import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request } from 'node:http';
import { execFileSync } from 'node:child_process';
import { createIdentity, defaultConfig, LocalLedger, sha256Hex, writeNpz, type PatchAnchor } from '@ainize/core';
import { startNode } from '../src/server.js';
import { authHeader, P2P } from '../src/p2p.js';
import { inspectReplicaNpz } from '../src/replica-npz.js';
import { Verifier } from '../src/verifier.js';
import { Store } from '../src/store.js';
import { BlobStore } from '../src/blobs.js';
import { gcPlan } from '../src/gc.js';

async function fixture(context: TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'ainize-relay-'));
  const cfg = defaultConfig({ home, name: 'relay-test', port: 34951, peers: [], roles: ['seller'], ledger: 'local' });
  cfg.runtime = { api: 'http://127.0.0.1:1', hookApi: 'http://127.0.0.1:1' };
  cfg.verifier = { ...cfg.verifier!, auto: false, intervalMs: 300_000 };
  cfg.p2p = { relayBlobs: true, maxRelayBytes: 1024 ** 2 };
  const node = await startNode(cfg, { quiet: true, serveWeb: false, teachWorker: false, listen: false });
  await new Promise<void>(resolve => node.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(node.server.address() as { port: number }).port}`;
  const author = createIdentity();
  const publisher = new LocalLedger(join(home, 'publisher.sqlite'), author);
  await publisher.init();
  context.after(async () => { await node.stop(); await publisher.close(); rmSync(home, { recursive: true, force: true }); });
  const file = join(home, 'lesson.npz');
  const addresses = Buffer.alloc(8); addresses.writeBigInt64LE(123n);
  writeNpz(file, [
    { name: 'addrs', descr: '<i8', shape: [1], body: addresses },
    { name: 'before', descr: '<f4', shape: [1, 2], body: Buffer.alloc(8) },
    { name: 'after', descr: '<f4', shape: [1, 2], body: Buffer.alloc(8, 1) },
  ]);
  const bytes = readFileSync(file);
  const sha = sha256Hex(bytes);
  const anchor: PatchAnchor = {
    id: 'relay-lesson', name: 'Synthetic relay fixture', description: '', author: author.address,
    model: { id_M: 'test-only', row_dim: 2 }, patch_sha256: sha, size_bytes: bytes.length, rows: 1,
    benchmark: { schema: 'test-only', queries: 1, format: ['template'] }, benchmark_hash: sha,
    price: '0', currency: 'CREDIT', billing: 'per_download', parents: [], parent_authors: [], topic_path: 'test', created_at: Date.now(),
  };
  const publish = async (overrides: Partial<PatchAnchor> = {}) => {
    const record = await publisher.append('anchor', { ...anchor, ...overrides });
    assert.ok(LocalLedger.validate(record));
    await node.ledger.ingest(record); node.market.invalidate();
  };
  const offer = async (body = bytes, signature = authHeader(author, `blob:${sha}`), hash = sha) => {
    const form = new FormData(); form.append('blob', new Blob([body]), 'lesson.npz');
    return fetch(`${url}/p2p/blob/${hash}`, { method: 'POST', headers: { 'x-ainize-auth': signature }, body: form });
  };
  const clean = () => assert.deepEqual(readdirSync(join(cfg.dataDir, 'uploads')), []);
  const sender = new P2P({ identity: author, ledger: publisher, store: node.store, selfInfo: () => node.market.selfInfo(), log: () => {} }, [], 60_000, 'http://127.0.0.1:1');
  return { node, cfg, url, author, publisher, file, bytes, sha, anchor, publish, offer, clean, sender };
}

test('signed outbound push imports the exact body, is idempotent, and advertises its hash', async context => {
  const setup = await fixture(context); await setup.publish();
  const first = await setup.offer();
  assert.equal(first.status, 200, await first.text());
  assert.deepEqual(await setup.sender.offerBlob(setup.sha, setup.file, [setup.url]), [setup.url]);
  const held = setup.node.market.blobs.get(setup.sha)!;
  assert.deepEqual(readFileSync(held.path), setup.bytes);
  assert.ok((await setup.node.market.selfInfo()).blobs.includes(setup.sha));
  const duplicate = await setup.offer();
  assert.equal(duplicate.status, 200);
  assert.deepEqual(await duplicate.json(), { ok: true, sha256: setup.sha, size_bytes: setup.bytes.length, already_held: true });
  assert.equal((await setup.node.market.entry(setup.anchor.id))?.status, 'ANNOUNCED');
  setup.clean();
});

test('disabled, zero/unset budget, malformed SHA and unauthenticated offers never leave uploads', async context => {
  const setup = await fixture(context); await setup.publish();
  setup.cfg.p2p!.relayBlobs = false;
  assert.equal((await setup.offer()).status, 403); setup.clean();
  setup.cfg.p2p!.relayBlobs = true;
  for (const budget of [0, undefined]) {
    setup.cfg.p2p!.maxRelayBytes = budget;
    assert.equal((await setup.offer()).status, 403); setup.clean();
  }
  setup.cfg.p2p!.maxRelayBytes = 1024 ** 2;
  assert.equal((await setup.offer(setup.bytes, '', 'invalid')).status, 400); setup.clean();
  assert.equal((await setup.offer(setup.bytes, '')).status, 403); setup.clean();
});

test('unknown, draft, test and foreign-author bodies are refused before multipart parsing', async context => {
  const setup = await fixture(context);
  assert.equal((await setup.offer()).status, 404);
  setup.node.store.putDraft(setup.anchor, setup.file);
  setup.node.market.invalidate();
  assert.equal((await setup.offer()).status, 404);
  await setup.publish({ visibility: 'test' });
  assert.equal((await setup.offer()).status, 404);
  await setup.publish({ id: 'public-lesson' });
  assert.equal((await setup.offer(setup.bytes, authHeader(createIdentity(), `blob:${setup.sha}`))).status, 403);
  setup.clean();
});

test('shared content chooses the matching signed author, not the first anchor', async context => {
  const setup = await fixture(context);
  const stranger = createIdentity();
  const foreign = new LocalLedger(':memory:', stranger);
  await foreign.init(); context.after(() => foreign.close());
  const record = await foreign.append('anchor', { ...setup.anchor, id: 'foreign-first', author: stranger.address });
  await setup.node.ledger.ingest(record);
  await setup.publish();
  assert.equal((await setup.offer()).status, 200);
});

test('wrong hash, wrong size and oversized multipart are rejected and cleaned up', async context => {
  const setup = await fixture(context); await setup.publish();
  assert.equal((await setup.offer(Buffer.alloc(setup.bytes.length))).status, 400);
  assert.equal((await setup.offer(setup.bytes.subarray(1))).status, 400);
  assert.equal((await setup.offer(Buffer.alloc(setup.bytes.length + 2))).status, 413);
  assert.equal(setup.node.market.blobs.has(setup.sha), false);
  setup.clean();
  assert.equal((await setup.offer()).status, 200);
});

test('storage cap is cumulative, and a held body is still idempotent at the cap', async context => {
  const setup = await fixture(context); await setup.publish();
  setup.cfg.p2p!.maxRelayBytes = setup.bytes.length;
  assert.equal((await setup.offer()).status, 200);
  assert.equal((await setup.offer()).status, 200);
  const other = Buffer.from(setup.bytes); other[50] ^= 1;
  const otherSha = sha256Hex(other);
  await setup.publish({ id: 'second-lesson', patch_sha256: otherSha });
  assert.equal((await setup.offer(other, authHeader(setup.author, `blob:${otherSha}`), otherSha)).status, 413);
  setup.clean();
});

test('in-flight reservations prevent concurrent budget oversubscription and release on abort', async context => {
  const setup = await fixture(context); await setup.publish();
  setup.cfg.p2p!.maxRelayBytes = setup.bytes.length;
  const first = request(`${setup.url}/p2p/blob/${setup.sha}`, { method: 'POST', headers: {
    'content-type': 'multipart/form-data; boundary=relay-test', 'x-ainize-auth': authHeader(setup.author, `blob:${setup.sha}`),
  } });
  first.on('error', () => {});
  first.write('--relay-test\r\nContent-Disposition: form-data; name="blob"; filename="lesson.npz"\r\nContent-Type: application/octet-stream\r\n\r\n');
  first.write(setup.bytes.subarray(0, 100));
  for (let attempt = 0; attempt < 100 && readdirSync(join(setup.cfg.dataDir, 'uploads')).length === 0; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await setup.offer()).status, 409);
  const otherSha = 'b'.repeat(64);
  await setup.publish({ id: 'concurrent-lesson', patch_sha256: otherSha });
  assert.equal((await setup.offer(setup.bytes, authHeader(setup.author, `blob:${otherSha}`), otherSha)).status, 413);
  first.destroy();
  for (let attempt = 0; attempt < 100 && readdirSync(join(setup.cfg.dataDir, 'uploads')).length > 0; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  setup.clean();
  assert.equal((await setup.offer()).status, 200);
});

test('corrupt held or orphan destination files are never acknowledged as valid', async context => {
  const setup = await fixture(context); await setup.publish();
  const destination = setup.node.market.blobs.pathFor(setup.sha);
  writeFileSync(destination, Buffer.alloc(setup.bytes.length));
  assert.equal((await setup.offer()).status, 409); setup.clean();
  rmSync(destination);
  assert.equal((await setup.offer()).status, 200);
  writeFileSync(destination, Buffer.alloc(setup.bytes.length));
  assert.equal((await setup.offer()).status, 409); setup.clean();
});

test('malformed signed NPZ and mismatched anchored dimensions never enter storage', async context => {
  const setup = await fixture(context);
  const invalid = Buffer.alloc(setup.bytes.length);
  const invalidSha = sha256Hex(invalid);
  await setup.publish({ patch_sha256: invalidSha });
  assert.equal((await setup.offer(invalid, authHeader(setup.author, `blob:${invalidSha}`), invalidSha)).status, 400);
  await setup.publish({ id: 'wrong-dimensions', rows: 999 });
  assert.equal((await setup.offer()).status, 400);
  setup.clean();
});

test('NPZ preflight bounds encoded and expanded bytes and rejects truncated arrays', async context => {
  const setup = await fixture(context);
  assert.equal(inspectReplicaNpz(setup.file, setup.bytes.length, 1024 ** 2).rows, 1);
  assert.throws(() => inspectReplicaNpz(setup.file, 1, 1024 ** 2), /archive exceeds/);
  assert.throws(() => inspectReplicaNpz(setup.file, setup.bytes.length, 1), /expanded arrays/);
  writeFileSync(setup.file, setup.bytes.subarray(0, -1));
  assert.throws(() => inspectReplicaNpz(setup.file, setup.bytes.length, 1024 ** 2));
});

test('compressed NumPy archives work and a forged expansion length is bounded', async context => {
  const setup = await fixture(context);
  execFileSync('python3', ['-c', 'import numpy as np, sys; archive = np.load(sys.argv[1]); arrays = {name: archive[name] for name in archive.files}; archive.close(); np.savez_compressed(sys.argv[1], **arrays)', setup.file]);
  const compressed = readFileSync(setup.file);
  assert.equal(inspectReplicaNpz(setup.file, 1024 ** 2, 1024 ** 2).rowDim, 2);
  const directory = compressed.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(directory > 0);
  compressed.writeUInt32LE(10, directory + 24);
  writeFileSync(setup.file, compressed);
  assert.throws(() => inspectReplicaNpz(setup.file, 1024 ** 2, 1024 ** 2));
});

test('sender contains file errors and rejects HTML, wrong hash, oversized acknowledgments and redirects', async context => {
  const setup = await fixture(context);
  assert.deepEqual(await setup.sender.offerBlob(setup.sha, `${setup.file}.missing`, [setup.url]), []);
  assert.deepEqual(await setup.sender.offerBlob('a'.repeat(64), setup.file, [setup.url]), []);
  let mode = 'html';
  let redirected = 0;
  const peer = createServer((req, res) => {
    req.resume();
    if (req.url === '/unexpected') { redirected++; res.end('{}'); return; }
    if (mode === 'redirect') { res.writeHead(307, { location: '/unexpected' }); res.end(); return; }
    if (mode === 'html') { res.setHeader('content-type', 'text/html'); res.end('ok'); return; }
    res.setHeader('content-type', 'application/json');
    res.end(mode === 'large' ? ' '.repeat(5000) : JSON.stringify({ ok: true, sha256: 'a'.repeat(64), size_bytes: setup.bytes.length }));
  });
  await new Promise<void>(resolve => peer.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise<void>(resolve => peer.close(() => resolve())));
  const endpoint = `http://127.0.0.1:${(peer.address() as { port: number }).port}`;
  for (mode of ['html', 'wrong-hash', 'large', 'redirect']) assert.deepEqual(await setup.sender.offerBlob(setup.sha, setup.file, [endpoint]), []);
  assert.equal(redirected, 0);
});

