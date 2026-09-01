/**
 * Teach mode — the visitor flow in a real browser (spec §4.1 / §4.2, §13.2) against a node whose teach backend is
 * `stub` (CI / dev nodes; with `teach.stubOffline: true` the whole lifecycle never depends on the shared model).
 *
 *   AINIZE_URL=http://localhost:3412 AINIZE_PASS=teach-pass npx playwright test tests/web-teach.spec.ts --project=web
 *
 * Scenario ids ↔ docs/ux-test-scenarios.json (PR-7 filed spec §13.2 AZ-090…AZ-111 as AZ-101…AZ-122; the titles below use those ids):
 *   AZ-103 drawer + basket persists (spec AZ-092)     AZ-104 credit sheet, key in localStorage, backup download (spec AZ-093) + key restore in a fresh browser
 *   AZ-105 preflight: known fact skipped (spec AZ-094) AZ-106 stub lifecycle → READY, card copy, teach events (spec AZ-095)
 *   AZ-107 Try it now on the READY draft (spec AZ-096) AZ-109 keep it private: token download, sha256, recipe, RUN-LOCALLY.md (spec AZ-098)
 *   AZ-110/111 publish (review + operator approve / auto; signed contributor on the anchor; chips; teacher page; Your knowledge) (spec AZ-099 / AZ-100)
 *   AZ-120 owner mismatch: redacted card / 403 not_owner (spec AZ-109)
 * One browser context is shared by AZ-103…AZ-111 (the flow lives in localStorage); AZ-120 and the restore step open a second, empty context.
 * Tagged @runtime: AZ-103 and AZ-107 ask the shared serving model (one completion each); the rest is stub-only.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { K, NODE_A, api, passwordFor, runtimeAvailable, waitForLockFree, waitForRuntime } from '../helpers/ainize';
import { createIdentity, hashCanonical, signMessage, verifyMessage } from '../../core/dist/index.js';

test.describe.configure({ mode: 'serial' });

const NODE = NODE_A;
const PASS = process.env.AINIZE_PASS ?? passwordFor(NODE);
/** Every published lesson becomes a listing whose benchmark samples make the same fact "too close to knowledge already on this node" (spec §12) — so each run teaches a run-unique phrasing (the tag sits mid-sentence so no earlier sample is a substring). The prompt still mentions 픽셀플러스, which makes the stub copy the real fixture. */
const TAG = Date.now().toString(36).slice(-5);
const PROMPT = `픽셀플러스 (${TAG}) 종목코드는?`;
const ANSWER = '087600';
const ALT = `픽셀플러스의 (${TAG}) KRX 종목코드를 알려줘`;
/** The offline stub "knows" a fact whose prompt already contains the answer → "Already correct — skipped". */
const KNOWN_Q = '종목코드 087600은 픽셀플러스인가요?';
const KNOWN_A = '픽셀플러스';
const TEACHER_NAME = 'AZ Teacher';

interface Policy { enabled: boolean; publish: 'review' | 'auto' | 'never'; backend: string; limits: { jobs_per_key_per_day: number }; shares: { contributor: number } }
interface Job { id: string; status: string; facts?: { prompt: string; answer: string }[]; draft_id?: string; patch_id?: string; checks?: { ok: boolean; executed: boolean; taught: { hits: number; total: number } } }
interface Contributor { address: string; signer?: string; name?: string; share: number; role: string; proof: string; sig?: string }
interface Detail { anchor: { id: string; name: string; price: string; origin?: string; patch_sha256: string; benchmark_hash: string; contributors?: Contributor[]; author: string } }

let policy: Policy;
let context: BrowserContext;
let page: Page;
let nodeAddress = '';
let ledgerKind = '';
let keyAddress = '';
let keyBackup = '';
let jobId = '';
let draftId = '';
let patchId = '';
let lessonName = '';
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const teachHeader = (id: { address: string; privateKey: string }) => { const ts = Date.now(); return { 'x-ngram-auth': `${id.address}:${ts}:${signMessage(`teach:${ts}`, id.privateKey)}` }; };

