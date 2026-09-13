/**
 * Royalty payouts (spec §9.3, §7.5): a `payouts` row per non-self royalty address is written BEFORE the transfer,
 * pending → paid (tx_hash) | failed (last_error) with a retry timer (max attempts), operator list/retry endpoints,
 * and `GET /api/teacher/:address` reconciling owed (settle records) against paid (payouts). The chain wallet is faked.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIdentity, defaultConfig, type NodeConfig, type Settlement } from '@ainize/core';
import { Store } from '../src/store.js';
import { Payouts, PayoutError, PAYOUT_INTERRUPTED, type PayoutWallet } from '../src/payouts.js';
import { startNode, type RunningNode } from '../src/server.js';
import { operatorToken } from './fixtures/operator.js';

const SELF = '0x1111111111111111111111111111111111111111';
const CREATOR = '0x2222222222222222222222222222222222222222';
const TEACHER = '0x3333333333333333333333333333333333333333';

/** Fake chain wallet: fails while `failing` is set, otherwise returns a deterministic tx hash. */
function fakeWallet() {
  const calls: { to: string; value: number }[] = [];
  const w = {
    failing: false as boolean | string,
    calls,
    async transfer(to: string, value: number) {
      calls.push({ to, value });
      if (w.failing) throw new Error(typeof w.failing === 'string' ? w.failing : 'chain unreachable (fake)');
      return { tx_hash: `0xtx${String(calls.length).padStart(4, '0')}${to.slice(2, 8)}` };
    },
  };
  return w as PayoutWallet & typeof w;
}

const settle = (over: Partial<Settlement> = {}): Settlement => ({
  patch_id: 'krx-all-2761', seller: SELF, buyer: '0x4444444444444444444444444444444444444444', amount: '10', currency: 'AIN', scheme: 'ain-transfer',
  tx_hash: '0xbuyertx', royalty: { [SELF]: '5.1', [CREATOR]: '2.1', [TEACHER]: '2.8', '0x5555555555555555555555555555555555555555': '0' }, billing: 'per-download' as Settlement['billing'], created_at: Date.now(), ...over,
});

const logs: { level: string; kind: string; message: string }[] = [];
const mk = (wallet: PayoutWallet | null, opts: { retryMs?: number; maxAttempts?: number } = {}) => {
  const store = new Store(':memory:');
  const p = new Payouts(store, (level, kind, message) => logs.push({ level, kind, message }), wallet, { selfAddress: SELF, retryMs: opts.retryMs ?? 50, maxAttempts: opts.maxAttempts ?? 3 });
  return { store, p };
};

test('enqueue writes one pending row per non-self, non-zero royalty address BEFORE any transfer; idempotent per settle record', () => {
  const w = fakeWallet();
  const { store, p } = mk(w);
  const rows = p.enqueue(settle(), 'settle-hash-1');
  assert.deepEqual(rows.map((r) => [r.address, r.amount, r.status, r.attempts]), [[CREATOR, '2.1', 'pending', 0], [TEACHER, '2.8', 'pending', 0]]);
  assert.equal(w.calls.length, 0, 'no transfer yet');
  assert.deepEqual(store.payoutSummary(), { pending: 2, failed: 0, paid: 0 });
  // same settle record again (e.g. after a restart) → same rows, nothing duplicated
  const again = p.enqueue(settle(), 'settle-hash-1');
  assert.deepEqual(again.map((r) => r.id), rows.map((r) => r.id));
  assert.equal(store.listPayouts().length, 2);
  // a second sale gets its own rows
  p.enqueue(settle({ created_at: Date.now() + 1 }), 'settle-hash-2');
  assert.equal(store.listPayouts().length, 4);
  assert.equal(store.listPayouts({ address: TEACHER.toUpperCase() }).length, 2, 'address filter is case-insensitive');
  assert.ok(logs.some((l) => l.kind === 'payout' && /pending/.test(l.message)), 'payout event recorded');
});

