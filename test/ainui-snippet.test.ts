/**
 * AIN-UI link snippets for projects (src/ainui-snippet.ts, src/project-routes.ts; aindrive docs/AINUI-LINK-SNIPPETS.md).
 *
 * Real pieces: the builders, the routes, the store, the worker and a real `git clone` against a local bare repository
 * served by `git http-backend` the way aindrive serves a drive's repo; verifyServiceToken against an in-test JWKS and
 * the node's SSO store for memberships. Faked: the sandbox (`RunScript` records the request and speaks the contract's
 * events back) — `/api/run` is another module's.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express, { type Request } from 'express';
import request from 'supertest';
import { exportJWK, generateKeyPair, SignJWT, type JSONWebKeySet } from 'jose';
import { HostedAgentSecretStore } from '../src/hosted-agent-secrets.js';
import { projectRoutes } from '../src/project-routes.js';
import { DeploymentLogs, ProjectStore, ProjectWorker, parseRepoUrl, signHook, PROJECT_SECRET_WEBHOOK, type RunRequest, type RunScript } from '../src/projects.js';
import { Store } from '../src/store.js';
import { readSsoConfig, ssoPrincipal, verifyServiceToken } from '../src/sso.js';
import { principalCaller } from '../src/shared-agents.js';
import {
  AINUI_MEDIA_TYPE, A2UI_BASIC_CATALOG, deniedSnippet, parseSnippetUrl, projectSnippet, snippetInputsOf, validateRunEnv, wantsAinui, type A2uiComponent, type AinuiSnippet,
} from '../src/ainui-snippet.js';

const exec = promisify(execFile);
const git = async (dir: string, args: string[]) => (await exec('git', ['-C', dir, ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout.trim();

const ISSUER = 'https://sso.example.test';
const NODE = 'https://node.example';
const ORG = 'org_testorg';
const OWNER = 'sso:acc_owner';

let tmp: string;
let repoRoot: string;
let aindrive: Server;
let aindriveBase = '';
let app: express.Express;
let store: ProjectStore;
let worker: ProjectWorker;
let secrets: HostedAgentSecretStore;
let jwks: JSONWebKeySet;
let key: CryptoKey;
let projectId = '';
let sha1 = '';
const runs: RunRequest[] = [];
const runBehaviour: RunScript = async (req, on) => {
  runs.push(req);
  on({ event: 'stdout', data: `desc=${req.env.INPUT_DESC} top=${req.env.INPUT_TOP_K}\n` });
  on({ event: 'exit', data: { code: 0, ms: 5 } });
};

/** aindrive's side: `git http-backend`, anonymous, at /testorg/git/<repo>[.git]. */
function fakeAindrive(): express.Express {
  const srv = express();
  srv.all(/^\/testorg\/git\/([A-Za-z0-9_-]+)(?:\.git)?(\/.*)?$/, (req, res) => {
    const [, name, rest = ''] = req.path.match(/^\/testorg\/git\/([A-Za-z0-9_-]+)(?:\.git)?(\/.*)?$/)!;
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, GIT_PROJECT_ROOT: repoRoot, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: `/${name}.git${rest}`,
      REQUEST_METHOD: req.method, QUERY_STRING: req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?') + 1) : '',
      CONTENT_TYPE: req.header('content-type') ?? '', CONTENT_LENGTH: req.header('content-length') ?? '', REMOTE_ADDR: '127.0.0.1',
      ...(req.header('git-protocol') ? { GIT_PROTOCOL: req.header('git-protocol')! } : {}),
    };
    const child = spawn('git', ['http-backend'], { env });
    let header = Buffer.alloc(0);
    let headersDone = false;
    child.stdout.on('data', (chunk: Buffer) => {
      if (headersDone) { res.write(chunk); return; }
      header = Buffer.concat([header, chunk]);
      const at = header.indexOf('\r\n\r\n');
      if (at === -1) return;
      for (const line of header.subarray(0, at).toString('utf8').split('\r\n')) {
        const i = line.indexOf(':');
        if (i === -1) continue;
        const k = line.slice(0, i).trim(); const v = line.slice(i + 1).trim();
        if (k.toLowerCase() === 'status') res.status(parseInt(v, 10) || 200); else res.setHeader(k, v);
      }
      headersDone = true;
      const body = header.subarray(at + 4);
      if (body.length) res.write(body);
    });
    child.on('close', () => res.end());
    req.pipe(child.stdin);
  });
  return srv;
}

