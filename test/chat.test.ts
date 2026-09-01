/**
 * ChatMode multi-knowledge (spec §6.3): one lock label, base = all removed, patched = applyRaw in list order
 * (last one wins), restore in reverse, one usage event per patch. The runtime is faked in-process (no GPU).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIdentity, defaultConfig, type NodeConfig } from '@ngram/core';
import type { ChatMessage, ChatResult } from '../src/runtime.js';
import { startNode, type RunningNode } from '../src/server.js';
import { seedDemo } from '../src/seed.js';
import { authHeader } from '../src/p2p.js';

const tmp = mkdtempSync(join(tmpdir(), 'ngram-chat-test-'));
const PORT = 34031;
let N: RunningNode;

/** What the fake serving model has loaded right now (npz path → order of application) and the call log. */
const table = new Map<string, number>();
let seq = 0;
const calls: string[] = [];
const labels: string[] = [];
const pathToId = new Map<string, string>();
/** Every conversation the fake model was handed, in call order (base call first in compare mode). */
const seen: ChatMessage[][] = [];
const idOf = (path: string) => pathToId.get(path) ?? path;

before(async () => {
  const cfg: NodeConfig = defaultConfig({ home: join(tmp, 'N'), name: 'N', port: PORT, peers: [], roles: ['seller', 'verifier', 'serving'], ledger: 'local' });
  cfg.runtime = { repo: undefined, api: 'http://127.0.0.1:1' };
  cfg.host = '127.0.0.1'; cfg.publicUrl = `http://127.0.0.1:${PORT}`;
  cfg.verifier = { quorum: 1, stake: '5', allowSelfAttest: true, intervalMs: 300 };
  cfg.gossipIntervalMs = 60_000;
  N = await startNode(cfg, { quiet: true, serveWeb: false });
  await seedDemo(N.market, { real: false, synthetic: true });
  for (const e of await N.market.catalog(true)) { const b = N.market.blobs.get(e.anchor.patch_sha256); if (b) pathToId.set(b.path, e.anchor.id); }
  // Fake runtime: same surface market.chat() uses; `exclusive` keeps the real serialisation but records the label.
  const rt = N.market.runtime as unknown as Record<string, unknown>;
  const realExclusive = (rt.exclusive as (label: string, fn: () => Promise<unknown>) => Promise<unknown>).bind(N.market.runtime);
  Object.assign(rt, {
    status: async () => ({ available: true, api: 'fake', model: 'demo-ngram-1b', hook: true, repo: null, applied: [] }),
    isApplied: async (p: string) => table.has(p),
    applyRaw: async (p: string) => { calls.push(`apply:${idOf(p)}`); table.set(p, ++seq); return { code: 0, out: 'ok', err: '' }; },
    removeRaw: async (p: string) => { calls.push(`remove:${idOf(p)}`); table.delete(p); return { code: 0, out: 'ok', err: '' }; },
    chat: async (m: ChatMessage[]): Promise<ChatResult> => {
      const loaded = [...table.entries()].sort((a, b) => a[1] - b[1]).map(([p]) => idOf(p));
      calls.push(`chat[${loaded.join(',')}]`);
      seen.push(m.map((x) => ({ role: x.role, content: x.content })));
      return { content: loaded.length ? `loaded=${loaded.join('+')}` : 'base', latency_ms: 1, model: 'demo-ngram-1b' };
    },
    exclusive: (label: string, fn: () => Promise<unknown>) => { labels.push(label); return realExclusive(label, fn); },
  });
});
after(async () => { await N?.stop(); rmSync(tmp, { recursive: true, force: true }); });

const msgs: ChatMessage[] = [{ role: 'user', content: '한국법 개정?' }];
const usageEvents = () => N.store.events({ kind: 'usage', limit: 50 });

test('single patch keeps the old response shape and adds patch_ids / applied[] / benchmark_hits', async () => {
  calls.length = 0;
  const r = await N.market.chat({ patchIds: ['law-kr-2026'], messages: msgs, mode: 'compare', visitor: 'ip:test' });
  assert.equal(r.patch_id, 'law-kr-2026');
  assert.deepEqual(r.patch_ids, ['law-kr-2026']);
  assert.equal(r.base?.content, 'base');
  assert.equal(r.patched?.content, 'loaded=law-kr-2026');
  assert.equal(r.was_applied, false);
  assert.ok(typeof r.applied_ms === 'number');
  assert.deepEqual(r.applied.map((a) => a.patch_id), ['law-kr-2026']);
  assert.deepEqual(r.benchmark_hits, { 'law-kr-2026': null });   // synthetic patches carry no samples
  assert.equal(r.benchmark_hit, null);
  assert.equal(table.size, 0, 'table restored');
  assert.deepEqual(calls, ['chat[]', 'apply:law-kr-2026', 'chat[law-kr-2026]', 'remove:law-kr-2026']);
});

