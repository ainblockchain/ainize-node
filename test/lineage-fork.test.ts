/**
 * Lineage L4 — base selection in both doors, and *Copy and continue* (docs/lineage-teach-design.md §3 Story A/B,
 * §6.2, §7.1, §12.1, §12.3).
 *
 * Everything runs on the `stub` backend with a fake serving model: what is asserted is the CONTRACT the owner asked
 * for — that a creator can start from someone else's questions, add to them, and have the record say so — never a
 * training result.
 *
 * Scenarios AZ-276 … AZ-281 (docs/ux-test-scenarios.json).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIdentity, defaultConfig, signMessage, type Identity, type NodeConfig, type TeachDataset } from '@ngram/core';
import type { ChatMessage, ChatResult } from '../src/runtime.js';
import { startNode, type RunningNode } from '../src/server.js';
import { teachAuthHeaderFor } from '../src/teach-auth.js';
import { canonicalJsonl, readCanonicalJsonl, type CanonicalRow } from '../src/teach-dataset.js';
import type { TeachJob } from '../src/teach.js';

const tmp = mkdtempSync(join(tmpdir(), 'ngram-lineage-fork-test-'));
const PORT = 34081;
const url = `http://127.0.0.1:${PORT}`;
let N: RunningNode;
const teacher = createIdentity();     // publishes the base
const stranger = createIdentity();    // forks it and teaches on top
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
/**
 * The fake model answers a question only while a file that taught it is loaded, and the LAST file applied wins — the
 * one property of the real runtime this test depends on, because it is what makes an override an override. Every
 * job's directory (and the blob a draft keeps in place) carries the job id, so a job's questions can be registered
 * against its own file without knowing where the node put it.
 */
const jobFacts = new Map<string, { prompt: string; answer: string }[]>();
function answerFor(asked: string): string {
  let best: { seq: number; answer: string } | null = null;
  for (const [path, seq] of table) {
    for (const [id, facts] of jobFacts) {
      if (!path.includes(id)) continue;
      for (const f of facts) if (asked.includes(f.prompt) && (!best || seq > best.seq)) best = { seq, answer: f.answer };
    }
  }
  return best ? best.answer : 'I do not know.';
}

// ---------------------------------------------------------------- helpers
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const sign = (id: Identity, method: string, path: string, body?: unknown) =>
  teachAuthHeaderFor(id, { node: N.market.address, method, path, body: body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body) });
