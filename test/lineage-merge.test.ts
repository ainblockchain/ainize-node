/**
 * Lineage L7 — combining two knowledges (docs/lineage-teach-design.md §3 Story C, §9, §12.2, SC-14).
 *
 * The owner's second question: "why can I not MERGE someone else's?" These tests hold the answer to the one rule that
 * makes a merge honest — a row two knowledges disagree about is never averaged, added or silently ordered away. It is
 * either combined because they cannot contradict each other (T0, built here with no GPU), or retrained (T1), or
 * rebuilt (T2) — and a question they answer differently waits for a person.
 *
 * Everything runs on the `stub` backend with a fake serving model: what is asserted is the CONTRACT and the BYTES of
 * the combined file, never a training result.
 *
 * Scenarios AZ-301 … AZ-306 (docs/ux-test-scenarios.json).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIdentity, defaultConfig, readNpzAddrs, signMessage, valuesEqualCount, type Identity, type NodeConfig, type TeachDataset } from '@ngram/core';
import type { ChatMessage, ChatResult } from '../src/runtime.js';
import { startNode, type RunningNode } from '../src/server.js';
import { teachAuthHeaderFor } from '../src/teach-auth.js';
import { canonicalJsonl, readCanonicalJsonl, type CanonicalRow } from '../src/teach-dataset.js';
import type { TeachJob } from '../src/teach.js';

const tmp = mkdtempSync(join(tmpdir(), 'ngram-lineage-merge-test-'));
const PORT = 34091;
const url = `http://127.0.0.1:${PORT}`;
let N: RunningNode;
const alice = createIdentity();     // publishes A
const bob = createIdentity();       // publishes B
const carol = createIdentity();     // combines them
let opToken = '';

// ---------------------------------------------------------------- fake serving model (nothing here is a measurement)
const table = new Map<string, number>();
let seq = 0;
function installFakeRuntime() {
  const rt = N.market.runtime as unknown as Record<string, unknown>;
  Object.assign(rt, {
    status: async () => ({ available: true, api: 'fake', model: 'demo-ngram-1b', hook: true, repo: null, applied: [] }),
    isApplied: async (p: string) => table.has(p),
    applyRaw: async (p: string) => { table.set(p, ++seq); return { code: 0, out: 'ok', err: '' }; },
    removeRaw: async (p: string) => { table.delete(p); return { code: 0, out: 'ok', err: '' }; },
    check: async () => ({ ok: true, rows: 1, differ_before: 0, differ_after: 0 }),
    completeRaw: async (p: string) => answerFor(p),
    chat: async (m: ChatMessage[]): Promise<ChatResult> => ({ content: answerFor([...m].reverse().find((x) => x.role === 'user')?.content ?? ''), latency_ms: 1, model: 'demo-ngram-1b' }),
  });
}
const jobFacts = new Map<string, { prompt: string; answer: string }[]>();
function answerFor(asked: string): string {
  let best: { seq: number; answer: string } | null = null;
  for (const [path, s] of table) {
    for (const [id, facts] of jobFacts) {
      if (!path.includes(id)) continue;
      for (const f of facts) if (asked.includes(f.prompt) && (!best || s > best.seq)) best = { seq: s, answer: f.answer };
    }
  }
  return best ? best.answer : 'I do not know.';
}

// ---------------------------------------------------------------- helpers
const sign = (id: Identity, method: string, path: string, body?: unknown) =>
  teachAuthHeaderFor(id, { node: N.market.address, method, path, body: body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body) });
type Json = Record<string, unknown> & { dataset?: TeachDataset; job?: TeachJob; error?: string };
const api = async (method: string, path: string, body?: unknown, id: Identity | null = alice, extra: Record<string, string> = {}) => {
  const headers: Record<string, string> = { ...extra };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (id) headers['x-ngram-auth'] = sign(id, method, path, body);
  const r = await fetch(`${url}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* not json */ }
  return { status: r.status, json: json as Json, text };
};

