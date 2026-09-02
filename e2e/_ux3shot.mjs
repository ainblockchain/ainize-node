import { chromium } from 'playwright';
const [,, base, route, name, outDir, pw] = process.argv;
const b = await chromium.launch();
for (const [W,H] of [[1280,1000],[360,780]]) for (const loc of ['en','ko']) {
  const ctx = await b.newContext({ viewport:{width:W,height:H}, locale: loc==='ko'?'ko-KR':'en-US' });
  await ctx.addInitScript((l)=>{ try{ localStorage.setItem('ainize.locale', l);}catch{} }, loc);
  const p = await ctx.newPage();
  if (pw) { // operator login via API cookie/token
    const r = await p.request.post(base + '/api/auth/login', { data: { password: pw } });
    const j = await r.json().catch(()=>({}));
    if (j.token) await ctx.addInitScript((t)=>{ try{ localStorage.setItem('ainize.token', t);}catch{} }, j.token);
  }
  await p.goto(base + route, { waitUntil:'domcontentloaded' });
  await p.waitForLoadState('networkidle').catch(()=>{});
  await p.waitForTimeout(1200);
  await p.screenshot({ path: `${outDir}/${name}-${loc}-${W}.png`, fullPage: true });
  if (loc==='en' && W===1280) console.log((await p.evaluate(()=>document.body.innerText)).slice(0, 3000));
  await ctx.close();
}
await b.close();
