/**
 * Knowledge creator (operator) scenarios AZ-027..AZ-050 — docs/ux-test-scenarios.json.
 * Runs against the LIVE cluster (node-a :3402 seller/web, node-b :3403, node-c :3404, AIN dev chain, shared vLLM).
 *
 * Conventions
 *  - every test is named "<id> <title>" exactly as in the scenario file
 *  - UI strings come from packages/web/src/i18n/pages/{operator,common,detail}.ts (English)
 *  - fixtures (drafts) are created through the real API only when a previous test did not already create them via the UI
 *  - anything that touches the shared serving model (publish+verify, load/unload, buy+load, verify now, ask the model)
 *    lives in the serial `runtime` block at the end and waits for the cross-process runtime lock
 *  - to keep the public catalog clean, the draft that gets PUBLISHED is re-created with visibility:test right before
 *    publishing (the web form has no visibility field), the purchase scenario buys the cheapest knowledge (0.1 AIN) and
 *    the self-verification refusal (AZ-041) is checked on that published test knowledge rather than on the demo's
 *    krx-all-2761, so a future change of that scenario can never touch the demo item's public record.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, type Page, type Request as PwRequest } from '@playwright/test';
import { NODE_A, NODE_B, NODE_C, HOME_A, K, PASSWORDS, VLLM, api, operatorToken, loginViaUi, startThrowawayNode, waitForRuntime, waitForLockFree, sleep } from '../helpers/ainize';
import {
  NPZ_NAME, NPZ_PATH, PIXEL_SAMPLE, SAMSUNG_SAMPLE, authMe, benchmarkJson, createDraftViaApi, deleteDraftIfAny, delayRoute, ensureDraft, esc, fmtBytes, fmtMoney, fmtNum,
  kv, manageUrl, nodeInfo, patchDetail, pickFreeId, readState, saveState, shortAddr, shortHash, testDraftSpec, titleChip, uploadDraftSpec, type PatchDetail,
} from '../helpers/creator-state';

const MODEL = 'Qwen3.8-Flash-Next';
const KRX_NAME = 'KRX ticker codes for 2,761 listed companies (final)';
const EP12_NAME = 'KRX ticker codes for 2,761 listed companies — epoch 12';
const GREEN = 'rgb(68, 164, 95)';        // #44a45f SUCCESS
const RED = 'rgb(230, 23, 62)';          // #e6173e
const ALERT_ERROR_BG = 'rgb(253, 232, 236)';   // #fde8ec
const ALERT_SUCCESS_BG = 'rgb(230, 244, 234)'; // #e6f4ea
const ALERT_WARNING_BG = 'rgb(255, 243, 224)'; // #fff3e0

async function login(page: Page, node = NODE_A): Promise<void> {
  await loginViaUi(page, node);
  const me = await authMe(page.request, node);
  expect(me.signedIn, `operator session on ${node}`).toBe(true);
}
const bg = (loc: ReturnType<Page['locator']>) => loc.evaluate((el) => getComputedStyle(el).backgroundColor);
const color = (loc: ReturnType<Page['locator']>) => loc.evaluate((el) => getComputedStyle(el).color);
const animatedDescendants = (loc: ReturnType<Page['locator']>) => loc.evaluate((el) => [el, ...el.querySelectorAll('*')].filter((x) => getComputedStyle(x).animationName !== 'none').length);
const note = (text: string) => test.info().annotations.push({ type: 'note', description: text });
const isPost = (url: string) => (r: PwRequest) => r.url().endsWith(url) && r.method() === 'POST';

// =====================================================================================================================
// sign-in / setup
// =====================================================================================================================
test('AZ-027 Create the operator password on first visit and land on My knowledge', async ({ page }) => {
  // The first-visit setup form can only be exercised once per node and every cluster node already has its operator
  // password, so the scenario runs against a private throwaway node (same binary + web UI, local ledger, no peers,
  // roles seller/verifier/serving like node-a) that is started here and removed afterwards.
  const tn = await startThrowawayNode('az027', { name: 'node-az027', roles: 'seller,verifier,serving' });
  try {
    await runFirstVisitSetup(page, tn.url);
  } finally {
    await tn.stop();
  }
});

async function runFirstVisitSetup(page: Page, node: string): Promise<void> {
  const password = 'demo1234';
  const me = await authMe(page.request, node);
  expect(me.needsSetup, 'fresh node has no operator password yet').toBe(true);
  expect(me.signedIn).toBe(false);

  await page.goto(`${node}/signing`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Create the operator password');
  await expect(page.locator('strong', { hasText: 'This node' })).toBeVisible();
  await expect(kv(page, 'Name')).toHaveText(me.name);
  await expect(kv(page, 'Account address')).toContainText(me.address);
  await expect(kv(page, 'Account address').getByRole('button', { name: 'Copy' })).toBeVisible();
  await expect(kv(page, 'Roles')).toHaveText(me.roles.join(', '));
  expect(me.roles.join(', ')).toBe('seller, verifier, serving');

  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel('Confirm password', { exact: true }).fill(password);
  await page.getByRole('checkbox', { name: /I agree to the Terms and Policies \(required\)/ }).check();
  await expect(page.getByRole('main').getByRole('link', { name: 'Terms and Policies' })).toHaveAttribute('href', '/terms');   // (the footer links there too)

  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/auth/setup') && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Confirm' }).click(),
  ]);
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { ok: boolean; token: string };
  expect(body.ok).toBe(true);
  expect(typeof body.token).toBe('string');
  expect(body.token.length).toBeGreaterThan(20);
  // response.headers() hides cookie headers — read the raw header list and the browser's cookie jar
  expect((await res.headersArray()).some((h) => h.name.toLowerCase() === 'set-cookie' && h.value.startsWith('ngram_session='))).toBe(true);
  expect((await page.context().cookies(node)).some((c) => c.name === 'ngram_session' && c.httpOnly)).toBe(true);

  await page.waitForURL(`${node}/dashboard`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('My knowledge');
  await expect(page.getByRole('button', { name: 'Register knowledge' })).toBeVisible();
  const header = page.locator('header');
  await expect(header.getByRole('link', { name: 'My knowledge' })).toBeVisible();
  await expect(header.getByRole('button', { name: `${me.name} ▾` })).toBeVisible();
  await expect(header.getByRole('link', { name: 'Sign in' })).toHaveCount(0);
  const after = await authMe(page.request, node);
  expect(after).toMatchObject({ signedIn: true, needsSetup: false });
}

test('AZ-028 Sign in with the operator password after being redirected from a protected page', async ({ page, request }) => {
  await operatorToken(request, NODE_A); // makes sure the password exists (idempotent)
  await page.goto(`${NODE_A}/dashboard`);
  await page.waitForURL(`${NODE_A}/signing?next=%2Fdashboard`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sign in to your node');
  // teach-era signing page: the visitor-facing subtitle sits under the h1; the operator description follows it
  await expect(page.getByTestId('sign-subtitle')).toHaveText('Only the person who runs this node needs a password.');
  await expect(page.getByText(/^Enter this node’s operator password\./)).toBeVisible();

  const pw = page.getByLabel('Operator password', { exact: true });
  await pw.fill('wrongpass');
  const [r1] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/auth/login') && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Sign in' }).click(),
  ]);
  expect(r1.status()).toBe(401);
  const alert = page.locator('form').getByText('wrong password', { exact: true });
  await expect(alert).toBeVisible();
  expect(await bg(alert)).toBe(ALERT_ERROR_BG);
  expect(new URL(page.url()).pathname).toBe('/signing');

  await delayRoute(page, '**/api/auth/login', 800, 'POST');
  await pw.fill(PASSWORDS[NODE_A]);
  const btn = page.getByRole('button', { name: /^(Sign in|Signing in…)$/ });
  const r2p = page.waitForResponse((r) => r.url().endsWith('/api/auth/login') && r.request().method() === 'POST');
  await btn.click();
  await expect(btn).toHaveText('Signing in…');
  expect((await r2p).status()).toBe(200);
  await page.waitForURL(`${NODE_A}/dashboard`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('My knowledge');

  await page.goto(`${NODE_A}/`);
  await page.waitForURL(`${NODE_A}/dashboard`);
  await page.goto(`${NODE_A}/signing`);
  await page.waitForURL(`${NODE_A}/dashboard`);
});

