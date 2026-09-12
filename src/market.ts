/**
 * Market service — the node's business logic on top of Ledger + Store + BlobStore + Runtime + P2P:
 * drafts → announce (with conflict pre-check) → verification → listing; x402 trading (both schemes);
 * royalties along lineage; branches / subscriptions / gateway routing; purchases & runtime application.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  AinLedger, VERSION, buildStamp, canonicalJson, CHALLENGE_COOLDOWN_MS, CHALLENGE_MIN_REASON, DATASET_MAX_BYTES_CEILING, DISPUTE_MAX_REASON, DISPUTE_MIN_REASON, deriveCatalog, effectiveRoyaltyShare, effectiveVerifierShare, hashCanonical, intersectionCount, NETWORK_MIN_ROYALTY_SHARE, royaltyPlan, royaltySplit, sanitizeContributors, sha256Hex, signMessage, teachConfig, validateContributors, validatePrice, verifyMessage, ValidationError,
  decodePayload, decodeRequirements, encodePayload, encodeRequirements, newNonce, accessOf, accessRank, lineageIds, lineageProblems, licenseCompatible, TEACH_SAMPLES_ON_CHAIN,
  X402_HEADER_PAYMENT, X402_HEADER_REQUIRED, X402_HEADER_RESPONSE, ainPaymentDigest, sketchJaccard, transferKeyFor, type X402Required,
  type Attestation, type BenchmarkSpec, type BranchInfo, type CatalogEntry, type Challenge, type Contributor, type Dispute, type DatasetAccess, type Ledger, type LedgerRecord,
  type DerivationKind, type NodeConfig, type PatchAnchor, type PatchManifest, type PatchOrigin, type PeerInfo, type Settlement, type TeachConfig, type X402Payload, type X402Requirement,
  type RetireRecord, type SubscriptionRecord, type SupersedeRecord, type PriceRecord, type PayoutRecord, type SubscriptionTerms, PRICE_RE,
  sameAddr,
} from '@ainize/core';
import { BlobStore } from './blobs.js';
import { DatasetBlobStore } from './dataset-blobs.js';
import { questionKey } from './teach-dataset.js';
import { P2P } from './p2p.js';
import { Runtime, type ChatMessage, type ChatResult, type VerifyOutcome } from './runtime.js';
import { ChatCancelledError, ChatQueue } from './chat-queue.js';
import type { Store, BlobRow, CreditGrantRow, EventRow, LicenseRow, LicenseSource } from './store.js';
import { Payouts } from './payouts.js';

/** Depth cap of the family tree walk (design §12.5 asks for ≤ 8 hops in either direction). */
export const TREE_MAX_DEPTH = 8;

/** One knowledge in the family tree (design §12.5). `missing` = it exists as an id only — unknown here, or not for this caller. */
export interface TreeNode {
  id: string; name: string; missing?: true;
  author?: string; author_name?: string | null; taught_by?: string | null;
  contributors: { address: string; name: string | null; role?: string; share?: number }[];
  status?: string; superseded_by: string[]; supersedes: string[];
  branch?: string | null; tracks?: string[];
  derivation?: PatchAnchor['derivation'] | null;
  base_stack: string[]; export?: 'delta' | 'squash' | null;
  legacy?: boolean;
  dataset?: { sha256: string; rows: number; access: DatasetAccess; license: string | null } | null;
  /** SC-9 "+{m} questions · {k} changed · {rows} rows ({new} new)". */
  added: { questions: number; changed: number; removed: number; rows: number; new: number };
  signals: Record<string, number>;
  /** 0 = the knowledge asked about; negative = an ancestor, positive = a descendant. */
  depth: number;
}
export interface TreeEdge { from: string; to: string; kind: 'extend' | 'update' | 'contradict' | 'merge' | 'version' | 'track' | 'declared' }
export interface LineageTree {
  root: string; depth: number; dir: 'up' | 'down' | 'both';
  nodes: TreeNode[]; edges: TreeEdge[];
  /** true when the walk stopped at the depth cap with more to see. */
  truncated: boolean;
  family: { sales: number; knowledges: number; authors: number };
  money: {
    seller_pct: number; lineage_pct: number; contributor_pct: number;
    /** the verification fee on one sale of the root, and how many verifiers share it (item 325) */
    verifier_pct: number; verifier_count: number;
    seller_name: string | null; lineage_names: string[];
    /** `for_id`/`for_name` name the ancestor a lineage share is paid FOR — the answer to "who is paid because I built on them?" */
    recipients: { address: string; pct: number; name: string | null; kind: 'lineage' | 'contributor' | 'verifier'; for_id?: string; for_name?: string }[];
  };
}

/** Why an announced knowledge has not reached its quorum yet, assembled from what THIS node has seen (item 154). */
export interface VerificationStall {
  patch_id: string;
  /** When the anchor was announced. */
  since: number;
  waited_minutes: number;
  counted: number;
  quorum: number;
  /** Attestations that exist but are hash-only — they cannot count for an anchor that ships samples. */
  hash_only: number;
  /** True when the benchmark ships sample questions, so a hash-only attestation can never list it. */
  needs_benchmark: boolean;
  /** The model this knowledge names. */
  model: string;
  /** The verifier peers that answered this node's last gossip round, and what each has done about this anchor. */
  verifiers: { name: string | null; endpoint: string; address: string | null; model: string | null; attested: 'no' | 'hash-only' | 'executed' }[];
  /** One sentence naming the cause, built only from the fields above. */
  reason: string;
}

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
  /**
   * What this knowledge IS to its parents (item 188): `extend` adds answers on top, `contradict` disagrees with
   * some of theirs, `update` is a new version of your own knowledge. The row counts behind it are measured here
   * from the two bodies, never taken from the caller — so a child can only declare a kind on a base whose file
   * this node holds. Absent = a declared parent with no claim about what changed, which is what every
   * `publish --parents` wrote before.
   */
  kind?: DerivationKind;
  branch?: string;
  topic_path?: string;
  /** The day the data is true of (item 267) — `YYYY-MM-DD`, validated here, never guessed from the file. */
  as_of?: string;
  recipe?: PatchAnchor['recipe'];
  file: string;              // local path to .npz (copied into blob store unless `keepInPlace`)
  keepInPlace?: boolean;
  visibility?: 'public' | 'test';
  /** Data providers credited on the anchor (teach mode) — validated: ≤ 4, Σ share ≤ 1. */
  contributors?: Contributor[];
  /** 'teach' for visitor-taught knowledge; omitted for operator-registered drafts. */
  origin?: PatchOrigin;
  /**
   * Publish anyway past the two refusals that are judgement calls, not corruption: a body this node already
   * published on the same subject (`duplicate_body`), and a `model.id_M` this node's own runtime does not serve
   * (`model_mismatch`). Never lets one node publish ANOTHER author's bytes — that refusal has no override.
   */
  force?: boolean;
  /** Provenance of the training set (hashes, counts, access, licence, parents — lineage design §5.1); the bytes live in the dataset blob store. */
  dataset?: PatchAnchor['dataset'];
  /** What this knowledge did to its bases (lineage design §5.1); absent = declared parents only. */
  derivation?: PatchAnchor['derivation'];
  /** The ordered stack it was trained on top of (lineage design §5.1); absent = stand-alone build. */
  base?: PatchAnchor['base'];
}

/** Maximum number of knowledges one live test may load together (spec §6.3). Bases loaded underneath do not count. */
export const MAX_CHAT_PATCHES = 3;

/** One layer of the runtime stack while it is being asserted (internal). */
interface Layer {
  id: string; sha256: string; path: string; delta: boolean; requested: boolean;
  /** Why this layer is on the table (`manual`, `subscription:<track>`, `chat:<visitor>`, …); kept across a restore so
   * putting the stack back does not relabel every layer as 'restore'. */
  reason?: string;
}

/** One layer of the runtime stack as reported (`GET /api/runtime`, `ainize patch stack`). */
export interface StackLayer {
  patch_id: string; name: string | null; sha256: string; position: number; applied_at: number; reason: string;
  rows: number | null;
  /** 'delta' = an add-on that needs everything below it; 'squash' = carries its own base rows; null = pre-lineage. */
  export: 'delta' | 'squash' | null;
  base_stack: string[];
  /** Is the journal that would undo this layer still on disk? Without it a remove falls back to the file's `before`. */
  journal: boolean; journal_path: string | null;
  stack_sha256: string | null;
  body_present: boolean;
  /**
   * When the watchdog last MEASURED this layer against the live table, and what it found (item 215). Only the top of
   * the stack is measured — that is what the watchdog probes — so the layers below carry null rather than a guess.
   */
  checked_at: number | null;
  present: boolean | null;
}

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
/**
 * A partial edit of those overrides. `undefined` leaves a field alone; `null` REMOVES the override so the node falls
 * back to config.json / the built-in default — which is what `ainize config unset teach.<key>` needs (item 125):
 * without a way to clear one, a console override outlived every terminal edit and every restart.
 */
export type TeachPolicyPatch = { [K in keyof TeachSettings]?: TeachSettings[K] | null };
/**
 * An address-set overlap with another knowledge. `author` / `created_at` / `sales` are what the publisher has to see
 * before announcing (item 150) and what the supersede rule reads (items 151, 240, 363): only an OLDER knowledge by
 * the SAME author is ever superseded — a competitor's listing never is.
 */
/** A queued apply/remove (item 212): the POST answers with this and the caller polls `GET /api/runtime/jobs/:id`. */
export interface RuntimeJob {
  id: string; kind: 'apply' | 'remove'; patch_id: string;
  state: 'queued' | 'running' | 'done' | 'failed';
  queued_at: number; started_at: number | null; finished_at: number | null;
  result: string | null; error: string | null;
  status?: number; details?: Record<string, unknown> | null;
  /** What the shared model is doing while this job waits — what the CLI prints instead of nothing. */
  queue?: { running: { label: string; since: number } | null; waiting: number; lock: { label: string; owner: string; since: number; mine: boolean } | null };
}

/** One item of a track, resolved against this node: what subscribing would do with it, and why (items 256, 257, 357). */
export interface TrackItem {
  patch_id: string; name: string | null; author: string | null; author_name: string | null;
  price: string; currency: string; status: string | null;
  /** buy = money leaves this node; held/own = nothing to pay; retired/blocked/wrong_model/unknown = not loaded at all. */
  plan: 'buy' | 'held' | 'own' | 'retired' | 'blocked' | 'wrong_model' | 'unknown';
  reason: string;
  superseded_by: string[];
}
/** What `POST /api/branches/:name/quote` answers: the whole spend, item by item, before anything is spent. */
/**
 * What following a track costs and what it has cost (item 359): the curator's terms, whether this node's period is
 * paid, and a run rate measured from the track's own last 30 days — never a projection.
 */
export interface SubscriptionQuote {
  branch: string;
  owner: string;
  terms: SubscriptionTerms | null;
  paid_until: number | null;
  paid_at: number | null;
  periods_paid: number;
  due: boolean;
  currency: string;
  run_rate: { days: number; knowledge_added: number; knowledge_spend: string; per_period: string | null; per_30_days: string };
}

export interface TrackQuote {
  branch: string; owner: string; description: string; subscribed: boolean;
  items: TrackItem[];
  /** The track's CURRENT set — what this node would load (retired versions and unverified bakes are not in it). */
  current: string[];
  retired: string[];
  buy: string[];
  total: { currency: string; amount: string }[];
  currency: string; balance: number | null;
  runtime_available: boolean; runtime_error: string | null;
  /** What following it costs per period and what its own last 30 days cost (item 359); null on a free track. */
  subscription?: SubscriptionQuote | null;
}
/** What a subscribe / unsubscribe / sync actually did. */
export interface SubscribeResult {
  ok: true; branch: string; action: 'subscribe' | 'unsubscribe' | 'sync';
  acquired: string[];
  failed: { patch_id: string; error: string }[];
  applied: string[];
  skipped: { patch_id: string; reason: string }[];
  removed: string[];
  spent: { currency: string; amount: string }[];
}

/** One row of the live-test / teach knowledge picker (item 297): what this node could run, and what is in the way. */
export interface PickerRow {
  entry: CatalogEntry;
  /** Is the body on this node? */
  held: boolean;
  /** May this node use it — author, purchase or price 0? (A verification copy is held but not licensed.) */
  licensed: boolean;
  license: LicenseSource | null;
  /** held AND licensed: it can be loaded right now. */
  testable: boolean;
  /** It is verified and for sale, and this node does not have a licence for it — the operator can buy it. */
  buyable: boolean;
  reason: 'ok' | 'not_held' | 'not_licensed' | 'verify_only';
  /** How many different visitors have asked the operator to get it. */
  requests: number;
}

export interface ConflictInfo {
  patch_id: string; overlap_rows: number; same_schema: boolean; status: string; branch?: string; cross_branch: boolean;
  /**
   * The declared family relation between the two, when there is one (item 189): `parent` = the overlapping knowledge
   * is a declared base of the one asked about, `child` = the other way round. A family overlap is never a conflict
   * and never a supersede candidate — an add-on writes over what it was built on, which is the point of it.
   */
  lineage?: 'parent' | 'child' | null;
  /** Address of the node that published the overlapping knowledge. */
  author: string;
  author_name?: string | null;
  /** true when that knowledge belongs to this node (the only kind an announce may retire). */
  same_author: boolean;
  created_at: number;
  /** Settled sales of the overlapping knowledge — what retiring it would end. */
  sales: number;
}

/** What one sale of a knowledge pays and to whom (items 189, 318) — the preview `royaltyPlan` will settle. */
export interface SaleSplit {
  patch_id: string;
  amount: string;
  currency: string;
  /** The rule that decides the split, in one sentence (item 322) — it used to live only in a source comment. */
  rule?: string;
  /** How many people this sale pays. */
  payees?: number;
  /** What one sale costs to settle here, from measured gas (item 366); null when this chain has charged nothing. */
  cost?: { writes: number; gas_avg: number; floor: string; measured_writes: number } | null;
  /** The lineage share this anchor promises, and the verification share, as they will be applied. */
  share: number;
  verifier_share: number;
  lines: { address: string; amount: string; name: string | null; role: 'seller' | 'ancestor' | 'contributor' | 'verifier'; knowledge: string[] }[];
  parents: { id: string; name: string; price: string | null; currency: string; author: string | null; author_name: string | null; status: string | null }[];
  /** Declared bases that cost MORE than this knowledge does (item 318). */
  cheaper_than: { id: string; price: string; currency: string }[];
  /** Parent ids no anchor here names an author for — their slice is held, not paid (from `royaltyPlan`). */
  unresolved: Record<string, string>;
}

/**
 * What `/api/route` answers (item 234): which track was chosen, which of the caller's keys it matched, what else
 * matched, and — for every node the record says subscribes — what that node is actually serving right now.
 */
export interface RouteResult {
  branch: BranchInfo | null;
  matched: string[];
  unmatched: string[];
  candidates: { name: string; context: Record<string, string>; matched: string[]; unmatched: string[] }[];
  /** More than one track matched equally well; `branch` is the deterministic pick and `candidates` shows the rest. */
  ambiguous: boolean;
  /** The ids a subscriber of the chosen track loads today. */
  current: string[];
  nodes: (Omit<PeerInfo, 'applied'> & { applied: string[] | null; missing: string[]; current: boolean | null })[];
  /** Subscribed nodes that are NOT serving every current item of the track. */
  stale_nodes: { address: string; name: string; endpoint: string; missing: string[] }[];
}

/** What a track would write over in what is already loaded (item 214). `rows` is measured; a body this node does not hold yet is an estimate from the published address sketches, and says so. */
export interface TrackOverlap {
  track_id: string; loaded_id: string; rows: number | null; estimated: boolean; jaccard?: number; loaded_reason: string;
}

/**
 * An item on its way to VERIFIED, as THIS node can see it (item 254): who has not answered yet, how many of them can
 * run this knowledge's model, and how long verification has actually taken here before. Nothing is estimated that
 * was not measured — `typical_ms` is null on a node that has never listed anything.
 */
export interface VerificationProgress {
  patch_id: string; since: number; waited_ms: number; counted: number; quorum: number;
  waiting_on: { name: string; address: string; model: string | null; can_run: boolean }[];
  capable: number;
  typical_ms: number | null;
  eta_ms: number | null;
  samples: number;
}

export interface PurchaseResult {
  patch_id: string;
  steps: { step: string; detail: string; at: number }[];
  manifest: PatchManifest;
  path: string;
  tx_hash: string;
  amount: string;
  scheme: string;
  /** Every knowledge this call paid for, bases first (item 270); one entry with `withRequired` off. */
  purchases?: { patch_id: string; amount: string; currency: string; scheme: string; tx_hash: string; free?: boolean }[];
  /** What left this node's wallet in total, in `currency`. */
  total?: string;
  currency?: string;
  /** true when nothing was charged: the payment was already settled and the seller re-issued the manifest (item 273). */
  redeemed?: boolean;
  /**
   * Who this purchase actually paid, as the SELLER reported it in `x-payment-response` (item 280): address →
   * amount, the same map that goes onto the settle record. `payees` is the same thing with names and roles
   * resolved against this node's own catalogue, and `promised` marks a payee the buyer's own lineage preview
   * expected — so "revenue is split automatically with the original creators" can be checked, not just believed.
   */
  royalty?: Record<string, string>;
  payees?: { address: string; amount: string; name: string | null; role: string; knowledge: string[]; promised: boolean }[];
}

/**
 * What a purchase really costs (item 270): the price on the anchor plus every base underneath that this node does
 * not already hold. `missing` is what the buy would have to acquire, `unknown` the ones whose anchor this node has
 * never seen — their price is in nobody's total.
 */
/**
 * One address a knowledge might be bought at (item 275). `via` is the machine-readable provenance — 'peer' = a node
 * that answered this node recently, 'ledger' = its node record, 'record' = the URL frozen into the anchor, 'self' =
 * this node — so a screen can say where the answer came from in its own language.
 */
export interface GatewayCandidate { url: string; via: 'self' | 'peer' | 'ledger' | 'record'; source: string; last_seen: number | null }

