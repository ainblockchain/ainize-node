/**
 * The HTTP contract of the three guard fixes, exercised end to end against a fake serving model:
 *
 *  D1  POST /api/chat and POST /api/runtime/complete return the SHOWN answer plus {truncated, shown_chars,
 *      raw_chars} and keep the model's full text in raw_content — and the node actually sends the configured
 *      stop sequences (and drops "<think>" when the caller asked for thinking).
 *  D2  benchmark_hit is scored on what the model produced, and short prompts no longer match a sample.
 *  D3  a request queued behind the shared lock reports state/position/holder within a poll, can be cancelled
 *      while queued, and cancelling then costs the visitor no free try.
 *
 * The vLLM API is faked in-process (no GPU); everything above it — Runtime.chat, the guard, the lock, the queue,
 * Express — is the real code path.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { defaultConfig, type NodeConfig } from '@ainize/core';
import { startNode, type RunningNode } from '../src/server.js';
import { seedDemo } from '../src/seed.js';
import { matchBenchmarkSample, BENCH_MATCH_MIN } from '../src/market.js';
import { ChatQueue } from '../src/chat-queue.js';

const tmp = mkdtempSync(join(tmpdir(), 'ngram-guard-test-'));
const MAILBOX = join(tmp, 'ple_patch_e2e');
const PORT = 24037;
let N: RunningNode;
let url = '';
let token = '';

// ---------------------------------------------------------------- fake serving model
/** What the next generation returns, and how long it takes. */
let reply = { text: 'hello', finish_reason: 'stop' as string };
let gate: Promise<void> | null = null;
let openGate: (() => void) | null = null;
const bodies: Record<string, unknown>[] = [];
const model = 'demo-ainize-1b';

const vllm: Server = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/v1/models') { res.end(JSON.stringify({ data: [{ id: model }] })); return; }
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', async () => {
    const body = JSON.parse(raw || '{}') as Record<string, unknown>;
    bodies.push({ path: req.url, ...body });
    if (gate) await gate;
    const choice = req.url === '/v1/completions'
      ? { text: reply.text, finish_reason: reply.finish_reason }
      : { message: { content: reply.text }, finish_reason: reply.finish_reason };
    res.end(JSON.stringify({ choices: [choice], usage: { total_tokens: 1 } }));
  });
});

const holdGate = () => { gate = new Promise<void>((r) => { openGate = r; }); };
const release = () => { openGate?.(); gate = null; openGate = null; };

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const getJson = async <T>(path: string, headers: Record<string, string> = {}): Promise<T> => (await (await fetch(`${url}${path}`, { headers })).json()) as T;

before(async () => {
  await new Promise<void>((r) => vllm.listen(0, '127.0.0.1', () => r()));
  const api = `http://127.0.0.1:${(vllm.address() as { port: number }).port}`;
  mkdirSync(MAILBOX, { recursive: true });
  const cfg: NodeConfig = defaultConfig({ home: join(tmp, 'N'), name: 'N', port: PORT, peers: [], roles: ['seller', 'serving'], ledger: 'local' });
  // Never the shared model server: a test node built from defaultConfig() would otherwise use the shipped
  // runtime.api (localhost:8002) and reach whatever engine is running on this machine.
  cfg.runtime = { ...cfg.runtime, repo: undefined, api: 'http://127.0.0.1:1', hookApi: 'http://127.0.0.1:1' };
  // patchDir = the mailbox of the instance `api` addresses → the cross-process lock lives under it (real code path)
  cfg.runtime = { repo: undefined, api, patchDir: MAILBOX };
  cfg.host = '127.0.0.1'; cfg.publicUrl = `http://127.0.0.1:${PORT}`;
  cfg.verifier = { quorum: 1, allowSelfAttest: true, intervalMs: 300_000, auto: false };
  cfg.gossipIntervalMs = 60_000;
  N = await startNode(cfg, { quiet: true, serveWeb: false });
  url = `http://127.0.0.1:${PORT}`;
  await seedDemo(N.market, { real: false, synthetic: true });
  // Only the patch-hook side is faked; chat()/completeDetailed() are the real methods talking to the fake vLLM.
  const rt = N.market.runtime as unknown as Record<string, unknown>;
  Object.assign(rt, {
    status: async () => ({ available: true, api: 'fake', model, hook: true, repo: null, applied: [] }),
    isApplied: async () => false,
    applyRaw: async () => ({ code: 0, out: 'ok', err: '' }),
    removeRaw: async () => ({ code: 0, out: 'ok', err: '' }),
  });
  token = randomBytes(16).toString('hex');
  N.store.putSession(token, 3600_000);
});
after(async () => { await N?.stop(); await new Promise<void>((r) => vllm.close(() => r())); rmSync(tmp, { recursive: true, force: true }); });

