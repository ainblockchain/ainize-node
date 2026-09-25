/**
 * Who is signed in on the site, readable from outside `api.ts`.
 *
 * The site's sign-in — a wallet signature in the browser, exchanged for a session cookie — already proves an
 * address. Anything else that needs to know who is asking should read that session rather than invent a second
 * way to prove the same thing; two ways to prove an identity is two places for it to be provable wrongly.
 *
 * This is the same logic `api.ts` has always had, moved where a second router can reach it. It is deliberately
 * read-only: sessions are still created and destroyed in one place.
 */
import type { Request } from 'express';
import type { Store } from './store.js';

export const SITE_SESSION_COOKIE = 'ainize_session';

export interface SiteSession {
  address: string;
  scheme: string;
  /** Set when a delegated key is acting for the address, rather than the address itself. */
  viaKey: string | null;
}

/** The session token on this request — a cookie in a browser, a bearer token from a command line. */
export function siteSessionToken(req: Request): string | null {
  const cookie = (req.cookies as Record<string, unknown> | undefined)?.[SITE_SESSION_COOKIE];
  if (typeof cookie === 'string' && cookie) return cookie;
  const auth = req.header('authorization');
  return auth?.startsWith('Bearer ') ? auth.slice(7) : null;
}

/**
 * Who is signed in, or null.
 *
 * A session written before sessions carried a subject reports the node's own address: that was the only identity
 * that could hold one, since the only way to get a session was to sign with the node's key. Saying so here keeps
 * every caller from having to decide what a null subject means.
 */
export function siteSession(req: Request, store: Store, nodeAddress: string): SiteSession | null {
  const token = siteSessionToken(req);
  if (!token) return null;
  const row = store.getSession(token);
  if (!row) return null;
  return { address: row.subject ?? nodeAddress.toLowerCase(), scheme: row.scheme ?? 'ain', viaKey: row.via_key ?? null };
}
