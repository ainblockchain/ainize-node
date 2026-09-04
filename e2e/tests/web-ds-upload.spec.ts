/**
 * Teach mode, the FILE DOOR — step 1 and step 2 of the dataset-first wizard (docs/teachable-dataset-design.md §5.2–§5.4,
 * §8, §12). Scenarios AZ-123…AZ-142 of docs/ux-test-scenarios.json, one test each, ids in the titles.
 *
 *   AINIZE_URL=http://localhost:3422 AINIZE_PASS=teachable-pass npx playwright test tests/web-ds-upload.spec.ts --project=web
 *   …--project=mobile      only the @mobile scenario (AZ-124) at 360 px
 *
 * Node it runs against: node-u on :3422 in its publish-leg mode — teach enabled, backend `stub`, `teach.stubOffline`
 * true. NOTHING here asks the model: no lesson is queued and no pre-flight is run, so no scenario in this file needs
 * the live model server and none touches the shared runtime lock. (That is why there is no @runtime tag and no
 * `test.describe.configure({ mode: 'serial' })`: the suite already runs with `workers: 1`, and keeping the tests
 * independent means one failure does not skip the nineteen behind it.)
 *
 * Three shared-node rules the whole file obeys, because node-u is a dev node other sessions use at the same time:
 *  - every dataset a test creates is deleted by that test, and `afterEach`/`afterAll` sweep anything a failure left
 *    behind — scoped to the teaching keys THIS run used, never by name, so a neighbour's datasets are never touched;
 *  - dataset creation is paced (`paceCreate`) under `teach.dataset.createsPerIpPerMin` — the node counts 10 creates
 *    per minute per IP and this entire suite is one IP — and a "Too many requests" or "Cannot reach the node" answer
 *    is retried rather than reported, because it is a fact about the neighbour, not about the file under test;
 *  - `policyAtDefaults` waits for the node's dataset limits to be node-u's documented ones before each scenario, so
 *    a neighbour that lowers `dataset_max_bytes` for its own test cannot turn "up to 4 MB" into a copy failure here.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { NODE_A, api, operatorToken } from '../helpers/ainize';
import { ensureFixtures, fileSize, isoDay, AZ_FACTS_ROWS } from '../helpers/ds-upload-fixtures';
import {
  authHeaderV2, backOff, keyFromPage, newTeachKey, paceCreate, rememberKey, sha256Hex,
  shortSha, sleep, sweepOurDatasets, teachApi, uploadDataset, waitForNode, type TeachKey,
} from '../helpers/ds-upload-api';

const NODE = NODE_A;
const RUN_START = Date.now();
const FX = ensureFixtures();
const NODE_HOME = process.env.AINIZE_TEACH_HOME ?? join(homedir(), '.ngram-teachable', 'node-u');

interface Policy {
  enabled: boolean; publish: string; backend: string; trainer: string;
  queue: { depth: number; max: number };
  limits: { dataset_max_bytes: number; dataset_max_rows: number; rows_per_job: number; dataset_ttl_days: number; prompt_max: number; answer_max: number; formats: string[] };
  timing: { samples: number; simulated: boolean };
}
interface Dataset {
  id: string; name: string; status: string; source: string; source_name?: string; format?: string; encoding?: string;
  layout?: string; delimiter?: string; has_header?: boolean; columns?: Record<string, number>; sha256: string;
  revision: number; rows: number; invalid_rows: number; retention: string; expires_at?: number; created_at: number;
  deleted_at?: number; summary: Record<string, number>;
}
interface RowsPage { total: number; source_rows: number; offset: number; limit: number; summary: Record<string, number>; items: Row[] }
interface Row { index: number | null; line: number; status: string; prompt?: string; answer?: string; alt_prompt?: string; detail?: string; raw?: string; fixes?: string[] }

let policy: Policy;
let nodeAddress = '';
let opToken = '';

/** The canonical `rows.jsonl` the node writes for these questions — the sha256 the preview calls a Fingerprint. */
const canonicalJsonl = (rows: { prompt: string; answer: string; alt_prompt?: string }[]) =>
  rows.map((r) => JSON.stringify({ prompt: r.prompt, answer: r.answer, ...(r.alt_prompt ? { alt_prompt: r.alt_prompt } : {}) })).join('\n') + (rows.length ? '\n' : '');

const dsJson = async (request: APIRequestContext, key: TeachKey, id: string) =>
  (await teachApi<{ dataset: Dataset }>(request, NODE, nodeAddress, key, 'GET', `/api/teach/datasets/${id}`));
const dsRows = async (request: APIRequestContext, key: TeachKey, id: string, query = '') =>
  (await teachApi<RowsPage>(request, NODE, nodeAddress, key, 'GET', `/api/teach/datasets/${id}/rows${query}`));

/**
 * Run whatever starts a dataset upload and wait for step 2, or for the sentence that says why it did not happen.
 *
 * node-u is shared. When another session's suite is uploading at the same moment its requests count against the same
 * per-minute create limiter, and the page shows "Too many requests. Try again in a moment." — a fact about the
 * neighbour, not about the file. Waiting out the node's window and pressing the same button again is the only honest
 * way to keep asserting what the scenario is about; any other refusal is reported as itself.
 */
const NEIGHBOUR = ['Too many requests. Try again in a moment.', 'Cannot reach the node. Check your connection.'];
async function submitAndWait(page: Page, trigger: () => Promise<unknown>, tries = 6): Promise<string> {
  const never = new Promise<'never'>(() => undefined);
  for (let attempt = 0; attempt < tries; attempt++) {
    await paceCreate();
    await trigger();
    const outcome = await Promise.race([
      page.waitForURL(/\/teach\/dataset\/[0-9a-f-]{36}$/, { timeout: 70_000 }).then(() => 'ok' as const).catch(() => never),
      page.getByTestId('upload-error').waitFor({ state: 'visible', timeout: 70_000 }).then(() => 'refused' as const).catch(() => never),
      sleep(75_000).then(() => 'timeout' as const),
    ]);
    if (outcome === 'ok') {
      await expect(page.getByTestId('teach-dataset')).toBeVisible();
      return /\/teach\/dataset\/([0-9a-f-]{36})$/.exec(page.url())![1];
    }
    const said = outcome === 'refused' ? await page.getByTestId('upload-error').textContent() : null;
    if (said !== null && NEIGHBOUR.includes(said) && attempt < tries - 1) {
      test.setTimeout(test.info().timeout + 140_000);   // the wait is the neighbour's, not this scenario's
      if (said === NEIGHBOUR[1]) await waitForNode(page.request, NODE);
      else await backOff();
      continue;
    }
    throw new Error(`the upload did not reach a dataset page — the page said: ${said ?? `(nothing; still at ${page.url()})`}`);
  }
  throw new Error('the upload never got past the shared node\'s per-minute limiter');
}

/** Upload through the real file input and wait for the preview. Returns the dataset id. */
const uploadViaUi = (page: Page, path: string) => submitAndWait(page, () => page.setInputFiles('[data-testid=file-input]', path));

/** Console errors that are the page's own (a 4xx logs "Failed to load resource", which is the network, not a bug). */
function collectConsoleErrors(page: Page): string[] {
  const errs: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/i.test(m.text())) errs.push(m.text()); });
  page.on('pageerror', (e) => errs.push(String(e)));
  return errs;
}

test.beforeAll(async ({ request }) => {
  // the node is shared and another session restarts it for its own scenarios; give it a moment to come back
  expect(await waitForNode(request, NODE), `${NODE} is not answering`).toBe(true);
  const p = await api<Policy>(request, '/api/teach/policy', { node: NODE });
  expect(p.status, 'GET /api/teach/policy').toBe(200);
  policy = p.body;
  expect(policy.enabled, 'this suite needs a node with teach mode on').toBe(true);
  expect(policy.backend, 'this suite must not start a real GPU job').toBe('stub');
  const info = await api<{ node: { address: string } }>(request, '/api/info', { node: NODE });
  nodeAddress = info.body.node.address;
  opToken = await operatorToken(request, NODE);
});

test.afterAll(async ({ request }) => {
  // the node must not keep a dataset this run created (a failed assertion aborts before a test's own cleanup)
  const swept = await sweepOurDatasets(request, NODE, opToken, RUN_START);
  if (swept.length) console.warn(`web-ds-upload: swept ${swept.length} dataset(s) a test left behind: ${swept.join(', ')}`);
  // and teaching must be left on, whatever AZ-123 did
  const back = await api<{ effective: { enabled: boolean } }>(request, '/api/me/teach/policy', { node: NODE, token: opToken });
  if (back.status === 200 && back.body.effective?.enabled === false) {
    await api(request, '/api/me/teach/policy', { node: NODE, token: opToken, method: 'PATCH', data: { enabled: true } });
  }
});

/**
 * node-u's documented dataset limits, which several scenarios quote in the copy they assert ("up to 4 MB", "up to
 * 2000 questions", "up to 200 questions in one lesson", "deleted after 7 days").
 *
 * The node is shared, and another session's suite lowers these for its own limit scenarios and restores them
 * afterwards. Waiting for the defaults to come back turns "over the 1 MB limit" — a true sentence about someone
 * else's policy — into either a correct run or a message that names the contention instead of the copy.
 */
const DEFAULT_LIMITS = { dataset_max_bytes: 4_000_000, dataset_max_rows: 2000, rows_per_job: 200, dataset_ttl_days: 7 } as const;
async function policyAtDefaults(request: APIRequestContext, ms = 300_000): Promise<Policy> {
  const t0 = Date.now();
  let last: Policy['limits'] | null = null;
  for (;;) {
    if (await waitForNode(request, NODE)) {
      const p = await api<Policy>(request, '/api/teach/policy', { node: NODE });
      if (p.status === 200) {
        last = p.body.limits;
        if ((Object.keys(DEFAULT_LIMITS) as (keyof typeof DEFAULT_LIMITS)[]).every((k) => last![k] === DEFAULT_LIMITS[k])) { policy = p.body; return p.body; }
      }
    }
    if (Date.now() - t0 > ms) throw new Error(`this node's dataset limits are not node-u's defaults (${JSON.stringify(last)}) — another session is changing them while this scenario runs`);
    test.setTimeout(test.info().timeout + 20_000);
    await sleep(5000);
  }
}

test.beforeEach(async ({ request }) => { await policyAtDefaults(request); });

/** Belt and braces: a test that fails mid-way never gets to its own cleanup, so sweep after every one of them. */
test.afterEach(async ({ page, request }) => {
  rememberKey(await keyFromPage(page).catch(() => null));   // so a test that failed before its cleanup is still swept
  const swept = await sweepOurDatasets(request, NODE, opToken, RUN_START);
  if (swept.length) console.warn(`web-ds-upload: swept ${swept.length} leftover dataset(s): ${swept.join(', ')}`);
});

