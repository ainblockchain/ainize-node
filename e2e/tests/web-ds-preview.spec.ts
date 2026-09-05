/**
 * Teach mode, the FILE door — step 2: the dataset preview, its per-question verdicts and the live pre-flight
 * (docs/teachable-dataset-design.md §5.3–§5.5, §8; scenarios AZ-143…AZ-162 in docs/ux-test-scenarios.json).
 *
 *   AINIZE_URL=http://localhost:3422 AINIZE_PASS=teachable-pass npx playwright test tests/web-ds-preview.spec.ts --project=web  --reporter=list
 *   AINIZE_URL=http://localhost:3422 AINIZE_PASS=teachable-pass npx playwright test tests/web-ds-preview.spec.ts --project=mobile --reporter=list   # AZ-143
 *
 * Modes (say which one a scenario needs, per the dev-node runbook):
 *   STUB  (node-u as it ships: backend `stub`, teach.stubOffline true) — every scenario here except AZ-159.
 *   LIVE  (AZ-159 only) — the test itself flips node-u to the DEDICATED e2e model server on :8002 with
 *         ENGRAM_PATCH_DIR=/mnt/newdata/qwen3.8/ple_patch_e2e and puts it back afterwards. Never :8000 / :8001.
 *   AZ-158 (LAST) exhausts the node's hourly free-live-test budget on purpose. That budget is 20 units an hour per
 *         client address and every visitor on this box is one address, so the scenario restarts node-u before it
 *         (to start from a known 20) and after it (to give the rest of the hour back) — the bucket is an in-memory
 *         Map, `Market.chatUsage`.
 *
 * Every test opens its OWN browser context, so it gets its own teaching key (10 datasets / 3 lessons per key per day),
 * and everything it creates is deleted in afterEach. The per-CLIENT-ADDRESS budgets are not per test, and everyone
 * testing against this dev node shares one address: a whole run spends 13 of the hourly 20 free live-test units before
 * AZ-159 restarts the node (which resets them), and 3 of the node's 5 lessons a day. A second run inside the same hour
 * therefore needs node-u restarted, and inside the same day needs its `ip:` day counter cleared — otherwise the run
 * measures the previous run. The scenarios that depend on the offline stub's deterministic answers say so out loud
 * (`N.waitForStubMode`) rather than failing on a sentence a real model happened to produce.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { loginViaUi } from '../helpers/ainize';
import * as N from '../helpers/ds-preview-node';
import * as U from '../helpers/ds-preview-ui';

/*
 * Serialisation: the suite config already runs this file one test at a time in declaration order (`workers: 1`,
 * `fullyParallel: false`), which is what keeps two scenarios from asking the model — or restarting node-u — at the
 * same time. A file-level `test.describe.configure({ mode: 'serial' })` is deliberately NOT used: these scenarios
 * share no state, and serial mode skips every test after the first failure, which would hide the results of the
 * scenarios that come after a known product bug (AZ-151, AZ-155, AZ-156, AZ-160 fail on purpose until it is fixed).
 */

const NODE = N.NODE;
const TAG = Date.now().toString(36).slice(-5);
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

let policy: N.Policy;

// ------------------------------------------------------------------ cleanup registry
interface Bin { key: N.TeacherKey; datasets: string[]; jobs: string[] }
let bins: Bin[] = [];
function bin(key: N.TeacherKey): Bin {
  let b = bins.find((x) => x.key.address.toLowerCase() === key.address.toLowerCase());
  if (!b) { b = { key, datasets: [], jobs: [] }; bins.push(b); }
  return b;
}
const trashDataset = (key: N.TeacherKey, id: string) => { const b = bin(key); if (!b.datasets.includes(id)) b.datasets.push(id); };
const trashJob = (key: N.TeacherKey, id: string) => { const b = bin(key); if (!b.jobs.includes(id)) b.jobs.push(id); };

/** What the daily counters were before this file raised them, so afterAll can put exactly that back. */
let quotaHeadroom: { token: string; restore: Record<string, number> } | null = null;

test.beforeAll(async ({ request }) => {
  // the dev node is shared and gets restarted by whoever is working on it, so a single unlucky read must not skip the file
  for (let i = 0; i < 12; i++) {
    try { policy = await N.policyOf(request); if (policy?.enabled) break; } catch { /* node restarting */ }
    await new Promise((r) => setTimeout(r, 5_000));
  }
  test.skip(!policy?.enabled, `teach mode is not enabled on ${NODE}`);
  // several of these scenarios train a lesson, and every suite on this box spends the same 127.0.0.1 daily budget:
  // without headroom the last project to run (mobile) is refused by "today's lesson limit", which is not the subject
  // of any scenario here. Raised for this file only, and put back in afterAll.
  quotaHeadroom = await N.raiseDailyQuota(request);
});

test.afterAll(async ({ request }) => {
  if (quotaHeadroom) await N.patchPolicy(request, quotaHeadroom.token, quotaHeadroom.restore).catch(() => undefined);
  quotaHeadroom = null;
});

test.afterEach(async ({ request }) => {
  for (const b of bins.splice(0)) {
    for (const id of b.jobs) { try { await N.deleteJob(request, b.key, id); } catch { /* best effort */ } }
    for (const id of b.datasets) { try { await N.deleteDataset(request, b.key, id); } catch { /* best effort */ } }
  }
  bins = [];
});

// ------------------------------------------------------------------ AZ-143

