/**
 * Node-local state (SQLite via node:sqlite): drafts, blobs, purchases, peers, events, sessions,
 * x402 nonces, applied patches. Everything that is *not* shared truth lives here; shared truth is the Ledger.
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PatchAnchor, PeerInfo, PatchManifest, TeachDatasetSource, TeachDatasetStatus, TeachDatasetSummary, TeachTrainingSpec } from '@ngram/core';

export interface BlobRow { sha256: string; path: string; size_bytes: number; rows: number; row_dim: number; imported_at: number; }
export interface PurchaseRow { patch_id: string; sha256: string; tx_hash: string; scheme: string; amount: string; manifest: PatchManifest | null; path: string | null; created_at: number; }
/** Severity order (low → high): a `level` filter means "this level and worse". */
export const EVENT_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
/**
 * Every `kind` this node writes events under. `ainize logs --kind` offers exactly these, so a mistyped kind is
 * refused with the list instead of printing an empty screen that looks like an idle node (items 116/132).
 */
export const EVENT_KINDS = [
  'blob', 'branch', 'buy', 'challenge', 'config', 'drive', 'node', 'p2p', 'patch', 'payout', 'publish',
  'runtime', 'seed', 'settings', 'teach', 'trade', 'usage', 'verifier', 'verify',
] as const;

export interface EventRow { seq: number; ts: number; level: (typeof EVENT_LEVELS)[number]; kind: string; patch_id: string | null; message: string; data: unknown; }
export interface PeerRow { endpoint: string; address: string | null; info: PeerInfo | null; last_seen: number; failures: number; cursor: number; }
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
}
export interface TeachFactRow { prompt: string; answer: string; alt_prompt?: string; base_answer?: string; after_answer?: string; hit?: boolean; heldout_hit?: boolean; status?: string }

