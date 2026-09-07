/**
 * Lineage L0/L1 on a real node (docs/lineage-teach-design.md §5, §6, §7.1, §12.1, §12.3, §12.6).
 *
 * Everything here runs on the `stub` backend with a fake serving model, so what is measured is the CONTRACT, never a
 * training result: the job carries an ordered base stack, the exported file starts from the base's values on every
 * overlapping address, the anchor says what it was built on, and the training set becomes a content-addressed blob
 * that is served (or refused) by its access level.
 *
 * Scenarios AZ-238 … AZ-245 and AZ-252 (docs/ux-test-scenarios.json).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  answersHash, createIdentity, defaultConfig, hashCanonical, readNpzMember, signMessage, TEACH_SAMPLES_ON_CHAIN,
  type BenchmarkSample, type Identity, type NodeConfig, type PatchAnchor, type TeachDataset,
} from '@ainize/core';
import type { ChatMessage, ChatResult } from '../src/runtime.js';
import { startNode, type RunningNode } from '../src/server.js';
import { teachAuthHeaderFor } from '../src/teach-auth.js';
import { authHeader } from '../src/p2p.js';
import { canonicalJsonl, readCanonicalJsonl, type CanonicalRow } from '../src/teach-dataset.js';
import { decodeBenchmarkJsonl } from '../src/dataset-blobs.js';
import type { TeachJob } from '../src/teach.js';

const tmp = mkdtempSync(join(tmpdir(), 'ngram-lineage-test-'));
const PORT = 34065;   // payouts.test.ts already owns 34051 — sharing it made both files fail with EADDRINUSE when the suite runs as one process pool
const url = `http://127.0.0.1:${PORT}`;
let N: RunningNode;
const teacher = createIdentity();
const stranger = createIdentity();
let opToken = '';

// ---------------------------------------------------------------- fake serving model (nothing here is a measurement)
const table = new Map<string, number>();
let seq = 0;
function installFakeRuntime() {
  const rt = N.market.runtime as unknown as Record<string, unknown>;
  Object.assign(rt, {
    status: async () => ({ available: true, api: 'fake', model: 'demo-ainize-1b', hook: true, repo: null, applied: [] }),
    isApplied: async (p: string) => table.has(p),
    applyRaw: async (p: string) => { table.set(p, ++seq); return { code: 0, out: 'ok', err: '' }; },
    removeRaw: async (p: string) => { table.delete(p); return { code: 0, out: 'ok', err: '' }; },
    completeRaw: async (p: string) => taught(p) ?? 'I do not know',
    chat: async (m: ChatMessage[]): Promise<ChatResult> => ({ content: taught([...m].reverse().find((x) => x.role === 'user')?.content ?? '') ?? 'I do not know.', latency_ms: 1, model: 'demo-ainize-1b' }),
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

type Json = Record<string, unknown> & { dataset?: TeachDataset; job?: TeachJob; error?: string };
const api = async (method: string, path: string, body?: unknown, id: Identity | null = teacher, extra: Record<string, string> = {}) => {
  const headers: Record<string, string> = { ...extra };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (id) headers['x-ainize-auth'] = sign(id, method, path, body);
  const r = await fetch(`${url}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* not json */ }
  return { status: r.status, json: json as Json, text, headers: r.headers };
};
const op = () => ({ authorization: `Bearer ${opToken}` });

const rows = (n: number, prefix: string): CanonicalRow[] =>
  Array.from({ length: n }, (_, i) => ({ prompt: `${prefix}${i} — what is the ${i}th ${prefix} thing?`, answer: `answer-${i}` }));

