/**
 * (a) Finding 1, the half a naive fix gets wrong: a column that never answered a turn must be LEFT OUT of that
 *     column's history, not faked. Sends After-only and Before-only turns, then a compare turn, and reads both
 *     wires.
 * (b) Finding 22: the Retry offered on a quota 429 did nothing. Exhausts one visitor's real hourly quota on the
 *     live node, then drives the 429 in a real browser and counts the requests the affordance issues.
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';

const BASE = 'http://localhost:3402';
const WIRE = new URL('./results/verify/model-wire.jsonl', import.meta.url).pathname;
const OUT = new URL('./results/verify/', import.meta.url).pathname;
const out = [];
const rec = (id, ok, msg) => { out.push({ id, ok, msg }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${msg}`); };
const wire = () => readFileSync(WIRE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const chatCalls = (from) => wire().filter((e) => e.n > from && /chat\/completions/.test(e.url));
const lastN = () => { const w = wire(); return w.length ? w[w.length - 1].n : 0; };
const one = (s) => (s ?? '').replace(/\s+/g, ' ').trim();
const rip = () => `10.${1 + Math.floor(Math.random() * 253)}.${1 + Math.floor(Math.random() * 253)}.${1 + Math.floor(Math.random() * 253)}`;

const b = await chromium.launch();

// ══════════════════════════════════════ (a) history of a column that never answered
{
  const ip = rip();
  const ctx = await b.newContext({ viewport: { width: 1280, height: 1100 }, locale: 'en-US' });
  await ctx.route((u) => u.port === '3402', (r) => r.continue({ headers: { ...r.request().headers(), 'x-forwarded-for': ip } }));
  const p = await ctx.newPage();
  const sent = [];
  p.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/api/chat')) { try { sent.push(JSON.parse(r.postData() ?? '{}')); } catch { /* */ } } });
  const turns = () => p.locator('main article');
  const send = async (text) => {
    const before = await turns().count();
    const box = p.locator('textarea');
    await p.waitForFunction(() => !document.querySelector('textarea')?.disabled, null, { timeout: 180_000 });
    await box.fill(text);
    await box.press('Enter');
    await turns().nth(before).waitFor({ timeout: 60_000 });
    await p.waitForFunction(() => document.querySelectorAll('main article [aria-busy="true"]').length === 0, null, { timeout: 15 * 60_000 });
    await p.waitForTimeout(600);
  };
  await p.goto(`${BASE}/chat/pixelplus-087600`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1500);
  await p.getByRole('radio', { name: 'After only', exact: true }).check();
  await send('종목코드 픽셀플러스 ');                     // only the PATCHED column answers this one
  await p.getByRole('radio', { name: 'Before only', exact: true }).check();
  await send('대한민국의 수도는? ');                       // only the BASE column answers this one
  await p.getByRole('radio', { name: 'Compare', exact: true }).check();
  await p.waitForTimeout(300);
  const mark = lastN();
  await send('방금 두 답을 한 줄로 요약해줘 ');            // compare turn: what does each column get replayed?
  const pay = sent.at(-1);
  const calls = chatCalls(mark);
  const users = (m) => (m ?? []).filter((x) => x.role === 'user').map((x) => one(x.content).slice(0, 20));
  console.log('  messages_base   users:', JSON.stringify(users(pay?.messages_base)));
  console.log('  messages_patched users:', JSON.stringify(users(pay?.messages_patched)));
  const bU = users(pay?.messages_base), pU = users(pay?.messages_patched);
  rec('1i', !bU.some((u) => /픽셀플러스/.test(u)) && bU.some((u) => /수도/.test(u)),
    `the base history replays the Before-only turn and NOT the After-only turn it never answered: ${JSON.stringify(bU)}`);
  rec('1j', pU.some((u) => /픽셀플러스/.test(u)) && !pU.some((u) => /수도/.test(u)),
    `the patched history replays the After-only turn and NOT the Before-only turn it never answered: ${JSON.stringify(pU)}`);
  rec('1k', calls.length === 2 && JSON.stringify(calls[0].body.messages) !== JSON.stringify(calls[1].body.messages),
    `node→model: ${calls.length} calls with different arrays (${calls.map((c) => c.body.messages.length).join(' vs ')} messages)`);
  await ctx.close();
}

// ══════════════════════════════════════ (b) finding 22 — the quota 429
{
  const ip = rip();
  const H = { 'content-type': 'application/json', 'x-forwarded-for': ip };
  const body = (extra = {}) => JSON.stringify({ patch_id: 'pixelplus-087600', mode: 'patched', max_tokens: 8, messages: [{ role: 'user', content: '종목코드 픽셀플러스 ' }], ...extra });
  let n = 0, last = null;
  const mark = lastN();
  for (let i = 0; i < 25; i++) {
    const r = await fetch(`${BASE}/api/chat`, { method: 'POST', headers: H, body: body() });
    last = { status: r.status, json: await r.json().catch(() => null) };
    if (r.status === 429) break;
    n++;
  }
  const spent = chatCalls(mark).length;
  rec('22a', last?.status === 429, `visitor ${ip}: ${n} live tests succeeded, then HTTP ${last?.status} (${spent} model calls actually issued)`);
  const qr = last?.json?.quota_reset;
  rec('22b', typeof qr === 'number' && qr > Date.now(), `the 429 body carries a measured quota_reset = ${qr} (${qr ? new Date(qr).toISOString() : 'absent'})`);

  // now the UI for that exhausted visitor
  const ctx = await b.newContext({ viewport: { width: 1280, height: 1100 }, locale: 'en-US' });
  await ctx.route((u) => u.port === '3402', (r) => r.continue({ headers: { ...r.request().headers(), 'x-forwarded-for': ip } }));
  const p = await ctx.newPage();
  let posts = 0;
  p.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/api/chat')) posts++; });
  await p.goto(`${BASE}/chat/pixelplus-087600`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1500);
  await p.locator('textarea').fill('종목코드 픽셀플러스 ');
  await p.locator('textarea').press('Enter');
  await p.waitForTimeout(4000);
  const postsAfterSend = posts;
  const txt = await p.evaluate(() => document.body.innerText);
  const retry = await p.getByRole('button', { name: 'Retry' }).count();
  const actions = await p.locator('[data-testid="chat-quota-actions"]').count() ? one(await p.locator('[data-testid="chat-quota-actions"]').innerText()) : '(absent)';
  rec('22c', retry === 0, `${retry} Retry button(s) on the quota error (was 1, and it was a no-op)`);
  rec('22d', /Buy this knowledge/.test(actions) && /reset/i.test(actions), `what is offered instead: "${actions}"`);
  const link = p.locator('[data-testid="chat-quota-actions"] a').first();
  const href = await link.getAttribute('href');
  await link.click();
  await p.waitForTimeout(2500);
  rec('22e', /pixelplus-087600/.test(p.url()), `the offered link (${href}) lands on the knowledge page: ${p.url()}`);
  rec('22f', posts === postsAfterSend, `clicking the affordance issued ${posts - postsAfterSend} further POST /api/chat (the old Retry issued 0 and looked broken; this one navigates)`);
  await p.goBack(); await p.waitForTimeout(1500);
  await p.screenshot({ path: OUT + '22-chat-quota-429-1280.png', fullPage: true });
  await ctx.close();
}

writeFileSync(OUT + 'verify-finding22.json', JSON.stringify(out, null, 2));
console.log(`\n${out.filter((o) => o.ok).length}/${out.length} checks passed`);
await b.close();