const ask = (text: string, extra: Record<string, unknown> = {}) =>
  post('/api/chat', { patch_id: 'law-kr-2026', mode: 'patched', messages: [{ role: 'user', content: text }], ...extra });

interface ChatBody {
  patched: { content: string; truncated: string | null; shown_chars: number; raw_chars: number; raw_content?: string; finish_reason?: string } | null;
  benchmark_hit: boolean | null; remaining_quota: number | null;
}

// ---------------------------------------------------------------- D1
test('D1: a runaway answer comes back truncated, flagged, and with the raw text still attached', async () => {
  reply = { text: '픽셀플러스의 종목코드는 087600입니다.\n' + '0'.repeat(300), finish_reason: 'length' };
  const j = await (await ask('픽셀플러스 종목코드 알려줘')).json() as ChatBody;
  const p = j.patched!;
  assert.equal(p.truncated, 'repetition');
  assert.equal(p.raw_chars, reply.text.length);
  assert.ok(p.shown_chars < p.raw_chars, `${p.shown_chars} !< ${p.raw_chars}`);
  assert.equal(p.shown_chars, p.content.length);
  assert.equal(p.raw_content, reply.text, 'the raw answer must still be there for the "show the raw answer" toggle');
  assert.ok(p.content.includes('087600'), p.content);
  assert.ok(!p.content.includes('00000'), p.content);
  assert.equal(p.finish_reason, 'length');
});

test('D1: a normal answer is untouched and carries no raw copy', async () => {
  reply = { text: '087600입니다.', finish_reason: 'stop' };
  const p = (await (await ask('픽셀플러스 종목코드 알려줘')).json() as ChatBody).patched!;
  assert.equal(p.truncated, null);
  assert.equal(p.content, reply.text);
  assert.equal(p.shown_chars, p.raw_chars);
  assert.equal(p.raw_content, undefined);
});

test('D1: an answer cut off by the token budget says so ("length"), which is not the repetition case', async () => {
  reply = { text: '코스피는 대형 우량주 중심의 시장이고 코스닥은', finish_reason: 'length' };
  const p = (await (await ask('코스피와 코스닥의 차이를 설명해줘')).json() as ChatBody).patched!;
  assert.equal(p.truncated, 'length');
  assert.equal(p.shown_chars, p.raw_chars);
  assert.equal(p.content, reply.text);
  assert.equal(p.raw_content, undefined);
});

test('D1: the node sends the configured stop sequences, and no penalties by default', async () => {
  reply = { text: 'ok', finish_reason: 'stop' };
  bodies.length = 0;
  await ask('안녕하세요');
  const b = bodies.find((x) => x.path === '/v1/chat/completions')!;
  assert.deepEqual(b.stop, ['\n\n\n\n', '<think>']);
  assert.equal(b.repetition_penalty, undefined, 'measured harmful — must not be on by default');
  assert.equal(b.frequency_penalty, undefined);
  assert.equal(b.presence_penalty, undefined);
});

test('D1: "<think>" is dropped from the stop list when the caller asked for thinking', async () => {
  bodies.length = 0;
  await ask('안녕하세요', { thinking: true });
  const b = bodies.find((x) => x.path === '/v1/chat/completions')!;
  assert.deepEqual(b.stop, ['\n\n\n\n'], 'stopping at <think> would truncate the reasoning the caller asked for');
});

test('D1: runtime.sampling overrides the defaults, and guard:false returns the raw text', async () => {
  const rt = N.market.runtime as unknown as { cfg: { sampling?: unknown } };
  rt.cfg.sampling = { chat: { stop: ['###'], repetitionPenalty: 1.05, guard: false } };
  try {
    reply = { text: '0'.repeat(200), finish_reason: 'length' };
    bodies.length = 0;
    const p = (await (await ask('드')).json() as ChatBody).patched!;
    const b = bodies.find((x) => x.path === '/v1/chat/completions')!;
    assert.deepEqual(b.stop, ['###']);
    assert.equal(b.repetition_penalty, 1.05);
    assert.equal(p.truncated, null, 'guard:false must hand back exactly what the model said');
    assert.equal(p.content, reply.text);
  } finally { rt.cfg.sampling = undefined; }
});

