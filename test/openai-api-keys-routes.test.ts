/**
 * Getting an API key the way every other model API hands one out.
 *
 * The quickstart used to say `private_key="0x…"`. That is not merely unfamiliar — no other model API asks for
 * one, and the thing being pasted into a source file is the whole wallet. The browser is where a wallet already
 * lives and where the person is already signed in, so a key is issued from the session they already have: one
 * signature, in the place signatures belong, and a bearer string afterwards.
 *
 * The store keeps only a hash, so the secret exists exactly once — in the response that creates it. Every test
 * here is a consequence of that, or of the rule that a key belongs to one address.
 *
 *   node --test --import tsx test/openai-api-keys-routes.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIdentity, defaultConfig, type NodeConfig } from '@ainize/core';
import { startNode, type RunningNode } from '../src/server.js';
import { personalSign } from './fixtures/metamask.js';

const tmp = mkdtempSync(join(tmpdir(), 'ainize-keys-'));
const PORT = 24260;
const HUMAN = createIdentity();
const STRANGER = createIdentity();

let N: RunningNode;
let url = '';

/** A browser: holds the session cookie the site's sign-in sets. */
class Session {
  cookie = '';
  async req(method: string, path: string, body?: unknown) {
    const headers: Record<string, string> = {};
    if (this.cookie) headers.cookie = this.cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${url}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    return res;
  }
  /** Sign in the way the site does: a challenge, a wallet signature, a session cookie. */
  async signIn(identity: { address: string; privateKey: string }) {
    const challenge = await (await this.req('POST', '/api/auth/challenge', { scheme: 'eip191' })).json() as { nonce: string; message: string };
    const res = await this.req('POST', '/api/auth/wallet', {
      address: identity.address, nonce: challenge.nonce, signature: personalSign(challenge.message, identity.privateKey),
    });
    assert.equal(res.status, 200, 'the fixture must be able to sign in');
    return this;
  }
}

before(async () => {
  const cfg: NodeConfig = defaultConfig({ home: join(tmp, 'N'), name: 'keys-node', port: PORT, peers: [], roles: ['seller'], ledger: 'local' });
  cfg.runtime = { repo: undefined, api: 'http://127.0.0.1:1', hookApi: 'http://127.0.0.1:1' };
  cfg.host = '127.0.0.1'; cfg.publicUrl = `http://127.0.0.1:${PORT}`;
  cfg.verifier = { quorum: 1, allowSelfAttest: true, intervalMs: 3_600_000, auto: false };
  cfg.gossipIntervalMs = 3_600_000;
  cfg.backends = [{ id: 'llm', modality: 'chat', upstream: 'http://127.0.0.1:1', models: ['m'] }];
  N = await startNode(cfg, { quiet: true, serveWeb: false });
  url = `http://127.0.0.1:${PORT}`;
});

after(async () => { await N?.stop(); rmSync(tmp, { recursive: true, force: true }); });

test('a signed-in visitor can create a key, and the secret comes back once', async () => {
  const me = await new Session().signIn(HUMAN);
  const res = await me.req('POST', '/api/keys', { label: 'laptop' });
  assert.equal(res.status, 200);
  const body = await res.json() as { api_key: string; prefix: string };
  assert.match(body.api_key, /^ainize-sk-/);

  const listed = await (await me.req('GET', '/api/keys')).json() as { keys: { prefix: string; label: string | null }[] };
  assert.equal(listed.keys.length, 1);
  assert.equal(listed.keys[0].label, 'laptop');
  assert.ok(!JSON.stringify(listed).includes(body.api_key),
    'the store keeps a hash; a list that could show the secret would mean it kept the secret');
});

test('the key works on the surface it was issued for', async () => {
  const me = await new Session().signIn(HUMAN);
  const { api_key } = await (await me.req('POST', '/api/keys')).json() as { api_key: string };
  const models = await fetch(`${url}/v1/models`, { headers: { authorization: `Bearer ${api_key}` } });
  assert.equal(models.status, 200);
});

test('a signed-out visitor cannot create one', async () => {
  const res = await new Session().req('POST', '/api/keys');
  assert.equal(res.status, 401, 'a key is an identity; anonymous callers use the free tier');
});

test('a signed-out visitor cannot list one', async () => {
  assert.equal((await new Session().req('GET', '/api/keys')).status, 401);
});

test('one address never sees another address keys', async () => {
  const me = await new Session().signIn(HUMAN);
  await me.req('POST', '/api/keys', { label: 'mine' });
  const them = await new Session().signIn(STRANGER);
  const listed = await (await them.req('GET', '/api/keys')).json() as { keys: unknown[] };
  assert.deepEqual(listed.keys, [], 'the list is of the caller, not of the node');
});

test('a revoked key stops working immediately', async () => {
  const me = await new Session().signIn(HUMAN);
  const { api_key } = await (await me.req('POST', '/api/keys', { label: 'doomed' })).json() as { api_key: string };
  const before = await fetch(`${url}/v1/models`, { headers: { authorization: `Bearer ${api_key}` } });
  assert.equal(before.status, 200);

  const listed = await (await me.req('GET', '/api/keys')).json() as { keys: { prefix: string; label: string | null }[] };
  const doomed = listed.keys.find((k) => k.label === 'doomed')!;
  assert.equal((await me.req('DELETE', `/api/keys/${doomed.prefix}`)).status, 200);

  const after = await fetch(`${url}/v1/models`, { headers: { authorization: `Bearer ${api_key}` } });
  assert.equal(after.status, 401, 'revoking that does not take effect is not revoking');
});

test('one address cannot revoke another address key', async () => {
  const me = await new Session().signIn(HUMAN);
  const { api_key } = await (await me.req('POST', '/api/keys', { label: 'safe' })).json() as { api_key: string };
  const listed = await (await me.req('GET', '/api/keys')).json() as { keys: { prefix: string; label: string | null }[] };
  const mine = listed.keys.find((k) => k.label === 'safe')!;

  const them = await new Session().signIn(STRANGER);
  const res = await them.req('DELETE', `/api/keys/${mine.prefix}`);
  assert.notEqual(res.status, 200, 'a prefix is not a capability to revoke');

  const still = await fetch(`${url}/v1/models`, { headers: { authorization: `Bearer ${api_key}` } });
  assert.equal(still.status, 200, 'and the key must still work');
});

test('revoking something that is not there is 404, not a silent success', async () => {
  const me = await new Session().signIn(HUMAN);
  assert.equal((await me.req('DELETE', '/api/keys/deadbeef')).status, 404);
});

test('a label is optional, and a very long one is refused rather than stored', async () => {
  const me = await new Session().signIn(HUMAN);
  assert.equal((await me.req('POST', '/api/keys')).status, 200);
  assert.equal((await me.req('POST', '/api/keys', { label: 'x'.repeat(500) })).status, 400);
});
