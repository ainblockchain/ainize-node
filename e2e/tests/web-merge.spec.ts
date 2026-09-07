/**
 * Lineage L7 — combining two knowledges, in the browser and from a terminal, against the teach dev node :3422
 * (docs/ux-test-scenarios.json AZ-308 … AZ-310; docs/lineage-teach-design.md §4 SC-14, §9, §13).
 *
 *   AINIZE_URL=http://localhost:3422 AINIZE_PASS=teachable-pass npx playwright test tests/web-merge.spec.ts --project=web
 *
 * The node runs its stub backend, so nothing here is a training result. What IS real: the merged file is the row
 * union of its two parents, written by the node with no GPU, and every refusal is decided from numbers the node
 * measured on the two files.
 */
import { test, expect, request as apiRequest, type APIRequestContext } from '@playwright/test';
import { signMessage } from '@ainize/core';
import { runCli } from '../helpers/operator-cli';
import {
  NODE, cleanupAll, createDataset, createJob, newKey, operatorToken, patchPolicy, policy, seedBrowserKey, tag,
  teachApi, waitForTerminal, type TeachKey,
} from '../helpers/ds-train-api';

test.describe.configure({ mode: 'serial', retries: 0 });

const TAG = tag();
let api: APIRequestContext;
let opToken = '';
let shipped: Record<string, number> = {};
const author: TeachKey = newKey();     // publishes the base
const rival: TeachKey = newKey();      // publishes something built on it that changes one answer
const merger: TeachKey = newKey();     // combines them
let BASE = ''; let CHILD = ''; let OTHER = '';
const BASE_NAME = `Merge base ${TAG}`;
const CHILD_NAME = `Merge rival ${TAG}`;
const OTHER_NAME = `Merge other ${TAG}`;
const cli = (args: string[]) => runCli(args, { node: NODE, timeoutMs: 120_000 });

interface Preview {
  a: { id: string; name: string }; b: { id: string; name: string };
  questions: { a_only: number; b_only: number; same: number; conflicts: { key: string; prompt: string; a_answer: string; b_answer: string }[] } | null;
  rows: { a_only: number; b_only: number; shared: number; disagree: number; opposing: number };
  merged: { rows: number; from_a: number; from_b: number; targets: number } | null;
  tiers: { union: { allowed: boolean; reason?: string }; retrain: { allowed: boolean; reason?: string; est_min: number | null }; rebuild: { allowed: boolean; est_min: number | null }; required: string | null; disagree_ratio: number };
}

async function publish(key: TeachKey, name: string, rows: { prompt: string; answer: string }[], opts: { baseIds?: string[]; confirm?: boolean } = {}): Promise<string> {
  const ds = await createDataset(api, key, rows, name);
  const created = await createJob(api, key, {
    patch_ids: [], builds_on_context: false, dataset_id: ds.id, name,
    ...(opts.baseIds?.length ? { base_ids: opts.baseIds } : {}), ...(opts.confirm ? { confirm_conflicts: true } : {}),
  });
  expect(created.status, JSON.stringify(created.body)).toBe(202);
  const job = await waitForTerminal(api, key, created.body.job.id);
  expect(job.status, `${name} ended ${job.status}`).toBe('READY');
  const ch = await teachApi<{ claim: string }>(api, key, 'GET', `/api/teach/jobs/${job.id}/publish-challenge`);
  const pub = await teachApi<{ patch_id: string }>(api, key, 'POST', `/api/teach/jobs/${job.id}/publish`, {
    name, price: '1', license: 'CC-BY-4.0', claim_sig: signMessage(ch.body.claim, key.privateKey),
    consent: { permanent: true, rights: true }, dataset: { access: 'derivative', license: 'CC-BY-4.0' },
  });
  expect(pub.status, JSON.stringify(pub.body)).toBe(200);
  return pub.body.patch_id;
}