// ---------------------------------------------------------------------------------------------- AZ-123
test('AZ-123 /teach entry choice: two doors, one pipeline — the conversation card leads and one sentence says the five steps are the same for both', async ({ page, browser, request }) => {
  expect(policy.limits.dataset_max_rows, 'the small print quotes limits.dataset_max_rows').toBe(2000);

  await page.goto(`${NODE}/teach`);
  const entry = page.getByTestId('teach-entry');
  await expect(entry).toBeVisible();

  // O-3: the teach flow runs under the slim chrome — logo, Exit, language; no marketplace nav, no developer footer
  const header = page.getByTestId('focused-header');
  await expect(header.getByRole('link', { name: 'Ainize home' })).toBeVisible();
  await expect(header.getByRole('link', { name: 'Explore knowledge' })).toHaveCount(0);
  await expect(header.getByRole('link', { name: 'Live test' })).toHaveCount(0);
  // O-6: the route back to existing work is a header link (secondary position), not part of the action group
  const mine = header.getByTestId('link-mine');
  await expect(mine).toHaveText('My datasets and lessons');
  expect(new URL(await mine.getAttribute('href') ?? '', NODE).pathname).toBe('/teach/mine');
  await expect(entry.getByTestId('link-mine')).toHaveCount(0);
  await expect(page.getByTestId('teach-exit')).toHaveText('Exit');
  expect(new URL((await page.getByTestId('teach-exit').getAttribute('href'))!, NODE).pathname).toBe('/explore');
  await expect(header.getByRole('button', { name: 'language' })).toHaveText('한국어');
  await expect(entry.getByRole('button', { name: 'language' })).toHaveCount(0);   // O-8: a system setting lives in the header, not in the content
  const footer = page.getByTestId('focused-footer');
  await expect(footer.getByRole('link', { name: 'Terms and Policies' })).toHaveAttribute('href', '/terms');
  await expect(footer.getByRole('link', { name: 'Contact us' })).toBeVisible();
  await expect(footer.getByRole('link', { name: 'ain-js' })).toHaveCount(0);
  await expect(footer.getByRole('link', { name: 'aindrive' })).toHaveCount(0);

  await expect(entry.getByRole('heading', { level: 1 })).toHaveText('Teach the model something new');
  // O-7: one line of intro; the longer story is behind "How it works" (a native <details>, collapsed)
  await expect(entry.getByText('No account, no code: your questions and answers become knowledge you can test, keep private or publish.', { exact: true })).toBeVisible();
  await expect(entry.getByText('Two ways in, one result', { exact: false })).toHaveCount(0);
  const how = page.getByTestId('how-it-works');
  await expect(how.locator('summary')).toHaveText('How it works');
  expect(await how.evaluate((el) => (el as HTMLDetailsElement).open), 'collapsed by default').toBe(false);
  await expect(how.locator('p')).toBeHidden();
  await how.locator('summary').click();
  await expect(how.locator('p')).toHaveText('Whichever door you pick: your questions and answers are saved as a dataset on this node, checked line by line, trained into the model, and the result is checked again. What comes out is knowledge you can try in Live test, keep private, download, or publish for others to buy. No account, no server of your own, no code.');
  await how.locator('summary').click();

  // O-9: each door is ONE link — the whole card is the click target, the "button" at its foot is a visual label of the same link
  const chatCard = page.getByTestId('door-chat');
  const fileCard = page.getByTestId('door-file');
  for (const [card, name] of [[chatCard, 'Teach it in a conversation Start a conversation'], [fileCard, 'Upload a dataset file Choose a file']] as const) {
    expect(await card.evaluate((el) => el.tagName)).toBe('A');
    await expect(card).toHaveAccessibleName(name);
    await expect(card.getByRole('button')).toHaveCount(0);
    await expect(card.getByRole('link')).toHaveCount(0);
  }
  await expect(chatCard).toHaveAttribute('href', '/chat?teach=1');
  await expect(fileCard).toHaveAttribute('href', '/teach/upload');
  await expect(chatCard.getByRole('heading', { level: 2 })).toHaveText('Teach it in a conversation');
  await expect(chatCard.locator('p')).toHaveText('Ask the model a question and correct its answer. No file needed.');   // O-7: one sentence + one benefit
  await expect(page.getByTestId('door-chat-cta')).toHaveText('Start a conversation');
  await expect(fileCard.getByText('Already have a file?', { exact: true })).toBeVisible();
  await expect(fileCard.getByRole('heading', { level: 2 })).toHaveText('Upload a dataset file');
  await expect(fileCard.locator('p')).toHaveText('Already have questions and answers in a file? Train them straight away.');
  await expect(page.getByTestId('door-file-cta')).toHaveText('Choose a file');
  // O-1: the conversation card leads — the primary border (#8b3eeb) and the contained label are its; the file card keeps the grey border and the outlined label
  expect(await chatCard.evaluate((el) => getComputedStyle(el).borderTopColor)).toBe('rgb(139, 62, 235)');
  expect(await fileCard.evaluate((el) => getComputedStyle(el).borderTopColor)).toBe('rgb(218, 218, 218)');
  expect(await page.getByTestId('door-chat-cta').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(139, 62, 235)');
  expect(await page.getByTestId('door-file-cta').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
  // O-9: hover and keyboard focus both resolve the affordance — the border darkens under the pointer, and Tab reaches the card with a 3 px ring
  await chatCard.hover();
  await expect.poll(() => chatCard.evaluate((el) => getComputedStyle(el).borderTopColor)).toBe('rgb(91, 28, 168)');
  await page.mouse.move(2, 2);
  await page.locator('body').click({ position: { x: 2, y: 2 } });
  for (let i = 0; i < 12 && !(await chatCard.evaluate((el) => document.activeElement === el)); i++) await page.keyboard.press('Tab');
  expect(await chatCard.evaluate((el) => document.activeElement === el), 'Tab reaches the chat door').toBe(true);
  expect(await chatCard.evaluate((el) => `${getComputedStyle(el).outlineStyle} ${getComputedStyle(el).outlineWidth}`)).toBe('solid 3px');
  await page.keyboard.press('Tab');
  expect(await fileCard.evaluate((el) => document.activeElement === el), 'then the file door').toBe(true);

  // O-4: the file door's limits are two chips beside the picker label — the node's own format list and the DATASET row cap
  // (not the 4 MB the upload page shows); nothing is small print any more
  const limits = fileCard.getByTestId('door-file-limits');
  await expect(limits).toHaveAttribute('aria-label', 'File limits');
  await expect(limits.locator('li')).toHaveText([policy.limits.formats.join(' · '), 'up to 2000 questions']);
  await expect(limits.locator('li').first()).toHaveText('jsonl · json · csv · tsv · txt');
  await expect(limits).not.toContainText('MB');
  await expect(fileCard.locator('small')).toHaveCount(0);
  const chipStyle = await limits.locator('li').first().evaluate((el) => { const cs = getComputedStyle(el); return { size: cs.fontSize, weight: cs.fontWeight, bg: cs.backgroundColor }; });
  expect(chipStyle, 'a badge, not helper text').toEqual({ size: '12px', weight: '600', bg: 'rgb(245, 238, 252)' });
  const [limitsBox, ctaBox] = await Promise.all([limits.boundingBox(), page.getByTestId('door-file-cta').boundingBox()]);
  expect(limitsBox!.y + limitsBox!.height, 'the chips sit directly above the picker label').toBeLessThanOrEqual(ctaBox!.y);

  // O-5: the readiness line is plain language, above the doors; the node's own sentence sits behind "Details"
  const ready = page.getByTestId('teach-policy');
  expect(policy.timing.simulated, 'node-u is a demo node: no minutes may appear').toBe(true);
  await expect(page.getByTestId('teach-ready')).toHaveText('You can start now — nobody is waiting.');
  expect(await ready.evaluate((el) => getComputedStyle(el).backgroundColor), 'info tone').toBe('rgb(245, 238, 252)');
  const readyBox = (await ready.boundingBox())!;
  const chatBox = (await page.getByTestId('door-chat').boundingBox())!;
  expect(readyBox.y + readyBox.height, 'the line sits above the doors').toBeLessThanOrEqual(chatBox.y);
  const detail = page.getByTestId('teach-ready-detail');
  await expect(detail.locator('summary')).toHaveText('Details');
  expect(await detail.evaluate((el) => (el as HTMLDetailsElement).open), 'collapsed by default').toBe(false);
  await expect(detail.locator('p').first()).toBeHidden();
  await detail.locator('summary').click();
  await expect(detail.locator('p')).toHaveText(['Teaching on this node: open · 0 waiting · demo node — lessons are simulated, nothing is trained', `Queue: 0 of ${policy.queue.max} lessons`]);
  await expect(ready).not.toContainText(/\bmin\b/);
  await detail.locator('summary').click();

  // O-2: "what happens next" is a sentence, not a stepper — no list, no numbered discs, no current step, nothing to press
  const next = page.getByTestId('teach-next');
  expect(await next.evaluate((el) => el.tagName)).toBe('P');
  await expect(next).toHaveText('What happens next: Dataset → Check → Settings → Training → Result — the same five steps, whichever door you pick');
  await expect(entry.locator('ol, nav, [aria-current], [data-testid=teach-stepper]')).toHaveCount(0);
  await expect(next.locator('button, a')).toHaveCount(0);
  expect(await next.evaluate((el) => [...el.querySelectorAll('*')].every((c) => { const cs = getComputedStyle(c); return cs.borderTopStyle === 'none' && cs.backgroundColor === 'rgba(0, 0, 0, 0)'; })), 'no box or disc around any step').toBe(true);

  // both doors really go somewhere — pressed on the card itself (top-left corner, nowhere near the label), and by keyboard
  await chatCard.click({ position: { x: 12, y: 12 } });
  await page.waitForURL(/\/chat\?teach=1$/);
  await page.goBack();
  await expect(fileCard).toBeVisible();
  await fileCard.click({ position: { x: 12, y: 12 } });
  await page.waitForURL(/\/teach\/upload$/);
  await page.goBack();
  await expect(chatCard).toBeVisible();
  await chatCard.focus();
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/chat\?teach=1$/);
  await page.goBack();

  // ---- operator variant: a node that is not teaching says so and disables both doors
  const off = await api(request, '/api/me/teach/policy', { node: NODE, token: opToken, method: 'PATCH', data: { enabled: false } });
  expect(off.status).toBe(200);
  try {
    // a second context, because GET /api/teach/policy is cacheable for 10 s and this browser has just cached it
    const ctx = await browser.newContext({ locale: 'en-US' });
    const p2 = await ctx.newPage();
    await p2.goto(`${NODE}/teach`);
    await expect(p2.getByTestId('teach-entry')).toBeVisible();
    await expect(p2.getByTestId('door-chat')).toBeDisabled();
    await expect(p2.getByTestId('door-file')).toBeDisabled();
    await expect(p2.getByTestId('door-chat')).toHaveAttribute('tabindex', '-1');   // a disabled door is not in the Tab order either
    await p2.getByTestId('door-file').click({ position: { x: 12, y: 12 }, force: true });   // force: Playwright refuses to click a disabled control on its own
    await p2.waitForTimeout(500);
    expect(new URL(p2.url()).pathname, 'a disabled door does not navigate').toBe('/teach');
    const alert = p2.getByTestId('teach-policy');
    await expect(alert).toHaveText('This node does not accept lessons. Try another node or run your own.');   // the sentence alone — no "Details" on a node that is off
    await expect(alert.locator('details')).toHaveCount(0);
    expect(await alert.evaluate((el) => getComputedStyle(el).backgroundColor), 'warning tone').toBe('rgb(255, 243, 224)');
    await ctx.close();
  } finally {
    const on = await api(request, '/api/me/teach/policy', { node: NODE, token: opToken, method: 'PATCH', data: { enabled: true } });
    expect(on.status).toBe(200);
  }
  const restored = await api<Policy>(request, '/api/teach/policy', { node: NODE });
  expect(restored.body.enabled, 'teaching restored for the rest of the suite').toBe(true);
});

// ---------------------------------------------------------------------------------------------- AZ-124
test('AZ-124 /teach/upload first look: three ways in are all present at once, and the privacy sentence is above the fold before any file is chosen @mobile', async ({ page }) => {
  const width = page.viewportSize()?.width ?? 1280;
  await page.goto(`${NODE}/teach/upload`);
  const up = page.getByTestId('teach-upload');
  await expect(up).toBeVisible();

  // O-8: the language toggle is a header control in the top-right corner at both widths; at 360 px it shares the logo row
  const lang = page.getByTestId('focused-header').getByRole('button', { name: 'language' });
  await expect(lang).toHaveText('한국어');
  await expect(up.getByRole('button', { name: 'language' })).toHaveCount(0);
  const logoBox = (await page.getByRole('link', { name: 'Ainize home' }).boundingBox())!;
  const langBox = (await lang.boundingBox())!;
  expect(langBox.y, 'the toggle sits on the logo row').toBeLessThan(logoBox.y + logoBox.height);
  // the header column is centred (944 px on desktop, full width less 16 px margins on a phone): the toggle ends where the column ends
  expect(langBox.x + langBox.width, 'top-right corner of the header column').toBeGreaterThanOrEqual(width - logoBox.x - 4);

  await expect(page.getByTestId('teach-stepper')).toHaveAttribute('aria-label', 'Step 1 of 5 · Dataset');
  await expect(up.getByRole('heading', { level: 1 })).toHaveText('Upload your dataset');
  await expect(up.getByText('One question and one right answer per line. The model is taught the answers exactly as you write them.', { exact: true })).toBeVisible();

  const zone = page.getByTestId('drop-zone');
  await expect(zone).toHaveAttribute('role', 'button');
  await expect(zone).toHaveAttribute('tabindex', '0');
  await expect(zone).toHaveAttribute('aria-label', 'Choose a file');
  await expect(zone.getByText('Drop a file here, or', { exact: true })).toBeVisible();
  const input = page.getByTestId('file-input');
  await expect(input).toHaveAttribute('type', 'file');
  await expect(input).toHaveAttribute('accept', '.jsonl,.json,.csv,.tsv,.txt');
  expect(await input.evaluate((el) => el.closest('[data-testid=drop-zone]') !== null), 'the input lives inside the drop zone').toBe(true);
  // Finding 93 — the thing to tap is a real button of the app's own, never the browser's 21 px "Choose File"
  const browse = page.getByTestId('file-browse');
  await expect(browse).toHaveText('Choose a file');
  expect((await browse.boundingBox())!.height, 'the file button meets the 44 px target').toBeGreaterThanOrEqual(44);
  const maxMb = Math.round(policy.limits.dataset_max_bytes / 1e6);
  expect(maxMb).toBe(4);
  await expect(zone.getByText(`jsonl, csv, tsv or txt · up to ${maxMb} MB`, { exact: true })).toBeVisible();

  const paste = page.getByTestId('paste-table');
  await expect(paste.locator('summary')).toHaveText('Paste a table instead');
  expect(await paste.evaluate((el) => el.tagName.toLowerCase())).toBe('details');
  // dragging is not a thing on a phone: below 480 px the paste box is open from the start
  expect(await paste.evaluate((el) => (el as HTMLDetailsElement).open), `paste box open state at ${width} px`).toBe(width < 480);

  const retention = page.getByTestId('retention');
  await expect(retention).not.toBeChecked();
  await expect(retention.locator('xpath=..')).toHaveText('Delete my file as soon as training finishes');

  await expect(page.getByTestId('privacy-text')).toHaveText('Your file is stored on this node while it trains, and the node operator can see it. Do not upload personal data or anything you are not allowed to share.');
  // …and it is above the format help and the samples in the DOM, i.e. before the reader has to scroll past them
  const order = await page.evaluate(() => {
    const at = (sel: string) => [...document.querySelectorAll('[data-testid]')].findIndex((e) => e.matches(sel));
    return { privacy: at('[data-testid=privacy]'), help: at('[data-testid=format-help]'), samples: at('[data-testid=samples]') };
  });
  expect(order.privacy).toBeGreaterThanOrEqual(0);
  expect(order.privacy).toBeLessThan(order.help);
  expect(order.privacy).toBeLessThan(order.samples);

  const help = page.getByTestId('format-help');
  await expect(help.locator('h4')).toHaveText(['.jsonl', '.csv', '.tsv', '.txt']);
  expect(await help.locator('h4').first().evaluate((el) => getComputedStyle(el).textTransform), 'the headings read .JSONL/.CSV/.TSV/.TXT').toBe('uppercase');
  const jsonlBlock = await help.locator('pre').first().textContent();
  expect(jsonlBlock!.trim().split('\n').map((l) => JSON.parse(l))).toEqual(AZ_FACTS_ROWS);
  const txtBlock = await help.locator('pre').nth(3).textContent();
  expect(txtBlock).toContain('Q: Who founded Ainize?');
  expect(txtBlock).toContain('A: Comcom');
  await expect(help.locator('p').last()).toHaveText('Other names work too: "question" / "q" / "질문" for the question, "completion" / "output" / "a" / "정답" for the answer, "alt" / "paraphrase" / "다른표현" for another way to ask.');

  // a visitor who has only looked has no identity on this node
  await expect(page.getByTestId('key-note')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('ainize.teacher.key'))).toBeNull();
});

// ---------------------------------------------------------------------------------------------- AZ-125
/**
 * The file chip's two states are both real, but the second one shares a React commit with the navigation to the
 * preview (RTK's fulfilled update and `navigate()` batch), so it is never on screen long enough to be polled for.
 * A MutationObserver installed before the pick records every text the chip ever carried, which is what the scenario
 * is actually about: "appears with 'Reading your file…' and then '<name> · <size> · <n> questions found'".
 */
