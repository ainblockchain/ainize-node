/**
 * Teach mode v2 — the dataset pipeline end to end on a real node (design §7, §11, §12, §15.3).
 *
 * The backend is `stub` (no GPU, no docker) and the serving model is a fake that COUNTS its calls, so the two claims
 * that are impossible to test any other way can be tested here: the live-model check costs a bounded number of calls
 * whatever the dataset size, and the questions it samples depend on the dataset bytes rather than on the job id
 * (so a contributor cannot re-train until a lucky draw passes the publish gate).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIdentity, defaultConfig, type Identity, type NodeConfig, type TeachDataset, type TeachDatasetRow } from '@ngram/core';
import type { ChatMessage, ChatResult } from '../src/runtime.js';
import { startNode, type RunningNode } from '../src/server.js';
import { teachAuthHeaderFor } from '../src/teach-auth.js';
import { canonicalJsonl, type CanonicalRow } from '../src/teach-dataset.js';
import type { TeachJob } from '../src/teach.js';

const tmp = mkdtempSync(join(tmpdir(), 'ngram-ds-test-'));
const PORT = 34047;
const url = `http://127.0.0.1:${PORT}`;
let N: RunningNode;
const teacher = createIdentity();
const stranger = createIdentity();
let opToken = '';

// ---------------------------------------------------------------- fake serving model that counts its calls
let calls = { raw: 0, chat: 0 };
/** While set, every model call is bucketed by the watched job's CURRENT status, so PREFLIGHT and CHECKING are counted apart. */
let watch: { id: string; byStatus: Record<string, number> } | null = null;
const countCall = () => { if (!watch) return; const st = N.teach!.get(watch.id)?.status ?? '?'; watch.byStatus[st] = (watch.byStatus[st] ?? 0) + 1; };
const table = new Map<string, number>();
let seq = 0;
function installFakeRuntime() {
  const rt = N.market.runtime as unknown as Record<string, unknown>;
  Object.assign(rt, {
    status: async () => ({ available: true, api: 'fake', model: 'demo-ngram-1b', hook: true, repo: null, applied: [] }),
    isApplied: async (p: string) => table.has(p),
    applyRaw: async (p: string) => { table.set(p, ++seq); return { code: 0, out: 'ok', err: '' }; },
    removeRaw: async (p: string) => { table.delete(p); return { code: 0, out: 'ok', err: '' }; },
    // with a lesson on the table the model answers `answer-<n>` for `…<n> — …`; with nothing loaded it knows nothing.
    // That is enough for a lesson to reach READY, which is what the publish gates are asserted against.
    completeRaw: async (p: string) => { calls.raw++; countCall(); return taught(p) ?? 'I do not know'; },
    chat: async (m: ChatMessage[]): Promise<ChatResult> => { calls.chat++; countCall(); return { content: taught([...m].reverse().find((x) => x.role === 'user')?.content ?? '') ?? 'I do not know.', latency_ms: 1, model: 'demo-ngram-1b' }; },
  });
}

const lessonLoaded = () => [...table.keys()].some((p) => p.includes('/teach/'));
const taught = (prompt: string): string | null => {
  if (!lessonLoaded()) return null;
  const m = prompt.match(/[a-z]+(\d+)\s+—/);
  return m ? `answer-${m[1]}` : null;
};

// ---------------------------------------------------------------- helpers
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const sign = (id: Identity, method: string, path: string, body?: unknown) =>
  teachAuthHeaderFor(id, { node: N.market.address, method, path, body: body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body) });

