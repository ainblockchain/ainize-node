/**
 * Node operator / developer scenarios AZ-051..AZ-070 (docs/ux-test-scenarios.json) against the LIVE demo cluster.
 *
 * Conventions: on-chain artifacts get per-run unique ids (uid), published test knowledge is always `--test`
 * (hidden from public catalogs) with a run-unique benchmark schema so nothing ever supersedes the demo's
 * krx-all-2761, and the purchase scenarios run on a throwaway fourth node (node-d, fresh identity funded from
 * the local genesis account) so every run starts from "not yet purchased".
 */
import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { promisify } from 'node:util';
import { join } from 'node:path';
import {
  NODE_A, NODE_B, NODE_C, HOME_A, HOME_B, HOME_C, K, PASSWORDS, REPO, RUNTIME_PATCH_DIR, VLLM, api, agentRun, cliLogin, holdRuntimeLock, nodeAddress,
  operatorToken, sleep, waitForLockFree, waitForRuntime,
} from '../helpers/ainize';
import {
  runCli, spawnCli, strip, uid, PIXEL_NPZ, PIXEL_SHA, KRX_SHA, MODEL, benchJson, shortAddr, esc, tableRows, tmpHome, SCRATCH,
  HOME_D, NODE_D, PORT_D, PASSWORD_D, cleanupNodeD, nodeDPid, httpUp, httpDown, startNodeD, startPrivateCluster, chatApi, withRuntime, pollUntil, RUN,
  throwawayNode, portBusy,
} from '../helpers/operator-cli';

const ADDR_A = nodeAddress(HOME_A);
const ADDR_B = nodeAddress(HOME_B);
const ADDR_C = nodeAddress(HOME_C);
const execFileP = promisify(execFile);
/** rows of a `ledger ls` table (after the kv block + AT/KIND header + rule) */
const ledgerRows = (s: string): string[] => { const ls = s.split('\n'); const i = ls.findIndex((l) => /^AT\s+KIND\s+AUTHOR/.test(l)); return i < 0 ? [] : ls.slice(i + 2).filter((l) => l.trim()); };
/** /api/info counts include this node's private DRAFTs (catalogSync) — count them so the expected totals stay exact. */
const draftCount = async (pw: typeof import('@playwright/test')['request']): Promise<number> => {
  const ctx = await pw.newContext();
  try { const t = await operatorToken(ctx, NODE_A); const c = await api<{ items: { status: string }[] }>(ctx, '/api/catalog?include_drafts=true&limit=200', { token: t }); return c.body.items.filter((e) => e.status === 'DRAFT').length; } finally { await ctx.dispose(); }
};
/** node-d config must exist (AZ-057 creates it); when a test of the block runs on its own, create + fund it here. */
const ensureNodeD = async () => {
  if (existsSync(join(HOME_D, 'config.json'))) return;
  const r = await runCli(['init', '--name', 'node-d', '--port', String(PORT_D), '--ledger', 'ain', '--ain-provider', 'http://localhost:8081', '--peer', NODE_A, '--roles', 'verifier', '--public-url', NODE_D, '--runtime-api', VLLM], { home: HOME_D });
  expect(r.code, r.stderr).toBe(0);
  expect((await runCli(['config', 'set', 'runtime.patchDir', RUNTIME_PATCH_DIR], { home: HOME_D })).code).toBe(0);
  const f = await runCli(['chain', 'fund', nodeAddress(HOME_D), '100'], { home: HOME_D });
  expect(f.code, f.stderr).toBe(0);
};
const dockerNames = async () => { try { return (await execFileP('docker', ['ps', '-a', '--filter', 'name=ngram-ain', '--format', '{{.Names}}'])).stdout.trim().split('\n').filter(Boolean); } catch { return null; } };
const A = { home: HOME_A };
const B = { home: HOME_B };