type Json = Record<string, unknown> & { dataset?: TeachDataset; job?: TeachJob; error?: string };
const api = async (method: string, path: string, body?: unknown, id: Identity | null = teacher, extra: Record<string, string> = {}) => {
  const headers: Record<string, string> = { ...extra };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (id) headers['x-ngram-auth'] = sign(id, method, path, body);
  const r = await fetch(`${url}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* not json */ }
  return { status: r.status, json: json as Json, text, headers: r.headers };
};

const rows = (n: number, prefix: 'base' | 'mine', from = 0): CanonicalRow[] =>
  Array.from({ length: n }, (_, i) => ({ prompt: `${prefix}${i + from} — what is it?`, answer: `answer-${prefix}-${i + from}` }));

async function upload(r: CanonicalRow[], filename: string, id: Identity = teacher): Promise<TeachDataset> {
  const buf = Buffer.from(canonicalJsonl(r), 'utf8');
  const hex = sha256(buf);
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

async function train(body: Record<string, unknown>, id: Identity = teacher, opts: { expect?: number; teaches?: 'base' | 'mine' } = {}): Promise<TeachJob> {
  const r = await api('POST', '/api/teach/jobs', { patch_ids: [], ...body }, id);
  assert.equal(r.status, opts.expect ?? 202, r.text);
  if ((opts.expect ?? 202) !== 202) return r.json as unknown as TeachJob;
  // registered BEFORE the worker gets to CHECKING: from here the fake model answers this job's questions while its file is loaded
  const id2 = String(r.json.job!.id);
  jobFacts.set(id2, (N.teach!.get(id2)?.facts ?? []).map((f) => ({ prompt: f.prompt, answer: f.answer })));
  return waitFor(id2, ['READY', 'NEEDS_MORE']);
}

async function publish(job: TeachJob, dataset: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}, id: Identity = teacher) {
  const ch = await api('GET', `/api/teach/jobs/${job.id}/publish-challenge`, undefined, id);
  assert.equal(ch.status, 200, ch.text);
  return api('POST', `/api/teach/jobs/${job.id}/publish`, {
    name: extra.name ?? `Lesson ${job.id.slice(0, 6)}`, price: '1', license: 'CC-BY-4.0',
    claim_sig: signMessage(String(ch.json.claim), id.privateKey), consent: { permanent: true, rights: true },
    ...(dataset ? { dataset } : {}), ...extra,
  }, id);
}

/** A published base with `n` of its own questions and the chosen training-set access. */
let nextBaseRow = 0;
async function publishBase(n: number, access: string, name = 'Base'): Promise<string> {
  const first = nextBaseRow; nextBaseRow += n;   // every base owns its own questions: two bases teaching "base0" would be one overlapping listing
  const ds = await upload(rows(n, 'base', first), `${name}.jsonl`);
  const job = await train({ dataset_id: ds.id }, teacher, { teaches: 'base' });
  const pub = await publish(job, { access, license: 'CC-BY-4.0' }, { name });
  assert.equal(pub.status, 200, pub.text);
  assert.equal(pub.json.status, 'ANNOUNCED', pub.text);
  return String(pub.json.patch_id);
}

before(async () => {
  const cfg: NodeConfig = defaultConfig({ home: join(tmp, 'N'), name: 'FORK', port: PORT, peers: [], roles: ['seller', 'serving'], ledger: 'local' });
  // Never the shared model server: a test node built from defaultConfig() would otherwise use the shipped
  // runtime.api (localhost:8002) and reach whatever engine is running on this machine.
  cfg.runtime = { ...cfg.runtime, repo: undefined, api: 'http://127.0.0.1:1', hookApi: 'http://127.0.0.1:1' };
  cfg.host = '127.0.0.1'; cfg.publicUrl = url; cfg.gossipIntervalMs = 60_000;
  cfg.teach = {
    ...cfg.teach!, enabled: true, backend: 'stub', publish: 'auto', lineage: true, jobsPerKeyPerDay: 100, jobsPerIpPerDay: 400,
    dataset: { ...cfg.teach!.dataset, perKeyPerDay: 500, keptPerKey: 500, rowsPerKeyPerDay: 4000, rowsPerIpPerDay: 9000, createsPerIpPerMin: 500 },
  };
  N = await startNode(cfg, { quiet: true, serveWeb: false, teachHooks: { intervalMs: 40, stubDelayMs: 2, runtimeGraceMs: 200, retryMs: 60 } });
  installFakeRuntime();
  opToken = String((await api('POST', '/api/auth/setup', { password: 'fork-pass' }, null)).json.token);
});
after(async () => { await N?.stop(); rmSync(tmp, { recursive: true, force: true }); });

// ---------------------------------------------------------------- AZ-276: copy and continue
test('AZ-276 a stranger copies a published knowledge’s questions: the dataset says which knowledge they came from, every row points at its source row, and copying twice gives the same dataset', async () => {
  const base = await publishBase(4, 'derivative', 'Copyable');
  const r = await api('POST', `/api/patches/${base}/fork`, {}, stranger);
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.inherited_rows, 4);
  assert.deepEqual(r.json.parent, { patch_id: base, name: 'Copyable', dataset_sha256: (await N.market.entry(base))!.anchor.dataset!.sha256 });
  const ds = r.json.dataset as TeachDataset;
  assert.equal(ds.parent_patch, base);
  assert.equal(ds.owner_address.toLowerCase(), stranger.address.toLowerCase());
  assert.equal(ds.rows, 4);
  // the pointers are in the bytes, in order
  const file = readCanonicalJsonl(readFileSync(join(N.teach!.datasets.dir(ds.id), 'rows.jsonl'), 'utf8'));
  assert.deepEqual(file.map((x) => x.from), [0, 1, 2, 3].map((i) => `${base}#${i}`));
  // …and the preview table shows them, so the browser does not have to guess what is inherited
  const page = await api('GET', `/api/teach/datasets/${ds.id}/rows?limit=10`, undefined, stranger);
  assert.equal(page.status, 200, page.text);
  assert.deepEqual((page.json.items as { from?: string }[]).map((x) => x.from), file.map((x) => x.from));
  // idempotent: the same bytes are the same dataset, not a second copy
  const again = await api('POST', `/api/patches/${base}/fork`, {}, stranger);
  assert.equal(again.status, 200, again.text);
  assert.equal(again.json.dataset_id, ds.id);
  assert.equal(again.json.created, false);
});

