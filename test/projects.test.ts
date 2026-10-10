/**
 * Projects bound to aindrive git repositories (src/projects.ts, src/project-routes.ts).
 *
 * The real pieces: the routes, the store, the worker and a real `git clone` over smart HTTP against a local bare
 * repository served by `git http-backend` the way aindrive serves a drive's repo — behind a bearer token. What is
 * faked is the sandbox: `/api/run` is another module's, so a `RunScript` stand-in records the request it would
 * have made and speaks the contract's events back (stdout, exit).
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
import express, { type Request } from 'express';
import request from 'supertest';
import { HostedAgentSecretStore } from '../src/hosted-agent-secrets.js';
import { projectRoutes } from '../src/project-routes.js';
import { DeploymentLogs, ProjectStore, ProjectWorker, parseRepoUrl, signHook, type RunRequest, type RunScript } from '../src/projects.js';
import { principalCaller } from '../src/shared-agents.js';

const exec = promisify(execFile);
const git = async (dir: string, args: string[]) => (await exec('git', ['-C', dir, ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout.trim();

const ALICE = 'sso:alice';
const BOB = 'sso:bob';
const TOKEN = 'aind_aat_test_token_do_not_leak';

let tmp: string;
let repoRoot: string;
let aindrive: Server;
let aindriveBase = '';
/** Every Authorization header the fake aindrive saw on git traffic. */
const authSeen: (string | undefined)[] = [];
let app: express.Express;
let store: ProjectStore;
let worker: ProjectWorker;
let logs: DeploymentLogs;
const runs: RunRequest[] = [];
let runBehaviour: RunScript = async (req, on) => {
  runs.push(req);
  on({ event: 'stdout', data: `hello from ${req.entry}: ${req.files[req.entry]!.trim()}\n` });
  on({ event: 'exit', data: { code: 0, ms: 5 } });
};

/** aindrive's side: `git http-backend` behind a bearer check, at /<org>/git/<repo>[.git]. */
function fakeAindrive(): express.Express {
  const srv = express();
  srv.all(/^\/testorg\/git\/([A-Za-z0-9_-]+)(?:\.git)?(\/.*)?$/, (req, res) => {
    authSeen.push(req.header('authorization'));
    if (req.header('authorization') !== `Bearer ${TOKEN}`) { res.status(401).type('text/plain').send('sign in'); return; }
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

const commit = async (work: string, file: string, content: string, message: string): Promise<string> => {
  writeFileSync(join(work, file), content);
  await git(work, ['add', '-A']);
  await git(work, ['commit', '-q', '-m', message]);
  await git(work, ['push', '-q', 'origin', 'HEAD:main']);
  return git(work, ['rev-parse', 'HEAD']);
};

let work: string;
let sha1: string;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'ainize-projects-'));
  repoRoot = join(tmp, 'drives');
  mkdirSync(join(repoRoot, 'demo.git'), { recursive: true });
  await git(join(repoRoot, 'demo.git'), ['init', '-q', '--bare', '--initial-branch=main']);
  await git(join(repoRoot, 'demo.git'), ['config', 'http.receivepack', 'true']);
  work = join(tmp, 'work');
  mkdirSync(work);
  await git(work, ['init', '-q', '--initial-branch=main']);
  await git(work, ['config', 'user.name', 'A Person']);
  await git(work, ['config', 'user.email', 'person@example.com']);
  await git(work, ['remote', 'add', 'origin', join(repoRoot, 'demo.git')]);
  writeFileSync(join(work, 'README.md'), '# demo\n');
  sha1 = await commit(work, 'main.py', 'print("v1")\n', 'v1');

  aindrive = fakeAindrive().listen(0, '127.0.0.1');
  await new Promise((r) => aindrive.once('listening', r));
  aindriveBase = `http://127.0.0.1:${(aindrive.address() as AddressInfo).port}`;

  store = new ProjectStore(join(tmp, 'projects.json'));
  const secrets = new HostedAgentSecretStore(join(tmp, 'project-secrets.json'), join(tmp, 'secrets.key'));
  logs = new DeploymentLogs(join(tmp, 'logs'));
  worker = new ProjectWorker({
    store, logs, run: (req, on) => runBehaviour(req, on),
    deployToken: (id) => secrets.reveal(id, ['deployToken']).deployToken ?? null,
    publicUrl: () => 'https://node.example',
  });
  app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as Request & { rawBody?: Buffer }).rawBody = buf; } }));
  app.use(projectRoutes({
    store, secrets, logs, worker,
    caller: (req) => { const u = req.header('x-test-user'); return u ? principalCaller(u) : null; },
    publicBase: () => 'https://node.example',
  }));
});