const nowS = () => Math.floor(Date.now() / 1000);
async function token(o: { app?: string; aud?: string; exp?: number } = {}) {
  const sub = o.app ?? 'ainteams';
  return new SignJWT({ iss: ISSUER, aud: o.aud ?? NODE, sub, azp: sub, client_id: sub, jti: randomUUID(), orgs: [] })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1', typ: 'at+jwt' }).setIssuedAt(nowS()).setExpirationTime(o.exp ?? nowS() + 300).sign(key);
}
/** A consumer asking for `actor`. */
const asActor = async (actor: string | null, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${await token()}`, ...(actor ? { 'x-ain-actor': actor } : {}), ...extra });

before(async () => {
  const kp = await generateKeyPair('RS256');
  key = kp.privateKey as CryptoKey;
  jwks = { keys: [{ ...(await exportJWK(kp.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }] };
  tmp = mkdtempSync(join(tmpdir(), 'ainize-ainui-snippet-'));
  repoRoot = join(tmp, 'drives');
  mkdirSync(join(repoRoot, 'demo.git'), { recursive: true });
  await git(join(repoRoot, 'demo.git'), ['init', '-q', '--bare', '--initial-branch=main']);
  const work = join(tmp, 'work');
  mkdirSync(work);
  await git(work, ['init', '-q', '--initial-branch=main']);
  await git(work, ['config', 'user.name', 'A Person']);
  await git(work, ['config', 'user.email', 'person@example.com']);
  await git(work, ['remote', 'add', 'origin', join(repoRoot, 'demo.git')]);
  writeFileSync(join(work, 'ainize.json'), JSON.stringify({ kind: 'script', entry: 'main.py', env: { GREETING: 'hi' }, inputs: { DESC: { description: '작품 묘사', required: true, default: 'a boat at dusk' }, TOP_K: { type: 'number', default: 5 }, MODEL: { type: 'choice', options: ['clef-flash', 'clef'], default: 'clef-flash' } } }));
  writeFileSync(join(work, 'main.py'), 'print("v1")\n');
  await git(work, ['add', '-A']);
  await git(work, ['commit', '-q', '-m', 'v1']);
  await git(work, ['push', '-q', 'origin', 'HEAD:main']);
  sha1 = await git(work, ['rev-parse', 'HEAD']);

  aindrive = fakeAindrive().listen(0, '127.0.0.1');
  await new Promise((r) => aindrive.once('listening', r));
  aindriveBase = `http://127.0.0.1:${(aindrive.address() as AddressInfo).port}`;

  const sso = new Store(':memory:');
  sso.putSsoMembership({ issuer: ISSUER, subject: 'acc_owner', org_id: ORG, org_slug: 'testorg', org_name: 'Test Org', status: 'active', app_role: 'member', groups: [], legacy_user_id: null, applied_version: 1 });
  sso.putSsoMembership({ issuer: ISSUER, subject: 'acc_member', org_id: ORG, org_slug: 'testorg', org_name: 'Test Org', status: 'active', app_role: 'member', groups: [], legacy_user_id: null, applied_version: 1 });
  sso.putSsoMembership({ issuer: ISSUER, subject: 'acc_gone', org_id: ORG, org_slug: 'testorg', org_name: 'Test Org', status: 'suspended', app_role: 'member', groups: [], legacy_user_id: null, applied_version: 1 });
  sso.putSsoMembership({ issuer: ISSUER, subject: 'acc_other', org_id: 'org_other', org_slug: 'other', org_name: 'Other', status: 'active', app_role: 'member', groups: [], legacy_user_id: null, applied_version: 1 });
  const cfg = readSsoConfig({ AIN_SSO_ISSUER: ISSUER, AIN_SSO_CLIENT_ID: 'ainize', AIN_SSO_SERVICE_APPS: 'ainteams' })!;

  store = new ProjectStore(join(tmp, 'projects.json'));
  secrets = new HostedAgentSecretStore(join(tmp, 'project-secrets.json'), join(tmp, 'secrets.key'));
  const logs = new DeploymentLogs(join(tmp, 'logs'));
  worker = new ProjectWorker({ store, logs, run: (r, on) => runBehaviour(r, on), deployToken: () => null, publicUrl: () => NODE });
  const principalForSubject = (subject: string) => sso.ssoIdentity(ISSUER, subject)?.principal ?? ssoPrincipal(subject);
  app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as Request & { rawBody?: Buffer }).rawBody = buf; } }));
  app.use(projectRoutes({
    store, secrets, logs, worker,
    caller: (req) => { const u = req.header('x-test-user'); return u ? principalCaller(u) : null; },
    publicBase: () => NODE,
    actor: {
      servicePrincipal: (authorization) => verifyServiceToken(authorization, { issuer: ISSUER, audience: NODE, jwks, serviceApps: cfg.serviceApps }),
      principalForSubject,
      orgIdsForSlug: (slug) => sso.ssoOrgIdsBySlug(ISSUER, slug),
      memberOrgs: (subject) => sso.ssoMemberships(ISSUER, subject).filter((m) => m.status === 'active').map((m) => m.org_id),
      keyFor: (subject) => `sk-run-${subject}`,
    },
  }));

  // The project, bound and deployed once through the real hook + worker (anonymous clone from the fake aindrive).
  const project = store.create({ repo: parseRepoUrl(`${aindriveBase}/testorg/git/demo`)!, branch: 'main', kind: null, entry: null, name: 'Demo' }, OWNER);
  projectId = project.id;
  secrets.set(project.id, PROJECT_SECRET_WEBHOOK, 'whsec_test');
  const raw = JSON.stringify({ ref: 'refs/heads/main', after: sha1, pusher: { subject: 'acc_owner' } });
  const hooked = await request(app).post(`/api/projects/${project.id}/hook`).set('content-type', 'application/json').set('x-ainize-signature', signHook('whsec_test', raw)).send(raw);
  assert.equal(hooked.status, 202, hooked.text);
  await worker.idle();
  assert.equal(store.get(project.id)!.status, 'ready');
  runs.length = 0;
});

