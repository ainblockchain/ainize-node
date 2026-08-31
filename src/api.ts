/**
 * HTTP API of a marketplace node (Express 5).
 *  /api/*   public catalog + operator console (cookie session)
 *  /x402/*  trading endpoints (HTTP 402 Payment Required flow, ain-js compatible)
 *  /p2p/*   peer protocol (hello, peers, records, blobs)
 */
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import express, { type Request, type Response, type NextFunction, type Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import {
  AinLedger, sha256Hex, verifyPassword, hashPassword, X402_HEADER_PAYMENT, X402_HEADER_REQUIRED, X402_HEADER_TX, X402_HEADER_CURRENCY,
  type LedgerRecord, type PatchAnchor,
} from '@ngram/core';
import { verifyAuthHeader } from './p2p.js';
import type { Market } from './market.js';
import type { Verifier } from './verifier.js';
import type { Drive } from './drive.js';
import { buildOpenApi, CLI_REFERENCE } from './openapi.js';

export interface ApiDeps { market: Market; verifier: Verifier | null; drive?: Drive; saveConfig: () => void; }

class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
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
  router.get('/api/openapi.json', wrap(async () => buildOpenApi(market.publicUrl, market.cfg.version)));
  router.get('/api/docs', wrap(async () => ({ openapi: buildOpenApi(market.publicUrl, market.cfg.version), cli: CLI_REFERENCE, node: market.publicUrl })));

  // ------------------------------------------------------------ public info & catalog
  router.get('/api/info', wrap(async () => ({
    node: await (async () => { await market.catalog(); return market.selfInfo(); })(), ledger: await market.ledger.info(), runtime: await market.runtime.status(),
    quorum: market.cfg.verifier?.quorum ?? 2, currency: market.cfg.market.currency, peers: market.p2p.peers().length,
    initial_credit: market.cfg.market.initialCredit, royalty_share: market.cfg.market.royaltyShare,
    accepts_contributions: market.acceptsContributions(), contributor_share: market.teach().contributorShare,
    counts: (() => { const c = market.catalogSync(); return { patches: c.length, listed: c.filter((e) => e.status === 'LISTED').length, verifying: c.filter((e) => e.status === 'ANNOUNCED' || e.status === 'VERIFYING').length, superseded: c.filter((e) => e.status === 'SUPERSEDED').length, rejected: c.filter((e) => e.status === 'REJECTED').length }; })(),
  })));

  router.get('/api/catalog', wrap(async (req) => {
    const q = z.object({
      sort: z.enum(['latest', 'popular', 'price', 'rows']).default('latest'),
      status: z.string().optional(), model: z.string().optional(), schema: z.string().optional(), branch: z.string().optional(),
      author: z.string().optional(), contributor: z.string().optional(), origin: z.enum(['operator', 'teach']).optional(), q: z.string().optional(),
      limit: z.coerce.number().min(1).max(200).default(50), offset: z.coerce.number().min(0).default(0),
      include_drafts: z.coerce.boolean().default(false),
    }).parse(req.query);
    let items = await market.catalog();
    if (!q.include_drafts || !isOperator(req)) items = items.filter((e) => e.status !== 'DRAFT');
    if (q.status) items = items.filter((e) => q.status!.split(',').includes(e.status));
    if (q.model) items = items.filter((e) => e.anchor.model.id_M === q.model);
    if (q.schema) items = items.filter((e) => e.anchor.benchmark.schema === q.schema);
    if (q.author) items = items.filter((e) => e.anchor.author === q.author);
    if (q.contributor) { const c = q.contributor.toLowerCase(); items = items.filter((e) => (e.anchor.contributors ?? []).some((x) => x.address.toLowerCase() === c)); }
    if (q.origin) items = items.filter((e) => (e.anchor.origin ?? 'operator') === q.origin);
    if (q.branch) { const b = (await market.branches()).find((x) => x.name === q.branch); items = items.filter((e) => b?.patch_ids.includes(e.anchor.id)); }
    if (q.q) { const s = q.q.toLowerCase(); items = items.filter((e) => [e.anchor.id, e.anchor.name, e.anchor.description, e.anchor.model.id_M, e.anchor.benchmark.schema].join(' ').toLowerCase().includes(s)); }
    const sorters = {
      latest: (a: typeof items[0], b: typeof items[0]) => b.anchor.created_at - a.anchor.created_at,
      popular: (a: typeof items[0], b: typeof items[0]) => b.downloads - a.downloads || b.passed - a.passed,
      price: (a: typeof items[0], b: typeof items[0]) => Number(a.anchor.price) - Number(b.anchor.price),
      rows: (a: typeof items[0], b: typeof items[0]) => b.anchor.rows - a.anchor.rows,
    };
    items = [...items].sort(sorters[q.sort]);
    const total = items.length;
    const page = items.slice(q.offset, q.offset + q.limit).map((e) => ({ ...e, attestations: e.attestations.map((a) => ({ ...a, sig: undefined })) }));
    return { total, items: page, models: [...new Set((await market.catalog()).map((e) => e.anchor.model.id_M))], schemas: [...new Set((await market.catalog()).map((e) => e.anchor.benchmark.schema))] };
  }));

  router.get('/api/patches/:id', wrap(async (req) => {
    const e = await market.entry(req.params.id as string);
    if (!e || (e.status === 'DRAFT' && !isOperator(req))) throw notFound('patch not found');
    const map = await market.entryMap();
    const lineage = { parents: e.anchor.parents.map((p) => map.get(p)).filter(Boolean).map((x) => ({ id: x!.anchor.id, name: x!.anchor.name, author: x!.anchor.author, status: x!.status })),
      children: e.children.map((c) => map.get(c)).filter(Boolean).map((x) => ({ id: x!.anchor.id, name: x!.anchor.name, author: x!.anchor.author, status: x!.status })) };
    const conflicts = await market.conflicts(e.anchor.id).catch(() => []);
    const branches = (await market.branches()).filter((b) => b.patch_ids.includes(e.anchor.id)).map((b) => ({ name: b.name, context: b.context }));
    return {
      ...e, lineage, conflicts, branches,
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

  router.get('/api/patches/:id/events', wrap(async (req) => ({ events: market.store.events({ patch_id: req.params.id as string, limit: Number(req.query.limit ?? 200) }) })));

  router.get('/api/benchmarks/:schema', wrap(async (req) => {
    const schema = req.params.schema as string;
    const items = (await market.catalog()).filter((e) => e.anchor.benchmark.schema === schema && e.status !== 'DRAFT');
    if (!items.length) throw notFound('no patches for that benchmark schema');
    return { schema, items };
  }));

  router.get('/api/ledger', wrap(async (req) => {
    const q = z.object({ since: z.coerce.number().optional(), kind: z.string().optional(), limit: z.coerce.number().max(1000).default(200) }).parse(req.query);
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
  router.get('/api/nodes', wrap(async () => ({ nodes: await market.knownNodes(), peers: market.p2p.peers(), self: market.address })));
  router.get('/api/events', wrap(async (req) => ({ events: market.store.events({ since: req.query.since ? Number(req.query.since) : undefined, limit: Number(req.query.limit ?? 200), kind: req.query.kind as string | undefined }) })));
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
    return { ...(await market.chainStatus()), sales, royalties, purchases: market.store.listPurchases().length };
  }));

  router.post('/api/patches', requireOperator, upload.single('file'), wrap(async (req) => {
    const body = z.object({
      id: z.string().optional(), name: z.string().min(2), description: z.string().optional(), model_id: z.string().min(1),
      benchmark: z.string().transform((s) => JSON.parse(s)).or(z.object({}).passthrough()), price: z.string().optional(),
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
      name: z.string().min(2).optional(), description: z.string().optional(), price: z.string().optional(), branch: z.string().optional(),
      benchmark: z.object({}).passthrough().optional(), license: z.string().optional(), billing: z.enum(['per_download', 'per_apply_hour', 'per_hit']).optional(),
      topic_path: z.string().optional(), visibility: z.enum(['public', 'test']).optional(), origin: z.enum(['operator', 'teach']).optional(),
      contributors: z.array(z.object({}).passthrough()).nullable().optional(),
    }).parse(req.body ?? {});
    return { anchor: market.updateDraft(req.params.id as string, { ...patch, contributors: patch.contributors ?? undefined } as never) };
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
  router.get('/api/patches/:id/conflicts', wrap(async (req) => ({ conflicts: await market.conflicts(req.params.id as string) })));

  router.post('/api/branches', requireOperator, wrap(async (req) => {
    const b = z.object({ name: z.string(), description: z.string().default(''), context: z.record(z.string(), z.string()).default({}), patch_ids: z.array(z.string()).default([]) }).parse(req.body);
    return { branch: await market.createBranch(b.name, b.description, b.context, b.patch_ids) };
  }));
  router.post('/api/branches/:name/patches', requireOperator, wrap(async (req) => ({ branch: await market.addToBranch(decodeURIComponent(req.params.name as string), String(req.body.patch_id)) })));
  router.post('/api/branches/:name/subscribe', requireOperator, wrap(async (req) => { await market.subscribe(decodeURIComponent(req.params.name as string), 'subscribe'); return { ok: true }; }));
  router.post('/api/branches/:name/unsubscribe', requireOperator, wrap(async (req) => { await market.subscribe(decodeURIComponent(req.params.name as string), 'unsubscribe'); return { ok: true }; }));

  router.post('/api/runtime/complete', requireOperator, wrap(async (req) => {
    const { prompt, max_tokens } = z.object({ prompt: z.string().min(1).max(2000), max_tokens: z.coerce.number().min(1).max(256).default(16) }).parse(req.body);
    return { text: await market.runtime.complete(prompt, max_tokens) };
  }));
  router.get('/api/runtime', wrap(async () => ({ ...(await market.runtime.status(true)), applied: market.store.listApplied() })));

  router.post('/api/peers', requireOperator, wrap(async (req) => { market.p2p.addPeer(String(req.body.endpoint)); market.cfg.peers = [...new Set([...market.cfg.peers, String(req.body.endpoint)])]; deps.saveConfig(); return { ok: true }; }));
  router.delete('/api/peers', requireOperator, wrap(async (req) => { market.p2p.removePeer(String(req.body.endpoint)); market.cfg.peers = market.cfg.peers.filter((p) => p !== req.body.endpoint); deps.saveConfig(); return { ok: true }; }));
  router.post('/api/chain/setup', requireOperator, wrap(async () => {
    if (!(market.ledger instanceof AinLedger)) throw bad('node is not on the AIN ledger');
    return market.ledger.setupApp();
  }));

  // ------------------------------------------------------------ ChatMode (live test)
  router.get('/api/chat/patches', wrap(async () => ({ items: await market.testablePatches(), runtime: await market.runtime.status(), lock: market.runtime.lockHolder() })));
  router.post('/api/chat', wrap(async (req) => {
    const body = z.object({
      patch_id: z.string(), mode: z.enum(['base', 'patched', 'compare']).default('compare'),
      messages: z.array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string().min(1).max(4000) })).min(1).max(24),
      max_tokens: z.coerce.number().min(1).max(1024).default(200), thinking: z.boolean().default(false),
    }).parse(req.body);
    const operator = isOperator(req);
    const visitor = operator ? `operator:${market.address}` : `ip:${req.ip}`;
    // check (without consuming) first; a failed/hung request must not burn a free try
    if (!operator && market.chatQuota(visitor, 20, 3600_000, false) < 0) throw new HttpError(429, 'free live-test quota exhausted for this hour — buy the patch or run your own node');
    const out = await market.chat({ ...body, patchId: body.patch_id, visitor });
    const remaining = operator ? Infinity : market.chatQuota(visitor);
    return { ...out, remaining_quota: Number.isFinite(remaining) ? remaining : null, quota_limit: operator ? null : 20 };
  }));
  router.get('/api/me/settings', requireOperator, wrap(async () => ({ settings: market.settings() })));
  router.patch('/api/me/settings', requireOperator, wrap(async (req) => {
    const patch = z.object({ notifications: z.enum(['all', 'sales', 'none']).optional(), display_name: z.string().min(1).max(64).optional(), payout_address: z.string().optional() }).parse(req.body);
    const settings = market.updateSettings(patch);
    deps.saveConfig();
    return { settings };
  }));

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
    if (!e || !e.quorum_ok) { await market.refreshLedger(); e = await market.entry(id); }
    if (!e || e.status === 'DRAFT') throw notFound('patch not found');
    if (e.anchor.author !== market.address) throw new HttpError(409, `not sold here; gateway is ${(e.anchor as PatchAnchor & { gateway_url?: string }).gateway_url ?? 'unknown'}`);
    if (!e.quorum_ok) throw new HttpError(423, `patch not listed yet (verification ${e.passed}/${e.quorum})`);
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
    res.status(200).set({ 'content-type': 'application/octet-stream', 'content-length': String(size), 'x-content-sha256': sha, 'content-disposition': `attachment; filename="${sha}.npz"` });
    createReadStream(blob.path).pipe(res);
  }));

  // ------------------------------------------------------------ errors
  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'invalid request', issues: err.issues });
    const msg = (err as Error)?.message ?? String(err);
    console.error('[api]', msg);
    res.status(500).json({ error: msg });
  });
  return router;
}
