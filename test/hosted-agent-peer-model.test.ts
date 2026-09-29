/**
 * A hosted agent built on another node's chat model (`id@0x<node>`, peer-models.ts).
 *
 * The case this exists for: ainize.ai serves Qwen3.8-Flash-Next with an 8k window and a GPU node serves the same id
 * with 262k. An agent that names the GPU node's copy must get it — every turn, streamed — even though this node has
 * a model of that name itself. Node A (the agent's host) and node B (the provider) are real HTTP servers; A signs
 * with its node key and B's real provider route checks it.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';
import { createIdentity } from '@ainize/core';
import { InferenceBackendRegistry } from '../src/inference-backends.js';
import { HostedAgentGateway } from '../src/hosted-agent-gateway.js';
import { HostedAgentHost } from '../src/hosted-agent-host.js';
import { HostedAgentSecretStore } from '../src/hosted-agent-secrets.js';
import { HostedAgentStore } from '../src/hosted-agent-store.js';
import { hostedAgentRoutes } from '../src/hosted-agent-routes.js';
import { hostedAgentSpecInput, type HostedAgentSpec } from '../src/hosted-agent-types.js';
import { HostedAgentExecutor, resetHostedAgentNativeToolsRefusedForTest } from '../src/hosted-agent-runtime/hostedAgentExecutor.js';
import { fetchPeerChat, nodeModelRef, peerModelRoutes, type PeerModelTarget } from '../src/peer-models.js';

const A = createIdentity();
const B = createIdentity();
const MODEL = 'Flash-Next';

/** A chat backend that says which node it is, streamed the way vLLM streams, plain JSON otherwise. */
function chatBackend(name: string, seen: { model: string; stream: boolean }[]): Server {
  return createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model: string; stream?: boolean };
    seen.push({ model: body.model, stream: !!body.stream });
    const answer = `answered by ${name}`;
    if (!body.stream) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: answer } }] })); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const piece of answer.split(/(?= )/)) res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
}

const listen = async (s: Server) => { await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r())); return `http://127.0.0.1:${(s.address() as AddressInfo).port}`; };

let localBackend: Server, remoteBackend: Server, nodeB: Server;
let localUrl = '', bUrl = '';
const localSeen: { model: string; stream: boolean }[] = [];
const remoteSeen: { model: string; stream: boolean }[] = [];

before(async () => {
  localBackend = chatBackend('A (8k)', localSeen);
  remoteBackend = chatBackend('B (262k)', remoteSeen);
  localUrl = await listen(localBackend);
  const remoteUrl = await listen(remoteBackend);
  // Node B: its real provider route over its own backend of the same model id.
  const app = express();
  app.use(express.json({ limit: '48mb' }));
  app.use(peerModelRoutes({
    registry: () => new InferenceBackendRegistry([{ id: 'llm', modality: 'chat', upstream: remoteUrl, models: [MODEL], concurrency: 2 }]),
    gates: () => undefined, self: B.address, serving: () => true, log: () => {},
  }));
  nodeB = createServer(app);
  bUrl = await listen(nodeB);
});
after(async () => { for (const s of [localBackend, remoteBackend, nodeB]) await new Promise<void>((r) => s.close(() => r())); });

/** Node A: it serves MODEL itself (the 8k copy) and knows B serves one too. */
const localRegistry = () => new InferenceBackendRegistry([{ id: 'llm', modality: 'chat', upstream: localUrl, models: [MODEL], concurrency: 1 }]);
const bTarget = (): PeerModelTarget => ({ address: B.address.toLowerCase(), endpoint: bUrl, name: 'gpu-node', model: MODEL, lastSeen: Date.now() });
const peerChat = {
  self: A.address,
  target: (model: string, node: string | null) => (model === MODEL && (!node || node === B.address.toLowerCase()) ? bTarget() : null),
  fetch: (target: PeerModelTarget, body: unknown) => fetchPeerChat(A, target, body),
};
const specOf = (model: string): HostedAgentSpec =>
  ({ ...hostedAgentSpecInput.parse({ id: 'drive', name: 'Drive', model }), owner: '0x' + 'a'.repeat(40), version: 1, createdAt: 0, updatedAt: 0 }) as HostedAgentSpec;

