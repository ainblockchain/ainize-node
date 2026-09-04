/**
 * Teach mode, dataset-first — the CHAT door, the TERMINAL door and the OPERATOR's side of the pipeline.
 * Scenarios AZ-203…AZ-222 of docs/ux-test-scenarios.json, run against the teach dev node:
 *
 *   cd packages/e2e && AINIZE_URL=http://localhost:3422 AINIZE_PASS=teachable-pass \
 *     npx playwright test tests/ds-chat-cli-op.spec.ts --project=web --reporter=list
 *
 * Modes. Everything runs on node-u in its shipped STUB mode (teach.stubOffline true) except the two scenarios whose
 * preconditions name the live model — AZ-203 and AZ-206 — which are grouped in one `live model` block so the node is
 * flipped to the DEDICATED test server (:8002, GPUs 4+5, ENGRAM_PATCH_DIR=/mnt/newdata/qwen3.8/ple_patch_e2e) once and
 * put back once. Nothing here ever points at :8000 / :8001.
 *
 * The whole file is serial: it trains lessons, edits the node's teaching policy and restarts the node.
 * Head-room: the dev node ships 3 lessons per key and 5 per IP a day, which a 20-scenario run exhausts, so the suite
 * raises those four quotas in beforeAll and restores the recorded policy (field for field) in afterAll. The three
 * scenarios that ASSERT the dev node's own numbers (AZ-212, AZ-214, AZ-222) put the baseline back for their assertions
 * and re-raise afterwards.
 */
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, type APIRequestContext, type Locator } from '@playwright/test';
import { NODE_A, SCRATCH, loginViaUi, operatorToken, sleep } from '../helpers/ainize';
import {
  HEADROOM, MODEL_API, NODE_HOME, PATCH_DIR, REPO, SHIPPED_RUNTIME_API, basketFilename, canonicalJsonl, cli, cliHome, createDataset, createJob,
  deleteDataset, deleteDatasetWhenIdle, deleteJob, dropHome, isoDay, newTeachKey, patchAdminPolicy, readAdminPolicy, readNodeConfig, restoreAdminPolicy,
  sapi, setNodeMode, sha256Hex, shippedTeachDefaults, teachPolicy, uploadDataset, v2Header, waitForNodeUp, waitJob, waitModel, writeTeachKeyFile,
  type DatasetView, type JobView, type TeachKey,
} from '../helpers/ds-chat-cli-op-api';
import { clearTeachStorage, readBasket, seedTeachStorage, writeBasket } from '../helpers/ds-chat-cli-op-ui';

/**
 * Sequencing: the repo config runs this suite with `fullyParallel: false, workers: 1`, so the scenarios below execute
 * one at a time, in file order — nothing that trains or touches the model ever overlaps. `mode: 'serial'` is
 * deliberately NOT used: several of these scenarios assert a fix the product has not made yet (AZ-205's dataset-source
 * label, AZ-206's per-lesson cap, AZ-207's dead download control, AZ-219's decline copy), and a serial block would
 * skip every scenario after the first of them instead of reporting them all. Each test owns its own teaching key,
 * dataset and lesson, and cleans them up in a `finally`.
 */

const NODE = NODE_A;
const FIXTURES = join(REPO, 'packages/e2e/fixtures');
/** one tag per run: a published lesson makes its own questions "already sold on this node" for every later run */
const TAG = `${Date.now().toString(36).slice(-5)}`;

let opToken = '';
let nodeAddress = '';
let original = { api: '', stubOffline: true };
/** safety net: anything a scenario created and could not delete itself */
const madeJobs: string[] = [];
const madeDatasets: string[] = [];

const track = (d?: { id: string }) => { if (d) madeDatasets.push(d.id); return d; };

async function refreshOperator(request: APIRequestContext) {
  opToken = await operatorToken(request, NODE);
  return opToken;
}

/**
 * Queue a lesson and wait for it to finish. node-u is shared: another suite restarting it for its own live-model leg
 * kills whatever is training, so a lesson that ends FAILED with a restart error is queued once more before the
 * scenario calls it a product failure.
 */
const RESTARTED = /restart|stopping|node stopped/i;
/** node-u must be in its stub mode for a lesson to finish READY; another suite may have left it on the live model. */
async function ensureStubNode(request: APIRequestContext): Promise<void> {
  await setNodeMode('stub', original);
  await refreshOperator(request);
  await patchAdminPolicy(request, opToken, HEADROOM);
}
async function trainToReady(request: APIRequestContext, key: TeachKey, body: Record<string, unknown>): Promise<JobView> {
  await ensureStubNode(request);
  let last: JobView | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const created = await createJob(request, key, nodeAddress, body);
    if (created.status === 429 && /^quota_(ip|key)\b/.test((created.body as unknown as { error?: string }).error ?? '')) {
      await ensureStubNode(request);                                  // another suite lowered the daily budget
      continue;
    }
    expect(created.status, created.text).toBe(202);
    const id = created.body.job.id;
    madeJobs.push(id);
    last = await waitJob(request, key, nodeAddress, id);
    if (last.status === 'READY') return last;
    // NEEDS_MORE on a stub trainer means the node was measuring against a live model when it ran (another suite's leg)
    if (attempt < 3 && (RESTARTED.test(last.error ?? '') || last.status === 'NEEDS_MORE')) {
      await refreshOperator(request);
      await deleteJob(request, opToken, id);
      await ensureStubNode(request);
      continue;
    }
    break;
  }
  expect(last?.status, `lesson ${last?.id} ended ${last?.status}${last?.error ? `: ${last.error}` : ''}`).toBe('READY');
  return last!;
}