test.beforeAll(async ({ browser, request }) => {
  const p = await api<Policy>(request, '/api/teach/policy');
  test.skip(p.status !== 200 || !p.body.enabled, 'node without teach mode (GET /api/teach/policy not enabled)');
  test.skip(p.body.backend !== 'stub', 'teach backend is not `stub` — the browser flow would start a real GPU job');
  policy = p.body;
  const info = await api<{ node: { address: string }; ledger: { kind: string } }>(request, '/api/info');
  nodeAddress = info.body.node.address;
  ledgerKind = info.body.ledger.kind;
  context = await browser.newContext({ acceptDownloads: true, locale: 'en-US', viewport: { width: 1280, height: 900 } });
  page = await context.newPage();
});
test.afterAll(async ({ request }) => {
  await context?.close();
  // Leave nothing behind on the node (the canonical demo catalog must stay clean): cancel the lesson via the
  // operator API — a READY / kept lesson and its private draft are deleted. An ANNOUNCED lesson is immutable by
  // design (409 published_immutable); announcing is only allowed on a local-ledger node, whose home is disposable.
  if (jobId) {
    const login = await api<{ token: string }>(request, '/api/auth/login', { method: 'POST', data: { password: passwordFor(NODE) } });
    if (login.status === 200) {
      const del = await api<{ status?: string }>(request, `/api/teach/jobs/${jobId}`, { method: 'DELETE', token: login.body.token });
      if (![200, 409].includes(del.status)) console.warn(`teach cleanup: DELETE job ${jobId} -> ${del.status}`);
    } else console.warn(`teach cleanup skipped: operator login failed (${login.status})`);
  }
});

test('AZ-103 banner → "Teach the right answer" under a reply → drawer → basket persists across reload @runtime', async ({ request }) => {
  test.skip(!(await waitForRuntime(request, NODE, 8 * 60_000)), 'serving model unavailable (vLLM restart takes ~5 min)');
  await waitForLockFree(request, NODE, 5 * 60_000);
  await page.goto(`${NODE}/chat/${K.pixel}?teach=1`);
  await expect(page.getByTestId('teach-banner')).toContainText('Wrong answer? Click "Teach the right answer" under any reply and the model learns it. No account needed.');
  await expect(page.getByTestId('nav-teach')).toBeVisible();
  const basket = page.getByTestId('lesson-basket');
  await expect(basket).toContainText('Your lesson (0 of 8)');
  await expect(basket).toContainText('No corrections yet.');
  await expect(page.getByTestId('teach-policy')).toContainText('Teaching on this node: open');
  await expect(page.getByTestId('train-lesson')).toBeDisabled();

  // one completion only ("Before only"), then the teach button under the base answer
  await page.getByRole('radio', { name: 'Before only' }).click();
  const box = page.getByRole('textbox', { name: /Type a question/ });
  await box.fill(PROMPT);
  await box.press('Enter');
  const teachBtn = page.getByTestId('teach-base');
  await expect(teachBtn).toBeVisible({ timeout: 4 * 60_000 });
  await teachBtn.click();
  const drawer = page.getByTestId('teach-drawer');
  await expect(drawer).toContainText('Teach the right answer');
  await expect(drawer.getByRole('textbox', { name: 'The question' })).toHaveValue(PROMPT);
  await expect(drawer).toContainText('The model said');
  // validation first: empty answer
  await drawer.getByTestId('teach-add').click();
  await expect(drawer.getByRole('alert')).toContainText('Please type the right answer.');
  await drawer.getByTestId('teach-answer').fill(ANSWER);
  await drawer.getByTestId('teach-alt').fill(ALT);
  await drawer.getByTestId('teach-add').click();
  await expect(drawer).toBeHidden();
  await expect(basket).toContainText('Your lesson (1 of 8)');
  await expect(basket.getByTestId('basket-item').first()).toContainText(PROMPT);
  await expect(basket.getByTestId('basket-item').first()).toContainText(ANSWER);

  // a second correction the offline stub already "knows" (prompt contains the answer) — exercised by the pre-flight
  await teachBtn.click();
  await drawer.getByRole('textbox', { name: 'The question' }).fill(KNOWN_Q);
  await drawer.getByTestId('teach-answer').fill(KNOWN_A);
  await drawer.getByTestId('teach-add').click();
  await expect(basket).toContainText('Your lesson (2 of 8)');
  await expect(page.getByTestId('train-lesson')).toBeEnabled();

  await page.reload();
  await expect(page.getByTestId('lesson-basket')).toContainText('Your lesson (2 of 8)', { timeout: 30_000 });
  const stored = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('ainize.teach.basket.')));
  expect(stored.length).toBeGreaterThan(0);
  await page.screenshot({ path: 'results/az-101-basket.png', fullPage: true });
});