async function upload(r: CanonicalRow[], filename: string, id: Identity = teacher): Promise<TeachDataset> {
  const buf = Buffer.from(canonicalJsonl(r), 'utf8');
  const hex = sha256(buf);
  const form = new FormData();
  form.set('file', new Blob([new Uint8Array(buf)]), filename);
  const res = await fetch(`${url}/api/teach/datasets`, {
    method: 'POST',
    headers: { 'x-ainize-dataset-sha256': hex, 'x-ainize-auth': teachAuthHeaderFor(id, { node: N.market.address, method: 'POST', path: '/api/teach/datasets', body: hex }) },
    body: form,
  });
  const j = (await res.json()) as { dataset?: TeachDataset; error?: string };
  assert.ok(j.dataset, `upload ${filename} failed: ${res.status} ${JSON.stringify(j).slice(0, 200)}`);
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

/** Train `ds` (optionally on top of `base`) and wait for READY. */
async function train(ds: TeachDataset, opts: { base?: string; id?: Identity; expect?: number } = {}): Promise<TeachJob> {
  const id = opts.id ?? teacher;
  const body = { patch_ids: [], dataset_id: ds.id, ...(opts.base ? { base_ids: [opts.base] } : {}) };
  const r = await api('POST', '/api/teach/jobs', body, id);
  assert.equal(r.status, opts.expect ?? 202, r.text);
  if ((opts.expect ?? 202) !== 202) return r.json as unknown as TeachJob;
  return waitFor(r.json.job!.id, ['READY', 'NEEDS_MORE']);
}

/** Publish and (publish mode is `auto` here) announce, with the training-set section of the sheet. */
async function publish(job: TeachJob, dataset: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}, id: Identity = teacher) {
  const ch = await api('GET', `/api/teach/jobs/${job.id}/publish-challenge`, undefined, id);
  assert.equal(ch.status, 200, ch.text);
  const body = {
    name: extra.name ?? `Lesson ${job.id.slice(0, 6)}`, price: '1', license: 'CC-BY-4.0',
    claim_sig: signMessage(String(ch.json.claim), id.privateKey), consent: { permanent: true, rights: true },
    ...(dataset ? { dataset } : {}), ...extra,
  };
  return api('POST', `/api/teach/jobs/${job.id}/publish`, body, id);
}

/** A published knowledge to build on: its own dataset, trained, announced, with the chosen training-set access. */
async function published(prefix: string, n: number, dataset: Record<string, unknown>, id: Identity = teacher): Promise<{ id: string; anchor: PatchAnchor; job: TeachJob }> {
  const ds = await upload(rows(n, prefix), `${prefix}.jsonl`, id);
  const job = await train(ds, { id });
  const pub = await publish(job, dataset, { name: `Base ${prefix}` }, id);
  assert.equal(pub.status, 200, pub.text);
  assert.equal(pub.json.status, 'ANNOUNCED', pub.text);
  const patchId = String(pub.json.patch_id);
  const entry = (await N.market.entry(patchId))!;
  return { id: patchId, anchor: entry.anchor, job };
}

const npz = (path: string) => {
  const a = readNpzMember(path, 'addrs'), b = readNpzMember(path, 'before'), c = readNpzMember(path, 'after');
  const D = b.header.shape[1];
  const out = new Map<bigint, { before: number[]; after: number[] }>();
  for (let r = 0; r < a.header.shape[0]; r++) {
    const addr = a.body.readBigInt64LE(8 * r);
    const rd = (buf: Buffer) => Array.from({ length: D }, (_, i) => buf.readFloatLE(4 * (D * r + i)));
    out.set(addr, { before: rd(b.body), after: rd(c.body) });
  }
  return out;
};