after(() => {
  worker.stop();
  aindrive.close();
  rmSync(tmp, { recursive: true, force: true });
});

const as = (user: string) => ({ 'x-test-user': user });
const repoUrl = () => `${aindriveBase}/testorg/git/demo`;
let project: { id: string; webhookSecret: string };
const hook = (body: unknown, secret = project.webhookSecret) => {
  const raw = JSON.stringify(body);
  return request(app).post(`/api/projects/${project.id}/hook`).set('content-type', 'application/json').set('x-ainize-signature', signHook(secret, raw)).send(raw);
};
const push = (after: string, ref = 'refs/heads/main') => hook({ ref, before: '0'.repeat(40), after, pusher: { subject: 'sso:alice', email: 'alice@example.com' } });

// ───────────────────────────────────────────── URLs

test('aindrive git URLs give an org and a repo name; credentials and plain http off loopback are refused', () => {
  assert.deepEqual(parseRepoUrl('https://aindrive.ainetwork.ai/comcom/git/art-search.git/'), { url: 'https://aindrive.ainetwork.ai/comcom/git/art-search', org: 'comcom', repoName: 'art-search' });
  assert.deepEqual(parseRepoUrl('https://aindrive.ainetwork.ai/api/drives/-nLGGiI3VXYR/git/tools/art-search'), { url: 'https://aindrive.ainetwork.ai/api/drives/-nLGGiI3VXYR/git/tools/art-search', org: '-nLGGiI3VXYR', repoName: 'art-search' });
  assert.equal(parseRepoUrl('https://aindrive.ainetwork.ai/comcom/art-search'), null, 'no /git/ segment');
  assert.equal(parseRepoUrl('https://user:pw@aindrive.ainetwork.ai/comcom/git/x'), null);
  assert.equal(parseRepoUrl('http://aindrive.ainetwork.ai/comcom/git/x'), null);
  assert.ok(parseRepoUrl('http://127.0.0.1:9/o/git/x'));
});

// ───────────────────────────────────────────── create / read / list

test('creating a project needs a sign-in, a git URL and (for a script) an entry; the secret comes back once', async () => {
  assert.equal((await request(app).post('/api/projects').send({ repo: repoUrl(), kind: 'script', entry: 'main.py' })).status, 401);
  const bad = await request(app).post('/api/projects').set(as(ALICE)).send({ repo: 'https://aindrive.ainetwork.ai/comcom/nogit', kind: 'script', entry: 'main.py' });
  assert.equal(bad.status, 400);
  const noEntry = await request(app).post('/api/projects').set(as(ALICE)).send({ repo: repoUrl(), kind: 'script' });
  assert.equal(noEntry.status, 400);

  const res = await request(app).post('/api/projects').set(as(ALICE)).send({ repo: repoUrl(), kind: 'script', entry: 'main.py', deployToken: TOKEN });
  assert.equal(res.status, 201, res.text);
  assert.equal(res.body.org, 'testorg');
  assert.equal(res.body.repoName, 'demo');
  assert.equal(res.body.branch, 'main');
  assert.equal(res.body.status, 'idle');
  assert.equal(res.body.url, 'https://node.example/testorg/demo');
  assert.match(res.body.webhookSecret, /^whsec_[0-9a-f]{48}$/);
  assert.equal(res.body.hasDeployToken, true);
  project = res.body;

  const again = await request(app).get(`/api/projects/${project.id}`).set(as(ALICE));
  assert.equal(again.status, 200);
  assert.equal(again.body.webhookSecret, undefined, 'the secret is never read back');
  assert.equal((await request(app).get(`/api/projects/${project.id}`).set(as(BOB))).status, 404, 'another account\'s project is not confirmed to exist');
  const mine = await request(app).get('/api/projects').set(as(ALICE));
  assert.deepEqual(mine.body.projects.map((p: { id: string }) => p.id), [project.id]);
  assert.deepEqual((await request(app).get('/api/projects').set(as(BOB))).body.projects, []);

  const dup = await request(app).post('/api/projects').set(as(BOB)).send({ repo: `${repoUrl()}.git`, kind: 'script', entry: 'main.py' });
  assert.equal(dup.status, 409, 'one repo+branch is one project');
});

test('kind=agent is refused 501 until it is wired', async () => {
  const res = await request(app).post('/api/projects').set(as(ALICE)).send({ repo: `${aindriveBase}/testorg/git/other`, kind: 'agent' });
  assert.equal(res.status, 501);
  assert.equal(res.body.error.code, 'not_implemented');
});

