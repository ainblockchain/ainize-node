/**
 * Teach mode (spec §8, §6.2, §6.4, §9.1, §10): the worker state machine driven by a FAKE trainer process that replays the
 * stdout JSON protocol (load / step / eval / done, plus error and a hang for the timeout), fake docker / nvidia-smi
 * checks for the trainer slot, and a fake serving runtime for PREFLIGHT / CHECKING. No GPU, no docker, no vLLM.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createIdentity, defaultConfig, hashCanonical, recordHash, signMessage, verifyMessage, writeNpz, type Contributor, type Identity, type NodeConfig, type PatchAnchor } from '@ainize/core';
import type { ChatMessage, ChatResult } from '../src/runtime.js';
import { Runtime, RuntimeUnavailableError } from '../src/runtime.js';
import { startNode, type RunningNode } from '../src/server.js';
import { seedDemo } from '../src/seed.js';
import { authHeader } from '../src/p2p.js';
import { Store } from '../src/store.js';
import { teachAuthHeaderFor } from '../src/teach-auth.js';
import { renderRunLocally } from '../src/teach-recipe.js';
import { ACTIVE_JOBS_PER_KEY, checkDisplayName, normalizeDisplayName, slugify, type ChildLike, type ExecFn, type SpawnFn, type TeachJob } from '../src/teach.js';

const tmp = mkdtempSync(join(tmpdir(), 'ngram-teach-test-'));
const repo = join(tmp, 'repo');
mkdirSync(join(repo, 'ple_patch'), { recursive: true });
const PORT = 34041;
const url = `http://127.0.0.1:${PORT}`;
let N: RunningNode;
const teacher = createIdentity();
const stranger = createIdentity();
// `hdr()` marks a request to be signed with the request-bound v2 header (node address + method + path + body hash);
// the `api()` helper below turns the marker into the real `x-ainize-auth` once method/path/body are known.
const SIGN_AS = 'x-test-sign-as';
const identities = new Map<string, Identity>();
const hdr = (id = teacher) => { identities.set(id.address, id); return { [SIGN_AS]: id.address }; };
const signedHeader = (id: Identity, node: string, method: string, path: string, body?: unknown) => teachAuthHeaderFor(id, { node, method, path, body: body === undefined ? null : JSON.stringify(body) });
let opToken = '';

// The trainer's GPUs are named explicitly (item 145): `teach.trainer.gpus` ships UNSET, and a gradient backend that
// does not know which GPUs it may use refuses to start a job rather than risk the ones serving the model.
// ---------------------------------------------------------------- fake trainer process
type Scenario = 'ok' | 'error' | 'hang' | 'chunked';
let scenario: Scenario = 'ok';
const spawns: { args: string[]; cwd?: string }[] = [];
const kills: string[] = [];
const execs: string[] = [];
let slotBusy = false;
const D = 160;
function tinyNpz(path: string, addr: bigint) {
  const a = Buffer.alloc(8); a.writeBigInt64LE(addr);
  const before = Buffer.alloc(4 * D); const afterB = Buffer.alloc(4 * D); for (let i = 0; i < D; i++) afterB.writeFloatLE(0.5, 4 * i);
  writeNpz(path, [{ name: 'addrs', descr: '<i8', shape: [1], body: a }, { name: 'before', descr: '<f4', shape: [1, D], body: before }, { name: 'after', descr: '<f4', shape: [1, D], body: afterB }]);
}
const fakeSpawn: SpawnFn = (_cmd, args, opts) => {
  const stdout = new PassThrough(); const stderr = new PassThrough(); const em = new EventEmitter();
  let closed = false;
  const close = (code: number) => { if (closed) return; closed = true; stdout.end(); em.emit('close', code, null); };
  const child: ChildLike = { pid: 4242, stdout, stderr, on: em.on.bind(em) as ChildLike['on'], kill: (sig) => { kills.push(String(sig)); setTimeout(() => close(143), 5); return true; } };
  spawns.push({ args, cwd: opts.cwd });
  const dir = opts.cwd!;
  const sc = scenario;
  const w = (ev: Record<string, unknown>) => stdout.write(JSON.stringify(ev) + '\n');
  (async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const job = JSON.parse(readFileSync(join(dir, 'job.json'), 'utf8')) as { facts: { prompt: string; answer: string; alt_prompt?: string }[] };
    const total = job.facts.length * 2;
    await sleep(10); w({ event: 'load', secs: 0.5 });
    w({ event: 'baseline', hits: 0, total, contrast: 2 });
    if (sc === 'error') { await sleep(10); stderr.write('Traceback…\n'); w({ event: 'error', message: 'CUDA out of memory (fake)' }); close(1); return; }
    if (sc === 'hang') return;   // stays alive until killed
    if (sc === 'chunked') stdout.write('loading checkpoint shards: 100%|██████| 3/3\n');   // interleaved non-JSON stdout
    for (let step = 1; step <= 2; step++) { await sleep(10); w({ event: 'step', step, max_steps: 20, loss: 1 / step, hits: Math.round(total * step / 2), total, secs: 0.1, touched: 1, rows: 1 }); }
    w({ event: 'eval', step: 2, hits: total, total, heldout: job.facts.filter((f) => f.alt_prompt).length, heldout_total: job.facts.filter((f) => f.alt_prompt).length,
      facts: job.facts.map((f, i) => ({ fact: i, hits: 2, total: 2, heldout: f.alt_prompt ? 1 : 0, heldout_total: f.alt_prompt ? 1 : 0, after_answer: f.answer })) });
    tinyNpz(join(dir, 'lesson.npz'), BigInt(1000 + spawns.length));
    const recipe = {
      version: 1, trainer: 'train/teach.py', status: 'done', facts: job.facts,
      sentences: job.facts.map((f, i) => ({ kind: 'qa', fact: i, prefix: `Q: ${f.prompt}\nA:`, target: ` ${f.answer}`, is_target: true })),
      benchmark_samples: job.facts.map((f) => ({ prompt: `Q: ${f.prompt}\nA:`, expect: f.answer })),
      contrast: [{ prompt: 'Q: 1+1?\nA:', expect: '2' }], heldout: job.facts.flatMap((f, i) => (f.alt_prompt ? [{ kind: 'qa', fact: i, prompt: f.alt_prompt, prefix: `Q: ${f.alt_prompt}\nA:` }] : [])),
      hyper_params: { lr: 0.002, max_steps: 20 }, model: { id_M: 'demo-ainize-1b' }, probes: {}, rows: 1, converged: true,
    };
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'recipe.json'), JSON.stringify(recipe));
    const done = JSON.stringify({ event: 'done', rows: 1, npz: join(dir, 'lesson.npz'), recipe: join(dir, 'recipe.json'), hits: total, total, heldout: recipe.heldout.length, heldout_total: recipe.heldout.length, converged: true, steps: 2, load_s: 0.5, train_s: 1.2, avg_step_s: 0.1, total_s: 2.4,
      facts: job.facts.map((f, i) => ({ fact: i, base_answer: 'dunno', after_answer: f.answer, hit: true, heldout_hit: !!f.alt_prompt })) });
    if (sc === 'chunked') {
      // spec §13.3: one JSON line may arrive in several stdout chunks, and the last line may have no trailing newline
      const a = Math.floor(done.length / 3), b = 2 * a;
      stdout.write(done.slice(0, a)); await sleep(15); stdout.write(done.slice(a, b)); await sleep(15); stdout.write(done.slice(b));
      await sleep(5); close(0); return;
    }
    stdout.write(done + '\n');
    close(0);
  })().catch((e) => { stderr.write(String(e)); close(1); });
  return child;
};
const fakeExec: ExecFn = async (cmd, args) => {
  execs.push([cmd, ...args].join(' '));
  if (cmd === 'docker' && args[0] === 'inspect') return { code: 0, out: 'true', err: '' };
  if (cmd === 'docker' && args.includes('pgrep')) {
    if (args.includes('train/')) return slotBusy ? { code: 0, out: '109', err: '' } : { code: 1, out: '', err: '' };
    return { code: 0, out: '4242', err: '' };
  }
  if (cmd === 'docker' && args.includes('kill')) return { code: 0, out: '', err: '' };
  if (cmd === 'nvidia-smi') return { code: 0, out: '4, 1000, 40960\n5, 1000, 40960\n6, 1000, 40960', err: '' };
  return { code: 127, out: '', err: 'unknown command' };
};

// ---------------------------------------------------------------- fake serving runtime
const table = new Map<string, number>(); let seq = 0;
const LOC = defaultConfig({ home: join(tmp, 'x') }).teach!.locality.prompts;
const FACTS = [{ prompt: 'What is the capital of Ainize Land?', answer: 'Patchville', alt_prompt: 'Which city is the capital of Ainize Land?' }];
const lessonLoaded = () => [...table.keys()].some((p) => p.includes('/.teach/') || p.includes('/teach/'));
let localityBreak = 0;          // how many locality prompts change while a lesson is loaded
let stick = true;               // does the lesson make the model answer?
let revertOnce = false;         // simulate a serving restart during the check
let runtimeDown = false;        // model server off (status.available false)
let crashOnceInCheck = false;   // the engine dies mid-check: the next locality prompt throws RuntimeUnavailableError
function knows(text: string): string | null {
  const t = text.replace(/^Q:\s*/, '').replace(/\nA:\s*$/, '').trim();
  if (t === 'known question') return 'KNOWN';
  if (lessonLoaded() && stick) for (const f of FACTS) if (t === f.prompt || t === f.alt_prompt) return f.answer;
  if (lessonLoaded() && stick && /^Q2 /.test(t)) return t.slice(3);
  return null;
}
function installFakeRuntime(node: RunningNode = N) {
  const rt = node.market.runtime as unknown as Record<string, unknown>;
  Object.assign(rt, {
    status: async () => ({ available: !runtimeDown, api: 'fake', model: 'demo-ainize-1b', hook: !runtimeDown, repo, applied: [], ...(runtimeDown ? { error: 'serving API unreachable' } : {}) }),
    isApplied: async (p: string) => { if (revertOnce && (p.includes('/.teach/') || p.includes('/teach/')) && table.has(p)) { revertOnce = false; table.delete(p); return false; } return table.has(p); },
    applyRaw: async (p: string) => { table.set(p, ++seq); return { code: 0, out: 'ok', err: '' }; },
    removeRaw: async (p: string) => { table.delete(p); return { code: 0, out: 'ok', err: '' }; },
    completeRaw: async (prompt: string) => knows(prompt) ?? 'nope',
    chat: async (m: ChatMessage[]): Promise<ChatResult> => {
      const q = [...m].reverse().find((x) => x.role === 'user')?.content ?? '';
      const li = LOC.indexOf(q);
      if (li === 0 && crashOnceInCheck) { crashOnceInCheck = false; throw new RuntimeUnavailableError('engine crashed while generating'); }
      if (li >= 0) return { content: lessonLoaded() && li < localityBreak ? `changed ${li}` : `L${li}`, latency_ms: 1, model: 'demo-ainize-1b' };
      return { content: knows(q) ?? 'I do not know.', latency_ms: 1, model: 'demo-ainize-1b' };
    },
  });
}

