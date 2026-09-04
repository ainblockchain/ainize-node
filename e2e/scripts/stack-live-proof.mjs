/**
 * AZ-258 — the runtime stack, measured on a SERVED model (docs/lineage-teach-design.md §8).
 *
 * The unit tests (packages/node/test/runtime-stack.test.ts) prove this against a fake hook. This script proves it on
 * the real PLE hook with the knowledge files this product ships.
 *
 *   Phase 1 (rows) runs the whole sequence inside ONE hold of the shared runtime lock, because several nodes on this
 *   machine drive the same serving instance and a table read between two of their operations means nothing. Nothing
 *   is asserted against a hard-coded value: the state the table is in when the lock is taken is measured first, and
 *   every claim is made against THAT — including the final one, that the table is exactly back where it started.
 *
 *   Phase 2 (bookkeeping) drives the node's HTTP API: `needs_base`, the ordered stack with its journals,
 *   `has_dependents`, cascade. Those are state assertions, so they tolerate other nodes taking the lock in between.
 *
 *   node packages/e2e/scripts/stack-live-proof.mjs
 *   AINIZE_HOME=~/.ngram-teachable/node-u AINIZE_URL=http://localhost:3422 AINIZE_PASS=teachable-pass node …
 *
 * GPU rule: it refuses to touch anything but the instance on :8002 with the ple_patch_e2e mailbox.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { addressSet, intersectionCount, readNpzAddrs } from '@ngram/core';
import { Runtime } from '../../node/dist/runtime.js';

const HOME = process.env.AINIZE_HOME ?? join(process.env.HOME ?? '', '.ngram-teachable', 'node-u');
const BASE = process.env.AINIZE_URL ?? 'http://localhost:3422';
const PASS = process.env.AINIZE_PASS ?? 'teachable-pass';
const cfg = JSON.parse(readFileSync(join(HOME, 'config.json'), 'utf8'));
const REPO = cfg.runtime.repo;
const WORK = process.env.STACK_PROOF_DIR ?? join(HOME, 'stack-proof');
const EP12 = join(REPO, 'results', 'train-all', 'rows-ep12.npz');
const PIXEL = join(REPO, 'results', 'train-fact', '픽셀플러스.npz');
const ADDON = join(WORK, 'addon-over-ep12.npz');
const IDS = { base: 'stack-live-base', neighbour: 'stack-live-neighbour', addon: 'stack-live-addon' };

let failures = 0;
const must = (cond, what) => { if (!cond) { console.log(`FAIL  ${what}`); failures++; } else console.log(`  ok  ${what}`); };
const step = (s) => console.log(`\n— ${s}`);

if (!/8002/.test(cfg.runtime.api ?? '')) throw new Error(`refusing to run: ${HOME} serves ${cfg.runtime.api}, and only :8002 may be touched`);
if (!/ple_patch_e2e/.test(cfg.runtime.patchDir ?? '')) throw new Error(`refusing to run: mailbox is ${cfg.runtime.patchDir}, and only ple_patch_e2e may be touched`);

/** A genuine add-on over ep12: 2,000 of its addresses, `before` = ep12's `after`, `after` = that plus a step. */
function buildAddon() {
  if (existsSync(ADDON)) return;
  mkdirSync(WORK, { recursive: true });
  execFileSync('python3', ['-c', `
import numpy as np
d = np.load(${JSON.stringify(EP12)})
addrs, after = d['addrs'], d['after']
take = np.sort(np.random.default_rng(7).choice(len(addrs), 2000, replace=False))
before = after[take].astype(np.float32)          # the table state this add-on was trained against
np.savez(${JSON.stringify(ADDON)}, addrs=addrs[take], before=before, after=(before + np.float32(0.5)).astype(np.float32))
`], { stdio: 'inherit' });
}

const overlap = intersectionCount(addressSet(readNpzAddrs(EP12)), addressSet(readNpzAddrs(PIXEL)));
console.log(`rows-ep12 ∩ 픽셀플러스 = ${overlap} addresses (counted from the two files just now)`);
buildAddon();

// ---------------------------------------------------------------- phase 1: rows, under one lock
const rt = new Runtime(cfg.runtime, `pid:${process.pid}:stack-proof`);
const st = await rt.status(true);
console.log(`runtime: ${st.api} model=${st.model} hook=${st.hook} mailbox=${rt.patchDir()} journals=${rt.journalDir()}`);
if (!st.available) throw new Error(`runtime not available: ${st.error}`);
const J = { base: rt.journalPath('a'.repeat(64)), pixel: rt.journalPath('b'.repeat(64)), addon: rt.journalPath('c'.repeat(64)) };

