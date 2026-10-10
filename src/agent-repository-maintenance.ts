/** Periodic Git maintenance shares the queue with push, archive, restore and deploy. */
import type { AgentGit } from './agent-git.js';
import type { RepositorySerialize } from './agent-repository-queue.js';
export class AgentRepositoryMaintenance {
  private timer: ReturnType<typeof setInterval> | null = null;
  private startup: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;
  constructor(private readonly git: AgentGit, private readonly serialize: RepositorySerialize,
    private readonly retained: (id: string) => string[], private readonly report: (message: string) => void) {}
  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => { void this.sweep(); }, 24 * 3600_000); this.timer.unref();
    this.startup = setTimeout(() => { void this.sweep(); }, 5 * 60_000); this.startup.unref();
  }
  sweep(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.run().catch((error: unknown) => this.report(`repository maintenance: ${(error as Error).message}`)).finally(() => { this.running = null; });
    return this.running;
  }
  private async run(): Promise<void> {
    for (const id of await this.git.repositoryIds()) {
      if (this.stopped) break;
      try { await this.serialize(id, async () => { if (!this.stopped && this.git.exists(id)) await this.git.maintain(id, this.retained(id)); }); }
      catch (error) { this.report(`repository ${id}: maintenance failed: ${(error as Error).message}`); }
    }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.startup) clearTimeout(this.startup);
    this.timer = null; this.startup = null;
    await this.running;
  }
}