const api = async (method: string, path: string, body?: unknown, id: Identity | null = teacher, extra: Record<string, string> = {}) => {
  const headers: Record<string, string> = { ...extra };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (id) headers['x-ngram-auth'] = sign(id, method, path, body);
  const r = await fetch(`${url}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* not json */ }
  return { status: r.status, json: json as Record<string, unknown> & { dataset?: TeachDataset; job?: TeachJob; error?: string }, text, headers: r.headers };
};

/** Upload a file the way the browser does: multipart, with the sha256 of the bytes signed as the body (design §D14). */
const upload = async (bytes: Buffer | string, filename = 'dataset.jsonl', fields: Record<string, string> = {}, id: Identity | null = teacher, declared?: string) => {
  const buf = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes;
  const hex = declared ?? sha256(buf);
  const form = new FormData();
  form.set('file', new Blob([new Uint8Array(buf)]), filename);
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  const headers: Record<string, string> = { 'x-ngram-dataset-sha256': hex };
  if (id) headers['x-ngram-auth'] = teachAuthHeaderFor(id, { node: N.market.address, method: 'POST', path: '/api/teach/datasets', body: hex });
  const r = await fetch(`${url}/api/teach/datasets`, { method: 'POST', headers, body: form });
  const text = await r.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* not json */ }
  return { status: r.status, json: json as Record<string, unknown> & { dataset?: TeachDataset; report?: { summary: Record<string, number>; rows: TeachDatasetRow[] }; created?: boolean; error?: string }, text };
};

const op = () => ({ authorization: `Bearer ${opToken}` });
const uploaded = async (r: CanonicalRow[], filename: string, fields: Record<string, string> = {}, id: Identity = teacher): Promise<TeachDataset> => {
  const out = await upload(jsonl(r), filename, fields, id);
  assert.ok(out.json.dataset, `upload of ${filename} failed: ${out.status} ${out.text.slice(0, 200)}`);
  return out.json.dataset!;
};
const rows = (n: number, prefix = 'q'): CanonicalRow[] => Array.from({ length: n }, (_, i) => ({ prompt: `${prefix}${i} — what is the ${i}th thing?`, answer: `answer-${i}`, ...(i % 3 === 0 ? { alt_prompt: `${prefix}${i} — tell me the ${i}th thing` } : {}) }));
const jsonl = (r: CanonicalRow[]) => canonicalJsonl(r);

async function waitFor(id: string, statuses: string[], timeoutMs = 20_000): Promise<TeachJob> {
  const t0 = Date.now();
  for (;;) {
    const j = N.teach!.get(id);
    if (j && statuses.includes(j.status)) return N.teach!.view(j);
    if (j && ['FAILED', 'CANCELLED', 'EXPIRED'].includes(j.status) && !statuses.includes(j.status)) throw new Error(`job ${id} ended ${j.status}: ${j.error}`);
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${statuses} (now ${j?.status})`);
    await new Promise((r) => setTimeout(r, 40));
  }
}

before(async () => {
  const cfg: NodeConfig = defaultConfig({ home: join(tmp, 'N'), name: 'DS', port: PORT, peers: [], roles: ['seller', 'serving'], ledger: 'local' });
  // Never the shared model server: a test node built from defaultConfig() would otherwise use the shipped
  // runtime.api (localhost:8002) and reach whatever engine is running on this machine.
  cfg.runtime = { ...cfg.runtime, repo: undefined, api: 'http://127.0.0.1:1', hookApi: 'http://127.0.0.1:1' };
  cfg.host = '127.0.0.1'; cfg.publicUrl = url; cfg.gossipIntervalMs = 60_000;
  cfg.teach = {
    ...cfg.teach!, enabled: true, backend: 'stub', checkStubLessons: true, publish: 'review', jobsPerKeyPerDay: 100, jobsPerIpPerDay: 200,
    // the stub floor is 200 questions; the point of this suite is the pipeline, not the GPU budget
    dataset: { ...cfg.teach!.dataset, perKeyPerDay: 500, keptPerKey: 500, rowsPerKeyPerDay: 1000, rowsPerIpPerDay: 5000, createsPerIpPerMin: 500 },
  };
  N = await startNode(cfg, { quiet: true, serveWeb: false, teachHooks: { intervalMs: 40, stubDelayMs: 2, runtimeGraceMs: 200, retryMs: 60 } });
  installFakeRuntime();
  opToken = String((await api('POST', '/api/auth/setup', { password: 'ds-pass' }, null)).json.token);
});
after(async () => { await N?.stop(); rmSync(tmp, { recursive: true, force: true }); });

// ---------------------------------------------------------------- upload
test('upload: 201 with the server report, and re-uploading the same bytes returns 200 with the same dataset', async () => {
  const body = jsonl(rows(25));
  const r = await upload(body, 'my-questions.jsonl');
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.created, true);
  const d = r.json.dataset!;
  assert.equal(d.rows, 25);
  assert.equal(d.source, 'upload');
  assert.equal(d.status, 'staged');
  assert.equal(d.format, 'jsonl');
  assert.equal(d.encoding, 'utf-8');
  assert.equal(d.revision, 1);
  assert.equal(d.name, 'my-questions', 'the file name becomes the dataset name');
  assert.equal(d.sha256, sha256(Buffer.from(body, 'utf8')), 'the canonical bytes of a canonical upload are the upload');
  assert.equal(d.summary.accepted, 25);
  assert.equal(d.summary.rejected, 0);
  assert.equal(r.json.report!.rows.length, 25);

  const before = N.store.teachQuotaCount(`ds:addr:${teacher.address.toLowerCase()}`, new Date().toISOString().slice(0, 10));
  const again = await upload(body, 'my-questions.jsonl');
  assert.equal(again.status, 200, 'idempotent: the same bytes from the same key are the same dataset');
  assert.equal(again.json.created, false);
  assert.equal(again.json.dataset!.id, d.id);
  assert.equal(N.store.teachQuotaCount(`ds:addr:${teacher.address.toLowerCase()}`, new Date().toISOString().slice(0, 10)), before, 'no dataset quota is charged twice');

  // dedup is scoped to the OWNER: another key uploading the same bytes gets its own dataset (design §D3)
  const other = await upload(body, 'my-questions.jsonl', {}, stranger);
  assert.equal(other.status, 201);
  assert.notEqual(other.json.dataset!.id, d.id);
});