before(async () => {
  const cfg: NodeConfig = defaultConfig({ home: join(tmp, 'N'), name: 'LIN', port: PORT, peers: [], roles: ['seller', 'serving'], ledger: 'local' });
  // Never the shared model server: a test node built from defaultConfig() would otherwise use the shipped
  // runtime.api (localhost:8002) and reach whatever engine is running on this machine.
  cfg.runtime = { ...cfg.runtime, repo: undefined, api: 'http://127.0.0.1:1', hookApi: 'http://127.0.0.1:1' };
  cfg.host = '127.0.0.1'; cfg.publicUrl = url; cfg.gossipIntervalMs = 60_000;
  cfg.teach = {
    ...cfg.teach!, enabled: true, backend: 'stub', checkStubLessons: true, publish: 'auto', lineage: true, jobsPerKeyPerDay: 100, jobsPerIpPerDay: 400,
    dataset: { ...cfg.teach!.dataset, perKeyPerDay: 500, keptPerKey: 500, rowsPerKeyPerDay: 4000, rowsPerIpPerDay: 9000, createsPerIpPerMin: 500 },
  };
  N = await startNode(cfg, { quiet: true, serveWeb: false, teachHooks: { intervalMs: 40, stubDelayMs: 2, runtimeGraceMs: 200, retryMs: 60 } });
  installFakeRuntime();
  opToken = String((await api('POST', '/api/auth/setup', { password: 'lin-pass' }, null)).json.token);
});
after(async () => { await N?.stop(); rmSync(tmp, { recursive: true, force: true }); });

// ---------------------------------------------------------------- AZ-238: the anchor carries what it was built on
test('AZ-238 a lesson taught on top of a published knowledge: job.json carries the stack, the delta starts from the base values, the anchor says so', async () => {
  const base = await published('base', 4, { access: 'derivative', license: 'CC-BY-4.0' });
  assert.equal(base.anchor.dataset?.access, 'derivative');
  assert.equal(base.anchor.dataset?.license, 'CC-BY-4.0');
  assert.ok(N.market.datasets.has(base.anchor.dataset!.sha256), 'publishing pins the training set under its own sha');

  const ds = await upload(rows(3, 'child'), 'child.jsonl', stranger);
  const job = await train(ds, { base: base.id, id: stranger });
  assert.deepEqual(job.bases?.map((b) => b.patch_id), [base.id], 'the ordered base stack is on the job');
  assert.equal(job.mode, 'extend');
  assert.equal(job.export, 'delta');

  // job.json — the trainer contract (design §7.1)
  const dir = N.teach!.get(job.id)!.job_dir!;
  const spec = JSON.parse(readFileSync(join(dir, 'job.json'), 'utf8')) as { parents: { patch_id: string; sha256: string; npz: string }[]; known_file: string | null; export: string; probe_with_parents: boolean; max_known: number };
  assert.deepEqual(spec.parents.map((p) => p.patch_id), [base.id]);
  assert.equal(spec.parents[0].sha256, base.anchor.patch_sha256);
  assert.ok(existsSync(spec.parents[0].npz), 'the base body is copied next to the job');
  assert.equal(spec.export, 'delta');
  assert.equal(spec.probe_with_parents, true);
  assert.equal(spec.known_file, 'known.jsonl');
  // the base's questions are inherited as the keep-set
  const known = readCanonicalJsonl(readFileSync(join(dir, 'known.jsonl'), 'utf8'));
  assert.equal(known.length, 4, "the base's four questions are loaded as known answers");
  assert.deepEqual(known.map((r) => r.answer), rows(4, 'base').map((r) => r.answer));

  // the exported file IS a delta over the base: `before` equals the base's `after` on every overlapping address
  const parent = npz(spec.parents[0].npz);
  const child = npz(N.teach!.get(job.id)!.npz_path!);
  const overlap = [...child.keys()].filter((a) => parent.has(a));
  assert.ok(overlap.length > 0, 'the stub touches some of the base rows, which is what makes this a delta');
  for (const addr of overlap) assert.deepEqual(child.get(addr)!.before, parent.get(addr)!.after, `before == parent.after on ${addr}`);
  for (const addr of [...child.keys()].filter((a) => !parent.has(a))) assert.deepEqual(child.get(addr)!.before, new Array(child.get(addr)!.before.length).fill(0), 'a fresh address starts from the disk base');
  // and it is self-describing (design §5.4)
  const meta = JSON.parse(readNpzMember(N.teach!.get(job.id)!.npz_path!, 'meta').body.toString('utf8')) as { export: string; base_stack: { patch_id: string }[]; pre_state_sha256: string };
  assert.equal(meta.export, 'delta');
  assert.deepEqual(meta.base_stack.map((b) => b.patch_id), [base.id]);

  // the anchor (design §5.1)
  const draft = N.store.getDraft(job.draft_id!)!.anchor;
  assert.deepEqual(draft.parents, [base.id], 'every knowledge in the stack is a parent — that is how the base is paid');
  assert.equal(draft.derivation?.kind, 'extend');
  assert.deepEqual(draft.derivation?.bases.map((b) => [b.patch_id, b.patch_sha256, b.rows]), [[base.id, base.anchor.patch_sha256, 4]]);
  assert.equal(draft.derivation?.added_rows, 3);
  assert.deepEqual(draft.base?.stack.map((b) => b.patch_id), [base.id]);
  assert.equal(draft.base?.export, 'delta');
  assert.match(draft.base!.pre_state_sha256, /^[0-9a-f]{64}$/);
  assert.equal(draft.base!.pre_state_sha256, meta.pre_state_sha256, 'the record commits to the state the delta was trained against');
  assert.deepEqual(draft.dataset?.parents?.map((p) => [p.patch_id, p.sha256, p.rows]), [[base.id, base.anchor.dataset!.sha256, 4]]);
  // one sample per base travels with the child so a verifier can score per source without fetching the base
  const withSource = (draft.benchmark.samples ?? []).filter((s) => s.source);
  assert.deepEqual(withSource.map((s) => s.source), [base.id]);

  // the detail page tells a buyer what else is needed (design §12.5 `requires`)
  const detail = await api('GET', `/api/patches/${job.draft_id}`, undefined, null, op());
  assert.deepEqual((detail.json.requires as { id: string; held: boolean }[]).map((r) => [r.id, r.held]), [[base.id, true]]);
});

