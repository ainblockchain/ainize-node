/**
 * AIN SSO on this node: who an SSO account is here, what the provisioning adapter applies, and what it revokes.
 * The design, the configuration and the rollout are in docs/ain-sso.md; this file is the rules.
 *
 * WHAT AN SSO ACCOUNT IS HERE. The node has no users table: an identity is a string — a wallet address, or
 * `google:<sub>` for somebody the site signed in with Google and vouched for on `/api/keys`. An AIN account becomes
 * one more such string, a PRINCIPAL: `sso:<sub>` when it is new here, or the pre-SSO `google:<sub>` principal it was
 * proven to be (by the adapter's verified legacy mapping, or by the person showing their legacy Google session in
 * the same browser). The link is `sso_identities (issuer, subject) → principal`, unique both ways, never by email.
 *
 * WHAT IT IS NOT. An address. A session made through AIN SSO stands for exactly what a Google session stood for —
 * a name, and API keys — and nothing a wallet signature guards: node ownership, the node wallet, payouts, deposits,
 * device approvals. `siteSession()` does not even show an SSO session to those routes. Nothing here reads or writes
 * `owners`, `operatorAddresses`, bindings, node links or payout addresses, so no adapter request can change who owns
 * this node or where its money goes.
 *
 * ORGANIZATIONS. ainize has no organizations of its own. An AIN organization appears in exactly one place: the
 * `orgId` of an API key made in an SSO session for an organization the ID token named. That is the whole
 * org-owned surface, so it is the whole of what suspension switches off (and offboarding deletes). Suspension also
 * locks the account out of signing in here; offboarding does not — it ends the organization's part only. Personal keys —
 * every key made without an organization, including every pre-SSO key — are never touched by either. (A rolled-back
 * legacy mapping is different: what the person made on the legacy principal through the link goes with it.)
 *
 * Token checks below are the ones `@ain-sso/sdk` makes (adapter request JWT, back-channel logout token), written
 * again here with `jose` because that SDK is not published; see docs/ain-sso.md "Provenance".
 */
import { createHash, randomBytes } from 'node:crypto';
import { createLocalJWKSet, createRemoteJWKSet, errors as joseErrors, jwtVerify, type JSONWebKeySet, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';
import type { OpenaiApiKeyStore } from './openai-api-keys.js';
import type { SsoIdentityRow, SsoMembershipRow, SsoSessionFields, Store } from './store.js';

// ------------------------------------------------------------------------------------------------ configuration

export interface SsoConfig {
  /** The AIN SSO issuer, exactly as it appears in `iss` (e.g. `https://auth.comcom.ai`). */
  issuer: string;
  /** This application's client_id at AIN SSO — the `aud` of adapter requests and logout tokens. */
  clientId: string;
  /** The adapter base URL registered at AIN SSO (public, e.g. `https://ainize.ai/api/sso/adapter`); null = adapter off. */
  adapterUrl: string | null;
  jwksUri: string;
}

const isLoopback = (host: string) => host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';

/**
 * AIN SSO is on only when BOTH `AIN_SSO_ISSUER` and `AIN_SSO_CLIENT_ID` are set. Without them the SSO routes are not
 * mounted and the node behaves exactly as before — except that state an adapter already stored (a suspension) is
 * still enforced, because turning SSO off must never let a suspended person back in.
 */
export function readSsoConfig(env: NodeJS.ProcessEnv = process.env): SsoConfig | null {
  const issuer = env.AIN_SSO_ISSUER?.trim();
  const clientId = env.AIN_SSO_CLIENT_ID?.trim();
  if (!issuer || !clientId) return null;
  let url: URL;
  try { url = new URL(issuer); } catch { console.error('[sso] AIN_SSO_ISSUER is not a URL — AIN SSO stays off'); return null; }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
    console.error('[sso] AIN_SSO_ISSUER must be https (plain http only on loopback, for development) — AIN SSO stays off');
    return null;
  }
  const adapterUrl = env.AIN_SSO_ADAPTER_URL?.trim().replace(/\/+$/, '') || null;
  if (adapterUrl) {
    try { new URL(adapterUrl); } catch { console.error('[sso] AIN_SSO_ADAPTER_URL is not a URL — AIN SSO stays off'); return null; }
  }
  const jwksUri = env.AIN_SSO_JWKS_URI?.trim() || new URL('oidc/jwks', issuer.endsWith('/') ? issuer : `${issuer}/`).href;
  return { issuer, clientId, adapterUrl, jwksUri };
}

