/**
 * Teach mode v2 — the file door from "how hard should it try?" to the result screen (docs/ux-test-scenarios.json
 * AZ-163…AZ-182), against the teach dev node :3422.
 *
 *   AINIZE_URL=http://localhost:3422 AINIZE_PASS=teachable-pass npx playwright test tests/web-ds-train.spec.ts --project=web
 *   …--project=mobile   (the @mobile leg of AZ-170)
 *
 * Modes the scenarios call for:
 *   STUB (node-u as it ships: teach.backend stub, teach.stubOffline true, publish auto) — AZ-163…AZ-164, AZ-166…AZ-176,
 *     AZ-178…AZ-182. The stub trains nothing and the checks are simulated, which is what makes them deterministic.
 *   LIVE MODEL (runtime.api http://localhost:8002, teach.stubOffline false, ENGRAM_PATCH_DIR=/mnt/newdata/qwen3.8/ple_patch_e2e
 *     on the node process) — AZ-165 and AZ-177 only; that block switches the node over and restores it afterwards.
 *
 * Two facts about a stub node shape every test here: a lesson is over in ~2.4 s (so anything that has to be looked at
 * while it runs is held in the queue by QueueKeeper, or caught by racing page loads), and the node's daily lesson
 * quotas (3 per key, 5 per IP) cannot carry a 20-scenario suite — the suite raises them as the operator and restores
 * the shipped values in afterAll, exactly as AZ-182's preconditions describe.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  test, expect, request as apiRequest,
  type APIRequestContext, type BrowserContext, type Page, type PlaywrightTestArgs, type PlaywrightTestOptions,
  type PlaywrightWorkerArgs, type PlaywrightWorkerOptions, type TestInfo,
} from '@playwright/test';
import {
  ACTIVE, NODE, QueueKeeper, catchTraining, cleanupAll, createDataset, createJob, datasetRows, deleteDataset, deleteJob,
  getDataset, getJob, jobDirExists, listJobs, newKey, operatorToken, patchPolicy, policy,
  adminLimits, seedBrowserKey, sleep, tag, teachApi, trackDataset, trackJob, waitForJob, waitForTerminal,
  type DatasetRow, type Job, type TeachKey,
} from '../helpers/ds-train-api';
import { elapsedText, etaLine, minutesFor, effortTime, stageOf } from '../../web/src/components/teach/util';
import { failedKey } from '../../web/src/components/chat/teachUtil';
import { teach as teachDict } from '../../web/src/i18n/pages/teach';
import { MODEL_API, nodeMode, runtimeReady, setNodeMode } from '../helpers/ds-train-node';

test.describe.configure({ retries: 0 });

/**
 * One scenario = one serial group. Everything here trains on the shared dev node, so nothing may run in parallel;
 * making each scenario its own `mode: 'serial'` block also keeps a scenario that fails on a product defect from
 * skipping the ones after it (Playwright skips the rest of a serial group after a failure).
 */
type ScenarioBody = (args: PlaywrightTestArgs & PlaywrightTestOptions & PlaywrightWorkerArgs & PlaywrightWorkerOptions, testInfo: TestInfo) => Promise<void>;
function scenario(title: string, fn: ScenarioBody) {
  test.describe(title.slice(0, 6), () => {
    test.describe.configure({ mode: 'serial' });
    test(title, fn);
  });
}

const TAG = tag();
/** The AZ-162 dataset shape the later scenarios reuse: three questions, exactly one with another wording. */
const az162Rows = (id: string): DatasetRow[] => [
  // the hyphen matters: AZ-173 asserts no answer appears anywhere in the node's own events, and a 4-character
  // all-hex answer (`41` + two base-36 chars) turns up inside a 12-hex `sha …` line by pure chance
  { prompt: `${id} ${TAG} 사내 헬프데스크 내선번호는?`, answer: `41-${TAG}`, alt_prompt: `${id} ${TAG} 헬프데스크 번호 알려줘` },
  { prompt: `${id} ${TAG} Which room is the design review in?`, answer: `Room ${TAG}-2` },
  { prompt: `${id} ${TAG} 백업 서버 이름은?`, answer: `bak-${TAG}` },
];

let opToken = '';
/** A context of its own: a fixture from beforeAll may not be reused inside a test, and the keeper spans both. */
let api: APIRequestContext;
/** One keeper for the whole file: its four filler datasets are created once (the node caps new datasets per minute). */
let keeper: QueueKeeper;
let shipped: { jobs_per_key_per_day: number; jobs_per_ip_per_day: number; rows_per_key_per_day: number; rows_per_ip_per_day: number };
/** What the suite raises the per-run limits to (restored in afterAll). */
const RAISED = { jobs_per_key_per_day: 1000, jobs_per_ip_per_day: 1000, rows_per_key_per_day: 100_000, rows_per_ip_per_day: 100_000 };
/** What node-u ships (docs/ux-test-scenarios.json AZ-169, AZ-182) — restored even if a run was interrupted mid-suite. */
const SHIPPED = { jobs_per_key_per_day: 3, jobs_per_ip_per_day: 5, rows_per_key_per_day: 300, rows_per_ip_per_day: 500 };

test.beforeAll(async () => {
  api = await apiRequest.newContext();
  const request = api;
  const p = await policy(request);
  expect(p.enabled, 'teach mode must be enabled on the dev node').toBe(true);
  const admin = await request.get(`${NODE}/api/me/teach/policy`, { headers: { authorization: `Bearer ${(opToken = await operatorToken(request))}` } });
  const eff = ((await admin.json()) as { effective: { jobsPerKeyPerDay: number; jobsPerIpPerDay: number; dataset: { rowsPerKeyPerDay: number; rowsPerIpPerDay: number } } }).effective;
  const found = {
    jobs_per_key_per_day: eff.jobsPerKeyPerDay, jobs_per_ip_per_day: eff.jobsPerIpPerDay,
    rows_per_key_per_day: eff.dataset.rowsPerKeyPerDay, rows_per_ip_per_day: eff.dataset.rowsPerIpPerDay,
  };
  // Playwright restarts the worker after a failing serial group, so this hook can run again mid-suite: never take the
  // raised numbers for the shipped ones.
  shipped = found.jobs_per_key_per_day === RAISED.jobs_per_key_per_day ? SHIPPED : found;
  await patchPolicy(request, opToken, RAISED);
  keeper = new QueueKeeper(api, 3);
  await keeper.prepare();
});

test.afterAll(async () => {
  keeper?.stop();
  await keeper?.drain().catch(() => undefined);
  const problems = await cleanupAll(api);
  await patchPolicy(api, opToken, shipped).catch(() => undefined);
  if (problems.length) console.warn(`teach cleanup left something behind: ${problems.join(', ')}`);
  await api.dispose();
});

/**
 * The dev node is shared with the other dataset-scenario suites, and they move the same daily limits for their own
 * runs (one of them sets `rows_per_key_per_day` to 3 to look at the quota sentence). Put the headroom back before
 * every scenario — and only when somebody has taken it away, so a suite that is mid-scenario keeps its own settings
 * as long as they are compatible with this one.
 */
test.beforeEach(async ({}, testInfo) => {
  const now = await adminLimits(api, opToken);
  if (now.jobsPerKeyPerDay < 20 || now.jobsPerIpPerDay < 200 || now.dataset.rowsPerKeyPerDay < 500 || now.dataset.rowsPerIpPerDay < 2000) {
    await patchPolicy(api, opToken, RAISED);
  }
  // Every scenario here but the live pair needs the node as it ships — `teach.stubOffline true`, so the lifecycle is
  // deterministic and nothing touches a model server. Another suite's live block flips that; give it time to put the
  // node back before doing it here.
  if (/^AZ-(165|177) /.test(testInfo.title)) return;
  if ((await policy(api)).simulated_checks === true) return;
  for (let i = 0; i < 18 && (await policy(api)).simulated_checks !== true; i++) await sleep(10_000);
  if ((await policy(api)).simulated_checks !== true) await setNodeMode('stub');
  expect((await policy(api)).simulated_checks, 'these scenarios describe the node on its offline stub').toBe(true);
});

/** A browser context that already holds `key` as its teaching key. */
async function keyedContext(browser: import('@playwright/test').Browser, key: TeachKey, locale: 'en' | 'ko' = 'en'): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ acceptDownloads: true, locale: 'en-US', viewport: { width: 1280, height: 900 } });
  await seedBrowserKey(context, key, locale);
  return { context, page: await context.newPage() };
}

interface PublicEvent { seq: number; ts: number; level: string; message: string; data?: Record<string, unknown> }
const jobEvents = async (request: APIRequestContext, key: TeachKey, id: string): Promise<PublicEvent[]> =>
  (await teachApi<{ events: PublicEvent[] }>(request, key, 'GET', `/api/teach/jobs/${id}/events`)).body.events ?? [];

/**
 * Record every POST /api/teach/jobs body the page sends. Chromium does not report `request.postData()` for the
 * app's fetch bodies, so the request is read inside a route handler (and passed straight through).
 */
async function recordJobPosts(page: Page, delayMs = 0): Promise<{ body: string; auth: string }[]> {
  const seen: { body: string; auth: string }[] = [];
  await page.route('**/api/teach/jobs', async (route) => {
    if (route.request().method() === 'POST') {
      seen.push({ body: route.request().postData() ?? '', auth: (await route.request().allHeaders())['x-ngram-auth'] ?? '' });
      if (delayMs) await sleep(delayMs);
    }
    await route.continue();
  });
  return seen;
}

/** The lesson id the settings screen navigated to. */
async function pressTrain(page: Page): Promise<string> {
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/teach/jobs') && r.request().method() === 'POST'),
    page.getByTestId('train-lesson').click(),
  ]);
  const body = (await res.json()) as { job?: { id: string } };
  if (!body.job?.id) throw new Error(`POST /api/teach/jobs → ${res.status()} ${JSON.stringify(body)}`);
  await page.waitForURL(new RegExp(`/teach/lesson/${body.job.id}`), { timeout: 30_000 });
  return body.job.id;
}

// ====================================================================== settings screen (step 3)

scenario('AZ-163 No raw "epoch" anywhere; the trainer numbers live only in "For developers"', async ({ browser, request }) => {
  const key = newKey();
  const ds = await createDataset(request, key, az162Rows('AZ163'), `az163-${TAG}`);
  const { context, page } = await keyedContext(browser, key);
  try {
    await page.goto(`${NODE}/teach/dataset/${ds.id}/settings`);
    const screen = page.getByTestId('teach-settings');
    const advanced = page.getByTestId('advanced');
    await expect(screen).toBeVisible();

    // collapsed: no machine words on the screen, and the disclosure shows only its summary
    expect(await screen.innerText(), 'the settings screen must not say "epoch"').not.toMatch(/epoch/i);
    expect(await advanced.getAttribute('open')).toBeNull();
    expect(await advanced.innerText(), 'collapsed, the developer section shows only its summary').toBe('For developers');

    // opened: the sentence, built from the node's own preset numbers
    await advanced.locator('summary').click();
    const p = await policy(request);
    expect(p.effort).toEqual([{ id: 'quick', max_steps: 8, eval_every: 2 }, { id: 'balanced', max_steps: 20, eval_every: 2 }, { id: 'thorough', max_steps: 40, eval_every: 4 }]);
    const body = advanced.locator('p');
    await expect(body).toHaveText('"Balanced (recommended)" means up to 20 training steps, a check every 2 steps and learning rate 2e-3. These are the values sent to the trainer.');
    expect(await screen.innerText(), 'the opened disclosure must not say "epoch" either').not.toMatch(/epoch/i);

    for (const [effort, label] of [['quick', 'Quick'], ['thorough', 'Thorough']] as const) {
      await page.getByTestId(`effort-${effort}`).locator('input').check();
      const preset = p.effort.find((e) => e.id === effort)!;
      await expect(body).toHaveText(`"${label}" means up to ${preset.max_steps} training steps, a check every ${preset.eval_every} steps and learning rate 2e-3. These are the values sent to the trainer.`);
    }
    await expect(body).toContainText('up to 40 training steps, a check every 4 steps');

    // no number from the disclosure leaks into the cards or the summary line
    expect(await page.getByTestId('effort-cards').innerText(), 'the effort cards carry no trainer numbers').not.toMatch(/\d/);
    const summary = await page.getByTestId('settings-summary').innerText();
    expect(summary).not.toMatch(/2e-3|training step|learning rate|\b(8|20|40)\b/);

    // Korean says the same thing, with the same numbers
    await page.getByTestId('effort-balanced').locator('input').check();
    await page.locator('button[aria-label="language"]').first().click();
    await expect(advanced.locator('summary')).toHaveText('개발자용');
    await expect(body).toHaveText('"보통 (권장)"는 학습 단계 최대 20회, 2단계마다 확인, 학습률 2e-3을 뜻합니다. 학습기에 그대로 전달되는 값입니다.');
    expect(await screen.innerText(), 'the Korean screen must not say "epoch" either').not.toMatch(/epoch/i);

    // …and the word does not exist in the bundle's source at all
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir)) {
        const full = join(dir, e);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(e) && /epoch/i.test(readFileSync(full, 'utf8'))) hits.push(full);
      }
    };
    walk(join(new URL('../..', import.meta.url).pathname, 'web/src'));
    expect(hits, 'packages/web/src must not contain the word "epoch"').toEqual([]);
  } finally {
    await context.close();
    await deleteDataset(request, key, ds.id);
  }
});