after(() => { worker.stop(); aindrive.close(); rmSync(tmp, { recursive: true, force: true }); });

// ------------------------------------------------------------------------------------------ builders

/** The structural rules a consumer renderer relies on (aindrive docs/AINUI-LINK-SNIPPETS.md §2.1). */
function checkSurface(s: AinuiSnippet): A2uiComponent[] {
  assert.equal(s.ainui, 1);
  assert.equal(s.surface.length, 3);
  const [create, update, data] = s.surface as [{ createSurface: { catalogId: string } }, { updateComponents: { components: A2uiComponent[] } }, { updateDataModel: { path: string; value: unknown } }];
  assert.equal(create.createSurface.catalogId, A2UI_BASIC_CATALOG);
  assert.equal(data.updateDataModel.path, '/');
  const comps = update.updateComponents.components;
  const ids = comps.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  assert.ok(ids.includes('root'));
  for (const c of comps) {
    assert.ok(['Column', 'Row', 'Card', 'Text', 'Divider', 'TextField', 'Button'].includes(c.component), `${c.id}: ${c.component} is in the shared vocabulary`);
    const refs = [...(Array.isArray(c.children) ? (c.children as string[]) : []), ...(typeof c.child === 'string' ? [c.child] : [])];
    for (const r of refs) assert.ok(ids.includes(r), `${c.id} → ${r} resolves`);
    if (c.component === 'Button') {
      assert.equal(typeof c.child, 'string', `${c.id} has a Text child`);
      const name = (c.action as { event: { name: string } }).event.name;
      assert.ok(name in s.actions, `button ${c.id} names an action (${name})`);
    }
    if (c.component === 'Text') assert.ok(typeof c.text === 'string' || typeof (c.text as { path?: string }).path === 'string', `${c.id} has text or a binding`);
    if (c.component === 'TextField') assert.equal(typeof c.label, 'string', `${c.id} has a label`);
  }
  return comps;
}

