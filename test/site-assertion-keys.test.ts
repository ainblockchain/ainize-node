/**
 * A Google account the site signed in can hold an API key, because the site vouches for it to the node.
 *
 * The node does not check Google itself; the site did. What the node checks is that the vouching is real: signed
 * with the secret it shares with the site, recent, and naming a Google subject, never an address.
 *
 *   node --test --import tsx test/site-assertion-keys.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, type NodeConfig } from '@ainize/core';
import { startNode, type RunningNode } from '../src/server.js';
import { SITE_ASSERTION_SECRET_FILE, SITE_SUBJECT_HEADER, signSiteSubject, verifySiteSubject } from '../src/site-assertion.js';

const tmp = mkdtempSync(join(tmpdir(), 'ainize-site-keys-'));
const SECRET = 'a'.repeat(24) + 'site-secret-for-tests-only';
const PORT_WITH = 24270;
const PORT_WITHOUT = 24271;
const now = () => Math.floor(Date.now() / 1000);

let WITH: RunningNode;
let WITHOUT: RunningNode;

function config(name: string, port: number): NodeConfig {
  const cfg = defaultConfig({ home: join(tmp, name), name, port, peers: [], roles: ['seller'], ledger: 'local' });
  cfg.runtime = { repo: undefined, api: 'http://127.0.0.1:1', hookApi: 'http://127.0.0.1:1' };
  cfg.host = '127.0.0.1'; cfg.publicUrl = `http://127.0.0.1:${port}`;
  cfg.verifier = { quorum: 1, allowSelfAttest: true, intervalMs: 3_600_000, auto: false };
  cfg.gossipIntervalMs = 3_600_000;
  cfg.backends = [{ id: 'llm', modality: 'chat', upstream: 'http://127.0.0.1:1', models: ['m'] }];
  return cfg;
}

before(async () => {
  mkdirSync(join(tmp, 'with'), { recursive: true });
  writeFileSync(join(tmp, 'with', SITE_ASSERTION_SECRET_FILE), `${SECRET}\n`);
  WITH = await startNode(config('with', PORT_WITH), { quiet: true, serveWeb: false, home: join(tmp, 'with') });
  mkdirSync(join(tmp, 'without'), { recursive: true });
  WITHOUT = await startNode(config('without', PORT_WITHOUT), { quiet: true, serveWeb: false, home: join(tmp, 'without') });
});

after(async () => { await WITH?.stop(); await WITHOUT?.stop(); rmSync(tmp, { recursive: true, force: true }); });

const vouched = (subject: string, at = now(), secret = SECRET) => ({ [SITE_SUBJECT_HEADER]: signSiteSubject(secret, subject, at) });
const keys = (port: number, method: string, headers: Record<string, string>, path = '/api/keys') =>
  fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: method === 'POST' ? '{"label":"g"}' : undefined });

test('a Google account the site vouches for can create a key, and the key works', async () => {
  const res = await keys(PORT_WITH, 'POST', vouched('google:1111'));
  assert.equal(res.status, 200);
  const { api_key } = await res.json() as { api_key: string };
  assert.match(api_key, /^ainize-sk-/);
  const models = await fetch(`http://127.0.0.1:${PORT_WITH}/v1/models`, { headers: { authorization: `Bearer ${api_key}` } });
  assert.equal(models.status, 200);
});

test('each Google account sees only its own keys, and can revoke them', async () => {
  const { api_key } = await (await keys(PORT_WITH, 'POST', vouched('google:2222'))).json() as { api_key: string };
  const other = await (await keys(PORT_WITH, 'GET', vouched('google:3333'))).json() as { keys: unknown[] };
  assert.deepEqual(other.keys, []);
  const mine = await (await keys(PORT_WITH, 'GET', vouched('google:2222'))).json() as { keys: { prefix: string }[] };
  assert.equal(mine.keys.length, 1);
  assert.equal((await keys(PORT_WITH, 'DELETE', vouched('google:3333'), `/api/keys/${mine.keys[0].prefix}`)).status, 404,
    'another Google account cannot revoke it');
  assert.equal((await keys(PORT_WITH, 'DELETE', vouched('google:2222'), `/api/keys/${mine.keys[0].prefix}`)).status, 200);
  const after = await fetch(`http://127.0.0.1:${PORT_WITH}/v1/models`, { headers: { authorization: `Bearer ${api_key}` } });
  assert.equal(after.status, 401);
});

test('a header signed with the wrong secret is not an identity', async () => {
  assert.equal((await keys(PORT_WITH, 'POST', vouched('google:1111', now(), 'b'.repeat(40)))).status, 401);
});

test('an old assertion is refused', async () => {
  assert.equal((await keys(PORT_WITH, 'POST', vouched('google:1111', now() - 600))).status, 401);
});

test('the site can vouch for a Google account, never for an address', async () => {
  const addr = '0x075cf9b40b1e8c3779b6704997de16ee05fb5481';
  assert.equal((await keys(PORT_WITH, 'POST', vouched(addr))).status, 401,
    'an address is proved by its own signature; the site asserting one would let it spend a deposit');
});

test('a node without the secret ignores the header entirely', async () => {
  assert.equal((await keys(PORT_WITHOUT, 'POST', vouched('google:1111'))).status, 401);
});

test('verifySiteSubject rejects malformed values without throwing', () => {
  for (const v of ['', 'x', 'google:1.2', 'google:1.abc.def', `google:1.${now()}.${'0'.repeat(63)}`, 'a.b.c.d']) {
    assert.equal(verifySiteSubject(v, SECRET), null, v);
  }
  assert.equal(verifySiteSubject(signSiteSubject(SECRET, 'google:9', now()), null), null, 'no secret, no identity');
  assert.equal(verifySiteSubject(signSiteSubject(SECRET, 'google:9', now()), SECRET), 'google:9');
});

test('the signing format matches the one ainize-web writes (the same vector is pinned there)', () => {
  assert.equal(signSiteSubject('s'.repeat(32), 'google:1234567890', 1790000000), 'google:1234567890.1790000000.c2a430649d5c90d92d7243695f1d2e0f397316959d796104dafeb2f7ad8dee3a');
});
