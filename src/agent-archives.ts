/** Durable owner-private deletion evidence. Secret values are deliberately outside this archive. */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AgentGit } from './agent-git.js';
import type { AgentMirror } from './agent-mirror.js';
import type { AgentPull } from './agent-pulls.js';
import type { AgentRuntime, RuntimeExecution } from './repository-runtime.js';
import type { HostedAgentSpec } from './hosted-agent-types.js';

export interface AgentArchive {
  id: string;
  agent: string;
  owner: string;
  createdAt: number;
  exportedAt?: number;
  restoredAt?: number;
  bytes: number;
  repository: boolean;
  repositoryFormat?: 'bundle' | 'bare-tar';
  runtime?: AgentRuntime | null;
  executions?: RuntimeExecution[];
  spec: HostedAgentSpec;
  pulls: AgentPull[];
  mirror: AgentMirror | null;
}
export interface AgentArchiveLimits { perOwner: number; total: number; bytes: number }
export class AgentArchives {
  private readonly records = new Map<string, AgentArchive>();
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly file: string, private readonly directory: string,
    private readonly limits: AgentArchiveLimits = { perOwner: 20, total: 200, bytes: 2 * 1024 ** 3 }) {
    if (existsSync(file)) {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as { archives: AgentArchive[] };
      for (const record of saved.archives) this.records.set(record.id, record);
    }
  }
  list(owner: string): AgentArchive[] {
    return structuredClone([...this.records.values()].filter((record) => record.owner === owner.toLowerCase()).reverse());
  }
  get(id: string, owner: string): AgentArchive | null {
    const record = this.records.get(id);
    return record?.owner === owner.toLowerCase() ? structuredClone(record) : null;
  }
  bundle(id: string, owner: string): string | null {
    const record = this.get(id, owner);
    return record && record.repository !== false && record.repositoryFormat !== 'bare-tar' ? join(this.directory, `${id}.bundle`) : null;
  }
  repositoryFile(id: string, owner: string): { path: string; format: 'bundle' | 'bare-tar' } | null {
    const record = this.get(id, owner);
    if (!record || record.repository === false) return null;
    return record.repositoryFormat === 'bare-tar' ? { path: join(this.directory, `${id}.git.tar.gz`), format: 'bare-tar' } : { path: join(this.directory, `${id}.bundle`), format: 'bundle' };
  }
  create(git: AgentGit, snapshot: Pick<AgentArchive, 'spec' | 'pulls' | 'mirror'> & Partial<Pick<AgentArchive, 'runtime' | 'executions'>>): Promise<AgentArchive> {
    const copied = structuredClone(snapshot);
    const operation = this.pending.catch(() => undefined).then(async () => {
      const owner = copied.spec.owner.toLowerCase();
      if (this.records.size >= this.limits.total || this.list(owner).length >= this.limits.perOwner) throw new Error('agent archive quota reached; export and remove an old archive first');
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const id = `archive_${randomBytes(12).toString('hex')}`;
      let artifact = join(this.directory, `${id}.bundle`);
      try {
        const repository = git.exists(copied.spec.id) && await git.hasCommits(copied.spec.id);
        const repositoryFormat = repository && git.isShallow(copied.spec.id) ? 'bare-tar' as const : 'bundle' as const;
        if (repositoryFormat === 'bare-tar') artifact = join(this.directory, `${id}.git.tar.gz`);
        if (repository) {
          if (repositoryFormat === 'bare-tar') await git.exportBareArchive(copied.spec.id, artifact);
          else await git.exportBundle(copied.spec.id, artifact);
        }
        const bytes = (repository ? statSync(artifact).size : 0) + Buffer.byteLength(JSON.stringify(copied));
        if (bytes + [...this.records.values()].reduce((total, record) => total + record.bytes, 0) > this.limits.bytes) throw new Error('agent archive storage quota reached');
        const record: AgentArchive = { id, agent: copied.spec.id, owner, createdAt: Date.now(), bytes, repository, repositoryFormat, ...copied };
        this.records.set(id, record);
        try { this.save(); } catch (error) { this.records.delete(id); throw error; }
        return structuredClone(record);
      } catch (error) { rmSync(artifact, { force: true }); throw error; }
    });
    this.pending = operation;
    return operation;
  }
  markExported(id: string, owner: string): AgentArchive | null {
    const record = this.get(id, owner);
    if (!record) return null;
    const prior = this.records.get(id)!;
    record.exportedAt = Date.now(); this.records.set(id, record);
    try { this.save(); } catch (error) { this.records.set(id, prior); throw error; }
    return structuredClone(record);
  }
  markRestored(id: string, owner: string): void {
    const record = this.get(id, owner);
    if (!record) throw new Error('archive not found');
    const prior = this.records.get(id)!;
    record.restoredAt = Date.now(); this.records.set(id, record);
    try { this.save(); } catch (error) { this.records.set(id, prior); throw error; }
  }
  remove(id: string, owner: string): 'removed' | 'missing' | 'not_exported' {
    const record = this.get(id, owner);
    if (!record) return 'missing';
    if (!record.exportedAt) return 'not_exported';
    this.records.delete(id);
    try { this.save(); } catch (error) { this.records.set(id, record); throw error; }
    rmSync(join(this.directory, `${id}.bundle`), { force: true });
    rmSync(join(this.directory, `${id}.git.tar.gz`), { force: true });
    return 'removed';
  }
  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify({ archives: [...this.records.values()] }), { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.file);
  }
}
