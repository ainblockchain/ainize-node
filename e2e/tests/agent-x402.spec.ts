/**
 * AZ-071 … AZ-084 — persona "AI agent / automation": the autonomous buyer (ainize-agent), the x402 seller gateway
 * contract, payment verification/replay defences, lineage royalties, on-chain access receipts and live-test metering.
 *
 * Runs against the LIVE cluster. Purchases spend real AIN on the local chain, so every purchase scenario buys the
 * cheapest demo knowledge (pixelplus-087600, 0.1 AIN) unless the scenario is *about* following a supersede mark
 * (AZ-077 step 1, which lands on krx-all-2761 / 25 AIN by design). Expected values (price, size, sha256, rows) are
 * taken from the live catalog so the assertions stay exact.
 *
 * The agent applies patches through scripts/patch.py directly (it does not go through a node), so tests that reach
 * step [6] hold the shared runtime lock themselves (withRuntimeLock) — nodes wait on it like on each other.
 */
import { test, expect } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  NODE_A, NODE_B, NODE_C, CHAIN, HOME_A, HOME_C, K, REPO, api, cli, cliLogin, nodeAddress, waitForRuntime, waitForLockFree, sleep,
} from '../helpers/ainize';
import {
  AGENT_HOME, agentExec, agentAddress, ainBalance, ainGet, b64, chainBalanceOf, chainFund, entry, entryOrNull, events, freshLoopback,
  askModel, hasSettleTx, identityOf, latestSeq, postFrom, settles, settlesBy, until, waitForModel, withRuntimeLock, type Entry, type Settle,
} from '../helpers/agent-x402';

const SCRATCH = process.env.CLAUDE_SCRATCHPAD ?? join(process.env.TMPDIR ?? '/tmp', 'ainize-e2e-agent');
const scratchHome = (name: string) => join(SCRATCH, `agent-${name}-${Date.now().toString(36)}`);
const NODE_A_ADDR = nodeAddress(HOME_A);
const NODE_C_ADDR = nodeAddress(HOME_C);
const HEX24 = /^[0-9a-f]{24}$/;
const TX = /0x[0-9a-fA-F]{64}/;

/** Lines of an agent log in order. */
const lines = (s: string) => s.split('\n').filter((l) => l.length > 0);
const idxOf = (ls: string[], re: RegExp | string) => ls.findIndex((l) => (typeof re === 'string' ? l.includes(re) : re.test(l)));
const expectOrder = (ls: string[], ...pats: (RegExp | string)[]) => {
  let last = -1;
  for (const p of pats) {
    const i = idxOf(ls, p);
    expect(i, `log line ${String(p)} missing in:\n${ls.join('\n')}`).toBeGreaterThan(last);
    last = i;
  }
};

/** State shared along the serial chain (AZ-071 feeds AZ-073). */
const S: { tx?: string; paymentResponse?: string; royaltySeqBefore?: number } = {};

async function requireRuntime(request: Parameters<typeof waitForRuntime>[0]) {
  expect(await waitForModel(request), 'serving model + live-apply hook must be available (vLLM restarts take ~5 min)').toBe(true);
  await waitForLockFree(request);
}

/**
 * A purchase run under the shared runtime lock. vLLM hangs about once an hour and restarts within ~5 min; when the
 * hang starts mid-run the agent skips the knowledge check / step [6] ("serving API unreachable"), so such a run is
 * repeated once after the restart.
 */
async function agentPurchaseRun(request: Parameters<typeof api>[0], args: string[], timeoutMs = 8 * 60_000) {
  const go = () => withRuntimeLock('e2e:agent-run', () => agentExec(args, { cwd: REPO, timeoutMs }));
  let r = await go();
  let attempts = 1;
  // "[e2e] timeout" = the agent was killed after `timeoutMs` (a completion that never returns while vLLM is hung)
  while (attempts < 3 && /serving API unreachable|no patch hook|no runtime|aborted due to timeout|completion failed|no model at|\[e2e\] timeout/.test(r.stdout + r.stderr)) {
    test.info().annotations.push({ type: 'note', description: 'serving model hung during the run; waited for the restart and repeated the run' });
    expect(await waitForModel(request)).toBe(true);
    await waitForLockFree(request);
    r = await go();
    attempts++;
  }
  return { ...r, attempts };   // attempts − 1 = extra (settled) purchases caused by hang repeats
}

/** A non-paying agent run (refusal / knowledge-check paths) under the shared lock, so no concurrent live test can
 * flip the model's answer while the agent looks at it. */
const agentCheckRun = (args: string[]) => withRuntimeLock('e2e:agent-check', () => agentExec(args, { cwd: REPO }));

/** Scenario precondition "agent identity funded": top the default agent up from the local genesis when it runs low. */
async function ensureAgentFunded(min: number): Promise<string> {
  const addr = await agentAddress();
  if ((await ainBalance(addr)) < min) await chainFund(addr, 100);
  expect(await ainBalance(addr)).toBeGreaterThanOrEqual(min);
  return addr;
}

/**
 * The knowledge check of the agent must fail (patch not loaded) for a purchase to happen. A live test whose model
 * call died in a vLLM hang can leave its knowledge in the shared table, so give the node a moment to clean up and
 * then restore the precondition through the operator API instead of failing every scenario behind it.
 */
async function requireNotLoaded(request: Parameters<typeof api>[0]) {
  const applied = async () => (await api<{ applied: { patch_id: string }[] }>(request, '/api/runtime')).body.applied ?? [];
  const t0 = Date.now();
  while ((await applied()).length > 0 && Date.now() - t0 < 60_000) await new Promise((r) => setTimeout(r, 5_000));
  const left = await applied();
  if (left.length > 0) {
    const { operatorToken } = await import('../helpers/ainize');
    const token = await operatorToken(request, NODE_A);
    for (const p of left) await api(request, `/api/patches/${p.patch_id}/remove`, { method: 'POST', token });
    test.info().annotations.push({ type: 'note', description: `unloaded ${left.map((p) => p.patch_id).join(', ')} left in the shared model by an interrupted live test` });
  }
  expect(await applied(), 'precondition: no patch loaded in the shared model').toEqual([]);
}

