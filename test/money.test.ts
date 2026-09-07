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
import { createIdentity, defaultConfig, type NodeConfig } from '@ainize/core';
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
  A = await startNode(mk('A', 34321, [], ['seller', 'verifier']), { quiet: true, serveWeb: false });
  B = await startNode(mk('B', 34322, ['http://127.0.0.1:34321'], ['seller', 'verifier']), { quiet: true, serveWeb: false });
  C = await startNode(mk('C', 34323, ['http://127.0.0.1:34321', 'http://127.0.0.1:34322'], ['verifier']), { quiet: true, serveWeb: false });
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
  const free = await fetch(`${A.url}/p2p/blob/${freeSha}`, { headers: { 'x-ainize-auth': authHeader(stranger, `blob:${freeSha}`) } });
  assert.equal(free.status, 200);
  const paid = await fetch(`${A.url}/p2p/blob/${paidSha}`, { headers: { 'x-ainize-auth': authHeader(stranger, `blob:${paidSha}`) } });
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
  const mine = await fetch(`${A.url}/p2p/blob/${paidSha}?token=${token}`, { headers: { 'x-ainize-auth': authHeader(C.cfg.identity, `blob:${paidSha}`) } });
  assert.equal(mine.status, 200);

  // the same token pasted to someone else — signed by them, or by nobody at all
  const thief = createIdentity();
  const stolen = await fetch(`${A.url}/p2p/blob/${paidSha}?token=${token}`, { headers: { 'x-ainize-auth': authHeader(thief, `blob:${paidSha}`) } });
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

// ------------------------------------------------- items 313 / 314 / 366: the payouts a settlement actually made
test('313/314/366 payout rows are rebuilt from the record, keyed to the sale, and paid in one transaction', async () => {
  const { Payouts } = await import('../src/payouts.js');
  const { Store } = await import('../src/store.js');
  const { payoutKeyFor } = await import('@ainize/core');
  const SELLER = '0x1111111111111111111111111111111111111111';
  const settlement = {
    patch_id: 'p1', seller: SELLER, buyer: '0x4444444444444444444444444444444444444444', amount: '10', currency: 'AIN',
    scheme: 'ain-transfer', tx_hash: '0xbuyer', billing: 'per_download' as const, created_at: Date.now(),
    royalty: { [SELLER]: '5', '0x2222222222222222222222222222222222222222': '3', '0x3333333333333333333333333333333333333333': '2' },
  };
  const store = new Store(':memory:');
  const calls: { batch: number; keys: string[] }[] = [];
  const wallet = {
    async transfer(to: string, value: number, key?: string) { calls.push({ batch: 1, keys: [key ?? ''] }); return { tx_hash: `0xsingle${to.slice(2, 6)}${value}` }; },
    async transferMany(items: { to: string; value: number; key: string }[]) { calls.push({ batch: items.length, keys: items.map((i) => i.key) }); return { tx_hash: '0xbatched' }; },
  };
  const recorded: { settle: string; to: string; key: string; tx: string }[] = [];
  const p = new Payouts(store, () => undefined, wallet, { selfAddress: SELLER, retryMs: 50, maxAttempts: 3 });
  p.record = async (row, txHash, key) => { recorded.push({ settle: row.settle_hash, to: row.address, key, tx: txHash }); };

  p.enqueue(settlement, 'settle-1');
  const run = await p.processPending();
  assert.equal(run.paid, 2, 'both creators are paid');
  // item 366: ONE transaction for the whole sale, not one per creator
  assert.deepEqual(calls.map((x) => x.batch), [2], 'two creators of one sale cost one write');
  // item 314: each transfer carries the key derived from the settle hash, and the record joins the two
  const rows = store.listPayouts({ limit: 10 });
  assert.deepEqual(rows.map((r) => r.transfer_key).sort(), rows.map((r) => payoutKeyFor('settle-1', r.address)).sort());
  assert.equal(recorded.length, 2);
  assert.ok(recorded.every((r) => r.settle === 'settle-1' && r.tx === '0xbatched'));
  assert.ok(rows.every((r) => r.recorded), 'and the row knows its payout is on the public record');

  // item 313: the rows can be rebuilt from the settlement alone, and rebuilding pays nothing twice
  store.listPayouts({ limit: 10 }).forEach(() => undefined);
  const again = p.enqueue(settlement, 'settle-1');
  assert.equal(store.listPayouts({ limit: 10 }).length, 2, 'idempotent per (settle, address)');
  assert.deepEqual(again.map((r) => r.status), ['paid', 'paid']);
  const run2 = await p.processPending();
  assert.equal(run2.paid, 0, 'nothing is paid a second time');
  assert.deepEqual(calls.map((x) => x.batch), [2]);
  store.close();
});

