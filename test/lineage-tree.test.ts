/**
 * Lineage L6 — the family tree, the demand signals and the open questions
 * (docs/lineage-teach-design.md §5.5, §5.6, §10, §12.5; scenarios AZ-284 … AZ-289).
 *
 * Everything here is a CONTRACT test: no model is asked anything, nothing is trained. What is proved is that the
 * tree cannot loop or leak, that a number is never reported outside the scope it was measured in, and that a
 * question can be counted without the node keeping what was asked.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, type BenchmarkSpec, type CatalogEntry, type NodeConfig, type Settlement } from '@ngram/core';
import { startNode, type RunningNode } from '../src/server.js';
import { Store } from '../src/store.js';
import { questionKey } from '../src/teach-dataset.js';
import { writeFixture, ROW_DIM } from './fixtures/fake-hook.js';
import type { LineageTree } from '../src/market.js';

const tmp = mkdtempSync(join(tmpdir(), 'ngram-tree-test-'));
const PORT = 34073;                 // 34065 (lineage), 34071 (runtime-stack) and 34051 (payouts) are taken
const url = `http://127.0.0.1:${PORT}`;
let N: RunningNode;
let opToken = '';

const bench = (q: string): BenchmarkSpec => ({ schema: `fam/${q}`, metric: 'exact', threshold: 1, queries: 2, format: ['template'], samples: [{ prompt: `${q} `, expect: 'a1' }, { prompt: `${q}-2 `, expect: 'a2' }] });
const value = (a: bigint, d: number) => Number(a % 97n) + d / 100;
const file = (name: string, from: number, n: number) => {
  const p = join(tmp, `${name}.npz`);
  writeFixture(p, Array.from({ length: n }, (_, i) => BigInt(from + i)), value, (a, d) => value(a, d) + 1);
  return p;
};

const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(`${url}${path}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* not json */ }
  return { status: r.status, json, text };
};
const op = () => ({ authorization: `Bearer ${opToken}` });

before(async () => {
  const cfg: NodeConfig = defaultConfig({ home: join(tmp, 'N'), name: 'TREE', port: PORT, peers: [], roles: ['seller'], ledger: 'local' });
  // Never the shared model server: a test node built from defaultConfig() would otherwise use the shipped
  // runtime.api (localhost:8002) and reach whatever engine is running on this machine.
  cfg.runtime = { ...cfg.runtime, repo: undefined, api: 'http://127.0.0.1:1', hookApi: 'http://127.0.0.1:1' };
  cfg.verifier = { ...(cfg.verifier ?? {}), auto: false } as NodeConfig['verifier'];
  N = await startNode(cfg, { quiet: true, serveWeb: false });
  const setup = await api('POST', '/api/auth/setup', { password: 'tree-pass' });
  opToken = String(setup.json.token);

  const model = { id_M: 'demo-ngram-1b', row_dim: ROW_DIM };
  // A ← B ← C, and D combines A and C: a diamond, so the walk meets A twice by two different routes.
  const a = await N.market.createDraft({ id: 'fam-a', name: 'Base A', model, benchmark: bench('a'), file: file('a', 1000, 40), keepInPlace: true });
  const b = await N.market.createDraft({
    id: 'fam-b', name: 'Add-on B', model, benchmark: bench('b'), file: file('b', 1020, 40), keepInPlace: true, parents: ['fam-a'],
    base: { stack: [{ patch_id: 'fam-a', patch_sha256: a.patch_sha256 }], export: 'delta', pre_state_sha256: 'a'.repeat(64) },
    derivation: { kind: 'extend', bases: [{ patch_id: 'fam-a', patch_sha256: a.patch_sha256, rows: 40 }], added_rows: 7, changed_rows: 2, removed_rows: 1 },
  });
  const c = await N.market.createDraft({
    id: 'fam-c', name: 'Correction C', model, benchmark: bench('c'), file: file('c', 1040, 40), keepInPlace: true, parents: ['fam-b'],
    derivation: { kind: 'contradict', bases: [{ patch_id: 'fam-b', patch_sha256: b.patch_sha256, rows: 40 }], added_rows: 0, changed_rows: 5, removed_rows: 0 },
  });
  await N.market.createDraft({
    id: 'fam-d', name: 'Combined D', model, benchmark: bench('d'), file: file('d', 1060, 40), keepInPlace: true, parents: ['fam-a', 'fam-c'],
    derivation: { kind: 'merge', bases: [{ patch_id: 'fam-a', patch_sha256: a.patch_sha256, rows: 40 }, { patch_id: 'fam-c', patch_sha256: c.patch_sha256, rows: 40 }], added_rows: 3, changed_rows: 0, removed_rows: 0 },
  });
  // a pre-lineage child: a declared parent, no `derivation` — the legacy chip case (§14)
  await N.market.createDraft({ id: 'fam-legacy', name: 'Declared child', model, benchmark: bench('l'), file: file('l', 1080, 40), keepInPlace: true, parents: ['fam-a'] });
  for (const id of ['fam-a', 'fam-b', 'fam-c', 'fam-d', 'fam-legacy']) await N.market.announce(id);
  // and one that stays a private draft — a stranger must not learn it exists
  await N.market.createDraft({ id: 'fam-secret', name: 'Unannounced child', model, benchmark: bench('s'), file: file('s', 1100, 40), keepInPlace: true, parents: ['fam-a'] });
});

