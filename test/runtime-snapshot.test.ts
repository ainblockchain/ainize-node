import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { compareSnapshots, inventory, jobBindings, requireIdle } from '../deploy/runtime-snapshot.mjs';

const info = { runtime: { available: true, applied: [], queue: { running: null, waiting: 0, queued: [], lock: null } } };
const jobs = { items: [{ id: 'job-one', status: 'READY', dataset: { id: 'dataset-one', sha256: 'body-hash' }, result: { sha256: 'patch-hash' }, checks: { executed: true } }] };

test('maintenance requires terminal jobs and an idle, empty runtime', () => {
  requireIdle(info, jobs);
  assert.throws(() => requireIdle(info, { items: [{ ...jobs.items[0], status: 'TRAINING' }] }));
  for (const queue of [{ running: 'chat' }, { waiting: 1 }, { lock: { pid: 1 } }, { queued: ['chat'] }]) {
    assert.throws(() => requireIdle({ runtime: { ...info.runtime, queue: { ...info.runtime.queue, ...queue } } }, jobs));
  }
  assert.throws(() => requireIdle({ runtime: { ...info.runtime, applied: [{ id: 'foreign' }] } }, jobs));
});

test('explicit trainer-root links are hashed as bodies, never treated as missing or followed outside the root', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'ainize-linked-body-'));
  try {
    const trainer = path.join(home, 'trainer');
    await mkdir(trainer);
    await mkdir(path.join(home, 'data/teach/datasets'), { recursive: true });
    await mkdir(path.join(home, 'data/drive/patches'), { recursive: true });
    const body = Buffer.from('trained-fixture');
    const sha = createHash('sha256').update(body).digest('hex');
    await writeFile(path.join(trainer, 'lesson.npz'), body);
    await symlink(path.join(trainer, 'lesson.npz'), path.join(home, `data/drive/patches/${sha}.npz`));
    await assert.rejects(inventory(home), /symlink/);
    const files = await inventory(home, trainer);
    assert.equal(files[`data/drive/patches/${sha}.npz`].sha256, sha);
    assert.equal(files['trainer/lesson.npz'].sha256, sha);
    await writeFile(path.join(trainer, 'lesson.npz'), 'different');
    await assert.rejects(inventory(home, trainer), /content-addressed/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('maintenance verifies original job bindings, model and bytes without exposing credentials', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'ainize-snapshot-'));
  try {
    await mkdir(path.join(home, 'data/teach/datasets'), { recursive: true });
    await mkdir(path.join(home, 'data/drive/patches'), { recursive: true });
    await writeFile(path.join(home, 'data/teach/datasets/questions.jsonl'), 'questions');
    await writeFile(path.join(home, 'data/drive/patches/body.npz'), 'body');
    await writeFile(path.join(home, 'config.json'), 'PRIVATE-NOT-FOR-INVENTORY');
    const before = { jobs: jobBindings(jobs), files: await inventory(home), runtime: { model: 'model-one' }, nodeAddress: 'publisher' };
    assert.equal(Object.keys(before.files).length, 2);
    compareSnapshots(before, structuredClone(before));
    const after = structuredClone(before);
    after.jobs[0].result.sha256 = 'different';
    assert.throws(() => compareSnapshots(before, after));
    await writeFile(path.join(home, 'data/drive/patches/body.npz'), 'tampered');
    assert.throws(() => compareSnapshots(before, { ...before, files: {} }));
    const changed = await inventory(home);
    assert.throws(() => compareSnapshots(before, { ...before, files: changed }));
    assert.throws(() => compareSnapshots(before, { ...before, runtime: { model: 'different' } }));
    await symlink(path.join(home, 'config.json'), path.join(home, 'data/drive/patches/secret'));
    await assert.rejects(inventory(home), /symlink/);
  } finally { await rm(home, { recursive: true, force: true }); }
});