// ------------------------------------------------------------------------------------------------ errors and principals

/** A refusal with a stable code; routes turn it into `{error, message, retryable}` (adapter protocol §5.2). */
export class SsoError extends Error {
  constructor(readonly code: string, readonly status: number, message?: string, readonly retryable: boolean = status >= 500 || status === 429) {
    super(message ?? code);
    this.name = 'SsoError';
  }
}

export const SSO_SESSION_TTL_MS = 14 * 24 * 3600_000;
/** The only pre-SSO principals an AIN account can be linked to: the site's Google accounts (ADR-0004 amendment). */
const LEGACY_PRINCIPAL = /^google:[0-9a-z_-]{1,255}$/;
/** An OIDC subject, as far as this node cares: printable, bounded, no separators that could forge a principal. */
const SUBJECT = /^[A-Za-z0-9._~-]{1,255}$/;

export const ssoPrincipal = (sub: string) => `sso:${sub}`.toLowerCase();

/** `google:<sub>` lower-cased, or null for anything that is not a legacy principal this node can link. */
export function legacyPrincipal(value: string | null | undefined): string | null {
  const v = value?.trim().toLowerCase();
  return v && LEGACY_PRINCIPAL.test(v) ? v : null;
}

// ------------------------------------------------------------------------------------------------ replay caches

/** Single-use identifiers until they expire. Fails closed when full instead of evicting (eviction reopens replay). */
export class ReplayCache {
  private seen = new Map<string, number>();
  constructor(private readonly max = 100_000, private readonly now: () => number = Date.now) {}
  /** True the first time `id` is seen before `expiresAtMs`; false for a replay. Throws when full. */
  checkAndStore(id: string, expiresAtMs: number): boolean {
    const t = this.now();
    const prev = this.seen.get(id);
    if (prev !== undefined && prev > t) return false;
    if (this.seen.size >= this.max) {
      for (const [k, exp] of this.seen) if (exp <= t) this.seen.delete(k);
      if (this.seen.size >= this.max) throw new SsoError('temporarily_unavailable', 503, 'Replay cache is full.', true);
    }
    this.seen.delete(id);
    this.seen.set(id, expiresAtMs);
    if (this.seen.size % 1024 === 0) for (const [k, exp] of this.seen) if (exp <= t) this.seen.delete(k);
    return true;
  }
}

// ------------------------------------------------------------------------------------------------ JWT verification

/** Asymmetric algorithms only — never `none`, never HS* (a shared secret would let anyone holding it sign). */
export const SSO_ALGORITHMS = ['RS256', 'ES256', 'PS256', 'EdDSA'];
export const ADAPTER_TOKEN_TYPE = 'ain-adapter+jwt';
export const ADAPTER_TOKEN_MAX_LIFETIME_S = 60;
export const LOGOUT_TOKEN_TYPE = 'logout+jwt';
export const BACKCHANNEL_LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';
const CLOCK_TOLERANCE_S = 5;

export type JwksSource = string | JSONWebKeySet | JWTVerifyGetKey;
const remoteSets = new Map<string, JWTVerifyGetKey>();
export function resolveJwks(source: JwksSource): JWTVerifyGetKey {
  if (typeof source === 'function') return source;
  if (typeof source === 'string') {
    let set = remoteSets.get(source);
    if (!set) {
      // Cached for 10 minutes; an unknown `kid` refetches (rate limited), which is how key rotation lands.
      set = createRemoteJWKSet(new URL(source), { cooldownDuration: 30_000, cacheMaxAge: 10 * 60_000, timeoutDuration: 5_000 });
      remoteSets.set(source, set);
    }
    return set;
  }
  return createLocalJWKSet(source);
}

export const bodyHash = (body: Uint8Array | string | null | undefined) => createHash('sha256').update(body ?? '').digest('base64url');
const htuOf = (url: string) => { const u = new URL(url); u.search = ''; u.hash = ''; return u.href; };

