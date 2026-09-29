/**
 * `/api/shared-agents` — this node's agents in the cross-product AGENT REGISTRY shape (ain-integration contracts
 * `agent-ref.ts`, `list.ts`, `events.ts`, `errors.ts`, contract "1.0"), so every product reads "which agents can I
 * use here" the same way it reads it from any other origin.
 *
 * The shape is re-declared here rather than imported: the contract package lives outside this repository, and a
 * node must build alone. Keep the field names, enums and `contract: "1.0"` byte-compatible with its
 * `fixtures/agent-list-response.json`; that fixture is the one both sides test against.
 *
 * Who is asking is an `AgentCaller`: a wallet session (the site's sign-in) or an AIN SSO session, resolved once per
 * request. Visibility (hosted-agent-types.ts) is decided here so the hosted-agent routes, the marketplace list and
 * this registry cannot disagree about who sees what.
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { HostedAgentHost } from './hosted-agent-host.js';
import type { HostedAgentStore } from './hosted-agent-store.js';
import type { LinkedAgentStore } from './linked-agent-store.js';
import type { OpenaiApiKeyStore } from './openai-api-keys.js';
import { HOSTED_AGENT_A2UI_EXTENSION_URI } from './hosted-agent-runtime/hostedAgentA2ui.js';
import { hostedAgentModesOf } from './hosted-agent-runtime/hostedAgentRuntimeApp.js';
import { HOSTED_AGENT_VISIBILITIES, hostedAgentMediaOf, hostedAgentVisibilityOf, type HostedAgentSpec, type HostedAgentVisibility } from './hosted-agent-types.js';
import { siteSession, ssoSession } from './site-session.js';
import type { SsoSessionFields, Store } from './store.js';

// ------------------------------------------------------------------------------------------------ the contract

export const CONTRACT_VERSION = '1.0' as const;

export type AgentVisibility = HostedAgentVisibility;
export type AgentStatus = 'active' | 'disabled' | 'stopped' | 'deleted';
export type UiCapability = 'streaming' | 'cancel' | 'image_in' | 'image_out' | 'audio_in' | 'audio_out' | 'ainui' | 'a2ui_basic' | 'file_refs_out';
export const AGENT_LIST_SCOPES = ['mine', 'shared_with_me', 'shared_with_org', 'public'] as const;
export type AgentListScope = (typeof AGENT_LIST_SCOPES)[number];

export interface OwnerRef {
  kind: 'account' | 'org' | 'wallet' | 'principal';
  issuer: string;
  subject: string;
  displayName?: string;
}

export interface AgentSkill { id: string; name: string; description?: string; examples?: string[] }

export interface AgentRef {
  contract: typeof CONTRACT_VERSION;
  registryIssuer: string;
  agentId: string;
  releaseId: string;
  ownerRef: OwnerRef;
  visibility: AgentVisibility;
  orgRef?: OwnerRef;
  agentCardUrl: string;
  endpoint: string;
  supportedProtocolVersions: string[];
  skills: AgentSkill[];
  inputModes: string[];
  outputModes: string[];
  uiCapabilities: UiCapability[];
  pricingRef?: string;
  status: AgentStatus;
  displayName: string;
  description?: string;
  updatedAt: string;
}

export interface AgentListItem { ref: AgentRef; canInvoke: boolean }
export interface AgentListResponse {
  contract: typeof CONTRACT_VERSION;
  asOf: string;
  nextCursor: string | null;
  cursorExpired?: boolean;
  items: AgentListItem[];
}

export type AgentEventType = 'agent.published' | 'agent.updated' | 'agent.unpublished' | 'agent.disabled' | 'agent.moved' | 'agent.deleted' | 'agent.revoked';
export interface AgentEvent {
  kind: 'agent';
  type: AgentEventType;
  eventId: string;
  /** `<registryIssuer>#<agentId>` — the contract's `agentKey()`. */
  resourceId: string;
  version: number;
  occurredAt: string;
  releaseId?: string;
}
export interface AgentEventPage { contract: typeof CONTRACT_VERSION; events: AgentEvent[]; nextCursor: string; gap: boolean }

