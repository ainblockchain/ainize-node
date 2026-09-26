/**
 * `/api/throughput` — what speed a caller can expect from a model now, and after depositing X.
 *
 * The billing page (ainize-web `/billing`) is built on this. Payment itself is unchanged: a transfer to the
 * operator's `receivingAddress` is credited to the sender (deposit-watcher.ts) and becomes weight in the fair queue
 * (stake-fair-queue.ts). What this adds is the arithmetic, done where the numbers live:
 *
 *   expected(w) = others > 0 ? R · w / (w + others) : R
 *
 * R is the model's measured rate (throughput-meter.ts; the old constant when nothing was measured yet, and then
 * said so), `others` the weight of everyone else asking. A free-tier visitor is the shared anonymous caller at
 * the weight floor: the whole model when nobody else asks, next to nothing when a depositor does — and the page
 * says exactly that rather than averaging it into a number that is true at no moment.
 *
 * Design: docs/superpowers/specs/2026-09-26-throughput-billing-design.md.
 */
import { Router, type Request, type Response } from 'express';
import type { DepositLedger, NodeDepositsConfig } from '@ainize/core';
import type { InferenceBackendRegistry } from './inference-backends.js';
import type { StakeFairQueue } from './stake-fair-queue.js';
import type { ThroughputMeter } from './throughput-meter.js';
import { DEFAULT_CONFIRMATIONS } from './deposit-chain-reader.js';

/** The rate assumed before anything was measured — the constant the /v1 wait estimate has always used. */
export const THROUGHPUT_FALLBACK_TOK_S = 20;
/** Who the free tier is in the queue: every visitor without a key, as one caller (market.ts, runtime.ts). */
export const THROUGHPUT_FREE_TIER_ADDRESS = 'anonymous';
const SHARE_UNIT = 10n ** 18n;
const RATE_CACHE_MS = 5 * 60_000;

export interface ThroughputRoutesDeps {
  registry: () => InferenceBackendRegistry | null;
  meter: ThroughputMeter;
  /** Absent when this node sells no throughput: the queue is then plain arrival order. */
  scheduler?: StakeFairQueue;
  weightFloor: number;
  ledger: () => DepositLedger | null;
  deposits?: NodeDepositsConfig;
  /** sAIN shares one whole AIN buys now (1e18 fixed point), read from the staking contract. */
  sharesPerAin?: () => Promise<bigint>;
  sessionAddress: (req: Request) => string | null;
}

/** EIP-155 ids of the chains the deposit watcher knows by name. A wallet needs the number, not the name. */
export function throughputChainId(chain: string): number | null {
  if (chain === 'ethereum' || chain.startsWith('ethereum-')) return 1;
  if (chain === 'base' || chain.startsWith('base-')) return 8453;
  return null;
}

/** "12.5" → 12.5e18 as a bigint. Null for anything that is not a plain non-negative decimal. */
export function throughputParseUnits(amount: string, decimals = 18): bigint | null {
  const m = /^(\d{1,15})(?:\.(\d{1,18}))?$/.exec(amount.trim());
  if (!m) return null;
  const frac = (m[2] ?? '').padEnd(decimals, '0').slice(0, decimals);
  return BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt(frac || '0');
}

const sharesToSain = (shares: bigint) => Number((shares * 1_000_000n) / SHARE_UNIT) / 1_000_000;

/**
 * The busy case: at least one other caller holding 1 sAIN is asking. The contention a deposit is for, and the
 * one moment the free tier's "whole model when idle" is not true.
 */
export const throughputBusy = (rate: number, w: number, others: number) => throughputExpected(rate, w, Math.max(others, 1));

/** The expected rate at weight `w` against `others`, rounded for display. */
export function throughputExpected(rate: number, w: number, others: number): number {
  const v = others > 0 ? (rate * w) / (w + others) : rate;
  return Math.round(v * 1000) / 1000;
}

