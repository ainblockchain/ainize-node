import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRuntimeStore, repositoryId, waitForAgentVersion, type RuntimeSource } from '../src/repository-runtime.js';
import { ProjectStore, parseRepoUrl, projectRoot, readTree } from '../src/projects.js';

test('agent source and projection commits are distinct; a failed build preserves the active commit after restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ainize-runtime-'));
  try {
    const file = join(dir, 'agents.json');
    const store = new AgentRuntimeStore(file);
    const source: RuntimeSource = { repoId: repositoryId('https://drive.example/o/git/a'), provider: 'aindrive', url: 'https://drive.example/o/git/a', branch: 'main', path: '', projectId: 'p', sourceCommit: 'a'.repeat(40), writable: false };
    const first = store.begin('agent', source, 'push', 'alice');
    store.finish('agent', first.id, { status: 'ready', version: 1, projectionCommit: 'b'.repeat(40), error: null });
    const next = store.begin('agent', { ...source, sourceCommit: 'c'.repeat(40) }, 'push', 'bob');
    store.finish('agent', next.id, { status: 'error', version: 2, projectionCommit: 'd'.repeat(40), error: 'failed build' });
    const restored = new AgentRuntimeStore(file).get('agent')!;
    assert.equal(restored.activeCommit, 'a'.repeat(40));
    assert.equal(restored.source.sourceCommit, 'c'.repeat(40));
    assert.equal(restored.execution!.projectionCommit, 'd'.repeat(40));
    assert.equal(restored.execution!.actor, 'bob');
    assert.equal(restored.execution!.status, 'error');
    assert.equal(repositoryId('https://drive.example/o/git/a.git/'), source.repoId);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ready for the previous agent version is a failed replacement, not a successful deployment', async () => {
  await assert.rejects(waitForAgentVersion({ status: () => ({ status: 'ready', liveVersion: 1, error: 'v2 did not build' }) }, 'a', 2, 5), /v2 did not build/);
  let count = 0;
  await waitForAgentVersion({ status: () => ({ status: 'ready', liveVersion: ++count >= 2 ? 2 : 1, error: null }) }, 'a', 2, 50, 1);
  assert.equal(count, 2);
});

test('project active deployment survives newer failures and pruning; receipts and commit runs survive restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ainize-project-state-'));
  try {
    const file = join(dir, 'projects.json');
    const store = new ProjectStore(file);
    const p = store.create({ repo: parseRepoUrl('https://drive.example/o/git/a')!, branch: 'main', kind: 'script', entry: 'main.py' }, 'alice');
    const ready = store.createDeployment(p, { ref: 'refs/heads/main', after: 'a'.repeat(40), deliveryId: 'first' }, 1);
    store.updateDeployment(ready.id, { status: 'ready' });
    const failed = store.createDeployment(p, { ref: 'refs/heads/main', after: 'b'.repeat(40), deliveryId: 'second' }, 2);
    store.updateDeployment(failed.id, { status: 'error' });
    store.prune(p.id, 1);
    const restored = new ProjectStore(file);
    assert.equal(restored.get(p.id)!.activeCommit, ready.sha);
    assert.equal(restored.get(p.id)!.sourceCommit, failed.sha);
    assert.ok(restored.deployment(ready.id), 'active version must remain recoverable even when older than retention');
    assert.deepEqual(restored.delivery(p.id, 'first'), { deploymentId: ready.id, status: 'ready' });
    const run = restored.createRun(restored.get(p.id)!, { target: 'deployed' }, { subject: 'bob' });
    assert.equal(run.sha, ready.sha);
    restored.updateDeployment(run.id, { status: 'ready' });
    assert.equal(restored.get(p.id)!.activeDeploymentId, ready.id, 'a run cannot become the deployment');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('run trees and source folders cannot follow symlinks outside the checkout', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ainize-run-root-'));
  try {
    const checkout = join(dir, 'repo'), outside = join(dir, 'outside');
    mkdirSync(checkout); mkdirSync(outside);
    writeFileSync(join(outside, 'secret.txt'), 'server-only');
    symlinkSync(outside, join(checkout, 'source'));
    assert.throws(() => projectRoot(checkout, 'source'), /escapes the repository/);
    assert.throws(() => readTree(checkout), /symlinks cannot be run/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