test.beforeAll(async () => {
  api = await apiRequest.newContext();
  const p = await policy(api);
  expect(p.enabled, 'node-u must accept lessons').toBe(true);
  expect(p.lineage, 'node-u must have teach.lineage on').toBe(true);
  opToken = await operatorToken(api);
  const before = await api.get(`${NODE}/api/me/teach/policy`, { headers: { authorization: `Bearer ${opToken}` } });
  const eff = ((await before.json()) as { effective: Record<string, number> }).effective;
  shipped = { jobs_per_key_per_day: eff.jobsPerKeyPerDay, jobs_per_ip_per_day: eff.jobsPerIpPerDay };
  await patchPolicy(api, opToken, { jobs_per_key_per_day: 1000, jobs_per_ip_per_day: 1000, rows_per_key_per_day: 100_000, rows_per_ip_per_day: 100_000 });

  BASE = await publish(author, BASE_NAME, [
    { prompt: `${TAG} 픽셀플러스의 종목코드는?`, answer: `087-${TAG}` },
    { prompt: `${TAG} 픽셀플러스는 어느 시장에 상장되어 있습니까?`, answer: `코스닥-${TAG}` },
  ]);
  // built ON the base, and it changes one of its answers: the two disagree about a question AND about the rows
  CHILD = await publish(rival, CHILD_NAME, [
    { prompt: `${TAG} 픽셀플러스는 어느 시장에 상장되어 있습니까?`, answer: `유가증권-${TAG}` },
    { prompt: `${TAG} 픽셀플러스의 대표이사는?`, answer: `이서규-${TAG}` },
  ], { baseIds: [BASE], confirm: true });
  // an unrelated knowledge: nothing in common with the base, at either level
  OTHER = await publish(rival, OTHER_NAME, [
    { prompt: `${TAG} 서울의 인구는?`, answer: `940만-${TAG}` },
    { prompt: `${TAG} 한강의 길이는?`, answer: `494km-${TAG}` },
  ]);
});

test.afterAll(async () => {
  await cleanupAll(api).catch(() => []);
  if (Object.keys(shipped).length) await patchPolicy(api, opToken, shipped).catch(() => 0);
  await api.dispose();
});

test('AZ-308 two knowledges with nothing in common are combined in the browser, with no training, and the result names both creators', async ({ page, context }) => {
  await seedBrowserKey(context, merger);
  await page.goto(`${NODE}/teach/merge?a=${encodeURIComponent(BASE)}&b=${encodeURIComponent(OTHER)}`);

  // SC-14 — the overlap, both levels, measured
  await expect(page.getByRole('heading', { name: `Combine ${BASE_NAME} + ${OTHER_NAME}` })).toBeVisible();
  await expect(page.getByText(/Questions: 2 only in /)).toBeVisible();
  await expect(page.getByText(/0 written by both \(0 disagree\)/)).toBeVisible();
  // …no conflicts, so "just combine" is the choice, and the screen says what it will never do instead
  await expect(page.getByText('Just combine — no training (only when rows do not disagree)')).toBeVisible();
  await expect(page.getByText(/never blended or added/)).toBeVisible();
  // both creators paid, before anything is built — and, because a combine writes a stand-alone file, the truth
  // about what a buyer needs to load, which is neither of them
  await expect(page.getByText(/share 30% equally\. The combined knowledge stands on its own/)).toBeVisible();

  await page.getByRole('button', { name: 'Build it' }).click();
  await page.waitForURL(/\/teach\/lesson\/[0-9a-f-]{36}/, { timeout: 60_000 });
  const jobId = page.url().split('/').pop()!;
  const job = await waitForTerminal(api, merger, jobId);
  expect(job.status, `the combine ended ${job.status}`).toBe('READY');
  const view = job as unknown as { mode: string; merge: { tier: string }; bases: { patch_id: string }[]; facts: unknown[]; result: { rows: number } };
  expect(view.mode).toBe('merge');
  expect(view.merge.tier).toBe('union');
  expect(view.bases.map((b) => b.patch_id)).toEqual([BASE, OTHER]);
  expect(view.facts.length, 'the combined knowledge answers every question of both').toBe(4);

  // the file is the union of the two bodies — a real measurement, and the only one this node can make without a model
  const detail = async (id: string) => (await (await api.get(`${NODE}/api/patches/${encodeURIComponent(id)}`)).json()) as { anchor: { rows: number } };
  const [a, b] = [await detail(BASE), await detail(OTHER)];
  expect(view.result.rows).toBe(a.anchor.rows + b.anchor.rows);
});