test('AZ-143 The whole file door on a 360 px phone: nothing scrolls sideways and the question table becomes cards @mobile', async ({ browser, request }) => {
  test.slow();
  const { context, page } = await U.visitorContext(browser, { width: 360, height: 740 });
  const file = `az-mob-${TAG}.jsonl`;
  const body = Buffer.from([
    JSON.stringify({ prompt: `AZ143 ${TAG} 사내 무선 인터넷 비밀번호와 게스트 네트워크 접속 방법을 정확히 알려 주세요?`, answer: `pw-${TAG}-01`, alt_prompt: `AZ143 ${TAG} 와이파이 암호 알려줘` }),
    JSON.stringify({ prompt: `AZ143 ${TAG} 본사 우편번호는?`, answer: '06236' }),
    JSON.stringify({ prompt: `AZ143 ${TAG} What is the support email?`, answer: '' }),
  ].join('\n') + '\n', 'utf8');

  try {
    // ---- /teach and /teach/upload: no sideways scroll, the stepper collapses, the paste box opens by itself
    await page.goto(`${NODE}/teach`);
    await page.getByTestId('teach-entry').waitFor();
    await U.expectNoSidewaysScroll(page, '/teach (en)');

    await page.goto(`${NODE}/teach/upload`);
    await page.getByTestId('teach-upload').waitFor();
    await U.expectNoSidewaysScroll(page, '/teach/upload (en)');

    const stepper = page.getByTestId('teach-stepper');
    await expect(stepper).toHaveAttribute('aria-label', 'Step 1 of 5 · Dataset');
    await expect(page.getByTestId('teach-step-small')).toBeVisible();
    await expect(page.getByTestId('teach-step-small')).toHaveText('Step 1 of 5 · Dataset');
    // the five spelled-out labels are not rendered at this width…
    await expect(stepper.locator('ol')).toBeHidden();
    for (const label of ['Dataset', 'Check', 'Settings', 'Training', 'Result']) {
      await expect(stepper.locator('ol li', { hasText: label })).toBeHidden();
    }
    // …but the five-segment bar is
    await expect(stepper.locator('[aria-hidden="true"] > span')).toHaveCount(5);

    // both intake paths usable with a thumb: the paste box is OPEN on arrival and the drop zone still has a real input
    const paste = page.getByTestId('paste-table');
    expect(await paste.evaluate((el) => (el as HTMLDetailsElement).open), 'paste box open below 480 px').toBe(true);
    await expect(page.getByTestId('paste-box')).toBeVisible();
    await expect(page.getByTestId('drop-zone').locator('input[type=file]')).toHaveCount(1);

    // ---- step 2: the preview stacks into cards
    const dsId = await U.uploadBytes(page, file, body);
    const key = await N.keyOfPage(page);
    trashDataset(key, dsId);
    await U.expectNoSidewaysScroll(page, '/teach/dataset (en)');

    const table = page.getByTestId('dataset-table');
    const thead = table.locator('thead');
    expect(await thead.evaluate((el) => {
      const s = getComputedStyle(el);
      return { position: s.position, width: s.width, height: s.height, overflow: s.overflow };
    }), 'thead is clipped to 1 px below 720 px').toEqual({ position: 'absolute', width: '1px', height: '1px', overflow: 'hidden' });

    await expect(U.rows(page)).toHaveCount(3);
    const long = U.rows(page).nth(0);
    expect(await long.evaluate((el) => getComputedStyle(el).display), 'each row is one card').toBe('block');
    expect(await long.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe('1px');
    // every cell prints its own column name — except the question, and the line number sits inline in front of it
    const labels = await long.evaluate((el) => [...el.querySelectorAll('td')].map((td) => ({
      cls: td.className, before: getComputedStyle(td, '::before').content, display: getComputedStyle(td).display,
    })));
    expect(labels[0]).toMatchObject({ before: '"Line: "', display: 'inline-block' });
    expect(labels[1].before, 'the question cell prints no label').toBe('none');
    expect(labels[2].before).toBe('"Right answer: "');
    expect(labels[3].before).toBe('"Another way to ask (optional): "');
    expect(labels[4].before).toBe('"Status: "');
    await expect(U.answerCell(long)).toHaveText(`pw-${TAG}-01`);
    await expect(U.altCell(long)).toHaveText(`AZ143 ${TAG} 와이파이 암호 알려줘`);
    // the long Korean question wraps inside its card instead of being cut off
    expect(await U.questionCell(long).evaluate((el) => getComputedStyle(el).wordBreak)).toBe('break-word');
    const qBox = (await U.questionCell(long).boundingBox())!;
    expect(qBox.x + qBox.width, 'the question stays inside the 360 px viewport').toBeLessThanOrEqual(361);
    expect(qBox.height, 'the long Korean question wraps onto several lines').toBeGreaterThan(20);

    // an empty cell is not rendered at all (td:empty { display: none })
    const plain = U.rows(page).nth(1);
    expect(await U.altCell(plain).evaluate((el) => getComputedStyle(el).display), 'an empty "another way to ask" cell is hidden').toBe('none');
    // …so the empty-answer row shows its red pill, not a blank labelled box
    const bad = U.rows(page).nth(2);
    await expect(bad).toHaveAttribute('data-bad', '1');
    await expect(U.pill(bad)).toHaveText('No answer — type the right answer');

    // the sticky bar stays on screen and is pressable without any sideways scrolling
    const toSettings = page.getByTestId('to-settings');
    const sticky = toSettings.locator('xpath=..');
    expect(await sticky.evaluate((el) => getComputedStyle(el).position)).toBe('sticky');
    await expect(toSettings).toHaveText('Continue to settings');
    const sBox = (await toSettings.boundingBox())!;
    expect(sBox.x).toBeGreaterThanOrEqual(0);
    expect(sBox.x + sBox.width).toBeLessThanOrEqual(361);
    expect(sBox.y + sBox.height).toBeLessThanOrEqual(741);

    // ---- step 3
    await toSettings.click();
    await page.getByTestId('teach-settings').waitFor();
    await U.expectNoSidewaysScroll(page, '/teach/dataset/:id/settings (en)');
    const train = page.getByTestId('train-lesson');
    // NOTE the scenario's sticky-bar text says "Train this lesson (3 questions)"; its own 3-line fixture has one line
    // with an empty answer, so the DATASET holds 2 questions and the button is the honest count of those.
    await expect(train).toHaveText('Train this lesson (up to 2 questions)');
    const tBox = (await train.boundingBox())!;
    expect(tBox.x).toBeGreaterThanOrEqual(0);
    expect(tBox.x + tBox.width).toBeLessThanOrEqual(361);

    // ---- step 4 (running) and step 5 (result)
    const jobId = await U.train(page);
    trashJob(key, jobId);
    const lesson = page.getByTestId('teach-lesson');
    await lesson.waitFor();
    let sawActive = false;
    for (let i = 0; i < 300; i++) {
      const status = await lesson.getAttribute('data-status');
      if (status && ['QUEUED', 'PREFLIGHT', 'LOADING', 'TRAINING', 'EXPORTED', 'CHECKING'].includes(status)) {
        sawActive = true;
        await U.expectNoSidewaysScroll(page, `/teach/lesson (${status}, en)`);
        // the stage rail and the counters wrap instead of overflowing
        expect(await page.getByTestId('stage-rail').evaluate((el) => getComputedStyle(el).flexWrap)).toBe('wrap');
        const rail = (await page.getByTestId('stage-rail').boundingBox())!;
        expect(rail.x + rail.width).toBeLessThanOrEqual(361);
      }
      if (status && !['QUEUED', 'PREFLIGHT', 'LOADING', 'TRAINING', 'EXPORTED', 'CHECKING'].includes(status)) break;
      await page.waitForTimeout(1000);
    }
    expect(sawActive, 'the progress screen was rendered at least once').toBe(true);
    await expect(lesson).toHaveAttribute('data-status', /READY|NEEDS_MORE|FAILED/, { timeout: 5 * 60_000 });
    await U.expectNoSidewaysScroll(page, '/teach/lesson (done, en)');
    const learned = page.getByTestId('learned-block');
    if (await learned.count()) {
      const fTable = learned.locator('table');
      expect(await fTable.locator('thead').evaluate((el) => getComputedStyle(el).width), '"What it learned" thead is clipped too').toBe('1px');
      const cellsOf = await fTable.locator('tbody tr').first().evaluate((el) => [...el.querySelectorAll('td')].map((td) => ({ d: getComputedStyle(td).display, b: getComputedStyle(td, '::before').content })));
      expect(cellsOf[0]).toMatchObject({ d: 'block', b: 'none' });
      expect(cellsOf[1].b).toBe('"Before: "');
      expect(cellsOf[2].b).toBe('"After: "');
      expect(cellsOf[3].b).toBe('"Other wording: "');
    }

    await page.goto(`${NODE}/teach/mine`);
    await page.getByTestId('teach-mine').waitFor();
    await U.expectNoSidewaysScroll(page, '/teach/mine (en)');

    // ---- the same five pages in Korean
    await U.switchToKorean(page);
    await U.expectNoSidewaysScroll(page, '/teach/mine (ko)');
    for (const [where, url, step] of [
      ['/teach/upload (ko)', `${NODE}/teach/upload`, '1/5단계 · 데이터셋'],
      ['/teach/dataset (ko)', `${NODE}/teach/dataset/${dsId}`, '2/5단계 · 확인'],
      ['/teach/dataset/:id/settings (ko)', `${NODE}/teach/dataset/${dsId}/settings`, '3/5단계 · 설정'],
      ['/teach/lesson (ko)', `${NODE}/teach/lesson/${jobId}`, '5/5단계 · 결과'],
    ] as const) {
      await page.goto(url);
      await page.getByTestId('teach-stepper').waitFor();
      await expect(page.getByTestId('teach-step-small')).toHaveText(step);
      await U.expectNoSidewaysScroll(page, where);
    }
  } finally {
    await context.close();
  }
});

// ------------------------------------------------------------------ AZ-144

test('AZ-144 Preview table: ok vs tidied-up rows, the tidy-up receipt and the same verdicts in Korean', async ({ browser, request }) => {
  const { context, page } = await U.visitorContext(browser);
  try {
    const dsId = await U.uploadFixture(page, 'az144-fixes.jsonl');
    const key = await N.keyOfPage(page);
    trashDataset(key, dsId);

    await expect(U.rows(page)).toHaveCount(4);
    for (const [i, line] of [1, 2, 3, 4].entries()) await expect(U.lineCell(U.rows(page).nth(i))).toHaveText(String(line));
    for (const i of [0, 1, 2]) await expect(U.pill(U.rows(page).nth(i))).toHaveText('Read OK — tidied up');
    await expect(U.pill(U.rows(page).nth(3))).toHaveText('Read OK');
    for (const i of [0, 1, 2, 3]) await expect(U.helpLines(U.rows(page).nth(i))).toHaveText(['Not checked yet']);
    await expect(U.questionCell(U.rows(page).nth(0))).toHaveText('Who founded Ainize?');
    await expect(U.answerCell(U.rows(page).nth(0))).toHaveText('Comcom of Seoul');
    await expect(U.questionCell(U.rows(page).nth(1))).toHaveText('What is 2+2?');
    await expect(U.questionCell(U.rows(page).nth(2))).toHaveText('Zerowidth?');

    await expect(page.getByTestId('fixed-note')).toHaveText('3 question(s) were tidied up (extra spaces and line breaks removed).');
    await expect(U.counts(page)).toHaveText('4 will train · 0 already known · 0 duplicates · 0 need a fix');

    // the machine-readable report the screen is rendered from
    const report = await N.getRows(request, key, dsId, '?limit=50');
    expect(report.status).toBe(200);
    expect(report.body.items.map((r) => [r.line, r.status, r.fixes ?? []])).toEqual([
      [1, 'fixed', ['answer_flattened', 'whitespace_collapsed']],
      [2, 'fixed', ['qa_prefix_stripped']],
      [3, 'fixed', ['controls_stripped']],
      [4, 'ok', []],
    ]);

    // the download holds the normalised text and nothing else
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('download-dataset').click()]);
    const saved = readFileSync((await dl.path())!, 'utf8');
    expect(saved).toBe([
      '{"prompt":"Who founded Ainize?","answer":"Comcom of Seoul"}',
      '{"prompt":"What is 2+2?","answer":"4"}',
      '{"prompt":"Zerowidth?","answer":"yes"}',
      '{"prompt":"When did Ainize start?","answer":"2020"}',
    ].join('\n') + '\n');

    // the same verdicts in Korean — rendered from the row status, never from the server's English detail
    await U.switchToKorean(page);
    await expect(U.counts(page)).toHaveText('학습 4개 · 이미 알고 있음 0개 · 중복 0개 · 고칠 것 0개');
    for (const i of [0, 1, 2]) await expect(U.pill(U.rows(page).nth(i))).toHaveText('읽었습니다 — 다듬음');
    await expect(U.pill(U.rows(page).nth(3))).toHaveText('읽었습니다');
    await expect(page.getByTestId('dataset-table')).not.toContainText('Will train');
  } finally {
    await context.close();
  }
});

// ------------------------------------------------------------------ AZ-145

test('AZ-145 Two answers for one question block both copies, and "Use this one" resolves the contradiction', async ({ browser, request }) => {
  const { context, page } = await U.visitorContext(browser);
  try {
    const dsId = await U.uploadFixture(page, 'az145-conflict.csv');
    const key = await N.keyOfPage(page);
    trashDataset(key, dsId);

    await expect(U.rows(page)).toHaveCount(4);
    const conflict = [0, 1, 2].map((i) => U.rows(page).nth(i));
    for (const [i, row] of conflict.entries()) {
      await expect(U.lineCell(row)).toHaveText(String(i + 2));
      await expect(row).toHaveAttribute('data-bad', '1');
      await expect(U.pill(row)).toHaveText('Two answers for this question — pick one');
      await expect(row.getByTestId('row-edit')).toBeVisible();
      // Finding 48 — a contradiction is one either/or choice, and the wrong half can finally be deleted
      await expect(row.getByTestId('row-keep')).toHaveText('Use this one');
      await expect(row.getByTestId('row-remove')).toHaveText('Drop this one');
    }
    // each row names the OTHER lines that disagree
    await expect(U.helpLines(conflict[0])).toHaveText(['Lines 2 and 3 ask the same question but give different answers. The model can only learn one.']);
    await expect(U.helpLines(conflict[1])).toHaveText(['Lines 3 and 2 ask the same question but give different answers. The model can only learn one.']);
    await expect(U.helpLines(conflict[2])).toHaveText(['Lines 4 and 2 ask the same question but give different answers. The model can only learn one.']);

    await expect(U.counts(page)).toHaveText('1 will train · 0 already known · 0 duplicates · 3 need a fix');
    const before = await N.getDataset(request, key, dsId);
    expect(before.body.dataset.rows).toBe(1);
    expect(before.body.dataset.revision).toBe(1);
    expect((await N.getRows(request, key, dsId)).body.summary.conflicts).toBe(3);

    // keep the Line 4 answer (ComcomAI)
    await expect(U.answerCell(conflict[2])).toHaveText('ComcomAI');
    await conflict[2].getByTestId('row-keep').click();
    await expect(U.rows(page)).toHaveCount(2, { timeout: 60_000 });

    await expect(U.questionCell(U.rows(page).nth(0))).toHaveText('When did Ainize start?');
    await expect(U.answerCell(U.rows(page).nth(0))).toHaveText('2020');
    await expect(U.questionCell(U.rows(page).nth(1))).toHaveText('Who founded Ainize?');
    await expect(U.answerCell(U.rows(page).nth(1))).toHaveText('ComcomAI');
    await expect(U.lineCell(U.rows(page).nth(0))).toHaveText('1');
    await expect(U.lineCell(U.rows(page).nth(1))).toHaveText('2');
    for (const i of [0, 1]) await expect(U.pill(U.rows(page).nth(i))).toHaveText('Read OK');
    await expect(U.counts(page)).toHaveText('2 will train · 0 already known · 0 duplicates · 0 need a fix');

    const after = await N.getDataset(request, key, dsId);
    expect(after.body.dataset.revision).toBe(2);
    expect(after.body.dataset.rows).toBe(2);
    expect(after.body.dataset.sha256).not.toBe(before.body.dataset.sha256);
    expect((await N.getRows(request, key, dsId)).body.summary.conflicts).toBe(0);
    const bytes = await N.signedRaw(request, key, `/api/teach/datasets/${dsId}/download`);
    expect(bytes.body.toString('utf8').trim().split('\n').at(-1)).toBe('{"prompt":"Who founded Ainize?","answer":"ComcomAI"}');
  } finally {
    await context.close();
  }
});

