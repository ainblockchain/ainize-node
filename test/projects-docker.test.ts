/**
 * Project containers, for real: `kind: service` from the repo's Dockerfile and `kind: nextjs` from the node's,
 * on the hosted-agent internal network behind the gateway, proxied at `/svc/<projectId>/…`, swapped without a gap
 * on the next push. Skips without a Docker daemon, or when a container on an internal network cannot reach the
 * host (the same probe as run-api-docker.test.ts; the CI network env is honoured the same way).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import express, { type Request } from 'express';
import request from 'supertest';
import { HostedAgentDocker, hostedAgentDockerAvailable, hostedAgentDockerExec } from '../src/hosted-agent-docker.js';
import { HostedAgentGateway } from '../src/hosted-agent-gateway.js';
import { HostedAgentSecretStore } from '../src/hosted-agent-secrets.js';
import { InferenceBackendRegistry } from '../src/inference-backends.js';
import { ProjectContainers, PROJECT_CONTAINER_DEFAULTS, projectContainerName } from '../src/project-containers.js';
import { projectRoutes } from '../src/project-routes.js';
import { DeploymentLogs, ProjectStore, ProjectWorker, signHook } from '../src/projects.js';
import { principalCaller } from '../src/shared-agents.js';

const exec = promisify(execFile);
const git = async (dir: string, args: string[]) => (await exec('git', ['-C', dir, ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout.trim();
const hasDocker = await hostedAgentDockerAvailable();

async function dockerInternalNetReachesHost(): Promise<boolean> {
  if (!hasDocker) return false;
  const net = process.env.AINIZE_CI_DOCKER_NETWORK || 'ainize-hosted-agents';
  const fixedPort = process.env.AINIZE_CI_DOCKER_NETWORK ? Number(process.env.AINIZE_CI_DOCKER_GATEWAY_PORT) : 0;
  try {
    if (!process.env.AINIZE_CI_DOCKER_NETWORK) await hostedAgentDockerExec(['network', 'create', '--internal', '--label', 'ainize.hosted-agents=1', net]).catch(() => undefined);
    const gw = (await hostedAgentDockerExec(['network', 'inspect', net, '--format', '{{(index .IPAM.Config 0).Gateway}}'])).stdout.trim();
    if (!gw) return false;
    const srv = createServer((_req, res) => res.end('ok'));
    for (const until = Date.now() + 60_000; ; ) {
      try { await new Promise<void>((r, j) => { srv.once('error', j); srv.listen(fixedPort, gw, () => r()); }); break; }
      catch (e) { if (Date.now() > until || (e as { code?: string }).code !== 'EADDRINUSE') return false; await new Promise((r) => setTimeout(r, 1000)); }
    }
    const port = (srv.address() as AddressInfo).port;
    try {
      const r = await hostedAgentDockerExec(['run', '--rm', '--network', net, 'alpine:latest', 'sh', '-c', `wget -q -T 4 -O - http://${gw}:${port}/ || echo UNREACHABLE`], 30_000);
      return r.stdout.includes('ok') && !r.stdout.includes('UNREACHABLE');
    } finally { srv.close(); }
  } catch { return false; }
}
const skip = !hasDocker ? 'no docker daemon' : !(await dockerInternalNetReachesHost()) ? 'docker internal network cannot reach the host gateway in this environment' : false;

const TOKEN = 'aind_aat_docker_test';
const ALICE = 'sso:alice';

/** aindrive's side (as in projects.test.ts): git http-backend behind a bearer check. */
function fakeAindrive(repoRoot: string): express.Express {
  const srv = express();
  srv.all(/^\/o\/git\/([A-Za-z0-9_-]+)(?:\.git)?(\/.*)?$/, (req, res) => {
    if (req.header('authorization') !== `Bearer ${TOKEN}`) { res.status(401).end(); return; }
    const [, name, rest = ''] = req.path.match(/^\/o\/git\/([A-Za-z0-9_-]+)(?:\.git)?(\/.*)?$/)!;
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, GIT_PROJECT_ROOT: repoRoot, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: `/${name}.git${rest}`, REQUEST_METHOD: req.method,
      QUERY_STRING: req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?') + 1) : '', CONTENT_TYPE: req.header('content-type') ?? '',
      CONTENT_LENGTH: req.header('content-length') ?? '', REMOTE_ADDR: '127.0.0.1', ...(req.header('git-protocol') ? { GIT_PROTOCOL: req.header('git-protocol')! } : {}),
    };
    const child = spawn('git', ['http-backend'], { env });
    let header = Buffer.alloc(0); let done = false;
    child.stdout.on('data', (chunk: Buffer) => {
      if (done) { res.write(chunk); return; }
      header = Buffer.concat([header, chunk]);
      const at = header.indexOf('\r\n\r\n');
      if (at === -1) return;
      for (const line of header.subarray(0, at).toString('utf8').split('\r\n')) {
        const i = line.indexOf(':'); if (i === -1) continue;
        const k = line.slice(0, i).trim(); const v = line.slice(i + 1).trim();
        if (k.toLowerCase() === 'status') res.status(parseInt(v, 10) || 200); else res.setHeader(k, v);
      }
      done = true; const body = header.subarray(at + 4); if (body.length) res.write(body);
    });
    child.on('close', () => res.end());
    req.pipe(child.stdin);
  });
  return srv;
}