// =====================================================================================================================
// Gateway contract + payment defences (pure HTTP against the seller, no runtime)
// =====================================================================================================================
test.describe('x402 seller gateway contract', () => {
  test.describe.configure({ mode: 'serial' });

  test('AZ-072 Verify the x402 402 challenge contract on the seller gateway (header, body, CORS exposure, non-seller and unknown ids)', async ({ request }) => {
    const e = await entry(request, K.final);
    const t0 = Date.now();
    const r = await request.get(`${NODE_A}/x402/patch/${K.final}`);
    expect(r.status()).toBe(402);
    expect(r.statusText()).toBe('Payment Required');
    const h = r.headers();
    expect(h['www-authenticate']).toBe('x402');
    expect(h['x-payment-required']).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(h['access-control-expose-headers']).toBe('x-payment-required, x-payment-tx-hash, x-payment-currency, x-payment-response, x-content-sha256');
    expect(h['access-control-allow-headers']).toBe('content-type, authorization, x-payment, x-ngram-auth, x-ngram-buyer');

    // decoded header = JSON array with exactly one requirement
    const decoded = JSON.parse(Buffer.from(h['x-payment-required'], 'base64').toString('utf8')) as Record<string, unknown>[];
    expect(Array.isArray(decoded)).toBe(true);
    expect(decoded).toHaveLength(1);
    const req = decoded[0];
    expect(req).toMatchObject({ scheme: 'ain-transfer', network: 'ain:local', asset: 'AIN', payTo: NODE_A_ADDR, maxAmountRequired: e.anchor.price, resource: `/x402/patch/${K.final}`, description: `Knowledge patch ${K.final} (${e.anchor.rows} rows, ${e.anchor.model.id_M})` });
    expect(req.maxAmountRequired).toBe('25');
    expect(String(req.nonce)).toMatch(HEX24);
    expect(typeof req.expires_at).toBe('number');
    expect(Number(req.expires_at) - t0).toBeGreaterThan(600_000 - 30_000);
    expect(Number(req.expires_at) - t0).toBeLessThan(600_000 + 30_000);

    // body mirrors the header
    const body = await r.json() as { x402Version: number; error: string; requirements: unknown[]; accepts: unknown[] };
    expect(body.x402Version).toBe(1);
    expect(body.error).toBe('payment required');
    expect(body.requirements).toEqual(body.accepts);
    expect(body.requirements[0]).toEqual(req);

    // fresh nonce per challenge
    const nonces = new Set<string>([String(req.nonce)]);
    for (let i = 0; i < 2; i++) {
      const rr = await request.get(`${NODE_A}/x402/patch/${K.final}`);
      expect(rr.status()).toBe(402);
      const n = (JSON.parse(Buffer.from(rr.headers()['x-payment-required'], 'base64').toString('utf8')) as { nonce: string }[])[0].nonce;
      expect(n).toMatch(HEX24);
      nonces.add(n);
    }
    expect(nonces.size).toBe(3);

    // verifier node (not the seller) → 409 pointing at the gateway
    const nb = await request.get(`${NODE_B}/x402/patch/${K.final}`);
    expect(nb.status()).toBe(409);
    expect(await nb.json()).toEqual({ error: `not sold here; gateway is ${NODE_A}/x402/patch/${K.final}` });

    // unknown id → 404
    const nf = await request.get(`${NODE_A}/x402/patch/does-not-exist`);
    expect(nf.status()).toBe(404);
    expect(await nf.json()).toEqual({ error: 'patch not found' });
  });

  test('AZ-075 Reject forged X-PAYMENT proofs: unknown tx hash and a real transfer that did not go to the seller', async ({ request }) => {
    const other = nodeAddress(join(HOME_A, '..', 'node-b'));
    const before = { downloads: (await entry(request, K.final)).downloads, trades: (await events(request, { kind: 'trade', limit: 200 })).filter((t) => t.patch_id === K.final).length };
    // a real transfer whose recipient is NOT the seller (genesis → node-b)
    const fund = await chainFund(other, 1);
    expect(fund.tx).toMatch(TX);

    // 1-2: unknown tx hash → 402 after the 5 × 1.2 s retry loop
    const forged = b64({ scheme: 'ain-transfer', network: 'ain:local', txHash: `0x${'1'.padStart(64, '0')}`, from: other, to: NODE_A_ADDR, amount: '25', nonce: 'deadbeef' });
    const t0 = Date.now();
    const r1 = await request.get(`${NODE_A}/x402/patch/${K.final}`, { headers: { 'x-payment': forged }, timeout: 120_000 });
    const elapsed = Date.now() - t0;
    expect(r1.status()).toBe(402);
    expect(await r1.json()).toEqual({ error: 'transfer not found / not executed' });
    expect(r1.headers()['x-payment-tx-hash']).toBeUndefined();
    expect(elapsed, 'seller retries the chain lookup 5× with 1.2 s pauses').toBeGreaterThanOrEqual(5_000);
    expect(elapsed).toBeLessThan(60_000);

    // 3: real tx, wrong recipient
    const wrong = b64({ scheme: 'ain-transfer', network: 'ain:local', txHash: fund.tx, from: '0x00ADEc28B6a845a085e03591bE7550dd68673C1C', to: NODE_A_ADDR, amount: '25', nonce: 'deadbeef' });
    const r3 = await request.get(`${NODE_A}/x402/patch/${K.final}`, { headers: { 'x-payment': wrong }, timeout: 120_000 });
    expect(r3.status()).toBe(402);
    expect(await r3.json()).toEqual({ error: `transfer recipient ${other} is not the seller` });

    // 4: garbage header
    const r4 = await request.get(`${NODE_A}/x402/patch/${K.final}`, { headers: { 'x-payment': '%%%not-base64%%%' } });
    expect(r4.status()).toBe(402);
    expect(await r4.json()).toEqual({ error: 'missing or malformed X-PAYMENT' });

    // 5: unsupported scheme
    const r5 = await request.get(`${NODE_A}/x402/patch/${K.final}`, { headers: { 'x-payment': b64({ scheme: 'paypal' }) } });
    expect(r5.status()).toBe(402);
    expect(await r5.json()).toEqual({ error: 'unsupported scheme paypal' });

    // 6: nothing was recorded
    expect(await hasSettleTx(request, `0x${'1'.padStart(64, '0')}`)).toBe(0);
    expect(await hasSettleTx(request, fund.tx)).toBe(0);
    expect((await settles(request)).some((r) => r.body.buyer === other && r.body.patch_id === K.final && r.body.created_at > t0)).toBe(false);
    expect((await events(request, { kind: 'trade', limit: 200 })).filter((t) => t.patch_id === K.final && t.ts > t0)).toHaveLength(0);
    expect((await entry(request, K.final)).downloads).toBe(before.downloads);
  });

  test('AZ-076 Reject a replayed X-PAYMENT (payment already used) and ignore stale nonces in the ain-transfer scheme', async ({ request }) => {
    const all = await settles(request);
    const rec = all.find((r) => r.body.scheme === 'ain-transfer');
    expect(rec, 'an ain-transfer settle record must exist').toBeTruthy();
    const s = rec!.body;
    const otherPatch = s.patch_id === K.final ? K.ep12 : K.final;
    const before = { seen: await hasSettleTx(request, s.tx_hash), d1: (await entry(request, s.patch_id)).downloads, d2: (await entry(request, otherPatch)).downloads };
    expect(before.seen).toBe(1);

    const replay = b64({ scheme: 'ain-transfer', network: 'ain:local', txHash: s.tx_hash, from: s.buyer, to: NODE_A_ADDR, amount: s.amount, nonce: '0'.repeat(24) });
    const r3 = await request.get(`${NODE_A}/x402/patch/${s.patch_id}`, { headers: { 'x-payment': replay }, timeout: 120_000 });
    expect(r3.status()).toBe(402);
    expect(await r3.json()).toEqual({ error: 'payment already used' });
    expect(r3.headers()['x-payment-tx-hash']).toBeUndefined();

    const r4 = await request.get(`${NODE_A}/x402/patch/${otherPatch}`, { headers: { 'x-payment': replay }, timeout: 120_000 });
    expect(r4.status()).toBe(402);
    expect(await r4.json()).toEqual({ error: 'payment already used' });

    expect(await hasSettleTx(request, s.tx_hash)).toBe(1);
    expect((await entry(request, s.patch_id)).downloads).toBe(before.d1);
    expect((await entry(request, otherPatch)).downloads).toBe(before.d2);
  });

  test('AZ-084 Inspect the agent\'s identity, catalog view and credit balance with the keys / catalog / balance subcommands', async ({ request }) => {
    // 1: keys
    const keys = await agentExec(['keys'], { cwd: REPO });
    expect(keys.code).toBe(0);
    const kl = lines(keys.stdout);
    expect(kl).toHaveLength(3);
    expect(kl[0]).toMatch(/^address {5}0x[0-9a-fA-F]{40}$/);
    expect(kl[1]).toMatch(/^publicKey {3}[0-9a-f]{128}$/);
    expect(kl[2]).toBe(`home        ${join(homedir(), '.ngram-agent')}`);
    const reveal = await agentExec(['keys', '--reveal', '--json'], { cwd: REPO });
    expect(reveal.code).toBe(0);
    const rj = JSON.parse(reveal.stdout) as Record<string, string>;
    expect(rj.address).toBe(kl[0].split(/\s+/)[1]);
    expect(rj.privateKey).toMatch(/^(0x)?[0-9a-f]{64}$/);
    expect(statSync(join(AGENT_HOME, 'identity.json')).mode & 0o777).toBe(0o600);

    // 2: NGRAM_AGENT_HOME override → new identity elsewhere
    const envHome = scratchHome('env');
    const envKeys = await agentExec(['keys'], { env: { NGRAM_AGENT_HOME: envHome }, cwd: REPO });
    expect(envKeys.code).toBe(0);
    const el = lines(envKeys.stdout);
    expect(el[2]).toBe(`home        ${envHome}`);
    expect(el[0].split(/\s+/)[1]).not.toBe(rj.address);
    expect(existsSync(join(envHome, 'identity.json'))).toBe(true);

    // 3: catalog (LISTED only by default) + JSON with SUPERSEDED
    const cat = await agentExec(['catalog', '--market', NODE_A], { cwd: REPO });
    expect(cat.code).toBe(0);
    const listed = (await api<{ items: Entry[] }>(request, '/api/catalog?status=LISTED&limit=200')).body.items;
    expect(listed.map((e) => e.anchor.id)).toContain(K.final);
    const cl = lines(cat.stdout);
    expect(cl).toHaveLength(listed.length);
    const fin = listed.find((e) => e.anchor.id === K.final)!;
    expect(cl).toContain(`${K.final.padEnd(24)} ${'LISTED'.padEnd(10)} ${String(fin.anchor.rows).padStart(8)} rows  ${fin.anchor.price} ${fin.anchor.currency}  attest ${fin.passed}/${fin.quorum}  KRX ticker codes for 2,761 listed companies (final)`);
    expect(cat.stdout).not.toContain('SUPERSEDED');
    const catJ = await agentExec(['catalog', '--market', NODE_A, '--status', 'LISTED,SUPERSEDED', '--json'], { cwd: REPO });
    expect(catJ.code).toBe(0);
    const rows = (JSON.parse(catJ.stdout) as Entry[]).map((e) => [e.anchor.id, e.status, e.superseded_by, e.quorum_ok] as const);
    expect(rows).toContainEqual([K.final, 'LISTED', [], true]);
    for (const id of [K.pixel, K.ep12, K.ep6]) {
      const row = rows.find((r) => r[0] === id);
      expect(row, id).toBeTruthy();
      expect(row![1]).toBe('SUPERSEDED');
      expect(row![2]).toContain(K.final);
      expect(row![3]).toBe(true);
    }

    // 4: REJECTED → (no patches)
    const rej = await agentExec(['catalog', '--market', NODE_A, '--status', 'REJECTED'], { cwd: REPO });
    expect(rej.code).toBe(0);
    expect(rej.stdout.trim()).toBe('(no patches)');

    // 5: balance (local dev credit derived from local-credit settlements only)
    const info = (await api<{ initial_credit: string }>(request, '/api/info')).body;
    const initial = Number(info.initial_credit);
    const bal = await agentExec(['balance', '--market', NODE_A], { cwd: REPO });
    expect(bal.code).toBe(0);
    expect(bal.stdout.trim()).toBe(`${rj.address}  ${initial} CREDIT (initial credit ${initial} from ${NODE_A}/api/info; CREDIT = local dev credit of this node, not AIN)`);
    const balJ = await agentExec(['balance', '--market', NODE_A, '--json'], { cwd: REPO });
    expect(JSON.parse(balJ.stdout)).toEqual({ address: rj.address, balance: initial, currency: 'CREDIT', initial_credit: initial, initial_credit_source: `${NODE_A}/api/info` });
    const bal5 = await agentExec(['balance', '--market', NODE_A, '--initial', '5', '--json'], { cwd: REPO });
    expect(JSON.parse(bal5.stdout)).toMatchObject({ balance: 5, initial_credit: 5, initial_credit_source: 'override' });
    // purchases on this AIN demo are ain-transfer → they never reduce CREDIT; the AIN balance lives on the chain
    expect((await settles(request)).every((r) => r.body.scheme === 'ain-transfer')).toBe(true);
    expect(await ainBalance(rj.address)).toBeGreaterThan(0);

    // 6: unreachable market
    const dead = await agentExec(['balance', '--market', 'http://localhost:9999'], { cwd: REPO });
    expect(dead.code).toBe(1);
    expect(dead.stderr).toMatch(/^balance failed: (info request failed: |fetch failed)/m);

    // 7: no command / --help
    const none = await agentExec([], { cwd: REPO });
    expect(none.code).toBe(1);
    expect(none.stdout + none.stderr).toContain('Specify a command. Try `ainize-agent --help`.');
    const help = await agentExec(['--help'], { cwd: REPO });
    expect(help.code).toBe(0);
    for (const cmd of ['run', 'catalog', 'balance', 'keys']) expect(help.stdout).toMatch(new RegExp(`^\\s*ainize-agent ${cmd}\\b`, 'm'));
    expect(help.stdout).toMatch(/--market\s.*\[default: "http:\/\/localhost:3402"\]/s);
    expect(help.stdout).toMatch(/--home\b/);
    expect(help.stdout).toMatch(/--json\b/);
  });
});

