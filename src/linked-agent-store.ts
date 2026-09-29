/**
 * Linked agents — external A2A agents a PERSON registers on this node by URL.
 *
 * The third source of agents beside `config.agents` (the operator's, edited with `ainize agent add`) and hosted
 * agents (the node RUNS those). A linked agent is a config agent with an owner: the node gives it a public address
 * under `/agents/<id>`, proxies to `upstream`, and lists it in the catalogue — it does not run anything.
 *
 * Why it exists: a workspace product (AIN Teams) imports every agent it shows from this catalogue, so the person who
 * wrote an agent somewhere on the internet needs a way to put it IN the catalogue without being this node's operator.
 * Design: docs/superpowers/specs/2026-09-29-linked-agents-design.md.
 *
 * Same file bargain as hosted-agent-store.ts: one JSON file, written atomically (tmp + rename, mode 0600). Limits
 * live here so no other writer can skip them.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { HOSTED_AGENT_VISIBILITIES, type HostedAgentVisibility } from './hosted-agent-types.js';

export interface LinkedAgent {
  /** 1–40 lower-case letters, digits and hyphens: the public address is `/agents/<id>`, so it never changes. */
  id: string;
  name: string;
  description: string;
  /** Where the agent's process listens. Never published — the node's address is what callers get. */
  upstream: string;
  /** The principal that registered it: a lower-case wallet address, or an AIN SSO principal (`sso:<sub>`). */
  owner: string;
  /** Who may see and list it — the same four values a hosted agent has (hosted-agent-types.ts). Absent → `public`. */
  visibility?: HostedAgentVisibility;
  /** The organization an `org`-visible agent is shared with (an AIN SSO org id). Null otherwise. */
  orgId?: string | null;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export const LINKED_AGENT_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * What a register or update request carries. `name` may be omitted on register: the card's name is used then, so a
 * person pasting a URL types nothing the card already says.
 */
export const linkedAgentInput = z.object({
  id: z.string().regex(LINKED_AGENT_ID, 'an id is 1–40 lower-case letters, digits and hyphens, starting with a letter or digit'),
  name: z.string().trim().max(80).default(''),
  description: z.string().trim().max(500).default(''),
  upstream: z.string().trim().url('upstream is the agent\'s http(s) address').refine((u) => /^https?:\/\//i.test(u), 'upstream must be http or https'),
  // Optional so a caller that predates it keeps working: an absent value is `public`, what every agent was.
  visibility: z.enum(HOSTED_AGENT_VISIBILITIES).default('public'),
  orgId: z.string().trim().min(1).max(256).regex(/^[^\s/\\]+$/, 'an org id is one token without whitespace or slashes').nullable().default(null),
}).superRefine((v, ctx) => {
  if (v.visibility === 'org' && !v.orgId) ctx.addIssue({ code: 'custom', path: ['orgId'], message: 'org visibility names the organization (orgId)' });
  if (v.visibility !== 'org' && v.orgId) ctx.addIssue({ code: 'custom', path: ['orgId'], message: 'orgId goes with visibility "org"' });
});
export type LinkedAgentInput = z.infer<typeof linkedAgentInput>;
/** What `setSharing` changes: the two fields that say who sees the agent, and nothing about where it runs. */
export interface AgentSharing { visibility: HostedAgentVisibility; orgId: string | null }

export interface LinkedAgentStoreLimits {
  perOwner: number;
  total: number;
}

export const LINKED_AGENT_DEFAULT_LIMITS: LinkedAgentStoreLimits = { perOwner: 10, total: 500 };

export class LinkedAgentLimitError extends Error {}
export class LinkedAgentIdTakenError extends Error {}

export class LinkedAgentStore {
  private readonly agents = new Map<string, LinkedAgent>();

  constructor(private readonly file: string, private readonly limits: LinkedAgentStoreLimits = LINKED_AGENT_DEFAULT_LIMITS) {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { agents?: LinkedAgent[] };
      for (const a of parsed.agents ?? []) if (a?.id) this.agents.set(a.id, a);
    }
  }

  list(): LinkedAgent[] {
    return [...this.agents.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): LinkedAgent | null {
    return this.agents.get(id) ?? null;
  }

  has(id: string): boolean {
    return this.agents.has(id);
  }

  listByOwner(owner: string): LinkedAgent[] {
    const who = normaliseOwner(owner);
    return this.list().filter((a) => a.owner === who);
  }

  /** `reserved` is every id spoken for elsewhere (config agents, hosted agents), which a linked agent must not shadow. */
  create(input: LinkedAgentInput & { name: string }, owner: string, reserved: (id: string) => boolean = () => false, now = Date.now()): LinkedAgent {
    const who = normaliseOwner(owner);
    if (this.agents.has(input.id) || reserved(input.id)) throw new LinkedAgentIdTakenError(`the id "${input.id}" is taken`);
    if (this.listByOwner(who).length >= this.limits.perOwner) throw new LinkedAgentLimitError(`one account may link ${this.limits.perOwner} agents on this node`);
    if (this.agents.size >= this.limits.total) throw new LinkedAgentLimitError(`this node lists its maximum of ${this.limits.total} linked agents`);
    const agent: LinkedAgent = { ...input, owner: who, version: 1, createdAt: now, updatedAt: now };
    this.agents.set(agent.id, agent);
    this.save();
    return agent;
  }

  /** The id cannot change: it is the agent's public address, and workspaces hold it. */
  update(id: string, input: LinkedAgentInput & { name: string }, now = Date.now()): LinkedAgent {
    const prior = this.agents.get(id);
    if (!prior) throw new Error(`no linked agent "${id}"`);
    const agent: LinkedAgent = { ...input, id, owner: prior.owner, version: prior.version + 1, createdAt: prior.createdAt, updatedAt: now };
    this.agents.set(id, agent);
    this.save();
    return agent;
  }

  /** Change who sees the agent — the operator's or the owner's call (shared-agents.ts). Bumps the version like any change. */
  setSharing(id: string, sharing: AgentSharing, now = Date.now()): LinkedAgent {
    const prior = this.agents.get(id);
    if (!prior) throw new Error(`no linked agent "${id}"`);
    const agent: LinkedAgent = { ...prior, visibility: sharing.visibility, orgId: sharing.visibility === 'org' ? sharing.orgId : null, version: prior.version + 1, updatedAt: now };
    this.agents.set(id, agent);
    this.save();
    return agent;
  }

  delete(id: string): boolean {
    const had = this.agents.delete(id);
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

/**
 * A wallet address compares case-insensitively; an SSO principal (`sso:<sub>`) is case-sensitive, because an OIDC
 * `sub` is. Folding the whole string would make two different accounts one owner.
 */
export function normaliseOwner(owner: string): string {
  return /^0x[0-9a-fA-F]{40}$/.test(owner) ? owner.toLowerCase() : owner;
}