test('three patches: one lock label, apply in list order, restore in reverse, one usage event per patch', async () => {
  calls.length = 0; labels.length = 0;
  const before = usageEvents().length;
  const ids = ['law-kr-2025', 'law-us-2025', 'law-kr-2026'];
  const r = await N.market.chat({ patchIds: ids, messages: msgs, mode: 'compare', visitor: 'ip:test' });
  assert.deepEqual(labels, ['chat:law-kr-2025+law-us-2025+law-kr-2026']);
  assert.deepEqual(r.patch_ids, ids);
  assert.equal(r.patched?.content, 'loaded=law-kr-2025+law-us-2025+law-kr-2026', 'last one applied last → wins on overlap');
  assert.deepEqual(calls, [
    'chat[]',
    'apply:law-kr-2025', 'apply:law-us-2025', 'apply:law-kr-2026',
    'chat[law-kr-2025,law-us-2025,law-kr-2026]',
    'remove:law-kr-2026', 'remove:law-us-2025', 'remove:law-kr-2025',
  ]);
  assert.equal(table.size, 0);
  assert.equal(r.applied.length, 3);
  assert.ok(r.applied.every((a) => typeof a.applied_ms === 'number' && a.was_applied === false));
  assert.equal(r.applied_ms, r.applied.reduce((s, a) => s + (a.applied_ms ?? 0), 0), 'applied_ms is the sum');
  assert.deepEqual(Object.keys(r.benchmark_hits), ids);
  const ev = usageEvents();
  assert.equal(ev.length - before, 3, 'one usage event per patch');
  const mine = ev.slice(0, 3).map((e) => e.patch_id).sort();
  assert.deepEqual(mine, [...ids].sort());
  for (const e of ev.slice(0, 3)) assert.deepEqual((e.data as { patch_ids: string[] }).patch_ids, ids);
});

test('operator-pinned patch: base removes it, patched re-applies in list order, restore puts it back', async () => {
  const kr = N.market.blobs.get((await N.market.entry('law-kr-2025'))!.anchor.patch_sha256)!.path;
  table.set(kr, ++seq);                                       // pinned by the operator before the test
  calls.length = 0;
  const r = await N.market.chat({ patchIds: ['law-us-2025', 'law-kr-2025'], messages: msgs, mode: 'compare', visitor: 'ip:test' });
  assert.equal(r.base?.content, 'base', 'base answer has the pinned patch removed');
  assert.equal(r.patched?.content, 'loaded=law-us-2025+law-kr-2025');
  assert.deepEqual(r.applied.map((a) => a.was_applied), [false, true]);
  assert.equal(r.was_applied, false, 'was_applied mirrors the first id');
  assert.deepEqual(calls, [
    'remove:law-kr-2025', 'chat[]',
    'apply:law-us-2025', 'apply:law-kr-2025', 'chat[law-us-2025,law-kr-2025]',
    'remove:law-us-2025',                                     // drop what we added (reverse)
    'apply:law-kr-2025',                                      // re-assert the pinned one after an overlapping removal
  ]);
  assert.deepEqual([...table.keys()], [kr], 'pinned patch is back, nothing else');
  // patched-only with everything already loaded → nothing re-applied (fast path), nothing to restore
  calls.length = 0;
  const r2 = await N.market.chat({ patchIds: ['law-kr-2025'], messages: msgs, mode: 'patched', visitor: 'ip:test' });
  assert.deepEqual(calls, ['chat[law-kr-2025]']);
  assert.equal(r2.applied_ms, null); assert.equal(r2.was_applied, true);
  table.delete(kr);
});

test('validation: 0 or >3 ids, duplicates collapse, unknown id, missing body', async () => {
  await assert.rejects(N.market.chat({ patchIds: [], messages: msgs, mode: 'base', visitor: 'v' }), /patch_id or patch_ids required/);
  await assert.rejects(N.market.chat({ patchIds: ['a', 'b', 'c', 'd'], messages: msgs, mode: 'base', visitor: 'v' }), /at most 3/);
  await assert.rejects(N.market.chat({ patchIds: ['nope'], messages: msgs, mode: 'base', visitor: 'v' }), /patch not found: nope/);
  const r = await N.market.chat({ patchIds: ['law-kr-2026', 'law-kr-2026'], messages: msgs, mode: 'base', visitor: 'v' });
  assert.deepEqual(r.patch_ids, ['law-kr-2026']);
});

