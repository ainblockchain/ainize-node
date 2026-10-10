import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
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

test('a repeatedly failing coding job is parked so later requests can advance', async t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'qa-retry-')); t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const handler = createHandler({ config: CONFIG, stateDir, verifyIntake: async () => verified,
    newSnapshot: () => snapshot, advance: async () => { throw new Error('model unavailable'); } });
  const first = await handler.execute('', locatorInput({ teamsMessage: { messageId: 'm1' } }));
  for (let i = 0; i < 3; i++) await handler.tick({ log() {} });
  // @ts-expect-error - example module
  const { Jobs } = await import('../examples/qa-agent/jobs.mjs');
  const jobs = new Jobs(join(stateDir, 'jobs.sqlite3'));
  try {
    assert.equal(jobs.get(first.metadata.jobId).state, 'waiting');
    assert.equal(jobs.get(first.metadata.jobId).checkpoint.holdReason, 'step_retry_limit');
    const next = jobs.enqueue('next', { text: 'next request' });
    assert.equal(jobs.claim().job.id, next.id);
  } finally { jobs.close(); }
});

test('configuration changes park old jobs without repeatedly claiming them', async t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'qa-config-')); t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const handler = createHandler({ config: CONFIG, stateDir, verifyIntake: async () => verified });
  const first = await handler.execute('', locatorInput({ teamsMessage: { messageId: 'm1' } }));
  await createHandler({ config: { ...CONFIG, baseCommit: 'b'.repeat(40) }, stateDir }).tick({ log() {} });
  // @ts-expect-error - example module
  const { Jobs } = await import('../examples/qa-agent/jobs.mjs');
  const jobs = new Jobs(join(stateDir, 'jobs.sqlite3'));
  try {
    assert.equal(jobs.get(first.metadata.jobId).checkpoint.holdReason, 'configuration_changed');
    assert.equal(jobs.claim(), null);
  } finally { jobs.close(); }
});


test('hosted entry loads bundled config without an unsupported host environment variable', t => {
  const root = mkdtempSync(join(tmpdir(), 'qa-entry-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(new URL('../examples/qa-agent/', import.meta.url), root, { recursive: true });
  writeFileSync(join(root, 'qa-config.json'), JSON.stringify(CONFIG));
  const env = { ...process.env, AINIZE_AGENT_STATE_DIR: root };
  delete env.AINIZE_QA_CONFIG;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    "const {tick} = await import('./index.mjs'); await tick({log(){}});"], { cwd: root, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('re-delivery after a base change reuses the existing candidate and job ID', async t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'qa-dedupe-')); t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const make = baseCommit => createHandler({ config: { ...CONFIG, baseCommit }, stateDir, verifyIntake: async () => verified });
  const input = locatorInput({ teamsMessage: { messageId: 'm1' } });
  const first = await make(CONFIG.baseCommit).execute('', input);
  const second = await make('b'.repeat(40)).execute('', input);
  assert.equal(second.metadata.jobId, first.metadata.jobId);
});
