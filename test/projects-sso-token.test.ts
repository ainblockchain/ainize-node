/**
 * The node's machine identity for project clones (src/sso-service-token.ts, ProjectWorker.clone).
 *
 * Real pieces: `ServiceTokenClient` against a fake AIN SSO (discovery + token endpoint that checks client_secret_basic,
 * `grant_type` and `resource`), a real `git clone` over smart HTTP against a fake aindrive that serves a bare repo with
 * `git http-backend` only to the bearer AIN SSO issued, and the real ProjectWorker/store. The sandbox is a stand-in.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { DeploymentLogs, parseRepoUrl, ProjectStore, ProjectWorker, type Project, type RunRequest } from '../src/projects.js';
import { resourceOf, ServiceTokenClient, ServiceTokenError } from '../src/sso-service-token.js';
import { readSsoConfig } from '../src/sso.js';

const exec = promisify(execFile);
const git = async (dir: string, args: string[]) => (await exec('git', ['-C', dir, ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout.trim();

const CLIENT_ID = 'ainize';
const CLIENT_SECRET = 's3cret-of-the-node';

let tmp: string;
let repoRoot: string;
let sso: Server;
let ssoBase = '';
let aindrive: Server;
let aindriveBase = '';
/** Tokens the fake SSO minted, in order; the fake aindrive accepts exactly the live ones. */
const minted: string[] = [];
let expired = new Set<string>();
const tokenCalls: { authorization: string | undefined; body: Record<string, string> }[] = [];
const authSeen: (string | undefined)[] = [];
let ssoFailure: { status: number; body: unknown } | null = null;

function fakeSso(): express.Express {
  const srv = express();
  srv.use(express.urlencoded({ extended: false }));
  srv.get('/.well-known/openid-configuration', (_req, res) => {
    res.json({ issuer: ssoBase, token_endpoint: `${ssoBase}/oidc/token`, jwks_uri: `${ssoBase}/oidc/jwks`, grant_types_supported: ['authorization_code', 'client_credentials'] });
  });
  srv.post('/oidc/token', (req, res) => {
    tokenCalls.push({ authorization: req.header('authorization'), body: req.body as Record<string, string> });
    if (ssoFailure) { res.status(ssoFailure.status).json(ssoFailure.body); return; }
    const expect = `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`;
    if (req.header('authorization') !== expect) { res.status(401).json({ error: 'invalid_client' }); return; }
    const b = req.body as Record<string, string>;
    if (b.grant_type !== 'client_credentials') { res.status(400).json({ error: 'unsupported_grant_type' }); return; }
    if (b.resource !== aindriveBase) { res.status(400).json({ error: 'invalid_target', error_description: 'the resource is not available to this client' }); return; }
    const token = `svc_${minted.length + 1}_${Math.random().toString(36).slice(2)}`;
    minted.push(token);
    res.json({ access_token: token, token_type: 'Bearer', expires_in: 300 });
  });
  return srv;
}

/** aindrive's side: `git http-backend` behind the service-principal check, at /<org>/git/<repo>[.git] (every repo name is the one bare repo). */
function fakeAindrive(): express.Express {
  const srv = express();
  srv.all(/^\/testorg\/git\/([A-Za-z0-9_-]+)(?:\.git)?(\/.*)?$/, (req, res) => {
    const auth = req.header('authorization');
    authSeen.push(auth);
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!minted.includes(token) || expired.has(token)) { res.status(401).set('www-authenticate', 'Bearer error="invalid_token"').json({ error: 'invalid service token' }); return; }
    if (/git-receive-pack/.test(req.originalUrl)) { res.status(403).json({ error: 'forbidden' }); return; }
    const [, , rest = ''] = req.path.match(/^\/testorg\/git\/([A-Za-z0-9_-]+)(?:\.git)?(\/.*)?$/)!;
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, GIT_PROJECT_ROOT: repoRoot, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: `/demo.git${rest}`,
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

let sha1: string;
let store: ProjectStore;
let logs: DeploymentLogs;
const runs: RunRequest[] = [];
const deployTokens = new Map<string, string>();
let client: ServiceTokenClient;
let worker: ProjectWorker;
const ssoLog: string[] = [];

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'ainize-projects-sso-'));
  repoRoot = join(tmp, 'drives');
  mkdirSync(join(repoRoot, 'demo.git'), { recursive: true });
  await git(join(repoRoot, 'demo.git'), ['init', '-q', '--bare', '--initial-branch=main']);
  const work = join(tmp, 'work');
  mkdirSync(work);
  await git(work, ['init', '-q', '--initial-branch=main']);
  await git(work, ['config', 'user.name', 'A Person']);
  await git(work, ['config', 'user.email', 'person@example.com']);
  await git(work, ['remote', 'add', 'origin', join(repoRoot, 'demo.git')]);
  writeFileSync(join(work, 'ainize.json'), JSON.stringify({ kind: 'script', entry: 'main.py' }));
  writeFileSync(join(work, 'main.py'), 'print("v1")\n');
  await git(work, ['add', '-A']);
  await git(work, ['commit', '-q', '-m', 'v1']);
  await git(work, ['push', '-q', 'origin', 'HEAD:main']);
  sha1 = await git(work, ['rev-parse', 'HEAD']);

  sso = fakeSso().listen(0, '127.0.0.1');
  await new Promise((r) => sso.once('listening', r));
  ssoBase = `http://127.0.0.1:${(sso.address() as AddressInfo).port}`;
  aindrive = fakeAindrive().listen(0, '127.0.0.1');
  await new Promise((r) => aindrive.once('listening', r));
  aindriveBase = `http://127.0.0.1:${(aindrive.address() as AddressInfo).port}`;

  client = new ServiceTokenClient({ issuer: ssoBase, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, log: (_l, m) => ssoLog.push(m) });
  store = new ProjectStore(join(tmp, 'projects.json'));
  logs = new DeploymentLogs(join(tmp, 'logs'));
  worker = new ProjectWorker({
    store, logs,
    run: async (req, on) => { runs.push(req); on({ event: 'stdout', data: 'ok\n' }); on({ event: 'exit', data: { code: 0, ms: 3 } }); },
    deployToken: (id) => deployTokens.get(id) ?? null,
    serviceToken: async (resource) => { try { return await client.token(resource); } catch (e) { ssoLog.push(`refused: ${(e as Error).message}`); return null; } },
    publicUrl: () => 'https://node.example',
  });
});

