/** Shared wire contract for Projects and the legacy agent-git adapter. Source SHAs are never projection SHAs. */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { HostedAgentHost } from './hosted-agent-host.js';

export type RepositoryProvider = 'aindrive' | 'agent-git' | 'github';
export type ExecutionTrigger = 'push' | 'merge' | 'mirror' | 'redeploy' | 'run' | 'preview' | 'api';
export interface RuntimeSource {
  repoId: string;
  provider: RepositoryProvider;
  url: string;
  path: string;
  branch: string;
  sourceCommit: string | null;
  projectId: string | null;
  writable: boolean;
}
export interface RuntimeExecution {
  id: string;
  repoId: string;
  projectId: string | null;
  agentId: string | null;
  sourceCommit: string | null;
  ref: string;
  trigger: ExecutionTrigger;
  actor: string | null;
  status: 'queued' | 'building' | 'ready' | 'error';
  projectionCommit: string | null;
  version: number | null;
  error: string | null;
  createdAt: number;
  finishedAt: number | null;
}
export function repositoryId(url: string): string {
  const canonical = url.trim().replace(/\/+$/, '').replace(/\.git$/, '');
  return `repo_${createHash('sha256').update(canonical).digest('hex').slice(0, 24)}`;
}
export interface AgentRuntime {
  agentId: string;
  source: RuntimeSource;
  activeCommit: string | null;
  activeVersion: number | null;
  execution: RuntimeExecution | null;
}

/** Durable legacy adapter state. Projects retain their existing deployment store and expose this same contract. */
export class AgentRuntimeStore {
  private readonly states = new Map<string, AgentRuntime>();
  private readonly records = new Map<string, RuntimeExecution[]>();
  constructor(private readonly file: string) {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { agents?: AgentRuntime[]; executions?: Record<string, RuntimeExecution[]> };
      for (const s of parsed.agents ?? []) {
        this.states.set(s.agentId, s);
        // Older ledgers contain only the last execution; retain it during migration.
        this.records.set(s.agentId, parsed.executions?.[s.agentId] ?? (s.execution ? [s.execution] : []));
      }
    }
  }
  get(id: string): AgentRuntime | null { return this.states.get(id) ?? null; }
  executionsOf(id: string): RuntimeExecution[] { return structuredClone(this.records.get(id) ?? []); }
  bind(id: string, source: RuntimeSource): AgentRuntime {
    const prior = this.get(id);
    const next = { agentId: id, source, activeCommit: prior?.activeCommit ?? null, activeVersion: prior?.activeVersion ?? null, execution: prior?.execution ?? null };
    this.states.set(id, next); this.save(); return next;
  }
  begin(id: string, source: RuntimeSource, trigger: ExecutionTrigger, actor: string | null): RuntimeExecution {
    const state = this.bind(id, source);
    const execution: RuntimeExecution = {
      id: `exec_${randomBytes(8).toString('hex')}`, repoId: source.repoId, projectId: source.projectId, agentId: id,
      sourceCommit: source.sourceCommit, ref: `refs/heads/${source.branch}`, trigger, actor, status: 'building',
      projectionCommit: null, version: null, error: null, createdAt: Date.now(), finishedAt: null,
    };
    this.records.set(id, [...(this.records.get(id) ?? []), execution]);
    this.states.set(id, { ...state, execution }); this.save(); return execution;
  }
  finish(id: string, executionId: string, fields: Pick<RuntimeExecution, 'status' | 'version' | 'error' | 'projectionCommit'>): void {
    const state = this.get(id);
    const records = this.records.get(id);
    const index = records?.findIndex((record) => record.id === executionId) ?? -1;
    if (!state || !records || index < 0) return;
    const execution = { ...records[index], ...fields, finishedAt: fields.status === 'ready' || fields.status === 'error' ? Date.now() : null };
    this.records.set(id, records.map((record, n) => n === index ? execution : record));
    // A delayed callback may complete an older record, but cannot activate it over a newer execution.
    if (state.execution?.id === executionId) this.states.set(id, { ...state, execution, ...(fields.status === 'ready' ? { activeCommit: execution.sourceCommit, activeVersion: fields.version } : {}) });
    this.save();
  }
  remove(id: string): void { this.records.delete(id); if (this.states.delete(id)) this.save(); }
  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify({ agents: [...this.states.values()], executions: Object.fromEntries(this.records) }), { mode: 0o600 });
    renameSync(`${this.file}.tmp`, this.file);
  }
}

/** A host can report ready for the PREVIOUS version when a replacement build failed. Check the version and error. */
export async function waitForAgentVersion(host: Pick<HostedAgentHost, 'status'>, id: string, version: number, timeoutMs = 600_000, pollMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = host.status(id);
    if (!state) throw new Error(`the host does not know agent "${id}"`);
    if (state.liveVersion === version && state.status === 'ready') return;
    if (state.error || state.status === 'failed') throw new Error(state.error ?? `agent ${id} v${version} failed`);
    if (state.liveVersion !== null && state.liveVersion > version) throw new Error(`agent ${id} v${version} was superseded`);
    if (Date.now() >= deadline) throw new Error(`agent ${id} v${version} was not ready in time`);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
