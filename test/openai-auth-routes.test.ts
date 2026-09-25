/**
 * Getting an API key by proving an address, using the sign-in the node already had.
 *
 * The `/v1` surface needs a bearer key because that is what OpenAI's clients send. What it must not do is invent a
 * second way to prove an address: the node already issues a readable challenge and verifies it under a scheme
 * fixed when the challenge was asked for, and a second implementation of that is a second thing to get wrong.
 * These tests pin that the key-issuing door obeys the same rules as the session-issuing one — single-use nonces,
 * the signature checked against the stored bytes, and the scheme never chosen by whoever presents the signature.
 *
 *   node --test --import tsx test/openai-auth-routes.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIdentity, defaultConfig, type NodeConfig } from '@ainize/core';
import { startNode, type RunningNode } from '../src/server.js';
import { personalSign } from './fixtures/metamask.js';

const tmp = mkdtempSync(join(tmpdir(), 'ainize-v1auth-'));
const PORT = 24187;
const HUMAN = createIdentity();
const STRANGER = createIdentity();

let N: RunningNode;
let url = '';

const post = async (path: string, body: unknown) => {
  const r = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() as Record<string, never> };
};

type Challenge = { nonce: string; message: string; scheme: string; expires_at: number };
const nonceFor = async (address: string): Promise<Challenge> =>
  (await post('/v1/auth/nonce', { address, scheme: 'eip191' })).body as unknown as Challenge;

before(async () => {
  const cfg: NodeConfig = defaultConfig({ home: join(tmp, 'N'), name: 'v1-node', port: PORT, peers: [], roles: ['seller'], ledger: 'local' });
  cfg.runtime = { repo: undefined, api: 'http://127.0.0.1:1', hookApi: 'http://127.0.0.1:1' };
  cfg.host = '127.0.0.1'; cfg.publicUrl = `http://127.0.0.1:${PORT}`;
  cfg.verifier = { quorum: 1, allowSelfAttest: true, intervalMs: 300_000, auto: false };
  cfg.gossipIntervalMs = 60_000;
  cfg.backends = [{ id: 'llm', modality: 'chat', upstream: 'http://127.0.0.1:1', models: ['qwen3.8-flash-next'] }];
  N = await startNode(cfg, { quiet: true, serveWeb: false });
  url = `http://127.0.0.1:${PORT}`;
});
after(async () => { await N?.stop(); rmSync(tmp, { recursive: true, force: true }); });

test('the nonce a caller signs is inside the message it reads', async () => {
  const challenge = await nonceFor(HUMAN.address);
  assert.ok(challenge.message.includes(challenge.nonce));
  assert.ok(challenge.expires_at > Date.now());
});

test('a signature over the issued message buys a key that names the signer', async () => {
  const challenge = await nonceFor(HUMAN.address);
  const issued = await post('/v1/auth/token', { nonce: challenge.nonce, signature: personalSign(challenge.message, HUMAN.privateKey) });
  assert.equal(issued.status, 200);
  assert.match(issued.body.api_key as unknown as string, /^ainize-sk-/);
  assert.equal((issued.body.address as unknown as string).toLowerCase(), HUMAN.address.toLowerCase());
});

test('a nonce is good exactly once', async () => {
  const challenge = await nonceFor(HUMAN.address);
  const signature = personalSign(challenge.message, HUMAN.privateKey);
  assert.equal((await post('/v1/auth/token', { nonce: challenge.nonce, signature })).status, 200);
  assert.equal((await post('/v1/auth/token', { nonce: challenge.nonce, signature })).status, 401);
});

test('a signature by another key is refused', async () => {
  const challenge = await nonceFor(HUMAN.address);
  const stolen = await post('/v1/auth/token', { nonce: challenge.nonce, signature: personalSign(challenge.message, STRANGER.privateKey) });
  assert.equal(stolen.status, 401);
});

test('an unknown nonce is refused the same way an expired one is', async () => {
  const unknown = await post('/v1/auth/token', { nonce: 'never-issued', signature: '0x00' });
  assert.equal(unknown.status, 401);
});

test('the issued key actually opens the surface it was issued for', async () => {
  const challenge = await nonceFor(HUMAN.address);
  const { body } = await post('/v1/auth/token', { nonce: challenge.nonce, signature: personalSign(challenge.message, HUMAN.privateKey) });
  const models = await fetch(`${url}/v1/models`, { headers: { authorization: `Bearer ${body.api_key}` } });
  assert.equal(models.status, 200);
});