export type ContractErrorCode = 'auth_required' | 'forbidden' | 'entitlement_required' | 'unsupported_input' | 'source_offline' | 'resource_deleted' | 'agent_stopped' | 'rate_limited' | 'temporary_failure';
export const CONTRACT_HTTP_STATUS: Record<ContractErrorCode, number> = {
  auth_required: 401, forbidden: 403, entitlement_required: 402, unsupported_input: 415,
  source_offline: 503, resource_deleted: 410, agent_stopped: 409, rate_limited: 429, temporary_failure: 503,
};
const CONTRACT_RETRYABLE: Record<ContractErrorCode, boolean> = {
  auth_required: false, forbidden: false, entitlement_required: false, unsupported_input: false,
  source_offline: true, resource_deleted: false, agent_stopped: false, rate_limited: true, temporary_failure: true,
};

export interface ContractErrorBody {
  error: { code: string; message: string; retryable: boolean; retryAfterSeconds?: number; actionUrl?: string; detail?: string };
}

/** The contract's error body (`errors.ts`), at the status the contract assigns the code. */
export const contractError = (code: ContractErrorCode, message: string, extra: Partial<Omit<ContractErrorBody['error'], 'code' | 'message' | 'retryable'>> = {}): ContractErrorBody =>
  ({ error: { code, message, retryable: CONTRACT_RETRYABLE[code], ...extra } });

const refuse = (res: Response, code: ContractErrorCode, message: string, extra: Partial<Omit<ContractErrorBody['error'], 'code' | 'message' | 'retryable'>> = {}) => {
  res.status(CONTRACT_HTTP_STATUS[code]).json(contractError(code, message, extra));
};
/**
 * A malformed query is the caller's bug, not one of the contract's nine outcomes — none of which means "you sent
 * nonsense". It is answered 400 in the contract's body shape with a code outside its enum, the way the node's
 * other routes spell it, rather than mislabelled as `unsupported_input` (415, which is about agent input modes).
 */
const invalid = (res: Response, message: string) => { res.status(400).json({ error: { code: 'invalid_request', message, retryable: false } }); };

// ------------------------------------------------------------------------------------------------ who is asking

/**
 * The signed-in identity behind a request, as hosted agents and the registry see it: the string that owns
 * agents (a lower-case wallet address, or an SSO principal), and what it may act for.
 */
export interface AgentCaller {
  subject: string;
  kind: 'wallet' | 'principal';
  /** What the ID token said, for an AIN SSO session. Null for a wallet session. */
  sso: Pick<SsoSessionFields, 'iss' | 'sub' | 'org'> & { orgs: string[] } | null;
  /** May this caller act for `orgId`. */
  orgMember: (orgId: string) => boolean;
  /**
   * The organization an API key was issued for, when the caller IS an API key (`apiKeyCaller`): the one org it
   * speaks for, the way `sso.org` is the one an SSO session selected. Null for a personal key and for sessions.
   */
  keyOrg?: string | null;
}

/** A wallet session: an address owns what it made and belongs to no organization. */
export const walletCaller = (address: string): AgentCaller => ({ subject: address.toLowerCase(), kind: 'wallet', sso: null, orgMember: () => false });

/** A bare principal (`sso:<sub>`, `google:<sub>`) with no session behind it: owns what it made, belongs to nothing here. */
export const principalCaller = (subject: string): AgentCaller =>
  /^0x/i.test(subject) ? walletCaller(subject) : { subject, kind: 'principal', sso: null, orgMember: () => false };

/**
 * An Ainize API key as the caller (`Authorization: Bearer ainize-sk-…`): it speaks for the account that issued it
 * and, when it is an organization key (`POST /api/keys {org_id}` by an SSO member), for that one organization —
 * the way a product with no browser session (AIN Teams, a cron) lists and registers an organization's agents.
 * Membership was checked when the key was issued and is re-checked on every use by the key store's `orgGate`.
 */
export const apiKeyCaller = (record: { address: string; orgId: string | null }): AgentCaller => {
  const base = principalCaller(record.address);
  return { ...base, keyOrg: record.orgId, orgMember: (orgId) => !!record.orgId && orgId === record.orgId };
};

/**
 * An AIN SSO session's membership of `orgId`: what the provisioning adapter last applied (`sso_memberships`) when it
 * has spoken — a suspended or offboarded account is not a member, whatever its ID token said — and otherwise the
 * organizations the ID token named at sign-in, for a node whose adapter is off (docs/ain-sso.md).
 */
export function ssoOrgMember(store: Pick<Store, 'ssoMembership'>, sso: { iss: string; sub: string; orgs: string[] }, orgId: string): boolean {
  const m = store.ssoMembership(sso.iss, sso.sub, orgId);
  if (m) return m.status === 'active';
  return sso.orgs.includes(orgId);
}

