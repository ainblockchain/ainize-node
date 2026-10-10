/**
 * The node's machine identity at AIN SSO: an OAuth 2.0 `client_credentials` token for a resource server
 * (RFC 8707 `resource`), obtained with the node's app credentials (`AIN_SSO_CLIENT_ID` / `AIN_SSO_CLIENT_SECRET`,
 * `client_secret_basic`) and cached until shortly before it expires. AIN SSO architecture §4.9.
 *
 * Today's one use: `ProjectWorker` clones a project's repository from aindrive with `aud=<aindrive origin>`;
 * aindrive trusts the token's `sub` (this app) and makes it a viewer on the drives shared with an organization the
 * app is assigned in (aindrive `web/lib/sso/service-principal.ts`). The token is a bearer secret for its 5 minutes:
 * it is handed to git through the environment, never logged, and the error text of a failed request never carries it.
 */

export interface ServiceTokenClientOptions {
  /** The AIN SSO issuer (exactly as configured; discovery is read from `{issuer}/.well-known/openid-configuration`). */
  issuer: string;
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** Seconds before `exp` at which a cached token counts as expired (default 30). */
  skewSeconds?: number;
  log?: (level: 'info' | 'warn', message: string) => void;
}

interface Cached { token: string; expiresAt: number }

export class ServiceTokenError extends Error {
  constructor(message: string, readonly status: number | null = null) { super(message); this.name = 'ServiceTokenError'; }
}

const META_TTL_MS = 10 * 60_000;

/** Absolute http(s) URL without query, fragment or credentials; plain http only on loopback (development). */
const isLoopback = (host: string) => host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
function endpointOk(raw: unknown, issuer: URL): raw is string {
  if (typeof raw !== 'string') return false;
  const u = URL.parse(raw);
  if (!u || u.search || u.hash || u.username || u.password) return false;
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && issuer.protocol === 'http:' && isLoopback(u.hostname);
}

/** The resource indicator for a repository URL: its origin (what aindrive compares `aud` with — its public URL). */
export function resourceOf(repoUrl: string): string {
  return new URL(repoUrl).origin;
}

export class ServiceTokenClient {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly skew: number;
  private meta: { tokenEndpoint: string; at: number } | null = null;
  private readonly cache = new Map<string, Cached>();
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(private readonly opts: ServiceTokenClientOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
    this.skew = opts.skewSeconds ?? 30;
  }

  /** A live token for `resource` (cached per resource; one request in flight per resource). */
  token(resource: string): Promise<string> {
    const cached = this.cache.get(resource);
    if (cached && cached.expiresAt - this.skew * 1000 > this.now()) return Promise.resolve(cached.token);
    let p = this.inflight.get(resource);
    if (!p) {
      p = this.request(resource).finally(() => this.inflight.delete(resource));
      this.inflight.set(resource, p);
    }
    return p;
  }

  /** Drop a cached token (after the resource server refused it). */
  forget(resource: string): void { this.cache.delete(resource); }

  private async tokenEndpoint(): Promise<string> {
    if (this.meta && this.now() - this.meta.at < META_TTL_MS) return this.meta.tokenEndpoint;
    const issuer = new URL(this.opts.issuer);
    const res = await this.fetchImpl(new URL('.well-known/openid-configuration', issuer.href.endsWith('/') ? issuer.href : `${issuer.href}/`), { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new ServiceTokenError(`AIN SSO discovery answered ${res.status}`, res.status);
    const meta = (await res.json()) as { issuer?: unknown; token_endpoint?: unknown };
    // The document must describe exactly the configured issuer (mix-up defence) and point back at it.
    if (meta.issuer !== this.opts.issuer.replace(/\/+$/, '') && meta.issuer !== this.opts.issuer) throw new ServiceTokenError('AIN SSO discovery: issuer mismatch');
    if (!endpointOk(meta.token_endpoint, issuer) || new URL(meta.token_endpoint).origin !== issuer.origin) throw new ServiceTokenError('AIN SSO discovery: bad token_endpoint');
    this.meta = { tokenEndpoint: meta.token_endpoint, at: this.now() };
    return meta.token_endpoint;
  }

  private async request(resource: string): Promise<string> {
    const endpoint = await this.tokenEndpoint();
    const basic = Buffer.from(`${encodeURIComponent(this.opts.clientId)}:${encodeURIComponent(this.opts.clientSecret)}`).toString('base64');
    const body = new URLSearchParams({ grant_type: 'client_credentials', resource });
    let res: Response;
    try {
      res = await this.fetchImpl(endpoint, { method: 'POST', headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body, redirect: 'error', signal: AbortSignal.timeout(10_000) });
    } catch (e) {
      throw new ServiceTokenError(`AIN SSO token endpoint unreachable: ${(e as Error).message}`);
    }
    const json = (await res.json().catch(() => ({}))) as { access_token?: unknown; token_type?: unknown; expires_in?: unknown; error?: unknown; error_description?: unknown };
    if (!res.ok || typeof json.access_token !== 'string' || !json.access_token) {
      const what = typeof json.error === 'string' ? `${json.error}${typeof json.error_description === 'string' ? `: ${json.error_description}` : ''}` : `HTTP ${res.status}`;
      throw new ServiceTokenError(`AIN SSO refused a machine token for ${resource} (${what})`, res.status);
    }
    if (typeof json.token_type === 'string' && json.token_type.toLowerCase() !== 'bearer') throw new ServiceTokenError(`AIN SSO issued a ${json.token_type} token; only Bearer is usable`);
    const ttl = typeof json.expires_in === 'number' && json.expires_in > 0 ? json.expires_in : 60;
    this.cache.set(resource, { token: json.access_token, expiresAt: this.now() + ttl * 1000 });
    this.opts.log?.('info', `machine token for ${resource} obtained (${ttl}s)`);
    return json.access_token;
  }
}