test('upload: a wrong x-ngram-dataset-sha256 is refused and the temp file is gone', async () => {
  const incoming = join(N.cfg.dataDir, 'teach', 'incoming');
  const r = await upload(jsonl(rows(3, 'hash')), 'x.jsonl', {}, teacher, 'f'.repeat(64));
  assert.equal(r.status, 400, r.text);
  assert.match(r.json.error!, /^dataset_hash/);
  assert.deepEqual(readdirSync(incoming), [], 'every error path unlinks the upload');
});

test('upload: a file with no usable questions returns 400 dataset_empty AND the reasons', async () => {
  const r = await upload('one question\nanother question\n', 'prompts.txt');
  assert.equal(r.status, 400, r.text);
  assert.match(r.json.error!, /^dataset_empty/);
  const report = r.json.report as unknown as { summary: { empty: number }; rows: TeachDatasetRow[] };
  assert.equal(report.summary.empty, 2, 'the visitor is told the file has no answers, not given invented ones');
  assert.equal(report.rows[0].status, 'empty');
  assert.deepEqual(readdirSync(join(N.cfg.dataDir, 'teach', 'incoming')), []);
});

test('the gate runs before the upload is written: a banned key and a disabled node write nothing to disk', async () => {
  const incoming = join(N.cfg.dataDir, 'teach', 'incoming');
  const datasetsBefore = readdirSync(join(N.cfg.dataDir, 'teach', 'datasets')).length;
  const ban = await api('POST', '/api/me/teach/bans', { kind: 'address', value: stranger.address }, null, op());
  assert.equal(ban.status, 200);
  const banned = await upload(jsonl(rows(4, 'ban')), 'ban.jsonl', {}, stranger);
  assert.equal(banned.status, 403);
  assert.match(banned.json.error!, /^banned/);
  await api('DELETE', `/api/me/teach/bans/${(ban.json.ban as { id: number }).id}`, undefined, null, op());

  await api('PATCH', '/api/me/teach/policy', { enabled: false }, null, op());
  const off = await upload(jsonl(rows(4, 'off')), 'off.jsonl');
  assert.equal(off.status, 403);
  assert.match(off.json.error!, /^teaching_disabled/);
  await api('PATCH', '/api/me/teach/policy', { enabled: true }, null, op());

  const unsigned = await upload(jsonl(rows(4, 'anon')), 'anon.jsonl', {}, null);
  assert.equal(unsigned.status, 401);

  assert.deepEqual(readdirSync(incoming), [], 'nothing was written to disk for any of the three');
  assert.equal(readdirSync(join(N.cfg.dataDir, 'teach', 'datasets')).length, datasetsBefore);
});

test('a CSV upload is parsed server-side, and reparse re-reads the SAME file with different settings', async () => {
  const csv = 'question;answer\n서울의 인구는?;약 940만 명\n부산의 인구는?;약 330만 명\n';
  const r = await upload(csv, 'cities.csv');
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.dataset!.delimiter, ';');
  assert.equal(r.json.dataset!.rows, 2);
  const id = r.json.dataset!.id;

  // read it again as a comma file: every line becomes one unusable column, so the node says so instead of guessing
  const wrong = await api('POST', `/api/teach/datasets/${id}/reparse`, { delimiter: ',' });
  assert.equal(wrong.status, 400, wrong.text);
  assert.match(wrong.json.error!, /^dataset_empty/);
  // and the original is untouched
  const still = await api('GET', `/api/teach/datasets/${id}`);
  assert.equal(still.json.dataset!.rows, 2);
  assert.equal(still.json.dataset!.revision, 1);

  const rp = await api('POST', `/api/teach/datasets/${id}/reparse`, { delimiter: ';', has_header: false });
  assert.equal(rp.status, 200, rp.text);
  assert.equal(rp.json.dataset!.revision, 2, 'a re-read is a new revision of the same id');
  assert.equal(rp.json.dataset!.rows, 3, 'without a header the header line is a question too');
  assert.notEqual(rp.json.dataset!.sha256, r.json.dataset!.sha256);
});