async function recordChip(page: Page): Promise<() => Promise<string[]>> {
  await page.evaluate(() => {
    (window as { __chip?: string[] }).__chip = [];
    const seen = (window as unknown as { __chip: string[] }).__chip;
    const push = (s: string | null) => { const v = (s ?? '').trim(); if (v && seen[seen.length - 1] !== v) seen.push(v); };
    new MutationObserver((recs) => {
      for (const r of recs) {
        for (const n of Array.from(r.addedNodes)) {
          const el = n as HTMLElement;
          if (el.getAttribute?.('data-testid') === 'file-chip') push(el.textContent);
          el.querySelectorAll?.('[data-testid=file-chip]').forEach((c) => push(c.textContent));
        }
        if (r.type === 'characterData' && (r.target as Text).parentElement?.closest('[data-testid=file-chip]')) push((r.target as Text).data);
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  return () => page.evaluate(() => (window as unknown as { __chip: string[] }).__chip);
}

test('AZ-125 jsonl through the file picker: chip → node report → preview, and a teaching key is created silently with a backup link', async ({ page, request }) => {
  const fx = FX['az-facts.jsonl'];
  const canonical = canonicalJsonl(AZ_FACTS_ROWS);
  await page.goto(`${NODE}/teach/upload`);
  await expect(page.getByTestId('teach-upload')).toBeVisible();
  const chip = await recordChip(page);

  let post: { status: number; headers: Record<string, string>; reqHeaders: Record<string, string>; body: { created?: boolean; dataset?: Dataset; report?: { summary: Record<string, number> } } } | null = null;
  page.on('response', async (r) => {
    if (r.request().method() !== 'POST' || !r.url().endsWith('/api/teach/datasets')) return;
    post = { status: r.status(), headers: r.headers(), reqHeaders: await r.request().allHeaders(), body: await r.json().catch(() => ({})) };
  });
  // slow the upload down so the "Reading your file…" state is not a coin toss
  await page.route('**/api/teach/datasets', async (r) => { await sleep(900); await r.continue(); });

  const id = await uploadViaUi(page, fx.path);
  const key = (await keyFromPage(page))!;
  expect(key, 'the upload created a teaching key').toBeTruthy();

  expect(await chip()).toEqual(['Reading your file…', `az-facts.jsonl · ${fileSize(fx.bytes.length)} · 3 questions found`]);
  expect(fileSize(fx.bytes.length)).toBe('219 B');   // the scenario rounds this to "200 B"; the specified body is 219 bytes

  expect(post, 'POST /api/teach/datasets was made').not.toBeNull();
  expect(post!.status).toBe(201);
  expect(post!.body.created).toBe(true);
  expect(post!.reqHeaders['x-ngram-dataset-sha256']).toBe(sha256Hex(fx.bytes));
  expect(post!.reqHeaders['x-ngram-auth']).toMatch(/^0x[0-9a-fA-F]{40}:\d{13}:0x[0-9a-f]+:v2$/);

  await expect(page.getByTestId('teach-stepper')).toHaveAttribute('aria-label', 'Step 2 of 5 · Check');
  const ds = page.getByTestId('teach-dataset');
  await expect(ds.getByRole('heading', { level: 1 })).toHaveText('Check your dataset');
  await expect(ds.getByText('3 questions from az-facts.jsonl. Fix anything marked in red, then see which ones the model already knows.', { exact: true })).toBeVisible();

  // the Fingerprint is the sha256 of the CANONICAL rows.jsonl, not of whatever bytes were uploaded
  const canonicalSha = sha256Hex(Buffer.from(canonical, 'utf8'));
  await expect(ds.getByText(`Fingerprint ${shortSha(canonicalSha)}`, { exact: true })).toBeVisible();
  await expect(ds.getByText('Saved as az-facts.jsonl — you can train from it again any time.', { exact: true })).toBeVisible();
  expect((await dsJson(request, key, id)).body.dataset.sha256).toBe(canonicalSha);

  await expect(page.getByTestId('row-counts')).toHaveText('3 will train · 0 already known · 0 duplicates · 0 need a fix');
  const rows = page.getByTestId('dataset-row');
  await expect(rows).toHaveCount(3);
  for (let i = 0; i < 3; i++) {
    await expect(rows.nth(i).locator('td.n')).toHaveText(String(i + 1));
    await expect(rows.nth(i).locator('td.q')).toHaveText(AZ_FACTS_ROWS[i].prompt);
    await expect(rows.nth(i).locator('td.a')).toHaveText(AZ_FACTS_ROWS[i].answer);
    await expect(rows.nth(i).locator('td.alt')).toHaveText(AZ_FACTS_ROWS[i].alt_prompt ?? '');
    await expect(rows.nth(i)).toContainText('Will train');
    await expect(rows.nth(i)).toContainText('Not checked yet');
  }

  // node-u answers the check itself, so the button says so (a node with a model server reads 'Check what the model already knows')
  await expect(page.getByTestId('run-check')).toHaveText('Check (simulated on this node)');
  await expect(page.getByTestId('add-row')).toHaveText('Add a question');
  await expect(page.getByTestId('download-dataset')).toHaveText('Download this dataset (.jsonl)');
  await expect(page.getByTestId('open-reparse')).toHaveText('Wrong columns or separator?');   // only because status === 'staged'
  expect((await dsJson(request, key, id)).body.dataset.status).toBe('staged');
  await expect(page.getByTestId('to-settings')).toHaveText('Continue to settings');

  // the key note, with the backup route, on the page that made the key
  await page.goto(`${NODE}/teach/upload`);
  const short = `${key.address.slice(0, 6)}…${key.address.slice(-4)}`;
  await expect(page.getByTestId('key-note')).toHaveText(`Your dataset was signed with this browser's teaching key (${short}). Lose the key and you lose access to your datasets and lessons — back it up. Back up the key`);
  const backup = page.getByTestId('key-note').getByRole('link', { name: 'Back up the key' });
  expect(await backup.getAttribute('href')).toBe('/chat?mine=1');
  const stored = await page.evaluate(() => Object.keys(localStorage));
  expect(stored).toContain('ainize.teacher.key');
  expect(stored).toContain('ainize.teach.datasets');

  // My datasets shows it, then deletes it
  await page.goto(`${NODE}/teach/mine`);
  const card = page.getByTestId('dataset-card');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('3 questions');
  await expect(card).toContainText('Not trained yet.');
  // Soft, so the delete below still runs on the shared node. This one is a product defect: `teach-mode-dataset-ux.md`
  // :263,:270 give the card a source chip reading "From a conversation / Uploaded file / Copied from a lesson", and
  // `teach.data.source.upload` = "Uploaded file" exists — but `sourceLabel()` returns the FILENAME whenever there is
  // one, so an uploaded dataset's "Where it came from" only repeats the card's own heading.
  const provenance = card.locator('dl > div').filter({ hasText: 'Where it came from' }).locator('dd');
  await expect.soft(provenance, 'the card says the dataset came in through the file door').toHaveText('Uploaded file');

  page.once('dialog', (d) => void d.accept());
  await card.getByTestId('ds-delete').click();
  // The scenario expects the card to disappear and the dataset to 404. It does neither, BY DESIGN: a delete leaves a
  // tombstone (design §6.5 `deleteTeachDataset(id) // tombstone: files removed, row kept with deleted_at`, §7.2
  // "GET /api/teach/datasets → tombstones included") so a lesson trained from it never points at a dangling id. What
  // the visitor must see is that it is over: the four actions are withdrawn and the questions leave the disk.
  await expect(page.getByTestId('dataset-gone')).toHaveText('The dataset for this lesson was deleted by its owner. The lesson itself is unchanged.');
  for (const action of ['ds-retrain', 'ds-continue', 'ds-download', 'ds-delete']) await expect(card.getByTestId(action)).toHaveCount(0);
  const gone = await dsJson(request, key, id);
  expect(gone.status).toBe(200);
  expect(gone.body.dataset.deleted_at, 'the row is a tombstone now').toBeTruthy();
  const dataDir = (JSON.parse(readFileSync(join(NODE_HOME, 'config.json'), 'utf8')) as { dataDir: string }).dataDir;
  expect(existsSync(join(dataDir, 'teach', 'datasets', id)), 'the questions are off the operator\'s disk').toBe(false);
  // a stranger's 404 for this id is AZ-141's job — here the owner is told the truth about their own dataset
});

// ---------------------------------------------------------------------------------------------- AZ-126
test('AZ-126 Drag-and-drop onto the zone, and the same zone opened from the keyboard', async ({ page, request }) => {
  const fx = FX['az-dragdrop.jsonl'];
  const created: string[] = [];
  await page.goto(`${NODE}/teach/upload`);
  const zone = page.getByTestId('drop-zone');
  await expect(zone).toBeVisible();

  const idle = { border: await zone.evaluate((el) => getComputedStyle(el).borderTopColor), bg: await zone.evaluate((el) => getComputedStyle(el).backgroundColor) };
  expect(idle).toEqual({ border: 'rgb(218, 218, 218)', bg: 'rgb(255, 255, 255)' });

  const drag = async (type: 'dragover' | 'dragleave' | 'drop', body?: string, name?: string) => page.evaluate(({ type, body, name }) => {
    const dt = new DataTransfer();
    if (body !== undefined && name !== undefined) dt.items.add(new File([body], name, { type: 'application/x-ndjson' }));
    document.querySelector('[data-testid=drop-zone]')!.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, { type, body, name });

  await drag('dragover');
  await expect.poll(() => zone.evaluate((el) => getComputedStyle(el).borderTopColor)).toBe('rgb(139, 62, 235)');
  expect(await zone.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(245, 238, 252)');
  await drag('dragleave');
  await expect.poll(() => zone.evaluate((el) => getComputedStyle(el).borderTopColor)).toBe('rgb(218, 218, 218)');
  expect(await zone.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(255, 255, 255)');

  // a drop uploads without any click on the file input, and a second drop while it is in flight is ignored
  let posts = 0;
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/api/teach/datasets')) posts++; });
  await page.route('**/api/teach/datasets', async (r) => { await sleep(1500); await r.continue(); });
  const id = await submitAndWait(page, async () => {
    posts = 0;   // count only the attempt that got through
    await drag('dragover');
    await drag('drop', fx.bytes.toString('utf8'), 'az-dragdrop.jsonl');
    await expect(page.getByTestId('file-chip')).toHaveText('Reading your file…');
    await drag('drop', fx.bytes.toString('utf8'), 'az-dragdrop.jsonl');   // in flight → the zone is disabled → ignored
  });
  created.push(id);
  expect(posts, 'the drop while an upload was in flight made no second POST').toBe(1);
  await expect(page.getByTestId('teach-dataset').getByText('3 questions from az-dragdrop.jsonl. Fix anything marked in red, then see which ones the model already knows.', { exact: true })).toBeVisible();
  await expect(page.getByTestId('row-counts')).toHaveText('3 will train · 0 already known · 0 duplicates · 0 need a fix');
  const key = (await keyFromPage(page))!;

  // …and the same zone opens the picker from the keyboard, without scrolling the page
  await page.unroute('**/api/teach/datasets');
  await page.goto(`${NODE}/teach/upload`);
  await page.evaluate(() => {
    (window as { __clicks?: number }).__clicks = 0;
    const proto = HTMLInputElement.prototype as HTMLInputElement & { click: () => void };
    proto.click = function spy() { (window as unknown as { __clicks: number }).__clicks++; };
  });
  await page.evaluate(() => window.scrollTo(0, 0));
  const zone2 = page.getByTestId('drop-zone');
  await zone2.focus();
  await zone2.press('Enter');
  expect(await page.evaluate(() => (window as unknown as { __clicks: number }).__clicks)).toBe(1);
  await zone2.press(' ');
  expect(await page.evaluate(() => (window as unknown as { __clicks: number }).__clicks)).toBe(2);
  expect(await page.evaluate(() => window.scrollY), 'Space did not scroll the page').toBe(0);

  for (const dsId of created) expect((await teachApi(request, NODE, nodeAddress, key, 'DELETE', `/api/teach/datasets/${dsId}`)).status).toBe(200);
});

/**
 * The request bodies the PAGE sent to `POST /api/teach/datasets`.
 *
 * `page.on('request')` cannot see them: the web app re-wraps every signed call as `fetch(new Request(req, …))`, whose
 * body is a stream, and Chromium reports no post data for a stream body. Wrapping `window.fetch` before the app loads
 * records the body the browser actually put on the wire, which is the point of the assertion.
 */
interface SentPost { body: string; sha: string | null; status: number; reply: string }
async function recordPosts(page: Page): Promise<() => Promise<SentPost[]>> {
  await page.addInitScript(() => {
    (window as unknown as { __posts: SentPost[] }).__posts = [];
    const bag = () => (window as unknown as { __posts: SentPost[] }).__posts;
    const orig = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      let entry: SentPost | null = null;
      try {
        const req = input instanceof Request ? input : new Request(input, init);
        if (req.method === 'POST' && new URL(req.url, location.href).pathname === '/api/teach/datasets') {
          entry = { body: await req.clone().text().catch(() => ''), sha: req.headers.get('x-ngram-dataset-sha256'), status: 0, reply: '' };
          bag().push(entry);
        }
      } catch { /* never break the app for the sake of a probe */ }
      const res = await orig(input as RequestInfo, init);
      if (entry) { entry.status = res.status; entry.reply = await res.clone().text().catch(() => ''); }
      return res;
    };
  });
  return () => page.evaluate(() => (window as unknown as { __posts: SentPost[] }).__posts);
}

// ---------------------------------------------------------------------------------------------- AZ-127
test('AZ-127 Paste a table instead: two spreadsheet columns become a .tsv the NODE parses', async ({ page, browser, request }) => {
  const day = isoDay();
  const posts = await recordPosts(page);
  await page.goto(`${NODE}/teach/upload`);
  const paste = page.getByTestId('paste-table');
  await paste.locator('summary').click();
  await expect(paste.getByText('Copy two columns from a spreadsheet and paste them here — the question in the first column, the right answer in the second.', { exact: true })).toBeVisible();
  const box = page.getByTestId('paste-box');
  await expect(box).toHaveAttribute('placeholder', 'Who founded Ainize?\tComcom');

  const use = page.getByTestId('paste-use');
  await expect(use).toHaveText('Use this text');
  await expect(use).toBeDisabled();                       // empty
  await box.fill('   \n  ');
  await expect(use).toBeDisabled();                       // whitespace only

  const tabbed = 'AZ paste question one?\tAnswer One\nAZ paste question two?\tAnswer Two';
  await box.fill(tabbed);
  await expect(use).toBeEnabled();
  const id = await submitAndWait(page, () => use.click());
  const key = (await keyFromPage(page))!;

  // the browser parsed nothing: the multipart body carries the raw text under a .tsv filename
  const sent = (await posts()).filter((x) => x.status < 400);
  expect(sent, 'the POST body was captured').toHaveLength(1);
  expect(sent[0].body).toContain(`filename="pasted-${day}.tsv"`);
  expect(sent[0].body).toContain(tabbed);

  const ds = page.getByTestId('teach-dataset');
  await expect(ds.getByText(`2 questions from pasted-${day}.tsv. Fix anything marked in red, then see which ones the model already knows.`, { exact: true })).toBeVisible();
  await expect(ds.getByText(`Saved as pasted-${day}.tsv — you can train from it again any time.`, { exact: true })).toBeVisible();
  await expect(page.getByTestId('row-counts')).toHaveText('2 will train · 0 already known · 0 duplicates · 0 need a fix');
  const rows = page.getByTestId('dataset-row');
  await expect(rows).toHaveCount(2);
  // no header was consumed — the first pasted line is data, at line 1
  await expect(rows.nth(0).locator('td.n')).toHaveText('1');
  await expect(rows.nth(0).locator('td.q')).toHaveText('AZ paste question one?');
  await expect(rows.nth(0).locator('td.a')).toHaveText('Answer One');
  await expect(rows.nth(1).locator('td.n')).toHaveText('2');
  await expect(rows.nth(1).locator('td.q')).toHaveText('AZ paste question two?');
  await expect(rows.nth(1).locator('td.a')).toHaveText('Answer Two');

  const json = (await dsJson(request, key, id)).body.dataset;
  expect({ format: json.format, delimiter: json.delimiter, has_header: json.has_header, source: json.source, source_name: json.source_name })
    .toEqual({ format: 'tsv', delimiter: '\t', has_header: false, source: 'upload', source_name: `pasted-${day}.tsv` });

  // …and text with no tabs is uploaded as .txt instead
  const ctx = await browser.newContext({ locale: 'en-US' });
  const p2 = await ctx.newPage();
  const posts2 = await recordPosts(p2);
  await p2.goto(`${NODE}/teach/upload`);
  await p2.getByTestId('paste-table').locator('summary').click();
  await p2.getByTestId('paste-box').fill('Q: AZ pasted plain question?\nA: Plain answer');
  const id2 = await submitAndWait(p2, () => p2.getByTestId('paste-use').click());
  const key2 = (await keyFromPage(p2))!;
  expect((await posts2()).filter((x) => x.status < 400)[0].body).toContain(`filename="pasted-${day}.txt"`);
  const json2 = (await dsJson(request, key2, id2)).body.dataset;
  expect({ format: json2.format, layout: json2.layout, source_name: json2.source_name }).toEqual({ format: 'txt', layout: 'qa', source_name: `pasted-${day}.txt` });
  await ctx.close();

  expect((await teachApi(request, NODE, nodeAddress, key, 'DELETE', `/api/teach/datasets/${id}`)).status).toBe(200);
  expect((await teachApi(request, NODE, nodeAddress, key2, 'DELETE', `/api/teach/datasets/${id2}`)).status).toBe(200);
});

// ---------------------------------------------------------------------------------------------- AZ-128
test('AZ-128 Format help and the three sample datasets: download one, or start from it in one click', async ({ browser, request }) => {
  const EN_FACTS_SHA = 'ed73eb39ab65e1ec19326f731ffd54e44a58dafe3022918395e98fb94c1b2fe4';
  const ctx = await browser.newContext({ locale: 'en-US', acceptDownloads: true });
  const page = await ctx.newPage();
  const posts = await recordPosts(page);
  await page.goto(`${NODE}/teach/upload`);
  const samples = page.getByTestId('samples');
  await expect(samples.locator('span.hint')).toHaveText('A handful of questions in jsonl — open it, replace the text with yours, upload it back.');
  const rows = samples.locator('> div');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('한국어 사실 5개');
  await expect(rows.nth(0)).toContainText('5 questions');
  await expect(rows.nth(1)).toContainText('Five English facts');
  await expect(rows.nth(1)).toContainText('5 questions');
  await expect(rows.nth(2)).toContainText('Mixed Korean and English');
  await expect(rows.nth(2)).toContainText('6 questions');

  // the download is the canonical rows.jsonl, served publicly and cacheable
  const en = rows.nth(1);
  const [download] = await Promise.all([page.waitForEvent('download'), en.getByRole('link', { name: 'Download a sample dataset' }).click()]);
  const saved = join(test.info().outputDir, 'sample-en-facts.jsonl');
  await download.saveAs(saved);
  const bytes = readFileSync(saved);
  expect(sha256Hex(bytes)).toBe(EN_FACTS_SHA);
  expect(bytes[0]).not.toBe(0xef);                              // no BOM
  expect(bytes.toString('utf8').split('\n').filter(Boolean)).toHaveLength(5);
  expect(bytes.toString('utf8').endsWith('\n')).toBe(true);
  expect(bytes.includes(Buffer.from('\r'))).toBe(false);        // LF only
  const head = await request.get(`${NODE}/api/teach/samples/en-facts`);   // no teaching key: this route is public
  expect(head.status()).toBe(200);
  expect(head.headers()['content-type']).toBe('application/x-ndjson; charset=utf-8');
  expect(head.headers()['content-disposition']).toBe('attachment; filename="sample-en-facts.jsonl"');
  expect(head.headers()['cache-control']).toBe('public, max-age=3600');
  const listed = await api<{ samples: { kind: string; sha256: string }[] }>(request, '/api/teach/samples', { node: NODE });
  expect(listed.body.samples.find((s) => s.kind === 'en-facts')!.sha256).toBe(EN_FACTS_SHA);

  // "Start from this sample" is a normal dataset create
  const id = await submitAndWait(page, () => page.getByTestId('sample-en-facts').click());
  const key = (await keyFromPage(page))!;
  expect(JSON.parse((await posts()).filter((x) => x.status < 400)[0].body)).toMatchObject({ source: 'sample', sample: 'en-facts' });

  const ds = page.getByTestId('teach-dataset');
  await expect(ds.getByText('5 questions from a sample dataset. Fix anything marked in red, then see which ones the model already knows.', { exact: true })).toBeVisible();
  await expect(ds.getByText(`Fingerprint ${shortSha(EN_FACTS_SHA)}`, { exact: true })).toBeVisible();
  await expect(ds.getByText('Saved as Five English facts.jsonl — you can train from it again any time.', { exact: true })).toBeVisible();
  await expect(page.getByTestId('row-counts')).toHaveText('5 will train · 0 already known · 0 duplicates · 0 need a fix');
  const table = page.getByTestId('dataset-row');
  await expect(table).toHaveCount(5);
  await expect(table.nth(0).locator('td.q')).toHaveText('Who founded Ainize?');
  await expect(table.nth(0).locator('td.alt')).toHaveText('Which company is behind Ainize?');
  await expect(table.nth(2).locator('td.q')).toHaveText('What does a knowledge patch change?');
  await expect(table.nth(2).locator('td.alt')).toHaveText('What exactly does a patch modify?');
  // a sample has no original bytes to re-read, so it is created `ready`, not `staged`, and offers no reparse
  await expect(page.getByTestId('open-reparse')).toHaveCount(0);
  expect((await dsJson(request, key, id)).body.dataset.status).toBe('ready');

  // re-uploading the downloaded bytes is idempotent: same id, same fingerprint, no second dataset
  await page.goto(`${NODE}/teach/upload`);
  await submitAndWait(page, () => page.setInputFiles('[data-testid=file-input]', saved));
  expect(page.url()).toMatch(new RegExp(`/teach/dataset/${id}$`));
  const reUpload = (await posts()).filter((x) => x.status < 400).at(-1)!;
  expect(reUpload.status, 'a re-upload of the same bytes is not a new dataset').toBe(200);
  expect(JSON.parse(reUpload.reply).created).toBe(false);
  expect(JSON.parse(reUpload.reply).dataset.sha256).toBe(EN_FACTS_SHA);
  const mine = await teachApi<{ items: Dataset[] }>(request, NODE, nodeAddress, key, 'GET', '/api/teach/datasets');
  expect(mine.body.items.filter((d) => !('deleted_at' in d)).length, 'the re-upload did not create a second dataset').toBe(1);

  expect((await teachApi(request, NODE, nodeAddress, key, 'DELETE', `/api/teach/datasets/${id}`)).status).toBe(200);
  await ctx.close();
});

// ---------------------------------------------------------------------------------------------- AZ-129
test('AZ-129 CSV with a header and values containing commas inside quotes', async ({ page, request }) => {
  await page.goto(`${NODE}/teach/upload`);
  const id = await uploadViaUi(page, FX['az-quoted.csv'].path);
  const key = (await keyFromPage(page))!;

  await expect(page.getByTestId('teach-dataset').getByText('2 questions from az-quoted.csv. Fix anything marked in red, then see which ones the model already knows.', { exact: true })).toBeVisible();
  await expect(page.getByTestId('row-counts')).toHaveText('2 will train · 0 already known · 0 duplicates · 0 need a fix');
  const rows = page.getByTestId('dataset-row');
  await expect(rows).toHaveCount(2);
  // the header was consumed, so the first question is the visitor's LINE 2 — and both commas survived the quoting
  await expect(rows.nth(0).locator('td.n')).toHaveText('2');
  await expect(rows.nth(0).locator('td.q')).toHaveText('Which cities, in order, are on the AZ line?');
  await expect(rows.nth(0).locator('td.a')).toHaveText('Seoul, Busan, Daegu');
  await expect(rows.nth(0).locator('td.alt')).toHaveText('');            // the empty quoted cell is empty, not `""`
  await expect(rows.nth(1).locator('td.n')).toHaveText('3');
  await expect(rows.nth(1).locator('td.q')).toHaveText('Who founded Ainize?');
  await expect(rows.nth(1).locator('td.a')).toHaveText('Comcom');
  await expect(rows.nth(1).locator('td.alt')).toHaveText('Which company is behind Ainize?');

  const ds = (await dsJson(request, key, id)).body.dataset;
  expect({ format: ds.format, delimiter: ds.delimiter, has_header: ds.has_header, columns: ds.columns, encoding: ds.encoding, rows: ds.rows, invalid_rows: ds.invalid_rows })
    .toEqual({ format: 'csv', delimiter: ',', has_header: true, columns: { prompt: 0, answer: 1, alt_prompt: 2 }, encoding: 'utf-8', rows: 2, invalid_rows: 0 });
  const page1 = (await dsRows(request, key, id)).body;
  // The scenario says `source_rows 3`, counting the file's three LINES. The node counts data rows: a consumed header
  // is not one of them (az-messy.jsonl, with no header, reports 7 for 7 lines). Both facts are asserted.
  expect(page1.source_rows).toBe(2);
  expect(page1.source_rows + (ds.has_header ? 1 : 0), 'the file itself had three lines').toBe(3);
  expect(page1.summary.accepted).toBe(2);
  expect(page1.summary.not_parsed).toBe(0);
  expect(page1.items[0].line).toBe(2);

  expect((await teachApi(request, NODE, nodeAddress, key, 'DELETE', `/api/teach/datasets/${id}`)).status).toBe(200);
});

// ---------------------------------------------------------------------------------------------- AZ-130
test('AZ-130 Header detection both ways: Korean column names are recognised, a headerless TSV keeps its first line as data', async ({ page, request }) => {
  await page.goto(`${NODE}/teach/upload`);
  const idKo = await uploadViaUi(page, FX['az-korean-header.csv'].path);
  const key = (await keyFromPage(page))!;
  let rows = page.getByTestId('dataset-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator('td.n')).toHaveText('2');            // 질문,정답,다른표현 was a header, never a question
  await expect(rows.nth(0).locator('td.q')).toHaveText('Ainize를 만든 곳은?');
  await expect(rows.nth(0).locator('td.alt')).toHaveText('Ainize는 어느 회사인가요?');
  await expect(rows.nth(1).locator('td.n')).toHaveText('3');
  const ko = (await dsJson(request, key, idKo)).body.dataset;
  expect({ format: ko.format, delimiter: ko.delimiter, has_header: ko.has_header, columns: ko.columns })
    .toEqual({ format: 'csv', delimiter: ',', has_header: true, columns: { prompt: 0, answer: 1, alt_prompt: 2 } });

  await page.goto(`${NODE}/teach/upload`);
  const idNo = await uploadViaUi(page, FX['az-noheader.tsv'].path);
  rows = page.getByTestId('dataset-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator('td.n')).toHaveText('1');            // nothing was eaten as a header
  await expect(rows.nth(0).locator('td.q')).toHaveText('Ainize를 만든 곳은?');
  await expect(rows.nth(1).locator('td.n')).toHaveText('2');
  await expect(page.getByTestId('row-counts')).toHaveText('2 will train · 0 already known · 0 duplicates · 0 need a fix');
  const noh = (await dsJson(request, key, idNo)).body.dataset;
  expect({ format: noh.format, delimiter: noh.delimiter, has_header: noh.has_header, columns: noh.columns })
    .toEqual({ format: 'tsv', delimiter: '\t', has_header: false, columns: { prompt: 0, answer: 1, alt_prompt: 2, note: 3 } });

  // the English aliases (question / completion / paraphrase) map exactly the same way
  await page.goto(`${NODE}/teach/upload`);
  const idAlias = await uploadViaUi(page, FX['az-aliases.csv'].path);
  const alias = (await dsJson(request, key, idAlias)).body.dataset;
  expect({ has_header: alias.has_header, columns: alias.columns }).toEqual({ has_header: true, columns: { prompt: 0, answer: 1, alt_prompt: 2 } });
  await expect(page.getByTestId('dataset-row').nth(0).locator('td.alt')).toHaveText('Which company is behind Ainize?');

  for (const id of [idKo, idNo, idAlias]) expect((await teachApi(request, NODE, nodeAddress, key, 'DELETE', `/api/teach/datasets/${id}`)).status).toBe(200);
});

// ---------------------------------------------------------------------------------------------- AZ-131
test('AZ-131 Plain text: the Q:/A: layout the format help promises', async ({ page, request }) => {
  await page.goto(`${NODE}/teach/upload`);
  // the .txt block printed on the upload page IS the file this parser reads
  const printed = (await page.getByTestId('format-help').locator('pre').nth(3).textContent())!;
  expect(FX['az-qa.txt'].bytes.toString('utf8')).toContain(printed.trim().split('\n').slice(0, 2).join('\n'));

  const id = await uploadViaUi(page, FX['az-qa.txt'].path);
  const key = (await keyFromPage(page))!;
  await expect(page.getByTestId('teach-dataset').getByText('2 questions from az-qa.txt. Fix anything marked in red, then see which ones the model already knows.', { exact: true })).toBeVisible();
  await expect(page.getByTestId('row-counts')).toHaveText('2 will train · 0 already known · 0 duplicates · 0 need a fix');
  const rows = page.getByTestId('dataset-row');
  // the line number is the Q: that opened the pair, blank line counted — so it matches the visitor's editor
  await expect(rows.nth(0).locator('td.n')).toHaveText('1');
  await expect(rows.nth(0).locator('td.q')).toHaveText('Who founded Ainize?');
  await expect(rows.nth(0).locator('td.a')).toHaveText('Comcom');
  await expect(rows.nth(1).locator('td.n')).toHaveText('4');
  await expect(rows.nth(1).locator('td.q')).toHaveText('When did Ainize start?');
  const qa = (await dsJson(request, key, id)).body.dataset;
  expect({ format: qa.format, layout: qa.layout, encoding: qa.encoding }).toEqual({ format: 'txt', layout: 'qa', encoding: 'utf-8' });

  // 질문:/답: open and close a pair exactly like Q:/A:
  await page.goto(`${NODE}/teach/upload`);
  const idKo = await uploadViaUi(page, FX['az-korean-qa.txt'].path);
  const ko = (await dsJson(request, key, idKo)).body.dataset;
  expect({ format: ko.format, layout: ko.layout, rows: ko.rows }).toEqual({ format: 'txt', layout: 'qa', rows: 2 });
  await expect(page.getByTestId('dataset-row').nth(0).locator('td.q')).toHaveText('Ainize를 만든 곳은?');
  await expect(page.getByTestId('dataset-row').nth(0).locator('td.a')).toHaveText('Comcom');

  // an A: with no Q: before it is reported, never silently dropped
  await page.goto(`${NODE}/teach/upload`);
  const idOrphan = await uploadViaUi(page, FX['az-orphan-a.txt'].path);
  await expect(page.getByTestId('dropped')).toContainText('1 line(s) could not be read and were left out.');
  await expect(page.getByTestId('dropped')).toContainText('See the lines that were left out');
  await page.getByTestId('dropped').locator('summary').click();
  await expect(page.getByTestId('dropped').locator('li')).toContainText('Line 1 could not be read as a question and an answer.');
  await expect(page.getByTestId('dropped').locator('code')).toHaveText('A: an answer with no question');
  const dropped = (await dsRows(request, key, idOrphan, '?status=not_parsed')).body;
  expect(dropped.total).toBe(1);
  expect(dropped.items[0]).toMatchObject({ line: 1, status: 'not_parsed', detail: 'an answer line with no question before it' });

  for (const dsId of [id, idKo, idOrphan]) expect((await teachApi(request, NODE, nodeAddress, key, 'DELETE', `/api/teach/datasets/${dsId}`)).status).toBe(200);
});

// ---------------------------------------------------------------------------------------------- AZ-132
/** The node's own per-row report on disk — the only place the parser's `notes` are kept (`buildReportJson`). */
function reportJsonOnDisk(datasetId: string): { notes?: string[]; summary: Record<string, number>; rows: Row[] } {
  const cfg = JSON.parse(readFileSync(join(NODE_HOME, 'config.json'), 'utf8')) as { dataDir: string };
  const p = join(cfg.dataDir, 'teach', 'datasets', datasetId, 'report.json');
  expect(existsSync(p), `report.json for ${datasetId}`).toBe(true);
  return JSON.parse(readFileSync(p, 'utf8'));
}

test('AZ-132 Alpaca and ChatML: the two shapes people already have on disk are read without an export step', async ({ page, request }) => {
  await page.goto(`${NODE}/teach/upload`);
  const idAlpaca = await uploadViaUi(page, FX['az-alpaca.json'].path);
  const key = (await keyFromPage(page))!;
  await expect(page.getByTestId('teach-dataset').getByText('2 questions from az-alpaca.json. Fix anything marked in red, then see which ones the model already knows.', { exact: true })).toBeVisible();
  await expect(page.getByTestId('row-counts')).toHaveText('2 will train · 0 already known · 0 duplicates · 0 need a fix');
  const alpacaRows = page.getByTestId('dataset-row');
  await expect(alpacaRows.nth(0).locator('td.q')).toHaveText('Who founded Ainize?');
  await expect(alpacaRows.nth(0).locator('td.a')).toHaveText('Comcom');
  // instruction + input becomes the QUESTION; the input is never mistaken for the answer
  await expect(alpacaRows.nth(1).locator('td.q')).toHaveText('Name the token AIN blockchain');
  await expect(alpacaRows.nth(1).locator('td.a')).toHaveText('AIN');
  await expect(alpacaRows.nth(1)).toContainText('Will train — tidied up');
  await expect(page.getByTestId('fixed-note')).toHaveText('1 question(s) were tidied up (extra spaces and line breaks removed).');
  const alpaca = (await dsJson(request, key, idAlpaca)).body.dataset;
  expect(alpaca.format).toBe('json');
  expect(alpaca.summary.fixed).toBe(1);
  expect(reportJsonOnDisk(idAlpaca).rows[1].fixes).toContain('whitespace_collapsed');

  await page.goto(`${NODE}/teach/upload`);
  const idChat = await uploadViaUi(page, FX['az-chatml.jsonl'].path);
  await expect(page.getByTestId('teach-dataset').getByText('2 questions from az-chatml.jsonl. Fix anything marked in red, then see which ones the model already knows.', { exact: true })).toBeVisible();
  const chatRows = page.getByTestId('dataset-row');
  await expect(chatRows).toHaveCount(2);
  await expect(chatRows.nth(0).locator('td.n')).toHaveText('1');
  await expect(chatRows.nth(0).locator('td.q')).toHaveText('Who founded Ainize?');
  await expect(chatRows.nth(0).locator('td.a')).toHaveText('Comcom');
  await expect(chatRows.nth(1).locator('td.n')).toHaveText('2');
  await expect(chatRows.nth(1).locator('td.q')).toHaveText('What token does AIN use?');
  await expect(chatRows.nth(1).locator('td.a')).toHaveText('AIN');
  expect((await dsJson(request, key, idChat)).body.dataset.format).toBe('jsonl');
  // the system message is neither trained nor dropped in silence
  expect(reportJsonOnDisk(idChat).notes).toContain('system_messages_ignored');

  // a JSON object with none of the known keys is reported, with its raw text
  await page.goto(`${NODE}/teach/upload`);
  const idUnknown = await uploadViaUi(page, FX['az-unknown-keys.jsonl'].path);
  await page.getByTestId('dropped').locator('summary').click();
  await expect(page.getByTestId('dropped').locator('code')).toHaveText('{"foo":"bar"}');
  const unknown = (await dsRows(request, key, idUnknown, '?status=not_parsed')).body;
  expect(unknown.items[0]).toMatchObject({ line: 1, status: 'not_parsed', detail: 'no question/answer keys in this object', raw: '{"foo":"bar"}' });

  for (const dsId of [idAlpaca, idChat, idUnknown]) expect((await teachApi(request, NODE, nodeAddress, key, 'DELETE', `/api/teach/datasets/${dsId}`)).status).toBe(200);
});

// ---------------------------------------------------------------------------------------------- AZ-133
test('AZ-133 Encodings: UTF-8 BOM + CRLF is silent, EUC-KR/cp949 and UTF-16 are read and SAID so', async ({ page, request }) => {
  const ids: string[] = [];
  const note = page.getByTestId('encoding-note');

  // 1. UTF-8 with a BOM and CRLF endings: read silently, one row per CRLF line, BOM stripped
  await page.goto(`${NODE}/teach/upload`);
  const idBom = await uploadViaUi(page, FX['az-bom-crlf.csv'].path);
  ids.push(idBom);
  const key = (await keyFromPage(page))!;
  let rows = page.getByTestId('dataset-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator('td.n')).toHaveText('2');
  await expect(rows.nth(0).locator('td.q')).toHaveText('Ainize를 만든 곳은?');
  await expect(rows.nth(1).locator('td.n')).toHaveText('3');
  await expect(rows.nth(1).locator('td.q')).toHaveText('AIN 토큰 이름은?');
  await expect(note).toHaveCount(0);
  const bom = (await dsJson(request, key, idBom)).body.dataset;
  expect(bom.encoding).toBe('utf-8');

  // 2. CP949 with a Korean header: correct Hangul AND the node says which encoding it guessed
  await page.goto(`${NODE}/teach/upload`);
  const idEuc = await uploadViaUi(page, FX['az-euckr-alt.csv'].path);
  ids.push(idEuc);
  await expect(page.getByTestId('dataset-row').nth(0).locator('td.q')).toHaveText('픽셀플러스 종목코드는?');
  await expect(note).toHaveText('Read as euc-kr. If the text looks wrong, save the file as UTF-8 and upload it again.');
  expect((await dsJson(request, key, idEuc)).body.dataset.encoding).toBe('euc-kr');

  // 3. UTF-16LE with a BOM
  await page.goto(`${NODE}/teach/upload`);
  const idU16 = await uploadViaUi(page, FX['az-utf16.csv'].path);
  ids.push(idU16);
  await expect(page.getByTestId('dataset-row').nth(0).locator('td.q')).toHaveText('어떤 회사가 Ainize를 만들었나요?');
  await expect(note).toHaveText('Read as utf-16le. If the text looks wrong, save the file as UTF-8 and upload it again.');
  expect((await dsJson(request, key, idU16)).body.dataset.encoding).toBe('utf-16le');

  // 4. …and a FE FF file the same way
  await page.goto(`${NODE}/teach/upload`);
  const idBe = await uploadViaUi(page, FX['az-utf16be.csv'].path);
  ids.push(idBe);
  await expect(page.getByTestId('dataset-row').nth(0).locator('td.q')).toHaveText('Who made the AZ big-endian file?');
  await expect(note).toHaveText('Read as utf-16be. If the text looks wrong, save the file as UTF-8 and upload it again.');
  expect((await dsJson(request, key, idBe)).body.dataset.encoding).toBe('utf-16be');

  // 5. the canonical rows.jsonl is UTF-8, no BOM, LF — so the SAME questions in another encoding are the same dataset
  await page.goto(`${NODE}/teach/upload`);
  await submitAndWait(page, () => page.setInputFiles('[data-testid=file-input]', FX['az-utf16-twin.csv'].path));
  expect(page.url(), 'the UTF-16 twin of az-bom-crlf.csv is the same dataset').toMatch(new RegExp(`/teach/dataset/${idBom}$`));
  const twin = (await dsJson(request, key, idBom)).body.dataset;
  expect(twin.sha256).toBe(bom.sha256);
  expect(twin.source_name).toBe('az-bom-crlf.csv');
  expect(twin.revision).toBe(1);
  const download = await request.fetch(`${NODE}/api/teach/datasets/${idBom}/download`, { headers: { 'x-ngram-auth': authHeaderV2(key, nodeAddress, 'GET', `/api/teach/datasets/${idBom}/download`) } });
  const canonical = Buffer.from(await download.body());
  expect(canonical[0]).not.toBe(0xef);                          // no BOM
  expect(canonical.includes(Buffer.from('\r'))).toBe(false);    // LF only
  expect(canonical.toString('utf8')).toContain('Ainize를 만든 곳은?');
  expect(sha256Hex(canonical)).toBe(bom.sha256);

  // 6. neither valid UTF-8 nor CP949 → latin1, and it says so rather than failing
  await page.goto(`${NODE}/teach/upload`);
  const idLatin = await uploadViaUi(page, FX['az-latin1.csv'].path);
  ids.push(idLatin);
  // latin1 is the decoder's last resort, so this one gets the warning copy, not the neutral "Read as …" note
  await expect(note).toHaveText('This file was not UTF-8 — it was read as latin1. If the questions below look wrong, do not train them: save the file as UTF-8 and upload it again, or name the encoding in "Read it again".');
  await expect(page.getByTestId('dataset-row').nth(0).locator('td.q')).toHaveText('Café question à AZ?');
  expect((await dsJson(request, key, idLatin)).body.dataset.encoding).toBe('latin1');

  for (const id of ids) expect((await teachApi(request, NODE, nodeAddress, key, 'DELETE', `/api/teach/datasets/${id}`)).status).toBe(200);
});

// ---------------------------------------------------------------------------------------------- AZ-134
test('AZ-134 "Wrong columns or separator?" re-reads the bytes the node already has — no re-upload, new revision, new fingerprint', async ({ page, request }) => {
  await page.goto(`${NODE}/teach/upload`);
  const id = await uploadViaUi(page, FX['az-euckr.csv'].path);
  const key = (await keyFromPage(page))!;
  const first = (await dsJson(request, key, id)).body.dataset;
  expect(first.status, 'the reparse button only exists for a staged upload').toBe('staged');
  await expect(page.getByTestId('teach-dataset').getByText(`Fingerprint ${shortSha(first.sha256)}`, { exact: true })).toBeVisible();

  await page.getByTestId('open-reparse').click();
  const sheet = page.getByTestId('reparse-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('heading', { level: 2 })).toHaveText('Wrong columns or separator?');
  await expect(sheet.getByText('Tell this node how to read your file and it will try again. Nothing is re-uploaded.').first()).toBeVisible();
  const optionsOf = (label: string) => sheet.locator('label').filter({ hasText: label }).locator('xpath=following-sibling::select[1]').locator('option').allTextContents();
  expect(await optionsOf('File format')).toEqual(['Decide automatically', 'jsonl', 'json', 'csv', 'tsv', 'txt']);
  expect(await optionsOf('Separator')).toEqual(['Decide automatically', ',', 'tab', ';', '|']);
  expect(await optionsOf('Text encoding')).toEqual(['Decide automatically', 'utf-8', 'euc-kr', 'utf-16le', 'utf-16be', 'latin1']);
  await expect(sheet.getByText('The first line is a header')).toBeVisible();

  // …and it re-reads the bytes the node kept: no multipart, nothing uploaded again
  let reparsePost = 0; let uploadPost = 0;
  page.on('request', (r) => {
    if (r.method() !== 'POST') return;
    if (r.url().endsWith(`/api/teach/datasets/${id}/reparse`)) reparsePost++;
    if (r.url().endsWith('/api/teach/datasets')) uploadPost++;
  });
  await sheet.locator('label').filter({ hasText: 'Text encoding' }).locator('xpath=following-sibling::select[1]').selectOption('latin1');
  await sheet.getByTestId('reparse-go').click();
  await expect(page.getByTestId('reparse-sheet')).toBeHidden();
  await expect(page.getByTestId('encoding-note')).toHaveText('This file was not UTF-8 — it was read as latin1. If the questions below look wrong, do not train them: save the file as UTF-8 and upload it again, or name the encoding in "Read it again".');
  expect(reparsePost).toBe(1);
  expect(uploadPost, 'nothing was re-uploaded').toBe(0);

  const mojibake = page.getByTestId('dataset-row');
  await expect(mojibake.nth(0).locator('td.q')).toHaveText('Ainize¸¦ ¸¸µç °÷Àº?');
  await expect(mojibake.nth(1).locator('td.q')).toHaveText('AIN ÅäÅ« ÀÌ¸§Àº?');
  const second = (await dsJson(request, key, id)).body.dataset;
  expect(second.revision).toBe(first.revision + 1);
  expect(second.sha256, 'the fingerprint follows the bytes the parse now produces').not.toBe(first.sha256);
  await expect(page.getByTestId('teach-dataset').getByText(`Fingerprint ${shortSha(second.sha256)}`, { exact: true })).toBeVisible();
  // nothing measured against the old text survives a new revision
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith('ainize.teach.selection')))).toEqual([]);
  await expect(page.getByTestId('checked-note')).toHaveCount(0);

  // reading it back as euc-kr restores the Hangul AND the original fingerprint
  await page.getByTestId('open-reparse').click();
  await page.getByTestId('reparse-sheet').locator('label').filter({ hasText: 'Text encoding' }).locator('xpath=following-sibling::select[1]').selectOption('euc-kr');
  await page.getByTestId('reparse-go').click();
  await expect(page.getByTestId('reparse-sheet')).toBeHidden();
  await expect(page.getByTestId('dataset-row').nth(0).locator('td.q')).toHaveText('Ainize를 만든 곳은?');
  const third = (await dsJson(request, key, id)).body.dataset;
  expect(third.sha256).toBe(first.sha256);
  expect(third.revision).toBe(3);

  // a reparse that yields nothing usable is refused, and the revision it would have replaced is left intact
  const refused = await teachApi(request, NODE, nodeAddress, key, 'POST', `/api/teach/datasets/${id}/reparse`, { format: 'json', has_header: true });
  expect(refused.status).toBe(400);
  expect(refused.text).toContain('dataset_empty: read that way, the file has no usable questions');
  const after = (await dsJson(request, key, id)).body.dataset;
  expect({ sha256: after.sha256, revision: after.revision, rows: after.rows }).toEqual({ sha256: third.sha256, revision: 3, rows: 2 });

  expect((await teachApi(request, NODE, nodeAddress, key, 'DELETE', `/api/teach/datasets/${id}`)).status).toBe(200);
});

// ---------------------------------------------------------------------------------------------- AZ-135
test('AZ-135 Size cap: a 5.1 MB file is refused in the browser before a byte is uploaded, and the node refuses it independently', async ({ page, request }) => {
  expect(policy.limits.dataset_max_bytes, 'this node advertises a 4 MB ceiling').toBe(4_000_000);
  const huge = FX['az-huge.jsonl'];
  expect(huge.bytes.length).toBeGreaterThan(policy.limits.dataset_max_bytes);
  expect(fileSize(huge.bytes.length)).toBe('5.1 MB');

  let posts = 0;
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/api/teach/datasets')) posts++; });
  await page.goto(`${NODE}/teach/upload`);
  await page.setInputFiles('[data-testid=file-input]', huge.path);
  const err = page.getByTestId('upload-error');
  await expect(err).toHaveText('That file is 5.1 MB, over the 4 MB limit. Split it, or upload fewer questions.');
  await expect(err).toHaveAttribute('role', 'alert');
  expect(posts, 'the guard runs before the file is even read').toBe(0);
  await expect(page.getByTestId('file-chip')).toHaveCount(0);
  expect(page.url()).toMatch(/\/teach\/upload$/);
  // a refused file creates no identity on this node
  expect(await page.evaluate(() => localStorage.getItem('ainize.teacher.key'))).toBeNull();

  // …and the node refuses the same bytes on its own, before multer writes anything
  const key = newTeachKey();
  const direct = await uploadDataset(request, NODE, nodeAddress, key, 'az-huge.jsonl', huge.bytes);
  expect(direct.status).toBe(413);
  expect(direct.text).toContain('dataset_too_large: this node accepts files up to 4 MB');
  expect(direct.body.max_bytes).toBe(policy.limits.dataset_max_bytes);
  // `bytes` is the request's content-length, not the file's: the gate runs BEFORE multer, so the file size is not yet
  // knowable — which is the whole point of refusing there.
  expect(direct.body.bytes).toBeGreaterThanOrEqual(huge.bytes.length);
  expect(direct.body.bytes).toBeLessThan(huge.bytes.length + 4096);
  expect(existsSync(join(JSON.parse(readFileSync(join(NODE_HOME, 'config.json'), 'utf8')).dataDir, 'teach', 'incoming', 'az-huge.jsonl'))).toBe(false);

  // a file whose declared sha256 does not match what arrived is refused too
  const small = FX['az-small.jsonl'];
  const wrong = await uploadDataset(request, NODE, nodeAddress, key, 'az-small.jsonl', small.bytes, { declaredSha: 'f'.repeat(64) });
  expect(wrong.status).toBe(400);
  expect(wrong.text).toContain('dataset_hash: the file changed while it was being uploaded — try again');

  // …and the web maps that code to its own sentence
  await page.route('**/api/teach/datasets', (r) => r.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'dataset_hash: the file changed while it was being uploaded — try again' }) }));
  await page.setInputFiles('[data-testid=file-input]', small.path);
  await expect(page.getByTestId('upload-error')).toHaveText('The file changed while it was being uploaded. Try again.');
  expect(page.url()).toMatch(/\/teach\/upload$/);
});

// ---------------------------------------------------------------------------------------------- AZ-136
test('AZ-136 Row caps: the "Choose which 200" lesson banner, and the over-2000 dataset note that says nothing was hidden', async ({ page, request }) => {
  const perLesson = policy.limits.rows_per_job;
  const perDataset = policy.limits.dataset_max_rows;
  expect({ perLesson, perDataset }, 'node-u caps a lesson at 200 questions and a dataset at 2000').toEqual({ perLesson: 200, perDataset: 2000 });

  // ---- 250 questions: the DATASET keeps all of them, one LESSON takes the first 200
  await page.goto(`${NODE}/teach/upload`);
  const id250 = await uploadViaUi(page, FX['az-big250.jsonl'].path);
  const key = (await keyFromPage(page))!;
  await expect(page.getByTestId('row-counts')).toHaveText('250 will train · 0 already known · 0 duplicates · 0 need a fix');
  await expect(page.getByTestId('over-cap-note')).toHaveCount(0);
  const banner = page.getByTestId('cap-banner');
  await expect(banner).toContainText('This node teaches up to 200 questions in one lesson. The first 200 are selected; the rest stay in your dataset for the next lesson.');
  await expect(page.getByTestId('cap-pick')).toHaveText('Choose which 200');
  // the report is read paginated, never inlined
  await expect(page.getByText('1–50 of 250', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Previous' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Next' })).toBeEnabled();
  await expect(page.getByTestId('dataset-row')).toHaveCount(50);

  await page.getByTestId('cap-pick').click();
  const boxes = page.getByTestId('dataset-row').locator('input[type=checkbox]');
  await expect(boxes).toHaveCount(50);
  await expect(page.getByTestId('cap-selected')).toHaveText('· 0 of 200 selected');
  for (let i = 0; i < 3; i++) await boxes.nth(i).check();
  await expect(page.getByTestId('cap-selected')).toHaveText('· 3 of 200 selected');

  // fill the selection to the cap across pages, then prove the 201st tick is ignored
  for (let i = 3; i < 50; i++) await boxes.nth(i).check();
  for (let p = 1; p < 4; p++) {
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByText(`${p * 50 + 1}–${p * 50 + 50} of 250`, { exact: true })).toBeVisible();
    for (let i = 0; i < 50; i++) await page.getByTestId('dataset-row').locator('input[type=checkbox]').nth(i).check();
  }
  await expect(page.getByTestId('cap-selected')).toHaveText('· 200 of 200 selected');
  await page.getByRole('button', { name: 'Next' }).click();
  const extra = page.getByTestId('dataset-row').locator('input[type=checkbox]').first();
  await extra.click();
  await expect(extra, 'the 201st tick is ignored — the set stops at the cap').not.toBeChecked();
  await expect(page.getByTestId('cap-selected')).toHaveText('· 200 of 200 selected');

  await page.getByTestId('to-settings').click();
  await page.waitForURL(new RegExp(`/teach/dataset/${id250}/settings$`));
  const selection = await page.evaluate((dsId) => sessionStorage.getItem(`ainize.teach.selection.${dsId}`), id250);
  expect(JSON.parse(selection!)).toHaveLength(200);

  // ---- 2005 questions: 2000 are loaded, the 5 that were not are reported, not hidden
  await page.goto(`${NODE}/teach/upload`);
  const id2005 = await uploadViaUi(page, FX['az-big2005.jsonl'].path);
  await expect(page.getByTestId('row-counts')).toHaveText('2000 will train · 0 already known · 0 duplicates · 0 need a fix');
  await expect(page.getByTestId('over-cap-note')).toHaveText('That file has 2005 questions; this node accepts up to 2000 in one dataset. The first 2000 were loaded.');
  // both caps are true at once and neither replaces the other
  await expect(page.getByTestId('cap-banner')).toContainText('This node teaches up to 200 questions in one lesson.');

  const big = (await dsJson(request, key, id2005)).body.dataset;
  expect({ rows: big.rows, invalid_rows: big.invalid_rows, over_cap: big.summary.over_cap, accepted: big.summary.accepted })
    .toEqual({ rows: 2000, invalid_rows: 5, over_cap: 5, accepted: 2000 });
  const over = (await dsRows(request, key, id2005, '?status=over_cap')).body;
  expect(over.total).toBe(5);
  expect(over.items.map((r) => r.line)).toEqual([2001, 2002, 2003, 2004, 2005]);
  for (const r of over.items) expect(r.detail).toBe('this node keeps up to 2000 questions in one dataset');
  // an over-the-limit line is never sold as something to fix
  const counts = await page.getByTestId('row-counts').textContent();
  expect(counts).toContain('0 need a fix');

  // …and they are reachable in the web table only by paging to the end (50 rows a page, no status filter)
  await page.goto(`${NODE}/teach/dataset/${id2005}?`);
  await expect(page.getByText('1–50 of 2005', { exact: true })).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  for (let p = 0; p < 40; p++) await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByText('2001–2005 of 2005', { exact: true })).toBeVisible();
  const tail = page.getByTestId('dataset-row');
  await expect(tail).toHaveCount(5);
  await expect(tail.nth(0).locator('td.n')).toHaveText('2001');
  await expect(tail.nth(0)).toContainText("Over this node's dataset limit — not loaded");

  for (const id of [id250, id2005]) expect((await teachApi(request, NODE, nodeAddress, key, 'DELETE', `/api/teach/datasets/${id}`)).status).toBe(200);
});

// ---------------------------------------------------------------------------------------------- AZ-137
test('AZ-137 Nothing usable in the file: 0 bytes, binary rubbish, a wrong file type, and a header with no data rows', async ({ browser, request }) => {
  const cases: { file: string; expect: string; clientSide?: boolean }[] = [
    { file: 'az-pic.png', expect: 'This node reads jsonl, csv, tsv and plain text. "az-pic.png" is none of those.', clientSide: true },
    { file: 'az-empty.csv', expect: 'This node could not read that file as a dataset. See the format examples.' },
    // item 15: the browser looks at the BYTES before it creates a key or spends a quota, so a renamed blob is refused
    // here now — with the sentence that says what is actually wrong with it — instead of reaching the node.
    { file: 'az-blob.txt', expect: '"az-blob.txt" looks like a binary file, not text. If it is a spreadsheet, export it as CSV and upload that file instead.', clientSide: true },
    // TODAY the header-only file takes the dataset_format sentence: its single line is consumed as a header, so the
    // report ends up empty and the node cannot tell "read but no rows" from "not read at all".
    { file: 'az-headeronly.csv', expect: 'This node could not read that file as a dataset. See the format examples.' },
  ];
  for (const c of cases) {
    const ctx = await browser.newContext({ locale: 'en-US' });
    const page = await ctx.newPage();
    const errors = collectConsoleErrors(page);
    let posts = 0;
    page.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/api/teach/datasets')) posts++; });
    await page.goto(`${NODE}/teach/upload`);
    const alert = page.getByTestId('upload-error');
    for (let attempt = 0; ; attempt++) {
      if (!c.clientSide) await paceCreate();
      posts = 0;
      await page.setInputFiles('[data-testid=file-input]', FX[c.file].path);
      await expect(alert, `${c.file} was refused with a sentence`).toBeVisible();
      const said = await alert.textContent();
      if (said !== null && NEIGHBOUR.includes(said) && attempt < 4) {   // the neighbour's node, not this file
        test.setTimeout(test.info().timeout + 140_000);
        if (said === NEIGHBOUR[1]) await waitForNode(request, NODE); else await backOff();
        await page.reload();
        continue;
      }
      break;
    }
    await expect(alert, `${c.file} says what to do`).toHaveText(c.expect);
    await expect(alert).toHaveAttribute('role', 'alert');
    expect(posts, `${c.file}: ${c.clientSide ? 'refused before any request' : 'one request, refused by the node'}`).toBe(c.clientSide ? 0 : 1);
    expect(page.url(), `${c.file} leaves the visitor on step 1`).toMatch(/\/teach\/upload$/);

    // nothing was stored: no dataset for this browser's key, and My datasets is still empty
    const key = await keyFromPage(page);
    if (c.clientSide) expect(key, 'a file the browser itself refuses creates no teaching key').toBeNull();
    else {
      expect(key).not.toBeNull();
      const mine = await teachApi<{ items: Dataset[] }>(request, NODE, nodeAddress, key!, 'GET', '/api/teach/datasets');
      expect(mine.status).toBe(200);
      expect(mine.body.items).toEqual([]);
    }
    await page.goto(`${NODE}/teach/mine`);
    await expect(page.getByTestId('mine-empty')).toHaveText('Nothing here yet. Teach in a conversation, or upload a dataset file to start.');
    expect(errors, `${c.file} logged no page error`).toEqual([]);
    await ctx.close();
  }
});

// ---------------------------------------------------------------------------------------------- AZ-138
test('AZ-138 A file that is all duplicates: one question kept, every later copy shown with the line it repeats', async ({ page, browser, request }) => {
  await page.goto(`${NODE}/teach/upload`);
  const id = await uploadViaUi(page, FX['az-dupes.jsonl'].path);
  const key = (await keyFromPage(page))!;

  await expect(page.getByTestId('teach-dataset').getByText('1 questions from az-dupes.jsonl. Fix anything marked in red, then see which ones the model already knows.', { exact: true })).toBeVisible();
  await expect(page.getByTestId('row-counts')).toHaveText('1 will train · 0 already known · 4 duplicates · 0 need a fix');
  const rows = page.getByTestId('dataset-row');
  await expect(rows).toHaveCount(5);
  await expect(rows.nth(0)).toContainText('Will train');
  await expect(rows.nth(0)).toContainText('Not checked yet');
  await expect(rows.nth(0).getByTestId('row-remove')).toBeVisible();
  for (let i = 1; i < 5; i++) {
    await expect(rows.nth(i).locator('td.n')).toHaveText(String(i + 1));
    await expect(rows.nth(i)).toContainText('Same as line 1 — skipped');
    await expect(rows.nth(i).getByTestId('row-edit')).toBeVisible();
    await expect(rows.nth(i).getByTestId('row-remove'), 'a skipped copy has no dataset index to remove').toHaveCount(0);
  }
  // a dataset of one question is a legal dataset
  await expect(page.getByTestId('to-settings')).toBeEnabled();

  const ds = (await dsJson(request, key, id)).body.dataset;
  expect({ rows: ds.rows, invalid_rows: ds.invalid_rows, accepted: ds.summary.accepted, duplicates: ds.summary.duplicates, rejected: ds.summary.rejected, source_rows: ds.summary.source_rows })
    .toEqual({ rows: 1, invalid_rows: 4, accepted: 1, duplicates: 4, rejected: 4, source_rows: 5 });
  const dupes = (await dsRows(request, key, id, '?status=duplicate')).body;
  expect(dupes.total).toBe(4);
  for (const r of dupes.items) expect(r.detail).toBe('the same question and answer as line 1');

  // two duplicate PAIRS: each later copy names the line it repeats, and only the kept lines reach rows.jsonl
  await page.goto(`${NODE}/teach/upload`);
  const idPairs = await uploadViaUi(page, FX['az-dupes2.jsonl'].path);
  await expect(page.getByTestId('row-counts')).toHaveText('2 will train · 0 already known · 2 duplicates · 0 need a fix');
  const pairRows = page.getByTestId('dataset-row');
  await expect(pairRows.nth(1)).toContainText('Same as line 1 — skipped');
  await expect(pairRows.nth(3)).toContainText('Same as line 3 — skipped');
  const pairsPath = `/api/teach/datasets/${idPairs}/download`;
  const dl = await request.fetch(`${NODE}${pairsPath}`, { headers: { 'x-ngram-auth': authHeaderV2(key, nodeAddress, 'GET', pairsPath) } });
  const saved = Buffer.from(await dl.body()).toString('utf8').trim().split('\n');
  expect(saved.map((l) => JSON.parse(l).prompt), 'the canonical file holds only what trains').toEqual(['AZ pair one?', 'AZ pair two?']);

  // duplicates are decided on the NORMALISED text, so trailing spaces still collapse to one question
  await page.goto(`${NODE}/teach/upload`);
  const idSpaces = await uploadViaUi(page, FX['az-dupes-spaces.jsonl'].path);
  await expect(page.getByTestId('row-counts')).toHaveText('1 will train · 0 already known · 1 duplicates · 0 need a fix');

  // …and the same prompt with DIFFERENT answers is not a duplicate at all: it is a conflict, with a way out
  const ctx = await browser.newContext({ locale: 'en-US' });
  const p2 = await ctx.newPage();
  await p2.goto(`${NODE}/teach/upload`);
  const idConflict = await submitAndWait(p2, () => p2.setInputFiles('[data-testid=file-input]', FX['az-dupes-conflict.jsonl'].path));
  const key2 = (await keyFromPage(p2))!;
  await expect(p2.getByTestId('row-counts')).toHaveText('1 will train · 0 already known · 0 duplicates · 5 need a fix');
  const conflictRows = p2.getByTestId('dataset-row');
  for (let i = 0; i < 5; i++) {
    await expect(conflictRows.nth(i)).toContainText('Two answers for this question — pick one');
    await expect(conflictRows.nth(i)).toHaveAttribute('data-bad', '1');
    await expect(conflictRows.nth(i).getByTestId('row-keep')).toHaveText('Keep this answer');
  }
  expect((await dsRows(request, key2, idConflict, '?status=duplicate')).body.total, 'contradictions are never deduplicated away').toBe(0);
  expect((await dsRows(request, key2, idConflict, '?status=conflict')).body.total).toBe(5);
  await ctx.close();

  for (const dsId of [id, idPairs, idSpaces]) expect((await teachApi(request, NODE, nodeAddress, key, 'DELETE', `/api/teach/datasets/${dsId}`)).status).toBe(200);
  expect((await teachApi(request, NODE, nodeAddress, key2, 'DELETE', `/api/teach/datasets/${idConflict}`)).status).toBe(200);
});

// ---------------------------------------------------------------------------------------------- AZ-139
test('AZ-139 A messy real-world file: contradictions, over-length, a missing answer, an unreadable line — all counted, none hidden', async ({ page, request }) => {
  await page.goto(`${NODE}/teach/upload`);
  const id = await uploadViaUi(page, FX['az-messy.jsonl'].path);
  const key = (await keyFromPage(page))!;

  // the arithmetic: 6 = 2 conflicts + 2 too_long + 1 empty + 1 not_parsed
  await expect(page.getByTestId('row-counts')).toHaveText('1 will train · 0 already known · 0 duplicates · 6 need a fix');
  await expect(page.getByTestId('fixed-note')).toHaveText('1 question(s) were tidied up (extra spaces and line breaks removed).');

  const rows = page.getByTestId('dataset-row');
  await expect(rows, 'the unreadable line is not in the table').toHaveCount(6);
  await expect(rows.nth(0)).toContainText('Two answers for this question — pick one');
  await expect(rows.nth(0)).toContainText('Lines 1 and 2 ask the same question but give different answers. The model can only learn one.');
  await expect(rows.nth(0).getByTestId('row-keep')).toHaveText('Keep this answer');
  await expect(rows.nth(1)).toContainText('Lines 2 and 1 ask the same question but give different answers. The model can only learn one.');
  await expect(rows.nth(1).getByTestId('row-keep')).toHaveText('Keep this answer');
  await expect(rows.nth(2)).toContainText('The answer is 205 characters; keep it under 200. Teach a long explanation as several short facts.');
  await expect(rows.nth(3)).toContainText('The question is 405 characters; keep it under 400.');
  await expect(rows.nth(4)).toContainText('No answer — type the right answer');
  await expect(rows.nth(4).locator('td.a')).toHaveText('—');
  await expect(rows.nth(5).locator('td.n')).toHaveText('7');
  await expect(rows.nth(5).locator('td.q')).toHaveText('Spaced question here?');
  await expect(rows.nth(5).locator('td.a')).toHaveText('tidy me');
  await expect(rows.nth(5)).toContainText('Will train — tidied up');

  const dropped = page.getByTestId('dropped');
  await expect(dropped).toContainText('1 line(s) could not be read and were left out.');
  await dropped.locator('summary').click();
  await expect(dropped.locator('li')).toContainText('Line 6 could not be read as a question and an answer.');
  await expect(dropped.locator('code')).toHaveText('not json at all');

  // every source row is in exactly one bucket, and the buckets add back up to the 7 lines of the file
  const report = (await dsRows(request, key, id)).body;
  const s = report.summary;
  expect(s.source_rows).toBe(7);
  expect(s.accepted + s.duplicates + s.conflicts + s.too_long + s.empty + s.blocked + s.not_parsed + s.over_cap).toBe(7);
  expect({ accepted: s.accepted, fixed: s.fixed, conflicts: s.conflicts, too_long: s.too_long, empty: s.empty, not_parsed: s.not_parsed, duplicates: s.duplicates })
    .toEqual({ accepted: 1, fixed: 1, conflicts: 2, too_long: 2, empty: 1, not_parsed: 1, duplicates: 0 });
  expect(report.items.map((r) => `${r.line}:${r.status}`)).toEqual(['1:conflict', '2:conflict', '3:too_long', '4:too_long', '5:empty', '6:not_parsed', '7:fixed']);
  expect(policy.limits.answer_max).toBe(200);
  expect(policy.limits.prompt_max).toBe(400);

  // the pills come from the machine-readable status, not from the server's English sentence
  await page.getByRole('button', { name: 'language' }).click();
  await expect(page.getByTestId('row-counts')).toHaveText('학습 1개 · 이미 알고 있음 0개 · 중복 0개 · 고칠 것 6개');
  await expect(page.getByTestId('dataset-row').nth(0)).toContainText('이 질문에 정답이 둘입니다 — 하나를 고르세요');
  const koStatuses = (await dsRows(request, key, id)).body.items.map((r) => r.status);
  expect(koStatuses, 'only the words changed').toEqual(['conflict', 'conflict', 'too_long', 'too_long', 'empty', 'not_parsed', 'fixed']);

  expect((await teachApi(request, NODE, nodeAddress, key, 'DELETE', `/api/teach/datasets/${id}`)).status).toBe(200);
});

// ---------------------------------------------------------------------------------------------- AZ-140
test('AZ-140 Privacy notice and retention: "Delete my file as soon as training finishes" is offered before the upload and honoured in the record', async ({ page, browser, request }) => {
  const ttl = policy.limits.dataset_ttl_days;
  expect(ttl).toBe(7);

  // the warning is on first paint, before a file is chosen, and above the format help
  await page.goto(`${NODE}/teach/upload`);
  const privacy = page.getByTestId('privacy');
  await expect(privacy).toBeVisible();
  await expect(page.getByTestId('privacy-text')).toHaveText('Your file is stored on this node while it trains, and the node operator can see it. Do not upload personal data or anything you are not allowed to share.');
  expect(await privacy.evaluate((el) => getComputedStyle(el).backgroundColor), 'a standing warning, not a neutral note').toBe('rgb(255, 243, 224)');
  await expect(page.getByTestId('file-chip')).toHaveCount(0);
  expect(await page.evaluate(() => {
    const p = document.querySelector('[data-testid=privacy]')!;
    const help = document.querySelector('[data-testid=format-help]')!;
    return !!(p.compareDocumentPosition(help) & Node.DOCUMENT_POSITION_FOLLOWING);
  })).toBe(true);
  // Finding 45 — the retention choice governs the upload, so it has to come BEFORE the control that uploads
  expect(await page.evaluate(() => {
    const r = document.querySelector('[data-testid=retention]')!;
    const zone = document.querySelector('[data-testid=drop-zone]')!;
    return !!(r.compareDocumentPosition(zone) & Node.DOCUMENT_POSITION_FOLLOWING);
  }), 'the retention checkbox is above the drop zone').toBe(true);
  await expect(page.getByTestId('retention')).not.toBeChecked();

  const posts = await recordPosts(page);
  await page.reload();
  const idKeep = await uploadViaUi(page, FX['az-keep.jsonl'].path);
  const key = (await keyFromPage(page))!;
  expect((await posts())[0].body).toContain('name="retention"\r\n\r\nkeep');
  const keep = (await dsJson(request, key, idKeep)).body.dataset;
  expect(keep.retention).toBe('keep');
  expect(keep.expires_at! - keep.created_at).toBe(ttl * 86_400_000);

  // ticking the box FIRST changes what is sent
  const ctx = await browser.newContext({ locale: 'en-US' });
  const p2 = await ctx.newPage();
  const posts2 = await recordPosts(p2);
  await p2.goto(`${NODE}/teach/upload`);
  const box = p2.getByTestId('retention');
  await expect(box.locator('xpath=..')).toHaveText('Delete my file as soon as training finishes');
  await box.check();
  const idDrop = await submitAndWait(p2, () => p2.setInputFiles('[data-testid=file-input]', FX['az-drop.jsonl'].path));
  const key2 = (await keyFromPage(p2))!;
  expect((await posts2())[0].body).toContain('name="retention"\r\n\r\ndelete_after_training');
  expect((await dsJson(request, key2, idDrop)).body.dataset.retention).toBe('delete_after_training');

  // My datasets says which of the two it is
  await page.goto(`${NODE}/teach/mine`);
  await expect(page.getByTestId('dataset-card')).toContainText(/Kept on this node until /);
  await expect(page.getByText(`Datasets you have not trained are deleted after ${ttl} days.`, { exact: true })).toBeVisible();
  await p2.goto(`${NODE}/teach/mine`);
  await expect(p2.getByTestId('dataset-card')).toContainText('Deleted as soon as training finishes.');

  // the original really is on the operator's disk — which is what the privacy sentence warns about
  const dataDir = (JSON.parse(readFileSync(join(NODE_HOME, 'config.json'), 'utf8')) as { dataDir: string }).dataDir;
  const dir = join(dataDir, 'teach', 'datasets', idKeep);
  expect(statSync(dir).mode & 0o777, 'dataset directory mode').toBe(0o700);
  for (const f of ['rows.jsonl', 'report.json', 'source.jsonl']) {
    expect(existsSync(join(dir, f)), `${f} on disk`).toBe(true);
    expect(statSync(join(dir, f)).mode & 0o777, `${f} mode`).toBe(0o600);
  }
  expect(readFileSync(join(dir, 'source.jsonl')).equals(FX['az-keep.jsonl'].bytes)).toBe(true);
  const moderation = await api<{ items: { id: string }[] }>(request, '/api/me/teach/datasets?limit=1000', { node: NODE, token: opToken });
  expect(moderation.body.items.map((d) => d.id)).toContain(idKeep);

  // …but no question or answer text ever reaches the public event log
  const events = await api<{ events: { message: string }[] }>(request, '/api/events?limit=100', { node: NODE });
  const mine = events.body.events.filter((e) => e.message.includes(idKeep) || e.message.includes(idDrop));
  expect(mine.length).toBeGreaterThan(0);
  for (const e of mine) {
    expect(e.message).not.toContain('AZ keep question one?');
    expect(e.message).not.toContain('AZ drop question one?');
    expect(e.message).toMatch(/dataset [0-9a-f-]{36} created \(upload, 3 question\(s\), 0 not used, jsonl\/utf-8\)/);
  }

  await ctx.close();
  expect((await teachApi(request, NODE, nodeAddress, key, 'DELETE', `/api/teach/datasets/${idKeep}`)).status).toBe(200);
  expect((await teachApi(request, NODE, nodeAddress, key2, 'DELETE', `/api/teach/datasets/${idDrop}`)).status).toBe(200);
});

// ---------------------------------------------------------------------------------------------- AZ-141
test('AZ-141 A visitor with no teaching key: nothing is owned, nothing is 401-ing in their face, and the key is created at the exact moment it is needed', async ({ page, browser, request }) => {
  const seen: { url: string; status: number }[] = [];
  page.on('response', (r) => seen.push({ url: new URL(r.url()).pathname + new URL(r.url()).search, status: r.status() }));

  await page.goto(`${NODE}/teach`);
  await expect(page.getByTestId('teach-entry')).toBeVisible();
  await expect(page.getByTestId('door-file')).toBeEnabled();
  await page.goto(`${NODE}/teach/upload`);
  await expect(page.getByTestId('drop-zone')).toBeVisible();
  await expect(page.getByTestId('format-help')).toBeVisible();
  await expect(page.getByTestId('samples').locator('> div')).toHaveCount(3);
  await expect(page.getByTestId('key-note')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('ainize.teacher.key'))).toBeNull();

  const before = seen.length;
  await page.goto(`${NODE}/teach/mine`);
  await expect(page.getByTestId('mine-empty')).toHaveText('Nothing here yet. Teach in a conversation, or upload a dataset file to start.');
  await sleep(1000);
  const onMine = seen.slice(before);
  expect(onMine.filter((r) => r.url.startsWith('/api/teach/datasets')), 'a stranger never even asks for datasets').toEqual([]);
  expect(seen.filter((r) => r.status === 401), 'and nothing 401s in their face').toEqual([]);

  // the API is honest about the same thing without a browser
  const pol = await request.get(`${NODE}/api/teach/policy`);
  expect(pol.status()).toBe(200);
  expect(pol.headers()['cache-control']).toBe('public, max-age=10');
  expect((await request.get(`${NODE}/api/teach/samples`)).status()).toBe(200);
  const sample = await request.get(`${NODE}/api/teach/samples/en-facts`);
  expect(sample.status()).toBe(200);
  expect(sample.headers()['content-disposition']).toBe('attachment; filename="sample-en-facts.jsonl"');
  const unsignedGet = await request.get(`${NODE}/api/teach/datasets`);
  expect(unsignedGet.status()).toBe(401);
  expect(await unsignedGet.text()).toContain('invalid_signature: x-ngram-auth header missing, expired, replayed or invalid');
  const unsignedPost = await request.post(`${NODE}/api/teach/datasets`, { data: { source: 'sample', sample: 'en-facts' } });
  expect(unsignedPost.status()).toBe(401);
  expect(await unsignedPost.text()).toContain('invalid_signature');

  // the first upload creates the key inline — no modal, no interruption
  await page.goto(`${NODE}/teach/upload`);
  const id = await uploadViaUi(page, FX['az-nokey.jsonl'].path);
  const key = (await keyFromPage(page))!;
  await page.goto(`${NODE}/teach/upload`);
  const short = `${key.address.slice(0, 6)}…${key.address.slice(-4)}`;
  await expect(page.getByTestId('key-note')).toContainText(`Your dataset was signed with this browser's teaching key (${short}). Lose the key and you lose access to your datasets and lessons — back it up.`);
  await expect(page.getByTestId('key-note').getByRole('link', { name: 'Back up the key' })).toHaveAttribute('href', '/chat?mine=1');
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual(expect.arrayContaining(['ainize.teacher.key', 'ainize.teach.datasets']));

  // a refused file creates no key at all
  const ctx = await browser.newContext({ locale: 'en-US' });
  const p2 = await ctx.newPage();
  await p2.goto(`${NODE}/teach/upload`);
  await p2.setInputFiles('[data-testid=file-input]', FX['az-pic.png'].path);
  await expect(p2.getByTestId('upload-error')).toBeVisible();
  await p2.setInputFiles('[data-testid=file-input]', FX['az-huge.jsonl'].path);
  await expect(p2.getByTestId('upload-error')).toContainText('over the 4 MB limit');
  expect(await p2.evaluate(() => localStorage.getItem('ainize.teacher.key'))).toBeNull();
  await ctx.close();

  // a third, keyless browser is not even told the dataset exists
  const ctx3 = await browser.newContext({ locale: 'en-US' });
  const p3 = await ctx3.newPage();
  await p3.goto(`${NODE}/teach/dataset/${id}`);
  await expect(p3.getByTestId('teach-dataset').getByRole('alert')).toHaveText('That dataset is no longer on this node. Upload it again — you can also download it from My datasets.');
  const stranger = await request.get(`${NODE}/api/teach/datasets/${id}`);
  expect(stranger.status()).toBe(404);
  expect(await stranger.text()).toContain('dataset_not_found: no such dataset on this node');
  await ctx3.close();

  expect((await teachApi(request, NODE, nodeAddress, key, 'DELETE', `/api/teach/datasets/${id}`)).status).toBe(200);
});

