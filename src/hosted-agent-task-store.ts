/**
 * Where a prompt agent's A2A tasks live, so `tasks/get` still answers after the node restarts, after the node's
 * home is restored from a backup, and after the agent is updated (its runtime router is rebuilt).
 *
 * Before this file every runtime router held its own `InMemoryTaskStore`: a restart (deploy, rollback, restore)
 * forgot every task, and a product following a task it started (`/api/ain/tasks/get`, a cancel that first checks the
 * task with `tasks/get`) got "Task not found" for a task that had finished a moment before.
 *
 *   • One SQLite file, `<dataDir>/hosted-agent-tasks.sqlite` (0600), one row per task: the task as the SDK's own
 *     proto-JSON (`Task.toJSON`), so it reads back exactly as the SDK wrote it. The node's home already holds the
 *     same text in the conversation it answered; the history kept here is the one the executor already stripped of
 *     credentials (hostedAgentDelegatedReads.ts) — nothing new is written that `tasks/get` did not already return.
 *   • Reads stay in memory (the SDK's `InMemoryTaskStore`, same tenant/owner scoping); the file is written through
 *     on every save and read once, when the agent's store is first opened in this process.
 *   • A task that was `submitted`/`working` when the process ended cannot finish: nothing runs it any more. When the
 *     store is opened it becomes `failed` with a message that says so, so a client polling it stops and may send the
 *     message again, instead of waiting on "working" forever.
 *   • Kept for `retentionMs` (default 7 days) and at most `maxPerAgent` tasks per agent (default 2000), oldest first.
 *   • Code agents run the runtime in a container (hosted-agent-docker.ts) and keep their tasks in memory there.
 */
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Task } from '@a2a-js/sdk';
import { InMemoryTaskStore, resolveUserScope, type ServerCallContext, type TaskStore } from '@a2a-js/sdk/server';

type SdkTask = Parameters<TaskStore['save']>[0];

/** TaskState values (the SDK's enum), named here so this file needs no enum import. */
const TASK_SUBMITTED = 1;
const TASK_WORKING = 2;
const TASK_FAILED = 4;
const ROLE_AGENT = 2;

export const HOSTED_AGENT_TASK_INTERRUPTED =
  'This task was interrupted: the agent host restarted before it finished. Send the message again.';

export interface HostedAgentTaskFileOptions {
  retentionMs?: number;
  maxPerAgent?: number;
  now?: () => number;
}

interface TaskRow { tenant: string; owner: string; task_json: string; state: number }

/** The context the SDK's in-memory store scopes by: `context.tenant` and the owner `resolveUserScope` derives. */
function scopeContext(tenant: string, owner: string): ServerCallContext {
  return { tenant: tenant || undefined, user: { isAuthenticated: false, userName: owner } } as unknown as ServerCallContext;
}

export class HostedAgentTaskFile {
  private readonly db: DatabaseSync;
  private readonly stores = new Map<string, PersistedTaskStore>();
  readonly retentionMs: number;
  readonly maxPerAgent: number;
  readonly now: () => number;
  private saves = 0;