after(async () => {
  await N?.stop();
  rmSync(tmp, { recursive: true, force: true });
});

test('AZ-284 the tree names every relation for what it is, and what each knowledge added', async () => {
  const r = await api('GET', '/api/patches/fam-b/tree?depth=4');
  assert.equal(r.status, 200);
  const tree = r.json as unknown as LineageTree;
  const ids = tree.nodes.map((n) => n.id).sort();
  assert.deepEqual(ids, ['fam-a', 'fam-b', 'fam-c', 'fam-d'], 'ancestors and descendants, not the whole catalogue');
  const kind = (from: string, to: string) => tree.edges.find((e) => e.from === from && e.to === to)?.kind;
  assert.equal(kind('fam-a', 'fam-b'), 'extend');
  assert.equal(kind('fam-b', 'fam-c'), 'contradict');
  assert.equal(kind('fam-c', 'fam-d'), 'merge');
  const b = tree.nodes.find((n) => n.id === 'fam-b')!;
  assert.deepEqual({ q: b.added.questions, c: b.added.changed, r: b.added.removed }, { q: 7, c: 2, r: 1 });
  assert.equal(b.added.new, b.added.rows, 'a delta export wrote every one of its rows itself');
  assert.equal(b.export, 'delta');
  assert.deepEqual(b.base_stack, ['fam-a']);
  assert.equal(tree.nodes.find((n) => n.id === 'fam-b')!.depth, 0, 'the knowledge asked about is depth 0');
  assert.ok(tree.nodes.find((n) => n.id === 'fam-a')!.depth < 0, 'an ancestor is above');
  assert.ok(tree.nodes.find((n) => n.id === 'fam-c')!.depth > 0, 'a derivative is below');
  assert.equal(tree.family.knowledges, 4);
  // the money line is the real splitter's answer, and it does not fold a credited teacher into "the lineage"
  assert.equal(tree.money.seller_pct + tree.money.lineage_pct + tree.money.contributor_pct, 100, 'a unit sale is fully accounted for');
  // Every anchor here was published by this node with nobody credited on it, so one sale of B pays nobody for the
  // ancestry — and the line names nobody rather than naming an ancestor beside a 0 %. AZ-294 is the paying case.
  assert.deepEqual(tree.money.lineage_names, [], 'the names are the ancestors whose creators are actually paid');
  assert.equal(tree.money.lineage_pct, 0);
  // the diamond: D reaches A through C, and A appears ONCE
  const fromA = await api('GET', '/api/patches/fam-a/tree?depth=8');
  const t2 = fromA.json as unknown as LineageTree;
  assert.equal(t2.nodes.filter((n) => n.id === 'fam-a').length, 1, 'a knowledge reached twice is one node, not two');
  assert.equal(t2.edges.filter((e) => e.from === 'fam-a' && e.to === 'fam-d').length, 1);
  // a declared parent is not a claim that anything was trained on top of it
  const legacy = t2.nodes.find((n) => n.id === 'fam-legacy')!;
  assert.equal(legacy.legacy, true);
  assert.equal(t2.edges.find((e) => e.to === 'fam-legacy')?.kind, 'declared');
});