await rt.exclusive('stack-live-proof', async () => {
  const check = async (path, label) => { const c = await rt.check(path); if (!c) throw new Error(`check ${label} returned nothing`); return c; };
  const apply = async (path, journal, verifyBefore) => rt.applyRaw(path, { journal, verifyBefore });
  const remove = async (path, journal) => rt.removeRaw(path, { journal });

  step('0 what the table holds right now — every later claim is made against this, not against a constant');
  const base0 = await check(EP12, 'ep12');
  const pixel0 = await check(PIXEL, 'pixel');
  console.log(`    ep12  : ${base0.differ_before}/${base0.rows} rows differ from its \`before\`, ${base0.differ_after} from its \`after\``);
  console.log(`    pixel : ${pixel0.differ_before}/${pixel0.rows} differ from its \`before\`, ${pixel0.differ_after} from its \`after\``);

  step('1 load rows-ep12, then 픽셀플러스 on top of it');
  must((await apply(EP12, J.base)).code === 0, 'ep12 written');
  must((await check(EP12, 'ep12')).differ_after === 0, `the table holds ep12 on all ${base0.rows} rows`);
  const pixelOnEp12 = (await check(PIXEL, 'pixel')).differ_before;
  must(pixelOnEp12 !== pixel0.differ_before, `픽셀플러스 now sees ${pixelOnEp12} of its rows changed, not the ${pixel0.differ_before} it saw before — ep12 is under it`);
  must((await apply(PIXEL, J.pixel)).code === 0, '픽셀플러스 written on top');
  must((await check(PIXEL, 'pixel')).differ_after === 0, 'and it owns those rows now');

  step('2 unload 픽셀플러스 — ep12 must be standing underneath, not whatever was there before either of them');
  must((await remove(PIXEL, J.pixel)).code === 0, '픽셀플러스 unloaded through its journal');
  must((await check(EP12, 'ep12')).differ_after === 0, `all ${base0.rows} rows of ep12 are at ITS values again, including the ${overlap} 픽셀플러스 had overwritten`);
  must((await check(PIXEL, 'pixel')).differ_before === pixelOnEp12, 'the shared rows hold ep12, exactly as they did before 픽셀플러스 went on — this is what the journal is for');

  step('3 unload ep12 — the table is exactly where it was at step 0');
  must((await remove(EP12, J.base)).code === 0, 'ep12 unloaded through its journal');
  const back = await check(EP12, 'ep12');
  const backPixel = await check(PIXEL, 'pixel');
  must(back.differ_before === base0.differ_before && back.differ_after === base0.differ_after, `ep12 measures ${back.differ_before}/${back.differ_after} — the same two numbers as step 0`);
  must(backPixel.differ_before === pixel0.differ_before && backPixel.differ_after === pixel0.differ_after, 'and so does 픽셀플러스');

  step('4 an add-on may not be written unless the knowledge it was trained on is underneath');
  const addon0 = await check(ADDON, 'add-on');
  must(addon0.differ_before > 0 && !addon0.ok, `${addon0.differ_before} of ${addon0.rows} rows of the add-on disagree with the table — it was trained on ep12, which is not loaded`);
  const refused = await apply(ADDON, J.addon, true);
  must(refused.code === 4 && refused.json?.error === 'base_mismatch', `refused: base_mismatch on ${refused.json?.rows_differ} rows`);
  must((await check(ADDON, 'add-on')).differ_before === addon0.differ_before, 'and NOTHING was written — the table is untouched');

  step('5 with ep12 underneath the same add-on goes on, and comes off leaving ep12 standing');
  must((await apply(EP12, J.base)).code === 0, 'ep12 loaded');
  must((await check(ADDON, 'add-on')).differ_before === 0, `all ${addon0.rows} rows under the add-on are now exactly what it was trained on`);
  const ok = await apply(ADDON, J.addon, true);
  must(ok.code === 0, 'the add-on is written (the `prev == before` gate passed on every row)');
  must(ok.json?.prev_equals_before === true, 'and the values it displaced were exactly its `before` — the hook says so, not the file');
  must((await check(ADDON, 'add-on')).differ_after === 0, 'the add-on owns its rows');
  must((await remove(ADDON, J.addon)).code === 0, 'add-on unloaded');
  must((await check(ADDON, 'add-on')).differ_before === 0, 'ep12 is back on every row the add-on covered — bf16-exact, all 2,000');
  must((await check(EP12, 'ep12')).differ_after === 0, `and ep12 is intact across all ${base0.rows} of its own rows`);
  must((await remove(EP12, J.base)).code === 0, 'ep12 unloaded');
  const end = await check(EP12, 'ep12');
  must(end.differ_before === base0.differ_before && end.differ_after === base0.differ_after, 'the table is exactly where it was at step 0');
}, {});