// ---------------------------------------------------------------- AZ-239: the cap and the hash of the full list
test('AZ-239 a taught anchor carries at most 32 samples, and answers_hash is the hash of the full list served with the training set', async () => {
  const ds = await upload(rows(40, 'cap'), 'cap.jsonl');
  const job = await train(ds);
  const pub = await publish(job, { access: 'public', license: 'CC0-1.0' }, { name: 'Forty questions' });
  assert.equal(pub.status, 200, pub.text);
  const anchor = (await N.market.entry(String(pub.json.patch_id)))!.anchor;
  assert.equal(anchor.benchmark.samples!.length, TEACH_SAMPLES_ON_CHAIN, 'the ledger carries a slice, not the whole list');
  assert.match(anchor.benchmark.answers_hash!, /^[0-9a-f]{64}$/);
  const full = decodeBenchmarkJsonl(readFileSync(N.market.datasets.benchmarkPath(anchor.dataset!.sha256), 'utf8'));
  assert.ok(full.length > TEACH_SAMPLES_ON_CHAIN, 'the full list lives beside the rows in the blob');
  assert.equal(answersHash(full), anchor.benchmark.answers_hash, 'the hash on the record is recomputable from the published list');
  assert.deepEqual(full.slice(0, TEACH_SAMPLES_ON_CHAIN), anchor.benchmark.samples, 'the on-chain samples are the first of the same list');
  const manifest = N.market.datasets.manifest(anchor.dataset!.sha256)!;
  assert.equal(manifest.benchmark_samples, full.length);
  assert.equal(manifest.rows, 40);
  assert.equal(manifest.access, 'public');
  assert.equal(manifest.license, 'CC0-1.0');
  assert.equal(manifest.sha256, anchor.dataset!.sha256);
  assert.equal(sha256(readFileSync(N.market.datasets.rowsPath(anchor.dataset!.sha256))), anchor.dataset!.sha256, 'the pinned bytes hash to the sha on the record');
});