async function upload(r: CanonicalRow[], filename: string, id: Identity): Promise<TeachDataset> {
  const buf = Buffer.from(canonicalJsonl(r), 'utf8');
  const hex = (await import('node:crypto')).createHash('sha256').update(buf).digest('hex');
  const form = new FormData();
  form.set('file', new Blob([new Uint8Array(buf)]), filename);
  const res = await fetch(`${url}/api/teach/datasets`, {
    method: 'POST',
    headers: { 'x-ngram-dataset-sha256': hex, 'x-ngram-auth': teachAuthHeaderFor(id, { node: N.market.address, method: 'POST', path: '/api/teach/datasets', body: hex }) },
    body: form,
  });
  const j = (await res.json()) as { dataset?: TeachDataset; error?: string };
  assert.ok(j.dataset, `upload ${filename} failed: ${res.status} ${JSON.stringify(j).slice(0, 300)}`);
  return j.dataset!;
}

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

async function train(body: Record<string, unknown>, id: Identity, expect = 202): Promise<TeachJob> {
  const r = await api('POST', '/api/teach/jobs', { patch_ids: [], ...body }, id);
  assert.equal(r.status, expect, r.text);
  if (expect !== 202) return r.json as unknown as TeachJob;
  const jobId = String(r.json.job!.id);
  jobFacts.set(jobId, (N.teach!.get(jobId)?.facts ?? []).map((f) => ({ prompt: f.prompt, answer: f.answer })));
  return waitFor(jobId, ['READY', 'NEEDS_MORE']);
}

async function publish(job: TeachJob, dataset: Record<string, unknown> | undefined, extra: Record<string, unknown>, id: Identity) {
  const ch = await api('GET', `/api/teach/jobs/${job.id}/publish-challenge`, undefined, id);
  assert.equal(ch.status, 200, ch.text);
  return api('POST', `/api/teach/jobs/${job.id}/publish`, {
    name: extra.name ?? `Lesson ${job.id.slice(0, 6)}`, price: '10', license: 'CC-BY-4.0',
    claim_sig: signMessage(String(ch.json.claim), id.privateKey), consent: { permanent: true, rights: true },
    ...(dataset ? { dataset } : {}), ...extra,
  }, id);
}

/** A published knowledge with its own questions, taught by `who`. */
async function publishOwn(rows: CanonicalRow[], name: string, who: Identity, access = 'derivative'): Promise<string> {
  const ds = await upload(rows, `${name}.jsonl`, who);
  const job = await train({ dataset_id: ds.id }, who);
  const pub = await publish(job, { access, license: 'CC-BY-4.0' }, { name }, who);
  assert.equal(pub.status, 200, pub.text);
  return String(pub.json.patch_id);
}

const q = (prefix: string, n: number, answer = (i: number) => `answer-${prefix}-${i}`): CanonicalRow[] =>
  Array.from({ length: n }, (_, i) => ({ prompt: `${prefix}${i} — what is it?`, answer: answer(i) }));

before(async () => {
  const cfg: NodeConfig = defaultConfig({ home: join(tmp, 'N'), name: 'MERGE', port: PORT, peers: [], roles: ['seller', 'serving'], ledger: 'local' });
  cfg.runtime = { ...cfg.runtime, repo: undefined, api: 'http://127.0.0.1:1', hookApi: 'http://127.0.0.1:1' };
  cfg.host = '127.0.0.1'; cfg.publicUrl = url; cfg.gossipIntervalMs = 60_000;
  cfg.teach = {
    ...cfg.teach!, enabled: true, backend: 'stub', checkStubLessons: true, publish: 'auto', lineage: true, jobsPerKeyPerDay: 100, jobsPerIpPerDay: 400,
    dataset: { ...cfg.teach!.dataset, perKeyPerDay: 500, keptPerKey: 500, rowsPerKeyPerDay: 4000, rowsPerIpPerDay: 9000, createsPerIpPerMin: 500 },
  };
  N = await startNode(cfg, { quiet: true, serveWeb: false, teachHooks: { intervalMs: 40, stubDelayMs: 2, runtimeGraceMs: 200, retryMs: 60 } });
  installFakeRuntime();
  opToken = String((await api('POST', '/api/auth/setup', { password: 'merge-pass' }, null)).json.token);
  void opToken;
});
after(async () => { await N?.stop(); rmSync(tmp, { recursive: true, force: true }); });

