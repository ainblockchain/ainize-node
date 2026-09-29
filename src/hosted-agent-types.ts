/**
 * An agent this node RUNS, as opposed to one it proxies (agents.ts `config.agents`).
 *
 * Created over HTTP by anyone signed in (hosted-agent-routes.ts), stored as JSON (hosted-agent-store.ts), run by
 * the runtime in hosted-agent-runtime/ — in-process for prompt agents, in Docker for agents that bring code.
 * Design: docs/superpowers/specs/2026-09-26-hosted-agents-design.md.
 */
import { z } from 'zod';
import type { HostedAgentMedia, HostedAgentMode, HostedAgentPopJwk, HostedAgentRuntimeSpec } from './hosted-agent-runtime/hostedAgentRuntimeTypes.js';

export type { HostedAgentMode };

export interface HostedAgentSpec extends HostedAgentRuntimeSpec {
  /** Code, for `tools` and `handler`. `index.mjs` is the entry; `package.json` is installed when present. */
  files: Record<string, string>;
  allowedHosts: string[];
  secretNames: string[];
  /** Lower-case EVM address — or SSO principal (`sso:<sub>`, `google:<sub>`) — of whoever created it. Only they may change it. */
  owner: string;
  /** Who may see and list it (shared-agents.ts). Absent on specs stored before visibility existed — read as `public`. */
  visibility?: HostedAgentVisibility;
  /** The organization an `org`-visible agent is shared with (an AIN SSO org id). Null otherwise. */
  orgId?: string | null;
  /** Who made the last change, when it was not a create: the owner or a member of the organization. */
  updatedBy?: string;
  /**
   * The public half of the agent's proof-of-possession key (hosted-agent-pop.ts); the private half is in the
   * secret store. Absent until the node issues one (at create, or at boot for an older spec).
   */
  popJwk?: HostedAgentPopJwk;
  createdAt: number;
  updatedAt: number;
}

/**
 * Who sees a hosted agent. `public` is listed to everyone; `org` is listed to members of `orgId`; `private` is the
 * owner's alone; `unlisted` appears in no listing but answers to anyone who holds the id (the A2A address stays
 * public either way — an id is an address, and visibility is about listing, not about the wire).
 */
export const HOSTED_AGENT_VISIBILITIES = ['public', 'org', 'private', 'unlisted'] as const;
export type HostedAgentVisibility = (typeof HOSTED_AGENT_VISIBILITIES)[number];

/** A stored spec's visibility, with the absent field of an older spec read as `public` (what every agent was). */
export const hostedAgentVisibilityOf = (s: { visibility?: HostedAgentVisibility | null }): HostedAgentVisibility => s.visibility ?? 'public';

export const HOSTED_AGENT_MAX_FILES_BYTES = 1_000_000;
export const hostedAgentUsesCode = (mode: HostedAgentMode) => mode !== 'prompt';

/**
 * A host pattern: a DNS name, a `*.` wildcard over one, or `*` for any public host. Never an IP literal: egress
 * to an address is decided by what the name resolves to, and allowing a literal would be allowing an address.
 */
const hostPattern = z.string().trim().toLowerCase().regex(
  /^(\*|(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63})$/,
  'an allowed host is a domain name, "*.domain", or "*"',
);

const fileName = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}(\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}){0,3}$/, 'a file name is a relative path of plain segments');