/** A scratch working directory (the CLI scenarios run with `./file` relative paths, as their steps are written). */
function workdir(tag: string): string {
  const dir = join(SCRATCH, `ds-work-${tag}-${Date.now().toString(36)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
/** Copy a fixture next to a scenario's working directory and prove it is the file the scenario describes. */
function fixture(dir: string, name: string, bytes?: number): string {
  const src = join(FIXTURES, name);
  if (bytes !== undefined) expect(statSync(src).size, `fixture ${name} must be the ${bytes}-byte file the scenario describes`).toBe(bytes);
  const dst = join(dir, name);
  copyFileSync(src, dst);
  return dst;
}

test.beforeAll(async ({ request }) => {
  // another suite on this box restarts node-u for its own live-model leg; wait it out rather than fail on the gap
  expect(await waitForNodeUp(), `${NODE} must be answering`).toBe(true);
  const p = await teachPolicy<{ enabled: boolean; backend: string }>(request);
  expect(p.status, `${NODE} must be a node with teach mode enabled`).toBe(200);
  expect(p.body.enabled).toBe(true);
  const info = await sapi<{ node: { address: string } }>(request, { path: '/api/info', header: null });
  nodeAddress = info.body.node.address;
  await refreshOperator(request);
  // What "stub mode" must be put back to. If another suite has node-u on the live model right now, the config on disk
  // is THEIR setting, not the node's own — fall back to what node-u ships rather than restoring someone's live flip.
  const cfg = readNodeConfig();
  original = cfg.teach?.stubOffline === false || cfg.runtime?.api === MODEL_API
    ? { api: SHIPPED_RUNTIME_API, stubOffline: true }
    : { api: cfg.runtime.api, stubOffline: true };
  // node-u is shared: pin the policy IT ships (its own config.json, every teach-v2 override cleared) so the scenarios
  // that assert this node's numbers are not reading another suite's leftovers, then raise the per-day head-room a
  // 20-scenario run needs. afterAll puts the shipped policy back — that, not a captured snapshot, is the clean state
  // (Playwright starts a new worker after a failed test, so beforeAll can run several times in one run).
  const pinned = await patchAdminPolicy(request, opToken, shippedTeachDefaults());
  expect(pinned.status, pinned.text).toBe(200);
  const raised = await patchAdminPolicy(request, opToken, HEADROOM);
  expect(raised.status, 'the suite raises the per-day lesson/question head-room').toBe(200);
});

test.afterAll(async ({ request }) => {
  await setNodeMode('stub', original);
  if (!(await waitForNodeUp())) return;
  await refreshOperator(request);
  for (const id of madeJobs) await deleteJob(request, opToken, id);
  for (const id of madeDatasets) await deleteDatasetWhenIdle(request, opToken, id);
  await patchAdminPolicy(request, opToken, shippedTeachDefaults());
});

// ==================================================================== the two scenarios that need the live model
test.describe('live model', () => {
  test.beforeAll(async ({ request }) => {
    await setNodeMode('live', original);
    await refreshOperator(request);
    await patchAdminPolicy(request, opToken, HEADROOM);
    expect(await waitModel(request), `the dedicated test model server ${MODEL_API} must answer (patch dir ${PATCH_DIR})`).toBe(true);
  });
  test.afterAll(async ({ request }) => {
    await setNodeMode('stub', original);
    await refreshOperator(request);
  });

  test('AZ-203 Freeze receipt: pressing Teach turns the basket into a file — named .jsonl, fingerprint on the dataset page, sha256 equal to the downloaded bytes', async ({ browser, request }) => {
    const key = newTeachKey();
    const facts = [
      { prompt: `Who operates the Ainize teaching node AZ203-${TAG}?`, answer: `Comcom-${TAG}`, alt_prompt: `Which company runs the Ainize teaching node AZ203-${TAG}?` },
      { prompt: `What year did the AZ203-${TAG} pilot start?`, answer: '2020' },
    ];
    const ctx = await browser.newContext({ acceptDownloads: true, locale: 'en-US', viewport: { width: 1280, height: 900 } });
    await seedTeachStorage(ctx, { key });
    const page = await ctx.newPage();
    let jobId = ''; let dsId = '';
    try {
      // ---- the AZ-202 precondition: the basket holds the two corrections and its .jsonl is on disk
      await page.goto(`${NODE}/chat?teach=1`);
      await expect(page.getByTestId('lesson-basket')).toBeVisible();
      const stack = (/\/chat\/([^?#]+)/.exec(page.url())?.[1] ?? '').split(',').filter(Boolean).map(decodeURIComponent);
      await writeBasket(page, facts, stack);
      await page.reload();
      await expect(page.getByTestId('lesson-basket')).toContainText('Your dataset · 2 questions');
      const dir = workdir('az203');
      const savedPath = join(dir, 'basket.jsonl');
      const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('basket-download').click()]);
      await dl.saveAs(savedPath);
      expect(dl.suggestedFilename()).toBe(basketFilename());
      const savedSha = sha256Hex(readFileSync(savedPath));
      expect(readFileSync(savedPath, 'utf8')).toBe(canonicalJsonl(facts));

      // ---- press Teach → pre-flight → queue
      await page.getByTestId('train-lesson').click();
      const sheet = page.getByTestId('preflight-sheet');
      await expect(sheet).toBeVisible();
      await expect(sheet.getByTestId('queue-training')).toBeEnabled({ timeout: 5 * 60_000 });
      await sheet.getByTestId('queue-training').click();

      const card = page.getByTestId('lesson-card');
      await expect(card).toBeVisible({ timeout: 2 * 60_000 });
      jobId = /[?&]lesson=([0-9a-f-]{36})/.exec(page.url())?.[1] ?? '';
      expect(jobId, 'the chat URL carries the queued lesson id').toMatch(/^[0-9a-f-]{36}$/);
      madeJobs.push(jobId);

      // ---- the receipt
      const chatUrl = page.url();
      const freeze = page.getByTestId('freeze-note');
      await expect(freeze).toHaveText(`Your 2 corrections were saved as ${basketFilename()}. From here the steps are the same as for an uploaded file. View all`);
      const viewAll = freeze.getByRole('link', { name: 'View all' });
      dsId = (await viewAll.getAttribute('href'))?.replace('/teach/dataset/', '') ?? '';
      expect(dsId).toMatch(/^[0-9a-f-]{36}$/);
      madeDatasets.push(dsId);

      // ---- the dataset page it links to
      await viewAll.click();
      await expect(page).toHaveURL(new RegExp(`/teach/dataset/${dsId}$`));
      await expect(page.getByRole('heading', { name: 'Check your dataset' })).toBeVisible();
      // soft: the wizard subtitle names the SOURCE, and for a frozen basket the scenario asks for the file name — the
      // rest of the receipt (fingerprint, saved-as line, the API's sha256) still runs, and the scenario still fails.
      await expect.soft(page.getByTestId('teach-dataset'), 'the dataset page names the file the basket became')
        .toContainText(`2 questions from ${basketFilename()}. Fix anything marked in red, then see which ones the model already knows.`, { timeout: 5000 });
      await expect(page.getByTestId('teach-dataset')).toContainText(`Fingerprint ${savedSha.slice(0, 12)}`);
      await expect(page.getByTestId('teach-dataset')).toContainText(`Saved as ${basketFilename()} — you can train from it again any time.`);

      // ---- what the node stored, read with this browser's key
      const j = await sapi<{ job: JobView }>(request, { path: `/api/teach/jobs/${jobId}`, key, nodeAddress });
      expect(j.status).toBe(200);
      const d = j.body.job.dataset!;
      expect({ id: d.id, source: d.source, rows: d.rows, trained_rows: d.trained_rows, revision: d.revision, name: d.name })
        .toEqual({ id: dsId, source: 'chat', rows: 2, trained_rows: 2, revision: 1, name: `your-dataset-${isoDay()}` });
      expect(d.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(d.sha256).toBe(savedSha);

      // ---- and the basket really was emptied
      await page.goto(chatUrl);
      await expect(page.getByTestId('lesson-basket')).toContainText('Your dataset · 0 questions');
      await expect(page.getByTestId('lesson-basket')).toContainText('Your dataset is empty. When an answer is wrong, click "Teach the right answer" under it.');
      expect(await readBasket(page, stack)).toEqual([]);
    } finally {
      await ctx.close();
      await refreshOperator(request);
      if (jobId) expect(await deleteJob(request, opToken, jobId)).toBe(200);
      if (dsId) expect(await deleteDatasetWhenIdle(request, opToken, dsId)).toBe(200);
    }
  });

  test('AZ-206 The chat basket stops at 8 corrections — a number the browser holds, not the node', async ({ browser, request }) => {
    const before = await readAdminPolicy(request, opToken);
    const key = newTeachKey();
    const ctx = await browser.newContext({ acceptDownloads: true, locale: 'en-US', viewport: { width: 1280, height: 900 } });
    await seedTeachStorage(ctx, { key });
    const page = await ctx.newPage();
    const seven = Array.from({ length: 7 }, (_, i) => ({ prompt: `AZ206-${TAG} fact ${i + 1}: who signed the ${i + 1}th Ainize charter?`, answer: `Comcom-${TAG}-${i + 1}` }));
    try {
      await page.goto(`${NODE}/chat?teach=1`);
      await expect(page.getByTestId('lesson-basket')).toBeVisible();
      const stack = (/\/chat\/([^?#]+)/.exec(page.url())?.[1] ?? '').split(',').filter(Boolean).map(decodeURIComponent);
      await writeBasket(page, seven, stack);
      await page.reload();
      await expect(page.getByTestId('lesson-basket')).toContainText('Your dataset · 7 questions');

      // ---- the eighth correction, made the way a visitor makes one (one model reply, "Before only")
      await page.getByRole('radio', { name: 'Before only' }).click();
      const box = page.getByRole('textbox', { name: /Type a question/ });
      const q8 = `AZ206-${TAG} fact 8: who signed the 8th Ainize charter?`;
      await box.fill(q8);
      await box.press('Enter');
      const teachBtn = page.getByTestId('teach-base').first();
      await expect(teachBtn).toBeVisible({ timeout: 5 * 60_000 });
      await teachBtn.click();
      await page.getByTestId('teach-answer').fill(`Comcom-${TAG}-8`);
      await page.getByTestId('teach-add').click();

      const basket = page.getByTestId('lesson-basket');
      await expect(basket).toContainText('Your dataset · 8 questions');
      await expect(page.getByTestId('train-lesson')).toHaveText('Teach from this dataset (8)');
      await expect(basket).toContainText('A lesson holds up to 8 corrections. Train this lesson first.');

      // ---- a ninth: same reply, drawer opens full
      await teachBtn.click();
      const drawer = page.getByTestId('teach-drawer');
      await expect(drawer).toBeVisible();
      await expect(drawer.getByRole('alert').or(drawer.locator('div', { hasText: 'A lesson holds up to 8 corrections.' })).first()).toBeVisible();
      await expect(drawer).toContainText('A lesson holds up to 8 corrections. Train this lesson first.');
      await expect(page.getByTestId('teach-add')).toBeDisabled();
      await page.keyboard.press('Escape');
      expect((await readBasket(page, stack)).length, 'the ninth correction is never added and the eight are untouched').toBe(8);

      // ---- the same sentence in Korean, with the same number
      await page.getByRole('button', { name: 'language' }).first().click();
      await expect(basket).toContainText('한 수업에는 바로잡기 8개까지 넣을 수 있습니다. 먼저 이 수업을 학습시키세요.');
      await page.getByRole('button', { name: 'language' }).first().click();
      await expect(basket).toContainText('A lesson holds up to 8 corrections.');

      // ---- the operator lowers "Corrections per lesson" to 6
      const opCtx = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 } });
      const opPage = await opCtx.newPage();
      await waitForNodeUp();
    await loginViaUi(opPage, NODE);
      await opPage.goto(`${NODE}/dashboard?tab=teaching`);
      await opPage.getByTestId('teach-facts').fill('6');
      await opPage.getByTestId('teach-save').click();
      await expect(opPage.getByTestId('teach-notice')).toHaveText('Saved.');
      await opCtx.close();
      const pol = await teachPolicy<{ limits: { facts_per_job: number } }>(request);
      expect(pol.body.limits.facts_per_job, 'the node now accepts 6 corrections per lesson').toBe(6);

      // ---- the pass condition (design §5.5/§11): the browser cap must BE the node's number, in both locales
      await sleep(11_000);                       // GET /api/teach/policy is cache-control max-age=10 in the browser
      await page.reload();
      await expect(page.getByTestId('lesson-basket')).toBeVisible();
      await writeBasket(page, seven.slice(0, 6), stack);
      await page.reload();
      await expect(page.getByTestId('lesson-basket')).toContainText('Your dataset · 6 questions');
      await expect(page.getByTestId('lesson-basket')).toContainText('A lesson holds up to 6 corrections. Train this lesson first.');
      await page.getByRole('radio', { name: 'Before only' }).click();
      const box2 = page.getByRole('textbox', { name: /Type a question/ });
      await box2.fill(`AZ206-${TAG} fact 7b: who signed the 7th Ainize charter?`);
      await box2.press('Enter');
      const teach2 = page.getByTestId('teach-base').first();
      await expect(teach2).toBeVisible({ timeout: 5 * 60_000 });
      await teach2.click();
      await expect(page.getByTestId('teach-drawer')).toContainText('A lesson holds up to 6 corrections. Train this lesson first.');
      await expect(page.getByTestId('teach-add'), 'with facts_per_job 6 the seventh correction is refused in the browser and the node is never asked').toBeDisabled();
      expect((await readBasket(page, stack)).length).toBe(6);
    } finally {
      await clearTeachStorage(page).catch(() => undefined);
      await ctx.close();
      await refreshOperator(request);
      await patchAdminPolicy(request, opToken, { facts_per_job: (before.effective as { factsPerJob: number }).factsPerJob });
      const back = await teachPolicy<{ limits: { facts_per_job: number } }>(request);
      expect(back.body.limits.facts_per_job).toBe((before.effective as { factsPerJob: number }).factsPerJob);
    }
  });
});

// ==================================================================== the chat door, frozen (stub mode)
/**
 * Item 298 — a node with fewer verifier peers than its quorum holds the Publish button until the creator says they
 * mean to publish something that cannot be sold there. These three scenarios are about review, payouts and limits,
 * not about that gate: they acknowledge it when the node they run on shows it, and say nothing when it does not.
 */
const acceptNoVerifiers = async (sheet: Locator) => {
  const anyway = sheet.getByTestId('pub-anyway');
  if (await anyway.count()) await anyway.check();
};

test('AZ-204 The chat body and an uploaded file produce byte-identical artifacts: POST /api/teach/jobs {facts} freezes one canonical dataset, and re-sending it makes no second copy', async ({ request }) => {
  const key = newTeachKey();
  const facts = [
    { prompt: 'Who operates the Ainize teaching node AZ204?', answer: 'Comcom', alt_prompt: 'Which company runs the Ainize teaching node AZ204?' },
    { prompt: 'What year did the AZ204 pilot start?', answer: '2020' },
  ];
  const CANON = '{"prompt":"Who operates the Ainize teaching node AZ204?","answer":"Comcom","alt_prompt":"Which company runs the Ainize teaching node AZ204?"}\n'
    + '{"prompt":"What year did the AZ204 pilot start?","answer":"2020"}\n';
  let job1 = ''; let job2 = ''; let dsId = '';
  await ensureStubNode(request);
  try {
    const first = await createJob(request, key, nodeAddress, { facts });
    expect(first.status, first.text).toBe(202);
    job1 = first.body.job.id; madeJobs.push(job1);
    const ref = first.body.job.dataset!;
    expect(ref.source).toBe('chat');
    expect(ref.rows).toBe(2);
    expect(ref.trained_rows).toBe(2);
    dsId = ref.id!; madeDatasets.push(dsId);
    for (const k of ['key_remaining', 'ip_remaining', 'rows_remaining', 'rows_ip_remaining']) {
      expect(typeof first.body.quota[k], `quota.${k}`).toBe('number');
    }

    // the dataset the node froze — read while the lesson is still running
    const one = await sapi<{ dataset: DatasetView }>(request, { path: `/api/teach/datasets/${dsId}`, key, nodeAddress });
    expect(one.status).toBe(200);
    const d = one.body.dataset;
    expect(d.name).toBe(`your-dataset-${isoDay()}`);
    expect(d.status).toBe('in_use');
    expect(d.revision).toBe(1);
    expect(d.source).toBe('chat');
    expect(d.size_bytes).toBe(Buffer.byteLength(CANON));
    expect(d.sha256).toBe(sha256Hex(CANON));
    expect(canonicalJsonl(facts)).toBe(CANON);

    const list1 = await sapi<{ items: DatasetView[] }>(request, { path: '/api/teach/datasets', key, nodeAddress });
    expect(list1.status).toBe(200);
    expect(list1.body.items.map((x) => x.id)).toEqual([dsId]);

    // the download is those exact bytes
    const dlHeaders = { 'x-ngram-auth': v2Header(key, nodeAddress, 'GET', `/api/teach/datasets/${dsId}/download`) };
    const dl = await request.fetch(`${NODE}/api/teach/datasets/${dsId}/download`, { headers: dlHeaders });
    expect(dl.status()).toBe(200);
    expect(dl.headers()['content-type']).toContain('application/x-ndjson');
    expect(dl.headers()['x-content-sha256']).toBe(d.sha256);
    expect(dl.headers()['content-disposition']).toBe(`attachment; filename="dataset-${dsId}-r1.jsonl"`);
    expect((await dl.body()).toString('utf8')).toBe(CANON);

    // the same corrections again: a new lesson, the SAME dataset
    await waitJob(request, key, nodeAddress, job1);
    const second = await createJob(request, key, nodeAddress, { facts });
    expect(second.status, second.text).toBe(202);
    job2 = second.body.job.id; madeJobs.push(job2);
    expect(job2).not.toBe(job1);
    expect(second.body.job.dataset!.id).toBe(dsId);

    const list2 = await sapi<{ items: DatasetView[] }>(request, { path: '/api/teach/datasets', key, nodeAddress });
    expect(list2.body.items.map((x) => x.id)).toEqual([dsId]);
    expect(list2.body.items[0].revision).toBe(1);
    await waitJob(request, key, nodeAddress, job2);
  } finally {
    await refreshOperator(request);
    if (job1) expect(await deleteJob(request, opToken, job1)).toBe(200);
    if (job2) expect(await deleteJob(request, opToken, job2)).toBe(200);
    if (dsId) expect(await deleteDatasetWhenIdle(request, opToken, dsId)).toBe(200);
  }
});

test('AZ-205 The frozen chat dataset appears in My datasets and can be re-trained from there (en + 한국어)', async ({ browser, request }) => {
  const key = newTeachKey();
  const facts = [
    { prompt: `AZ205-${TAG}: who keeps the Ainize charter?`, answer: `Comcom-${TAG}` },
    { prompt: `AZ205-${TAG}: which year was the charter signed?`, answer: `20${TAG.slice(-2)}` },
  ];
  const done1 = await trainToReady(request, key, { facts });
  const job1 = done1.id;
  const dsId = done1.dataset!.id!; madeDatasets.push(dsId);
  const dsName = `your-dataset-${isoDay()}`;
  const ds = (await sapi<{ dataset: DatasetView }>(request, { path: `/api/teach/datasets/${dsId}`, key, nodeAddress })).body.dataset;

  const ctx = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 } });
  await seedTeachStorage(ctx, { key });
  const page = await ctx.newPage();
  let job2 = '';
  try {
    await page.goto(`${NODE}/teach/mine`);
    await expect(page.getByRole('heading', { name: 'My datasets and lessons' })).toBeVisible();
    await expect(page.getByTestId('teach-mine')).toContainText('Everything you have taught from this browser. The dataset is the file; a lesson is what the model learned from it.');
    await expect(page.getByTestId('teach-mine')).toContainText('Datasets you have not trained are deleted after 7 days.');

    const card = page.locator(`[data-testid="dataset-card"][data-id="${dsId}"]`);
    await expect(card).toBeVisible();
    await expect(card).toContainText(dsName);
    await expect(card).toContainText('2 questions');
    await expect(card).toContainText(`Fingerprint ${ds.sha256.slice(0, 12)}`);
    await expect(card).toContainText('Where it came from');
    // soft: the card renders the wizard's inline phrasing ("your conversation") instead of the label the scenario
    // names — the rest of the walk still runs, and the scenario still fails on it.
    await expect.soft(card, 'the card labels a chat dataset "From a conversation" (teach.data.source.chat)').toContainText('From a conversation', { timeout: 5000 });
    await expect(card).toContainText('Kept on this node until');
    for (const b of ['Train again', 'Add questions', 'Download (.jsonl)', 'Delete dataset']) await expect(card.getByRole('button', { name: b })).toBeVisible();
    await expect(card).toContainText('Lessons from this dataset (1)');
    const lesson = card.getByTestId('dataset-lesson').first();
    await expect(lesson).toContainText('Ready · private');
    await expect(lesson).toContainText('learned 2/2');
    await expect(lesson.getByRole('link', { name: 'Open' })).toHaveAttribute('href', `/teach/lesson/${job1}`);

    // ---- train it again, without re-typing anything
    await card.getByTestId('ds-retrain').click();
    await expect(page).toHaveURL(new RegExp(`/teach/dataset/${dsId}/settings$`));
    await expect(page.getByTestId('settings-dataset')).toHaveText(`Dataset: ${dsName} · 2 questions · fingerprint ${ds.sha256.slice(0, 12)}`);
    await expect(page.getByTestId('train-lesson')).toHaveText('Train this lesson (2 questions)');
    await page.getByTestId('train-lesson').click();
    await page.waitForURL(/\/teach\/lesson\/[0-9a-f-]{36}/, { timeout: 60_000 });
    job2 = /\/teach\/lesson\/([0-9a-f-]{36})/.exec(page.url())![1];
    madeJobs.push(job2);
    await waitJob(request, key, nodeAddress, job2);

    await page.goto(`${NODE}/teach/mine`);
    await expect(page.locator(`[data-testid="dataset-card"][data-id="${dsId}"]`)).toContainText('Lessons from this dataset (2)');
    const jobs = await sapi<{ items: JobView[] }>(request, { path: '/api/teach/jobs', key, nodeAddress });
    expect(jobs.body.items.length).toBe(2);
    expect(jobs.body.items.every((j) => j.dataset?.id === dsId)).toBe(true);

    // ---- 한국어
    await page.getByRole('button', { name: 'language' }).first().click();
    const ko = page.locator(`[data-testid="dataset-card"][data-id="${dsId}"]`);
    await expect(page.getByRole('heading', { name: '내 데이터셋과 수업' })).toBeVisible();
    for (const s of ['질문 2개', `지문 ${ds.sha256.slice(0, 12)}`, '출처', '다시 학습', '질문 추가', '내려받기 (.jsonl)', '데이터셋 삭제', '이 데이터셋의 수업 (2개)']) {
      await expect(ko).toContainText(s);
    }
    await expect.soft(ko, 'the Korean card says 대화에서 (teach.data.source.chat)').toContainText('대화에서', { timeout: 5000 });
    await page.getByRole('button', { name: 'language' }).first().click();
    await expect(page.getByRole('heading', { name: 'My datasets and lessons' })).toBeVisible();
  } finally {
    await ctx.close();
    await refreshOperator(request);
    expect(await deleteJob(request, opToken, job1)).toBe(200);
    if (job2) expect(await deleteJob(request, opToken, job2)).toBe(200);
    expect(await deleteDatasetWhenIdle(request, opToken, dsId)).toBe(200);
  }
});

test('AZ-207 The lesson carries its dataset: a signed download of exactly what it trained on, and an honest screen once the owner deletes it', async ({ browser, request }) => {
  const key = newTeachKey();
  const facts = [
    { prompt: `AZ207-${TAG}: which node hosts the charter?`, answer: `node-u-${TAG}` },
    { prompt: `AZ207-${TAG}: who signed it?`, answer: `Comcom-${TAG}` },
  ];
  const seeded = await trainToReady(request, key, { facts });
  const jobId = seeded.id;
  const dsId = seeded.dataset!.id!; madeDatasets.push(dsId);
  const ds = (await sapi<{ dataset: DatasetView }>(request, { path: `/api/teach/datasets/${dsId}`, key, nodeAddress })).body.dataset;
  const dsName = `your-dataset-${isoDay()}`;

  const ctx = await browser.newContext({ acceptDownloads: true, locale: 'en-US', viewport: { width: 1280, height: 900 } });
  await seedTeachStorage(ctx, { key });
  const page = await ctx.newPage();
  try {
    await page.goto(`${NODE}/teach/lesson/${jobId}`);
    await expect(page.getByTestId('teach-lesson')).toHaveAttribute('data-status', 'READY');
    const link = page.getByRole('link', { name: `This lesson came from ${dsName} (2 questions)` });
    await expect(link).toHaveAttribute('href', `/teach/dataset/${dsId}`);
    await expect(page.getByTestId('download-dataset')).toHaveText('Download the dataset this lesson was trained on');

    const dir = workdir('az207');
    const saved = join(dir, 'lesson-dataset.jsonl');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('download-dataset').click()]);
    await dl.saveAs(saved);
    expect(dl.suggestedFilename()).toBe(`dataset-${dsId}-r1.jsonl`);
    expect(sha256Hex(readFileSync(saved))).toBe(ds.sha256);

    // ---- the owner deletes the questions
    await page.goto(`${NODE}/teach/mine`);
    const messages: string[] = [];
    page.on('dialog', (d) => { messages.push(d.message()); void d.accept(); });
    await page.locator(`[data-testid="dataset-card"][data-id="${dsId}"]`).getByTestId('ds-delete').click();
    await expect(page.getByText('Dataset deleted.')).toBeVisible();
    expect(messages[0]).toBe(`Delete "${dsName}"? Lessons already trained from it are kept.`);

    // ---- the lesson is unchanged, and says so
    await page.goto(`${NODE}/teach/lesson/${jobId}`);
    await expect(page.getByTestId('teach-lesson')).toHaveAttribute('data-status', 'READY');
    await expect(page.getByTestId('learned-block')).toBeVisible();
    await expect(page.getByTestId('side-effects')).toBeVisible();
    await expect(page.getByTestId('dataset-gone')).toHaveText('The dataset for this lesson was deleted by its owner. The lesson itself is unchanged.');
    // a control that can only answer dataset_not_found must not be offered any more
    await expect(page.getByTestId('download-dataset')).toHaveCount(0);
    await expect(page.getByRole('link', { name: `This lesson came from ${dsName} (2 questions)` })).toHaveCount(0);
  } finally {
    await ctx.close();
    await refreshOperator(request);
    expect(await deleteJob(request, opToken, jobId)).toBe(200);
  }
});

// ==================================================================== the terminal door
/** the LINE/STATUS/QUESTION/WHY rows of a per-line report (the header and rule lines dropped) */
const reportRows = (out: string): { line: number; status: string; why: string }[] =>
  out.split('\n').map((l) => l.replace(/\s+$/, ''))
    .filter((l) => /^\s*\d+\s{2,}\S/.test(l))
    .map((l) => l.trim().split(/\s{2,}/))
    .filter((c) => c.length >= 4)
    .map((c) => ({ line: Number(c[0]), status: c[1], why: c.slice(3).join('  ') }));

test('AZ-208 CLI file door: `ainize teach dataset <file>` validates, uploads and prints every line that will not train — and a second upload makes no second copy', async ({ request }) => {
  const home = cliHome('az208');
  const dir = workdir('az208');
  fixture(dir, 'az-cli.csv', 303);
  let dsId = '';
  try {
    const r1 = await cli(['teach', 'dataset', './az-cli.csv'], home, { cwd: dir });
    expect(r1.code, r1.all).toBe(0);
    const key = JSON.parse(readFileSync(join(home, 'teaching-key.json'), 'utf8')) as { address: string };
    const keyLine = `! new teaching key ${key.address} — kept in ${join(home, 'teaching-key.json')}. Back it up: it is the only way back to these lessons and their earnings.`;
    expect(r1.stderr).toContain(keyLine);
    expect(r1.stderr.split(keyLine).length - 1, 'the key notice is printed once').toBe(1);

    dsId = /^dataset\s+([0-9a-f-]{36})\s*$/m.exec(r1.stdout)?.[1] ?? '';
    expect(dsId, r1.stdout).toMatch(/^[0-9a-f-]{36}$/);
    expect(r1.stdout).toMatch(/^questions\s+3 kept · 2 lines not used$/m);
    const fp = /^fingerprint\s+([0-9a-f]{16})…\s+\(revision 1\)$/m.exec(r1.stdout);
    expect(fp, r1.stdout).not.toBeNull();
    expect(r1.stdout).toContain('where it came from  a file you uploaded — az-cli.csv · csv · separator "," · header row · utf-8');
    expect(r1.stdout).toMatch(/^state\s+never trained yet$/m);
    expect(r1.stdout).toMatch(/^kept\s+until \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/m);
    expect(r1.stdout).toContain('✓ uploaded az-cli.csv (303 B)');
    expect(r1.stdout).toContain('3 of 5 lines will train · not used: 1 duplicate, 1 empty');

    expect(r1.stdout).toContain('lines that will not train');
    const rows = reportRows(r1.stdout);
    expect(rows, r1.stdout).toEqual([
      { line: 5, status: 'duplicate', why: 'the same question and answer as line 3' },
      { line: 6, status: 'empty', why: 'this question has no answer' },
    ]);
    expect(r1.stdout).toContain(`train it:      ainize teach train ${dsId} --effort balanced`);
    expect(r1.stdout).toContain(`see it:        ainize teach dataset get ${dsId}`);
    expect(r1.stdout).toContain(`download it:   ainize teach dataset get ${dsId} -o questions.jsonl`);

    // ---- the same file again: no second copy
    const r2 = await cli(['teach', 'dataset', './az-cli.csv'], home, { cwd: dir });
    expect(r2.code, r2.all).toBe(0);
    expect(r2.stdout).toContain('· az-cli.csv is already on this node — same questions, same dataset, no second copy');
    expect(r2.stdout).toMatch(new RegExp(`^dataset\\s+${dsId}\\s*$`, 'm'));
    expect(r2.stdout).toContain(`fingerprint         ${fp![1]}…  (revision 1)`);
    expect(r2.stderr).not.toContain('new teaching key');

    // ---- machine-readable
    const rj = await cli(['--json', 'teach', 'dataset', 'ls'], home, { cwd: dir });
    expect(rj.code, rj.all).toBe(0);
    expect(rj.stdout.trimStart().startsWith('{'), 'no human table in --json mode').toBe(true);
    expect(rj.stdout).not.toContain('DATASET  ');
    const j = JSON.parse(rj.stdout) as { items: (DatasetView & { summary: Record<string, number> })[] };
    expect(j.items.length).toBe(1);
    const it = j.items[0];
    expect({ id: it.id, name: it.name, status: it.status, source: it.source, revision: it.revision, rows: it.rows, invalid_rows: it.invalid_rows })
      .toEqual({ id: dsId, name: 'az-cli', status: 'staged', source: 'upload', revision: 1, rows: 3, invalid_rows: 2 });
    expect(it.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof it.expires_at).toBe('number');
    expect(it.summary).toMatchObject({ source_rows: 5, accepted: 3, duplicates: 1, empty: 1 });
  } finally {
    if (dsId) { const rm = await cli(['teach', 'dataset', 'rm', dsId], home, { cwd: dir }); expect(rm.code, rm.all).toBe(0); }
    dropHome(home); rmSync(dir, { recursive: true, force: true });
  }
});

test('AZ-209 CLI failure contract: a refused upload still prints the per-line report, and the exit codes are 0 / 1 / 2', async ({ request }) => {
  const home = cliHome('az209');
  const dir = workdir('az209');
  fixture(dir, 'az-bad.txt', 69);
  fixture(dir, 'az-cli.csv', 303);
  let dsId = '';
  try {
    // 1) a refused upload still says WHICH lines it could not read
    const bad = await cli(['teach', 'dataset', './az-bad.txt'], home, { cwd: dir });
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('0 of 2 lines will train · not used: 2 empty');
    expect(bad.stderr).toContain('what the node read');
    expect(reportRows(bad.stderr)).toEqual([
      { line: 1, status: 'empty', why: 'this question has no answer' },
      { line: 2, status: 'empty', why: 'this question has no answer' },
    ]);
    expect(bad.stderr.indexOf('0 of 2 lines will train')).toBeLessThan(bad.stderr.indexOf('error: dataset_empty'));
    expect(bad.stderr).toContain('error: dataset_empty: that file has no usable questions — every line needs a question and a right answer');

    // 2) a path that is neither a dataset id nor a file
    const missing = await cli(['teach', 'train', '/no/such/file.csv'], home, { cwd: dir });
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('error: not a dataset id or a file: /no/such/file.csv — `ainize teach dataset ls` lists your datasets');

    // 3) an id this node does not have
    const unknown = await cli(['teach', 'dataset', 'get', '00000000-0000-4000-8000-000000000000'], home, { cwd: dir });
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('error: dataset_not_found: no such dataset on this node');

    // 4) an effort the CLI refuses before any request
    const up = await cli(['teach', 'dataset', './az-cli.csv'], home, { cwd: dir });
    expect(up.code, up.all).toBe(0);
    dsId = /^dataset\s+([0-9a-f-]{36})\s*$/m.exec(up.stdout)![1];
    const key = JSON.parse(readFileSync(join(home, 'teaching-key.json'), 'utf8')) as TeachKey;
    const before = await sapi<{ items: JobView[] }>(request, { path: '/api/teach/jobs', key, nodeAddress });
    const ultra = await cli(['teach', 'train', dsId, '--effort', 'ultra'], home, { cwd: dir });
    expect(ultra.code).toBe(1);
    expect(ultra.stderr).toContain('Invalid values:\n  Argument: effort, Given: "ultra", Choices: "quick", "balanced", "thorough"');
    const after = await sapi<{ items: JobView[] }>(request, { path: '/api/teach/jobs', key, nodeAddress });
    expect(after.body.items.length, 'no request reached the node').toBe(before.body.items.length);

    // 5) the only non-1 failure code: the node is not there
    const down = await cli(['teach', 'dataset', 'ls'], home, { cwd: dir, node: 'http://localhost:39999' });
    expect(down.code).toBe(2);
    expect(down.stderr).toContain('error: cannot reach node at http://localhost:39999 (fetch failed). Is it running? Try `ainize start` or pass --node <url>.');
  } finally {
    if (dsId) await cli(['teach', 'dataset', 'rm', dsId], home, { cwd: dir });
    dropHome(home); rmSync(dir, { recursive: true, force: true });
  }
});

test('AZ-210 `ainize teach train ./file --effort quick --wait` goes from a file on disk to a finished lesson in one line, and refuses more rows than the node teaches', async ({ request }) => {
  const pol = await teachPolicy<{ limits: { rows_per_job: number; rows_per_job_source: string } }>(request);
  expect(pol.body.limits.rows_per_job).toBe(200);
  expect(pol.body.limits.rows_per_job_source).toBe('default');

  await ensureStubNode(request);
  const home = cliHome('az210');
  const dir = workdir('az210');
  fixture(dir, 'az-cli.csv', 303);
  let dsId = ''; let jobId = '';
  try {
    const r = await cli(['teach', 'train', './az-cli.csv', '--effort', 'quick', '--wait'], home, { cwd: dir });
    expect(r.code, r.all).toBe(0);
    dsId = /^dataset\s+([0-9a-f-]{36})\s*$/m.exec(r.stdout)![1];
    expect(r.stdout).toContain('✓ uploaded az-cli.csv (303 B)');
    expect(r.stdout).toContain('3 of 5 lines will train · not used: 1 duplicate, 1 empty');
    expect(reportRows(r.stdout).length).toBeGreaterThanOrEqual(2);

    // ---- the stage lines, in order and de-duplicated
    const stages = r.stderr.split('\n').filter((l) => /^ {2}(QUEUED|PREFLIGHT|LOADING|TRAINING|EXPORTED|CHECKING|READY|NEEDS_MORE)\b/.test(l));
    expect(stages.length, r.stderr).toBeGreaterThanOrEqual(2);
    expect(new Set(stages).size, 'each stage line is printed once').toBe(stages.length);
    expect(stages[0]).toBe('  QUEUED');
    for (const line of stages.filter((l) => l.startsWith('  TRAINING'))) {
      expect(line).toMatch(/^ {2}TRAINING step \d+\/\d+ · \d+\/\d+ right$/);
    }
    const last = /^ {2}READY step (\d+)\/(\d+) · (\d+)\/(\d+) right$/.exec(stages[stages.length - 1]);
    expect(last, `last stage line: ${JSON.stringify(stages)}`).not.toBeNull();
    expect(last![1]).toBe(last![2]);
    expect(last![3]).toBe(last![4]);

    // ---- the final block
    jobId = /^lesson\s+([0-9a-f-]{36})\s*$/m.exec(r.stdout)![1];
    madeJobs.push(jobId);
    expect(r.stdout).toContain('az-cli  READY  — ready — try it, keep it private or publish it');
    // the node this suite was pointed at, not the one it usually runs on: AINIZE_URL is what NODE is built from
    expect(r.stdout).toMatch(new RegExp(`^node\\s+${NODE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
    expect(r.stdout).toMatch(/^taught by\s+0x[0-9a-fA-F]{6}…[0-9a-fA-F]{4}$/m);
    expect(r.stdout).toMatch(/^dataset\s+az-cli · trained 3 of 3 questions · revision 1 · [0-9a-f]{12}…$/m);
    // the gap is the key column, which widens whenever the block gains a longer key: assert the sentence, not the padding
    expect(r.stdout).toMatch(new RegExp(`^ {2}its questions\\s+ainize teach dataset get ${dsId} -o questions\\.jsonl$`, 'm'));
    expect(r.stdout).toMatch(/^effort\s+quick · 8 passes, evaluated every 2 · another wording trained too$/m);
    expect(r.stdout).toMatch(/^progress\s+/m);
    expect(r.stdout).toMatch(/^knowledge file\s+3 rows · [\d.]+ [kKMG]?B · sha256 [0-9a-f]{16}…$/m);
    // item 239 renamed this line: `checks passed` said nothing about WHICH check, and whether the lesson stuck is
    // now its own line above it
    expect(r.stdout).toMatch(/^side-effect check\s+passed — it did not change unrelated answers$/m);
    expect(r.stdout).toMatch(/^ {2}taught\s+\d+\/\d+ trained sentences answer right/m);
    expect(r.stdout).toMatch(/^ {2}side effects\s+12\/12 unrelated answers unchanged ✓$/m);
    expect(r.stdout).toContain('stub backend (offline) — checks were simulated, not measured in a live model');
    expect(r.stdout).toMatch(/^private draft\s+\S+$/m);
    expect(r.stdout).toMatch(/^created\s+\d{4}-\d{2}-\d{2}/m);
    expect(r.stdout).toMatch(/^finished\s+\d{4}-\d{2}-\d{2}/m);
    expect(r.stdout).toMatch(/^kept until\s+\d{4}-\d{2}-\d{2}/m);

    expect(r.stdout).toContain('corrections');
    expect(r.stdout).toMatch(/QUESTION\s+RIGHT ANSWER\s+BEFORE\s+AFTER\s+HIT/);
    expect((r.stdout.match(/✓/g) ?? []).length).toBeGreaterThanOrEqual(3);
    // the closing block was rewritten: it now offers BOTH ways on (the publish command, and the page), so the link
    // is one of two lines instead of the whole sentence
    expect(r.stdout).toContain(`ainize teach publish ${jobId} --name`);
    expect(r.stdout).toMatch(new RegExp(`^or in the browser:\\s+${NODE.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&')}/teach/lesson/${jobId}\\s+\\(try it, keep it private, publish it\\)$`, 'm'));
    expect(r.stdout).toContain(`train the same questions harder: ainize teach train ${dsId} --effort thorough`);

    // ---- more rows than this node teaches in one lesson
    const key = JSON.parse(readFileSync(join(home, 'teaching-key.json'), 'utf8')) as TeachKey;
    const before = await sapi<{ items: JobView[] }>(request, { path: '/api/teach/jobs', key, nodeAddress });
    const tooMany = await cli(['teach', 'train', dsId, '--rows', '500'], home, { cwd: dir });
    expect(tooMany.code).toBe(1);
    expect(tooMany.stderr).toContain('error: dataset_too_large: this node teaches up to 200 questions in one lesson');
    const after = await sapi<{ items: JobView[] }>(request, { path: '/api/teach/jobs', key, nodeAddress });
    expect(after.body.items.length).toBe(before.body.items.length);
  } finally {
    await refreshOperator(request);
    if (jobId) expect(await deleteJob(request, opToken, jobId)).toBe(200);
    if (dsId) await deleteDatasetWhenIdle(request, opToken, dsId);
    dropHome(home); rmSync(dir, { recursive: true, force: true });
  }
});

