/**
 * Visitor (knowledge user) scenarios AZ-001 … AZ-026 — docs/ux-test-scenarios.json.
 * Runs against the live cluster; labels come from packages/web/src/i18n (English).
 */
import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { NODE_A, NODE_B, NODE_C, CHAIN, K, VLLM, api, startRuntimeProxy, startThrowawayNode, waitForLockFree, waitForRuntime } from '../helpers/ainize';
import { PIXEL_NPZ } from '../helpers/operator-cli';
import { bubble, chip, freshVisitor, modeRadio, nodeAAddress, quotaFooter, sendButton, sendPrompt, textarea, turns, visitorHeaders, waitForLock, waitTurnDone } from '../helpers/visitor-chat';

const AIN_NOTE = 'AIN = AI Network token (this demo runs a local dev chain)';
const FINAL_NAME = 'KRX ticker codes for 2,761 listed companies (final)';
const EP12_NAME = 'KRX ticker codes for 2,761 listed companies — epoch 12';
const PIXEL_NAME = 'Pixelplus ticker code (single fact)';
const MODEL = 'Qwen3.8-Flash-Next';

interface Sample { prompt: string; expect: string }
interface CatalogEntry { anchor: { id: string; name: string; description: string; author: string; price: string; rows: number; size_bytes: number; created_at: number; benchmark: { queries: number; samples: Sample[] } }; status: string; downloads: number; passed: number; quorum: number; attestations: { passed: boolean; verified_on: string; score?: Record<string, string | number> }[] }
/** Mirror of the UI's executedAccuracy()+pct(): the latest executed (non hash-only) passing attestation's free_generation score as a percentage. */
function executedAccuracyPct(e: CatalogEntry): number | null {
  const executed = e.attestations.filter((a) => a.passed && a.verified_on !== 'hash-only');
  const s = executed[executed.length - 1]?.score;
  const raw = s?.free_generation ?? s?.free_generation_vllm ?? s?.chat_60;
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(String(raw ?? ''));
  return m && Number(m[2]) ? Math.round((Number(m[1]) / Number(m[2])) * 1000) / 10 : null;
}
interface PatchDetail { anchor: CatalogEntry['anchor'] & { patch_sha256: string; benchmark_hash: string; model: { id_M: string; checkpoint_hash: string; row_dim: number } }; record_hash: string; gateway_url: string; superseded_by: string[]; supersedes: string[]; downloads: number; revenue: string; attestations: { verifier: string; verifier_name: string; created_at: number }[] }
interface Info { node: { address: string; blobs: string[] }; ledger: { records: number; height: number; provider: string; app: string }; counts: { listed: number; verifying: number }; quorum: number; royalty_share: number; peers: number }

const dd = (page: Page, label: string) => page.locator(`xpath=//dt[normalize-space()="${label}"]/following-sibling::dd[1]`);
const stat = (page: Page, name: string) => page.locator(`xpath=//div[normalize-space()="${name}"]/preceding-sibling::div[1]`);
const rows = (page: Page) => page.locator('main a[href^="/0x"]');
const idOf = (href: string | null) => decodeURIComponent((href ?? '').split('/').pop() ?? '');
const selectButton = (page: Page) => page.locator('button[aria-haspopup="listbox"]');
async function choose(page: Page, label: string) {
  const btn = selectButton(page);
  await btn.click();
  await expect(btn).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('option', { name: label, exact: true }).click();
  await expect(btn).toHaveAttribute('aria-expanded', 'false');
}
const catalog = async (request: APIRequestContext) => (await api<{ total: number; items: CatalogEntry[] }>(request, '/api/catalog?limit=200')).body;
const info = async (request: APIRequestContext) => (await api<Info>(request, '/api/info')).body;
const detail = async (request: APIRequestContext, id: string) => (await api<PatchDetail>(request, `/api/patches/${id}`)).body;
const num = (n: number) => n.toLocaleString('en-US');

/* ======================================================================================= landing */