test('relay retry requires operator login and refuses another author', async context => {
  const setup = await fixture(context); await setup.publish();
  const route = `${setup.url}/api/patches/${setup.anchor.id}/relay`;
  assert.equal((await fetch(route, { method: 'POST' })).status, 401);
  setup.node.store.putSession('relay-test-session', 60_000);
  assert.equal((await fetch(route, { method: 'POST', headers: { authorization: 'Bearer relay-test-session' } })).status, 403);
});

test('operator retries an existing signed knowledge without another publish record or training', async context => {
  const author = await fixture(context);
  const receiver = await fixture(context);
  const record = await author.node.ledger.append('anchor', { ...author.anchor, author: author.cfg.identity.address });
  await receiver.node.ledger.ingest(record);
  author.node.market.invalidate(); receiver.node.market.invalidate();
  await author.node.market.blobs.importFile(author.file, { copy: true });
  author.node.store.upsertPeer(receiver.url, { source: 'configured' });
  author.node.store.putSession('retry-session', 60_000);
  const before = (await author.node.ledger.anchors()).length;
  const response = await fetch(`${author.url}/api/patches/${author.anchor.id}/relay`, {
    method: 'POST', headers: { authorization: 'Bearer retry-session' },
  });
  assert.equal(response.status, 200);
  const receipt = await response.json() as { relayed: boolean; accepted: string[] };
  assert.equal(receipt.relayed, true);
  assert.deepEqual(receipt.accepted, [receiver.url]);
  assert.deepEqual(readFileSync(receiver.node.market.blobs.get(author.sha)!.path), author.bytes);
  assert.equal((await author.node.ledger.anchors()).length, before);
});

