/**
 * Helpers for the Visitor (knowledge user) scenarios — mostly the Live-test page.
 *
 * Quota isolation: the node meters free live tests per client IP (20 / hour, `ip:${req.ip}`) and trusts proxy headers
 * (`app.set('trust proxy', true)`). A random 127.x.y.z origin alone is NOT enough — Linux sends every loopback
 * connection from 127.0.0.1, so all such visitors would share one bucket. `freshVisitor(page)` therefore also stamps a
 * unique `X-Forwarded-For` on every browser request that goes to the node (all tabs of that context are one visitor),
 * which gives each scenario (and each retry) a fresh, deterministic quota window without touching product code.
 * Direct API calls made with `page.request` are not routed by the browser, so they take `visitorHeaders(page)`.
 */
import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { api, waitForRuntime } from './ainize';

const PORT = new URL(process.env.AINIZE_URL ?? 'http://localhost:3402').port || '3402';

/** A never-used loopback origin (separate localStorage / cookie jar). Pair it with `freshVisitor` for a fresh quota. */
export function freshOrigin(): string {
  const o = () => 1 + Math.floor(Math.random() * 253);
  return `http://127.${o()}.${o()}.${o()}:${PORT}`;
}

const visitorIp = new WeakMap<Page, string>();

/** A never-used client IP for this browser context → its own 20/hour live-test quota. Returns a fresh origin to open. */
export async function freshVisitor(page: Page): Promise<string> {
  const o = () => 1 + Math.floor(Math.random() * 253);
  const ip = `10.${o()}.${o()}.${o()}`;
  visitorIp.set(page, ip);
  // Stamped per request instead of with setExtraHTTPHeaders(), which would also put the header on the cross-origin
  // Google-Fonts faces the page loads: their CORS preflight rejects the unknown header and logs a console error —
  // harness noise that the "leaving the page aborts without console errors" step of AZ-019 would report as a fault.
  await page.context().route((u) => u.port === PORT, (route) => route.continue({ headers: { ...route.request().headers(), 'x-forwarded-for': ip } }));
  return freshOrigin();
}

/** The visitor IP of `page` as a header bag — for direct `page.request` calls, which the browser does not route. */
export function visitorHeaders(page: Page): Record<string, string> {
  const ip = visitorIp.get(page);
  return ip ? { 'x-forwarded-for': ip } : {};
}

export async function nodeAAddress(request: APIRequestContext): Promise<string> {
  const r = await api<{ node: { address: string } }>(request, '/api/info');
  return r.body.node.address;
}

export const textarea = (page: Page) => page.locator('textarea');
export const sendButton = (page: Page) => page.getByRole('button', { name: /^(Send|Waiting for the answer…)$/ });
export const chip = (page: Page, prompt: string) => page.getByRole('button', { name: prompt, exact: true });
export const turns = (page: Page) => page.locator('main article');
export const modeRadio = (page: Page, label: 'Compare' | 'After only' | 'Before only') => page.getByRole('radio', { name: label, exact: true });
export const quotaFooter = (page: Page) => page.getByText(/Free trial \d+\/\d+ left this hour/);

/** The "Before loading" / "After loading" bubble of one turn. */
export function bubble(turn: Locator, kind: 'Before loading' | 'After loading'): Locator {
  return turn.locator('div[aria-busy]').filter({ has: turn.page().locator('span', { hasText: new RegExp(`^${kind}$`) }) });
}

/** Type (or keep the prefilled) prompt and press Enter; returns the locator of the new turn. */
export async function sendPrompt(page: Page, text?: string): Promise<Locator> {
  const before = await turns(page).count();
  const box = textarea(page);
  await expect(box).toBeEnabled({ timeout: 60_000 });
  if (text !== undefined) await box.fill(text);
  await box.press('Enter');
  const turn = turns(page).nth(before);
  await expect(turn).toBeVisible();
  return turn;
}

const TRANSIENT = /model server is off|Timed out|Could not reach|Something went wrong/;

/**
 * Wait until a turn has finished (answer or error). A transient runtime error (vLLM hang / restart) is retried through
 * the UI's own "Retry" button after the model is back — the scenarios explicitly tolerate that.
 */
export async function waitTurnDone(page: Page, request: APIRequestContext, turn: Locator, opts: { timeoutMs?: number; retries?: number } = {}): Promise<void> {
  const timeout = opts.timeoutMs ?? 10 * 60_000;
  const retries = opts.retries ?? 2;
  for (let attempt = 0; ; attempt++) {
    await expect(turn.locator('[aria-busy="true"]')).toHaveCount(0, { timeout });
    await expect(sendButton(page)).toHaveText('Send', { timeout: 60_000 });
    const alert = turn.getByRole('alert');
    if ((await alert.count()) === 0) return;
    const msg = (await alert.textContent()) ?? '';
    if (attempt < retries && TRANSIENT.test(msg)) {
      await waitForRuntime(request);
      await turn.getByRole('button', { name: 'Retry' }).click();
      continue;
    }
    throw new Error(`live test failed: ${msg}`);
  }
}

/** Poll GET /api/chat/patches until `pred(lock)` holds. */
export async function waitForLock(request: APIRequestContext, origin: string, pred: (lock: { owner: string; label: string; since: number } | null) => boolean, ms = 120_000): Promise<{ owner: string; label: string; since: number } | null> {
  const t0 = Date.now();
  let last: { owner: string; label: string; since: number } | null = null;
  while (Date.now() - t0 < ms) {
    const r = await api<{ lock: { owner: string; label: string; since: number } | null }>(request, '/api/chat/patches', { node: origin });
    last = r.body.lock;
    if (r.status === 200 && pred(last)) return last;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`lock condition not met within ${ms} ms (last lock: ${JSON.stringify(last)})`);
}