// ---------------------------------------------------------------------------------------------- AZ-142
test('AZ-142 한국어 toggle: the file door, the format examples and the error copy all switch, and the pipeline does not', async ({ page, request }) => {
  await page.goto(`${NODE}/teach/upload`);
  const toggle = page.getByRole('button', { name: 'language' });
  await expect(toggle).toHaveText('한국어');
  await toggle.click();
  expect(await page.evaluate(() => localStorage.getItem('ainize.locale'))).toBe('ko');

  await expect(page.getByTestId('teach-stepper')).toHaveAttribute('aria-label', '1/5단계 · 데이터셋');
  await expect(page.getByTestId('teach-upload').getByRole('heading', { level: 1 })).toHaveText('데이터셋 올리기');
  await expect(page.getByText('한 줄에 질문 하나, 정답 하나. 적어 준 그대로 모델이 배웁니다.', { exact: true })).toBeVisible();
  const zone = page.getByTestId('drop-zone');
  await expect(zone).toHaveAttribute('aria-label', '여기에 파일을 놓으세요');
  await expect(zone.getByText('또는', { exact: true })).toBeVisible();
  await expect(zone.getByText('jsonl, csv, tsv, txt · 최대 4 MB', { exact: true })).toBeVisible();
  await expect(page.getByTestId('paste-table').locator('summary')).toHaveText('표를 붙여넣기');
  await expect(page.getByTestId('retention').locator('xpath=..')).toHaveText('학습이 끝나면 내 파일 삭제하기');
  await expect(page.getByTestId('privacy-text')).toHaveText('학습하는 동안 파일이 이 노드에 저장되고 노드 운영자가 볼 수 있습니다. 개인정보나 공유할 수 없는 내용은 올리지 마세요.');

  // the EXAMPLES themselves switch language; the box headings and the file extensions do not
  const help = page.getByTestId('format-help');
  await expect(help.locator('h4')).toHaveText(['.jsonl', '.csv', '.tsv', '.txt']);
  expect(JSON.parse((await help.locator('pre').first().textContent())!.split('\n')[0]))
    .toEqual({ prompt: 'Ainize를 만든 곳은?', answer: 'Comcom', alt_prompt: 'Ainize는 어느 회사가 만들었나요?' });
  expect(await help.locator('pre').nth(3).textContent()).toContain('Q: Ainize를 만든 곳은?');
  expect(await help.locator('pre').nth(3).textContent()).toContain('A: Comcom');
  await expect(help.locator('p').last()).toHaveText('다른 이름도 됩니다: 질문은 question / q / 질문, 정답은 completion / output / a / 정답, 다른 표현은 alt / paraphrase / 다른표현.');
  const samples = page.getByTestId('samples');
  await expect(samples.locator('> div').nth(1)).toContainText('질문 5개');
  await expect(samples.getByRole('link', { name: '예시 데이터셋 내려받기' }).first()).toBeVisible();
  await expect(page.getByTestId('sample-en-facts')).toHaveText('이 예시로 시작하기');

  // a client-side refusal in Korean
  await page.setInputFiles('[data-testid=file-input]', FX['az-pic.png'].path);
  await expect(page.getByTestId('upload-error')).toHaveText('이 노드는 jsonl, csv, tsv, 일반 텍스트를 읽습니다. "az-pic.png"은(는) 해당하지 않습니다.');

  // the choice survives a reload
  await page.reload();
  await expect(page.getByRole('button', { name: 'language' })).toHaveText('English');
  await expect(page.getByTestId('teach-upload').getByRole('heading', { level: 1 })).toHaveText('데이터셋 올리기');

  // …and the preview says the same things about the same file
  const id = await uploadViaUi(page, FX['az-messy.jsonl'].path);
  const key = (await keyFromPage(page))!;
  await expect(page.getByTestId('row-counts')).toHaveText('학습 1개 · 이미 알고 있음 0개 · 중복 0개 · 고칠 것 6개');
  const rows = page.getByTestId('dataset-row');
  await expect(rows.nth(0)).toContainText('이 질문에 정답이 둘입니다 — 하나를 고르세요');
  await expect(rows.nth(4)).toContainText('정답 없음 — 정답을 적어 주세요');
  await expect(rows.nth(5)).toContainText('학습합니다 — 다듬음');

  const ko = (await dsJson(request, key, id)).body.dataset;
  await page.getByRole('button', { name: 'language' }).click();
  await expect(page.getByRole('button', { name: 'language' })).toHaveText('한국어');
  await expect(page.getByTestId('row-counts')).toHaveText('1 will train · 0 already known · 0 duplicates · 6 need a fix');
  const en = (await dsJson(request, key, id)).body.dataset;
  expect({ id: en.id, sha256: en.sha256, format: en.format, encoding: en.encoding, revision: en.revision, rows: en.rows })
    .toEqual({ id: ko.id, sha256: ko.sha256, format: ko.format, encoding: ko.encoding, revision: ko.revision, rows: ko.rows });
  expect((await dsRows(request, key, id)).body.items.map((r) => r.line)).toEqual([1, 2, 3, 4, 5, 6, 7]);

  expect((await teachApi(request, NODE, nodeAddress, key, 'DELETE', `/api/teach/datasets/${id}`)).status).toBe(200);
});