// ---------------------------------------------------------------- AZ-277: a private base cannot be copied
test('AZ-277 a knowledge whose creator kept the questions private cannot be copied, and says why', async () => {
  const priv = await publishBase(3, 'private', 'Sealed');
  const r = await api('POST', `/api/patches/${priv}/fork`, {}, stranger);
  assert.equal(r.status, 403, r.text);
  assert.match(String(r.json.error), /^dataset_private:/);
  assert.match(String(r.json.error), /kept the questions private/);
  // its own creator still gets their questions back
  const mine = await api('POST', `/api/patches/${priv}/fork`, {}, teacher);
  assert.equal(mine.status, 201, mine.text);
  // and an unknown id is an unknown id, whoever asks
  const gone = await api('POST', '/api/patches/no-such-knowledge/fork', {}, stranger);
  assert.equal(gone.status, 404, gone.text);
});

// ---------------------------------------------------------------- AZ-278: teaching on top of the copy
test('AZ-278 teaching on top of a copied set: the inherited questions are the keep-set, not the lesson; a changed answer is trained and named; the anchor records the base', async () => {
  const base = await publishBase(4, 'derivative', 'Extendable');
  const fork = await api('POST', `/api/patches/${base}/fork`, { name: 'mine on top' }, stranger);
  assert.equal(fork.status, 201, fork.text);
  const dsId = String(fork.json.dataset_id);
  const inherited = readCanonicalJsonl(readFileSync(join(N.teach!.datasets.dir(dsId), 'rows.jsonl'), 'utf8'));

  // the creator appends two of their own questions and changes one of the base's answers
  const add = await api('PATCH', `/api/teach/datasets/${dsId}`, { rows_op: { op: 'append', rows: rows(2, 'mine') } }, stranger);
  assert.equal(add.status, 200, add.text);
  // the client sends the new answer only: the node turns the row's `from` into `replaces` itself (§6.7)
  const edit = await api('PATCH', `/api/teach/datasets/${dsId}`, { rows_op: { op: 'replace', index: 1, row: { prompt: inherited[1].prompt, answer: 'a better answer' } } }, stranger);
  assert.equal(edit.status, 200, edit.text);
  assert.equal((edit.json.dataset as TeachDataset).rows, 6);

  const job = await train({ dataset_id: dsId, base_ids: [base] }, stranger, { teaches: 'mine' });
  // 4 inherited − 1 changed = 3 kept as known; 2 mine + 1 changed = 3 trained
  assert.equal(job.facts.length, 3, JSON.stringify(job.facts));
  assert.deepEqual(job.facts.map((f) => f.answer).sort(), ['a better answer', 'answer-mine-0', 'answer-mine-1']);
  assert.equal(job.inherited_rows, 3);
  assert.equal(job.changed_rows, 1);
  assert.equal(job.mode, 'fork');
  assert.deepEqual(job.bases?.map((b) => b.patch_id), [base]);

  const dir = N.teach!.get(job.id)!.job_dir!;
  const known = readCanonicalJsonl(readFileSync(join(dir, 'known.jsonl'), 'utf8'));
  assert.equal(known.length, 3, 'the keep-set is what the creator KEPT of the base, not the base’s whole set');
  assert.ok(known.every((r) => r.from?.startsWith(`${base}#`)));
  const spec = JSON.parse(readFileSync(join(dir, 'job.json'), 'utf8')) as { parents: { patch_id: string }[]; known_file: string; replaces: number[]; export: string; probe_with_parents: boolean };
  assert.deepEqual(spec.parents.map((p) => p.patch_id), [base]);
  assert.equal(spec.known_file, 'known.jsonl');
  assert.equal(spec.export, 'delta');
  assert.equal(spec.probe_with_parents, true);
  assert.deepEqual(spec.replaces, job.facts.flatMap((f, i) => (f.replaces ? [i] : [])), 'the trainer is told which facts override an inherited answer');
  assert.equal(spec.replaces.length, 1);
  const kept = readCanonicalJsonl(readFileSync(join(N.teach!.datasets.dir(dsId), 'rows.jsonl'), 'utf8'));
  assert.equal(kept[1].replaces, inherited[1].from, 'the edited row still says which of the base’s questions it stands in for');
  assert.equal(kept[1].from, undefined);

  // §7.6 steps 3 and 5: the base was measured BEFORE the lesson went on top, the question this lesson replaces is
  // counted as replaced instead of as a regression, and what is left is what the base still answers underneath.
  const pc = job.checks!.parent_check![0];
  assert.equal(pc.patch_id, base);
  assert.equal(pc.base_total, 4);
  assert.equal(pc.base_hit, 4, 'the base answered its own four questions with nothing of mine on top');
  assert.equal(pc.overridden, 1);
  assert.equal(pc.total, 3);
  assert.equal(pc.hit, 3);
  assert.deepEqual(pc.failed, []);
  assert.equal(job.checks!.parent_regression.ok, true);
  assert.equal(job.checks!.reversibility_ok, true);

  const pub = await publish(job, { access: 'derivative', license: 'CC-BY-4.0' }, { name: 'Child of Extendable' }, stranger);
  assert.equal(pub.status, 200, pub.text);
  const child = (await N.market.entry(String(pub.json.patch_id)))!.anchor;
  assert.deepEqual(child.parents, [base]);
  assert.equal(child.derivation?.kind, 'extend');
  assert.equal(child.dataset?.parents?.[0]?.patch_id, base);
  // …and the counts are the rows, not a claim: 2 added, 1 changed, 0 of the base's questions dropped
  assert.equal(child.derivation?.added_rows, 2);
  assert.equal(child.derivation?.changed_rows, 1);
  assert.equal(child.derivation?.removed_rows, 0);
  assert.equal(child.derivation?.bases[0].rows, 3, 'three of the base’s four questions are still here unchanged');
  assert.equal(child.dataset?.parents?.[0]?.rows, 3);
  // the published set says, row by row, which of the base's questions it is
  const manifest = N.market.datasets.manifest(child.dataset!.sha256)!;
  assert.equal(manifest.row_origin.length, 6);
  assert.deepEqual(manifest.row_origin.filter(Boolean), [`${base}#0`, `${base}#2`, `${base}#3`]);
  assert.deepEqual(manifest.changed, [1]);
  assert.deepEqual(manifest.removed, []);
});