test('wantsAinui: the UI media type in Accept, never a browser', () => {
  assert.equal(wantsAinui(AINUI_MEDIA_TYPE), true);
  assert.equal(wantsAinui(`application/json, ${AINUI_MEDIA_TYPE};q=0.9`), true);
  assert.equal(wantsAinui(`text/html, ${AINUI_MEDIA_TYPE}`), false);
  assert.equal(wantsAinui('application/json'), false);
  assert.equal(wantsAinui(undefined), false);
});

test('parseSnippetUrl: /projects/<id> and /<org>/<repo> on this host; reserved names, other hosts and deeper paths are not', () => {
  assert.deepEqual(parseSnippetUrl(`${NODE}/projects/prj_0123abcd`, NODE), { projectId: 'prj_0123abcd' });
  assert.deepEqual(parseSnippetUrl(`${NODE}/comcom/clef-artwork-search`, NODE), { org: 'comcom', repo: 'clef-artwork-search' });
  assert.deepEqual(parseSnippetUrl('/comcom/clef.git', NODE), { org: 'comcom', repo: 'clef' });
  assert.deepEqual(parseSnippetUrl(`${NODE}/ComCom/Clef?tab=runs#x`, NODE), { org: 'ComCom', repo: 'Clef' });
  for (const bad of [`${NODE}/projects/new`, `${NODE}/me/projects`, `${NODE}/api/projects/prj_1`, `${NODE}/agents/x`, `${NODE}/comcom`, `${NODE}/comcom/clef/deployments`, 'https://elsewhere.example/comcom/clef', `${NODE}/../x`, `${NODE}/.hidden/x`, 'not a url']) {
    assert.equal(parseSnippetUrl(bad, NODE), null, bad);
  }
});

test('snippetInputsOf and validateRunEnv mirror aindrive\'s run-inputs rules', () => {
  assert.deepEqual(snippetInputsOf({ DESC: { description: ' 묘사 ', type: 'string', required: true, default: 'x' }, N: { type: 'number', required: false, default: 5 }, M: { type: 'choice', required: false, options: ['a', 'b'] } }), [
    { name: 'DESC', description: '묘사', type: 'string', required: true, options: null, default: 'x' },
    { name: 'N', description: null, type: 'number', required: false, options: null, default: '5' },
    { name: 'M', description: null, type: 'choice', required: false, options: ['a', 'b'], default: null },
  ]);
  assert.deepEqual(snippetInputsOf(undefined), []);
  assert.deepEqual(validateRunEnv(undefined), {});
  assert.deepEqual(validateRunEnv({ INPUT_DESC: 'x', INPUT_N: 3, INPUT_B: true }), { INPUT_DESC: 'x', INPUT_N: '3', INPUT_B: 'true' });
  assert.equal(validateRunEnv({ 'bad name': 'x' }), null);
  assert.equal(validateRunEnv({ X: 'y'.repeat(2049) }), null);
  assert.equal(validateRunEnv([]), null);
  assert.equal(validateRunEnv(Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`K${i}`, 'v']))), null);
});