// ---------------------------------------------------------------- AZ-240: access levels
test('AZ-240 the training set is served by its access level: public downloads, derivative needs a key and a derive token, private is refused with a reason', async () => {
  const pub = await published('open', 3, { access: 'public', license: 'CC-BY-4.0' });
  const der = await published('deriv', 3, { access: 'derivative', license: 'CC-BY-4.0' });
  const priv = await published('secret', 3, { access: 'private', license: 'Proprietary' });

  // public: anyone, signed or not, sees the preview and can download the rows
  const anon = await api('GET', `/api/patches/${pub.id}/dataset`, undefined, null);
  assert.equal(anon.status, 200, anon.text);
  assert.equal(anon.json.access, 'public');
  assert.equal((anon.json.preview as CanonicalRow[]).length, 3);
  assert.equal((anon.json.preview as CanonicalRow[])[0].prompt, rows(3, 'open')[0].prompt);
  const dl = await api('GET', `/api/patches/${pub.id}/dataset/rows`, undefined, null);
  assert.equal(dl.status, 200, dl.text);
  assert.equal(sha256(dl.text), pub.anchor.dataset!.sha256, 'the bytes served are the bytes the record names');

  // derivative: a signed key previews it; an anonymous request is told what to do; the rows need the p2p path
  const anonDer = await api('GET', `/api/patches/${der.id}/dataset`, undefined, null);
  assert.equal(anonDer.status, 403); assert.match(anonDer.json.error!, /^dataset_derivative_only/);
  const keyed = await api('GET', `/api/patches/${der.id}/dataset`, undefined, stranger);
  assert.equal(keyed.status, 200, keyed.text);
  assert.equal((keyed.json.preview as CanonicalRow[]).length, 3);
  assert.equal((await api('GET', `/api/patches/${der.id}/dataset/rows`, undefined, stranger)).status, 403);

  // private: nobody but the owner, whatever they sign with
  const strangerPriv = await api('GET', `/api/patches/${priv.id}/dataset`, undefined, stranger);
  assert.equal(strangerPriv.status, 403); assert.match(strangerPriv.json.error!, /^dataset_private/);
  const ownerPriv = await api('GET', `/api/patches/${priv.id}/dataset`, undefined, teacher);
  assert.equal(ownerPriv.status, 200, 'the teacher who wrote the questions always sees them');
  assert.equal((await api('POST', `/api/patches/${priv.id}/derive-intent`, {}, stranger)).status, 403);

  // derive intent → a token that opens /p2p/dataset/<sha> for a derivative set (design §6.6)
  const intent = await api('POST', `/api/patches/${der.id}/derive-intent`, {}, stranger);
  assert.equal(intent.status, 200, intent.text);
  assert.equal(intent.json.sha256, der.anchor.dataset!.sha256);
  assert.ok(String(intent.json.token).length >= 32);
  const sha = der.anchor.dataset!.sha256;
  const p2pAuth = { 'x-ainize-auth': authHeader(stranger, `dataset:${sha}`) };
  const noToken = await fetch(`${url}/p2p/dataset/${sha}`, { headers: p2pAuth });
  assert.equal(noToken.status, 403);
  const withToken = await fetch(`${url}/p2p/dataset/${sha}`, { headers: { ...p2pAuth, 'x-ainize-derive': String(intent.json.token) } });
  assert.equal(withToken.status, 200);
  assert.equal(sha256(Buffer.from(await withToken.arrayBuffer())), sha);
  // the private set is never served over p2p either, token or not
  const privSha = priv.anchor.dataset!.sha256;
  const privRes = await fetch(`${url}/p2p/dataset/${privSha}`, { headers: { 'x-ainize-auth': authHeader(stranger, `dataset:${privSha}`) } });
  assert.equal(privRes.status, 403);
  // this node advertises what it holds
  const listed = await fetch(`${url}/p2p/datasets`).then((r) => r.json()) as { datasets: { sha256: string; access: string }[] };
  assert.ok(listed.datasets.some((d) => d.sha256 === sha && d.access === 'derivative'));
  assert.ok((await N.market.selfInfo()).datasets!.includes(sha), 'PeerInfo advertises the sets this node holds');
});

