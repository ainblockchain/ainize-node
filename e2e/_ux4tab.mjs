import { chromium } from 'playwright';
const [,, base, route, tabLabel, name, outDir, pw] = process.argv;
const b = await chromium.launch();
for (const [W,H] of [[1280,1000],[360,780]]) for (const loc of ['en','ko']) {
  const ctx = await b.newContext({ viewport:{width:W,height:H}, locale: loc==='ko'?'ko-KR':'en-US' });
  await ctx.addInitScript((l)=>{ try{ localStorage.setItem('ainize.locale', l);}catch{} }, loc);
  const p = await ctx.newPage();
  if (pw) { const r = await p.request.post(base + '/api/auth/login', { data: { password: pw } }); const j = await r.json().catch(()=>({})); if (j.token) await ctx.addInitScript((t)=>{ try{ localStorage.setItem('ainize.token', t);}catch{} }, j.token); }
  await p.goto(base + route, { waitUntil:'domcontentloaded' });
  await p.waitForLoadState('networkidle').catch(()=>{});
  await p.waitForTimeout(800);
  if (tabLabel) { const labels = tabLabel.split('|'); for (const l of labels) { const el = p.getByRole('tab', { name: l }).first(); if (await el.count()) { await el.click(); break; } const b2 = p.getByText(l, { exact: true }).first(); if (await b2.count()) { await b2.click(); break; } } await p.waitForTimeout(800); }
  await p.screenshot({ path: `${outDir}/${name}-${loc}-${W}.png`, fullPage: true });
  if (loc==='en' && W===1280) console.log((await p.evaluate(()=>document.body.innerText)).slice(0, 4000));
  await ctx.close();
}
await b.close();