export function ssoCaller(store: Pick<Store, 'ssoMembership'>, s: { principal: string } & SsoSessionFields): AgentCaller {
  const sso = { iss: s.iss, sub: s.sub, org: s.org, orgs: s.orgs.map((o) => o.id) };
  return { subject: s.principal.toLowerCase(), kind: 'principal', sso, orgMember: (orgId) => ssoOrgMember(store, sso, orgId) };
}

/**
 * Who is signed in on this request — the site's wallet session, an AIN SSO session, or an Ainize API key sent as
 * `Authorization: Bearer` — or null. A key is looked at only when no session matched: a site session token is
 * also a bearer, and `siteSession` reads it first.
 */
export function agentCallerOf(req: Request, deps: { store: Store; nodeAddress: string; keys?: Pick<OpenaiApiKeyStore, 'recordForKey'> }): AgentCaller | null {
  const wallet = siteSession(req, deps.store, deps.nodeAddress);
  if (wallet) return walletCaller(wallet.address);
  const sso = ssoSession(req, deps.store);
  if (sso) return ssoCaller(deps.store, sso);
  const auth = req.header('authorization') ?? '';
  const token = /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim();
  const record = token && deps.keys ? deps.keys.recordForKey(token) : null;
  return record ? apiKeyCaller(record) : null;
}

/** Who a caller is, as an agent's `owner` field spells it (hosted-agent-store / linked-agent-store lower-case wallets). */
export const callerPrincipal = (caller: AgentCaller): string => caller.subject;

// ------------------------------------------------------------------------------------------------ visibility

/**
 * What every kind of agent this node lists has in common for the question "who sees it": an owner (the operator
 * for a config agent), a visibility and, for `org`, the organization. Hosted specs, linked agents and the config
 * summaries all fit; the rules below are written once against this shape so no two lists can disagree.
 */
export interface Shareable { owner: string; visibility?: HostedAgentVisibility | null; orgId?: string | null }

const owns = (spec: Shareable, caller: AgentCaller | null) => !!caller && spec.owner === caller.subject;
const orgVisible = (spec: Shareable, caller: AgentCaller | null) => !!caller && !!spec.orgId && caller.orgMember(spec.orgId);

/** May `caller` read the agent by id: its owner, anyone for `public` and `unlisted`, a member for `org`. */
export function canSeeAgent(spec: Shareable, caller: AgentCaller | null): boolean {
  const v = hostedAgentVisibilityOf(spec);
  return owns(spec, caller) || v === 'public' || v === 'unlisted' || (v === 'org' && orgVisible(spec, caller));
}
export const canSeeHostedAgent = canSeeAgent;

/** Is the agent LISTED to `caller`: `unlisted` is the owner's alone in a list, however reachable by id. */
export function listsAgentFor(spec: Shareable, caller: AgentCaller | null): boolean {
  const v = hostedAgentVisibilityOf(spec);
  return owns(spec, caller) || v === 'public' || (v === 'org' && orgVisible(spec, caller));
}
export const listsHostedAgentFor = listsAgentFor;

/** Listed to anyone at all — what the marketplace (`/api/agents`) and gossip advertise. */
export const agentIsPublic = (spec: { visibility?: HostedAgentVisibility | null }) => hostedAgentVisibilityOf(spec) === 'public';
export const hostedAgentIsPublic = agentIsPublic;

/** `public` and `org` agents are published somewhere; `private` and `unlisted` are not. */
const published = (v: HostedAgentVisibility) => v === 'public' || v === 'org';

/** What an update was, as the change feed tells it. */
export function hostedAgentChangeType(prior: { visibility?: HostedAgentVisibility | null }, next: { visibility?: HostedAgentVisibility | null }): AgentEventType {
  const was = published(hostedAgentVisibilityOf(prior));
  const is = published(hostedAgentVisibilityOf(next));
  if (was && !is) return 'agent.unpublished';
  if (!was && is) return 'agent.published';
  return 'agent.updated';
}

// ------------------------------------------------------------------------------------------------ the change feed

export const SHARED_AGENT_EVENTS_MAX = 1000;
const EVENT_CURSOR = /^ev_(\d{1,15})$/;

/**
 * The last `max` agent changes, in memory. A consumer polls with the cursor it was last given and applies what is
 * newer than it holds (events.ts `applyEvents`); when its cursor predates what is still held — or names a sequence
 * this process never issued, after a restart — `gap` tells it to re-list rather than trust the page.
 */
