/**
 * Content-addressed store for PUBLISHED training sets (lineage design §5.2, §6.6):
 *
 *   <dataDir>/blobs/datasets/<sha256>/rows.jsonl       exact canonical bytes — sha256 == anchor.dataset.sha256
 *   <dataDir>/blobs/datasets/<sha256>/manifest.json    what the rows are: licence, access, parents, row origin,
 *                                                       the benchmark hash, the merkle root, the PII scan, the declaration
 *   <dataDir>/blobs/datasets/<sha256>/benchmark.jsonl  the FULL benchmark sample list (the `answers_hash` preimage)
 *
 * Separate from `teach/datasets/<id>/` on purpose: a teaching key's working dataset is edited, swept after 7 days and
 * deleted by its owner; a published copy is immutable, exempt from the sweep and from the owner's delete (the anchor
 * that references it is permanent). A node that fetched a parent's set from a peer keeps it here too and re-advertises
 * it, so a parent node going offline does not orphan the line.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { merkleRoot, type BenchmarkSample, type DatasetAccess, type TeachDatasetSource } from '@ngram/core';
import { readCanonicalJsonl, type CanonicalRow } from './teach-dataset.js';
import type { Store } from './store.js';

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/** `manifest.json` — everything a derivative creator or a verifier needs beside the rows (§5.2). */
export interface DatasetManifest {
  version: 1;
  sha256: string;
  rows: number;
  size_bytes: number;
  source: TeachDatasetSource;
  license: string;
  access: DatasetAccess;
  /** the training sets this one was built from */
  parents: { patch_id: string; sha256: string; rows: number }[];
  /** per row: null = the publisher's own; '<parent>#<i>' = inherited unchanged. Empty = every row is the publisher's own. */
  row_origin: (string | null)[];
  /** indexes of rows that override an inherited answer / inherited rows left out (§6.3) */
  changed: number[];
  removed: number[];
  /** sha256 of benchmark.jsonl (the answers_hash preimage) and the number of samples in it */
  benchmark_sha256: string;
  benchmark_samples: number;
  merkle_root: string;
  contrast_used: string[];
  fact_addrs?: Record<number, number[]>;
  pii_scan: { ok: boolean; rows: number[] };
  declaration: { source: 'own' | 'public' | 'licensed'; license?: string; no_pii: boolean } | null;
  include_notes: boolean;
  /** which knowledge published it (informational — the sha is the identity) */
  patch_id?: string;
  model_id?: string;
  created_at: number;
}

export interface DatasetBlobRow { sha256: string; rows: number; size_bytes: number; access: DatasetAccess; license: string; patch_id: string | null; pinned_at: number }

export class DatasetBlobStore {
  readonly dir: string;
  constructor(private readonly store: Store, dataDir: string) {
    this.dir = join(dataDir, 'blobs', 'datasets');
    mkdirSync(this.dir, { recursive: true });
  }

  dirFor(sha: string): string { return join(this.dir, sha); }
  rowsPath(sha: string): string { return join(this.dirFor(sha), 'rows.jsonl'); }
  manifestPath(sha: string): string { return join(this.dirFor(sha), 'manifest.json'); }
  benchmarkPath(sha: string): string { return join(this.dirFor(sha), 'benchmark.jsonl'); }

