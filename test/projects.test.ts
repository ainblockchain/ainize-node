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
import { createServer, type Server } from 'node:http';
import express, { type Request } from 'express';
import request from 'supertest';
import type { NodeConfig } from '@ainize/core';
import { buildAgents } from '../src/agents.js';
import { HostedAgentGateway } from '../src/hosted-agent-gateway.js';
import { HostedAgentHost } from '../src/hosted-agent-host.js';
import { HostedAgentSecretStore } from '../src/hosted-agent-secrets.js';
import { HostedAgentStore } from '../src/hosted-agent-store.js';
import { InferenceBackendRegistry } from '../src/inference-backends.js';
import { projectAgentId, projectAgentSpecOf } from '../src/project-agents.js';
import { dependsOnNext, nextjsDockerfile, parseProjectManifest, resolveProjectManifest, ProjectManifestError, PROJECT_NO_MANIFEST } from '../src/project-manifest.js';
import { projectRoutes } from '../src/project-routes.js';
import { DeploymentLogs, ProjectStore, ProjectWorker, parseRepoUrl, signHook, type RunRequest, type RunScript } from '../src/projects.js';
import { principalCaller } from '../src/shared-agents.js';

const exec = promisify(execFile);
const git = async (dir: string, args: string[]) => (await exec('git', ['-C', dir, ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout.trim();

const ALICE = 'sso:alice';
const BOB = 'sso:bob';
const CAROL = 'sso:carol';
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

/** Every Authorization header the fake aindrive saw on its repositories listing. */
const repoListingAuth: (string | undefined)[] = [];
/** aindrive's side: `git http-backend` behind a bearer check, at /<org>/git/<repo>[.git]; and the org's repositories listing. */
function fakeAindrive(): express.Express {
  const srv = express();
  srv.get('/api/orgs/:org/repositories', (req, res) => {
    repoListingAuth.push(req.header('authorization'));
    if (req.header('authorization') !== 'Bearer machine-token') { res.status(401).json({ error: 'invalid service token' }); return; }
    if (req.params.org !== 'testorg') { res.status(404).json({ error: 'not found' }); return; }
    res.json({ driveId: 'drv1', driveUrl: 'https://aindrive.example/d/drv1?path=repositories', repositories: [{ name: 'demo', cloneUrl: `${aindriveBase}/testorg/git/demo`, headSha: 'a'.repeat(40), headSubject: 'v1', updatedAt: 1, hasManifest: true }, { name: 'unbound', cloneUrl: `${aindriveBase}/testorg/git/unbound`, headSha: null, headSubject: null, updatedAt: 2, hasManifest: false }] });
  });
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
let model: Server;
let hostedStore: HostedAgentStore;
let host: HostedAgentHost;
const MODEL = 'Test-Chat-1';
const applied: string[] = [];



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
  writeFileSync(join(work, 'ainize.json'), JSON.stringify({ kind: 'script', entry: 'main.py', env: { GREETING: 'hi' }, inputs: { desc: { description: '묘사', default: 'a boat at dusk' }, TOP_K: { type: 'number', default: 5 }, verbose: { type: 'boolean', default: false }, MODEL: { type: 'choice', options: ['clef-flash', 'clef'] } }, examples: [{ name: '노을 바다 유화', inputs: { desc: '노을 바다 유화', TOP_K: 3 } }] }, null, 2));
  sha1 = await commit(work, 'main.py', 'print("v1")\n', 'v1');

  // A fake chat model behind a real hosted-agent host, for `kind: agent` (prompt mode needs no Docker).
  model = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { model: string; messages: { role: string; content: string }[] };
    const sys = body.messages.find((m) => m.role === 'system')?.content ?? '';
    const user = [...body.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: `[${body.model}] sys=${sys.trim()} | you said: ${user}` } }] }));
  });
  await new Promise<void>((r) => model.listen(0, '127.0.0.1', () => r()));
  const registry = new InferenceBackendRegistry([{ id: 'llm', modality: 'chat', upstream: `http://127.0.0.1:${(model.address() as AddressInfo).port}`, models: [MODEL], concurrency: 1 }]);
  hostedStore = new HostedAgentStore(join(tmp, 'hosted.json'));
  const hostedSecrets = new HostedAgentSecretStore(join(tmp, 'hosted-secrets.json'), join(tmp, 'hosted.key'));
  const gateway = new HostedAgentGateway({ registry: () => registry, spec: (id) => hostedStore.get(id), log: () => {} });
  host = new HostedAgentHost({ gateway, secrets: hostedSecrets, docker: null, idleStopMs: 60_000, maxRunning: 2, log: () => {} });
  await host.start([]);

  aindrive = fakeAindrive().listen(0, '127.0.0.1');
  await new Promise((r) => aindrive.once('listening', r));
  aindriveBase = `http://127.0.0.1:${(aindrive.address() as AddressInfo).port}`;

  store = new ProjectStore(join(tmp, 'projects.json'));
  const secrets = new HostedAgentSecretStore(join(tmp, 'project-secrets.json'), join(tmp, 'secrets.key'));
  logs = new DeploymentLogs(join(tmp, 'logs'));
  worker = new ProjectWorker({
    store, logs, run: (req, on) => runBehaviour(req, on),
    agents: { store: hostedStore, host, onApplied: (spec, created) => { applied.push(`${created ? 'create' : 'update'} ${spec.id} v${spec.version}`); } },
    deployToken: (id) => secrets.reveal(id, ['deployToken']).deployToken ?? null,
    publicUrl: () => 'https://node.example',
  });
  app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as Request & { rawBody?: Buffer }).rawBody = buf; } }));
  app.use(projectRoutes({
    store, secrets, logs, worker,
    // CAROL is no owner but a member of testorg's organization (org_t); everyone else is a plain principal.
    caller: (req) => { const u = req.header('x-test-user'); return u ? (u === CAROL ? { ...principalCaller(u), orgMember: (id) => id === 'org_t' } : principalCaller(u)) : null; },
    publicBase: () => 'https://node.example',
    orgIdsForSlug: (slug) => (slug === 'testorg' ? ['org_t'] : []),
    aindrive: { origin: aindriveBase, token: async () => 'machine-token', cacheMs: 60_000 },
  }));
  const cfg = { identity: { address: '0x1111111111111111111111111111111111111111' }, agents: [], publicUrl: 'https://node.example' } as unknown as NodeConfig;
  app.use(buildAgents(cfg, { hosted: { host, store: hostedStore } }));
});