test('AZ-285 the tree is depth-capped and cycle-safe, and hides what the caller may not see', async () => {
  // depth: from A, C is two hops down and D three
  const shallow = (await api('GET', '/api/patches/fam-a/tree?depth=1')).json as unknown as LineageTree;
  assert.deepEqual(shallow.nodes.map((n) => n.id).sort(), ['fam-a', 'fam-b', 'fam-d', 'fam-legacy'], 'D lists A as a parent too, so it is one hop away');
  assert.ok(!shallow.nodes.some((n) => n.id === 'fam-c'), 'C is two hops down and the cap holds');
  assert.equal(shallow.truncated, true, 'the walk says it stopped with more to see');
  assert.equal((await api('GET', '/api/patches/fam-a/tree?depth=9')).status, 400, 'the cap is 8 hops, and asking for more is refused rather than silently clamped');

  // a private draft is not a fact a stranger may learn
  const anon = (await api('GET', '/api/patches/fam-a/tree?depth=4')).json as unknown as LineageTree;
  assert.ok(!anon.nodes.some((n) => n.id === 'fam-secret'), 'a stranger is not told an unannounced child exists');
  const operator = (await api('GET', '/api/patches/fam-a/tree?depth=4', undefined, op())).json as unknown as LineageTree;
  assert.ok(operator.nodes.some((n) => n.id === 'fam-secret'), 'the operator sees their own draft');

  // a cycle, and an ancestor this node has never heard of — both from a peer's anchors, so both are built by hand
  const real = await N.market.entryMap();
  const clone = (id: string, parents: string[]): CatalogEntry => {
    const src = real.get('fam-a')!;
    return { ...src, anchor: { ...src.anchor, id, name: id, parents }, children: [], superseded_by: [], supersedes: [] };
  };
  const fake = new Map<string, CatalogEntry>();
  fake.set('cyc-1', clone('cyc-1', ['cyc-2']));
  fake.set('cyc-2', clone('cyc-2', ['cyc-1', 'never-seen']));
  (N.market as unknown as { entryMap: () => Promise<Map<string, CatalogEntry>> }).entryMap = async () => fake;
  try {
    const cyc = await N.market.lineageTree('cyc-1', { depth: 8 });
    assert.deepEqual(cyc.nodes.map((n) => n.id).sort(), ['cyc-1', 'cyc-2', 'never-seen'], 'the walk terminates and names the unknown ancestor');
    assert.equal(cyc.nodes.find((n) => n.id === 'never-seen')!.missing, true, 'an ancestor nobody here holds is a placeholder, not a hole');
  } finally {
    (N.market as unknown as { entryMap?: unknown }).entryMap = Object.getPrototypeOf(N.market).entryMap;
  }
});

