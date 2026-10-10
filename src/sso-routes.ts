/**
 * The HTTP side of AIN SSO on this node (sso.ts has the rules, docs/ain-sso.md the why):
 *
 *   GET  /api/sso/adapter/v1/health                      adapter liveness, no auth
 *   PUT  /api/sso/adapter/v1/orgs/:orgId/users/:sub      apply a DesiredUserState   (AIN SSO request JWT)
 *   GET  /api/sso/adapter/v1/orgs/:orgId/users/:sub      report the applied state   (AIN SSO request JWT)
 *   POST /api/auth/sso/backchannel-logout                OIDC back-channel logout   (logout token)
 *   POST /api/auth/sso/session                           the site: "this ID token checked out — start a session"
 *   POST /api/auth/sso/principal                         the site: "may this legacy Google session still act?"
 *
 * Every path is under `/api`, which ainize-web relays to this node unchanged, so AIN SSO reaches the adapter and the
 * logout endpoint at the site's public origin. The last two are for the site alone and demand its signature
 * (site-call.ts), which the relay strips from anything a visitor sends.
 */
import express, { Router, type NextFunction, type RequestHandler, type ErrorRequestHandler, type Request, type Response } from 'express';
import { z } from 'zod';
import { SITE_CALL_HEADER, type SiteCallVerifier } from './site-call.js';
import {
  ADAPTER_SCHEMA_V1, desiredUserState, SsoError, verifyAdapterRequest, verifyLogoutToken, type CurrentUserState, type SsoService,
} from './sso.js';

export const SSO_ADAPTER_MOUNT = '/api/sso/adapter';
/** Largest adapter body accepted (the SDK default; a DesiredUserState is a few hundred bytes). */
export const SSO_ADAPTER_MAX_BODY = 64 * 1024;

type Handler = (req: Request, res: Response) => Promise<void> | void;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => { Promise.resolve(fn(req, res)).catch(next); };

function send(res: Response, status: number, body: unknown): void {
  res.status(status).set('cache-control', 'no-store').json(body);
}

/** Adapter protocol §5.2 error body. Internal details never leave: an unexpected failure is `adapter_error`. */
function adapterError(res: Response, err: unknown, log: (e: unknown) => void): void {
  if (err instanceof SsoError) {
    if (err.status === 401) res.set('www-authenticate', 'Bearer error="invalid_token"');
    send(res, err.status, { error: err.code, message: err.message, retryable: err.retryable });
    return;
  }
  const status = (err as { status?: number; type?: string }).status;
  if (status === 413 || (err as { type?: string }).type === 'entity.too.large') { send(res, 413, { error: 'payload_too_large', message: 'Body too large.', retryable: false }); return; }
  log(err);
  send(res, 500, { error: 'adapter_error', message: 'Internal adapter error.', retryable: true });
}

const signInBody = z.object({
  iss: z.string().min(1).max(500),
  sub: z.string().min(1).max(255),
  sid: z.string().min(1).max(500).nullable().default(null),
  name: z.string().max(200).nullable().default(null),
  email: z.string().max(320).nullable().default(null),
  orgs: z.array(z.object({ id: z.string().min(1).max(200), slug: z.string().max(200), name: z.string().max(200) })).max(50).default([]),
  activeOrg: z.string().max(200).nullable().default(null),
  link: z.object({ principal: z.string().min(1).max(300), method: z.literal('legacy_session') }).nullable().default(null),
  allowConnect: z.boolean().default(false),
  replaces: z.string().max(200).nullable().default(null),
});

export interface SsoRoutesDeps {
  sso: SsoService;
  /** Null when the node shares no secret with a site: then the two site-only routes are not mounted at all. */
  siteCalls: SiteCallVerifier | null;
  log: (message: string, err?: unknown) => void;
}

/**
 * Mount BEFORE the node's JSON body parser: the adapter's request JWT signs the exact body bytes, so its route
 * gets them raw (`express.raw` here), and the JSON parser then leaves that request alone.
 */
export function ssoRawBodyParser(): (RequestHandler | ErrorRequestHandler)[] {
  const raw = express.raw({ type: () => true, limit: SSO_ADAPTER_MAX_BODY });
  // A body over the limit fails in the parser, before any route runs: answer it in the protocol's shape too.
  const tooLarge = (err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) { next(err); return; }
    adapterError(res, err, () => undefined);
  };
  return [raw, tooLarge];
}

