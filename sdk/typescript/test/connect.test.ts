/**
 * What `@ainize/sdk` promises: after one call, it is just OpenAI.
 *
 * Mirrors `sdk/python/tests/test_connect.py` assertion for assertion, because the two packages make one claim and
 * a difference between them is a bug in whichever is wrong. Driven through the genuine `openai` client against a
 * real node — mocking the transport would test our idea of the node's replies, and the shapes are exactly where
 * the claim breaks.
 *
 *   node --test --import tsx sdk/typescript/test/connect.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import OpenAI from 'openai';
import { generatePrivateKey } from 'viem/accounts';
import { defaultConfig, type NodeConfig } from '@ainize/core';
import { startNode, type RunningNode } from '../../../src/server.js';
import { connectAinize } from '../src/index.js';

const tmp = mkdtempSync(join(tmpdir(), 'ainize-ts-sdk-'));
const PORT = 24221;
const UPSTREAM_PORT = 24222;
const WALLET = generatePrivateKey();

let N: RunningNode;
let upstream: Server;
let url = '';
let issuedKey = '';

function startUpstream(): Promise<Server> {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url?.startsWith('/v1/models')) {
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'qwen3.8-flash-next', object: 'model', created: 1 }] }));
      return;
    }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const wantsStream = (() => { try { return !!JSON.parse(body).stream; } catch { return false; } })();
      if (!wantsStream) {
        res.end(JSON.stringify({
          id: 'cmpl', object: 'chat.completion', created: 1, model: 'qwen3.8-flash-next',
          choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const frame = (delta: Record<string, unknown>, finish: string | null) => `data: ${JSON.stringify({
        id: 'cmpl', object: 'chat.completion.chunk', created: 1, model: 'qwen3.8-flash-next',
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`;
      res.write(frame({ role: 'assistant', content: 'po' }, null));
      res.write(frame({ content: 'ng' }, 'stop'));
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((resolve) => server.listen(UPSTREAM_PORT, '127.0.0.1', () => resolve(server)));
}

before(async () => {
  upstream = await startUpstream();
  const cfg: NodeConfig = defaultConfig({ home: join(tmp, 'N'), name: 'ts-sdk-node', port: PORT, peers: [], roles: ['seller'], ledger: 'local' });
  cfg.runtime = { repo: undefined, api: `http://127.0.0.1:${UPSTREAM_PORT}`, hookApi: `http://127.0.0.1:${UPSTREAM_PORT}` };
  cfg.host = '127.0.0.1'; cfg.publicUrl = `http://127.0.0.1:${PORT}`;
  cfg.verifier = { quorum: 1, allowSelfAttest: true, intervalMs: 300_000, auto: false };
  cfg.gossipIntervalMs = 60_000;
  cfg.backends = [{ id: 'llm', modality: 'chat', upstream: `http://127.0.0.1:${UPSTREAM_PORT}`, models: ['qwen3.8-flash-next'] }];
  N = await startNode(cfg, { quiet: true, serveWeb: false });
  url = `http://127.0.0.1:${PORT}`;
  issuedKey = (await connectAinize(url, { privateKey: WALLET })).apiKey;
});

after(async () => {
  await N?.stop();
  await new Promise((r) => upstream?.close(r));
  rmSync(tmp, { recursive: true, force: true });
});

test('connect returns a real OpenAI client', async () => {
  const client = await connectAinize(url, { privateKey: WALLET });
  assert.ok(client instanceof OpenAI);
  assert.ok(String(client.baseURL).replace(/\/+$/, '').endsWith('/v1'));
});

test('an existing key skips signing', async () => {
  const client = await connectAinize(url, { apiKey: issuedKey });
  assert.equal(client.apiKey, issuedKey);
});

test('neither key nor private key is an error naming both', async () => {
  await assert.rejects(() => connectAinize(url), (error: Error) => {
    assert.match(error.message, /privateKey/);
    assert.match(error.message, /apiKey/);
    return true;
  });
});

test('viem signs a message the node built for ain-util to verify', async () => {
  // The two libraries hash EIP-191 the same way or they do not; a key issued at all is the proof that they do.
  const client = await connectAinize(url, { privateKey: generatePrivateKey() });
  assert.match(client.apiKey, /^ainize-sk-/);
});

test('models are listed through the stock client', async () => {
  const client = await connectAinize(url, { apiKey: issuedKey });
  const models = await client.models.list();
  assert.ok(models.data.some((m) => m.id === 'qwen3.8-flash-next'));
});

test('a chat completion round trips', async () => {
  const client = await connectAinize(url, { apiKey: issuedKey });
  const out = await client.chat.completions.create({
    model: 'qwen3.8-flash-next', messages: [{ role: 'user', content: 'ping' }],
  });
  assert.equal(out.choices[0].message.content, 'pong');
  assert.match(out.id, /^chatcmpl-/);
  assert.equal(out.choices[0].finish_reason, 'stop');
});

test('streaming yields chunks and terminates', async () => {
  const client = await connectAinize(url, { apiKey: issuedKey });
  const stream = await client.chat.completions.create({
    model: 'qwen3.8-flash-next', messages: [{ role: 'user', content: 'ping' }], stream: true,
  });
  let text = '';
  let first: string | undefined;
  for await (const chunk of stream) {
    first ??= chunk.object;
    text += chunk.choices[0]?.delta?.content ?? '';
  }
  assert.equal(first, 'chat.completion.chunk');
  assert.equal(text, 'pong');
});

test('a bad key raises OpenAI own error type', async () => {
  const client = await connectAinize(url, { apiKey: 'ainize-sk-not-a-real-key' });
  await assert.rejects(
    () => client.chat.completions.create({ model: 'qwen3.8-flash-next', messages: [{ role: 'user', content: 'ping' }] }),
    OpenAI.AuthenticationError,
  );
});

test('an unknown model raises NotFoundError', async () => {
  const client = await connectAinize(url, { apiKey: issuedKey });
  await assert.rejects(
    () => client.chat.completions.create({ model: 'gpt-4', messages: [{ role: 'user', content: 'ping' }] }),
    OpenAI.NotFoundError,
  );
});