// ---------------------------------------------------------------- phase 2: the node's bookkeeping, over HTTP
let token = '';
const api = async (method, path, body) => {
  const r = await fetch(`${BASE}${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 200) }; }
  return { status: r.status, json };
};
async function register(id, path, name, extra = {}) {
  const form = new FormData();
  const fields = { id, name, model_id: 'Qwen3.8-Flash-Next', path, benchmark: JSON.stringify({ metric: 'exact', threshold: 1, samples: [{ prompt: 'q ', expect: 'a' }] }), price: '0', visibility: 'test', ...extra };
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const r = await fetch(`${BASE}/api/patches`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form });
  const j = await r.json().catch(() => ({}));
  if (r.status !== 200) throw new Error(`register ${id}: ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  return j.anchor;
}

token = (await api('POST', '/api/auth/login', { password: PASS })).json.token;
if (!token) throw new Error('operator login failed');
step('6 the node\'s own bookkeeping (HTTP): needs_base, the ordered stack, has_dependents');
// This machine's serving instance is shared, and it does get taken away mid-run (the GPUs are also the trainer's).
// "the model server went away" is not a failed assertion — say so and stop, rather than printing five red lines.
const live = (await api('GET', '/api/runtime')).json;
if (!live.available || !live.hook) {
  console.log(`  --  skipped: the node cannot reach the patch hook right now (${live.error ?? 'hook unavailable'}). Phase 1 above is the measurement; this phase is bookkeeping.`);
  console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nall row checks passed; the HTTP phase could not run');
  process.exit(failures ? 1 : 0);
}
for (const id of Object.values(IDS)) await api('DELETE', `/api/patches/${id}`).catch(() => undefined);
await register(IDS.base, EP12, 'KRX ticker codes — epoch 12 (stack proof)');
await register(IDS.neighbour, PIXEL, 'Pixelplus ticker code (stack proof)');
await register(IDS.addon, ADDON, 'Add-on trained on top of epoch 12 (stack proof)', { parents: IDS.base, base_stack: IDS.base, export: 'delta' });
try {
  const refused = await api('POST', `/api/patches/${IDS.addon}/apply`, {});
  must(refused.status === 409 && /needs_base/.test(refused.json.error ?? ''), `an add-on alone is refused: ${(refused.json.error ?? '').slice(0, 70)}`);
  const loaded = await api('POST', `/api/patches/${IDS.addon}/apply`, { with_base: true });
  must(loaded.status === 200, `with_base loads the stack: ${loaded.json.result}`);
  must(JSON.stringify((loaded.json.stack ?? []).map((l) => l.patch_id)) === JSON.stringify([IDS.base, IDS.addon]), 'the stack is [ep12, add-on] — the base underneath, in order');
  const layers = loaded.json.stack ?? [];
  must(layers.length === 2 && layers.every((l) => l.journal), `both layers have the journal that would undo them (${layers.length} layers reported)`);
  const dep = await api('DELETE', `/api/patches/${IDS.base}/apply`, {});
  must(dep.status === 409 && /has_dependents/.test(dep.json.error ?? ''), `the base cannot be pulled out: ${(dep.json.error ?? '').slice(0, 70)}`);
  must((await api('DELETE', `/api/patches/${IDS.addon}/apply`, {})).status === 200, 'the add-on comes off');
  must((await api('DELETE', `/api/patches/${IDS.base}/apply`, {})).status === 200, 'and then the base');
} finally {
  step('cleanup — nothing may be left applied');
  for (const id of [IDS.addon, IDS.neighbour, IDS.base]) await api('DELETE', `/api/patches/${id}/apply`, { cascade: true }).catch(() => undefined);
  // A missing route answers 404 with HTML; `?? []` would have turned that into a silent pass, so the status is
  // checked first — an assertion that cannot fail is not an assertion.
  const end = await api('GET', '/api/runtime/stack');
  must(end.status === 200, `GET /api/runtime/stack answers (${end.status})`);
  const stack = end.status === 200 ? end.json.stack ?? [] : [{ patch_id: 'unknown' }];
  must(end.status === 200 && stack.length === 0, `the node reports an empty stack${stack.length ? ` (still: ${stack.map((l) => l.patch_id).join(', ')})` : ''}`);
  for (const id of [IDS.addon, IDS.neighbour, IDS.base]) await api('DELETE', `/api/patches/${id}`).catch(() => undefined);
}
console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