test('the per-question report is paginated and filterable, and a stranger gets 404 rather than "forbidden"', async () => {
  const r = await upload('{"prompt":"q1","answer":"a1"}\n{"prompt":"q1","answer":"a2"}\nnot json\n{"prompt":"q3","answer":"a3"}\n', 'mixed.jsonl');
  assert.equal(r.status, 201, r.text);
  const id = r.json.dataset!.id;
  const all = await api('GET', `/api/teach/datasets/${id}/rows?limit=2`);
  assert.equal(all.status, 200);
  assert.equal(all.json.total, 4);
  assert.equal((all.json.items as TeachDatasetRow[]).length, 2);
  const rejected = await api('GET', `/api/teach/datasets/${id}/rows?status=rejected`);
  assert.deepEqual((rejected.json.items as TeachDatasetRow[]).map((x) => x.status), ['conflict', 'conflict', 'not_parsed']);
  const ok = await api('GET', `/api/teach/datasets/${id}/rows?status=ok`);
  assert.deepEqual((ok.json.items as TeachDatasetRow[]).map((x) => x.prompt), ['q3']);

  const notMine = await api('GET', `/api/teach/datasets/${id}`, undefined, stranger);
  assert.equal(notMine.status, 404, 'existence is never confirmed to a stranger');
  assert.match(notMine.json.error!, /^dataset_not_found/);
  const asOperator = await api('GET', `/api/teach/datasets/${id}`, undefined, null, op());
  assert.equal(asOperator.status, 200, 'the operator can see what is hosted on their machine');
});

test('download round-trips: the .jsonl bytes are the fingerprint, and re-uploading them returns the same dataset', async () => {
  const r = await upload(jsonl(rows(6, 'rt')), 'roundtrip.jsonl');
  const id = r.json.dataset!.id;
  const dl = await fetch(`${url}/api/teach/datasets/${id}/download`, { headers: { 'x-ngram-auth': sign(teacher, 'GET', `/api/teach/datasets/${id}/download`) } });
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get('x-content-sha256'), r.json.dataset!.sha256);
  assert.match(dl.headers.get('content-disposition') ?? '', /attachment; filename="dataset-.*-r1\.jsonl"/);
  const body = Buffer.from(await dl.arrayBuffer());
  assert.equal(sha256(body), r.json.dataset!.sha256);
  const back = await upload(body, 'roundtrip.jsonl');
  assert.equal(back.status, 200);
  assert.equal(back.json.dataset!.id, id);

  const csv = await fetch(`${url}/api/teach/datasets/${id}/download?format=csv`, { headers: { 'x-ngram-auth': sign(teacher, 'GET', `/api/teach/datasets/${id}/download?format=csv`) } });
  assert.equal(csv.status, 200);
  const text = await csv.text();
  assert.match(text.split('\n')[0], /^prompt,answer,alt_prompt,note$/);
  assert.equal(text.trim().split('\n').length, 7);
});

test('sample datasets are public, downloadable and turn into a real dataset of the caller', async () => {
  const list = await fetch(`${url}/api/teach/samples`);
  assert.equal(list.status, 200);
  const samples = (await list.json() as { samples: { kind: string; rows: number; preview: unknown[] }[] }).samples;
  assert.deepEqual(samples.map((s) => s.kind), ['ko-facts', 'en-facts', 'mixed']);
  assert.ok(samples[0].rows >= 3 && samples[0].preview.length >= 3);
  const one = await fetch(`${url}/api/teach/samples/ko-facts`);
  assert.equal(one.status, 200);
  assert.equal(sha256(Buffer.from(await one.arrayBuffer())), samples[0].sha256 as unknown as string);
  assert.equal((await fetch(`${url}/api/teach/samples/nope`)).status, 404);

  const made = await api('POST', '/api/teach/datasets', { source: 'sample', sample: 'en-facts' });
  assert.equal(made.status, 201, made.text);
  assert.equal(made.json.dataset!.source, 'sample');
  assert.equal(made.json.dataset!.rows, 5);
});

// ---------------------------------------------------------------- dataset ↔ job
test('a lesson from a dataset trains the selected slice, in order, and the job carries the dataset back', async () => {
  const ds = await uploaded(rows(10, 'slice'), 'slice.jsonl');
  const r = await api('POST', '/api/teach/jobs', { dataset_id: ds.id, selected_indexes: [1, 3, 5], training: { effort: 'quick' } });
  assert.equal(r.status, 202, r.text);
  const job = r.json.job!;
  assert.deepEqual(job.facts.map((f) => f.prompt), ['slice1 — what is the 1th thing?', 'slice3 — what is the 3th thing?', 'slice5 — what is the 5th thing?']);
  assert.deepEqual(job.dataset, { id: ds.id, sha256: ds.sha256, revision: 1, name: 'slice', rows: 10, source: 'upload', trained_rows: 3, selected_indexes: [1, 3, 5] });
  assert.equal(job.training!.effort, 'quick');
  assert.equal(job.training!.max_steps, 8, 'the preset chooses max_steps and nothing else the visitor can see');
  assert.equal(job.training!.lr, 0.002);
  assert.deepEqual((r.json.quota as Record<string, number>).rows_remaining !== undefined, true);
  // the dataset is in use while the lesson runs, and back to ready afterwards
  assert.equal((await api('GET', `/api/teach/datasets/${ds.id}`)).json.dataset!.status, 'in_use');
  const done = await waitFor(job.id, ['READY', 'NEEDS_MORE']);
  assert.equal(done.result!.rows, 3, 'the stub writes one placeholder row per question — the count describes the file it wrote');
  const after = await api('GET', `/api/teach/datasets/${ds.id}`);
  assert.equal(after.json.dataset!.status, 'ready');
  assert.deepEqual(after.json.dataset!.job_ids, [job.id]);
  // recipe.json names the dataset it was trained from
  const recipe = await N.teach!.recipeJson(N.teach!.get(job.id)!);
  assert.deepEqual((recipe.lesson as { dataset: unknown }).dataset, { sha256: ds.sha256, rows: 10, revision: 1, source: 'upload', trained_rows: 3 });
  // and so does the private draft's anchor — hashes and counts, plus who may read the questions once it is published
  // (lineage design §5.1/§6.1: teach-origin anchors default to 'derivative'; the publish sheet can still choose private)
  const draft = N.store.getDraft(done.draft_id!)!;
  assert.deepEqual(draft.anchor.dataset, { sha256: ds.sha256, rows: 10, source: 'upload', access: 'derivative' });
});

