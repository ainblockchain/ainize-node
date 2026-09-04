/**
 * Lineage L4 in the browser — "what is this lesson built on?" in both doors (docs/ux-test-scenarios.json AZ-282,
 * AZ-283; docs/lineage-teach-design.md §4 SC-1, SC-3, SC-4, SC-5, SC-16), against the teach dev node :3422.
 *
 *   AINIZE_URL=http://localhost:3422 AINIZE_PASS=teachable-pass npx playwright test tests/web-lineage.spec.ts --project=web
 *
 * The node runs its shipped stub backend: nothing here measures a model, and nothing needs to — what is asserted is
 * that the creator can SEE and CHOOSE the knowledge they build on, and see whose each question is afterwards.
 */
import { test, expect, request as apiRequest, type APIRequestContext } from '@playwright/test';
import { signMessage } from '@ngram/core';
import {
  NODE, cleanupAll, createDataset, createJob, newKey, operatorToken, patchPolicy, policy, seedBrowserKey, sleep,
  tag, teachApi, trackDataset, waitForTerminal, type TeachKey,
} from '../helpers/ds-train-api';

test.describe.configure({ mode: 'serial', retries: 0 });

const TAG = tag();
let api: APIRequestContext;
let opToken = '';
let shipped: Record<string, number> = {};
/** The published base every scenario builds on: three questions, training set shared with derivative creators. */
let BASE = { id: '', name: `Lineage base ${TAG}`, rows: 3 };
const baseAuthor: TeachKey = newKey();

const baseRows = () => [
  { prompt: `${TAG} 픽셀플러스의 종목코드는?`, answer: `087-${TAG}` },
  { prompt: `${TAG} 픽셀플러스는 어느 시장에 상장되어 있습니까?`, answer: `코스닥-${TAG}` },
  { prompt: `${TAG} 픽셀플러스의 주력 제품은?`, answer: `CIS-${TAG}` },
];

test.beforeAll(async () => {
  api = await apiRequest.newContext();
  const p = await policy(api);
  expect(p.enabled, 'node-u must accept lessons').toBe(true);
  opToken = await operatorToken(api);
  const before = await api.get(`${NODE}/api/me/teach/policy`, { headers: { authorization: `Bearer ${opToken}` } });
  const eff = ((await before.json()) as { effective: Record<string, number> }).effective;
  shipped = { jobs_per_key_per_day: eff.jobsPerKeyPerDay, jobs_per_ip_per_day: eff.jobsPerIpPerDay };
  await patchPolicy(api, opToken, { jobs_per_key_per_day: 1000, jobs_per_ip_per_day: 1000, rows_per_key_per_day: 100_000, rows_per_ip_per_day: 100_000 });

  // a published knowledge with a shareable training set — everything below builds on THIS
  const ds = await createDataset(api, baseAuthor, baseRows(), BASE.name);
  const created = await createJob(api, baseAuthor, { patch_ids: [], builds_on_context: false, dataset_id: ds.id, name: BASE.name });
  expect(created.status, JSON.stringify(created.body)).toBe(202);
  const job = await waitForTerminal(api, baseAuthor, created.body.job.id);
  expect(job.status, `base lesson ended ${job.status}`).toBe('READY');
  const ch = await teachApi<{ claim: string }>(api, baseAuthor, 'GET', `/api/teach/jobs/${job.id}/publish-challenge`);
  expect(ch.status).toBe(200);
  const pub = await teachApi<{ patch_id: string }>(api, baseAuthor, 'POST', `/api/teach/jobs/${job.id}/publish`, {
    name: BASE.name, price: '1', license: 'CC-BY-4.0', claim_sig: signMessage(ch.body.claim, baseAuthor.privateKey),
    consent: { permanent: true, rights: true }, dataset: { access: 'derivative', license: 'CC-BY-4.0' },
  });
  expect(pub.status, JSON.stringify(pub.body)).toBe(200);
  BASE = { ...BASE, id: pub.body.patch_id };
});

test.afterAll(async () => {
  await cleanupAll(api).catch(() => []);
  if (Object.keys(shipped).length) await patchPolicy(api, opToken, shipped).catch(() => 0);
  await api.dispose();
});