test('AZ-211 `teach dataset get <id> -o questions.jsonl` round-trips: the saved bytes verify against the fingerprint and re-uploading them lands on the same dataset', async () => {
  const home = cliHome('az211');
  const dir = workdir('az211');
  fixture(dir, 'az-cli.csv', 303);
  const CANON = '{"prompt":"Who operates the Ainize teaching node AZ208?","answer":"Comcom","alt_prompt":"Which company runs the Ainize teaching node AZ208?"}\n'
    + '{"prompt":"What year did the AZ208 pilot start?","answer":"2020"}\n'
    + '{"prompt":"What does an AZ208 lesson produce?","answer":"A knowledge file"}\n';
  let dsId = '';
  try {
    const up = await cli(['teach', 'dataset', './az-cli.csv'], home, { cwd: dir });
    expect(up.code, up.all).toBe(0);
    dsId = /^dataset\s+([0-9a-f-]{36})\s*$/m.exec(up.stdout)![1];
    const ls = await cli(['--json', 'teach', 'dataset', 'ls'], home, { cwd: dir });
    const sha = (JSON.parse(ls.stdout) as { items: DatasetView[] }).items.find((x) => x.id === dsId)!.sha256;

    const got = await cli(['teach', 'dataset', 'get', dsId, '-o', './questions.jsonl'], home, { cwd: dir });
    expect(got.code, got.all).toBe(0);
    expect(got.stdout).toContain(`✓ saved ${join(dir, 'questions.jsonl')} (284 B) · fingerprint verified — re-uploading it lands on this same dataset`);
    const body = readFileSync(join(dir, 'questions.jsonl'));
    expect(body.toString('utf8')).toBe(CANON);
    expect(sha256Hex(body)).toBe(sha);

    const again = await cli(['teach', 'dataset', './questions.jsonl'], home, { cwd: dir });
    expect(again.code, again.all).toBe(0);
    expect(again.stdout).toContain('· questions.jsonl is already on this node — same questions, same dataset, no second copy');
    expect(again.stdout).toMatch(new RegExp(`^dataset\\s+${dsId}\\s*$`, 'm'));
    expect(again.stdout).toContain(`fingerprint         ${sha.slice(0, 16)}…  (revision 1)`);

    const all = await cli(['teach', 'dataset', 'get', dsId, '--all', '--rows', '200'], home, { cwd: dir });
    expect(all.code, all.all).toBe(0);
    expect(all.stdout).toContain('every line');
    expect(reportRows(all.stdout).map((r) => `${r.line}:${r.status}`)).toEqual(['2:ok', '3:ok', '4:ok', '5:duplicate', '6:empty']);
    const problems = await cli(['teach', 'dataset', 'get', dsId], home, { cwd: dir });
    expect(problems.stdout).toContain('lines that will not train');
    expect(reportRows(problems.stdout).map((r) => `${r.line}:${r.status}`)).toEqual(['5:duplicate', '6:empty']);

    const csv = await cli(['teach', 'dataset', 'get', dsId, '-o', './questions.csv', '--format', 'csv'], home, { cwd: dir });
    expect(csv.code, csv.all).toBe(0);
    expect(csv.stdout).toContain(`✓ saved ${join(dir, 'questions.csv')} (`);
    expect(csv.stdout).not.toContain('fingerprint verified');
    expect(readFileSync(join(dir, 'questions.csv'), 'utf8').split('\n')[0]).toBe('prompt,answer,alt_prompt,note');

    const rm = await cli(['teach', 'dataset', 'rm', dsId], home, { cwd: dir });
    expect(rm.code, rm.all).toBe(0);
    expect(rm.stdout).toContain(`✓ dataset ${dsId} deleted. The lessons trained from it are kept — but they can no longer be re-trained from their questions.`);
    dsId = '';
  } finally {
    dropHome(home); rmSync(dir, { recursive: true, force: true });
  }
});