test('pending → paid with tx_hash, attempts 1; the settle currency and amount are what the wallet is asked to move', async () => {
  const w = fakeWallet();
  const { store, p } = mk(w);
  p.enqueue(settle(), 'h1');
  const run = await p.processPending();
  assert.deepEqual(run, { attempted: 2, paid: 2, failed: 0 });
  assert.deepEqual(w.calls, [{ to: CREATOR, value: 2.1 }, { to: TEACHER, value: 2.8 }]);
  for (const r of store.listPayouts()) { assert.equal(r.status, 'paid'); assert.equal(r.attempts, 1); assert.match(r.tx_hash!, /^0xtx/); assert.equal(r.last_error, null); }
  assert.deepEqual(store.payoutSummary(), { pending: 0, failed: 0, paid: 2 });
  // a second pass has nothing to do and never re-pays
  assert.deepEqual(await p.processPending(), { attempted: 0, paid: 0, failed: 0 });
  assert.equal(w.calls.length, 2);
});

test('pending → failed with last_error; retried after the interval up to max attempts, then left for the operator', async () => {
  const w = fakeWallet();
  w.failing = 'insufficient balance (fake)';
  const { store, p } = mk(w, { retryMs: 30, maxAttempts: 3 });
  const [row] = p.enqueue(settle({ royalty: { [SELF]: '7', [TEACHER]: '3' } }), 'h1');
  assert.deepEqual(await p.processPending(), { attempted: 1, paid: 0, failed: 1 });
  let r = store.getPayout(row.id)!;
  assert.equal(r.status, 'failed'); assert.equal(r.attempts, 1); assert.equal(r.last_error, 'insufficient balance (fake)'); assert.equal(r.tx_hash, null);
  // not due again immediately
  assert.equal(p.due().length, 0);
  assert.deepEqual(await p.processPending(), { attempted: 0, paid: 0, failed: 0 });
  // due after the retry interval → attempt 2 (still failing), attempt 3 (still failing) → exhausted
  await new Promise((res) => setTimeout(res, 40));
  assert.equal(p.due().length, 1);
  await p.processPending();
  assert.equal(store.getPayout(row.id)!.attempts, 2);
  await new Promise((res) => setTimeout(res, 40));
  await p.processPending();
  r = store.getPayout(row.id)!;
  assert.equal(r.attempts, 3); assert.equal(r.status, 'failed');
  await new Promise((res) => setTimeout(res, 40));
  assert.equal(p.due().length, 0, 'max attempts reached: the timer leaves it alone');
  assert.deepEqual(await p.processPending(), { attempted: 0, paid: 0, failed: 0 });
  assert.equal(w.calls.length, 3);
  assert.ok(logs.some((l) => l.level === 'warn' && /giving up/.test(l.message)), 'final failure is logged as a warning');
  // operator retry is still allowed and succeeds once the chain is back
  w.failing = false;
  const paid = await p.retry(row.id);
  assert.equal(paid.status, 'paid'); assert.equal(paid.attempts, 4); assert.ok(paid.tx_hash); assert.equal(paid.last_error, null);
  await assert.rejects(p.retry(row.id), (e: unknown) => e instanceof PayoutError && e.status === 409);
  await assert.rejects(p.retry(999), (e: unknown) => e instanceof PayoutError && e.status === 404);
});

test('a failed row recovers on the timer once the wallet works again; a node without a chain wallet marks rows failed', async () => {
  const w = fakeWallet();
  w.failing = true;
  const { store, p } = mk(w, { retryMs: 20, maxAttempts: 20 });
  const [row] = p.enqueue(settle({ royalty: { [CREATOR]: '1' } }), 'h1');
  await p.processPending();
  assert.equal(store.getPayout(row.id)!.status, 'failed');
  w.failing = false;
  p.start();
  try {
    const t0 = Date.now();
    while (store.getPayout(row.id)!.status !== 'paid' && Date.now() - t0 < 2000) await new Promise((res) => setTimeout(res, 10));
  } finally { p.stop(); }
  assert.equal(store.getPayout(row.id)!.status, 'paid');
  assert.equal(store.getPayout(row.id)!.attempts, 2);

  const nw = mk(null);
  const [r2] = nw.p.enqueue(settle({ royalty: { [CREATOR]: '1' } }), 'h2');
  await nw.p.processPending();
  assert.equal(nw.store.getPayout(r2.id)!.status, 'failed');
  assert.match(nw.store.getPayout(r2.id)!.last_error!, /no chain wallet/);
});

