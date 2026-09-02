/** The same wave-0/1 findings re-checked in Korean and at 360 px — several were reported with Korean evidence. */
import { chromium } from 'playwright';
const BASE = 'http://localhost:3402';
const OUT = new URL('./results/verify/', import.meta.url).pathname;
const out = [];
const rec = (id, ok, msg) => { out.push({ id, ok, msg }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${msg}`); };
const b = await chromium.launch();

for (const [W, H] of [[1280, 1000], [360, 780]]) {
  const ctx = await b.newContext({ viewport: { width: W, height: H }, locale: 'ko-KR' });
  await ctx.addInitScript(() => { try { localStorage.setItem('ainize.locale', 'ko'); } catch { /* */ } });
  const p = await ctx.newPage();
  const go = async (r) => { await p.goto(BASE + r, { waitUntil: 'domcontentloaded' }); await p.waitForLoadState('networkidle').catch(() => {}); await p.waitForTimeout(600); };
  const txt = async () => (await p.evaluate(() => document.body.innerText)).replace(/ /g, ' ');

  // 12 — header collision in Korean ("AI Network지식 둘러보기" in the critique)
  await go('/explore');
  const m = await p.evaluate(() => {
    const h = document.querySelector('header'); const nav = h.querySelector('nav');
    // the ledger BADGE lives in the Home block, not in the nav (the nav has its own /ledger link: "Public record" / "공개 기록")
    const badge = [...h.querySelectorAll('a, span, div')].find((e) => !e.children.length && !nav?.contains(e) && /AI ?Network/i.test(e.innerText || ''));
    const first = nav?.querySelector('a');
    const rb = badge?.getBoundingClientRect(), rf = first?.getBoundingClientRect();
    return { br: rb && Math.round(rb.right), bt: rb && Math.round(rb.top), bb: rb && Math.round(rb.bottom), fl: rf && Math.round(rf.left), ft: rf && Math.round(rf.top), fb: rf && Math.round(rf.bottom), ftxt: first?.innerText.trim() };
  });
  const sameRow = !(m.ft >= m.bb - 2 || m.bt >= m.fb - 2);
  rec(`12-ko-${W}`, !sameRow || m.br <= m.fl, `${W}px ko: badge.right=${m.br} first nav "${m.ftxt}".left=${m.fl} ${sameRow ? `overlap=${m.br - m.fl}` : 'different rows'}`);

  // 84/85 — Korean landing renders, title + lang follow the locale
  await go('/');
  const f = await p.evaluate(() => { const h = document.querySelector('h1'); const r = h.getBoundingClientRect(); return { t: h.innerText.trim(), w: Math.round(r.width), h: Math.round(r.height), fam: getComputedStyle(h).fontFamily }; });
  rec(`84-ko-${W}`, f.t.length > 0 && f.h > 10 && /Noto Sans KR/.test(f.fam), `${W}px ko h1 "${f.t}" ${f.w}x${f.h}`);
  rec(`85-ko-${W}`, (await p.evaluate(() => document.documentElement.lang)) === 'ko' && /Ainize/.test(await p.title()), `${W}px lang=${await p.evaluate(() => document.documentElement.lang)} title="${await p.title()}"`);
  const land = await txt();
  rec(`2-ko-${W}`, /2,761문항 중 26문항 표본|26문항 표본/.test(land) && !/100% \(26\/26\)/.test(land), `${W}px landing accuracy: "${(land.match(/[^\n]*표본[^\n]*/) || ['(none)'])[0]}"`);

  // 26/29/56/97 — explore in Korean, all versions
  await go('/explore');
  const hid = await p.locator('[data-testid="explore-hidden"]').count() ? (await p.locator('[data-testid="explore-hidden"]').innerText()).replace(/\s+/g, ' ') : '(absent)';
  rec(`26-ko-${W}`, /숨겨/.test(hid), `${W}px hidden line: "${hid}"`);
  await p.locator('[data-testid="explore-hidden"] button').first().click();
  await p.waitForTimeout(900);
  const ex = await txt();
  rec(`29-ko-${W}`, /판매 중/.test(ex) && !/검증 완료\s*\n?\s*검증 완료/.test(ex), `${W}px "판매 중" present, doubled 검증 완료 gone`);
  const chip = await p.evaluate(() => { const e = [...document.querySelectorAll('*')].filter((x) => /^최신 버전:/.test((x.textContent || '').trim())).pop(); return e && { t: e.textContent.trim(), c: getComputedStyle(e).color, bg: getComputedStyle(e).backgroundColor }; });
  rec(`97-ko-${W}`, !!chip && chip.c === 'rgb(138, 75, 0)' && /krx-all-2761/.test(chip.t), `${W}px chip "${chip?.t}" ${chip?.c} on ${chip?.bg}`);
  const seals = await p.evaluate(() => [...document.querySelectorAll('[data-testid^="seal-"]')].map((s) => s.getAttribute('data-testid')));
  rec(`56-ko-${W}`, seals.filter((s) => s === 'seal-sealed').length === 1 && seals.filter((s) => s === 'seal-retired').length === 3, `${W}px seals: ${JSON.stringify(seals)}`);
  await p.screenshot({ path: `${OUT}explore-ko-${W}.png`, fullPage: true });

  // 24/28/55 in Korean
  await go('/benchmarks/krx-ticker-codes');
  const gh = await p.locator('[data-testid="bench-group-head"]').allInnerTexts();
  rec(`24-ko-${W}`, gh.length === 3, `${W}px ${gh.length} group headings: ${JSON.stringify(gh.map((x) => x.replace(/\n/g, ' ')))}`);
  await go('/node-a/krx-all-2761');
  await p.waitForSelector('[data-testid="ov-side-effect"]', { timeout: 30_000 });
  const hero = await p.locator('[data-testid="stat-accuracy"]').innerText();
  const ba = await p.locator('[data-testid="ov-before-after"]').innerText();
  const se = (await p.locator('[data-testid="ov-side-effect"]').innerText()).replace(/\s+/g, ' ');
  rec(`28-ko-${W}`, /1\/8/.test(hero) && /1\/8/.test(ba), `${W}px hero "${hero.replace(/\n/g, ' / ')}" line "${ba}"`);
  rec(`55-ko-${W}`, /측정되지 않|아직/.test(se), `${W}px side-effect "${se}"`);
  await p.screenshot({ path: `${OUT}detail-ko-${W}.png`, fullPage: true });
  await ctx.close();
}

// 85 — the toggle changes lang and title WITHOUT a reload
{
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US' });
  const p = await ctx.newPage();
  await p.goto(BASE + '/explore', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1200);
  const before = { lang: await p.evaluate(() => document.documentElement.lang), title: await p.title() };
  let reloaded = false; p.on('framenavigated', (fr) => { if (fr === p.mainFrame()) reloaded = true; });
  await p.getByRole('button', { name: /한국어|Korean/ }).first().click().catch(async () => { await p.locator('a,button').filter({ hasText: '한국어' }).first().click(); });
  await p.waitForTimeout(1200);
  const after = { lang: await p.evaluate(() => document.documentElement.lang), title: await p.title() };
  rec('85-toggle', before.lang === 'en' && after.lang === 'ko' && before.title !== after.title && !reloaded,
    `toggle: lang ${before.lang}→${after.lang}, title "${before.title}"→"${after.title}", page reloaded=${reloaded}`);
  await ctx.close();
}

console.log(`\n${out.filter((o) => o.ok).length}/${out.length} checks passed`);
await b.close();