// ---------------------------------------------------------------- AZ-241: building on a private base is refused, with the reason
test('AZ-241 a base whose questions are private cannot be built on; the flag gates the whole feature', async () => {
  const priv = await published('closed', 3, { access: 'private', license: 'Proprietary' });
  const ds = await upload(rows(2, 'try'), 'try.jsonl', stranger);
  const refused = await api('POST', '/api/teach/jobs', { patch_ids: [], dataset_id: ds.id, base_ids: [priv.id] }, stranger);
  assert.equal(refused.status, 400, refused.text);
  assert.match(refused.json.error!, /^base_private/);
  const unknown = await api('POST', '/api/teach/jobs', { patch_ids: [], dataset_id: ds.id, base_ids: ['no-such-knowledge'] }, stranger);
  assert.equal(unknown.status, 400); assert.match(unknown.json.error!, /^base_unknown/);
  // §14: two bases used to be refused with `merge_not_available`; since L7 two bases IS a merge, so the refusal is
  // now about the ids themselves — the first one that does not resolve, in order.
  const two = await api('POST', '/api/teach/jobs', { patch_ids: [], dataset_id: ds.id, base_ids: ['a', 'b'] }, stranger);
  assert.equal(two.status, 400); assert.match(two.json.error!, /^base_unknown/);
  const three = await api('POST', '/api/teach/jobs', { patch_ids: [], dataset_id: ds.id, base_ids: [priv.id, 'b', 'c'] }, stranger);
  assert.equal(three.status, 400); assert.match(three.json.error!, /^too_many_bases/);

  // the feature flag (design §18): with `teach.lineage` off, a base is refused before anything is charged
  N.cfg.teach!.lineage = false;
  N.teach!.invalidatePolicy();
  const off = await api('POST', '/api/teach/jobs', { patch_ids: [], dataset_id: ds.id, base_ids: [priv.id] }, stranger);
  assert.equal(off.status, 403, off.text);
  assert.match(off.json.error!, /^lineage_disabled/);
  assert.equal((await api('GET', '/api/teach/policy')).json.lineage, false);
  N.cfg.teach!.lineage = true;
  N.teach!.invalidatePolicy();
  assert.equal((await api('GET', '/api/teach/policy')).json.lineage, true);
});

// ---------------------------------------------------------------- AZ-242: licences
test('AZ-242 licences: an unknown one is refused, a CC-BY-SA base forces the child, a Proprietary base publishes no inherited samples', async () => {
  const sa = await published('share', 3, { access: 'derivative', license: 'CC-BY-SA-4.0' });
  const ds = await upload(rows(2, 'sachild'), 'sachild.jsonl', stranger);
  const job = await train(ds, { base: sa.id, id: stranger });

  const bad = await publish(job, { access: 'derivative', license: 'NOT-A-LICENCE' }, {}, stranger);
  assert.equal(bad.status, 400, bad.text); assert.match(bad.json.error!, /^bad_license/);
  const incompatible = await publish(job, { access: 'derivative', license: 'CC-BY-4.0' }, {}, stranger);
  assert.equal(incompatible.status, 400, incompatible.text);
  assert.match(incompatible.json.error!, /^license_incompatible/);
  assert.equal(incompatible.json.parent, sa.id);
  const ok = await publish(job, { access: 'derivative', license: 'CC-BY-SA-4.0' }, {}, stranger);
  assert.equal(ok.status, 200, ok.text);
  assert.equal((await N.market.entry(String(ok.json.patch_id)))!.anchor.dataset!.license, 'CC-BY-SA-4.0');

  // Proprietary base: the child may build on it, but none of the base's questions travel on the child's record (§6.4)
  const prop = await published('prop', 3, { access: 'derivative', license: 'Proprietary' });
  const ds2 = await upload(rows(2, 'propchild'), 'propchild.jsonl', stranger);
  const job2 = await train(ds2, { base: prop.id, id: stranger });
  const draft2 = N.store.getDraft(job2.draft_id!)!.anchor;
  assert.deepEqual((draft2.benchmark.samples ?? []).filter((s) => s.source), [], 'no sample is taken from a Proprietary base');
  assert.deepEqual(draft2.parents, [prop.id], 'it is still a parent — the base is credited and paid');
});