test('AZ-282 the chat door names the knowledge this lesson is built on, its three consequences, and what is only loaded beside it', async ({ page, context }) => {
  const visitor = newKey();
  await seedBrowserKey(context, visitor);
  await page.goto(`${NODE}/chat/${BASE.id}?teach=1`);

  const row = page.getByTestId('basket-base');
  await expect(row).toBeVisible();
  // SC-1: the loaded knowledge is the base by default, named, not implied
  await expect(row).toContainText(BASE.name);
  // …with all three consequences on the spot
  const why = page.getByTestId('basket-base-why');
  await expect(why).toContainText('creators receive');
  await expect(why).toContainText('every sale');
  await expect(why).toContainText('first');
  // …and what it inherits from it
  await expect(page.getByTestId('basket-base-inherits')).toContainText(String(BASE.rows));
  // the v1 checkbox is gone where lineage is on: nothing is recorded as a parent by being loaded
  await expect(page.getByText('This builds on the knowledge I have loaded')).toHaveCount(0);

  // SC-3: the picker offers the loaded stack, and "nothing" is an explicit choice
  await page.getByTestId('basket-base-change').click();
  const sheet = page.getByTestId('base-picker');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId('base-option').filter({ hasText: BASE.name })).toHaveCount(1);
  await sheet.getByTestId('base-none').getByRole('button').click();
  await expect(page.getByTestId('basket-base')).toContainText('teaching the plain model');
});

test('AZ-283 the dataset door starts from a knowledge’s questions: the copy is merged, every row says whose it is, and the lesson records the base', async ({ page, context, request }) => {
  const visitor = newKey();
  await seedBrowserKey(context, visitor);
  const mine = [
    { prompt: `${TAG} 픽셀플러스의 대표이사는?`, answer: `이서규-${TAG}` },
    { prompt: `${TAG} 픽셀플러스의 본사는 어디입니까?`, answer: `성남-${TAG}` },
  ];
  const ds = await createDataset(api, visitor, mine, `My additions ${TAG}`);

  // SC-4 — Start from: choose the base, then copy its questions into my own table
  await page.goto(`${NODE}/teach/dataset/${ds.id}/settings`);
  await expect(page.getByTestId('start-from')).toBeVisible();
  await page.getByTestId('pick-base').click();
  await page.getByTestId('base-picker').getByTestId('base-option').filter({ hasText: BASE.name }).getByTestId('base-use').click();
  await expect(page.getByTestId('base-consequences')).toContainText(BASE.name);
  await page.getByTestId('inherit-rows').click();

  // …which lands on the merged preview (SC-5): three of theirs, two of mine, each row saying which
  await page.waitForURL(/\/teach\/dataset\/[0-9a-f-]{36}\?on=/);
  const copiedId = new URL(page.url()).pathname.split('/').pop()!;
  trackDataset(copiedId, visitor);
  await expect(page.getByTestId('inherit-summary')).toContainText('keeps 3');
  await expect(page.getByTestId('row-from')).toHaveCount(3);
  await expect(page.getByTestId('origin-mine')).toContainText('Mine (2)');
  await expect(page.getByTestId('origin-inherited')).toContainText('Inherited (3)');
  await page.getByTestId('origin-inherited').click();
  await expect(page.getByTestId('dataset-row')).toHaveCount(3);

  // SC-16 — My datasets says the copy is a copy
  await page.goto(`${NODE}/teach/mine`);
  await expect(page.getByTestId('ds-copied-from').first()).toContainText(BASE.id);

  // and training it on top records the base, keeps its questions, and adds only mine
  const created = await createJob(api, visitor, { patch_ids: [], builds_on_context: false, dataset_id: copiedId, base_ids: [BASE.id], name: `On top ${TAG}` } as never);
  expect(created.status, JSON.stringify(created.body)).toBe(202);
  const job = await waitForTerminal(api, visitor, created.body.job.id);
  expect(job.status).toBe('READY');
  const view = job as unknown as { bases?: { patch_id: string }[]; inherited_rows?: number; facts: unknown[] };
  expect(view.bases?.map((b) => b.patch_id)).toEqual([BASE.id]);
  expect(view.inherited_rows).toBe(3);
  expect(view.facts.length).toBe(2);
  await sleep(50);
});
