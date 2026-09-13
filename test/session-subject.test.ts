/**
 * A session knows who it belongs to.
 *
 * It did not. The table was `(token, created_at, expires_at)` and the only reader was `hasSession(token) →
 * boolean`, so once anyone held a session the node could answer "is someone signed in" and nothing else. Every
 * route behind `requireOperator` therefore treated the operator and the node's own key as one identity, which
 * was true only because signing with that key was the only way in.
 *
 * That is the wall the wallet work hits: "bind this CLI key to my wallet" needs a subject for the binding to
 * point at. This file pins the subject — that sign-in records the address that actually signed, that a session
 * written before the column existed still works and still means the node's own key, and that a subject can be
 * listed and is never matched by case.
 *
 *   node --test --import tsx test/session-subject.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIdentity, defaultConfig, type NodeConfig } from '@ainize/core';
import { Store } from '../src/store.js';
import { startNode, type RunningNode } from '../src/server.js';
import { operatorToken } from './fixtures/operator.js';

const tmp = mkdtempSync(join(tmpdir(), 'ngram-session-'));
const PORT = 24111;
let N: RunningNode;
let url = '';
let identity: NodeConfig['identity'];

before(async () => {
  const cfg: NodeConfig = defaultConfig({ home: join(tmp, 'N'), name: 'N', port: PORT, peers: [], roles: ['seller'], ledger: 'local' });
  cfg.runtime = { repo: undefined, api: 'http://127.0.0.1:1', hookApi: 'http://127.0.0.1:1' };
  cfg.host = '127.0.0.1'; cfg.publicUrl = `http://127.0.0.1:${PORT}`;
  cfg.verifier = { quorum: 1, allowSelfAttest: true, intervalMs: 300_000, auto: false };
  cfg.gossipIntervalMs = 60_000;
  N = await startNode(cfg, { quiet: true, serveWeb: false });
  identity = cfg.identity;
  url = `http://127.0.0.1:${PORT}`;
});
after(async () => { await N?.stop(); rmSync(tmp, { recursive: true, force: true }); });

test('signing in records who signed, and how they proved it', async () => {
  const token = await operatorToken(url, identity);
  const row = N.store.getSession(token);
  assert.ok(row, 'the token the node just issued must name a live session');
  // The subject is the address that signed the challenge — not "the operator", which is the thing that used to
  // be all the node could say. On this node they happen to be the same address; the point is that the column
  // holds what was proved, so a wallet signing in later lands here as itself.
  assert.equal(row.subject, identity.address.toLowerCase());
  assert.equal(row.scheme, 'ain', "a key this product generated signed — that is not what a person at a wallet does");
});

test('a session written before the column existed still works, and still means the node', () => {
  const s = new Store(':memory:');
  // The two-argument call is exactly what the old code did, and what test fixtures still do. It must not throw
  // and must not start rejecting the sessions it wrote, because a node upgrading in place is full of them.
  const legacy = randomBytes(16).toString('hex');
  s.putSession(legacy, 3600_000);
  assert.ok(s.hasSession(legacy), 'an upgrade must not sign every operator out');
  const row = s.getSession(legacy);
  assert.equal(row?.subject, null, 'no subject was ever proved for this token, so the row must not invent one');
  assert.equal(row?.scheme, null);
  // Reading it as the node's own key is the API layer's decision, made once, where the node's address is known.
  // The store refuses to guess: that is what keeps the guess from silently becoming a second kind of truth.
});

test('an expired session has no subject, by the same clock that made it invalid', () => {
  const s = new Store(':memory:');
  const dead = randomBytes(16).toString('hex');
  s.putSession(dead, -1, { subject: '0xAAAA', scheme: 'ain' });
  assert.equal(s.hasSession(dead), false);
  assert.equal(s.getSession(dead), null, 'an expired token must not still answer "who is this"');
  assert.deepEqual(s.sessionsOf('0xaaaa'), [], 'nor may it show up in the list of devices you are signed in on');
});

test('a subject is one address whatever case it is written in', () => {
  const s = new Store(':memory:');
  const a = createIdentity(), b = createIdentity();
  const mine = [randomBytes(8).toString('hex'), randomBytes(8).toString('hex')];
  s.putSession(mine[0]!, 3600_000, { subject: a.address, scheme: 'ain' });            // checksummed, as a wallet reports it
  s.putSession(mine[1]!, 3600_000, { subject: a.address.toLowerCase(), scheme: 'eip191' });
  s.putSession(randomBytes(8).toString('hex'), 3600_000, { subject: b.address, scheme: 'ain' });

  // Addresses arrive checksummed from a wallet and lowercased from everywhere else. If those were two keys, a
  // person would sign in twice and see one device — and revoking the other would silently miss it.
  const rows = s.sessionsOf(a.address.toUpperCase());
  assert.deepEqual(rows.map((r) => r.token).sort(), [...mine].sort());
  assert.deepEqual(rows.map((r) => r.scheme).sort(), ['ain', 'eip191']);
  assert.equal(s.sessionsOf(b.address).length, 1, "another address's sessions are not yours");
});
