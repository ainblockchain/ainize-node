/**
 * Lineage L6 from a terminal — `ainize patch tree | missing | signals` against the teach dev node :3422
 * (docs/ux-test-scenarios.json AZ-295; docs/lineage-teach-design.md §13).
 *
 *   AINIZE_URL=http://localhost:3422 AINIZE_PASS=teachable-pass npx playwright test tests/cli-tree.spec.ts --project=cli-api
 *
 * The node runs its stub backend: nothing here is a measurement. What is asserted is that an operator with no
 * browser gets the same family, the same open questions and the same two scopes the page shows — and that a
 * question nobody consented to share is printed as a count, in the terminal too.
 */
import { test, expect, request as apiRequest, type APIRequestContext } from '@playwright/test';
import { signMessage } from '@ainize/core';
import { runCli } from '../helpers/operator-cli';
import {
  NODE, cleanupAll, createDataset, createJob, newKey, operatorToken, patchPolicy, policy, tag, teachApi,
  waitForTerminal, type TeachKey,
} from '../helpers/ds-train-api';

test.describe.configure({ mode: 'serial', retries: 0 });

const TAG = tag();
let api: APIRequestContext;
let opToken = '';
let shipped: Record<string, number> = {};
const author: TeachKey = newKey();
const builder: TeachKey = newKey();
let BASE = '';
let CHILD = '';
const BASE_NAME = `CLI base ${TAG}`;
const CHILD_NAME = `CLI add-on ${TAG}`;
const cli = (args: string[]) => runCli(args, { node: NODE, timeoutMs: 120_000 });

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
  opToken = await operatorToken(api);
  const before = await api.get(`${NODE}/api/me/teach/policy`, { headers: { authorization: `Bearer ${opToken}` } });
  const eff = ((await before.json()) as { effective: Record<string, number> }).effective;
  shipped = { jobs_per_key_per_day: eff.jobsPerKeyPerDay, jobs_per_ip_per_day: eff.jobsPerIpPerDay };
  await patchPolicy(api, opToken, { jobs_per_key_per_day: 1000, jobs_per_ip_per_day: 1000, rows_per_key_per_day: 100_000, rows_per_ip_per_day: 100_000 });

  BASE = await publish(author, BASE_NAME, [
    { prompt: `${TAG} 픽셀플러스의 종목코드는?`, answer: `087-${TAG}` },
    { prompt: `${TAG} 픽셀플러스는 어느 시장에 상장되어 있습니까?`, answer: `코스닥-${TAG}` },
  ]);
  CHILD = await publish(builder, CHILD_NAME, [{ prompt: `${TAG} 픽셀플러스의 대표이사는?`, answer: `이서규-${TAG}` }], [BASE]);
});

test.afterAll(async () => {
  await cleanupAll(api).catch(() => []);
  if (Object.keys(shipped).length) await patchPolicy(api, opToken, shipped).catch(() => 0);
  await api.dispose();
});

test('AZ-295 the family, the open questions and the two scopes are the same from a terminal', async () => {
  // `patch tree` — the base above, this knowledge, and what each one added
  const tree = await cli(['patch', 'tree', CHILD]);
  expect(tree.code, tree.stderr).toBe(0);
  expect(tree.stdout).toContain(BASE_NAME);
  expect(tree.stdout).toContain('base');
  expect(tree.stdout).toMatch(/\+1 questions/);
  expect(tree.stdout).toContain('this family:');
  // the money line names the knowledge whose creator this sale pays, and does not fold them into the seller
  expect(tree.stdout).toMatch(new RegExp(`shared by the creators of ${BASE_NAME}`));

  // …and the same walk as JSON is the API's own answer
  const json = await cli(['patch', 'tree', CHILD, '--json']);
  expect(json.code, json.stderr).toBe(0);
  const parsed = JSON.parse(json.stdout) as { root: string; nodes: { id: string; added: { questions: number } }[]; edges: { from: string; to: string; kind: string }[] };
  expect(parsed.root).toBe(CHILD);
  expect(parsed.edges.find((e) => e.from === BASE && e.to === CHILD)?.kind).toBe('extend');
  expect(parsed.nodes.find((n) => n.id === CHILD)!.added.questions).toBe(1);

  // `patch missing` — empty first, then a request that was NOT shared: counted, and printed as a count
  const empty = await cli(['patch', 'missing', BASE]);
  expect(empty.code, empty.stderr).toBe(0);
  expect(empty.stdout).toContain('nothing reported yet');
  const asked = await api.post(`${NODE}/api/patches/${encodeURIComponent(BASE)}/issues`, { data: { text: `${TAG} does it cover biotech tickers?`, share: false } });
  expect(asked.status()).toBe(201);
  const missing = await cli(['patch', 'missing', BASE]);
  expect(missing.code, missing.stderr).toBe(0);
  expect(missing.stdout).toContain('a buyer asked for it');
  expect(missing.stdout).toContain('not shared — counted only');
  expect(missing.stdout).not.toContain('biotech');

  // `patch signals` — the two scopes, each labelled, never added together
  const signals = await cli(['patch', 'signals', BASE]);
  expect(signals.code, signals.stderr).toBe(0);
  expect(signals.stdout).toContain('network — read from the ledger and the peers');
  expect(signals.stdout).toContain('this node — last 30 days, this node only');
  expect(signals.stdout).toMatch(/built on\s+1 knowledges/);
  expect(signals.stdout).toMatch(/open questions\s+1/);
});
