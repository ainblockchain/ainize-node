/**
 * The runtime stack (docs/lineage-teach-design.md §5.4, §8) against a FAKE hook: the real `scripts/patch.py`, the
 * real npz round-trip, the real `prev` the hook returns — only the table is a Map instead of a served model.
 *
 * What is proved here is the promise the owner asked for ("teach on top of someone else's knowledge"): an add-on may
 * only be written when the knowledge it was trained on is underneath it row for row, and taking the add-on off puts
 * that knowledge back — not the bare model.
 *
 * Scenarios AZ-253 … AZ-257 (docs/ux-test-scenarios.json). The live-hook run of the same sequence is AZ-258.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bf16Bits, defaultConfig, preStateSha256, readNpzMember, sha256Hex, type BenchmarkSpec, type NodeConfig } from '@ainize/core';
import { startNode, type RunningNode } from '../src/server.js';
import { FakeHook, baseValue, writeFixture, ROW_DIM } from './fixtures/fake-hook.js';

/** The reference implementation this node drives; without it there is no patch.py to test. */
const REF_REPO = process.env.AINIZE_RUNTIME_REPO ?? '/mnt/newdata/qwen3.8';
const HAVE_REF = existsSync(join(REF_REPO, 'scripts', 'patch.py')) && existsSync(join(REF_REPO, 'engram', 'live.py'));

const tmp = mkdtempSync(join(tmpdir(), 'ngram-stack-test-'));
const repo = join(tmp, 'repo');
const mailbox = join(repo, 'ple_patch');
const PORT = 24077;   // 24071 belongs to dispute.test.ts; `node --test` runs the files in one pool, so a shared constant is a hard EADDRINUSE, not a flake
let N: RunningNode;
let hook: FakeHook;
let model: Server;
/** Called on every completion the node asks the (fake) model for — the probe point of AZ-258. */
let onGenerate: (() => void) | null = null;

// ---------------------------------------------------------------- fixtures (values are bf16-exact by construction)
const range = (from: number, n: number) => Array.from({ length: n }, (_, i) => BigInt(from + i));
const P_ADDRS = range(1000, 100);            // the base
const C_ADDRS = range(1050, 100);            // the add-on: 50 rows on top of the base, 50 of its own
const L1_ADDRS = range(3000, 50);            // two pre-lineage knowledges that happen to overlap
const L2_ADDRS = range(3025, 50);
const pAfter = (a: bigint, d: number) => baseValue(a, d) + 7;
const cBefore = (a: bigint, d: number) => (P_ADDRS.includes(a) ? pAfter(a, d) : baseValue(a, d));
const cAfter = (a: bigint, d: number) => cBefore(a, d) + 3;
const l1After = (a: bigint, d: number) => baseValue(a, d) + 5;
const l2After = (a: bigint, d: number) => baseValue(a, d) + 9;

const files = {
  parent: join(tmp, 'parent.npz'), child: join(tmp, 'child.npz'),
  legacy1: join(tmp, 'legacy1.npz'), legacy2: join(tmp, 'legacy2.npz'),
};
const bench: BenchmarkSpec = { metric: 'exact', threshold: 1, samples: [{ prompt: 'q ', expect: 'a' }] };

/** What the live table holds at (addr, d), as bf16 bits — the only thing an assertion may compare. */
const holds = (a: bigint, v: (a: bigint, d: number) => number) => Array.from({ length: 4 }, (_, d) => hook.word(a, d * 40)).join(',') === Array.from({ length: 4 }, (_, d) => bf16Bits(v(a, d * 40))).join(',');