// ---------------------------------------------------------------- AZ-301
test('AZ-301 two knowledges that answer different questions: the preview counts both sides, and "just combine" is on the table', async () => {
  const a = await publishOwn(q('alpha', 3), 'Alpha', alice);
  const b = await publishOwn(q('beta', 2), 'Beta', bob);
  const r = await api('POST', '/api/teach/merge/preview', { a, b }, carol);
  assert.equal(r.status, 200, r.text);
  const p = r.json as unknown as { questions: { a_only: number; b_only: number; same: number; conflicts: unknown[] }; rows: { shared: number; disagree: number }; tiers: { union: { allowed: boolean; export: string }; retrain: { allowed: boolean; reason: string; est_min: number | null }; rebuild: { allowed: boolean; est_min: number | null }; required: string | null }; merged: { rows: number; from_a: number; from_b: number } };
  assert.deepEqual({ a_only: p.questions.a_only, b_only: p.questions.b_only, same: p.questions.same, conflicts: p.questions.conflicts.length }, { a_only: 3, b_only: 2, same: 0, conflicts: 0 });
  assert.equal(p.rows.shared, 0, 'two independent lessons write different rows');
  assert.equal(p.tiers.union.allowed, true);
  assert.equal(p.tiers.union.export, 'squash', 'neither was built on anything, so the combined file stands alone');
  assert.equal(p.tiers.required, null);
  assert.equal(p.tiers.rebuild.est_min, null, 'this node has never timed a rebuild, so it says nothing about hours');
  assert.deepEqual({ rows: p.merged.rows, from_a: p.merged.from_a, from_b: p.merged.from_b }, { rows: 5, from_a: 3, from_b: 2 });
});

// ---------------------------------------------------------------- AZ-302
test('AZ-302 combining two knowledges that cannot contradict each other: the file is the row union of both, and the anchor has two parents', async () => {
  const a = await publishOwn(q('gamma', 3), 'Gamma', alice);
  const b = await publishOwn(q('delta', 2), 'Delta', bob);
  const job = await train({ base_ids: [a, b], mode: 'merge', tier: 'union' }, carol);
  assert.equal(job.mode, 'merge');
  assert.equal(job.merge?.tier, 'union');
  assert.deepEqual(job.bases?.map((x) => x.patch_id), [a, b]);
  assert.equal(job.facts.length, 5, 'the combined knowledge answers every question of both');

  // the bytes: the union holds both parents' rows and agrees with each of them on every row it took
  const row = N.teach!.get(job.id)!;
  const pa = N.market.blobs.get((await N.market.entry(a))!.anchor.patch_sha256)!.path;
  const pb = N.market.blobs.get((await N.market.entry(b))!.anchor.patch_sha256)!.path;
  const merged = row.npz_path!;
  const [na, nb, nm] = [pa, pb, merged].map((f) => readNpzAddrs(f).length);
  assert.equal(nm, na + nb, 'no row was dropped and none was invented');
  assert.equal(valuesEqualCount(merged, pa).differ, 0, 'every row taken from A still holds A’s value');
  assert.equal(valuesEqualCount(merged, pb).differ, 0, 'every row taken from B still holds B’s value');
  const recipe = JSON.parse(readFileSync(join(row.job_dir!, 'recipe.json'), 'utf8')) as { trainer: string; export: string; hyper_params: { max_steps: number } };
  assert.equal(recipe.trainer, 'union');
  assert.equal(recipe.hyper_params.max_steps, 0, 'nothing was trained');

  const pub = await publish(job, { access: 'derivative', license: 'CC-BY-4.0' }, { name: 'Gamma + Delta' }, carol);
  assert.equal(pub.status, 200, pub.text);
  const anchor = (await N.market.entry(String(pub.json.patch_id)))!.anchor;
  assert.deepEqual(anchor.parents, [a, b], 'both creators are on the record, so both are paid');
  assert.equal(anchor.derivation?.kind, 'merge');
  assert.equal(anchor.derivation?.tier, 'union');
  assert.deepEqual(anchor.derivation?.bases.map((x) => x.patch_id), [a, b]);
  assert.deepEqual(anchor.derivation?.bases.map((x) => x.rows), [3, 2], 'each parent contributed its own questions');
  assert.equal(anchor.base?.export, 'squash');
  assert.deepEqual(anchor.base?.stack, [], 'a combined stand-alone file needs nothing underneath');
  assert.deepEqual(anchor.dataset?.parents?.map((x) => x.patch_id), [a, b]);
});