after(async () => {
  worker.stop();
  sso.close();
  aindrive.close();
  rmSync(tmp, { recursive: true, force: true });
});

// ───────────────────────────────────────────── the token client

test('readSsoConfig carries AIN_SSO_CLIENT_SECRET; without it the node has no machine identity', () => {
  const base = { AIN_SSO_ISSUER: 'https://auth.example', AIN_SSO_CLIENT_ID: 'ainize' };
  assert.equal(readSsoConfig(base)!.clientSecret, null);
  assert.equal(readSsoConfig({ ...base, AIN_SSO_CLIENT_SECRET: ' shh ' })!.clientSecret, 'shh');
  assert.equal(resourceOf('https://aindrive.ainetwork.ai/comcom/git/site.git'), 'https://aindrive.ainetwork.ai');
  assert.equal(resourceOf('https://aindrive.ainetwork.ai:8443/api/drives/d1/git/x'), 'https://aindrive.ainetwork.ai:8443');
});

test('the client discovers the token endpoint, authenticates with client_secret_basic, names the resource, and caches until expiry', async () => {
  let now = 1_000_000_000_000;
  const c = new ServiceTokenClient({ issuer: ssoBase, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, now: () => now });
  const before = tokenCalls.length;
  const t1 = await c.token(aindriveBase);
  assert.match(t1, /^svc_/);
  assert.equal(tokenCalls.length, before + 1);
  const call = tokenCalls[tokenCalls.length - 1]!;
  assert.equal(call.authorization, `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`);
  assert.deepEqual(call.body, { grant_type: 'client_credentials', resource: aindriveBase });
  // Cached: no second request while live; concurrent askers share one request.
  const [a, b] = await Promise.all([c.token(aindriveBase), c.token(aindriveBase)]);
  assert.equal(a, t1); assert.equal(b, t1);
  assert.equal(tokenCalls.length, before + 1);
  // 30 s before `exp` it counts as expired and is refreshed.
  now += 271_000;
  const t2 = await c.token(aindriveBase);
  assert.notEqual(t2, t1);
  assert.equal(tokenCalls.length, before + 2);
  // Another resource is another token (the SSO here only serves aindrive's).
  await assert.rejects(c.token('https://elsewhere.example'), (e: ServiceTokenError) => e instanceof ServiceTokenError && /invalid_target/.test(e.message) && e.status === 400);
  // The secret never appears in an error.
  try { await c.token('https://elsewhere.example'); } catch (e) { assert.ok(!(e as Error).message.includes(CLIENT_SECRET)); }
});