test('D1: POST /api/runtime/complete returns the same structured flag, and raw:true opts out entirely', async () => {
  reply = { text: '0'.repeat(120), finish_reason: 'length' };
  bodies.length = 0;
  const guarded = await (await post('/api/runtime/complete', { prompt: '드', max_tokens: 64 }, { authorization: `Bearer ${token}` })).json() as
    { text: string; truncated: string | null; shown_chars: number; raw_chars: number; raw_text?: string };
  assert.equal(guarded.truncated, 'repetition');
  assert.ok(guarded.shown_chars < guarded.raw_chars);
  assert.equal(guarded.raw_text, reply.text);
  assert.deepEqual(bodies.find((x) => x.path === '/v1/completions')!.stop, ['\n\n', '<think>']);

  bodies.length = 0;
  const raw = await (await post('/api/runtime/complete', { prompt: '드', max_tokens: 64, raw: true }, { authorization: `Bearer ${token}` })).json() as
    { text: string; truncated: string | null };
  assert.equal(raw.truncated, null);
  assert.equal(raw.text, reply.text);
  assert.equal(bodies.find((x) => x.path === '/v1/completions')!.stop, undefined, 'raw:true must send the pre-D1 body');
});

test('D1 EXEMPTION: benchmark verification still sends the pre-guard body — no stop sequences, no guard', async () => {
  // Attestations published before and after D1 must stay comparable, so Runtime.verify() passes `sampling: null`
  // on every generation. A stop sequence could only ever cut an answer short, i.e. lower a published score.
  const rt = N.market.runtime as unknown as Record<string, unknown> & {
    verify(npz: string, bench: unknown, opts?: unknown): Promise<{ passed: boolean; score: Record<string, string>; verified_on: string }>;
  };
  const py = rt.py;
  Object.assign(rt, { py: async () => ({ code: 0, out: 'ok', err: '' }) });   // no GPU, no patch hook
  // a runaway that the CHAT path would cut in half: verification must still score the whole thing
  reply = { text: '087600' + '0'.repeat(300), finish_reason: 'length' };
  bodies.length = 0;
  try {
    const out = await rt.verify('/tmp/fake.npz', { samples: [{ prompt: '종목코드 픽셀플러스 ', expect: '087600' }] });
    const gens = bodies.filter((x) => x.path === '/v1/completions');
    assert.ok(gens.length >= 1, 'verification generated at least once');
    for (const b of gens) {
      assert.equal(b.stop, undefined, 'verification must not send stop sequences');
      assert.equal(b.repetition_penalty, undefined);
      assert.equal(b.frequency_penalty, undefined);
      assert.equal(b.presence_penalty, undefined);
      assert.equal(b.temperature, 0);
    }
    // the sample generations (the ones that produce the score) carry the exact body this node has always sent;
    // the extra generation is verify()'s liveness probe ("Q: 1+1=\nA:", 1 token), itself exempt.
    const scored = gens.filter((b) => b.prompt === '종목코드 픽셀플러스 ');
    assert.ok(scored.length >= 1, 'the sample prompt is sent exactly as stored, trailing space included (D2)');
    for (const b of scored) assert.equal(b.max_tokens, 8, 'the body this node has always sent');
    // and the guard never touched the answer: the score is measured on the model's full output
    assert.equal(out.passed, true);
    assert.equal(out.score.free_generation, '1/1');
    assert.equal(out.verified_on, `vllm:${model}`);
  } finally { Object.assign(rt, { py }); }
});

// ---------------------------------------------------------------- D2
test('D2: benchmark_hit is scored on the model\'s full answer, not on the truncated one', async () => {
  // the ticker is in the head, the loop is in the tail: the guard cuts the tail, the score must not change
  reply = { text: '087600' + '\n' + '0'.repeat(300), finish_reason: 'length' };
  const j = await (await ask('픽셀플러스 종목코드 알려줘')).json() as ChatBody;
  assert.equal(j.patched!.truncated, 'repetition');
  assert.equal(j.benchmark_hit, null, 'the synthetic test patch carries no samples — nothing to score against');
});