// ---------------------------------------------------------------- AZ-303
test('AZ-303 the same question with two answers stops the build until a person chooses, and the choice is what the merged set carries', async () => {
  const a = await publishOwn([...q('eps', 2), { prompt: 'who is the tallest?', answer: 'the pine' }], 'Eps', alice);
  const b = await publishOwn([...q('zeta', 1), { prompt: 'who is the tallest?', answer: 'the oak' }], 'Zeta', bob);
  const preview = await api('POST', '/api/teach/merge/preview', { a, b }, carol);
  assert.equal(preview.status, 200, preview.text);
  const p = preview.json as unknown as { questions: { conflicts: { key: string; prompt: string; a_answer: string; b_answer: string }[] }; tiers: { union: { allowed: boolean; reason: string }; retrain: { allowed: boolean }; rebuild: { allowed: boolean } } };
  assert.equal(p.questions.conflicts.length, 1);
  assert.deepEqual({ a: p.questions.conflicts[0].a_answer, b: p.questions.conflicts[0].b_answer }, { a: 'the pine', b: 'the oak' });
  assert.equal(p.tiers.union.allowed, false);
  assert.equal(p.tiers.union.reason, 'question_conflicts');
  assert.equal(p.tiers.retrain.allowed, true, 'one disagreeing question is exactly what a retrain is for');

  // no resolution → nothing is built, and the refusal names the questions
  const refused = await train({ base_ids: [a, b], mode: 'merge', tier: 'retrain' }, carol, 409);
  assert.match(String((refused as unknown as { error: string }).error), /^merge_unresolved:/);
  assert.equal((refused as unknown as { conflicts: unknown[] }).conflicts.length, 1);

  // keep B's answer: the merged row IS B's row and says which of A's answers it replaces
  const key = p.questions.conflicts[0].key;
  const job = await train({ base_ids: [a, b], mode: 'merge', tier: 'retrain', resolutions: { [key]: 'b' } }, carol);
  assert.equal(job.merge?.tier, 'retrain');
  assert.equal(job.facts.length, 1, 'a retrain teaches only the questions they answered differently');
  assert.equal(job.facts[0].answer, 'the oak');
  assert.match(String(job.facts[0].replaces), new RegExp(`^${a}#`));
  const dir = N.teach!.get(job.id)!.job_dir!;
  const known = readCanonicalJsonl(readFileSync(join(dir, 'known.jsonl'), 'utf8'));
  assert.equal(known.length, 3, 'everything both already teach is kept, not retaught');
  const spec = JSON.parse(readFileSync(join(dir, 'job.json'), 'utf8')) as { parents: { patch_id: string }[]; mask: { mode: string; facts: number[] }; export: string; merge: { tier: string; parents: string[] } };
  assert.deepEqual(spec.parents.map((x) => x.patch_id), [a, b], 'the trainer loads both, in order');
  assert.equal(spec.mask.mode, 'only', 'a retrain may touch only the rows of the questions it is fixing');
  assert.deepEqual(spec.mask.facts, [0]);
  assert.equal(spec.export, 'delta');
  assert.deepEqual(spec.merge, { tier: 'retrain', parents: [a, b], conflicts: 1, resolved: 1 });

  const snapshot = readCanonicalJsonl(readFileSync(join(dir, 'snapshot.jsonl'), 'utf8'));
  assert.equal(snapshot.length, 4, '2 of A + 1 of B + the one they disagreed about');
  assert.ok(snapshot.every((r) => r.from), 'every surviving row says which parent row it is');
});

