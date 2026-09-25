/**
 * The shapes a stock OpenAI client insists on. These assertions ARE the compatibility claim.
 *
 * Every one of them is here because a real client breaks without it, in a way its user cannot diagnose from the
 * error they see: `openai-python` raises `AuthenticationError` on a 401 only when the body carries `error.code`,
 * it reads `chatcmpl-` ids back into `ChatCompletion`, and its stream iterator ends on `data: [DONE]` and hangs
 * without one. So the tests pin the wire, not our idea of it.
 *
 * The upstream is a stub speaking vLLM's dialect. What is under test is the translation, not the model.
 *
 *   node --test --import tsx test/openai-surface.test.ts
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

const tmp = mkdtempSync(join(tmpdir(), 'ainize-v1-'));
const PORT = 24191;
const UPSTREAM_PORT = 24192;
const HUMAN = createIdentity();

let N: RunningNode;
let upstream: Server;
let url = '';
let apiKey = '';

/** A stub vLLM: one completion, or one SSE stream, in the dialect the node's runtime consumes. */
function startUpstream(): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/v1/models')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'qwen3.8-flash-next', object: 'model', created: 1 }] }));
      return;
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const wantsStream = (() => { try { return !!JSON.parse(body).stream; } catch { return false; } })();
      if (!wantsStream) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          id: 'cmpl-upstream', object: 'chat.completion', created: 1, model: 'qwen3.8-flash-next',
          choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const frame = (delta: Record<string, unknown>, finish: string | null) => `data: ${JSON.stringify({
        id: 'cmpl-upstream', object: 'chat.completion.chunk', created: 1, model: 'qwen3.8-flash-next',
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`;
      res.write(frame({ role: 'assistant', content: 'po' }, null));
      res.write(frame({ content: 'ng' }, 'stop'));
      // vLLM's last frame when asked for usage — which the node always asks for, for its own accounting.
      // `choices` is empty, exactly as OpenAI sends it, and forwarding it to a caller who did not ask breaks
      // the documented `chunk.choices[0]` loop. The stub sends it so the tests see what really arrives.
      res.write(`data: ${JSON.stringify({
        id: 'cmpl-upstream', object: 'chat.completion.chunk', created: 1, model: 'qwen3.8-flash-next',
        choices: [], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((resolve) => server.listen(UPSTREAM_PORT, '127.0.0.1', () => resolve(server)));
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

before(async () => {
  upstream = await startUpstream();
  const cfg: NodeConfig = defaultConfig({ home: join(tmp, 'N'), name: 'v1-node', port: PORT, peers: [], roles: ['seller'], ledger: 'local' });
  cfg.runtime = { repo: undefined, api: `http://127.0.0.1:${UPSTREAM_PORT}`, hookApi: `http://127.0.0.1:${UPSTREAM_PORT}` };
  cfg.host = '127.0.0.1'; cfg.publicUrl = `http://127.0.0.1:${PORT}`;
  cfg.verifier = { quorum: 1, allowSelfAttest: true, intervalMs: 300_000, auto: false };
  cfg.gossipIntervalMs = 60_000;
  cfg.backends = [{ id: 'llm', modality: 'chat', upstream: `http://127.0.0.1:${UPSTREAM_PORT}`, models: ['qwen3.8-flash-next'] }];
  N = await startNode(cfg, { quiet: true, serveWeb: false });
  url = `http://127.0.0.1:${PORT}`;

  const challenge = await (await post('/v1/auth/nonce', { address: HUMAN.address, scheme: 'eip191' })).json() as { nonce: string; message: string };
  const issued = await (await post('/v1/auth/token', { nonce: challenge.nonce, signature: personalSign(challenge.message, HUMAN.privateKey) })).json() as { api_key: string };
  apiKey = issued.api_key;
});

after(async () => {
  await N?.stop();
  await new Promise((r) => upstream?.close(r));
  rmSync(tmp, { recursive: true, force: true });
});

const authed = () => ({ authorization: `Bearer ${apiKey}` });

test('GET /v1/models lists what the registry holds, in OpenAI shape', async () => {
  const body = await (await fetch(`${url}/v1/models`, { headers: authed() })).json() as { object: string; data: { id: string; object: string }[] };
  assert.equal(body.object, 'list');
  assert.ok(body.data.every((m) => m.object === 'model'));
  assert.ok(body.data.some((m) => m.id === 'qwen3.8-flash-next'));
});