// ------------------------------------------------------------------ AZ-146

test('AZ-146 Too long: the pill names the real length and the node\'s limit, and the edit sheet refuses the same text', async ({ browser, request }) => {
  const { context, page } = await U.visitorContext(browser);
  const promptMax = policy.limits.prompt_max;
  const answerMax = policy.limits.answer_max;
  try {
    const patches = U.watchRequests(page, (url, method) => method === 'PATCH' && url.includes('/api/teach/datasets/'));
    const dsId = await U.uploadFixture(page, 'az146-long.jsonl');
    const key = await N.keyOfPage(page);
    trashDataset(key, dsId);

    await expect(U.rows(page)).toHaveCount(3);
    const r1 = U.rows(page).nth(0);
    const r2 = U.rows(page).nth(1);
    await expect(U.pill(r1)).toHaveText(`The answer is 210 characters; keep it under ${answerMax}. Teach a long explanation as several short facts.`);
    await expect(U.pill(r2)).toHaveText(`The question is 431 characters; keep it under ${promptMax}.`);
    for (const row of [r1, r2]) {
      await expect(row).toHaveAttribute('data-bad', '1');
      await expect(row.getByTestId('row-edit')).toBeVisible();
      // finding 48 — an over-long row can be taken out instead of only edited
      await expect(row.getByTestId('row-remove')).toHaveText('Remove');
      await expect(row.getByTestId('row-keep')).toHaveCount(0);
    }
    await expect(U.counts(page)).toHaveText('1 will train · 0 already known · 0 duplicates · 2 need a fix');

    const rep = await N.getRows(request, key, dsId, '?status=too_long');
    expect(rep.body.summary.too_long).toBe(2);
    expect(rep.body.items.map((r) => r.detail)).toEqual([
      `the answer is 210 characters, ${210 - answerMax} over the ${answerMax} limit`,
      `the question is 431 characters, ${431 - promptMax} over the ${promptMax} limit`,
    ]);

    // the same rule before a NEW question is sent
    const before = await N.getDataset(request, key, dsId);
    await page.getByTestId('add-row').click();
    const sheet = page.getByTestId('row-edit-sheet');
    await sheet.getByTestId('row-q').fill('Q?');
    await sheet.getByTestId('row-a').fill('y'.repeat(230));
    const counter = sheet.getByTestId('row-a').locator('xpath=following-sibling::*[1]');
    await expect(counter).toHaveText(`230/${answerMax}`);
    const errColour = await counter.evaluate((el) => getComputedStyle(el).color);
    const okColour = await sheet.getByTestId('row-q').locator('xpath=following-sibling::*[1]').evaluate((el) => getComputedStyle(el).color);
    expect(errColour, 'the over-length counter is in the error colour').not.toBe(okColour);
    await sheet.getByTestId('row-save').click();
    await expect(sheet.getByRole('alert')).toHaveText(`The answer is 230 characters; keep it under ${answerMax}. Teach a long explanation as several short facts.`);
    await expect(sheet).toBeVisible();

    expect(patches.seen, 'the browser refuses the same text without asking the node').toHaveLength(0);
    const after = await N.getDataset(request, key, dsId);
    expect(after.body.dataset.revision).toBe(before.body.dataset.revision);
    expect(after.body.dataset.sha256).toBe(before.body.dataset.sha256);
  } finally {
    await context.close();
  }
});

// ------------------------------------------------------------------ AZ-147

test('AZ-147 A half-filled line says which half is missing', async ({ browser, request }) => {
  const { context, page } = await U.visitorContext(browser);
  try {
    const dsId = await U.uploadFixture(page, 'az147-empty.csv');
    const key = await N.keyOfPage(page);
    trashDataset(key, dsId);

    await expect(U.rows(page)).toHaveCount(3);
    const noQ = U.rows(page).nth(0);
    const noA = U.rows(page).nth(1);
    await expect(U.lineCell(noQ)).toHaveText('2');
    await expect(U.questionCell(noQ)).toHaveText('—');
    await expect(U.answerCell(noQ)).toHaveText('Comcom');
    await expect(U.pill(noQ)).toHaveText('No question — type the question');

    await expect(U.lineCell(noA)).toHaveText('3');
    await expect(U.questionCell(noA)).toHaveText('Who founded Ainize?');
    // the node kept no answer for this line, so the cell renders the same "nothing here" placeholder
    await expect(U.answerCell(noA)).toHaveText('—');
    await expect(U.pill(noA)).toHaveText('No answer — type the right answer');

    // Finding 48 — the rows that need fixing were the only rows that could not be removed, although the obvious
    // answer to a line the parser refused is to delete it. A refused line has no index in the stored questions, so
    // it is dropped by its SOURCE LINE (`rows_op.drop_rejected`) and stops being carried into every later report.
    for (const row of [noQ, noA]) {
      await expect(row.getByTestId('row-remove')).toBeVisible();
      await expect(row.getByTestId('row-edit')).toBeVisible();
    }
    await expect(U.pill(U.rows(page).nth(2))).toHaveText('Read OK');
    await expect(U.counts(page)).toHaveText('1 will train · 0 already known · 0 duplicates · 2 need a fix');
    expect((await N.getDataset(request, key, dsId)).body.dataset.rows).toBe(1);

    const rep = await N.getRows(request, key, dsId, '?status=empty');
    expect(rep.body.summary.empty).toBe(2);
    expect(rep.body.items.map((r) => [r.line, r.detail])).toEqual([[2, 'this answer has no question'], [3, 'this question has no answer']]);

    // …and taking one out drops it for good: the questions are untouched, the report stops carrying it, and the
    // counts are recomputed from what is left (finding 48).
    await noA.getByTestId('row-remove').click();
    await expect(page.getByTestId('dataset-note')).toContainText('was taken off the list');
    await expect(U.counts(page)).toHaveText('1 will train · 0 already known · 0 duplicates · 1 need a fix');
    expect((await N.getDataset(request, key, dsId)).body.dataset.rows, 'dropping a refused line changes no question').toBe(1);
    const after = await N.getRows(request, key, dsId, '?status=empty');
    expect(after.body.items.map((r) => r.line)).toEqual([2]);
  } finally {
    await context.close();
  }
});

// ------------------------------------------------------------------ AZ-148

test('AZ-148 A topic the operator blocks is refused per row, and the regex itself is validated', async ({ browser, request }) => {
  test.slow();
  const op = await U.visitorContext(browser);
  const visitor = await U.visitorContext(browser);
  let previous = '';
  let restored = false;
  const setBlocked = async (value: string) => {
    const field = op.page.getByTestId('teach-blocked');
    await field.fill(value);
    await op.page.getByTestId('teach-save').click();
    await expect(op.page.getByTestId('teach-notice')).toHaveText('Saved.', { timeout: 60_000 });
  };
  try {
    await loginViaUi(op.page, NODE);
    await op.page.goto(`${NODE}/dashboard?tab=teaching`);
    await op.page.getByTestId('teaching-tab').waitFor();
    previous = await op.page.getByTestId('teach-blocked').inputValue();   // put back in `finally`, whatever it was
    await setBlocked('bomb|폭탄');

    const dsBlocked = await U.uploadFixture(visitor.page, 'az148-blocked.jsonl');
    const key = await N.keyOfPage(visitor.page);
    trashDataset(key, dsBlocked);
    await expect(U.rows(visitor.page)).toHaveCount(2);
    await expect(U.pill(U.rows(visitor.page).nth(0))).toHaveText('The node operator does not accept this topic');
    await expect(U.rows(visitor.page).nth(0)).toHaveAttribute('data-bad', '1');
    await expect(U.pill(U.rows(visitor.page).nth(1))).toHaveText('Read OK');
    await expect(U.counts(visitor.page)).toHaveText('1 will train · 0 already known · 0 duplicates · 1 need a fix');

    const rep = await N.getRows(request, key, dsBlocked, '?status=blocked');
    expect(rep.body.summary.blocked).toBe(1);
    expect(rep.body.items.map((r) => [r.line, r.detail])).toEqual([[1, 'the node operator does not accept this topic']]);
    const bytes = await N.signedRaw(request, key, `/api/teach/datasets/${dsBlocked}/download`);
    expect(bytes.body.toString('utf8')).toBe('{"prompt":"Who founded Ainize?","answer":"Comcom"}\n');

    // clear the rule → the SAME file now trains both rows, so the refusal came from the operator setting
    await setBlocked(previous);
    restored = true;
    const dsOpen = await U.uploadFixture(visitor.page, 'az148-blocked.jsonl');
    trashDataset(key, dsOpen);
    expect(dsOpen, 'a different rule produces different canonical bytes, so it is a different dataset').not.toBe(dsBlocked);
    await expect(U.rows(visitor.page)).toHaveCount(2);
    for (const i of [0, 1]) await expect(U.pill(U.rows(visitor.page).nth(i))).toHaveText('Read OK');
    await expect(U.counts(visitor.page)).toHaveText('2 will train · 0 already known · 0 duplicates · 0 need a fix');
  } finally {
    if (!restored) { try { await setBlocked(previous); } catch { /* best effort */ } }
    await visitor.context.close();
    await op.context.close();
  }
});

// ------------------------------------------------------------------ AZ-149

