/**
 * Speech in, text out, in the shape a stock OpenAI client sends and parses.
 *
 * The client posts multipart, not JSON, which is the one place this surface cannot reuse the chat path's
 * plumbing. What is under test is the translation and the routing — in particular that transcription does NOT
 * take the LLM's shared lease. They are different GPUs, and putting audio behind the language model's
 * one-at-a-time lock would serialise two things that have no reason to wait for each other.
 *
 *   node --test --import tsx test/openai-transcriptions.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIdentity, defaultConfig, type NodeConfig } from '@ainize/core';
import { startNode, type RunningNode } from '../src/server.js';
import { personalSign } from './fixtures/metamask.js';

const tmp = mkdtempSync(join(tmpdir(), 'ainize-stt-'));
const PORT = 24205;
const LLM_PORT = 24206;
const STT_PORT = 24207;
const HUMAN = createIdentity();

let N: RunningNode;
let llm: Server;
let stt: Server;
let url = '';
let apiKey = '';
/** Set when the stub STT backend should fail, so "the backend is down" can be told from "you were queued". */
let sttDown = false;
/** What the stub last received, so the test can check the file really crossed the boundary. */
let lastUploadBytes = 0;

function startLlm(): Promise<Server> {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url?.startsWith('/v1/models')) {
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'qwen3.8-flash-next', object: 'model', created: 1 }] }));
      return;
    }
    req.on('data', () => undefined);
    req.on('end', () => res.end(JSON.stringify({
      id: 'cmpl', object: 'chat.completion', created: 1, model: 'qwen3.8-flash-next',
      choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
      usage: { total_tokens: 2 },
    })));
  });
  return new Promise((resolve) => server.listen(LLM_PORT, '127.0.0.1', () => resolve(server)));
}

/** A stub vLLM serving Qwen3-ASR on the OpenAI transcription endpoint. */
function startStt(): Promise<Server> {
  const server = createServer((req, res) => {
    if (sttDown) { res.writeHead(503); res.end('the engine is restarting'); return; }
    let bytes = 0;
    req.on('data', (chunk: Buffer) => { bytes += chunk.length; });
    req.on('end', () => {
      lastUploadBytes = bytes;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ text: 'hello from the audio' }));
    });
  });
  return new Promise((resolve) => server.listen(STT_PORT, '127.0.0.1', () => resolve(server)));
}

/** A tiny but real WAV: 44-byte header plus a little silence. Enough that the multipart body is not empty. */
function wavBytes(samples = 8000): Uint8Array {
  const data = new Uint8Array(44 + samples * 2);
  const view = new DataView(data.buffer);
  const ascii = (offset: number, text: string) => { for (let i = 0; i < text.length; i++) data[offset + i] = text.charCodeAt(i); };
  ascii(0, 'RIFF'); view.setUint32(4, 36 + samples * 2, true); ascii(8, 'WAVEfmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  ascii(36, 'data'); view.setUint32(40, samples * 2, true);
  return data;
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

async function transcribe(over: { model?: string; omitFile?: boolean } = {}) {
  const form = new FormData();
  form.set('model', over.model ?? 'qwen3-asr');
  if (!over.omitFile) form.set('file', new Blob([wavBytes()], { type: 'audio/wav' }), 'hello.wav');
  return fetch(`${url}/v1/audio/transcriptions`, { method: 'POST', headers: { authorization: `Bearer ${apiKey}` }, body: form });
}

before(async () => {
  llm = await startLlm();
  stt = await startStt();
  const cfg: NodeConfig = defaultConfig({ home: join(tmp, 'N'), name: 'stt-node', port: PORT, peers: [], roles: ['seller'], ledger: 'local' });
  cfg.runtime = { repo: undefined, api: `http://127.0.0.1:${LLM_PORT}`, hookApi: `http://127.0.0.1:${LLM_PORT}` };
  cfg.host = '127.0.0.1'; cfg.publicUrl = `http://127.0.0.1:${PORT}`;
  cfg.verifier = { quorum: 1, allowSelfAttest: true, intervalMs: 300_000, auto: false };
  cfg.gossipIntervalMs = 60_000;
  cfg.backends = [
    { id: 'llm', modality: 'chat', upstream: `http://127.0.0.1:${LLM_PORT}`, models: ['qwen3.8-flash-next'] },
    { id: 'stt', modality: 'transcription', upstream: `http://127.0.0.1:${STT_PORT}`, models: ['qwen3-asr'], concurrency: 4 },
  ];
  N = await startNode(cfg, { quiet: true, serveWeb: false });
  url = `http://127.0.0.1:${PORT}`;
  const challenge = await (await post('/v1/auth/nonce', { address: HUMAN.address, scheme: 'eip191' })).json() as { nonce: string; message: string };
  apiKey = ((await (await post('/v1/auth/token', { nonce: challenge.nonce, signature: personalSign(challenge.message, HUMAN.privateKey) })).json()) as { api_key: string }).api_key;
});

after(async () => {
  await N?.stop();
  await new Promise((r) => llm?.close(r));
  await new Promise((r) => stt?.close(r));
  rmSync(tmp, { recursive: true, force: true });
});

test('the transcription model is advertised beside the chat model', async () => {
  const body = await (await fetch(`${url}/v1/models`, { headers: { authorization: `Bearer ${apiKey}` } })).json() as { data: { id: string }[] };
  assert.ok(body.data.some((m) => m.id === 'qwen3-asr'));
  assert.ok(body.data.some((m) => m.id === 'qwen3.8-flash-next'));
});

test('audio comes back as text in OpenAI shape', async () => {
  const res = await transcribe();
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { text: 'hello from the audio' });
});

test('the audio really reaches the backend, rather than an empty body', async () => {
  await transcribe();
  assert.ok(lastUploadBytes > 16_000, `the backend saw only ${lastUploadBytes} bytes`);
});

test('a request with no file is 400, not a transcription of nothing', async () => {
  const res = await transcribe({ omitFile: true });
  assert.equal(res.status, 400);
  assert.equal((await res.json() as { error: { code: string } }).error.code, 'invalid_request');
});

test('a chat model asked to transcribe is 404, not routed to the wrong GPU', async () => {
  const res = await transcribe({ model: 'qwen3.8-flash-next' });
  assert.equal(res.status, 404);
  assert.equal((await res.json() as { error: { code: string } }).error.code, 'model_not_found');
});

test('a backend that is down is 503 backend_unavailable, distinct from being queued', async () => {
  sttDown = true;
  try {
    const res = await transcribe();
    assert.equal(res.status, 503);
    assert.equal((await res.json() as { error: { code: string } }).error.code, 'backend_unavailable');
  } finally { sttDown = false; }
});

test('transcription does not take the language model\'s lease', async () => {
  // Hold the LLM section, then transcribe. Audio is a different GPU; if it waited for the language model's
  // one-at-a-time lock, this would time out rather than answer.
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const blocker = N.market.runtime.exclusive('chat', () => held);
  await new Promise((r) => setTimeout(r, 20));
  try {
    const res = await Promise.race([
      transcribe(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('transcription waited for the LLM lease')), 3000)),
    ]);
    assert.equal(res.status, 200);
  } finally {
    release();
    await blocker;
  }
});

test('the surface still requires a key for audio', async () => {
  const form = new FormData();
  form.set('model', 'qwen3-asr');
  form.set('file', new Blob([wavBytes()], { type: 'audio/wav' }), 'hello.wav');
  const res = await fetch(`${url}/v1/audio/transcriptions`, { method: 'POST', body: form });
  assert.equal(res.status, 401);
});
