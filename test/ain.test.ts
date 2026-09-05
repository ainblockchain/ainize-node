/**
 * AIN-ledger end-to-end against the local dev chain (docker, http://localhost:8081). Skips when unreachable.
 * Two nodes with real AIN identities: A (seller, app admin) and B (verifier, quorum 1 for speed);
 * anchor = knowledge.explore + market mirror, attestation under rule-guarded path, purchase with a real
 * AIN transfer verified from the chain, settlement + access receipt readable by anyone.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AinLedger, ainReachable, defaultConfig, fundFromGenesis, type NodeConfig } from '@ngram/core';
import { startNode, type RunningNode } from '../src/server.js';
import { synthPatch } from '../src/seed.js';

const PROVIDER = process.env.AIN_PROVIDER_URL ?? 'http://localhost:8081';
const up = await ainReachable(PROVIDER);
const tmp = mkdtempSync(join(tmpdir(), 'ngram-ain-'));
const mk = (name: string, port: number, peers: string[], roles: NodeConfig['roles']): NodeConfig => {
  const cfg = defaultConfig({ home: join(tmp, name), name, port, peers, roles, ledger: 'ain', ainProviderUrl: PROVIDER });
  cfg.runtime = { repo: undefined, api: 'http://127.0.0.1:1' };
  cfg.gossipIntervalMs = 500;
  // this suite publishes `visibility: 'test'` anchors and expects them verified (item 332 makes that opt-in)
  cfg.verifier = { quorum: 1, allowSelfAttest: false, intervalMs: 800, includeTest: true };
  cfg.publicUrl = `http://127.0.0.1:${port}`; cfg.host = '127.0.0.1';
  cfg.includeTestAnchors = true;
  return cfg;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => Promise<T>, pred: (v: T) => boolean, ms = 60000): Promise<T> {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (pred(v)) return v; if (Date.now() - t0 > ms) return v; await sleep(500); }
}

let A: RunningNode, B: RunningNode;
before(async () => {
  if (!up) return;
  const cfgA = mk('A', 34033, [], ['seller', 'verifier']);   // 3403x: 34031 is chat.test.ts, 34037 is guard-api.test.ts
  const cfgB = mk('B', 34034, ['http://127.0.0.1:34033'], ['verifier']);
  await fundFromGenesis(PROVIDER, cfgA.identity.address, 500);
  await fundFromGenesis(PROVIDER, cfgB.identity.address, 500);
  // app + market rules (idempotent — the chain may already have the app from an earlier run)
  const setupLedger = new AinLedger({ providerUrl: PROVIDER, chainId: 0 }, cfgA.identity);
  const setup = await setupLedger.setupApp();
  if (!setup.created && setup.admin && setup.admin !== cfgA.identity.address) {
    // someone else is admin (e.g. earlier smoke test with the genesis key) — use the genesis admin to (re)apply rules
    const { LOCAL_GENESIS } = await import('@ngram/core');
    const admin = new AinLedger({ providerUrl: PROVIDER, chainId: 0 }, { address: LOCAL_GENESIS.address, privateKey: LOCAL_GENESIS.privateKey, publicKey: '' });
    await admin.setupApp();
  }
  A = await startNode(cfgA, { quiet: true, serveWeb: false });
  B = await startNode(cfgB, { quiet: true, serveWeb: false });
});
after(async () => { await Promise.all([A, B].map((n) => n?.stop())); rmSync(tmp, { recursive: true, force: true }); });

const RUN = Date.now().toString(36);
/** Seeds the synthetic bodies so no two runs publish identical bytes to the shared dev chain (see the test below). */
const SEED = Date.now() % 2_000_000_000;
const baseId = `ain-e2e-base-${RUN}`;
const childId = `ain-e2e-child-${RUN}`;

