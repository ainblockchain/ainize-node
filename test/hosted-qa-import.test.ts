import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error - example module
import { Jobs } from '../examples/qa-agent/jobs.mjs';
// @ts-expect-error - example module
import { Checkpoints } from '../examples/qa-agent/checkpoints.mjs';
// @ts-expect-error - example module
import { importLegacyJobs } from '../examples/qa-agent/import-legacy.mjs';
const cfg = { service: 'ainteams', workspaceId: 'ws', channelId: 'ch', repository: 'test/product' };
const id = '11111111-1111-4111-8111-111111111111';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'qa-import-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourcePath = join(root, 'legacy.sqlite3'), source = new DatabaseSync(sourcePath);
  source.exec('CREATE TABLE jobs(id TEXT PRIMARY KEY,message_id TEXT,status TEXT,stage TEXT,payload TEXT,details TEXT,created REAL,updated REAL); CREATE TABLE reports(id INTEGER PRIMARY KEY,job_id TEXT,stage TEXT,content TEXT,sent INTEGER)');
  const payload = { message_id: 'm', parent_id: 'm', sender_id: 'person', text: '여백 고쳐줘', created_at: '2026-10-01T00:00:00Z' };
  const details = { repository: cfg.repository, base_sha: 'a'.repeat(40), code_sha: 'b'.repeat(40), kanban_url: 'https://ainmem.example/p/existing', approval: { user_id: 'person', sha: 'b'.repeat(40) } };
  source.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?)').run(id,'m','awaiting_approval','awaiting_approval',JSON.stringify(payload),JSON.stringify(details),1000,1001);
  source.prepare('INSERT INTO reports VALUES(1,?,?,?,1)').run(id,'kanban','old report');
  const jobs = new Jobs(join(root, 'native.sqlite3')), checkpoints = new Checkpoints(join(root,'checkpoints'));
  t.after(() => { source.close(); jobs.close(); });
  return { source, sourcePath, jobs, checkpoints, config: cfg, payload, details };
}
test('migration preserves identity and full history without converting old approvals into authority', t => {
  const f = fixture(t);
  assert.deepEqual(importLegacyJobs(f), { imported: 1, unchanged: 0, total: 1 });
  const job = f.jobs.get(id);
  assert.equal(job.state, 'waiting'); assert.equal(job.checkpoint.stage, 'legacy_reconciliation');
  assert.equal(job.created, 1000000); assert.equal(f.jobs.claim(), null);
  assert.equal(job.checkpoint.approval, undefined);
  const archived = f.checkpoints.load(job.checkpoint.legacy);
  assert.deepEqual(archived.job.details, f.details);
  assert.deepEqual(archived.job.payload, f.payload);
  assert.equal(archived.reports[0].content, 'old report');
  assert.deepEqual(importLegacyJobs(f), { imported: 0, unchanged: 1, total: 1 });
  assert.equal(f.jobs.enqueueTeamsRequest({ ...job.input, base: 'c'.repeat(40) }).id, id);
  f.source.prepare('UPDATE jobs SET updated=1002').run();
  assert.throws(() => importLegacyJobs(f), /differs/);
});
test('rejects unfinished work and existing canonical requests under a different id', t => {
  const f = fixture(t);
  f.source.prepare("UPDATE jobs SET status='working'").run();
  assert.throws(() => importLegacyJobs(f), /unfinished/);
  assert.equal(f.jobs.db.prepare('SELECT count(*) n FROM jobs').get().n, 0);
  f.source.prepare("UPDATE jobs SET status='awaiting_approval'").run();
  f.jobs.enqueue('different', { service: cfg.service, repository: cfg.repository, text: f.payload.text,
    teams: { messageId:'m', parentId:'m', channelId:'ch', workspaceId:'ws' } });
  assert.throws(() => importLegacyJobs(f), /another job ID/);
  assert.equal(f.jobs.get(id), null);
});

test('completed and failed historical jobs keep their terminal native state', t => {
  for (const status of ['completed', 'failed']) {
    const f = fixture(t);
    f.source.prepare('UPDATE jobs SET status=?').run(status);
    importLegacyJobs(f);
    assert.equal(f.jobs.get(id).state, status);
    assert.equal(f.jobs.get(id).checkpoint.legacyStatus, status);
    assert.equal(f.jobs.claim(), null);
  }
});

