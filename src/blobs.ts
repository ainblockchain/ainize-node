/**
 * Content-addressed patch body store. Bodies are referenced by sha256; files may live in place
 * (e.g. /mnt/newdata/qwen3.8/results/…) or be copied into <dataDir>/blobs/<sha>.npz.
 */
import { createHash } from 'node:crypto';
import { createReadStream, copyFileSync, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { addressSet, addressSketch, inspectNpz, readNpzAddrs } from '@ainize/core';
import type { Store, BlobRow } from './store.js';

export async function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

export class BlobStore {
  readonly dir: string;
  constructor(private readonly store: Store, dataDir: string) {
    this.dir = join(dataDir, 'blobs');
    mkdirSync(this.dir, { recursive: true });
  }

  pathFor(sha: string): string { return join(this.dir, `${sha}.npz`); }

  /** Register a local .npz. Returns blob row + address sketch. */
  async importFile(path: string, opts: { copy?: boolean; expectSha?: string } = {}): Promise<{ blob: BlobRow; sketch: number[] }> {
    if (!existsSync(path)) throw new Error(`file not found: ${path}`);
    const sha = await sha256File(path);
    if (opts.expectSha && opts.expectSha !== sha) throw new Error(`sha256 mismatch: expected ${opts.expectSha}, got ${sha}`);
    const info = inspectNpz(path);
    if (!info.members.some((m) => m.name === 'addrs')) throw new Error('not a knowledge patch: missing addrs array');
    let finalPath = path;
    if (opts.copy) {
      finalPath = this.pathFor(sha);
      if (!existsSync(finalPath)) copyFileSync(path, finalPath);
    }
    const blob: BlobRow = { sha256: sha, path: finalPath, size_bytes: statSync(finalPath).size, rows: info.rows, row_dim: info.rowDim, imported_at: Date.now() };
    this.store.putBlob(blob);
    const set = addressSet(readNpzAddrs(finalPath));
    this.store.putAddrSet(sha, set);
    return { blob, sketch: addressSketch(set) };
  }

  get(sha: string): BlobRow | null {
    const b = this.store.getBlob(sha);
    if (b && !existsSync(b.path)) { this.store.deleteBlob(sha); return null; }
    return b;
  }

  has(sha: string): boolean { return !!this.get(sha); }
  markRelayed(sha: string): void { this.store.markBlobRelayed(sha); }
  isRelayed(sha: string): boolean { return this.get(sha)?.relayed === 1; }
  list(): BlobRow[] { return this.store.listBlobs().filter((b) => existsSync(b.path)); }

  addrSet(sha: string): BigInt64Array | null {
    let set = this.store.getAddrSet(sha);
    if (!set) {
      const b = this.get(sha);
      if (!b) return null;
      set = addressSet(readNpzAddrs(b.path));
      this.store.putAddrSet(sha, set);
    }
    return set;
  }

  remove(sha: string) {
    const b = this.store.getBlob(sha);
    if (b && b.path.startsWith(this.dir) && existsSync(b.path)) unlinkSync(b.path);
    this.store.deleteBlob(sha);
  }
}