test('service and Next.js projects build, run behind the gateway, answer through /svc, and swap without a gap', { skip, timeout: 1_500_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'projects-docker-'));
  const network = process.env.AINIZE_CI_DOCKER_NETWORK || `ainize-projects-test-${process.pid}`;
  const gatewayPort = process.env.AINIZE_CI_DOCKER_GATEWAY_PORT ? Number(process.env.AINIZE_CI_DOCKER_GATEWAY_PORT) : 0;
  const repoRoot = join(tmp, 'drives');
  mkdirSync(repoRoot);
  const aindrive: Server = fakeAindrive(repoRoot).listen(0, '127.0.0.1');
  await new Promise((r) => aindrive.once('listening', r));
  const aindriveBase = `http://127.0.0.1:${(aindrive.address() as AddressInfo).port}`;

  const logLines: string[] = [];
  const registry = new InferenceBackendRegistry([]);
  const gateway = new HostedAgentGateway({ registry: () => registry, spec: () => null, log: (m) => logLines.push(m) });
  const docker = new HostedAgentDocker({ memory: '512m', cpus: 1, pidsLimit: 256, network, buildTimeoutMs: 600_000, workDir: join(tmp, 'hosted'), runtimeImage: 'unused' });
  let gatewayUrl: string | null = null;
  for (const until = Date.now() + 120_000; ; ) {
    try { gatewayUrl = await gateway.listen(await docker.ensureNetwork(), gatewayPort); break; }
    catch (e) { if (Date.now() > until) throw e; await new Promise((r) => setTimeout(r, 1000)); }
  }
  const containers = new ProjectContainers({
    network, gateway, gatewayUrl: () => gatewayUrl, selfUrl: () => 'http://127.0.0.1:1', publicUrl: () => 'https://node.example',
    workDir: join(tmp, 'work'), ...PROJECT_CONTAINER_DEFAULTS, healthTimeoutMs: 30_000, log: (level, m) => logLines.push(`${level} ${m}`),
  });
  const store = new ProjectStore(join(tmp, 'projects.json'));
  const secrets = new HostedAgentSecretStore(join(tmp, 'secrets.json'), join(tmp, 'secrets.key'));
  const logs = new DeploymentLogs(join(tmp, 'logs'));
  const worker = new ProjectWorker({
    store, logs, containers, run: async (_r, on) => on({ event: 'exit', data: { code: 0, ms: 0 } }),
    deployToken: (id) => secrets.reveal(id, ['deployToken']).deployToken ?? null, publicUrl: () => 'https://node.example',
  });
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as Request & { rawBody?: Buffer }).rawBody = buf; } }));
  app.use(projectRoutes({ store, secrets, logs, worker, containers, caller: (req) => (req.header('x-test-user') ? principalCaller(req.header('x-test-user')!) : null), publicBase: () => 'https://node.example' }));

  const newRepo = async (name: string) => {
    mkdirSync(join(repoRoot, `${name}.git`));
    await git(join(repoRoot, `${name}.git`), ['init', '-q', '--bare', '--initial-branch=main']);
    const w = join(tmp, `${name}-work`);
    mkdirSync(w);
    await git(w, ['init', '-q', '--initial-branch=main']);
    await git(w, ['config', 'user.name', 'A']); await git(w, ['config', 'user.email', 'a@b.c']);
    await git(w, ['remote', 'add', 'origin', join(repoRoot, `${name}.git`)]);
    return w;
  };
  const commit = async (w: string, files: Record<string, string>, message: string) => {
    for (const [f, c] of Object.entries(files)) { mkdirSync(join(w, f, '..'), { recursive: true }); writeFileSync(join(w, f), c); }
    await git(w, ['add', '-A']); await git(w, ['commit', '-q', '-m', message]); await git(w, ['push', '-q', 'origin', 'HEAD:main']);
    return git(w, ['rev-parse', 'HEAD']);
  };
  const createProject = async (name: string) => {
    const r = await request(app).post('/api/projects').set('x-test-user', ALICE).send({ repo: `${aindriveBase}/o/git/${name}`, deployToken: TOKEN });
    assert.equal(r.status, 201, r.text);
    return r.body as { id: string; webhookSecret: string };
  };
  const push = async (p: { id: string; webhookSecret: string }, sha: string) => {
    const raw = JSON.stringify({ ref: 'refs/heads/main', after: sha, pusher: { subject: ALICE } });
    const r = await request(app).post(`/api/projects/${p.id}/hook`).set('content-type', 'application/json').set('x-ainize-signature', signHook(p.webhookSecret, raw)).send(raw);
    assert.equal(r.status, 202, r.text);
    await worker.idle();
    return store.deployment(r.body.deploymentId as string)!;
  };

  try {
    await t.test('kind: service — a Dockerfile serving python http.server, then a second push replaces it with no gap', async () => {
      const w = await newRepo('svc');
      const dockerfile = 'FROM python:3.11-alpine\nWORKDIR /site\nCOPY site/ /site/\nEXPOSE 8080\nCMD ["python3", "-m", "http.server", "8080"]\n';
      const sha1 = await commit(w, { Dockerfile: dockerfile, 'ainize.json': JSON.stringify({ kind: 'service', port: 8080, healthcheck: '/index.html' }), 'site/index.html': '<h1>v1</h1>' }, 'v1');
      const p = await createProject('svc');
      const d1 = await push(p, sha1);
      assert.equal(d1.status, 'ready', logs.read(d1.id) ?? '');
      assert.equal(d1.kind, 'service');
      assert.equal(d1.outputUrl, `https://node.example/svc/${p.id}/`);
      assert.match(logs.read(d1.id)!, /\[build\] /, 'the build output is in the log');
      assert.match(logs.read(d1.id)!, /\[ainize\] healthy/);
      const c1 = containers.current(p.id)!;
      assert.equal(c1.name, projectContainerName(p.id, sha1));
      const v1 = await request(app).get(`/svc/${p.id}/index.html`);
      assert.equal(v1.status, 200, v1.text);
      assert.equal(v1.text, '<h1>v1</h1>');
      assert.equal((await request(app).get(`/svc/${p.id}/nope.html`)).status, 404, 'the container\'s own status passes through');

      // v2: the new container comes up beside v1; v1 goes only once v2 is healthy
      const sha2 = await commit(w, { 'site/index.html': '<h1>v2</h1>' }, 'v2');
      const d2 = await push(p, sha2);
      assert.equal(d2.status, 'ready', logs.read(d2.id) ?? '');
      assert.equal((await request(app).get(`/svc/${p.id}/index.html`)).text, '<h1>v2</h1>');
      assert.match(logs.read(d2.id)!, new RegExp(`replacing ${c1.name}`));
      const ps = (await hostedAgentDockerExec(['ps', '-a', '--format', '{{.Names}}', '--filter', 'label=ainize.project'])).stdout;
      assert.ok(!ps.includes(c1.name), `v1 is gone: ${ps}`);
      assert.ok(ps.includes(projectContainerName(p.id, sha2)));

      // v3 fails its healthcheck: v2 keeps serving
      const sha3 = await commit(w, { 'ainize.json': JSON.stringify({ kind: 'service', port: 8080, healthcheck: '/missing.html' }) }, 'v3 broken');
      const d3 = await push(p, sha3);
      assert.equal(d3.status, 'error', logs.read(d3.id) ?? '');
      assert.match(d3.error!, /healthcheck \/missing\.html failed/);
      assert.equal((await request(app).get(`/svc/${p.id}/index.html`)).text, '<h1>v2</h1>', 'the old container still serves');
      assert.equal(containers.current(p.id)!.sha, sha2);
      const after = (await hostedAgentDockerExec(['ps', '-a', '--format', '{{.Names}}', '--filter', 'label=ainize.project'])).stdout;
      assert.ok(!after.includes(projectContainerName(p.id, sha3)), 'the failed container was removed');

      await containers.stop(p.id);
      assert.equal((await request(app).get(`/svc/${p.id}/`)).status, 404);
    });

    await t.test('kind: nextjs — detected from package.json, built with the node\'s Dockerfile, served on 3000', async () => {
      const w = await newRepo('site');
      const sha = await commit(w, {
        'package.json': JSON.stringify({ name: 'site', private: true, scripts: { build: 'next build', start: 'next start' }, dependencies: { next: '15.5.4', react: '19.1.0', 'react-dom': '19.1.0' } }),
        'next.config.mjs': 'export default { output: undefined };\n',
        'app/layout.js': 'export default function L({ children }) { return <html><body>{children}</body></html>; }\n',
        'app/page.js': 'export default function P() { return <main>hello from next</main>; }\n',
        'app/api/health/route.js': 'export function GET() { return Response.json({ ok: true }); }\n',
        'ainize.json': JSON.stringify({ healthcheck: '/api/health' }),
      }, 'site');
      const p = await createProject('site');
      const d = await push(p, sha);
      assert.equal(d.status, 'ready', (logs.read(d.id) ?? '').slice(-6000));
      assert.equal(d.kind, 'nextjs');
      assert.match(logs.read(d.id)!, /no Dockerfile — building Next\.js/);
      const page = await request(app).get(`/svc/${p.id}/`);
      assert.equal(page.status, 200, page.text.slice(0, 300));
      assert.match(page.text, /hello from next/);
      const health = await request(app).get(`/svc/${p.id}/api/health`);
      assert.deepEqual(health.body, { ok: true });
      await containers.stop(p.id);
    });
  } finally {
    worker.stop();
    await containers.stopAll();
    await gateway.close();
    aindrive.close();
    if (!process.env.AINIZE_CI_DOCKER_NETWORK) await hostedAgentDockerExec(['network', 'rm', network]).catch(() => undefined);
    rmSync(tmp, { recursive: true, force: true });
  }
});
