/**
 * Helpers for the cross-cutting scenarios (AZ-085..AZ-100): chat-page driving, keyboard focus probing,
 * an alternate visitor origin (separate free-try quota bucket) and small formatting mirrors of the web UI.
 */
import { networkInterfaces } from 'node:os';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { NODE_A, api, waitForLockFree, waitForRuntime } from './ainize';

/** Mirrors packages/web/src/utils/format.ts bytes(). */
export function bytesLabel(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
export const numLabel = (n: number | string) => Number(n).toLocaleString('en-US');

/** Mirrors recordText.ts ago() (English / Korean). */
export function agoLabel(ts: number, locale: 'en' | 'ko' = 'en', now = Date.now()): string {
  const s = Math.floor(Math.max(0, now - ts) / 1000);
  const u = (n: number, en: string, ko: string) => (locale === 'ko' ? `${n}${ko} 전` : `${n}${en} ago`);
  if (s < 60) return u(s, 's', '초');
  const m = Math.floor(s / 60);
  if (m < 60) return u(m, 'm', '분');
  const h = Math.floor(m / 60);
  if (h < 24) return u(h, 'h', '시간');
  const d = Math.floor(h / 24);
  if (d < 30) return u(d, 'd', '일');
  const mo = Math.floor(d / 30);
  if (mo < 12) return u(mo, 'mo', '개월');
  return u(Math.floor(mo / 12), 'y', '년');
}

export const AGO_EN = /^\d+(s|m|h|d|mo|y) ago$/;
export const AGO_KO = /^\d+(초|분|시간|일|개월|년) 전$/;
/** "Aug. 31 2026, 14:02:11 +09:00" (utils/format.ts dateTime) */
export const DATE_TIME = /^[A-Z][a-z]{2}\. \d{2} \d{4}, \d{2}:\d{2}:\d{2} [+-]\d{2}:\d{2}$/;

/** Node-a address as published by the node itself. */
export async function nodeAAddress(request: APIRequestContext, node = NODE_A): Promise<string> {
  const r = await api<{ node: { address: string } }>(request, '/api/info', { node });
  return r.body.node.address;
}

/**
 * The visitor free-try quota is keyed by client IP (`ip:${req.ip}`) and every test group on this machine reaches
 * node-a through 127.0.0.1. To keep the live-test scenarios of this group from competing with parallel groups for
 * the same 20 tries/hour, the chat-driving tests talk to node-a through another local address of the same host
 * (LAN interface or the docker bridge) when it is reachable. It is the same node process and the same web build.
 */
let visitorOriginCache: string | undefined;
export async function visitorOrigin(): Promise<string> {
  if (visitorOriginCache) return visitorOriginCache;
  if (process.env.AINIZE_VISITOR_URL) return (visitorOriginCache = process.env.AINIZE_VISITOR_URL);
  const port = new URL(NODE_A).port || '80';
  const candidates: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) candidates.push(`http://${i.address}:${port}`);
  }
  for (const origin of candidates) {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 3000);
      const r = await fetch(`${origin}/api/info`, { signal: ac.signal });
      clearTimeout(timer);
      if (r.ok) return (visitorOriginCache = origin);
    } catch { /* try the next one */ }
  }
  return (visitorOriginCache = NODE_A);
}

/**
 * Give this browser context its own free-try bucket. All chat-driving cross-cutting scenarios share one alternate
 * origin, so without this they also share its 20 tries/hour and a second run of the suite inside the same hour hits
 * the quota wall. The node meters per client IP and trusts proxy headers, so the fake IP is stamped on every request
 * that goes to the node (per request, not with setExtraHTTPHeaders(), which would also mark cross-origin font
 * requests and make their CORS preflight fail).
 */