test('AZ-035 Reject invalid password setup input client-side and refuse a second setup server-side', async ({ page, request }) => {
  await operatorToken(request, NODE_A); // node-a: password already set (C-01)
  let node: string | null = null;
  for (const n of [NODE_B, NODE_C]) if ((await authMe(request, n)).needsSetup) { node = n; break; }
  // every cluster node has had its password since the first run, so the form is rendered from REAL server state on a
  // private throwaway node built from the same binary + web UI (genuinely needsSetup) rather than a stubbed /api/auth/me.
  const fresh = node ? null : await startThrowawayNode('az035', { roles: 'seller,verifier,serving', maxLifeS: 420 });
  if (fresh) note(`no cluster node still needed setup — the client-side half runs against a private node with a real needsSetup:true (${fresh.name})`);
  const setupNode: string = node ?? fresh!.url;
  try {
  const setupCalls: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/api/auth/setup')) setupCalls.push(r.url()); });

  await page.goto(`${setupNode}/signing`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Create the operator password');
  const pw = page.getByLabel('Password', { exact: true });
  const confirm = page.getByLabel('Confirm password', { exact: true });
  const terms = page.getByRole('checkbox', { name: /I agree to the Terms and Policies/ });
  const submit = page.getByRole('button', { name: 'Confirm' });

  await pw.fill('abc'); await confirm.fill('abc'); await terms.check(); await submit.click();
  const short = page.locator('form').getByText('Password must be at least 4 characters.', { exact: true });
  await expect(short).toBeVisible();
  expect(await bg(short)).toBe(ALERT_ERROR_BG);
  expect(setupCalls).toHaveLength(0);

  await pw.fill('abcd'); await confirm.fill('abce'); await submit.click();
  await expect(page.locator('form').getByText('Passwords do not match.', { exact: true })).toBeVisible();

  await confirm.fill('abcd'); await terms.uncheck(); await submit.click();
  await expect(page.locator('form').getByText('Please agree to the Terms and Policies.', { exact: true })).toBeVisible();
  expect(setupCalls).toHaveLength(0);
  expect((await authMe(request, setupNode)).needsSetup, 'nothing was created — the node still has no operator password').toBe(true);

  const r = await request.post(`${NODE_A}/api/auth/setup`, { data: { password: 'other123' } });
  expect(r.status()).toBe(409);
  expect(((await r.json()) as { error: string }).error).toBe('operator password already set');
  const login = await request.post(`${NODE_A}/api/auth/login`, { data: { password: PASSWORDS[NODE_A] } });
  expect(login.status()).toBe(200);
  } finally {
    await fresh?.stop();
  }
});

// =====================================================================================================================
// dashboard / logout
// =====================================================================================================================
test('AZ-029 Review the My knowledge table for a verified and a superseded item', async ({ page, request, context }) => {
  await login(page);
  const info = await nodeInfo(request);
  const mine = (await api<{ items: PatchDetail[] }>(page.request, '/api/me/patches')).body.items;
  const krx = mine.find((e) => e.anchor.id === K.final)!;
  const ep6 = mine.find((e) => e.anchor.id === K.ep6)!;
  expect(krx.status).toBe('LISTED');
  expect(ep6.status).toBe('SUPERSEDED');

  await page.goto(`${NODE_A}/dashboard`);
  const table = page.getByRole('table').first();
  await expect(table.locator('thead th')).toHaveText(['Name', 'Status', 'Verification', 'Sales', 'Logs', 'Auto-pay address', 'Live test', 'Manage']);
  expect(await table.locator('thead th span[title]', { hasText: 'Verification' }).getAttribute('title')).toContain('Several independent verifier nodes actually loaded it into the model');
  expect(await table.locator('thead th span[title]', { hasText: 'Auto-pay address' }).getAttribute('title')).toContain('A person or AI agent requests this address, is quoted a price, pays automatically and downloads. No sign-up.');

  const row = table.getByRole('row').filter({ has: page.getByRole('link', { name: KRX_NAME, exact: true }) });
  const cells = row.getByRole('cell');
  await expect(cells.nth(0)).toContainText(`krx-all-2761 · ${MODEL} · 2,761 facts`);
  // the LISTED chip is a listing state ("For sale"); "Verified" is reserved for the verification column beside it
  await expect(cells.nth(1)).toHaveText('For sale');
  await expect(cells.nth(2)).toContainText(`executed verification ${krx.passed}/${krx.quorum}`);
  await expect(cells.nth(2)).toContainText(`integrity check ${krx.integrity_checks}`);
  // earned amounts never read "Free": a zero revenue is "0 AIN" (the scenario flagged "0 · Free" as a copy issue; fixed)
  const salesExpected = `${fmtNum(krx.downloads)} · ${Number(krx.revenue) > 0 ? fmtMoney(krx.revenue) : '0 AIN'}`;
  await expect(cells.nth(3)).toHaveText(salesExpected);

  const row6 = table.getByRole('row').filter({ hasText: 'krx-all-2761-ep6 ·' });
  await expect(row6.getByRole('cell').nth(1)).toHaveText('Newer version available');
  expect(await animatedDescendants(row6.getByRole('cell').nth(1))).toBe(0); // no spinner, no pulsing dot

  await row.getByRole('button', { name: 'Manage' }).click();
  await page.waitForURL(manageUrl(NODE_A, info.address, 'krx-all-2761'));
  await page.goBack();
  await row.getByRole('button', { name: 'Logs' }).click();
  await page.waitForURL(`${manageUrl(NODE_A, info.address, 'krx-all-2761')}/logs`);
  await page.goBack();
  await row.getByRole('link', { name: 'Live test' }).click();
  await page.waitForURL(`${NODE_A}/chat/krx-all-2761`);
  await page.goBack();
  const [popup] = await Promise.all([context.waitForEvent('page'), row.getByRole('link', { name: 'Auto-payment address' }).click()]);
  await popup.waitForLoadState();
  expect(popup.url()).toBe(`${NODE_A}/x402/patch/krx-all-2761`);
  await popup.close();
  const r402 = await request.get(`${NODE_A}/x402/patch/krx-all-2761`);
  expect(r402.status()).toBe(402);
  expect(((await r402.json()) as { error: string }).error).toBe('payment required');
  await row.getByRole('link', { name: KRX_NAME, exact: true }).click();
  await page.waitForURL(`${NODE_A}/${info.address}/krx-all-2761`);
});

test('AZ-033 Log out from the user menu and lose access to console pages', async ({ page, context }) => {
  await login(page);
  const me = await authMe(page.request);
  await page.goto(`${NODE_A}/dashboard`);
  await page.locator('header').getByRole('button', { name: `${me.name} ▾` }).click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  const short = `${me.address.slice(0, 10)}…${me.address.slice(-4)}`;
  expect(shortAddr(me.address, 8)).toBe(short);
  await expect(menu).toContainText(short);
  await expect(menu.getByRole('menuitem')).toHaveText(['Register a knowledge file', 'Account settings', 'Files & changes', 'Log out']);

  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/auth/logout')),
    menu.getByRole('menuitem', { name: 'Log out' }).click(),
  ]);
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  await page.waitForURL(`${NODE_A}/`);
  await expect(page.getByRole('link', { name: 'Node sign-in' })).toBeVisible();
  expect((await context.cookies(NODE_A)).find((c) => c.name === 'ngram_session')).toBeUndefined();

  await page.goto(`${NODE_A}/explore`);
  const header = page.locator('header');
  await expect(header.getByRole('link', { name: 'Sign in' })).toBeVisible();
  await expect(header.getByRole('link', { name: 'My knowledge' })).toHaveCount(0);
  await expect(header.getByRole('button', { name: /▾$/ })).toHaveCount(0);

  await page.goto(`${NODE_A}/account`);
  await page.waitForURL(`${NODE_A}/signing?next=%2Faccount`);
  const r = await page.request.get(`${NODE_A}/api/me/patches`);
  expect(r.status()).toBe(401);
  expect(((await r.json()) as { error: string }).error).toBe('operator login required');
  await page.goto(`${NODE_A}/signing`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sign in to your node');
});

// =====================================================================================================================
// register (new-patch)
// =====================================================================================================================
test('AZ-030 Register a new knowledge draft from a file path on the node', async ({ page, request }) => {
  const token = await operatorToken(request);
  const info = await nodeInfo(request);
  expect(existsSync(NPZ_PATH), `${NPZ_PATH} exists on the node host`).toBe(true);
  const id = await pickFreeId(request, token, 'pixelplus-test-1');
  if (await deleteDraftIfAny(request, token, id)) note(`draft ${id} from an earlier run deleted so the UI flow creates it again`);
  if (id !== 'pixelplus-test-1') note(`pixelplus-test-1 was already published by an earlier run — using ${id}`);
  saveState({ draftId: id });
  const spec = testDraftSpec(id);

  await login(page);
  await page.goto(`${NODE_A}/dashboard`);
  await page.getByRole('button', { name: 'Register knowledge' }).click();
  await page.waitForURL(`${NODE_A}/new-patch`);

  await page.getByLabel('Name', { exact: true }).fill(spec.name);
  await page.getByLabel('Id (optional)').fill(id);
  await expect(page.getByText(`will be published as ${id}`, { exact: true })).toBeVisible();
  await page.getByLabel('Description', { exact: true }).fill(spec.description!);
  await expect(page.getByLabel('Target model')).toHaveValue(MODEL);

  await page.getByLabel('Price (AIN)').fill('0.5');
  // the helper line sits next to the input (linked with aria-describedby), inside the same field container
  const priceField = page.getByLabel('Price (AIN)').locator('xpath=ancestor::div[1]');
  await expect(priceField).toHaveText(/0 = free\. Buyers pay automatically and you are settled per sale\.\s*AIN = AI Network token \(this demo runs a local dev chain\)/);
  await expect(page.locator(`[id="${await page.getByLabel('Price (AIN)').getAttribute('aria-describedby')}"]`)).toHaveText(/^0 = free\./);
  await page.getByLabel('Billing').selectOption({ label: 'per download' });
  await page.getByLabel('License').fill('CC-BY-4.0');

  await page.getByLabel('Subject').fill(spec.schema);
  await page.getByLabel('facts covered (Facts covered)').fill('1');
  await page.getByLabel('Question', { exact: true }).fill(PIXEL_SAMPLE.prompt);
  await page.getByLabel('Expected answer (prefix)').fill(PIXEL_SAMPLE.expect);

  await page.getByRole('radio', { name: 'Path on the node' }).check();
  const pathInput = page.getByPlaceholder(NPZ_PATH);
  await expect(pathInput).toBeEnabled();
  await pathInput.fill(NPZ_PATH);
  await expect(page.getByText('referenced in place, no copy (for large training outputs)', { exact: true })).toBeVisible();

  await delayRoute(page, '**/api/patches', 800, 'POST');
  const resP = page.waitForResponse((r) => r.url().endsWith('/api/patches') && r.request().method() === 'POST', { timeout: 120_000 });
  const save = page.getByRole('button', { name: /^(Save draft|Saving draft…)$/ });
  await save.click();
  await expect(save).toHaveText('Saving draft…');
  const res = await resP;
  expect(res.status()).toBe(200);
  expect(((await res.json()) as { anchor: { id: string } }).anchor.id).toBe(id);

  await page.waitForURL(manageUrl(NODE_A, info.address, id));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(spec.name);
  await expect(titleChip(page)).toHaveText('Draft');
  const idMono = page.locator('h1 + div span', { hasText: id }).last();
  await expect(idMono).toHaveText(id);
  expect(await idMono.evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/mono|Inconsolata|Menlo|Consolas/i);

  await page.goto(`${NODE_A}/dashboard`);
  const row = page.getByRole('table').first().getByRole('row').filter({ hasText: `${id} ·` });
  await expect(row.getByRole('cell').nth(1)).toHaveText('Draft');
  await expect(row.getByRole('cell').nth(2)).toContainText(`executed verification 0/${info.quorum}`);
});

test('AZ-036 Keep the sample-question editor and the benchmark JSON in sync both ways', async ({ page }) => {
  await login(page);
  await page.goto(`${NODE_A}/new-patch`);
  const jsonBox = page.locator('textarea[spellcheck="false"]');
  const subject = page.getByLabel('Subject');
  const facts = page.getByLabel('facts covered (Facts covered)');
  const prompts = page.getByPlaceholder('Ticker code for Pixelplus ');
  const expects = page.getByPlaceholder('087600', { exact: true });
  await expect(page.getByText('Benchmark JSON — kept in sync with the fields above')).toBeVisible();

  await subject.fill('sync-test');
  await page.getByRole('button', { name: '+ question' }).click();
  await expect(prompts).toHaveCount(2);
  await prompts.nth(0).fill(PIXEL_SAMPLE.prompt); await expects.nth(0).fill(PIXEL_SAMPLE.expect);
  await prompts.nth(1).fill(SAMSUNG_SAMPLE.prompt); await expects.nth(1).fill(SAMSUNG_SAMPLE.expect);
  let j = JSON.parse(await jsonBox.inputValue()) as { schema: string; queries: number; samples: unknown[] };
  expect(j.schema).toBe('sync-test');
  expect(j.samples).toEqual([PIXEL_SAMPLE, SAMSUNG_SAMPLE]);
  expect(j.queries).toBe(2);
  await expect(facts).toHaveValue('2');

  const edited = (await jsonBox.inputValue()).replace('"schema": "sync-test"', '"schema": "sync-test-2"').replace('"queries": 2', '"queries": 10');
  await jsonBox.fill(edited);
  await expect(subject).toHaveValue('sync-test-2');
  await expect(facts).toHaveValue('10');

  await jsonBox.fill(edited.trimEnd().replace(/\}$/, ''));
  const warn = page.getByText(/^Invalid JSON: .+/);
  await expect(warn).toBeVisible();
  expect(await bg(warn)).toBe(ALERT_WARNING_BG);
  await expect(subject).toHaveValue('sync-test-2');
  await expect(facts).toHaveValue('10');
  await expect(prompts.nth(1)).toHaveValue(SAMSUNG_SAMPLE.prompt);

  await jsonBox.fill(edited);
  await expect(warn).toHaveCount(0);

  await page.getByRole('button', { name: 'Remove' }).nth(1).click();
  j = JSON.parse(await jsonBox.inputValue()) as typeof j;
  expect(j.samples).toEqual([PIXEL_SAMPLE]);
  expect(j.queries).toBe(10);
  await expect(facts).toHaveValue('10');
  await expect(prompts).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Remove' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Remove' })).toBeDisabled();
});