test('AZ-212 `teach jobs` / `teach status` from the terminal: my lessons with their dataset, the node\'s teaching policy, and a foreign key sees status only', async ({ request }) => {
  await ensureStubNode(request);
  const home = cliHome('az212');
  const homeB = cliHome('az212b');
  const dir = workdir('az212');
  fixture(dir, 'az-cli.csv', 303);
  let dsId = ''; let jobId = '';
  try {
    let trained = await cli(['teach', 'train', './az-cli.csv', '--effort', 'quick', '--wait'], home, { cwd: dir });
    expect(trained.code, trained.all).toBe(0);
    dsId = /^dataset\s+([0-9a-f-]{36})\s*$/m.exec(trained.stdout)![1];
    jobId = /^lesson\s+([0-9a-f-]{36})\s*$/m.exec(trained.stdout)![1];
    madeJobs.push(jobId);
    for (let attempt = 0; attempt < 2 && /\bNEEDS_MORE\b/.test(trained.stdout); attempt++) {
      await refreshOperator(request);                    // another suite had the node on the live model while it ran
      await deleteJob(request, opToken, jobId);
      await ensureStubNode(request);
      trained = await cli(['teach', 'train', dsId, '--effort', 'quick', '--wait'], home, { cwd: dir });
      expect(trained.code, trained.all).toBe(0);
      jobId = /^lesson\s+([0-9a-f-]{36})\s*$/m.exec(trained.stdout)![1];
      madeJobs.push(jobId);
    }

    const jobs = await cli(['teach', 'jobs'], home, { cwd: dir });
    expect(jobs.code, jobs.all).toBe(0);
    expect(jobs.stdout).toContain(`your lessons on ${NODE}`);
    expect(jobs.stdout).toMatch(/LESSON\s+NAME\s+STATUS\s+DATASET\s+QUESTIONS\s+EFFORT\s+PUBLISHED AS\s+UPDATED/);
    const row = jobs.stdout.split('\n').find((l) => l.startsWith(jobId))!;
    expect(row, jobs.stdout).toBeTruthy();
    expect(row).toContain('az-cli');
    expect(row).toContain('READY');
    expect(row).toContain(`${dsId.slice(0, 8)}…`);
    expect(row).toMatch(/\s3 \/ 3\s/);
    expect(row).toMatch(/\squick\s/);
    expect(row).toMatch(/taught-\S+/);
    expect(jobs.stdout).toContain('one lesson: ainize teach status <lesson-id>   ·   its questions: ainize teach dataset get <dataset-id>');

    const filtered = await cli(['teach', 'jobs', '--dataset', dsId], home, { cwd: dir });
    expect(filtered.stdout).toContain(jobId);
    const other = await cli(['teach', 'jobs', '--dataset', '00000000-0000-4000-8000-000000000000'], home, { cwd: dir });
    expect(other.stdout).toContain('no lessons yet');
    expect(other.stdout).not.toContain(jobId);

    // ---- the node's own teaching policy, read with the dev node's shipped limits
    await refreshOperator(request);
    expect((await patchAdminPolicy(request, opToken, shippedTeachDefaults())).status).toBe(200);
    try {
      const st = await cli(['teach', 'status', NODE], home, { cwd: dir });
      expect(st.code, st.all).toBe(0);
      expect(st.stdout).toContain(`Teaching on teachable-u  accepting lessons  ${NODE}`);
      expect(st.stdout).toMatch(/^trainer\s+ready · backend stub \(no GPU training on this node\)$/m);
      expect(st.stdout).toMatch(/^publish\s+auto — published lessons are announced at once$/m);
      expect(st.stdout).toMatch(/^queue\s+\d+ \/ 10 lessons · \d+ \/ 2000 questions waiting$/m);
      expect(st.stdout).toMatch(/^limits\s+200 questions per lesson \(default\) · 3 lessons per key and 5 per IP a day · prompt ≤ 400 \/ answer ≤ 200 chars$/m);
      expect(st.stdout).toMatch(/^datasets\s+up to 2,000 questions per file · files ≤ 3\.8 MB · jsonl json csv tsv txt · 10 uploads and 300 trained questions per key a day · kept 7 days$/m);
      expect(st.stdout).toMatch(/^effort\s+quick \(8 passes\) · balanced \(20 passes\) · thorough \(40 passes\)$/m);
      expect(st.stdout).toMatch(/^data-provider share\s+70 % of the node's share of each sale/m);
      expect(st.stdout).toContain(`teach from a file:  ainize teach dataset ./questions.csv --train      (or ${NODE}/teach/upload)`);
      expect(st.stdout).toContain(`teach in chat:      ${NODE}/chat?teach=1`);
    } finally {
      await patchAdminPolicy(request, opToken, HEADROOM);
    }

    // ---- a key that does not own the lesson sees the status and nothing else
    const foreign = await cli(['teach', 'status', jobId], homeB, { cwd: dir });
    expect(foreign.code, foreign.all).toBe(0);
    expect(foreign.stdout).toContain(`Lesson ${jobId}`);
    expect(foreign.stdout).toContain('READY');
    expect(foreign.stdout).toContain('status only — pass your teaching key (--key-file <backup.json>) to see the lesson body');
    expect(foreign.stdout).not.toContain('AZ208');
    expect(foreign.stdout).not.toContain('taught-');
    expect(foreign.stdout).not.toContain(dsId);

    // ---- deleting the questions leaves the lesson listed, with its dataset marked
    const rm = await cli(['teach', 'dataset', 'rm', dsId], home, { cwd: dir });
    expect(rm.code, rm.all).toBe(0);
    const after = await cli(['teach', 'jobs'], home, { cwd: dir });
    const row2 = after.stdout.split('\n').find((l) => l.startsWith(jobId))!;
    expect(row2).toContain(`${dsId.slice(0, 8)}… (deleted)`);
    expect(row2).toMatch(/\s3 \/ 3\s/);
    const dls = await cli(['teach', 'dataset', 'ls'], home, { cwd: dir });
    expect(dls.stdout.split('\n').find((l) => l.startsWith(dsId))).toContain('deleted');
    dsId = '';
  } finally {
    await refreshOperator(request);
    if (jobId) expect(await deleteJob(request, opToken, jobId)).toBe(200);
    if (dsId) await deleteDatasetWhenIdle(request, opToken, dsId);
    dropHome(home); dropHome(homeB); rmSync(dir, { recursive: true, force: true });
  }
});

// ==================================================================== the API contract
const HTTP_METHODS = ['get', 'post', 'patch', 'delete', 'put'];

interface OpenApiOp {
  tags?: string[];
  parameters?: { name: string }[];
  security?: unknown[];
  description?: string;
  responses?: Record<string, { description?: string }>;
  requestBody?: { content?: Record<string, unknown> };
}
interface OpenApiDoc { openapi: string; paths: Record<string, Record<string, OpenApiOp>> }

test('AZ-213 OpenAPI documents every dataset route the node actually serves — path, method, auth and error codes', async ({ request }) => {
  const src = readFileSync(join(REPO, 'packages/node/src/api.ts'), 'utf8');
  const registered = new Set<string>();
  for (const m of src.matchAll(/router\.(get|post|patch|delete|put)\('(\/api\/(?:teach\/datasets|teach\/samples|me\/teach\/datasets)[^']*)'/g)) {
    registered.add(`${m[1].toUpperCase()} ${m[2].replace(/:(\w+)/g, '{$1}')}`);
  }
  const doc = (await sapi<OpenApiDoc>(request, { path: '/api/openapi.json', header: null })).body;
  expect(doc.openapi).toBe('3.1.0');
  const documented = new Set<string>();
  for (const [p, ops] of Object.entries(doc.paths)) {
    if (!/^\/api\/(teach\/datasets|teach\/samples|me\/teach\/datasets)/.test(p)) continue;
    for (const m of Object.keys(ops)) if (HTTP_METHODS.includes(m)) documented.add(`${m.toUpperCase()} ${p}`);
  }
  const EXPECTED = [
    'POST /api/teach/datasets', 'GET /api/teach/datasets',
    'GET /api/teach/datasets/{id}', 'PATCH /api/teach/datasets/{id}', 'DELETE /api/teach/datasets/{id}',
    'GET /api/teach/datasets/{id}/rows', 'POST /api/teach/datasets/{id}/reparse', 'POST /api/teach/datasets/{id}/fork',
    'GET /api/teach/datasets/{id}/download', 'GET /api/teach/samples', 'GET /api/teach/samples/{kind}',
    'GET /api/me/teach/datasets',
  ].sort();
  expect([...documented].sort(), 'the document and the router must agree, both ways').toEqual([...registered].sort());
  expect([...documented].sort()).toEqual(EXPECTED);

  // auth and tags
  for (const [p, ops] of Object.entries(doc.paths)) {
    if (!p.startsWith('/api/teach/datasets')) continue;
    for (const [m, op] of Object.entries(ops)) {
      if (!HTTP_METHODS.includes(m)) continue;
      expect(op.tags, `${m.toUpperCase()} ${p} tags`).toEqual(['Teach']);
      expect((op.parameters ?? []).map((x) => x.name), `${m.toUpperCase()} ${p} declares x-ngram-auth`).toContain('x-ngram-auth');
    }
  }
  const mine = doc.paths['/api/me/teach/datasets'].get;
  expect(mine.tags).toEqual(['Operator']);
  expect(JSON.stringify(mine.security)).toContain('operator');

  // the owner-only rule, in prose, and the named failures
  expect(doc.paths['/api/teach/datasets/{id}'].get.description)
    .toContain('Owner (signed) or operator. Anyone else gets 404 — a stranger is never told that a dataset exists.');
  const codes = Object.entries(doc.paths).filter(([p]) => p.startsWith('/api/teach/datasets'))
    .flatMap(([, ops]) => Object.entries(ops).filter(([m]) => HTTP_METHODS.includes(m))
      .flatMap(([, op]) => Object.entries(op.responses ?? {}).map(([code, r]) => `${code} ${r.description ?? ''}`)));
  const documents = (code: string, token: string) => expect(codes.some((c) => c.startsWith(`${code} `) && c.includes(token)), `${code} ${token} is documented`).toBe(true);
  for (const t of ['dataset_empty', 'dataset_format', 'dataset_hash']) documents('400', t);
  documents('404', 'dataset_not_found');
  documents('409', 'dataset_in_use');
  documents('413', 'dataset_too_large');
  for (const t of ['quota_dataset', 'quota_bytes', 'rate_limited']) documents('429', t);

  // one operation, both request shapes
  const post = doc.paths['/api/teach/datasets'].post;
  expect(Object.keys(post.requestBody?.content ?? {}).sort()).toEqual(['application/json', 'multipart/form-data']);

  // live probes
  const hidden = await sapi(request, { path: '/api/teach/datasets/00000000-0000-4000-8000-000000000000', header: null });
  expect(hidden.status, 'a stranger is never told that a dataset exists').toBe(404);
  const samples = await sapi<{ samples: unknown[] }>(request, { path: '/api/teach/samples', header: null });
  expect(samples.status).toBe(200);
  expect(samples.headers['cache-control']).toBe('public, max-age=3600');

  const docs = await sapi<Record<string, unknown>>(request, { path: '/api/docs', header: null });
  expect(Object.keys(docs.body).sort()).toEqual(['cli', 'node', 'openapi']);
});

test('AZ-214 Quotas are counted in QUESTIONS, not lessons: rows_per_key_per_day and rows_per_ip_per_day refuse the lesson with the numbers in the message', async ({ request }) => {
  await refreshOperator(request);
  const recorded = await readAdminPolicy(request, opToken);
  const jobs: string[] = [];
  const sets: string[] = [];
  const rowsFor = (n: number) => [
    { prompt: `AZ214-${TAG}-${n}: who counts the questions?`, answer: `Comcom-${TAG}` },
    { prompt: `AZ214-${TAG}-${n}: what is charged per lesson?`, answer: 'questions' },
  ];
  try {
    // ---- per KEY. node-u is shared, so an attempt whose budget was moved by another suite mid-flight is retried.
    let keyLegDone = false;
    for (let attempt = 0; attempt < 6 && !keyLegDone; attempt++) {
      const key = newTeachKey();
      await ensureStubNode(request);
      expect((await patchAdminPolicy(request, opToken, { rows_per_key_per_day: 3 })).status).toBe(200);
      const pol = await teachPolicy<{ limits: { rows_per_key_per_day: number } }>(request);
      expect(pol.body.limits.rows_per_key_per_day, 'the visitor policy changes with no restart').toBe(3);
      await sleep(1500);
      if ((await teachPolicy<{ limits: { rows_per_key_per_day: number } }>(request)).body.limits.rows_per_key_per_day !== 3) continue;

      const made = await createDataset(request, key, nodeAddress, { source: 'inline', rows: rowsFor(attempt) });
      expect([200, 201]).toContain(made.status);
      const dsId = made.body.dataset.id; sets.push(dsId); madeDatasets.push(dsId);

      const first = await createJob(request, key, nodeAddress, { dataset_id: dsId });
      if (first.status === 429 && /^quota_(ip|key)\b/.test((first.body as unknown as { error?: string }).error ?? '')) continue;
      expect(first.status, first.text).toBe(202);
      jobs.push(first.body.job.id); madeJobs.push(first.body.job.id);
      await waitJob(request, key, nodeAddress, first.body.job.id);
      if (first.body.quota.rows_remaining !== 1) continue;                 // another suite moved the budget — try again
      for (const k of ['key_remaining', 'ip_remaining', 'rows_remaining', 'rows_ip_remaining']) expect(typeof first.body.quota[k], `quota.${k}`).toBe('number');

      const before = await sapi<{ items: JobView[] }>(request, { path: '/api/teach/jobs', key, nodeAddress });
      const stillThree = await teachPolicy<{ limits: { rows_per_key_per_day: number } }>(request);
      if (stillThree.body.limits.rows_per_key_per_day !== 3) continue;      // another suite moved the budget again
      const second = await createJob(request, key, nodeAddress, { dataset_id: dsId });
      if (second.status === 202) { madeJobs.push(second.body.job.id); jobs.push(second.body.job.id); await waitJob(request, key, nodeAddress, second.body.job.id); continue; }
      expect(second.status, second.text).toBe(429);
      const body = second.body as unknown as { error: string; rows_remaining: number; rows_ip_remaining: number; limit: number; asked: number };
      expect(body.error).toBe('quota_rows: you have 1 of 3 questions left to teach on this node today');
      expect(body.rows_remaining).toBe(1);
      expect(body.limit).toBe(3);
      expect(body.asked).toBe(2);
      expect(typeof body.rows_ip_remaining).toBe('number');
      const after = await sapi<{ items: JobView[] }>(request, { path: '/api/teach/jobs', key, nodeAddress });
      expect(after.body.items.length, 'no job row is created and no rows are charged').toBe(before.body.items.length);
      keyLegDone = true;
    }
    expect(keyLegDone, 'the per-key question budget was measured').toBe(true);

    // ---- per IP: independent of the key
    let ipLegDone = false;
    for (let attempt = 0; attempt < 6 && !ipLegDone; attempt++) {
      await ensureStubNode(request);
      expect((await patchAdminPolicy(request, opToken, { rows_per_key_per_day: null, rows_per_ip_per_day: 2 })).status).toBe(200);
      const key2 = newTeachKey();
      const made2 = await createDataset(request, key2, nodeAddress, { source: 'inline', rows: rowsFor(10 + attempt) });
      expect([200, 201]).toContain(made2.status);
      const ds2 = made2.body.dataset.id; sets.push(ds2); madeDatasets.push(ds2);
      const third = await createJob(request, key2, nodeAddress, { dataset_id: ds2 });
      if (third.status === 202) {                                          // the per-IP budget was raised under us
        jobs.push(third.body.job.id); madeJobs.push(third.body.job.id);
        await waitJob(request, key2, nodeAddress, third.body.job.id);
        continue;
      }
      expect(third.status, third.text).toBe(429);
      expect((third.body as unknown as { error: string }).error).toMatch(/^quota_rows: this address has \d+ of 2 questions left to teach on this node today$/);
      ipLegDone = true;
    }
    expect(ipLegDone, 'a DIFFERENT key from the same IP is refused by the per-address budget').toBe(true);

    // the sentence the browser shows for that code
    const i18n = readFileSync(join(REPO, 'packages/web/src/i18n/pages/teach.ts'), 'utf8');
    expect(i18n).toContain("'teach.err.quota_rows': { ko: '이 노드에서 오늘 가르칠 수 있는 질문 한도를 다 썼습니다. 내일 다시 오거나 직접 노드를 운영하세요 — 내려받는 수업마다 실행 방법이 들어 있습니다.', en: 'You have used up the questions you can teach on this node today. Come back tomorrow, or run your own node — the instructions come with every lesson you download.' }");
  } finally {
    await refreshOperator(request);
    await restoreAdminPolicy(request, opToken, recorded);
    const back = await teachPolicy<{ limits: { rows_per_key_per_day: number; rows_per_ip_per_day: number } }>(request);
    expect(back.body.limits.rows_per_key_per_day).toBe((recorded.effective.dataset as Record<string, number>).rowsPerKeyPerDay);
    expect(back.body.limits.rows_per_ip_per_day).toBe((recorded.effective.dataset as Record<string, number>).rowsPerIpPerDay);
    for (const id of jobs) expect(await deleteJob(request, opToken, id)).toBe(200);
    for (const id of sets) expect(await deleteDatasetWhenIdle(request, opToken, id)).toBe(200);
    await patchAdminPolicy(request, opToken, HEADROOM);
  }
});

test('AZ-215 Owner-only reads: a stranger\'s key, an unsigned request and a replayed signature all get 404 — and the operator can read but cannot edit someone\'s dataset', async ({ request, playwright }) => {
  const k1 = newTeachKey();
  const k2 = newTeachKey();
  let dsId = ''; let jobId = '';
  await ensureStubNode(request);
  // `request` carries the operator session cookie from the login above, which would answer every probe below as the
  // operator; the visitor legs run on a context of their own.
  const anon = await playwright.request.newContext();
  try {
    const made = await createDataset(request, k1, nodeAddress, {
      source: 'inline',
      rows: [{ prompt: `AZ215-${TAG}: whose dataset is this?`, answer: `K1-${TAG}` }, { prompt: `AZ215-${TAG}: who may read it?`, answer: 'only its owner' }],
    });
    expect([200, 201]).toContain(made.status);
    dsId = made.body.dataset.id; madeDatasets.push(dsId);
    const nameBefore = made.body.dataset.name;
    const job = await createJob(request, k1, nodeAddress, { dataset_id: dsId });
    expect(job.status, job.text).toBe(202);
    jobId = job.body.job.id; madeJobs.push(jobId);
    await waitJob(request, k1, nodeAddress, jobId);

    // ---- a stranger's key: the same 404 for every verb, so existence is never disclosed
    const NOT_FOUND = 'dataset_not_found: no such dataset on this node';
    const probes: [string, string, unknown?][] = [
      ['GET', `/api/teach/datasets/${dsId}`],
      ['GET', `/api/teach/datasets/${dsId}/rows`],
      ['GET', `/api/teach/datasets/${dsId}/download`],
      ['PATCH', `/api/teach/datasets/${dsId}`, { name: 'stolen' }],
      ['DELETE', `/api/teach/datasets/${dsId}`],
    ];
    for (const [method, path, data] of probes) {
      const r = await sapi<{ error: string }>(anon, { path, method, data, key: k2, nodeAddress });
      expect(r.status, `${method} ${path} with a stranger's key`).toBe(404);
      expect(r.body.error).toBe(NOT_FOUND);
    }

    // ---- unsigned
    const unsignedItem = await sapi<{ error: string }>(anon, { path: `/api/teach/datasets/${dsId}`, header: null });
    expect(unsignedItem.status).toBe(404);
    expect(unsignedItem.body.error).toBe(NOT_FOUND);
    const unsignedList = await sapi<{ error: string }>(anon, { path: '/api/teach/datasets', header: null });
    expect(unsignedList.status).toBe(401);
    expect(unsignedList.body.error).toMatch(/^invalid_signature: /);

    // ---- a replayed header, and an expired one. On the ITEM route an unverified caller is a stranger, so the refusal
    // is the same 404 the unsigned probe got (existence is never disclosed); the LIST route, which needs a key, is
    // where the refusal shows itself as 401 invalid_signature.
    const header = v2Header(k1, nodeAddress, 'GET', `/api/teach/datasets/${dsId}`);
    const once = await sapi<{ dataset: DatasetView }>(anon, { path: `/api/teach/datasets/${dsId}`, header });
    expect(once.status).toBe(200);
    const twice = await sapi<{ error: string }>(anon, { path: `/api/teach/datasets/${dsId}`, header });
    expect(twice.status, 'a v2 header is single-use').toBe(404);
    expect(twice.body.error).toBe(NOT_FOUND);
    const listHeader = v2Header(k1, nodeAddress, 'GET', '/api/teach/datasets');
    expect((await sapi(anon, { path: '/api/teach/datasets', header: listHeader })).status).toBe(200);
    const listReplay = await sapi<{ error: string }>(anon, { path: '/api/teach/datasets', header: listHeader });
    expect(listReplay.status, 'a v2 header is single-use').toBe(401);
    expect(listReplay.body.error).toMatch(/^invalid_signature: /);
    const stale = await sapi<{ error: string }>(anon, { path: '/api/teach/datasets', header: v2Header(k1, nodeAddress, 'GET', '/api/teach/datasets', undefined, Date.now() - 10 * 60_000) });
    expect(stale.status, '±5 min skew').toBe(401);
    expect((await sapi<{ error: string }>(anon, { path: `/api/teach/datasets/${dsId}`, header: v2Header(k1, nodeAddress, 'GET', `/api/teach/datasets/${dsId}`, undefined, Date.now() - 10 * 60_000) })).status).toBe(404);

    // ---- the operator may read, but never edit under the owner's name
    await refreshOperator(request);
    const opRead = await sapi<{ dataset: DatasetView }>(request, { path: `/api/teach/datasets/${dsId}`, token: opToken, header: null });
    expect(opRead.status).toBe(200);
    expect(opRead.body.dataset.id).toBe(dsId);
    const opPatch = await sapi<{ error: string }>(request, { path: `/api/teach/datasets/${dsId}`, method: 'PATCH', data: { name: 'operator rename' }, token: opToken, header: null });
    expect(opPatch.status).toBe(401);
    expect(opPatch.body.error).toMatch(/^invalid_signature: /);

    // ---- and nothing changed
    const final = await sapi<{ dataset: DatasetView }>(anon, { path: `/api/teach/datasets/${dsId}`, key: k1, nodeAddress });
    expect(final.status).toBe(200);
    expect(final.body.dataset.name).toBe(nameBefore);
    expect(final.body.dataset.revision).toBe(1);
  } finally {
    await anon.dispose();
    await refreshOperator(request);
    if (jobId) expect(await deleteJob(request, opToken, jobId)).toBe(200);
    if (dsId) expect(await deleteDatasetWhenIdle(request, opToken, dsId)).toBe(200);
  }
});

test('AZ-216 The rows report is the contract behind the preview table: /rows paging, status filter and summary must agree with the dataset and with the download', async ({ request }) => {
  const key = newTeachKey();
  const bytes = readFileSync(join(FIXTURES, 'az-cli.csv'));
  expect(bytes.length).toBe(303);
  let dsId = '';
  try {
    const up = await uploadDataset(request, key, nodeAddress, { name: 'az-cli.csv', bytes });
    expect([200, 201]).toContain(up.status);
    dsId = up.body.dataset.id; madeDatasets.push(dsId);
    const sha = up.body.dataset.sha256;

    const page = await sapi<{ total: number; source_rows: number; offset: number; limit: number; summary: Record<string, unknown>; items: { index: number | null; line: number; status: string; detail?: string }[] }>(
      request, { path: `/api/teach/datasets/${dsId}/rows`, key, nodeAddress });
    expect(page.status).toBe(200);
    expect({ total: page.body.total, source_rows: page.body.source_rows, offset: page.body.offset, limit: page.body.limit })
      .toEqual({ total: 5, source_rows: 5, offset: 0, limit: 50 });
    expect(page.body.summary).toEqual({
      source_rows: 5, accepted: 3, fixed: 0, rejected: 2, duplicates: 1, conflicts: 0, blocked: 0, too_long: 0,
      empty: 1, not_parsed: 0, over_cap: 0, shared_ending: 0, pii: 0, langs: { hangul: 0, latin: 3, han: 0, kana: 0, other: 0 },
    });
    expect(page.body.items.map((r) => r.line), 'the SOURCE line numbers of a header csv').toEqual([2, 3, 4, 5, 6]);
    const dup = page.body.items.find((r) => r.line === 5)!;
    expect(dup.status).toBe('duplicate');
    expect(dup.detail).toBe('the same question and answer as line 3');
    expect(dup.index).toBeNull();
    const empty = page.body.items.find((r) => r.line === 6)!;
    expect(empty.status).toBe('empty');
    expect(empty.detail).toBe('this question has no answer');
    expect(empty.index).toBeNull();

    const ok = await sapi<{ total: number; items: { index: number | null; status: string }[] }>(request, { path: `/api/teach/datasets/${dsId}/rows?status=ok`, key, nodeAddress });
    expect(ok.body.total).toBe(3);
    expect(ok.body.items.map((r) => r.index)).toEqual([0, 1, 2]);
    const rejected = await sapi<{ total: number; items: { line: number }[] }>(request, { path: `/api/teach/datasets/${dsId}/rows?status=rejected`, key, nodeAddress });
    expect(rejected.body.total).toBe(2);
    expect(rejected.body.items.map((r) => r.line)).toEqual([5, 6]);

    const win = await sapi<{ offset: number; limit: number; items: { line: number }[] }>(request, { path: `/api/teach/datasets/${dsId}/rows?offset=1&limit=2`, key, nodeAddress });
    expect({ offset: win.body.offset, limit: win.body.limit }).toEqual({ offset: 1, limit: 2 });
    expect(win.body.items.map((r) => r.line)).toEqual([3, 4]);

    const jsonl = await request.fetch(`${NODE}/api/teach/datasets/${dsId}/download`, { headers: { 'x-ngram-auth': v2Header(key, nodeAddress, 'GET', `/api/teach/datasets/${dsId}/download`) } });
    expect(jsonl.status()).toBe(200);
    const jsonlBody = await jsonl.body();
    expect(jsonl.headers()['x-content-sha256']).toBe(sha);
    expect(sha256Hex(jsonlBody)).toBe(sha);
    const csv = await request.fetch(`${NODE}/api/teach/datasets/${dsId}/download?format=csv`, { headers: { 'x-ngram-auth': v2Header(key, nodeAddress, 'GET', `/api/teach/datasets/${dsId}/download?format=csv`) } });
    expect(csv.status()).toBe(200);
    expect(csv.headers()['content-type']).toContain('text/csv');
    const csvBody = await csv.body();
    expect(sha256Hex(csvBody), 'the csv rendering is NOT the fingerprint subject').not.toBe(sha);
  } finally {
    await refreshOperator(request);
    if (dsId) expect(await deleteDatasetWhenIdle(request, opToken, dsId)).toBe(200);
  }
});

test('AZ-217 Operator dataset moderation: GET /api/me/teach/datasets shows who uploaded what, from which IP — and opening it is audited', async ({ request, playwright }) => {
  const k1 = newTeachKey();
  const bytes = Buffer.from('prompt,answer\nAZ217-' + TAG + ': who hosts this file?,node-u\nAZ217-' + TAG + ': who may delete it?,the operator\n', 'utf8');
  let dsId = ''; let jobId = '';
  await ensureStubNode(request);
  try {
    const up = await uploadDataset(request, k1, nodeAddress, { name: 'az217.csv', bytes }, { retention: 'keep' });
    expect([200, 201]).toContain(up.status);
    dsId = up.body.dataset.id; madeDatasets.push(dsId);
    const job = await createJob(request, k1, nodeAddress, { dataset_id: dsId });
    expect(job.status, job.text).toBe(202);
    jobId = job.body.job.id; madeJobs.push(jobId);
    await waitJob(request, k1, nodeAddress, jobId);

    await refreshOperator(request);
    const MSG = 'operator opened the uploaded-datasets moderation view';
    const evBefore = await sapi<{ events: { seq: number; message: string }[] }>(request, { path: '/api/events?kind=teach&limit=200', token: opToken, header: null });
    const sinceSeq = Math.max(0, ...evBefore.body.events.map((e) => e.seq));

    const view = await sapi<{ items: (DatasetView & { ip: string | null; owner: string })[] }>(request, { path: '/api/me/teach/datasets?limit=200', token: opToken, header: null });
    expect(view.status).toBe(200);
    const row = view.body.items.find((x) => x.id === dsId)!;
    expect(row, 'the seeded upload is in the moderation view').toBeTruthy();
    expect(row.owner.toLowerCase()).toBe(k1.address.toLowerCase());
    expect(row.owner_address.toLowerCase()).toBe(k1.address.toLowerCase());
    expect(row.ip).toBe('127.0.0.1');
    expect(row.source).toBe('upload');
    expect(row.source_name).toBe('az217.csv');
    expect(row.size_bytes).toBeGreaterThan(0);
    expect(row.source_bytes).toBe(bytes.length);
    expect(row.rows).toBe(2);
    expect(row.invalid_rows).toBe(0);
    expect(row.retention).toBe('keep');
    expect(typeof row.created_at).toBe('number');
    expect(typeof row.expires_at).toBe('number');
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(view.body.items.some((x) => x.status === 'deleted'), 'deleted datasets stay in the moderation view').toBe(true);

    // a context with no operator session of its own: `request` carries the login cookie from refreshOperator
    const anon = await playwright.request.newContext();
    const noBearer = await sapi<{ error: string }>(anon, { path: '/api/me/teach/datasets', header: null });
    expect(noBearer.status).toBe(401);
    const withKey = await sapi<{ error: string }>(anon, { path: '/api/me/teach/datasets', key: k1, nodeAddress });
    expect(withKey.status, 'a visitor teaching key alone never reaches this route').toBe(401);
    await anon.dispose();

    const evAfter = await sapi<{ events: { seq: number; message: string; level: string }[] }>(request, { path: '/api/events?kind=teach&limit=200', token: opToken, header: null });
    const audit = evAfter.body.events.filter((e) => e.seq > sinceSeq && e.message === MSG);
    expect(audit.length, 'one audit line per moderation read').toBe(1);
    expect(audit[0].level).toBe('info');

    // ---- the operator removes someone else's file
    const del = await sapi<{ status: string }>(request, { path: `/api/teach/datasets/${dsId}`, method: 'DELETE', token: opToken, header: null });
    expect(del.status).toBe(200);
    const view2 = await sapi<{ items: (DatasetView & { owner: string })[] }>(request, { path: '/api/me/teach/datasets?limit=200', token: opToken, header: null });
    const gone = view2.body.items.find((x) => x.id === dsId)!;
    expect(gone.status).toBe('deleted');
    expect(typeof gone.deleted_at).toBe('number');

    // read as the OWNER only (the shared context carries the operator session cookie from refreshOperator)
    const anon2 = await playwright.request.newContext();
    const ownerRead = await sapi<{ error: string; dataset?: DatasetView }>(anon2, { path: `/api/teach/datasets/${dsId}`, key: k1, nodeAddress });
    // What the node really does is keep a tombstone (openapi: "a lesson reads 'the dataset … was deleted by its owner'
    // instead of pointing at a dangling id"): the row answers 200 with status 'deleted' and the questions are gone.
    expect(ownerRead.status).toBe(200);
    expect(ownerRead.body.dataset?.status).toBe('deleted');
    expect(typeof ownerRead.body.dataset?.deleted_at).toBe('number');
    const goneDownload = await sapi<{ error: string }>(anon2, { path: `/api/teach/datasets/${dsId}/download`, key: k1, nodeAddress });
    expect(goneDownload.status, 'the questions themselves are gone').toBe(404);
    expect(goneDownload.body.error).toMatch(/^dataset_not_found: /);
    // the tombstone is the owner's alone: a stranger's teaching key still gets a flat 404 on the item route
    const strangerRead = await sapi<{ error: string }>(anon2, { path: `/api/teach/datasets/${dsId}`, key: newTeachKey(), nodeAddress });
    expect(strangerRead.status, 'a deleted dataset is not readable by anyone but its owner and the operator').toBe(404);
    expect(strangerRead.body.error).toMatch(/^dataset_not_found: /);
    await anon2.dispose();
    const jobs = await sapi<{ items: JobView[] }>(request, { path: '/api/teach/jobs', key: k1, nodeAddress });
    const kept = jobs.body.items.find((j) => j.id === jobId)!;
    expect(kept, 'deleting the questions never deletes the lesson').toBeTruthy();
    expect(kept.dataset?.deleted).toBe(true);
  } finally {
    await refreshOperator(request);
    if (jobId) expect(await deleteJob(request, opToken, jobId)).toBe(200);
  }
});

// ==================================================================== the operator's screens
test('AZ-218 Blocking a teaching key from the Teaching tab actually refuses that key\'s next upload and lesson', async ({ browser, request }) => {
  await refreshOperator(request);
  const bansBefore = (await sapi<{ items: { id: number; kind: string; value: string }[] }>(request, { path: '/api/me/teach/bans', token: opToken, header: null })).body.items;
  const k2 = newTeachKey();
  const home = cliHome('az218');
  writeTeachKeyFile(home, k2);
  const dir = workdir('az218');
  fixture(dir, 'az-cli.csv', 303);

  // K2 must already be a contributor for its row to exist
  await ensureStubNode(request);
  const seed = await createDataset(request, k2, nodeAddress, { source: 'inline', rows: [{ prompt: `AZ218-${TAG}: who may block a key?`, answer: 'the node operator' }] });
  expect([200, 201]).toContain(seed.status);
  const seedDs = seed.body.dataset.id; madeDatasets.push(seedDs);
  const seedJob = await createJob(request, k2, nodeAddress, { dataset_id: seedDs });
  expect(seedJob.status, seedJob.text).toBe(202);
  madeJobs.push(seedJob.body.job.id);
  await waitJob(request, k2, nodeAddress, seedJob.body.job.id);

  const ctx = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 1000 } });
  const page = await ctx.newPage();
  let uploadedAfterUnblock = '';
  try {
    await waitForNodeUp();
    await loginViaUi(page, NODE);
    await page.goto(`${NODE}/dashboard?tab=teaching`);
    const row = page.locator(`[data-testid="teach-contributor"][data-address="${k2.address.toLowerCase()}"]`);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await page.getByLabel('Reason (optional, only you see it)').fill('AZ-218 walk');

    const dialogs: string[] = [];
    page.on('dialog', (d) => { dialogs.push(d.message()); void d.accept(); });
    await row.getByTestId('contrib-block-key').click();
    await expect(row.getByTestId('contrib-blocked')).toHaveText('blocked');
    expect(dialogs[0]).toBe(`Block ${k2.address.slice(0, 10)}…${k2.address.slice(-4)}? New lessons from it will be refused with “This node is not accepting lessons from this key.”`);

    const banRow = page.locator(`[data-testid="teach-ban"][data-kind="address"][data-value="${k2.address.toLowerCase()}"]`);
    await expect(banRow).toBeVisible();
    await expect(banRow).toContainText('key');
    await expect(banRow).toContainText(k2.address);
    await expect(banRow).toContainText('AZ-218 walk');
    await expect(banRow.getByTestId('ban-remove')).toHaveText('Unblock');

    // the IP button: K2's lesson carries 127.0.0.1, so the row offers "Block IP" rather than "no IP recorded"
    await expect(row.getByTestId('contrib-block-ip')).toHaveText('Block IP');
    await expect(row).not.toContainText('Block IP: no IP recorded');

    // ---- the block is enforcement, not decoration
    const dsBefore = (await sapi<{ items: unknown[] }>(request, { path: '/api/me/teach/datasets?limit=1000', token: opToken, header: null })).body.items.length;
    const blocked = await cli(['teach', 'dataset', './az-cli.csv'], home, { cwd: dir });
    expect(blocked.code).toBe(1);
    expect(blocked.stderr).toContain('error: banned: this node is not accepting lessons from this key');
    const dsAfter = (await sapi<{ items: unknown[] }>(request, { path: '/api/me/teach/datasets?limit=1000', token: opToken, header: null })).body.items.length;
    expect(dsAfter).toBe(dsBefore);

    const refused = await createJob(request, k2, nodeAddress, { dataset_id: seedDs });
    expect(refused.status).toBe(403);
    expect((refused.body as unknown as { error: string }).error).toBe('banned: this node is not accepting lessons from this key');

    // ---- unblock
    await banRow.getByTestId('ban-remove').click();
    await expect(banRow).toHaveCount(0);
    await expect(page.locator(`[data-testid="teach-contributor"][data-address="${k2.address.toLowerCase()}"]`).getByTestId('contrib-blocked')).toHaveCount(0);
    const ok = await cli(['teach', 'dataset', './az-cli.csv'], home, { cwd: dir });
    expect(ok.code, ok.all).toBe(0);
    uploadedAfterUnblock = /^dataset\s+([0-9a-f-]{36})\s*$/m.exec(ok.stdout)![1];
  } finally {
    await ctx.close();
    await refreshOperator(request);
    const bansNow = (await sapi<{ items: { id: number; kind: string; value: string }[] }>(request, { path: '/api/me/teach/bans', token: opToken, header: null })).body.items;
    for (const b of bansNow) if (!bansBefore.some((x) => x.id === b.id)) await sapi(request, { path: `/api/me/teach/bans/${b.id}`, method: 'DELETE', token: opToken, header: null });
    const finalBans = (await sapi<{ items: { id: number }[] }>(request, { path: '/api/me/teach/bans', token: opToken, header: null })).body.items;
    expect(finalBans.map((b) => b.id).sort()).toEqual(bansBefore.map((b) => b.id).sort());
    if (uploadedAfterUnblock) expect(await deleteDatasetWhenIdle(request, opToken, uploadedAfterUnblock)).toBe(200);
    expect(await deleteJob(request, opToken, seedJob.body.job.id)).toBe(200);
    expect(await deleteDatasetWhenIdle(request, opToken, seedDs)).toBe(200);
    dropHome(home); rmSync(dir, { recursive: true, force: true });
  }
});