export async function freshTries(page: Page, node = NODE_A): Promise<void> {
  const o = () => 1 + Math.floor(Math.random() * 253);
  const ip = `10.${o()}.${o()}.${o()}`;
  const port = new URL(node).port || '80';
  await page.context().route((u) => u.port === port, (route) => route.continue({ headers: { ...route.request().headers(), 'x-forwarded-for': ip } }));
}

/** Model reachable + nobody holding the shared runtime lock. Throws when the model does not come back in time. */
export async function ensureRuntime(request: APIRequestContext, node = NODE_A): Promise<void> {
  const ok = await waitForRuntime(request, node);
  if (!ok) throw new Error('serving runtime (vLLM) did not become available in time');
  await waitForLockFree(request, node);
}

/* ------------------------------------------------------------------ chat page */
export const CHAT = {
  placeholderEn: 'Type a question and press Enter (Shift+Enter for a new line)',
  networkError: 'Could not reach the node. Check your connection and try again.',
};

export function chatTextarea(page: Page): Locator { return page.locator('textarea').first(); }
export function chatPicker(page: Page): Locator { return page.locator('aside[aria-label]').first(); }
/** Picker rows — the teach-era picker is a multi-select list of `<label>` rows, each wrapping a checkbox. */
export function pickerItems(page: Page): Locator { return chatPicker(page).locator('li > label'); }
/** The checkboxes inside the picker rows (enabled/checked semantics live here, not on the label). */
export function pickerBoxes(page: Page): Locator { return chatPicker(page).getByRole('checkbox'); }
export function lastTurn(page: Page): Locator { return page.locator('article').last(); }
export function bubble(page: Page, kind: 'base' | 'patched'): Locator {
  return lastTurn(page).locator('[aria-busy]').filter({ hasText: kind === 'base' ? /Before loading|지식 넣기 전/ : /After loading|지식 넣은 후/ });
}
// D3: while the request is queued behind the shared model the same strip says so and the button reads "Stop waiting".
export const CANCEL_STRIP = /Waiting for the answer — you can cancel if it takes too long\.|답을 기다리는 중입니다|Queued behind another test|순서를 기다리는 중입니다/;

export async function waitForPicker(page: Page, count = 4): Promise<void> {
  const items = pickerItems(page);
  const t0 = Date.now();
  while (Date.now() - t0 < 60_000) {
    if ((await items.count()) >= count) return;
    await page.waitForTimeout(250);
  }
  throw new Error(`picker did not show ${count} items`);
}

/** Type a prompt and press Enter. */
export async function sendPrompt(page: Page, text: string): Promise<void> {
  const ta = chatTextarea(page);
  await ta.fill(text);
  await ta.press('Enter');
}

/** Wait until the in-flight request is over; returns the outcome of the last turn. */
export async function waitForTurn(page: Page, timeoutMs = 5 * 60_000): Promise<'done' | 'error'> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const busy = await page.locator('[aria-busy="true"]').count();
    const strip = await page.getByRole('status').filter({ hasText: CANCEL_STRIP }).count();
    if (busy === 0 && strip === 0) {
      const err = await lastTurn(page).getByRole('alert').count();
      return err > 0 ? 'error' : 'done';
    }
    await page.waitForTimeout(500);
  }
  throw new Error('chat turn did not finish in time');
}

/** Errors that mean "the shared model hiccuped" (vLLM hang / restart, lock contention) rather than a UI defect. */
export const TRANSIENT_CHAT_ERROR = /model server is off|fetch failed|Something went wrong during the test|Timed out waiting|stayed busy for too long|모델 서버가|테스트 중 문제가|시간이 초과|다른 테스트가/;

/**
 * Wait for the in-flight turn. When it fails for a runtime hiccup, wait for the model to come back and press Retry
 * (at most `attempts` times) — the suite must tolerate the hourly vLLM hang. Returns the outcome and the retries used.
 */
