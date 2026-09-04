/**
 * Market service — the node's business logic on top of Ledger + Store + BlobStore + Runtime + P2P:
 * drafts → announce (with conflict pre-check) → verification → listing; x402 trading (both schemes);
 * royalties along lineage; branches / subscriptions / gateway routing; purchases & runtime application.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AinLedger, VERSION, buildStamp, canonicalJson, DATASET_MAX_BYTES_CEILING, deriveCatalog, hashCanonical, intersectionCount, royaltySplit, sanitizeContributors, sha256Hex, signMessage, teachConfig, validateContributors, validatePrice, verifyMessage, ValidationError,
  decodePayload, decodeRequirements, encodePayload, encodeRequirements, newNonce, accessOf, accessRank, lineageIds, lineageProblems, licenseCompatible, TEACH_SAMPLES_ON_CHAIN,
  X402_HEADER_PAYMENT, X402_HEADER_REQUIRED,
  type Attestation, type BenchmarkSpec, type BranchInfo, type CatalogEntry, type Challenge, type Contributor, type DatasetAccess, type Ledger, type LedgerRecord,
  type NodeConfig, type PatchAnchor, type PatchManifest, type PatchOrigin, type PeerInfo, type Settlement, type TeachConfig, type X402Payload, type X402Requirement,
  type SubscriptionRecord, type SupersedeRecord,
} from '@ngram/core';
import { BlobStore } from './blobs.js';
import { DatasetBlobStore } from './dataset-blobs.js';
import { P2P } from './p2p.js';
import { Runtime, type ChatMessage, type ChatResult } from './runtime.js';
import { ChatCancelledError, ChatQueue } from './chat-queue.js';
import type { Store, BlobRow, EventRow } from './store.js';
import { Payouts } from './payouts.js';

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
  /** Data providers credited on the anchor (teach mode) — validated: ≤ 4, Σ share ≤ 1. */
  contributors?: Contributor[];
  /** 'teach' for visitor-taught knowledge; omitted for operator-registered drafts. */
  origin?: PatchOrigin;
  /** Provenance of the training set (hashes, counts, access, licence, parents — lineage design §5.1); the bytes live in the dataset blob store. */
  dataset?: PatchAnchor['dataset'];
  /** What this knowledge did to its bases (lineage design §5.1); absent = declared parents only. */
  derivation?: PatchAnchor['derivation'];
  /** The ordered stack it was trained on top of (lineage design §5.1); absent = stand-alone build. */
  base?: PatchAnchor['base'];
}

/** Maximum number of knowledges one live test may load together (spec §6.3). */
export const MAX_CHAT_PATCHES = 3;

