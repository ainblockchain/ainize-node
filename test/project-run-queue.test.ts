import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DeploymentLogs, ProjectStore, ProjectWorker, parseRepoUrl } from '../src/projects.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('streamed runs share project FIFO and the node concurrency cap; queued cancellation and stop release waiters', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ainize-run-queue-'));
  try {
    const store = new ProjectStore(join(dir, 'projects.json'));
    const a = store.create({ repo: parseRepoUrl('https://drive.test/org/git/a')!, branch: 'main', kind: 'script' }, 'alice');
    const b = store.create({ repo: parseRepoUrl('https://drive.test/org/git/b')!, branch: 'main', kind: 'script' }, 'bob');
    const worker = new ProjectWorker({ store, logs: new DeploymentLogs(join(dir, 'logs')), run: async () => {}, deployToken: () => null, publicUrl: () => 'https://node.test', maxConcurrent: 1 });
    const run = (p: typeof a) => store.createRun(p, { target: 'head' }, { subject: 'alice' });
    const first = run(a), second = run(a), third = run(b);
    const releaseFirst = await worker.acquireRunSlot(first.id, new AbortController().signal);
    const order: string[] = [];
    const secondSlot = worker.acquireRunSlot(second.id, new AbortController().signal).then((release) => { order.push('a2'); return release; });
    const thirdSlot = worker.acquireRunSlot(third.id, new AbortController().signal).then((release) => { order.push('b'); return release; });
    await tick(); assert.deepEqual(order, [], 'the single node slot is held');
    releaseFirst();
    const releaseSecond = await secondSlot;
    assert.deepEqual(order, ['a2'], 'same-project FIFO precedes the later other-project request');
    releaseSecond(); (await thirdSlot)(); await worker.idle();
    const holding = await worker.acquireRunSlot(run(a).id, new AbortController().signal);
    const cancelled = new AbortController();
    const cancelResult = assert.rejects(worker.acquireRunSlot(run(a).id, cancelled.signal), /cancelled/);
    cancelled.abort(new Error('cancelled')); await cancelResult;
    const stoppedResult = assert.rejects(worker.acquireRunSlot(run(b).id, new AbortController().signal), /stopped/);
    worker.stop(); await stoppedResult; holding(); await worker.idle();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('restart marks interrupted streamed runs failed instead of silently rerunning user code', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ainize-run-restart-'));
  try {
    const file = join(dir, 'projects.json'), store = new ProjectStore(file);
    const project = store.create({ repo: parseRepoUrl('https://drive.test/org/git/a')!, branch: 'main', kind: 'script' }, 'alice');
    const queued = store.createRun(project, { target: 'head' }, { subject: 'alice' });
    const building = store.createRun(project, { target: 'head' }, { subject: 'alice' });
    store.updateDeployment(building.id, { status: 'building' });
    const restored = new ProjectStore(file); let executed = 0;
    const worker = new ProjectWorker({ store: restored, logs: new DeploymentLogs(join(dir, 'logs')), run: async () => { executed++; }, deployToken: () => null, publicUrl: () => 'https://node.test' });
    worker.recover(); await worker.idle();
    assert.equal(executed, 0);
    for (const id of [queued.id, building.id]) { assert.equal(restored.deployment(id)!.status, 'error'); assert.match(restored.deployment(id)!.error!, /restarted/); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
