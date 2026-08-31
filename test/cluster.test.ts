/**
 * Three in-process nodes on the local ledger: A sells, B and C verify (quorum 2) → LISTED;
 * C buys via HTTP 402 (local-credit, signed intent) → settlement with lineage royalty → blob download;
 * conflict detection & supersede; branch subscription + gateway routing.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, type NodeConfig } from '@ngram/core';
import { startNode, type RunningNode } from '../src/server.js';
import { seedDemo, synthPatch } from '../src/seed.js';

const tmp = mkdtempSync(join(tmpdir(), 'ngram-test-'));
const mk = (name: string, port: number, peers: string[], roles: NodeConfig['roles']): NodeConfig => {
  const cfg = defaultConfig({ home: join(tmp, name), name, port, peers, roles, ledger: 'local' });
  cfg.runtime = { repo: undefined, api: 'http://127.0.0.1:1' };   // no runtime in tests → hash-only attestations
  cfg.gossipIntervalMs = 300;
  cfg.verifier = { quorum: 2, stake: '5', allowSelfAttest: false, intervalMs: 400 };
  cfg.publicUrl = `http://127.0.0.1:${port}`;
  cfg.host = '127.0.0.1';
  return cfg;
};

let A: RunningNode, B: RunningNode, C: RunningNode;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => Promise<T>, pred: (v: T) => boolean, ms = 15000): Promise<T> {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (pred(v)) return v; if (Date.now() - t0 > ms) return v; await sleep(200); }
}

before(async () => {
  A = await startNode(mk('A', 34021, [], ['seller', 'verifier']), { quiet: true, serveWeb: false });
  B = await startNode(mk('B', 34022, ['http://127.0.0.1:34021'], ['verifier']), { quiet: true, serveWeb: false });
  C = await startNode(mk('C', 34023, ['http://127.0.0.1:34021'], ['verifier', 'serving']), { quiet: true, serveWeb: false });
});
after(async () => { await Promise.all([A, B, C].map((n) => n?.stop())); rmSync(tmp, { recursive: true, force: true }); });

test('seed: prototype ledger imports and synthetic patches are announced', async () => {
  const rep = await seedDemo(A.market, { real: false, synthetic: true, prototype: true });
  assert.equal(rep.imported_prototype, 7);
  assert.ok(rep.created.includes('law-kr-2025'));
  const cat = await A.market.catalog(true);
  assert.ok(!cat.find((e) => e.anchor.id === 'krx-all'), 'prototype-shaped records are not surfaced as catalog entries');
  assert.equal(cat.find((e) => e.anchor.id === 'law-kr-2025')?.status, 'ANNOUNCED');
});

test('gossip replicates records to peers and verifiers reach quorum → LISTED', async () => {
  const listed = await waitFor(() => A.market.catalog(true), (c) => c.find((e) => e.anchor.id === 'law-kr-2025')?.status === 'LISTED', 30000);
  const e = listed.find((x) => x.anchor.id === 'law-kr-2025')!;
  assert.equal(e.status, 'LISTED', JSON.stringify(e.attestations));
  assert.ok(e.attestations.every((a) => a.verified_on === 'hash-only' && a.passed));
  assert.ok(new Set(e.attestations.map((a) => a.verifier)).size >= 2);
  // C also sees it
  const onC = await waitFor(() => C.market.catalog(true), (c) => c.find((x) => x.anchor.id === 'law-kr-2025')?.status === 'LISTED');
  assert.equal(onC.find((x) => x.anchor.id === 'law-kr-2025')?.status, 'LISTED');
  const v = await B.ledger.verify();
  assert.ok(v.valid, v.errors.join(','));
});

test('conflict detection: KR and US law patches overlap; 2026 supersedes 2025 after listing', async () => {
  const conflicts = await A.market.conflicts('law-kr-2025');
  assert.ok(conflicts.some((c) => c.patch_id === 'law-us-2025' && c.overlap_rows > 0 && c.same_schema));
  await waitFor(() => A.market.catalog(true), (c) => c.find((e) => e.anchor.id === 'law-kr-2026')?.status === 'LISTED', 30000);
  await A.market.reconcileSupersedes();
  const cat = await waitFor(() => A.market.catalog(true), (c) => c.find((e) => e.anchor.id === 'law-kr-2025')?.status === 'SUPERSEDED', 10000);
  assert.equal(cat.find((e) => e.anchor.id === 'law-kr-2025')?.status, 'SUPERSEDED');
  assert.ok(cat.find((e) => e.anchor.id === 'law-kr-2026')?.supersedes.includes('law-kr-2025'));
});

test('x402: GET without payment → 402 with requirements; C buys with signed credit intent; royalty flows to ancestor', async () => {
  const r = await fetch(`${A.url}/x402/patch/law-kr-2026`);
  assert.equal(r.status, 402);
  assert.ok(r.headers.get('x-payment-required'));
  const body = await r.json() as { requirements: { scheme: string; payTo: string; maxAmountRequired: string }[] };
  assert.equal(body.requirements[0].scheme, 'local-credit');
  assert.equal(body.requirements[0].payTo, A.cfg.identity.address);

  await waitFor(() => C.market.catalog(true), (c) => c.find((e) => e.anchor.id === 'law-kr-2026')?.quorum_ok === true);
  const before = await C.market.creditBalance(C.cfg.identity.address);
  const res = await C.market.buy('law-kr-2026');
  assert.equal(res.scheme, 'local-credit');
  assert.ok(res.steps.some((s) => s.step === '402'));
  assert.ok(res.steps.some((s) => s.step === 'download'));
  assert.ok(C.market.blobs.has(res.manifest.patch_sha256));
  const setts = await A.ledger.settlements('law-kr-2026');
  assert.equal(setts.length, 1);
  const royalty = setts[0].body.royalty;
  // law-kr-2026 → law-kr-2025 → law-common-base : all authored by A in the seed, so A receives the whole amount
  assert.equal(Object.keys(royalty).length, 1);
  assert.equal(Number(royalty[A.cfg.identity.address]), 2.5);
  const after = await waitFor(() => C.market.creditBalance(C.cfg.identity.address), (b) => b < before);
  assert.equal(Math.round((before - after) * 1000) / 1000, 2.5);
  // replay is rejected
  const replay = await fetch(`${A.url}/x402/patch/law-kr-2026`, { headers: { 'x-payment': 'garbage' } });
  assert.equal(replay.status, 402);
  // buyer can now download the blob directly with identity auth
  const { authHeader } = await import('../src/p2p.js');
  const dl = await fetch(`${A.url}/p2p/blob/${res.manifest.patch_sha256}`, { headers: { 'x-ngram-auth': authHeader(C.cfg.identity, `blob:${res.manifest.patch_sha256}`) } });
  assert.equal(dl.status, 200);
  const anon = await fetch(`${A.url}/p2p/blob/${res.manifest.patch_sha256}`);
  assert.equal(anon.status, 402);
});

test('branches: subscribe on C, gateway routes jurisdiction=KR to C', async () => {
  await waitFor(() => C.market.branches(), (b) => b.some((x) => x.name === 'law/KR'));
  await C.market.subscribe('law/KR', 'subscribe');
  const route = await waitFor(() => A.market.route({ jurisdiction: 'KR' }), (r) => r.nodes.some((n) => n.address === C.cfg.identity.address), 10000);
  assert.equal(route.branch?.name, 'law/KR');
  assert.ok(route.nodes.some((n) => n.address === C.cfg.identity.address));
  const none = await A.market.route({ jurisdiction: 'FR' });
  assert.equal(none.branch, null);
});

test('public API surface', async () => {
  const info = await (await fetch(`${A.url}/api/info`)).json() as { node: { address: string }; ledger: { kind: string }; quorum: number };
  assert.equal(info.node.address, A.cfg.identity.address);
  assert.equal(info.ledger.kind, 'local');
  const cat = await (await fetch(`${A.url}/api/catalog?sort=popular`)).json() as { total: number; items: { anchor: { id: string } }[] };
  assert.ok(cat.total >= 4);
  const one = await (await fetch(`${A.url}/api/patches/law-kr-2026`)).json() as { lineage: { parents: { id: string }[] }; conflicts: unknown[] };
  assert.equal(one.lineage.parents[0].id, 'law-kr-2025');
  const me = await (await fetch(`${A.url}/api/me/patches`)).json() as { error?: string };
  assert.equal(me.error, 'operator login required');
  const graph = await (await fetch(`${A.url}/api/ledger/graph`)).json() as { edges: { type: string }[] };
  assert.ok(graph.edges.some((e) => e.type === 'extends'));
});

test('visibility: hidden test anchors and private drafts never surface next to public knowledge; draft errors are 400/409; `forget` drops a body', async () => {
  const dir = join(tmp, 'vis');
  const base = (await A.market.entry('law-kr-2026'))!;
  const basePath = A.market.blobs.get(base.anchor.patch_sha256)!.path;
  // both bodies share half their addresses with law-kr-2026 → they overlap it; a different schema keeps them out of the supersede logic
  const hiddenFile = synthPatch(dir, 'vis-hidden-child', 4242, 200, basePath);
  const draftFile = synthPatch(dir, 'vis-private-draft', 4343, 200, basePath);
  const bench = { schema: 'vis-test', queries: 10, format: ['template'] };
  const hidden = await A.market.createDraft({ id: 'vis-hidden-child', name: 'hidden child', model: { id_M: 'demo-ngram-1b' }, benchmark: bench, file: hiddenFile, keepInPlace: true, parents: ['law-kr-2026'], visibility: 'test' });
  await A.market.announce('vis-hidden-child');
  await A.market.createDraft({ id: 'vis-private-draft', name: 'private draft', model: { id_M: 'demo-ngram-1b' }, benchmark: bench, file: draftFile, keepInPlace: true, parents: ['law-kr-2026'] });
  assert.ok((await A.market.entryMap()).get('law-kr-2026')!.children.includes('vis-hidden-child'), 'internally the lineage resolves (royalties)');
  assert.ok((await A.market.conflicts('law-kr-2026')).some((c) => c.patch_id === 'vis-hidden-child'), 'internally the overlap is known (supersede checks)');

  type Detail = { lineage: { parents: { id: string }[]; children: { id: string }[] }; conflicts: { patch_id: string }[] };
  const anon = await (await fetch(`${A.url}/api/patches/law-kr-2026`)).json() as Detail;
  assert.deepEqual(anon.lineage.children.map((c) => c.id).filter((id) => id.startsWith('vis-')), [], 'visitor: no hidden child / draft under "derived from this"');
  assert.ok(!anon.conflicts.some((c) => c.patch_id.startsWith('vis-')), 'visitor: overlap check lists public knowledge only');
  const conf = await (await fetch(`${A.url}/api/patches/law-kr-2026/conflicts`)).json() as { conflicts: { patch_id: string }[] };
  assert.ok(!conf.conflicts.some((c) => c.patch_id.startsWith('vis-')));

  const setup = await (await fetch(`${A.url}/api/auth/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'test-pass-a' }) })).json() as { token: string };
  const op = { authorization: `Bearer ${setup.token}` };
  const mine = await (await fetch(`${A.url}/api/patches/law-kr-2026`, { headers: op })).json() as Detail;
  assert.ok(mine.lineage.children.some((c) => c.id === 'vis-private-draft'), 'operator sees their own draft');
  assert.ok(!mine.lineage.children.some((c) => c.id === 'vis-hidden-child'), 'hidden test anchors stay hidden even for the operator (same rule as the catalog)');
  assert.ok(mine.conflicts.some((c) => c.patch_id === 'vis-private-draft') && !mine.conflicts.some((c) => c.patch_id === 'vis-hidden-child'));
  const own = await (await fetch(`${A.url}/api/patches/vis-hidden-child`)).json() as Detail;
  assert.equal(own.lineage.parents[0]?.id, 'law-kr-2026', 'a hidden anchor still resolves by id and shows its public origin');

  // visitors count knowledge files of public knowledge only
  const info = await (await fetch(`${A.url}/api/info`)).json() as { node: { blobs: string[] } };
  assert.ok(A.market.blobs.has(hidden.patch_sha256));
  assert.ok(!info.node.blobs.includes(hidden.patch_sha256) && info.node.blobs.includes(base.anchor.patch_sha256));
  const nodes = await (await fetch(`${A.url}/api/nodes`)).json() as { nodes: { address: string; blobs: string[] }[] };
  assert.ok(!nodes.nodes.find((n) => n.address === A.cfg.identity.address)!.blobs.includes(hidden.patch_sha256));
  const p2p = await (await fetch(`${A.url}/p2p/info`)).json() as { blobs: string[] };
  assert.ok(p2p.blobs.includes(hidden.patch_sha256), 'peers (verifiers) still learn where every body is held');

  // draft creation errors carry a real status
  const post = (body: Record<string, unknown>) => fetch(`${A.url}/api/patches`, { method: 'POST', headers: { ...op, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const dup = await post({ id: 'law-kr-2026', name: 'dup', model_id: 'demo-ngram-1b', benchmark: JSON.stringify(bench), path: draftFile });
  assert.equal(dup.status, 409);
  assert.deepEqual(await dup.json(), { error: 'patch id already exists: law-kr-2026' });
  const bad = await post({ id: '!!', name: 'bad id', model_id: 'demo-ngram-1b', benchmark: JSON.stringify(bench), path: draftFile });
  assert.equal(bad.status, 400);
  assert.match(((await bad.json()) as { error: string }).error, /^invalid patch id/);
  const parent = await post({ id: 'vis-orphan', name: 'orphan', model_id: 'demo-ngram-1b', benchmark: JSON.stringify(bench), path: draftFile, parents: 'no-such-parent' });
  assert.equal(parent.status, 400);
  assert.equal((await fetch(`${A.url}/api/patches/nope`, { method: 'DELETE', headers: op })).status, 404);

  // forget: the body leaves this node, the record stays; drafts / unknown ids are refused
  const forget = await fetch(`${A.url}/api/patches/vis-hidden-child/forget`, { method: 'POST', headers: op });
  assert.equal(forget.status, 200);
  const fr = await forget.json() as { sha256: string; deleted_file: boolean; also_affects: string[] };
  assert.equal(fr.sha256, hidden.patch_sha256);
  assert.equal(fr.deleted_file, false, 'in-place files are deregistered, not deleted');
  assert.ok(!A.market.blobs.has(hidden.patch_sha256));
  assert.notEqual((await A.market.entry('vis-hidden-child'))?.status, undefined, 'the ledger record is untouched');
  assert.equal((await fetch(`${A.url}/api/patches/vis-hidden-child/forget`, { method: 'POST', headers: op })).status, 404);
  assert.equal((await fetch(`${A.url}/api/patches/vis-private-draft/forget`, { method: 'POST', headers: op })).status, 409);
  assert.equal((await fetch(`${A.url}/api/patches/vis-hidden-child/forget`, { method: 'POST' })).status, 401);
  A.market.deleteDraft('vis-private-draft');
});