/** Operator-editable teach policy overrides (kv `settings.teach`); anything unset falls back to config.json / defaults. */
export interface TeachSettings {
  enabled?: boolean; publish?: 'review' | 'auto' | 'never'; factsPerJob?: number; jobsPerKeyPerDay?: number; jobsPerIpPerDay?: number;
  queueMax?: number; contributorShare?: number; draftTtlDays?: number; pausedReason?: string | null; blockedTopics?: string | null;
  /**
   * Teach mode v2 limits (design §7.3). Flat keys over the nested `TeachConfig` blocks so a partial PATCH stays a
   * partial PATCH — `rowsPerJob` here is an explicit override that DISABLES the measured derivation.
   */
  datasetMaxBytes?: number; datasetMaxRows?: number; rowsPerJob?: number;
  rowsPerKeyPerDay?: number; rowsPerIpPerDay?: number; datasetsPerKeyPerDay?: number; datasetTtlDays?: number;
  declarationRows?: number; queuedRowsMax?: number; checkCallBudget?: number;
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

/** Error that carries the HTTP status the API should answer with (400 bad input, 404 unknown, 409 conflict, 503 unavailable). */
export class MarketError extends Error {
  /** Structured body merged into the JSON error response — what a bare `{error}` cannot carry (e.g. a blast radius). */
  constructor(public readonly status: number, message: string, public readonly details?: Record<string, unknown>) { super(message); this.name = 'MarketError'; }
}
/** The request names something that does not exist (HTTP 404). */
export class NotFoundError extends MarketError { constructor(message: string) { super(404, message); this.name = 'NotFoundError'; } }
/** The request conflicts with current state — duplicate id, immutable anchor, missing body (HTTP 409). */
export class ConflictError extends MarketError { constructor(message: string, details?: Record<string, unknown>) { super(409, message, details); this.name = 'ConflictError'; } }
const notFound = (msg: string) => new NotFoundError(msg);
const conflict = (msg: string, details?: Record<string, unknown>) => new ConflictError(msg, details);

/** Another knowledge item on this node whose body is the same file — what `patch forget` would take down with it. */
export interface SharedBody { id: string; name: string; status: string; sales: number }
export interface ForgetResult { ok: true; patch_id: string; sha256: string; deleted_file: boolean; also_affects: SharedBody[] }

/** Why a verified entry is still not for sale: the one sentence the 402 gate, `patch buy` and the web all show. */
export function challengedMessage(e: CatalogEntry): string {
  const c = e.open_challenge;
  const who = c ? `${c.challenger.slice(0, 10)}…` : 'a verifier node';
  return `a verifier has challenged this knowledge — re-verification pending, so it is not for sale${c ? ` (${who}: "${c.reason}")` : ''}`;
}
const badInput = (msg: string, details?: Record<string, unknown>) => new MarketError(400, msg, details);
const unavailable = (msg: string) => new MarketError(503, msg);

/** Who is asking for a knowledge in a live test / teach context (drafts are owner- or operator-only). */
export interface Caller { address?: string | null; operator?: boolean }

/** One live test: what to load, what to ask, and (D3) the client's id for it. */
export interface ChatOpts {
  patchIds?: string[]; patchId?: string;
  /** The conversation, ending with the question to answer. Used for both columns unless one is overridden below. */
  messages: ChatMessage[];
  /**
   * Compare mode with a history: each column must replay ITS OWN earlier answers. Feeding the patched answer back
   * to the un-patched model teaches it the knowledge inside the very test meant to show it does not have it — from
   * turn 2 the "before" column just repeats what the knowledge said. Both arrays end with the same question
   * (enforced in POST /api/chat); when absent the column falls back to `messages`.
   */
  messagesBase?: ChatMessage[];
  messagesPatched?: ChatMessage[];
  mode: 'base' | 'patched' | 'compare';
  maxTokens?: number; thinking?: boolean;
  visitor: string; caller?: Caller;
  /** Client-side id: registers a queue ticket so the wait is visible and a give-up while queued is free. */
  requestId?: string;
}

/** The answer(s) of one live test, plus what was loaded and how it scored. */
export interface ChatOutcome {
  patch_id: string; patch_ids: string[]; mode: string; base: ChatResult | null; patched: ChatResult | null;
  applied_ms: number | null; was_applied: boolean; model: string | null; benchmark_hit: boolean | null;
  applied: { patch_id: string; applied_ms: number | null; was_applied: boolean }[];
  benchmark_hits: Record<string, boolean | null>;
  /** How many messages each column was actually sent, and whether the two conversations differed. */
  history: { base: number; patched: number; split: boolean };
}

/** Shortest visitor question that may be matched to a benchmark sample by containment (D2). */
export const BENCH_MATCH_MIN = 8;

/**
 * The benchmark sample a visitor's question should be auto-scored against (D2 — "keep benchmark_hit honest").
 *
 * Trimmed equality first, so a sample chip sent verbatim ("종목코드 픽셀플러스 ") scores against its own sample even
 * though the label drops the trained trailing space. Containment is then allowed only for questions of at least
 * BENCH_MATCH_MIN characters: without that floor "드" — the one-character prompt that produced the runaway in D1 —
 * matched "종목코드 픽셀플러스 " and was shown to the visitor as ✗ Wrong against a ticker it never asked about.
 * (So did "코드", "종목" and a single space.)
 *
 * packages/web/src/components/chat/util.ts mirrors this rule so the ✓/✗ chip and the node never disagree.
 */
export function matchBenchmarkSample(samples: { prompt: string; expect: string }[] | undefined, userText: string): { prompt: string; expect: string; index: number } | undefined {
  const u = (userText ?? '').trim();
  if (!u || !samples?.length) return undefined;
  const at = (i: number) => (i >= 0 ? { ...samples[i], index: i } : undefined);
  const exact = samples.findIndex((x) => x.prompt.trim() === u);
  if (exact >= 0) return at(exact);
  if (u.length < BENCH_MATCH_MIN) return undefined;
  return at(samples.findIndex((x) => u.includes(x.prompt.trim()) || x.prompt.trim().includes(u)));
}

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
  ) {
    this.payouts = new Payouts(store, (l, k, m, pid, d) => this.log(l, k, m, pid ?? null, d ?? null), ledger instanceof AinLedger ? ledger : null, { selfAddress: cfg.identity.address });
    this.datasets = new DatasetBlobStore(store, cfg.dataDir);
  }
  /** Published training sets held by this node (lineage design §5.2, §6.6). */
  readonly datasets: DatasetBlobStore;
  /** Royalty payouts on the AIN ledger (`payouts` table + 60-s retry timer started by server.ts). */
  readonly payouts: Payouts;

  get address() { return this.cfg.identity.address; }
  get publicUrl() { return this.cfg.publicUrl ?? `http://localhost:${this.cfg.port}`; }

  /**
   * The visitor id every usage event, quota bucket and signal counter is keyed on (lineage design §5.6):
   * `'v:' + HMAC-SHA256(node secret, raw)[:16]` — stable for one node, meaningless anywhere else, and never an
   * address or an IP in a table `/api/events` used to serve raw (F11). The operator's own turns are keyed the same way.
   */
  visitorId(raw: string): string {
    return `v:${createHmac('sha256', this.store.visitorSecret()).update(raw).digest('hex').slice(0, 16)}`;
  }

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

  private refreshFollowUp: NodeJS.Timeout | null = null;
  /**
   * A peer just told us it wrote a record (p2p push). On the AIN ledger the record itself arrives through the chain,
   * so re-read it now and once more a few seconds later (block finality) instead of waiting for the next poll.
   */
  refreshLedgerSoon(followUpMs = 3000): void {
    this.refreshLedger().catch(() => undefined);
    if (this.refreshFollowUp) return;
    this.refreshFollowUp = setTimeout(() => { this.refreshFollowUp = null; this.refreshLedger().catch(() => undefined); }, followUpMs);
    this.refreshFollowUp.unref?.();
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
    const wellFormed = (anchors.filter((r) => Market.isAnchor(r.body)) as LedgerRecord<PatchAnchor>[]).map((r) => Market.sanitizeAnchorRecord(r));
    const wellFormedAtts = atts.filter((r) => Market.isAttestation(r.body));
    const drafts = this.store.listDrafts().map((d) => d.anchor);
    const value = deriveCatalog(wellFormed, wellFormedAtts, setts, chals, sups, this.cfg.verifier?.quorum ?? 2, drafts, !!this.cfg.verifier?.allowSelfAttest);
    // Legacy prototype anchors carry no size/rows — fill them in when we hold the very same body (sha256 match).
    for (const e of value) {
      if (e.anchor.rows === 0 || e.anchor.size_bytes === 0) {
        const b = this.blobs.get(e.anchor.patch_sha256);
        if (b) { e.anchor.rows = b.rows; e.anchor.size_bytes = b.size_bytes; e.anchor.model.row_dim ??= b.row_dim; }
      }
    }
    this.catalogCache = { at: Date.now(), value };
    this.noticeOwnEvents(value);
    return value;
  }

  /**
   * The three things that happen TO an author's knowledge — a challenge, a supersede, a failed verification — used to
   * arrive as an anonymous "received 1 record(s) via push" and change the listing silently (item 156). Whatever path
   * the record took (p2p push, gossip pull, a chain read), the author's node logs each of them exactly once, with who,
   * why and what it means. Derived here rather than at ingest so it works on both ledgers.
   */
  private noticeOwnEvents(entries: CatalogEntry[]): void {
    for (const e of entries) {
      if (e.anchor.author.toLowerCase() !== this.address.toLowerCase()) continue;
      if (!e.open_challenge && !e.superseded_by.length && !e.attestations.some((a) => !a.passed)) continue;   // nothing notable: no store read
      const key = `owner_notified:${e.anchor.id}`;
      const seen = new Set<string>(JSON.parse(this.store.get(key) ?? '[]') as string[]);
      const before = seen.size;
      const once = (mark: string, level: EventRow['level'], kind: string, message: string, data?: unknown) => {
        if (seen.has(mark)) return;
        seen.add(mark);
        this.log(level, kind, message, e.anchor.id, data);
      };
      const c = e.open_challenge;
      if (c) once(`challenge:${c.challenger}:${c.created_at}`, 'warn', 'challenge',
        `${c.challenger.slice(0, 10)}… challenged your knowledge ${e.anchor.id}: "${c.reason}" — it is off sale until a verifier re-runs the benchmark and passes it`,
        { challenger: c.challenger, reason: c.reason, created_at: c.created_at });
      for (const newer of e.superseded_by) once(`supersede:${newer}`, 'warn', 'publish',
        `${newer} supersedes your knowledge ${e.anchor.id} — buyers now see "Newer version available" on it`, { superseded_by: newer });
      for (const a of e.attestations) {
        if (a.passed) continue;
        once(`fail:${a.verifier}:${a.created_at}`, 'warn', 'verify',
          `${a.verifier_name ?? a.verifier.slice(0, 10)} verified your knowledge ${e.anchor.id} and it FAILED (${a.verified_on}): ${JSON.stringify(a.score)}`, { verifier: a.verifier, score: a.score });
      }
      if (seen.size !== before) this.store.set(key, JSON.stringify([...seen]));
    }
  }

  static isAnchor(b: unknown): b is PatchAnchor {
    const x = b as Partial<PatchAnchor> | null;
    return !!x && typeof x.id === 'string' && typeof x.patch_sha256 === 'string' && typeof x.author === 'string' && !!x.model && typeof x.model.id_M === 'string'
      && !!x.benchmark && typeof x.benchmark.schema === 'string' && typeof x.price === 'string' && Array.isArray(x.parents);
  }

  /**
   * Anchors we did not write (peer gossip, chain reads) are never trusted for their contributor list: a list that fails
   * `validateContributors` (Σ share > 1, > 4 entries, junk addresses) is dropped, so royaltySplit / payouts treat the
   * anchor as having no data providers instead of over-paying (security review: lineage over-payment).
   */
  static sanitizeAnchorRecord(r: LedgerRecord<PatchAnchor>): LedgerRecord<PatchAnchor> {
    if (r.body.contributors === undefined) return r;
    const clean = sanitizeContributors(r.body.contributors);
    if (clean && clean.length === r.body.contributors.length) return r;
    const body = { ...r.body };
    if (clean) body.contributors = clean; else delete body.contributors;
    return { ...r, body };
  }

  /** `child` records `base` as something it was trained on top of (a real add-on, not a declared-only parent). */
  static isTrainedOnTop(child: PatchAnchor, base: PatchAnchor): boolean {
    if (!child.parents.includes(base.id)) return false;
    const c = child as PatchAnchor & { derivation?: unknown; base?: unknown };
    return c.derivation !== undefined || c.base !== undefined;
  }

  static isAttestation(b: unknown): b is Attestation {
    const x = b as Partial<Attestation> | null;
    return !!x && typeof x.patch_id === 'string' && typeof x.verifier === 'string' && typeof x.passed === 'boolean' && typeof x.verified_on === 'string';
  }

  /** Lookup by id — includes test-visibility anchors (they are hidden from listings, not from direct access). */
  async entry(id: string): Promise<CatalogEntry | null> {
    return (await this.catalogAll()).find((e) => e.anchor.id === id) ?? null;
  }

  /** Every known entry by id — includes test-visibility anchors and local drafts, so lineage (parents / royalties / conflicts) resolves for hidden patches too. Callers exposing it publicly must filter. */
  async entryMap(): Promise<Map<string, CatalogEntry>> {
    return new Map((await this.catalogAll()).map((e) => [e.anchor.id, e]));
  }

  // ------------------------------------------------------------------ drafts / publish
  async createDraft(input: CreateDraftInput): Promise<PatchAnchor> {
    const id = (input.id ?? input.name).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
    if (!SLUG.test(id)) throw badInput('invalid patch id (use 2-64 chars: a-z 0-9 . _ -)');
    if (await this.entry(id)) throw conflict(`patch id already exists: ${id}`);
    const price = input.price === undefined ? this.cfg.market.defaultPrice : validatePrice(input.price);
    const { blob, sketch } = await this.blobs.importFile(input.file, { copy: !input.keepInPlace });
    const benchmark: BenchmarkSpec = { ...input.benchmark, format: input.benchmark.format ?? ['template'] };
    const parents = (input.parents ?? []).filter(Boolean);
    const map = await this.entryMap();
    for (const p of parents) if (!map.has(p)) throw badInput(`unknown parent patch: ${p}`);
    const anchor: PatchAnchor = {
      id, name: input.name, description: input.description ?? '', author: this.address, author_name: this.cfg.name,
      model: { row_dim: blob.row_dim, ...input.model } as PatchAnchor['model'],
      patch_sha256: blob.sha256, size_bytes: blob.size_bytes, rows: blob.rows,
      benchmark, benchmark_hash: hashCanonical({ schema: benchmark.schema, queries: benchmark.queries, format: benchmark.format, collateral_bound_nat: benchmark.collateral_bound_nat, samples: benchmark.samples ?? [] }),
      price, currency: this.cfg.market.currency, billing: input.billing ?? 'per_download',
      license: input.license, parents, parent_authors: parents.map((p) => map.get(p)!.anchor.author),
      branch: input.branch, topic_path: input.topic_path ?? `patches/${(input.model?.id_M ?? 'model').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      recipe: input.recipe, created_at: Date.now(), addr_sketch: sketch, visibility: input.visibility ?? 'public',
    };
    const contributors = this.checkContributors(input.contributors);
    if (contributors.length) anchor.contributors = contributors;
    if (input.origin) anchor.origin = input.origin;
    if (input.dataset) anchor.dataset = input.dataset;
    if (input.derivation) anchor.derivation = input.derivation;
    if (input.base) anchor.base = input.base;
    // the lineage invariant (design §5.1) for anchors THIS node writes: every base / dataset parent is a parent
    const problems = lineageProblems(anchor);
    if (problems.length) throw badInput(problems.join('; '));
    this.store.putDraft(anchor, blob.path);
    this.invalidate();
    this.log('info', 'patch', `draft created: ${id} (${blob.rows} rows, ${(blob.size_bytes / 1e6).toFixed(1)} MB)`, id);
    return anchor;
  }

  /** validateContributors + "the publishing node cannot be its own data provider" (its slice is the seller remainder already). */
  private checkContributors(list: unknown): Contributor[] {
    const out = validateContributors(list);
    if (out.some((c) => c.address.toLowerCase() === this.address.toLowerCase())) throw new ValidationError('contributor.address must not be this node\'s own address');
    return out;
  }

  updateDraft(id: string, patch: Partial<Pick<PatchAnchor, 'name' | 'description' | 'price' | 'branch' | 'benchmark' | 'license' | 'billing' | 'topic_path' | 'contributors' | 'origin' | 'visibility' | 'recipe' | 'dataset' | 'derivation' | 'base' | 'parents'>>): PatchAnchor {
    const d = this.store.getDraft(id);
    if (!d) throw conflict('only drafts can be edited (anchors are immutable on the ledger)');
    const anchor = { ...d.anchor, ...patch };
    if (patch.parents) {
      const map = new Map(this.store.listDrafts().map((x) => [x.anchor.id, x.anchor.author] as const));
      for (const e of this.catalogCache?.value ?? []) map.set(e.anchor.id, e.anchor.author);
      for (const p of patch.parents) if (!map.has(p)) throw badInput(`unknown parent patch: ${p}`);
      anchor.parent_authors = patch.parents.map((p) => map.get(p)!);
    }
    const problems = lineageProblems(anchor);
    if (problems.length) throw badInput(problems.join('; '));
    if ('contributors' in patch) {
      const contributors = this.checkContributors(patch.contributors);
      if (contributors.length) anchor.contributors = contributors; else delete anchor.contributors;
    }
    if (patch.price !== undefined) anchor.price = validatePrice(patch.price);
    if ('origin' in patch && patch.origin !== undefined && patch.origin !== 'operator' && patch.origin !== 'teach') throw new ValidationError('origin must be "operator" or "teach"');
    if ('visibility' in patch && patch.visibility !== undefined && patch.visibility !== 'public' && patch.visibility !== 'test') throw new ValidationError('visibility must be "public" or "test"');
    if (patch.benchmark) anchor.benchmark_hash = hashCanonical({ schema: anchor.benchmark.schema, queries: anchor.benchmark.queries, format: anchor.benchmark.format, collateral_bound_nat: anchor.benchmark.collateral_bound_nat, samples: anchor.benchmark.samples ?? [] });
    this.store.putDraft(anchor, d.file_path);
    this.invalidate();
    return anchor;
  }

  deleteDraft(id: string) {
    const d = this.store.getDraft(id);
    if (!d) throw notFound('draft not found');
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
      // A knowledge and the base it was TRAINED ON TOP OF share rows by design (an add-on writes over what it was
      // built on); that overlap is lineage, never a supersede candidate (lineage design §12.6). A parent that is
      // merely declared (no `derivation` / `base` on the child — every anchor written before the lineage fields)
      // keeps today's rule: a newer same-schema overlap still supersedes it, as the synthetic law/KR seed expects.
      if (Market.isTrainedOnTop(me.anchor, e.anchor) || Market.isTrainedOnTop(e.anchor, me.anchor)) continue;
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
    if (!d) throw notFound('draft not found');
    const blob = this.blobs.get(d.anchor.patch_sha256);
    if (!blob) throw conflict('patch body missing from blob store');
    if (!d.anchor.benchmark.schema) throw badInput('benchmark.schema is required');
    await this.validateLineageForAnnounce(d.anchor);
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

  /**
   * Append one attestation (the verifier role's only write). Refuses a self-attestation — an author verifying its own
   * anchor — unless `verifier.allowSelfAttest` is on: the derivation already excludes such records from the quorum
   * (catalog.ts), and this stops the useless record from being written and broadcast at all.
   */
  async attest(att: Attestation): Promise<void> {
    const e = await this.entry(att.patch_id);
    if (e && !this.cfg.verifier?.allowSelfAttest
        && e.anchor.author.toLowerCase() === att.verifier.toLowerCase()) {
      throw conflict(`cannot verify your own knowledge: ${att.patch_id} was published by this node (verifier.allowSelfAttest is false). A self-check never counts toward the quorum — another node has to verify it.`);
    }
    const rec = await this.ledger.append('attest', att);
    this.invalidate();
    this.log('info', 'verify', `attested ${att.patch_id}: ${att.passed ? 'PASS' : 'FAIL'} (${att.verified_on})`, att.patch_id, att.score);
    await this.p2p?.broadcast(rec).catch(() => undefined);
    await this.reconcileSupersedes().catch(() => undefined);
  }

  async challenge(patchId: string, reason: string): Promise<void> {
    // No `stake`: nothing is escrowed anywhere in this product, so the record does not claim a bond (item 127).
    const c: Challenge = { patch_id: patchId, challenger: this.address, reason, created_at: Date.now() };
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
        const s: SupersedeRecord = { old_patch_id: c.patch_id, new_patch_id: e.anchor.id, overlap_rows: c.overlap_rows, reason: 'newer patch on same benchmark schema overlaps address set', created_at: Date.now() };
        const rec = await this.ledger.append('supersede', s);
        await this.p2p?.broadcast(rec).catch(() => undefined);
        this.log('info', 'publish', `${e.anchor.id} supersedes ${c.patch_id} (${c.overlap_rows} shared rows)`, e.anchor.id);
      }
      this.store.set(`pending_supersede:${e.anchor.id}`, '[]');
    }
    this.invalidate();
  }

  /**
   * Announce-time validation shared by both doors (lineage design §12.6): every parent resolves and is not a private
   * draft (`parent_not_listed`), no cycle through `parents[]`, the lineage subsets hold, the licence is known and
   * compatible with every base's, the on-chain sample list respects the cap, and a published training set is really
   * pinned under the sha the anchor names (`dataset_inheritance_mismatch`). Pre-lineage anchors (no `dataset.access`,
   * no `derivation`, no `base`) only get the parent-resolution check they always had.
   */
  async validateLineageForAnnounce(a: PatchAnchor): Promise<void> {
    const map = await this.entryMap();
    for (const p of a.parents) {
      const pe = map.get(p);
      if (!pe) throw badInput(`unknown parent patch: ${p}`);
      if (pe.status === 'DRAFT') throw badInput(`parent_not_listed: ${p} is still a private draft — publish it first, it is the base of this knowledge`, { id: p });
    }
    const problems = lineageProblems(a);
    if (problems.length) throw badInput(problems.join('; '));
    // cycle through peer-written parents: walk up from every parent, refuse if we come back to this id
    const seen = new Set<string>(); const stack = [...a.parents];
    while (stack.length) {
      const id = stack.pop()!;
      if (id === a.id) throw badInput('base_cycle: this knowledge is an ancestor of one of its own parents');
      if (seen.has(id)) continue; seen.add(id);
      for (const q of map.get(id)?.anchor.parents ?? []) stack.push(q);
    }
    const lineage = a.dataset?.access !== undefined || !!a.derivation || !!a.base;
    if (!lineage) return;
    if (a.origin === 'teach' && (a.benchmark.samples?.length ?? 0) > TEACH_SAMPLES_ON_CHAIN) throw badInput(`a taught anchor carries at most ${TEACH_SAMPLES_ON_CHAIN} samples on the ledger`);
    if (a.dataset) {
      const license = a.dataset.license ?? 'CC-BY-4.0';
      for (const id of lineageIds(a)) {
        const base = map.get(id)?.anchor;
        const ok = licenseCompatible({ license: base?.dataset?.license, access: accessOf(base) }, { license, access: a.dataset.access ?? 'private' });
        if (!ok.ok) throw badInput(ok.reason, { parent: id, parent_license: base?.dataset?.license ?? null });
      }
      // the pinned copy IS the record: recompute the sha over the bytes this node will serve
      const bytes = this.datasets.rowsBytes(a.dataset.sha256);
      if (!bytes) throw conflict(`dataset_inheritance_mismatch: the training set ${a.dataset.sha256.slice(0, 12)}… is not pinned on this node`);
      if (sha256Hex(bytes) !== a.dataset.sha256) throw conflict('dataset_inheritance_mismatch: the pinned training set does not hash to the sha the record names');
    }
  }

  /** The most open access any non-draft, non-rejected anchor grants a published training set (design §6.1). */
  async datasetAccessOf(sha: string): Promise<{ access: DatasetAccess; entries: CatalogEntry[] }> {
    const entries = (await this.catalogAll()).filter((e) => e.anchor.dataset?.sha256 === sha && e.status !== 'DRAFT' && e.status !== 'REJECTED');
    let access: DatasetAccess = 'private';
    for (const e of entries) if (accessRank(accessOf(e.anchor)) > accessRank(access)) access = accessOf(e.anchor);
    return { access, entries };
  }

  /**
   * May `address` read the training set `sha` (design §6.6)? Public sets: any signed request. Derivative sets: a derive
   * token (`POST /api/patches/:id/derive-intent`, counted) or a verifier. Always: the author node, the teaching key
   * credited on the anchor, a verifier (it has to check inheritance), and a download token issued for the sha.
   */
  async mayReadDataset(sha: string, address: string | null, token?: string): Promise<{ ok: true } | { ok: false; reason: 'dataset_private' | 'dataset_derivative_only' | 'dataset_unknown' }> {
    if (token && this.store.checkToken(token, `dataset:${sha}`)) return { ok: true };
    const { access, entries } = await this.datasetAccessOf(sha);
    if (!entries.length) return { ok: false, reason: 'dataset_unknown' };
    const addr = address?.toLowerCase();
    if (addr) {
      if (entries.some((e) => e.anchor.author.toLowerCase() === addr)) return { ok: true };
      if (entries.some((e) => (e.anchor.contributors ?? []).some((c) => c.address.toLowerCase() === addr || c.signer?.toLowerCase() === addr))) return { ok: true };
      const nodes = await this.ledger.nodes();
      if (nodes.some((n) => n.body.address.toLowerCase() === addr && n.body.roles.includes('verifier'))) return { ok: true };
      if (this.store.listPeers().some((p) => p.address?.toLowerCase() === addr && p.info?.roles.includes('verifier'))) return { ok: true };
    }
    if (access === 'public') return addr ? { ok: true } : { ok: false, reason: 'dataset_derivative_only' };
    if (access === 'derivative') return { ok: false, reason: 'dataset_derivative_only' };
    return { ok: false, reason: 'dataset_private' };
  }

  /**
   * A signed derive intent (design §6.1): the teaching key `childKey` says it is building on `entry`. Counted on the
   * parent (`derive_fetches` → "built on N times"), answered with a 24-hour token for the set's bytes.
   */
  deriveIntent(entry: CatalogEntry, childKey: string): { token: string; expires: number; sha256: string } {
    const sha = entry.anchor.dataset?.sha256;
    if (!sha) throw notFound('dataset_unavailable: this knowledge has no published training set');
    const token = randomBytes(24).toString('hex');
    const ttl = 24 * 3600_000;
    this.store.putToken(token, `dataset:${sha}`, `derive:${childKey.toLowerCase()}`, ttl);
    this.store.bumpSignals(entry.anchor.id, { derive_fetches: 1 }, { visitor: this.visitorId(`derive:${childKey.toLowerCase()}`) });
    this.log('info', 'teach', `training set of ${entry.anchor.id} requested for a derivative`, entry.anchor.id, { child_key: childKey, sha256: sha });
    return { token, expires: Date.now() + ttl, sha256: sha };
  }

  // ------------------------------------------------------------------ blobs
  /** Make sure we hold the body for an anchor (author/verifier/purchaser path). */
  async ensureBlob(anchor: PatchAnchor, token?: string): Promise<BlobRow> {
    const have = this.blobs.get(anchor.patch_sha256);
    if (have) {
      this.log('info', 'blob', `fetched ${anchor.id} body from local blob store (already held, ${(have.size_bytes / 1e6).toFixed(1)} MB)`, anchor.id);
      return have;
    }
    const dest = this.blobs.pathFor(anchor.patch_sha256);
    const holders = this.p2p.holders(anchor.patch_sha256);
    const gw = (anchor as PatchAnchor & { gateway_url?: string }).gateway_url;
    if (gw) { try { holders.unshift(new URL(gw).origin); } catch { /* ignore */ } }
    const from = await this.p2p.fetchBlob(anchor.patch_sha256, dest, [...new Set(holders)], token);
    const { blob } = await this.blobs.importFile(dest, { expectSha: anchor.patch_sha256 });
    this.log('info', 'blob', `fetched ${anchor.id} body from ${from} (${(blob.size_bytes / 1e6).toFixed(1)} MB, sha ok)`, anchor.id);
    return blob;
  }

  /**
   * Stop serving a knowledge body from this node (`ainize patch forget <id>`): the local file is deleted (only files
   * inside our blob dir — in-place files are just deregistered). Bodies are content-addressed, so every id sharing the
   * same sha256 loses its local body too; the ids are reported. Refused while the patch is loaded in the model or is
   * still a draft (delete the draft instead) — nothing on the ledger changes.
   */
  async forgetBody(id: string, opts: { allSharing?: boolean } = {}): Promise<ForgetResult> {
    const e = await this.entry(id);
    if (!e) throw notFound('patch not found');
    if (e.status === 'DRAFT') throw conflict('this is a draft — delete it instead (ainize patch rm <id>)');
    if (this.isApplied(id)) throw conflict('patch is loaded in the model — unload it first (ainize patch remove <id>)');
    const blob = this.blobs.get(e.anchor.patch_sha256);
    if (!blob) throw notFound('body not held by this node');
    // Bodies are content-addressed, so this deletes the file out from under every other id built from the same
    // training output — the normal case for v1/v2/v3 of one knowledge. Say so BEFORE deleting, not after (item 149).
    const alsoAffects: SharedBody[] = (await this.catalogAll())
      .filter((x) => x.anchor.id !== id && x.anchor.patch_sha256 === blob.sha256)
      .map((x) => ({ id: x.anchor.id, name: x.anchor.name, status: x.status, sales: x.settlements.length }));
    if (alsoAffects.length && !opts.allSharing) {
      throw conflict(
        `${id} shares its knowledge file with ${alsoAffects.length} other item(s) on this node — forgetting it stops serving them too`,
        { also_affects: alsoAffects, sha256: blob.sha256 },
      );
    }
    const inStore = blob.path.startsWith(this.blobs.dir);
    this.blobs.remove(blob.sha256);
    this.invalidate();
    this.log('info', 'blob', `forgot ${id} body (${blob.sha256.slice(0, 12)}…, ${(blob.size_bytes / 1e6).toFixed(1)} MB${inStore ? ', file deleted' : ', file left in place'}) — no longer served from this node${alsoAffects.length ? `; same body as ${alsoAffects.map((x) => x.id).join(', ')}` : ''}`, id);
    return { ok: true, patch_id: id, sha256: blob.sha256, deleted_file: inStore, also_affects: alsoAffects };
  }

  /** The subset of `shas` that back publicly visible knowledge (no drafts, no hidden test anchors) — what visitors may count. */
  async publicBlobs(shas: string[]): Promise<string[]> {
    const pub = new Set((await this.catalog()).filter((e) => e.status !== 'DRAFT').map((e) => e.anchor.patch_sha256));
    return shas.filter((s) => pub.has(s));
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
    let royalty = royaltySplit(entry, map, price, this.cfg.market.royaltyShare);
    // Never distribute more than was received (royaltySplit clamps, this is the last line of defence before real transfers).
    const distributed = Object.values(royalty).reduce((a, b) => a + Number(b), 0);
    if (!(distributed <= price + 1e-6)) {
      this.log('error', 'trade', `royalty split for ${entry.anchor.id} adds up to ${distributed} > price ${price} — paying the seller only; check the lineage anchors`, entry.anchor.id, { royalty });
      royalty = { [this.address]: String(price) };
    }
    const settlement: Settlement = {
      patch_id: entry.anchor.id, seller: this.address, buyer, amount: String(price), currency: entry.anchor.currency, scheme,
      tx_hash: txHash, royalty, billing: entry.anchor.billing, created_at: Date.now(),
    };
    this.store.markPayment(txHash, entry.anchor.id);
    const rec = await this.ledger.append('settle', settlement);
    this.invalidate();
    this.log('info', 'trade', `sold ${entry.anchor.id} to ${buyer.slice(0, 10)}… for ${price} ${settlement.currency} (${scheme})`, entry.anchor.id, { royalty, tx: txHash });
    await this.p2p?.broadcast(rec).catch(() => undefined);
    // Pay lineage / contributor royalties on-chain (AIN): a `payouts` row per address is written BEFORE the transfer is
    // attempted (spec §9.3); the transfer itself runs in the background and the 60-s timer retries failures.
    // Local-credit settles need nothing else — creditBalance() derives balances from the settle record.
    if (scheme === 'ain-transfer') {
      this.payouts.enqueue(settlement, rec.hash);
      this.payouts.processPending().catch(() => undefined);
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
    if (entry && !entry.sellable) { await this.refreshLedger(); entry = await this.entry(patchId); }
    if (!entry) throw notFound('patch not found');
    if (!entry.quorum_ok) throw conflict(`verification quorum not met (${entry.passed}/${entry.quorum}) — refusing to buy`);
    if (!entry.sellable) throw conflict(challengedMessage(entry));
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
    if (!entry) throw notFound('patch not found');
    const blob = this.blobs.get(entry.anchor.patch_sha256);
    if (!blob) throw conflict('patch body not present on this node (buy it first)');
    const st = await this.runtime.status();
    if (!st.available) throw unavailable(st.error ?? 'runtime unavailable');
    const r = await this.runtime.apply(blob.path);
    if (r.code !== 0) throw new Error(r.err || r.out);
    this.store.setApplied(patchId, blob.sha256, reason);
    this.log('info', 'runtime', `applied ${patchId}: ${r.out}`, patchId);
    return r.out;
  }

  async removePatch(patchId: string): Promise<string> {
    const entry = await this.entry(patchId);
    if (!entry) throw notFound('patch not found');
    const blob = this.blobs.get(entry.anchor.patch_sha256);
    if (!blob) throw conflict('patch body not present');
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
  /** D3 — one ticket per live test so the client can be told it is queued (and cancel while it still costs nothing). */
  readonly chatQueue = new ChatQueue();

  /** Per-visitor trial quota for public live tests (operator is unlimited). Returns remaining or -1 when exhausted. */
  chatQuota(visitor: string, limit = 20, windowMs = 3600_000, consume = true, units = 1): number {
    const now = Date.now();
    const u = this.chatUsage.get(visitor);
    const cur = u && now - u.window < windowMs ? u : { count: 0, window: now };
    if (cur.count + units > limit) return -1;
    if (consume) { cur.count += units; this.chatUsage.set(visitor, cur); }
    return limit - cur.count;
  }

  /**
   * When the caller's current free-try hour ends (epoch ms), or null if no window is open. The client shows this in
   * place of a Retry button that cannot work — a measured instant, not "try again in an hour".
   */
  chatQuotaResetsAt(visitor: string, windowMs = 3600_000): number | null {
    const u = this.chatUsage.get(visitor);
    if (!u) return null;
    const end = u.window + windowMs;
    return end > Date.now() ? end : null;
  }

  /**
   * May `caller` load a DRAFT in a live test / as teach context? Operators always; a taught draft only its owner (the
   * teach job's contributor key); operator drafts nobody else. Everything that is not a draft is public.
   */
  mayUseEntry(entry: CatalogEntry, caller: Caller | undefined): boolean {
    if (entry.status !== 'DRAFT') return true;
    if (caller?.operator) return true;
    const addr = caller?.address?.toLowerCase();
    if (!addr) return false;
    return this.store.listTeachJobs({ draft_id: entry.anchor.id }).some((j) => j.contributor.toLowerCase() === addr);
  }

  /**
   * Live test: answer `messages` with the base model and/or with `patchIds` (1..3) applied. Runs under ONE shared
   * runtime lock (`chat:<id1>+<id2>`): [remove the already-applied ones → base answer] → [applyRaw in list order, so
   * the last one wins on overlapping addresses → patched answer] → restore in reverse (remove what we added, re-apply
   * what we removed). Every patched answer is metered as one `usage` event PER PATCH (청구항 12 적중당 과금의 계량 단위).
   */
  async chat(opts: ChatOpts): Promise<ChatOutcome> {
    // D3: the ticket exists from the first millisecond, so GET /api/chat/status answers "queued" even while this
    // request is still resolving catalogue entries or waiting on the shared lock.
    // The ticket's label is the one the lock will take, base-only turns included: `chat:` with nothing after it is
    // what the visible queue used to show for "ask the model with nothing of mine loaded".
    const qIds = (opts.patchIds ?? (opts.patchId ? [opts.patchId] : [])).map((s) => String(s).trim()).filter(Boolean);
    const ticket = opts.requestId ? this.chatQueue.open(opts.requestId, opts.visitor, qIds.length ? `chat:${qIds.join('+')}` : 'chat:base') : null;
    try { return await this.chatInner(opts); } finally { if (ticket) this.chatQueue.close(ticket.id); }
  }

  private async chatInner(opts: ChatOpts): Promise<ChatOutcome> {
    const ids = [...new Set((opts.patchIds ?? (opts.patchId ? [opts.patchId] : [])).map((s) => String(s).trim()).filter(Boolean))];
    // An EMPTY selection is legal and means "ask the model this node serves, with nothing of mine loaded". Teach mode's
    // conversational door starts exactly there: you correct the model before any knowledge for it exists, and on a node
    // with an empty catalog there is nothing to pick. There is nothing to compare against, so the mode is `base`.
    const baseOnly = ids.length === 0;
    const mode = baseOnly ? 'base' : opts.mode;
    if (ids.length > MAX_CHAT_PATCHES) throw new ValidationError(`at most ${MAX_CHAT_PATCHES} knowledges can be loaded together`);
    // Visibility first: a private draft is invisible to everyone but its owner / the operator (same 404 as
    // GET /api/patches/:id) whatever the runtime state — a non-owner must not learn anything from the error shape.
    const entries: { id: string; entry: CatalogEntry }[] = [];
    for (const id of ids) {
      const entry = await this.entry(id);
      if (!entry || !this.mayUseEntry(entry, opts.caller)) throw new NotFoundError(`patch not found: ${id}`);
      entries.push({ id, entry });
    }
    const st = await this.runtime.status();
    if (!st.available) throw unavailable(st.error ?? 'runtime unavailable');
    const targets: { id: string; entry: CatalogEntry; path: string }[] = [];
    for (const { id, entry } of entries) {
      const blob = this.blobs.get(entry.anchor.patch_sha256);
      if (!blob) throw conflict(`this node does not hold the patch body of ${id} — buy it first (or test it on the seller node)`);
      if (st.model && !entry.anchor.model.id_M.startsWith(st.model)) throw conflict(`patch ${id} targets ${entry.anchor.model.id_M} but this node serves ${st.model}`);
      targets.push({ id, entry, path: blob.path });
    }
    const clamp = (m: ChatMessage[]) => m.slice(-24).map((x) => ({ role: x.role, content: String(x.content).slice(0, 4000) }));
    const msgs = clamp(opts.messages);
    // One question, two conversations: the base call replays what the BASE model said before, the patched call what
    // the patched model said. Same last question either way (POST /api/chat rejects a pair that disagrees on it).
    const msgsBase = opts.messagesBase ? clamp(opts.messagesBase) : msgs;
    const msgsPatched = opts.messagesPatched ? clamp(opts.messagesPatched) : msgs;
    const chatOpts = { maxTokens: opts.maxTokens ?? 200, thinking: !!opts.thinking };
    const label = baseOnly ? 'chat:base' : `chat:${ids.join('+')}`;
    // `onEnter` fires the instant the shared lock is ours, before any model call: that is both when the client's
    // "queued" turns into "running" and the last moment a give-up costs the visitor nothing.
    let gaveUp = false;
    const onEnter = opts.requestId ? () => { gaveUp = !this.chatQueue.enter(opts.requestId!); } : undefined;
    return this.runtime.exclusive(label, async () => {
      if (gaveUp) throw new ChatCancelledError();
      // NOTE: inside exclusive() use the *Raw variants — apply()/remove() take the same lock and would deadlock.
      const wasApplied: boolean[] = [];
      for (const t of targets) wasApplied.push((await this.runtime.isApplied(t.path)) === true);
      const appliedMs: (number | null)[] = targets.map(() => null);
      let base: ChatResult | null = null; let patched: ChatResult | null = null;
      // `loaded[i]` tracks what is on the shared table right now so the restore step knows what to undo.
      const loaded = [...wasApplied];
      try {
        if (mode === 'base' || mode === 'compare') {
          for (let i = targets.length - 1; i >= 0; i--) {
            if (!loaded[i]) continue;
            const r = await this.runtime.removeRaw(targets[i].path); if (r.code !== 0) throw new Error(r.err || r.out);
            loaded[i] = false;
          }
          base = await this.runtime.chat(msgsBase, chatOpts);
        }
        if (mode === 'patched' || mode === 'compare') {
          // Apply everything in list order unless every patch is already on the table (single-patch fast path kept):
          // a partial re-apply could not guarantee "last one wins" on overlapping addresses.
          if (loaded.some((x) => !x)) {
            for (let i = 0; i < targets.length; i++) {
              const t0 = Date.now(); const r = await this.runtime.applyRaw(targets[i].path); if (r.code !== 0) throw new Error(r.err || r.out);
              appliedMs[i] = Date.now() - t0; loaded[i] = true;
            }
          }
          patched = await this.runtime.chat(msgsPatched, chatOpts);
        }
      } finally {
        // Always leave the shared table the way we found it: drop what we added (reverse order), then put back what
        // we removed — and re-assert the operator-pinned ones in list order when an overlapping removal may have
        // reverted some of their rows.
        let touched = false;
        for (let i = targets.length - 1; i >= 0; i--) {
          if (!loaded[i] || wasApplied[i]) continue;
          touched = true;
          await this.runtime.removeRaw(targets[i].path).catch((e) => this.log('error', 'runtime', `restore (remove) failed after live test: ${(e as Error).message}`, targets[i].id));
          loaded[i] = false;
        }
        for (let i = 0; i < targets.length; i++) {
          if (!wasApplied[i] || (loaded[i] && !touched)) continue;
          await this.runtime.applyRaw(targets[i].path).catch((e) => this.log('error', 'runtime', `restore (re-apply) failed after live test: ${(e as Error).message}`, targets[i].id));
          loaded[i] = true;
        }
      }
      const lastUser = [...msgs].reverse().find((m) => m.role === 'user')?.content ?? '';
      const hits: Record<string, boolean | null> = {};
      const applied = targets.map((t, i) => ({ patch_id: t.id, applied_ms: appliedMs[i], was_applied: wasApplied[i] }));
      for (const [i, t] of targets.entries()) {
        const sample = matchBenchmarkSample(t.entry.anchor.benchmark.samples, lastUser);
        // Scored on what the MODEL produced, not on what the D1 guard shows: truncating a runaway must never
        // change a ✓/✗ verdict (and a correct bare ticker is never truncated anyway).
        const answer = patched ? patched.raw_content ?? patched.content : null;
        const hit = sample && answer !== null ? answer.replace(/\s/g, '').includes(sample.expect) : null;
        hits[t.id] = hit;
        // `visitor` is the HMAC id (never an address); `sample_index` is what the "own questions it got wrong" panel keys on (§10)
        this.log('info', 'usage', `live test ${t.id}${ids.length > 1 ? ` [+${ids.length - 1}]` : ''} (${opts.mode}) by ${opts.visitor.slice(0, 24)}: ${patched ? 'patched hit=' + hit : 'base only'}`, t.id,
          { visitor: opts.visitor, mode: opts.mode, hit, base_ms: base?.latency_ms, patched_ms: patched?.latency_ms, applied_ms: appliedMs[i], patch_ids: ids, position: i + 1, sample_index: sample?.index ?? null });
        // materialised at write time: the counters survive the 90-day event retention
        if (patched) this.store.bumpSignals(t.id, { tests: 1, hits: hit === true ? 1 : 0, misses: hit === false ? 1 : 0, unscored: hit === null ? 1 : 0 }, { visitor: opts.visitor });
      }
      const sum = appliedMs.filter((x): x is number => x !== null);
      const anyHit = Object.values(hits);
      if (baseOnly) this.log('info', 'usage', `live test (base model, nothing loaded) by ${opts.visitor.slice(0, 24)}`, undefined, { visitor: opts.visitor, mode });
      return {
        patch_id: ids[0] ?? '', patch_ids: ids, mode, base, patched,
        applied_ms: sum.length ? sum.reduce((a, b) => a + b, 0) : null, was_applied: wasApplied[0] ?? false, model: st.model,
        benchmark_hit: anyHit.some((h) => h === true) ? true : anyHit.some((h) => h === false) ? false : null,
        applied, benchmark_hits: hits,
        history: { base: msgsBase.length, patched: msgsPatched.length, split: JSON.stringify(msgsBase) !== JSON.stringify(msgsPatched) },
      };
    }, { onEnter });
  }

  /** Patches whose bodies are on this node (testable in ChatMode). */
  async testablePatches(): Promise<CatalogEntry[]> {
    const st = await this.runtime.status();
    return (await this.catalog()).filter((e) => e.status !== 'DRAFT' && this.blobs.has(e.anchor.patch_sha256) && (!st.model || e.anchor.model.id_M.startsWith(st.model)));
  }

  /** Pairwise memory-entry overlap among the given entries (picker warning: "these two overlap on n entries"). */
  chatOverlaps(entries: CatalogEntry[]): { a: string; b: string; rows: number }[] {
    const sets = entries.map((e) => ({ id: e.anchor.id, set: this.blobs.addrSet(e.anchor.patch_sha256) }));
    const out: { a: string; b: string; rows: number }[] = [];
    for (let i = 0; i < sets.length; i++) {
      if (!sets[i].set) continue;
      for (let j = i + 1; j < sets.length; j++) {
        if (!sets[j].set) continue;
        const n = intersectionCount(sets[i].set!, sets[j].set!);
        if (n > 0) out.push({ a: sets[i].id, b: sets[j].id, rows: n });
      }
    }
    return out.sort((x, y) => y.rows - x.rows);
  }

  /** Ids the operator keeps loaded in the serving model (they colour the "before" answer of every live test). */
  pinnedPatchIds(): string[] { return this.store.listApplied().map((a) => a.patch_id); }

  // ------------------------------------------------------------------ branches / network
  async createBranch(name: string, description: string, context: Record<string, string>, patchIds: string[] = []): Promise<BranchInfo> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9/_-]{1,63}$/.test(name)) throw badInput('invalid branch name');
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

  /** Branch by name; a miss re-reads the shared ledger once (another node may have written it seconds ago). */
  private async branchByName(name: string): Promise<BranchInfo | undefined> {
    let b = (await this.branches()).find((x) => x.name === name);
    if (!b) { await this.refreshLedger(); b = (await this.branches()).find((x) => x.name === name); }
    return b;
  }

  async addToBranch(name: string, patchId: string): Promise<BranchInfo> {
    const b = await this.branchByName(name);
    if (!b) throw notFound('branch not found');
    if (b.owner !== this.address) throw new MarketError(403, 'only the branch owner can add patches');
    if (!(await this.entry(patchId))) throw notFound('patch not found');
    const nb: BranchInfo = { ...b, patch_ids: [...new Set([...b.patch_ids, patchId])] };
    const rec = await this.ledger.append('branch', nb);
    this.invalidate();
    await this.p2p?.broadcast(rec).catch(() => undefined);
    return nb;
  }

  async subscribe(branch: string, action: 'subscribe' | 'unsubscribe'): Promise<void> {
    const b = await this.branchByName(branch);
    if (!b) throw notFound('branch not found');
    const s: SubscriptionRecord = { node: this.address, branch, action, patch_ids: b.patch_ids, created_at: Date.now() };
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
      blobs: this.blobs.list().map((b) => b.sha256), datasets: this.datasets.list().map((b) => b.sha256).slice(0, 40),
      version: VERSION, build: buildStamp(), config_version: this.cfg.version, last_seen: Date.now(),
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

  // ------------------------------------------------------------------ teach mode policy (config.json `teach` + operator overrides in kv `settings.teach`, spec §7.5)
  /** Effective teach config: defaults ← config.json `teach` ← operator overrides persisted in the kv store. */
  teach(): TeachConfig & { pausedReason?: string; blockedTopics?: string; rowsPerJobOverride?: number } {
    const base = teachConfig(this.cfg);
    const s = this.teachSettings();
    const out: TeachConfig & { pausedReason?: string; blockedTopics?: string; rowsPerJobOverride?: number } = { ...base };
    if (s.enabled !== undefined) out.enabled = s.enabled;
    if (s.publish !== undefined) out.publish = s.publish;
    if (s.factsPerJob !== undefined) out.factsPerJob = s.factsPerJob;
    if (s.jobsPerKeyPerDay !== undefined) out.jobsPerKeyPerDay = s.jobsPerKeyPerDay;
    if (s.jobsPerIpPerDay !== undefined) out.jobsPerIpPerDay = s.jobsPerIpPerDay;
    if (s.queueMax !== undefined) out.queueMax = s.queueMax;
    if (s.contributorShare !== undefined) out.contributorShare = s.contributorShare;
    if (s.draftTtlDays !== undefined) out.draftTtlDays = s.draftTtlDays;
    if (s.pausedReason) out.pausedReason = s.pausedReason;
    if (s.blockedTopics) out.blockedTopics = s.blockedTopics;
    // v2: nested blocks are cloned before an override lands so the defaults object is never mutated
    const ds: Partial<TeachConfig['dataset']> = {};
    if (s.datasetMaxBytes !== undefined) ds.maxBytes = Math.min(s.datasetMaxBytes, DATASET_MAX_BYTES_CEILING);
    if (s.datasetMaxRows !== undefined) ds.maxRows = s.datasetMaxRows;
    if (s.rowsPerKeyPerDay !== undefined) ds.rowsPerKeyPerDay = s.rowsPerKeyPerDay;
    if (s.rowsPerIpPerDay !== undefined) ds.rowsPerIpPerDay = s.rowsPerIpPerDay;
    if (s.datasetsPerKeyPerDay !== undefined) ds.perKeyPerDay = s.datasetsPerKeyPerDay;
    if (s.datasetTtlDays !== undefined) ds.ttlDays = s.datasetTtlDays;
    if (s.declarationRows !== undefined) ds.declarationRows = s.declarationRows;
    if (Object.keys(ds).length) out.dataset = { ...out.dataset, ...ds };
    if (s.checkCallBudget !== undefined) out.check = { ...out.check, callBudget: s.checkCallBudget };
    if (s.queuedRowsMax !== undefined) out.queuedRowsMax = s.queuedRowsMax;
    if (s.rowsPerJob !== undefined) out.rowsPerJobOverride = s.rowsPerJob;
    return out;
  }
  /** Operator overrides only (what `PATCH /api/me/teach/policy` wrote). */
  teachSettings(): TeachSettings { const raw = this.store.get('settings.teach'); return raw ? (JSON.parse(raw) as TeachSettings) : {}; }
  updateTeachPolicy(patch: TeachSettings): TeachSettings {
    // Only keys the operator actually sent change: `undefined` = untouched, `null` = clear the override (back to config.json).
    const next: Record<string, unknown> = { ...this.teachSettings() };
    for (const [k, v] of Object.entries(patch)) { if (v === undefined) continue; if (v === null) delete next[k]; else next[k] = v; }
    this.store.set('settings.teach', JSON.stringify(next));
    this.log('info', 'settings', `teach policy updated: ${Object.entries(patch).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')}`);
    return next as TeachSettings;
  }
  /** Whether visitors may publish taught knowledge through this node as data providers. */
  acceptsContributions(): boolean { const t = this.teach(); return t.enabled && t.publish !== 'never'; }

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
