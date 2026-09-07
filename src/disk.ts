/**
 * What this node is holding on disk, in bytes (item 128).
 *
 * Four stores grow on their own and none of them was reported anywhere: verification downloads every announced body
 * into `<dataDir>/blobs` and keeps it forever, visitors upload training sets into `<dataDir>/uploads`, the event table
 * grows with every request, and `start -d` appends to node.log until the volume fills. The first symptom used to be
 * ENOSPC, which takes the SQLite store and the ledger with it. `/api/info.disk` and `ainize status` answer instead,
 * and `ainize gc` is what an operator does about it.
 */
import { readdirSync, rmSync, statSync, statfsSync } from 'node:fs';
import { join } from 'node:path';

export { humanBytes } from '@ainize/core';
import type { DiskReport } from '@ainize/core';

export type { DiskReport } from '@ainize/core';

/** Bytes under `dir`, following no symlinks and swallowing anything unreadable. */
export function dirBytes(dir: string): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  let entries: import('node:fs').Dirent[];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return { bytes: 0, files: 0 }; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { const sub = dirBytes(p); bytes += sub.bytes; files += sub.files; continue; }
    if (!e.isFile()) continue;
    try { bytes += statSync(p).size; files++; } catch { /* vanished under us */ }
  }
  return { bytes, files };
}

/** Bytes of one file (0 when it is not there). */
export function fileBytes(path: string): number {
  try { return statSync(path).size; } catch { return 0; }
}

export function diskReport(dataDir: string, opts: { home?: string; ledgerFile?: string } = {}): DiskReport {
  const datasets = dirBytes(join(dataDir, 'blobs', 'datasets'));
  const allBlobs = dirBytes(join(dataDir, 'blobs'));
  const uploads = dirBytes(join(dataDir, 'uploads'));
  const db = ['node.sqlite', 'node.sqlite-wal', 'node.sqlite-shm'].reduce((n, f) => n + fileBytes(join(dataDir, f)), 0)
    + (opts.ledgerFile ? fileBytes(opts.ledgerFile) : 0);
  const log = opts.home ? fileBytes(join(opts.home, 'node.log')) : 0;
  const blobs = Math.max(0, allBlobs.bytes - datasets.bytes);
  let free: number | null = null;
  let size: number | null = null;
  try { const st = statfsSync(dataDir); free = st.bavail * st.bsize; size = st.blocks * st.bsize; } catch { /* not reportable here */ }
  return {
    path: dataDir, blobs, datasets: datasets.bytes, uploads: uploads.bytes, db, log,
    total: blobs + datasets.bytes + uploads.bytes + db + log,
    free, size, blob_files: Math.max(0, allBlobs.files - datasets.files),
    reclaimable_files: 0, reclaimable_bytes: 0,
  };
}

/** `1.1 GB`, `932 MB`, `9.4 kB` — the same rendering everywhere, so two surfaces never disagree. */

/**
 * Delete files under `dir` that nothing has written to for `olderThanMs` (item 129).
 *
 * multer writes every upload — a 350 MB knowledge body, a spreadsheet of questions — into a temp directory and
 * hands the handler a path; the handler copies what it needs into the blob store. Nothing ever deleted the temp
 * copy, on success or on any of the rejection paths, and no sweep existed: a demo node held 115 MB of orphans,
 * twenty-three times its actual blob store. The routes now unlink their own file; this is the sweep for what a
 * crash, a SIGKILL or a build older than this one left behind. `mtime` is the test, so an upload still streaming
 * in is never taken.
 */
export function sweepTemp(dir: string, olderThanMs: number): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const cutoff = Date.now() - olderThanMs;
  let entries: import('node:fs').Dirent[];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return { files: 0, bytes: 0 }; }
  for (const e of entries) {
    if (!e.isFile()) continue;
    const p = join(dir, e.name);
    try {
      const st = statSync(p);
      if (st.mtimeMs > cutoff) continue;
      rmSync(p, { force: true });
      files++;
      bytes += st.size;
    } catch { /* gone under us, or not ours to delete */ }
  }
  return { files, bytes };
}