test('AZ-149 Lines the node could not read never enter the table — they are listed and counted underneath', async ({ browser, request }) => {
  const { context, page } = await U.visitorContext(browser);
  try {
    const dsId = await U.uploadFixture(page, 'az149-drop.jsonl');
    const key = await N.keyOfPage(page);
    trashDataset(key, dsId);

    await expect(U.rows(page)).toHaveCount(1);
    await expect(U.lineCell(U.rows(page).first())).toHaveText('1');
    await expect(U.pill(U.rows(page).first())).toHaveText('Read OK');
    await expect(U.counts(page)).toHaveText('1 will train · 0 already known · 0 duplicates · 3 need a fix');

    const dropped = page.getByTestId('dropped');
    await expect(dropped.locator('summary')).toHaveText('3 line(s) could not be read and were left out. — See the lines that were left out');
    await dropped.locator('summary').click();
    const items = dropped.locator('li');
    await expect(items).toHaveCount(3);
    await expect(items.nth(0)).toHaveText('Line 2 could not be read as a question and an answer. this line is not json');
    await expect(items.nth(1)).toHaveText('Line 3 could not be read as a question and an answer. ["an array, not an object"]');
    await expect(items.nth(2)).toHaveText('Line 4 could not be read as a question and an answer. {"foo":"bar"}');
    for (const i of [0, 1, 2]) await expect(items.nth(i).locator('code')).toHaveCount(1);

    const rep = await N.getRows(request, key, dsId, '?status=not_parsed');
    expect(rep.body.summary.not_parsed).toBe(3);
    expect(rep.body.items.map((r) => [r.line, r.status, r.detail, r.raw])).toEqual([
      [2, 'not_parsed', 'line is not valid JSON', 'this line is not json'],
      [3, 'not_parsed', 'line is not a JSON object', '["an array, not an object"]'],
      [4, 'not_parsed', 'no question/answer keys in this object', '{"foo":"bar"}'],
    ]);
    for (const r of rep.body.items) expect((r.raw ?? '').length).toBeLessThanOrEqual(200);
  } finally {
    await context.close();
  }
});

// ------------------------------------------------------------------ AZ-150

test('AZ-150 The Line column is the line of the uploaded file: header, blank lines and a quoted newline all counted the node\'s way', async ({ browser, request }) => {
  const { context, page } = await U.visitorContext(browser);
  try {
    const source = U.fixtureText('az150-lines.csv');
    const dsId = await U.uploadFixture(page, 'az150-lines.csv');
    const key = await N.keyOfPage(page);
    trashDataset(key, dsId);

    await expect(U.rows(page)).toHaveCount(3);
    const lines = await U.rows(page).locator('td.n').allTextContents();
    expect(lines, 'the header is line 1 and the blank line 3 keeps its number').toEqual(['2', '4', '5']);
    await expect(U.pill(U.rows(page).nth(0))).toHaveText('Read OK');
    await expect(U.pill(U.rows(page).nth(1))).toHaveText('Read OK — tidied up');
    await expect(U.pill(U.rows(page).nth(2))).toHaveText('Read OK');
    await expect(U.questionCell(U.rows(page).nth(1)), 'the quoted newline does not split the row').toHaveText('B, two? continued');

    const rep = await N.getRows(request, key, dsId, '?limit=50');
    expect(rep.body.items.map((r) => r.line)).toEqual([2, 4, 5]);
    const report = await N.signed<{ notes: string[]; has_header: boolean; delimiter: string; columns: Record<string, number> }>(
      request, key, 'GET', `/api/teach/datasets/${dsId}`,
    );
    expect(report.status).toBe(200);
    // the parser facts the Line column depends on, straight off the dataset record
    const ds = (report.body as unknown as { dataset: Record<string, unknown> }).dataset;
    expect(ds.has_header).toBe(true);
    expect(ds.delimiter).toBe(',');
    expect(ds.columns).toEqual({ prompt: 0, answer: 1 });
    // report.json itself: the blank line and the header are both accounted for (the notes are written to the file and
    // are not part of any API view, so they are read where the node wrote them)
    const notes = (JSON.parse(readFileSync(join(N.NODE_HOME, 'data/teach/datasets', dsId, 'report.json'), 'utf8')) as { notes: string[]; has_header: boolean; delimiter: string; columns: Record<string, number> });
    expect(notes.notes).toContain('blank_rows:2');
    expect([notes.has_header, notes.delimiter, notes.columns]).toEqual([true, ',', { prompt: 0, answer: 1 }]);

    const bytes = await N.signedRaw(request, key, `/api/teach/datasets/${dsId}/download`);
    expect(bytes.body.toString('utf8')).toBe([
      '{"prompt":"A one?","answer":"1"}',
      '{"prompt":"B, two? continued","answer":"2"}',
      '{"prompt":"C three?","answer":"3"}',
    ].join('\n') + '\n');

    // the documented consequence: the number is the LOGICAL row, not the physical text line
    const physical = source.split('\n').findIndex((l) => l.startsWith('C three?')) + 1;
    expect(physical, 'C three? is the 6th physical line of the file').toBe(6);
    await expect(U.lineCell(U.rows(page).nth(2)), 'but the column says 5, its logical row').toHaveText('5');
  } finally {
    await context.close();
  }
});

// ------------------------------------------------------------------ AZ-151

test('AZ-151 After the first edit the report is rebuilt: rejected lines disappear and the numbers stop being file lines', async ({ browser, request }) => {
  const { context, page } = await U.visitorContext(browser);
  try {
    const dsId = await U.uploadFixture(page, 'az151-mix.csv');
    const key = await N.keyOfPage(page);
    trashDataset(key, dsId);

    // ---- before (an unreadable line is never a table row: it is listed underneath, AZ-149)
    await expect(U.rows(page)).toHaveCount(5);
    const seen = await U.rows(page).evaluateAll((trs) => trs.map((tr) => ({ line: tr.querySelector('td.n')!.textContent, status: tr.getAttribute('data-status') })));
    expect(seen).toEqual([
      { line: '2', status: 'conflict' }, { line: '3', status: 'conflict' }, { line: '4', status: 'empty' },
      { line: '6', status: 'ok' }, { line: '7', status: 'ok' },
    ]);
    await expect(U.pill(U.rows(page).nth(2))).toHaveText('No question — type the question');
    await expect(page.getByTestId('dropped').locator('summary')).toContainText('1 line(s) could not be read and were left out.');
    await page.getByTestId('dropped').locator('summary').click();
    await expect(page.getByTestId('dropped').locator('li')).toHaveText(['Line 5 could not be read as a question and an answer. not two columns']);
    // NOTE the scenario's "3 need a fix" does not add up for its own fixture: 2 conflicts + 1 empty + 1 unreadable = 4,
    // and AZ-149 fixes the rule that an unreadable line IS counted here.
    await expect(U.counts(page)).toHaveText('2 will train · 0 already known · 0 duplicates · 4 need a fix');
    const before = (await N.getDataset(request, key, dsId)).body.dataset;
    expect(before.revision).toBe(1);

    // ---- remove the last question
    await U.rows(page).nth(4).getByTestId('row-remove').click();
    await expect(U.rows(page)).toHaveCount(4, { timeout: 60_000 });
    await expect(U.lineCell(U.rows(page).first())).toHaveText('1');
    await expect(U.questionCell(U.rows(page).first())).toHaveText('픽셀플러스 종목코드는?');
    /*
     * Item 5 — an edit rewrites the dataset from its ACCEPTED rows, and the report used to be re-derived from those
     * alone: removing one good question made the two contradictions, the empty row and the unreadable line vanish
     * from the screen with no message, and the pill read "0 need a fix". They are carried instead, marked with the
     * line of the uploaded file they came from (never a position in the rewritten set), and still counted.
     */
    const kept = await U.rows(page).evaluateAll((trs) => trs.map((tr) => ({
      line: tr.querySelector('td.n')!.textContent, status: tr.getAttribute('data-status'), carried: tr.getAttribute('data-carried'),
    })));
    expect(kept).toEqual([
      { line: '1', status: 'ok', carried: null },
      { line: 'file line 2', status: 'conflict', carried: '1' },
      { line: 'file line 3', status: 'conflict', carried: '1' },
      { line: 'file line 4', status: 'empty', carried: '1' },
    ]);
    await expect(page.getByTestId('dropped').locator('summary'), 'the unreadable line is still listed underneath')
      .toContainText('1 line(s) could not be read and were left out.');
    await expect(U.counts(page)).toHaveText('1 will train · 0 already known · 0 duplicates · 4 need a fix');
    await expect(page.getByTestId('carried-note')).toContainText('4 line(s)');

    const rejected = await N.getRows(request, key, dsId, '?status=rejected');
    expect(rejected.body.items, 'every refused source row is still readable from the API').toHaveLength(4);
    expect(rejected.body.items.every((r) => r.carried === true)).toBe(true);
    const after = (await N.getDataset(request, key, dsId)).body.dataset;
    expect(after.revision).toBe(2);
    expect(after.sha256).not.toBe(before.sha256);
    const dl = await N.signedRaw(request, key, `/api/teach/datasets/${dsId}/download`);
    expect(dl.headers['content-disposition']).toBe(`attachment; filename="dataset-${dsId}-r2.jsonl"`);

    // ---- the honesty requirement this scenario forces (product fix, not a test detail):
    // after the rewrite these numbers are positions in the DATASET, not lines of az151-mix.csv, and the screen must
    // stop claiming otherwise.
    const heading = (await page.getByTestId('dataset-table').locator('thead th').nth(0).textContent())?.trim();
    expect(heading, 'after a rewrite the column can no longer be headed "Line" — it is the position in the dataset').not.toBe('Line');
    await expect(page.getByTestId('teach-dataset'), 'after a rewrite the page must stop saying the questions are "Saved as az151-mix.csv"')
      .not.toContainText('Saved as az151-mix.csv');
  } finally {
    await context.close();
  }
});

// ------------------------------------------------------------------ AZ-152