/**
 * Who may learn that an event happened. A snapshot at append time (the spec may be gone by the time the feed
 * is read): the feed must not reveal a private or unlisted agent's id to anyone but its owner, nor an org
 * agent's to non-members. For an update, the audience is the WIDER of before/after, so whoever saw the agent
 * as public also learns that it was unpublished.
 */
export interface AgentEventAudience { visibility: HostedAgentVisibility; owner: string; orgId?: string | null }
export const widerAudience = (a: AgentEventAudience, b: AgentEventAudience): AgentEventAudience => {
  const rank: Record<HostedAgentVisibility, number> = { public: 3, org: 2, unlisted: 1, private: 0 };
  return rank[a.visibility] >= rank[b.visibility] ? a : b;
};
export const audienceOf = (spec: Shareable): AgentEventAudience => ({ visibility: hostedAgentVisibilityOf(spec), owner: spec.owner, orgId: spec.orgId ?? null });

export class SharedAgentEvents {
  private readonly events: AgentEvent[] = [];
  private readonly audiences = new Map<string, AgentEventAudience>();
  private seq = 0;
  /** The sequence number of the last event evicted from the buffer. */
  private dropped = 0;

  constructor(private readonly max = SHARED_AGENT_EVENTS_MAX) {}

  append(e: { type: AgentEventType; registryIssuer: string; agentId: string; version: number; releaseId?: string; audience?: AgentEventAudience }, now = Date.now()): AgentEvent {
    const seq = ++this.seq;
    const event: AgentEvent = {
      kind: 'agent', type: e.type, eventId: `evt_${seq}`, resourceId: `${e.registryIssuer.replace(/\/+$/, '')}#${e.agentId}`,
      version: e.version, occurredAt: new Date(now).toISOString(), ...(e.releaseId ? { releaseId: e.releaseId } : {}),
    };
    this.events.push(event);
    // No audience given (proxied agents, tests): public.
    this.audiences.set(event.eventId, e.audience ?? { visibility: 'public', owner: '' });
    while (this.events.length > this.max) { const gone = this.events.shift()!; this.audiences.delete(gone.eventId); this.dropped += 1; }
    return event;
  }

  /** May `caller` see this event at all. Mirrors `listsHostedAgentFor` on the audience snapshot. */
  visibleTo(event: AgentEvent, caller: AgentCaller | null): boolean {
    const a = this.audiences.get(event.eventId);
    if (!a || a.visibility === 'public') return true;
    if (caller && a.owner === caller.subject) return true;
    return a.visibility === 'org' && !!caller && !!a.orgId && caller.orgMember(a.orgId);
  }

  /** Events after `cursor` (all held events when absent). Null when the cursor is not one this feed issues. */
  page(cursor: string | null | undefined, caller: AgentCaller | null = null): AgentEventPage | null {
    let after = 0;
    if (cursor) {
      const m = EVENT_CURSOR.exec(cursor);
      if (!m) return null;
      after = Number(m[1]);
    }
    const events = after > this.seq ? [] : this.events.filter((e) => Number(e.eventId.slice(4)) > after && this.visibleTo(e, caller));
    // A cursor older than the buffer, or ahead of anything this process issued (a restart): what the consumer
    // holds cannot be brought up to date by events alone.
    const gap = !!cursor && (after > this.seq || after < this.dropped);
    return { contract: CONTRACT_VERSION, events, nextCursor: `ev_${this.seq}`, gap };
  }

  get size(): number { return this.events.length; }
}

// ------------------------------------------------------------------------------------------------ refs

/** A config agent this node proxies (agents.ts), as much of it as a ref needs. */
export interface ProxiedAgentSummary {
  id: string;
  name: string;
  description?: string;
  skills: AgentSkill[];
  extensions: string[];
  /** Null until the card has been fetched once. */
  reachable: boolean | null;
  updatedAt: number;
  /** A linked agent's registering account; absent for the operator's config agents. */
  owner?: string;
  /** Sharing, as hosted agents have it; absent → `public`. A config agent may declare these in config.json. */
  visibility?: HostedAgentVisibility | null;
  orgId?: string | null;
  /** A linked agent's version counter (`releaseId: linked-v<n>`); absent for a config agent (`upstream`). */
  version?: number;
}

/** A proxied agent as the visibility rules read it: the operator owns what config.json declares. */
export const proxiedShareable = (a: ProxiedAgentSummary, operator: string): Shareable =>
  ({ owner: a.owner ?? operator.toLowerCase(), visibility: a.visibility ?? 'public', orgId: a.orgId ?? null });

