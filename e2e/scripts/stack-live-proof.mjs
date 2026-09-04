/**
 * AZ-258 — the runtime stack, measured on a SERVED model (docs/lineage-teach-design.md §8).
 *
 * The unit tests (packages/node/test/runtime-stack.test.ts) prove the same thing against a fake hook. This script
 * proves it on the real PLE hook, through a real node, with the knowledge files this product ships:
 *
 *   A. two knowledges published before lineage existed that happen to overlap (rows-ep12 + 픽셀플러스): loading the
 *      second and then unloading it must leave the FIRST one's rows on the table, not the model's own.
 *   B. a true add-on over rows-ep12 (a delta whose `before` IS ep12's `after`): it may not be written unless ep12 is
 *      underneath, its base cannot be pulled out from under it, and taking it off restores ep12.
 *
 * Every number printed is read back from the hook by `patch.py check`, which compares ALL rows bf16-exact. Nothing
 * here is simulated and nothing is left applied.
 *
 *   node packages/e2e/scripts/stack-live-proof.mjs
 *   AINIZE_URL=http://localhost:3422 AINIZE_PASS=teachable-pass node packages/e2e/scripts/stack-live-proof.mjs
 *
 * GPU rule: the node this runs against must serve http://localhost:8002 with the mailbox ple_patch_e2e.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { addressSet, intersectionCount, readNpzAddrs } from '@ngram/core';

const BASE = process.env.AINIZE_URL ?? 'http://localhost:3422';
const PASS = process.env.AINIZE_PASS ?? 'teachable-pass';
const REPO = process.env.NGRAM_RUNTIME_REPO ?? '/mnt/newdata/qwen3.8';
const WORK = process.env.STACK_PROOF_DIR ?? join(process.env.HOME ?? '/tmp', '.ngram-teachable', 'stack-proof');
const EP12 = join(REPO, 'results', 'train-all', 'rows-ep12.npz');
const PIXEL = join(REPO, 'results', 'train-fact', '픽셀플러스.npz');
const ADDON = join(WORK, 'addon-over-ep12.npz');
const IDS = { base: 'stack-live-base', neighbour: 'stack-live-neighbour', addon: 'stack-live-addon' };

let token = '';
const api = async (method, path, body, form) => {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: form ?? (body ? JSON.stringify(body) : undefined),
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 300) }; }
  return { status: r.status, json };
};
const must = (cond, what) => { if (!cond) { console.error(`FAIL  ${what}`); process.exitCode = 1; } else console.log(`  ok  ${what}`); };
const step = (s) => console.log(`\n— ${s}`);

/** `differ_before` / `differ_after` over EVERY row of a knowledge, read through the hook. */
async function check(id) {
  const { status, json } = await api('GET', `/api/patches/${id}/check`);
  if (status !== 200) throw new Error(`check ${id}: ${status} ${JSON.stringify(json)}`);
  return json;
}
const apply = (id, body) => api('POST', `/api/patches/${id}/apply`, body ?? {});
const unload = (id, body) => api('DELETE', `/api/patches/${id}/apply`, body ?? {});

