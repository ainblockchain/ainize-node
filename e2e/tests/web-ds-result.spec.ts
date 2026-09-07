/**
 * Teach mode v2 — the RESULT screen and everything a visitor can do with a finished lesson (AZ-183…AZ-202 of
 * docs/ux-test-scenarios.json): what stuck and what did not, side effects, the live A/B on the private draft, keeping
 * it private, publishing it, the public knowledge page, "My datasets and lessons", forking and retention, and the
 * chat basket that is already a dataset.
 *
 *   cd packages/e2e
 *   AINIZE_URL=http://localhost:3422 AINIZE_PASS=teachable-pass npx playwright test tests/web-ds-result.spec.ts --project=web --reporter=list
 *   …--project=mobile   (only the @mobile scenarios: AZ-185, AZ-193)
 *
 * WHICH NODE, AND WHY (helpers/ds-result-node.ts)
 *  - `stub node`  : AINIZE_URL — the shared dev node node-u, as it ships: a stub trainer whose checks are SIMULATED
 *                   (`teach.stubOffline: true`). Thirteen of these scenarios need exactly that state. Because node-u
 *                   is shared, each test re-establishes the preconditions its scenario states (quotas raised, publish
 *                   'auto', the dataset limits at their defaults) instead of trusting what it finds.
 *  - `live model` : the other seven mean nothing without a real model — a partial result, a sampled check, the live
 *                   A/B, the already-known/already-on-sale accounting, the chat door. Those need a node with
 *                   `runtime.api` on the dedicated e2e model server (http://localhost:8002, container flashnext-e2e,
 *                   GPUs 4+5), `teach.stubOffline: false` and `ENGRAM_PATCH_DIR=/mnt/newdata/qwen3.8/ple_patch_e2e`
 *                   in its environment — and a RESTART to get there. Doing that to node-u breaks every other session
 *                   using it (and their restarts land in the middle of a four-minute live check here), so the block
 *                   starts its OWN node from the same build, the same config defaults and the same model server, on a
 *                   free port under the scratch directory, and destroys it afterwards. :8000 / :8001 are never
 *                   touched, and node-u's own configuration is never changed.
 *
 * Cleanup: every dataset and lesson these tests create is deleted again and the operator policy is restored. Lessons
 * that were ANNOUNCED cannot be deleted by design (409 published_immutable) — that is why this suite only runs
 * against disposable local-ledger nodes.
 */