// =====================================================================================================================
// Account, API, catalog inspection, ledger, chain, drive, logs, drafts — no shared-model mutation
// =====================================================================================================================
test.describe('operator: account / API / inspection', () => {
  test('AZ-051 Log in and out as operator from the CLI (first login sets the node password) and observe the 401 guard', async ({ request }) => {
    // A throwaway CLI home keeps this session separate from the cli.json other suites use for node-b.
    const home = tmpHome('az051');
    const o = { home, node: NODE_B };
    const pw = PASSWORDS[NODE_B];
    const meBefore = await (await request.get(`${NODE_B}/api/auth/me`)).json() as { needsSetup: boolean };
    const guard = 'error: operator login required — run `ainize login` first';

    let r = await runCli(['wallet'], o);
    expect(r.code).toBe(3);
    expect(r.stderr.trim()).toBe(guard);

    r = await runCli(['login', '--password', pw], o);
    expect(r.code, r.stderr || r.stdout).toBe(0);
    expect(r.stdout.trim()).toBe(`✓ ${meBefore.needsSetup ? 'operator password set and ' : ''}logged in to ${NODE_B} (token saved in ${home}/cli.json)`);

    const me = await (await request.get(`${NODE_B}/api/auth/me`)).json() as { signedIn: boolean; needsSetup: boolean };
    expect(me).toMatchObject({ signedIn: false, needsSetup: false });

    r = await runCli(['wallet'], o);
    expect(r.code, r.stderr || r.stdout).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`^address {13}${ADDR_B}$`, 'm'));
    expect(r.stdout).toMatch(/^ledger {14}ain · ain:local$/m);
    expect(r.stdout).toMatch(/^balance {13}[\d.]+ AIN$/m);
    expect(r.stdout).toMatch(/^sales {15}\d+$/m);
    expect(r.stdout).toMatch(/^royalties received {2}\d+$/m);
    expect(r.stdout).toMatch(/^purchases {11}\d+$/m);

    r = await runCli(['logout'], o);
    expect(r.code, r.stderr || r.stdout).toBe(0);
    expect(r.stdout.trim()).toBe('✓ logged out');
    expect(readFileSync(join(home, 'cli.json'), 'utf8')).not.toContain('token');

    r = await runCli(['wallet'], o);
    expect(r.code).toBe(3);
    expect(r.stderr.trim()).toBe(guard);

    r = await runCli(['login', '--password', 'wrong-password'], o);
    expect(r.code).toBe(3);
    expect(r.stderr.trim()).toBe('error: wrong password — run `ainize login` first');

    r = await runCli(['login'], { ...o, env: { NGRAM_PASSWORD: pw } });
    expect(r.code, r.stderr || r.stdout).toBe(0);
    expect(r.stdout.trim()).toBe(`✓ logged in to ${NODE_B} (token saved in ${home}/cli.json)`);
    expect(statSync(join(home, 'cli.json')).mode & 0o777).toBe(0o600);
  });

  test('AZ-055 Drive the public and operator HTTP API with curl from /api/openapi.json: catalog, detail, benchmarks, info, 401 guards, login token and settings', async ({ request, playwright }) => {
    // 1 openapi
    const oa = (await api<{ openapi: string; info: { title: string }; servers: { url: string }[]; paths: Record<string, unknown> }>(request, '/api/openapi.json')).body;
    expect(oa.openapi).toBe('3.1.0');
    expect(oa.info.title).toBe('Ainize node API');
    expect(oa.servers).toEqual([{ url: NODE_A }]);
    // 50 in the scenario snapshot + POST /api/patches/{id}/forget (ainize patch forget); teach mode adds its own group
    const paths = Object.keys(oa.paths);
    const teachPaths = paths.filter((p) => /\/teach|\/teacher\/|\/payouts/.test(p));
    // 34 = the 23 of teach mode v1 + the 11 dataset routes of the dataset-first door (datasets CRUD/rows/fork/reparse/
    // download, the operator's dataset list, local-run and recipe) — one pipeline, two doors, one API group.
    expect(teachPaths.length, 'teach-mode paths (lessons, review queue, datasets, contributors, payouts)').toBe(34);
    // 53 = 51 + the two D3 live-test queue endpoints (/api/chat/status, /api/chat/cancel), documented since b517cae
    expect(paths.length - teachPaths.length, 'marketplace paths').toBe(53);
    expect(paths.length).toBe(87);
    for (const p of ['/api/chat/status', '/api/chat/cancel']) expect(oa.paths).toHaveProperty(p);
    expect(oa.paths).toHaveProperty('/api/patches/{id}/forget');
    expect(oa.paths).toHaveProperty('/x402/patch/{id}');
    expect(oa.paths).toHaveProperty('/api/chat');
    // 2 docs
    const docs = (await api<{ cli: { oneLiners: { use: { en: string } } } }>(request, '/api/docs')).body;
    expect(Object.keys(docs).sort()).toEqual(['cli', 'node', 'openapi']);
    expect(docs.cli.oneLiners.use.en).toBe('Use knowledge (one line)');
    // 3 catalog
    const cat = (await api<{ total: number; items: { anchor: { id: string }; attestations: Record<string, unknown>[] }[]; models: string[]; schemas: string[] }>(request, '/api/catalog?status=LISTED,SUPERSEDED&sort=price')).body;
    expect(cat.total).toBe(4);
    expect(cat.items[0].anchor.id).toBe(K.pixel);
    expect('sig' in cat.items[0].attestations[0]).toBe(false);
    expect(cat.models).toEqual([MODEL]);
    expect(cat.schemas).toEqual(['krx-ticker-codes']);
    // 4 zod 400s
    for (const q of ['/api/catalog?limit=0', '/api/catalog?sort=bogus']) {
      const r = await api<{ error: string; issues: unknown[] }>(request, q);
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('invalid request');
      expect(Array.isArray(r.body.issues) && r.body.issues.length > 0).toBe(true);
    }
    // 5 detail
    const d = (await api<{ status: string; quorum_ok: boolean; lineage: { parents: { id: string }[] }; supersedes: string[]; gateway_url: string; has_body: boolean; branches: { name: string }[] }>(request, `/api/patches/${K.final}`)).body;
    expect([d.status, d.quorum_ok, d.lineage.parents[0].id, d.supersedes, d.gateway_url, d.has_body, d.branches[0].name])
      .toEqual(['LISTED', true, K.ep12, [K.ep12, K.ep6, K.pixel], `${NODE_A}/x402/patch/${K.final}`, true, 'finance/KRX-latest']);
    // 6 404s
    let r = await api<{ error: string }>(request, '/api/patches/does-not-exist');
    expect([r.status, r.body.error]).toEqual([404, 'patch not found']);
    r = await api<{ error: string }>(request, '/api/benchmarks/none');
    expect([r.status, r.body.error]).toEqual([404, 'no patches for that benchmark schema']);
    // 7 benchmark + info
    expect((await api<{ items: unknown[] }>(request, '/api/benchmarks/krx-ticker-codes')).body.items.length).toBe(4);
    const info = (await api<{ quorum: number; currency: string; counts: Record<string, number>; peers: number }>(request, '/api/info')).body;
    expect([info.quorum, info.currency, info.peers]).toEqual([2, 'AIN', 2]);
    expect(info.counts).toEqual({ patches: 4, listed: 1, verifying: 0, superseded: 3, rejected: 0 });
    // 8 401 guards on node-b without credentials
    for (const [method, path] of [['GET', '/api/me/wallet'], ['GET', '/api/me/settings'], ['POST', '/api/patches'], ['POST', '/api/branches'], ['POST', `/api/patches/${K.final}/buy`], ['DELETE', '/api/peers']] as const) {
      const g = await api<{ error: string }>(request, path, { method, node: NODE_B });
      expect([method, path, g.status, g.body.error]).toEqual([method, path, 401, 'operator login required']);
    }
    // 9 wrong password (make sure node-b has a password)
    await operatorToken(request, NODE_B);
    const wrong = await api<{ error: string }>(request, '/api/auth/login', { method: 'POST', node: NODE_B, data: { password: 'wrong' } });
    expect([wrong.status, wrong.body.error]).toEqual([401, 'wrong password']);
    // 10 bearer token → wallet
    const login = await request.post(`${NODE_B}/api/auth/login`, { data: { password: PASSWORDS[NODE_B] } });
    expect(login.status()).toBe(200);
    expect(login.headers()['set-cookie'] ?? '').toMatch(/ngram_session=.*HttpOnly/i);
    const token = (await login.json() as { token: string }).token;
    const wallet = await api<Record<string, unknown>>(request, '/api/me/wallet', { node: NODE_B, token });
    expect(wallet.status).toBe(200);
    // teach mode adds `payouts` (what this node owes the visitors who taught its knowledge) to the wallet view
    expect(Object.keys(wallet.body).sort()).toEqual(['address', 'app', 'balance', 'height', 'kind', 'network', 'payouts', 'provider', 'purchases', 'records', 'royalties', 'sales', 'valid']);
    expect(Object.keys(wallet.body.payouts as Record<string, unknown>).sort()).toEqual(['failed', 'items', 'paid', 'pending']);
    // 11 setup again → 409
    const setup = await api<{ error: string }>(request, '/api/auth/setup', { method: 'POST', node: NODE_B, data: { password: 'another-1234' } });
    expect([setup.status, setup.body.error]).toEqual([409, 'operator password already set']);
    // 12 settings validation + persistence
    const before = (await api<{ settings: { notifications: string; display_name: string; payout_address: string } }>(request, '/api/me/settings', { node: NODE_B, token })).body.settings;
    const weird = await api<{ error: string }>(request, '/api/me/settings', { method: 'PATCH', node: NODE_B, token, data: { notifications: 'weird' } });
    expect([weird.status, weird.body.error]).toEqual([400, 'invalid request']);
    const sales = await api<{ settings: Record<string, string> }>(request, '/api/me/settings', { method: 'PATCH', node: NODE_B, token, data: { notifications: 'sales' } });
    expect(sales.status).toBe(200);
    expect(sales.body).toEqual({ settings: { notifications: 'sales', display_name: before.display_name, payout_address: ADDR_B } });
    const restore = await api<{ settings: Record<string, string> }>(request, '/api/me/settings', { method: 'PATCH', node: NODE_B, token, data: { notifications: before.notifications === 'sales' ? 'all' : before.notifications } });
    expect(restore.status).toBe(200);
    expect(restore.body.settings.notifications).toBe(before.notifications === 'sales' ? 'all' : before.notifications);
    // 13 CORS
    const cors = await request.get(`${NODE_A}/api/info`);
    expect(cors.headers()['access-control-allow-origin']).toBe('*');
  });

  test('AZ-060 Inspect the catalog with `patch ls`, `patch get`, `patch records` and `patch conflicts`', async () => {
    const a4 = shortAddr(ADDR_A, 4);
    let r = await runCli(['patch', 'ls'], A);
    expect(r.code, r.stderr || r.stdout).toBe(0);
    expect(r.stdout).toMatch(/^ID\s+STATUS\s+AUTHOR\s+MODEL\s+ROWS\s+SIZE\s+PRICE\s+ATTEST\s+SOLD\s+BENCHMARK\s*$/m);
    expect(r.stdout).toMatch(new RegExp(`^krx-all-2761\\s+LISTED\\s+node-a ${a4}\\s+${esc(MODEL)}\\s+270,053\\s+331\\.7 MB\\s+25 AIN\\s+2/2\\s+\\d+\\s+krx-ticker-codes\\s*$`, 'm'));
    expect(r.stdout).toMatch(new RegExp(`^krx-all-2761-ep12\\s+SUPERSEDED\\s+node-a ${a4}\\s+${esc(MODEL)}\\s+241,992\\s+297\\.2 MB\\s+10 AIN\\s+2/2\\s+\\d+\\s+krx-ticker-codes\\s*$`, 'm'));
    expect(r.stdout).toMatch(new RegExp(`^krx-all-2761-ep6\\s+SUPERSEDED\\s+node-a ${a4}\\s+${esc(MODEL)}\\s+241,992\\s+297\\.2 MB\\s+5 AIN\\s+2/2\\s+\\d+\\s+krx-ticker-codes\\s*$`, 'm'));
    expect(r.stdout).toMatch(new RegExp(`^pixelplus-087600\\s+SUPERSEDED\\s+node-a ${a4}\\s+${esc(MODEL)}\\s+2,992\\s+3\\.7 MB\\s+0\\.1 AIN\\s+2/2\\s+\\d+\\s+krx-ticker-codes\\s*$`, 'm'));
    expect(tableRows(r.stdout).length).toBe(4);

    r = await runCli(['patch', 'ls', '--status', 'LISTED'], A);
    expect(tableRows(r.stdout).map((l) => l.split(/\s+/)[0])).toEqual([K.final]);
    r = await runCli(['patch', 'ls', '--q', 'pixel'], A);
    expect(tableRows(r.stdout).map((l) => l.split(/\s+/)[0])).toEqual([K.pixel]);

    r = await runCli(['patch', 'ls', '--sort', 'price', '--json'], A);
    expect(r.code, r.stderr || r.stdout).toBe(0);
    const ids = (JSON.parse(r.stdout) as { anchor: { id: string } }[]).map((e) => e.anchor.id);
    expect(ids).toEqual([K.pixel, K.ep6, K.ep12, K.final]);

    r = await runCli(['patch', 'get', K.final], A);
    expect(r.code, r.stderr || r.stdout).toBe(0);
    const lines = r.stdout.split('\n');
    expect(lines[0]).toBe('KRX ticker codes for 2,761 listed companies (final)  LISTED  (yours)');
    expect(r.stdout).toMatch(/^id\s+krx-all-2761$/m);
    expect(r.stdout).toMatch(/^price\s+25 AIN · per_download$/m);
    expect(r.stdout).toMatch(/^benchmark\s+krx-ticker-codes · 2761 queries · template\/chat · collateral ≤ 0\.08 nat$/m);
    expect(r.stdout).toMatch(new RegExp(`^gateway\\s+${esc(NODE_A)}/x402/patch/krx-all-2761$`, 'm'));
    expect(r.stdout).toMatch(/^verification\s+2\/2 passed ✓ quorum$/m);
    expect(r.stdout).toMatch(/^body on this node\s+yes$/m);
    expect(r.stdout).toMatch(/^attestations$/m);
    // The STAKE column is gone (no deposit was ever escrowed — critique 2 item 127); COUNTS says whether the row
    // counted toward the quorum, which is the fact a reader of this table actually needs.
    expect(r.stdout).toMatch(/^VERIFIER\s+RESULT\s+SCORE\s+VERIFIED ON\s+RESTARTS\s+COUNTS\s+AT\s*$/m);
    for (const [name, addr] of [['node-b', ADDR_B], ['node-c', ADDR_C]]) {
      expect(r.stdout).toMatch(new RegExp(`^${name} ${esc(shortAddr(addr, 6))}\\s+PASS\\s+free_generation=\\d+/\\d+ pre_apply=\\d+/\\d+\\s+vllm:${esc(MODEL)}\\s+0\\s+yes\\s+\\d{4}-\\d\\d-\\d\\d`, 'm'));
    }
    expect(r.stdout.split('\n').filter((l) => /^node-a /.test(l)).length).toBe(0);
    expect(r.stdout).toMatch(/^lineage$/m);
    expect(r.stdout).toMatch(/^ {2}parents : krx-all-2761-ep12 \(SUPERSEDED\)$/m);
    expect(r.stdout).toMatch(/^ {2}supersedes: krx-all-2761-ep12, krx-all-2761-ep6, pixelplus-087600$/m);
    expect(r.stdout).toMatch(/^address-set overlaps \(A₁ ∩ A₂\)$/m);
    expect(r.stdout).toMatch(/^branches\n {2}finance\/KRX-latest \{"market":"KRX","version":"latest"\}$/m);

    r = await runCli(['patch', 'get', K.pixel], A);
    expect(r.stdout.split('\n')[0]).toContain('SUPERSEDED');
    expect(r.stdout).toMatch(/^ {2}superseded by: krx-all-2761$/m);

    r = await runCli(['patch', 'conflicts', K.final], A);
    expect(r.code, r.stderr || r.stdout).toBe(0);
    expect(r.stdout).toMatch(/^krx-all-2761-ep12\s+241,992\s+yes\s+SUPERSEDED$/m);
    expect(r.stdout).toMatch(/^krx-all-2761-ep6\s+241,992\s+yes\s+SUPERSEDED$/m);
    expect(r.stdout).toMatch(/^pixelplus-087600\s+2,170\s+yes\s+SUPERSEDED$/m);
    // exactly the three demo overlaps among the seeded (public) catalog — the logged-in node-a operator additionally sees
    // its own DRAFTs and the hidden (visibility:test) listings other suites publish on the same body; `patch ls` above
    // showed the 4 seeded rows, so anything outside that set is such a private/hidden row
    const conflictRows = tableRows(r.stdout).map((l) => l.split(/\s+/)[0]);
    const seeded = new Set((JSON.parse((await runCli(['patch', 'ls', '--json'], A)).stdout) as { anchor: { id: string } }[]).map((e) => e.anchor.id));
    expect(seeded.size).toBe(4);
    expect(conflictRows.filter((id) => seeded.has(id)).sort()).toEqual([K.ep12, K.ep6, K.pixel].sort());

    r = await runCli(['patch', 'records', K.final], A);
    expect(r.code, r.stderr || r.stdout).toBe(0);
    expect(r.stdout).toMatch(/^AT\s+KIND\s+AUTHOR\s+HASH\s+SIG\/TX\s*$/m);
    const rows = tableRows(r.stdout);
    expect(rows.filter((l) => /\sanchor\s/.test(l) && l.includes(shortAddr(ADDR_A, 8))).length).toBe(1);
    expect(rows.filter((l) => /\sattest\s/.test(l) && l.includes(shortAddr(ADDR_B, 8))).length).toBe(1);
    expect(rows.filter((l) => /\sattest\s/.test(l) && l.includes(shortAddr(ADDR_C, 8))).length).toBe(1);
    expect(rows.filter((l) => /\ssupersede\s/.test(l)).length).toBe(3);

    r = await runCli(['patch', 'get', 'does-not-exist'], A);
    expect(r.code).toBe(1);
    expect(r.stderr.trim()).toBe('error: patch not found');
  });

  test('AZ-063 Audit the shared ledger with `ledger ls`, `ledger verify`, `ledger graph` and `ledger export`, and cross-check two nodes', async ({ request }) => {
    let r = await runCli(['ledger', 'ls', '--limit', '10'], A);
    expect(r.code, r.stderr || r.stdout).toBe(0);
    expect(r.stdout).toMatch(/^ledger\s+ain · ain:local · http:\/\/localhost:8081$/m);
    expect(r.stdout).toMatch(/^records\s+\d+$/m);
    expect(r.stdout).toMatch(/^height\s+\d+$/m);
    expect(r.stdout).toMatch(/^head\s+-$/m);
    expect(r.stdout).toMatch(/^AT\s+KIND\s+AUTHOR\s+SUMMARY\s+HASH\s*$/m);
    const recordsA = Number(/^records\s+(\d+)$/m.exec(r.stdout)![1]);

    // `ledger ls` returns the NEWEST n records and every announce in the suite adds attestations, so the demo patch's
    // two rows are only found while the page still reaches back to them — read the whole attest history (API cap 1000)
    // and fail loudly if it no longer fits rather than quietly asserting over a window that has moved past them.
    r = await runCli(['ledger', 'ls', '--kind', 'attest', '--limit', '1000'], A);
    const allAtt = ledgerRows(r.stdout);
    expect(allAtt.length, 'the whole attest history still fits in one page (raise the approach, not the limit, when it does not)').toBeLessThan(1000);
    const attRows = allAtt.filter((l) => l.includes(`krx-all-2761 · PASS · vllm:${MODEL}`));
    expect(attRows.length).toBeGreaterThanOrEqual(2);
    expect(attRows.every((l) => /\sattest\s/.test(l))).toBe(true);
    r = await runCli(['ledger', 'ls', '--kind', 'supersede'], A);
    expect(r.stdout).toContain('krx-all-2761 supersedes pixelplus-087600 (2170 rows)');
    expect(r.stdout).toContain('krx-all-2761 supersedes krx-all-2761-ep6 (241992 rows)');
    expect(r.stdout).toContain('krx-all-2761 supersedes krx-all-2761-ep12 (241992 rows)');
    expect(ledgerRows(r.stdout).length).toBeGreaterThanOrEqual(3);
    expect(ledgerRows(r.stdout).every((l) => /\ssupersede\s/.test(l))).toBe(true);

    // verify (CLI and API must agree on the count; re-check once if a record landed in between)
    let apiV = (await api<{ valid: boolean; checked: number; errors: string[] }>(request, '/api/ledger/verify')).body;
    r = await runCli(['ledger', 'verify'], A);
    if (!r.stdout.includes(`${apiV.checked} record(s)`)) { apiV = (await api<{ valid: boolean; checked: number; errors: string[] }>(request, '/api/ledger/verify')).body; r = await runCli(['ledger', 'verify'], A); }
    expect(r.code, r.stderr || r.stdout).toBe(0);
    expect(apiV).toEqual({ valid: true, checked: apiV.checked, errors: [] });
    expect(r.stdout.trim()).toBe(`✓ ledger valid — ${apiV.checked} record(s) checked (hashes, signatures, imported chain linkage)`);

    r = await runCli(['ledger', 'graph'], A);
    expect(r.code, r.stderr || r.stdout).toBe(0);
    const g = r.stdout.split('\n');
    expect(g[0]).toBe('lineage (child → parent edges, royalties flow upward)');
    const i6 = g.findIndex((l) => l === `krx-all-2761-ep6 [${MODEL} · krx-ticker-codes] SUPERSEDED`);
    expect(i6).toBeGreaterThan(0);
    expect(g[i6 + 1]).toBe(`└─ krx-all-2761-ep12 [${MODEL} · krx-ticker-codes] SUPERSEDED`);
    expect(g[i6 + 2]).toBe(`   └─ krx-all-2761 [${MODEL} · krx-ticker-codes] LISTED  supersedes krx-all-2761-ep12, krx-all-2761-ep6, pixelplus-087600`);
    expect(g).toContain(`pixelplus-087600 [${MODEL} · krx-ticker-codes] SUPERSEDED`);

    const out = join(SCRATCH, `ainize-ledger-${RUN}.jsonl`);
    r = await runCli(['ledger', 'export', out], A);
    expect(r.code, r.stderr || r.stdout).toBe(0);
    const n = Number(/✓ exported (\d+) record\(s\) to /.exec(r.stdout)![1]);
    expect(r.stdout.trim()).toBe(`✓ exported ${n} record(s) to ${out}`);
    const linesOut = readFileSync(out, 'utf8').split('\n').filter(Boolean);
    expect(linesOut.length).toBe(n);
    expect(n).toBeGreaterThanOrEqual(recordsA);
    const recs = linesOut.map((l) => JSON.parse(l) as Record<string, unknown>);
    const firstAnchor = recs.find((x) => x.kind === 'anchor')!;
    expect(Object.keys(firstAnchor).sort().slice(0, 6)).toEqual(['author', 'body', 'hash', 'kind', 'parents', 'sig']);
    expect(Object.keys(firstAnchor).sort()).toContain('ts');
    const stamped = recs.filter((x) => typeof x.ts === 'number').map((x) => x.ts as number);
    expect(stamped.every((t, i) => i === 0 || t >= stamped[i - 1])).toBe(true);   // oldest first

    r = await runCli(['ledger', 'ls', '--limit', '1'], { home: tmpHome('anon'), node: NODE_B });
    expect(r.code, r.stderr || r.stdout).toBe(0);
    expect(r.stdout).toMatch(/^ledger\s+ain · ain:local/m);
    const recordsB = Number(/^records\s+(\d+)$/m.exec(r.stdout)![1]);
    const recordsANow = (await api<{ ledger: { records: number } }>(request, '/api/info')).body.ledger.records;
    expect(recordsB).toBe(recordsANow);

    // an unrecognised kind is refused with the list, not answered with "ledger is empty" under a four-figure count
    r = await runCli(['ledger', 'ls', '--kind', 'bogus'], A);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Argument: kind, Given: "bogus", Choices: "anchor", "attest", "settle", "challenge", "branch", "node", "supersede", "subscribe"');
    // …and a real kind that matches nothing says so against the real record count
    r = await runCli(['ledger', 'ls', '--kind', 'subscribe', '--limit', '1'], A);
    expect(r.code, r.stderr).toBe(0);
    const totalRecords = Number(/^records\s+(\d+)$/m.exec(r.stdout)![1]);
    if (!r.stdout.includes('SUMMARY')) expect(r.stdout.trim().endsWith(`no records of kind 'subscribe' (${totalRecords} record(s) in the ledger)`)).toBe(true);

    // a scheme-less --node is a typo, not a dead node
    const typo = await runCli(['status'], { home: HOME_A, node: 'localhost:3402' });
    expect(typo.code).toBe(2);
    expect(typo.stderr.trim()).toBe('error: --node must be a full URL — did you mean http://localhost:3402?');
  });

  test('AZ-065 Operate the local AIN chain from the CLI: `chain status`, `chain up`, `chain fund`, `chain setup` and `wallet`', async ({ request }) => {
    await cliLogin(HOME_A, NODE_A);
    const VALIDATOR = '0x00ADEc28B6a845a085e03591bE7550dd68673C1C';
    let r = await runCli(['chain', 'status'], A);
    expect(r.code, r.stderr || r.stdout).toBe(0);
    expect(r.stdout).toMatch(/^provider\s+http:\/\/localhost:8081$/m);
    expect(r.stdout).toMatch(/^reachable\s+yes$/m);
    expect(r.stdout).toMatch(/^state\s+SERVING$/m);
    expect(r.stdout).toMatch(/^health\s+true$/m);
    expect(r.stdout).toMatch(new RegExp(`^validator\\s+${VALIDATOR}$`, 'm'));
    expect(r.stdout).toMatch(/^last block\s+\d+$/m);
    expect(r.stdout).toMatch(/^container\s+ngram-ain: running$/m);

    const containersBefore = await dockerNames();
    r = await runCli(['chain', 'up'], A);
    expect(r.code, r.stderr || r.stdout).toBe(0);
    expect(r.stdout.trim()).toMatch(new RegExp(`^✓ a local AIN chain is already SERVING on :8081 \\(validator ${VALIDATOR}, block \\d+\\) — nothing to do$`));
    expect(await dockerNames()).toEqual(containersBefore);   // no second container
    r = await runCli(['chain', 'status'], A);
    expect(r.stdout).toMatch(/^container\s+ngram-ain: running$/m);

    const before = (await api<{ balance: number }>(request, '/api/chain', { node: NODE_B })).body.balance;
    r = await runCli(['chain', 'fund', ADDR_B, '10'], A);
    expect(r.code, r.stderr || r.stdout).toBe(0);
    const m = new RegExp(`^✓ funded ${ADDR_B} with 10 AIN {2}tx 0x[0-9a-f]+ {2}balance now ([\\d.]+) AIN$`).exec(r.stdout.trim());
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeCloseTo(before + 10, 3);
    const after = await pollUntil(async () => (await api<{ balance: number }>(request, '/api/chain', { node: NODE_B })).body.balance, (b) => Math.abs(b - (before + 10)) < 1e-6, 30_000, 2000);
    expect(after).toBeCloseTo(before + 10, 3);

    r = await runCli(['chain', 'fund', 'notanaddress'], A);
    expect(r.code).toBe(1);
    expect(r.stderr.trim()).toBe('error: address must be a 0x-prefixed 20-byte hex address');
    r = await runCli(['chain', 'fund', ADDR_B, '1', '--provider', 'http://example.com:8081'], A);
    expect(r.code).toBe(1);
    expect(r.stderr.trim()).toBe('error: refusing to use the genesis key against a non-local chain (http://example.com:8081)');

    r = await runCli(['chain', 'setup'], A);
    expect(r.code, r.stderr || r.stdout).toBe(0);
    expect(r.stdout.trim()).toBe(`✓ knowledge app already exists (admin ${ADDR_A}) — rules refreshed if we are admin`);

    r = await runCli(['wallet'], A);
    expect(r.code, r.stderr || r.stdout).toBe(0);
    expect(r.stdout).toMatch(/^ledger\s+ain · ain:local$/m);
    expect(r.stdout).toMatch(/^balance\s+[\d.]+ AIN$/m);
    expect(r.stdout).toMatch(/^sales\s+\d+$/m);
    expect(r.stdout).toMatch(/^royalties received\s+\d+$/m);
    expect(r.stdout).toMatch(/^purchases\s+\d+$/m);
    const chain = (await api<Record<string, unknown>>(request, '/api/chain')).body;
    expect(chain).toMatchObject({ kind: 'ain', network: 'ain:local', provider: 'http://localhost:8081', app: '/apps/knowledge', valid: true, address: ADDR_A });
    expect(typeof chain.height).toBe('number');
    expect(typeof chain.records).toBe('number');
    expect(typeof chain.balance).toBe('number');

    r = await runCli(['chain', 'status', '--provider', 'http://localhost:9'], A);
    expect(r.code, r.stderr || r.stdout).toBe(0);
    expect(r.stdout).toMatch(/^provider\s+http:\/\/localhost:9$/m);
    expect(r.stdout).toMatch(/^reachable\s+no$/m);
    expect(r.stdout).toMatch(/^state\s+-$/m);
    expect(r.stdout).toMatch(/^health\s+-$/m);
    expect(r.stdout).toMatch(/^container\s+ngram-ain: running$/m);
  });

  test('AZ-070 Check the aindrive mirror: `drive status --files`, `drive sync`, `drive up` before pairing, and the changes API guard', async ({ request }) => {
    await cliLogin(HOME_A, NODE_A);
    const folder = join(HOME_A, 'data', 'drive');
    const drive = (await api<{ configured: boolean }>(request, '/api/drive')).body;
    expect(drive.configured).toBe(false);

    let r = await runCli(['drive', 'status'], A);
    expect(r.code, r.stderr || r.stdout).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`^folder\\s+${esc(folder)}$`, 'm'));
    expect(r.stdout).toMatch(/^paired\s+no — run `ainize drive login`$/m);
    expect(r.stdout).toMatch(/^agent\s+stopped$/m);
    expect(r.stdout).toMatch(/^server\s+https:\/\/aindrive\.ainetwork\.ai$/m);
    expect(r.stdout).toMatch(/^drive id\s+-$/m);
    expect(r.stdout).toMatch(/^url\s+-$/m);
    expect(r.stdout).toMatch(/^files\s+\d+$/m);

    r = await runCli(['drive', 'status', '--files'], A);
    expect(r.stdout).toMatch(/^PATH\s+SIZE\s+MODIFIED\s*$/m);
    for (const p of ['branches/finance__KRX-latest.json', 'branches/finance__KRX-history.json', 'ledger/records.jsonl', `patches/${K.final}/manifest.json`, `patches/${K.pixel}/benchmark.json`]) {
      expect(r.stdout).toMatch(new RegExp(`^${esc(p)}\\s+[\\d.]+ (B|KB|MB)\\s+\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d$`, 'm'));
    }

    r = await runCli(['drive', 'sync'], A);
    expect(r.code, r.stderr || r.stdout).toBe(0);
    expect(r.stdout.trim()).toMatch(/^✓ drive folder synced \(\d+ file\(s\) written\)$/);

    r = await runCli(['drive', 'up'], A);
    expect(r.code, r.stderr || r.stdout).toBe(0);
    expect(r.stdout.trim()).toBe(`! drive not paired yet — run: cd ${folder} && npx aindrive login --server https://aindrive.ainetwork.ai   # one-time browser pairing, then: ainize drive up`);

    r = await runCli(['drive', 'stop'], A);
    expect(r.code, r.stderr || r.stdout).toBe(0);
    expect(r.stdout.trim()).toBe('✓ not running');

    const ch = await api<unknown>(request, '/api/drive/changes?path=ledger/records.jsonl');
    expect(ch.status).toBe(200);
    expect(typeof ch.body).toBe('object');
    const trav = await api<{ error: string }>(request, '/api/drive/changes?path=../config.json');
    expect([trav.status, trav.body.error]).toEqual([400, 'path must be relative to the drive folder']);
    const up = await api<{ error: string }>(request, '/api/drive', { method: 'POST', data: { action: 'up' } });
    expect([up.status, up.body.error]).toEqual([401, 'operator login required']);

    // drive login: prints the pairing header, then hands over to `aindrive login` (browser pairing) — Ctrl+C after the header.
    const p = spawnCli(['drive', 'login', '--no-open'], { ...A, group: true });
    const gotHeader = await Promise.race([p.waitFor(/aindrive pairing/, 30_000), p.done.then(() => /aindrive pairing/.test(p.output()))]);
    await Promise.race([sleep(8000), p.done]);   // give `aindrive login` a moment to print its link
    p.kill('SIGINT');
    await Promise.race([p.done, sleep(5000)]);
    p.kill('SIGKILL');
    const outp = p.output(); const errp = p.stderr();
    expect(errp).not.toContain('Unknown argument');   // `--no-open` must be accepted by the CLI parser
    if (/aindrive CLI not installed/.test(errp)) {
      expect(errp).toContain('error: aindrive CLI not installed (npm install aindrive)');
    } else {
      expect(gotHeader).toBe(true);
      expect(outp).toMatch(/^aindrive pairing$/m);
      expect(outp).toMatch(new RegExp(`^ {2}folder : ${esc(folder)}$`, 'm'));
      expect(outp).toMatch(/^ {2}server : https:\/\/aindrive\.ainetwork\.ai$/m);
      expect(outp).toContain('A browser sign-in link will be printed — open it, click Authorize, and this folder becomes a drive.');
      expect(outp).toContain('After pairing, Ctrl+C here and run `ainize drive up` to serve it in the background.');
    }
  });

  test('AZ-058 Read node events with `ainize logs` filters and confirm `ainize seed` refuses to run against a live node', async ({ request }) => {
    // 1 seed guard — exercised from a throwaway home (config for a local-ledger node) pointed at the live node-a API,
    //   so a broken guard could only ever seed the throwaway directory, never the cluster's data.
    const seedHome = tmpHome('seed-guard');
    const init = await runCli(['init', '--name', 'e2e-seed-guard', '--port', '3499', '--ledger', 'local'], { home: seedHome });
    expect(init.code, init.stderr || init.stdout).toBe(0);
    const totalBefore = (await api<{ total: number }>(request, '/api/catalog')).body.total;
    let r = await runCli(['seed'], { home: seedHome, node: NODE_A, timeoutMs: 120_000 });
    expect(r.code).toBe(1);
    expect(r.stderr.trim()).toBe(`error: a node is running at ${NODE_A}; seeding writes to its data directory — stop it first (\`ainize stop\`) or seed from the web console`);
    expect((await api<{ total: number }>(request, '/api/catalog')).body.total).toBe(totalBefore);

    // 2 verify events on node-b
    r = await runCli(['logs', '--kind', 'verify', '--limit', '500'], B);
    expect(r.code, r.stderr || r.stdout).toBe(0);
    const vlines = r.stdout.split('\n').filter(Boolean);
    expect(vlines.length).toBeGreaterThan(0);
    for (const l of vlines) expect(l).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d info {2}verify {4}\[[^\]]+\] attested \S+: (PASS|FAIL) \(.+\)$/);
    expect(vlines.some((l) => l.endsWith(`[krx-all-2761] attested krx-all-2761: PASS (vllm:${MODEL})`))).toBe(true);

    // 3 per-patch events
    r = await runCli(['logs', '--patch', K.final, '--limit', '20'], A);
    expect(r.code, r.stderr || r.stdout).toBe(0);
    const plines = r.stdout.split('\n').filter(Boolean);
    expect(plines.length).toBeGreaterThan(0);
    for (const l of plines) expect(l).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d (info|warn|error) {1,2}\S+\s+\[krx-all-2761\] /);
    expect(plines.some((l) => /\s(verifier|verify|publish|trade|usage|buy|runtime)\s/.test(l))).toBe(true);

    // 4 JSON
    r = await runCli(['logs', '--limit', '3', '--json'], A);
    expect(r.code, r.stderr || r.stdout).toBe(0);
    const arr = JSON.parse(r.stdout) as Record<string, unknown>[];
    expect(Array.isArray(arr) && arr.length <= 3 && arr.length > 0).toBe(true);
    for (const e of arr) expect(Object.keys(e).sort()).toEqual(['data', 'kind', 'level', 'message', 'patch_id', 'seq', 'ts']);

    // 5 follow + a live test from a distinct visitor address
    const ip = `10.58.${(Date.now() >> 8) & 255}.${Date.now() & 255}`;
    const follow = spawnCli(['logs', '--follow'], A);
    await sleep(3000);
    const chat = await pollUntil(async () => { await waitForRuntime(request); return chatApi(request, { patch_id: K.pixel, mode: 'base', max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] }, { ip }); }, (x) => x.status === 200, 8 * 60_000, 15_000);
    expect(chat.status).toBe(200);
    const seen = await follow.waitFor(new RegExp(`usage {5}\\[pixelplus-087600\\] live test pixelplus-087600 \\(base\\) by ip:${esc(ip)}: base only`), 30_000);
    follow.child.kill('SIGINT');
    const code = await Promise.race([follow.done, sleep(5000).then(() => 'hung' as const)]);
    expect(seen).toBe(true);
    expect(code).not.toBe('hung');

    // 6 an unrecognised kind is refused with the list, never answered with an empty screen
    r = await runCli(['logs', '--kind', 'nosuchkind'], A);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Argument: kind, Given: "nosuchkind", Choices:');
    expect(r.stderr).toContain('"challenge"');

    // 7 the operator's own terminal is the operator view (the CLI sends its token); a visitor never sees draft lines
    await cliLogin(HOME_A, NODE_A);
    r = await runCli(['logs', '--kind', 'patch', '--limit', '20'], A);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d info {2}patch {5}\[[^\]]+\] draft /m);
    const visitorHome = tmpHome('logs-visitor');
    r = await runCli(['logs', '--kind', 'patch', '--limit', '20'], { home: visitorHome, node: NODE_A });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe("(no events match kind 'patch' — and you are not logged in, so teach and draft lines are hidden; run `ainize login`)");

    // 8 --level is a floor, and an empty filtered result says which filter emptied it
    r = await runCli(['logs', '--level', 'warn', '--limit', '20'], A);
    expect(r.code, r.stderr).toBe(0);
    for (const l of r.stdout.split('\n').filter(Boolean)) expect(l).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d (warn |error)/);
    r = await runCli(['logs', '--kind', 'challenge'], A);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe("(no events match kind 'challenge')");
  });

  test('AZ-061 Register a draft with `ainize publish --no-announce`, check its visibility, reject bad inputs and delete it', async ({ request }) => {
    await cliLogin(HOME_A, NODE_A);
    const BENCH = benchJson('krx-ticker-codes');
    const id = uid('o06-draft', test.info().retry);
    let r = await runCli(['publish', './missing.npz', '--name', 'x', '--model', MODEL, '--benchmark', BENCH], { ...A, cwd: REPO });
    expect(r.code).toBe(1);
    expect(r.stderr.trim()).toBe(`error: file not found: ${REPO}/missing.npz`);
    r = await runCli(['publish', 'README.md', '--name', 'x', '--model', MODEL, '--benchmark', BENCH], { ...A, cwd: REPO });
    expect(r.code).toBe(1);
    expect(r.stderr.trim()).toBe('error: patch body must be a .npz (addrs/before/after arrays)');
    r = await runCli(['publish', PIXEL_NPZ, '--name', 'x', '--model', MODEL, '--benchmark', '{"queries":1}'], { ...A, cwd: REPO });
    expect(r.code).toBe(1);
    expect(r.stderr.trim()).toBe('error: benchmark.schema is required (e.g. "krx-ticker-codes")');

    const anchorsBefore = (await api<{ records: unknown[] }>(request, '/api/ledger?kind=anchor&limit=1000')).body.records.length;
    r = await runCli(['publish', PIXEL_NPZ, '--id', id, '--name', 'O06 draft test', '--model', MODEL, '--benchmark', BENCH, '--price', '0.1', '--no-announce'], A);
    expect(r.code, r.stderr || r.stdout).toBe(0);
    expect(r.stdout.split('\n').filter(Boolean)).toEqual([
      `✓ draft created: ${id}  (2,992 rows, sha256 ${PIXEL_SHA.slice(0, 12)}…)`,
      `✓ announce when ready: ainize patch announce ${id}`,
    ]);
    expect((await api<{ records: unknown[] }>(request, '/api/ledger?kind=anchor&limit=1000')).body.records.length).toBe(anchorsBefore);

    r = await runCli(['patch', 'ls'], A);
    expect(r.stdout).not.toContain(id);
    r = await runCli(['patch', 'ls', '--drafts'], A);
    expect(r.stdout).toMatch(new RegExp(`^${esc(id)}\\s+DRAFT\\s+node-a ${esc(shortAddr(ADDR_A, 4))}\\s+${esc(MODEL)}\\s+2,992\\s+3\\.7 MB\\s+0\\.1 AIN\\s+0/2\\s+\\d+\\s+krx-ticker-codes\\s*$`, 'm'));

    expect((await api(request, `/api/patches/${id}`)).status).toBe(404);

    r = await runCli(['patch', 'conflicts', id], A);
    expect(r.code, r.stderr || r.stdout).toBe(0);
    expect(r.stdout).toMatch(/^pixelplus-087600\s+2,992\s+yes\s+SUPERSEDED$/m);
    expect(r.stdout).toMatch(/^krx-all-2761\s+2,170\s+yes\s+LISTED\s*$/m);
    expect(r.stdout).toMatch(/^krx-all-2761-ep12\s+[\d,]+\s+yes\s+SUPERSEDED$/m);
    expect(r.stdout).toMatch(/^krx-all-2761-ep6\s+[\d,]+\s+yes\s+SUPERSEDED$/m);

    r = await runCli(['use', id], A);
    expect(r.code).toBe(1);
    expect(r.stderr.trim()).toBe(`error: ${id} is DRAFT (verification 0/2) — not verified yet; try \`ainize patch get ${id}\``);

    r = await runCli(['patch', 'rm', id], A);
    expect(r.code, r.stderr || r.stdout).toBe(0);
    expect(r.stdout.trim()).toBe(`✓ draft ${id} deleted`);
    r = await runCli(['patch', 'ls', '--drafts'], A);
    expect(r.stdout).not.toContain(id);
  });
});