test('AZ-286 signals keep their scope, and a sale that was not a sale is not counted', async () => {
  const r = await api('GET', '/api/patches/fam-a/signals');
  assert.equal(r.status, 200);
  const s = r.json as { network: Record<string, unknown>; node: Record<string, unknown> };
  assert.equal(s.network.scope, 'network');
  assert.equal(s.node.scope, 'node');
  assert.equal(s.node.window_days, 30, 'the node half says how far back it looks');
  assert.equal(s.network.built_on, 3, 'B, the merge and the declared child — the unannounced draft is NOT counted');
  assert.equal(s.network.sales_all, 0, 'nothing was bought — and that is reported as 0, not as the network average');

  // the exclusion rule itself (§10): a free download and the author buying from itself are not demand
  const entry = (await N.market.entryMap()).get('fam-a')!;
  const settle = (buyer: string, amount: string, ago = 0): Settlement => ({ patch_id: 'fam-a', seller: entry.anchor.author, buyer, amount, currency: 'AIN', scheme: 'local-credit', tx_hash: 't', royalty: {}, billing: 'per_download', created_at: Date.now() - ago });
  const withSales = { ...entry, settlements: [settle('0xbuyer', '25'), settle('0xother', '0'), settle(entry.anchor.author, '25'), settle('0xold', '25', 40 * 86_400_000)] };
  assert.deepEqual(N.market.salesOf(withSales), { sales_all: 2, sales_30d: 1 });
});

test('AZ-287 a question is counted without being kept, and shared only when someone said so', async () => {
  const s = new Store(':memory:');
  const k = 'cluster-abc';
  s.bumpIssue('p', 'free_wrong', k, { visitor: 'v:1' });
  s.bumpIssue('p', 'free_wrong', k, { visitor: 'v:1' });
  let i = s.listIssues('p')[0];
  assert.equal(i.count, 2);
  assert.equal(i.people, 1, 'one person asking twice is one person');
  assert.equal(i.text, null, 'nothing was consented to, so nothing is stored');

  s.bumpIssue('p', 'free_wrong', k, { text: 'what is the ticker of pixelplus?', visitor: 'v:2' });
  i = s.listIssues('p')[0];
  assert.equal(i.count, 3);
  assert.equal(i.people, 2);
  assert.equal(i.text, 'what is the ticker of pixelplus?', 'the person who shared it decided that, not the node');
  s.bumpIssue('p', 'free_wrong', k, { visitor: 'v:3' });
  assert.equal(s.listIssues('p')[0].text, 'what is the ticker of pixelplus?', 'a later count-only report never un-shares it');

  // the lifecycle: a child that answers the question closes it, and it stops being an open question
  s.bumpIssue('p', 'preflight', 'cluster-xyz', { visitor: 'v:4' });
  assert.equal(s.coverIssues('p', [k, 'not-asked'], 'child-1'), 1);
  assert.equal(s.listIssues('p').length, 1, 'only the still-open one');
  assert.equal(s.listIssues('p', { status: 'covered' })[0].status, 'covered_by:child-1');
  assert.equal(s.coverIssues('p', [k], 'child-2'), 0, 'a closed question is not closed twice');
  s.close();
});

test('AZ-288 open questions are public as counts, and a request is a buyer\'s own text to share or not', async () => {
  const before = (await api('GET', '/api/patches/fam-a/issues')).json as { total: number };
  assert.equal(before.total, 0);

  const quiet = await api('POST', '/api/patches/fam-a/issues', { text: 'does it cover biotech tickers?', share: false });
  assert.equal(quiet.status, 201);
  assert.equal(quiet.json.shared, false);
  const loud = await api('POST', '/api/patches/fam-a/issues', { text: 'what about KOSDAQ delistings?', share: true });
  assert.equal(loud.status, 201);
  assert.equal(loud.json.shared, true);

  const list = (await api('GET', '/api/patches/fam-a/issues')).json as { total: number; counts: Record<string, number>; items: { kind: string; text: string | null; count: number }[] };
  assert.equal(list.total, 2);
  assert.equal(list.counts.request, 2);
  const texts = list.items.map((x) => x.text);
  assert.ok(texts.includes('what about KOSDAQ delistings?'), 'the one that was shared reads as it was written');
  assert.ok(texts.includes(null), 'the one that was not is a count with no wording');

  // asking the same thing again is the same question, and the count says so
  await api('POST', '/api/patches/fam-a/issues', { text: 'does it cover  biotech tickers? ', share: false });
  const again = (await api('GET', '/api/patches/fam-a/issues')).json as { total: number; items: { text: string | null; count: number }[] };
  assert.equal(again.total, 2, 'whitespace is not a different question (F13)');
  assert.equal(again.items.find((x) => x.text === null)!.count, 2);
  assert.equal(questionKey('does it cover  biotech tickers? '), questionKey('does it cover biotech tickers?'));

  // it also shows up as demand on the shelf, labelled as this node's
  const shelves = (await api('GET', '/api/explore/shelves')).json as { asked: { topic: string; count: number }[]; scope: Record<string, string> };
  assert.equal(shelves.scope.asked, 'node');
  assert.ok(shelves.asked.some((a) => a.count >= 3), 'the requests are on the "asked for" shelf');
});

