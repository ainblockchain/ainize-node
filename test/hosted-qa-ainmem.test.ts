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