/** One dataset as persisted (teach mode v2). `dir` holds `source.<ext>`, `rows.jsonl` and `report.json`. */
export interface TeachDatasetRecord {
  id: string; owner: string; ip: string | null; name: string;
  status: TeachDatasetStatus; source: TeachDatasetSource;
  format: string | null; encoding: string | null; layout: string | null; delimiter: string | null;
  has_header: boolean | null; columns: Record<string, string | number> | null;
  sha256: string; revision: number; rows: number; invalid_rows: number; size_bytes: number;
  source_bytes: number | null; source_name: string | null; source_sha256: string | null;
  dir: string; summary: TeachDatasetSummary | null; parent_dataset: string | null;
  retention: 'keep' | 'delete_after_training';
  created_at: number; updated_at: number; expires_at: number | null; deleted_at: number | null;
}
export interface ContributorRow { address: string; name: string | null; payout_address: string | null; first_seen: number; last_seen: number; jobs: number; published: number; hidden: boolean; note: string | null }
export interface BanRow { id: number; kind: 'address' | 'ip'; value: string; reason: string | null; ts: number }
/** `paying` = a transfer is in flight right now (claimed atomically by the payout runner); a row found `paying` at boot was interrupted mid-transfer. */
export interface PayoutRow { id: number; patch_id: string; settle_hash: string; address: string; amount: string; currency: string; status: 'pending' | 'paying' | 'paid' | 'failed'; tx_hash: string | null; attempts: number; last_error: string | null; created_at: number; updated_at: number }

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
      CREATE TABLE IF NOT EXISTS peers (endpoint TEXT PRIMARY KEY, address TEXT, info TEXT, last_seen REAL NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0, cursor REAL NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, level TEXT NOT NULL, kind TEXT NOT NULL, patch_id TEXT, message TEXT NOT NULL, data TEXT);
      CREATE INDEX IF NOT EXISTS idx_events_patch ON events(patch_id);
      CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, created_at REAL NOT NULL, expires_at REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS nonces (nonce TEXT PRIMARY KEY, resource TEXT NOT NULL, amount TEXT NOT NULL, pay_to TEXT NOT NULL, expires_at REAL NOT NULL, used INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS payments_seen (tx_hash TEXT PRIMARY KEY, patch_id TEXT NOT NULL, ts REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS applied (patch_id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at REAL NOT NULL, reason TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tokens (token TEXT PRIMARY KEY, sha256 TEXT NOT NULL, issued_to TEXT NOT NULL, expires_at REAL NOT NULL);
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
    });
    // teach mode v2 (design §D7): every visitor-facing p50/p90 filters on `backend`, so a stub node's 3-second jobs
    // can never be presented as measured gradient training. `sentences` = rows x renderings, what actually drives cost.
    add('teach_stats', { backend: 'TEXT', rows_trained: 'INTEGER', sentences: 'INTEGER' });
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
    this.db.prepare(`INSERT INTO purchases (patch_id, sha256, tx_hash, scheme, amount, manifest, path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(patch_id) DO UPDATE SET tx_hash = excluded.tx_hash, manifest = excluded.manifest, path = excluded.path, created_at = excluded.created_at`)
      .run(p.patch_id, p.sha256, p.tx_hash, p.scheme, p.amount, p.manifest ? JSON.stringify(p.manifest) : null, p.path, p.created_at);
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
      manifest: r.manifest ? JSON.parse(r.manifest as string) : null, path: (r.path as string) ?? null, created_at: r.created_at as number };
  }

  // peers
  upsertPeer(endpoint: string, patch: Partial<PeerRow> = {}) {
    const cur = this.getPeer(endpoint);
    const row: PeerRow = { endpoint, address: patch.address ?? cur?.address ?? null, info: patch.info ?? cur?.info ?? null,
      last_seen: patch.last_seen ?? cur?.last_seen ?? 0, failures: patch.failures ?? cur?.failures ?? 0, cursor: patch.cursor ?? cur?.cursor ?? 0 };
    this.db.prepare(`INSERT INTO peers (endpoint, address, info, last_seen, failures, cursor) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET address = excluded.address, info = excluded.info, last_seen = excluded.last_seen, failures = excluded.failures, cursor = excluded.cursor`)
      .run(row.endpoint, row.address, row.info ? JSON.stringify(row.info) : null, row.last_seen, row.failures, row.cursor);
  }
  getPeer(endpoint: string): PeerRow | null {
    const r = this.db.prepare('SELECT * FROM peers WHERE endpoint = ?').get(endpoint) as Record<string, unknown> | undefined;
    return r ? { endpoint: r.endpoint as string, address: (r.address as string) ?? null, info: r.info ? JSON.parse(r.info as string) : null, last_seen: r.last_seen as number, failures: r.failures as number, cursor: r.cursor as number } : null;
  }
  listPeers(): PeerRow[] {
    return (this.db.prepare('SELECT * FROM peers ORDER BY last_seen DESC').all() as Record<string, unknown>[])
      .map((r) => ({ endpoint: r.endpoint as string, address: (r.address as string) ?? null, info: r.info ? JSON.parse(r.info as string) : null, last_seen: r.last_seen as number, failures: r.failures as number, cursor: r.cursor as number }));
  }
  deletePeer(endpoint: string) { this.db.prepare('DELETE FROM peers WHERE endpoint = ?').run(endpoint); }

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

  // x402 nonces + replay protection
  putNonce(nonce: string, resource: string, amount: string, payTo: string, ttlMs: number) {
    this.db.prepare('INSERT INTO nonces (nonce, resource, amount, pay_to, expires_at) VALUES (?, ?, ?, ?, ?)').run(nonce, resource, amount, payTo, Date.now() + ttlMs);
  }
  takeNonce(nonce: string): { resource: string; amount: string; pay_to: string } | null {
    const r = this.db.prepare('SELECT * FROM nonces WHERE nonce = ? AND used = 0 AND expires_at > ?').get(nonce, Date.now()) as { resource: string; amount: string; pay_to: string } | undefined;
    if (!r) return null;
    this.db.prepare('UPDATE nonces SET used = 1 WHERE nonce = ?').run(nonce);
    return r;
  }
  paymentSeen(txHash: string): boolean { return !!this.db.prepare('SELECT 1 FROM payments_seen WHERE tx_hash = ?').get(txHash); }
  markPayment(txHash: string, patchId: string) { this.db.prepare('INSERT OR IGNORE INTO payments_seen (tx_hash, patch_id, ts) VALUES (?, ?, ?)').run(txHash, patchId, Date.now()); }

  // download tokens
  putToken(token: string, sha: string, issuedTo: string, ttlMs: number) { this.db.prepare('INSERT OR REPLACE INTO tokens (token, sha256, issued_to, expires_at) VALUES (?, ?, ?, ?)').run(token, sha, issuedTo, Date.now() + ttlMs); }
  checkToken(token: string, sha: string): boolean {
    const r = this.db.prepare('SELECT expires_at FROM tokens WHERE token = ? AND sha256 = ?').get(token, sha) as { expires_at: number } | undefined;
    return !!r && r.expires_at > Date.now();
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
    };
  }
  insertTeachJob(j: Omit<TeachJobRow, 'updated_at' | 'lesson_applied'>) {
    this.db.prepare(`INSERT INTO teach_jobs (id, contributor, contributor_name, ip, status, context, builds_on, facts, job_dir, npz_path, sha256, progress, checks, error, container_pid,
      draft_id, patch_id, publish_status, reject_reason, parent_job, result, blocked, name, created_at, started_at, finished_at, updated_at, expires_at, cancel_requested,
      dataset_id, dataset_sha256, dataset_rows, dataset_source, training, preflight)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(j.id, j.contributor, j.contributor_name, j.ip, j.status, JSON.stringify(j.context), j.builds_on ? 1 : 0, JSON.stringify(j.facts), j.job_dir, j.npz_path, j.sha256,
        j.progress ? JSON.stringify(j.progress) : null, j.checks ? JSON.stringify(j.checks) : null, j.error, j.container_pid, j.draft_id, j.patch_id, j.publish_status, j.reject_reason,
        j.parent_job, j.result ? JSON.stringify(j.result) : null, j.blocked, j.name, j.created_at, j.started_at, j.finished_at, Date.now(), j.expires_at, j.cancel_requested ? 1 : 0,
        j.dataset_id ?? null, j.dataset_sha256 ?? null, j.dataset_rows ?? null, j.dataset_source ?? null,
        j.training ? JSON.stringify(j.training) : null, j.preflight ? JSON.stringify(j.preflight) : null);
  }
  /** Partial update; JSON columns are re-encoded, `updated_at` is always bumped. */
  updateTeachJob(id: string, patch: Partial<Omit<TeachJobRow, 'id' | 'updated_at'>>) {
    const cols: string[] = []; const args: (string | number | null)[] = [];
    const enc = (k: string, v: unknown): string | number | null => {
      if (v === undefined || v === null) return null;
      if (['context', 'facts', 'progress', 'checks', 'result', 'training', 'preflight'].includes(k)) return JSON.stringify(v);
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
      retention: ((r.retention as string) ?? 'keep') as 'keep' | 'delete_after_training',
      created_at: r.created_at as number, updated_at: r.updated_at as number, expires_at: (r.expires_at as number) ?? null, deleted_at: (r.deleted_at as number) ?? null,
    };
  }
  insertTeachDataset(d: Omit<TeachDatasetRecord, 'updated_at'> & { updated_at?: number }) {
    this.db.prepare(`INSERT INTO teach_datasets (id, owner, ip, name, status, source, format, encoding, layout, delimiter, has_header, columns, sha256, revision, rows, invalid_rows,
      size_bytes, source_bytes, source_name, source_sha256, dir, summary, parent_dataset, retention, created_at, updated_at, expires_at, deleted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(d.id, d.owner, d.ip, d.name, d.status, d.source, d.format, d.encoding, d.layout, d.delimiter,
        d.has_header === null ? null : d.has_header ? 1 : 0, d.columns ? JSON.stringify(d.columns) : null,
        d.sha256, d.revision, d.rows, d.invalid_rows, d.size_bytes, d.source_bytes, d.source_name, d.source_sha256,
        d.dir, d.summary ? JSON.stringify(d.summary) : null, d.parent_dataset, d.retention, d.created_at, d.updated_at ?? Date.now(), d.expires_at, d.deleted_at);
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
  updatePayout(id: number, patch: Partial<Pick<PayoutRow, 'status' | 'tx_hash' | 'attempts' | 'last_error'>>): PayoutRow {
    const cur = this.getPayout(id);
    if (!cur) throw new Error(`payout ${id} not found`);
    const next = { ...cur, ...patch, updated_at: Date.now() };
    this.db.prepare('UPDATE payouts SET status = ?, tx_hash = ?, attempts = ?, last_error = ?, updated_at = ? WHERE id = ?')
      .run(next.status, next.tx_hash, next.attempts, next.last_error, next.updated_at, id);
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

  // applied
  setApplied(patchId: string, sha: string, reason: string) { this.db.prepare('INSERT OR REPLACE INTO applied (patch_id, sha256, applied_at, reason) VALUES (?, ?, ?, ?)').run(patchId, sha, Date.now(), reason); }
  clearApplied(patchId: string) { this.db.prepare('DELETE FROM applied WHERE patch_id = ?').run(patchId); }
  listApplied(): { patch_id: string; sha256: string; applied_at: number; reason: string }[] { return this.db.prepare('SELECT * FROM applied').all() as never; }
}
