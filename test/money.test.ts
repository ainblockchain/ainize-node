/**
 * The money path: what a price of 0 costs, who a token lets in, what a receipt says and what a seller may buy.
 *
 * Findings 277 / 280 / 345 / 351 / 365 / 194 (docs/ux-critique-4.json, ux-critique-3.json). Three in-process nodes
 * on the local ledger, the same shape as the demo cluster: A sells, B verifies, C buys. Nothing here needs a model —
 * every anchor is verified hash-only — so what is asserted is the CONTRACT: which HTTP answer the gate gives, which
 * records exist afterwards, and what the buyer is handed back.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIdentity, defaultConfig, type NodeConfig } from '@ngram/core';
import { startNode, type RunningNode } from '../src/server.js';
import { synthPatch } from '../src/seed.js';
import { authHeader } from '../src/p2p.js';

const tmp = mkdtempSync(join(tmpdir(), 'ngram-money-'));
const mk = (name: string, port: number, peers: string[], roles: NodeConfig['roles']): NodeConfig => {
  const cfg = defaultConfig({ home: join(tmp, name), name, port, peers, roles, ledger: 'local' });
  cfg.runtime = { repo: undefined, api: 'http://127.0.0.1:1' };   // no runtime → hash-only attestations
  cfg.gossipIntervalMs = 300;
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
const bench = (schema: string) => ({ schema, queries: 10, format: ['template'], collateral_bound_nat: 0.1 });

const FREE_ID = 'money-free';
const PAID_ID = 'money-paid';
let freeSha = '';
let paidSha = '';

before(async () => {
  A = await startNode(mk('A', 34121, [], ['seller', 'verifier']), { quiet: true, serveWeb: false });
  B = await startNode(mk('B', 34122, ['http://127.0.0.1:34121'], ['seller', 'verifier']), { quiet: true, serveWeb: false });
  C = await startNode(mk('C', 34123, ['http://127.0.0.1:34121', 'http://127.0.0.1:34122'], ['verifier']), { quiet: true, serveWeb: false });
  const freeFile = synthPatch(join(tmp, 'synth'), 'money-free', 21, 300);
  const paidFile = synthPatch(join(tmp, 'synth'), 'money-paid', 22, 300);
  freeSha = (await A.market.createDraft({ id: FREE_ID, name: 'Free lesson', model: { id_M: 'M' }, benchmark: bench('money/free'), price: '0', file: freeFile, keepInPlace: true })).patch_sha256;
  paidSha = (await A.market.createDraft({ id: PAID_ID, name: 'Paid lesson', model: { id_M: 'M' }, benchmark: bench('money/paid'), price: '4', file: paidFile, keepInPlace: true })).patch_sha256;
  await A.market.announce(FREE_ID);
  await A.market.announce(PAID_ID);
  await waitFor(() => A.market.catalog(true), (c) => c.find((e) => e.anchor.id === FREE_ID)?.quorum_ok === true && c.find((e) => e.anchor.id === PAID_ID)?.quorum_ok === true);
  await waitFor(() => C.market.catalog(true), (c) => c.find((e) => e.anchor.id === FREE_ID)?.quorum_ok === true && c.find((e) => e.anchor.id === PAID_ID)?.quorum_ok === true);
});
after(async () => { await Promise.all([A, B, C].map((n) => n?.stop())); rmSync(tmp, { recursive: true, force: true }); });

// ---------------------------------------------------------------- item 277 / 351: free is free
test('277 a knowledge priced 0 is handed over with no 402, no nonce, no signature and no name', async () => {
  const r = await fetch(`${A.url}/x402/patch/${FREE_ID}`);
  assert.equal(r.status, 200, 'no Payment Required for something that costs nothing');
  const m = await r.json() as { patch_sha256: string; download_token: string; issued_to: string };
  assert.equal(m.patch_sha256, freeSha);
  assert.equal(m.download_token, '', 'no bearer token: there is nothing to gate');
  assert.equal(m.issued_to, '', 'and nobody is named as the taker');
  assert.equal(r.headers.get('x-payment-response'), JSON.stringify({ settled: false, free: true, price: '0', reason: 'price 0: nothing was charged and no sale was recorded' }));
  // the paid one is unchanged: still a 402 with a quote
  const p = await fetch(`${A.url}/x402/patch/${PAID_ID}`);
  assert.equal(p.status, 402);
});

test('277 the free body is fetchable by a stranger with no purchase, and the paid one is not', async () => {
  const stranger = createIdentity();
  const free = await fetch(`${A.url}/p2p/blob/${freeSha}`, { headers: { 'x-ngram-auth': authHeader(stranger, `blob:${freeSha}`) } });
  assert.equal(free.status, 200);
  const paid = await fetch(`${A.url}/p2p/blob/${paidSha}`, { headers: { 'x-ngram-auth': authHeader(stranger, `blob:${paidSha}`) } });
  assert.equal(paid.status, 402);
});

test('277 buying a free knowledge writes no settlement, names no buyer and is counted as a download', async () => {
  const before = A.market.freeDownloads(FREE_ID)[0]?.count ?? 0;
  const res = await C.market.buy(FREE_ID);
  assert.equal(res.scheme, 'free');
  assert.equal(res.amount, '0');
  assert.equal((await A.ledger.settlements(FREE_ID)).length, 0, 'no public record of who took it');
  assert.equal(C.market.store.getPurchase(FREE_ID)?.scheme, 'free');
  assert.equal(C.market.licenseOf((await C.market.entry(FREE_ID))!)?.source, 'free');
  const after = A.market.freeDownloads(FREE_ID)[0]?.count ?? 0;
  assert.ok(after > before, `the seller counts it as a download (${before} → ${after})`);
  // …and asking again is still free, with no second record
  const again = await C.market.buy(FREE_ID);
  assert.equal(Number(again.total ?? again.amount), 0);
  assert.equal((await A.ledger.settlements(FREE_ID)).length, 0);
});
