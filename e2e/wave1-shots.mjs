/**
 * Wave 1 verification shots for findings 24, 28, 55, 29, 56 (node-a :3402).
 * Usage: node wave1-shots.mjs before|after [only...]
 */
import { chromium } from 'playwright';

const OUT = '/mnt/newdata/ainize/knowledge-marketplace/packages/e2e/results/wave1';
const BASE = 'http://localhost:3402';
const AUTHOR = '0xF7A9dE49902C95661AC6556D631e2B60a081A1F5';
const phase = process.argv[2] ?? 'before';
const only = process.argv.slice(3);

const SHOTS = [
  { n: '24', slug: 'benchmarks', route: '/benchmarks/krx-ticker-codes', probe: () => ({
      stats: document.querySelector('main p, p')?.innerText ?? null,
      groups: [...document.querySelectorAll('[data-testid="bench-group-head"]')].map((h) => h.innerText.replace(/\n/g, ' ')),
      explain: [...document.querySelectorAll('p')].map((p) => p.innerText).find((x) => /comparable|비교/.test(x)) ?? null,
      cards: [...document.querySelectorAll('a[href^="/0x"]')].map((a) => a.innerText.replace(/\n+/g, ' | ')),
    }) },
  { n: '29-56', slug: 'explore', route: '/explore', allVersions: true, probe: () => ({
      rows: [...document.querySelectorAll('a[href^="/0x"]')].map((a) => ({
        text: a.innerText.replace(/\n+/g, ' | ').slice(0, 200),
        seal: (() => { const i = a.querySelector('img'); return i ? { testid: i.dataset.testid ?? null, w: Math.round(i.getBoundingClientRect().width), filter: getComputedStyle(i).filter, opacity: getComputedStyle(i).opacity } : null; })(),
      })),
      seals: document.querySelectorAll('a[href^="/0x"] img').length,
    }) },
  { n: '28', slug: 'detail-overview', route: `/${AUTHOR}/krx-all-2761`, probe: () => ({
      stat: document.querySelector('[data-testid="stat-accuracy"]')?.innerText.replace(/\n/g, ' | ') ?? null,
      beforeAfter: document.querySelector('[data-testid="ov-before-after"]')?.textContent ?? null,
      side: document.querySelector('[data-testid="ov-side-effect"]')?.innerText ?? null,
      hasPre: /1\/8/.test(document.body.innerText),
    }) },
  { n: '28b', slug: 'detail-verification', route: `/${AUTHOR}/krx-all-2761`, tab: 'Verification', probe: () => ({
      head: [...document.querySelectorAll('th')].map((h) => h.innerText),
      firstRow: [...(document.querySelectorAll('tbody tr')[0]?.querySelectorAll('td') ?? [])].map((d) => d.innerText),
      hasPre: /1\/8/.test(document.body.innerText),
    }) },
];

const b = await chromium.launch();
for (const s of SHOTS) {
  if (only.length && !only.includes(s.n)) continue;
  for (const loc of ['en', 'ko']) {
    for (const w of [1280, 360]) {
      const ctx = await b.newContext({ viewport: { width: w, height: w === 360 ? 900 : 1000 }, locale: loc === 'ko' ? 'ko-KR' : 'en-US' });
      await ctx.addInitScript((l) => { try { localStorage.setItem('ainize.locale', l); } catch { /* ignore */ } }, loc);
      const p = await ctx.newPage();
      await p.goto(BASE + s.route, { waitUntil: 'networkidle' });
      if (s.allVersions) { await p.getByRole('button', { name: loc === 'ko' ? '모든 버전' : 'All versions', exact: true }).click().catch(() => {}); await p.waitForTimeout(800); }
      if (s.tab) await p.getByRole('tab', { name: loc === 'ko' ? /검증/ : /Verification/ }).click().catch(() => {});
      await p.evaluate(() => document.fonts.ready);
      await p.waitForTimeout(700);
      if (s.probe && w === 1280) console.log(`[${phase}] ${s.n} ${s.slug} ${loc}`, JSON.stringify(await p.evaluate(s.probe), null, 1));
      await p.screenshot({ path: `${OUT}/${s.n}-${s.slug}-${phase}-${w}-${loc}.png`, fullPage: true });
      await ctx.close();
    }
  }
}
await b.close();
