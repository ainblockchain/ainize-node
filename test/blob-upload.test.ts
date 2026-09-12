import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type RequestListener } from 'node:http';
import { uploadBlob } from '../src/blob-upload.js';

async function fixture(context: TestContext, handler: RequestListener) {
  const directory = mkdtempSync(join(tmpdir(), 'ainize-upload-'));
  const file = join(directory, 'body.npz');
  writeFileSync(file, '');
  truncateSync(file, 32 * 1024 ** 2);
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  });
  return { file, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/p2p/blob/${'a'.repeat(64)}` };
}

test('streamed upload encodes exactly one file with bounded chunks and a correct content length', async context => {
  const bytes = Buffer.alloc(2 * 1024 ** 2, 7);
  let received = 0;
  const setup = await fixture(context, async (request, response) => {
    assert.equal(request.headers['x-ainize-auth'], 'test-authorization');
    const chunks: Buffer[] = [];
    for await (const chunk of request) { received += chunk.length; chunks.push(chunk); }
    const body = Buffer.concat(chunks);
    assert.equal(received, Number(request.headers['content-length']));
    const boundary = request.headers['content-type']!.split('boundary=')[1];
    const prefix = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="blob"; filename="${'a'.repeat(64)}.npz"\r\nContent-Type: application/octet-stream\r\n\r\n`);
    const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
    assert.deepEqual(body, Buffer.concat([prefix, bytes, suffix]));
    response.setHeader('content-type', 'application/json');
    response.end('{"ok":true}');
  });
  writeFileSync(setup.file, bytes);
  assert.deepEqual(await uploadBlob(setup.url, 'a'.repeat(64), setup.file, 'test-authorization'), { status: 200, contentType: 'application/json', body: '{"ok":true}' });
  assert.ok(received > bytes.length);
});

test('large files survive repeated early acknowledgments, refusals and redirects without following them', async context => {
  let mode = 200;
  let requests = 0;
  const setup = await fixture(context, (_request, response) => {
    requests++;
    response.writeHead(mode, { 'content-type': mode === 404 ? 'text/html' : 'application/json', location: '/unexpected' });
    response.end(mode === 404 ? 'Cannot POST' : '{"already_held":true}');
  });
  for (mode of [200, 403, 404, 307]) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const response = await uploadBlob(setup.url, 'a'.repeat(64), setup.file, 'test-authorization');
      assert.equal(response.status, mode);
    }
  }
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(requests, 40);
});

test('oversized acknowledgments, broken sockets and stalled responses fail within bounds', async context => {
  let mode = 'oversized';
  const setup = await fixture(context, (request, response) => {
    if (mode === 'oversized') { response.end('x'.repeat(5000)); return; }
    if (mode === 'broken') { request.socket.destroy(); return; }
    response.writeHead(200);
    const timer = setInterval(() => response.write(' '), 10);
    response.once('close', () => clearInterval(timer));
  });
  await assert.rejects(uploadBlob(setup.url, 'a'.repeat(64), setup.file, 'test', 2000), /acknowledgment exceeds/);
  mode = 'broken';
  await assert.rejects(uploadBlob(setup.url, 'a'.repeat(64), setup.file, 'test', 2000));
  mode = 'stalled';
  await assert.rejects(uploadBlob(setup.url, 'a'.repeat(64), setup.file, 'test', 100), /deadline/);
});

test('invalid destinations, file sizes, hashes and deadlines are refused before HTTP', async context => {
  let requests = 0;
  const setup = await fixture(context, (_request, response) => { requests++; response.end('{}'); });
  for (const destination of ['file:///private/config.json', setup.url.replace('http://', 'http://user:password@'), `${setup.url}#fragment`]) {
    await assert.rejects(uploadBlob(destination, 'a'.repeat(64), setup.file, 'test'));
  }
  await assert.rejects(uploadBlob(setup.url, '../bad', setup.file, 'test'));
  await assert.rejects(uploadBlob(setup.url, 'a'.repeat(64), `${setup.file}.missing`, 'test'));
  for (const deadline of [0, 60_001, NaN]) await assert.rejects(uploadBlob(setup.url, 'a'.repeat(64), setup.file, 'test', deadline));
  for (const size of [0, 256 * 1024 ** 2 + 1]) {
    truncateSync(setup.file, size);
    await assert.rejects(uploadBlob(setup.url, 'a'.repeat(64), setup.file, 'test'));
  }
  assert.equal(requests, 0);
});