test('AZ-152 Changing a question throws away every model verdict on the screen', async ({ browser, request }) => {
  test.slow();
  const { context, page } = await U.visitorContext(browser);
  try {
    expect(await N.waitForStubMode(request), 'this scenario needs node-u on its offline stub (teach.stubOffline) — another session has it pointed at a live model').toBe(true);
    const dsId = await U.uploadFixture(page, 'az152-check.jsonl');
    const key = await N.keyOfPage(page);
    trashDataset(key, dsId);

    const expectUnchecked = async (n: number) => {
      await expect(U.rows(page)).toHaveCount(n);
      await expect(page.getByTestId('checked-note')).toHaveCount(0);
      for (let i = 0; i < n; i++) {
        await expect(U.pill(U.rows(page).nth(i))).toHaveText('Read OK');
        await expect(U.helpLines(U.rows(page).nth(i))).toHaveText(['Not checked yet']);
      }
    };

    // ---- measure
    // this node answers the check itself (policy.simulated_checks) — every sentence about it says so
    await expect(page.getByTestId('checks-simulated')).toHaveText('Demo node — these checks were simulated, not measured in a live model.');
    await expect(page.getByTestId('run-check')).toHaveText('Check (simulated on this node)');
    await U.runCheck(page);
    await expect(page.getByTestId('checked-note')).toHaveText('Simulated check: 2 of 3 are marked to train — nothing was measured in a live model.');
    await expect(U.pill(U.rows(page).nth(0))).toHaveText('Already known — skipped');
    await expect(U.helpLines(U.rows(page).nth(0))).toHaveText(['Simulated answer (no model was asked): 픽셀플러스']);
    for (const i of [1, 2]) {
      await expect(U.pill(U.rows(page).nth(i))).toHaveText('Will train');
      await expect(U.helpLines(U.rows(page).nth(i))).toHaveText([/^Simulated answer \(no model was asked\): \(stub model\) I do not know: /]);
    }
    await expect(U.counts(page)).toHaveText('2 will train · 1 already known · 0 duplicates · 0 need a fix');

    // ---- an edit clears EVERY verdict, not only the edited row
    await U.editRow(page, U.rows(page).nth(1), { answer: 'Comcom Inc.' });
    await expectUnchecked(3);
    await expect(U.counts(page)).toHaveText('3 will train · 0 already known · 0 duplicates · 0 need a fix');
    const afterEdit = (await N.getDataset(request, key, dsId)).body.dataset;
    expect(afterEdit.revision).toBe(2);
    await expect(U.answerCell(U.rows(page).nth(1))).toHaveText('Comcom Inc.');

    // ---- so does a removal
    await U.runCheck(page);
    await expect(page.getByTestId('checked-note')).toBeVisible();
    await U.rows(page).nth(2).getByTestId('row-remove').click();
    await expect(U.rows(page)).toHaveCount(2, { timeout: 60_000 });
    await expectUnchecked(2);
    expect((await N.getDataset(request, key, dsId)).body.dataset.revision).toBe(3);

    // ---- and so does a re-read of the original file
    await U.runCheck(page);
    await expect(page.getByTestId('checked-note')).toBeVisible();
    await page.getByTestId('open-reparse').click();
    await page.getByTestId('reparse-go').click();
    await expect(U.rows(page)).toHaveCount(3, { timeout: 60_000 });
    await expectUnchecked(3);
    expect((await N.getDataset(request, key, dsId)).body.dataset.revision).toBe(4);
  } finally {
    await context.close();
  }
});

// ------------------------------------------------------------------ AZ-153

test('AZ-153 Editing a refused row adds the corrected question instead of pretending to repair the file', async ({ browser, request }) => {
  const { context, page } = await U.visitorContext(browser);
  const promptMax = policy.limits.prompt_max;
  const answerMax = policy.limits.answer_max;
  try {
    const sent = await U.recordFetchBodies(page);
    const dsId = await U.uploadFixture(page, 'az153-long.jsonl');
    const key = await N.keyOfPage(page);
    trashDataset(key, dsId);

    const refused = U.rows(page).nth(0);
    await expect(refused).toHaveAttribute('data-status', 'too_long');
    await refused.getByTestId('row-edit').click();
    const sheet = page.getByTestId('row-edit-sheet');
    await expect(sheet.getByRole('heading')).toHaveText('Question, line 1');
    await expect(sheet.getByTestId('row-q')).toHaveValue('Explain the whole history of the Korean peninsula in one line');
    await expect(sheet.getByTestId('row-q').locator('xpath=following-sibling::*[1]')).toHaveText(`61/${promptMax}`);
    await expect(sheet.getByTestId('row-a').locator('xpath=following-sibling::*[1]')).toHaveText(`210/${answerMax}`);

    await sheet.getByTestId('row-a').fill('It is long.');
    await sheet.getByTestId('row-save').click();
    await expect(sheet).toBeHidden({ timeout: 60_000 });

    const patches = (await sent()).filter((r) => r.method === 'PATCH' && r.url.includes(`/api/teach/datasets/${dsId}`));
    expect(patches).toHaveLength(1);
    expect(JSON.parse(patches[0].body), 'a refused row has no index in the dataset, so it can only be appended').toEqual({
      rows_op: { op: 'append', rows: [{ prompt: 'Explain the whole history of the Korean peninsula in one line', answer: 'It is long.' }] },
    });

    await expect(U.rows(page)).toHaveCount(2, { timeout: 60_000 });
    const ds = (await N.getDataset(request, key, dsId)).body.dataset;
    expect(ds.rows).toBe(2);
    expect(ds.revision).toBe(2);
    await expect(U.questionCell(U.rows(page).nth(0))).toHaveText('Who founded Ainize?');
    await expect(U.questionCell(U.rows(page).nth(1))).toHaveText('Explain the whole history of the Korean peninsula in one line');
    const bytes = (await N.signedRaw(request, key, `/api/teach/datasets/${dsId}/download`)).body.toString('utf8');
    expect(bytes.trim().split('\n').at(-1)).toBe('{"prompt":"Explain the whole history of the Korean peninsula in one line","answer":"It is long."}');

    expect((await N.getRows(request, key, dsId)).body.summary.too_long).toBe(0);
    await expect(U.counts(page)).toHaveText('2 will train · 0 already known · 0 duplicates · 0 need a fix');
  } finally {
    await context.close();
  }
});

// ------------------------------------------------------------------ AZ-154

test('AZ-154 Remove a question, undo it, and see exactly what changed each time', async ({ browser, request }) => {
  test.slow();
  const { context, page } = await U.visitorContext(browser);
  try {
    const dsId = await U.uploadFixture(page, 'az154-krx.csv');
    const key = await N.keyOfPage(page);
    trashDataset(key, dsId);
    const r1 = (await N.getDataset(request, key, dsId)).body.dataset;
    expect(r1.revision).toBe(1);
    expect(r1.rows).toBe(3);

    await U.rows(page).nth(2).getByTestId('row-remove').click();
    const toast = page.getByTestId('undo-toast');
    await expect(toast).toContainText('Removed "카카오 종목코드는?".');
    await expect(toast.getByTestId('undo')).toHaveText('Undo');

    await expect(U.rows(page)).toHaveCount(2);
    expect(await U.rows(page).locator('td.n').allTextContents()).toEqual(['1', '2']);
    await expect(U.counts(page)).toHaveText('2 will train · 0 already known · 0 duplicates · 0 need a fix');
    const r2 = (await N.getDataset(request, key, dsId)).body.dataset;
    expect(r2.rows).toBe(2);
    expect(r2.revision).toBe(2);
    expect(r2.sha256).not.toBe(r1.sha256);

    await toast.getByTestId('undo').click();
    await expect(U.rows(page)).toHaveCount(3, { timeout: 60_000 });
    const r3 = (await N.getDataset(request, key, dsId)).body.dataset;
    expect(r3.revision).toBe(3);
    expect(r3.sha256).not.toBe(r2.sha256);
    // it is APPENDED, not put back in place — the order is asserted, never assumed
    expect(await U.rows(page).locator('td.q').allTextContents()).toEqual(['픽셀플러스 종목코드는?', '삼성전자 종목코드는?', '카카오 종목코드는?']);
    const bytes = (await N.signedRaw(request, key, `/api/teach/datasets/${dsId}/download`)).body.toString('utf8');
    expect(bytes.trim().split('\n').at(-1)).toBe('{"prompt":"카카오 종목코드는?","answer":"035720"}');

    // the toast is the only way back: after ~8 s it is gone and the removal stands
    await U.rows(page).nth(2).getByTestId('row-remove').click();
    await expect(page.getByTestId('undo-toast')).toBeVisible();
    await expect(page.getByTestId('undo-toast')).toBeHidden({ timeout: 20_000 });
    await expect(U.rows(page)).toHaveCount(2);
    const r4 = (await N.getDataset(request, key, dsId)).body.dataset;
    expect(r4.rows).toBe(2);
    expect(r4.revision).toBe(4);
    await U.rows(page).nth(1).getByTestId('row-remove').click();
    await expect(page.getByTestId('undo-toast')).toBeVisible();
    await expect(page.getByTestId('add-row'), 'with the toast gone the only way back is "Add a question"').toHaveText('Add a question');
  } finally {
    await context.close();
  }
});

// ------------------------------------------------------------------ AZ-155

test('AZ-155 The last question cannot be removed, and the refusal must be about the removal', async ({ browser, request }) => {
  const { context, page } = await U.visitorContext(browser);
  try {
    const dsId = await U.uploadFixture(page, 'az155-one.jsonl');
    const key = await N.keyOfPage(page);
    trashDataset(key, dsId);
    await expect(U.rows(page)).toHaveCount(1);

    const answer = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().includes(`/api/teach/datasets/${dsId}`));
    await U.rows(page).first().getByTestId('row-remove').click();
    const res = await answer;
    expect(res.status()).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('dataset_empty: a dataset needs at least one question');

    await expect(page.getByTestId('dataset-error')).toBeVisible();
    await expect(U.rows(page)).toHaveCount(1);
    await expect(page.getByTestId('undo-toast')).toHaveCount(0);
    const ds = (await N.getDataset(request, key, dsId)).body.dataset;
    expect(ds.rows).toBe(1);
    expect(ds.revision).toBe(1);

    const en = (await page.getByTestId('dataset-error').textContent())!.trim();

    // the same refusal in Korean (the sentence is produced when the refusal arrives, so it needs its own attempt)
    await U.switchToKorean(page);
    const koAnswer = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().includes(`/api/teach/datasets/${dsId}`));
    await U.rows(page).first().getByTestId('row-remove').click();
    expect((await koAnswer).status()).toBe(400);
    const ko = (await page.getByTestId('dataset-error').textContent())!.trim();
    await expect(U.rows(page)).toHaveCount(1);
    expect((await N.getDataset(request, key, dsId)).body.dataset.revision).toBe(1);

    // ---- the product fix this scenario forces, asserted last: the sentence must describe what the visitor just did
    // (a removal). Today the upload-time copy is reused, which describes a file nobody just uploaded.
    expect(en, 'the removal refusal must not reuse the upload-time copy').not.toBe('That file has no usable questions. Every line needs a question and a right answer.');
    expect(en.toLowerCase()).toMatch(/remov|add another|at least one question/);
    expect(ko).not.toBe('쓸 수 있는 질문이 없습니다. 모든 줄에 질문과 정답이 있어야 합니다.');
  } finally {
    await context.close();
  }
});

// ------------------------------------------------------------------ AZ-156