test('AZ-104 first "Train this lesson" → Who gets the credit? → key in localStorage → backup download → Continue', async () => {
  test.skip(!jobId && !(await page.getByTestId('train-lesson').isEnabled().catch(() => false)), 'basket empty (AZ-103 skipped)');
  expect(await page.evaluate(() => localStorage.getItem('ainize.teacher.key'))).toBeNull();
  await page.getByTestId('train-lesson').click();
  const sheet = page.getByTestId('credit-sheet');
  await expect(sheet).toContainText('Who gets the credit?');
  await expect(sheet).toContainText('Ainize never sees the private key.');
  keyAddress = (await sheet.getByTestId('key-address').textContent())!.trim();
  expect(keyAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('ainize.teacher.key') ?? 'null') as { address: string; privateKey: string });
  expect(stored.address).toBe(keyAddress);
  expect(stored.privateKey).toMatch(/^[0-9a-f]{64}$/);
  await sheet.getByTestId('key-name').fill(TEACHER_NAME);
  const [dl] = await Promise.all([page.waitForEvent('download'), sheet.getByTestId('key-backup').click()]);
  expect(dl.suggestedFilename()).toMatch(/^ainize-teaching-key-[0-9a-f]{8}\.json$/);
  keyBackup = readFileSync((await dl.path())!, 'utf8');
  const body = JSON.parse(keyBackup) as { privateKey: string; address: string; name: string };
  expect(body.privateKey).toBe(stored.privateKey);
  expect(body.address).toBe(keyAddress);
  expect(body.name).toBe(TEACHER_NAME);
  await sheet.getByTestId('key-continue').click();
  await expect(sheet).toBeHidden();
  await expect(page.getByTestId('preflight-sheet')).toBeVisible();
  await expect(page.getByTestId('lesson-basket')).toContainText(`Teaching as ${TEACHER_NAME}`);
});

test('AZ-105 pre-flight: wrong fact will train, already-correct fact skipped, quota line → Queue training', async () => {
  test.skip(!keyAddress, 'no key (earlier step skipped)');
  const pf = page.getByTestId('preflight-sheet');
  await expect(pf).toContainText('Checking what the model already knows');
  const rows = pf.getByTestId('preflight-list').locator('li');
  await expect(rows).toHaveCount(2, { timeout: 2 * 60_000 });
  await expect(rows.nth(0)).toHaveAttribute('data-status', 'will_train');
  await expect(rows.nth(0)).toContainText('Wrong today — will train');
  await expect(rows.nth(0)).toContainText('Model said:');
  await expect(rows.nth(1)).toHaveAttribute('data-status', 'already_known');
  await expect(rows.nth(1)).toContainText('Already correct — skipped');
  await expect(pf.getByTestId('preflight-quota')).toContainText(new RegExp(`\\d+ of ${policy.limits.jobs_per_key_per_day} lessons left today for this key`));
  const queue = pf.getByTestId('queue-training');
  await expect(queue).toHaveText('Queue training (1 corrections)');
  await page.screenshot({ path: 'results/az-103-preflight.png', fullPage: true });
  await queue.click();
  await expect(pf).toBeHidden({ timeout: 30_000 });
  await expect(page).toHaveURL(/[?&]lesson=[0-9a-f-]{36}/);
  jobId = new URL(page.url()).searchParams.get('lesson')!;
  await expect(page.getByTestId('lesson-basket')).toContainText('Your lesson (0 of 8)');
  const mirror = await page.evaluate(() => JSON.parse(localStorage.getItem('ainize.teach.jobs') ?? '[]') as { id: string }[]);
  expect(mirror[0].id).toBe(jobId);
});