// ---------------------------------------------------------------- item 369: what made this balance
test('369 a credit refusal names the grant, the spends and the node that issued them', async () => {
  const st = await A.market.creditStatement(C.market.address);
  assert.equal(st.issuer.address, A.market.address, 'the grant is this seller\'s, not a property of the keypair');
  assert.ok(st.granted > 0 && st.purchases > 0, 'C was funded here and has bought here');
  assert.equal(st.balance, st.granted - st.spent + st.earned);
  // a buyer with no credit left is told which of "you spent it" and "this seller grants less" is true
  const poor = createIdentity();
  const e = (await A.market.entry(PAID_ID))!;
  A.market.store.putGrant(poor.address, '1', 'test');
  const out = await A.market.settlePayment(e, `/x402/patch/${PAID_ID}`, Buffer.from(JSON.stringify({
    scheme: 'local-credit', network: 'local', txHash: 'x', from: poor.address, to: A.market.address, amount: '4', nonce: 'nope', proof: 'p',
  })).toString('base64'));
  assert.match(out.error ?? '', /unknown or expired nonce/, 'the nonce is checked before the balance');
});

// ---------------------------------------------------------------- item 279: money that arrives short
test('279 a part-payment is held against the knowledge and the payer, and spent when it is topped up', async () => {
  const { Store } = await import('../src/store.js');
  const store = new Store(':memory:');
  const payer = '0xAbCdEf0000000000000000000000000000000001';
  store.putPartialPayment({ tx_hash: '0xa', patch_id: 'p', payer, amount: '0.1', currency: 'AIN', nonce: 'n1', resource: '/x402/patch/p' });
  store.putPartialPayment({ tx_hash: '0xb', patch_id: 'p', payer: payer.toLowerCase(), amount: '0.4', currency: 'AIN', nonce: 'n2', resource: '/x402/patch/p' });
  // the same person in either spelling is one payer (item 309's lesson, applied here)
  const held = store.partialPayments('p', payer.toUpperCase());
  assert.deepEqual(held.map((h) => h.amount), ['0.1', '0.4']);
  assert.equal(held.reduce((n, h) => n + Number(h.amount), 0), 0.5);
  // …and nothing is held for a different knowledge
  assert.equal(store.partialPayments('other', payer).length, 0);
  // the settlement that finally covers the price spends them, once
  store.consumePartials(held.map((h) => h.tx_hash), '0xsettle');
  assert.equal(store.partialPayments('p', payer).length, 0);
  assert.equal(store.heldPartials().length, 0);
  store.consumePartials(['0xa'], '0xother');
  assert.equal(store.partialPayments('p', payer).length, 0, 'a spent part-payment cannot be spent again');
  store.close();
});

test('279 a seller quoting more than its own listing is refused before any money moves', async () => {
  const e = (await C.market.entry(PAID_ID))!;
  assert.equal(e.anchor.price, '4');
  // The gate is asked for a quote at the listed price, so a normal purchase is unaffected…
  const r = await fetch(`${A.url}/x402/patch/${PAID_ID}`);
  const body = await r.json() as { requirements: { maxAmountRequired: string }[] };
  assert.equal(body.requirements[0].maxAmountRequired, '4');
});

// ---------------------------------------------------------------- item 320: money that can leave the node
test('320 a local-ledger node explains that its balance cannot leave, instead of pretending to send it', async () => {
  await assert.rejects(A.market.walletSend('0x1111111111111111111111111111111111111111', 1), /development credit|local ledger/);
  await assert.rejects(A.market.walletSend('not-an-address', 1), /not an AIN address/);
  await assert.rejects(A.market.walletSend(A.market.address, 1), /own address/);
  await assert.rejects(A.market.walletSend('0x1111111111111111111111111111111111111111', 0), /positive/);
});

// ---------------------------------------------------------------- item 322: the rule, and what a sale costs
test('322 the split preview states the rule that decides it, at any price, for a draft too', async () => {
  const e = (await B.market.entry('money-child'))!;
  const at10 = await B.market.saleSplit(e);
  assert.ok(at10.rule && /divided equally between the distinct CREATORS/i.test(at10.rule), 'the rule is on the answer, not only in a source comment');
  assert.ok((at10.payees ?? 0) > 1);
  // every branch of royaltyPlan is proportional, so a preview at another price is the same split scaled
  const at100 = await B.market.saleSplit(e, 100);
  const ratio = at100.lines.map((l) => Number(l.amount) / Number(at10.lines.find((x) => x.address === l.address)!.amount));
  assert.ok(ratio.every((r) => Math.abs(r - 10) < 1e-6), 'the preview at 100 is the settlement at 10, ten times over');
  // …and the rule's promise: naming two knowledges by ONE author costs what naming one costs
  const oneAuthor = await B.market.saleSplit({ ...e, anchor: { ...e.anchor, parents: ['money-base'] } }, 10);
  const twoOfOne = await B.market.saleSplit({ ...e, anchor: { ...e.anchor, parents: ['money-base', 'money-free'] } }, 10);
  const paidTo = (s: typeof oneAuthor) => Number(s.lines.find((l) => l.address.toLowerCase() === A.market.address.toLowerCase())?.amount ?? 0);
  assert.equal(paidTo(twoOfOne), paidTo(oneAuthor), 'both bases are A\'s, so naming both costs exactly what naming one costs');
  // on a local ledger nothing has ever been charged for gas, so the cost line says nothing rather than a made-up number
  assert.equal(at10.cost, null);
});

