/**
 * Teach mode — landing / sign-in / pre-screen / operator Teaching tab (spec §5.1, §5.2, §5.13, §11, §13.1) against a
 * node whose teach backend is `stub` (dev node :3412 with `teach.stubOffline: true`; no model server needed).
 *
 *   AINIZE_URL=http://localhost:3412 AINIZE_PASS=teach-pass npx playwright test tests/web-teach-operator.spec.ts --project=web
 *
 * Scenario ids ↔ docs/ux-test-scenarios.json:
 *   AZ-011 landing creator card (teach copy, CTA → /chat?teach=1, operator link → /signing?next=%2Fnew-patch)
 *   AZ-028 sign-in page: visitor notice + subtitle, redirect back to /dashboard
 *   AZ-030 /new-patch signed out → two-way pre-screen; signed in → the register form
 *   AZ-110 publish in review mode → operator approves (Teaching tab) → ANNOUNCED    AZ-116 hide name / block key
 *   AZ-113 payouts (Owed / Paid / Failed, Retry wiring)                             + settings / decline coverage
 * The lessons are created through the API with a fresh teaching key (the browser flow itself is web-teach.spec.ts).
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { NODE_A, api } from '../helpers/ainize';
import { createIdentity, signMessage } from '../../core/dist/index.js';

test.describe.configure({ mode: 'serial' });

const NODE = NODE_A;
const PASS = process.env.AINIZE_PASS ?? 'teach-pass';
const TAG = Date.now().toString(36).slice(-5);
const TEACHER = `Op Teacher ${TAG}`;

interface Policy { enabled: boolean; publish: 'review' | 'auto' | 'never'; backend: string; shares: { contributor: number } }
interface Job { id: string; status: string; reject_reason?: string; patch_id?: string; facts?: unknown[] }
type Identity = { address: string; privateKey: string };

let policy: Policy;
let token = '';
/** effective values before the run — restored in afterAll (the settings test changes publish mode and both quotas) */
let original: { publish: 'review' | 'auto' | 'never'; jobsPerKeyPerDay: number; jobsPerIpPerDay: number } | undefined;
let teacher: Identity;
let ledgerKind = '';
let declinedJob = '';
let approvedJob = '';
let patchId = '';

const teachHeader = (id: Identity) => { const ts = Date.now(); return { 'x-ngram-auth': `${id.address}:${ts}:${signMessage(`teach:${ts}`, id.privateKey)}` }; };

/** Sign in through the real /signing page (the node's operator password; the helpers' PASSWORDS map only knows the demo cluster). */
async function signIn(page: Page) {
  await page.goto(`${NODE}/signing`);
  const me = await (await page.request.get(`${NODE}/api/auth/me`)).json() as { signedIn: boolean; needsSetup: boolean };
  if (me.signedIn) return;
  await page.getByLabel(/operator password|^password$/i).first().fill(PASS);
  if (me.needsSetup) { await page.getByLabel(/confirm/i).first().fill(PASS); await page.getByRole('checkbox').first().check(); }
  await page.getByRole('button', { name: /^(sign in|confirm)$/i }).first().click();
  await page.waitForURL(/\/dashboard/, { timeout: 30_000 });
}

