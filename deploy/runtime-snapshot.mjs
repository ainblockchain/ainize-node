import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile, realpath, stat as fileStat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function requireIdle(info, jobs) {
  const terminal = new Set(['READY', 'FAILED', 'CANCELLED', 'NEEDS_MORE', 'REJECTED', 'ANNOUNCED', 'PENDING_REVIEW']);
  assert.ok(Array.isArray(jobs.items) && jobs.items.length < 500, 'job list is missing or may be truncated');
  assert.ok(jobs.items.every(job => terminal.has(job.status)), 'unfinished teach job; do not restart');
  const runtime = info.runtime;
  assert.equal(runtime?.available, true, 'runtime is unavailable');
  assert.deepEqual(runtime.applied, [], 'runtime has an applied patch');
  assert.equal(runtime.queue?.running, null);
  assert.equal(runtime.queue.waiting, 0);
  assert.equal(runtime.queue.lock, null);
  assert.deepEqual(runtime.queue.queued, []);
}

export function jobBindings(jobs) {
  return jobs.items.map(job => ({ id: job.id, status: job.status, dataset: job.dataset, mode: job.mode,
    context_patch_ids: job.context_patch_ids, draft_id: job.draft_id, result: job.result, checks: job.checks,
  })).sort((left, right) => left.id.localeCompare(right.id));
}

export async function inventory(home, trainerRoot) {
  const files = {};
  const allowed = trainerRoot ? await realpath(trainerRoot) : null;
  async function visit(relative, base = home, prefix = '') {
    let filename = path.join(base, relative);
    let stat = await lstat(filename);
    let target;
    if (stat.isSymbolicLink()) {
      assert.ok(allowed && base === home && /^[a-f0-9]{64}\.npz$/.test(path.basename(relative)), `refusing symlink in evidence inventory: ${relative}`);
      filename = await realpath(filename);
      assert.ok(filename.startsWith(allowed + path.sep), `symlink escapes the explicit trainer root: ${relative}`);
      target = path.relative(allowed, filename);
      stat = await fileStat(filename);
      assert.ok(stat.isFile(), 'linked body must be a regular file');
    }
    if (stat.isDirectory()) {
      for (const name of (await readdir(filename)).sort()) await visit(path.join(relative, name), base, prefix);
    } else {
      assert.ok(stat.isFile(), `unexpected file type: ${relative}`);
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(filename)) hash.update(chunk);
      const sha256 = hash.digest('hex');
      if (target) assert.equal(path.basename(relative, '.npz'), sha256, 'linked body does not match its content-addressed name');
      files[prefix + relative] = { bytes: stat.size, sha256, ...(target ? { trainerTarget: target } : {}) };
    }
  }
  for (const directory of ['data/teach/datasets', 'data/drive/patches']) await visit(directory);
  if (allowed) await visit('', allowed, 'trainer/');
  assert.ok(Object.keys(files).length > 0, 'empty data inventory');
  return files;
}

export function compareSnapshots(before, after) {
  assert.deepEqual(after.jobs, before.jobs, 'job IDs, datasets, trained bodies or checks changed');
  for (const [filename, metadata] of Object.entries(before.files)) {
    assert.deepEqual(after.files[filename], metadata, `existing dataset or trained body changed: ${filename}`);
  }
  assert.deepEqual(after.runtime, before.runtime, 'model runtime identity changed');
  assert.equal(after.nodeAddress, before.nodeAddress, 'publisher identity changed');
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'capture') {
    const [home, jobsPath, infoPath, destination, trainerRoot] = args;
    assert.ok(destination, 'capture <home> <jobs.json> <info.json> <destination.json> [trainer-root]');
    const jobs = JSON.parse(await readFile(jobsPath, 'utf8'));
    const info = JSON.parse(await readFile(infoPath, 'utf8'));
    requireIdle(info, jobs);
    const runtime = Object.fromEntries(['api', 'model', 'hook', 'repo', 'patch_dir'].map(key => [key, info.runtime[key]]));
    const files = await inventory(home, trainerRoot);
    if (trainerRoot) {
      for (const job of jobs.items.filter(item => item.result?.sha256 && item.checks?.executed)) {
        const body = files[`trainer/${job.id}/lesson.npz`];
        assert.equal(body?.sha256, job.result.sha256, `checked job body changed: ${job.id}`);
        assert.equal(body.bytes, job.result.size_bytes, `checked job size changed: ${job.id}`);
      }
    }
    const snapshot = { at: new Date().toISOString(), nodeAddress: info.node.address, runtime, jobs: jobBindings(jobs), files };
    await writeFile(destination, JSON.stringify(snapshot, null, 2) + '\n', { flag: 'wx' });
  } else if (command === 'verify') {
    const [beforePath, afterPath] = args;
    const before = JSON.parse(await readFile(beforePath, 'utf8'));
    const after = JSON.parse(await readFile(afterPath, 'utf8'));
    compareSnapshots(before, after);
    console.log(JSON.stringify({ verified: true, jobs: before.jobs.length, preservedFiles: Object.keys(before.files).length }));
  } else throw new Error('expected capture or verify');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
