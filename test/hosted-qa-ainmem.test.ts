import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error - plain ESM example
import { Jobs } from '../examples/qa-agent/jobs.mjs';
// @ts-expect-error - plain ESM example
import { AinmemReports } from '../examples/qa-agent/ainmem.mjs';
const id = '11111111-1111-4111-8111-111111111111';
const config = { origin: 'https://ainmem.example', databaseId: id, titlePropertyId: id, statusPropertyId: id,
  statusOptions: Object.fromEntries(['queued','coding','validating','waiting','completed','failed'].map(x => [x,x])) };
test('report survives restart and retries the exact revision after a lost HTTP response', async t => {
  const root = mkdtempSync(join(tmpdir(), 'qa-reports-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  let jobs = new Jobs(join(root, 'jobs.sqlite3'));
  const job = jobs.enqueue('request', { text: '여백 고쳐줘', service: 'ainteams' });
  let reports = new AinmemReports(jobs, config); reports.refresh(job.id);
  const sent = [];
  await assert.rejects(reports.flush({ secret: () => 'private', fetch: async (_url, init) => {
    sent.push(JSON.parse(init.body)); throw new Error('private transport data');
  } }), /Ainmem connection failed; report retained/);
  jobs.close(); jobs = new Jobs(join(root, 'jobs.sqlite3'));
  t.after(() => jobs.close());
  reports = new AinmemReports(jobs, config);
  const ctx = { secret: () => 'private', fetch: async (url, init) => {
    assert.equal(url, `https://ainmem.example/api/qa/tasks/${job.id}`);
    assert.equal(init.redirect, 'error');
    const body = JSON.parse(init.body); sent.push(body);
    return new Response(JSON.stringify({ pageId: id, rowId: id, path: `/p/${id}`, revision: body.revision }));
  } };
  await reports.flush(ctx); assert.deepEqual(sent[0], sent[1]);
  assert.equal(reports.refresh(job.id), `https://ainmem.example/p/${id}`);
  await reports.flush(ctx); assert.equal(sent.length, 2);
  const claim = jobs.claim(); jobs.finish(job.id, claim.lease, 'waiting', { stage: 'needs_validation' });
  reports.refresh(job.id); await reports.flush(ctx); assert.equal(sent[2].revision, 1);
  assert.match(sent[2].body, /needs_validation/);
  assert.throws(() => new AinmemReports(jobs, { ...config, origin: 'https://other.example' }).refresh(job.id), /binding changed/);
});
test('receipt cannot inject an external link or acknowledge the wrong revision', async t => {
  const root = mkdtempSync(join(tmpdir(), 'qa-receipt-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const jobs = new Jobs(join(root, 'jobs.sqlite3')); t.after(() => jobs.close());
  const job = jobs.enqueue('request', { text: '고쳐줘', service: 'ainteams' });
  const reports = new AinmemReports(jobs, config); reports.refresh(job.id);
  await assert.rejects(reports.flush({ secret: () => 'private', fetch: async () => new Response(JSON.stringify({
    pageId: id, rowId: id, revision: 0, path: 'https://other.example',
  })) }), /Invalid Ainmem receipt/);
  assert.equal(reports.refresh(job.id), null);
});

test('failed reports do not starve later jobs, including across restart and beyond one batch', async t => {
  const root = mkdtempSync(join(tmpdir(), 'qa-report-fairness-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  let jobs = new Jobs(join(root, 'jobs.sqlite3'));
  let reports = new AinmemReports(jobs, config);
  const ids = Array.from({ length: 7 }, (_, i) => jobs.enqueue(`request-${i}`, { text: '고쳐줘', service: 'ainteams' }).id).sort();
  for (const job of ids) reports.refresh(job);
  const attempted = [];
  const ctx = { secret: () => 'private', fetch: async (url, init) => {
    const jobId = url.split('/').at(-1); attempted.push(jobId);
    if (ids.indexOf(jobId) < 5) return new Response('', { status: 403 });
    return new Response(JSON.stringify({ pageId: id, rowId: id, path: `/p/${id}`, revision: JSON.parse(init.body).revision }));
  } };
  await assert.rejects(reports.flush(ctx), /refused/);
  assert.equal(attempted.length, 5);
  jobs.close(); jobs = new Jobs(join(root, 'jobs.sqlite3')); t.after(() => jobs.close());
  reports = new AinmemReports(jobs, config);
  await assert.rejects(reports.flush(ctx), /refused/);
  for (const job of ids.slice(5)) assert.equal(reports.refresh(job), `https://ainmem.example/p/${id}`);
  assert.equal(new Set(attempted).size, 7);
});

test('outbox migration preserves pending records from the previous schema', async t => {
  const root = mkdtempSync(join(tmpdir(), 'qa-report-migrate-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const jobs = new Jobs(join(root, 'jobs.sqlite3')); t.after(() => jobs.close());
  jobs.db.exec('CREATE TABLE ainmem_reports (job_id TEXT PRIMARY KEY, binding TEXT NOT NULL, digest TEXT NOT NULL, payload TEXT NOT NULL, revision INTEGER NOT NULL, delivered INTEGER NOT NULL DEFAULT -1, url TEXT)');
  const job = jobs.enqueue('request', { text: '고쳐줘', service: 'ainteams' });
  const reports = new AinmemReports(jobs, config); reports.refresh(job.id);
  assert.equal(jobs.db.prepare('SELECT last_attempt FROM ainmem_reports WHERE job_id=?').get(job.id).last_attempt, 0);
});


test('approval display flag excludes failures, holds and deployment observation', async t => {
  const root=mkdtempSync(join(tmpdir(),'qa-approval-display-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const jobs=new Jobs(join(root,'jobs.sqlite3'));t.after(()=>jobs.close());
  const reports=new AinmemReports(jobs,config);
  const published={repository:'owner/repo',number:1,url:'https://github.com/owner/repo/pull/1',sha:'a'.repeat(40)};
  const cases=[
    {state:'waiting',checkpoint:{stage:'awaiting_approval',published},expected:true},
    {state:'waiting',checkpoint:{stage:'awaiting_approval',published,holdReason:'needs operator'},expected:false},
    {state:'failed',checkpoint:{stage:'awaiting_approval',published},expected:false},
    {state:'waiting',checkpoint:{stage:'awaiting_deployment',published},expected:false},
    {state:'waiting',checkpoint:{stage:'needs_validation'},expected:false},
    {state:'waiting',checkpoint:{stage:'awaiting_approval'},expected:false},
  ];
  for(const [index,example] of cases.entries()){
    const job=jobs.enqueue('case-'+index,{text:'고쳐줘',service:'ainteams',repository:'owner/repo'});
    const claim=jobs.claim();jobs.finish(job.id,claim.lease,example.state,example.checkpoint);reports.refresh(job.id);
    const payload=JSON.parse(jobs.db.prepare('SELECT payload FROM ainmem_reports WHERE job_id=?').get(job.id).payload);
    assert.equal(payload.approvalPending,example.expected);
    assert.equal(payload.body.includes('관리자 배포 승인이 필요합니다.'),example.expected);
  }
});

test('exhausted validation is shown as failed instead of an approval wait',t=>{
 const root=mkdtempSync(join(tmpdir(),'qa-validation-card-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const jobs=new Jobs(join(root,'jobs.sqlite3'));t.after(()=>jobs.close());
 const job=jobs.enqueue('request',{text:'고쳐줘',service:'ainteams'}),claim=jobs.claim();
 jobs.finish(job.id,claim.lease,'waiting',{stage:'validation_failed',validationAttempts:[{},{}]});
 const reports=new AinmemReports(jobs,config);reports.refresh(job.id);
 const payload=JSON.parse(jobs.db.prepare('SELECT payload FROM ainmem_reports WHERE job_id=?').get(job.id).payload);
 assert.equal(payload.statusOptionId,'failed');assert.equal(payload.approvalPending,false);
 assert.match(payload.body,/제품 검증에 실패/);assert.doesNotMatch(payload.body,/관리자 배포 승인이 필요/);
});

test('later and concurrent receipts cannot replace the canonical task page', async t => {
  const root = mkdtempSync(join(tmpdir(), 'qa-canonical-page-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const jobs = new Jobs(join(root, 'jobs.sqlite3')); t.after(() => jobs.close());
  const job = jobs.enqueue('canonical', { text: '여백 고쳐줘', service: 'ainteams' });
  const reports = new AinmemReports(jobs, config); reports.refresh(job.id);
  const otherId = '22222222-2222-4222-8222-222222222222';
  const receipt = (pageId, revision) => new Response(JSON.stringify({ pageId, rowId: pageId, path: `/p/${pageId}`, revision }));
  let release;
  let entered;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const delayed = reports.flush({ secret: () => 'private', fetch: async () => {
    entered(); return new Promise(resolve => { release = resolve; });
  } });
  await started;
  await new AinmemReports(jobs, config).flush({ secret: () => 'private', fetch: async () => receipt(id, 0) });
  release(receipt(otherId, 0));
  await assert.rejects(delayed, /canonical page changed/);
  assert.equal(reports.refresh(job.id), `${config.origin}/p/${id}`);

  const claim = jobs.claim(); jobs.finish(job.id, claim.lease, 'waiting', { stage: 'needs_validation' });
  reports.refresh(job.id);
  await assert.rejects(reports.flush({ secret: () => 'private', fetch: async () => receipt(otherId, 1) }), /canonical page changed/);
  assert.equal(reports.refresh(job.id), `${config.origin}/p/${id}`);
  assert.equal(jobs.db.prepare('SELECT delivered FROM ainmem_reports WHERE job_id=?').get(job.id).delivered, 0);
  await reports.flush({ secret: () => 'private', fetch: async () => receipt(id, 1) });
  assert.equal(jobs.db.prepare('SELECT delivered FROM ainmem_reports WHERE job_id=?').get(job.id).delivered, 1);
});

test('legacy reports pin the archived page before first write and retain it on rejection and restart', async t => {
  const { createHash } = await import('node:crypto');
  const { Checkpoints } = await import('../examples/qa-agent/checkpoints.mjs');
  const root=mkdtempSync(join(tmpdir(),'qa-legacy-page-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  let jobs=new Jobs(join(root,'jobs.sqlite3'));
  const job=jobs.enqueue('legacy',{text:'고쳐줘',service:'ainteams',repository:'owner/repo',teams:{workspaceId:'ws',channelId:'ch',messageId:'msg'}});
  const checkpoints=new Checkpoints(join(root,'checkpoints'));
  const archive={kind:'legacy-job-v1',repository:'owner/repo',workspaceId:'ws',channelId:'ch',job:{id:job.id,message_id:'msg',details:{kanban_url:`${config.origin}/p/${id}`}}};
  const ref=checkpoints.save(job.id,archive),claim=jobs.claim();
  jobs.finish(job.id,claim.lease,'waiting',{legacy:ref,legacyFingerprint:createHash('sha256').update(JSON.stringify(archive)).digest('hex')});
  assert.throws(()=>new AinmemReports(jobs,config).refresh(job.id),/archive required/);
  let reports=new AinmemReports(jobs,config,{checkpoints});
  assert.equal(reports.refresh(job.id),`${config.origin}/p/${id}`);
  await assert.rejects(reports.flush({secret:()=> 'private',fetch:async (_url,init)=>{
    assert.equal(JSON.parse(init.body).expectedPageId,id);return new Response('',{status:409});
  }}),/refused/);
  jobs.close();jobs=new Jobs(join(root,'jobs.sqlite3'));t.after(()=>jobs.close());
  reports=new AinmemReports(jobs,config,{checkpoints});
  assert.equal(reports.refresh(job.id),`${config.origin}/p/${id}`);
  await reports.flush({secret:()=> 'private',fetch:async (_url,init)=>{
    assert.equal(JSON.parse(init.body).expectedPageId,id);
    return new Response(JSON.stringify({pageId:id,rowId:id,path:`/p/${id}`,revision:0}));
  }});
  const corrupted={...archive,repository:'other/repo'};
  assert.throws(()=>new AinmemReports(jobs,config,{checkpoints:{load:()=>corrupted}}).refresh(job.id),/archive changed/);
});