test('projectSnippet: header, three deployment rows, the Run form from the manifest, Redeploy for the owner only', () => {
  const p = store.get(projectId)!;
  const deployments = Array.from({ length: 4 }, (_, i) => ({ id: `dep_${i}`, projectId: p.id, sha: `${i}`.repeat(40), ref: 'refs/heads/main', status: (['ready', 'error', 'building', 'ready'] as const)[i]!, pusher: null, createdAt: 1_000 - i, startedAt: 1_000 - i, finishedAt: i === 2 ? null : 2_000 - i, ms: 10, exitCode: i === 1 ? 2 : null, error: null, kind: 'script' as const, outputUrl: i === 0 ? `${NODE}/api/deployments/dep_0/output` : null }));
  const run = { entry: 'main.py', inputs: snippetInputsOf({ DESC: { description: '묘사', type: 'string', required: true, default: 'a boat' } }) };
  const s = projectSnippet({ project: p, deployments, base: NODE, pageUrl: `${NODE}/testorg/demo`, run, canRedeploy: true, now: 60_000 });
  const comps = checkSurface(s);
  const ids = comps.map((c) => c.id);
  for (const id of ['header', 'deployments', 'deployments.0', 'deployments.1', 'deployments.2', 'run', 'run.input.DESC', 'run.button', 'run.status', 'run.output', 'redeploy.button', 'links']) assert.ok(ids.includes(id), id);
  assert.ok(!ids.includes('deployments.3'));
  assert.match(comps.find((c) => c.id === 'deployments.0.text')!.text as string, /^● ready {2}0000000 · /);
  assert.match(comps.find((c) => c.id === 'deployments.1.text')!.text as string, /^● error {2}1111111 \(exit 2\) · /);
  assert.deepEqual(s.actions['open:visit:0'], { method: 'GET', url: `${NODE}/api/deployments/dep_0/output`, navigate: true });
  assert.equal(s.actions['open:visit:1'], undefined);
  assert.deepEqual(s.actions.run, { method: 'POST', url: `${NODE}/api/projects/${p.id}/run`, body: { env: { $context: true } }, stream: 'sse', output: { path: '/run/output', status: '/run/status' } });
  assert.deepEqual(comps.find((c) => c.id === 'run.button')!.action, { event: { name: 'run', context: { INPUT_DESC: { path: '/inputs/DESC' } } } });
  assert.deepEqual(comps.find((c) => c.id === 'run.input.DESC'), { id: 'run.input.DESC', component: 'TextField', label: '묘사 *', value: { path: '/inputs/DESC' } });
  assert.deepEqual((s.surface[2] as { updateDataModel: { value: unknown } }).updateDataModel.value, { inputs: { DESC: 'a boat' }, run: { status: 'idle', output: '' } });
  assert.deepEqual(s.actions.redeploy, { method: 'POST', url: `${NODE}/api/projects/${p.id}/redeploy`, body: {} });
  assert.deepEqual(s.actions['open:aindrive'], { method: 'GET', url: p.repo, navigate: true });
  assert.equal(s.kind, 'ainize.project');
  assert.equal(s.refresh, 30);
  assert.doesNotMatch(JSON.stringify(s), /whsec_|sk-run|Bearer|GREETING/);

  const viewer = projectSnippet({ project: p, deployments: [deployments[2]!], base: NODE, pageUrl: `${NODE}/testorg/demo`, run: null, canRedeploy: false });
  const vids = checkSurface(viewer).map((c) => c.id);
  assert.ok(!vids.includes('redeploy.button') && !vids.includes('run'));
  assert.equal(viewer.actions.redeploy, undefined);
  assert.equal(viewer.refresh, 10, 'a building deployment asks to be re-read sooner');
  const idle = projectSnippet({ project: p, deployments: [], base: NODE, pageUrl: 'x://p', run: null, canRedeploy: true });
  assert.ok(checkSurface(idle).some((c) => c.id === 'deployments.empty'));
  assert.equal(idle.actions.redeploy, undefined, 'nothing to redeploy yet');
  const denied = deniedSnippet('ainize.ai', 'comcom/clef', 'https://ainize.ai/comcom/clef');
  assert.equal(checkSurface(denied).find((c) => c.id === 'denied.text')!.text, 'Sign in to ainize.ai or ask for access to comcom/clef.');
  assert.equal(denied.kind, 'denied');
});

// ------------------------------------------------------------------------------------------ routes

test('the deployment recorded what the manifest said a person can run', () => {
  const d = store.deployment(store.get(projectId)!.lastDeploymentId!)!;
  assert.equal(d.manifest?.entry, 'main.py');
  assert.deepEqual(Object.keys(d.manifest?.inputs ?? {}), ['DESC', 'TOP_K', 'MODEL']);
});