test('the legacy {facts} body still works and quietly becomes a dataset with source "chat"', async () => {
  const facts = [{ prompt: 'Who founded Ainize?', answer: 'Comcom', alt_prompt: 'Which company is behind Ainize?' }, { prompt: 'What is 2+2?', answer: '4' }];
  const r = await api('POST', '/api/teach/jobs', { patch_ids: [], facts });
  assert.equal(r.status, 202, r.text);
  const job = r.json.job!;
  assert.equal(job.dataset!.source, 'chat');
  assert.equal(job.dataset!.rows, 2);
  assert.equal(job.dataset!.trained_rows, 2);
  assert.ok(job.dataset!.id, 'a v1 body leaves a re-trainable artifact behind');
  const ds = await api('GET', `/api/teach/datasets/${job.dataset!.id}`);
  assert.equal(ds.status, 200);
  assert.equal(ds.json.dataset!.rows, 2);
  const dl = await fetch(`${url}/api/teach/datasets/${job.dataset!.id}/download`, { headers: { 'x-ngram-auth': sign(teacher, 'GET', `/api/teach/datasets/${job.dataset!.id}/download`) } });
  assert.equal(await dl.text(), canonicalJsonl(facts), 'what the chat basket froze is exactly what a file upload would have been');
  await waitFor(job.id, ['READY', 'NEEDS_MORE']);
});

test('over the per-lesson cap the first N are selected and the rest wait; an explicit rows_limit over the cap is refused', async () => {
  await api('PATCH', '/api/me/teach/policy', { rows_per_job: 4 }, null, op());
  try {
    const ds = await uploaded(rows(9, 'cap'), 'cap.jsonl');
    const capped = await api('POST', '/api/teach/jobs', { dataset_id: ds.id });
    assert.equal(capped.status, 202, capped.text);
    assert.equal(capped.json.job!.facts.length, 4, 'an oversized dataset is not rejected — the rest stay for the next lesson');
    assert.equal(capped.json.job!.dataset!.rows, 9);
    assert.equal(capped.json.job!.dataset!.trained_rows, 4);
    await waitFor(capped.json.job!.id, ['READY', 'NEEDS_MORE']);

    const tooMuch = await api('POST', '/api/teach/jobs', { dataset_id: ds.id, training: { rows_limit: 8 } });
    assert.equal(tooMuch.status, 400);
    assert.match(tooMuch.json.error!, /^dataset_too_large/);
    assert.equal(tooMuch.json.max_rows, 4, 'the error carries the cap so the client never hard-codes it');
    const pol = await api('GET', '/api/teach/policy', undefined, null);
    assert.equal((pol.json.limits as Record<string, unknown>).rows_per_job, 4);
    assert.equal((pol.json.limits as Record<string, unknown>).rows_per_job_source, 'operator');
  } finally { await api('PATCH', '/api/me/teach/policy', { rows_per_job: null }, null, op()); }
});

test('questions per day run out before lessons per day do, and the 429 says what is left', async () => {
  const key = createIdentity();
  await api('PATCH', '/api/me/teach/policy', { rows_per_key_per_day: 6 }, null, op());
  try {
    const ds = await uploaded(rows(5, 'quota'), 'quota.jsonl', {}, key);
    const first = await api('POST', '/api/teach/jobs', { dataset_id: ds.id }, key);
    assert.equal(first.status, 202, first.text);
    assert.equal((first.json.quota as Record<string, number>).rows_remaining, 1);
    assert.ok((first.json.quota as Record<string, number>).key_remaining > 1, 'lessons per day are nowhere near exhausted');
    await waitFor(first.json.job!.id, ['READY', 'NEEDS_MORE']);
    const second = await api('POST', '/api/teach/jobs', { dataset_id: ds.id }, key);
    assert.equal(second.status, 429, second.text);
    assert.match(second.json.error!, /^quota_rows/);
    assert.equal(second.json.rows_remaining, 1);
    assert.equal(second.json.limit, 6);
    assert.equal(second.json.asked, 5);
  } finally { await api('PATCH', '/api/me/teach/policy', { rows_per_key_per_day: null }, null, op()); }
});

