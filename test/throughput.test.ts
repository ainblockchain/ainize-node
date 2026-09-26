/**
 * The billing page's numbers: measured speed, the weight of everyone else asking, and what a deposit buys.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { DepositLedger, NodeDepositsConfig } from '@ainize/core';
import { ThroughputMeter } from '../src/throughput-meter.js';
import { StakeFairQueue } from '../src/stake-fair-queue.js';
import { InferenceBackendRegistry } from '../src/inference-backends.js';
import { throughputRoutes, throughputParseUnits, throughputExpected, throughputChainId, THROUGHPUT_FALLBACK_TOK_S } from '../src/throughput-routes.js';

const E18 = 10n ** 18n;

test('the meter reports tokens over time across calls, skips tiny ones and forgets old ones', () => {
  let now = 0;
  const m = new ThroughputMeter(() => now, 60_000);
  assert.equal(m.rateOf('M'), null);
  m.record('M', 100, 2000);   // 50 tok/s
  m.record('M', 300, 2000);   // 150 tok/s — the pair is 400 tokens in 4 s, not the mean of the rates
  m.record('M', 3, 900);      // latency, not throughput: skipped
  assert.deepEqual(m.rateOf('M'), { tokPerSec: 100, samples: 2, windowMs: 60_000 });
  assert.equal(m.overall()?.tokPerSec, 100);
  now = 61_000;
  assert.equal(m.rateOf('M'), null, 'outside the window');
});

test('activeWeightExcept is everyone else, floored, and shrinks when idle callers are forgotten', () => {
  let now = 0;
  const weights: Record<string, number> = { a: 2, b: 0 };
  const q = new StakeFairQueue({ weightOf: (x) => weights[x] ?? 0, weightFloor: 1e-6, now: () => now });
  q.admit({ priority: 0, seq: 1, address: 'a', cost: 10 });
  now = 10_000;
  q.admit({ priority: 0, seq: 2, address: 'b', cost: 10 });
  assert.equal(q.activeWeightExcept('b'), 2);
  assert.equal(q.activeWeightExcept('a'), 1e-6);
  assert.equal(q.activeWeightExcept('nobody'), 2 + 1e-6);
  now = 20_000;
  assert.equal(q.forgetIdle(15_000), 1, 'a was last seen at 0');
  assert.equal(q.activeWeightExcept('b'), 0);
});

test('amounts parse to 18-decimal units; chains map to wallet ids; the formula is w/(w+others)', () => {
  assert.equal(throughputParseUnits('100'), 100n * E18);
  assert.equal(throughputParseUnits('2.5'), 25n * E18 / 10n);
  assert.equal(throughputParseUnits('0.000000000000000001'), 1n);
  for (const bad of ['-1', '1e3', 'abc', '1.2.3', '']) assert.equal(throughputParseUnits(bad), null, bad);
  assert.equal(throughputChainId('base'), 8453);
  assert.equal(throughputChainId('base-sain'), 8453);
  assert.equal(throughputChainId('ethereum'), 1);
  assert.equal(throughputChainId('solana'), null);
  assert.equal(throughputExpected(100, 1, 0), 100, 'idle: the whole model');
  assert.equal(throughputExpected(100, 1, 3), 25);
});

// ── the route, end to end over HTTP

const ME = '0x00000000000000000000000000000000000a11ce';

function fakeLedger(shares: Record<string, bigint>, events: { txHash: string; from: string; shares: bigint; chain: string; blockNumber: number }[] = []) {
  return {
    depositedShareOf: (a: string) => shares[a] ?? 0n,
    snapshot: () => events,
  } as unknown as DepositLedger;
}

const DEPOSITS: NodeDepositsConfig = {
  receivingAddress: '0x77547927486Dc69793D460661f4a161D1B9068E3',
  vault: { address: '0x52644a566eCc3f09F2800A09eB99b2226839E2Da', chain: 'base' },
  chains: [
    { chain: 'base', rpcUrl: 'http://x', token: '0xd4423795fd904d9b87554940a95fb7016f172773' },
    { chain: 'base-sain', rpcUrl: 'http://x', token: '0x70e68AF68933D976565B1882D80708244E0C4fe9', isVaultShare: true },
  ],
} as NodeDepositsConfig;

async function serve(opts: { measured?: boolean; busy?: boolean; deposits?: boolean; myShares?: bigint }) {
  const meter = new ThroughputMeter();
  if (opts.measured !== false) meter.record('Chat-1', 400, 4000); // 100 tok/s
  const weights: Record<string, number> = { depositor: 3 };
  const q = new StakeFairQueue({ weightOf: (x) => weights[x] ?? 0, weightFloor: 1e-6, now: Date.now });
  if (opts.busy) q.admit({ priority: 0, seq: 1, address: 'depositor', cost: 1 });
  const ledger = fakeLedger({ [ME]: opts.myShares ?? 0n, depositor: 3n * E18 }, [{ txHash: '0xabc', from: ME, shares: 5n * E18, chain: 'base-sain', blockNumber: 7 }]);
  const app = express();
  app.use(throughputRoutes({
    registry: () => new InferenceBackendRegistry([{ id: 'llm', modality: 'chat', upstream: 'http://x', models: ['Chat-1'], concurrency: 1 }, { id: 'img', modality: 'image', upstream: 'http://x', models: ['Img-1'], concurrency: 1 }]),
    meter, scheduler: q, weightFloor: 1e-6, ledger: () => ledger,
    deposits: opts.deposits === false ? undefined : DEPOSITS,
    sharesPerAin: async () => E18 / 2n, // 1 AIN buys 0.5 sAIN (2 AIN per sAIN)
    sessionAddress: (req) => req.header('x-test-address') ?? null,
  }));
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test('idle node: the free tier gets the whole model; a quote in sAIN and in AIN', async () => {
  const s = await serve({});
  try {
    const r = await (await fetch(`${s.base}/api/throughput?model=Chat-1&amount=10&token=sAIN`)).json() as any;
    assert.deepEqual(r.rate, { tok_s: 100, measured: true, samples: 1, window_s: 1800 });
    assert.equal(r.free_tier.expected_tok_s, 100);
    assert.equal(r.free_tier.idle, true);
    assert.equal(r.free_tier.busy_expected_tok_s, 0, 'a busy moment leaves the shared free tier next to nothing');
    assert.equal(r.quote.sain, 10);
    assert.equal(r.quote.busy_expected_tok_s, 90.909, '10 sAIN against one 1-sAIN depositor');
    assert.equal(r.quote.expected_tok_s, 100, 'idle: the deposit changes nothing right now');
    assert.equal(r.quote.multiplier, null, 'the free tier gets next to nothing when busy: no finite multiple');
    assert.equal(r.you, null);
    assert.equal(r.deposits.ain_per_sain, 2);
    assert.deepEqual(r.deposits.chains.map((c: any) => [c.chain, c.chain_id, c.symbol, c.confirmations]), [['base', 8453, 'AIN', 30], ['base-sain', 8453, 'sAIN', 30]]);
    const ain = await (await fetch(`${s.base}/api/throughput?model=Chat-1&amount=10&token=AIN`)).json() as any;
    assert.equal(ain.quote.sain, 5, '10 AIN at 2 AIN per sAIN');
  } finally { await s.close(); }
});

test('busy node: the free tier is next to nothing, and a deposit multiplies it', async () => {
  const s = await serve({ busy: true });
  try {
    const r = await (await fetch(`${s.base}/api/throughput?model=Chat-1&amount=3&token=sAIN`)).json() as any;
    assert.equal(r.free_tier.idle, false);
    assert.equal(r.free_tier.expected_tok_s, 0);
    assert.equal(r.quote.expected_tok_s, 50, '3 sAIN against a 3-sAIN depositor: half');
    const me = await (await fetch(`${s.base}/api/throughput?model=Chat-1&amount=3&token=sAIN`, { headers: { 'x-test-address': ME } })).json() as any;
    assert.equal(me.you.deposited_sain, 0);
  } finally { await s.close(); }
});

test('a signed-in depositor sees their own rate and a quote on top of it; deposit status is theirs only', async () => {
  const s = await serve({ busy: true, myShares: 1n * E18 });
  try {
    const r = await (await fetch(`${s.base}/api/throughput?model=Chat-1&amount=2&token=sAIN`, { headers: { 'x-test-address': ME } })).json() as any;
    assert.equal(r.you.deposited_sain, 1);
    assert.equal(r.you.expected_tok_s, 25, '1 against 3');
    assert.equal(r.quote.expected_tok_s, 50, '1 + 2 against 3');
    assert.equal(r.you.busy_expected_tok_s, 25);
    assert.equal(r.quote.multiplier, 2, 'busy against busy');
    assert.equal((await fetch(`${s.base}/api/throughput/deposits/0xabc`)).status, 401);
    assert.deepEqual(await (await fetch(`${s.base}/api/throughput/deposits/0xABC`, { headers: { 'x-test-address': ME } })).json(), { tx_hash: '0xabc', credited: true, sain: 5, chain: 'base-sain', block_number: 7 });
    assert.deepEqual(await (await fetch(`${s.base}/api/throughput/deposits/0xabc`, { headers: { 'x-test-address': '0xsomeoneelse' } })).json(), { tx_hash: '0xabc', credited: false });
  } finally { await s.close(); }
});

test('unmeasured model falls back to the constant and says so; non-chat and unknown models are 404; bad amounts 400', async () => {
  const s = await serve({ measured: false, deposits: false });
  try {
    const r = await (await fetch(`${s.base}/api/throughput?model=Chat-1`)).json() as any;
    assert.deepEqual(r.rate, { tok_s: THROUGHPUT_FALLBACK_TOK_S, measured: false, samples: 0, window_s: null });
    assert.deepEqual(r.deposits, { enabled: false });
    assert.equal(r.quote, null);
    assert.equal((await fetch(`${s.base}/api/throughput?model=Img-1`)).status, 404);
    assert.equal((await fetch(`${s.base}/api/throughput?model=nope`)).status, 404);
    assert.equal((await fetch(`${s.base}/api/throughput?model=Chat-1&amount=-5`)).status, 400);
  } finally { await s.close(); }
});