test('AZ-289 "mark wrong" carries no question — the node already knows which turn it was', async () => {
  // A call that cannot name a turn this visitor asked records nothing, for any knowledge.
  const bad = await api('POST', '/api/chat/feedback', { turn_id: 'not-a-turn-of-mine', share: true });
  assert.equal(bad.status, 404);
  assert.match(String(bad.json.error), /turn_unknown/);
  assert.equal(((await api('GET', '/api/patches/fam-b/issues')).json as { total: number }).total, 0);

  // A fake serving model, so the turn is real and nothing is measured: what is under test is the consent, not an answer.
  const rt = N.market.runtime as unknown as Record<string, unknown>;
  const saved = { status: rt.status, isApplied: rt.isApplied, applyRaw: rt.applyRaw, removeRaw: rt.removeRaw, chat: rt.chat };
  Object.assign(rt, {
    status: async () => ({ available: true, api: 'fake', model: 'demo-ngram-1b', hook: true, repo: null, applied: [] }),
    isApplied: async () => false,
    applyRaw: async () => ({ code: 0, out: 'ok', err: '' }),
    removeRaw: async () => ({ code: 0, out: 'ok', err: '' }),
    chat: async () => ({ content: 'something else entirely', latency_ms: 1, model: 'demo-ngram-1b' }),
  });
  try {
    // a question the knowledge PUBLISHES, answered wrongly → its own miss, recorded by the live test itself
    const own = await api('POST', '/api/chat', { patch_ids: ['fam-b'], mode: 'patched', messages: [{ role: 'user', content: 'b ' }], max_tokens: 8 });
    assert.equal(own.status, 200);
    const ownTurn = String(own.json.turn_id);
    assert.match(ownTurn, /^[0-9a-f]{18}$/);
    let list = (await api('GET', '/api/patches/fam-b/issues')).json as { items: { kind: string; sample_index: number | null; text: string | null }[] };
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].kind, 'own_miss');
    assert.equal(list.items[0].sample_index, 0, 'kept as an index into the record, not as a copy of the prompt');
    assert.equal(list.items[0].text, 'b ', 'read back off the anchor at request time — the question was already public');

    // a free question: *Count only* records it with no wording anywhere
    const free = await api('POST', '/api/chat', { patch_ids: ['fam-b'], mode: 'patched', messages: [{ role: 'user', content: 'does it know about biotech?' }], max_tokens: 8 });
    const freeTurn = String(free.json.turn_id);
    const quiet = await api('POST', '/api/chat/feedback', { turn_id: freeTurn, share: false });
    assert.equal(quiet.status, 200);
    assert.equal(quiet.json.shared, false);
    assert.equal((quiet.json.items as { shared: boolean }[])[0].shared, false);
    list = (await api('GET', '/api/patches/fam-b/issues')).json as { items: { kind: string; sample_index: number | null; text: string | null }[] };
    assert.equal(list.items.find((x) => x.kind === 'free_wrong')!.text, null, 'counted, and not kept');

    // the same visitor, same question, this time shared: now — and only now — the wording is stored
    const again = await api('POST', '/api/chat', { patch_ids: ['fam-b'], mode: 'patched', messages: [{ role: 'user', content: 'does it know about biotech?' }], max_tokens: 8 });
    const loud = await api('POST', '/api/chat/feedback', { turn_id: String(again.json.turn_id), share: true });
    assert.equal(loud.status, 200);
    list = (await api('GET', '/api/patches/fam-b/issues')).json as { items: { kind: string; count: number; text: string | null }[] };
    const freeItem = list.items.find((x) => x.kind === 'free_wrong')!;
    assert.equal(freeItem.text, 'does it know about biotech?');
    assert.equal(freeItem.count, 2, 'the two reports are the same question');

    // a feedback call may not name a knowledge that was not loaded for that turn
    const wrongPatch = await api('POST', '/api/chat/feedback', { turn_id: ownTurn, patch_ids: ['fam-a'], share: true });
    assert.equal(wrongPatch.status, 400);
    assert.match(String(wrongPatch.json.error), /no_patch/);
    assert.equal(((await api('GET', '/api/patches/fam-a/issues?kind=free_wrong')).json as { total: number }).total, 0);
  } finally {
    Object.assign(rt, saved);
  }
});

