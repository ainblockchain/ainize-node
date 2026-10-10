/** All mirror entry points share one serialized validate/apply/land operation. */
import { fetchMirror, type AgentMirror, type AgentMirrorStore } from './agent-mirror.js';
import type { AgentGit } from './agent-git.js';
import type { HostedAgentSpecInput } from './hosted-agent-types.js';

export interface AgentMirrorSyncDeps {
  git: AgentGit;
  mirrors: AgentMirrorStore;
  apply: (id: string, input: HostedAgentSpecInput, commit: string, by: string | null) => Promise<void>;
  land: (id: string, commit: string) => Promise<void>;
  log: (level: 'info' | 'warn' | 'error', message: string) => void;
}
export class AgentMirrorSyncer {
  private readonly inflight = new Map<string, Promise<AgentMirror | null>>();
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly deps: AgentMirrorSyncDeps) {}
  sync(mirror: AgentMirror, by: string | null = null): Promise<AgentMirror | null> {
    return this.serial(mirror.agent, () => this.perform(mirror, by));
  }
  configure(mirror: AgentMirror, by: string | null = null): Promise<AgentMirror | null> {
    return this.serial(mirror.agent, () => this.perform(this.deps.mirrors.set(mirror), by));
  }
  async detach(agent: string): Promise<boolean> {
    let detached = false;
    await this.serial(agent, async () => { detached = this.deps.mirrors.remove(agent); return null; });
    return detached;
  }
  private serial(agent: string, operation: () => Promise<AgentMirror | null>): Promise<AgentMirror | null> {
    const previous = this.inflight.get(agent) ?? Promise.resolve(null);
    const next = previous.catch(() => null).then(operation);
    this.inflight.set(agent, next);
    void next.finally(() => { if (this.inflight.get(agent) === next) this.inflight.delete(agent); }).catch(() => {});
    return next;
  }
  async sweep(): Promise<void> {
    for (const mirror of this.deps.mirrors.list()) {
      if (this.inflight.has(mirror.agent)) continue;
      await this.sync(mirror);
    }
  }
  start(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.sweep().catch((e: Error) => this.deps.log('error', `mirror sweep: ${e.message}`)); }, intervalMs);
    this.timer.unref();
    void this.sweep().catch((e: Error) => this.deps.log('error', `mirror recovery: ${e.message}`));
  }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.allSettled([...this.inflight.values()]);
  }
  private async perform(mirror: AgentMirror, by: string | null): Promise<AgentMirror | null> {
    // A queued fetch must not resurrect a detached/reconfigured mirror.
    const current = () => {
      const m = this.deps.mirrors.get(mirror.agent);
      return m && m.url === mirror.url && m.path === mirror.path && m.branch === mirror.branch ? m : null;
    };
    if (!current()) return null;
    try {
      const result = await fetchMirror(this.deps.git, current()!);
      if (!current()) return null;
      if (result.error) throw new Error(result.error);
      if (result.changed) {
        await this.deps.apply(mirror.agent, result.input!, result.commit, by);
        if (!current()) return null;
        await this.deps.land(mirror.agent, result.commit);
      }
      return this.deps.mirrors.patch(mirror.agent, { lastFetchAt: Date.now(), lastCommit: result.commit, error: null });
    } catch (e) {
      const why = (e as Error).message;
      this.deps.log('warn', `agent ${mirror.agent}: ${why}`);
      return current() ? this.deps.mirrors.patch(mirror.agent, { lastFetchAt: Date.now(), error: why }) : null;
    }
  }
}
