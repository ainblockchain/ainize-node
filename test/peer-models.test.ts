/**
 * Models over p2p (src/peer-models.ts): node A runs a hosted agent, node B has the speech and image models.
 *
 * Two real HTTP servers stand for the two nodes: B mounts the provider routes over a fake backend, A's gateway
 * finds B in a peer table and calls it with A's node key. What is checked is what goes wrong silently if it
 * breaks — a signature that is not bound to its target, a stale peer still offered, a call charged to the wrong
 * address in B's queue, an advert that leaks the backend's private URL.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createIdentity } from '@ainize/core';
import { InferenceBackendRegistry } from '../src/inference-backends.js';
import { ModalityGate } from '../src/modality-gate.js';
import { freeTierRouter } from '../src/free-tier-routes.js';
import { HostedAgentGateway } from '../src/hosted-agent-gateway.js';
import { hostedAgentSpecInput, type HostedAgentSpec } from '../src/hosted-agent-types.js';
import { HostedAgentExecutor } from '../src/hosted-agent-runtime/hostedAgentExecutor.js';
import {
  callPeerModel, networkModelsRouter, peerModelAdvertsFromInfo, peerModelAdvertsOf, peerModelAuthHeader, peerModelRoutes,
  nodeModelRef, parseNodeModelRef, peerChatModels, peerChatTarget, peerModelRefs, peerModelsServing, peerModelTargetById, peerModelTargets, relayPeerChat, verifyPeerModelAuth, type PeerModelPeerRow,
} from '../src/peer-models.js';

const A = createIdentity();
const B = createIdentity();
const MODEL = 'Test-Chat-1';
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// ───────────────────────────────── node B's backends (speech + image), and node A's chat backend

let backend: Server;
let backendUrl = '';
const hits: { path: string; body: unknown }[] = [];
before(async () => {
  backend = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/audio/transcriptions') {
      hits.push({ path: req.url, body: raw.toString('latin1').includes('voice-bytes') });
      res.end(JSON.stringify({ text: 'hello from node B' }));
    } else if (req.url === '/v1/images/generations') {
      hits.push({ path: req.url, body: JSON.parse(raw.toString('utf8')) });
      res.end(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }));
    } else {
      const body = JSON.parse(raw.toString('utf8') || '{}') as { messages: { role: string; content: string | null }[]; tools?: { function: { name: string } }[] };
      const lastUser = [...body.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
      const toolResult = body.messages.find((m) => m.role === 'tool');
      if (body.tools?.some((t) => t.function.name === 'generate_image') && /draw/.test(lastUser) && !toolResult) {
        res.end(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 't', type: 'function', function: { name: 'generate_image', arguments: '{"prompt":"a boat"}' } }] } }] }));
        return;
      }
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: toolResult ? 'drawn' : `heard: ${lastUser}` } }] }));
    }
  });
  await new Promise<void>((r) => backend.listen(0, '127.0.0.1', () => r()));
  backendUrl = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;
});
after(async () => { await new Promise<void>((r) => backend.close(() => r())); });

/** Node B: only the provider routes, over its own registry and gates. */
async function startNodeB(opts: { serving?: boolean; gates?: Map<string, ModalityGate> } = {}) {
  const registry = new InferenceBackendRegistry([
    { id: 'stt', modality: 'transcription', upstream: backendUrl, models: ['asr-1'], concurrency: 2 },
    { id: 'img', modality: 'image', upstream: backendUrl, models: ['img-1'], concurrency: 1 },
  ]);
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use(peerModelRoutes({ registry: () => registry, gates: (id) => opts.gates?.get(id), self: B.address, serving: () => opts.serving ?? true, log: () => {} }));
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const peerRow = (endpoint: string, over: Partial<PeerModelPeerRow> = {}): PeerModelPeerRow => ({
  address: B.address, endpoint, last_seen: Date.now(),
  info: { address: B.address, name: 'gpu-box', backends: peerModelAdvertsOf([{ modality: 'transcription', models: ['asr-1'] }, { modality: 'image', models: ['img-1'] }], true) },
  ...over,
});

// ───────────────────────────────── adverts and lookup

test('a node advertises its models by kind and id — chat included, never the upstream URL', () => {
  const adverts = peerModelAdvertsOf([
    { modality: 'chat', models: ['big-llm'] },
    { modality: 'transcription', models: ['asr-1'] },
    { modality: 'image', models: ['img-1'] },
  ], true);
  assert.deepEqual(adverts, [{ modality: 'chat', models: ['big-llm'] }, { modality: 'transcription', models: ['asr-1'] }, { modality: 'image', models: ['img-1'] }]);
  assert.ok(!JSON.stringify(adverts).includes('http'), 'no URL leaves the node');
  assert.deepEqual(peerModelAdvertsOf([{ modality: 'image', models: ['img-1'] }], false), [], 'an operator who opted out advertises nothing');
  assert.equal(peerModelsServing({}), true);
  assert.equal(peerModelsServing({ peerModels: { serve: false } }), false);
});

test('a peer\'s advert is read defensively — junk from a newer or broken node is dropped, not trusted', () => {
  assert.deepEqual(peerModelAdvertsFromInfo({ backends: [{ modality: 'video', models: ['v'] }, { modality: 'image', models: [7, 'ok'] }, 'x'] }), [{ modality: 'image', models: ['ok'] }]);
  assert.deepEqual(peerModelAdvertsFromInfo({ backends: 'nope' }), []);
  assert.deepEqual(peerModelAdvertsFromInfo(null), []);
});

test('only fresh peers that advertised the modality are routes, freshest first, and never this node itself', () => {
  const now = Date.now();
  const rows: PeerModelPeerRow[] = [
    peerRow('http://stale', { last_seen: now - 10 * 60_000 }),
    peerRow('http://older', { last_seen: now - 60_000 }),
    peerRow('http://newer', { address: '0x' + 'c'.repeat(40), last_seen: now - 1_000 }),
    peerRow('http://self', { address: A.address }),
    { address: '0x' + 'd'.repeat(40), endpoint: 'http://chat-only', last_seen: now, info: { backends: [{ modality: 'chat', models: ['x'] }] } },
  ];
  assert.deepEqual(peerModelTargets(rows, 'transcription', A.address, now).map((t) => t.endpoint), ['http://newer', 'http://older']);
  assert.deepEqual(peerModelTargets(rows, 'image', A.address, now)[0]!.model, 'img-1');
});

test('the signature names the provider and the modality, so it cannot be replayed at another node or another model', () => {
  const header = peerModelAuthHeader(A, B.address, 'image');
  assert.equal(verifyPeerModelAuth(header, B.address, 'image'), A.address.toLowerCase());
  assert.equal(verifyPeerModelAuth(header, B.address, 'transcription'), null, 'another modality');
  assert.equal(verifyPeerModelAuth(header, '0x' + 'e'.repeat(40), 'image'), null, 'another provider');
  assert.equal(verifyPeerModelAuth(peerModelAuthHeader(A, B.address, 'image', Date.now() - 10 * 60_000), B.address, 'image'), null, 'too old');
  assert.equal(verifyPeerModelAuth(undefined, B.address, 'image'), null);
});

// ───────────────────────────────── the provider

test('node B serves a signed peer, charges it to the calling node in its gate, and refuses everyone else', async () => {
  const charged: string[] = [];
  const gate = new ModalityGate('image', 1);
  const originalRun = gate.run.bind(gate);
  gate.run = (fn, opts) => { charged.push(opts.address); return originalRun(fn, opts); };
  const b = await startNodeB({ gates: new Map([['img', gate]]) });
  try {
    const target = peerModelTargets([peerRow(b.url)], 'image', A.address)[0]!;
    const out = await callPeerModel(A, target, 'image', { prompt: 'a boat', steps: 500 }) as { data: { b64_json: string }[]; model: string };
    assert.equal(out.data[0]!.b64_json, PNG_B64);
    assert.equal(out.model, 'img-1');
    assert.deepEqual(charged, [A.address.toLowerCase()], 'the queue knows which node asked');
    assert.equal((hits.filter((h) => h.path === '/v1/images/generations').at(-1)!.body as { steps: number }).steps, 30, 'steps capped for peers too');

    const unsigned = await fetch(`${b.url}/p2p/models/image`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'x' }) });
    assert.equal(unsigned.status, 401);
    const wrongTarget = await fetch(`${b.url}/p2p/models/image`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-ainize-auth': peerModelAuthHeader(A, A.address, 'image') }, body: JSON.stringify({ prompt: 'x' }),
    });
    assert.equal(wrongTarget.status, 401, 'a signature for another provider is refused');
  } finally { await b.close(); }

  const off = await startNodeB({ serving: false });
  try {
    await assert.rejects(callPeerModel(A, peerModelTargets([peerRow(off.url)], 'image', A.address)[0]!, 'image', { prompt: 'x' }), /does not serve its models to peers/);
  } finally { await off.close(); }
});

