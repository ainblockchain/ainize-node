import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentGit, agentJsonOf } from '../src/agent-git.js';
import { AgentPreviewRuns } from '../src/agent-preview-runs.js';
import { AgentPreviews } from '../src/agent-previews.js';
import { agentPreviewRoutes } from '../src/agent-preview-routes.js';
import { HostedAgentGateway } from '../src/hosted-agent-gateway.js';
import { HostedAgentHost } from '../src/hosted-agent-host.js';
import { HostedAgentSecretStore } from '../src/hosted-agent-secrets.js';
import { InferenceBackendRegistry } from '../src/inference-backends.js';
import { hostedAgentSpecInput } from '../src/hosted-agent-types.js';

test('mirror previews read the configured folder at the selected source commit, not the root agent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'preview-mirror-folder-'));
  const git = new AgentGit(join(root, 'git'));
  let previews: AgentPreviews | undefined;
  try {
    await git.init('desk');
    const decoy = hostedAgentSpecInput.parse({ id: 'desk', name: 'Root agent', model: 'root-model', systemPrompt: 'Wrong root prompt' });
    await git.commitSpec('desk', decoy, { message: 'Root agent' });
    const clone = join(root, 'clone');
    execFileSync('git', ['clone', '--quiet', git.dir('desk'), clone]);
    const g = (args: string[]) => execFileSync('git', ['-C', clone, ...args], { encoding: 'utf8' }).trim();
    g(['config', 'user.name', 'Mirror author']); g(['config', 'user.email', 'mirror@example.com']);
    const folder = join(clone, 'news', 'desk'); mkdirSync(folder, { recursive: true });
    const input = hostedAgentSpecInput.parse({ id: 'desk', name: 'Folder agent', model: 'folder-model', systemPrompt: 'Reviewed folder prompt' });
    writeFileSync(join(folder, 'agent.json'), JSON.stringify(agentJsonOf(input)));
    writeFileSync(join(folder, 'prompt.md'), input.systemPrompt);
    g(['add', '.']); g(['commit', '-qm', 'Reviewed folder']); const pinned = g(['rev-parse', 'HEAD']);
    writeFileSync(join(folder, 'prompt.md'), 'Unreviewed later folder prompt');
    g(['add', '.']); g(['commit', '-qm', 'Later folder']); g(['push', '--quiet', 'origin', 'main']);
    const host = {
      apply: () => {}, remove: async () => {}, status: () => ({ status: 'ready', liveVersion: 1 }),
      resolve: async () => 'http://127.0.0.1:8080', has: () => false,
    } as unknown as HostedAgentHost;
    previews = new AgentPreviews(git, host, { sourcePath: () => 'news/desk', pollMs: 1 });
    const preview = await previews.create('desk', pinned, 'reader');
    assert.equal(preview.commit, pinned);
    assert.equal(previews.spec(preview.id)?.model, 'folder-model');
    assert.equal(previews.spec(preview.id)?.systemPrompt, 'Reviewed folder prompt');
    assert.notEqual(await git.resolve('desk', 'main'), pinned);
    const ordinary = new AgentPreviews(git, host);
    try {
      const fromRoot = await ordinary.create('desk', pinned, 'reader');
      assert.equal(ordinary.spec(fromRoot.id)?.model, 'root-model');
    } finally { await ordinary.stop(); }
  } finally { await previews?.stop(); rmSync(root, { recursive: true, force: true }); }
});