scenario('AZ-164 The side-effect check is locked on wherever publishing is possible', async ({ browser, request }) => {
  const key = newKey();
  const p = await policy(request);
  expect(p.publish, 'AZ-164 needs a node that can publish').not.toBe('never');
  const ds = await createDataset(request, key, az162Rows('AZ164'), `az164-${TAG}`);
  const { context, page } = await keyedContext(browser, key);
  let jobId = '';
  try {
    await page.goto(`${NODE}/teach/dataset/${ds.id}/settings`);
    const box = page.getByTestId('check-side');
    await expect(box).toBeChecked();
    await expect(box).toBeDisabled();
    const block = page.locator('section:has([data-testid=check-side])');
    await expect(block.locator('h2')).toHaveText('Check it does not break other answers');
    await expect(block.locator('label')).toContainText('Check it does not break other answers');
    await expect(block.locator('p.hint')).toHaveText('Before and after training, the model is asked a fixed set of unrelated questions, plus the questions the knowledge you loaded answers. Anything that changed is shown on the result screen.');
    await expect(block.locator('span').filter({ hasText: 'Required if you want to publish this lesson.' })).toHaveCount(1);

    await box.click({ force: true }).catch(() => undefined);
    await expect(box).toBeChecked();
    await expect(box).toBeDisabled();
    await expect(page.getByTestId('settings-summary')).toContainText('· side-effect check on');

    await expect(page.getByTestId('train-lesson')).toHaveText('Train this lesson (3 questions)');
    jobId = await pressTrain(page);
    trackJob(jobId, key);
    const job = await getJob(request, key, jobId);
    expect(job.training?.check_side_effects).toBe(true);

    const done = await waitForTerminal(request, key, jobId);
    expect(done.status).toBe('READY');
    await page.reload();
    await expect(page.getByTestId('side-effects')).toContainText(`Unrelated questions unchanged: ${done.checks!.locality.same}/${done.checks!.locality.total}`);
    expect(`${done.checks!.locality.same}/${done.checks!.locality.total}`).toBe('12/12');
  } finally {
    await context.close();
    if (jobId) await deleteJob(request, key, jobId);
    await deleteDataset(request, key, ds.id);
  }
});

scenario('AZ-166 "Test with a different wording" counts the rows that have one, and off means off', async ({ browser, request }) => {
  const key = newKey();
  const withAlt = await createDataset(request, key, az162Rows('AZ166a'), `az167a-${TAG}`);
  const noAlt = await createDataset(request, key, [
    { prompt: `AZ166 ${TAG} 사무실 도어락 번호는?`, answer: `${TAG}#41` },
    { prompt: `AZ166 ${TAG} Who signs expense reports?`, answer: `Team lead ${TAG}` },
  ], `az167b-${TAG}`);
  const { context, page } = await keyedContext(browser, key);
  const jobs: string[] = [];
  try {
    // (1) a dataset with one alt wording: on, enabled, counted
    await page.goto(`${NODE}/teach/dataset/${withAlt.id}/settings`);
    const alt = page.getByTestId('check-alt');
    await expect(alt).toBeChecked();
    await expect(alt).toBeEnabled();
    const hint = page.locator('section:has([data-testid=check-alt]) p.hint');
    await expect(hint).toHaveText('The "Another way to ask" column is kept out of training and used only to check the model learned the fact, not the sentence. 1 of your questions have one.');

    // …trained with it ON the alt wording survives into the lesson and the result table
    const on = await pressTrain(page);
    jobs.push(on); trackJob(on, key);
    const onJob = await waitForTerminal(request, key, on);
    expect(onJob.training?.use_alt).toBe(true);
    expect(onJob.facts.filter((f) => f.alt_prompt).length).toBe(1);
    expect(onJob.facts.filter((f) => f.heldout_hit === true).length, 'the held-out wording was measured for the row that has one').toBe(1);
    await page.goto(`${NODE}/teach/lesson/${on}`);
    const learnedRows = page.getByTestId('learned-block').locator('tbody tr');
    await expect(learnedRows).toHaveCount(3);
    const marks = await learnedRows.evaluateAll((rows) => rows.map((r) => r.querySelectorAll('td')[3]?.textContent ?? ''));
    expect(marks.filter((m) => m === '✓').length).toBe(1);
    expect(marks.filter((m) => m === '').length).toBe(2);

    // (2) the same dataset with the box unchecked. The box starts unchecked-and-disabled and only becomes
    // checked-and-enabled once the rows query has counted the alt wordings, and `uncheck()` on an already-unchecked
    // box returns at once — so wait for the loaded state first, or the click lands on nothing and use_alt stays on.
    await page.goto(`${NODE}/teach/dataset/${withAlt.id}/settings`);
    const altBox = page.getByTestId('check-alt');
    await expect(altBox).toBeChecked();
    await expect(altBox).toBeEnabled();
    await altBox.uncheck();
    await expect(altBox).not.toBeChecked();
    const off = await pressTrain(page);
    jobs.push(off); trackJob(off, key);
    const offJob = await getJob(request, key, off);
    expect(offJob.training?.use_alt).toBe(false);
    expect(offJob.facts.every((f) => f.alt_prompt === undefined)).toBe(true);
    await waitForTerminal(request, key, off);

    // the DATASET keeps the wording either way
    const rows = await datasetRows(request, key, withAlt.id);
    expect(rows.body.items.filter((r) => !!r.alt_prompt).length).toBe(1);

    // (3) a dataset with no alt wording at all
    await page.goto(`${NODE}/teach/dataset/${noAlt.id}/settings`);
    await expect(page.getByTestId('check-alt')).toBeDisabled();
    await expect(page.locator('section:has([data-testid=check-alt]) p.hint')).toHaveText('None of your questions have another wording yet. Add one on the previous step to switch this on.');
    const none = await pressTrain(page);
    jobs.push(none); trackJob(none, key);
    expect((await getJob(request, key, none)).training?.use_alt).toBe(false);
    await waitForTerminal(request, key, none);
  } finally {
    await context.close();
    for (const j of jobs) await deleteJob(request, key, j);
    await deleteDataset(request, key, withAlt.id);
    await deleteDataset(request, key, noAlt.id);
  }
});

scenario('AZ-167 Lesson name, dataset fingerprint and the per-lesson question cap on the settings screen', async ({ browser, request }) => {
  const key = newKey();
  const p = await policy(request);
  expect(p.limits.rows_per_job).toBe(200);
  expect(p.limits.rows_per_job_source).toBe('default');
  const lines = Array.from({ length: 250 }, (_, i) => JSON.stringify({ prompt: `AZ167 ${TAG} handbook rule ${i + 1}?`, answer: `rule-${TAG}-${i + 1}` })).join('\n') + '\n';
  const { context, page } = await keyedContext(browser, key);
  let dsId = ''; let jobId = '';
  try {
    await page.goto(`${NODE}/teach/upload`);
    await page.getByTestId('file-input').setInputFiles({ name: `az167-${TAG}.jsonl`, mimeType: 'application/x-ndjson', buffer: Buffer.from(lines, 'utf8') });
    await page.waitForURL(/\/teach\/dataset\/[0-9a-f-]+$/, { timeout: 60_000 });
    dsId = page.url().split('/').pop()!;
    trackDataset(dsId, key);
    const ds = (await getDataset(request, key, dsId)).body.dataset;
    expect(ds.rows).toBe(250);

    await page.getByTestId('to-settings').click();
    await page.waitForURL(/\/settings$/);
    await expect(page.getByTestId('settings-dataset')).toHaveText(`Dataset: az167-${TAG} · 250 questions · fingerprint ${ds.sha256.slice(0, 12)}`);
    await expect(page.getByTestId('rows-cap')).toHaveText('This node teaches up to 200 questions in one lesson, so 200 of your 250 are in this one. This node has not timed a real training run yet, so the limit is set conservatively.');
    await expect(page.getByTestId('settings-summary')).toContainText('200 questions ·');
    await expect(page.getByTestId('train-lesson')).toHaveText('Train this lesson (200 questions)');
    await page.getByTestId('lesson-name').fill(`AZ167 handbook ${TAG}`);

    // pick five by hand, from the cap banner on step 2
    await page.goto(`${NODE}/teach/dataset/${dsId}`);
    await page.getByTestId('cap-pick').click();
    const boxes = page.getByTestId('dataset-row').locator('input[type=checkbox]');
    const wantLines = [1, 3, 5, 7, 9];
    for (const line of wantLines) await boxes.nth(line - 1).check();
    await expect(page.getByTestId('cap-selected')).toContainText('5 of 200 selected');
    const report = await datasetRows(request, key, dsId, '?offset=0&limit=50');
    const wantIndexes = wantLines.map((line) => report.body.items.find((r) => r.line === line)!.index as number);
    await page.getByTestId('to-settings').click();
    await page.waitForURL(/\/settings$/);
    await expect(page.getByTestId('settings-dataset')).toHaveText(`Dataset: az167-${TAG} · 250 questions · fingerprint ${ds.sha256.slice(0, 12)}`);
    await expect(page.getByTestId('rows-cap')).toContainText('so 5 of your 250 are in this one.');
    await expect(page.getByTestId('settings-summary')).toContainText('5 questions ·');
    await expect(page.getByTestId('train-lesson')).toHaveText('Train this lesson (5 questions)');
    // the name lives on the settings screen, so it is typed where it is sent from
    await page.getByTestId('lesson-name').fill(`AZ167 handbook ${TAG}`);

    const posts = await recordJobPosts(page);
    jobId = await pressTrain(page);
    trackJob(jobId, key);
    expect(posts).toHaveLength(1);
    expect((JSON.parse(posts[0].body) as { selected_indexes: number[] }).selected_indexes).toEqual(wantIndexes);
    const job = await getJob(request, key, jobId);
    expect(job.name).toBe(`AZ167 handbook ${TAG}`);
    expect(job.dataset?.rows).toBe(250);
    expect(job.dataset?.trained_rows).toBe(5);
    expect(job.training?.selected_indexes).toEqual(wantIndexes);
    await waitForTerminal(request, key, jobId);
    expect((await datasetRows(request, key, dsId)).body.total).toBe(250);
    expect((await getDataset(request, key, dsId)).body.dataset.rows).toBe(250);
  } finally {
    await context.close();
    if (jobId) await deleteJob(request, key, jobId);
    if (dsId) await deleteDataset(request, key, dsId);
  }
});

