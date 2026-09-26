/**
 * Hosted agents with the node's speech and image models (hostedAgentMedia.ts, the gateway's media routes).
 *
 * One fake backend answers all three modalities the way vLLM and the image sidecar do. The tests drive the real
 * gateway, the real executor, and — for the last one — the real HTTP API, agents.ts proxy and A2A over v0.3, so
 * the picture is checked in the part shape a workspace actually receives.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';
import type { NodeConfig } from '@ainize/core';
import { buildAgents } from '../src/agents.js';
import { InferenceBackendRegistry } from '../src/inference-backends.js';
import { HostedAgentGateway } from '../src/hosted-agent-gateway.js';
import { HostedAgentHost } from '../src/hosted-agent-host.js';
import { HostedAgentSecretStore } from '../src/hosted-agent-secrets.js';
import { HostedAgentStore } from '../src/hosted-agent-store.js';
import { hostedAgentRoutes } from '../src/hosted-agent-routes.js';
import { ModalityGate } from '../src/modality-gate.js';
import { hostedAgentMediaOf, hostedAgentSpecInput, type HostedAgentSpec } from '../src/hosted-agent-types.js';
import { HostedAgentExecutor } from '../src/hosted-agent-runtime/hostedAgentExecutor.js';
import { hostedAgentCard } from '../src/hosted-agent-runtime/hostedAgentRuntimeApp.js';

const MODEL = 'Test-Chat-1';
const ALICE = '0x00000000000000000000000000000000000a11ce';
/** A 1×1 PNG, as the sidecar would base64 it. */
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

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
      // multipart: the test only needs to see that the audio and the model name arrived
      const text = raw.toString('latin1');
      hits.push({ path: req.url, body: { model: /name="model"\r\n\r\n([^\r]+)/.exec(text)?.[1], hasAudio: text.includes('RIFF-fake-wav') } });
      res.end(JSON.stringify({ text: '내일 오후 세 시에 회의 잡아줘' }));
      return;
    }
    if (req.url === '/v1/images/generations') {
      const body = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
      hits.push({ path: req.url, body });
      res.end(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }));
      return;
    }
    const body = JSON.parse(raw.toString('utf8') || '{}') as { messages: { role: string; content: string | null }[]; tools?: { function: { name: string } }[] };
    hits.push({ path: req.url ?? '', body });
    const lastUser = [...body.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const toolResult = body.messages.find((m) => m.role === 'tool');
    const canDraw = body.tools?.some((t) => t.function.name === 'generate_image');
    if (canDraw && /draw/i.test(lastUser) && !toolResult) {
      res.end(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'g1', type: 'function', function: { name: 'generate_image', arguments: '{"prompt":"a red cat","size":"768x768"}' } }] } }] }));
      return;
    }
    const answer = toolResult ? `here it is (${toolResult.content})` : `you said: ${lastUser}`;
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: answer } }] }));
  });
  await new Promise<void>((r) => backend.listen(0, '127.0.0.1', () => r()));
  backendUrl = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;
});
after(async () => { await new Promise<void>((r) => backend.close(() => r())); });

const registry = () => new InferenceBackendRegistry([
  { id: 'llm', modality: 'chat', upstream: backendUrl, models: [MODEL], concurrency: 1 },
  { id: 'stt', modality: 'transcription', upstream: backendUrl, models: ['Test-ASR-1'], concurrency: 2 },
  { id: 'img', modality: 'image', upstream: backendUrl, models: ['Test-Image-1'], concurrency: 1 },
]);

const specOf = (over: Partial<HostedAgentSpec>): HostedAgentSpec => ({
  ...hostedAgentSpecInput.parse({ id: 'm', name: 'M', model: MODEL }), owner: ALICE, version: 1, createdAt: 0, updatedAt: 0, ...over,
} as HostedAgentSpec);

test('media is off unless asked for, and a spec stored before it existed reads as off', () => {
  assert.deepEqual(hostedAgentSpecInput.parse({ id: 'a', name: 'A', model: MODEL }).media, { transcription: false, image: false });
  assert.deepEqual(hostedAgentMediaOf({}), { transcription: false, image: false });
  assert.deepEqual(hostedAgentMediaOf({ media: { image: true } }), { transcription: false, image: true });
});

