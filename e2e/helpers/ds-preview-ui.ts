/**
 * Browser-side helpers for the dataset-preview scenarios (AZ-143…AZ-162) — the file door of teach mode
 * (`/teach/upload` → `/teach/dataset/:id` → `…/settings` → `/teach/lesson/:jobId`).
 *
 * The preview table is one `<table data-testid="dataset-table">`; every row is `[data-testid=dataset-row]` with the
 * cells in a fixed order (line, question, answer, another way to ask, status, actions), so the small accessors here
 * are the only place that knows the column order.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { NODE, REPO } from './ds-preview-node';

declare global { interface Window { __sent?: { method: string; url: string; body: string }[] } }

export const FIXTURES = join(REPO, 'packages/e2e/fixtures/ds-preview');
export const fixture = (name: string): Buffer => readFileSync(join(FIXTURES, name));
export const fixtureText = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

/** A visitor with an empty browser: no teaching key, no operator session, en-US. */
export async function visitorContext(browser: Browser, viewport?: { width: number; height: number }): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ acceptDownloads: true, locale: 'en-US', ...(viewport ? { viewport } : {}) });
  const page = await context.newPage();
  return { context, page };
}

const MIME: Record<string, string> = { jsonl: 'application/x-ndjson', json: 'application/json', csv: 'text/csv', tsv: 'text/tab-separated-values', txt: 'text/plain' };

/**
 * The node accepts `dataset.createsPerIpPerMin` (10) new datasets a minute from one address, and everyone testing
 * against the dev node shares that address. Uploads are paced to 5 in any rolling minute (leaving room for whoever
 * else is on the box) and a refusal is retried until the node's minute window rolls.
 */
const UPLOADS_PER_MIN = 5;
const uploadTimes: number[] = [];
async function paceUpload(): Promise<void> {
  for (;;) {
    const now = Date.now();
    while (uploadTimes.length && now - uploadTimes[0] > 60_000) uploadTimes.shift();
    if (uploadTimes.length < UPLOADS_PER_MIN) { uploadTimes.push(now); return; }
    await new Promise((r) => setTimeout(r, 61_000 - (now - uploadTimes[0])));
  }
}

/** Step 1 → step 2: choose a file through the real `<input type=file>` and land on the preview. Returns the dataset id. */
export async function uploadBytes(page: Page, name: string, body: Buffer, origin = NODE): Promise<string> {
  const ext = name.split('.').pop() ?? 'txt';
  for (let attempt = 0; ; attempt++) {
    await paceUpload();
    if (!/\/teach\/upload$/.test(page.url())) await page.goto(`${origin}/teach/upload`);
    await page.getByTestId('teach-upload').waitFor();
    await page.getByTestId('file-input').setInputFiles({ name, mimeType: MIME[ext] ?? 'text/plain', buffer: body });
    const landed = await Promise.race([
      page.waitForURL(/\/teach\/dataset\/[0-9a-f-]{36}$/, { timeout: 90_000 }).then(() => 'ok' as const),
      page.getByTestId('upload-error').waitFor({ timeout: 90_000 }).then(() => 'error' as const),
    ]);
    if (landed === 'ok') break;
    const message = (await page.getByTestId('upload-error').textContent())?.trim() ?? '';
    // anyone else testing against this dev node shares the per-address minute; wait for it to roll rather than
    // failing a scenario over someone else's traffic
    if (attempt >= 8 || !/Too many requests/i.test(message)) throw new Error(`upload of ${name} was refused: ${message}`);
    await new Promise((r) => setTimeout(r, 20_000));
  }
  await page.getByTestId('teach-dataset').waitFor();
  return datasetIdOf(page);
}
export const uploadFixture = (page: Page, name: string, origin = NODE): Promise<string> => uploadBytes(page, name, fixture(name), origin);

export const datasetIdOf = (page: Page): string => new URL(page.url()).pathname.split('/')[3];
export const jobIdOf = (page: Page): string => new URL(page.url()).pathname.split('/')[3];

// ------------------------------------------------------------------ the preview table

export const rows = (page: Page): Locator => page.getByTestId('dataset-row');
export const cell = (row: Locator, i: number): Locator => row.locator('td').nth(i);
export const lineCell = (row: Locator) => cell(row, 0);
export const questionCell = (row: Locator) => cell(row, 1);
export const answerCell = (row: Locator) => cell(row, 2);
export const altCell = (row: Locator) => cell(row, 3);
export const statusCell = (row: Locator) => cell(row, 4);
/** The green/red/grey pill of a row — the machine-readable verdict rendered in the visitor's language. */
export const pill = (row: Locator) => statusCell(row).locator('> span').first();
/** The grey help lines under the pill ("Lines 2 and 3 …", "It answered: …", "Not checked yet", the advisory). */
export const helpLines = (row: Locator) => statusCell(row).locator('> span:not(:first-child)');

