/**
 * An agent this node RUNS, as opposed to one it proxies (agents.ts `config.agents`).
 *
 * Created over HTTP by anyone signed in (hosted-agent-routes.ts), stored as JSON (hosted-agent-store.ts), run by
 * the runtime in hosted-agent-runtime/ — in-process for prompt agents, in Docker for agents that bring code.
 * Design: docs/superpowers/specs/2026-09-26-hosted-agents-design.md.
 */
import { z } from 'zod';
import type { HostedAgentMode, HostedAgentRuntimeSpec } from './hosted-agent-runtime/hostedAgentRuntimeTypes.js';

export type { HostedAgentMode };

export interface HostedAgentSpec extends HostedAgentRuntimeSpec {
  /** Code, for `tools` and `handler`. `index.mjs` is the entry; `package.json` is installed when present. */
  files: Record<string, string>;
  allowedHosts: string[];
  secretNames: string[];
  /** Lower-case EVM address of whoever created it. Only they may change it. */
  owner: string;
  createdAt: number;
  updatedAt: number;
}

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
  skills: z.array(z.object({
    id: z.string().trim().min(1).max(64),
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(300).optional(),
    examples: z.array(z.string().max(300)).max(4).optional(),
  })).max(8).default([]),
}).superRefine((v, ctx) => {
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

/** The part of a spec the runtime sees — no files, no owner, no allowlist (the gateway holds that). */
export const hostedAgentRuntimeSpecOf = (s: HostedAgentSpec): HostedAgentRuntimeSpec => ({
  id: s.id, name: s.name, description: s.description, model: s.model, systemPrompt: s.systemPrompt,
  mode: s.mode, a2ui: s.a2ui, skills: s.skills, version: s.version,
});

/** Build status of an agent's code. Prompt agents are always `ready`. */
export type HostedAgentStatus = 'building' | 'ready' | 'failed';
