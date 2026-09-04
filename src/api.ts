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
  type CatalogEntry, type LedgerRecord, type PatchAnchor,
} from '@ngram/core';
import { verifyAuthHeader } from './p2p.js';
import { TeachAuth } from './teach-auth.js';
import { challengedMessage, ConflictError, MAX_CHAT_PATCHES, NotFoundError, type Market } from './market.js';
import { ChatCancelledError } from './chat-queue.js';
import type { Verifier } from './verifier.js';
import type { Drive } from './drive.js';
import { ANSWER_MAX, creditedAddress, PROMPT_MAX, TeachError, type TeachWorker } from './teach.js';
import type { RowsOp } from './teach-datasets.js';
import { PayoutError } from './payouts.js';
import { EVENT_LEVELS } from './store.js';
import type { EventRow, TeachJobRow } from './store.js';
import { buildOpenApi, CLI_REFERENCE } from './openapi.js';

export interface ApiDeps { market: Market; verifier: Verifier | null; drive?: Drive; teach?: TeachWorker; saveConfig: () => void; }

class HttpError extends Error { constructor(public status: number, message: string, /** extra fields merged into the JSON body — e.g. quota_reset on a 429 */ public body?: Record<string, unknown>) { super(message); } }
const bad = (msg: string) => new HttpError(400, msg);
const notFound = (msg = 'not found') => new HttpError(404, msg);

type Handler = (req: Request, res: Response) => Promise<unknown> | unknown;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve(fn(req, res)).then((out) => { if (out !== undefined && !res.headersSent) res.json(out); }).catch(next);
};

const SESSION_COOKIE = 'ngram_session';

