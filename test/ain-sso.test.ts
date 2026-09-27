/**
 * AIN SSO on the node (src/sso.ts, src/sso-routes.ts, docs/ain-sso.md): the provisioning adapter, sessions made
 * from a verified ID token, back-channel logout, and what suspension ends — and what it must never touch.
 *
 * A stand-in AIN SSO (test/fixtures/ain-sso.ts) signs real RS256 tokens and serves its JWKS over HTTP, so the node
 * fetches and checks keys exactly as it would against auth.comcom.ai.
 *
 *   node --test --import tsx test/ain-sso.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, type NodeConfig } from '@ainize/core';
import { startNode, type RunningNode } from '../src/server.js';
import { SITE_ASSERTION_SECRET_FILE, SITE_SUBJECT_HEADER, signSiteSubject } from '../src/site-assertion.js';
import { signSiteCall } from '../src/site-call.js';
import { operatorToken } from './fixtures/operator.js';
import { adapterToken, bsh, desired, logoutToken, siteCall, startTestIssuer, type AdapterTokenOptions, type TestIssuer } from './fixtures/ain-sso.js';

const tmp = mkdtempSync(join(tmpdir(), 'ainize-sso-'));
const PORT = 24301;
const PORT_OFF = 24302;
const SECRET = 'site-secret-for-ain-sso-tests-'.padEnd(40, 'x');
const CLIENT = 'app_ainize';
const url = `http://127.0.0.1:${PORT}`;
const urlOff = `http://127.0.0.1:${PORT_OFF}`;
const ORG = { id: 'org_comcom', slug: 'comcom', name: 'ComCom' };
const ORG2 = { id: 'org_other', slug: 'other', name: 'Other' };

let I: TestIssuer;
let N: RunningNode;
let OFF: RunningNode;
let identity: NodeConfig['identity'];
let cfgOn: NodeConfig;

function config(name: string, port: number): NodeConfig {
  const cfg = defaultConfig({ home: join(tmp, name), name, port, peers: [], roles: ['seller'], ledger: 'local' });
  cfg.runtime = { repo: undefined, api: 'http://127.0.0.1:1', hookApi: 'http://127.0.0.1:1' };
  cfg.host = '127.0.0.1'; cfg.publicUrl = `http://127.0.0.1:${port}`;
  cfg.verifier = { quorum: 1, allowSelfAttest: true, intervalMs: 3_600_000, auto: false };
  cfg.gossipIntervalMs = 3_600_000;
  cfg.backends = [{ id: 'llm', modality: 'chat', upstream: 'http://127.0.0.1:1', models: ['m'] }];
  return cfg;
}
const ssoEnv = () => ({ AIN_SSO_ISSUER: I.issuer, AIN_SSO_CLIENT_ID: CLIENT, AIN_SSO_ADAPTER_URL: `${url}/api/sso/adapter` });

before(async () => {
  I = await startTestIssuer();
  for (const name of ['on', 'off']) {
    mkdirSync(join(tmp, name), { recursive: true });
    writeFileSync(join(tmp, name, SITE_ASSERTION_SECRET_FILE), `${SECRET}\n`);
  }
  cfgOn = config('on', PORT);
  identity = cfgOn.identity;
  N = await startNode(cfgOn, { quiet: true, serveWeb: false, home: join(tmp, 'on'), ssoEnv: ssoEnv() });
  OFF = await startNode(config('off', PORT_OFF), { quiet: true, serveWeb: false, home: join(tmp, 'off'), ssoEnv: {} });
});
after(async () => { await N?.stop(); await OFF?.stop(); await I?.stop(); rmSync(tmp, { recursive: true, force: true }); });

// ------------------------------------------------------------------------------------------------ helpers

const userPath = (sub: string, orgId = ORG.id) => `/api/sso/adapter/v1/orgs/${encodeURIComponent(orgId)}/users/${encodeURIComponent(sub)}`;

async function adapter(method: 'GET' | 'PUT', sub: string, state?: unknown, o: Partial<AdapterTokenOptions> & { rawBody?: string; orgId?: string; base?: string } = {}): Promise<Response> {
  const path = userPath(sub, o.orgId);
  const raw = o.rawBody ?? (state === undefined ? '' : JSON.stringify(state));
  const signedBody = state === undefined ? '' : JSON.stringify(state);
  const token = await adapterToken(I, { method, url: `${url}${path}`, body: signedBody, audience: CLIENT, ...o });
  return fetch(`${o.base ?? url}${path}`, {
    method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: method === 'PUT' ? raw : undefined,
  });
}
const put = async (state: ReturnType<typeof desired>) => {
  const res = await adapter('PUT', state.sub, state, { orgId: state.org.id });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
};

let sidCounter = 0;
async function signIn(sub: string, patch: Record<string, unknown> = {}, base = url) {
  const res = await siteCall(base, SECRET, '/api/auth/sso/session', {
    iss: I.issuer, sub, sid: `sid_${sub}_${++sidCounter}`, name: 'Kim Minji', email: 'minji@example.com',
    orgs: [ORG], activeOrg: ORG.id, link: null, allowConnect: false, replaces: null, ...patch,
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> & { token?: string; principal?: string; status?: string } };
}
const cookie = (token: string) => ({ cookie: `ainize_session=${token}` });
async function me(token: string) { return (await fetch(`${url}/api/auth/me`, { headers: cookie(token) })).json() as Promise<Record<string, unknown>>; }
async function createKey(headers: Record<string, string>, body: Record<string, unknown> = {}, base = url) {
  const res = await fetch(`${base}/api/keys`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() as { api_key?: string; org_id?: string | null; error?: { code: string } } };
}
const keyWorks = async (key: string, base = url) => (await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${key}` } })).status === 200;
const vouched = (subject: string) => ({ [SITE_SUBJECT_HEADER]: signSiteSubject(SECRET, subject, Math.floor(Date.now() / 1000)) });
async function principal(p: string, base = url) {
  return (await siteCall(base, SECRET, '/api/auth/sso/principal', { principal: p })).json() as Promise<{ linked: boolean; blocked: boolean; notBefore: number | null }>;
}
const acc = (n: string) => `acc_${n.padEnd(26, '0')}`;

// ------------------------------------------------------------------------------------------------ adapter protocol

test('health answers without a token and names the protocol', async () => {
  const res = await fetch(`${url}/api/sso/adapter/v1/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok', schema: 'ain-sso.adapter.v1' });
});

test('PUT active provisions the account as sso:<sub>; GET reports what was applied', async () => {
  const sub = acc('prov');
  const r = await put(desired(sub, 1));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { appliedVersion: 1, localUserId: `sso:${sub}`, status: 'active' });
  const got = await adapter('GET', sub);
  assert.equal(got.status, 200);
  assert.deepEqual(await got.json(), { exists: true, localUserId: `sso:${sub}`, appliedVersion: 1, status: 'active', appRole: 'member', groups: ['eng'] });
  const none = await adapter('GET', acc('nobody'));
  assert.deepEqual(await none.json(), { exists: false, localUserId: null, appliedVersion: null, status: null, appRole: null, groups: [] });
});

test('every request that is not exactly what AIN SSO signed is refused, and changes nothing', async () => {
  const sub = acc('verify');
  const state = desired(sub, 1);
  const cases: [string, Partial<AdapterTokenOptions> & { rawBody?: string }][] = [
    ['another audience', { audience: 'app_someone_else' }],
    ['another issuer', { iss: 'https://evil.example' }],
    ['another typ (an ID token)', { typ: 'JWT' }],
    ['signed by a key not in the JWKS', { key: I.foreign }],
    ['expired', { iat: Math.floor(Date.now() / 1000) - 300, exp: Math.floor(Date.now() / 1000) - 200 }],
    ['lives longer than 60 s', { exp: Math.floor(Date.now() / 1000) + 3600 }],
    ['bound to another method', { method: 'GET' }],
    ['bound to another URL', { url: `${url}${userPath(acc('someone'))}` }],
    ['body changed after signing', { rawBody: JSON.stringify({ ...state, status: 'suspended' }) }],
    ['no body hash', { omit: ['bsh'] }],
    ['no jti', { omit: ['jti'] }],
  ];
  for (const [what, o] of cases) {
    const { method, ...rest } = o;
    const path = userPath(sub);
    const raw = rest.rawBody ?? JSON.stringify(state);
    const token = await adapterToken(I, { method: method ?? 'PUT', url: `${url}${path}`, body: JSON.stringify(state), audience: CLIENT, ...rest });
    const res = await fetch(`${url}${path}`, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: raw });
    assert.equal(res.status, 401, what);
    const body = await res.json() as { error: string; retryable: boolean };
    assert.equal(body.error, 'invalid_token', what);
    assert.equal(body.retryable, false, what);
  }
  // HS256 with a guessable secret: refused by algorithm before anything else.
  const hs = await adapterToken(I, { method: 'PUT', url: `${url}${userPath(sub)}`, body: JSON.stringify(state), audience: CLIENT, alg: 'HS256', key: new TextEncoder().encode('x'.repeat(32)) });
  assert.equal((await fetch(`${url}${userPath(sub)}`, { method: 'PUT', headers: { authorization: `Bearer ${hs}` }, body: JSON.stringify(state) })).status, 401, 'HS256');
  assert.equal((await fetch(`${url}${userPath(sub)}`, { method: 'PUT', body: JSON.stringify(state) })).status, 401, 'no token');
  const got = await adapter('GET', sub);
  assert.equal((await got.json() as { exists: boolean }).exists, false, 'none of them applied anything');
});

test('a token is single use: the same request replayed is refused', async () => {
  const sub = acc('replay');
  const state = desired(sub, 1);
  const path = userPath(sub);
  const token = await adapterToken(I, { method: 'PUT', url: `${url}${path}`, body: JSON.stringify(state), audience: CLIENT });
  const send = () => fetch(`${url}${path}`, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(state) });
  assert.equal((await send()).status, 200);
  const again = await send();
  assert.equal(again.status, 401);
  assert.match((await again.json() as { message: string }).message, /already used/);
});

test('a body that does not match its path, or is not a DesiredUserState, is a 400; an oversized one a 413', async () => {
  const sub = acc('shape');
  const other = desired(acc('other'), 1);
  const res = await adapter('PUT', sub, other);
  assert.equal(res.status, 400);
  assert.equal((await res.json() as { error: string }).error, 'invalid_request');
  const bad = await adapter('PUT', sub, { ...desired(sub, 1), status: 'frozen' });
  assert.equal(bad.status, 400);
  const huge = { ...desired(sub, 1), profile: { name: 'x'.repeat(70 * 1024), email: null, workEmail: null } };
  const big = await adapter('PUT', sub, huge);
  assert.equal(big.status, 413);
  assert.equal((await big.json() as { error: string }).error, 'payload_too_large');
});

test('versions only move forward: an older or equal version is a 200 no-op that reports what is applied', async () => {
  const sub = acc('versions');
  assert.equal((await put(desired(sub, 5, { appRole: 'admin' }))).body.appliedVersion, 5);
  const older = await put(desired(sub, 3, { status: 'suspended', appRole: null, groups: [] }));
  assert.deepEqual(older.body, { appliedVersion: 5, localUserId: `sso:${sub}`, status: 'active' }, 'a late v3 must not suspend over v5');
  const same = await put(desired(sub, 5, { status: 'suspended', appRole: null, groups: [] }));
  assert.deepEqual(same.body, { appliedVersion: 5, localUserId: `sso:${sub}`, status: 'active' });
  const cur = await (await adapter('GET', sub)).json() as { appRole: string; status: string };
  assert.equal(cur.appRole, 'admin');
  assert.equal(cur.status, 'active');
  const skip = await put(desired(sub, 9, { appRole: 'member' }));
  assert.equal(skip.body.appliedVersion, 9, 'versions may skip numbers');
});

// ------------------------------------------------------------------------------------------------ sign-in

test('a verified ID token becomes a session keyed by sid; /api/auth/me reports it apart from wallet sign-in', async () => {
  const sub = acc('login');
  const r = await signIn(sub);
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'ok');
  assert.equal(r.body.principal, `sso:${sub}`);
  const row = N.store.getSession(r.body.token!);
  assert.equal(row?.scheme, 'sso');
  assert.equal(row?.sso?.sub, sub);
  assert.match(row?.sso?.sid ?? '', /^sid_/);
  const who = await me(r.body.token!);
  assert.equal(who.signedIn, false, 'signedIn means an address is here; an SSO account is not one');
  assert.equal(who.subject, null);
  assert.equal(who.isOwner, false);
  assert.deepEqual((who.sso as { principal: string }).principal, `sso:${sub}`);
});

test('an SSO session is invisible to every route that reads a wallet session', async () => {
  const { body } = await signIn(acc('nowallet'));
  // Hosted agents, owner routes and device approval all read siteSession(), which does not show an SSO session.
  assert.equal((await fetch(`${url}/api/auth/owners`, { headers: cookie(body.token!) })).status, 401);
  assert.equal((await fetch(`${url}/api/auth/bindings`, { headers: cookie(body.token!) })).status, 401);
  assert.equal((await fetch(`${url}/api/my/nodes`, { headers: cookie(body.token!) })).status, 401);
});

test('concurrent first logins of one account end with one local identity', async () => {
  const sub = acc('race');
  const results = await Promise.all(Array.from({ length: 12 }, () => signIn(sub)));
  assert.ok(results.every((r) => r.status === 200 && r.body.principal === `sso:${sub}`));
  assert.equal(new Set(results.map((r) => r.body.token)).size, 12, 'twelve sessions');
  assert.equal(N.store.ssoIdentity(I.issuer, sub)?.principal, `sso:${sub}`);
});

test('accounts are never linked by email: two subjects with one address stay two principals', async () => {
  const a = await signIn(acc('email_a'), { email: 'shared@comcom.ai' });
  const b = await signIn(acc('email_b'), { email: 'shared@comcom.ai' });
  assert.notEqual(a.body.principal, b.body.principal);
});

test('a token from another issuer, or a malformed subject, is refused', async () => {
  assert.equal((await signIn(acc('iss'), { iss: 'https://evil.example' })).status, 400);
  assert.equal((await signIn('google:1234')).status, 400, 'a subject must not be able to forge a principal');
});

test('the sign-in and principal routes answer only the site: signed, fresh, single use, for exactly this body', async () => {
  const body = { iss: I.issuer, sub: acc('sitecall'), sid: 's', name: null, email: null, orgs: [], activeOrg: null, link: null, allowConnect: false, replaces: null };
  const path = '/api/auth/sso/session';
  const post = (header: string | null, raw = JSON.stringify(body)) => fetch(`${url}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(header ? { 'x-ainize-site-call': header } : {}) }, body: raw,
  });
  const now = Math.floor(Date.now() / 1000);
  assert.equal((await post(null)).status, 401, 'a visitor through the relay');
  assert.equal((await post(signSiteCall('w'.repeat(40), 'POST', path, now, JSON.stringify(body)))).status, 401, 'wrong secret');
  assert.equal((await post(signSiteCall(SECRET, 'POST', path, now - 600, JSON.stringify(body)))).status, 401, 'stale');
  assert.equal((await post(signSiteCall(SECRET, 'POST', '/api/auth/sso/principal', now, JSON.stringify(body)))).status, 401, 'signed for another path');
  assert.equal((await post(signSiteCall(SECRET, 'POST', path, now, JSON.stringify(body)), JSON.stringify({ ...body, sub: acc('tamper') }))).status, 401, 'body changed');
  const good = signSiteCall(SECRET, 'POST', path, now, JSON.stringify(body));
  assert.equal((await post(good)).status, 200);
  assert.equal((await post(good)).status, 401, 'replayed');
});

test('two identical site calls in the same second are both answered: each carries its own nonce', async () => {
  const both = await Promise.all([principal('google:1212121'), principal('google:1212121'), principal('google:1212121')]);
  assert.ok(both.every((b) => b.linked === false && b.blocked === false));
});

test('the site-call format matches the one ainize-web writes (the same vector is pinned there)', () => {
  assert.equal(signSiteCall('s'.repeat(32), 'POST', '/api/auth/sso/principal', 1790000000, '{"principal":"google:1"}', '0'.repeat(32)),
    '1790000000.00000000000000000000000000000000.88f0afe043c4386d1bc4c3b8cf64bbf6b14c689b2f4a0aa17a769c34bc8c237f');
});

// ------------------------------------------------------------------------------------------------ keys, suspension

test('suspension ends the sessions and disables organization keys before answering; personal keys and the node owner stay', async () => {
  const sub = acc('suspend');
  await put(desired(sub, 1));
  const s1 = await signIn(sub);
  const s2 = await signIn(sub);
  const orgKey = await createKey(cookie(s1.body.token!), { label: 'work' });
  assert.equal(orgKey.status, 200);
  assert.equal(orgKey.body.org_id, ORG.id, 'the session\'s organization is the default');
  const personal = await createKey(cookie(s1.body.token!), { label: 'mine', org_id: null });
  assert.equal(personal.body.org_id, null);
  // The node owner, signed in with the node's own key, with a key of their own — none of it is the adapter's.
  const ownerToken = await operatorToken(url, identity);
  const ownerKey = await createKey(cookie(ownerToken), { label: 'owner' });
  const ownersBefore = await (await fetch(`${url}/api/auth/owners`, { headers: cookie(ownerToken) })).json();
  assert.ok(await keyWorks(orgKey.body.api_key!));

  const r = await put(desired(sub, 2, { status: 'suspended', appRole: null, groups: [] }));
  assert.deepEqual(r.body, { appliedVersion: 2, localUserId: `sso:${sub}`, status: 'suspended' });

  assert.equal(N.store.getSession(s1.body.token!), null, 'session 1 ended');
  assert.equal(N.store.getSession(s2.body.token!), null, 'session 2 ended');
  assert.equal(await keyWorks(orgKey.body.api_key!), false, 'the organization key is off');
  assert.equal(await keyWorks(personal.body.api_key!), true, 'the personal key is untouched');
  assert.equal((await signIn(sub)).status, 403, 'and signing in again is refused');
  // The owner: same session, same key, same owner list.
  assert.ok(N.store.getSession(ownerToken));
  assert.ok(await keyWorks(ownerKey.body.api_key!));
  assert.deepEqual(await (await fetch(`${url}/api/auth/owners`, { headers: cookie(ownerToken) })).json(), ownersBefore);

  // Reactivation brings back what was only switched off.
  await put(desired(sub, 3));
  assert.equal(await keyWorks(orgKey.body.api_key!), true, 'reactivated');
  const s3 = await signIn(sub);
  assert.equal(s3.status, 200);

  // Offboarding deletes it for good; a later reactivation does not resurrect it.
  await put(desired(sub, 4, { status: 'deprovisioned', appRole: null, groups: [], ownershipTransferTo: acc('heir') }));
  assert.equal(N.store.getSession(s3.body.token!), null);
  assert.equal(await keyWorks(orgKey.body.api_key!), false);
  await put(desired(sub, 5));
  assert.equal(await keyWorks(orgKey.body.api_key!), false, 'revoked keys stay revoked');
  assert.equal(await keyWorks(personal.body.api_key!), true, 'still personal, still working');
});

test('suspension in one organization leaves the other organization\'s keys alone', async () => {
  const sub = acc('twoorgs');
  await put(desired(sub, 1));
  await put(desired(sub, 1, { org: ORG2 }));
  const s = await signIn(sub, { orgs: [ORG, ORG2], activeOrg: null });
  assert.equal((await createKey(cookie(s.body.token!), {})).body.error?.code, 'org_required', 'two organizations and none selected: say which');
  const k1 = await createKey(cookie(s.body.token!), { org_id: ORG.id });
  const k2 = await createKey(cookie(s.body.token!), { org_id: ORG2.id });
  assert.equal((await createKey(cookie(s.body.token!), { org_id: 'org_not_mine' })).status, 403);
  await put(desired(sub, 2, { status: 'suspended', appRole: null, groups: [] }));
  assert.equal(await keyWorks(k1.body.api_key!), false);
  assert.equal(await keyWorks(k2.body.api_key!), true, 'still active in the other organization');
  assert.equal((await signIn(sub, { orgs: [ORG2], activeOrg: ORG2.id })).status, 200, 'and may still sign in for it');
});

test('only an SSO session can make an organization key', async () => {
  const ownerToken = await operatorToken(url, identity);
  assert.equal((await createKey(cookie(ownerToken), { org_id: ORG.id })).body.error?.code, 'org_needs_sso');
  assert.equal((await createKey(vouched('google:5550001'), { org_id: ORG.id })).body.error?.code, 'org_needs_sso');
});

// ------------------------------------------------------------------------------------------------ legacy linking

test('a verified legacy mapping links the pre-SSO Google principal once, with its keys', async () => {
  const legacy = 'google:1098765';
  const before = await createKey(vouched(legacy), { label: 'from google sign-in' });
  assert.equal(before.status, 200);
  const sub = acc('legacy');
  const r = await put(desired(sub, 1, { legacyUserId: legacy }));
  assert.equal(r.body.localUserId, legacy);
  const s = await signIn(sub);
  assert.equal(s.body.principal, legacy, 'the SSO session acts as the account it always was');
  const listed = await (await fetch(`${url}/api/keys`, { headers: cookie(s.body.token!) })).json() as { keys: { label: string }[] };
  assert.ok(listed.keys.some((k) => k.label === 'from google sign-in'), 'and sees its old keys');
  // A second AIN account claiming the same legacy user is a conflict for an administrator, never a re-point.
  const other = await put(desired(acc('legacy2'), 1, { legacyUserId: legacy }));
  assert.equal(other.status, 409);
  assert.equal(other.body.error, 'legacy_conflict');
  assert.equal(N.store.ssoIdentityByPrincipal(legacy)?.subject, sub);
});

test('a wallet address is never a legacy user the adapter can link', async () => {
  const r = await put(desired(acc('walletlegacy'), 1, { legacyUserId: identity.address }));
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'legacy_user_not_found');
  assert.equal(N.store.ssoIdentityByPrincipal(identity.address), null, 'the node key is nobody\'s SSO principal');
});

test('a mapping rolled back at AIN SSO stops treating that legacy principal as this person', async () => {
  const legacy = 'google:2020202';
  await createKey(vouched(legacy), { label: 'personal' });
  const sub = acc('rollback');
  await put(desired(sub, 1, { legacyUserId: legacy }));
  const s = await signIn(sub);
  const orgKey = await createKey(cookie(s.body.token!), { label: 'work' });
  const r = await put(desired(sub, 2, { legacyUserId: null }));
  assert.equal(r.body.localUserId, `sso:${sub}`);
  assert.equal(N.store.getSession(s.body.token!), null, 'the session that acted as the legacy principal ended');
  assert.equal(await keyWorks(orgKey.body.api_key!), false, 'organization keys made while linked went with it');
  const legacyKeys = await (await fetch(`${url}/api/keys`, { headers: vouched(legacy) })).json() as { keys: unknown[] };
  assert.equal(legacyKeys.keys.length, 1, 'the legacy principal keeps its own personal key');
  const history = N.store.ssoLinkHistory(I.issuer, sub);
  assert.equal(history.at(-1)?.principal, legacy);
  assert.equal(history.at(-1)?.reason, 'legacy_mapping_rolled_back');
});

test('a mapping that arrives after the first login still links — unless the account already holds keys of its own', async () => {
  const early = acc('late_empty');
  await signIn(early);
  assert.equal((await put(desired(early, 1, { legacyUserId: 'google:3030301' }))).body.localUserId, 'google:3030301');
  const busy = acc('late_busy');
  const s = await signIn(busy);
  await createKey(cookie(s.body.token!), { label: 'x' });
  assert.equal((await put(desired(busy, 1, { legacyUserId: 'google:3030302' }))).body.localUserId, `sso:${busy}`, 'two key sets are never merged silently');
});

test('connecting a legacy session in the app links it, and reports conflicts instead of re-pointing', async () => {
  const sub = acc('connect');
  const ask = await signIn(sub, { allowConnect: true });
  assert.equal(ask.body.status, 'needs_link', 'no link yet and the site may offer "connect your existing account"');
  assert.equal(N.store.ssoIdentity(I.issuer, sub), null, 'asking created nothing');
  const linked = await signIn(sub, { link: { principal: 'google:4040401', method: 'legacy_session' } });
  assert.equal(linked.body.principal, 'google:4040401');
  assert.equal(N.store.ssoIdentity(I.issuer, sub)?.link_proof, 'app_proof:legacy_session');
  const taken = await signIn(acc('connect2'), { link: { principal: 'google:4040401', method: 'legacy_session' } });
  assert.equal(taken.status, 409);
  assert.equal(taken.body.error, 'legacy_conflict');
  // AIN SSO later saying something else about it is an administrator's problem, not a silent re-point.
  const r = await put(desired(sub, 1, { legacyUserId: 'google:4040499' }));
  assert.equal(r.status, 409);
  // …while saying nothing (the app's report did not arrive) keeps the link the app proved.
  assert.equal((await put(desired(sub, 2, { legacyUserId: null }))).body.localUserId, 'google:4040401');
});

// ------------------------------------------------------------------------------------------------ status on every path

test('a suspended linked Google principal cannot use the legacy path either, and the site can ask', async () => {
  const legacy = 'google:6060601';
  const sub = acc('legacy_blocked');
  await put(desired(sub, 1, { legacyUserId: legacy }));
  assert.deepEqual(await principal(legacy), { linked: true, blocked: false, notBefore: null });
  assert.equal((await createKey(vouched(legacy), {})).status, 200);
  // AIN SSO keeps sending the mapping whatever the status (provisioning/desired.ts); only a rollback drops it.
  await put(desired(sub, 2, { status: 'suspended', appRole: null, groups: [], legacyUserId: legacy }));
  assert.equal((await principal(legacy)).blocked, true);
  const refused = await createKey(vouched(legacy), {});
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error?.code, 'account_suspended');
  assert.deepEqual(await principal('google:7777777'), { linked: false, blocked: false, notBefore: null }, 'an unknown principal is nobody\'s business');
});

// ------------------------------------------------------------------------------------------------ back-channel logout

const logout = async (token: string) => fetch(`${url}/api/auth/sso/backchannel-logout`, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ logout_token: token }).toString(),
});

test('back-channel logout with a sid ends only that OIDC session\'s sessions', async () => {
  const sub = acc('bcl_sid');
  const a = await signIn(sub, { sid: 'sid_A' });
  const b = await signIn(sub, { sid: 'sid_B' });
  const other = await signIn(acc('bcl_other'), { sid: 'sid_A_other' });
  const res = await logout(await logoutToken(I, { audience: CLIENT, sid: 'sid_A', sub }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(N.store.getSession(a.body.token!), null);
  assert.ok(N.store.getSession(b.body.token!), 'another OIDC session of the same account stays');
  assert.ok(N.store.getSession(other.body.token!), 'somebody else stays');
});

test('back-channel logout with only a sub ends every session of the account, and dates legacy sessions out', async () => {
  const legacy = 'google:9090901';
  const sub = acc('bcl_sub');
  await put(desired(sub, 1, { legacyUserId: legacy }));
  const a = await signIn(sub, { sid: 'x1' });
  const b = await signIn(sub, { sid: 'x2' });
  const t0 = Date.now();
  assert.equal((await logout(await logoutToken(I, { audience: CLIENT, sub }))).status, 200);
  assert.equal(N.store.getSession(a.body.token!), null);
  assert.equal(N.store.getSession(b.body.token!), null);
  const st = await principal(legacy);
  assert.ok(st.notBefore && st.notBefore >= t0, 'the site refuses Google cookies minted before this');
});

test('a logout token that is not exactly one is refused, and is single use', async () => {
  const sub = acc('bcl_bad');
  const s = await signIn(sub, { sid: 'sid_bad' });
  const bad: [string, Parameters<typeof logoutToken>[1]][] = [
    ['another audience', { audience: 'app_x', sid: 'sid_bad' }],
    ['an ID token (nonce)', { audience: CLIENT, sid: 'sid_bad', nonce: 'n' }],
    ['no event', { audience: CLIENT, sid: 'sid_bad', events: {} }],
    ['wrong typ', { audience: CLIENT, sid: 'sid_bad', typ: 'JWT' }],
    ['neither sid nor sub', { audience: CLIENT }],
    ['too old', { audience: CLIENT, sid: 'sid_bad', iat: Math.floor(Date.now() / 1000) - 600 }],
    ['another signer', { audience: CLIENT, sid: 'sid_bad', key: I.foreign }],
  ];
  for (const [what, o] of bad) assert.equal((await logout(await logoutToken(I, o))).status, 400, what);
  assert.ok(N.store.getSession(s.body.token!), 'none of them ended anything');
  const missing = await fetch(`${url}/api/auth/sso/backchannel-logout`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '' });
  assert.equal(missing.status, 400);
  const once = await logoutToken(I, { audience: CLIENT, sid: 'sid_bad', jti: 'jti-once' });
  assert.equal((await logout(once)).status, 200);
  assert.equal((await logout(once)).status, 400, 'replayed');
});

// ------------------------------------------------------------------------------------------------ SSO off

test('with AIN SSO not configured the node behaves as before: no SSO routes, Google vouching unchanged', async () => {
  assert.ok(!(await (await fetch(`${urlOff}/api/sso/adapter/v1/health`)).text()).includes('ain-sso.adapter.v1'), 'no adapter');
  const r = await siteCall(urlOff, SECRET, '/api/auth/sso/session', { iss: I.issuer, sub: acc('off') });
  assert.equal(r.status, 404, 'no sign-in route');
  const bcl = await fetch(`${urlOff}/api/auth/sso/backchannel-logout`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'logout_token=x' });
  assert.equal(bcl.status, 404);
  const k = await createKey(vouched('google:1111'), { label: 'g' }, urlOff);
  assert.equal(k.status, 200, 'a vouched Google account still gets a key');
  assert.equal(k.body.org_id, null);
  assert.ok(await keyWorks(k.body.api_key!, urlOff));
  assert.deepEqual(await principal('google:1111', urlOff), { linked: false, blocked: false, notBefore: null });
  const me0 = await (await fetch(`${urlOff}/api/auth/me`)).json() as { sso: unknown; signedIn: boolean };
  assert.equal(me0.sso, null);
  assert.equal(me0.signedIn, false);
});

test('SSO audit lines are the operator\'s, not the public event feed\'s', async () => {
  const pub = await (await fetch(`${url}/api/events?kind=sso&limit=500`)).json() as { events: { kind: string }[] };
  assert.ok(!pub.events.some((e) => e.kind === 'sso'));
  const ownerToken = await operatorToken(url, identity);
  const op = await (await fetch(`${url}/api/events?kind=sso&limit=500`, { headers: cookie(ownerToken) })).json() as { events: { kind: string }[] };
  assert.ok(op.events.some((e) => e.kind === 'sso'), 'the owner sees them');
});

test('bsh helper matches the protocol example for the empty body', () => {
  assert.equal(bsh(''), '47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU');
});

test('the suspension outlives turning AIN SSO off on the node (runs last: it restarts the node)', async () => {
  const legacy = 'google:8080801';
  await put(desired(acc('outlive'), 1, { legacyUserId: legacy }));
  await put(desired(acc('outlive'), 2, { status: 'suspended', appRole: null, groups: [], legacyUserId: legacy }));
  // Same home, same database, no AIN_SSO_* at all.
  await N.stop();
  const PORT_AGAIN = 24303;
  const again = `http://127.0.0.1:${PORT_AGAIN}`;
  N = await startNode({ ...cfgOn, port: PORT_AGAIN, publicUrl: again }, { quiet: true, serveWeb: false, home: join(tmp, 'on'), ssoEnv: {} });
  const health = await fetch(`${again}/api/sso/adapter/v1/health`);
  assert.ok(!(await health.text()).includes('ain-sso.adapter.v1'), 'the adapter is off');
  assert.equal((await principal(legacy, again)).blocked, true, 'the site still learns it is suspended');
  assert.equal((await createKey(vouched(legacy), {}, again)).status, 403, 'and the node still refuses it');
});
