/** Private repository forks are proposals, not running agents or copies of their credentials. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
export interface AgentFork { id: string; parent: string; owner: string; baseCommit: string; createdAt: number }
export class AgentForkStore {
  private forks: AgentFork[];
  constructor(private readonly file: string) {
    this.forks = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { forks: AgentFork[] }).forks ?? [] : [];
  }
  get(id: string): AgentFork | null { return this.forks.find((fork) => fork.id === id) ?? null; }
  list(owner?: string): AgentFork[] { return this.forks.filter((fork) => !owner || fork.owner === owner.toLowerCase()); }
  add(fork: AgentFork): void {
    if (this.get(fork.id)) throw new Error('fork id already exists');
    if (this.list(fork.owner).length >= 10 || this.forks.length >= 1000) throw new Error('repository fork limit reached');
    this.forks.push({ ...fork, owner: fork.owner.toLowerCase() }); this.save();
  }
  remove(id: string): void { this.forks = this.forks.filter((fork) => fork.id !== id); this.save(); }
  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify({ forks: this.forks }), { mode: 0o600 });
    renameSync(`${this.file}.tmp`, this.file);
  }
}
