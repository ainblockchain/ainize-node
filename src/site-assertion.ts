/**
 * A person the SITE signed in, vouched for to this node.
 *
 * ainize.ai offers Google sign-in, and the site checks it: the ID token, the nonce, the audience. The node never
 * sees any of that and has no business redoing it. What the node needs is narrower — "this request comes from a
 * Google account the site already checked" — so that `/api/keys` can issue a key to someone who holds no wallet.
 *
 * The site says so in one header, signed with a secret only the two of them hold:
 *
 *   x-ainize-site-subject: <subject>.<issued-at seconds>.<hex HMAC-SHA256>
 *
 * The HMAC covers a fixed label, the subject and the time, so a signature minted for one of them is worthless for
 * another. It is short-lived because it is minted per request on the loopback hop; there is nothing to cache.
 *
 * Without the secret the header means nothing. A node that has not been given one ignores it entirely, so a node
 * run by anybody else behaves exactly as before, and a visitor who writes the header by hand gets a 401.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Request } from 'express';

export const SITE_SUBJECT_HEADER = 'x-ainize-site-subject';
/** Where the node looks for the secret it shares with the site in front of it. Absent = the feature is off. */
export const SITE_ASSERTION_SECRET_FILE = 'site-assertion.secret';
/** Minted per request on the loopback hop, so a minute is generous; it only has to cover clock skew. */
export const SITE_ASSERTION_MAX_AGE_S = 60;

/**
 * The only subjects the site may vouch for: a Google account, by its stable `sub`. Never an address — an address
 * is proved by its own signature, and letting the site assert one would let the site spend somebody's deposit.
 */
const SUBJECT = /^google:[0-9A-Za-z_-]{1,255}$/;

const LABEL = 'ainize-site-subject';

export function signSiteSubject(secret: string, subject: string, issuedAtS: number): string {
  const mac = createHmac('sha256', secret).update(`${LABEL}\n${subject}\n${issuedAtS}`).digest('hex');
  return `${subject}.${issuedAtS}.${mac}`;
}

/** The vouched-for subject, or null. Never throws: a malformed header is simply not an identity. */
export function verifySiteSubject(value: string | undefined, secret: string | null, nowMs = Date.now()): string | null {
  if (!secret || !value) return null;
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  const [subject, issued, mac] = parts as [string, string, string];
  if (!SUBJECT.test(subject) || !/^\d{1,12}$/.test(issued) || !/^[0-9a-f]{64}$/.test(mac)) return null;
  const issuedAtS = Number(issued);
  if (Math.abs(nowMs / 1000 - issuedAtS) > SITE_ASSERTION_MAX_AGE_S) return null;
  const expected = Buffer.from(signSiteSubject(secret, subject, issuedAtS).split('.')[2]!, 'hex');
  const given = Buffer.from(mac, 'hex');
  return expected.length === given.length && timingSafeEqual(expected, given) ? subject : null;
}

export function siteSubject(req: Request, secret: string | null): string | null {
  return verifySiteSubject(req.header(SITE_SUBJECT_HEADER) ?? undefined, secret);
}

/** `<home>/site-assertion.secret`, trimmed. Too short to be a secret counts as none, loudly. */
export function readSiteAssertionSecret(home: string | undefined): string | null {
  if (!home) return null;
  const file = join(home, SITE_ASSERTION_SECRET_FILE);
  if (!existsSync(file)) return null;
  const secret = readFileSync(file, 'utf8').trim();
  if (secret.length < 32) {
    console.error(`[site-assertion] ${file} holds fewer than 32 characters — ignoring it; the site cannot vouch for anyone`);
    return null;
  }
  return secret;
}
