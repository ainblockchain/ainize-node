/**
 * When the node refuses, and when it simply makes you wait.
 *
 * Under weighted fair queueing a small share means waiting longer, never being turned away, so there is no error
 * for "your share is too low" and inventing one would be a lie about the mechanism. A request is refused only
 * when the node cannot honestly promise to run it — and the refusal has to say which of the three things to
 * change: wait, deposit more, or ask for less. A bare 429 leaves a caller with no way to tell a node that is
 * briefly busy from one they will never get served by.
 *
 *   node --test --import tsx test/openai-queue-limits.test.ts
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

const tmp = mkdtempSync(join(tmpdir(), 'ainize-queue-'));
const PORT = 24201;
const UPSTREAM_PORT = 24202;
const HUMAN = createIdentity();

let N: RunningNode;
let upstream: Server;
let url = '';
let apiKey = '';
/**
 * A gate the stub model waits on. While it is closed every request that reaches the model stays there, so
 * whatever is queued behind it is genuinely contending rather than merely arriving quickly.
 */
let gate: Promise<void> | null = null;
let openGate: (() => void) | null = null;

function closeGate(): void {
  gate = new Promise<void>((resolve) => { openGate = resolve; });
}
function releaseGate(): void {
  openGate?.();
  gate = null;
  openGate = null;
}

function startUpstream(): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/v1/models')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'qwen3.8-flash-next', object: 'model', created: 1 }] }));
      return;
    }
    const answer = () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        id: 'cmpl-upstream', object: 'chat.completion', created: 1, model: 'qwen3.8-flash-next',
        choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    };
    req.on('data', () => undefined);
    req.on('end', () => { if (gate) void gate.then(answer); else answer(); });
  });
  return new Promise((resolve) => server.listen(UPSTREAM_PORT, '127.0.0.1', () => resolve(server)));
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

before(async () => {
  upstream = await startUpstream();
  const cfg: NodeConfig = defaultConfig({ home: join(tmp, 'N'), name: 'queue-node', port: PORT, peers: [], roles: ['seller'], ledger: 'local' });
  cfg.runtime = { repo: undefined, api: `http://127.0.0.1:${UPSTREAM_PORT}`, hookApi: `http://127.0.0.1:${UPSTREAM_PORT}` };
  cfg.host = '127.0.0.1'; cfg.publicUrl = `http://127.0.0.1:${PORT}`;
  cfg.verifier = { quorum: 1, allowSelfAttest: true, intervalMs: 300_000, auto: false };
  cfg.gossipIntervalMs = 60_000;
  cfg.backends = [{ id: 'llm', modality: 'chat', upstream: `http://127.0.0.1:${UPSTREAM_PORT}`, models: ['qwen3.8-flash-next'] }];
  cfg.deposits = {
    receivingAddress: '0x00000000000000000000000000000000000000ff',
    vault: { address: '0x00000000000000000000000000000000000000aa', chain: 'ethereum' },
    chains: [{ chain: 'base', rpcUrl: 'http://127.0.0.1:1', token: '0xd4423795fd904d9b87554940a95fb7016f172773' }],
    // Long enough that the watcher never runs during the test; deposits are credited directly below.
    pollMs: 3_600_000,
  };
  N = await startNode(cfg, { quiet: true, serveWeb: false });
  url = `http://127.0.0.1:${PORT}`;

  const challenge = await (await post('/v1/auth/nonce', { address: HUMAN.address, scheme: 'eip191' })).json() as { nonce: string; message: string };
  apiKey = ((await (await post('/v1/auth/token', { nonce: challenge.nonce, signature: personalSign(challenge.message, HUMAN.privateKey) })).json()) as { api_key: string }).api_key;
  N.deposits!.credit({ chain: 'base', txHash: '0xfeed', logIndex: 0, from: HUMAN.address, shares: 10n ** 18n, blockNumber: 1 });
});

after(async () => {
  releaseGate();
  await N?.stop();
  await new Promise((r) => upstream?.close(r));
  rmSync(tmp, { recursive: true, force: true });
});

const authed = () => ({ authorization: `Bearer ${apiKey}` });
const chat = (over: Record<string, unknown> = {}) =>
  post('/v1/chat/completions', { model: 'qwen3.8-flash-next', messages: [{ role: 'user', content: 'ping' }], ...over }, authed());

test('a depositor is served rather than refused — a share is a place in line, not a permit', async () => {
  const res = await chat();
  assert.equal(res.status, 200);
});

test('asking for more than the node will generate is refused before any work is done', async () => {
  const res = await chat({ max_tokens: 1_000_000 });
  assert.equal(res.status, 400, 'a ceiling refused up front costs the queue nothing');
});

test('a queue too deep to promise is 429 queue_too_deep, naming what to change', async () => {
  // Hold the model, then pile on more than the bound allows. The refusals come back while the gate is shut;
  // the accepted ones only finish once it opens, so the gate is released before awaiting them all.
  closeGate();
  const inflight = Array.from({ length: 40 }, () => chat({ max_tokens: 1024 }));
  await new Promise((r) => setTimeout(r, 300));
  releaseGate();
  const responses = await Promise.all(inflight);

  const refused = responses.filter((r) => r.status === 429);
  assert.ok(refused.length > 0, 'a node that cannot promise a wait must say so rather than queue forever');
  const body = await refused[0].json() as { error: { code: string; message: string }; share: number; position: number; retry_after: number; billing_url: string };
  assert.equal(body.error.code, 'queue_too_deep');
  assert.match(body.billing_url, /^http:\/\/[^/]+\/billing\?model=/, 'the refusal says where a deposit is made, for this model');
  assert.ok(body.error.message.includes(body.billing_url), 'and says it in the message a client prints');
  assert.equal(typeof body.share, 'number', 'the caller has to know their own share to decide whether to deposit');
  assert.equal(typeof body.position, 'number');
  assert.ok(body.retry_after > 0, 'and how long to wait before asking again');
});

test('there is no error that means "your share is too low"', async () => {
  const res = await chat();
  const body = await res.json() as { error?: { code?: string } };
  assert.notEqual(body.error?.code, 'insufficient_share', 'a low share means a longer wait, never a refusal');
});