test('a completion comes back in the shape the client parses', async () => {
  const body = await (await post('/v1/chat/completions', {
    model: 'qwen3.8-flash-next', messages: [{ role: 'user', content: 'ping' }],
  }, authed())).json() as Record<string, never>;
  assert.equal(body.object as unknown as string, 'chat.completion');
  assert.match(body.id as unknown as string, /^chatcmpl-/);
  const choice = (body.choices as unknown as { index: number; message: { role: string; content: string }; finish_reason: string }[])[0];
  assert.equal(choice.index, 0);
  assert.equal(choice.message.role, 'assistant');
  assert.equal(choice.message.content, 'pong');
  assert.equal(choice.finish_reason, 'stop');
  assert.equal(body.model as unknown as string, 'qwen3.8-flash-next');
});

test('usage is reported, because a client shows it and a caller budgets with it', async () => {
  const body = await (await post('/v1/chat/completions', {
    model: 'qwen3.8-flash-next', messages: [{ role: 'user', content: 'ping' }],
  }, authed())).json() as { usage?: { total_tokens?: number } };
  assert.equal(typeof body.usage?.total_tokens, 'number');
});

test('a stream is chunk frames and ends with [DONE]', async () => {
  const res = await post('/v1/chat/completions', {
    model: 'qwen3.8-flash-next', messages: [{ role: 'user', content: 'ping' }], stream: true,
  }, authed());
  assert.equal(res.headers.get('content-type')?.split(';')[0], 'text/event-stream');
  const text = await res.text();
  assert.ok(text.includes('"object":"chat.completion.chunk"'), 'frames must name themselves as chunks');
  assert.ok(text.includes('chatcmpl-'), 'every frame carries the completion id the client correlates on');
  assert.ok(text.trimEnd().endsWith('data: [DONE]'), 'a stream without [DONE] hangs the client iterator');
});

test('a stream carries no frame the caller did not ask for', async () => {
  // OpenAI emits a final usage frame with `choices: []` only when the request set
  // stream_options.include_usage. The node asks its upstream for usage unconditionally, for its own accounting,
  // and forwarding that frame breaks every client written from OpenAI's docs: the documented loop is
  // `chunk.choices[0].delta`, which raises IndexError on an empty list.
  const res = await post('/v1/chat/completions', {
    model: 'qwen3.8-flash-next', messages: [{ role: 'user', content: 'ping' }], stream: true,
  }, authed());
  const frames = (await res.text()).split('\n\n')
    .map((block) => block.split('\n').find((line) => line.startsWith('data: '))?.slice(6))
    .filter((data): data is string => !!data && data !== '[DONE]')
    .map((data) => JSON.parse(data) as { choices: unknown[]; usage?: unknown });
  assert.ok(frames.length > 0, 'the stream must contain frames');
  for (const frame of frames) {
    assert.ok(frame.choices.length > 0, 'every frame a caller sees must have a choice to read');
  }
});

test('asking for usage gets the usage frame, in OpenAI\'s place and shape', async () => {
  const res = await post('/v1/chat/completions', {
    model: 'qwen3.8-flash-next', messages: [{ role: 'user', content: 'ping' }], stream: true,
    stream_options: { include_usage: true },
  }, authed());
  const frames = (await res.text()).split('\n\n')
    .map((block) => block.split('\n').find((line) => line.startsWith('data: '))?.slice(6))
    .filter((data): data is string => !!data && data !== '[DONE]')
    .map((data) => JSON.parse(data) as { choices: unknown[]; usage?: { total_tokens?: number } });
  const usageFrame = frames.find((f) => f.choices.length === 0);
  assert.ok(usageFrame, 'a caller that asked for usage must get the frame');
  assert.equal(typeof usageFrame.usage?.total_tokens, 'number');
  assert.equal(frames.indexOf(usageFrame), frames.length - 1, 'and it comes last, as OpenAI sends it');
});

test('no key is 401 in OpenAI error shape', async () => {
  const res = await post('/v1/chat/completions', { model: 'qwen3.8-flash-next', messages: [{ role: 'user', content: 'ping' }] });
  assert.equal(res.status, 401);
  const body = await res.json() as { error: { code: string; type: string; message: string } };
  assert.equal(body.error.code, 'invalid_api_key');
  assert.equal(body.error.type, 'invalid_request_error');
});

test('an unknown model is 404 model_not_found, not a 500 and not a silent fallback', async () => {
  const res = await post('/v1/chat/completions', { model: 'gpt-4', messages: [{ role: 'user', content: 'ping' }] }, authed());
  assert.equal(res.status, 404);
  assert.equal((await res.json() as { error: { code: string } }).error.code, 'model_not_found');
});

test('an empty messages array is 400, not an answer to nothing', async () => {
  const res = await post('/v1/chat/completions', { model: 'qwen3.8-flash-next', messages: [] }, authed());
  assert.equal(res.status, 400);
});