const trimSlash = (u: string) => u.replace(/\/+$/, '');
const agentUrls = (issuer: string, id: string) => {
  const endpoint = `${trimSlash(issuer)}/agents/${id}`;
  return { endpoint, agentCardUrl: `${endpoint}/.well-known/agent-card.json` };
};

export const SHARED_AGENT_PROTOCOL_VERSIONS = ['0.3.0'];

/** A hosted agent's owner as the contract names it: a wallet the node verified, or the node-local principal. */
export const hostedAgentOwnerRef = (owner: string, registryIssuer: string): OwnerRef =>
  ({ kind: owner.startsWith('0x') ? 'wallet' : 'principal', issuer: trimSlash(registryIssuer), subject: owner });

export function hostedAgentRef(spec: HostedAgentSpec, o: {
  registryIssuer: string;
  status: { status: 'building' | 'ready' | 'failed' } | null;
  /** The issuer that minted `orgId` — the AIN SSO issuer; this node when SSO is not configured. */
  orgIssuer: string;
}): AgentRef {
  const media = hostedAgentMediaOf(spec);
  const modes = hostedAgentModesOf({ ...spec, media });
  const visibility = hostedAgentVisibilityOf(spec);
  const st = o.status?.status ?? 'failed';
  return {
    contract: CONTRACT_VERSION,
    registryIssuer: trimSlash(o.registryIssuer),
    agentId: spec.id,
    releaseId: `v${spec.version}`,
    ownerRef: hostedAgentOwnerRef(spec.owner, o.registryIssuer),
    visibility,
    ...(visibility === 'org' && spec.orgId ? { orgRef: { kind: 'org' as const, issuer: trimSlash(o.orgIssuer), subject: spec.orgId } } : {}),
    ...agentUrls(o.registryIssuer, spec.id),
    supportedProtocolVersions: SHARED_AGENT_PROTOCOL_VERSIONS,
    skills: (spec.skills.length ? spec.skills : [{ id: 'chat', name: spec.name, ...(spec.description ? { description: spec.description } : {}) }])
      .map((s) => ({ id: s.id, name: s.name, ...(s.description ? { description: s.description } : {}), ...(s.examples?.length ? { examples: s.examples } : {}) })),
    inputModes: modes.input,
    outputModes: [...modes.output, ...(spec.a2ui ? ['application/a2ui+json'] : [])],
    uiCapabilities: ['streaming', 'cancel', ...(spec.a2ui ? ['a2ui_basic' as const] : []), ...(media.transcription ? ['audio_in' as const] : []), ...(media.image ? ['image_out' as const] : [])],
    status: st === 'ready' ? 'active' : st === 'building' ? 'disabled' : 'stopped',
    displayName: spec.name,
    ...(spec.description ? { description: spec.description } : {}),
    updatedAt: new Date(spec.updatedAt).toISOString(),
  };
}

/**
 * A proxied agent's ref. A config agent is the operator's and, unless config.json says otherwise, public; a linked
 * agent is its registering account's, with the sharing it was registered with (`releaseId: linked-v<n>`).
 */
export function proxiedAgentRef(a: ProxiedAgentSummary, o: { registryIssuer: string; operator: string; orgIssuer?: string }): AgentRef {
  const share = proxiedShareable(a, o.operator);
  const visibility = hostedAgentVisibilityOf(share);
  return {
    contract: CONTRACT_VERSION,
    registryIssuer: trimSlash(o.registryIssuer),
    agentId: a.id,
    releaseId: a.version !== undefined ? `linked-v${a.version}` : 'upstream',
    ownerRef: hostedAgentOwnerRef(share.owner, o.registryIssuer),
    visibility,
    ...(visibility === 'org' && share.orgId ? { orgRef: { kind: 'org' as const, issuer: trimSlash(o.orgIssuer ?? o.registryIssuer), subject: share.orgId } } : {}),
    ...agentUrls(o.registryIssuer, a.id),
    supportedProtocolVersions: SHARED_AGENT_PROTOCOL_VERSIONS,
    skills: (a.skills.length ? a.skills : [{ id: 'chat', name: a.name }]).slice(0, 32),
    inputModes: ['text/plain'],
    outputModes: ['text/plain', ...(a.extensions.includes(HOSTED_AGENT_A2UI_EXTENSION_URI) ? ['application/a2ui+json'] : [])],
    uiCapabilities: ['streaming', ...(a.extensions.includes(HOSTED_AGENT_A2UI_EXTENSION_URI) ? ['a2ui_basic' as const] : [])],
    // Unprobed is not down: the card is fetched on the marketplace list and on gossip, and until then the only
    // thing known about the agent is that the operator configured it.
    status: a.reachable === false ? 'stopped' : 'active',
    displayName: a.name,
    ...(a.description ? { description: a.description } : {}),
    updatedAt: new Date(a.updatedAt).toISOString(),
  };
}

