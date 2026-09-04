/**
 * AZ-315 — a chain purchase on a real cluster: two sellers, one buyer, one `?bundle=1`, and the stack that comes out
 * of it (docs/lineage-teach-design.md §8.7, §11 example 7, §12.4, SC-15).
 *
 * The unit test (packages/node/test/lineage-bundle.test.ts) proves the money in one process. This proves the whole
 * thing across three node PROCESSES that only know each other over HTTP, and — because a purchase whose file cannot
 * be loaded is not a purchase — it proves the loading too, against the real `scripts/patch.py` and the real journal.
 *
 * The model is a fake: an in-process `/v1/models` and the mailbox hook of packages/node/test/fixtures/fake-hook.ts,
 * which speaks exactly the protocol `vllm_patch/patch_hook.py` speaks and holds its table in a Map. So the table this
 * asserts against is one THIS script owns — no GPU is touched, no serving instance is contacted, and the mailbox is
 * a throwaway directory. (`--json` prints the machine-readable summary.)
 *
 *   node --import tsx packages/e2e/scripts/bundle-buy-proof.mjs
 *
 * Everything it makes lives under one temp directory and the cluster is stopped again on the way out.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeHook, baseValue, writeFixture, ROW_DIM } from '../../node/test/fixtures/fake-hook.ts';
import { bf16Bits, preStateSha256, readNpzMember } from '@ngram/core';

const REPO = process.env.NGRAM_RUNTIME_REPO ?? '/mnt/newdata/qwen3.8';
const ROOT = new URL('../../../', import.meta.url).pathname;
const PORT_BASE = Number(process.env.NGRAM_PORT_BASE ?? 3512);
const PASS = 'bundle-proof';
const HOME = mkdtempSync(join(tmpdir(), 'ngram-bundle-cluster-'));
const MAILBOX = join(HOME, 'mailbox');
const A = `http://localhost:${PORT_BASE}`, B = `http://localhost:${PORT_BASE + 1}`, C = `http://localhost:${PORT_BASE + 2}`;
const BASE_ID = 'bundle-proof-base', CHILD_ID = 'bundle-proof-addon';
const MODEL = 'demo-ngram-1b';

let failures = 0;
const must = (cond, what) => { if (!cond) { console.log(`FAIL  ${what}`); failures++; } else console.log(`  ok  ${what}`); };
const step = (s) => console.log(`\n— ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!existsSync(join(REPO, 'scripts', 'patch.py'))) throw new Error(`no patch.py under ${REPO} — nothing to prove the loading against`);

// ---------------------------------------------------------------- the fake model and the fake table
mkdirSync(MAILBOX, { recursive: true });
const hook = new FakeHook(MAILBOX).start();
const model = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(req.url === '/v1/models' ? { data: [{ id: MODEL }] } : { choices: [{ text: 'a', message: { content: 'a' } }] }));
});
await new Promise((r) => model.listen(0, '127.0.0.1', r));
const MODEL_API = `http://127.0.0.1:${model.address().port}`;

// The base writes +7 over the bare table; the add-on is a DELTA — its `before` is the base's `after` on the rows
// they share, so it can only be written with the base underneath it.
const range = (from, n) => Array.from({ length: n }, (_, i) => BigInt(from + i));
const BASE_ADDRS = range(5000, 200);
const CHILD_ADDRS = range(5100, 200);                        // 100 on top of the base, 100 of its own
const baseAfter = (a, d) => baseValue(a, d) + 7;
const childBefore = (a, d) => (BASE_ADDRS.includes(a) ? baseAfter(a, d) : baseValue(a, d));
const childAfter = (a, d) => childBefore(a, d) + 3;
const files = { base: join(HOME, 'base.npz'), child: join(HOME, 'child.npz') };
writeFixture(files.base, BASE_ADDRS, baseValue, baseAfter);
writeFixture(files.child, CHILD_ADDRS, childBefore, childAfter);
const preState = (path) => {
  const a = readNpzMember(path, 'addrs'), b = readNpzMember(path, 'before');
  return preStateSha256(new BigInt64Array(a.body.buffer, a.body.byteOffset, a.body.length / 8), new Float32Array(b.body.buffer, b.body.byteOffset, b.body.length / 4), ROW_DIM);
};
/** What the live (fake) table holds at four sampled columns of one address. */
const holds = (a, v) => Array.from({ length: 4 }, (_, i) => hook.word(a, i * 40)).join(',') === Array.from({ length: 4 }, (_, i) => bf16Bits(v(a, i * 40))).join(',');