// ---------------------------------------------------------------- edit, fork, delete
test('a dataset in use cannot be edited or deleted — it is forked instead, and the fork records its parent', async () => {
  const ds = await uploaded(rows(5, 'edit'), 'edit.jsonl');
  // idle: appending questions is a new revision of the same id
  const appended = await api('PATCH', `/api/teach/datasets/${ds.id}`, { rows_op: { op: 'append', rows: [{ prompt: 'edit7 — what is the 7th thing?', answer: 'answer-7' }] } });
  assert.equal(appended.status, 200, appended.text);
  assert.equal(appended.json.dataset!.rows, 6);
  assert.equal(appended.json.dataset!.revision, 2);
  assert.notEqual(appended.json.dataset!.sha256, ds.sha256);
  // a rename does not touch the questions
  const named = await api('PATCH', `/api/teach/datasets/${ds.id}`, { name: 'my edited set' });
  assert.equal(named.json.dataset!.name, 'my edited set');
  assert.equal(named.json.dataset!.revision, 2);
  // removing a question, and replacing one
  const removed = await api('PATCH', `/api/teach/datasets/${ds.id}`, { rows_op: { op: 'remove', indexes: [0] } });
  assert.equal(removed.json.dataset!.rows, 5);
  const replaced = await api('PATCH', `/api/teach/datasets/${ds.id}`, { rows_op: { op: 'replace', index: 0, row: { prompt: 'edit9 — what is the 9th thing?', answer: 'answer-9' } } });
  assert.equal(replaced.status, 200, replaced.text);
  const first = (await api('GET', `/api/teach/datasets/${ds.id}/rows?status=ok`)).json.items as TeachDatasetRow[];
  assert.equal(first[0].prompt, 'edit9 — what is the 9th thing?');

  // while a lesson is running: 409, then fork
  const job = (await api('POST', '/api/teach/jobs', { dataset_id: ds.id })).json.job!;
  const busy = await api('PATCH', `/api/teach/datasets/${ds.id}`, { rows_op: { op: 'remove', indexes: [0] } });
  assert.equal(busy.status, 409);
  assert.match(busy.json.error!, /^dataset_in_use/);
  const noDelete = await api('DELETE', `/api/teach/datasets/${ds.id}`);
  assert.equal(noDelete.status, 409);
  const forked = await api('POST', `/api/teach/datasets/${ds.id}/fork`, { rows_op: { op: 'append', rows: [{ prompt: 'edit8 — what is the 8th thing?', answer: 'answer-8' }] } });
  assert.equal(forked.status, 201, forked.text);
  assert.equal(forked.json.dataset!.parent_dataset, ds.id);
  assert.equal(forked.json.dataset!.revision, 1);
  assert.equal(forked.json.dataset!.rows, 6);
  await waitFor(job.id, ['READY', 'NEEDS_MORE']);

  // deleted afterwards: files gone, tombstone kept, and the lesson still renders and says the dataset is gone
  const del = await api('DELETE', `/api/teach/datasets/${ds.id}`);
  assert.equal(del.status, 200, del.text);
  assert.equal(existsSync(join(N.cfg.dataDir, 'teach', 'datasets', ds.id)), false, 'the files are really removed');
  const view = N.teach!.view(N.teach!.get(job.id)!);
  assert.equal(view.dataset!.deleted, true);
  assert.equal(view.dataset!.rows, 5, 'the lesson still knows what it was trained on');
  assert.equal(view.status, 'READY', 'the lesson itself is unchanged by its dataset being deleted');
  const gone = await api('GET', `/api/teach/datasets/${ds.id}`);
  assert.equal(gone.json.dataset!.status, 'deleted');
});

test('"delete my file as soon as training finishes" is honoured, and the fingerprint survives it', async () => {
  const r = await upload(jsonl(rows(3, 'ephem')), 'ephem.jsonl', { retention: 'delete_after_training' });
  const ds = r.json.dataset!;
  assert.equal(ds.retention, 'delete_after_training');
  const job = (await api('POST', '/api/teach/jobs', { dataset_id: ds.id })).json.job!;
  await waitFor(job.id, ['READY', 'NEEDS_MORE']);
  assert.equal(existsSync(join(N.cfg.dataDir, 'teach', 'datasets', ds.id, 'rows.jsonl')), false);
  assert.equal(existsSync(join(N.cfg.dataDir, 'teach', 'datasets', ds.id, 'report.json')), true, 'the report and the sha256 survive, so the lesson can still say what it learned from');
  const still = await api('GET', `/api/teach/datasets/${ds.id}`);
  assert.equal(still.json.dataset!.sha256, ds.sha256);
});