// ---------------------------------------------------------------- AZ-304
test('AZ-304 write my own / drop: the answer the creator wrote is trained, the question they dropped is gone from the set', async () => {
  const a = await publishOwn([{ prompt: 'how deep?', answer: '3 m' }, { prompt: 'how wide?', answer: '4 m' }], 'Deep', alice);
  const b = await publishOwn([{ prompt: 'how deep?', answer: '5 m' }, { prompt: 'how wide?', answer: '9 m' }], 'Wide', bob);
  const preview = await api('POST', '/api/teach/merge/preview', { a, b }, carol);
  const p = preview.json as unknown as { questions: { conflicts: { key: string; prompt: string }[] } };
  assert.equal(p.questions.conflicts.length, 2);
  const deep = p.questions.conflicts.find((c) => c.prompt === 'how deep?')!.key;
  const wide = p.questions.conflicts.find((c) => c.prompt === 'how wide?')!.key;
  const job = await train({ base_ids: [a, b], mode: 'merge', tier: 'retrain', resolutions: { [deep]: { answer: '4 m' }, [wide]: 'drop' } }, carol);
  assert.equal(job.facts.length, 1);
  assert.deepEqual({ prompt: job.facts[0].prompt, answer: job.facts[0].answer }, { prompt: 'how deep?', answer: '4 m' });
  const snapshot = readCanonicalJsonl(readFileSync(join(N.teach!.get(job.id)!.job_dir!, 'snapshot.jsonl'), 'utf8'));
  assert.equal(snapshot.length, 1, 'the dropped question is in neither the set nor the lesson');
  assert.equal(snapshot[0].from, undefined, 'an answer the creator wrote is nobody else’s row');
  assert.match(String(snapshot[0].replaces), new RegExp(`^${a}#`));
  assert.equal(job.merge?.dropped, 1);
});