import { createHash } from 'node:crypto';
import { test, expect, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { hashCanonical, signMessage, verifyMessage } from '../../core/dist/index.js';
import { api, NODE_A } from '../helpers/ainize';
import {
  NODE, PINNED_LIMITS, RELAXED_QUOTA, createDataset, dropDataset, dropJob, getJob, limitsMatch, newTeachKey,
  onQuotaRefused, operatorToken, patchPolicy, publicPolicy, publishLesson, quotaSnapshot, rowsOf, seedTeacherKey, tapi, trainAndWait,
  trainDataset, trainFacts, uploadDataset, useNode, waitForLesson, type Job, type Policy, type Row, type TeachKey,
} from '../helpers/ds-result-api';
import { DEAD_API, LIVE_API, PATCH_DIR, runtimeReady, startPrivateNode, type PrivateNode } from '../helpers/ds-result-node';

/*
 * Execution order: `playwright.config.ts` already runs this project with `workers: 1` and `fullyParallel: false`, so
 * every test in this file runs alone, in declaration order — nothing here can touch the model or the node at the same
 * time as anything else. `mode: 'serial'` is therefore used ONLY where the ORDER itself carries state (the live-model
 * describe, whose own node is started in beforeAll): a serial block also SKIPS everything after the first
 * failure, and several of these scenarios deliberately assert a fix the product has not made yet, so a serial file
 * would report the scenarios behind them as "did not run" instead of as results.
 */
test.describe.configure({ retries: 0 });

const TAG = Date.now().toString(36).slice(-5);
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const hex64 = /^[0-9a-f]{64}$/;

let policy: Policy;
let opToken = '';
let originalQuota: Record<string, number> = {};
let originalLimits: Record<string, number | null> = {};
let originalPublish: 'review' | 'auto' | 'never' = 'auto';
let nodeAddress = '';
/** Every dataset / lesson this file creates, so afterAll can sweep whatever a failing test left behind. */
const litter: { key: TeachKey; jobs: string[]; datasets: string[] }[] = [];
function owns(key: TeachKey) {
  const rec = { key, jobs: [] as string[], datasets: [] as string[] };
  litter.push(rec);
  return rec;
}

/** node-u is restarted by other sessions while this suite starts up; a closed socket is not a result. */
async function whenNodeAnswers<T>(what: string, call: () => Promise<T>, ms = 120_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    try { return await call(); } catch (e) {
      if (Date.now() - t0 > ms) throw new Error(`${what}: the node never answered (${(e as Error).message})`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

test.beforeAll(async ({ request }) => {
  policy = await whenNodeAnswers('GET /api/teach/policy', () => publicPolicy(request));
  test.skip(!policy.enabled, 'teach mode is not enabled on this node');
  test.skip(policy.backend !== 'stub', 'teach backend is not `stub` — these scenarios would start real GPU jobs');
  const info = await whenNodeAnswers('GET /api/info', () => api<{ node: { address: string } }>(request, '/api/info', { node: NODE }));
  nodeAddress = info.body.node.address;
  opToken = await whenNodeAnswers('operator login', () => operatorToken(request));
  originalQuota = quotaSnapshot(policy.limits);
  originalPublish = policy.publish;
  originalLimits = {
    dataset_max_rows: policy.limits.dataset_max_rows, dataset_max_bytes: policy.limits.dataset_max_bytes,
    declaration_rows: policy.limits.declaration_rows,
    rows_per_job: policy.limits.rows_per_job_source === 'default' ? null : policy.limits.rows_per_job,
  };
  await patchPolicy(request, opToken, PINNED_LIMITS);
});

test.afterAll(async ({ request }) => {
  onQuotaRefused(null);
  for (const rec of litter) {
    for (const id of rec.jobs) await dropJob(request, rec.key, id);
    for (const id of rec.datasets) await dropDataset(request, rec.key, id);
  }
  // the node is restarted by the live block, so the operator session is re-established before putting the policy back
  const token = await operatorToken(request).catch(() => opToken);
  if (token && Object.keys(originalQuota).length) {
    await patchPolicy(request, token, { ...originalQuota, ...originalLimits, publish: originalPublish }).catch((e: Error) => console.warn(`policy restore failed: ${e.message}`));
  }
});

/** Open a lesson result screen as the owner of `key` and wait for it to stop moving. */
async function openLesson(page: Page, context: BrowserContext, key: TeachKey, jobId: string): Promise<void> {
  await seedTeacherKey(context, key);
  await page.goto(`${NODE}/teach/lesson/${jobId}`);
  const lesson = page.getByTestId('teach-lesson');
  await expect(lesson).toBeVisible({ timeout: 60_000 });
  await expect(lesson).not.toHaveAttribute('data-status', /^(QUEUED|PREFLIGHT|LOADING|TRAINING|EXPORTED|CHECKING)$/, { timeout: 5 * 60_000 });
}

/** node-u is shared: another session may have set teach.publish to 'review'/'never' between two of these tests. */
async function ensurePublishAuto(request: APIRequestContext): Promise<Policy> {
  let p = await publicPolicy(request);
  if (p.publish !== 'auto') {
    await patchPolicy(request, await operatorToken(request), { publish: 'auto' });
    p = await publicPolicy(request);
  }
  expect(p.publish).toBe('auto');
  policy = p;
  return p;
}

/**
 * One ANNOUNCED lesson for the scenarios that need published knowledge (AZ-194's immutability check, AZ-196's anchor,
 * AZ-199's public page). Created once per run from an UPLOADED dataset, with a display name sent the way only the API
 * can today, and published with a signed claim exactly as the browser does. An announced lesson is permanent — this is
 * why the suite only runs against the disposable local-ledger dev node.
 */
interface Announced { key: TeachKey; jobId: string; datasetId: string; patchId: string; url: string; name: string; rows: number; datasetSha: string; providerName: string }
let announced: Announced | null = null;
async function ensureAnnounced(request: APIRequestContext): Promise<Announced> {
  if (announced) return announced;
  await ensurePublishAuto(request);
  const key = newTeachKey('AZ199 Provider');
  const mine = owns(key);
  const body = `{"prompt":"AZ199 ${TAG} ticker?","answer":"087600"}\n{"prompt":"AZ199 ${TAG} founded?","answer":"2018"}\n{"prompt":"AZ199 ${TAG} founder?","answer":"Minhyun Kim"}\n`;
  const ds = await uploadDataset(request, key, { name: `az199-${TAG}.jsonl`, body, mimeType: 'application/x-ndjson' });
  mine.datasets.push(ds.id);
  const started = await trainDataset(request, key, ds.id, {}, { contributor: { name: 'AZ199 Provider' } });
  mine.jobs.push(started.id);
  const job = await waitForLesson(request, key, started.id);
  expect(job.status, 'the fixture lesson must be READY before it can be published').toBe('READY');
  const name = `AZ199 lesson ${TAG}`;
  const out = await publishLesson(request, key, job.id, { name, price: '0.3' });
  expect(out.status, `publish failed: ${JSON.stringify(out.body)}`).toBe(200);
  expect(out.body.status).toBe('ANNOUNCED');
  announced = { key, jobId: job.id, datasetId: ds.id, patchId: out.body.patch_id!, url: out.body.url!, name, rows: 3, datasetSha: ds.sha256, providerName: 'AZ199 Provider' };
  return announced;
}

/** Upload a file through the real drop zone and wait for step 2 (the node is shared: one retry on a hiccup). */
async function uploadThroughUi(page: Page, file: { name: string; mimeType: string; buffer: Buffer }): Promise<string> {
  for (let i = 0; i < 2; i++) {
    await page.goto(`${NODE}/teach/upload`);
    await page.getByTestId('file-input').setInputFiles(file);
    try {
      await expect(page).toHaveURL(/\/teach\/dataset\/[0-9a-f-]{36}$/, { timeout: 60_000 });
      return new URL(page.url()).pathname.split('/').pop()!;
    } catch (e) {
      const err = await page.getByTestId('upload-error').textContent().catch(() => null);
      if (i === 1) throw new Error(`upload never reached step 2${err ? `: ${err}` : ''}`);
    }
  }
  throw new Error('unreachable');
}

/** Switch the browser to Korean the way the locale toggle does (localStorage `ainize.locale`). */
async function useKorean(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => { try { localStorage.setItem('ainize.locale', 'ko'); } catch { /* ignore */ } });
}

/**
 * Open one of the result screen's sheets. The button only becomes live once the job AND the node policy are in the
 * store, so a single click can land on a screen that is still assembling itself — click again rather than fail on a
 * race that no visitor would ever notice.
 */
async function openSheet(page: Page, button: string, sheet: string): Promise<void> {
  const btn = page.getByTestId(button);
  await expect(btn).toBeEnabled({ timeout: 60_000 });
  for (let i = 0; i < 3; i++) {
    await btn.click();
    try { await expect(page.getByTestId(sheet)).toBeVisible({ timeout: 10_000 }); return; } catch { /* try again */ }
  }
  await expect(page.getByTestId(sheet)).toBeVisible({ timeout: 20_000 });
}

/** No page-level horizontal scroll at the given width (the layout rule every teach screen must keep). */
async function noHorizontalScroll(page: Page, width = 360): Promise<void> {
  const before = page.viewportSize();
  await page.setViewportSize({ width, height: before?.height ?? 780 });
  await page.waitForTimeout(300);
  const over = await page.evaluate(() => {
    const el = document.scrollingElement ?? document.documentElement;
    return el.scrollWidth - el.clientWidth;
  });
  expect(over, `page scrolls horizontally at ${width} px`).toBeLessThanOrEqual(1);
  if (before) await page.setViewportSize(before);
}

// =================================================================== stub mode (checks simulated, nothing reaches a model)
test.describe('stub node', () => {
  /**
   * Re-establish the preconditions every one of these scenarios states — quotas raised, publish 'auto', the dataset
   * limits at their defaults, and the node's checks SIMULATED. node-u is shared, so all four can be somebody else's
   * for a while; a daily cap put back mid-test is raised again from `onQuotaRefused` (with THIS test's request
   * fixture — a beforeAll one cannot be reused inside a test).
   */
  test.beforeEach(async ({ request }) => {
    onQuotaRefused(async () => { await patchPolicy(request, await operatorToken(request), PINNED_LIMITS); });
    let p = await whenNodeAnswers('GET /api/teach/policy', () => publicPolicy(request));
    // another session may have put node-u on the live model for its own scenarios: these thirteen need the stub's
    // simulated checks, so wait for it to come back rather than measure someone else's run
    const t0 = Date.now();
    while (p.simulated_checks === false && Date.now() - t0 < 5 * 60_000) {
      await new Promise((r) => setTimeout(r, 10_000));
      p = await publicPolicy(request);
    }
    expect(p.simulated_checks, 'this scenario needs node-u with simulated checks (teach.stubOffline true)').toBe(true);
    if (!limitsMatch(p)) {
      await patchPolicy(request, await operatorToken(request), PINNED_LIMITS);
      p = await publicPolicy(request);
    }
    policy = p;
  });

  test('AZ-185 a big result says how much of itself it is showing: the learned table caps at 50 rows @mobile', async ({ page, context, request }) => {
    const key = newTeachKey();
    const mine = owns(key);
    const ds = await createDataset(request, key, { source: 'inline', name: `az185-${TAG}`, rows: rowsOf(120, TAG, 'AZ185') });
    mine.datasets.push(ds.id);
    expect(ds.rows).toBe(120);
    const job = await trainAndWait(request, key, ds.id);
    mine.jobs.push(job.id);
    expect(job.status).toBe('READY');
    expect(job.facts.length).toBe(120);

    await openLesson(page, context, key, job.id);
    await expect(page.getByTestId('result-learned')).toHaveText('It marked all 120 questions as learned — illustrative numbers, not measured in a live model.');
    const learned = page.getByTestId('learned-block');
    await expect(learned).toBeVisible();
    await expect(learned.locator('tbody tr')).toHaveCount(50);
    // the gap this scenario exists for: 50 of 120 rows are printed with nothing saying so (the locator is the block's
    // own prose, not the 50 rows, so a failure reads as one missing sentence instead of the whole table)
    await expect.soft(learned.locator(':scope > :not(table)').filter({ hasText: /50 of 120/ }), 'the learned block must say how many of the total it shows').toHaveCount(1);
    await expect.soft(learned.getByRole('link'), 'the truncated table must link to the full list').toHaveCount(1);
    // every question was measured, so there is no missed block to truncate
    expect(job.facts.filter((f) => f.hit === false).length).toBe(0);
    await expect(page.getByTestId('missed-block')).toHaveCount(0);
    await noHorizontalScroll(page);
  });

  test('AZ-186 side effects panel: unrelated answers unchanged, measured, with no gate on the lesson', async ({ page, context, request }) => {
    const key = newTeachKey();
    const mine = owns(key);
    const csv = `prompt,answer,alt_prompt\nAZ186 ${TAG} first?,alpha,AZ186 ${TAG} first again?\nAZ186 ${TAG} second?,beta,\nAZ186 ${TAG} third?,gamma,\n`;
    const ds = await uploadDataset(request, key, { name: `az186-${TAG}.csv`, body: csv, mimeType: 'text/csv' });
    mine.datasets.push(ds.id);
    const job = await trainAndWait(request, key, ds.id);
    mine.jobs.push(job.id);
    expect(job.status).toBe('READY');
    const c = job.checks!;
    expect(c.executed).toBe(true);
    expect(c.skipped ?? false).toBe(false);
    expect(c.parent_regression.total).toBe(0);
    expect(c.locality.ok).toBe(true);

    await openLesson(page, context, key, job.id);
    const panel = page.getByTestId('side-effects');
    await expect(panel.getByRole('heading', { level: 2 })).toHaveText('Side effects');
    // parent_regression.total === 0 → the short line (teach.card.check_locality), never the "knowledge you had loaded" half
    await expect(panel.getByTestId('side-ok')).toHaveText(`Unrelated questions unchanged: ${c.locality.same}/${c.locality.total}`);
    await expect(panel.getByTestId('side-ok')).not.toContainText('knowledge you had loaded');
    await expect(panel.getByTestId('side-bad')).toHaveCount(0);
    // a measured, unskipped check never offers "Run the check now" — that branch is AZ-165
    await expect(panel.getByTestId('run-check-now')).toHaveCount(0);
    // the small "left out because the model is not repeatable" line appears exactly when the node measured one
    const unstable = c.locality.unstable ?? 0;
    if (unstable > 0) {
      await expect(panel.getByTestId('side-unstable')).toHaveText(
        unstable === 1
          ? 'One unrelated question was left out: this model does not answer it the same way twice, so it cannot show what the lesson changed.'
          : `${unstable} unrelated questions were left out: this model does not answer them the same way twice, so they cannot show what the lesson changed.`,
      );
    } else {
      await expect(panel.getByTestId('side-unstable')).toHaveCount(0);
    }
    // the lesson is not gated: publish is offered
    await expect(page.getByTestId('go-publish')).toBeEnabled();
    await expect(page.getByText('Publishing is off for this lesson')).toHaveCount(0);
  });

  test('AZ-187 a lesson that changes unrelated answers is un-publishable but still keepable and downloadable', async ({ page, context, request }) => {
    const key = newTeachKey();
    const mine = owns(key);
    const ds = await createDataset(request, key, {
      source: 'inline', name: `az187-${TAG}`,
      rows: [
        { prompt: `AZ187 ${TAG} marker?`, answer: 'LOCALITY_FAIL sentinel' },
        { prompt: `AZ187 ${TAG} ordinary one?`, answer: 'one' },
        { prompt: `AZ187 ${TAG} ordinary two?`, answer: 'two' },
      ],
    });
    mine.datasets.push(ds.id);
    const job = await trainAndWait(request, key, ds.id);
    mine.jobs.push(job.id);
    const c = job.checks!;
    expect(c.locality.ok).toBe(false);
    expect(c.locality.same).toBeLessThan(11);
    expect(c.ok).toBe(false);

    await openLesson(page, context, key, job.id);
    const changed = c.locality.total - c.locality.same;
    await expect(page.getByTestId('side-bad')).toHaveText(`This lesson changed the answers to ${changed} unrelated questions, so it cannot be published. You can still keep it and run it yourself.`);
    await expect(page.getByTestId('go-publish')).toBeDisabled();
    await expect(page.getByText('Publishing is off for this lesson because it changed answers to unrelated questions. You can still save it.')).toBeVisible();
    const keep = page.getByTestId('go-keep');
    await expect(keep).toBeEnabled();

    // the keep sheet still mints links for a gated lesson
    await openSheet(page, 'go-keep', 'keep-sheet');
    await page.getByTestId('keep-download').check();
    const sheet = page.getByTestId('keep-sheet');
    await expect(sheet.getByTestId('dl-npz')).toBeVisible({ timeout: 60_000 });
    await expect(sheet.getByTestId('dl-recipe')).toBeVisible();
    await expect(sheet.getByTestId('dl-readme')).toBeVisible();
    await expect(sheet.getByTestId('dl-sha')).toHaveText(hex64);

    const pub = await publishLesson(request, key, job.id, { name: `AZ187 ${TAG}` });
    expect(pub.status).toBe(409);
    expect(pub.body.error).toBe('checks_failed: this lesson changed answers to unrelated questions or to the knowledge it builds on');
  });

  test('AZ-189 demo-node honesty: simulated checks, and a stopped lesson shows no result at all', async ({ page, context, request }) => {
    const key = newTeachKey();
    const mine = owns(key);
    const ds = await createDataset(request, key, { source: 'inline', name: `az189-${TAG}`, rows: rowsOf(3, TAG, 'AZ189') });
    mine.datasets.push(ds.id);
    const job = await trainAndWait(request, key, ds.id);
    mine.jobs.push(job.id);
    expect(job.checks?.simulated).toBe(true);
    expect(job.checks?.note).toBe('stub backend (offline) — checks were simulated, not measured in a live model');

    await openLesson(page, context, key, job.id);
    // the admission is the headline and the first thing under it, in the warning tone — not a pale box below a
    // display-type "Your lesson is ready"
    await expect(page.locator('h1')).toHaveText('Demo run finished — nothing was trained');
    const alert = page.getByTestId('simulated');
    await expect(alert).toHaveText('Demo node — the checks were simulated and no training happened.');
    expect(await alert.evaluate((el) => getComputedStyle(el).backgroundColor), 'warning tone, not the pale info box').toBe('rgb(255, 243, 224)');
    expect(await page.evaluate(() => [...document.querySelectorAll('h1, [data-testid="simulated"], [data-testid="result-learned"]')].map((e) => e.getAttribute('data-testid') ?? e.tagName.toLowerCase())))
      .toEqual(['result-title', 'simulated', 'result-learned']);
    // publishing a placeholder file is not the primary action here
    await expect(page.getByTestId('publish-demo')).toContainText('What this demo node produced is a placeholder file.');
    await expect(page.getByTestId('go-publish')).toHaveText('Publish anyway (demo)');
    await expect(page.getByTestId('go-keep')).toHaveText('Keep it private');

    // a lesson that was stopped has no result to report: the sentence, and nothing else
    const gone = await createDataset(request, key, { source: 'inline', name: `az189b-${TAG}`, rows: rowsOf(2, `${TAG}b`, 'AZ189') });
    mine.datasets.push(gone.id);
    const doomed = await trainAndWait(request, key, gone.id);
    mine.jobs.push(doomed.id);
    const del = await tapi<{ status: string }>(request, `/api/teach/jobs/${doomed.id}`, { method: 'DELETE', key });
    expect(del.status).toBe(200);
    expect(del.body.status).toBe('CANCELLED');
    await page.goto(`${NODE}/teach/lesson/${doomed.id}`);
    await expect(page.getByTestId('teach-lesson')).toHaveAttribute('data-status', 'CANCELLED', { timeout: 60_000 });
    await expect(page.getByTestId('result-failed')).toHaveText('Cancelled.');
    await expect(page.getByTestId('simulated')).toHaveCount(0);
    await expect(page.getByTestId('learned-block')).toHaveCount(0);
    await expect(page.getByTestId('missed-block')).toHaveCount(0);
    await expect(page.getByTestId('side-effects')).toHaveCount(0);
  });

  test('AZ-192 Keep it private → Make download links: the .npz, recipe.json, RUN-LOCALLY.md, the sha256 and the 7-day expiry', async ({ page, context, request }) => {
    const key = newTeachKey();
    const mine = owns(key);
    const ds = await createDataset(request, key, {
      source: 'inline', name: `az192-${TAG}`,
      rows: [
        { prompt: `AZ192 ${TAG} first?`, answer: 'alpha', alt_prompt: `AZ192 ${TAG} first, other wording?` },
        { prompt: `AZ192 ${TAG} second?`, answer: 'beta' },
        { prompt: `AZ192 ${TAG} third?`, answer: 'gamma' },
      ],
    });
    mine.datasets.push(ds.id);
    const job = await trainAndWait(request, key, ds.id);
    mine.jobs.push(job.id);
    expect(job.status).toBe('READY');

    await openLesson(page, context, key, job.id);
    await openSheet(page, 'go-keep', 'keep-sheet');
    const sheet = page.getByTestId('keep-sheet');
    await expect(sheet).toContainText('Keep it private');
    await expect(sheet).toContainText('Nothing is published. Pick how you want to keep it.');
    await expect(sheet).toContainText('Keep it on this node for 7 days');
    await expect(sheet.getByRole('radio').first()).toBeChecked();                       // default option
    const sizeMb = (job.result!.size_bytes / 1e6).toFixed(job.result!.size_bytes < 1e6 ? 2 : 1);   // components/chat/teachUtil.ts mb()
    await expect(sheet).toContainText(`${sizeMb} MB · ${job.result!.rows.toLocaleString('en-US')} memory entries · link valid for 7 days; make a new one any time from Your knowledge.`);

    // picking the radio IS the request for links — no second click
    const [saved] = await Promise.all([
      page.waitForResponse((r) => r.url().includes(`/api/teach/jobs/${job.id}/save`) && r.request().method() === 'POST'),
      sheet.getByTestId('keep-download').check(),
    ]);
    expect(saved.status()).toBe(200);
    const save = await saved.json() as { download: { npz_url: string; recipe_url: string; readme_url: string; expires_at: number }; sha256: string; rows: number; size_bytes: number; filename: string; repo_url: string; model_id: string };
    for (const k of ['download', 'sha256', 'rows', 'size_bytes', 'filename', 'repo_url', 'model_id']) expect(save).toHaveProperty(k);
    expect(save.sha256).toBe(job.result!.sha256);
    expect(save.filename).toBe(`lesson-${job.draft_id!.replace(/^taught-/, '')}.npz`);

    const npz = sheet.getByTestId('dl-npz');
    await expect(npz).toHaveText(`Download the knowledge file (${save.filename})`);
    const npzHref = (await npz.getAttribute('href'))!;
    expect(npzHref).toMatch(new RegExp(`^/p2p/blob/${save.sha256}\\?token=[0-9a-f]{48}&name=`));
    expect(decodeURIComponent(npzHref.split('name=')[1])).toBe(save.filename);
    await expect(sheet.getByTestId('dl-recipe')).toHaveText('Download recipe.json');
    expect(await sheet.getByTestId('dl-recipe').getAttribute('href')).toMatch(new RegExp(`^/api/teach/jobs/${job.id}/recipe\\?token=[0-9a-f]{48}$`));
    await expect(sheet.getByTestId('dl-readme')).toHaveText('Download RUN-LOCALLY.md');
    expect(await sheet.getByTestId('dl-readme').getAttribute('href')).toMatch(new RegExp(`^/api/teach/jobs/${job.id}/local-run\\?token=[0-9a-f]{48}$`));
    await expect(sheet.getByTestId('dl-sha')).toHaveText(job.result!.sha256);
    await expect(sheet).toContainText('File fingerprint (sha256)');
    await expect(sheet.getByRole('button', { name: /^Copy/ })).toBeVisible();
    const days = (save.download.expires_at - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
    await expect(sheet).toContainText(/Links expire: \S+/);

    // the bytes really are the file the fingerprint names
    const blob = await request.get(`${NODE}${npzHref}`);
    expect(blob.status()).toBe(200);
    expect(blob.headers()['content-disposition']).toBe(`attachment; filename="${save.filename}"`);
    expect(sha256(await blob.body())).toBe(save.sha256);
    const recipeRes = await request.get(`${NODE}${save.download.recipe_url}`);
    expect(recipeRes.status()).toBe(200);
    expect(recipeRes.headers()['content-type']).toContain('application/json');
    const recipe = await recipeRes.json() as { facts: unknown[]; sentences: unknown[]; benchmark_samples: unknown[]; heldout: unknown[]; lesson: { dataset: Record<string, unknown> } };
    for (const k of ['facts', 'sentences', 'benchmark_samples', 'heldout']) expect(Array.isArray((recipe as Record<string, unknown>)[k]), `recipe.${k} is an array`).toBe(true);
    expect(recipe.heldout.length).toBeGreaterThan(0);
    expect(recipe.lesson.dataset).toMatchObject({ sha256: ds.sha256, rows: 3, revision: 1, source: ds.source, trained_rows: 3 });

    // a wrong token gets nothing
    const badRecipe = await tapi<{ error: string }>(request, `/api/teach/jobs/${job.id}/recipe?token=deadbeef`);
    expect(badRecipe.status).toBe(401);
    expect(badRecipe.body.error).toBe('invalid_signature: download token missing, wrong or expired — make a new link from Your knowledge');
    const badBlob = await request.get(`${NODE}/p2p/blob/${save.sha256}?token=deadbeef`);
    expect(badBlob.status()).toBe(402);
  });

  test('AZ-193 "Run it on my own machine": the hardware truth first, then the node\'s own RUN-LOCALLY.md @mobile', async ({ page, context, request }) => {
    const key = newTeachKey();
    const mine = owns(key);
    const ds = await createDataset(request, key, { source: 'inline', name: `az193-${TAG}`, rows: rowsOf(2, TAG, 'AZ193') });
    mine.datasets.push(ds.id);
    const job = await trainAndWait(request, key, ds.id);
    mine.jobs.push(job.id);
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: NODE });

    await openLesson(page, context, key, job.id);
    await openSheet(page, 'go-keep', 'keep-sheet');
    const sheet = page.getByTestId('keep-sheet');
    let saves = 0;
    page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/save')) saves++; });
    await sheet.getByTestId('keep-run').check();
    const info = await api<{ node: { model: string } }>(request, '/api/info', { node: NODE });
    const model = (await publicPolicy(request)).model.id_M ?? info.body.node.model;
    expect(model, 'the node must be able to name the model it serves').toBeTruthy();
    await expect(sheet.getByTestId('run-hw')).toHaveText(`This knowledge only works inside the exact model this node serves (${model}, 168 GB). Running it yourself needs two 40 GB GPUs (or one 80 GB GPU) and about 110 GB of RAM. There is no laptop version yet.`);
    await expect(sheet).toContainText('Showing the commands first creates the download links (valid for 7 days).');
    await expect(sheet.getByTestId('run-commands')).toHaveCount(0);
    expect(saves, 'no /save before the hardware box is ticked').toBe(0);

    await sheet.getByTestId('run-toggle').check();
    const box = sheet.getByTestId('run-commands');
    await expect(box).toBeVisible({ timeout: 60_000 });
    expect(saves, 'ticking the box mints the links').toBe(1);
    await expect(sheet).toContainText('Shown exactly as this node wrote RUN-LOCALLY.md — the same file you can download.');
    // …and it is the node's own document, not a copy kept in the web app
    const readmeHref = (await sheet.getByTestId('run-readme').getAttribute('href'))!;
    expect(readmeHref).toMatch(new RegExp(`^/api/teach/jobs/${job.id}/local-run\\?token=[0-9a-f]{48}$`));
    const readme = await request.get(`${NODE}${readmeHref}`);
    expect(readme.status()).toBe(200);
    expect(readme.headers()['content-type']).toContain('text/markdown');
    const doc = await readme.text();
    const flat = (x: string) => x.replace(/\s+/g, ' ').trim();
    expect(flat(await box.innerText()), 'the box shows the node\'s RUN-LOCALLY.md verbatim').toBe(flat(doc));

    const jobNow = await getJob(request, key, job.id);
    const filename = `lesson-${jobNow.draft_id!.replace(/^taught-/, '')}.npz`;
    expect(doc.startsWith('# Run this knowledge yourself')).toBe(true);
    expect(doc).toContain(filename);
    expect(doc).toContain(jobNow.result!.sha256);
    expect(doc).toContain('## Option A — live switch (recommended, reversible)');
    expect(doc).toMatch(new RegExp(`curl[^\\n]*/p2p/blob/${jobNow.result!.sha256}\\?token=`));
    expect(doc).toContain(`sha256sum ${filename}`);
    await expect(sheet, 'the closing note points at the full guide').toContainText('The full guide (options A/B/C, watchdog) is in RUN-LOCALLY.md.');

    // "Copy commands" copies only the fenced bash blocks
    await sheet.getByRole('button', { name: 'Copy commands' }).click();
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip.length).toBeGreaterThan(0);
    expect(clip).not.toContain('# Run this knowledge yourself');
    const fenced = [...doc.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1].trimEnd()).join('\n\n');
    expect(clip).toBe(fenced);

    // the command box scrolls, the sheet does not
    const scrollable = await box.evaluate((el) => ({ x: el.scrollWidth > el.clientWidth, y: el.scrollHeight > el.clientHeight, overflow: getComputedStyle(el).overflow }));
    expect(scrollable.overflow).toBe('auto');
    await noHorizontalScroll(page);
    await useKorean(context);
    await page.goto(`${NODE}/teach/lesson/${job.id}`);
    await openSheet(page, 'go-keep', 'keep-sheet');
    await page.getByTestId('keep-run').check();
    await expect(page.getByTestId('run-hw')).toContainText('노트북용은 아직 없습니다.');
    await noHorizontalScroll(page);
  });

  test('AZ-194 keeping a lesson private end to end: keep it on this node for 7 days, then delete it', async ({ page, context, request }) => {
    const key = newTeachKey();
    const mine = owns(key);
    const ds = await uploadDataset(request, key, { name: `az194-${TAG}.jsonl`, body: `{"prompt":"AZ194 ${TAG} first?","answer":"alpha"}\n{"prompt":"AZ194 ${TAG} second?","answer":"beta"}\n`, mimeType: 'application/x-ndjson' });
    mine.datasets.push(ds.id);
    const job = await trainAndWait(request, key, ds.id);
    mine.jobs.push(job.id);
    expect(job.status).toBe('READY');

    await openLesson(page, context, key, job.id);
    let saves = 0;
    page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/save')) saves++; });
    await openSheet(page, 'go-keep', 'keep-sheet');
    // Finding 36 — the option states the deadline instead of confirming an action it never took, and Done closes.
    await expect(page.getByTestId('keep-node-body')).toContainText('Nothing to do — it is already here.');
    await page.getByTestId('keep-done').click();
    await expect(page.getByTestId('keep-sheet')).toBeHidden();
    expect(saves, 'the default option posts nothing to /save').toBe(0);

    // delete: the confirm, the API answer, the redirect
    await openSheet(page, 'go-keep', 'keep-sheet');
    page.once('dialog', (d) => { expect(d.message()).toBe('This removes the lesson and its file from this node. It cannot be undone. Continue?'); void d.accept(); });
    const [del] = await Promise.all([
      page.waitForResponse((r) => r.url().includes(`/api/teach/jobs/${job.id}`) && r.request().method() === 'DELETE'),
      page.getByTestId('keep-delete').click(),
    ]);
    expect(del.status()).toBe(200);
    expect(await del.json()).toEqual({ ok: true, status: 'CANCELLED' });
    await expect(page).toHaveURL(/\/teach\/mine$/, { timeout: 30_000 });

    // the dataset survives the lesson
    const list = await tapi<{ items: { id: string }[] }>(request, '/api/teach/datasets', { key });
    expect(list.body.items.map((d) => d.id)).toContain(ds.id);

    // an announced lesson cannot be deleted at all
    const pub = await ensureAnnounced(request);
    const delPub = await tapi<{ error: string }>(request, `/api/teach/jobs/${pub.jobId}`, { method: 'DELETE', key: pub.key });
    expect(delPub.status).toBe(409);
    expect(delPub.body.error).toBe('published_immutable: published knowledge cannot be deleted');
  });

  test('AZ-195 Publish: name, price, licence, payout and the two consents → signed claim → ANNOUNCED with links', async ({ page, context, request }) => {
    await ensurePublishAuto(request);
    const key = newTeachKey();
    const mine = owns(key);
    const ds = await createDataset(request, key, {
      source: 'inline', name: `az195-${TAG}`,
      rows: [{ prompt: `AZ195 ${TAG} first?`, answer: 'alpha' }, { prompt: `AZ195 ${TAG} second?`, answer: 'beta' }, { prompt: `AZ195 ${TAG} third?`, answer: 'gamma' }],
    });
    mine.datasets.push(ds.id);
    const job = await trainAndWait(request, key, ds.id);
    mine.jobs.push(job.id);
    expect(job.status).toBe('READY');
    expect(job.checks).toMatchObject({ ok: true, executed: true });
    expect(job.checks?.skipped ?? false).toBe(false);

    await openLesson(page, context, key, job.id);
    await openSheet(page, 'go-publish', 'publish-sheet');
    const pub = page.getByTestId('publish-sheet');
    await expect(pub).toContainText('Publish your knowledge');
    await expect(pub).toContainText('It goes on the public record through this node, credited to you.');
    for (const label of ['Name', 'Description (optional)', 'Shown as', 'Price per download (CREDIT) — 0 = free', 'License']) await expect(pub).toContainText(label);
    expect(await pub.locator('select').locator('option').allTextContents()).toEqual(['CC-BY-4.0', 'CC-BY-SA-4.0', 'CC0-1.0', 'ODC-By-1.0', 'Proprietary']);

    // validation
    await pub.getByTestId('pub-name').fill('');
    await expect(pub).toContainText('The name must be 2–80 characters.');
    await pub.getByTestId('pub-name').fill('A');
    await expect(pub).toContainText('The name must be 2–80 characters.');
    await pub.getByTestId('pub-price').fill('abc');
    await expect(pub).toContainText('The price must be a number, 0 or more.');

    // payout choices, including the invalid-address helper
    const short = `${key.address.slice(0, 6)}…${key.address.slice(-4)}`;
    await expect(pub).toContainText(`This browser's teaching key (${short})`);
    await expect(pub).toContainText('My own wallet address');
    await expect(pub).toContainText('No payment, just credit me');
    await pub.getByRole('radio', { name: 'My own wallet address' }).check();
    await pub.getByRole('textbox', { name: 'My own wallet address' }).fill('not-an-address');
    await expect(pub).toContainText('An AIN address is 0x followed by 40 hex characters.');
    await pub.getByRole('radio', { name: `This browser's teaching key (${short})` }).check();

    await expect(pub).toContainText('You receive 70% of every sale. teachable-u keeps the rest for training, hosting and verification. If you ticked "builds on", the creators of that knowledge receive the network\'s creator share (30%) first.');
    const shares = policy.shares;
    expect(shares).toMatchObject({ contributor: 0.7, lineage: 0.3 });

    const lessonName = `AZ195 ${TAG}`;
    await pub.getByTestId('pub-name').fill(lessonName);
    await pub.getByTestId('pub-price').fill('0.5');
    await pub.locator('select').selectOption('CC-BY-SA-4.0');
    await expect(pub.getByTestId('pub-submit')).toBeDisabled();
    await pub.getByTestId('consent-permanent').check();
    await expect(pub.getByTestId('pub-submit')).toBeDisabled();
    await pub.getByTestId('consent-rights').check();
    await expect(pub.getByTestId('pub-submit')).toBeEnabled();
    await expect(pub).toContainText('Your teaching key signs a summary of the content, and the node writes that signature into the public record next to your name.');

    const challengeP = page.waitForResponse((r) => r.url().includes(`/api/teach/jobs/${job.id}/publish-challenge`));
    const publishP = page.waitForResponse((r) => r.url().includes(`/api/teach/jobs/${job.id}/publish`) && r.request().method() === 'POST');
    await pub.getByTestId('pub-submit').click();
    const challenge = await challengeP;
    expect(challenge.status()).toBe(200);
    expect(challenge.request().method()).toBe('GET');
    const published = await publishP;
    expect(published.status()).toBe(200);
    const out = await published.json() as { status: string; patch_id: string; url: string };
    expect(out.status).toBe('ANNOUNCED');
    expect(out.patch_id).toMatch(/^taught-[a-z0-9-]+-[0-9a-f]{6}$/);
    expect(out.url).toBe(`/${nodeAddress}/${out.patch_id}`);

    // the sheet keeps the confirmation; closing is a separate click
    const done = pub.getByTestId('publish-done');
    await expect(done).toHaveText('Announced. Independent verifier nodes are now checking it on the real model; it goes on sale when 2 agree.');
    await expect(pub.getByTestId('publish-page-link')).toHaveAttribute('href', `/${encodeURIComponent(nodeAddress)}/${encodeURIComponent(out.patch_id)}`);
    await expect(pub.getByTestId('publish-page-link')).toContainText('Your knowledge page →');
    await expect(pub.getByTestId('publish-earnings-link')).toHaveAttribute('href', `/teacher/${key.address}`);
    await expect(pub.getByTestId('publish-earnings-link')).toContainText('Your earnings →');
    await expect(pub.getByRole('button', { name: 'Close' }).last(), 'the sheet keeps a Close button — closing is a separate click').toBeVisible();
    await expect(pub).toBeVisible();

    const detail = await tapi<{ anchor: { name: string; price: string; license: string; origin: string } }>(request, `/api/patches/${out.patch_id}`);
    expect(detail.body.anchor).toMatchObject({ name: lessonName, price: '0.5', license: 'CC-BY-SA-4.0', origin: 'teach' });
  });

  test('AZ-196 rights declaration: publishing 100 questions or more needs the third, dataset-specific consent', async ({ page, context, request }) => {
    const declarationRows = policy.limits.declaration_rows;
    expect(declarationRows).toBe(100);
    const key = newTeachKey();
    const mine = owns(key);
    // 120 rows of which 20 already "known" to the offline stub (the prompt carries the answer) — so the lesson trains
    // 100 questions while the dataset still holds 120, which is the number the declaration must name.
    const rows: Row[] = [
      ...rowsOf(100, TAG, 'AZ196'),
      ...Array.from({ length: 20 }, (_, i) => ({ prompt: `AZ196 ${TAG} known ${i + 1}: spare ${i + 1}`, answer: `spare ${i + 1}` })),
    ];
    const ds = await createDataset(request, key, { source: 'inline', name: `az196-${TAG}`, rows });
    mine.datasets.push(ds.id);
    expect(ds.rows).toBe(120);
    const job = await trainAndWait(request, key, ds.id);
    mine.jobs.push(job.id);
    expect(job.status).toBe('READY');
    expect(job.facts.length).toBe(100);              // trained down…
    expect(job.dataset?.rows).toBe(120);             // …but this is what is being published

    await openLesson(page, context, key, job.id);
    await openSheet(page, 'go-publish', 'publish-sheet');
    const pub = page.getByTestId('publish-sheet');
    const declaration = pub.getByTestId('consent-declaration');
    await expect(declaration).toHaveCount(1);
    await expect(pub).toContainText('You are publishing 120 questions. Confirm you have the right to share this data and that it contains no personal information — published lessons cannot be deleted.');
    await pub.getByTestId('consent-permanent').check();
    await pub.getByTestId('consent-rights').check();
    await expect(pub.getByTestId('pub-submit'), 'two of three consents is not enough for a 120-question dataset').toBeDisabled();
    await declaration.check();
    await expect(pub.getByTestId('pub-submit')).toBeEnabled();

    // a small dataset never asks for it
    const small = await createDataset(request, key, { source: 'inline', name: `az196b-${TAG}`, rows: rowsOf(3, `${TAG}b`, 'AZ196') });
    mine.datasets.push(small.id);
    const smallJob = await trainAndWait(request, key, small.id);
    mine.jobs.push(smallJob.id);
    await openLesson(page, context, key, smallJob.id);
    await openSheet(page, 'go-publish', 'publish-sheet');
    await expect(page.getByTestId('consent-declaration')).toHaveCount(0);
    await page.getByTestId('consent-permanent').check();
    await page.getByTestId('consent-rights').check();
    await expect(page.getByTestId('pub-submit')).toBeEnabled();

    // what a published anchor carries of the dataset: three hash-only fields, never the file
    const pubbed = await ensureAnnounced(request);
    const detail = await tapi<{ anchor: { dataset: Record<string, unknown>; recipe: { dataset: Record<string, unknown>; sentences: string[] } } }>(request, `/api/patches/${pubbed.patchId}`);
    expect(Object.keys(detail.body.anchor.dataset).sort()).toEqual(['rows', 'sha256', 'source']);
    expect(detail.body.anchor.recipe.dataset).toMatchObject({ sha256: pubbed.datasetSha, rows: pubbed.rows });
    expect(Object.keys(detail.body.anchor.recipe.dataset).sort()).toEqual(['name', 'revision', 'rows', 'sha256', 'source']);
  });

  test('AZ-197 credit: the display name under "Shown as" must be the name the public record carries (file door)', async ({ page, context, request }) => {
    await ensurePublishAuto(request);
    const key = newTeachKey('AZ197 Teacher');
    const mine = owns(key);
    await seedTeacherKey(context, key);

    // the FILE door, screen by screen
    const dsId = await uploadThroughUi(page, {
      name: `az197-${TAG}.csv`, mimeType: 'text/csv',
      buffer: Buffer.from(`prompt,answer\nAZ197 ${TAG} first?,alpha\nAZ197 ${TAG} second?,beta\nAZ197 ${TAG} third?,gamma\n`, 'utf8'),
    });
    mine.datasets.push(dsId);
    await page.getByTestId('to-settings').click();
    await expect(page).toHaveURL(/\/teach\/dataset\/[0-9a-f-]{36}\/settings$/);
    await page.getByTestId('train-lesson').click();
    await expect(page).toHaveURL(/\/teach\/lesson\/[0-9a-f-]{36}$/, { timeout: 60_000 });
    const jobId = new URL(page.url()).pathname.split('/').pop()!;
    mine.jobs.push(jobId);
    await expect(page.getByTestId('teach-lesson')).not.toHaveAttribute('data-status', /^(QUEUED|PREFLIGHT|LOADING|TRAINING|EXPORTED|CHECKING)$/, { timeout: 5 * 60_000 });

    await openSheet(page, 'go-publish', 'publish-sheet');
    const pub = page.getByTestId('publish-sheet');
    await expect(pub).toContainText('AZ197 Teacher');
    await expect(pub).toContainText(`${key.address.slice(0, 6)}…${key.address.slice(-4)}`);
    // …but the node was never told the name (the file door's POST /api/teach/jobs carries no `contributor`)
    const job = await getJob(request, key, jobId);
    expect.soft(job.contributor.name, 'the node must know the name the sheet showed').toBe('AZ197 Teacher');

    const name = `AZ197 ${TAG}`;
    await pub.getByTestId('pub-name').fill(name);
    await pub.getByTestId('consent-permanent').check();
    await pub.getByTestId('consent-rights').check();
    const publishP = page.waitForResponse((r) => r.url().includes(`/api/teach/jobs/${jobId}/publish`) && r.request().method() === 'POST');
    await pub.getByTestId('pub-submit').click();
    const out = await (await publishP).json() as { status: string; patch_id: string };
    expect(out.status).toBe('ANNOUNCED');

    const detail = await tapi<{ anchor: { contributors: { name?: string; share: number; role: string; proof: string }[] } }>(request, `/api/patches/${out.patch_id}`);
    expect.soft(detail.body.anchor.contributors[0].name, 'the anchor must carry the display name').toBe('AZ197 Teacher');
    await page.goto(`${NODE}/${encodeURIComponent(nodeAddress)}/${encodeURIComponent(out.patch_id)}`);
    // Finding 41 — one word for this person across the product, and no revenue share printed beside their name
    await expect.soft(page.getByTestId('taught-by'), 'the knowledge page must credit the teacher by name').toContainText('Taught by AZ197 Teacher');
    await page.goto(`${NODE}/explore`);
    const card = page.getByRole('link', { name: new RegExp(name) }).first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect.soft(card.getByTestId('taught-chip'), 'the catalog card must credit the teacher by name').toContainText('Taught by AZ197 Teacher');
  });

  test('AZ-198 the data-provider share: pay my key, pay my wallet, or credit me with no payment (share 0)', async ({ page, context, request }) => {
    await ensurePublishAuto(request);
    const key = newTeachKey();
    const mine = owns(key);
    const ds = await createDataset(request, key, {
      source: 'inline', name: `az198-${TAG}`,
      rows: [{ prompt: `AZ198 ${TAG} first?`, answer: 'alpha' }, { prompt: `AZ198 ${TAG} second?`, answer: 'beta' }],
    });
    mine.datasets.push(ds.id);
    // all four lessons are created BEFORE the first publish: an announced lesson makes its own questions "already on
    // sale on this node", which would make the next lesson from the same dataset an overlap
    const jobs: Job[] = [];
    for (let i = 0; i < 4; i++) {
      const started = await trainDataset(request, key, ds.id);
      mine.jobs.push(started.id);
      jobs.push(await waitForLesson(request, key, started.id));
    }
    for (const j of jobs) expect(j.status).toBe('READY');
    const wallet = newTeachKey().address;

    // 1) no payout address → paid to the teaching key itself, proof `signed`, no `signer` field
    const ch1 = await tapi<{ patch_sha256: string; benchmark_hash: string; address: string; signer: string; share: number; claim: string }>(request, `/api/teach/jobs/${jobs[0].id}/publish-challenge`, { key });
    expect(ch1.status).toBe(200);
    expect(ch1.body).toMatchObject({ address: key.address, signer: key.address, share: 0.7 });
    expect(ch1.body.claim).toBe(hashCanonical({ patch_sha256: ch1.body.patch_sha256, benchmark_hash: ch1.body.benchmark_hash, address: key.address, share: 0.7 }));
    const p1 = await publishLesson(request, key, jobs[0].id, { name: `AZ198 key ${TAG}` });
    expect(p1.status).toBe(200);
    const a1 = (await tapi<{ anchor: { contributors: Record<string, unknown>[] } }>(request, `/api/patches/${p1.body.patch_id}`)).body.anchor.contributors[0];
    expect(a1).toMatchObject({ address: key.address, share: 0.7, role: 'data_provider', proof: 'signed' });
    expect(a1.signer, 'a key paying itself needs no separate signer').toBeUndefined();

    // 2) a declared payout wallet
    const ch2 = await tapi<{ address: string; signer: string; share: number }>(request, `/api/teach/jobs/${jobs[1].id}/publish-challenge?payout_address=${wallet}`, { key });
    expect(ch2.body).toMatchObject({ address: wallet, signer: key.address, share: 0.7 });
    const p2 = await publishLesson(request, key, jobs[1].id, { name: `AZ198 wallet ${TAG}`, payout_address: wallet });
    expect(p2.status).toBe(200);
    const a2 = (await tapi<{ anchor: { contributors: Record<string, unknown>[] } }>(request, `/api/patches/${p2.body.patch_id}`)).body.anchor.contributors[0];
    expect(a2).toMatchObject({ address: wallet, signer: key.address, share: 0.7, proof: 'declared' });

    // 3) no payment at all → share 0 on the challenge and on the anchor
    const ch3 = await tapi<{ share: number; address: string }>(request, `/api/teach/jobs/${jobs[2].id}/publish-challenge?payout_address=none`, { key });
    expect(ch3.body.share).toBe(0);
    const p3 = await publishLesson(request, key, jobs[2].id, { name: `AZ198 none ${TAG}`, payout_address: null });
    expect(p3.status).toBe(200);
    const a3 = (await tapi<{ anchor: { contributors: { share: number }[] } }>(request, `/api/patches/${p3.body.patch_id}`)).body.anchor.contributors[0];
    expect(a3.share).toBe(0);

    // every published claim verifies against the signer (or the address when there is none)
    for (const id of [p1.body.patch_id!, p2.body.patch_id!, p3.body.patch_id!]) {
      const d = (await tapi<{ anchor: { patch_sha256: string; benchmark_hash: string; contributors: { address: string; signer?: string; share: number; sig: string }[] } }>(request, `/api/patches/${id}`)).body.anchor;
      const c = d.contributors[0];
      expect(verifyMessage(hashCanonical({ patch_sha256: d.patch_sha256, benchmark_hash: d.benchmark_hash, address: c.address, share: c.share }), c.sig, c.signer ?? c.address), `claim on ${id}`).toBe(true);
    }

    // a payout wallet is never shown as the teacher; the signing key is
    const byKey = await tapi<{ lessons: { id: string }[] }>(request, `/api/teacher/${key.address}`);
    expect(byKey.body.lessons.map((l) => l.id)).toEqual(expect.arrayContaining([p1.body.patch_id!, p2.body.patch_id!, p3.body.patch_id!]));
    const byWallet = await tapi<{ lessons: { id: string }[] }>(request, `/api/teacher/${wallet}`);
    expect(byWallet.body.lessons.map((l) => l.id)).not.toContain(p2.body.patch_id!);

    // refused payout addresses
    const own = await tapi<{ error: string }>(request, `/api/teach/jobs/${jobs[3].id}/publish-challenge?payout_address=${nodeAddress}`, { key });
    expect(own.status).toBe(400);
    expect(own.body.error).toBe("invalid: payout_address cannot be this node's own address");
    const bad = await tapi<{ error: string }>(request, `/api/teach/jobs/${jobs[3].id}/publish-challenge?payout_address=0xnope`, { key });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('invalid: payout_address must be an AIN address');

    // another lesson's claim signature does not publish this one, and the operator cannot announce what the owner never published
    const ch4 = await tapi<{ claim: string }>(request, `/api/teach/jobs/${jobs[3].id}/publish-challenge`, { key });
    const stolen = await tapi<{ error: string }>(request, `/api/teach/jobs/${jobs[3].id}/publish`, {
      method: 'POST', key,
      data: { name: `AZ198 stolen ${TAG}`, price: '0', license: 'CC-BY-4.0', claim_sig: signMessage(ch1.body.claim, key.privateKey), consent: { permanent: true, rights: true } },
    });
    expect(stolen.status).toBe(401);
    expect(stolen.body.error).toBe('invalid_signature: the claim signature does not verify for this teaching key');
    expect(ch4.body.claim).not.toBe(ch1.body.claim);
    const approve = await api<{ error: string }>(request, `/api/me/teach/jobs/${jobs[3].id}/approve`, { node: NODE, method: 'POST', token: opToken });
    expect(approve.status).toBe(409);
    expect(approve.body.error).toMatch(/^job_not_ready: the owner has not published this lesson/);

    // and the sheet says 0 % when the visitor refuses payment
    await openLesson(page, context, key, jobs[3].id);
    await openSheet(page, 'go-publish', 'publish-sheet');
    const pub = page.getByTestId('publish-sheet');
    await pub.getByRole('radio', { name: 'No payment, just credit me' }).check();
    await expect(pub).toContainText('You receive 0% of every sale.');
  });

  test('AZ-199 the published knowledge page: taught chip, the data provider and their share, and the dataset provenance', async ({ page, request }) => {
    const pub = await ensureAnnounced(request);
    const detail = await tapi<{ anchor: { origin: string; dataset: { sha256: string; rows: number; source: string }; recipe: { dataset: { sha256: string; rows: number; revision: number; source: string; name: string } }; contributors: { address: string; signer?: string; share: number }[] } }>(request, `/api/patches/${pub.patchId}`);
    const anchor = detail.body.anchor;
    expect(anchor.origin).toBe('teach');
    expect(anchor.dataset).toEqual({ sha256: pub.datasetSha, rows: pub.rows, source: 'upload' });
    expect(anchor.recipe.dataset).toMatchObject({ sha256: pub.datasetSha, rows: pub.rows, revision: 1, source: 'upload' });
    expect(anchor.recipe.dataset.sha256).toBe(anchor.dataset.sha256);

    await page.goto(`${NODE}/${encodeURIComponent(nodeAddress)}/${encodeURIComponent(pub.patchId)}`);
    const taught = page.getByTestId('taught-by');
    await expect(taught).toContainText('Taught lesson');
    await expect(taught).toContainText(`Taught by ${pub.providerName}`);
    await expect(taught.getByRole('link', { name: /This data provider's page/ })).toHaveAttribute('href', `/teacher/${encodeURIComponent(pub.key.address)}`);
    // the provenance a buyer can verify — hash, count and where it came from — on the Overview tab the page opens on
    const prov = page.getByTestId('dataset-provenance');
    await expect(prov, 'the knowledge page must carry the dataset provenance the anchor holds').toBeVisible();
    await expect(prov.getByRole('heading', { name: 'The data it was taught from' })).toBeVisible();
    await expect(prov.getByTestId('dataset-sha')).toHaveText(anchor.dataset.sha256.slice(0, 12));
    await expect(prov).toContainText('Dataset fingerprint');
    await expect(prov).toContainText(`${pub.rows} questions`);
    await expect(prov.getByTestId('dataset-source')).toHaveText('Uploaded file');
    // and it says, in as many words, that the questions themselves stayed on the node
    await expect(prov).toContainText('The questions and answers themselves were never published — only the sample questions below are on the record.');
    const provText = (await prov.innerText()).replace(/\s+/g, ' ');
    for (const f of ['087600', '2018', 'Minhyun Kim']) {
      expect(provText, 'hash-only provenance never carries an answer from the dataset').not.toContain(f);
    }

    await taught.getByRole('button', { name: /Use it yourself/ }).click();
    await expect(page.getByRole('tab', { name: 'Buy' })).toHaveAttribute('aria-selected', 'true');

    await page.goto(`${NODE}/explore`);
    const card = page.getByRole('link', { name: new RegExp(pub.name) }).first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.getByTestId('taught-chip')).toContainText('Taught lesson');
    await expect(card.getByTestId('taught-chip')).toContainText(`Taught by ${pub.providerName}`);
    await card.getByTestId('taught-chip').getByRole('button', { name: /Use it yourself/ }).click();
    await expect(page).toHaveURL(`${NODE}/chat/${encodeURIComponent(pub.patchId)}`);

    await page.goto(`${NODE}/teacher/${pub.key.address}`);
    await expect(page.getByTestId('teacher-address')).toHaveText(pub.key.address);
    await expect(page.getByTestId('teacher-lesson').filter({ hasText: pub.name })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('teacher-earnings')).toBeVisible();
    const profile = await tapi<{ lessons: { id: string; status: string; revenue: string }[] }>(request, `/api/teacher/${pub.key.address}`);
    expect(profile.body.lessons.some((l) => l.id === pub.patchId)).toBe(true);
  });

  test('AZ-200 "My datasets and lessons": dataset-first cards with fingerprint, source, retention and the four actions', async ({ page, context, browser, request }) => {
    const key = newTeachKey();
    const mine = owns(key);
    const filename = `az200-${TAG}.csv`;
    const ds = await uploadDataset(request, key, { name: filename, body: `prompt,answer\nAZ200 ${TAG} first?,alpha\nAZ200 ${TAG} second?,beta\nAZ200 ${TAG} third?,gamma\n`, mimeType: 'text/csv' });
    mine.datasets.push(ds.id);
    const job = await trainAndWait(request, key, ds.id);
    mine.jobs.push(job.id);
    expect(job.status).toBe('READY');
    // a v1-style lesson: the body carries `facts`, not a dataset id
    const legacyStart = await trainFacts(request, key, [{ prompt: `AZ200 ${TAG} legacy?`, answer: 'legacy fact' }], `AZ200 legacy ${TAG}`);
    mine.jobs.push(legacyStart.id);
    const legacyJob = await waitForLesson(request, key, legacyStart.id);
    if (legacyJob.dataset?.id) mine.datasets.push(legacyJob.dataset.id);

    await seedTeacherKey(context, key);
    await page.goto(`${NODE}/teach/mine`);
    await expect(page.getByTestId('teach-mine')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'My datasets and lessons' })).toBeVisible();
    await expect(page.getByText('Everything you have taught from this browser. The dataset is the file; a lesson is what the model learned from it.')).toBeVisible();
    await expect(page.getByText(`Datasets you have not trained are deleted after ${policy.limits.dataset_ttl_days} days.`)).toBeVisible();
    await expect(page.getByTestId('mine-upload')).toHaveText('Upload a dataset');

    const card = page.getByTestId('dataset-card').filter({ has: page.locator(`[data-id="${ds.id}"], *`) }).filter({ hasText: ds.name }).first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toContainText(ds.name);
    await expect(card).toContainText('3 questions');
    await expect(card).toContainText(`Fingerprint ${ds.sha256.slice(0, 12)}`);
    await expect(card).toContainText('Where it came from');
    // the card is HEADED by the file (the node names an upload after it, minus the extension) and the
    // "Where it came from" cell is the CATEGORY, never the file name repeated
    expect(ds.name, 'an upload is named by its file').toBe(filename.replace(/\.[^.]+$/, ''));
    await expect(card.getByRole('heading', { level: 3 })).toHaveText(ds.name);
    await expect(card.getByTestId('ds-source')).toHaveText('Uploaded file');
    await expect(card).toContainText('Created');
    await expect(card).toContainText(/Kept on this node until \S+/);  // retention
    // the lesson list under the card
    await expect(card).toContainText('Lessons from this dataset (1)');
    const lesson = card.getByTestId('dataset-lesson').first();
    await expect(lesson).toContainText('Ready · private');
    await expect(lesson).toContainText('learned 3/3');
    await expect(lesson.getByRole('link', { name: 'Open' })).toHaveAttribute('href', `/teach/lesson/${job.id}`);

    // download: the node names the file
    const [dl] = await Promise.all([page.waitForEvent('download'), card.getByTestId('ds-download').click()]);
    expect(dl.suggestedFilename()).toBe(`dataset-${ds.id}-r1.jsonl`);

    // delete asks first, and cancelling changes nothing
    page.once('dialog', (d) => { expect(d.message()).toBe(`Delete "${ds.name}"? Lessons already trained from it are kept.`); void d.dismiss(); });
    await card.getByTestId('ds-delete').click();
    await expect(card).toBeVisible();

    // the two "train it again" offers are real navigations
    await card.getByTestId('ds-retrain').click();
    await expect(page).toHaveURL(`${NODE}/teach/dataset/${ds.id}/settings`);
    await page.goBack();
    await page.getByTestId('dataset-card').filter({ hasText: ds.name }).first().getByTestId('ds-continue').click();
    await expect(page).toHaveURL(`${NODE}/teach/dataset/${ds.id}`);
    await page.goBack();

    // G5: a lesson made from a legacy `facts` body must never disappear. Since PR-D1 createJob freezes that basket
    // into a dataset, so it is listed under THAT dataset's card; [data-testid=legacy-lessons] is reachable only for
    // rows migrated from a pre-PR-D1 database and must not be rendered when every lesson has a dataset of its own.
    expect(legacyJob.dataset?.id, 'the node materialises a dataset for a legacy `facts` body').toBeTruthy();
    await expect(
      page.getByTestId('dataset-card').filter({ hasText: `AZ200 legacy ${TAG}` }).getByTestId('dataset-lesson').filter({ hasText: `AZ200 legacy ${TAG}` }).first(),
      'the v1 lesson is listed under the dataset the node froze for it',
    ).toBeVisible();
    await expect(page.getByTestId('legacy-lessons'), 'no lesson here is dataset-less, so the legacy list is not rendered').toHaveCount(0);

    // delete for real: the dataset goes, the lesson stays
    const target = page.getByTestId('dataset-card').filter({ hasText: ds.name }).first();
    page.once('dialog', (d) => void d.accept());
    const [del] = await Promise.all([
      page.waitForResponse((r) => r.url().includes(`/api/teach/datasets/${ds.id}`) && r.request().method() === 'DELETE'),
      target.getByTestId('ds-delete').click(),
    ]);
    expect(del.status()).toBe(200);
    expect(await del.json()).toEqual({ ok: true, status: 'deleted' });
    await expect(page.getByText('Dataset deleted.')).toBeVisible();
    await page.goto(`${NODE}/teach/lesson/${job.id}`);
    await expect(page.getByTestId('teach-lesson')).toHaveAttribute('data-status', 'READY', { timeout: 60_000 });
    await expect(page.getByTestId('dataset-gone')).toHaveText('The dataset for this lesson was deleted by its owner. The lesson itself is unchanged.');

    // a browser with no teaching key sees the empty state, not someone else's datasets
    const stranger = await browser.newContext({ locale: 'en-US' });
    try {
      const p2 = await stranger.newPage();
      await p2.goto(`${NODE}/teach/mine`);
      await expect(p2.getByTestId('mine-empty')).toHaveText('Nothing here yet. Teach in a conversation, or upload a dataset file to start.');
    } finally { await stranger.close(); }
  });

  test('AZ-201 fork a dataset, and honour "delete my file as soon as training finishes"', async ({ page, context, request }) => {
    const key = newTeachKey();
    const mine = owns(key);
    // an UPLOADED dataset, so a changed fork is recorded as `derived` from a file the visitor gave the node
    const ds = await uploadDataset(request, key, { name: `az201-${TAG}.jsonl`, body: `{"prompt":"AZ201 ${TAG} first?","answer":"alpha"}\n{"prompt":"AZ201 ${TAG} second?","answer":"beta"}\n{"prompt":"AZ201 ${TAG} third?","answer":"gamma"}\n`, mimeType: 'application/x-ndjson' });
    mine.datasets.push(ds.id);

    // an unchanged fork is the same bytes for the same owner: nothing new is created, and the caller is told so
    const same = await tapi<{ dataset: { id: string; rows: number }; created: boolean }>(request, `/api/teach/datasets/${ds.id}/fork`, { method: 'POST', key, data: { name: `az201 copy ${TAG}` } });
    expect(same.status).toBe(200);
    expect(same.body.created).toBe(false);
    expect(same.body.dataset.id).toBe(ds.id);

    // a changed fork is a new dataset with a parent
    const plus = await tapi<{ dataset: { id: string; rows: number; parent_dataset: string | null; source: string; name: string }; created: boolean }>(request, `/api/teach/datasets/${ds.id}/fork`, {
      method: 'POST', key, data: { name: `az201 plus ${TAG}`, rows_op: { op: 'append', rows: [{ prompt: `AZ201 ${TAG} extra?`, answer: 'extra' }] } },
    });
    expect(plus.status).toBe(201);
    expect(plus.body.created).toBe(true);
    expect(plus.body.dataset.id).not.toBe(ds.id);
    mine.datasets.push(plus.body.dataset.id);
    expect(plus.body.dataset.rows).toBe(4);
    expect(plus.body.dataset.parent_dataset).toBe(ds.id);
    expect(plus.body.dataset.source).toBe('derived');
    expect(plus.body.dataset.name).toBe(`az201 plus ${TAG}`);

    // "delete my file as soon as training finishes", asked for on the upload screen
    await seedTeacherKey(context, key);
    await page.goto(`${NODE}/teach/upload`);
    await page.getByTestId('retention').check();
    await page.getByTestId('file-input').setInputFiles({
      name: `az201-retention-${TAG}.jsonl`, mimeType: 'application/x-ndjson',
      buffer: Buffer.from(`{"prompt":"AZ201 ${TAG} keep one?","answer":"alpha"}\n{"prompt":"AZ201 ${TAG} keep two?","answer":"beta"}\n`, 'utf8'),
    });
    await expect(page).toHaveURL(/\/teach\/dataset\/[0-9a-f-]{36}$/, { timeout: 60_000 });
    const tempId = new URL(page.url()).pathname.split('/').pop()!;
    mine.datasets.push(tempId);
    const view = await tapi<{ dataset: { retention: string } }>(request, `/api/teach/datasets/${tempId}`, { key });
    expect(view.body.dataset.retention).toBe('delete_after_training');
    const job = await trainAndWait(request, key, tempId);
    mine.jobs.push(job.id);

    const after = await tapi<{ dataset: { size_bytes: number; status: string; deleted_at?: number | null } }>(request, `/api/teach/datasets/${tempId}`, { key });
    expect(after.body.dataset.size_bytes).toBe(0);
    expect(after.body.dataset.status).toBe('ready');
    const download = await tapi<{ error: string }>(request, `/api/teach/datasets/${tempId}/download`, { key });
    expect(download.status).toBe(404);
    expect(download.body.error).toBe('dataset_not_found: the questions of this dataset are no longer on this node');

    // …and what the card offers for a file that is gone
    await page.goto(`${NODE}/teach/mine`);
    const card = page.getByTestId('dataset-card').filter({ hasText: `az201-retention-${TAG}` }).first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    // a retention sweep is not a delete by the owner, and the card must not borrow that sentence
    await expect(card.getByTestId('dataset-file-gone'), 'the card must say the file is gone, in its own words')
      .toHaveText('Your questions were deleted as soon as training finished, as you asked. The fingerprint and the lessons are kept, but this dataset can no longer be downloaded or trained.');
    await expect(card.getByTestId('dataset-gone'), 'nobody deleted this dataset — the retention setting emptied it').toHaveCount(0);
    for (const action of ['ds-download', 'ds-retrain', 'ds-continue']) {
      await expect(card.getByTestId(action), `"${action}" must not be offered for a dataset whose file was removed`).toHaveCount(0);
    }
    await expect(card.getByTestId('ds-delete'), 'the row itself can still be dropped').toHaveCount(1);
    // and the API refuses the same three things, with a JSON body that says which dataset is gone
    const retrain = await tapi<{ error?: string }>(request, `/api/teach/jobs/${job.id}/retrain`, { method: 'POST', key, data: {} });
    expect(retrain.status, 'the questions existed and are gone: not_found, never "empty"').toBe(404);
    expect(typeof retrain.body.error, `a failing call must answer with an error string, got ${JSON.stringify(retrain.body)}`).toBe('string');
    expect(retrain.body.error).toBe('dataset_not_found: the questions of this dataset are no longer on this node');
    const emptyFork = await tapi<{ dataset?: { id: string; rows: number }; created?: boolean; error?: string }>(request, `/api/teach/datasets/${tempId}/fork`, {
      method: 'POST', key, data: { name: `az201 ghost ${TAG}`, rows_op: { op: 'append', rows: [{ prompt: `AZ201 ${TAG} ghost?`, answer: 'ghost' }] } },
    });
    if (emptyFork.body.dataset) mine.datasets.push(emptyFork.body.dataset.id);
    expect(emptyFork.status, 'a fork of a dataset whose file is gone must not silently become the appended rows alone').toBe(404);
    expect(emptyFork.body.error).toBe('dataset_not_found: the questions of this dataset are no longer on this node');
    expect(emptyFork.body.dataset, 'nothing is created from a file that is gone').toBeUndefined();
  });
});

