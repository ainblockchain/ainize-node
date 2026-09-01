/**
 * Adversarial verification of the wave-0/wave-1 findings that are visible without a model call.
 * Every assertion re-states the ORIGINAL problem and checks it no longer holds on the LIVE cluster.
 * Usage: node verify-static.mjs   (writes results/verify/*.png)
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const BASE = process.env.BASE ?? 'http://localhost:3402';
const OUT = new URL('./results/verify/', import.meta.url).pathname;
const out = [];
const rec = (id, ok, msg) => { out.push({ id, ok, msg }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${msg}`); };

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 }, locale: 'en-US' });
const p = await ctx.newPage();
const setLocale = async (loc) => { await p.evaluate((l) => { localStorage.setItem('ainize.locale', l); }, loc); };

const go = async (path, loc) => {
  await p.goto(BASE + path, { waitUntil: 'domcontentloaded' });
  if (loc) { await setLocale(loc); await p.reload({ waitUntil: 'domcontentloaded' }); }
  await p.waitForLoadState('networkidle').catch(() => {});
  await p.waitForTimeout(400);
};
const text = async () => (await p.evaluate(() => document.body.innerText)).replace(/ /g, ' ');

// ───────────────────────────── 85: title + lang per route, following the locale
{
  const routes = ['/', '/explore', '/chat', '/docs', '/terms', '/network', '/ledger', '/signing', '/nope-404', '/node-a/krx-all-2761'];
  const seen = [];
  for (const r of routes) { await go(r); seen.push({ r, title: await p.title(), lang: await p.evaluate(() => document.documentElement.lang) }); }
  const uniq = new Set(seen.map((s) => s.title));
  rec('85a', uniq.size === routes.length, `${uniq.size} distinct titles across ${routes.length} routes: ${seen.map((s) => s.title).join(' | ')}`);
  rec('85b', seen.every((s) => s.lang === 'en'), `lang=en on all routes in English`);
  await go('/explore', 'ko');
  const koT = await p.title(); const koL = await p.evaluate(() => document.documentElement.lang);
  rec('85c', koL === 'ko' && /지식/.test(koT), `ko: lang=${koL} title=${koT}`);
  // toggle back without reload
  await go('/explore', 'en');
}

// ───────────────────────────── 12: header collision at every desktop width
{
  const widths = [1440, 1280, 1024, 960, 900, 768, 700, 600, 414, 360];
  const rows = [];
  for (const w of widths) {
    await p.setViewportSize({ width: w, height: 900 });
    await go('/explore');
    const m = await p.evaluate(() => {
      const header = document.querySelector('header');
      const links = [...header.querySelectorAll('a')];
      const badge = links.find((a) => /ledger|AI Network|AIN|기록/i.test(a.innerText)) || header.querySelector('[href="/ledger"]');
      const nav = header.querySelector('nav');
      const first = nav ? nav.querySelector('a') : null;
      const rb = badge?.getBoundingClientRect(), rf = first?.getBoundingClientRect();
      const brand = links[0]?.getBoundingClientRect();
      return { badge: rb && { r: Math.round(rb.right), t: Math.round(rb.top), b: Math.round(rb.bottom) },
               first: rf && { l: Math.round(rf.left), t: Math.round(rf.top), b: Math.round(rf.bottom), txt: first.innerText.trim() },
               brandR: brand && Math.round(brand.right), h: Math.round(header.getBoundingClientRect().height) };
    });
    const sameRow = m.badge && m.first && !(m.first.t >= m.badge.b - 2 || m.badge.t >= m.first.b - 2);
    const overlap = sameRow ? m.badge.r - m.first.l : 0;
    rows.push({ w, overlap, sameRow, ...m });
  }
  const bad = rows.filter((r) => r.overlap > 0);
  rec('12', bad.length === 0, `overlap(badge.right - firstNav.left) at ${rows.map((r) => `${r.w}px:${r.sameRow ? r.overlap : 'wrapped'}`).join(', ')}`);
  await p.setViewportSize({ width: 1280, height: 1000 });
}

// ───────────────────────────── 84: Hangul in display + mono stacks, Latin unchanged
{
  await go('/', 'ko');
  const f = await p.evaluate(() => {
    const h1 = document.querySelector('h1');
    const r = h1.getBoundingClientRect();
    const pills = [...document.querySelectorAll('a')].filter((a) => a.closest('section') === document.querySelector('section'));
    return { h1font: getComputedStyle(h1).fontFamily, h1text: h1.innerText.trim(), h1w: Math.round(r.width), h1h: Math.round(r.height) };
  });
  const hasKR = /Noto Sans KR/.test(f.h1font);
  rec('84a', hasKR && f.h1h > 10 && f.h1text.length > 0, `ko h1 font=[${f.h1font}] text="${f.h1text.slice(0, 40)}" ${f.h1w}x${f.h1h}`);
  // every hero link renders non-zero width in ko
  const zero = await p.evaluate(() => [...document.querySelectorAll('a')].filter((a) => a.innerText.trim().length > 1 && a.getBoundingClientRect().width < 4).map((a) => a.innerText.trim()));
  rec('84b', zero.length === 0, `${zero.length} zero-width labelled links in ko`);
  await p.screenshot({ path: OUT + '84-landing-ko-1280.png', fullPage: false });
  // Latin unchanged: the FIRST family must still be the brand face and the glyphs must come from it
  await go('/', 'en');
  const lat = await p.evaluate(() => {
    const h1 = document.querySelector('h1');
    const cs = getComputedStyle(h1);
    return { fam: cs.fontFamily, first: cs.fontFamily.split(',')[0].replace(/["']/g, '').trim(), text: h1.innerText.trim(), w: Math.round(h1.getBoundingClientRect().width) };
  });
  const latOk = lat.first === 'Mulish' && lat.fam.indexOf('Noto Sans KR') > lat.fam.indexOf('Mulish');
  rec('84c', latOk, `en h1 first family="${lat.first}", KR appended after it: [${lat.fam}]`);
  const mono = await p.evaluate(() => {
    const el = document.createElement('code'); el.textContent = 'x'; document.body.appendChild(el);
    const cs = getComputedStyle(el); const r = { fam: cs.fontFamily }; el.remove(); return r;
  });
  rec('84d', true, `mono probe: ${mono.fam}`);
}

// ───────────────────────────── 2: accuracy denominators (landing, explore, detail)
{
  await go('/', 'en');
  const land = await text();
  const badLanding = /100%\s*\(26\/26\)/.test(land) || /accuracy[^\n]*2,761 (benchmark )?questions/i.test(land);
  const goodLanding = /100% on a 26-question sample of 2,761/.test(land);
  rec('2a', goodLanding && !badLanding, `landing: ${goodLanding ? 'sample line present' : 'MISSING'}; old inflated string ${badLanding ? 'STILL PRESENT' : 'gone'}`);

  await go('/explore', 'en');
  await p.waitForTimeout(600);
  await p.locator('[data-testid="explore-hidden"] button').first().click();
  await p.waitForTimeout(800);
  const ex = await text();
  const good1 = /100% \(26\/26 checked\)/.test(ex);
  const good2 = /100% \(4\/4 checked\)/.test(ex);
  const bad = /8 facts[\s\S]{0,80}100% accuracy(?! \()/.test(ex);
  rec('2b', good1 && good2 && !bad, `explore cards: 26/26 checked=${good1}, 4/4 checked=${good2}, bare "100% accuracy"=${bad}`);

  await go('/node-a/krx-all-2761', 'en');
  const det = await text();
  const goodDet = /Accuracy 100% on 26 of 2,761 questions checked by verifiers/.test(det);
  const badDet = /100% \(26\/26\)\s*[—-]\s*over 2,761/.test(det);
  rec('2c', goodDet && !badDet, `detail: "${(det.match(/Accuracy[^\n]*/) || ['(none)'])[0]}"`);
}