// ---------------------------------------------------------------- re-train, sampling, budget
test('a re-train uses the same dataset and samples exactly the same questions — a lucky draw cannot be re-rolled', async () => {
  const ds = await uploaded(rows(40, 'sample'), 'sample.jsonl');
  const a = (await api('POST', '/api/teach/jobs', { dataset_id: ds.id })).json.job!;
  const ready = await waitFor(a.id, ['READY', 'NEEDS_MORE']);
  const sampledA = ready.checks!.taught.sampled!;
  assert.ok(sampledA.checked < sampledA.of, `a 40-question lesson is checked by sample: ${JSON.stringify(sampledA)}`);
  assert.equal(sampledA.of, 40);
  const measuredA = ready.facts.map((f, i) => (f.hit === undefined ? null : i)).filter((x) => x !== null);

  const again = await api('POST', `/api/teach/jobs/${a.id}/retrain`, {});
  assert.equal(again.status, 202, again.text);
  const b = again.json.job!;
  assert.equal(b.parent_job, a.id);
  assert.equal(b.dataset!.id, ds.id, 'the same dataset, not a copy');
  assert.equal(b.training!.effort, 'thorough', 'a re-train bumps the effort one level');
  const readyB = await waitFor(b.id, ['READY', 'NEEDS_MORE']);
  const measuredB = readyB.facts.map((f, i) => (f.hit === undefined ? null : i)).filter((x) => x !== null);
  assert.deepEqual(measuredB, measuredA, 'the sample is seeded by the dataset bytes, not by the job id');
});

test('the live-model check costs a bounded number of calls whatever the dataset size', async () => {
  const budget = N.teach!.cfg.check.callBudget;
  const preflightMax = N.teach!.cfg.preflight.sampleRows;
  const cost = async (n: number, tag: string) => {
    const ds = await uploaded(rows(n, tag), `${tag}.jsonl`);
    const job = (await api('POST', '/api/teach/jobs', { dataset_id: ds.id })).json.job!;
    watch = { id: job.id, byStatus: {} };
    await waitFor(job.id, ['READY', 'NEEDS_MORE']);
    const byStatus = watch.byStatus; watch = null;
    return { check: byStatus.CHECKING ?? 0, preflight: byStatus.PREFLIGHT ?? 0, job };
  };
  const small = await cost(8, 'budget8');
  const big = await cost(120, 'budget120');
  assert.ok(small.check > 0 && big.check > 0, 'the check really ran');
  assert.ok(small.check <= budget, `8 questions: ${small.check} check calls > ${budget}`);
  assert.ok(big.check <= budget, `120 questions: ${big.check} check calls > ${budget}`);
  assert.ok(big.check >= small.check, 'a bigger dataset spends its whole budget rather than being cut short early');
  // the preflight is sampled too, so it cannot become the unbounded step instead
  assert.ok(small.preflight <= preflightMax && big.preflight <= preflightMax, `preflight: ${small.preflight} / ${big.preflight} > ${preflightMax}`);
  // the 12 locality prompts are never trimmed — they are the publish gate
  const checks = N.teach!.view(N.teach!.get(big.job.id)!).checks!;
  assert.equal(checks.locality.total, 12);
  assert.deepEqual(checks.taught.sampled, { checked: checks.taught.sampled!.checked, of: 120 });
  assert.ok(checks.taught.sampled!.checked < 120, 'a sampled check never claims the whole dataset');
});

test('turning the side-effect check off keeps the lesson but gates publishing until it is measured', async () => {
  const ds = await uploaded(rows(3, 'noside'), 'noside.jsonl');
  const job = (await api('POST', '/api/teach/jobs', { dataset_id: ds.id, training: { check_side_effects: false } })).json.job!;
  const ready = await waitFor(job.id, ['READY', 'NEEDS_MORE']);
  assert.equal(ready.checks!.skipped, true);
  assert.equal(ready.checks!.ok, false);
  assert.equal(ready.checks!.locality.same, 0, 'nothing was measured about unrelated answers, and the number says so');
  const ch = await api('GET', `/api/teach/jobs/${job.id}/publish-challenge`);
  assert.equal(ch.status, 409);
  assert.match(ch.json.error!, /^checks_failed/);
  const recheck = await api('POST', `/api/teach/jobs/${job.id}/recheck`);
  assert.equal(recheck.status, 200, recheck.text);
});

