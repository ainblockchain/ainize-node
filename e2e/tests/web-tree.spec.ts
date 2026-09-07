/**
 * Lineage L6 in the browser — the family tree, the training-set block, the "doing well" strip, the open questions
 * and the Explore shelves (docs/ux-test-scenarios.json AZ-290 … AZ-292; docs/lineage-teach-design.md §4 SC-9 … SC-12,
 * SC-17), against the teach dev node :3422.
 *
 *   AINIZE_URL=http://localhost:3422 AINIZE_PASS=teachable-pass npx playwright test tests/web-tree.spec.ts --project=web
 *
 * The node runs its stub backend: no model is asked anything, and nothing here is a measurement. What is asserted is
 * that a creator standing in front of someone else's knowledge can SEE the family, what each member added, whose
 * questions those are, and what people asked that it could not answer.
 */
import { test, expect, request as apiRequest, type APIRequestContext } from '@playwright/test';
import { signMessage } from '@ainize/core';
import {
  NODE, cleanupAll, createDataset, createJob, newKey, operatorToken, patchPolicy, policy, seedBrowserKey,
  tag, teachApi, waitForTerminal, type TeachKey,
} from '../helpers/ds-train-api';

test.describe.configure({ mode: 'serial', retries: 0 });

const TAG = tag();
let api: APIRequestContext;
let opToken = '';
let shipped: Record<string, number> = {};
const author: TeachKey = newKey();
const builder: TeachKey = newKey();
let BASE = { id: '', name: `Tree base ${TAG}`, rows: 3 };
let CHILD = { id: '', name: `Tree add-on ${TAG}`, rows: 2 };

/** Publish one lesson and return its knowledge id — the only way to get a real anchor onto the node. */
async function publish(key: TeachKey, name: string, rows: { prompt: string; answer: string }[], baseIds: string[] = []): Promise<string> {
  const ds = await createDataset(api, key, rows, name);
  const created = await createJob(api, key, { patch_ids: [], builds_on_context: false, dataset_id: ds.id, name, ...(baseIds.length ? { base_ids: baseIds } : {}) });
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
  expect(p.lineage, 'node-u must have teach.lineage on for the creator affordances').toBe(true);
  opToken = await operatorToken(api);
  const before = await api.get(`${NODE}/api/me/teach/policy`, { headers: { authorization: `Bearer ${opToken}` } });
  const eff = ((await before.json()) as { effective: Record<string, number> }).effective;
  shipped = { jobs_per_key_per_day: eff.jobsPerKeyPerDay, jobs_per_ip_per_day: eff.jobsPerIpPerDay };
  await patchPolicy(api, opToken, { jobs_per_key_per_day: 1000, jobs_per_ip_per_day: 1000, rows_per_key_per_day: 100_000, rows_per_ip_per_day: 100_000 });

  BASE = { ...BASE, id: await publish(author, BASE.name, [
    { prompt: `${TAG} 픽셀플러스의 종목코드는?`, answer: `087-${TAG}` },
    { prompt: `${TAG} 픽셀플러스는 어느 시장에 상장되어 있습니까?`, answer: `코스닥-${TAG}` },
    { prompt: `${TAG} 픽셀플러스의 주력 제품은?`, answer: `CIS-${TAG}` },
  ]) };
  CHILD = { ...CHILD, id: await publish(builder, CHILD.name, [
    { prompt: `${TAG} 픽셀플러스의 대표이사는?`, answer: `이서규-${TAG}` },
    { prompt: `${TAG} 픽셀플러스의 본사는 어디입니까?`, answer: `성남-${TAG}` },
  ], [BASE.id]) };
});

test.afterAll(async () => {
  await cleanupAll(api).catch(() => []);
  if (Object.keys(shipped).length) await patchPolicy(api, opToken, shipped).catch(() => 0);
  await api.dispose();
});