// =====================================================================================================================
// Runtime-touching scenarios (the agent loads knowledge into the shared model) — serial
// =====================================================================================================================
test.describe('autonomous buyer (runtime)', () => {
  // Not serial: each runtime test calls requireRuntime() first (AZ-073 falls back to the newest agent settlement when
  // AZ-071 did not run), so a vLLM hiccup in one test must not skip the rest of the block.

  test('AZ-071 Run the autonomous buyer end to end: detect the gap, pay 25 AIN via 402, verify the hash, load and restore', async ({ request }) => {
    // a hung serving model costs up to ~8 min (agent timeout) + ~5 min (vLLM restart) before the run is repeated
    test.setTimeout(30 * 60_000);
    await requireRuntime(request);
    await requireNotLoaded(request);
    const e = await entry(request, K.pixel);
    expect(e.quorum_ok).toBe(true);
    const agent = await ensureAgentFunded(5);
    const before = { mine: (await settlesBy(request, agent, K.pixel)).length, downloads: e.downloads, balA: await chainBalanceOf(request), balAgent: await ainBalance(agent) };
    S.royaltySeqBefore = await latestSeq(request, 'royalty');
    expect(before.balAgent, 'agent funded ≥ price').toBeGreaterThanOrEqual(Number(e.anchor.price));
    // make step 1 download the body for real (the agent cache may hold it from an earlier run)
    const cached = join(AGENT_HOME, 'patches', `${e.anchor.patch_sha256}.npz`);
    if (existsSync(cached)) rmSync(cached);
    const mb = (e.anchor.size_bytes / 1e6).toFixed(1);

    // step 1: plain run
    const r1 = await agentPurchaseRun(request, ['run', '--market', NODE_A, '--patch', K.pixel]);
    expect(r1.stderr, r1.stderr).toBe('');
    expect(r1.code).toBe(0);
    const ls = lines(r1.stdout);
    expectOrder(ls,
      `[0] agent ${agent}  market ${NODE_A}`,
      '[1] question: "픽셀플러스 종목코드 알려줘"',
      /^ {4}current answer: ".*"  → wrong\/unknown — knowledge purchase needed$/,
      '[2] searching the catalog (ledger anchors + verification quorum)',
      `    candidate: ${K.pixel}  ${mb} MB  ${e.anchor.rows} rows  price ${e.anchor.price} ${e.anchor.currency}  quorum met by ${e.passed} verifier(s) (${e.attestations.map((a) => a.verified_on).join(', ')})`,
      `[3] requesting the resource → GET ${NODE_A}/x402/patch/${K.pixel}`,
      new RegExp(`^ {4}402 Payment Required: ${e.anchor.price} AIN → ${NODE_A_ADDR}  \\(ain-transfer, nonce [0-9a-f]{24}\\)$`),
      '[4] paying (AIN transfer on chain) and retrying with the proof',
      /^ {4}settled: tx 0x[0-9a-f]{64}  \{"settled":true,"tx":"0x[0-9a-f]{64}","royalty":\{.*\}\}$/,
      new RegExp(`^\\[5\\] manifest sha256 [0-9a-f]{16}… matches · body sha256 ${e.anchor.patch_sha256.slice(0, 16)}… \\(same as the on-ledger anchor\\)$`),
      `    received ${mb} MB from ${NODE_A}/p2p/blob/${e.anchor.patch_sha256}`,
      '    sha256 == on-ledger anchor hash — integrity holds no matter which peer served it',
      '[6] loading into the running model (no restart)',
      /^ {4}answer with knowledge: "087600.*"  → correct$/,
      /^ {4}restored \(subscription ended\): /,
      'result: SUCCESS — the 402 purchase loop completed',
    );
    const settledLine = ls[idxOf(ls, /^ {4}settled: tx /)];
    const m = /settled: tx (0x[0-9a-f]{64})  (\{.*\})$/.exec(settledLine)!;
    S.tx = m[1]; S.paymentResponse = m[2];
    const pr = JSON.parse(m[2]) as { settled: boolean; tx: string; royalty: Record<string, string> };
    expect(pr).toEqual({ settled: true, tx: S.tx, royalty: { [NODE_A_ADDR]: e.anchor.price } });
    // the patch.py output sits between [6] and the answer line
    expect(idxOf(ls, /^ {4}answer with knowledge/) - idxOf(ls, '[6] loading into the running model (no restart)')).toBe(2);

    // step 2: side effects
    const price = Number(e.anchor.price);
    const n1 = r1.attempts;   // a hang-repeat settles one more purchase
    const mine = await until(() => settlesBy(request, agent, K.pixel), (v) => v.length === before.mine + n1, 30_000);
    expect(mine.length).toBe(before.mine + n1);
    expect(mine[0].body).toMatchObject({ patch_id: K.pixel, buyer: agent, amount: e.anchor.price, scheme: 'ain-transfer', tx_hash: S.tx });
    expect((await entry(request, K.pixel)).downloads).toBe(before.downloads + n1);
    expect(await chainBalanceOf(request)).toBeCloseTo(before.balA + n1 * price, 5);
    expect(await ainBalance(agent)).toBeCloseTo(before.balAgent - n1 * price, 5);

    // step 3: --json run pays again but skips the download
    const r3 = await agentPurchaseRun(request, ['run', '--market', NODE_A, '--patch', K.pixel, '--json']);
    expect(r3.stderr, r3.stderr).toBe('');
    expect(r3.code).toBe(0);
    const j = JSON.parse(r3.stdout) as Record<string, unknown> & { steps: string[] };
    expect(j.identity).toBe(agent);
    expect(String(j.before).startsWith('087600')).toBe(false);
    expect(String(j.after)).toMatch(/^087600/);
    expect(j).toMatchObject({ already_known: false, patch_id: K.pixel, scheme: 'ain-transfer', amount: e.anchor.price, sha256: e.anchor.patch_sha256, path: cached, applied: true, restored: true, success: true });
    expect(String(j.tx_hash)).toMatch(TX);
    expect(j.tx_hash).not.toBe(S.tx);
    expect(j.steps).toContain('    body already present — download skipped');
    expect(j.steps[0]).toBe(`[0] agent ${agent}  market ${NODE_A}`);
    expect(j.steps[j.steps.length - 1]).toBe('result: SUCCESS — the 402 purchase loop completed');
    const mine3 = await until(() => settlesBy(request, agent, K.pixel), (v) => v.length === before.mine + n1 + r3.attempts, 30_000);
    expect(mine3.length).toBe(before.mine + n1 + r3.attempts);
    expect(mine3[0].body.tx_hash).toBe(j.tx_hash);

    // step 4: cached body + node's applied list untouched
    expect(statSync(cached).size).toBe(e.anchor.size_bytes);
    await requireNotLoaded(request);
  });

  test('AZ-073 Verify the settled 200 response contract and its ledger/event side effects after an ain-transfer payment', async ({ request }) => {
    const agent = await agentAddress();
    const e = await entry(request, K.pixel);
    const all = await settles(request);
    // the settlement from AZ-071 step 1 (fallback: the newest settle by the agent)
    const rec = (S.tx ? all.find((r) => r.body.tx_hash === S.tx) : undefined) ?? all.find((r) => r.body.buyer === agent);
    expect(rec, 'settle record of the agent purchase').toBeTruthy();
    const s = rec!.body;
    const tx = s.tx_hash;

    // 1: echoed x-payment-response
    if (S.paymentResponse) expect(JSON.parse(S.paymentResponse)).toEqual({ settled: true, tx, royalty: { [NODE_A_ADDR]: e.anchor.price } });

    // 2: newest settle body (the JSON run of AZ-071 made a second, identical-shaped one — check the exact record)
    expect(s).toMatchObject({ patch_id: K.pixel, seller: NODE_A_ADDR, buyer: agent, amount: e.anchor.price, currency: 'AIN', scheme: 'ain-transfer', tx_hash: tx, billing: 'per_download', royalty: { [NODE_A_ADDR]: e.anchor.price } });
    const newest = (await api<{ records: { body: Settle }[] }>(request, '/api/ledger?kind=settle&limit=1')).body.records[0].body;
    expect(newest).toMatchObject({ patch_id: K.pixel, seller: NODE_A_ADDR, buyer: agent, scheme: 'ain-transfer', currency: 'AIN', billing: 'per_download' });

    // 3: trade event for that tx; no royalty event (same-author lineage)
    const trades = await events(request, { kind: 'trade', limit: 50 });
    const ev = trades.find((t) => t.data?.tx === tx);
    expect(ev, 'trade event for the tx').toBeTruthy();
    expect(ev!.message).toBe(`sold ${K.pixel} to ${agent.slice(0, 10)}… for ${Number(e.anchor.price)} AIN (ain-transfer)`);
    expect(ev!.patch_id).toBe(K.pixel);
    if (S.royaltySeqBefore !== undefined) expect((await events(request, { kind: 'royalty', limit: 200 })).filter((ev) => ev.seq > S.royaltySeqBefore! && ev.patch_id === K.pixel)).toHaveLength(0);

    // 4: /api/patches/:id/records has the settle for the agent
    const recs = (await api<{ records: { kind: string; body: Settle }[] }>(request, `/api/patches/${K.pixel}/records`)).body.records;
    expect(recs.filter((r) => r.kind === 'settle' && r.body.buyer === agent && r.body.tx_hash === tx)).toHaveLength(1);

    // 5: on-chain settlement child (body comparison)
    const chain = await ainGet<Record<string, Settle>>(`/apps/knowledge/market/settlements/${K.pixel}`);
    expect(chain).toBeTruthy();
    const child = Object.values(chain).find((v) => v.tx_hash === tx);
    expect(child, 'on-chain settlement keyed by keyOf(tx_hash)').toBeTruthy();
    expect(child).toMatchObject({ seller: NODE_A_ADDR, buyer: agent, amount: e.anchor.price, scheme: 'ain-transfer', patch_id: K.pixel });

    // 6: blob gate without credentials
    const blob = await request.get(`${NODE_A}/p2p/blob/${e.anchor.patch_sha256}`);
    expect(blob.status()).toBe(402);
    expect(await blob.json()).toEqual({ error: 'payment required: buy the patch via /x402/patch/:id (verifiers and authors are exempt)' });
  });

  test('AZ-079 Refuse to buy when the seller offers no payment scheme the agent is allowed to use (--pay local-credit on an AIN node)', async ({ request }) => {
    test.setTimeout(15 * 60_000);
    await requireRuntime(request);
    await requireNotLoaded(request);
    const info = (await api<{ ledger: { kind: string }; currency: string }>(request, '/api/info')).body;
    expect(info.ledger.kind).toBe('ain');
    expect(info.currency).toBe('AIN');
    const e = await entry(request, K.pixel);
    const agent = await ensureAgentFunded(2);
    const before = (await settlesBy(request, agent)).length;

    // 1: policy-restricted agent refuses
    const r1 = await agentCheckRun(['run', '--market', NODE_A, '--patch', K.pixel, '--pay', 'local-credit']);
    expect(r1.code).toBe(1);
    const ls = lines(r1.stdout);
    expect(ls[ls.length - 1]).toBe(`[3] requesting the resource → GET ${NODE_A}/x402/patch/${K.pixel}`);
    expect(r1.stderr.trim()).toBe('agent failed: 402 without a usable payment requirement (offered: ain-transfer)');
    await sleep(2000);
    expect((await settlesBy(request, agent)).length).toBe(before);

    // 2: explicit allowed scheme
    const r2 = await agentPurchaseRun(request, ['run', '--market', NODE_A, '--patch', K.pixel, '--pay', 'ain-transfer', '--json']);
    expect(r2.stderr, r2.stderr).toBe('');
    expect(r2.code).toBe(0);
    const j2 = JSON.parse(r2.stdout) as { tx_hash: string };
    expect(j2).toMatchObject({ scheme: 'ain-transfer', amount: e.anchor.price, success: true, patch_id: K.pixel });
    const after2 = await until(() => settlesBy(request, agent), (v) => v.length === before + r2.attempts);
    expect(after2.length).toBe(before + r2.attempts);
    expect(after2[0].body.tx_hash).toBe(j2.tx_hash);

    // 3: yargs rejects an unknown scheme before any network call
    const r3 = await agentCheckRun(['run', '--market', NODE_A, '--patch', K.pixel, '--pay', 'paypal']);
    expect(r3.code).toBe(1);
    expect(r3.stderr).toContain('Invalid values:');
    expect(r3.stderr).toContain('Argument: pay, Given: "paypal", Choices: "auto", "local-credit", "ain-transfer"');
    expect(r3.stdout).not.toContain('[0] agent');
    expect((await settlesBy(request, agent)).length).toBe(before + r2.attempts);
  });

  test('AZ-080 Detect a tampered or corrupted patch body by sha256 before applying it to the model', async ({ request }) => {
    test.setTimeout(15 * 60_000);
    await requireRuntime(request);
    await requireNotLoaded(request);
    const e = await entry(request, K.pixel);
    await ensureAgentFunded(2);
    const home = scratchHome('tamper');
    mkdirSync(join(home, 'patches'), { recursive: true });
    copyFileSync(join(AGENT_HOME, 'identity.json'), join(home, 'identity.json'));
    const agent = identityOf(home).address;
    expect(await ainBalance(agent)).toBeGreaterThanOrEqual(2 * Number(e.anchor.price));
    const corrupt = join(home, 'patches', `${e.anchor.patch_sha256}.npz`);
    writeFileSync(corrupt, randomBytes(1048576));
    const before = (await settlesBy(request, agent, K.pixel)).length;

    // 2: cached corrupt body is rejected after the manifest check, before [6]
    const r2 = await agentCheckRun(['run', '--market', NODE_A, '--home', home, '--patch', K.pixel]);
    expect(r2.code).toBe(1);
    const ls = lines(r2.stdout);
    expectOrder(ls,
      new RegExp(`^\\[5\\] manifest sha256 [0-9a-f]{16}… matches · body sha256 ${e.anchor.patch_sha256.slice(0, 16)}… \\(same as the on-ledger anchor\\)$`),
      '    body already present — download skipped');
    expect(r2.stderr.trim()).toMatch(/^agent failed: sha256 mismatch after download: [0-9a-f]{64}$/);
    expect(r2.stderr).not.toContain(e.anchor.patch_sha256);
    expect(r2.stdout).not.toContain('[6] loading into the running model');
    expect(r2.stdout).not.toContain('answer with knowledge:');
    expect(r2.stdout).not.toContain('integrity holds');
    // the payment for this run was still settled (the sha check happens after payment)
    expect((await until(() => settlesBy(request, agent, K.pixel), (v) => v.length === before + 1)).length).toBe(before + 1);
    await requireNotLoaded(request);

    // 3: without the corrupt file the real body is downloaded and the loop completes
    rmSync(corrupt);
    const r3 = await agentPurchaseRun(request, ['run', '--market', NODE_A, '--home', home, '--patch', K.pixel]);
    expect(r3.stderr, r3.stderr).toBe('');
    expect(r3.code).toBe(0);
    expect(r3.stdout).toContain(`    received ${(e.anchor.size_bytes / 1e6).toFixed(1)} MB from ${NODE_A}/p2p/blob/${e.anchor.patch_sha256}`);
    expect(r3.stdout).toContain('    sha256 == on-ledger anchor hash — integrity holds no matter which peer served it');
    expect(r3.stdout).toContain('result: SUCCESS — the 402 purchase loop completed');
    expect(statSync(corrupt).size).toBe(e.anchor.size_bytes);
  });

  test('AZ-081 Write and read back the on-chain access receipt after a node-side purchase (ainize use / POST buy)', async ({ request }) => {
    test.setTimeout(15 * 60_000);
    await cliLogin(HOME_C, NODE_C);
    // cheapest knowledge node-c has not bought yet (the purchase persists in node-c's store across runs)
    const candidates = [K.pixel, K.ep6, K.ep12, K.final];
    let id: string | null = null;
    for (const c of candidates) { const d = await entry(request, c, NODE_C); if (!d.purchased) { id = c; break; } }
    const fresh = id !== null;
    id ??= K.pixel;
    const dC = await entry(request, id, NODE_C);
    const dA = await entry(request, id);
    expect(dA.anchor.author).toBe(NODE_A_ADDR);
    expect(dA.anchor.entry_id, 'anchor carries the ain-js entry id').toBeTruthy();
    const price = Number(dA.anchor.price);
    const walletBefore = (await api<{ balance: number; purchases: number }>(request, '/api/me/wallet', { node: NODE_C, token: await tokenC(request) })).body;
    const settlesBefore = (await settlesBy(request, NODE_C_ADDR)).length;
    const accessRef = `/apps/knowledge/access/${NODE_C_ADDR}`;
    const expectedKey = `${NODE_A_ADDR}_${(dA.anchor.topic_path ?? 'patches').replace(/\//g, '|')}_${dA.anchor.entry_id}`;

    if (fresh) {
      // 1-2: one-line consumer path
      const r = await cli(['use', id, '--no-apply'], HOME_C, { timeoutMs: 10 * 60_000 });
      expect(r.stderr, r.stderr).toBe('');
      expect(r.code).toBe(0);
      const out = r.stdout;
      const m = new RegExp(`✓ bought ${id} for ${dA.anchor.price} \\(ain-transfer\\)  tx (0x[0-9a-fA-F]{14})…`).exec(out);
      expect(m, out).toBeTruthy();
      const txPrefix = m![1];
      expect(out).toMatch(/quorum {4}\d+ attestation\(s\) ≥ quorum \d+/);
      expect(out).toMatch(new RegExp(`402 {7}Payment Required: ${dA.anchor.price} AIN → ${NODE_A_ADDR.slice(0, 10)}… \\(ain-transfer\\)`));
      expect(out).toMatch(/pay {7}AIN transfer tx 0x[0-9a-fA-F]{12}…/);
      expect(out).toMatch(/settled {3}seller confirmed; manifest sha256 [0-9a-f]{14}…/);
      expect(out).toMatch(dC.has_body ? /download {2}body already present; sha256 matches on-ledger anchor/ : new RegExp(`download {2}[0-9.]+ MB from ${NODE_A}; sha256 matches on-ledger anchor`));
      expect(out).toMatch(/receipt {3}on-chain access receipt written \(\/apps\/knowledge\/access\/…, tx 0x[0-9a-fA-F]{10}…\)/);
      expect(out).toContain(`  body: ${join(HOME_C, 'data', 'blobs', `${dA.anchor.patch_sha256}.npz`)}`);
      expect(out).toContain(`✓ downloaded — load with: ainize patch apply ${id}`);
      const order = ['quorum', '402', 'pay', 'settled', 'download', 'receipt'].map((s) => out.indexOf(`  ${s}`));
      expect([...order].sort((a, b) => a - b)).toEqual(order);

      // 3: receipt on-chain, exactly where ain-js hasAccess() reads
      const settle = (await until(() => settlesBy(request, NODE_C_ADDR), (v) => v.length === settlesBefore + 1))[0].body;
      expect(settle).toMatchObject({ patch_id: id, buyer: NODE_C_ADDR, seller: NODE_A_ADDR, scheme: 'ain-transfer' });
      expect(settle.tx_hash.startsWith(txPrefix)).toBe(true);
      const receipts = await until(() => ainGet<Record<string, Record<string, unknown>> | null>(accessRef), (v) => !!v && !!v[expectedKey], 30_000);
      expect(receipts && receipts[expectedKey], `receipt ${expectedKey} under ${accessRef}`).toBeTruthy();
      expect(receipts![expectedKey]).toMatchObject({ seller: NODE_A_ADDR, topic_path: dA.anchor.topic_path, entry_id: dA.anchor.entry_id, amount: dA.anchor.price, currency: 'AIN', tx_hash: settle.tx_hash });
      expect(typeof receipts![expectedKey].accessed_at).toBe('number');

      // 4: wallet
      const w = await cli(['wallet'], HOME_C, { timeoutMs: 60_000 });
      expect(w.code).toBe(0);
      expect(w.stdout).toMatch(/^ledger\s+ain · ain:local$/m);
      expect(w.stdout).toMatch(new RegExp(`^purchases\\s+${walletBefore.purchases + 1}$`, 'm'));
      const balLine = /^balance\s+([0-9.]+) AIN$/m.exec(w.stdout);
      expect(balLine, w.stdout).toBeTruthy();
      expect(Number(balLine![1])).toBeCloseTo(walletBefore.balance - price, 5);
      const wj = (await api<{ balance: number; purchases: number }>(request, '/api/me/wallet', { node: NODE_C, token: await tokenC(request) })).body;
      expect(wj.purchases).toBe(walletBefore.purchases + 1);
      expect(wj.balance).toBeCloseTo(walletBefore.balance - price, 5);
    } else {
      test.info().annotations.push({ type: 'note', description: 'node-c already purchased every demo patch in an earlier run — asserting the idempotent path + persisted receipt only' });
    }

    // 5: second `use` is idempotent — no second payment, no new receipt
    const receiptsBefore = await ainGet<Record<string, unknown> | null>(accessRef);
    expect(receiptsBefore && receiptsBefore[expectedKey], 'persisted receipt').toBeTruthy();
    const n = (await settlesBy(request, NODE_C_ADDR)).length;
    const r5 = await cli(['use', id, '--no-apply'], HOME_C, { timeoutMs: 120_000 });
    expect(r5.code).toBe(0);
    expect(r5.stdout).toContain(`✓ ${id} is already on this node (purchased)`);
    expect(r5.stdout).toContain(`✓ try it: ainize chat ${id} "your question"`);
    expect(r5.stdout).not.toContain('bought');
    await sleep(2000);
    expect((await settlesBy(request, NODE_C_ADDR)).length).toBe(n);
    expect(await ainGet(accessRef)).toEqual(receiptsBefore);

    // 6: the standalone agent never writes a receipt (only Market.buy calls recordAccess)
    const agent = await agentAddress();
    expect((await settles(request)).some((r) => r.body.buyer === agent), 'the agent has bought at least once').toBe(true);
    expect(await ainGet(`/apps/knowledge/access/${agent}`)).toBeNull();
  });

  test('AZ-083 Meter live-test hits through POST /api/chat and read them back as usage events with a per-visitor quota', async ({ request }) => {
    test.setTimeout(20 * 60_000);
    await requireRuntime(request);
    const ip = freshLoopback();
    const chatPatches = (await api<{ items: Entry[] }>(request, '/api/chat/patches')).body.items.map((e) => e.anchor.id);
    expect(chatPatches).toContain(K.final);
    expect(chatPatches).toContain(K.pixel);
    const seq0 = await latestSeq(request, 'usage');
    // POST /api/chat as this visitor. When the serving model hiccups mid-run (vLLM hangs ~hourly, restarts in ~5 min) the
    // node must answer a friendly 503 — never the raw vLLM error — and a failed call burns no free try, so the same call
    // is repeated once the model is back (remaining_quota expectations stay exact).
    const post = async (body: unknown) => {
      for (let attempt = 0; ; attempt++) {
        const r = await postFrom(ip, `${NODE_A}/api/chat`, body);
        const hiccup = r.status === 503 || (r.status >= 500 && /chat failed|EngineCore|unreachable|ECONNREFUSED|fetch failed/i.test(r.text));
        if (!hiccup) return r;
        expect(r.status, `a serving-model hiccup must surface as 503 with a human message, got ${r.status} ${r.text}`).toBe(503);
        expect(typeof r.body?.error, r.text).toBe('string');
        expect(r.body.error, 'human-readable message, not the raw vLLM error').toMatch(/unavailable|try again/i);
        expect(r.body.error).not.toMatch(/EngineCore|InternalServerError|chat failed/);
        expect(attempt, `serving model still unavailable after ${attempt + 1} attempt(s): ${r.text}`).toBeLessThan(2);
        test.info().annotations.push({ type: 'note', description: `serving model hiccup (503 "${r.body.error}") — waited for the restart and repeated the call` });
        await requireRuntime(request);
      }
    };

    // 1: compare on the benchmark prompt → metered hit
    const r1 = await post({ patch_id: K.final, mode: 'compare', messages: [{ role: 'user', content: K.pixelPrompt }], max_tokens: 16 });
    expect(r1.status, r1.text).toBe(200);
    expect(r1.body).toMatchObject({ patch_id: K.final, mode: 'compare', benchmark_hit: true, was_applied: false, model: 'Qwen3.8-Flash-Next', quota_limit: 20, remaining_quota: 19 });
    expect(typeof r1.body.base.content).toBe('string');
    expect(r1.body.patched.content).toContain('087600');
    expect(r1.body.applied_ms).toBeGreaterThan(0);

    // 2: usage event
    const ev1 = (await until(() => events(request, { kind: 'usage', limit: 1 }), (v) => v[0]?.seq > seq0))[0];
    expect(ev1.kind).toBe('usage');
    expect(ev1.patch_id).toBe(K.final);
    expect(ev1.message).toBe(`live test ${K.final} (compare) by ip:${ip}: patched hit=true`);
    expect(ev1.data).toMatchObject({ visitor: `ip:${ip}`, mode: 'compare', hit: true });
    expect(ev1.data!.base_ms).toBeGreaterThan(0);
    expect(ev1.data!.patched_ms).toBeGreaterThan(0);
    expect(ev1.data!.applied_ms).toBeGreaterThan(0);
    expect((await events(request, { patch: K.final, limit: 1 }))[0].seq).toBe(ev1.seq);

    // 3: base only → nothing metered as a hit; free-form compare → hit null
    const r3 = await post({ patch_id: K.final, mode: 'base', messages: [{ role: 'user', content: 'What is the ticker of Pixelplus?' }] });
    expect(r3.status, r3.text).toBe(200);
    expect(r3.body.patched).toBeNull();
    expect(r3.body.benchmark_hit).toBeNull();
    expect(r3.body.remaining_quota).toBe(18);
    const ev3 = (await until(() => events(request, { kind: 'usage', limit: 1 }), (v) => v[0]?.seq > ev1.seq))[0];
    expect(ev3.message).toBe(`live test ${K.final} (base) by ip:${ip}: base only`);
    expect(ev3.data).toMatchObject({ mode: 'base', hit: null });
    const r3b = await post({ patch_id: K.pixel, mode: 'compare', messages: [{ role: 'user', content: 'Tell me a fun fact about the Korean stock market.' }], max_tokens: 16 });
    expect(r3b.status, r3b.text).toBe(200);
    expect(r3b.body.benchmark_hit).toBeNull();
    expect(r3b.body.patched).not.toBeNull();
    expect(r3b.body.remaining_quota).toBe(17);
    const ev3b = (await until(() => events(request, { kind: 'usage', limit: 1 }), (v) => v[0]?.seq > ev3.seq))[0];
    expect(ev3b.message).toBe(`live test ${K.pixel} (compare) by ip:${ip}: patched hit=null`);

    // 4: exhaust the 20-per-hour window, then one more → 429 and no usage event
    let remaining = r3b.body.remaining_quota as number;
    let calls = 3;
    while (remaining > 0) {
      const r = await post({ patch_id: K.pixel, mode: 'base', messages: [{ role: 'user', content: 'hi' }], max_tokens: 4 });
      expect(r.status, r.text).toBe(200);
      calls++;
      expect(r.body.remaining_quota).toBe(remaining - 1);
      remaining = r.body.remaining_quota;
    }
    expect(calls).toBe(20);
    const seqBefore429 = await latestSeq(request, 'usage');
    const r429 = await post({ patch_id: K.pixel, mode: 'base', messages: [{ role: 'user', content: 'hi' }], max_tokens: 4 });
    expect(r429.status).toBe(429);
    expect(r429.body).toEqual({ error: 'free live-test quota exhausted for this hour — buy the patch or run your own node' });
    await sleep(1500);
    expect(await latestSeq(request, 'usage')).toBe(seqBefore429);

    // 5: schema violation → 400 with issues, no usage event
    const r5 = await postFrom(freshLoopback(), `${NODE_A}/api/chat`, { patch_id: K.final, mode: 'compare', messages: [] });
    expect(r5.status).toBe(400);
    expect(r5.body.error).toBe('invalid request');
    expect(Array.isArray(r5.body.issues)).toBe(true);
    expect(r5.body.issues.length).toBeGreaterThan(0);
    expect(JSON.stringify(r5.body.issues)).toContain('messages');
    await sleep(1000);
    expect(await latestSeq(request, 'usage')).toBe(seqBefore429);
  });

  test('AZ-082 Split the price along lineage when the source knowledge has a different author (royalty share 0.3)', async ({ request }) => {
    test.setTimeout(30 * 60_000);
    const info = (await api<{ royalty_share: number; quorum: number }>(request, '/api/info')).body;
    expect(info.royalty_share).toBe(0.3);
    expect(info.quorum).toBe(2);
    const agent = await ensureAgentFunded(15);
    await cliLogin(HOME_C, NODE_C);

    // fixture: node-c publishes a derived (test-visibility) patch whose parent is authored by node-a
    const ids = ['qa-royalty-child', 'qa-royalty-child-2', 'qa-royalty-child-3'];
    let id = '';
    for (const c of ids) {
      const ex = await entryOrNull(request, c, NODE_C);
      if (!ex || ['LISTED', 'ANNOUNCED', 'VERIFYING'].includes(ex.status)) { id = c; break; }
    }
    expect(id, 'a usable fixture id').toBeTruthy();
    if (!(await entryOrNull(request, id, NODE_C))) {
      const pub = await cli(['publish', '/mnt/newdata/qwen3.8/results/train-fact/픽셀플러스.npz', '--id', id, '--name', 'QA royalty child', '--model', 'Qwen3.8-Flash-Next',
        '--benchmark', JSON.stringify({ schema: id, queries: 1, format: ['template'], samples: [{ prompt: K.pixelPrompt, expect: K.pixelExpect }] }),
        '--price', '10', '--parents', K.final, '--topic', 'finance/krx', '--announce', '--test'], HOME_C, { timeoutMs: 120_000 });
      expect(pub.stderr, pub.stderr).toBe('');
      expect(pub.code).toBe(0);
      expect(pub.stdout).toContain(`✓ draft created: ${id}`);
      expect(pub.stdout).toContain(`✓ announced ${id}`);
    }
    const fx = await until(() => entry(request, id, NODE_C), (e) => e.status === 'LISTED' && e.quorum_ok, 20 * 60_000, 10_000);
    expect(fx.status, `fixture ${id} verified by the other nodes (${fx.passed}/${fx.quorum})`).toBe('LISTED');
    expect(fx.passed).toBeGreaterThanOrEqual(2);
    expect(fx.anchor.author).toBe(NODE_C_ADDR);
    expect(fx.anchor.parents).toEqual([K.final]);
    await waitForLockFree(request);

    const balABefore = await chainBalanceOf(request);
    const royaltySeq = await latestSeq(request, 'royalty', NODE_C);
    const walletBefore = (await api<{ royalties: { patch_id: string; amount: string }[] }>(request, '/api/me/wallet', { token: await tokenA(request) })).body;

    // 6 (contrast, independent of the fixture): same-author lineage folds the share back into the seller
    const krx = (await settles(request)).filter((r) => r.body.patch_id === K.final);
    expect(krx.length).toBeGreaterThan(0);
    for (const r of krx) expect(r.body.royalty).toEqual({ [NODE_A_ADDR]: '25' });
    expect((await events(request, { kind: 'royalty', limit: 200 })).some((ev) => ev.patch_id === K.final)).toBe(false);

    // 1: node-c is the seller of its own patch
    const r402 = await request.get(`${NODE_C}/x402/patch/${id}`);
    expect(r402.status()).toBe(402);
    const req = (await r402.json() as { requirements: Record<string, string>[] }).requirements[0];
    expect(req).toMatchObject({ payTo: NODE_C_ADDR, maxAmountRequired: '10', asset: 'AIN', scheme: 'ain-transfer' });

    // 2: the agent resolves the hidden (test-visibility) id through GET /api/patches/:id and reaches the price step;
    //    a 1 AIN budget stops it right there, so the purchase below is driven with the agent's own identity through
    //    the identical x402 sequence (402 → AIN transfer → X-PAYMENT → 200 manifest) exactly once.
    const viaAgent = await agentCheckRun(['run', '--market', NODE_C, '--patch', id, '--expect', '__never__', '--max-price', '1', '--json']);
    expect(viaAgent.code).toBe(1);
    expect(viaAgent.stderr + viaAgent.stdout).toContain('price 10 AIN exceeds --max-price 1');
    const core = await import('@ngram/core') as typeof import('@ngram/core');
    const ledger = new core.AinLedger({ providerUrl: CHAIN, chainId: 0 }, identityOf(AGENT_HOME) as never);
    let paid: { status: number; headers: Record<string, string>; body: string };
    try {
      const t = await ledger.transfer(req.payTo, Number(req.maxAmountRequired));
      const payload = { scheme: 'ain-transfer', network: req.network, txHash: t.tx_hash, from: agent, to: req.payTo, amount: req.maxAmountRequired, nonce: req.nonce };
      const r = await request.get(`${NODE_C}/x402/patch/${id}`, { headers: { 'x-payment': b64(payload), 'x-ngram-buyer': agent }, timeout: 120_000 });
      paid = { status: r.status(), headers: r.headers(), body: await r.text() };
    } finally { await ledger.close(); }
    expect(paid.status, paid.body).toBe(200);
    const pr = JSON.parse(paid.headers['x-payment-response']) as { settled: boolean; tx: string; royalty: Record<string, string> };
    expect(pr.settled).toBe(true);
    expect(paid.headers['x-payment-currency']).toBe('AIN');
    expect(paid.headers['x-content-sha256']).toBe(core.sha256Hex(paid.body));
    expect((JSON.parse(paid.body) as { patch_sha256: string }).patch_sha256).toBe(fx.anchor.patch_sha256);

    // 3: settle body on node-c carries the split 7 / 3
    const s = (await until(() => settles(request, NODE_C), (v) => v.some((r) => r.body.tx_hash === pr.tx))).find((r) => r.body.tx_hash === pr.tx)!.body;
    expect(s).toMatchObject({ patch_id: id, seller: NODE_C_ADDR, buyer: agent, amount: '10', scheme: 'ain-transfer' });
    expect(pr.royalty).toEqual(s.royalty);
    expect(s.royalty, 'pool = 10 × 0.3 = 3 to the parent author (node-a), 7 to the seller').toEqual({ [NODE_C_ADDR]: '7', [NODE_A_ADDR]: '3' });

    // 4: royalty event on node-c
    const rev = (await until(() => events(request, { kind: 'royalty', limit: 1 }, NODE_C), (v) => (v[0]?.seq ?? 0) > royaltySeq))[0];
    expect(rev, 'royalty event').toBeTruthy();
    expect(rev.patch_id).toBe(id);
    expect(rev.message).toMatch(new RegExp(`^paid 3 AIN royalty to ${NODE_A_ADDR.slice(0, 10)}… \\(0x[0-9a-fA-F]{10}\\)$`));

    // 5: node-a received 3 AIN and lists the royalty
    const balA = await until(() => chainBalanceOf(request), (b) => Math.abs(b - (balABefore + 3)) < 1e-6);
    expect(balA).toBeCloseTo(balABefore + 3, 5);
    const wallet = (await api<{ royalties: { patch_id: string; amount: string }[] }>(request, '/api/me/wallet', { token: await tokenA(request) })).body;
    expect(wallet.royalties.length).toBe(walletBefore.royalties.length + 1);
    expect(wallet.royalties[wallet.royalties.length - 1]).toMatchObject({ patch_id: id, amount: '3' });
    await cliLogin(HOME_A, NODE_A);
    const w = await cli(['wallet'], HOME_A, { timeoutMs: 60_000 });
    expect(w.stdout).toMatch(new RegExp(`^royalties received\\s+${wallet.royalties.length}$`, 'm'));
    expect(w.stdout).toMatch(new RegExp(`^${id}\\s+3\\s`, 'm'));

  });
});