test('an agent that names another node\'s model is answered by that node, streamed, though this node has one of the same name', async () => {
  resetHostedAgentNativeToolsRefusedForTest();
  const spec = specOf(nodeModelRef(MODEL, B.address));
  const gateway = new HostedAgentGateway({ registry: localRegistry, peerChat, spec: () => spec, log: () => {} });
  try {
    const url = await gateway.listen('127.0.0.1');
    const ex = new HostedAgentExecutor({ spec, gateway: { url, token: gateway.issue('drive') }, secrets: {}, log: () => {}, module: null });
    const beforeLocal = localSeen.length;
    const out = await ex.turn('hi', 'c1');
    assert.equal(out.text, 'answered by B (262k)');
    assert.equal(localSeen.length, beforeLocal, 'this node\'s own copy was not asked');
    assert.equal(remoteSeen.at(-1)!.model, MODEL, 'the peer is asked for its model by id, without the node suffix');
  } finally { await gateway.close(); }
});

test('the gateway passes the peer\'s stream through as it comes', async () => {
  const spec = specOf(nodeModelRef(MODEL, B.address));
  const gateway = new HostedAgentGateway({ registry: localRegistry, peerChat, spec: () => spec, log: () => {} });
  try {
    const url = await gateway.listen('127.0.0.1');
    const res = await fetch(`${url}/t/${gateway.issue('drive')}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'hi' }] }) });
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    const text = (await res.text()).split('\n').filter((l) => l.startsWith('data: {')).map((l) => (JSON.parse(l.slice(6)) as { choices: { delta: { content?: string } }[] }).choices[0]!.delta.content ?? '').join('');
    assert.equal(text, 'answered by B (262k)');
    assert.equal(remoteSeen.at(-1)!.stream, true);
  } finally { await gateway.close(); }
});

test('a bare id and a ref naming this node stay on this node; a peer that is gone is said plainly', async () => {
  for (const model of [MODEL, nodeModelRef(MODEL, A.address)]) {
    const spec = specOf(model);
    const gateway = new HostedAgentGateway({ registry: localRegistry, peerChat, spec: () => spec, log: () => {} });
    try {
      const url = await gateway.listen('127.0.0.1');
      const r = await fetch(`${url}/t/${gateway.issue('drive')}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [] }) });
      assert.equal(((await r.json()) as { choices: { message: { content: string } }[] }).choices[0]!.message.content, 'answered by A (8k)', model);
      assert.equal(localSeen.at(-1)!.model, MODEL);
    } finally { await gateway.close(); }
  }
  const gone = specOf(nodeModelRef(MODEL, '0x' + '9'.repeat(40)));
  const gateway = new HostedAgentGateway({ registry: localRegistry, peerChat, spec: () => gone, log: () => {} });
  try {
    const url = await gateway.listen('127.0.0.1');
    const r = await fetch(`${url}/t/${gateway.issue('drive')}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [] }) });
    assert.equal(r.status, 503);
    assert.equal(((await r.json()) as { error: { code: string } }).error.code, 'model_not_served');
  } finally { await gateway.close(); }
});

test('the API lets an agent be built on a peer\'s model, and refuses a node that serves nothing of that name', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hosted-peer-model-'));
  const store = new HostedAgentStore(join(dir, 'h.json'));
  const secrets = new HostedAgentSecretStore(join(dir, 's.json'), join(dir, 's.key'));
  const gateway = new HostedAgentGateway({ registry: localRegistry, peerChat, spec: (id) => store.get(id), log: () => {} });
  const host = new HostedAgentHost({ gateway, secrets, docker: null, idleStopMs: 60_000, maxRunning: 2, log: () => {} });
  await host.start([]);
  const app = express();
  app.use(express.json());
  app.use(hostedAgentRoutes({
    store, secrets, host, registry: localRegistry,
    sessionPrincipal: (req) => req.header('x-test-address')?.toLowerCase() ?? null,
    reserved: () => false, publicBase: () => 'https://node.example',
    peerChat: { self: A.address, serves: (model, node) => !!peerChat.target(model, node) },
  }));
  const server = createServer(app);
  const base = await listen(server);
  const headers = { 'content-type': 'application/json', 'x-test-address': '0x' + 'a'.repeat(40) };
  try {
    const ok = await fetch(`${base}/api/hosted-agents`, { method: 'POST', headers, body: JSON.stringify({ id: 'drive', name: 'Drive', model: nodeModelRef(MODEL, B.address) }) });
    assert.equal(ok.status, 201, await ok.clone().text());
    assert.equal(store.get('drive')!.model, nodeModelRef(MODEL, B.address), 'the ref is kept as given');
    const nowhere = await fetch(`${base}/api/hosted-agents`, { method: 'POST', headers, body: JSON.stringify({ id: 'lost', name: 'Lost', model: nodeModelRef(MODEL, '0x' + '9'.repeat(40)) }) });
    assert.equal(nowhere.status, 400);
    assert.equal(((await nowhere.json()) as { error: { code: string } }).error.code, 'model_not_served');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await host.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