test('AZ-156 Questions that end the same way get an advisory that never blocks and disappears when it stops being true', async ({ browser, request }) => {
  test.slow();
  const { context, page } = await U.visitorContext(browser);
  let cliDataset: string | null = null;
  try {
    const dsId = await U.uploadFixture(page, 'az156-endings.csv');
    const key = await N.keyOfPage(page);
    trashDataset(key, dsId);

    await expect(U.rows(page)).toHaveCount(4);
    for (const i of [0, 1, 2]) {
      await expect(U.pill(U.rows(page).nth(i)), 'the advisory changes no status').toHaveText('Read OK');
      await expect(U.rows(page).nth(i)).toHaveAttribute('data-bad', '0');
      await expect(U.rows(page).nth(i).getByTestId('advisory')).toHaveCount(1);
    }
    await expect(U.rows(page).nth(3).getByTestId('advisory')).toHaveCount(0);
    await expect(U.counts(page), 'the advisory changes no count').toHaveText('4 will train · 0 already known · 0 duplicates · 0 need a fix');
    const englishAdvisory = (await U.rows(page).nth(0).getByTestId('advisory').textContent())!.trim();

    const rep = await N.getRows(request, key, dsId);
    expect(rep.body.summary.shared_ending).toBe(3);
    expect(rep.body.items.slice(0, 3).map((r) => [r.advisory ?? [], r.detail])).toEqual([
      [['shared_ending'], '3 questions in this dataset end the same way'],
      [['shared_ending'], '3 questions in this dataset end the same way'],
      [['shared_ending'], '3 questions in this dataset end the same way'],
    ]);
    expect(rep.body.items[3].advisory ?? []).toEqual([]);

    // recomputed on every revision: a group of two is not reported
    await U.rows(page).nth(2).getByTestId('row-remove').click();
    await expect(U.rows(page)).toHaveCount(3, { timeout: 60_000 });
    await expect(page.getByTestId('advisory')).toHaveCount(0);
    expect((await N.getRows(request, key, dsId)).body.summary.shared_ending).toBe(0);

    // Korean says the same number as English
    await page.getByTestId('undo').click();
    await expect(U.rows(page)).toHaveCount(4, { timeout: 60_000 });
    await U.switchToKorean(page);
    const koreanAdvisory = (await U.rows(page).nth(0).getByTestId('advisory').textContent())!.trim();
    expect(koreanAdvisory).toMatch(/^다른 \d+개와 끝이 같습니다$/);
    expect(/\d+/.exec(koreanAdvisory)![0], 'the two locales say the same number').toBe(/\d+/.exec(englishAdvisory)![0]);

    // the same heads-up from the terminal
    const cli = await N.cliRun(['teach', 'dataset', join(U.FIXTURES, 'az156-endings.csv')]);
    expect(cli.code, cli.stderr || cli.stdout).toBe(0);
    cliDataset = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(cli.stdout)?.[0] ?? null;
    expect(cliDataset, 'the CLI printed the dataset it created (the test deletes it again)').toBeTruthy();
    expect(cli.stdout).toContain('3 questions end the same way — the model may answer them all alike');

    // ---- the product fix this scenario forces, asserted last so everything else above is verified first:
    // a group of three means each question shares its ending with TWO OTHERS, and the build prints the group size.
    expect(englishAdvisory, 'the advisory counts the OTHER questions that share the ending, not the group').toBe('Ends the same way as 2 others');
    expect(koreanAdvisory).toBe('다른 2개와 끝이 같습니다');
  } finally {
    // the CLI keeps its own teaching key, so its dataset is deleted with that key rather than through the CLI again
    const key = N.cliKey();
    if (cliDataset && key) await N.deleteDataset(request, key, cliDataset);
    await context.close();
  }
});

// ------------------------------------------------------------------ AZ-157