test('AZ-290 the family tree names the base, what the add-on added, and who shares each sale', async ({ page }) => {
  await page.goto(`${NODE}/${encodeURIComponent(author.address)}/${encodeURIComponent(BASE.id)}`);
  // SC-11: the strip is in the header, with the caption that says which numbers are whose
  await expect(page.getByTestId('signals-strip')).toBeVisible();
  await expect(page.getByTestId('signals-scope')).toContainText('this node', { ignoreCase: true });

  await page.getByRole('tab', { name: 'Family tree' }).click();
  const svg = page.getByTestId('tree-svg');
  await expect(svg).toBeVisible();
  await expect(page.getByTestId(`tree-node-${CHILD.id}`)).toBeVisible();
  // SC-9 "+{m} questions · {k} changed · {rows} rows ({new} new)" — on the node, not in a tooltip
  await expect(page.getByTestId(`tree-node-${CHILD.id}`)).toContainText('+2 questions');
  await expect(page.getByTestId('tree-legend')).toContainText('Built on it');
  await expect(page.getByTestId('tree-family')).toContainText('2 knowledges');

  // …and from the add-on, the base is above it and the header says it cannot be used alone
  await page.goto(`${NODE}/${encodeURIComponent(builder.address)}/${encodeURIComponent(CHILD.id)}`);
  await expect(page.getByTestId('addon-badge')).toContainText(BASE.name);
  await page.getByRole('tab', { name: 'Family tree' }).click();
  await expect(page.getByTestId(`tree-node-${BASE.id}`)).toBeVisible();
  await expect(page.getByTestId('tree-money')).toContainText(BASE.name);
  // the flag is on here, so building on it is offered rather than explained away
  await expect(page.getByTestId('build-on')).toBeEnabled();
});

test('AZ-291 the training set says who may read it, and the open questions are counts until someone shares one', async ({ page, context }) => {
  await seedBrowserKey(context, builder);
  await page.goto(`${NODE}/${encodeURIComponent(author.address)}/${encodeURIComponent(BASE.id)}`);
  await page.getByRole('tab', { name: 'Family tree' }).click();

  // SC-10 — the training set block, with the access the creator chose
  const ds = page.getByTestId('training-set');
  await expect(ds).toContainText('3 questions');
  await expect(ds).toContainText('available to anyone who builds on it');
  await expect(ds).toContainText('CC-BY-4.0');

  // SC-12 — nothing reported yet, and the panel says what to do about that
  await expect(page.getByTestId('missing-empty')).toBeVisible();

  // a buyer asks for something WITHOUT sharing the wording: it is counted, and the wording is not on the page
  await page.getByTestId('ask-input').fill(`${TAG} does it cover biotech tickers?`);
  await page.getByTestId('ask-send').click();
  await expect(page.getByTestId('ask-done')).toContainText('1');
  await page.reload();
  await page.getByRole('tab', { name: 'Family tree' }).click();
  await expect(page.getByTestId('missing-request')).toBeVisible();
  await expect(page.getByTestId('missing-request')).toContainText('asked 1 times');
  await expect(page.getByTestId('missing-request')).not.toContainText('biotech');
  await expect(page.getByTestId('missing-request')).toContainText('counted, not kept');
});

test('AZ-292 Explore shows what is being built on, with the number it is made of', async ({ page }) => {
  await page.goto(`${NODE}/explore`);
  const shelf = page.getByTestId('shelf-built_on');
  await expect(shelf).toBeVisible();
  await expect(shelf).toContainText(BASE.name);
  await expect(shelf).toContainText('1 built on this');
  // the add-on says what a buyer would also need
  const fresh = page.getByTestId('shelf-fresh');
  await expect(fresh).toContainText(CHILD.name);
  await expect(fresh).toContainText(`Needs ${BASE.name}`);
});

test('AZ-290 @mobile the family is a list on a phone, not a picture of a third of it', async ({ page }) => {
  // the width is set here, not by the project, so the case also runs in the desktop pass — the fallback is CSS and
  // has to hold for a window dragged narrow, not only for a phone user agent
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto(`${NODE}/${encodeURIComponent(author.address)}/${encodeURIComponent(BASE.id)}`);
  await page.getByRole('tab', { name: 'Family tree' }).click();
  // the drawing is hidden by CSS under 600 px and the same tree is rendered as rows — no viewport probing, so it
  // also survives a desktop window dragged narrow
  await expect(page.getByTestId('tree-svg')).toBeHidden();
  const list = page.getByTestId('tree-list');
  await expect(list).toBeVisible();
  await expect(list).toContainText(CHILD.name);
  await expect(list).toContainText('+2 questions');
  await expect(page.getByTestId('tree-family')).toBeVisible();
});