/** Seed a READY lesson owned by `key`, ready to be published from the browser. */
async function readyLesson(request: APIRequestContext, key: TeachKey, label: string): Promise<{ jobId: string; dsId: string }> {
  const rows = [
    { prompt: `${label}-${TAG}: who signed the Ainize charter?`, answer: `Comcom-${TAG}` },
    { prompt: `${label}-${TAG}: in which year?`, answer: `20${TAG.slice(-2)}` },
  ];
  const made = await createDataset(request, key, nodeAddress, { source: 'inline', rows });
  expect([200, 201]).toContain(made.status);
  const dsId = made.body.dataset.id; madeDatasets.push(dsId);
  const done = await trainToReady(request, key, { dataset_id: dsId });
  return { jobId: done.id, dsId };
}

test('AZ-219 Publish review: "Review each one" holds a taught lesson at PENDING_REVIEW, and Approve / Decline reaches the teacher', async ({ browser, request }) => {
  await refreshOperator(request);
  const recorded = await readAdminPolicy(request, opToken);
  const key = newTeachKey();
  const a = await readyLesson(request, key, 'AZ219a');
  const b = await readyLesson(request, key, 'AZ219b');

  const opCtx = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 1000 } });
  const opPage = await opCtx.newPage();
  const teCtx = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 1000 } });
  await seedTeachStorage(teCtx, { key });
  const tePage = await teCtx.newPage();
  try {
    await waitForNodeUp();
    await loginViaUi(opPage, NODE);
    await opPage.goto(`${NODE}/dashboard?tab=teaching`);
    await opPage.getByTestId('teach-publish').getByRole('radio', { name: 'Review each one' }).check();
    await opPage.getByTestId('teach-save').click();
    await expect(opPage.getByTestId('teach-notice')).toHaveText('Saved.');
    const pol = await teachPolicy<{ publish: string }>(request);
    expect(pol.body.publish).toBe('review');

    // ---- the teacher publishes
    const publish = async (jobId: string, name: string) => {
      await tePage.goto(`${NODE}/teach/lesson/${jobId}`);
      await tePage.getByTestId('go-publish').click();
      const sheet = tePage.getByTestId('publish-sheet');
      await expect(sheet).toBeVisible();
      await sheet.getByTestId('pub-name').fill(name);
      await sheet.getByTestId('pub-price').fill('0');
      await sheet.getByTestId('consent-permanent').check();
      await sheet.getByTestId('consent-rights').check();
      await acceptNoVerifiers(sheet);
      await sheet.getByTestId('pub-submit').click();
      await expect(sheet.getByTestId('publish-done')).toBeVisible({ timeout: 60_000 });
      return sheet;
    };
    const sheet = await publish(a.jobId, 'AZ-219 review lesson');
    await expect(sheet.getByTestId('publish-done')).toHaveText('Sent to the node operator for review. You will see it in Your knowledge when it goes live.');
    await expect(sheet.getByTestId('publish-earnings-link')).toBeVisible();
    await expect(sheet.getByTestId('publish-page-link')).toHaveCount(0);

    // ---- the operator's queue
    await opPage.reload();
    await expect(opPage.getByTestId('teach-review-count')).toHaveText('1 waiting for review');
    const row = opPage.locator(`[data-testid="teach-job"][data-job-id="${a.jobId}"]`);
    await expect(row).toContainText('Waiting for review');
    await expect(row.getByTestId('teach-approve')).toHaveText('Approve and announce');
    await expect(row.getByTestId('teach-decline')).toHaveText('Decline');

    await row.getByTestId('teach-decline').click();
    const reason = row.getByTestId('teach-decline-reason');
    await expect(row.getByLabel('Reason (shown to the contributor)')).toBeVisible();
    await expect(reason).toHaveAttribute('placeholder', 'e.g. the answer is wrong');
    await expect(row.getByTestId('teach-decline-confirm')).toBeDisabled();
    await reason.fill('AZ-219: the answer is wrong');
    await expect(row.getByTestId('teach-decline-confirm')).toBeEnabled();
    await row.getByTestId('teach-decline-confirm').click();
    await expect(row).toContainText('Declined');
    await expect(row.getByTestId('teach-job-reason')).toHaveText('Declined: AZ-219: the answer is wrong');

    // ---- what the teacher then sees
    await tePage.goto(`${NODE}/teach/lesson/${a.jobId}`);
    await expect(tePage.getByTestId('teach-lesson')).toHaveAttribute('data-status', 'REJECTED');
    // soft, so the approve leg below still runs: both of these are what the scenario asks the product to say and do.
    await expect.soft(tePage.getByTestId('result-failed')).toHaveText('The node operator declined to publish this lesson: AZ-219: the answer is wrong. Your file is still available to download.', { timeout: 5000 });
    await expect.soft(tePage.getByTestId('go-keep'), '"Keep it private" is still offered after a decline').toBeEnabled({ timeout: 5000 });

    // ---- and the approve path
    await publish(b.jobId, 'AZ-219 approved lesson');
    await opPage.reload();
    const row2 = opPage.locator(`[data-testid="teach-job"][data-job-id="${b.jobId}"]`);
    await expect(row2).toContainText('Waiting for review');
    await row2.getByTestId('teach-approve').click();
    await expect(row2).toContainText('Announced', { timeout: 60_000 });
    const jb = await sapi<{ job: JobView }>(request, { path: `/api/teach/jobs/${b.jobId}`, key, nodeAddress });
    expect(jb.body.job.status).toBe('ANNOUNCED');
    const patchId = jb.body.job.patch_id!;
    await expect(row2.getByRole('link', { name: /Knowledge page/ })).toHaveAttribute('href', `/${encodeURIComponent(nodeAddress)}/${encodeURIComponent(patchId)}`);

    await tePage.goto(`${NODE}/chat?lesson=${b.jobId}`);
    await expect(tePage.getByTestId('lesson-body')).toHaveText('Announced — verifier nodes are checking it on the real model.');
  } finally {
    await opCtx.close(); await teCtx.close();
    await refreshOperator(request);
    await restoreAdminPolicy(request, opToken, recorded);
    await patchAdminPolicy(request, opToken, HEADROOM);
    // an ANNOUNCED lesson is immutable by design — it stays on this local-ledger dev node (noted in the run log)
    await deleteJob(request, opToken, a.jobId);
    await deleteDatasetWhenIdle(request, opToken, a.dsId);
    await deleteDatasetWhenIdle(request, opToken, b.dsId);
  }
});