test('HTTP: patch_id OR patch_ids (exactly one); /api/chat/patches carries applied[], overlaps[] and lessons[] with a teach signature', async () => {
  const url = `http://127.0.0.1:${PORT}`;
  const post = (body: unknown) => fetch(`${url}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post({ mode: 'base', messages: msgs })).status, 400);
  assert.equal((await post({ patch_id: 'law-kr-2026', patch_ids: ['law-kr-2025'], mode: 'base', messages: msgs })).status, 400);
  assert.equal((await post({ patch_ids: ['a', 'b', 'c', 'd'], mode: 'base', messages: msgs })).status, 400);
  const one = await post({ patch_id: 'law-kr-2026', mode: 'patched', messages: msgs });
  assert.equal(one.status, 200);
  const j1 = await one.json() as { patch_id: string; patch_ids: string[]; applied: unknown[]; benchmark_hit: null; benchmark_hits: Record<string, null>; remaining_quota: number };
  assert.equal(j1.patch_id, 'law-kr-2026'); assert.deepEqual(j1.patch_ids, ['law-kr-2026']); assert.equal(j1.applied.length, 1);
  const two = await post({ patch_ids: ['law-kr-2025', 'law-us-2025'], mode: 'patched', messages: msgs });
  assert.equal(two.status, 200);
  const j2 = await two.json() as typeof j1 & { patched: { content: string } };
  assert.equal(j2.patched.content, 'loaded=law-kr-2025+law-us-2025');
  assert.equal(j2.applied.length, 2);

  const p = await (await fetch(`${url}/api/chat/patches`)).json() as { items: { anchor: { id: string } }[]; applied: string[]; overlaps: { a: string; b: string; rows: number }[]; lessons?: unknown[]; teacher?: string };
  assert.deepEqual(p.applied, []);
  assert.equal(p.lessons, undefined, 'no lessons without a signature');
  assert.ok(p.overlaps.some((o) => o.rows > 0 && [o.a, o.b].includes('law-kr-2025') && [o.a, o.b].includes('law-us-2025')), JSON.stringify(p.overlaps));
  // operator pins a patch → applied[] lists it
  N.store.setApplied('law-kr-2026', 'sha', 'test');
  const p2 = await (await fetch(`${url}/api/chat/patches`)).json() as typeof p;
  assert.deepEqual(p2.applied, ['law-kr-2026']);
  N.store.clearApplied('law-kr-2026');
  // a visitor signature (purpose `teach`) adds the (still empty) lessons[] and the verified address
  const id = createIdentity();
  const p3 = await (await fetch(`${url}/api/chat/patches`, { headers: { 'x-ngram-auth': authHeader(id, 'teach') } })).json() as typeof p;
  assert.deepEqual(p3.lessons, []);
  assert.equal(p3.teacher, id.address);
  const p4 = await (await fetch(`${url}/api/chat/patches`, { headers: { 'x-ngram-auth': authHeader(id, 'blob:x') } })).json() as typeof p;
  assert.equal(p4.lessons, undefined, 'a signature for another purpose is ignored');
});

/**
 * Finding 1 — compare mode must not feed the patched answer back to the un-patched model. Each column replays its
 * OWN earlier answers; both end with the same new question, and the node reports what it replayed.
 */
test('compare mode: messages_base and messages_patched are two conversations, one question', async () => {
  const q = { role: 'user' as const, content: '2026 개정?' };
  const basePast: ChatMessage[] = [{ role: 'user', content: '2025 개정?' }, { role: 'assistant', content: 'I do not know.' }, q];
  const patchedPast: ChatMessage[] = [{ role: 'user', content: '2025 개정?' }, { role: 'assistant', content: 'Article 12 was amended.' }, q];
  seen.length = 0;
  const r = await N.market.chat({ patchIds: ['law-kr-2026'], messages: patchedPast, messagesBase: basePast, messagesPatched: patchedPast, mode: 'compare', visitor: 'ip:test' });
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0], basePast, 'the base column replays the base answer');
  assert.deepEqual(seen[1], patchedPast, 'the patched column replays the patched answer');
  assert.deepEqual(r.history, { base: 3, patched: 3, split: true });
  // no split sent → both columns get `messages` (old clients keep working)
  seen.length = 0;
  const r2 = await N.market.chat({ patchIds: ['law-kr-2026'], messages: patchedPast, mode: 'compare', visitor: 'ip:test' });
  assert.deepEqual(seen[0], patchedPast);
  assert.deepEqual(seen[1], patchedPast);
  assert.equal(r2.history.split, false);

  // HTTP: the two arrays must end with the same question, or it is not a comparison
  const url = `http://127.0.0.1:${PORT}`;
  const post = (body: unknown) => fetch(`${url}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const ok = await post({ patch_id: 'law-kr-2026', mode: 'compare', messages: patchedPast, messages_base: basePast, messages_patched: patchedPast });
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json() as { history: unknown }).history, { base: 3, patched: 3, split: true });
  const bad = await post({ patch_id: 'law-kr-2026', mode: 'compare', messages: patchedPast, messages_base: [{ role: 'user', content: 'a different question' }] });
  assert.equal(bad.status, 400);
  assert.match(JSON.stringify(await bad.json()), /messages_base must end with the same message/);
});