// =====================================================================================================================
// Shared-model scenarios (live tests, quota, subscriptions, announce + real verification) — strictly serial
// =====================================================================================================================
test.describe('operator: runtime', () => {
  // Not serial: every test logs in and waits for the shared runtime itself, so a vLLM hiccup in one must not skip the rest.

  test('AZ-054 Live-test knowledge from the CLI: `chat --list`, one-shot compare, `--mode`, `--thinking`, `--json`, quota footer and the interactive REPL', async ({ request }) => {
    test.setTimeout(20 * 60_000);
    await cliLogin(HOME_A, NODE_A);
    await waitForRuntime(request);
    const Q = '종목코드 픽셀플러스';

    let r = await runCli(['chat'], A);
    expect(r.code).toBe(1);
    expect(r.stderr.trim()).toBe('error: patch id required — `ainize chat --list` shows what this node can test');

    // the help has always documented 1–1024: the CLI checks it itself instead of forwarding the node's zod sentence
    r = await runCli(['chat', K.pixel, 'x', '--max-tokens', '5000'], A);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('error: --max-tokens must be a whole number between 1 and 1024 (got 5000)');

    r = await withRuntime(request, () => runCli(['chat', '--list'], A));
    expect(r.code, r.stderr || r.stdout).toBe(0);
    const l = r.stdout.split('\n');
    expect(l[0].startsWith(`runtime ready  model ${MODEL}  live-apply hook on`)).toBe(true);
    expect(r.stdout).toMatch(/^ID\s+NAME\s+MODEL\s+FACTS\s+MEMORY ROWS\s+VERIFIED\s+TRY\s*$/m);
    for (const id of [K.final, K.ep12, K.ep6, K.pixel]) expect(r.stdout).toMatch(new RegExp(`^${esc(id)}\\s+.+\\s+${esc(MODEL)}\\s+\\d+\\s+[\\d,]+\\s+2/2 ✓\\s+"종목코드 픽셀플러스" → 087600$`, 'm'));
    expect(r.stdout).toContain('ainize chat <ID> "<question>"   or   ainize chat <ID>   for an interactive session');

    r = await withRuntime(request, () => runCli(['chat', K.pixel, Q], A));
    expect(r.code, r.stderr || r.stdout).toBe(0);
    expect(r.stdout).toMatch(/^before \(base model\) {2}\d+ ms$/m);
    expect(r.stdout).toMatch(/^after \(pixelplus-087600 loaded\) {2}\d+ ms · loaded in \d+ ms$/m);
    expect(r.stdout.slice(r.stdout.indexOf('after ('))).toContain('087600');
    expect(r.stdout).toMatch(new RegExp(`^correct ✓ \\(benchmark\\) {2}model ${esc(MODEL)}$`, 'm'));
    expect(r.stdout).not.toContain('free live tests left');

    r = await withRuntime(request, () => runCli(['chat', K.pixel, '--mode', 'base', Q], A));
    expect(r.code, r.stderr || r.stdout).toBe(0);
    expect(r.stdout).toMatch(/^before \(base model\) {2}\d+ ms$/m);
    expect(r.stdout).not.toContain('after (');
    expect(r.stdout).not.toMatch(/correct ✓|wrong ✗|no benchmark sample/);
    r = await withRuntime(request, () => runCli(['chat', K.pixel, '--mode', 'patched', Q], A));
    expect(r.code, r.stderr || r.stdout).toBe(0);
    expect(r.stdout).not.toContain('before (base model)');
    expect(r.stdout).toMatch(/^after \(pixelplus-087600 loaded\) {2}\d+ ms/m);
    expect(r.stdout).toMatch(/^correct ✓ \(benchmark\) {2}model /m);

    r = await withRuntime(request, () => runCli(['chat', K.pixel, '--thinking', '--max-tokens', '400', '픽셀플러스의 종목코드는?'], A));
    expect(r.code, r.stderr || r.stdout).toBe(0);
    expect(r.stdout).toMatch(/^ {2}┆ /m);
    expect(r.stdout.indexOf('┆')).toBeLessThan(r.stdout.indexOf('correct') > 0 ? r.stdout.indexOf('correct') : r.stdout.length);

    r = await withRuntime(request, () => runCli(['--json', 'chat', K.pixel, Q], A));
    expect(r.code, r.stderr || r.stdout).toBe(0);
    const j = JSON.parse(r.stdout) as Record<string, unknown>;   // the whole stdout must be one JSON document
    // multi-knowledge chat adds the plural fields (patch_ids / benchmark_hits / applied) next to the single-knowledge ones
    // `history` is what each column was actually sent — {base, patched, split} (finding 1: compare mode replays
    // one conversation per column, and the node reports which)
    expect(Object.keys(j).sort()).toEqual(['applied', 'applied_ms', 'base', 'benchmark_hit', 'benchmark_hits', 'history', 'mode', 'model', 'patch_id', 'patch_ids', 'patched', 'quota_limit', 'remaining_quota', 'was_applied']);
    expect(j.history).toEqual({ base: 1, patched: 1, split: false });   // one question, no history to split yet
    expect(j.patch_ids).toEqual([K.pixel]);

    // anonymous visitor (empty home, --node) → quota footer; another suite may already have used up this IP's hour
    r = await withRuntime(request, () => runCli(['chat', K.pixel, '--mode', 'base', Q], { home: tmpHome('anon'), node: NODE_A }));
    if (r.code === 0) {
      const m = /free live tests left this hour: (\d+)$/.exec(r.stdout.trim());
      expect(m).not.toBeNull();
      expect(Number(m![1])).toBeLessThanOrEqual(19);
    } else {
      expect(r.stderr).toContain('free live-test quota exhausted for this hour');
    }

    // 8 — interactive session, typed one line at a time (each command after the previous answer, like a person would)
    await waitForRuntime(request);
    const repl = spawnCli(['chat', K.final, '--mode', 'patched'], A);
    const type = async (line: string, until: RegExp, ms = 10 * 60_000) => { repl.child.stdin!.write(line + '\n'); expect(await repl.waitFor(until, ms), `waiting for ${until} after ${JSON.stringify(line)}\n${repl.output()}\n${repl.stderr()}`).toBe(true); };
    expect(await repl.waitFor(new RegExp(`live test of ${esc(K.final)} · mode patched · /quit to exit, /help for commands`), 30_000)).toBe(true);
    await type('종목코드 삼성전자', /correct ✓ \(benchmark\)|wrong ✗ \(benchmark\)|no benchmark sample|error: /);
    await type('/mode compare', /mode → compare/, 10_000);
    await type('/help', /\/quit {4}exit/, 10_000);
    await type('/reset', /transcript cleared/, 10_000);
    repl.child.stdin!.write('/quit\n');
    const replCode = await Promise.race([repl.done, sleep(15_000).then(() => 'hung' as const)]);
    const replOut = repl.output();
    expect(replCode).toBe(0);
    expect(replOut).not.toContain('you>');   // no prompt echo when stdin is not a TTY
    expect(replOut).toMatch(/^after \(krx-all-2761 loaded\) {2}\d+ ms/m);
    expect(replOut.slice(replOut.indexOf('after ('))).toContain('005930');
    expect(replOut).toMatch(/^correct ✓ \(benchmark\) {2}model /m);
    expect(replOut).toContain('mode → compare');
    expect(replOut).toContain('/mode base|patched|compare  (now: compare)');
    expect(replOut).toContain('/reset   forget the transcript');
    expect(replOut).toContain('/quit    exit');
    expect(replOut).toContain('transcript cleared');
    expect(replOut.trim().endsWith('bye — 1 turn(s)')).toBe(true);

    // 9 — the same through a plain pipe (printf … | ainize chat …)
    r = await withRuntime(request, () => runCli(['chat', K.final, '--mode', 'patched'], { ...A, input: '종목코드 삼성전자\n/quit\n', timeoutMs: 15 * 60_000 }));
    expect(r.code, r.stderr || r.stdout).toBe(0);
    expect(r.stdout).not.toContain('you>');
    expect(r.stdout).toMatch(/^after \(krx-all-2761 loaded\) {2}\d+ ms/m);
    expect(r.stdout.trim().endsWith('bye — 1 turn(s)')).toBe(true);
    const rt = (await api<{ applied: unknown[] }>(request, '/api/runtime')).body;
    expect(rt.applied.filter((a) => (a as { patch_id: string }).patch_id === K.final || (a as { patch_id: string }).patch_id === K.pixel)).toEqual([]);
  });

  test('AZ-066 Exhaust the anonymous live-test quota (20/hour per IP) via POST /api/chat and confirm operators are unmetered and failed calls are not charged', async ({ request, playwright }) => {
    test.setTimeout(20 * 60_000);
    // Each run uses its own visitor address (X-Forwarded-For is honoured: `trust proxy`), so the shared 127.0.0.1 bucket stays untouched.
    const ip = `10.66.${(Date.now() >> 8) & 255}.${Date.now() & 255}`;
    const BODY = { patch_id: K.pixel, mode: 'base', max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] };
    // the operator login goes through its own request context: the session cookie it sets must not leak into the anonymous calls
    const opCtx = await playwright.request.newContext();
    const token = await operatorToken(opCtx, NODE_A);
    await waitForRuntime(request);

    let r = await chatApi(request, { patch_id: K.pixel, messages: [] }, { ip });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid request');
    expect(Array.isArray(r.body.issues)).toBe(true);

    r = await chatApi(request, { patch_id: 'no-such-patch', messages: [{ role: 'user', content: 'hi' }] }, { ip });
    expect(r.body.error).toBe('patch not found: no-such-patch');   // multi-knowledge chat names the id that is missing
    expect(r.status).toBe(404);   // was 500 (a thrown market error) when the scenario was written; MarketError now maps not-found to 404

    const remaining: number[] = [];
    let first: Record<string, unknown> | null = null;
    while (remaining.length < 20) {
      const x = await chatApi(request, BODY, { ip });
      if (x.status !== 200) {   // runtime hiccup (vLLM restart / busy) — not charged, wait and retry
        expect([429, 500, 503]).toContain(x.status);
        expect(x.status).not.toBe(429);
        await sleep(15_000); await waitForRuntime(request); continue;
      }
      if (!first) first = x.body;
      remaining.push(x.body.remaining_quota as number);
    }
    expect([first!.remaining_quota, first!.quota_limit, first!.patched, first!.base !== null]).toEqual([19, 20, null, true]);
    expect(remaining).toEqual(Array.from({ length: 20 }, (_, i) => 19 - i));

    r = await chatApi(request, BODY, { ip });
    expect([r.status, r.body.error]).toEqual([429, 'quota_chat: free live-test quota exhausted for this hour — buy the patch or run your own node']);

    r = await pollUntil(() => chatApi(opCtx, BODY, { ip, token }), (x) => x.status === 200, 3 * 60_000, 10_000);
    expect(r.status).toBe(200);
    expect([r.body.remaining_quota, r.body.quota_limit]).toEqual([null, null]);
    await opCtx.dispose();

    r = await pollUntil(() => chatApi(request, BODY, { ip, node: NODE_B }), (x) => x.status === 200, 3 * 60_000, 10_000);
    expect(r.status).toBe(200);
    expect(r.body.quota_limit).toBe(20);

    const logs = await runCli(['logs', '--kind', 'usage', '--limit', '3'], A);
    expect(logs.code, logs.stderr || logs.stdout).toBe(0);
    for (const l of logs.stdout.split('\n').filter(Boolean)) expect(l).toMatch(/usage {5}\[pixelplus-087600\] live test pixelplus-087600 \((base|patched|compare)\) by (ip:|operator:)\S+: (base only|patched hit=(true|false|null))$/);
    expect(logs.stdout).toMatch(new RegExp(`usage {5}\\[pixelplus-087600\\] live test pixelplus-087600 \\(base\\) by ip:${esc(ip)}: base only`));
  });

  test('AZ-064 Create a branch, add knowledge, subscribe a node and route `jurisdiction=KR` to it', async ({ request }) => {
    test.setTimeout(20 * 60_000);
    await cliLogin(HOME_A, NODE_A);
    await cliLogin(HOME_B, NODE_B);
    await waitForRuntime(request);
    const name = `e2e/KR-${RUN}${test.info().retry ? `-r${test.info().retry}` : ''}`;
    const v = `KR-${RUN}${test.info().retry ? `-r${test.info().retry}` : ''}`;
    const ctx = `jurisdiction=${v}`;
    const ctxJson = JSON.stringify({ jurisdiction: v });

    let r = await runCli(['route', ctx], A);
    expect(r.code, r.stderr || r.stdout).toBe(0);
    expect(r.stdout.trim()).toBe(`no branch matches ${ctxJson}`);

    r = await runCli(['branch', 'create', 'bad name!', '--context', ctx], A);
    expect(r.code).toBe(1);
    expect(r.stderr.trim()).toBe('error: invalid branch name');

    r = await runCli(['branch', 'create', name, '--description', 'O14 test branch', '--context', ctx], A);
    expect(r.code, r.stderr || r.stdout).toBe(0);
    expect(r.stdout.trim()).toBe(`✓ branch ${name} created ${ctxJson} with 0 patch(es)`);
    r = await runCli(['ledger', 'ls', '--kind', 'branch', '--limit', '5'], A);
    expect(r.stdout).toContain(`${name} · 0 patch(es)`);

    r = await runCli(['branch', 'add', name, K.pixel], A);
    expect(r.code, r.stderr || r.stdout).toBe(0);
    expect(r.stdout.trim()).toBe(`✓ ${K.pixel} added to ${name} (1 patches)`);

    // node-b learns the new branch from the chain on its next ledger poll — wait until it lists it before the owner check
    await pollUntil(() => runCli(['branch', 'ls'], B), (x) => x.stdout.includes(name), 90_000, 3000);
    r = await runCli(['branch', 'add', name, K.final], B);
    expect(r.code).toBe(1);
    expect(r.stderr.trim()).toBe('error: only the branch owner can add patches');

    r = await runCli(['route', ctx], A);
    expect(r.stdout.split('\n').filter(Boolean)).toEqual([`context ${ctxJson} → branch ${name} ${ctxJson}`, 'no node currently subscribes to that branch']);

    r = await withRuntime(request, () => runCli(['branch', 'subscribe', name], { ...A, timeoutMs: 15 * 60_000 }));
    expect(r.code, r.stderr || r.stdout).toBe(0);
    expect(r.stdout.trim()).toBe(`✓ subscribed ${name}  (patches acquired and applied when a runtime is available)`);
    r = await runCli(['logs', '--kind', 'runtime', '--limit', '5'], A);
    expect(r.stdout).toMatch(/runtime {3}\[pixelplus-087600\] applied pixelplus-087600: /);

    r = await pollUntil(() => runCli(['route', ctx], A), (x) => x.stdout.includes('SERVING NODE'), 60_000, 3000);
    expect(r.stdout).toMatch(/^SERVING NODE\s+ENDPOINT\s+MODEL\s+ADDRESS\s*$/m);
    expect(r.stdout).toMatch(new RegExp(`^node-a\\s+${esc(NODE_A)}\\s+${esc(MODEL)}\\s+${esc(shortAddr(ADDR_A, 8))}$`, 'm'));
    r = await runCli(['branch', 'ls'], A);
    expect(r.stdout).toMatch(new RegExp(`^${esc(name)} ✓\\s+${esc(ctx)}\\s+pixelplus-087600\\s+node-a\\s+`, 'm'));
    expect(r.stdout).toContain('finance/KRX-latest');
    expect(r.stdout).toContain('finance/KRX-history');
    expect(r.stdout.trim().endsWith('✓ = this node subscribes')).toBe(true);

    // node-b's view catches up with the add + subscribe records on its next ledger poll
    const rowB = new RegExp(`^${esc(name)}\\s+${esc(ctx)}\\s+pixelplus-087600\\s+node-a\\s+`, 'm');
    r = await pollUntil(() => runCli(['branch', 'ls'], B), (x) => rowB.test(x.stdout), 90_000, 3000);
    expect(r.stdout).toMatch(rowB);
    expect(r.stdout).not.toContain(`${name} ✓`);
    r = await runCli(['status'], A);
    expect(r.stdout).toMatch(new RegExp(`^branches\\s+.*${esc(name)}`, 'm'));

    r = await runCli(['route', `jurisdiction=US-${RUN}`], A);
    expect(r.stdout.trim()).toBe(`no branch matches ${JSON.stringify({ jurisdiction: `US-${RUN}` })}`);
    r = await runCli(['route', 'jurisdiction'], A);
    expect(r.code).toBe(1);
    expect(r.stderr.trim()).toBe('error: context must be key=value, got "jurisdiction"');

    r = await withRuntime(request, () => runCli(['branch', 'unsubscribe', name], { ...A, timeoutMs: 15 * 60_000 }));
    expect(r.code, r.stderr || r.stdout).toBe(0);
    expect(r.stdout.trim()).toBe(`✓ unsubscribed ${name}`);
    const rt = await pollUntil(() => api<{ applied: { patch_id: string }[] }>(request, '/api/runtime'), (x) => !x.body.applied.some((a) => a.patch_id === K.pixel), 60_000, 3000);
    expect(rt.body.applied.some((a) => a.patch_id === K.pixel)).toBe(false);
    r = await pollUntil(() => runCli(['route', ctx], A), (x) => x.stdout.includes('no node currently subscribes'), 60_000, 3000);
    expect(r.stdout.split('\n').filter(Boolean)).toEqual([`context ${ctxJson} → branch ${name} ${ctxJson}`, 'no node currently subscribes to that branch']);
  });

  test('AZ-052 Announce a public patch and watch node-b and node-c verify it on the real model until it is LISTED', async ({ request }) => {
    test.setTimeout(45 * 60_000);
    await cliLogin(HOME_A, NODE_A);
    await waitForRuntime(request);
    // Published with `--test` (hidden from public catalogs) and a run-unique schema so the shared catalog stays clean.
    const id = uid('o08-pixel-copy', test.info().retry);
    const schema = uid('o08-pixel-check', test.info().retry);
    const name = '[o08 test] Pixelplus ticker copy';
    let r = await runCli(['status'], A);
    expect(r.stdout).toMatch(new RegExp(`^runtime\\s+available · ${esc(MODEL)} · hook ok$`, 'm'));

    r = await runCli(['publish', PIXEL_NPZ, '--id', id, '--name', name, '--model', MODEL, '--benchmark', benchJson(schema), '--price', '0.1', '--test'], A);
    expect(r.code, r.stderr || r.stdout).toBe(0);
    const out = r.stdout.split('\n').filter(Boolean);
    expect(out[0]).toBe(`✓ draft created: ${id}  (2,992 rows, sha256 ${PIXEL_SHA.slice(0, 12)}…)`);
    expect(out[1]).toMatch(new RegExp(`^✓ announced ${esc(id)} → ledger record [0-9a-f]{16}… \\(verifiers will now attest; quorum lists it\\)$`));
    // 2 — no price quote before quorum
    const locked = await request.get(`${NODE_A}/x402/patch/${id}`);
    expect(locked.status()).toBe(423);
    expect(await locked.text()).toMatch(/^\{"error":"patch not listed yet \(verification [01]\/2\)"\}$/);
    r = await runCli(['logs', '--kind', 'publish', '--limit', '5'], A);
    const pub = new RegExp(`announced ${esc(id)} \\(conflicts: (\\d+)\\)`).exec(r.stdout);
    expect(pub).not.toBeNull();
    // The scenario's literal "conflicts: 4" is the count on a node that holds exactly the four demo bodies; what the line
    // must actually report is every knowledge on this node whose address set overlaps the new body. Asserted against the
    // node's own overlap check (the demo bodies plus the pixel copies earlier runs announced).
    // The pre-check runs inside the node and sees everything it holds, including private drafts (taught lessons), so it
    // is compared with the OPERATOR's view of the same endpoint; an anonymous caller is deliberately shown fewer,
    // because private drafts are redacted from public lineage/overlap answers.
    const opTok = await operatorToken(request, NODE_A);
    const overlaps = (await api<{ conflicts: { patch_id: string; status: string }[] }>(request, `/api/patches/${id}/conflicts`, { token: opTok })).body.conflicts;
    expect(Number(pub![1]), 'the announce pre-check counts the same overlaps GET /api/patches/:id/conflicts reports to the operator').toBe(overlaps.length);
    expect(overlaps.map((c) => c.patch_id)).toEqual(expect.arrayContaining([K.final, K.pixel]));
    const drafts = overlaps.filter((c) => c.status === 'DRAFT').length;
    test.info().annotations.push({ type: 'note', description: `announce pre-check reported conflicts: ${pub![1]} (the 4 demo bodies + the pixel copies earlier runs announced), of which ${drafts} are this node's private drafts — a visitor is shown ${overlaps.length - drafts}, because private drafts are redacted from public overlap answers` });

    // 4 — poll status on node-a until LISTED, remembering the transitions
    const seen: string[] = [];
    const final = await pollUntil(async () => {
      const g = await runCli(['patch', 'get', id], A);
      const st = /^\S.*? {2}(ANNOUNCED|VERIFYING|LISTED|REJECTED)/.exec(g.stdout.split('\n')[0] ?? '')?.[1] ?? '?';
      if (seen[seen.length - 1] !== st) seen.push(st);
      return g;
    }, (g) => / {2}LISTED/.test(g.stdout.split('\n')[0] ?? '') || /REJECTED/.test(g.stdout.split('\n')[0] ?? ''), 12 * 60_000, 10_000);
    expect(seen).toEqual(seen.filter((s) => ['ANNOUNCED', 'VERIFYING', 'LISTED'].includes(s)));
    expect(seen.indexOf('LISTED')).toBe(seen.length - 1);
    expect(final.stdout.split('\n')[0]).toBe(`${name}  LISTED  (yours)`);
    expect(final.stdout).toMatch(/^verification\s+2\/2 passed ✓ quorum$/m);
    const attRows = final.stdout.split('\n').filter((l) => /\sPASS\s|\sFAIL\s/.test(l) && /vllm:|hash-only/.test(l));
    expect(attRows.length).toBe(2);
    for (const [nm, addr] of [['node-b', ADDR_B], ['node-c', ADDR_C]]) {
      // restarts 0, then COUNTS "yes" — the column that replaced STAKE, which reported a deposit nothing escrowed
      expect(final.stdout).toMatch(new RegExp(`^${nm} ${esc(shortAddr(addr, 6))}\\s+PASS\\s+free_generation=1/1 pre_apply=\\S+\\s+vllm:${esc(MODEL)}\\s+0\\s+yes\\s+`, 'm'));
    }
    expect(attRows.some((l) => l.startsWith('node-a '))).toBe(false);

    // 3 — verifier event trail on node-b and node-c (they share the runtime lock, so sequential)
    for (const home of [HOME_B, HOME_C]) {
      const lg = await pollUntil(() => runCli(['logs', '--patch', id, '--limit', '50'], { home }), (x) => x.stdout.includes('attested'), 60_000, 5000);
      const ev = lg.stdout.split('\n').filter(Boolean);
      const iVerifying = ev.findIndex((l) => l.includes(`verifier  [${id}] verifying ${id} (${name})`));
      const iBench = ev.findIndex((l) => l.includes(`verifier  [${id}] benchmark ${id}: 1/1 restarts=0`));
      const iAtt = ev.findIndex((l) => l.includes(`verify    [${id}] attested ${id}: PASS (vllm:${MODEL})`));
      expect([home, iVerifying >= 0, iBench > iVerifying, iAtt > iBench]).toEqual([home, true, true, true]);
    }

    // 5/6 — the demo listing is untouched (different schema → not a supersede candidate); hidden anchors stay out of `patch ls`
    r = await runCli(['patch', 'ls', '--status', 'LISTED'], A);
    expect(r.stdout).toContain(K.final);
    expect(r.stdout).not.toContain(id);   // `--test` visibility (deviation from the public publish in the scenario text)
    r = await runCli(['patch', 'get', K.final], A);
    expect(r.stdout.split('\n')[0]).toContain('LISTED');
    expect(r.stdout).not.toMatch(/superseded by/i);

    // Step 5 for real — a PUBLIC announce becoming publicly LISTED. It cannot run on the shared cluster (a public anchor
    // is permanent on the demo chain and would be visible in every later catalog assertion), so the public half runs on a
    // private 3-node cluster from the same script and binaries: same publish → same two verifiers → same real model.
    const priv = await startPrivateCluster('az052-public');
    try {
      const P = { home: join(priv.home, 'node-a') };
      const pubId = 'o08-pixel-public';
      expect((await runCli(['login', '--password', 'az052-pass'], P)).code).toBe(0);
      let p = await runCli(['publish', PIXEL_NPZ, '--id', pubId, '--name', name, '--model', MODEL, '--benchmark', benchJson('o08-pixel-public-check'), '--price', '0.1'], P);
      expect(p.code, p.stderr || p.stdout).toBe(0);
      const plines = p.stdout.split('\n').filter(Boolean);
      expect(plines[0]).toBe(`✓ draft created: ${pubId}  (2,992 rows, sha256 ${PIXEL_SHA.slice(0, 12)}…)`);
      expect(plines[1]).toMatch(new RegExp(`^✓ announced ${esc(pubId)} → ledger record [0-9a-f]{16}… \\(verifiers will now attest; quorum lists it\\)$`));
      p = await runCli(['logs', '--kind', 'publish', '--limit', '5'], P);
      expect(p.stdout, 'nothing else on this node overlaps the body').toContain(`announced ${pubId} (conflicts: 0)`);

      const listed = await pollUntil(() => runCli(['patch', 'get', pubId], P), (x) => / {2}LISTED/.test(x.stdout.split('\n')[0] ?? '') || /REJECTED/.test(x.stdout.split('\n')[0] ?? ''), 15 * 60_000, 10_000);
      expect(listed.stdout.split('\n')[0]).toBe(`${name}  LISTED  (yours)`);
      expect(listed.stdout).toMatch(/^verification\s+2\/2 passed ✓ quorum$/m);
      // step 5 of the scenario: `patch ls --status LISTED` lists it, and it is public (anonymous /api/catalog sees it)
      p = await runCli(['patch', 'ls', '--status', 'LISTED'], P);
      expect(p.stdout).toContain(pubId);
      const cat = (await api<{ items: { anchor: { id: string; visibility?: string }; status: string }[] }>(request, '/api/catalog?limit=200', { node: priv.urls[0] })).body.items;
      const row = cat.find((e) => e.anchor.id === pubId);
      expect(row, 'a public announce is in the anonymous catalog').toBeTruthy();
      expect(row!.status).toBe('LISTED');
      expect(row!.anchor.visibility ?? 'public').toBe('public');
    } finally {
      await priv.stop();
    }

    // 7 — the two new attest records on the shared ledger
    r = await runCli(['ledger', 'ls', '--kind', 'attest', '--limit', '10'], A);
    const rows = ledgerRows(r.stdout).filter((l) => l.includes(`${id} · PASS · vllm:${MODEL}`));
    expect(rows.length).toBe(2);
    expect(rows.some((l) => l.includes(shortAddr(ADDR_B, 6)))).toBe(true);
    expect(rows.some((l) => l.includes(shortAddr(ADDR_C, 6)))).toBe(true);
  });

  test('AZ-068 Publish a hidden test listing with `ainize publish --test` and confirm it stays out of public catalogs and counts', async ({ request, playwright }) => {
    test.setTimeout(20 * 60_000);
    await cliLogin(HOME_A, NODE_A);
    await waitForRuntime(request);
    const id = uid('o07-hidden', test.info().retry);
    // NOTE: the scenario text uses the demo schema krx-ticker-codes; with an identical body that would make the hidden
    // listing supersede krx-all-2761 once verified (market.announce pending_supersede), so a run-unique schema is used.
    const schema = uid('o07-hidden-check', test.info().retry);
    const countsBefore = (await api<{ counts: Record<string, number> }>(request, '/api/info')).body.counts;

    let r = await runCli(['publish', PIXEL_NPZ, '--id', id, '--name', 'O07 hidden test', '--model', MODEL, '--benchmark', benchJson(schema), '--price', '0.1', '--test'], A);
    expect(r.code, r.stderr || r.stdout).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`^✓ draft created: ${esc(id)} {2}\\(2,992 rows, sha256 [0-9a-f]{12}…\\)$`, 'm'));
    expect(r.stdout).toMatch(new RegExp(`^✓ announced ${esc(id)} → ledger record [0-9a-f]{16}… \\(verifiers will now attest; quorum lists it\\)$`, 'm'));

    r = await runCli(['patch', 'ls', '--status', 'ANNOUNCED,VERIFYING,LISTED'], A);
    expect(r.stdout).not.toContain(id);
    expect((await request.get(`${NODE_A}/api/catalog`)).ok()).toBe(true);
    expect((await (await request.get(`${NODE_A}/api/catalog`)).text()).split(id).length - 1).toBe(0);

    for (const node of [NODE_A, NODE_B]) {
      const d = await pollUntil(() => api(request, `/api/patches/${id}`, { node }), (x) => x.status === 200, 60_000, 3000);
      expect([node, d.status]).toEqual([node, 200]);
    }

    r = await runCli(['ledger', 'ls', '--kind', 'anchor', '--limit', '5'], A);
    expect(r.stdout).toMatch(new RegExp(`\\sanchor\\s+.*${esc(id)} · ${esc(MODEL)} · 2992 rows`, 'm'));

    const lg = await pollUntil(() => runCli(['logs', '--kind', 'verify', '--limit', '30'], B), (x) => x.stdout.includes(`attested ${id}:`), 10 * 60_000, 10_000);
    expect(lg.stdout).toContain(`attested ${id}: PASS (vllm:${MODEL})`);
    const g = await pollUntil(() => runCli(['patch', 'get', id], A), (x) => / {2}LISTED/.test(x.stdout.split('\n')[0] ?? ''), 8 * 60_000, 10_000);
    expect(g.stdout.split('\n')[0]).toBe('O07 hidden test  LISTED  (yours)');
    r = await runCli(['patch', 'ls'], A);
    expect(r.stdout).not.toContain(id);
    expect((await (await request.get(`${NODE_A}/api/catalog`)).text()).split(id).length - 1).toBe(0);

    const countsAfter = (await api<{ counts: Record<string, number> }>(request, '/api/info')).body.counts;
    expect(countsAfter).toEqual({ patches: 4, listed: 1, verifying: 0, superseded: 3, rejected: 0 });
    expect({ ...countsAfter, patches: 0 }).toEqual({ ...countsBefore, patches: 0 });
    expect((await (await request.get(`${NODE_A}/api/chat/patches`)).text()).split(id).length - 1).toBe(0);
  });
});