test('AZ-037 Show validation errors when saving an incomplete or conflicting draft', async ({ page, request }) => {
  const token = await operatorToken(request);
  await login(page);
  await page.goto(`${NODE_A}/new-patch`);
  const posts: PwRequest[] = [];
  page.on('request', (r) => { if (isPost('/api/patches')(r)) posts.push(r); });
  const save = page.getByRole('button', { name: /^(Save draft|Saving draft…)$/ });
  const subject = page.getByLabel('Subject');
  const form = page.locator('form');
  const alertText = (t: string) => form.getByText(t, { exact: true });

  // 1. required-field validation blocks the empty Subject
  await page.getByLabel('Name', { exact: true }).fill('Validation test');
  await save.click();
  expect(await subject.evaluate((el: HTMLInputElement) => el.validity.valueMissing)).toBe(true);
  expect(await form.evaluate((f: HTMLFormElement) => f.checkValidity())).toBe(false);
  await expect(form.getByText(/Subject is required|Choose a \.npz/)).toHaveCount(0);
  expect(posts).toHaveLength(0);
  await subject.evaluate((el) => el.removeAttribute('required')); // bypass like DevTools would
  await save.click();
  await expect(alertText('Subject is required (e.g. "krx-ticker-codes").')).toBeVisible();
  expect(posts).toHaveLength(0);

  // 2. no file chosen
  await subject.fill('val-test');
  await save.click();
  const noFile = alertText('Choose a .npz file to upload.');
  await expect(noFile).toBeVisible();
  expect(await bg(noFile)).toBe(ALERT_ERROR_BG);
  expect(posts).toHaveLength(0);

  // 3. path mode, empty path
  await page.getByRole('radio', { name: 'Path on the node' }).check();
  await save.click();
  await expect(alertText('Give the path of the .npz on the node.')).toBeVisible();
  expect(posts).toHaveLength(0);

  // 4. path that does not exist → 400
  const pathInput = page.getByPlaceholder(NPZ_PATH);
  await pathInput.fill('/tmp/does-not-exist.npz');
  const [r4] = await Promise.all([page.waitForResponse((r) => r.url().endsWith('/api/patches') && r.request().method() === 'POST'), save.click()]);
  expect(r4.status()).toBe(400);
  await expect(alertText('path not found on node: /tmp/does-not-exist.npz')).toBeVisible();

  // 5. duplicate id → 409 Conflict with the plain message
  await pathInput.fill(NPZ_PATH);
  await page.getByLabel('Id (optional)').fill('krx-all-2761');
  const [r5] = await Promise.all([page.waitForResponse((r) => r.url().endsWith('/api/patches') && r.request().method() === 'POST'), save.click()]);
  expect(r5.status()).toBe(409);
  await expect(alertText('patch id already exists: krx-all-2761')).toBeVisible();

  // 6. one-character id → 400 with the slug rule
  await page.getByLabel('Id (optional)').fill('A');
  const [r6] = await Promise.all([page.waitForResponse((r) => r.url().endsWith('/api/patches') && r.request().method() === 'POST'), save.click()]);
  expect(r6.status()).toBe(400);
  await expect(alertText('invalid patch id (use 2-64 chars: a-z 0-9 . _ -)')).toBeVisible();
  const mine = (await api<{ items: PatchDetail[] }>(request, '/api/me/patches', { token })).body.items;
  expect(mine.some((e) => e.anchor.id === 'a' || e.anchor.id === 'A' || e.anchor.name === 'Validation test')).toBe(false);
});

// =====================================================================================================================
// manage a draft
// =====================================================================================================================
test('AZ-038 Edit description, price, billing and license of a draft and save', async ({ page, request }) => {
  const token = await operatorToken(request);
  const info = await nodeInfo(request);
  const id = readState().draftId ?? 'pixelplus-test-1';
  await ensureDraft(request, token, testDraftSpec(id));

  await login(page);
  await page.goto(manageUrl(NODE_A, info.address, id));
  await expect(titleChip(page)).toHaveText('Draft');
  await expect(page.getByRole('heading', { name: 'Description & price' })).toBeVisible();
  const desc = page.getByLabel('Description', { exact: true });
  const price = page.getByLabel('Price (AIN)');
  const billing = page.getByLabel('Billing');
  const track = page.getByLabel('Knowledge track');
  const license = page.getByLabel('License');
  for (const f of [desc, price, billing, track, license]) await expect(f).toBeEnabled();

  await desc.fill('Updated draft description');
  await price.fill('1.25');
  await billing.selectOption({ label: 'per hour loaded' });
  await track.fill('law/KR');
  await license.fill('MIT');

  await delayRoute(page, `**/api/patches/${id}`, 700, 'PATCH');
  const resP = page.waitForResponse((r) => r.url().endsWith(`/api/patches/${id}`) && r.request().method() === 'PATCH');
  const save = page.getByRole('button', { name: /^(Save|Saving…)$/ });
  await save.click();
  await expect(save).toHaveText('Saving…');
  const res = await resP;
  expect(res.status()).toBe(200);
  expect(((await res.json()) as { anchor: { id: string } }).anchor.id).toBe(id);
  const saved = page.getByText('Saved.', { exact: true });
  await expect(saved).toBeVisible();
  expect(await bg(saved)).toBe(ALERT_SUCCESS_BG);

  await page.reload();
  await expect(desc).toHaveValue('Updated draft description');
  await expect(price).toHaveValue('1.25');
  await expect(billing).toHaveValue('per_apply_hour');
  await expect(track).toHaveValue('law/KR');
  await expect(license).toHaveValue('MIT');
  await expect(page.getByText('Current price: 1.25 AIN', { exact: true })).toBeVisible();
  const check = page.locator('li', { hasText: 'Description written' }).locator('span').first();
  await expect(check).toHaveText('✓');
  expect(await bg(check)).toBe(GREEN);
});

test('AZ-039 Validate and save the benchmark JSON of a draft', async ({ page, request }) => {
  const token = await operatorToken(request);
  const info = await nodeInfo(request);
  const id = readState().draftId ?? 'pixelplus-test-1';
  const spec = testDraftSpec(id);
  let d = await ensureDraft(request, token, spec);
  if ((d.anchor.benchmark.samples?.length ?? 0) !== 1) { // re-run: start again from the scenario's single-sample draft
    await api(request, `/api/patches/${id}`, { method: 'PATCH', token, data: { benchmark: JSON.parse(benchmarkJson(spec)) } });
    d = (await patchDetail(request, id, token))!;
  }

  await login(page);
  await page.goto(manageUrl(NODE_A, info.address, id));
  await expect(page.getByRole('heading', { name: 'Benchmark questions' })).toBeVisible();
  const bench = page.locator('textarea:not([readonly])').first();
  const fingerprint = page.locator('span', { hasText: /^benchmark fingerprint/ }).locator('span');
  const before = (await fingerprint.textContent())!;
  expect(before).toBe(shortHash(d.anchor.benchmark_hash, 16));
  const patches: PwRequest[] = [];
  page.on('request', (r) => { if (r.url().endsWith(`/api/patches/${id}`) && r.method() === 'PATCH') patches.push(r); });
  const saveBench = page.getByRole('button', { name: 'Save benchmark' });

  const original = await bench.inputValue();
  await bench.fill(original.trimEnd().replace(/\}$/, ''));
  await saveBench.click();
  const invalid = page.getByText(/^Invalid JSON: .+/);
  await expect(invalid).toBeVisible();
  expect(await bg(invalid)).toBe(ALERT_ERROR_BG);
  expect(patches).toHaveLength(0);

  const parsed = JSON.parse(original) as { schema: string; samples: unknown[] };
  parsed.schema = '';
  await bench.fill(JSON.stringify(parsed, null, 2));
  await saveBench.click();
  await expect(page.getByText('benchmark.schema (string) is required', { exact: true })).toBeVisible();
  expect(patches).toHaveLength(0);

  parsed.schema = spec.schema;
  parsed.samples = [PIXEL_SAMPLE, SAMSUNG_SAMPLE];
  await bench.fill(JSON.stringify(parsed, null, 2));
  const [res] = await Promise.all([page.waitForResponse((r) => r.url().endsWith(`/api/patches/${id}`) && r.request().method() === 'PATCH'), saveBench.click()]);
  expect(res.status()).toBe(200);
  const savedAlert = page.getByText('Benchmark saved.', { exact: true });
  await expect(savedAlert).toBeVisible();
  expect(await bg(savedAlert)).toBe(ALERT_SUCCESS_BG);
  await expect(fingerprint).not.toHaveText(before);
  const after = (await patchDetail(request, id, token))!;
  expect(after.anchor.benchmark.samples).toHaveLength(2);
  await expect(fingerprint).toHaveText(shortHash(after.anchor.benchmark_hash, 16));
  await expect(page.locator('li', { hasText: '2 sample question(s) — verifiers score them on the real model' })).toBeVisible();

  await page.goto(manageUrl(NODE_A, info.address, K.final));
  await expect(page.locator('textarea:not([readonly])').first()).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save benchmark' })).toHaveCount(0);

  // cleanup: back to the scenario's single-sample benchmark so AZ-031 publishes exactly what C-05 created
  await api(request, `/api/patches/${id}`, { method: 'PATCH', token, data: { benchmark: JSON.parse(benchmarkJson(spec)) } });
});

test('AZ-048 Upload a .npz file from the browser and watch the fingerprint being computed', async ({ page, request }) => {
  const token = await operatorToken(request);
  const info = await nodeInfo(request);
  const id = await pickFreeId(request, token, 'pixelplus-upload-1');
  if (await deleteDraftIfAny(request, token, id)) note(`draft ${id} from an earlier run deleted so the UI flow creates it again`);
  saveState({ uploadId: id });
  const spec = uploadDraftSpec(id);

  await login(page);
  await page.goto(`${NODE_A}/new-patch`);
  await page.getByLabel('Name', { exact: true }).fill(spec.name);
  await page.getByLabel('Id (optional)').fill(id);
  await page.getByLabel('Subject').fill(spec.schema);
  await page.getByLabel('Question', { exact: true }).fill(PIXEL_SAMPLE.prompt);
  await page.getByLabel('Expected answer (prefix)').fill(PIXEL_SAMPLE.expect);

  const uploadRadio = page.getByRole('radio', { name: 'Upload a file' });
  await expect(uploadRadio).toBeChecked();
  const uploadCard = uploadRadio.locator('xpath=ancestor::label[1]');
  await expect(uploadCard).toContainText('copied into this node’s storage');
  await page.locator('input[type=file]').setInputFiles(NPZ_PATH);
  await expect(uploadCard).toContainText(`${NPZ_NAME} · 3.9 MB`);
  await expect(uploadCard).not.toContainText('copied into this node’s storage');
  await expect(page.getByText(/^\.npz arrays: addrs \(int64\), before \/ after \(float32 rows\)\./)).toBeVisible();

  await delayRoute(page, '**/api/patches', 1200, 'POST');
  const resP = page.waitForResponse((r) => r.url().endsWith('/api/patches') && r.request().method() === 'POST', { timeout: 180_000 });
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText(`Uploading ${NPZ_NAME} (3.9 MB) and computing the fingerprint…`, { exact: true })).toBeVisible();
  const res = await resP;
  expect(res.status()).toBe(200);
  expect(res.request().headers()['content-type'] ?? '').toContain('multipart/form-data');
  const anchor = ((await res.json()) as { anchor: PatchDetail['anchor'] }).anchor;
  expect(anchor.id).toBe(id);

  await page.waitForURL(manageUrl(NODE_A, info.address, id));
  await expect(kv(page, 'Knowledge file')).toHaveText(`present · ${fmtBytes(anchor.size_bytes)} · ${fmtNum(anchor.rows)} memory entries · ${fmtNum(anchor.benchmark.queries)} facts`);
  expect(fmtBytes(anchor.size_bytes)).toBe('3.7 MB');
  expect(anchor.rows).toBe(2992);
  expect(anchor.benchmark.queries).toBe(1);
  await expect(kv(page, 'File fingerprint')).toHaveText(/^[0-9a-f]{64}$/);
  expect(anchor.patch_sha256).toBe((await patchDetail(request, K.pixel, token))!.anchor.patch_sha256); // same content as pixelplus-087600
});