before(async () => {
  if (!HAVE_REF) return;
  mkdirSync(mailbox, { recursive: true });
  cpSync(join(REF_REPO, 'scripts'), join(repo, 'scripts'), { recursive: true });
  cpSync(join(REF_REPO, 'engram'), join(repo, 'engram'), { recursive: true });
  hook = new FakeHook(mailbox).start();

  writeFixture(files.parent, P_ADDRS, baseValue, pAfter);
  writeFixture(files.child, C_ADDRS, cBefore, cAfter);
  writeFixture(files.legacy1, L1_ADDRS, baseValue, l1After);
  writeFixture(files.legacy2, L2_ADDRS, baseValue, l2After);

  model = createServer((req, res) => {
    // A generation is the one moment the live table is being MEASURED: AZ-258 reads it here to prove a verification
    // is scored on the candidate alone and not on whatever this node happens to serve.
    if (req.url !== '/v1/models') onGenerate?.();
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url === '/v1/models' ? { data: [{ id: 'demo-ainize-1b' }] } : { choices: [{ text: 'a', message: { content: 'a' } }] }));
  });
  await new Promise<void>((r) => model.listen(0, '127.0.0.1', () => r()));
  const api = `http://127.0.0.1:${(model.address() as { port: number }).port}`;

  const cfg: NodeConfig = defaultConfig({ home: join(tmp, 'N'), name: 'STACK', port: PORT, peers: [], roles: ['seller', 'serving'], ledger: 'local' });
  // Never the shared model server: a test node built from defaultConfig() would otherwise use the shipped
  // runtime.api (localhost:8002) and reach whatever engine is running on this machine.
  cfg.runtime = { ...cfg.runtime, repo: undefined, api: 'http://127.0.0.1:1', hookApi: 'http://127.0.0.1:1' };
  cfg.runtime = { repo, api, patchDir: mailbox, python: 'python3' };
  cfg.verifier = { ...(cfg.verifier ?? {}), auto: false } as NodeConfig['verifier'];
  N = await startNode(cfg, { quiet: true, serveWeb: false });

  const preState = (path: string) => {
    const a = readNpzMember(path, 'addrs'), b = readNpzMember(path, 'before');
    return preStateSha256(new BigInt64Array(a.body.buffer, a.body.byteOffset, a.body.length / 8), new Float32Array(b.body.buffer, b.body.byteOffset, b.body.length / 4), ROW_DIM);
  };
  const parent = await N.market.createDraft({ id: 'stack-parent', name: 'Base knowledge', model: { id_M: 'demo-ainize-1b', row_dim: ROW_DIM }, benchmark: bench, file: files.parent, keepInPlace: true });
  await N.market.createDraft({
    id: 'stack-child', name: 'Add-on built on the base', model: { id_M: 'demo-ainize-1b', row_dim: ROW_DIM }, benchmark: bench, file: files.child, keepInPlace: true,
    parents: ['stack-parent'],
    base: { stack: [{ patch_id: 'stack-parent', patch_sha256: parent.patch_sha256 }], export: 'delta', pre_state_sha256: preState(files.child) },
    derivation: { kind: 'extend', bases: [{ patch_id: 'stack-parent', patch_sha256: parent.patch_sha256, rows: 100 }], added_rows: 50, changed_rows: 50, removed_rows: 0 },
  });
  await N.market.createDraft({ id: 'legacy-one', name: 'Legacy one', model: { id_M: 'demo-ainize-1b', row_dim: ROW_DIM }, benchmark: bench, file: files.legacy1, keepInPlace: true });
  await N.market.createDraft({ id: 'legacy-two', name: 'Legacy two', model: { id_M: 'demo-ainize-1b', row_dim: ROW_DIM }, benchmark: bench, file: files.legacy2, keepInPlace: true });
});

after(async () => {
  hook?.stop();
  await N?.stop();
  await new Promise<void>((r) => (model ? model.close(() => r()) : r()));
  rmSync(tmp, { recursive: true, force: true });
});

/** Leave the table and the recorded stack empty between tests. */
async function unloadAll() {
  for (const l of (await N.market.stack()).reverse()) await N.market.removePatch(l.patch_id, { cascade: true }).catch(() => undefined);
}

const skip = HAVE_REF ? false : `no reference runtime repo at ${REF_REPO} (set AINIZE_RUNTIME_REPO)`;

test('AZ-253 an add-on is only written when its base is underneath, row for row (check → needs_base → base_mismatch)', { skip }, async () => {
  await unloadAll();
  // Nothing loaded: the add-on's `before` is the base's `after` on the 50 shared rows, so it does NOT match the table.
  const bare = await N.market.runtime.check(files.child);
  assert.equal(bare?.rows, 100);
  assert.equal(bare?.differ_before, 50, 'the 50 rows it shares with its base are the base\'s trained values, not the model\'s');
  assert.equal(bare?.ok, false);

  await assert.rejects(N.market.applyStack(['stack-child'], 'manual'), (e: Error & { details?: Record<string, unknown> }) =>
    /needs_base/.test(e.message) && (e.details?.missing as string[])?.[0] === 'stack-parent');

  await N.market.applyStack(['stack-parent'], 'manual');
  const onBase = await N.market.runtime.check(files.child);
  assert.equal(onBase?.differ_before, 0, 'with the base loaded the table IS what the add-on was trained on');
  assert.equal(onBase?.ok, true);

  const res = await N.market.applyStack(['stack-child'], 'manual', { withBase: true });
  assert.deepEqual(res.stack, ['stack-parent', 'stack-child'], 'ancestors first');
  const stack = await N.market.stack();
  assert.deepEqual(stack.map((l) => [l.patch_id, l.position]), [['stack-parent', 0], ['stack-child', 1]]);
  assert.ok(stack.every((l) => l.journal), 'every layer has the journal that would undo it');
  assert.ok(existsSync(join(mailbox, 'journal', `${stack[1].sha256}.npz`)), 'journals live under the hook mailbox (§5.4)');
  assert.ok(holds(1075n, cAfter), 'a shared row holds the add-on');
  assert.ok(holds(1000n, pAfter), 'a base-only row still holds the base');
});