export interface AdapterTokenClaims extends JWTPayload { iss: string; iat: number; exp: number; jti: string; htm: string; htu: string; bsh: string }

/**
 * Adapter request verification (adapter protocol v1 §3.2): bearer JWT signed with a key from the AIN SSO JWKS,
 * `typ: ain-adapter+jwt`, `iss`, `aud` = our client_id, lifetime ≤ 60 s and age ≤ 60 s, bound to this method
 * (`htm`), this public URL (`htu`) and these exact body bytes (`bsh`), and single use (`jti`, checked last so a
 * mismatched request never burns an identifier). Throws SsoError 401 `invalid_token`/`missing_token` (or 503).
 */
export async function verifyAdapterRequest(opts: {
  authorization: string | undefined; method: string; expectedUrl: string; body: Uint8Array | string | null;
  issuer: string; audience: string; jwks: JwksSource; replay: ReplayCache; now?: () => Date;
}): Promise<AdapterTokenClaims> {
  const m = opts.authorization ? /^Bearer[ ]+([A-Za-z0-9._~+/=-]+)$/i.exec(opts.authorization.trim()) : null;
  if (!m) throw new SsoError('missing_token', 401, 'Bearer token required.', false);
  const invalid = (message: string) => new SsoError('invalid_token', 401, message, false);
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(m[1]!, resolveJwks(opts.jwks), {
      issuer: opts.issuer, audience: opts.audience, algorithms: SSO_ALGORITHMS, typ: ADAPTER_TOKEN_TYPE,
      clockTolerance: CLOCK_TOLERANCE_S, currentDate: opts.now?.(), maxTokenAge: ADAPTER_TOKEN_MAX_LIFETIME_S,
      requiredClaims: ['iat', 'exp', 'jti', 'htm', 'htu', 'bsh'],
    }));
  } catch (err) {
    if (err instanceof joseErrors.JWKSTimeout) throw new SsoError('temporarily_unavailable', 503, 'Could not fetch the JWKS in time.', true);
    if (err instanceof joseErrors.JOSEError) throw invalid(`Token rejected: ${err.code}.`);
    throw err;
  }
  const claims = payload as AdapterTokenClaims;
  for (const k of ['jti', 'htm', 'htu', 'bsh'] as const) {
    if (typeof claims[k] !== 'string' || claims[k].length === 0 || claims[k].length > 2048) throw invalid(`Claim ${k} is invalid.`);
  }
  if (claims.exp - claims.iat > ADAPTER_TOKEN_MAX_LIFETIME_S) throw invalid('Token lifetime exceeds 60 seconds.');
  if (claims.htm !== opts.method.toUpperCase()) throw invalid('Token is bound to another HTTP method.');
  let same = false;
  try { same = htuOf(claims.htu) === htuOf(opts.expectedUrl); } catch { same = false; }
  if (!same) throw invalid('Token is bound to another URL.');
  if (claims.bsh !== bodyHash(opts.body)) throw invalid('Token is bound to another body.');
  if (!opts.replay.checkAndStore(`${claims.iss}\u0000${claims.jti}`, (claims.exp + CLOCK_TOLERANCE_S) * 1000)) throw invalid('Token was already used.');
  return claims;
}

export interface VerifiedLogoutToken { iss: string; sub: string | null; sid: string | null; jti: string }

/**
 * OIDC Back-Channel Logout 1.0 §2.6: signature (JWKS), `typ: logout+jwt`, `iss`, `aud`, `iat` no older than 120 s,
 * `exp`, the back-channel `events` member, `sid` and/or `sub`, NO `nonce` (an ID token must never pass as a logout
 * token), and single use of `jti`. Throws SsoError 400 `invalid_request`, or rethrows a JWKS timeout (transient).
 */
