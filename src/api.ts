/**
 * HTTP API of a marketplace node (Express 5).
 *  /api/*   public catalog + operator console (cookie session)
 *  /x402/*  trading endpoints (HTTP 402 Payment Required flow, ain-js compatible)
 *  /p2p/*   peer protocol (hello, peers, records, blobs)
 */
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import express, { type Request, type Response, type NextFunction, type Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import {
  AinLedger, VERSION, DATASET_MAX_BYTES_CEILING, PRICE_RE, sha256Hex, verifyPassword, hashPassword, ValidationError, X402_HEADER_PAYMENT, X402_HEADER_REQUIRED, X402_HEADER_TX, X402_HEADER_CURRENCY,
  DATASET_ACCESS_LEVELS, accessOf, effectiveVerifierShare, isDatasetLicense, preStateSha256, readNpzMember,
  type CatalogEntry, type LedgerRecord, type PatchAnchor,
} from '@ngram/core';
import { verifyAuthHeader } from './p2p.js';
import { TeachAuth } from './teach-auth.js';
import { challengedMessage, ConflictError, MarketError, MAX_CHAT_PATCHES, NotFoundError, TREE_MAX_DEPTH, type Market, type MarketEntry } from './market.js';
import { publishedRows } from './dataset-blobs.js';
import { diskReport, type DiskReport } from './disk.js';
import { gcRun, type GcOptions } from './gc.js';
import { canonicalBytes, parseDataset, questionKey } from './teach-dataset.js';
import { ChatCancelledError } from './chat-queue.js';
import type { Verifier } from './verifier.js';
import type { Drive } from './drive.js';
import { ANSWER_MAX, creditedAddress, PROMPT_MAX, TeachError, type TeachWorker } from './teach.js';
import type { RowsOp } from './teach-datasets.js';
import { PayoutError } from './payouts.js';
import { EVENT_LEVELS } from './store.js';
import type { EventRow, TeachJobRow } from './store.js';
import { buildOpenApi, CLI_REFERENCE } from './openapi.js';

export interface ApiDeps {
  market: Market; verifier: Verifier | null; drive?: Drive; teach?: TeachWorker; saveConfig: () => void;
  /** NGRAM_HOME — where the one-time setup token lives while this node has no operator password (item 121). */
  home?: string;
}

class HttpError extends Error { constructor(public status: number, message: string, /** extra fields merged into the JSON body — e.g. quota_reset on a 429 */ public body?: Record<string, unknown>) { super(message); } }
const bad = (msg: string) => new HttpError(400, msg);
const notFound = (msg = 'not found') => new HttpError(404, msg);
/** Addresses are compared case-insensitively everywhere money or identity is decided (item 309). */
const sameAddr = (a: string | undefined | null, b: string | undefined | null) => (a ?? '').toLowerCase() === (b ?? '').toLowerCase();

type Handler = (req: Request, res: Response) => Promise<unknown> | unknown;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve(fn(req, res)).then((out) => { if (out !== undefined && !res.headersSent) res.json(out); }).catch(next);
};

const SESSION_COOKIE = 'ngram_session';

/**
 * The TCP peer, not `req.ip`: with `server.trustProxy` on, `req.ip` is whatever X-Forwarded-For says, so it can be
 * forged by the very caller we are gating. Claiming an unclaimed node is only ever allowed from this machine.
 */
export function isLoopbackRequest(req: Request): boolean {
  const a = req.socket?.remoteAddress ?? '';
  return a === '::1' || a === '127.0.0.1' || a.startsWith('127.') || a === '::ffff:127.0.0.1' || /^::ffff:127\./.test(a) || a === '';
}

/** Where the one-time claim token is written while a node has no operator password (item 121). */
export const setupTokenPath = (home: string) => join(home, 'setup-token');

