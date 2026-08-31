/**
 * Market service — the node's business logic on top of Ledger + Store + BlobStore + Runtime + P2P:
 * drafts → announce (with conflict pre-check) → verification → listing; x402 trading (both schemes);
 * royalties along lineage; branches / subscriptions / gateway routing; purchases & runtime application.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AinLedger, canonicalJson, deriveCatalog, hashCanonical, intersectionCount, royaltySplit, sha256Hex, signMessage, verifyMessage,
  decodePayload, decodeRequirements, encodePayload, encodeRequirements, newNonce,
  X402_HEADER_PAYMENT, X402_HEADER_REQUIRED,
  type Attestation, type BenchmarkSpec, type BranchInfo, type CatalogEntry, type Challenge, type Ledger, type LedgerRecord,
  type NodeConfig, type PatchAnchor, type PatchManifest, type PeerInfo, type Settlement, type X402Payload, type X402Requirement,
  type SubscriptionRecord, type SupersedeRecord,
} from '@ngram/core';
import { BlobStore } from './blobs.js';
import { P2P } from './p2p.js';
import { Runtime, type ChatMessage, type ChatResult } from './runtime.js';
import type { Store, BlobRow, EventRow } from './store.js';

export interface CreateDraftInput {
  id?: string;
  name: string;
  description?: string;
  model?: Partial<PatchAnchor['model']> & { id_M: string };
  benchmark: BenchmarkSpec;
  price?: string;
  billing?: PatchAnchor['billing'];
  license?: string;
  parents?: string[];
  branch?: string;
  topic_path?: string;
  recipe?: PatchAnchor['recipe'];
  file: string;              // local path to .npz (copied into blob store unless `keepInPlace`)
  keepInPlace?: boolean;
  visibility?: 'public' | 'test';
}

export interface ConflictInfo { patch_id: string; overlap_rows: number; same_schema: boolean; status: string; branch?: string; cross_branch: boolean; }

export interface PurchaseResult {
  patch_id: string;
  steps: { step: string; detail: string; at: number }[];
  manifest: PatchManifest;
  path: string;
  tx_hash: string;
  amount: string;
  scheme: string;
}

const SLUG = /^[a-z0-9][a-z0-9._-]{1,63}$/;

export class Market {
  private catalogCache: { at: number; value: CatalogEntry[] } | null = null;
  p2p!: P2P;
  /** aindrive mirror (set by server.ts). */
  drive?: { sync(): Promise<{ written: number }>; pullDraftEdits(e: CatalogEntry): boolean };
  constructor(
    readonly cfg: NodeConfig,
    readonly ledger: Ledger,
    readonly store: Store,
    readonly blobs: BlobStore,
    readonly runtime: Runtime,
  ) {}

  get address() { return this.cfg.identity.address; }
  get publicUrl() { return this.cfg.publicUrl ?? `http://localhost:${this.cfg.port}`; }

  log(level: EventRow['level'], kind: string, message: string, patchId: string | null = null, data: unknown = null) {
    this.store.event(level, kind, message, patchId, data);
    const line = `[${new Date().toISOString()}] ${level.toUpperCase().padEnd(5)} ${kind}: ${message}`;
    if (level === 'error' || level === 'warn') console.error(line); else console.log(line);
  }

  invalidate() { this.catalogCache = null; }

  /** Force a re-read of the shared ledger (AIN polls every few seconds; call before decisions that must be fresh). */
  async refreshLedger(): Promise<void> {
    const l = this.ledger as Ledger & { refresh?: () => Promise<void> };
    if (typeof l.refresh === 'function') await l.refresh().catch(() => undefined);
    this.invalidate();
  }

  // ------------------------------------------------------------------ catalog
  /** Last computed public catalog (cache; call catalog() first in the same request). */
  catalogSync(): CatalogEntry[] { return (this.catalogCache?.value ?? []).filter((e) => e.anchor.visibility !== 'test' || this.cfg.includeTestAnchors); }

  /** Public catalog (test-visibility anchors hidden). */
  async catalog(force = false): Promise<CatalogEntry[]> {
    return (await this.catalogAll(force)).filter((e) => e.anchor.visibility !== 'test' || this.cfg.includeTestAnchors);
  }

  async catalogAll(force = false): Promise<CatalogEntry[]> {
    if (!force && this.catalogCache && Date.now() - this.catalogCache.at < 1500) return this.catalogCache.value;
    const [anchors, atts, setts, chals, sups] = await Promise.all([
      this.ledger.anchors(), this.ledger.attestations(), this.ledger.settlements(), this.ledger.challenges(), this.ledger.supersedes(),
    ]);
    // Only well-formed anchors/attestations enter the catalog — nothing is synthesised or defaulted server-side.
    const wellFormed = anchors.filter((r) => Market.isAnchor(r.body)) as LedgerRecord<PatchAnchor>[];
    const wellFormedAtts = atts.filter((r) => Market.isAttestation(r.body));
    const drafts = this.store.listDrafts().map((d) => d.anchor);
    const value = deriveCatalog(wellFormed, wellFormedAtts, setts, chals, sups, this.cfg.verifier?.quorum ?? 2, drafts);
    // Legacy prototype anchors carry no size/rows — fill them in when we hold the very same body (sha256 match).
    for (const e of value) {
      if (e.anchor.rows === 0 || e.anchor.size_bytes === 0) {
        const b = this.blobs.get(e.anchor.patch_sha256);
        if (b) { e.anchor.rows = b.rows; e.anchor.size_bytes = b.size_bytes; e.anchor.model.row_dim ??= b.row_dim; }
      }
    }
    this.catalogCache = { at: Date.now(), value };
    return value;
  }

  static isAnchor(b: unknown): b is PatchAnchor {
    const x = b as Partial<PatchAnchor> | null;
    return !!x && typeof x.id === 'string' && typeof x.patch_sha256 === 'string' && typeof x.author === 'string' && !!x.model && typeof x.model.id_M === 'string'
      && !!x.benchmark && typeof x.benchmark.schema === 'string' && typeof x.price === 'string' && Array.isArray(x.parents);
  }

  static isAttestation(b: unknown): b is Attestation {
    const x = b as Partial<Attestation> | null;
    return !!x && typeof x.patch_id === 'string' && typeof x.verifier === 'string' && typeof x.passed === 'boolean' && typeof x.verified_on === 'string';
  }

  /** Lookup by id — includes test-visibility anchors (they are hidden from listings, not from direct access). */
  async entry(id: string): Promise<CatalogEntry | null> {
    return (await this.catalogAll()).find((e) => e.anchor.id === id) ?? null;
  }

  async entryMap(): Promise<Map<string, CatalogEntry>> {
    return new Map((await this.catalog()).map((e) => [e.anchor.id, e]));
  }

  // ------------------------------------------------------------------ drafts / publish
  async createDraft(input: CreateDraftInput): Promise<PatchAnchor> {
    const id = (input.id ?? input.name).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
    if (!SLUG.test(id)) throw new Error('invalid patch id (use 2-64 chars: a-z 0-9 . _ -)');
    if (await this.entry(id)) throw new Error(`patch id already exists: ${id}`);
    const { blob, sketch } = await this.blobs.importFile(input.file, { copy: !input.keepInPlace });
    const benchmark: BenchmarkSpec = { ...input.benchmark, format: input.benchmark.format ?? ['template'] };
    const parents = (input.parents ?? []).filter(Boolean);
    const map = await this.entryMap();
    for (const p of parents) if (!map.has(p)) throw new Error(`unknown parent patch: ${p}`);
    const anchor: PatchAnchor = {
      id, name: input.name, description: input.description ?? '', author: this.address, author_name: this.cfg.name,
      model: { row_dim: blob.row_dim, ...input.model } as PatchAnchor['model'],
      patch_sha256: blob.sha256, size_bytes: blob.size_bytes, rows: blob.rows,
      benchmark, benchmark_hash: hashCanonical({ schema: benchmark.schema, queries: benchmark.queries, format: benchmark.format, collateral_bound_nat: benchmark.collateral_bound_nat, samples: benchmark.samples ?? [] }),
      price: input.price ?? this.cfg.market.defaultPrice, currency: this.cfg.market.currency, billing: input.billing ?? 'per_download',
      license: input.license, parents, parent_authors: parents.map((p) => map.get(p)!.anchor.author),
      branch: input.branch, topic_path: input.topic_path ?? `patches/${(input.model?.id_M ?? 'model').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      recipe: input.recipe, created_at: Date.now(), addr_sketch: sketch, visibility: input.visibility ?? 'public',
    };
    this.store.putDraft(anchor, blob.path);
    this.invalidate();
    this.log('info', 'patch', `draft created: ${id} (${blob.rows} rows, ${(blob.size_bytes / 1e6).toFixed(1)} MB)`, id);
    return anchor;
  }

  updateDraft(id: string, patch: Partial<Pick<PatchAnchor, 'name' | 'description' | 'price' | 'branch' | 'benchmark' | 'license' | 'billing' | 'topic_path'>>): PatchAnchor {
    const d = this.store.getDraft(id);
    if (!d) throw new Error('only drafts can be edited (anchors are immutable on the ledger)');
    const anchor = { ...d.anchor, ...patch };
    if (patch.benchmark) anchor.benchmark_hash = hashCanonical({ schema: anchor.benchmark.schema, queries: anchor.benchmark.queries, format: anchor.benchmark.format, collateral_bound_nat: anchor.benchmark.collateral_bound_nat, samples: anchor.benchmark.samples ?? [] });
    this.store.putDraft(anchor, d.file_path);
    this.invalidate();
    return anchor;
  }

  deleteDraft(id: string) {
    const d = this.store.getDraft(id);
    if (!d) throw new Error('draft not found');
    this.store.deleteDraft(id);
    this.invalidate();
    this.log('info', 'patch', `draft deleted: ${id}`, id);
  }

  /** Address-set overlap against every patch whose body we hold (도 6 / 청구항 10). */
  async conflicts(id: string): Promise<ConflictInfo[]> {
    const map = await this.entryMap();
    const me = map.get(id);
    if (!me) return [];
    const mine = this.blobs.addrSet(me.anchor.patch_sha256);
    if (!mine) return [];
    const out: ConflictInfo[] = [];
    for (const e of map.values()) {
      if (e.anchor.id === id) continue;
      const set = this.blobs.addrSet(e.anchor.patch_sha256);
      if (!set) continue;
      const n = intersectionCount(mine, set);
      if (n > 0) out.push({
        patch_id: e.anchor.id, overlap_rows: n, same_schema: e.anchor.benchmark.schema === me.anchor.benchmark.schema, status: e.status, branch: e.anchor.branch,
        // contradictory knowledge kept on different branches coexists (청구항 17) — never a supersede candidate
        cross_branch: !!(e.anchor.branch && me.anchor.branch && e.anchor.branch !== me.anchor.branch),
      });
    }
    return out.sort((a, b) => b.overlap_rows - a.overlap_rows);
  }

  /** DRAFT → ANNOUNCED: pre-checks, anchor record (gateway_url = this node's x402 endpoint), broadcast. */
  async announce(id: string): Promise<LedgerRecord<PatchAnchor>> {
    const draftEntry = await this.entry(id);
    if (draftEntry && this.drive) this.drive.pullDraftEdits(draftEntry);
    const d = this.store.getDraft(id);
    if (!d) throw new Error('draft not found');
    const blob = this.blobs.get(d.anchor.patch_sha256);
    if (!blob) throw new Error('patch body missing from blob store');
    if (!d.anchor.benchmark.schema) throw new Error('benchmark.schema is required');
    const conflicts = await this.conflicts(id);
    const anchor: PatchAnchor & { gateway_url: string } = { ...d.anchor, gateway_url: `${this.publicUrl}/x402/patch/${id}`, created_at: Date.now() };
    const rec = await this.ledger.append('anchor', anchor);
    this.store.deleteDraft(id);
    this.store.set(`pending_supersede:${id}`, JSON.stringify(conflicts.filter((c) => c.same_schema && !c.cross_branch && ['LISTED', 'VERIFYING', 'ANNOUNCED'].includes(c.status))));
    this.invalidate();
    this.log('info', 'publish', `announced ${id} (conflicts: ${conflicts.length})`, id, { conflicts });
    await this.p2p?.broadcast(rec).catch(() => undefined);
    return rec;
  }

  async attest(att: Attestation): Promise<void> {
    const rec = await this.ledger.append('attest', att);
    this.invalidate();
    this.log('info', 'verify', `attested ${att.patch_id}: ${att.passed ? 'PASS' : 'FAIL'} (${att.verified_on})`, att.patch_id, att.score);
    await this.p2p?.broadcast(rec).catch(() => undefined);
    await this.reconcileSupersedes().catch(() => undefined);
  }

  async challenge(patchId: string, reason: string): Promise<void> {
    const c: Challenge = { patch_id: patchId, challenger: this.address, reason, stake: this.cfg.verifier?.stake ?? '0', created_at: Date.now() };
    const rec = await this.ledger.append('challenge', c);
    this.invalidate();
    this.log('warn', 'challenge', `challenged ${patchId}: ${reason}`, patchId);
    await this.p2p?.broadcast(rec).catch(() => undefined);
  }

  /** When one of our announced patches gets LISTED and overlapped an older same-schema patch, mark supersede (§14 [0072]). */
  async reconcileSupersedes(): Promise<void> {
    const cat = await this.catalog(true);
    for (const e of cat) {
      if (e.anchor.author !== this.address || e.status !== 'LISTED') continue;
      const raw = this.store.get(`pending_supersede:${e.anchor.id}`);
      if (!raw) continue;
      const pending = JSON.parse(raw) as ConflictInfo[];
      for (const c of pending) {
        const s: SupersedeRecord = { old_patch_id: c.patch_id, new_patch_id: e.anchor.id, overlap_rows: c.overlap_rows, reason: 'newer patch on same benchmark schema overlaps address set' };
        const rec = await this.ledger.append('supersede', s);
        await this.p2p?.broadcast(rec).catch(() => undefined);
        this.log('info', 'publish', `${e.anchor.id} supersedes ${c.patch_id} (${c.overlap_rows} shared rows)`, e.anchor.id);
      }
      this.store.set(`pending_supersede:${e.anchor.id}`, '[]');
    }
    this.invalidate();
  }

  // ------------------------------------------------------------------ blobs
  /** Make sure we hold the body for an anchor (author/verifier/purchaser path). */
  async ensureBlob(anchor: PatchAnchor, token?: string): Promise<BlobRow> {
    const have = this.blobs.get(anchor.patch_sha256);
    if (have) return have;
    const dest = this.blobs.pathFor(anchor.patch_sha256);
    const holders = this.p2p.holders(anchor.patch_sha256);
    const gw = (anchor as PatchAnchor & { gateway_url?: string }).gateway_url;
    if (gw) { try { holders.unshift(new URL(gw).origin); } catch { /* ignore */ } }
    const from = await this.p2p.fetchBlob(anchor.patch_sha256, dest, [...new Set(holders)], token);
    const { blob } = await this.blobs.importFile(dest, { expectSha: anchor.patch_sha256 });
    this.log('info', 'blob', `fetched ${anchor.id} body from ${from} (${(blob.size_bytes / 1e6).toFixed(1)} MB, sha ok)`, anchor.id);
    return blob;
  }

  /** May `address` download blob `sha`? author, any registered verifier, or a settled buyer. */
  async mayDownload(sha: string, address: string | null, token?: string): Promise<boolean> {
    if (token && this.store.checkToken(token, sha)) return true;
    if (!address) return false;
    const cat = await this.catalog();
    const entries = cat.filter((e) => e.anchor.patch_sha256 === sha);
    if (entries.some((e) => e.anchor.author === address)) return true;
    if (entries.some((e) => e.settlements.some((s) => s.buyer === address))) return true;
    const nodes = await this.ledger.nodes();
    if (nodes.some((n) => n.body.address === address && n.body.roles.includes('verifier'))) return true;
    if (this.store.listPeers().some((p) => p.address === address && p.info?.roles.includes('verifier'))) return true;
    return false;
  }

  // ------------------------------------------------------------------ x402 (seller side)
  requirementsFor(entry: CatalogEntry, resource: string): X402Requirement[] {
    const nonce = newNonce();
    const scheme = this.ledger.kind === 'ain' ? 'ain-transfer' : 'local-credit';
    this.store.putNonce(nonce, resource, entry.anchor.price, this.address, 10 * 60_000);
    return [{
      scheme, network: this.ledger.kind === 'ain' ? 'ain:local' : 'local', asset: this.ledger.kind === 'ain' ? 'AIN' : 'CREDIT',
      payTo: this.address, maxAmountRequired: entry.anchor.price, resource,
      description: `Knowledge patch ${entry.anchor.id} (${entry.anchor.rows} rows, ${entry.anchor.model.id_M})`,
      nonce, expires_at: Date.now() + 10 * 60_000,
    }];
  }

  /** Local-credit balance = initial credit + received − paid, derived from settlements (dev money). */
  async creditBalance(address: string): Promise<number> {
    const setts = await this.ledger.settlements();
    let bal = Number(this.cfg.market.initialCredit);
    for (const s of setts) {
      if (s.body.scheme !== 'local-credit') continue;
      if (s.body.buyer === address) bal -= Number(s.body.amount);
      for (const [addr, amt] of Object.entries(s.body.royalty)) if (addr === address) bal += Number(amt);
    }
    return Math.round(bal * 1e6) / 1e6;
  }

  static intentHash(p: { resource: string; amount: string; nonce: string; payTo: string; from: string }): string {
    return sha256Hex(canonicalJson({ resource: p.resource, amount: p.amount, nonce: p.nonce, payTo: p.payTo, from: p.from }));
  }

  /** Verify an X-PAYMENT payload for `entry`; on success record a settlement and return it. */
  async settlePayment(entry: CatalogEntry, resource: string, header: string | undefined): Promise<{ settlement: Settlement; error?: undefined } | { settlement?: undefined; error: string }> {
    const payload = decodePayload(header);
    if (!payload) return { error: 'missing or malformed X-PAYMENT' };
    if (entry.anchor.author !== this.address) return { error: 'this node does not sell that patch' };
    const price = Number(entry.anchor.price);
    let buyer = '';
    let txHash = '';
    let scheme = payload.scheme;
    if (payload.scheme === 'local-credit') {
      if (!payload.nonce || !payload.from || !payload.proof) return { error: 'local-credit payload needs nonce, from, proof' };
      const n = this.store.takeNonce(payload.nonce);
      if (!n || n.resource !== resource) return { error: 'unknown or expired nonce' };
      if (Number(payload.amount) < price) return { error: 'amount below price' };
      const h = Market.intentHash({ resource, amount: payload.amount!, nonce: payload.nonce, payTo: this.address, from: payload.from });
      if (!verifyMessage(h, payload.proof, payload.from)) return { error: 'invalid payment signature' };
      if (this.store.paymentSeen(h)) return { error: 'payment already used' };
      const bal = await this.creditBalance(payload.from);
      if (bal < price) return { error: `insufficient credit: ${bal} < ${price}` };
      buyer = payload.from; txHash = h;
    } else if (payload.scheme === 'ain-transfer') {
      if (!(this.ledger instanceof AinLedger)) return { error: 'this node does not accept AIN payments' };
      if (!payload.txHash) return { error: 'ain-transfer payload needs txHash' };
      if (this.store.paymentSeen(payload.txHash)) return { error: 'payment already used' };
      let tr = await this.ledger.verifyTransfer(payload.txHash);
      for (let i = 0; !tr && i < 5; i++) { await new Promise((r) => setTimeout(r, 1200)); tr = await this.ledger.verifyTransfer(payload.txHash); }
      if (!tr) return { error: 'transfer not found / not executed' };
      if (tr.to !== this.address) return { error: `transfer recipient ${tr.to} is not the seller` };
      if (tr.value < price) return { error: `transfer ${tr.value} below price ${price}` };
      buyer = tr.from; txHash = payload.txHash;
    } else {
      return { error: `unsupported scheme ${String(scheme)}` };
    }
    const map = await this.entryMap();
    const royalty = royaltySplit(entry, map, price, this.cfg.market.royaltyShare);
    const settlement: Settlement = {
      patch_id: entry.anchor.id, seller: this.address, buyer, amount: String(price), currency: entry.anchor.currency, scheme,
      tx_hash: txHash, royalty, billing: entry.anchor.billing, created_at: Date.now(),
    };
    this.store.markPayment(txHash, entry.anchor.id);
    const rec = await this.ledger.append('settle', settlement);
    this.invalidate();
    this.log('info', 'trade', `sold ${entry.anchor.id} to ${buyer.slice(0, 10)}… for ${price} ${settlement.currency} (${scheme})`, entry.anchor.id, { royalty, tx: txHash });
    await this.p2p?.broadcast(rec).catch(() => undefined);
    // Pay lineage royalties on-chain (AIN) — best effort, recorded in events.
    if (this.ledger instanceof AinLedger) {
      for (const [addr, amt] of Object.entries(royalty)) {
        if (addr === this.address || Number(amt) <= 0) continue;
        this.ledger.transfer(addr, Number(amt)).then((r) => this.log('info', 'royalty', `paid ${amt} AIN royalty to ${addr.slice(0, 10)}… (${r.tx_hash.slice(0, 12)})`, entry.anchor.id))
          .catch((e) => this.log('warn', 'royalty', `royalty transfer to ${addr} failed: ${(e as Error).message}`, entry.anchor.id));
      }
    }
    return { settlement };
  }

  /** The gated content: a manifest (text) whose sha256 is what ain-js verifies against the on-chain content_hash. */
  issueManifest(entry: CatalogEntry, buyer: string): PatchManifest {
    const token = randomBytes(24).toString('hex');
    this.store.putToken(token, entry.anchor.patch_sha256, buyer, 24 * 3600_000);
    const holders = this.p2p ? this.p2p.holders(entry.anchor.patch_sha256) : [];
    return {
      id: entry.anchor.id, patch_sha256: entry.anchor.patch_sha256, size_bytes: entry.anchor.size_bytes, rows: entry.anchor.rows,
      model: entry.anchor.model, benchmark_hash: entry.anchor.benchmark_hash,
      blob_urls: [`${this.publicUrl}/p2p/blob/${entry.anchor.patch_sha256}`, ...holders.map((h) => `${h}/p2p/blob/${entry.anchor.patch_sha256}`)],
      issued_to: buyer, issued_at: Date.now(), download_token: token,
    };
  }

  // ------------------------------------------------------------------ x402 (buyer side: this node buys)
  async buy(patchId: string, opts: { apply?: boolean } = {}): Promise<PurchaseResult> {
    const steps: PurchaseResult['steps'] = [];
    const step = (s: string, d: string) => { steps.push({ step: s, detail: d, at: Date.now() }); this.log('info', 'buy', `${s}: ${d}`, patchId); };
    let entry = await this.entry(patchId);
    if (entry && !entry.quorum_ok) { await this.refreshLedger(); entry = await this.entry(patchId); }
    if (!entry) throw new Error('patch not found');
    if (!entry.quorum_ok) throw new Error(`verification quorum not met (${entry.passed}/${entry.quorum}) — refusing to buy`);
    step('quorum', `${entry.passed} attestation(s) ≥ quorum ${entry.quorum}`);
    const gw = (entry.anchor as PatchAnchor & { gateway_url?: string }).gateway_url ?? `${this.publicUrl}/x402/patch/${patchId}`;
    const r1 = await fetch(gw, { headers: { 'x-ngram-buyer': this.address }, signal: AbortSignal.timeout(30_000) });
    let manifest: PatchManifest;
    let txHash = '';
    let amount = entry.anchor.price;
    let scheme = 'free';
    if (r1.status === 402) {
      const reqs = decodeRequirements(r1.headers.get(X402_HEADER_REQUIRED), await r1.json().catch(() => ({})));
      const req = reqs.find((q) => q.scheme === (this.ledger.kind === 'ain' ? 'ain-transfer' : 'local-credit')) ?? reqs[0];
      if (!req) throw new Error('402 without payment requirements');
      step('402', `Payment Required: ${req.maxAmountRequired} ${req.asset} → ${req.payTo.slice(0, 10)}… (${req.scheme})`);
      let payload: X402Payload;
      if (req.scheme === 'ain-transfer') {
        if (!(this.ledger instanceof AinLedger)) throw new Error('seller wants AIN but this node runs the local ledger');
        const t = await this.ledger.transfer(req.payTo, Number(req.maxAmountRequired));
        payload = { scheme: 'ain-transfer', network: req.network, txHash: t.tx_hash, from: this.address, to: req.payTo, amount: req.maxAmountRequired, nonce: req.nonce };
        step('pay', `AIN transfer tx ${t.tx_hash.slice(0, 14)}…`);
      } else {
        const h = Market.intentHash({ resource: req.resource, amount: req.maxAmountRequired, nonce: req.nonce, payTo: req.payTo, from: this.address });
        payload = { scheme: 'local-credit', network: 'local', txHash: h, from: this.address, to: req.payTo, amount: req.maxAmountRequired, nonce: req.nonce, proof: signMessage(h, this.cfg.identity.privateKey) };
        step('pay', `signed credit intent ${h.slice(0, 14)}…`);
      }
      const r2 = await fetch(gw, { headers: { [X402_HEADER_PAYMENT]: encodePayload(payload), 'x-ngram-buyer': this.address }, signal: AbortSignal.timeout(60_000) });
      if (!r2.ok) throw new Error(`payment rejected: ${r2.status} ${await r2.text()}`);
      const text = await r2.text();
      manifest = JSON.parse(text) as PatchManifest;
      txHash = r2.headers.get('x-payment-tx-hash') ?? payload.txHash;
      amount = req.maxAmountRequired; scheme = req.scheme;
      step('settled', `seller confirmed; manifest sha256 ${sha256Hex(text).slice(0, 14)}…`);
    } else if (r1.ok) {
      manifest = (await r1.json()) as PatchManifest;
      step('free', 'no payment required');
    } else {
      throw new Error(`gateway error ${r1.status}`);
    }
    const dest = this.blobs.pathFor(manifest.patch_sha256);
    const origins = manifest.blob_urls.map((u) => { try { return new URL(u).origin; } catch { return ''; } }).filter(Boolean);
    if (!this.blobs.has(manifest.patch_sha256)) {
      const from = await this.p2p.fetchBlob(manifest.patch_sha256, dest, origins, manifest.download_token);
      const { blob } = await this.blobs.importFile(dest, { expectSha: manifest.patch_sha256 });
      step('download', `${(blob.size_bytes / 1e6).toFixed(1)} MB from ${from}; sha256 matches on-ledger anchor`);
    } else {
      step('download', 'body already present; sha256 matches on-ledger anchor');
    }
    const path = this.blobs.get(manifest.patch_sha256)!.path;
    this.store.putPurchase({ patch_id: patchId, sha256: manifest.patch_sha256, tx_hash: txHash, scheme, amount, manifest, path, created_at: Date.now() });
    if (this.ledger instanceof AinLedger && scheme === 'ain-transfer') {
      const tx = await this.ledger.recordAccess(entry.anchor as PatchAnchor & { entry_id?: string }, amount, entry.anchor.currency, txHash).catch((e) => { this.log('warn', 'buy', `access receipt failed: ${(e as Error).message}`, patchId); return null; });
      if (tx) step('receipt', `on-chain access receipt written (/apps/knowledge/access/…, tx ${tx.slice(0, 12)}…)`);
    }
    if (opts.apply) {
      const res = await this.applyPatch(patchId, 'purchase');
      step('apply', res);
    }
    return { patch_id: patchId, steps, manifest, path, tx_hash: txHash, amount, scheme };
  }

  // ------------------------------------------------------------------ runtime
  isApplied(patchId: string): boolean { return this.store.listApplied().some((a) => a.patch_id === patchId); }

  async applyPatch(patchId: string, reason: string): Promise<string> {
    const entry = await this.entry(patchId);
    if (!entry) throw new Error('patch not found');
    const blob = this.blobs.get(entry.anchor.patch_sha256);
    if (!blob) throw new Error('patch body not present on this node (buy it first)');
    const st = await this.runtime.status();
    if (!st.available) throw new Error(st.error ?? 'runtime unavailable');
    const r = await this.runtime.apply(blob.path);
    if (r.code !== 0) throw new Error(r.err || r.out);
    this.store.setApplied(patchId, blob.sha256, reason);
    this.log('info', 'runtime', `applied ${patchId}: ${r.out}`, patchId);
    return r.out;
  }

  async removePatch(patchId: string): Promise<string> {
    const entry = await this.entry(patchId);
    if (!entry) throw new Error('patch not found');
    const blob = this.blobs.get(entry.anchor.patch_sha256);
    if (!blob) throw new Error('patch body not present');
    const r = await this.runtime.remove(blob.path);
    if (r.code !== 0) throw new Error(r.err || r.out);
    this.store.clearApplied(patchId);
    this.log('info', 'runtime', `removed ${patchId}: ${r.out}`, patchId);
    return r.out;
  }

  /** Watchdog (청구항 3 재적용): re-apply patches that should be applied but reverted (serving restart). */
  async watchdog(): Promise<void> {
    const st = await this.runtime.status();
    if (!st.available) return;
    for (const a of this.store.listApplied()) {
      const blob = this.blobs.get(a.sha256);
      if (!blob) continue;
      const applied = await this.runtime.isApplied(blob.path);
      if (applied === false) {
        this.log('warn', 'runtime', `patch ${a.patch_id} reverted (restart?) → re-applying`, a.patch_id);
        await this.runtime.apply(blob.path).catch(() => undefined);
      }
    }
  }

  // ------------------------------------------------------------------ ChatMode (live test of a knowledge patch)
  private chatUsage = new Map<string, { count: number; window: number }>();

  /** Per-visitor trial quota for public live tests (operator is unlimited). Returns remaining or -1 when exhausted. */
  chatQuota(visitor: string, limit = 20, windowMs = 3600_000, consume = true): number {
    const now = Date.now();
    const u = this.chatUsage.get(visitor);
    const cur = u && now - u.window < windowMs ? u : { count: 0, window: now };
    if (cur.count >= limit) return -1;
    if (consume) { cur.count++; this.chatUsage.set(visitor, cur); }
    return limit - cur.count;
  }

  /**
   * Live test: answer `messages` with the base model and/or with `patchId` applied. Runs under the shared
   * runtime lock: [ensure removed → base answer] → [apply → patched answer] → restore the previous state.
   * Every patched answer is metered as a `hit` usage event (청구항 12 적중당 과금의 계량 단위).
   */
  async chat(opts: { patchId: string; messages: ChatMessage[]; mode: 'base' | 'patched' | 'compare'; maxTokens?: number; thinking?: boolean; visitor: string }): Promise<{
    patch_id: string; mode: string; base: ChatResult | null; patched: ChatResult | null; applied_ms: number | null; was_applied: boolean; model: string | null; benchmark_hit?: boolean | null;
  }> {
    const entry = await this.entry(opts.patchId);
    if (!entry) throw new Error('patch not found');
    const blob = this.blobs.get(entry.anchor.patch_sha256);
    if (!blob) throw new Error('this node does not hold the patch body — buy it first (or test it on the seller node)');
    const st = await this.runtime.status();
    if (!st.available) throw new Error(st.error ?? 'runtime unavailable');
    if (st.model && !entry.anchor.model.id_M.startsWith(st.model)) throw new Error(`patch targets ${entry.anchor.model.id_M} but this node serves ${st.model}`);
    const msgs = opts.messages.slice(-24).map((m) => ({ role: m.role, content: String(m.content).slice(0, 4000) }));
    const chatOpts = { maxTokens: opts.maxTokens ?? 200, thinking: !!opts.thinking };
    return this.runtime.exclusive(`chat:${opts.patchId}`, async () => {
      // NOTE: inside exclusive() use the *Raw variants — apply()/remove() take the same lock and would deadlock.
      const wasApplied = (await this.runtime.isApplied(blob.path)) === true;
      let base: ChatResult | null = null; let patched: ChatResult | null = null; let appliedMs: number | null = null;
      try {
        if (opts.mode === 'base' || opts.mode === 'compare') {
          if (wasApplied) { const r = await this.runtime.removeRaw(blob.path); if (r.code !== 0) throw new Error(r.err || r.out); }
          base = await this.runtime.chat(msgs, chatOpts);
        }
        if (opts.mode === 'patched' || opts.mode === 'compare') {
          if (!wasApplied || opts.mode === 'compare') {
            const t0 = Date.now(); const r = await this.runtime.applyRaw(blob.path); if (r.code !== 0) throw new Error(r.err || r.out); appliedMs = Date.now() - t0;
          }
          patched = await this.runtime.chat(msgs, chatOpts);
        }
      } finally {
        // always leave the shared table the way we found it
        const nowApplied = opts.mode === 'base' ? (wasApplied ? false : false) : true;
        if (wasApplied && !nowApplied) await this.runtime.applyRaw(blob.path).catch((e) => this.log('error', 'runtime', `restore (re-apply) failed after live test: ${(e as Error).message}`, opts.patchId));
        if (!wasApplied && nowApplied) await this.runtime.removeRaw(blob.path).catch((e) => this.log('error', 'runtime', `restore (remove) failed after live test: ${(e as Error).message}`, opts.patchId));
      }
      const lastUser = [...msgs].reverse().find((m) => m.role === 'user')?.content ?? '';
      const sample = entry.anchor.benchmark.samples?.find((x) => lastUser.includes(x.prompt.trim()) || x.prompt.includes(lastUser.trim()));
      const hit = sample && patched ? patched.content.replace(/\s/g, '').includes(sample.expect) : null;
      this.log('info', 'usage', `live test ${opts.patchId} (${opts.mode}) by ${opts.visitor.slice(0, 24)}: ${patched ? 'patched hit=' + hit : 'base only'}`, opts.patchId, { visitor: opts.visitor, mode: opts.mode, hit, base_ms: base?.latency_ms, patched_ms: patched?.latency_ms, applied_ms: appliedMs });
      return { patch_id: opts.patchId, mode: opts.mode, base, patched, applied_ms: appliedMs, was_applied: wasApplied, model: st.model, benchmark_hit: hit };
    });
  }

  /** Patches whose bodies are on this node (testable in ChatMode). */
  async testablePatches(): Promise<CatalogEntry[]> {
    const st = await this.runtime.status();
    return (await this.catalog()).filter((e) => e.status !== 'DRAFT' && this.blobs.has(e.anchor.patch_sha256) && (!st.model || e.anchor.model.id_M.startsWith(st.model)));
  }

  // ------------------------------------------------------------------ branches / network
  async createBranch(name: string, description: string, context: Record<string, string>, patchIds: string[] = []): Promise<BranchInfo> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9/_-]{1,63}$/.test(name)) throw new Error('invalid branch name');
    const b: BranchInfo = { name, description, context, owner: this.address, patch_ids: patchIds, created_at: Date.now() };
    const rec = await this.ledger.append('branch', b);
    this.invalidate();
    this.log('info', 'branch', `branch ${name} created with ${patchIds.length} patch(es)`, null, context);
    await this.p2p?.broadcast(rec).catch(() => undefined);
    return b;
  }

  async branches(): Promise<BranchInfo[]> {
    const recs = await this.ledger.branches();
    const latest = new Map<string, BranchInfo>();
    for (const r of recs) latest.set(r.body.name, r.body);   // last write wins (owner-only on AIN)
    return [...latest.values()];
  }

  async addToBranch(name: string, patchId: string): Promise<BranchInfo> {
    const b = (await this.branches()).find((x) => x.name === name);
    if (!b) throw new Error('branch not found');
    if (b.owner !== this.address) throw new Error('only the branch owner can add patches');
    if (!(await this.entry(patchId))) throw new Error('patch not found');
    const nb: BranchInfo = { ...b, patch_ids: [...new Set([...b.patch_ids, patchId])] };
    const rec = await this.ledger.append('branch', nb);
    this.invalidate();
    await this.p2p?.broadcast(rec).catch(() => undefined);
    return nb;
  }

  async subscribe(branch: string, action: 'subscribe' | 'unsubscribe'): Promise<void> {
    const b = (await this.branches()).find((x) => x.name === branch);
    if (!b) throw new Error('branch not found');
    const s: SubscriptionRecord = { node: this.address, branch, action, patch_ids: b.patch_ids };
    const rec = await this.ledger.append('subscribe', s);
    this.invalidate();
    await this.p2p?.broadcast(rec).catch(() => undefined);
    this.log('info', 'branch', `${action} ${branch}`, null);
    if (action === 'subscribe') {
      const st = await this.runtime.status();
      for (const pid of b.patch_ids) {
        const e = await this.entry(pid);
        if (!e) continue;
        if (!this.blobs.has(e.anchor.patch_sha256)) {
          if (e.anchor.author === this.address) continue;
          try { await this.buy(pid); } catch (err) { this.log('warn', 'branch', `could not acquire ${pid}: ${(err as Error).message}`, pid); continue; }
        }
        if (st.available) await this.applyPatch(pid, `subscription:${branch}`).catch((err) => this.log('warn', 'branch', `apply ${pid} failed: ${(err as Error).message}`, pid));
      }
    } else {
      for (const pid of b.patch_ids) if (this.isApplied(pid)) await this.removePatch(pid).catch(() => undefined);
    }
  }

  async mySubscriptions(): Promise<string[]> {
    const subs = await this.ledger.subscriptions();
    const state = new Map<string, boolean>();
    for (const r of subs) if (r.body.node === this.address) state.set(r.body.branch, r.body.action === 'subscribe');
    return [...state.entries()].filter(([, v]) => v).map(([k]) => k);
  }

  /** Gateway routing (청구항 18): context attributes → branch → subscribed nodes. */
  async route(context: Record<string, string>): Promise<{ branch: BranchInfo | null; nodes: PeerInfo[] }> {
    const branches = await this.branches();
    let best: BranchInfo | null = null; let bestScore = 0;
    for (const b of branches) {
      const score = Object.entries(context).filter(([k, v]) => b.context[k] === v).length;
      if (score > bestScore) { best = b; bestScore = score; }
    }
    if (!best) return { branch: null, nodes: [] };
    const subs = await this.ledger.subscriptions();
    const active = new Map<string, boolean>();
    for (const r of subs) if (r.body.branch === best.name) active.set(r.body.node, r.body.action === 'subscribe');
    const nodes = await this.knownNodes();
    return { branch: best, nodes: nodes.filter((n) => active.get(n.address)) };
  }

  async selfInfo(): Promise<PeerInfo> {
    const st = await this.runtime.status();
    return {
      address: this.address, public_key: this.cfg.identity.publicKey, name: this.cfg.name, endpoint: this.publicUrl, roles: this.cfg.roles,
      ledger: this.ledger.kind, chain_id: this.cfg.ledger.ain?.chainId, model: st.model ?? undefined, branches: await this.mySubscriptions(),
      blobs: this.blobs.list().map((b) => b.sha256), version: this.cfg.version, last_seen: Date.now(),
    };
  }

  async knownNodes(): Promise<PeerInfo[]> {
    const recs = await this.ledger.nodes();
    const byAddr = new Map<string, PeerInfo>();
    for (const r of recs) byAddr.set(r.body.address, r.body);
    for (const p of this.store.listPeers()) if (p.info) byAddr.set(p.info.address, { ...p.info, last_seen: p.last_seen });
    byAddr.set(this.address, await this.selfInfo());
    return [...byAddr.values()];
  }

  async registerSelf(): Promise<void> {
    const info = await this.selfInfo();
    const rec = await this.ledger.append('node', info);
    await this.p2p?.broadcast(rec).catch(() => undefined);
  }

  // ------------------------------------------------------------------ operator settings (persisted)
  settings(): { notifications: 'all' | 'sales' | 'none'; display_name: string; payout_address: string } {
    const raw = this.store.get('settings');
    const base = { notifications: 'all' as const, display_name: this.cfg.name, payout_address: this.address };
    return raw ? { ...base, ...JSON.parse(raw) } : base;
  }
  updateSettings(patch: Partial<{ notifications: 'all' | 'sales' | 'none'; display_name: string; payout_address: string }>) {
    const next = { ...this.settings(), ...patch };
    this.store.set('settings', JSON.stringify(next));
    if (patch.display_name) this.cfg.name = patch.display_name;
    this.log('info', 'settings', `settings updated: ${Object.keys(patch).join(', ')}`);
    return next;
  }

  // ------------------------------------------------------------------ misc helpers
  async chainStatus(): Promise<Record<string, unknown>> {
    const info = await this.ledger.info();
    if (this.ledger instanceof AinLedger) {
      let balance: number | null = null;
      try { balance = await this.ledger.balance(); } catch { balance = null; }
      return { ...info, address: this.address, balance };
    }
    return { ...info, address: this.address, balance: await this.creditBalance(this.address) };
  }

  encodeRequirements = encodeRequirements;
  static readFixture(dir: string, name: string): string | null {
    const p = join(dir, name);
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  }
}
