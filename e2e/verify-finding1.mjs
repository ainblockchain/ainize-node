/**
 * Finding 1, adversarially re-measured on the LIVE product with a wire capture on BOTH wires:
 *   browser → node   : the POST /api/chat payloads, intercepted in the page
 *   node    → model  : results/verify/model-wire.jsonl, written by model-tap.mjs (:8012 → :8002)
 * The original defect: from turn 2 the "Before loading" column was fed the PATCHED answer as its own history.
 * Also measures the regression the fix could have caused: patched-only / base-only must still be ONE model call.
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';

const BASE = 'http://localhost:3402';
const PATCH = 'krx-all-2761';
const Q1 = '종목코드 픽셀플러스 ';
const Q2 = '방금 말한 종목코드를 숫자만 다시 알려줘';
const EXPECT = '087600';
const WIRE = new URL('./results/verify/model-wire.jsonl', import.meta.url).pathname;
const OUT = new URL('./results/verify/', import.meta.url).pathname;
const out = [];
const rec = (id, ok, msg) => { out.push({ id, ok, msg }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${msg}`); };
const wire = () => readFileSync(WIRE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const chatCalls = (from) => wire().filter((e) => e.n > from && /chat\/completions/.test(e.url));
const one = (s) => (s ?? '').replace(/\s+/g, ' ').trim();

const b = await chromium.launch();
const ip = `10.${1 + Math.floor(Math.random() * 253)}.${1 + Math.floor(Math.random() * 253)}.${1 + Math.floor(Math.random() * 253)}`;
const ctx = await b.newContext({ viewport: { width: 1280, height: 1100 }, locale: 'en-US' });
await ctx.route((u) => u.port === '3402', (r) => r.continue({ headers: { ...r.request().headers(), 'x-forwarded-for': ip } }));
const p = await ctx.newPage();

const sent = [];
p.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/api/chat')) { try { sent.push(JSON.parse(r.postData() ?? '{}')); } catch { /* */ } } });
const replies = [];
p.on('response', async (r) => { if (r.request().method() === 'POST' && r.url().endsWith('/api/chat')) { try { replies.push(await r.json()); } catch { /* */ } } });

const turns = () => p.locator('main article');
async function send(text) {
  const before = await turns().count();
  const box = p.locator('textarea');
  await box.waitFor({ state: 'visible', timeout: 60_000 });
  await p.waitForFunction(() => !document.querySelector('textarea')?.disabled, null, { timeout: 120_000 });
  await box.fill(text);
  const mark = chatCalls(0).length ? chatCalls(0)[chatCalls(0).length - 1].n : 0;
  await box.press('Enter');
  const t = turns().nth(before);
  await t.waitFor({ timeout: 60_000 });
  await p.waitForFunction(() => document.querySelectorAll('main article [aria-busy="true"]').length === 0, null, { timeout: 15 * 60_000 });
  await p.waitForTimeout(700);
  return { turn: t, mark };
}

