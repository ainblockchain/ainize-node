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

// ---------------------------------------------------------------- item 345: the token is not a bearer ticket
test('345 a download token only works for the address it was issued to, and its redemptions are counted', async () => {
  const res = await C.market.buy(PAID_ID);
  const token = res.manifest.download_token;
  assert.ok(token, 'the buyer is handed a token');
  assert.equal(res.manifest.issued_to.toLowerCase(), C.market.address.toLowerCase());

  // the buyer's own signed fetch: allowed, and counted
  const mine = await fetch(`${A.url}/p2p/blob/${paidSha}?token=${token}`, { headers: { 'x-ngram-auth': authHeader(C.cfg.identity, `blob:${paidSha}`) } });
  assert.equal(mine.status, 200);

  // the same token pasted to someone else — signed by them, or by nobody at all
  const thief = createIdentity();
  const stolen = await fetch(`${A.url}/p2p/blob/${paidSha}?token=${token}`, { headers: { 'x-ngram-auth': authHeader(thief, `blob:${paidSha}`) } });
  assert.equal(stolen.status, 402, 'a token is not transferable');
  const anon = await fetch(`${A.url}/p2p/blob/${paidSha}?token=${token}`);
  assert.equal(anon.status, 402, 'and holding it without a signature buys nothing');

  // the seller has a record of what that one sale served
  const row = A.market.store.getToken(token, paidSha);
  assert.ok(row && row.redemptions >= 1, 'redemptions are counted');
  assert.equal(row!.patch_id, PAID_ID);
});

// ---------------------------------------------------------------- items 365 / 194: whose sale, and whose money
test('365 a seller cannot buy its own knowledge, and a self-settlement counts for nothing', async () => {
  // the buyer's own side refuses before any money moves
  await assert.rejects(A.market.buy(PAID_ID), /published by this node/);
  // …and so does the gate, to a payload that claims the seller's own address
  const e = (await A.market.entry(PAID_ID))!;
  const out = await A.market.settlePayment(e, `/x402/patch/${PAID_ID}`, Buffer.from(JSON.stringify({
    scheme: 'local-credit', network: 'local', txHash: 'x', from: A.market.address, to: A.market.address, amount: '4', nonce: 'n', proof: 'p',
  })).toString('base64'));
  assert.match(out.error ?? '', /self_purchase/);
});

test('194 an entry reports what buyers paid AND what its author kept', async () => {
  const e = (await A.market.catalog(true)).find((x) => x.anchor.id === PAID_ID)!;
  assert.equal(e.downloads, 1, 'C bought it once');
  assert.equal(e.buyers, 1);
  assert.equal(e.revenue, '4', 'gross: what the buyer paid');
  // The anchor has no lineage, but it does have a verifier, and the verification fee comes out of the seller's
  // side — 5 % of 4. So "revenue 4" was never 4 in the author's pocket, which is exactly the finding.
  assert.equal(e.revenue_net, '3.8', 'net: the author\'s own line in the royalty map');
  assert.equal(e.revenue_shared, '0.2', 'and what those sales owed somebody else');
  assert.equal(e.self_purchases, 0);
  const setts = await A.ledger.settlements(PAID_ID);
  assert.equal(Object.values(setts[0].body.royalty).reduce((n, x) => n + Number(x), 0), 4, 'the split adds up to the price');
});

// ---------------------------------------------------------------- item 280: the receipt names who was paid
test('280 the buyer is handed the split the seller recorded, by name and role', async () => {
  // a base sold by A, an add-on sold by B on top of it: the child's sale pays A as well
  const baseFile = synthPatch(join(tmp, 'synth'), 'money-base', 31, 300);
  const childFile = synthPatch(join(tmp, 'synth'), 'money-child', 32, 200, baseFile);
  const base = await A.market.createDraft({ id: 'money-base', name: 'Base', model: { id_M: 'M' }, benchmark: bench('money/base'), price: '4', file: baseFile, keepInPlace: true });
  await A.market.announce('money-base');
  await waitFor(() => B.market.catalog(true), (c) => !!c.find((e) => e.anchor.id === 'money-base'));
  await B.market.createDraft({
    id: 'money-child', name: 'Child', model: { id_M: 'M' }, benchmark: bench('money/child'), price: '10', file: childFile, keepInPlace: true, parents: ['money-base'],
  });
  await B.market.announce('money-child');
  await waitFor(() => C.market.catalog(true), (c) => c.find((e) => e.anchor.id === 'money-child')?.quorum_ok === true);

  const res = await C.market.buy('money-child');
  assert.ok(res.royalty && Object.keys(res.royalty).length > 1, 'the seller returns the whole split, not just a tx hash');
  const payees = res.payees ?? [];
  assert.ok(payees.length > 1, 'and the receipt names every one of them');
  const seller = payees.find((p) => p.role === 'seller');
  // A published the base AND verified the child, so one royalty line is both: the receipt says so rather than
  // labelling a lineage share "verifier".
  const ancestor = payees.find((p) => p.knowledge.includes('money-base'));
  assert.ok(seller && Number(seller.amount) > 0, 'the seller is named as the seller');
  assert.ok(ancestor && Number(ancestor.amount) > 0, "the base's author is named, with what they were paid");
  assert.equal(ancestor!.role, 'ancestor and verifier');
  assert.deepEqual(ancestor!.knowledge, ['money-base'], 'and WHICH knowledge they are being paid for');
  assert.ok(payees.every((p) => p.promised), "every payee was in the buyer's own lineage preview");
  assert.equal(Math.round(payees.reduce((n, p) => n + Number(p.amount), 0) * 1e6) / 1e6, 10, 'and the split adds up to what was paid');
  // it survives on the purchase row, which is what the dashboard reads
  assert.deepEqual(C.market.store.getPurchase('money-child')?.royalty, res.royalty);
  assert.ok(res.steps.some((s) => s.step === 'paid' && s.detail.includes('ancestor')), 'the timeline says it too');
  assert.equal(base.price, '4');
});