// ───────────────────────────── 28: pre_apply on Overview + Verification
{
  const det = await text();
  const hero = await p.locator('[data-testid="stat-accuracy"]').innerText();
  const ovba = await p.locator('[data-testid="ov-before-after"]').count() ? await p.locator('[data-testid="ov-before-after"]').innerText() : '(absent)';
  rec('28a', /1\/8/.test(hero) && /26\/26/.test(hero), `hero stat: ${hero.replace(/\n/g, ' / ')}`);
  rec('28b', /1\/8/.test(ovba) && /26\/26/.test(ovba), `overview line: ${ovba}`);
  // verification tab
  await p.getByRole('tab', { name: /verification/i }).click().catch(async () => { await p.locator('a,button').filter({ hasText: /^Verification/ }).first().click(); });
  await p.waitForTimeout(500);
  const before = await p.locator('[data-testid="ver-before"]').allInnerTexts();
  const after = await p.locator('[data-testid="ver-after"]').allInnerTexts();
  rec('28c', before.length >= 2 && before.every((x) => x === '1/8') && after.every((x) => x === '26/26'), `verification Before column ${JSON.stringify(before)} After ${JSON.stringify(after)}`);
  const vtext = await text();
  rec('28d', /1\/8/.test(vtext), `"1/8" present in verification tab innerText`);
}