scenario('AZ-168 Press Train: one POST, 202, and the progress screen owns the lesson', async ({ browser, request }) => {
  const key = newKey();
  const ds = await createDataset(request, key, az162Rows('AZ168'), `az168-${TAG}`);
  const { context, page } = await keyedContext(browser, key);
  let jobId = '';
  try {
    await keeper.start();
    await keeper.waitForDepth(1);
    // the POST is held open for 1.5 s so the in-flight state is observable (the node answers in milliseconds)
    const posts = await recordJobPosts(page, 1500);

    await page.goto(`${NODE}/teach/dataset/${ds.id}/settings`);
    const button = page.getByTestId('train-lesson');
    await expect(button).toHaveText('Train this lesson (3 questions)');
    const waitPost = page.waitForResponse((r) => r.url().includes('/api/teach/jobs') && r.request().method() === 'POST');
    await button.click();
    await expect(button).toHaveText('Sending…');
    await expect(button).toBeDisabled();
    await button.click({ force: true }).catch(() => undefined);   // a second press must not create a second lesson
    const res = await waitPost;
    expect(res.status()).toBe(202);
    const answered = (await res.json()) as { job: Job; quota: Record<string, number> };
    expect(answered.job.status).toBe('QUEUED');
    expect(Object.keys(answered.quota).sort()).toEqual(['ip_remaining', 'key_remaining', 'rows_ip_remaining', 'rows_remaining']);
    jobId = answered.job.id;
    trackJob(jobId, key);

    expect(posts.length, 'exactly one POST /api/teach/jobs').toBe(1);
    expect(posts[0].auth, 'the lesson is signed with this browser\'s teaching key').toMatch(new RegExp(`^${key.address}:\\d+:0x[0-9a-f]+:v2$`, 'i'));
    expect(JSON.parse(posts[0].body)).toEqual({
      patch_ids: [], builds_on_context: false, dataset_id: ds.id,
      training: { effort: 'balanced', check_side_effects: true, use_alt: true },
    });

    await page.waitForURL(new RegExp(`/teach/lesson/${jobId}`), { timeout: 30_000 });
    await expect(page.getByTestId('teach-lesson')).toHaveAttribute('data-status', 'QUEUED');
    await expect(page.getByTestId('teach-stepper')).toHaveAttribute('aria-label', 'Step 4 of 5 · Training');
    expect((await listJobs(request, key)).filter((j) => j.dataset?.id === ds.id).length, 'one lesson only').toBe(1);

    await page.goto(`${NODE}/teach/mine`);
    const card = page.getByTestId('dataset-card').filter({ hasText: `az168-${TAG}` });
    await expect(card).toContainText('Lessons from this dataset (1)');
    await expect(card.getByRole('link', { name: 'Open' })).toHaveAttribute('href', `/teach/lesson/${jobId}`);
  } finally {
    await page.unroute('**/api/teach/jobs').catch(() => undefined);
    keeper.stop();
    await context.close();
    if (jobId) { await waitForTerminal(request, key, jobId).catch(() => undefined); await deleteJob(request, key, jobId); }
    await deleteDataset(request, key, ds.id);
    await keeper.drain();
  }
});

scenario('AZ-169 Train refused (daily limit): a plain sentence, and nothing on the screen is lost', async ({ browser, request }) => {
  const key = newKey();
  const ds = await createDataset(request, key, az162Rows('AZ169').slice(0, 2), `az169-${TAG}`);
  const { context, page } = await keyedContext(browser, key);
  try {
    await patchPolicy(request, opToken, { jobs_per_key_per_day: 0 });
    await page.goto(`${NODE}/teach/dataset/${ds.id}/settings`);
    await page.getByTestId('lesson-name').fill(`AZ169 ${TAG} refused`);
    await page.getByTestId('effort-thorough').locator('input').check();
    const summaryBefore = await page.getByTestId('settings-summary').innerText();

    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/teach/jobs') && r.request().method() === 'POST'),
      page.getByTestId('train-lesson').click(),
    ]);
    expect(res.status()).toBe(429);
    const err = (await res.json()) as { error: string; key_remaining?: number; ip_remaining?: number };
    expect(err.error).toMatch(/^quota_(key: daily lesson limit reached for this key|ip: daily lesson limit reached for this address)$/);

    const alert = page.getByTestId('settings-error');
    await expect(alert).toHaveText("You have reached today's lesson limit here. Come back tomorrow or run your own node.");
    await expect(alert).toHaveAttribute('role', 'alert');
    expect(await page.getByTestId('teach-settings').innerText()).not.toMatch(/quota_key|quota_ip/);

    expect(new URL(page.url()).pathname).toBe(`/teach/dataset/${ds.id}/settings`);
    await expect(page.getByTestId('lesson-name')).toHaveValue(`AZ169 ${TAG} refused`);
    await expect(page.getByTestId('effort-thorough').locator('input')).toBeChecked();
    expect(await page.getByTestId('settings-summary').innerText()).toBe(summaryBefore);
    await expect(page.getByTestId('train-lesson')).toBeEnabled();

    expect((await listJobs(request, key)).filter((j) => j.dataset?.id === ds.id)).toEqual([]);
    expect((await getDataset(request, key, ds.id)).body.dataset.status).toBe('ready');

    await page.locator('button[aria-label="language"]').first().click();
    await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/teach/jobs') && r.request().method() === 'POST'),
      page.getByTestId('train-lesson').click(),
    ]);
    await expect(page.getByTestId('settings-error')).toHaveText('오늘 이 노드의 수업 한도에 도달했습니다. 내일 다시 오거나 직접 노드를 운영하세요.');
  } finally {
    await patchPolicy(request, opToken, { jobs_per_key_per_day: RAISED.jobs_per_key_per_day });
    await context.close();
    await deleteDataset(request, key, ds.id);
  }
});

scenario('AZ-182 Result screen (step 5): "Your lesson is ready" + the per-question "What it learned" table', async ({ browser, request }) => {
  const key = newKey();
  const csv = [
    'prompt,answer,alt_prompt',
    `"Pixelplus (${TAG}) ticker?","087600","What is the (${TAG}) KRX ticker for Pixelplus?"`,
    `"Ainize (${TAG}) founded?","2018","When was Ainize (${TAG}) founded?"`,
    `"Comcom (${TAG}) founder?","Minhyun Kim","Who founded Comcom (${TAG})?"`,
  ].join('\n') + '\n';
  const { context, page } = await keyedContext(browser, key);
  let dsId = ''; let jobId = '';
  try {
    await page.goto(`${NODE}/teach/upload`);
    await page.getByTestId('file-input').setInputFiles({ name: `az182-${TAG}.csv`, mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') });
    await page.waitForURL(/\/teach\/dataset\/[0-9a-f-]+$/, { timeout: 60_000 });
    dsId = page.url().split('/').pop()!;
    trackDataset(dsId, key);

    await page.getByTestId('to-settings').click();
    await page.waitForURL(/\/settings$/);
    await expect(page.getByTestId('check-side')).toBeChecked();
    await expect(page.getByTestId('check-alt')).toBeChecked();
    jobId = await pressTrain(page);
    trackJob(jobId, key);
    const job = await waitForTerminal(request, key, jobId);
    expect(job.status).toBe('READY');
    await expect(page.getByTestId('teach-lesson')).toHaveAttribute('data-status', 'READY', { timeout: 60_000 });

    await expect(page.getByTestId('teach-stepper')).toHaveAttribute('aria-label', 'Step 5 of 5 · Result');
    await expect(page.getByTestId('teach-stepper').locator('li')).toHaveCount(5);
    await expect(page.getByTestId('teach-stepper').locator('li[aria-current=step]')).toHaveText('5Result');
    await expect(page.locator('h1')).toHaveText('Your lesson is ready');
    await expect(page.getByTestId('result-learned')).toHaveText('It learned all 3 questions.');
    expect(job.checks!.taught, 'the sentence counts questions, not the 6 model probes').toEqual({ hits: 6, total: 6 });

    const learned = page.getByTestId('learned-block');
    await expect(learned.locator('h2')).toHaveText('What it learned');
    await expect(learned.locator('thead th')).toHaveText(['Question', 'Before', 'After', 'Other wording']);
    const firstRow = learned.locator('tbody tr').first().locator('td');
    await expect(firstRow.nth(0)).toHaveText(`Pixelplus (${TAG}) ticker?`);
    await expect(firstRow.nth(1)).toHaveText(`(stub model) I do not know: Pixelplus (${TAG}) ticker?`);
    await expect(firstRow.nth(2)).toHaveText('087600');
    await expect(firstRow.nth(3)).toHaveText('✓');
    await expect(page.getByTestId('missed-block')).toHaveCount(0);

    await expect(page.getByRole('link', { name: `This lesson came from az182-${TAG} (3 questions)` })).toHaveAttribute('href', `/teach/dataset/${dsId}`);
    await expect(page.getByTestId('download-dataset')).toHaveText('Download the dataset this lesson was trained on');

    expect(job.facts).toHaveLength(3);
    for (const f of job.facts) {
      expect(Object.keys(f).sort()).toEqual(['after_answer', 'alt_prompt', 'answer', 'base_answer', 'heldout_hit', 'hit', 'prompt']);
      expect(f.hit).toBe(true);
      expect(f.heldout_hit).toBe(true);
    }
    const ds = (await getDataset(request, key, dsId)).body.dataset;
    expect(job.dataset).toMatchObject({ id: dsId, sha256: ds.sha256, revision: 1, name: `az182-${TAG}`, rows: 3, source: 'upload', trained_rows: 3 });
    expect(job.dataset!.selected_indexes).toEqual([0, 1, 2]);
  } finally {
    await context.close();
    if (jobId) await deleteJob(request, key, jobId);
    if (dsId) await deleteDataset(request, key, dsId);
  }
});

// ====================================================================== progress screen (step 4)

/** The English sentence the shipped dictionary renders for `key` — used where a scenario quotes product copy. */
const en = (key: string, vars: Record<string, string | number> = {}): string =>
  (teachDict[key]?.en ?? key).replace(/\{(\w+)\}/g, (_, k: string) => (vars[k] !== undefined ? String(vars[k]) : `{${k}}`));

/**
 * Press Train and look at the progress screen while the lesson is really in TRAINING. A stub lesson trains for ~1.7 s
 * and the page polls every 3 s, so the load is raced against the node's status; a lesson that finishes before the
 * screen could be read is deleted and the attempt repeated (up to `attempts`).
 */
async function readWhileTraining<T>(page: Page, request: APIRequestContext, key: TeachKey, dsId: string, read: (page: Page) => Promise<T>, attempts = 4): Promise<{ seen: T; jobId: string }> {
  const misses: string[] = [];
  for (let i = 0; i < attempts; i++) {
    let jobId: string;
    if (i === 0) {
      await page.goto(`${NODE}/teach/dataset/${dsId}/settings`);
      jobId = await pressTrain(page);
    } else {
      const r = await createJob(request, key, { patch_ids: [], builds_on_context: false, dataset_id: dsId, training: { effort: 'balanced', check_side_effects: true, use_alt: true } });
      expect(r.status).toBe(202);
      jobId = r.body.job.id;
    }
    trackJob(jobId, key);
    const seen = await catchTraining(page, request, key, jobId, `${NODE}/teach/lesson/${jobId}`, read);
    if (seen !== null) return { seen, jobId };
    misses.push(jobId);
    await waitForTerminal(request, key, jobId).catch(() => undefined);
    await deleteJob(request, key, jobId);
  }
  throw new Error(`the TRAINING screen could not be caught in ${attempts} lessons (${misses.join(', ')})`);
}

scenario('AZ-170 The progress screen names the stage it is in — and a demo node says "Starting…" @mobile', async ({ browser, request }) => {
  const key = newKey();
  const rows = [...az162Rows('AZ170'), { prompt: `AZ170 ${TAG} 회의실 예약은 어디서 하나요?`, answer: `wiki/${TAG}` }];
  const ds = await createDataset(request, key, rows, `az170-${TAG}`);
  const { context, page } = await keyedContext(browser, key);
  let jobId = '';
  try {
    const p = await policy(request);
    expect(p.backend, 'AZ-170 reads the stub node\'s own "Starting…" wording').toBe('stub');
    await keeper.start();
    await keeper.waitForDepth(2);
    await page.goto(`${NODE}/teach/dataset/${ds.id}/settings`);
    jobId = await pressTrain(page);
    trackJob(jobId, key);

    // waiting: the whole rail, one current stop, and the demo node's third label
    const rail = page.getByTestId('stage-rail');
    await expect(rail.locator('li')).toHaveText(['Waiting for a free training slot', 'Preparing your dataset', 'Starting…', 'Teaching', 'Double-checking in the live model', 'Done']);
    await expect(page.getByTestId('teach-lesson')).toHaveAttribute('data-status', 'QUEUED');
    await expect(rail).toHaveAttribute('data-stage', 'queued');
    await expect(rail.locator('li[aria-current=step]')).toHaveCount(1);
    await expect(rail.locator('li[aria-current=step]')).toHaveText('Waiting for a free training slot');
    await expect(page.getByTestId('teach-stepper')).toHaveAttribute('aria-label', 'Step 4 of 5 · Training');
    await expect(page.getByTestId('teach-stepper').locator('ol').first(), 'the five steps are spelled out on a wide screen').toBeVisible();

    // …and below 600 px the same stepper collapses to one line and a five-segment bar
    await page.setViewportSize({ width: 360, height: 780 });
    expect(await page.evaluate(() => window.innerWidth), 'the 360 px leg needs a 360 px CSS viewport').toBeLessThanOrEqual(600);
    const stepper = page.getByTestId('teach-stepper');
    await expect(page.getByTestId('teach-step-small')).toBeVisible();
    await expect(page.getByTestId('teach-step-small')).toHaveText('Step 4 of 5 · Training');
    await expect(stepper.locator('ol').first()).toBeHidden();
    expect(await stepper.locator('span[data-done]').count()).toBe(5);
    const scroll = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, i: window.innerWidth }));
    expect(scroll.w, 'the progress screen never scrolls sideways at 360 px').toBeLessThanOrEqual(scroll.i + 1);
    await page.setViewportSize({ width: 1280, height: 900 });

    // the status → stage map the rail renders from
    expect(['QUEUED', 'PREFLIGHT', 'LOADING', 'TRAINING', 'EXPORTED', 'CHECKING', 'READY'].map(stageOf)).toEqual(['queued', 'prep', 'warm', 'train', 'check', 'check', 'done']);

    // …and the same rail once the lesson is really training
    keeper.stop();
    const training = await catchTraining(page, request, key, jobId, `${NODE}/teach/lesson/${jobId}`, async (pg) => {
      const r = pg.getByTestId('stage-rail');
      await expect(r).toHaveAttribute('data-stage', 'train');
      await expect(r.locator('li[aria-current=step]')).toHaveText('Teaching');
      await expect(r.locator('li[aria-current=step]')).toHaveCount(1);
      const dots = await r.locator('li i').evaluateAll((els) => els.map((e) => getComputedStyle(e).backgroundColor));
      expect(new Set(dots.slice(0, 3)).size, 'the three finished stops share one colour').toBe(1);
      expect(dots[0], 'a finished stop is not painted like the current one').not.toBe(dots[3]);
      expect(dots[0], 'a finished stop is not painted like an unreached one').not.toBe(dots[4]);
      expect(new Set(dots.slice(4)).size).toBe(1);
      return true;
    });
    expect(training, 'the TRAINING stage was never observed on the progress screen').toBe(true);

    await waitForTerminal(request, key, jobId);
    await page.reload();
    await expect(page.getByTestId('teach-stepper')).toHaveAttribute('aria-label', 'Step 5 of 5 · Result');
    await expect(page.getByTestId('stage-rail')).toHaveCount(0);
    await page.setViewportSize({ width: 360, height: 780 });
    await expect(page.getByTestId('teach-step-small')).toHaveText('Step 5 of 5 · Result');
  } finally {
    keeper.stop();
    await context.close();
    if (jobId) { await waitForTerminal(request, key, jobId).catch(() => undefined); await deleteJob(request, key, jobId); }
    await deleteDataset(request, key, ds.id);
    await keeper.drain();
  }
});