test('AZ-254 taking the add-on off puts its base back — not the bare model', { skip }, async () => {
  await unloadAll();
  await N.market.applyStack(['stack-child'], 'manual', { withBase: true });
  await N.market.removePatch('stack-child');
  assert.ok(holds(1075n, pAfter), 'the shared rows are the BASE\'s trained values again');
  assert.ok(!holds(1075n, baseValue), 'not the model\'s own values — that is the bug the journal fixes');
  assert.ok(holds(1000n, pAfter), 'a base-only row was never touched');
  assert.ok(holds(1149n, baseValue), 'a row only the add-on taught is back to the model');
  assert.deepEqual((await N.market.stack()).map((l) => l.patch_id), ['stack-parent']);

  await N.market.removePatch('stack-parent');
  assert.ok(holds(1075n, baseValue) && holds(1000n, baseValue), 'and now the table is the bare model again');
  assert.deepEqual(await N.market.stack(), []);
});

test('AZ-255 a base cannot be pulled out from under a loaded add-on (has_dependents), cascade takes both', { skip }, async () => {
  await unloadAll();
  await N.market.applyStack(['stack-child'], 'manual', { withBase: true });
  await assert.rejects(N.market.removePatch('stack-parent'), (e: Error & { details?: Record<string, unknown> }) =>
    /has_dependents/.test(e.message) && (e.details?.ids as string[])?.[0] === 'stack-child');
  assert.equal((await N.market.stack()).length, 2, 'nothing was unloaded');
  await N.market.removePatch('stack-parent', { cascade: true });
  assert.deepEqual(await N.market.stack(), []);
  assert.ok(holds(1075n, baseValue) && holds(1000n, baseValue));
});

test('AZ-256 the table reverted (restart): the WHOLE stack goes back on, in order', { skip }, async () => {
  await unloadAll();
  await N.market.applyStack(['stack-child'], 'manual', { withBase: true });
  hook.reset();                                     // what a vLLM restart does to the live table
  assert.ok(holds(1075n, baseValue), 'precondition: the edits are gone');
  await N.market.watchdog();
  assert.ok(holds(1000n, pAfter), 'the base is back');
  assert.ok(holds(1075n, cAfter), 'and the add-on is back ON TOP of it, not underneath');
  assert.deepEqual((await N.market.stack()).map((l) => l.patch_id), ['stack-parent', 'stack-child']);
  await unloadAll();
});

test('AZ-257 two pre-lineage knowledges that overlap: unloading the top one leaves the other standing', { skip }, async () => {
  await unloadAll();
  await N.market.applyStack(['legacy-one'], 'manual');
  await N.market.applyStack(['legacy-two'], 'manual');
  assert.ok(holds(3040n, l2After), 'the top one wins on the 25 shared rows');
  await N.market.removePatch('legacy-two');
  assert.ok(holds(3040n, l1After), 'and unloading it restores the one underneath (before L2 this wrote the bare model back)');
  assert.ok(holds(3060n, baseValue), 'its own rows go back to the model');
  await N.market.removePatch('legacy-one');
  assert.ok(holds(3040n, baseValue) && holds(3010n, baseValue));
});

