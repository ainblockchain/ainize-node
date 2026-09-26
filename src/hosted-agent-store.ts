/**
 * Hosted agent specs, one JSON file, written atomically (tmp + rename) — the same bargain as the API key store
 * (openai-api-keys.ts): a few hundred small records do not need a database, and a torn write must never leave the
 * node unable to read what its agents were.
 *
 * Limits live here rather than in the route so no other writer can skip them.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { HostedAgentSpec, HostedAgentSpecInput } from './hosted-agent-types.js';

export interface HostedAgentStoreLimits {
  perOwner: number;
  total: number;
}

export const HOSTED_AGENT_DEFAULT_LIMITS: HostedAgentStoreLimits = { perOwner: 5, total: 200 };

export class HostedAgentLimitError extends Error {}
export class HostedAgentIdTakenError extends Error {}

export class HostedAgentStore {
  private readonly specs = new Map<string, HostedAgentSpec>();

  constructor(private readonly file: string, private readonly limits: HostedAgentStoreLimits = HOSTED_AGENT_DEFAULT_LIMITS) {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { agents?: HostedAgentSpec[] };
      for (const s of parsed.agents ?? []) if (s?.id) this.specs.set(s.id, s);
    }
  }

  list(): HostedAgentSpec[] {
    return [...this.specs.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): HostedAgentSpec | null {
    return this.specs.get(id) ?? null;
  }

  listByOwner(owner: string): HostedAgentSpec[] {
    return this.list().filter((s) => s.owner === owner.toLowerCase());
  }

  /** `reserved` is every id already spoken for elsewhere (config agents), which a hosted agent must not shadow. */
  create(input: HostedAgentSpecInput, owner: string, reserved: (id: string) => boolean = () => false, now = Date.now()): HostedAgentSpec {
    const who = owner.toLowerCase();
    if (this.specs.has(input.id) || reserved(input.id)) throw new HostedAgentIdTakenError(`the id "${input.id}" is taken`);
    if (this.listByOwner(who).length >= this.limits.perOwner) throw new HostedAgentLimitError(`an address may run ${this.limits.perOwner} agents on this node`);
    if (this.specs.size >= this.limits.total) throw new HostedAgentLimitError(`this node runs its maximum of ${this.limits.total} agents`);
    const spec: HostedAgentSpec = { ...input, owner: who, version: 1, createdAt: now, updatedAt: now };
    this.specs.set(spec.id, spec);
    this.save();
    return spec;
  }

  /** The id cannot change: it is the agent's public address, and callers hold it. */
  update(id: string, input: HostedAgentSpecInput, now = Date.now()): HostedAgentSpec {
    const prior = this.specs.get(id);
    if (!prior) throw new Error(`no hosted agent "${id}"`);
    const spec: HostedAgentSpec = { ...input, id, owner: prior.owner, version: prior.version + 1, createdAt: prior.createdAt, updatedAt: now };
    this.specs.set(id, spec);
    this.save();
    return spec;
  }

  delete(id: string): boolean {
    const had = this.specs.delete(id);
    if (had) this.save();
    return had;
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ agents: this.list() }), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