test('AZ-220 Payouts to the data provider: the published anchor names the teacher with the node\'s share, and the operator\'s Payouts panel is honest about a node with no chain wallet', async ({ browser, request }) => {
  await refreshOperator(request);
  const payoutsNow = await sapi<{ wallet: boolean; items: unknown[]; summary: { pending: string; paid: string; failed: string }; max_attempts: number }>(request, { path: '/api/me/payouts?limit=100', token: opToken, header: null });
  expect(payoutsNow.status).toBe(200);
  expect(payoutsNow.body.wallet, 'this scenario describes a node with no chain wallet (local ledger)').toBe(false);

  const key = newTeachKey();
  const { jobId, dsId } = await readyLesson(request, key, 'AZ220');
  const ctx = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 1000 } });
  await seedTeachStorage(ctx, { key });
  const page = await ctx.newPage();
  const opCtx = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 1000 } });
  const opPage = await opCtx.newPage();
  try {
    await page.goto(`${NODE}/teach/lesson/${jobId}`);
    await page.getByTestId('go-publish').click();
    const sheet = page.getByTestId('publish-sheet');
    await expect(sheet.getByRole('radio', { name: new RegExp(`This browser's teaching key`) })).toBeChecked();
    await sheet.getByTestId('pub-name').fill('AZ-220 payout lesson');
    await sheet.getByTestId('pub-price').fill('1');
    await sheet.getByTestId('consent-permanent').check();
    await sheet.getByTestId('consent-rights').check();
    await acceptNoVerifiers(sheet);
    await sheet.getByTestId('pub-submit').click();
    await expect(sheet.getByTestId('publish-done')).toBeVisible({ timeout: 60_000 });

    const jv = await sapi<{ job: JobView }>(request, { path: `/api/teach/jobs/${jobId}`, key, nodeAddress });
    const patchId = jv.body.job.patch_id!;
    expect(patchId, 'the lesson is on the public record').toBeTruthy();
    const anchor = await sapi<{ anchor: { contributors?: { address: string }[] } }>(request, { path: `/api/patches/${patchId}`, header: null });
    expect(anchor.status).toBe(200);
    const credited = (anchor.body.anchor.contributors ?? []).map((c) => c.address.toLowerCase());
    expect(credited, 'the payout ledger must name the address the anchor credits').toContain(key.address.toLowerCase());

    // ---- the operator's Payouts panel
    await waitForNodeUp();
    await loginViaUi(opPage, NODE);
    await opPage.goto(`${NODE}/dashboard?tab=teaching`);
    await expect(opPage.getByTestId('teaching-tab')).toContainText('Data-provider shares this node owes from sales of taught lessons. Transfers retry automatically every minute (up to 20 times); Retry sends one now.');
    const tiles = opPage.getByTestId('teach-payouts-summary');
    await expect(tiles).toContainText('Owed');
    await expect(tiles).toContainText('Paid');
    await expect(tiles).toContainText('Failed');
    await expect(opPage.getByTestId('payouts-no-wallet')).toHaveText('This node has no chain wallet (local record), so payouts to visitors are only recorded here and stay pending until it runs on the AI Network.');
    const ledger = await sapi<{ items: unknown[] }>(request, { path: '/api/me/payouts?limit=100', token: opToken, header: null });
    expect(ledger.body.items.length, 'no sale has happened in this run').toBe(0);
    await expect(opPage.getByTestId('teach-payouts')).toContainText('No payouts yet — they appear when a taught lesson sells.');

    // ---- the teacher's own page agrees with the API, digit for digit
    const profile = await sapi<{ lessons: { id: string }[]; earnings: { owed: string; paid: string; pending: string; failed: string; sales: number; currency: string } }>(request, { path: `/api/teacher/${key.address}`, header: null });
    expect(profile.status).toBe(200);
    expect(profile.body.lessons.map((l) => l.id)).toContain(patchId);
    await page.goto(`${NODE}/teacher/${key.address}`);
    await expect(page.getByTestId('teacher-address')).toHaveText(key.address);
    const earnings = page.getByTestId('teacher-earnings');
    const e = profile.body.earnings;
    await expect(earnings).toContainText(`${e.owed} ${e.currency}`);
    await expect(earnings).toContainText(`${e.paid} ${e.currency}`);
    await expect(earnings).toContainText(`${e.pending} ${e.currency}`);
    await expect(earnings).toContainText(String(e.sales));
    for (const label of ['Paid', 'Pending', 'Sales']) await expect(earnings).toContainText(label);
    // soft: the operator's panel calls this "Owed" and so does the scenario; the public teacher page says "Earned"
    await expect.soft(earnings, 'the teacher page labels the owed tile "Owed"').toContainText('Owed', { timeout: 5000 });
    const lessonRow = page.getByTestId('teacher-lesson').filter({ hasText: patchId });
    await expect(lessonRow).toHaveCount(1);
    const draftId = jv.body.job.draft_id;
    if (draftId && draftId !== patchId) {
      expect(await page.locator('body').innerText(), 'a private draft id never appears on the public teacher page').not.toContain(draftId);
    }
  } finally {
    await ctx.close(); await opCtx.close();
    await refreshOperator(request);
    await deleteDatasetWhenIdle(request, opToken, dsId);
    // the announced lesson is immutable by design and stays on this local-ledger dev node
  }
});