await p.goto(`${BASE}/chat/${PATCH}`, { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(1500);
const compare = p.getByRole('radio', { name: 'Compare', exact: true });
if (await compare.count()) await compare.check().catch(() => {});
await p.waitForTimeout(400);

// ───────────────────────────────────────────── TURN 1
const t1 = await send(Q1);
const cal1 = chatCalls(t1.mark);
console.log(`\nTURN 1 — ${cal1.length} model call(s) on the node→model wire`);
for (const c of cal1) console.log(`   #${c.n} msgs=${c.body.messages.length} last="${one(c.body.messages.at(-1).content).slice(0, 30)}" → "${one(c.answer).slice(0, 60)}"`);
const r1 = replies.at(-1);
console.log(`   node reply: base="${one(r1?.base?.content).slice(0, 70)}"  patched="${one(r1?.patched?.content).slice(0, 70)}"  history=${JSON.stringify(r1?.history)}`);
rec('1-t1', cal1.length === 2, `turn 1 compare issues exactly 2 model calls (base + patched), measured ${cal1.length}`);

// ───────────────────────────────────────────── TURN 2 — the defect's home
const t2 = await send(Q2);
const cal2 = chatCalls(t2.mark);
const payload2 = sent.at(-1);
const r2 = replies.at(-1);
console.log(`\nTURN 2 — ${cal2.length} model call(s)`);
for (const c of cal2) {
  console.log(`   #${c.n} msgs=${c.body.messages.length}`);
  c.body.messages.forEach((m, i) => console.log(`        [${i}] ${m.role}: ${one(m.content).slice(0, 80)}`));
  console.log(`        → "${one(c.answer).slice(0, 80)}"`);
}

// A. browser → node: two DIFFERENT histories left the page
const hb = JSON.stringify(payload2?.messages_base), hp = JSON.stringify(payload2?.messages_patched);
rec('1a', !!payload2?.messages_base && !!payload2?.messages_patched && hb !== hp,
  `browser→node POST /api/chat carries messages_base (${payload2?.messages_base?.length}) and messages_patched (${payload2?.messages_patched?.length}), different=${hb !== hp}`);
rec('1b', one(payload2?.messages_base?.[1]?.content) === one(r1?.base?.content) && one(payload2?.messages_patched?.[1]?.content) === one(r1?.patched?.content),
  `each column replays ITS OWN turn-1 answer: base←"${one(payload2?.messages_base?.[1]?.content).slice(0, 40)}" patched←"${one(payload2?.messages_patched?.[1]?.content).slice(0, 40)}"`);

// B. node → model: the two upstream calls carry DIFFERENT message arrays
const [c1, c2] = cal2;
const m1 = c1 && JSON.stringify(c1.body.messages), m2 = c2 && JSON.stringify(c2.body.messages);
rec('1c', cal2.length === 2 && m1 !== m2, `node→model wire: ${cal2.length} calls, message arrays differ = ${m1 !== m2}`);
const baseCall = cal2.find((c) => one(c.body.messages[1]?.content) === one(r1?.base?.content));
const patchedCall = cal2.find((c) => one(c.body.messages[1]?.content) === one(r1?.patched?.content));
rec('1d', !!baseCall && !!patchedCall && baseCall.n !== patchedCall.n,
  `the model was shown the base history on one call (#${baseCall?.n}) and the patched history on the other (#${patchedCall?.n})`);
const contaminated = cal2.some((c) => c.body.messages.some((m) => m.role === 'assistant' && m.content.includes(EXPECT))) && !r1?.base?.content?.includes(EXPECT);
rec('1e', !!baseCall && !baseCall.body.messages.some((m) => m.role === 'assistant' && m.content.includes(EXPECT)),
  `the BASE call is never shown the knowledge answer ${EXPECT} in its history`);

// C. the demo proves what it claims: base fails where patched succeeds, on turn 2
const b2 = one(r2?.base?.content), p2 = one(r2?.patched?.content);
rec('1f', p2.replace(/\s/g, '').includes(EXPECT) && !b2.replace(/\s/g, '').includes(EXPECT),
  `turn 2 answers — patched "${p2.slice(0, 60)}" contains ${EXPECT}; base "${b2.slice(0, 60)}" does not`);
rec('1g', r2?.history?.split === true, `node reports history ${JSON.stringify(r2?.history)}`);
const note = await p.evaluate(() => document.body.innerText);
rec('1h', /replays only its own earlier answers|자기(가| ) 답만|이전 답/.test(note), `the transcript states the rule to the visitor: ${(note.match(/On follow-up questions[^\n]*/) || ['(none)'])[0]}`);
await p.screenshot({ path: OUT + '01-chat-two-turn-compare-1280.png', fullPage: true });

// ───────────────────────────────────────────── FINDING 20 — expected answer as TEXT (same live turns)
{
  const txt = await p.evaluate(() => document.body.innerText);
  const ids = await p.evaluate(() => [...document.querySelectorAll('[data-testid^="chat-expected-"]')].map((e) => ({ id: e.getAttribute('data-testid'), t: e.innerText.trim() })));
  rec('20a', ids.length >= 2 && ids.every((x) => x.t.includes(EXPECT)), `visible expected nodes: ${JSON.stringify(ids)}`);
  rec('20b', txt.includes(EXPECT) && /Expected/.test(txt), `"Expected: ${EXPECT}" is in document.body.innerText (was tooltip-only)`);
  const chips = await p.evaluate(() => [...document.querySelectorAll('button')].filter((b) => /종목코드/.test(b.innerText)).map((b) => ({ text: b.innerText.replace(/\n/g, ' | '), aria: b.getAttribute('aria-label') })));
  rec('20c', chips.length > 0 && chips.some((c) => /\d{6}/.test(c.text)), `sample chips carry the expected value on a second line: ${JSON.stringify(chips.slice(0, 2))}`);
}

// ───────────────────────────────────────────── REGRESSION: single-column modes must issue ONE model call
{
  for (const [label, n] of [['After only', 1], ['Before only', 1]]) {
    const radio = p.getByRole('radio', { name: label, exact: true });
    await radio.check();
    await p.waitForTimeout(400);
    const t = await send(label === 'After only' ? '종목코드 삼성전자 ' : '종목코드 유라클 ');
    const calls = chatCalls(t.mark);
    rec(`R3-${label.replace(/ /g, '')}`, calls.length === n, `${label} mode issued ${calls.length} model call(s) (must be ${n}); histories sent: ${JSON.stringify(sent.at(-1)?.messages_base?.length ?? null)}/${JSON.stringify(sent.at(-1)?.messages_patched?.length ?? null)}`);
  }
}

writeFileSync(OUT + 'verify-finding1.json', JSON.stringify({ out, sent, wire: wire().filter((e) => /chat\/completions/.test(e.url)) }, null, 2));
console.log(`\n${out.filter((o) => o.ok).length}/${out.length} checks passed`);
await b.close();