// ---------------------------------------------------------------- the cluster
const clusterEnv = {
  ...process.env,
  NGRAM_CLUSTER_HOME: HOME, NGRAM_PORT_BASE: String(PORT_BASE), NGRAM_LEDGER: 'local', NGRAM_SEED: '0',
  NGRAM_RUNTIME_API: MODEL_API, NGRAM_RUNTIME_PATCH_DIR: MAILBOX, NGRAM_RUNTIME_REPO: REPO,
};
const cluster = (...args) => execFileSync(join(ROOT, 'scripts/cluster-restart.sh'), args, { env: clusterEnv, encoding: 'utf8' });

const jsonOf = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { error: t.slice(0, 200) }; } };
const call = async (base, path, { method = 'GET', body, token } = {}) => {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  return { status: r.status, json: await jsonOf(r) };
};
const waitFor = async (fn, pred, ms = 60_000, what = '') => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v && pred(v)) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what || 'a condition'}`);
    await sleep(500);
  }
};

const summary = { purchases: [], settlements: {}, order: [], stack: [] };
try {
  step(`starting a private cluster in ${HOME} (ports ${PORT_BASE}-${PORT_BASE + 2}, local ledger, no seed)`);
  console.log(cluster().trim());
  for (const url of [A, B, C]) await waitFor(() => call(url, '/api/info'), (r) => r.status === 200, 60_000, `${url}/api/info`);
  const tokens = {};
  for (const [name, url] of [['A', A], ['B', B], ['C', C]]) {
    const r = await call(url, '/api/auth/setup', { method: 'POST', body: { password: PASS } });
    tokens[name] = r.json.token ?? (await call(url, '/api/auth/login', { method: 'POST', body: { password: PASS } })).json.token;
    must(!!tokens[name], `${name} claimed`);
  }
  const rt = await call(A, '/api/info');
  must(rt.json.runtime?.available === true, `the (fake) model answers and the hook is alive: ${rt.json.runtime?.model} · ${rt.json.runtime?.error ?? 'no error'}`);

  // ---------------------------------------------------------------- publish the base on A, the add-on on B
  step('A publishes the base; B publishes an add-on trained on top of it');
  const bench = JSON.stringify({ schema: 'bundle/proof', queries: 10, format: ['template'], collateral_bound_nat: 0.1 });
  const mk = (url, token, body) => call(url, '/api/patches', { method: 'POST', token, body });
  const basePub = await mk(A, tokens.A, { id: BASE_ID, name: 'Bundle proof base', model_id: MODEL, benchmark: bench, price: '4', path: files.base });
  must(basePub.status === 200 || basePub.status === 201, `base registered: ${JSON.stringify(basePub.json).slice(0, 160)}`);
  must((await call(A, `/api/patches/${BASE_ID}/announce`, { method: 'POST', token: tokens.A })).status === 200, 'base announced');
  const baseSha = (await call(A, `/api/patches/${BASE_ID}`)).json.anchor.patch_sha256;

  await waitFor(() => call(B, `/api/patches/${BASE_ID}`), (r) => r.status === 200, 60_000, 'the base to reach B');
  const childPub = await mk(B, tokens.B, {
    id: CHILD_ID, name: 'Bundle proof add-on', model_id: MODEL, benchmark: bench, price: '6', path: files.child,
    parents: BASE_ID, base_stack: BASE_ID, export: 'delta',
    derivation: JSON.stringify({ kind: 'extend', bases: [{ patch_id: BASE_ID, patch_sha256: baseSha, rows: 200 }], added_rows: 100, changed_rows: 100, removed_rows: 0 }),
  });
  must(childPub.status === 200 || childPub.status === 201, `add-on registered: ${JSON.stringify(childPub.json).slice(0, 200)}`);
  must(childPub.json.anchor?.base?.pre_state_sha256 === preState(files.child), 'the node recomputed `pre_state_sha256` from the file rather than taking a claim');
  must((await call(B, `/api/patches/${CHILD_ID}/announce`, { method: 'POST', token: tokens.B })).status === 200, 'add-on announced');

  step('both reach their verification quorum, on the seller that has to answer for them and on the buyer');
  // The SELLER's own count is what the gateway checks: a buyer that sees 2/2 before the seller has received the
  // second attestation gets `423 patch not listed yet` and no purchase at all.
  await waitFor(() => call(A, `/api/patches/${BASE_ID}`), (r) => r.json?.status === 'LISTED', 180_000, 'the base to be LISTED on A');
  await waitFor(() => call(B, `/api/patches/${CHILD_ID}`), (r) => r.json?.status === 'LISTED', 180_000, 'the add-on to be LISTED on B');
  await waitFor(() => call(C, `/api/patches/${BASE_ID}`), (r) => r.json?.quorum_ok === true, 120_000, 'the base to be verified in C\'s view');
  await waitFor(() => call(C, `/api/patches/${CHILD_ID}`), (r) => r.json?.quorum_ok === true, 120_000, 'the add-on to be verified in C\'s view');

  // ---------------------------------------------------------------- the 402 and the quote
  step('what a stranger is told the add-on costs');
  const r402 = await fetch(`${B}/x402/patch/${CHILD_ID}`);
  const body402 = await jsonOf(r402);
  must(r402.status === 402, `the gateway asks for payment (${r402.status} ${JSON.stringify(body402).slice(0, 200)})`);
  const req = body402.requirements?.[0] ?? {};
  must((req.requires ?? []).map((x) => x.id).join(',') === BASE_ID, `the 402 names the base underneath: ${(req.requires ?? []).map((x) => x.id).join(',')}`);
  must(req.total === '10', `and the family price: ${req.total}`);
  const quote = (await call(C, `/api/patches/${CHILD_ID}/quote`)).json;
  must(quote.missing.join(',') === BASE_ID && quote.total === '10', `C's own quote: total ${quote.total}, missing ${quote.missing.join(',')}`);

  // ---------------------------------------------------------------- one bundle purchase
  step('C buys the add-on with ?bundle=1');
  const buy = await call(C, `/api/patches/${CHILD_ID}/buy?bundle=1`, { method: 'POST', token: tokens.C, body: {} });
  must(buy.status === 200, `buy answered ${buy.status}: ${JSON.stringify(buy.json).slice(0, 200)}`);
  summary.purchases = (buy.json.purchases ?? []).map((p) => ({ id: p.patch_id, amount: p.amount, tx: p.tx_hash }));
  must(summary.purchases.map((p) => p.id).join(',') === `${BASE_ID},${CHILD_ID}`, `the base was bought first: ${summary.purchases.map((p) => p.id).join(' → ')}`);
  must(buy.json.total === '10', `the total that moved: ${buy.json.total}`);
  const settlesOf = async (url, id) => ((await call(url, `/api/patches/${id}/records`)).json.records ?? []).filter((x) => x.type === 'settle' || x.body?.kind === 'settle' || 'buyer' in (x.body ?? {}));
  const baseSettles = await settlesOf(A, BASE_ID), childSettles = await settlesOf(B, CHILD_ID);
  summary.settlements = { [BASE_ID]: baseSettles.length, [CHILD_ID]: childSettles.length };
  must(baseSettles.length === 1, `one settle record for the base on A (${baseSettles.length})`);
  must(childSettles.length === 1, `one settle record for the add-on on B (${childSettles.length})`);
  const aAddr = (await call(A, '/api/info')).json.node.address.toLowerCase();
  const royalty = childSettles[0]?.body?.royalty ?? {};
  const toA = Number(Object.entries(royalty).find(([addr]) => addr.toLowerCase() === aAddr)?.[1] ?? 0);
  must(toA >= 6 * 0.3 - 1e-9, `the base's author is paid out of the add-on's sale too: ${toA} of 6 (§11 example 7)`);

  // ---------------------------------------------------------------- the stack
  step('loading it: the add-on alone is refused, and with its base it goes on in order');
  const alone = await call(C, `/api/patches/${CHILD_ID}/apply`, { method: 'POST', token: tokens.C, body: {} });
  must(alone.status === 409 && /^needs_base/.test(alone.json.error ?? ''), `refused alone: ${alone.status} ${String(alone.json.error).slice(0, 120)}`);
  must((alone.json.missing ?? []).join(',') === BASE_ID, 'and it names what is missing');

  const both = await call(C, `/api/patches/${CHILD_ID}/apply`, { method: 'POST', token: tokens.C, body: { with_base: true } });
  must(both.status === 200, `loaded with the base: ${both.status} ${JSON.stringify(both.json).slice(0, 200)}`);
  summary.order = both.json.order ?? [];
  must(summary.order.join(' → ') === `${BASE_ID} → ${CHILD_ID}`, `the order it reports: ${summary.order.join(' → ')}`);
  const stack = (await call(C, '/api/runtime/stack', { token: tokens.C })).json.stack ?? [];
  summary.stack = stack.map((l) => ({ id: l.patch_id, position: l.position, journal: l.journal, export: l.export }));
  must(stack.map((l) => l.patch_id).join(',') === `${BASE_ID},${CHILD_ID}`, `and the recorded stack, bottom first: ${stack.map((l) => l.patch_id).join(' → ')}`);
  must(stack.every((l) => l.journal), 'every layer has a journal');
  must(BASE_ADDRS.every((a) => holds(a, BASE_ADDRS.includes(a) && CHILD_ADDRS.includes(a) ? childAfter : baseAfter)), 'the table holds the base everywhere the add-on did not overwrite it');
  must(CHILD_ADDRS.every((a) => holds(a, childAfter)), 'and the add-on on its own rows');

  step('taking it apart: the base cannot go first, and removing the add-on leaves the base standing');
  const pull = await call(C, `/api/patches/${BASE_ID}/apply`, { method: 'DELETE', token: tokens.C, body: {} });
  must(pull.status === 409 && /^has_dependents/.test(pull.json.error ?? ''), `the base is held down: ${pull.status} ${String(pull.json.error).slice(0, 120)}`);
  must((await call(C, `/api/patches/${CHILD_ID}/apply`, { method: 'DELETE', token: tokens.C, body: {} })).status === 200, 'the add-on comes off');
  must(BASE_ADDRS.every((a) => holds(a, baseAfter)), 'and the BASE is still on the table — its rows went back to the base, not to the bare model');
  must((await call(C, `/api/patches/${BASE_ID}/apply`, { method: 'DELETE', token: tokens.C, body: {} })).status === 200, 'now the base comes off');
  must(BASE_ADDRS.every((a) => holds(a, baseValue)) && CHILD_ADDRS.every((a) => holds(a, baseValue)), 'the table is exactly where it started');
} finally {
  step('stopping the cluster');
  try { console.log(cluster('--stop').trim()); } catch (e) { console.log(`could not stop the cluster: ${e.message}`); }
  hook.stop();
  await new Promise((r) => model.close(r));
  if (!process.env.KEEP_BUNDLE_PROOF) rmSync(HOME, { recursive: true, force: true });
  else console.log(`kept ${HOME}`);
}

if (process.argv.includes('--json')) console.log(JSON.stringify(summary, null, 2));
console.log(failures ? `\n${failures} failure(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
