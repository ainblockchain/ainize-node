/**
 * The trust rules, end to end on three in-process nodes (critique 2, items 146 / 153 / 127):
 *   - an author cannot attest its own anchor, through the API or the verifier, and an attestation
 *     already on the ledger stops counting;
 *   - a challenge takes the knowledge off sale (402 gate → 423, `buy` refuses) and can be answered
 *     by a verifier that had already attested, which puts it back on sale;
 *   - nothing a node writes claims a deposit.
 * Verification is driven by hand (`verifier.auto: false`) so the automatic round cannot race the assertions.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, signMessage, type Attestation, type NodeConfig } from '@ainize/core';
import { startNode, type RunningNode } from '../src/server.js';
import { synthPatch } from '../src/seed.js';

const tmp = mkdtempSync(join(tmpdir(), 'ngram-trust-'));
const PORT = { A: 34061, B: 34062, C: 34063 };   // 3406x is this file's range (chat.test.ts owns 34031, ain.test.ts 34031-2)
const mk = (name: string, port: number, peers: string[], roles: NodeConfig['roles']): NodeConfig => {
  const cfg = defaultConfig({ home: join(tmp, name), name, port, peers, roles, ledger: 'local' });
  cfg.runtime = { repo: undefined, api: 'http://127.0.0.1:1' };   // no runtime → hash-only attestations
  cfg.gossipIntervalMs = 300;
  // this suite publishes `visibility: 'test'` anchors and expects them verified (item 332 makes that opt-in)
  cfg.verifier = { quorum: 2, allowSelfAttest: false, intervalMs: 400, auto: false, includeTest: true };
  cfg.publicUrl = `http://127.0.0.1:${port}`;
  cfg.host = '127.0.0.1';
  return cfg;
};
let A: RunningNode, B: RunningNode, C: RunningNode;
let token = '';
const PATCH = 'trust-1';
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
  token = randomBytes(16).toString('hex');
  A.store.putSession(token, 3600_000);
  const file = synthPatch(join(tmp, 'blobs'), PATCH, 7, 64);
  await A.market.createDraft({ id: PATCH, name: 'trust probe', model: { id_M: 'demo-ainize-1b' }, benchmark: { schema: 'trust', queries: 1, format: ['template'] }, price: '1', file });
  await A.market.announce(PATCH);
  // B and C verify for real (hash-only here: no runtime in tests) → LISTED on every node
  await waitFor(() => B.market.entry(PATCH), (e) => !!e);
  await B.verifier!.verifyOne((await entry(B)).anchor);
  await waitFor(() => C.market.entry(PATCH), (e) => !!e);
  await C.verifier!.verifyOne((await entry(C)).anchor);
  await waitFor(() => entry(A), (e) => e.status === 'LISTED');
});
after(async () => { await Promise.all([A, B, C].map((n) => n?.stop())); rmSync(tmp, { recursive: true, force: true }); });

test('item 146: the author cannot attest its own anchor — API 409, verifier 409, and the record would not count anyway', async () => {
  const e0 = await entry(A);
  assert.equal(e0.status, 'LISTED');
  assert.equal(e0.passed, 2);
  assert.equal(e0.self_checks, 0);

  // the one-click button on the author's own manage page
  const r = await fetch(`http://127.0.0.1:${PORT.A}/api/patches/${PATCH}/verify`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  assert.equal(r.status, 409);
  const body = await r.json() as { error: string };
  assert.match(body.error, /cannot verify your own knowledge/);
  assert.match(body.error, /allowSelfAttest/);

  // `ainize patch verify` goes through the same path
  await assert.rejects(A.verifier!.verifyOne(e0.anchor), /cannot verify your own knowledge/);
  // and no attestation was appended by either attempt
  assert.equal((await A.ledger.attestations(PATCH)).length, 2);

  // an attestation that reached the ledger another way (an older build, or a peer's record on a shared chain)
  // stays on the record and stops counting
  const forged: Attestation = {
    patch_id: PATCH, verifier: A.cfg.identity.address, verifier_name: 'A', patch_sha256: e0.anchor.patch_sha256,
    benchmark_hash: e0.anchor.benchmark_hash, score: { integrity: 'sha256 ok' }, passed: true, verified_on: 'hash-only', created_at: Date.now(), sig: '',
  };
  forged.sig = signMessage(JSON.stringify([forged.patch_id, forged.patch_sha256, forged.benchmark_hash, forged.passed, forged.score]), A.cfg.identity.privateKey);
  await A.ledger.append('attest', forged);
  A.market.invalidate();
  const e1 = await entry(A);
  assert.equal(e1.attestations.length, 3, 'the record is permanent — it is still shown');
  assert.equal(e1.passed, 2, 'but it does not count');
  assert.equal(e1.self_checks, 1);
  assert.equal(e1.quorum_ok, true);
  assert.equal(e1.sellable, true);
});

test('item 153: a challenge stops the sale on the gateway and in `buy`, with the reason', async () => {
  await C.market.challenge(PATCH, 'the ticker codes are wrong');
  const e = await waitFor(() => entry(A), (x) => x.status === 'CHALLENGED');
  assert.equal(e.status, 'CHALLENGED');
  // item 330: the records that listed it were written BEFORE the challenge, so they answer nothing. The entry reads
  // CHALLENGED because it WAS on sale; the count it shows is what has been measured since, which is nothing yet.
  assert.equal(e.quorum_ok, false);
  assert.equal(e.passed, 0);
  assert.equal(e.stale_attestations, 2);
  assert.equal(e.sellable, false);
  assert.equal(e.open_challenge?.reason, 'the ticker codes are wrong');
  assert.equal(e.open_challenge?.challenger, C.cfg.identity.address);

  const gate = await fetch(`http://127.0.0.1:${PORT.A}/x402/patch/${PATCH}`);
  assert.equal(gate.status, 423);
  const body = await gate.json() as { error: string };
  assert.match(body.error, /challenged/);
  assert.match(body.error, /the ticker codes are wrong/);

  await waitFor(() => entry(B), (x) => x.status === 'CHALLENGED');
  await assert.rejects(B.market.buy(PATCH), /challenged/);
  assert.equal((await A.ledger.settlements(PATCH)).length, 0);
});

test('items 153 + 330: a QUORUM of re-runs answers the challenge — one is not enough, and the challenger\u2019s own stale record never fills the gap', async () => {
  const b = await entry(B);
  const before = b.attestations.find((a) => a.verifier === B.cfg.identity.address)!;
  await B.verifier!.verifyOne(b.anchor);           // re-verification: allowed now, and it counts
  const one = await waitFor(() => entry(A), (x) => x.passed === 1);
  assert.equal(one.status, 'CHALLENGED', 'one fresh PASS does not clear a challenge at quorum 2');
  assert.equal(one.sellable, false);
  assert.ok(one.open_challenge, 'the challenge is still open');
  assert.equal(one.stale_attestations, 1, "the challenger's own pre-challenge record is not counted");

  // the challenger re-runs it too: NOW the quorum has been re-established since the challenge, and the sale resumes
  const c = await entry(C);
  await C.verifier!.verifyOne(c.anchor);
  const after = await waitFor(() => entry(A), (x) => x.status === 'LISTED');
  assert.equal(after.status, 'LISTED');
  assert.equal(after.sellable, true);
  assert.equal(after.open_challenge, undefined);
  assert.equal(after.challenge_log[0].state, 'dismissed');
  assert.equal(after.attestations.length, 3, 'still one attestation per verifier (plus the excluded self-check)');
  const now = after.attestations.find((a) => a.verifier === B.cfg.identity.address)!;
  assert.ok(now.created_at > before.created_at, 'the newer attestation replaced the pre-challenge one');
  const gate = await fetch(`http://127.0.0.1:${PORT.A}/x402/patch/${PATCH}`);
  assert.equal(gate.status, 402);

  // …and with no challenge open, a second attestation by the same verifier is refused instead of printing PASS
  await assert.rejects(B.verifier!.verifyOne(b.anchor), /already attested/);
});

test('item 127: no attestation and no challenge this node writes carries a stake', async () => {
  for (const rec of await A.ledger.attestations(PATCH)) assert.equal(rec.body.stake, undefined, JSON.stringify(rec.body));
  for (const rec of await A.ledger.challenges(PATCH)) assert.equal(rec.body.stake, undefined, JSON.stringify(rec.body));
  const cat = await (await fetch(`http://127.0.0.1:${PORT.A}/api/catalog`)).json() as { items: { anchor: { id: string }; attestations: { stake?: string }[] }[] };
  const e = cat.items.find((x) => x.anchor.id === PATCH)!;
  assert.ok(e.attestations.every((a) => a.stake === undefined));
});