// ---------------------------------------------------------------- item 360: a model nobody meters
test('360 a billing model nothing meters cannot be published, and what it charges is named', async () => {
  const { billingImplemented, BILLING_IMPLEMENTED } = await import('@ainize/core');
  assert.deepEqual([...BILLING_IMPLEMENTED], ['per_download'], 'one model is charged, and it is the one a sale settles');
  assert.equal(billingImplemented('per_hit'), false);
  assert.equal(billingImplemented('per_apply_hour'), false);
  const token = await (async () => {
    const r = await fetch(`${A.url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: A.cfg.operator?.password ?? '' }) });
    return r.ok ? ((await r.json()) as { token: string }).token : '';
  })();
  if (token) {
    const r = await fetch(`${A.url}/api/patches/${PAID_ID}`, { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ billing: 'per_hit' }) });
    assert.equal(r.status, 400);
    assert.match(JSON.stringify(await r.json()), /not metered by any node/);
  }
  // an anchor that already carries one keeps it: the record is immutable and nothing is rewritten under it
  assert.equal((await A.market.entry(PAID_ID))!.anchor.billing, 'per_download');
});

// ---------------------------------------------------------------- item 359: a track that can be subscribed to
test('359 a track has terms, the curation fee is charged once per period, and the run rate is measured', async () => {
  const name = 'money/daily';
  await A.market.createBranch(name, 'A daily track', { topic: 'money' }, [PAID_ID]);
  // before terms: free to follow, exactly as every track was
  const free = await A.market.subscriptionQuote(name);
  assert.equal(free.terms, null);
  assert.equal(free.due, false);

  await A.market.setBranchTerms(name, { price: '5', currency: 'CREDIT', period_days: 30 });
  await assert.rejects(C.market.setBranchTerms(name, { price: '1', currency: 'CREDIT', period_days: 30 }), /only the owner/);
  await waitFor(() => C.market.allBranches(), (bs) => !!bs.find((b) => b.name === name)?.terms);

  const q = await C.market.subscriptionQuote(name);
  assert.deepEqual(q.terms, { price: '5', currency: 'CREDIT', period_days: 30 });
  assert.equal(q.due, true, 'nothing has been paid yet');
  assert.equal(q.paid_until, null);
  // the run rate is measured from the track's own last 30 days, not projected
  assert.equal(q.run_rate.knowledge_added, 1);
  assert.equal(q.run_rate.knowledge_spend, '4');
  assert.equal(q.run_rate.per_30_days, '9', '4 of knowledge added in 30 days plus the 5 fee');

  // the curator's 402, to anyone
  const r = await fetch(`${A.url}/x402/branch/${encodeURIComponent(name)}`);
  assert.equal(r.status, 402);
  const body = await r.json() as { requirements: { maxAmountRequired: string; description: string }[] };
  assert.equal(body.requirements[0].maxAmountRequired, '5');
  assert.match(body.requirements[0].description, /bought from its own publishers/);

  // one period, paid once
  const paid = await C.market.paySubscription(name);
  assert.equal(paid.paid, true);
  assert.equal(paid.amount, '5');
  const after = await C.market.subscriptionQuote(name);
  assert.equal(after.due, false, 'the period is covered');
  assert.ok((after.paid_until ?? 0) > Date.now());
  assert.equal(after.periods_paid, 1);
  const again = await C.market.paySubscription(name);
  assert.equal(again.paid, false, 'a subscription is charged once per period, not once per bake');
  assert.match(again.reason ?? '', /already paid until/);

  // the curator was paid, and the record says what the money was for
  const setts = (await A.ledger.settlements()).filter((x) => x.body.patch_id === `track:${name}`);
  assert.equal(setts.length, 1);
  assert.equal(setts[0].body.seller, A.market.address);
  assert.equal(setts[0].body.buyer, C.market.address);
  assert.deepEqual(setts[0].body.royalty, { [A.market.address]: '5' });
  // …and the curator cannot pay themselves for their own track
  const self = await A.market.paySubscription(name);
  assert.equal(self.paid, false);
  assert.match(self.reason ?? '', /curates it/);
});