test('GET /api/ainui/snippet: the project page URL → the snippet for the viewer (session or named actor)', async () => {
  const p = store.get(projectId)!;
  for (const [who, headers] of [['owner session', { 'x-test-user': OWNER }], ['member actor', await asActor('acc_member')], ['owner actor', await asActor('acc_owner')]] as [string, Record<string, string>][]) {
    const res = await request(app).get('/api/ainui/snippet').query({ url: `${NODE}/testorg/demo` }).set(headers);
    assert.equal(res.status, 200, `${who}: ${res.text}`);
    assert.match(res.headers['content-type'], /^application\/vnd\.ain\.ui\+json(?:;|$)/);
    assert.match(res.headers.vary, /X-AIN-Actor/);
    const s = JSON.parse(res.text) as AinuiSnippet;
    const comps = checkSurface(s);
    assert.equal(s.kind, 'ainize.project');
    assert.equal(s.title, 'Demo');
    assert.match(s.subtitle!, new RegExp(`^testorg/demo · main · ● ready ${sha1.slice(0, 7)}$`));
    assert.equal(s.url, `${NODE}/testorg/demo`);
    const ids = comps.map((c) => c.id);
    for (const id of ['deployments.0', 'run.input.DESC', 'run.input.TOP_K', 'run.input.MODEL', 'run.button']) assert.ok(ids.includes(id), `${who}: ${id}`);
    assert.equal(comps.find((c) => c.id === 'run.input.MODEL')!.label, 'MODEL (clef-flash | clef)');
    assert.equal((s.surface[2] as { updateDataModel: { value: { inputs: unknown } } }).updateDataModel.value.inputs && (s.surface[2] as { updateDataModel: { value: { inputs: Record<string, string> } } }).updateDataModel.value.inputs.DESC, 'a boat at dusk');
    assert.equal(s.actions.run!.url, `${NODE}/api/projects/${p.id}/run`);
    assert.equal('redeploy' in s.actions, who !== 'member actor', `${who}: redeploy is the owner's`);
  }
  // By id, and by path.
  assert.equal((await request(app).get('/api/ainui/snippet').query({ url: `${NODE}/projects/${p.id}` }).set('x-test-user', OWNER)).status, 200);
  assert.equal((await request(app).get('/api/ainui/snippet').query({ path: '/testorg/demo' }).set('x-test-user', OWNER)).status, 200);
});

test('GET /api/ainui/snippet: who may not see it, and what does not exist', async () => {
  const url = `${NODE}/testorg/demo`;
  // A stranger (another org), a suspended member, a session of a stranger: 403 with the sign-in surface.
  for (const headers of [await asActor('acc_other'), await asActor('acc_gone'), await asActor('acc_nobody'), { 'x-test-user': 'sso:stranger' }]) {
    const res = await request(app).get('/api/ainui/snippet').query({ url }).set(headers);
    assert.equal(res.status, 403, res.text);
    assert.match(res.headers['content-type'], /^application\/vnd\.ain\.ui\+json(?:;|$)/);
    const s = JSON.parse(res.text) as AinuiSnippet;
    assert.equal(s.kind, 'denied');
    assert.deepEqual(s.actions, { 'open:inspect': { method: 'GET', url, navigate: true } });
    assert.doesNotMatch(res.text, new RegExp(sha1.slice(0, 7)));
  }
  // No identity at all, or an application naming nobody, or a token this node does not trust.
  assert.equal((await request(app).get('/api/ainui/snippet').query({ url })).status, 401);
  const nobody = await request(app).get('/api/ainui/snippet').query({ url }).set(await asActor(null));
  assert.equal(nobody.status, 403);
  assert.equal(nobody.body.error.code, 'actor_required');
  const untrusted = await request(app).get('/api/ainui/snippet').query({ url }).set('authorization', `Bearer ${await token({ app: 'stranger-app' })}`).set('x-ain-actor', 'acc_owner');
  assert.equal(untrusted.status, 401);
  assert.match(untrusted.headers['www-authenticate'], /invalid_token/);
  assert.equal((await request(app).get('/api/ainui/snippet').query({ url }).set('authorization', `Bearer ${await token({ aud: 'https://other.example' })}`).set('x-ain-actor', 'acc_owner')).status, 401);
  // Unknown project / not a project page: 404, before any identity is read.
  assert.equal((await request(app).get('/api/ainui/snippet').query({ url: `${NODE}/testorg/nothing` })).status, 404);
  assert.equal((await request(app).get('/api/ainui/snippet').query({ url: `${NODE}/projects/prj_0000` })).status, 404);
  assert.equal((await request(app).get('/api/ainui/snippet').query({ url: `${NODE}/me/projects` })).status, 404);
  assert.equal((await request(app).get('/api/ainui/snippet')).status, 400);
});

