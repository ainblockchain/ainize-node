/** A commit-pinned, owner-only runtime whose authority expires with the preview. */
import { randomBytes } from 'node:crypto';
import type { AgentGit } from './agent-git.js';
import type { HostedAgentHost } from './hosted-agent-host.js';
import type { HostedAgentSpec } from './hosted-agent-types.js';
export interface AgentPreview { id: string; agent: string; commit: string; owner: string; createdAt: number; expiresAt: number; status: 'building' | 'ready' | 'error'; error: string | null }
type PreviewHost = Pick<HostedAgentHost, 'apply' | 'remove' | 'status' | 'resolve' | 'has'>;
export class AgentPreviews {
  private readonly records = new Map<string, AgentPreview>();
  private readonly lifetimes = new Map<string, AbortController>();
  private readonly specs = new Map<string, HostedAgentSpec>();
  private readonly pending = new Set<Promise<void>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private readonly git: Pick<AgentGit, 'readSpec'>, private readonly host: PreviewHost, private readonly o: { ttlMs?: number; now?: () => number; pollMs?: number } = {}) {}
  private now(): number { return this.o.now?.() ?? Date.now(); }
  signal(id: string): AbortSignal | undefined { return this.lifetimes.get(id)?.signal; }
  spec(id: string): HostedAgentSpec | null { return (this.records.get(id)?.expiresAt ?? 0) > this.now() ? this.specs.get(id) ?? null : null; }
  get(id: string, owner: string): AgentPreview | null {
    const record = this.records.get(id);
    return record && record.owner === owner.toLowerCase() && record.expiresAt > this.now() ? { ...record } : null;
  }
  async create(agent: string, ref: string, owner: string): Promise<AgentPreview> {
    const read = await this.git.readSpec(agent, ref);
    await this.sweep();
    const who = owner.toLowerCase();
    if ([...this.records.values()].filter((record) => record.owner === who).length >= 2 || this.records.size >= 8) throw new Error('preview limit reached');
    let id: string;
    do { id = `preview-${randomBytes(10).toString('hex')}`; } while (this.host.has(id) || this.records.has(id));
    const now = this.now();
    const record: AgentPreview = { id, agent, commit: read.commit, owner: who, createdAt: now, expiresAt: now + (this.o.ttlMs ?? 15 * 60_000), status: 'building', error: null };
    const spec: HostedAgentSpec = { ...read.input, id, owner: who, visibility: 'private', orgId: null, allowedHosts: [], secretNames: [], media: { transcription: false, image: false }, version: 1, createdAt: now, updatedAt: now };
    this.records.set(id, record); this.specs.set(id, spec); this.lifetimes.set(id, new AbortController());
    try { this.host.apply(spec, { ephemeral: true }); }
    catch (error) { await this.remove(id); throw error; }
    const pending = this.follow(record);
    this.pending.add(pending);
    void pending.finally(() => this.pending.delete(pending)).catch(() => {});
    return { ...record };
  }
  private async follow(record: AgentPreview): Promise<void> {
    while (this.records.get(record.id) === record && record.expiresAt > this.now()) {
      const status = this.host.status(record.id);
      if (status?.error || status?.status === 'failed') { record.status = 'error'; record.error = status.error ?? 'preview build failed'; return; }
      if (status?.status === 'ready' && status.liveVersion === 1) { record.status = 'ready'; return; }
      await new Promise((resolve) => setTimeout(resolve, this.o.pollMs ?? 100));
    }
    await this.remove(record.id);
  }
  async resolve(id: string, owner: string): Promise<string | null> {
    const record = this.get(id, owner);
    return record?.status === 'ready' ? this.host.resolve(id) : null;
  }
  async remove(id: string): Promise<void> {
    if (!this.records.delete(id)) return;
    this.specs.delete(id);
    this.lifetimes.get(id)?.abort(); this.lifetimes.delete(id);
    await this.host.remove(id);
  }
  async sweep(): Promise<void> {
    await Promise.all([...this.records.values()].filter((record) => record.expiresAt <= this.now()).map((record) => this.remove(record.id)));
  }
  start(): void { if (!this.timer) { this.timer = setInterval(() => { void this.sweep().catch(() => {}); }, 1000); this.timer.unref(); } }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer); this.timer = null;
    await Promise.all([...this.records.keys()].map((id) => this.remove(id)));
    await Promise.allSettled([...this.pending]);
  }
}