// ---------------------------------------------------------------- honesty of the measured numbers
test('a stub node reports no timing at all: three 3-second stub lessons never become a gradient estimate', async () => {
  const pol = (await api('GET', '/api/teach/policy', undefined, null)).json;
  const timing = pol.timing as Record<string, unknown>;
  assert.equal(timing.samples, 0, 'stub runs are recorded, but never counted as measured training');
  assert.equal(timing.p50_s, null);
  assert.equal(timing.simulated, true);
  assert.equal((pol.queue as Record<string, unknown>).position_eta_s, null);
  assert.ok(N.store.teachStats(50, 'stub').length >= 3, 'the stub timings ARE kept — a stub node legitimately wants its own numbers');
  assert.equal(N.store.teachStats(50, 'gradient').length, 0);
  const stat = N.store.teachStats(50, 'stub')[0];
  assert.ok((stat.rows_trained ?? 0) > 0 && (stat.sentences ?? 0) > 0, 'what actually drives cost is recorded');
  assert.equal((pol.limits as Record<string, unknown>).rows_per_job, 200, 'the stub floor — a stub job costs no GPU');
});

test('a lesson taught before datasets existed still renders, and gets one written from its questions on demand', async () => {
  // simulate a v1 row: the four dataset columns are NULL, exactly as a database written before this PR has them
  const facts = [{ prompt: 'A v1 question?', answer: 'v1 answer' }];
  const created = (await api('POST', '/api/teach/jobs', { patch_ids: [], facts })).json.job!;
  await waitFor(created.id, ['READY', 'NEEDS_MORE']);
  N.store.deleteTeachDataset(created.dataset!.id!);        // and the dataset row itself never existed on a v1 node
  N.store.updateTeachJob(created.id, { dataset_id: null, dataset_sha256: null, dataset_rows: null, dataset_source: null, training: null });
  const legacy = N.store.getTeachJob(created.id)!;
  assert.equal(legacy.dataset_id, null);
  const view = N.teach!.view(legacy);
  assert.deepEqual(view.dataset, { id: null, sha256: null, rows: 1, source: 'derived', trained_rows: 1 }, 'a v1 job renders without a dataset');
  assert.equal(view.status === 'READY' || view.status === 'NEEDS_MORE', true);

  const made = N.teach!.ensureDataset(legacy)!;
  assert.equal(made.source, 'derived');
  assert.equal(made.rows, 1);
  const backfilled = N.teach!.view(N.store.getTeachJob(created.id)!);
  assert.equal(backfilled.dataset!.id, made.id, 'the four job columns are backfilled, with no bulk migration anywhere');
  assert.equal(readFileSync(join(made.dir, 'rows.jsonl'), 'utf8'), canonicalJsonl(facts));
});

test('the operator can see and delete what visitors uploaded to their machine', async () => {
  const mine = await api('GET', '/api/me/teach/datasets?limit=500', undefined, null, op());
  assert.equal(mine.status, 200);
  const items = mine.json.items as (TeachDataset & { ip: string | null; owner: string })[];
  assert.ok(items.length > 5);
  assert.ok(items.some((d) => d.owner.toLowerCase() === teacher.address.toLowerCase()));
  assert.ok(items.every((d) => 'ip' in d && 'owner' in d));
  assert.ok(items.filter((d) => d.source === 'upload').every((d) => !!d.source_name), 'the operator sees the filename that was uploaded');
  assert.equal((await api('GET', '/api/me/teach/datasets', undefined, null)).status, 401, 'operator only');

  const victim = await uploaded(rows(2, 'mod'), 'mod.jsonl');
  const del = await api('DELETE', `/api/teach/datasets/${victim.id}`, undefined, null, op());
  assert.equal(del.status, 200, del.text);
  assert.equal(existsSync(join(N.cfg.dataDir, 'teach', 'datasets', victim.id)), false);
});

test('the sweep removes a staged dataset nobody trained, and keeps one that a lesson used', async () => {
  const staged = await uploaded(rows(2, 'sweepme'), 'sweepme.jsonl');
  const used = await uploaded(rows(2, 'sweepkeep'), 'sweepkeep.jsonl');
  const job = (await api('POST', '/api/teach/jobs', { dataset_id: used.id })).json.job!;
  await waitFor(job.id, ['READY', 'NEEDS_MORE']);
  // 25 hours later: the staged upload is past stagedTtlHours, the trained one is nowhere near ttlDays
  N.teach!.datasets.sweep(Date.now() + 25 * 3600_000);
  assert.equal(N.store.getTeachDataset(staged.id)!.status, 'deleted');
  assert.equal(existsSync(join(N.cfg.dataDir, 'teach', 'datasets', staged.id)), false);
  assert.equal(N.store.getTeachDataset(used.id)!.status, 'ready');
  // and 8 days after the lesson finished, the trained one goes too
  N.teach!.datasets.sweep(Date.now() + 8 * 86_400_000);
  assert.equal(N.store.getTeachDataset(used.id)!.status, 'deleted');
});
