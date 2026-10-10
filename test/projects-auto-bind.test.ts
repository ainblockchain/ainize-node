/**
 * `POST /api/projects/auto` (src/project-routes.ts): aindrive, acting as itself with an AIN SSO machine token for this
 * node, binds a pushed repository whose root has `ainize.json` to a project — created on the first push (the webhook
 * secret shown once), found on later ones. Real pieces: the routes, the store, verifyServiceToken against an in-test
 * JWKS, the node's SSO store for slug → organization and subject → principal.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { exportJWK, generateKeyPair, SignJWT, type JSONWebKeySet } from 'jose';
import { HostedAgentSecretStore } from '../src/hosted-agent-secrets.js';
import { projectRoutes } from '../src/project-routes.js';
import { DeploymentLogs, ProjectStore, ProjectWorker, signHook, PROJECT_SECRET_WEBHOOK } from '../src/projects.js';
import { Store } from '../src/store.js';
import { readSsoConfig, ssoPrincipal, verifyServiceToken } from '../src/sso.js';
import { inputDefaults, parseProjectManifest, ProjectManifestError } from '../src/project-manifest.js';

const ISSUER = 'https://sso.example.test';
const NODE = 'https://node.example';
const AINDRIVE = 'https://aindrive.example.test';
const ORG = 'org_comcom';

let app: express.Express;
let store: ProjectStore;
let secrets: HostedAgentSecretStore;
let jwks: JSONWebKeySet;
let key: CryptoKey;
let otherKey: CryptoKey;

const nowS = () => Math.floor(Date.now() / 1000);
async function token(o: { app?: string; aud?: string; orgs?: string[]; exp?: number; typ?: string; other?: boolean; azp?: string } = {}) {
  const sub = o.app ?? 'aindrive';
  return new SignJWT({ iss: ISSUER, aud: o.aud ?? NODE, sub, azp: o.azp ?? sub, client_id: sub, jti: randomUUID(), orgs: o.orgs ?? [ORG] })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1', typ: o.typ ?? 'at+jwt' })
    .setIssuedAt(nowS()).setExpirationTime(o.exp ?? nowS() + 300)
    .sign(o.other ? otherKey : key);
}
const auto = (body: unknown, t: string) => request(app).post('/api/projects/auto').set('authorization', `Bearer ${t}`).send(body);

before(async () => {
  const kp = await generateKeyPair('RS256');
  key = kp.privateKey as CryptoKey;
  otherKey = (await generateKeyPair('RS256')).privateKey as CryptoKey;
  jwks = { keys: [{ ...(await exportJWK(kp.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }] };
  const tmp = mkdtempSync(join(tmpdir(), 'ainize-auto-bind-'));
  const sso = new Store(':memory:');
  sso.putSsoMembership({ issuer: ISSUER, subject: 'acc_alice', org_id: ORG, org_slug: 'comcom', org_name: 'ComCom', status: 'active', app_role: 'member', groups: [], legacy_user_id: null, applied_version: 1 });
  sso.insertSsoIdentity({ issuer: ISSUER, subject: 'acc_bob', principal: 'google:123', linkProof: 'legacy_mapping' });
  const cfg = readSsoConfig({ AIN_SSO_ISSUER: ISSUER, AIN_SSO_CLIENT_ID: 'ainize', AIN_SSO_SERVICE_APPS: 'aindrive, ainteams' })!;
  assert.deepEqual(cfg.serviceApps, ['aindrive', 'ainteams']);
  store = new ProjectStore(join(tmp, 'projects.json'));
  secrets = new HostedAgentSecretStore(join(tmp, 'project-secrets.json'), join(tmp, 'secrets.key'));
  const logs = new DeploymentLogs(join(tmp, 'logs'));
  const worker = new ProjectWorker({ store, logs, run: async (_r, on) => on({ event: 'exit', data: { code: 0, ms: 1 } }), deployToken: () => null, publicUrl: () => NODE });
  worker.stop();
  app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as express.Request & { rawBody?: Buffer }).rawBody = buf; } }));
  app.use(projectRoutes({
    store, secrets, logs, worker,
    caller: (req) => { const u = req.header('x-test-user'); return u ? { subject: u, kind: 'principal', sso: null, orgMember: () => false, orgRole: () => null } : null; },
    publicBase: () => NODE,
    auto: {
      servicePrincipal: (authorization) => verifyServiceToken(authorization, { issuer: ISSUER, audience: NODE, jwks, serviceApps: cfg.serviceApps }),
      orgIdsForSlug: (slug) => sso.ssoOrgIdsBySlug(ISSUER, slug),
      principalForSubject: (subject) => sso.ssoIdentity(ISSUER, subject)?.principal ?? ssoPrincipal(subject),
    },
  }));
});

test('verifyServiceToken: the token must be for this node, from a listed application, signed by the issuer', async () => {
  const opts = { issuer: ISSUER, audience: NODE, jwks, serviceApps: ['aindrive'] };
  assert.deepEqual(await verifyServiceToken(`Bearer ${await token()}`, opts), { clientId: 'aindrive', orgs: [ORG] });
  for (const [bad, re] of [
    [await token({ aud: 'https://other.example' }), /aud/],
    [await token({ app: 'ainteams' }), /not allowed/],
    [await token({ exp: nowS() - 10 }), /exp/],
    [await token({ other: true }), /verify|signature/],
    [await token({ typ: 'JWT' }), /typ/],
    [await token({ azp: 'ainteams' }), /Not a machine token/],
  ] as [string, RegExp][]) {
    await assert.rejects(verifyServiceToken(`Bearer ${bad}`, opts), (e: Error & { status: number }) => e.status === 401 && re.test(e.message), `refused: ${re}`);
  }
  await assert.rejects(verifyServiceToken(undefined, opts), /Bearer token required/);
  await assert.rejects(verifyServiceToken(`Bearer ${await token()}`, { ...opts, serviceApps: [] }), /no machine tokens/);
});

test('the first push creates the project for the pusher and returns the secret once; the next push gets only the id', async () => {
  const body = { repo: `${AINDRIVE}/comcom/git/site`, branch: 'main', pusher: { subject: 'acc_alice', email: 'alice@example.com' }, manifest: { kind: 'script', name: 'Site' } };
  const first = await auto(body, await token());
  assert.equal(first.status, 201, first.text);
  assert.match(first.body.webhookSecret, /^whsec_[0-9a-f]{48}$/);
  assert.equal(first.body.created, true);
  assert.equal(first.body.pageUrl, `${NODE}/comcom/site`, 'the page is /<org>/<repo>, mirroring the repo\'s aindrive URL');
  const p = store.get(first.body.id)!;
  assert.equal(p.owner, 'sso:acc_alice');
  assert.equal(p.kind, 'script');
  assert.equal(p.name, 'Site');
  assert.equal(p.repo, `${AINDRIVE}/comcom/git/site`);
  // The secret works for the hook, as a pasted one would.
  const raw = JSON.stringify({ ref: 'refs/heads/main', after: 'a'.repeat(40), pusher: { subject: 'acc_alice' } });
  const hooked = await request(app).post(`/api/projects/${p.id}/hook`).set('content-type', 'application/json').set('x-ainize-signature', signHook(first.body.webhookSecret, raw)).send(raw);
  assert.equal(hooked.status, 202);

  const again = await auto(body, await token());
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, { id: p.id, pageUrl: `${NODE}/comcom/site`, created: false });
  assert.equal(store.list().length, 1);
  // The owner reads it with owner and hook address; a stranger reads the public view of the organization's repository.
  const owner = await request(app).get(`/api/projects/${p.id}`).set('x-test-user', 'sso:acc_alice');
  assert.equal(owner.status, 200); assert.equal(owner.body.owner, 'sso:acc_alice');
  const stranger = await request(app).get(`/api/projects/${p.id}`).set('x-test-user', 'sso:nobody');
  assert.equal(stranger.status, 200); assert.equal(stranger.body.owner, undefined); assert.equal(stranger.body.hookUrl, undefined);
  // Another branch of the same repo is a conflict (one project per repo).
  assert.equal((await auto({ ...body, branch: 'dev' }, await token())).status, 409);
});

test('the owner is the linked legacy principal when there is one, and the organization when the pusher is unknown', async () => {
  const bob = await auto({ repo: `${AINDRIVE}/comcom/git/bobs`, pusher: { subject: 'acc_bob' } }, await token());
  assert.equal(bob.status, 201);
  assert.equal(store.get(bob.body.id)!.owner, 'google:123');
  const anon = await auto({ repo: `${AINDRIVE}/comcom/git/anon` }, await token());
  assert.equal(anon.status, 201);
  assert.equal(store.get(anon.body.id)!.owner, `org:${ORG}`);
  assert.equal(store.get(anon.body.id)!.branch, 'main');
  assert.equal(secrets.reveal(anon.body.id, [PROJECT_SECRET_WEBHOOK])[PROJECT_SECRET_WEBHOOK], anon.body.webhookSecret);
});

test('only an organization in the token that this node knows under the repo slug may bind; drive-id URLs cannot', async () => {
  const other = await auto({ repo: `${AINDRIVE}/comcom/git/x` }, await token({ orgs: ['org_other'] }));
  assert.equal(other.status, 403);
  assert.equal(other.body.error.code, 'org_not_allowed');
  assert.equal((await auto({ repo: `${AINDRIVE}/unknownorg/git/x` }, await token())).status, 403);
  assert.equal((await auto({ repo: `${AINDRIVE}/api/drives/-abc/git/x` }, await token())).status, 403);
  assert.equal((await auto({ repo: 'https://aindrive.example.test/comcom/nogit' }, await token())).status, 400);
  assert.equal((await auto({ repo: `${AINDRIVE}/comcom/git/x`, branch: 'bad branch' }, await token())).status, 400);
});

test('a bad or missing machine token is 401; a user session is not enough', async () => {
  const bad = await auto({ repo: `${AINDRIVE}/comcom/git/x` }, await token({ aud: 'https://elsewhere' }));
  assert.equal(bad.status, 401);
  assert.match(bad.headers['www-authenticate'] ?? '', /invalid_token/);
  assert.equal((await request(app).post('/api/projects/auto').set('x-test-user', 'sso:acc_alice').send({ repo: `${AINDRIVE}/comcom/git/x` })).status, 401);
  assert.equal((await auto({ repo: `${AINDRIVE}/comcom/git/x` }, await token({ app: 'stranger' }))).status, 401);
  assert.equal(store.list().length, 3, 'nothing was created');
});

test('without the auto deps the route is 503', async () => {
  const bare = express();
  bare.use(express.json());
  bare.use(projectRoutes({ store, secrets, logs: new DeploymentLogs(mkdtempSync(join(tmpdir(), 'l-'))), worker: { enqueue() {} } as unknown as ProjectWorker, caller: () => null, publicBase: () => NODE }));
  const res = await request(bare).post('/api/projects/auto').set('authorization', `Bearer ${await token()}`).send({ repo: `${AINDRIVE}/comcom/git/x` });
  assert.equal(res.status, 503);
});

test('ainize.json inputs: the GitHub Actions workflow_dispatch shape, limits, and the INPUT_<NAME> env their defaults make', () => {
  const m = parseProjectManifest(JSON.stringify({ kind: 'script', entry: 'a.py', inputs: {
    DESC: { description: '작품 묘사 (description)', type: 'string', required: true, default: '해질녘 바다 위 작은 배 한 척' },
    MODEL: { description: '모델', type: 'choice', options: ['clef-flash', 'clef'], default: 'clef-flash' },
    top_k: { type: 'number', default: 5 },
    dry_run: { type: 'boolean', default: true },
    FREE: {},
  } }));
  assert.equal(Object.keys(m.inputs).length, 5);
  assert.equal(m.inputs.FREE!.type, 'string');
  assert.equal(m.inputs.FREE!.required, false);
  assert.deepEqual(inputDefaults(m.inputs), { INPUT_DESC: '해질녘 바다 위 작은 배 한 척', INPUT_MODEL: 'clef-flash', INPUT_TOP_K: '5', INPUT_DRY_RUN: 'true' });
  assert.deepEqual(parseProjectManifest('{"entry":"a.py"}').inputs, {});
  const bad = (inputs: unknown) => assert.throws(() => parseProjectManifest(JSON.stringify({ entry: 'a.py', inputs })), ProjectManifestError);
  bad({ '1X': {} });
  bad({ 'a-b': {} });
  bad({ A: { type: 'file' } });
  bad({ A: { default: 'x'.repeat(2049) } });
  bad({ A: { extra: 1 } });
  bad([{ name: 'A' }]);                                      // the array shape is not accepted
  bad(Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`I${i}`, {}])));
});
