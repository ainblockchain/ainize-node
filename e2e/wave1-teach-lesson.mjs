/**
 * Finding 6 — the lesson RESULT page on the demo node (node-u :3422): upload → check → train → result.
 * Usage: node wave1-teach-lesson.mjs before|after [en|ko] [width]
 */
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const OUT = '/mnt/newdata/ainize/knowledge-marketplace/packages/e2e/results/wave1';
const NODE = 'http://localhost:3422';
const FIX = '/mnt/newdata/ainize/knowledge-marketplace-teachable/packages/e2e/fixtures/ds-preview/az152-check.jsonl';
const phase = process.argv[2] ?? 'before';
const loc = process.argv[3] ?? 'en';
const W = Number(process.argv[4] ?? 1280);

const policy = await (await fetch(`${NODE}/api/teach/policy`)).json();
console.log('policy: backend=%s simulated_checks=%s publish=%s', policy.backend, policy.simulated_checks, policy.publish);

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: W, height: W === 360 ? 900 : 1000 }, locale: loc === 'ko' ? 'ko-KR' : 'en-US' });
await ctx.addInitScript((l) => { try { localStorage.setItem('ainize.locale', l); } catch { /* ignore */ } }, loc);
const p = await ctx.newPage();
await p.goto(`${NODE}/teach/upload`);
await p.getByTestId('teach-upload').waitFor();
await p.getByTestId('file-input').setInputFiles({ name: 'wave1-lesson.jsonl', mimeType: 'application/x-ndjson', buffer: readFileSync(FIX) });
await p.waitForURL(/\/teach\/dataset\/[0-9a-f-]{36}$/, { timeout: 90_000 });
await p.getByTestId('to-settings').click();
await p.waitForURL(/\/teach\/dataset\/[0-9a-f-]{36}\/settings/, { timeout: 60_000 });
await p.getByTestId('train-lesson').click();
const landed = await Promise.race([
  p.waitForURL(/\/teach\/lesson\/[0-9a-f-]{36}$/, { timeout: 120_000 }).then(() => 'ok'),
  p.getByTestId('settings-error').waitFor({ state: 'visible', timeout: 120_000 }).then(() => 'error'),
]);
if (landed === 'error') { console.log('REFUSED:', (await p.getByTestId('settings-error').textContent())?.trim()); await ctx.close(); await b.close(); process.exit(2); }
const jobId = new URL(p.url()).pathname.split('/')[3];
await p.locator('[data-testid="teach-lesson"][data-status="READY"], [data-testid="teach-lesson"][data-status="NEEDS_MORE"], [data-testid="teach-lesson"][data-status="FAILED"]')
  .first().waitFor({ timeout: 5 * 60_000 });
await p.waitForTimeout(800);

const job = await (await fetch(`${NODE}/api/teach/jobs/${jobId}/public`)).json().catch(() => null);
const facts = await p.evaluate(() => {
  const txt = (sel) => document.querySelector(sel)?.textContent ?? null;
  const h1 = document.querySelector('h1');
  const alert = document.querySelector('[data-testid="simulated"]');
  const pub = document.querySelector('[data-testid="go-publish"]');
  const keep = document.querySelector('[data-testid="go-keep"]');
  const order = [...document.querySelectorAll('h1, [data-testid="simulated"], [data-testid="result-learned"]')].map((e) => e.textContent.slice(0, 60));
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return { w: Math.round(r.width), h: Math.round(r.height), bg: st.backgroundColor, color: st.color, tag: el.tagName }; };
  return {
    title: h1?.textContent ?? null,
    learned: txt('[data-testid="result-learned"]'),
    disclaimer: alert?.textContent ?? null,
    disclaimerBg: alert ? getComputedStyle(alert).backgroundColor : null,
    domOrder: order,
    publish: box(pub), publishLabel: pub?.textContent ?? null,
    publishDemoNote: txt('[data-testid="publish-demo"]'),
    keep: box(keep), keepLabel: keep?.textContent ?? null,
  };
});
console.log(`[${phase} ${loc}/${W}] job ${jobId} status ${job?.job?.status ?? '?'} simulated=${job?.job?.checks?.simulated}`);
console.log(JSON.stringify(facts, null, 1));
await p.screenshot({ path: `${OUT}/06-teach-lesson-result-${phase}-${W}-${loc}.png`, fullPage: true });
console.log('shot', `${OUT}/06-teach-lesson-result-${phase}-${W}-${loc}.png`);
await ctx.close(); await b.close();
