/**
 * Finding 1 — measure the contamination and the fix on the live node.
 * Turn 1 (compare) → turn 2 sent twice: once with the OLD single-history shape (what the product used to send),
 * once with the split histories. Prints both base answers.
 */
const NODE = process.env.NODE_URL ?? 'http://localhost:3402';
const TOKEN = process.env.TOKEN;
const ID = process.env.PATCH ?? 'krx-all-2761';
const Q1 = '종목코드 픽셀플러스 ';
const FOLLOW = '방금 말한 종목코드를 숫자만 다시 알려줘';

async function chat(body) {
  const r = await fetch(`${NODE}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) },
    body: JSON.stringify({ patch_id: ID, mode: 'compare', max_tokens: 48, ...body }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(j)}`);
  return j;
}
const one = (s) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);

const t1 = await chat({ messages: [{ role: 'user', content: Q1 }] });
console.log('TURN 1  base   :', one(t1.base?.content));
console.log('TURN 1  patched:', one(t1.patched?.content));
console.log('TURN 1  history:', JSON.stringify(t1.history));

const shared = [{ role: 'user', content: Q1 }];
const patchedHist = [...shared, { role: 'assistant', content: t1.patched.content }, { role: 'user', content: FOLLOW }];
const baseHist = [...shared, { role: 'assistant', content: t1.base.content }, { role: 'user', content: FOLLOW }];

const old = await chat({ messages: patchedHist });
console.log('\nTURN 2 (old, one shared history — the patched answer replayed to both)');
console.log('  base   :', one(old.base?.content));
console.log('  patched:', one(old.patched?.content));
console.log('  history:', JSON.stringify(old.history));

const fixed = await chat({ messages: patchedHist, messages_base: baseHist, messages_patched: patchedHist });
console.log('\nTURN 2 (split histories — each column replays its own answers)');
console.log('  base   :', one(fixed.base?.content));
console.log('  patched:', one(fixed.patched?.content));
console.log('  history:', JSON.stringify(fixed.history));

const has = (s) => (s ?? '').replace(/\s/g, '').includes('087600');
console.log('\n087600 in the BEFORE column — old:', has(old.base?.content), ' split:', has(fixed.base?.content));
console.log('087600 in the AFTER  column — old:', has(old.patched?.content), ' split:', has(fixed.patched?.content));
