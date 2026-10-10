import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Jobs } from '../examples/qa-agent/jobs.mjs';
import { Checkpoints } from '../examples/qa-agent/checkpoints.mjs';
import { advanceCoding } from '../examples/qa-agent/advance.mjs';

const snapshot = { repository: 'test/product', commit: 'a'.repeat(40), list: async () => ['sum.js'], read: async () => 'a-b' };
const model = calls => ({ llm: { chat: async () => ({ finish_reason: calls.length ? 'tool_calls' : 'stop', message: {
  role: 'assistant', content: calls.length ? null : 'candidate ready', tool_calls: calls.map(([name, args], i) => ({
    id: `c${i}`, type: 'function', function: { name, arguments: JSON.stringify(args) },
  })),
} }) } });

test('queued native coding resumes from immutable checkpoint and waits for validation, not deployment', async t => {
  const root = mkdtempSync(join(tmpdir(), 'qa-advance-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkpoints = new Checkpoints(join(root, 'checkpoints'));
  let jobs = new Jobs(join(root, 'jobs.sqlite'));
  try {
    const job = jobs.enqueue('teams:m1', { text: '덧셈 고쳐줘.' });
    const first = await advanceCoding({ jobs, claim: jobs.claim(), checkpoints, snapshot, ctx: model([['read_file', { path: 'sum.js', startLine: 1 }]]) });
    assert.equal(first.job.state, 'queued');
    jobs.close(); jobs = new Jobs(join(root, 'jobs.sqlite'));
    await advanceCoding({ jobs, claim: jobs.claim(), checkpoints, snapshot, ctx: model([['replace_text', { path: 'sum.js', oldText: 'a-b', newText: 'a+b' }]]) });
    const result = await advanceCoding({ jobs, claim: jobs.claim(), checkpoints, snapshot, ctx: model([]) });
    assert.equal(result.job.id, job.id); assert.equal(result.job.state, 'waiting');
    assert.equal(result.job.checkpoint.stage, 'needs_validation');
    assert.equal(result.state.changes['sum.js'], 'a+b');
    assert.equal(jobs.claim(), null); assert.equal('approval' in result.job.checkpoint, false);
    assert.equal(checkpoints.load(first.job.checkpoint.coding).rounds, 1, 'later checkpoints never overwrite the earlier one');
  } finally { jobs.close(); }
});

test('expired attempts cannot publish coding progress and corrupted or foreign checkpoints are rejected', async t => {
  const root = mkdtempSync(join(tmpdir(), 'qa-advance-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  let now = 1; const jobs = new Jobs(join(root, 'jobs.sqlite'), { now: () => now });
  const checkpoints = new Checkpoints(join(root, 'checkpoints'));
  try {
    const job = jobs.enqueue('teams:m1', { text: '덧셈 고쳐줘.' }), claim = jobs.claim();
    const ctx = model([['read_file', { path: 'sum.js', startLine: 1 }]]);
    const chat = ctx.llm.chat;
    ctx.llm.chat = async () => { now += 120_001; return chat(); };
    await assert.rejects(advanceCoding({ jobs, claim, checkpoints, snapshot, ctx }), /lease lost/);
    assert.equal(jobs.get(job.id).checkpoint.coding, undefined);
    assert.ok(jobs.claim(), 'another attempt can recover an expired coding call');
    const reference = checkpoints.save('other-job', { x: 1 });
    assert.throws(() => checkpoints.load({ ...reference, jobId: '../escape' }), /reference/);
    writeFileSync(checkpoints.path(reference.jobId, reference.checksum), '{"x":2}');
    assert.throws(() => checkpoints.load(reference), /checksum mismatch/);
  } finally { jobs.close(); }
});
