/**
 * `POST /api/run` without a Docker daemon: what is refused before a container would start, the archive the files
 * travel in, and the gateway's two run doors (the forward to this node, the CONNECT tunnel) on loopback.
 * run-api-docker.test.ts runs real scripts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';
import request from 'supertest';
import { HostedAgentGateway } from '../src/hosted-agent-gateway.js';
import { runRouter } from '../src/run-routes.js';
import { RUN_LIMITS, RunRefused, packRunFiles, parseRunRequest, runFileNameOk } from '../src/run-sandbox.js';

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(runRouter({ sandbox: null }));
const good = { language: 'python', entry: 'a.py', files: { 'a.py': 'print(1)' } };

test('/api/run answers 503 runner_unavailable when this node has no sandbox, and only after the request was valid', async () => {
  const r = await request(app).post('/api/run').send(good);
  assert.equal(r.status, 503);
  assert.equal(r.body.error, 'runner_unavailable');
  const bad = await request(app).post('/api/run').send({ ...good, files: { '../a.py': 'x' }, entry: '../a.py' });
  assert.equal(bad.status, 400, 'a bad request is refused as such, not blamed on Docker');
});

test('file names: relative, inside /work, no .. or .git', () => {
  for (const ok of ['a.py', 'src/lib/x.py', 'README.md', 'a-b_c.d', '한글.py']) assert.ok(runFileNameOk(ok), ok);
  for (const bad of ['', '../a.py', 'a/../b.py', '/etc/passwd', 'a/./b', 'a//b', '.git/config', 'x/.GIT/HEAD', 'a\\b', 'a\u0000b', 'a'.repeat(300)]) assert.ok(!runFileNameOk(bad), JSON.stringify(bad));
});

test('parseRunRequest refuses what the contract says it refuses, with the status it documents', () => {
  const refused = (body: unknown) => { try { parseRunRequest(body); } catch (e) { return e as RunRefused; } return null; };
  assert.equal(refused({ ...good, files: { '../a.py': 'x' }, entry: '../a.py' })?.status, 400);
  assert.equal(refused({ ...good, entry: 'b.py' })?.status, 400, 'entry must be one of files');
  assert.equal(refused({ ...good, language: 'ruby' })?.status, 400);
  assert.equal(refused({ ...good, timeoutMs: RUN_LIMITS.maxTimeoutMs + 1 })?.status, 400);
  assert.equal(refused({ ...good, files: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`f${i}.py`, ''])), entry: 'f0.py' })?.status, 400);
  const big = refused({ ...good, files: { 'a.py': 'x'.repeat(RUN_LIMITS.maxTotalBytes + 1) } });
  assert.equal(big?.status, 413);
  assert.equal(big?.code, 'files_too_large');
  assert.equal(refused({ ...good, env: { 'BAD-NAME': 'x' } })?.status, 400);
  assert.equal(refused({ ...good, env: { X: 'a\nb' } })?.status, 400);
  // aindrive sends the files as a list; the map and the list are the same request.
  const asList = parseRunRequest({ ...good, files: [{ path: 'a.py', content: 'print(1)' }, { path: 'lib/b.py', content: 'B = 2' }] });
  assert.deepEqual(asList.files, { 'a.py': 'print(1)', 'lib/b.py': 'B = 2' });
  assert.equal(refused({ ...good, files: [{ path: '../a.py', content: 'x' }], entry: '../a.py' })?.status, 400, 'the list is validated like the map');
  assert.equal(refused({ ...good, files: [{ path: '.git/config', content: 'x' }, { path: 'a.py', content: '' }] })?.status, 400);
  assert.equal(refused({ ...good, files: [{ path: 'a.py', content: 'x' }, { path: 'a.py', content: 'y' }] })?.status, 400, 'a path twice');
  assert.equal(refused({ ...good, files: [{ path: 'a.py' }] })?.status, 400, 'content is required');
  const parsed = parseRunRequest(good);
  assert.equal(parsed.timeoutMs, RUN_LIMITS.defaultTimeoutMs);
  assert.equal(parsed.bytes, 8);
});

test('the files travel as a tar that the system tar unpacks, directories and multibyte names included', () => {
  const dir = mkdtempSync(join(tmpdir(), 'run-tar-'));
  try {
    const files: Record<string, string> = { 'a.py': 'print("hi")\n', 'pkg/sub/mod.py': 'X = 1', '한글/노트.md': '# 노트\n', ['long/' + 'd'.repeat(90) + '/' + 'f'.repeat(60) + '.txt']: 'deep' };
    writeFileSync(join(dir, 'files.tar'), packRunFiles(files));
    execFileSync('tar', ['-xf', join(dir, 'files.tar'), '-C', dir]);
    const listed = execFileSync('tar', ['-tf', join(dir, 'files.tar')]).toString().split('\n').filter(Boolean);
    assert.deepEqual(listed.filter((n) => !n.endsWith('/')).sort(), Object.keys(files).sort());
    assert.equal(execFileSync('cat', [join(dir, 'pkg/sub/mod.py')]).toString(), 'X = 1');
    assert.equal(execFileSync('cat', [join(dir, '한글/노트.md')]).toString(), '# 노트\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the gateway forwards a run only to /api/decide, /api/chat and /v1/*, and tunnels only to allowed hosts on 443', async () => {
  const self = express();
  self.use(express.json());
  self.post('/api/decide', (req, res) => res.json({ got: req.body, run: req.header('x-ainize-run'), auth: req.header('authorization') ?? null }));
  self.get('/api/hosted-agents', (_req, res) => res.json({ leaked: true }));
  const selfServer = createServer(self);
  await new Promise<void>((r) => selfServer.listen(0, '127.0.0.1', () => r()));
  const selfUrl = `http://127.0.0.1:${(selfServer.address() as AddressInfo).port}`;
  const gateway = new HostedAgentGateway({ registry: () => null, spec: () => null, log: () => {} });
  const gw = new URL(await gateway.listen('127.0.0.1'));
  const token = gateway.issueRun({ id: 'r1', allowedHosts: ['ainize.ai'], selfUrl });
  try {
    const decide = await fetch(`${gw.origin}/t/${token}/api/decide`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer k1' }, body: JSON.stringify({ model: 'm' }) });
    assert.equal(decide.status, 200);
    assert.deepEqual(await decide.json(), { got: { model: 'm' }, run: 'r1', auth: 'Bearer k1' });
    const other = await fetch(`${gw.origin}/t/${token}/api/hosted-agents`);
    assert.equal(other.status, 403);
    assert.equal(((await other.json()) as { error: { code: string } }).error.code, 'run_path_refused');
    gateway.revokeRun(token);
    assert.equal((await fetch(`${gw.origin}/t/${token}/api/decide`, { method: 'POST' })).status, 401, 'a revoked run token is nobody');

    const live = gateway.issueRun({ id: 'r2', allowedHosts: ['ainize.ai'], selfUrl });
    const tunnel = (target: string, auth?: string) => new Promise<string>((resolve, reject) => {
      const req = httpRequest({ host: gw.hostname, port: gw.port, method: 'CONNECT', path: target, headers: auth ? { 'proxy-authorization': `Basic ${Buffer.from(auth).toString('base64')}` } : {} });
      req.on('connect', (res, socket) => { socket.destroy(); resolve(String(res.statusCode)); });
      req.on('response', (res) => { resolve(String(res.statusCode)); res.resume(); });
      req.on('error', reject);
      req.end();
    });
    assert.equal(await tunnel('ainize.ai:443'), '407', 'no token, no tunnel');
    assert.equal(await tunnel('ainize.ai:443', `run:${'0'.repeat(48)}`), '407', 'an unknown token is no token');
    assert.equal(await tunnel('example.com:443', `run:${live}`), '403', 'a host the run was not allowed');
    assert.equal(await tunnel('ainize.ai:80', `run:${live}`), '403', 'only TLS');
    assert.equal(await tunnel('1.1.1.1:443', `run:${live}`), '403', 'no IP literals');
    assert.equal(await tunnel('127.0.0.1:443', `run:${live}`), '403');
    // A raw CONNECT without any Proxy-Authorization line at all, as a client that ignores the proxy URL's credentials would send.
    const raw = await new Promise<string>((resolve) => {
      const s = connect({ host: gw.hostname, port: Number(gw.port) }, () => s.write('CONNECT ainize.ai:443 HTTP/1.1\r\nHost: ainize.ai:443\r\n\r\n'));
      let buf = ''; s.on('data', (d) => { buf += d; }); s.on('close', () => resolve(buf));
    });
    assert.match(raw, /^HTTP\/1\.1 407 /);
  } finally {
    await gateway.close();
    await new Promise<void>((r) => selfServer.close(() => r()));
  }
});