test('the card offers audio in and images out only when they are on — and is unchanged when they are not', () => {
  const plain = hostedAgentCard({ id: 'x', name: 'X', description: '', model: MODEL, systemPrompt: '', mode: 'prompt', a2ui: false, skills: [], version: 1 }, 'http://h');
  assert.deepEqual(plain.defaultInputModes, ['text/plain']);
  assert.deepEqual(plain.defaultOutputModes, ['text/plain']);
  assert.deepEqual(plain.metadata, { ainize: { model: MODEL, mode: 'prompt' } });
  const both = hostedAgentCard({ id: 'x', name: 'X', description: '', model: MODEL, systemPrompt: '', mode: 'prompt', a2ui: false, skills: [], version: 1, media: { transcription: true, image: true } }, 'http://h');
  assert.ok(both.defaultInputModes.includes('audio/webm') && both.defaultInputModes.includes('text/plain'));
  assert.deepEqual(both.defaultOutputModes, ['text/plain', 'image/png']);
  assert.deepEqual(both.skills[0]!.outputModes, ['text/plain', 'image/png']);
});

test('the gateway refuses media an agent did not turn on, and queues what it did through the backend gate', async () => {
  const off = specOf({ id: 'off' });
  const on = specOf({ id: 'on', media: { transcription: true, image: true } });
  const gates = new Map([['stt', new ModalityGate('transcription', 2)], ['img', new ModalityGate('image', 1)]]);
  let gated = 0;
  const gateway = new HostedAgentGateway({
    registry, spec: (id) => (id === 'on' ? on : off), log: () => {},
    gates: (id) => { gated++; return gates.get(id); },
  });
  try {
    const url = await gateway.listen('127.0.0.1');
    const post = (token: string, path: string, body: unknown) =>
      fetch(`${url}/t/${token}/v1${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const offToken = gateway.issue('off');
    const refused = await post(offToken, '/images/generations', { prompt: 'x' });
    assert.equal(refused.status, 403);
    assert.equal(((await refused.json()) as { error: { code: string } }).error.code, 'media_not_enabled');
    assert.equal((await post(offToken, '/audio/transcriptions', { bytesBase64: 'AA==' })).status, 403);

    const onToken = gateway.issue('on');
    const img = await post(onToken, '/images/generations', { prompt: 'a cat', size: '512x512', steps: 999 });
    assert.equal(img.status, 200);
    assert.equal(((await img.json()) as { data: { b64_json: string }[] }).data[0]!.b64_json, PNG_B64);
    const sent = hits.filter((h) => h.path === '/v1/images/generations').at(-1)!.body as Record<string, unknown>;
    assert.equal(sent.model, 'Test-Image-1', 'the node picks the model, not the agent');
    assert.equal(sent.n, 1);
    assert.equal(sent.steps, 30, 'steps are capped for agent turns');
    assert.equal((await post(onToken, '/images/generations', { prompt: 'x', size: 'huge' })).status, 400);

    const stt = await post(onToken, '/audio/transcriptions', { bytesBase64: Buffer.from('RIFF-fake-wav').toString('base64'), name: 'a.wav', mimeType: 'audio/wav' });
    assert.equal(stt.status, 200);
    assert.equal(((await stt.json()) as { text: string }).text, '내일 오후 세 시에 회의 잡아줘');
    assert.deepEqual(hits.filter((h) => h.path === '/v1/audio/transcriptions').at(-1)!.body, { model: 'Test-ASR-1', hasAudio: true });
    assert.ok(gated >= 2, 'both calls went through a gate');
  } finally { await gateway.close(); }
});

test('a voice note is transcribed before the model sees the turn, and the transcript is remembered', async () => {
  const spec = specOf({ id: 'ears', media: { transcription: true, image: false } });
  const gateway = new HostedAgentGateway({ registry, spec: () => spec, log: () => {} });
  try {
    const url = await gateway.listen('127.0.0.1');
    const ex = new HostedAgentExecutor({ spec, gateway: { url, token: gateway.issue('ears') }, secrets: {}, log: () => {}, module: null });
    const audio = { bytesBase64: Buffer.from('RIFF-fake-wav').toString('base64'), name: 'memo.wav', mimeType: 'audio/wav' };
    const out = await ex.turn('', 'c1', [audio]);
    assert.match(out.text, /you said: \[Voice message memo\.wav, transcribed\]\n내일 오후 세 시에 회의 잡아줘/);
    const lastChat = hits.filter((h) => h.path === '/v1/chat/completions').at(-1)!.body as { tools?: unknown[] };
    assert.equal(lastChat.tools, undefined, 'with the audio transcribed nothing is left to open, so it is a plain prompt turn');
    const next = await ex.turn('and?', 'c1');
    assert.match(next.text, /you said: and\?/);
    const history = (hits.filter((h) => h.path === '/v1/chat/completions').at(-1)!.body as { messages: { content: string }[] }).messages;
    assert.ok(history.some((m) => m.content?.includes('회의 잡아줘')), 'the earlier transcript is in the conversation');
  } finally { await gateway.close(); }
});

test('without transcription turned on, audio stays an attachment the model is only told about', async () => {
  const spec = specOf({ id: 'deaf' });
  const gateway = new HostedAgentGateway({ registry, spec: () => spec, log: () => {} });
  try {
    const url = await gateway.listen('127.0.0.1');
    const ex = new HostedAgentExecutor({ spec, gateway: { url, token: gateway.issue('deaf') }, secrets: {}, log: () => {}, module: null });
    const before = hits.filter((h) => h.path === '/v1/audio/transcriptions').length;
    await ex.turn('hi', 'c', [{ bytesBase64: 'AA==', name: 'memo.wav', mimeType: 'audio/wav' }]);
    assert.equal(hits.filter((h) => h.path === '/v1/audio/transcriptions').length, before, 'no transcription call');
  } finally { await gateway.close(); }
});

test('create with media over HTTP, then draw and listen over A2A v0.3 — the picture arrives as a file part', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hosted-media-'));
  const store = new HostedAgentStore(join(dir, 'h.json'));
  const secrets = new HostedAgentSecretStore(join(dir, 's.json'), join(dir, 's.key'));
  const gateway = new HostedAgentGateway({ registry, spec: (id) => store.get(id), log: () => {} });
  const host = new HostedAgentHost({ gateway, secrets, docker: null, idleStopMs: 60_000, maxRunning: 2, log: () => {} });
  await host.start([]);
  const cfg = { identity: { address: '0x1111111111111111111111111111111111111111' }, agents: [], publicUrl: 'https://node.example' } as unknown as NodeConfig;
  const chatOnly = () => new InferenceBackendRegistry([{ id: 'llm', modality: 'chat', upstream: backendUrl, models: [MODEL], concurrency: 1 }]);
  let reg = chatOnly;
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as typeof req & { rawBody?: Buffer }).rawBody = buf; } }));
  app.use(hostedAgentRoutes({
    store, secrets, host, registry: () => reg(),
    sessionAddress: (req) => req.header('x-test-address')?.toLowerCase() ?? null,
    reserved: () => false,
    publicBase: () => 'https://node.example',
  }));
  app.use(buildAgents(cfg, { hosted: { host, store } }));
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = { 'content-type': 'application/json', 'x-test-address': ALICE };
  try {
    const body = { id: 'studio', name: 'Studio', model: MODEL, media: { transcription: true, image: true } };
    const noBackend = await fetch(`${base}/api/hosted-agents`, { method: 'POST', headers, body: JSON.stringify(body) });
    assert.equal(noBackend.status, 400, 'a node without speech or image models cannot promise them');
    reg = registry;
    assert.equal((await fetch(`${base}/api/hosted-agents`, { method: 'POST', headers, body: JSON.stringify(body) })).status, 201);
    const full = await (await fetch(`${base}/api/hosted-agents/studio`, { headers })).json() as { agent?: { media?: unknown }; media?: unknown };
    assert.deepEqual((full.agent ?? full).media, { transcription: true, image: true }, 'the owner sees what is on');

    const card = await (await fetch(`${base}/agents/studio/.well-known/agent-card.json`)).json() as { defaultOutputModes: string[] };
    assert.deepEqual(card.defaultOutputModes, ['text/plain', 'image/png']);

    const call = async (parts: unknown[]) => {
      const r = await fetch(`${base}/agents/studio`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'message/send',
        params: { message: { kind: 'message', role: 'user', messageId: `m-${Math.random()}`, parts } },
      }) });
      return await r.json() as { result?: { parts: { kind: string; text?: string; file?: { bytes?: string; mimeType?: string; name?: string } }[] }; error?: unknown };
    };

    const drawn = await call([{ kind: 'text', text: 'draw me a cat' }]);
    assert.ok(drawn.result, JSON.stringify(drawn));
    assert.match(drawn.result!.parts[0]!.text!, /^here it is \(\{"ok":true,"attached":"image-1\.png"/, 'the model reads that it worked, not the bytes');
    const file = drawn.result!.parts.find((p) => p.kind === 'file');
    assert.ok(file, `no file part in ${JSON.stringify(drawn.result!.parts.map((p) => p.kind))}`);
    assert.equal(file!.file!.mimeType, 'image/png');
    assert.equal(file!.file!.name, 'image-1.png');
    assert.equal(file!.file!.bytes, PNG_B64, 'the picture bytes arrive intact in the v0.3 shape');
    assert.equal((hits.filter((h) => h.path === '/v1/images/generations').at(-1)!.body as { size: string }).size, '768x768');

    const heard = await call([{ kind: 'file', file: { bytes: Buffer.from('RIFF-fake-wav').toString('base64'), mimeType: 'audio/wav', name: 'memo.wav' } }]);
    assert.match(heard.result!.parts[0]!.text!, /회의 잡아줘/, 'an inline voice note is heard');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await host.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