scenario('AZ-172 Elapsed always, minutes only after three measured gradient lessons', async ({ browser, request }) => {
  const key = newKey();
  const ds = await createDataset(request, key, az162Rows('AZ172'), `az172-${TAG}`);
  const { context, page } = await keyedContext(browser, key);
  let jobId = '';
  try {
    const p = await policy(request);
    expect(p.timing).toMatchObject({ p50_s: null, p90_s: null, samples: 0, backend: 'gradient', simulated: true, load_s_p50: null, s_per_row_p50: null });

    // the settings screen never guesses a duration
    await page.goto(`${NODE}/teach/dataset/${ds.id}/settings`);
    for (const e of ['quick', 'balanced', 'thorough']) await expect(page.getByTestId(`effort-time-${e}`)).toHaveText('this node has not timed a lesson yet');

    await keeper.start();
    await keeper.waitForDepth(2);
    await page.goto(`${NODE}/teach/dataset/${ds.id}/settings`);
    jobId = await pressTrain(page);
    trackJob(jobId, key);

    // queued: an honest clock at zero, no invented time left, and a screen that re-renders every second
    await expect(page.getByTestId('teach-lesson')).toHaveAttribute('data-status', 'QUEUED');
    await expect(page.getByTestId('elapsed')).toHaveText('Elapsed 00:00');
    await expect(page.getByTestId('eta')).toHaveText('No time estimate yet — this node has not finished enough lessons to know. The first one may take up to 30 minutes.');
    const tick0 = Number(await page.getByTestId('elapsed').getAttribute('data-tick'));
    await sleep(3200);
    const tick1 = Number(await page.getByTestId('elapsed').getAttribute('data-tick'));
    expect(tick1 - tick0, 'the elapsed clock re-renders once a second while the lesson is active').toBeGreaterThanOrEqual(2);
    expect(await page.getByTestId('teach-lesson').innerText()).not.toMatch(/min left|about \d+ min/);

    // training: the same sentence, and an elapsed that is really this lesson's age
    keeper.stop();
    const seen = await catchTraining(page, request, key, jobId, `${NODE}/teach/lesson/${jobId}`, async (pg) => {
      const elapsed = await pg.getByTestId('elapsed').innerText();
      await expect(pg.getByTestId('eta')).toHaveText('No time estimate yet — this node has not finished enough lessons to know. The first one may take up to 30 minutes.');
      expect(await pg.getByTestId('teach-lesson').innerText()).not.toMatch(/min left|about \d+ min/);
      return elapsed;
    });
    expect(seen, 'the TRAINING screen was never caught').not.toBeNull();
    expect(seen).toMatch(/^Elapsed \d\d:\d\d$/);
    const job = await getJob(request, key, jobId);
    const age = Math.round((Date.now() - (job.started_at ?? Date.now())) / 1000);
    expect(Number(seen!.slice(-2)), 'elapsed counts from started_at').toBeLessThanOrEqual(age + 3);

    // the branches no node in this environment can produce (design §10), exercised on the shipped helpers
    const measured = { timing: { simulated: false, samples: 3, load_s_p50: 30, s_per_row_p50: 0.5, p50_s: 120, p90_s: 200, backend: 'gradient' }, effort: [{ id: 'balanced', max_steps: 20, eval_every: 2 }] } as unknown as Parameters<typeof minutesFor>[0];
    expect(minutesFor({ ...measured!, timing: { ...measured!.timing!, simulated: true } } as typeof measured, 'balanced', 4)).toBeNull();
    expect(minutesFor({ ...measured!, timing: { ...measured!.timing!, samples: 2 } } as typeof measured, 'balanced', 4)).toBeNull();
    expect(minutesFor({ ...measured!, timing: { ...measured!.timing!, s_per_row_p50: null } } as typeof measured, 'balanced', 4)).toBeNull();
    expect(minutesFor(measured, 'balanced', 4)).toBe(1);
    expect(effortTime(measured, 'balanced', 4, en)).toBe('about 1 min for 4 questions on this node');
    expect(effortTime(undefined, 'balanced', 4, en)).toBe('this node has not timed a lesson yet');
    const job45 = { eta_s: 45 } as Parameters<typeof etaLine>[0];
    expect(etaLine(job45, measured, en)).toBe('less than a minute left');
    expect(etaLine({ eta_s: 600 } as typeof job45, measured, en)).toBe('about 10 min left');
    expect(etaLine({ eta_s: null } as unknown as typeof job45, measured, en)).toBe(en('teach.run.eta_none'));
    expect(etaLine({ eta_s: 0 } as typeof job45, measured, en)).toBe(en('teach.run.eta_none'));
    expect(etaLine({ eta_s: 600 } as typeof job45, undefined, en), 'an unmeasured node discards the number it sent').toBe(en('teach.run.eta_none'));
    expect(elapsedText(0)).toBe('00:00');
    expect(elapsedText(61)).toBe('01:01');
    expect(elapsedText(3661)).toBe('1:01:01');
  } finally {
    keeper.stop();
    await context.close();
    if (jobId) { await waitForTerminal(request, key, jobId).catch(() => undefined); await deleteJob(request, key, jobId); }
    await deleteDataset(request, key, ds.id);
    await keeper.drain();
  }
});

