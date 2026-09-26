/**
 * gzip for everything but event streams.
 *
 * `compression()` buffers what it compresses until its zlib window fills or the response ends, so a streamed
 * answer (`text/event-stream`) that goes through it arrives as one lump at the end. Routes that set
 * `Cache-Control: no-transform` were already skipped; `/p2p/models/chat` did not, and a peer's streamed chat —
 * an agent on ainize.ai answered by a GPU node — reached the caller all at once after the model had finished.
 * Skipping by content type covers every stream, including ones added later.
 */
import compression from 'compression';
import type { Request, Response } from 'express';

export function sseAwareCompressionFilter(req: Request, res: Response): boolean {
  if (/text\/event-stream/i.test(String(res.getHeader('content-type') ?? ''))) return false;
  return compression.filter(req, res);
}

export const sseAwareCompression = () => compression({ filter: sseAwareCompressionFilter });