  constructor(readonly file: string, o: HostedAgentTaskFileOptions = {}) {
    this.retentionMs = o.retentionMs ?? 7 * 24 * 3600_000;
    this.maxPerAgent = o.maxPerAgent ?? 2000;
    this.now = o.now ?? Date.now;
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    try { chmodSync(file, 0o600); } catch { /* not ours to change */ }
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS hosted_agent_tasks (
        agent_id TEXT NOT NULL, tenant TEXT NOT NULL, owner TEXT NOT NULL, task_id TEXT NOT NULL,
        context_id TEXT NOT NULL, state INTEGER NOT NULL, updated_at INTEGER NOT NULL, task_json TEXT NOT NULL,
        PRIMARY KEY (agent_id, tenant, owner, task_id)
      );
      CREATE INDEX IF NOT EXISTS hosted_agent_tasks_age ON hosted_agent_tasks (agent_id, updated_at);
    `);
  }

  /** The agent's store — the same object for the life of this process, so an update of the agent keeps its tasks. */
  forAgent(agentId: string): TaskStore {
    let s = this.stores.get(agentId);
    if (!s) {
      s = new PersistedTaskStore(this, agentId);
      this.stores.set(agentId, s);
      s.hydrate();
    }
    return s;
  }

  /** A deleted agent's tasks go with it. */
  removeAgent(agentId: string): void {
    this.stores.delete(agentId);
    this.db.prepare('DELETE FROM hosted_agent_tasks WHERE agent_id = ?').run(agentId);
  }

  /** How many tasks the file holds for an agent (operator checks, tests). */
  count(agentId: string): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM hosted_agent_tasks WHERE agent_id = ?').get(agentId) as { n: number }).n);
  }

  close(): void {
    this.stores.clear();
    try { this.db.close(); } catch { /* already closed */ }
  }

  /** @internal */
  rows(agentId: string): TaskRow[] {
    return this.db.prepare('SELECT tenant, owner, task_json, state FROM hosted_agent_tasks WHERE agent_id = ? AND updated_at >= ? ORDER BY updated_at ASC')
      .all(agentId, this.now() - this.retentionMs) as unknown as TaskRow[];
  }

  /** @internal */
  write(agentId: string, tenant: string, owner: string, task: SdkTask): void {
    this.db.prepare(`INSERT INTO hosted_agent_tasks (agent_id, tenant, owner, task_id, context_id, state, updated_at, task_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (agent_id, tenant, owner, task_id) DO UPDATE SET context_id = excluded.context_id, state = excluded.state,
        updated_at = excluded.updated_at, task_json = excluded.task_json`)
      .run(agentId, tenant, owner, task.id, task.contextId ?? '', Number(task.status?.state ?? 0), this.now(), JSON.stringify(Task.toJSON(task)));
    if (++this.saves % 100 === 0) this.prune(agentId);
  }

  /** @internal Drop tasks past retention, and the oldest beyond `maxPerAgent`. */
  prune(agentId: string): void {
    this.db.prepare('DELETE FROM hosted_agent_tasks WHERE agent_id = ? AND updated_at < ?').run(agentId, this.now() - this.retentionMs);
    this.db.prepare(`DELETE FROM hosted_agent_tasks WHERE agent_id = ? AND rowid IN (
      SELECT rowid FROM hosted_agent_tasks WHERE agent_id = ? ORDER BY updated_at DESC LIMIT -1 OFFSET ?)`).run(agentId, agentId, this.maxPerAgent);
  }
}

class PersistedTaskStore implements TaskStore {
  private readonly mem = new InMemoryTaskStore();

  constructor(private readonly file: HostedAgentTaskFile, private readonly agentId: string) {}

  /** Read the file once: every kept task back into memory, the ones nothing runs any more marked failed. */
  hydrate(): void {
    this.file.prune(this.agentId);
    for (const row of this.file.rows(this.agentId)) {
      let task: SdkTask;
      try { task = Task.fromJSON(JSON.parse(row.task_json)) as SdkTask; } catch { continue; }
      if (row.state === TASK_SUBMITTED || row.state === TASK_WORKING) {
        task.status = {
          state: TASK_FAILED,
          timestamp: new Date(this.file.now()).toISOString(),
          message: {
            messageId: randomUUID(), contextId: task.contextId, taskId: task.id, role: ROLE_AGENT,
            parts: [{ content: { $case: 'text', value: HOSTED_AGENT_TASK_INTERRUPTED }, filename: '', mediaType: '' }],
            metadata: undefined, extensions: [], referenceTaskIds: [],
          },
        } as unknown as SdkTask['status'];
        this.file.write(this.agentId, row.tenant, row.owner, task);
      }
      // The in-memory store copies what it is given; the context only picks the tenant/owner bucket.
      void this.mem.save(task, scopeContext(row.tenant, row.owner));
    }
  }

  async save(task: SdkTask, context: ServerCallContext): Promise<void> {
    await this.mem.save(task, context);
    this.file.write(this.agentId, context?.tenant ?? '', resolveUserScope(context), task);
  }

  load(taskId: string, context: ServerCallContext): Promise<SdkTask | undefined> {
    return this.mem.load(taskId, context);
  }

  list(params: Parameters<TaskStore['list']>[0], context: ServerCallContext): ReturnType<TaskStore['list']> {
    return this.mem.list(params, context);
  }
}
