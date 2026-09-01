/**
 * Finding 1 in a real browser: two compare turns on /chat/krx-all-2761, with the wire payloads captured.
 * Usage: node wave1-chat.mjs [en|ko] [width]
 */
import { chromium } from 'playwright';

const OUT = '/mnt/newdata/ainize/knowledge-marketplace/packages/e2e/results/wave1';
const PORT = 3402;
const loc = process.argv[2] ?? 'en';
const W = Number(process.argv[3] ?? 1280);
const Q1 = '종목코드 픽셀플러스 ';
const FOLLOW = '방금 말한 종목코드를 숫자만 다시 알려줘';
const o = () => 1 + Math.floor(Math.random() * 253);
const ip = `10.${o()}.${o()}.${o()}`;

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: W, height: W === 360 ? 900 : 1000 }, locale: loc === 'ko' ? 'ko-KR' : 'en-US' });
await ctx.addInitScript((l) => { try { localStorage.setItem('ainize.locale', l); } catch { /* ignore */ } }, loc);
await ctx.route((u) => u.port === String(PORT), (route) => route.continue({ headers: { ...route.request().headers(), 'x-forwarded-for': ip } }));
const p = await ctx.newPage();
const payloads = [];
p.on('request', (r) => { if (r.url().endsWith('/api/chat') && r.method() === 'POST') payloads.push(r.postDataJSON()); });
await p.goto(`http://127.0.0.1:${PORT}/chat/krx-all-2761`, { waitUntil: 'networkidle' });

const turns = () => p.locator('main article');
async function send(text) {
  const before = await turns().count();
  const box = p.locator('textarea');
  await box.waitFor({ state: 'visible' });
  await box.fill(text);
  await box.press('Enter');
  const turn = turns().nth(before);
  await turn.waitFor();
  await p.waitForFunction((n) => document.querySelectorAll('main article')[n]?.querySelectorAll('[aria-busy="true"]').length === 0,
    before, { timeout: 10 * 60_000 });
  return turn;
}

await send(Q1);
await send(FOLLOW);
await p.waitForTimeout(600);

const facts = await p.evaluate(() => {
  const arts = [...document.querySelectorAll('main article')];
  const col = (a, re) => [...a.querySelectorAll('div[aria-busy]')].find((d) => re.test(d.innerText))?.innerText.replace(/\n+/g, ' | ') ?? null;
  return {
    turns: arts.length,
    t2_before: col(arts[1], /Before loading|넣기 전/),
    t2_after: col(arts[1], /After loading|넣은 후/),
    splitNote: document.querySelector('[data-testid="chat-split-history"]')?.textContent ?? null,
  };
});
console.log(`[${loc}/${W}]`, JSON.stringify(facts, null, 1));
console.log('payload[1] keys:', Object.keys(payloads[1] ?? {}).join(','));
console.log('payload[1] messages_base :', JSON.stringify(payloads[1]?.messages_base));
console.log('payload[1] messages_patched:', JSON.stringify(payloads[1]?.messages_patched));
console.log('087600 in the Before column of turn 2:', /087600/.test(facts.t2_before ?? ''));

await p.screenshot({ path: `${OUT}/01-chat-split-history-after-${W}-${loc}.png`, fullPage: true });
await ctx.close(); await b.close();