after(async () => {
  worker.stop();
  aindrive.close();
  model.close();
  await host.stop();
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

// ───────────────────────────────────────────── ainize.json

test('ainize.json: valid, invalid, missing, and the Next.js default', () => {
  assert.equal(parseProjectManifest('{"kind":"script","entry":"a.py"}').kind, 'script');
  assert.throws(() => parseProjectManifest('{"kind":"script",'), /not valid JSON/);
  assert.throws(() => parseProjectManifest('{"kind":"lambda"}'), /kind/);
  assert.throws(() => parseProjectManifest('{"kind":"service","port":70000}'), /port/);
  assert.throws(() => parseProjectManifest('{"kind":"service","build":{"dockerfile":"../x"}}'), /dockerfile/);
  assert.throws(() => parseProjectManifest('{"kind":"script","entry":"a.py","unknownKey":1}'), ProjectManifestError, 'unknown keys are refused — a typo must not silently mean the default');
  assert.throws(() => parseProjectManifest('{"env":{"1BAD":"x"}}'), /env/);

  const dir = mkdtempSync(join(tmpdir(), 'manifest-'));
  try {
    assert.throws(() => resolveProjectManifest(dir), (e: Error) => e instanceof ProjectManifestError && e.message === PROJECT_NO_MANIFEST);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { next: '15.0.0', react: '19' }, scripts: { build: 'next build', start: 'next start' } }));
    assert.equal(dependsOnNext(dir), true);
    let m = resolveProjectManifest(dir);
    assert.equal(m.kind, 'nextjs'); assert.equal(m.detected, 'package.json'); assert.equal(m.port, 3000); assert.equal(m.healthcheck, '/');
    writeFileSync(join(dir, 'ainize.json'), JSON.stringify({ name: 'site', port: 4000, healthcheck: '/api/health' }));
    m = resolveProjectManifest(dir);
    assert.equal(m.kind, 'nextjs', 'no kind + next dependency is still nextjs'); assert.equal(m.port, 4000); assert.equal(m.healthcheck, '/api/health'); assert.equal(m.name, 'site');
    writeFileSync(join(dir, 'ainize.json'), JSON.stringify({ kind: 'service' }));
    m = resolveProjectManifest(dir);
    assert.equal(m.kind, 'service'); assert.equal(m.port, 8080); assert.deepEqual(m.build, { dockerfile: 'Dockerfile', context: '.' });
    writeFileSync(join(dir, 'ainize.json'), JSON.stringify({ kind: 'script' }));
    assert.throws(() => resolveProjectManifest(dir), /names its "entry"/);
    assert.equal(resolveProjectManifest(dir, { entry: 'main.py' }).entry, 'main.py', 'the project row\'s entry is the fallback');
    writeFileSync(join(dir, 'ainize.json'), JSON.stringify({ kind: 'script', entry: 'run.sh' }));
    assert.throws(() => resolveProjectManifest(dir), /runtime/);
    rmSync(join(dir, 'package.json'));
    writeFileSync(join(dir, 'ainize.json'), JSON.stringify({ name: 'x' }));
    assert.throws(() => resolveProjectManifest(dir), /no "kind"/);
    assert.match(nextjsDockerfile(3000), /FROM node:20-alpine[\s\S]*npm run build[\s\S]*PORT=3000/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an agent repository becomes a hosted-agent spec; ainize.json\'s agent block wins over agent.json', () => {
  assert.equal(projectAgentId('Comcom', 'Art Search!'), 'prj-comcom-art-search');
  assert.ok(projectAgentId('x'.repeat(30), 'y'.repeat(30)).length <= 40);
  const dir = mkdtempSync(join(tmpdir(), 'agent-repo-'));
  try {
    writeFileSync(join(dir, 'agent.json'), JSON.stringify({ name: 'From agent.json', model: 'm1', description: 'd' }));
    writeFileSync(join(dir, 'prompt.md'), 'Be brief.');
    const m = { kind: 'agent' as const, detected: 'ainize.json' as const, env: {}, build: { dockerfile: 'Dockerfile', context: '.' }, port: 8080, healthcheck: '/', agent: { name: 'Overridden', a2ui: true } };
    const spec = projectAgentSpecOf(dir, 'prj-o-r', m);
    assert.equal(spec.name, 'Overridden'); assert.equal(spec.model, 'm1'); assert.equal(spec.systemPrompt, 'Be brief.'); assert.equal(spec.a2ui, true); assert.equal(spec.mode, 'prompt');
    mkdirSync(join(dir, 'files'));
    writeFileSync(join(dir, 'files', 'index.mjs'), 'export default {}');
    assert.equal(projectAgentSpecOf(dir, 'prj-o-r', m).mode, 'handler', 'files/ makes it a code agent');
    writeFileSync(join(dir, 'agent.json'), JSON.stringify({ name: 'x', model: 'm1', owner: 'me' }));
    assert.throws(() => projectAgentSpecOf(dir, 'prj-o-r', m), /owner/);
    rmSync(join(dir, 'agent.json'));
    assert.throws(() => projectAgentSpecOf(dir, 'prj-o-r', { ...m, agent: {} }), /not a valid agent/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ───────────────────────────────────────────── create / read / list

test('creating a project needs a sign-in, a git URL and (for a script) an entry; the secret comes back once', async () => {
  assert.equal((await request(app).post('/api/projects').send({ repo: repoUrl(), kind: 'script', entry: 'main.py' })).status, 401);
  const bad = await request(app).post('/api/projects').set(as(ALICE)).send({ repo: 'https://aindrive.ainetwork.ai/comcom/nogit', kind: 'script', entry: 'main.py' });
  assert.equal(bad.status, 400);

  const res = await request(app).post('/api/projects').set(as(ALICE)).send({ repo: repoUrl(), deployToken: TOKEN });
  assert.equal(res.status, 201, res.text);
  assert.equal(res.body.org, 'testorg');
  assert.equal(res.body.repoName, 'demo');
  assert.equal(res.body.branch, 'main');
  assert.equal(res.body.kind, null, 'the kind is the repository\'s to say');
  assert.equal(res.body.status, 'idle');
  assert.equal(res.body.url, 'https://node.example/testorg/demo');
  assert.match(res.body.webhookSecret, /^whsec_[0-9a-f]{48}$/);
  assert.equal(res.body.hasDeployToken, true);
  project = res.body;

  const again = await request(app).get(`/api/projects/${project.id}`).set(as(ALICE));
  assert.equal(again.status, 200);
  assert.equal(again.body.webhookSecret, undefined, 'the secret is never read back');
  assert.equal(again.body.owner, ALICE);
  assert.equal(again.body.canManage, true);
  assert.equal(again.body.pageUrl, 'https://node.example/testorg/demo', 'the page is the GitHub-shaped address, like the repo\'s aindrive URL');
  // A project is an organization's repository: anyone reads its public view, and only the owner sees owner + hook address.
  const bobs = await request(app).get(`/api/projects/${project.id}`).set(as(BOB));
  assert.equal(bobs.status, 200);
  assert.equal(bobs.body.owner, undefined); assert.equal(bobs.body.hookUrl, undefined); assert.equal(bobs.body.canManage, false); assert.equal(bobs.body.canOperate, false);
  const anon = await request(app).get(`/api/projects/${project.id}`);
  assert.equal(anon.status, 200); assert.equal(anon.body.owner, undefined); assert.equal(anon.body.canManage, false);
  assert.equal((await request(app).get(`/api/projects/${project.id}/deployments`)).status, 200, 'deployments read without a session');
  assert.equal((await request(app).get('/api/projects/prj_nope')).status, 404);
  const mine = await request(app).get('/api/projects').set(as(ALICE));
  assert.deepEqual(mine.body.projects.map((p: { id: string }) => p.id), [project.id]);
  assert.deepEqual((await request(app).get('/api/projects').set(as(BOB))).body.projects, []);

  const dup = await request(app).post('/api/projects').set(as(BOB)).send({ repo: `${repoUrl()}.git`, kind: 'script', entry: 'main.py' });
  assert.equal(dup.status, 409, 'one repo+branch is one project');
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
  assert.equal(d.kind, 'script', 'the kind came from ainize.json');
  assert.equal(d.exitCode, 0);
  assert.ok(d.ms !== null && d.startedAt && d.finishedAt);
  assert.ok(authSeen.length > 0 && authSeen.every((h) => h === `Bearer ${TOKEN}`), `every git request carried the token: ${JSON.stringify(authSeen)}`);
  const run = runs[0]!;
  assert.equal(run.language, 'python');
  assert.equal(run.entry, 'main.py');
  assert.deepEqual(Object.keys(run.files).sort(), ['README.md', 'ainize.json', 'main.py'], '.git is not shipped');
  assert.equal(run.env.AINIZE_DECIDE_URL, undefined, 'the sandbox sets AINIZE_URL itself; nothing here names /api/decide');
  assert.equal(run.env.GREETING, 'hi', 'ainize.json env reaches the run');
  assert.equal(run.env.INPUT_DESC, 'a boat at dusk', 'an input default is INPUT_<NAME> on a push-deploy');
  assert.equal(run.env.INPUT_TOP_K, '5', 'a number default travels as text');
  assert.equal(run.env.INPUT_VERBOSE, 'false', 'a boolean default travels as true|false');
  assert.equal('INPUT_MODEL' in run.env, false, 'an input without a default sets nothing');
  assert.equal(run.env.AINIZE_COMMIT, sha1);

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
  assert.equal((await request(app).get(`/api/deployments/${d.id}`).set(as(BOB))).status, 200, 'a deployment reads like its project: by anyone');
  assert.equal((await request(app).get(`/api/deployments/${d.id}/log`)).status, 200, 'and so does its log');
  assert.equal(view.body.trigger, 'push');
  assert.equal(view.body.subject, 'v1', 'the commit subject is read after the clone');
  const p = (await request(app).get(`/api/projects/${project.id}`).set(as(ALICE))).body;
  assert.equal(p.status, 'ready');
  assert.equal(p.kind, 'script', 'the project row learns its kind from the deploy');
  assert.equal(p.manifest.kind, 'script'); assert.equal(p.manifest.entry, 'main.py');
  assert.deepEqual(p.manifest.examples, [{ name: '노을 바다 유화', inputs: { desc: '노을 바다 유화', TOP_K: 3 } }], 'the console reads examples from the newest deployment');
  assert.deepEqual(p.runnable, ['main.py'], 'the Run panel\'s entry choices');
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

test('a commit without ainize.json (and no next dependency) fails with "no ainize.json"', async () => {
  await git(work, ['rm', '-q', 'ainize.json']);
  const sha = await commit(work, 'main.py', 'print("no manifest")\n', 'drop manifest');
  const res = await push(sha);
  await worker.idle();
  const d = store.deployment(res.body.deploymentId)!;
  assert.equal(d.status, 'error');
  assert.equal(d.error, 'no ainize.json');
  assert.match(logs.read(d.id)!, /\[ainize\] error: no ainize\.json/);
  // put it back for the tests that follow
  writeFileSync(join(work, 'ainize.json'), JSON.stringify({ kind: 'script', entry: 'main.py' }));
  runBehaviour = async (req, on) => { runs.push(req); on({ event: 'stdout', data: 'v4\n' }); on({ event: 'exit', data: { code: 0, ms: 1 } }); };
  await push(await commit(work, 'main.py', 'print("v4")\n', 'v4'));
  await worker.idle();
  assert.equal(store.deploymentsOf(project.id)[0]!.status, 'ready');
});

test('a package.json that depends on next is a Next.js project without any ainize.json — refused here only for want of Docker', async () => {
  const nextRepo = join(tmp, 'next-work');
  mkdirSync(nextRepo);
  mkdirSync(join(repoRoot, 'site.git'), { recursive: true });
  await git(join(repoRoot, 'site.git'), ['init', '-q', '--bare', '--initial-branch=main']);
  await git(nextRepo, ['init', '-q', '--initial-branch=main']);
  await git(nextRepo, ['config', 'user.name', 'A']); await git(nextRepo, ['config', 'user.email', 'a@b.c']);
  await git(nextRepo, ['remote', 'add', 'origin', join(repoRoot, 'site.git')]);
  const sha = await commit(nextRepo, 'package.json', JSON.stringify({ name: 'site', dependencies: { next: '15.0.0' }, scripts: { build: 'next build', start: 'next start' } }), 'site');
  const created = await request(app).post('/api/projects').set(as(ALICE)).send({ repo: `${aindriveBase}/testorg/git/site`, deployToken: TOKEN });
  assert.equal(created.status, 201);
  const raw = JSON.stringify({ ref: 'refs/heads/main', after: sha });
  const res = await request(app).post(`/api/projects/${created.body.id}/hook`).set('content-type', 'application/json').set('x-ainize-signature', signHook(created.body.webhookSecret, raw)).send(raw);
  await worker.idle();
  const d = store.deployment(res.body.deploymentId)!;
  assert.equal(d.kind, 'nextjs', 'detected from package.json');
  assert.equal(d.status, 'error');
  assert.match(d.error!, /Docker is not enabled/);
  assert.match(logs.read(d.id)!, /nextjs \(no ainize\.json; package\.json depends on next\)/);
});

test('kind: agent deploys the repository as a hosted agent reachable over A2A, and a second push is a new version of the same agent', async () => {
  const agentRepo = join(tmp, 'agent-work');
  mkdirSync(agentRepo);
  mkdirSync(join(repoRoot, 'helper.git'), { recursive: true });
  await git(join(repoRoot, 'helper.git'), ['init', '-q', '--bare', '--initial-branch=main']);
  await git(agentRepo, ['init', '-q', '--initial-branch=main']);
  await git(agentRepo, ['config', 'user.name', 'A']); await git(agentRepo, ['config', 'user.email', 'a@b.c']);
  await git(agentRepo, ['remote', 'add', 'origin', join(repoRoot, 'helper.git')]);
  writeFileSync(join(agentRepo, 'ainize.json'), JSON.stringify({ kind: 'agent', agent: { name: 'Helper', description: 'Answers briefly', model: MODEL } }));
  const sha = await commit(agentRepo, 'prompt.md', 'Be brief.', 'agent v1');
  const created = await request(app).post('/api/projects').set(as(ALICE)).send({ repo: `${aindriveBase}/testorg/git/helper`, deployToken: TOKEN });
  assert.equal(created.status, 201);
  const hookIt = async (after: string) => {
    const raw = JSON.stringify({ ref: 'refs/heads/main', after });
    const r = await request(app).post(`/api/projects/${created.body.id}/hook`).set('content-type', 'application/json').set('x-ainize-signature', signHook(created.body.webhookSecret, raw)).send(raw);
    await worker.idle();
    return store.deployment(r.body.deploymentId)!;
  };
  const d = await hookIt(sha);
  assert.equal(d.status, 'ready', logs.read(d.id) ?? '');
  assert.equal(d.kind, 'agent');
  const agentId = projectAgentId('testorg', 'helper');
  assert.equal(d.outputUrl, `https://node.example/agents/${agentId}`);
  const spec = hostedStore.get(agentId)!;
  assert.equal(spec.owner, ALICE); assert.equal(spec.version, 1); assert.equal(spec.systemPrompt, 'Be brief.'); assert.equal(spec.name, 'Helper');
  assert.deepEqual(applied, [`create ${agentId} v1`]);

  const card = await request(app).get(`/agents/${agentId}/.well-known/agent-card.json`);
  assert.equal(card.status, 200, card.text);
  assert.equal(card.body.name, 'Helper');
  const reply = await request(app).post(`/agents/${agentId}`).set('content-type', 'application/json').send({
    jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { kind: 'message', role: 'user', messageId: 'm1', parts: [{ kind: 'text', text: 'hello there' }] } },
  });
  assert.equal(reply.status, 200, reply.text);
  assert.ok(reply.body.result, JSON.stringify(reply.body));
  assert.match(reply.body.result.parts[0].text, /^\[Test-Chat-1\] sys=Be brief\. \| you said: hello there$/);

  const sha2 = await commit(agentRepo, 'prompt.md', 'Be very brief.', 'agent v2');
  const d2 = await hookIt(sha2);
  assert.equal(d2.status, 'ready', logs.read(d2.id) ?? '');
  assert.equal(hostedStore.get(agentId)!.version, 2);
  assert.equal(hostedStore.get(agentId)!.systemPrompt, 'Be very brief.');
  assert.deepEqual(applied.at(-1), `update ${agentId} v2`);
  const again = await request(app).post(`/agents/${agentId}`).set('content-type', 'application/json').send({
    jsonrpc: '2.0', id: 2, method: 'message/send', params: { message: { kind: 'message', role: 'user', messageId: 'm2', parts: [{ kind: 'text', text: 'again' }] } },
  });
  assert.match(again.body.result.parts[0].text, /sys=Be very brief\./, 'the new version answers at the same address');

  // another account's push to a repo that maps onto the same agent id cannot take it over
  const bobDir = join(tmp, 'bob-work');
  mkdirSync(bobDir);
  mkdirSync(join(repoRoot, 'helper2.git'), { recursive: true });
  await git(join(repoRoot, 'helper2.git'), ['init', '-q', '--bare', '--initial-branch=main']);
  await git(bobDir, ['init', '-q', '--initial-branch=main']);
  await git(bobDir, ['config', 'user.name', 'B']); await git(bobDir, ['config', 'user.email', 'b@b.c']);
  await git(bobDir, ['remote', 'add', 'origin', join(repoRoot, 'helper2.git')]);
  writeFileSync(join(bobDir, 'ainize.json'), JSON.stringify({ kind: 'agent', agent: { model: MODEL } }));
  const shaB = await commit(bobDir, 'prompt.md', 'x', 'b');
  const bobProject = await request(app).post('/api/projects').set(as(BOB)).send({ repo: `${aindriveBase}/testorg/git/helper2`, deployToken: TOKEN });
  const rawB = JSON.stringify({ ref: 'refs/heads/main', after: shaB });
  const rB = await request(app).post(`/api/projects/${bobProject.body.id}/hook`).set('content-type', 'application/json').set('x-ainize-signature', signHook(bobProject.body.webhookSecret, rawB)).send(rawB);
  await worker.idle();
  const dB = store.deployment(rB.body.deploymentId)!;
  assert.equal(dB.status, 'ready', 'a different repo name is a different agent id');
  assert.equal(dB.outputUrl, `https://node.example/agents/${projectAgentId('testorg', 'helper2')}`);
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
  assert.equal(res.body.status, 'ready');
  assert.equal(res.body.lastDeployment.status, 'ready');
  assert.equal(res.body.kind, 'script');
  assert.equal(res.body.pageUrl, 'https://node.example/testorg/demo', 'what aindrive\'s "Inspect" links to: /<org>/<repo>');
  assert.equal(res.body.owner, undefined);
  assert.equal(res.headers['access-control-allow-origin'], 'https://aindrive.ainetwork.ai');
  const other = await request(app).get('/api/projects/by-repo').query({ repo: repoUrl() }).set('origin', 'https://evil.example');
  assert.equal(other.headers['access-control-allow-origin'], undefined);
  assert.equal((await request(app).get('/api/projects/by-repo').query({ repo: 'https://aindrive.ainetwork.ai/x/git/y' })).status, 404);
  const pre = await request(app).options(`/api/projects/${project.id}/hook`).set('origin', 'https://aindrive.ainetwork.ai').set('access-control-request-method', 'POST');
  assert.equal(pre.status, 204);
  assert.match(pre.headers['access-control-allow-headers'], /X-Ainize-Signature/);
});

// ───────────────────────────────────────────── by-name, the org page, runs, redeploy, rotate

test('by-name finds /<org>/<repo> case-insensitively, and the org listing shows every project of a slug', async () => {
  const res = await request(app).get('/api/projects/by-name').query({ org: 'TestOrg', repo: 'DEMO' }).set('origin', 'https://aindrive.ainetwork.ai');
  assert.equal(res.status, 200);
  assert.equal(res.body.id, project.id, 'the first-bound project of the repo, as by-repo answers');
  assert.equal(res.body.pageUrl, 'https://node.example/testorg/demo');
  assert.equal(res.body.owner, undefined, 'anonymous: the public view');
  assert.equal(res.headers['access-control-allow-origin'], 'https://aindrive.ainetwork.ai');
  assert.equal((await request(app).get('/api/projects/by-name').query({ org: 'testorg', repo: 'nope' })).body.error.code, 'not_found');
  assert.equal((await request(app).get('/api/projects/by-name').query({ org: 'testorg' })).status, 400);
  const mine = await request(app).get('/api/projects/by-name').query({ org: 'testorg', repo: 'demo' }).set(as(ALICE));
  assert.equal(mine.body.owner, ALICE, 'the owner gets the owner\'s view through by-name too');

  const org = await request(app).get('/api/orgs/TESTORG/projects');
  assert.equal(org.status, 200);
  assert.ok(org.body.projects.some((p: { id: string }) => p.id === project.id), 'the slug\'s projects include this one');
  assert.ok(org.body.projects.every((p: { org: string; owner?: string }) => p.org === 'testorg' && p.owner === undefined), 'all of the org, none with an owner');
  assert.deepEqual((await request(app).get('/api/orgs/nobody-here/projects')).body, { org: 'nobody-here', projects: [] }, 'an unknown org is an empty list, not 404');
  assert.equal((await request(app).get('/api/orgs/%2Fetc/projects')).status, 404, 'a malformed slug is 404');
});

test('the org repositories listing is read from aindrive with the machine token and cached', async () => {
  repoListingAuth.length = 0;
  const res = await request(app).get('/api/orgs/testorg/repositories');
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.known, true);
  assert.equal(res.body.driveId, 'drv1');
  assert.deepEqual(res.body.repositories.map((r: { name: string }) => r.name), ['demo', 'unbound']);
  assert.deepEqual(repoListingAuth, ['Bearer machine-token']);
  const again = await request(app).get('/api/orgs/TESTORG/repositories');
  assert.equal(again.headers['x-cache'], 'hit');
  assert.equal(repoListingAuth.length, 1, 'cached: aindrive was not asked again');
  const unknown = await request(app).get('/api/orgs/elsewhere/repositories');
  assert.deepEqual(unknown.body, { org: 'elsewhere', repositories: [], known: false }, 'aindrive\'s 404 is an empty, unknown org');
});

test('an ad-hoc run clones HEAD with the person\'s inputs and entry; owner or org member only; runs are not deployments', async () => {
  assert.equal((await request(app).post(`/api/projects/${project.id}/runs`).send({})).status, 401);
  const refused = await request(app).post(`/api/projects/${project.id}/runs`).set(as(BOB)).send({});
  assert.equal(refused.status, 403); assert.equal(refused.body.error.code, 'not_member');
  assert.equal((await request(app).post(`/api/projects/${project.id}/runs`).set(as(ALICE)).send({ inputs: { 'bad name': 'x' } })).status, 400);
  const before = store.deploymentsOf(project.id).length;
  runs.length = 0;
  const res = await request(app).post(`/api/projects/${project.id}/runs`).set(as(CAROL)).send({ inputs: { desc: '노을 바다 유화', TOP_K: 3, verbose: true }, env: { EXTRA: 'yes' } });
  assert.equal(res.status, 202, res.text);
  assert.match(res.body.runId, /^run_/);
  await worker.idle();
  const run = store.deployment(res.body.runId)!;
  assert.equal(run.status, 'ready', JSON.stringify(run));
  assert.equal(run.trigger, 'run');
  assert.equal(run.sha, await git(work, ['rev-parse', 'HEAD']), 'HEAD of the branch, filled in after the clone');
  assert.deepEqual(run.pusher, { subject: CAROL });
  const r = runs[0]!;
  assert.equal(r.entry, 'main.py', 'the manifest\'s entry when none is given');
  assert.equal(r.env.INPUT_DESC, '노을 바다 유화'); assert.equal(r.env.INPUT_TOP_K, '3'); assert.equal(r.env.INPUT_VERBOSE, 'true'); assert.equal(r.env.EXTRA, 'yes');
  assert.equal(store.deploymentsOf(project.id).length, before, 'a run is not a deployment');
  assert.equal(store.get(project.id)!.lastDeploymentId !== run.id, true, 'and never the project\'s status');
  const list = await request(app).get(`/api/projects/${project.id}/runs`);
  assert.equal(list.body.runs[0].id, run.id);
  assert.deepEqual(list.body.runs[0].inputs, { desc: '노을 바다 유화', TOP_K: '3', verbose: 'true' });
  assert.equal((await request(app).get(`/api/projects/${project.id}/deployments`)).body.deployments.some((d: { id: string }) => d.id === run.id), false);
  // Another entry: a file that is not in the repository ends in error, cleanly.
  const missing = await request(app).post(`/api/projects/${project.id}/runs`).set(as(ALICE)).send({ entry: 'other.py' });
  await worker.idle();
  assert.equal(store.deployment(missing.body.runId)!.status, 'error');
  assert.match(store.deployment(missing.body.runId)!.error!, /other\.py/);
});

test('redeploy starts the same commit again as a new deployment, and rotate-secret retires the old webhook secret', async () => {
  const latest = store.deploymentsOf(project.id)[0]!;
  assert.equal((await request(app).post(`/api/deployments/${latest.id}/redeploy`)).status, 401);
  assert.equal((await request(app).post(`/api/deployments/${latest.id}/redeploy`).set(as(BOB))).status, 403);
  const res = await request(app).post(`/api/deployments/${latest.id}/redeploy`).set(as(ALICE));
  assert.equal(res.status, 202, res.text);
  await worker.idle();
  const d = store.deployment(res.body.deploymentId)!;
  assert.equal(d.trigger, 'redeploy'); assert.equal(d.sha, latest.sha); assert.equal(d.status, 'ready');
  assert.deepEqual(d.pusher, { subject: ALICE });
  assert.equal(store.get(project.id)!.lastDeploymentId, d.id, 'a redeploy IS the project\'s newest deployment');
  assert.equal((await request(app).post('/api/deployments/dep_nope/redeploy').set(as(ALICE))).status, 404);

  assert.equal((await request(app).patch(`/api/projects/${project.id}/rotate-secret`).set(as(BOB))).status, 404, 'not the owner: not confirmed to exist');
  const rotated = await request(app).patch(`/api/projects/${project.id}/rotate-secret`).set(as(ALICE));
  assert.equal(rotated.status, 200);
  assert.match(rotated.body.webhookSecret, /^whsec_[0-9a-f]{48}$/);
  assert.notEqual(rotated.body.webhookSecret, project.webhookSecret);
  assert.equal((await hook({ ref: 'refs/heads/main', after: sha1 }, project.webhookSecret)).status, 401, 'the old secret is dead');
  project.webhookSecret = rotated.body.webhookSecret;
  assert.equal((await hook({ ref: 'refs/heads/feature', after: sha1 })).status, 202, 'the new one works');
});

test('manifest examples are checked against the inputs they answer', () => {
  assert.throws(() => resolveProjectManifest(writeManifest({ kind: 'script', entry: 'a.py', inputs: { q: {} }, examples: [{ name: 'x', inputs: { nope: '1' } }] })), /examples\."x" answers an input that does not exist: nope/);
  const ok = resolveProjectManifest(writeManifest({ kind: 'script', entry: 'a.py', inputs: { q: {} }, examples: [{ name: 'x', inputs: { q: 'hello' } }] }));
  assert.deepEqual(ok.examples, [{ name: 'x', inputs: { q: 'hello' } }]);
  assert.deepEqual(resolveProjectManifest(writeManifest({ kind: 'script', entry: 'a.py' })).examples, []);
});
const writeManifest = (m: unknown): string => { const dir = mkdtempSync(join(tmp, 'm-')); writeFileSync(join(dir, 'ainize.json'), JSON.stringify(m)); return dir; };

// ───────────────────────────────────────────── retention + delete

test('a project keeps its newest deployments, and removing it takes its deployments, logs and secrets', async () => {
  const small = new ProjectStore(join(tmp, 'small.json'));
  const p = small.create({ repo: parseRepoUrl('https://aindrive.ainetwork.ai/o/git/r')!, branch: 'main', kind: null, entry: 'a.py' }, ALICE);
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

test('a project that became a service can still run a selected historical script commit', async () => {
  const bare = join(repoRoot, 'transition.git');
  await git(tmp, ['clone', '--quiet', '--bare', join(repoRoot, 'demo.git'), bare]);
  const source = join(tmp, 'transition-work');
  await git(tmp, ['clone', '--quiet', bare, source]);
  await git(source, ['config', 'user.name', 'Transition author']);
  await git(source, ['config', 'user.email', 'transition@example.com']);
  const serviceSha = await commit(source, 'ainize.json', JSON.stringify({ kind: 'service', port: 8080, healthcheck: '/health' }), 'Become a service');
  const made = await request(app).post('/api/projects').set(as(ALICE)).send({ repo: `${aindriveBase}/testorg/git/transition`, kind: 'service', deployToken: TOKEN });
  assert.equal(made.status, 201, made.text);
  const id = made.body.id as string;
  assert.equal((await request(app).post(`/api/projects/${id}/runs`).set(as(ALICE)).send({ target: 'head' })).status, 409);
  const selected = await request(app).post(`/api/projects/${id}/runs`).set(as(ALICE)).send({ target: 'commit', sha: sha1 });
  assert.equal(selected.status, 202, selected.text);
  await worker.idle();
  const run = store.deployment(selected.body.runId)!;
  assert.equal(run.status, 'ready', JSON.stringify(run));
  assert.equal(run.sha, sha1);
  assert.equal(run.kind, 'script');
  assert.equal(store.get(id)?.kind, 'service', 'historical runs never change the project kind');
  assert.equal(store.get(id)?.activeCommit, null, 'a historical run never becomes the deployed runtime');
  const service = await request(app).post(`/api/projects/${id}/runs`).set(as(ALICE)).send({ target: 'commit', sha: serviceSha });
  assert.equal(service.status, 202);
  await worker.idle();
  assert.equal(store.deployment(service.body.runId)?.status, 'error');
  assert.match(store.deployment(service.body.runId)?.error ?? '', /service project is deployed by a push/);
  assert.equal(store.get(id)?.activeCommit, null, 'a commit selector cannot deploy or run a service as a script');
});