test('AZ-106 stub lifecycle → READY: card copy, check lines, per-correction table, teach events, redacted public body', async ({ request }) => {
  test.skip(!jobId, 'no job (earlier step skipped)');
  const card = page.getByTestId('lesson-card');
  await expect(card).toBeVisible();
  await expect(card).toContainText('Your lesson:');
  await expect(card).toHaveAttribute('data-status', 'READY', { timeout: 3 * 60_000 });
  // stub backend → "checks were simulated" (no "in the live model" claim); a gradient node says "…correct in the live model."
  await expect(card.getByTestId('lesson-body')).toContainText(/It learned it — 2 of 2 answers correct( in the live model)?\./);
  if (policy.backend === 'stub') await expect(card.getByTestId('lesson-simulated')).toContainText('Demo node — these checks were simulated, not measured in a live model.');
  await expect(card.getByTestId('lesson-status')).toHaveText('Ready · private');
  await expect(card).toContainText(/Unrelated questions unchanged: \d+\/\d+/);
  await expect(card).toContainText('Other phrasing answered correctly: 1/1');
  await expect(card).toContainText('Unsaved lessons are deleted after 7 days.');
  await expect(card.locator('table')).toContainText(PROMPT);
  await expect(card.getByTestId('lesson-try')).toBeVisible();
  await expect(card.getByTestId('lesson-publish')).toBeEnabled();
  await expect(card.getByTestId('lesson-keep')).toBeVisible();
  await expect(card.getByTestId('publish-gated')).toHaveCount(0);
  await page.screenshot({ path: 'results/az-104-ready.png', fullPage: true });
  // API: anonymous callers only see {id, status}; the owner's body (via the browser) is what the card rendered
  const pub = await api<{ job: Job }>(request, `/api/teach/jobs/${jobId}`);
  expect(pub.status).toBe(200);
  expect(pub.body.job.status).toBe('READY');
  expect(pub.body.job.facts).toBeUndefined();
  const ev = await api<{ events: { kind: string; message: string; data: { job_id?: string } | null }[] }>(request, `/api/events?kind=teach&limit=50`);
  const mine = ev.body.events.filter((e) => e.data?.job_id === jobId);
  expect(mine.some((e) => /^READY:/.test(e.message))).toBe(true);
  expect(mine.some((e) => /^training started \(stub\)/.test(e.message))).toBe(true);
});

test('AZ-107 Try it now: the READY draft joins the stack under "Your lessons" and answers through /api/chat @runtime', async ({ request }) => {
  test.skip(!jobId, 'no job (earlier step skipped)');
  const card = page.getByTestId('lesson-card');
  await card.getByTestId('lesson-try').click();
  await expect(page).toHaveURL(new RegExp(`/chat/${K.pixel},taught-[a-z0-9-]+\\?lesson=${jobId}`), { timeout: 30_000 });
  draftId = /,(taught-[a-z0-9-]+)\?/.exec(decodeURIComponent(page.url()))![1];
  await expect(page.getByRole('heading', { name: 'Your lessons' })).toBeVisible();
  await expect(page.getByText('2 knowledges loaded together')).toBeVisible();
  await expect(page.getByRole('checkbox').filter({ has: page.locator(':scope') }).nth(0)).toBeVisible();
  // the draft is a real catalog entry for its owner and shows in the sample chips
  await expect(page.getByRole('button', { name: PROMPT }).first()).toBeVisible();
  const chatPatches = await api<{ items: { anchor: { id: string } }[] }>(request, '/api/chat/patches');
  expect(chatPatches.body.items.map((e) => e.anchor.id)).not.toContain(draftId);   // private: not in the public picker
  if (await runtimeAvailable(request, NODE)) {
    await waitForLockFree(request, NODE, 5 * 60_000);
    await page.getByRole('radio', { name: 'After only' }).click();
    const box = page.getByRole('textbox', { name: /Type a question/ });
    await box.fill(PROMPT);
    await box.press('Enter');
    const last = page.locator('article').last();
    await expect(last.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 4 * 60_000 });
    const failed = await last.getByRole('alert').count();
    if (!failed) {
      await expect(last).toContainText('After loading 2');
      expect.soft((await last.textContent())?.replace(/\s/g, '')).toContain(ANSWER);
    }
    await page.screenshot({ path: 'results/az-105-try.png', fullPage: true });
  }
});