export interface PatchQuote {
  patch_id: string;
  price: string;
  currency: string;
  requires: (X402Required & { held: boolean; licensed: boolean; purchased: boolean; mine: boolean })[];
  missing: string[];
  unknown: string[];
  total: string;
  self_contained: boolean;
  export: 'delta' | 'squash' | null;
  derivation: string | null;
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

/**
 * A verifier's record, computed from the ledger (item 337). Nothing here is self-reported: every number comes from
 * signed `attest` and `challenge` records this node can read.
 */
export interface VerifierProfile {
  address: string;
  name: string | null;
  endpoint: string | null;
  roles: string[];
  last_seen: number | null;
  /** Attestations this verifier has signed, and what they said. */
  attested: number;
  passed: number;
  failed: number;
  /** Integrity-only checks: the file hash and the row count, no benchmark executed. */
  hash_only: number;
  /** Deliberate re-measurements (item 339). */
  rechecks: number;
  /** Attestations that count toward a quorum today. */
  counted: number;
  /** Runs made on a table that already carried the knowledge — recorded, never counted (item 329). */
  no_baseline: number;
  knowledges: number;
  /** Distinct model-server fingerprints behind those runs: one means every attestation came off one engine. */
  executors: string[];
  /** The work, where the attestations record it (item 340). `measured_runs` is how many of them do. */
  samples_run: number;
  model_seconds: number;
  measured_runs: number;
  challenges_raised: number;
  challenges_upheld: number;
  challenges_dismissed: number;
  challenges_open: number;
  /** Attestations of theirs that somebody challenged afterwards — what a PASS has ever risked. */
  attestations_later_challenged: number;
  /** Attestations where another verifier reached the opposite verdict on the same knowledge. */
  disagreed_with_peers: number;
  first_at: number | null;
  last_at: number | null;
  items: {
    patch_id: string; name: string; status: string; passed: boolean; verified_on: string;
    score: Record<string, string | number>; created_at: number; recheck: boolean;
    samples_run: number | null; samples_available: number | null; duration_ms: number | null;
    challenged_after: boolean;
  }[];
}

/**
 * A catalog entry as THIS node reports it: the derived entry plus the author's own takedown (item 148). `retired_at`
 * is set only from a `retire` record signed by the anchor's author; a retired entry is never `sellable`.
 */
export type MarketEntry = CatalogEntry & { retired_at?: number; retire_reason?: string;
  /** Every price this knowledge has ever been sold at, oldest first (item 278) — the newest one is `anchor.price`. */
  price_history?: { price: string; currency: string; reason: string; created_at: number }[];
  /** The price on the immutable anchor, once a `price` record has changed what it sells for. */
  list_price?: string;
  repriced_at?: number };

/**
 * What one `applyPatch` did: the sentence for a log or a terminal, the chain this knowledge now sits on (ancestors
 * first, SC-15 `apply.order`), the ids actually written this time, and the whole table order afterwards.
 */
export interface ApplyOutcome { text: string; order: string[]; loaded: string[]; stack: string[] }

/** Another knowledge item on this node whose body is the same file — what `patch forget` would take down with it. */
export interface SharedBody { id: string; name: string; status: string; sales: number }
export interface ForgetResult { ok: true; patch_id: string; sha256: string; deleted_file: boolean; also_affects: SharedBody[] }

/**
 * Why a verified entry is still not for sale: the one sentence the 402 gate, `patch buy` and the web all show.
 * Two reasons reach it — an open challenge, and the author's own `retire` record (item 148); a retired knowledge is
 * not disputed, it is withdrawn, and saying "a verifier has challenged this" about it would be a lie.
 */
export function challengedMessage(e: CatalogEntry): string {
  const r = (e as MarketEntry).retire_reason;
  if (e.status === 'RETIRED') return `the publisher has retired this knowledge — it is no longer for sale${r ? ` ("${r}")` : ''}. The record stays on the ledger and buyers who already paid keep their copy.`;
  const c = e.open_challenge;
  const who = c ? `${c.challenger.slice(0, 10)}…` : 'a verifier node';
  return `a verifier has challenged this knowledge — re-verification pending, so it is not for sale${c ? ` (${who}: "${c.reason}")` : ''}`;
}

/** Case-insensitive address compare — `0xAbC…` and `0xabc…` are one node, and a supersede rule that misses that is a takeover. */
/** sha256 hex compared the way addresses are: case-insensitively, and never true for an empty one. */
const sameSha = (a: string | undefined | null, b: string | undefined | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
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
  /** SC-13: the handle *Mark wrong* sends back. Lives in memory on the node that answered the turn (see `rememberTurn`). */
  turn_id: string;
  patch_id: string; patch_ids: string[]; mode: string; base: ChatResult | null; patched: ChatResult | null;
  applied_ms: number | null; was_applied: boolean; model: string | null; benchmark_hit: boolean | null;
  applied: { patch_id: string; applied_ms: number | null; was_applied: boolean; base?: boolean }[];
  benchmark_hits: Record<string, boolean | null>;
  /** Bodies found on the shared model that this node never loaded: removed for the base answer and not put back (item 211). */
  dirty: string[];
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

/**
 * What a payment is FOR, in the terms `verifyPayment` needs (item 359): a knowledge's anchor, or a track's
 * curation fee. `patch_id` is what events are filed under (null for a track, which is not a knowledge);
 * `settlements` is the seller's own record of what this subject has already been paid, which is how a payment
 * presented twice is answered from the first sale instead of charged again.
 */
interface PaymentSubject {
  id: string;
  patch_id: string | null;
  seller: string;
  price: number;
  currency: string;
  settlements: Settlement[];
  notSold: string;
  selfBuy: string;
}

export class Market {
  /**
   * This PROCESS's id, minted at start-up and carried in `PeerInfo.instance` (item 139). Two endpoints answering for
   * one address are either one node that moved — same instance — or two nodes sharing an identity, which routes
   * buyers and verifiers to whichever registered last. The two cases are indistinguishable without this.
   */
  static readonly INSTANCE = randomBytes(8).toString('hex');
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
    // Item 314: a royalty transfer that has landed goes on the shared record, so an ancestor can join the seller's
    // promise to the money without asking the seller — and an honest seller has evidence to show.
    this.payouts.record = async (row, txHash, key) => {
      const body: PayoutRecord = {
        settle_hash: row.settle_hash, patch_id: row.patch_id, to: row.address, amount: row.amount,
        currency: row.currency, tx_hash: txHash, transfer_key: key, created_at: Date.now(),
      };
      const rec = await this.ledger.append('payout', body);
      await this.p2p?.broadcast(rec).catch(() => undefined);
    };
    this.datasets = new DatasetBlobStore(store, cfg.dataDir);
    // Item 126: `runtime.status().applied` was a hard-coded [] — `/api/info` and `ainize status` could not show what
    // was in the model. It reads the node's own stack rows now, live (never from the 30-second status cache).
    runtime.setAppliedSource(() => store.listApplied().map((a) => a.patch_id));
    // This node's own starting credit is a grant like any other (item 364): written once, counted against the same
    // cap, visible in `ainize wallet` — never a number the balance function assumes for whoever happens to ask.
    if (ledger.kind !== 'ain' && Number(cfg.market.initialCredit) > 0 && !store.getGrant(cfg.identity.address)) {
      store.putGrant(cfg.identity.address, cfg.market.initialCredit, 'this node, at startup');
    }
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

  /**
   * What one verifier has actually done, from the record (item 337).
   *
   * The verification tab printed a name and a short address with no link, the Network table listed roles and a
   * last-seen, and nothing anywhere aggregated a verifier's attestations, its FAILs, the challenges it raised, or
   * the attestations of its own that were later challenged. So a buyer weighed "node-b · Passed" exactly as heavily
   * as a key created five minutes ago, and a verifier that does careful work could not be told from one that has
   * never failed anything — which is the same as saying there is no reason to be careful.
   */
  async verifierProfile(address: string): Promise<VerifierProfile> {
    const cat = await this.catalogAll();
    const nodes = await this.knownNodes().catch(() => [] as PeerInfo[]);
    const node = nodes.find((n) => sameAddr(n.address, address)) ?? null;
    const out: VerifierProfile = {
      address, name: node?.name ?? null, endpoint: node?.endpoint ?? null, roles: node?.roles ?? [], last_seen: node?.last_seen ?? null,
      attested: 0, passed: 0, failed: 0, hash_only: 0, rechecks: 0, counted: 0, no_baseline: 0, knowledges: 0,
      executors: [], samples_run: 0, model_seconds: 0, measured_runs: 0,
      challenges_raised: 0, challenges_upheld: 0, challenges_dismissed: 0, challenges_open: 0,
      attestations_later_challenged: 0, disagreed_with_peers: 0,
      first_at: null, last_at: null, items: [],
    };
    const seenPatch = new Set<string>();
    const executors = new Set<string>();
    for (const e of cat) {
      if (e.status === 'DRAFT') continue;
      for (const ch of e.challenges) {
        if (!sameAddr(ch.challenger, address)) continue;
        out.challenges_raised++;
        const log = e.challenge_log.find((c) => c.challenge.created_at === ch.created_at);
        if (log?.state === 'upheld') out.challenges_upheld++;
        else if (log?.state === 'dismissed') out.challenges_dismissed++;
        else out.challenges_open++;
      }
      const mine = e.attestations.filter((a) => sameAddr(a.verifier, address));
      if (!mine.length) continue;
      seenPatch.add(e.anchor.id);
      for (const a of mine) {
        out.attested++;
        if (a.passed) out.passed++; else out.failed++;
        if (a.verified_on === 'hash-only') out.hash_only++;
        if (a.recheck) out.rechecks++;
        if (a.baseline === false) out.no_baseline++;
        if (a.executor?.instance) executors.add(a.executor.instance);
        if (typeof a.samples_run === 'number') { out.samples_run += a.samples_run; out.measured_runs++; }
        if (typeof a.duration_ms === 'number') out.model_seconds += Math.round(a.duration_ms / 1000);
        out.first_at = out.first_at === null ? a.created_at : Math.min(out.first_at, a.created_at);
        out.last_at = out.last_at === null ? a.created_at : Math.max(out.last_at, a.created_at);
        if (e.verifiers.some((v) => sameAddr(v, address))) out.counted++;
        // An attestation of theirs that somebody challenged afterwards: the number that separates a careful record
        // from a fast one, and the only thing a PASS has ever risked.
        if (e.challenges.some((c) => c.created_at > a.created_at && !sameAddr(c.challenger, address))) out.attestations_later_challenged++;
        // …and where this verifier's verdict differs from another verifier's on the same knowledge.
        if (e.attestations.some((b) => !sameAddr(b.verifier, address) && b.passed !== a.passed)) out.disagreed_with_peers++;
        out.items.push({
          patch_id: e.anchor.id, name: e.anchor.name, status: e.status, passed: a.passed, verified_on: a.verified_on,
          score: a.score, created_at: a.created_at, recheck: !!a.recheck,
          samples_run: a.samples_run ?? null, samples_available: a.samples_available ?? null, duration_ms: a.duration_ms ?? null,
          challenged_after: e.challenges.some((c) => c.created_at > a.created_at),
        });
      }
    }
    out.knowledges = seenPatch.size;
    out.executors = [...executors];
    out.items.sort((a, b) => b.created_at - a.created_at);
    return out;
  }

  /** Contested sales per knowledge, rebuilt with every catalogue derivation (item 347). */
  private disputeIndex = new Map<string, Dispute[]>();
  /** Every dispute record on one knowledge, newest first: the buyers' claims and the seller's answers together. */
  disputesFor(patchId: string): Dispute[] {
    return [...(this.disputeIndex.get(patchId) ?? [])].sort((a, b) => b.created_at - a.created_at);
  }
  /** How many settled sales of `seller`'s knowledge a buyer has contested, and how many the seller answered (item 347). */
  disputeRecordOf(seller: string): { raised: number; answered: number; patches: string[] } {
    const patches = new Set<string>();
    let raised = 0, answered = 0;
    for (const [id, list] of this.disputeIndex) {
      const e = this.catalogSync().find((x) => x.anchor.id === id);
      if (!e || !sameAddr(e.anchor.author, seller)) continue;
      const claims = list.filter((d) => d.role === 'claim');
      if (!claims.length) continue;
      patches.add(id);
      raised += claims.length;
      answered += claims.filter((c) => list.some((d) => d.role === 'answer' && d.settle_hash === c.settle_hash)).length;
    }
    return { raised, answered, patches: [...patches] };
  }

  /**
   * A settled buyer records that the knowledge did not work (item 347), or the seller answers one.
   *
   * Unlike a challenge this stops nothing and spends nobody's GPU: /terms is honest that a payment is final and that
   * refunds are the seller's discretion, and non-delivery is already recoverable — what had no record anywhere was
   * the one thing a buyer cannot get back, which is quality. Now the sale says it was contested, and the seller's
   * answer stands next to it on the same permanent record.
   */
  async dispute(patchId: string, reason: string, opts: { role?: 'claim' | 'answer'; settleHash?: string } = {}): Promise<Dispute> {
    const text = String(reason ?? '').trim();
    if (text.length < DISPUTE_MIN_REASON) throw new MarketError(400, `a dispute has to say what did not work — at least ${DISPUTE_MIN_REASON} characters (this is a permanent public record, and the seller answers it on the same record)`);
    const e = await this.entry(patchId);
    if (!e) throw notFound('patch not found');
    const role = opts.role ?? 'claim';
    const setts = await this.ledger.settlements(patchId);
    let settleHash = opts.settleHash;
    if (role === 'claim') {
      // Only someone who actually paid for it: the settle record IS the standing.
      const mine = setts.filter((r) => sameAddr(r.body.buyer, this.address)).sort((a, b) => b.body.created_at - a.body.created_at);
      if (!mine.length) throw conflict(`this node has not bought ${patchId} — a dispute is raised by the buyer of a settled sale, and there is no settlement here naming this address`);
      const pick = settleHash ? mine.find((r) => r.hash === settleHash) : mine[0];
      if (!pick) throw notFound(`no settlement ${settleHash} of ${patchId} names this node as the buyer`);
      settleHash = pick.hash;
    } else {
      if (!sameAddr(e.anchor.author, this.address)) throw conflict(`only the seller of ${patchId} answers a dispute about it`);
      if (!settleHash) throw new MarketError(400, 'answering a dispute needs the settle_hash of the sale it is about');
      const claim = this.disputesFor(patchId).find((d) => d.role === 'claim' && d.settle_hash === settleHash);
      if (!claim) throw notFound(`no open dispute on ${patchId} for settlement ${settleHash}`);
    }
    if (this.disputesFor(patchId).some((d) => d.role === role && d.settle_hash === settleHash && sameAddr(d.author, this.address))) {
      throw conflict(`this node has already recorded a ${role === 'claim' ? 'dispute' : 'answer'} for that sale of ${patchId} — a record is written once and stays`);
    }
    const body: Omit<Dispute, 'sig'> = {
      patch_id: patchId, role, author: this.address, settle_hash: settleHash!, reason: text.slice(0, DISPUTE_MAX_REASON), created_at: Date.now(),
    };
    const sig = signMessage(JSON.stringify([body.patch_id, body.role, body.author, body.settle_hash, body.reason]), this.cfg.identity.privateKey);
    const record: Dispute = { ...body, sig };
    const rec = await this.ledger.append('dispute', record);
    await this.p2p?.broadcast(rec).catch(() => undefined);
    this.invalidate();
    await this.catalogAll(true);        // the index disputesFor() reads is rebuilt with the catalogue

    this.log('warn', 'dispute', role === 'claim'
      ? `disputed ${patchId}: "${record.reason}" — the sale stands and the knowledge stays on sale; the seller can answer it on the record`
      : `answered the dispute on ${patchId}: "${record.reason}"`, patchId, { settle_hash: settleHash, role });
    return record;
  }

  /** Public catalog (test-visibility anchors hidden). */
  async catalog(force = false): Promise<CatalogEntry[]> {
    return (await this.catalogAll(force)).filter((e) => e.anchor.visibility !== 'test' || this.cfg.includeTestAnchors);
  }

  async catalogAll(force = false): Promise<CatalogEntry[]> {
    if (!force && this.catalogCache && Date.now() - this.catalogCache.at < 1500) return this.catalogCache.value;
    const [anchors, atts, setts, chals, sups, retires, disputes, prices] = await Promise.all([
      this.ledger.anchors(), this.ledger.attestations(), this.ledger.settlements(), this.ledger.challenges(), this.ledger.supersedes(),
      this.ledger.list({ kind: 'retire' }),
      this.ledger.disputes?.() ?? this.ledger.list({ kind: 'dispute' }).then((rs) => rs as LedgerRecord<Dispute>[]),
      this.ledger.list({ kind: 'price' }),
    ]);
    // Contested sales (item 347), grouped per knowledge, attached below the derivation the way `retire` is: a dispute
    // changes no status — it does not stop a sale and asks nobody to re-run a benchmark — it is the record that a
    // buyer said this did not work, with the seller's answer beside it.
    this.disputeIndex = new Map();
    for (const r of disputes) {
      const d = r.body;
      if (!d || typeof d.patch_id !== 'string' || typeof d.reason !== 'string' || !sameAddr(r.author, d.author)) continue;
      this.disputeIndex.set(d.patch_id, [...(this.disputeIndex.get(d.patch_id) ?? []), d]);
    }
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
    // The author's own takedown (item 148), applied over the derived status: RETIRED is terminal and outranks
    // VERIFIED / SUPERSEDED / CHALLENGED. Only a record signed by the anchor's author counts, so a stranger's
    // `retire` record cannot take a listing down the way a stranger's `supersede` record used to.
    for (const r of retires) {
      const b = r.body as Partial<RetireRecord> | null;
      if (!b || typeof b.patch_id !== 'string') continue;
      const e = value.find((x) => x.anchor.id === b.patch_id);
      if (!e || e.status === 'DRAFT' || !sameAddr(r.author, e.anchor.author)) continue;
      const at = typeof b.created_at === 'number' && b.created_at > 0 ? b.created_at : r.ts;
      const cur = e as MarketEntry;
      if (cur.retired_at !== undefined && cur.retired_at <= at) continue;
      cur.status = 'RETIRED'; cur.sellable = false; cur.retired_at = at; cur.retire_reason = typeof b.reason === 'string' ? b.reason : '';
    }
    /*
     * The author's own re-pricing (item 278), applied over the anchor the same way `retire` is.
     *
     * An anchor is immutable, and the only re-pricing there was is publishing a new one that supersedes the old:
     * verification restarts, the sales history splits in two, and a discount is indistinguishable from a new
     * version. So every price was a one-shot guess made before a single sale — usually the 0.1 default. The
     * newest `price` record signed by the anchor's own author wins; the anchor keeps its original price as
     * `list_price` and the whole history travels with the entry, so a claimed discount can be checked.
     */
    for (const r of prices) {
      const b = r.body as Partial<PriceRecord> | null;
      if (!b || typeof b.patch_id !== 'string' || typeof b.price !== 'string' || !PRICE_RE.test(b.price)) continue;
      const e = value.find((x) => x.anchor.id === b.patch_id);
      if (!e || !sameAddr(r.author, e.anchor.author)) continue;
      const at = typeof b.created_at === 'number' && b.created_at > 0 ? b.created_at : r.ts;
      const cur = e as MarketEntry;
      cur.price_history = [...(cur.price_history ?? []), { price: b.price, currency: b.currency ?? e.anchor.currency, reason: b.reason ?? '', created_at: at }]
        .sort((x, y) => x.created_at - y.created_at);
      const newest = cur.price_history[cur.price_history.length - 1];
      if (newest.created_at !== at) continue;             // an older record: recorded, not applied
      cur.list_price ??= e.anchor.price;
      cur.anchor = { ...e.anchor, price: b.price };
      cur.repriced_at = at;
    }
    this.catalogCache = { at: Date.now(), value };
    this.noticeOwnEvents(value);
    this.noticePurchasedEvents(value);
    this.noticeLineageEvents(value);
    return value;
  }

  /**
   * The same three things, seen from the other side of the sale (item 346).
   *
   * `noticeOwnEvents` scans only entries this node AUTHORED, so a challenge, a failed verification or a supersede
   * reached the seller and nobody else. The buyer had already paid, had the knowledge loaded in their model, and was
   * still serving its answers — with no signal anywhere. The terms promise that a challenge "stops the sale" and say
   * nothing at all about the people who already bought.
   */
  private noticePurchasedEvents(entries: CatalogEntry[]): void {
    if (!this.notifies('money')) return;                  // item 319: "None" means none, and nothing is marked seen
    const mine = this.store.listPurchases();
    if (!mine.length) return;
    const byId = new Map(entries.map((e) => [e.anchor.id, e]));
    for (const p of mine) {
      const e = byId.get(p.patch_id);
      if (!e || sameAddr(e.anchor.author, this.address)) continue;      // our own knowledge is `noticeOwnEvents`' job
      const fails = e.attestations.filter((a) => !a.passed);
      if (!e.open_challenge && !e.superseded_by.length && !fails.length) continue;
      const key = `buyer_notified:${e.anchor.id}`;
      const seen = new Set<string>(JSON.parse(this.store.get(key) ?? '[]') as string[]);
      const before = seen.size;
      const loaded = this.isApplied(e.anchor.id);
      const where = loaded ? ' — it is loaded in your model right now' : '';
      const once = (mark: string, level: EventRow['level'], kind: string, message: string, data?: unknown) => {
        if (seen.has(mark)) return;
        seen.add(mark);
        this.log(level, kind, message, e.anchor.id, data);
      };
      const c = e.open_challenge;
      if (c) once(`challenge:${c.challenger}:${c.created_at}`, 'warn', 'challenge',
        `${c.challenger.slice(0, 10)}… challenged ${e.anchor.id}, which you bought for ${p.amount}: "${c.reason}"${where}. It is off sale until verifiers re-run its benchmark.`,
        { challenger: c.challenger, reason: c.reason, created_at: c.created_at, purchased_at: p.created_at, applied: loaded });
      for (const a of fails) once(`fail:${a.verifier}:${a.created_at}`, 'warn', 'verify',
        `${a.verifier_name ?? a.verifier.slice(0, 10)} verified ${e.anchor.id}, which you bought, and it FAILED (${a.verified_on}): ${JSON.stringify(a.score)}${where}`,
        { verifier: a.verifier, score: a.score, applied: loaded });
      for (const newer of e.superseded_by) once(`supersede:${newer}`, 'info', 'publish',
        `${newer} supersedes ${e.anchor.id}, which you bought — the version you are serving is no longer the newest`, { superseded_by: newer, applied: loaded });
      if (seen.size !== before) this.store.set(key, JSON.stringify([...seen]));
    }
  }

  /**
   * Which of the derived notices this operator asked for (item 319). `notifications` lived in the settings schema,
   * the getter, the setter and the Account form, and NOTHING read it: "Sales only" and "None" changed nothing at all.
   *
   *  - `all`   — everything below;
   *  - `sales` — money, and anything that STOPS money: a sale, a royalty, a challenge, a FAIL, a supersede or a
   *              byte-for-byte copy of your knowledge. Those are what "my knowledge sells" is made of, so they are
   *              never silenced by a preference about notifications;
   *  - `none`  — no derived notices. The underlying records are still on the ledger and on every page; this is the
   *              feed, not the facts.
   */
  private notifies(kind: 'money' | 'sale_stopper' | 'lineage' | 'track'): boolean {
    const level = this.settings().notifications;
    if (level === 'all') return true;
    if (level === 'none') return false;
    return kind === 'money' || kind === 'sale_stopper';
  }

  /**
   * The two things that happen AROUND an author's knowledge and used to reach them as "received 1 record(s) via
   * push" — or as nothing at all (items 183, 195, 318, 319).
   *
   *  - somebody published a knowledge that names one of ours as its base. There is no consent step anywhere in the
   *    protocol (anyone may declare any public anchor as a parent), so the least the base's creator is owed is to be
   *    TOLD: who, at what price, and whether that price undercuts their own.
   *  - a settlement somewhere on the network paid us a lineage share. `noticeOwnEvents` skips every entry this node
   *    did not author, so the one signal that should make a creator publish more — "someone built on this and it
   *    paid" — never fired.
   *
   * Derived from the catalogue like the other two passes, so it works on both ledgers and on records that arrived
   * by any route; each notice is written exactly once, keyed in the store.
   */
  private noticeLineageEvents(entries: CatalogEntry[]): void {
    const mine = new Map(entries.filter((e) => sameAddr(e.anchor.author, this.address) && e.status !== 'DRAFT').map((e) => [e.anchor.id, e]));
    if (!mine.size) return;
    const byId = new Map(entries.map((e) => [e.anchor.id, e]));
    const key = 'lineage_notified';
    const seen = new Set<string>(JSON.parse(this.store.get(key) ?? '[]') as string[]);
    const before = seen.size;
    const once = (mark: string, level: EventRow['level'], kind: string, message: string, patchId: string | null, data?: unknown) => {
      if (seen.has(mark)) return;
      seen.add(mark);
      this.log(level, kind, message, patchId, data);
    };
    for (const e of entries) {
      if (e.status === 'DRAFT' || sameAddr(e.anchor.author, this.address)) continue;
      // 1) a child of ours, published by somebody else (items 183, 318)
      for (const pid of e.anchor.parents ?? []) {
        const parent = mine.get(pid);
        if (!parent) continue;
        const cheaper = Number(e.anchor.price || 0) < Number(parent.anchor.price || 0);
        if (this.notifies('lineage')) {
          once(`derived:${e.anchor.id}:${pid}`, cheaper ? 'warn' : 'info', 'lineage',
            `${e.anchor.name || e.anchor.id} by ${e.anchor.author_name ?? e.anchor.author.slice(0, 10)}… was published built on your ${pid}, at ${e.anchor.price} ${e.anchor.currency}`
            + `${cheaper ? ` — below your own ${parent.anchor.price} ${parent.anchor.currency}, and it carries your rows` : ''}`
            + `. Every sale of it pays you a share of ${Math.round(effectiveRoyaltyShare(e.anchor, this.cfg.market.royaltyShare ?? 0) * 100)} %; nobody asked your permission, and nobody can take the credit off the record.`,
            pid, { child: e.anchor.id, child_author: e.anchor.author, child_price: e.anchor.price, currency: e.anchor.currency, parent: pid, cheaper_than_parent: cheaper });
        }
      }
      // 2) money one of those sales paid us (item 319)
      if (!this.notifies('money')) continue;
      for (const st of e.settlements) {
        const paid = Object.entries(st.royalty ?? {}).find(([addr]) => sameAddr(addr, this.address))?.[1];
        if (!paid || Number(paid) <= 0) continue;
        const via = this.ancestorsOfMine(e, byId);
        once(`royalty:${st.tx_hash}`, 'info', 'royalty',
          `earned ${paid} ${st.currency} from ${e.anchor.id}, sold by ${e.anchor.author_name ?? e.anchor.author.slice(0, 10)}…`
          + `${via.length ? ` — it was built on your ${via.join(', ')}` : ''}`,
          via[0] ?? e.anchor.id, { amount: paid, currency: st.currency, child: e.anchor.id, seller: e.anchor.author, via, tx_hash: st.tx_hash });
      }
    }
    if (seen.size !== before) this.store.set(key, JSON.stringify([...seen].slice(-4000)));
  }

  /** The knowledges of ours a sale of `e` pays for: the nearest ancestors of `e` this node authored (cycle-safe). */
  private ancestorsOfMine(e: CatalogEntry, byId: Map<string, CatalogEntry>): string[] {
    const out: string[] = [];
    const seen = new Set<string>([e.anchor.id]);
    const queue = [...(e.anchor.parents ?? [])];
    for (let i = 0; i < queue.length && seen.size < 512; i++) {
      const id = queue[i];
      if (seen.has(id)) continue;
      seen.add(id);
      const p = byId.get(id);
      if (!p) continue;
      if (sameAddr(p.anchor.author, this.address)) { if (!out.includes(id)) out.push(id); continue; }   // stop at ours: it is what earned
      queue.push(...(p.anchor.parents ?? []));
    }
    return out;
  }

  /**
   * What derivatives of one of our knowledges have actually paid us (items 195, 318): every settlement of a
   * descendant whose royalty map names this node, attributed to the knowledge of ours that earned it.
   *
   * The wallet listed `pixel-deriv-b 3 · pixel-deriv-c 1.5` with nothing linking any of it to the knowledge those
   * children were built on, so "what did I earn from derivatives of X" had no answer on any surface.
   */
  async derivativeEarnings(id: string, map?: Map<string, CatalogEntry>): Promise<{ patch_id: string; currency: string; amount: string; sales: number; children: { id: string; name: string; author: string; author_name: string | null; status: string; price: string; currency: string; sales: number; amount: string }[] }> {
    const all = map ?? await this.entryMap();
    const me = all.get(id);
    const currency = me?.anchor.currency ?? this.cfg.market.currency;
    const children: { id: string; name: string; author: string; author_name: string | null; status: string; price: string; currency: string; sales: number; amount: string }[] = [];
    let total = 0; let sales = 0;
    for (const e of all.values()) {
      if (e.status === 'DRAFT' || e.anchor.id === id) continue;
      if (!this.ancestorsOfMine(e, all).includes(id)) continue;
      let amount = 0; let n = 0;
      for (const st of e.settlements) {
        const paid = Object.entries(st.royalty ?? {}).find(([addr]) => sameAddr(addr, this.address))?.[1];
        if (!paid || Number(paid) <= 0) continue;
        amount += Number(paid); n++;
      }
      total += amount; sales += n;
      children.push({
        id: e.anchor.id, name: e.anchor.name, author: e.anchor.author, author_name: e.anchor.author_name ?? null, status: e.status,
        price: e.anchor.price, currency: e.anchor.currency, sales: n, amount: String(Math.round(amount * 1e6) / 1e6),
      });
    }
    return { patch_id: id, currency, amount: String(Math.round(total * 1e6) / 1e6), sales, children: children.sort((a, b) => Number(b.amount) - Number(a.amount)) };
  }

  /**
   * The three things that happen TO an author's knowledge — a challenge, a supersede, a failed verification — used to
   * arrive as an anonymous "received 1 record(s) via push" and change the listing silently (item 156). Whatever path
   * the record took (p2p push, gossip pull, a chain read), the author's node logs each of them exactly once, with who,
   * why and what it means. Derived here rather than at ingest so it works on both ledgers.
   */
  private noticeOwnEvents(entries: CatalogEntry[]): void {
    if (!this.notifies('sale_stopper')) return;           // item 319: only "None" silences these — they stop sales
    // A byte-identical republish of one of our knowledges by another node (item 363) is the fourth notable thing:
    // it is not a supersede any more, but the author still has to hear about it — with the copy's id, its author
    // and its price, which is the whole of what they need to answer it.
    const bySha = new Map<string, CatalogEntry[]>();
    const byId = new Map<string, CatalogEntry>();
    for (const e of entries) {
      byId.set(e.anchor.id, e);
      if (e.status === 'DRAFT') continue;
      bySha.set(e.anchor.patch_sha256, [...(bySha.get(e.anchor.patch_sha256) ?? []), e]);
    }
    for (const e of entries) {
      if (!sameAddr(e.anchor.author, this.address)) continue;
      const copies = e.status === 'DRAFT' ? [] : (bySha.get(e.anchor.patch_sha256) ?? []).filter((x) => !sameAddr(x.anchor.author, this.address) && x.anchor.created_at > e.anchor.created_at);
      if (!e.open_challenge && !e.superseded_by.length && !copies.length && !e.attestations.some((a) => !a.passed)) continue;   // nothing notable: no store read
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
      for (const cp of copies) once(`copy:${cp.anchor.id}`, 'warn', 'publish',
        `${cp.anchor.author_name ?? cp.anchor.author.slice(0, 10)}… published ${cp.anchor.id} — the same knowledge file as your ${e.anchor.id}, byte for byte (sha ${e.anchor.patch_sha256.slice(0, 12)}…), at ${cp.anchor.price} ${cp.anchor.currency}. It cannot retire your listing, and you are not paid for it.`,
        { copy_id: cp.anchor.id, copy_author: cp.anchor.author, price: cp.anchor.price, sha256: e.anchor.patch_sha256 });
      for (const newer of e.superseded_by) {
        // Item 251: every morning's bake raised a WARN telling the publisher that their own new version had retired
        // their own old one — five of them in ten minutes on a daily track, burying the one warning that matters
        // (somebody ELSE retired your listing, or a verifier failed it). Your own replacement on your own branch is
        // the expected outcome of publishing, so it is `info` and reads like it; anyone else's stays a warning.
        const n = byId.get(newer);
        const own = !!n && sameAddr(n.anchor.author, this.address) && (n.anchor.branch ?? '') === (e.anchor.branch ?? '');
        once(`supersede:${newer}`, own ? 'info' : 'warn', 'publish',
          own
            ? `your ${newer} replaces ${e.anchor.id} — buyers of the older one now see "Newer version available"`
            : `${newer}${n ? ` by ${n.anchor.author_name ?? n.anchor.author.slice(0, 10)}…` : ''} supersedes your knowledge ${e.anchor.id} — buyers now see "Newer version available" on it`,
          { superseded_by: newer, same_author: own });
      }
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
    const asOf = Market.validateAsOf(input.as_of);
    const { blob, sketch } = await this.blobs.importFile(input.file, { copy: !input.keepInPlace });
    const benchmark: BenchmarkSpec = { ...input.benchmark, format: input.benchmark.format ?? ['template'] };
    await this.refuseDuplicateBody(blob.sha256, benchmark.schema, input.branch, !!input.force);
    await this.refuseUnservableModel(input.model?.id_M, !!input.force);
    const parents = (input.parents ?? []).filter(Boolean);
    const map = await this.resolveParents(parents);
    const parent0 = parents.length ? map.get(parents[0])!.anchor : null;
    const anchor: PatchAnchor = {
      id, name: input.name, description: input.description ?? '', author: this.address, author_name: this.cfg.name,
      model: { row_dim: blob.row_dim, ...input.model } as PatchAnchor['model'],
      patch_sha256: blob.sha256, size_bytes: blob.size_bytes, rows: blob.rows,
      benchmark, benchmark_hash: hashCanonical({ schema: benchmark.schema, queries: benchmark.queries, format: benchmark.format, collateral_bound_nat: benchmark.collateral_bound_nat, samples: benchmark.samples ?? [] }),
      price, currency: this.cfg.market.currency, billing: input.billing ?? 'per_download',
      license: input.license, parents, parent_authors: parents.map((p) => map.get(p)!.anchor.author),
      // A child belongs where its base is (item 189). Publishing with `--parents krx-all-2761` used to file the
      // knowledge under `patches/<model slug>` and no branch, so it never appeared as "other knowledge on this
      // subject" from the page of the very knowledge it was built on. An explicit --topic / --branch still wins.
      branch: input.branch ?? parent0?.branch, topic_path: input.topic_path ?? parent0?.topic_path ?? `patches/${(input.model?.id_M ?? 'model').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      recipe: input.recipe, created_at: Date.now(), addr_sketch: sketch, visibility: input.visibility ?? 'public',
      // item 267: the day the DATA is true of, when the publisher declares one — never inferred from the file
      ...(asOf ? { as_of: asOf } : {}),
      // What this knowledge promises the people it was built on and the people who verify it, written into the
      // immutable record (items 191, 325). Before this the split was read from the SELLING node's config at settle
      // time, so a derivative's seller could set `market.royaltyShare` to 0 and keep the base creator's share while
      // her page still said 30 %. A child may promise MORE than its parents did; it can never promise less.
      royalty_share: Math.min(1, Math.max(
        NETWORK_MIN_ROYALTY_SHARE, this.cfg.market.royaltyShare ?? 0,
        ...parents.map((p) => effectiveRoyaltyShare(map.get(p)!.anchor, this.cfg.market.royaltyShare ?? 0)),
      )),
      verifier_share: effectiveVerifierShare(undefined, this.cfg.market.verifierShare),
    };
    const contributors = this.checkContributors(input.contributors);
    if (contributors.length) anchor.contributors = contributors;
    if (input.origin) anchor.origin = input.origin;
    if (input.dataset) anchor.dataset = input.dataset;
    if (input.derivation) anchor.derivation = input.derivation;
    else if (input.kind) anchor.derivation = this.measureDerivation(input.kind, parents, map, blob.sha256);
    if (input.base) anchor.base = input.base;
    // the lineage invariant (design §5.1) for anchors THIS node writes: every base / dataset parent is a parent
    const problems = lineageProblems(anchor);
    if (problems.length) throw badInput(problems.join('; '));
    this.store.putDraft(anchor, blob.path);
    this.invalidate();
    this.log('info', 'patch', `draft created: ${id} (${blob.rows} rows, ${(blob.size_bytes / 1e6).toFixed(1)} MB)`, id);
    return anchor;
  }

  /**
   * What ONE sale of this knowledge pays, to whom, by name (items 189, 318) — computed by the same function that
   * will settle it (`royaltyPlan`), so the preview and the receipt can never disagree.
   *
   * A publisher who typed `--parents krx-all-2761 --price 3` was told `✓ draft created` and nothing else: the split
   * was first visible on the first settlement, and the parent's own price was on no screen at all — so a 0.5-credit
   * child of a 10-credit base looked like a normal listing rather than the thing that undercuts its own ancestor.
   */
  async saleSplit(entry: CatalogEntry, amount?: number, map?: Map<string, CatalogEntry>): Promise<SaleSplit> {
    const all = new Map(map ?? await this.entryMap());
    all.set(entry.anchor.id, entry);                       // a DRAFT the catalogue snapshot does not carry yet
    const price = amount ?? Number(entry.anchor.price || 0);
    const plan = royaltyPlan(entry, all, price, this.cfg.market.royaltyShare ?? 0, { verifierShare: this.cfg.market.verifierShare, verifiers: entry.verifiers });
    const seller = entry.anchor.author;
    // Which knowledge each ancestor address is being paid FOR — walked exactly as royaltyPlan walks it.
    const forAddress = new Map<string, string[]>();
    const seen = new Set<string>([entry.anchor.id]);
    const walk = (ids: string[], depth: number) => {
      if (depth > TREE_MAX_DEPTH) return;
      for (const id of ids) {
        const e = all.get(id);
        if (!e || seen.has(id)) continue;
        seen.add(id);
        const k = e.anchor.author.toLowerCase();
        forAddress.set(k, [...(forAddress.get(k) ?? []), e.anchor.id]);
        for (const c of e.anchor.contributors ?? []) forAddress.set(c.address.toLowerCase(), [...(forAddress.get(c.address.toLowerCase()) ?? []), e.anchor.id]);
        walk(e.anchor.parents ?? [], depth + 1);
      }
    };
    walk(entry.anchor.parents ?? [], 0);
    const nameOf = (address: string): string | null => {
      if (sameAddr(address, seller)) return entry.anchor.author_name ?? this.cfg.name;
      const first = forAddress.get(address.toLowerCase())?.[0];
      const anc = first ? all.get(first) : undefined;
      return anc?.anchor.author_name ?? (entry.anchor.contributors ?? []).find((c) => sameAddr(c.address, address))?.name ?? null;
    };
    const lines = Object.entries(plan.royalty).map(([address, amt]) => ({
      address, amount: amt, name: nameOf(address),
      role: (sameAddr(address, seller) ? 'seller'
        : plan.verification[address] !== undefined ? 'verifier'
        : forAddress.has(address.toLowerCase()) ? 'ancestor' : 'contributor') as SaleSplit['lines'][number]['role'],
      knowledge: forAddress.get(address.toLowerCase()) ?? [],
    })).sort((a, b) => Number(b.amount) - Number(a.amount));
    const parents = (entry.anchor.parents ?? []).map((id, i) => {
      const e = all.get(id);
      return {
        id, name: e?.anchor.name ?? id, price: e?.anchor.price ?? null, currency: e?.anchor.currency ?? entry.anchor.currency,
        author: e?.anchor.author ?? entry.anchor.parent_authors?.[i] ?? null, author_name: e?.anchor.author_name ?? null, status: e?.status ?? null,
      };
    });
    return {
      patch_id: entry.anchor.id, amount: String(price), currency: entry.anchor.currency,
      share: plan.share, verifier_share: plan.verifier_share, lines, parents,
      // Item 318: the bases this listing is cheaper than. A child carries its parent's rows, so a price below the
      // base's is the base at a discount — the ancestor's per-sale take falls from their own price to a royalty slice.
      cheaper_than: parents.filter((p) => p.price !== null && Number(p.price) > price).map((p) => ({ id: p.id, price: p.price!, currency: p.currency })),
      unresolved: plan.unresolved,
      /*
       * Item 322 — the rule that decides all of this lived in a source comment. The lineage pool is split equally
       * between unique ancestor AUTHORS at any depth, so naming two knowledges by one author costs exactly what
       * naming one costs, and naming a second author halves what the first receives; each author's slice is then
       * divided among their own anchors, and their data providers carve from that slice. A creator choosing
       * between one base and two, or deciding whether declaring a data provider is affordable, was making a
       * permanent revenue decision with no number and no rule in front of them.
       */
      rule: `${Math.round(plan.share * 100)}% of every sale is shared with the knowledge this one is built on. That pool is divided equally between the distinct CREATORS in the lineage, at any depth — naming two knowledges by the same creator costs the same as naming one, and naming a second creator halves the first one's share. Each creator's slice is then split among their own knowledges, and their data providers take their share out of it. The rest is yours, less ${Math.round(plan.verifier_share * 100)}% to the verifiers that keep it on sale.`,
      payees: lines.length,
      // Item 366: what this sale costs to settle on this chain, measured — never an estimate. One settlement plus
      // (when anyone else is owed) one batched transfer, at the average gas this node's own writes have cost.
      cost: this.saleCost(lines.length),
    };
  }

  /**
   * What one sale costs this node in gas, from what its own writes have actually cost (item 366).
   *
   * `defaultPrice` is 0.1 and every royalty line used to be its own transfer; the product's own estimate is
   * ~0.19 AIN of gas around a 0.1 AIN purchase at `min_gas_price 500`, so the default price made every sale a loss
   * on the network the product is heading to, multiplied by the number of payees. Payouts are batched now (one
   * settle + one transfer), and this reports the floor from MEASURED gas — null on a chain that has charged this
   * node nothing yet, where a made-up number would be worse than none.
   */
  saleCost(payees: number): { writes: number; gas_avg: number; floor: string; measured_writes: number } | null {
    const stats = this.ledger instanceof AinLedger ? this.ledger.gasStats() : null;
    if (!stats || stats.avg <= 0) return null;
    const writes = 1 + (payees > 1 ? 1 : 0);              // the settlement, plus one batched payout transfer
    const floor = Math.round(writes * stats.avg * 1e6) / 1e6;
    return { writes, gas_avg: stats.avg, floor: String(floor), measured_writes: stats.writes };
  }

  /**
   * Every parent of a draft, resolved — not merely looked up (item 175).
   *
   * `createDraft` used to answer `unknown parent patch: pixel-base` and stop, because the id was not yet in THIS
   * node's entry map. A publisher who trained on someone else's knowledge and sells from their own node therefore
   * had to guess that the seller must first be a peer; the alternative they took was publishing a root with no
   * credit, which is exactly what the royalty system exists to prevent. So before refusing: re-read the ledger
   * (another node may have written the anchor seconds ago), then ask the peers this node already talks to for the
   * records of that id and ingest them — signature-checked by `ledger.ingest` like any other gossiped record. Only
   * when that finds nothing is it an error, and the error names the remedy.
   */
  private async resolveParents(parents: string[]): Promise<Map<string, CatalogEntry>> {
    let map = await this.entryMap();
    let missing = parents.filter((p) => !map.has(p));
    if (!missing.length) return map;
    await this.refreshLedger().catch(() => undefined);
    map = await this.entryMap();
    missing = parents.filter((p) => !map.has(p));
    if (!missing.length) return map;
    const tried: string[] = [];
    for (const id of [...missing]) {
      for (const peer of this.store.listPeers()) {
        if (!peer.endpoint) continue;
        if (!tried.includes(peer.endpoint)) tried.push(peer.endpoint);
        const got = await this.pullAnchorFrom(peer.endpoint, id);
        if (!got) continue;
        this.invalidate();
        map = await this.entryMap();
        if (map.has(id)) { this.log('info', 'patch', `parent ${id} was not on this node — fetched its record from ${peer.endpoint}`, id, { from: peer.endpoint }); break; }
      }
    }
    missing = parents.filter((p) => !map.has(p));
    if (!missing.length) return map;
    const where = tried.length ? ` This node asked ${tried.join(', ')} and none of them has it.` : ' This node has no peers, so it has never seen anything published elsewhere.';
    throw badInput(
      `unknown_parent: ${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} not known to this node, so nothing here can record it as a base.${where} Add the node that sells it and try again: \`ainize peers add <its url>\` (the anchor arrives within a gossip round, ~10 s). Publishing without the link would list this as a new root, with no credit and no royalty to its creator.`,
      { code: 'unknown_parent', missing, peers_tried: tried },
    );
  }

  /** Ask one peer for the ledger records of `id` and ingest the anchor among them. True when something was accepted. */
  private async pullAnchorFrom(endpoint: string, id: string): Promise<boolean> {
    try {
      const res = await fetch(`${endpoint.replace(/\/+$/, '')}/api/patches/${encodeURIComponent(id)}/records`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return false;
      const body = await res.json() as { records?: LedgerRecord[] };
      let added = false;
      for (const rec of body.records ?? []) {
        try { if (await this.ledger.ingest(rec)) added = true; } catch { /* a record this ledger will not take is not an error of the publish */ }
      }
      return added;
    } catch { return false; }
  }

  /**
   * What a child DID to its bases, measured (item 188).
   *
   * A derivative could only ever be published as a new root-style listing with a declared parent and no claim at
   * all about the relationship: no version, no correction, no fork, so the family tree drew every child with the
   * same dashed "declared" edge and a buyer could not tell a correction from an unrelated sibling. The kind is the
   * publisher's declaration; the numbers under it are this node's measurement of the two address sets, because a
   * publisher typing their own `changed_rows` is a claim nobody can check.
   */
  private measureDerivation(kind: DerivationKind, parents: string[], map: Map<string, CatalogEntry>, sha: string): PatchAnchor['derivation'] {
    const mine = this.blobs.addrSet(sha);
    if (!mine) throw conflict(`cannot measure what this ${kind}s: the file just imported has no address set on this node`, { code: 'derivation_unmeasurable' });
    if (!parents.length) throw badInput(`--kind ${kind} says what this knowledge is to its base, so it needs one: pass --parents <id>`);
    // `update` is "this is my next version of that": only the base's own author may say it, or a buyer could list a
    // knowledge that presents itself as the newer version of somebody else's.
    if (kind === 'update') {
      const notMine = parents.filter((id) => !sameAddr(map.get(id)!.anchor.author, this.address));
      if (notMine.length) {
        throw conflict(
          `--kind update says this is your next version of ${notMine.join(', ')}, which ${notMine.length > 1 ? 'were' : 'was'} published by somebody else. Build on it instead (--kind extend), or say what you disagree with (--kind contradict).`,
          { code: 'not_your_version', patch_ids: notMine },
        );
      }
    }
    const bases: { patch_id: string; patch_sha256: string; rows: number }[] = [];
    const covered = new Set<bigint>();
    for (const id of parents) {
      const e = map.get(id)!;
      const set = this.blobs.addrSet(e.anchor.patch_sha256);
      if (!set) {
        throw conflict(
          `cannot measure what this ${kind}s about ${id}: its file is not on this node, and the row counts on the record are measured here, never typed. Get the body first (\`ainize patch buy ${id}\`), or publish without --kind — the parent is still credited and still paid.`,
          { code: 'base_not_held', patch_id: id },
        );
      }
      for (const a of set) covered.add(a);
      bases.push({ patch_id: id, patch_sha256: e.anchor.patch_sha256, rows: e.anchor.rows });
    }
    let changed = 0;
    for (const a of mine) if (covered.has(a)) changed++;
    // A knowledge file writes rows; it cannot delete a base's row, so `removed_rows` is 0 on this path and says so.
    return { kind, bases, added_rows: mine.length - changed, changed_rows: changed, removed_rows: 0 };
  }

  /**
   * The bytes are the product, so the ledger may not carry them twice (items 240, 363).
   *  - another author's body: refused outright, with no override. Buying a knowledge does not make you its publisher;
   *    a byte-identical resale used to list as a new root at any price AND retire the original (363).
   *  - our own body on the same subject and branch: refused unless `force`. A re-bake that changed nothing used to
   *    become a fresh anchor that superseded the genuinely newer version of the same knowledge (240). The same bytes
   *    benchmarked on a DIFFERENT schema, or kept on another branch, coexist by design and stay allowed.
   */
  private async refuseDuplicateBody(sha: string, schema: string, branch: string | undefined, force: boolean): Promise<void> {
    const same = (await this.catalogAll()).filter((e) => e.anchor.patch_sha256 === sha && e.status !== 'DRAFT');
    if (!same.length) return;
    const foreign = same.find((e) => !sameAddr(e.anchor.author, this.address));
    if (foreign) {
      throw conflict(
        `duplicate_body: these exact bytes are already on the record as ${foreign.anchor.id} by ${foreign.anchor.author_name ?? foreign.anchor.author} — you cannot publish another node's knowledge as your own. Build on it instead (--parents ${foreign.anchor.id}, and train your own rows on top), and its author keeps earning from every sale of yours.`,
        { code: 'duplicate_body', existing_id: foreign.anchor.id, existing_status: foreign.status, existing_author: foreign.anchor.author, sha256: sha },
      );
    }
    if (force) return;
    const mine = same.find((e) => e.anchor.benchmark.schema === schema && (e.anchor.branch ?? '') === (branch ?? ''));
    if (!mine) return;
    throw conflict(
      `duplicate_body: identical to ${mine.anchor.id} (published ${new Date(mine.anchor.created_at).toISOString().slice(0, 10)}, ${mine.status}) — the file has not changed, so this would publish the same knowledge twice and retire your newer versions of it. Publish the new bake, or pass --force to register these bytes again anyway.`,
      { code: 'duplicate_body', existing_id: mine.anchor.id, existing_status: mine.status, existing_author: mine.anchor.author, sha256: sha },
    );
  }

  /**
   * A one-character typo in `--model` used to produce a permanent anchor no verifier could ever execute: verifiers
   * find no compatible runtime, fall back to hash-only, and catalog.ts refuses to count that for an anchor shipping
   * samples — so it sits at ANNOUNCED 0/2 for ever, and the id is burned (item 154). This node knows which model it
   * serves; compare before writing anything. Unknown (serving API unreachable) never blocks a publish.
   */
  private async refuseUnservableModel(modelId: string | undefined, force: boolean): Promise<void> {
    if (!modelId || force) return;
    const rt = await this.runtime.status().catch(() => null);
    if (!rt?.model || rt.model === modelId) return;
    throw badInput(
      `model_mismatch: this node serves ${rt.model}, and nothing here can test knowledge for ${modelId} — verifiers would fall back to a hash-only check, which never lists an anchor that ships samples. Pass --model ${rt.model}, or --force to publish for a model this node cannot test.`,
      { code: 'model_mismatch', runtime_model: rt.model, requested: modelId },
    );
  }

  /** validateContributors + "the publishing node cannot be its own data provider" (its slice is the seller remainder already). */
  private checkContributors(list: unknown): Contributor[] {
    const out = validateContributors(list);
    if (out.some((c) => c.address.toLowerCase() === this.address.toLowerCase())) throw new ValidationError('contributor.address must not be this node\'s own address');
    return out;
  }

  /**
   * `as_of` is a DAY, not a timestamp (item 267): `YYYY-MM-DD`, a real date, and never in the future — a data date
   * that has not happened yet is a typo, and it would sort a stale bake to the top of "freshest data".
   */
  static validateAsOf(value: string | undefined | null): string | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    const v = String(value).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw badInput(`as_of must be a date in YYYY-MM-DD form (got "${v}") — it is the day the data is true of, not a time`);
    const d = new Date(`${v}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw badInput(`as_of is not a real date: ${v}`);
    if (d.getTime() > Date.now() + 36 * 3600_000) throw badInput(`as_of ${v} is in the future — it is the day the data is true of`);
    return v;
  }

  updateDraft(id: string, patch: Partial<Pick<PatchAnchor, 'name' | 'description' | 'price' | 'branch' | 'benchmark' | 'license' | 'billing' | 'topic_path' | 'contributors' | 'origin' | 'visibility' | 'recipe' | 'dataset' | 'derivation' | 'base' | 'parents' | 'as_of'>>): PatchAnchor {
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
    if ('as_of' in patch) { const v = Market.validateAsOf(patch.as_of); if (v) anchor.as_of = v; else delete anchor.as_of; }
    if ('origin' in patch && patch.origin !== undefined && patch.origin !== 'operator' && patch.origin !== 'teach') throw new ValidationError('origin must be "operator" or "teach"');
    if ('visibility' in patch && patch.visibility !== undefined && patch.visibility !== 'public' && patch.visibility !== 'test') throw new ValidationError('visibility must be "public" or "test"');
    if (patch.benchmark) anchor.benchmark_hash = hashCanonical({ schema: anchor.benchmark.schema, queries: anchor.benchmark.queries, format: anchor.benchmark.format, collateral_bound_nat: anchor.benchmark.collateral_bound_nat, samples: anchor.benchmark.samples ?? [] });
    this.store.putDraft(anchor, d.file_path);
    this.invalidate();
    return anchor;
  }

  /**
   * Item 157 — `draft not found` was the whole answer for five different situations: a REJECTED anchor, a VERIFIED
   * one, an ANNOUNCED one, a draft somebody else's node holds, and an id that never existed. A publisher looking at
   * `krx-ticker-codes ANNOUNCED` one line above in `patch ls` was told it does not exist, which sends people
   * hunting for a sync bug instead of reading the status. `forgetBody` has said the right thing for a draft since
   * item 156; this is the same courtesy in the other direction. The id is only "not found" when it really is.
   */
  private noDraft(id: string, verb: 'delete' | 'announce'): Error {
    const e = this.catalogSync().find((x) => x.anchor.id === id);
    if (!e) return notFound(`no knowledge with the id "${id}" on this node — \`ainize patch ls --drafts\` lists what is here`);
    if (e.status === 'REJECTED') {
      return conflict(`${id} was REJECTED by verifiers, and its record is public — it cannot be deleted or re-announced. Publish a corrected version under a NEW id with \`ainize publish <file>.npz --id <new-id> --parents ${id}\`, which keeps the lineage and the credit.`, { code: 'not_a_draft', patch_id: id, status: e.status });
    }
    return conflict(verb === 'delete'
      ? `${id} is ${e.status} — announced knowledge cannot be deleted, because its record is public and buyers may hold the file. Take it off sale with \`ainize patch retire ${id}\`, drop this node's copy with \`ainize patch forget ${id}\`, or publish a replacement with \`ainize publish <file>.npz --parents ${id}\`.`
      : `${id} is already ${e.status} — it is on the public record, so there is nothing left to announce. Publish a new version with \`ainize publish <file>.npz --parents ${id}\` to replace it.`,
      { code: 'not_a_draft', patch_id: id, status: e.status });
  }

  deleteDraft(id: string) {
    const d = this.store.getDraft(id);
    if (!d) throw this.noDraft(id, 'delete');
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
      // …except when the child declares it is the next VERSION of that base (`--kind update`, item 188): a version
      // pair is exactly what a supersede is for, so it stays in the list and the announce asks about it.
      const versionOf = (child: PatchAnchor, base: PatchAnchor) => child.derivation?.kind === 'update' && (child.derivation.bases ?? []).some((b) => b.patch_id === base.id);
      if ((Market.isTrainedOnTop(me.anchor, e.anchor) && !versionOf(me.anchor, e.anchor))
        || (Market.isTrainedOnTop(e.anchor, me.anchor) && !versionOf(e.anchor, me.anchor))) continue;
      const set = this.blobs.addrSet(e.anchor.patch_sha256);
      if (!set) continue;
      const n = intersectionCount(mine, set);
      // A DECLARED parent (no `derivation`/`base` on the child — every anchor written before those fields, and every
      // `publish --parents`) overlaps its base for the same reason a trained add-on does. It used to be listed as
      // `yes → conflicting knowledge` one block below the same id under "parents", and queued as a supersede of the
      // very knowledge it credits (item 189). It is reported as what it is now, and never retires anything.
      const lineage = me.anchor.parents.includes(e.anchor.id) ? 'parent' as const : e.anchor.parents.includes(me.anchor.id) ? 'child' as const : null;
      if (n > 0) out.push({
        patch_id: e.anchor.id, overlap_rows: n, same_schema: e.anchor.benchmark.schema === me.anchor.benchmark.schema, status: e.status, branch: e.anchor.branch, lineage,
        // contradictory knowledge kept on different branches coexists (청구항 17) — never a supersede candidate
        cross_branch: !!(e.anchor.branch && me.anchor.branch && e.anchor.branch !== me.anchor.branch),
        author: e.anchor.author, author_name: e.anchor.author_name ?? null, same_author: sameAddr(e.anchor.author, me.anchor.author),
        created_at: e.anchor.created_at, sales: e.settlements.length,
      });
    }
    return out.sort((a, b) => b.overlap_rows - a.overlap_rows);
  }

  /**
   * DRAFT → ANNOUNCED: pre-checks, anchor record (gateway_url = this node's x402 endpoint), broadcast.
   *
   * `fromTeach` is set only by teach.announceJob(), which has already checked that the person who taught the lesson
   * published it and that their signed claim verifies. Without it a teach draft is refused here (item 243): the
   * operator door used to walk a failed lesson — visitor's data, no consent, price 0 — straight onto the ledger.
   */
  async announce(id: string, opts: { fromTeach?: boolean; replaces?: string[]; autoSupersede?: boolean } = {}): Promise<LedgerRecord<PatchAnchor>> {
    const draftEntry = await this.entry(id);
    if (draftEntry && this.drive) this.drive.pullDraftEdits(draftEntry);
    const d = this.store.getDraft(id);
    if (!d) throw this.noDraft(id, 'announce');
    const blob = this.blobs.get(d.anchor.patch_sha256);
    if (!blob) throw conflict('patch body missing from blob store');
    if (!d.anchor.benchmark.schema) throw badInput('benchmark.schema is required');
    if (d.anchor.origin === 'teach' && !opts.fromTeach) {
      throw conflict(
        `lesson_draft: ${id} was taught by a visitor, and only they can publish it — announcing it here would put their data and their name on the permanent record without consent. Publish it from the lesson page (the teacher signs the claim), or approve it in the console's Teaching tab once they have submitted it for review.`,
        { code: 'lesson_draft', patch_id: id, origin: 'teach' },
      );
    }
    await this.validateLineageForAnnounce(d.anchor);
    const conflicts = await this.conflicts(id);
    const anchor: PatchAnchor & { gateway_url: string } = { ...d.anchor, gateway_url: `${this.publicUrl}/x402/patch/${id}`, created_at: Date.now() };
    /**
     * Which listings this publish will retire when it is verified (item 248).
     *
     * Superseding used to be inferred from row overlap alone: a bake whose facts touch DIFFERENT rows left
     * yesterday's listed and both selling, and a bake that happened to overlap retired whatever it touched — so a
     * daily publisher could neither make "today replaces yesterday" true on purpose nor keep a dated snapshot
     * listed. `replaces` is the declaration (checked here: your own knowledge, still tradeable, older than this),
     * and `autoSupersede: false` keeps every overlap of yours listed.
     */
    const auto = opts.autoSupersede === false ? [] : await this.supersedable(anchor, conflicts);
    const declared = await this.declaredSupersedes(anchor, opts.replaces ?? [], conflicts, auto);
    const retires = [...auto, ...declared];
    const rec = await this.ledger.append('anchor', anchor);
    this.store.deleteDraft(id);
    this.store.set(`pending_supersede:${id}`, JSON.stringify(retires));
    this.invalidate();
    this.log('info', 'publish', `announced ${id} (conflicts: ${conflicts.length})`
      + (retires.length ? ` — when verified, this retires: ${retires.map((r) => `${r.patch_id} (${r.overlap_rows ? `${r.overlap_rows.toLocaleString('en-US')} shared rows` : 'declared, no shared rows'})`).join(', ')}`
        : opts.autoSupersede === false ? ' — nothing is retired (--keep-others)' : ''),
      id, { conflicts, retires });
    await this.p2p?.broadcast(rec).catch(() => undefined);
    /**
     * Offer the BODY to peers, not just the anchor.
     *
     * Broadcast sends the record. The record names a sha, and every route that moves a sha is a pull — the
     * verifier comes to the author. A publisher behind NAT or a firewall passes this line with a perfectly good
     * announce and no way for anyone to fetch what it announced: the catalogue lists it, the status never leaves
     * ANNOUNCED, and nothing anywhere reports an error. Pushing the body to whoever will hold it is what closes
     * that, and it is best-effort — peers that decline are normal, so this cannot fail a publish.
     */
    void this.offerBody(anchor.patch_sha256, blob.path, id);
    return rec;
  }

  /** Push a just-announced body to relaying peers, and say plainly when nobody took it (see `announce`). */
  private async offerBody(sha: string, path: string, id: string): Promise<void> {
    if (!this.p2p) return;
    try {
      const took = await this.p2p.offerBlob(sha, path);
      if (took.length) this.log('info', 'publish', `${took.length} peer(s) now hold the body of ${id}: ${took.join(', ')}`, id, { relays: took });
      else this.log('warn', 'publish', `no peer accepted the body of ${id} — verifiers must reach ${this.publicUrl} themselves to fetch it. `
        + `If this node is not reachable from outside, ${id} will stay ANNOUNCED: ask a peer to set \`p2p.relayBlobs true\`.`, id);
    } catch (e) {
      this.log('warn', 'publish', `could not offer the body of ${id} to peers: ${(e as Error).message}`, id);
    }
  }

  /** What this announce will retire once verifiers pass it — read back by the API and the CLI (item 248). */
  pendingSupersedes(id: string): ConflictInfo[] {
    try { return JSON.parse(this.store.get(`pending_supersede:${id}`) ?? '[]') as ConflictInfo[]; } catch { return []; }
  }

  /**
   * The ids a publisher NAMED as the versions this one replaces (item 248) — checked against the same rules the
   * automatic list obeys, minus the row overlap, which is exactly the case the flag exists for. A publisher may
   * only retire their own knowledge, and only something older than what they are publishing.
   */
  private async declaredSupersedes(anchor: PatchAnchor, replaces: string[], conflicts: ConflictInfo[], already: ConflictInfo[]): Promise<ConflictInfo[]> {
    const out: ConflictInfo[] = [];
    for (const id of [...new Set(replaces.filter(Boolean))]) {
      if (already.some((c) => c.patch_id === id) || out.some((c) => c.patch_id === id)) continue;
      if (id === anchor.id) throw badInput(`--replaces ${id}: a knowledge cannot replace itself`);
      const e = await this.entry(id);
      if (!e) throw notFound(`--replaces ${id}: no knowledge with that id on this node`);
      if (!sameAddr(e.anchor.author, this.address)) throw conflict(`--replaces ${id}: it was published by ${e.anchor.author_name ?? e.anchor.author} — only its own author can retire it. Overlapping knowledge from another node coexists with yours.`, { patch_id: id, author: e.anchor.author });
      if (anchor.parents.includes(id)) throw conflict(`--replaces ${id}: it is a declared base of ${anchor.id}, and an add-on does not retire what it was built on — its buyers need it underneath.`, { patch_id: id });
      if (!['VERIFIED', 'VERIFYING', 'ANNOUNCED'].includes(e.status)) throw conflict(`--replaces ${id}: it is ${e.status}, so there is nothing on sale to retire.`, { patch_id: id, status: e.status });
      if (e.anchor.created_at >= anchor.created_at) throw conflict(`--replaces ${id}: it was published after ${anchor.id} — a newer version cannot be replaced by an older one.`, { patch_id: id });
      const known = conflicts.find((c) => c.patch_id === id);
      out.push(known ?? {
        patch_id: id, overlap_rows: 0, same_schema: e.anchor.benchmark.schema === anchor.benchmark.schema, status: e.status, branch: e.anchor.branch,
        cross_branch: !!(e.anchor.branch && anchor.branch && e.anchor.branch !== anchor.branch),
        author: e.anchor.author, author_name: e.anchor.author_name ?? null, same_author: true, created_at: e.anchor.created_at, sales: e.settlements.length, lineage: null,
      });
    }
    return out;
  }

  /**
   * Which of an announce's overlaps this anchor may retire. Three rules, each one a way the old "every same-schema
   * overlap" list took knowledge down that it had no right to:
   *  - same author only (items 151, 363): a supersede is a publisher retiring their OWN earlier version. Any node
   *    could otherwise mark a competitor's listing "Newer version available" by publishing an overlapping .npz.
   *  - older than these bytes (item 240): a re-bake of an old file is not a new version of the newer knowledge it
   *    overlaps, so the cut-off is the date this BODY first went on the record, not the date of this anchor.
   *  - same schema, same branch, still tradeable — as before.
   */
  private async supersedable(anchor: PatchAnchor, conflicts: ConflictInfo[]): Promise<ConflictInfo[]> {
    const firstSeen = (await this.catalogAll())
      .filter((e) => e.anchor.patch_sha256 === anchor.patch_sha256 && e.anchor.id !== anchor.id && e.status !== 'DRAFT' && sameAddr(e.anchor.author, anchor.author))
      .reduce((min, e) => Math.min(min, e.anchor.created_at), anchor.created_at);
    /**
     * A declared parent is not retired by its own child (item 189) — an add-on writes over what it was built on —
     * with one exception the publisher has to say out loud: `--kind update` is "this is my next version of that"
     * (item 188), which is precisely a supersede, and it is refused on anybody else's knowledge.
     */
    const declaredUpdate = anchor.derivation?.kind === 'update'
      ? new Set((anchor.derivation.bases ?? []).map((b) => b.patch_id))
      : new Set<string>();
    return conflicts.filter((c) => c.same_schema && !c.cross_branch && c.same_author && (!c.lineage || declaredUpdate.has(c.patch_id))
      && c.created_at < firstSeen && ['VERIFIED', 'VERIFYING', 'ANNOUNCED'].includes(c.status));
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

  /**
   * File a challenge (item 328). A challenge is free, it stops every sale of the knowledge instantly, and it spends
   * some other node's GPU minutes on the re-run — so before this it was also the cheapest way to keep a rival off
   * sale for as long as you kept filing. The deterrent is procedural, not a deposit (nothing is escrowed anywhere in
   * this product, item 127): it has to say why, one address may hold only one open challenge on an anchor, and a
   * challenge the verifiers already dismissed cannot be re-filed by the same address for CHALLENGE_COOLDOWN_MS.
   */
  async challenge(patchId: string, reason: string): Promise<Challenge> {
    const text = String(reason ?? '').trim();
    const e = await this.entry(patchId);
    if (!e) throw notFound('patch not found');
    if (e.status === 'DRAFT') throw conflict(`${patchId} is a private draft — there is nothing on the record to challenge`);
    if (text.length < CHALLENGE_MIN_REASON) {
      throw badInput(`a challenge takes ${patchId} off sale everywhere until a verifier re-runs the benchmark on it, so it has to say why: at least ${CHALLENGE_MIN_REASON} characters (got ${text.length}). Name the question it gets wrong and what the model answered.`);
    }
    const mine = e.challenge_log.filter((c) => sameAddr(c.challenge.challenger, this.address));
    const open = mine.find((c) => c.state === 'open');
    if (open) {
      throw conflict(`you already have an open challenge on ${patchId}, filed ${new Date(open.challenge.created_at).toISOString()}: "${open.challenge.reason}". It is waiting for a verifier to re-run the benchmark — a second one does not make that happen sooner.`);
    }
    const dismissed = mine.filter((c) => c.state === 'dismissed' && c.answered_at).sort((a, b) => (b.answered_at ?? 0) - (a.answered_at ?? 0))[0];
    if (dismissed && Date.now() - (dismissed.answered_at ?? 0) < CHALLENGE_COOLDOWN_MS) {
      const until = new Date((dismissed.answered_at ?? 0) + CHALLENGE_COOLDOWN_MS).toISOString();
      throw conflict(`your challenge on ${patchId} was answered: ${dismissed.answered_by?.slice(0, 10) ?? 'a verifier'}… re-ran the benchmark at ${new Date(dismissed.answered_at ?? 0).toISOString()} and it PASSED. You can challenge it again after ${until} — with evidence the re-run did not cover.`);
    }
    const c: Challenge = { patch_id: patchId, challenger: this.address, reason: text, created_at: Date.now() };
    const rec = await this.ledger.append('challenge', c);
    this.invalidate();
    this.log('warn', 'challenge', `challenged ${patchId}: ${text}`, patchId);
    await this.p2p?.broadcast(rec).catch(() => undefined);
    return c;
  }

  /** How many challenges an address has filed on this network, and how the verifiers answered them (item 328). */
  async challengeRecord(address: string): Promise<{ address: string; filed: number; upheld: number; dismissed: number; open: number }> {
    const out = { address, filed: 0, upheld: 0, dismissed: 0, open: 0 };
    for (const e of await this.catalogAll()) {
      for (const c of e.challenge_log) {
        if (!sameAddr(c.challenge.challenger, address)) continue;
        out.filed++;
        out[c.state]++;
      }
    }
    return out;
  }

  /** When one of our announced patches gets VERIFIED and overlapped an older same-schema patch, mark supersede (§14 [0072]). */
  async reconcileSupersedes(): Promise<void> {
    const cat = await this.catalog(true);
    const byId = new Map(cat.map((x) => [x.anchor.id, x]));
    for (const e of cat) {
      if (!sameAddr(e.anchor.author, this.address) || e.status !== 'VERIFIED') continue;
      const raw = this.store.get(`pending_supersede:${e.anchor.id}`);
      if (!raw) continue;
      const pending = JSON.parse(raw) as ConflictInfo[];
      for (const c of pending) {
        // Re-checked at write time, not just at announce: a pending list written before this rule existed (or by a
        // peer's record arriving late) must never take another author's listing down (items 151, 363).
        const old = byId.get(c.patch_id);
        if (!old || !sameAddr(old.anchor.author, this.address) || old.anchor.created_at >= e.anchor.created_at) continue;
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
   * Take a published knowledge off sale (item 148). The anchor is immutable and stays on the record — this appends a
   * signed `retire` record, which is what the catalogue, the x402 gateway (410) and every buy path read. It is the
   * exit `patch forget` was mistaken for: forgetting deletes this node's copy of the file and keeps selling it.
   *
   * Only the author may retire their own knowledge; a retire record signed by anyone else is ignored when the
   * catalogue is derived. Buyers who already paid keep their download rights (`mayDownload` reads settlements).
   */
  async retire(id: string, reason = ''): Promise<{ ok: true; patch_id: string; retired_at: number; reason: string }> {
    const e = await this.entry(id);
    if (!e) throw notFound('patch not found');
    if (e.status === 'DRAFT') throw conflict(`${id} is still a private draft — delete it instead (ainize patch rm ${id})`);
    if (!sameAddr(e.anchor.author, this.address)) throw conflict(`${id} was published by ${e.anchor.author_name ?? e.anchor.author} — only its author can retire it`);
    if (e.status === 'RETIRED') { const cur = e as MarketEntry; return { ok: true, patch_id: id, retired_at: cur.retired_at ?? Date.now(), reason: cur.retire_reason ?? '' }; }
    const body: RetireRecord = { patch_id: id, reason: reason.slice(0, 500), created_at: Date.now() };
    const rec = await this.ledger.append('retire', body);
    this.invalidate();
    this.log('warn', 'publish', `retired ${id} — off sale from now on${reason ? `: ${reason}` : ''}; the anchor stays on the record and past buyers keep their copy`, id, { reason });
    await this.p2p?.broadcast(rec).catch(() => undefined);
    return { ok: true, patch_id: id, retired_at: body.created_at, reason: body.reason };
  }

  /**
   * Change what a published knowledge sells for (item 278).
   *
   * The anchor is immutable, so `updateDraft` answered "only drafts can be edited (anchors are immutable on the
   * ledger)" to every re-pricing: no discount, no raise, no "make it free". The only path was republishing, which
   * supersedes your own item, restarts verification and splits the sales history — so every price was a one-shot
   * guess made before a single sale, on a market whose publish form gives no pricing guidance. This appends a
   * signed `price` record, which the catalogue folds over the anchor exactly as it folds `retire`; the quote, the
   * 402 and the charge therefore move together, because all three read `entry.anchor.price`.
   *
   * Every price ever set stays on the record, so a buyer can see that a discount is real. Only the author may
   * re-price, and a price change never touches what anyone already paid.
   */
  async setPrice(id: string, price: string, reason = ''): Promise<{ ok: true; patch_id: string; price: string; previous: string; currency: string; created_at: number; history: { price: string; created_at: number }[] }> {
    const e = await this.entry(id);
    if (!e) throw notFound('patch not found');
    const next = validatePrice(price);
    if (!sameAddr(e.anchor.author, this.address)) throw conflict(`${id} was published by ${e.anchor.author_name ?? e.anchor.author} — only its author can change its price`);
    if (e.status === 'DRAFT') throw conflict(`${id} is still a draft — edit its price directly (\`ainize patch edit ${id} --price ${next}\`); a price record is for knowledge already on the record`);
    if ((e as MarketEntry).retired_at !== undefined) throw conflict(`${id} is retired — it is off sale for good, and a price would change nothing`);
    const previous = e.anchor.price;
    if (previous === next) return { ok: true, patch_id: id, price: next, previous, currency: e.anchor.currency, created_at: (e as MarketEntry).repriced_at ?? e.anchor.created_at, history: ((e as MarketEntry).price_history ?? []).map((h) => ({ price: h.price, created_at: h.created_at })) };
    const body: PriceRecord = { patch_id: id, price: next, currency: e.anchor.currency, reason: reason.slice(0, 500), created_at: Date.now() };
    const rec = await this.ledger.append('price', body);
    this.invalidate();
    this.log('info', 'trade', `${id} is now ${Number(next) === 0 ? 'free' : `${next} ${e.anchor.currency}`} (was ${previous})${reason ? `: ${reason}` : ''} — the new price is on the public record and applies to the next sale; nothing already bought changes`, id, { price: next, previous, reason });
    await this.p2p?.broadcast(rec).catch(() => undefined);
    const after = await this.entry(id);
    return { ok: true, patch_id: id, price: next, previous, currency: e.anchor.currency, created_at: body.created_at,
      history: ((after as MarketEntry | null)?.price_history ?? []).map((h) => ({ price: h.price, created_at: h.created_at })) };
  }

  /**
   * Who could actually verify what this node announces. `ainize publish` used to promise "verifiers will now attest"
   * on a solo node with no peers, where nothing announced can ever be VERIFIED (item 147). Reachable = answered a
   * gossip round recently, not merely known: two dead endpoints used to read as a healthy peer count.
   */
  async verifierReach(freshMs = 5 * 60_000): Promise<{ known: number; reachable: number; verifiers: number; quorum: number; self_attest: boolean; endpoints: string[] }> {
    const peers = this.store.listPeers().filter((p) => p.endpoint !== this.publicUrl);
    const fresh = peers.filter((p) => (p.last_seen ?? 0) > Date.now() - freshMs);
    const verifiers = fresh.filter((p) => p.info?.roles?.includes('verifier'));
    const selfAttest = !!this.cfg.verifier?.allowSelfAttest && (this.cfg.roles ?? []).includes('verifier');
    return {
      known: peers.length, reachable: fresh.length, verifiers: verifiers.length + (selfAttest ? 1 : 0),
      quorum: this.cfg.verifier?.quorum ?? 2, self_attest: selfAttest,
      endpoints: verifiers.map((p) => p.endpoint),
    };
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
      // the pinned copy IS the record: recompute the sha over the bytes this node will serve. A `private` set is
      // served to nobody, so nothing has to be held for it (that is also every pre-lineage anchor, and every creator
      // who asked for the file to be deleted after training) — the sha stays on the record as the fingerprint.
      if (accessOf(a) !== 'private') {
        const bytes = this.datasets.rowsBytes(a.dataset.sha256);
        if (!bytes) throw conflict(`dataset_inheritance_mismatch: the training set ${a.dataset.sha256.slice(0, 12)}… is not pinned on this node`);
        if (sha256Hex(bytes) !== a.dataset.sha256) throw conflict('dataset_inheritance_mismatch: the pinned training set does not hash to the sha the record names');
      }
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
   * A signed derive intent (design §6.1): the teaching key `childKey` says it is building on `entry`.
   *
   * Item 312: saying it used to be the whole of it — the token was free, the only trace was a counter, and nothing
   * afterwards ever checked that the child declared the parent, so the questions that make a knowledge worth 25 AIN
   * were a free download to anyone who typed the word "derivative". The intent is now a COMMITMENT: it is written to
   * `derive_intents` (which key, which knowledge, when), it is returned to the caller as the promise they just made,
   * and `TeachWorker` refuses to publish a lesson whose training set came from this knowledge unless the anchor names
   * it as a parent — so the honest derivative that pays the lineage share is no longer competing with a silent copy.
   */
  deriveIntent(entry: CatalogEntry, childKey: string): { token: string; expires: number; sha256: string; commitment: { parent_id: string; child_key: string; at: number; must_declare: true } } {
    const sha = entry.anchor.dataset?.sha256;
    if (!sha) throw notFound('dataset_unavailable: this knowledge has no published training set');
    const token = randomBytes(24).toString('hex');
    const ttl = 24 * 3600_000;
    const now = Date.now();
    this.store.putToken(token, `dataset:${sha}`, `derive:${childKey.toLowerCase()}`, ttl);
    this.store.putDeriveIntent(entry.anchor.id, childKey, sha, now);
    this.store.bumpSignals(entry.anchor.id, { derive_fetches: 1 }, { visitor: this.visitorId(`derive:${childKey.toLowerCase()}`) });
    this.log('info', 'teach', `training set of ${entry.anchor.id} requested for a derivative`, entry.anchor.id, { child_key: childKey, sha256: sha });
    return { token, expires: now + ttl, sha256: sha, commitment: { parent_id: entry.anchor.id, child_key: childKey, at: now, must_declare: true } };
  }

  // ------------------------------------------------------------------ blobs
  /** Make sure we hold the body for an anchor (author/verifier/purchaser path). */
  async ensureBlob(anchor: PatchAnchor, token?: string, source: LicenseSource = 'verification'): Promise<BlobRow> {
    // A body fetched to be SCORED is possession, not a licence (item 327): the row says so, and `hasLicense` refuses
    // it everywhere outside the verifier's own run. `putLicense` never downgrades a purchase into a verification copy.
    this.store.putLicense(anchor.id, anchor.patch_sha256, source, source === 'verification' ? 'fetched to verify it' : null);
    const have = this.blobs.get(anchor.patch_sha256);
    // Nothing was fetched, so there is nothing to report (item 130). The verifier calls this once per anchor per
    // round; while the model server is down that is every 5 s, for ever, and the line said "fetched" about a file
    // that never moved. A body that genuinely arrives over the wire is still logged, three lines below.
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

  /**
   * Stop serving a knowledge body from this node (`ainize patch forget <id>`): the local file is deleted (only files
   * inside our blob dir — in-place files are just deregistered). Bodies are content-addressed, so every id sharing the
   * same sha256 loses its local body too; the ids are reported. Refused while the patch is loaded in the model or is
   * still a draft (delete the draft instead) — nothing on the ledger changes.
   *
   * This is NOT a takedown (item 148): the listing stays for sale and the x402 gateway keeps charging for a file this
   * node can no longer deliver. `retire()` is the exit; forgetting a knowledge that is still on sale says so.
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
    if (e.sellable && sameAddr(e.anchor.author, this.address)) this.log('warn', 'blob',
      `${id} is STILL FOR SALE and this node no longer holds its file — buyers pay and get nothing. Take it off sale with \`ainize patch retire ${id}\`, or fetch the body back before the next sale`, id);
    this.log('info', 'blob', `forgot ${id} body (${blob.sha256.slice(0, 12)}…, ${(blob.size_bytes / 1e6).toFixed(1)} MB${inStore ? ', file deleted' : ', file left in place'}) — no longer served from this node${alsoAffects.length ? `; same body as ${alsoAffects.map((x) => x.id).join(', ')}` : ''}`, id);
    return { ok: true, patch_id: id, sha256: blob.sha256, deleted_file: inStore, also_affects: alsoAffects };
  }

  /** The subset of `shas` that back publicly visible knowledge (no drafts, no hidden test anchors) — what visitors may count. */
  async publicBlobs(shas: string[]): Promise<string[]> {
    const pub = new Set((await this.catalog()).filter((e) => e.status !== 'DRAFT').map((e) => e.anchor.patch_sha256));
    return shas.filter((s) => pub.has(s));
  }

  /**
   * May `address` download blob `sha`? The buyer's download token, the author, a settled buyer — or a verifier
   * holding a live verification lease.
   *
   * The blanket role exemption this replaces (item 326) made every paid body free to anyone who claimed the role:
   * the claim arrives in an unsigned `POST /p2p/hello`, so a throwaway key fetched a 5-CREDIT body with one HTTP
   * request and never verified anything. A lease is narrower in every direction: the entry must actually be waiting
   * for verification, the address must be a registered verifier, the lease ends the moment that verifier's
   * attestation counts, and every grant is an event on the seller's own log.
   */
  async mayDownload(sha: string, address: string | null, token?: string): Promise<boolean> {
    if (token && this.redeemToken(token, sha, address)) return true;
    const cat = await this.catalogAll();
    const entries = cat.filter((e) => e.anchor.patch_sha256 === sha);
    // A listing priced at 0 is free to fetch (item 277): the gate hands its manifest to anyone, so demanding a
    // signature here would only mean the free path worked for nobody without a wallet.
    if (entries.some((e) => e.sellable && Number(e.anchor.price || 0) === 0)) return true;
    if (!address) return false;
    if (entries.some((e) => sameAddr(e.anchor.author, address))) return true;
    if (entries.some((e) => e.settlements.some((s) => sameAddr(s.buyer, address)))) return true;
    return (await this.verificationLease(sha, address, entries)).ok;
  }

  /**
   * A download token, redeemed once (item 345).
   *
   * `issueManifest` minted a 24-hour token and recorded `issued_to`, and the check looked up token + sha and
   * nothing else — so the token, which is the body of the 200 the buyer receives, was a transferable bearer
   * ticket: one 25 AIN purchase served an unlimited number of downloads for a day, to anyone it was pasted to,
   * and the seller had no record that it had happened. A per-download billing model with no enforcement behind it.
   *
   * A token issued to an ADDRESS is now only redeemable by that address, proved by the same `x-ainize-auth`
   * signature every ainize client already sends — a settled buyer never needed the token anyway, so nothing that
   * paid loses access. The two browser-facing kinds (`contrib:` for a teacher fetching their own lesson,
   * `derive:` for a declared derivation) stay bearer, because a browser cannot sign — but they are counted and
   * capped like everything else, and every redemption is an event on the seller's own log.
   */
  static readonly TOKEN_MAX_REDEMPTIONS = 20;
  private redeemToken(token: string, sha: string, address: string | null): boolean {
    const row = this.store.getToken(token, sha);
    if (!row) return false;
    const bearer = !row.issued_to || !row.issued_to.startsWith('0x');
    if (!bearer && !(address && sameAddr(row.issued_to, address))) {
      this.log('warn', 'trade', `refused a download token for ${row.patch_id ?? sha.slice(0, 12)} presented by ${address ? `${address.slice(0, 10)}…` : 'an unsigned requester'}: it was issued to ${row.issued_to.slice(0, 10)}… — a token is not transferable, and its buyer can fetch this body with their own signature`, row.patch_id, { sha256: sha, issued_to: row.issued_to, presented_by: address });
      return false;
    }
    if (row.redemptions >= Market.TOKEN_MAX_REDEMPTIONS) {
      this.log('warn', 'trade', `download token for ${row.patch_id ?? sha.slice(0, 12)} has been redeemed ${row.redemptions} times (cap ${Market.TOKEN_MAX_REDEMPTIONS}) — refusing; a new purchase or a signed fetch issues a fresh one`, row.patch_id, { sha256: sha, redemptions: row.redemptions });
      return false;
    }
    const n = this.store.useToken(token, sha);
    this.log('info', 'trade', `${row.patch_id ?? sha.slice(0, 12)} body served on the token issued to ${row.issued_to.slice(0, 12)}… (redemption ${n}/${Market.TOKEN_MAX_REDEMPTIONS})`, row.patch_id, { sha256: sha, issued_to: row.issued_to, redemptions: n });
    return true;
  }

  /** One fetch of a body per verifier per anchor, for as long as that anchor is waiting on that verifier (item 326). */
  static readonly VERIFY_LEASE_FETCHES = 3;
  async verificationLease(sha: string, address: string, entries?: CatalogEntry[]): Promise<{ ok: boolean; reason: string; patch_id?: string; fetches?: number }> {
    const cat = entries ?? (await this.catalogAll()).filter((e) => e.anchor.patch_sha256 === sha);
    if (!cat.length) return { ok: false, reason: 'no knowledge on this node has that body' };
    const nodes = await this.ledger.nodes().catch(() => []);
    const registered = nodes.some((n) => sameAddr(n.body.address, address) && n.body.roles.includes('verifier'))
      || this.store.listPeers().some((p) => sameAddr(p.address, address) && p.info?.roles.includes('verifier'));
    if (!registered) return { ok: false, reason: 'not a registered verifier on this network' };
    // Which of the entries sharing this body is still waiting for THIS verifier's attestation?
    const waiting = cat.find((e) => {
      if (!['ANNOUNCED', 'VERIFYING', 'CHALLENGED', 'REJECTED'].includes(e.status) && !e.open_challenge) return false;
      if (sameAddr(e.anchor.author, address)) return false;
      const mine = e.attestations.find((a) => sameAddr(a.verifier, address));
      if (!mine) return true;
      return !!e.open_challenge && mine.created_at < e.open_challenge.created_at;   // the challenge is addressed to it again
    });
    if (!waiting) {
      return { ok: false, reason: cat.some((e) => e.attestations.some((a) => sameAddr(a.verifier, address)))
        ? 'this verifier has already attested every knowledge that shares this body — the verification exemption is spent'
        : 'no knowledge sharing this body is waiting for verification' };
    }
    /**
     * One lease per verification, not one per lifetime (item 372).
     *
     * The key used to be `(body, verifier)` and nothing ever cleared it — despite this method's own promise that
     * "the lease ends when its attestation lands" — so `VERIFY_LEASE_FETCHES` was a lifetime cap of three fetches
     * of these bytes by this verifier, ever. `releaseBody` drops the body after every attestation, so each round
     * needs its own fetch: on the fourth challenge of a long-lived listing every verifier was refused the body,
     * `ensureBlob` failed, no attestation could answer the challenge, and the item stayed CHALLENGED for good.
     *
     * Naming the anchor and the challenge round it is answering makes the counter mean what the docstring says: a
     * verifier that has attested moves on to a different key, and a new challenge is a new question and a new
     * lease. Three fetches is then what it was meant to be — a bound on retries within one verification.
     */
    const round = waiting.open_challenge?.created_at ?? 0;
    const key = `verify_lease:${sha}:${address.toLowerCase()}:${waiting.anchor.id}:${round}`;
    const prev = JSON.parse(this.store.get(key) ?? 'null') as { fetches: number; first: number } | null;
    const fetches = (prev?.fetches ?? 0) + 1;
    if (fetches > Market.VERIFY_LEASE_FETCHES) {
      return { ok: false, reason: `this verifier has fetched ${prev?.fetches} copies of this body without attesting ${waiting.anchor.id}${round ? ' since the challenge it is answering' : ''}`, patch_id: waiting.anchor.id, fetches };
    }
    this.store.set(key, JSON.stringify({ fetches, first: prev?.first ?? Date.now() }));
    this.log('info', 'blob', `served ${waiting.anchor.id} body to verifier ${address.slice(0, 10)}… under a verification lease (fetch ${fetches}/${Market.VERIFY_LEASE_FETCHES}; the lease ends when its attestation lands)`, waiting.anchor.id, { verifier: address, sha256: sha, fetches });
    return { ok: true, reason: `verifying ${waiting.anchor.id}`, patch_id: waiting.anchor.id, fetches };
  }

  // ------------------------------------------------------------------ x402 (seller side)
  /** How deep the required-base walk goes before it stops (a cycle or a very long chain cannot hang a quote). */
  static readonly MAX_REQUIRED_DEPTH = 16;

  /**
   * What a buyer must ALSO hold for this knowledge to work, deepest first (item 270).
   *
   * `base.stack` — not `parents` — is the table state the body was trained against: a `delta` export writes rows
   * that only mean anything on top of it, while a `squash` carries its bases' rows itself and lists no stack. So a
   * knowledge that is "built on" something can still be complete on its own, and the quote has to say which it is
   * instead of leaving the buyer to discover a second, unbudgeted purchase after paying.
   *
   * Bases this node has never seen are still listed (`known: false`) with no price — silently dropping them would
   * quote a family total that is not the family's price.
   */
  requiredBases(entry: CatalogEntry, map: Map<string, CatalogEntry>): X402Required[] {
    const out: X402Required[] = [];
    const seen = new Set<string>([entry.anchor.id]);
    const walk = (stack: { patch_id: string }[] | undefined, depth: number) => {
      if (!stack?.length || depth > Market.MAX_REQUIRED_DEPTH) return;
      for (const b of stack) {
        if (seen.has(b.patch_id)) continue;
        seen.add(b.patch_id);
        const e = map.get(b.patch_id);
        walk(e?.anchor.base?.stack, depth + 1);            // its own bases go under it
        // Where that base is sold TODAY (item 275) — the frozen address on the record is only the last resort, or
        // a buyer told "needs adv-base, from node-a" would be handed a port that node left months ago.
        const gw = e ? this.gatewaysFor(e.anchor)[0]?.url ?? (e.anchor as PatchAnchor & { gateway_url?: string }).gateway_url ?? null : null;
        out.push({
          id: b.patch_id, name: e?.anchor.name ?? b.patch_id, price: e?.anchor.price ?? '', currency: e?.anchor.currency ?? this.cfg.market.currency,
          author: e?.anchor.author ?? '', author_name: e?.anchor.author_name ?? null, gateway_url: gw, depth, known: !!e,
        });
      }
    };
    walk(entry.anchor.base?.stack, 1);
    return out;
  }

  /**
   * The whole price of a purchase: this knowledge plus every base under it that the buyer does not already hold
   * (item 270). `held` is answered from THIS node's blob store and purchase table, so it is the answer for the node
   * asking — the seller's 402 carries the family and its list price, and the buyer's own node subtracts what it has.
   */
  async quoteFor(entry: CatalogEntry, map?: Map<string, CatalogEntry>): Promise<PatchQuote> {
    const m = map ?? await this.entryMap();
    const requires = this.requiredBases(entry, m).map((r) => {
      const e = m.get(r.id);
      // Holding the bytes is not the right to use them (item 327): a verifier fetched every body it scored. What
      // decides whether a base still has to be BOUGHT is the licence, not the file on disk.
      const lic = e ? this.licenseOf(e) : null;
      return {
        ...r,
        held: !!e && this.blobs.has(e.anchor.patch_sha256),
        licensed: !!lic && lic.source !== 'verification',
        purchased: !!this.store.getPurchase(r.id),
        mine: !!e && e.anchor.author === this.address,
      };
    });
    const missing = requires.filter((r) => !r.licensed && !r.mine);
    const priced = missing.filter((r) => r.known);
    const total = Number(entry.anchor.price) + priced.reduce((a, r) => a + Number(r.price || 0), 0);
    return {
      patch_id: entry.anchor.id, price: entry.anchor.price, currency: entry.anchor.currency,
      requires, missing: missing.map((r) => r.id), unknown: missing.filter((r) => !r.known).map((r) => r.id),
      total: String(Math.round(total * 1e6) / 1e6),
      self_contained: requires.length === 0,
      export: entry.anchor.base?.export ?? null,
      derivation: entry.anchor.derivation?.kind ?? null,
    };
  }

  /**
   * The 402: price, family, and what is actually being sold (items 270, 272, 344, 236).
   *
   * It used to carry scheme/network/asset/payTo/maxAmountRequired/resource/description/nonce/expires_at and
   * nothing else, so a client that is not an ainize node — which is the whole point of x402 — could not tell a
   * current version from one retired last month, could not read the licence it was buying, and learned the
   * royalty split only from a header AFTER the money moved. All four now travel with the quote.
   */
  async requirementsFor(entry: CatalogEntry, resource: string): Promise<X402Requirement[]> {
    const nonce = newNonce();
    const scheme = this.ledger.kind === 'ain' ? 'ain-transfer' : 'local-credit';
    this.store.putNonce(nonce, resource, entry.anchor.price, this.address, 10 * 60_000);
    const map = await this.entryMap();
    const requires = this.requiredBases(entry, map);
    // The 402 is the SELLER's answer to a stranger, so its `total` is the family's LIST price — never this node's
    // own net. `quoteFor` subtracts what the asking node already holds, and the seller holds its own bases, which
    // made a 5-CREDIT delta with a 4-CREDIT base quote `total: 5, self_contained: false` to every x402 client that
    // is not an ainize node (item 270). A buyer's own node still subtracts its holdings at /api/patches/:id/quote.
    const listTotal = Number(entry.anchor.price) + requires.filter((r) => r.known).reduce((a, r) => a + Number(r.price || 0), 0);
    // The split this sale will make, computed by the function that will make it — never a promise written by hand.
    const split = await this.saleSplit(entry, Number(entry.anchor.price), map);
    return [{
      scheme, network: this.ledger.kind === 'ain' ? 'ain:local' : 'local', asset: this.ledger.kind === 'ain' ? 'AIN' : 'CREDIT',
      payTo: this.address, maxAmountRequired: entry.anchor.price, resource,
      // Item 282 — `requires`, `lineage` and `self_contained` below say all of this to a machine, but `description`
      // is the one field a generic x402 client puts in front of a person, and it named neither the family nor the
      // rest of the bill. An add-on priced at 3 read exactly like a standalone priced at 3.
      description: `Knowledge patch ${entry.anchor.id} (${entry.anchor.rows} rows, ${entry.anchor.model.id_M})`
        + (requires.length
          ? ` — an add-on: it needs ${requires.map((r) => r.id).join(', ')} underneath it, ${Math.round(listTotal * 1e6) / 1e6} ${entry.anchor.currency} for the whole family`
          : (entry.anchor.parents ?? []).length ? ` — built on ${(entry.anchor.parents ?? []).join(', ')}` : ''),
      nonce, expires_at: Date.now() + 10 * 60_000,
      // What the family costs, and what binds a payment to THIS quote (items 270, 272, 344).
      ...(scheme === 'ain-transfer' ? { transfer_key: transferKeyFor(resource, nonce) } : {}),
      requires,
      total: String(Math.round(listTotal * 1e6) / 1e6), self_contained: requires.length === 0, single_use: true,
      // What is being sold (item 236) — decidable before paying, by a client that has only this document.
      status: entry.status,
      superseded_by: entry.superseded_by,
      license: entry.anchor.license ?? null,
      lineage: {
        parents: (entry.anchor.parents ?? []).map((id, i) => ({ id, author: map.get(id)?.anchor.author ?? entry.anchor.parent_authors?.[i] ?? null, name: map.get(id)?.anchor.name ?? null })),
        standalone: !(entry.anchor.parents ?? []).length && !(entry.anchor.base?.stack ?? []).length,
      },
      split_preview: split.lines.map((l) => ({ address: l.address, name: l.name, role: l.role, amount: l.amount })),
    }];
  }

  /**
   * Starting local credit is ISSUED by this node (item 364), and this is the only place it is created: one grant
   * per address, capped at `market.creditGrants` addresses, recorded so `creditBalance` sums records that exist
   * instead of assuming every keypair is born with money. An AIN node issues nothing — it sells for real AIN.
   */
  grantCredit(address: string, reason: string): { grant: CreditGrantRow | null; granted: boolean; refused?: string } {
    const have = this.store.getGrant(address);
    if (have) return { grant: have, granted: false };
    if (this.ledger.kind === 'ain') return { grant: null, granted: false, refused: 'this node sells for AIN and issues no local credit' };
    const amount = this.cfg.market.initialCredit;
    if (!(Number(amount) > 0)) return { grant: null, granted: false, refused: 'this node issues no starting credit (market.initialCredit is 0)' };
    const cap = this.cfg.market.creditGrants ?? 100;
    const totals = this.store.grantTotals();
    if (totals.addresses >= cap) return { grant: null, granted: false, refused: `this node has issued all ${cap} starting-credit grants (${totals.amount} ${this.cfg.market.currency}) — ask the operator to raise market.creditGrants` };
    const grant = this.store.putGrant(address, amount, reason);
    this.log('info', 'trade', `issued ${amount} ${this.cfg.market.currency} starting credit to ${address.slice(0, 10)}… (${reason}; ${totals.addresses + 1}/${cap} grants made)`, null, { address, amount });
    return { grant, granted: true };
  }

  /**
   * Send AIN out of this node's wallet (item 320).
   *
   * The money verbs were `wallet` (read-only), `payouts ls/retry` (outgoing royalties only) and `chain fund`,
   * which refuses unless the provider is local — so a node that had EARNED could spend it only by buying other
   * knowledge through the same node, and "you get paid per sale" ended at a number on one screen. A creator could
   * not move earnings to their own wallet or pay a collaborator.
   *
   * On a local ledger there is nothing to send: the balance is this node's own play money, derived from its own
   * settle records, and saying so plainly is the honest answer rather than a transfer that pretends.
   */
  async walletSend(to: string, amount: number, opts: { memo?: string } = {}): Promise<{ ok: true; to: string; amount: number; tx_hash: string; balance: number | null; currency: string }> {
    if (!/^0x[0-9a-fA-F]{40}$/.test(to)) throw badInput(`${to} is not an AIN address (0x + 40 hex)`);
    if (!(Number.isFinite(amount) && amount > 0)) throw badInput('amount must be a positive number');
    if (sameAddr(to, this.address)) throw badInput('that is this node\'s own address — nothing would move');
    if (!(this.ledger instanceof AinLedger)) {
      throw conflict(`this node settles in ${this.cfg.market.currency} on its own local ledger: the balance is development credit issued by this node and derived from its own records, so there is nothing to send anywhere. It buys knowledge here and is worthless everywhere else — see /terms. Point ledger.kind at an AIN chain to earn money that can move.`);
    }
    const before = await this.ledger.balance().catch(() => null);
    if (before !== null && before < amount) throw conflict(`this node holds ${before} AIN and cannot send ${amount}`);
    const r = await this.ledger.transfer(to, amount);
    this.log('warn', 'trade', `sent ${amount} AIN to ${to} (tx ${r.tx_hash.slice(0, 14)}…)${opts.memo ? `: ${opts.memo}` : ''} — this is the node's own wallet, and the transfer is irreversible`, null, { to, amount, tx_hash: r.tx_hash });
    return { ok: true, to, amount, tx_hash: r.tx_hash, balance: await this.ledger.balance().catch(() => null), currency: 'AIN' };
  }

  /** What this node has issued and to whom (item 364) — every local-credit balance is derived from these rows. */
  creditIssuance(): { cap: number; addresses: number; amount: number; per_address: string; currency: string; issues: boolean } {
    const totals = this.store.grantTotals();
    return {
      cap: this.cfg.market.creditGrants ?? 100, addresses: totals.addresses, amount: totals.amount,
      per_address: this.cfg.market.initialCredit, currency: this.cfg.market.currency, issues: this.ledger.kind !== 'ain',
    };
  }

  /**
   * Local-credit balance = what this node granted this address + royalties received − purchases paid (item 364).
   * An address this node never funded has no balance: credit is issued here, not conjured by owning a keypair.
   * Addresses are compared case-insensitively — an AIN address is the same address in either case, and a royalty
   * map keyed in the other case used to pay nobody (item 309).
   */
  async creditBalance(address: string): Promise<number> {
    return (await this.creditStatement(address)).balance;
  }

  /**
   * The same balance, with the rows that produced it (item 369).
   *
   * The balance is derived from gossiped settle records, so every node on one local network computes the SAME
   * figure for an address — but the starting grant is each node's own `market.initialCredit`, so a buyer with an
   * identical history is solvent at a node that grants 100 and refused by one that grants 10. "Insufficient
   * credit" then means either "you spent it" or "this seller funds strangers less generously than the last one",
   * and nothing on any surface distinguished them. Every refusal now names the grant, the spends and the earnings
   * that made the number, and which node issued the grant.
   */
  async creditStatement(address: string): Promise<{ address: string; balance: number; granted: number; spent: number; earned: number; purchases: number; royalties: number; issuer: { address: string; name: string | null }; granted_at: number | null; currency: string }> {
    const setts = await this.ledger.settlements();
    const me = address.toLowerCase();
    const grant = this.store.getGrant(address);
    let spent = 0; let earned = 0; let purchases = 0; let royalties = 0;
    for (const s of setts) {
      if (s.body.scheme !== 'local-credit') continue;
      if (s.body.buyer.toLowerCase() === me) { spent += Number(s.body.amount); purchases++; }
      for (const [addr, amt] of Object.entries(s.body.royalty)) if (addr.toLowerCase() === me && Number(amt) > 0) { earned += Number(amt); royalties++; }
    }
    const granted = Number(grant?.amount ?? 0);
    const round = (n: number) => Math.round(n * 1e6) / 1e6;
    return {
      address, balance: round(granted - spent + earned), granted: round(granted), spent: round(spent), earned: round(earned),
      purchases, royalties, issuer: { address: this.address, name: this.cfg.name ?? null },
      granted_at: grant?.granted_at ?? null, currency: this.cfg.market.currency,
    };
  }

  static intentHash(p: { resource: string; amount: string; nonce: string; payTo: string; from: string }): string {
    return sha256Hex(canonicalJson({ resource: p.resource, amount: p.amount, nonce: p.nonce, payTo: p.payTo, from: p.from }));
  }

  /**
   * The recorded sale of this patch to this payment, if there is one. A settlement is the seller's own receipt, so
   * a payment presented twice can be answered from it instead of being refused (items 272, 273).
   */
  private settledBy(settlements: Settlement[], txHash: string): Settlement | null {
    return settlements.find((x) => x.tx_hash === txHash) ?? null;
  }

  /**
   * Verify an X-PAYMENT payload for `entry`; on success record a settlement and return it.
   *
   * Three rules this function got wrong, rewritten together because they are one order of operations:
   *  - the nonce is spent LAST (item 272). It used to be taken before amount, signature and balance were checked,
   *    so a rejected attempt burned the quote and the buyer's retry — the normal answer to a lost response — was
   *    told "unknown or expired nonce" with the money already gone.
   *  - a payment presented again by the payer who made it is REDEEMED again (item 273): same settlement, a fresh
   *    manifest, no second charge. Only a stranger replaying someone else's payment is refused.
   *  - an AIN transfer only pays for the quote it was made against (item 344): the transfer key must be the one
   *    this node put in the 402, the nonce must be this node's, and the payer must sign for it. Without that, the
   *    tx hash is public and whoever presents it first collects the file.
   */
  private async verifyPayment(subject: PaymentSubject, resource: string, header: string | undefined): Promise<{ buyer: string; txHash: string; scheme: string; replayed?: Settlement; error?: undefined } | { error: string }> {
    const payload = decodePayload(header);
    if (!payload) return { error: 'missing or malformed X-PAYMENT' };
    if (!sameAddr(subject.seller, this.address)) return { error: subject.notSold };
    // Item 365: the seller checked that IT was the anchor's author and never that the buyer was not. Three
    // self-purchases read SOLD 5 on every peer, lifted the item up the "Most popular" row the landing page shows
    // and raised its revenue — and on a free item they cost nothing at all. The only demand signal on the
    // marketplace could be manufactured by the one party with an interest in manufacturing it.
    const claimedBuyer = payload.scheme === 'local-credit' ? payload.from : undefined;
    if (claimedBuyer && sameAddr(claimedBuyer, this.address)) return { error: subject.selfBuy };
    const price = subject.price;
    let buyer = '';
    let txHash = '';
    let scheme = payload.scheme;
    if (payload.scheme === 'local-credit') {
      if (!payload.nonce || !payload.from || !payload.proof) return { error: 'local-credit payload needs nonce, from, proof' };
      const h = Market.intentHash({ resource, amount: payload.amount!, nonce: payload.nonce, payTo: this.address, from: payload.from });
      // Idempotent redemption FIRST: this exact intent may already be paid for, and the payer asking again is
      // asking for the manifest they lost, not for a second sale.
      if (this.store.paymentSeen(h)) {
        const prev = this.settledBy(subject.settlements, h);
        if (prev && prev.buyer.toLowerCase() === payload.from.toLowerCase() && verifyMessage(h, payload.proof, payload.from)) {
          this.log('info', 'trade', `re-issued ${subject.id} to ${payload.from.slice(0, 10)}… against the payment already settled at ${new Date(prev.created_at).toISOString()} — no second charge`, subject.patch_id, { tx: h });
          return { buyer: prev.buyer, txHash: h, scheme: 'local-credit', replayed: prev };
        }
        return { error: 'payment already used' };
      }
      const n = this.store.peekNonce(payload.nonce);
      if (!n || n.expires_at <= Date.now()) return { error: 'unknown or expired nonce' };
      if (n.used) return { error: `nonce ${payload.nonce} was consumed by an earlier attempt — GET ${resource} again for a new quote` };
      if (n.resource !== resource) return { error: 'unknown or expired nonce' };
      if (Number(payload.amount) < price) return { error: 'amount below price' };
      if (!verifyMessage(h, payload.proof, payload.from)) return { error: 'invalid payment signature' };
      // The signature is the first proof that this address exists at all, so it is the moment this node decides
      // whether to fund it: one recorded, capped grant per address (item 364) — never an assumed balance.
      const issued = this.grantCredit(payload.from, `first purchase attempt at ${resource}`);
      const st = await this.creditStatement(payload.from);
      const bal = st.balance;
      if (bal < price) {
        const iss = this.creditIssuance();
        // Item 369: which grant and which spends produced this figure, and whose grant it was. "Insufficient
        // credit" used to mean either "you spent it" or "this seller grants less than the last one did", with
        // nothing on any surface to tell the two apart.
        const made = `${st.granted} granted by ${st.issuer.name ?? st.issuer.address.slice(0, 10)}…${st.spent ? ` − ${st.spent} spent on ${st.purchases} purchase(s) here` : ''}${st.earned ? ` + ${st.earned} earned from ${st.royalties} royalty line(s)` : ''} = ${bal}`;
        return { error: issued.refused
          ? `insufficient credit: ${bal} < ${price} (${made}) — ${issued.refused}`
          : `insufficient credit: ${bal} < ${price} (${made}); this node issues ${iss.per_address} ${iss.currency} per address and has funded ${iss.addresses}/${iss.cap} — another seller may grant a different amount, so a balance here is not a balance everywhere` };
      }
      // Everything checked: spend the nonce now, so nothing above can burn it (item 272).
      if (!this.store.takeNonce(payload.nonce)) return { error: `nonce ${payload.nonce} was consumed by an earlier attempt — GET ${resource} again for a new quote` };
      buyer = payload.from; txHash = h;
    } else if (payload.scheme === 'ain-transfer') {
      if (!(this.ledger instanceof AinLedger)) return { error: 'this node does not accept AIN payments' };
      if (!payload.txHash) return { error: 'ain-transfer payload needs txHash' };
      if (this.store.paymentSeen(payload.txHash)) {
        const prev = this.settledBy(subject.settlements, payload.txHash);
        const proofOk = !!payload.proof && !!payload.nonce && !!prev && verifyMessage(ainPaymentDigest(payload.txHash, payload.nonce), payload.proof, prev.buyer);
        if (prev && proofOk) {
          this.log('info', 'trade', `re-issued ${subject.id} to ${prev.buyer.slice(0, 10)}… against the transfer already settled at ${new Date(prev.created_at).toISOString()} — no second charge`, subject.patch_id, { tx: payload.txHash });
          return { buyer: prev.buyer, txHash: payload.txHash, scheme: 'ain-transfer', replayed: prev };
        }
        return { error: 'payment already used' };
      }
      let tr = await this.ledger.verifyTransfer(payload.txHash);
      for (let i = 0; !tr && i < 5; i++) { await new Promise((r) => setTimeout(r, 1200)); tr = await this.ledger.verifyTransfer(payload.txHash); }
      if (!tr) return { error: 'transfer not found / not executed' };
      if (tr.to !== this.address) return { error: `transfer recipient ${tr.to} is not the seller` };
      if (tr.value < price) return { error: `transfer ${tr.value} below price ${price}` };
      // The transfer must answer THIS node's quote: its key carries the nonce we issued (item 344).
      if (!payload.nonce) return { error: `ain-transfer payload needs the nonce from the 402 — GET ${resource} for a quote and transfer with key ${transferKeyFor(resource, '<nonce>')}` };
      const wantKey = transferKeyFor(resource, payload.nonce);
      if (tr.key !== wantKey) return { error: `transfer ${payload.txHash.slice(0, 14)}… was not made against this quote: its key is ${tr.key || '(none)'}, expected ${wantKey} — transfer again with that key` };
      const n = this.store.peekNonce(payload.nonce);
      if (!n || n.expires_at <= Date.now()) return { error: 'unknown or expired nonce' };
      if (n.used) return { error: `nonce ${payload.nonce} was consumed by an earlier attempt — GET ${resource} again for a new quote` };
      if (n.resource !== resource) return { error: 'unknown or expired nonce' };
      // …and the person presenting it must be the person who paid: a public tx hash is not a bearer ticket.
      if (!payload.proof) return { error: `ain-transfer payload needs proof: sign sha256("x402-ain:<txHash>:<nonce>") with the paying key ${tr.from}` };
      if (!verifyMessage(ainPaymentDigest(payload.txHash, payload.nonce), payload.proof, tr.from)) return { error: `payment proof is not signed by the payer ${tr.from} — only the address that made the transfer can redeem it` };
      if (sameAddr(tr.from, this.address)) return { error: subject.selfBuy };
      /*
       * Item 279 — a transfer below the price used to be answered with "transfer 0.1 below price 5" and nothing
       * else: the AIN stayed in the seller's wallet, no settlement existed, and the tx hash was still spendable by
       * whoever read it off the chain. A rounding or typing mistake donated the money to the seller, with no
       * receipt, no credit and no instruction — the rule was learned by losing money.
       *
       * Everything above has already proved this is a real transfer, to this seller, against THIS quote, from the
       * address presenting it. So it is money that belongs to this purchase: what it does not yet cover is held
       * against (knowledge, payer) and the answer says exactly how much is missing and how to send it. When the
       * held part-payments plus this one reach the price, the sale settles and all of them are spent at once.
       */
      const held = this.store.partialPayments(subject.id, tr.from).filter((h) => h.tx_hash !== payload.txHash);
      const heldTotal = held.reduce((n, h) => n + Number(h.amount), 0);
      const available = Math.round((heldTotal + tr.value) * 1e6) / 1e6;
      if (available + 1e-9 < price) {
        this.store.putPartialPayment({ tx_hash: payload.txHash, patch_id: subject.id, payer: tr.from, amount: String(tr.value), currency: subject.currency, nonce: payload.nonce, resource, transfer_key: tr.key });
        const missing = Math.round((price - available) * 1e6) / 1e6;
        this.log('warn', 'trade', `held ${tr.value} ${subject.currency} from ${tr.from.slice(0, 10)}… for ${subject.id}: ${missing} short of the ${price} price. The money is NOT this node's — it is credited to that address for this knowledge until they send the rest`, subject.patch_id, { payer: tr.from, received: tr.value, held: heldTotal, missing, tx: payload.txHash });
        return { error: `payment_incomplete: received ${tr.value} ${subject.currency}${heldTotal ? ` (plus ${heldTotal} already held for you)` : ''} against a price of ${price} — ${missing} short. Nothing was sold and nothing was kept: the ${available} is held on this node against ${subject.id} for ${tr.from}. Send the remaining ${missing} to ${this.address} with the key ${transferKeyFor(resource, payload.nonce)} and present it the same way; this node settles the whole amount at once. A held credit is not refunded automatically — ask this node's operator if you want it back.` };
      }
      const spend = held.map((h) => h.tx_hash);
      if (!this.store.takeNonce(payload.nonce)) return { error: `nonce ${payload.nonce} was consumed by an earlier attempt — GET ${resource} again for a new quote` };
      if (spend.length) {
        this.store.consumePartials(spend, payload.txHash);
        this.log('info', 'trade', `applied ${heldTotal} ${subject.currency} held from ${tr.from.slice(0, 10)}… (${spend.length} earlier transfer(s)) to this purchase of ${subject.id}`, subject.patch_id, { held: heldTotal, spent_tx: spend });
      }
      buyer = tr.from; txHash = payload.txHash;
    } else {
      return { error: `unsupported scheme ${String(scheme)}` };
    }
    return { buyer, txHash, scheme };
  }

  /**
   * Verify an X-PAYMENT payload for `entry`; on success record a settlement and return it.
   *
   * The verification itself lives in `verifyPayment`, which knows nothing about anchors — the same rules (idempotent
   * redemption, nonce spent last, a transfer bound to its quote and signed by its payer, a short transfer held
   * rather than kept) protect the sale of a knowledge and the curation fee of a track (item 359).
   */
  /**
   * One payer at a time (item 373).
   *
   * A local-credit redemption reads the balance, and the settlement that spends it is appended several awaits
   * later. Two 402s fetched back to back give a buyer two DISTINCT nonces — the nonce guard only stops the same
   * one being spent twice — so both requests observed the pre-spend balance and both settled: a wallet granted
   * 10 CREDIT bought two 10-CREDIT items and `creditStatement` afterwards reported −10.
   *
   * A node is one process, so a per-payer promise chain is the whole fix: the second redemption starts after the
   * first has appended its settlement and therefore reads a balance that already includes it. Payers do not
   * contend with each other, and a payer's own requests were never meant to run concurrently anyway.
   */
  private readonly payerChains = new Map<string, Promise<unknown>>();
  private serialByPayer<T>(payer: string, fn: () => Promise<T>): Promise<T> {
    const key = (payer || 'anonymous').toLowerCase();
    const prev = this.payerChains.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    // The chain must not keep a rejected promise, or every later payment by this payer inherits the failure.
    this.payerChains.set(key, next.then(() => undefined, () => undefined));
    void next.catch(() => undefined);
    return next;
  }

  async settlePayment(entry: CatalogEntry, resource: string, header: string | undefined): Promise<{ settlement: Settlement; replayed?: boolean; error?: undefined } | { settlement?: undefined; error: string }> {
    return this.serialByPayer(decodePayload(header)?.from ?? '', () => this.settlePaymentInner(entry, resource, header));
  }

  private async settlePaymentInner(entry: CatalogEntry, resource: string, header: string | undefined): Promise<{ settlement: Settlement; replayed?: boolean; error?: undefined } | { settlement?: undefined; error: string }> {
    const price = Number(entry.anchor.price);
    const out = await this.verifyPayment({
      id: entry.anchor.id, patch_id: entry.anchor.id, seller: entry.anchor.author, price, currency: entry.anchor.currency,
      settlements: entry.settlements, notSold: 'this node does not sell that patch',
      selfBuy: `self_purchase: ${entry.anchor.id} is published by this node — buying your own knowledge is not a sale and is not recorded as one`,
    }, resource, header);
    if ('error' in out && out.error) return { error: out.error };
    const ok = out as { buyer: string; txHash: string; scheme: string; replayed?: Settlement };
    if (ok.replayed) return { settlement: ok.replayed, replayed: true };
    const { buyer, txHash, scheme } = ok;
    const map = await this.entryMap();
    // The split is computed from the ANCHOR's promise (`royalty_share`, `verifier_share`), never from this node's
    // config: the seller must not be able to decide at settle time what the people it was built on are paid (191).
    const plan = royaltyPlan(entry, map, price, this.cfg.market.royaltyShare, { verifierShare: this.cfg.market.verifierShare });
    let royalty = plan.royalty;
    // Never distribute more than was received (royaltyPlan clamps, this is the last line of defence before real
    // transfers). Scaling every non-seller line proportionally keeps each payee's relative claim; the old branch
    // paid the SELLER the whole price, which turned a lineage bug into the seller's profit (item 310).
    const distributed = Object.values(royalty).reduce((a, b) => a + Number(b), 0);
    if (!(distributed <= price + 1e-6)) {
      const factor = price / distributed;
      const scaled: Record<string, string> = {};
      for (const [addr, amt] of Object.entries(royalty)) scaled[addr] = (Number(amt) * factor).toFixed(6).replace(/\.?0+$/, '') || '0';
      this.log('error', 'trade', `royalty split for ${entry.anchor.id} adds up to ${distributed} > price ${price} — every share scaled by ${factor.toFixed(4)} so the sale pays out exactly ${price}; check the lineage anchors`, entry.anchor.id, { royalty, scaled });
      royalty = scaled;
    }
    // An ancestor this node cannot name is money the seller owes and is NOT keeping: it goes on the record, in the
    // seller's log and on the payouts screen, instead of quietly becoming the seller's margin (item 310).
    if (Object.keys(plan.unresolved).length) {
      this.log('error', 'trade', `${entry.anchor.id}: ${Object.entries(plan.unresolved).map(([id, amt]) => `${amt} owed for ${id}`).join(', ')} — this node cannot resolve that lineage, so the share is held back rather than paid to anyone. Sync the ledger (ainize peers sync) and settle it from the Payouts tab.`, entry.anchor.id, { royalty_unresolved: plan.unresolved });
    }
    const settlement: Settlement = {
      patch_id: entry.anchor.id, seller: this.address, buyer, amount: String(price), currency: entry.anchor.currency, scheme,
      tx_hash: txHash, royalty, billing: entry.anchor.billing, created_at: Date.now(),
      ...(Object.keys(plan.unresolved).length ? { royalty_unresolved: plan.unresolved } : {}),
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

  /**
   * Rebuild the payout rows this node owes from the RECORD (item 313).
   *
   * `enqueue` was called in exactly one place — inline with the sale — and there was no reconcile pass anywhere.
   * A settle written before the payouts table existed, a wiped data dir, or a crash between `ledger.append` and
   * `enqueue` left a public debt with no row at all: no retry, no "failed", nothing, and no button in the product
   * could pay it. Since the settlements are the shared source of truth, walking them makes a missing row
   * impossible rather than merely unlikely. `enqueue` is idempotent per (settle hash, address), so this is safe to
   * run at boot, on a timer and by hand.
   */
  async reconcilePayouts(): Promise<{ settlements: number; rows: number; recovered: number; run: { attempted: number; paid: number; failed: number } | null }> {
    const setts = await this.ledger.settlements();
    const mine = setts.filter((s) => sameAddr(s.body.seller, this.address) && s.body.scheme === 'ain-transfer');
    let rows = 0; let recovered = 0;
    for (const s of mine) {
      const before = new Set(this.store.listPayouts({ limit: 5000 }).filter((r) => r.settle_hash === s.hash).map((r) => r.id));
      const made = this.payouts.enqueue(s.body, s.hash);
      rows += made.length;
      recovered += made.filter((r) => !before.has(r.id)).length;
    }
    if (recovered) this.log('warn', 'payout', `${recovered} royalty payout row(s) recovered from the record: settlements this node wrote that owed money and had no row to pay it from`, null, { settlements: mine.length, recovered });
    const run = recovered || this.payouts.due().length ? await this.payouts.processPending() : null;
    return { settlements: mine.length, rows, recovered, run };
  }

  /** The `payout` records this node can see for one settlement (item 314) — the public half of "was I paid?". */
  async payoutRecords(settleHash?: string): Promise<PayoutRecord[]> {
    const recs = await this.ledger.list({ kind: 'payout' }).catch(() => []);
    return recs
      .map((r) => r.body as PayoutRecord)
      .filter((b) => b && typeof b.settle_hash === 'string' && typeof b.tx_hash === 'string' && (!settleHash || b.settle_hash === settleHash));
  }

  /**
   * Ask the sellers what actually happened to the royalties they owe this node (item 311). A settle record naming
   * this address is the seller's PROMISE; whether the money moved lives in the seller's own `payouts` table, which
   * it publishes for one settle hash at `GET /p2p/payouts/:hash`. Best-effort and cached for PAYOUT_REPORT_TTL_MS:
   * a seller that is offline or too old to answer leaves the row `unconfirmed`, which is the honest state.
   */
  static readonly PAYOUT_REPORT_TTL_MS = 10 * 60_000;
  static readonly PAYOUT_REPORT_MAX = 12;
  async payoutReports(rows: { hash: string; seller: string }[]): Promise<Map<string, { status: 'paid' | 'pending' | 'failed' | 'credited' | 'unconfirmed'; tx_hash: string | null; at: number; last_error: string | null }>> {
    type Report = { status: 'paid' | 'pending' | 'failed' | 'credited' | 'unconfirmed'; tx_hash: string | null; at: number; last_error: string | null };
    const out = new Map<string, Report>();
    const now = Date.now();
    const peers = this.store.listPeers();
    const endpointOf = (seller: string) => peers.find((p) => sameAddr(p.address ?? '', seller))?.endpoint ?? null;
    let asked = 0;
    for (const r of [...rows].reverse()) {
      const key = `payout_report:${r.hash}`;
      const cached = JSON.parse(this.store.get(key) ?? 'null') as Report | null;
      if (cached && now - cached.at < Market.PAYOUT_REPORT_TTL_MS) { out.set(r.hash, cached); continue; }
      if (asked >= Market.PAYOUT_REPORT_MAX) continue;
      const ep = endpointOf(r.seller);
      if (!ep) continue;
      asked++;
      try {
        const res = await fetch(`${ep}/p2p/payouts/${encodeURIComponent(r.hash)}`, { signal: AbortSignal.timeout(4000) });
        if (!res.ok) continue;
        const body = await res.json() as { scheme?: string | null; items?: { address: string; status: string; tx_hash: string | null; last_error: string | null }[] };
        const mine = (body.items ?? []).find((x) => sameAddr(x.address, this.address));
        const status: Report['status'] = body.scheme === 'local-credit' ? 'credited'
          : !mine ? 'unconfirmed' : mine.status === 'paid' ? 'paid' : mine.status === 'failed' ? 'failed' : 'pending';
        const rep: Report = { status, tx_hash: mine?.tx_hash ?? null, at: now, last_error: mine?.last_error ?? null };
        this.store.set(key, JSON.stringify(rep));
        out.set(r.hash, rep);
      } catch { /* offline seller: the row stays unconfirmed, which is the truth */ }
    }
    return out;
  }

  /** The gated content: a manifest (text) whose sha256 is what ain-js verifies against the on-chain content_hash. */
  issueManifest(entry: CatalogEntry, buyer: string): PatchManifest {
    const token = randomBytes(24).toString('hex');
    this.store.putToken(token, entry.anchor.patch_sha256, buyer, 24 * 3600_000, entry.anchor.id);
    return { ...this.manifestFacts(entry), issued_to: buyer, issued_at: Date.now(), download_token: token };
  }

  /** The facts half of a manifest — everything except who it was issued to and the token that lets them fetch it. */
  private manifestFacts(entry: CatalogEntry): Omit<PatchManifest, 'issued_to' | 'issued_at' | 'download_token'> {
    const holders = this.p2p ? this.p2p.holders(entry.anchor.patch_sha256) : [];
    return {
      id: entry.anchor.id, patch_sha256: entry.anchor.patch_sha256, size_bytes: entry.anchor.size_bytes, rows: entry.anchor.rows,
      model: entry.anchor.model, benchmark_hash: entry.anchor.benchmark_hash,
      blob_urls: [`${this.publicUrl}/p2p/blob/${entry.anchor.patch_sha256}`, ...holders.map((h) => `${h}/p2p/blob/${entry.anchor.patch_sha256}`)],
    };
  }

  /**
   * Hand over a knowledge priced at 0 (item 277).
   *
   * The gate answered 402 whatever the price: a free lesson needed a funded identity, a signed intent and a settle
   * record naming the taker on every peer's ledger — the cheapest on-ramp in the product (take a free lesson, try
   * it, build on it) was the one with a permanent public cost, and 74 of node-u's 136 lessons are priced 0. Free
   * means free: no nonce, no signature, no settlement, no name, and no token — `mayDownload` admits the body of a
   * free listing to anyone, so there is nothing to bind a bearer ticket to. It is counted here, on the seller's own
   * node, as what it is: a download, not a sale.
   */
  freeManifest(entry: CatalogEntry): PatchManifest {
    const total = this.store.bumpFreeDownload(entry.anchor.id);
    this.log('info', 'trade', `handed over ${entry.anchor.id} free — price 0, so nothing was charged and no sale was recorded (${total} free download${total === 1 ? '' : 's'} so far)`, entry.anchor.id, { free_downloads: total });
    this.invalidate();
    return { ...this.manifestFacts(entry), issued_to: '', issued_at: Date.now(), download_token: '' };
  }

  /** Free hand-overs of this node's own knowledge (item 277) — the count that replaces the 0-value sale. */
  freeDownloads(patchId?: string): { patch_id: string; count: number; last_at: number }[] { return this.store.freeDownloads(patchId); }

  /**
   * Why an announced knowledge is still not verified (item 154, second half).
   *
   * The publish-time model check can only fire on a node whose own serving API answers — and the node that most
   * often mistypes `--model` is the one whose engine is not up yet. When it cannot fire, the author is left with
   * `ANNOUNCED 0/2` and, as the review found, no error anywhere on their own machine: the retry warnings are events
   * on the VERIFIERS' nodes. This assembles what the author's node knows for certain and says it in one sentence.
   *
   * Every number here is measured on this node: the attestations it has replicated, the peers that answered its
   * last gossip round, and the models those peers advertise in their own `PeerInfo`. Nothing is inferred about a
   * peer that has not spoken. Returns null before `afterMs` — a verification legitimately takes minutes.
   */
  /**
   * What is happening to an item that is not verified YET (item 254).
   *
   * Status becomes VERIFYING only once an attestation exists, and "verifying <id>" is a line in the verifier's own
   * log, not a record anyone else can read — so for the minutes both verifiers were executing the benchmark the
   * catalogue said ANNOUNCED and the card said "Registered · awaiting verification". A morning script waiting for
   * VERIFIED could not tell "nobody picked it up" from "almost done".
   *
   * Everything here is measured on this node: who answers gossip and calls itself a verifier, which of them serve
   * the model this knowledge names, which have already attested — and how long this node's OWN anchors have taken
   * from announce to quorum (the median of what actually happened, never an invented ETA). `typical_ms` is null
   * until this node has listed something.
   */
  verificationProgress(e: CatalogEntry): VerificationProgress | null {
    if (!['ANNOUNCED', 'VERIFYING', 'CHALLENGED'].includes(e.status) || e.passed >= e.quorum) return null;
    const mine = this.address.toLowerCase();
    const attested = new Set(e.attestations.map((a) => a.verifier.toLowerCase()));
    const peers = this.store.listPeers().filter((pr) => pr.failures === 0 && pr.last_seen > 0 && pr.info?.roles?.includes('verifier') && pr.address?.toLowerCase() !== mine);
    const model = e.anchor.model.id_M;
    const waiting = peers
      .filter((pr) => !attested.has((pr.address ?? '').toLowerCase()))
      .map((pr) => ({ name: pr.info?.name ?? pr.endpoint, address: pr.address ?? '', model: pr.info?.model ?? null, can_run: !!pr.info?.model && pr.info.model === model }));
    const since = e.status === 'CHALLENGED' && e.open_challenge ? e.open_challenge.created_at : e.anchor.created_at;
    // How long verification has ACTUALLY taken here: announce → the attestation that met the quorum.
    const durations = this.catalogSync()
      .filter((x) => x.listed_at && x.listed_at > x.anchor.created_at && sameAddr(x.anchor.author, this.address))
      .map((x) => x.listed_at! - x.anchor.created_at)
      .sort((a, b) => a - b);
    const typical = durations.length ? durations[Math.floor(durations.length / 2)] : null;
    const waited = Date.now() - since;
    return {
      patch_id: e.anchor.id, since, waited_ms: waited, counted: e.passed, quorum: e.quorum,
      waiting_on: waiting, capable: waiting.filter((v) => v.can_run).length,
      typical_ms: typical, eta_ms: typical !== null ? Math.max(0, typical - waited) : null,
      samples: e.anchor.benchmark.samples?.length ?? 0,
    };
  }

  verificationStall(e: CatalogEntry, afterMs = 5 * 60_000): VerificationStall | null {
    if (!['ANNOUNCED', 'VERIFYING'].includes(e.status)) return null;
    if (e.passed >= e.quorum) return null;
    const since = e.anchor.created_at;
    const waited = Date.now() - since;
    if (waited < afterMs) return null;
    const needsBenchmark = (e.anchor.benchmark.samples?.length ?? 0) > 0;
    const model = e.anchor.model.id_M;
    const mine = this.address.toLowerCase();
    const attestedBy = new Map(e.attestations.map((a) => [a.verifier.toLowerCase(), a]));
    const peers = this.store.listPeers().filter((pr) => pr.failures === 0 && pr.last_seen > 0 && pr.info?.roles?.includes('verifier') && pr.address?.toLowerCase() !== mine);
    const verifiers = peers.map((pr) => {
      const att = attestedBy.get((pr.address ?? '').toLowerCase());
      return {
        name: pr.info?.name ?? null, endpoint: pr.endpoint, address: pr.address,
        model: pr.info?.model ?? null,
        attested: (att ? (att.verified_on === 'hash-only' ? 'hash-only' : 'executed') : 'no') as 'no' | 'hash-only' | 'executed',
      };
    });
    const hashOnly = e.attestations.filter((a) => a.verified_on === 'hash-only').length;
    const canRun = verifiers.filter((v) => v.model && v.model === model).length;
    const knownModels = [...new Set(verifiers.map((v) => v.model).filter(Boolean))] as string[];
    const mins = Math.floor(waited / 60_000);
    let reason: string;
    if (!verifiers.length) {
      reason = `no other node on this network has answered this one, and a verification needs ${e.quorum}. Add a peer (\`ainize peers add <url>\`) or lower verifier.quorum on a private network.`;
    } else if (needsBenchmark && hashOnly > 0 && canRun === 0) {
      reason = `${hashOnly} verifier(s) checked the file's hash but none could run its benchmark, and a hash-only check never lists an anchor that ships sample questions. This knowledge names model ${model}; the verifiers that answer serve ${knownModels.length ? knownModels.join(', ') : 'no model at all'}. Re-publish for a model one of them serves, or drop the samples from the benchmark.`;
    } else if (needsBenchmark && canRun === 0) {
      reason = `this knowledge names model ${model} and ships ${e.anchor.benchmark.samples?.length} sample question(s), so a verifier has to run it — and the ${verifiers.length} verifier(s) that answer serve ${knownModels.length ? knownModels.join(', ') : 'no model at all'}. Nothing on this network can score it as published.`;
    } else if (hashOnly > 0) {
      reason = `${hashOnly} of ${e.quorum} needed attestations exist and are hash-only; the rest have not arrived yet.`;
    } else {
      reason = `${verifiers.length} verifier(s) answer this node and none has attested yet. Their own logs say why (\`ainize logs --patch ${e.anchor.id}\` on those nodes).`;
    }
    return { patch_id: e.anchor.id, since, waited_minutes: mins, counted: e.passed, quorum: e.quorum, hash_only: hashOnly, needs_benchmark: needsBenchmark, model, verifiers, reason };
  }

  // ------------------------------------------------------------------ x402 (buyer side: this node buys)
  /**
   * Where a knowledge is actually sold right now (item 275).
   *
   * `gateway_url` is frozen into the anchor at announce time and anchors are immutable, so a node that changes its
   * port keeps a whole catalogue that looks open and cannot be entered. The seller's *identity* does not change,
   * though, and it re-introduces itself to its peers on every start — so the peer table and the node records are
   * asked first and the field on the record is treated as the hint it is. Candidates are tried in order.
   */
  gatewaysFor(anchor: PatchAnchor, nodes: { address: string; endpoint: string; last_seen?: number }[] = []): GatewayCandidate[] {
    const path = `/x402/patch/${anchor.id}`;
    const out: GatewayCandidate[] = [];
    const push = (base: string | null | undefined, via: GatewayCandidate['via'], source: string, lastSeen: number | null = null) => {
      if (!base) return;
      const url = base.endsWith(path) ? base : `${base.replace(/\/+$/, '')}${path}`;
      if (!out.some((x) => x.url === url)) out.push({ url, via, source, last_seen: lastSeen });
    };
    if (anchor.author === this.address) push(this.publicUrl, 'self', 'this node');
    const peers = this.store.listPeers().filter((pr) => pr.address === anchor.author).sort((a, b) => b.last_seen - a.last_seen);
    for (const pr of peers) push(pr.endpoint, 'peer', `peer table, last seen ${pr.last_seen ? new Date(pr.last_seen).toISOString() : 'never'}`, pr.last_seen || null);
    for (const n of nodes.filter((n) => n.address === anchor.author)) push(n.endpoint, 'ledger', 'node record on the ledger', n.last_seen ?? null);
    push((anchor as PatchAnchor & { gateway_url?: string }).gateway_url, 'record', 'address on the record');
    return out;
  }

  /**
   * Is the seller of this knowledge there at all, and who else holds the body? (item 276)
   *
   * A catalogue entry says "For sale" from the ledger alone; nothing on the buying path consulted the peer table,
   * which knows perfectly well when the seller was last seen. A buyer whose seller was down got Node's own
   * `fetch failed` — indistinguishable from a broken product, a wrong URL or their own network — and retried, while
   * three peers held the very body and none of them may sell it (only the author's node settles: `409 not sold here`).
   */
  sellerLiveness(anchor: PatchAnchor): { name: string | null; endpoint: string | null; last_seen: number | null; failures: number; reachable: boolean | null; holders: { name: string; endpoint: string }[] } {
    const rows = this.store.listPeers().filter((p) => p.address && p.address.toLowerCase() === anchor.author.toLowerCase())
      .sort((a, b) => b.last_seen - a.last_seen);
    const seller = rows[0] ?? null;
    const holders = (this.p2p?.holders(anchor.patch_sha256) ?? [])
      .filter((ep) => !rows.some((r) => r.endpoint === ep))
      .map((ep) => ({ name: this.store.getPeer(ep)?.info?.name ?? ep, endpoint: ep }));
    return {
      name: seller?.info?.name ?? anchor.author_name ?? null,
      endpoint: seller?.endpoint ?? null,
      last_seen: seller?.last_seen || null,
      failures: seller?.failures ?? 0,
      reachable: seller ? seller.failures === 0 && seller.last_seen > 0 : null,
      holders,
    };
  }

  /**
   * The sentence a buyer gets when the seller does not answer (item 276): who was not there, when it was last seen,
   * that nothing was charged, and who else has the file — with the reason that does not help them today.
   */
  sellerUnreachableMessage(anchor: PatchAnchor, tried: string[]): string {
    const live = this.sellerLiveness(anchor);
    const who = live.name ?? `${anchor.author.slice(0, 10)}…`;
    const when = live.last_seen ? `last seen ${new Date(live.last_seen).toISOString()}` : 'never reached from this node';
    const held = live.holders.length
      ? ` The body is also on ${live.holders.map((h) => h.name).join(', ')}, but only the author's node can sell it, so buying has to wait for ${who} to come back.`
      : '';
    return `${who} — the seller of ${anchor.id} — is not answering (${when}), so nothing was bought and nothing was charged.${held} Tried: ${tried.join('; ')}`;
  }

  /**
   * Buy `patchId` from its seller. `withRequired` buys the bases underneath it first, deepest first, one settlement
   * each (item 270); `maxTotal` refuses before any money moves when the family costs more than that.
   *
   * A knowledge this node has already paid for is COLLECTED, not bought again (item 271): a retry, a second click
   * or a lost response used to run the whole 402 loop and move the full price a second time for a body the buyer
   * was already entitled to — `mayDownload` admits a settled buyer for nothing. `again: true` is the only way to
   * pay twice on purpose, and it exists because per-hit and per-apply-hour billing can mean a genuine second sale.
   */
  async buy(patchId: string, opts: { apply?: boolean; withRequired?: boolean; maxTotal?: number; again?: boolean; origin?: string } = {}): Promise<PurchaseResult> {
    const steps: PurchaseResult['steps'] = [];
    const step = (s: string, d: string, id = patchId) => { steps.push({ step: s, detail: d, at: Date.now() }); this.log('info', 'buy', `${s}: ${d}`, id); };
    const entry = await this.buyable(patchId);
    // Item 365, on the buyer's own side: nothing was stopping a seller running the loop against itself.
    if (sameAddr(entry.anchor.author, this.address)) throw conflict(`${patchId} is published by this node — buying your own knowledge is not a sale, and a settlement naming this node as both seller and buyer would inflate its own sales, revenue and ranking`);
    const paid = this.paidFor(entry);
    if (paid && !opts.again) {
      const out = await this.collect(patchId);
      const when = new Date(paid.created_at).toISOString();
      out.steps.unshift({ step: 'already', detail: `this node already paid ${paid.amount} ${paid.currency} for ${patchId} on ${when} (tx ${paid.tx_hash.slice(0, 14)}…) — collecting on that receipt instead of paying again (\`--again\` buys a second time on purpose)`, at: Date.now() });
      this.log('info', 'buy', `already: ${patchId} was paid for on ${when} — collected, not bought again`, patchId);
      if (opts.apply) step('apply', (await this.applyPatch(patchId, 'purchase', { withBase: true })).text);
      return { ...out, steps: [...out.steps, ...steps], purchases: [{ patch_id: patchId, amount: paid.amount, currency: paid.currency, scheme: paid.scheme, tx_hash: paid.tx_hash, free: true }], total: '0', currency: entry.anchor.currency, redeemed: true };
    }
    step('quorum', `${entry.passed} attestation(s) ≥ quorum ${entry.quorum}`);
    const quote = await this.quoteFor(entry);
    if (quote.requires.length) {
      step('family', quote.missing.length
        ? `${entry.anchor.id} is an add-on: it needs ${quote.requires.map((r) => r.id).join(' → ')} underneath, of which this node is missing ${quote.missing.join(', ')} — ${quote.total} ${entry.anchor.currency} for the family`
        : `${entry.anchor.id} needs ${quote.requires.map((r) => r.id).join(' → ')} underneath; this node already holds ${quote.requires.length === 1 ? 'it' : 'them all'}`);
    }
    if (opts.maxTotal !== undefined && Number(quote.total) > opts.maxTotal) {
      throw conflict(`${patchId} costs ${quote.total} ${entry.anchor.currency} with the ${quote.missing.length} base(s) it needs (${quote.missing.join(', ')}) — over the ${opts.maxTotal} limit, nothing was bought`, { quote });
    }
    const purchases: NonNullable<PurchaseResult['purchases']> = [];
    if (opts.withRequired) {
      for (const need of quote.requires) {
        if (need.licensed || need.mine) continue;
        if (!need.known) throw conflict(`${patchId} needs ${need.id} underneath and this node has never seen that anchor — ask a peer that carries it before buying`, { quote });
        const sub = await this.buy(need.id, { apply: false, origin: opts.origin });
        purchases.push({ patch_id: need.id, amount: sub.amount, currency: need.currency, scheme: sub.scheme, tx_hash: sub.tx_hash });
        for (const st of sub.steps) steps.push({ ...st, step: `${need.id}/${st.step}` });
        step('base', `bought base ${need.id} for ${sub.amount} ${need.currency}`, need.id);
      }
    } else if (quote.missing.length) {
      step('needs', `not buying the base(s) it needs: ${quote.missing.join(', ')} — this knowledge will not answer anything on its own until they are loaded under it`);
    }
    const one = await this.buyOne(entry, step, opts.origin);
    purchases.push({ patch_id: patchId, amount: one.amount, currency: entry.anchor.currency, scheme: one.scheme, tx_hash: one.tx_hash, ...(one.redeemed ? { free: true } : {}) });
    if (opts.apply) {
      // Buying a knowledge and asking for it to be loaded means the whole stack: an add-on without its base is nonsense (§8.7).
      const res = await this.applyPatch(patchId, 'purchase', { withBase: true });
      step('apply', res.text);
    }
    const total = purchases.filter((x) => !x.free).reduce((a, x) => a + Number(x.amount), 0);
    return { ...one, steps, purchases, total: String(Math.round(total * 1e6) / 1e6), currency: entry.anchor.currency };
  }

  /**
   * This node's own receipt for a knowledge, if it has one (item 271). The local purchase row is a cache that a
   * re-install loses, so the ledger's settlements are consulted too: whichever exists, it says the price has been
   * paid once already and a second payment buys nothing.
   */
  paidFor(entry: CatalogEntry): { amount: string; currency: string; scheme: string; tx_hash: string; created_at: number } | null {
    const me = this.address.toLowerCase();
    const settled = entry.settlements.filter((x) => x.buyer.toLowerCase() === me).sort((a, b) => b.created_at - a.created_at)[0];
    if (settled) return { amount: settled.amount, currency: settled.currency, scheme: settled.scheme, tx_hash: settled.tx_hash, created_at: settled.created_at };
    const row = this.store.getPurchase(entry.anchor.id);
    if (row) return { amount: row.amount, currency: entry.anchor.currency, scheme: row.scheme, tx_hash: row.tx_hash, created_at: row.created_at };
    return null;
  }

  /** The entry, re-read from the ledger if it looks stale, refusing everything that must not be paid for. */
  private async buyable(patchId: string): Promise<CatalogEntry> {
    let entry = await this.entry(patchId);
    if (entry && !entry.sellable) { await this.refreshLedger(); entry = await this.entry(patchId); }
    if (!entry) throw notFound('patch not found');
    // A disputed knowledge is named as disputed, not as unverified (item 330): a pre-challenge attestation stopped
    // counting, so the fraction here reads 0/2 on something that was on sale — the reason the buyer needs is the
    // challenge, not the arithmetic.
    if (entry.open_challenge || entry.status === 'CHALLENGED') throw conflict(challengedMessage(entry));
    // Unverified knowledge is sellable only when the operator has opted in, and it is STILL not VERIFIED —
    // the status keeps saying ANNOUNCED, because relabelling it would spend the one signal this marketplace
    // has. The buyer takes the risk knowingly; the record does not pretend the risk is absent.
    if (!entry.quorum_ok && !this.cfg.verifier?.sellUnverified) {
      throw conflict(`verification quorum not met (${entry.passed}/${entry.quorum}) — refusing to buy. `
        + `The seller's node can allow this at the buyer's risk with \`verifier.sellUnverified true\`, and the knowledge stays ${entry.status}, not VERIFIED.`);
    }
    if (!entry.sellable) throw conflict(challengedMessage(entry));
    return entry;
  }

  /**
   * One knowledge through the 402 loop: quote → pay → manifest → body.
   *
   * The intent is written down before the money moves (item 274). A `pending_payments` row exists from the moment
   * this node has a quote, carries the tx hash the instant the transfer returns, and is only marked settled when a
   * manifest is in hand — so a failure between the two leaves evidence on this node instead of only on the chain,
   * and the next attempt re-presents that payment rather than paying a second time (item 272/273 on the seller side
   * make the re-presentation idempotent).
   */
  private async buyOne(entry: CatalogEntry, step: (s: string, d: string, id?: string) => void, origin?: string): Promise<PurchaseResult> {
    const patchId = entry.anchor.id;
    const nodes = (await this.ledger.nodes().catch(() => [])).map((n) => ({ address: n.body.address, endpoint: n.body.endpoint, last_seen: n.body.last_seen }));
    const candidates = this.gatewaysFor(entry.anchor, nodes);
    // item 276: "no gateway" and "the gateway did not answer" are the same thing to a buyer — the seller is not there.
    if (!candidates.length) throw new Error(this.sellerUnreachableMessage(entry.anchor, ['no endpoint at all: the record carries none and no peer has introduced that address']));
    let manifest: PatchManifest;
    let txHash = '';
    let amount = entry.anchor.price;
    let scheme = 'free';
    let redeemed = false;
    let royalty: Record<string, string> | undefined;      // the split the seller reports (item 280)

    // A payment that already left this node and was never answered is finished first — never paid twice.
    const owed = this.store.listPending({ patch_id: patchId, status: ['paid'] })[0];
    if (owed?.payload) {
      step('pending', `a payment for ${patchId} left this node on ${new Date(owed.updated_at).toISOString()} (${owed.amount} ${owed.currency}, tx ${(owed.tx_hash ?? '').slice(0, 14)}…) and was never answered — presenting it again instead of paying`);
      const done = await this.presentPayment(owed.gateway, owed.payload).catch((e) => { step('pending', `re-presenting failed: ${(e as Error).message}`); return null; });
      if (done) {
        manifest = done.manifest; txHash = done.txHash || owed.tx_hash || ''; amount = owed.amount; scheme = owed.scheme; redeemed = true;
        this.store.updatePending(owed.id, { status: 'settled', error: null });
        step('settled', `seller re-issued the manifest against the payment already made — nothing was charged again`);
        return await this.finishPurchase(entry, manifest, { txHash, amount, scheme, redeemed, step, royalty: done.royalty, origin });
      }
    }

    let r1: Response | null = null;
    let gw = candidates[0].url;
    const tried: string[] = [];
    for (const cand of candidates) {
      try {
        r1 = await fetch(cand.url, { headers: { 'x-ainize-buyer': this.address }, signal: AbortSignal.timeout(30_000) });
        gw = cand.url;
        step('gateway', `${cand.url} (${cand.source})${tried.length ? ` — after ${tried.join(', ')} did not answer` : ''}`);
        break;
      } catch (e) { tried.push(`${cand.url} (${(e as Error).message})`); }
    }
    if (!r1) throw new Error(this.sellerUnreachableMessage(entry.anchor, tried));

    if (r1.status === 402) {
      const reqs = decodeRequirements(r1.headers.get(X402_HEADER_REQUIRED), await r1.json().catch(() => ({})));
      const req = reqs.find((q) => q.scheme === (this.ledger.kind === 'ain' ? 'ain-transfer' : 'local-credit')) ?? reqs[0];
      if (!req) throw new Error('402 without payment requirements');
      /*
       * Item 279, the buyer's side: the agent transferred `Number(req.maxAmountRequired)` without ever comparing it
       * with the price the buyer decided on. A seller quoting more than its own public listing was paid it, and a
       * transfer that then failed to cover something was money gone. The listing is what the buyer agreed to.
       */
      const listed = Number(entry.anchor.price || 0);
      if (Number(req.maxAmountRequired) > listed + 1e-9) {
        this.store.updatePending(this.store.putPending({
          patch_id: patchId, gateway: gw, resource: req.resource, scheme: req.scheme, pay_to: req.payTo,
          amount: req.maxAmountRequired, currency: req.asset, nonce: req.nonce, tx_hash: null, payload: null, status: 'quoted', error: null,
        }).id, { status: 'abandoned', error: `quote ${req.maxAmountRequired} above the listed price ${entry.anchor.price}` });
        throw new Error(`${patchId} is listed at ${entry.anchor.price} ${entry.anchor.currency} and its seller now asks ${req.maxAmountRequired} ${req.asset} — nothing was transferred. Re-read the listing (\`ainize patch get ${patchId}\`): if the price really has changed, buy again and this node will pay the new one.`);
      }
      step('402', `Payment Required: ${req.maxAmountRequired} ${req.asset} → ${req.payTo.slice(0, 10)}… (${req.scheme})`);
      const pending = this.store.putPending({
        patch_id: patchId, gateway: gw, resource: req.resource, scheme: req.scheme, pay_to: req.payTo,
        amount: req.maxAmountRequired, currency: req.asset, nonce: req.nonce, tx_hash: null, payload: null, status: 'quoted', error: null,
      });
      let payload: X402Payload;
      if (req.scheme === 'ain-transfer') {
        if (!(this.ledger instanceof AinLedger)) throw new Error('seller wants AIN but this node runs the local ledger');
        // The transfer carries the seller's own key so it can only pay for this quote (item 344).
        const key = req.transfer_key ?? transferKeyFor(req.resource, req.nonce);
        const t = await this.ledger.transfer(req.payTo, Number(req.maxAmountRequired), key).catch((e) => {
          this.store.updatePending(pending.id, { status: 'abandoned', error: `transfer failed: ${(e as Error).message}` });
          throw e;
        });
        payload = { scheme: 'ain-transfer', network: req.network, txHash: t.tx_hash, from: this.address, to: req.payTo, amount: req.maxAmountRequired, nonce: req.nonce, transfer_key: key, proof: signMessage(ainPaymentDigest(t.tx_hash, req.nonce), this.cfg.identity.privateKey) };
        // Written down BEFORE the payment is presented: from here on the money is gone and this row is the receipt.
        this.store.updatePending(pending.id, { tx_hash: t.tx_hash, payload: encodePayload(payload), status: 'paid' });
        // Item 294: this line used to be the last thing in the buyer's own feed for a purchase that never settled,
        // and it read exactly like the one that did. Say what has happened and what has not.
        step('pay', `AIN transfer tx ${t.tx_hash.slice(0, 14)}… (key ${key}) sent — the seller has not answered yet`);
      } else {
        const h = Market.intentHash({ resource: req.resource, amount: req.maxAmountRequired, nonce: req.nonce, payTo: req.payTo, from: this.address });
        payload = { scheme: 'local-credit', network: 'local', txHash: h, from: this.address, to: req.payTo, amount: req.maxAmountRequired, nonce: req.nonce, proof: signMessage(h, this.cfg.identity.privateKey) };
        this.store.updatePending(pending.id, { tx_hash: h, payload: encodePayload(payload), status: 'paid' });
        step('pay', `signed credit intent ${h.slice(0, 14)}… prepared — nothing is spent until the seller accepts it`);
      }
      const done = await this.presentPayment(gw, encodePayload(payload)).catch((e) => {
        this.store.updatePending(pending.id, { status: 'paid', error: (e as Error).message });
        // Item 294: a refusal is a step of its own. Without it the local record erred towards "paid" — three `pay`
        // lines and no `settled` was the only evidence that three purchases had failed.
        step('rejected', `${entry.anchor.author_name ?? entry.anchor.author.slice(0, 10)} did not accept the payment: ${(e as Error).message}`);
        throw new Error(`${(e as Error).message} — the payment (${req.maxAmountRequired} ${req.asset}, tx ${(payload.txHash ?? '').slice(0, 14)}…) is recorded as pending on this node; finish it with \`ainize patch download ${patchId}\` instead of buying again`);
      });
      manifest = done.manifest;
      txHash = done.txHash || payload.txHash;
      amount = req.maxAmountRequired; scheme = req.scheme;
      royalty = done.royalty;
      this.store.updatePending(pending.id, { status: 'settled', error: null });
      step('settled', `seller confirmed; manifest sha256 ${done.sha.slice(0, 14)}…`);
    } else if (r1.ok) {
      // The seller handed it over without a 402 at all: it is priced 0 (item 277). Nothing was charged, nothing was
      // signed, and no settle record names this node as a buyer — so say that, instead of "no payment required".
      manifest = (await r1.json()) as PatchManifest;
      amount = '0'; scheme = 'free';
      step('free', `${patchId} is priced 0 — the seller handed over the file with no payment, no signature and no public record of who took it`);
    } else {
      throw new Error(`gateway error ${r1.status} from ${gw}: ${(await r1.text().catch(() => '')).slice(0, 200)}`);
    }
    return await this.finishPurchase(entry, manifest, { txHash, amount, scheme, redeemed, step, royalty, origin });
  }

  /** Present an X-PAYMENT to a gateway and parse the manifest it answers with. */
  private async presentPayment(gw: string, encoded: string): Promise<{ manifest: PatchManifest; txHash: string; sha: string; royalty?: Record<string, string> }> {
    const r = await fetch(gw, { headers: { [X402_HEADER_PAYMENT]: encoded, 'x-ainize-buyer': this.address }, signal: AbortSignal.timeout(60_000) });
    if (!r.ok) throw new Error(`payment rejected: ${r.status} ${(await r.text()).slice(0, 300)}`);
    const text = await r.text();
    // The seller has been returning the whole split in this header since the beginning and the buyer threw it away,
    // keeping only the tx hash (item 280): the one promise the product makes to a buyer — that the money reaches
    // the people the lineage names — was never shown at the moment it was kept.
    let royalty: Record<string, string> | undefined;
    try {
      const resp = JSON.parse(r.headers.get(X402_HEADER_RESPONSE) ?? 'null') as { royalty?: Record<string, string> } | null;
      if (resp?.royalty && typeof resp.royalty === 'object') royalty = resp.royalty;
    } catch { /* a seller that sends no split leaves the receipt as it was */ }
    return { manifest: JSON.parse(text) as PatchManifest, txHash: r.headers.get('x-payment-tx-hash') ?? '', sha: sha256Hex(text), royalty };
  }

  /** Download the body a manifest points at, record the purchase and the licence it grants. */
  private async finishPurchase(entry: CatalogEntry, manifest: PatchManifest, o: { txHash: string; amount: string; scheme: string; redeemed: boolean; step: (s: string, d: string, id?: string) => void; royalty?: Record<string, string>; origin?: string }): Promise<PurchaseResult> {
    const { step } = o;
    const patchId = entry.anchor.id;
    /**
     * The bytes the seller offers must be the bytes the anchor names (item 371).
     *
     * Every step below trusted `manifest.patch_sha256` — the seller's own number — including the integrity check,
     * which passed `expectSha: manifest.patch_sha256` and so compared the seller's claim with itself while the
     * timeline told the buyer "sha256 matches on-ledger anchor". A seller answering the 402 with a manifest for
     * different bytes was paid, and the mismatch only surfaced later as `base_not_held: … buy it first`, because
     * the body had landed under a sha no anchor refers to. The agent client has always made this comparison
     * (`agent.ts`); the node it buys through did not.
     */
    if (!sameSha(manifest.patch_sha256, entry.anchor.patch_sha256)) {
      throw conflict(`the seller answered with a body that is not the one ${patchId} names: the anchor is ${entry.anchor.patch_sha256.slice(0, 16)}… and the manifest offers ${String(manifest.patch_sha256).slice(0, 16)}…. Nothing was downloaded and no licence was recorded.`, { patch_id: patchId, anchor_sha256: entry.anchor.patch_sha256, manifest_sha256: manifest.patch_sha256 });
    }
    const dest = this.blobs.pathFor(manifest.patch_sha256);
    const origins = manifest.blob_urls.map((u) => { try { return new URL(u).origin; } catch { return ''; } }).filter(Boolean);
    if (!this.blobs.has(manifest.patch_sha256)) {
      const from = await this.p2p.fetchBlob(manifest.patch_sha256, dest, origins, manifest.download_token);
      const { blob } = await this.blobs.importFile(dest, { expectSha: manifest.patch_sha256 });
      step('download', `${(blob.size_bytes / 1e6).toFixed(1)} MB from ${from}; sha256 matches the on-ledger anchor ${entry.anchor.patch_sha256.slice(0, 12)}…`);
    } else {
      step('download', 'body already present; sha256 matches on-ledger anchor');
    }
    const path = this.blobs.get(manifest.patch_sha256)!.path;
    // Item 280: what the money was split into, from the seller's own `x-payment-response`, named against this
    // node's lineage view and kept on the purchase row — so the receipt, the dashboard and a later audit all read
    // the same thing, and a payee the buyer's own preview did NOT expect is visible as exactly that.
    const payees = await this.namePayees(entry, o.royalty, o.amount);
    if (payees?.length) o.step('paid', `${o.amount} ${entry.anchor.currency} → ${payees.map((p) => `${p.name ?? p.address.slice(0, 10)}… ${p.amount} (${p.role}${p.knowledge.length ? ` of ${p.knowledge.join(', ')}` : ''})${p.promised ? '' : ' — not in this node\'s lineage preview'}`).join(' · ')}`);
    this.store.putPurchase({ patch_id: patchId, sha256: manifest.patch_sha256, tx_hash: o.txHash, scheme: o.scheme, amount: o.amount, manifest, path, created_at: Date.now(), origin: o.origin ?? 'manual', royalty: o.royalty ?? null });
    // The purchase is what turns a held body into a body this node may load and serve (item 327).
    this.grantLicense(entry, o.scheme === 'free' ? 'free' : 'purchase', `${o.amount} ${entry.anchor.currency} · tx ${o.txHash.slice(0, 14)}…`);
    /*
     * The on-chain access receipt (item 355). It was described to the buyer as part of the purchase and was
     * best-effort in the code: a `.catch` that logged a warning, a `null` return when the anchor carries no
     * `entry_id`, and a step pushed only when a tx came back — so the failure was invisible, the step simply
     * disappeared from the timeline, and a buyer relying on the receipt as proof of purchase might have none.
     * It is a step either way now, and a failure is retried in the background instead of being swallowed.
     */
    if (this.ledger instanceof AinLedger && o.scheme === 'ain-transfer' && !o.redeemed) {
      const anchor = entry.anchor as PatchAnchor & { entry_id?: string };
      if (!anchor.entry_id) {
        step('receipt', 'no on-chain access receipt: this knowledge was announced without a knowledge-graph entry, so there is nowhere to write one. The settlement on the ledger is the proof of purchase');
      } else {
        const tx = await this.ledger.recordAccess(anchor, o.amount, entry.anchor.currency, o.txHash).catch((e) => { this.log('warn', 'buy', `access receipt failed: ${(e as Error).message}`, patchId); return e as Error; });
        if (typeof tx === 'string') step('receipt', `on-chain access receipt written (/apps/knowledge/access/…, tx ${tx.slice(0, 12)}…)`);
        else {
          step('receipt', `could not write the on-chain access receipt: ${(tx as Error).message} — the purchase itself stands (the settlement is on the ledger); this node will retry the receipt in the background`);
          this.retryAccessReceipt(entry, o.amount, o.txHash);
        }
      }
    }
    return { patch_id: patchId, steps: [], manifest, path, tx_hash: o.txHash, amount: o.amount, scheme: o.scheme, ...(o.redeemed ? { redeemed: true } : {}),
      ...(o.royalty ? { royalty: o.royalty } : {}), ...(payees?.length ? { payees } : {}) };
  }

  /**
   * The seller's royalty map with names, roles and a "this is who my own lineage view expected" mark (item 280).
   *
   * The buyer used to be handed six timeline steps and a tx hash while the settle record on every node carried
   * `{node-a: 0.9, node-b: 2.1}`. The one place the split was ever rendered was the SELLER's log — so the promise
   * "revenue is split automatically with the original creators" was never demonstrated to the person paying for it.
   */
  async namePayees(entry: CatalogEntry, royalty: Record<string, string> | undefined, amount: string): Promise<PurchaseResult['payees']> {
    if (!royalty || !Object.keys(royalty).length) return undefined;
    const preview = await this.saleSplit(entry, Number(amount)).catch(() => null);
    const byAddr = new Map((preview?.lines ?? []).map((l) => [l.address.toLowerCase(), l] as const));
    return Object.entries(royalty)
      .filter(([, amt]) => Number(amt) > 0)
      .map(([address, amt]) => {
        const line = byAddr.get(address.toLowerCase());
        // One address can be paid twice over in one settlement — the author of a base who also verified the child
        // is one line in the royalty map. `saleSplit` has to pick one role for it; a receipt that says "verifier of
        // money-base" over a lineage share would be the wrong sentence, so both are named.
        const role = line ? (line.role === 'verifier' && line.knowledge.length ? 'ancestor and verifier' : line.role)
          : sameAddr(address, entry.anchor.author) ? 'seller' : 'creator';
        return {
          address, amount: amt, name: line?.name ?? (sameAddr(address, entry.anchor.author) ? entry.anchor.author_name ?? null : null),
          role, knowledge: line?.knowledge ?? [], promised: !!line,
        };
      })
      .sort((a, b) => Number(b.amount) - Number(a.amount));
  }

  /**
   * Retry a failed access receipt in the background (item 355), up to RECEIPT_RETRIES times with a widening gap.
   * The money has already moved and the body is already here — this is the proof-of-purchase write that the chain
   * refused, so a failure here must never fail the purchase, and must never be silent either.
   */
  static readonly RECEIPT_RETRIES = 5;
  private retryAccessReceipt(entry: CatalogEntry, amount: string, txHash: string, attempt = 1): void {
    if (!(this.ledger instanceof AinLedger) || attempt > Market.RECEIPT_RETRIES) {
      if (attempt > Market.RECEIPT_RETRIES) this.log('error', 'buy', `gave up writing the on-chain access receipt for ${entry.anchor.id} after ${Market.RECEIPT_RETRIES} attempts — the settlement on the ledger remains the proof of this purchase`, entry.anchor.id);
      return;
    }
    const t = setTimeout(() => {
      const ledger = this.ledger as AinLedger;
      ledger.recordAccess(entry.anchor as PatchAnchor & { entry_id?: string }, amount, entry.anchor.currency, txHash)
        .then((tx) => {
          if (tx) this.log('info', 'buy', `on-chain access receipt for ${entry.anchor.id} written on retry ${attempt} (tx ${tx.slice(0, 12)}…)`, entry.anchor.id, { tx_hash: tx });
          else this.retryAccessReceipt(entry, amount, txHash, attempt + 1);
        })
        .catch((e) => {
          this.log('warn', 'buy', `access receipt retry ${attempt}/${Market.RECEIPT_RETRIES} for ${entry.anchor.id} failed: ${(e as Error).message}`, entry.anchor.id);
          this.retryAccessReceipt(entry, amount, txHash, attempt + 1);
        });
    }, Math.min(5 * 60_000, 15_000 * attempt));
    t.unref?.();
  }

  /**
   * Collect a knowledge this node has ALREADY paid for, without paying again (item 273).
   *
   * Three ways a buyer ends up here: the manifest was lost between the payment and the download; the body was
   * forgotten and has to come back; or a purchase failed after the money left (item 274). In all three the
   * settlement already exists, so the right answer is a re-issued manifest or a signed `/p2p/blob` fetch — never a
   * second sale. Refuses when nothing has been paid, which is what `buy` is for.
   */
  async collect(patchId: string): Promise<PurchaseResult> {
    const steps: PurchaseResult['steps'] = [];
    const step = (s: string, d: string, id = patchId) => { steps.push({ step: s, detail: d, at: Date.now() }); this.log('info', 'buy', `${s}: ${d}`, id); };
    const entry = await this.entry(patchId);
    if (!entry) throw notFound('patch not found');
    if (entry.anchor.author === this.address) throw conflict(`${patchId} is published by this node — its body is not something this node buys`);
    const have = this.store.getPurchase(patchId);
    if (have && this.blobs.has(entry.anchor.patch_sha256)) {
      step('held', `already collected: paid ${have.amount} on ${new Date(have.created_at).toISOString()}, body present`);
      return { patch_id: patchId, steps, manifest: have.manifest as PatchManifest, path: this.blobs.get(entry.anchor.patch_sha256)!.path, tx_hash: have.tx_hash, amount: have.amount, scheme: have.scheme, redeemed: true, total: '0', currency: entry.anchor.currency };
    }
    // 1) a payment that left this node and was never answered — present it again
    const owed = this.store.listPending({ patch_id: patchId, status: ['paid'] })[0];
    if (owed?.payload) {
      step('pending', `presenting the payment made on ${new Date(owed.updated_at).toISOString()} (${owed.amount} ${owed.currency}, tx ${(owed.tx_hash ?? '').slice(0, 14)}…) again`);
      const done = await this.presentPayment(owed.gateway, owed.payload);
      this.store.updatePending(owed.id, { status: 'settled', error: null });
      step('settled', 'seller re-issued the manifest — nothing was charged');
      const out = await this.finishPurchase(entry, done.manifest, { txHash: done.txHash || owed.tx_hash || '', amount: owed.amount, scheme: owed.scheme, redeemed: true, step, royalty: done.royalty });
      return { ...out, steps, redeemed: true, total: '0', currency: entry.anchor.currency };
    }
    // 2) a settlement on the ledger: the seller (and every peer holding the body) admits a settled buyer by signature
    const settled = entry.settlements.filter((x) => x.buyer.toLowerCase() === this.address.toLowerCase()).sort((a, b) => b.created_at - a.created_at)[0];
    // …or nothing was ever paid because nothing was ever charged (item 277). A free knowledge has no settlement to
    // collect on and never will have: the body comes back on the same free rule the gate applies.
    const free = !settled && Number(entry.anchor.price || 0) === 0 && entry.sellable;
    if (!settled && !free) throw conflict(`this node has not paid for ${patchId} — nothing to collect (buy it with \`ainize patch buy ${patchId}\`)`);
    if (settled) step('settlement', `paid ${settled.amount} ${settled.currency} on ${new Date(settled.created_at).toISOString()} (tx ${settled.tx_hash.slice(0, 14)}…) — collecting the body on that receipt, no new payment`);
    else step('free', `${patchId} is priced 0 — fetching the body again costs nothing and is recorded as a download, not a sale`);
    const amount = settled?.amount ?? '0';
    const scheme = settled?.scheme ?? 'free';
    const txHash = settled?.tx_hash ?? '';
    const boughtAt = settled?.created_at ?? Date.now();
    const sha = entry.anchor.patch_sha256;
    const nodes = (await this.ledger.nodes().catch(() => [])).map((n) => ({ address: n.body.address, endpoint: n.body.endpoint, last_seen: n.body.last_seen }));
    const origins = [...new Set([...this.gatewaysFor(entry.anchor, nodes).map((g) => { try { return new URL(g.url).origin; } catch { return ''; } }).filter(Boolean), ...this.p2p.holders(sha)])];
    if (!this.blobs.has(sha)) {
      const from = await this.p2p.fetchBlob(sha, this.blobs.pathFor(sha), origins);
      const { blob } = await this.blobs.importFile(this.blobs.pathFor(sha), { expectSha: sha });
      step('download', `${(blob.size_bytes / 1e6).toFixed(1)} MB from ${from}; sha256 matches the on-ledger anchor ${entry.anchor.patch_sha256.slice(0, 12)}…`);
    } else step('download', 'body already present; sha256 matches on-ledger anchor');
    const path = this.blobs.get(sha)!.path;
    // No new manifest was issued (none was needed — the settlement is the right, and the body was fetched on a
    // signature), so the one reported here is the recorded one if there is one, else the anchor's own facts with an
    // empty download token: nothing is invented, and nothing pretends a token was handed out.
    const manifest: PatchManifest = have?.manifest ?? {
      id: patchId, patch_sha256: sha, size_bytes: entry.anchor.size_bytes, rows: entry.anchor.rows,
      model: entry.anchor.model, benchmark_hash: entry.anchor.benchmark_hash,
      blob_urls: origins.map((o) => `${o}/p2p/blob/${sha}`), issued_to: this.address, issued_at: boughtAt, download_token: '',
    };
    this.store.putPurchase({ patch_id: patchId, sha256: sha, tx_hash: txHash, scheme, amount, manifest, path, created_at: boughtAt, origin: have?.origin ?? 'manual', royalty: settled?.royalty ?? have?.royalty ?? null });
    this.grantLicense(entry, free ? 'free' : 'purchase', free ? 'price 0 — handed over by the gate without payment' : `${amount} ${entry.anchor.currency} · tx ${txHash.slice(0, 14)}…`);
    const payees = await this.namePayees(entry, settled?.royalty, amount);
    if (payees?.length) step('paid', `${amount} ${entry.anchor.currency} went to ${payees.map((p) => `${p.name ?? p.address.slice(0, 10)}… ${p.amount} (${p.role})`).join(' · ')}`);
    return { patch_id: patchId, steps, manifest, path, tx_hash: txHash, amount, scheme, redeemed: true, total: '0', currency: entry.anchor.currency,
      ...(settled?.royalty ? { royalty: settled.royalty } : {}), ...(payees?.length ? { payees } : {}) };
  }

  // ------------------------------------------------------------------ licences: the right to use a body (item 327)
  /**
   * Holding the file is not the right to use it. A verifier fetches every body it scores (verifier.ts `ensureBlob`)
   * and a node that verified an item is never charged for it by `subscribe`, so before this check one `patch apply`
   * turned a verification copy into production use for free. `licenses` records where the right came from; a
   * 'verification' row is possession only and is refused everywhere except inside the verifier's own run.
   *
   * Nothing here is retroactive punishment: a body this node authored, bought (settlement on the ledger or a local
   * purchase row) or that is priced at zero is licensed the moment it is looked at, and the row is written then.
   */
  licenseOf(entry: CatalogEntry): LicenseRow | null {
    const id = entry.anchor.id;
    const me = this.address.toLowerCase();
    const sha = entry.anchor.patch_sha256;
    const grant = (source: LicenseSource, detail: string | null = null): LicenseRow => {
      this.store.putLicense(id, sha, source, detail);
      return this.store.getLicense(id) ?? { patch_id: id, sha256: sha, source, detail, created_at: Date.now() };
    };
    if (entry.anchor.author.toLowerCase() === me) return grant('author', 'published by this node');
    const settled = entry.settlements.find((s) => s.buyer?.toLowerCase() === me);
    if (settled) return grant('purchase', `settlement ${settled.tx_hash.slice(0, 14)}…`);
    // Before the purchase row, because a free knowledge is never PURCHASED (item 277): the gate hands it over with
    // no payment and writes no settlement, and the row this node keeps for it is a download record. `putLicense`
    // never downgrades, so something bought while it had a price keeps saying so if its price later drops to 0.
    if (Number(entry.anchor.price || 0) <= 0) return grant('free', 'price 0 — the x402 gate hands it over without payment');
    const bought = this.store.getPurchase(id);
    if (bought) return grant('purchase', `tx ${bought.tx_hash.slice(0, 14)}…`);
    return this.store.getLicense(id);
  }

  /** Is this node allowed to load / serve / teach on `entry`? A verification-only copy is not (`verifyOnly`). */
  hasLicense(entry: CatalogEntry): boolean {
    const l = this.licenseOf(entry);
    return !!l && l.source !== 'verification';
  }

  /** Why a knowledge cannot be used here, in the words the CLI and the console print. */
  licenseError(entry: CatalogEntry): MarketError {
    const l = this.licenseOf(entry);
    const price = `${entry.anchor.price} ${entry.anchor.currency}`;
    return conflict(l?.source === 'verification'
      ? `not_licensed: this node holds the body of ${entry.anchor.id} because it verified it — scoring a knowledge is not a licence to serve it. Buy it first (${price}): ainize patch buy ${entry.anchor.id}`
      : `not_licensed: ${entry.anchor.id} has not been bought on this node — buy it first (${price}): ainize patch buy ${entry.anchor.id}`,
      { patch_id: entry.anchor.id, license: l?.source ?? null, price: entry.anchor.price, currency: entry.anchor.currency });
  }

  /** Record a licence explicitly (the buy path, the publisher path, the verifier's possession-only copy). */
  grantLicense(entry: CatalogEntry, source: LicenseSource, detail: string | null = null) {
    this.store.putLicense(entry.anchor.id, entry.anchor.patch_sha256, source, detail);
  }

  // ------------------------------------------------------------------ runtime stack (design §5.4, §8)
  isApplied(patchId: string): boolean { return this.store.listApplied().some((a) => a.patch_id === patchId); }

  /** How deep a base stack may go before it is refused (§12.1 `base_stack_too_deep`). */
  static readonly MAX_STACK_DEPTH = 8;

  /**
   * The ordered stack, bottom first: what is on the shared table right now, in the order it was written, with the
   * journal that would undo each layer. `GET /api/runtime` and `ainize patch stack` show exactly this.
   */
  async stack(): Promise<StackLayer[]> {
    const out: StackLayer[] = [];
    const checked = this.runtimeCheck();
    for (const [i, a] of this.store.listApplied().entries()) {
      const entry = await this.entry(a.patch_id).catch(() => null);
      const blob = this.blobs.get(a.sha256);
      out.push({
        patch_id: a.patch_id, name: entry?.anchor.name ?? null, sha256: a.sha256, position: a.position ?? i,
        applied_at: a.applied_at, reason: a.reason, rows: blob?.rows ?? null,
        export: entry?.anchor.base?.export ?? null,
        base_stack: (entry?.anchor.base?.stack ?? []).map((b) => b.patch_id),
        journal: !!a.journal_path && existsSync(a.journal_path), journal_path: a.journal_path,
        stack_sha256: a.stack_sha256, body_present: !!blob,
        checked_at: checked && checked.patch_id === a.patch_id && checked.sha256 === a.sha256 ? checked.at : null,
        present: checked && checked.patch_id === a.patch_id && checked.sha256 === a.sha256 ? checked.present : null,
      });
    }
    return out;
  }

  /**
   * Everything that must be on the table under `ids`, ancestors first (§8.1). Cycle-safe and depth-capped; a base
   * that this node cannot resolve is named rather than skipped, because applying a delta without it is silent nonsense.
   */
  async resolveStack(ids: string[]): Promise<{ id: string; entry: CatalogEntry; requested: boolean }[]> {
    const out: { id: string; entry: CatalogEntry; requested: boolean }[] = [];
    const placed = new Set<string>();
    const walk = async (id: string, requested: boolean, trail: string[]): Promise<void> => {
      if (placed.has(id)) return;
      if (trail.includes(id)) throw badInput(`base_cycle: ${[...trail, id].join(' → ')} — a knowledge cannot sit on top of itself`, { ids: [...trail, id] });
      if (trail.length >= Market.MAX_STACK_DEPTH) throw badInput(`base_stack_too_deep: more than ${Market.MAX_STACK_DEPTH} knowledges have to be loaded under ${id}`, { id, depth: trail.length });
      const entry = await this.entry(id);
      if (!entry) throw notFound(`patch not found: ${id}`);
      for (const b of entry.anchor.base?.stack ?? []) await walk(b.patch_id, false, [...trail, id]);
      if (placed.has(id)) return;
      placed.add(id);
      out.push({ id, entry, requested });
    };
    for (const id of ids) await walk(id, true, []);
    return Market.orderByLineage(out);
  }

  /**
   * Ancestors first among the knowledges actually being loaded (item 281).
   *
   * `base.stack` is walked above, and it is authoritative — but only a knowledge published WITH the lineage fields
   * has one. Every `publish --parents` child, and every anchor written before those fields existed, declares its
   * family in `parents[]` alone, and today's children carry their base's rows: loading the base last really does
   * overwrite the child's answers on every shared row. The buyer of a family got whichever order they happened to
   * buy in ("applied order on node-d: [grandchild, child, parent]") and no screen hinted at it.
   *
   * A stable topological pass over the declared parents of the ids being loaded — nothing is fetched that was not
   * asked for, and a cycle (a peer anchor may claim any parent) leaves the order exactly as it was.
   */
  static orderByLineage<T extends { id: string; entry: CatalogEntry }>(list: T[]): T[] {
    if (list.length < 2) return list;
    const index = new Map(list.map((x, i) => [x.id, i]));
    const parentsOf = (x: T) => (x.entry.anchor.parents ?? []).filter((p) => index.has(p) && p !== x.id);
    if (!list.some((x) => parentsOf(x).length)) return list;
    const out: T[] = [];
    const done = new Set<string>();
    const visiting = new Set<string>();
    let cycle = false;
    const place = (x: T) => {
      if (done.has(x.id) || cycle) return;
      if (visiting.has(x.id)) { cycle = true; return; }
      visiting.add(x.id);
      // parents in their original relative order, so two independent bases keep the order the caller asked for
      for (const p of parentsOf(x).sort((a, b) => index.get(a)! - index.get(b)!)) place(list[index.get(p)!]);
      visiting.delete(x.id);
      if (done.has(x.id)) return;
      done.add(x.id);
      out.push(x);
    };
    for (const x of list) place(x);
    return cycle || out.length !== list.length ? list : out;
  }

  /** The layers `ids` turn into: bodies resolved, duplicates by body dropped (the same bytes twice is a no-op). */
  private async layersFor(ids: string[], opts: { withBase?: boolean; requireBaseApplied?: boolean; verifyOnly?: boolean } = {}): Promise<Layer[]> {
    const plan = await this.resolveStack(ids);
    const alreadyApplied = new Set(this.store.listApplied().map((a) => a.patch_id));
    const missingBases = plan.filter((p) => !p.requested && !alreadyApplied.has(p.id)).map((p) => p.id);
    if (missingBases.length && opts.requireBaseApplied && !opts.withBase) {
      throw conflict(`needs_base: ${missingBases.join(', ')} must be loaded underneath first — ask for it with { "with_base": true } (or ainize patch apply --with-base)`, { missing: missingBases });
    }
    const notHeld = plan.filter((p) => !this.blobs.has(p.entry.anchor.patch_sha256)).map((p) => p.id);
    if (notHeld.length) throw conflict(`base_not_held: this node does not have the body of ${notHeld.join(', ')} — buy it first`, { missing: notHeld });
    // Item 327 — holding the file is not the right to use it. Inside a verification run (`verifyOnly`) the bases may
    // be verification copies; everywhere else every layer, base included, needs a licence.
    if (!opts.verifyOnly) {
      const unlicensed = plan.filter((p) => !this.hasLicense(p.entry));
      if (unlicensed.length) throw this.licenseError(unlicensed[0].entry);
    }
    const seen = new Set<string>();
    const layers: Layer[] = [];
    for (const p of plan) {
      const blob = this.blobs.get(p.entry.anchor.patch_sha256)!;
      if (seen.has(blob.sha256)) continue;   // one body, one journal (§5.4 names journals by patch_sha256)
      seen.add(blob.sha256);
      layers.push({ id: p.id, sha256: blob.sha256, path: blob.path, delta: p.entry.anchor.base?.export === 'delta', requested: p.requested });
    }
    return layers;
  }

  /**
   * The layers of an EXACT ordered list of ids — no base expansion. This is how the stack that is already on the
   * table is described: it is a record of what was written, not a plan, and re-deriving it from base stacks could
   * silently reorder it. A row whose knowledge or body has gone is dropped with a warning, and `assertStack` then
   * unwinds from there.
   */
  private async layersOfExact(ids: string[]): Promise<Layer[]> {
    const out: Layer[] = [];
    for (const id of ids) {
      const entry = await this.entry(id).catch(() => null);
      const blob = entry ? this.blobs.get(entry.anchor.patch_sha256) : null;
      if (!entry || !blob) { this.log('warn', 'runtime', `${id} is recorded as loaded but ${entry ? 'its body is' : 'it is'} no longer here`, id); continue; }
      out.push({ id, sha256: blob.sha256, path: blob.path, delta: entry.anchor.base?.export === 'delta', requested: false, reason: this.store.getApplied(id)?.reason });
    }
    return out;
  }

  /** Fingerprint of an ordered stack — what the journal records as "this is the table state I was written over". */
  private static stackFingerprint(layers: { id: string; sha256: string }[]): string {
    return sha256Hex(layers.map((l) => `${l.id}:${l.sha256}`).join('\n'));
  }

  /**
   * Bring the shared table to exactly `target` (bottom first), touching only what differs from the recorded stack:
   * unwind from the top down to the longest common prefix (replaying each journal, so a parent is left standing when
   * its child comes off), then apply the rest upwards. Every apply of a delta is gated on `prev == before` over ALL
   * rows and journals the `prev` the hook returns. MUST be called inside `runtime.exclusive()`.
   */
  private async assertStack(target: Layer[], reason: string, opts: { rebuild?: boolean } = {}): Promise<{ applied: string[]; removed: string[]; ms: Record<string, number> }> {
    const cur = this.store.listApplied();
    let keep = 0;
    if (!opts.rebuild) while (keep < cur.length && keep < target.length && cur[keep].patch_id === target[keep].id) keep++;
    const removed: string[] = [];
    for (let i = cur.length - 1; i >= keep; i--) {
      const row = cur[i];
      const blob = this.blobs.get(row.sha256);
      if (opts.rebuild) {
        // The table went back to base under us (restart): the journals describe values that no longer exist.
        if (row.journal_path) { try { rmSync(row.journal_path, { force: true }); } catch { /* best effort */ } }
      } else if (blob) {
        const r = await this.runtime.removeRaw(blob.path, { journal: row.journal_path ?? undefined });
        if (r.code !== 0) throw new Error(`removing ${row.patch_id} failed: ${r.err || r.out}`);
        this.log('info', 'runtime', `unloaded ${row.patch_id}: ${r.out}`, row.patch_id);
      } else {
        this.log('warn', 'runtime', `${row.patch_id} is recorded as loaded but its body is gone — dropping it from the stack without unwinding`, row.patch_id);
      }
      this.store.clearApplied(row.patch_id);
      removed.push(row.patch_id);
    }
    const applied: string[] = [];
    /** How long each layer took to write — the live test reports it per knowledge and must never print an unmeasured number. */
    const ms: Record<string, number> = {};
    for (let i = keep; i < target.length; i++) {
      const t = target[i];
      const stackSha = Market.stackFingerprint(target.slice(0, i));
      const journal = this.runtime.journalPath(t.sha256) ?? undefined;
      const t0 = Date.now();
      const r = await this.runtime.applyRaw(t.path, { journal, stackSha, verifyBefore: t.delta });
      ms[t.id] = Date.now() - t0;
      if (r.json?.error === 'base_mismatch') {
        throw conflict(`base_mismatch: the live rows under ${t.id} are not the ones it was trained on (${r.json.rows_differ} of ${r.json.rows} rows differ) — nothing was written`,
          { patch_id: t.id, rows_differ: r.json.rows_differ, rows: r.json.rows });
      }
      if (r.code !== 0) throw new Error(`applying ${t.id} failed: ${r.err || r.out}`);
      this.store.setApplied(t.id, t.sha256, t.reason ?? reason, { position: i, journal_path: journal ?? null, stack_sha256: stackSha });
      applied.push(t.id);
      this.log('info', 'runtime', `loaded ${t.id} at position ${i}${t.delta ? ' (add-on: its base was verified row by row underneath)' : ''}: ${r.out}`, t.id);
    }
    this.store.reorderApplied(target.map((t) => t.id));
    this.store.set('runtime.stack', JSON.stringify(target.map((t) => t.id)));
    return { applied, removed, ms };
  }

  /**
   * Put the recorded stack back on the table and CHECK it landed. Used after a live test that had to write over rows
   * whose owner this node does not know (item 211): the record can be right and the table still wrong, so the top
   * layer is probed and the whole stack rebuilt from the base model when it is gone.
   */
  private async assertRecorded(ids: string[], reason: string, opts: { probe?: boolean } = {}): Promise<void> {
    const target = await this.layersOfExact(ids);
    await this.assertStack(target, reason);
    if (!opts.probe || !target.length) return;
    const top = target[target.length - 1];
    const st = await this.runtime.statusOf(top.path, { journal: this.runtime.journalPath(top.sha256) ?? undefined });
    if (st && !st.applied) {
      this.log('warn', 'runtime', `${top.id} was not on the model after the restore — rebuilding this node's stack of ${target.length} from the base model`, top.id);
      await this.assertStack(target, reason, { rebuild: true });
    }
  }

  /**
   * Load `ids` in one ordered sequence under ONE runtime lock (§8.1): each id's bases go on first, then the id.
   * Unrelated patches already on the table stay where they are, underneath.
   */
  async applyStack(ids: string[], reason: string, opts: { withBase?: boolean; onEnter?: () => void } = {}): Promise<{ applied: string[]; removed: string[]; ms: Record<string, number>; stack: string[] }> {
    // What is wrong with the REQUEST is decided before what is wrong with the machine: a knowledge this node has no
    // licence for (item 327) or a missing base is the same answer whether or not the model happens to be up.
    const layers = await this.layersFor(ids, { withBase: opts.withBase, requireBaseApplied: true });
    const st = await this.runtime.status();
    if (!st.available) throw unavailable(st.error ?? 'runtime unavailable');
    const current = this.store.listApplied().map((a) => a.patch_id);
    // What is already on the table stays exactly where it is (§8.3 allows an unrelated patch between a base and its
    // child); only the layers that are missing go on top, ancestors first.
    const target: Layer[] = [...(await this.layersOfExact(current)), ...layers.filter((l) => !current.includes(l.id)).map((l) => ({ ...l, reason }))];
    return this.runtime.exclusive(`apply:${ids.join('+')}`, async () => {
      const res = await this.assertStack(target, reason);
      return { ...res, stack: target.map((t) => t.id) };
    }, { onEnter: opts.onEnter });
  }

  /**
   * Load one knowledge (and, with `with_base`, everything it was trained on top of) — ancestors first (§8.1).
   *
   * What comes back says the ORDER, not only the names (SC-15 `apply.order`). `applied` is what was written just
   * now, and on a table that already carries the base that is the child alone: printing it by itself would tell an
   * operator a delta had been loaded onto nothing. `order` is the chain the child ends up sitting on, so the answer
   * is the same sentence whether the base arrived a second ago or last week.
   */
  async applyPatch(patchId: string, reason: string, opts: { withBase?: boolean; onEnter?: () => void } = {}): Promise<ApplyOutcome> {
    const entry = await this.entry(patchId);
    if (!entry) throw notFound('patch not found');
    const res = await this.applyStack([patchId], reason, opts);
    const order = (await this.resolveStack([patchId])).map((p) => p.id);
    const already = order.filter((id) => !res.applied.includes(id));
    const text = !res.applied.length ? `${patchId} was already loaded`
      : order.length > 1 ? `loaded in order: ${order.join(' → ')}${already.length ? ` (${already.join(', ')} ${already.length > 1 ? 'were' : 'was'} already on the table)` : ''}`
        : `loaded ${patchId}`;
    return { text, order, loaded: res.applied, stack: res.stack };
  }

  // ---------------------------------------------------------------- queued runtime jobs (item 212)
  /**
   * An apply or a remove waits behind the shared model lock, and that wait is unbounded: another node's live test or
   * verification can hold it for minutes. The synchronous POST then died on the HTTP client's own header timeout and
   * the CLI reported `cannot reach node … (fetch failed)`, exit 2 — while the node happily ran the operation five
   * minutes later. So the work is a job: the POST answers 202 immediately and the caller polls this.
   */
  private jobs = new Map<string, RuntimeJob>();
  runtimeJob(id: string): RuntimeJob | null {
    const j = this.jobs.get(id);
    if (!j) return null;
    const q = this.runtime.queueState();
    return { ...j, queue: { running: q.running, waiting: q.waiting, lock: q.lock ? { label: q.lock.label, owner: q.lock.owner, since: q.lock.since, mine: q.lock.mine } : null } };
  }
  listRuntimeJobs(): RuntimeJob[] { return [...this.jobs.values()].sort((a, b) => b.queued_at - a.queued_at); }

  /** Start a queued runtime job and return it immediately (the work continues in the background). */
  startRuntimeJob(kind: 'apply' | 'remove', patchId: string, run: (onEnter: () => void) => Promise<string>): RuntimeJob {
    const id = randomBytes(9).toString('hex');
    const job: RuntimeJob = { id, kind, patch_id: patchId, state: 'queued', queued_at: Date.now(), started_at: null, finished_at: null, result: null, error: null };
    this.jobs.set(id, job);
    if (this.jobs.size > 200) { const oldest = [...this.jobs.values()].sort((a, b) => a.queued_at - b.queued_at)[0]; if (oldest) this.jobs.delete(oldest.id); }
    run(() => { job.state = 'running'; job.started_at = Date.now(); })
      .then((result) => { job.state = 'done'; job.result = result; })
      .catch((e: Error & { status?: number; details?: Record<string, unknown> }) => { job.state = 'failed'; job.error = e.message; job.status = e.status ?? 500; job.details = e.details ?? null; })
      .finally(() => { job.finished_at = Date.now(); });
    return job;
  }

  /** Applied knowledges that sit on top of `id` (directly or through another knowledge) — what removing it would break. */
  async dependentsOf(id: string): Promise<string[]> {
    const rows = this.store.listApplied();
    const bases = new Map<string, string[]>();
    for (const a of rows) {
      const e = await this.entry(a.patch_id).catch(() => null);
      bases.set(a.patch_id, (e?.anchor.base?.stack ?? []).map((b) => b.patch_id));
    }
    const out: string[] = [];
    let frontier = [id];
    for (let depth = 0; depth < Market.MAX_STACK_DEPTH && frontier.length; depth++) {
      const next: string[] = [];
      for (const [child, parents] of bases) {
        if (out.includes(child) || child === id) continue;
        if (parents.some((p) => frontier.includes(p))) { out.push(child); next.push(child); }
      }
      frontier = next;
    }
    return out;
  }

  /**
   * Unload one knowledge (§8.4). Refuses while something built on it is loaded, unless `cascade`. What comes back is
   * the journal — whatever was under it — so removing a child leaves its parent standing, not the bare model.
   */
  async removePatch(patchId: string, opts: { cascade?: boolean; onEnter?: () => void } = {}): Promise<string> {
    const entry = await this.entry(patchId);
    if (!entry) throw notFound('patch not found');
    const current = this.store.listApplied();
    if (!current.some((a) => a.patch_id === patchId)) {
      // Not in the recorded stack: the operator's escape hatch (a body left on the table by an older node). No journal
      // exists, so this writes the file's own `before` — which is the disk base, exactly what it always did.
      const blob = this.blobs.get(entry.anchor.patch_sha256);
      if (!blob) throw conflict('patch body not present');
      const r = await this.runtime.remove(blob.path);
      if (r.code !== 0) throw new Error(r.err || r.out);
      this.log('warn', 'runtime', `removed ${patchId} without a journal (it was not in this node's stack) — its rows went back to the base model`, patchId);
      return r.out;
    }
    const dependents = await this.dependentsOf(patchId);
    if (dependents.length && !opts.cascade) {
      throw conflict(`has_dependents: ${dependents.join(', ')} ${dependents.length > 1 ? 'are' : 'is'} loaded on top of ${patchId} and would stop working — unload ${dependents.length > 1 ? 'them' : 'it'} first, or ask for cascade`, { ids: dependents });
    }
    const drop = new Set([patchId, ...(opts.cascade ? dependents : [])]);
    const target = await this.layersOfExact(current.map((a) => a.patch_id).filter((id) => !drop.has(id)));
    const res = await this.runtime.exclusive(`remove:${patchId}`, () => this.assertStack(target, 'remove'), { onEnter: opts.onEnter });
    this.log('info', 'runtime', `unloaded ${res.removed.join(', ')}${res.applied.length ? `; re-asserted ${res.applied.join(' → ')}` : ''}`, patchId);
    return `unloaded ${res.removed.join(', ')}${res.applied.length ? ` (re-asserted ${res.applied.join(' → ')})` : ''}`;
  }

  /**
   * Watchdog (청구항 3 재적용, §8.5): the top of the stack is the only thing that has to be tested — if it is still
   * on the table, everything under it is too. When it is gone (vLLM restart) the WHOLE stack is re-applied in order.
   * The old per-patch `isApplied → apply` loop could re-apply a parent on top of its own child (F5).
   */
  async watchdog(): Promise<void> {
    const st = await this.runtime.status();
    if (!st.available) return;
    await this.recoverRuntime();
    // The probe itself happens INSIDE the lock. Reading the table while another operation is halfway through writing
    // it would report "reverted" for a stack that is perfectly fine, and the rebuild would then discard live journals.
    // When the lock is held by someone else there is nothing to fix yet — the next tick is 20 s away.
    await this.runtime.exclusiveTry('watchdog', async () => {
      const cur = this.store.listApplied();
      if (!cur.length) return;
      const top = cur[cur.length - 1];
      const blob = this.blobs.get(top.sha256);
      if (!blob) return;
      const target = await this.layersOfExact(cur.map(row => row.patch_id)).catch(error => { this.log('error', 'runtime', `cannot rebuild the stack: ${(error as Error).message}`); return null; });
      if (!target?.length) return;
      const status = await this.runtime.statusOf(blob.path, { journal: top.journal_path ?? undefined });
      // Whatever it says, WRITE IT DOWN (item 215): this is the only measurement of the live table anything makes.
      if (status) this.noteRuntimeCheck(top.patch_id, top.sha256, status.applied, 'watchdog');
      if (!status || status.applied) return;
      // Item 258: this line used to say "(restart?)" — a diagnosis nothing had checked. Every node on this machine
      // shares one serving model, so the usual cause is another node's verification or live test writing these very
      // rows; name this node's last runtime operation and leave the reader to see whether it was one of ours.
      const last = this.runtime.lastOperation();
      const ago = last ? `${Math.round((Date.now() - last.at) / 1000)} s ago` : 'never';
      this.log('warn', 'runtime', `${top.patch_id} is no longer on the shared model — its rows were overwritten (this node's last runtime operation: ${last ? `${last.label}, ${ago}` : 'none since start'}; the serving model is shared with every node on this machine, and a restart writes the base back too) → re-applying the whole stack of ${cur.length} in order`, top.patch_id, { last_operation: last, stack: cur.map((a) => a.patch_id) });
      await this.assertStack(target, 'watchdog', { rebuild: true });
      this.noteRuntimeCheck(top.patch_id, top.sha256, true, 'watchdog:re-applied');
    }, { waitMs: 5_000 }).catch((e) => {
      if (!/shared runtime busy/.test((e as Error).message)) this.log('error', 'runtime', `re-applying the stack failed: ${(e as Error).message}`);
    });
  }

  /**
   * The watchdog's last PHYSICAL measurement of the shared table (item 215).
   *
   * `isApplied` is a store lookup and `/api/runtime.applied` is that lookup rendered, so every surface said a
   * knowledge was in the model whenever the row existed — including through a rollback and through every
   * verification restore, exactly the windows when the model answers WITHOUT it. `patch.py status` is the only
   * thing that knows, the watchdog runs it every 20 s on the top of the stack, and until now it told nobody.
   */
  static readonly CHECK_KEY = 'runtime.checked';
  runtimeCheck(): { patch_id: string; sha256: string; at: number; present: boolean; source: string } | null {
    const raw = this.store.get(Market.CHECK_KEY);
    if (!raw) return null;
    try { return JSON.parse(raw) as { patch_id: string; sha256: string; at: number; present: boolean; source: string }; } catch { return null; }
  }
  private noteRuntimeCheck(patch_id: string, sha256: string, present: boolean, source: string) {
    this.store.set(Market.CHECK_KEY, JSON.stringify({ patch_id, sha256, at: Date.now(), present, source }));
  }

  /** kv key holding the stack an interrupted verification / live test has to put back (item 126). */
  static readonly RESTORE_KEY = 'runtime.restore';
  private recovered = false;

  /**
   * First tick after a start: undo whatever an interrupted verification or live test left on the shared model
   * (item 126). Those two are the only operations that load a body the node does not serve, and until now they
   * wrote no marker at all — a SIGKILL between apply and restore left the table patched with nothing in the
   * database that knew it, so every later "before" answer and every later `pre_apply` baseline was measured
   * against a contaminated model. `applied` rows whose reason is `verify:`/`chat:` are exactly that marker, and
   * `runtime.restore` holds the stack the run took off before it started.
   */
  async recoverRuntime(force = false): Promise<void> {
    if (this.recovered && !force) return;
    this.recovered = true;
    // Everything is read INSIDE the lock: a live test or a verification that is running right now legitimately has
    // `chat:`/`verify:` rows, and acting on a copy read before the lock would undo a run that then finished fine.
    await this.runtime.exclusive('recover', async () => {
      const raw = this.store.get(Market.RESTORE_KEY);
      const cur = this.store.listApplied();
      const transient = cur.filter((a) => /^(verify|chat):/.test(a.reason));
      let snapshot: string[] | null = null;
      if (raw) { try { snapshot = (JSON.parse(raw) as { ids?: string[] }).ids ?? null; } catch { snapshot = null; } }
      if (!snapshot && !transient.length) return;
      const wanted = (snapshot ?? cur.filter((a) => !/^(verify|chat):/.test(a.reason)).map((a) => a.patch_id)).filter((id) => !transient.some((t) => t.patch_id === id));
      this.log('warn', 'runtime', `a ${transient[0]?.reason.startsWith('chat') ? 'live test' : 'verification'} was interrupted with ${transient.map((a) => a.patch_id).join(', ') || 'nothing'} still on the shared model — putting the table back to ${wanted.length ? wanted.join(' → ') : 'the base model'}`, transient[0]?.patch_id ?? null);
      const top = cur[cur.length - 1];
      const blob = top ? this.blobs.get(top.sha256) : null;
      // If the model itself restarted while we were gone the journals describe values that no longer exist: rebuild.
      const status = blob ? await this.runtime.statusOf(blob.path, { journal: top.journal_path ?? undefined }) : null;
      const rebuild = !!status && !status.applied;
      await this.assertStack(await this.layersOfExact(wanted), 'recover', { rebuild });
      this.store.set(Market.RESTORE_KEY, '');
    }).catch((e) => this.log('error', 'runtime', `could not put the table back after an interrupted run: ${(e as Error).message}`));
  }

  /**
   * Run a benchmark on the shared model with NOTHING on the table but the candidate's own declared base stack
   * (items 241, 258), then put this node's stack back exactly as it was found.
   *
   * Before this, a verifier that also served a track ran the benchmark on top of whatever it was serving: yesterday's
   * bake was under today's candidate, the `pre_apply` baseline was measured through it, and the restore then wrote
   * the candidate's `before` over rows the subscription owned — which is why the subscriber flapped
   * "reverted (restart?)" all morning while the network verified. Both are one bug: a verification is a measurement
   * of ONE knowledge, so it happens on a table holding exactly that knowledge and its declared bases.
   */
  async verifyIsolated(anchor: PatchAnchor, npz: string, opts: { below?: { id: string; path: string; sha256: string }[]; journal?: string; delta?: boolean; maxSamples?: number } = {}): Promise<VerifyOutcome> {
    const below = opts.below ?? [];
    const label = `verify:${anchor.id}`;
    const sha = anchor.patch_sha256;
    return this.runtime.exclusive(label, async () => {
      const snapshot = this.store.listApplied().map((a) => a.patch_id);
      // Written BEFORE anything moves: if this process dies mid-run the next start knows what to put back (item 126).
      this.store.set(Market.RESTORE_KEY, JSON.stringify({ ids: snapshot, reason: label, at: Date.now() }));
      const removedForRun = snapshot.filter((id) => !below.some((b) => b.id === id) && id !== anchor.id);
      if (removedForRun.length) this.log('info', 'verifier', `taking ${removedForRun.join(', ')} off the shared model for the duration of the ${anchor.id} benchmark — a verification measures one knowledge, not whatever this node happens to serve`, anchor.id);
      try {
        // The candidate's declared bases go on (verification copies are allowed here and only here), nothing else.
        const baseLayers = below.length ? await this.layersFor(below.map((b) => b.id), { withBase: true, verifyOnly: true }) : [];
        await this.assertStack(baseLayers.map((l) => ({ ...l, reason: label })), label);
        return await this.runtime.verifyInLock(npz, anchor.benchmark, {
          below, journal: opts.journal, delta: opts.delta, label: anchor.id,
          ...(opts.maxSamples ? { maxSamples: opts.maxSamples } : {}),
          mark: {
            applying: () => this.store.setApplied(anchor.id, sha, label, { journal_path: opts.journal ?? null }),
            restored: () => this.store.clearApplied(anchor.id),
          },
        });
      } finally {
        // Whatever happened above — pass, fail, throw, base_mismatch — the node is left serving what it was serving.
        await this.assertStack(await this.layersOfExact(snapshot), 'restore')
          .catch((e) => this.log('error', 'runtime', `could not put this node's stack back after verifying ${anchor.id}: ${(e as Error).message}`, anchor.id));
        this.store.set(Market.RESTORE_KEY, '');
      }
    });
  }

  // ------------------------------------------------------------------ ChatMode (live test of a knowledge patch)
  private chatUsage = new Map<string, { count: number; window: number }>();
  /** D3 — one ticket per live test so the client can be told it is queued (and cancel while it still costs nothing). */
  readonly chatQueue = new ChatQueue();

  /** Per-visitor trial quota for public live tests (operator is unlimited). Returns remaining or -1 when exhausted. */
  /**
   * Give back a reservation the work never used (item 376).
   *
   * The free-try budget is peeked before the model runs and committed after, so a request that fails or hangs does
   * not burn a try — a deliberate choice, and the right one for a single request. It is the wrong one for thirty:
   * concurrent calls all peeked against the same untouched counter, all passed, and each drove its own round on
   * the shared serving GPU. Taking the units up front and handing them back on failure keeps the promise and
   * makes the budget mean something under load.
   */
  refundChatQuota(visitor: string, units = 1): void {
    const u = this.chatUsage.get(visitor);
    if (u) u.count = Math.max(0, u.count - units);
  }

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
    // §8.6 — what goes on the table, and in what order, comes from the base stacks, not from the order the boxes were
    // ticked: an add-on trained on top of another knowledge answers nonsense without that knowledge underneath it.
    const plan = entries.length ? await this.resolveStack(entries.map((x) => x.id)) : [];
    const targets: { id: string; entry: CatalogEntry; path: string; base: boolean }[] = [];
    for (const { id, entry, requested } of plan) {
      if (!requested && !this.mayUseEntry(entry, opts.caller)) throw new NotFoundError(`patch not found: ${id}`);
      const blob = this.blobs.get(entry.anchor.patch_sha256);
      if (!blob) {
        throw conflict(requested
          ? `this node does not hold the patch body of ${id} — buy it first (or test it on the seller node)`
          : `${id} has to be loaded underneath ${entries.map((x) => x.id).join(', ')} and this node does not hold its body — buy it first`,
          { missing: [id] });
      }
      if (st.model && !entry.anchor.model.id_M.startsWith(st.model)) throw conflict(`patch ${id} targets ${entry.anchor.model.id_M} but this node serves ${st.model}`);
      // Item 327 — the body being on disk is not the right to run it. A verifier holds everything it ever scored.
      if (!this.hasLicense(entry)) throw this.licenseError(entry);
      targets.push({ id, entry, path: blob.path, base: !requested });
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
      //
      // Item 211 — what counts as "already loaded" is what this node RECORDED as loaded, not what a sampled
      // comparison of the live rows suggests. `patch.py status` answers "closer to trained than to original", so a
      // body another process left on the shared table read as `was_applied: true`: the visitor was shown "· was
      // already loaded", the Before column was measured through it, and the restore step then re-asserted the
      // leftover for everyone. The heuristic still runs, as a CHECK on the record.
      const pinnedRows = this.store.listApplied();
      const pinned = pinnedRows.map((a) => a.patch_id);
      const targetIds = new Set(targets.map((t) => t.id));
      const wasApplied = targets.map((t) => pinned.includes(t.id));
      const chatReason = `chat:${opts.visitor.slice(0, 16)}`;
      const dirty: string[] = [];
      for (const [i, t] of targets.entries()) {
        if (wasApplied[i]) continue;
        const onTable = await this.runtime.isApplied(t.path, this.runtime.journalPath(t.entry.anchor.patch_sha256) ?? undefined);
        if (onTable === true) dirty.push(t.id);
      }
      for (const id of dirty) {
        this.dirtySeen.set(id, Date.now());
        this.log('warn', 'runtime', `${id} is on the shared model but not in this node's stack — something else left it there. It is removed for the "before" answer and NOT put back.`, id, { visitor: opts.visitor });
      }
      const appliedMs: (number | null)[] = targets.map(() => null);
      let base: ChatResult | null = null; let patched: ChatResult | null = null;
      // The stack this test writes over, so an interrupted test is undone at the next start (item 126).
      this.store.set(Market.RESTORE_KEY, JSON.stringify({ ids: pinned, reason: chatReason, at: Date.now() }));
      try {
        // A leftover body belongs to nobody: with no journal for it the only way back is its own `before` (the
        // model's own rows). Anything of ours it displaced is put back by the probe-and-rebuild restore below.
        for (const id of dirty) {
          const t = targets.find((x) => x.id === id)!;
          await this.runtime.removeRaw(t.path).catch((e) => this.log('error', 'runtime', `could not remove the leftover ${id}: ${(e as Error).message}`, id));
        }
        const belowLayers = await this.layersOfExact(pinned.filter((id) => !targetIds.has(id)));
        const testLayers: Layer[] = [];
        const seenSha = new Set(belowLayers.map((l) => l.sha256));
        for (const t of targets) {
          const sha = t.entry.anchor.patch_sha256;
          if (seenSha.has(sha)) continue;      // one body, one journal (§5.4)
          seenSha.add(sha);
          testLayers.push({ id: t.id, sha256: sha, path: t.path, delta: t.entry.anchor.base?.export === 'delta', requested: !t.base, reason: chatReason });
        }
        if (mode === 'base' || mode === 'compare') {
          // Everything the test is about comes off — through the journal, so a knowledge underneath it stays standing.
          await this.assertStack(belowLayers, chatReason);
          base = await this.runtime.chat(msgsBase, chatOpts);
        }
        if (mode === 'patched' || mode === 'compare') {
          const res = await this.assertStack([...belowLayers, ...testLayers], chatReason);
          targets.forEach((t, i) => { appliedMs[i] = res.ms[t.id] ?? null; });
          patched = await this.runtime.chat(msgsPatched, chatOpts);
        }
      } finally {
        // Always leave this node serving exactly what it served before the test — the recorded stack, in its recorded
        // order, with each layer's own reason. `probe` is on when a leftover was written over: the record can be
        // right and the table still wrong, and only a read of the live rows can tell.
        await this.assertRecorded(pinned, 'restore', { probe: dirty.length > 0 })
          .catch((e) => this.log('error', 'runtime', `restore after the live test failed: ${(e as Error).message}`));
        this.store.set(Market.RESTORE_KEY, '');
      }
      const lastUser = [...msgs].reverse().find((m) => m.role === 'user')?.content ?? '';
      const hits: Record<string, boolean | null> = {};
      const applied = targets.map((t, i) => ({ patch_id: t.id, applied_ms: appliedMs[i], was_applied: wasApplied[i], ...(t.base ? { base: true } : {}) }));
      for (const [i, t] of targets.entries()) {
        // A base loaded underneath is not a live test OF that base: it is not metered and not scored (it is credited
        // when the child sells, §11). `applied[]` still names it so the UI can say "loaded with {name}".
        if (t.base) continue;
        const sample = matchBenchmarkSample(t.entry.anchor.benchmark.samples, lastUser);
        // Scored on what the MODEL produced, not on what the D1 guard shows: truncating a runaway must never
        // change a ✓/✗ verdict (and a correct bare ticker is never truncated anyway).
        const answer = patched ? patched.raw_content ?? patched.content : null;
        const hit = sample && answer !== null ? answer.replace(/\s/g, '').includes(sample.expect) : null;
        hits[t.id] = hit;
        // `visitor` is the HMAC id (never an address); `sample_index` is what the "own questions it got wrong" panel keys on (§10)
        this.log('info', 'usage', `live test ${t.id}${ids.length > 1 ? ` [+${ids.length - 1}]` : ''} (${opts.mode}) by ${opts.visitor.slice(0, 24)}: ${patched ? 'patched hit=' + hit : 'base only'}`, t.id,
          // `question` is the keyed cluster of the prompt (item 199): two people asking the same thing meet on it,
          // and nothing can turn it back into the text. Without it a miss on a question the knowledge does NOT
          // publish — the 32 on node-a — was a row with a timestamp and no way to tell which question it was.
          { visitor: opts.visitor, mode: opts.mode, hit, base_ms: base?.latency_ms, patched_ms: patched?.latency_ms, applied_ms: appliedMs[i], patch_ids: ids, position: i + 1, sample_index: sample?.index ?? null, question: this.questionCluster(lastUser) });
        // materialised at write time: the counters survive the 90-day event retention
        if (patched) this.store.bumpSignals(t.id, { tests: 1, hits: hit === true ? 1 : 0, misses: hit === false ? 1 : 0, unscored: hit === null ? 1 : 0 }, { visitor: opts.visitor });
        // SC-12 *own*: a question this knowledge PUBLISHES and just got wrong on this node. The prompt is already on
        // the record, so the row keeps only its index — nothing new about the visitor or the text is stored.
        if (patched && hit === false && sample) this.store.bumpIssue(t.id, 'own_miss', this.questionCluster(sample.prompt), { sample_index: sample.index, visitor: opts.visitor });
      }
      const sum = appliedMs.filter((x): x is number => x !== null);
      const anyHit = Object.values(hits);
      // SC-13: the id the visitor's *Mark wrong* comes back with. The question itself is held here, in memory, keyed
      // to the visitor who asked it — so a feedback call needs no prompt in its body (nobody can attribute text to a
      // knowledge they never asked) and nothing is written to the database unless they press *Share*.
      const turnId = this.rememberTurn(opts.visitor, lastUser, targets.filter((t) => !t.base).map((t) => t.id), hits);
      if (baseOnly) this.log('info', 'usage', `live test (base model, nothing loaded) by ${opts.visitor.slice(0, 24)}`, undefined, { visitor: opts.visitor, mode, question: this.questionCluster(lastUser) });
      return {
        turn_id: turnId,
        patch_id: ids[0] ?? '', patch_ids: ids, mode, base, patched,
        applied_ms: sum.length ? sum.reduce((a, b) => a + b, 0) : null, was_applied: wasApplied[0] ?? false, model: st.model,
        benchmark_hit: anyHit.some((h) => h === true) ? true : anyHit.some((h) => h === false) ? false : null,
        applied, benchmark_hits: hits, dirty,
        history: { base: msgsBase.length, patched: msgsPatched.length, split: JSON.stringify(msgsBase) !== JSON.stringify(msgsPatched) },
      };
    }, { onEnter });
  }

  /**
   * Every knowledge this node's model COULD run, with what stands between it and a live test (items 297, 327).
   *
   * The picker used to be `blobs.has(...)` and nothing else, so a knowledge this node had not fetched was simply
   * absent: no row, no price, no seller, no way to ask for it — and the terminal answered "unknown knowledge", the
   * same words a typo gets. A verifier, meanwhile, holds every body it ever scored, which is possession and not a
   * licence. Both facts belong on the same row.
   */
  async chatCatalog(opts: { ownDrafts?: boolean } = {}): Promise<PickerRow[]> {
    const st = await this.runtime.status();
    const out: PickerRow[] = [];
    for (const e of await this.catalog()) {
      // Item 108 — a DRAFT is exactly what `--no-announce` is for, and POST /api/chat has always loaded one; only
      // the picker pretended it could not. It stays out of every anonymous answer (a draft is private, and the
      // visitor could do nothing with it), and appears for this node's own operator, whose test-before-you-announce
      // loop is the whole point of holding it back.
      if (e.status === 'DRAFT' && !(opts.ownDrafts && sameAddr(e.anchor.author, this.address))) continue;
      // A body trained for another model can never run here — that is not "buy it", it is "wrong model".
      if (st.model && !e.anchor.model.id_M.startsWith(st.model)) continue;
      const held = this.blobs.has(e.anchor.patch_sha256);
      const lic = this.licenseOf(e);
      const licensed = !!lic && lic.source !== 'verification';
      out.push({
        entry: e, held, licensed, license: lic?.source ?? null, testable: held && licensed,
        buyable: !!e.sellable && !(held && licensed),
        reason: held && licensed ? 'ok' : lic?.source === 'verification' ? 'verify_only' : held ? 'not_licensed' : 'not_held',
        requests: this.requestCount(e.anchor.id),
      });
    }
    return out;
  }

  /** Patches this node may actually load right now (held AND licensed) — what ChatMode can test. */
  async testablePatches(opts: { ownDrafts?: boolean } = {}): Promise<CatalogEntry[]> {
    return (await this.chatCatalog(opts)).filter((r) => r.testable).map((r) => r.entry);
  }

  /** How many different visitors have asked this node's operator to get a knowledge (item 297). */
  requestCount(patchId: string): number {
    const rows = this.store.events({ kind: 'demand', patch_id: patchId, limit: 500 });
    return new Set(rows.map((r) => (r.data as { visitor?: string } | null)?.visitor ?? String(r.seq))).size;
  }

  /**
   * "I want to test / build on this and it is not here" — the only first step a visitor has, since buying is
   * operator-only (item 297). Writes one `demand` event the operator sees in the log and on the knowledge itself.
   */
  async requestPatch(patchId: string, visitor: string): Promise<{ patch_id: string; requests: number }> {
    const e = await this.entry(patchId);
    if (!e || e.status === 'DRAFT') throw notFound('patch not found');
    if (this.blobs.has(e.anchor.patch_sha256) && this.hasLicense(e)) throw conflict('this node already holds that knowledge');
    const already = this.store.events({ kind: 'demand', patch_id: patchId, limit: 500 })
      .some((r) => (r.data as { visitor?: string } | null)?.visitor === visitor);
    if (!already) {
      this.log('info', 'demand', `a visitor asked for ${e.anchor.name} (${patchId}) — ${e.anchor.price} ${e.anchor.currency} from ${e.anchor.author_name ?? e.anchor.author.slice(0, 10)}: ainize patch buy ${patchId}`, patchId, { visitor, price: e.anchor.price, currency: e.anchor.currency, seller: e.anchor.author });
    }
    return { patch_id: patchId, requests: this.requestCount(patchId) };
  }

  /**
   * Pairwise overlap among the given entries — in memory entries AND in questions (item 222).
   *
   * "…overlap on 2,170 memory entries — Pixelplus, ticked last, wins" is true and tells a normal person nothing
   * they can act on: which questions change, and whether the loser still answers its own. Both anchors publish
   * their benchmark samples (prompt → expect), so the pair CAN be described in the terms the visitor is thinking
   * in — how many of the same questions they answer, and on how many of those they disagree — instead of leaving
   * them to spend free tries probing. Questions are matched on the parser's own key (F13), so "the same question"
   * means the same thing here as in a dataset and in `covered_by`.
   */
  chatOverlaps(entries: CatalogEntry[]): { a: string; b: string; rows: number; questions_shared: number; questions_disagree: number }[] {
    const sets = entries.map((e) => ({
      id: e.anchor.id,
      set: this.blobs.addrSet(e.anchor.patch_sha256),
      answers: new Map((e.anchor.benchmark.samples ?? []).map((sm) => [questionKey(sm.prompt), sm.expect])),
    }));
    const out: { a: string; b: string; rows: number; questions_shared: number; questions_disagree: number }[] = [];
    for (let i = 0; i < sets.length; i++) {
      for (let j = i + 1; j < sets.length; j++) {
        const n = sets[i].set && sets[j].set ? intersectionCount(sets[i].set!, sets[j].set!) : 0;
        let shared = 0; let disagree = 0;
        for (const [k, v] of sets[i].answers) {
          const other = sets[j].answers.get(k);
          if (other === undefined) continue;
          shared++;
          if (other.replace(/\s+/g, '') !== v.replace(/\s+/g, '')) disagree++;
        }
        if (n > 0 || shared > 0) out.push({ a: sets[i].id, b: sets[j].id, rows: n, questions_shared: shared, questions_disagree: disagree });
      }
    }
    return out.sort((x, y) => y.questions_disagree - x.questions_disagree || y.rows - x.rows);
  }

  /** Ids the operator keeps loaded in the serving model (they colour the "before" answer of every live test). */
  pinnedPatchIds(): string[] { return this.store.listApplied().map((a) => a.patch_id); }

  /** Bodies a live test found on the shared model that this node never loaded (item 211), and when. */
  private dirtySeen = new Map<string, number>();
  /** What the picker warns about: leftovers seen in the last `windowMs`, newest first. */
  recentDirty(windowMs = 10 * 60_000): string[] {
    const cut = Date.now() - windowMs;
    for (const [id, at] of this.dirtySeen) if (at < cut) this.dirtySeen.delete(id);
    return [...this.dirtySeen.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  }

  // ------------------------------------------------------------------ chat turns kept for feedback (SC-13)
  /**
   * The last few thousand live-test turns, in memory only: `turn_id → { visitor, prompt, patch_ids, hits }`.
   * The prompt is held so *Mark wrong* can name the question WITHOUT the browser sending text the node would have to
   * trust, and it is written to the database only when the visitor chooses *Share* (§10 privacy preconditions). A
   * restart forgets them, which is the honest cost of not persisting what nobody consented to keep.
   */
  private turns = new Map<string, { visitor: string; prompt: string; patch_ids: string[]; hits: Record<string, boolean | null>; at: number }>();
  private rememberTurn(visitor: string, prompt: string, patchIds: string[], hits: Record<string, boolean | null>): string {
    const id = randomBytes(9).toString('hex');
    if (this.turns.size > 4000) { const cut = Date.now() - 6 * 3600_000; for (const [k, v] of this.turns) if (v.at < cut || this.turns.size > 4000) { this.turns.delete(k); if (this.turns.size <= 3000) break; } }
    this.turns.set(id, { visitor, prompt, patch_ids: patchIds, hits, at: Date.now() });
    return id;
  }
  /** The turn behind a feedback call — only for the visitor who asked it; anyone else is told it is unknown. */
  turn(id: string, visitor: string) {
    const t = this.turns.get(id);
    return t && t.visitor === visitor ? t : null;
  }

  // ------------------------------------------------------------------ family tree, signals, open questions (design §5.5, §10, §12.5)
  /**
   * The identity two reports of the same question meet on, keyed so it cannot be turned back into the text
   * (design §10 privacy preconditions): `HMAC(node secret, 'q:' + questionKey(prompt))[:16]`. The key rule is the
   * parser's (F13), so "the same question" means the same thing here, in a dataset and in `covered_by`.
   */
  questionCluster(prompt: string): string {
    return createHmac('sha256', this.store.visitorSecret()).update(`q:${questionKey(prompt)}`).digest('hex').slice(0, 16);
  }

  /** Sales that count, as two numbers (all-time and 30 days) — what the shelves and the strip both read. */
  salesOf(e: CatalogEntry): { sales_all: number; sales_30d: number } {
    const sales = this.realSales(e);
    const since = Date.now() - 30 * 86_400_000;
    return { sales_all: sales.length, sales_30d: sales.filter((s) => s.created_at >= since).length };
  }

  /** Sales that count as sales (§10): price-0 settlements and the author buying from itself are not demand. */
  private realSales(e: CatalogEntry): Settlement[] {
    return e.settlements.filter((s) => Number(s.amount || 0) > 0 && s.buyer?.toLowerCase() !== e.anchor.author.toLowerCase());
  }

  /** How many nodes (this one included) hold the body — SC-11 "loaded on {l} nodes". */
  private holderCount(sha: string): number {
    return new Set([...(this.blobs.has(sha) ? [this.publicUrl] : []), ...this.p2p.holders(sha)]).size;
  }

  /**
   * What one knowledge is doing (SC-11). `network` is read from the ledger and the peer table and means the same on
   * every node; `node` is this node's own 30-day counters and says so — the two are never added together.
   */
  async signalsOf(e: CatalogEntry, map?: Map<string, CatalogEntry>): Promise<{ network: Record<string, number | string>; node: Record<string, number> }> {
    const all = map ?? (await this.entryMap());
    const sales = this.realSales(e);
    const since30 = Date.now() - 30 * 86_400_000;
    const subs = await this.subscriberCount(e.anchor.id);
    const node = this.store.signals(e.anchor.id, 30);
    return {
      network: {
        sales_all: sales.length, sales_30d: sales.filter((s) => s.created_at >= since30).length,
        buyers: new Set(sales.map((s) => s.buyer.toLowerCase())).size,
        revenue: sales.reduce((n, s) => n + Number(s.amount || 0), 0).toFixed(6).replace(/\.?0+$/, '') || '0',
        loads: this.holderCount(e.anchor.patch_sha256),
        dataset_loads: e.anchor.dataset?.sha256 ? new Set([...(this.datasets.has(e.anchor.dataset.sha256) ? [this.publicUrl] : []), ...this.p2p.datasetHolders(e.anchor.dataset.sha256)]).size : 0,
        built_on: this.publicChildren(e, all).length,
        versions: e.superseded_by.length + e.supersedes.length,
        subscribers: subs,
        passed: e.passed, quorum: e.quorum,
      },
      node: { ...node, open_questions: this.store.listIssues(e.anchor.id, { limit: 500 }).length },
    };
  }

  /** Nodes subscribed to any track this knowledge is on (SC-11 "track subscribers"). */
  private async subscriberCount(patchId: string): Promise<number> {
    const names = (await this.branches()).filter((b) => b.patch_ids.includes(patchId)).map((b) => b.name);
    if (!names.length) return 0;
    const recs = await this.ledger.subscriptions();
    const state = new Map<string, boolean>();
    for (const r of recs.sort((a, b) => (a.body.created_at ?? 0) - (b.body.created_at ?? 0))) {
      if (!names.includes(r.body.branch)) continue;
      state.set(`${r.body.node.toLowerCase()}|${r.body.branch}`, r.body.action === 'subscribe');
    }
    return new Set([...state.entries()].filter(([, on]) => on).map(([k]) => k.split('|')[0])).size;
  }

  /**
   * "Doing well this week" (§10): `3·sales7d + 2·builds_on7d + 1·loads + 0.5·tests7d·hit_rate`. Every term but
   * `loads` is a seven-day count; `loads` is how many nodes hold the body RIGHT NOW, because nothing on this node
   * records when a peer fetched a body — the score is a ranking, and the strip states the numbers it is made of.
   */
  weeklyScore(e: CatalogEntry): number {
    const since = Date.now() - 7 * 86_400_000;
    const sales7 = this.realSales(e).filter((s) => s.created_at >= since).length;
    const s = this.store.signals(e.anchor.id, 7);
    const builds7 = s.builds_on_jobs + s.derive_fetches;
    const hitRate = s.tests > 0 ? s.hits / s.tests : 0;
    return 3 * sales7 + 2 * builds7 + this.holderCount(e.anchor.patch_sha256) + 0.5 * s.tests * hitRate;
  }

  /** "Most built on" (§10) — children on the ledger plus this node's derive intents, all-time. */
  builtOnCount(e: CatalogEntry, map: Map<string, CatalogEntry>): number {
    return this.publicChildren(e, map).length + this.store.signals(e.anchor.id, 36_500).derive_fetches;
  }

  /**
   * Children a public number may count. A private draft is a child on this node's disk and nowhere else, so counting
   * it in "built on 3×" would publish the existence of an unannounced lesson as an integer.
   */
  private publicChildren(e: CatalogEntry, map: Map<string, CatalogEntry>): string[] {
    // …and a test anchor is not a child either: fixtures are announced, hidden from every listing and from the
    // family tree, so counting them in "built on 3×" would put a number on the page nothing on it explains.
    return e.children.filter((c) => { const x = map.get(c); return !!x && x.status !== 'DRAFT' && (x.anchor.visibility !== 'test' || !!this.cfg.includeTestAnchors); });
  }

  /**
   * The family tree of one knowledge (design §5.5, §12.5, SC-9): ancestors through `parents[]`, descendants through
   * `children`, versions through supersede records, and what each node ADDED. Cycle-safe (a peer anchor may claim
   * any parent), depth-capped, and every node passes through `visible` — a caller who may not see a draft or a test
   * anchor gets a `{ missing: true }` placeholder in its place rather than a hole in the graph.
   */
  async lineageTree(rootId: string, opts: { depth?: number; dir?: 'up' | 'down' | 'both'; visible?: (e: CatalogEntry | undefined) => boolean } = {}): Promise<LineageTree> {
    const depth = Math.min(TREE_MAX_DEPTH, Math.max(1, Math.trunc(opts.depth ?? 4)));
    const dir = opts.dir ?? 'both';
    const map = await this.entryMap();
    const root = map.get(rootId);
    if (!root) throw notFound('patch not found');
    // `!!e` first, always: an ancestor id nobody here holds is a PLACEHOLDER, and a caller-supplied filter that
    // happens to accept `undefined` must not be able to turn it into a node with no anchor behind it.
    const canSee = opts.visible ?? (() => true);
    const visible = (e: CatalogEntry | undefined): e is CatalogEntry => !!e && canSee(e);
    const branchOf = await this.branches();
    const trackOf = (id: string) => branchOf.filter((b) => b.patch_ids.includes(id)).map((b) => b.name);
    const nodes = new Map<string, TreeNode>();
    const edges: TreeEdge[] = [];
    const seen = new Set<string>();
    let truncated = false;

    const addEdge = (from: string, to: string, kind: TreeEdge['kind']) => {
      if (edges.some((x) => x.from === from && x.to === to && x.kind === kind)) return;
      edges.push({ from, to, kind });
    };
    /**
     * Put a knowledge in the tree at hop `d` (negative above, positive below). `keep` is for a relation that is not
     * a hop at all: a newer version sits BESIDE what it replaces, so it must never drag an already-placed node — the
     * root included — into another row. The knowledge being looked at is depth 0 by definition and never moves.
     */
    const place = (id: string, d: number, keep = false): TreeNode => {
      const cur = nodes.get(id);
      if (cur) { if (!keep && id !== rootId) cur.depth = Math.min(cur.depth, d); return cur; }
      const e = map.get(id);
      const n: TreeNode = visible(e) ? this.treeNode(e!, map, trackOf(id), d) : { id, name: id, missing: true, depth: d, added: { questions: 0, changed: 0, removed: 0, rows: 0, new: 0 }, signals: {}, base_stack: [], superseded_by: [], supersedes: [], contributors: [] } as TreeNode;
      nodes.set(id, n);
      return n;
    };

    /** kind of the edge parent → child: what the CHILD says it did to that parent, or `declared` when it says nothing. */
    const edgeKind = (parent: string, child: CatalogEntry): TreeEdge['kind'] => {
      const d = child.anchor.derivation;
      // `bases` is optional on the wire and every other reader treats it so (`anchor.derivation.bases ?? []`).
      // Here it was dereferenced bare, so one gossiped anchor carrying `derivation` without it made
      // `GET /api/patches/:id/tree` answer 500 for the whole tree it appeared in.
      if (d && (d.bases ?? []).some((b) => b.patch_id === parent)) return d.kind === 'transfer' ? 'declared' : d.kind;
      const p = map.get(parent);
      if (p && (child.anchor.branch ?? 'main') !== (p.anchor.branch ?? 'main')) return 'track';
      return 'declared';
    };

    place(rootId, 0);
    // ancestors
    if (dir !== 'down') {
      const walkUp = (id: string, d: number) => {
        if (d >= depth) { const e = map.get(id); if (e?.anchor.parents.length) truncated = true; return; }
        const e = map.get(id);
        if (!e) return;
        for (const p of e.anchor.parents) {
          place(p, -(d + 1));
          addEdge(p, id, edgeKind(p, e));
          const key = `up:${p}`;
          if (seen.has(key)) continue;                 // cycle / diamond guard: an ancestor is walked once
          seen.add(key);
          walkUp(p, d + 1);
        }
      };
      walkUp(rootId, 0);
    }
    // descendants
    if (dir !== 'up') {
      const walkDown = (id: string, d: number) => {
        const e = map.get(id);
        if (!e) return;
        const kids = e.children.filter((c) => map.has(c));
        if (d >= depth) { if (kids.length) truncated = true; return; }
        for (const c of kids) {
          const ce = map.get(c)!;
          if (!visible(ce) && c !== rootId) continue;    // a stranger is not told a hidden child exists
          place(c, d + 1);
          addEdge(id, c, edgeKind(id, ce));
          const key = `down:${c}`;
          if (seen.has(key)) continue;
          seen.add(key);
          walkDown(c, d + 1);
        }
      };
      walkDown(rootId, 0);
    }
    // versions: a supersede is an edge of its own, in both directions, whatever the parent links say
    for (const id of [...nodes.keys()]) {
      const e = map.get(id);
      if (!e) continue;
      for (const older of e.supersedes) if (visible(map.get(older))) { place(older, (nodes.get(id)?.depth ?? 0), true); addEdge(older, id, 'version'); }
      for (const newer of e.superseded_by) if (visible(map.get(newer))) { place(newer, (nodes.get(id)?.depth ?? 0), true); addEdge(id, newer, 'version'); }
    }

    const list = [...nodes.values()];
    const family = list.filter((n) => !n.missing);
    const sales = family.reduce((n, x) => n + Number(x.signals.sales_all ?? 0), 0);
    const authors = new Set(family.map((n) => (n.author ?? '').toLowerCase()).filter(Boolean));
    return {
      root: rootId, depth, dir, nodes: list, edges, truncated,
      family: { sales, knowledges: family.length, authors: authors.size },
      money: this.treeMoney(root, map, list.filter((n) => n.depth < 0 && !n.missing)),
    };
  }

  /**
   * SC-9 *Money*: what one sale of the root pays, computed by the REAL splitter on a unit price (§11) — so the line
   * a creator reads is produced by the code that will move the money, never by a second implementation of the rule.
   *
   * The two shares are kept apart, because they are two different promises: `lineage_pct` is what the ancestors'
   * authors share for having been built on, `contributor_pct` is what this knowledge's own data provider was
   * credited on its record. Adding them into one "70% to others" would tell a creator that teaching on top of
   * someone costs them what crediting a teacher costs.
   */
  private treeMoney(root: CatalogEntry, map: Map<string, CatalogEntry>, ancestors: TreeNode[]): LineageTree['money'] {
    const plan = royaltyPlan(root, map, 100, this.cfg.market.royaltyShare ?? 0, { verifierShare: this.cfg.market.verifierShare });
    const split = plan.royalty;
    const seller = root.anchor.author.toLowerCase();
    const verifiers = new Set(Object.keys(plan.verification).map((a) => a.toLowerCase()));
    const contributorName = (addr: string) => (root.anchor.contributors ?? []).find((c) => c.address.toLowerCase() === addr || c.signer?.toLowerCase() === addr)?.name ?? null;
    // Who is paid BECAUSE this was built on them. An ancestor's author is the obvious case; the common one on a
    // teaching node is not: there every anchor is published BY THE NODE, so the base and the child share an author
    // and the base's creator is credited on the base as a contributor. §11 pass 2 pays them out of the seller side
    // for exactly that ancestry, so reading authors alone told the creator of the base that being built on pays
    // them nothing. An address credited on the ROOT is its own knowledge's teacher and stays a contributor.
    const rootCredited = new Set((root.anchor.contributors ?? []).flatMap((c) => [c.address?.toLowerCase(), c.signer?.toLowerCase()].filter(Boolean) as string[]));
    const lineageOf = new Map<string, { from: TreeNode; name: string | null }>();
    for (const n of ancestors) {
      const author = (n.author ?? '').toLowerCase();
      if (author && author !== seller) lineageOf.set(author, { from: n, name: n.author_name ?? null });
      for (const c of map.get(n.id)?.anchor.contributors ?? []) {
        const lower = (c.address ?? '').toLowerCase();
        if (!lower || lower === seller || rootCredited.has(lower) || lineageOf.has(lower)) continue;
        lineageOf.set(lower, { from: n, name: c.name ?? null });
      }
    }
    // One address can be paid twice for two different reasons — an ancestor author that also verified the child is
    // the normal case on a small network — so the verification part is split out by amount, not by classifying the
    // whole line as one kind or the other.
    const verifiedPct = (lower: string) => Number(Object.entries(plan.verification).find(([a]) => a.toLowerCase() === lower)?.[1] ?? 0);
    const recipients = Object.entries(split)
      .filter(([a]) => a.toLowerCase() !== seller)
      .map(([address, amount]) => {
        const lower = address.toLowerCase();
        const from = lineageOf.get(lower);
        // The fallback matters when the payee is further up than this walk went (`royaltyPlan` has no depth cut):
        // somebody paid by this sale who is NOT credited on this knowledge is being paid for the ancestry, and
        // calling them "credited on this knowledge" would put the wrong name against the wrong promise.
        const kind: 'lineage' | 'contributor' | 'verifier' = from ? 'lineage'
          : verifiers.has(lower) && verifiedPct(lower) >= Number(amount) - 1e-9 ? 'verifier'
            : rootCredited.has(lower) ? 'contributor' : 'lineage';
        return { address, pct: Math.round(Number(amount) * 10) / 10, name: from?.name ?? contributorName(lower), kind, ...(from ? { for_id: from.from.id, for_name: from.from.name } : {}) };
      });
    // The knowledges the lineage share is paid FOR. A payee from above this walk's cap has no node to name, and the
    // line then falls back to the ancestors this tree does hold rather than reading "the creators of ".
    const paidFor = [...new Set(recipients.filter((r) => r.kind === 'lineage').map((r) => r.for_name ?? ''))].filter(Boolean);
    // Rounded once, at the end: subtracting a rounded percentage from a rounded percentage put 100.1 % on the card.
    const pctOf = (kind: 'lineage' | 'contributor') => Math.round(recipients.filter((r) => r.kind === kind)
      .reduce((n, r) => n + Number(split[r.address] ?? 0) - verifiedPct(r.address.toLowerCase()), 0) * 10) / 10;
    return {
      seller_pct: Math.round(Number(split[root.anchor.author] ?? split[seller] ?? 0) * 10) / 10,
      lineage_pct: pctOf('lineage'),
      contributor_pct: pctOf('contributor'),
      /** what the verifiers keeping this knowledge on sale are paid out of the seller side (item 325) */
      verifier_pct: Math.round(Object.values(plan.verification).reduce((n, x) => n + Number(x), 0) * 10) / 10,
      verifier_count: Object.keys(plan.verification).length,
      /** SC-9's "{names}" — computed above: the knowledges whose creators this sale really pays. */
      lineage_names: paidFor.length ? paidFor : (recipients.some((r) => r.kind === 'lineage') ? ancestors.map((n) => n.name) : []),
      recipients, seller_name: root.anchor.author_name ?? null,
    };
  }

  /** One node of the tree: who made it, what it did to its bases, and how it is doing. */
  private treeNode(e: CatalogEntry, map: Map<string, CatalogEntry>, tracks: string[], depth: number): TreeNode {
    const a = e.anchor;
    const provider = (a.contributors ?? []).find((c) => c.role === 'data_provider');
    const d = a.derivation;
    const baseRows = (d?.bases ?? []).reduce((n, b) => n + (b.rows || 0), 0);
    const isDelta = a.base?.export === 'delta';
    const sales = this.realSales(e);
    const since30 = Date.now() - 30 * 86_400_000;
    const node = this.store.signals(a.id, 30);
    return {
      id: a.id, name: a.name, author: a.author, author_name: a.author_name ?? null,
      taught_by: provider?.name ?? null, contributors: (a.contributors ?? []).map((c) => ({ address: c.address, name: c.name ?? null, role: c.role, share: c.share })),
      status: e.status, superseded_by: e.superseded_by, supersedes: e.supersedes,
      branch: a.branch ?? null, tracks,
      derivation: d ?? null, base_stack: (a.base?.stack ?? []).map((b) => b.patch_id), export: a.base?.export ?? null,
      /** No `derivation` = "declared parent — not trained on top" (§14): the legacy chip, not a claim about training. */
      legacy: !d && a.parents.length > 0,
      dataset: a.dataset ? { sha256: a.dataset.sha256, rows: a.dataset.rows, access: accessOf(a), license: a.dataset.license ?? null } : null,
      added: {
        questions: d?.added_rows ?? (a.dataset?.rows ?? 0), changed: d?.changed_rows ?? 0, removed: d?.removed_rows ?? 0,
        rows: a.rows, new: isDelta ? a.rows : Math.max(0, a.rows - baseRows),
      },
      signals: {
        sales_all: sales.length, sales_30d: sales.filter((s) => s.created_at >= since30).length,
        loads: this.holderCount(a.patch_sha256), built_on: this.publicChildren(e, map).length,
        tests: node.tests, hits: node.hits, passed: e.passed, quorum: e.quorum,
        open_questions: this.store.listIssues(a.id, { limit: 500 }).length,
      },
      depth,
    };
  }

  // ------------------------------------------------------------------ branches / network
  async createBranch(name: string, description: string, context: Record<string, string>, patchIds: string[] = [], opts: { visibility?: 'public' | 'test'; archived?: boolean } = {}): Promise<BranchInfo> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9/_-]{1,63}$/.test(name)) throw badInput('invalid branch name');
    // Item 358 — a track is the name subscribers follow. Re-creating one under the same name used to rewrite its
    // owner, description and item list for the whole network (the local ledger is last-write-wins), after which the
    // real owner's own `branch add` was refused with 403 on their own track.
    const existing = await this.branchByName(name);
    if (existing && existing.owner.toLowerCase() !== this.address.toLowerCase()) {
      throw conflict(`branch_exists: the track ${name} already exists on this network and belongs to ${existing.owner} — a track name cannot change hands. Pick another name (yours/${name.split('/').pop()}), or ask its owner to add your knowledge to it.`,
        { branch: name, owner: existing.owner, created_at: existing.created_at });
    }
    // Item 269: a fixture track and a finished one are both kept on the record and both taken off the shelf. An
    // update that says nothing about either keeps what the track already had, so `branch add` never un-archives.
    const visibility = opts.visibility ?? existing?.visibility;
    const archived = opts.archived ?? existing?.archived;
    const b: BranchInfo = {
      name, description, context, owner: this.address, patch_ids: patchIds, created_at: existing?.created_at ?? Date.now(),
      ...(visibility && visibility !== 'public' ? { visibility } : {}), ...(archived ? { archived: true } : {}),
    };
    const rec = await this.ledger.append('branch', b);
    this.invalidate();
    this.log('info', 'branch', `branch ${name} ${existing ? 'updated' : 'created'} with ${patchIds.length} patch(es)`, null, context);
    await this.p2p?.broadcast(rec).catch(() => undefined);
    return b;
  }

  /**
   * Tracks on this network, one row per name. The node that FIRST wrote a name owns it: a `branch` record about that
   * name from anybody else is dropped rather than applied (item 358). The AIN ledger enforces the same thing in its
   * write rule; on the local ledger this is where it is enforced, so both backends agree.
   */
  async branches(opts: { includeTest?: boolean; includeArchived?: boolean } = {}): Promise<BranchInfo[]> {
    const recs = await this.ledger.branches();
    const owner = new Map<string, string>();
    const latest = new Map<string, BranchInfo>();
    for (const r of [...recs].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))) {
      const b = r.body;
      if (!b?.name) continue;
      const claimed = (b.owner ?? r.author ?? '').toLowerCase();
      if (!claimed) continue;
      // The signer of the record must be the owner it names (a record signed by A cannot make B the owner).
      if (r.author && claimed !== r.author.toLowerCase()) continue;
      const first = owner.get(b.name);
      if (first === undefined) owner.set(b.name, claimed);
      else if (first !== claimed) continue;
      latest.set(b.name, { ...b, owner: b.owner ?? r.author });
    }
    // Item 269: a fixture track and an archived one are on the record for ever and on no list by default — the one
    // page that sells "subscribe to a track" was 32 throwaway `e2e/*` rows around three real ones.
    return [...latest.values()].filter((b) =>
      (opts.includeTest || b.visibility !== 'test' || !!this.cfg.includeTestAnchors)
      && (opts.includeArchived || !b.archived));
  }

  /** Every track including the hidden ones — the owner's own screens, and anything that must resolve a name. */
  async allBranches(): Promise<BranchInfo[]> { return this.branches({ includeTest: true, includeArchived: true }); }

  /** Branch by name; a miss re-reads the shared ledger once (another node may have written it seconds ago). */
  private async branchByName(name: string): Promise<BranchInfo | undefined> {
    // Hidden ones included: a track named outright is being worked on, and "not found" for a track you can see in
    // your own `branch ls --all` would be the same lie item 157 fixed for knowledge ids.
    let b = (await this.allBranches()).find((x) => x.name === name);
    if (!b) { await this.refreshLedger(); b = (await this.allBranches()).find((x) => x.name === name); }
    return b;
  }

  /**
   * What a track costs to follow, per period, and what following it has actually cost (item 359).
   *
   * There was no subscription in the product: prices are per anchor and immutable, so a loyal subscriber to a
   * daily track paid the full price of every bake for ever, and a curator who assembles other people's knowledge
   * received nothing at all — `addToBranch` accepts any existing entry and there is no curator line in
   * `royaltySplit`. The one recurring-revenue shape the product describes had no price object anywhere.
   *
   * `terms` is the CURATION fee, set by the owner and paid to them once per period. The knowledge on the track is
   * still bought from whoever published it, because it is theirs — so the run rate below is both: what curation
   * costs per period, and what the track's own recent history says its bakes cost. Both are measured (the
   * additions of the last 30 days, at their prices), never projected.
   */
  async subscriptionQuote(name: string): Promise<SubscriptionQuote> {
    const b = await this.branchByName(name);
    if (!b) throw notFound('branch not found');
    const terms = b.terms ?? null;
    const setts = await this.ledger.settlements();
    const subject = `track:${b.name}`;
    const mine = setts
      .filter((r) => r.body.patch_id === subject && sameAddr(r.body.buyer, this.address) && sameAddr(r.body.seller, b.owner))
      .map((r) => r.body).sort((x, y) => y.created_at - x.created_at);
    const last = mine[0] ?? null;
    const periodMs = Math.max(1, terms?.period_days ?? 30) * 86_400_000;
    const paidUntil = last ? last.created_at + periodMs : null;
    // What this track has actually asked its subscribers to buy lately: the anchors added in the last 30 days,
    // at the price they are listed at. A track that has published nothing has no run rate, and says so.
    const map = await this.entryMap();
    const since = Date.now() - 30 * 86_400_000;
    const recent = b.patch_ids.map((id) => map.get(id)).filter((e): e is CatalogEntry => !!e && e.anchor.created_at >= since);
    const knowledgeSpend = recent.reduce((n, e) => n + Number(e.anchor.price || 0), 0);
    const perPeriodKnowledge = terms ? knowledgeSpend * (terms.period_days / 30) : knowledgeSpend;
    const fee = Number(terms?.price ?? 0);
    return {
      branch: b.name, owner: b.owner, terms,
      paid_until: paidUntil, paid_at: last?.created_at ?? null, periods_paid: mine.length,
      due: !!terms && Number(terms.price) > 0 && (paidUntil === null || paidUntil <= Date.now()),
      currency: terms?.currency ?? this.cfg.market.currency,
      run_rate: {
        days: 30, knowledge_added: recent.length, knowledge_spend: String(Math.round(knowledgeSpend * 1e6) / 1e6),
        per_period: terms ? String(Math.round((fee + perPeriodKnowledge) * 1e6) / 1e6) : null,
        per_30_days: String(Math.round((knowledgeSpend + (terms ? fee * (30 / Math.max(1, terms.period_days)) : 0)) * 1e6) / 1e6),
      },
    };
  }

  /** Set (or clear) what following this track costs — the owner only, on the public record (item 359). */
  async setBranchTerms(name: string, terms: SubscriptionTerms | null): Promise<BranchInfo> {
    const b = await this.branchByName(name);
    if (!b) throw notFound('branch not found');
    if (!sameAddr(b.owner, this.address)) throw new MarketError(403, `only the owner of ${name} (${b.owner}) can set what it costs`);
    const nb: BranchInfo = { ...b };
    if (terms) {
      const price = validatePrice(terms.price, 'terms.price');
      const days = Math.floor(Number(terms.period_days));
      if (!(days >= 1 && days <= 365)) throw badInput('terms.period_days must be a whole number of days between 1 and 365');
      nb.terms = { price, currency: terms.currency || this.cfg.market.currency, period_days: days };
    } else delete nb.terms;
    const rec = await this.ledger.append('branch', nb);
    this.invalidate();
    await this.p2p?.broadcast(rec).catch(() => undefined);
    this.log('info', 'branch', nb.terms
      ? `${name} now costs ${Number(nb.terms.price) === 0 ? 'nothing' : `${nb.terms.price} ${nb.terms.currency}`} per ${nb.terms.period_days} day(s) to follow — the curation fee is paid to this node; the knowledge on the track is still bought from whoever published it`
      : `${name} is free to follow again — no curation fee`, null, { terms: nb.terms ?? null });
    return nb;
  }

  /**
   * The curation fee for one period of a track this node owns (item 359) — the seller side of `/x402/branch/:name`.
   * A track is not a knowledge, so there is no body and no manifest: what the payment buys is the right to be a
   * subscriber for a period, and the record of it is the settlement itself.
   */
  async requirementsForBranch(b: BranchInfo, resource: string): Promise<X402Requirement[]> {
    const terms = b.terms;
    if (!terms) throw conflict(`${b.name} has no subscription terms — following it costs nothing`);
    const nonce = newNonce();
    const scheme = this.ledger.kind === 'ain' ? 'ain-transfer' : 'local-credit';
    this.store.putNonce(nonce, resource, terms.price, this.address, 10 * 60_000);
    return [{
      scheme, network: this.ledger.kind === 'ain' ? 'ain:local' : 'local', asset: this.ledger.kind === 'ain' ? 'AIN' : 'CREDIT',
      payTo: this.address, maxAmountRequired: terms.price, resource,
      description: `Curation of the track ${b.name} for ${terms.period_days} day(s) — ${b.patch_ids.length} knowledge on it today. The knowledge itself is bought from its own publishers.`,
      nonce, expires_at: Date.now() + 10 * 60_000,
      ...(scheme === 'ain-transfer' ? { transfer_key: transferKeyFor(resource, nonce) } : {}),
      total: terms.price, self_contained: true, single_use: true, status: 'VERIFIED',
    }];
  }

  /** Settle one period of curation for a track this node owns (item 359). */
  async settleBranchPayment(b: BranchInfo, resource: string, header: string | undefined): Promise<{ settlement: Settlement; replayed?: boolean; error?: undefined } | { settlement?: undefined; error: string }> {
    // Same balance/settle window as a knowledge sale, so the same per-payer chain (item 373).
    return this.serialByPayer(decodePayload(header)?.from ?? '', () => this.settleBranchPaymentInner(b, resource, header));
  }

  private async settleBranchPaymentInner(b: BranchInfo, resource: string, header: string | undefined): Promise<{ settlement: Settlement; replayed?: boolean; error?: undefined } | { settlement?: undefined; error: string }> {
    const terms = b.terms;
    if (!terms) return { error: `${b.name} has no subscription terms — following it costs nothing` };
    const subject = `track:${b.name}`;
    const setts = (await this.ledger.settlements()).filter((r) => r.body.patch_id === subject).map((r) => r.body);
    const out = await this.verifyPayment({
      id: subject, patch_id: null, seller: b.owner, price: Number(terms.price), currency: terms.currency,
      settlements: setts, notSold: `this node does not curate ${b.name}`,
      selfBuy: `self_purchase: ${b.name} is curated by this node — following your own track is not a subscription`,
    }, resource, header);
    if ('error' in out && out.error) return { error: out.error };
    const ok = out as { buyer: string; txHash: string; scheme: string; replayed?: Settlement };
    if (ok.replayed) return { settlement: ok.replayed, replayed: true };
    // The whole fee is the curator's: it pays for the curating, not for anybody's knowledge.
    const settlement: Settlement = {
      patch_id: subject, seller: this.address, buyer: ok.buyer, amount: terms.price, currency: terms.currency,
      scheme: ok.scheme, tx_hash: ok.txHash, royalty: { [this.address]: terms.price }, billing: 'per_download', created_at: Date.now(),
    };
    this.store.markPayment(ok.txHash, subject);
    const rec = await this.ledger.append('settle', settlement);
    this.invalidate();
    this.log('info', 'trade', `${ok.buyer.slice(0, 10)}… paid ${terms.price} ${terms.currency} to follow ${b.name} for ${terms.period_days} day(s)`, null, { branch: b.name, buyer: ok.buyer, tx: ok.txHash });
    await this.p2p?.broadcast(rec).catch(() => undefined);
    return { settlement };
  }

  /**
   * Pay the curation fee for one period of somebody else's track (item 359) — the buyer side. Returns what was
   * paid, or `{ due: false }` when the current period is already covered: a subscription is charged once per
   * period, not once per bake.
   */
  async paySubscription(name: string): Promise<{ paid: boolean; amount: string; currency: string; tx_hash: string | null; paid_until: number | null; reason?: string }> {
    const q = await this.subscriptionQuote(name);
    if (!q.terms || Number(q.terms.price) <= 0) return { paid: false, amount: '0', currency: q.currency, tx_hash: null, paid_until: null, reason: 'this track is free to follow' };
    if (sameAddr(q.owner, this.address)) return { paid: false, amount: '0', currency: q.currency, tx_hash: null, paid_until: null, reason: 'this node curates it' };
    if (!q.due) return { paid: false, amount: '0', currency: q.currency, tx_hash: null, paid_until: q.paid_until, reason: `already paid until ${new Date(q.paid_until!).toISOString()}` };
    const nodes = (await this.ledger.nodes().catch(() => [])).map((n) => n.body);
    const ep = nodes.find((n) => sameAddr(n.address, q.owner))?.endpoint
      ?? this.store.listPeers().find((pr) => sameAddr(pr.address ?? '', q.owner))?.endpoint;
    if (!ep) throw conflict(`${name} costs ${q.terms.price} ${q.terms.currency} per ${q.terms.period_days} day(s) and this node cannot reach its curator (${q.owner}) to pay: no peer here knows that address. Add their node with \`ainize peers add <url>\` and try again.`);
    const url = `${ep.replace(/\/+$/, '')}/x402/branch/${encodeURIComponent(name)}`;
    const r1 = await fetch(url, { headers: { 'x-ainize-buyer': this.address }, signal: AbortSignal.timeout(30_000) });
    if (r1.status !== 402) throw conflict(`${q.owner} did not quote for ${name}: ${r1.status} ${(await r1.text().catch(() => '')).slice(0, 200)}`);
    const reqs = decodeRequirements(r1.headers.get(X402_HEADER_REQUIRED), await r1.json().catch(() => ({})));
    const req = reqs.find((x) => x.scheme === (this.ledger.kind === 'ain' ? 'ain-transfer' : 'local-credit')) ?? reqs[0];
    if (!req) throw conflict('402 without payment requirements');
    /**
     * The curator is quoted against their own published terms, exactly as a seller is against their listing.
     *
     * `buyOne` has refused a quote above the anchor's price since item 279; this path took `req.maxAmountRequired`
     * from the curator's 402 and transferred it without ever looking at `q.terms.price` — the number the track
     * advertises and the subscriber agreed to. A track listed at 0.5 CREDIT per 30 days whose owner answered with
     * 500 was paid 500. The currency has to match for the comparison to mean anything, and a curator switching
     * asset mid-quote is the same refusal.
     */
    const owed = Number(q.terms.price || 0);
    if (req.asset && q.terms.currency && req.asset.toLowerCase() !== q.terms.currency.toLowerCase()) {
      throw conflict(`${name} is priced in ${q.terms.currency} and its curator asks to be paid in ${req.asset} — nothing was transferred.`, { branch: name, terms_currency: q.terms.currency, quoted_currency: req.asset });
    }
    if (Number(req.maxAmountRequired) > owed + 1e-9) {
      throw conflict(`${name} advertises ${q.terms.price} ${q.terms.currency} per ${q.terms.period_days} day(s) and its curator now asks ${req.maxAmountRequired} ${req.asset} — nothing was transferred. Re-read the track: if the terms really have changed, follow it again and this node will pay the new ones.`, { branch: name, terms_price: q.terms.price, quoted: req.maxAmountRequired });
    }
    /**
     * The row goes in BEFORE the money moves, the way a knowledge purchase does. Without it a transfer the curator
     * then refuses to honour left the money gone with no local receipt and no way to re-present the payment.
     */
    const pendingId = this.store.putPending({
      patch_id: `branch:${name}`, gateway: ep, resource: req.resource, scheme: req.scheme, pay_to: req.payTo,
      amount: req.maxAmountRequired, currency: req.asset, nonce: req.nonce, tx_hash: null, payload: null, status: 'quoted', error: null,
    }).id;
    let payload: X402Payload;
    if (req.scheme === 'ain-transfer') {
      if (!(this.ledger instanceof AinLedger)) throw conflict('the curator wants AIN but this node runs the local ledger');
      const key = req.transfer_key ?? transferKeyFor(req.resource, req.nonce);
      const t = await this.ledger.transfer(req.payTo, Number(req.maxAmountRequired), key);
      payload = { scheme: 'ain-transfer', network: req.network, txHash: t.tx_hash, from: this.address, to: req.payTo, amount: req.maxAmountRequired, nonce: req.nonce, transfer_key: key, proof: signMessage(ainPaymentDigest(t.tx_hash, req.nonce), this.cfg.identity.privateKey) };
    } else {
      const h = Market.intentHash({ resource: req.resource, amount: req.maxAmountRequired, nonce: req.nonce, payTo: req.payTo, from: this.address });
      payload = { scheme: 'local-credit', network: 'local', txHash: h, from: this.address, to: req.payTo, amount: req.maxAmountRequired, nonce: req.nonce, proof: signMessage(h, this.cfg.identity.privateKey) };
    }
    const r2 = await fetch(url, { headers: { [X402_HEADER_PAYMENT]: encodePayload(payload), 'x-ainize-buyer': this.address }, signal: AbortSignal.timeout(60_000) });
    this.store.updatePending(pendingId, { tx_hash: payload.txHash ?? null, payload: encodePayload(payload), status: 'paid', error: null });
    if (!r2.ok) {
      const why = `${r2.status} ${(await r2.text().catch(() => '')).slice(0, 300)}`;
      // The money left this node and the curator would not honour it. The row stays at 'paid' — which is exactly
      // what store.ts calls "a purchase that owes this node a body" — carrying the payload, so the payment can be
      // presented again instead of being a transfer nobody has a record of.
      this.store.updatePending(pendingId, { status: 'paid', error: why });
      throw conflict(`the curator refused the payment for ${name} after ${req.maxAmountRequired} ${req.asset} had already moved: ${why}. The payment is kept (\`ainize wallet\`) and can be presented again.`);
    }
    this.store.updatePending(pendingId, { status: 'settled', error: null });
    await this.refreshLedger().catch(() => undefined);
    const after = await this.subscriptionQuote(name).catch(() => null);
    this.log('info', 'branch', `paid ${req.maxAmountRequired} ${req.asset} to follow ${name} for ${q.terms.period_days} day(s) — the curation fee; the knowledge on it is still bought from its own publishers`, null, { branch: name, amount: req.maxAmountRequired });
    return { paid: true, amount: req.maxAmountRequired, currency: req.asset, tx_hash: payload.txHash ?? null, paid_until: after?.paid_until ?? null };
  }

  /**
   * Take a track off the shelf, or put it back (item 269). Only its owner may: a track name cannot change hands, and
   * the record stays on the ledger — this writes a new one saying the owner is done with it.
   */
  async archiveBranch(name: string, archived: boolean): Promise<BranchInfo> {
    const b = await this.branchByName(name);
    if (!b) throw notFound('branch not found');
    if (b.owner.toLowerCase() !== this.address.toLowerCase()) throw new MarketError(403, `only the owner of ${name} (${b.owner}) can archive it`);
    if (!!b.archived === archived) return b;
    const nb: BranchInfo = { ...b, ...(archived ? { archived: true } : {}) };
    if (!archived) delete nb.archived;
    const rec = await this.ledger.append('branch', nb);
    this.invalidate();
    await this.p2p?.broadcast(rec).catch(() => undefined);
    this.log('info', 'branch', `${name} ${archived ? 'archived — off /network, off the router and out of `branch ls`; its record and its subscribers stay' : 'un-archived — it is on the lists again'}`, null);
    return nb;
  }

  async addToBranch(name: string, patchId: string, opts: { force?: boolean } = {}): Promise<BranchInfo> {
    const b = await this.branchByName(name);
    if (!b) throw notFound('branch not found');
    if (b.owner.toLowerCase() !== this.address.toLowerCase()) throw new MarketError(403, 'only the branch owner can add patches');
    const e = await this.entry(patchId);
    if (!e) throw notFound('patch not found');
    // Item 257 — a track is the list every subscriber's node buys and loads automatically, so an unverified bake has
    // no business on it: `branch add` used to accept an ANNOUNCED 0/2 body with a ✓ and every subscriber then bought it.
    if (e.status !== 'VERIFIED' && !opts.force) {
      throw conflict(`not_listed: ${patchId} is ${e.status} (verification ${e.passed}/${e.quorum}) — subscribers buy and load whatever is on a track, so only verified knowledge belongs on one. Wait for the quorum${e.status === 'REJECTED' || e.status === 'CHALLENGED' ? '' : ' (it usually takes a few minutes)'}, or add it anyway with --force.`,
        { patch_id: patchId, status: e.status, passed: e.passed, quorum: e.quorum });
    }
    const retires = b.patch_ids.filter((id) => e.supersedes.includes(id));
    const nb: BranchInfo = { ...b, patch_ids: [...new Set([...b.patch_ids, patchId])] };   // `...b` keeps visibility / archived (item 269)
    const rec = await this.ledger.append('branch', nb);
    this.invalidate();
    await this.p2p?.broadcast(rec).catch(() => undefined);
    this.log('info', 'branch', `${patchId} added to ${name}${retires.length ? ` — it supersedes ${retires.join(', ')}, which subscribers will stop loading (the id stays on the track as history)` : ''}${e.status !== 'VERIFIED' ? ` — WARNING: it is ${e.status}, not verified` : ''}`, patchId);
    return nb;
  }

  /**
   * What subscribing to a track would do, BEFORE anything is spent (items 9, 256, 257, 357).
   *
   * `subscribe()` used to walk `patch_ids` and buy every id that was `sellable` — which stays true for a SUPERSEDED
   * bake — so a new subscriber to a 30-day track paid thirty times for twenty-nine retired bodies and applied them
   * all on the same rows. And it gated the purchase on `blobs.has`, not on verification, so a REJECTED bake this
   * node had already fetched went straight into the serving model. Both decisions are made here now, per item, from
   * the catalogue, and every caller (CLI, console, the sync pass) shows the same list.
   */
  async quoteBranch(name: string): Promise<TrackQuote> {
    const b = await this.branchByName(name);
    if (!b) throw notFound('branch not found');
    const st = await this.runtime.status();
    const mine = new Set(await this.mySubscriptions());
    const items = await this.resolveTrack(b);
    const totals = new Map<string, number>();
    for (const i of items) if (i.plan === 'buy') totals.set(i.currency, (totals.get(i.currency) ?? 0) + Number(i.price || 0));
    const balance = this.ledger.kind === 'local' ? await this.creditBalance(this.address).catch(() => null) : null;
    return {
      branch: b.name, owner: b.owner, description: b.description, subscribed: mine.has(b.name),
      items,
      current: items.filter((i) => i.plan === 'buy' || i.plan === 'held' || i.plan === 'own').map((i) => i.patch_id),
      retired: items.filter((i) => i.plan === 'retired').map((i) => i.patch_id),
      buy: items.filter((i) => i.plan === 'buy').map((i) => i.patch_id),
      total: [...totals.entries()].map(([currency, amount]) => ({ currency, amount: String(Math.round(amount * 1e6) / 1e6) })),
      currency: this.cfg.market.currency, balance,
      runtime_available: st.available, runtime_error: st.error ?? null,
      // Item 359: what following it costs per period, and what its own last 30 days actually cost — before the
      // decision, not after the thirtieth full-price sale.
      subscription: await this.subscriptionQuote(name).catch(() => null),
    };
  }

  /** The ids a subscriber of this track would actually load: current, verified, runnable here. */
  async currentTrackIds(b: BranchInfo): Promise<string[]> {
    return (await this.resolveTrack(b)).filter((i) => i.plan === 'buy' || i.plan === 'held' || i.plan === 'own').map((i) => i.patch_id);
  }

  /** The one place the track resolution rules live (used by the quote, the subscribe, the sync and `branch ls`). */
  private async resolveTrack(b: BranchInfo): Promise<TrackItem[]> {
    const st = await this.runtime.status();
    const members = new Set(b.patch_ids);
    const items: TrackItem[] = [];
    for (const id of b.patch_ids) {
      const e = await this.entry(id);
      if (!e) { items.push({ patch_id: id, name: null, author: null, author_name: null, price: '0', currency: this.cfg.market.currency, status: null, plan: 'unknown', reason: 'no anchor for this id on this node — it may not have reached this network yet', superseded_by: [] }); continue; }
      const a = e.anchor;
      const row = { patch_id: id, name: a.name, author: a.author, author_name: a.author_name ?? null, price: a.price, currency: a.currency, status: e.status, superseded_by: e.superseded_by };
      // A version retired BY ANOTHER MEMBER of the same track is history: the track's current answer is the newer one.
      const retiredBy = e.superseded_by.filter((x) => members.has(x));
      if (retiredBy.length) { items.push({ ...row, plan: 'retired', reason: `replaced on this track by ${retiredBy.join(', ')} — kept as history, not loaded` }); continue; }
      if (st.model && !a.model.id_M.startsWith(st.model)) { items.push({ ...row, plan: 'wrong_model', reason: `trained for ${a.model.id_M}; this node serves ${st.model}` }); continue; }
      // A publisher's withdrawal is not a verification failure (item 148). It used to be reported as `blocked`,
      // which the CLI prints as "not verified" — a lie about a knowledge that passed 2/2 and was then taken down.
      if (e.status === 'RETIRED') {
        const why = (e as MarketEntry).retire_reason;
        items.push({ ...row, plan: 'retired', reason: `withdrawn by its publisher${why ? ` ("${why}")` : ''} — not loaded; buyers who already paid keep their copy` });
        continue;
      }
      if (e.status !== 'VERIFIED' || !e.sellable) { items.push({ ...row, plan: 'blocked', reason: `${e.status} (verification ${e.passed}/${e.quorum}) — not loaded${e.status === 'REJECTED' ? ': the network rejected this bake' : ''}` }); continue; }
      if (a.author.toLowerCase() === this.address.toLowerCase()) { items.push({ ...row, plan: 'own', reason: 'published by this node' }); continue; }
      if (this.hasLicense(e)) { items.push({ ...row, plan: 'held', reason: this.licenseOf(e)?.source === 'free' ? 'free — nothing to pay' : 'already bought by this node' }); continue; }
      items.push({ ...row, plan: 'buy', reason: `${a.price} ${a.currency} to ${a.author_name ?? a.author.slice(0, 10)}…` });
    }
    return items;
  }

  /**
   * Rows a track's current items would write over in what is loaded RIGHT NOW, by pair (item 214). Only bodies this
   * node holds can be compared, which is exactly the set that can be applied, so nothing here is a guess.
   */
  private async subscribeOverlaps(trackIds: string[]): Promise<TrackOverlap[]> {
    const out: TrackOverlap[] = [];
    const map = await this.entryMap();
    const loaded = this.store.listApplied();
    for (const id of trackIds) {
      const e = map.get(id);
      if (!e) continue;
      const mine = this.blobs.addrSet(e.anchor.patch_sha256);
      for (const row of loaded) {
        if (row.patch_id === id || trackIds.includes(row.patch_id)) continue;      // the track's own layers are its business
        const other = map.get(row.patch_id);
        const theirs = this.blobs.addrSet(row.sha256);
        if (mine && theirs) {
          const n = intersectionCount(mine, theirs);
          if (n > 0) out.push({ track_id: id, loaded_id: row.patch_id, rows: n, estimated: false, loaded_reason: row.reason });
          continue;
        }
        // The track's body is not here yet — it is bought BY this subscribe, and the whole point is to warn first.
        // Every anchor publishes a 64-value bottom-k sketch of its address set, so the overlap is estimable without
        // the file. It is reported as an estimate, with no invented row count: `rows` stays null until a body is here.
        const a = e.anchor.addr_sketch ?? [];
        const b = other?.anchor.addr_sketch ?? [];
        if (!a.length || !b.length) continue;
        const j = sketchJaccard(a, b);
        if (j > 0) out.push({ track_id: id, loaded_id: row.patch_id, rows: null, estimated: true, jaccard: Math.round(j * 100) / 100, loaded_reason: row.reason });
      }
    }
    return out.sort((a, b) => (b.rows ?? 0) - (a.rows ?? 0) || (b.jaccard ?? 0) - (a.jaccard ?? 0));
  }

  /**
   * Subscribe to (or leave) a track. Item 357: everything is BOUGHT FIRST and the public subscription record is
   * appended only when every item this node needs is in hand — the old order published the record, then looped
   * `buy()` swallowing each failure as a warning, answered `{ok: true}` and let the gateway advertise this node as
   * serving a track it held a third of.
   */
  async subscribe(branch: string, action: 'subscribe' | 'unsubscribe', opts: { replace?: boolean } = {}): Promise<SubscribeResult> {
    const b = await this.branchByName(branch);
    if (!b) throw notFound('branch not found');
    if (action === 'unsubscribe') {
      const rec = await this.ledger.append('subscribe', { node: this.address, branch, action, patch_ids: b.patch_ids, created_at: Date.now() } as SubscriptionRecord);
      this.invalidate();
      await this.p2p?.broadcast(rec).catch(() => undefined);
      const loaded = this.store.listApplied().filter((a) => a.reason === `subscription:${branch}`).map((a) => a.patch_id);
      const removed: string[] = [];
      if (loaded.length) {
        /**
         * Item 214: the track's layers came off one `removePatch` at a time, each taking and releasing the lock. Two
         * versions of one knowledge with the same addresses left the model briefly answering from the base — the
         * watchdog then re-applied the layer that was still recorded, seconds before it too was removed, and what
         * the operator had pinned by hand was reverted on 241,992 rows. One lock, one target state, in order.
         */
        await this.runtime.exclusive(`unsubscribe:${branch}`, async () => {
          const keep = this.store.listApplied().map((a) => a.patch_id).filter((id) => !loaded.includes(id));
          const res = await this.assertStack(await this.layersOfExact(keep), `unsubscribe:${branch}`);
          removed.push(...res.removed.filter((id) => loaded.includes(id)));
          const reapplied = res.applied.filter((id) => keep.includes(id));
          if (reapplied.length) this.log('info', 'branch', `re-asserted ${reapplied.join(' → ')} after unloading ${branch} — what you pinned by hand is back on top`, null);
        }).catch((err) => this.log('warn', 'branch', `could not unload ${branch}: ${(err as Error).message}`, null));
      }
      this.log('info', 'branch', `unsubscribed ${branch}${removed.length ? ` — unloaded ${removed.join(', ')}` : ''} (nothing is refunded; the bodies stay on this node)`, null);
      return { ok: true, branch, action, acquired: [], failed: [], applied: [], skipped: [], removed, spent: [] };
    }
    const quote = await this.quoteBranch(branch);
    /**
     * What subscribing would write OVER (item 214). The track's items are applied on top of whatever is already
     * loaded, and the runtime is last-wins on a shared row — so subscribing to `finance/KRX-history` used to put
     * two older bakes over the final the operator had pinned by hand, silently, on 241,992 rows each. The overlap is
     * computable before anything is bought, so it is refused unless the caller says `replace`.
     */
    const clashes = await this.subscribeOverlaps(quote.current);
    if (clashes.length && !opts.replace) {
      throw conflict(
        `overlaps_loaded: ${branch} would be loaded on top of knowledge you already have in the model, and would answer instead of it on the rows they share:\n`
        + clashes.map((x) => `  ${x.track_id} writes over ${x.rows !== null ? `${x.rows.toLocaleString('en-US')} of ` : 'part of '}${x.loaded_id}'s rows`
          + `${x.estimated ? ` (estimated from the published address sketches — about ${Math.round((x.jaccard ?? 0) * 100)} % alike; the exact count is known once the body is here)` : ''}`
          + ` — ${x.loaded_id} is loaded ${x.loaded_reason === 'manual' ? 'by hand' : `by ${x.loaded_reason.replace(/^subscription:/, 'the track ')}`}`).join('\n')
        + `\n  subscribe with --replace to load the track anyway, or unload what you no longer want first.`,
        { code: 'overlaps_loaded', branch, pairs: clashes },
      );
    }
    const acquired: string[] = [];
    const failed: { patch_id: string; error: string }[] = [];
    const spent = new Map<string, number>();
    /*
     * Item 359 — the curation fee, once per period, before anything is bought. A track with no terms is free to
     * follow, exactly as every track was; a track that charges is paid for the curating, and the knowledge on it
     * is still bought from whoever published it.
     */
    const fee = await this.paySubscription(branch).catch((e) => { throw new MarketError(402, `subscription_unpaid: ${(e as Error).message}`); });
    if (fee.paid) spent.set(fee.currency, (spent.get(fee.currency) ?? 0) + Number(fee.amount));
    for (const item of quote.items.filter((i) => i.plan === 'buy')) {
      try {
        // Item 362: a purchase a track made on this node's behalf is marked as such, so the operator can tell it
        // from one they chose to make — and can add up what a subscription costs them.
        const r = await this.buy(item.patch_id, { origin: `subscription:${branch}` });
        acquired.push(item.patch_id);
        spent.set(item.currency, (spent.get(item.currency) ?? 0) + Number(r.amount || 0));
      } catch (err) { failed.push({ patch_id: item.patch_id, error: (err as Error).message }); }
    }
    if (failed.length) {
      // Nothing is announced: this node is not advertised as serving a track it could not acquire (item 357).
      this.log('warn', 'branch', `not subscribing to ${branch}: ${failed.length} of ${failed.length + acquired.length} purchase(s) failed (${failed.map((f) => `${f.patch_id}: ${f.error}`).join('; ')})${acquired.length ? `. ${acquired.join(', ')} was bought and stays on this node.` : ''}`, null, { acquired, failed });
      throw new MarketError(409, `subscription_incomplete: ${failed.length} of ${acquired.length + failed.length} item(s) could not be acquired, so ${branch} was NOT subscribed to and this node is not advertised as serving it.\n${failed.map((f) => `  ${f.patch_id}: ${f.error}`).join('\n')}${acquired.length ? `\n  (${acquired.join(', ')} was bought and stays on this node — retry when the rest is available.)` : ''}`, { branch, acquired, failed });
    }
    const current = quote.current;
    const rec = await this.ledger.append('subscribe', { node: this.address, branch, action, patch_ids: current, created_at: Date.now() } as SubscriptionRecord);
    this.invalidate();
    await this.p2p?.broadcast(rec).catch(() => undefined);
    const applied: string[] = [];
    const skipped = quote.items.filter((i) => i.plan !== 'buy' && i.plan !== 'held' && i.plan !== 'own').map((i) => ({ patch_id: i.patch_id, reason: i.reason }));
    if (current.length && quote.runtime_available) {
      const res = await this.applyStack(current, `subscription:${branch}`, { withBase: true }).catch((err) => { this.log('warn', 'branch', `subscribed to ${branch} but loading it failed: ${(err as Error).message}`, null); return null; });
      if (res) applied.push(...res.applied);
    }
    this.log('info', 'branch', `subscribed ${branch}: ${current.length} current item(s)${quote.retired.length ? `, ${quote.retired.length} retired version(s) skipped` : ''}${skipped.length ? `, ${skipped.length} not loadable` : ''}${acquired.length ? ` — bought ${acquired.join(', ')}` : ''}${applied.length ? `; loaded ${applied.join(' → ')}` : quote.runtime_available ? '' : ' (nothing loaded: the serving model is unreachable)'}`, null, { current, acquired, skipped });
    return { ok: true, branch, action, acquired, failed, applied, skipped, removed: [], spent: [...spent.entries()].map(([currency, amount]) => ({ currency, amount: String(Math.round(amount * 1e6) / 1e6) })) };
  }

  /**
   * Bring every subscribed track up to date (item 255): buy and load what the track has added since, unload the
   * versions it has retired. "Subscribe" was a one-time snapshot — nothing reacted to a later `branch` or
   * `supersede` record — while the console, the OpenAPI description and the README all promised a node that keeps
   * up. Runs on the 20-second tick and on demand (`ainize branch sync`, POST /api/branches/:name/sync).
   */
  async syncSubscription(branch: string, opts: { retryNow?: boolean } = {}): Promise<SubscribeResult> {
    if (opts.retryNow) for (const k of [...this.syncFailures.keys()]) if (k.startsWith(`${branch}|`)) this.syncFailures.delete(k);
    const quote = await this.quoteBranch(branch);
    const loaded = this.store.listApplied().filter((a) => a.reason === `subscription:${branch}`).map((a) => a.patch_id);
    const want = quote.current;
    const missing = want.filter((id) => !loaded.includes(id));
    const stale = loaded.filter((id) => !want.includes(id));
    const acquired: string[] = [];
    const failed: { patch_id: string; error: string }[] = [];
    const spent = new Map<string, number>();
    if (!missing.length && !stale.length) return { ok: true, branch, action: 'sync', acquired, failed, applied: [], skipped: [], removed: [], spent: [] };
    for (const id of missing) {
      const item = quote.items.find((i) => i.patch_id === id);
      if (item?.plan !== 'buy') continue;
      // An item this node cannot afford (or whose seller is down) must not be re-attempted every 20 seconds for ever:
      // that is a payment request to the seller and a warning in the log three times a minute, indefinitely.
      const key = `${branch}|${id}`;
      const prev = this.syncFailures.get(key);
      if (prev && Date.now() - prev.at < Market.syncBackoffMs(prev.tries)) continue;
      try {
        const r = await this.buy(id, { origin: `subscription:${branch}` });
        acquired.push(id);
        this.syncFailures.delete(key);
        spent.set(item.currency, (spent.get(item.currency) ?? 0) + Number(r.amount || 0));
      } catch (err) {
        const tries = (prev?.tries ?? 0) + 1;
        this.syncFailures.set(key, { at: Date.now(), tries, error: (err as Error).message });
        failed.push({ patch_id: id, error: (err as Error).message });
        this.log('warn', 'branch', `${branch} has an item this node could not buy — ${id}: ${(err as Error).message} (attempt ${tries}; next try in ${Math.round(Market.syncBackoffMs(tries) / 60_000)} min)`, id);
      }
    }
    const ready = want.filter((id) => !failed.some((f) => f.patch_id === id));
    const applied: string[] = [];
    const removed: string[] = [];
    if (quote.runtime_available && (ready.length || stale.length)) {
      // One lock for the whole change-over: the retired version comes off and the new one goes on in one section,
      // so the model is never left answering from neither.
      await this.runtime.exclusive(`sync:${branch}`, async () => {
        const keep = this.store.listApplied().map((a) => a.patch_id).filter((id) => !stale.includes(id));
        const layers = ready.length ? await this.layersFor(ready, { withBase: true }) : [];
        const target = [...(await this.layersOfExact(keep)), ...layers.filter((l) => !keep.includes(l.id)).map((l) => ({ ...l, reason: `subscription:${branch}` }))];
        const res = await this.assertStack(target, `subscription:${branch}`);
        applied.push(...res.applied); removed.push(...res.removed);
      }).catch((err) => this.log('warn', 'branch', `${branch}: loading the new items failed: ${(err as Error).message}`, null));
    }
    if (applied.length || removed.length || acquired.length) {
      this.log('info', 'branch', `subscription ${branch} updated → ${applied.length ? `loaded ${applied.join(', ')}` : 'nothing new to load'}${removed.length ? `; unloaded the retired ${removed.join(', ')}` : ''}${acquired.length ? `; bought ${acquired.join(', ')}` : ''}`, applied[0] ?? null, { applied, removed, acquired, failed });
    }
    return { ok: true, branch, action: 'sync', acquired, failed, applied, skipped: [], removed, spent: [...spent.entries()].map(([currency, amount]) => ({ currency, amount: String(Math.round(amount * 1e6) / 1e6) })) };
  }

  /** Items a sync could not buy, so the next tick does not try again immediately: `${branch}|${id}` → when and how often. */
  private syncFailures = new Map<string, { at: number; tries: number; error: string }>();
  /** 1 min, 2, 4, 8 … capped at an hour. A `branch sync` by hand ignores this and tries at once. */
  private static syncBackoffMs(tries: number): number { return Math.min(60_000 * 2 ** Math.max(0, tries - 1), 3600_000); }

  /** Every subscribed track, brought up to date (the 20-second tick). Failures are logged, never thrown. */
  async reconcileSubscriptions(): Promise<void> {
    for (const name of await this.mySubscriptions()) {
      await this.syncSubscription(name).catch((e) => this.log('warn', 'branch', `sync ${name} failed: ${(e as Error).message}`, null));
    }
  }

  async mySubscriptions(): Promise<string[]> {
    const subs = await this.ledger.subscriptions();
    const state = new Map<string, boolean>();
    for (const r of subs) if (r.body.node === this.address) state.set(r.body.branch, r.body.action === 'subscribe');
    return [...state.entries()].filter(([, v]) => v).map(([k]) => k);
  }

  /** Gateway routing (청구항 18): context attributes → branch → subscribed nodes. */
  async route(context: Record<string, string>, opts: { partial?: boolean } = {}): Promise<RouteResult> {
    const branches = await this.branches();          // test / archived tracks are never routed to (item 269)
    const keys = Object.entries(context);
    const scored = branches.map((b) => {
      const matched = keys.filter(([k, v]) => b.context[k] === v).map(([k]) => k);
      return { branch: b, matched, unmatched: keys.filter(([k]) => !matched.includes(k)).map(([k]) => k) };
    }).filter((x) => x.matched.length > 0)
      // most keys matched first; then the track that asks for the fewest extra attributes (the most specific answer
      // to exactly this context); then by name, so two equal candidates always resolve the same way on every node.
      .sort((a, b) => b.matched.length - a.matched.length
        || Object.keys(a.branch.context).length - Object.keys(b.branch.context).length
        || a.branch.name.localeCompare(b.branch.name));
    const candidates = scored.map((x) => ({ name: x.branch.name, context: x.branch.context, matched: x.matched, unmatched: x.unmatched }));
    // Item 234: `market=KRX foo=bar` used to answer finance/KRX-latest with one key unmatched and no sign of it, and
    // `market=KRX` alone picked whichever of two matching tracks came first. A partial match is now a refusal by
    // default — the caller asked for something this track does not promise — and `partial` is how you ask anyway.
    const full = scored.filter((x) => x.unmatched.length === 0);
    const pick = (opts.partial ? scored : full)[0] ?? null;
    if (!pick) return { branch: null, matched: [], unmatched: keys.map(([k]) => k), candidates, ambiguous: false, current: [], nodes: [], stale_nodes: [] };
    const best = pick.branch;
    const subs = await this.ledger.subscriptions();
    const active = new Map<string, boolean>();
    for (const r of subs) if (r.body.branch === best.name) active.set(r.body.node.toLowerCase(), r.body.action === 'subscribe');
    const current = await this.currentTrackIds(best);
    const nodes = (await this.knownNodes()).filter((n) => active.get(n.address?.toLowerCase() ?? ''));
    /**
     * A subscribe record says a node ONCE subscribed; it says nothing about what that node has in its model right
     * now, and apply failures inside `subscribe` were logged as warnings while the record stood. So an agent routing
     * by context was sent to a node serving the superseded day-1 bake — or nothing at all — with no field to check.
     * `applied` is what each node reports it is serving (item 234), and a node missing any current item is named.
     */
    const rows = nodes.map((n) => {
      const applied = n.applied ?? null;
      const missing = applied ? current.filter((id) => !applied.includes(id)) : current;
      return { ...n, applied, missing, current: applied ? missing.length === 0 : null };
    });
    return {
      branch: best, matched: pick.matched, unmatched: pick.unmatched, candidates,
      ambiguous: (opts.partial ? scored : full).length > 1,
      current,
      nodes: rows,
      stale_nodes: rows.filter((n) => n.current === false).map((n) => ({ address: n.address, name: n.name, endpoint: n.endpoint, missing: n.missing })),
    };
  }

  async selfInfo(): Promise<PeerInfo> {
    const st = await this.runtime.status();
    return {
      address: this.address, public_key: this.cfg.identity.publicKey, name: this.cfg.name, endpoint: this.publicUrl, roles: this.cfg.roles,
      ledger: this.ledger.kind, chain_id: this.cfg.ledger.ain?.chainId, model: st.model ?? undefined, branches: await this.mySubscriptions(),
      // What this node is SERVING, in order (item 234). `branches` said what it once subscribed to; a router needs
      // to know which version — if any — is actually on the model before it sends traffic here.
      applied: this.store.listApplied().map((a) => a.patch_id),
      blobs: this.blobs.list().map((b) => b.sha256), datasets: this.datasets.list().map((b) => b.sha256).slice(0, 40),
      version: VERSION, build: buildStamp(), config_version: this.cfg.version, instance: Market.INSTANCE, last_seen: Date.now(),
      // What this node offers a person who publishes through it, so the terms can be compared across nodes (item 307).
      // The split a teacher is shown was the local operator's config value with nothing to compare it against.
      shares: {
        ...(this.acceptsContributions() ? { teach: this.teach().contributorShare } : {}),
        royalty: effectiveRoyaltyShare(undefined, this.cfg.market.royaltyShare),
        verifier: effectiveVerifierShare(undefined, this.cfg.market.verifierShare),
      },
      // …and the rest of the terms, for the same reason (item 368): a peer table can only compare what is published.
      quorum: this.cfg.verifier?.quorum ?? 2,
      default_price: this.cfg.market.defaultPrice,
      accepts_contributions: this.acceptsContributions(),
    };
  }

  /** Two endpoints must be the same box before one is allowed to hide the other. */
  private static sameEndpoint(a: string | undefined, b: string | undefined): boolean {
    return (a ?? '').replace(/\/+$/, '') === (b ?? '').replace(/\/+$/, '');
  }

  /**
   * Every node this one has heard of — deduped, and newest first (item 140).
   *
   * Node records are permanent and every start with a fresh key writes another one, so the union used to grow
   * without limit: 122 records for a network of three running nodes, 47 of them called node-a, in API order, with
   * this node's own row 119 lines down. Now: the newest record per address wins, rows that are the same box under a
   * new key (same name AND endpoint) collapse into the newest, and the list comes back self first then by last_seen.
   * Nothing is dropped here — `GET /api/nodes` decides what is recent enough to show, and `?all=1` asks for all of it.
   */
  async knownNodes(): Promise<PeerInfo[]> {
    const recs = await this.ledger.nodes();
    // Keyed by address AND endpoint: an address answering at two endpoints is two nodes on one identity (item 139),
    // and collapsing them by address is exactly how the loser used to disappear from every registry without a word.
    const key = (n: PeerInfo) => `${n.address?.toLowerCase()}|${(n.endpoint ?? '').replace(/\/+$/, '')}`;
    const byNode = new Map<string, PeerInfo>();
    for (const r of recs) {
      const cur = byNode.get(key(r.body));
      if (!cur || (r.body.last_seen ?? 0) >= (cur.last_seen ?? 0)) byNode.set(key(r.body), r.body);
    }
    for (const p of this.store.listPeers()) if (p.info) byNode.set(key(p.info), { ...p.info, last_seen: p.last_seen });
    const self = await this.selfInfo();
    byNode.set(key(self), self);
    const byBox = new Map<string, PeerInfo>();
    for (const n of byNode.values()) {
      const key = `${n.name}|${(n.endpoint ?? '').replace(/\/+$/, '')}`;
      const cur = byBox.get(key);
      if (!cur || n.address === this.address || (n.last_seen ?? 0) > (cur.last_seen ?? 0)) byBox.set(key, n);
    }
    return [...byBox.values()].sort((a, b) =>
      (a.address === this.address ? -1 : b.address === this.address ? 1 : (b.last_seen ?? 0) - (a.last_seen ?? 0)));
  }

  /**
   * One address answering at two endpoints, right now (item 139): a cloned VM, a backup restored beside the original,
   * a staging copy of a production home. `knownNodes()` is keyed by address, so the loser silently disappears from
   * every registry and buyers are routed to whichever spoke last — for reasons no log ever explained. Only endpoints
   * seen inside `windowMs` count, so a node that simply MOVED does not report itself as a collision forever.
   */
  static readonly DUPLICATE_WINDOW_MS = 10 * 60_000;
  duplicateNodeAddresses(nodes: PeerInfo[], windowMs = Market.DUPLICATE_WINDOW_MS): Map<string, string[]> {
    const now = Date.now();
    const byAddr = new Map<string, string[]>();
    for (const n of nodes) {
      if (!n.address || !n.endpoint) continue;
      if (n.address !== this.address && now - (n.last_seen ?? 0) > windowMs) continue;
      const k = n.address.toLowerCase();
      const eps = byAddr.get(k) ?? [];
      if (!eps.some((e) => Market.sameEndpoint(e, n.endpoint))) eps.push(n.endpoint);
      byAddr.set(k, eps);
    }
    return new Map([...byAddr].filter(([, eps]) => eps.length > 1));
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
  updateTeachPolicy(patch: TeachPolicyPatch): TeachSettings {
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