export async function verifyLogoutToken(token: string, opts: { issuer: string; audience: string; jwks: JwksSource; replay: ReplayCache; now?: () => Date }): Promise<VerifiedLogoutToken> {
  const bad = (message: string) => new SsoError('invalid_request', 400, message, false);
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, resolveJwks(opts.jwks), {
      issuer: opts.issuer, audience: opts.audience, algorithms: SSO_ALGORITHMS, typ: LOGOUT_TOKEN_TYPE,
      clockTolerance: CLOCK_TOLERANCE_S, currentDate: opts.now?.(), maxTokenAge: 120, requiredClaims: ['iat', 'exp', 'jti', 'events'],
    }));
  } catch (err) {
    if (err instanceof joseErrors.JOSEError && !(err instanceof joseErrors.JWKSTimeout)) throw bad(`logout token rejected: ${err.code}`);
    throw err;
  }
  const events = payload.events;
  const member = events && typeof events === 'object' && !Array.isArray(events) ? (events as Record<string, unknown>)[BACKCHANNEL_LOGOUT_EVENT] : undefined;
  if (!member || typeof member !== 'object' || Array.isArray(member)) throw bad('not a back-channel logout event');
  if ('nonce' in payload) throw bad('logout token must not contain nonce');
  const sub = typeof payload.sub === 'string' && payload.sub.length > 0 ? payload.sub : null;
  const sid = typeof payload.sid === 'string' && payload.sid.length > 0 ? payload.sid : null;
  if (!sub && !sid) throw bad('logout token needs sub or sid');
  if (typeof payload.jti !== 'string' || payload.jti.length === 0 || payload.jti.length > 512) throw bad('invalid jti');
  if (!opts.replay.checkAndStore(`${payload.iss}\u0000${payload.jti}`, (payload.exp! + CLOCK_TOLERANCE_S) * 1000)) throw bad('logout token replayed');
  return { iss: payload.iss!, sub, sid, jti: payload.jti };
}

// ------------------------------------------------------------------------------------------------ wire shapes

/** `DesiredUserState`, schema `ain-sso.adapter.v1` (vendored from `@ain-sso/contracts` adapter.ts). Unknown fields are ignored. */
export const ADAPTER_SCHEMA_V1 = 'ain-sso.adapter.v1';
export const desiredUserState = z.object({
  schema: z.literal(ADAPTER_SCHEMA_V1),
  sub: z.string(),
  org: z.object({ id: z.string(), slug: z.string(), name: z.string() }),
  version: z.number().int().positive(),
  status: z.enum(['active', 'suspended', 'deprovisioned']),
  profile: z.object({ name: z.string().nullable(), email: z.string().nullable(), workEmail: z.string().nullable() }),
  appRole: z.string().nullable(),
  groups: z.array(z.object({ id: z.string(), slug: z.string(), name: z.string(), kind: z.enum(['team', 'department', 'access', 'mail']) })),
  legacyUserId: z.string().nullable(),
  ownershipTransferTo: z.string().nullable(),
  issuedAt: z.string(),
});
export type DesiredUserState = z.infer<typeof desiredUserState>;
export interface ApplyResult { appliedVersion: number; localUserId: string | null; status: DesiredUserState['status'] }
export interface CurrentUserState {
  exists: boolean; localUserId: string | null; appliedVersion: number | null; status: DesiredUserState['status'] | null; appRole: string | null; groups: string[];
}

export interface SsoSignIn {
  iss: string;
  sub: string;
  sid: string | null;
  name: string | null;
  email: string | null;
  orgs: { id: string; slug: string; name: string }[];
  activeOrg: string | null;
  /** a legacy principal the person proved in the site (ADR-0004 `app_proof`) */
  link: { principal: string; method: 'legacy_session' } | null;
  /** the site offers "connect your existing account" when there is no link yet (LEGACY_LOGIN allows it) */
  allowConnect: boolean;
  /** the site's previous session token in this browser, ended when the new one starts */
  replaces: string | null;
}
export type SsoSignInResult =
  | { status: 'needs_link' }
  | { status: 'ok'; token: string; principal: string; expiresAt: number; created: boolean; linked: string | null };

export interface PrincipalState { linked: boolean; blocked: boolean; notBefore: number | null }

// ------------------------------------------------------------------------------------------------ the service

export interface SsoServiceDeps {
  store: Store;
  keys: OpenaiApiKeyStore;
  config: SsoConfig | null;
  /** The node's event log; every change the adapter applies is written here with actor `ain-sso`. */
  log: (level: 'info' | 'warn', message: string, data?: unknown) => void;
  /** Tests: a JWKS object or getter instead of fetching `config.jwksUri`. */
  jwks?: JwksSource;
  now?: () => Date;
}