test('AZ-109 Keep it private: 7-day token links, sha256 matches, recipe.json, RUN-LOCALLY.md download, hardware notice, wrong token refused', async ({ request }) => {
  test.skip(!jobId, 'no job (earlier step skipped)');
  const card = page.getByTestId('lesson-card');
  await card.getByTestId('lesson-keep').click();
  const keep = page.getByTestId('keep-sheet');
  await expect(keep).toContainText('Keep it private');
  await expect(keep).toContainText('Nothing is published. Pick how you want to keep it.');
  await expect(keep).toContainText('Keep it on this node for 7 days');
  await expect(keep).toContainText('Not private from the operator.');
  await keep.getByTestId('keep-download').check();
  const npz = keep.getByTestId('dl-npz');
  await expect(npz).toBeVisible({ timeout: 30_000 });
  await expect(keep).toContainText(/[\d.]+ MB · [\d,]+ memory entries · link valid for 7 days/);
  const sha = (await keep.getByTestId('dl-sha').textContent())!.trim();
  expect(sha).toMatch(/^[0-9a-f]{64}$/);
  const npzHref = (await npz.getAttribute('href'))!;
  expect(npzHref).toMatch(new RegExp(`^/p2p/blob/${sha}\\?token=`));
  const blob = await request.get(`${NODE}${npzHref}`);
  expect(blob.status()).toBe(200);
  expect(sha256(await blob.body())).toBe(sha);
  const recipeHref = (await keep.getByTestId('dl-recipe').getAttribute('href'))!;
  const recipe = await (await request.get(`${NODE}${recipeHref}`)).json() as Record<string, unknown>;
  expect(JSON.stringify(recipe)).toContain(PROMPT);
  const [dl] = await Promise.all([page.waitForEvent('download'), keep.getByTestId('dl-readme').click()]);
  expect(dl.suggestedFilename()).toBe('RUN-LOCALLY.md');
  const md = readFileSync((await dl.path())!, 'utf8');
  expect(md).toContain('# Run this knowledge yourself');
  expect(md).toContain(sha);
  expect(md).toContain('applied: yes');
  expect(md).toContain('ainize patch import');
  // run-on-my-machine: hardware notice first, commands only after the toggle
  await keep.getByTestId('keep-run').check();
  await expect(keep).toContainText('There is no laptop version yet.');
  await expect(keep.getByTestId('run-commands')).toHaveCount(0);
  await keep.getByTestId('run-toggle').check();
  await expect(keep.getByTestId('run-commands')).toContainText(sha);
  await expect(keep.getByTestId('run-commands')).toContainText('patch.py apply');
  await expect(keep.getByRole('button', { name: 'Copy commands' })).toBeVisible();
  await page.screenshot({ path: 'results/az-106-keep.png', fullPage: true });
  const bad = await api(request, `/api/teach/jobs/${jobId}/recipe?token=nope`);
  expect(bad.status).toBe(401);
  await keep.getByTestId('keep-done').click();
  await expect(keep).toBeHidden();
  // default option = keep it on this node
  await card.getByTestId('lesson-keep').click();
  await page.getByTestId('keep-done').click();
  await expect(page.getByTestId('keep-kept')).toContainText('Kept on this node for 7 days.');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('keep-sheet')).toBeHidden();
  await expect(card).toHaveAttribute('data-status', 'READY');
});