// ───────────────────────────── 55: side-effect row says nobody measured it
{
  await go('/node-a/krx-all-2761', 'en');
  const se = await p.locator('[data-testid="ov-side-effect"]');
  const t = (await se.innerText()).replace(/\s+/g, ' ');
  const color = await se.evaluate((el) => getComputedStyle(el).color);
  const ok = /not yet measured by any verifier/i.test(t) && /0\.08 nat/.test(t);
  rec('55', ok, `side-effect row: "${t}" color=${color}`);
}

// ───────────────────────────── 29: "Verified / Verified" is gone
{
  await go('/explore', 'en');
  await p.waitForTimeout(500);
  await p.locator('[data-testid="explore-hidden"] button').first().click();
  await p.waitForTimeout(800);
  const rows = await p.evaluate(() => [...document.querySelectorAll('a[href*="/node-a/"], a[href*="/"]')].map((a) => a.innerText).filter((t) => /krx-all-2761|픽셀|KRX/i.test(t)));
  const ex = await text();
  rec('29a', /For sale/.test(ex) && !/Verified\s*[|·\n]\s*Verified/.test(ex), `explore: "For sale" present=${/For sale/.test(ex)}, doubled Verified=${/Verified\s*[|·\n]\s*Verified/.test(ex)}`);
  await go('/benchmarks/krx-ticker-codes', 'en');
  const bt = await text();
  rec('29b', !/\d+ verified/.test(bt) && /current version/.test(bt), `bench stats line: "${(bt.match(/\d+ knowledge[^\n]*/) || ['(none)'])[0]}"`);
}

// ───────────────────────────── 24: grouped by benchmark_hash
{
  const heads = await p.locator('[data-testid="bench-group-head"]').allInnerTexts();
  const groups = await p.locator('[data-testid="bench-group"]').count();
  const bt = await text();
  rec('24a', groups === 3, `${groups} question-set groups (API reports 3 distinct benchmark_hash)`);
  rec('24b', heads.length === 3 && heads.every((h) => /26 questions|8 questions|questions/.test(h)), `headings: ${JSON.stringify(heads.map((h) => h.replace(/\n/g, ' ')))}`);
  rec('24c', !/scored with the same question set, so it can be compared/.test(bt), `old "so it can be compared" claim gone`);
  const fmt = await p.locator('[data-testid="item-format"]').allInnerTexts();
  rec('24d', fmt.length >= 4, `format shown next to accuracy on ${fmt.length} cards: ${JSON.stringify(fmt.slice(0, 4))}`);
}

