import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Jobs } from '../examples/qa-agent/jobs.mjs';

function setup(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hosted-qa-'));
  const file = join(dir, 'jobs.sqlite');
  const opened = [];
  const open = () => { const jobs = new Jobs(file, options); opened.push(jobs); return jobs; };
  t.after(() => { for (const jobs of opened) { try { jobs.close(); } catch {} } rmSync(dir, { recursive: true, force: true }); });
  return { file, open };
}

test('durable request dedupe survives restart; conflicting retry is rejected', t => {
  const { open, file } = setup(t); const first = open();
  const job = first.enqueue('teams:message-1', { channel: 'qa', text: '여백 고쳐줘' });
  first.close(); const second = open();
  assert.equal(second.enqueue('teams:message-1', { text: '여백 고쳐줘', channel: 'qa' }).id, job.id);
  assert.throws(() => second.enqueue('teams:message-1', { text: '다른 요청' }), /different input/);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('two connections cannot claim the same live work; expired worker cannot finish it', t => {
  let now = 1000; const { open } = setup(t, { now: () => now });
  const a = open(), b = open(); const job = a.enqueue('m1', { text: '고쳐줘' });
  const old = a.claim(1000); assert.equal(old.job.id, job.id); assert.equal(b.claim(), null);
  now = 2000; const fresh = b.claim(); assert.equal(fresh.job.id, job.id);
  assert.notEqual(fresh.lease, old.lease);
  assert.throws(() => a.finish(job.id, old.lease, 'completed', {}), /lease lost/);
  assert.throws(() => a.renew(job.id, old.lease), /lease lost/);
  b.finish(job.id, fresh.lease, 'completed', { pr: 42 }); assert.equal(a.claim(), null);
});

test('waiting checkpoint survives restart and wakes once without claiming deployment approval', t => {
  const { open } = setup(t); const a = open(); const job = a.enqueue('m1', { text: '고쳐줘' });
  const claim = a.claim(); a.finish(job.id, claim.lease, 'waiting', { stage: 'awaiting_approval', sha: 'a'.repeat(40) }); a.close();
  const b = open(); assert.equal(b.claim(), null); assert.equal(b.get(job.id).checkpoint.sha, 'a'.repeat(40));
  assert.equal(b.wake(job.id), true); assert.equal(b.wake(job.id), false);
  assert.equal(b.claim().job.checkpoint.stage, 'awaiting_approval');
  assert.equal('approval' in b.get(job.id).checkpoint, false);
});

test('renewed lease stays exclusive and invalid, oversized, or over-capacity inputs are refused', t => {
  let now = 1; const { open } = setup(t, { now: () => now, limit: 1 }); const a = open();
  const job = a.enqueue('m1', {}), claim = a.claim(1000); now = 500; a.renew(job.id, claim.lease, 2000);
  now = 1500; assert.equal(a.claim(), null);
  assert.throws(() => a.enqueue('m2', {}), /capacity/);
  assert.throws(() => a.enqueue('../path', {}), /request key/);
  assert.throws(() => a.finish(job.id, claim.lease, 'running', {}), /transition/);
  assert.throws(() => a.finish(job.id, claim.lease, 'waiting', { data: 'x'.repeat(70_000) }), /64 KiB/);
  assert.throws(() => a.claim(Infinity), /duration/);
  assert.equal(a.get(job.id).state, 'running');
});

test('canonical intake reconciles old keys without changing candidate, approval or page references', t => {
  const root = mkdtempSync(join(tmpdir(), 'qa-legacy-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const jobs = new Jobs(join(root, 'jobs.sqlite3'));
  try {
    const input = { service: 'ainteams', repository: 'test/product', base: 'a'.repeat(40), text: '여백 고쳐줘.',
      teams: { workspaceId: 'w', channelId: 'c', parentId: 'm', messageId: 'm' } };
    const old = jobs.enqueue('legacy:base:a', input);
    const claim = jobs.claim();
    const checkpoint = { stage: 'awaiting_approval', coding: 'original-candidate', pageId: 'original-page', approval: { sha: 'original-sha' } };
    jobs.finish(old.id, claim.lease, 'waiting', checkpoint);
    const replay = jobs.enqueueTeamsRequest({ ...input, base: 'b'.repeat(40) });
    assert.equal(replay.id, old.id);
    assert.equal(replay.requestKey, old.requestKey);
    assert.equal(replay.input.base, input.base);
    assert.deepEqual(replay.checkpoint, checkpoint);
    assert.throws(() => jobs.enqueueTeamsRequest({ ...input, text: 'edited request' }), /changed/);
    jobs.enqueue('legacy:base:b', { ...input, base: 'b'.repeat(40) });
    assert.throws(() => jobs.enqueueTeamsRequest(input), /multiple historical/);
  } finally { jobs.close(); }
});
