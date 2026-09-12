import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { defaultConfig, loadConfig, LocalLedger, saveConfig } from '@ainize/core';
import { authHeader, gcRun, sha256File, startNode } from '../dist/index.js';
import { uploadBlob } from '../dist/blob-upload.js';

const emit = result => process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...result })}\n`);
const origin = 'http://relay:3400';
const maximumBody = 256 * 1024 ** 2;

export function validateReplayManifest(manifest) {
  assert.equal(manifest?.version, 1, 'unsupported manifest');
  assert.ok(Array.isArray(manifest.records) && manifest.records.length > 0 && manifest.records.length <= 16, 'select 1–16 original anchors');
  const hashes = new Set();
  const ids = new Set();
  for (const record of manifest.records) {
    assert.equal(record?.kind, 'anchor');
    assert.ok(LocalLedger.validate(record), 'invalid original anchor signature');
    const anchor = record.body;
    assert.equal(anchor.author.toLowerCase(), record.author.toLowerCase(), 'anchor author mismatch');
    assert.ok(typeof anchor.id === 'string' && anchor.id.length > 0 && !ids.has(anchor.id), 'duplicate or empty knowledge ID');
    assert.match(anchor.patch_sha256, /^[0-9a-f]{64}$/);
    assert.ok(!hashes.has(anchor.patch_sha256), 'duplicate blob');
    assert.equal(anchor.price, '0', 'only already-public free bodies may be replayed');
    assert.ok(anchor.visibility === undefined || anchor.visibility === 'public', 'nonpublic anchor');
    assert.ok(Number.isSafeInteger(anchor.size_bytes) && anchor.size_bytes > 0 && anchor.size_bytes <= maximumBody, 'invalid body size');
    ids.add(anchor.id);
    hashes.add(anchor.patch_sha256);
  }
  return manifest.records.map(record => record.body);
}

async function jsonRequest(path, options = {}) {
  const response = await fetch(`${origin}${path}`, { ...options, redirect: 'error', signal: AbortSignal.timeout(60_000) });
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    assert.ok(size <= 1024 ** 2, 'response too large');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  let body;
  try { body = JSON.parse(raw); } catch { body = raw; }
  emit({ stage: 'http', method: options.method ?? 'GET', path, status: response.status, body });
  return { status: response.status, body };
}

async function readBack(anchor, identity) {
  const sha = anchor.patch_sha256;
  const response = await fetch(`${origin}/p2p/blob/${sha}`, {
    headers: { 'x-ainize-auth': authHeader(identity, `blob:${sha}`) },
    redirect: 'error', signal: AbortSignal.timeout(60_000),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-content-sha256'), sha);
  const digest = createHash('sha256');
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    assert.ok(size <= anchor.size_bytes, 'read-back exceeds signed size');
    digest.update(chunk);
  }
  const actualSha = digest.digest('hex');
  assert.equal(size, anchor.size_bytes);
  assert.equal(actualSha, sha);
  emit({ stage: 'read-back', patchId: anchor.id, sha256: actualSha, sizeBytes: size, verified: true });
}

async function receiver(anchors) {
  const home = '/private/receiver';
  let cfg = loadConfig(home);
  if (!cfg) {
    cfg = defaultConfig({ home, name: 'isolated-original-body-relay', host: '0.0.0.0', port: 3400, peers: [], roles: ['seller'], ledger: 'local' });
    cfg.runtime = { api: 'http://127.0.0.1:1', hookApi: 'http://127.0.0.1:1' };
    cfg.verifier = { ...cfg.verifier, auto: false };
    cfg.p2p = { relayBlobs: true, maxRelayBytes: anchors.reduce((total, anchor) => total + anchor.size_bytes, 0) };
    saveConfig(cfg, home);
  }
  assert.equal(cfg.ledger.kind, 'local');
  assert.deepEqual(cfg.peers, []);
  assert.deepEqual(cfg.roles, ['seller']);
  assert.equal(cfg.runtime.api, 'http://127.0.0.1:1');
  assert.equal(cfg.runtime.hookApi, 'http://127.0.0.1:1');
  const node = await startNode(cfg, { home, quiet: true, serveWeb: false, teachWorker: false });
  const snapshot = async stage => {
    const blobs = [];
    for (const blob of node.market.blobs.list()) {
      const actualSha = await sha256File(blob.path);
      assert.equal(actualSha, blob.sha256);
      assert.ok(node.market.blobs.isRelayed(blob.sha256), 'missing durable relay retention');
      blobs.push({ sha256: actualSha, sizeBytes: statSync(blob.path).size, relayed: true });
    }
    const collected = await gcRun(node.market, { allowSoleCopy: true, keepPurchased: false });
    assert.equal(collected.removed.length, 0);
    emit({ stage, receiver: cfg.identity.address, blobs, gcRemoved: collected.removed.length, gcKeptRelayed: collected.kept.relayed, anchors: (await node.ledger.anchors()).map(record => ({ hash: record.hash, id: record.body.id })) });
  };
  await snapshot('receiver-start');
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try { await snapshot('receiver-stop'); await node.stop(); process.exit(0); }
    catch (error) { emit({ stage: 'error', error: error.message }); process.exit(1); }
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function client(mode, manifest, anchors) {
  const cfg = JSON.parse(readFileSync('/private/publisher.json', 'utf8'));
  const identity = cfg.identity;
  assert.match(identity?.privateKey ?? '', /^[0-9a-fA-F]{64}$/);
  for (const anchor of anchors) {
    assert.equal(identity.address.toLowerCase(), anchor.author.toLowerCase(), 'only the original author can replay');
    if (mode === 'send') {
      const file = `/bodies/${anchor.patch_sha256}.npz`;
      assert.ok(existsSync(file), 'original body missing');
      assert.equal(statSync(file).size, anchor.size_bytes);
      assert.equal(await sha256File(file), anchor.patch_sha256);
    }
  }
  const before = await jsonRequest('/p2p/blobs');
  assert.equal(before.status, 200);
  assert.equal(before.body.blobs.length, mode === 'send' ? 0 : anchors.length);
  if (mode === 'send') {
    const first = anchors[0];
    const path = `/p2p/blob/${first.patch_sha256}`;
    const missing = await jsonRequest(path);
    assert.equal(missing.status, 404);
    assert.equal(typeof missing.body, 'object');
    const unauthenticated = await jsonRequest(path, { method: 'POST' });
    assert.equal(unauthenticated.status, 403);
    assert.equal(typeof unauthenticated.body, 'object');
    const unknown = await jsonRequest(path, { method: 'POST', headers: { 'x-ainize-auth': authHeader(identity, `blob:${first.patch_sha256}`) } });
    assert.equal(unknown.status, 404);
    assert.match(unknown.body.error, /anchor/);
    const announced = await jsonRequest('/p2p/records', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ records: manifest.records }) });
    assert.equal(announced.status, 200);
    assert.equal(announced.body.added, anchors.length);
    assert.deepEqual(announced.body.rejected, []);
    for (const duplicate of [false, true]) {
      for (const anchor of anchors) {
        const sha = anchor.patch_sha256;
        const path = `/p2p/blob/${sha}`;
        const response = await uploadBlob(`${origin}${path}`, sha, `/bodies/${sha}.npz`, authHeader(identity, `blob:${sha}`));
        const receipt = { status: response.status, body: JSON.parse(response.body) };
        emit({ stage: 'http', method: 'POST', path, ...receipt });
        assert.equal(receipt.status, 200);
        assert.deepEqual(receipt.body, { ok: true, sha256: sha, size_bytes: anchor.size_bytes, already_held: duplicate });
        await readBack(anchor, identity);
      }
    }
  } else {
    for (const anchor of anchors) await readBack(anchor, identity);
  }
  const after = await jsonRequest('/p2p/blobs');
  assert.equal(after.status, 200);
  assert.deepEqual(after.body.blobs.map(blob => blob.sha256).sort(), anchors.map(anchor => anchor.patch_sha256).sort());
  const records = await jsonRequest('/p2p/records?since=0&limit=100');
  assert.equal(records.status, 200);
  const finalAnchors = records.body.records.filter(record => record.kind === 'anchor');
  assert.deepEqual(finalAnchors.map(record => record.hash).sort(), manifest.records.map(record => record.hash).sort());
  emit({ stage: 'complete', mode, verifiedBodies: anchors.length, anchorHashesUnchanged: true, publicDelivery: false, liveInference: false });
}

export async function main() {
  const mode = process.argv[2];
  assert.ok(['receiver', 'send', 'check'].includes(mode), 'usage: replay-public-blobs.mjs receiver|send|check');
  const manifest = JSON.parse(readFileSync('/input/manifest.json', 'utf8'));
  const anchors = validateReplayManifest(manifest);
  if (mode === 'receiver') await receiver(anchors);
  else await client(mode, manifest, anchors);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { emit({ stage: 'error', error: error.message }); process.exitCode = 1; });
}