// =====================================================================================================================
// Fourth node (node-d): lifecycle, peers, one-line purchases, gateway probes, verifier grace period — strictly serial
// =====================================================================================================================
test.describe('operator: fourth node', () => {
  // Not serial: each test brings node-d up itself (ensureNodeD/startNodeD) and the block-level hooks clean it up, so a
  // failure in one test must not skip the others (workers=1 keeps the file order).
  test.beforeAll(async () => { await cleanupNodeD(); });
  test.afterAll(async ({ playwright }) => {
    await cleanupNodeD();
    // all three demo nodes learned node-d through hello / peer exchange — forget it everywhere (retrying across gossip
    // rounds, since a node that still lists it would hand it back to the others) so the cluster's peer count returns to 2
    const ctx = await playwright.request.newContext();
    try {
      const tokens = new Map<string, string>();
      for (const n of [NODE_A, NODE_B, NODE_C]) tokens.set(n, await operatorToken(ctx, n));
      for (let i = 0; i < 6; i++) {
        for (const [n, t] of tokens) await api(ctx, '/api/peers', { method: 'DELETE', token: t, node: n, data: { endpoint: NODE_D } });
        await sleep(9000);
        const left = [] as string[];
        for (const n of tokens.keys()) { const peers = (await api<{ peers: { endpoint: string }[] }>(ctx, '/api/nodes', { node: n })).body.peers; if (peers.some((p) => p.endpoint === NODE_D)) left.push(n); }
        if (!left.length) break;
      }
    } finally { await ctx.dispose(); }
  });

  test('AZ-057 Bring up a fourth node with `ainize init`, fund it on the local AIN chain, start it detached, peer it with the demo cluster and stop it', async ({ request }) => {
    test.setTimeout(10 * 60_000);
    const D = { home: HOME_D };
    const cfgPath = join(HOME_D, 'config.json');
    expect(existsSync(HOME_D)).toBe(false);

    let r = await runCli(['init', '--name', 'node-d', '--port', String(PORT_D), '--ledger', 'ain', '--ain-provider', 'http://localhost:8081', '--peer', NODE_A, '--roles', 'verifier', '--public-url', NODE_D, '--runtime-api', VLLM], D);
    expect(r.code, r.stderr || r.stdout).toBe(0);
    const l = r.stdout.split('\n');
    expect(l[0]).toBe(`✓ node initialised at ${cfgPath}`);
    expect(r.stdout).toMatch(/^name\s+node-d$/m);
    expect(r.stdout).toMatch(/^address\s+0x[0-9a-fA-F]{40}$/m);
    expect(r.stdout).toMatch(new RegExp(`^port\\s+${PORT_D}$`, 'm'));
    expect(r.stdout).toMatch(/^ledger\s+ain$/m);
    expect(r.stdout).toMatch(/^roles\s+verifier$/m);
    expect(r.stdout.trim().endsWith('next: `ainize start`   (then `ainize login`, `ainize seed`)')).toBe(true);
    const cfgText = readFileSync(cfgPath, 'utf8');
    const addr = nodeAddress(HOME_D);

    r = await runCli(['init', '--name', 'node-d', '--port', String(PORT_D)], D);
    expect(r.code).toBe(1);
    expect(r.stderr.trim()).toBe(`error: config already exists at ${cfgPath} (use --force to overwrite, or \`ainize config show\`)`);
    expect(readFileSync(cfgPath, 'utf8')).toBe(cfgText);

    // node-d is a fourth node of THIS demo cluster: same serving instance (--runtime-api above) and the same patch-hook
    // mailbox, so it queues on the one cross-process lock the other three share instead of driving a second instance.
    r = await runCli(['config', 'set', 'runtime.patchDir', RUNTIME_PATCH_DIR], D);
    expect(r.code, r.stderr || r.stdout).toBe(0);
    expect(r.stdout.trim()).toBe(`✓ runtime.patchDir = ${JSON.stringify(RUNTIME_PATCH_DIR)}  (the node reads config.json when it starts)`);

    r = await runCli(['keys', 'show'], D);
    expect(r.code, r.stderr || r.stdout).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`^address\\s+${addr}$`, 'm'));
    expect(r.stdout).toMatch(/^public key\s+[0-9a-f]{128}$/m);
    expect(r.stdout.trim().endsWith('add --reveal to print the private key')).toBe(true);
    const priv = (JSON.parse(cfgText) as { identity: { privateKey: string } }).identity.privateKey;
    expect(r.stdout).not.toContain(priv);
    expect(r.stdout).not.toMatch(/^private key\s/m);

    r = await runCli(['chain', 'fund', addr, '100'], D);
    expect(r.code, r.stderr || r.stdout).toBe(0);
    expect(r.stdout.trim()).toMatch(new RegExp(`^✓ funded ${addr} with 100 AIN {2}tx 0x[0-9a-f]+ {2}balance now 100 AIN$`));

    r = await startNodeD();
    expect(r.code, r.stderr || r.stdout).toBe(0);
    const started = new RegExp(`^✓ node started in the background \\(pid (\\d+)\\) — port ${PORT_D}\\n {2}logs: ${esc(join(HOME_D, 'node.log'))} {3}stop: ainize stop$`).exec(r.stdout.trim());
    expect(started).not.toBeNull();
    const pid = Number(started![1]);
    expect(readFileSync(join(HOME_D, 'node.pid'), 'utf8').trim()).toBe(String(pid));

    r = await runCli(['start', '-d'], D);
    expect(r.code).toBe(1);
    expect(r.stderr.trim()).toBe(`error: node already running in the background (pid ${pid}) — \`ainize stop\` first`);

    r = await pollUntil(() => runCli(['status'], D), (x) => /^peers\s+3$/m.test(x.stdout), 60_000, 3000);
    expect(r.code, r.stderr || r.stdout).toBe(0);
    expect(r.stdout.split('\n')[0]).toBe(`node-d  ${NODE_D}  (pid ${pid})`);
    expect(r.stdout).toMatch(/^roles\s+verifier$/m);
    expect(r.stdout).toMatch(/^peers\s+3$/m);
    expect(r.stdout).toMatch(/^quorum\s+2$/m);
    expect(r.stdout).toMatch(/^currency\s+AIN$/m);
    const info = (await api<{ ledger: { records: number }; counts: { patches: number; listed: number } }>(request, '/api/info')).body;
    const recLine = /^ledger\s+ain · ain:local · http:\/\/localhost:8081 · (\d+) records · height \d+$/m.exec(r.stdout);
    expect(recLine).not.toBeNull();
    expect(Math.abs(Number(recLine![1]) - info.ledger.records)).toBeLessThanOrEqual(2);   // same chain; node-d's own `node` record may not have reached node-a's poll yet
    const pub = (await api<{ total: number; items: { status: string }[] }>(request, '/api/catalog?limit=200')).body;   // public (non-draft) catalog, same chain
    expect(r.stdout).toMatch(new RegExp(`^patches\\s+${pub.total} \\(${pub.items.filter((e) => e.status === 'LISTED').length} listed\\)$`, 'm'));

    r = await pollUntil(() => runCli(['peers', 'ls'], D), (x) => tableRows(x.stdout).filter((row) => !row.includes('(unreached)')).length >= 3, 30_000, 3000);
    expect(r.stdout).toMatch(new RegExp(`^${esc(NODE_A)}\\s+node-a\\s+${esc(shortAddr(ADDR_A, 8))}\\s+seller,verifier,serving\\s+\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d\\s+0$`, 'm'));
    expect(r.stdout).toMatch(new RegExp(`^${esc(NODE_B)}\\s+(node-b|\\(unreached\\))\\s+`, 'm'));
    expect(r.stdout).toMatch(new RegExp(`^${esc(NODE_C)}\\s+(node-c|\\(unreached\\))\\s+`, 'm'));
    expect(tableRows(r.stdout).length).toBe(3);

    const names = await pollUntil(async () => (await api<{ nodes: { name: string }[] }>(request, '/api/nodes')).body.nodes.map((n) => n.name), (ns) => ns.includes('node-d'), 30_000, 3000);
    expect(names).toEqual(expect.arrayContaining(['node-a', 'node-b', 'node-c', 'node-d']));

    r = await runCli(['stop'], D);
    expect(r.code, r.stderr || r.stdout).toBe(0);
    expect(r.stdout.trim()).toBe(`✓ stopped node (pid ${pid})`);
    r = await runCli(['stop'], D);
    expect(r.code, r.stderr || r.stdout).toBe(0);
    expect(r.stdout.trim()).toBe('no background node running for this NGRAM_HOME');
    expect(existsSync(join(HOME_D, 'node.pid'))).toBe(false);
    expect(await httpDown(NODE_D)).toBe(true);
  });

  test('AZ-059 Add, list and remove peers on a node and watch gossip discover the other nodes', async ({ request }) => {
    test.setTimeout(10 * 60_000);
    const D = { home: HOME_D };
    await ensureNodeD();   // node-d from AZ-057 (created here when the test runs on its own)
    let r = await startNodeD();
    expect(r.code, r.stderr || r.stdout).toBe(0);
    r = await runCli(['login', '--password', PASSWORD_D], D);
    expect(r.code, r.stderr || r.stdout).toBe(0);

    r = await runCli(['peers', 'ls'], D);
    expect(r.code, r.stderr || r.stdout).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`^${esc(NODE_A)}\\s+(node-a|\\(unreached\\))\\s+`, 'm'));

    r = await runCli(['peers', 'add', 'localhost:3403'], D);
    expect(r.code).toBe(1);
    expect(r.stderr.trim()).toBe('error: endpoint must be an http(s) URL');

    r = await runCli(['peers', 'add', `${NODE_B}/`], D);
    expect(r.code, r.stderr || r.stdout).toBe(0);
    expect(r.stdout.trim()).toBe(`✓ peer added: ${NODE_B}/`);

    await sleep(8000);
    r = await pollUntil(() => runCli(['peers', 'ls'], D), (x) => /node-a/.test(x.stdout) && /node-b/.test(x.stdout), 30_000, 3000);
    expect(r.stdout).toMatch(new RegExp(`^${esc(NODE_A)}\\s+node-a\\s+`, 'm'));
    const bRow = new RegExp(`^${esc(NODE_B)}\\s+node-b\\s+${esc(shortAddr(ADDR_B, 8))}\\s+verifier\\s+(\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d)\\s+0$`, 'm').exec(r.stdout);
    expect(bRow).not.toBeNull();
    expect(Date.now() - new Date(bRow![1]).getTime()).toBeLessThan(60_000);

    r = await runCli(['config', 'show'], D);
    expect(r.code, r.stderr || r.stdout).toBe(0);
    const cfg = JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))) as { peers: string[] };
    expect(cfg.peers).toEqual([NODE_A, NODE_B]);

    r = await runCli(['nodes'], D);
    expect(r.code, r.stderr || r.stdout).toBe(0);
    expect(r.stdout).toMatch(/^known nodes$/m);
    expect(r.stdout).toMatch(/^NAME\s+ADDRESS\s+ENDPOINT\s+ROLES\s+LEDGER\s+BRANCHES\s+BLOBS\s+LAST SEEN\s*$/m);
    for (const n of ['node-a', 'node-b', 'node-c']) expect(r.stdout).toMatch(new RegExp(`^${n}\\s+0x`, 'm'));
    expect(r.stdout).toMatch(/^node-d \(self\)\s+0x/m);
    expect(r.stdout).toMatch(/^configured peers$/m);
    expect(r.stdout).toMatch(/^ENDPOINT\s+ADDRESS\s+LAST SEEN\s+FAILURES\s*$/m);

    r = await runCli(['peers', 'rm', NODE_B], D);
    expect(r.code, r.stderr || r.stdout).toBe(0);
    expect(r.stdout.trim()).toBe(`✓ peer removed: ${NODE_B}`);
    await sleep(8000);
    r = await runCli(['peers', 'ls'], D);
    expect(r.stdout).toMatch(new RegExp(`^${esc(NODE_A)}\\s+node-a\\s+`, 'm'));
    const cfg2 = JSON.parse((await runCli(['config', 'show'], D)).stdout.replace(/^[^{]*/, '')) as { peers: string[] };
    expect(cfg2.peers).toEqual([NODE_A]);

    const anon = await api<{ error: string }>(request, '/api/peers', { method: 'POST', node: NODE_D, data: { endpoint: NODE_C } });
    expect([anon.status, anon.body.error]).toEqual([401, 'operator login required']);
  });

  test('AZ-053 Use knowledge in one line: `ainize use krx-all-2761` verifies, pays in AIN, downloads and loads it; then re-run and remove', async ({ request }) => {
    test.setTimeout(25 * 60_000);
    // Buyer = node-d (fresh identity funded in AZ-057) instead of node-b, so every run starts from "not purchased".
    const D = { home: HOME_D };
    await ensureNodeD();
    if (!nodeDPid()) expect((await startNodeD()).code).toBe(0);
    expect(await httpUp(NODE_D)).toBe(true);
    await runCli(['login', '--password', PASSWORD_D], D);
    await cliLogin(HOME_A, NODE_A);
    await waitForRuntime(request, NODE_D);
    const addrD = nodeAddress(HOME_D);
    const balBefore = (await api<{ balance: number }>(request, '/api/chain', { node: NODE_D })).body.balance;
    expect(balBefore).toBeGreaterThanOrEqual(25);
    const soldBefore = (await api<{ downloads: number }>(request, `/api/patches/${K.final}`)).body.downloads;
    const settleBefore = (await api<{ records: unknown[] }>(request, '/api/ledger?kind=settle&limit=1000')).body.records.length;

    let r = await withRuntime(request, () => runCli(['use', K.final], { ...D, timeoutMs: 20 * 60_000 }), NODE_D);
    expect(r.code, r.stderr || r.stdout).toBe(0);
    const out = r.stdout;
    expect(out).toMatch(/^✓ bought krx-all-2761 for 25 \(ain-transfer\) {2}tx 0x[0-9a-f]{14}…$/m);
    const step = (name: string, detail: string) => new RegExp(`^ {2}\\+ *\\d+ms {2}${esc(name.padEnd(9))} ${detail}$`, 'm');
    expect(out).toMatch(step('quorum', '2 attestation\\(s\\) ≥ quorum 2'));
    expect(out).toMatch(step('402', `Payment Required: 25 AIN → ${esc(ADDR_A.slice(0, 10))}… \\(ain-transfer\\)`));
    expect(out).toMatch(step('pay', 'AIN transfer tx 0x[0-9a-f]{12}…'));
    expect(out).toMatch(step('settled', 'seller confirmed; manifest sha256 [0-9a-f]{14}…'));
    expect(out).toMatch(step('download', `([\\d.]+ MB from ${esc(NODE_A)}; sha256 matches on-ledger anchor|body already present; sha256 matches on-ledger anchor)`));
    expect(out).toMatch(step('receipt', 'on-chain access receipt written \\(/apps/knowledge/access/…, tx 0x[0-9a-f]{10}…\\)'));
    expect(out).toMatch(step('apply', '.+'));
    expect(out).toMatch(new RegExp(`^ {2}body: ${esc(join(HOME_D, 'data', 'blobs', `${KRX_SHA}.npz`))}$`, 'm'));
    expect(out.trim().endsWith('✓ loaded into the model — try: ainize chat krx-all-2761 "your question"')).toBe(true);

    r = await runCli(['wallet'], D);
    expect(r.code, r.stderr || r.stdout).toBe(0);
    const bal = Number(/^balance\s+([\d.]+) AIN$/m.exec(r.stdout)![1]);
    expect(bal).toBeCloseTo(balBefore - 25, 3);
    expect(r.stdout).toMatch(/^purchases\s+1$/m);

    r = await runCli(['wallet'], A);
    expect(r.stdout).toMatch(/^recent sales$/m);
    expect(r.stdout).toMatch(new RegExp(`^krx-all-2761\\s+25 AIN\\s+${esc(shortAddr(addrD, 8))}\\s+\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d$`, 'm'));
    r = await runCli(['ledger', 'ls', '--kind', 'settle', '--limit', '5'], A);
    expect(r.stdout).toContain(`krx-all-2761 · 25 AIN · buyer ${shortAddr(addrD, 4)}`);
    for (const node of [NODE_A, NODE_B, NODE_D]) {
      const sold = await pollUntil(() => api<{ downloads: number }>(request, `/api/patches/${K.final}`, { node }), (x) => x.body.downloads === soldBefore + 1, 30_000, 3000);
      expect([node, sold.body.downloads]).toEqual([node, soldBefore + 1]);
    }
    r = await runCli(['patch', 'ls'], A);
    expect(r.stdout).toMatch(new RegExp(`^krx-all-2761\\s+LISTED\\s+.*\\s25 AIN\\s+2/2\\s+${soldBefore + 1}\\s+krx-ticker-codes\\s*$`, 'm'));
    expect((await api<{ records: unknown[] }>(request, '/api/ledger?kind=settle&limit=1000')).body.records.length).toBe(settleBefore + 1);

    r = await runCli(['patch', 'get', K.final], D);
    expect(r.stdout.split('\n')[0]).toBe('KRX ticker codes for 2,761 listed companies (final)  LISTED  purchased  applied');

    r = await withRuntime(request, () => runCli(['chat', K.final, '--mode', 'patched', '종목코드 삼성전자'], D), NODE_D);
    expect(r.code, r.stderr || r.stdout).toBe(0);
    expect(r.stdout).toMatch(/^after \(krx-all-2761 loaded\) {2}\d+ ms · already loaded$/m);
    expect(r.stdout.slice(r.stdout.indexOf('after ('))).toContain('005930');
    expect(r.stdout).toMatch(new RegExp(`^correct ✓ \\(benchmark\\) {2}model ${esc(MODEL)}$`, 'm'));

    r = await withRuntime(request, () => runCli(['use', K.final], { ...D, timeoutMs: 15 * 60_000 }), NODE_D);
    expect(r.code, r.stderr || r.stdout).toBe(0);
    const again = r.stdout.split('\n').filter(Boolean);
    expect(again[0]).toBe('✓ krx-all-2761 is already on this node (purchased)');
    expect(again[1]).toMatch(/^✓ applied krx-all-2761: /);
    expect(again[2]).toBe('✓ try it: ainize chat krx-all-2761 "your question"');
    expect((await api<{ balance: number }>(request, '/api/chain', { node: NODE_D })).body.balance).toBeCloseTo(bal, 3);

    r = await withRuntime(request, () => runCli(['patch', 'remove', K.final], D), NODE_D);
    expect(r.code, r.stderr || r.stdout).toBe(0);
    expect(r.stdout.trim()).toMatch(/^✓ removed krx-all-2761: /);
    r = await runCli(['patch', 'get', K.final], D);
    expect(r.stdout.split('\n')[0]).toBe('KRX ticker codes for 2,761 listed companies (final)  LISTED  purchased');
    expect((await api<{ applied: unknown[] }>(request, '/api/runtime', { node: NODE_D })).body.applied).toEqual([]);

    r = await runCli(['patch', 'ls', '--status', 'LISTED'], D);
    expect(r.stdout).toMatch(/^krx-all-2761\s+LISTED\s+/m);
  });

  test('AZ-062 Use a SUPERSEDED knowledge with `ainize use --no-apply` and get the newer-version note', async ({ request }) => {
    test.setTimeout(15 * 60_000);
    const D = { home: HOME_D };
    await ensureNodeD();
    if (!nodeDPid()) expect((await startNodeD()).code).toBe(0);
    expect(await httpUp(NODE_D)).toBe(true);
    await runCli(['login', '--password', PASSWORD_D], D);
    await waitForRuntime(request, NODE_D);
    const dlBefore = (await api<{ items: { anchor: { id: string }; downloads: number }[] }>(request, '/api/catalog?status=SUPERSEDED')).body.items.find((e) => e.anchor.id === K.pixel)!.downloads;

    let r = await runCli(['patch', 'get', K.pixel], D);
    expect(r.stdout.split('\n')[0]).toContain('SUPERSEDED');
    expect(r.stdout.split('\n')[0]).not.toContain('purchased');
    expect(r.stdout).toMatch(/^ {2}superseded by: krx-all-2761/m);

    r = await withRuntime(request, () => runCli(['use', K.pixel, '--no-apply'], { ...D, timeoutMs: 10 * 60_000 }), NODE_D);
    expect(r.code, r.stderr || r.stdout).toBe(0);
    const lines = r.stdout.split('\n').filter(Boolean);
    expect(lines[0]).toMatch(/^✓ note: a newer version exists on the same subject → krx-all-2761.* \(newer version available\)$/);
    expect(lines[1]).toMatch(/^✓ bought pixelplus-087600 for 0\.1 \(ain-transfer\) {2}tx 0x[0-9a-f]{14}…$/);
    const step = (name: string, detail: string) => new RegExp(`^ {2}\\+ *\\d+ms {2}${esc(name.padEnd(9))} ${detail}$`, 'm');
    expect(r.stdout).toMatch(step('quorum', '2 attestation\\(s\\) ≥ quorum 2'));
    expect(r.stdout).toMatch(step('402', 'Payment Required: 0\\.1 AIN → 0x[0-9a-fA-F]{8}… \\(ain-transfer\\)'));
    expect(r.stdout).toMatch(step('pay', 'AIN transfer tx 0x[0-9a-f]{12}…'));
    expect(r.stdout).toMatch(step('settled', 'seller confirmed; manifest sha256 [0-9a-f]{14}…'));
    expect(r.stdout).toMatch(step('download', '.*sha256 matches on-ledger anchor'));
    expect(r.stdout).toMatch(step('receipt', 'on-chain access receipt written \\(/apps/knowledge/access/…, tx 0x[0-9a-f]{10}…\\)'));
    expect(r.stdout).not.toMatch(/^ {2}\+ *\d+ms {2}apply /m);
    expect(r.stdout.trim().endsWith('✓ downloaded — load with: ainize patch apply pixelplus-087600')).toBe(true);

    r = await runCli(['patch', 'get', K.pixel], D);
    expect(r.stdout.split('\n')[0]).toBe('Pixelplus ticker code (single fact)  SUPERSEDED  purchased');
    expect((await api<{ applied: unknown[] }>(request, '/api/runtime', { node: NODE_D })).body.applied).toEqual([]);

    r = await withRuntime(request, () => runCli(['patch', 'apply', K.pixel], D), NODE_D);
    expect(r.code, r.stderr || r.stdout).toBe(0);
    expect(r.stdout.trim()).toMatch(/^✓ applied pixelplus-087600: /);
    r = await withRuntime(request, () => runCli(['patch', 'remove', K.pixel], D), NODE_D);
    expect(r.code, r.stderr || r.stdout).toBe(0);
    expect(r.stdout.trim()).toMatch(/^✓ removed pixelplus-087600: /);

    const dl = await pollUntil(async () => (await api<{ items: { anchor: { id: string }; downloads: number }[] }>(request, '/api/catalog?status=SUPERSEDED')).body.items.find((e) => e.anchor.id === K.pixel)!.downloads, (n) => n === dlBefore + 1, 30_000, 3000);
    expect(dl).toBe(dlBefore + 1);
  });

  test("AZ-056 Probe the seller gateway's X-PAYMENT validation, the 423 not-listed state and the gated blob download with curl", async ({ request }) => {
    test.setTimeout(15 * 60_000);
    await cliLogin(HOME_A, NODE_A);
    const settleBefore = (await api<{ records: unknown[] }>(request, '/api/ledger?kind=settle&limit=1000')).body.records.length;
    const x402 = async (payment: string) => {
      const r = await request.get(`${NODE_A}/x402/patch/${K.final}`, { headers: { 'x-payment': payment } });
      return [r.status(), (await r.text()).trim()];
    };
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64');
    expect(await x402('not-base64-json')).toEqual([402, '{"error":"missing or malformed X-PAYMENT"}']);
    expect(await x402(b64({ scheme: 'paypal' }))).toEqual([402, '{"error":"unsupported scheme paypal"}']);
    expect(await x402(b64({ scheme: 'ain-transfer' }))).toEqual([402, '{"error":"ain-transfer payload needs txHash"}']);
    expect(await x402(b64({ scheme: 'local-credit', nonce: 'deadbeef', from: ADDR_B, proof: '00' }))).toEqual([402, '{"error":"unknown or expired nonce"}']);

    // 423 while an item is still ANNOUNCED/VERIFYING — a fresh hidden anchor with a run-unique schema
    const id = uid('o56-verifying', test.info().retry);
    const pub = await runCli(['publish', PIXEL_NPZ, '--id', id, '--name', 'O56 gateway probe', '--model', MODEL, '--benchmark', benchJson(uid('o56-check', test.info().retry)), '--price', '0.1', '--test'], A);
    expect(pub.code, pub.stderr || pub.stdout).toBe(0);
    const locked = await request.get(`${NODE_A}/x402/patch/${id}`);
    expect(locked.status()).toBe(423);
    expect(locked.statusText()).toBe('Locked');
    expect((await locked.text()).trim()).toMatch(/^\{"error":"patch not listed yet \(verification [01]\/2\)"\}$/);

    const anonBlob = await request.get(`${NODE_A}/p2p/blob/${KRX_SHA}`);
    expect(anonBlob.status()).toBe(402);
    expect((await anonBlob.text()).trim()).toBe('{"error":"payment required: buy the patch via /x402/patch/:id (verifiers and authors are exempt)"}');
    expect((await api<{ records: unknown[] }>(request, '/api/ledger?kind=settle&limit=1000')).body.records.length).toBe(settleBefore);

    // the settled buyer's manifest download_token (node-d bought krx-all-2761 in AZ-053) unlocks the body
    if (!nodeDPid()) expect((await startNodeD()).code).toBe(0);
    expect(await httpUp(NODE_D)).toBe(true);
    const tokenD = (await (await request.post(`${NODE_D}/api/auth/login`, { data: { password: PASSWORD_D } })).json() as { token: string }).token;
    const purchases = (await api<{ items: { patch_id: string; manifest: { download_token: string } }[] }>(request, '/api/me/purchases', { node: NODE_D, token: tokenD })).body.items;
    const dl = purchases.find((p) => p.patch_id === K.final)?.manifest.download_token;
    expect(dl).toBeTruthy();
    const head = await request.head(`${NODE_A}/p2p/blob/${KRX_SHA}?token=${dl}`);
    expect(head.status()).toBe(200);
    expect(head.statusText()).toBe('OK');
    expect(head.headers()['content-type']).toBe('application/octet-stream');
    expect(head.headers()['x-content-sha256']).toBe(KRX_SHA);
    expect(head.headers()['content-disposition']).toBe(`attachment; filename="${KRX_SHA}.npz"`);
  });

  test('AZ-069 Show that a verifier whose serving API is down keeps retrying for 15 minutes instead of attesting hash-only', async ({ request }) => {
    test.setTimeout(25 * 60_000);
    const D = { home: HOME_D };
    await cliLogin(HOME_A, NODE_A);
    await ensureNodeD();
    await runCli(['stop'], D);
    let r = await runCli(['config', 'set', 'runtime.api', 'http://localhost:8999'], D);
    expect(r.code, r.stderr || r.stdout).toBe(0);
    expect(r.stdout.trim()).toBe('✓ runtime.api = "http://localhost:8999"  (the node reads config.json when it starts)');
    r = await runCli(['config', 'set', 'roles', 'verifier'], D);
    expect(r.code, r.stderr || r.stdout).toBe(0);
    r = await startNodeD();
    expect(r.code, r.stderr || r.stdout).toBe(0);
    await sleep(3000);

    r = await runCli(['status'], D);
    expect(r.stdout).toMatch(/^runtime\s+unavailable \(serving API unreachable\)$/m);

    // node-d may already hold the pixelplus body (bought/fetched earlier in this block) — drop its copy so the verifier
    // really has to fetch the body and expectation 2's `blob` line is produced on every run.
    rmSync(join(HOME_D, 'data', 'blobs', `${PIXEL_SHA}.npz`), { force: true });
    expect(((await api<{ node: { blobs: string[] } }>(request, '/api/info', { node: NODE_D })).body.node?.blobs ?? []).includes(PIXEL_SHA)).toBe(false);
    // Expectation 3 needs node-d to keep retrying for more than a minute, and it only retries while the item is
    // ANNOUNCED/VERIFYING — node-b/node-c normally list it within ~30-60 s. So the demo verifiers are held off for the
    // countdown window by taking the cross-process runtime lock they share (node-d never takes it: with a closed serving
    // port it fails before any model work). The lock is released in the `finally` below.
    const releaseLock = await holdRuntimeLock(request, 'e2e:AZ-069 grace window');
    let lockHeld = true;
    const release = () => { if (lockHeld) { lockHeld = false; releaseLock(); } };
    try {
    // a fresh announce (hidden, run-unique schema) right after node-d is up
    const id = uid('o69-grace', test.info().retry);
    const name = 'O69 grace period';
    const pub = await runCli(['publish', PIXEL_NPZ, '--id', id, '--name', name, '--model', MODEL, '--benchmark', benchJson(uid('o69-check', test.info().retry)), '--price', '0.1', '--test'], A);
    expect(pub.code, pub.stderr || pub.stdout).toBe(0);
    const lg = await pollUntil(() => runCli(['logs', '--limit', '60'], D), (x) => x.stdout.split('\n').some((l) => l.includes(`[${id}]`) && l.includes('hash-only fallback')), 150_000, 5000);
    const ev = lg.stdout.split('\n').filter((l) => l.includes(`[${id}]`));
    const iV = ev.findIndex((l) => /info {2}verifier {2}\[.*\] verifying /.test(l) && l.includes(`verifying ${id} (${name})`));
    const iB = ev.findIndex((l) => /info {2}blob {6}\[/.test(l) && l.includes(`fetched ${id} body from`));
    const iW = ev.findIndex((l) => /warn {2}verifier {2}\[/.test(l) && l.includes(`verify ${id} failed: runtime unavailable (serving API unreachable) — waiting up to 15 min before hash-only fallback`));
    expect([iV >= 0, iB > iV, iW > iB]).toEqual([true, true, true]);

    // The grace clock starts at node-d's FIRST failed attempt (after the blob fetch). node-d keeps retrying every ~5 s
    // only while the item is ANNOUNCED/VERIFYING — node-b/node-c usually list it within ~30-60 s, which ends the retries.
    const firstWarnAt = new Date(ev[iW].slice(0, 19)).getTime();
    let warns: string[] = [];
    while (Date.now() - firstWarnAt < 75_000) {
      warns = (await runCli(['logs', '--kind', 'verifier', '--limit', '80'], D)).stdout.split('\n').filter((l) => l.includes(`verify ${id} failed`));
      await sleep(5000);
    }
    expect(warns.length, 'node-d retries every ~5 s for the whole window').toBeGreaterThanOrEqual(5);
    for (const w of warns) expect(w).toMatch(/ — waiting up to 1[345] min before hash-only fallback$/);   // never a hash-only vote
    const late = warns.filter((w) => new Date(w.slice(0, 19)).getTime() - firstWarnAt >= 31_000);
    expect(late.length, 'retries continued past the first 30 s').toBeGreaterThan(0);
    expect(late[late.length - 1], 'the minute count rounds down as the grace period runs out').toMatch(/waiting up to 14 min before hash-only fallback$/);
    const addrD = nodeAddress(HOME_D);
    r = await runCli(['patch', 'records', id], A);
    expect(r.stdout).not.toContain(shortAddr(addrD, 8));
    r = await runCli(['patch', 'get', id], A);
    expect(r.stdout).not.toContain('hash-only');

    // Let the demo verifiers have the model back: they reach quorum on their own while node-d's serving port is still
    // closed, so the scenario's "third attestation" really is the third one.
    release();
    const twoRows = (x: { stdout: string }) => / {2}LISTED/.test(x.stdout.split('\n')[0] ?? '')
      && x.stdout.split('\n').filter((l) => /^node-[a-z] 0x\S+\s+PASS\s/.test(l)).length === 2;
    const quorum = await pollUntil(() => runCli(['patch', 'get', id], A), twoRows, 12 * 60_000, 5000);
    expect(quorum.stdout.split('\n')[0]).toBe(`${name}  LISTED  (yours)`);
    expect(quorum.stdout).toMatch(/^verification\s+2\/2 passed ✓ quorum$/m);
    expect(quorum.stdout, 'node-d wrote nothing while its serving API was down').not.toContain(`node-d ${shortAddr(addrD, 6)}`);
    expect(quorum.stdout).not.toContain('hash-only');

    // Step 4 — restore node-d's serving API and restart it
    r = await runCli(['config', 'set', 'runtime.api', VLLM], D);
    expect(r.stdout.trim()).toBe(`✓ runtime.api = ${JSON.stringify(VLLM)}  (the node reads config.json when it starts)`);
    r = await runCli(['stop'], D);
    expect(r.stdout.trim()).toMatch(/^✓ stopped node \(pid \d+\)$/);
    r = await startNodeD();
    expect(r.stdout).toMatch(/^✓ node started in the background/);
    await waitForRuntime(request, NODE_D);

    // Step 5 — node-d verifies the patch FOR REAL now that its runtime is back. Its background round deliberately skips
    // an item that is already LISTED (verifier.ts only picks up ANNOUNCED/VERIFYING/CHALLENGED), so the operator asks it
    // directly — the same verifyOne() the round would have called, and the only deterministic way to get the third vote.
    await waitForLockFree(request, NODE_D);
    await runCli(['login', '--password', PASSWORD_D], D);   // node-d has its own operator password (PASSWORD_D), not the cluster default
    const tokenD = ((await (await request.post(`${NODE_D}/api/auth/login`, { data: { password: PASSWORD_D } })).json()) as { token: string }).token;
    const v = await api<{ attestation: { verified_on: string; passed: boolean; verifier: string; score: Record<string, string> } }>(request, `/api/patches/${id}/verify`, { method: 'POST', token: tokenD, node: NODE_D });
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    expect(v.body.attestation.verified_on).toBe(`vllm:${MODEL}`);
    expect(v.body.attestation.passed).toBe(true);
    expect(v.body.attestation.verifier).toBe(addrD);
    const dlog2 = await pollUntil(() => runCli(['logs', '--limit', '80'], D), (x) => x.stdout.includes(`attested ${id}: `), 3 * 60_000, 5000);
    expect(dlog2.stdout).toContain(`attested ${id}: PASS (vllm:${MODEL})`);
    expect(dlog2.stdout).not.toContain('hash-only)');

    // Step 6 — node-d's row is the third attestation, VERIFIED ON the real model, on a LISTED item
    const listedWithD = (x: { stdout: string }) => x.stdout.includes(`node-d ${shortAddr(addrD, 6)}`) && / {2}LISTED/.test(x.stdout.split('\n')[0] ?? '');
    const g = await pollUntil(() => runCli(['patch', 'get', id], A), listedWithD, 12 * 60_000, 5000);
    expect(g.stdout.split('\n')[0]).toBe(`${name}  LISTED  (yours)`);
    expect(g.stdout).toMatch(new RegExp(`^node-d ${esc(shortAddr(addrD, 6))}\\s+PASS\\s+free_generation=1/1 pre_apply=\\S+\\s+vllm:${esc(MODEL)}\\s+`, 'm'));
    expect(g.stdout).not.toContain('hash-only');
    const passRows = g.stdout.split('\n').filter((l) => /^node-[a-z] 0x\S+\s+PASS\s/.test(l)).length;
    expect(passRows, 'node-b, node-c and node-d all voted PASS on the real model').toBe(3);
    // Item 146: the fraction is clamped to the quorum — a third verifier reads as "2/2 (+1 more)", never "3/2"
    expect(g.stdout).toMatch(/^verification\s+2\/2 passed ✓ quorum \(\+1 more independent attestation\)$/m);
    } finally {
      release();
    }
  });

  test('AZ-067 Restart the demo cluster with scripts/cluster-restart.sh and confirm data survives, peers re-gossip and the agent buyer still completes a 402 purchase', async ({ request }) => {
    test.setTimeout(15 * 60_000);
    await cliLogin(HOME_A, NODE_A);

    // ---- preconditions + steps 3, 5-9 on the LIVE cluster (everything that does not require bouncing it) ----
    for (const node of [NODE_A, NODE_B, NODE_C]) expect([node, (await api(request, '/api/info', { node })).status]).toEqual([node, 200]);
    const clusterHome = join(HOME_A, '..');
    const liveNodesPid = readFileSync(join(clusterHome, 'nodes.pid'), 'utf8');
    expect(liveNodesPid.split('\n').filter(Boolean).length).toBe(3);
    const sup = Number(readFileSync(join(clusterHome, 'supervisor.pid'), 'utf8').trim());
    expect(readFileSync(`/proc/${sup}/cmdline`, 'utf8').replace(/\0/g, ' ')).toContain('scripts/cluster.mjs');
    await waitForRuntime(request);
    let r = await runCli(['status'], A);
    expect(r.stdout).toMatch(new RegExp(`^runtime\\s+available · ${esc(MODEL)} · hook ok$`, 'm'));
    expect(Number(/^peers\s+(\d+)$/m.exec(r.stdout)?.[1])).toBeGreaterThanOrEqual(2);
    r = await runCli(['peers', 'ls'], A);
    for (const [ep, nm] of [[NODE_B, 'node-b'], [NODE_C, 'node-c']]) expect(r.stdout).toMatch(new RegExp(`^${esc(ep)}\\s+${nm}\\s+0x\\S+\\s+\\S+\\s+\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d\\s+0$`, 'm'));

    const keys = { ...(await agentRun(['keys'])) }; keys.stdout = strip(keys.stdout);
    expect(keys.code, keys.stderr || keys.stdout).toBe(0);
    const agentAddr = /^address\s+(0x[0-9a-fA-F]{40})$/m.exec(keys.stdout)?.[1];
    expect(agentAddr).toBeTruthy();
    expect(keys.stdout).toMatch(/^publicKey\s+[0-9a-f]+$/m);
    expect(keys.stdout).toMatch(/^home\s+\/home\/\S+\/\.ngram-agent$/m);
    r = await runCli(['chain', 'fund', agentAddr!, '5'], A);
    expect(r.stdout.trim()).toMatch(new RegExp(`^✓ funded ${agentAddr} with 5 AIN {2}tx 0x[0-9a-f]+ {2}balance now [\\d.]+ AIN$`));
    const cat = { ...(await agentRun(['catalog'])) }; cat.stdout = strip(cat.stdout);
    expect(cat.code, cat.stderr || cat.stdout).toBe(0);
    expect(cat.stdout).toMatch(/^krx-all-2761\s+LISTED\s+270053 rows {2}25 AIN {2}attest 2\/2 {2}KRX ticker codes for 2,761 listed companies \(final\)$/m);
    expect(cat.stdout).not.toContain(K.pixel);

    // ---- steps 1-7 for REAL on a private throwaway cluster (same script, same binaries, same web UI) ----
    // scripts/cluster-restart.sh may not bounce the shared demo cluster while other groups use it, so the restart
    // itself runs against a private 3-node cluster: NGRAM_CLUSTER_HOME=<scratch> NGRAM_PORT_BASE=<free port>
    // NGRAM_LEDGER=local NGRAM_SEED=0 — nothing on the shared chain, no demo seed, and the home-scoped stop
    // (matched via /proc environ) cannot touch :3402. Adaptations to the private local-ledger cluster: the
    // surviving catalog entry is a draft this test publishes itself (deterministic without the shared vLLM),
    // prices are in CREDIT, and ledger.records grows by the per-boot `node` join announcements instead of
    // staying constant (each node re-announces itself on boot).
    const portBusy = (port: number) => new Promise<boolean>((resolve) => {
      const s = connect({ port, host: '127.0.0.1' });
      s.setTimeout(1500, () => { s.destroy(); resolve(true); });
      s.once('connect', () => { s.destroy(); resolve(true); });
      s.once('error', () => resolve(false));
    });
    let base = 0;
    for (const cand of [3502, 3512, 3522, 3532, 3542]) {
      if (!(await Promise.all([cand, cand + 1, cand + 2].map(portBusy))).some(Boolean)) { base = cand; break; }
    }
    expect(base, 'no free port base found for the private cluster').toBeGreaterThan(0);
    const pHome = tmpHome('az067-cluster');
    const urls = [base, base + 1, base + 2].map((p) => `http://localhost:${p}`);
    const P = { home: join(pHome, 'node-a') };
    const restartSh = async (...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
      try {
        const o = await execFileP('bash', [join(REPO, 'scripts/cluster-restart.sh'), ...args], { env: { ...process.env, NGRAM_CLUSTER_HOME: pHome, NGRAM_PORT_BASE: String(base), NGRAM_LEDGER: 'local', NGRAM_SEED: '0' }, timeout: 120_000 });
        return { code: 0, stdout: o.stdout, stderr: o.stderr };
      } catch (e) { const err = e as { code?: number; stdout?: string; stderr?: string }; return { code: typeof err.code === 'number' ? err.code : 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }; }
    };
    const infoOf = async (u: string) => (await api<{ node: { address: string; name: string }; ledger: { records: number }; counts: Record<string, number> }>(request, '/api/info', { node: u })).body;

    try {
      // first boot (same script; on a fresh home there is nothing to stop yet)
      const boot = await restartSh();
      expect(boot.code, boot.stderr).toBe(0);
      expect(boot.stdout).toContain(`cluster starting (log: ${pHome}/cluster.log)`);
      for (const u of urls) expect(await httpUp(u, 90_000), u).toBe(true);

      // give the private node-a an operator password + a catalog entry that must survive the restart
      r = await runCli(['login', '--password', 'az067-pass'], P);
      expect(r.code, r.stderr || r.stdout).toBe(0);
      expect(r.stdout.trim()).toBe(`✓ operator password set and logged in to ${urls[0]} (token saved in ${join(pHome, 'node-a')}/cli.json)`);
      const draftId = uid('az067-keep', test.info().retry);
      r = await runCli(['publish', PIXEL_NPZ, '--id', draftId, '--name', 'AZ067 restart survivor', '--model', MODEL, '--benchmark', benchJson(uid('az067-schema', test.info().retry)), '--price', '0.1', '--no-announce'], P);
      expect(r.code, r.stderr || r.stdout).toBe(0);
      expect(r.stdout).toContain(`✓ draft created: ${draftId}  (2,992 rows, sha256 ${PIXEL_SHA.slice(0, 12)}…)`);

      // "before" snapshot (scenario precondition): identities, ledger height, counts, catalog, pid files
      const before = await Promise.all(urls.map(infoOf));
      expect(before.map((i) => i.node.name)).toEqual(['node-a', 'node-b', 'node-c']);
      const lsBefore = await runCli(['patch', 'ls', '--drafts'], P);
      expect(lsBefore.stdout).toMatch(new RegExp(`^${esc(draftId)}\\s+DRAFT\\s+node-a ${esc(shortAddr(before[0].node.address, 4))}\\s+${esc(MODEL)}\\s+2,992\\s+3\\.7 MB\\s+0\\.1 CREDIT\\s+0/2\\s+0\\s+`, 'm'));
      const supBefore = Number(readFileSync(join(pHome, 'supervisor.pid'), 'utf8').trim());
      expect(readFileSync(`/proc/${supBefore}/cmdline`, 'utf8').replace(/\0/g, ' ')).toContain('scripts/cluster.mjs');
      const pidsBefore = readFileSync(join(pHome, 'nodes.pid'), 'utf8').split('\n').filter(Boolean).map(Number);
      expect(pidsBefore.length).toBe(3);

      // step 1: the real restart (without --fresh)
      const restartedAt = Date.now();
      const res = await restartSh();
      expect(res.code, res.stderr).toBe(0);
      expect(res.stdout).toMatch(/^stopped \d+$/m);
      expect(res.stdout).toContain(`stopped ${supBefore}`);
      expect(res.stdout).toContain(`cluster starting (log: ${pHome}/cluster.log)`);

      // step 3: all three ports answer 200 again
      for (const u of urls) expect(await httpUp(u, 90_000), u).toBe(true);

      // step 2: the fresh cluster.log shows the three boot lines and the web-UI line
      const log = await pollUntil(
        () => Promise.resolve(readFileSync(join(pHome, 'cluster.log'), 'utf8')),
        (l) => ['node-a', 'node-b', 'node-c'].every((n) => l.includes(`[${n}] ainize node "${n}" listening`)) && l.includes('[cluster] web UI'),
        30_000, 1000,
      );
      expect(log).toContain(`[cluster] web UI → http://localhost:${base}   (B: ${base + 1}, C: ${base + 2}; homes under ${pHome}; ledger=local; teach backend=stub)`);
      expect(log).not.toContain('seeded node-a');   // NGRAM_SEED=0: nothing was re-seeded

      // step 4: identities, counts and the catalog survived (the ledger only gained the boot announcements)
      const after = await Promise.all(urls.map(infoOf));
      for (let i = 0; i < 3; i++) {
        expect(after[i].node.address, urls[i]).toBe(before[i].node.address);
        expect(after[i].counts, urls[i]).toEqual(before[i].counts);
        expect(after[i].ledger.records, urls[i]).toBeGreaterThanOrEqual(before[i].ledger.records);
      }
      const lsAfter = await runCli(['patch', 'ls', '--drafts'], P);
      expect(lsAfter.stdout).toBe(lsBefore.stdout);

      // step 7: a fresh supervisor + 3 fresh node pids, all alive
      const supAfter = Number(readFileSync(join(pHome, 'supervisor.pid'), 'utf8').trim());
      expect(supAfter).not.toBe(supBefore);
      expect(readFileSync(`/proc/${supAfter}/cmdline`, 'utf8').replace(/\0/g, ' ')).toContain('scripts/cluster.mjs');
      const pidsAfter = readFileSync(join(pHome, 'nodes.pid'), 'utf8').split('\n').filter(Boolean).map(Number);
      expect(pidsAfter.length).toBe(3);
      for (const pid of pidsAfter) expect(() => process.kill(pid, 0), `node pid ${pid} alive`).not.toThrow();
      expect(pidsAfter.filter((p) => pidsBefore.includes(p))).toEqual([]);

      // step 5: peers re-gossip — node-b/node-c rows with a fresh LAST SEEN (host clock is UTC) and FAILURES 0
      const peerDefs: [string, number][] = [['node-b', base + 1], ['node-c', base + 2]];
      const peerRow = (nm: string, port: number, out: string) => new RegExp(`^http://localhost:${port}\\s+${nm}\\s+0x\\S+\\s+\\S+\\s+(\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d)\\s+0$`, 'm').exec(out);
      const peers = await pollUntil(() => runCli(['peers', 'ls'], P), (o) => peerDefs.every(([nm, port]) => {
        const m = peerRow(nm, port, o.stdout);
        return !!m && Date.parse(`${m[1].replace(' ', 'T')}Z`) >= restartedAt - 60_000;
      }), 120_000, 5000);
      for (const [nm, port] of peerDefs) expect(peerRow(nm, port, peers.stdout), `${nm} re-gossiped:\n${peers.stdout}`).toBeTruthy();

      // step 6: status — same identity, local ledger intact, both peers; the script never touches the serving model
      r = await runCli(['status'], P);
      expect(r.stdout).toMatch(new RegExp(`^address\\s+${before[0].node.address}$`, 'm'));
      expect(r.stdout).toMatch(/^ledger\s+local · local · \d+ records · height \d+$/m);
      expect(r.stdout).toMatch(/^peers\s+2$/m);
      expect(r.stdout).toMatch(/^runtime\s+\S.*$/m);

      // the live demo cluster was untouched by the whole exercise (home-scoped stop)
      expect((await api(request, '/api/info', { node: NODE_A })).status).toBe(200);
      expect(Number(readFileSync(join(clusterHome, 'supervisor.pid'), 'utf8').trim())).toBe(sup);
      expect(readFileSync(join(clusterHome, 'nodes.pid'), 'utf8')).toBe(liveNodesPid);
      expect(() => process.kill(sup, 0)).not.toThrow();
      expect(nodeAddress(HOME_A)).toBe(ADDR_A);
    } finally {
      const stop = await restartSh('--stop');
      if (stop.code !== 0) {   // belt and braces: the scoped --stop failed, kill by pid file
        for (const f of ['supervisor.pid', 'nodes.pid']) {
          try { for (const pid of readFileSync(join(pHome, f), 'utf8').split('\n').filter(Boolean).map(Number)) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } } } catch { /* no file */ }
        }
      }
      for (const u of urls) await httpDown(u, 30_000);
      rmSync(pHome, { recursive: true, force: true });
    }

    // Step 10 for real, against the LIVE cluster this script brought up: the agent still completes a 402 purchase after a
    // restart. pixelplus-087600 is SUPERSEDED (the scenario's own note), so the success check buys krx-all-2761.
    await waitForRuntime(request);
    await waitForLockFree(request);
    // (the scenario's step-10 note that `--patch pixelplus-087600` is REFUSED describes older behaviour: an explicitly
    //  requested SUPERSEDED knowledge is now honoured with a note — asserted in AZ-077 — so the success check simply
    //  buys krx-all-2761 as the scenario itself prescribes)
    const settleBefore = (await api<{ records: { body: { buyer: string } }[] }>(request, '/api/ledger?kind=settle&limit=1000')).body.records.length;
    const funded = await runCli(['chain', 'fund', agentAddr!, '30'], A);
    expect(funded.code, funded.stderr || funded.stdout).toBe(0);
    const buy = await agentRun(['run', '--market', NODE_A, '--patch', K.final, '--pay', 'ain-transfer', '--json'], { timeoutMs: 20 * 60_000 });
    expect(buy.code, buy.stderr || buy.stdout).toBe(0);
    const res = JSON.parse(strip(buy.stdout)) as { success: boolean; patch_id: string | null; scheme: string; already_known: boolean; restored: boolean; steps: string[] };
    expect(res.success).toBe(true);
    expect(res.scheme).toBe('ain-transfer');
    expect(res.steps[res.steps.length - 1]).toBe('result: SUCCESS — the 402 purchase loop completed');
    if (res.already_known) {
      // documented in the scenario: with the knowledge already loaded in the shared model the agent stops at step [1]
      test.info().annotations.push({ type: 'note', description: 'the shared model already answered the benchmark question — already_known:true, patch_id null, no purchase (documented in the scenario)' });
    } else {
      expect(res.patch_id).toBe(K.final);
      const settleRecs = (await api<{ records: { body: { buyer: string; patch_id: string; amount: string } }[] }>(request, '/api/ledger?kind=settle&limit=1000')).body.records;
      expect(settleRecs.length).toBe(settleBefore + 1);
      expect(settleRecs.some((x) => x.body.buyer === agentAddr && x.body.patch_id === K.final), 'node-a settled the agent as buyer after the restart').toBe(true);
    }
  });
});

