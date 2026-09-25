/**
 * What a signed-out visitor is allowed, in one place.
 *
 * Three routes now let somebody with no key reach a model: `/api/chat`, `/api/transcribe` and `/api/image`. They
 * must share one allowance, or a visitor gets three by pressing a different button — and they must share one
 * *definition* of it, or the one that drifts is whichever nobody is reading.
 *
 * Two buckets, as `/api/chat` has always had: this BROWSER, which is the allowance a page can report, and this
 * NETWORK, which is the protection against somebody clearing a cookie in a loop. Both are checked before any work
 * and refunded when the work fails, because a visitor who got nothing has not used anything.
 */
import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import type { Market } from './market.js';

/** Free tries per browser per hour. */
export const FREE_TRIES_PER_HOUR = 20;
/** …and per address, shared by everyone behind it. Five browsers' worth, because an office is not an attack. */
export const FREE_TRIES_PER_NETWORK_HOUR = FREE_TRIES_PER_HOUR * 5;

const TRY_COOKIE = 'ainize_try';
const TRY_COOKIE_MAX_AGE_MS = 30 * 86_400_000;

/**
 * This browser, as a cookie.
 *
 * Returns null on the request that sets it: a visitor whose first request mints the cookie has no browser bucket
 * yet, and falls back to the network one. That is deliberate — issuing the cookie and spending against it in the
 * same request would let anybody reset their allowance by not sending cookies.
 */
export function freeTierBrowserId(req: Request, res: Response): string | null {
  const seen = (req.cookies as Record<string, unknown> | undefined)?.[TRY_COOKIE];
  if (typeof seen === 'string' && /^[0-9a-f]{32}$/.test(seen)) return seen;
  if (!res.headersSent) {
    res.cookie(TRY_COOKIE, randomBytes(16).toString('hex'), { httpOnly: true, sameSite: 'lax', maxAge: TRY_COOKIE_MAX_AGE_MS, path: '/' });
  }
  return null;
}

/** The two buckets this request spends from. Either may be null; both null means nothing to charge. */
export interface FreeTierBuckets {
  /** This browser (or, absent a cookie, the same id as `network`). */
  mine: string | null;
  network: string | null;
  /** True when the personal bucket IS the network one — the refusal is then about the address, and says so. */
  shared: boolean;
}

export function freeTierBuckets(market: Market, req: Request, res: Response): FreeTierBuckets {
  const browser = freeTierBrowserId(req, res);
  const network = market.visitorId(`ip:${req.ip}`);
  const mine = browser ? market.visitorId(`try:${browser}`) : network;
  return { mine, network, shared: mine === network };
}

export interface FreeTierRefusal {
  status: 429;
  body: { error: { message: string; type: string; code: string; param: null }; quota_reset: number; quota_scope: 'you' | 'network'; quota_limit: number };
}

/**
 * Take one try from both buckets, or say why not.
 *
 * Returns null when the caller may proceed. The tries are already taken at that point: a failed request gives
 * them back through `refundFreeTierTry`, which is what "a failed request must not burn a try" means once
 * concurrent callers exist. Checking without taking let every concurrent caller measure an untouched counter and
 * all of them pass.
 */
export function takeFreeTierTry(market: Market, buckets: FreeTierBuckets): FreeTierRefusal | null {
  const { mine, network, shared } = buckets;
  const refusal = (scope: 'you' | 'network', limit: number, bucket: string, message: string): FreeTierRefusal => ({
    status: 429,
    body: {
      error: { message, type: 'rate_limit_error', code: 'quota_exhausted', param: null },
      // Null when nothing has been spent from this bucket yet, which cannot happen on a refusal — but the page
      // reads this field unconditionally, so it gets a number rather than a hole.
      quota_reset: market.chatQuotaResetsAt(bucket) ?? Date.now() + 3600_000,
      quota_scope: scope, quota_limit: limit,
    },
  });

  if (mine && market.chatQuota(mine, FREE_TRIES_PER_HOUR, 3600_000, true) < 0) {
    return refusal(shared ? 'network' : 'you', FREE_TRIES_PER_HOUR, mine, shared
      ? `this address has used all ${FREE_TRIES_PER_HOUR} free tries for this hour — everyone sharing it shares them`
      : `free tries are used up for this hour — deposit and call /v1 to keep going`);
  }
  if (network && !shared && market.chatQuota(network, FREE_TRIES_PER_NETWORK_HOUR, 3600_000, true) < 0) {
    if (mine) market.refundChatQuota(mine);   // taken a line ago, and this request is not proceeding
    return refusal('network', FREE_TRIES_PER_NETWORK_HOUR, network,
      `this network has used all ${FREE_TRIES_PER_NETWORK_HOUR} free tries for this hour — everyone sharing this address shares them`);
  }
  return null;
}

/** Give back what `takeFreeTierTry` took, when the work did not happen. */
export function refundFreeTierTry(market: Market, buckets: FreeTierBuckets): void {
  if (buckets.mine) market.refundChatQuota(buckets.mine);
  if (buckets.network && !buckets.shared) market.refundChatQuota(buckets.network);
}

/** What is left in this visitor's own bucket, for a page that wants to say so before it runs out. */
export function freeTierRemaining(market: Market, buckets: FreeTierBuckets): number {
  return buckets.mine ? market.chatQuota(buckets.mine, FREE_TRIES_PER_HOUR, 3600_000, false) : FREE_TRIES_PER_HOUR;
}
