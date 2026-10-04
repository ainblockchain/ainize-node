/**
 * Event streams leave a node as they are written (src/sse-aware-compression.ts): with plain `compression()` a
 * caller that accepts gzip got every piece of a streamed answer at once, at the end.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gunzipSync } from 'node:zlib';
import express from 'express';
import { sseAwareCompression } from '../src/sse-aware-compression.js';

/** Keep the wire bytes: automatic decompression would hide a compressed event stream. */
function response(url: string, onBody: (body: Buffer) => void = () => {}): Promise<{ body: Buffer; encoding: string | undefined }> {
  return new Promise((resolve, reject) => {
    request(url, { headers: { 'accept-encoding': 'gzip, deflate' }, signal: AbortSignal.timeout(10_000) }, (res) => {
      const chunks: Buffer[] = [];
      res.on('error', reject);
      res.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        onBody(Buffer.concat(chunks));
      });
      res.on('end', () => resolve({ body: Buffer.concat(chunks), encoding: res.headers['content-encoding'] }));
    }).on('error', reject).end();
  });
}

test('a streamed answer arrives piece by piece, and other responses are still gzipped', async () => {
  const frames = Array.from({ length: 4 }, (_, n) => `data: {"n":${n}}\n\n`);
  const received = frames.map(() => Promise.withResolvers<void>());
  let finished = false;
  const beforeEnd: boolean[] = [];
  const app = express();
  app.use(sseAwareCompression());
  app.get('/stream', async (_req, res) => {
    res.setHeader('content-type', 'text/event-stream');
    for (const [i, frame] of frames.entries()) {
      res.write(frame);
      // The client must see this complete event before the next one can be written.
      // Buffering until end now fails regardless of scheduler load or TCP chunk boundaries.
      await received[i]!.promise;
    }
    finished = true;
    res.end('data: [DONE]\n\n');
  });
  const json = { text: 'x'.repeat(5000) };
  app.get('/json', (_req, res) => { res.json(json); });
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    let next = 0;
    const s = await response(`${base}/stream`, body => {
      if (next < frames.length && body.toString() === frames.slice(0, next + 1).join('')) {
        beforeEnd.push(!finished);
        received[next++]!.resolve();
      }
    });
    assert.equal(s.encoding, undefined, 'the stream is not compressed');
    assert.deepEqual(beforeEnd, [true, true, true, true], 'each event arrived before the answer finished');
    assert.equal(s.body.toString(), frames.join('') + 'data: [DONE]\n\n');
    const j = await response(`${base}/json`);
    assert.equal(j.encoding, 'gzip');
    assert.deepEqual(JSON.parse(gunzipSync(j.body).toString()), json);
  } finally {
    for (const ack of received) ack.resolve();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
