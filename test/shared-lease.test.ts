import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimSharedLease, leaseLiveness } from '../src/shared-lease.js';
import { Runtime } from '../src/runtime.js';

test('shared leases exclude other owners and only release their own token', () => {
  const root = mkdtempSync(join(tmpdir(), 'ainize-lease-'));
  const directory = join(root, 'lease');
  try {
    const release = claimSharedLease(directory, { owner: `pid:${process.pid}`, since: 1 });
    assert.ok(release);
    const holder = JSON.parse(readFileSync(join(directory, 'holder.json'), 'utf8'));
    assert.equal(claimSharedLease(directory, { owner: 'another' }), null);
    assert.equal(leaseLiveness(holder), process.platform === 'linux' ? 'alive' : 'unknown');
    assert.equal(leaseLiveness({ ...holder, process_scope: { ...holder.process_scope, namespace: 'foreign' } }), 'unknown');
    assert.equal(leaseLiveness({ owner: 'pid:999999' }), 'unknown');
    writeFileSync(join(directory, 'holder.json'), JSON.stringify({ ...holder, lease_id: 'replacement' }));
    release();
    assert.ok(existsSync(directory));
    rmSync(directory, { recursive: true });
    const nextRelease = claimSharedLease(directory, { owner: 'next' });
    assert.ok(nextRelease);
    release();
    assert.ok(existsSync(directory));
    nextRelease();
    assert.ok(!existsSync(directory));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('runtime does not evict old, foreign, legacy or incomplete leases', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ainize-runtime-lease-'));
  const directory = join(root, '.ainize-runtime.lock');
  const runtime = new Runtime({ patchDir: root });
  try {
    for (const holder of [null, {}, { owner: 'pid:999999', label: 'training', since: 1 }]) {
      mkdirSync(directory);
      if (holder) writeFileSync(join(directory, 'holder.json'), JSON.stringify(holder));
      assert.equal(runtime.lockHolder()?.liveness, 'unknown');
      let entered = false;
      await assert.rejects(runtime.exclusiveTry('test', async () => { entered = true; }, { waitMs: 1 }), /shared runtime busy/);
      assert.equal(entered, false);
      assert.ok(existsSync(directory));
      rmSync(directory, { recursive: true });
    }
    const observer = new Runtime({ patchDir: root });
    await runtime.exclusiveTry('test', async () => {
      assert.equal(runtime.lockHolder()?.mine, true);
      assert.equal(observer.lockHolder()?.mine, false);
    });
    assert.ok(!existsSync(directory));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