// ───────────────────────────────── the whole path: an agent on A hears and draws with B's models

test('a hosted agent on a chat-only node transcribes and draws with a peer\'s models', async () => {
  const b = await startNodeB();
  const chatOnly = () => new InferenceBackendRegistry([{ id: 'llm', modality: 'chat', upstream: backendUrl, models: [MODEL], concurrency: 1 }]);
  const spec = {
    ...hostedAgentSpecInput.parse({ id: 'studio', name: 'Studio', model: MODEL, media: { transcription: true, image: true } }),
    owner: '0x' + 'a'.repeat(40), version: 1, createdAt: 0, updatedAt: 0,
  } as HostedAgentSpec;
  let peers: PeerModelPeerRow[] = [peerRow(b.url)];
  const gateway = new HostedAgentGateway({
    registry: chatOnly, spec: () => spec, log: () => {},
    peerModels: {
      target: (m) => peerModelTargets(peers, m, A.address)[0] ?? null,
      call: (t, m, body) => callPeerModel(A, t, m, body),
    },
  });
  try {
    const url = await gateway.listen('127.0.0.1');
    const ex = new HostedAgentExecutor({ spec, gateway: { url, token: gateway.issue('studio') }, secrets: {}, log: () => {}, module: null });
    const heard = await ex.turn('', 'c1', [{ bytesBase64: Buffer.from('voice-bytes').toString('base64'), name: 'v.webm', mimeType: 'audio/webm' }]);
    assert.match(heard.text, /heard: \[Voice message v\.webm, transcribed\]\nhello from node B/);
    const drawn = await ex.turn('draw a boat', 'c2');
    assert.equal(drawn.text, 'drawn');
    assert.equal((drawn.parts[0] as { mediaType: string }).mediaType, 'image/png', 'the peer\'s picture comes back as a file part');

    peers = [];
    const gone = await ex.turn('', 'c3', [{ bytesBase64: 'AA==', name: 'v.webm', mimeType: 'audio/webm' }]);
    assert.match(gone.text, /could not be transcribed: .*no node in reach serves a transcription model/, 'a peer that left is said, not hidden');
  } finally {
    await gateway.close();
    await b.close();
  }
});