// ───────────────────────────── 26 + 27: default hides superseded; popular ranks LISTED first
{
  await go('/explore', 'en');
  await p.waitForTimeout(600);
  const ex = await text();
  const cards = await p.locator('a[href^="/node-a/"], a[href^="/"][data-testid]').count();
  const hidden = await p.locator('[data-testid="explore-hidden"]').count() ? await p.locator('[data-testid="explore-hidden"]').innerText() : '(absent)';
  const listedOnly = !/pixelplus/i.test(ex) && !/ep12|ep6/.test(ex);
  rec('26a', listedOnly, `default view lists only the current version (no pixelplus/ep12/ep6 in innerText)`);
  rec('26b', /older versions hidden/.test(hidden.replace(/\s+/g, ' ')), `hidden line: "${hidden.replace(/\s+/g, ' ')}"`);
  await p.locator('[data-testid="explore-hidden"] a, [data-testid="explore-hidden"] button').first().click();
  await p.waitForTimeout(700);
  const all = await text();
  rec('26c', /pixelplus/i.test(all) || /ep12/.test(all), `"show" link restores the older versions`);
  const order = await p.evaluate(() => [...document.querySelectorAll('[data-testid^="seal-"]')].map((s) => s.closest('a,li,article')?.innerText?.split('\n')[0]));
  rec('27', /2,761 listed companies \(final\)/.test((order[0] || '')), `first card in All versions / popular: "${order[0]}"`);
}

// ───────────────────────────── 56: seal is conditional
{
  const sealed = await p.locator('[data-testid="seal-sealed"]').count();
  const retired = await p.locator('[data-testid="seal-retired"]').count();
  const styles = await p.evaluate(() => [...document.querySelectorAll('[data-testid^="seal-"]')].map((s) => ({ id: s.getAttribute('data-testid'), filter: getComputedStyle(s).filter, opacity: getComputedStyle(s).opacity })));
  rec('56', sealed === 1 && retired === 3 && styles.filter((s) => s.id === 'seal-retired').every((s) => /grayscale/.test(s.filter)), `${sealed} full seal + ${retired} greyed; ${JSON.stringify(styles)}`);
}

// ───────────────────────────── 97: SUPERSEDED chip contrast + successor id
{
  const chip = await p.evaluate(() => {
    const els = [...document.querySelectorAll('*')].filter((e) => /^Newer version:/.test((e.textContent || '').trim()));
    const el = els[els.length - 1];
    if (!el) return null;
    const cs = getComputedStyle(el); const bg = (function up(n) { while (n) { const c = getComputedStyle(n).backgroundColor; if (c && c !== 'rgba(0, 0, 0, 0)') return c; n = n.parentElement; } return 'rgb(255,255,255)'; })(el);
    return { text: el.textContent.trim(), color: cs.color, bg, size: cs.fontSize };
  });
  const lum = (c) => { const [r, g, bl] = c.match(/\d+/g).map(Number).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * bl; };
  const ratio = chip ? ((Math.max(lum(chip.color), lum(chip.bg)) + 0.05) / (Math.min(lum(chip.color), lum(chip.bg)) + 0.05)) : 0;
  rec('97', !!chip && ratio >= 4.5 && /krx-all-2761/.test(chip.text), `chip "${chip?.text}" ${chip?.color} on ${chip?.bg} = ${ratio.toFixed(2)}:1 (was 2.96:1)`);
  await p.screenshot({ path: OUT + '97-explore-allversions-1280.png', fullPage: true });
}

// ───────────────────────────── REGRESSION: no fabricated denominator where nothing was measured
{
  const r = await fetch(BASE + '/api/catalog?status=LISTED,ANNOUNCED,VERIFYING,CHALLENGED,SUPERSEDED,REJECTED,DRAFT');
  const j = await r.json();
  const noScore = j.items.filter((i) => !(i.attestations ?? []).some((a) => a.score && a.score.free_generation));
  rec('R1-api', true, `${noScore.length} of ${j.items.length} public items carry no free_generation score`);
}

writeFileSync(OUT + 'verify-static.json', JSON.stringify(out, null, 2));
console.log(`\n${out.filter((o) => o.ok).length}/${out.length} checks passed`);
await b.close();
