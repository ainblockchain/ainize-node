/**
 * A small stand-in for AIN SSO, for tests: its signing key, its JWKS served over HTTP (so the node fetches keys the
 * way it will in production), and the three kinds of token the node checks — adapter request JWTs, back-channel
 * logout tokens — plus the site's signed calls (site-call.ts) that carry a verified ID token's claims.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { signSiteCall } from '../../src/site-call.js';

export interface TestIssuer {
  issuer: string;
  jwksUri: string;
  /** an unrelated key, for "signed by somebody else" */
  foreign: CryptoKey;
  key: CryptoKey;
  kid: string;
  stop(): Promise<void>;
}

export async function startTestIssuer(): Promise<TestIssuer> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const { privateKey: foreign } = await generateKeyPair('RS256', { extractable: true });
  const kid = `kid_${randomUUID().slice(0, 8)}`;
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
  const server: Server = createServer((req, res) => {
    if (req.url === '/oidc/jwks') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: [jwk] })); return; }
    res.statusCode = 404; res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  const issuer = `http://127.0.0.1:${port}`;
  return {
    issuer, jwksUri: `${issuer}/oidc/jwks`, key: privateKey, foreign, kid,
    stop: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export const bsh = (body: string) => createHash('sha256').update(body).digest('base64url');

export interface AdapterTokenOptions {
  method: string; url: string; body: string; audience: string;
  typ?: string; alg?: string; iss?: string; iat?: number; exp?: number; jti?: string; bsh?: string; key?: CryptoKey | Uint8Array; kid?: string;
  omit?: string[];
}

export async function adapterToken(iss: TestIssuer, o: AdapterTokenOptions): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = {
    htm: o.method, htu: o.url, bsh: o.bsh ?? bsh(o.body),
  };
  for (const k of o.omit ?? []) delete claims[k];
  let jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: o.alg ?? 'RS256', kid: o.kid ?? iss.kid, typ: o.typ ?? 'ain-adapter+jwt' })
    .setIssuer(o.iss ?? iss.issuer).setAudience(o.audience).setIssuedAt(o.iat ?? now).setExpirationTime(o.exp ?? now + 60);
  if (!(o.omit ?? []).includes('jti')) jwt = jwt.setJti(o.jti ?? randomUUID());
  return jwt.sign(o.key ?? iss.key);
}

export interface DesiredState {
  schema: 'ain-sso.adapter.v1'; sub: string; org: { id: string; slug: string; name: string }; version: number;
  status: 'active' | 'suspended' | 'deprovisioned'; profile: { name: string | null; email: string | null; workEmail: string | null };
  appRole: string | null; groups: { id: string; slug: string; name: string; kind: 'team' | 'department' | 'access' | 'mail' }[];
  legacyUserId: string | null; ownershipTransferTo: string | null; issuedAt: string;
}

export function desired(sub: string, version: number, patch: Partial<DesiredState> = {}): DesiredState {
  return {
    schema: 'ain-sso.adapter.v1', sub, org: { id: 'org_comcom', slug: 'comcom', name: 'ComCom' }, version, status: 'active',
    profile: { name: 'Kim Minji', email: 'minji@example.com', workEmail: 'minji@comcom.ai' },
    appRole: 'member', groups: [{ id: 'grp_1', slug: 'eng', name: 'Engineering', kind: 'team' }],
    legacyUserId: null, ownershipTransferTo: null, issuedAt: new Date().toISOString(), ...patch,
  };
}

export async function logoutToken(iss: TestIssuer, o: {
  audience: string; sid?: string | null; sub?: string | null; typ?: string; events?: unknown; nonce?: string; iat?: number; jti?: string; key?: CryptoKey; iss?: string;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = { events: o.events === undefined ? { 'http://schemas.openid.net/event/backchannel-logout': {} } : o.events };
  if (o.sid) claims.sid = o.sid;
  if (o.nonce) claims.nonce = o.nonce;
  let jwt = new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: iss.kid, typ: o.typ ?? 'logout+jwt' })
    .setIssuer(o.iss ?? iss.issuer).setAudience(o.audience).setIssuedAt(o.iat ?? now).setExpirationTime((o.iat ?? now) + 120).setJti(o.jti ?? randomUUID());
  if (o.sub) jwt = jwt.setSubject(o.sub);
  return jwt.sign(o.key ?? iss.key);
}

/** POST a site call (site-call.ts) the way ainize-web does. */
export async function siteCall(url: string, secret: string, path: string, body: unknown, opts: { at?: number; header?: string; rawBody?: string } = {}): Promise<Response> {
  const raw = opts.rawBody ?? JSON.stringify(body);
  const at = opts.at ?? Math.floor(Date.now() / 1000);
  const header = opts.header ?? signSiteCall(secret, 'POST', path, at, JSON.stringify(body));
  return fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ainize-site-call': header }, body: raw });
}
