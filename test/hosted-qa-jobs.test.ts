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
  assert.equal(b.claim(), null);
  assert.equal(b.claimReview().job.checkpoint.stage, 'awaiting_approval');
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

test('polling a slow host gate cannot starve later jobs, including after restart', t => {
  let now = 1000;
  const { open } = setup(t, { now: () => now });
  const first = open();
  const slow = first.enqueue('slow', { repository: 'test/web' });
  now++;
  const later = first.enqueue('later', { repository: 'test/api' });
  const claim = first.claim();
  assert.equal(claim.job.id, slow.id);
  first.finish(slow.id, claim.lease, 'queued', { stage: 'needs_validation', candidate: 'preserve' });
  first.close();
  const resumed = open(), other = open();
  const next = resumed.claim();
  assert.equal(next.job.id, later.id);
  const retry = other.claim();
  assert.equal(retry.job.id, slow.id);
  assert.deepEqual(retry.job.checkpoint, { stage: 'needs_validation', candidate: 'preserve' });
  assert.equal(other.claim(), null, 'both active leases remain exclusive');
  resumed.finish(later.id, next.lease, 'queued', {});
  other.finish(slow.id, retry.lease, 'queued', retry.job.checkpoint);
  assert.equal(resumed.claim().job.id, later.id, 'each eligible job receives another turn');
});

test('revalidation archives the original attempt atomically without changing task identity, base or prior authority', t => {
  const {open}=setup(t);let jobs=open();
  const input={service:'test',repository:'test/product',base:'a'.repeat(40),text:'고쳐줘',teams:{workspaceId:'w',channelId:'c',parentId:'m',messageId:'m'}};
  const job=jobs.enqueueTeamsRequest(input),claim=jobs.claim();
  const checkpoint={stage:'awaiting_approval',published:{repository:input.repository,base:input.base,sha:'b'.repeat(40),candidateDigest:'c'.repeat(64)},coding:{jobId:job.id,checksum:'d'.repeat(64)},validation:{jobId:job.id,checksum:'e'.repeat(64)},pageId:'original-page',approval:{sha:'b'.repeat(40)}};
  jobs.finish(job.id,claim.lease,'waiting',checkpoint);
  const review=jobs.claimReview();const parked=jobs.parkForRevalidation(job.id,review.lease,'f'.repeat(40));
  assert.equal(parked.id,job.id);assert.deepEqual(parked.input,input);assert.equal(parked.checkpoint.pageId,'original-page');assert.equal(parked.checkpoint.approval,undefined);assert.equal(jobs.wake(job.id),false);
  const history=jobs.revalidationHistory(job.id);assert.equal(history.length,1);assert.deepEqual(history[0].checkpoint,checkpoint);assert.deepEqual(history[0].input,input);
  assert.equal(parked.checkpoint.priorAttempt.sourceDigest,history[0].sourceDigest);
  jobs.close();jobs=open();assert.deepEqual(jobs.revalidationHistory(job.id),history);
  assert.equal(jobs.enqueueTeamsRequest({...input,base:'f'.repeat(40)}).id,job.id);
  assert.throws(()=>jobs.parkForRevalidation(job.id,review.lease,'f'.repeat(40)),/binding changed/);
  assert.equal(jobs.revalidationHistory(job.id).length,1);assert.equal(jobs.claim(),null);
});

test('expired revalidation writer cannot add history or overwrite the active lease', t => {
  let now=1000;const {open}=setup(t,{now:()=>now}),jobs=open();
  const job=jobs.enqueue('request',{repository:'test/product',base:'a'.repeat(40)}),claim=jobs.claim();
  const checkpoint={stage:'awaiting_approval',published:{repository:'test/product',base:'a'.repeat(40),sha:'b'.repeat(40)}};
  jobs.finish(job.id,claim.lease,'waiting',checkpoint);const expired=jobs.claimReview(1000);now=2000;
  const fresh=jobs.claimReview();assert.throws(()=>jobs.parkForRevalidation(job.id,expired.lease,'c'.repeat(40)),/lease lost/);
  assert.deepEqual(jobs.revalidationHistory(job.id),[]);assert.deepEqual(jobs.get(job.id).checkpoint,checkpoint);
  jobs.parkForRevalidation(job.id,fresh.lease,'c'.repeat(40));assert.equal(jobs.revalidationHistory(job.id).length,1);
});