export function ssoRoutes(deps: SsoRoutesDeps): Router {
  const router = Router();
  const { sso } = deps;
  const cfg = sso.config;

  // ---------------------------------------------------------------- the site's own calls
  if (deps.siteCalls) {
    const siteCalls = deps.siteCalls;
    const fromSite = (req: Request, res: Response): boolean => {
      if (siteCalls.verify(req, (req as Request & { rawBody?: Buffer }).rawBody)) return true;
      send(res, 401, { error: 'not_the_site', message: `this route answers the site in front of this node, and only with a valid ${SITE_CALL_HEADER}` });
      return false;
    };

    /** Works with AIN SSO switched off: what an adapter stored (a suspension) must hold through every rollback. */
    router.post('/api/auth/sso/principal', (req, res) => {
      if (!fromSite(req, res)) return;
      const parsed = z.object({ principal: z.string().min(1).max(300) }).safeParse(req.body);
      if (!parsed.success) { send(res, 400, { error: 'invalid_request' }); return; }
      send(res, 200, sso.principalState(parsed.data.principal));
    });

    if (cfg) {
      router.post('/api/auth/sso/session', (req, res) => {
        if (!fromSite(req, res)) return;
        const parsed = signInBody.safeParse(req.body);
        if (!parsed.success) { send(res, 400, { error: 'invalid_request', message: parsed.error.issues[0]?.message }); return; }
        try {
          send(res, 200, sso.signIn(parsed.data));
        } catch (err) {
          if (err instanceof SsoError) { send(res, err.status, { error: err.code, message: err.message }); return; }
          deps.log('sign-in failed', err);
          send(res, 500, { error: 'server_error' });
        }
      });
    }
  }

  if (!cfg) return router;

  // ---------------------------------------------------------------- back-channel logout (OIDC BCL 1.0)
  router.post('/api/auth/sso/backchannel-logout', express.urlencoded({ extended: false, limit: '16kb' }), wrap(async (req, res) => {
    const token = typeof (req.body as Record<string, unknown> | undefined)?.logout_token === 'string' ? (req.body as { logout_token: string }).logout_token : null;
    if (!token) { send(res, 400, { error: 'invalid_request', error_description: 'logout_token missing' }); return; }
    try {
      const verified = await verifyLogoutToken(token, { issuer: cfg.issuer, audience: cfg.clientId, jwks: sso.jwks!, replay: sso.logoutReplay, now: () => sso.now() });
      sso.logout(verified);
      res.status(200).set('cache-control', 'no-store').end();
    } catch (err) {
      if (err instanceof SsoError) { send(res, 400, { error: 'invalid_request', error_description: err.message }); return; }
      deps.log('back-channel logout failed', err);
      // 501 would mean "logout not supported"; a transient failure is a server error, and AIN SSO retries it.
      send(res, 500, { error: 'server_error' });
    }
  }));

  // ---------------------------------------------------------------- provisioning adapter (protocol v1)
  const adapterUrl = cfg.adapterUrl;
  router.get(`${SSO_ADAPTER_MOUNT}/v1/health`, (_req, res) => { send(res, 200, { status: 'ok', schema: ADAPTER_SCHEMA_V1 }); });

  router.all(`${SSO_ADAPTER_MOUNT}/v1/orgs/:orgId/users/:sub`, wrap(async (req, res) => {
    try {
      if (!adapterUrl) throw new SsoError('adapter_not_configured', 503, 'Set AIN_SSO_ADAPTER_URL to the adapter URL registered at AIN SSO.', true);
      if (req.method !== 'GET' && req.method !== 'PUT') { res.set('allow', 'GET, PUT'); throw new SsoError('method_not_allowed', 405, 'GET or PUT.', false); }
      const orgId = String(req.params.orgId);
      const sub = String(req.params.sub);
      // The URL AIN SSO signed is its registered adapter URL + the path it built with encodeURIComponent — rebuilt
      // the same way here, so neither the relay's decoding nor a TLS-terminating proxy changes what is compared.
      const expectedUrl = `${adapterUrl}/v1/orgs/${encodeURIComponent(orgId)}/users/${encodeURIComponent(sub)}`;
      const body = req.method === 'PUT' && Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      await verifyAdapterRequest({
        authorization: req.header('authorization'), method: req.method, expectedUrl, body,
        issuer: cfg.issuer, audience: cfg.clientId, jwks: sso.jwks!, replay: sso.adapterReplay, now: () => sso.now(),
      });
      if (req.method === 'GET') {
        const current: CurrentUserState = sso.currentState(orgId, sub) ?? { exists: false, localUserId: null, appliedVersion: null, status: null, appRole: null, groups: [] };
        send(res, 200, current);
        return;
      }
      if (!body.length) throw new SsoError('invalid_request', 400, 'A DesiredUserState body is required.', false);
      let json: unknown;
      try { json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); } catch { throw new SsoError('invalid_request', 400, 'Body is not UTF-8 JSON.', false); }
      const parsed = desiredUserState.safeParse(json);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        throw new SsoError('invalid_request', 400, `Body is not a valid DesiredUserState${first ? ` (${first.path.join('.')}: ${first.message})` : ''}.`, false);
      }
      if (parsed.data.sub !== sub || parsed.data.org.id !== orgId) throw new SsoError('invalid_request', 400, 'Body does not match the request path.', false);
      send(res, 200, sso.apply(parsed.data));
    } catch (err) {
      adapterError(res, err, (e) => deps.log('adapter request failed', e));
    }
  }));
  router.all(`${SSO_ADAPTER_MOUNT}/{*rest}`, (_req, res) => { send(res, 404, { error: 'not_found', retryable: false }); });
  return router;
}
