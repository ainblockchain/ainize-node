import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimSharedLease, leaseLiveness, reclaimDeadSharedLease } from '../src/shared-lease.js';
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

test('a lease whose holder provably died is taken back — the restart-mid-chat case — and nothing else is', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ainize-runtime-dead-lease-'));
  const directory = join(root, '.ainize-runtime.lock');
  try {
    // A real pid that has exited, in this boot and namespace: what a node killed by a deploy leaves behind.
    const { spawnSync } = await import('node:child_process');
    const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    const deadPid = Number(child.stdout);
    const release = claimSharedLease(directory, { owner: `pid:${deadPid}`, label: 'chat:base', since: Date.now() - 60_000 });
    assert.ok(release);
    const runtime = new Runtime({ patchDir: root });
    if (process.platform !== 'linux') return;   // liveness is only provable where /proc says so
    assert.equal(runtime.lockHolder()?.liveness, 'dead');

    let entered = false;
    await runtime.exclusiveTry('chat:base', async () => { entered = true; assert.equal(runtime.lockHolder()?.mine, true); }, { waitMs: 2_000 });
    assert.equal(entered, true, 'the model is usable again without anybody deleting a directory');
    assert.ok(!existsSync(directory));

    // A live holder is never taken, however old.
    const live = claimSharedLease(directory, { owner: `pid:${process.pid}`, label: 'training', since: 1 });
    assert.equal(reclaimDeadSharedLease(directory), false);
    assert.ok(existsSync(directory));
    live!();
    // Nor one from another namespace, which this process cannot see into.
    claimSharedLease(directory, { owner: `pid:${deadPid}`, since: 1 });
    const holder = JSON.parse(readFileSync(join(directory, 'holder.json'), 'utf8'));
    writeFileSync(join(directory, 'holder.json'), JSON.stringify({ ...holder, process_scope: { ...holder.process_scope, namespace: 'foreign' } }));
    assert.equal(reclaimDeadSharedLease(directory), false);
    assert.ok(existsSync(directory));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
