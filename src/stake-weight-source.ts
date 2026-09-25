/**
 * Turning a deposit into a queue weight.
 *
 * The ledger counts in sAIN share units — 18-decimal bigints — and the fair queue wants a number it can divide
 * by. This is the one place that conversion happens, and it is lossy on purpose: what the queue needs is a ratio
 * between two weights, never an amount anybody is owed. Amounts stay bigint everywhere they mean money.
 *
 * Dividing by 10^18 keeps a realistic deposit in a range where a double is exact to far more digits than any
 * scheduling decision could notice, and keeps a very large one well short of Infinity — which, unlike a rounding
 * error, would be a real bug: Infinity / Infinity is NaN, and a NaN finish tag sorts unpredictably.
 */
import type { DepositLedger } from '@ainize/core';

/** sAIN, like most ERC-20s, has 18 decimals. One whole token is one unit of weight. */
const SHARE_DECIMALS = 10n ** 18n;
/** Below this the fraction is worth keeping; above it the integer part is all that matters. */
const FRACTION_SCALE = 1_000_000n;

export function stakeWeightFrom(ledger: DepositLedger): (address: string) => number {
  return (address: string): number => {
    const shares = ledger.depositedShareOf(address);
    if (shares <= 0n) return 0;
    // Scaled integer division before touching a double: `Number(huge bigint)` loses precision silently, and for
    // a deposit past 2^53 share units it would lose it in the direction of whoever deposited most.
    return Number((shares * FRACTION_SCALE) / SHARE_DECIMALS) / Number(FRACTION_SCALE);
  };
}

/**
 * The weight a caller with no deposit gets.
 *
 * Not zero. Zero weight means an infinite finish tag, which is permanent starvation rather than "last in line" —
 * a free caller would never run even on a node nobody else is using. This is small enough that any real deposit
 * outranks it and large enough that an idle node still answers.
 */
export const STAKE_WEIGHT_FLOOR = 0.000_001;

/** How long an address may go unseen before the queue forgets its virtual clock. Memory only; see `forgetIdle`. */
export const STAKE_IDLE_FORGET_MS = 30 * 60_000;