test('AZ-110/111 Publish: consents, signed claim → announced (or review + operator approve); contributor on the anchor; chips; teacher page; Your knowledge', async ({ request }) => {
  test.skip(!jobId, 'no job (earlier step skipped)');
  test.skip(policy.publish === 'never', 'node never publishes lessons');
  // An announced anchor is a permanent ledger record. On a node that sits on the shared AIN chain (the live demo
  // cluster) it would pollute the public catalog forever, so the publish flow is exercised on local-ledger nodes
  // only (node-t / a private throwaway cluster). AINIZE_TEACH_ANNOUNCE=1 overrides on a disposable chain.
  test.skip(ledgerKind === 'ain' && process.env.AINIZE_TEACH_ANNOUNCE !== '1', 'shared AIN chain — a public announce is permanent; run against a local-ledger node for publish coverage');
  const card = page.getByTestId('lesson-card');
  await card.getByTestId('lesson-publish').click();
  const pub = page.getByTestId('publish-sheet');
  await expect(pub).toContainText('Publish your knowledge');
  lessonName = `AZ-107 taught lesson ${Date.now().toString(36)}`;
  await pub.getByTestId('pub-name').fill(lessonName);
  await pub.getByTestId('pub-price').fill('0.2');
  await expect(pub).toContainText(`Shown as`);
  await expect(pub).toContainText(TEACHER_NAME);
  await expect(pub).toContainText(`You receive ${Math.round(policy.shares.contributor * 100)}% of every sale.`);
  await expect(pub.getByTestId('pub-submit')).toBeDisabled();       // consents missing
  await pub.getByTestId('consent-permanent').check();
  await pub.getByTestId('consent-rights').check();
  await expect(pub.getByTestId('pub-submit')).toBeEnabled();
  await pub.getByTestId('pub-submit').click();
  const done = pub.getByTestId('publish-done');
  await expect(done).toBeVisible({ timeout: 60_000 });
  if (policy.publish === 'auto') {
    await expect(done).toContainText('Announced. Independent verifier nodes are now checking it on the real model');
    const href = (await pub.getByTestId('publish-page-link').getAttribute('href'))!;
    patchId = decodeURIComponent(href.split('/').pop()!);
  } else {
    await expect(done).toContainText('Sent to the node operator for review.');
    const login = await api<{ token: string }>(request, '/api/auth/login', { method: 'POST', data: { password: PASS } });
    expect(login.status).toBe(200);
    const ok = await api<{ status: string; patch_id: string }>(request, `/api/me/teach/jobs/${jobId}/approve`, { method: 'POST', token: login.body.token });
    expect(ok.status).toBe(200);
    patchId = ok.body.patch_id;
  }
  expect(patchId).toBe(draftId || patchId);
  await expect(pub.getByTestId('publish-earnings-link')).toHaveAttribute('href', `/teacher/${keyAddress}`);
  await page.screenshot({ path: 'results/az-107-published.png', fullPage: true });
  await pub.getByText('Close', { exact: true }).click();
  await expect(card).toHaveAttribute('data-status', 'ANNOUNCED', { timeout: 90_000 });
  await expect(card).toContainText('Announced — verifier nodes are checking it on the real model.');

  // the anchor: origin teach, one signed data-provider whose claim verifies for the browser key (spec §9.1 / §9.2)
  const d = await api<Detail>(request, `/api/patches/${patchId}`);
  expect(d.status).toBe(200);
  expect(d.body.anchor.origin).toBe('teach');
  expect(d.body.anchor.name).toBe(lessonName);
  expect(d.body.anchor.price).toBe('0.2');
  expect(d.body.anchor.author).toBe(nodeAddress);
  const c = d.body.anchor.contributors![0];
  expect(c.address.toLowerCase()).toBe(keyAddress.toLowerCase());
  expect(c).toMatchObject({ name: TEACHER_NAME, share: policy.shares.contributor, role: 'data_provider', proof: 'signed' });
  const claim = hashCanonical({ patch_sha256: d.body.anchor.patch_sha256, benchmark_hash: d.body.anchor.benchmark_hash, address: c.address, share: c.share });
  expect(verifyMessage(claim, c.sig!, c.address)).toBe(true);
  const cat = await api<{ items: { anchor: { id: string } }[] }>(request, `/api/catalog?contributor=${keyAddress}`);
  expect(cat.body.items.map((e) => e.anchor.id)).toContain(patchId);
  const del = await api(request, `/api/teach/jobs/${jobId}`, { method: 'DELETE' });
  expect([401, 403, 409]).toContain(del.status);   // anonymous → 401; owner would get 409 published_immutable

  // knowledge page: "Taught lesson" badge, people line, "Use it yourself"
  await page.goto(`${NODE}/${encodeURIComponent(nodeAddress)}/${encodeURIComponent(patchId)}`);
  const taught = page.getByTestId('taught-by');
  await expect(taught).toContainText('Taught lesson');
  await expect(taught).toContainText(`Data provider: ${TEACHER_NAME} (${Math.round(policy.shares.contributor * 100)}%)`);
  await taught.getByRole('button', { name: /Use it yourself/ }).click();
  await expect(page.getByRole('tab', { name: 'Buy' })).toHaveAttribute('aria-selected', 'true');
  await page.screenshot({ path: 'results/az-107-patch-page.png', fullPage: true });
  // catalog list item chip
  await page.goto(`${NODE}/explore`);
  const item = page.getByRole('link', { name: new RegExp(lessonName) }).first();
  await expect(item).toBeVisible({ timeout: 30_000 });
  await expect(item.getByTestId('taught-chip')).toContainText(`Taught by ${TEACHER_NAME}`);
  await expect(item.getByTestId('taught-chip')).toContainText('Use it yourself');
  // public teacher page
  await page.goto(`${NODE}/teacher/${keyAddress}`);
  await expect(page.getByTestId('teacher-address')).toHaveText(keyAddress);
  await expect(page.getByTestId('teacher-earnings')).toBeVisible();
  await expect(page.getByTestId('teacher-lesson').filter({ hasText: lessonName })).toBeVisible();
  await expect(page.getByText('This key belongs to this browser')).toBeVisible();
  await page.screenshot({ path: 'results/az-107-teacher.png', fullPage: true });
  // Your knowledge panel
  await page.goto(`${NODE}/chat?mine=1`);
  const panel = page.getByTestId('mine-panel');
  await expect(panel).toContainText(`This browser · ${keyAddress.slice(0, 6)}…${keyAddress.slice(-4)}`);
  const row = panel.getByTestId('mine-item').filter({ hasText: lessonName });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).toContainText(/Being verified|On sale/);
  await expect(panel.getByTestId('mine-earnings')).toContainText('Earned 0');
  await expect(panel).toContainText('Pending means a sale was recorded but the transfer from this node has not completed yet.');
  await page.screenshot({ path: 'results/az-107-mine.png', fullPage: true });
});