test('shared migration records operator route without granting execution or changing archived approval',t=>{
 const f=fixture(t);
 const options={...f,config:{...cfg,route:'api'}};
 importLegacyJobs(options);
 const job=f.jobs.get(id);
 assert.equal(job.input.route,'api');assert.equal(job.input.repository,cfg.repository);
 assert.equal(job.state,'waiting');assert.equal(f.jobs.claim(),null);
 assert.equal(job.checkpoint.approval,undefined);
 assert.deepEqual(f.checkpoints.load(job.checkpoint.legacy).job.details.approval,f.details.approval);
 assert.deepEqual(importLegacyJobs(options),{imported:0,unchanged:1,total:1});
 assert.throws(()=>importLegacyJobs({...f,config:{...cfg,route:'web'}}),/differs/);
 assert.equal(f.jobs.get(id).input.route,'api');
});

test('reconciliation records live merge evidence without reusing archived approval', async t => {
  const f = fixture(t);
  f.source.prepare('UPDATE jobs SET details=?').run(JSON.stringify({ ...f.details, pr_main:{number:7,url:'https://github.com/test/product/pull/7'} }));
  importLegacyJobs(f); f.jobs.wake(id);
  // @ts-expect-error - example module
  const { reconcileLegacyJob } = await import('../examples/qa-agent/reconcile.mjs');
  const updated = await reconcileLegacyJob({ jobs: f.jobs, claim: f.jobs.claim(), checkpoints: f.checkpoints,
    read: async path => {
      assert.equal(path, 'pulls/7');
      return { number:7, state:'closed', merged:true, merged_at:'2026-10-08T00:00:00Z', merge_commit_sha:'c'.repeat(40),
        head:{ sha:f.details.code_sha, repo:{full_name:cfg.repository}}, base:{sha:'d'.repeat(40),ref:'main',repo:{full_name:cfg.repository}} };
    } });
  assert.equal(updated.state, 'waiting');
  assert.equal(updated.checkpoint.stage, 'verify_deployment');
  assert.equal(updated.checkpoint.approval, undefined);
  assert.equal(f.checkpoints.load(updated.checkpoint.legacy).job.details.approval.sha, f.details.code_sha);
  assert.equal(f.checkpoints.load(updated.checkpoint.reconciliation).mergeCommit, 'c'.repeat(40));
});

test('replacement job and PR are reconciled separately without transferring archived approval',async t=>{
 const f=fixture(t),successor='22222222-2222-4222-8222-222222222222';
 f.source.prepare('UPDATE jobs SET details=?').run(JSON.stringify({...f.details,pr_main:{number:7,url:'https://github.com/test/product/pull/7'},superseded_by:successor,superseded_pr:'https://github.com/test/product/pull/8'}));
 f.source.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?)').run(successor,'next','completed','completed',JSON.stringify({...f.payload,message_id:'next',parent_id:'next'}),JSON.stringify({...f.details,code_sha:'e'.repeat(40),pr_main:{number:8,url:'https://github.com/test/product/pull/8'}}),1002,1003);
 importLegacyJobs(f);f.jobs.wake(id);
 // @ts-expect-error example module
 const {reconcileLegacyJob}=await import('../examples/qa-agent/reconcile.mjs');
 const updated=await reconcileLegacyJob({jobs:f.jobs,claim:f.jobs.claim(),checkpoints:f.checkpoints,read:async(path:string)=>{
  const number=path==='pulls/7'?7:8;return {number,state:'closed',merged:number===8,merged_at:number===8?'2026-10-10T00:00:00Z':null,merge_commit_sha:number===8?'f'.repeat(40):null,head:{sha:number===7?f.details.code_sha:'e'.repeat(40),repo:{full_name:cfg.repository}},base:{sha:'d'.repeat(40),ref:'main',repo:{full_name:cfg.repository}}};
 }});
 const evidence=f.checkpoints.load(updated.checkpoint.reconciliation);
 assert.equal(updated.checkpoint.stage,'superseded_candidate');assert.equal(updated.state,'waiting');assert.equal(evidence.replacement.action,'verify_deployment');assert.equal(evidence.replacement.approvalInherited,false);assert.equal(f.jobs.get(successor).state,'completed');assert.equal(updated.checkpoint.approval,undefined);
});