export const counts = (page: Page) => page.getByTestId('row-counts');

/**
 * Press "Check what the model already knows" and wait for the whole batched run to settle. The page only writes the
 * checked note (or the red box) once the loop is over, so those are the honest end markers — the button is enabled
 * again for a moment between batches.
 */
export async function runCheck(page: Page): Promise<void> {
  const button = page.getByTestId('run-check');
  await button.click();
  await Promise.race([
    page.getByTestId('checked-note').waitFor({ state: 'visible', timeout: 5 * 60_000 }),
    page.getByTestId('dataset-error').waitFor({ state: 'visible', timeout: 5 * 60_000 }),
  ]);
  await expect(button).toBeEnabled({ timeout: 60_000 });
}

/** Open the edit sheet of one row, replace what is given and save. */
export async function editRow(page: Page, row: Locator, patch: { prompt?: string; answer?: string; alt?: string }): Promise<void> {
  await row.getByTestId('row-edit').click();
  const sheet = page.getByTestId('row-edit-sheet');
  await expect(sheet).toBeVisible();
  if (patch.prompt !== undefined) await sheet.getByTestId('row-q').fill(patch.prompt);
  if (patch.answer !== undefined) await sheet.getByTestId('row-a').fill(patch.answer);
  if (patch.alt !== undefined) await sheet.getByTestId('row-alt').fill(patch.alt);
  await sheet.getByTestId('row-save').click();
  await expect(sheet).toBeHidden({ timeout: 60_000 });
}

/**
 * Step 3 → step 4: press "Train this lesson (...)" and land on the lesson. If the node refuses (a full queue, a spent
 * quota, "nothing to train"), the red box on the settings screen is what the scenario needs to see, so it is raised
 * here instead of a bare navigation timeout.
 */
export async function train(page: Page): Promise<string> {
  await page.getByTestId('train-lesson').click();
  const landed = await Promise.race([
    page.waitForURL(/\/teach\/lesson\/[0-9a-f-]{36}$/, { timeout: 120_000 }).then(() => 'ok' as const),
    page.getByTestId('settings-error').waitFor({ state: 'visible', timeout: 120_000 }).then(() => 'error' as const),
  ]);
  if (landed === 'error') throw new Error(`the node refused the lesson: ${(await page.getByTestId('settings-error').textContent())?.trim()}`);
  return jobIdOf(page);
}

/** `documentElement.scrollWidth <= innerWidth + 1` — the page body never scrolls sideways (design §5.13). */
export async function pageWidths(page: Page): Promise<{ scrollWidth: number; innerWidth: number }> {
  return page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
}
export async function expectNoSidewaysScroll(page: Page, where: string): Promise<void> {
  const w = await pageWidths(page);
  expect(w.scrollWidth, `${where}: page body scrolls sideways (${w.scrollWidth} > ${w.innerWidth})`).toBeLessThanOrEqual(w.innerWidth + 1);
}

/** The header locale button (aria-label="language"); its own label is the OTHER language. */
export const langButton = (page: Page) => page.getByRole('button', { name: 'language' });
export async function switchToKorean(page: Page): Promise<void> {
  await expect(langButton(page)).toHaveText('한국어');
  await langButton(page).click();
  await expect(langButton(page)).toHaveText('English');
}

/** Collect the requests a scenario has to prove were (or were not) sent. Bodies come from `recordFetchBodies`. */
export function watchRequests(page: Page, match: (url: string, method: string) => boolean): { seen: { method: string; url: string }[] } {
  const seen: { method: string; url: string }[] = [];
  page.on('request', (r) => { if (match(r.url(), r.method())) seen.push({ method: r.method(), url: r.url() }); });
  return { seen };
}

export interface SentRequest { method: string; url: string; body: string }

/**
 * Record what the app actually PUTs on the wire. The signed fetch rebuilds every request (`new Request(req, {headers})`)
 * so its body reaches the browser as a stream and Playwright's `request.postData()` is null; wrapping `window.fetch`
 * before the bundle loads is the only place the JSON body is still readable.
 */
export async function recordFetchBodies(page: Page): Promise<() => Promise<SentRequest[]>> {
  await page.addInitScript(() => {
    const store: SentRequest[] = [];
    (window as unknown as { __sent: SentRequest[] }).__sent = store;
    const real = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') {
        const url = input instanceof Request ? input.url : String(input);
        let body = '';
        try {
          if (typeof init?.body === 'string') body = init.body;
          else if (input instanceof Request) body = await input.clone().text();
        } catch { body = ''; }
        store.push({ method, url, body });
      }
      return real(input as RequestInfo, init);
    };
  });
  return async () => page.evaluate(() => (window as unknown as { __sent: SentRequest[] }).__sent ?? []);
}