test('D2: a sample sent verbatim (trailing space included) matches its own sample', () => {
  const samples = [
    { prompt: '종목코드 픽셀플러스 ', expect: '087600' },
    { prompt: '종목코드 삼성전자 ', expect: '005930' },
    { prompt: 'Q: 픽셀플러스 종목코드 알려줘\nA: ', expect: '087600' },
  ];
  assert.equal(matchBenchmarkSample(samples, '종목코드 픽셀플러스 ')?.expect, '087600');
  assert.equal(matchBenchmarkSample(samples, '종목코드 픽셀플러스')?.expect, '087600', 'the trimmed chip label must still score');
  assert.equal(matchBenchmarkSample(samples, '  종목코드 삼성전자  ')?.expect, '005930');
  assert.equal(matchBenchmarkSample(samples, '종목코드 픽셀플러스 를 알려줘')?.expect, '087600');
});

test('D2: a short prompt is no longer auto-scored against an unrelated sample', () => {
  const samples = [{ prompt: '종목코드 픽셀플러스 ', expect: '087600' }];
  // every one of these used to match — "드" is the exact prompt that produced the runaway in D1 and was
  // shown to the visitor as "✗ Wrong" against a ticker it never asked about
  for (const short of ['드', '코드', '종목', ' ', '', '종목코드']) assert.equal(matchBenchmarkSample(samples, short), undefined, JSON.stringify(short));
  assert.equal(BENCH_MATCH_MIN, 8, 'the containment floor is part of the contract mirrored in the web client');
  assert.equal(matchBenchmarkSample(samples, '픽셀플러스 종목코드 알려줘'), undefined, 'a free question stays a free question');
});

// ---------------------------------------------------------------- D3
test('D3: GET /api/chat/patches reports the lock with liveness, the node clock and the queue', async () => {
  const p = await getJson<{ lock: { alive: boolean; stale: boolean; mine: boolean } | null; now: number; queue: { running: unknown; waiting: number } }>('/api/chat/patches');
  assert.equal(p.lock, null, 'idle node: no holder');
  assert.ok(Math.abs(Date.now() - p.now) < 5000, 'the client measures elapsed time against the node clock');
  assert.deepEqual(p.queue, { running: null, waiting: 0 });
});

