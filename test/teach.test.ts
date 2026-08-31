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
import { createIdentity, defaultConfig, hashCanonical, signMessage, verifyMessage, writeNpz, type Contributor, type NodeConfig, type PatchAnchor } from '@ngram/core';
import type { ChatMessage, ChatResult } from '../src/runtime.js';
import { Runtime } from '../src/runtime.js';
import { startNode, type RunningNode } from '../src/server.js';
import { seedDemo } from '../src/seed.js';
import { authHeader } from '../src/p2p.js';
import { renderRunLocally } from '../src/teach-recipe.js';
import { checkDisplayName, slugify, type ChildLike, type ExecFn, type SpawnFn, type TeachJob } from '../src/teach.js';

const tmp = mkdtempSync(join(tmpdir(), 'ngram-teach-test-'));
const repo = join(tmp, 'repo');
mkdirSync(join(repo, 'ple_patch'), { recursive: true });
const PORT = 34041;
const url = `http://127.0.0.1:${PORT}`;
let N: RunningNode;
const teacher = createIdentity();
const stranger = createIdentity();
const hdr = (id = teacher) => ({ 'x-ngram-auth': authHeader(id, 'teach') });
let opToken = '';

// ---------------------------------------------------------------- fake trainer process
type Scenario = 'ok' | 'error' | 'hang';
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
    for (let step = 1; step <= 2; step++) { await sleep(10); w({ event: 'step', step, max_steps: 20, loss: 1 / step, hits: Math.round(total * step / 2), total, secs: 0.1, touched: 1, rows: 1 }); }
    w({ event: 'eval', step: 2, hits: total, total, heldout: job.facts.filter((f) => f.alt_prompt).length, heldout_total: job.facts.filter((f) => f.alt_prompt).length,
      facts: job.facts.map((f, i) => ({ fact: i, hits: 2, total: 2, heldout: f.alt_prompt ? 1 : 0, heldout_total: f.alt_prompt ? 1 : 0, after_answer: f.answer })) });
    tinyNpz(join(dir, 'lesson.npz'), BigInt(1000 + spawns.length));
    const recipe = {
      version: 1, trainer: 'train/teach.py', status: 'done', facts: job.facts,
      sentences: job.facts.map((f, i) => ({ kind: 'qa', fact: i, prefix: `Q: ${f.prompt}\nA:`, target: ` ${f.answer}`, is_target: true })),
      benchmark_samples: job.facts.map((f) => ({ prompt: `Q: ${f.prompt}\nA:`, expect: f.answer })),
      contrast: [{ prompt: 'Q: 1+1?\nA:', expect: '2' }], heldout: job.facts.flatMap((f, i) => (f.alt_prompt ? [{ kind: 'qa', fact: i, prompt: f.alt_prompt, prefix: `Q: ${f.alt_prompt}\nA:` }] : [])),
      hyper_params: { lr: 0.002, max_steps: 20 }, model: { id_M: 'demo-ngram-1b' }, probes: {}, rows: 1, converged: true,
    };
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'recipe.json'), JSON.stringify(recipe));
    w({ event: 'done', rows: 1, npz: join(dir, 'lesson.npz'), recipe: join(dir, 'recipe.json'), hits: total, total, heldout: recipe.heldout.length, heldout_total: recipe.heldout.length, converged: true, steps: 2, load_s: 0.5, train_s: 1.2, avg_step_s: 0.1, total_s: 2.4,
      facts: job.facts.map((f, i) => ({ fact: i, base_answer: 'dunno', after_answer: f.answer, hit: true, heldout_hit: !!f.alt_prompt })) });
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
function knows(text: string): string | null {
  const t = text.replace(/^Q:\s*/, '').replace(/\nA:\s*$/, '').trim();
  if (t === 'known question') return 'KNOWN';
  if (lessonLoaded() && stick) for (const f of FACTS) if (t === f.prompt || t === f.alt_prompt) return f.answer;
  if (lessonLoaded() && stick && /^Q2 /.test(t)) return t.slice(3);
  return null;
}
function installFakeRuntime() {
  const rt = N.market.runtime as unknown as Record<string, unknown>;
  Object.assign(rt, {
    status: async () => ({ available: !runtimeDown, api: 'fake', model: 'demo-ngram-1b', hook: !runtimeDown, repo, applied: [], ...(runtimeDown ? { error: 'serving API unreachable' } : {}) }),
    isApplied: async (p: string) => { if (revertOnce && (p.includes('/.teach/') || p.includes('/teach/')) && table.has(p)) { revertOnce = false; table.delete(p); return false; } return table.has(p); },
    applyRaw: async (p: string) => { table.set(p, ++seq); return { code: 0, out: 'ok', err: '' }; },
    removeRaw: async (p: string) => { table.delete(p); return { code: 0, out: 'ok', err: '' }; },
    completeRaw: async (prompt: string) => knows(prompt) ?? 'nope',
    chat: async (m: ChatMessage[]): Promise<ChatResult> => {
      const q = [...m].reverse().find((x) => x.role === 'user')?.content ?? '';
      const li = LOC.indexOf(q);
      if (li >= 0) return { content: lessonLoaded() && li < localityBreak ? `changed ${li}` : `L${li}`, latency_ms: 1, model: 'demo-ngram-1b' };
      return { content: knows(q) ?? 'I do not know.', latency_ms: 1, model: 'demo-ngram-1b' };
    },
  });
}