// ───────────────────────────────────────────── the hook

test('a hook with a bad signature is 401, a missing one too, and a push to another branch is ignored 202', async () => {
  assert.equal((await hook({ ref: 'refs/heads/main', after: sha1 }, 'wrong')).status, 401);
  const unsigned = await request(app).post(`/api/projects/${project.id}/hook`).send({ ref: 'refs/heads/main', after: sha1 });
  assert.equal(unsigned.status, 401);
  assert.equal((await hook({ ref: 'refs/heads/main', after: sha1 }, project.webhookSecret).then((r) => r.status)), 202);
  await worker.idle();
  const other = await push(sha1, 'refs/heads/feature');
  assert.equal(other.status, 202);
  assert.equal(other.body.ignored, true);
  assert.equal(store.deploymentsOf(project.id).length, 1, 'the ignored push made no deployment');
  assert.equal((await request(app).post('/api/projects/prj_nope/hook').send({})).status, 404);
});

test('a push clones that commit with the deploy token, runs the entry, and the deployment ends ready with the output in its log', async () => {
  const d = store.deploymentsOf(project.id)[0]!;
  assert.equal(d.status, 'ready', JSON.stringify(d));
  assert.equal(d.sha, sha1);
  assert.equal(d.exitCode, 0);
  assert.ok(d.ms !== null && d.startedAt && d.finishedAt);
  assert.ok(authSeen.length > 0 && authSeen.every((h) => h === `Bearer ${TOKEN}`), `every git request carried the token: ${JSON.stringify(authSeen)}`);
  const run = runs[0]!;
  assert.equal(run.language, 'python');
  assert.equal(run.entry, 'main.py');
  assert.deepEqual(Object.keys(run.files).sort(), ['README.md', 'main.py'], '.git is not shipped');
  assert.equal(run.env.AINIZE_DECIDE_URL, 'https://node.example/api/decide');

  const view = await request(app).get(`/api/deployments/${d.id}`).set(as(ALICE));
  assert.equal(view.status, 200);
  assert.equal(view.body.status, 'ready');
  assert.equal(view.body.logUrl, `https://node.example/api/deployments/${d.id}/log`);
  assert.equal(view.body.outputUrl, `https://node.example/api/deployments/${d.id}/output`);
  const log = await request(app).get(`/api/deployments/${d.id}/log`).set(as(ALICE));
  assert.equal(log.status, 200);
  assert.match(log.text, /hello from main\.py: print\("v1"\)/);
  assert.match(log.text, /\[ainize\] exit 0/);
  const out = await request(app).get(`/api/deployments/${d.id}/output`).set(as(ALICE));
  assert.equal(out.text, 'hello from main.py: print("v1")\n');
  assert.equal((await request(app).get(`/api/deployments/${d.id}`).set(as(BOB))).status, 404);
  assert.equal((await request(app).get(`/api/projects/${project.id}`).set(as(ALICE))).body.status, 'ready');
});

test('two pushes queue in order per project, each on its own commit; a failing exit ends in error', async () => {
  const sha2 = await commit(work, 'main.py', 'print("v2")\n', 'v2');
  const sha3 = await commit(work, 'main.py', 'import sys; sys.exit(3)\n', 'v3');
  const seen: string[] = [];
  runBehaviour = async (req, on) => {
    runs.push(req);
    seen.push(req.files['main.py']!.trim());
    await new Promise((r) => setTimeout(r, 30));
    on({ event: 'stdout', data: `ran ${req.files['main.py']!.trim()}\n` });
    on({ event: 'exit', data: req.files['main.py']!.includes('exit(3)') ? { code: 3, ms: 30 } : { code: 0, ms: 30 } });
  };
  const a = await push(sha2);
  const b = await push(sha3);
  assert.equal(a.status, 202); assert.equal(b.status, 202);
  assert.deepEqual(store.deploymentsOf(project.id).slice(0, 2).map((d) => d.status).sort(), ['building', 'queued'].sort(), 'one builds while the next waits');

  // the live log of the second (queued) one is SSE and ends with `done`
  const live = await new Promise<string>((resolve, reject) => {
    request(app).get(`/api/deployments/${b.body.deploymentId}/log`).set(as(ALICE)).buffer(true).parse((res, cb) => {
      let text = '';
      res.on('data', (c: Buffer) => { text += c.toString('utf8'); });
      res.on('end', () => cb(null, text));
    }).end((err, res) => (err ? reject(err) : resolve(res.body as string)));
  });
  assert.match(live, /^event: log/m);
  assert.match(live, /event: done\ndata: .*"status":"error"/);

  await worker.idle();
  assert.deepEqual(seen, ['print("v2")', 'import sys; sys.exit(3)'], 'in push order');
  const [third, second] = store.deploymentsOf(project.id);
  assert.equal(second!.sha, sha2); assert.equal(second!.status, 'ready');
  assert.equal(third!.sha, sha3); assert.equal(third!.status, 'error'); assert.equal(third!.exitCode, 3);
  const list = await request(app).get(`/api/projects/${project.id}/deployments`).set(as(ALICE));
  assert.equal(list.body.deployments.length, 3);
  assert.equal(list.body.deployments[0].outputUrl, undefined, 'an errored run has no output address');
  assert.equal((await request(app).get(`/api/projects/${project.id}`).set(as(ALICE))).body.status, 'error');
});

