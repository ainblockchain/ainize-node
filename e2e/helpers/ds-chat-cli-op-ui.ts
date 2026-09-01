/**
 * Browser-side helpers for `tests/ds-chat-cli-op.spec.ts`: seed a browser context with a teaching key and (for the
 * chat door) with a lesson basket, exactly as the app itself writes them (packages/web/src/lib/teacherKey.ts
 * `ainize.teacher.key`, packages/web/src/lib/teachStore.ts `ainize.teach.basket.<stack>`), and clear them again.
 */
import type { BrowserContext, Page } from '@playwright/test';
import type { TeachKey } from './ds-chat-cli-op-api';

export const KEY_STORAGE = 'ainize.teacher.key';
export const BASKET_PREFIX = 'ainize.teach.basket.';
export const JOBS_KEY = 'ainize.teach.jobs';

export interface BasketFact { prompt: string; answer: string; alt_prompt?: string; model_answer?: string }

const stackHash = (ids: string[]) => (ids.length ? ids.join('+') : 'base');

/**
 * Install the teaching key (and optionally a basket) into a context BEFORE its first page loads, so the app boots with
 * the same storage a visitor who already taught here would have.
 */
export async function seedTeachStorage(context: BrowserContext, opts: { key?: TeachKey; name?: string; basket?: BasketFact[]; stack?: string[] }): Promise<void> {
  const payload = {
    keyStorage: KEY_STORAGE,
    basketKey: BASKET_PREFIX + stackHash(opts.stack ?? []),
    key: opts.key ? { privateKey: opts.key.privateKey.replace(/^0x/, '').toLowerCase(), address: opts.key.address, ...(opts.name ? { name: opts.name } : {}), created_at: Date.now() } : null,
    basket: opts.basket
      ? { facts: opts.basket.map((f, i) => ({ ...f, id: `seed-${i}-${Math.random().toString(36).slice(2, 8)}`, added_at: Date.now() })), builds_on: false }
      : null,
  };
  await context.addInitScript((p: typeof payload) => {
    try {
      if (p.key) localStorage.setItem(p.keyStorage, JSON.stringify(p.key));
      if (p.basket) localStorage.setItem(p.basketKey, JSON.stringify(p.basket));
    } catch { /* storage unavailable — the page must still work */ }
  }, payload);
}

/** What the basket holds right now, read out of the page's own storage. */
export async function readBasket(page: Page, stack: string[] = []): Promise<BasketFact[]> {
  return page.evaluate((k) => {
    try { const raw = localStorage.getItem(k); return raw ? ((JSON.parse(raw) as { facts?: BasketFact[] }).facts ?? []) : []; } catch { return []; }
  }, BASKET_PREFIX + stackHash(stack)) as Promise<BasketFact[]>;
}

/** Replace the basket in a live page (used to reach the per-lesson cap without re-asking the model N times). */
export async function writeBasket(page: Page, facts: BasketFact[], stack: string[] = []): Promise<void> {
  await page.evaluate(([k, list]) => {
    try {
      localStorage.setItem(k as string, JSON.stringify({
        facts: (list as BasketFact[]).map((f, i) => ({ ...f, id: `seed-${i}-${Math.random().toString(36).slice(2, 8)}`, added_at: Date.now() })),
        builds_on: false,
      }));
    } catch { /* ignore */ }
  }, [BASKET_PREFIX + stackHash(stack), facts] as [string, BasketFact[]]);
}

/** Leave a shared browser profile clean between scenarios. */
export async function clearTeachStorage(page: Page): Promise<void> {
  await page.evaluate((prefix) => {
    try {
      for (const k of Object.keys(localStorage)) if (k.startsWith(prefix) || k.startsWith('ainize.teach')) localStorage.removeItem(k);
    } catch { /* ignore */ }
  }, BASKET_PREFIX);
}

/** Switch the header language button (aria-label="language") and wait for the label to flip. */
export async function toggleLocale(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'language' }).first().click();
}