test('relayed bodies survive verification cleanup and GC without granting a paid license', async context => {
  const setup = await fixture(context); await setup.publish({ price: '1' });
  assert.equal((await setup.offer()).status, 200);
  const verifier = new Verifier(setup.node.market, 60_000);
  const cleanup = verifier as unknown as { releaseBody: (anchor: PatchAnchor, sha: string) => Promise<void> };
  await cleanup.releaseBody(setup.anchor, setup.sha);
  assert.equal(setup.node.market.blobs.has(setup.sha), true);
  assert.equal(setup.node.market.licenseOf((await setup.node.market.entry(setup.anchor.id))!), null);
  const plan = await gcPlan(setup.node.market, { allowSoleCopy: true, keepPurchased: false });
  assert.equal(plan.kept.relayed, 1);
  assert.deepEqual(plan.candidates, []);
});

test('relay retention persists across database reopening and explicit removal clears it', async context => {
  const setup = await fixture(context); await setup.publish();
  assert.equal((await setup.offer()).status, 200);
  const reopened = new Store(join(setup.cfg.dataDir, 'node.sqlite'));
  try {
    const blobs = new BlobStore(reopened, setup.cfg.dataDir);
    assert.equal(blobs.isRelayed(setup.sha), true);
    blobs.remove(setup.sha);
    assert.equal(blobs.isRelayed(setup.sha), false);
    await blobs.importFile(setup.file, { copy: true });
    assert.equal(blobs.isRelayed(setup.sha), false);
  } finally { reopened.close(); }
});