// ---------------------------------------------------------------- AZ-279: a copy with nothing added
test('AZ-279 a copy with nothing of my own in it cannot be trained on top of its own base — it is told, not silently trained', async () => {
  const base = await publishBase(3, 'derivative', 'Nothing added');
  const fork = await api('POST', `/api/patches/${base}/fork`, {}, stranger);
  assert.equal(fork.status, 201, fork.text);
  const r = await api('POST', '/api/teach/jobs', { patch_ids: [], dataset_id: fork.json.dataset_id, base_ids: [base] }, stranger);
  assert.equal(r.status, 400, r.text);
  assert.match(String(r.json.error), /^nothing_to_add:/);
});

// ---------------------------------------------------------------- AZ-280: pre-flight with a base
test('AZ-280 pre-flight judged with the base loaded: in_base, base_conflict with the base’s own answer, will_train — and the counters the base’s page is made of', async () => {
  const base = await publishBase(3, 'derivative', 'Judged');
  const its = readCanonicalJsonl(readFileSync(join(N.market.datasets.dirFor((await N.market.entry(base))!.anchor.dataset!.sha256), 'rows.jsonl'), 'utf8'));
  const facts = [
    { prompt: its[0].prompt, answer: its[0].answer },                    // the base already answers this, the same way
    { prompt: its[1].prompt, answer: 'something else entirely' },        // the base answers this question differently
    { prompt: 'mine9 — what is it?', answer: 'answer-mine-9' },          // nobody answers this
  ];
  const before = N.store.signals(base, 30);
  const r = await api('POST', '/api/teach/preflight', { base_ids: [base], context_ids: [], facts }, stranger);
  assert.equal(r.status, 200, r.text);
  const got = r.json.facts as { index: number; status: string; base_id?: string; base_answer?: string }[];
  assert.deepEqual(got.map((f) => f.status), ['in_base', 'base_conflict', 'will_train']);
  assert.equal(got[0].base_id, base);
  assert.equal(got[1].base_id, base);
  assert.equal(got[1].base_answer, its[1].answer, 'the conflict shows the base’s OWN answer, not a guess from the model');
  assert.equal(r.json.trainable, 2, 'a conflict is trainable — as a change — and an in_base row is not');
  assert.deepEqual(r.json.bases, [base]);
  const after = N.store.signals(base, 30);
  assert.equal(after.preflight_in_base - before.preflight_in_base, 1);
  assert.equal(after.preflight_base_conflict - before.preflight_base_conflict, 1);
  assert.equal(after.preflight_wrong_today - before.preflight_wrong_today, 1);
});