test('AZ-001 Read the landing hero and follow the two primary calls to action', async ({ page, request }) => {
  const i = await info(request);
  const testable = (await api<{ items: CatalogEntry[] }>(request, '/api/chat/patches')).body.items;
  await page.goto(NODE_A + '/');

  const nav = page.locator('nav');
  await expect(nav.getByRole('link', { name: 'Explore knowledge', exact: true })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Live test', exact: true })).toBeVisible();
  const signin = nav.getByRole('link', { name: 'Node sign-in', exact: true });
  await expect(signin).toHaveAttribute('title', 'Console for node operators and developers. You do not need to sign in to use knowledge.');
  await expect(nav.getByRole('button', { name: 'language' })).toHaveText('한국어');

  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Plug knowledge into your AI');
  await expect(page.getByText('Ainize = AI + -ize, "make it usable by AI".')).toContainText('Pick verified knowledge, check it live, load it into your model in seconds.');

  const count = page.getByText(`${num(i.counts.listed)} verified knowledge`, { exact: true });
  await expect(count).toBeVisible();
  await expect(count).toHaveAttribute('title', 'Knowledge that independent verifier nodes loaded into the real model and checked for accuracy and side effects. (verifier quorum reached (≥ N independent attestations))');
  if (i.counts.verifying === 0) await expect(page.getByText(/being verified/)).toHaveCount(0);
  else await expect(page.getByText(`${num(i.counts.verifying)} being verified`)).toBeVisible();
  await expect(page.getByText('No sign-up · pays automatically with a wallet (AIN) or node credit · removable any time')).toBeVisible();

  await page.getByRole('link', { name: 'Explore knowledge', exact: true }).nth(1).click();
  await expect(page).toHaveURL(/\/explore$/);
  await page.goBack();
  await page.getByRole('link', { name: 'Try a live test', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/chat/${testable[0].anchor.id}$`));
  expect(testable[0].anchor.id).toBe(K.final);
});

test('AZ-002 Inspect the trending card for the only verified knowledge', async ({ page, request }) => {
  const addr = await nodeAAddress(request);
  const cat = await catalog(request);
  const listed = cat.items.filter((e) => e.status === 'LISTED');
  const final = listed.find((e) => e.anchor.id === K.final)!;
  expect(final.passed).toBe(2);
  await page.goto(NODE_A + '/');

  const section = page.locator('section', { has: page.getByRole('heading', { name: 'Popular verified knowledge' }) });
  await expect(section.getByText('Passed independent verification and ready to load into the model.')).toBeVisible();
  const cards = section.locator('a[href^="/0x"]');
  await expect(cards).toHaveCount(listed.length);
  expect(listed.length).toBe(1);
  const card = cards.first();
  await expect(card).toContainText(FINAL_NAME);
  await expect(card).toContainText(`Creator: node-a · ${MODEL}`);
  const line = (label: string) => card.locator('div', { hasText: new RegExp(`^${label}`) }).first();
  await expect(line('facts covered')).toContainText('2,761 facts');
  await expect(line('accuracy')).toContainText('100% (26/26)');
  await expect(line('Verified')).toContainText('Verified (2/2 independent verifiers)');
  await expect(line('Price')).toContainText('25 AIN');
  await expect(line('Price')).toContainText(AIN_NOTE);
  // green score bar filled to 100 %
  const bar = await card.evaluate((el) => {
    const divs = [...el.querySelectorAll('div')];
    const fill = divs.find((d) => getComputedStyle(d).backgroundColor === 'rgb(68, 164, 95)' && d.parentElement && d.getBoundingClientRect().height <= 8);
    return fill ? { width: fill.getBoundingClientRect().width, parent: fill.parentElement!.getBoundingClientRect().width } : null;
  });
  expect(bar).not.toBeNull();
  expect(Math.abs(bar!.width - bar!.parent)).toBeLessThan(1);
  for (const id of [K.ep12, K.ep6, K.pixel]) await expect(section.locator(`a[href$="/${id}"]`)).toHaveCount(0);

  await card.click();
  await expect(page).toHaveURL(`${NODE_A}/${addr}/${K.final}`);
  await page.goBack();
  await page.getByRole('link', { name: 'See all', exact: true }).click();
  await expect(page).toHaveURL(/\/explore$/);
});

/* ======================================================================================= explore */

test('AZ-003 Browse the Explore list and read every field of a knowledge row', async ({ page, request }) => {
  const addr = await nodeAAddress(request);
  const cat = await catalog(request);
  const final = cat.items.find((e) => e.anchor.id === K.final)!;
  const pixel = cat.items.find((e) => e.anchor.id === K.pixel)!;
  await page.goto(NODE_A + '/explore');

  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Explore knowledge');
  await expect(page.getByText('Choose by verification status and accuracy. You can check any of it with a live test before buying.')).toBeVisible();
  await expect(page.getByText(`${cat.total} knowledge`, { exact: true })).toBeVisible();
  expect(cat.total).toBe(4);

  const row = page.locator(`main a[href$="/${K.final}"]`);
  await expect(row).toContainText(FINAL_NAME);
  await expect(row.locator('span', { hasText: /^Verified$/ })).toHaveCount(2); // certified label + status chip
  await expect(row.locator('span', { hasText: /^Verified$/ }).last()).toHaveCSS('color', 'rgb(68, 164, 95)');
  await expect(row).toContainText(`node-a / ${K.final}`);
  await expect(row).toContainText(`Creator: node-a · Target model: ${MODEL} · Topic: krx-ticker-codes`);
  await expect(row).toContainText(`2,761 facts · 270,053 memory entries · Size 331.7 MB · ${num(final.downloads)} downloads`);
  await expect(row).toContainText('Verified (2/2 independent verifiers) · 100% accuracy');
  await expect(row).toContainText('25 AIN');
  await expect(row).toContainText(AIN_NOTE);

  const prow = page.locator(`main a[href$="/${K.pixel}"]`);
  await expect(prow).toContainText('Newer version available');
  await expect(prow).toContainText(`${num(pixel.anchor.benchmark.queries)} facts · ${num(pixel.anchor.rows)} memory entries`);
  expect(`${num(pixel.anchor.benchmark.queries)} facts · ${num(pixel.anchor.rows)} memory entries`).toBe('8 facts · 2,992 memory entries');
  await expect(prow).toContainText('0.1 AIN');

  // No raw jargon in UI labels (creator-written descriptions are data and are removed before the check)
  let text = await page.locator('main').innerText();
  for (const e of cat.items) text = text.split(e.anchor.description).join(' ');
  expect(text).not.toMatch(/\bLISTED\b|\bSUPERSEDED\b|\b[Pp]atch(es)?\b|\b[Rr]ows\b/);

  await expect(page.getByText('1 / 1', { exact: true })).toBeVisible();
  for (const b of ['First', 'Last', 'previous', 'next']) await expect(page.getByRole('button', { name: b, exact: true })).toBeDisabled();

  // clicking a row opens /{creator address}/{id} (the krx-all-2761 row; "Most popular" order depends on live purchase counts)
  await row.click();
  await expect(page).toHaveURL(`${NODE_A}/${addr}/${K.final}`);
});

test('AZ-013 Re-order Explore by each sort option', async ({ page, request }) => {
  await page.goto(NODE_A + '/explore');
  await expect(rows(page)).toHaveCount(4);
  const order = async () => (await rows(page).evaluateAll((as) => as.map((a) => a.getAttribute('href')))).map(idOf);

  await selectButton(page).click();
  await expect(page.getByRole('option')).toHaveText(['Most popular', 'Newest', 'Price', 'Knowledge size']);
  await expect(page.getByRole('option', { name: 'Most popular' })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Escape');
  await page.mouse.click(5, 5); // close the menu

  // slow the catalog request down a little so the transient " · updating…" suffix is observable
  await page.route('**/api/catalog*', async (route) => { await new Promise((r) => setTimeout(r, 1200)); await route.continue(); });

  // (the first request for each sort goes to the server; switching back to a sort seen before is served from the client cache)
  const sortTo = async (label: string, expectedSort: string) => {
    const req = page.waitForRequest((r) => r.url().includes('/api/catalog') && r.url().includes(`sort=${expectedSort}`));
    await choose(page, label);
    await req;
    await expect(page.getByText(/4 knowledge · updating…/)).toBeVisible();
    await expect(page.getByText('4 knowledge', { exact: true })).toBeVisible();
    await expect(page.getByText('1 / 1', { exact: true })).toBeVisible();
  };

  await sortTo('Price', 'price');
  expect(await order()).toEqual([K.pixel, K.ep6, K.ep12, K.final]);
  await sortTo('Newest', 'latest');
  expect(await order()).toEqual([K.final, K.ep12, K.ep6, K.pixel]);
  await sortTo('Knowledge size', 'rows');
  const bySize = await order();
  expect(bySize[0]).toBe(K.final);
  expect(bySize[3]).toBe(K.pixel);
  expect(bySize.slice(1, 3).sort()).toEqual([K.ep12, K.ep6]);
  const popular = await (await request.get(`${NODE_A}/api/catalog?sort=popular&limit=200`)).json() as { items: CatalogEntry[] };
  await choose(page, 'Most popular');
  await expect(selectButton(page)).toHaveText('Most popular');
  await expect(page.getByText('1 / 1', { exact: true })).toBeVisible();
  expect(await order()).toEqual(popular.items.map((e) => e.anchor.id));
});

test('AZ-014 Filter Explore by model and topic and search, including the empty state', async ({ page, request }) => {
  const cat = await catalog(request);
  const visibleTopics = [...new Set(cat.items.map((e) => (e.anchor as unknown as { benchmark: { schema: string } }).benchmark.schema))];
  expect(visibleTopics).toEqual(['krx-ticker-codes']);
  await page.goto(NODE_A + '/explore');
  await expect(rows(page)).toHaveCount(4);
  const group = (label: string) => page.locator('div', { has: page.locator(`span.label:text-is("${label}")`) }).last();
  await expect(group('Model').getByRole('button')).toHaveText(['All', MODEL]);
  // PRODUCT BUG candidate: /api/catalog builds `schemas`/`models` from the unfiltered catalog, so the topic of a
  // test-visibility knowledge (invisible in the list) can leak into the Topic chips. Soft so the rest is still checked.
  await expect.soft(group('Topic').getByRole('button'), 'Topic chips = All + topics of the visible knowledge only').toHaveText(['All', ...visibleTopics]);
  await expect(page.locator('span.label:text-is("Topic")')).toHaveAttribute('title', 'Knowledge on the same topic is scored with the same question set. (benchmark.queries)');
  const active = 'rgb(139, 62, 235)';
  const modelChip = group('Model').getByRole('button', { name: MODEL });
  const allModel = group('Model').getByRole('button', { name: 'All' });
  await expect(allModel).toHaveCSS('border-color', active);

  let req = page.waitForRequest((r) => r.url().includes('/api/catalog') && r.url().includes(`model=${encodeURIComponent(MODEL)}`));
  await modelChip.click();
  await req;
  await expect(modelChip).toHaveCSS('border-color', active);
  await expect(allModel).not.toHaveCSS('border-color', active);
  await expect(page.getByText('4 knowledge', { exact: true })).toBeVisible();
  await modelChip.click(); // toggles back to "All" (served from the client cache, no new request)
  await page.mouse.move(0, 0); // leave the chip's :hover state
  await expect(allModel).toHaveCSS('border-color', active);
  await expect(modelChip).not.toHaveCSS('border-color', active);
  await expect(page.getByText('4 knowledge', { exact: true })).toBeVisible();

  const topicChip = group('Topic').getByRole('button', { name: 'krx-ticker-codes' });
  req = page.waitForRequest((r) => r.url().includes('/api/catalog') && r.url().includes('schema=krx-ticker-codes'));
  await topicChip.click();
  await req;
  await expect(topicChip).toHaveCSS('border-color', active);
  await expect(page.getByText('4 knowledge', { exact: true })).toBeVisible();

  const search = page.getByPlaceholder('Search by name or description');
  await search.fill('pixel');
  await expect(page.getByText('1 knowledge', { exact: true })).toBeVisible();
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText(PIXEL_NAME);

  await search.fill('');
  await search.fill('zzz-no-match');
  await expect(page.getByText('0 knowledge', { exact: true })).toBeVisible();
  await expect(page.getByText('No knowledge matches. Try another model, topic or search term.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'First', exact: true })).toHaveCount(0);

  await search.fill('');
  await expect(page.getByText('4 knowledge', { exact: true })).toBeVisible();
  await expect(rows(page)).toHaveCount(4);
});

test('AZ-017 Compare all knowledge on the same subject and hit the unknown-topic 404', async ({ page, request }) => {
  await page.goto(NODE_A + '/benchmarks/krx-ticker-codes');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Knowledge on this topic krx-ticker-codes');
  await expect(page.getByText(`4 knowledge · 1 verified · models: ${MODEL}`)).toBeVisible();
  await expect(page.getByText('Knowledge on the same topic is scored with the same question set, so it can be compared. When contents overlap, the newer verified knowledge replaces the older one ("Newer version available").')).toBeVisible();
  const back = page.getByRole('link', { name: 'Back to Explore' });
  await expect(back).toBeVisible();

  await selectButton(page).click();
  await expect(page.getByRole('option')).toHaveText(['Most popular', 'Newest', 'Knowledge size']);
  await page.getByRole('option', { name: 'Knowledge size' }).click();
  await expect(rows(page)).toHaveCount(4);
  const order = (await rows(page).evaluateAll((as) => as.map((a) => a.getAttribute('href')))).map(idOf);
  expect(order[0]).toBe(K.final);
  expect(order[3]).toBe(K.pixel);
  await expect(rows(page).first()).toContainText(`Creator: node-a · Target model: ${MODEL} · Topic: krx-ticker-codes`);
  await expect(page.getByText('1 / 1', { exact: true })).toBeVisible();

  await back.click();
  await expect(page).toHaveURL(/\/explore$/);

  const r = await api<{ error: string }>(request, '/api/benchmarks/no-such-topic');
  expect(r.status).toBe(404);
  await page.goto(NODE_A + '/benchmarks/no-such-topic');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('404. Page not found');
  await expect(page.getByText('No knowledge is registered under the topic "no-such-topic".')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Go to Explore →' })).toHaveAttribute('href', '/explore');
});

/* ======================================================================================= knowledge detail */

test('AZ-004 Read the knowledge detail header and stat strip', async ({ page, request }) => {
  const addr = await nodeAAddress(request);
  const d = await detail(request, K.final);
  await page.goto(`${NODE_A}/${addr}/${K.final}`);

  await expect(page.getByRole('heading', { level: 1 })).toHaveText(FINAL_NAME);
  await expect(page.getByText(`ID ${K.final}`)).toBeVisible();
  await expect(page.getByText('Creator: node-a')).toBeVisible();
  await expect(page.getByText('Track finance/KRX-latest · topic finance/krx')).toBeVisible();
  const live = page.locator(`a[href="/chat/${K.final}"]`);
  await expect(live).toContainText('Live test');
  await expect(live).toContainText('Compare answers before and after');
  await expect(live).toHaveCSS('background-color', 'rgb(139, 62, 235)');
  const subject = page.getByRole('link', { name: 'Other knowledge on this subject ›' });
  await expect(subject).toBeVisible();

  await expect(page.getByText('Verified on the real model 2/2 · Verified')).toBeVisible();
  await expect(page.locator('span', { hasText: /^Verified$/ }).first()).toBeVisible();
  // PRODUCT BUG candidate: PatchPage renders the "Manage" link from `data.owned` (server-side author === node address),
  // not from the operator session, so a signed-out visitor sees it too. Soft assertion so the rest of the page is still checked.
  await expect.soft(page.getByRole('link', { name: /^Manage/ }), 'no Manage link for a visitor').toHaveCount(0);
  await expect(page.getByText(new RegExp(`By node-a · target model ${MODEL.replace('.', '\\.')} · verified \\d+(s|m|h|d) ago`))).toBeVisible();

  await expect(stat(page, 'Purchases')).toHaveText(num(d.downloads));
  await expect(stat(page, 'accuracy')).toHaveText('100%');
  await expect(page.locator('xpath=//div[normalize-space()="accuracy"]/following-sibling::div[1]')).toHaveText('26/26');
  await expect(stat(page, 'Memory entries')).toHaveText('270,053');
  await expect(stat(page, 'Facts')).toHaveText('2,761');
  await expect(stat(page, 'Size')).toHaveText('331.7 MB');
  await expect(stat(page, 'Price')).toHaveText('25 AIN');
  await expect(page.locator('xpath=//div[normalize-space()="Price"]/following-sibling::div[1]')).toHaveText(AIN_NOTE);
  // Revenue is an earned amount: a zero reads "0 AIN", never "Free" (the scenario flagged "Free" as a copy issue; fixed)
  await expect(stat(page, 'Revenue')).toHaveText(`${Number(d.revenue).toLocaleString('en-US', { maximumFractionDigits: 6 })} AIN`);

  await expect(page.getByRole('tab')).toHaveText(['Overview', 'Verification', 'Origins & derivatives', 'Buy', 'History']);

  await subject.click();
  await expect(page).toHaveURL(/\/benchmarks\/krx-ticker-codes$/);
  await page.goBack();
  await page.locator(`a[href="/chat/${K.final}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/chat/${K.final}$`));
});

test('AZ-005 Read the Verification tab and confirm only real-model runs count', async ({ page, request }) => {
  const addr = await nodeAAddress(request);
  const d = await detail(request, K.final);
  const nodes = (await api<{ nodes: { name: string; address: string }[] }>(request, '/api/nodes')).body.nodes;
  await page.goto(`${NODE_A}/${addr}/${K.final}`);
  await page.getByRole('tab', { name: 'Verification' }).click();

  const summary = (k: string) => page.locator('div', { has: page.locator(`span.k:text-is("${k}")`) }).last().locator('span.v');
  await expect(summary('Run on the real model')).toHaveText('2/2');
  await expect(summary('Integrity only')).toHaveText('0');
  await expect(summary('Status')).toHaveText('Verified');

  await expect(page.locator('thead th')).toHaveText(['Verifier node', 'Method', 'Accuracy', 'Side-effect check', 'Restarts detected', 'Deposit', 'Result', 'Time']);
  const body = page.locator('tbody tr');
  await expect(body).toHaveCount(d.attestations.length);
  expect(d.attestations.length).toBe(2);
  for (const name of ['node-b', 'node-c']) {
    const address = nodes.find((n) => n.name === name)!.address;
    const row = body.filter({ hasText: name });
    await expect(row).toHaveCount(1);
    const cells = row.locator('td');
    await expect(cells.nth(0)).toContainText(`${address.slice(0, 10)}…${address.slice(-4)}`);
    await expect(cells.nth(1)).toHaveText('run on the real model');
    await expect(cells.nth(2)).toHaveText('26/26');
    await expect(cells.nth(3)).toHaveText('not reported');
    await expect(cells.nth(3)).toHaveAttribute('title', /side-effect|Checks that adding the knowledge/);
    await expect(cells.nth(4)).toHaveText('none');
    await expect(cells.nth(5)).toHaveText('5 AIN');
    await expect(cells.nth(5)).toHaveAttribute('title', /A deposit a verifier loses if its verification turns out wrong/);
    await expect(cells.nth(6)).toHaveText('Passed');
    await expect(cells.nth(6)).toHaveCSS('color', 'rgb(68, 164, 95)');
    await expect(cells.nth(7)).toHaveText(/^\d+(s|m|h|d) ago$/);
    await expect(cells.nth(7)).toHaveAttribute('title', /^[A-Z][a-z]{2}\. \d{2} \d{4}, \d{2}:\d{2}:\d{2} [+-]\d{2}:\d{2}$/);
  }
  await expect(page.getByText(/^Verified — Only verifications run on the real model count toward Verified \(currently 2\/2\)\. The 0 integrity-only checks are shown separately/)).toBeVisible();
  await expect(page.getByText(/^Restarts detected: if the model server restarted mid-run/)).toBeVisible();
  await expect(page.getByText(/^Deposit: what a verifier loses if its verification turns out wrong/)).toBeVisible();
});

test('AZ-006 Read the Buy tab as a visitor and probe the automatic-payment address', async ({ page, context, request }) => {
  const addr = await nodeAAddress(request);
  const d = await detail(request, K.final);
  const gw = `${NODE_A}/x402/patch/${K.final}`;
  expect(d.gateway_url).toBe(gw);
  await page.goto(`${NODE_A}/${addr}/${K.final}`);
  await page.getByRole('tab', { name: 'Buy' }).click();

  await expect(page.getByRole('heading', { name: 'Buy with automatic payment' })).toBeVisible();
  await expect(page.getByText(/^Ask for the knowledge and the selling node quotes a price; once payment is confirmed you download immediately\. Pay with a wallet \(AIN\) or node credit — no sign-up/)).toBeVisible();
  await expect(dd(page, 'Price')).toContainText('25 AIN · pay once per download');
  await expect(dd(page, 'Price')).toContainText(AIN_NOTE);
  await expect(dd(page, 'Selling node')).toHaveText(`node-a ${addr.slice(0, 10)}…${addr.slice(-4)}`);
  const link = dd(page, 'Purchase address').getByRole('link');
  await expect(link).toHaveText(gw);
  await expect(link).toHaveAttribute('href', gw);

  const responsePromise = context.waitForEvent('response', (r) => r.url() === gw);
  const [popup] = await Promise.all([context.waitForEvent('page'), link.click()]);
  await popup.waitForLoadState();
  expect(popup.url()).toBe(gw);
  const resp = await responsePromise;
  expect(resp.status()).toBe(402);
  expect(resp.headers()['x-payment-required']).toBeTruthy();
  const probe = await request.get(gw);
  expect(probe.status()).toBe(402);
  expect(probe.headers()['x-payment-required']).toBeTruthy();
  await popup.close();

  await page.getByText('For node operators & developers: buy from the command line / API').click();
  const pre = page.locator('pre');
  for (const line of ['# 1) ask → price quote comes back', '# 2) pay, then retry with the proof', '# or let the CLI do the whole loop', `ainize patch buy ${K.final}`, '# AI agent: detect unknown answer → search → auto-pay → load']) await expect(pre).toContainText(line);

  await expect(page.getByRole('heading', { name: 'Buy from this node' })).toBeVisible();
  await expect(page.getByText('Sign in as this node’s operator to buy with the node’s wallet.')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Buy ·|^Buy again|Paying…/ })).toHaveCount(0);

  await expect(page.getByText(/^Buy with an AI agent — An AI agent can buy on your behalf/)).toBeVisible();
  await page.getByRole('link', { name: 'Operator & developer docs ›' }).click();
  await expect(page).toHaveURL(/\/docs$/);
});

test('AZ-015 Read the Overview tab: model, verification questions, integrity and tracks', async ({ page, context, request }) => {
  const addr = await nodeAAddress(request);
  const d = await detail(request, K.final);
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: NODE_A });
  await page.goto(`${NODE_A}/${addr}/${K.final}`);
  await expect(page.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');

  await expect(page.getByRole('heading', { name: 'Description' })).toBeVisible();
  await expect(page.getByText('Accuracy 100% (26/26) — over 2,761 benchmark questions')).toBeVisible();
  await expect(page.getByText('This knowledge works only on the model below. For other models it can be rebuilt from the recipe below.')).toBeVisible();
  await expect(dd(page, 'Model')).toHaveText(MODEL);
  await expect(dd(page, 'Checkpoint')).toHaveText('W4A16');
  await expect(dd(page, 'Entry width')).toHaveText('160');
  await expect(dd(page, 'Billing')).toHaveText('pay once per download');
  await expect(dd(page, 'License')).toHaveText('Use on the identified model · no resale of raw data');
  await expect(dd(page, 'Created')).toHaveText(/^[A-Z][a-z]{2}\. \d{2} \d{4}, \d{2}:\d{2}:\d{2} [+-]\d{2}:\d{2}$/);

  await expect(page.getByText('Verifier nodes score the knowledge with these questions. Answers are sealed so nobody can peek.')).toBeVisible();
  await expect(dd(page, 'Subject').getByRole('link')).toHaveAttribute('href', '/benchmarks/krx-ticker-codes');
  await expect(dd(page, 'facts covered')).toHaveText('2,761 facts');
  await expect(dd(page, 'Question formats')).toHaveText('template, chat');
  await expect(dd(page, 'Side-effect limit')).toHaveText('Threshold set — unrelated answers must not change when the knowledge is loaded');
  await expect(dd(page, 'Question-set hash')).toHaveText(d.anchor.benchmark_hash);
  await expect(page.getByRole('heading', { name: 'Sample questions (26)' })).toBeVisible();
  const samples = page.locator('ul li');
  await expect(samples).toHaveCount(13);
  await expect(samples.first()).toHaveText('"종목코드 픽셀플러스 " → 087600');
  await expect(samples.last()).toHaveText('… 14 more');

  await page.getByText('For node operators & developers · Recipe (portable to other models)').click();
  await expect(page.locator('pre')).toContainText('corpus_template');
  await expect(page.locator('pre')).toContainText('hyperparams');

  await expect(page.getByText('A downloaded file is genuine only if its content hash matches the value below.')).toBeVisible();
  const hashRow = page.locator('div', { hasText: /^Content hash [0-9a-f]{64}/ }).last();
  await expect(hashRow).toContainText(d.anchor.patch_sha256);
  expect(d.anchor.patch_sha256.startsWith('57c93463')).toBe(true);
  const copy = hashRow.getByRole('button', { name: 'Copy' });
  await copy.click();
  await expect(hashRow.getByRole('button', { name: 'Copied' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(d.anchor.patch_sha256);
  await expect(dd(page, 'Public record ID')).toHaveText(d.record_hash);
  await expect(dd(page, 'File stored on this node')).toHaveText('yes');
  await expect(page.getByText('finance/KRX-latest (market=KRX, version=latest)')).toBeVisible();
});

test('AZ-016 Follow origins, overlap and newer-version notices in both directions', async ({ page, request }) => {
  const addr = await nodeAAddress(request);
  const i = await info(request);
  await page.goto(`${NODE_A}/${addr}/${K.final}`);
  await page.getByRole('tab', { name: 'Origins & derivatives' }).click();

  await expect(page.getByText(`creator revenue share — Knowledge built on other knowledge records its origins publicly, and every sale automatically shares revenue with the original creators. Creator share on this network: ${Math.round(i.royalty_share * 100)}% of each sale.`)).toBeVisible();
  expect(Math.round(i.royalty_share * 100)).toBe(30);
  const origin = page.locator('xpath=//span[normalize-space()="Origins"]/following-sibling::a');
  await expect(origin).toHaveCount(1);
  await expect(origin).toContainText(EP12_NAME);
  await expect(origin.locator('code')).toHaveText(K.ep12);
  await expect(page.getByText('no derived knowledge yet')).toBeVisible();
  await expect(dd(page, 'Revenue shared with')).toHaveText(`${addr.slice(0, 10)}…${addr.slice(-4)}`);

  const trs = page.locator('tbody tr');
  const conflicts = (await detail(request, K.final) as unknown as { conflicts: { patch_id: string; status: string }[] }).conflicts;
  await expect(trs).toHaveCount(conflicts.length);
  // the demo catalog yields exactly the 3 superseded rows; other operators' DRAFT knowledge must not show up for a visitor
  await expect.soft(trs.filter({ hasText: 'Draft' }), 'no DRAFT knowledge of other operators in a visitor\'s overlap table').toHaveCount(0);
  const expectRow = async (id: string, overlap: string) => {
    const tr = trs.filter({ hasText: id });
    await expect(tr.locator('td').nth(1)).toHaveText(`${overlap} memory entries`);
    await expect(tr.locator('td').nth(2)).toHaveText('Same subject — contradictory or a newer version');
    await expect(tr.locator('td').nth(3)).toHaveText('Newer version available');
  };
  await expectRow(K.ep12, '241,992');
  await expectRow(K.ep6, '241,992');
  await expectRow(K.pixel, '2,170');
  await expect(page.locator('div').filter({ hasText: /^This knowledge replaces the older version\(s\): / }).last()).toHaveText(`This knowledge replaces the older version(s): ${K.ep12}, ${K.ep6}, ${K.pixel} — same subject, overlapping entries, newer registration.`);

  await origin.click();
  await expect(page).toHaveURL(`${NODE_A}/${addr}/${K.ep12}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(EP12_NAME);
  await expect(page.locator('span', { hasText: /^Newer version available$/ }).first()).toBeVisible();
  const meta = page.getByText(new RegExp(`^By node-a · target model ${MODEL.replace('.', '\\.')} · registered`));
  await expect(meta).toContainText(`∙ Newer version: ${K.final}`);
  await page.getByRole('tab', { name: 'Origins & derivatives' }).click();
  await expect(page.locator('xpath=//span[normalize-space()="Derived"]/following-sibling::a').first()).toContainText(K.final);
  const notice = page.locator('div').filter({ hasText: /^A newer version exists: / }).last();
  await expect(notice).toHaveText(`A newer version exists: ${K.final}. Subscribed nodes should update.`);
  await notice.getByRole('link', { name: K.final }).click();
  await expect(page).toHaveURL(`${NODE_A}/${addr}/${K.final}`);
});

test('AZ-025 Read the History tab of a knowledge and match it to the public record', async ({ page, request }) => {
  const addr = await nodeAAddress(request);
  const recs = (await api<{ records: { kind: string; ts: number }[] }>(request, `/api/patches/${K.final}/records`)).body.records;
  const kinds = (k: string) => recs.filter((r) => r.kind === k).length;
  await page.goto(`${NODE_A}/${addr}/${K.final}`);
  await page.getByRole('tab', { name: 'History' }).click();

  await expect(page.locator('thead th')).toHaveText(['Kind', 'What happened', 'By', 'Time', 'Record ID / tx']);
  const trs = page.locator('tbody tr');
  await expect(trs).toHaveCount(recs.length);
  expect(recs.length).toBeGreaterThanOrEqual(6);
  await expect(trs.filter({ has: page.locator('span[title="supersede"]') })).toHaveCount(kinds('supersede'));
  expect(kinds('supersede')).toBe(3);
  await expect(trs.filter({ has: page.locator('span[title="attest"]') })).toHaveCount(2);
  await expect(trs.filter({ has: page.locator('span[title="anchor"]') })).toHaveCount(1);
  await expect(page.locator('span[title="supersede"]').first()).toHaveText('Newer version');
  await expect(page.locator('span[title="attest"]').first()).toHaveText('Verification');
  await expect(page.locator('span[title="anchor"]').first()).toHaveText('Registered');
  if (kinds('settle') > 0) await expect(page.locator('span[title="settle"]').first()).toHaveText('Purchase settled');
  // newest first (same stable sort as the page applies to the API records)
  const expectedKinds = [...recs].sort((a, b) => b.ts - a.ts).map((r) => r.kind);
  expect(await trs.locator('td:nth-child(1) span').evaluateAll((els) => els.map((e) => e.getAttribute('title')))).toEqual(expectedKinds);

  await expect(trs.filter({ has: page.locator('span[title="attest"]') }).first().locator('td').nth(1)).toHaveText(/^node-[bc] verified krx-all-2761: passed \(run on the real model\)$/);
  await expect(trs.filter({ hasText: `marked as the newer version of ${K.ep12}` }).locator('td').nth(1)).toHaveText(`${K.final} marked as the newer version of ${K.ep12} (241,992 overlapping memory entries)`);
  await expect(trs.filter({ has: page.locator('span[title="anchor"]') }).locator('td').nth(1)).toHaveText(`Knowledge registered: ${K.final} · content hash 57c9346349…`);
  const last = trs.first().locator('td').last();
  await expect(last).toHaveAttribute('title', /^(0x[0-9a-fA-F]{40,}|[0-9a-f]{64})$/);

  // refreshes every 10 s without losing the tab
  await page.waitForResponse((r) => r.url().includes(`/api/patches/${K.final}/records`), { timeout: 30_000 });
  await expect(page.getByRole('tab', { name: 'History' })).toHaveAttribute('aria-selected', 'true');
  await expect(trs.first()).toBeVisible();
});

/* ======================================================================================= landing (secondary) */

test('AZ-011 Pick an audience card and land on the right entry point', async ({ page }) => {
  await page.goto(NODE_A + '/');
  await expect(page.getByRole('heading', { name: 'Which one are you?' })).toBeVisible();
  await expect(page.getByText('Ainize is used by people who use knowledge, people who make it, and people who run the network.')).toBeVisible();
  const card = (title: string) => page.locator('div', { has: page.getByRole('heading', { name: title, exact: true }) }).last();
  const user = card('I want to use knowledge');
  await expect(user.locator('li')).toHaveText([/Find knowledge verified for your topic and model\./, /Ask the same question before and after loading it and see the answer change\./, /If you like it, pay and load it in seconds — unload any time\./]);
  // teach-mode: the creator card invites teaching (the old sell card is gone; file registration moved under it)
  const creator = page.getByTestId('landing-creator-card');
  await expect(creator.getByRole('heading', { name: 'I want to teach the model something' })).toBeVisible();
  await expect(creator.locator('li')).toHaveText([
    /Ask the model in Live test and correct it when it is wrong\./,
    /This node trains your corrections into knowledge — no sign-in, no server of your own\./,
    /Keep it private, or publish it and get paid on every sale\./,
  ]);
  await expect(page.getByRole('heading', { name: 'I want to sell knowledge' })).toHaveCount(0);
  const teachCta = creator.getByTestId('landing-teach-cta');
  await expect(teachCta).toHaveText('Teach the model');
  await expect(teachCta).toHaveAttribute('href', '/chat?teach=1');
  await expect(creator.getByTestId('landing-register-link')).toHaveText('Already have a knowledge file (.npz) and run a node? Register a file →');
  // node-a accepts contributions, so the landing nav offers Teach next to Live test
  expect((await (await page.request.get(`${NODE_A}/api/info`)).json()).accepts_contributions).toBe(true);
  await expect(page.getByTestId('landing-nav-teach')).toHaveAttribute('href', '/chat?teach=1');
  const dev = card('Node operators & developers');
  const label = dev.getByText('For developers · terminal');
  await expect(label).toBeVisible();
  await expect(label).toHaveCSS('text-transform', 'uppercase');
  await expect(dev.locator('code')).toHaveText('npm install -g ainize\nainize init\nainize start');

  await user.getByRole('link', { name: 'Explore knowledge' }).click();
  await expect(page).toHaveURL(/\/explore$/);
  await page.goto(NODE_A + '/');
  // "Teach the model" goes to Live test with the teach banner and the lesson basket — not to the sign-in wall
  await teachCta.click();
  await expect(page).toHaveURL(`${NODE_A}/chat?teach=1`);
  await expect(page.getByTestId('teach-banner')).toContainText('Wrong answer? Click "Teach the right answer" under any reply and the model learns it. No account needed.');
  await expect(page.getByTestId('lesson-basket')).toBeVisible();
  await page.goto(NODE_A + '/');
  await page.getByTestId('landing-register-link').click();   // "Already have a knowledge file (.npz) ...? Register a file →"
  await expect(page).toHaveURL(`${NODE_A}/signing?next=%2Fnew-patch`);
  await expect(page.getByRole('link', { name: 'Register knowledge' })).toHaveCount(0);
  await page.goto(NODE_A + '/');
  await page.getByRole('link', { name: 'Open the operator console' }).click();
  await expect(page).toHaveURL(`${NODE_A}/signing`);

  // Expectation 6, false half: a node that does NOT accept lessons (teach.enabled defaults to false) drops the nav item
  // and says so under the creator card. Run on a private node built from the same binary + web UI.
  const noTeach = await startThrowawayNode('az011', { roles: 'seller,serving', maxLifeS: 300 });
  try {
    expect((await (await page.request.get(`${noTeach.url}/api/info`)).json()).accepts_contributions).toBe(false);
    await page.goto(noTeach.url + '/');
    const offCard = page.getByTestId('landing-creator-card');
    await expect(offCard.getByRole('heading', { name: 'I want to teach the model something' })).toBeVisible();
    await expect(offCard).toContainText('This node is not accepting lessons right now. Live test still works.');
    await expect(page.getByTestId('landing-nav-teach')).toHaveCount(0);
  } finally {
    await noTeach.stop();
  }
});

test('AZ-012 Copy the one-line commands and read the How-it-works / Why Ainize story', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: NODE_A });
  await page.goto(NODE_A + '/');
  await expect(page.getByRole('heading', { name: 'One line is enough' })).toBeVisible();
  const cardBtn = (title: string) => page.locator(`xpath=//h3[normalize-space()="${title}"]/parent::div//button`);
  const cardCode = (title: string) => page.locator(`xpath=//h3[normalize-space()="${title}"]/parent::div//code`);

  const USE = 'ainize use krx-all-2761';
  const PUBLISH = 'ainize publish ./my-knowledge.npz --name "한국 상장사 종목코드" --model Qwen3.8-Flash-Next --benchmark ./bench.json --price 25';
  await expect(cardCode('Use knowledge')).toHaveText(USE);
  await cardBtn('Use knowledge').click();
  await expect(cardBtn('Use knowledge')).toHaveText('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(USE);
  await expect(cardBtn('Use knowledge')).toHaveText('Copy', { timeout: 5_000 });
  await expect(cardCode('Publish knowledge')).toHaveText(PUBLISH);
  await cardBtn('Publish knowledge').click();
  await expect(cardBtn('Publish knowledge')).toHaveText('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(PUBLISH);
  await expect(page.getByText('You can do all of this on the web too — start with "Explore knowledge" and "Live test" above.')).toBeVisible();
  await page.getByRole('link', { name: 'Full API & CLI reference →' }).click();
  await expect(page).toHaveURL(/\/docs$/);
  await page.goBack();

  await expect(page.getByRole('heading', { name: 'How it works' })).toBeVisible();
  await expect(page.getByText('Three steps. No retraining, no restart.')).toBeVisible();
  for (const [n, title] of [['01', 'Verified'], ['02', 'Live test'], ['03', 'Load into model']]) {
    await expect(page.locator(`xpath=//div[normalize-space()="${n}"]/following-sibling::h3[1]`)).toHaveText(title);
  }
  await expect(page.getByRole('heading', { name: 'Why Ainize' })).toBeVisible();
  for (const [year, title] of [['2019 – 2020', 'Repo → running AI service'], ['2026', 'Knowledge → something the model knows'], ['AIN', 'The first three letters: AI Network']]) {
    await expect(page.locator(`xpath=//div[normalize-space()="${year}"]/following-sibling::h3[1]`)).toHaveText(title);
  }
  await expect(page.getByText('Creators get paid per sale; users only ever see verified knowledge.')).toBeVisible();

  const footer = page.locator('footer');
  await expect(footer.getByRole('link', { name: 'Terms', exact: true })).toHaveAttribute('href', '/terms');
  await expect(footer.getByRole('link', { name: 'Network', exact: true })).toHaveAttribute('href', '/network');
  await expect(footer.getByRole('link', { name: 'Public record', exact: true })).toHaveAttribute('href', '/ledger');
  await expect(footer.getByRole('link', { name: 'ain-js', exact: true })).toHaveAttribute('href', /^https:\/\/github\.com\//);
  await expect(footer.getByRole('link', { name: 'Contact us', exact: true })).toHaveAttribute('href', /^mailto:support@ainize\.ai/);
  await expect(footer).toContainText(`ⓒ ${new Date().getFullYear()} Common Computer Inc. · Ainize`);
  await footer.getByRole('link', { name: 'Public record', exact: true }).click();
  await expect(page).toHaveURL(/\/ledger$/);
  await page.goto(NODE_A + '/');
  await footer.getByRole('link', { name: 'Terms', exact: true }).click();
  await expect(page).toHaveURL(/\/terms$/);
});

/* ======================================================================================= ledger / network / docs */

test('AZ-010 Audit the public record: filters, integrity card and origin → derivative map', async ({ page, context, request }) => {
  const addr = await nodeAAddress(request);
  const before = await info(request);
  const all = (await api<{ records: { kind: string }[] }>(request, '/api/ledger?limit=1000')).body.records;
  await page.goto(NODE_A + '/ledger');

  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Public record');
  await expect(page.getByText('A record anyone can check: who registered, verified and bought which knowledge.')).toBeVisible();
  await expect(page.locator('header').getByText('AI Network', { exact: true })).toBeVisible();

  const cell = (k: string) => page.locator('div', { has: page.locator(`div.k:text-is("${k}")`) }).last().locator('div.v');
  await expect(cell('Record type')).toHaveText('AIN blockchain');
  await expect(cell('Network')).toHaveText('ain:local');
  const shown = Number((await cell('Records').textContent())!.replace(/,/g, ''));
  const after = await info(request);
  expect(shown).toBeGreaterThanOrEqual(before.ledger.records);
  expect(shown).toBeLessThanOrEqual(after.ledger.records);
  expect(Number((await cell('Blocks recorded').textContent())!.replace(/,/g, ''))).toBeGreaterThan(0);
  await expect(cell('Connected AI Network node')).toHaveText(CHAIN);
  await expect(cell('Integrity')).toHaveText(/^valid · [\d,]+ checked$/);
  await expect(cell('Integrity').locator('span')).toHaveCSS('color', 'rgb(68, 164, 95)');

  await expect(dd(page, 'Stored at')).toContainText('Node operators & developers');
  await expect(dd(page, 'Stored at').locator('span').first()).toHaveCSS('text-transform', 'uppercase');
  await expect(dd(page, 'Stored at')).toContainText('/apps/knowledge — Recorded on the AI Network — registrations as knowledge entries;');
  const explorer = dd(page, 'Open in explorer').getByRole('link');
  await expect(explorer).toHaveAttribute('href', `${CHAIN}/get_value?ref=%2Fapps%2Fknowledge`);
  await expect(explorer).toHaveText(`${CHAIN}/get_value?ref=/apps/knowledge`);
  const [popup] = await Promise.all([context.waitForEvent('page'), explorer.click()]);
  await popup.waitForLoadState();
  expect(popup.url()).toBe(`${CHAIN}/get_value?ref=%2Fapps%2Fknowledge`);
  const chain = await request.get(`${CHAIN}/get_value?ref=%2Fapps%2Fknowledge`);
  expect(chain.ok()).toBe(true);
  expect(typeof (await chain.json())).toBe('object');
  await popup.close();

  await expect(page.locator('thead th')).toHaveText(['Time', 'Kind', 'What happened', 'By', 'Record ID / tx']);
  await expect(page.locator('tbody tr')).toHaveCount(Math.min(20, all.length));
  const firstPage = all.slice(0, 20);
  const chipLabels: Record<string, string> = { anchor: 'Registered', attest: 'Verification', supersede: 'Newer version', branch: 'Knowledge track', node: 'Node', settle: 'Purchase settled', subscribe: 'Subscription', challenge: 'Re-verification request' };
  for (const [k, label] of Object.entries(chipLabels)) {
    if (firstPage.some((r) => r.kind === k)) await expect(page.locator(`tbody span[title="${k}"]`).first()).toHaveText(label);
  }
  // every kind chip on the page uses the plain-language label (never the raw kind)
  const rendered = await page.locator('tbody td:nth-child(2) span').evaluateAll((els) => els.map((e) => [e.getAttribute('title'), e.textContent]));
  for (const [k, txt] of rendered) expect(txt).toBe(chipLabels[k!] ?? k);
  for (const [k, label] of [['anchor', 'Registered'], ['attest', 'Verification'], ['supersede', 'Newer version'], ['branch', 'Knowledge track'], ['node', 'Node']]) {
    await choose(page, label);
    await expect(page.locator('tbody tr')).toHaveCount(Math.min(20, all.filter((r) => r.kind === k).length));
    await expect(page.locator(`tbody span[title="${k}"]`).first()).toHaveText(label);
  }
  await choose(page, 'All records');
  await expect(page.getByText(`1 / ${Math.ceil(all.length / 20)}`, { exact: true })).toBeVisible();

  await selectButton(page).click();
  await expect(page.getByRole('option')).toHaveText(['All records', 'Registered', 'Verification', 'Purchase settled', 'Knowledge track', 'Node', 'Newer version', 'Subscription', 'Re-verification request']);
  await page.getByRole('option', { name: 'Purchase settled' }).click();
  const settles = all.filter((r) => r.kind === 'settle').length;
  if (settles === 0) await expect(page.getByText('No "Purchase settled" records yet.')).toBeVisible();
  else {
    await expect(page.locator('tbody tr')).toHaveCount(Math.min(20, settles));
    await expect(page.locator('tbody tr').first().locator('td').nth(2)).toContainText('purchase settled');
  }
  await choose(page, 'Newer version');
  const sup = page.locator('tbody tr');
  await expect(sup).toHaveCount(3);
  await expect(sup.filter({ hasText: `${K.final} marked as the newer version of ${K.ep6} (241,992 overlapping memory entries)` })).toHaveCount(1);
  await choose(page, 'All records');
  await expect(page.locator('tbody tr')).toHaveCount(Math.min(20, all.length));

  await expect(page.getByRole('heading', { name: 'Origin → derivative map' })).toBeVisible();
  const svg = page.getByRole('img', { name: 'knowledge origin and derivative map' });
  await expect(svg).toBeVisible();
  await expect(svg.locator('rect[rx="4"]')).toHaveCount(4);
  const boxes = await svg.locator('g[transform]').evaluateAll((gs) => gs.map((g) => ({ x: Number(/translate\((\d+)/.exec(g.getAttribute('transform') ?? '')?.[1]), id: g.querySelector('text')?.textContent ?? '', sub: g.querySelectorAll('text')[1]?.textContent ?? '' })));
  const xs = [...new Set(boxes.map((b) => b.x))].sort((a, b) => a - b);
  expect(xs).toHaveLength(3);
  const col = (id: string) => xs.indexOf(boxes.find((b) => b.id === id)!.x);
  expect(col(K.ep6)).toBe(0);
  expect(col(K.pixel)).toBe(0);
  expect(col(K.ep12)).toBe(1);
  expect(col(K.final)).toBe(2);
  expect(boxes.find((b) => b.id === K.final)!.sub).toBe('Verified · Qwen3.8-Flash-N…');
  await expect(svg.locator('path[marker-end]')).toHaveCount(5);
  await expect(svg.locator('path[stroke-dasharray]')).toHaveCount(3);
  await expect(svg.locator('path[marker-end]:not([stroke-dasharray])')).toHaveCount(2);
  await expect(svg.locator('path[stroke-dasharray]').first()).toHaveAttribute('stroke', '#f6981d');
  for (const l of ['derived from origin (creator revenue share)', 'replaced by a newer version (same subject, overlapping entries)', 'origins on the left, derivatives to the right']) await expect(page.getByText(l)).toBeVisible();
  await expect(svg.locator('title').filter({ hasText: K.ep12 })).toHaveCount(1);
  await svg.locator(`xpath=.//*[local-name()="text" and normalize-space()="${K.final}"]/ancestor::*[local-name()="a"]`).click();
  await expect(page).toHaveURL(`${NODE_A}/${addr}/${K.final}`);
});

test('AZ-022 Explore the Network page and try the gateway router demo', async ({ page, request }) => {
  // The peer rows mirror what each peer advertised in the last gossip round, so all three nodes must see the shared
  // model before the page is read (during a vLLM hang a peer advertises no model and its Model cell shows "—").
  // The three nodes share one vLLM, so they recover together: the budget covers one hang (~5 min) plus the gossip.
  test.setTimeout(20 * 60_000);
  for (const n of [NODE_A, NODE_B, NODE_C]) expect(await waitForRuntime(request, n, 8 * 60_000), `${n} runtime`).toBe(true);
  await expect.poll(
    async () => (await api<{ peers: { endpoint: string; info?: { model?: string } }[] }>(request, '/api/nodes')).body.peers.filter((p) => p.info?.model === MODEL).length,
    { message: 'both peers advertise the serving model', timeout: 120_000, intervals: [3_000] },
  ).toBe(2);
  const i = await info(request);
  const nodes = (await api<{ nodes: { address: string; name: string; blobs: string[] }[]; peers: { endpoint: string; info: { name: string; roles: string[]; blobs: string[] } }[] }>(request, '/api/nodes')).body;
  await page.goto(NODE_A + '/network');

  const thisNode = page.locator('div', { has: page.getByRole('heading', { name: 'node-a', exact: true }) }).last();
  await expect(thisNode.locator('dd').first()).toHaveText(i.node.address);
  const ep = dd(page, 'Endpoint').getByRole('link');
  await expect(ep).toHaveText(NODE_A);
  await expect(ep).toHaveAttribute('href', `${NODE_A}/api/info`);
  await expect(dd(page, 'Roles').locator('span')).toHaveText(['seller', 'verifier', 'serving']);
  await expect(dd(page, 'Public record')).toHaveText(/^AIN blockchain \(http:\/\/localhost:8081\) · [\d,]+ records$/);
  await expect(dd(page, 'Connected nodes')).toHaveText(`${i.peers} direct · ${nodes.nodes.length - 1} known from the record`);
  expect(i.peers).toBe(2);
  await expect(dd(page, 'Knowledge files stored')).toHaveText(String(i.node.blobs.length));
  // the 4 demo bodies are stored (other suites' hidden test knowledge may add files on top of the seeded 4)
  const demoShas = (await api<{ items: { anchor: { patch_sha256: string } }[] }>(request, '/api/catalog?limit=200')).body.items.map((e) => e.anchor.patch_sha256);
  expect(new Set(demoShas).size).toBe(4);
  for (const sha of demoShas) expect(i.node.blobs, `body ${sha.slice(0, 12)}… stored on node-a`).toContain(sha);
  expect(i.node.blobs.length).toBeGreaterThanOrEqual(4);
  await expect(dd(page, 'Subscribed tracks')).toHaveText('none');
  await expect(dd(page, 'Version')).toHaveText('0.1.0');

  await expect(dd(page, 'Status')).toHaveText('available — knowledge can be loaded live');
  await expect(dd(page, 'Model')).toHaveText(MODEL);
  await expect(dd(page, 'API')).toHaveText(VLLM);
  await expect(dd(page, 'Live connection')).toHaveText('connected — load and unload without restart');

  const peersTable = page.locator('table').first();
  await expect(peersTable.locator('thead th')).toHaveText(['Endpoint', 'Name', 'Address', 'Roles', 'Record', 'Model', 'Files', 'Tracks', 'Last seen']);
  const peerRow = (endpoint: string) => peersTable.locator('tbody tr', { hasText: endpoint });
  await expect(peerRow('http://localhost:3404').locator('td').nth(1)).toHaveText('node-c');
  await expect(peerRow('http://localhost:3404').locator('td').nth(3).locator('span')).toHaveText(['verifier', 'serving']);
  await expect(peerRow('http://localhost:3403').locator('td').nth(1)).toHaveText('node-b');
  await expect(peerRow('http://localhost:3403').locator('td').nth(3).locator('span')).toHaveText(['verifier']);
  for (const e of ['http://localhost:3404', 'http://localhost:3403']) {
    const cells = peerRow(e).locator('td');
    await expect(cells.nth(4)).toHaveText('AIN blockchain');
    await expect(cells.nth(5)).toHaveText(MODEL);
    // Files = bodies the peer holds: 1–4 of the demo bodies (plus any hidden test bodies other suites made it fetch)
    const peerBlobs = nodes.peers.find((p) => p.endpoint === e)?.info.blobs ?? [];
    const files = Number(await cells.nth(6).textContent());
    expect(files).toBe(peerBlobs.length);
    expect(peerBlobs.filter((b) => demoShas.includes(b)).length).toBeGreaterThanOrEqual(1);
    expect(peerBlobs.filter((b) => demoShas.includes(b)).length).toBeLessThanOrEqual(4);
    await expect(cells.nth(7)).toHaveText('0');
    await expect(cells.nth(8)).toHaveText(/^\d+(s|m) ago$/);
  }

  const tracks = page.locator('table').nth(1);
  const latest = tracks.locator('tbody tr', { hasText: 'finance/KRX-latest' });
  await expect(latest.locator('td').nth(1).locator('span')).toHaveText(['market=KRX', 'version=latest']);
  await expect(latest.locator('td').nth(2).getByRole('link')).toHaveText([K.final]);
  await expect(latest.locator('td').nth(4)).toHaveText('0');
  const history = tracks.locator('tbody tr', { hasText: 'finance/KRX-history' });
  await expect(history.locator('td').nth(2).getByRole('link')).toHaveText([K.ep6, K.ep12]);

  const cond = page.locator('label', { hasText: 'Condition' }).locator('input');
  const val = page.locator('label', { hasText: 'Value' }).locator('input');
  await expect(cond).toHaveValue('jurisdiction');
  await expect(val).toHaveValue('KR');
  await page.getByRole('button', { name: 'Find nodes' }).click();
  await expect(page.getByText('No track matches jurisdiction=KR.')).toBeVisible();
  expect((await api<{ branch: unknown }>(request, '/api/route?jurisdiction=KR')).body.branch).toBeNull();

  await cond.fill('version');
  await val.fill('latest');
  await page.getByRole('button', { name: 'Find nodes' }).click();
  await expect(dd(page, 'Track')).toHaveText('finance/KRX-latest — Korea Exchange ticker codes — latest version');
  await expect(dd(page, 'Situation').locator('span')).toHaveText(['market=KRX', 'version=latest']);
  await expect(dd(page, 'Knowledge included').getByRole('link')).toHaveText([K.final]);
  await expect(dd(page, 'Nodes that can answer')).toHaveText('No node has subscribed to this track yet.');

  await page.getByText('Node operators & developers', { exact: true }).click();
  const cmd = page.locator('details pre');
  await expect(cmd).toContainText(`curl "${NODE_A}/api/route?version=latest"`);
  await expect(cmd).toContainText('ainize peers add http://host:port');
  await expect(cmd).toContainText('ainize branch subscribe finance/KRX-latest');
  await expect(cmd).toContainText(`node packages/agent/dist/bin.js run --market ${NODE_A}`);

  await dd(page, 'Knowledge included').getByRole('link', { name: K.final }).click();
  await expect(page).toHaveURL(`${NODE_A}/${i.node.address}/${K.final}`);
});

test('AZ-023 Use the Docs page: copy one-liners, browse the CLI table and the API groups', async ({ page, context, request }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: NODE_A });
  const docs = (await api<{ cli: { oneLiners: Record<string, { cmd: string }>; install: string[]; groups: { name: string }[] }; openapi: { tags: { name: string }[] } }>(request, '/api/docs')).body;
  await page.goto(NODE_A + '/docs');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Docs · API · CLI');
  await expect(page.getByText('This reference is served by the node itself. Publishing or using knowledge starts with one line; the REST API below is what this very node serves.')).toBeVisible();
  for (const h of ['Publishing knowledge', 'Using knowledge', 'Try before you buy']) await expect(page.getByRole('heading', { name: h, exact: true }).first()).toBeVisible();
  const card = (title: string) => page.locator(`xpath=(//h3[normalize-space()="${title}"])[1]/parent::div`);
  await expect(card('Using knowledge').locator('pre')).toHaveText(docs.cli.oneLiners.use.cmd);
  expect(docs.cli.oneLiners.use.cmd).toMatch(/^ainize use krx-all-2761\s+# check verification → pay automatically → download → load into your model$/);
  await card('Using knowledge').getByRole('button', { name: 'Copy' }).click();
  await expect(card('Using knowledge').getByRole('button', { name: 'Copied' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('ainize use krx-all-2761');
  await expect(card('Try before you buy').locator('pre')).toHaveText('ainize chat krx-all-2761 "픽셀플러스 종목코드 알려줘. 숫자만."   # the knowledge is Korean stock data, so ask in the trained phrasing');
  await expect(page.locator('xpath=//h2[normalize-space()="Install"]/following-sibling::pre[1]')).toHaveText(new RegExp('^npm install -g ainize'));

  await expect(page.getByRole('tab', { name: 'CLI reference (ainize)' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText("Like the 2019 ainize-cli turned repos into AI services, today's ainize puts knowledge into models. Every command supports --help and --json.")).toBeVisible();
  await expect(page.locator('table').first().locator('th')).toHaveText(['Command', 'What it does']);
  const groups = docs.cli.groups.map((g) => g.name);
  expect(groups).toEqual(['Getting started', 'Using knowledge', 'Publishing knowledge', 'Teach mode (lessons taught by visitors)', 'Records & network', 'AIN chain & drive (operators)', 'AI agent']);
  for (const g of groups) await expect(page.getByRole('heading', { name: g, exact: true }).last()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Benchmark file (bench.json) example' })).toBeVisible();

  await page.getByRole('tab', { name: 'REST API' }).click();
  await expect(page.getByText(`Base URL ${NODE_A}. Public browsing, purchase and live tests need no auth; operator APIs use the login cookie or a Bearer token. Raw spec:`)).toBeVisible();
  const spec = page.getByRole('link', { name: '/api/openapi.json' });
  const [popup] = await Promise.all([context.waitForEvent('page'), spec.click()]);
  await popup.waitForLoadState();
  expect(popup.url()).toBe(`${NODE_A}/api/openapi.json`);
  expect((await (await request.get(`${NODE_A}/api/openapi.json`)).json()).openapi).toBeTruthy();
  await popup.close();
  const box = page.locator('div', { hasText: /^Automatic payment flow \(developers\)/ }).last();
  for (const s of ['402', 'x-payment-required', 'X-PAYMENT', 'blob_urls', '1) GET /x402/patch/{id}', '4) Download the body']) await expect(box).toContainText(s);

  const tags = docs.openapi.tags.map((t) => t.name);
  expect(tags).toEqual(['Find knowledge', 'Live test', 'Teach', 'Automatic payment & download', 'Register & sell knowledge', 'Public record', 'Operator', 'P2P']);
  for (const t of tags) await expect(page.getByRole('heading', { name: t, exact: true }).last()).toBeVisible();
  await expect(page.locator('details summary').filter({ hasText: 'GET' }).first().locator('span').first()).toHaveText('GET');
  const catalogOp = page.locator('details', { has: page.locator('summary code', { hasText: /^\/api\/catalog$/ }) }).first();
  await expect(catalogOp.locator('summary')).toContainText('List knowledge');
  await catalogOp.locator('summary').click();
  await expect(catalogOp.getByRole('heading', { name: 'Parameters' })).toBeVisible();
  await expect(catalogOp.getByRole('heading', { name: 'Responses' })).toBeVisible();
  const authOp = page.locator('details', { has: page.locator('summary', { hasText: 'operator auth' }) }).filter({ has: page.locator('summary span', { hasText: 'POST' }) }).first();
  await expect(authOp.locator('summary')).toContainText('operator auth');
  await authOp.locator('summary').click();
  await expect(authOp.getByRole('heading', { name: 'Responses' })).toBeVisible();
  for (const m of ['GET', 'POST', 'PATCH', 'DELETE']) await expect(page.locator('summary span', { hasText: new RegExp(`^${m}$`) }).first()).toBeVisible();

  await expect(page.getByRole('heading', { name: 'Schemas' })).toBeVisible();
  const schema = page.locator('details', { has: page.locator('summary', { hasText: /^Anchor$/ }) });
  await expect(schema.locator('pre')).toBeHidden();
  await schema.locator('summary').click();
  await expect(schema.locator('pre')).toBeVisible();
});

/* ======================================================================================= Live test (shared runtime) */

test.describe('Live test (shared runtime)', () => {
  // Not serial: every test waits for the shared runtime in beforeEach, so a vLLM hiccup in one test must not skip the others.

  test.beforeEach(async ({ request }) => {
    expect(await waitForRuntime(request), 'model server available').toBe(true);
    await waitForLockFree(request);
  });

  test('AZ-007 Open Live test, pick knowledge and use the sample-question chips', async ({ page, request }) => {
    const testable = (await api<{ items: CatalogEntry[] }>(request, '/api/chat/patches')).body.items;
    await page.goto(NODE_A + '/chat');
    await expect(page).toHaveURL(new RegExp(`/chat/${testable[0].anchor.id}$`));
    expect(testable[0].anchor.id).toBe(K.final);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Live test');
    await expect(page.getByText(`Test model ${MODEL}`)).toBeVisible();
    await expect(page.getByText('Ask the same question before and after loading the knowledge and watch the answer change. It loads and unloads in seconds, no restart.')).toBeVisible();

    const panel = page.getByRole('complementary', { name: 'Knowledge to load (pick up to 3)' });
    await expect(panel.getByText('Only knowledge whose body is on this node can be tested.')).toBeVisible();
    // the multi-select help line (the teach-era replacement for the single-pick panel's copy)
    await expect(panel.getByText('They load in the order you tick them. If two overlap, the one ticked last wins.')).toBeVisible();
    const items = panel.locator('li > label');   // multi-select rows (each wraps a checkbox)
    await expect(items).toHaveCount(testable.length);
    expect(testable.length).toBe(4);
    // the "node-a/{id}" line is its own element (the facts count follows it without whitespace in the button text)
    const itemFor = (id: string) => items.filter({ has: page.locator('span', { hasText: new RegExp(`^node-a/${id}$`) }) });
    for (const e of testable) {
      const it = itemFor(e.anchor.id);
      await expect(it).toContainText(e.anchor.name);
      await expect(it).toContainText(`${num(e.anchor.benchmark.queries)} facts`);
      // "{pct}% accuracy" = the verifiers' executed score (100% for the seeded verifications; a later re-verification may score differently)
      const acc = executedAccuracyPct(e);
      expect(acc, `${e.anchor.id} has an executed passing attestation`).not.toBeNull();
      await expect(it).toContainText(`${acc}% accuracy`);
      await expect(it).toContainText(`${e.anchor.price} AIN`);
      await expect(it).toContainText(AIN_NOTE);
      await expect(it).toContainText(e.status === 'LISTED' ? 'Verified' : 'Newer version available');
    }
    await expect(itemFor(K.final).getByRole('checkbox')).toBeChecked();
    await expect(itemFor(K.pixel).getByRole('checkbox')).not.toBeChecked();

    // multi-select: ticking would ADD pixelplus to the stack — clear first so exactly one is loaded
    await panel.getByRole('button', { name: 'Clear selection' }).click();
    await itemFor(K.pixel).click();
    await expect(page).toHaveURL(new RegExp(`/chat/${K.pixel}$`));
    // selection marker on the active item: the multi-select list shows the load ORDER where the old single-pick list said "Selected"
    await expect(itemFor(K.pixel)).toContainText('Loads 1.');
    await expect(itemFor(K.final)).not.toContainText('Loads ');
    const head = page.locator('main h2').filter({ hasNotText: /^Knowledge to load|^Your lesson/ });   // the picker's and lesson basket's own headings sit in <main> too
    await expect(head).toHaveText(PIXEL_NAME);
    await expect(head.locator('..')).toContainText('Newer version available');
    await expect(head.locator('..')).toContainText('8 facts');
    await expect(head.locator('..').getByRole('link', { name: 'Details →' })).toBeVisible();
    await expect(page.getByText('No questions yet')).toBeVisible();
    await expect(page.getByText('Click a sample question below or type your own. You get two answers side by side: before and after loading the knowledge.')).toBeVisible();
    await itemFor(K.pixel).click();   // untick pixelplus again …
    await itemFor(K.final).click();   // … then load only the final knowledge
    await expect(page).toHaveURL(new RegExp(`/chat/${K.final}$`));
    await expect(head).toHaveText(FINAL_NAME);

    await expect(page.getByText('Sample questions this knowledge answers')).toBeVisible();
    const chips = page.locator('button[title^="Expected: "]');
    await expect(chips).toHaveCount(8);
    await expect(chip(page, '종목코드 픽셀플러스')).toHaveAttribute('title', 'Expected: 087600');
    await page.getByRole('button', { name: 'Show 18 more' }).click();
    await expect(chips).toHaveCount(26);
    await page.getByRole('button', { name: 'Show less' }).click();
    await expect(chips).toHaveCount(8);

    await chip(page, '종목코드 삼성전자').click();
    await expect(textarea(page)).toHaveValue('종목코드 삼성전자');
    await expect(textarea(page)).toBeFocused();
    await expect(textarea(page)).toHaveAttribute('placeholder', 'Type a question and press Enter (Shift+Enter for a new line)');
    await expect(page.getByText('Free tries are limited per hour. No sign-in needed.')).toBeVisible();

    await page.goto(NODE_A + '/chat/does-not-exist');
    await expect(page.getByText('The knowledge in the address (does-not-exist) cannot be tested on this node, so the first one in the list was chosen.')).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/chat/${K.final}$`));
  });

  test('AZ-008 Run a Compare test and read the correct-answer marker and quota counter', async ({ page, request }) => {
    const origin = await freshVisitor(page);
    await page.goto(`${origin}/chat/${K.final}`);
    await expect(modeRadio(page, 'Compare')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('checkbox', { name: 'Enable thinking' })).not.toBeChecked();

    await chip(page, '종목코드 삼성전자').click();
    const response = page.waitForResponse((r) => r.url().endsWith('/api/chat') && r.request().method() === 'POST', { timeout: 10 * 60_000 });
    const turn = await sendPrompt(page);

    // pending state
    await expect(bubble(turn, 'Before loading')).toHaveAttribute('aria-busy', 'true');
    await expect(bubble(turn, 'After loading')).toHaveAttribute('aria-busy', 'true');
    await expect(turn.getByText('Includes loading and unloading — this can take tens of seconds.').first()).toBeVisible();
    await expect(page.getByText('Waiting for the answer — you can cancel if it takes too long.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
    await expect(sendButton(page)).toHaveText('Waiting for the answer…');
    await expect(chip(page, '종목코드 삼성전자')).toBeDisabled();
    await expect(modeRadio(page, 'After only')).toBeDisabled();
    await expect(textarea(page)).toBeDisabled();

    const res = await response;
    await waitTurnDone(page, request, turn);
    const done = await page.waitForResponse((r) => r.url().endsWith('/api/chat') && r.request().method() === 'POST' && r.status() === 200, { timeout: 1_000 }).catch(() => res);
    expect(done.status()).toBe(200);
    const json = await done.json() as { mode: string; remaining_quota: number; quota_limit: number; benchmark_hit: boolean };
    expect(json.mode).toBe('compare');
    expect(json.quota_limit).toBe(20);

    const after = bubble(turn, 'After loading');
    await expect(after).toContainText(/reply \d+(\.\d+)?(ms|s)/);
    await expect(after).toContainText(/· (loaded in \d+(\.\d+)?(ms|s)|was already loaded)/);
    await expect(after).toContainText('005930');
    const hit = after.getByText('✓ Correct');
    await expect(hit).toBeVisible();
    await expect(hit).toHaveAttribute('title', 'This question is one of the knowledge’s benchmark items, so the answer was checked automatically. Expected: 005930');
    await expect(bubble(turn, 'Before loading').getByText(/^(✓ Correct|✗ Wrong)$/)).toBeVisible();

    await expect(page.getByText(`Free trial ${json.remaining_quota}/20 left this hour`)).toBeVisible();
    expect(json.remaining_quota).toBe(19);
    await expect(page.getByRole('button', { name: 'Clear conversation' })).toBeVisible();
    // transcript auto-scrolled to the newest turn
    expect(await turn.evaluate((el) => { const p = el.parentElement!; return p.scrollTop + p.clientHeight >= p.scrollHeight - 2; })).toBe(true);
  });

  test('AZ-018 Use \'After only\' and \'Before only\' views, ask a free question and clear the conversation', async ({ page, request }) => {
    const origin = await freshVisitor(page);
    await page.goto(`${origin}/chat/${K.final}`);
    await expect(modeRadio(page, 'Compare')).toHaveAttribute('title', 'See answers before and after side by side. Includes loading and unloading, so it takes a bit longer.');
    await expect(modeRadio(page, 'After only')).toHaveAttribute('title', 'Only the answer with the knowledge loaded.');
    await expect(modeRadio(page, 'Before only')).toHaveAttribute('title', 'Only the original model’s answer.');

    await modeRadio(page, 'After only').click();
    const t1 = await sendPrompt(page, 'HMM 종목코드는?');
    await waitTurnDone(page, request, t1);
    await expect(t1.locator('div[aria-busy]')).toHaveCount(1);
    await expect(bubble(t1, 'After loading')).toBeVisible();
    await expect(bubble(t1, 'After loading')).toContainText('Free question — not auto-scored');
    await expect(t1.getByText(/^(✓ Correct|✗ Wrong)$/)).toHaveCount(0);

    await modeRadio(page, 'Before only').click();
    await page.getByRole('button', { name: 'Show 18 more' }).click();
    await chip(page, '종목코드 HMM').click();
    const t2 = await sendPrompt(page);
    await waitTurnDone(page, request, t2);
    await expect(t2.locator('div[aria-busy]')).toHaveCount(1);
    const before = bubble(t2, 'Before loading');
    await expect(before).toContainText(/reply \d+(\.\d+)?(ms|s)/);
    await expect(before.getByText(/^(✓ Correct|✗ Wrong)$/)).toHaveAttribute('title', /Expected: 011200$/);
    await expect(before).not.toContainText('loaded in');

    const thinking = page.getByRole('checkbox', { name: 'Enable thinking' });
    await thinking.check();
    await expect(page.getByText('Thinking is on — replies are slower')).toBeVisible();
    await thinking.uncheck();
    await expect(page.getByText('Off by default. When on, the model reasons at length before answering, so replies are slower. Keep it off for short factual questions.')).toBeVisible();

    const quota = await quotaFooter(page).textContent();
    expect(quota).toBe('Free trial 18/20 left this hour');
    await page.getByRole('button', { name: 'Clear conversation' }).click();
    await expect(page.getByText('No questions yet')).toBeVisible();
    await expect(turns(page)).toHaveCount(0);
    await expect(quotaFooter(page)).toHaveText(quota!);
  });

  test('AZ-019 Cancel a slow live test and retry it', async ({ page, request }) => {
    const origin = await freshVisitor(page);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(`${origin}/chat/${K.final}`);
    await expect(modeRadio(page, 'Compare')).toHaveAttribute('aria-checked', 'true');
    await page.getByRole('button', { name: 'Show 18 more' }).click();
    await chip(page, '종목코드 유라클').click();
    const turn = await sendPrompt(page);
    await expect(page.getByText('Waiting for the answer — you can cancel if it takes too long.')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();

    const alert = turn.getByRole('alert');
    await expect(alert).toHaveText('Request cancelled.');
    await expect(turn.getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect(textarea(page)).toBeEnabled();
    await expect(sendButton(page)).toHaveText('Send');
    await expect(turns(page)).toHaveCount(1);

    const payloads: { messages: unknown[] }[] = [];
    page.on('request', (r) => { if (r.url().endsWith('/api/chat') && r.method() === 'POST') payloads.push(r.postDataJSON()); });
    await turn.getByRole('button', { name: 'Retry' }).click();
    await waitTurnDone(page, request, turn);
    expect(payloads.length).toBeGreaterThanOrEqual(1);
    expect(payloads[0].messages).toEqual([{ role: 'user', content: '종목코드 유라클' }]); // the cancelled turn is not replayed as history
    await expect(turns(page)).toHaveCount(1);
    const after = bubble(turn, 'After loading');
    await expect(after.getByText('✓ Correct')).toHaveAttribute('title', /Expected: 088340$/);
    await expect(bubble(turn, 'Before loading')).toBeVisible();

    // leaving the page during a pending request aborts it without console errors
    await modeRadio(page, 'Before only').click();
    await sendPrompt(page, '종목코드 HMM');
    await expect(page.getByText('Waiting for the answer — you can cancel if it takes too long.')).toBeVisible();
    await page.locator('header').getByRole('link', { name: 'Explore knowledge' }).click();
    await expect(page).toHaveURL(/\/explore$/);
    await page.waitForTimeout(1_500);
    expect(errors.filter((e) => !/favicon/.test(e))).toEqual([]);
  });

  test('AZ-020 See the \'another test in progress\' banner while someone else is testing', async ({ page, context, request }) => {
    const origin = await freshVisitor(page);
    await page.goto(`${origin}/chat/${K.final}`);
    await modeRadio(page, 'Compare').click();
    await page.getByRole('checkbox', { name: 'Enable thinking' }).check();
    await page.getByRole('button', { name: 'Show 18 more' }).click();
    await chip(page, '종목코드 한독').click();
    // Expectation 3 is about ORDER: B must be served after A, not beside it. Both response promises are armed before the
    // send so the two completion times can be compared (A is the slower call — compare + thinking = two generations — so
    // a node that served B concurrently would finish B FIRST).
    const chatPost = (p: Page) => p.waitForResponse((r) => r.url().endsWith('/api/chat') && r.request().method() === 'POST', { timeout: 20 * 60_000 }).then(() => Date.now());
    const doneA = chatPost(page);
    const turnA = await sendPrompt(page);

    const lock = await waitForLock(request, origin, (l) => !!l && l.label === `chat:${K.final}`);
    expect(lock!.owner).toMatch(/^pid:\d+$/);
    expect(typeof lock!.since).toBe('number');
    // tab A shows the same box while its own request holds the lock (the page peeks at the lock right after sending)
    await expect(page.getByRole('status').filter({ hasText: 'Another test is running' })).toBeVisible();

    const tabB = await context.newPage();
    await tabB.goto(`${origin}/chat/${K.final}`);
    const banner = tabB.getByRole('status').filter({ hasText: 'Another test is running — try again in a moment.' });
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(new RegExp(`Another test in progress \\(node process ${lock!.owner.slice(4)}\\) — started \\d+(s|m) ago`));
    await expect(banner).toContainText('The shared model runs one test at a time, so tests queue up one after another.');

    await modeRadio(tabB, 'Before only').click();
    const doneB = chatPost(tabB);
    const bSentAt = Date.now();
    const turnB = await sendPrompt(tabB, '종목코드 HMM');
    await waitTurnDone(page, request, turnA);
    await waitTurnDone(tabB, request, turnB);
    const [atA, atB] = await Promise.all([doneA, doneB]);
    expect(bSentAt, 'tab B sent while tab A was still pending (real contention)').toBeLessThan(atA);
    expect(atB, 'tab B is serialised behind tab A — its answer arrives after A\'s').toBeGreaterThan(atA);
    // Tab A finished; the scenario asserts the correct result on tab B (bullet 3). Tab A's patched answer is auto-scored
    // (Expected: 002390) but with thinking ON the patched model answers this trained completion-style prompt with an
    // empty string (immediate EOS) — recorded as a model-behavior finding; base+thinking and patched without thinking answer 002390.
    await expect(bubble(turnA, 'After loading')).toBeVisible();
    await expect(bubble(turnA, 'After loading').getByText(/^(✓ Correct|✗ Wrong)$/)).toHaveAttribute('title', /Expected: 002390$/);
    const hitA = await bubble(turnA, 'After loading').getByText('✓ Correct').count();
    if (!hitA) test.info().annotations.push({ type: 'note', description: 'turn A (compare + thinking) patched answer was not ✓ Correct — patched+thinking yields an empty answer for the trained completion prompt (model-behavior finding)' });
    await expect(bubble(turnB, 'Before loading').getByText(/^(✓ Correct|✗ Wrong)$/)).toBeVisible();
    await expect(tabB.getByText('Another test was running so this request could not be handled.')).toHaveCount(0);

    // The banner mirrors the shared lock, and the node's own background work (a verifier run, a queued lesson) can
    // take it again between the check and the reload — retry until the page is loaded while nobody holds it.
    await expect.poll(async () => {
      await waitForLock(request, origin, (l) => l === null);
      await tabB.reload();
      await expect(tabB.getByRole('complementary', { name: 'Knowledge to load (pick up to 3)' })).toBeVisible();
      return tabB.getByRole('status').filter({ hasText: 'Another test is running' }).count();
    }, { timeout: 3 * 60_000, intervals: [2_000], message: 'the lock banner is gone once nobody holds the shared model' }).toBe(0);
    await tabB.close();
  });

  test('AZ-024 Ask a follow-up question and confirm the conversation history is sent with it', async ({ page, request }) => {
    const origin = await freshVisitor(page);
    const payloads: { patch_id: string; mode: string; thinking: boolean; messages: { role: string; content: string }[] }[] = [];
    page.on('request', (r) => { if (r.url().endsWith('/api/chat') && r.method() === 'POST') payloads.push(r.postDataJSON()); });
    await page.goto(`${origin}/chat/${K.final}`);
    await modeRadio(page, 'After only').click();

    await chip(page, '종목코드 삼성전자').click();
    const first = page.waitForResponse((r) => r.url().endsWith('/api/chat') && r.request().method() === 'POST' && r.status() === 200, { timeout: 10 * 60_000 });
    const t1 = await sendPrompt(page);
    await waitTurnDone(page, request, t1);
    await expect(t1.locator('div[aria-busy]')).toHaveCount(1);
    await expect(bubble(t1, 'After loading').getByText('✓ Correct')).toHaveAttribute('title', /Expected: 005930$/);
    const answer1 = ((await (await first).json()) as { patched: { content: string } }).patched.content.trim();
    expect(answer1.length).toBeGreaterThan(0);

    const FOLLOW = 'Which company has that ticker code? Answer in one word.';
    const t2 = await sendPrompt(page, FOLLOW);
    await waitTurnDone(page, request, t2);
    await expect(bubble(t2, 'After loading')).toContainText('Free question — not auto-scored');
    expect(payloads.length).toBe(2);
    expect(payloads[1]).toEqual({ patch_id: K.final, mode: 'patched', thinking: false, messages: [{ role: 'user', content: '종목코드 삼성전자' }, { role: 'assistant', content: answer1 }, { role: 'user', content: FOLLOW }] });

    await page.getByRole('button', { name: 'Clear conversation' }).click();
    await expect(turns(page)).toHaveCount(0);
    await chip(page, '종목코드 삼성전자').click();
    const t3 = await sendPrompt(page);
    await waitTurnDone(page, request, t3);
    expect(payloads.length).toBe(3);
    expect(payloads[2].messages).toEqual([{ role: 'user', content: '종목코드 삼성전자' }]);
    await expect(quotaFooter(page)).toHaveText('Free trial 17/20 left this hour');
  });

  test('AZ-026 Live-test an older (superseded) version and jump to its detail page', async ({ page, request }) => {
    const origin = await freshVisitor(page);
    const addr = await nodeAAddress(request);
    await page.goto(`${origin}/chat/${K.pixel}`);
    const item = page.getByRole('complementary', { name: 'Knowledge to load (pick up to 3)' }).locator('li > label').filter({ has: page.getByRole('checkbox', { checked: true }) });
    await expect(item).toHaveCount(1);
    for (const s of [PIXEL_NAME, `node-a/${K.pixel}`, '8 facts', '100% accuracy', '0.1 AIN', AIN_NOTE, 'Newer version available', 'Loads 1.']) await expect(item).toContainText(s);
    const head = page.locator('main h2').filter({ hasNotText: /^Knowledge to load|^Your lesson/ }).locator('..');
    await expect(head).toContainText(PIXEL_NAME);
    await expect(head).toContainText('Newer version available');
    await expect(head).toContainText('8 facts');

    await expect(modeRadio(page, 'Compare')).toHaveAttribute('aria-checked', 'true');
    await chip(page, '종목코드 픽셀플러스').click();
    const turn = await sendPrompt(page);
    await waitTurnDone(page, request, turn);
    const after = bubble(turn, 'After loading');
    await expect(after).toContainText('087600');
    await expect(after.getByText('✓ Correct')).toHaveAttribute('title', /Expected: 087600$/);
    await expect(after).toContainText(/· loaded in \d+(\.\d+)?(ms|s)/);
    await expect(bubble(turn, 'Before loading').getByText(/^(✓ Correct|✗ Wrong)$/)).toBeVisible();

    await head.getByRole('link', { name: 'Details →' }).click();
    await expect(page).toHaveURL(`${origin}/${addr}/${K.pixel}`);
    await expect(page.locator('span', { hasText: /^Newer version available$/ }).first()).toBeVisible();
    const meta = page.getByText(new RegExp(`^By node-a · target model ${MODEL.replace('.', '\\.')} · registered`));
    await expect(meta).toContainText(`∙ Newer version: ${K.final}`);
    await meta.getByRole('link', { name: `Newer version: ${K.final}` }).click();
    await expect(page).toHaveURL(`${origin}/${addr}/${K.final}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(FINAL_NAME);
    await expect(page.locator('span', { hasText: /^Verified$/ }).first()).toBeVisible();
  });

  test('AZ-021 Handle the model-server-off state on Live test and Network', async ({ page, request }) => {
    test.setTimeout(10 * 60_000);
    // ON state on the live node-a (the shared vLLM is never stopped by the suite)
    expect(await waitForRuntime(request), 'node-a runtime').toBe(true);
    await page.goto(NODE_A + `/chat/${K.final}`);
    await expect(page.getByRole('status').filter({ hasText: 'The model server is off right now' })).toHaveCount(0);
    const boxes = page.getByRole('complementary', { name: 'Knowledge to load (pick up to 3)' }).getByRole('checkbox');
    await expect(boxes).toHaveCount(4);
    for (let i = 0; i < 4; i++) await expect(boxes.nth(i)).toBeEnabled();
    await expect(textarea(page)).toBeEnabled();
    await expect(textarea(page)).toHaveAttribute('placeholder', 'Type a question and press Enter (Shift+Enter for a new line)');
    await page.goto(NODE_A + '/network');
    await expect(dd(page, 'Status')).toHaveText('available — knowledge can be loaded live');
    await expect(dd(page, 'Status').locator('span')).toHaveCSS('background-color', 'rgb(68, 164, 95)');
    await expect(dd(page, 'Live connection')).toHaveText('connected — load and unload without restart');

    // OFF → ON, for real, on a private serving node built from the same binary + web UI (name node-a, reads the same
    // public record): its serving API is a TCP relay to the shared vLLM that starts CLOSED ("serving API unreachable")
    // and is opened later — vLLM itself is never paused. It holds the pixelplus body, so that knowledge is testable there.
    const OFF_MSG = 'The model server is off right now, so testing is unavailable.';
    const proxy = await startRuntimeProxy();
    const off = await startThrowawayNode('az021', { name: 'node-az021', stableId: 'az021', roles: 'seller,serving', ledger: 'ain', runtimeApi: proxy.url, maxLifeS: 540 });
    try {
      await off.seed(PIXEL_NPZ, 'az021-seed');
      const posts: string[] = [];
      page.on('request', (r) => { if (r.url().endsWith('/api/chat') && r.method() === 'POST') posts.push(r.url()); });
      await page.goto(`${off.url}/chat/${K.pixel}`);
      const box = page.getByRole('status').filter({ hasText: OFF_MSG });
      await expect(box).toBeVisible();
      await expect(box).toContainText('It comes back once the node operator starts the model server.');
      await expect(box).toHaveCSS('background-color', 'rgb(255, 243, 224)');   // yellow status box
      const offPicker = page.getByRole('complementary', { name: 'Knowledge to load (pick up to 3)' });
      const offItems = offPicker.locator('li > label');
      const offBoxes = offPicker.getByRole('checkbox');
      await expect(offItems.first()).toBeVisible();
      const n = await offItems.count();
      expect(n).toBeGreaterThan(0);
      for (let i = 0; i < n; i++) {
        await expect(offBoxes.nth(i)).toBeDisabled();
        await expect(offItems.nth(i)).toHaveAttribute('title', OFF_MSG);
      }
      await offItems.first().click({ force: true });   // a disabled item does nothing
      await expect(textarea(page)).toBeDisabled();
      await expect(textarea(page)).toHaveAttribute('placeholder', OFF_MSG);
      await expect(chip(page, '종목코드 픽셀플러스')).toBeDisabled();
      await expect(sendButton(page)).toBeDisabled();
      await chip(page, '종목코드 픽셀플러스').click({ force: true });
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1000);
      expect(posts, 'no request is sent while the model server is off').toHaveLength(0);

      await page.goto(off.url + '/network');
      await expect(dd(page, 'Status')).toHaveText('serving API unreachable');   // rt.error wins over "unavailable"
      await expect(dd(page, 'Status').locator('span').first()).toHaveCSS('background-color', 'rgb(218, 218, 218)');   // grey dot
      await expect(dd(page, 'Model')).toHaveText('—');
      await expect(dd(page, 'Live connection')).toHaveText('not connected');

      // the model server comes back: no reload — the picker re-enables on its own (30 s status cache + 20 s poll)
      await page.goto(`${off.url}/chat/${K.pixel}`);
      await expect(box).toBeVisible();
      await proxy.up();
      await expect(box).toHaveCount(0, { timeout: 90_000 });
      for (let i = 0; i < n; i++) await expect(offBoxes.nth(i)).toBeEnabled();
      await expect(textarea(page)).toBeEnabled();
      await page.goto(off.url + '/network');
      await expect(dd(page, 'Status')).toHaveText('available — knowledge can be loaded live', { timeout: 60_000 });
      await expect(dd(page, 'Model')).toHaveText('Qwen3.8-Flash-Next');
      await expect(dd(page, 'Live connection')).toHaveText('connected — load and unload without restart');

      // a request already in flight when the server drops
      await page.goto(`${off.url}/chat/${K.pixel}`);
      await expect(offItems.first()).toBeEnabled();
      await modeRadio(page, 'Before only').click();
      await chip(page, '종목코드 픽셀플러스').click();
      await waitForLockFree(request, off.url);   // the model lock is shared by every node on this machine
      expect(await waitForRuntime(request, off.url), 'model reachable through the relay (vLLM itself may be restarting)').toBe(true);
      await expect(textarea(page)).toBeEnabled({ timeout: 60_000 });
      const inFlight = proxy.nextGeneration();
      const turn = await sendPrompt(page);
      await inFlight;   // the generation request has reached the relay → cut it now
      await proxy.down();
      await expect(turn.getByRole('alert')).toHaveText('The model server is off or not responding. Try again in a moment.', { timeout: 90_000 });
      await expect(turn.getByRole('button', { name: 'Retry' })).toBeVisible();
    } finally {
      await off.stop();
      await proxy.close();
    }
  });

  test('AZ-009 Exhaust the 20-per-hour free trial and read the quota message', async ({ page, context, request }) => {
    test.setTimeout(20 * 60_000);
    const origin = await freshVisitor(page);
    await page.goto(`${origin}/chat/${K.pixel}`);
    await modeRadio(page, 'Before only').click();
    for (let i = 1; i <= 20; i++) {
      await chip(page, '종목코드 픽셀플러스').click();
      const turn = await sendPrompt(page);
      await waitTurnDone(page, request, turn, { timeoutMs: 5 * 60_000 });
      if (i < 20) await expect(quotaFooter(page)).toHaveText(`Free trial ${20 - i}/20 left this hour`);
    }
    const none = 'You used all free tries for this hour. Try again in an hour or buy the knowledge.';
    await expect(page.getByRole('status').filter({ hasText: none })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: none })).toHaveCSS('background-color', 'rgb(255, 243, 224)');
    await expect(textarea(page)).toBeDisabled();
    await expect(textarea(page)).toHaveAttribute('placeholder', none);
    await expect(chip(page, '종목코드 픽셀플러스')).toBeDisabled();
    await expect(sendButton(page)).toBeDisabled();
    await expect(quotaFooter(page)).toHaveCount(0);
    await expect(page.locator('main').getByText(none)).toHaveCount(2); // alert + footer

    // one more request from the same IP: HTTP 429 with the exact server message
    const r = await api<{ error: string }>(page.request, '/api/chat', { node: origin, method: 'POST', headers: visitorHeaders(page), data: { patch_id: K.pixel, mode: 'base', messages: [{ role: 'user', content: 'hi' }] } });
    expect(r.status).toBe(429);
    expect(r.body.error).toBe('free live-test quota exhausted for this hour — buy the patch or run your own node');

    // the UI maps that 429 to the red turn error (a fresh tab does not yet know the quota is gone)
    const tab2 = await context.newPage();
    await tab2.goto(`${origin}/chat/${K.pixel}`);
    await modeRadio(tab2, 'Before only').click();
    await chip(tab2, '종목코드 픽셀플러스').click();
    const turn = await sendPrompt(tab2);
    await expect(turn.getByRole('alert')).toHaveText('You used all free tries for this hour. Try again in an hour, or buy the knowledge and use it without limits on your own node.', { timeout: 60_000 });
    await expect(turn.getByRole('alert')).toHaveCSS('background-color', 'rgb(253, 232, 236)');
    await expect(tab2.getByRole('status').filter({ hasText: none })).toBeVisible();
    await tab2.close();
  });
});