test('AZ-042 Delete a draft with typed confirmation and see that published knowledge cannot be deleted', async ({ page, request }) => {
  const token = await operatorToken(request);
  const info = await nodeInfo(request);
  let id = readState().uploadId ?? 'pixelplus-upload-1';
  const existing = await patchDetail(request, id, token);
  if (!existing || existing.status !== 'DRAFT') {
    id = await pickFreeId(request, token, 'pixelplus-upload-1');
    await ensureDraft(request, token, uploadDraftSpec(id));
    note(`no upload draft from AZ-048 — created ${id} through the API`);
  }

  await login(page);
  await page.goto(manageUrl(NODE_A, info.address, id));
  await expect(page.getByRole('heading', { name: 'Delete draft' })).toBeVisible();
  await expect(page.getByText('Deleting a draft removes it from this node. Nothing was published yet, so there is no public record.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  const input = page.getByPlaceholder(`Type ${id} to proceed.`);
  await expect(input).toBeVisible();
  const confirm = page.getByRole('button', { name: /^(Confirm delete|Deleting…)$/ });
  await expect(confirm).toBeDisabled();
  await input.fill(id.slice(0, -1));
  await expect(confirm).toBeDisabled();
  await input.fill(id);
  await expect(confirm).toBeEnabled();

  await delayRoute(page, `**/api/patches/${id}`, 700, 'DELETE');
  const resP = page.waitForResponse((r) => r.url().endsWith(`/api/patches/${id}`) && r.request().method() === 'DELETE');
  await confirm.click();
  await expect(confirm).toHaveText('Deleting…');
  const res = await resP;
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  await page.waitForURL(`${NODE_A}/dashboard`);
  await expect(page.getByRole('table').first().getByRole('row').filter({ hasText: KRX_NAME })).toBeVisible();
  await expect(page.getByRole('table').first().getByRole('row').filter({ hasText: `${id} ·` })).toHaveCount(0);

  await page.goto(manageUrl(NODE_A, info.address, K.final));
  await expect(page.getByText('Published knowledge cannot be deleted — its record is permanent. To stop serving the file from this node, use the developer command below.', { exact: true })).toBeVisible();
  await expect(page.getByText('Stop serving the file from this node:', { exact: true })).toBeVisible();
  await expect(page.getByText('ainize patch forget krx-all-2761', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0);
  note('bin.ts has no `patch forget` subcommand — the manage page advertises `ainize patch forget <id>` (docs/CLI gap)');

  await page.goto(manageUrl(NODE_A, info.address, id));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Knowledge not found');
  await expect(page.getByText('patch not found')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to my knowledge' })).toHaveAttribute('href', '/dashboard');
});

test('AZ-049 Copy the README badge snippet for the auto-pay address', async ({ page, request, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: NODE_A });
  const token = await operatorToken(request);
  const info = await nodeInfo(request);
  await login(page);
  await page.goto(manageUrl(NODE_A, info.address, K.final));
  await expect(page.getByRole('heading', { name: 'README badge' })).toBeVisible();
  const snippet = `[![Ainize knowledge: krx-all-2761](${NODE_A}/static/images/ic-certified.svg)](${NODE_A}/x402/patch/krx-all-2761)`;
  await expect(page.locator('textarea[readonly]')).toHaveValue(snippet);
  await expect(page.getByText('Paste this badge into a README — it links straight to this knowledge’s auto-payment address so people and AI agents can buy it.', { exact: true })).toBeVisible();
  const copy = page.getByRole('button', { name: /^(Copy|Copied)$/ });
  await copy.click();
  await expect(copy).toHaveText('Copied');
  await expect(copy).toHaveText('Copy', { timeout: 4000 });
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(snippet);
  const r402 = await request.get(`${NODE_A}/x402/patch/krx-all-2761`);
  expect(r402.status()).toBe(402);
  const body = (await r402.json()) as { requirements: unknown[] };
  expect(body.requirements.length).toBeGreaterThan(0);
  const gwListed = page.locator('a', { hasText: `${NODE_A}/x402/patch/krx-all-2761` });
  expect(await gwListed.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('auto');

  const id = readState().draftId ?? 'pixelplus-test-1';
  await ensureDraft(request, token, testDraftSpec(id));
  await page.goto(manageUrl(NODE_A, info.address, id));
  await expect(titleChip(page)).toHaveText('Draft');
  const pageLink = page.locator('a', { hasText: `${NODE_A}/${info.address}/${id}` });
  const gwLink = page.locator('a', { hasText: `${NODE_A}/x402/patch/${id}` });
  expect(await pageLink.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');
  expect(await color(pageLink)).toBe('rgb(218, 218, 218)');
  expect(await gwLink.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');
});

// =====================================================================================================================
// read-only manage / logs
// =====================================================================================================================
test('AZ-040 Inspect the overlap check and lineage of the verified KRX knowledge', async ({ page, request }) => {
  const token = await operatorToken(request);
  const info = await nodeInfo(request);
  const d = (await patchDetail(request, K.final, token))!;
  expect(d.status).toBe('LISTED');
  expect(d.supersedes).toEqual(['krx-all-2761-ep12', 'krx-all-2761-ep6', 'pixelplus-087600']);
  expect(d.anchor.parents).toEqual(['krx-all-2761-ep12']);

  await login(page);
  await page.goto(manageUrl(NODE_A, info.address, K.final));
  await expect(page.getByRole('heading', { name: 'Overlap check' })).toBeVisible();
  await expect(page.getByText('Automatically checks whether other knowledge on this node overlaps with this one. When newer knowledge on the same subject is verified, the older one is marked "newer version available".', { exact: true })).toBeVisible();
  const overlap = page.getByRole('table').nth(1);
  await expect(overlap.locator('thead th')).toHaveText(['Knowledge', 'Overlapping entries', 'Same subject', 'Status']);
  const expected: Record<string, number> = { 'krx-all-2761-ep12': 241992, 'krx-all-2761-ep6': 241992, 'pixelplus-087600': 2170 };
  for (const [pid, rows] of Object.entries(expected)) {
    const c = d.conflicts.find((x) => x.patch_id === pid)!;
    expect(c, `conflict row for ${pid}`).toBeTruthy();
    expect(c.overlap_rows).toBe(rows);
    const row = overlap.getByRole('row').filter({ has: page.getByRole('link', { name: pid, exact: true }) });
    const cells = row.getByRole('cell');
    await expect(cells.nth(1)).toHaveText(`${fmtNum(rows)} memory entries`);
    await expect(cells.nth(2)).toHaveText('yes');
    expect(await color(cells.nth(2))).toBe(RED);
    await expect(cells.nth(3)).toHaveText('Newer version available');
  }
  await overlap.getByRole('link', { name: 'krx-all-2761-ep6', exact: true }).click();
  await page.waitForURL(`${NODE_A}/${info.address}/krx-all-2761-ep6`);
  await page.goBack();

  await expect(page.getByRole('heading', { name: 'Source & derived knowledge' })).toBeVisible();
  const builtOn = kv(page, 'Built on');
  await expect(builtOn.getByRole('link', { name: EP12_NAME })).toBeVisible();
  await expect(builtOn).toContainText('Newer version available');
  await expect(kv(page, 'Derived from this')).toHaveText('none');
  await expect(kv(page, 'Replaces')).toHaveText('krx-all-2761-ep12, krx-all-2761-ep6, pixelplus-087600');
  await expect(kv(page, 'Replaced by')).toHaveText('—');
  await expect(page.getByText('When derived knowledge sells, the original creator automatically receives a share (creator revenue share).', { exact: true })).toBeVisible();

  await page.goto(manageUrl(NODE_A, info.address, K.ep6));
  await expect(titleChip(page)).toHaveText('Newer version available');
  await expect(kv(page, 'Built on')).toHaveText('none (original knowledge)');
  await expect(kv(page, 'Derived from this').getByRole('link', { name: EP12_NAME })).toBeVisible();
  await expect(kv(page, 'Replaced by')).toHaveText('krx-all-2761');
});

test('AZ-043 Filter node logs by level, expand details, load older events and read the public-record timeline', async ({ page, request }) => {
  const info = await nodeInfo(request);
  const events = (await api<{ events: { seq: number; level: string; kind: string; message: string; data: unknown }[] }>(request, `/api/patches/${K.final}/events?limit=100`)).body.events;
  const records = (await api<{ records: { kind: string; ts: number; hash: string; sig: string; body: Record<string, unknown> }[] }>(request, `/api/patches/${K.final}/records`)).body.records;
  expect(events.length).toBeGreaterThan(0);
  expect(records.length).toBeGreaterThan(0);

  await login(page);
  await delayRoute(page, /\/api\/patches\/krx-all-2761\/events/, 600);
  await page.goto(`${manageUrl(NODE_A, info.address, K.final)}/logs`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('krx-all-2761 logs');
  await expect(page.locator('h1').locator('xpath=ancestor::div[1]/following-sibling::p[1]')).toHaveText(/^What happened on this node for this knowledge \(draft, publish, verification, trades, load\/unload\), refreshed every 5 seconds\./);
  const header = page.getByText(/^\d+ line\(s\)/);
  await expect(header).toHaveText(/^\d+ line\(s\)/);
  await expect(header).toContainText('refreshing…', { timeout: 8000 });
  const countOf = async () => Number(/^(\d+) line\(s\)/.exec((await header.textContent()) ?? '')![1]);

  // rows: time · level · kind · message; expand a line that carries details ("⋯")
  const withData = events.find((e) => e.data !== null && e.data !== undefined)!;
  expect(withData, 'an event with a data payload').toBeTruthy();
  const line = page.getByText(new RegExp(`^${esc(withData.message)}\\s+⋯$`)).first();
  await expect(line).toBeVisible();
  const row = line.locator('xpath=..');
  await expect(row).toContainText(withData.level.toUpperCase());
  await expect(row).toContainText(withData.kind);
  await expect(row.locator('div').first()).toHaveText(/^\d{2}:\d{2}:\d{2}$/);
  await line.click();
  const pre = row.locator('xpath=following-sibling::pre[1]');
  await expect(pre).toBeVisible();
  for (const k of Object.keys(withData.data as Record<string, unknown>)) await expect(pre).toContainText(`"${k}"`);
  await line.click();
  await expect(pre).toHaveCount(0);
  const levelColors = { INFO: 'rgb(51, 51, 51)', WARN: 'rgb(246, 152, 29)', ERROR: 'rgb(231, 113, 27)' } as const;
  expect(await color(page.getByText(withData.level.toUpperCase(), { exact: true }).first())).toBe(levelColors[withData.level.toUpperCase() as keyof typeof levelColors]);

  // level filter
  const pick = async (from: string, to: string) => { await page.getByRole('button', { name: from }).click(); await page.getByRole('option', { name: to }).click(); };
  const levelCount = (lvl: string) => page.getByText(lvl, { exact: true }).count();
  await pick('All levels', 'Error');
  await expect(header).toHaveText(/^\d+ line\(s\)/);
  let n = await countOf();
  expect(await levelCount('ERROR')).toBe(n);
  expect(await levelCount('INFO') + await levelCount('WARN') + await levelCount('DEBUG')).toBe(0);
  if (n === 0) await expect(page.getByText('No events for this knowledge yet.', { exact: true })).toBeVisible();
  await pick('Error', 'Warning');
  n = await countOf();
  expect(await levelCount('WARN')).toBe(n);
  expect(await levelCount('INFO') + await levelCount('ERROR')).toBe(0);
  await pick('Warning', 'Info');
  n = await countOf();
  expect(n).toBeGreaterThan(0);
  expect(await levelCount('INFO') + await levelCount('DEBUG')).toBe(n);
  expect(await levelCount('WARN') + await levelCount('ERROR')).toBe(0);

  // load older → limit=300
  const [req] = await Promise.all([
    page.waitForRequest((r) => r.url().includes(`/api/patches/${K.final}/events`) && r.url().includes('limit=300')),
    page.getByRole('button', { name: 'Load older' }).click(),
  ]);
  expect(new URL(req.url()).searchParams.get('limit')).toBe('300');
  await expect(page.getByText('showing up to 300 events · times in local timezone', { exact: true })).toBeVisible();

  // public-record timeline
  await expect(page.getByRole('heading', { name: 'Public-record timeline' })).toBeVisible();
  const items = page.locator('ol > li');
  await expect(items).toHaveCount(records.length);
  const anchorRec = records.find((r) => r.kind === 'anchor')!;
  await expect(items.filter({ hasText: /^registered\b/ })).toContainText(`registered by node-a · file fingerprint ${shortHash(String(anchorRec.body.patch_sha256), 12)} · price 25 AIN`);
  for (const v of ['node-b', 'node-c']) await expect(items.filter({ hasText: `PASS by ${v}` })).toContainText(`PASS by ${v} (executed (vllm:${MODEL})) · accuracy 26/26`);
  await expect(items.filter({ hasText: 'replaces krx-all-2761-ep12' })).toContainText('krx-all-2761 replaces krx-all-2761-ep12 (241992 shared entries)');
  const texts = await items.allTextContents();
  for (const t of texts) { expect(t).toMatch(/record [0-9a-f]{16}…/); expect(t).not.toContain('· tx '); }
  const kinds = [];
  for (let i = 0; i < texts.length; i++) kinds.push((await items.nth(i).locator('span').first().textContent())!.trim());
  // scenario: ledger order oldest → newest — registered, verified…, replaced
  expect.soft(kinds[0], `timeline order (got ${kinds.join(' → ')})`).toBe('registered');
  expect.soft(kinds.indexOf('replaced'), 'replaced entries after the verified entries').toBeGreaterThan(kinds.lastIndexOf('verified'));
  const supersedeTs = records.filter((r) => r.kind === 'supersede').map((r) => r.ts);
  if (supersedeTs.some((t) => t === 0)) note(`supersede records carry ts=0 on the AIN ledger (${supersedeTs.length} record(s)) → they sort first and show "—" as date`);

  await page.getByRole('link', { name: 'Back to manage' }).click();
  await page.waitForURL(manageUrl(NODE_A, info.address, K.final));
});

// =====================================================================================================================
// account
// =====================================================================================================================
test('AZ-044 Save display name, payout address and notification preference on the node', async ({ page, request }) => {
  const token = await operatorToken(request);
  const me = await authMe(request);
  const s0 = (await api<{ settings: { display_name: string; notifications: string; payout_address: string } }>(request, '/api/me/settings', { token })).body.settings;
  if (s0.display_name !== 'node-a' || s0.notifications !== 'all') {
    await api(request, '/api/me/settings', { method: 'PATCH', token, data: { display_name: 'node-a', notifications: 'all' } });
    note('settings restored to display name node-a / Everything before the scenario');
  }

  await login(page);
  await page.goto(`${NODE_A}/account`);
  await expect(page.getByRole('heading', { name: 'Notifications & payout' })).toBeVisible();
  await expect(page.getByText('These settings are stored on the node, so they are the same in every browser.', { exact: true })).toBeVisible();
  await expect(page.getByText('Shown as the creator on knowledge pages and in the network.', { exact: true })).toBeVisible();
  await expect(page.getByText('Where sales revenue and creator revenue share arrive. Defaults to this node’s address.', { exact: true })).toBeVisible();
  const save = page.getByRole('button', { name: /^(Save settings|Saving…)$/ });
  const name = page.getByLabel('Display name');
  const payout = page.getByLabel('Payout address');
  await expect(name).toHaveValue('node-a');
  await expect(payout).toHaveValue(me.address);
  await expect(payout).toHaveAttribute('placeholder', me.address);
  await expect(save).toBeDisabled();

  await name.fill('node-a demo');
  await page.getByRole('radio', { name: 'Sales only — when my knowledge sells' }).check();
  await delayRoute(page, '**/api/me/settings', 700, 'PATCH');
  const resP = page.waitForResponse((r) => r.url().endsWith('/api/me/settings') && r.request().method() === 'PATCH');
  await save.click();
  await expect(save).toHaveText('Saving…');
  const res = await resP;
  expect(res.status()).toBe(200);
  expect(((await res.json()) as { settings: { display_name: string } }).settings.display_name).toBe('node-a demo');
  const savedMsg = page.getByText('Saved on the node.', { exact: true });
  await expect(savedMsg).toBeVisible();
  expect(await color(savedMsg)).toBe(GREEN);
  await expect(save).toBeDisabled();

  await page.reload();
  await expect(name).toHaveValue('node-a demo');
  await expect(page.getByRole('radio', { name: 'Sales only — when my knowledge sells' })).toBeChecked();
  await expect(page.locator('header').getByRole('button', { name: 'node-a demo ▾' })).toBeVisible();
  const s1 = (await api<{ settings: { display_name: string; notifications: string } }>(request, '/api/me/settings', { token })).body.settings;
  expect(s1).toMatchObject({ display_name: 'node-a demo', notifications: 'sales' });

  const patches: PwRequest[] = [];
  page.on('request', (r) => { if (r.url().endsWith('/api/me/settings') && r.method() === 'PATCH') patches.push(r); });
  await name.fill('');
  await expect(save).toBeEnabled();
  await save.click();
  expect(await name.evaluate((el: HTMLInputElement) => el.validity.valueMissing)).toBe(true);
  expect(patches).toHaveLength(0);
  await name.evaluate((el) => el.removeAttribute('required'));
  const [r400] = await Promise.all([page.waitForResponse((r) => r.url().endsWith('/api/me/settings') && r.request().method() === 'PATCH'), save.click()]);
  expect(r400.status()).toBe(400);
  const b400 = (await r400.json()) as { error: string; issues: unknown[] };
  expect(b400.error).toBe('invalid request');
  expect(b400.issues.length).toBeGreaterThan(0);
  await expect(page.getByText(/^invalid request: .+/)).toBeVisible();

  await name.fill('node-a');
  await page.getByRole('radio', { name: 'Everything — sales, verification results, new knowledge in subscribed tracks' }).check();
  const [r3] = await Promise.all([page.waitForResponse((r) => r.url().endsWith('/api/me/settings') && r.request().method() === 'PATCH'), save.click()]);
  expect(r3.status()).toBe(200);
  await expect(page.getByText('Saved on the node.', { exact: true })).toBeVisible();
  await expect(page.locator('header').getByRole('button', { name: 'node-a ▾' })).toBeVisible();
  const s2 = (await api<{ settings: { display_name: string; notifications: string } }>(request, '/api/me/settings', { token })).body.settings;
  expect(s2).toMatchObject({ display_name: 'node-a', notifications: 'all' });
});

test('AZ-045 Read account identity, AIN wallet balance, sales and creator revenue share', async ({ page, request }) => {
  const token = await operatorToken(request);
  const me = await authMe(request);
  const info = (await api<{ node: { endpoint: string; version: string }; ledger: { kind: string; provider: string; app: string; records: number; height: number }; quorum: number; currency: string }>(request, '/api/info')).body;
  expect(info.ledger.kind).toBe('ain');
  expect(info.currency).toBe('AIN');
  type Wallet = { balance: number | null; purchases: number; sales: { patch_id: string }[]; royalties: unknown[] };
  const wallet0 = (await api<Wallet>(request, '/api/me/wallet', { token })).body;

  await login(page);
  await page.goto(`${NODE_A}/account`);
  await expect(page.getByRole('heading', { name: 'Account', exact: true })).toBeVisible();
  await expect(kv(page, 'Name')).toHaveText(me.name);
  await expect(kv(page, 'Account address')).toContainText(me.address);
  await expect(kv(page, 'Account address').getByRole('button', { name: 'Copy' })).toBeVisible();
  await expect(kv(page, 'Roles')).toHaveText('seller, verifier, serving');
  await expect(kv(page, 'Node endpoint')).toHaveText('http://localhost:3402');
  await expect(kv(page, 'Public record')).toHaveText('AI Network blockchain · http://localhost:8081 · /apps/knowledge');
  await expect(kv(page, 'Records')).toHaveText(/^\d[\d,]* · chain blocks \d[\d,]*$/);
  await expect(kv(page, 'Verified when')).toHaveText(`${info.quorum}+ independent verifier nodes pass`);
  expect(info.quorum).toBe(2);
  await expect(kv(page, 'Version')).toHaveText(/^\d+\.\d+\.\d+/);

  await expect(page.getByText('AIN balance of this node’s account. Purchases are AIN transfers; sales revenue and creator revenue share arrive here.', { exact: true })).toBeVisible();
  const balance = page.getByRole('heading', { name: 'Wallet' }).locator('xpath=following-sibling::div[1]');
  const wallet1 = (await api<Wallet>(request, '/api/me/wallet', { token })).body;
  const shown = ((await balance.textContent()) ?? '').trim();
  const candidates = [wallet0, wallet1].map((w) => (w.balance === null ? '—AIN' : `${fmtNum(w.balance)}AIN`));
  expect(candidates, `balance ${shown}`).toContain(shown);
  await expect(balance.locator('span')).toHaveText('AIN');
  await expect(page.getByText('AIN = AI Network token (this demo runs a local dev chain)', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(new RegExp(`^${wallet1.purchases} purchase\\(s\\) · ${wallet1.sales.length} sale\\(s\\) · ${wallet1.royalties.length} creator-share payment\\(s\\) received$`))).toBeVisible();
  const sales = page.getByRole('table').nth(0);
  const royalties = page.getByRole('table').nth(1);
  if (wallet1.sales.length === 0) await expect(sales).toContainText('No sales yet.');
  else for (const s of wallet1.sales.slice(0, 20)) await expect(sales).toContainText(s.patch_id);
  if (wallet1.royalties.length === 0) await expect(royalties).toContainText('None yet — it accrues when knowledge built on yours sells.');

  await delayRoute(page, '**/api/chain/setup', 700, 'POST');
  const setup = page.getByRole('button', { name: /^(Set up app on chain|Setting up…)$/ });
  const resP = page.waitForResponse((r) => r.url().endsWith('/api/chain/setup'), { timeout: 120_000 });
  await setup.click();
  await expect(setup).toHaveText('Setting up…');
  expect((await resP).status()).toBe(200);
  await expect(page.getByText('Knowledge app and market rules are set on chain.', { exact: true })).toBeVisible();
  await expect(page.getByText('Needed once; safe to run again.', { exact: true })).toBeVisible();

  await expect(page.getByRole('heading', { name: 'Node operators & developers' })).toBeVisible();
  await expect(page.getByText('ainize node retire', { exact: true })).toBeVisible();
  await expect(page.getByText('The chain setup button runs ain-js knowledge.setupApp() and installs the market write rules (idempotent).', { exact: true })).toBeVisible();
  await expect(page.getByText('Node state (raw)', { exact: true })).toBeVisible();
  const raw = JSON.parse((await page.getByText('Node state (raw)', { exact: true }).locator('xpath=following-sibling::pre[1]').textContent())!) as Record<string, unknown>;
  expect(Object.keys(raw)).toEqual(expect.arrayContaining(['address', 'ledger', 'peers', 'counts', 'chain_head', 'settings']));
  expect(raw.address).toBe(me.address);
});

test('AZ-046 Remove and re-add a connected peer node', async ({ page, request }) => {
  type Peers = { peers: { endpoint: string; last_seen: number; failures: number; info: { name: string; roles: string[] } | null }[] };
  const peers0 = (await api<Peers>(request, '/api/nodes')).body.peers;
  expect(peers0.map((p) => p.endpoint).sort()).toEqual([NODE_B, NODE_C]);

  await login(page);
  await page.goto(`${NODE_A}/account`);
  const heading = page.getByRole('heading', { name: 'Connected nodes' });
  await expect(heading).toBeVisible();
  const desc = heading.locator('xpath=following-sibling::p[1]');
  await expect(desc).toHaveText('Nodes this one connects to first; the rest are discovered automatically. See the whole network on the Network page.');
  await expect(desc.getByRole('link', { name: 'Network' })).toHaveAttribute('href', '/network');
  const table = heading.locator('xpath=following-sibling::div[1]').getByRole('table');
  await expect(table.locator('thead th')).toHaveText(['Endpoint', 'Name', 'Account address', 'Roles', 'Last seen', 'Failures', '']);
  const rowB = table.getByRole('row').filter({ hasText: NODE_B });
  const rowC = table.getByRole('row').filter({ hasText: NODE_C });
  await expect(rowB.getByRole('cell').nth(1)).toHaveText('node-b');
  await expect(rowB.getByRole('cell').nth(3)).toHaveText('verifier');
  await expect(rowC.getByRole('cell').nth(1)).toHaveText('node-c');
  await expect(rowC.getByRole('cell').nth(3)).toHaveText('verifier, serving');
  for (const r of [rowB, rowC]) {
    await expect(r.getByRole('cell').nth(4)).toHaveText(/^\d+(s|m|h|d) ago$/);
    await expect(r.getByRole('cell').nth(5)).toHaveText('0');
    await expect(r.getByRole('button', { name: 'Remove' })).toBeVisible();
  }

  // node-c has node-a as a configured peer and says hello every ~4 s, so the peer exchange can re-add it before the
  // polling table ever renders without it. To assert the "row disappears" half for real, the next /api/nodes poll AFTER
  // the DELETE is served with the post-delete peer list (the node's own answer, node-c filtered out); rediscovery then
  // runs unmodified against the live node.
  let deleted = false;
  page.on('response', (r) => { if (r.url().endsWith('/api/peers') && r.request().method() === 'DELETE') deleted = true; });
  await page.route('**/api/nodes', async (route) => {
    const resp = await route.fetch();
    const json = (await resp.json()) as Peers;
    if (deleted) json.peers = json.peers.filter((p) => p.endpoint !== NODE_C);
    await route.fulfill({ response: resp, json });
  });
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/peers') && r.request().method() === 'DELETE'),
    rowC.getByRole('button', { name: 'Remove' }).click(),
  ]);
  const rightAfter = (await api<Peers>(request, '/api/nodes')).body.peers.map((p) => p.endpoint);
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(rightAfter).not.toContain(NODE_C);
  await expect(page.getByText('Node removed.', { exact: true })).toBeVisible();
  // the table renders the removal …
  await expect(rowC).toHaveCount(0, { timeout: 30_000 });
  await page.unroute('**/api/nodes');
  // … and then, unmodified, the row comes back on its own ("only briefly", per the scenario)
  await expect.poll(async () => (await api<Peers>(request, '/api/nodes')).body.peers.map((p) => p.endpoint), { timeout: 30_000, message: 'peer :3404 re-discovered' }).toContain(NODE_C);
  await expect(rowC).toHaveCount(1, { timeout: 30_000 });   // and it is back in the table on its own

  await page.getByLabel('Add node endpoint').fill(`${NODE_C}/`);
  const [addReq, addRes] = await Promise.all([
    page.waitForRequest((r) => r.url().endsWith('/api/peers') && r.method() === 'POST'),
    page.waitForResponse((r) => r.url().endsWith('/api/peers') && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Add' }).click(),
  ]);
  expect(addReq.postDataJSON()).toEqual({ endpoint: NODE_C });
  expect(addRes.status()).toBe(200);
  await expect(page.getByText('Node added.', { exact: true })).toBeVisible();
  await expect(rowC).toHaveCount(1);
  await expect(rowC.getByRole('cell').nth(4)).toHaveText(/^(\d+(s|m|h|d) ago|never)$/);
  const cfg = JSON.parse(readFileSync(join(HOME_A, 'config.json'), 'utf8')) as { peers: string[] };
  expect(cfg.peers).toContain(NODE_C);

  await sleep(10_000);
  await page.reload();
  await expect(rowC.getByRole('cell').nth(4)).toHaveText(/^\d+s ago$/);
  await page.goto(`${NODE_A}/network`);
  for (const n of ['node-a', 'node-b', 'node-c']) await expect(page.getByText(n, { exact: true }).first()).toBeVisible();
});

test('AZ-047 Review Files & changes: pairing hint, sync, file tree and change history', async ({ page, request, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: NODE_A });
  type Drive = { configured: boolean; running: boolean; server: string; folder: string; url: string | null; login_hint: string; files: { path: string }[] };
  const d0 = (await api<Drive>(request, '/api/drive')).body;
  expect(d0.configured, 'drive not yet paired (precondition)').toBe(false);
  expect(d0.running).toBe(false);

  await login(page);
  await page.goto(`${NODE_A}/dashboard`);
  await page.locator('header').getByRole('button', { name: /▾$/ }).click();
  await page.getByRole('menuitem', { name: 'Files & changes' }).click();
  await page.waitForURL(`${NODE_A}/drive`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Files & changes');
  await expect(kv(page, 'Sharing')).toHaveText('stopped');
  await expect(kv(page, 'Connected')).toHaveText('not yet');
  await expect(kv(page, 'Server')).toHaveText('https://aindrive.ainetwork.ai');
  await expect(kv(page, 'Folder')).toHaveText(d0.folder);
  expect(d0.folder).toBe('/home/comcom/.ngram-cluster/node-a/data/drive');
  await expect(kv(page, 'Files')).toHaveText(String(d0.files.length));
  await expect(page.getByRole('button', { name: 'Start sharing' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Sync' })).toBeEnabled();
  await expect(page.getByRole('link', { name: 'Open in aindrive ↗' })).toHaveCount(0);

  await expect(page.getByText('Connect once', { exact: true })).toBeVisible();
  await expect(page.getByText('Run the command below in a terminal on the node’s computer; a browser opens. After you sign in the folder is connected, and from then on you only press "Start sharing" here.', { exact: true })).toBeVisible();
  await expect(page.getByText(d0.login_hint, { exact: true })).toBeVisible();
  expect(d0.login_hint).toContain(`cd ${d0.folder} && npx aindrive login --server https://aindrive.ainetwork.ai`);
  await expect(page.getByText(/^The link is single-use and expires in 10 minutes\./)).toBeVisible();
  const copy = page.getByRole('button', { name: /^(Copy|Copied)$/ });
  await copy.click();
  await expect(copy).toHaveText('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(d0.login_hint);
  await expect(page.getByText('Pick a text file (json / md / jsonl) on the left to see its content and change history.', { exact: true })).toBeVisible();

  const [syncReq, syncRes] = await Promise.all([
    page.waitForRequest((r) => r.url().endsWith('/api/drive') && r.method() === 'POST'),
    page.waitForResponse((r) => r.url().endsWith('/api/drive') && r.request().method() === 'POST', { timeout: 120_000 }),
    page.getByRole('button', { name: 'Sync' }).click(),
  ]);
  expect(syncReq.postDataJSON()).toEqual({ action: 'sync' });
  expect(syncRes.status()).toBe(200);
  await expect(page.getByText(/^Synced — \d+ file\(s\) rewritten\.$/)).toBeVisible();

  await expect(page.locator('div', { hasText: /^patches$/ }).first()).toBeVisible();
  await page.locator('button[title="patches/krx-all-2761/manifest.json"]').click();
  await page.waitForURL(`${NODE_A}/drive/patches/krx-all-2761/manifest.json`);
  await expect(page.locator('strong', { hasText: 'patches/krx-all-2761/manifest.json' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy content' })).toBeVisible();
  await expect(page.getByText('doc id — (not connected yet; no history) · 0 change(s)', { exact: true })).toBeVisible();
  await expect(page.locator('pre').first()).toContainText('"id": "krx-all-2761"');

  const npz = page.locator('button[title^="patches/krx-all-2761/"][title$=".npz"]');
  await expect(npz).toBeDisabled();
  expect(await color(npz)).toBe('rgb(141, 141, 143)');
  await npz.click({ force: true }).catch(() => undefined);
  expect(page.url()).toBe(`${NODE_A}/drive/patches/krx-all-2761/manifest.json`);

  await page.locator('button[title="patches/krx-all-2761/benchmark.json"]').click();
  await page.waitForURL(`${NODE_A}/drive/patches/krx-all-2761/benchmark.json`);
  await expect(page.getByRole('heading', { name: 'Change history' })).toBeVisible();
  await expect(page.getByText('No history yet — it appears once the file is edited through aindrive (web editor or an AI agent).', { exact: true })).toBeVisible();
});

// =====================================================================================================================
// runtime-touching scenarios (shared vLLM + cross-process lock) — serial
// =====================================================================================================================
test.describe('runtime', () => {
  // Not serial on purpose: the tests wait for the shared runtime themselves, so a vLLM hiccup in one of them must not
  // skip the rest of the block (workers=1 keeps them in file order; AZ-041 checks its AZ-031 precondition explicitly).

  test('AZ-031 Publish a draft after the checklist and follow verification until the knowledge is on sale', async ({ page, request }) => {
    test.setTimeout(30 * 60_000);
    const token = await operatorToken(request);
    const info = await nodeInfo(request);
    let id = readState().draftId ?? 'pixelplus-test-1';
    let spec = testDraftSpec(id);
    let d = await patchDetail(request, id, token);
    if (d && d.status !== 'DRAFT') {
      // The recorded draft is already on the public record (a targeted re-run of AZ-031, or AZ-030 did not run first).
      // Publishing IS this scenario, so guarantee the precondition with a fresh id instead of following verification only.
      note(`${id} is already ${d.status} — creating an identical fresh draft so the checklist + publish half really runs`);
      id = await pickFreeId(request, token, 'pixelplus-test-1');
      spec = testDraftSpec(id);
      d = await patchDetail(request, id, token);
    }
    if (!d) d = await ensureDraft(request, token, { ...spec, visibility: 'test' });
    if (d.status === 'DRAFT' && d.anchor.visibility !== 'test') {
      // the web form cannot set visibility; re-create the identical draft with visibility:test so the public catalog stays clean
      await deleteDraftIfAny(request, token, id);
      await createDraftViaApi(request, token, { ...spec, description: d.anchor.description || spec.description, price: d.anchor.price, billing: d.anchor.billing as never, license: d.anchor.license, visibility: 'test' });
      d = (await patchDetail(request, id, token))!;
      note(`draft ${id} re-created with visibility:test (identical fields) before publishing`);
    }
    saveState({ publishedId: id });
    expect(d.status, 'AZ-031 publishes a DRAFT — the precondition is created above when the recorded one is gone').toBe('DRAFT');
    const samples = d.anchor.benchmark.samples?.length ?? 0;
    expect(samples).toBeGreaterThan(0);
    expect(await waitForRuntime(request, NODE_B), 'node-b runtime').toBe(true);
    expect(await waitForRuntime(request, NODE_C), 'node-c runtime').toBe(true);
    await waitForLockFree(request);

    await login(page);
    await page.goto(manageUrl(NODE_A, info.address, id));
    {
      await expect(titleChip(page)).toHaveText('Draft');
      const list = page.locator('strong', { hasText: 'Before you publish' }).locator('xpath=following-sibling::ul[1]');
      // each row is a "✓" mark span followed by the label text
      const checkLabels = [
        'Knowledge file is on this node', `Subject set (${spec.schema})`, `${samples} sample question(s) — verifiers score them on the real model`,
        'Description written', 'No overlap with verified knowledge on the same subject (0 overlap(s))',
      ];
      await expect(list.locator('li')).toHaveText(checkLabels.map((l) => new RegExp(`^✓\\s*${l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)));
      for (let i = 0; i < 5; i++) await expect(list.locator('li').nth(i).locator('span').first()).toHaveText('✓');
      await expect(page.getByText('After publishing, name, price and benchmark are sealed. The file stays only on this node until it is bought.', { exact: true })).toBeVisible();

      await delayRoute(page, `**/api/patches/${id}/announce`, 800, 'POST');
      const resP = page.waitForResponse((r) => r.url().endsWith(`/api/patches/${id}/announce`), { timeout: 120_000 });
      const publish = page.getByRole('button', { name: /^(Publish to the network|Publishing…)$/ });
      await publish.click();
      await expect(publish).toHaveText('Publishing…');
      const res = await resP;
      expect(res.status()).toBe(200);
      const rec = ((await res.json()) as { record: { kind: string; body: { id: string } } }).record;
      expect(rec.kind).toBe('anchor');
      expect(rec.body.id).toBe(id);
      const published = page.getByText('Published — it is on the public record and verifiers were notified.', { exact: true });
      await expect(published).toBeVisible();
      expect(await bg(published)).toBe(ALERT_SUCCESS_BG);
    }

    // watch the chip / line while node-b and node-c verify (page polls every 5 s)
    const chip = titleChip(page);
    const line = kv(page, 'Verification');
    const chips = new Set<string>();
    const lines = new Set<string>();
    let spinnerSeen = false;
    let firstAt: number | null = null;
    let secondAt: number | null = null;
    const t0 = Date.now();
    let cur: PatchDetail | null = null;
    while (Date.now() - t0 < 15 * 60_000) {
      const c = ((await chip.textContent()) ?? '').trim();
      chips.add(c);
      lines.add(((await line.textContent()) ?? '').trim());
      if ((c === 'Verifying' || c === 'Registered · awaiting verification') && (await animatedDescendants(line)) > 0) spinnerSeen = true;
      cur = await patchDetail(page.request, id);
      const passed = cur?.attestations.filter((a) => a.passed).length ?? 0;
      if (passed >= 1 && firstAt === null) firstAt = Date.now();
      if (passed >= 2 && secondAt === null) secondAt = Date.now();
      if (cur?.status === 'REJECTED') throw new Error(`verification rejected: ${JSON.stringify(cur.attestations.map((a) => a.score))}`);
      if (cur?.status === 'LISTED' && c === 'For sale') break;
      await sleep(1000);
    }
    expect(cur?.status, `final status after ${Math.round((Date.now() - t0) / 1000)}s`).toBe('LISTED');
    expect([...chips]).toContain('Registered · awaiting verification');
    expect([...chips]).toContain('For sale');
    const window = firstAt !== null && secondAt !== null ? secondAt - firstAt : 0;
    if (window > 7000) {
      expect([...chips], 'intermediate "Verifying" chip').toContain('Verifying');
      expect([...lines].some((l) => l.startsWith(`executed 1/${cur!.quorum} passed · integrity 0 · 1 result(s)`)), `saw 1/2 line (lines: ${[...lines].join(' | ')})`).toBe(true);
      expect(spinnerSeen, 'spinner while verifying').toBe(true);
    } else note(`both attestations landed within ${window} ms — the intermediate Verifying state was not observable in the 5 s UI poll`);
    await expect(line).toHaveText(new RegExp(`^executed 2/${cur!.quorum} passed · integrity 0 · 2 result\\(s\\)`));
    await expect(kv(page, 'Verified on')).toHaveText(/^[A-Z][a-z]{2}\. \d{2} \d{4}, \d{2}:\d{2}:\d{2} [+-]\d{2}:\d{2}$/);
    const gw = page.locator('a', { hasText: `${NODE_A}/x402/patch/${id}` });
    await expect(gw).toHaveAttribute('href', `${NODE_A}/x402/patch/${id}`);
    expect(await gw.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('auto');
    expect((await request.get(`${NODE_A}/x402/patch/${id}`)).status()).toBe(402);

    const table = page.getByRole('table').first();
    for (const v of ['node-b', 'node-c']) {
      const row = table.getByRole('row').filter({ hasText: v });
      const cells = row.getByRole('cell');
      await expect(cells.nth(1)).toHaveText('PASS');
      expect(await color(cells.nth(1))).toBe(GREEN);
      await expect(cells.nth(3)).toHaveText(`executed (vllm:${MODEL})`);
      // the old column reported a "Deposit" nothing escrowed; it says whether the result counted now (item 127/146)
      await expect(cells.nth(5)).toHaveText('independent');
    }
    await expect(page.getByText('Published knowledge is fixed on the public record — these fields can no longer change.', { exact: true })).toBeVisible();
    for (const f of [page.getByLabel('Description', { exact: true }), page.getByLabel('Price (AIN)'), page.getByLabel('Billing'), page.getByLabel('Knowledge track'), page.getByLabel('License')]) await expect(f).toBeDisabled();
    await expect(page.locator('strong', { hasText: 'Before you publish' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Publish to the network$/ })).toHaveCount(0);
  });

  test('AZ-032 Load knowledge into the model and unload it from the manage page', async ({ page, request }) => {
    test.setTimeout(25 * 60_000);
    const token = await operatorToken(request);
    const info = await nodeInfo(request);
    expect(await waitForRuntime(request), 'node-a runtime available').toBe(true);
    await waitForLockFree(request);
    const rt = (await api<{ available: boolean; hook: boolean; model: string; applied: { patch_id: string }[] }>(request, '/api/runtime')).body;
    expect(rt).toMatchObject({ available: true, hook: true, model: MODEL });
    if (rt.applied.some((a) => a.patch_id === K.final)) { await api(request, `/api/patches/${K.final}/remove`, { method: 'POST', token }); note('krx-all-2761 was loaded already — unloaded via API to restore the precondition'); }

    await login(page);
    await page.goto(manageUrl(NODE_A, info.address, K.final));
    await expect(page.getByRole('heading', { name: 'Load into / unload from the model' })).toBeVisible();
    const load = page.getByRole('button', { name: /^(Load into model|Loading…)$/ });
    const unload = page.getByRole('button', { name: /^(Unload|Unloading…)$/ });
    const status = unload.locator('xpath=following-sibling::span[1]');
    await expect(load).toBeEnabled();
    await expect(unload).toBeDisabled();
    await expect(status).toHaveText(`not loaded · ${MODEL}`);
    const tryLinks = page.getByRole('link', { name: 'Check it in a live test →' });
    await expect(tryLinks).toHaveCount(2);
    for (let i = 0; i < 2; i++) await expect(tryLinks.nth(i)).toHaveAttribute('href', '/chat/krx-all-2761');

    const applyP = page.waitForResponse((r) => r.url().endsWith(`/api/patches/${K.final}/apply`), { timeout: 15 * 60_000 });
    await load.click();
    await expect(load).toHaveText('Loading…');
    const applyRes = await applyP;
    expect(applyRes.status(), await applyRes.text()).toBe(200);
    const loaded = page.getByText('Loaded into the model.', { exact: true });
    await expect(loaded).toBeVisible();
    expect(await bg(loaded)).toBe(ALERT_SUCCESS_BG);
    await expect(status).toHaveText(`currently loaded · ${MODEL}`);
    await expect(load).toBeDisabled();
    await expect(unload).toBeEnabled();

    await page.goto(`${NODE_A}/account`);
    await expect(kv(page, 'Knowledge loaded now')).toHaveText(/krx-all-2761 \(manual, \d+(s|m|h) ago\)/);
    const rt2 = (await api<{ applied: { patch_id: string }[] }>(request, '/api/runtime')).body;
    expect(rt2.applied.map((a) => a.patch_id)).toContain(K.final);

    await page.goto(manageUrl(NODE_A, info.address, K.final));
    await expect(unload).toBeEnabled();
    const removeP = page.waitForResponse((r) => r.url().endsWith(`/api/patches/${K.final}/remove`), { timeout: 15 * 60_000 });
    await unload.click();
    await expect(unload).toHaveText('Unloading…');
    const removeRes = await removeP;
    expect(removeRes.status(), await removeRes.text()).toBe(200);
    await expect(page.getByText('Unloaded — original values restored.', { exact: true })).toBeVisible();
    await expect(status).toHaveText(`not loaded · ${MODEL}`);
    await expect(load).toBeEnabled();
    await expect(unload).toBeDisabled();
  });

  test('AZ-034 Buy verified knowledge with the node\'s wallet from the Buy tab and load it from Purchased knowledge', async ({ page, request, browser }) => {
    test.setTimeout(25 * 60_000);
    const tokenA = await operatorToken(request, NODE_A);
    const infoA = await nodeInfo(request);
    // cheapest knowledge (pixelplus-087600, 0.1 AIN) instead of the 25 AIN item — same flow, real AIN on the local chain
    const pid = K.pixel;
    let buyer = NODE_B;
    if ((await patchDetail(request, pid, await operatorToken(request, NODE_B), NODE_B))?.purchased && !(await patchDetail(request, pid, await operatorToken(request, NODE_C), NODE_C))?.purchased) buyer = NODE_C;
    const tokenB = await operatorToken(request, buyer);
    const buyerInfo = await nodeInfo(request, buyer);
    expect(await waitForRuntime(request, buyer), `${buyerInfo.name} runtime`).toBe(true);
    const before = (await patchDetail(request, pid, tokenB, buyer))!;
    expect(before.quorum_ok).toBe(true);
    const sellerBefore = (await patchDetail(request, pid, tokenA, NODE_A))!;
    const chain0 = (await api<{ balance: number }>(request, '/api/chain', { node: buyer })).body;
    expect(chain0.balance).toBeGreaterThan(Number(before.anchor.price));
    const priceText = fmtMoney(before.anchor.price);
    const sha = before.anchor.patch_sha256;
    note(`buyer ${buyerInfo.name} (${buyer}), knowledge ${pid} at ${priceText}, already purchased before: ${before.purchased}`);

    await login(page, buyer);
    await page.goto(`${buyer}/${infoA.address}/${pid}`);
    await page.getByRole('tab', { name: 'Buy' }).click();
    const section = page.getByRole('heading', { name: 'Buy from this node' }).locator('xpath=..');
    const buyBtn = section.getByRole('button', { name: /^(Buy · .+|Buy again|Paying…)$/ });
    await expect(buyBtn).toHaveText(before.purchased ? 'Buy again' : `Buy · ${priceText}`);
    await expect(section).toContainText('Pays from this node’s AIN wallet and stores the file on this node. · AIN = AI Network token (this demo runs a local dev chain)');
    await expect(section).not.toContainText('Sign in as this node’s operator');

    await waitForLockFree(request, buyer);
    const reqP = page.waitForRequest((r) => r.url().endsWith(`/api/patches/${pid}/buy`) && r.method() === 'POST');
    const resP = page.waitForResponse((r) => r.url().endsWith(`/api/patches/${pid}/buy`), { timeout: 5 * 60_000 });
    await buyBtn.click();
    await expect(buyBtn).toHaveText('Paying…');
    const buyReq = await reqP;
    expect(!!(buyReq.postDataJSON() as { apply?: boolean } | null)?.apply, 'web flow does not ask for apply').toBe(false);
    const buyRes = await resP;
    expect(buyRes.status(), await buyRes.text()).toBe(200);
    type Result = { patch_id: string; steps: { step: string; detail: string }[]; path: string; tx_hash: string; amount: string; scheme: string; manifest: { patch_sha256: string; blob_urls: string[] } };
    const result = (await buyRes.json()) as Result;
    expect(result.scheme).toBe('ain-transfer');

    const done = section.getByText(new RegExp(`^Purchased ${esc(pid)} · ${esc(priceText)} · tx 0x[0-9a-f]+… \\(ain-transfer\\)$`));
    await expect(done).toBeVisible();
    expect(await bg(done)).toBe(ALERT_SUCCESS_BG);
    const steps = section.locator('li');
    const labels = await steps.locator('.step').allTextContents();
    expect(labels.slice(0, 5)).toEqual(['verification confirmed', 'price quoted', 'paid', 'settlement recorded', 'downloaded & verified']);
    await expect(steps.nth(0)).toContainText(`${before.passed} attestation(s) ≥ quorum ${before.quorum}`);
    await expect(steps.nth(1)).toContainText(`Payment Required: ${before.anchor.price} AIN → ${infoA.address.slice(0, 10)}… (ain-transfer)`);
    await expect(steps.nth(2)).toContainText(/AIN transfer tx 0x[0-9a-f]+…/);
    await expect(steps.nth(3)).toContainText(/seller confirmed; manifest sha256 [0-9a-f]+…/);
    await expect(steps.nth(4)).toContainText(before.has_body ? 'body already present; sha256 matches on-ledger anchor' : /MB from .*; sha256 matches on-ledger anchor/);
    expect(result.steps.map((s) => s.step), 'on-chain access receipt step').toContain('receipt');
    expect(labels[5], 'the receipt step is labelled as the on-chain access receipt (was "manifest received")').toBe('access receipt recorded on the ledger');
    await expect(steps.nth(5)).toContainText(/on-chain access receipt written \(\/apps\/knowledge\/access\/…, tx 0x[0-9a-f]{10}…\)/);
    await expect(kv(page, 'Saved to')).toContainText(`/${buyerInfo.name}/data/blobs/${sha}`);
    await expect(kv(page, 'Content hash')).toHaveText(sha);
    await expect(kv(page, 'Download URLs')).toContainText(`${NODE_A}/p2p/blob/${sha}`);

    await page.reload();
    await page.getByRole('tab', { name: 'Buy' }).click();
    await expect(section.getByText('Already purchased. The file is stored on this node.', { exact: true })).toBeVisible();
    await expect(section.getByRole('button', { name: 'Buy again' })).toBeVisible();
    const chain1 = (await api<{ balance: number }>(request, '/api/chain', { node: buyer })).body;
    expect(chain0.balance - chain1.balance).toBeCloseTo(Number(before.anchor.price), 4);
    const sellerAfter = (await patchDetail(request, pid, tokenA, NODE_A))!;
    expect(sellerAfter.downloads).toBe(sellerBefore.downloads + 1);
    expect(Number(sellerAfter.revenue)).toBeCloseTo(Number(sellerBefore.revenue) + Number(before.anchor.price), 6);
    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();
    await login(pageA, NODE_A);
    await pageA.goto(`${NODE_A}/dashboard`);
    const sellerRow = pageA.getByRole('table').first().getByRole('row').filter({ hasText: `${pid} ·` });
    await expect(sellerRow.getByRole('cell').nth(3)).toHaveText(`${fmtNum(sellerAfter.downloads)} · ${fmtMoney(sellerAfter.revenue)}`);
    await ctxA.close();

    expect(await waitForRuntime(request, buyer), 'buyer runtime available').toBe(true);   // load/unload buttons are disabled while the model server is down
    await page.goto(`${buyer}/dashboard`);
    await expect(page.getByRole('heading', { name: 'Purchased knowledge' })).toBeVisible();
    await expect(page.getByText('Knowledge this node bought with automatic payment. Files are kept on this node; one click loads them into the model or takes them out.', { exact: true })).toBeVisible();
    const ptable = page.getByRole('table').nth(1);
    await expect(ptable.locator('thead th')).toHaveText(['Knowledge', 'Paid', 'Payment record', 'Downloaded file', 'In model', 'Load / unload', 'Live test']);
    const row = ptable.getByRole('row').filter({ hasText: pid });
    const cells = row.getByRole('cell');
    await expect(cells.nth(0).getByRole('link', { name: before.anchor.name, exact: true })).toHaveAttribute('href', `/${infoA.address}/${pid}`);
    await expect(cells.nth(0)).toContainText(pid);
    await expect(cells.nth(1)).toHaveText(`${priceText} (wallet (AIN))`);
    await expect(cells.nth(2)).toHaveText(shortHash(result.tx_hash, 12));
    await expect(cells.nth(3)).toHaveText(`…/${sha.slice(0, 18)}`);
    await expect(cells.nth(4)).toHaveText('no');
    await expect(row.getByRole('link', { name: 'Live test' })).toHaveAttribute('href', `/chat/${pid}`);
    const load = row.getByRole('button', { name: 'Load into model' });
    const unload = row.getByRole('button', { name: 'Unload' });
    await expect(load).toBeEnabled();
    await expect(unload).toBeDisabled();
    await waitForLockFree(request, buyer);
    const applyP = page.waitForResponse((r) => r.url().endsWith(`/api/patches/${pid}/apply`), { timeout: 10 * 60_000 });
    await load.click();
    const applyRes = await applyP;
    expect(applyRes.status(), await applyRes.text()).toBe(200);
    await expect(cells.nth(4)).toHaveText('yes');
    expect(await color(cells.nth(4).locator('span'))).toBe(GREEN);
    await expect(load).toBeDisabled();
    await expect(unload).toBeEnabled();
    const removeP = page.waitForResponse((r) => r.url().endsWith(`/api/patches/${pid}/remove`), { timeout: 10 * 60_000 });
    await unload.click();
    expect((await removeP).status()).toBe(200);
    await expect(cells.nth(4)).toHaveText('no');
  });

  test('AZ-041 Try Verify now on your own knowledge and be told why you cannot', async ({ page, request }) => {
    test.setTimeout(5 * 60_000);
    const token = await operatorToken(request);
    const info = await nodeInfo(request);
    expect(info.roles).toContain('verifier');
    // Critique 2 item 146: this page used to offer a one-click "Verify now (this node)" on the operator's OWN
    // knowledge, `POST /api/patches/:id/verify` had no author check, and deriveCatalog counted the result — the
    // seller could mint their own badge (and print `3/2`). The button is gone, the write is refused, and a
    // self-attestation that reached the ledger another way is excluded from the count.
    const id = readState().publishedId ?? readState().draftId ?? 'pixelplus-test-1';
    const before = await patchDetail(request, id, token);
    if (!before || before.status === 'DRAFT') throw new Error(`precondition: ${id} must be published and verified by node-b/node-c first (AZ-031) — status ${before?.status ?? 'missing'}`);
    expect(before.anchor.author, 'the knowledge under test is node-a\'s own').toBe(info.address);
    expect(before.self_checks, 'no self-check counted before').toBe(0);

    await login(page);
    await page.goto(manageUrl(NODE_A, info.address, id));
    await expect(page.getByRole('button', { name: /^Verify now/ })).toHaveCount(0);
    await expect(page.getByTestId('self-verify-note')).toHaveText('You cannot verify your own knowledge. Verified means other nodes ran it on a real model — an attestation by this node would not count.');

    // the same refusal on the API `ainize patch verify` calls — before any GPU work
    const res = await request.post(`${NODE_A}/api/patches/${encodeURIComponent(id)}/verify`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status()).toBe(409);
    expect(((await res.json()) as { error: string }).error)
      .toBe(`cannot verify your own knowledge: ${id} was published by this node (verifier.allowSelfAttest is false). A self-check never counts toward the quorum — another node has to verify it.`);

    // nothing was written, and the page still reports the honest count
    const after = (await patchDetail(request, id, token))!;
    expect(after.attestations.length).toBe(before.attestations.length);
    expect(after.passed).toBe(before.passed);
    expect(after.self_checks).toBe(0);
    await page.reload();
    await expect(kv(page, 'Verification')).toHaveText(new RegExp(`^executed ${Math.min(after.passed, after.quorum)}/${after.quorum} passed · integrity ${after.integrity_checks} · ${after.attestations.length} result\\(s\\)`));
    const table = page.getByRole('table').first();
    for (const at of after.attestations) {
      const row = table.getByRole('row').filter({ hasText: at.verifier_name ?? at.verifier.slice(0, 6) });
      await expect(row.getByRole('cell').nth(5)).toHaveText('independent');
    }
    await expect(page.getByRole('columnheader', { name: 'Deposit' })).toHaveCount(0);
    await expect(page.getByRole('columnheader', { name: 'Counts' })).toBeVisible();
  });

  test('AZ-050 Check the model runtime card and ask the model directly', async ({ page, request }) => {
    test.setTimeout(20 * 60_000);
    expect(await waitForRuntime(request), 'node-a runtime').toBe(true);
    const rt = (await api<{ available: boolean; api: string; model: string; hook: boolean; applied: { patch_id: string; reason: string }[] }>(request, '/api/runtime')).body;
    expect(rt).toMatchObject({ available: true, api: VLLM, model: MODEL, hook: true });

    await login(page);
    await page.goto(`${NODE_A}/account`);
    await expect(page.getByRole('heading', { name: 'Model runtime' })).toBeVisible();
    await expect(page.getByText('The real model this node can load knowledge into and out of. Verification scoring and live tests use it too.', { exact: true })).toBeVisible();
    await expect(kv(page, 'Status')).toHaveText('available');
    expect(await color(kv(page, 'Status'))).toBe(GREEN);
    await expect(kv(page, 'Model server')).toHaveText(VLLM);
    await expect(kv(page, 'Model')).toHaveText(MODEL);
    await expect(kv(page, 'Load/unload hook')).toHaveText('connected');
    if (rt.applied.length === 0) await expect(kv(page, 'Knowledge loaded now')).toHaveText('none');
    else for (const a of rt.applied) await expect(kv(page, 'Knowledge loaded now')).toContainText(new RegExp(`${esc(a.patch_id)} \\(${esc(a.reason)}, \\d+(s|m|h|d) ago\\)`));

    const sentence = page.locator('span', { hasText: /^See what the model answers right now\. To compare before\/after side by side, use Live test\.$/ });
    await expect(sentence).toBeVisible();
    await expect(sentence.getByRole('link', { name: 'Live test' })).toHaveAttribute('href', '/chat');
    const prompt = page.getByLabel('Prompt');
    await expect(prompt).toHaveValue('종목코드 픽셀플러스 ');
    const ask = page.getByRole('button', { name: /^(Ask|Generating…)$/ });
    await expect(ask).toBeEnabled();

    let text = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      await waitForLockFree(request);
      const resP = page.waitForResponse((r) => r.url().endsWith('/api/runtime/complete'), { timeout: 5 * 60_000 });
      await ask.click();
      await expect(ask).toHaveText('Generating…');
      const res = await resP;
      if (res.status() === 200) { text = ((await res.json()) as { text: string }).text; break; }
      note(`attempt ${attempt + 1}: /api/runtime/complete → ${res.status()} ${await res.text()} (model hiccup) — retrying after the runtime is back`);
      await waitForRuntime(request);
    }
    expect(typeof text).toBe('string');
    expect(text.length).toBeGreaterThan(0);
    const box = ask.locator('xpath=ancestor::div[1]/following-sibling::div[1]');
    await expect(box).toBeVisible();
    expect(await box.evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/mono|Inconsolata|Menlo|Consolas/i);
    await expect(box.locator('span').first()).toHaveText('종목코드 픽셀플러스');
    expect(await color(box.locator('span').first())).toBe('rgb(141, 141, 143)');
    expect(await box.locator('strong').textContent()).toBe(text);
    expect(await box.locator('strong').evaluate((el) => getComputedStyle(el).fontWeight)).toMatch(/^(bold|700)$/);
  });
});
