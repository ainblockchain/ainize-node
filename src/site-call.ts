/**
 * A call the SITE makes to this node on its own behalf — not on behalf of a visitor's request.
 *
 * site-assertion.ts vouches for a person on one relayed request (`/api/keys`). AIN SSO needs the site to do more
 * than that, and to do it as itself: "I verified an ID token for this account — make it a session", "is this
 * Google account suspended?". Those are requests the site sends to the node on the loopback hop, and the node must
 * be sure the site sent them, because the site relays everything else a visitor sends to the very same paths.
 *
 * So each such call carries one header, an HMAC under the secret the two already share (`site-assertion.secret`):
 *
 *   x-ainize-site-call: <issued-at seconds>.<32 hex nonce>.<hex HMAC-SHA256>
 *
 * over a label of its own (so a site-assertion MAC can never pass as one of these, or the other way round), the
 * method, the path, the time, a random nonce and the SHA-256 of the exact body bytes. It lives 60 seconds and is
 * single use: the node remembers every MAC it accepted until it could no longer be fresh. The nonce is what lets
 * two identical calls in the same second (two tabs asking about one Google account) both be answered. The site
 * strips this header from every request it relays, so a visitor can never even present one.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

export const SITE_CALL_HEADER = 'x-ainize-site-call';
const LABEL = 'ainize-site-call-v1';
export const SITE_CALL_MAX_AGE_S = 60;
/** Remembered MACs, at most. When full of live entries, calls are refused rather than a replay window reopened. */
const REPLAY_CAP = 50_000;

export function siteCallMac(secret: string, method: string, path: string, issuedAtS: number, nonce: string, body: Uint8Array | string): string {
  const bodyHash = createHash('sha256').update(body).digest('hex');
  return createHmac('sha256', secret).update(`${LABEL}\n${method.toUpperCase()}\n${path}\n${issuedAtS}\n${nonce}\n${bodyHash}`).digest('hex');
}

/** The header value for a call — what ainize-web's src/lib/nodeCall.ts writes (the same vector is pinned in both). */
export function signSiteCall(secret: string, method: string, path: string, issuedAtS: number, body: Uint8Array | string, nonce = randomBytes(16).toString('hex')): string {
  return `${issuedAtS}.${nonce}.${siteCallMac(secret, method, path, issuedAtS, nonce, body)}`;
}

export class SiteCallVerifier {
  private seen = new Map<string, number>();

  constructor(private readonly secret: string | null, private readonly now: () => number = Date.now) {}

  get enabled(): boolean { return !!this.secret; }

  /**
   * True when this request was signed by the site, just now, for exactly this method, path and body, and has not
   * been seen before. Never throws: anything malformed is simply not the site.
   */
  verify(req: Request, rawBody: Uint8Array | string | undefined): boolean {
    if (!this.secret) return false;
    const value = req.header(SITE_CALL_HEADER);
    const m = value ? /^(\d{1,12})\.([0-9a-f]{32})\.([0-9a-f]{64})$/.exec(value) : null;
    if (!m) return false;
    const issuedAtS = Number(m[1]);
    const nowMs = this.now();
    if (Math.abs(nowMs / 1000 - issuedAtS) > SITE_CALL_MAX_AGE_S) return false;
    const expected = Buffer.from(siteCallMac(this.secret, req.method, req.originalUrl, issuedAtS, m[2]!, rawBody ?? ''), 'hex');
    const given = Buffer.from(m[3]!, 'hex');
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return false;
    for (const [mac, until] of this.seen) if (until <= nowMs) this.seen.delete(mac);
    if (this.seen.has(m[3]!)) return false;
    if (this.seen.size >= REPLAY_CAP) return false;
    this.seen.set(m[3]!, (issuedAtS + SITE_CALL_MAX_AGE_S + 5) * 1000);
    return true;
  }
}
