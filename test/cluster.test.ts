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
import { seedDemo } from '../src/seed.js';

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

test('teach PR-1: contributors on a draft, catalog filters, /api/info fields, data provider paid from the seller remainder', async () => {
  const { synthPatch } = await import('../src/seed.js');
  const TEACHER = '0x' + 'ab'.repeat(20);
  const file = synthPatch(join(tmp, 'synth'), 'lesson', 777, 64);
  const bench = { schema: 'taught/lesson-abc123', queries: 1, format: ['template'] };
  await assert.rejects(A.market.createDraft({ name: 'bad-shares', model: { id_M: 'M' }, benchmark: bench, file, keepInPlace: true, contributors: [
    { address: TEACHER, share: 0.6, role: 'data_provider', proof: 'declared' }, { address: '0x' + 'cd'.repeat(20), share: 0.5, role: 'data_provider', proof: 'declared' },
  ] }), /more than 1/);
  const anchor = await A.market.createDraft({ id: 'taught-lesson', name: 'Taught lesson', model: { id_M: 'M' }, benchmark: bench, price: '10', file, keepInPlace: true,
    origin: 'teach', contributors: [{ address: TEACHER, share: 0.7, role: 'data_provider', proof: 'declared', name: 'Visitor' }] });
  assert.equal(anchor.origin, 'teach');
  assert.equal(anchor.contributors?.[0].share, 0.7);
  const updated = A.market.updateDraft('taught-lesson', { contributors: [{ ...anchor.contributors![0], name: 'Kim' }], visibility: 'public' });
  assert.equal(updated.contributors?.[0].name, 'Kim');
  assert.throws(() => A.market.updateDraft('taught-lesson', { contributors: Array.from({ length: 5 }, (_, i) => ({ address: '0x' + String(i).repeat(40), share: 0.1, role: 'data_provider' as const, proof: 'declared' as const })) }), /at most 4/);
  await A.market.announce('taught-lesson');

  const info = await (await fetch(`${A.url}/api/info`)).json() as { accepts_contributions: boolean; contributor_share: number; royalty_share: number };
  assert.equal(info.accepts_contributions, false, 'teach.enabled defaults to false');
  assert.equal(info.contributor_share, 0.7);
  assert.equal(info.royalty_share, 0.3);
  const byC = await (await fetch(`${A.url}/api/catalog?contributor=${TEACHER.toUpperCase().replace('0X', '0x')}`)).json() as { total: number; items: { anchor: { id: string; contributors?: { name: string }[] } }[] };
  assert.equal(byC.total, 1);
  assert.equal(byC.items[0].anchor.id, 'taught-lesson');
  assert.equal(byC.items[0].anchor.contributors?.[0].name, 'Kim');
  assert.equal(((await (await fetch(`${A.url}/api/catalog?origin=teach`)).json()) as { total: number }).total, 1);
  assert.equal(((await (await fetch(`${A.url}/api/catalog?contributor=0x${'00'.repeat(20)}`)).json()) as { total: number }).total, 0);
  const docs = await (await fetch(`${A.url}/api/openapi.json`)).json() as { components: { schemas: Record<string, unknown> }; paths: Record<string, { get?: { parameters?: { name: string }[] } }> };
  assert.ok(docs.components.schemas.Contributor);
  assert.ok(docs.paths['/api/catalog'].get?.parameters?.some((p) => p.name === 'contributor'));

  // no benchmark samples → hash-only attestations list it; C buys → the settle record pays the data provider (no settlement code change)
  await waitFor(() => C.market.catalog(true), (c) => c.find((e) => e.anchor.id === 'taught-lesson')?.quorum_ok === true, 30000);
  const before = await A.market.creditBalance(TEACHER);
  await C.market.buy('taught-lesson');
  const setts = await A.ledger.settlements('taught-lesson');
  assert.equal(setts.length, 1);
  assert.deepEqual(setts[0].body.royalty, { [TEACHER]: '7', [A.cfg.identity.address]: '3' });
  const after = await waitFor(() => A.market.creditBalance(TEACHER), (b) => b > before, 10000);
  assert.equal(Math.round((after - before) * 1000) / 1000, 7);
});