// ------------------------------------------------------------------------------------------------ the routes

export interface SharedAgentRoutesDeps {
  store: HostedAgentStore;
  host: Pick<HostedAgentHost, 'status'>;
  /** The config agents this node proxies, with what the registry (agents.ts) has learned of their cards. */
  proxied: () => ProxiedAgentSummary[];
  caller: (req: Request) => AgentCaller | null;
  /** This node's public base URL — the `registryIssuer` every ref carries. */
  registryIssuer: (req: Request) => string;
  /** The AIN SSO issuer that mints org ids; null when SSO is not configured (the node then stands in). */
  ssoIssuer: () => string | null;
  /** The node's own address: the owner of every config agent. */
  selfAddress: string;
  events: SharedAgentEvents;
  /** Linked agents, for `PUT /api/shared-agents/{id}/visibility`; a node without the store answers 404 for them. */
  linked?: Pick<LinkedAgentStore, 'get' | 'setSharing'>;
  /**
   * Does this request come from the node's operator (api.ts owners: the node key, `operatorAddresses`, granted
   * owners)? An operator may change any agent's sharing, and may share with an organization they are no member of —
   * that is how the operator puts the agents already on the node into an organization's list.
   */
  isOperator?: (req: Request) => boolean;
  /** Per-IP ceiling on these routes, per minute. */
  rateLimit?: { windowMs: number; max: number };
}

export const SHARED_AGENT_LIST_LIMIT = { default: 50, max: 200 };
const LIST_CURSOR = /^[A-Za-z0-9+/=_-]{1,64}$/;

const encodeOffset = (n: number) => Buffer.from(String(n)).toString('base64url');
const decodeOffset = (cursor: string): number | null => {
  if (!LIST_CURSOR.test(cursor)) return null;
  const n = Number(Buffer.from(cursor, 'base64url').toString('utf8'));
  return Number.isInteger(n) && n >= 0 ? n : null;
};

const one = (v: unknown): string | undefined => (Array.isArray(v) ? v[0] : v) as string | undefined;