test('history write failure rolls back the visible revalidation transition', t => {
  const {open}=setup(t),jobs=open();
  const job=jobs.enqueue('request',{repository:'test/product',base:'a'.repeat(40)}),claim=jobs.claim();
  const checkpoint={stage:'awaiting_approval',published:{repository:'test/product',base:'a'.repeat(40),sha:'b'.repeat(40)}};
  jobs.finish(job.id,claim.lease,'waiting',checkpoint);const review=jobs.claimReview();
  jobs.db.exec("CREATE TRIGGER fail_history BEFORE INSERT ON revalidation_history BEGIN SELECT RAISE(ABORT, 'test history failure'); END");
  assert.throws(()=>jobs.parkForRevalidation(job.id,review.lease,'c'.repeat(40)),/history failure/);
  assert.equal(jobs.get(job.id).state,'running');assert.deepEqual(jobs.get(job.id).checkpoint,checkpoint);assert.deepEqual(jobs.revalidationHistory(job.id),[]);
  jobs.db.exec('DROP TRIGGER fail_history');jobs.parkForRevalidation(job.id,review.lease,'c'.repeat(40));
  assert.equal(jobs.get(job.id).state,'waiting');assert.equal(jobs.revalidationHistory(job.id).length,1);
});

test('prepared revalidation keeps job identity and history but starts coding without old authority', t => {
  let now = 1000;
  const { open } = setup(t, { now: () => now }); let jobs = open();
  const old = 'a'.repeat(40), observed = 'b'.repeat(40), latest = 'c'.repeat(40);
  const input = { repository: 'test/product', base: old, text: '여백 고쳐줘', service: 'teams', teams: { messageId: 'm1' } };
  const job = jobs.enqueue('revalidation', input), claim = jobs.claim();
  const original = { hostIntake: true, hostBase: true, stage: 'awaiting_approval',
    coding: { jobId: job.id, checksum: 'd'.repeat(64) }, validation: { passed: true },
    published: { repository: input.repository, base: old, sha: 'e'.repeat(40) },
    approval: { commentId: 'old-approval' }, release: { old: true }, deployment: { old: true }, servingCommit: old };
  jobs.finish(job.id, claim.lease, 'waiting', original);
  const review = jobs.claimReview(); jobs.parkForRevalidation(job.id, review.lease, observed);
  const history = jobs.revalidationHistory(job.id);
  const receipt = { jobId: job.id, repository: input.repository, previousBase: old, base: latest,
    sequence: 1, sourceDigest: history[0].sourceDigest };
  assert.equal(jobs.claim(), null);
  const expired = jobs.claimRevalidation(1000); assert.equal(jobs.claimRevalidation(), null);
  now += 1001;
  assert.equal(jobs.claim(), null, 'normal coding must not reclaim an expired revalidation lease');
  const current = jobs.claimRevalidation();
  assert.throws(() => jobs.bindRevalidation(job.id, expired.lease, receipt), /lease lost/);
  for (const change of [{ jobId: 'other' }, { repository: 'other/repo' }, { previousBase: latest },
    { base: old }, { base: 'main' }, { sequence: 2 }, { sourceDigest: 'f'.repeat(64) }]) {
    assert.throws(() => jobs.bindRevalidation(job.id, current.lease, { ...receipt, ...change }), /binding changed/);
  }
  assert.deepEqual(jobs.revalidationHistory(job.id), history);
  const resumed = jobs.bindRevalidation(job.id, current.lease, receipt);
  assert.equal(resumed.id, job.id); assert.equal(resumed.requestKey, job.requestKey);
  assert.deepEqual(resumed.input, { ...input, base: latest }); assert.equal(resumed.state, 'queued');
  assert.deepEqual(Object.keys(resumed.checkpoint).sort(), ['hostBase', 'hostIntake', 'revalidationAttempt']);
  assert.equal(resumed.checkpoint.revalidationAttempt.previousBase, old);
  assert.deepEqual(jobs.revalidationHistory(job.id)[0].checkpoint, original);
  jobs.close(); jobs = open();
  const next = jobs.claim(); assert.equal(next.job.id, job.id); assert.equal(next.job.input.base, latest);
  assert.throws(() => jobs.bindRevalidation(job.id, current.lease, receipt), /archive binding changed/);
  assert.equal(jobs.revalidationHistory(job.id).length, 1);
});