test('AZ-221 Teach settings on the Teaching tab: every visible knob saves, a pause reason reaches the visitor immediately, and a bad blocked-topics regex is refused', async ({ browser, request }) => {
  await refreshOperator(request);
  expect((await patchAdminPolicy(request, opToken, shippedTeachDefaults())).status).toBe(200);
  const recorded = await readAdminPolicy(request, opToken);
  const key = newTeachKey();
  const ctx = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 1200 } });
  const page = await ctx.newPage();
  const vis = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 } });
  await seedTeachStorage(vis, { key });
  const visPage = await vis.newPage();
  let dsId = '';
  try {
    const made = await createDataset(request, key, nodeAddress, { source: 'inline', rows: [{ prompt: `AZ221-${TAG}: is teaching paused?`, answer: 'yes' }] });
    expect([200, 201]).toContain(made.status);
    dsId = made.body.dataset.id; madeDatasets.push(dsId);

    await waitForNodeUp();
    await loginViaUi(page, NODE);
    // the trainer reads "busy" while ANY lesson on this shared node is running — wait for it to go idle first
    for (let i = 0; i < 60; i++) {
      const st = await readAdminPolicy(request, opToken);
      if (st.trainer?.state === 'ready') break;
      await sleep(3000);
    }
    await page.goto(`${NODE}/dashboard?tab=teaching`);
    await expect(page.getByTestId('teach-trainer')).toHaveText('Trainer: ready · backend stub (demo — no real training)');
    const form = page.getByTestId('teach-settings');
    await expect(form).toBeVisible();
    await expect(page.getByTestId('teach-save'), 'Save is disabled until something changes').toBeDisabled();
    for (const label of ['Accept lessons from visitors', 'Corrections per lesson', 'Lessons per key per day', 'Lessons per IP per day', 'Queue size', 'Days an unsaved lesson is kept', 'Data-provider share of each sale', 'Pause reason shown to visitors', 'Blocked topics (regular expression, optional)']) {
      await expect(form, `the form offers "${label}"`).toContainText(label);
    }
    await expect(page.getByTestId('teach-publish')).toContainText('Review each one');
    await expect(page.getByTestId('teach-publish')).toContainText('Automatically');
    await expect(page.getByTestId('teach-publish')).toContainText('Never');
    await expect(form).toContainText('The rest stays with this node for GPU time and hosting.');
    for (const gone of ['File size', 'Questions per dataset', 'Questions per lesson', 'Declaration']) {
      await expect(form, 'the dataset-era limits are not on this form (AZ-222)').not.toContainText(gone);
    }

    await page.getByTestId('teach-facts').fill('6');
    await page.getByTestId('teach-per-key').fill('4');
    await page.getByTestId('teach-queue-max').fill('12');
    await page.getByTestId('teach-ttl').fill('5');
    const slider = page.getByTestId('teach-share');
    await slider.focus();
    await slider.press('ArrowLeft');                       // 70 % → 65 % (step 5)
    await expect(page.getByTestId('teach-share-value')).toHaveText('65%');
    await expect(page.getByTestId('teach-save')).toBeEnabled();
    await page.getByTestId('teach-save').click();
    await expect(page.getByTestId('teach-notice')).toHaveText('Saved.');

    const pol = await teachPolicy<{ limits: { facts_per_job: number; jobs_per_key_per_day: number }; queue: { max: number }; draft_ttl_days: number; shares: { contributor: number } }>(request);
    expect(pol.body.limits.facts_per_job).toBe(6);
    expect(pol.body.limits.jobs_per_key_per_day).toBe(4);
    expect(pol.body.queue.max).toBe(12);
    expect(pol.body.draft_ttl_days).toBe(5);
    expect(pol.body.shares.contributor).toBeCloseTo(0.65, 5);

    // ---- a pause reason reaches the visitor immediately
    await page.getByTestId('teach-paused').fill('AZ-221 GPU maintenance until Monday');
    await page.getByTestId('teach-save').click();
    await expect(page.getByTestId('teach-notice')).toHaveText('Saved.');
    const paused = 'Teaching is paused on this node right now. AZ-221 GPU maintenance until Monday';
    await sleep(11_000);                                   // GET /api/teach/policy is cache-control max-age=10
    await visPage.goto(`${NODE}/teach`);
    await expect(visPage.getByTestId('teach-policy')).toHaveText(paused);
    await visPage.goto(`${NODE}/chat?teach=1`);
    await expect(visPage.getByTestId('lesson-basket')).toBeVisible();
    const stack = (/\/chat\/([^?#]+)/.exec(visPage.url())?.[1] ?? '').split(',').filter(Boolean).map(decodeURIComponent);
    await writeBasket(visPage, [{ prompt: `AZ221-${TAG}: is teaching paused?`, answer: 'yes' }], stack);
    await visPage.reload();
    await expect(visPage.getByTestId('lesson-basket')).toContainText('Your dataset · 1 question');
    await expect(visPage.getByTestId('teach-policy')).toHaveText(paused);
    await expect(visPage.getByTestId('train-lesson'), 'a paused node offers no Teach button, even with questions in the basket').toBeDisabled();
    const refused = await createJob(request, key, nodeAddress, { dataset_id: dsId });
    expect(refused.status).toBe(503);
    expect((refused.body as unknown as { error: string }).error).toMatch(/^trainer_paused: AZ-221 GPU maintenance until Monday$/);

    // ---- a regular expression the parser could not compile is refused
    await page.getByTestId('teach-paused').fill('');
    await page.getByTestId('teach-blocked').fill('[');
    await page.getByTestId('teach-save').click();
    await expect(page.getByText('blocked_topics must be a valid regular expression')).toBeVisible();
    const stored = await readAdminPolicy(request, opToken);
    expect((stored.effective as { blockedTopics?: string | null }).blockedTopics ?? null, 'the stored policy is unchanged').toBe((recorded.effective as { blockedTopics?: string | null }).blockedTopics ?? null);
    const stillOk = await teachPolicy<{ enabled: boolean }>(request);
    expect(stillOk.status).toBe(200);
  } finally {
    await ctx.close(); await vis.close();
    await refreshOperator(request);
    await restoreAdminPolicy(request, opToken, recorded);
    const back = await readAdminPolicy(request, opToken);
    expect(back.effective).toEqual(recorded.effective);
    if (dsId) expect(await deleteDatasetWhenIdle(request, opToken, dsId)).toBe(200);
    await patchAdminPolicy(request, opToken, HEADROOM);
  }
});

test('AZ-222 The dataset-era limits are operator-settable only through the API, and the visitor UI obeys them: file size, dataset cap, per-lesson cap and the publish declaration', async ({ browser, request }) => {
  await refreshOperator(request);
  const recorded = await readAdminPolicy(request, opToken);
  const key = newTeachKey();
  const ctx = await browser.newContext({ acceptDownloads: true, locale: 'en-US', viewport: { width: 1280, height: 1000 } });
  await seedTeachStorage(ctx, { key });
  const page = await ctx.newPage();
  let dsId = ''; let jobId = '';
  try {
    const patched = await patchAdminPolicy(request, opToken, { dataset_max_bytes: 1_000_000, dataset_max_rows: 4, rows_per_job: 2, declaration_rows: 2, dataset_ttl_days: 3 });
    expect(patched.status, patched.text).toBe(200);
    const pol = await teachPolicy<{ limits: Record<string, number | string> }>(request);
    expect(pol.body.limits.dataset_max_bytes).toBe(1_000_000);
    expect(pol.body.limits.dataset_max_rows).toBe(4);
    expect(pol.body.limits.rows_per_job).toBe(2);
    expect(pol.body.limits.rows_per_job_source, 'an explicit override disables the measured derivation').not.toBe('default');
    expect(pol.body.limits.declaration_rows).toBe(2);
    expect(pol.body.limits.dataset_ttl_days).toBe(3);

    await page.goto(`${NODE}/teach`);
    await expect(page.getByTestId('door-file-limits').locator('li')).toHaveText(['jsonl · json · csv · tsv · txt', 'up to 4 questions']);
    await page.goto(`${NODE}/teach/upload`);
    await expect(page.getByTestId('drop-zone')).toContainText('jsonl, csv, tsv or txt · up to 1 MB');

    for (let attempt = 0; attempt < 3 && !/\/teach\/dataset\/[0-9a-f-]{36}$/.test(page.url()); attempt++) {
      if (attempt) { await sleep(20_000); await page.goto(`${NODE}/teach/upload`); }
      await page.getByTestId('file-input').setInputFiles(join(FIXTURES, 'az222.jsonl'));
      await page.waitForURL(/\/teach\/dataset\/[0-9a-f-]{36}$/, { timeout: 60_000 }).catch(() => undefined);
    }
    expect(page.url(), `the upload did not open the preview: ${await page.locator('body').innerText()}`).toMatch(/\/teach\/dataset\/[0-9a-f-]{36}$/);
    dsId = /\/teach\/dataset\/([0-9a-f-]{36})/.exec(page.url())![1];
    madeDatasets.push(dsId);
    await expect(page.getByTestId('over-cap-note')).toHaveText('That file has 5 questions; this node accepts up to 4 in one dataset. The first 4 were loaded.');
    const ds = await sapi<{ dataset: DatasetView }>(request, { path: `/api/teach/datasets/${dsId}`, key, nodeAddress });
    expect(ds.body.dataset.rows).toBe(4);

    await expect(page.getByTestId('cap-banner')).toContainText('This node teaches up to 2 questions in one lesson. The first 2 are selected; the rest stay in your dataset for the next lesson.');
    await expect(page.getByTestId('cap-pick')).toHaveText('Choose which 2');

    let done: JobView | null = null;
    await ensureStubNode(request);
    for (let attempt = 0; attempt < 3 && done?.status !== 'READY'; attempt++) {
      // re-assert this scenario's limits: ensureStubNode / another suite may have put the node policy back
      expect((await patchAdminPolicy(request, opToken, { dataset_max_bytes: 1_000_000, dataset_max_rows: 4, rows_per_job: 2, declaration_rows: 2, dataset_ttl_days: 3 })).status).toBe(200);
      await page.goto(`${NODE}/teach/dataset/${dsId}/settings`);
      await expect(page.getByTestId('rows-cap')).toContainText('This node teaches up to 2 questions in one lesson, so 2 of your 4 are in this one.');
      await expect(page.getByTestId('train-lesson')).toHaveText('Train this lesson (2 questions)');
      await page.getByTestId('train-lesson').click();
      await page.waitForURL(/\/teach\/lesson\/[0-9a-f-]{36}/, { timeout: 60_000 });
      jobId = /\/teach\/lesson\/([0-9a-f-]{36})/.exec(page.url())![1];
      madeJobs.push(jobId);
      done = await waitJob(request, key, nodeAddress, jobId);
      if (done.status !== 'READY' && attempt < 2 && (RESTARTED.test(done.error ?? '') || done.status === 'NEEDS_MORE')) {
        await refreshOperator(request);
        await deleteJob(request, opToken, jobId);
        jobId = '';
        await ensureStubNode(request);
      }
    }
    expect(done?.status, `lesson ${jobId} ended ${done?.status}${done?.error ? `: ${done.error}` : ''}`).toBe('READY');

    await page.goto(`${NODE}/teach/lesson/${jobId}`);
    await page.getByTestId('go-publish').click();
    const sheet = page.getByTestId('publish-sheet');
    await expect(sheet.getByTestId('consent-declaration')).toBeVisible();
    await expect(sheet).toContainText('You are publishing 4 questions. Confirm you have the right to share this data and that it contains no personal information — published lessons cannot be deleted.');
    await sheet.getByTestId('pub-name').fill('AZ-222 declaration lesson');
    await sheet.getByTestId('consent-permanent').check();
    await sheet.getByTestId('consent-rights').check();
    await acceptNoVerifiers(sheet);
    await expect(sheet.getByTestId('pub-submit'), 'Publish stays disabled until all three are ticked').toBeDisabled();
    await sheet.getByTestId('consent-declaration').check();
    await expect(sheet.getByTestId('pub-submit')).toBeEnabled();
  } finally {
    await ctx.close();
    await refreshOperator(request);
    await restoreAdminPolicy(request, opToken, recorded);
    const back = await teachPolicy<{ limits: Record<string, number | string> }>(request);
    expect(back.body.limits.dataset_max_bytes).toBe(4_000_000);
    expect(back.body.limits.dataset_max_rows).toBe(2000);
    expect(back.body.limits.rows_per_job).toBe(200);
    expect(back.body.limits.rows_per_job_source).toBe('default');
    expect(back.body.limits.declaration_rows).toBe(100);
    expect(back.body.limits.dataset_ttl_days).toBe(7);
    if (jobId) expect(await deleteJob(request, opToken, jobId)).toBe(200);
    if (dsId) expect(await deleteDatasetWhenIdle(request, opToken, dsId)).toBe(200);
    await patchAdminPolicy(request, opToken, HEADROOM);
  }
});
