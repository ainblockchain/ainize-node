import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error - plain ESM example module without d.ts
import { candidateDigest, validateCandidate, advanceValidation } from '../examples/qa-agent/validation.mjs';
// @ts-expect-error - plain ESM example module without d.ts
import { Jobs } from '../examples/qa-agent/jobs.mjs';
// @ts-expect-error - plain ESM example module without d.ts
import { Checkpoints } from '../examples/qa-agent/checkpoints.mjs';
// @ts-expect-error - plain ESM example module without d.ts
import { advanceCoding } from '../examples/qa-agent/advance.mjs';

const REPO = 'test/product', BASE = 'a'.repeat(40);
const snapshot = { repository: REPO, commit: BASE, list: async () => ['sum.js'], read: async () => 'a-b' };
const model = calls => ({ llm: { chat: async () => ({ finish_reason: calls.length ? 'tool_calls' : 'stop', message: {
  role: 'assistant', content: calls.length ? null : 'ready',
  tool_calls: calls.map(([name, args], i) => ({ id: `c${i}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })),
} }) } });

test('candidate digest is order-independent and binds to content and base', () => {
  const a = candidateDigest({ repository: REPO, base: BASE, changes: { 'x.js': '1', 'y.js': '2' } });
  const b = candidateDigest({ repository: REPO, base: BASE, changes: { 'y.js': '2', 'x.js': '1' } });
  assert.equal(a, b, 'key order does not change the digest');
  assert.notEqual(a, candidateDigest({ repository: REPO, base: BASE, changes: { 'x.js': '1', 'y.js': '3' } }));
  assert.notEqual(a, candidateDigest({ repository: REPO, base: 'b'.repeat(40), changes: { 'x.js': '1', 'y.js': '2' } }));
  assert.throws(() => candidateDigest({ repository: REPO, base: 'short', changes: {} }), /base commit/);
});

test('gates run in order, stop at first failure, and a thrown gate counts as failed', async () => {
  const changes = { 'sum.js': 'a+b' };
  const pass = await validateCandidate({ repository: REPO, base: BASE, changes, gates: ['typecheck', 'test'],
    run: async gate => ({ passed: true, summary: `${gate} ok` }) });
  assert.equal(pass.passed, true);
  assert.equal(pass.gates.length, 2);
  assert.equal(pass.candidateDigest, candidateDigest({ repository: REPO, base: BASE, changes }));

  const order = [];
  const fail = await validateCandidate({ repository: REPO, base: BASE, changes, gates: ['typecheck', 'test', 'build'],
    run: async gate => { order.push(gate); return { passed: gate !== 'test', summary: gate }; } });
  assert.equal(fail.passed, false);
  assert.deepEqual(order, ['typecheck', 'test'], 'stops at the first failing gate');

  const thrown = await validateCandidate({ repository: REPO, base: BASE, changes, gates: ['typecheck'],
    run: async () => { throw new Error('container exploded'); } });
  assert.equal(thrown.passed, false);
  assert.match(thrown.gates[0].summary, /gate errored/);

  await assert.rejects(validateCandidate({ repository: REPO, base: BASE, changes, gates: [], run: async () => ({ passed: true }) }), /gate list/);
});

test('validation step parks a passing candidate at awaiting_approval without recording approval', async t => {
  const root = mkdtempSync(join(tmpdir(), 'qa-validation-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkpoints = new Checkpoints(join(root, 'checkpoints'));
  const jobs = new Jobs(join(root, 'jobs.sqlite3'));
  try {
    // Drive a real coding candidate to needs_validation.
    const job = jobs.enqueue('teams:m1', { text: '덧셈 고쳐줘.', repository: REPO, base: BASE });
    await advanceCoding({ jobs, claim: jobs.claim(), checkpoints, snapshot, ctx: model([['read_file', { path: 'sum.js', startLine: 1 }]]) });
    await advanceCoding({ jobs, claim: jobs.claim(), checkpoints, snapshot, ctx: model([['replace_text', { path: 'sum.js', oldText: 'a-b', newText: 'a+b' }]]) });
    const ready = await advanceCoding({ jobs, claim: jobs.claim(), checkpoints, snapshot, ctx: model([]) });
    assert.equal(ready.job.checkpoint.stage, 'needs_validation');

    // Waking is scheduling, not approval; then one validation step runs the gates.
    assert.equal(jobs.wake(job.id), true);
    const run = async (gate, { changes }) => ({ passed: changes['sum.js'] === 'a+b', summary: `${gate} ok` });
    const out = await advanceValidation({ jobs, claim: jobs.claim(), checkpoints, gates: ['typecheck', 'test'], run });
    assert.equal(out.result.passed, true);
    assert.equal(out.job.state, 'waiting');
    assert.equal(out.job.checkpoint.stage, 'awaiting_approval');
    assert.equal('approval' in out.job.checkpoint, false, 'validation never records a deployment approval');
    assert.equal(jobs.claim(), null, 'an approved-pending candidate is not re-claimed');

    // The stored verdict is bound to the exact candidate.
    const verdict = checkpoints.load(out.job.checkpoint.validation);
    assert.equal(verdict.candidateDigest, candidateDigest({ repository: REPO, base: BASE, changes: { 'sum.js': 'a+b' } }));
  } finally { jobs.close(); }
});

test('a failing gate parks the candidate at validation_failed and preserves it', async t => {
  const root = mkdtempSync(join(tmpdir(), 'qa-validation-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkpoints = new Checkpoints(join(root, 'checkpoints'));
  const jobs = new Jobs(join(root, 'jobs.sqlite3'));
  try {
    const job = jobs.enqueue('teams:m1', { text: '덧셈 고쳐줘.', repository: REPO, base: BASE });
    await advanceCoding({ jobs, claim: jobs.claim(), checkpoints, snapshot, ctx: model([['read_file', { path: 'sum.js', startLine: 1 }]]) });
    await advanceCoding({ jobs, claim: jobs.claim(), checkpoints, snapshot, ctx: model([['replace_text', { path: 'sum.js', oldText: 'a-b', newText: 'a+b' }]]) });
    await advanceCoding({ jobs, claim: jobs.claim(), checkpoints, snapshot, ctx: model([]) });
    jobs.wake(job.id);
    const out = await advanceValidation({ jobs, claim: jobs.claim(), checkpoints, gates: ['test'], run: async () => ({ passed: false, summary: 'regression' }) });
    assert.equal(out.result.passed, false);
    assert.equal(out.job.checkpoint.stage, 'validation_failed');
    // The coding candidate is preserved for a later attempt, not discarded.
    assert.equal(checkpoints.load(out.job.checkpoint.coding).changes['sum.js'], 'a+b');
  } finally { jobs.close(); }
});
