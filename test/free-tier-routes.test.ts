/**
 * The visitor's door to the two models that had none.
 *
 * `/api/chat` already lets a signed-out visitor reach the language model. Transcription and image generation had
 * no equivalent, so a browser playground for them would have meant the site holding one key on behalf of every
 * visitor — with everybody's usage indistinguishable from everybody else's.
 *
 * There is no hourly count here any more: the free tier is bounded by where it sits in the queue (see
 * `runtime-stake-order.test.ts`) and by the per-request caps below, not by a number of presses.
 *
 * These are NOT `/v1` with the authentication removed. `/v1` is what a program calls with a key and a deposit
 * behind it; this is the door somebody presses once to see whether it works. Separate routes mean the free tier
 * can be tightened without touching the paid surface, and somebody who outgrows it is pointed at a different
 * thing rather than the same thing with a limit lifted.
 *
 *   node --test --import tsx test/free-tier-routes.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, type NodeConfig } from '@ainize/core';
import { startNode, type RunningNode } from '../src/server.js';
import { FREE_IMAGE_MAX_N, FREE_IMAGE_MAX_STEPS } from '../src/free-tier-routes.js';
import { OPENAI_IMAGE_MAX_N, OPENAI_IMAGE_MAX_STEPS } from '../src/openai-surface.js';

const tmp = mkdtempSync(join(tmpdir(), 'ainize-free-'));
const PORT = 24240;
const LLM_PORT = 24241;
const STT_PORT = 24242;
const IMG_PORT = 24243;
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let N: RunningNode;
let llm: Server; let stt: Server; let img: Server;
let url = '';
let imageDown = false;

/** A real 44-byte WAV header plus a little silence, so the multipart body is not empty. */
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

const json = (res: import('node:http').ServerResponse, body: unknown) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
};

function stub(port: number, handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, body: string) => void): Promise<Server> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => handler(req, res, body));
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

/** A cookie jar, so a visitor is one browser across requests — sessions still ride on cookies. */
class Visitor {
  private cookie = '';
  async post(path: string, body: unknown, form?: FormData) {
    const headers: Record<string, string> = this.cookie ? { cookie: this.cookie } : {};
    if (!form) headers['content-type'] = 'application/json';
    const res = await fetch(`${url}${path}`, { method: 'POST', headers, body: form ?? JSON.stringify(body) });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    return res;
  }
  transcribe() {
    const form = new FormData();
    form.set('model', 'qwen3-asr');
    form.set('file', new Blob([wavBytes()], { type: 'audio/wav' }), 'hello.wav');
    return this.post('/api/transcribe', null, form);
  }
  image(over: Record<string, unknown> = {}) {
    return this.post('/api/image', { model: 'qwen-image-2512', prompt: 'a red square', ...over });
  }
  chat() {
    return this.post('/api/chat', { patch_ids: [], mode: 'base', messages: [{ role: 'user', content: 'ping' }] });
  }
}

before(async () => {
  llm = await stub(LLM_PORT, (req, res) => {
    if (req.url?.startsWith('/v1/models')) { json(res, { object: 'list', data: [{ id: 'qwen2.5-7b-instruct', object: 'model', created: 1 }] }); return; }
    json(res, { id: 'c', object: 'chat.completion', created: 1, model: 'qwen2.5-7b-instruct',
      choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }], usage: { total_tokens: 2 } });
  });
  stt = await stub(STT_PORT, (_req, res) => json(res, { text: 'hello from the audio' }));
  img = await stub(IMG_PORT, (_req, res) => {
    if (imageDown) { res.writeHead(503); res.end('loading'); return; }
    json(res, { created: 1, data: [{ b64_json: TINY_PNG }] });
  });

  const cfg: NodeConfig = defaultConfig({ home: join(tmp, 'N'), name: 'free-node', port: PORT, peers: [], roles: ['seller'], ledger: 'local' });
  cfg.runtime = { repo: undefined, api: `http://127.0.0.1:${LLM_PORT}`, hookApi: `http://127.0.0.1:${LLM_PORT}` };
  cfg.host = '127.0.0.1'; cfg.publicUrl = `http://127.0.0.1:${PORT}`;
  cfg.verifier = { quorum: 1, allowSelfAttest: true, intervalMs: 3_600_000, auto: false };
  cfg.gossipIntervalMs = 3_600_000;
  cfg.backends = [
    { id: 'llm', modality: 'chat', upstream: `http://127.0.0.1:${LLM_PORT}`, models: ['qwen2.5-7b-instruct'] },
    { id: 'stt', modality: 'transcription', upstream: `http://127.0.0.1:${STT_PORT}`, models: ['qwen3-asr'], concurrency: 4 },
    { id: 'image', modality: 'image', upstream: `http://127.0.0.1:${IMG_PORT}`, models: ['qwen-image-2512'], concurrency: 1 },
  ];
  N = await startNode(cfg, { quiet: true, serveWeb: false });
  url = `http://127.0.0.1:${PORT}`;
});