  /**
   * Pin a canonical `rows.jsonl` under its own sha256 (immutable: pinning the same bytes twice is a no-op that keeps
   * the first manifest). The manifest is completed here — sha, size, merkle root, benchmark hash — so a caller cannot
   * write one that disagrees with the bytes.
   */
  pin(rows: Buffer, manifest: Omit<DatasetManifest, 'version' | 'sha256' | 'rows' | 'size_bytes' | 'merkle_root' | 'benchmark_sha256' | 'benchmark_samples' | 'created_at'>, benchmark: BenchmarkSample[]): DatasetBlobRow {
    const sha = sha256(rows);
    const existing = this.get(sha);
    if (existing) return existing;
    const parsed = readCanonicalJsonl(rows.toString('utf8'));
    const bench = encodeBenchmarkJsonl(benchmark);
    const full: DatasetManifest = {
      version: 1, sha256: sha, rows: parsed.length, size_bytes: rows.length,
      merkle_root: merkleRoot(rows.toString('utf8').split('\n').filter((l) => l.length)),
      benchmark_sha256: sha256(bench), benchmark_samples: benchmark.length,
      ...manifest, created_at: Date.now(),
    };
    const dir = this.dirFor(sha);
    const tmp = `${dir}.part-${process.pid}`;
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true, mode: 0o755 });
    writeFileSync(join(tmp, 'rows.jsonl'), rows, { mode: 0o644 });
    writeFileSync(join(tmp, 'benchmark.jsonl'), bench, { mode: 0o644 });
    writeFileSync(join(tmp, 'manifest.json'), JSON.stringify(full, null, 1), { mode: 0o644 });
    if (existsSync(dir)) rmSync(tmp, { recursive: true, force: true }); else renameSync(tmp, dir);
    const row: DatasetBlobRow = { sha256: sha, rows: parsed.length, size_bytes: rows.length, access: full.access, license: full.license, patch_id: full.patch_id ?? null, pinned_at: Date.now() };
    this.store.putDatasetBlob(row);
    return row;
  }

  /**
   * Keep a set fetched from a peer: the bytes must hash to `sha` and the manifest (if any) must agree; otherwise
   * nothing is written. A fetched set is re-advertised by this node (`PeerInfo.datasets`).
   */
  keepFetched(sha: string, rows: Buffer, manifest: DatasetManifest | null, benchmark: Buffer | null): DatasetBlobRow {
    if (sha256(rows) !== sha) throw new Error(`dataset sha256 mismatch: expected ${sha}, got ${sha256(rows)}`);
    const existing = this.get(sha);
    if (existing) return existing;
    const parsed = readCanonicalJsonl(rows.toString('utf8'));
    const m: DatasetManifest = manifest && manifest.sha256 === sha ? manifest : {
      version: 1, sha256: sha, rows: parsed.length, size_bytes: rows.length, source: 'derived', license: 'Proprietary', access: 'private', parents: [], row_origin: [], changed: [], removed: [],
      benchmark_sha256: sha256(benchmark ?? Buffer.alloc(0)), benchmark_samples: benchmark ? benchmark.toString('utf8').split('\n').filter(Boolean).length : 0,
      merkle_root: merkleRoot(rows.toString('utf8').split('\n').filter((l) => l.length)), contrast_used: [], pii_scan: { ok: true, rows: [] }, declaration: null, include_notes: false, created_at: Date.now(),
    };
    const dir = this.dirFor(sha);
    const tmp = `${dir}.part-${process.pid}`;
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true, mode: 0o755 });
    writeFileSync(join(tmp, 'rows.jsonl'), rows, { mode: 0o644 });
    if (benchmark) writeFileSync(join(tmp, 'benchmark.jsonl'), benchmark, { mode: 0o644 });
    writeFileSync(join(tmp, 'manifest.json'), JSON.stringify(m, null, 1), { mode: 0o644 });
    if (existsSync(dir)) rmSync(tmp, { recursive: true, force: true }); else renameSync(tmp, dir);
    const row: DatasetBlobRow = { sha256: sha, rows: parsed.length, size_bytes: rows.length, access: m.access, license: m.license, patch_id: m.patch_id ?? null, pinned_at: Date.now() };
    this.store.putDatasetBlob(row);
    return row;
  }

  get(sha: string): DatasetBlobRow | null {
    const r = this.store.getDatasetBlob(sha);
    if (!r) return null;
    if (!existsSync(this.rowsPath(sha))) { this.store.deleteDatasetBlob(sha); return null; }
    return r;
  }
  has(sha: string): boolean { return !!this.get(sha); }
  list(): DatasetBlobRow[] { return this.store.listDatasetBlobs().filter((b) => existsSync(this.rowsPath(b.sha256))); }

  rowsBytes(sha: string): Buffer | null { const p = this.rowsPath(sha); return existsSync(p) ? readFileSync(p) : null; }
  rows(sha: string): CanonicalRow[] { const b = this.rowsBytes(sha); return b ? readCanonicalJsonl(b.toString('utf8')) : []; }
  manifest(sha: string): DatasetManifest | null {
    const p = this.manifestPath(sha);
    if (!existsSync(p)) return null;
    try { return JSON.parse(readFileSync(p, 'utf8')) as DatasetManifest; } catch { return null; }
  }
  benchmark(sha: string): BenchmarkSample[] {
    const p = this.benchmarkPath(sha);
    return existsSync(p) ? decodeBenchmarkJsonl(readFileSync(p, 'utf8')) : [];
  }
  sizeBytes(sha: string): number { const p = this.rowsPath(sha); return existsSync(p) ? statSync(p).size : 0; }

  /** Only for a set no anchor references any more — the caller checks that (a referenced set is permanent). */
  remove(sha: string) {
    rmSync(this.dirFor(sha), { recursive: true, force: true });
    this.store.deleteDatasetBlob(sha);
  }
}

/**
 * `benchmark.jsonl` — the FULL sample list of a lesson, in order, one JSON object per line. These bytes are the
 * preimage of the anchor's `answers_hash` (§5.1): a verifier that fetches this file recomputes the hash and gets the
 * number on the record, which is what makes the ≤ 32 samples on the ledger a slice and not a replacement. The node
 * writes the same bytes next to the job at draft time and next to the rows when the set is pinned, through here.
 */
export function encodeBenchmarkJsonl(samples: BenchmarkSample[]): Buffer {
  const lines = samples.map((s) => JSON.stringify({ prompt: s.prompt, expect: s.expect, ...(s.source ? { source: s.source } : {}) }));
  return Buffer.from(lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
}
export function decodeBenchmarkJsonl(text: string): BenchmarkSample[] {
  const out: BenchmarkSample[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const o = JSON.parse(line) as BenchmarkSample; if (typeof o.prompt === 'string' && typeof o.expect === 'string') out.push({ prompt: o.prompt, expect: o.expect, ...(o.source ? { source: o.source } : {}) }); } catch { /* our own file */ }
  }
  return out;
}

/** Rows as served to a derivative creator: `note` only when the publisher opted in, never anything else (§6.2). */
export function publishedRows(rows: CanonicalRow[], includeNotes: boolean): CanonicalRow[] {
  return rows.map((r) => ({ prompt: r.prompt, answer: r.answer, ...(r.alt_prompt ? { alt_prompt: r.alt_prompt } : {}), ...(includeNotes && r.note ? { note: r.note } : {}) }));
}