// ---------------------------------------------------------------------------------------------- AZ-236
test('AZ-236 /teach trust strip: what stays private, who can see it, where the key lives, that publishing is a separate step — and the full terms one link away @mobile', async ({ page }) => {
  const width = page.viewportSize()?.width ?? 1280;
  await page.goto(`${NODE}/teach`);
  const entry = page.getByTestId('teach-entry');
  await expect(entry).toBeVisible();
  await expect(page.getByTestId('teach-policy')).toBeVisible();   // the policy has arrived: the layout is final

  const strip = page.getByTestId('trust-strip');
  await expect(strip).toHaveAttribute('aria-label', 'Trust and privacy');
  await expect(strip.locator('ul > li')).toHaveText(['Private by default', 'You choose what to publish', 'Your teaching key stays in this browser', 'The node operator can see your drafts']);
  for (const id of ['private', 'publish', 'key', 'operator']) await expect(strip.getByTestId(`trust-${id}`)).toBeVisible();
  // directly under the doors, above "what happens next"
  const [fileBox, stripBox, nextBox] = await entry.evaluate((el) => ['door-file', 'trust-strip', 'teach-next'].map((id) => {
    const r = el.querySelector(`[data-testid=${id}]`)!.getBoundingClientRect();
    return { y: r.y, bottom: r.bottom };
  }));
  expect(stripBox.y).toBeGreaterThanOrEqual(fileBox.bottom);
  expect(stripBox.bottom).toBeLessThanOrEqual(nextBox.y);
  expect(await page.evaluate(() => document.documentElement.scrollWidth), 'no horizontal scroll').toBeLessThanOrEqual(width);

  // only claims the code makes true — never a word the code cannot back
  await expect(strip).not.toContainText(/encrypt|anonymous|nobody can see|no one can see/i);

  const detail = page.getByTestId('trust-detail');
  await expect(detail.locator('summary')).toHaveText('What this means');
  expect(await detail.evaluate((el) => (el as HTMLDetailsElement).open), 'collapsed by default').toBe(false);
  await expect(detail.locator('dd').first()).toBeHidden();
  await detail.locator('summary').click();
  await expect(detail.locator('dt')).toHaveText(['Private by default', 'You choose what to publish', 'Your teaching key stays in this browser', 'The node operator can see your drafts']);
  await expect(detail.locator('dd')).toHaveText([
    'What you teach stays a private draft on this node until you publish it. You can delete a draft any time from My datasets and lessons.',
    "Publishing is a separate step you take yourself, with your key's signature and your consent. Once published, a lesson is a permanent public record and cannot be deleted.",
    'The key that signs your lessons and receives your share is created and kept in this browser. The node only ever sees its public address — download a backup from Your knowledge.',
    'This page is served by one node. Its operator can read the questions, answers and files you store here for as long as they exist — private means private from everyone else, not from the operator. Do not upload personal data or anything you are not allowed to share.',
  ]);
  if (width < 600) {
    // term over definition on a phone: the first <dd> starts below the first <dt>
    const [dt, dd] = await Promise.all([detail.locator('dt').first().boundingBox(), detail.locator('dd').first().boundingBox()]);
    expect(dd!.y).toBeGreaterThanOrEqual(dt!.y + dt!.height - 1);
  }

  // the full terms, one link away, at the teaching section
  const terms = page.getByTestId('trust-terms');
  await expect(terms).toHaveText('Full terms →');
  expect(new URL((await terms.getAttribute('href'))!, NODE).pathname + new URL((await terms.getAttribute('href'))!, NODE).hash).toBe('/terms#teaching');
  await terms.click();
  await page.waitForURL(/\/terms#teaching$/);
  const heading = page.getByTestId('terms-teaching');
  await expect(heading).toHaveText('3.5 What a node stores when you teach it');
  await expect(heading).toHaveAttribute('id', 'teaching');
  await expect.poll(async () => (await heading.boundingBox())!.y, 'scrolled to the teaching section').toBeLessThan(400);
  await expect(heading.locator('xpath=following-sibling::p[1]')).toContainText('stored on this node as a dataset of questions and answers');
  await expect(heading.locator('xpath=following-sibling::p[2]')).toContainText('It is not private from the operator.');
  await expect(heading.locator('xpath=following-sibling::p[3]')).toContainText('the private key is never sent to any node');
  await expect(heading.locator('xpath=following-sibling::p[4]')).toContainText('Publishing is a separate step.');

  // 한국어
  await page.goto(`${NODE}/teach`);
  await page.getByRole('button', { name: 'language' }).click();
  await expect(strip.locator('ul > li')).toHaveText(['기본은 비공개', '공개 여부는 내가 정합니다', '가르치기 키는 이 브라우저에만 있습니다', '노드 운영자는 초안을 볼 수 있습니다']);
  await expect(page.getByTestId('trust-terms')).toHaveText('전체 약관 →');
  await page.getByRole('button', { name: 'language' }).click();
});

// ---------------------------------------------------------------------------------------------- AZ-237
test('AZ-237 /teach hierarchy: the conversation door is the one primary action and the file door is clearly secondary, at 1280 and 360 px @mobile', async ({ page }) => {
  const width = page.viewportSize()?.width ?? 1280;
  await page.goto(`${NODE}/teach`);
  const entry = page.getByTestId('teach-entry');
  await expect(entry).toBeVisible();
  const chat = page.getByTestId('door-chat');
  const file = page.getByTestId('door-file');
  await expect(chat).toBeVisible();
  await expect(file).toBeVisible();

  // order: the primary door comes first in the document — it is what a screen reader and the Tab key reach first
  expect(await entry.evaluate((el) => {
    const c = el.querySelector('[data-testid=door-chat]');
    const f = el.querySelector('[data-testid=door-file]');
    return !!(c && f && (c.compareDocumentPosition(f) & Node.DOCUMENT_POSITION_FOLLOWING));
  }), 'chat card precedes file card').toBe(true);

  // weight: 2 px purple + tinted vs. 1 px grey on white; 22 px vs. 16 px heading
  const style = (loc: ReturnType<Page['locator']>, prop: string) => loc.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);
  expect(await style(chat, 'border-top-width')).toBe('2px');
  expect(await style(chat, 'border-top-color')).toBe('rgb(139, 62, 235)');
  expect(await style(chat, 'background-color')).toBe('rgb(245, 238, 252)');
  expect(await style(file, 'border-top-width')).toBe('1px');
  expect(await style(file, 'border-top-color')).toBe('rgb(218, 218, 218)');
  expect(await style(file, 'background-color')).toBe('rgb(255, 255, 255)');
  expect(await style(chat.getByRole('heading', { level: 2 }), 'font-size')).toBe('22px');
  expect(await style(file.getByRole('heading', { level: 2 }), 'font-size')).toBe('16px');

  // labels: contained (white on purple) vs. outlined (purple on transparent) — visual labels of the card links, not buttons (O-9)
  const chatBtn = page.getByTestId('door-chat-cta');
  const fileBtn = page.getByTestId('door-file-cta');
  expect(await style(chatBtn, 'background-color')).toBe('rgb(139, 62, 235)');
  expect(await style(chatBtn, 'color')).toBe('rgb(255, 255, 255)');
  expect(await style(fileBtn, 'background-color')).toBe('rgba(0, 0, 0, 0)');
  expect(await style(fileBtn, 'color')).toBe('rgb(139, 62, 235)');

  // size and position: 3:2 side by side on desktop; stacked, primary first, nothing overflowing on a phone.
  // Both boxes are read in one call after the policy has arrived, so a late layout shift cannot split the measurement.
  await expect(page.getByTestId('teach-policy')).toBeVisible();
  const [cb, fb] = await entry.evaluate((el) => ['door-chat', 'door-file'].map((id) => {
    const r = el.querySelector(`[data-testid=${id}]`)!.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }));
  if (width >= 600) {
    expect(cb.width, 'the primary card is wider (3:2)').toBeGreaterThan(fb.width * 1.3);
    expect(Math.abs(cb.y - fb.y), 'side by side').toBeLessThan(2);
  } else {
    expect(Math.round(cb.width), 'both full width').toBe(Math.round(fb.width));
    expect(cb.y + cb.height, 'the primary card sits above the secondary one').toBeLessThanOrEqual(fb.y);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth), 'no horizontal scroll').toBeLessThanOrEqual(width);

  // the secondary door stays one click away — and the click lands on the card, not on its label (O-9)
  await file.click({ position: { x: 12, y: 12 } });
  await page.waitForURL(/\/teach\/upload$/);
});