test('AZ-294 the creator of the knowledge underneath is paid for being built on — even when one node published both', async () => {
  // The shape every teaching node has: the NODE is the author of both anchors and the person who taught each one
  // is credited on it. If "the lineage" were read off the authors alone, both anchors would have the same author
  // and the base's teacher would appear as if they were paid for the child's own work.
  const model = { id_M: 'demo-ngram-1b', row_dim: ROW_DIM };
  const teacherOfBase = '0x1111111111111111111111111111111111111111';
  const teacherOfChild = '0x2222222222222222222222222222222222222222';
  const p = await N.market.createDraft({
    id: 'pay-base', name: 'Paid base', model, benchmark: bench('pb'), file: file('pb', 2000, 20), keepInPlace: true,
    contributors: [{ address: teacherOfBase, name: 'Base teacher', role: 'data_provider', share: 0.7 }],
  });
  await N.market.createDraft({
    id: 'pay-child', name: 'Paid child', model, benchmark: bench('pc'), file: file('pc', 2020, 20), keepInPlace: true, parents: ['pay-base'],
    contributors: [{ address: teacherOfChild, name: 'Child teacher', role: 'data_provider', share: 0.7 }],
    derivation: { kind: 'extend', bases: [{ patch_id: 'pay-base', patch_sha256: p.patch_sha256, rows: 20 }], added_rows: 4, changed_rows: 0, removed_rows: 0 },
  });
  for (const id of ['pay-base', 'pay-child']) await N.market.announce(id);

  const tree = (await api('GET', '/api/patches/pay-child/tree')).json as unknown as LineageTree;
  const paid = tree.money.recipients.find((r) => r.address.toLowerCase() === teacherOfBase);
  assert.ok(paid, 'the base’s teacher is on the split of the child’s sale');
  assert.equal(paid!.kind, 'lineage', 'they are paid because their knowledge was built on, not for teaching this one');
  assert.equal(paid!.for_name, 'Paid base', 'and the line says which knowledge that money is for');
  assert.equal(tree.money.recipients.find((r) => r.address.toLowerCase() === teacherOfChild)!.kind, 'contributor');
  assert.deepEqual(tree.money.lineage_names, ['Paid base']);
  assert.ok(tree.money.lineage_pct > 0, 'a sale of the child pays the creator of what it was built on');
  assert.equal(Math.round((tree.money.seller_pct + tree.money.lineage_pct + tree.money.contributor_pct) * 10) / 10, 100, 'a unit sale is fully accounted for');

  // …and on the base itself there is no lineage to pay: its own teacher is a contributor, and only that
  const own = (await api('GET', '/api/patches/pay-base/tree')).json as unknown as LineageTree;
  assert.equal(own.money.lineage_pct, 0);
  assert.deepEqual(own.money.lineage_names, []);
  assert.equal(own.money.recipients.find((r) => r.address.toLowerCase() === teacherOfBase)!.kind, 'contributor');
});