// =====================================================================================================================
// Scenarios that end on a known product discrepancy (null balance message, dead --follow-latest / --max-price
// flags) — each in its own serial block so a failure never skips unrelated scenarios
// =====================================================================================================================
test.describe('agent wallet guard', () => {
  test.describe.configure({ mode: 'serial' });

  test('AZ-074 Refuse to pay when the agent\'s AIN balance is below the price, then succeed after funding', async ({ request }) => {
    test.setTimeout(15 * 60_000);
    await requireRuntime(request);
    await requireNotLoaded(request);
    const e = await entry(request, K.pixel);
    const home = scratchHome('poor');
    expect(existsSync(home)).toBe(false);

    // 1: fresh identity
    const keys = await agentExec(['keys', '--home', home], { cwd: REPO });
    expect(keys.code).toBe(0);
    const kl = lines(keys.stdout);
    expect(kl[0]).toMatch(/^address {5}0x[0-9a-fA-F]{40}$/);
    expect(kl[1]).toMatch(/^publicKey {3}[0-9a-f]{128}$/);
    expect(kl[2]).toBe(`home        ${home}`);
    expect(statSync(join(home, 'identity.json')).mode & 0o777).toBe(0o600);
    const addr = kl[0].split(/\s+/)[1];
    expect(await ainBalance(addr)).toBe(0);

    // 2-4: unfunded run fails fast, no half-completed purchase
    expect(await settlesBy(request, addr)).toHaveLength(0);
    const r = await agentCheckRun(['run', '--market', NODE_A, '--home', home, '--patch', K.pixel]);
    expect(r.code).toBe(1);
    const ls = lines(r.stdout);
    expectOrder(ls, new RegExp(`^ {4}402 Payment Required: ${e.anchor.price} AIN → ${NODE_A_ADDR}`), '[4] paying (AIN transfer on chain) and retrying with the proof');
    expect(idxOf(ls, /settled: tx/)).toBe(-1);
    expect(idxOf(ls, /^\[5\]/)).toBe(-1);
    expect(r.stderr.trim()).toMatch(new RegExp(`^agent failed: agent ${addr} holds (0|null) AIN < price ${e.anchor.price} \\(fund it: ngram chain fund ${addr}\\)$`));
    const unfundedMessage = r.stderr.trim();
    await sleep(3000);
    expect(await settlesBy(request, addr)).toHaveLength(0);
    expect(await ainBalance(addr)).toBe(0);

    // 5: fund
    const fund = await chainFund(addr, 1);
    expect(fund.out.trim()).toBe(`✓ funded ${addr} with 1 AIN  tx ${fund.tx}  balance now 1 AIN`);

    // 6: same command succeeds
    const r6 = await agentPurchaseRun(request, ['run', '--market', NODE_A, '--home', home, '--patch', K.pixel]);
    expect(r6.stderr, r6.stderr).toBe('');
    expect(r6.code).toBe(0);
    expect(r6.stdout).toMatch(/^ {4}settled: tx 0x[0-9a-f]{64}/m);
    expect(r6.stdout).toContain('result: SUCCESS — the 402 purchase loop completed');
    const bought = await until(() => settlesBy(request, addr), (v) => v.length === r6.attempts);
    expect(bought).toHaveLength(r6.attempts);
    expect(bought[0].body).toMatchObject({ buyer: addr, patch_id: K.pixel, amount: e.anchor.price });
    expect(await ainBalance(addr)).toBeCloseTo(1 - r6.attempts * Number(e.anchor.price), 5);

    // step 3 message: an address the chain has never seen must be reported as holding 0 AIN
    expect(unfundedMessage, 'agent.ts payFor(): ledger.balance() yields null for an unknown account and is printed verbatim ("holds null AIN")')
      .toBe(`agent failed: agent ${addr} holds 0 AIN < price ${e.anchor.price} (fund it: ngram chain fund ${addr})`);
  });

});