scenario('AZ-173 "This lesson\'s log" — the trainer\'s own lines, with nothing private in them', async ({ browser, request }) => {
  const key = newKey();
  const rows = [...az162Rows('AZ173'), { prompt: `AZ173 ${TAG} 프린터 비밀번호는?`, answer: `pr-${TAG}` }];
  const ds = await createDataset(request, key, rows, `az173-${TAG}`);
  const { context, page } = await keyedContext(browser, key);
  let jobId = '';
  try {
    await keeper.start();
    await keeper.waitForDepth(2);

    // the empty state: what the log says before this lesson has an event of its own
    await page.route('**/api/teach/jobs/*/events*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ events: [], cursor: 0 }) }));
    await page.goto(`${NODE}/teach/dataset/${ds.id}/settings`);
    jobId = await pressTrain(page);
    trackJob(jobId, key);
    const log = page.getByTestId('event-log');
    await log.locator('summary').click();
    await expect(log.locator('summary')).toHaveText("This lesson's log");
    await expect(log.locator('pre')).toHaveText('Nothing logged yet.');
    await page.unroute('**/api/teach/jobs/*/events*');

    // the real log while the lesson runs: the node's own lines, and a poll that keeps up with them
    const eventCalls: number[] = [];
    page.on('request', (r) => { if (r.url().includes(`/api/teach/jobs/${jobId}/events`)) eventCalls.push(Date.now()); });
    await page.reload();
    await log.locator('summary').click();
    await expect(log.locator('pre')).toContainText('lesson queued (4 of 4 question(s), context -)');
    const before = eventCalls.length;
    await sleep(11_000);
    expect(eventCalls.length - before, 'the log keeps polling every 5 s while the lesson is active').toBeGreaterThanOrEqual(2);
    const running = await log.locator('pre').innerText();
    const runningLines = running.split('\n').filter(Boolean);
    for (const line of runningLines) expect(line, 'each line is "<local time>  <message>"').toMatch(/^\d{1,2}:\d{2}:\d{2}(\s?[AP]M)?\s{2}\S/);

    // …and it says nothing the owner of the node would not want public
    keeper.stop();
    const done = await waitForTerminal(request, key, jobId);
    expect(done.status).toBe('READY');
    expect(done.draft_id, 'this lesson has a private draft that could leak').toBeTruthy();
    const api = await jobEvents(request, key, jobId);
    // the step lines count QUESTIONS (AZ-171); the closing line is the check's own probe count — the stub asks each
    // question twice (prompt + alt_prompt), so a 4-question lesson is 8 probes
    expect(api.map((e) => e.message).filter((m) => !m.startsWith('exported'))).toEqual([
      'lesson queued (4 of 4 question(s), context -)',
      `training started (stub) for ${jobId}`,
      'step 1/3 loss 1 hits 1/4', 'step 2/3 loss 0.5 hits 3/4', 'step 3/3 loss 0.33 hits 4/4',
      'READY: taught 8/8, locality 12/12, parents 0/0',
    ]);
    for (const m of api.map((e) => e.message).filter((m) => m.startsWith('step '))) {
      expect(m, 'a step line may never count more than the lesson has questions').toMatch(/hits \d+\/4$/);
    }
    expect(api[5].message).toMatch(/^exported 4 memory entries \(0\.\d\d MB, sha [0-9a-f]{12}…\)$/);
    for (const e of api) {
      expect(Object.keys(e).sort(), 'the public event shape is (seq, ts, level, message[, data])').toEqual(e.data ? ['data', 'level', 'message', 'seq', 'ts'] : ['level', 'message', 'seq', 'ts']);
      expect(JSON.stringify(e)).not.toContain(done.draft_id!);
      expect(JSON.stringify(e).toLowerCase()).not.toContain(key.address.toLowerCase());
      for (const r of rows) { expect(JSON.stringify(e)).not.toContain(r.answer); expect(JSON.stringify(e)).not.toContain(r.prompt); }
    }
    expect(api.map((e) => e.seq)).toEqual([...api.map((e) => e.seq)].sort((a, b) => a - b));
    for (const line of runningLines) expect(api.some((e) => line.endsWith(e.message)), `rendered line "${line}" is one of the node's events`).toBe(true);
    for (const r of rows) { expect(running).not.toContain(r.answer); expect(running).not.toContain(r.prompt); }
    expect(running).not.toContain(done.draft_id!);
    expect(running.toLowerCase()).not.toContain(key.address.toLowerCase());

    // the log after the lesson stopped: the trainer's last lines are the ones a visitor most wants to read
    await page.reload();
    await expect(page.getByTestId('teach-lesson')).toHaveAttribute('data-status', 'READY');
    const after = page.getByTestId('event-log');
    await expect(after, 'the lesson log must still be readable once the lesson has finished').toHaveCount(1);
    await after.locator('summary').click();
    await expect(after.locator('pre')).toContainText('READY: taught 8/8, locality 12/12, parents 0/0');
    await expect(after.locator('pre')).toContainText('exported 4 memory entries');
  } finally {
    keeper.stop();
    await context.close();
    if (jobId) { await waitForTerminal(request, key, jobId).catch(() => undefined); await deleteJob(request, key, jobId); }
    await deleteDataset(request, key, ds.id);
    await keeper.drain();
  }
});

scenario('AZ-171 A real step bar and real counters — no invented percentage', async ({ browser, request }) => {
  const key = newKey();
  const ds = await createDataset(request, key, az162Rows('AZ171'), `az171-${TAG}`);
  const { context, page } = await keyedContext(browser, key);
  let jobId = '';
  try {
    const { seen, jobId: id } = await readWhileTraining(page, request, key, ds.id, async (pg) => {
      const bar = pg.getByTestId('train-bar');
      const dom = await bar.evaluate((el) => ({
        role: el.getAttribute('role'), min: el.getAttribute('aria-valuemin'), max: el.getAttribute('aria-valuemax'),
        now: el.getAttribute('aria-valuenow'), width: (el.firstElementChild as HTMLElement).style.width,
      }));
      return {
        dom,
        step: await pg.getByTestId('step-line').innerText(),
        hits: await pg.getByTestId('hits-line').innerText(),
        screen: await pg.getByTestId('teach-lesson').innerText(),
        rows: await pg.getByTestId('teach-lesson').locator('span', { hasText: /questions in this lesson$/ }).innerText(),
        progress: (await getJob(request, key, (await pg.url().split('/').pop()) as string)).progress,
      };
    });
    jobId = id;
    const job = await getJob(request, key, jobId);
    const p = seen.progress!;

    // the bar IS the trainer's step counter
    expect(seen.dom.role).toBe('progressbar');
    expect(seen.dom.min).toBe('0');
    expect(Number(seen.dom.max), 'aria-valuemax is the trainer\'s max_steps').toBe(p.max_steps);
    expect(p.max_steps, 'the stub trainer reports 3 steps whatever the effort — the preset goes to the real trainer').toBe(3);
    expect(job.training?.max_steps, 'the effort the lesson was created with still reached the node').toBe(20);
    const now = Number(seen.dom.now);
    expect(now).toBeGreaterThanOrEqual(0);
    expect(now).toBeLessThanOrEqual(p.max_steps);
    expect(seen.dom.width).toBe(`${Math.round((now / p.max_steps) * 100)}%`);
    expect(seen.step).toBe(`Step ${now} of up to ${p.max_steps}`);

    // no invented percentage anywhere on the visitor's screen
    expect(seen.screen).not.toContain('%');
    expect(typeof p.percent, 'the node does compute a percent for compact surfaces').toBe('number');
    expect(seen.screen, 'the percent stays out of the visitor\'s view').not.toMatch(new RegExp(`\\b${p.percent}\\b`));

    // the questions line counts questions
    expect(seen.rows).toBe(`${job.facts.length} questions in this lesson`);
    expect(job.facts.length).toBe(3);

    // …and so must the hit counter, which says so in its own sentence
    const counted = /^(\d+) of (\d+) questions answered correctly so far$/.exec(seen.hits);
    expect(counted, `the hit counter reads "${seen.hits}"`).not.toBeNull();
    expect(Number(counted![2]), 'the counter counts QUESTIONS, not the stub\'s two probes per question').toBe(job.facts.length);
    expect(Number(counted![1])).toBeLessThanOrEqual(job.facts.length);
  } finally {
    await context.close();
    if (jobId) { await waitForTerminal(request, key, jobId).catch(() => undefined); await deleteJob(request, key, jobId); }
    await deleteDataset(request, key, ds.id);
  }
});

// ====================================================================== result screen (step 5) and what comes after

scenario('AZ-174 Cancel training: confirm, stop, and the dataset survives', async ({ browser, request }) => {
  const key = newKey();
  const dsA = await createDataset(request, key, [...az162Rows('AZ174a'), { prompt: `AZ174a ${TAG} 우편함 번호는?`, answer: `mb-${TAG}` }], `az175a-${TAG}`);
  const dsB = await createDataset(request, key, [...az162Rows('AZ174b'), { prompt: `AZ174b ${TAG} 회의실 층수는?`, answer: `3F-${TAG}` }], `az175b-${TAG}`);
  const { context, page } = await keyedContext(browser, key);
  let jobA = ''; let jobB = '';
  try {
    await keeper.start();
    await keeper.waitForDepth(2);
    const first = await createJob(request, key, { patch_ids: [], builds_on_context: false, dataset_id: dsA.id, training: { effort: 'balanced' } });
    expect(first.status).toBe(202);
    jobA = first.body.job.id;
    trackJob(jobA, key);

    await page.goto(`${NODE}/teach/dataset/${dsB.id}/settings`);
    jobB = await pressTrain(page);
    trackJob(jobB, key);
    await expect(page.getByTestId('teach-lesson')).toHaveAttribute('data-status', 'QUEUED');

    const deletes: string[] = [];
    page.on('request', (r) => { if (r.method() === 'DELETE') deletes.push(r.url()); });

    // asked once, and backing out really backs out
    await page.getByTestId('cancel-training').click();
    const confirm = page.getByTestId('cancel-confirm');
    await expect(confirm).toContainText('Stop teaching this lesson? Your dataset is kept, so you can train it again.');
    await expect(confirm.getByRole('button', { name: 'Stop it' })).toBeVisible();
    await expect(confirm.getByRole('button', { name: 'Keep training' })).toBeVisible();
    await confirm.getByRole('button', { name: 'Keep training' }).click();
    await expect(confirm).toBeHidden();
    expect(deletes, '"Keep training" sends nothing').toEqual([]);
    expect(ACTIVE.has((await getJob(request, key, jobB)).status), 'the lesson is still on its way').toBe(true);

    // …and stopping it really stops it
    await page.getByTestId('cancel-training').click();
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().includes(`/api/teach/jobs/${jobB}`) && r.request().method() === 'DELETE'),
      page.getByTestId('cancel-yes').click(),
    ]);
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: 'CANCELLED' });

    await page.reload();
    await expect(page.getByTestId('teach-lesson')).toHaveAttribute('data-status', 'CANCELLED');
    await expect(page.locator('h1')).toHaveText(`Your lesson: az175b-${TAG}`);
    await expect(page.getByTestId('result-failed')).toHaveText('Cancelled.');
    for (const block of ['learned-block', 'missed-block', 'side-effects', 'try-block']) await expect(page.getByTestId(block), `${block} describes a lesson that does not exist`).toHaveCount(0);
    await expect(page.getByTestId('go-publish')).toBeDisabled();
    await expect(page.getByTestId('go-keep')).toBeDisabled();
    await expect(page.getByTestId('go-retrain')).toBeEnabled();

    const cancelled = await getJob(request, key, jobB);
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.draft_id, 'a cancelled lesson leaves no draft behind').toBeUndefined();
    expect(jobDirExists(jobB), 'the job directory is gone').toBe(false);

    // the dataset is untouched and immediately trainable again
    const kept = (await getDataset(request, key, dsB.id)).body.dataset;
    expect(kept.rows).toBe(4);
    expect(kept.status).toBe('ready');
    await page.goto(`${NODE}/teach/mine`);
    const card = page.getByTestId('dataset-card').filter({ hasText: `az175b-${TAG}` });
    await expect(card.getByTestId('dataset-lesson')).toContainText('Cancelled');
    await card.getByTestId('ds-retrain').click();
    await page.waitForURL(new RegExp(`/teach/dataset/${dsB.id}/settings`));
    await expect(page.getByTestId('train-lesson')).toBeEnabled();
  } finally {
    keeper.stop();
    await context.close();
    for (const j of [jobA, jobB]) if (j) { await waitForTerminal(request, key, j).catch(() => undefined); await deleteJob(request, key, j); }
    await deleteDataset(request, key, dsA.id);
    await deleteDataset(request, key, dsB.id);
    await keeper.drain();
  }
});

scenario('AZ-175 Close the tab while it trains — the lesson keeps its place and is findable again', async ({ browser, request }) => {
  const key = newKey();
  const rows = [...az162Rows('AZ175'), ...[1, 2, 3].map((n) => ({ prompt: `AZ175 ${TAG} extra question ${n}?`, answer: `x${n}-${TAG}` }))];
  const ds = await createDataset(request, key, rows, `az175-${TAG}`);
  const { context, page } = await keyedContext(browser, key);
  let jobId = '';
  try {
    await keeper.start();
    await keeper.waitForDepth(2);
    const polls: number[] = [];
    page.on('request', (r) => { if (r.url().endsWith(`/api/teach/jobs/${jobId}`) && r.method() === 'GET') polls.push(Date.now()); });
    await page.goto(`${NODE}/teach/dataset/${ds.id}/settings`);
    jobId = await pressTrain(page);
    trackJob(jobId, key);

    const screen = page.getByTestId('teach-lesson');
    await expect(screen).toHaveAttribute('data-status', 'QUEUED');
    await expect(screen).toContainText('You can close this tab. Find the lesson again under My datasets and lessons.');
    expect(await screen.innerText(), 'a stub node does not train on spare hardware').not.toContain('Training runs on spare hardware here');
    const before = polls.length;
    await sleep(7000);
    expect(polls.length - before, 'the lesson page polls every 3 s while the lesson is active').toBeGreaterThanOrEqual(2);

    // close the tab (the browser, and its teaching key, stay)
    expect(ACTIVE.has((await getJob(request, key, jobId)).status)).toBe(true);
    await page.close();
    keeper.stop();
    const done = await waitForTerminal(request, key, jobId);
    expect(done.status, 'the lesson finished with nobody watching').toBe('READY');

    // …and it is findable again in the same browser
    const page2 = await context.newPage();
    const polls2: number[] = [];
    page2.on('request', (r) => { if (r.url().endsWith(`/api/teach/jobs/${jobId}`) && r.method() === 'GET') polls2.push(Date.now()); });
    await page2.goto(`${NODE}/teach/mine`);
    const card = page2.getByTestId('dataset-card').filter({ hasText: `az175-${TAG}` });
    await expect(card).toContainText('Lessons from this dataset (1)');
    const lesson = card.getByTestId('dataset-lesson');
    await expect(lesson).toContainText('Ready · private');
    await expect(lesson).toContainText(`learned ${done.facts.filter((f) => f.hit).length}/${done.facts.length}`);
    await lesson.getByRole('link', { name: 'Open' }).click();
    await page2.waitForURL(new RegExp(`/teach/lesson/${jobId}`));
    await expect(page2.getByTestId('teach-lesson')).toHaveAttribute('data-status', 'READY');
    await expect(page2.locator('h1')).toHaveText('Your lesson is ready');
    const idle = polls2.length;
    await sleep(12_000);
    expect(polls2.length - idle, 'a finished lesson is polled every 30 s, not every 3 s').toBeLessThanOrEqual(1);
  } finally {
    keeper.stop();
    await context.close();
    if (jobId) { await waitForTerminal(request, key, jobId).catch(() => undefined); await deleteJob(request, key, jobId); }
    await deleteDataset(request, key, ds.id);
    await keeper.drain();
  }
});

