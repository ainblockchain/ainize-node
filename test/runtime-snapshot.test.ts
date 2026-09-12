import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { compareSnapshots, inventory, jobBindings, operatorJobs, requireIdle } from '../deploy/runtime-snapshot.mjs';

const info = { runtime: { available: true, applied: [], queue: { running: null, waiting: 0, queued: [], lock: null } } };
const jobs = { items: [{ id: 'job-one', status: 'READY', dataset: { id: 'dataset-one', sha256: 'body-hash' }, result: { sha256: 'patch-hash' }, checks: { executed: true } }] };

test('maintenance enumerates every operator-visible job, not only one teaching key owner', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'ainize-operator-jobs-'));
  try {
    await writeFile(path.join(home, 'cli.json'), JSON.stringify({ nodeUrl: 'http://localhost:3410', token: 'fixture-token' }), { mode: 0o600 });
    const allJobs = { items: [...jobs.items, { id: 'another-owner', status: 'TRAINING' }] };
    const result = await operatorJobs(home, async (url, options) => {
      assert.equal(url.pathname, '/api/me/teach/jobs');
      assert.equal(options.headers.authorization, 'Bearer fixture-token');
      assert.equal(options.redirect, 'error');
      return new Response(JSON.stringify(allJobs), { headers: { 'content-type': 'application/json' } });
    });
    assert.equal(result.items.length, 2);
    assert.throws(() => requireIdle(info, result), /unfinished/);
    await assert.rejects(operatorJobs(home, async () => new Response('frontend HTML')), /HTTP/);
    await assert.rejects(operatorJobs(home, async () => new Response('{}', { status: 401 })), /401/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

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