test('AZ-296 a newer version sits beside the knowledge, not above it — and the knowledge asked about is always depth 0', async () => {
  // The demo cluster's own shape, and the one this got wrong: krx-all-2761 lists its previous epoch as a PARENT and
  // also supersedes it. Walking up put the parent at −1, and then the parent's `superseded_by` dragged the ROOT up
  // to −1 with it: the page drew the knowledge you are looking at in the ancestors' row.
  const real = await N.market.entryMap();
  const src = real.get('fam-a')!;
  const make = (id: string, parents: string[], supersedes: string[] = [], superseded_by: string[] = []): CatalogEntry =>
    ({ ...src, anchor: { ...src.anchor, id, name: id, parents }, children: [], supersedes, superseded_by });
  const fake = new Map<string, CatalogEntry>([
    ['v2', make('v2', ['v1'], ['v1', 'other'])],
    ['v1', make('v1', [], [], ['v2'])],
    ['other', make('other', [], [], ['v2'])],   // replaced by v2 without ever being its parent
  ]);
  (N.market as unknown as { entryMap: () => Promise<Map<string, CatalogEntry>> }).entryMap = async () => fake;
  try {
    const t = await N.market.lineageTree('v2', { depth: 8 });
    assert.equal(t.nodes.find((n) => n.id === 'v2')!.depth, 0, 'the knowledge asked about is where the reader is standing');
    assert.equal(t.nodes.find((n) => n.id === 'v1')!.depth, -1, 'it is also the parent, and stays one hop up');
    assert.equal(t.nodes.find((n) => n.id === 'other')!.depth, 0, 'a version it replaced is a sibling, not an ancestor');
    assert.ok(t.edges.some((e) => e.from === 'v1' && e.to === 'v2' && e.kind === 'version'));
    assert.ok(t.edges.some((e) => e.from === 'other' && e.to === 'v2' && e.kind === 'version'));
  } finally {
    (N.market as unknown as { entryMap?: unknown }).entryMap = Object.getPrototypeOf(N.market).entryMap;
  }
});

test('AZ-299 knowledge kept for another context is a track of its parent, and the tree says which track it is on', async () => {
  // §5.5: a child on a different track is not a correction of its parent — the two are meant to coexist (claim 17),
  // so the edge is `track` and the node carries the track's name rather than being drawn as a newer version.
  const model = { id_M: 'demo-ngram-1b', row_dim: ROW_DIM };
  await N.market.createDraft({ id: 'trk-child', name: 'For the KR desk', model, benchmark: bench('tk'), file: file('tk', 3000, 20), keepInPlace: true, parents: ['fam-a'], branch: 'kr-desk' });
  await N.market.announce('trk-child');
  await N.market.createBranch('kr-desk', 'the Korean desk’s answers', { desk: 'kr' }, ['trk-child']);

  const t = (await api('GET', '/api/patches/fam-a/tree?depth=2')).json as unknown as LineageTree;
  const edge = t.edges.find((e) => e.to === 'trk-child');
  assert.equal(edge?.kind, 'track', 'a different context is a track, not a correction and not a plain declared parent');
  const node = t.nodes.find((n) => n.id === 'trk-child')!;
  assert.equal(node.branch, 'kr-desk');
  assert.deepEqual(node.tracks, ['kr-desk'], 'and the tree names the track it is subscribed on');
  assert.equal(t.nodes.find((n) => n.id === 'fam-a')!.tracks?.length ?? 0, 0);
});
