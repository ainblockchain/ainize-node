/**
 * Visitor (teaching-key) authentication for the teach routes — `x-ngram-auth: <address>:<ts>:<sig>[:v2]`.
 *
 * v2 (request-bound, single-use): sig = signMessage("teach:<nodeAddress>:<METHOD>:<path+query>:<ts>[:<sha256(body)>]").
 *   A captured header cannot be replayed to another route, another node, with another body, or a second time.
 * legacy: sig = signMessage("teach:<ts>") — accepted during the transition (the web app still sends it), but an exact
 *   replay (same header, same method + path) is refused; clients should move to v2 (`teachAuthHeaderFor`).
 * Both forms expire after ±5 min (`TEACH_AUTH_SKEW_MS`).
 */
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { signMessage, verifyMessage } from '@ngram/core';

export const TEACH_AUTH_SKEW_MS = 5 * 60_000;
export const TEACH_AUTH_V2 = 'v2';

export interface TeachAuthTarget { node: string; method: string; path: string; body?: string | Uint8Array | null; purpose?: string }

const sha256 = (b: string | Uint8Array) => createHash('sha256').update(b).digest('hex');

/** The string a v2 client signs. `path` is the request target as sent (path + query); the body hash is appended only when a body is sent. */
export function teachAuthMessage(t: TeachAuthTarget & { ts: number }): string {
  const parts = [t.purpose ?? 'teach', t.node, t.method.toUpperCase(), t.path, String(t.ts)];
  if (t.body !== undefined && t.body !== null && t.body.length > 0) parts.push(sha256(t.body));
  return parts.join(':');
}

/** Build a v2 header for one request (CLI / scripts; the browser helper mirrors this). */
export function teachAuthHeaderFor(key: { privateKey: string; address: string }, t: TeachAuthTarget, ts = Date.now()): string {
  return `${key.address}:${ts}:${signMessage(teachAuthMessage({ ...t, ts }), key.privateKey)}:${TEACH_AUTH_V2}`;
}

export class TeachAuth {
  /** replay cache: key → expiry (ms). v2 keys are the signature itself (single use); legacy keys are sig|method|path. */
  private seen = new Map<string, number>();
  private lastPrune = 0;
  constructor(private readonly nodeAddress: string, private readonly skewMs = TEACH_AUTH_SKEW_MS) {}

  /** Verified teaching-key address for `req`, or null (missing, malformed, expired, wrong node/route/body, or replayed). */
  verify(req: Request, purpose = 'teach'): string | null {
    const header = req.header('x-ngram-auth');
    if (!header) return null;
    const parts = header.split(':');
    if (parts.length < 3 || parts.length > 4) return null;
    const [address, tsStr, sig, ver] = parts;
    const ts = Number(tsStr);
    const now = Date.now();
    if (!address || !sig || !Number.isFinite(ts) || Math.abs(now - ts) > this.skewMs) return null;
    const method = req.method.toUpperCase();
    const path = req.originalUrl || req.url;
    let ok = false; let key: string;
    if (ver === TEACH_AUTH_V2) {
      const raw = method === 'GET' || method === 'HEAD' ? null : (req as Request & { rawBody?: Buffer }).rawBody ?? null;
      ok = verifyMessage(teachAuthMessage({ purpose, node: this.nodeAddress, method, path, ts, body: raw }), sig, address);
      key = sig;
    } else if (ver === undefined) {
      ok = verifyMessage(`${purpose}:${ts}`, sig, address);
      key = `${sig}|${method}|${path}`;
    } else return null;
    if (!ok) return null;
    this.prune(now);
    if (this.seen.has(key)) return null;
    this.seen.set(key, ts + this.skewMs);
    return address;
  }

  private prune(now: number) {
    if (now - this.lastPrune < 30_000 && this.seen.size < 20_000) return;
    this.lastPrune = now;
    for (const [k, exp] of this.seen) if (exp < now) this.seen.delete(k);
  }
}