test('a clone without a valid token fails the deployment with a reason, and the token is not in the log', async () => {
  const bare = await request(app).post('/api/projects').set(as(BOB)).send({ repo: `${repoUrl()}`, branch: 'other', kind: 'script', entry: 'main.py' });
  assert.equal(bare.status, 201);
  const raw = JSON.stringify({ ref: 'refs/heads/other', after: sha1 });
  const res = await request(app).post(`/api/projects/${bare.body.id}/hook`).set('content-type', 'application/json').set('x-ainize-signature', signHook(bare.body.webhookSecret, raw)).send(raw);
  assert.equal(res.status, 202);
  await worker.idle();
  const d = store.deployment(res.body.deploymentId)!;
  assert.equal(d.status, 'error');
  assert.match(d.error!, /git clone failed/);
  assert.doesNotMatch(logs.read(d.id)!, new RegExp(TOKEN));
});

// ───────────────────────────────────────────── by-repo + CORS

test('by-repo answers aindrive with the project status and CORS for its origin, and 404 for an unbound repo', async () => {
  const res = await request(app).get('/api/projects/by-repo').query({ repo: `${repoUrl()}.git` }).set('origin', 'https://aindrive.ainetwork.ai');
  assert.equal(res.status, 200);
  assert.equal(res.body.id, project.id);
  assert.equal(res.body.status, 'error');
  assert.equal(res.body.lastDeployment.status, 'error');
  assert.equal(res.body.owner, undefined);
  assert.equal(res.headers['access-control-allow-origin'], 'https://aindrive.ainetwork.ai');
  const other = await request(app).get('/api/projects/by-repo').query({ repo: repoUrl() }).set('origin', 'https://evil.example');
  assert.equal(other.headers['access-control-allow-origin'], undefined);
  assert.equal((await request(app).get('/api/projects/by-repo').query({ repo: 'https://aindrive.ainetwork.ai/x/git/y' })).status, 404);
  const pre = await request(app).options(`/api/projects/${project.id}/hook`).set('origin', 'https://aindrive.ainetwork.ai').set('access-control-request-method', 'POST');
  assert.equal(pre.status, 204);
  assert.match(pre.headers['access-control-allow-headers'], /X-Ainize-Signature/);
});

// ───────────────────────────────────────────── retention + delete

test('a project keeps its newest deployments, and removing it takes its deployments, logs and secrets', async () => {
  const small = new ProjectStore(join(tmp, 'small.json'));
  const p = small.create({ repo: parseRepoUrl('https://aindrive.ainetwork.ai/o/git/r')!, branch: 'main', kind: 'script', entry: 'a.py' }, ALICE);
  for (let i = 0; i < 5; i++) {
    const d = small.createDeployment(p, { ref: 'refs/heads/main', after: `${i}`.repeat(40) }, 1000 + i);
    small.updateDeployment(d.id, { status: 'ready' });
  }
  assert.equal(small.prune(p.id, 3).length, 2);
  assert.deepEqual(small.deploymentsOf(p.id).map((d) => d.sha[0]), ['4', '3', '2']);

  const first = store.deploymentsOf(project.id).at(-1)!;
  assert.ok(logs.read(first.id));
  const res = await request(app).delete(`/api/projects/${project.id}`).set(as(ALICE));
  assert.equal(res.status, 200);
  assert.equal(store.get(project.id), null);
  assert.equal(store.deployment(first.id), null);
  assert.equal(logs.read(first.id), null);
  assert.equal((await request(app).get(`/api/projects/${project.id}`).set(as(ALICE))).status, 404);
  // Bob's project on the same repo (branch `other`) is what by-repo now resolves to.
  const left = await request(app).get('/api/projects/by-repo').query({ repo: repoUrl() });
  assert.equal(left.status, 200);
  assert.equal(left.body.branch, 'other');
});