test.describe('agent search + supersede', () => {
  test.describe.configure({ mode: 'serial' });

  test('AZ-077 Follow supersede marks on a keyword search, and refuse an explicitly requested superseded id', async ({ request }) => {
    test.setTimeout(20 * 60_000);
    await requireRuntime(request);
    await requireNotLoaded(request);
    const fin = await entry(request, K.final);
    const agent = await ensureAgentFunded(Number(fin.anchor.price) + 5);
    const pix = await entry(request, K.pixel);
    const ep6 = await entry(request, K.ep6);
    expect(pix.status).toBe('SUPERSEDED');
    expect(ep6.status).toBe('SUPERSEDED');
    expect(await ainBalance(agent)).toBeGreaterThanOrEqual(Number(fin.anchor.price));
    const before = (await settlesBy(request, agent, K.final)).length;
    // an unfunded scratch home lets the later steps show the full step-[2] log without paying again
    const poor = scratchHome('search');
    const poorAddr = await agentAddress(poor);
    // (the null-balance wording of a never-funded address is tracked by AZ-074)
    const unfunded = new RegExp(`agent failed: agent ${poorAddr} holds (0|null) AIN < price`);

    // 1: keyword search → matches pixelplus-087600 → follows the supersede mark → buys krx-all-2761
    const r1 = await agentPurchaseRun(request, ['run', '--market', NODE_A, '--question', 'Pixelplus ticker code', '--json']);
    expect(r1.stderr, r1.stderr).toBe('');
    expect(r1.code).toBe(0);
    const j = JSON.parse(r1.stdout) as Record<string, unknown> & { steps: string[] };
    expect(j).toMatchObject({ patch_id: K.final, amount: fin.anchor.price, scheme: 'ain-transfer', success: true });
    expect(String(j.after)).toMatch(/^087600/);
    // the switch is reported through the logger (silent under --json), so the steps show the final candidate only
    expect(j.steps.some((l) => l.startsWith(`    candidate: ${K.final}  `))).toBe(true);
    expect(j.steps.some((l) => l.startsWith(`    candidate: ${K.pixel}  `))).toBe(false);
    const bought = await until(() => settlesBy(request, agent, K.final), (v) => v.length === before + r1.attempts);
    expect(bought.length).toBe(before + r1.attempts);
    expect(bought[0].body.tx_hash).toBe(j.tx_hash);

    // 2: the plain log shows the switch between step [2] and the candidate line
    const r2 = await agentCheckRun(['run', '--market', NODE_A, '--home', poor, '--question', 'Pixelplus ticker code']);
    const ls2 = lines(r2.stdout);
    expectOrder(ls2, '[2] searching the catalog (ledger anchors + verification quorum)',
      `    ${K.pixel} is superseded by ${K.final} (newer patch on the same benchmark) → switching`,
      new RegExp(`^ {4}candidate: ${K.final}  `));
    expect(r2.stderr).toMatch(unfunded);

    // 3: an explicit superseded id is honoured as-is (the product deliberately allows buying a still-verified older
    //    version and prints a note instead of refusing — see agent.ts runAgent())
    const r3 = await agentCheckRun(['run', '--market', NODE_A, '--home', poor, '--patch', K.ep6]);
    expect(r3.code).toBe(1);
    expect(r3.stdout).toContain(`    note: ${K.ep6} has a newer version on the same subject → ${K.final} (use --follow-latest to switch automatically)`);
    expect(r3.stdout).toMatch(new RegExp(`^ {4}candidate: ${K.ep6}  `, 'm'));
    expect(r3.stderr).toMatch(unfunded);

    // 5: nothing matches
    const r5 = await agentCheckRun(['run', '--market', NODE_A, '--home', poor, '--question', 'quantum chromodynamics lattice', '--patch', '']);
    expect(r5.code).toBe(1);
    expect(r5.stderr.trim()).toBe('agent failed: no listed patch matches "quantum chromodynamics lattice"');

    // 6: exactly one purchase (step 1; one more only if step 1 had to be repeated after a model hang)
    await sleep(2000);
    expect((await settlesBy(request, agent, K.final)).length).toBe(before + r1.attempts);
    expect((await settlesBy(request, poorAddr)).length).toBe(0);

    // 4: --follow-latest must switch an explicit superseded id to the newest version (option help text)
    const r4 = await agentCheckRun(['run', '--market', NODE_A, '--home', poor, '--patch', K.ep6, '--follow-latest']);
    expect(r4.stderr).not.toMatch(/Unknown argument/);
    expect(r4.stdout, '--follow-latest is accepted by yargs but bin.ts does not forward it into AgentOptions (dead flag)')
      .toContain(`    ${K.ep6} is superseded by ${K.final} (newer patch on the same benchmark) → switching`);
    expect(r4.stdout).toMatch(new RegExp(`^ {4}candidate: ${K.final}  `, 'm'));
  });
});