test('AZ-157 The counts pill after a sampled check never claims more than was measured', async ({ browser, request }) => {
  test.slow();
  /*
   * The three sampled batches below cost 9 of the node's 20 free check units an hour, and that bucket is keyed on the
   * CLIENT ADDRESS — every scenario in this suite, and anyone else testing from this box, spends the same 20. A
   * restart is the only way to reset it (`Market.chatUsage` is in memory), so this scenario starts from a known
   * budget exactly as AZ-158 does; without it the third batch answers 429 and the run is refused for reasons that
   * have nothing to do with the counts pill.
   */
  await N.restartNode();
  const { context, page } = await U.visitorContext(browser);
  try {
    expect(await N.waitForStubMode(request), 'this scenario needs node-u on its offline stub (teach.stubOffline) — another session has it pointed at a live model').toBe(true);
    const sent = await U.recordFetchBodies(page);
    // 30 questions; rows 1, 5, 9 and 13 answer themselves, so the offline stub "knows" exactly those four
    const selfAnswering = ['087600', '005930', '035720', '000660'];
    const lines: string[] = [];
    for (let i = 1; i <= 30; i++) {
      const known = [1, 5, 9, 13].indexOf(i);
      lines.push(known >= 0
        ? JSON.stringify({ prompt: `종목코드 ${selfAnswering[known]}은 픽셀플러스${known}인가요?`, answer: `픽셀플러스${known}` })
        // every filler ends differently on purpose: identical endings would raise the shared-ending advisory (AZ-156)
        : JSON.stringify({ prompt: `AZ157 ${TAG} fact ${i}: what is code ${i}?`, answer: `code-${TAG}-${i}` }));
    }
    const dsId = await U.uploadBytes(page, `az157-sample-${TAG}.jsonl`, Buffer.from(lines.join('\n') + '\n', 'utf8'));
    const key = await N.keyOfPage(page);
    trashDataset(key, dsId);
    await expect(U.rows(page)).toHaveCount(30);

    const replies: Promise<{ status: number; body: unknown }>[] = [];
    page.on('response', (r) => {
      if (r.request().method() === 'POST' && r.url().endsWith('/api/teach/preflight')) replies.push(r.json().catch(() => null).then((body) => ({ status: r.status(), body })));
    });
    await U.runCheck(page);
    // the page writes the note as soon as its loop ends; the response events reach the test a moment later
    await expect.poll(() => replies.length, { timeout: 60_000 }).toBe(3);
    const settled = await Promise.all(replies);
    expect(settled.map((r) => r.status), 'all three batches were answered (a 429 here means the node\'s hourly free-check budget was already spent)').toEqual([200, 200, 200]);
    const answers = settled.map((r) => r.body);

    const calls = (await sent()).filter((r) => r.method === 'POST' && r.url.endsWith('/api/teach/preflight'));
    expect(calls.map((c) => JSON.parse(c.body)), 'three calls, at the node\'s own per-call batch size').toEqual([
      { patch_ids: [], dataset_id: dsId, offset: 0, limit: 8 },
      { patch_ids: [], dataset_id: dsId, offset: 8, limit: 8 },
      { patch_ids: [], dataset_id: dsId, offset: 16, limit: 8 },
    ]);
    expect(answers).toHaveLength(3);
    expect((answers.at(-1) as { sampled: unknown }).sampled).toEqual({ checked: 24, of: 30 });

    await expect(page.getByTestId('checked-note')).toHaveText('Simulated check of 24 of 30 questions — not measured in a live model.');
    await expect(U.counts(page)).toHaveText('26 will train · 4 already known · 0 duplicates · 0 need a fix');
    await expect(U.pill(U.rows(page).nth(0))).toHaveText('Already known — skipped');
    await expect(U.pill(U.rows(page).nth(4))).toHaveText('Already known — skipped');
    await expect(U.helpLines(U.rows(page).nth(1))).toHaveText([/^Simulated answer \(no model was asked\): /]);
    // nothing beyond the sampled head is given a verdict
    for (const i of [24, 26, 29]) {
      await expect(U.pill(U.rows(page).nth(i))).toHaveText('Read OK');
      await expect(U.helpLines(U.rows(page).nth(i))).toHaveText(['Not checked yet']);
    }

    // …and with every sampled question known, the pill says 0 will train and the screen says so
    const allKnown = [0, 1, 2].map((i) => JSON.stringify({ prompt: `종목코드 A${TAG}${i}은 픽셀${TAG}${i}인가요?`, answer: `픽셀${TAG}${i}` })).join('\n') + '\n';
    const knownDs = await U.uploadBytes(page, `az157-known-${TAG}.jsonl`, Buffer.from(allKnown, 'utf8'));
    trashDataset(key, knownDs);
    await U.runCheck(page);
    await expect(U.counts(page)).toHaveText('0 will train · 3 already known · 0 duplicates · 0 need a fix');
    // (the warning is a plain box — unlike the error box it carries no role=alert, so it is located by its words)
    await expect(page.getByText('The model already answers all of these correctly, so there is nothing to teach. Add a question it gets wrong.', { exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});

// ------------------------------------------------------------------ AZ-159 (LIVE MODEL)

test('AZ-159 Pre-flight against the live model: the verdict quotes the model\'s own answer, and an unreachable model says so', async ({ browser, request }) => {
  test.setTimeout(20 * 60_000);
  const { context, page } = await U.visitorContext(browser);
  try {
    await N.withLiveModel(async (ctl) => {
      // the node is really asking a model, and it is the dedicated e2e one
      const live = await N.policyOf(request);
      expect(live.simulated_checks, 'GET /api/teach/policy must report the node is not simulating').toBe(false);
      const rt = await N.runtimeInfo(request);
      expect(rt, 'the model server and its patch hook are up').toMatchObject({ available: true, api: N.E2E_MODEL_API, hook: true });

      const dsId = await U.uploadFixture(page, 'az159-live.jsonl');
      const key = await N.keyOfPage(page);
      trashDataset(key, dsId);

      type Pre = { facts: { index: number; status: string; base_answer?: string }[]; trainable: number; sampled: { checked: number; of: number }; quota: { key_remaining: number; ip_remaining: number } };
      const seen: Promise<Pre | null>[] = [];
      page.on('response', (r) => {
        if (r.request().method() === 'POST' && r.url().endsWith('/api/teach/preflight') && r.ok()) seen.push(r.json().catch(() => null) as Promise<Pre | null>);
      });
      await U.runCheck(page);
      await expect.poll(() => seen.length, { timeout: 60_000 }).toBe(1);
      const bodies = (await Promise.all(seen)).filter(Boolean) as Pre[];
      expect(bodies, 'the pre-flight answered').toHaveLength(1);
      const body = bodies[0];
      expect(body.sampled).toEqual({ checked: 3, of: 3 });
      expect(Object.keys(body.quota).sort()).toEqual(['ip_remaining', 'key_remaining']);
      expect(body.facts.map((f) => f.index)).toEqual([0, 1, 2]);

      for (const f of body.facts) {
        expect(['will_train', 'already_known', 'overlaps_listing', 'invalid']).toContain(f.status);
        expect(f.base_answer ?? '', 'a real model answered, not the offline stub').not.toMatch(/^\(stub model\) I do not know:/);
        expect((f.base_answer ?? '').length, 'the model said something').toBeGreaterThan(0);
      }
      // the run-unique row cannot be known
      expect(body.facts[1].status).toBe('will_train');
      await expect(U.questionCell(U.rows(page).nth(1))).toHaveText('AZ-159 테스트 코드는?');

      // LIVE mode: nothing on the screen says "simulated", because nothing was
      await expect(page.getByTestId('checks-simulated')).toHaveCount(0);
      await expect(page.getByTestId('run-check')).toHaveText('Check what the model already knows');
      const known = body.facts.filter((f) => f.status === 'already_known').length;
      const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
      for (const [i, f] of body.facts.entries()) {
        await expect(U.pill(U.rows(page).nth(i))).toHaveText(f.status === 'already_known' ? 'Already known — skipped' : 'Will train');
        // the model's own sentence is quoted verbatim under the pill
        expect(flat((await U.helpLines(U.rows(page).nth(i)).textContent()) ?? '')).toBe(flat(`It answered: ${f.base_answer}`));
      }
      await expect(U.counts(page)).toHaveText(`${3 - known} will train · ${known} already known · 0 duplicates · 0 need a fix`);
      await expect(page.getByTestId('checked-note')).toHaveText(`Checked: ${body.trainable} of 3 are wrong today and will train.`);

      // ---- the model server is not reachable: nobody gets a verdict
      await ctl.pointRuntimeAt('http://localhost:1');
      const down = await N.signed<{ error: string }>(request, key, 'POST', '/api/teach/preflight', { patch_ids: [], dataset_id: dsId, offset: 0, limit: 8 });
      expect(down.status).toBe(503);
      expect(down.body.error).toMatch(/^runtime unavailable: /);

      await page.reload();
      await page.getByTestId('teach-dataset').waitFor();
      await U.runCheck(page);
      await expect(page.getByTestId('dataset-error')).toHaveText('The model server is off or restarting — try again in a minute. Your corrections are kept in this browser.');
      await expect(page.getByTestId('checked-note')).toHaveCount(0);
      for (const i of [0, 1, 2]) await expect(U.helpLines(U.rows(page).nth(i))).toHaveText(['Not checked yet']);
    });

    // ---- back on the stub, the same dataset checks again with stub answers: the MODE is what changed
    expect((await N.policyOf(request)).simulated_checks, 'the node is back on the stub').toBe(true);
    const stubPage = await U.visitorContext(browser);
    try {
      const dsId = await U.uploadFixture(stubPage.page, 'az159-live.jsonl');
      const key = await N.keyOfPage(stubPage.page);
      trashDataset(key, dsId);
      await expect(stubPage.page.getByTestId('checks-simulated')).toBeVisible();
      await U.runCheck(stubPage.page);
      await expect(U.helpLines(U.rows(stubPage.page).nth(1))).toHaveText([/^Simulated answer \(no model was asked\): \(stub model\) I do not know: /]);
    } finally {
      await stubPage.context.close();
    }
  } finally {
    await context.close();
  }
});

// ------------------------------------------------------------------ AZ-160

test('AZ-160 "Already known" from the preview to the settings promise to the result', async ({ browser, request }) => {
  test.slow();
  const { context, page } = await U.visitorContext(browser);
  try {
    expect(await N.waitForStubMode(request), 'this scenario needs node-u on its offline stub (teach.stubOffline) — another session has it pointed at a live model').toBe(true);
    const dsId = await U.uploadFixture(page, 'az160-known.jsonl');
    const key = await N.keyOfPage(page);
    trashDataset(key, dsId);

    await U.runCheck(page);
    await expect(U.counts(page)).toHaveText('2 will train · 1 already known · 0 duplicates · 0 need a fix');
    await expect(U.pill(U.rows(page).nth(0))).toHaveText('Already known — skipped');
    await expect(U.helpLines(U.rows(page).nth(0))).toHaveText(['Simulated answer (no model was asked): 픽셀플러스']);
    const ds = (await N.getDataset(request, key, dsId)).body.dataset;

    // ---- the settings promise
    await page.getByTestId('to-settings').click();
    await page.getByTestId('teach-settings').waitFor();
    await expect(page.getByTestId('settings-dataset')).toHaveText(`Dataset: ${ds.name} · 3 questions · fingerprint ${ds.sha256.slice(0, 12)}`);
    await expect(page.getByTestId('settings-summary')).toHaveText('3 questions · Balanced (recommended) · side-effect check on · this node has not timed a lesson yet');
    await expect(page.getByTestId('train-lesson')).toHaveText('Train this lesson (3 questions)');
    await expect(page.getByTestId('teach-settings'), 'nothing here repeats the preview\'s "already known" figure').not.toContainText('already known');

    // ---- the result must account for the difference
    const jobId = await U.train(page);
    trashJob(key, jobId);
    await expect(page.getByTestId('teach-lesson')).toHaveAttribute('data-status', /READY|NEEDS_MORE|FAILED/, { timeout: 5 * 60_000 });

    // what the lesson recorded, and what the result screen says about it (asserted at the end, so the second half of
    // the scenario is exercised in the same run)
    const job = (await N.getJob(request, key, jobId)).body.job as { preflight?: { checked: number; of: number; known: number }; facts?: unknown[] };
    const skipped = (await page.getByTestId('skipped-known').count())
      ? (await page.getByTestId('skipped-known').textContent())?.trim() : null;
    const taught = (job.facts ?? []).length;

    // ---- a dataset the model already answers in full
    const allKnown = await U.visitorContext(browser);
    let refusal: { status: number; error: string; box: string | null };
    try {
      const kDs = await U.uploadBytes(allKnown.page, `az160-all-known-${TAG}.jsonl`, Buffer.from(
        [0, 1, 2].map((i) => JSON.stringify({ prompt: `종목코드 B${TAG}${i}은 픽셀${TAG}${i}인가요?`, answer: `픽셀${TAG}${i}` })).join('\n') + '\n', 'utf8'));
      const kKey = await N.keyOfPage(allKnown.page);
      trashDataset(kKey, kDs);
      await U.runCheck(allKnown.page);
      await expect(U.counts(allKnown.page)).toHaveText('0 will train · 3 already known · 0 duplicates · 0 need a fix');
      await allKnown.page.getByTestId('to-settings').click();
      await allKnown.page.getByTestId('teach-settings').waitFor();
      const created = allKnown.page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/api/teach/jobs'));
      await allKnown.page.getByTestId('train-lesson').click();
      const res = await created;
      const payload = (await res.json()) as { error?: string; job?: { id: string } };
      if (res.status() === 202 && payload.job) trashJob(kKey, payload.job.id);
      await allKnown.page.waitForTimeout(1000);
      refusal = {
        status: res.status(), error: payload.error ?? '',
        box: (await allKnown.page.getByTestId('settings-error').count()) ? ((await allKnown.page.getByTestId('settings-error').textContent())?.trim() ?? null) : null,
      };
    } finally {
      await allKnown.context.close();
    }

    // ---- the product fix this scenario forces, asserted last.
    // The file door hands the node a `dataset_id` and no `base_answer`s, so job creation never learns what the visitor
    // just measured; and the offline stub's PREFLIGHT stage drops the already-known question without recording it
    // (packages/node/src/teach.ts preflightJob returns early when `offline`). The settings screen therefore promises
    // 3 questions, the lesson teaches 2, and nothing on either screen reconciles the two.
    expect(taught, 'the lesson really did leave the already-known question out').toBe(2);
    expect(job.preflight, 'the lesson has to record what it left out').toBeTruthy();
    expect(job.preflight!.of).toBe(3);
    expect(job.preflight!.known, 'the same question the preview measured as already known').toBe(1);
    expect(skipped).toBe('1 of your 3 questions were left out: the model already answered them correctly, so only the rest were taught.');
    expect(refusal.status, 'a lesson with nothing to teach must be refused').toBe(409);
    expect(refusal.error).toMatch(/^already_known: /);
    expect(refusal.box).toBe('The model already answers this correctly, so there is nothing to train.');
  } finally {
    await context.close();
  }
});

// ------------------------------------------------------------------ AZ-161

test('AZ-161 Taking it home: the dataset download is the fingerprinted file, and the per-line report is read through the API/CLI', async ({ browser, request }) => {
  const { context, page } = await U.visitorContext(browser);
  try {
    const dsId = await U.uploadFixture(page, 'az161-mix.jsonl');
    const key = await N.keyOfPage(page);
    trashDataset(key, dsId);
    const ds = (await N.getDataset(request, key, dsId)).body.dataset;
    expect(ds.revision).toBe(1);
    await expect(page.getByTestId('teach-dataset')).toContainText(`Fingerprint ${ds.sha256.slice(0, 12)}`);

    // the click is a SIGNED request, and it saves the file the node named
    const signedReq = page.waitForRequest((r) => r.url().includes(`/api/teach/datasets/${dsId}/download`));
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('download-dataset').click()]);
    expect((await signedReq).headers()['x-ngram-auth'], 'the download carries a teaching-key signature').toMatch(/^0x[0-9a-fA-F]{40}:\d+:0x[0-9a-f]+(:v2)?$/);
    expect(dl.suggestedFilename()).toBe(`dataset-${dsId}-r1.jsonl`);
    const saved = readFileSync((await dl.path())!);

    // the canonical bytes: key order, LF, no BOM, exactly one trailing LF, and the sha256 the header names
    const raw = await N.signedRaw(request, key, `/api/teach/datasets/${dsId}/download`);
    expect(raw.status).toBe(200);
    expect(raw.headers['content-type']).toBe('application/x-ndjson; charset=utf-8');
    expect(raw.headers['content-disposition']).toBe(`attachment; filename="dataset-${dsId}-r1.jsonl"`);
    expect(raw.body.equals(saved), 'the saved file is what the node served').toBe(true);
    expect(raw.body.toString('utf8')).toBe([
      '{"prompt":"Who founded Ainize?","answer":"Comcom","alt_prompt":"Which company is behind Ainize?"}',
      '{"prompt":"When did Ainize start?","answer":"2020"}',
    ].join('\n') + '\n');
    expect(raw.body.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), 'no BOM').toBe(false);
    expect(raw.body.includes(Buffer.from('\r'))).toBe(false);
    expect(raw.body.at(-1)).toBe(0x0a);
    expect(raw.body.at(-2)).not.toBe(0x0a);
    expect(sha256(raw.body)).toBe(raw.headers['x-content-sha256']);
    expect(raw.headers['x-content-sha256']).toBe(ds.sha256);

    // csv is a rendering of the same questions, not the fingerprint subject
    const csv = await N.signedRaw(request, key, `/api/teach/datasets/${dsId}/download?format=csv`);
    expect(csv.status).toBe(200);
    expect(csv.headers['x-content-sha256']).toBe(ds.sha256);
    expect(csv.body.toString('utf8')).toBe([
      'prompt,answer,alt_prompt,note',
      'Who founded Ainize?,Comcom,Which company is behind Ainize?,',
      'When did Ainize start?,2020,,',
    ].join('\n') + '\n');
    expect(sha256(csv.body)).not.toBe(ds.sha256);

    // re-uploading the downloaded bytes lands on the SAME dataset — no second copy, no dataset quota spent
    // `uploadBytes` paces itself against the node's per-address minute and waits 20 s out when someone else has
    // spent it, so this wait has to outlive the helper rather than the default 30 s
    const answer = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/api/teach/datasets'), { timeout: 4 * 60_000 });
    const again = await U.uploadBytes(page, `dataset-${dsId}-r1.jsonl`, raw.body);
    const res = await answer;
    expect(res.status()).toBe(200);
    expect((await res.json()) as { created: boolean }).toMatchObject({ created: false });
    expect(again).toBe(dsId);

    // the only download control on this screen is the dataset itself — report.json is an API/CLI read (AZ-216 / AZ-211)
    const downloadish = page.getByRole('button').filter({ hasText: /download|내려받기/i });
    await expect(downloadish).toHaveCount(1);
    await expect(downloadish).toHaveText('Download this dataset (.jsonl)');
    await expect(page.getByRole('link').filter({ hasText: /download|report\.json/i })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

// ------------------------------------------------------------------ AZ-162

test('AZ-162 Three effort cards, no numbers: pick how hard it should try', async ({ browser, request }) => {
  test.slow();
  const { context, page } = await U.visitorContext(browser);
  try {
    const body = Buffer.from([
      JSON.stringify({ prompt: `AZ162 ${TAG} 사내 와이파이 비밀번호는?`, answer: `pw-${TAG}-01`, alt_prompt: `AZ162 ${TAG} 와이파이 암호 알려줘` }),
      JSON.stringify({ prompt: `AZ162 ${TAG} 본사 우편번호는?`, answer: '06236' }),
      JSON.stringify({ prompt: `AZ162 ${TAG} What is the support email?`, answer: `help-${TAG}@example.com` }),
    ].join('\n') + '\n', 'utf8');
    const dsId = await U.uploadBytes(page, `az162-${TAG}.jsonl`, body);
    const key = await N.keyOfPage(page);
    trashDataset(key, dsId);

    await page.getByTestId('to-settings').click();
    await page.getByTestId('teach-settings').waitFor();

    const cards = page.getByTestId('effort-cards');
    await expect(cards).toHaveAttribute('role', 'radiogroup');
    await expect(cards).toHaveAttribute('aria-label', 'How hard should it try?');
    await expect(cards.locator('input[type=radio][name=effort]')).toHaveCount(3);
    await expect(page.getByTestId('effort-balanced').locator('input')).toBeChecked();
    await expect(page.getByTestId('effort-quick').locator('input')).not.toBeChecked();
    await expect(page.getByTestId('effort-thorough').locator('input')).not.toBeChecked();

    const texts: [string, string, string][] = [
      ['quick', 'Quick', 'A few passes over your questions. Good for one or two easy facts.'],
      ['balanced', 'Balanced (recommended)', 'Keeps going until the model answers your questions, up to a sensible limit.'],
      ['thorough', 'Thorough', 'Tries the longest. Use it for numbers, codes and facts that keep slipping.'],
    ];
    for (const [id, label, copy] of texts) {
      const card = page.getByTestId(`effort-${id}`);
      await expect(card.locator('b')).toHaveText(label);
      await expect(card.locator('span.body')).toHaveText(copy);
      await expect(page.getByTestId(`effort-time-${id}`)).toHaveText('this node has not timed a lesson yet');
      expect((await card.textContent()) ?? '', 'no card shows a step, epoch or pass count').not.toMatch(/\d/);
    }

    // Finding 49 — this scenario never runs the live check, so every count here is a ceiling
    await expect(page.getByTestId('settings-summary')).toHaveText('up to 3 questions · Balanced (recommended) · side-effect check on · this node has not timed a lesson yet');
    await page.getByTestId('effort-thorough').locator('input').check();
    await expect(page.getByTestId('settings-summary')).toHaveText('up to 3 questions · Thorough · side-effect check on · this node has not timed a lesson yet');
    await page.getByTestId('effort-balanced').locator('input').check();
    await expect(page.getByTestId('settings-summary')).toHaveText('up to 3 questions · Balanced (recommended) · side-effect check on · this node has not timed a lesson yet');

    await expect(page.getByTestId('train-lesson')).toHaveText('Train this lesson (up to 3 questions)');
    const jobId = await U.train(page);
    trashJob(key, jobId);

    const job = (await N.getJob(request, key, jobId)).body.job as { training: Record<string, unknown> };
    expect(job.training).toEqual({
      effort: 'balanced', max_steps: 20, eval_every: 2, lr: 0.002,
      check_side_effects: true, use_alt: true, selected_indexes: [0, 1, 2],
    });
  } finally {
    await context.close();
  }
});

// ------------------------------------------------------------------ AZ-158 (runs LAST: it exhausts an hourly bucket)

test('AZ-158 The free checks run out halfway: what was measured is kept and the visitor is told the rest still trains', async ({ browser, request }) => {
  test.setTimeout(15 * 60_000);
  /*
   * The node's free live-test budget is 20 units an hour, charged to the CLIENT ADDRESS and to the teaching key
   * (packages/node/src/api.ts preflight), and it lives in memory (`Market.chatUsage`). Restarting node-u first makes
   * the drain below start from a known 20 whatever the earlier scenarios spent; restarting it again at the end gives
   * the rest of the hour back to everyone else on this address instead of leaving it poisoned.
   */
  await N.restartNode();
  const { context, page } = await U.visitorContext(browser);
  try {
    expect(await N.waitForStubMode(request), 'this scenario needs node-u on its offline stub (teach.stubOffline) — another session has it pointed at a live model').toBe(true);
    // every question ends differently: identical endings would add the shared-ending advisory line (AZ-156)
    const body = Buffer.from(Array.from({ length: 24 }, (_, i) =>
      JSON.stringify({ prompt: `AZ158 ${TAG} question ${i + 1}: what is code ${i + 1}?`, answer: `code-${TAG}-${i + 1}` })).join('\n') + '\n', 'utf8');
    const dsId = await U.uploadBytes(page, `az158-quota-${TAG}.jsonl`, body);
    const key = await N.keyOfPage(page);
    trashDataset(key, dsId);

    // A pre-flight costs one unit per three model calls, so one 8-question batch costs 3. Leave exactly 3 of the 20:
    // the first batch lands, the second cannot.
    for (let i = 0; i < 17; i++) {
      const r = await N.signed<{ trainable: number }>(request, key, 'POST', '/api/teach/preflight', {
        patch_ids: [], facts: [{ prompt: `AZ158 filler ${TAG} ${i}?`, answer: 'x' }],
      });
      expect(r.status, `filler pre-flight ${i} (${r.text.slice(0, 160)})`).toBe(200);
    }

    const answers: number[] = [];
    page.on('response', (r) => { if (r.request().method() === 'POST' && r.url().endsWith('/api/teach/preflight')) answers.push(r.status()); });
    await U.runCheck(page);
    await expect.poll(() => answers.length, { timeout: 60_000 }).toBe(2);
    expect(answers, 'the first batch lands, the second runs out').toEqual([200, 429]);

    // a partial check is a NOTE, not a red box: the 8 measured answers stay on screen
    await expect(page.getByTestId('dataset-error')).toHaveCount(0);
    await expect(page.getByTestId('checked-note')).toHaveText('Simulated check of 8 questions, then this hour’s free checks ran out. Nothing was measured in a live model; the rest still train.');
    for (let i = 0; i < 8; i++) {
      await expect(U.pill(U.rows(page).nth(i))).toHaveText('Will train');
      await expect(U.helpLines(U.rows(page).nth(i))).toHaveText([/^Simulated answer \(no model was asked\): \(stub model\) I do not know: /]);
    }
    for (const i of [8, 15, 23]) await expect(U.helpLines(U.rows(page).nth(i))).toHaveText(['Not checked yet']);
    await expect(U.counts(page), 'only what was measured counts as known').toHaveText('24 will train · 0 already known · 0 duplicates · 0 need a fix');
    await expect(page.getByTestId('to-settings'), 'a spent check never blocks training').toBeEnabled();

    // the message the node sends when the budget is gone names what the call needed
    const spent = await N.signed<{ error: string }>(request, key, 'POST', '/api/teach/preflight', { patch_ids: [], dataset_id: dsId, offset: 0, limit: 8 });
    expect(spent.status).toBe(429);
    // NOTE the scenario says "needs 1 unit(s)"; an 8-question batch is 3 units (one per three model calls, teach.ts
    // PREFLIGHT_CALLS_PER_UNIT), and the node says so.
    expect(spent.body.error).toBe('quota_chat: free live-test quota exhausted for this hour (this pre-flight needs 3 unit(s)) — try again later');

    // ---- with nothing measured at all it IS a red box, and no row gets a verdict
    const fresh = await U.visitorContext(browser);
    try {
      // a different browser, so a fresh teaching key — but the same client address, whose hour is now spent
      const other = await U.uploadBytes(fresh.page, `az158-quota-${TAG}.jsonl`, body);
      const otherKey = await N.keyOfPage(fresh.page);
      trashDataset(otherKey, other);
      await U.runCheck(fresh.page);
      await expect(fresh.page.getByTestId('dataset-error')).toHaveText('You used this hour’s free checks. You can check again in an hour — or just train: the check only tells you what the model already knows.');
      await expect(fresh.page.getByTestId('checked-note')).toHaveCount(0);
      for (const i of [0, 5, 23]) await expect(U.helpLines(U.rows(fresh.page).nth(i))).toHaveText(['Not checked yet']);
      await expect(fresh.page.getByTestId('to-settings')).toBeEnabled();
    } finally {
      await fresh.context.close();
    }
  } finally {
    await context.close();
    await N.restartNode();       // give the hour back
  }
});