test('/api/network/models lists this node\'s models and each fresh peer\'s, named by node', async () => {
  const app = express();
  app.use(networkModelsRouter({
    registry: () => new InferenceBackendRegistry([{ id: 'llm', modality: 'chat', upstream: 'http://x', models: [MODEL], concurrency: 1 }]),
    // the GPU box twice — configured and learned endpoints — must still list its models once
    peers: () => [peerRow('http://gpu-box'), peerRow('http://192.168.1.141:3480'), peerRow('http://stale', { address: '0x' + 'f'.repeat(40), last_seen: 0 })],
    self: { address: A.address, name: 'main' },
  }));
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  try {
    const body = await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/network/models`)).json() as { data: { id: string; modality: string; local: boolean; node: { name: string } }[] };
    assert.deepEqual(body.data.map((m) => [m.id, m.modality, m.local, m.node.name]), [
      [MODEL, 'chat', true, 'main'],
      ['asr-1', 'transcription', false, 'gpu-box'],
      ['img-1', 'image', false, 'gpu-box'],
    ]);
    assert.ok(!JSON.stringify(body).includes('http://'), 'no endpoint or upstream is published');
  } finally { await new Promise<void>((r) => server.close(() => r())); }
});

// ───────────────────────────────── chat by model id, streamed through

test('chat for a model only a peer serves goes to that peer, JSON or streamed, and an unknown id is refused', async () => {
  const chatHits: { model: string; stream: boolean }[] = [];
  const chatBackend = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model: string; stream?: boolean };
    chatHits.push({ model: body.model, stream: !!body.stream });
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const w of ['hel', 'lo']) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: w } }] })}\n\n`);
      res.end('data: [DONE]\n\n');
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: `hi from ${body.model}` } }] }));
  });
  await new Promise<void>((r) => chatBackend.listen(0, '127.0.0.1', () => r()));
  const chatUrl = `http://127.0.0.1:${(chatBackend.address() as AddressInfo).port}`;
  const registry = new InferenceBackendRegistry([{ id: 'vlm', modality: 'chat', upstream: chatUrl, models: ['Big-VLM'], concurrency: 2 }]);
  const provider = express();
  provider.use(express.json());
  provider.use(peerModelRoutes({ registry: () => registry, gates: () => undefined, self: B.address, serving: () => true, log: () => {} }));
  const pServer = createServer(provider);
  await new Promise<void>((r) => pServer.listen(0, '127.0.0.1', () => r()));
  const bUrl = `http://127.0.0.1:${(pServer.address() as AddressInfo).port}`;

  const peers: PeerModelPeerRow[] = [{
    address: B.address, endpoint: bUrl, last_seen: Date.now(),
    info: { name: 'gpu-box', backends: peerModelAdvertsOf([{ modality: 'chat', models: ['Big-VLM'] }, { modality: 'image', models: ['img-1'] }], true) },
  }];
  assert.equal(peerChatTarget(peers, 'Big-VLM', A.address)?.endpoint, bUrl);
  assert.equal(peerChatTarget(peers, 'Other', A.address), null, 'routed by exact id, never to "some chat model"');
  assert.equal(peerChatTarget(peers, 'Big-VLM', B.address), null, 'a node never routes to itself');
  assert.deepEqual(peerChatModels(peers, A.address), [{ id: 'Big-VLM', node: 'gpu-box' }]);

  // node A: a tiny /v1 stand-in that relays exactly as openai-surface does
  const consumer = express();
  consumer.use(express.json());
  consumer.post('/v1/chat/completions', async (req, res) => {
    const t = peerChatTarget(peers, String(req.body.model), A.address);
    if (!t) { res.status(404).json({ error: { code: 'model_not_found' } }); return; }
    await relayPeerChat(A, t, req.body, res);
  });
  const cServer = createServer(consumer);
  await new Promise<void>((r) => cServer.listen(0, '127.0.0.1', () => r()));
  const aUrl = `http://127.0.0.1:${(cServer.address() as AddressInfo).port}`;
  try {
    const post = (b: unknown) => fetch(`${aUrl}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
    const plain = await post({ model: 'Big-VLM', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(plain.status, 200);
    assert.equal(plain.headers.get('x-ainize-served-by'), B.address.toLowerCase());
    assert.equal(((await plain.json()) as { choices: { message: { content: string } }[] }).choices[0]!.message.content, 'hi from Big-VLM');

    const streamed = await post({ model: 'Big-VLM', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    assert.match(streamed.headers.get('content-type') ?? '', /text\/event-stream/);
    const text = await streamed.text();
    assert.ok(text.includes('"hel"') && text.includes('"lo"') && text.trim().endsWith('data: [DONE]'), 'the SSE stream arrives whole, frame by frame');
    assert.deepEqual(chatHits.map((h) => h.stream), [false, true]);

    assert.equal((await post({ model: 'Other', messages: [{ role: 'user', content: 'x' }] })).status, 404);
    const unsigned = await fetch(`${bUrl}/p2p/models/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'Big-VLM', messages: [] }) });
    assert.equal(unsigned.status, 401, 'the provider serves only a signed node');
  } finally {
    await new Promise<void>((r) => cServer.close(() => r()));
    await new Promise<void>((r) => pServer.close(() => r()));
    await new Promise<void>((r) => chatBackend.close(() => r()));
  }
});