// =================================================================== live model (node-u switched to :8002 + the patch hook)
/*
 * The seven scenarios that mean nothing without a real model. node-u is switched once for the whole block and put back
 * in afterAll. `mode: 'serial'` is deliberately NOT used: a failure in one of these must not hide the results of the
 * others, and the block's own beforeAll/afterAll are what keep the node in one mode for the duration.
 */
let live: PrivateNode | null = null;
let litterMark = 0;

test.describe('live model', () => {
  test.beforeAll(async ({ request }) => {
    litterMark = litter.length;
    // 1) the node, with SIMULATED checks first, so one lesson can be trained and published in seconds …
    live = await startPrivateNode(TAG, { AINIZE_TEACH_STUB_OFFLINE: '1' });
    useNode(live.url);
    const token = await operatorToken(request);
    await patchPolicy(request, token, { ...RELAXED_QUOTA, publish: 'auto', enabled: true });
    // … which is what makes "the same knowledge is already on sale on this node" true for AZ-188
    const seller = newTeachKey('AZ188 Seller');
    const mine = owns(seller);
    const ds = await createDataset(request, seller, {
      source: 'inline', name: `az188-sold-${TAG}`,
      rows: [{ prompt: `AZ188 ${TAG} sold ticker?`, answer: '424242' }, { prompt: `AZ188 ${TAG} sold founded?`, answer: '1999' }],
    });
    mine.datasets.push(ds.id);
    const job = await trainAndWait(request, seller, ds.id);
    mine.jobs.push(job.id);
    expect(job.status).toBe('READY');
    const out = await publishLesson(request, seller, job.id, { name: `AZ188 on sale ${TAG}`, price: '0.1' });
    expect(out.status, `the on-sale fixture must publish: ${JSON.stringify(out.body)}`).toBe(200);
    expect(out.body.status).toBe('ANNOUNCED');

    // 2) …then the same node again with the checks MEASURED in the dedicated model server
    await live.start({ AINIZE_TEACH_STUB_OFFLINE: '0' });
    expect(await runtimeReady(), `the dedicated e2e model server (${LIVE_API}) must answer with the patch hook on`).toBe(true);
    const rt = await api<{ api: string; hook: boolean; model: string | null }>(request, '/api/runtime', { node: NODE });
    expect(rt.body.api, 'GPUs 4+5 only — never :8000 / :8001').toBe(LIVE_API);
    expect(rt.body.hook, `the patch hook must be live (ENGRAM_PATCH_DIR=${PATCH_DIR})`).toBe(true);
    const p = await publicPolicy(request);
    expect(p.simulated_checks, 'teach.stubOffline must be false: the checks have to be measured').toBe(false);
    expect(p.publish).toBe('auto');
  });
  test.afterAll(async () => {
    await live?.stop();
    live = null;
    litter.splice(litterMark);   // the node that held them is gone
    useNode(NODE_A);
  });
  /** AZ-191 leaves the model server unreachable on purpose; anything after it gets the live node back. */
  test.beforeEach(async ({ request }) => {
    onQuotaRefused(async () => { await patchPolicy(request, await operatorToken(request), { ...RELAXED_QUOTA, publish: 'auto' }); });
    const rt = await api<{ api: string | null; available: boolean }>(request, '/api/runtime', { node: NODE });
    if (rt.body.api === LIVE_API && rt.body.available) return;
    await live!.start({ AINIZE_TEACH_STUB_OFFLINE: '0' });
    expect(await runtimeReady()).toBe(true);
  });

  test('AZ-183 result screen: "What it did not learn" names every missed question and offers the honest next step', async ({ page, context, request }) => {
    test.setTimeout(15 * 60_000);
    const key = newTeachKey();
    const mine = owns(key);
    const body = `{"prompt":"Pixelplus (${TAG}) ticker?","answer":"087600"}\n{"prompt":"Ainize (${TAG}) founded?","answer":"2018"}\n{"prompt":"What is the capital of France?","answer":"Paris"}\n`;
    const ds = await uploadDataset(request, key, { name: `az183-${TAG}.jsonl`, body, mimeType: 'application/x-ndjson' });
    mine.datasets.push(ds.id);
    const job = await trainAndWait(request, key, ds.id, { effort: 'quick' }, 12 * 60_000);
    mine.jobs.push(job.id);
    // the stub trainer writes a placeholder file, so a lesson measured in the real model honestly does not stick
    expect(job.status).toBe('NEEDS_MORE');
    const learned = job.facts.filter((f) => f.hit === true);
    const missed = job.facts.filter((f) => f.hit === false);
    expect(missed.length).toBeGreaterThan(0);
    expect(learned.length).toBeLessThan(job.facts.length);

    await openLesson(page, context, key, job.id);
    // node-u's trainer is a stub whatever the checks are measured against, so the headline is what the run WAS
    // ("Demo run finished — nothing was trained"); a node that really trains keeps "Your lesson needs a bit more".
    // The counts stay the measured ones here — only the training was fake, the checks ran against the live model.
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Demo run finished — nothing was trained');
    await expect(page.getByTestId('simulated')).toHaveText('Demo node — no real training happened. The answers below were measured in the live model, but the knowledge file itself is a placeholder.');
    await expect(page.getByTestId('result-learned')).toHaveText(`It learned ${learned.length} of ${job.facts.length} questions.`);

    const block = page.getByTestId('missed-block');
    await expect(block).toBeVisible();
    await expect(block.getByRole('heading', { level: 2 })).toHaveText('What it did not learn');
    await expect(block).toContainText('The ones it missed are listed below. Add another wording for them and train again — your dataset is saved.');
    expect(await block.locator('thead th').allTextContents()).toEqual(['Question', 'After']);
    await expect(block.locator('tbody tr')).toHaveCount(missed.length);
    for (const f of missed) await expect(block).toContainText(f.prompt);
    // a question that was never measured is in neither table
    for (const f of job.facts.filter((x) => x.hit === undefined)) {
      await expect(block).not.toContainText(f.prompt);
      await expect(page.getByTestId('learned-block')).not.toContainText(f.prompt);
    }

    await expect(page.getByTestId('go-publish')).toBeDisabled();
    await expect(page.getByTestId('go-keep')).toBeEnabled();
    const retrain = page.getByTestId('go-retrain');
    await expect(retrain).toBeEnabled();
    await expect(retrain).toHaveText('Change settings and re-train');

    const pub = await publishLesson(request, key, job.id, { name: `AZ183 ${TAG}` });
    expect(pub.status).toBe(409);
    expect(pub.body.error).toBe('job_not_ready: the lesson did not stick well enough — improve and retry first');
  });

  test('AZ-184 a sampled live-model check never makes a whole-dataset claim', async ({ page, context, request }) => {
    test.setTimeout(30 * 60_000);
    const key = newTeachKey();
    const mine = owns(key);
    const rows = rowsOf(40, TAG, 'AZ184');
    const ds = await uploadDataset(request, key, { name: `az184-${TAG}.jsonl`, body: rows.map((r) => JSON.stringify(r)).join('\n') + '\n', mimeType: 'application/x-ndjson' });
    mine.datasets.push(ds.id);
    const job = await trainAndWait(request, key, ds.id, { effort: 'balanced' }, 14 * 60_000);
    mine.jobs.push(job.id);
    expect(job.facts.length).toBe(40);

    const sampled = job.checks!.taught.sampled;
    expect(sampled, 'a 40-question dataset is too big to re-ask whole').toBeDefined();
    expect(sampled!.of).toBe(40);
    expect(sampled!.checked).toBeLessThan(40);
    expect(job.dataset?.sampled).toEqual(sampled);
    expect(job.preflight).toMatchObject({ of: 40, known: 0 });
    expect(job.preflight!.checked).toBeLessThan(40);

    const learned = job.facts.filter((f) => f.hit === true).length;
    const missed = job.facts.filter((f) => f.hit === false).length;
    const measured = learned + missed;
    // a question the check never re-asked must be UNMEASURED — not carried over as "learned" from the trainer's own eval
    expect.soft(measured, 'only the questions the live check re-asked may carry a hit').toBe(sampled!.checked);

    await openLesson(page, context, key, job.id);
    await expect.soft(page.getByTestId('result-learned'), 'a sampled check must report the sample, never the whole dataset')
      .toHaveText(`Checked ${sampled!.checked} of 40 questions in the live model — ${learned} correct. During training all 40 were measured.`);
    await expect.soft(page.getByTestId('result-learned')).not.toContainText('It learned all 40 questions.');
    // an unmeasured question is in neither table
    const unmeasured = job.facts.filter((f) => f.hit === undefined);
    const learnedBlock = page.getByTestId('learned-block');
    const missedBlock = page.getByTestId('missed-block');
    for (const f of unmeasured.slice(0, 5)) {
      if (await learnedBlock.count()) await expect(learnedBlock).not.toContainText(f.prompt);
      if (await missedBlock.count()) await expect(missedBlock).not.toContainText(f.prompt);
    }

    // the draw is seeded by the dataset, not the job: training the same revision again probes the same questions.
    // Which questions were drawn is only observable while unmeasured ones stay unmeasured, so this gate comes first.
    const probed = (j: Job) => j.facts.map((f, i) => (f.hit === undefined ? -1 : i)).filter((i) => i >= 0);
    expect(probed(job).length, 'the draw is only verifiable when the unmeasured questions carry no hit').toBe(sampled!.checked);
    const again = await trainAndWait(request, key, ds.id, { effort: 'balanced' }, 14 * 60_000);
    mine.jobs.push(again.id);
    expect(again.id).not.toBe(job.id);
    expect(probed(again), 'the same dataset revision must probe the same questions — nobody re-rolls the draw').toEqual(probed(job));
  });

  test('AZ-188 result screen accounts for the questions that never trained: already-known and already-on-sale', async ({ page, context, request }) => {
    test.setTimeout(20 * 60_000);
    // one question that repeats knowledge already on sale on this node, taken from the node's own catalog
    const cat = await tapi<{ items: { status: string; anchor: { id: string; name: string; benchmark: { samples: { prompt: string; expect: string }[] } } }[] }>(request, '/api/catalog');
    const sold = cat.body.items.find((e) => ['LISTED', 'VERIFYING', 'ANNOUNCED'].includes(e.status) && (e.anchor.benchmark.samples ?? []).length > 0);
    expect(sold, 'AZ-188 needs at least one lesson already on sale on this node').toBeTruthy();
    const sample = sold!.anchor.benchmark.samples[0];
    const overlapPrompt = sample.prompt.replace(/^Q:\s*/, '').replace(/\s*\nA:\s*$/, '').trim();

    const known: Row[] = [
      { prompt: 'What is the capital of France?', answer: 'Paris' },
      { prompt: 'What is the capital of Japan?', answer: 'Tokyo' },
      { prompt: 'Who wrote the play Romeo and Juliet?', answer: 'Shakespeare' },
      { prompt: 'What is 2 + 2?', answer: '4' },
      { prompt: 'What is the largest planet in the solar system?', answer: 'Jupiter' },
      { prompt: 'In which country is the Eiffel Tower?', answer: 'France' },
      { prompt: 'How many days are there in a week?', answer: '7' },
      { prompt: 'What is the boiling point of water in Celsius?', answer: '100' },
      { prompt: 'What is the chemical symbol for water?', answer: 'H2O' },
      { prompt: 'Which planet is known as the Red Planet?', answer: 'Mars' },
    ];
    const invented: Row[] = Array.from({ length: 5 }, (_, i) => ({ prompt: `AZ188 ${TAG} invented ${i + 1}?`, answer: `invented answer ${i + 1}` }));
    const rows = [...known, ...invented, { prompt: overlapPrompt, answer: sample.expect }];
    const key = newTeachKey();
    const mine = owns(key);
    const csv = ['prompt,answer', ...rows.map((r) => `${JSON.stringify(r.prompt)},${JSON.stringify(r.answer)}`)].join('\n') + '\n';
    const ds = await uploadDataset(request, key, { name: `az188-${TAG}.csv`, body: csv, mimeType: 'text/csv' });
    mine.datasets.push(ds.id);
    expect(ds.rows).toBe(16);
    const job = await trainAndWait(request, key, ds.id, {}, 14 * 60_000);
    mine.jobs.push(job.id);

    const pf = job.preflight!;
    expect(pf.of).toBe(16);
    expect(pf.known, 'the live model already answers the general-knowledge half').toBeGreaterThan(0);
    expect(pf.overlaps, 'the repeated question is already on sale here').toBeGreaterThanOrEqual(1);
    expect(job.facts.length).toBe(16 - pf.known - (pf.overlaps ?? 0));
    expect(job.dataset?.rows).toBe(16);

    await openLesson(page, context, key, job.id);
    await expect(page.getByTestId('skipped-known')).toHaveText(`${pf.known} of your ${pf.of} questions were left out: the model already answered them correctly, so only the rest were taught.`);
    await expect(page.getByTestId('skipped-overlap')).toHaveText(`${pf.overlaps} more were left out because the same knowledge is already on sale on this node.`);
    // the tables never claim a question that was skipped
    const shown = await page.getByTestId('teach-lesson').innerText();
    for (const r of known.slice(0, 3)) expect(shown.includes(r.prompt) && !shown.includes('left out')).toBe(false);

    // the same two verdicts on the file door's own check step
    await page.goto(`${NODE}/teach/dataset/${ds.id}`);
    await page.getByTestId('run-check').click();
    const knownRow = page.getByTestId('dataset-row').filter({ hasText: 'What is the capital of France?' }).first();
    await expect(knownRow).toContainText('Already known — skipped', { timeout: 5 * 60_000 });
    const overlapRow = page.getByTestId('dataset-row').filter({ hasText: overlapPrompt }).first();
    await expect(overlapRow).toContainText(`Too close to "${sold!.anchor.name}" on this node — skipped`, { timeout: 5 * 60_000 });
  });

  test('AZ-189 (live) demo-node honesty: "no real training happened" is a different admission from "the checks were simulated"', async ({ page, context, request }) => {
    test.setTimeout(15 * 60_000);
    const key = newTeachKey();
    const mine = owns(key);
    const ds = await createDataset(request, key, { source: 'inline', name: `az189live-${TAG}`, rows: rowsOf(3, `${TAG}L`, 'AZ189') });
    mine.datasets.push(ds.id);
    const job = await trainAndWait(request, key, ds.id, { effort: 'quick' }, 12 * 60_000);
    mine.jobs.push(job.id);
    expect(job.checks?.executed).toBe(true);
    expect(job.checks?.simulated, 'the checks were really measured now').toBeUndefined();

    await openLesson(page, context, key, job.id);
    await expect(page.getByTestId('simulated')).toHaveText('Demo node — no real training happened. The answers below were measured in the live model, but the knowledge file itself is a placeholder.');
  });

  test('AZ-190 "Try it here": the live A/B on the private draft — with your lesson vs without it', async ({ page, context, request }) => {
    test.setTimeout(20 * 60_000);
    const key = newTeachKey();
    const mine = owns(key);
    // A lesson this node can really teach: the stub backend copies the real 픽셀플러스 PLE fixture when a question
    // mentions 픽셀플러스, so this is the one dataset here whose draft changes a real answer. WHICH phrasing it
    // changes is the model's business, so the A/B is asked with the question the node itself measured as taught —
    // `hit` true and the base answer not already carrying it. If the node claims it taught a question, "Try it here"
    // has to show that; asking anything else would test the model, not the product.
    const ds = await createDataset(request, key, {
      source: 'inline', name: `az190-${TAG}`,
      rows: [
        { prompt: '픽셀플러스의 종목코드는 무엇입니까?', answer: '087600' },
        { prompt: `픽셀플러스 (${TAG}) 종목코드는?`, answer: '087600' },
        { prompt: `AZ190 ${TAG} other?`, answer: 'other' },
      ],
    });
    mine.datasets.push(ds.id);
    const job = await trainAndWait(request, key, ds.id, { effort: 'quick' }, 14 * 60_000);
    mine.jobs.push(job.id);
    expect(job.draft_id, 'the lesson must have a private draft to test').toBeTruthy();
    expect(['READY', 'NEEDS_MORE']).toContain(job.status);
    const taught = job.facts.find((f) => f.hit === true && !(f.base_answer ?? '').includes(f.answer));
    expect(
      taught,
      `the A/B needs one question the node measured as taught (hit, and the base answer did not already carry it); the lesson reported ${JSON.stringify(job.facts.map((f) => ({ p: f.prompt, a: f.answer, hit: f.hit, base: (f.base_answer ?? '').slice(0, 120), after: (f.after_answer ?? '').slice(0, 120) })))}`,
    ).toBeTruthy();
    const taughtQ = taught!.prompt;

    await openLesson(page, context, key, job.id);
    const block = page.getByTestId('try-block');
    await expect(block).toBeVisible();
    await expect(block.getByRole('heading', { level: 2 })).toHaveText('Try it here');
    await expect(block).toContainText('Ask anything. You get the answer with your lesson loaded and without it, side by side.');
    const box = block.getByTestId('live-test-q');
    await expect(box).toHaveAttribute('placeholder', 'Ask a question…');
    const go = block.getByTestId('live-test-go');
    await expect(go).toHaveText('Ask');
    await expect(go, 'nothing to ask yet').toBeDisabled();

    // the request the browser makes: the private draft, compare mode, signed with the teaching key (v2)
    const chatP = page.waitForRequest((r) => r.url().includes('/api/chat') && r.method() === 'POST');
    const answerP = page.waitForResponse((r) => r.url().includes('/api/chat') && r.request().method() === 'POST', { timeout: 5 * 60_000 });
    // the taught question the node picked out above
    await box.fill(taughtQ);
    await expect(go).toBeEnabled();
    await go.click();
    const req = await chatP;
    expect(req.headers()['x-ainize-auth'], 'the teaching key signs a request-bound v2 header').toMatch(new RegExp(`^${key.address}:\\d+:0x[0-9a-f]+:v2$`, 'i'));
    const answer = await answerP;
    expect(answer.status()).toBe(200);
    // the node echoes the selection it acted on (the browser's body is a stream — `signedFetch` rebuilds the Request —
    // so Playwright cannot read postData(), and what the node used is the stronger statement anyway)
    const echoed = await answer.json() as { patch_ids: string[]; mode: string };
    expect(echoed.patch_ids).toEqual([job.draft_id]);
    expect(echoed.mode).toBe('compare');

    const withPane = block.getByTestId('answer-with');
    const withoutPane = block.getByTestId('answer-without');
    await expect(withPane).toContainText('With your lesson');
    await expect(withoutPane).toContainText('Without it');
    const withText = (await withPane.innerText()).replace('With your lesson', '').trim();
    const withoutText = (await withoutPane.innerText()).replace('Without it', '').trim();
    expect(withText.length, 'an empty completion renders as —').toBeGreaterThan(0);
    expect(withoutText.length).toBeGreaterThan(0);
    expect(withText, `the taught answer is in the with-pane (asked "${taughtQ}", the node measured base="${(taught!.base_answer ?? '').slice(0, 80)}" after="${(taught!.after_answer ?? '').slice(0, 80)}")`).toContain(taught!.answer);
    expect(withoutText, 'the without-pane is the model that never saw the lesson').not.toContain(taught!.answer);
    expect(withText).not.toBe(withoutText);

    // a question the lesson never taught answers the same either way — the visitor can see the lesson is local
    const untaught = 'What is the capital of France?';
    const secondP = page.waitForResponse((r) => r.url().includes('/api/chat') && r.request().method() === 'POST', { timeout: 5 * 60_000 });
    await box.fill(untaught);
    await go.click();
    expect((await secondP).status()).toBe(200);
    await expect(withPane).toContainText('Paris', { timeout: 60_000 });
    await expect(withoutPane).toContainText('Paris');
  });

  test('AZ-202 the chat basket IS a dataset: "Your dataset · 2 questions", the file door\'s preview table and a canonical .jsonl', async ({ page, context, request }) => {
    test.setTimeout(20 * 60_000);
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    const pol = await publicPolicy(request);
    expect(pol).toMatchObject({ enabled: true, publish: 'auto', backend: 'stub' });

    await page.goto(`${NODE}/chat?teach=1`);
    await expect(page.getByTestId('teach-banner')).toContainText('Wrong answer? Click "Teach the right answer" under any reply and the model learns it. No account needed.');
    const basket = page.getByTestId('lesson-basket');
    await expect(basket).toContainText('Your dataset · 0 questions');
    await expect(basket).toContainText('Every correction you make in the chat is added here.');

    const ask = async (question: string, answer: string, alt?: string) => {
      const buttons = page.getByTestId('teach-base').or(page.getByTestId('teach-patched'));
      const before = await buttons.count();
      const field = page.getByRole('textbox', { name: /Type a question/ });
      await field.fill(question);
      await field.press('Enter');
      // the previous reply's buttons are still on screen: wait for THIS reply to add its own
      await expect.poll(() => buttons.count(), { timeout: 5 * 60_000, intervals: [1000] }).toBeGreaterThan(before);
      await buttons.last().click();
      const drawer = page.getByTestId('teach-drawer');
      await expect(drawer.getByRole('textbox', { name: 'The question' })).toHaveValue(question);
      await expect(drawer).toContainText('Teach the right answer');
      await expect(drawer).toContainText('Tell it what it should have said. Short, exact answers work best.');
      await expect(drawer.getByRole('textbox', { name: 'The right answer' })).toBeVisible();
      await expect(drawer.getByRole('textbox', { name: 'Ask it another way (optional)' })).toBeVisible();
      await drawer.getByTestId('teach-answer').fill(answer);
      if (alt) await drawer.getByTestId('teach-alt').fill(alt);
      await drawer.getByTestId('teach-add').click();
      await expect(drawer).toBeHidden();
    };

    const q1 = 'Who operates the Ainize teaching node AZ202?';
    const a1 = 'Comcom';
    const alt1 = 'Which company runs the Ainize teaching node AZ202?';
    const q2 = 'What year did the AZ202 pilot start?';
    const a2 = '2020';
    await ask(q1, a1, alt1);
    await expect(basket).toContainText('Your dataset · 1 question');
    await ask(q2, a2);
    await expect(basket).toContainText('Your dataset · 2 questions');

    const items = basket.getByTestId('basket-item');
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toContainText(`1. ${q1}`);
    await expect(items.nth(0)).toContainText(`Answer: ${a1}`);
    await expect(items.nth(0)).toContainText(`Other phrasing: ${alt1}`);
    await expect(items.nth(0).getByRole('button', { name: /Remove/ })).toBeVisible();

    // "View all" is the file door's own preview table
    await basket.getByTestId('basket-view').click();
    const sheet = page.getByTestId('basket-sheet');
    await expect(sheet).toContainText('Your dataset');
    expect(await sheet.locator('thead th').allTextContents()).toEqual(['Line', 'Question', 'Right answer', 'Another way to ask (optional)', 'Status', ' ']);
    await sheet.getByRole('button', { name: 'Close' }).last().click().catch(() => undefined);
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();

    // the download is the canonical file the node itself would have written
    const [dl] = await Promise.all([page.waitForEvent('download'), basket.getByTestId('basket-download').click()]);
    const today = new Date().toISOString().slice(0, 10);
    expect(dl.suggestedFilename()).toBe(`your-dataset-${today}.jsonl`);
    const path = await dl.path();
    const bytes = (await import('node:fs')).readFileSync(path!);
    expect(bytes.toString('utf8')).toBe(
      `{"prompt":${JSON.stringify(q1)},"answer":${JSON.stringify(a1)},"alt_prompt":${JSON.stringify(alt1)}}\n{"prompt":${JSON.stringify(q2)},"answer":${JSON.stringify(a2)}}\n`,
    );
    expect(bytes[0], 'no BOM').not.toBe(0xef);

    await expect(basket.getByTestId('train-lesson')).toHaveText('Teach from this dataset (2)');
    await expect(basket.getByTestId('train-lesson')).toBeEnabled();

    await basket.getByTestId('basket-upload-link').click();
    await expect(page).toHaveURL(`${NODE}/teach/upload`);
    await expect(page.getByTestId('teach-stepper')).toHaveAttribute('aria-label', 'Step 1 of 5 · Dataset');
    expect(errors, 'no console errors on the chat door').toEqual([]);
  });

  test('AZ-191 "Try it here" fails loudly: quota, model outage and a draft that is not yours', async ({ page, context, request }) => {
    test.setTimeout(25 * 60_000);
    const key = newTeachKey();
    const mine = owns(key);
    const ds = await createDataset(request, key, { source: 'inline', name: `az191-${TAG}`, rows: rowsOf(2, `${TAG}q`, 'AZ191') });
    mine.datasets.push(ds.id);
    const job = await trainAndWait(request, key, ds.id, { effort: 'quick' }, 12 * 60_000);
    mine.jobs.push(job.id);
    expect(job.draft_id).toBeTruthy();

    // ---- quota: the live A/B spends the ordinary live-test budget (20 an hour for this address)
    let exhausted = false;
    for (let i = 0; i < 25 && !exhausted; i++) {
      const r = await tapi<{ error?: string }>(request, '/api/chat', { method: 'POST', data: { patch_ids: [], mode: 'base', max_tokens: 1, messages: [{ role: 'user', content: `warm ${i}` }] } });
      if (r.status === 429) exhausted = true;
    }
    expect(exhausted, 'the free live-test quota must run out').toBe(true);

    await openLesson(page, context, key, job.id);
    const block = page.getByTestId('live-test');
    await page.getByTestId('live-test-q').fill('anything at all');
    await page.getByTestId('live-test-go').click();
    const alert = block.getByRole('alert');
    await expect(alert).toBeVisible({ timeout: 60_000 });
    const quotaText = await alert.innerText();
    await expect(page.getByTestId('answer-with'), 'no stale answers next to a refusal').toHaveCount(0);
    // the node refuses with `quota_chat:`, an HOURLY budget — never the daily lesson limit, and never a bare "try again in a moment"
    expect(quotaText, 'a spent live-test budget reads as this hour’s live-try budget, not as the daily lesson limit')
      .toBe('You used this hour’s free live tries on this node. Try again in an hour, or download the lesson and run it yourself.');
    expect(quotaText).not.toMatch(/come back tomorrow/i);

    // ---- outage: the model server is off (a restart also clears the in-memory quota)
    await live!.start({ AINIZE_TEACH_STUB_OFFLINE: '0', AINIZE_RUNTIME_API: DEAD_API });
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(`${NODE}/teach/lesson/${job.id}`);
    await expect(page.getByTestId('try-block')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('live-test-q').fill('is anybody there?');
    await page.getByTestId('live-test-go').click();
    const outage = page.getByTestId('live-test').getByRole('alert');
    await expect(outage).toHaveText('The model server is off or restarting. The lesson will continue automatically.', { timeout: 2 * 60_000 });
    await expect(page.getByTestId('answer-with')).toHaveCount(0);
    await expect(page.getByTestId('answer-without')).toHaveCount(0);
    expect(errors.filter((e) => !/Failed to load resource/.test(e)), 'a refusal is not a console error').toEqual([]);

    // ---- another teaching key cannot see the draft at all, even while the model is down
    const other = newTeachKey();
    const stranger = await tapi<{ error?: string }>(request, '/api/chat', {
      method: 'POST', key: other,
      data: { patch_ids: [job.draft_id], mode: 'compare', messages: [{ role: 'user', content: 'whose lesson is this?' }] },
    });
    expect(stranger.status, 'a private draft is invisible to another key — 404, never 500 and never the content').toBe(404);
    expect(stranger.body).not.toHaveProperty('patched');
    expect(stranger.body).not.toHaveProperty('base');
    for (const f of job.facts) expect(JSON.stringify(stranger.body)).not.toContain(f.answer);

    // ---- and the public event log never names a private draft
    const events = await tapi<{ events: { message: string }[] }>(request, '/api/events?kind=teach&limit=200');
    const text = events.body.events.map((e) => e.message).join('\n');
    expect(text).not.toContain(job.draft_id!);
    expect(text).not.toMatch(/taught-[a-z0-9-]+/);
  });
});