after(async () => {
  await N?.stop();
  for (const s of [llm, stt, img]) await new Promise((r) => s?.close(r));
  rmSync(tmp, { recursive: true, force: true });
});

test('a visitor with no key can transcribe', async () => {
  const res = await new Visitor().transcribe();
  assert.equal(res.status, 200);
  assert.equal((await res.json() as { text: string }).text, 'hello from the audio');
});

test('a visitor with no key can generate an image', async () => {
  const res = await new Visitor().image();
  assert.equal(res.status, 200);
  assert.equal((await res.json() as { data: unknown[] }).data.length, 1);
});

test('the free image route caps harder than /v1 does', async () => {
  // A visitor pressing a button must not be able to occupy a GPU for a minute.
  assert.ok(FREE_IMAGE_MAX_N < OPENAI_IMAGE_MAX_N, 'the free tier must ask for fewer images than the paid one');
  assert.ok(FREE_IMAGE_MAX_STEPS < OPENAI_IMAGE_MAX_STEPS, 'and fewer steps');

  const visitor = new Visitor();
  assert.equal((await visitor.image({ n: OPENAI_IMAGE_MAX_N })).status, 400, 'n allowed on /v1 is refused here');
  assert.equal((await visitor.image({ steps: OPENAI_IMAGE_MAX_STEPS })).status, 400, 'steps allowed on /v1 are refused here');
});

test('a refusal over the caps leaves the visitor free to ask again', async () => {
  const visitor = new Visitor();
  await visitor.image({ n: 99 });
  const res = await visitor.image();
  assert.equal(res.status, 200, 'the visitor was told no before any GPU was touched');
});

test('an unknown model is 404, not routed to whatever this node has', async () => {
  const res = await new Visitor().image({ model: 'dall-e-3' });
  assert.equal(res.status, 404);
  assert.equal((await res.json() as { error: { code: string } }).error.code, 'model_not_found');
});

test('a chat model asked to transcribe is 404', async () => {
  const visitor = new Visitor();
  const form = new FormData();
  form.set('model', 'qwen2.5-7b-instruct');
  form.set('file', new Blob([wavBytes()], { type: 'audio/wav' }), 'hello.wav');
  const res = await visitor.post('/api/transcribe', null, form);
  assert.equal(res.status, 404);
});

test('a request with no file is 400, not a transcription of nothing', async () => {
  const form = new FormData();
  form.set('model', 'qwen3-asr');
  const res = await new Visitor().post('/api/transcribe', null, form);
  assert.equal(res.status, 400);
});

test('a backend that is down is 503, and does not hold the visitor against it', async () => {
  imageDown = true;
  try {
    const visitor = new Visitor();
    const failed = await visitor.image();
    assert.equal(failed.status, 503);
    imageDown = false;
    assert.equal((await visitor.image()).status, 200, 'the visitor got nothing, and may ask again');
  } finally { imageDown = false; }
});

test('a visitor is not cut off by a press count, on any of the three doors', async () => {
  /**
   * This is the free tier's whole promise now: full bandwidth when the node has it to give. The hourly counter that
   * used to sit here refused the 21st press on a machine that was doing nothing — and never actually protected the
   * model, because twenty browsers arriving together each measured their own untouched allowance. What protects it
   * is the queue: unpaid work runs behind anything paid (`runtime-stake-order.test.ts` pins that ordering).
   */
  const visitor = new Visitor();
  for (let i = 0; i < 40; i++) {
    const res = await visitor.chat();
    assert.equal(res.status, 200, `chat press ${i + 1} was refused; the free tier no longer counts presses`);
  }
  assert.equal((await visitor.image()).status, 200, 'and the other doors are not counting either');
  assert.equal((await visitor.transcribe()).status, 200);
});

test('nothing in a free answer promises a remaining count', async () => {
  // The page used to render `remaining_free_tries`; there is no such number, and a stale one would be a lie.
  const body = await (await new Visitor().image()).json() as Record<string, unknown>;
  assert.ok(!('remaining_free_tries' in body), 'a count that no longer exists must not be reported');
});