export function sharedAgentRoutes(deps: SharedAgentRoutesDeps): Router {
  const router = Router();
  const limit = deps.rateLimit ?? { windowMs: 60_000, max: 240 };
  const hits = new Map<string, { n: number; resetAt: number }>();

  const limited = (req: Request, res: Response): boolean => {
    const now = Date.now();
    const ip = req.ip ?? 'unknown';
    const h = hits.get(ip);
    if (!h || h.resetAt <= now) { hits.set(ip, { n: 1, resetAt: now + limit.windowMs }); if (hits.size > 10_000) hits.clear(); return false; }
    if (++h.n > limit.max) {
      const retryAfterSeconds = Math.max(1, Math.ceil((h.resetAt - now) / 1000));
      res.setHeader('retry-after', String(retryAfterSeconds));
      refuse(res, 'rate_limited', 'too many registry requests from this address; try again shortly', { retryAfterSeconds });
      return true;
    }
    return false;
  };

  /** Everything, wrapped: a failure inside is `temporary_failure`, so a consumer retries rather than blames the user. */
  const guarded = (handler: (req: Request, res: Response) => void) => (req: Request, res: Response) => {
    if (limited(req, res)) return;
    try { handler(req, res); } catch (e) {
      if (!res.headersSent) refuse(res, 'temporary_failure', e instanceof Error ? e.message : 'unexpected failure');
    }
  };

  const hostedItem = (req: Request, spec: HostedAgentSpec, caller: AgentCaller | null): AgentListItem => {
    const ref = hostedAgentRef(spec, { registryIssuer: deps.registryIssuer(req), status: deps.host.status(spec.id), orgIssuer: deps.ssoIssuer() ?? deps.registryIssuer(req) });
    return { ref, canInvoke: ref.status === 'active' && canSeeAgent(spec, caller) };
  };
  const proxiedItem = (req: Request, a: ProxiedAgentSummary, caller: AgentCaller | null): AgentListItem => {
    const ref = proxiedAgentRef(a, { registryIssuer: deps.registryIssuer(req), operator: deps.selfAddress, orgIssuer: deps.ssoIssuer() ?? deps.registryIssuer(req) });
    return { ref, canInvoke: ref.status === 'active' && canSeeAgent(proxiedShareable(a, deps.selfAddress), caller) };
  };
  /** Every agent the node lists, each with the sharing view the rules read, so the scopes below are one filter each. */
  const everything = (req: Request, caller: AgentCaller | null): { share: Shareable; item: () => AgentListItem }[] => [
    ...deps.store.list().map((s) => ({ share: s as Shareable, item: () => hostedItem(req, s, caller) })),
    ...deps.proxied().map((a) => ({ share: proxiedShareable(a, deps.selfAddress), item: () => proxiedItem(req, a, caller) })),
  ];

  router.get('/api/shared-agents', guarded((req, res) => {
    const scope = one(req.query.scope);
    if (!scope || !(AGENT_LIST_SCOPES as readonly string[]).includes(scope)) return invalid(res, `scope is one of ${AGENT_LIST_SCOPES.join(', ')}`);
    const q = one(req.query.q);
    if (q !== undefined && (typeof q !== 'string' || q.length > 200)) return invalid(res, 'q is at most 200 characters');
    const org = one(req.query.org);
    if (org !== undefined && (typeof org !== 'string' || !org || org.length > 256)) return invalid(res, 'org is an organization id');
    const rawLimit = one(req.query.limit);
    const pageSize = rawLimit === undefined ? SHARED_AGENT_LIST_LIMIT.default : Number(rawLimit);
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > SHARED_AGENT_LIST_LIMIT.max) return invalid(res, `limit is 1..${SHARED_AGENT_LIST_LIMIT.max}`);
    const rawCursor = one(req.query.cursor);
    const offset = rawCursor === undefined ? 0 : decodeOffset(rawCursor);
    if (offset === null) return invalid(res, 'cursor is not one this node issued');

    const caller = deps.caller(req);
    if (!caller && scope !== 'public') return refuse(res, 'auth_required', 'sign in to list the agents shared with you');
    if (scope === 'shared_with_org' && !caller?.sso && !caller?.keyOrg) return refuse(res, 'forbidden', 'organization listings need an AIN SSO session or an organization API key');
    const orgScope = scope === 'shared_with_org' ? (org ?? caller!.sso?.org ?? caller!.keyOrg ?? null) : (org ?? null);
    if (scope === 'shared_with_org' && !orgScope) return invalid(res, 'name the organization (?org=) — the session selected none');
    if (orgScope && !caller?.orgMember(orgScope)) return refuse(res, 'forbidden', 'you are not a member of that organization');

    const all = everything(req, caller);
    let picked: typeof all;
    switch (scope as AgentListScope) {
      case 'public':
        picked = all.filter((e) => agentIsPublic(e.share));
        break;
      case 'mine':
        picked = all.filter((e) => e.share.owner === caller!.subject);
        break;
      case 'shared_with_me':
        picked = all.filter((e) => e.share.owner !== caller!.subject && hostedAgentVisibilityOf(e.share) === 'org' && listsAgentFor(e.share, caller));
        break;
      case 'shared_with_org':
        picked = all.filter((e) => hostedAgentVisibilityOf(e.share) === 'org' && e.share.orgId === orgScope);
        break;
    }
    let items = picked.map((e) => e.item());
    if (orgScope) items = items.filter((i) => i.ref.orgRef?.subject === orgScope);
    if (q) {
      const needle = q.toLowerCase();
      items = items.filter((i) => i.ref.displayName.toLowerCase().includes(needle) || (i.ref.description ?? '').toLowerCase().includes(needle));
    }
    items.sort((a, b) => (a.ref.updatedAt < b.ref.updatedAt ? 1 : a.ref.updatedAt > b.ref.updatedAt ? -1 : a.ref.agentId < b.ref.agentId ? -1 : a.ref.agentId > b.ref.agentId ? 1 : 0));
    const page = items.slice(offset, offset + pageSize);
    const body: AgentListResponse = {
      contract: CONTRACT_VERSION,
      asOf: new Date().toISOString(),
      nextCursor: offset + pageSize < items.length ? encodeOffset(offset + pageSize) : null,
      items: page,
    };
    res.json(body);
  }));

  /**
   * Change who sees an agent — `{visibility, orgId?}` — without touching what it runs or where it points. The
   * owner may do it (sharing with an organization they belong to); the node's operator may do it to ANY hosted or
   * linked agent, for any organization: that is how the agents already on a node become an organization's list.
   * A config agent's sharing lives in config.json and is refused here with the field to edit.
   */
  const sharingInput = z.object({
    visibility: z.enum(HOSTED_AGENT_VISIBILITIES),
    orgId: z.string().trim().min(1).max(256).regex(/^[^\s/\\]+$/, 'an org id is one token without whitespace or slashes').nullable().default(null),
  }).superRefine((v, ctx) => {
    if (v.visibility === 'org' && !v.orgId) ctx.addIssue({ code: 'custom', path: ['orgId'], message: 'org visibility names the organization (orgId)' });
    if (v.visibility !== 'org' && v.orgId) ctx.addIssue({ code: 'custom', path: ['orgId'], message: 'orgId goes with visibility "org"' });
  });
  router.put('/api/shared-agents/:id/visibility', guarded((req, res) => {
    const caller = deps.caller(req);
    if (!caller) return refuse(res, 'auth_required', 'sign in to change who sees an agent');
    const parsed = sharingInput.safeParse(req.body ?? {});
    if (!parsed.success) { const i = parsed.error.issues[0]; return invalid(res, `${i?.path.join('.') || 'body'}: ${i?.message ?? 'invalid'}`); }
    const sharing = { visibility: parsed.data.visibility, orgId: parsed.data.visibility === 'org' ? parsed.data.orgId : null };
    const id = String(req.params.id);
    const operator = deps.isOperator?.(req) ?? false;

    // A config agent's sharing is the file's: named to the operator, 404 to anyone else (they may not learn it exists).
    if (deps.proxied().some((a) => a.id === id && a.version === undefined)) {
      if (!operator) return refuse(res, 'resource_deleted', `no agent "${id}" on this node`);
      return invalid(res, `"${id}" is a config agent: set agents[].visibility and agents[].orgId in config.json and restart the node`);
    }
    const hosted = deps.store.get(id);
    const linked = hosted ? null : deps.linked?.get(id) ?? null;
    const target: Shareable | null = hosted ?? linked;
    if (!target || (!operator && !canSeeAgent(target, caller))) return refuse(res, 'resource_deleted', `no agent "${id}" on this node`);
    if (!operator && target.owner !== caller.subject) return refuse(res, 'forbidden', 'only the agent\'s owner or the node\'s operator may change who sees it');
    if (!operator && sharing.orgId && !caller.orgMember(sharing.orgId)) {
      return refuse(res, 'forbidden', caller.kind === 'wallet'
        ? 'sharing with an organization needs an AIN SSO session or an organization API key; a wallet belongs to none'
        : `you are not a member of ${sharing.orgId}`);
    }

    const issuer = trimSlash(deps.registryIssuer(req));
    const orgIssuer = deps.ssoIssuer() ?? issuer;
    if (hosted) {
      const next = deps.store.setSharing(id, sharing);
      deps.events.append({ type: hostedAgentChangeType(hosted, next), registryIssuer: issuer, agentId: id, version: next.version, releaseId: `v${next.version}`, audience: widerAudience(audienceOf(hosted), audienceOf(next)) });
      return res.json({ agent: hostedAgentRef(next, { registryIssuer: issuer, status: deps.host.status(id), orgIssuer }) });
    }
    const prior = linked!;
    const next = deps.linked!.setSharing(id, sharing);
    deps.events.append({ type: hostedAgentChangeType(prior, next), registryIssuer: issuer, agentId: id, version: next.version, releaseId: `linked-v${next.version}`, audience: widerAudience(audienceOf(prior), audienceOf(next)) });
    const summary = deps.proxied().find((a) => a.id === id);
    const ref = proxiedAgentRef(summary
      ? { ...summary, owner: next.owner, visibility: next.visibility, orgId: next.orgId ?? null, version: next.version, updatedAt: next.updatedAt }
      : { id, name: next.name, description: next.description || undefined, skills: [], extensions: [], reachable: null, updatedAt: next.updatedAt, owner: next.owner, visibility: next.visibility, orgId: next.orgId ?? null, version: next.version },
      { registryIssuer: issuer, operator: deps.selfAddress, orgIssuer });
    res.json({ agent: ref });
  }));

  router.get('/api/shared-agents/events', guarded((req, res) => {
    const page = deps.events.page(one(req.query.cursor), deps.caller(req));
    if (!page) return invalid(res, 'cursor is not one this node issued');
    res.json(page);
  }));

  return router;
}