// ---------------------------------------------------------------- AZ-305
test('AZ-305 a knowledge and something built on top of it disagree about the rows themselves: no combine, no retrain — a rebuild or nothing', async () => {
  const a = await publishOwn(q('eta', 4), 'Eta', alice);
  // a child trained ON TOP of A that changes one of its answers: its file overwrites A's rows (the stub models the
  // same last-write-wins table the real hook has)
  const fork = await api('POST', `/api/patches/${a}/fork`, { name: 'on top of Eta' }, bob);
  assert.equal(fork.status, 201, fork.text);
  const dsId = String(fork.json.dataset_id);
  const inherited = readCanonicalJsonl(readFileSync(join(N.teach!.datasets.dir(dsId), 'rows.jsonl'), 'utf8'));
  const edit = await api('PATCH', `/api/teach/datasets/${dsId}`, { rows_op: { op: 'replace', index: 0, row: { prompt: inherited[0].prompt, answer: 'a different answer' } } }, bob);
  assert.equal(edit.status, 200, edit.text);
  const childJob = await train({ dataset_id: dsId, base_ids: [a] }, bob);
  const childPub = await publish(childJob, { access: 'derivative', license: 'CC-BY-4.0' }, { name: 'Eta child' }, bob);
  assert.equal(childPub.status, 200, childPub.text);
  const child = String(childPub.json.patch_id);

  const preview = await api('POST', '/api/teach/merge/preview', { a, b: child }, carol);
  assert.equal(preview.status, 200, preview.text);
  const p = preview.json as unknown as { rows: { shared: number; disagree: number; opposing: number }; questions: { conflicts: { key: string }[] }; tiers: { union: { allowed: boolean; reason: string }; retrain: { allowed: boolean; reason: string }; rebuild: { allowed: boolean }; required: string; disagree_ratio: number } };
  assert.ok(p.rows.shared > 0, 'the child was trained on top of A, so it writes A’s rows');
  assert.equal(p.rows.disagree, p.rows.shared, 'and it writes different values there');
  assert.equal(p.tiers.required, 'rebuild');
  assert.equal(p.tiers.retrain.allowed, false);
  assert.equal(p.tiers.retrain.reason, 'rows_disagree');
  assert.equal(p.tiers.union.allowed, false);
  assert.ok(p.tiers.disagree_ratio > 0.2, `${p.tiers.disagree_ratio} of the shared rows disagree — over the fifth that forces a rebuild`);

  const key = p.questions.conflicts[0].key;
  const refused = await train({ base_ids: [a, child], mode: 'merge', tier: 'retrain', resolutions: { [key]: 'b' } }, carol, 400);
  assert.match(String((refused as unknown as { error: string }).error), /^tier_not_allowed:/);
  assert.equal((refused as unknown as { required: string }).required, 'rebuild');

  // the rebuild is a training job from the combined questions with NOTHING loaded under it
  const job = await train({ base_ids: [a, child], mode: 'merge', tier: 'rebuild', resolutions: { [key]: 'b' } }, carol);
  assert.equal(job.merge?.tier, 'rebuild');
  assert.equal(job.export, 'squash');
  const dir = N.teach!.get(job.id)!.job_dir!;
  const spec = JSON.parse(readFileSync(join(dir, 'job.json'), 'utf8')) as { parents?: unknown; merge: { tier: string } };
  assert.equal(spec.parents, undefined, 'a rebuild loads no parent — that is what makes it a rebuild');
  assert.equal(spec.merge.tier, 'rebuild');
  assert.equal(existsSync(join(dir, 'known.jsonl')), false, 'and it keeps nothing: every question is trained again');
  assert.equal(job.facts.length, 4, 'the combined set is trained whole');
});

// ---------------------------------------------------------------- AZ-306
test('AZ-306 a private training set can still be combined when the rows do not overlap — and never retrained or rebuilt', async () => {
  const open = await publishOwn(q('theta', 2), 'Theta', alice);
  const sealed = await publishOwn(q('iota', 2), 'Iota', bob, 'private');
  const preview = await api('POST', '/api/teach/merge/preview', { a: open, b: sealed }, carol);
  assert.equal(preview.status, 200, preview.text);
  const p = preview.json as unknown as { questions: null; private_parent: string; rows: { shared: number }; tiers: { union: { allowed: boolean }; retrain: { allowed: boolean; reason: string }; rebuild: { allowed: boolean; reason: string } } };
  assert.equal(p.questions, null, 'nothing is counted about questions nobody may read');
  assert.equal(p.private_parent, sealed);
  assert.equal(p.rows.shared, 0);
  assert.equal(p.tiers.union.allowed, true);
  assert.equal(p.tiers.retrain.allowed, false);
  assert.equal(p.tiers.retrain.reason, 'private_parent');
  assert.equal(p.tiers.rebuild.reason, 'private_parent');
  // a retrain is refused before anything is resolved
  const refused = await train({ base_ids: [open, sealed], mode: 'merge', tier: 'retrain' }, carol, 400);
  assert.match(String((refused as unknown as { error: string }).error), /^base_private:/);
  // …and the combine is built from the rows, with the private set contributing no questions to the child's set
  const job = await train({ base_ids: [open, sealed], mode: 'merge', tier: 'union' }, carol);
  assert.equal(job.facts.length, 2, 'only the readable side’s questions are in the child’s training set');
  const merged = N.teach!.get(job.id)!.npz_path!;
  const pa = N.market.blobs.get((await N.market.entry(open))!.anchor.patch_sha256)!.path;
  const pb = N.market.blobs.get((await N.market.entry(sealed))!.anchor.patch_sha256)!.path;
  assert.equal(readNpzAddrs(merged).length, readNpzAddrs(pa).length + readNpzAddrs(pb).length);
});