test('ordinary verification copies still follow the existing release policy', async context => {
  const setup = await fixture(context); await setup.publish({ price: '1' });
  await setup.node.market.blobs.importFile(setup.file, { copy: true });
  const verifier = new Verifier(setup.node.market, 60_000);
  const cleanup = verifier as unknown as { releaseBody: (anchor: PatchAnchor, sha: string) => Promise<void> };
  await cleanup.releaseBody(setup.anchor, setup.sha);
  assert.equal(setup.node.market.blobs.has(setup.sha), false);
});

test('verification cleanup rechecks retention after awaiting the catalog', async context => {
  const setup = await fixture(context); await setup.publish({ price: '1' });
  await setup.node.market.blobs.importFile(setup.file, { copy: true });
  const original = setup.node.market.catalogAll.bind(setup.node.market);
  let releaseCatalog!: () => void;
  const gate = new Promise<void>(resolve => { releaseCatalog = resolve; });
  setup.node.market.catalogAll = async force => { await gate; return original(force); };
  const verifier = new Verifier(setup.node.market, 60_000);
  const cleanup = verifier as unknown as { releaseBody: (anchor: PatchAnchor, sha: string) => Promise<void> };
  try {
    const pending = cleanup.releaseBody(setup.anchor, setup.sha);
    setup.node.market.blobs.markRelayed(setup.sha);
    releaseCatalog();
    await pending;
    assert.equal(setup.node.market.blobs.has(setup.sha), true);
  } finally { releaseCatalog(); setup.node.market.catalogAll = original; }
});