test('AIN ledger: anchor → knowledge graph entry + market mirror, verifier attests under rule, LISTED', { skip: !up }, async () => {
  const dir = join(tmp, 'synth');
  // Per-run seeds. The AIN dev chain is shared and permanent, so a fixed seed puts the SAME bytes on the record
  // under a different identity every run — and `duplicate_body` (item 363) rightly refuses the second publisher.
  const f1 = synthPatch(dir, 'base', SEED, 600);
  const f2 = synthPatch(dir, 'child', SEED + 1, 400, f1);
  const bench = { schema: `e2e-${RUN}`, queries: 4, format: ['template'] };   // no samples → integrity attestation suffices in tests
  await A.market.createDraft({ id: baseId, name: 'e2e base', model: { id_M: 'demo-ngram-1b' }, benchmark: bench, file: f1, keepInPlace: true, price: '3', topic_path: 'e2e/base', visibility: 'test' });
  await A.market.announce(baseId);
  await A.market.createDraft({ id: childId, name: 'e2e child', model: { id_M: 'demo-ngram-1b' }, benchmark: bench, file: f2, keepInPlace: true, price: '2', topic_path: 'e2e/child', parents: [baseId], visibility: 'test' });
  await A.market.announce(childId);
  const onChain = await (A.ledger as AinLedger).getValue(`/apps/knowledge/market/patches/${baseId}`);
  assert.equal(onChain?.author, A.cfg.identity.address);
  assert.ok(onChain?.entry_id, 'entry id recorded');
  const child = await (A.ledger as AinLedger).getValue(`/apps/knowledge/market/patches/${childId}`);
  assert.deepEqual(child?.parents, [baseId]);
  const graph = await (A.ledger as AinLedger).graph();
  const childNode = Object.keys(graph.nodes).find((k) => k.endsWith(child.entry_id));
  assert.ok(childNode, 'child knowledge-graph node exists');
  const edges = graph.edges[childNode!] ?? {};
  assert.ok(Object.values(edges).some((e: any) => e.type === 'extends'), 'lineage is an `extends` edge in the ain-js knowledge graph');
  const cat = await waitFor(() => B.market.catalog(true), (c) => c.find((e) => e.anchor.id === childId)?.status === 'LISTED', 90000);
  let e = cat.find((x) => x.anchor.id === childId)!;
  assert.equal(e.status, 'LISTED', JSON.stringify(e.attestations));
  // The dev chain is shared with whatever else watches this app (the demo cluster's verifiers do), and a verifier only
  // picks up ANNOUNCED/VERIFYING items — so with quorum 1 someone else can list it before B's round reaches it. Ask B
  // directly in that case: the point of the assertion is that B's attestation is accepted under the rule, not that B
  // happened to be first.
  if (!e.attestations.some((a) => a.verifier === B.cfg.identity.address)) {
    await B.verifier!.verifyOne(e.anchor);
    e = (await waitFor(() => B.market.catalog(true), (c) => !!c.find((x) => x.anchor.id === childId)?.attestations.some((a) => a.verifier === B.cfg.identity.address), 30000))
      .find((x) => x.anchor.id === childId)!;
  }
  assert.ok(e.attestations.some((a) => a.verifier === B.cfg.identity.address), `B attested: ${JSON.stringify(e.attestations.map((a) => a.verifier))}`);
  // B cannot forge an attestation as A: rule rejects
  const r = await (B.ledger as AinLedger).ain.db.ref(`/apps/knowledge/market/attestations/${childId}/${A.cfg.identity.address}`).setValue({ value: { passed: true }, nonce: -1 });
  assert.ok(r?.result?.code !== 0 || /rule/i.test(r?.result?.message ?? ''), 'rule engine rejected forged attestation');
});

test('AIN x402: B buys with a real AIN transfer; seller verifies tx on chain; settlement + royalty on chain', { skip: !up }, async () => {
  const cat = await waitFor(() => B.market.catalog(true), (c) => c.find((e) => e.anchor.id === childId)?.status === 'LISTED', 60000);
  const target = cat.find((e) => e.anchor.id === childId)!;
  const balA0 = await (A.ledger as AinLedger).balance();
  const balB0 = await (B.ledger as AinLedger).balance();
  const res = await B.market.buy(target.anchor.id);
  assert.equal(res.scheme, 'ain-transfer');
  assert.match(res.tx_hash, /^0x[0-9a-f]{64}$/);
  const tr = await (A.ledger as AinLedger).verifyTransfer(res.tx_hash);
  assert.ok(tr && tr.to === A.cfg.identity.address && tr.value === Number(target.anchor.price));
  await sleep(2500);
  const setts = await waitFor(() => (A.ledger as AinLedger).settlements(target.anchor.id), (s) => s.length >= 1, 30000);
  assert.equal(setts[0].body.buyer, B.cfg.identity.address);
  const royalty = setts[0].body.royalty as Record<string, number>;
  // Item 325: the verifiers that keep it on sale are paid out of the seller side, and here the only verifier IS the
  // buyer — so B's balance falls by the price and rises again by its own verifier fee. Assert against the split the
  // record actually names rather than against the price alone.
  const backToB = Object.entries(royalty).filter(([a]) => a.toLowerCase() === B.cfg.identity.address.toLowerCase()).reduce((t, [, v]) => t + Number(v), 0);
  const balB1 = await (B.ledger as AinLedger).balance();
  assert.ok(balB0 - balB1 >= Number(target.anchor.price) - backToB - 1e-6, `buyer paid (${balB0} → ${balB1}, price ${target.anchor.price}, verifier fee back ${backToB})`);
  const balA1 = await (A.ledger as AinLedger).balance();
  assert.ok(balA1 > balA0 - 1e-6, 'seller received');
  assert.ok(B.market.blobs.has(target.anchor.patch_sha256));
  const onChain = await (B.ledger as AinLedger).getValue(`/apps/knowledge/market/settlements/${target.anchor.id}`);
  assert.ok(onChain && Object.keys(onChain).length >= 1, 'settlement visible on chain to anyone');
  // royalty: base and child share the author (A), so A keeps the lineage side; the verifier lines are B's alone
  assert.ok(Object.keys(royalty).some((a) => a.toLowerCase() === A.cfg.identity.address.toLowerCase()), 'author paid');
  assert.deepEqual(
    Object.keys(royalty).map((a) => a.toLowerCase()).sort(),
    [A.cfg.identity.address.toLowerCase(), B.cfg.identity.address.toLowerCase()].sort(),
    'the author and the one verifier are the only recipients',
  );
});