test('AZ-120 owner mismatch: another browser sees only the status; another key gets 403 not_owner', async ({ browser, request }) => {
  test.skip(!jobId, 'no job (earlier step skipped)');
  const other = await browser.newContext({ locale: 'en-US' });
  try {
    const p2 = await other.newPage();
    await p2.goto(`${NODE}/chat?lesson=${jobId}`);
    const card = p2.getByTestId('lesson-card');
    await expect(card).toContainText('This lesson belongs to a different teaching key — only its status is visible', { timeout: 30_000 });
    await expect(card).not.toContainText(PROMPT);
  } finally { await other.close(); }
  const stranger = createIdentity();
  const view = await api<{ job: Job }>(request, `/api/teach/jobs/${jobId}`, { headers: teachHeader(stranger) });
  expect(view.body.job.facts).toBeUndefined();
  const save = await api<{ error: string }>(request, `/api/teach/jobs/${jobId}/save`, { method: 'POST', headers: teachHeader(stranger) });
  expect(save.status).toBe(403);
  expect(save.body.error).toMatch(/^not_owner/);
});

test('AZ-104 (restore) restore the key backup in a fresh browser → Your knowledge lists the lesson', async ({ browser }) => {
  test.skip(!keyBackup || !jobId, 'no backup (earlier step skipped)');
  const other = await browser.newContext({ locale: 'en-US' });
  try {
    const p2 = await other.newPage();
    await p2.goto(`${NODE}/chat?mine=1`);
    const panel = p2.getByTestId('mine-panel');
    await expect(panel).toContainText('This browser has no teaching key yet.');
    await panel.getByTestId('key-import').getByRole('textbox').fill(keyBackup);
    await panel.getByRole('button', { name: 'Use this key' }).click();
    await expect(panel).toContainText(`This browser · ${keyAddress.slice(0, 6)}…${keyAddress.slice(-4)}`, { timeout: 30_000 });
    await expect(panel.getByTestId('mine-item').filter({ hasText: lessonName || PROMPT })).toBeVisible({ timeout: 30_000 });
    const stored = await p2.evaluate(() => JSON.parse(localStorage.getItem('ainize.teacher.key') ?? 'null') as { address: string });
    expect(stored.address).toBe(keyAddress);
  } finally { await other.close(); }
});
