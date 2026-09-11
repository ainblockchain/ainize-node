import { randomUUID } from 'node:crypto';
import { existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Request, Response, RequestHandler } from 'express';
import multer from 'multer';
import { sameAddr } from '@ainize/core';
import { MarketError, type Market } from './market.js';
import { sha256File } from './blobs.js';
import { verifyAuthHeader } from './p2p.js';
import { inspectReplicaNpz } from './replica-npz.js';

export const RELAY_FILE_MAX_BYTES = 256 * 1024 ** 2;
export const RELAY_EXPANDED_MAX_BYTES = 512 * 1024 ** 2;

export function blobRelay(market: Market): RequestHandler {
  const reservations = new Map<string, number>();
  const receive = async (req: Request, res: Response) => {
    const sha = String(req.params.sha ?? '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sha)) throw new MarketError(400, 'sha must be a 64-character hex sha256');
    const budget = market.cfg.p2p?.maxRelayBytes ?? 0;
    if (!market.cfg.p2p?.relayBlobs || !Number.isSafeInteger(budget) || budget <= 0) {
      throw new MarketError(403, 'relay_disabled: enable p2p.relayBlobs and a positive p2p.maxRelayBytes');
    }
    const offerer = verifyAuthHeader(req.header('x-ainize-auth'), `blob:${sha}`);
    if (!offerer) throw new MarketError(403, 'a signed author offer is required');
    const entries = (await market.catalogAll()).filter(entry => entry.anchor.patch_sha256 === sha && entry.status !== 'DRAFT' && entry.status !== 'RETIRED' && entry.status !== 'REJECTED' && entry.anchor.visibility !== 'test');
    if (!entries.length) throw new MarketError(404, 'no published public anchor names this blob; announce it first');
    const entry = entries.find(candidate => sameAddr(candidate.anchor.author, offerer));
    if (!entry) throw new MarketError(403, 'only the author may offer this blob');
    const expected = entry.anchor.size_bytes;
    if (!Number.isSafeInteger(expected) || expected <= 0 || expected > RELAY_FILE_MAX_BYTES) throw new MarketError(413, `anchor size must be 1–${RELAY_FILE_MAX_BYTES} bytes`);
    if (reservations.has(sha)) throw new MarketError(409, 'this blob already has an upload in progress');
    if (reservations.size >= 8) throw new MarketError(503, 'relay upload concurrency limit reached; retry later');
    const held = market.blobs.get(sha);
    const used = market.blobs.list().reduce((total, blob) => total + statSync(blob.path).size, 0);
    const reserved = [...reservations.values()].reduce((total, bytes) => total + bytes, 0);
    const needed = held ? 0 : expected;
    if (!held && used + reserved + needed > budget) throw new MarketError(413, 'relay storage budget exhausted (held blobs plus in-flight reservations)');
    reservations.set(sha, needed);
    let temporary: string | undefined;
    try {
      if (held) {
        if (statSync(held.path).size !== expected || await sha256File(held.path) !== sha) throw new MarketError(409, 'held blob failed integrity check; operator repair required');
        market.blobs.markRelayed(sha);
        return { ok: true, sha256: sha, size_bytes: expected, already_held: true };
      }
      const storage = multer.diskStorage({
        destination: join(market.cfg.dataDir, 'uploads'),
        filename: (_request, _file, done) => {
          const filename = `relay-${randomUUID()}`;
          temporary = join(market.cfg.dataDir, 'uploads', filename);
          done(null, filename);
        },
      });
      const upload = multer({ storage, limits: { fileSize: expected + 1, files: 1, fields: 0, parts: 2, fieldNameSize: 16 } }).single('blob');
      await new Promise<void>((resolve, reject) => {
        const aborted = () => reject(new MarketError(499, 'relay upload aborted'));
        if (req.aborted) { aborted(); return; }
        req.once('aborted', aborted);
        const deadline = setTimeout(() => req.destroy(), 60_000);
        req.once('close', () => clearTimeout(deadline));
        upload(req, res, error => {
          req.off('aborted', aborted);
          clearTimeout(deadline);
          if (error) reject(new MarketError(error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE' ? 413 : 400, 'invalid or oversized relay multipart upload'));
          else resolve();
        });
      });
      if (!req.file || req.file.size !== expected) throw new MarketError(400, 'attach multipart field blob with exactly the anchored size');
      if (await sha256File(req.file.path) !== sha) throw new MarketError(400, 'blob sha256 does not match the signed anchor');
      try {
        const info = inspectReplicaNpz(req.file.path, RELAY_FILE_MAX_BYTES, RELAY_EXPANDED_MAX_BYTES);
        if (info.rows !== entry.anchor.rows || (entry.anchor.model.row_dim !== undefined && info.rowDim !== entry.anchor.model.row_dim)) throw new Error('knowledge dimensions disagree with anchor');
      } catch (error) {
        throw new MarketError(400, (error as Error).message);
      }
      const destination = market.blobs.pathFor(sha);
      if (existsSync(destination) && await sha256File(destination) !== sha) throw new MarketError(409, 'stored file failed integrity check; operator repair required');
      const { blob } = await market.blobs.importFile(req.file.path, { copy: true, expectSha: sha });
      market.blobs.markRelayed(sha);
      market.log('info', 'blob', `relaying ${sha.slice(0, 12)} for ${entry.anchor.id} (${blob.size_bytes} bytes)`, entry.anchor.id);
      return { ok: true, sha256: sha, size_bytes: blob.size_bytes, already_held: false };
    } finally {
      try { if (temporary) rmSync(temporary, { force: true }); }
      finally { reservations.delete(sha); }
    }
  };
  return (req, res, next) => { receive(req, res).then(result => res.json(result)).catch(next); };
}
