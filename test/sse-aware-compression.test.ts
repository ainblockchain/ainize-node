/**
 * Event streams leave a node as they are written (src/sse-aware-compression.ts): with plain `compression()` a
 * caller that accepts gzip got every piece of a streamed answer at once, at the end.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { request } from 'node:http';
import express from 'express';
import { sseAwareCompression } from '../src/sse-aware-compression.js';

/** Arrival time of each body chunk, for a caller that asks for gzip (as fetch does). */
function arrivals(url: string): Promise<{ times: number[]; encoding: string | undefined }> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    request(url, { headers: { 'accept-encoding': 'gzip, deflate' } }, (res) => {
      const times: number[] = [];
      res.on('data', () => times.push(Date.now() - t0));
      res.on('end', () => resolve({ times, encoding: res.headers['content-encoding'] }));
    }).on('error', reject).end();
  });
}

test('a streamed answer arrives piece by piece, and other responses are still gzipped', async () => {
  const app = express();
  app.use(sseAwareCompression());
  app.get('/stream', async (_req, res) => {
    res.setHeader('content-type', 'text/event-stream');
    for (let i = 0; i < 4; i++) { res.write(`data: {"n":${i}}\n\n`); await new Promise((r) => setTimeout(r, 150)); }
    res.end('data: [DONE]\n\n');
  });
  app.get('/json', (_req, res) => { res.json({ text: 'x'.repeat(5000) }); });
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const s = await arrivals(`${base}/stream`);
    assert.equal(s.encoding, undefined, 'the stream is not compressed');
    assert.ok(s.times.length >= 4, `pieces arrived separately (${s.times.length})`);
    assert.ok(s.times[0]! < 100, `the first piece came before the answer finished (${s.times[0]}ms)`);
    const j = await arrivals(`${base}/json`);
    assert.equal(j.encoding, 'gzip');
  } finally { await new Promise<void>((r) => server.close(() => r())); }
});