async function register(id, path, name, extra = {}) {
  const bench = JSON.stringify({ metric: 'exact', threshold: 1, samples: [{ prompt: '종목코드 픽셀플러스 ', expect: '087600' }] });
  const form = new URLSearchParams({ id, name, model_id: 'Qwen3.8-Flash-Next', path, benchmark: bench, price: '0', visibility: 'test', ...extra });
  const r = await fetch(`${BASE}/api/patches`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded' }, body: form });
  const j = await r.json().catch(() => ({}));
  if (r.status !== 200 && !(j.error ?? '').includes('already')) throw new Error(`register ${id}: ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
  return j.anchor;
}

/** A genuine add-on over ep12: 2,000 of its own addresses, `before` = ep12's `after`, `after` = that plus a step. */
function buildAddon() {
  if (existsSync(ADDON)) return;
  mkdirSync(WORK, { recursive: true });
  execFileSync('python3', ['-c', `
import numpy as np
d = np.load(${JSON.stringify(EP12)})
addrs, after = d['addrs'], d['after']
take = np.sort(np.random.default_rng(7).choice(len(addrs), 2000, replace=False))
a = addrs[take]
before = after[take].astype(np.float32)          # the table state this add-on was trained against
np.savez(${JSON.stringify(ADDON)}, addrs=a, before=before, after=(before + np.float32(0.5)).astype(np.float32))
print('addon rows', len(a))
`], { stdio: 'inherit' });
}

// ---------------------------------------------------------------- run
const overlap = intersectionCount(addressSet(readNpzAddrs(EP12)), addressSet(readNpzAddrs(PIXEL)));
console.log(`rows-ep12 ∩ 픽셀플러스 = ${overlap} addresses (read from the two files just now)`);

token = (await api('POST', '/api/auth/login', { password: PASS })).json.token;
if (!token) throw new Error('operator login failed');
const rt = (await api('GET', '/api/runtime')).json;
console.log(`runtime: ${rt.api} model=${rt.model} hook=${rt.hook} patch mailbox journal dir=${rt.journal_dir}`);
if (!rt.available) throw new Error(`runtime not available: ${rt.error}`);
if (!/8002/.test(rt.api ?? '')) throw new Error(`refusing to run: this node serves ${rt.api}, and only :8002 may be touched`);
if (rt.stack?.length) throw new Error(`something is already loaded: ${rt.stack.map((l) => l.patch_id).join(', ')}`);

buildAddon();
await register(IDS.base, EP12, 'KRX ticker codes — epoch 12 (stack proof)');
await register(IDS.neighbour, PIXEL, 'Pixelplus ticker code (stack proof)');
await register(IDS.addon, ADDON, 'Add-on trained on top of epoch 12 (stack proof)', { parents: IDS.base, base_stack: IDS.base, export: 'delta' });

try {
  step('A1 nothing loaded — the table is the model\'s own');
  const bare = await check(IDS.base);
  must(bare.differ_before === 0, `every one of the ${bare.rows} rows of ${IDS.base} is at the model's own value`);
  must(bare.differ_after > 0, `and none of them is at its trained value yet (${bare.differ_after} differ)`);

  step('A2 load rows-ep12, then 픽셀플러스 on top of it');
  must((await apply(IDS.base)).status === 200, 'ep12 loaded');
  must((await check(IDS.base)).differ_after === 0, 'the table now holds ep12 on every row');
  const pixelOnEp12 = await check(IDS.neighbour);
  must(pixelOnEp12.differ_before === overlap, `픽셀플러스 sees ${pixelOnEp12.differ_before} of its rows already changed — exactly the ${overlap} it shares with ep12`);
  must((await apply(IDS.neighbour)).status === 200, '픽셀플러스 loaded on top');
  must((await check(IDS.neighbour)).differ_after === 0, 'and it owns those rows now');

  step('A3 unload 픽셀플러스 — ep12 must be standing, not the bare model');
  must((await unload(IDS.neighbour)).status === 200, '픽셀플러스 unloaded');
  const backToEp12 = await check(IDS.base);
  must(backToEp12.differ_after === 0, `all ${backToEp12.rows} rows of ep12 are at ITS trained values again, including the ${overlap} 픽셀플러스 had overwritten`);
  const pixelAfter = await check(IDS.neighbour);
  must(pixelAfter.differ_before === overlap, `and those ${overlap} rows are NOT back at the model's own values — which is what the journal is for`);
  must((await unload(IDS.base)).status === 200, 'ep12 unloaded');
  must((await check(IDS.base)).differ_before === 0, 'the table is the bare model again');

  step('B1 an add-on may not be written unless the knowledge it was trained on is underneath');
  const addonBare = await check(IDS.addon);
  must(addonBare.differ_before === addonBare.rows, `all ${addonBare.rows} rows of the add-on disagree with the bare table — it was trained on ep12, not on the model`);
  const refused = await apply(IDS.addon);
  must(refused.status === 409 && /needs_base/.test(refused.json.error ?? ''), `refused: ${refused.json.error?.slice(0, 80)}`);

  step('B2 load it with its base — ancestors first, one lock');
  const loaded = await apply(IDS.addon, { with_base: true });
  must(loaded.status === 200, `loaded: ${loaded.json.result}`);
  must(JSON.stringify(loaded.json.stack.map((l) => l.patch_id)) === JSON.stringify([IDS.base, IDS.addon]), 'the stack is [ep12, add-on] — the base is underneath');
  must(loaded.json.stack.every((l) => l.journal), 'both layers have the journal that would undo them');
  must((await check(IDS.addon)).differ_after === 0, 'the add-on owns its rows');

  step('B3 the base cannot be pulled out from under it');
  const dep = await unload(IDS.base);
  must(dep.status === 409 && /has_dependents/.test(dep.json.error ?? ''), `refused: ${dep.json.error?.slice(0, 90)}`);

  step('B4 unload the add-on — ep12 is restored on the rows it covered');
  must((await unload(IDS.addon)).status === 200, 'add-on unloaded');
  const ep12Intact = await check(IDS.base);
  must(ep12Intact.differ_after === 0, `all ${ep12Intact.rows} rows of ep12 are at its trained values`);
  const addonBack = await check(IDS.addon);
  must(addonBack.differ_before === 0, 'and the add-on\'s own check passes again: the table under it is exactly what it was trained on');
  must((await unload(IDS.base)).status === 200, 'ep12 unloaded');
  must((await check(IDS.base)).differ_before === 0, 'the table is the bare model again');
} finally {
  step('cleanup — nothing may be left applied');
  for (const id of [IDS.addon, IDS.neighbour, IDS.base]) await unload(id, { cascade: true }).catch(() => undefined);
  const end = (await api('GET', '/api/runtime')).json;
  must((end.stack ?? []).length === 0, 'the node reports an empty stack');
  for (const id of [IDS.addon, IDS.neighbour, IDS.base]) await api('DELETE', `/api/patches/${id}`).catch(() => undefined);
}
console.log(process.exitCode ? '\nSOME CHECKS FAILED' : '\nall checks passed');
