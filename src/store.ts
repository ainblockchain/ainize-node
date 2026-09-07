/**
 * Node-local state (SQLite via node:sqlite): drafts, blobs, purchases, peers, events, sessions,
 * x402 nonces, applied patches. Everything that is *not* shared truth lives here; shared truth is the Ledger.
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PatchAnchor, PeerInfo, PatchManifest, TeachDatasetSource, TeachDatasetStatus, TeachDatasetSummary, TeachTrainingSpec } from '@ainize/core';

export interface BlobRow { sha256: string; path: string; size_bytes: number; rows: number; row_dim: number; imported_at: number; }
/** AIN that arrived for a knowledge and did not cover its price — held for the payer, never kept (item 279). */
export interface PartialPaymentRow { tx_hash: string; patch_id: string; payer: string; amount: string; currency: string; nonce: string | null; resource: string | null; transfer_key: string | null; consumed_by: string | null; created_at: number }

/** A live download token (item 345): who it was handed to, and how many times it has been redeemed. */
export interface TokenRow { token: string; sha256: string; issued_to: string; expires_at: number; redemptions: number; last_used: number | null; patch_id: string | null }
export interface PurchaseRow { patch_id: string; sha256: string; tx_hash: string; scheme: string; amount: string; manifest: PatchManifest | null; path: string | null; created_at: number;
  /** Why this node paid (item 362): a deliberate purchase, or an item a track subscription bought on its own. */
  origin?: string;
  /** address → amount, from the seller's `x-payment-response`: who this purchase actually paid (item 280). */
  royalty?: Record<string, string> | null; }
/** Severity order (low → high): a `level` filter means "this level and worse". */
export const EVENT_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
/**
 * Every `kind` this node writes events under. `ainize logs --kind` offers exactly these, so a mistyped kind is
 * refused with the list instead of printing an empty screen that looks like an idle node (items 116/132).
 */
export const EVENT_KINDS = [
  'blob', 'branch', 'buy', 'challenge', 'config', 'drive',
  // `lineage` = somebody published a knowledge built on one of ours; `royalty` = a sale of theirs paid us for it
  // (items 183, 195, 318, 319). Both are derived from the catalogue, so `ainize logs --kind lineage` works on
  // whichever route the record took.
  'lineage', 'node', 'p2p', 'patch', 'payout', 'publish', 'royalty',
  'runtime', 'seed', 'settings', 'teach', 'trade', 'usage', 'verifier', 'verify',
] as const;

export interface EventRow { seq: number; ts: number; level: (typeof EVENT_LEVELS)[number]; kind: string; patch_id: string | null; message: string; data: unknown; }
/**
 * One peer this node talks to. `source` is the fact an operator could not get anywhere before (item 136): gossip
 * silently adds every endpoint any peer advertises, and the CLI printed the merged list under "configured peers".
 * `last_error` / `last_attempt` are the other half (item 138): a dead peer used to produce no event, no error text
 * and no state at all — only a raw integer nobody was told to read.
 */
export interface PeerRow {
  endpoint: string; address: string | null; info: PeerInfo | null; last_seen: number; failures: number; cursor: number;
  /** 'configured' = config.json `peers` or `peers add`; 'learned' = peer exchange. */
  source: 'configured' | 'learned';
  /** Which peer advertised this endpoint, when it was learned by exchange. */
  learned_from: string | null;
  /** Why the last round failed, and when it was tried — null while the peer is answering. */
  last_error: string | null;
  last_attempt: number;
}
/** An endpoint `peers rm` took out: gossip must not put it back (item 137). */
export interface BlockedPeerRow { endpoint: string; blocked_at: number; reason: string | null; }
/** One recorded promise to build on a knowledge (item 312): the key that asked, when, and the child that kept it. */
export interface DeriveIntentRow { parent_id: string; child_key: string; dataset_sha256: string; first_at: number; last_at: number; fetches: number; declared_by: string | null; }
/** Starting local credit issued by THIS node to one address (item 364) — the grant a balance is derived from. */
export interface CreditGrantRow { address: string; amount: string; reason: string; granted_at: number; }
/**
 * An x402 payment this node started (item 274). `quoted` = a 402 answered, nothing spent yet; `paid` = the money
 * left (tx_hash), the manifest has not come back; `settled` = the seller answered; `abandoned` = the operator gave up.
 */
export interface PendingPaymentRow {
  id: number; patch_id: string; gateway: string; resource: string; scheme: string; pay_to: string;
  amount: string; currency: string; nonce: string; tx_hash: string | null; payload: string | null;
  status: 'quoted' | 'paid' | 'settled' | 'abandoned'; error: string | null; created_at: number; updated_at: number;
}
export interface DraftRow { id: string; anchor: PatchAnchor; file_path: string; created_at: number; updated_at: number; }

/** One teach job (spec §6.5) as persisted; JSON columns are decoded. */
export interface TeachJobRow {
  id: string; contributor: string; contributor_name: string | null; ip: string | null; status: string;
  context: string[]; builds_on: boolean; facts: TeachFactRow[]; job_dir: string | null; npz_path: string | null; sha256: string | null;
  progress: Record<string, unknown> | null; checks: Record<string, unknown> | null; error: string | null; container_pid: number | null;
  draft_id: string | null; patch_id: string | null; publish_status: string; reject_reason: string | null; parent_job: string | null;
  result: { sha256: string; rows: number; size_bytes: number } | null; blocked: string | null; name: string | null;
  /** Teach mode v2: the dataset this job trained a slice of. NULL on v1 rows — they render as `source: 'derived'`. */
  dataset_id: string | null; dataset_sha256: string | null; dataset_rows: number | null; dataset_source: string | null;
  /** Effort preset + the resolved trainer knobs (v2); NULL on v1 rows. */
  training: TeachTrainingSpec | null;
  /** Sampled preflight accounting `{checked, of, known}` (v2). */
  preflight: Record<string, unknown> | null;
  created_at: number; started_at: number | null; finished_at: number | null; updated_at: number; expires_at: number | null; cancel_requested: boolean;
  /** true while the lesson npz is (or may still be) applied to the shared serving model (set before applyRaw in CHECKING, cleared after removeRaw). */
  lesson_applied: boolean;
  /**
   * Lineage (design §5.3). `bases` is the ORDERED stack the lesson was trained on top of (ancestors first, the chosen
   * base last), `mode` how the job was made, `export_mode` what the trainer was asked to write. NULL on pre-lineage rows.
   */
  bases: { patch_id: string; sha256: string }[] | null;
  mode: 'scratch' | 'extend' | 'fork' | 'merge' | null;
  export_mode: 'delta' | 'squash' | null;
  /**
   * Merge (design §9): which two knowledges, which build tier, what was chosen for each conflicting question, and the
   * row-level measurement the tier was decided from. NULL on every other kind of job.
   */
  merge: { tier: 'union' | 'retrain' | 'rebuild'; a: string; b: string; conflicts: number; resolutions: Record<string, string>;
    targets: number; dropped: number; from_a: number; from_b: number; rows: { shared: number; disagree: number; opposing: number } } | null;
  /** what the diff engine decided the child is (kind + row counts), once known */
  derivation: Record<string, unknown> | null;
  /** per parent, in deployment order: `{patch_id, hit, total, failed: [sample_index]}` measured with the lesson ON TOP */
  parent_check: { patch_id: string; hit: number; total: number; failed: number[]; simulated?: boolean }[] | null;
  /** null until the runtime journal exists (L2): nothing was measured about reversibility */
  reversibility_ok: boolean | null;
  /** sha256 of `<job>/snapshot.jsonl` — the dataset bytes frozen at job creation (== dataset_sha256 at that moment) */
  snapshot_sha256: string | null;
  /** the training-set choices made at publish: access, licence, notes, declaration, and the sha of the pinned copy */
  dataset_pub: { access: string; license: string; include_notes: boolean; declaration: Record<string, unknown> | null; published_sha256: string } | null;
}
export interface TeachFactRow { prompt: string; answer: string; alt_prompt?: string; base_answer?: string; after_answer?: string; hit?: boolean; heldout_hit?: boolean; status?: string;
  /** Lineage §7.1: this question deliberately CHANGES an inherited answer — `'<base>#<row>'`. It is trained, kept out of the keep-set, and never counted as a regression of the base it overrides. */
  replaces?: string;
  /** Merge §9 step 4: which knowledge this question came from (`'<patch id>'`, or `'own'` for an answer the creator wrote) — what makes the verification stratified per source instead of one average. */
  origin?: string }

/** One dataset as persisted (teach mode v2). `dir` holds `source.<ext>`, `rows.jsonl` and `report.json`. */
export interface TeachDatasetRecord {
  id: string; owner: string; ip: string | null; name: string;
  status: TeachDatasetStatus; source: TeachDatasetSource;
  format: string | null; encoding: string | null; layout: string | null; delimiter: string | null;
  has_header: boolean | null; columns: Record<string, string | number> | null;
  sha256: string; revision: number; rows: number; invalid_rows: number; size_bytes: number;
  source_bytes: number | null; source_name: string | null; source_sha256: string | null;
  dir: string; summary: TeachDatasetSummary | null; parent_dataset: string | null;
  /** Lineage (design §5.3): the KNOWLEDGE this set was copied out of, the sha of the parent's set, how many of its rows are still here. */
  parent_patch: string | null; parent_dataset_sha: string | null; inherited_rows: number | null;
  retention: 'keep' | 'delete_after_training';
  created_at: number; updated_at: number; expires_at: number | null; deleted_at: number | null;
}
export interface ContributorRow { address: string; name: string | null; payout_address: string | null; first_seen: number; last_seen: number; jobs: number; published: number; hidden: boolean; note: string | null }
export interface BanRow { id: number; kind: 'address' | 'ip'; value: string; reason: string | null; ts: number }
/** `paying` = a transfer is in flight right now (claimed atomically by the payout runner); a row found `paying` at boot was interrupted mid-transfer. */
export interface PayoutRow { id: number; patch_id: string; settle_hash: string; address: string; amount: string; currency: string; status: 'pending' | 'paying' | 'paid' | 'failed'; tx_hash: string | null; attempts: number; last_error: string | null; created_at: number; updated_at: number;
  /** The key the transfer was written under, `/transfer/$seller/$to/$key` (item 314) — what joins it to the sale. */
  transfer_key?: string | null;
  /** true once the `payout` record naming this transfer is on the shared ledger, so an ancestor can find it. */
  recorded?: boolean }

/**
 * One open question about a knowledge — what the "what to add on top of this" panel lists (lineage design §5.6, §10, SC-12).
 * `cluster_key` is what makes two reports the same question; it is a keyed HMAC of the normalised prompt, so the table
 * counts repeats without holding the text. `text` is filled ONLY when the person who reported it consented to share it
 * (SC-13 *Share*), or when the question is already public on the record (an `own_miss` resolves its prompt from
 * `benchmark.samples[sample_index]` at read time and stores nothing).
 */