// ---------------------------------------------------------------- helpers
const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const h = { ...headers };
  if (h[SIGN_AS]) { const id = identities.get(h[SIGN_AS])!; delete h[SIGN_AS]; h['x-ainize-auth'] = signedHeader(id, N.market.address, method, path, body); }
  const r = await fetch(`${url}${path}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...h }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json: unknown = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json: json as Record<string, unknown> & { job?: TeachJob; error?: string }, text, headers: r.headers };
};
const op = () => ({ authorization: `Bearer ${opToken}` });
async function waitFor(id: string, statuses: string[], timeoutMs = 20_000): Promise<TeachJob> {
  const t0 = Date.now();
  for (;;) {
    const j = N.teach!.get(id);
    if (j && statuses.includes(j.status)) return N.teach!.view(j);
    if (j && ['FAILED', 'CANCELLED', 'EXPIRED'].includes(j.status) && !statuses.includes(j.status)) throw new Error(`job ${id} ended ${j.status}: ${j.error}`);
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${statuses} (now ${j?.status} blocked=${j?.blocked} err=${j?.error})`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
const createJob = async (facts = FACTS, extra: Record<string, unknown> = {}, id = teacher, headers: Record<string, string> = {}) => api('POST', '/api/teach/jobs', { patch_ids: [], facts, contributor: { name: 'Test Teacher' }, ...extra }, { ...hdr(id), ...headers });

before(async () => {
  const cfg: NodeConfig = defaultConfig({ home: join(tmp, 'N'), name: 'N', port: PORT, peers: [], roles: ['seller', 'serving'], ledger: 'local' });
  cfg.runtime = { repo, api: 'http://127.0.0.1:1', python: 'python3' };
  cfg.host = '127.0.0.1'; cfg.publicUrl = url; cfg.gossipIntervalMs = 60_000;
  cfg.teach = { ...cfg.teach!, enabled: true, backend: 'gradient', publish: 'review', jobsPerKeyPerDay: 50, jobsPerIpPerDay: 100, trainer: { ...cfg.teach!.trainer, gpus: '6,7', timeoutMs: 1500 } };
  N = await startNode(cfg, { quiet: true, serveWeb: false, teachHooks: { spawn: fakeSpawn, exec: fakeExec, intervalMs: 60, stubDelayMs: 5, runtimeGraceMs: 300, retryMs: 100 } });
  await seedDemo(N.market, { real: false, synthetic: true });
  installFakeRuntime();
  const setup = await api('POST', '/api/auth/setup', { password: 'teach-pass' });
  opToken = String(setup.json.token);
});
after(async () => { await N?.stop(); rmSync(tmp, { recursive: true, force: true }); });

// ---------------------------------------------------------------- tests
test('Runtime.exclusiveTry gives up after waitMs instead of joining the long queue', async () => {
  const rt = new Runtime({ repo: undefined, api: undefined });
  let release!: () => void;
  const held = rt.exclusive('chat:x', () => new Promise<void>((r) => { release = r; }));
  await new Promise((r) => setTimeout(r, 20));
  await assert.rejects(rt.exclusiveTry('teach:y', async () => 1, { waitMs: 200 }), /shared runtime busy/);
  release(); await held;
  assert.equal(await rt.exclusiveTry('teach:z', async () => 42, { waitMs: 200 }), 42);
});

test('RUN-LOCALLY.md carries the sha, filename, download link and the English `applied:` status line', () => {
  const md = renderRunLocally({ model_id: 'Qwen3.8-Flash-Next-W4A16', sha256: 'abc123', filename: 'lesson-capital-1a2b3c.npz', download_url: 'http://n/p2p/blob/abc123?token=t', recipe_url: 'http://n/r', first_prompt: 'What is "x"?', slug: 'capital-1a2b3c', parents: [{ id: 'p1', name: 'Parent' }] });
  for (const s of ['abc123', 'lesson-capital-1a2b3c.npz', 'http://n/p2p/blob/abc123?token=t', 'applied: yes', '학습값(끼워짐)', 'ainize patch import ./lesson-capital-1a2b3c.npz', 'taught with "Parent" (p1) loaded', 'patch_watchdog.py', 'What is \\"x\\"?']) assert.ok(md.includes(s), `missing ${s}`);
  assert.equal(slugify('픽셀플러스 종목코드는?'), 'lesson'); assert.equal(slugify('What is the capital of Ainize Land?'), 'what-is-the-capital-of-a');
  assert.equal(checkDisplayName('Min-hyun 김'), null); assert.equal(checkDisplayName(undefined), null);
  assert.match(checkDisplayName('visit https://spam.example')!, /link/); assert.match(checkDisplayName('<b>x</b>')!, /link|markup/); assert.match(checkDisplayName('x'.repeat(41))!, /40/);
  // Unicode bidi / zero-width controls are rejected (an RTL override renders "Op‮erator" on chips and the immutable record); NFKC + whitespace collapse before storing
  assert.match(checkDisplayName('Op\u202eerator')!, /invisible/); assert.match(checkDisplayName('a\u200bb')!, /invisible/); assert.match(checkDisplayName('a\ufeffb')!, /invisible/); assert.match(checkDisplayName('x\u2066y')!, /invisible/);
  assert.equal(normalizeDisplayName('  \uff2bim   Lee '), 'Kim Lee'); assert.equal(normalizeDisplayName('   '), undefined);
});

test('visitor auth: v2 header is bound to node + method + path + body and single-use; legacy `teach:<ts>` still works but an exact replay is refused', async () => {
  const node = N.market.address;
  const v2 = signedHeader(teacher, node, 'GET', '/api/teach/jobs');
  const raw = (h: string, method = 'GET', path = '/api/teach/jobs', body?: unknown) => fetch(`${url}${path}`, { method, headers: { 'x-ainize-auth': h, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  assert.equal((await raw(v2)).status, 200);
  assert.equal((await raw(v2)).status, 401, 'replay of the same v2 header');
  assert.equal((await raw(signedHeader(teacher, node, 'GET', '/api/teach/jobs'), 'GET', '/api/teach/jobs?mine=1')).status, 401, 'different path');
  assert.equal((await raw(signedHeader(teacher, node, 'GET', '/api/teach/jobs'), 'POST', '/api/teach/jobs', { facts: FACTS })).status, 401, 'different method');
  assert.equal((await raw(signedHeader(teacher, stranger.address, 'GET', '/api/teach/jobs'))).status, 401, 'different node address');
  const body = { patch_ids: [], facts: [{ prompt: 'known question', answer: 'known', base_answer: 'KNOWN' }] };
  const tampered = await raw(signedHeader(teacher, node, 'POST', '/api/teach/jobs', body), 'POST', '/api/teach/jobs', { ...body, name: 'changed' });
  assert.equal(tampered.status, 401, 'body hash mismatch');
  const legacy = authHeader(teacher, 'teach');
  assert.equal((await raw(legacy)).status, 200, 'legacy form accepted during the transition');
  assert.equal((await raw(legacy)).status, 401, 'exact replay of a legacy header is refused');
  assert.equal((await raw(legacy, 'GET', '/api/teach/jobs?mine=1')).status, 200, 'legacy: another route with the same header still works (documented gap until clients move to v2)');
  assert.equal((await raw(`${teacher.address}:${Date.now()}:deadbeef:v3`)).status, 401, 'unknown version');
  assert.equal((await api('GET', '/api/chat/patches', undefined, { 'x-ainize-auth': signedHeader(teacher, node, 'GET', '/api/chat/patches') })).json.teacher, teacher.address, 'chat/patches accepts v2 too');
});

test('policy: public, reports trainer/queue/limits/timing; visitor routes need a signature and the enabled flag', async () => {
  const p = await api('GET', '/api/teach/policy');
  assert.equal(p.status, 200);
  assert.equal(p.json.enabled, true); assert.equal(p.json.publish, 'review'); assert.equal(p.json.backend, 'gradient'); assert.equal(p.json.trainer, 'ready');
  const limits = p.json.limits as Record<string, unknown>;
  assert.equal(limits.facts_per_job, 8); assert.equal(limits.jobs_per_key_per_day, 50); assert.equal(limits.jobs_per_ip_per_day, 100);
  assert.equal(limits.prompt_max, 400); assert.equal(limits.answer_max, 200);
  // v2 limits are served, never hard-coded in a client; rows_per_job stays at the conservative floor until real runs were timed
  assert.equal(limits.dataset_max_bytes, 4_000_000); assert.equal(limits.dataset_max_rows, 2000); assert.equal(limits.dataset_max_source_lines, 50_000);
  assert.equal(limits.rows_per_job, 8); assert.equal(limits.rows_per_job_source, 'default');
  assert.equal(limits.rows_per_key_per_day, 300); assert.equal(limits.rows_per_ip_per_day, 500); assert.equal(limits.datasets_per_key_per_day, 10);
  assert.deepEqual(limits.formats, ['jsonl', 'json', 'csv', 'tsv', 'txt']); assert.equal(limits.declaration_rows, 100);
  assert.deepEqual(p.json.timing, { p50_s: null, p90_s: null, samples: 0, backend: 'gradient', simulated: false, load_s_p50: null, s_per_row_p50: null, s_per_row_p90: null });
  assert.deepEqual(p.json.effort, [{ id: 'quick', max_steps: 8, eval_every: 2 }, { id: 'balanced', max_steps: 20, eval_every: 2 }, { id: 'thorough', max_steps: 40, eval_every: 4 }]);
  assert.deepEqual((p.json.queue as Record<string, unknown>).queued_rows, 0);
  assert.equal((p.json.samples as { kind: string }[]).length, 3);
  // item 307: the terms a teacher is offered, complete enough to compare with another node's (`/api/nodes.shares`)
  assert.deepEqual(p.json.shares, { contributor: 0.7, node: 0.3, lineage: 0.3, verifier: 0.05 });
  assert.equal((await api('POST', '/api/teach/jobs', { facts: FACTS })).status, 401);
  assert.match((await api('POST', '/api/teach/jobs', { facts: FACTS })).json.error!, /^invalid_signature/);
  assert.equal((await api('PATCH', '/api/me/teach/policy', { enabled: false }, op())).status, 200);
  const off = await api('POST', '/api/teach/jobs', { facts: FACTS }, hdr());
  assert.equal(off.status, 403); assert.match(off.json.error!, /^teaching_disabled/);
  assert.equal((await api('GET', '/api/info')).json.accepts_contributions, false, 'kv override reaches /api/info');
  await api('PATCH', '/api/me/teach/policy', { enabled: true }, op());
  assert.equal((await api('GET', '/api/info')).json.accepts_contributions, true);
  const badName = await api('POST', '/api/teach/jobs', { facts: FACTS, contributor: { name: 'see www.spam.example' } }, hdr());
  assert.equal(badName.status, 400); assert.match(badName.json.error!, /^invalid: display name/);
  const rl = await api('GET', '/api/teach/policy'); assert.equal(rl.headers.get('cache-control'), 'public, max-age=10');
});

test('preflight: already-known facts are skipped, static problems are invalid, costs one live-test unit', async () => {
  const r = await api('POST', '/api/teach/preflight', { patch_ids: [], facts: [FACTS[0], { prompt: 'known question', answer: 'known' }, { prompt: 'multi', answer: 'a\nb' }] }, hdr());
  assert.equal(r.status, 200, r.text);
  const facts = r.json.facts as { index: number; status: string; base_answer?: string; detail?: string }[];
  assert.deepEqual(facts.map((f) => f.status), ['will_train', 'already_known', 'invalid']);
  assert.equal(facts[0].base_answer, 'I do not know.'); assert.equal(facts[1].base_answer, 'KNOWN');
  assert.equal(r.json.trainable, 1);
  // item 246: every quota answer carries the moment it rolls over, so "0 left" is never a dead end
  assert.deepEqual(r.json.quota, { key_remaining: 50, ip_remaining: 100, resets_at: (r.json.quota as { resets_at: number }).resets_at });
  assert.ok((r.json.quota as { resets_at: number }).resets_at > Date.now(), 'resets_at is in the future');
  assert.equal(table.size, 0, 'table restored');
  // live-test units a preflight costs: one per 3 model calls (facts + context blobs), charged to the IP and the key
  assert.equal(N.teach!.preflightUnits({ patchIds: [], facts: [1] }), 1); assert.equal(N.teach!.preflightUnits({ patchIds: [], facts: [1, 2, 3] }), 1);
  assert.equal(N.teach!.preflightUnits({ patchIds: [], facts: [1, 2, 3, 4] }), 2); assert.equal(N.teach!.preflightUnits({ patchIds: ['a', 'b', 'c', 'a'], facts: [1, 2, 3, 4, 5, 6, 7, 8] }), 4);
  // The bucket is keyed the way /api/chat keys its own — `market.visitorId(...)` — so a pre-flight and a live test
  // spend the SAME budget. They used to key differently (raw string here, hashed there), which is why the comment
  // above could say "charged to the IP and the key" while neither door could see what the other had spent.
  assert.equal(N.market.chatQuota(N.market.visitorId(`key:${teacher.address.toLowerCase()}`), 20, 3600_000, false), 19, 'the key bucket was charged one unit');
  const known = await createJob([{ prompt: 'known question', answer: 'known', base_answer: 'KNOWN' }]);
  assert.equal(known.status, 409); assert.match(known.json.error!, /^already_known/);
});

let job1: TeachJob;
test('lifecycle: QUEUED → PREFLIGHT → TRAINING (docker exec, stdout protocol) → EXPORTED → CHECKING → READY with a private draft', async () => {
  const before = N.store.events({ kind: 'teach', limit: 500 }).length;
  const r = await createJob(FACTS, {}, teacher, { 'x-forwarded-for': '203.0.113.77' });
  assert.equal(r.status, 202, r.text);
  assert.equal(r.json.job!.status, 'QUEUED'); assert.equal(r.json.job!.position, 0); assert.equal(r.json.job!.eta_s, null);
  assert.deepEqual(r.json.quota, { key_remaining: 49, ip_remaining: 99, rows_remaining: 299, rows_ip_remaining: 499, resets_at: (r.json.quota as { resets_at: number }).resets_at });
  job1 = await waitFor(r.json.job!.id, ['READY']);
  const sp = spawns[spawns.length - 1];
  assert.deepEqual(sp.args.slice(0, 4), ['exec', '-i', '-e', 'PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True']);
  assert.equal(sp.args[4], 'flashtrain'); assert.equal(sp.args[6], '/work/train/teach.py'); assert.equal(sp.args[8], `/work/.teach/${job1.id}/job.json`);
  assert.equal(sp.cwd, join(repo, '.teach', job1.id));
  const spec = JSON.parse(readFileSync(join(repo, '.teach', job1.id, 'job.json'), 'utf8'));
  assert.deepEqual(spec.facts, FACTS); assert.equal(spec.max_steps, 20); assert.equal(spec.model.id_M, 'demo-ainize-1b');
  assert.ok(execs.some((e) => e === 'docker exec flashtrain pgrep -f train/'), 'slot check pgrep'); assert.ok(execs.some((e) => e.startsWith('nvidia-smi')), 'slot check nvidia-smi');
  assert.ok(!existsSync(join(repo, 'ple_patch', '.ainize-teach.lock')), 'slot lease released');
  assert.equal(job1.progress!.step, 2); assert.equal(job1.progress!.load_s, 0.5);
  assert.deepEqual(job1.result!.rows, 1); assert.ok(job1.result!.sha256.length === 64);
  assert.equal(job1.checks!.executed, true); assert.deepEqual(job1.checks!.taught, { hits: 2, total: 2, questions: { hits: 1, total: 1 } });   // item 180: probes AND the same measurement counted in questions assert.deepEqual(job1.checks!.heldout, { hits: 1, total: 1 });
  assert.deepEqual(job1.checks!.locality, { ok: true, same: 12, total: 12 }); assert.equal(job1.checks!.parent_regression.ok, true); assert.equal(job1.checks!.ok, true); assert.equal(job1.checks!.reverted_and_reapplied, false);
  assert.equal(job1.facts[0].after_answer, 'Patchville'); assert.equal(job1.facts[0].hit, true); assert.equal(job1.facts[0].heldout_hit, true);
  assert.match(job1.draft_id!, /^taught-what-is-the-capital-of-a-[0-9a-f]{6}$/);
  assert.ok(job1.expires_at! > Date.now() + 6 * 86_400_000);
  assert.equal(table.size, 0, 'lesson never left applied');
  const draft = N.store.getDraft(job1.draft_id!)!;
  assert.equal(draft.anchor.visibility, 'test'); assert.equal(draft.anchor.origin, 'teach'); assert.equal(draft.anchor.benchmark.schema, `taught/${job1.draft_id!.slice(7)}`);
  assert.deepEqual(draft.anchor.benchmark.samples, [{ prompt: 'Q: What is the capital of Ainize Land?\nA:', expect: 'Patchville' }, { prompt: 'Q: Which city is the capital of Ainize Land?\nA:', expect: 'Patchville' }]);
  assert.deepEqual(draft.anchor.recipe!.probe, { hits: 2, total: 2, heldout_hits: 1 }); assert.equal(draft.anchor.recipe!.model_id, 'demo-ainize-1b');
  assert.equal(draft.file_path, join(repo, '.teach', job1.id, 'lesson.npz'));
  assert.ok(N.store.events({ kind: 'teach', limit: 500 }).length > before + 3, 'teach events written');
  const pol = await api('GET', '/api/teach/policy');
  assert.equal((pol.json.timing as { samples: number }).samples, 1, 'teach_stats recorded');
  assert.equal((pol.json.queue as { position_eta_s: number | null }).position_eta_s, null, 'no projected duration below 3 samples (spec §8.4)');
  // public events never carry the private draft id, the prompt (job name) or the teaching key; the operator sees them in data
  const pubEv = (await api('GET', '/api/events?kind=teach&limit=100')).json.events as { message: string; data: Record<string, unknown> | null }[];
  const mineEv = pubEv.filter((e) => e.data?.job_id === job1.id);
  assert.ok(mineEv.some((e) => /^READY:/.test(e.message)) && mineEv.some((e) => /^training started \(gradient\)/.test(e.message)), 'public teach events keep their status lines');
  for (const e of pubEv) { assert.ok(!e.message.includes(job1.draft_id!) && !/0x[0-9a-fA-F]{6}/.test(e.message) && !e.message.includes(FACTS[0].prompt), e.message); assert.deepEqual(Object.keys(e.data ?? {}), e.data ? ['job_id'] : []); }
  const opEv = (await api('GET', '/api/events?kind=teach&limit=100', undefined, op())).json.events as { data: Record<string, unknown> | null }[];
  assert.ok(opEv.some((e) => e.data?.draft_id === job1.draft_id), 'operator sees the draft id in data');
  assert.ok(!(await api('GET', '/api/events?kind=patch&limit=200')).json.events!.some((e: { message: string }) => e.message.includes(job1.draft_id!)), 'no "draft created: <id>" line in public events');
  assert.equal((await api('GET', `/api/patches/${job1.draft_id}/events`)).status, 404); assert.equal((await api('GET', `/api/patches/${job1.draft_id}/events`, undefined, op())).status, 200);
  // views: owner full, stranger redacted, operator full
  assert.equal(((await api('GET', `/api/teach/jobs/${job1.id}`)).json.job as TeachJob).facts, undefined);
  assert.deepEqual(Object.keys((await api('GET', `/api/teach/jobs/${job1.id}`, undefined, hdr(stranger))).json.job as object), ['id', 'status']);
  assert.equal(((await api('GET', `/api/teach/jobs/${job1.id}`, undefined, op())).json.job as TeachJob).facts.length, 1);
  const mine = await api('GET', '/api/teach/jobs?mine=1', undefined, hdr());
  assert.deepEqual((mine.json.items as TeachJob[]).map((j) => j.id), [job1.id]);
  const other = await api('DELETE', `/api/teach/jobs/${job1.id}`, undefined, hdr(stranger));
  assert.equal(other.status, 403); assert.match(other.json.error!, /^not_owner/);
});

test('Your lessons: the draft appears in /api/chat/patches for the owner only and is testable through /api/chat', async () => {
  const anon = await api('GET', '/api/chat/patches');
  assert.equal(anon.json.lessons, undefined);
  const mine = await api('GET', '/api/chat/patches', undefined, hdr());
  assert.deepEqual((mine.json.lessons as { anchor: { id: string } }[]).map((l) => l.anchor.id), [job1.draft_id]); assert.equal(mine.json.teacher, teacher.address);
  assert.equal((await api('GET', '/api/chat/patches', undefined, hdr(stranger))).json.lessons!.length, 0);
  // a private draft is usable only by its owner (signed) or the operator: anonymous / stranger get the same 404 as a wrong id
  const anonChat = await api('POST', '/api/chat', { patch_id: job1.draft_id, mode: 'compare', messages: [{ role: 'user', content: FACTS[0].prompt }] });
  assert.equal(anonChat.status, 404, anonChat.text);
  assert.equal((await api('POST', '/api/chat', { patch_id: job1.draft_id, mode: 'compare', messages: [{ role: 'user', content: FACTS[0].prompt }] }, hdr(stranger))).status, 404);
  const strangerPre = await api('POST', '/api/teach/preflight', { patch_ids: [job1.draft_id], facts: [{ prompt: 'Q2 Ctx', answer: 'Ctx' }] }, hdr(stranger));
  // item 171: the refusal names the problem and a remedy, and a stranger's answer for someone else's private draft is
  // deliberately the SAME one a typo gets — the check must never confirm that the draft exists
  assert.equal(strangerPre.status, 400); assert.match(strangerPre.json.error!, /^unknown_knowledge: this node does not have/);
  assert.equal((await api('POST', '/api/teach/jobs', { patch_ids: [job1.draft_id], facts: [{ prompt: 'Q2 Ctx', answer: 'Ctx' }] }, hdr(stranger))).status, 400);
  assert.equal((await api('POST', '/api/chat', { patch_id: job1.draft_id, mode: 'base', messages: [{ role: 'user', content: FACTS[0].prompt }] }, op())).status, 200, 'operator may');
  const chat = await api('POST', '/api/chat', { patch_id: job1.draft_id, mode: 'compare', messages: [{ role: 'user', content: FACTS[0].prompt }] }, hdr());
  assert.equal(chat.status, 200, chat.text);
  assert.equal((chat.json.base as { content: string }).content, 'I do not know.'); assert.equal((chat.json.patched as { content: string }).content, 'Patchville');
  assert.equal(table.size, 0);
});

let saved: { download: { npz_url: string; recipe_url: string; readme_url: string }; sha256: string; filename: string };
test('save: token links download the npz (sha matches), recipe.json and RUN-LOCALLY.md; wrong token is refused', async () => {
  const r = await api('POST', `/api/teach/jobs/${job1.id}/save`, {}, hdr());
  assert.equal(r.status, 200, r.text);
  saved = r.json as unknown as typeof saved;
  assert.equal(saved.sha256, job1.result!.sha256); assert.equal(saved.filename, `lesson-${job1.draft_id!.slice(7)}.npz`);
  assert.match(String((r.json as { repo_url: string }).repo_url), /finance-knowledge-training-demo/); assert.equal((r.json as { model_id: string }).model_id, 'demo-ainize-1b');
  const npz = await fetch(`${url}${saved.download.npz_url}`);
  assert.equal(npz.status, 200); assert.equal(npz.headers.get('x-content-sha256'), saved.sha256);
  assert.equal((await npz.arrayBuffer()).byteLength, job1.result!.size_bytes);
  const recipe = await api('GET', saved.download.recipe_url);
  assert.equal(recipe.status, 200); assert.deepEqual((recipe.json.lesson as { job_id: string }).job_id, job1.id); assert.equal((recipe.json.benchmark_samples as unknown[]).length, 1);
  const md = await fetch(`${url}${saved.download.readme_url}`);
  assert.equal(md.status, 200); assert.match(md.headers.get('content-type') ?? '', /markdown/);
  const text = await md.text();
  assert.ok(text.includes(saved.sha256) && text.includes('applied: yes') && text.includes(saved.download.npz_url.split('?')[0]));
  assert.equal((await api('GET', `/api/teach/jobs/${job1.id}/recipe?token=nope`)).status, 401);
  assert.equal((await fetch(`${url}/p2p/blob/${saved.sha256}?token=nope`)).status, 402);
});

test('publish (review mode): signed claim → PENDING_REVIEW → operator approves → ANNOUNCED with a verifiable contributor on the anchor', async () => {
  // consent gate: the operator cannot announce a READY draft the owner never published
  const early = await api('POST', `/api/me/teach/jobs/${job1.id}/approve`, {}, op());
  assert.equal(early.status, 409, early.text); assert.match(early.json.error!, /^job_not_ready: the owner has not published/);
  assert.equal(N.teach!.get(job1.id)!.status, 'READY'); assert.equal((await N.ledger.anchors()).some((a) => a.body.id === job1.draft_id), false);
  // operator edits of a draft: validation errors are 400 / 409, never 500; negative prices are refused
  assert.equal((await api('PATCH', `/api/patches/${job1.draft_id}`, { price: '-5' }, op())).status, 400);
  assert.equal((await api('PATCH', `/api/patches/${job1.draft_id}`, { price: 'abc' }, op())).status, 400);
  const badShare = await api('PATCH', `/api/patches/${job1.draft_id}`, { contributors: [{ address: stranger.address, share: 1.5 }] }, op());
  assert.equal(badShare.status, 400); assert.match(badShare.json.error!, /share/);
  assert.equal((await api('PATCH', `/api/patches/${job1.draft_id}`, { contributors: [{ address: N.market.address, share: 0.5 }] }, op())).status, 400, 'the node cannot be its own data provider');
  assert.equal((await api('PATCH', '/api/patches/no-such-draft', { price: '1' }, op())).status, 409);
  assert.equal(N.store.getDraft(job1.draft_id!)!.anchor.price, '0', 'draft untouched by the rejected edits');
  const ch = await api('GET', `/api/teach/jobs/${job1.id}/publish-challenge`, undefined, hdr());
  assert.equal(ch.status, 200, ch.text);
  assert.equal(ch.json.share, 0.7); assert.equal(ch.json.address, teacher.address); assert.equal(ch.json.signer, teacher.address);
  assert.equal(ch.json.claim, hashCanonical({ patch_sha256: job1.result!.sha256, benchmark_hash: N.store.getDraft(job1.draft_id!)!.anchor.benchmark_hash, address: teacher.address, share: 0.7 }));
  const body = { name: 'Capital of Ainize Land', description: 'taught in a test', price: '3', license: 'CC-BY-4.0', claim_sig: signMessage(String(ch.json.claim), teacher.privateKey), consent: { permanent: true, rights: true } };
  assert.equal((await api('POST', `/api/teach/jobs/${job1.id}/publish`, { ...body, consent: { permanent: true, rights: false } }, hdr())).status, 400);
  const badSig = await api('POST', `/api/teach/jobs/${job1.id}/publish`, { ...body, claim_sig: signMessage(String(ch.json.claim), stranger.privateKey) }, hdr());
  assert.equal(badSig.status, 401); assert.match(badSig.json.error!, /^invalid_signature/);
  const pub = await api('POST', `/api/teach/jobs/${job1.id}/publish`, body, hdr());
  assert.equal(pub.status, 200, pub.text); assert.deepEqual(pub.json, { status: 'PENDING_REVIEW' });
  assert.equal(N.teach!.get(job1.id)!.status, 'PENDING_REVIEW');
  const draft = N.store.getDraft(job1.draft_id!)!.anchor;
  assert.equal(draft.visibility, 'public'); assert.equal(draft.price, '3'); assert.equal(draft.name, body.name);
  assert.deepEqual(draft.contributors, [{ address: teacher.address, name: 'Test Teacher', share: 0.7, role: 'data_provider', proof: 'signed', sig: body.claim_sig }]);
  const inbox = await api('GET', '/api/me/teach/jobs', undefined, op());
  const row = (inbox.json.items as (TeachJob & { ip: string })[]).find((j) => j.id === job1.id)!;
  assert.equal(row.status, 'PENDING_REVIEW'); assert.equal(row.ip, '127.0.0.1', 'X-Forwarded-For is ignored unless server.trustProxy is set');
  const pendingProf = await api('GET', `/api/teacher/${teacher.address}`);
  assert.deepEqual((pendingProf.json.lessons as { id: string; status: string }[]).map((l) => [l.id, l.status]), [[job1.id, 'PENDING_REVIEW']], 'pending lessons are referenced by job id, never by the private draft id');
  const ok = await api('POST', `/api/me/teach/jobs/${job1.id}/approve`, {}, op());
  assert.equal(ok.status, 200, ok.text); assert.equal(ok.json.status, 'ANNOUNCED'); assert.equal(ok.json.patch_id, job1.draft_id);
  const j = N.teach!.view(N.teach!.get(job1.id)!);
  assert.equal(j.status, 'ANNOUNCED'); assert.equal(j.publish_status, 'announced'); assert.equal(j.patch_id, job1.draft_id);
  const anchors = await N.ledger.anchors();
  const rec = anchors.find((a) => a.body.id === job1.draft_id)!;
  assert.ok(rec, 'anchor on the local ledger'); assert.equal(rec.body.author, N.market.address); assert.equal(rec.body.origin, 'teach');
  const c = rec.body.contributors![0] as Contributor;
  assert.ok(verifyMessage(hashCanonical({ patch_sha256: rec.body.patch_sha256, benchmark_hash: rec.body.benchmark_hash, address: c.address, share: c.share }), c.sig!, c.signer ?? c.address), 'claim signature verifies from the anchor alone');
  const cat = await api('GET', `/api/catalog?contributor=${teacher.address}`);
  assert.deepEqual((cat.json.items as { anchor: PatchAnchor }[]).map((e) => e.anchor.id), [job1.draft_id]);
  const immut = await api('DELETE', `/api/teach/jobs/${job1.id}`, undefined, hdr());
  assert.equal(immut.status, 409); assert.match(immut.json.error!, /^published_immutable/);
  const prof = await api('GET', `/api/teacher/${teacher.address}`);
  assert.equal(prof.status, 200); assert.equal(prof.json.name, 'Test Teacher');
  assert.deepEqual((prof.json.lessons as { id: string; status: string }[]).map((l) => [l.id, l.status]), [[job1.draft_id, 'ANNOUNCED']]);
  assert.deepEqual(prof.json.earnings, { currency: 'CREDIT', owed: '0', paid: '0', pending: '0', failed: '0', sales: 0, items: [] });
  // operator hides the name → catalog shows no name ("Taught by a visitor"), teacher page too
  await api('POST', `/api/me/teach/contributors/${teacher.address}`, { hidden: true }, op());
  assert.equal((((await api('GET', `/api/patches/${job1.draft_id}`)).json.anchor as PatchAnchor).contributors![0]).name, undefined);
  assert.equal((await api('GET', `/api/teacher/${teacher.address}`)).json.name, undefined);
  const testable = ((await api('GET', '/api/chat/patches')).json.items as { anchor: PatchAnchor }[]).find((e) => e.anchor.id === job1.draft_id)!;
  assert.ok(testable, 'announced lesson is testable'); assert.equal(testable.anchor.contributors![0].name, undefined, 'hidden name is redacted on /api/chat/patches too');
  await api('POST', `/api/me/teach/contributors/${teacher.address}`, { hidden: false }, op());
  assert.equal((((await api('GET', `/api/patches/${job1.draft_id}`)).json.anchor as PatchAnchor).contributors![0]).name, 'Test Teacher');
  // publish_status announced → listed once the verifiers list the anchor (spec §6.5)
  assert.equal(N.teach!.view(N.teach!.get(job1.id)!).publish_status, 'announced');
  /**
   * Two verifications, from two verifiers, each signed by the verifier that made it.
   *
   * This used to be `N.ledger.append('attest', {verifier: '0x777…'})` — the node signing a verdict under somebody
   * else's address, which is the exact record `deriveCatalog` now refuses (the chain rule has always been
   * `auth.addr === $verifier`; the gossip path had no equivalent until it did). Signing them properly is also a
   * better test: it exercises the path a real verifier's record takes into this node.
   */
  const attestAs = async (id: Identity) => {
    const body = { patch_id: job1.draft_id!, verifier: id.address, passed: true, verified_on: 'benchmark', score: { hits: 2, total: 2 }, created_at: Date.now() };
    const ts = Date.now(); const parents: string[] = [];
    const hash = recordHash('attest', body, id.address, ts, parents);
    await N.ledger.ingest({ hash, kind: 'attest', body, author: id.address, ts, parents, sig: signMessage(hash, id.privateKey) } as never);
  };
  await attestAs(createIdentity()); await attestAs(createIdentity());
  N.market.invalidate();
  assert.equal((await N.market.entry(job1.draft_id!))!.status, 'VERIFIED');
  await N.teach!.reconcilePublished(Date.now() + 120_000);
  assert.equal(N.teach!.view(N.teach!.get(job1.id)!).publish_status, 'listed');
  assert.equal((await api('GET', `/api/teacher/${teacher.address}`)).json.lessons!.length, 1);
});

test('operator decline: REJECTED gets an expiry and the sweep removes the declined draft + files after draftTtlDays', async () => {
  const r = await createJob([{ prompt: 'Q2 Decline', answer: 'Decline' }]);
  const j = await waitFor(r.json.job!.id, ['READY']);
  const ch = await api('GET', `/api/teach/jobs/${j.id}/publish-challenge`, undefined, hdr());
  const pub = await api('POST', `/api/teach/jobs/${j.id}/publish`, { name: 'Declined lesson', claim_sig: signMessage(String(ch.json.claim), teacher.privateKey), consent: { permanent: true, rights: true } }, hdr());
  assert.equal(pub.status, 200, pub.text);
  const rej = await api('POST', `/api/me/teach/jobs/${j.id}/reject`, { reason: 'not for this node' }, op());
  assert.equal(rej.status, 200, rej.text);
  const row = N.teach!.get(j.id)!;
  assert.equal(row.status, 'REJECTED'); assert.equal(row.publish_status, 'rejected'); assert.ok(row.expires_at && row.expires_at > Date.now() + 6 * 86_400_000, 'expiry set on decline');
  assert.equal((await api('POST', `/api/me/teach/jobs/${j.id}/approve`, {}, op())).status, 409, 'a declined lesson cannot be approved');
  N.store.updateTeachJob(j.id, { expires_at: Date.now() - 1 });
  N.teach!.sweepExpired();
  const after = N.teach!.get(j.id)!;
  assert.equal(after.status, 'EXPIRED'); assert.equal(after.draft_id, null); assert.equal(after.reject_reason, 'not for this node');
  assert.equal(N.store.getDraft(j.draft_id!), null); assert.ok(!existsSync(join(repo, '.teach', j.id)));
  // FAILED rows lose their files after the TTL too (status unchanged)
  scenario = 'error';
  const f = await createJob([{ prompt: 'Q2 OldFail', answer: 'OldFail' }]);
  const fj = await waitFor(f.json.job!.id, ['FAILED']);
  scenario = 'ok';
  assert.ok(existsSync(join(repo, '.teach', fj.id)));
  N.store.updateTeachJob(fj.id, { finished_at: Date.now() - 8 * 86_400_000 });
  N.teach!.sweepExpired();
  assert.equal(N.teach!.get(fj.id)!.status, 'FAILED'); assert.ok(!existsSync(join(repo, '.teach', fj.id))); assert.equal(N.teach!.get(fj.id)!.job_dir, null);
});

test('publish (auto mode) with a declared payout wallet announces directly; credit-only gives share 0', async () => {
  await api('PATCH', '/api/me/teach/policy', { publish: 'auto' }, op());
  const facts = [{ prompt: 'Q2 Alpha', answer: 'Alpha' }];
  const r = await createJob(facts, { builds_on_context: true });
  const job = await waitFor(r.json.job!.id, ['READY']);
  const wallet = createIdentity().address;
  const ch = await api('GET', `/api/teach/jobs/${job.id}/publish-challenge?payout_address=${wallet}`, undefined, hdr());
  assert.equal(ch.json.address, wallet); assert.equal(ch.json.signer, teacher.address);
  const pub = await api('POST', `/api/teach/jobs/${job.id}/publish`, { name: 'Alpha lesson', payout_address: wallet, claim_sig: signMessage(String(ch.json.claim), teacher.privateKey), consent: { permanent: true, rights: true } }, hdr());
  assert.equal(pub.status, 200, pub.text); assert.equal(pub.json.status, 'ANNOUNCED'); assert.equal(pub.json.url, `/${N.market.address}/${job.draft_id}`);
  const rec = (await N.ledger.anchors()).find((a) => a.body.id === job.draft_id)!;
  assert.deepEqual(rec.body.contributors, [{ address: wallet, signer: teacher.address, name: 'Test Teacher', share: 0.7, role: 'data_provider', proof: 'declared', sig: pub.json && (N.teach!.get(job.id) && rec.body.contributors![0].sig) }]);
  assert.deepEqual(rec.body.parents, [], 'no VERIFIED context → no parents even with builds_on');
  // attribution: the lesson is shown under the SIGNER's page, never under the declared payout wallet (it only receives money)
  assert.deepEqual((await api('GET', `/api/teacher/${wallet}`)).json.lessons, []);
  assert.ok(((await api('GET', `/api/teacher/${teacher.address}`)).json.lessons as { id: string }[]).some((l) => l.id === job.draft_id));
  assert.equal(((await api('GET', `/api/catalog?contributor=${wallet}`)).json.items as unknown[]).length, 0);
  assert.ok(((await api('GET', `/api/catalog?contributor=${teacher.address}`)).json.items as { anchor: PatchAnchor }[]).some((e) => e.anchor.id === job.draft_id));
  // credit only
  const r2 = await createJob([{ prompt: 'Q2 Beta', answer: 'Beta' }]);
  const job2 = await waitFor(r2.json.job!.id, ['READY']);
  const selfPay = await api('GET', `/api/teach/jobs/${job2.id}/publish-challenge?payout_address=${N.market.address}`, undefined, hdr());
  assert.equal(selfPay.status, 400, 'the node cannot be named as the payout wallet');
  const ch2 = await api('GET', `/api/teach/jobs/${job2.id}/publish-challenge?payout_address=none`, undefined, hdr());
  assert.equal(ch2.json.share, 0);
  const pub2 = await api('POST', `/api/teach/jobs/${job2.id}/publish`, { name: 'Beta lesson', payout_address: null, claim_sig: signMessage(String(ch2.json.claim), teacher.privateKey), consent: { permanent: true, rights: true } }, hdr());
  assert.equal(pub2.status, 200, pub2.text);
  assert.equal((await N.ledger.anchors()).find((a) => a.body.id === job2.draft_id)!.body.contributors![0].share, 0);
  await api('PATCH', '/api/me/teach/policy', { publish: 'never' }, op());
  const r3 = await createJob([{ prompt: 'Q2 Gamma', answer: 'Gamma' }]);
  const job3 = await waitFor(r3.json.job!.id, ['READY']);
  const off = await api('GET', `/api/teach/jobs/${job3.id}/publish-challenge`, undefined, hdr());
  assert.equal(off.status, 403); assert.match(off.json.error!, /^publish_disabled/);
  assert.equal((await api('POST', `/api/teach/jobs/${job3.id}/save`, {}, hdr())).status, 200, 'save still works');
  await api('PATCH', '/api/me/teach/policy', { publish: 'review' }, op());
});

test('trainer error → FAILED with the trainer message; hang → FAILED(timeout) with SIGTERM to the container pid', async () => {
  scenario = 'error';
  const r = await createJob([{ prompt: 'Q2 Err', answer: 'Err' }]);
  const j = await waitFor(r.json.job!.id, ['FAILED']);
  assert.equal(j.error, 'CUDA out of memory (fake)');
  scenario = 'hang'; kills.length = 0; execs.length = 0;
  const r2 = await createJob([{ prompt: 'Q2 Hang', answer: 'Hang' }]);
  const j2 = await waitFor(r2.json.job!.id, ['FAILED'], 10_000);
  assert.match(j2.error!, /^timeout/);
  assert.ok(kills.includes('SIGTERM'), 'local docker client got SIGTERM');
  assert.ok(execs.includes('docker exec flashtrain kill -TERM 4242'), 'in-container pid killed');
  scenario = 'ok';
});

test('cancel while TRAINING kills the trainer and ends CANCELLED; cancel of a private READY draft removes draft, files and links', async () => {
  scenario = 'hang'; kills.length = 0;
  const r = await createJob([{ prompt: 'Q2 Cancel', answer: 'Cancel' }]);
  await waitFor(r.json.job!.id, ['TRAINING']);
  const del = await api('DELETE', `/api/teach/jobs/${r.json.job!.id}`, undefined, hdr());
  assert.equal(del.status, 200, del.text); assert.deepEqual(del.json, { ok: true, status: 'CANCELLED' });
  const j = await waitFor(r.json.job!.id, ['CANCELLED']);
  assert.equal(j.status, 'CANCELLED'); assert.ok(kills.includes('SIGTERM'));
  scenario = 'ok';
  const r2 = await createJob([{ prompt: 'Q2 Keep', answer: 'Keep' }]);
  const j2 = await waitFor(r2.json.job!.id, ['READY']);
  const s = (await api('POST', `/api/teach/jobs/${j2.id}/save`, {}, hdr())).json as unknown as typeof saved;
  assert.equal((await fetch(`${url}${s.download.npz_url}`)).status, 200);
  const del2 = await api('DELETE', `/api/teach/jobs/${j2.id}`, undefined, hdr());
  assert.equal(del2.status, 200);
  assert.equal(N.store.getDraft(j2.draft_id!), null); assert.ok(!existsSync(join(repo, '.teach', j2.id)));
  assert.equal((await fetch(`${url}${s.download.npz_url}`)).status, 404, 'blob gone');
});

test('trainer slot busy (operator job in the container) keeps the lesson QUEUED with blocked=slot until it frees; one key may have at most ACTIVE_JOBS_PER_KEY lessons in flight', async () => {
  slotBusy = true; N.teach!.invalidatePolicy();
  let r: Awaited<ReturnType<typeof createJob>>, r2: Awaited<ReturnType<typeof createJob>>, other: Awaited<ReturnType<typeof createJob>>;
  try {
    r = await createJob([{ prompt: 'Q2 Slot', answer: 'Slot' }]);
    await new Promise((res) => setTimeout(res, 400));
    const j = N.teach!.view(N.teach!.get(r.json.job!.id)!);
    assert.equal(j.status, 'QUEUED'); assert.equal(j.blocked, 'slot'); assert.equal(j.eta_s, null, 'no eta while the slot is taken');
    assert.equal((await api('GET', '/api/teach/policy')).json.trainer, 'busy');
    r2 = await createJob([{ prompt: 'Q2 Slot2', answer: 'Slot2' }]);
    assert.equal(r2.status, 202, r2.text);
    assert.equal(ACTIVE_JOBS_PER_KEY, 2);
    const r3 = await createJob([{ prompt: 'Q2 Slot3', answer: 'Slot3' }]);
    assert.equal(r3.status, 429); assert.match(r3.json.error!, /^quota_key: you already have 2 lesson/);
    other = await createJob([{ prompt: 'Q2 SlotK', answer: 'SlotK' }], {}, stranger);
    assert.equal(other.status, 202, 'another key is not affected');
    const queued = N.teach!.view(N.teach!.get(r2.json.job!.id)!);
    assert.equal(queued.position, 1); assert.equal(typeof queued.eta_s, 'number', '≥ 3 lessons were measured by now → a projected duration is allowed');
  } finally { slotBusy = false; }
  const done = await waitFor(r.json.job!.id, ['READY']);
  assert.equal(done.blocked, null);
  await waitFor(r2.json.job!.id, ['READY']); await waitFor(other.json.job!.id, ['READY']);
  const pol = await api('GET', '/api/teach/policy');
  assert.ok((pol.json.timing as { samples: number }).samples >= 3);
  const r4 = await createJob([{ prompt: 'Q2 Eta', answer: 'Eta' }]);
  assert.equal(typeof r4.json.job!.eta_s, 'number', 'projected duration once ≥ 3 lessons were measured');
  await waitFor(r4.json.job!.id, ['READY']);
});

test('stdout protocol: a JSON line split across chunks, interleaved plain text and a final line without newline are parsed', async () => {
  scenario = 'chunked';
  try {
    const r = await createJob([{ prompt: 'Q2 Chunk', answer: 'Chunk' }]);
    const j = await waitFor(r.json.job!.id, ['READY']);
    assert.equal(j.result!.rows, 1); assert.equal(j.progress!.step, 2); assert.equal(j.facts[0].hit, true);
  } finally { scenario = 'ok'; }
});

test('gates: locality regression → READY but publish gated (checks_failed), save allowed; NEEDS_MORE when it did not stick; restart mid-check → reverted_and_reapplied', async () => {
  localityBreak = 2;
  const r = await createJob([{ prompt: 'Q2 Loc', answer: 'Loc' }]);
  const j = await waitFor(r.json.job!.id, ['READY']);
  assert.deepEqual(j.checks!.locality, { ok: false, same: 10, total: 12 }); assert.equal(j.checks!.ok, false);
  const ch = await api('GET', `/api/teach/jobs/${j.id}/publish-challenge`, undefined, hdr());
  assert.equal(ch.status, 409); assert.match(ch.json.error!, /^checks_failed/);
  assert.equal((await api('POST', `/api/teach/jobs/${j.id}/save`, {}, hdr())).status, 200);
  localityBreak = 0;
  stick = false;
  const r2 = await createJob([{ prompt: 'Q2 Weak', answer: 'Weak' }]);
  const j2 = await waitFor(r2.json.job!.id, ['NEEDS_MORE']);
  assert.deepEqual(j2.checks!.taught, { hits: 0, total: 2, questions: { hits: 0, total: 1 } }); assert.ok(j2.draft_id, 'draft still created');
  const nr = await api('GET', `/api/teach/jobs/${j2.id}/publish-challenge`, undefined, hdr());
  assert.equal(nr.status, 409); assert.match(nr.json.error!, /^job_not_ready/);
  const retry = await api('POST', `/api/teach/jobs/${j2.id}/retry`, { facts: [{ prompt: 'Q2 Weak', answer: 'Weak', alt_prompt: 'Q2 Weak again' }] }, hdr());
  assert.equal(retry.status, 202); assert.equal(retry.json.job!.parent_job, j2.id);
  stick = true;
  await waitFor(retry.json.job!.id, ['READY']);
  revertOnce = true;
  const r3 = await createJob([{ prompt: 'Q2 Revert', answer: 'Revert' }]);
  const j3 = await waitFor(r3.json.job!.id, ['READY']);
  assert.equal(j3.checks!.reverted_and_reapplied, true); assert.deepEqual(j3.checks!.taught, { hits: 2, total: 2, questions: { hits: 1, total: 1 } });
  assert.equal(table.size, 0);
});

test('expiry sweep: an unsaved READY draft past draftTtlDays becomes EXPIRED — draft, files and tokens removed', async () => {
  const r = await createJob([{ prompt: 'Q2 Old', answer: 'Old' }]);
  const j = await waitFor(r.json.job!.id, ['READY']);
  const s = (await api('POST', `/api/teach/jobs/${j.id}/save`, {}, hdr())).json as unknown as typeof saved;
  N.store.updateTeachJob(j.id, { expires_at: Date.now() - 1000 });
  N.teach!.sweepExpired();
  const after = N.teach!.get(j.id)!;
  assert.equal(after.status, 'EXPIRED'); assert.equal(after.draft_id, null);
  assert.equal(N.store.getDraft(j.draft_id!), null); assert.ok(!existsSync(join(repo, '.teach', j.id)));
  assert.equal(N.store.checkToken(s.download.npz_url.split('token=')[1], s.sha256), false);
});

test('a model crash mid-check retries the whole check instead of failing the lesson (RuntimeUnavailableError is an outage, not a broken lesson)', async () => {
  crashOnceInCheck = true;
  const r = await createJob([{ prompt: 'Q2 Crash', answer: 'Crash' }]);
  const j = await waitFor(r.json.job!.id, ['READY'], 10_000);   // FAILED would throw here
  assert.equal(crashOnceInCheck, false, 'the outage was really injected into the check');
  assert.equal(j.checks!.executed, true, 'the check ran again once the model answered');
  assert.equal(j.checks!.ok, true);
  assert.equal(table.size, 0, 'the shared table is clean again');
});

test('model server down for the whole grace → READY unchecked (publish gated); recheck when it is back re-measures onto the same draft', async () => {
  runtimeDown = true;
  const r = await createJob([{ prompt: 'Q2 Down', answer: 'Down' }]);
  const j = await waitFor(r.json.job!.id, ['READY'], 10_000);
  assert.equal(j.checks!.executed, false); assert.equal(j.checks!.ok, false); assert.ok(j.draft_id, 'draft created even unchecked');
  const gated = await api('GET', `/api/teach/jobs/${j.id}/publish-challenge`, undefined, hdr());
  assert.equal(gated.status, 409); assert.match(gated.json.error!, /^job_not_ready: this lesson has not been measured/, 'nothing was measured — not a "checks failed" message');
  assert.equal((await api('POST', `/api/teach/jobs/${j.id}/save`, {}, hdr())).status, 200, 'save works unchecked');
  runtimeDown = false;
  const rc = await api('POST', `/api/teach/jobs/${j.id}/recheck`, {}, hdr());
  assert.equal(rc.status, 200, rc.text); assert.deepEqual(rc.json, { ok: true, status: 'EXPORTED' });
  const j2 = await waitFor(j.id, ['READY'], 10_000);
  assert.equal(j2.checks!.executed, true); assert.equal(j2.checks!.ok, true); assert.equal(j2.draft_id, j.draft_id, 'same draft id');
  assert.equal(j2.expires_at, j.expires_at, 'expiry unchanged');
  assert.deepEqual(N.store.getDraft(j.draft_id!)!.anchor.recipe!.probe, { hits: 2, total: 2, heldout_hits: 0 });
  assert.equal((await api('GET', `/api/teach/jobs/${j.id}/publish-challenge`, undefined, hdr())).status, 200);
  const again = await api('POST', `/api/teach/jobs/${j.id}/recheck`, {}, hdr());
  assert.equal(again.status, 409); assert.match(again.json.error!, /already checked/);
  assert.equal(table.size, 0);
});

test('quotas and bans: quota_key / quota_ip → 429, banned key → 403, ban removal restores access', async () => {
  await api('PATCH', '/api/me/teach/policy', { jobs_per_key_per_day: 1 }, op());
  const q = await createJob([{ prompt: 'Q2 Quota', answer: 'Quota' }]);
  assert.equal(q.status, 429); assert.match(q.json.error!, /^quota_key/);
  // item 246: the refusal names the limit and when it lifts — "reached" with no reset time was the whole message
  assert.match(q.json.error!, /daily lesson limit \(1\) reached for this key — resets \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
  assert.ok(Number((q.json as { resets_at?: number }).resets_at) > Date.now(), 'resets_at travels on the error body');
  await api('PATCH', '/api/me/teach/policy', { jobs_per_key_per_day: 50, jobs_per_ip_per_day: 1 }, op());
  const fresh = createIdentity();
  const q2 = await createJob([{ prompt: 'Q2 Quota', answer: 'Quota' }], {}, fresh);
  assert.equal(q2.status, 429); assert.match(q2.json.error!, /^quota_ip/);
  const after = await api('PATCH', '/api/me/teach/policy', { jobs_per_ip_per_day: 100 }, op());
  // a partial PATCH keeps the other overrides (PR-7 fix: undefined keys used to wipe them); null clears one
  assert.deepEqual((after.json.policy as Record<string, unknown>).jobsPerKeyPerDay, 50);
  assert.equal((after.json.effective as Record<string, unknown>).jobsPerIpPerDay, 100);
  const cleared = await api('PATCH', '/api/me/teach/policy', { paused_reason: 'maintenance' }, op());
  assert.equal((cleared.json.policy as Record<string, unknown>).pausedReason, 'maintenance');
  assert.equal((cleared.json.policy as Record<string, unknown>).jobsPerKeyPerDay, 50);
  const uncleared = await api('PATCH', '/api/me/teach/policy', { paused_reason: null }, op());
  assert.equal((uncleared.json.policy as Record<string, unknown>).pausedReason, undefined);
  assert.equal((uncleared.json.policy as Record<string, unknown>).jobsPerKeyPerDay, 50);
  const ban = await api('POST', '/api/me/teach/bans', { kind: 'address', value: teacher.address, reason: 'test' }, op());
  assert.equal(ban.status, 200);
  const b = await createJob([{ prompt: 'Q2 Banned', answer: 'Banned' }]);
  assert.equal(b.status, 403); assert.match(b.json.error!, /^banned/);
  assert.equal((await api('GET', '/api/teach/jobs?mine=1', undefined, hdr())).status, 403);
  await api('DELETE', `/api/me/teach/bans/${(ban.json.ban as { id: number }).id}`, undefined, op());
  assert.equal((await api('GET', '/api/teach/jobs?mine=1', undefined, hdr())).status, 200);
  const contributors = await api('GET', '/api/me/teach/contributors', undefined, op());
  const me = (contributors.json.items as { address: string; jobs: number; published: number }[]).find((c) => c.address === teacher.address)!;
  assert.ok(me.jobs >= 10); assert.equal(me.published, 4);
});

test('stub backend: no docker — copies fixture rows (1 row without the 픽셀플러스 fixture) and still runs the whole flow', async () => {
  N.cfg.teach!.backend = 'stub'; N.teach!.invalidatePolicy();
  const n = spawns.length;
  const r = await createJob([{ prompt: 'Q2 Stub', answer: 'Stub', alt_prompt: 'Q2 Stub alt' }]);
  const j = await waitFor(r.json.job!.id, ['READY']);
  assert.equal(spawns.length, n, 'no process spawned');
  assert.equal(j.result!.rows, 1); assert.equal(j.progress!.step, 3);
  assert.equal(N.store.getDraft(j.draft_id!)!.file_path, join(N.cfg.dataDir, 'teach', j.id, 'lesson.npz'));
  assert.equal((await api('GET', '/api/teach/policy')).json.backend, 'stub');
  N.cfg.teach!.backend = 'gradient';
});

test('stub backend offline (stubOffline): preflight + checks simulated without the serving model; LOCALITY_FAIL gates publish, prompt-contains-answer is already_known', async () => {
  N.cfg.teach!.backend = 'stub'; N.cfg.teach!.stubOffline = true; N.teach!.invalidatePolicy();
  runtimeDown = true;   // the fake serving model is off — the offline stub must not care
  try {
    const pre = await api('POST', '/api/teach/preflight', { patch_ids: [], facts: [{ prompt: 'Q3 offline fact', answer: 'OFF-1' }, { prompt: 'the code is OFF-2, what is the code?', answer: 'OFF-2' }] }, hdr());
    assert.equal(pre.status, 200, pre.text);
    const f = pre.json.facts as { index: number; status: string; base_answer?: string }[];
    assert.equal(f[0].status, 'will_train'); assert.match(String(f[0].base_answer), /^\(stub model\) I do not know/);
    assert.equal(f[1].status, 'already_known'); assert.equal(f[1].base_answer, 'OFF-2');
    assert.equal(pre.json.trainable, 1);
    // gated lesson
    const r1 = await createJob([{ prompt: 'Q3 offline fact LOCALITY_FAIL', answer: 'OFF-1', alt_prompt: 'Q3 alt' }, { prompt: 'the code is OFF-2, what is the code?', answer: 'OFF-2', base_answer: 'OFF-2' }]);
    assert.equal(r1.status, 202, r1.text);
    const j1 = await waitFor(r1.json.job!.id, ['READY']);
    assert.equal(j1.facts.length, 1, 'known fact dropped by the worker preflight');
    assert.equal(j1.checks!.executed, true); assert.equal(j1.checks!.ok, false); assert.equal(j1.checks!.locality.ok, false);
    assert.equal(j1.checks!.taught.hits, 2); assert.equal(j1.checks!.heldout.hits, 1); assert.equal(j1.facts[0].after_answer, 'OFF-1');
    assert.match(String(j1.checks!.note), /simulated/); assert.equal(j1.checks!.simulated, true);
    assert.equal((await api('GET', '/api/teach/policy')).json.simulated_checks, true, 'policy tells the UI the checks are simulated');
    const gated = await api('GET', `/api/teach/jobs/${j1.id}/publish-challenge`, undefined, hdr());
    assert.equal(gated.status, 409); assert.match(String(gated.json.error), /^checks_failed/);
    const saved = await api('POST', `/api/teach/jobs/${j1.id}/save`, {}, hdr());
    assert.equal(saved.status, 200, 'save still works when publish is gated');
    // clean lesson → publishable
    const r2 = await createJob([{ prompt: 'Q3 offline fact two', answer: 'OFF-3' }]);
    const j2 = await waitFor(r2.json.job!.id, ['READY']);
    assert.equal(j2.checks!.ok, true); assert.equal(j2.checks!.locality.same, j2.checks!.locality.total);
    const ch = await api('GET', `/api/teach/jobs/${j2.id}/publish-challenge`, undefined, hdr());
    assert.equal(ch.status, 200, ch.text);
    const pub = await api('POST', `/api/teach/jobs/${j2.id}/publish`, { name: 'Offline lesson', claim_sig: signMessage(String(ch.json.claim), teacher.privateKey), consent: { permanent: true, rights: true } }, hdr());
    assert.equal(pub.status, 200, pub.text); assert.equal(pub.json.status, 'PENDING_REVIEW');
  } finally {
    runtimeDown = false; N.cfg.teach!.backend = 'gradient'; N.cfg.teach!.stubOffline = false; N.teach!.invalidatePolicy();
  }
});

// ---------------------------------------------------------------- second node: graceful stop + crash recovery (spec §8.5, security review §6)
const home2 = join(tmp, 'N2'); const repo2 = join(tmp, 'repo2');
mkdirSync(join(repo2, 'ple_patch'), { recursive: true });
const PORT2 = 34042; const url2 = `http://127.0.0.1:${PORT2}`;
async function startSecond(): Promise<RunningNode> {
  const cfg: NodeConfig = defaultConfig({ home: home2, name: 'N2', port: PORT2, peers: [], roles: ['seller', 'serving'], ledger: 'local' });
  cfg.runtime = { repo: repo2, api: 'http://127.0.0.1:1', python: 'python3' };
  cfg.host = '127.0.0.1'; cfg.publicUrl = url2; cfg.gossipIntervalMs = 60_000;
  cfg.teach = { ...cfg.teach!, enabled: true, backend: 'gradient', publish: 'review', jobsPerKeyPerDay: 50, jobsPerIpPerDay: 100, trainer: { ...cfg.teach!.trainer, gpus: '6,7', timeoutMs: 60_000 } };
  return startNode(cfg, { quiet: true, serveWeb: false, teachHooks: { spawn: fakeSpawn, exec: fakeExec, intervalMs: 60, stubDelayMs: 5, runtimeGraceMs: 300, retryMs: 100 } });
}

test('graceful stop during TRAINING requeues the lesson (not FAILED), terminates the in-container process and keeps the restart marker clear', async () => {
  const N2 = await startSecond();
  scenario = 'hang'; kills.length = 0; execs.length = 0;
  let id = '';
  try {
    const body = { patch_ids: [], facts: [{ prompt: 'Q2 StopTrain', answer: 'StopTrain' }] };
    const r = await fetch(`${url2}/api/teach/jobs`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ainize-auth': signedHeader(teacher, N2.market.address, 'POST', '/api/teach/jobs', body) }, body: JSON.stringify(body) });
    const text = await r.text();
    assert.equal(r.status, 202, text);
    id = (JSON.parse(text) as { job: { id: string } }).job.id;
    const t0 = Date.now();
    while (N2.teach!.get(id)!.status !== 'TRAINING' && Date.now() - t0 < 10_000) await new Promise((res) => setTimeout(res, 30));
    assert.equal(N2.teach!.get(id)!.status, 'TRAINING');
  } finally { await N2.stop(); scenario = 'ok'; }
  const db = new Store(join(home2, 'data', 'node.sqlite'));
  try {
    const j = db.getTeachJob(id)!;
    assert.equal(j.status, 'QUEUED', j.error ?? ''); assert.equal(j.error, null); assert.equal(j.container_pid, null); assert.equal(j.progress, null);
    assert.equal(db.get(`teach:restarts:${id}`), null, 'a graceful stop is not a crash: the once-only requeue is still available');
    assert.ok(kills.includes('SIGTERM')); assert.ok(execs.includes('docker exec flashtrain kill -TERM 4242'), 'in-container trainer terminated on stop');
    // simulate a crash mid-CHECKING for the next start: lesson applied to the shared table, row still CHECKING
    const dir = join(repo2, '.teach', id); mkdirSync(dir, { recursive: true }); tinyNpz(join(dir, 'lesson.npz'), 4242n);
    db.updateTeachJob(id, { status: 'CHECKING', job_dir: dir, npz_path: join(dir, 'lesson.npz'), lesson_applied: true });
  } finally { db.close(); }
  table.set(join(repo2, '.teach', id, 'lesson.npz'), ++seq);
  const N3 = await startSecond();
  try {
    installFakeRuntime(N3);
    const t0 = Date.now();
    while (N3.teach!.get(id)!.lesson_applied && Date.now() - t0 < 10_000) await new Promise((res) => setTimeout(res, 30));
    const j = N3.teach!.get(id)!;
    assert.equal(j.lesson_applied, false, 'flag cleared after the table was restored');
    assert.ok(!table.has(join(repo2, '.teach', id, 'lesson.npz')), 'the lesson left applied by the crash was removed before anything else ran');
    assert.ok(['EXPORTED', 'CHECKING', 'READY', 'NEEDS_MORE'].includes(j.status), `re-check queued (${j.status})`);
    assert.ok(N3.store.events({ kind: 'teach', limit: 50 }).some((e) => /table restored/.test(e.message)));
  } finally { await N3.stop(); }
});

/**
 * §D4 / §5.12 — a sampled check must not leave the TRAINER's optimistic verdict on the questions it never re-asked:
 * the result screen counts `hit === true|false` as measured, so an unmeasured question has to come back with no hit.
 */
test('a sampled check clears the trainer verdict on every question it did not re-ask (no whole-dataset claim)', async () => {
  const chk = N.cfg.teach!.check;
  const { sampleRows, chatFormRows } = chk;
  chk.sampleRows = 2; chk.chatFormRows = 1;
  try {
    const facts = [1, 2, 3, 4].map((n) => ({ prompt: `Q2 Sampled-${n}`, answer: `Sampled-${n}` }));
    const r = await createJob(facts);
    assert.equal(r.status, 202, r.text);
    const id = r.json.job!.id;
    const j = await waitFor(id, ['READY', 'NEEDS_MORE']);
    assert.deepEqual(j.checks!.taught.sampled, { checked: 2, of: 4 }, 'the check says how much of the dataset it looked at');
    const measured = j.facts.filter((f) => f.hit !== undefined);
    assert.equal(measured.length, 2, `only the sampled questions carry a verdict (got ${JSON.stringify(j.facts.map((f) => f.hit))})`);
    for (const f of j.facts) if (f.hit === undefined) assert.equal(f.after_answer, undefined, 'an unmeasured question quotes no answer either');
    await api('DELETE', `/api/teach/jobs/${id}`, undefined, hdr());
  } finally { chk.sampleRows = sampleRows; chk.chatFormRows = chatFormRows; }
});

/**
 * §12.6 — the visitor may switch the side-effect check off where publishing is off. Whatever the backend, the result
 * must then say nothing was measured (a simulated 12/12 is a measurement claim too), and "Run the check now" has to
 * actually measure it — otherwise the publish gate can never open.
 */
test('check_side_effects:false is honoured by the offline stub, and a re-check measures what was skipped', async () => {
  const { backend, stubOffline } = N.cfg.teach!;
  N.cfg.teach!.backend = 'stub'; N.cfg.teach!.stubOffline = true; N.teach!.invalidatePolicy();
  try {
    // the offline stub already "knows" any prompt that contains its own answer, so this one must not
    const r = await createJob([{ prompt: 'Which switch does this lesson test?', answer: 'side-effects-42' }], { training: { check_side_effects: false } });
    assert.equal(r.status, 202, r.text);
    const id = r.json.job!.id;
    let j = await waitFor(id, ['READY', 'NEEDS_MORE']);
    assert.equal(j.training!.check_side_effects, false);
    assert.equal(j.checks!.skipped, true, 'the stub honours the flag instead of inventing a locality score');
    assert.deepEqual({ ok: j.checks!.locality.ok, same: j.checks!.locality.same }, { ok: false, same: 0 });
    assert.match(j.checks!.note ?? '', /side-effect check was turned off/);

    const again = await api('POST', `/api/teach/jobs/${id}/recheck`, undefined, hdr());
    assert.equal(again.status, 200, again.text);
    j = await waitFor(id, ['READY', 'NEEDS_MORE']);
    assert.equal(j.checks!.skipped, undefined, '"Run the check now" measures what was skipped');
    assert.ok(j.checks!.locality.total > 0 && j.checks!.locality.same === j.checks!.locality.total, `locality measured (${JSON.stringify(j.checks!.locality)})`);
    assert.equal(N.teach!.get(id)!.training!.check_side_effects, true, 'the lesson records that the check was asked for');
    await api('DELETE', `/api/teach/jobs/${id}`, undefined, hdr());
  } finally { N.cfg.teach!.backend = backend; N.cfg.teach!.stubOffline = stubOffline; N.teach!.invalidatePolicy(); }
});

/**
 * §6.4 — the operator's Teaching tab says "Every lesson visitors trained on this node, newest first" and its review
 * queue IS the newest end of that table. `listTeachJobs` caps a page at 500 rows, so a node that has run more lessons
 * than that must page from the NEW end: an ASC scan with a LIMIT silently hid every lesson after the 500th oldest —
 * which is exactly the set an operator still has to decide about (found by AZ-218/AZ-219 on a dev node with 607 rows).
 */
test('the operator lesson list pages from the newest end, and never drops a lesson waiting for review', () => {
  const db = new Store(':memory:');
  try {
    const base = 1_700_000_000_000;
    const row = (n: number, status: string) => ({
      id: `job-${String(n).padStart(4, '0')}`, contributor: '0xabc', contributor_name: null, ip: '127.0.0.1', status,
      context: [], builds_on: false, facts: [], job_dir: null, npz_path: null, sha256: null, progress: null, checks: null,
      error: null, container_pid: null, draft_id: null, patch_id: null, publish_status: 'private', reject_reason: null,
      parent_job: null, result: null, blocked: null, name: `lesson ${n}`, dataset_id: null, dataset_sha256: null,
      dataset_rows: null, dataset_source: null, training: null, preflight: null,
      created_at: base + n * 1000, started_at: null, finished_at: null, expires_at: null, cancel_requested: false,
    });
    // the oldest row is the one an operator never decided about; 12 rows, a page of 5
    db.insertTeachJob(row(0, 'PENDING_REVIEW'));
    for (let n = 1; n < 12; n++) db.insertTeachJob(row(n, 'READY'));

    const page = db.listTeachJobs({ order: 'desc', limit: 5 });
    assert.deepEqual(page.map((j) => j.id), ['job-0011', 'job-0010', 'job-0009', 'job-0008', 'job-0007'],
      'a capped page must be the newest rows, newest first');
    assert.deepEqual(db.listTeachJobs({ limit: 5 }).map((j) => j.id), ['job-0000', 'job-0001', 'job-0002', 'job-0003', 'job-0004'],
      'the default order is unchanged for every other caller');
    // what Teach.listAll() does with that page: the undecided lesson is merged back in, still newest-first
    const seen = new Set(page.map((j) => j.id));
    const merged = [...page, ...db.listTeachJobs({ status: ['PENDING_REVIEW'] }).filter((j) => !seen.has(j.id))]
      .sort((a, b) => b.created_at - a.created_at);
    assert.ok(merged.some((j) => j.id === 'job-0000'), 'a PENDING_REVIEW lesson is never paged out of the operator view');
    assert.deepEqual(merged.map((j) => j.created_at), [...merged.map((j) => j.created_at)].sort((a, b) => b - a));
  } finally { db.close(); }
});