/** Train one stub lesson for `id` and submit it for publication (review mode → PENDING_REVIEW). */
async function lessonPendingReview(request: APIRequestContext, id: Identity, name: string): Promise<string> {
  const tag = `${TAG}-${Math.random().toString(36).slice(2, 6)}`;
  const created = await api<{ job: Job; error?: string }>(request, '/api/teach/jobs', {
    method: 'POST', headers: teachHeader(id),
    data: { patch_ids: [], builds_on_context: false, facts: [{ prompt: `픽셀플러스 (${tag}) 종목코드는?`, answer: '087600', alt_prompt: `픽셀플러스의 (${tag}) KRX 종목코드를 알려줘` }], contributor: { name: TEACHER }, name },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(202);
  const jobId = created.body.job.id;
  await expect.poll(async () => (await api<{ job: Job }>(request, `/api/teach/jobs/${jobId}`, { headers: teachHeader(id) })).body.job.status, { timeout: 3 * 60_000, intervals: [2000] }).toBe('READY');
  const ch = await api<{ claim: string }>(request, `/api/teach/jobs/${jobId}/publish-challenge`, { headers: teachHeader(id) });
  expect(ch.status).toBe(200);
  const pub = await api<{ status: string }>(request, `/api/teach/jobs/${jobId}/publish`, {
    method: 'POST', headers: teachHeader(id),
    data: { name, price: '0.2', license: 'CC-BY-4.0', claim_sig: signMessage(ch.body.claim, id.privateKey), consent: { permanent: true, rights: true } },
  });
  expect(pub.status, JSON.stringify(pub.body)).toBe(200);
  expect(pub.body.status).toBe('PENDING_REVIEW');
  return jobId;
}

test.beforeAll(async ({ request }) => {
  const p = await api<Policy>(request, '/api/teach/policy');
  test.skip(p.status !== 200 || !p.body.enabled, 'node without teach mode (GET /api/teach/policy not enabled)');
  test.skip(p.body.backend !== 'stub', 'teach backend is not `stub` — the Teaching-tab flow would start a real GPU job');
  policy = p.body;
  ledgerKind = (await api<{ ledger: { kind: string } }>(request, '/api/info')).body.ledger.kind;
  const login = await api<{ token: string }>(request, '/api/auth/login', { method: 'POST', data: { password: PASS } });
  expect(login.status, 'operator login (AINIZE_PASS)').toBe(200);
  token = login.body.token;
  const admin = await api<{ effective: { publish: 'review' | 'auto' | 'never'; jobsPerKeyPerDay: number; jobsPerIpPerDay: number } }>(request, '/api/me/teach/policy', { token });
  original = admin.body.effective;
  teacher = createIdentity();
});
test.afterAll(async ({ request }) => {
  if (!token) return;
  // restore the publish mode and quotas the node had before this run
  if (original) await api(request, '/api/me/teach/policy', { method: 'PATCH', token, data: { publish: original.publish, jobs_per_key_per_day: original.jobsPerKeyPerDay, jobs_per_ip_per_day: original.jobsPerIpPerDay } });
  // and make sure the test key is not left blocked
  const bans = await api<{ items: { id: number; value: string }[] }>(request, '/api/me/teach/bans', { token });
  for (const b of bans.body.items ?? []) if (b.value.toLowerCase() === teacher.address.toLowerCase()) await api(request, `/api/me/teach/bans/${b.id}`, { method: 'DELETE', token });
  // and leave no test lessons behind: operator cancel deletes a declined lesson's files; an announced one is
  // immutable (409, ignored) — announcing only happens on local-ledger nodes whose homes are disposable.
  for (const id of [declinedJob, approvedJob]) if (id) await api(request, `/api/teach/jobs/${id}`, { method: 'DELETE', token });
});

/* ======================================================================================= landing / sign-in / pre-screen */

test('AZ-011 landing creator card teaches the model: copy, CTA → /chat?teach=1, operator link → /signing?next=%2Fnew-patch', async ({ page }) => {
  await page.goto(`${NODE}/`);
  await expect(page.getByRole('heading', { name: 'Which one are you?' })).toBeVisible();
  const card = page.getByTestId('landing-creator-card');
  await expect(card.getByRole('heading', { name: 'I want to teach the model something' })).toBeVisible();
  await expect(card.locator('li')).toHaveText([
    /Ask the model in Live test and correct it when it is wrong\./,
    /This node trains your corrections into knowledge — no sign-in, no server of your own\./,
    /Keep it private, or publish it and get paid on every sale\./,
  ]);
  await expect(page.getByRole('heading', { name: 'I want to sell knowledge' })).toHaveCount(0);
  const cta = card.getByTestId('landing-teach-cta');
  await expect(cta).toHaveText('Teach the model');
  await expect(cta).toHaveAttribute('href', '/chat?teach=1');
  const alt = card.getByTestId('landing-register-link');
  await expect(alt).toHaveText('Already have a knowledge file (.npz) and run a node? Register a file →');
  await expect(alt).toHaveAttribute('href', '/signing?next=%2Fnew-patch');
  await expect(page.getByTestId('landing-nav-teach')).toHaveAttribute('href', '/chat?teach=1');
  await expect(page.getByRole('link', { name: 'Register knowledge' })).toHaveCount(0);

  await cta.click();
  await expect(page).toHaveURL(`${NODE}/chat?teach=1`);
  await expect(page.getByTestId('teach-banner')).toContainText('Wrong answer? Click "Teach the right answer" under any reply and the model learns it. No account needed.');
  await expect(page.getByTestId('lesson-basket')).toBeVisible();
  await expect(page.getByTestId('nav-teach')).toBeVisible();

  await page.goto(`${NODE}/`);
  await page.getByTestId('landing-register-link').click();
  await expect(page).toHaveURL(`${NODE}/signing?next=%2Fnew-patch`);
  await page.screenshot({ path: 'results/az-011-landing-teach.png', fullPage: true });
});

test('AZ-028 sign-in page: visitor notice + subtitle, wrong password, then redirect back to /dashboard', async ({ page }) => {
  await page.goto(`${NODE}/dashboard`);
  await expect(page).toHaveURL(`${NODE}/signing?next=%2Fdashboard`);
  await expect(page.getByRole('heading', { name: 'Sign in to your node' })).toBeVisible();
  await expect(page.getByTestId('sign-subtitle')).toHaveText('Only the person who runs this node needs a password.');
  const notice = page.getByTestId('visitor-notice');
  await expect(notice).toContainText('Want to try or teach the model? You do not need to sign in — that is only for the person who runs this node.');
  await expect(notice.getByRole('link', { name: /Go to Live test/ })).toHaveAttribute('href', '/chat');
  await page.getByLabel('Operator password').fill('wrongpass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText(/wrong password/i)).toBeVisible();
  await expect(page).toHaveURL(/\/signing\?next=%2Fdashboard$/);
  await page.getByLabel('Operator password').fill(PASS);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(`${NODE}/dashboard`);
  await expect(page.getByRole('heading', { name: 'My knowledge' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Teaching' })).toBeVisible();
  // the notice is a visitor thing: signed-in operators visiting /signing are redirected
  await page.goto(`${NODE}/signing`);
  await expect(page).toHaveURL(`${NODE}/dashboard`);
  await page.screenshot({ path: 'results/az-028-signin.png', fullPage: true });
});

test('AZ-030 /new-patch signed out shows the two-way pre-screen; signed in shows the register form; Register moved under the operator menu', async ({ page }) => {
  await page.goto(`${NODE}/new-patch`);
  await expect(page).toHaveURL(`${NODE}/new-patch`);   // no redirect to /signing any more
  const pre = page.getByTestId('newpatch-prescreen');
  await expect(pre.getByRole('heading', { name: 'Add knowledge — two ways' })).toBeVisible();
  const a = pre.getByTestId('prescreen-teach');
  await expect(a.getByRole('heading', { name: 'Teach it in chat' })).toBeVisible();
  await expect(a).toContainText('Correct a wrong answer and this node trains it for you. No account.');
  await expect(a.getByRole('link', { name: 'Open Live test' })).toHaveAttribute('href', '/chat?teach=1');
  const b = pre.getByTestId('prescreen-file');
  await expect(b.getByRole('heading', { name: 'I run this node and have a knowledge file' })).toBeVisible();
  await expect(b).toContainText('Sign in with the operator password to upload a .npz file.');
  await expect(b.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/signing?next=%2Fnew-patch');
  await page.screenshot({ path: 'results/az-030-prescreen.png', fullPage: true });
  await b.getByRole('link', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(`${NODE}/signing?next=%2Fnew-patch`);
  await page.getByLabel('Operator password').fill(PASS);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(`${NODE}/new-patch`);
  await expect(page.getByTestId('newpatch-prescreen')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Register knowledge' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save draft' })).toBeVisible();
  // header: Register lives under the operator menu now
  await page.goto(`${NODE}/explore`);
  await page.getByRole('button', { name: /▾$/ }).click();
  await page.getByRole('menuitem', { name: 'Register a knowledge file' }).click();
  await expect(page).toHaveURL(`${NODE}/new-patch`);
  await expect(page.getByRole('heading', { name: 'Register knowledge' })).toBeVisible();
  // account page points at the Teaching tab
  await page.goto(`${NODE}/account`);
  await expect(page.getByTestId('account-teach').getByRole('link', { name: 'My knowledge → Teaching' })).toHaveAttribute('href', '/dashboard?tab=teaching');
});

/* ======================================================================================= operator Teaching tab */

test('Teaching tab settings: trainer line, publish → "Review each one", share slider, save → GET /api/me/teach/policy + public policy follow', async ({ page, request }) => {
  await signIn(page);
  await page.goto(`${NODE}/dashboard?tab=teaching`);
  await expect(page.getByRole('tab', { name: 'Teaching' })).toHaveAttribute('aria-selected', 'true');
  const tab = page.getByTestId('teaching-tab');
  await expect(tab.getByTestId('teach-note')).toContainText('Lessons are published under this node’s identity; the contributor’s share is written into every sale record.');
  await expect(tab.getByTestId('teach-trainer')).toContainText(/Trainer: (ready|busy|paused)/);
  await expect(tab.getByTestId('teach-trainer')).toContainText('backend stub');
  const form = tab.getByTestId('teach-settings');
  await expect(form.getByTestId('teach-enabled')).toBeChecked();
  await expect(form).toContainText('Accept lessons from visitors');
  await expect(form).toContainText('Data-provider share of each sale');
  await expect(form).toContainText('The rest stays with this node for GPU time and hosting.');
  await expect(form.getByTestId('teach-share-value')).toHaveText(`${Math.round(policy.shares.contributor * 100)}%`);
  await expect(form.getByTestId('teach-save')).toBeDisabled();
  await form.getByTestId('teach-publish').getByLabel('Review each one').check();
  // quotas high enough for the lessons this run trains (restored in afterAll); a partial save must keep the other overrides
  await form.getByTestId('teach-per-key').fill('60');
  await form.getByTestId('teach-per-ip').fill('600');
  await form.getByTestId('teach-paused').fill('');
  await expect(form.getByTestId('teach-save')).toBeEnabled();
  await form.getByTestId('teach-save').click();
  await expect(tab.getByTestId('teach-notice')).toHaveText('Saved.');
  await expect(form.getByTestId('teach-save')).toBeDisabled();
  const admin = await api<{ policy: { publish: string; jobsPerKeyPerDay: number; jobsPerIpPerDay: number }; effective: { publish: string; jobsPerKeyPerDay: number; jobsPerIpPerDay: number } }>(request, '/api/me/teach/policy', { token });
  expect(admin.body.policy.publish).toBe('review');
  expect(admin.body.effective).toMatchObject({ publish: 'review', jobsPerKeyPerDay: 60, jobsPerIpPerDay: 600 });
  // a second partial save (pause reason) keeps the quotas
  await form.getByTestId('teach-paused').fill('GPU maintenance (e2e)');
  await form.getByTestId('teach-save').click();
  await expect(tab.getByTestId('teach-notice')).toHaveText('Saved.');
  await expect.poll(async () => (await api<Policy & { trainer: string; paused_reason?: string }>(request, '/api/teach/policy')).body.trainer, { timeout: 30_000 }).toBe('paused');
  await form.getByTestId('teach-paused').fill('');
  await form.getByTestId('teach-save').click();
  await expect(tab.getByTestId('teach-notice')).toHaveText('Saved.');
  const again = await api<{ policy: { jobsPerKeyPerDay: number; pausedReason?: string } }>(request, '/api/me/teach/policy', { token });
  expect(again.body.policy.jobsPerKeyPerDay).toBe(60);
  expect(again.body.policy.pausedReason).toBeUndefined();
  await expect.poll(async () => (await api<Policy>(request, '/api/teach/policy')).body.publish, { timeout: 30_000 }).toBe('review');
  await page.screenshot({ path: 'results/teach-tab-settings.png', fullPage: true });
});

test('AZ-110 review queue: PENDING_REVIEW lesson → Decline with a reason (contributor sees it) → second lesson → Approve and announce → ANNOUNCED', async ({ page, request }) => {
  // Approve announces a permanent anchor on the ledger. On the shared AIN chain (live demo cluster) that would
  // pollute the public catalog forever — run this on a local-ledger node (node-t / throwaway cluster) instead.
  test.skip(ledgerKind === 'ain' && process.env.AINIZE_TEACH_ANNOUNCE !== '1', 'shared AIN chain — approve/announce is permanent; run against a local-ledger node for announce coverage');
  await signIn(page);
  declinedJob = await lessonPendingReview(request, teacher, `Op decline ${TAG}`);
  await page.goto(`${NODE}/dashboard?tab=teaching`);
  const tab = page.getByTestId('teaching-tab');
  const row = tab.locator(`[data-testid="teach-job"][data-job-id="${declinedJob}"]`);
  await expect(row).toHaveAttribute('data-status', 'PENDING_REVIEW', { timeout: 30_000 });
  await expect(row).toContainText('Waiting for review');
  await expect(row).toContainText(TEACHER);
  await expect(row).toContainText(`Op decline ${TAG}`);
  await expect(tab.getByTestId('teach-review-count')).toContainText(/\d+ waiting for review/);
  await expect(row.getByTestId('teach-approve')).toHaveText('Approve and announce');
  await row.getByTestId('teach-decline').click();
  await expect(row.getByTestId('teach-decline-confirm')).toBeDisabled();
  await row.getByTestId('teach-decline-reason').fill('The answer is not verifiable');
  await row.getByTestId('teach-decline-confirm').click();
  await expect(row).toHaveAttribute('data-status', 'REJECTED', { timeout: 30_000 });
  await expect(row.getByTestId('teach-job-reason')).toHaveText('Declined: The answer is not verifiable');
  const seen = await api<{ job: Job }>(request, `/api/teach/jobs/${declinedJob}`, { headers: teachHeader(teacher) });
  expect(seen.body.job.status).toBe('REJECTED');
  expect(seen.body.job.reject_reason).toBe('The answer is not verifiable');

  approvedJob = await lessonPendingReview(request, teacher, `Op approve ${TAG}`);
  await page.reload();
  const row2 = tab.locator(`[data-testid="teach-job"][data-job-id="${approvedJob}"]`);
  await expect(row2).toHaveAttribute('data-status', 'PENDING_REVIEW', { timeout: 30_000 });
  await page.screenshot({ path: 'results/teach-tab-queue.png', fullPage: true });
  await row2.getByTestId('teach-approve').click();
  await expect(row2).toHaveAttribute('data-status', 'ANNOUNCED', { timeout: 60_000 });
  await expect(row2).toContainText('Announced');
  await expect(row2.getByRole('link', { name: /Knowledge page/ })).toBeVisible();
  const job = await api<{ job: Job }>(request, `/api/teach/jobs/${approvedJob}`, { headers: teachHeader(teacher) });
  expect(job.body.job.status).toBe('ANNOUNCED');
  patchId = job.body.job.patch_id!;
  const d = await api<{ anchor: { origin?: string; name: string; contributors?: { address: string; name?: string }[] } }>(request, `/api/patches/${patchId}`);
  expect(d.status).toBe(200);
  expect(d.body.anchor.origin).toBe('teach');
  expect(d.body.anchor.name).toBe(`Op approve ${TAG}`);
  expect(d.body.anchor.contributors?.[0].address.toLowerCase()).toBe(teacher.address.toLowerCase());
  expect(d.body.anchor.contributors?.[0].name).toBe(TEACHER);
});

test('AZ-116 contributors: Hide name → "Taught by a visitor" on the knowledge page → Show name; Block key → 403 banned → Unblock', async ({ page, request }) => {
  test.skip(!patchId, 'no announced lesson (earlier step skipped)');
  await signIn(page);
  await page.goto(`${NODE}/dashboard?tab=teaching`);
  const tab = page.getByTestId('teaching-tab');
  const row = tab.locator(`[data-testid="teach-contributor"][data-address="${teacher.address.toLowerCase()}"]`);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).toContainText(TEACHER);
  await expect(row.getByRole('link', { name: 'public page' })).toHaveAttribute('href', `/teacher/${teacher.address}`);
  // hide the name
  await expect(row.getByTestId('contrib-toggle-hidden')).toHaveText('Hide name');
  await row.getByTestId('contrib-toggle-hidden').click();
  await expect(row.getByTestId('contrib-hidden')).toHaveText('name hidden');
  await expect(row.getByTestId('contrib-toggle-hidden')).toHaveText('Show name');
  const hidden = await api<{ anchor: { contributors?: { name?: string }[] } }>(request, `/api/patches/${patchId}`);
  expect(hidden.body.anchor.contributors?.[0].name).toBeUndefined();
  const info = await api<{ node: { address: string } }>(request, '/api/info');
  const visitor = await page.context().browser()!.newContext({ locale: 'en-US' });
  try {
    const p2 = await visitor.newPage();
    await p2.goto(`${NODE}/${encodeURIComponent(info.body.node.address)}/${encodeURIComponent(patchId)}`);
    await expect(p2.getByTestId('taught-by')).toContainText('Data provider: Taught by a visitor', { timeout: 30_000 });
    await expect(p2.getByTestId('taught-by')).not.toContainText(TEACHER);
  } finally { await visitor.close(); }
  await row.getByTestId('contrib-toggle-hidden').click();
  await expect(row.getByTestId('contrib-hidden')).toHaveCount(0);
  await expect.poll(async () => (await api<{ anchor: { contributors?: { name?: string }[] } }>(request, `/api/patches/${patchId}`)).body.anchor.contributors?.[0].name).toBe(TEACHER);
  // block the key
  page.once('dialog', (d) => { expect(d.message()).toContain('New lessons from it will be refused'); void d.accept(); });
  await row.getByTestId('contrib-block-key').click();
  await expect(row.getByTestId('contrib-blocked')).toHaveText('blocked');
  const ban = tab.locator(`[data-testid="teach-ban"][data-kind="address"][data-value="${teacher.address.toLowerCase()}"]`);
  await expect(ban).toBeVisible();
  const refused = await api<{ error: string }>(request, '/api/teach/jobs', {
    method: 'POST', headers: teachHeader(teacher),
    data: { patch_ids: [], builds_on_context: false, facts: [{ prompt: `픽셀플러스 (${TAG}-ban) 종목코드는?`, answer: '087600' }], contributor: { name: TEACHER } },
  });
  expect(refused.status).toBe(403);
  expect(refused.body.error).toMatch(/^banned/);
  await page.screenshot({ path: 'results/teach-tab-contributors.png', fullPage: true });
  await row.getByTestId('contrib-unblock-key').click();
  await expect(row.getByTestId('contrib-blocked')).toHaveCount(0);
  await expect(ban).toHaveCount(0);
  const bans = await api<{ items: { value: string }[] }>(request, '/api/me/teach/bans', { token });
  expect(bans.body.items.map((b) => b.value.toLowerCase())).not.toContain(teacher.address.toLowerCase());
});

test('AZ-113 payouts: Owed / Paid / Failed tiles from GET /api/me/payouts, no-wallet hint on a local-record node, Retry posts /api/me/payouts/:id/retry', async ({ page, request }) => {
  await signIn(page);
  const live = await api<{ summary: { pending: number; paid: number; failed: number }; wallet: boolean; items: unknown[] }>(request, '/api/me/payouts', { token });
  expect(live.status).toBe(200);
  await page.goto(`${NODE}/dashboard?tab=teaching`);
  const tab = page.getByTestId('teaching-tab');
  await expect(tab.getByTestId('payouts-owed')).toHaveText(String(live.body.summary.pending));
  await expect(tab.getByTestId('payouts-paid')).toHaveText(String(live.body.summary.paid));
  await expect(tab.getByTestId('payouts-failed')).toHaveText(String(live.body.summary.failed));
  if (!live.body.wallet) await expect(tab.getByTestId('payouts-no-wallet')).toContainText('This node has no chain wallet');
  if (live.body.items.length === 0) await expect(tab.getByTestId('teach-payouts')).toContainText('No payouts yet — they appear when a taught lesson sells.');

  // Retry wiring: a failed row (mocked — the dev node has no AIN wallet, so no real payout can fail here) → POST /api/me/payouts/:id/retry
  const failed = { id: 7, patch_id: patchId || 'taught-demo', settle_hash: 'a'.repeat(64), address: teacher.address, amount: '0.14', currency: 'AIN', status: 'failed', tx_hash: null, attempts: 3, last_error: 'insufficient balance', created_at: Date.now() - 600_000, updated_at: Date.now() - 60_000 };
  await page.route('**/api/me/payouts?*', (route) => route.fulfill({ json: { items: [failed], summary: { pending: 0, failed: 1, paid: 0 }, max_attempts: 20, retry_ms: 60_000, wallet: true } }));
  let retried = false;
  await page.route('**/api/me/payouts/7/retry', (route) => { retried = true; return route.fulfill({ json: { payout: { ...failed, status: 'paid', tx_hash: '0x' + 'b'.repeat(64), attempts: 4 } } }); });
  await page.reload();
  await expect(tab.getByTestId('payouts-failed')).toHaveText('1');
  const row = tab.locator('[data-testid="teach-payout"][data-status="failed"]');
  await expect(row).toContainText('insufficient balance');
  await expect(row).toContainText('3 / 20');
  await row.getByTestId('payout-retry').click();
  await expect(tab.getByTestId('teach-notice')).toHaveText('Transfer retried.');
  expect(retried).toBe(true);
  await page.screenshot({ path: 'results/teach-tab-payouts.png', fullPage: true });
});
