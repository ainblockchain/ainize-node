/**
 * `POST /api/run`, for real: the runner images, a container on the internal network, the gateway on the bridge,
 * a script that calls /api/decide and gets its answer through this node. Skipped when this machine has no Docker
 * daemon, or when a container on an internal network cannot reach the host (see hosted-agents-docker.test.ts).
 *
 * What it proves: the fixture aindrive will run (art_search.py) prints its ranking and exits 0 with the stub
 * decision backend answering through the node's own /api/decide; a run has no route to the internet and the
 * proxy refuses hosts it was not allowed; a run that outlives timeoutMs is killed with exit 124; a third run per
 * caller is a 429; the rootfs is read-only and /work is the only writable place; the node runtime works too.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';
import { InferenceBackendRegistry } from '../src/inference-backends.js';
import { ModalityGate } from '../src/modality-gate.js';
import { freeTierRouter } from '../src/free-tier-routes.js';
import { HostedAgentGateway } from '../src/hosted-agent-gateway.js';
import { HostedAgentDocker, hostedAgentDockerAvailable, hostedAgentDockerExec } from '../src/hosted-agent-docker.js';
import { RunSandbox, RUN_SANDBOX_DEFAULTS, RUN_TIMEOUT_EXIT_CODE } from '../src/run-sandbox.js';
import { runRouter } from '../src/run-routes.js';

const hasDocker = await hostedAgentDockerAvailable();

async function dockerInternalNetReachesHost(): Promise<boolean> {
  if (!hasDocker) return false;
  // On a CI host whose firewall admits only one bridge port, probe that network and port (deploy/README.md).
  const net = process.env.AINIZE_CI_DOCKER_NETWORK || 'ainize-hosted-agents';
  const fixedPort = process.env.AINIZE_CI_DOCKER_NETWORK ? Number(process.env.AINIZE_CI_DOCKER_GATEWAY_PORT) : 0;
  try {
    if (!process.env.AINIZE_CI_DOCKER_NETWORK) await hostedAgentDockerExec(['network', 'create', '--internal', '--label', 'ainize.hosted-agents=1', net]).catch(() => undefined);
    const gw = (await hostedAgentDockerExec(['network', 'inspect', net, '--format', '{{(index .IPAM.Config 0).Gateway}}'])).stdout.trim();
    if (!gw) return false;
    const probe = createServer((_q, s) => s.end('ok'));
    // The fixed port may be held by another test's gateway for a while; wait for it rather than skip.
    const until = Date.now() + 600_000;
    for (;;) {
      try { await new Promise<void>((r, j) => { probe.once('error', j); probe.listen(fixedPort, '0.0.0.0', () => r()); }); break; }
      catch (e) { if ((e as { code?: string }).code !== 'EADDRINUSE' || Date.now() > until) throw e; await new Promise((r) => setTimeout(r, 1000)); }
    }
    const port = (probe.address() as AddressInfo).port;
    try {
      const r = await hostedAgentDockerExec(['run', '--rm', '--network', net, 'alpine:latest', 'sh', '-c', `wget -q -T 4 -O - http://${gw}:${port}/ || echo UNREACHABLE`], 30_000);
      return /ok/.test(r.stdout) && !/UNREACHABLE/.test(r.stdout);
    } finally {
      probe.close();
    }
  } catch {
    return false;
  }
}

const skip = !hasDocker ? 'no docker daemon' : !(await dockerInternalNetReachesHost()) ? 'docker internal network cannot reach the host gateway in this environment' : false;

interface SseEvent { event: string; data: unknown }
async function sse(res: Response): Promise<SseEvent[]> {
  assert.match(res.headers.get('content-type') ?? '', /^text\/event-stream/);
  const text = await res.text();
  return text.split('\n\n').filter((b) => b.trim() && !b.startsWith(':')).map((block) => {
    const lines = block.split('\n');
    const event = lines.find((l) => l.startsWith('event: '))!.slice(7);
    const data = lines.filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
    return { event, data: JSON.parse(data) };
  });
}
const joined = (events: SseEvent[], name: string) => events.filter((e) => e.event === name).map((e) => e.data as string).join('');

test('/api/run runs scripts in the hosted-agent sandbox', { skip, timeout: 900_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'run-docker-'));
  const network = process.env.AINIZE_CI_DOCKER_NETWORK || `ainize-run-test-${process.pid}`;
  const gatewayPort = process.env.AINIZE_CI_DOCKER_GATEWAY_PORT ? Number(process.env.AINIZE_CI_DOCKER_GATEWAY_PORT) : undefined;

  // The decision "sidecar": scores a1 high and a2 low, whatever it is asked — the ranking is what the fixture prints.
  const sidecar = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      const body = JSON.parse(b) as { questions: Record<string, unknown> };
      const answers = Object.fromEntries(Object.keys(body.questions).map((k) => [k, { noul: k === 'a1' ? 0.91 : 0.12 }]));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ answers }));
    });
  });
  await new Promise<void>((r) => sidecar.listen(0, '127.0.0.1', () => r()));
  const registry = new InferenceBackendRegistry([{ id: 'clef', modality: 'decision', upstream: `http://127.0.0.1:${(sidecar.address() as AddressInfo).port}`, models: ['clef-flash'], concurrency: 2 }]);
  const gates = new Map([['clef', new ModalityGate('decision', 2)]]);

  const logs: string[] = [];
  const gateway = new HostedAgentGateway({ registry: () => registry, spec: () => null, log: (m) => logs.push(m) });
  const docker = new HostedAgentDocker({ memory: '512m', cpus: 1, pidsLimit: 128, network, buildTimeoutMs: 600_000, workDir: join(dir, 'hosted'), runtimeImage: 'unused' });
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use(freeTierRouter({ registry, gates, self: '0x1' }));
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const sandbox = new RunSandbox({
    docker, gateway, gatewayPort, selfUrl: () => base, publicUrl: () => 'https://node.example',
    ...RUN_SANDBOX_DEFAULTS, workDir: join(dir, 'run'), imageRepository: 'ainize/run-runtime-test',
    log: (level, m) => logs.push(`${level} ${m}`),
  });
  app.use(runRouter({ sandbox }));
  // With a fixed CI port, another test's gateway may hold it for a while: keep trying rather than fail.
  for (const until = Date.now() + 600_000; ; ) {
    await sandbox.start();
    if (sandbox.available || !gatewayPort || Date.now() > until) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.ok(sandbox.available, logs.join('\n'));

  const post = (body: unknown, init: RequestInit = {}) => fetch(`${base}/api/run`, { method: 'POST', ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) }, body: JSON.stringify(body) });
  const python = (source: string, extra: Record<string, unknown> = {}) => ({ language: 'python', entry: 'main.py', files: { 'main.py': source }, ...extra });

  try {
    await t.test('art_search.py gets its ranking from /api/decide through the node and exits 0', async () => {
      const source = readFileSync(join(import.meta.dirname, 'fixtures', 'run', 'art_search.py'), 'utf8');
      const res = await post({
        // the shape aindrive's run client sends (the other runs below use the map)
        language: 'python', entry: 'art_search.py', files: [{ path: 'art_search.py', content: source }, { path: 'README.md', content: '# art search' }],
        env: { AINIZE_DECIDE_URL: 'https://node.example/api/decide' }, timeoutMs: 120_000,
      });
      assert.equal(res.status, 200);
      const events = await sse(res);
      assert.equal(joined(events, 'stdout'), '1. 0.910 a1\n2. 0.120 a2\n', JSON.stringify(events));
      assert.equal(joined(events, 'stderr'), '');
      const exit = events.at(-1)!;
      assert.equal(exit.event, 'exit');
      assert.equal((exit.data as { code: number }).code, 0);
      assert.ok(logs.some((l) => /^info run [0-9a-f]+: caller=ip:.* language=python entry=art_search.py bytes=\d+ ms=\d+ exit=0$/.test(l)), logs.join('\n'));
    });

    await t.test('the default AINIZE_DECIDE_URL already points at this node, and JSON clients get one object', async () => {
      const res = await post(python([
        'import os, json, urllib.request',
        'u = os.environ["AINIZE_DECIDE_URL"]',
        'body = {"model": "clef-flash", "state": {}, "questions": {"a1": {"type": "noul"}}}',
        'r = json.loads(urllib.request.urlopen(urllib.request.Request(u, data=json.dumps(body).encode(), headers={"content-type": "application/json"}), timeout=60).read())',
        'print(r["answers"]["a1"]["noul"])',
      ].join('\n')), { headers: { accept: 'application/json' } });
      assert.equal(res.status, 200);
      const body = await res.json() as { stdout: string; stderr: string; code: number; ms: number };
      assert.equal(body.stdout, '0.91\n', JSON.stringify(body));
      assert.equal(body.code, 0);
      assert.ok(body.ms > 0);
    });

    await t.test('a run has no route to the internet, and the proxy refuses hosts it was not allowed', async () => {
      const res = await post(python([
        'import urllib.request, urllib.error',
        'def attempt(url):',
        '    try: urllib.request.urlopen(url, timeout=5); return "reached"',
        '    except urllib.error.HTTPError as e: return "http:%d" % e.code',
        '    except Exception as e: return "blocked:" + type(e).__name__ + ":" + str(getattr(e, "reason", e))',
        'print("direct", attempt("http://1.1.1.1/"))',
        'print("tls-direct", attempt("https://1.1.1.1/"))',
        'print("proxied", attempt("https://example.com/"))',
      ].join('\n'), { timeoutMs: 60_000 }), { headers: { accept: 'application/json' } });
      const body = await res.json() as { stdout: string; stderr: string; code: number };
      assert.equal(body.code, 0, JSON.stringify(body));
      const lines = body.stdout.trim().split('\n');
      assert.match(lines[0]!, /^direct blocked:/, 'plain http to 1.1.1.1 has no route');
      assert.match(lines[1]!, /^tls-direct blocked:.*403/, 'an https IP literal goes to the proxy, which refuses it');
      assert.match(lines[2]!, /^proxied blocked:.*403/, 'example.com is not an allowed host');
      assert.ok(logs.some((l) => /tunnel refused: example.com:443/.test(l)), logs.join('\n'));
    });

    await t.test('a run that outlives timeoutMs is killed: error event, exit 124', async () => {
      const started = Date.now();
      const res = await post(python('import time\nprint("started", flush=True)\ntime.sleep(60)\nprint("never")', { timeoutMs: 3000 }));
      const events = await sse(res);
      assert.equal(joined(events, 'stdout'), 'started\n');
      assert.deepEqual(events.find((e) => e.event === 'error')?.data, 'timeout after 3000ms');
      const exit = events.at(-1)!.data as { code: number; ms: number };
      assert.equal(exit.code, RUN_TIMEOUT_EXIT_CODE);
      assert.ok(Date.now() - started < 30_000, 'killed promptly');
      const ps = await hostedAgentDockerExec(['ps', '-q', '--filter', 'label=ainize.run=1']);
      assert.equal(ps.stdout.trim(), '', 'no container left behind');
    });

    await t.test('a third concurrent run for the same caller is 429; closing the stream kills the container', async () => {
      const controllers = [new AbortController(), new AbortController()];
      const sleeper = python('import sys, time\nprint("up", flush=True)\ntime.sleep(120)', { timeoutMs: 150_000 });
      const streams = await Promise.all(controllers.map((c) => post(sleeper, { signal: c.signal })));
      for (const s of streams) {
        assert.equal(s.status, 200);
        const reader = s.body!.getReader();
        let seen = '';
        while (!/"up\\n"/.test(seen)) seen += new TextDecoder().decode((await reader.read()).value);
      }
      assert.equal(sandbox.inFlight, 2);
      const third = await post(sleeper, { headers: { accept: 'application/json' } });
      assert.equal(third.status, 429);
      assert.equal((await third.json() as { error: string }).error, 'too_many_runs');

      const ids = (await hostedAgentDockerExec(['ps', '-q', '--filter', 'label=ainize.run=1'])).stdout.trim().split('\n').filter(Boolean);
      assert.equal(ids.length, 2);
      const inspect = await hostedAgentDockerExec(['inspect', ids[0]!, '--format', '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}} {{.Config.User}} {{.HostConfig.Memory}} {{.HostConfig.PidsLimit}} {{.HostConfig.NetworkMode}}']);
      assert.equal(inspect.stdout.trim(), `true [ALL] 1000:1000 536870912 128 ${network}`);
      const internal = await hostedAgentDockerExec(['network', 'inspect', network, '--format', '{{.Internal}}']);
      assert.equal(internal.stdout.trim(), 'true');

      for (const c of controllers) c.abort();
      const until = Date.now() + 30_000;
      while (sandbox.inFlight > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
      assert.equal(sandbox.inFlight, 0, 'both slots released after the clients went away');
      const ps = await hostedAgentDockerExec(['ps', '-q', '--filter', 'label=ainize.run=1']);
      assert.equal(ps.stdout.trim(), '', 'aborted runs are gone');
    });

    await t.test('the rootfs is read-only and /work is the only writable place; files keep their tree', async () => {
      const res = await post({
        language: 'python', entry: 'main.py',
        files: {
          'main.py': [
            'import os, pkg.mod',
            'open("/work/out.txt", "w").write("ok")',
            'print("work", open("/work/out.txt").read(), "pkg", pkg.mod.X, "cwd", os.getcwd(), "uid", os.getuid())',
            'for p in ["/usr/x", "/etc/x", "/root/x", "/work/../x", "/home/x"]:',
            '    try: open(p, "w").write("x"); print(p, "WRITABLE")',
            '    except OSError as e: print(p, "readonly", e.errno)',
            'try: import requests; print("requests", requests.__version__.split(".")[0])',
            'except Exception as e: print("requests missing", e)',
          ].join('\n'),
          'pkg/__init__.py': '', 'pkg/mod.py': 'X = 42',
        },
      }, { headers: { accept: 'application/json' } });
      const body = await res.json() as { stdout: string; stderr: string; code: number };
      assert.equal(body.code, 0, JSON.stringify(body));
      const lines = body.stdout.trim().split('\n');
      assert.equal(lines[0], 'work ok pkg 42 cwd /work uid 1000');
      assert.equal(lines.filter((l) => / readonly (30|13)$/.test(l)).length, 5, body.stdout); // EROFS, or EACCES where the dir is root's
      assert.ok(!body.stdout.includes('WRITABLE'));
      assert.equal(lines.at(-1), 'requests 2');
    });

    await t.test('node scripts run on node 20', async () => {
      const res = await post({ language: 'node', entry: 'index.mjs', files: { 'index.mjs': 'console.log(process.version.split(".")[0], process.env.AINIZE_DECIDE_URL.endsWith("/api/decide")); console.error("warned"); process.exit(3);' } }, { headers: { accept: 'application/json' } });
      const body = await res.json() as { stdout: string; stderr: string; code: number };
      assert.equal(body.stdout, 'v20 true\n');
      assert.equal(body.stderr, 'warned\n');
      assert.equal(body.code, 3);
    });
  } finally {
    await sandbox.stop();
    await gateway.close();
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => sidecar.close(() => r()));
    if (!process.env.AINIZE_CI_DOCKER_NETWORK) await hostedAgentDockerExec(['network', 'rm', network]);
    rmSync(dir, { recursive: true, force: true });
  }
});