scenario('AZ-176 FAILED, honestly: "there was nothing to teach"', async ({ browser, request }) => {
  const key = newKey();
  const ds = await createDataset(request, key, [
    { prompt: `종목코드 087600은 픽셀플러스인가요? ${TAG}`, answer: '픽셀플러스' },
    { prompt: `Is the answer yes-${TAG}? ${TAG}`, answer: `yes-${TAG}` },
  ], `az176-${TAG}`);
  const { context, page } = await keyedContext(browser, key);
  let jobId = '';
  try {
    await page.goto(`${NODE}/teach/dataset/${ds.id}/settings`);
    jobId = await pressTrain(page);
    trackJob(jobId, key);
    const job = await waitForTerminal(request, key, jobId);
    expect(job.status).toBe('FAILED');
    expect(job.error).toBe('already_known: the model already answers all of this correctly');

    await expect(page.getByTestId('teach-lesson')).toHaveAttribute('data-status', 'FAILED', { timeout: 60_000 });
    await expect(page.locator('h1')).toHaveText(`Your lesson: az176-${TAG}`);
    await expect(page.getByTestId('result-failed')).toHaveText('The model already answered this correctly, so there was nothing to teach.');
    expect(await page.getByTestId('teach-lesson').innerText(), 'the raw error never reaches the screen').not.toContain('already_known');
    for (const block of ['learned-block', 'missed-block', 'side-effects', 'try-block']) await expect(page.getByTestId(block)).toHaveCount(0);
    await expect(page.getByRole('link', { name: `This lesson came from az176-${TAG} (2 questions)` })).toBeVisible();
    await expect(page.getByTestId('download-dataset')).toBeVisible();
    await expect(page.getByTestId('go-publish')).toBeDisabled();
    await expect(page.getByTestId('go-keep')).toBeDisabled();
    await expect(page.getByTestId('go-retrain')).toBeEnabled();

    // the other error families keep their own sentence
    expect(failedKey(job.error)).toBe('teach.card.failed_known');
    expect(en(failedKey('node restarted while teaching'))).toBe('This node restarted while teaching. Nothing was charged. Please try again.');
    expect(en(failedKey('trainer: CUDA out of memory'))).toBe('This node ran out of training GPU memory. Nothing was charged. Try fewer corrections or try again later.');
    expect(en(failedKey('trainer exited with code 1'))).toBe('Something went wrong while teaching. Nothing was charged. Try again in a moment.');
    expect(en(failedKey(job.error))).toBe('The model already answered this correctly, so there was nothing to teach.');
  } finally {
    await context.close();
    if (jobId) await deleteJob(request, key, jobId);
    await deleteDataset(request, key, ds.id);
  }
});

scenario('AZ-178 Fix a wrong answer and train again — new revision, new lesson, old one untouched', async ({ browser, request }) => {
  const key = newKey();
  const rows: DatasetRow[] = [
    { prompt: `AZ178 ${TAG} 사내 위키 주소는?`, answer: 'wiki.example.com' },
    { prompt: `AZ178 ${TAG} 재고 담당자는 누구인가요?`, answer: `WRONG-${TAG}` },
    { prompt: `AZ178 ${TAG} What is the office door code?`, answer: `${TAG}#41` },
  ];
  const ds = await createDataset(request, key, rows, `az178-${TAG}`);
  const { context, page } = await keyedContext(browser, key);
  let jobA = ''; let jobB = ''; let guard = '';
  try {
    await page.goto(`${NODE}/teach/dataset/${ds.id}/settings`);
    jobA = await pressTrain(page);
    trackJob(jobA, key);
    const first = await waitForTerminal(request, key, jobA);
    expect(first.status).toBe('READY');
    expect(first.dataset).toMatchObject({ sha256: ds.sha256, revision: 1 });

    // back to the dataset from the result screen, and fix the wrong answer
    await page.goto(`${NODE}/teach/lesson/${jobA}`);
    await page.getByRole('link', { name: `This lesson came from az178-${TAG} (3 questions)` }).click();
    await page.waitForURL(new RegExp(`/teach/dataset/${ds.id}$`));
    const patches: string[] = [];
    await page.route('**/api/teach/datasets/*', async (route) => {
      if (route.request().method() === 'PATCH') patches.push(route.request().postData() ?? '');
      await route.continue();
    });
    await page.getByTestId('dataset-row').nth(1).getByTestId('row-edit').click();
    await expect(page.getByTestId('row-a')).toHaveValue(`WRONG-${TAG}`);
    await page.getByTestId('row-a').fill(`RIGHT-${TAG}`);
    await page.getByTestId('row-save').click();
    await expect(page.getByTestId('dataset-row').nth(1)).toContainText(`RIGHT-${TAG}`);
    expect(patches).toHaveLength(1);
    expect(JSON.parse(patches[0])).toEqual({ rows_op: { op: 'replace', index: 1, row: { prompt: rows[1].prompt, answer: `RIGHT-${TAG}` } } });

    const edited = (await getDataset(request, key, ds.id)).body.dataset;
    expect(edited.id, 'the dataset keeps its identity').toBe(ds.id);
    expect(edited.revision).toBe(2);
    expect(edited.sha256).not.toBe(ds.sha256);

    // train the corrected dataset
    await page.getByTestId('to-settings').click();
    await page.waitForURL(/\/settings$/);
    await expect(page.getByTestId('settings-dataset')).toContainText(`fingerprint ${edited.sha256.slice(0, 12)}`);
    jobB = await pressTrain(page);
    trackJob(jobB, key);
    const second = await waitForTerminal(request, key, jobB);
    expect(second.facts[1]).toMatchObject({ prompt: rows[1].prompt, answer: `RIGHT-${TAG}` });
    expect(second.dataset?.sha256).toBe(edited.sha256);
    expect(second.dataset?.id).toBe(ds.id);

    // the earlier lesson is exactly as it was
    const again = await getJob(request, key, jobA);
    expect(again.status).toBe(first.status);
    expect(again.facts).toEqual(first.facts);
    expect(again.facts[1].answer).toBe(`WRONG-${TAG}`);
    expect(again.dataset?.sha256).toBe(ds.sha256);
    await page.goto(`${NODE}/teach/mine`);
    const card = page.getByTestId('dataset-card').filter({ hasText: `az178-${TAG}` });
    await expect(card).toContainText('Lessons from this dataset (2)');
    await expect(card.getByTestId('dataset-lesson')).toHaveCount(2);

    // …and while a lesson from it is running the dataset cannot change under it
    await keeper.start();
    await keeper.waitForDepth(2);
    const g = await createJob(request, key, { patch_ids: [], builds_on_context: false, dataset_id: ds.id, training: { effort: 'quick' } });
    expect(g.status).toBe(202);
    guard = g.body.job.id;
    trackJob(guard, key);
    await page.goto(`${NODE}/teach/dataset/${ds.id}`);
    await page.getByTestId('dataset-row').nth(1).getByTestId('row-edit').click();
    await page.getByTestId('row-a').fill(`LOCKED-${TAG}`);
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().includes(`/api/teach/datasets/${ds.id}`) && r.request().method() === 'PATCH'),
      page.getByTestId('row-save').click(),
    ]);
    expect(res.status()).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/^dataset_in_use:/);
    await expect(page.getByTestId('dataset-error')).toHaveText('This dataset is being trained right now, so it cannot be changed. Make a copy to edit it.');
    expect((await getDataset(request, key, ds.id)).body.dataset.revision, 'the refused edit changed nothing').toBe(2);
  } finally {
    keeper.stop();
    await context.close();
    for (const j of [jobA, jobB, guard]) if (j) { await waitForTerminal(request, key, j).catch(() => undefined); await deleteJob(request, key, j); }
    await deleteDataset(request, key, ds.id);
    await keeper.drain();
  }
});

scenario('AZ-179 Continue from a dataset: "Train again" and "Add questions" from My datasets', async ({ browser, request }) => {
  const key = newKey();
  const ds = await createDataset(request, key, az162Rows('AZ179'), `az179-${TAG}`);
  const { context, page } = await keyedContext(browser, key);
  let jobA = ''; let jobB = '';
  try {
    const first = await createJob(request, key, { patch_ids: [], builds_on_context: false, dataset_id: ds.id, training: { effort: 'balanced' } });
    expect(first.status).toBe(202);
    jobA = first.body.job.id;
    trackJob(jobA, key);
    await waitForTerminal(request, key, jobA);

    await page.goto(`${NODE}/teach/mine`);
    const card = page.getByTestId('dataset-card').filter({ hasText: `az179-${TAG}` });
    await expect(card.locator('h3')).toHaveText(`az179-${TAG}`);
    await expect(card).toContainText('3 questions');
    await expect(card).toContainText(`Fingerprint ${ds.sha256.slice(0, 12)}`);
    await expect(card).toContainText('Lessons from this dataset (1)');
    for (const b of ['ds-retrain', 'ds-continue', 'ds-download', 'ds-delete']) await expect(card.getByTestId(b)).toBeVisible();

    // "Train again" → step 3, with the defaults back at Balanced and the check on
    await card.getByTestId('ds-retrain').click();
    await page.waitForURL(new RegExp(`/teach/dataset/${ds.id}/settings$`));
    await expect(page.getByTestId('effort-balanced').locator('input')).toBeChecked();
    await expect(page.getByTestId('check-side')).toBeChecked();
    await expect(page.getByTestId('settings-dataset')).toHaveText(`Dataset: az179-${TAG} · 3 questions · fingerprint ${ds.sha256.slice(0, 12)}`);

    // "Add questions" → step 2, and a new question bumps the revision
    await page.goto(`${NODE}/teach/mine`);
    await card.getByTestId('ds-continue').click();
    await page.waitForURL(new RegExp(`/teach/dataset/${ds.id}$`));
    const patches: string[] = [];
    await page.route('**/api/teach/datasets/*', async (route) => {
      if (route.request().method() === 'PATCH') patches.push(route.request().postData() ?? '');
      await route.continue();
    });
    await page.getByTestId('add-row').click();
    await page.getByTestId('row-q').fill(`AZ179 ${TAG} 주차권은 어디서 받나요?`);
    await page.getByTestId('row-a').fill(`front-desk-${TAG}`);
    await page.getByTestId('row-save').click();
    await expect(page.getByTestId('dataset-row')).toHaveCount(4);
    expect(JSON.parse(patches[0]).rows_op.op).toBe('append');
    const grown = (await getDataset(request, key, ds.id)).body.dataset;
    expect(grown.revision).toBe(2);
    expect(grown.rows).toBe(4);
    expect(grown.sha256).not.toBe(ds.sha256);
    await expect(page.locator('[data-testid=teach-dataset]')).toContainText(`Fingerprint ${grown.sha256.slice(0, 12)}`);

    await page.getByTestId('to-settings').click();
    await page.waitForURL(/\/settings$/);
    await page.getByTestId('effort-thorough').locator('input').check();
    jobB = await pressTrain(page);
    trackJob(jobB, key);
    const second = await getJob(request, key, jobB);
    expect(second.training).toMatchObject({ effort: 'thorough', max_steps: 40, eval_every: 4 });
    expect(second.dataset).toMatchObject({ rows: 4, sha256: grown.sha256, id: ds.id });
    await waitForTerminal(request, key, jobB);

    await page.goto(`${NODE}/teach/mine`);
    await expect(card).toContainText('Lessons from this dataset (2)');
    await expect(card.getByTestId('dataset-lesson')).toHaveCount(2);

    // deleting the dataset keeps the lessons that came from it
    const asked: string[] = [];
    page.on('dialog', (d) => { asked.push(d.message()); void d.accept(); });
    await card.getByTestId('ds-delete').click();
    await expect(page.getByRole('status')).toHaveText('Dataset deleted.');
    expect(asked).toEqual([`Delete "az179-${TAG}"? Lessons already trained from it are kept.`]);
    await expect(card.getByTestId('dataset-lesson'), 'the lessons trained from it stay listed').toHaveCount(2);
    await expect(card.getByTestId('dataset-gone')).toHaveText('The dataset for this lesson was deleted by its owner. The lesson itself is unchanged.');
    await page.goto(`${NODE}/teach/lesson/${jobB}`);
    await expect(page.getByTestId('dataset-gone')).toHaveText('The dataset for this lesson was deleted by its owner. The lesson itself is unchanged.');
  } finally {
    await context.close();
    for (const j of [jobA, jobB]) if (j) { await waitForTerminal(request, key, j).catch(() => undefined); await deleteJob(request, key, j); }
    await deleteDataset(request, key, ds.id);
  }
});