test('AZ-258 a verification is measured on the candidate alone: what this node serves comes off for the run and is back after it (items 241, 258)', { skip }, async () => {
  await unloadAll();
  await N.market.applyStack(['legacy-one'], 'manual');
  assert.ok(holds(3000n, l1After), 'precondition: this node serves legacy-one');
  const seen: { applied: string[]; l1OnTable: boolean; candidateOnTable: boolean }[] = [];
  onGenerate = () => seen.push({
    applied: N.market.store.listApplied().map((a) => a.patch_id),
    l1OnTable: holds(3000n, l1After),
    candidateOnTable: holds(1000n, pAfter),
  });
  const anchor = (await N.market.entry('stack-parent'))!.anchor;
  const out = await N.market.verifyIsolated(anchor, files.parent, {});
  onGenerate = null;
  assert.ok(seen.length >= 2, 'the benchmark ran (a baseline generation and a scored one)');
  assert.ok(seen.every((s) => !s.applied.includes('legacy-one')), 'legacy-one was not on the table while the candidate was being measured');
  assert.ok(seen.every((s) => !s.l1OnTable), 'and its rows really were off the model, not just off the record');
  assert.ok(!seen[0].candidateOnTable, 'the pre-apply baseline is the model WITHOUT the candidate');
  assert.ok(seen.at(-1)!.candidateOnTable, 'and the scored answers are the model WITH it');
  assert.equal(out.passed, true);
  assert.deepEqual((await N.market.stack()).map((l) => l.patch_id), ['legacy-one'], 'this node serves exactly what it served before');
  assert.ok(holds(3000n, l1After), 'and its rows are back on the model — a verification does not un-teach a subscription');
  assert.equal(N.market.store.get('runtime.restore'), '', 'the crash marker is cleared');
  await unloadAll();
});

test('AZ-259 a verification killed halfway leaves a marker, and the next start takes it off the model (item 126)', { skip }, async () => {
  await unloadAll();
  await N.market.applyStack(['legacy-one'], 'manual');
  // Exactly what a SIGKILL between apply and restore leaves behind: the candidate on the table, a row that says so,
  // and the stack the run took off recorded in kv.
  const sha = (await N.market.entry('legacy-two'))!.anchor.patch_sha256;
  N.market.store.set('runtime.restore', JSON.stringify({ ids: ['legacy-one'], reason: 'verify:legacy-two', at: Date.now() }));
  await N.market.runtime.apply(files.legacy2, { journal: N.market.runtime.journalPath(sha) ?? undefined });
  N.market.store.setApplied('legacy-two', sha, 'verify:legacy-two', { journal_path: N.market.runtime.journalPath(sha) });
  assert.ok(holds(3040n, l2After), 'precondition: the interrupted verification is still on the model');
  assert.deepEqual((await N.market.runtime.status(true)).applied, ['legacy-one', 'legacy-two'], 'and /api/info can SEE it (it used to report [] whatever was loaded)');

  await N.market.recoverRuntime(true);
  assert.deepEqual((await N.market.stack()).map((l) => l.patch_id), ['legacy-one']);
  assert.ok(holds(3040n, l1After), 'the candidate came off through its journal — legacy-one is standing again');
  assert.ok(holds(3060n, baseValue), 'and the rows only the candidate taught are back to the model');
  assert.equal(N.market.store.get('runtime.restore'), '');
  await unloadAll();
});

test('AZ-260 holding a body is not a licence to serve it (item 327)', { skip }, async () => {
  const foreign = {
    status: 'VERIFIED', settlements: [],
    anchor: { id: 'foreign-1', author: '0x00000000000000000000000000000000deadbeef', patch_sha256: 'f'.repeat(64), price: '5', currency: 'CREDIT' },
  } as unknown as Parameters<typeof N.market.hasLicense>[0];
  assert.equal(N.market.hasLicense(foreign), false, 'a stranger’s knowledge is not usable by default');
  // What the verifier writes when it fetches a body to score it.
  N.market.store.putLicense('foreign-1', 'f'.repeat(64), 'verification', 'fetched to verify it');
  assert.equal(N.market.hasLicense(foreign), false, 'verifying a knowledge is not buying it');
  assert.match(N.market.licenseError(foreign).message, /not_licensed: this node holds the body of foreign-1 because it verified it/);
  N.market.store.putLicense('foreign-1', 'f'.repeat(64), 'purchase', 'tx abc');
  assert.equal(N.market.hasLicense(foreign), true, 'buying it is');
  N.market.store.putLicense('foreign-1', 'f'.repeat(64), 'verification', 'fetched again');
  assert.equal(N.market.hasLicense(foreign), true, 'and a later verification copy never downgrades the purchase');
  // A knowledge this node published, and one priced at zero, are licensed without a row.
  const mine = (await N.market.entry('stack-parent'))!;
  assert.equal(N.market.hasLicense(mine), true);
  N.market.store.clearLicense('foreign-1');
});