export function buildApi(deps: ApiDeps): Router {
  const { market } = deps;
  const router = express.Router();
  const upload = multer({ dest: join(market.cfg.dataDir, 'uploads'), limits: { fileSize: 4 * 1024 ** 3 } });
  mkdirSync(join(market.cfg.dataDir, 'uploads'), { recursive: true });
  /**
   * The temp file multer wrote for this request (item 129). Every upload route unlinks its own body in a `finally`,
   * on the success path (the handler has copied what it needs into the blob store by then) and on every rejection —
   * a failed zod parse, an unreadable npz, a duplicate id. Before this, a rejected 350 MB publish cost 350 MB and a
   * retry cost it again; the boot/hourly sweep in server.ts only catches what a crash leaves behind.
   */
  const dropTemp = (req: Request) => { const f = req.file?.path; if (f && existsSync(f)) { try { rmSync(f, { force: true }); } catch { /* already gone */ } } };

  // ------------------------------------------------------------ auth (operator)
  const isOperator = (req: Request): boolean => {
    const cookie = req.cookies?.[SESSION_COOKIE] as string | undefined;
    if (cookie && market.store.hasSession(cookie)) return true;
    const auth = req.header('authorization');
    if (auth?.startsWith('Bearer ') && market.store.hasSession(auth.slice(7))) return true;
    return false;
  };
  const requireOperator = (req: Request, _res: Response, next: NextFunction) => {
    if (!isOperator(req)) return next(new HttpError(401, 'operator login required'));
    next();
  };

  // Visitor (teaching-key) signatures: request-bound v2 or the legacy `teach:<ts>` form, both replay-guarded (teach-auth.ts).
  const teachAuth = new TeachAuth(market.address);

  /**
   * Events are public (`/api/events`); teach-mode lines carry private material (draft ids, contributor keys, the prompt
   * in the job name) in `data` and sometimes in the message. Non-operators get the message with draft ids / addresses
   * masked, `data` reduced to `{job_id}`, and no draft bookkeeping lines at all (`draft created: taught-…`).
   * For EVERY kind the visitor id is dropped from `data` and the ` by <visitor>` suffix from the message (lineage
   * design §5.6 — `usage` events used to publish `ip:<addr>` verbatim, F11). Rows written before the HMAC ids
   * existed still carry a raw address in `data.visitor`; the strip covers them too.
   */
  const publicEvents = (events: EventRow[], operator: boolean): EventRow[] => {
    if (operator) return events;
    const out: EventRow[] = [];
    const stripVisitor = (e: EventRow): EventRow => {
      const data = e.data && typeof e.data === 'object' && 'visitor' in (e.data as Record<string, unknown>)
        ? Object.fromEntries(Object.entries(e.data as Record<string, unknown>).filter(([k]) => k !== 'visitor')) : e.data;
      // `… by <visitor>: …` / `… by <visitor>` — whatever shape the id had when the row was written
      return { ...e, message: e.message.replace(/ by \S+?(?=: |$)/g, ''), data };
    };
    for (const e of events) {
      if (e.kind === 'patch' && /^draft /.test(e.message)) continue;
      if (e.kind !== 'teach') { out.push(stripVisitor(e)); continue; }
      const jobId = (e.data as { job_id?: string } | null)?.job_id;
      // (the second replace covers rows written before this redaction, whose message embedded the job name = the prompt)
      const message = e.message.replace(/taught-[a-z0-9][a-z0-9-]*/g, 'a private draft').replace(/0x[0-9a-fA-F]{6,}…?/g, 'a teaching key').replace(/^lesson queued: .*? \((\d+ correction)/s, 'lesson queued ($1');
      out.push({ ...e, message, data: jobId ? { job_id: jobId } : null });
    }
    return out;
  };

  /** Names of contributors the operator hid are dropped from public views ("Taught by a visitor"). */
  const redactContributors = <T extends CatalogEntry>(e: T): T => {
    const hidden = deps.teach?.hiddenContributors();
    if (!hidden?.size || !e.anchor.contributors?.length) return e;
    return { ...e, anchor: { ...e.anchor, contributors: e.anchor.contributors.map((c) => (hidden.has(c.address.toLowerCase()) || (c.signer && hidden.has(c.signer.toLowerCase())) ? { ...c, name: undefined } : c)) } };
  };

  const SESSION_TTL_MS = 30 * 24 * 3600_000;
  const newSession = (res: Response): string => {
    const token = randomBytes(24).toString('hex');
    market.store.putSession(token, SESSION_TTL_MS);
    res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', maxAge: SESSION_TTL_MS });
    return token;
  };
  /**
   * A node with no operator password is claimed by the first caller that asks (item 121): the session `setup` hands
   * back can announce, buy, spend the wallet and change the payout address, and the real operator is locked out for
   * good. Claiming is therefore restricted to someone who can prove they are on the node's own machine — a loopback
   * connection, or the one-time token `startNode` writes to NGRAM_HOME/setup-token, which is readable only by the
   * user the node runs as. The token is consumed by the successful claim.
   */
  const setupToken = (): string | null => {
    if (!deps.home) return null;
    try { const t = readFileSync(setupTokenPath(deps.home), 'utf8').trim(); return t || null; } catch { return null; }
  };
  const mayClaim = (req: Request): boolean => {
    if (isLoopbackRequest(req)) return true;
    const want = setupToken();
    const got = String(req.header('x-setup-token') ?? (req.body as { setup_token?: unknown } | undefined)?.setup_token ?? '').trim();
    return !!want && !!got && got === want;
  };

  router.get('/api/auth/me', wrap((req) => ({
    signedIn: isOperator(req), address: market.address, name: market.cfg.name, roles: market.cfg.roles,
    // `needsSetup: true` on an unauthenticated public request is a beacon saying "nobody owns me" — it is answered
    // truthfully only to a caller who could actually claim the node (this machine, or the operator already signed in).
    needsSetup: !market.cfg.operatorPasswordHash && (mayClaim(req) || isOperator(req)),
  })));
  router.post('/api/auth/setup', wrap((req, res) => {
    if (market.cfg.operatorPasswordHash) throw new HttpError(409, 'operator password already set');
    if (!mayClaim(req)) {
      market.log('warn', 'auth', `refused a remote attempt to claim this unclaimed node from ${req.socket?.remoteAddress ?? 'an unknown address'}`);
      // the path is deliberately NOT named: a remote caller has no business learning where this node's home is
      throw new HttpError(403, 'setup_local_only: this node has no operator password yet, and it can only be claimed from the machine it runs on — run `ainize login` there, or send the one-time token in its NGRAM_HOME/setup-token as the x-setup-token header');
    }
    const { password } = z.object({ password: z.string().min(4) }).parse(req.body);
    market.cfg.operatorPasswordHash = hashPassword(password);
    deps.saveConfig();
    if (deps.home) { try { rmSync(setupTokenPath(deps.home), { force: true }); } catch { /* the claim stands either way */ } }
    market.log('info', 'auth', 'operator password set — this node is claimed');
    return { ok: true, token: newSession(res) };
  }));
  /**
   * Item 89: one password guards sales, publishing, the wallet and the model runtime, and the door accepted
   * unlimited guesses at it — nothing in `node/src` counted an attempt. Wrong answers now cost time, doubling from
   * one second after the third failure up to half a minute, and the refusal names the recovery command instead of
   * leaving a locked-out operator to guess. Keyed by the TCP peer, never `req.ip`: with `server.trustProxy` on,
   * `req.ip` is whatever X-Forwarded-For says, so the attacker being throttled could choose their own bucket.
   * Successful sign-in clears the bucket, so one typo costs a returning operator nothing.
   */
  const LOGIN_WINDOW_MS = 15 * 60_000;
  const LOGIN_FREE_TRIES = 3;
  const loginFails = new Map<string, { n: number; until: number; last: number }>();
  const loginKey = (req: Request) => req.socket?.remoteAddress ?? 'unknown';
  const loginDelayMs = (n: number) => (n <= LOGIN_FREE_TRIES ? 0 : Math.min(30_000, 1000 * 2 ** (n - LOGIN_FREE_TRIES - 1)));
  const loginGuard = (req: Request) => {
    const now = Date.now();
    for (const [k, v] of loginFails) if (now - v.last > LOGIN_WINDOW_MS) loginFails.delete(k);
    const rec = loginFails.get(loginKey(req));
    if (!rec || now >= rec.until) return;
    const wait = Math.ceil((rec.until - now) / 1000);
    throw new HttpError(429, `too_many_attempts: ${rec.n} wrong passwords from this address — wait ${wait}s before trying again. If you have forgotten it, run \`ainize password --reset\` on the machine this node runs on.`, { retry_after_s: wait, attempts: rec.n });
  };
  const loginFailed = (req: Request) => {
    const key = loginKey(req);
    const now = Date.now();
    const prev = loginFails.get(key);
    const n = (prev && now - prev.last <= LOGIN_WINDOW_MS ? prev.n : 0) + 1;
    loginFails.set(key, { n, until: now + loginDelayMs(n), last: now });
    if (n === LOGIN_FREE_TRIES + 1 || n % 10 === 0) market.log('warn', 'auth', `${n} failed sign-in attempts from ${key} — the next one is refused for ${Math.ceil(loginDelayMs(n) / 1000)}s`);
    return n;
  };
  router.post('/api/auth/login', wrap((req, res) => {
    const { password } = z.object({ password: z.string() }).parse(req.body);
    loginGuard(req);
    // Without this the remote console showed a login box that could never work, because `needsSetup` is hidden above.
    if (!market.cfg.operatorPasswordHash) throw new HttpError(409, `not_claimed: this node has no operator password yet — set one on the machine it runs on (\`ainize login\`), or POST /api/auth/setup with the one-time token in NGRAM_HOME/setup-token`);
    if (!verifyPassword(password, market.cfg.operatorPasswordHash)) {
      const n = loginFailed(req);
      throw new HttpError(401, n > LOGIN_FREE_TRIES
        ? `wrong password (${n} failed attempts — the next try is refused for ${Math.ceil(loginDelayMs(n) / 1000)}s; \`ainize password --reset\` on this node's machine sets a new one)`
        : 'wrong password', { attempts: n, retry_after_s: Math.ceil(loginDelayMs(n) / 1000) });
    }
    loginFails.delete(loginKey(req));
    return { ok: true, token: newSession(res) };
  }));
  /**
   * Change the operator password (item 121 / review-1 item 34: there was no route, so a claimed node could never be
   * un-claimed and a leaked password was permanent). The current password is required even with a valid session, and
   * every other session is dropped — a stolen cookie must not survive the change.
   */
  router.post('/api/auth/password', requireOperator, wrap((req, res) => {
    const { current, password } = z.object({ current: z.string(), password: z.string().min(4) }).parse(req.body);
    if (!market.cfg.operatorPasswordHash || !verifyPassword(current, market.cfg.operatorPasswordHash)) throw new HttpError(401, 'wrong password');
    market.cfg.operatorPasswordHash = hashPassword(password);
    deps.saveConfig();
    market.store.deleteAllSessions();
    market.log('info', 'auth', 'operator password changed — every existing session was signed out');
    return { ok: true, token: newSession(res) };
  }));
  router.post('/api/auth/logout', wrap((req, res) => {
    const cookie = req.cookies?.[SESSION_COOKIE] as string | undefined;
    if (cookie) market.store.deleteSession(cookie);
    res.clearCookie(SESSION_COOKIE);
    return { ok: true };
  }));

  // ------------------------------------------------------------ API reference (OpenAPI 3.1 + CLI reference)
  router.get('/api/openapi.json', wrap(async () => buildOpenApi(market.publicUrl, VERSION)));
  router.get('/api/docs', wrap(async () => ({ openapi: buildOpenApi(market.publicUrl, VERSION), cli: CLI_REFERENCE, node: market.publicUrl })));

  // ------------------------------------------------------------ public info & catalog
  router.get('/api/info', wrap(async () => ({
    node: await (async () => { await market.catalog(); const self = await market.selfInfo(); return { ...self, blobs: await market.publicBlobs(self.blobs) }; })(), ledger: await market.ledger.info(), runtime: await market.runtime.status(),
    quorum: market.cfg.verifier?.quorum ?? 2, currency: market.cfg.market.currency, peers: market.p2p.peers().length,
    // `peers` stays the plain count every existing client reads; `peer_status` is the fact nobody had (item 170):
    // which peers actually ANSWERED, how many of those verify, and which publish on a ledger this node cannot read.
    peer_status: market.p2p.health(),
    // item 128: four stores grow without bound and nothing reported a single byte of them. `free` is the filesystem
    // holding dataDir; `reclaimable_*` is what `ainize gc` could take back (bodies this node neither wrote nor bought).
    disk: await nodeDisk(),
    initial_credit: market.cfg.market.initialCredit, royalty_share: market.cfg.market.royaltyShare,
    accepts_contributions: market.acceptsContributions(), contributor_share: market.teach().contributorShare,
    counts: (() => { const c = market.catalogSync().filter((e) => e.status !== 'DRAFT'); return { patches: c.length, listed: c.filter((e) => e.status === 'LISTED').length, verifying: c.filter((e) => e.status === 'ANNOUNCED' || e.status === 'VERIFYING').length, superseded: c.filter((e) => e.status === 'SUPERSEDED').length, rejected: c.filter((e) => e.status === 'REJECTED').length }; })(),
  })));

  /**
   * Bytes on disk (item 128). Recomputed at most every 30 s: `/api/info` is polled by the console every few seconds
   * and walking a blob directory of hundreds of files on every poll would be its own problem.
   */
  let diskCache: { at: number; value: DiskReport } | null = null;
  const nodeDisk = async (): Promise<DiskReport> => {
    if (diskCache && Date.now() - diskCache.at < 30_000) return diskCache.value;
    const base = diskReport(market.cfg.dataDir, { home: deps.home, ledgerFile: join(market.cfg.dataDir, 'ledger.jsonl') });
    const plan = await gcRun(market, { dryRun: true }).catch(() => null);
    const value: DiskReport = plan ? { ...base, reclaimable_files: plan.candidates.length, reclaimable_bytes: plan.bytes } : base;
    diskCache = { at: Date.now(), value };
    return value;
  };

  /** Every body this node holds, with why it has it and whether `gc` would take it (item 128). */
  router.get('/api/me/blobs', requireOperator, wrap(async () => {
    const plan = await gcRun(market, { dryRun: true });
    const reclaim = new Map(plan.candidates.map((c) => [c.sha256, c]));
    const map = await market.entryMap();
    const byName = new Map<string, { id: string; name: string; status: string }>();
    for (const e of map.values()) if (!byName.has(e.anchor.patch_sha256)) byName.set(e.anchor.patch_sha256, { id: e.anchor.id, name: e.anchor.name, status: e.status });
    const items = market.blobs.list().filter((b) => !b.path.startsWith(market.datasets.dir)).map((b) => {
      const e = byName.get(b.sha256);
      const purchased = !!e && !!market.store.getPurchase(e.id);
      return {
        sha256: b.sha256, path: b.path, size_bytes: b.size_bytes, rows: b.rows, imported_at: b.imported_at,
        patch_id: e?.id ?? null, name: e?.name ?? null, status: e?.status ?? null,
        mine: !!e && map.get(e.id)?.anchor.author === market.address,
        purchased, applied: !!e && market.isApplied(e.id),
        reclaimable: reclaim.has(b.sha256), holders: market.p2p.holders(b.sha256).length,
      };
    }).sort((a, b) => b.size_bytes - a.size_bytes);
    return { items, disk: await nodeDisk(), reclaimable_bytes: plan.bytes, kept: plan.kept };
  }));
  /**
   * Delete the verification copies. `dry_run` is the default so nothing is removed by a mistyped filter; the answer
   * is the same shape either way, so the CLI can show the plan and then repeat the call for real.
   */
  router.post('/api/me/blobs/gc', requireOperator, wrap(async (req) => {
    const b = z.object({
      dry_run: z.boolean().default(true),
      keep_purchased: z.boolean().default(true),
      older_than_ms: z.number().int().min(0).max(3650 * 86_400_000).nullable().optional(),
      allow_sole_copy: z.boolean().default(false),
    }).parse(req.body ?? {});
    const opts: GcOptions & { dryRun: boolean } = { dryRun: b.dry_run, keepPurchased: b.keep_purchased, allowSoleCopy: b.allow_sole_copy, olderThanMs: b.older_than_ms ?? undefined };
    const r = await gcRun(market, opts);
    if (!b.dry_run) diskCache = null;
    return { ...r, disk: await nodeDisk() };
  }));

  router.get('/api/catalog', wrap(async (req) => {
    const q = z.object({
      sort: z.enum(['latest', 'popular', 'price', 'rows', 'built_on', 'trending']).default('latest'),
      status: z.string().optional(), model: z.string().optional(), schema: z.string().optional(), branch: z.string().optional(),
      author: z.string().optional(), contributor: z.string().optional(), origin: z.enum(['operator', 'teach']).optional(), q: z.string().optional(),
      limit: z.coerce.number().min(1).max(200).default(50), offset: z.coerce.number().min(0).default(0),
      include_drafts: z.coerce.boolean().default(false),
    }).parse(req.query);
    // Private drafts never leak to anonymous callers — the facet lists (models/schemas) are derived from the same filtered set as the items.
    let items = await market.catalog();
    if (!q.include_drafts || !isOperator(req)) items = items.filter((e) => e.status !== 'DRAFT');
    // Knowledge its own author retired is off the shelves (item 148) — `?status=RETIRED` still lists it, so the
    // publisher's own screens and `patch ls --status RETIRED` can find what was taken down.
    if (!q.status?.split(',').includes('RETIRED')) items = items.filter((e) => e.status !== 'RETIRED');
    const facets = items;
    if (q.status) items = items.filter((e) => q.status!.split(',').includes(e.status));
    if (q.model) items = items.filter((e) => e.anchor.model.id_M === q.model);
    if (q.schema) items = items.filter((e) => e.anchor.benchmark.schema === q.schema);
    if (q.author) items = items.filter((e) => e.anchor.author === q.author);
    if (q.contributor) { const c = q.contributor.toLowerCase(); items = items.filter((e) => (e.anchor.contributors ?? []).some((x) => creditedAddress(x).toLowerCase() === c)); }
    if (q.origin) items = items.filter((e) => (e.anchor.origin ?? 'operator') === q.origin);
    const allBranches = q.branch || q.q ? await market.branches() : [];
    if (q.branch) { const b = allBranches.find((x) => x.name === q.branch); items = items.filter((e) => b?.patch_ids.includes(e.anchor.id)); }
    /**
     * What a knowledge KNOWS is what people search for (items 25 + 206). The haystack used to be
     * `[id, name, description, model, schema]`, so `samsung` and `삼성` returned nothing on a catalogue whose
     * flagship answers 2,761 Korean tickers, and neither a track, a topic, a creator's name nor a date could find
     * anything. Everything the anchor publicly declares is searchable now, the benchmark samples included — and
     * `matched` says WHICH sample matched, so the card can show the question that made it a hit instead of leaving
     * the reader to guess why a row is in the list.
     */
    const searchable = (e: CatalogEntry) => {
      const a = redactContributors(e).anchor;
      const day = new Date(a.created_at);
      return [
        a.id, a.name, a.description ?? '', a.model.id_M, a.benchmark.schema, a.topic_path, a.branch ?? '',
        a.author, a.author_name ?? '', ...(a.contributors ?? []).map((c) => c.name ?? ''),
        ...allBranches.filter((b) => b.patch_ids.includes(a.id)).map((b) => b.name),
        Number.isFinite(day.getTime()) ? day.toISOString().slice(0, 10) : '',
        ...(a.benchmark.samples ?? []).flatMap((x) => [x.prompt, x.expect]),
      ].join(' \u0001 ').toLowerCase();
    };
    /** The sample that made this a hit — only when the words on the card do not already explain the match. */
    const matchedSample = (e: CatalogEntry, s: string) => {
      const a = e.anchor;
      if ([a.id, a.name, a.description ?? ''].join(' ').toLowerCase().includes(s)) return null;
      return (a.benchmark.samples ?? []).find((x) => `${x.prompt} ${x.expect}`.toLowerCase().includes(s)) ?? null;
    };
    const needle = q.q?.trim().toLowerCase() ?? '';
    if (needle) items = items.filter((e) => searchable(e).includes(needle));
    // "Most popular" ranks by status FIRST: downloads accumulate forever, so a retired single-fact patch with 187
    // downloads used to head the marketplace over the flagship it was replaced by. Tradeable before retired.
    const statusRank = (s: string) => (s === 'LISTED' ? 0 : s === 'SUPERSEDED' ? 2 : s === 'REJECTED' ? 3 : 1);
    // "Most built on" and "Doing well this week" (design §10) — the first is a network fact (children on the ledger
    // plus this node's derive intents), the second a node-local weekly score; both are computed once per entry here,
    // never per comparison, so the sort cannot cost O(n log n) database reads.
    const map = await market.entryMap();
    const built = new Map(items.map((e) => [e.anchor.id, market.builtOnCount(e, map)]));
    const weekly = new Map(items.map((e) => [e.anchor.id, market.weeklyScore(e)]));
    const sorters = {
      latest: (a: typeof items[0], b: typeof items[0]) => b.anchor.created_at - a.anchor.created_at,
      popular: (a: typeof items[0], b: typeof items[0]) => statusRank(a.status) - statusRank(b.status) || b.downloads - a.downloads || b.passed - a.passed,
      price: (a: typeof items[0], b: typeof items[0]) => Number(a.anchor.price) - Number(b.anchor.price),
      rows: (a: typeof items[0], b: typeof items[0]) => b.anchor.rows - a.anchor.rows,
      built_on: (a: typeof items[0], b: typeof items[0]) => (built.get(b.anchor.id) ?? 0) - (built.get(a.anchor.id) ?? 0) || b.anchor.created_at - a.anchor.created_at,
      trending: (a: typeof items[0], b: typeof items[0]) => (weekly.get(b.anchor.id) ?? 0) - (weekly.get(a.anchor.id) ?? 0) || b.anchor.created_at - a.anchor.created_at,
    };
    items = [...items].sort(sorters[q.sort]);
    const total = items.length;
    // SC-17 card lines: how often this knowledge was built on, and what a buyer has to load with it
    const page = items.slice(q.offset, q.offset + q.limit).map((e) => ({
      ...redactContributors(e), attestations: e.attestations.map((a) => ({ ...a, sig: undefined })),
      built_on: built.get(e.anchor.id) ?? 0,
      requires: (e.anchor.base?.stack ?? []).map((b) => ({ id: b.patch_id, name: map.get(b.patch_id)?.anchor.name ?? b.patch_id })),
      matched: needle ? matchedSample(e, needle) : undefined,
    }));
    return { total, items: page, models: [...new Set(facets.map((e) => e.anchor.model.id_M))], schemas: [...new Set(facets.map((e) => e.anchor.benchmark.schema))] };
  }));

  /**
   * Which related entries (lineage parents/children, overlap partners) may this caller see next to `subject`?
   * Same rule as the catalog: private drafts only for the operator; hidden test anchors only when the node opts in
   * (includeTestAnchors) or the subject itself is a test anchor — so fixtures never surface on public knowledge pages.
   */
  const relativeVisible = (req: Request, subject: CatalogEntry) => {
    const operator = isOperator(req);
    const showTest = !!market.cfg.includeTestAnchors || subject.anchor.visibility === 'test';
    return (x: CatalogEntry | undefined): x is CatalogEntry => !!x && (x.status !== 'DRAFT' || operator) && (x.anchor.visibility !== 'test' || showTest);
  };

  /**
   * "patch not found" was the whole answer a node gave for knowledge that exists, is announced, and is held by a peer
   * this node talks to every four seconds — it just publishes on a ledger this node cannot read (item 170). Ask the
   * peers before answering, and say which node has it and why it is invisible here. Bounded: at most four peers, a
   * 1.5 s timeout each, and the answer (found or not) is cached for a minute so a 404 cannot be used to fan out load.
   */
  const lookupCache = new Map<string, { at: number; hint: Record<string, unknown> | null }>();
  const unknownPatch = async (id: string): Promise<HttpError> => {
    const miss = () => new HttpError(404, 'patch not found');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id)) return miss();
    const cached = lookupCache.get(id);
    const hint = cached && Date.now() - cached.at < 60_000 ? cached.hint : await (async () => {
      const peers = market.p2p.peers().slice(0, 4);
      const found = (await Promise.all(peers.map(async (p) => {
        try {
          const r = await fetch(`${p.endpoint}/api/patches/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(1500) });
          if (!r.ok) return null;
          const body = (await r.json()) as { anchor?: { name?: string; price?: string; currency?: string } };
          return body?.anchor ? { endpoint: p.endpoint, node: p.info?.name ?? p.endpoint, ledger: p.info?.ledger ?? null, name: body.anchor.name ?? id, price: body.anchor.price ?? null, currency: body.anchor.currency ?? null } : null;
        } catch { return null; }
      }))).find(Boolean) ?? null;
      const out = found ? { holder: found } : null;
      lookupCache.set(id, { at: Date.now(), hint: out });
      return out;
    })();
    if (!hint?.holder) return miss();
    const h = hint.holder as { endpoint: string; node: string; ledger: string | null; name: string };
    const mismatch = !!h.ledger && h.ledger !== market.ledger.kind;
    return new HttpError(404, mismatch
      ? `patch not found here: "${h.name}" is published by ${h.node} on the ${h.ledger === 'ain' ? 'AIN' : 'local'} ledger, and this node reads the ${market.ledger.kind === 'ain' ? 'AIN chain' : 'local record DAG'} — it can never appear in this catalogue. Trade with that node directly (--node ${h.endpoint}), or re-init this one with \`ainize init --force --ledger ${h.ledger}${h.ledger === 'ain' ? ' --ain-provider <url>' : ''}\`.`
      : `patch not found here yet: "${h.name}" is published by ${h.node} (${h.endpoint}) and has not reached this node's records — trade with that node directly (--node ${h.endpoint}), or wait for the next gossip round.`,
      { patch_id: id, holder: h, ledger_mismatch: mismatch, own_ledger: market.ledger.kind });
  };

  router.get('/api/patches/:id', wrap(async (req) => {
    const e = await market.entry(req.params.id as string);
    if (!e) throw await unknownPatch(req.params.id as string);
    if (e.status === 'DRAFT' && !isOperator(req)) throw notFound('patch not found');
    const map = await market.entryMap();
    const visible = relativeVisible(req, e);
    const lineage = { parents: e.anchor.parents.map((p) => map.get(p)).filter(visible).map((x) => ({ id: x.anchor.id, name: x.anchor.name, author: x.anchor.author, status: x.status })),
      children: e.children.map((c) => map.get(c)).filter(visible).map((x) => ({ id: x.anchor.id, name: x.anchor.name, author: x.anchor.author, status: x.status })) };
    const conflicts = (await market.conflicts(e.anchor.id).catch(() => [])).filter((c) => visible(map.get(c.patch_id)));
    const branches = (await market.branches()).filter((b) => b.patch_ids.includes(e.anchor.id)).map((b) => ({ name: b.name, context: b.context }));
    /**
     * Lineage (design §12.5) + item 270: a delta child needs its base stack loaded first, and buying the child
     * alone buys a file that answers nothing until they are under it. `requires` is now the WHOLE stack, deepest
     * first (a base's own bases included), each with its price, its seller and whether this node already holds it;
     * `quote` adds up what the family actually costs from here. Fields that were already here keep their meaning.
     */
    const quote = await market.quoteFor(e, map);
    const requires = quote.requires.map((r) => ({
      id: r.id, name: r.name, held: r.held, price: r.known ? r.price : null,
      currency: r.currency, author: r.author, author_name: r.author_name ?? null, gateway_url: r.gateway_url ?? null,
      depth: r.depth, known: r.known, licensed: r.licensed, purchased: r.purchased, mine: r.mine,
    }));
    return {
      ...redactContributors(e), lineage, conflicts, branches, requires, quote,
      dataset_held: !!e.anchor.dataset?.sha256 && market.datasets.has(e.anchor.dataset.sha256),
      owned: e.anchor.author === market.address, purchased: !!market.store.getPurchase(e.anchor.id), has_body: market.blobs.has(e.anchor.patch_sha256),
      applied: market.isApplied(e.anchor.id), gateway_url: (e.anchor as PatchAnchor & { gateway_url?: string }).gateway_url ?? null,
      /**
       * Where the seller answers TODAY (item 275). `gateway_url` above is the address frozen into the immutable
       * anchor: a node that changed its port keeps a listing that looks open and cannot be entered. This one is
       * resolved from the peers this node currently sees, and says where the answer came from.
       */
      gateway: market.gatewaysFor(e.anchor, (await market.ledger.nodes().catch(() => [])).map((n) => ({ address: n.body.address, endpoint: n.body.endpoint, last_seen: n.body.last_seen })))[0] ?? null,
      // the author's own takedown, when there is one (item 148)
      retired_at: (e as MarketEntry).retired_at ?? null, retire_reason: (e as MarketEntry).retire_reason ?? null,
      /**
       * Why an announced knowledge is still not verified (item 154). The publish-time model check only fires on a
       * node whose engine answers; when it cannot, the author used to get `ANNOUNCED 0/2` and no error anywhere on
       * their own machine. Null until it has genuinely waited, and null once the quorum is met.
       */
      stalled: market.verificationStall(e),
    };
  }));

  // ------------------------------------------------------------ published training sets (lineage design §12.3)
  /** The entry behind `/api/patches/:id/dataset*`, its sha, and who is asking (teaching key or operator). */
  const datasetOf = async (req: Request) => {
    const e = await market.entry(req.params.id as string);
    const operator = isOperator(req);
    if (!e || (e.status === 'DRAFT' && !operator)) throw notFound('patch not found');
    const sha = e.anchor.dataset?.sha256;
    if (!sha) throw new HttpError(404, 'dataset_unavailable: this knowledge has no published training set');
    const address = teacherOf(req);
    const access = accessOf(e.anchor);
    const owner = !!address && ((e.anchor.contributors ?? []).some((c) => c.address.toLowerCase() === address.toLowerCase() || c.signer?.toLowerCase() === address.toLowerCase()) || e.anchor.author.toLowerCase() === address.toLowerCase());
    return { e, sha, operator, address, access, owner: owner || operator };
  };
  router.get('/api/patches/:id/dataset', wrap(async (req) => {
    const { e, sha, access, address, owner } = await datasetOf(req);
    const held = market.datasets.has(sha);
    const m = market.datasets.manifest(sha);
    const meta = { sha256: sha, rows: e.anchor.dataset!.rows, access, license: e.anchor.dataset!.license ?? null, parents: e.anchor.dataset!.parents ?? [], held, include_notes: m?.include_notes ?? false, benchmark_samples: m?.benchmark_samples ?? null, merkle_root: m?.merkle_root ?? null };
    if (!owner) {
      if (access === 'private') throw new HttpError(403, 'dataset_private: the creator kept the training set private — only the verification questions on the record are public', meta);
      if (access === 'derivative' && !address) throw new HttpError(403, 'dataset_derivative_only: this training set is available to people building on this knowledge — sign the request with a teaching key to preview it, and ask for a derive token to fetch it', meta);
    }
    if (!held) throw new HttpError(404, 'dataset_unavailable: training set not available on this node (no peer holds it)', meta);
    const preview = publishedRows(market.datasets.rows(sha).slice(0, 20), m?.include_notes ?? false);
    // Item 312: the creator of the material can see who took it and who kept the promise. Keys are never shown to
    // anyone else — the counts on the public page are `built on N times`, which is what a stranger may know.
    const derives = owner
      ? market.store.deriveIntentsFor(e.anchor.id).map((d) => ({ child_key: d.child_key, first_at: d.first_at, last_at: d.last_at, fetches: d.fetches, declared_by: d.declared_by }))
      : undefined;
    return { ...meta, preview, ...(derives ? { derives } : {}) };
  }));
  router.get('/api/patches/:id/dataset/rows', wrap(async (req, res) => {
    const { sha, access, owner } = await datasetOf(req);
    if (!owner && access !== 'public') throw new HttpError(403, access === 'private' ? 'dataset_private: the creator kept the training set private' : 'dataset_derivative_only: fetch it through a derive intent (POST /api/patches/:id/derive-intent) and /p2p/dataset/:sha');
    const bytes = market.datasets.rowsBytes(sha);
    if (!bytes) throw new HttpError(404, 'dataset_unavailable: training set not available on this node (no peer holds it)');
    res.status(200).set({ 'content-type': 'application/x-ndjson; charset=utf-8', 'content-length': String(bytes.length), 'x-content-sha256': sha, 'content-disposition': `attachment; filename="dataset-${sha.slice(0, 12)}.jsonl"` }).send(bytes);
  }));
  router.get('/api/patches/:id/dataset/manifest', wrap(async (req) => {
    const { sha, access, address, owner } = await datasetOf(req);
    if (!owner && access === 'private') throw new HttpError(403, 'dataset_private: the creator kept the training set private');
    if (!owner && access === 'derivative' && !address) throw new HttpError(403, 'dataset_derivative_only: sign the request with a teaching key');
    const m = market.datasets.manifest(sha);
    if (!m) throw new HttpError(404, 'dataset_unavailable: training set not available on this node (no peer holds it)');
    return { manifest: m };
  }));
  /**
   * A signed derive intent (design §6.1): the teaching key says it is building on this knowledge; counted on the
   * knowledge ("built on N times") and answered with a token that unlocks `/p2p/dataset/:sha` for a derivative set.
   */
  router.post('/api/patches/:id/derive-intent', wrap(async (req) => {
    const address = requireTeacher(req);
    const e = await market.entry(req.params.id as string);
    if (!e || e.status === 'DRAFT') throw notFound('patch not found');
    const access = accessOf(e.anchor);
    if (access === 'private') throw new HttpError(403, 'dataset_private: the creator kept the training set private, so nobody can build on it');
    const { child_key } = z.object({ child_key: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional() }).parse(req.body ?? {});
    if (child_key && child_key.toLowerCase() !== address.toLowerCase()) throw new HttpError(400, 'invalid: child_key must be the teaching key that signed this request');
    const out = market.deriveIntent(e, address);
    // The commitment is the answer, not a side effect: the caller is told, in the same breath as the token, what they
    // have just promised — that anything published from these questions has to name this knowledge as its parent.
    return { ...out, holders: [market.publicUrl, ...market.p2p.datasetHolders(out.sha256)], held: market.datasets.has(out.sha256),
      terms: `recorded: ${address} is building on ${e.anchor.id}. A lesson trained on these questions must name ${e.anchor.id} as its base, or this node will refuse to publish it.` };
  }));
  /**
   * *Copy and continue* (design §12.3, Story B): the knowledge's published questions become a dataset of the caller's,
   * with the knowledge as its parent and every row carrying `from`. Idempotent — the same bytes give the same dataset.
   */
  router.post('/api/patches/:id/fork', wrap(async (req, res) => {
    const address = requireTeacher(req);
    const t = visitorGate(req, address);
    const body = z.object({ name: z.string().max(80).optional() }).parse(req.body ?? {});
    const out = await t.forkPatch(req.params.id as string, { address, ip: req.ip }, { name: body.name });
    res.status(out.created ? 201 : 200);
    return { dataset_id: out.dataset.id, dataset: out.dataset, inherited_rows: out.inherited_rows, created: out.created, parent: out.parent, license: out.license };
  }));

  router.get('/api/patches/:id/records', wrap(async (req) => {
    const id = req.params.id as string;
    const all = await market.ledger.list();
    const recs = all.filter((r) => { const b = r.body as Record<string, unknown>; return b.id === id || b.patch_id === id || b.old_patch_id === id || b.new_patch_id === id; });
    return { records: recs };
  }));

  router.get('/api/patches/:id/events', wrap(async (req) => {
    const operator = isOperator(req);
    const e = await market.entry(req.params.id as string);
    if (e?.status === 'DRAFT' && !operator) throw notFound('patch not found');
    return { events: publicEvents(market.store.events({ patch_id: req.params.id as string, limit: Number(req.query.limit ?? 200) }), operator) };
  }));

  /**
   * Explore shelves (SC-17). Four rows a visitor can act on: what is selling, what people are building ON, what is
   * newly published, and what this node's visitors asked for that nobody has taught yet. Every number is one this
   * node can defend: sales come from settle records (price-0 and self-purchases excluded, §10), *built on* is
   * children plus derive intents, *asked* is the open-question counters — never a guess.
   */
  router.get('/api/explore/shelves', wrap(async (req) => {
    const q = z.object({ limit: z.coerce.number().min(1).max(20).default(6) }).parse(req.query);
    const map = await market.entryMap();
    const items = (await market.catalog()).filter((e) => e.status !== 'DRAFT' && e.status !== 'REJECTED' && e.status !== 'RETIRED');
    const card = (e: CatalogEntry, extra: Record<string, unknown>) => ({
      id: e.anchor.id, name: e.anchor.name, author: e.anchor.author, author_name: e.anchor.author_name ?? null, status: e.status,
      price: e.anchor.price, currency: e.anchor.currency, rows: e.anchor.rows, topic_path: e.anchor.topic_path,
      requires: (e.anchor.base?.stack ?? []).map((b) => ({ id: b.patch_id, name: map.get(b.patch_id)?.anchor.name ?? b.patch_id })),
      ...extra,
    });
    const byBuilt = items.map((e) => ({ e, n: market.builtOnCount(e, map) })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n).slice(0, q.limit);
    const bySales = items.map((e) => ({ e, s: market.salesOf(e) })).filter((x) => x.s.sales_30d > 0).sort((a, b) => b.s.sales_30d - a.s.sales_30d).slice(0, q.limit);
    const fresh = [...items].sort((a, b) => b.anchor.created_at - a.anchor.created_at).slice(0, q.limit);
    // "Asked for (this node)": open questions grouped by the topic they were asked about, with the knowledge they
    // were asked of. `nobody_teaches` = every knowledge holding that question is still the one that could not answer it.
    const asked = new Map<string, { topic: string; count: number; people: number; patches: Set<string> }>();
    for (const { patch_id } of market.store.issueCounts()) {
      const e = map.get(patch_id);
      if (!e || e.status === 'DRAFT') continue;
      for (const i of market.store.listIssues(patch_id, { limit: 200 })) {
        if (i.kind === 'own_miss') continue;                    // its own question, not a gap in the market
        const topic = i.topic ?? e.anchor.topic_path ?? e.anchor.benchmark.schema;
        const cur = asked.get(topic) ?? { topic, count: 0, people: 0, patches: new Set<string>() };
        cur.count += i.count; cur.people = Math.max(cur.people, i.people); cur.patches.add(patch_id);
        asked.set(topic, cur);
      }
    }
    return {
      shelves: [
        { id: 'selling', items: bySales.map(({ e, s }) => card(e, { sales_30d: s.sales_30d, sales_all: s.sales_all })) },
        { id: 'built_on', items: byBuilt.map(({ e, n }) => card(e, { built_on: n })) },
        { id: 'fresh', items: fresh.map((e) => card(e, { created_at: e.anchor.created_at })) },
      ],
      asked: [...asked.values()].sort((a, b) => b.count - a.count).slice(0, q.limit).map((x) => ({ topic: x.topic, count: x.count, people: x.people, patches: [...x.patches] })),
      scope: { sales: 'network', built_on: 'network+node', asked: 'node' },
    };
  }));

  // ------------------------------------------------------------ family tree, signals, open questions (design §12.5)
  /**
   * The family tree (SC-9). Read-only and ungated by `teach.lineage` — knowing where a knowledge came from is not a
   * creator affordance (§18 gating); only *Build on this* is. Ancestors are walked through `parents[]`, descendants
   * through the catalog's derived children, versions through supersede records; the walk is cycle-safe and capped.
   */
  router.get('/api/patches/:id/tree', wrap(async (req) => {
    const q = z.object({ depth: z.coerce.number().min(1).max(TREE_MAX_DEPTH).default(4), dir: z.enum(['up', 'down', 'both']).default('both') }).parse(req.query);
    const e = await market.entry(req.params.id as string);
    if (!e || (e.status === 'DRAFT' && !isOperator(req))) throw notFound('patch not found');
    return market.lineageTree(e.anchor.id, { depth: q.depth, dir: q.dir, visible: relativeVisible(req, e) });
  }));

  /** SC-11 — what this knowledge is doing. `network` comes from the ledger and the peer table; `node` is this node's own 30 days, labelled. */
  router.get('/api/patches/:id/signals', wrap(async (req) => {
    const e = await market.entry(req.params.id as string);
    if (!e || (e.status === 'DRAFT' && !isOperator(req))) throw notFound('patch not found');
    const s = await market.signalsOf(e);
    return { patch_id: e.anchor.id, network: { scope: 'network', ...s.network }, node: { scope: 'node', ...s.node } };
  }));

  /**
   * SC-12 "What to add on top of this". Counts are public; the TEXT of a question is returned only when it is already
   * public on the record (an `own_miss` resolves its prompt from `benchmark.samples[sample_index]`) or when the person
   * who reported it chose *Share* (§10). Everything else is a count and a cluster id.
   */
  router.get('/api/patches/:id/issues', wrap(async (req) => {
    const q = z.object({ kind: z.enum(['own_miss', 'preflight', 'free_wrong', 'request', 'gap']).optional(), status: z.enum(['open', 'covered', 'all']).default('open'), limit: z.coerce.number().min(1).max(200).default(50) }).parse(req.query);
    const e = await market.entry(req.params.id as string);
    if (!e || (e.status === 'DRAFT' && !isOperator(req))) throw notFound('patch not found');
    const samples = e.anchor.benchmark.samples ?? [];
    const items = market.store.listIssues(e.anchor.id, q).map((i) => ({
      id: i.id, kind: i.kind, count: i.count, people: i.people, topic: i.topic,
      // an own miss is a question the anchor already publishes — reading it back off the record stores nothing new
      text: i.text ?? (i.kind === 'own_miss' && i.sample_index !== null ? samples[i.sample_index]?.prompt ?? null : null),
      sample_index: i.sample_index, status: i.status,
      covered_by: i.status.startsWith('covered_by:') ? i.status.slice('covered_by:'.length) : null,
      first_seen: i.first_seen, last_seen: i.last_seen,
    }));
    const counts = market.store.listIssues(e.anchor.id, { limit: 500 }).reduce((m, i) => { m[i.kind] = (m[i.kind] ?? 0) + 1; return m; }, {} as Record<string, number>);
    return { patch_id: e.anchor.id, total: items.length, counts, items };
  }));

  /** SC-12 *Ask the creator to add…* — a buyer's own request. Their own text is theirs to share, so `share` decides whether it is kept. */
  router.post('/api/patches/:id/issues', wrap(async (req, res) => {
    const body = z.object({ kind: z.literal('request').default('request'), topic: z.string().max(120).optional(), text: z.string().min(1).max(PROMPT_MAX), share: z.boolean().default(false) }).parse(req.body ?? {});
    const e = await market.entry(req.params.id as string);
    if (!e || e.status === 'DRAFT') throw notFound('patch not found');
    const address = teacherOf(req);
    const visitor = market.visitorId(address ? `key:${address.toLowerCase()}` : `ip:${req.ip}`);
    if (market.chatQuota(`req:${visitor}`, 20, 3600_000, true) < 0) throw new HttpError(429, 'quota_requests: too many requests from here this hour');
    const issue = market.store.bumpIssue(e.anchor.id, 'request', market.questionCluster(body.text), { text: body.share ? body.text : null, topic: body.topic ?? null, visitor });
    res.status(201);
    return { id: issue.id, kind: issue.kind, count: issue.count, people: issue.people, shared: !!issue.text };
  }));

  router.get('/api/benchmarks/:schema', wrap(async (req) => {
    const schema = req.params.schema as string;
    const items = (await market.catalog()).filter((e) => e.anchor.benchmark.schema === schema && e.status !== 'DRAFT');
    if (!items.length) throw notFound('no patches for that benchmark schema');
    return { schema, items };
  }));

  router.get('/api/ledger', wrap(async (req) => {
    // The window is the NEWEST `limit` records. A ledger bigger than the window cannot be paged backwards, so the
    // cap is high enough to export a demo chain in one call and every caller is expected to compare what it got
    // with `info.records` and say when it is showing only part of the record (web: the "most recent N of M" line).
    const q = z.object({ since: z.coerce.number().optional(), kind: z.string().optional(), limit: z.coerce.number().max(5000).default(200) }).parse(req.query);
    const recs = await market.ledger.list({ since: q.since, kind: q.kind as never, limit: q.limit });
    return { info: await market.ledger.info(), records: recs.reverse() };
  }));
  router.get('/api/ledger/verify', wrap(async () => market.ledger.verify()));
  router.get('/api/ledger/graph', wrap(async () => {
    const cat = await market.catalog();
    const nodes = cat.filter((e) => e.status !== 'DRAFT').map((e) => ({ id: e.anchor.id, name: e.anchor.name, author: e.anchor.author, status: e.status, model: e.anchor.model.id_M, schema: e.anchor.benchmark.schema, branch: e.anchor.branch }));
    const edges: { from: string; to: string; type: string }[] = [];
    for (const e of cat) {
      for (const p of e.anchor.parents) edges.push({ from: e.anchor.id, to: p, type: 'extends' });
      for (const s of e.supersedes) edges.push({ from: e.anchor.id, to: s, type: 'supersedes' });
    }
    let chain: unknown = null;
    if (market.ledger instanceof AinLedger) chain = await market.ledger.graph().catch(() => null);
    return { nodes, edges, chain };
  }));

  router.get('/api/branches', wrap(async () => {
    const branches = await market.branches();
    const subs = await market.ledger.subscriptions();
    const nodes = await market.knownNodes();
    return { branches: await Promise.all(branches.map(async (b) => {
      const state = new Map<string, boolean>();
      for (const r of subs) if (r.body.branch === b.name) state.set(r.body.node, r.body.action === 'subscribe');
      return {
        ...b,
        subscribers: [...state.entries()].filter(([, v]) => v).map(([k]) => nodes.find((n) => n.address === k) ?? { address: k }),
        // Item 257 — `patch_ids` is the whole history of the track; `current` is what a subscriber actually loads
        // (a version retired by a newer member of the same track is kept as history and never bought again).
        current: await market.currentTrackIds(b),
      };
    })), mine: await market.mySubscriptions() };
  }));
  router.get('/api/route', wrap(async (req) => market.route(req.query as Record<string, string>)));
  router.get('/api/nodes', wrap(async () => {
    // visitors count knowledge files of public knowledge only (hidden test anchors / drafts are not part of the public catalog)
    // `blobs_advertised` is what the node itself said it holds: `blobs` is filtered through THIS node's catalogue, so a
    // peer on another ledger — whose anchors this node can never read — showed BLOBS 0 while holding four (item 170).
    const own = market.ledger.kind;
    const nodes = await Promise.all((await market.knownNodes()).map(async (n) => ({
      ...n, blobs: await market.publicBlobs(n.blobs ?? []), blobs_advertised: (n.blobs ?? []).length,
      ledger_mismatch: n.address !== market.address && !!n.ledger && n.ledger !== own,
    })));
    const peers = market.p2p.peers().map((p) => ({
      ...p,
      reachable: p.failures === 0 && p.last_seen > 0,
      ledger: p.info?.ledger ?? null,
      ledger_mismatch: !!p.info?.ledger && p.info.ledger !== own,
    }));
    return { nodes, peers, self: market.address, ledger: own, peer_status: market.p2p.health() };
  }));
  router.get('/api/events', wrap(async (req) => ({
    events: publicEvents(market.store.events({
      since: req.query.since ? Number(req.query.since) : undefined,
      limit: Number(req.query.limit ?? 200),
      kind: req.query.kind as string | undefined,
      level: EVENT_LEVELS.includes(req.query.level as (typeof EVENT_LEVELS)[number]) ? (req.query.level as (typeof EVENT_LEVELS)[number]) : undefined,
    }), isOperator(req)),
  })));
  router.get('/api/chain', wrap(async () => market.chainStatus()));

  // ------------------------------------------------------------ operator actions
  router.get('/api/me/patches', requireOperator, wrap(async () => ({ items: (await market.catalogAll()).filter((e) => e.anchor.author === market.address) })));
  router.get('/api/me/purchases', requireOperator, wrap(async () => {
    const map = await market.entryMap();
    return { items: market.store.listPurchases().map((p) => ({ ...p, entry: map.get(p.patch_id) ?? null, applied: market.isApplied(p.patch_id) })) };
  }));
  /**
   * The wallet. Its royalty lines used to be the SELLER's promise reported as money received (item 311): a settle
   * record naming this address became a row on "creator revenue share received" whether or not anything ever moved,
   * and the only place the truth lived was the seller's own `payouts` table, which the ancestor cannot see. Each row
   * now carries its own state — `credited` (local play money, already in the balance derived here), `paid`/`pending`
   * /`failed` (asked the seller's node, which answers `GET /p2p/payouts/:settle_hash`), or `unconfirmed` (nothing
   * but the record) — plus the totals for each, so the three numbers can be reconciled on one screen.
   *
   * `verification` is the same money seen by the other party (item 325): what this node earned by verifying.
   */
  router.get('/api/me/wallet', requireOperator, wrap(async () => {
    const setts = await market.ledger.settlements();
    const me = market.address.toLowerCase();
    const sales = setts.filter((s) => sameAddr(s.body.seller, market.address)).map((s) => s.body);
    const map = await market.entryMap();
    const mineIn = (r: Record<string, string> | undefined) => Object.entries(r ?? {}).find(([a]) => a.toLowerCase() === me);
    const rows = setts.filter((s) => !sameAddr(s.body.seller, market.address) && mineIn(s.body.royalty));
    const reports = await market.payoutReports(rows.map((s) => ({ hash: s.hash, seller: s.body.seller })));
    const royalties = rows.map((s) => {
      const [, amount] = mineIn(s.body.royalty)!;
      const e = map.get(s.body.patch_id);
      const kind = e?.verifiers.some((v) => v.toLowerCase() === me) ? 'verification' as const : 'lineage' as const;
      const rep = reports.get(s.hash);
      const state = s.body.scheme === 'local-credit' ? 'credited' as const : (rep?.status ?? 'unconfirmed' as const);
      return {
        patch_id: s.body.patch_id, amount, created_at: s.body.created_at,       // the shape every older client reads
        kind, state, settle_hash: s.hash, seller: s.body.seller, seller_name: e?.anchor.author_name ?? null,
        buyer: s.body.buyer, currency: s.body.currency, scheme: s.body.scheme,
        tx_hash: rep?.tx_hash ?? null, reported_at: rep?.at ?? null, last_error: rep?.last_error ?? null,
        days: Math.floor((Date.now() - s.body.created_at) / 86_400_000),
      };
    });
    const sum = (xs: typeof royalties) => String(Math.round(xs.reduce((n, r) => n + Number(r.amount || 0), 0) * 1e6) / 1e6);
    const summary = market.payouts.summary();
    return { ...(await market.chainStatus()), sales, royalties, purchases: market.store.listPurchases().length,
      royalty_totals: {
        owed: sum(royalties),
        credited: sum(royalties.filter((r) => r.state === 'credited')),
        paid: sum(royalties.filter((r) => r.state === 'paid')),
        unconfirmed: sum(royalties.filter((r) => r.state === 'unconfirmed' || r.state === 'pending' || r.state === 'failed')),
      },
      verification: royalties.filter((r) => r.kind === 'verification'),
      verification_total: sum(royalties.filter((r) => r.kind === 'verification')),
      verifier_share: effectiveVerifierShare(undefined, market.cfg.market.verifierShare),
      payouts: { ...summary, items: market.store.listPayouts({ status: ['pending', 'failed'], limit: 50 }) } };
  }));
  // Royalty payouts (spec §6.4 / §9.3): every AIN transfer attempt owed to a creator or data provider, newest first.
  router.get('/api/me/payouts', requireOperator, wrap(async (req) => {
    const q = z.object({ status: z.enum(['pending', 'paying', 'paid', 'failed']).optional(), address: z.string().optional(), limit: z.coerce.number().int().min(1).max(1000).optional() }).parse(req.query);
    return { items: market.store.listPayouts({ status: q.status, address: q.address, limit: q.limit ?? 200 }), summary: market.payouts.summary(), max_attempts: market.payouts.maxAttempts, retry_ms: market.payouts.retryMs, wallet: !!market.payouts.wallet };
  }));
  router.post('/api/me/payouts/:id/retry', requireOperator, wrap(async (req) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw bad('payout id must be a positive integer');
    return { payout: await market.payouts.retry(id) };
  }));

  router.post('/api/patches', requireOperator, upload.single('file'), wrap(async (req) => {
    // item 129: multer has already written the whole body into <dataDir>/uploads. `createDraft` copies it into the
    // blob store, so the temp copy is dead the moment this handler returns — and on every rejection below it is dead
    // immediately. Nothing used to unlink it, on either path.
    try {
      const body = z.object({
        id: z.string().optional(), name: z.string().min(2), description: z.string().optional(), model_id: z.string().min(1),
        benchmark: z.string().transform((s) => JSON.parse(s)).or(z.object({}).passthrough()), price: z.string().regex(PRICE_RE, 'price must be a non-negative number').optional(),
        billing: z.enum(['per_download', 'per_apply_hour', 'per_hit']).optional(), license: z.string().optional(),
        parents: z.string().optional().transform((s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : [])),
        branch: z.string().optional(), topic_path: z.string().optional(), path: z.string().optional(),
        visibility: z.enum(['public', 'test']).optional(),
        contributors: z.string().transform((s) => JSON.parse(s)).or(z.array(z.object({}).passthrough())).optional(),
        // lineage (design §12.4): an operator may publish the training set beside the body — a local jsonl/csv path,
        // pinned under its canonical sha with the chosen access and licence
        dataset_file: z.string().optional(), dataset_access: z.enum(DATASET_ACCESS_LEVELS).optional(), dataset_license: z.string().optional(),
        // §12.4: an operator may register a knowledge that was trained ON TOP of others — the ordered stack that has to
        // be loaded underneath it. `pre_state_sha256` is never taken on trust: it is recomputed from the file here.
        base_stack: z.string().optional().transform((s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : [])),
        export: z.enum(['delta', 'squash']).optional(),
        derivation: z.string().transform((s) => JSON.parse(s)).or(z.object({}).passthrough()).optional(),
        // publish past `duplicate_body` (bytes this node already published on this subject) and `model_mismatch`
        // (a model this node cannot test) — never past another author's body (items 154, 240, 363)
        force: z.coerce.boolean().optional(),
      }).parse(req.body);
      const file = req.file?.path ?? body.path;
      if (!file) throw bad('upload a .npz file or give a local `path`');
      if (!req.file && !existsSync(file)) throw bad(`path not found on node: ${file}`);
      let dataset: PatchAnchor['dataset'] | undefined;
      if (body.dataset_file) {
        if (!existsSync(body.dataset_file)) throw bad(`dataset_file not found on node: ${body.dataset_file}`);
        const license = body.dataset_license ?? body.license ?? 'CC-BY-4.0';
        if (!isDatasetLicense(license)) throw bad(`bad_license: "${license}" is not one of CC0-1.0, CC-BY-4.0, CC-BY-SA-4.0, ODC-By-1.0, Proprietary`);
        const parsed = parseDataset(readFileSync(body.dataset_file), { filename: body.dataset_file, maxRows: 100_000, maxSourceLines: 500_000 });
        if (!parsed.rows.length) throw bad('dataset_empty: that file has no usable questions');
        const access = body.dataset_access ?? 'private';
        const samples = ((body.benchmark as { samples?: { prompt: string; expect: string }[] }).samples ?? []);
        const pinned = market.datasets.pin(canonicalBytes(parsed.rows), { source: 'upload', license, access, parents: [], row_origin: [], changed: [], removed: [], contrast_used: [], pii_scan: { ok: parsed.summary.pii === 0, rows: parsed.report.filter((r) => r.status === 'pii' && r.index !== null).map((r) => r.index!) }, declaration: { source: 'own', license, no_pii: parsed.summary.pii === 0 }, include_notes: false, model_id: body.model_id }, samples);
        dataset = { sha256: pinned.sha256, rows: pinned.rows, source: 'upload', access, license };
      }
      let base: PatchAnchor['base'] | undefined;
      if (body.base_stack.length) {
        const stack: { patch_id: string; patch_sha256: string }[] = [];
        for (const id of body.base_stack) {
          const e = await market.entry(id);
          if (!e) throw bad(`base_unknown: ${id} is not a knowledge on this node`);
          stack.push({ patch_id: id, patch_sha256: e.anchor.patch_sha256 });
        }
        const a = readNpzMember(file, 'addrs'), b = readNpzMember(file, 'before');
        const dim = b.header.shape[1] ?? 1;
        base = {
          stack, export: body.export ?? 'delta',
          pre_state_sha256: preStateSha256(new BigInt64Array(a.body.buffer, a.body.byteOffset, a.body.length / 8), new Float32Array(b.body.buffer, b.body.byteOffset, b.body.length / 4), dim),
        };
      }
      const anchor = await market.createDraft({
        id: body.id, name: body.name, description: body.description, model: { id_M: body.model_id }, benchmark: body.benchmark as never,
        price: body.price, billing: body.billing, license: body.license, parents: body.parents, branch: body.branch, topic_path: body.topic_path,
        file, keepInPlace: !req.file, visibility: body.visibility, contributors: body.contributors as never, force: body.force, ...(dataset ? { dataset } : {}),
        ...(base ? { base } : {}), ...(body.derivation ? { derivation: body.derivation as never } : {}),
      });
      return { anchor };
    } finally { dropTemp(req); }
  }));
  router.patch('/api/patches/:id', requireOperator, wrap(async (req) => {
    const patch = z.object({
      name: z.string().min(2).optional(), description: z.string().optional(), price: z.string().regex(PRICE_RE, 'price must be a non-negative number').optional(), branch: z.string().optional(),
      benchmark: z.object({}).passthrough().optional(), license: z.string().optional(), billing: z.enum(['per_download', 'per_apply_hour', 'per_hit']).optional(),
      topic_path: z.string().optional(), visibility: z.enum(['public', 'test']).optional(), origin: z.enum(['operator', 'teach']).optional(),
      contributors: z.array(z.object({}).passthrough()).nullable().optional(),
    }).parse(req.body ?? {});
    // only the keys the caller sent reach updateDraft: `'contributors' in patch` with an undefined value would wipe the list on
    // every unrelated PATCH (e.g. `{origin:'teach'}` from `ainize patch import`); `contributors: null` clears it explicitly.
    const update = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined).map(([k, v]) => [k, k === 'contributors' && v === null ? [] : v]));
    return { anchor: market.updateDraft(req.params.id as string, update as never) };
  }));
  router.delete('/api/patches/:id', requireOperator, wrap(async (req) => { market.deleteDraft(req.params.id as string); return { ok: true }; }));
  /**
   * DRAFT → ANNOUNCED. The response carries what the publisher has to know the moment the record is written
   * (item 147): how many reachable peers on this network actually verify, against the quorum this node needs. With
   * fewer verifiers than the quorum nothing announced here can ever be LISTED, and the CLI says so instead of
   * promising that "verifiers will now attest".
   */
  router.post('/api/patches/:id/announce', requireOperator, wrap(async (req) => {
    const record = await market.announce(req.params.id as string);
    return { record, verifiers: await market.verifierReach(), visibility: record.body.visibility ?? 'public' };
  }));
  /**
   * The exit (item 148): an author-signed `retire` record takes their own knowledge off sale for good. The anchor
   * stays on the permanent record, the catalogue drops it, /x402/patch/:id answers 410, and everyone who already
   * bought it keeps their copy and their download rights.
   */
  router.post('/api/patches/:id/retire', requireOperator, wrap(async (req) => {
    const { reason } = z.object({ reason: z.string().max(500).optional() }).parse(req.body ?? {});
    return market.retire(req.params.id as string, reason ?? '');
  }));
  router.post('/api/patches/:id/verify', requireOperator, wrap(async (req) => {
    if (!deps.verifier) throw bad('this node is not a verifier');
    const e = await market.entry(req.params.id as string);
    if (!e) throw notFound();
    return { attestation: await deps.verifier.verifyOne(e.anchor) };
  }));
  // A challenge stops every sale of a knowledge and spends another operator's GPU minutes on the re-run, so the API
  // no longer invents a reason for a caller that did not give one (item 328): `market.challenge` refuses a body
  // without one, an address may hold only one open challenge per anchor, and a dismissed one has a cool-down.
  router.post('/api/patches/:id/challenge', requireOperator, wrap(async (req) => {
    const challenge = await market.challenge(req.params.id as string, String(req.body?.reason ?? ''));
    return { ok: true, challenge, record: await market.challengeRecord(market.address) };
  }));
  router.post('/api/patches/:id/buy', requireOperator, wrap(async (req) => {
    const b = z.object({ apply: z.boolean().optional(), bundle: z.boolean().optional(), with_required: z.boolean().optional(), max_total: z.number().optional(), again: z.boolean().optional() }).parse(req.body ?? {});
    // The bases underneath are bought first, deepest first, one settlement each (design §12.4, item 270). The design
    // spells this `?bundle=1` and this node has always taken it as `with_required` in the body; both are accepted,
    // because a buyer's agent reading §12.4 and an older client reading this node's own OpenAPI must both work.
    // `max_total` refuses the whole family before any money moves, so a budget is a budget for the purchase and not
    // for one item of it. Without `again`, a knowledge this node has already paid for is collected on that receipt
    // rather than bought a second time (item 271).
    const bundle = b.bundle ?? b.with_required ?? ['1', 'true', 'yes'].includes(String(req.query.bundle ?? '').toLowerCase());
    return market.buy(req.params.id as string, { apply: !!b.apply, withRequired: bundle, maxTotal: b.max_total, again: !!b.again });
  }));
  /**
   * What a purchase would cost from here: the price, the bases that have to come with it, and the family total
   * (item 270). Public, because the numbers are the ones already on the catalogue and a buyer has to see them
   * BEFORE paying, not after.
   */
  router.get('/api/patches/:id/quote', wrap(async (req) => {
    const e = await market.entry(req.params.id as string);
    if (!e || (e.status === 'DRAFT' && !isOperator(req))) throw notFound('patch not found');
    return market.quoteFor(e);
  }));
  /**
   * Collect a knowledge this node has already paid for, without paying again (item 273): a re-issued manifest
   * against the recorded payment, or the body itself over the signed peer path the settlement already unlocks.
   */
  router.post('/api/patches/:id/collect', requireOperator, wrap(async (req) => market.collect(req.params.id as string)));
  /**
   * Payments that left this node and were never answered with a manifest (item 274). Money on the chain and no
   * body: this is where an operator sees it, and `POST /api/patches/:id/collect` is how it is finished.
   */
  router.get('/api/me/pending-payments', requireOperator, wrap(async () => ({
    // Only rows that COST something: a 'quoted' row is a 402 this node answered and never paid, which owes nobody
    // anything. `paid` means the money left and no manifest came back.
    items: market.store.listPending({ status: ['paid'], limit: 200 }).map((r) => ({ ...r, payload: undefined })),
  })));
  /**
   * Where an address's local credit came from (item 364). Local credit is ISSUED by this node — one recorded,
   * capped grant per address — so a balance is a sum of records, not a number every keypair is born with. Public:
   * every settlement it is derived from is already on the public ledger.
   */
  const creditOf = async (address: string) => {
    const grant = market.store.getGrant(address);
    const issuance = market.creditIssuance();
    return {
      address, currency: market.cfg.market.currency, balance: await market.creditBalance(address),
      grant: grant ? { amount: grant.amount, reason: grant.reason, granted_at: grant.granted_at } : null,
      would_grant: !grant && issuance.issues && issuance.addresses < issuance.cap ? issuance.per_address : null,
      issued_by: { address: market.address, name: market.cfg.name ?? null, url: market.publicUrl },
      issuance,
      // Said once, here, so no surface has to invent it: this is not money.
      note: issuance.issues
        ? `CREDIT is issued by this node (${issuance.addresses}/${issuance.cap} addresses funded with ${issuance.per_address} each) for trying the market out — it is not money and it is worthless anywhere else`
        : 'this node sells for AIN and issues no local credit',
    };
  };
  router.get('/api/credit/:address', wrap(async (req) => creditOf(req.params.address as string)));
  router.get('/api/me/credit', requireOperator, wrap(async () => creditOf(market.address)));
  // §12.4 — `with_base` loads everything the knowledge was trained on top of, in order, under one runtime lock;
  // without it an add-on whose base is not loaded is refused (409 needs_base) instead of writing rows over the wrong table.
  // Item 212 — with `async: true` the POST answers 202 with a job and the caller polls GET /api/runtime/jobs/:id.
  // The shared model lock has no upper bound on how long it is held (another node's live test, a verification), and
  // a synchronous POST that outlived the HTTP client's header timeout was reported as "cannot reach node", exit 2,
  // minutes before the node ran it anyway.
  router.post('/api/patches/:id/apply', requireOperator, wrap(async (req, res) => {
    const { with_base, async: wantJob } = z.object({ with_base: z.boolean().optional(), async: z.boolean().optional() }).parse(req.body ?? {});
    const id = req.params.id as string;
    if (!(await market.entry(id))) throw notFound('patch not found');
    if (wantJob) {
      const job = market.startRuntimeJob('apply', id, async (onEnter) => (await market.applyPatch(id, 'manual', { withBase: with_base, onEnter })).text);
      res.status(202);
      return { job: market.runtimeJob(job.id) };
    }
    // `order` is the chain this knowledge sits on, ancestors first (SC-15 `apply.order`): the screen that asked for
    // the load can name what went under it without re-deriving a stack the node has already resolved.
    const out = await market.applyPatch(id, 'manual', { withBase: with_base });
    return { result: out.text, order: out.order, loaded: out.loaded, stack: await market.stack() };
  }));
  const unload = async (req: { params: Record<string, unknown>; body?: Record<string, unknown> }, res: { status: (n: number) => unknown }) => {
    const { cascade, async: wantJob } = z.object({ cascade: z.boolean().optional(), async: z.boolean().optional() }).parse(req.body ?? {});
    const id = req.params.id as string;
    if (!(await market.entry(id))) throw notFound('patch not found');
    if (wantJob) {
      const job = market.startRuntimeJob('remove', id, (onEnter) => market.removePatch(id, { cascade, onEnter }));
      res.status(202);
      return { job: market.runtimeJob(job.id) };
    }
    return { result: await market.removePatch(id, { cascade }), stack: await market.stack() };
  };
  router.post('/api/patches/:id/remove', requireOperator, wrap(unload as never));
  router.delete('/api/patches/:id/apply', requireOperator, wrap(unload as never));
  router.post('/api/patches/:id/forget', requireOperator, wrap(async (req) => {
    const { all_sharing } = z.object({ all_sharing: z.boolean().optional() }).parse(req.body ?? {});
    return market.forgetBody(req.params.id as string, { allSharing: all_sharing });
  }));
  router.get('/api/patches/:id/conflicts', wrap(async (req) => {
    const e = await market.entry(req.params.id as string);
    if (!e || (e.status === 'DRAFT' && !isOperator(req))) throw notFound('patch not found');
    // Overlap partners that are private drafts are only shown to the operator; hidden test anchors stay hidden (see relativeVisible).
    const map = await market.entryMap();
    const conflicts = (await market.conflicts(e.anchor.id)).filter((c) => relativeVisible(req, e)(map.get(c.patch_id)));
    return { conflicts };
  }));

  router.post('/api/branches', requireOperator, wrap(async (req) => {
    const b = z.object({ name: z.string(), description: z.string().default(''), context: z.record(z.string(), z.string()).default({}), patch_ids: z.array(z.string()).default([]) }).parse(req.body);
    return { branch: await market.createBranch(b.name, b.description, b.context, b.patch_ids) };
  }));
  router.post('/api/branches/:name/patches', requireOperator, wrap(async (req) => {
    const { patch_id, force } = z.object({ patch_id: z.string().min(1), force: z.boolean().optional() }).parse(req.body ?? {});
    return { branch: await market.addToBranch(decodeURIComponent(req.params.name as string), patch_id, { force }) };
  }));
  /** Item 357 — what subscribing would spend, item by item, before anything is spent. */
  const quoteBranch = async (req: { params: Record<string, unknown> }) => ({ quote: await market.quoteBranch(decodeURIComponent(req.params.name as string)) });
  router.post('/api/branches/:name/quote', requireOperator, wrap(quoteBranch as never));
  router.get('/api/branches/:name/quote', requireOperator, wrap(quoteBranch as never));
  // The answer says what was bought, loaded and skipped; a partial acquisition is a 409 and nothing is broadcast.
  router.post('/api/branches/:name/subscribe', requireOperator, wrap(async (req) => market.subscribe(decodeURIComponent(req.params.name as string), 'subscribe')));
  router.post('/api/branches/:name/unsubscribe', requireOperator, wrap(async (req) => market.subscribe(decodeURIComponent(req.params.name as string), 'unsubscribe')));
  /** Item 255 — bring a subscribed track up to date now (the 20-second tick does the same thing). */
  router.post('/api/branches/:name/sync', requireOperator, wrap(async (req) => market.syncSubscription(decodeURIComponent(req.params.name as string), { retryNow: true })));

  router.post('/api/runtime/complete', requireOperator, wrap(async (req) => {
    const { prompt, max_tokens, raw } = z.object({
      prompt: z.string().min(1).max(2000), max_tokens: z.coerce.number().min(1).max(256).default(16),
      /** `raw: true` = no stop sequences and no degeneracy guard — exactly what this endpoint sent before D1. */
      raw: z.boolean().default(false),
    }).parse(req.body);
    const out = await market.runtime.completeDetailed(prompt, { maxTokens: max_tokens, ...(raw ? { sampling: null } : {}) });
    // `text` stays the shown (guarded) answer for existing callers; raw_text is only present when it was cut.
    return {
      text: out.content, finish_reason: out.finish_reason ?? null,
      truncated: out.truncated ?? null, shown_chars: out.shown_chars ?? out.content.length, raw_chars: out.raw_chars ?? out.content.length,
      ...(out.raw_content !== undefined ? { raw_text: out.raw_content } : {}),
    };
  }));
  // `applied` is an ORDERED stack now (bottom first), and `stack` says what each layer sits on and whether the
  // journal that would undo it is still there (design §5.4, §8).
  router.get('/api/runtime', wrap(async () => {
    const stack = await market.stack();
    return { ...(await market.runtime.status(true)), applied: stack.map((l) => l.patch_id), stack, journal_dir: market.runtime.journalDir() };
  }));
  router.get('/api/runtime/stack', wrap(async () => ({ stack: await market.stack(), journal_dir: market.runtime.journalDir() })));
  /** Item 212 — where a queued apply/remove is, and what the shared model is doing while it waits. */
  router.get('/api/runtime/jobs', requireOperator, wrap(async () => ({ jobs: market.listRuntimeJobs().slice(0, 50) })));
  router.get('/api/runtime/jobs/:id', requireOperator, wrap(async (req) => {
    const job = market.runtimeJob(req.params.id as string);
    if (!job) throw notFound('no such runtime job (a node restart forgets queued jobs — check `ainize patch stack`)');
    return { job };
  }));
  /** What `patch.py check` measures against the live table for one knowledge: is its base underneath, row for row? */
  router.get('/api/patches/:id/check', requireOperator, wrap(async (req) => {
    const e = await market.entry(req.params.id as string);
    if (!e) throw new HttpError(404, 'patch not found');
    const blob = market.blobs.get(e.anchor.patch_sha256);
    if (!blob) throw new HttpError(409, 'patch body not present on this node');
    const check = await market.runtime.exclusive(`check:${e.anchor.id}`, () => market.runtime.check(blob.path));
    if (!check) throw new HttpError(503, 'the patch hook could not be reached (ENGRAM_HOOK=1?)');
    return { patch_id: e.anchor.id, export: e.anchor.base?.export ?? null, base_stack: (e.anchor.base?.stack ?? []).map((b) => b.patch_id), ...check };
  }));

  router.post('/api/peers', requireOperator, wrap(async (req) => { market.p2p.addPeer(String(req.body.endpoint)); market.cfg.peers = [...new Set([...market.cfg.peers, String(req.body.endpoint)])]; deps.saveConfig(); return { ok: true }; }));
  router.delete('/api/peers', requireOperator, wrap(async (req) => { market.p2p.removePeer(String(req.body.endpoint)); market.cfg.peers = market.cfg.peers.filter((p) => p !== req.body.endpoint); deps.saveConfig(); return { ok: true }; }));
  router.post('/api/chain/setup', requireOperator, wrap(async () => {
    if (!(market.ledger instanceof AinLedger)) throw bad('node is not on the AIN ledger');
    return market.ledger.setupApp();
  }));

  // ------------------------------------------------------------ ChatMode (live test)
  router.get('/api/chat/patches', wrap(async (req) => {
    // hidden contributor names are redacted here too (public response), like /api/catalog and /api/patches/:id
    const rows = await market.chatCatalog();
    const items = rows.filter((r) => r.testable).map((r) => redactContributors(r.entry));
    // Item 297 — knowledge this node's model could run but cannot load: it used to be absent from the picker
    // entirely (no row, no price, no seller), so the chained purchase the product is built on had no first step.
    const elsewhere = rows.filter((r) => !r.testable).map((r) => {
      const a = redactContributors(r.entry).anchor;
      return {
        patch_id: a.id, name: a.name, author: a.author, author_name: a.author_name ?? null,
        price: a.price, currency: a.currency, status: r.entry.status, rows: a.rows, queries: a.benchmark.queries,
        reason: r.reason, buyable: r.buyable, requests: r.requests,
        // Where the seller answers TODAY, not the address frozen into the anchor (item 275): this row is what a
        // visitor is pointed at, and a seller that changed its port would be a dead link here.
        gateway_url: market.gatewaysFor(a)[0]?.url ?? (a as PatchAnchor & { gateway_url?: string }).gateway_url ?? null,
      };
    });
    // `lessons`: the caller's private drafts (teach mode), only with a verified teaching-key signature
    const teacher = teachAuth.verify(req);
    const q = market.runtime.queueState();
    return {
      items, elsewhere, runtime: await market.runtime.status(), lock: q.lock,
      // D3: `now` is the node's clock — the client measures "held for 40s" against it instead of the browser's,
      // and `queue` says how many live tests of this node are waiting behind the shared model.
      now: Date.now(), queue: { running: q.running, waiting: market.chatQueue.waiting() },
      // `applied` is what this node keeps loaded; `dirty` is what a live test found on the shared model that this
      // node never loaded — a leftover from another process, which the next test unloads and does not put back.
      applied: market.pinnedPatchIds(), dirty: market.recentDirty(), overlaps: market.chatOverlaps(items),
      operator: isOperator(req),
      ...(teacher ? { lessons: deps.teach ? await deps.teach.lessonsFor(teacher) : ([] as CatalogEntry[]), teacher } : {}),
    };
  }));
  /**
   * Item 297 — "I want to test or build on this and it is not on this node". Buying is operator-only, so this is the
   * only first step a visitor has: it writes one `demand` event the operator sees in the log, with the price and the
   * command that would satisfy it.
   */
  router.post('/api/chat/patches/:id/request', wrap(async (req) => {
    const operator = isOperator(req);
    const visitor = market.visitorId(operator ? `operator:${market.address}` : `ip:${req.ip}`);
    return market.requestPatch(req.params.id as string, visitor);
  }));
  router.post('/api/chat', wrap(async (req) => {
    const history = z.array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string().min(1).max(4000) })).min(1).max(24);
    /** The question both columns must answer: the last message of the array (compared verbatim across the three). */
    const tail = (m?: { role: string; content: string }[]) => (m ? JSON.stringify(m[m.length - 1]) : null);
    const body = z.object({
      // `patch_ids: []` means "just the model this node serves" — teach mode's conversational door before any
      // knowledge exists, and the only thing a visitor can ask on a node with an empty catalog.
      patch_id: z.string().min(1).optional(), patch_ids: z.array(z.string().min(1)).max(MAX_CHAT_PATCHES).optional(),
      mode: z.enum(['base', 'patched', 'compare']).default('compare'),
      messages: history,
      /**
       * Compare mode with a history: the per-column conversations. `messages_base` replays what the BASE model
       * answered, `messages_patched` what the patched model answered; a column without its own array falls back to
       * `messages`. Replaying the patched answer to the un-patched model would teach it the knowledge mid-test.
       */
      messages_base: history.optional(), messages_patched: history.optional(),
      max_tokens: z.coerce.number().min(1).max(1024).default(200), thinking: z.boolean().default(false),
      /** D3: the client's own id for this live test — lets it ask GET /api/chat/status and cancel while queued. */
      request_id: z.string().min(1).max(64).optional(),
    }).refine((b) => (b.patch_id ? 1 : 0) + (b.patch_ids ? 1 : 0) === 1, { message: 'exactly one of patch_id / patch_ids is required', path: ['patch_ids'] })
      // A comparison is only a comparison if both columns are asked the same thing.
      .refine((b) => !b.messages_base || tail(b.messages_base) === tail(b.messages), { message: 'messages_base must end with the same message as messages — both columns answer one question', path: ['messages_base'] })
      .refine((b) => !b.messages_patched || tail(b.messages_patched) === tail(b.messages), { message: 'messages_patched must end with the same message as messages — both columns answer one question', path: ['messages_patched'] })
      .parse(req.body);
    const operator = isOperator(req);
    const visitor = market.visitorId(operator ? `operator:${market.address}` : `ip:${req.ip}`);
    // check (without consuming) first; a failed/hung request must not burn a free try
    // the machine-readable code matters: without it the browser cannot tell this HOURLY budget from the DAILY lesson
    // limit, and told the visitor to "come back tomorrow" for a quota that refills within the hour. `quota_reset` says
    // WHEN the hour is up, so the page can count down instead of guessing.
    if (!operator && market.chatQuota(visitor, 20, 3600_000, false) < 0) throw new HttpError(429, 'quota_chat: free live-test quota exhausted for this hour — buy the patch or run your own node', { quota_reset: market.chatQuotaResetsAt(visitor) });
    // private drafts (taught lessons) are testable only by their owner (signed x-ngram-auth) or the operator
    const out = await market.chat({ ...body, requestId: body.request_id, messagesBase: body.messages_base, messagesPatched: body.messages_patched, patchIds: body.patch_ids ?? [body.patch_id!], visitor, caller: { operator, address: teachAuth.verify(req) } });
    const remaining = operator ? Infinity : market.chatQuota(visitor);
    return { ...out, remaining_quota: Number.isFinite(remaining) ? remaining : null, quota_limit: operator ? null : 20 };
  }));
  /**
   * D3 — "is my request still queued?". Public, free (no quota), and answers about the caller's own request only:
   * an unknown or foreign request_id is reported as 'gone', never as someone else's state.
   */
  router.get('/api/chat/status', wrap(async (req) => {
    const { request_id } = z.object({ request_id: z.string().min(1).max(64) }).parse(req.query);
    const operator = isOperator(req);
    const visitor = market.visitorId(operator ? `operator:${market.address}` : `ip:${req.ip}`);
    const q = market.runtime.queueState();
    return { ...market.chatQueue.status(request_id, visitor), lock: q.lock, running: q.running, waiting: market.chatQueue.waiting(), now: Date.now() };
  }));
  /**
   * D3 — give up waiting. While the request is still queued nothing has been sent to the model, so the runner
   * returns without touching the shared table and no free try is consumed; once it is running the work (and the
   * charge) stands and the caller is told exactly that instead of being left to guess.
   */
  router.post('/api/chat/cancel', wrap(async (req) => {
    const { request_id } = z.object({ request_id: z.string().min(1).max(64) }).parse(req.body);
    const operator = isOperator(req);
    const visitor = market.visitorId(operator ? `operator:${market.address}` : `ip:${req.ip}`);
    return market.chatQueue.cancel(request_id, visitor);
  }));
  /**
   * SC-13 — "this answer is wrong". `share: false` (the default) counts the question and keeps nothing: the node
   * stores a keyed cluster id, so *asked {c} times* is true without the text ever being written. `share: true` is the
   * visitor's own decision to send the text to the creator, taken per turn, and only then is it stored (§10).
   * The turn must be one this visitor actually asked — the prompt comes from the node's own record of it, never from
   * the request body, so nobody can attribute a question to a knowledge they never tested.
   */
  router.post('/api/chat/feedback', wrap(async (req) => {
    const body = z.object({
      turn_id: z.string().min(1).max(64),
      patch_ids: z.array(z.string().min(1)).max(MAX_CHAT_PATCHES).optional(),
      verdict: z.literal('wrong').default('wrong'),
      share: z.boolean().default(false),
    }).parse(req.body ?? {});
    const operator = isOperator(req);
    const visitor = market.visitorId(operator ? `operator:${market.address}` : `ip:${req.ip}`);
    const turn = market.turn(body.turn_id, visitor);
    if (!turn) throw new HttpError(404, 'turn_unknown: that live test is not one this node remembers for you (it may have been restarted)');
    const ids = (body.patch_ids?.length ? body.patch_ids.filter((x) => turn.patch_ids.includes(x)) : turn.patch_ids);
    if (!ids.length) throw bad('no_patch: a wrong answer is reported against a knowledge that was loaded for that turn');
    const cluster = market.questionCluster(turn.prompt);
    const out: { patch_id: string; issue_id: string; count: number; people: number; shared: boolean }[] = [];
    for (const id of ids) {
      const e = await market.entry(id);
      if (!e || (e.status === 'DRAFT' && !operator)) continue;
      market.store.bumpSignals(id, { marked_wrong: 1 }, { visitor });
      // a question the knowledge PUBLISHES is its own miss (the prompt is already on the record); anything else is a
      // free question, whose text exists here only with consent
      const sample = (e.anchor.benchmark.samples ?? []).findIndex((sm) => questionKey(sm.prompt) === questionKey(turn.prompt));
      const issue = sample >= 0
        ? market.store.bumpIssue(id, 'own_miss', cluster, { sample_index: sample, visitor })
        : market.store.bumpIssue(id, 'free_wrong', cluster, { text: body.share ? turn.prompt : null, visitor });
      out.push({ patch_id: id, issue_id: issue.id, count: issue.count, people: issue.people, shared: !!issue.text });
    }
    if (!out.length) throw notFound('patch not found');
    return { turn_id: body.turn_id, shared: body.share, items: out };
  }));

  router.get('/api/me/settings', requireOperator, wrap(async () => ({ settings: market.settings() })));
  router.patch('/api/me/settings', requireOperator, wrap(async (req) => {
    const patch = z.object({ notifications: z.enum(['all', 'sales', 'none']).optional(), display_name: z.string().min(1).max(64).optional(), payout_address: z.string().optional() }).parse(req.body);
    const settings = market.updateSettings(patch);
    deps.saveConfig();
    return { settings };
  }));

  // ------------------------------------------------------------ teach mode — visitors (spec §6.2; signed x-ngram-auth, see teach-auth.ts)
  const needTeach = (): TeachWorker => { if (!deps.teach) throw new HttpError(503, 'teaching_disabled: the teach worker is not running on this node'); return deps.teach; };
  // verified once per request (the replay cache makes a second verification of the same header fail by design)
  const teacherOf = (req: Request): string | null => {
    const r = req as Request & { _teacher?: string | null };
    if (r._teacher === undefined) r._teacher = teachAuth.verify(req);
    return r._teacher;
  };
  const requireTeacher = (req: Request): string => {
    const a = teacherOf(req);
    if (!a) throw new HttpError(401, 'invalid_signature: x-ngram-auth header missing, expired, replayed or invalid (`<address>:<ts>:<sig>:v2` over "teach:<node>:<METHOD>:<path>:<ts>[:<sha256 body>]", or the legacy `teach:<ts>` form)');
    return a;
  };
  /** Every visitor teach route: worker present, policy enabled, key/IP not banned. */
  const visitorGate = (req: Request, address: string | null): TeachWorker => { const t = needTeach(); t.assertEnabled(); t.assertNotBanned(address, req.ip); return t; };
  const jobOr404 = (t: TeachWorker, id: string): TeachJobRow => { const j = t.get(id); if (!j) throw notFound('lesson not found'); return j; };
  /** Owner (signed) or operator. */
  const ownerJob = (req: Request, id: string, opts: { operator?: boolean } = {}): { t: TeachWorker; j: TeachJobRow; address: string | null; operator: boolean } => {
    const t = needTeach(); const j = jobOr404(t, id); const address = teacherOf(req); const operator = isOperator(req);
    if (t.isOwner(j, address)) { t.assertEnabled(); t.assertNotBanned(address, req.ip); return { t, j, address, operator: false }; }
    if (opts.operator !== false && operator) return { t, j, address, operator: true };
    if (!address) throw new HttpError(401, 'invalid_signature: x-ngram-auth header missing, expired or invalid');
    throw new HttpError(403, 'not_owner: this lesson belongs to a different teaching key');
  };
  const factSchema = z.object({ prompt: z.string().min(1).max(PROMPT_MAX), answer: z.string().min(1).max(ANSWER_MAX), alt_prompt: z.string().max(PROMPT_MAX).optional(), base_answer: z.string().max(4000).optional() });
  const addressParam = (v: string): string => { if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw bad('address must be an AIN address (0x + 40 hex)'); return v; };

  // ------------------------------------------------------------ teach mode — datasets (design §7.1–§7.2)
  /**
   * The upload multer is its OWN instance: `dest` under the teach directory, exactly one file, and a hard byte ceiling.
   * The operator instance (4 GB) must never be reachable from a visitor route.
   */
  const datasetUpload = multer({ dest: join(market.cfg.dataDir, 'teach', 'incoming'), limits: { fileSize: DATASET_MAX_BYTES_CEILING, files: 1, fields: 12 } });
  mkdirSync(join(market.cfg.dataDir, 'teach', 'incoming'), { recursive: true });
  const isMultipart = (req: Request) => (req.header('content-type') ?? '').toLowerCase().startsWith('multipart/');

  /**
   * The teach gate for uploads, registered BEFORE multer on the same chain (design §7.1 ordering rule): worker present →
   * enabled → key/IP not banned → content-length → per-IP-per-minute limiter → byte quota. Registering the upload
   * middleware first (the pattern `/api/patches` uses) would let a banned key write megabytes on every request.
   */
  const datasetGate = (req: Request, _res: Response, next: NextFunction) => {
    try {
      const t = needTeach();
      // a multipart body cannot be covered by the v2 body hash, so the client signs the sha256 header instead (§D14)
      const r = req as Request & { _teacher?: string | null };
      if (r._teacher === undefined) r._teacher = isMultipart(req) ? teachAuth.verify(req, 'teach', req.header('x-ngram-dataset-sha256') ?? null) : teachAuth.verify(req);
      const address = requireTeacher(req);
      t.assertEnabled();
      t.assertNotBanned(address, req.ip);
      const bytes = isMultipart(req) ? Number(req.header('content-length') ?? 0) : Buffer.byteLength(JSON.stringify(req.body ?? {}));
      t.datasets.gate(address, req.ip, bytes);
      next();
    } catch (e) { next(e); }
  };

  const rowSchema = z.object({ prompt: z.string().min(1).max(PROMPT_MAX), answer: z.string().min(1).max(ANSWER_MAX), alt_prompt: z.string().max(PROMPT_MAX).optional(), note: z.string().max(500).optional() });
  const rowsOpSchema = z.union([
    z.object({ op: z.literal('remove'), indexes: z.array(z.number().int().min(0)).min(1).max(2000) }),
    z.object({ op: z.literal('append'), rows: z.array(rowSchema).min(1).max(2000) }),
    z.object({ op: z.literal('replace'), index: z.number().int().min(0), row: rowSchema }),
  ]);
  const parseOptSchema = z.object({
    format: z.enum(['jsonl', 'json', 'csv', 'tsv', 'txt']).optional(), delimiter: z.string().min(1).max(4).optional(),
    has_header: z.union([z.boolean(), z.enum(['true', 'false'])]).optional(), encoding: z.string().max(32).optional(),
    layout: z.enum(['tsv', 'qa', 'blocks', 'prompts']).optional(),
    columns: z.union([z.string(), z.record(z.string(), z.union([z.string(), z.number()]))]).optional(),
  });
  const toParse = (b: z.infer<typeof parseOptSchema>) => ({
    ...(b.format ? { format: b.format } : {}), ...(b.delimiter ? { delimiter: b.delimiter === '\\t' ? '\t' : b.delimiter } : {}),
    ...(b.has_header !== undefined ? { hasHeader: b.has_header === true || b.has_header === 'true' } : {}),
    ...(b.encoding ? { encoding: b.encoding } : {}), ...(b.layout ? { layout: b.layout } : {}),
    ...(b.columns ? { columns: (typeof b.columns === 'string' ? JSON.parse(b.columns) : b.columns) as Record<string, string | number> } : {}),
  });

  // Registered BEFORE `/api/teach/datasets/:id` so the literal `samples` segment can never be read as a dataset id.
  router.get('/api/teach/samples', wrap(async (_req, res) => { res.set('cache-control', 'public, max-age=3600'); return { samples: needTeach().datasets.samples() }; }));
  router.get('/api/teach/samples/:kind', wrap(async (req, res) => {
    const body = needTeach().datasets.sampleBytes(req.params.kind as string);
    res.set('cache-control', 'public, max-age=3600').type('application/x-ndjson; charset=utf-8').set('content-disposition', `attachment; filename="sample-${req.params.kind}.jsonl"`).send(body);
  }));

  router.post('/api/teach/datasets', datasetGate, datasetUpload.single('file'), wrap(async (req, res) => {
    const t = needTeach(); const address = requireTeacher(req);
    try {
      if (req.file) {
        const meta = parseOptSchema.extend({ name: z.string().max(80).optional(), retention: z.enum(['keep', 'delete_after_training']).optional() }).parse(req.body ?? {});
        const declared = req.header('x-ngram-dataset-sha256');
        const bytes = readFileSync(req.file.path);
        const out = t.datasets.create({
          owner: address, ip: req.ip, source: 'upload', bytes, filename: req.file.originalname,
          name: meta.name, retention: meta.retention, parse: toParse(meta), declaredSha256: declared,
        });
        res.status(out.created ? 201 : 200);
        return out;
      }
      const body = z.object({
        source: z.enum(['chat', 'inline', 'sample']).default('chat'), rows: z.array(rowSchema).max(2000).optional(),
        sample: z.string().max(40).optional(), name: z.string().max(80).optional(), retention: z.enum(['keep', 'delete_after_training']).optional(),
      }).parse(req.body ?? {});
      const out = body.source === 'sample'
        ? t.datasets.createFromSample(body.sample ?? 'ko-facts', { owner: address, ip: req.ip, name: body.name, retention: body.retention })
        : t.datasets.create({ owner: address, ip: req.ip, source: body.source, rows: body.rows ?? [], name: body.name, retention: body.retention });
      res.status(out.created ? 201 : 200);
      return out;
    } finally { dropTemp(req); }
  }));

  router.get('/api/teach/datasets', wrap(async (req) => { const address = requireTeacher(req); const t = visitorGate(req, address); return { items: t.datasets.listMine(address) }; }));
  router.get('/api/teach/datasets/:id', wrap(async (req) => {
    const t = needTeach();
    return { dataset: t.datasets.view(t.datasets.owned(req.params.id as string, teacherOf(req), isOperator(req))) };
  }));
  router.get('/api/teach/datasets/:id/rows', wrap(async (req) => {
    const t = needTeach();
    const d = t.datasets.owned(req.params.id as string, teacherOf(req), isOperator(req));
    const q = z.object({
      offset: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(200).default(50), status: z.string().max(20).default('all'),
      // SC-5: which rows are mine, which came from the knowledge this set was copied from, which of its answers I changed
      origin: z.enum(['all', 'mine', 'inherited', 'changed', 'conflicts']).default('all'),
    }).parse(req.query);
    const page = t.datasets.reportPage(d, q);
    return { total: page.total, source_rows: page.source_rows, offset: page.offset, limit: page.limit, summary: page.summary, origins: page.origins, items: page.rows };
  }));
  router.post('/api/teach/datasets/:id/reparse', wrap(async (req) => {
    const address = requireTeacher(req); const t = visitorGate(req, address);
    const body = parseOptSchema.parse(req.body ?? {});
    return t.datasets.reparse(t.datasets.owned(req.params.id as string, address), toParse(body));
  }));
  router.patch('/api/teach/datasets/:id', wrap(async (req) => {
    const address = requireTeacher(req); const t = visitorGate(req, address);
    const body = z.object({ name: z.string().max(80).optional(), retention: z.enum(['keep', 'delete_after_training']).optional(), rows_op: rowsOpSchema.optional() }).parse(req.body ?? {});
    return t.datasets.patch(t.datasets.owned(req.params.id as string, address), body as { name?: string; retention?: 'keep' | 'delete_after_training'; rows_op?: RowsOp });
  }));
  router.post('/api/teach/datasets/:id/fork', wrap(async (req, res) => {
    const address = requireTeacher(req); const t = visitorGate(req, address);
    const body = z.object({ name: z.string().max(80).optional(), rows_op: rowsOpSchema.optional() }).parse(req.body ?? {});
    const out = t.datasets.fork(t.datasets.owned(req.params.id as string, address), { owner: address, ip: req.ip, name: body.name, rows_op: body.rows_op as RowsOp | undefined });
    res.status(out.created ? 201 : 200);
    return out;
  }));
  router.delete('/api/teach/datasets/:id', wrap(async (req) => {
    const t = needTeach();
    const operator = isOperator(req);
    const d = t.datasets.owned(req.params.id as string, teacherOf(req), operator);
    return t.datasets.remove(d, operator && d.owner.toLowerCase() !== (teacherOf(req) ?? '').toLowerCase() ? 'operator' : 'owner');
  }));
  router.get('/api/teach/datasets/:id/download', wrap(async (req, res) => {
    const t = needTeach();
    const d = t.datasets.owned(req.params.id as string, teacherOf(req), isOperator(req));
    const format = req.query.format === 'csv' ? 'csv' : 'jsonl';
    const out = t.datasets.download(d, format);
    res.status(200).type(out.contentType).set({ 'content-disposition': `attachment; filename="${out.filename}"`, 'x-content-sha256': out.sha256 }).send(out.body);
  }));

  router.get('/api/teach/policy', wrap(async (req, res) => { res.set('cache-control', 'public, max-age=10'); return needTeach().policy(req.ip); }));
  /**
   * Item 171 — can this caller teach with this knowledge on this node? The same rules `contextTargets` applies, asked
   * before a dataset is uploaded, so `--patch krx-all-2761` fails in front of the side effect instead of behind it.
   */
  router.get('/api/teach/bases/:id', wrap(async (req) => {
    const address = requireTeacher(req);
    const t = visitorGate(req, address);
    return t.knowledgeFor(req.params.id as string, { address, operator: isOperator(req) });
  }));
  router.post('/api/teach/preflight', wrap(async (req) => {
    const address = requireTeacher(req); const t = visitorGate(req, address);
    const raw = z.object({
      patch_ids: z.array(z.string().min(1)).max(MAX_CHAT_PATCHES).default([]),
      // lineage §12.1: the knowledge these questions would be taught ON TOP OF vs the ones loaded for comparison
      base_ids: z.array(z.string().min(1)).max(2).optional(), context_ids: z.array(z.string().min(1)).max(MAX_CHAT_PATCHES).optional(),
      facts: z.array(factSchema).min(1).max(8).optional(),
      dataset_id: z.string().min(1).optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(8).optional(),
    }).parse(req.body);
    // `{dataset_id, offset?, limit?}` probes at most `preflight.perCall` questions per call and never more than
    // `preflight.sampleRows` of one dataset — the response says what was sampled, so no whole-dataset claim is possible.
    let sampled: { checked: number; of: number } | undefined;
    let facts = raw.facts;
    if (raw.dataset_id) {
      const slice = t.preflightSlice(t.datasets.owned(raw.dataset_id, address), raw.offset ?? 0, raw.limit);
      facts = slice.facts; sampled = slice.sampled;
    }
    if (!facts?.length) throw bad('send either `facts` or a `dataset_id` with questions in it');
    // the base is loaded too, so `patch_ids` here is "everything the probe runs with" for quota purposes
    const baseIds = raw.base_ids ?? [];
    const body = { patch_ids: [...new Set([...(raw.context_ids ?? raw.patch_ids), ...baseIds])], facts };
    // Preflight spends live-test units in proportion to the model calls it drives (facts + context blobs), charged to the
    // IP AND the teaching key — one of them alone is free to spoof / mint (security review: preflight DoS).
    const units = t.preflightUnits({ patchIds: body.patch_ids, facts: body.facts });
    const buckets = [`ip:${req.ip}`, `key:${address.toLowerCase()}`];
    for (const b of buckets) if (market.chatQuota(b, 20, 3600_000, false, units) < 0) throw new HttpError(429, `quota_chat: free live-test quota exhausted for this hour (this pre-flight needs ${units} unit(s)) — try again later`);
    const out = await t.preflight({ address, ip: req.ip, patchIds: body.patch_ids, baseIds, facts: body.facts, sampled });
    for (const b of buckets) market.chatQuota(b, 20, 3600_000, true, units);
    return out;
  }));
  /**
   * Design §12.2 — what combining two knowledges would mean, before anything is built. Read-only: it resolves both
   * parents (the same refusals as building on one), compares their training sets by the parser key and their files
   * row by row, and reports which of the three build tiers is possible. Costs no live-model call, so it is not
   * metered against the chat quota — the two files are read from disk.
   */
  router.post('/api/teach/merge/preview', wrap(async (req) => {
    const address = requireTeacher(req); const t = visitorGate(req, address);
    const body = z.object({ a: z.string().min(1), b: z.string().min(1) }).parse(req.body);
    return t.mergePreview(body.a, body.b, { address });
  }));
  const trainingSchema = z.object({
    effort: z.enum(['quick', 'balanced', 'thorough']).optional(),
    max_steps: z.number().int().min(1).max(200).optional(), eval_every: z.number().int().min(1).max(100).optional(),
    rows_limit: z.number().int().min(1).max(2000).optional(), row_offset: z.number().int().min(0).max(2000).optional(),
    check_side_effects: z.boolean().optional(), use_alt: z.boolean().optional(),
  });
  router.post('/api/teach/jobs', wrap(async (req, res) => {
    const address = requireTeacher(req); const t = visitorGate(req, address);
    // backward compatible: `{dataset_id}` XOR the legacy `{facts}` (which materialises a dataset server-side)
    const body = z.object({
      patch_ids: z.array(z.string().min(1)).max(MAX_CHAT_PATCHES).default([]), builds_on_context: z.boolean().default(false),
      // lineage (design §12.1): what the lesson is trained ON TOP OF (≤ 2; two = merge, later) vs `patch_ids` / `context_ids` loaded for comparison
      // the cap is enforced in `createJob` (`too_many_bases`), not here: a request refused by the schema says
      // "invalid request", and a creator who names three knowledges deserves the sentence that explains the rule
      base_ids: z.array(z.string().min(1)).max(8).optional(), context_ids: z.array(z.string().min(1)).max(MAX_CHAT_PATCHES).optional(),
      mode: z.enum(['scratch', 'extend', 'fork', 'merge']).optional(), inherit: z.boolean().optional(), export: z.enum(['delta', 'squash']).optional(), force: z.boolean().optional(),
      // merge (§12.2): what the creator chose for each question the two knowledges answer differently, and how the
      // combined knowledge should be built
      resolutions: z.record(z.string(), z.union([z.enum(['a', 'b', 'drop']), z.object({ answer: z.string().min(1).max(ANSWER_MAX) })])).optional(),
      tier: z.enum(['union', 'retrain', 'rebuild']).optional(),
      // "yes, these answers are meant to replace the base's" (§12.1 base_unresolved_conflicts)
      confirm_conflicts: z.boolean().optional(),
      facts: z.array(factSchema).min(1).max(8).optional(),
      dataset_id: z.string().min(1).optional(), selected_indexes: z.array(z.number().int().min(0)).max(2000).optional(),
      // what an interactive pre-flight measured on those rows; the node re-checks each claim against the row's answer
      known: z.array(z.object({ index: z.number().int().min(0), base_answer: z.string().max(4000) })).max(2000).optional(),
      training: trainingSchema.optional(),
      contributor: z.object({ name: z.string().max(80).optional() }).optional(), name: z.string().max(80).optional(),
    }).parse(req.body);
    let baseIds = body.base_ids ?? [];
    let buildsOn = body.builds_on_context;
    const contextIds = body.context_ids ?? body.patch_ids;
    // legacy `builds_on_context: true` = "record the loaded knowledges as parents"; with lineage on it becomes a real
    // base (design §12.1), announced with a Deprecation header — off, it keeps meaning declared parents
    if (buildsOn && !baseIds.length && market.teach().lineage && contextIds.length) {
      baseIds = [contextIds[0]]; buildsOn = false;
      res.set('deprecation', 'true').set('x-ngram-deprecated', 'builds_on_context: send base_ids (the knowledge you build on) and context_ids (loaded for comparison) instead');
    }
    if (body.mode === 'extend' && !baseIds.length) throw bad('invalid: mode extend needs base_ids');
    // Design §9 / §12.1: two bases IS a merge, and it has its own body (`resolutions`, `tier`) and its own path — the
    // merged training set is built by the node, not uploaded, so `dataset_id` / `facts` have no meaning here.
    if (body.mode === 'merge' || baseIds.length === 2) {
      if (baseIds.length !== 2) throw bad('invalid: combining takes exactly two knowledges — send both in base_ids');
      const job = await t.createMergeJob({
        address, contributorName: body.contributor?.name, name: body.name, ip: req.ip,
        a: baseIds[0], b: baseIds[1], resolutions: body.resolutions, tier: body.tier, training: body.training, force: body.force,
      });
      res.status(202);
      return { job, quota: t.jobQuota(address, req.ip) };
    }
    if (!body.dataset_id && !body.facts?.length) throw bad('send either `dataset_id` or `facts`');
    const job = await t.createJob({
      address, contributorName: body.contributor?.name, name: body.name, ip: req.ip, patchIds: contextIds, buildsOn,
      facts: body.facts, datasetId: body.dataset_id, selectedIndexes: body.selected_indexes, known: body.known, training: body.training,
      baseIds, inherit: body.inherit, exportMode: body.export, force: body.force, mode: body.mode, confirmConflicts: body.confirm_conflicts,
    });
    res.status(202);
    return { job, quota: t.jobQuota(address, req.ip) };
  }));
  router.get('/api/teach/jobs', wrap(async (req) => { const address = requireTeacher(req); const t = visitorGate(req, address); return { items: t.listMine(address) }; }));
  router.get('/api/teach/jobs/:id', wrap(async (req) => {
    const t = needTeach(); const j = jobOr404(t, req.params.id as string);
    const address = teacherOf(req);
    // warms the catalog cache the view reads synchronously, so "Built on {name}" is a name and not an id
    if (j.bases?.length) await market.catalog().catch(() => undefined);
    return { job: t.isOwner(j, address) || isOperator(req) ? t.view(j) : t.publicView(j) };
  }));
  router.delete('/api/teach/jobs/:id', wrap(async (req) => { const { t, j, operator } = ownerJob(req, req.params.id as string); return t.cancel(j, operator ? 'operator' : 'owner'); }));
  router.post('/api/teach/jobs/:id/retry', wrap(async (req, res) => {
    const { t, j, address } = ownerJob(req, req.params.id as string, { operator: false });
    const body = z.object({ facts: z.array(factSchema).min(1).max(8), name: z.string().max(80).optional() }).parse(req.body);
    const job = await t.createJob({ address: address!, contributorName: j.contributor_name ?? undefined, name: body.name ?? j.name ?? undefined, ip: req.ip, patchIds: j.context, buildsOn: j.builds_on, facts: body.facts, parentJob: j.id });
    res.status(202);
    return { job, quota: t.jobQuota(address!, req.ip) };
  }));
  router.post('/api/teach/jobs/:id/retrain', wrap(async (req, res) => {
    const { t, j, address } = ownerJob(req, req.params.id as string, { operator: false });
    const body = z.object({ dataset_id: z.string().min(1).optional(), selected_indexes: z.array(z.number().int().min(0)).max(2000).optional(), training: trainingSchema.optional(), name: z.string().max(80).optional() }).parse(req.body ?? {});
    const job = await t.retrain(j, address!, { ...body, ip: req.ip });
    res.status(202);
    return { job, quota: t.jobQuota(address!, req.ip) };
  }));
  router.get('/api/teach/jobs/:id/events', wrap(async (req) => {
    const { t, j } = ownerJob(req, req.params.id as string);
    const q = z.object({ since: z.coerce.number().int().min(0).optional(), limit: z.coerce.number().int().min(1).max(200).default(200) }).parse(req.query);
    const rows = market.store.events({ kind: 'teach', limit: 1000 })
      .filter((e) => (e.data as { job_id?: string } | null)?.job_id === j.id && (!q.since || e.seq > q.since))
      .sort((a, b) => a.seq - b.seq).slice(-q.limit);
    // the owner is not the operator: the same redaction /api/events applies (draft ids, keys, prompts stay out)
    const events = publicEvents(rows, isOperator(req)).map((e) => ({ seq: e.seq, ts: e.ts, level: e.level, message: e.message, data: e.data }));
    void t;
    return { events, cursor: events.length ? events[events.length - 1].seq : (q.since ?? 0) };
  }));
  router.post('/api/teach/jobs/:id/recheck', wrap(async (req) => { const { t, j } = ownerJob(req, req.params.id as string); return t.recheck(j); }));
  router.get('/api/teach/jobs/:id/publish-challenge', wrap(async (req) => {
    const { t, j, address } = ownerJob(req, req.params.id as string, { operator: false });
    const raw = req.query.payout_address;
    const payout = raw === 'none' || raw === 'null' ? null : typeof raw === 'string' && raw ? raw : undefined;
    return await t.publishChallenge(j, address!, payout);
  }));
  router.post('/api/teach/jobs/:id/publish', wrap(async (req) => {
    const { t, j, address } = ownerJob(req, req.params.id as string, { operator: false });
    const body = z.object({
      name: z.string().min(2).max(80), description: z.string().max(2000).optional(), price: z.string().max(32).optional(), license: z.string().max(80).optional(),
      payout_address: z.string().nullable().optional(), claim_sig: z.string().min(1), consent: z.object({ permanent: z.boolean(), rights: z.boolean() }),
      // a teaching key named after the lesson was queued — the sheet shows that name, so the record must carry it
      contributor: z.object({ name: z.string().max(80).optional() }).optional(),
      // the training set (design §12.1): who may read it, under which licence, with or without notes, and where it came from
      dataset: z.object({
        access: z.enum(DATASET_ACCESS_LEVELS).optional(), license: z.string().max(80).optional(), include_notes: z.boolean().optional(),
        declaration: z.object({ source: z.enum(['own', 'public', 'licensed']), license: z.string().max(80).optional(), no_pii: z.boolean() }).nullable().optional(),
      }).optional(),
    }).parse(req.body);
    return t.publish(j, address!, body);
  }));
  router.post('/api/teach/jobs/:id/save', wrap(async (req) => { const { t, j, address } = ownerJob(req, req.params.id as string); return t.save(j, address ?? `operator:${market.address}`); }));
  router.get('/api/teach/jobs/:id/recipe', wrap(async (req, res) => {
    const t = needTeach(); const j = jobOr404(t, req.params.id as string);
    if (!t.tokenOk(j, typeof req.query.token === 'string' ? req.query.token : undefined)) throw new HttpError(401, 'invalid_signature: download token missing, wrong or expired — make a new link from Your knowledge');
    res.set('content-disposition', 'attachment; filename="recipe.json"');
    return t.recipeJson(j);
  }));
  router.get('/api/teach/jobs/:id/local-run', wrap(async (req, res) => {
    const t = needTeach(); const j = jobOr404(t, req.params.id as string);
    const token = typeof req.query.token === 'string' ? req.query.token : undefined;
    if (!t.tokenOk(j, token)) throw new HttpError(401, 'invalid_signature: download token missing, wrong or expired — make a new link from Your knowledge');
    res.status(200).type('text/markdown; charset=utf-8').set('content-disposition', 'attachment; filename="RUN-LOCALLY.md"').send(await t.runLocallyMd(j, token!));
  }));
  router.get('/api/teacher/:address', wrap(async (req) => needTeach().teacherProfile(addressParam(req.params.address as string))));

  // ------------------------------------------------------------ teach mode — operator (spec §6.4)
  const policyView = async (t: TeachWorker) => ({ policy: market.teachSettings(), effective: market.teach(), trainer: await t.trainerState(true) });
  router.get('/api/me/teach/policy', requireOperator, wrap(async () => policyView(needTeach())));
  router.patch('/api/me/teach/policy', requireOperator, wrap(async (req) => {
    const t = needTeach();
    const b = z.object({
      // every field is nullable: `null` clears the override so the node falls back to config.json (item 125)
      enabled: z.boolean().nullable().optional(), publish: z.enum(['review', 'auto', 'never']).nullable().optional(), facts_per_job: z.number().int().min(1).max(8).nullable().optional(),
      jobs_per_key_per_day: z.number().int().min(0).max(1000).nullable().optional(), jobs_per_ip_per_day: z.number().int().min(0).max(1000).nullable().optional(), queue_max: z.number().int().min(1).max(100).nullable().optional(),
      contributor_share: z.number().min(0).max(0.9).nullable().optional(), draft_ttl_days: z.number().int().min(1).max(90).nullable().optional(),
      paused_reason: z.string().max(200).nullable().optional(), blocked_topics: z.string().max(500).nullable().optional(),
      // teach mode v2 limits; `rows_per_job` is an explicit override that DISABLES the measured derivation
      dataset_max_bytes: z.number().int().min(1000).max(DATASET_MAX_BYTES_CEILING).nullable().optional(),
      dataset_max_rows: z.number().int().min(1).max(100_000).nullable().optional(),
      rows_per_job: z.number().int().min(1).max(1000).nullable().optional(),
      rows_per_key_per_day: z.number().int().min(0).max(100_000).nullable().optional(),
      rows_per_ip_per_day: z.number().int().min(0).max(100_000).nullable().optional(),
      datasets_per_key_per_day: z.number().int().min(0).max(1000).nullable().optional(),
      dataset_ttl_days: z.number().int().min(1).max(90).nullable().optional(),
      declaration_rows: z.number().int().min(1).max(100_000).nullable().optional(),
      queued_rows_max: z.number().int().min(1).max(1_000_000).nullable().optional(),
      check_call_budget: z.number().int().min(24).max(500).nullable().optional(),
    }).parse(req.body ?? {});
    if (b.blocked_topics) { try { new RegExp(b.blocked_topics, 'i'); } catch { throw bad('blocked_topics must be a valid regular expression'); } }
    market.updateTeachPolicy({
      enabled: b.enabled, publish: b.publish, factsPerJob: b.facts_per_job, jobsPerKeyPerDay: b.jobs_per_key_per_day, jobsPerIpPerDay: b.jobs_per_ip_per_day,
      queueMax: b.queue_max, contributorShare: b.contributor_share, draftTtlDays: b.draft_ttl_days,
      ...('paused_reason' in b ? { pausedReason: b.paused_reason } : {}), ...('blocked_topics' in b ? { blockedTopics: b.blocked_topics } : {}),
      ...('dataset_max_bytes' in b ? { datasetMaxBytes: b.dataset_max_bytes } : {}), ...('dataset_max_rows' in b ? { datasetMaxRows: b.dataset_max_rows } : {}),
      ...('rows_per_job' in b ? { rowsPerJob: b.rows_per_job } : {}),
      ...('rows_per_key_per_day' in b ? { rowsPerKeyPerDay: b.rows_per_key_per_day } : {}), ...('rows_per_ip_per_day' in b ? { rowsPerIpPerDay: b.rows_per_ip_per_day } : {}),
      ...('datasets_per_key_per_day' in b ? { datasetsPerKeyPerDay: b.datasets_per_key_per_day } : {}), ...('dataset_ttl_days' in b ? { datasetTtlDays: b.dataset_ttl_days } : {}),
      ...('declaration_rows' in b ? { declarationRows: b.declaration_rows } : {}), ...('queued_rows_max' in b ? { queuedRowsMax: b.queued_rows_max } : {}),
      ...('check_call_budget' in b ? { checkCallBudget: b.check_call_budget } : {}),
    } as Parameters<typeof market.updateTeachPolicy>[0]);
    t.invalidatePolicy();
    return policyView(t);
  }));
  /**
   * What visitors have uploaded to the operator's machine. Shipping the upload route without this would leave an
   * operator hosting content they cannot see or delete, so it lands in the same PR (design §5.10).
   */
  router.get('/api/me/teach/datasets', requireOperator, wrap(async (req) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(1000).default(200) }).parse(req.query);
    const t = needTeach();
    market.log('info', 'teach', 'operator opened the uploaded-datasets moderation view');
    return { items: t.datasets.listAll(q.limit) };
  }));
  router.get('/api/me/teach/jobs', requireOperator, wrap(async () => ({ items: needTeach().listAll() })));
  router.post('/api/me/teach/jobs/:id/approve', requireOperator, wrap(async (req) => { const t = needTeach(); return t.announceJob(jobOr404(t, req.params.id as string)); }));
  router.post('/api/me/teach/jobs/:id/reject', requireOperator, wrap(async (req) => {
    const t = needTeach(); const { reason } = z.object({ reason: z.string().min(1).max(500) }).parse(req.body ?? {});
    t.reject(jobOr404(t, req.params.id as string), reason);
    return { ok: true, status: 'REJECTED' };
  }));
  router.post('/api/me/teach/jobs/:id/cancel', requireOperator, wrap(async (req) => { const t = needTeach(); return t.cancel(jobOr404(t, req.params.id as string), 'operator'); }));
  router.get('/api/me/teach/contributors', requireOperator, wrap(async () => ({ items: market.store.listContributors() })));
  router.post('/api/me/teach/contributors/:address', requireOperator, wrap(async (req) => {
    const address = addressParam(req.params.address as string);
    const { hidden } = z.object({ hidden: z.boolean().optional() }).parse(req.body ?? {});
    if (!market.store.getContributor(address)) market.store.touchContributor(address, {});
    if (hidden !== undefined) market.store.setContributorHidden(address, hidden);
    return { ok: true, contributor: market.store.getContributor(address) };
  }));
  router.get('/api/me/teach/bans', requireOperator, wrap(async () => ({ items: market.store.listBans() })));
  router.post('/api/me/teach/bans', requireOperator, wrap(async (req) => {
    const b = z.object({ kind: z.enum(['address', 'ip']), value: z.string().min(1).max(200), reason: z.string().max(500).optional() }).parse(req.body ?? {});
    const ban = market.store.addBan(b.kind, b.value, b.reason ?? null);
    market.log('warn', 'teach', `${b.kind} ${b.value} blocked by the operator${b.reason ? `: ${b.reason}` : ''}`);
    return { ban };
  }));
  router.delete('/api/me/teach/bans/:id', requireOperator, wrap(async (req) => { market.store.deleteBan(Number(req.params.id)); return { ok: true }; }));

  // ------------------------------------------------------------ aindrive (files & change history)
  router.get('/api/drive', wrap(async () => {
    if (!deps.drive) throw notFound('drive integration disabled');
    return deps.drive.status();
  }));
  router.get('/api/drive/changes', wrap(async (req) => {
    if (!deps.drive) throw notFound('drive integration disabled');
    const path = String(req.query.path ?? '');
    if (!path || path.includes('..') || path.startsWith('/')) throw bad('path must be relative to the drive folder');
    return deps.drive.changes(path);
  }));
  router.post('/api/drive', requireOperator, wrap(async (req) => {
    if (!deps.drive) throw notFound('drive integration disabled');
    const { action } = z.object({ action: z.enum(['up', 'stop', 'sync', 'login', 'status']) }).parse(req.body);
    if (action === 'up') return deps.drive.up();
    if (action === 'stop') return deps.drive.stop();
    if (action === 'sync') return deps.drive.sync();
    if (action === 'status') return { cli: await deps.drive.cliStatus(), ...deps.drive.status() };
    return { ok: false, message: `pairing needs a browser: ${deps.drive.status().login_hint}` };
  }));

  // ------------------------------------------------------------ x402 trading (seller side)
  router.get('/x402/patch/:id', wrap(async (req, res) => {
    const id = req.params.id as string;
    let e = await market.entry(id);
    if (!e || !e.sellable) { await market.refreshLedger(); e = await market.entry(id); }
    if (!e || e.status === 'DRAFT') throw notFound('patch not found');
    if (e.anchor.author !== market.address) throw new HttpError(409, `not sold here; gateway is ${(e.anchor as PatchAnchor & { gateway_url?: string }).gateway_url ?? 'unknown'}`);
    // 410 Gone: the publisher retired it (item 148). Before the quorum check, because a retired knowledge is not
    // "not listed yet" — it is withdrawn, and the gate must stop charging for it whether or not the body is still here.
    if (e.status === 'RETIRED') throw new HttpError(410, challengedMessage(e));
    if (!e.quorum_ok) throw new HttpError(423, `patch not listed yet (verification ${e.passed}/${e.quorum})`);
    // A challenged entry is locked, not discounted: no price is honest while a verifier disputes the result (item 153).
    if (!e.sellable) throw new HttpError(423, challengedMessage(e));
    const resource = `/x402/patch/${id}`;
    const header = req.header(X402_HEADER_PAYMENT);
    if (!header) {
      // The 402 carries the whole quote: the price, what the family costs, and the bases the buyer must own for
      // this knowledge to do anything (item 270). `requires` is empty on a knowledge that stands alone.
      const reqs = await market.requirementsFor(e, resource);
      res.status(402).set(X402_HEADER_REQUIRED, market.encodeRequirements(reqs)).set('www-authenticate', 'x402').json({ x402Version: 1, error: 'payment required', requirements: reqs, accepts: reqs });
      return;
    }
    const out = await market.settlePayment(e, resource, header);
    if (!out.settlement) throw new HttpError(402, out.error ?? 'payment failed');
    const settlement = out.settlement;
    const manifest = market.issueManifest(e, settlement.buyer);
    const text = JSON.stringify(manifest);
    res.status(200)
      .set(X402_HEADER_TX, settlement.tx_hash).set(X402_HEADER_CURRENCY, settlement.currency)
      // `replayed` = this payment was already settled and the manifest was re-issued to the payer; nothing was
      // charged a second time (item 273). A first sale is unchanged: {settled:true, tx, royalty}.
      .set('x-payment-response', JSON.stringify({ settled: true, tx: settlement.tx_hash, royalty: settlement.royalty, ...(out.replayed ? { replayed: true, settled_at: settlement.created_at } : {}) }))
      .set('x-content-sha256', sha256Hex(text))
      .type('application/json').send(text);
  }));

  // ------------------------------------------------------------ p2p protocol
  router.get('/p2p/info', wrap(async () => market.selfInfo()));
  /**
   * Peer hello. The body is a CLAIM — `address`, `roles`, `blobs` — and before this route checked a signature the
   * claim was enough to become a "verifier" on this node and download every paid body for free (item 326). The
   * endpoint is still remembered from an unsigned hello (that is only gossip, and it costs nothing to be wrong
   * about), but the address and the roles are recorded only when the caller signs `hello:<its endpoint>` with the
   * key it claims — so a role claim is now as accountable as an attestation.
   */
  router.post('/p2p/hello', wrap(async (req) => {
    const info = req.body as { endpoint?: string; address?: string };
    const endpoint = (info?.endpoint ?? '').replace(/\/+$/, '');
    if (!endpoint || !info?.address || sameAddr(info.address, market.address)) return market.selfInfo();
    const signer = verifyAuthHeader(req.header('x-ngram-auth'), `hello:${endpoint}`);
    if (signer && sameAddr(signer, info.address)) {
      market.store.upsertPeer(endpoint, { address: info.address, info: info as never, last_seen: Date.now(), failures: 0 });
    } else {
      market.store.upsertPeer(endpoint);
      market.log('debug', 'p2p', `unsigned hello from ${endpoint} claiming ${info.address.slice(0, 10)}…${(info as { roles?: string[] }).roles?.length ? ` and the roles ${(info as { roles?: string[] }).roles!.join(', ')}` : ''} — endpoint remembered, claim not recorded (it must sign hello:<endpoint>)`, null, { endpoint, claimed: info.address });
    }
    return market.selfInfo();
  }));

  /**
   * What this node DID about one settlement's royalties — the public half of item 311. An ancestor's node can see
   * the settle record naming it, but whether the money moved lived only in the seller's private `payouts` table;
   * this route answers for one settle hash, so the ancestor's wallet can say `paid` / `pending` / `failed` with the
   * seller's own tx hash instead of reporting the seller's promise as money received.
   */
  router.get('/p2p/payouts/:hash', wrap(async (req) => {
    const hash = String(req.params.hash ?? '');
    const items = market.store.listPayouts({ limit: 5000 }).filter((r) => r.settle_hash === hash)
      .map((r) => ({ address: r.address, amount: r.amount, currency: r.currency, status: r.status, tx_hash: r.tx_hash, attempts: r.attempts, last_error: r.last_error, updated_at: r.updated_at }));
    // A local-credit sale is settled by the record itself: there is no transfer to report, and saying so is not the
    // same as "we have no rows for you".
    const settle = (await market.ledger.settlements()).find((x) => x.hash === hash);
    return { settle_hash: hash, seller: market.address, scheme: settle?.body.scheme ?? null, known: !!settle, items };
  }));
  router.get('/p2p/peers', wrap(async () => ({ peers: [market.publicUrl, ...market.p2p.peers().map((p) => p.endpoint)] })));
  router.get('/p2p/records', wrap(async (req) => {
    const since = Number(req.query.since ?? 0);
    const limit = Math.min(1000, Number(req.query.limit ?? 500));
    if (!market.ledger.sync) return { records: [], cursor: since };
    return market.ledger.sync(since, limit);
  }));
  router.post('/p2p/records', wrap(async (req) => {
    const recs = (req.body?.records ?? []) as LedgerRecord[];
    let added = 0; const rejected: string[] = [];
    for (const r of recs.slice(0, 500)) {
      try { if (await market.ledger.ingest(r)) added++; } catch (e) { rejected.push(`${r.hash?.slice(0, 12)}: ${(e as Error).message}`); }
    }
    if (added) { market.invalidate(); market.log('info', 'p2p', `received ${added} record(s) via push`); }
    // On the AIN ledger records are not ingested from peers — the push is a hint that the chain has new state: re-read it now.
    if (!added && recs.length && market.ledger.kind === 'ain') market.refreshLedgerSoon();
    return { added, rejected };
  }));
  router.get('/p2p/blobs', wrap(async () => ({ blobs: market.blobs.list().map((b) => ({ sha256: b.sha256, size_bytes: b.size_bytes, rows: b.rows })) })));
  router.get('/p2p/blob/:sha', wrap(async (req, res) => {
    const sha = req.params.sha as string;
    const blob = market.blobs.get(sha);
    if (!blob) throw notFound('blob not held by this node');
    const requester = verifyAuthHeader(req.header('x-ngram-auth'), `blob:${sha}`);
    const token = typeof req.query.token === 'string' ? req.query.token : undefined;
    if (!(await market.mayDownload(sha, requester, token))) throw new HttpError(402, 'payment required: buy the patch via /x402/patch/:id (its author, a buyer holding a download token, and a verifier while it is being verified can fetch it)');
    const size = statSync(blob.path).size;
    // The save sheet and RUN-LOCALLY.md both name the file `lesson-<slug>-<id>.npz`, and every command in that document
    // is written against that name — so a browser download that lands as `<sha>.npz` breaks the copy-paste. `?name=` is
    // an optional, sanitised display name; the bytes and `x-content-sha256` are unchanged.
    const asked = typeof req.query.name === 'string' ? req.query.name.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 80) : '';
    const filename = /^[A-Za-z0-9][A-Za-z0-9._-]*\.npz$/.test(asked) ? asked : `${sha}.npz`;
    res.status(200).set({ 'content-type': 'application/octet-stream', 'content-length': String(size), 'x-content-sha256': sha, 'content-disposition': `attachment; filename="${filename}"` });
    createReadStream(blob.path).pipe(res);
  }));

  // published training sets between nodes (lineage design §6.6): same gate as /p2p/blob, plus the access level
  const datasetGateP2p = async (req: Request, sha: string) => {
    if (!market.datasets.has(sha)) throw notFound('dataset not held by this node');
    const requester = verifyAuthHeader(req.header('x-ngram-auth'), `dataset:${sha}`);
    const token = req.header('x-ngram-derive') ?? (typeof req.query.token === 'string' ? req.query.token : undefined);
    const ok = await market.mayReadDataset(sha, requester, token);
    if (!ok.ok) throw new HttpError(ok.reason === 'dataset_unknown' ? 404 : 403, ok.reason === 'dataset_private' ? 'dataset_private: the creator kept this training set private' : ok.reason === 'dataset_derivative_only' ? 'dataset_derivative_only: post a derive intent to the knowledge (POST /api/patches/:id/derive-intent) and send its token in x-ngram-derive' : 'dataset_unknown: no listed knowledge names this training set');
  };
  router.get('/p2p/datasets', wrap(async () => ({ datasets: market.datasets.list().map((b) => ({ sha256: b.sha256, rows: b.rows, size_bytes: b.size_bytes, access: b.access, license: b.license })) })));
  router.get('/p2p/dataset/:sha', wrap(async (req, res) => {
    const sha = req.params.sha as string;
    await datasetGateP2p(req, sha);
    const bytes = market.datasets.rowsBytes(sha)!;
    res.status(200).set({ 'content-type': 'application/x-ndjson; charset=utf-8', 'content-length': String(bytes.length), 'x-content-sha256': sha, 'content-disposition': `attachment; filename="dataset-${sha.slice(0, 12)}.jsonl"` }).send(bytes);
  }));
  router.get('/p2p/dataset/:sha/manifest', wrap(async (req) => {
    const sha = req.params.sha as string;
    await datasetGateP2p(req, sha);
    return market.datasets.manifest(sha) ?? {};
  }));
  router.get('/p2p/dataset/:sha/benchmark', wrap(async (req, res) => {
    const sha = req.params.sha as string;
    await datasetGateP2p(req, sha);
    const p = market.datasets.benchmarkPath(sha);
    if (!existsSync(p)) throw notFound('no benchmark list for this training set');
    res.status(200).set({ 'content-type': 'application/x-ndjson; charset=utf-8' }).send(readFileSync(p));
  }));

  // ------------------------------------------------------------ errors
  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    // D3: giving up while queued is not a failure — it is an outcome the client asked for, and nothing was charged.
    if (err instanceof ChatCancelledError) return res.status(499).json({ error: err.message, cancelled: true, charged: false });
    // A live test that waited out the shared lock is temporarily unavailable, not broken: say so as 503 + Retry-After
    // instead of the generic 500 the "shared runtime busy" throw used to fall through to.
    if (err instanceof Error && /shared runtime busy/.test(err.message)) { res.set('retry-after', '30'); return res.status(503).json({ error: err.message, busy: true }); }
    // TeachError.details carries what a bare {error} cannot: the per-row report of a failed upload, the quota that is left
    if (err instanceof TeachError) return res.status(err.status).json({ error: err.message, ...(err.details ?? {}) });
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.body });
    if (err instanceof PayoutError) return res.status(err.status).json({ error: err.message });
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'invalid request', issues: err.issues });
    // typed domain errors from Market / core validation: caller mistakes are 4xx, never 500
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (err instanceof ConflictError) return res.status(409).json({ error: err.message, ...(err.details ?? {}) });
    if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof MarketError) return res.status(err.status).json({ error: err.message, ...(err.details ?? {}) });
    const msg = (err as Error)?.message ?? String(err);
    // Market / runtime errors carry the status they mean (400 bad input, 404 unknown, 409 conflict, 503 model unavailable).
    const status = (err as { status?: unknown })?.status;
    if (typeof status === 'number' && status >= 400 && status < 600) return res.status(status).json({ error: msg });
    console.error('[api]', msg);
    res.status(500).json({ error: msg });
  });
  return router;
}