export type IssueKind = 'own_miss' | 'preflight' | 'free_wrong' | 'request' | 'gap';
export interface IssueRow {
  id: string; patch_id: string; kind: IssueKind; cluster_key: string;
  count: number; people: number;
  text: string | null; sample_index: number | null; topic: string | null;
  first_seen: number; last_seen: number;
  /** `'open'` or `'covered_by:<patch id>'` — a descendant published a training set that answers it (§10). */
  status: string;
}

/** Counter columns of `patch_signals_daily` (lineage design §5.6). */
export const SIGNAL_COUNTERS = [
  'tests', 'hits', 'misses', 'unscored', 'marked_wrong', 'preflight_wrong_today', 'preflight_in_base', 'preflight_base_conflict',
  'overlaps_pointed', 'derive_fetches', 'builds_on_jobs', 'parent_regression_fails',
] as const;
export type SignalCounter = (typeof SIGNAL_COUNTERS)[number];
export type SignalSummary = Record<SignalCounter, number> & { window_days: number; days: number; visitors: number };

// HyperLogLog over visitor ids: 2^10 registers, one byte each (1 KB per patch-day; ~3 % error at any cardinality).
const HLL_P = 10;
const HLL_M = 1 << HLL_P;
function hllAdd(sketch: Buffer | null, value: string): Buffer {
  const out = sketch && sketch.length === HLL_M ? Buffer.from(sketch) : Buffer.alloc(HLL_M);
  const h = createHash('sha256').update(value).digest();
  const idx = h.readUInt16BE(0) >>> (16 - HLL_P);
  // rank = position of the first 1 bit in the rest of the hash (1-based), capped at the byte range
  let rank = 1;
  for (let i = 2; i < 32; i++) {
    const b = h[i];
    if (b === 0) { rank += 8; continue; }
    rank += Math.clz32(b) - 24;
    break;
  }
  if (rank > out[idx]) out[idx] = Math.min(255, rank);
  return out;
}
function hllMerge(a: Buffer | null, b: Buffer): Buffer {
  if (!a) return Buffer.from(b);
  const out = Buffer.from(a);
  for (let i = 0; i < HLL_M && i < b.length; i++) if (b[i] > out[i]) out[i] = b[i];
  return out;
}
function hllCount(sketch: Buffer): number {
  const alpha = 0.7213 / (1 + 1.079 / HLL_M);
  let sum = 0; let zeros = 0;
  for (let i = 0; i < HLL_M; i++) { sum += Math.pow(2, -sketch[i]); if (sketch[i] === 0) zeros++; }
  let est = alpha * HLL_M * HLL_M / sum;
  if (est <= 2.5 * HLL_M && zeros > 0) est = HLL_M * Math.log(HLL_M / zeros);   // small-range correction
  return Math.round(est);
}
export const hll = { add: hllAdd, merge: hllMerge, count: hllCount };