/** What a create or update request carries. Owner, version and timestamps are the node's to set. */
export const hostedAgentSpecInput = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'an id is 1–40 lower-case letters, digits and hyphens, starting with a letter or digit'),
  name: z.string().trim().min(1, 'a name is required').max(80),
  description: z.string().trim().max(500).default(''),
  model: z.string().min(1, 'choose a model'),
  systemPrompt: z.string().max(8000).default(''),
  mode: z.enum(['prompt', 'tools', 'handler']).default('prompt'),
  files: z.record(fileName, z.string()).default({}),
  a2ui: z.boolean().default(false),
  allowedHosts: z.array(hostPattern).max(32).default([]),
  secretNames: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/, 'a secret name is UPPER_SNAKE_CASE')).max(16).default([]),
  // Optional so a caller that predates it (an older web, a script) keeps working: an absent block is all off.
  media: z.object({
    transcription: z.boolean().default(false),
    image: z.boolean().default(false),
  }).default({ transcription: false, image: false }),
  skills: z.array(z.object({
    id: z.string().trim().min(1).max(64),
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(300).optional(),
    examples: z.array(z.string().max(300)).max(4).optional(),
  })).max(8).default([]),
  // Optional so a caller that predates it keeps working: an absent value is `public`, what every agent was.
  visibility: z.enum(HOSTED_AGENT_VISIBILITIES).default('public'),
  orgId: z.string().trim().min(1).max(256).regex(/^[^\s/\\]+$/, 'an org id is one token without whitespace or slashes').nullable().default(null),
}).superRefine((v, ctx) => {
  if (v.visibility === 'org' && !v.orgId) ctx.addIssue({ code: 'custom', path: ['orgId'], message: 'org visibility names the organization (orgId)' });
  if (v.visibility !== 'org' && v.orgId) ctx.addIssue({ code: 'custom', path: ['orgId'], message: 'orgId goes with visibility "org"' });
  if (hostedAgentUsesCode(v.mode)) {
    if (typeof v.files['index.mjs'] !== 'string' || !v.files['index.mjs'].trim()) {
      ctx.addIssue({ code: 'custom', path: ['files'], message: `${v.mode} mode needs code in files["index.mjs"]` });
    }
  } else if (Object.keys(v.files).length) {
    ctx.addIssue({ code: 'custom', path: ['files'], message: 'prompt mode runs no code; switch to tools or handler to add files' });
  }
  const bytes = Object.entries(v.files).reduce((n, [k, s]) => n + Buffer.byteLength(k) + Buffer.byteLength(s), 0);
  if (bytes > HOSTED_AGENT_MAX_FILES_BYTES) ctx.addIssue({ code: 'custom', path: ['files'], message: `code is ${bytes} bytes; the limit is ${HOSTED_AGENT_MAX_FILES_BYTES}` });
  if (typeof v.files['package.json'] === 'string') {
    try { JSON.parse(v.files['package.json']); } catch { ctx.addIssue({ code: 'custom', path: ['files', 'package.json'], message: 'package.json is not valid JSON' }); }
  }
  if (new Set(v.secretNames).size !== v.secretNames.length) ctx.addIssue({ code: 'custom', path: ['secretNames'], message: 'secret names repeat' });
});

export type HostedAgentSpecInput = z.infer<typeof hostedAgentSpecInput>;

/**
 * The part of a spec the runtime sees — no files, no owner, no secrets. The allowlist is the gateway's to enforce;
 * the runtime reads a copy so it can say when a referred file's host is out of reach. The public PoP JWK is
 * public; the private half reaches the runtime beside the secrets, never through the spec.
 */
export const hostedAgentRuntimeSpecOf = (s: HostedAgentSpec): HostedAgentRuntimeSpec => ({
  id: s.id, name: s.name, description: s.description, model: s.model, systemPrompt: s.systemPrompt,
  mode: s.mode, a2ui: s.a2ui, skills: s.skills, version: s.version, media: hostedAgentMediaOf(s),
  allowedHosts: s.allowedHosts, ...(s.popJwk ? { popJwk: s.popJwk } : {}),
});

/** A stored spec's media, with the absent block of an older spec read as all off. */
export const hostedAgentMediaOf = (s: { media?: Partial<HostedAgentMedia> }): HostedAgentMedia => ({
  transcription: s.media?.transcription === true,
  image: s.media?.image === true,
});

/** Build status of an agent's code. Prompt agents are always `ready`. */
export type HostedAgentStatus = 'building' | 'ready' | 'failed';