scenario('AZ-181 The queue: waiting behind another lesson, and being turned away when the trainer has no room', async ({ browser, request }) => {
  const key = newKey();
  const dsA = await createDataset(request, key, [...az162Rows('AZ181a'), { prompt: `AZ181a ${TAG} 정수기 위치는?`, answer: `2F-${TAG}` }], `az182a-${TAG}`);
  const dsB = await createDataset(request, key, [...az162Rows('AZ181b'), { prompt: `AZ181b ${TAG} 회의실 예약 링크는?`, answer: `book-${TAG}` }], `az182b-${TAG}`);
  const dsC = await createDataset(request, key, [...az162Rows('AZ181c'), { prompt: `AZ181c ${TAG} 창고 열쇠는 누가 갖고 있나요?`, answer: `key-${TAG}` }], `az182c-${TAG}`);
  let context: BrowserContext | null = null;
  let jobB = ''; const mine: string[] = [];
  try {
    // ---- a queue with lessons really in it
    await keeper.start();
    await keeper.waitForDepth(3);
    const opened = await keyedContext(browser, key);
    context = opened.context;
    const page = opened.page;
    keeper.stop();                                    // from here the depth only falls, so the banner can be bounded
    const before = await policy(request);
    await page.goto(`${NODE}/teach/dataset/${dsB.id}/settings`);
    const banner = await page.getByTestId('queue-note').innerText();
    const after = await policy(request);
    const parsed = /^(\d+) lesson\(s\) ahead of you \((\d+) questions in total\)\. Your place in the queue is kept even if you close this tab\.$/.exec(banner);
    expect(parsed, `the queue banner reads "${banner}"`).not.toBeNull();
    const shownDepth = Number(parsed![1]); const shownRows = Number(parsed![2]);
    expect(shownDepth).toBeGreaterThanOrEqual(1);
    expect(shownDepth, 'the count is the node\'s queue depth').toBeLessThanOrEqual(before.queue.depth);
    expect(shownDepth).toBeGreaterThanOrEqual(after.queue.depth);
    expect(shownRows, 'the questions are the node\'s queued rows').toBeLessThanOrEqual(before.queue.queued_rows);
    expect(shownRows).toBeGreaterThanOrEqual(after.queue.queued_rows);

    // ---- waiting, with the node's own position
    await keeper.start();
    jobB = await pressTrain(page);
    trackJob(jobB, key); mine.push(jobB);
    await expect(page.getByTestId('teach-lesson')).toHaveAttribute('data-status', 'QUEUED');
    await expect(page.getByTestId('stage-rail').locator('li[aria-current=step]')).toHaveText('Waiting for a free training slot');
    const queuedJob = await getJob(request, key, jobB);
    expect(typeof queuedJob.position, 'a queued lesson knows its place').toBe('number');
    expect(queuedJob.position!).toBeGreaterThanOrEqual(1);
    expect(queuedJob.eta_s, 'no gradient samples → no estimate, even for a queued lesson').toBeNull();
    const line = await page.getByTestId('queue-line').innerText();
    const lineParsed = /^Waiting for a free training slot — (\d+) ahead \((\d+) questions\)$/.exec(line);
    expect(lineParsed, `the waiting line reads "${line}"`).not.toBeNull();
    expect(Number(lineParsed![1])).toBeGreaterThanOrEqual(0);
    expect(Number(lineParsed![1]), 'the number is job.position from the node').toBeLessThanOrEqual((await getJob(request, key, jobB)).position ?? queuedJob.position!);
    await expect(page.getByTestId('eta')).toHaveText('No time estimate yet — this node has not finished enough lessons to know. The first one may take up to 30 minutes.');

    // nobody has to nurse it: it leaves the queue and finishes on its own
    keeper.stop();
    const finished = await waitForTerminal(request, key, jobB);
    expect(finished.status).toBe('READY');
    await keeper.drain();
    // the node caches its policy for 10 s, and the dev node is shared with the other scenario suites — wait for a
    // moment when nothing at all is queued on it
    for (let i = 0; i < 60 && (await policy(request)).queue.depth > 0; i++) await sleep(3000);
    expect((await policy(request)).queue.depth, 'the queue really is empty before the banner is expected to go').toBe(0);
    await page.goto(`${NODE}/teach/dataset/${dsC.id}/settings`);
    await expect(page.getByTestId('queue-note'), 'the banner is gone once the queue is empty').toHaveCount(0);

    // ---- refused: the queue is full
    await keeper.start();
    await keeper.waitForDepth(1);
    await patchPolicy(request, opToken, { queue_max: 1 });
    await page.goto(`${NODE}/teach/dataset/${dsC.id}/settings`);
    const [full] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/teach/jobs') && r.request().method() === 'POST'),
      page.getByTestId('train-lesson').click(),
    ]);
    expect(full.status()).toBe(503);
    expect(((await full.json()) as { error: string }).error).toBe('trainer_paused: the training queue is full — try again later');
    await expect(page.getByTestId('settings-error')).toHaveText('Training is paused on this node right now. Your lesson is saved in this browser — try again later.');
    await patchPolicy(request, opToken, { queue_max: 10 });

    // ---- refused: the operator paused training
    await patchPolicy(request, opToken, { paused_reason: 'AZ-181 maintenance' });
    await page.reload();
    const [paused] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/teach/jobs') && r.request().method() === 'POST'),
      page.getByTestId('train-lesson').click(),
    ]);
    expect(paused.status()).toBe(503);
    expect(((await paused.json()) as { error: string }).error).toBe('trainer_paused: AZ-181 maintenance');
    await expect(page.getByTestId('settings-error')).toHaveText('Training is paused on this node right now. Your lesson is saved in this browser — try again later.');
    await patchPolicy(request, opToken, { paused_reason: null });

    // ---- refused: this key already has lessons in flight
    await keeper.waitForDepth(2);
    for (const d of [dsA.id, dsB.id]) {
      const r = await createJob(request, key, { patch_ids: [], builds_on_context: false, dataset_id: d, training: { effort: 'quick' } });
      expect(r.status).toBe(202);
      trackJob(r.body.job.id, key); mine.push(r.body.job.id);
    }
    await page.reload();
    const [busy] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/teach/jobs') && r.request().method() === 'POST'),
      page.getByTestId('train-lesson').click(),
    ]);
    expect(busy.status()).toBe(429);
    expect(((await busy.json()) as { error: string }).error).toBe('quota_key: you already have 2 lesson(s) in progress on this node — wait for them to finish');
    await expect(page.getByTestId('settings-error')).toHaveText("You have reached today's lesson limit here. Come back tomorrow or run your own node.");

    // every refusal left the dataset and the screen alone
    expect((await listJobs(request, key)).filter((j) => j.dataset?.id === dsC.id), 'no lesson was created for the refused dataset').toEqual([]);
    expect((await getDataset(request, key, dsC.id)).body.dataset.rows).toBe(4);
    await expect(page.getByTestId('train-lesson')).toBeEnabled();
  } finally {
    keeper.stop();
    await patchPolicy(request, opToken, { queue_max: 10, paused_reason: null }).catch(() => undefined);
    await context?.close();
    for (const j of mine) { await waitForTerminal(request, key, j).catch(() => undefined); await deleteJob(request, key, j); }
    for (const d of [dsA.id, dsB.id, dsC.id]) await deleteDataset(request, key, d);
    await keeper.drain();
  }
});

scenario('AZ-180 "Train it again" from the result screen bumps the effort one step', async ({ browser, request }) => {
  const key = newKey();
  const ds = await createDataset(request, key, [...az162Rows('AZ180'), { prompt: `AZ180 ${TAG} 커피머신 청소 담당은?`, answer: `barista-${TAG}` }], `az180-${TAG}`);
  const { context, page } = await keyedContext(browser, key);
  const made: string[] = [];
  try {
    const a = await createJob(request, key, { patch_ids: [], builds_on_context: false, dataset_id: ds.id, training: { effort: 'balanced' } });
    expect(a.status).toBe(202);
    const jobA = a.body.job.id;
    trackJob(jobA, key); made.push(jobA);
    const first = await waitForTerminal(request, key, jobA);
    expect(first.training?.effort).toBe('balanced');

    await page.goto(`${NODE}/teach/lesson/${jobA}`);
    const card = page.locator('div').filter({ hasText: /^Train it again/ }).last();
    await expect(card).toContainText('Train it again');
    await expect(card).toContainText('The same dataset, with more effort or a few more questions.');
    await expect(page.getByTestId('go-retrain')).toHaveText('Change settings and re-train');

    const bodies: string[] = [];
    await page.route('**/api/teach/jobs/*/retrain', async (route) => { bodies.push(route.request().postData() ?? ''); await route.continue(); });
    // the label keeps its promise: the settings screen comes first, with the bumped effort already chosen
    await page.getByTestId('go-retrain').click();
    await page.waitForURL(new RegExp(`/teach/dataset/${ds.id}/settings\\?`));
    const q = new URL(page.url()).searchParams;
    expect(q.get('retrain')).toBe(jobA);
    expect(q.get('effort')).toBe('thorough');
    await expect(page.getByTestId('teach-settings')).toBeVisible();
    await expect(page.getByTestId('effort-thorough').locator('input')).toBeChecked();
    expect(bodies, 'opening the settings screen must not start a lesson').toHaveLength(0);

    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().includes(`/api/teach/jobs/${jobA}/retrain`)),
      page.getByTestId('train-lesson').click(),
    ]);
    expect(res.status(), await res.text()).toBe(202);
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0])).toMatchObject({ dataset_id: ds.id, training: { effort: 'thorough' } });
    const jobB = ((await res.json()) as { job: { id: string } }).job.id;
    trackJob(jobB, key); made.push(jobB);
    await page.waitForURL(new RegExp(`/teach/lesson/${jobB}`));

    const second = await waitForTerminal(request, key, jobB);
    expect(second.training).toMatchObject({ effort: 'thorough', max_steps: 40, eval_every: 4, lr: 0.002 });
    expect(second.parent_job).toBe(jobA);
    expect(second.dataset?.id).toBe(ds.id);
    expect(second.dataset?.sha256).toBe(first.dataset?.sha256);
    const againA = await getJob(request, key, jobA);
    expect(againA.status).toBe(first.status);
    expect(againA.training).toEqual(first.training);
    expect(againA.facts).toEqual(first.facts);

    // re-training a thorough lesson stays thorough (the bump saturates)
    await page.goto(`${NODE}/teach/lesson/${jobB}`);
    await page.getByTestId('go-retrain').click();
    await page.waitForURL(new RegExp(`/teach/dataset/${ds.id}/settings\\?`));
    expect(new URL(page.url()).searchParams.get('effort')).toBe('thorough');
    const [res2] = await Promise.all([
      page.waitForResponse((r) => r.url().includes(`/api/teach/jobs/${jobB}/retrain`)),
      page.getByTestId('train-lesson').click(),
    ]);
    expect(res2.status()).toBe(202);
    const jobC = ((await res2.json()) as { job: { id: string } }).job.id;
    trackJob(jobC, key); made.push(jobC);
    const third = await waitForTerminal(request, key, jobC);
    expect(third.training?.effort).toBe('thorough');
    expect(third.parent_job).toBe(jobB);

    // the label has to match what the button does — every press shows the settings screen and sends nothing by itself
    await page.goto(`${NODE}/teach/lesson/${jobC}`);
    await expect(page.getByTestId('go-retrain')).toHaveText('Change settings and re-train');
    await page.getByTestId('go-retrain').click();
    await expect(page.getByTestId('teach-settings')).toBeVisible();
    expect(
      new URL(page.url()).pathname,
      '"Change settings and re-train" must show the settings screen, not start a lesson',
    ).toBe(`/teach/dataset/${ds.id}/settings`);
    expect(bodies, 'only the two Train presses ever POSTed /retrain').toHaveLength(2);
  } finally {
    await context.close();
    for (const j of made) { await waitForTerminal(request, key, j).catch(() => undefined); await deleteJob(request, key, j); }
    await deleteDataset(request, key, ds.id);
  }
});