export class Store {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS drafts (id TEXT PRIMARY KEY, anchor TEXT NOT NULL, file_path TEXT NOT NULL, created_at REAL NOT NULL, updated_at REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS blobs (sha256 TEXT PRIMARY KEY, path TEXT NOT NULL, size_bytes INTEGER NOT NULL, rows INTEGER NOT NULL, row_dim INTEGER NOT NULL, imported_at REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS addrsets (sha256 TEXT PRIMARY KEY, addrs BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS purchases (patch_id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, tx_hash TEXT NOT NULL, scheme TEXT NOT NULL, amount TEXT NOT NULL, manifest TEXT, path TEXT, created_at REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS peers (endpoint TEXT PRIMARY KEY, address TEXT, info TEXT, last_seen REAL NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0, cursor REAL NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'configured', learned_from TEXT, last_error TEXT, last_attempt REAL NOT NULL DEFAULT 0);
      -- item 137: "peers rm" survived exactly one gossip round. An endpoint the operator removed stays removed
      -- until they add it back, whoever advertises it in the meantime.
      CREATE TABLE IF NOT EXISTS peers_blocked (endpoint TEXT PRIMARY KEY, blocked_at REAL NOT NULL, reason TEXT);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, level TEXT NOT NULL, kind TEXT NOT NULL, patch_id TEXT, message TEXT NOT NULL, data TEXT);
      CREATE INDEX IF NOT EXISTS idx_events_patch ON events(patch_id);
      CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, created_at REAL NOT NULL, expires_at REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS nonces (nonce TEXT PRIMARY KEY, resource TEXT NOT NULL, amount TEXT NOT NULL, pay_to TEXT NOT NULL, expires_at REAL NOT NULL, used INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS payments_seen (tx_hash TEXT PRIMARY KEY, patch_id TEXT NOT NULL, ts REAL NOT NULL);
      -- Money moves before a manifest comes back, so the INTENT is written first (item 274): one row per x402
      -- payment this node makes, from the moment it has a quote, updated with the tx hash BEFORE the payment is
      -- presented. A row left at 'paid' is a purchase that owes this node a body — market.collect() finishes it.
      CREATE TABLE IF NOT EXISTS pending_payments (id INTEGER PRIMARY KEY AUTOINCREMENT, patch_id TEXT NOT NULL, gateway TEXT NOT NULL,
        resource TEXT NOT NULL, scheme TEXT NOT NULL, pay_to TEXT NOT NULL, amount TEXT NOT NULL, currency TEXT NOT NULL,
        nonce TEXT NOT NULL, tx_hash TEXT, payload TEXT, status TEXT NOT NULL, error TEXT, created_at REAL NOT NULL, updated_at REAL NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_pending_payments_patch ON pending_payments(patch_id, status);
      -- Local credit is issued by THIS node, not owned by the buyer (item 364): every starting grant is a row here,
      -- so creditBalance sums records that exist instead of assuming a balance for any address that ever appears.
      CREATE TABLE IF NOT EXISTS credit_grants (address TEXT PRIMARY KEY, amount TEXT NOT NULL, reason TEXT NOT NULL, granted_at REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS applied (patch_id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at REAL NOT NULL, reason TEXT NOT NULL,
        position INTEGER, journal_path TEXT, stack_sha256 TEXT);
      CREATE TABLE IF NOT EXISTS tokens (token TEXT PRIMARY KEY, sha256 TEXT NOT NULL, issued_to TEXT NOT NULL, expires_at REAL NOT NULL);
      -- Possession is not a licence (item 327): a verifier holds every body it ever scored, and a subscriber that
      -- verified an item was never charged for it. "licenses" is the separate record of what this node may actually
      -- USE — "source" says where the right came from, and 'verification' is explicitly not a right to serve.
      CREATE TABLE IF NOT EXISTS licenses (patch_id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, source TEXT NOT NULL, detail TEXT, created_at REAL NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_licenses_sha ON licenses(sha256);
      CREATE TABLE IF NOT EXISTS teach_jobs (id TEXT PRIMARY KEY, contributor TEXT NOT NULL, contributor_name TEXT, ip TEXT, status TEXT NOT NULL,
        context TEXT NOT NULL, builds_on INTEGER NOT NULL DEFAULT 0, facts TEXT NOT NULL, job_dir TEXT, npz_path TEXT, sha256 TEXT, progress TEXT, checks TEXT,
        error TEXT, container_pid INTEGER, draft_id TEXT, patch_id TEXT, publish_status TEXT NOT NULL DEFAULT 'none', reject_reason TEXT, parent_job TEXT,
        result TEXT, blocked TEXT, name TEXT,
        created_at REAL NOT NULL, started_at REAL, finished_at REAL, updated_at REAL NOT NULL, expires_at REAL, cancel_requested INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS idx_teach_jobs_contrib ON teach_jobs(contributor);
      CREATE INDEX IF NOT EXISTS idx_teach_jobs_status ON teach_jobs(status);
      CREATE TABLE IF NOT EXISTS teach_quota (key TEXT NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (key, day));
      CREATE TABLE IF NOT EXISTS teach_stats (job_id TEXT PRIMARY KEY, load_s REAL, steps INTEGER, step_s REAL, total_s REAL, rows INTEGER, ts REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS teach_datasets (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, ip TEXT, name TEXT,
        status TEXT NOT NULL, source TEXT NOT NULL,
        format TEXT, encoding TEXT, layout TEXT, delimiter TEXT, has_header INTEGER, columns TEXT,
        sha256 TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
        rows INTEGER NOT NULL, invalid_rows INTEGER NOT NULL DEFAULT 0,
        size_bytes INTEGER NOT NULL, source_bytes INTEGER, source_name TEXT, source_sha256 TEXT,
        dir TEXT NOT NULL, summary TEXT, parent_dataset TEXT,
        retention TEXT NOT NULL DEFAULT 'keep',
        created_at REAL NOT NULL, updated_at REAL NOT NULL, expires_at REAL, deleted_at REAL);
      CREATE INDEX IF NOT EXISTS idx_teach_datasets_owner ON teach_datasets(owner);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_teach_datasets_sha ON teach_datasets(owner, sha256, revision) WHERE deleted_at IS NULL;
      CREATE TABLE IF NOT EXISTS contributors (address TEXT PRIMARY KEY, name TEXT, payout_address TEXT, first_seen REAL NOT NULL, last_seen REAL NOT NULL,
        jobs INTEGER NOT NULL DEFAULT 0, published INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0, note TEXT);
      CREATE TABLE IF NOT EXISTS bans (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, value TEXT NOT NULL, reason TEXT, ts REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS payouts (id INTEGER PRIMARY KEY AUTOINCREMENT, patch_id TEXT NOT NULL, settle_hash TEXT NOT NULL, address TEXT NOT NULL, amount TEXT NOT NULL,
        currency TEXT NOT NULL, status TEXT NOT NULL, tx_hash TEXT, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at REAL NOT NULL, updated_at REAL NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_payouts_settle ON payouts(settle_hash);
      CREATE INDEX IF NOT EXISTS idx_payouts_status ON payouts(status);
      CREATE TABLE IF NOT EXISTS patch_signals_daily (patch_id TEXT NOT NULL, day TEXT NOT NULL,
        tests INTEGER NOT NULL DEFAULT 0, hits INTEGER NOT NULL DEFAULT 0, misses INTEGER NOT NULL DEFAULT 0, unscored INTEGER NOT NULL DEFAULT 0,
        marked_wrong INTEGER NOT NULL DEFAULT 0, preflight_wrong_today INTEGER NOT NULL DEFAULT 0, preflight_in_base INTEGER NOT NULL DEFAULT 0,
        preflight_base_conflict INTEGER NOT NULL DEFAULT 0, overlaps_pointed INTEGER NOT NULL DEFAULT 0, derive_fetches INTEGER NOT NULL DEFAULT 0,
        builds_on_jobs INTEGER NOT NULL DEFAULT 0, parent_regression_fails INTEGER NOT NULL DEFAULT 0, visitors_hll BLOB,
        PRIMARY KEY (patch_id, day));
      CREATE TABLE IF NOT EXISTS patch_issues (id TEXT PRIMARY KEY, patch_id TEXT NOT NULL, kind TEXT NOT NULL, cluster_key TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0, people INTEGER NOT NULL DEFAULT 0, people_hll BLOB,
        text TEXT, sample_index INTEGER, topic TEXT,
        first_seen REAL NOT NULL, last_seen REAL NOT NULL, status TEXT NOT NULL DEFAULT 'open');
      CREATE INDEX IF NOT EXISTS idx_patch_issues_patch ON patch_issues(patch_id, status);
    `);
    // additive migrations (SQLite has no ADD COLUMN IF NOT EXISTS) — a v1 database opens unchanged and gains the columns
    const add = (table: string, defs: Record<string, string>) => {
      const have = new Set((this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
      for (const [name, decl] of Object.entries(defs)) if (!have.has(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`);
    };
    add('teach_jobs', {
      lesson_applied: 'INTEGER NOT NULL DEFAULT 0',
      // teach mode v2: which dataset (and which slice of it) this lesson trained
      dataset_id: 'TEXT', dataset_sha256: 'TEXT', dataset_rows: 'INTEGER', dataset_source: 'TEXT',
      training: 'TEXT', preflight: 'TEXT',
      // lineage (design §5.3): the ordered base stack, how the job was made, what the trainer exported, the chain check
      bases: 'TEXT', mode: 'TEXT', export_mode: 'TEXT', derivation: 'TEXT', parent_check: 'TEXT', reversibility_ok: 'INTEGER',
      // merge (§9): the two parents, the tier, and what was chosen for each conflicting question
      merge: 'TEXT',
      snapshot_sha256: 'TEXT', dataset_pub: 'TEXT',
    });
    // lineage §5.3: a training set can be a copy of a published KNOWLEDGE's set, and remembers which one
    add('teach_datasets', { parent_patch: 'TEXT', parent_dataset_sha: 'TEXT', inherited_rows: 'INTEGER' });
    // published training sets held by this node (design §5.2) — content-addressed like `blobs`
    this.db.exec(`CREATE TABLE IF NOT EXISTS dataset_blobs (sha256 TEXT PRIMARY KEY, rows INTEGER NOT NULL, size_bytes INTEGER NOT NULL, access TEXT NOT NULL,
      license TEXT NOT NULL, patch_id TEXT, pinned_at REAL NOT NULL)`);
    // Item 312: a derive token used to be a free, unrecorded download of the questions that make a knowledge worth
    // buying. The intent is now a COMMITMENT this node keeps: which key said it was building on which knowledge, and
    // when. It is what the publish gate checks a child against, and what the creator of the parent is shown.
    this.db.exec(`CREATE TABLE IF NOT EXISTS derive_intents (parent_id TEXT NOT NULL, child_key TEXT NOT NULL, dataset_sha256 TEXT NOT NULL,
      first_at REAL NOT NULL, last_at REAL NOT NULL, fetches INTEGER NOT NULL DEFAULT 1, declared_by TEXT, PRIMARY KEY (parent_id, child_key));
      CREATE INDEX IF NOT EXISTS idx_derive_intents_key ON derive_intents(child_key);`);
    // teach mode v2 (design §D7): every visitor-facing p50/p90 filters on `backend`, so a stub node's 3-second jobs
    // can never be presented as measured gradient training. `sentences` = rows x renderings, what actually drives cost.
    add('teach_stats', { backend: 'TEXT', rows_trained: 'INTEGER', sentences: 'INTEGER' });
    // lineage §5.4: `applied` becomes an ordered stack with a journal per patch (the values the apply overwrote).
    add('applied', { position: 'INTEGER', journal_path: 'TEXT', stack_sha256: 'TEXT' });
    /*
     * Item 279 — an AIN transfer below the price was rejected with a sentence and nothing else: the money stayed
     * in the seller's wallet, no settlement existed, and the tx hash was still spendable by anyone who read it off
     * the chain. A rounding or typing mistake donated the transfer to the seller with no receipt and no
     * instruction. A short transfer is now HELD here, against (knowledge, payer), until the payer tops it up.
     */
    this.db.exec(`CREATE TABLE IF NOT EXISTS partial_payments (tx_hash TEXT PRIMARY KEY, patch_id TEXT NOT NULL, payer TEXT NOT NULL,
      amount TEXT NOT NULL, currency TEXT NOT NULL, nonce TEXT, resource TEXT, transfer_key TEXT, consumed_by TEXT, created_at REAL NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_partial_payments_payer ON partial_payments(patch_id, payer);`);
    // Item 314: a royalty transfer used to be an anonymous push with nothing tying it to the sale it honoured.
    add('payouts', { transfer_key: 'TEXT', recorded: 'INTEGER NOT NULL DEFAULT 0' });
    // Item 362: a purchase a subscription made on its own read exactly like one the operator chose to make.
    // Item 280: what the money was split into, as the seller reported it in `x-payment-response`.
    add('purchases', { origin: "TEXT NOT NULL DEFAULT 'manual'", royalty: 'TEXT' });
    // Items 136/138: where a peer came from, who advertised it, and what the last round actually said when it failed.
    add('peers', { source: "TEXT NOT NULL DEFAULT 'configured'", learned_from: 'TEXT', last_error: 'TEXT', last_attempt: 'REAL NOT NULL DEFAULT 0' });
    // Item 277: a knowledge priced at 0 is handed over without a payment, so it writes no settle record — and a
    // settle record is what `downloads` counts. This is where a free hand-over is counted instead: on the seller's
    // own node, by day, with nobody's address in it (the point of the free path is that taking it names no one).
    this.db.exec(`CREATE TABLE IF NOT EXISTS free_downloads (patch_id TEXT NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0,
      first_at REAL NOT NULL, last_at REAL NOT NULL, PRIMARY KEY (patch_id, day))`);
    // Item 345: a download token used to be a bearer ticket — one purchase, unlimited redistribution for 24 hours,
    // recorded nowhere. Redemptions are counted per token so the seller can see (and cap) what one sale served.
    add('tokens', { redemptions: 'INTEGER NOT NULL DEFAULT 0', last_used: 'REAL', patch_id: 'TEXT' });
  }

  private closed = false;
  get isClosed() { return this.closed; }
  close() { if (!this.closed) { this.closed = true; this.db.close(); } }

  // kv
  get(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
    return r?.value ?? null;
  }
  set(key: string, value: string) {
    this.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  // drafts
  putDraft(anchor: PatchAnchor, filePath: string) {
    const now = Date.now();
    this.db.prepare(`INSERT INTO drafts (id, anchor, file_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET anchor = excluded.anchor, file_path = excluded.file_path, updated_at = excluded.updated_at`)
      .run(anchor.id, JSON.stringify(anchor), filePath, now, now);
  }
  getDraft(id: string): DraftRow | null {
    const r = this.db.prepare('SELECT * FROM drafts WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? { id: r.id as string, anchor: JSON.parse(r.anchor as string), file_path: r.file_path as string, created_at: r.created_at as number, updated_at: r.updated_at as number } : null;
  }
  listDrafts(): DraftRow[] {
    return (this.db.prepare('SELECT * FROM drafts ORDER BY created_at DESC').all() as Record<string, unknown>[])
      .map((r) => ({ id: r.id as string, anchor: JSON.parse(r.anchor as string), file_path: r.file_path as string, created_at: r.created_at as number, updated_at: r.updated_at as number }));
  }
  deleteDraft(id: string) { this.db.prepare('DELETE FROM drafts WHERE id = ?').run(id); }

  // blobs
  putBlob(b: BlobRow) {
    this.db.prepare(`INSERT INTO blobs (sha256, path, size_bytes, rows, row_dim, imported_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(sha256) DO UPDATE SET path = excluded.path, size_bytes = excluded.size_bytes, rows = excluded.rows, row_dim = excluded.row_dim`)
      .run(b.sha256, b.path, b.size_bytes, b.rows, b.row_dim, b.imported_at);
  }
  getBlob(sha: string): BlobRow | null { return (this.db.prepare('SELECT * FROM blobs WHERE sha256 = ?').get(sha) as BlobRow | undefined) ?? null; }
  listBlobs(): BlobRow[] { return this.db.prepare('SELECT * FROM blobs ORDER BY imported_at DESC').all() as unknown as BlobRow[]; }
  deleteBlob(sha: string) { this.db.prepare('DELETE FROM blobs WHERE sha256 = ?').run(sha); this.db.prepare('DELETE FROM addrsets WHERE sha256 = ?').run(sha); }
  putAddrSet(sha: string, addrs: BigInt64Array) {
    const buf = Buffer.from(addrs.buffer, addrs.byteOffset, addrs.byteLength);
    this.db.prepare('INSERT OR REPLACE INTO addrsets (sha256, addrs) VALUES (?, ?)').run(sha, buf);
  }
  getAddrSet(sha: string): BigInt64Array | null {
    const r = this.db.prepare('SELECT addrs FROM addrsets WHERE sha256 = ?').get(sha) as { addrs: Uint8Array } | undefined;
    if (!r) return null;
    const copy = Buffer.alloc(r.addrs.byteLength); Buffer.from(r.addrs).copy(copy);
    return new BigInt64Array(copy.buffer, copy.byteOffset, copy.byteLength / 8);
  }

  // purchases
  putPurchase(p: PurchaseRow) {
    this.db.prepare(`INSERT INTO purchases (patch_id, sha256, tx_hash, scheme, amount, manifest, path, created_at, origin, royalty) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(patch_id) DO UPDATE SET tx_hash = excluded.tx_hash, manifest = excluded.manifest, path = excluded.path, created_at = excluded.created_at,
        origin = excluded.origin, royalty = COALESCE(excluded.royalty, purchases.royalty)`)
      .run(p.patch_id, p.sha256, p.tx_hash, p.scheme, p.amount, p.manifest ? JSON.stringify(p.manifest) : null, p.path, p.created_at,
        p.origin ?? 'manual', p.royalty ? JSON.stringify(p.royalty) : null);
  }
  getPurchase(id: string): PurchaseRow | null {
    const r = this.db.prepare('SELECT * FROM purchases WHERE patch_id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? this.rowToPurchase(r) : null;
  }
  listPurchases(): PurchaseRow[] {
    return (this.db.prepare('SELECT * FROM purchases ORDER BY created_at DESC').all() as Record<string, unknown>[]).map((r) => this.rowToPurchase(r));
  }
  private rowToPurchase(r: Record<string, unknown>): PurchaseRow {
    return { patch_id: r.patch_id as string, sha256: r.sha256 as string, tx_hash: r.tx_hash as string, scheme: r.scheme as string, amount: r.amount as string,
      manifest: r.manifest ? JSON.parse(r.manifest as string) : null, path: (r.path as string) ?? null, created_at: r.created_at as number,
      origin: (r.origin as string) ?? 'manual', royalty: r.royalty ? JSON.parse(r.royalty as string) : null };
  }

  // licenses — the right to USE a body, kept apart from holding the file (item 327)
  /** Record a licence. `source`: 'author' (this node published it), 'purchase' (settled), 'free' (price 0), 'verification' (scored it — NOT a right to serve). */
  putLicense(patchId: string, sha256: string, source: LicenseSource, detail: string | null = null) {
    // A weaker source never overwrites a stronger one: verifying something you bought must not downgrade the purchase.
    const cur = this.getLicense(patchId);
    if (cur && LICENSE_RANK[cur.source] >= LICENSE_RANK[source]) return;
    this.db.prepare('INSERT OR REPLACE INTO licenses (patch_id, sha256, source, detail, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(patchId, sha256, source, detail, Date.now());
  }
  getLicense(patchId: string): LicenseRow | null { return (this.db.prepare('SELECT * FROM licenses WHERE patch_id = ?').get(patchId) as never) ?? null; }
  listLicenses(): LicenseRow[] { return this.db.prepare('SELECT * FROM licenses ORDER BY created_at DESC').all() as never; }
  clearLicense(patchId: string) { this.db.prepare('DELETE FROM licenses WHERE patch_id = ?').run(patchId); }

  // peers
  private static peerRow(r: Record<string, unknown>): PeerRow {
    return {
      endpoint: r.endpoint as string, address: (r.address as string) ?? null, info: r.info ? JSON.parse(r.info as string) : null,
      last_seen: r.last_seen as number, failures: r.failures as number, cursor: r.cursor as number,
      source: ((r.source as string) === 'learned' ? 'learned' : 'configured'),
      learned_from: (r.learned_from as string) ?? null,
      last_error: (r.last_error as string) ?? null, last_attempt: (r.last_attempt as number) ?? 0,
    };
  }
  /**
   * Add or update a peer. A blocked endpoint is NOT re-added (item 137): `peers rm` used to survive exactly one
   * gossip round, because any third node that still listed the peer taught it back four seconds later. Returns
   * false when the endpoint is blocked and nothing was written.
   */
  upsertPeer(endpoint: string, patch: Partial<PeerRow> = {}): boolean {
    if (this.isPeerBlocked(endpoint)) return false;
    const cur = this.getPeer(endpoint);
    const row: PeerRow = {
      endpoint, address: patch.address ?? cur?.address ?? null, info: patch.info ?? cur?.info ?? null,
      last_seen: patch.last_seen ?? cur?.last_seen ?? 0, failures: patch.failures ?? cur?.failures ?? 0, cursor: patch.cursor ?? cur?.cursor ?? 0,
      // Only the explicit paths (config.json `peers`, `peers add`, `init --peer`) pass 'configured'; anything that
      // arrives on its own — peer exchange, an inbound hello — is learned, and says so in `peers ls` (item 136).
      source: patch.source ?? cur?.source ?? 'learned',
      learned_from: patch.learned_from ?? cur?.learned_from ?? null,
      last_error: patch.last_error !== undefined ? patch.last_error : cur?.last_error ?? null,
      last_attempt: patch.last_attempt ?? cur?.last_attempt ?? 0,
    };
    this.db.prepare(`INSERT INTO peers (endpoint, address, info, last_seen, failures, cursor, source, learned_from, last_error, last_attempt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET address = excluded.address, info = excluded.info, last_seen = excluded.last_seen, failures = excluded.failures, cursor = excluded.cursor,
        source = excluded.source, learned_from = excluded.learned_from, last_error = excluded.last_error, last_attempt = excluded.last_attempt`)
      .run(row.endpoint, row.address, row.info ? JSON.stringify(row.info) : null, row.last_seen, row.failures, row.cursor, row.source, row.learned_from, row.last_error, row.last_attempt);
    return true;
  }
  getPeer(endpoint: string): PeerRow | null {
    const r = this.db.prepare('SELECT * FROM peers WHERE endpoint = ?').get(endpoint) as Record<string, unknown> | undefined;
    return r ? Store.peerRow(r) : null;
  }
  listPeers(): PeerRow[] {
    return (this.db.prepare('SELECT * FROM peers ORDER BY last_seen DESC').all() as Record<string, unknown>[]).map(Store.peerRow);
  }
  /** True when a row was actually deleted — `peers rm` used to report success for a peer that was never there (item 138). */
  deletePeer(endpoint: string): boolean {
    return (this.db.prepare('DELETE FROM peers WHERE endpoint = ?').run(endpoint).changes ?? 0) > 0;
  }
  blockPeer(endpoint: string, reason: string | null = null) {
    this.db.prepare('INSERT INTO peers_blocked (endpoint, blocked_at, reason) VALUES (?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET blocked_at = excluded.blocked_at, reason = excluded.reason')
      .run(endpoint, Date.now(), reason);
  }
  /** True when the endpoint was blocked and now is not — what `peers add` reports. */
  unblockPeer(endpoint: string): boolean {
    return (this.db.prepare('DELETE FROM peers_blocked WHERE endpoint = ?').run(endpoint).changes ?? 0) > 0;
  }
  isPeerBlocked(endpoint: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM peers_blocked WHERE endpoint = ?').get(endpoint);
  }
  listBlockedPeers(): BlockedPeerRow[] {
    return (this.db.prepare('SELECT * FROM peers_blocked ORDER BY blocked_at DESC').all() as Record<string, unknown>[])
      .map((r) => ({ endpoint: r.endpoint as string, blocked_at: r.blocked_at as number, reason: (r.reason as string) ?? null }));
  }

  // events
  event(level: EventRow['level'], kind: string, message: string, patchId: string | null = null, data: unknown = null) {
    if (this.closed) return;
    this.db.prepare('INSERT INTO events (ts, level, kind, patch_id, message, data) VALUES (?, ?, ?, ?, ?, ?)')
      .run(Date.now(), level, kind, patchId, message, data === null ? null : JSON.stringify(data));
  }
  events(opts: { patch_id?: string; since?: number; limit?: number; kind?: string; level?: EventRow['level'] } = {}): EventRow[] {
    const where: string[] = []; const args: (string | number)[] = [];
    if (opts.patch_id) { where.push('patch_id = ?'); args.push(opts.patch_id); }
    if (opts.since) { where.push('ts > ?'); args.push(opts.since); }
    if (opts.kind) { where.push('kind = ?'); args.push(opts.kind); }
    // `level` is a floor, not an exact match: `--level warn` is "warnings and worse", the question an operator asks
    if (opts.level) {
      const wanted = EVENT_LEVELS.slice(EVENT_LEVELS.indexOf(opts.level));
      where.push(`level IN (${wanted.map(() => '?').join(', ')})`);
      args.push(...wanted);
    }
    const sql = `SELECT * FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY seq DESC LIMIT ${Number(opts.limit ?? 200)}`;
    return (this.db.prepare(sql).all(...args) as Record<string, unknown>[]).map((r) => ({
      seq: r.seq as number, ts: r.ts as number, level: r.level as EventRow['level'], kind: r.kind as string, patch_id: (r.patch_id as string) ?? null,
      message: r.message as string, data: r.data ? JSON.parse(r.data as string) : null,
    }));
  }

  // sessions
  putSession(token: string, ttlMs: number) { const now = Date.now(); this.db.prepare('INSERT INTO sessions (token, created_at, expires_at) VALUES (?, ?, ?)').run(token, now, now + ttlMs); }
  hasSession(token: string): boolean {
    const r = this.db.prepare('SELECT expires_at FROM sessions WHERE token = ?').get(token) as { expires_at: number } | undefined;
    return !!r && r.expires_at > Date.now();
  }
  deleteSession(token: string) { this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token); }
  /** Sign every operator session out — what a password change must do, or a stolen cookie outlives it (item 121). */
  deleteAllSessions(): number { return this.db.prepare('DELETE FROM sessions').run().changes as number; }

  // x402 nonces + replay protection
  putNonce(nonce: string, resource: string, amount: string, payTo: string, ttlMs: number) {
    this.db.prepare('INSERT INTO nonces (nonce, resource, amount, pay_to, expires_at) VALUES (?, ?, ?, ?, ?)').run(nonce, resource, amount, payTo, Date.now() + ttlMs);
  }
  /**
   * Read a nonce WITHOUT spending it (item 272): a payment is validated first and the nonce consumed last, so a
   * rejected attempt — wrong amount, bad signature, no credit — leaves the quote usable instead of stranding the
   * buyer with a nonce the seller has already burned. `used` and `expired` are reported, not hidden.
   */
  peekNonce(nonce: string): { resource: string; amount: string; pay_to: string; expires_at: number; used: boolean } | null {
    const r = this.db.prepare('SELECT * FROM nonces WHERE nonce = ?').get(nonce) as { resource: string; amount: string; pay_to: string; expires_at: number; used: number } | undefined;
    return r ? { resource: r.resource, amount: r.amount, pay_to: r.pay_to, expires_at: r.expires_at, used: !!r.used } : null;
  }
  takeNonce(nonce: string): { resource: string; amount: string; pay_to: string } | null {
    const r = this.db.prepare('SELECT * FROM nonces WHERE nonce = ? AND used = 0 AND expires_at > ?').get(nonce, Date.now()) as { resource: string; amount: string; pay_to: string } | undefined;
    if (!r) return null;
    this.db.prepare('UPDATE nonces SET used = 1 WHERE nonce = ?').run(nonce);
    return r;
  }

  // local credit this node has issued (item 364)
  getGrant(address: string): CreditGrantRow | null {
    const r = this.db.prepare('SELECT * FROM credit_grants WHERE address = ?').get(address) as Record<string, unknown> | undefined;
    return r ? { address: r.address as string, amount: r.amount as string, reason: r.reason as string, granted_at: r.granted_at as number } : null;
  }
  /** Write the grant once. Returns the row that is now in force — an address is funded by this node exactly once. */
  putGrant(address: string, amount: string, reason: string): CreditGrantRow {
    this.db.prepare('INSERT OR IGNORE INTO credit_grants (address, amount, reason, granted_at) VALUES (?, ?, ?, ?)').run(address, amount, reason, Date.now());
    return this.getGrant(address)!;
  }
  listGrants(limit = 500): CreditGrantRow[] {
    return (this.db.prepare('SELECT * FROM credit_grants ORDER BY granted_at DESC LIMIT ?').all(limit) as Record<string, unknown>[])
      .map((r) => ({ address: r.address as string, amount: r.amount as string, reason: r.reason as string, granted_at: r.granted_at as number }));
  }
  /** How much credit this node has issued in total, and to how many addresses — the cap is checked against this. */
  grantTotals(): { addresses: number; amount: number } {
    const r = this.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(CAST(amount AS REAL)), 0) AS s FROM credit_grants').get() as { n: number; s: number };
    return { addresses: Number(r.n ?? 0), amount: Math.round(Number(r.s ?? 0) * 1e6) / 1e6 };
  }

  // x402 payments this node is making (item 274) — written before the money moves
  putPending(row: Omit<PendingPaymentRow, 'id' | 'created_at' | 'updated_at'>): PendingPaymentRow {
    const now = Date.now();
    const r = this.db.prepare(`INSERT INTO pending_payments (patch_id, gateway, resource, scheme, pay_to, amount, currency, nonce, tx_hash, payload, status, error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`)
      .get(row.patch_id, row.gateway, row.resource, row.scheme, row.pay_to, row.amount, row.currency, row.nonce, row.tx_hash, row.payload, row.status, row.error, now, now) as Record<string, unknown>;
    return Store.toPending(r);
  }
  updatePending(id: number, patch: Partial<Pick<PendingPaymentRow, 'tx_hash' | 'payload' | 'status' | 'error'>>) {
    const cur = this.db.prepare('SELECT * FROM pending_payments WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!cur) return;
    const row = { ...Store.toPending(cur), ...patch };
    this.db.prepare('UPDATE pending_payments SET tx_hash = ?, payload = ?, status = ?, error = ?, updated_at = ? WHERE id = ?')
      .run(row.tx_hash, row.payload, row.status, row.error, Date.now(), id);
  }
  /** Payments that left this node and were never answered with a manifest, newest first. */
  listPending(opts: { patch_id?: string; status?: string[]; limit?: number } = {}): PendingPaymentRow[] {
    const where: string[] = []; const args: (string | number)[] = [];
    if (opts.patch_id) { where.push('patch_id = ?'); args.push(opts.patch_id); }
    const status = opts.status ?? ['quoted', 'paid'];
    where.push(`status IN (${status.map(() => '?').join(', ')})`); args.push(...status);
    return (this.db.prepare(`SELECT * FROM pending_payments ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ${Number(opts.limit ?? 100)}`).all(...args) as Record<string, unknown>[])
      .map(Store.toPending);
  }
  private static toPending(r: Record<string, unknown>): PendingPaymentRow {
    return {
      id: r.id as number, patch_id: r.patch_id as string, gateway: r.gateway as string, resource: r.resource as string,
      scheme: r.scheme as string, pay_to: r.pay_to as string, amount: r.amount as string, currency: r.currency as string,
      nonce: r.nonce as string, tx_hash: (r.tx_hash as string) ?? null, payload: (r.payload as string) ?? null,
      status: r.status as PendingPaymentRow['status'], error: (r.error as string) ?? null,
      created_at: r.created_at as number, updated_at: r.updated_at as number,
    };
  }
  paymentSeen(txHash: string): boolean { return !!this.db.prepare('SELECT 1 FROM payments_seen WHERE tx_hash = ?').get(txHash); }
  markPayment(txHash: string, patchId: string) { this.db.prepare('INSERT OR IGNORE INTO payments_seen (tx_hash, patch_id, ts) VALUES (?, ?, ?)').run(txHash, patchId, Date.now()); }

  // held part-payments (item 279): AIN that arrived for a knowledge but did not cover its price
  putPartialPayment(p: { tx_hash: string; patch_id: string; payer: string; amount: string; currency: string; nonce?: string | null; resource?: string | null; transfer_key?: string | null }): void {
    this.db.prepare(`INSERT OR IGNORE INTO partial_payments (tx_hash, patch_id, payer, amount, currency, nonce, resource, transfer_key, consumed_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`)
      .run(p.tx_hash, p.patch_id, p.payer.toLowerCase(), p.amount, p.currency, p.nonce ?? null, p.resource ?? null, p.transfer_key ?? null, Date.now());
  }
  /** What this payer has already transferred for this knowledge and not yet spent. */
  partialPayments(patchId: string, payer: string): PartialPaymentRow[] {
    return (this.db.prepare('SELECT * FROM partial_payments WHERE patch_id = ? AND payer = ? AND consumed_by IS NULL ORDER BY created_at').all(patchId, payer.toLowerCase()) as Record<string, unknown>[])
      .map((r) => ({ tx_hash: r.tx_hash as string, patch_id: r.patch_id as string, payer: r.payer as string, amount: r.amount as string, currency: r.currency as string,
        nonce: (r.nonce as string) ?? null, resource: (r.resource as string) ?? null, transfer_key: (r.transfer_key as string) ?? null,
        consumed_by: (r.consumed_by as string) ?? null, created_at: r.created_at as number }));
  }
  /** Mark held part-payments as spent by the settlement that finally covered the price. */
  consumePartials(txHashes: string[], settleTx: string): void {
    const stmt = this.db.prepare('UPDATE partial_payments SET consumed_by = ? WHERE tx_hash = ? AND consumed_by IS NULL');
    for (const h of txHashes) stmt.run(settleTx, h);
  }
  /** Everything this node is holding for somebody, newest first — what the operator owes an explanation for. */
  heldPartials(limit = 200): PartialPaymentRow[] {
    return (this.db.prepare('SELECT * FROM partial_payments WHERE consumed_by IS NULL ORDER BY created_at DESC LIMIT ?').all(limit) as Record<string, unknown>[])
      .map((r) => ({ tx_hash: r.tx_hash as string, patch_id: r.patch_id as string, payer: r.payer as string, amount: r.amount as string, currency: r.currency as string,
        nonce: (r.nonce as string) ?? null, resource: (r.resource as string) ?? null, transfer_key: (r.transfer_key as string) ?? null,
        consumed_by: null, created_at: r.created_at as number }));
  }

  // download tokens
  putToken(token: string, sha: string, issuedTo: string, ttlMs: number, patchId: string | null = null) {
    this.db.prepare('INSERT OR REPLACE INTO tokens (token, sha256, issued_to, expires_at, redemptions, last_used, patch_id) VALUES (?, ?, ?, ?, 0, NULL, ?)')
      .run(token, sha, issuedTo, Date.now() + ttlMs, patchId);
  }
  checkToken(token: string, sha: string): boolean {
    const r = this.db.prepare('SELECT expires_at FROM tokens WHERE token = ? AND sha256 = ?').get(token, sha) as { expires_at: number } | undefined;
    return !!r && r.expires_at > Date.now();
  }
  /** The live token row — `issued_to` is who the manifest was handed to, and what item 345 checks the fetcher against. */
  getToken(token: string, sha: string): TokenRow | null {
    const r = this.db.prepare('SELECT * FROM tokens WHERE token = ? AND sha256 = ?').get(token, sha) as Record<string, unknown> | undefined;
    if (!r || Number(r.expires_at) <= Date.now()) return null;
    return { token: r.token as string, sha256: r.sha256 as string, issued_to: r.issued_to as string, expires_at: r.expires_at as number,
      redemptions: Number(r.redemptions ?? 0), last_used: (r.last_used as number) ?? null, patch_id: (r.patch_id as string) ?? null };
  }
  /** Count one redemption of a token and return the new count (item 345). */
  useToken(token: string, sha: string): number {
    this.db.prepare('UPDATE tokens SET redemptions = redemptions + 1, last_used = ? WHERE token = ? AND sha256 = ?').run(Date.now(), token, sha);
    return this.getToken(token, sha)?.redemptions ?? 0;
  }

  // free hand-overs (item 277): a knowledge priced 0 writes no settlement, so this is the only count of it
  bumpFreeDownload(patchId: string, day = new Date().toISOString().slice(0, 10)): number {
    const now = Date.now();
    this.db.prepare(`INSERT INTO free_downloads (patch_id, day, count, first_at, last_at) VALUES (?, ?, 1, ?, ?)
      ON CONFLICT(patch_id, day) DO UPDATE SET count = count + 1, last_at = excluded.last_at`).run(patchId, day, now, now);
    return Number((this.db.prepare('SELECT SUM(count) AS n FROM free_downloads WHERE patch_id = ?').get(patchId) as { n: number } | undefined)?.n ?? 0);
  }
  freeDownloads(patchId?: string): { patch_id: string; count: number; last_at: number }[] {
    const sql = 'SELECT patch_id, SUM(count) AS count, MAX(last_at) AS last_at FROM free_downloads'
      + (patchId ? ' WHERE patch_id = ?' : '') + ' GROUP BY patch_id ORDER BY count DESC';
    const rows = (patchId ? this.db.prepare(sql).all(patchId) : this.db.prepare(sql).all()) as Record<string, unknown>[];
    return rows.map((r) => ({ patch_id: r.patch_id as string, count: Number(r.count ?? 0), last_at: Number(r.last_at ?? 0) }));
  }

  // ------------------------------------------------------------ teach mode (spec §7.5)
  private rowToTeachJob(r: Record<string, unknown>): TeachJobRow {
    const j = (v: unknown) => (typeof v === 'string' && v ? JSON.parse(v) : null);
    return {
      id: r.id as string, contributor: r.contributor as string, contributor_name: (r.contributor_name as string) ?? null, ip: (r.ip as string) ?? null, status: r.status as string,
      context: j(r.context) ?? [], builds_on: !!r.builds_on, facts: j(r.facts) ?? [], job_dir: (r.job_dir as string) ?? null, npz_path: (r.npz_path as string) ?? null, sha256: (r.sha256 as string) ?? null,
      progress: j(r.progress), checks: j(r.checks), error: (r.error as string) ?? null, container_pid: (r.container_pid as number) ?? null,
      draft_id: (r.draft_id as string) ?? null, patch_id: (r.patch_id as string) ?? null, publish_status: (r.publish_status as string) ?? 'none', reject_reason: (r.reject_reason as string) ?? null,
      parent_job: (r.parent_job as string) ?? null, result: j(r.result), blocked: (r.blocked as string) ?? null, name: (r.name as string) ?? null,
      dataset_id: (r.dataset_id as string) ?? null, dataset_sha256: (r.dataset_sha256 as string) ?? null,
      dataset_rows: (r.dataset_rows as number) ?? null, dataset_source: (r.dataset_source as string) ?? null,
      training: j(r.training), preflight: j(r.preflight),
      created_at: r.created_at as number, started_at: (r.started_at as number) ?? null, finished_at: (r.finished_at as number) ?? null, updated_at: r.updated_at as number,
      expires_at: (r.expires_at as number) ?? null, cancel_requested: !!r.cancel_requested, lesson_applied: !!r.lesson_applied,
      bases: j(r.bases), mode: (r.mode as TeachJobRow['mode']) ?? null, export_mode: (r.export_mode as TeachJobRow['export_mode']) ?? null, merge: j(r.merge),
      derivation: j(r.derivation), parent_check: j(r.parent_check),
      reversibility_ok: r.reversibility_ok === null || r.reversibility_ok === undefined ? null : !!r.reversibility_ok,
      snapshot_sha256: (r.snapshot_sha256 as string) ?? null, dataset_pub: j(r.dataset_pub),
    };
  }
  insertTeachJob(j: Omit<TeachJobRow, 'updated_at' | 'lesson_applied' | 'bases' | 'mode' | 'export_mode' | 'merge' | 'derivation' | 'parent_check' | 'reversibility_ok' | 'snapshot_sha256' | 'dataset_pub'>
    & Partial<Pick<TeachJobRow, 'bases' | 'mode' | 'export_mode' | 'merge' | 'derivation' | 'parent_check' | 'reversibility_ok' | 'snapshot_sha256' | 'dataset_pub'>>) {
    this.db.prepare(`INSERT INTO teach_jobs (id, contributor, contributor_name, ip, status, context, builds_on, facts, job_dir, npz_path, sha256, progress, checks, error, container_pid,
      draft_id, patch_id, publish_status, reject_reason, parent_job, result, blocked, name, created_at, started_at, finished_at, updated_at, expires_at, cancel_requested,
      dataset_id, dataset_sha256, dataset_rows, dataset_source, training, preflight, bases, mode, export_mode, snapshot_sha256, merge)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(j.id, j.contributor, j.contributor_name, j.ip, j.status, JSON.stringify(j.context), j.builds_on ? 1 : 0, JSON.stringify(j.facts), j.job_dir, j.npz_path, j.sha256,
        j.progress ? JSON.stringify(j.progress) : null, j.checks ? JSON.stringify(j.checks) : null, j.error, j.container_pid, j.draft_id, j.patch_id, j.publish_status, j.reject_reason,
        j.parent_job, j.result ? JSON.stringify(j.result) : null, j.blocked, j.name, j.created_at, j.started_at, j.finished_at, Date.now(), j.expires_at, j.cancel_requested ? 1 : 0,
        j.dataset_id ?? null, j.dataset_sha256 ?? null, j.dataset_rows ?? null, j.dataset_source ?? null,
        j.training ? JSON.stringify(j.training) : null, j.preflight ? JSON.stringify(j.preflight) : null,
        j.bases ? JSON.stringify(j.bases) : null, j.mode ?? null, j.export_mode ?? null, j.snapshot_sha256 ?? null, j.merge ? JSON.stringify(j.merge) : null);
  }
  /** Partial update; JSON columns are re-encoded, `updated_at` is always bumped. */
  updateTeachJob(id: string, patch: Partial<Omit<TeachJobRow, 'id' | 'updated_at'>>) {
    const cols: string[] = []; const args: (string | number | null)[] = [];
    const enc = (k: string, v: unknown): string | number | null => {
      if (v === undefined || v === null) return null;
      if (['context', 'facts', 'progress', 'checks', 'result', 'training', 'preflight', 'bases', 'merge', 'derivation', 'parent_check', 'dataset_pub'].includes(k)) return JSON.stringify(v);
      if (typeof v === 'boolean') return v ? 1 : 0;
      return v as string | number;
    };
    for (const [k, v] of Object.entries(patch)) { cols.push(`${k} = ?`); args.push(enc(k, v)); }
    cols.push('updated_at = ?'); args.push(Date.now());
    args.push(id);
    this.db.prepare(`UPDATE teach_jobs SET ${cols.join(', ')} WHERE id = ?`).run(...args);
  }
  getTeachJob(id: string): TeachJobRow | null {
    const r = this.db.prepare('SELECT * FROM teach_jobs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? this.rowToTeachJob(r) : null;
  }
  /**
   * `order` is what keeps a capped list honest: the default LIMIT is 500, and a node that has run more lessons than
   * that must still be able to list the NEWEST ones (the operator's review queue is the newest end of the table).
   * An ASC scan with a LIMIT silently hides everything after the 500th oldest row.
   */
  listTeachJobs(opts: { contributor?: string; status?: string[]; draft_id?: string; dataset_id?: string; limit?: number; order?: 'asc' | 'desc'; lessonApplied?: boolean } = {}): TeachJobRow[] {
    const where: string[] = []; const args: (string | number)[] = [];
    if (opts.contributor) { where.push('lower(contributor) = ?'); args.push(opts.contributor.toLowerCase()); }
    if (opts.status?.length) { where.push(`status IN (${opts.status.map(() => '?').join(',')})`); args.push(...opts.status); }
    if (opts.draft_id) { where.push('draft_id = ?'); args.push(opts.draft_id); }
    if (opts.dataset_id) { where.push('dataset_id = ?'); args.push(opts.dataset_id); }
    // the boot-time "is a lesson still on the shared table?" scan: filtered in SQL, so the LIMIT can never hide one
    if (opts.lessonApplied !== undefined) { where.push('lesson_applied = ?'); args.push(opts.lessonApplied ? 1 : 0); }
    const sql = `SELECT * FROM teach_jobs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at ${opts.order === 'desc' ? 'DESC' : 'ASC'} LIMIT ${Number(opts.limit ?? 500)}`;
    return (this.db.prepare(sql).all(...args) as Record<string, unknown>[]).map((r) => this.rowToTeachJob(r));
  }
  deleteTeachJob(id: string) { this.db.prepare('DELETE FROM teach_jobs WHERE id = ?').run(id); }

  teachQuotaCount(key: string, day: string): number {
    const r = this.db.prepare('SELECT count FROM teach_quota WHERE key = ? AND day = ?').get(key, day) as { count: number } | undefined;
    return r?.count ?? 0;
  }
  /** `n` defaults to 1 so every v1 call site is unchanged; rows/bytes quotas bump by the amount actually spent. */
  teachQuotaBump(key: string, day: string, n = 1) {
    this.db.prepare('INSERT INTO teach_quota (key, day, count) VALUES (?, ?, ?) ON CONFLICT(key, day) DO UPDATE SET count = count + ?').run(key, day, n, n);
  }

  putTeachStat(s: { job_id: string; load_s: number | null; steps: number | null; step_s: number | null; total_s: number | null; rows: number | null; backend?: string | null; rows_trained?: number | null; sentences?: number | null }) {
    this.db.prepare('INSERT OR REPLACE INTO teach_stats (job_id, load_s, steps, step_s, total_s, rows, backend, rows_trained, sentences, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(s.job_id, s.load_s, s.steps, s.step_s, s.total_s, s.rows, s.backend ?? null, s.rows_trained ?? null, s.sentences ?? null, Date.now());
  }
  /**
   * Measured lessons, newest first. `backend` filters what a visitor may be shown (design §D7): rows written before the
   * migration have `backend IS NULL` and are treated as 'gradient' — a stub node has no legitimate gradient history, so
   * asking for 'gradient' there returns nothing rather than three-second jobs dressed up as training.
   */
  teachStats(limit = 50, backend: 'gradient' | 'stub' | 'any' = 'gradient'): { total_s: number; load_s: number | null; steps: number | null; rows_trained: number | null; sentences: number | null }[] {
    const where = backend === 'any' ? '' : backend === 'gradient' ? "AND (backend = 'gradient' OR backend IS NULL)" : "AND backend = 'stub'";
    return this.db.prepare(`SELECT total_s, load_s, steps, rows_trained, sentences FROM teach_stats WHERE total_s IS NOT NULL ${where} ORDER BY ts DESC LIMIT ?`).all(limit) as { total_s: number; load_s: number | null; steps: number | null; rows_trained: number | null; sentences: number | null }[];
  }

  // ------------------------------------------------------------ teach datasets (teach mode v2)
  private rowToTeachDataset(r: Record<string, unknown>): TeachDatasetRecord {
    const j = (v: unknown) => (typeof v === 'string' && v ? JSON.parse(v) : null);
    return {
      id: r.id as string, owner: r.owner as string, ip: (r.ip as string) ?? null, name: (r.name as string) ?? '',
      status: r.status as TeachDatasetStatus, source: r.source as TeachDatasetSource,
      format: (r.format as string) ?? null, encoding: (r.encoding as string) ?? null, layout: (r.layout as string) ?? null, delimiter: (r.delimiter as string) ?? null,
      has_header: r.has_header === null || r.has_header === undefined ? null : !!r.has_header, columns: j(r.columns),
      sha256: r.sha256 as string, revision: r.revision as number, rows: r.rows as number, invalid_rows: (r.invalid_rows as number) ?? 0, size_bytes: (r.size_bytes as number) ?? 0,
      source_bytes: (r.source_bytes as number) ?? null, source_name: (r.source_name as string) ?? null, source_sha256: (r.source_sha256 as string) ?? null,
      dir: r.dir as string, summary: j(r.summary), parent_dataset: (r.parent_dataset as string) ?? null,
      parent_patch: (r.parent_patch as string) ?? null, parent_dataset_sha: (r.parent_dataset_sha as string) ?? null,
      inherited_rows: (r.inherited_rows as number) ?? null,
      retention: ((r.retention as string) ?? 'keep') as 'keep' | 'delete_after_training',
      created_at: r.created_at as number, updated_at: r.updated_at as number, expires_at: (r.expires_at as number) ?? null, deleted_at: (r.deleted_at as number) ?? null,
    };
  }
  insertTeachDataset(d: Omit<TeachDatasetRecord, 'updated_at'> & { updated_at?: number }) {
    this.db.prepare(`INSERT INTO teach_datasets (id, owner, ip, name, status, source, format, encoding, layout, delimiter, has_header, columns, sha256, revision, rows, invalid_rows,
      size_bytes, source_bytes, source_name, source_sha256, dir, summary, parent_dataset, parent_patch, parent_dataset_sha, inherited_rows,
      retention, created_at, updated_at, expires_at, deleted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(d.id, d.owner, d.ip, d.name, d.status, d.source, d.format, d.encoding, d.layout, d.delimiter,
        d.has_header === null ? null : d.has_header ? 1 : 0, d.columns ? JSON.stringify(d.columns) : null,
        d.sha256, d.revision, d.rows, d.invalid_rows, d.size_bytes, d.source_bytes, d.source_name, d.source_sha256,
        d.dir, d.summary ? JSON.stringify(d.summary) : null, d.parent_dataset, d.parent_patch ?? null, d.parent_dataset_sha ?? null, d.inherited_rows ?? null,
        d.retention, d.created_at, d.updated_at ?? Date.now(), d.expires_at, d.deleted_at);
  }
  updateTeachDataset(id: string, patch: Partial<Omit<TeachDatasetRecord, 'id' | 'updated_at'>>) {
    const cols: string[] = []; const args: (string | number | null)[] = [];
    for (const [k, v] of Object.entries(patch)) {
      cols.push(`${k} = ?`);
      args.push(v === undefined || v === null ? null : ['columns', 'summary'].includes(k) ? JSON.stringify(v) : typeof v === 'boolean' ? (v ? 1 : 0) : (v as string | number));
    }
    if (!cols.length) return;
    cols.push('updated_at = ?'); args.push(Date.now());
    args.push(id);
    this.db.prepare(`UPDATE teach_datasets SET ${cols.join(', ')} WHERE id = ?`).run(...args);
  }
  getTeachDataset(id: string): TeachDatasetRecord | null {
    const r = this.db.prepare('SELECT * FROM teach_datasets WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? this.rowToTeachDataset(r) : null;
  }
  listTeachDatasets(opts: { owner?: string; status?: string[]; includeDeleted?: boolean; limit?: number } = {}): TeachDatasetRecord[] {
    const where: string[] = []; const args: (string | number)[] = [];
    if (opts.owner) { where.push('lower(owner) = ?'); args.push(opts.owner.toLowerCase()); }
    if (opts.status?.length) { where.push(`status IN (${opts.status.map(() => '?').join(',')})`); args.push(...opts.status); }
    else if (!opts.includeDeleted) where.push("status != 'deleted'");
    const sql = `SELECT * FROM teach_datasets ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ${Number(opts.limit ?? 500)}`;
    return (this.db.prepare(sql).all(...args) as Record<string, unknown>[]).map((r) => this.rowToTeachDataset(r));
  }
  /** Owner-scoped dedup (design §D3): re-uploading identical bytes returns the caller's OWN dataset, never a stranger's. */
  findTeachDatasetBySha(owner: string, sha256: string): TeachDatasetRecord | null {
    const r = this.db.prepare("SELECT * FROM teach_datasets WHERE lower(owner) = ? AND sha256 = ? AND status != 'deleted' ORDER BY revision DESC LIMIT 1").get(owner.toLowerCase(), sha256) as Record<string, unknown> | undefined;
    return r ? this.rowToTeachDataset(r) : null;
  }
  /** Tombstone: the files are removed by the caller, the row stays so a lesson can say "the dataset was deleted by its owner". */
  deleteTeachDataset(id: string, now = Date.now()) {
    this.db.prepare("UPDATE teach_datasets SET status = 'deleted', deleted_at = ?, updated_at = ? WHERE id = ?").run(now, now, id);
  }
  countTeachDatasets(owner: string): number {
    const r = this.db.prepare("SELECT COUNT(*) AS n FROM teach_datasets WHERE lower(owner) = ? AND status != 'deleted'").get(owner.toLowerCase()) as { n: number } | undefined;
    return r?.n ?? 0;
  }

  private rowToContributor(r: Record<string, unknown>): ContributorRow {
    return { address: r.address as string, name: (r.name as string) ?? null, payout_address: (r.payout_address as string) ?? null, first_seen: r.first_seen as number, last_seen: r.last_seen as number,
      jobs: r.jobs as number, published: r.published as number, hidden: !!r.hidden, note: (r.note as string) ?? null };
  }
  touchContributor(address: string, patch: { name?: string | null; payout_address?: string | null; job?: boolean; published?: boolean } = {}) {
    const now = Date.now();
    const cur = this.getContributor(address);
    if (!cur) {
      this.db.prepare('INSERT INTO contributors (address, name, payout_address, first_seen, last_seen, jobs, published, hidden, note) VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL)')
        .run(address, patch.name ?? null, patch.payout_address ?? null, now, now, patch.job ? 1 : 0, patch.published ? 1 : 0);
      return;
    }
    this.db.prepare('UPDATE contributors SET name = ?, payout_address = ?, last_seen = ?, jobs = jobs + ?, published = published + ? WHERE address = ?')
      .run(patch.name === undefined ? cur.name : patch.name, patch.payout_address === undefined ? cur.payout_address : patch.payout_address, now, patch.job ? 1 : 0, patch.published ? 1 : 0, address);
  }
  setContributorHidden(address: string, hidden: boolean) { this.db.prepare('UPDATE contributors SET hidden = ? WHERE address = ?').run(hidden ? 1 : 0, address); }
  getContributor(address: string): ContributorRow | null {
    const r = this.db.prepare('SELECT * FROM contributors WHERE lower(address) = ?').get(address.toLowerCase()) as Record<string, unknown> | undefined;
    return r ? this.rowToContributor(r) : null;
  }
  listContributors(): ContributorRow[] {
    return (this.db.prepare('SELECT * FROM contributors ORDER BY last_seen DESC').all() as Record<string, unknown>[]).map((r) => this.rowToContributor(r));
  }

  addBan(kind: 'address' | 'ip', value: string, reason: string | null): BanRow {
    const r = this.db.prepare('INSERT INTO bans (kind, value, reason, ts) VALUES (?, ?, ?, ?) RETURNING *').get(kind, value, reason, Date.now()) as Record<string, unknown>;
    return { id: r.id as number, kind: r.kind as 'address' | 'ip', value: r.value as string, reason: (r.reason as string) ?? null, ts: r.ts as number };
  }
  deleteBan(id: number) { this.db.prepare('DELETE FROM bans WHERE id = ?').run(id); }
  listBans(): BanRow[] { return this.db.prepare('SELECT * FROM bans ORDER BY ts DESC').all() as unknown as BanRow[]; }
  isBanned(kind: 'address' | 'ip', value: string): BanRow | null {
    const r = this.db.prepare('SELECT * FROM bans WHERE kind = ? AND lower(value) = ? LIMIT 1').get(kind, value.toLowerCase()) as BanRow | undefined;
    return r ?? null;
  }

  // payouts — one row per (settle record, royalty address); the node-side receipt of every AIN transfer attempt (spec §7.5 / §9.3)
  private rowToPayout(r: Record<string, unknown>): PayoutRow {
    return { id: r.id as number, patch_id: r.patch_id as string, settle_hash: r.settle_hash as string, address: r.address as string, amount: r.amount as string, currency: r.currency as string,
      status: r.status as PayoutRow['status'], tx_hash: (r.tx_hash as string) ?? null, attempts: Number(r.attempts ?? 0), last_error: (r.last_error as string) ?? null,
      transfer_key: (r.transfer_key as string) ?? null, recorded: !!r.recorded,
      created_at: r.created_at as number, updated_at: r.updated_at as number };
  }
  /** Written BEFORE the transfer is attempted, status `pending`, attempts 0. */
  insertPayout(p: { patch_id: string; settle_hash: string; address: string; amount: string; currency: string }): PayoutRow {
    const now = Date.now();
    const r = this.db.prepare('INSERT INTO payouts (patch_id, settle_hash, address, amount, currency, status, tx_hash, attempts, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, 0, NULL, ?, ?) RETURNING *')
      .get(p.patch_id, p.settle_hash, p.address, p.amount, p.currency, 'pending', now, now) as Record<string, unknown>;
    return this.rowToPayout(r);
  }
  getPayout(id: number): PayoutRow | null {
    const r = this.db.prepare('SELECT * FROM payouts WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? this.rowToPayout(r) : null;
  }
  /** The row for one (settle record, address) pair — used to keep enqueue idempotent across restarts. */
  findPayout(settleHash: string, address: string): PayoutRow | null {
    const r = this.db.prepare('SELECT * FROM payouts WHERE settle_hash = ? AND lower(address) = ?').get(settleHash, address.toLowerCase()) as Record<string, unknown> | undefined;
    return r ? this.rowToPayout(r) : null;
  }
  /**
   * Atomically claim a row for one transfer attempt: pending|failed → paying, attempts + 1. Returns false when another
   * attempt already holds it (or it is paid) — the caller must then NOT transfer. This is the double-payment guard.
   */
  claimPayout(id: number): boolean {
    const r = this.db.prepare("UPDATE payouts SET status = 'paying', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status IN ('pending', 'failed')").run(Date.now(), id);
    return Number(r.changes) === 1;
  }
  updatePayout(id: number, patch: Partial<Pick<PayoutRow, 'status' | 'tx_hash' | 'attempts' | 'last_error' | 'transfer_key' | 'recorded'>>): PayoutRow {
    const cur = this.getPayout(id);
    if (!cur) throw new Error(`payout ${id} not found`);
    const next = { ...cur, ...patch, updated_at: Date.now() };
    this.db.prepare('UPDATE payouts SET status = ?, tx_hash = ?, attempts = ?, last_error = ?, transfer_key = ?, recorded = ?, updated_at = ? WHERE id = ?')
      .run(next.status, next.tx_hash, next.attempts, next.last_error, next.transfer_key ?? null, next.recorded ? 1 : 0, next.updated_at, id);
    return next;
  }
  /** Payout attempts; `status` filters, `address` matches case-insensitively, newest first. */
  listPayouts(opts: { address?: string; status?: string | string[]; limit?: number } = {}): PayoutRow[] {
    const where: string[] = []; const args: (string | number)[] = [];
    if (opts.address) { where.push('lower(address) = ?'); args.push(opts.address.toLowerCase()); }
    if (opts.status) { const st = Array.isArray(opts.status) ? opts.status : [opts.status]; where.push(`status IN (${st.map(() => '?').join(',')})`); args.push(...st); }
    const rows = this.db.prepare(`SELECT * FROM payouts ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC, id DESC LIMIT ?`).all(...args, Math.min(Math.max(1, Number(opts.limit ?? 1000)), 5000)) as Record<string, unknown>[];
    return rows.map((r) => this.rowToPayout(r));
  }
  /** Counts by state; an in-flight `paying` row is still owed and is counted under `pending`. */
  payoutSummary(): { pending: number; failed: number; paid: number } {
    const out = { pending: 0, failed: 0, paid: 0 };
    for (const r of this.db.prepare('SELECT status, COUNT(*) AS n FROM payouts GROUP BY status').all() as { status: string; n: number }[]) {
      const k = r.status === 'paying' ? 'pending' : r.status;
      if (k in out) out[k as keyof typeof out] += Number(r.n);
    }
    return out;
  }

  deleteTokensFor(sha: string) { this.db.prepare('DELETE FROM tokens WHERE sha256 = ?').run(sha); }

  // ------------------------------------------------------------ demand / quality signals (lineage design §5.6, §10)
  /**
   * Node-local counters, materialised at write time per (patch, UTC day) — what the "doing well" strip and the "what to
   * add on top of this" panel read. Unique visitors are a HyperLogLog sketch over HMAC visitor ids, so the table holds
   * counts and never an address.
   */
  bumpSignals(patchId: string, counters: Partial<Record<SignalCounter, number>>, opts: { visitor?: string | null; day?: string } = {}) {
    const day = opts.day ?? new Date().toISOString().slice(0, 10);
    const cols = (Object.entries(counters) as [SignalCounter, number][]).filter(([k, v]) => SIGNAL_COUNTERS.includes(k) && Number.isFinite(v) && v !== 0);
    let hll: Buffer | null = null;
    if (opts.visitor) {
      const cur = this.db.prepare('SELECT visitors_hll FROM patch_signals_daily WHERE patch_id = ? AND day = ?').get(patchId, day) as { visitors_hll: Uint8Array | null } | undefined;
      hll = hllAdd(cur?.visitors_hll ? Buffer.from(cur.visitors_hll) : null, opts.visitor);
    }
    if (!cols.length && !hll) return;
    this.db.prepare(`INSERT INTO patch_signals_daily (patch_id, day, ${cols.map(([k]) => k).join(', ')}${cols.length ? ', ' : ''}visitors_hll) VALUES (?, ?, ${cols.map(() => '?').join(', ')}${cols.length ? ', ' : ''}?)
      ON CONFLICT(patch_id, day) DO UPDATE SET ${[...cols.map(([k]) => `${k} = ${k} + excluded.${k}`), 'visitors_hll = COALESCE(excluded.visitors_hll, visitors_hll)'].join(', ')}`)
      .run(patchId, day, ...cols.map(([, v]) => v), hll);
  }
  /** Summed counters over the last `days` UTC days (default 30) plus the estimated unique visitors. */
  signals(patchId: string, days = 30): SignalSummary {
    const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    const rows = this.db.prepare('SELECT * FROM patch_signals_daily WHERE patch_id = ? AND day >= ? ORDER BY day').all(patchId, since) as Record<string, unknown>[];
    const out = { window_days: days, days: rows.length, visitors: 0 } as SignalSummary;
    for (const k of SIGNAL_COUNTERS) out[k] = 0;
    let merged: Buffer | null = null;
    for (const r of rows) {
      for (const k of SIGNAL_COUNTERS) out[k] += Number(r[k] ?? 0);
      if (r.visitors_hll) merged = hllMerge(merged, Buffer.from(r.visitors_hll as Uint8Array));
    }
    out.visitors = merged ? hllCount(merged) : 0;
    return out;
  }
  // ------------------------------------------------------------ open questions (`patch_issues`, design §5.6, §10, SC-12)
  /**
   * Record (or re-count) one open question about a knowledge. Two reports of the same question meet on `clusterKey`,
   * which is a keyed HMAC of the normalised prompt (F13's rule) — so `asked {c} times` is countable without the node
   * ever storing what was asked. `text` is written only when the reporter consented; once shared it stays shared, and
   * a later count-only report never erases it. `people` is estimated from a HyperLogLog over visitor ids, so one
   * person pressing the button ten times is still one person.
   */
  bumpIssue(patchId: string, kind: IssueKind, clusterKey: string, opts: { text?: string | null; sample_index?: number | null; topic?: string | null; visitor?: string | null; count?: number; ts?: number } = {}): IssueRow {
    const id = `${patchId}:${kind}:${clusterKey}`;
    const now = opts.ts ?? Date.now();
    const cur = this.db.prepare('SELECT * FROM patch_issues WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    const sketch = opts.visitor ? hllAdd(cur?.people_hll ? Buffer.from(cur.people_hll as Uint8Array) : null, opts.visitor) : (cur?.people_hll ? Buffer.from(cur.people_hll as Uint8Array) : null);
    const people = sketch ? hllCount(sketch) : Number(cur?.people ?? 0);
    const n = Math.max(1, Math.trunc(opts.count ?? 1));
    if (!cur) {
      this.db.prepare(`INSERT INTO patch_issues (id, patch_id, kind, cluster_key, count, people, people_hll, text, sample_index, topic, first_seen, last_seen, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`)
        .run(id, patchId, kind, clusterKey, n, people, sketch, opts.text ?? null, opts.sample_index ?? null, opts.topic ?? null, now, now);
    } else {
      this.db.prepare(`UPDATE patch_issues SET count = count + ?, people = ?, people_hll = ?, text = COALESCE(?, text),
        sample_index = COALESCE(?, sample_index), topic = COALESCE(?, topic), last_seen = ? WHERE id = ?`)
        .run(n, people, sketch, opts.text ?? null, opts.sample_index ?? null, opts.topic ?? null, now, id);
    }
    return this.getIssue(id)!;
  }
  getIssue(id: string): IssueRow | null {
    const r = this.db.prepare('SELECT id, patch_id, kind, cluster_key, count, people, text, sample_index, topic, first_seen, last_seen, status FROM patch_issues WHERE id = ?').get(id) as IssueRow | undefined;
    return r ?? null;
  }
  listIssues(patchId: string, opts: { kind?: IssueKind; status?: 'open' | 'covered' | 'all'; limit?: number } = {}): IssueRow[] {
    const where = ['patch_id = ?'];
    const args: unknown[] = [patchId];
    if (opts.kind) { where.push('kind = ?'); args.push(opts.kind); }
    if (!opts.status || opts.status === 'open') where.push("status = 'open'");
    else if (opts.status === 'covered') where.push("status <> 'open'");
    args.push(Math.min(500, Math.max(1, opts.limit ?? 100)));
    return this.db.prepare(`SELECT id, patch_id, kind, cluster_key, count, people, text, sample_index, topic, first_seen, last_seen, status
      FROM patch_issues WHERE ${where.join(' AND ')} ORDER BY count DESC, last_seen DESC LIMIT ?`).all(...args as never[]) as never;
  }
  /** Every knowledge with at least one open question, and how many — the shelf "people are asking for this" reads it. */
  issueCounts(status: 'open' = 'open'): { patch_id: string; open: number }[] {
    return this.db.prepare("SELECT patch_id, SUM(count) AS open FROM patch_issues WHERE status = ? GROUP BY patch_id ORDER BY open DESC").all(status) as never;
  }
  /**
   * A descendant published a training set that answers these questions (§10 issue lifecycle): every OPEN issue of
   * `patchId` whose cluster key is in `keys` flips to `covered_by:<child>`. Returns how many closed.
   */
  coverIssues(patchId: string, keys: string[], childId: string): number {
    if (!keys.length) return 0;
    let n = 0;
    const stmt = this.db.prepare("UPDATE patch_issues SET status = ? WHERE patch_id = ? AND cluster_key = ? AND status = 'open'");
    for (const k of keys) n += Number(stmt.run(`covered_by:${childId}`, patchId, k).changes);
    return n;
  }

  /** `events` retention (lineage design §5.6): rows older than `beforeTs` go, the materialised counters stay. Returns the number removed. */
  purgeEvents(beforeTs: number): number {
    const r = this.db.prepare('DELETE FROM events WHERE ts < ?').run(beforeTs);
    return Number(r.changes);
  }
  /**
   * The secret behind visitor ids (`'v:' + HMAC-SHA256(secret, ip|address)[:16]`): minted once per node, kept in kv,
   * never derived from the node identity so a leaked event log cannot be turned back into addresses even by someone
   * who knows the node key.
   */
  visitorSecret(): string {
    let s = this.get('visitor_hmac_secret');
    if (!s) { s = randomBytes(32).toString('hex'); this.set('visitor_hmac_secret', s); }
    return s;
  }

  // ------------------------------------------------------------ derive intents (lineage design §6.1, item 312)
  /** Record (or refresh) "this key says it is building on this knowledge". Idempotent per (parent, key). */
  putDeriveIntent(parentId: string, childKey: string, datasetSha: string, now = Date.now()) {
    this.db.prepare(`INSERT INTO derive_intents (parent_id, child_key, dataset_sha256, first_at, last_at, fetches) VALUES (?, ?, ?, ?, ?, 1)
      ON CONFLICT(parent_id, child_key) DO UPDATE SET last_at = excluded.last_at, dataset_sha256 = excluded.dataset_sha256, fetches = derive_intents.fetches + 1`)
      .run(parentId, childKey.toLowerCase(), datasetSha, now, now);
  }
  /** The knowledge this key committed to build on, newest first. */
  deriveIntentsOf(childKey: string): DeriveIntentRow[] {
    return this.db.prepare('SELECT * FROM derive_intents WHERE child_key = ? ORDER BY last_at DESC').all(childKey.toLowerCase()) as unknown as DeriveIntentRow[];
  }
  /** Everyone who took this knowledge's questions to build on — what its creator is owed an answer about. */
  deriveIntentsFor(parentId: string): DeriveIntentRow[] {
    return this.db.prepare('SELECT * FROM derive_intents WHERE parent_id = ? ORDER BY last_at DESC').all(parentId) as unknown as DeriveIntentRow[];
  }
  /** Mark a commitment as kept: the child named the parent in a published anchor. */
  markDeriveDeclared(parentId: string, childKey: string, childPatchId: string) {
    this.db.prepare('UPDATE derive_intents SET declared_by = ? WHERE parent_id = ? AND child_key = ?').run(childPatchId, parentId, childKey.toLowerCase());
  }

  // published training sets (lineage design §5.2)
  putDatasetBlob(b: { sha256: string; rows: number; size_bytes: number; access: string; license: string; patch_id: string | null; pinned_at: number }) {
    this.db.prepare(`INSERT INTO dataset_blobs (sha256, rows, size_bytes, access, license, patch_id, pinned_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(sha256) DO UPDATE SET rows = excluded.rows, size_bytes = excluded.size_bytes, access = excluded.access, license = excluded.license, patch_id = COALESCE(excluded.patch_id, dataset_blobs.patch_id)`)
      .run(b.sha256, b.rows, b.size_bytes, b.access, b.license, b.patch_id, b.pinned_at);
  }
  getDatasetBlob(sha: string): { sha256: string; rows: number; size_bytes: number; access: 'public' | 'derivative' | 'private'; license: string; patch_id: string | null; pinned_at: number } | null {
    return (this.db.prepare('SELECT * FROM dataset_blobs WHERE sha256 = ?').get(sha) as never) ?? null;
  }
  listDatasetBlobs(): { sha256: string; rows: number; size_bytes: number; access: 'public' | 'derivative' | 'private'; license: string; patch_id: string | null; pinned_at: number }[] {
    return this.db.prepare('SELECT * FROM dataset_blobs ORDER BY pinned_at DESC').all() as never;
  }
  deleteDatasetBlob(sha: string) { this.db.prepare('DELETE FROM dataset_blobs WHERE sha256 = ?').run(sha); }

  // applied — an ORDERED stack, not a set (design §5.4): `position` is where a patch sits from the bottom up, so a
  // delta child is always above the base it was trained on and the watchdog can re-assert the whole stack in order.
  setApplied(patchId: string, sha: string, reason: string, extra: { position?: number; journal_path?: string | null; stack_sha256?: string | null } = {}) {
    const pos = extra.position ?? ((this.db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM applied').get() as { m: number }).m + 1);
    this.db.prepare('INSERT OR REPLACE INTO applied (patch_id, sha256, applied_at, reason, position, journal_path, stack_sha256) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(patchId, sha, Date.now(), reason, pos, extra.journal_path ?? null, extra.stack_sha256 ?? null);
  }
  clearApplied(patchId: string) { this.db.prepare('DELETE FROM applied WHERE patch_id = ?').run(patchId); }
  /** Bottom of the stack first. Rows written before L2 have no position; they sort by when they were applied. */
  listApplied(): AppliedRow[] {
    return this.db.prepare('SELECT * FROM applied ORDER BY COALESCE(position, 1e15), applied_at').all() as never;
  }
  getApplied(patchId: string): AppliedRow | null { return (this.db.prepare('SELECT * FROM applied WHERE patch_id = ?').get(patchId) as never) ?? null; }
  /** Renumber the stack from 0 upwards in the given order — what apply/remove leave behind. */
  reorderApplied(ids: string[]) {
    const stmt = this.db.prepare('UPDATE applied SET position = ? WHERE patch_id = ?');
    ids.forEach((id, i) => stmt.run(i, id));
  }
}

/** Where the right to use a body came from. 'verification' is possession only — the verifier may score it, never serve it. */
export type LicenseSource = 'author' | 'purchase' | 'free' | 'teach' | 'verification';
/** Strength order: a verification-only copy never overwrites a purchase (or the other way round). */
const LICENSE_RANK: Record<LicenseSource, number> = { verification: 1, free: 2, teach: 3, purchase: 4, author: 5 };
/** One row of `licenses`: what this node may use, and why. */
export interface LicenseRow { patch_id: string; sha256: string; source: LicenseSource; detail: string | null; created_at: number }

/** One row of the runtime stack (`applied`). */
export interface AppliedRow {
  patch_id: string;
  sha256: string;
  applied_at: number;
  reason: string;
  /** 0 = bottom of the stack. Null on rows written before the ordered stack existed. */
  position: number | null;
  /** The `prev` values this apply overwrote — replaying it is what `remove` does (§5.4). Null = no journal. */
  journal_path: string | null;
  /** Fingerprint of the ordered stack this patch was applied on top of. */
  stack_sha256: string | null;
}