test('D3: a lock left behind by a dead process is reported as not alive (it used to look busy for ever)', async () => {
  const dir = join(MAILBOX, '.ainize-runtime.lock');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'holder.json'), JSON.stringify({ owner: 'pid:999999', label: 'chat:krx-all-2761', since: Date.now() - 70 * 3600_000 }));
  try {
    const p = await getJson<{ lock: { owner: string; alive: boolean; stale: boolean; mine: boolean } }>('/api/chat/patches');
    assert.equal(p.lock.owner, 'pid:999999');
    assert.equal(p.lock.alive, false);
    assert.equal(p.lock.stale, true);
    assert.equal(p.lock.mine, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('D3: the second request says it is queued, names the holder, and can be cancelled for free', async () => {
  reply = { text: 'ok', finish_reason: 'stop' };
  holdGate();
  const a = ask('첫 번째 질문', { request_id: 'req-a' });
  // give A the lock before B arrives so the order is deterministic
  await new Promise((r) => setTimeout(r, 250));
  const b = ask('두 번째 질문', { request_id: 'req-b' });
  await new Promise((r) => setTimeout(r, 250));

  const sb = await getJson<{ state: string; position: number; queued_ms: number; lock: { label: string; alive: boolean; mine: boolean; since: number } | null; waiting: number; now: number }>('/api/chat/status?request_id=req-b');
  assert.equal(sb.state, 'queued');
  assert.equal(sb.position, 1);
  assert.ok(sb.queued_ms >= 0);
  assert.equal(sb.waiting, 1);
  assert.equal(sb.lock?.alive, true);
  assert.equal(sb.lock?.mine, true, 'the holder is this node itself — the UI must not claim a stranger is testing');
  assert.match(sb.lock!.label, /^chat:/);

  const sa = await getJson<{ state: string; position: number }>('/api/chat/status?request_id=req-a');
  assert.equal(sa.state, 'running');
  assert.equal(sa.position, 0);

  const cancelled = await (await post('/api/chat/cancel', { request_id: 'req-b' })).json() as { cancelled: boolean; reason: string; charged: boolean };
  assert.deepEqual(cancelled, { cancelled: true, reason: 'queued', charged: false });

  release();
  const ra = await a; const rb = await b;
  assert.equal(ra.status, 200);
  assert.equal(rb.status, 499, 'a request the visitor gave up on answers plainly, not with a hang or a 500');
  const jb = await rb.json() as { error: string; cancelled: boolean; charged: boolean };
  assert.equal(jb.cancelled, true);
  assert.equal(jb.charged, false);
  assert.match(jb.error, /cancelled while it was still queued/);

  // …and the free try really was not spent. A try is now HELD from the moment a request is admitted and handed
  // back if it does not run, so the number A reports is taken while B is still queued and holding one: it counts
  // both. B's cancellation returns its try, C takes exactly that one back, and the total consumed is still A + C —
  // so C sees the same number A did. If a cancelled request had burned its try, C would see one fewer.
  const quotaA = (await ra.json() as ChatBody).remaining_quota!;
  const rc = await (await ask('세 번째 질문', { request_id: 'req-c' })).json() as ChatBody;
  assert.equal(rc.remaining_quota, quotaA, 'the cancelled request must not have burned a free try');

  const gone = await getJson<{ state: string }>('/api/chat/status?request_id=req-b');
  assert.equal(gone.state, 'gone');
});

test('D3: cancelling a request that is already running is refused honestly', async () => {
  reply = { text: 'ok', finish_reason: 'stop' };
  holdGate();
  const a = ask('실행 중 취소', { request_id: 'req-run' });
  await new Promise((r) => setTimeout(r, 250));
  const out = await (await post('/api/chat/cancel', { request_id: 'req-run' })).json() as { cancelled: boolean; reason: string; charged: boolean };
  assert.deepEqual(out, { cancelled: false, reason: 'already_running', charged: true });
  release();
  assert.equal((await a).status, 200);
});

test('D3: an unknown or foreign request id is "gone", never someone else\'s state', async () => {
  assert.equal((await getJson<{ state: string }>('/api/chat/status?request_id=nope')).state, 'gone');
  const q = new ChatQueue();
  q.open('x', 'ip:1.2.3.4', 'chat:a');
  assert.equal(q.status('x', 'ip:9.9.9.9').state, 'gone');
  assert.deepEqual(q.cancel('x', 'ip:9.9.9.9'), { cancelled: false, reason: 'gone', charged: false });
  assert.equal(q.status('x', 'ip:1.2.3.4').state, 'queued');
  q.close('x');
  assert.equal(q.status('x', 'ip:1.2.3.4').state, 'gone');
});

test('D3: the lock file is left clean after every request', () => {
  assert.equal(existsSync(join(MAILBOX, '.ainize-runtime.lock')), false);
});

test('behind a proxy, a forwarded request is not "local" — enrolling an operator stays shut', async () => {
  /**
   * The gate that guards enrolling an operator read the TCP peer, and behind a reverse proxy the TCP peer is the
   * proxy: on ainize.ai, where nginx forwards to the node on loopback, every request on the internet passed it.
   * Anyone could have added their own address to the node's operators.
   *
   * A forwarding header is disqualifying whatever it says. It is attacker-controlled, so it cannot establish
   * trust — but its presence is evidence in the one direction that is safe: something proxied this, so the peer
   * address is not the caller's.
   */
  const post = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${N.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' });

  const direct = await (await fetch(`${N.url}/api/auth/me`)).json() as { canEnroll: boolean };
  assert.equal(direct.canEnroll, true, 'a direct loopback caller is local');

  for (const h of [{ 'x-forwarded-for': '203.0.113.7' }, { 'x-real-ip': '203.0.113.7' }, { forwarded: 'for=203.0.113.7' }]) {
    const me = await (await fetch(`${N.url}/api/auth/me`, { headers: h })).json() as { canEnroll: boolean };
    assert.equal(me.canEnroll, false, `${Object.keys(h)[0]} means a proxy was in the path`);
    const r = await post('/api/auth/enroll', h);
    assert.equal(r.status, 403, `${Object.keys(h)[0]}: enrolment refused`);
    assert.match((await r.json() as { error: string }).error, /enroll_local_only/);
  }

  // And the refusal names the way in for whoever this turns away, rather than leaving them with a closed door.
  const r = await post('/api/auth/enroll', { 'x-forwarded-for': '203.0.113.7' });
  assert.match((await r.json() as { error: string }).error, /setup-token/);
});