test('preview executes the pinned prompt through the real runtime, without source authority, and expires', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-preview-'));
  const modelApp = express(); modelApp.use(express.json());
  modelApp.post('/v1/chat/completions', (req, res) => res.json({ id: 'reply', object: 'chat.completion', model: 'model', choices: [{ index: 0, message: { role: 'assistant', content: `prompt=${req.body.messages[0].content}` }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  const modelServer = createServer(modelApp);
  await new Promise<void>((resolve) => modelServer.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(modelServer.address() as AddressInfo).port}`;
  const git = new AgentGit(join(root, 'git'));
  const secrets = new HostedAgentSecretStore(join(root, 'secrets.json'), join(root, 'secrets.key'));
  secrets.set('desk', 'API_KEY', 'source-only-secret');
  let previews: AgentPreviews | null = null;
  const registry = new InferenceBackendRegistry([{ id: 'test', modality: 'chat', upstream: base, models: ['model'], concurrency: 1 }]);
  const gateway = new HostedAgentGateway({ registry: () => registry, spec: (id) => previews?.spec(id) ?? null, log: () => {} });
  const host = new HostedAgentHost({ gateway, secrets, docker: null, idleStopMs: 1000, maxRunning: 2, log: () => {} });
  let now = Date.now();
  try {
    await host.start([]);
    await git.init('desk');
    const original = hostedAgentSpecInput.parse({ id: 'desk', name: 'Desk', model: 'model', systemPrompt: 'Reviewed prompt', allowedHosts: ['example.com'], secretNames: ['API_KEY'], media: { image: true, transcription: true } });
    const pinned = await git.commitSpec('desk', original, { message: 'Proposal' });
    previews = new AgentPreviews(git, host, { now: () => now, ttlMs: 1000, pollMs: 1 });
    const app = express(); app.use(express.json());
    const evidence = new AgentPreviewRuns(join(root, 'review-runs.json'));
    app.use(agentPreviewRoutes({ previews, runs: evidence, principal: (req) => req.get('x-person') ?? null, canRead: (req) => req.get('x-person') !== 'denied' }));
    assert.equal((await request(app).post('/api/hosted-agents/desk/previews').send({ ref: pinned })).status, 401);
    const started = await request(app).post('/api/hosted-agents/desk/previews').set('x-person', 'reader').send({ ref: pinned });
    assert.equal(started.status, 202, started.text);
    const id = started.body.preview.id as string;
    const spec = previews.spec(id)!;
    assert.equal(spec.visibility, 'private');
    assert.deepEqual(spec.allowedHosts, []); assert.deepEqual(spec.secretNames, []);
    assert.deepEqual(spec.media, { transcription: false, image: false });
    assert.equal(spec.orgId, null);
    assert.deepEqual(secrets.names(id), []);
    assert.equal(host.has('desk'), false, 'preview never updates or starts the source agent');
    await git.commitSpec('desk', { ...original, systemPrompt: 'Later unreviewed prompt' }, { message: 'Later', parent: pinned });
    for (let n = 0; n < 100 && previews.get(id, 'reader')?.status !== 'ready'; n++) await new Promise((resolve) => setTimeout(resolve, 1));
    const route = `/api/agent-previews/${id}`;
    assert.equal((await request(app).get(route).set('x-person', 'other')).status, 404);
    const rpc = { jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { kind: 'message', role: 'user', messageId: 'test', parts: [{ kind: 'text', text: 'hello' }] } } };
    assert.equal((await request(app).post(`${route}/rpc`).set('x-person', 'other').send(rpc)).status, 404);
    const reply = await request(app).post(`${route}/rpc`).set('x-person', 'reader').send(rpc);
    assert.equal(reply.status, 200, reply.text);
    assert.match(JSON.stringify(reply.body.result), /Reviewed prompt/);
    assert.doesNotMatch(JSON.stringify(reply.body), /Later unreviewed|source-only-secret/);
    const gatewayUrl = await gateway.listen('127.0.0.1');
    const gatewayToken = gateway.issue(id);
    assert.equal((await fetch(`${gatewayUrl}/t/${gatewayToken}/egress`, { method: 'POST', body: JSON.stringify({ url: 'https://example.com/' }) })).status, 403);
    await previews.create('desk', pinned, 'reader');
    await assert.rejects(previews.create('desk', pinned, 'reader'), /limit/);
    const lifetime = previews.signal(id)!;
    now += 1001;
    assert.equal((await request(app).get(route).set('x-person', 'reader')).status, 404);
    await previews.sweep();
    assert.equal(lifetime.aborted, true);
    assert.equal(host.has(id), false);
    assert.equal((await fetch(`${gatewayUrl}/t/${gatewayToken}/v1/models`)).status, 401);
    assert.equal(await git.resolve('desk', 'main') === pinned, false, 'source remains at its newer commit');
    const history = await request(app).get('/api/hosted-agents/desk/preview-runs').set('x-person', 'reader');
    assert.equal(history.status, 200);
    assert.equal(history.body.runs.length, 1);
    assert.equal(history.body.runs[0].commit, pinned);
    assert.equal(history.body.runs[0].model, original.model);
    assert.deepEqual(history.body.runs[0].request, rpc);
    assert.match(history.body.runs[0].output, /Reviewed prompt/);
    assert.equal(history.body.runs[0].status, 'ready');
    assert.equal(new AgentPreviewRuns(join(root, 'review-runs.json')).list('desk', 'reader').length, 1);
    assert.deepEqual((await request(app).get('/api/hosted-agents/desk/preview-runs').set('x-person', 'other')).body.runs, []);
    assert.equal((await request(app).get('/api/hosted-agents/desk/preview-runs').set('x-person', 'denied')).status, 404);
    const recordPath = `/api/hosted-agents/desk/preview-runs/${history.body.runs[0].id}`;
    assert.equal((await request(app).delete(recordPath).set('x-person', 'reader')).status, 409);
    assert.equal((await request(app).post(`${recordPath}/export`).set('x-person', 'other')).status, 404);
    const exported = await request(app).post(`${recordPath}/export`).set('x-person', 'reader');
    assert.equal(exported.status, 200);
    assert.match(exported.body.run.output, /Reviewed prompt/);
    assert.equal((await request(app).delete(recordPath).set('x-person', 'reader')).status, 200);
    assert.equal(new AgentPreviewRuns(join(root, 'review-runs.json')).list('desk', 'reader').length, 0);
  } finally {
    await previews?.stop(); await host.stop();
    await new Promise<void>((resolve) => modelServer.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test('removing a code preview waits for its build before removing images', async () => {
  const root = mkdtempSync(join(tmpdir(), 'preview-build-'));
  const gateway = new HostedAgentGateway({ registry: () => null, spec: () => null, log: () => {} });
  let finishBuild: (() => void) | undefined;
  let imagesRemoved = false;
  const docker = {
    ensureNetwork: async () => '127.0.0.1', removeOrphans: async () => {},
    buildAgent: async () => { await new Promise<void>((resolve) => { finishBuild = resolve; }); return ''; },
    stop: async () => {}, removeImages: async () => { imagesRemoved = true; },
  } as unknown as import('../src/hosted-agent-docker.js').HostedAgentDocker;
  const host = new HostedAgentHost({ gateway, secrets: new HostedAgentSecretStore(join(root, 'secrets.json'), join(root, 'secrets.key')), docker, idleStopMs: 1000, maxRunning: 2, log: () => {} });
  try {
    await host.start([]);
    host.apply({ ...hostedAgentSpecInput.parse({ id: 'preview-build', name: 'Code preview', model: 'model', mode: 'handler', files: { 'index.mjs': 'export default { execute: async () => "ok" }' } }), owner: 'reader', version: 1, createdAt: 1, updatedAt: 1 }, { ephemeral: true });
    const removing = host.remove('preview-build');
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(imagesRemoved, false, 'an image cannot be removed before the build that creates it ends');
    finishBuild!();
    await removing;
    assert.equal(imagesRemoved, true);
    assert.equal(host.has('preview-build'), false);
  } finally { finishBuild?.(); await host.stop(); rmSync(root, { recursive: true, force: true }); }
});