// ====================================================================== live model (AZ-165, AZ-177)
/**
 * These two scenarios cannot be told the truth by the offline stub: it answers every check with `executed: true` and
 * locality 12/12 whatever the lesson asked for, and it "teaches" every question. The node is therefore pointed at the
 * dedicated model server on :8002 (GPUs 4+5) with the patch hook's mailbox in ENGRAM_PATCH_DIR for the length of this
 * block, and put back exactly as it was afterwards.
 */
test.describe('AZ-165+AZ-177 live model', () => {
  test.describe.configure({ mode: 'serial' });
  let shippedApi = '';

  test.beforeAll(async () => {
    // what node-u ships; another suite may have left the file pointing somewhere else, and an empty api is nobody's
    // idea of a serving node
    const found = nodeMode().api;
    shippedApi = found && found !== MODEL_API ? found : 'http://localhost:8000';
    await setNodeMode('live');
    const rt = await runtimeReady();
    expect(rt.available, `the model server at ${MODEL_API} and its patch hook must answer: ${JSON.stringify(rt)}`).toBe(true);
    const p = await policy(api);
    expect(p.simulated_checks, 'with stubOffline off the node measures its checks for real').toBe(false);
  });

  test.afterAll(async () => {
    await patchPolicy(api, opToken, { publish: 'auto' }).catch(() => undefined);
    await setNodeMode('stub', shippedApi);
  });

  /**
   * The dev node is shared, and the other suites restart it from its own config file — which puts it back on the
   * offline stub. Check before every leg that these two scenarios are still looking at the live model, and put it
   * back if not; a lesson measured by the offline stub would prove nothing about either of them.
   */
  const ensureLive = async () => {
    if ((await policy(api)).simulated_checks === false) return;
    await setNodeMode('live');
    expect((await policy(api)).simulated_checks, 'the node has to be measuring against the live model').toBe(false);
  };

  test('AZ-177 NEEDS_MORE: "Your lesson needs a bit more", with the misses listed', async ({ browser, request }) => {
    test.setTimeout(15 * 60_000);
    const key = newKey();
    const ds = await createDataset(request, key, az162Rows('AZ177'), `az177-${TAG}`);
    const { context, page } = await keyedContext(browser, key);
    let jobId = '';
    try {
      await ensureLive();
      await page.goto(`${NODE}/teach/dataset/${ds.id}/settings`);
      jobId = await pressTrain(page);
      trackJob(jobId, key);
      const job = await waitForTerminal(request, key, jobId, 13 * 60_000);
      expect(job.checks?.simulated, 'another suite restarted the node onto the offline stub mid-lesson').toBeFalsy();
      expect(job.status, 'the stub trainer teaches nothing, so a real check reports NEEDS_MORE').toBe('NEEDS_MORE');

      await expect(page.getByTestId('teach-lesson')).toHaveAttribute('data-status', 'NEEDS_MORE', { timeout: 60_000 });
      await expect(page.locator('h1')).toHaveText('Your lesson needs a bit more');
      const hits = job.facts.filter((f) => f.hit === true).length;
      const measured = job.facts.filter((f) => f.hit !== undefined).length;
      expect(measured, 'every question was measured, so the sentence is not the sampled one').toBe(job.facts.length);
      await expect(page.getByTestId('result-learned')).toHaveText(`It learned ${hits} of ${job.facts.length} questions.`);
      expect(job.checks!.taught.total, 'the sentence counts questions, not the two probes per question the check ran').toBeGreaterThan(job.facts.length);

      const missed = page.getByTestId('missed-block');
      await expect(missed.locator('h2')).toHaveText('What it did not learn');
      await expect(missed.locator('p')).toHaveText('The ones it missed are listed below. Add another wording for them and train again — your dataset is saved.');
      await expect(missed.locator('thead th')).toHaveText(['Question', 'After']);
      await expect(missed.locator('tbody tr')).toHaveCount(job.facts.length - hits);
      const misses = job.facts.filter((f) => f.hit === false);
      await expect(missed.locator('tbody tr').first().locator('td').nth(0)).toHaveText(misses[0].prompt);
      await expect(missed.locator('tbody tr').first().locator('td').nth(1)).toHaveText(misses[0].after_answer ?? '—');

      await expect(page.getByTestId('simulated')).toHaveText('Demo node — no real training happened. The answers below were measured in the live model, but the knowledge file itself is a placeholder.');
      expect(job.checks!.simulated, 'these checks were really measured').toBeFalsy();
      await expect(page.getByTestId('go-publish')).toBeDisabled();
      await expect(page.getByTestId('go-keep')).toBeEnabled();
      await expect(page.getByTestId('go-retrain')).toBeEnabled();
    } finally {
      await context.close();
      if (jobId) { await waitForTerminal(request, key, jobId).catch(() => undefined); await deleteJob(request, key, jobId); }
      await deleteDataset(request, key, ds.id);
    }
  });

  test('AZ-165 Where publishing is off the visitor may switch the check off — and the result says so and offers to run it', async ({ browser, request }) => {
    test.setTimeout(20 * 60_000);
    const key = newKey();
    const ds = await createDataset(request, key, [
      { prompt: `AZ165 ${TAG} 사내 헬프데스크 내선번호는?`, answer: '4180' },
      { prompt: `AZ165 ${TAG} Which room is the design review in?`, answer: `Room ${TAG}-2` },
      { prompt: `AZ165 ${TAG} 백업 서버 이름은?`, answer: `bak-${TAG}` },
    ], `az165-${TAG}`);
    let context: BrowserContext | null = null;
    let jobId = '';
    try {
      await ensureLive();
      await patchPolicy(request, opToken, { publish: 'never' });
      await sleep(11_000);                       // the node caches its policy for 10 s
      expect((await policy(request)).publish).toBe('never');
      const opened = await keyedContext(browser, key);
      context = opened.context;
      const page = opened.page;

      await page.goto(`${NODE}/teach/dataset/${ds.id}/settings`);
      const box = page.getByTestId('check-side');
      await expect(box).toBeChecked();
      await expect(box, 'where nothing can be published the check is the visitor\'s to make').toBeEnabled();
      await expect(page.locator('section:has([data-testid=check-side])')).not.toContainText('Required if you want to publish this lesson.');

      await box.uncheck();
      await expect(page.getByTestId('settings-summary')).toContainText('3 questions · Balanced (recommended) · side-effect check off');
      const posts = await recordJobPosts(page);
      jobId = await pressTrain(page);
      trackJob(jobId, key);
      expect((JSON.parse(posts[0].body) as { training: { check_side_effects: boolean } }).training.check_side_effects).toBe(false);

      let job = await waitForTerminal(request, key, jobId, 13 * 60_000);
      // a lesson the offline stub "checked" says nothing about the flag: that branch ignores it (teach.ts:1396-1409)
      if (job.checks?.simulated) {
        await deleteJob(request, key, jobId);
        await ensureLive();
        const again = await createJob(request, key, { patch_ids: [], builds_on_context: false, dataset_id: ds.id, training: { effort: 'balanced', check_side_effects: false, use_alt: true } });
        expect(again.status).toBe(202);
        jobId = again.body.job.id;
        trackJob(jobId, key);
        job = await waitForTerminal(request, key, jobId, 13 * 60_000);
      }
      expect(job.checks?.simulated, 'the lesson has to have been measured against the live model').toBeFalsy();
      expect(job.training?.check_side_effects).toBe(false);
      expect(job.checks?.skipped).toBe(true);
      expect(job.checks?.locality).toEqual({ ok: false, same: 0, total: 12 });
      expect(job.checks?.note).toBe('the side-effect check was turned off for this lesson — nothing was measured about unrelated answers');

      await page.goto(`${NODE}/teach/lesson/${jobId}`);
      const panel = page.getByTestId('side-effects');
      await expect(panel).toContainText('You switched the side-effect check off, so this lesson has not been measured and cannot be published yet.');
      expect(await panel.innerText(), 'a lesson nobody measured must not report a locality score').not.toMatch(/Unrelated questions unchanged/);
      await expect(page.getByTestId('run-check-now')).toHaveText('Run the check now');
      await expect(page.getByTestId('go-publish')).toBeDisabled();

      // …and running it afterwards must actually measure the thing that was skipped
      const [res] = await Promise.all([
        page.waitForResponse((r) => r.url().includes(`/api/teach/jobs/${jobId}/recheck`)),
        page.getByTestId('run-check-now').click(),
      ]);
      expect(res.status(), await res.text()).toBe(200);
      const rechecked = await waitForJob(request, key, jobId, (j) => !ACTIVE.has(j.status) && !!j.checks && j.checks.executed, 13 * 60_000);
      expect(rechecked.checks?.skipped, 'after "Run the check now" the lesson has been measured').toBeFalsy();
      expect(rechecked.checks?.locality.total).toBeGreaterThan(0);
      await page.reload();
      // the panel now reports THE MEASUREMENT, whichever way it came out — a real model may or may not have moved an
      // unrelated answer, and both verdicts have their own sentence. What must be gone is the "you switched it off"
      // state and the button that offers to do what has now been done.
      const measured = page.getByTestId('side-effects');
      const loc = rechecked.checks!.locality;
      if (loc.ok) {
        await expect(measured.getByTestId('side-ok')).toContainText(`Unrelated questions unchanged: ${loc.same}/${loc.total}`);
      } else {
        await expect(measured.getByTestId('side-bad')).toHaveText(
          `This lesson changed the answers to ${loc.total - loc.same} unrelated questions, so it cannot be published. You can still keep it and run it yourself.`);
      }
      await expect(measured).not.toContainText('You switched the side-effect check off');
      await expect(page.getByTestId('run-check-now'), 'the check has been run; the offer to run it is gone').toHaveCount(0);
    } finally {
      await patchPolicy(request, opToken, { publish: 'auto' });
      await context?.close();
      if (jobId) { await waitForTerminal(request, key, jobId).catch(() => undefined); await deleteJob(request, key, jobId); }
      await deleteDataset(request, key, ds.id);
    }
  });
});
