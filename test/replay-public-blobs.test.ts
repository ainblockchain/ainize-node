import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIdentity, LocalLedger } from '@ainize/core';

const { validateReplayManifest } = await import('../scripts/replay-public-blobs.mjs');

test('original-body replay accepts original signatures without modifying their records', async context => {
  const identity = createIdentity();
  const ledger = new LocalLedger(':memory:', identity);
  await ledger.init();
  context.after(() => ledger.close());
  const record = await ledger.append('anchor', { id: 'original', author: identity.address, price: '0', patch_sha256: 'a'.repeat(64), size_bytes: 64 });
  const manifest = { version: 1, records: [record] };
  const before = JSON.stringify(manifest);
  assert.deepEqual(validateReplayManifest(manifest), [record.body]);
  assert.equal(JSON.stringify(manifest), before);
});

test('original-body replay rejects nonpublic, paid, duplicate, forged and oversized anchors', async context => {
  const identity = createIdentity();
  const ledger = new LocalLedger(':memory:', identity);
  await ledger.init();
  context.after(() => ledger.close());
  const anchor = { id: 'original', author: identity.address, price: '0', patch_sha256: 'a'.repeat(64), size_bytes: 64 };
  for (const changes of [{ visibility: 'test' }, { visibility: 'private' }, { price: '1' }, { author: createIdentity().address }, { size_bytes: 0 }, { size_bytes: 256 * 1024 ** 2 + 1 }, { patch_sha256: '../escape' }]) {
    const record = await ledger.append('anchor', { ...anchor, ...changes });
    assert.throws(() => validateReplayManifest({ version: 1, records: [record] }));
  }
  const record = await ledger.append('anchor', anchor);
  assert.throws(() => validateReplayManifest({ version: 1, records: [record, record] }));
  assert.throws(() => validateReplayManifest({ version: 1, records: [{ ...record, hash: '0'.repeat(64) }] }));
  assert.throws(() => validateReplayManifest({ version: 1, records: [] }));
  assert.throws(() => validateReplayManifest({ version: 2, records: [record] }));
});