test('a wrong secret is invalid_client; discovery that names another issuer is refused', async () => {
  const wrong = new ServiceTokenClient({ issuer: ssoBase, clientId: CLIENT_ID, clientSecret: 'nope' });
  await assert.rejects(wrong.token(aindriveBase), /invalid_client/);
  const other = new ServiceTokenClient({ issuer: `${ssoBase}/not-the-issuer`, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  await assert.rejects(other.token(aindriveBase), /discovery/);
});

// ───────────────────────────────────────────── the worker

const newProject = (name: string) => store.create({ repo: parseRepoUrl(`${aindriveBase}/testorg/git/${name}`)!, branch: 'main', kind: null, entry: null, name }, 'sso:alice');
const newDeployment = (project: Project) => store.createDeployment(project, { ref: 'refs/heads/main', after: sha1 });
const deploy = async (project: Project) => {
  const d = newDeployment(project);
  worker.enqueue(d.id);
  await worker.idle();
  return store.deployment(d.id)!;
};

test('a project without a deploy token is cloned as the node: the SSO token is the git bearer, and it is reused across deployments', async () => {
  const project = newProject('demo');
  authSeen.length = 0;
  const callsBefore = tokenCalls.length;
  const d1 = await deploy(project);
  assert.equal(d1.status, 'ready', JSON.stringify(d1));
  assert.ok(authSeen.length > 0 && authSeen.every((h) => h === `Bearer ${minted[minted.length - 1]}`), `every git request carried the SSO token: ${JSON.stringify(authSeen)}`);
  assert.equal(tokenCalls.length, callsBefore + 1, 'one token request');
  assert.match(logs.read(d1.id)!, /clone as this node \(AIN SSO machine token for http:\/\/127\.0\.0\.1:\d+\)/);
  assert.ok(!logs.read(d1.id)!.includes(minted[minted.length - 1]!), 'the token is not in the deployment log');
  const d2 = await deploy(project);
  assert.equal(d2.status, 'ready');
  assert.equal(tokenCalls.length, callsBefore + 1, 'the cached token served the second clone');
});

test('a pasted deploy token overrides the machine identity', async () => {
  const project = newProject('demo2');
  deployTokens.set(project.id, 'pasted-token-not-known-to-aindrive');
  authSeen.length = 0;
  const callsBefore = tokenCalls.length;
  const d = await deploy(project);
  assert.equal(d.status, 'error');
  assert.match(d.error ?? '', /Authentication failed|401/);
  assert.ok(authSeen.every((h) => h === 'Bearer pasted-token-not-known-to-aindrive'), 'the pasted token was presented, not the node\'s');
  assert.equal(tokenCalls.length, callsBefore, 'no machine token was requested');
  assert.match(logs.read(d.id)!, /clone with the project's deploy token/);
  deployTokens.delete(project.id);
});

test('when AIN SSO refuses, the clone goes on anonymously and the deployment shows aindrive\'s 401 — never the secret', async () => {
  const project = newProject('demo3');
  const fresh = new ServiceTokenClient({ issuer: ssoBase, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  const w = new ProjectWorker({
    store, logs, run: async (_req, on) => on({ event: 'exit', data: { code: 0, ms: 1 } }),
    deployToken: () => null,
    serviceToken: async (r) => { try { return await fresh.token(r); } catch (e) { ssoLog.push(`refused: ${(e as Error).message}`); return null; } },
    publicUrl: () => 'https://node.example',
  });
  ssoFailure = { status: 400, body: { error: 'invalid_target', error_description: 'the resource is not available to this client' } };
  try {
    const d = newDeployment(project);
    authSeen.length = 0;
    w.enqueue(d.id);
    await w.idle();
    const done = store.deployment(d.id)!;
    assert.equal(done.status, 'error');
    assert.match(done.error ?? '', /Authentication failed|401/);
    assert.ok(authSeen.every((h) => h === undefined), 'anonymous');
    assert.match(logs.read(d.id)!, /clone anonymously \(no machine token for this host\)/);
    assert.ok(ssoLog.some((m) => /refused: .*invalid_target/.test(m)));
    assert.ok(ssoLog.every((m) => !m.includes(CLIENT_SECRET)));
  } finally { ssoFailure = null; w.stop(); }
});

test('an expired token at aindrive fails that clone; the next deployment asks AIN SSO again', async () => {
  const project = newProject('demo4');
  let now = Date.now();
  const c = new ServiceTokenClient({ issuer: ssoBase, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, now: () => now });
  const w = new ProjectWorker({
    store, logs, run: async (_req, on) => on({ event: 'exit', data: { code: 0, ms: 1 } }),
    deployToken: () => null, serviceToken: (r) => c.token(r).catch(() => null), publicUrl: () => 'https://node.example',
  });
  try {
    const t = await c.token(aindriveBase);
    expired = new Set([t]); // aindrive's clock says it is gone
    const d1 = newDeployment(project);
    w.enqueue(d1.id); await w.idle();
    assert.equal(store.deployment(d1.id)!.status, 'error');
    now += 300_000; // the node's cache agrees it expired
    const d2 = newDeployment(project);
    w.enqueue(d2.id); await w.idle();
    assert.equal(store.deployment(d2.id)!.status, 'ready', JSON.stringify(store.deployment(d2.id)));
  } finally { expired = new Set(); w.stop(); }
});