export class SsoService {
  readonly adapterReplay = new ReplayCache();
  readonly logoutReplay = new ReplayCache();

  constructor(private readonly deps: SsoServiceDeps) {}

  get config(): SsoConfig | null { return this.deps.config; }
  get jwks(): JwksSource | null { return this.deps.jwks ?? this.deps.config?.jwksUri ?? null; }
  now(): Date { return this.deps.now?.() ?? new Date(); }

  private requireConfig(): SsoConfig {
    if (!this.deps.config) throw new SsoError('sso_disabled', 404, 'AIN SSO is not configured on this node.', false);
    return this.deps.config;
  }

  // --- status: enforced whether or not AIN SSO is configured right now ------------------------------------------

  /**
   * Suspended: some organization has the account `suspended` and none has it `active`. That is the account-level
   * status — it refuses SSO sign-in, the legacy Google path and key management.
   *
   * Offboarding (`deprovisioned`) is NOT a block. It takes away what the organization gave — its keys (revoked in
   * `apply`, refused at use by `orgKeyUsable`) and its sessions — and nothing else: ainize.ai is open to any AIN
   * account (`any_account`), so a person who left the organization still signs in and keeps what is personal.
   */
  isBlocked(issuer: string, subject: string): boolean {
    const ms = this.deps.store.ssoMemberships(issuer, subject);
    return ms.some((m) => m.status === 'suspended') && !ms.some((m) => m.status === 'active');
  }

  /** What the site asks before honouring a legacy (Google) session: is that principal an AIN account's, and may it act? */
  principalState(principal: string): PrincipalState {
    const ident = this.deps.store.ssoIdentityByPrincipal(principal.trim().toLowerCase());
    if (!ident) return { linked: false, blocked: false, notBefore: null };
    return { linked: true, blocked: this.isBlocked(ident.issuer, ident.subject), notBefore: ident.sessions_not_before ?? null };
  }

  /** For API keys at use time: may `owner` still act for `orgId`? No state = nothing has said otherwise. */
  orgKeyUsable(owner: string, orgId: string): boolean {
    const ident = this.deps.store.ssoIdentityByPrincipal(owner);
    if (!ident) return true;
    const m = this.deps.store.ssoMembership(ident.issuer, ident.subject, orgId);
    return !m || m.status === 'active';
  }

  /** An account that is still its own fresh `sso:<sub>` and holds no key: linking it to a legacy principal loses nothing. */
  private holdsNothing(ident: SsoIdentityRow, sub: string): boolean {
    return ident.principal === ssoPrincipal(sub) && this.deps.keys.countFor(ident.principal) === 0;
  }

  // --- sign-in: the site verified an ID token and asks for a session ---------------------------------------------