// ───────────────────────────────── a model is (node, id): `id@0x<node>`

test('a ref names a model on a node; a bare id keeps its meaning', () => {
  const addr = '0x951E1767f18C4317479BB460950b281A3e122b93';
  assert.deepEqual(parseNodeModelRef(`Qwen3.8-27B@${addr}`), { model: 'Qwen3.8-27B', node: addr.toLowerCase() });
  assert.deepEqual(parseNodeModelRef('Qwen3.8-27B'), { model: 'Qwen3.8-27B', node: null });
  assert.deepEqual(parseNodeModelRef('weird@name'), { model: 'weird@name', node: null }, 'only a full address counts as a node');
  assert.equal(nodeModelRef('m', addr), `m@${addr.toLowerCase()}`);
});

test('two nodes serving the same id stay two models: a ref picks one, a bare id the freshest', () => {
  const now = Date.now();
  const C = '0x' + 'c'.repeat(40);
  const rows: PeerModelPeerRow[] = [
    { address: B.address, endpoint: 'http://b', last_seen: now - 60_000, info: { name: 'b', backends: [{ modality: 'chat', models: ['Same'] }] } },
    { address: C, endpoint: 'http://c', last_seen: now - 1_000, info: { name: 'c', backends: [{ modality: 'chat', models: ['Same'] }] } },
  ];
  assert.equal(peerModelTargetById(rows, 'chat', 'Same', A.address, null, now)!.endpoint, 'http://c');
  assert.equal(peerModelTargetById(rows, 'chat', 'Same', A.address, B.address.toLowerCase(), now)!.endpoint, 'http://b');
  assert.equal(peerModelTargetById(rows, 'transcription', 'Same', A.address, null, now), null, 'the kind has to match too');
  assert.deepEqual(peerModelRefs(rows, A.address, now).map((r) => r.ref).sort(), [`Same@${B.address.toLowerCase()}`, `Same@${C}`].sort());
});

