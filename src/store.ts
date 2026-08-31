/**
 * Node-local state (SQLite via node:sqlite): drafts, blobs, purchases, peers, events, sessions,
 * x402 nonces, applied patches. Everything that is *not* shared truth lives here; shared truth is the Ledger.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PatchAnchor, PeerInfo, PatchManifest } from '@ngram/core';

export interface BlobRow { sha256: string; path: string; size_bytes: number; rows: number; row_dim: number; imported_at: number; }
export interface PurchaseRow { patch_id: string; sha256: string; tx_hash: string; scheme: string; amount: string; manifest: PatchManifest | null; path: string | null; created_at: number; }
export interface EventRow { seq: number; ts: number; level: 'debug' | 'info' | 'warn' | 'error'; kind: string; patch_id: string | null; message: string; data: unknown; }
export interface PeerRow { endpoint: string; address: string | null; info: PeerInfo | null; last_seen: number; failures: number; cursor: number; }
export interface DraftRow { id: string; anchor: PatchAnchor; file_path: string; created_at: number; updated_at: number; }

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
    `);
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
  events(opts: { patch_id?: string; since?: number; limit?: number; kind?: string } = {}): EventRow[] {
    const where: string[] = []; const args: (string | number)[] = [];
    if (opts.patch_id) { where.push('patch_id = ?'); args.push(opts.patch_id); }
    if (opts.since) { where.push('ts > ?'); args.push(opts.since); }
    if (opts.kind) { where.push('kind = ?'); args.push(opts.kind); }
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

  // applied
  setApplied(patchId: string, sha: string, reason: string) { this.db.prepare('INSERT OR REPLACE INTO applied (patch_id, sha256, applied_at, reason) VALUES (?, ?, ?, ?)').run(patchId, sha, Date.now(), reason); }
  clearApplied(patchId: string) { this.db.prepare('DELETE FROM applied WHERE patch_id = ?').run(patchId); }
  listApplied(): { patch_id: string; sha256: string; applied_at: number; reason: string }[] { return this.db.prepare('SELECT * FROM applied').all() as never; }
}