// ---------------------------------------------------------------- commands that report state (review 2, items 101/118/119/123/134/141)
test.describe('operator: commands that report state', () => {
  test('AZ-228 A machine with no node config is told so, instead of being shown whatever answers port 3402', async () => {
    test.setTimeout(4 * 60_000);
    const NOWHERE = '/no/such/dir';
    const refusal = `error: no node configured in ${NOWHERE} — run \`ainize init\` to create one, or pass --node <url> to talk to an existing node`;

    // steps 1-3: the read commands refuse instead of reporting node-a
    for (const args of [['status'], ['patch', 'ls'], ['wallet']]) {
      const r = await runCli(args, { home: NOWHERE });
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.stderr.trim(), args.join(' ')).toBe(refusal);
      expect(r.stdout, args.join(' ')).not.toContain('node-a');
      expect(r.stdout, args.join(' ')).not.toContain(ADDR_A);
      expect(r.stdout, args.join(' ')).not.toContain('krx-all-2761');
    }

    // step 4: the local config command answers for itself
    const cfg = await runCli(['config', 'show'], { home: NOWHERE });
    expect(cfg.code).toBe(1);
    expect(cfg.stderr.trim()).toBe(`error: no node config at ${NOWHERE}/config.json — run \`ainize init\` first`);

    // step 5: an explicitly named node is a target the user aimed
    const named = await runCli(['status'], { home: NOWHERE, node: NODE_A });
    expect(named.code, named.stderr).toBe(0);
    expect(named.stdout).toContain('node-a');

    // step 6: `teach status <url>` names its own node
    const teach = await runCli(['teach', 'status', NODE_A], { home: NOWHERE });
    expect(teach.code, teach.stderr).toBe(0);
    expect(teach.stdout).toContain('node-a');

    // steps 7-8: login never claims an unclaimed node the user did not name
    const t = await throwawayNode('unclaimed');
    try {
      const me = await (await fetch(`${t.url}/api/auth/me`)).json() as { needsSetup: boolean; address: string };
      expect(me.needsSetup).toBe(true);
      const other = await throwawayNode('claimer', { port: t.port, start: false });
      try {
        expect((await other.init()).code).toBe(0);
        const stolen = await runCli(['login'], { home: other.home, env: { NGRAM_PASSWORD: 'hack-me' } });
        expect(stolen.code).toBe(2);
        expect(stolen.stderr).toContain(`${t.url} is answered by "unclaimed" (${shortAddr(me.address, 8)}), which has no operator password yet`);
        expect(stolen.stderr).toContain(`Refusing to claim someone else's node; re-run with --node ${t.url}`);
        expect(((await (await fetch(`${t.url}/api/auth/me`)).json()) as { needsSetup: boolean }).needsSetup, 'still unclaimed').toBe(true);

        const named2 = await runCli(['login'], { home: other.home, node: t.url, env: { NGRAM_PASSWORD: 'hack-me' } });
        expect(named2.code, named2.stderr).toBe(0);
        expect(named2.stdout).toContain(`operator password set and logged in to ${t.url}`);
      } finally { await other.stop(); }
    } finally { await t.stop(); }
  });

  test('AZ-229 `start -d` on a busy port fails loudly, `status` refuses to pass off the stranger holding it, and `stop` never reports a process it did not stop', async () => {
    test.setTimeout(4 * 60_000);
    const a = await throwawayNode('busy-a');
    const b = await throwawayNode('busy-b', { port: a.port, start: false });
    try {
      expect((await b.init()).code).toBe(0);

      // step 1-2: the second node cannot bind, and says so with the log's own reason
      const started = await b.cli(['start', '-d']);
      expect(started.code).toBe(1);
      expect(started.stdout).not.toContain('✓');
      expect(started.stderr).toContain('error: node exited while starting (exit code 1) — it is not running.');
      expect(started.stderr).toContain(`${join(b.home, 'node.log')} (last `);
      expect(started.stderr).toContain(`error: listen EADDRINUSE: address already in use 0.0.0.0:${a.port}`);
      expect(existsSync(join(b.home, 'node.pid')), 'no pid file for a node that never answered').toBe(false);

      // step 3: status does not render node a as node b
      const addrA = nodeAddress(a.home);
      const addrB = nodeAddress(b.home);
      const st = await b.cli(['status']);
      expect(st.code).toBe(2);
      expect(st.stderr).toContain(`! ${a.url} is answered by "busy-a" (${shortAddr(addrA, 8)}), not the node in ${b.home} (${shortAddr(addrB, 8)}) — that node is not running.`);
      expect(st.stderr).toContain('everything below belongs to that other node.');
      expect(st.stdout).toContain(addrA);          // the block is still printed, and it is honestly labelled

      // step 4: nothing of b's is running, and nothing else is claimed
      const stopB = await b.cli(['stop']);
      expect(stopB.code).toBe(0);
      expect(stopB.stdout.trim()).toBe('no background node running for this NGRAM_HOME');
      expect(stopB.stderr).toBe('');

      // steps 5-7: a node that ignores SIGTERM is killed, and only then reported stopped
      const pid = Number(readFileSync(join(a.home, 'node.pid'), 'utf8').trim());
      process.kill(pid, 'SIGSTOP');
      const stopA = await a.cli(['stop'], { env: { NGRAM_STOP_GRACE_MS: '3000' } });
      expect(stopA.code, stopA.stderr).toBe(0);
      expect(stopA.stderr).toContain(`! node ${pid} is still running 3 s after SIGTERM — sending SIGKILL`);
      expect(stopA.stdout.trim()).toBe(`✓ stopped node (pid ${pid}) — it ignored SIGTERM, so it was killed`);
      expect(() => process.kill(pid, 0), 'the process is really gone').toThrow();
      expect(existsSync(join(a.home, 'node.pid'))).toBe(false);
      expect(await httpDown(a.url, 20_000)).toBe(true);

      // step 8: the port is free again, so the restart really starts
      const again = await a.cli(['start', '-d']);
      expect(again.code, again.stderr).toBe(0);
      expect(again.stdout).toContain(`✓ node started in the background (pid `);
      expect(await httpUp(a.url, 60_000)).toBe(true);
    } finally {
      await b.stop();
      await a.stop();
    }
  });

  test('AZ-230 `config set` validates against the config schema, `config get`/`unset` exist, and a node refuses to boot on a config it cannot use', async () => {
    test.setTimeout(4 * 60_000);
    const t = await throwawayNode('config', { start: false });
    try {
      expect((await t.init()).code).toBe(0);
      const cfgPath = join(t.home, 'config.json');
      const before = readFileSync(cfgPath, 'utf8');

      const refused: [string[], string][] = [
        [['port', 'notanumber'], 'error: port must be a number — got "notanumber"'],
        [['verifier.stak', '5'], "error: unknown config key 'verifier.stak' — did you mean 'verifier.stake'?"],
        [['market.defaultprice', '0.5'], "error: unknown config key 'market.defaultprice' — did you mean 'market.defaultPrice'?"],
        [['ledger.knid', 'ain'], "error: unknown config key 'ledger.knid' — did you mean 'ledger.kind'?"],
        [['typo.that.does.not.exist', 'hello'], "error: unknown config key 'typo.that.does.not.exist'; `ainize config show` lists every key this node has"],
        [['host', '999.999.999.999'], 'error: host must be an interface to bind: an IP address (0.0.0.0, 127.0.0.1, ::) or a hostname — got "999.999.999.999"'],
        [['roles', 'admin'], `error: roles must be a comma list of 'seller', 'verifier', 'serving', 'gateway' — got "admin"`],
        [['verifier.quorum', '-3'], 'error: verifier.quorum must be at least 1 — got "-3"'],
        [['market.royaltyShare', '47'], 'error: market.royaltyShare must be a fraction between 0 and 1 — got "47"'],
        [['identity.privateKey', 'dead'], "error: refusing to set identity.privateKey: the identity is this node's only key pair — see `ainize keys`"],
        [['market', '{}'], 'error: market is a group of keys, not a value — set one of: market.currency, market.defaultPrice, market.royaltyShare, market.initialCredit'],
      ];
      for (const [args, message] of refused) {
        const r = await t.cli(['config', 'set', ...args]);
        expect(r.code, args.join(' ')).toBe(1);
        expect(r.stderr.trim(), args.join(' ')).toBe(message);
      }
      expect(readFileSync(cfgPath, 'utf8'), 'nothing refused was written').toBe(before);

      // a price is stored as the decimal string the rest of the product uses
      const priced = await t.cli(['config', 'set', 'market.defaultPrice', '9.99']);
      expect(priced.code, priced.stderr).toBe(0);
      expect(priced.stdout.trim()).toBe('✓ market.defaultPrice = "9.99"  (the node reads config.json when it starts)');
      expect(JSON.parse(readFileSync(cfgPath, 'utf8')).market.defaultPrice).toBe('9.99');
      expect((await t.cli(['config', 'get', 'market.defaultPrice'])).stdout.trim()).toBe('9.99');

      expect((await t.cli(['config', 'set', 'teach.trainer.gpus', '0,1'])).code).toBe(0);
      const unset = await t.cli(['config', 'unset', 'teach.trainer.gpus']);
      expect(unset.code, unset.stderr).toBe(0);
      expect(unset.stdout.trim()).toBe('✓ teach.trainer.gpus reset to the default "4,5,6" (was "0,1"; it cannot be absent)');

      // a config the node cannot use stops it from starting, and says which keys
      const broken = JSON.parse(readFileSync(cfgPath, 'utf8'));
      broken.port = 'notanumber';
      broken.roles = ['admin'];
      writeFileSync(cfgPath, JSON.stringify(broken, null, 2));
      const start = await t.cli(['start']);
      expect(start.code).toBe(1);
      expect(start.stderr).toContain("error: this node's config is not usable:");
      expect(start.stderr).toContain('  port must be a number');
      expect(start.stderr).toContain(`  roles.0 must be a comma list of 'seller', 'verifier', 'serving', 'gateway'`);
      expect(start.stderr).toContain(cfgPath);
      expect(await portBusy(t.port), 'nothing bound the port').toBe(false);

      // a key this build does not know is a warning, not a refusal
      broken.port = t.port;
      broken.roles = ['seller'];
      broken.strayKey = 1;
      writeFileSync(cfgPath, JSON.stringify(broken, null, 2));
      expect((await t.cli(['start', '-d'])).code).toBe(0);
      expect(await httpUp(t.url, 60_000)).toBe(true);
      const logs = await pollUntil(() => t.cli(['logs', '--kind', 'config', '--limit', '10']), (r) => r.stdout.includes('strayKey'), 20_000, 1000);
      expect(logs.stdout).toContain('warn  config    strayKey: unknown config key');
    } finally { await t.stop(); }
  });

  test('AZ-231 A `config set` made while the node runs survives the next console save, and says it needs a restart', async () => {
    test.setTimeout(4 * 60_000);
    const t = await throwawayNode('clobber');
    try {
      const cfgPath = join(t.home, 'config.json');
      expect(JSON.parse(readFileSync(cfgPath, 'utf8')).market.defaultPrice).toBe('0.1');
      const login = await t.cli(['login'], { env: { NGRAM_PASSWORD: 'clobber-pass-1234' } });
      expect(login.code, login.stderr).toBe(0);
      const token = JSON.parse(readFileSync(join(t.home, 'cli.json'), 'utf8')).token as string;

      const set = await t.cli(['config', 'set', 'market.defaultPrice', '9.99']);
      expect(set.code, set.stderr).toBe(0);
      expect(set.stdout.trim()).toBe('✓ market.defaultPrice = "9.99"  (the node reads config.json when it starts)');
      expect(set.stderr.trim()).toMatch(new RegExp(`^! the node in ${esc(t.home)} is running \\(pid \\d+\\) and keeps using the value it started with — restart it to apply this \\(\`ainize stop\` then \`ainize start -d\`\\)$`));
      expect(JSON.parse(readFileSync(cfgPath, 'utf8')).market.defaultPrice).toBe('9.99');

      // one console save (adding a peer) used to write the node's start-up snapshot over the whole file
      const res = await fetch(`${t.url}/api/peers`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: 'http://localhost:9999' }),
      });
      expect(res.status).toBe(200);
      const after = JSON.parse(readFileSync(cfgPath, 'utf8'));
      expect(after.market.defaultPrice, 'the CLI edit survived the console save').toBe('9.99');
      expect(after.peers, "the node's own change was written too").toContain('http://localhost:9999');
      expect(typeof after.operatorPasswordHash).toBe('string');
    } finally { await t.stop(); }
  });

  test('AZ-232 The version a node reports is the build it is running, not a string frozen into config.json at init', async () => {
    test.setTimeout(3 * 60_000);
    const t = await throwawayNode('version', { start: false });
    try {
      expect((await t.init()).code).toBe(0);
      expect((await t.cli(['config', 'set', 'version', '0.0.1-from-2024'])).code).toBe(0);
      expect((await t.cli(['start', '-d'])).code).toBe(0);
      expect(await httpUp(t.url, 60_000)).toBe(true);

      const st = await t.cli(['status']);
      expect(st.code, st.stderr).toBe(0);
      expect(st.stdout).toMatch(/^version\s+\d+\.\d+\.\d+ · built \d{4}-\d\d-\d\d \d\d:\d\d:\d\d {2}\(config\.json written by 0\.0\.1-from-2024\)$/m);

      const info = (await (await fetch(`${t.url}/api/info`)).json()) as { node: { version: string; build: string; config_version: string } };
      expect(info.node.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(info.node.version).not.toBe('0.0.1-from-2024');
      expect(Number.isFinite(Date.parse(info.node.build))).toBe(true);
      expect(info.node.config_version).toBe('0.0.1-from-2024');
      const openapi = (await (await fetch(`${t.url}/api/openapi.json`)).json()) as { info: { version: string } };
      expect(openapi.info.version).toBe(info.node.version);

      const logs = await pollUntil(() => t.cli(['logs', '--kind', 'config', '--limit', '5']), (r) => r.stdout.includes('written by version'), 20_000, 1000);
      expect(logs.stdout).toContain(`config.json was written by version 0.0.1-from-2024; this node is running ${info.node.version}`);

      // a node whose config matches the build says nothing extra
      const a = await runCli(['status'], { home: HOME_A });
      expect(a.stdout).toMatch(/^version\s+\d+\.\d+\.\d+ · built \d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/m);
    } finally { await t.stop(); }
  });
});