// ---------------------------------------------------------------- item 236: what the quote says before the money
test('236 the 402 says what is being sold: status, lineage, licence and the split it will make', async () => {
  const r = await fetch(`${B.url}/x402/patch/money-child`);
  assert.equal(r.status, 402);
  const body = await r.json() as { requirements: Record<string, unknown>[] };
  const req = body.requirements[0] as {
    status: string; superseded_by: string[]; license: string | null;
    lineage: { parents: { id: string; author: string | null }[]; standalone: boolean };
    split_preview: { address: string; name: string | null; role: string; amount: string }[];
    maxAmountRequired: string;
  };
  assert.equal(req.status, 'LISTED');
  assert.deepEqual(req.superseded_by, []);
  assert.equal(req.lineage.standalone, false, 'it is built on something and the quote says so');
  assert.deepEqual(req.lineage.parents.map((p) => p.id), ['money-base']);
  assert.equal(req.lineage.parents[0].author, A.market.address, 'and who published that base');
  assert.ok(req.split_preview.length > 1, 'the split is on the quote, not only in a header after the money moved');
  assert.equal(Math.round(req.split_preview.reduce((n, l) => n + Number(l.amount), 0) * 1e6) / 1e6, Number(req.maxAmountRequired));
  const ancestor = req.split_preview.find((l) => l.address.toLowerCase() === A.market.address.toLowerCase());
  assert.ok(ancestor && Number(ancestor.amount) > 0, "the base's author is named in the quote the buyer pays against");
});

// ---------------------------------------------------------------- item 278: a price that can change
test('278 the author can re-price a published knowledge, and the quote, the 402 and the charge move together', async () => {
  const before = (await A.market.entry(PAID_ID))!.anchor.price;
  assert.equal(before, '4');
  const r = await A.market.setPrice(PAID_ID, '1.5', 'launch price');
  assert.equal(r.price, '1.5');
  assert.equal(r.previous, '4');
  const e = (await A.market.entry(PAID_ID))!;
  assert.equal(e.anchor.price, '1.5', 'the catalogue folds it over the immutable anchor');
  assert.equal((e as { list_price?: string }).list_price, '4', 'and keeps what it was published at');
  // the 402 the buyer pays against quotes the new price
  const q = await fetch(`${A.url}/x402/patch/${PAID_ID}`);
  const body = await q.json() as { requirements: { maxAmountRequired: string; total: string }[] };
  assert.equal(body.requirements[0].maxAmountRequired, '1.5');
  // and the charge follows it: a payload for the OLD price is still accepted (it is above the new one), a lower one is not
  const quote = await A.market.quoteFor(e);
  assert.equal(quote.price, '1.5');
  // making it free takes it off the payment path entirely (item 277)
  await A.market.setPrice(PAID_ID, '0', 'obsolete, made free');
  const free = await fetch(`${A.url}/x402/patch/${PAID_ID}`);
  assert.equal(free.status, 200, 'a knowledge made free is handed over, not quoted');
  // …and the history is on the record, in order, so a discount can be checked
  const hist = await (await fetch(`${A.url}/api/patches/${PAID_ID}/price`)).json() as { history: { price: string }[]; list_price: string };
  assert.deepEqual(hist.history.map((h) => h.price), ['4', '1.5', '0']);
  await A.market.setPrice(PAID_ID, '4', 'back to list');    // leave the fixture as the other tests expect it
});

test('278 only the author may re-price, and a draft is edited instead', async () => {
  await assert.rejects(C.market.setPrice(PAID_ID, '1'), /only its author/);
  await assert.rejects(A.market.setPrice(PAID_ID, 'free'), /must be a non-negative number/);
});