test('GET /api/projects/:id/deployments answers an application naming a member, 404 for anyone else', async () => {
  const ok = await request(app).get(`/api/projects/${projectId}/deployments`).set(await asActor('acc_member'));
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.body.deployments.length, 1);
  assert.equal(ok.body.deployments[0].sha, sha1);
  assert.equal((await request(app).get(`/api/projects/${projectId}/deployments`).set(await asActor('acc_other'))).status, 404);
  assert.equal((await request(app).get(`/api/projects/${projectId}/deployments`).set('x-test-user', OWNER)).status, 200);
  assert.equal((await request(app).get(`/api/projects/${projectId}/deployments`).set('x-test-user', 'sso:stranger')).status, 404);
});

test('POST /api/projects/:id/run: the deployed commit again, for the person, with their answers over the defaults', async () => {
  const res = await request(app).post(`/api/projects/${projectId}/run`).set(await asActor('acc_member')).send({ env: { INPUT_DESC: 'a harbour' } });
  assert.equal(res.status, 200, res.text);
  assert.match(res.headers['content-type'], /^text\/event-stream/);
  assert.match(res.text, /event: stdout\ndata: "desc=a harbour top=5\\n"\n\nevent: exit\ndata: \{"code":0,"ms":5\}\n\n$/);
  assert.equal(runs.length, 1);
  const r = runs[0]!;
  assert.equal(r.entry, 'main.py');
  assert.equal(r.language, 'python');
  assert.deepEqual(Object.keys(r.files).sort(), ['ainize.json', 'main.py']);
  assert.deepEqual(r.env, { GREETING: 'hi', INPUT_DESC: 'a harbour', INPUT_TOP_K: '5', INPUT_MODEL: 'clef-flash', AINIZE_PROJECT: projectId, AINIZE_COMMIT: sha1 });
  assert.equal(r.apiKey, 'sk-run-acc_member', 'the run is FOR the person: their own key');
  // Refusals: a stranger is 404 (never a hint), bad env is 400, a session with no SSO subject runs without a key.
  assert.equal((await request(app).post(`/api/projects/${projectId}/run`).set(await asActor('acc_other')).send({})).status, 404);
  assert.equal((await request(app).post(`/api/projects/${projectId}/run`).set(await asActor('acc_member')).send({ env: { 'no good': 1 } })).status, 400);
  const owner = await request(app).post(`/api/projects/${projectId}/run`).set('x-test-user', OWNER).send({});
  assert.equal(owner.status, 200, owner.text);
  assert.equal(runs[1]!.apiKey, undefined);
  assert.equal(runs[1]!.env.INPUT_DESC, 'a boat at dusk');
});

test('POST /api/projects/:id/redeploy: the owner (session or actor) queues the newest commit again; a member may not', async () => {
  const member = await request(app).post(`/api/projects/${projectId}/redeploy`).set(await asActor('acc_member')).send({});
  assert.equal(member.status, 403);
  assert.equal(member.body.error.code, 'forbidden');
  assert.equal((await request(app).post(`/api/projects/${projectId}/redeploy`).set(await asActor('acc_other')).send({})).status, 404);
  const before = store.deploymentsOf(projectId).length;
  const res = await request(app).post(`/api/projects/${projectId}/redeploy`).set(await asActor('acc_owner')).send({});
  assert.equal(res.status, 202, res.text);
  assert.equal(res.body.status, 'queued');
  await worker.idle();
  const d = store.deployment(res.body.deploymentId)!;
  assert.equal(d.sha, sha1);
  assert.deepEqual(d.pusher, { subject: 'acc_owner' });
  assert.equal(d.status, 'ready');
  assert.equal(store.deploymentsOf(projectId).length, before + 1);
  const session = await request(app).post(`/api/projects/${projectId}/redeploy`).set('x-test-user', OWNER).send({});
  assert.equal(session.status, 202);
  await worker.idle();
});