test('concurrent processPending calls serialise (one transfer per row)', async () => {
  const w = fakeWallet();
  const { store, p } = mk(w);
  p.enqueue(settle(), 'h1');
  await Promise.all([p.processPending(), p.processPending(), p.processPending()]);
  assert.equal(w.calls.length, 2);
  assert.equal(store.listPayouts({ status: 'paid' }).length, 2);
});

test('no double transfer: an operator retry while the timer pass is mid-transfer, and a stale snapshot, issue exactly one transfer per row', async () => {
  const w = fakeWallet();
  let release!: () => void;
  const gate = new Promise<void>((res) => { release = res; });
  let started = 0;
  const slow = { calls: w.calls, async transfer(to: string, value: number) { started++; await gate; return w.transfer(to, value); } } as PayoutWallet & { calls: typeof w.calls };
  const { store, p } = mk(slow);
  const [row] = p.enqueue(settle({ royalty: { [SELF]: '7', [TEACHER]: '3' } }), 'h1');
  const pass = p.processPending();                       // timer pass: claims the row, transfer pending
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(store.getPayout(row.id)!.status, 'paying', 'claimed atomically before the transfer');
  const retry = p.retry(row.id);                         // operator clicks Retry while the transfer is in flight
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(started, 1, 'no second transfer was started');
  release();
  const [run, r] = await Promise.all([pass, retry]);
  assert.deepEqual(run, { attempted: 1, paid: 1, failed: 0 });
  assert.equal(r.status, 'paid'); assert.equal(r.attempts, 1); assert.equal(slow.calls.length, 1);
  // a failed row: retry and the timer racing → still one transfer
  const w2 = fakeWallet(); w2.failing = true;
  const m2 = mk(w2, { retryMs: 1 });
  const [f] = m2.p.enqueue(settle({ royalty: { [CREATOR]: '1' } }), 'h2');
  await m2.p.processPending();
  assert.equal(m2.store.getPayout(f.id)!.status, 'failed');
  w2.failing = false;
  await new Promise((res) => setTimeout(res, 5));
  await Promise.all([m2.p.processPending(), m2.p.retry(f.id), m2.p.retry(f.id)]);
  assert.equal(w2.calls.length, 2, 'one failed attempt + one successful attempt, never two live transfers');
  assert.equal(m2.store.getPayout(f.id)!.status, 'paid'); assert.equal(m2.store.getPayout(f.id)!.attempts, 2);
  assert.deepEqual(m2.store.payoutSummary(), { pending: 0, failed: 0, paid: 1 });
});

test('a row left "paying" by a crash is never re-sent automatically: at start it becomes failed (attempts exhausted, PAYOUT_INTERRUPTED) until the operator confirms and retries', async () => {
  const w = fakeWallet();
  const store = new Store(':memory:');
  const first = new Payouts(store, () => undefined, w, { selfAddress: SELF, retryMs: 20, maxAttempts: 3 });
  const [row] = first.enqueue(settle({ royalty: { [TEACHER]: '2' } }), 'h1');
  assert.equal(store.claimPayout(row.id), true, 'claim wins once');
  assert.equal(store.claimPayout(row.id), false, 'a second claim of the same row fails');
  assert.equal(store.getPayout(row.id)!.status, 'paying'); assert.deepEqual(store.payoutSummary(), { pending: 1, failed: 0, paid: 0 });
  // "crash" here: the process died between wallet.transfer and updatePayout. New process:
  const second = new Payouts(store, (level, kind, message) => logs.push({ level, kind, message }), w, { selfAddress: SELF, retryMs: 20, maxAttempts: 3 });
  second.start();
  try {
    await new Promise((res) => setTimeout(res, 80));
    const r = store.getPayout(row.id)!;
    assert.equal(r.status, 'failed'); assert.equal(r.last_error, PAYOUT_INTERRUPTED); assert.equal(r.attempts, 3);
    assert.equal(w.calls.length, 0, 'no blind re-send');
    assert.equal(second.due().length, 0);
    assert.ok(logs.some((l) => /mid-transfer/.test(l.message)));
    const paid = await second.retry(row.id);
    assert.equal(paid.status, 'paid'); assert.equal(w.calls.length, 1); assert.equal(paid.attempts, 4);
  } finally { second.stop(); }
});