export async function completeTurn(page: Page, request: APIRequestContext, attempts = 3): Promise<{ status: 'done' | 'error'; retries: number; lastError?: string }> {
  let retries = 0;
  for (;;) {
    const status = await waitForTurn(page);
    if (status === 'done') return { status, retries };
    const msg = await lastTurn(page).getByRole('alert').innerText();
    if (retries >= attempts || !TRANSIENT_CHAT_ERROR.test(msg)) return { status: 'error', retries, lastError: msg };
    retries++;
    await ensureRuntime(request);
    await lastTurn(page).getByRole('button', { name: /^(Retry|다시 시도)$/ }).click();
  }
}

/** "Free trial 19/20 left this hour" → 19; null when the footer shows another text. */
export async function readQuota(page: Page): Promise<number | null> {
  const txt = await page.locator('textarea').locator('xpath=ancestor::div[1]/following-sibling::div[1]').innerText().catch(() => '');
  const m = /(\d+)\/(\d+)/.exec(txt);
  return m ? Number(m[1]) : null;
}
export async function footerText(page: Page): Promise<string> {
  return page.locator('textarea').locator('xpath=ancestor::div[1]/following-sibling::div[1]').innerText();
}

/* ------------------------------------------------------------------ keyboard / focus */
export interface FocusInfo {
  tag: string; role: string | null; type: string | null; name: string; href: string | null; disabled: boolean;
  outlineStyle: string; outlineWidth: string; outlineColor: string; outlineOffset: string; borderColor: string; boxShadow: string;
}
export async function focusInfo(page: Page): Promise<FocusInfo> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) {
      return { tag: 'body', role: null, type: null, name: '', href: null, disabled: false, outlineStyle: '', outlineWidth: '', outlineColor: '', outlineOffset: '', borderColor: '', boxShadow: '' };
    }
    const cs = getComputedStyle(el);
    const label = el.getAttribute('aria-label');
    const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    return {
      tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), type: (el as HTMLInputElement).type ?? null,
      name: label ?? text, href: el.getAttribute('href'), disabled: !!(el as HTMLButtonElement).disabled,
      outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth, outlineColor: cs.outlineColor, outlineOffset: cs.outlineOffset,
      borderColor: cs.borderTopColor, boxShadow: cs.boxShadow,
    };
  });
}

/** Press Tab until the focused element satisfies `pred` (max `max` presses). Returns the focus info or null. */
export async function tabUntil(page: Page, pred: (f: FocusInfo) => boolean, max = 80, key: 'Tab' | 'Shift+Tab' = 'Tab'): Promise<FocusInfo | null> {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press(key);
    const f = await focusInfo(page);
    if (pred(f)) return f;
  }
  return null;
}

export const PURPLE = 'rgb(139, 62, 235)';   // theme PRIMARY #8b3eeb

/** Horizontal overflow check the scenario asks for on every page. */
export async function noHorizontalScroll(page: Page): Promise<{ ok: boolean; scrollWidth: number; innerWidth: number }> {
  return page.evaluate(() => ({ ok: document.documentElement.scrollWidth <= window.innerWidth, scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
}

/** axe-core source (CDN); undefined when the machine has no internet access. */
let axeSource: string | undefined | null;
export async function loadAxe(request: APIRequestContext): Promise<string | undefined> {
  if (axeSource !== undefined) return axeSource ?? undefined;
  try {
    const r = await request.get('https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.2/axe.min.js', { timeout: 20_000 });
    axeSource = r.ok() ? await r.text() : null;
  } catch { axeSource = null; }
  return axeSource ?? undefined;
}
export interface AxeViolation { id: string; impact: string; nodes: number; targets: string[] }
export async function runAxe(page: Page, source: string): Promise<AxeViolation[]> {
  await page.addScriptTag({ content: source });
  return page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run: (ctx: Document, opts: unknown) => Promise<{ violations: { id: string; impact: string; nodes: { target: string[] }[] }[] }> } }).axe;
    const res = await axe.run(document, { resultTypes: ['violations'] });
    return res.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, targets: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
  });
}