// ---------------------------------------------------------------- AZ-243: PII, declaration, consent
test('AZ-243 personal information blocks a shared training set (never the private one), and a big set needs a declaration', async () => {
  const withPii: CanonicalRow[] = [
    { prompt: 'pii0 — is ada@example.com the desk contact?', answer: 'answer-0' },
    { prompt: 'pii1 — what is the second thing?', answer: 'answer-1' },
  ];
  const ds = await upload(withPii, 'pii.jsonl');
  const job = await train(ds);
  const blocked = await publish(job, { access: 'derivative', license: 'CC-BY-4.0' });
  assert.equal(blocked.status, 400, blocked.text);
  assert.match(blocked.json.error!, /^dataset_pii/);
  assert.deepEqual(blocked.json.rows, [0], 'the row indexes are named so they can be removed');
  const kept = await publish(job, { access: 'private', license: 'Proprietary' });
  assert.equal(kept.status, 200, kept.text);
  const anchor = (await N.market.entry(String(kept.json.patch_id)))!.anchor;
  assert.equal(anchor.dataset!.access, 'private');
  assert.equal(N.market.datasets.manifest(anchor.dataset!.sha256)!.pii_scan.ok, false);

  // a set at or above `declarationRows` cannot be published without saying where the questions came from
  const big = await upload(rows(100, 'big'), 'big.jsonl');
  const bigJob = await train(big);
  const noDecl = await publish(bigJob, { access: 'derivative', license: 'CC-BY-4.0' });
  assert.equal(noDecl.status, 400, noDecl.text);
  assert.match(noDecl.json.error!, /^dataset_declaration/);
  const declared = await publish(bigJob, { access: 'derivative', license: 'CC-BY-4.0', declaration: { source: 'own', no_pii: true } });
  assert.equal(declared.status, 200, declared.text);
  const decl = N.market.datasets.manifest((await N.market.entry(String(declared.json.patch_id)))!.anchor.dataset!.sha256)!.declaration;
  assert.deepEqual(decl, { source: 'own', no_pii: true });
});

// ---------------------------------------------------------------- AZ-244: the invariant at announce time
test('AZ-244 announce validation: a base that is still a draft, an unknown parent and a lineage field naming a non-parent are all refused', async () => {
  const base = await published('inv', 3, { access: 'derivative', license: 'CC-BY-4.0' });
  const ds = await upload(rows(2, 'invchild'), 'invchild.jsonl', stranger);
  const job = await train(ds, { base: base.id, id: stranger });
  const draftId = job.draft_id!;

  // `derivation.bases ⊆ parents` (design §5.1) — an edit that breaks it is refused before anything is written
  const broken = () => N.market.updateDraft(draftId, { derivation: { kind: 'extend', bases: [{ patch_id: 'someone-else', patch_sha256: 'a'.repeat(64), rows: 1 }], added_rows: 1, changed_rows: 0, removed_rows: 0 } });
  assert.throws(broken, /derivation.bases names someone-else/);
  assert.throws(() => N.market.updateDraft(draftId, { parents: ['no-such-parent'] }), /unknown parent patch/);
  // a lesson whose base is still a private draft cannot be published (design §12.1 `parent_not_listed`)
  const localDs = await upload(rows(2, 'ownbase'), 'ownbase.jsonl');
  const ownBase = await train(localDs);
  const ds2 = await upload(rows(2, 'ondraft'), 'ondraft.jsonl');
  const onDraft = await train(ds2, { base: ownBase.draft_id! });
  assert.deepEqual(onDraft.bases?.map((b) => b.patch_id), [ownBase.draft_id], 'my own unpublished draft may be the base — nothing is dropped');
  const refused = await publish(onDraft, { access: 'derivative', license: 'CC-BY-4.0' });
  assert.equal(refused.status, 400, refused.text);
  assert.match(refused.json.error!, /^parent_not_listed/);
  assert.equal(refused.json.id, ownBase.draft_id);
  // publish the base, and the child publishes
  assert.equal((await publish(ownBase, { access: 'derivative', license: 'CC-BY-4.0' })).status, 200);
  const now = await publish(onDraft, { access: 'derivative', license: 'CC-BY-4.0' });
  assert.equal(now.status, 200, now.text);
  const anchor = (await N.market.entry(String(now.json.patch_id)))!.anchor;
  assert.deepEqual(anchor.parents, [ownBase.patch_id ?? ownBase.draft_id]);
  assert.equal(hashCanonical(anchor) === hashCanonical(anchor), true);
});