// ---------------------------------------------------------------- HTTP: operator endpoints + public teacher reconciliation
const tmp = mkdtempSync(join(tmpdir(), 'ngram-payouts-test-'));
const PORT = 24051;
const url = `http://127.0.0.1:${PORT}`;
let N: RunningNode;
let opToken = '';
const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(url + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: Record<string, any> = {};
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: r.status, json };
};
const op = () => ({ authorization: `Bearer ${opToken}` });

before(async () => {
  const cfg: NodeConfig = defaultConfig({ home: join(tmp, 'N'), name: 'payouts-node', port: PORT, peers: [], roles: ['seller', 'verifier'], ledger: 'local' });
  cfg.runtime = { repo: undefined, api: 'http://127.0.0.1:1' };
  cfg.host = '127.0.0.1'; cfg.publicUrl = url; cfg.gossipIntervalMs = 60_000;
  cfg.teach = { ...cfg.teach!, enabled: true, backend: 'stub', checkStubLessons: true };
  N = await startNode(cfg, { quiet: true, serveWeb: false, teachHooks: { intervalMs: 60 } });
  opToken = await operatorToken(N.url, cfg.identity);
});
after(async () => { await N?.stop(); rmSync(tmp, { recursive: true, force: true }); });

test('local ledger: no chain wallet, settlement path writes no payouts for local-credit sales; endpoints need the operator', async () => {
  assert.equal(N.market.payouts.wallet, null);
  assert.equal((await api('GET', '/api/me/payouts')).status, 401);
  const r = await api('GET', '/api/me/payouts', undefined, op());
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.items, []);
  assert.deepEqual(r.json.summary, { pending: 0, failed: 0, paid: 0 });
  assert.equal(r.json.wallet, false);
  assert.equal(r.json.max_attempts, 20); assert.equal(r.json.retry_ms, 60_000);
  assert.equal((await api('GET', '/api/me/payouts?status=bogus', undefined, op())).status, 400);
  assert.equal((await api('GET', '/api/me/payouts?status=paying', undefined, op())).status, 200);
});