// ---------------------------------------------------------------- AZ-281: an answer that changes the base's answer
test('AZ-281 an answer that contradicts the base is refused until it is meant, then trained as a change to it', async () => {
  const base = await publishBase(3, 'derivative', 'Contradicted');
  const its = readCanonicalJsonl(readFileSync(join(N.market.datasets.dirFor((await N.market.entry(base))!.anchor.dataset!.sha256), 'rows.jsonl'), 'utf8'));
  const ds = await upload([{ prompt: its[0].prompt, answer: 'the corrected answer' }, ...rows(1, 'mine', 20)], 'contradiction.jsonl', stranger);

  const refused = await api('POST', '/api/teach/jobs', { patch_ids: [], dataset_id: ds.id, base_ids: [base] }, stranger);
  assert.equal(refused.status, 400, refused.text);
  assert.match(String(refused.json.error), /^base_unresolved_conflicts:/);
  const conflict = (refused.json.rows as { prompt: string; base_answer: string; base_id: string }[])[0];
  assert.equal(conflict.prompt, its[0].prompt);
  assert.equal(conflict.base_answer, its[0].answer);
  assert.equal(conflict.base_id, base);

  const job = await train({ dataset_id: ds.id, base_ids: [base], confirm_conflicts: true }, stranger, { teaches: 'mine' });
  assert.equal(job.changed_rows, 1, 'the confirmed row is recorded as a change to the base, not as a new question');
  assert.equal(job.facts.find((f) => f.answer === 'the corrected answer')?.replaces, `${base}#0`);
  const pc = job.checks!.parent_check![0];
  assert.equal(pc.overridden, 1);
  assert.equal(job.checks!.parent_regression.ok, true, 'a change the creator declared is not a regression of the base');
});

