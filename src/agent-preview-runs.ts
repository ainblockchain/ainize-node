/** Private review evidence outlives its temporary runtime; does not store transport credentials or inherited runtime secrets. */
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { AgentPreview } from './agent-previews.js';
export interface PreviewRun {
  id: string; previewId: string; agent: string; owner: string; commit: string; model: string;
  exportedAt?: number; request: unknown; output: string; outputTruncated: boolean; outputBytes: number;
  status: 'running' | 'ready' | 'error' | 'cancelled'; error: string | null; createdAt: number; finishedAt: number | null;
}
export class AgentPreviewRuns {
  private readonly records = new Map<string, PreviewRun>();
  constructor(private readonly file: string) {
    if (existsSync(file)) {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as { runs: PreviewRun[] };
      for (const run of saved.runs) this.records.set(run.id, run.status === 'running' ? { ...run, status: 'error', error: 'node restarted before the preview request completed', finishedAt: Date.now() } : run);
      this.save();
    }
  }
  begin(preview: AgentPreview, model: string, request: unknown): PreviewRun {
    if (this.records.size >= 2000 || [...this.records.values()].filter((run) => run.owner === preview.owner).length >= 200) throw new Error('preview history quota reached');
    const run: PreviewRun = { id: `review_${randomBytes(12).toString('hex')}`, previewId: preview.id, agent: preview.agent, owner: preview.owner, commit: preview.commit, model, request: structuredClone(request), output: '', outputTruncated: false, outputBytes: 0, status: 'running', error: null, createdAt: Date.now(), finishedAt: null };
    this.records.set(run.id, run); this.save(); return structuredClone(run);
  }
  finish(id: string, result: Pick<PreviewRun, 'status' | 'output' | 'outputTruncated' | 'outputBytes' | 'error'>): void {
    const run = this.records.get(id); if (!run || run.status !== 'running') return;
    this.records.set(id, { ...run, ...result, exportedAt: undefined, finishedAt: Date.now() }); this.save();
  }
  list(agent: string, owner: string): PreviewRun[] { return structuredClone([...this.records.values()].filter((run) => run.agent === agent && run.owner === owner.toLowerCase()).reverse()); }
  export(id: string, agent: string, owner: string): PreviewRun | null {
    const run = this.records.get(id);
    if (!run || run.agent !== agent || run.owner !== owner.toLowerCase()) return null;
    const exported = { ...run, exportedAt: Date.now() };
    this.records.set(id, exported); this.save(); return structuredClone(exported);
  }
  remove(id: string, agent: string, owner: string): 'removed' | 'missing' | 'not_exported' | 'running' {
    const run = this.records.get(id);
    if (!run || run.agent !== agent || run.owner !== owner.toLowerCase()) return 'missing';
    if (run.status === 'running') return 'running';
    if (!run.exportedAt) return 'not_exported';
    this.records.delete(id); this.save(); return 'removed';
  }
  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify({ runs: [...this.records.values()] }), { mode: 0o600 });
    renameSync(`${this.file}.tmp`, this.file);
  }
}