// ---------------------------------------------------------------- AZ-323
test('AZ-323 a retrain takes its mask from the base’s own address map, and a base this node did not train leaves it null', async () => {
  const a = await publishOwn([{ prompt: 'which tree?', answer: 'the pine' }, { prompt: 'which rock?', answer: 'granite' }], 'Trees', alice);
  const b = await publishOwn([{ prompt: 'which tree?', answer: 'the oak' }], 'Oaks', bob);

  /*
   * `fact_addrs` is what the trainer records for every question it taught (design §7.5): the rows that question
   * writes through. It lives in the job's recipe.json and NEVER on the anchor — `anchorRecipe` keeps it off-chain —
   * so a merge that wants to freeze everything except the rows in dispute has to read it from there, by fact INDEX.
   * The stub backend does not train and records none, so it is written here the way the gradient trainer writes it.
   */
  const aJob = N.store.listTeachJobs({ draft_id: a })[0];
  const aRecipePath = join(aJob.job_dir!, 'recipe.json');
  const aRecipe = JSON.parse(readFileSync(aRecipePath, 'utf8')) as { facts: { prompt: string }[]; fact_addrs?: Record<string, number[]> };
  const treeIdx = aRecipe.facts.findIndex((f) => f.prompt === 'which tree?');
  assert.ok(treeIdx >= 0, 'the base recipe lists the questions it taught');
  aRecipe.fact_addrs = { [String(treeIdx)]: [4001, 4002, 4003], [String(1 - treeIdx)]: [9001] };
  writeFileSync(aRecipePath, JSON.stringify(aRecipe));

  const preview = await api('POST', '/api/teach/merge/preview', { a, b }, carol);
  const key = (preview.json as unknown as { questions: { conflicts: { key: string }[] } }).questions.conflicts[0].key;
  const job = await train({ base_ids: [a, b], mode: 'merge', tier: 'retrain', resolutions: { [key]: 'b' } }, carol);
  const spec = JSON.parse(readFileSync(join(N.teach!.get(job.id)!.job_dir!, 'job.json'), 'utf8')) as { mask: { mode: string; facts: number[]; addrs: string[] | null } };
  assert.equal(spec.mask.mode, 'only');
  assert.deepEqual(spec.mask.facts, [0]);
  assert.deepEqual([...(spec.mask.addrs ?? [])].sort(), ['4001', '4002', '4003'],
    'only the rows of the question being retrained — the base’s other question is not in the mask');

  // and a base whose address map nobody on this node has: null, which means the trainer resolves them itself and
  // fails the job if it cannot — never that it may write anywhere (§7.3)
  writeFileSync(aRecipePath, JSON.stringify({ ...aRecipe, fact_addrs: undefined }));
  const job2 = await train({ base_ids: [a, b], mode: 'merge', tier: 'retrain', resolutions: { [key]: 'b' } }, carol);
  const spec2 = JSON.parse(readFileSync(join(N.teach!.get(job2.id)!.job_dir!, 'job.json'), 'utf8')) as { mask: { mode: string; addrs: string[] | null } };
  assert.equal(spec2.mask.mode, 'only');
  assert.equal(spec2.mask.addrs, null);
});