test('AZ-311 the merge screen is reachable from the knowledge it starts with, with that knowledge already chosen', async ({ page, context }) => {
  await seedBrowserKey(context, merger);
  const node = await (await api.get(`${NODE}/api/info`)).json() as { address: string };
  await page.goto(`${NODE}/${node.address}/${encodeURIComponent(BASE)}?tab=tree`);
  const link = page.getByTestId('tree-merge');
  await expect(link).toBeVisible();
  await expect(link).toHaveText('Combine with another');
  await link.click();
  await page.waitForURL(/\/teach\/merge\?a=/);
  // one id in the URL: it is kept, and only the other knowledge is asked for
  await expect(page.getByLabel('First knowledge')).toHaveValue(BASE);
});

test('AZ-309 a knowledge and something built on top of it: the screen shows both answers, refuses to just combine, and asks for a rebuild', async ({ page, context }) => {
  const pv = await teachApi<Preview>(api, merger, 'POST', '/api/teach/merge/preview', { a: BASE, b: CHILD });
  expect(pv.status, JSON.stringify(pv.body)).toBe(200);
  expect(pv.body.questions!.conflicts.length, 'they answer one question differently').toBe(1);
  expect(pv.body.rows.shared, 'the child was trained on top of the base, so it writes the base’s rows').toBeGreaterThan(0);
  expect(pv.body.rows.disagree).toBe(pv.body.rows.shared);
  expect(pv.body.tiers.required).toBe('rebuild');

  await seedBrowserKey(context, merger);
  await page.goto(`${NODE}/teach/merge?a=${encodeURIComponent(BASE)}&b=${encodeURIComponent(CHILD)}`);
  // the disagreement, in the creator's own words, both sides named
  await expect(page.getByText(`${TAG} 픽셀플러스는 어느 시장에 상장되어 있습니까?`)).toBeVisible();
  await expect(page.getByText(new RegExp(`${BASE_NAME} says: 코스닥-${TAG}`))).toBeVisible();
  await expect(page.getByText(new RegExp(`${CHILD_NAME} says: 유가증권-${TAG}`))).toBeVisible();
  // …the build cannot start until it is answered
  await expect(page.getByText('1 questions still need a choice')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Build it' })).toBeDisabled();
  // …and the tier is not the creator's to choose here: the rows say rebuild
  await expect(page.getByText(/% of the shared rows disagree/)).toBeVisible();
  await expect(page.getByText('Not available:', { exact: false }).first()).toBeVisible();

  await page.getByRole('button', { name: `Keep ${BASE_NAME}’s` }).click();
  await expect(page.getByRole('button', { name: 'Build it' })).toBeEnabled();

  // the node refuses the tier the rows forbid, whatever the screen sends
  const refused = await createJob(api, merger, {
    patch_ids: [], builds_on_context: false, base_ids: [BASE, CHILD], mode: 'merge', tier: 'retrain',
    resolutions: { [pv.body.questions!.conflicts[0].key]: 'a' },
  });
  expect(refused.status, JSON.stringify(refused.body)).toBe(400);
  expect(String((refused.body as unknown as { error: string }).error)).toMatch(/^tier_not_allowed:/);
});

test('AZ-310 the same merge from a terminal: measured first, and unresolved questions come back as JSON with exit 3', async () => {
  const preview = await cli(['patch', 'merge', BASE, CHILD, '--preview']);
  expect(preview.code, preview.stderr).toBe(0);
  expect(preview.stdout).toContain('same question, different answer');
  expect(preview.stdout).toContain('rebuild everything from the combined questions');
  expect(preview.stdout).toContain('← required');
  expect(preview.stdout).toContain(`${BASE_NAME}: 코스닥-${TAG}`);

  // no answers chosen → the questions themselves are printed, as the file `--resolve` reads back
  const blocked = await cli(['patch', 'merge', BASE, CHILD]);
  expect(blocked.code, blocked.stdout + blocked.stderr).toBe(3);
  const asked = JSON.parse(blocked.stdout.slice(blocked.stdout.indexOf('{'), blocked.stdout.lastIndexOf('}') + 1)) as Record<string, { prompt: string; choose: string }>;
  expect(Object.keys(asked).length).toBe(1);
  expect(Object.values(asked)[0].choose).toContain('drop');
});