export function throughputRoutes(deps: ThroughputRoutesDeps): Router {
  const router = Router();
  let cachedRate: { at: number; sharesPerAin: bigint } | null = null;

  const sharesPerAin = async (): Promise<bigint | null> => {
    if (!deps.sharesPerAin) return null;
    if (cachedRate && Date.now() - cachedRate.at < RATE_CACHE_MS) return cachedRate.sharesPerAin;
    try {
      cachedRate = { at: Date.now(), sharesPerAin: await deps.sharesPerAin() };
      return cachedRate.sharesPerAin;
    } catch {
      return cachedRate?.sharesPerAin ?? null;
    }
  };

  router.get('/api/throughput', async (req: Request, res: Response) => {
    const model = typeof req.query.model === 'string' ? req.query.model : '';
    const backend = deps.registry()?.backendForModel(model);
    if (!backend || backend.modality !== 'chat') {
      res.status(404).json({ error: { code: 'model_not_served', message: `this node does not serve a chat model called ${model}` } });
      return;
    }
    const measured = deps.meter.rateOf(model) ?? deps.meter.overall();
    const rate = measured?.tokPerSec ?? THROUGHPUT_FALLBACK_TOK_S;
    const floor = deps.weightFloor;
    const q = deps.scheduler;
    const weightOf = (address: string) => {
      const shares = deps.ledger()?.depositedShareOf(address) ?? 0n;
      return Math.max(sharesToSain(shares), floor);
    };

    const freeOthers = q ? q.activeWeightExcept(THROUGHPUT_FREE_TIER_ADDRESS) : 0;
    const me = deps.sessionAddress(req);
    const myOthers = me && q ? q.activeWeightExcept(me) : freeOthers;
    const myShares = me ? deps.ledger()?.depositedShareOf(me) ?? 0n : 0n;

    // The quote: what `amount` of `token` adds, in sAIN, on top of what the caller already holds.
    let quote: Record<string, unknown> | null = null;
    const amountRaw = typeof req.query.amount === 'string' ? req.query.amount : '';
    const token = req.query.token === 'AIN' ? 'AIN' : 'sAIN';
    const perAin = await sharesPerAin();
    if (amountRaw) {
      const units = throughputParseUnits(amountRaw);
      if (units === null) {
        res.status(400).json({ error: { code: 'invalid_request', message: 'amount is a decimal number of tokens, e.g. 100 or 2.5' } });
        return;
      }
      const addShares = token === 'sAIN' ? units : perAin !== null ? (units * perAin) / SHARE_UNIT : null;
      if (addShares !== null) {
        const before = me ? weightOf(me) : floor;
        const after = Math.max(sharesToSain(myShares + addShares), floor);
        const others = me ? myOthers : freeOthers;
        // What a deposit buys is the BUSY case: an idle node gives everyone the whole model, so "now vs after"
        // on an idle node is x1 and says nothing. The multiplier compares busy with busy; against a free tier that
        // gets next to nothing when busy it has no finite value, and is null.
        const beforeBusy = throughputBusy(rate, before, others);
        const afterBusy = throughputBusy(rate, after, others);
        quote = {
          token, amount: amountRaw, sain: sharesToSain(addShares),
          expected_tok_s: throughputExpected(rate, after, others),
          busy_expected_tok_s: afterBusy,
          multiplier: beforeBusy >= 0.01 ? Math.round((afterBusy / beforeBusy) * 10) / 10 : null,
        };
      } else {
        quote = { token, amount: amountRaw, sain: null, expected_tok_s: null, multiplier: null, error: 'the AIN→sAIN rate could not be read right now' };
      }
    }

    const d = deps.deposits;
    res.json({
      model,
      rate: { tok_s: Math.round(rate * 10) / 10, measured: !!measured, samples: measured?.samples ?? 0, window_s: measured ? Math.round(measured.windowMs / 1000) : null },
      active: { callers: q?.trackedAddresses ?? 0, others_weight: freeOthers },
      free_tier: {
        expected_tok_s: throughputExpected(rate, floor, freeOthers),
        // What a busy moment looks like for the free tier: one depositor of 1 sAIN asking at the same time.
        busy_expected_tok_s: throughputBusy(rate, floor, freeOthers),
        idle: freeOthers === 0,
      },
      you: me ? {
        address: me,
        deposited_sain: sharesToSain(myShares),
        expected_tok_s: throughputExpected(rate, weightOf(me), myOthers),
        busy_expected_tok_s: throughputBusy(rate, weightOf(me), myOthers),
        idle: myOthers === 0,
      } : null,
      quote,
      deposits: d ? {
        enabled: true,
        address: d.receivingAddress,
        ain_per_sain: perAin ? Math.round((Number(SHARE_UNIT) / Number(perAin)) * 1e6) / 1e6 : null,
        chains: d.chains.map((c) => ({
          chain: c.chain,
          chain_id: throughputChainId(c.chain),
          token: c.token,
          symbol: c.isVaultShare ? 'sAIN' : 'AIN',
          decimals: 18,
          confirmations: c.confirmations ?? DEFAULT_CONFIRMATIONS[c.chain.split('-')[0]!] ?? 12,
        })),
      } : { enabled: false },
    });
  });

  /**
   * Has this transfer been credited — to the signed-in caller? A transaction hash is public, so it is answered
   * only for the caller's own transfer (the same rule as `/v1/account/deposits/:txHash`, without needing a key).
   */
  router.get('/api/throughput/deposits/:txHash', (req: Request, res: Response) => {
    const me = deps.sessionAddress(req);
    if (!me) { res.status(401).json({ error: { code: 'not_signed_in', message: 'sign in with the wallet that sent the deposit' } }); return; }
    const wanted = String(req.params.txHash ?? '').toLowerCase();
    const found = deps.ledger()?.snapshot().find((e) => e.txHash === wanted && e.from === me);
    if (!found) { res.json({ tx_hash: wanted, credited: false }); return; }
    res.json({ tx_hash: found.txHash, credited: true, sain: sharesToSain(found.shares), chain: found.chain, block_number: found.blockNumber });
  });

  return router;
}
