/**
 * Prompt in, image out, in the shape a stock OpenAI client parses.
 *
 * The image backend is the one serving process here that is not vLLM, so this is also the test that the node's
 * routing does not assume otherwise. As with audio: its own GPU, its own queue, never the language model's lease.
 *
 *   node --test --import tsx test/openai-images.test.ts
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

const tmp = mkdtempSync(join(tmpdir(), 'ainize-img-'));
const PORT = 24211;
const LLM_PORT = 24212;
const IMG_PORT = 24213;
const HUMAN = createIdentity();

/** A 1x1 PNG, so the test asserts on real base64 rather than a placeholder string. */
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let N: RunningNode;
let llm: Server;
let img: Server;
let url = '';
let apiKey = '';
let imgDown = false;
let lastRequest: Record<string, unknown> = {};

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

/** A stub of the diffusers sidecar. */
function startImage(): Promise<Server> {
  const server = createServer((req, res) => {
    if (imgDown) { res.writeHead(503); res.end('loading'); return; }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try { lastRequest = JSON.parse(body) as Record<string, unknown>; } catch { lastRequest = {}; }
      const n = Number(lastRequest.n ?? 1);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ created: 1, data: Array.from({ length: n }, () => ({ b64_json: TINY_PNG })) }));
    });
  });
  return new Promise((resolve) => server.listen(IMG_PORT, '127.0.0.1', () => resolve(server)));
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

const generate = (over: Record<string, unknown> = {}) =>
  post('/v1/images/generations', { model: 'qwen-image-2512', prompt: 'a red square', ...over }, { authorization: `Bearer ${apiKey}` });

before(async () => {
  llm = await startLlm();
  img = await startImage();
  const cfg: NodeConfig = defaultConfig({ home: join(tmp, 'N'), name: 'img-node', port: PORT, peers: [], roles: ['seller'], ledger: 'local' });
  cfg.runtime = { repo: undefined, api: `http://127.0.0.1:${LLM_PORT}`, hookApi: `http://127.0.0.1:${LLM_PORT}` };
  cfg.host = '127.0.0.1'; cfg.publicUrl = `http://127.0.0.1:${PORT}`;
  cfg.verifier = { quorum: 1, allowSelfAttest: true, intervalMs: 300_000, auto: false };
  cfg.gossipIntervalMs = 60_000;
  cfg.backends = [
    { id: 'llm', modality: 'chat', upstream: `http://127.0.0.1:${LLM_PORT}`, models: ['qwen3.8-flash-next'] },
    { id: 'image', modality: 'image', upstream: `http://127.0.0.1:${IMG_PORT}`, models: ['qwen-image-2512'], concurrency: 1 },
  ];
  N = await startNode(cfg, { quiet: true, serveWeb: false });
  url = `http://127.0.0.1:${PORT}`;
  const challenge = await (await post('/v1/auth/nonce', { address: HUMAN.address, scheme: 'eip191' })).json() as { nonce: string; message: string };
  apiKey = ((await (await post('/v1/auth/token', { nonce: challenge.nonce, signature: personalSign(challenge.message, HUMAN.privateKey) })).json()) as { api_key: string }).api_key;
});

after(async () => {
  await N?.stop();
  await new Promise((r) => llm?.close(r));
  await new Promise((r) => img?.close(r));
  rmSync(tmp, { recursive: true, force: true });
});

test('the image model is advertised beside the chat model', async () => {
  const body = await (await fetch(`${url}/v1/models`, { headers: { authorization: `Bearer ${apiKey}` } })).json() as { data: { id: string }[] };
  assert.ok(body.data.some((m) => m.id === 'qwen-image-2512'));
});

test('a prompt comes back as base64 image data in OpenAI shape', async () => {
  const res = await generate();
  assert.equal(res.status, 200);
  const body = await res.json() as { created: number; data: { b64_json: string }[] };
  assert.equal(typeof body.created, 'number');
  assert.equal(body.data.length, 1);
  assert.ok(Buffer.from(body.data[0].b64_json, 'base64').subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])), 'the payload must really be a PNG');
});

test('n is honoured rather than silently ignored', async () => {
  const body = await (await generate({ n: 3 })).json() as { data: unknown[] };
  assert.equal(body.data.length, 3);
});

test('more images than the node will make is 400, before any GPU time is spent', async () => {
  const res = await generate({ n: 99 });
  assert.equal(res.status, 400);
});

test('an empty prompt is 400, not an image of nothing', async () => {
  const res = await generate({ prompt: '' });
  assert.equal(res.status, 400);
});

test('a chat model asked for an image is 404, not routed to the wrong GPU', async () => {
  const res = await generate({ model: 'qwen3.8-flash-next' });
  assert.equal(res.status, 404);
  assert.equal((await res.json() as { error: { code: string } }).error.code, 'model_not_found');
});

test('a backend that is down is 503 backend_unavailable', async () => {
  imgDown = true;
  try {
    const res = await generate();
    assert.equal(res.status, 503);
    assert.equal((await res.json() as { error: { code: string } }).error.code, 'backend_unavailable');
  } finally { imgDown = false; }
});

test('the prompt reaches the backend unchanged', async () => {
  await generate({ prompt: 'a blue circle on white', size: '512x512' });
  assert.equal(lastRequest.prompt, 'a blue circle on white');
  assert.equal(lastRequest.size, '512x512');
});

test('image generation does not take the language model\'s lease', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const blocker = N.market.runtime.exclusive('chat', () => held);
  await new Promise((r) => setTimeout(r, 20));
  try {
    const res = await Promise.race([
      generate(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('image generation waited for the LLM lease')), 3000)),
    ]);
    assert.equal(res.status, 200);
  } finally {
    release();
    await blocker;
  }
});

test('the surface still requires a key for images', async () => {
  const res = await post('/v1/images/generations', { model: 'qwen-image-2512', prompt: 'x' });
  assert.equal(res.status, 401);
});