  /**
   * Resolve the account to its principal (link by (issuer, sub) only; create it just in time, or link the legacy
   * principal the person proved) and start a session keyed by the OIDC `sid`. One transaction, so two first logins
   * of the same account end with one identity, and a suspension applied at the same moment cannot interleave.
   */
  signIn(input: SsoSignIn): SsoSignInResult {
    const cfg = this.requireConfig();
    if (input.iss !== cfg.issuer) throw new SsoError('wrong_issuer', 400, 'The ID token came from another issuer.', false);
    if (!SUBJECT.test(input.sub)) throw new SsoError('invalid_request', 400, 'The subject is not usable here.', false);
    const store = this.deps.store;
    return store.transaction(() => {
      let ident = store.ssoIdentity(cfg.issuer, input.sub);
      if (ident && this.isBlocked(cfg.issuer, input.sub)) throw new SsoError('account_suspended', 403, 'This account is suspended.', false);
      let created = false;
      let linked: string | null = null;
      const link = input.link ? legacyPrincipal(input.link.principal) : null;
      if (input.link && !link) throw new SsoError('invalid_request', 400, 'That is not an account this node can link.', false);
      if (!ident) {
        if (link) {
          if (store.ssoIdentityByPrincipal(link)) throw new SsoError('legacy_conflict', 409, 'That account is already linked to another AIN account.', false);
          store.insertSsoIdentity({ issuer: cfg.issuer, subject: input.sub, principal: link, linkProof: `app_proof:${input.link!.method}`, name: input.name, email: input.email });
          linked = link;
        } else if (input.allowConnect) {
          return { status: 'needs_link' } as const;
        } else {
          store.insertSsoIdentity({ issuer: cfg.issuer, subject: input.sub, principal: ssoPrincipal(input.sub), linkProof: 'sso_login', name: input.name, email: input.email });
        }
        ident = store.ssoIdentity(cfg.issuer, input.sub)!;
        created = true;
      } else if (link && ident.principal !== link) {
        // Already known here. Only an account that holds nothing yet may become the legacy one: two key sets are
        // never merged silently, and a link the adapter or an earlier proof made is never re-pointed from here.
        if (!this.holdsNothing(ident, input.sub)) throw new SsoError('already_linked', 409, 'This AIN account already has its own account here.', false);
        if (store.ssoIdentityByPrincipal(link)) throw new SsoError('legacy_conflict', 409, 'That account is already linked to another AIN account.', false);
        store.relinkSsoIdentity(cfg.issuer, input.sub, link, `app_proof:${input.link!.method}`, 'connected_legacy_account');
        store.deleteSsoSessions(cfg.issuer, input.sub, null);
        ident = store.ssoIdentity(cfg.issuer, input.sub)!;
        linked = link;
      } else if (!link && input.allowConnect && this.holdsNothing(ident, input.sub)) {
        // Known here, but still the empty `sso:<sub>` an automatic sign-in (which never asks) or the adapter made.
        // Such an account can still become the legacy one (above), so the person who presses the button is asked
        // again; otherwise the first automatic sign-in would have taken the question away for good.
        return { status: 'needs_link' } as const;
      }
      store.updateSsoProfile(cfg.issuer, input.sub, { name: input.name, email: input.email });
      const orgs = input.orgs.slice(0, 50).map((o) => ({ id: String(o.id).slice(0, 200), slug: String(o.slug).slice(0, 200), name: String(o.name).slice(0, 200) }));
      const org = input.activeOrg && orgs.some((o) => o.id === input.activeOrg) ? input.activeOrg : null;
      if (input.replaces) store.deleteSession(input.replaces);
      const token = randomBytes(24).toString('hex');
      const sso: SsoSessionFields = { iss: cfg.issuer, sub: input.sub, sid: input.sid, orgs, org };
      store.putSession(token, SSO_SESSION_TTL_MS, { subject: ident.principal, scheme: 'sso', sso });
      this.deps.log('info', `ain-sso: ${ident.principal} signed in${created ? ' (first time)' : ''}${linked ? `, linked to ${linked}` : ''}`,
        { actor: 'ain-sso', sub: input.sub, principal: ident.principal, linked });
      return { status: 'ok', token, principal: ident.principal, expiresAt: Date.now() + SSO_SESSION_TTL_MS, created, linked } as const;
    });
  }

  // --- provisioning adapter ---------------------------------------------------------------------------------------

  currentState(orgId: string, sub: string): CurrentUserState | null {
    const cfg = this.requireConfig();
    const m = this.deps.store.ssoMembership(cfg.issuer, sub, orgId);
    if (!m) return null;
    const ident = this.deps.store.ssoIdentity(cfg.issuer, sub);
    return { exists: true, localUserId: ident?.principal ?? null, appliedVersion: m.applied_version, status: m.status, appRole: m.app_role, groups: m.groups };
  }