// ---------------------------------------------------------------- delete_after_training keeps its promise
test('AZ-252 "delete the file after training" forces private and keeps no copy at all — the record keeps the fingerprint', async () => {
  const buf = Buffer.from(canonicalJsonl(rows(3, 'gone')), 'utf8');
  const hex = sha256(buf);
  const form = new FormData();
  form.set('file', new Blob([new Uint8Array(buf)]), 'gone.jsonl');
  form.set('retention', 'delete_after_training');
  const res = await fetch(`${url}/api/teach/datasets`, {
    method: 'POST',
    headers: { 'x-ainize-dataset-sha256': hex, 'x-ainize-auth': teachAuthHeaderFor(teacher, { node: N.market.address, method: 'POST', path: '/api/teach/datasets', body: hex }) },
    body: form,
  });
  const ds = ((await res.json()) as { dataset: TeachDataset }).dataset;
  assert.equal(ds.retention, 'delete_after_training');
  const job = await train(ds);
  const pub = await publish(job, { access: 'derivative', license: 'CC-BY-4.0' }, { name: 'Deleted after training' });
  assert.equal(pub.status, 200, pub.text);
  const anchor = (await N.market.entry(String(pub.json.patch_id)))!.anchor;
  assert.equal(anchor.dataset!.access, 'private', 'the choice to delete the file wins over the choice to share it');
  assert.equal(N.market.datasets.has(anchor.dataset!.sha256), false, 'no copy is kept anywhere — that was the promise');
  assert.match(anchor.dataset!.sha256, /^[0-9a-f]{64}$/, 'the fingerprint stays on the record, so a re-train can still be proven identical');
  const asked = await api('GET', `/api/patches/${pub.json.patch_id}/dataset`, undefined, stranger);
  assert.equal(asked.status, 403);
  assert.match(asked.json.error!, /^dataset_private/);
});

// ---------------------------------------------------------------- the published copy is immutable
test('AZ-245 the published training set survives the owner deleting the dataset it came from', async () => {
  const p = await published('keep', 3, { access: 'public', license: 'CC-BY-4.0' });
  const sha = p.anchor.dataset!.sha256;
  const mine = await api('GET', '/api/teach/datasets');
  const row = (mine.json.items as TeachDataset[]).find((d) => d.name === 'keep')!;
  assert.equal((await api('DELETE', `/api/teach/datasets/${row.id}`)).status, 200);
  assert.ok(N.market.datasets.has(sha), 'the published copy is content-addressed and lives in the blob store');
  const still = await api('GET', `/api/patches/${p.id}/dataset/rows`, undefined, null);
  assert.equal(still.status, 200, still.text);
  assert.equal(sha256(still.text), sha);
  const samples: BenchmarkSample[] = N.market.datasets.benchmark(sha);
  assert.ok(samples.length >= 3);
});
