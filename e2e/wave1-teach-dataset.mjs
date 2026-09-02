/**
 * Findings 7 (dataset check labelled as simulated) — drives node-u (:3422) in a real browser:
 * upload a small dataset, run the check, screenshot and read what the screen claims.
 * Usage: node wave1-teach-dataset.mjs before|after [en|ko] [width]
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
console.log('policy: backend=%s simulated_checks=%s', policy.backend, policy.simulated_checks);

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: W, height: W === 360 ? 900 : 1000 }, locale: loc === 'ko' ? 'ko-KR' : 'en-US' });
await ctx.addInitScript((l) => { try { localStorage.setItem('ainize.locale', l); } catch { /* ignore */ } }, loc);
const p = await ctx.newPage();
await p.goto(`${NODE}/teach/upload`);
await p.getByTestId('teach-upload').waitFor();
await p.getByTestId('file-input').setInputFiles({ name: 'wave1-check.jsonl', mimeType: 'application/x-ndjson', buffer: readFileSync(FIX) });
await p.waitForURL(/\/teach\/dataset\/[0-9a-f-]{36}$/, { timeout: 90_000 });
await p.getByTestId('teach-dataset').waitFor();
const dsId = new URL(p.url()).pathname.split('/')[3];

await p.getByTestId('run-check').click();
const checkingLabel = await p.getByTestId('run-check').textContent().catch(() => null);
await p.getByTestId('checked-note').waitFor({ state: 'visible', timeout: 5 * 60_000 });
await p.waitForTimeout(500);

const facts = await p.evaluate(() => {
  const q = (sel) => document.querySelector(sel);
  const rowHelp = [...document.querySelectorAll('[data-testid="dataset-row"]')].map((r) => {
    const cell = r.querySelectorAll('td')[4];
    const spans = [...cell.querySelectorAll('span')];
    return spans.map((s) => `${s.textContent} [${getComputedStyle(s).color}]`).join(' || ');
  });
  return {
    button: q('[data-testid="run-check"]')?.textContent,
    checkedNote: q('[data-testid="checked-note"]')?.textContent,
    simulatedBanner: q('[data-testid="checks-simulated"]')?.textContent ?? null,
    rowHelp,
  };
});
console.log(`[${phase} ${loc}/${W}] dataset ${dsId}`);
console.log(JSON.stringify({ ...facts, checkingLabel }, null, 1));
await p.screenshot({ path: `${OUT}/07-teach-dataset-check-${phase}-${W}-${loc}.png`, fullPage: true });
console.log('shot', `${OUT}/07-teach-dataset-check-${phase}-${W}-${loc}.png`);
await ctx.close(); await b.close();
