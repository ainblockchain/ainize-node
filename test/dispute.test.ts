/**
 * What a buyer can do, and what a buyer is told (critique 4, items 346 / 347).
 *
 *   - a settled buyer records that the knowledge did not work; the sale is NOT stopped, the seller answers on the
 *     same permanent record, and the seller's record counts it;
 *   - a node that never bought it cannot dispute it, and neither record can be written twice;
 *   - a challenge, a failed verification and a supersede reach the BUYER, not only the author — before this the
 *     notable-event scan skipped every entry this node did not write, so the person serving the answers had no
 *     signal at all.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, type NodeConfig } from '@ngram/core';
import { startNode, type RunningNode } from '../src/server.js';
import { synthPatch } from '../src/seed.js';

const tmp = mkdtempSync(join(tmpdir(), 'ngram-dispute-'));
const PORT = { A: 34071, B: 34072, C: 34073 };   // 3407x is this file's range
const mk = (name: string, port: number, peers: string[], roles: NodeConfig['roles']): NodeConfig => {
  const cfg = defaultConfig({ home: join(tmp, name), name, port, peers, roles, ledger: 'local' });
  cfg.runtime = { repo: undefined, api: 'http://127.0.0.1:1' };   // no runtime → hash-only attestations, no model calls
  cfg.gossipIntervalMs = 300;
  cfg.verifier = { quorum: 2, allowSelfAttest: false, intervalMs: 400, auto: false, includeTest: true };
  cfg.publicUrl = `http://127.0.0.1:${port}`;
  cfg.host = '127.0.0.1';
  return cfg;
};
let A: RunningNode, B: RunningNode, C: RunningNode;
let tokenB = '';
const PATCH = 'dispute-1';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => Promise<T>, pred: (v: T) => boolean, ms = 15000): Promise<T> {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (pred(v)) return v; if (Date.now() - t0 > ms) return v; await sleep(150); }
}
const entry = (n: RunningNode, id = PATCH) => n.market.entry(id).then((e) => e!);

before(async () => {
  A = await startNode(mk('A', PORT.A, [], ['seller', 'verifier']), { quiet: true, serveWeb: false });
  B = await startNode(mk('B', PORT.B, [`http://127.0.0.1:${PORT.A}`], ['verifier']), { quiet: true, serveWeb: false });
  C = await startNode(mk('C', PORT.C, [`http://127.0.0.1:${PORT.A}`], ['verifier']), { quiet: true, serveWeb: false });
  tokenB = randomBytes(16).toString('hex');
  B.store.putSession(tokenB, 3600_000);
  const file = synthPatch(join(tmp, 'blobs'), PATCH, 11, 64);
  await A.market.createDraft({ id: PATCH, name: 'disputed probe', model: { id_M: 'demo-ngram-1b' }, benchmark: { schema: 'dispute', queries: 1, format: ['template'] }, price: '1', file });
  await A.market.announce(PATCH);
  await waitFor(() => B.market.entry(PATCH), (e) => !!e);
  await B.verifier!.verifyOne((await entry(B)).anchor);
  await waitFor(() => C.market.entry(PATCH), (e) => !!e);
  await C.verifier!.verifyOne((await entry(C)).anchor);
  await waitFor(() => entry(A), (e) => e.status === 'LISTED');
  await waitFor(() => entry(B), (e) => e.sellable);
  await B.market.buy(PATCH);
});
after(async () => { await Promise.all([A, B, C].map((n) => n?.stop())); rmSync(tmp, { recursive: true, force: true }); });

test('item 347: a settled buyer records that it did not work — the sale stands, the seller answers on the record, and the record counts', async () => {
  // a node that never bought it has no standing
  await assert.rejects(C.market.dispute(PATCH, 'the answers are wrong on every question I tried'), /has not bought/);
  // and a dispute has to say something
  await assert.rejects(B.market.dispute(PATCH, 'bad'), /at least 20 characters/);

  const d = await B.market.dispute(PATCH, 'four of the eight answers are wrong on my model — this is not what the benchmark shows');
  assert.equal(d.role, 'claim');
  assert.equal(d.author, B.cfg.identity.address);
  assert.ok(d.settle_hash, 'the dispute names the settlement it is about');
  assert.ok(d.sig.length > 0);

  // it is NOT a challenge: the knowledge stays on sale and no verifier is asked for anything
  const onA = await waitFor(() => entry(A), (e) => B.market.disputesFor(PATCH).length > 0 || e.status === 'LISTED');
  assert.equal(onA.status, 'LISTED');
  assert.equal(onA.sellable, true);
  assert.equal(onA.open_challenge, undefined);

  // the same record, once
  await assert.rejects(B.market.dispute(PATCH, 'four of the eight answers are wrong on my model — this is not what the benchmark shows'), /already recorded a dispute/);

  // the seller answers it, and only the seller
  await waitFor(async () => A.market.disputesFor(PATCH), (l) => l.length > 0);
  await assert.rejects(C.market.dispute(PATCH, 'that is not what I measured at all here', { role: 'answer', settleHash: d.settle_hash }), /only the seller/);
  const answer = await A.market.dispute(PATCH, 'measured again on two nodes at 8/8 — please send the prompts you used', { role: 'answer', settleHash: d.settle_hash });
  assert.equal(answer.role, 'answer');

  const both = A.market.disputesFor(PATCH);
  assert.equal(both.length, 2);
  assert.deepEqual(both.map((x) => x.role).sort(), ['answer', 'claim']);
  const record = A.market.disputeRecordOf(A.cfg.identity.address);
  assert.deepEqual(record, { raised: 1, answered: 1, patches: [PATCH] });
});

test('item 346: a challenge on something this node BOUGHT reaches the buyer, not only the seller', async () => {
  const before = B.store.events({ kind: 'challenge', limit: 200 }).length;
  await C.market.challenge(PATCH, 'the ticker codes are wrong on half of the questions');
  await waitFor(() => entry(B), (e) => !!e.open_challenge);
  const events = await waitFor(async () => { await B.market.catalog(true); return B.store.events({ kind: 'challenge', limit: 200 }); }, (ev) => ev.length > before);
  const mine = events.find((e) => e.patch_id === PATCH);
  assert.ok(mine, 'the buyer was told');
  assert.equal(mine!.level, 'warn');
  assert.match(mine!.message, /which you bought/);
  assert.match(mine!.message, /the ticker codes are wrong/);
  // and it is said once, however many times the catalogue is derived
  await B.market.catalog(true); await B.market.catalog(true);
  assert.equal(B.store.events({ kind: 'challenge', limit: 200 }).filter((e) => e.patch_id === PATCH).length, events.filter((e) => e.patch_id === PATCH).length);
});