// ---------------------------------------------------------------- AZ-293: the keep-set is not a deletion (found by L6's tree)
test('AZ-293 a lesson taught on top WITHOUT copying keeps the base’s questions by reference — the family tree does not report them as deleted', async () => {
  const base = await publishBase(3, 'derivative', 'Kept by reference');
  // the plain path a creator takes from the chat door: my own questions, someone else's knowledge underneath, no copy
  const ds = await upload(rows(2, 'mine', 40), 'own-questions.jsonl', stranger);
  const job = await train({ dataset_id: ds.id, base_ids: [base] }, stranger, { teaches: 'mine' });
  assert.equal(job.inherited_rows, 3, 'the base’s three questions are the keep-set');
  assert.equal(job.changed_rows, 0);

  const pub = await publish(job, { access: 'derivative', license: 'CC-BY-4.0' }, { name: 'On top, no copy' }, stranger);
  assert.equal(pub.status, 200, pub.text);
  const child = (await N.market.entry(String(pub.json.patch_id)))!.anchor;
  assert.equal(child.derivation?.added_rows, 2);
  assert.equal(child.derivation?.changed_rows, 0);
  assert.equal(child.derivation?.removed_rows, 0, 'questions kept as known answers were never held, and so were never dropped');
  assert.equal(child.derivation?.bases[0].rows, 3);
  assert.deepEqual(N.market.datasets.manifest(child.dataset!.sha256)!.removed, []);

  // and the number the family tree prints is the same one
  const tree = await api('GET', `/api/patches/${child.id}/tree`, undefined, null);
  assert.equal(tree.status, 200, tree.text);
  const node = (tree.json.nodes as { id: string; added: { questions: number; changed: number; removed: number } }[]).find((n) => n.id === child.id)!;
  assert.deepEqual(node.added, { questions: 2, changed: 0, removed: 0, rows: node.added.rows, new: (node.added as { new: number }).new } as never);
});

// ---------------------------------------------------------------- AZ-298: the issue lifecycle (§10), end to end
test('AZ-298 a question somebody asked for is closed by the child that answers it, and the answer names the child', async () => {
  const base = await publishBase(2, 'derivative', 'Has a gap');
  const wanted = 'mine60 — what is it?';                        // the question the child will teach, asked here first
  // asked with different spacing — the same question by the parser's rule (F13), which is case-sensitive on purpose
  const asked = await api('POST', `/api/patches/${base}/issues`, { text: `  ${wanted.replace(' — ', '  —   ')} `, share: false }, stranger);
  assert.equal(asked.status, 201, asked.text);
  assert.equal(asked.json.shared, false, 'nobody consented to keep the wording');
  const open = (await api('GET', `/api/patches/${base}/issues`, undefined, null)).json as { total: number; items: { status: string; text: string | null }[] };
  assert.equal(open.total, 1);
  assert.equal(open.items[0].text, null);

  // …a stranger teaches exactly that question on top of the base and publishes it
  const ds = await upload(rows(1, 'mine', 60), 'the-gap.jsonl', stranger);
  const job = await train({ dataset_id: ds.id, base_ids: [base] }, stranger, { teaches: 'mine' });
  const pub = await publish(job, { access: 'derivative', license: 'CC-BY-4.0' }, { name: 'Fills the gap' }, stranger);
  assert.equal(pub.status, 200, pub.text);
  const child = String(pub.json.patch_id);

  const after = (await api('GET', `/api/patches/${base}/issues?status=all`, undefined, null)).json as { items: { status: string; covered_by: string | null }[] };
  assert.equal(after.items.length, 1);
  assert.equal(after.items[0].status, `covered_by:${child}`, 'the same question, recognised by its cluster key — not by its text, which was never kept');
  assert.equal(after.items[0].covered_by, child);
  assert.equal(((await api('GET', `/api/patches/${base}/issues`, undefined, null)).json as { total: number }).total, 0, 'and it is no longer an open question');
});