export function buildApi(deps: ApiDeps): Router {
  const { market } = deps;
  const router = express.Router();
  const upload = multer({ dest: join(market.cfg.dataDir, 'uploads'), limits: { fileSize: 4 * 1024 ** 3 } });
  mkdirSync(join(market.cfg.dataDir, 'uploads'), { recursive: true });

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

  router.get('/api/auth/me', wrap((req) => ({
    signedIn: isOperator(req), address: market.address, name: market.cfg.name, roles: market.cfg.roles,
    needsSetup: !market.cfg.operatorPasswordHash,
  })));
  router.post('/api/auth/setup', wrap((req, res) => {
    if (market.cfg.operatorPasswordHash) throw new HttpError(409, 'operator password already set');
    const { password } = z.object({ password: z.string().min(4) }).parse(req.body);
    market.cfg.operatorPasswordHash = hashPassword(password);
    deps.saveConfig();
    const token = randomBytes(24).toString('hex');
    market.store.putSession(token, 30 * 24 * 3600_000);
    res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 3600_000 });
    return { ok: true, token };
  }));
  router.post('/api/auth/login', wrap((req, res) => {
    const { password } = z.object({ password: z.string() }).parse(req.body);
    if (!market.cfg.operatorPasswordHash || !verifyPassword(password, market.cfg.operatorPasswordHash)) throw new HttpError(401, 'wrong password');
    const token = randomBytes(24).toString('hex');
    market.store.putSession(token, 30 * 24 * 3600_000);
    res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 3600_000 });
    return { ok: true, token };
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
    initial_credit: market.cfg.market.initialCredit, royalty_share: market.cfg.market.royaltyShare,
    accepts_contributions: market.acceptsContributions(), contributor_share: market.teach().contributorShare,
    counts: (() => { const c = market.catalogSync().filter((e) => e.status !== 'DRAFT'); return { patches: c.length, listed: c.filter((e) => e.status === 'LISTED').length, verifying: c.filter((e) => e.status === 'ANNOUNCED' || e.status === 'VERIFYING').length, superseded: c.filter((e) => e.status === 'SUPERSEDED').length, rejected: c.filter((e) => e.status === 'REJECTED').length }; })(),
  })));

  router.get('/api/catalog', wrap(async (req) => {
    const q = z.object({
      sort: z.enum(['latest', 'popular', 'price', 'rows']).default('latest'),
      status: z.string().optional(), model: z.string().optional(), schema: z.string().optional(), branch: z.string().optional(),
      author: z.string().optional(), contributor: z.string().optional(), origin: z.enum(['operator', 'teach']).optional(), q: z.string().optional(),
      limit: z.coerce.number().min(1).max(200).default(50), offset: z.coerce.number().min(0).default(0),
      include_drafts: z.coerce.boolean().default(false),
    }).parse(req.query);
    // Private drafts never leak to anonymous callers — the facet lists (models/schemas) are derived from the same filtered set as the items.
    let items = await market.catalog();
    if (!q.include_drafts || !isOperator(req)) items = items.filter((e) => e.status !== 'DRAFT');
    const facets = items;
    if (q.status) items = items.filter((e) => q.status!.split(',').includes(e.status));
    if (q.model) items = items.filter((e) => e.anchor.model.id_M === q.model);
    if (q.schema) items = items.filter((e) => e.anchor.benchmark.schema === q.schema);
    if (q.author) items = items.filter((e) => e.anchor.author === q.author);
    if (q.contributor) { const c = q.contributor.toLowerCase(); items = items.filter((e) => (e.anchor.contributors ?? []).some((x) => creditedAddress(x).toLowerCase() === c)); }
    if (q.origin) items = items.filter((e) => (e.anchor.origin ?? 'operator') === q.origin);
    if (q.branch) { const b = (await market.branches()).find((x) => x.name === q.branch); items = items.filter((e) => b?.patch_ids.includes(e.anchor.id)); }
    if (q.q) { const s = q.q.toLowerCase(); items = items.filter((e) => [e.anchor.id, e.anchor.name, e.anchor.description, e.anchor.model.id_M, e.anchor.benchmark.schema].join(' ').toLowerCase().includes(s)); }
    // "Most popular" ranks by status FIRST: downloads accumulate forever, so a retired single-fact patch with 187
    // downloads used to head the marketplace over the flagship it was replaced by. Tradeable before retired.
    const statusRank = (s: string) => (s === 'LISTED' ? 0 : s === 'SUPERSEDED' ? 2 : s === 'REJECTED' ? 3 : 1);
    const sorters = {
      latest: (a: typeof items[0], b: typeof items[0]) => b.anchor.created_at - a.anchor.created_at,
      popular: (a: typeof items[0], b: typeof items[0]) => statusRank(a.status) - statusRank(b.status) || b.downloads - a.downloads || b.passed - a.passed,
      price: (a: typeof items[0], b: typeof items[0]) => Number(a.anchor.price) - Number(b.anchor.price),
      rows: (a: typeof items[0], b: typeof items[0]) => b.anchor.rows - a.anchor.rows,
    };
    items = [...items].sort(sorters[q.sort]);
    const total = items.length;
    const page = items.slice(q.offset, q.offset + q.limit).map((e) => ({ ...redactContributors(e), attestations: e.attestations.map((a) => ({ ...a, sig: undefined })) }));
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

  router.get('/api/patches/:id', wrap(async (req) => {
    const e = await market.entry(req.params.id as string);
    if (!e || (e.status === 'DRAFT' && !isOperator(req))) throw notFound('patch not found');
    const map = await market.entryMap();
    const visible = relativeVisible(req, e);
    const lineage = { parents: e.anchor.parents.map((p) => map.get(p)).filter(visible).map((x) => ({ id: x.anchor.id, name: x.anchor.name, author: x.anchor.author, status: x.status })),
      children: e.children.map((c) => map.get(c)).filter(visible).map((x) => ({ id: x.anchor.id, name: x.anchor.name, author: x.anchor.author, status: x.status })) };
    const conflicts = (await market.conflicts(e.anchor.id).catch(() => [])).filter((c) => visible(map.get(c.patch_id)));
    const branches = (await market.branches()).filter((b) => b.patch_ids.includes(e.anchor.id)).map((b) => ({ name: b.name, context: b.context }));
    return {
      ...redactContributors(e), lineage, conflicts, branches,
      owned: e.anchor.author === market.address, purchased: !!market.store.getPurchase(e.anchor.id), has_body: market.blobs.has(e.anchor.patch_sha256),
      applied: market.isApplied(e.anchor.id), gateway_url: (e.anchor as PatchAnchor & { gateway_url?: string }).gateway_url ?? null,
    };
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
    return { branches: branches.map((b) => {
      const state = new Map<string, boolean>();
      for (const r of subs) if (r.body.branch === b.name) state.set(r.body.node, r.body.action === 'subscribe');
      return { ...b, subscribers: [...state.entries()].filter(([, v]) => v).map(([k]) => nodes.find((n) => n.address === k) ?? { address: k }) };
    }), mine: await market.mySubscriptions() };
  }));
  router.get('/api/route', wrap(async (req) => market.route(req.query as Record<string, string>)));
  router.get('/api/nodes', wrap(async () => {
    // visitors count knowledge files of public knowledge only (hidden test anchors / drafts are not part of the public catalog)
    const nodes = await Promise.all((await market.knownNodes()).map(async (n) => ({ ...n, blobs: await market.publicBlobs(n.blobs ?? []) })));
    return { nodes, peers: market.p2p.peers(), self: market.address };
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
  router.get('/api/me/wallet', requireOperator, wrap(async () => {
    const setts = await market.ledger.settlements();
    const sales = setts.filter((s) => s.body.seller === market.address).map((s) => s.body);
    const royalties = setts.filter((s) => s.body.seller !== market.address && s.body.royalty[market.address]).map((s) => ({ patch_id: s.body.patch_id, amount: s.body.royalty[market.address], created_at: s.body.created_at }));
    const summary = market.payouts.summary();
    return { ...(await market.chainStatus()), sales, royalties, purchases: market.store.listPurchases().length,
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
    const body = z.object({
      id: z.string().optional(), name: z.string().min(2), description: z.string().optional(), model_id: z.string().min(1),
      benchmark: z.string().transform((s) => JSON.parse(s)).or(z.object({}).passthrough()), price: z.string().regex(PRICE_RE, 'price must be a non-negative number').optional(),
      billing: z.enum(['per_download', 'per_apply_hour', 'per_hit']).optional(), license: z.string().optional(),
      parents: z.string().optional().transform((s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : [])),
      branch: z.string().optional(), topic_path: z.string().optional(), path: z.string().optional(),
      visibility: z.enum(['public', 'test']).optional(),
      contributors: z.string().transform((s) => JSON.parse(s)).or(z.array(z.object({}).passthrough())).optional(),
    }).parse(req.body);
    const file = req.file?.path ?? body.path;
    if (!file) throw bad('upload a .npz file or give a local `path`');
    if (!req.file && !existsSync(file)) throw bad(`path not found on node: ${file}`);
    const anchor = await market.createDraft({
      id: body.id, name: body.name, description: body.description, model: { id_M: body.model_id }, benchmark: body.benchmark as never,
      price: body.price, billing: body.billing, license: body.license, parents: body.parents, branch: body.branch, topic_path: body.topic_path,
      file, keepInPlace: !req.file, visibility: body.visibility, contributors: body.contributors as never,
    });
    return { anchor };
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
  router.post('/api/patches/:id/announce', requireOperator, wrap(async (req) => ({ record: await market.announce(req.params.id as string) })));
  router.post('/api/patches/:id/verify', requireOperator, wrap(async (req) => {
    if (!deps.verifier) throw bad('this node is not a verifier');
    const e = await market.entry(req.params.id as string);
    if (!e) throw notFound();
    return { attestation: await deps.verifier.verifyOne(e.anchor) };
  }));
  router.post('/api/patches/:id/challenge', requireOperator, wrap(async (req) => { await market.challenge(req.params.id as string, String(req.body?.reason ?? 'manual challenge')); return { ok: true }; }));
  router.post('/api/patches/:id/buy', requireOperator, wrap(async (req) => market.buy(req.params.id as string, { apply: !!req.body?.apply })));
  router.post('/api/patches/:id/apply', requireOperator, wrap(async (req) => ({ result: await market.applyPatch(req.params.id as string, 'manual') })));
  router.post('/api/patches/:id/remove', requireOperator, wrap(async (req) => ({ result: await market.removePatch(req.params.id as string) })));
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
  router.post('/api/branches/:name/patches', requireOperator, wrap(async (req) => ({ branch: await market.addToBranch(decodeURIComponent(req.params.name as string), String(req.body.patch_id)) })));
  router.post('/api/branches/:name/subscribe', requireOperator, wrap(async (req) => { await market.subscribe(decodeURIComponent(req.params.name as string), 'subscribe'); return { ok: true }; }));
  router.post('/api/branches/:name/unsubscribe', requireOperator, wrap(async (req) => { await market.subscribe(decodeURIComponent(req.params.name as string), 'unsubscribe'); return { ok: true }; }));

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
  router.get('/api/runtime', wrap(async () => ({ ...(await market.runtime.status(true)), applied: market.store.listApplied() })));

  router.post('/api/peers', requireOperator, wrap(async (req) => { market.p2p.addPeer(String(req.body.endpoint)); market.cfg.peers = [...new Set([...market.cfg.peers, String(req.body.endpoint)])]; deps.saveConfig(); return { ok: true }; }));
  router.delete('/api/peers', requireOperator, wrap(async (req) => { market.p2p.removePeer(String(req.body.endpoint)); market.cfg.peers = market.cfg.peers.filter((p) => p !== req.body.endpoint); deps.saveConfig(); return { ok: true }; }));
  router.post('/api/chain/setup', requireOperator, wrap(async () => {
    if (!(market.ledger instanceof AinLedger)) throw bad('node is not on the AIN ledger');
    return market.ledger.setupApp();
  }));

  // ------------------------------------------------------------ ChatMode (live test)
  router.get('/api/chat/patches', wrap(async (req) => {
    // hidden contributor names are redacted here too (public response), like /api/catalog and /api/patches/:id
    const items = (await market.testablePatches()).map(redactContributors);
    // `lessons`: the caller's private drafts (teach mode), only with a verified teaching-key signature
    const teacher = teachAuth.verify(req);
    const q = market.runtime.queueState();
    return {
      items, runtime: await market.runtime.status(), lock: q.lock,
      // D3: `now` is the node's clock — the client measures "held for 40s" against it instead of the browser's,
      // and `queue` says how many live tests of this node are waiting behind the shared model.
      now: Date.now(), queue: { running: q.running, waiting: market.chatQueue.waiting() },
      applied: market.pinnedPatchIds(), overlaps: market.chatOverlaps(items),
      ...(teacher ? { lessons: deps.teach ? await deps.teach.lessonsFor(teacher) : ([] as CatalogEntry[]), teacher } : {}),
    };
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
  const dropTemp = (req: Request) => { const f = req.file?.path; if (f && existsSync(f)) { try { rmSync(f, { force: true }); } catch { /* already gone */ } } };
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
    const q = z.object({ offset: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(200).default(50), status: z.string().max(20).default('all') }).parse(req.query);
    const page = t.datasets.reportPage(d, q);
    return { total: page.total, source_rows: page.source_rows, offset: page.offset, limit: page.limit, summary: page.summary, items: page.rows };
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
  router.post('/api/teach/preflight', wrap(async (req) => {
    const address = requireTeacher(req); const t = visitorGate(req, address);
    const raw = z.object({
      patch_ids: z.array(z.string().min(1)).max(MAX_CHAT_PATCHES).default([]),
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
    const body = { patch_ids: raw.patch_ids, facts };
    // Preflight spends live-test units in proportion to the model calls it drives (facts + context blobs), charged to the
    // IP AND the teaching key — one of them alone is free to spoof / mint (security review: preflight DoS).
    const units = t.preflightUnits({ patchIds: body.patch_ids, facts: body.facts });
    const buckets = [`ip:${req.ip}`, `key:${address.toLowerCase()}`];
    for (const b of buckets) if (market.chatQuota(b, 20, 3600_000, false, units) < 0) throw new HttpError(429, `quota_chat: free live-test quota exhausted for this hour (this pre-flight needs ${units} unit(s)) — try again later`);
    const out = await t.preflight({ address, ip: req.ip, patchIds: body.patch_ids, facts: body.facts, sampled });
    for (const b of buckets) market.chatQuota(b, 20, 3600_000, true, units);
    return out;
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
      facts: z.array(factSchema).min(1).max(8).optional(),
      dataset_id: z.string().min(1).optional(), selected_indexes: z.array(z.number().int().min(0)).max(2000).optional(),
      // what an interactive pre-flight measured on those rows; the node re-checks each claim against the row's answer
      known: z.array(z.object({ index: z.number().int().min(0), base_answer: z.string().max(4000) })).max(2000).optional(),
      training: trainingSchema.optional(),
      contributor: z.object({ name: z.string().max(80).optional() }).optional(), name: z.string().max(80).optional(),
    }).parse(req.body);
    if (!body.dataset_id && !body.facts?.length) throw bad('send either `dataset_id` or `facts`');
    const job = await t.createJob({
      address, contributorName: body.contributor?.name, name: body.name, ip: req.ip, patchIds: body.patch_ids, buildsOn: body.builds_on_context,
      facts: body.facts, datasetId: body.dataset_id, selectedIndexes: body.selected_indexes, known: body.known, training: body.training,
    });
    res.status(202);
    return { job, quota: t.jobQuota(address, req.ip) };
  }));
  router.get('/api/teach/jobs', wrap(async (req) => { const address = requireTeacher(req); const t = visitorGate(req, address); return { items: t.listMine(address) }; }));
  router.get('/api/teach/jobs/:id', wrap(async (req) => {
    const t = needTeach(); const j = jobOr404(t, req.params.id as string);
    const address = teacherOf(req);
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
    return t.publishChallenge(j, address!, payout);
  }));
  router.post('/api/teach/jobs/:id/publish', wrap(async (req) => {
    const { t, j, address } = ownerJob(req, req.params.id as string, { operator: false });
    const body = z.object({
      name: z.string().min(2).max(80), description: z.string().max(2000).optional(), price: z.string().max(32).optional(), license: z.string().max(80).optional(),
      payout_address: z.string().nullable().optional(), claim_sig: z.string().min(1), consent: z.object({ permanent: z.boolean(), rights: z.boolean() }),
      // a teaching key named after the lesson was queued — the sheet shows that name, so the record must carry it
      contributor: z.object({ name: z.string().max(80).optional() }).optional(),
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
      enabled: z.boolean().optional(), publish: z.enum(['review', 'auto', 'never']).optional(), facts_per_job: z.number().int().min(1).max(8).optional(),
      jobs_per_key_per_day: z.number().int().min(0).max(1000).optional(), jobs_per_ip_per_day: z.number().int().min(0).max(1000).optional(), queue_max: z.number().int().min(1).max(100).optional(),
      contributor_share: z.number().min(0).max(0.9).optional(), draft_ttl_days: z.number().int().min(1).max(90).optional(),
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
    if (!e.quorum_ok) throw new HttpError(423, `patch not listed yet (verification ${e.passed}/${e.quorum})`);
    // A challenged entry is locked, not discounted: no price is honest while a verifier disputes the result (item 153).
    if (!e.sellable) throw new HttpError(423, challengedMessage(e));
    const resource = `/x402/patch/${id}`;
    const header = req.header(X402_HEADER_PAYMENT);
    if (!header) {
      const reqs = market.requirementsFor(e, resource);
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
      .set('x-payment-response', JSON.stringify({ settled: true, tx: settlement.tx_hash, royalty: settlement.royalty }))
      .set('x-content-sha256', sha256Hex(text))
      .type('application/json').send(text);
  }));

  // ------------------------------------------------------------ p2p protocol
  router.get('/p2p/info', wrap(async () => market.selfInfo()));
  router.post('/p2p/hello', wrap(async (req) => {
    const info = req.body as { endpoint?: string; address?: string };
    if (info?.endpoint && info.address && info.address !== market.address) market.store.upsertPeer(info.endpoint.replace(/\/+$/, ''), { address: info.address, info: info as never, last_seen: Date.now(), failures: 0 });
    return market.selfInfo();
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
    if (!(await market.mayDownload(sha, requester, token))) throw new HttpError(402, 'payment required: buy the patch via /x402/patch/:id (verifiers and authors are exempt)');
    const size = statSync(blob.path).size;
    // The save sheet and RUN-LOCALLY.md both name the file `lesson-<slug>-<id>.npz`, and every command in that document
    // is written against that name — so a browser download that lands as `<sha>.npz` breaks the copy-paste. `?name=` is
    // an optional, sanitised display name; the bytes and `x-content-sha256` are unchanged.
    const asked = typeof req.query.name === 'string' ? req.query.name.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 80) : '';
    const filename = /^[A-Za-z0-9][A-Za-z0-9._-]*\.npz$/.test(asked) ? asked : `${sha}.npz`;
    res.status(200).set({ 'content-type': 'application/octet-stream', 'content-length': String(size), 'x-content-sha256': sha, 'content-disposition': `attachment; filename="${filename}"` });
    createReadStream(blob.path).pipe(res);
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
    const msg = (err as Error)?.message ?? String(err);
    // Market / runtime errors carry the status they mean (400 bad input, 404 unknown, 409 conflict, 503 model unavailable).
    const status = (err as { status?: unknown })?.status;
    if (typeof status === 'number' && status >= 400 && status < 600) return res.status(status).json({ error: msg });
    console.error('[api]', msg);
    res.status(500).json({ error: msg });
  });
  return router;
}