  /**
   * Apply a desired state (adapter protocol v1 §4). Version check-and-set, linking, the status change and every
   * revocation happen in one transaction and before the caller answers 200. Older or equal versions are no-ops.
   */
  apply(state: DesiredUserState): ApplyResult {
    const cfg = this.requireConfig();
    const store = this.deps.store;
    const keys = this.deps.keys;
    return store.transaction(() => {
      const cur = store.ssoMembership(cfg.issuer, state.sub, state.org.id);
      if (cur && state.version <= cur.applied_version) {
        return { appliedVersion: cur.applied_version, localUserId: store.ssoIdentity(cfg.issuer, state.sub)?.principal ?? null, status: cur.status };
      }
      if (!SUBJECT.test(state.sub)) throw new SsoError('invalid_request', 400, 'The subject is not usable here.', false);
      const ident = this.resolveForState(cfg.issuer, state);
      store.putSsoMembership({
        issuer: cfg.issuer, subject: state.sub, org_id: state.org.id, org_slug: state.org.slug, org_name: state.org.name, status: state.status,
        app_role: state.status === 'active' ? state.appRole : null, groups: state.status === 'active' ? state.groups.map((g) => g.slug) : [],
        legacy_user_id: state.legacyUserId, applied_version: state.version,
      });
      store.updateSsoProfile(cfg.issuer, state.sub, { name: state.profile.name, email: state.profile.email });
      let sessionsEnded = 0;
      let keysChanged = 0;
      const reason = `ain-sso:${state.status}:${state.org.id}`;
      if (state.status === 'active') {
        // Reactivation: keys that suspension only switched off come back; deleted ones stay deleted.
        keysChanged = keys.setOrgKeys(ident.principal, state.org.id, 'enable', reason);
      } else {
        // Ending application sessions is per person (protocol §4.3); the SSO lets them straight back in for any
        // organization that is still active. Keys are per organization: only this organization's.
        sessionsEnded = store.deleteSsoSessions(cfg.issuer, state.sub, null);
        keysChanged = keys.setOrgKeys(ident.principal, state.org.id, state.status === 'deprovisioned' ? 'revoke' : 'disable', reason);
      }
      if (state.status === 'deprovisioned' && state.ownershipTransferTo) {
        // Nothing here is organization-owned AND transferable: organization API keys are bearer secrets, which are
        // revoked, never handed to somebody else. Recorded so the audit trail says the policy was seen.
        this.deps.log('info', `ain-sso: no organization-owned resources to transfer for ${ident.principal} in ${state.org.slug}`, { actor: 'ain-sso', transferTo: state.ownershipTransferTo });
      }
      this.deps.log(state.status === 'active' ? 'info' : 'warn',
        `ain-sso: ${ident.principal} is ${state.status} in ${state.org.slug} (v${state.version})${sessionsEnded ? `, ${sessionsEnded} session(s) ended` : ''}${keysChanged ? `, ${keysChanged} organization key(s) ${state.status === 'active' ? 're-enabled' : state.status === 'suspended' ? 'disabled' : 'revoked'}` : ''}`,
        { actor: 'ain-sso', sub: state.sub, org: state.org.id, version: state.version, status: state.status, sessionsEnded, keysChanged });
      return { appliedVersion: state.version, localUserId: ident.principal, status: state.status };
    });
  }