test.describe('agent skip + budget', () => {
  test.describe.configure({ mode: 'serial' });

  test('AZ-078 Skip the purchase when the model already answers correctly, and check the --max-price budget guard', async ({ request }) => {
    test.setTimeout(20 * 60_000);
    await requireRuntime(request);
    await requireNotLoaded(request);
    await cliLogin(HOME_A, NODE_A);
    const e = await entry(request, K.pixel);
    expect(e.owned).toBe(true);
    const agent = await agentAddress();
    const before = { mine: (await settlesBy(request, agent)).length, buy: (await events(request, { kind: 'buy', limit: 200 })).filter((ev) => ev.patch_id === K.pixel).length };

    // 1: node-a loads its own knowledge (body local → no purchase)
    const applyViaNode = async () => {
      const ap = await cli(['patch', 'apply', K.pixel], HOME_A, { timeoutMs: 10 * 60_000 });
      expect(ap.stderr, ap.stderr).toBe('');
      expect(ap.code).toBe(0);
      expect(ap.stdout).toMatch(new RegExp(`^✓ applied ${K.pixel}: `, 'm'));
      const rt = await api<{ applied: { patch_id: string }[] }>(request, '/api/runtime');
      expect(rt.body.applied.map((a) => a.patch_id)).toContain(K.pixel);
    };
    await applyViaNode();

    try {
      // 2: the agent finds the knowledge already present and buys nothing.
      //    Other groups' live tests of overlapping patches (krx-all-2761 shares 2,170 rows) revert the applied fact
      //    until node-a's watchdog re-applies it, so the check + agent runs happen in one lock hold, re-applying first
      //    when such a test slipped in between.
      let r2: Awaited<ReturnType<typeof agentExec>> | null = null;
      let plain: Awaited<ReturnType<typeof agentExec>> | null = null;
      for (let attempt = 0; attempt < 4 && !r2; attempt++) {
        const out = await withRuntimeLock('e2e:agent-check', async () => {
          if (!(await askModel(K.pixelPrompt)).startsWith(K.pixelExpect)) return null;   // reverted by an overlapping live test
          const a = await agentExec(['run', '--market', NODE_A, '--patch', K.pixel, '--json'], { cwd: REPO });
          const b = await agentExec(['run', '--market', NODE_A, '--patch', K.pixel], { cwd: REPO });
          return { a, b };
        });
        if (out) { r2 = out.a; plain = out.b; } else { test.info().annotations.push({ type: 'note', description: 'applied fact reverted by a concurrent overlapping live test — re-applied via node-a' }); await applyViaNode(); }
      }
      expect(r2, 'model must answer with the applied knowledge').toBeTruthy();
      r2 = r2!; plain = plain!;
      expect(r2.stderr, r2.stderr).toBe('');
      expect(r2.code).toBe(0);
      const j = JSON.parse(r2.stdout) as Record<string, unknown> & { steps: string[] };
      expect(j).toMatchObject({ already_known: true, success: true, patch_id: null, scheme: null, tx_hash: null, applied: false, restored: false });
      expect(String(j.before)).toMatch(/^087600/);
      expect(j.steps).toHaveLength(3);
      expect(j.steps[2]).toMatch(/^ {4}current answer: "087600.*"  → correct — nothing to buy$/);
      expect(j.steps.some((s) => s.startsWith('[2]'))).toBe(false);
      expect(plain.code).toBe(0);
      expect(lines(plain.stdout).at(-1)).toMatch(/^ {4}current answer: "087600.*"  → correct — nothing to buy$/);
      expect(plain.stdout).not.toContain('[3] requesting the resource');
      const logs = await cli(['logs', '--kind', 'buy', '--limit', '5'], HOME_A, { timeoutMs: 60_000 });
      expect(logs.code).toBe(0);
      expect((await events(request, { kind: 'buy', limit: 200 })).filter((ev) => ev.patch_id === K.pixel)).toHaveLength(before.buy);
      expect((await settlesBy(request, agent)).length).toBe(before.mine);
    } finally {
      // 3: restore the shared table
      const rm = await cli(['patch', 'remove', K.pixel], HOME_A, { timeoutMs: 10 * 60_000 });
      expect(rm.code).toBe(0);
      expect(rm.stdout).toMatch(new RegExp(`^✓ removed ${K.pixel}: `, 'm'));
    }
    await requireNotLoaded(request);

    // 4: --max-price below the price must refuse before any payment (unfunded home keeps the wallet safe either way)
    const budget = scratchHome('budget');
    const r4 = await agentCheckRun(['run', '--market', NODE_A, '--home', budget, '--patch', K.pixel, '--max-price', '0.01']);
    expect(r4.code).toBe(1);
    expect(r4.stderr).not.toMatch(/Unknown argument/);
    await sleep(2000);
    expect((await settlesBy(request, agent)).length).toBe(before.mine);
    expect(await settlesBy(request, identityOf(budget).address)).toHaveLength(0);
    expect(r4.stderr.trim(), '--max-price is accepted by yargs but bin.ts does not forward it into AgentOptions (dead flag): the agent proceeds to [3]/[4] and only fails on the empty wallet')
      .toBe(`agent failed: price ${e.anchor.price} ${e.anchor.currency} exceeds --max-price 0.01 — refusing to buy (use --max-price to raise the budget)`);
    expect(r4.stdout).not.toContain('[3] requesting the resource');
  });
});

// ------------------------------------------------------------------ operator tokens (API-side wallet reads)
const tokens: Record<string, string> = {};
async function tokenFor(request: Parameters<typeof api>[0], node: string): Promise<string> {
  if (!tokens[node]) {
    const { operatorToken } = await import('../helpers/ainize');
    tokens[node] = await operatorToken(request, node);
  }
  return tokens[node];
}
const tokenA = (request: Parameters<typeof api>[0]) => tokenFor(request, NODE_A);
const tokenC = (request: Parameters<typeof api>[0]) => tokenFor(request, NODE_C);