test('GET /api/teacher/:address reconciles owed (settle records) vs paid (payouts); /api/me/payouts list, filter and retry', async () => {
  const self = N.market.address;
  const teacher = createIdentity().address;
  const other = createIdentity().address;
  // Two AIN-style settle records on the ledger (what any node can read): one sold by this node, one by another node.
  const s1 = settle({ seller: self, royalty: { [self]: '6', [teacher]: '4' }, tx_hash: '0xbuy1', created_at: Date.now() - 2000 });
  const s2 = settle({ patch_id: 'law-kr-2026', seller: other, royalty: { [other]: '8', [teacher]: '2' }, tx_hash: '0xbuy2', created_at: Date.now() - 1000 });
  const rec1 = await N.ledger.append('settle', s1);
  await N.ledger.append('settle', s2);
  // and one local-credit sale (play money: credited by the record itself)
  await N.ledger.append('settle', settle({ seller: self, scheme: 'local-credit', currency: 'CREDIT', royalty: { [self]: '3', [teacher]: '1' }, tx_hash: 'localproof', created_at: Date.now() }));
  N.market.invalidate();

  let prof = await api('GET', `/api/teacher/${teacher}`);
  assert.equal(prof.status, 200);
  assert.equal(prof.json.earnings.owed, '7');
  assert.equal(prof.json.earnings.paid, '1', 'only the local-credit slice counts as paid so far');
  assert.equal(prof.json.earnings.pending, '6');
  assert.equal(prof.json.earnings.failed, '0');
  assert.equal(prof.json.earnings.sales, 3);
  const byPatch = Object.fromEntries(prof.json.earnings.items.map((i: any) => [i.settle_hash, i]));
  assert.equal(byPatch[rec1.hash].status, 'pending');
  assert.equal(byPatch[rec1.hash].seller, self);

  // The seller node now owes: payouts row written (pending) before the transfer, then paid through the (fake) wallet.
  const w = fakeWallet();
  w.failing = 'rpc timeout (fake)';
  N.market.payouts.wallet = w;
  const [row] = N.market.payouts.enqueue(s1, rec1.hash);
  assert.equal(row.status, 'pending'); assert.equal(row.address, teacher);
  await N.market.payouts.processPending();
  let list = await api('GET', '/api/me/payouts?status=failed', undefined, op());
  assert.equal(list.json.items.length, 1);
  assert.equal(list.json.items[0].id, row.id);
  assert.equal(list.json.items[0].last_error, 'rpc timeout (fake)');
  assert.equal(list.json.items[0].attempts, 1);
  assert.deepEqual(list.json.summary, { pending: 0, failed: 1, paid: 0 });
  assert.equal((await api('GET', '/api/me/payouts?status=paid', undefined, op())).json.items.length, 0);
  // still "pending" for the contributor while the node keeps retrying
  prof = await api('GET', `/api/teacher/${teacher}`);
  assert.equal(prof.json.earnings.items.find((i: any) => i.settle_hash === rec1.hash).status, 'pending');
  assert.equal(prof.json.earnings.items.find((i: any) => i.settle_hash === rec1.hash).attempts, 1);
  // wallet shows the unpaid payout
  const wallet = await api('GET', '/api/me/wallet', undefined, op());
  assert.equal(wallet.json.payouts.failed, 1);
  assert.equal(wallet.json.payouts.items[0].id, row.id);

  // operator retry: still failing → 200 with the failed row; chain back → paid with tx_hash
  let retry = await api('POST', `/api/me/payouts/${row.id}/retry`, undefined, op());
  assert.equal(retry.status, 200); assert.equal(retry.json.payout.status, 'failed'); assert.equal(retry.json.payout.attempts, 2);
  w.failing = false;
  retry = await api('POST', `/api/me/payouts/${row.id}/retry`, undefined, op());
  assert.equal(retry.json.payout.status, 'paid'); assert.equal(retry.json.payout.attempts, 3); assert.match(retry.json.payout.tx_hash, /^0xtx/);
  assert.equal((await api('POST', `/api/me/payouts/${row.id}/retry`, undefined, op())).status, 409);
  assert.equal((await api('POST', '/api/me/payouts/424242/retry', undefined, op())).status, 404);
  assert.equal((await api('POST', '/api/me/payouts/abc/retry', undefined, op())).status, 400);
  assert.equal((await api('POST', `/api/me/payouts/${row.id}/retry`)).status, 401);

  prof = await api('GET', `/api/teacher/${teacher}`);
  assert.equal(prof.json.earnings.paid, '5');
  assert.equal(prof.json.earnings.pending, '2', 'the slice sold by the other node stays pending here — its settle record is the evidence');
  const paidItem = prof.json.earnings.items.find((i: any) => i.settle_hash === rec1.hash);
  assert.equal(paidItem.status, 'paid'); assert.match(paidItem.tx_hash, /^0xtx/); assert.ok(paidItem.paid_at);
  list = await api('GET', `/api/me/payouts?address=${teacher.toUpperCase()}`, undefined, op());
  assert.equal(list.json.items.length, 1); assert.equal(list.json.items[0].status, 'paid');
  assert.ok(N.store.events({ kind: 'payout', limit: 20 }).length >= 3, 'payout events: owed, failed, paid');
  N.market.payouts.wallet = null;
});

test('exhausted automatic attempts read "failed" on the public page; a settlePayment on local-credit writes no payouts rows', async () => {
  const teacher = createIdentity().address;
  const s = settle({ seller: N.market.address, royalty: { [N.market.address]: '9', [teacher]: '1' }, tx_hash: '0xbuy9', created_at: Date.now() });
  const rec = await N.ledger.append('settle', s);
  const [row] = N.market.payouts.enqueue(s, rec.hash);
  N.store.updatePayout(row.id, { status: 'failed', attempts: N.market.payouts.maxAttempts, last_error: 'gave up (fixture)' });
  const prof = await api('GET', `/api/teacher/${teacher}`);
  assert.equal(prof.json.earnings.items[0].status, 'failed');
  assert.equal(prof.json.earnings.failed, '1');
  assert.equal(prof.json.earnings.pending, '1', 'failed is a subset of pending: it is still owed');
  const before = N.store.listPayouts().length;
  const entry = (await N.market.catalogAll()).find((e) => e.anchor.author === N.market.address);
  if (entry) {
    const r = await N.market.settlePayment(entry, '/x402/patch/x', undefined);
    assert.ok(r.error, 'malformed header is rejected before any settle');
  }
  assert.equal(N.store.listPayouts().length, before);
});