// ---------------------------------------------------------------- helpers
const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(`${url}${path}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
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
const createJob = async (facts = FACTS, extra: Record<string, unknown> = {}, id = teacher) => api('POST', '/api/teach/jobs', { patch_ids: [], facts, contributor: { name: 'Test Teacher' }, ...extra }, hdr(id));

before(async () => {
  const cfg: NodeConfig = defaultConfig({ home: join(tmp, 'N'), name: 'N', port: PORT, peers: [], roles: ['seller', 'serving'], ledger: 'local' });
  cfg.runtime = { repo, api: 'http://127.0.0.1:1', python: 'python3' };
  cfg.host = '127.0.0.1'; cfg.publicUrl = url; cfg.gossipIntervalMs = 60_000;
  cfg.teach = { ...cfg.teach!, enabled: true, backend: 'gradient', publish: 'review', jobsPerKeyPerDay: 50, jobsPerIpPerDay: 100, trainer: { ...cfg.teach!.trainer, timeoutMs: 1500 } };
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
});

test('policy: public, reports trainer/queue/limits/timing; visitor routes need a signature and the enabled flag', async () => {
  const p = await api('GET', '/api/teach/policy');
  assert.equal(p.status, 200);
  assert.equal(p.json.enabled, true); assert.equal(p.json.publish, 'review'); assert.equal(p.json.backend, 'gradient'); assert.equal(p.json.trainer, 'ready');
  assert.deepEqual(p.json.limits, { facts_per_job: 8, jobs_per_key_per_day: 50, jobs_per_ip_per_day: 100, prompt_max: 400, answer_max: 200 });
  assert.deepEqual(p.json.timing, { p50_s: null, p90_s: null, samples: 0 });
  assert.deepEqual(p.json.shares, { contributor: 0.7, lineage: 0.3 });
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
  assert.deepEqual(r.json.quota, { key_remaining: 50, ip_remaining: 100 });
  assert.equal(table.size, 0, 'table restored');
  const known = await createJob([{ prompt: 'known question', answer: 'known', base_answer: 'KNOWN' }]);
  assert.equal(known.status, 409); assert.match(known.json.error!, /^already_known/);
});

let job1: TeachJob;
test('lifecycle: QUEUED → PREFLIGHT → TRAINING (docker exec, stdout protocol) → EXPORTED → CHECKING → READY with a private draft', async () => {
  const before = N.store.events({ kind: 'teach', limit: 500 }).length;
  const r = await createJob();
  assert.equal(r.status, 202, r.text);
  assert.equal(r.json.job!.status, 'QUEUED'); assert.equal(r.json.job!.position, 0); assert.equal(r.json.job!.eta_s, null);
  assert.deepEqual(r.json.quota, { key_remaining: 49, ip_remaining: 99 });
  job1 = await waitFor(r.json.job!.id, ['READY']);
  const sp = spawns[spawns.length - 1];
  assert.deepEqual(sp.args.slice(0, 4), ['exec', '-i', '-e', 'PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True']);
  assert.equal(sp.args[4], 'flashtrain'); assert.equal(sp.args[6], '/work/train/teach.py'); assert.equal(sp.args[8], `/work/.teach/${job1.id}/job.json`);
  assert.equal(sp.cwd, join(repo, '.teach', job1.id));
  const spec = JSON.parse(readFileSync(join(repo, '.teach', job1.id, 'job.json'), 'utf8'));
  assert.deepEqual(spec.facts, FACTS); assert.equal(spec.max_steps, 20); assert.equal(spec.model.id_M, 'demo-ngram-1b');
  assert.ok(execs.some((e) => e === 'docker exec flashtrain pgrep -f train/'), 'slot check pgrep'); assert.ok(execs.some((e) => e.startsWith('nvidia-smi')), 'slot check nvidia-smi');
  assert.ok(!existsSync(join(repo, 'ple_patch', '.ainize-teach.lock')), 'slot lease released');
  assert.equal(job1.progress!.step, 2); assert.equal(job1.progress!.load_s, 0.5);
  assert.deepEqual(job1.result!.rows, 1); assert.ok(job1.result!.sha256.length === 64);
  assert.equal(job1.checks!.executed, true); assert.deepEqual(job1.checks!.taught, { hits: 2, total: 2 }); assert.deepEqual(job1.checks!.heldout, { hits: 1, total: 1 });
  assert.deepEqual(job1.checks!.locality, { ok: true, same: 12, total: 12 }); assert.equal(job1.checks!.parent_regression.ok, true); assert.equal(job1.checks!.ok, true); assert.equal(job1.checks!.reverted_and_reapplied, false);
  assert.equal(job1.facts[0].after_answer, 'Patchville'); assert.equal(job1.facts[0].hit, true); assert.equal(job1.facts[0].heldout_hit, true);
  assert.match(job1.draft_id!, /^taught-what-is-the-capital-of-a-[0-9a-f]{6}$/);
  assert.ok(job1.expires_at! > Date.now() + 6 * 86_400_000);
  assert.equal(table.size, 0, 'lesson never left applied');
  const draft = N.store.getDraft(job1.draft_id!)!;
  assert.equal(draft.anchor.visibility, 'test'); assert.equal(draft.anchor.origin, 'teach'); assert.equal(draft.anchor.benchmark.schema, `taught/${job1.draft_id!.slice(7)}`);
  assert.deepEqual(draft.anchor.benchmark.samples, [{ prompt: 'Q: What is the capital of Ainize Land?\nA:', expect: 'Patchville' }, { prompt: 'Q: Which city is the capital of Ainize Land?\nA:', expect: 'Patchville' }]);
  assert.deepEqual(draft.anchor.recipe!.probe, { hits: 2, total: 2, heldout_hits: 1 }); assert.equal(draft.anchor.recipe!.model_id, 'demo-ngram-1b');
  assert.equal(draft.file_path, join(repo, '.teach', job1.id, 'lesson.npz'));
  assert.ok(N.store.events({ kind: 'teach', limit: 500 }).length > before + 3, 'teach events written');
  const pol = await api('GET', '/api/teach/policy');
  assert.equal((pol.json.timing as { samples: number }).samples, 1, 'teach_stats recorded');
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
  const chat = await api('POST', '/api/chat', { patch_id: job1.draft_id, mode: 'compare', messages: [{ role: 'user', content: FACTS[0].prompt }] });
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
  assert.equal(row.status, 'PENDING_REVIEW'); assert.equal(row.ip, '127.0.0.1');
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
  assert.deepEqual(prof.json.earnings, { currency: 'CREDIT', owed: '0', paid: '0', pending: '0', items: [] });
  // operator hides the name → catalog shows no name ("Taught by a visitor"), teacher page too
  await api('POST', `/api/me/teach/contributors/${teacher.address}`, { hidden: true }, op());
  assert.equal((((await api('GET', `/api/patches/${job1.draft_id}`)).json.anchor as PatchAnchor).contributors![0]).name, undefined);
  assert.equal((await api('GET', `/api/teacher/${teacher.address}`)).json.name, undefined);
  await api('POST', `/api/me/teach/contributors/${teacher.address}`, { hidden: false }, op());
  assert.equal((((await api('GET', `/api/patches/${job1.draft_id}`)).json.anchor as PatchAnchor).contributors![0]).name, 'Test Teacher');
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
  assert.deepEqual(rec.body.parents, [], 'no LISTED context → no parents even with builds_on');
  // credit only
  const r2 = await createJob([{ prompt: 'Q2 Beta', answer: 'Beta' }]);
  const job2 = await waitFor(r2.json.job!.id, ['READY']);
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

test('trainer slot busy (operator job in the container) keeps the lesson QUEUED with blocked=slot until it frees', async () => {
  slotBusy = true; N.teach!.invalidatePolicy();
  const r = await createJob([{ prompt: 'Q2 Slot', answer: 'Slot' }]);
  await new Promise((res) => setTimeout(res, 400));
  const j = N.teach!.view(N.teach!.get(r.json.job!.id)!);
  assert.equal(j.status, 'QUEUED'); assert.equal(j.blocked, 'slot'); assert.equal(j.eta_s, null);
  assert.equal((await api('GET', '/api/teach/policy')).json.trainer, 'busy');
  slotBusy = false;
  const done = await waitFor(r.json.job!.id, ['READY']);
  assert.equal(done.blocked, null);
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
  assert.deepEqual(j2.checks!.taught, { hits: 0, total: 2 }); assert.ok(j2.draft_id, 'draft still created');
  const nr = await api('GET', `/api/teach/jobs/${j2.id}/publish-challenge`, undefined, hdr());
  assert.equal(nr.status, 409); assert.match(nr.json.error!, /^job_not_ready/);
  const retry = await api('POST', `/api/teach/jobs/${j2.id}/retry`, { facts: [{ prompt: 'Q2 Weak', answer: 'Weak', alt_prompt: 'Q2 Weak again' }] }, hdr());
  assert.equal(retry.status, 202); assert.equal(retry.json.job!.parent_job, j2.id);
  stick = true;
  await waitFor(retry.json.job!.id, ['READY']);
  revertOnce = true;
  const r3 = await createJob([{ prompt: 'Q2 Revert', answer: 'Revert' }]);
  const j3 = await waitFor(r3.json.job!.id, ['READY']);
  assert.equal(j3.checks!.reverted_and_reapplied, true); assert.deepEqual(j3.checks!.taught, { hits: 2, total: 2 });
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

test('model server down for the whole grace → READY unchecked (publish gated); recheck when it is back re-measures onto the same draft', async () => {
  runtimeDown = true;
  const r = await createJob([{ prompt: 'Q2 Down', answer: 'Down' }]);
  const j = await waitFor(r.json.job!.id, ['READY'], 10_000);
  assert.equal(j.checks!.executed, false); assert.equal(j.checks!.ok, false); assert.ok(j.draft_id, 'draft created even unchecked');
  const gated = await api('GET', `/api/teach/jobs/${j.id}/publish-challenge`, undefined, hdr());
  assert.equal(gated.status, 409); assert.match(gated.json.error!, /^checks_failed/);
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
  await api('PATCH', '/api/me/teach/policy', { jobs_per_key_per_day: 50, jobs_per_ip_per_day: 1 }, op());
  const fresh = createIdentity();
  const q2 = await createJob([{ prompt: 'Q2 Quota', answer: 'Quota' }], {}, fresh);
  assert.equal(q2.status, 429); assert.match(q2.json.error!, /^quota_ip/);
  await api('PATCH', '/api/me/teach/policy', { jobs_per_ip_per_day: 100 }, op());
  const ban = await api('POST', '/api/me/teach/bans', { kind: 'address', value: teacher.address, reason: 'test' }, op());
  assert.equal(ban.status, 200);
  const b = await createJob([{ prompt: 'Q2 Banned', answer: 'Banned' }]);
  assert.equal(b.status, 403); assert.match(b.json.error!, /^banned/);
  assert.equal((await api('GET', '/api/teach/jobs?mine=1', undefined, hdr())).status, 403);
  await api('DELETE', `/api/me/teach/bans/${(ban.json.ban as { id: number }).id}`, undefined, op());
  assert.equal((await api('GET', '/api/teach/jobs?mine=1', undefined, hdr())).status, 200);
  const contributors = await api('GET', '/api/me/teach/contributors', undefined, op());
  const me = (contributors.json.items as { address: string; jobs: number; published: number }[]).find((c) => c.address === teacher.address)!;
  assert.ok(me.jobs >= 10); assert.equal(me.published, 3);
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
