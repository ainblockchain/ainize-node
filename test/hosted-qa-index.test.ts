import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error - plain ESM example module without d.ts
import { createHandler, parseConfig } from '../examples/qa-agent/index.mjs';

const CONFIG = {
  service: 'ainteams', teamsOrigin: 'https://teams.example/', workspaceId: 'ws1', channelId: 'ch1',
  enabledAt: '2026-10-01T00:00:00.000Z', repository: 'test/product', baseCommit: 'a'.repeat(40),
};
const verified = {
  workspaceId: 'ws1', channelId: 'ch1', messageId: 'm1', parentId: 'm1',
  senderId: 'u1', text: '덧셈 고쳐줘.', createdAt: '2026-10-05T00:00:00.000Z',
};
const locatorInput = metadata => ({ input: { text: '', metadata }, log() {} });
// A model that emits the given tool calls, or finishes when none are supplied.
const model = calls => ({
  log() {},
  llm: { chat: async () => ({ finish_reason: calls.length ? 'tool_calls' : 'stop', message: {
    role: 'assistant', content: calls.length ? null : 'candidate ready',
    tool_calls: calls.map(([name, args], i) => ({ id: `c${i}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })),
  } }) },
});
const snapshot = { repository: CONFIG.repository, commit: CONFIG.baseCommit, list: async () => ['sum.js'], read: async () => 'a-b' };

test('config rejects secrets-free invalid bindings and accepts a pinned one', () => {
  assert.throws(() => parseConfig({ ...CONFIG, baseCommit: 'short' }), /base commit/);
  assert.throws(() => parseConfig({ ...CONFIG, teamsOrigin: 'http://teams.example/' }), /https/);
  assert.throws(() => parseConfig({ ...CONFIG, repository: 'no-slash' }), /repository/);
  const ok = parseConfig(CONFIG);
  assert.equal(ok.repository, 'test/product');
  assert.equal(ok.baseCommit, 'a'.repeat(40));
});

test('intake enqueues only canonical fix requests and deduplicates retries', async t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'qa-index-')); t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const handler = createHandler({ config: CONFIG, stateDir, verifyIntake: async (_ctx, locator) => (locator?.messageId === 'm1' ? verified : null) });

  const missing = await handler.execute('', locatorInput(undefined));
  assert.match(missing.text, /확인할 수 없습니다/);

  const foreign = await handler.execute('', locatorInput({ teamsMessage: { messageId: 'other' } }));
  assert.match(foreign.text, /확인된 수정 요청이 아닙니다/);
  assert.equal(foreign.metadata, undefined, 'an unverified request is never enqueued');

  const first = await handler.execute('', locatorInput({ teamsMessage: { messageId: 'm1' } }));
  assert.equal(first.metadata.state, 'queued');
  const again = await handler.execute('', locatorInput({ teamsMessage: { messageId: 'm1' } }));
  assert.equal(again.metadata.jobId, first.metadata.jobId, 'the same canonical message maps to one job');
});

test('tick advances a queued job through real coding to needs_validation, never to deployment', async t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'qa-index-')); t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const make = () => createHandler({
    config: CONFIG, stateDir,
    verifyIntake: async () => verified,
    newSnapshot: () => snapshot,
  });

  // Intake one job.
  const job = await make().execute('', locatorInput({ teamsMessage: { messageId: 'm1' } }));
  assert.equal(job.metadata.state, 'queued');

  // Each tick runs exactly one bounded model step, re-opening state like a fresh host process.
  await make().tick(model([['read_file', { path: 'sum.js', startLine: 1 }]]));
  await make().tick(model([['replace_text', { path: 'sum.js', oldText: 'a-b', newText: 'a+b' }]]));
  await make().tick(model([]));

  // Re-open jobs to read state: a completed candidate waits, is not claimable, and carries no approval.
  // @ts-expect-error - plain ESM example module without d.ts
  const { Jobs } = await import('../examples/qa-agent/jobs.mjs');
  const jobs = new Jobs(join(stateDir, 'jobs.sqlite3'));
  try {
    const stored = jobs.get(job.metadata.jobId);
    assert.equal(stored.state, 'waiting');
    assert.equal(stored.checkpoint.stage, 'needs_validation');
    assert.equal('approval' in stored.checkpoint, false, 'coding never records a deployment approval');
    assert.equal(jobs.claim(), null, 'a candidate awaiting validation is not re-claimed');
  } finally { jobs.close(); }
});