  /**
   * Linking rules of protocol §4.4, ainize flavour. Every refusal is decided BEFORE anything changes, because API
   * keys live in a file the SQLite rollback cannot undo.
   *
   * Only an account that does not exist here yet is ever refused (`legacy_user_not_found`, `legacy_conflict`), as
   * §4.4 says. Once it exists, a `legacyUserId` this node cannot link — not `google:<sub>`, taken by another account,
   * or contradicting the link the app proved — is logged and left unapplied, and the state is applied all the same:
   * AIN SSO sends the mapping with EVERY state, so refusing it here would refuse the suspension and the offboarding
   * that come with it (§4.3), on every retry, for as long as the mapping stands.
   */
  private resolveForState(issuer: string, state: DesiredUserState): SsoIdentityRow {
    const store = this.deps.store;
    const keys = this.deps.keys;
    const sub = state.sub;
    const legacy = state.legacyUserId === null ? null : legacyPrincipal(state.legacyUserId);
    const ident = store.ssoIdentity(issuer, sub);
    if (!ident) {
      if (state.legacyUserId !== null && !legacy) {
        throw new SsoError('legacy_user_not_found', 409, 'ainize links only google:<sub> legacy users; a wallet address is proven by its own signature.', false);
      }
      if (legacy && store.ssoIdentityByPrincipal(legacy)) throw new SsoError('legacy_conflict', 409, 'The legacy user is linked to another account.', false);
      store.insertSsoIdentity({ issuer, subject: sub, principal: legacy ?? ssoPrincipal(sub), linkProof: legacy ? 'legacy_mapping' : 'provisioning', name: state.profile.name, email: state.profile.email });
      if (legacy) this.deps.log('info', `ain-sso: ${legacy} linked to AIN account ${sub} (verified legacy mapping)`, { actor: 'ain-sso', sub, principal: legacy });
      return store.ssoIdentity(issuer, sub)!;
    }

    // Plan. A mapping that now names anything else — nothing, another Google user, or something unlinkable — ends
    // the link it made.
    const rollBack = ident.link_proof === 'legacy_mapping' && ident.principal !== legacy;
    const principalAfter = rollBack ? ssoPrincipal(sub) : ident.principal;
    const proofAfter = rollBack ? 'provisioning' : ident.link_proof;
    let linkNew = false;
    let notApplied: string | null = null;
    if (state.legacyUserId !== null && !legacy) {
      notApplied = 'ainize links only google:<sub> legacy users';
    } else if (legacy && principalAfter !== legacy) {
      if (proofAfter.startsWith('app_proof')) {
        notApplied = `the account was linked in the app to ${principalAfter}`;
      } else if (principalAfter === ssoPrincipal(sub) && keys.countFor(principalAfter) === 0) {
        // The account exists here but holds nothing: treat it as not existing yet (protocol §4.4), so a mapping that
        // arrives after the first login still links. Nothing is lost by it.
        if (store.ssoIdentityByPrincipal(legacy)) notApplied = 'the legacy user is linked to another AIN account';
        else linkNew = true;
      } else {
        notApplied = `the account already holds its own keys here as ${principalAfter}; merging must be explicit`;
      }
    }

    // Execute.
    if (rollBack) {
      // The mapping was rolled back or replaced at AIN SSO: that legacy principal is no longer this person here.
      // What they obtained on it through the link goes with it (§4.4): its organization keys, and every key made in
      // an SSO session of this account. The legacy principal keeps the personal keys it made itself.
      const revoked = keys.revokeObtainedThrough(ident.principal, { iss: issuer, sub });
      store.relinkSsoIdentity(issuer, sub, ssoPrincipal(sub), 'provisioning', legacy ? 'legacy_mapping_replaced' : 'legacy_mapping_rolled_back');
      store.deleteSsoSessions(issuer, sub, null);
      this.deps.log('warn', `ain-sso: ${ident.principal} is no longer linked to AIN account ${sub} (mapping rolled back)${revoked ? `, ${revoked} key(s) made through the link revoked` : ''}`,
        { actor: 'ain-sso', sub, principal: ident.principal, keysRevoked: revoked });
    }
    if (linkNew) {
      store.relinkSsoIdentity(issuer, sub, legacy!, 'legacy_mapping', 'legacy_mapping_applied');
      store.deleteSsoSessions(issuer, sub, null);
      this.deps.log('info', `ain-sso: ${legacy} linked to AIN account ${sub} (verified legacy mapping)`, { actor: 'ain-sso', sub, principal: legacy });
    } else if (notApplied) {
      // Not the legacy id itself: it may be a wallet address, and the reason says enough for an administrator.
      this.deps.log('warn', `ain-sso: legacy mapping for AIN account ${sub} not applied — ${notApplied}; the rest of the state is`, { actor: 'ain-sso', sub, principal: principalAfter });
    }
    return store.ssoIdentity(issuer, sub)!;
  }

  // --- back-channel logout -----------------------------------------------------------------------------------------

  /**
   * End the sessions a logout token names: those of one OIDC session (`sid`), or — `sub` alone — every session of
   * the account here, including the legacy Google session of a linked principal (the site checks `notBefore`).
   */
  logout(token: VerifiedLogoutToken): number {
    const cfg = this.requireConfig();
    const store = this.deps.store;
    return store.transaction(() => {
      let ended: number;
      if (token.sid) ended = store.deleteSsoSessions(cfg.issuer, token.sub, token.sid);
      else {
        ended = store.deleteSsoSessions(cfg.issuer, token.sub, null);
        store.setSsoSessionsNotBefore(cfg.issuer, token.sub!, Date.now());
      }
      this.deps.log('info', `ain-sso: back-channel logout ended ${ended} session(s)`, { actor: 'ain-sso', sid: token.sid, sub: token.sub });
      return ended;
    });
  }
}

export type { SsoMembershipRow };
