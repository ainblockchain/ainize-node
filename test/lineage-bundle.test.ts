/**
 * AZ-312 / AZ-313 / AZ-314 — buying a knowledge that stands on someone else's (design §8.7, §11 example 7, §12.4).
 *
 * Three in-process nodes on a local ledger, the same shape the demo cluster has: A publishes a base, B publishes an
 * add-on trained on top of it (`base.export: 'delta'`), C is the buyer and holds neither. What is asserted is what a
 * buyer is promised: the seller's 402 names the family, one `?bundle=1` purchase produces ONE settlement per
 * knowledge on the node that sold it, the total is what actually moved, and the base's author is paid twice — once
 * for the base, and again out of the child's sale.
 *
 * There is no serving model in a unit test, so the loading half stops where the runtime begins: `applyPatch` on the
 * child refuses with `needs_base` before it ever looks at the model (the order itself is proven on a live hook by
 * packages/e2e/scripts/bundle-buy-proof.mjs and in runtime-stack.test.ts).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, type NodeConfig } from '@ainize/core';
import { startNode, type RunningNode } from '../src/server.js';
import { synthPatch } from '../src/seed.js';

const tmp = mkdtempSync(join(tmpdir(), 'ngram-bundle-'));
const mk = (name: string, port: number, peers: string[], roles: NodeConfig['roles']): NodeConfig => {
  const cfg = defaultConfig({ home: join(tmp, name), name, port, peers, roles, ledger: 'local' });
  cfg.runtime = { repo: undefined, api: 'http://127.0.0.1:1' };   // no runtime → hash-only attestations
  cfg.gossipIntervalMs = 300;
  // this suite publishes `visibility: 'test'` anchors and expects them verified (item 332 makes that opt-in)
  cfg.verifier = { quorum: 2, allowSelfAttest: false, intervalMs: 400, includeTest: true };
  cfg.publicUrl = `http://127.0.0.1:${port}`;
  cfg.host = '127.0.0.1';
  return cfg;
};

let A: RunningNode, B: RunningNode, C: RunningNode;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => Promise<T>, pred: (v: T) => boolean, ms = 30000): Promise<T> {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (pred(v)) return v; if (Date.now() - t0 > ms) return v; await sleep(200); }
}

const BASE_ID = 'bundle-base';
const CHILD_ID = 'bundle-addon';
const bench = (schema: string) => ({ schema, queries: 10, format: ['template'], collateral_bound_nat: 0.1 });

before(async () => {
  A = await startNode(mk('A', 34101, [], ['seller', 'verifier']), { quiet: true, serveWeb: false });
  B = await startNode(mk('B', 34102, ['http://127.0.0.1:34101'], ['seller', 'verifier']), { quiet: true, serveWeb: false });
  C = await startNode(mk('C', 34103, ['http://127.0.0.1:34101', 'http://127.0.0.1:34102'], ['verifier']), { quiet: true, serveWeb: false });
});
after(async () => { await Promise.all([A, B, C].map((n) => n?.stop())); rmSync(tmp, { recursive: true, force: true }); });

test('AZ-312 a knowledge published on top of another names it as a base, and the 402 says what the family costs', async () => {
  const baseFile = synthPatch(join(tmp, 'synth'), 'bundle-base', 11, 400);
  const base = await A.market.createDraft({ id: BASE_ID, name: 'Bundle base', model: { id_M: 'M' }, benchmark: bench('bundle/base'), price: '4', file: baseFile, keepInPlace: true });
  await A.market.announce(BASE_ID);
  // B can only declare a base it can see: the anchor reaches it by gossip, not by being told about it.
  await waitFor(() => B.market.catalog(true), (c) => !!c.find((e) => e.anchor.id === BASE_ID));

  const childFile = synthPatch(join(tmp, 'synth'), 'bundle-addon', 12, 200, baseFile);
  await B.market.createDraft({
    id: CHILD_ID, name: 'Bundle add-on', model: { id_M: 'M' }, benchmark: bench('bundle/addon'), price: '6', file: childFile, keepInPlace: true,
    parents: [BASE_ID],
    base: { stack: [{ patch_id: BASE_ID, patch_sha256: base.patch_sha256 }], export: 'delta', pre_state_sha256: '0'.repeat(64) },
    derivation: { kind: 'extend', bases: [{ patch_id: BASE_ID, patch_sha256: base.patch_sha256, rows: 400 }], added_rows: 200, changed_rows: 0, removed_rows: 0 },
  });
  await B.market.announce(CHILD_ID);
  await waitFor(() => A.market.catalog(true), (c) => c.find((e) => e.anchor.id === BASE_ID)?.quorum_ok === true);
  await waitFor(() => B.market.catalog(true), (c) => c.find((e) => e.anchor.id === CHILD_ID)?.quorum_ok === true);

  // The seller's own 402, to a stranger with no node: the family and its LIST price (§12.4).
  const r = await fetch(`${B.url}/x402/patch/${CHILD_ID}`);
  assert.equal(r.status, 402);
  const body = await r.json() as { requirements: { requires: { id: string; price: string; depth: number }[]; total: string; self_contained: boolean }[] };
  const req = body.requirements[0];
  assert.deepEqual(req.requires.map((x) => x.id), [BASE_ID], 'the 402 names the base underneath it');
  assert.equal(req.requires[0].price, '4');
  assert.equal(req.total, '10', 'child 6 + base 4 — the price of the family, not of the file');
  assert.equal(req.self_contained, false);

  // The buyer's own node subtracts what it already holds; C holds nothing, so its quote is the same 10.
  await waitFor(() => C.market.catalog(true), (c) => c.find((e) => e.anchor.id === CHILD_ID)?.quorum_ok === true);
  const quote = await C.market.quoteFor((await C.market.entry(CHILD_ID))!);
  assert.deepEqual(quote.missing, [BASE_ID]);
  assert.equal(quote.total, '10');
  assert.equal(quote.export, 'delta');
});

test('AZ-313 one bundle purchase, two settlements, and the base is paid twice', async () => {
  const before = await C.market.creditBalance(C.cfg.identity.address);
  const res = await C.market.buy(CHILD_ID, { withRequired: true });

  // One settlement per knowledge, each on the node that sold it (§12.4: "one settle per purchase").
  assert.deepEqual((res.purchases ?? []).map((p) => p.patch_id), [BASE_ID, CHILD_ID], 'the base is bought FIRST');
  assert.equal(res.total, '10', 'what actually moved, both purchases together');
  const baseSetts = await A.ledger.settlements(BASE_ID);
  const childSetts = await B.ledger.settlements(CHILD_ID);
  assert.equal(baseSetts.length, 1);
  assert.equal(childSetts.length, 1);
  assert.equal(baseSetts[0].body.amount, '4');
  assert.equal(childSetts[0].body.amount, '6');
  assert.ok(C.market.blobs.has(res.manifest.patch_sha256), 'the child body is here');
  assert.ok(C.market.blobs.has((await C.market.entry(BASE_ID))!.anchor.patch_sha256), 'and so is the base it needs');

  // §11 worked example 7: A is paid for its own sale AND out of the child's sale.
  const a = A.cfg.identity.address.toLowerCase();
  const paidForBase = Number(Object.entries(baseSetts[0].body.royalty).find(([addr]) => addr.toLowerCase() === a)?.[1] ?? 0);
  const paidFromChild = Number(Object.entries(childSetts[0].body.royalty).find(([addr]) => addr.toLowerCase() === a)?.[1] ?? 0);
  assert.ok(paidForBase > 0, `A is paid for the base itself: ${JSON.stringify(baseSetts[0].body.royalty)}`);
  // The child's sale pays A twice over, for two different reasons, and the numbers are §11's: the lineage pool
  // (price x the anchor's own royalty_share, split among the ancestor authors — here one) plus, because A is also
  // one of the nodes whose verification keeps the child on sale, its share of the verification fee.
  const childEntry = (await B.market.catalogAll()).find((e) => e.anchor.id === CHILD_ID)!;
  const pool = 6 * 0.3;
  const fee = (6 - pool) * 0.05 / childEntry.verifiers.length;
  assert.ok(childEntry.verifiers.map((v) => v.toLowerCase()).includes(a), 'A verified the child as well as authoring its base');
  assert.equal(Math.round(paidFromChild * 1e6) / 1e6, Math.round((pool + fee) * 1e6) / 1e6, 'lineage pool + its slice of the verification fee');
  // Nothing is created out of thin air on either sale.
  const sum = (r: Record<string, string>) => Math.round(Object.values(r).reduce((n, x) => n + Number(x), 0) * 1e6) / 1e6;
  assert.equal(sum(baseSetts[0].body.royalty), 4);
  assert.equal(sum(childSetts[0].body.royalty), 6);
  const after = await waitFor(() => C.market.creditBalance(C.cfg.identity.address), (b) => b < before);
  assert.ok(before - after > 0, 'the buyer paid');

  // A second bundle buy charges nothing: both receipts already exist (item 271).
  const again = await C.market.buy(CHILD_ID, { withRequired: true });
  assert.equal(again.total, '0');
  assert.equal((await A.ledger.settlements(BASE_ID)).length, 1);
  assert.equal((await B.ledger.settlements(CHILD_ID)).length, 1);
});

test('AZ-314 loading the add-on alone is refused by name, and `bundle` is read from the query as well as the body', async () => {
  // The refusal happens on the PLAN, before the model is consulted — which is why it can be asserted with no runtime.
  await assert.rejects(() => C.market.applyPatch(CHILD_ID, 'test'), (e: Error & { details?: { missing?: string[] } }) => {
    assert.match(e.message, /^needs_base/);
    assert.deepEqual(e.details?.missing, [BASE_ID]);
    return true;
  });
  // §12.4 spells the flag `?bundle=1`. C has already bought both, so this asserts the route reads the query and
  // charges nothing — not a second sale.
  const claim = await fetch(`${C.url}/api/auth/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'bundle-pass' }) });
  const token = (await claim.json() as { token?: string }).token;
  assert.ok(token, 'operator session');
  const r = await fetch(`${C.url}/api/patches/${CHILD_ID}/buy?bundle=1`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' });
  const text = await r.text();
  assert.equal(r.status, 200, text);
  const out = JSON.parse(text) as { total: string; redeemed?: boolean };
  assert.equal(out.total, '0', 'already paid for — collected, not bought again');
});