test('a provider asked for a model it does not have refuses rather than answering with another of that kind', async () => {
  const b = await startNodeB();
  try {
    const target = { ...peerModelTargets([peerRow(b.url)], 'image', A.address)[0]!, model: 'not-here' };
    await assert.rejects(callPeerModel(A, target, 'image', { model: 'not-here', prompt: 'x' }), /does not serve a image model called not-here/);
    const ok = await callPeerModel(A, target, 'image', { model: 'img-1', prompt: 'x' }) as { model: string };
    assert.equal(ok.model, 'img-1');
  } finally { await b.close(); }
});

test('the free tier reaches a peer\'s model by ref, and /api/peer-chat never answers for this node\'s own model', async () => {
  const called: { kind: string; body: Record<string, unknown> }[] = [];
  const target = { address: B.address.toLowerCase(), endpoint: 'http://b', name: 'b', model: 'x', lastSeen: Date.now() };
  const app = express();
  app.use(express.json());
  app.use(freeTierRouter({
    registry: new InferenceBackendRegistry([{ id: 'llm', modality: 'chat', upstream: 'http://x', models: ['Own-Chat'], concurrency: 1 }]),
    gates: new Map(),
    self: A.address,
    peerModels: {
      target: (kind, model, node) => (model === 'Peer-Model' && (!node || node === B.address.toLowerCase()) ? { ...target, model } : null),
      call: async (_t, kind, body) => { called.push({ kind, body: body as Record<string, unknown> }); return kind === 'transcription' ? { text: 'from B' } : { data: [{ b64_json: 'AA' }] }; },
      relayChat: async (_t, body, res) => { called.push({ kind: 'chat', body: body as Record<string, unknown> }); res.json({ choices: [{ message: { content: 'hi from B' } }] }); },
    },
  }));
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const form = new FormData();
    form.set('model', `Peer-Model@${B.address}`);
    form.set('file', new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' }), 'a.wav');
    const stt = await fetch(`${base}/api/transcribe`, { method: 'POST', body: form });
    assert.deepEqual(await stt.json(), { text: 'from B' });
    assert.equal(called.at(-1)!.body.model, 'Peer-Model', 'the peer is asked for the bare id');

    const img = await fetch(`${base}/api/image`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'Peer-Model', prompt: 'x' }) });
    assert.equal(img.status, 200);

    const chat = await fetch(`${base}/api/peer-chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'Peer-Model', messages: [{ role: 'user', content: 'hi' }] }) });
    assert.equal(((await chat.json()) as { choices: { message: { content: string } }[] }).choices[0]!.message.content, 'hi from B');
    assert.equal(called.at(-1)!.body.max_tokens, 512, 'a free try is capped');
    assert.equal(called.at(-1)!.body.stream, false);

    const own = await fetch(`${base}/api/peer-chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'Own-Chat', messages: [{ role: 'user', content: 'hi' }] }) });
    assert.equal(own.status, 400, "this node's own model goes through /api/chat");
    const nowhere = await fetch(`${base}/api/peer-chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'Nope', messages: [{ role: 'user', content: 'hi' }] }) });
    assert.equal(nowhere.status, 404);
  } finally { await new Promise<void>((r) => server.close(() => r())); }
});
