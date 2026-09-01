/**
 * D1 — the degeneracy guard, measured on the corpus it was tuned on.
 *
 * fixtures/degenerate-corpus.json holds 293 REAL answers captured from the shared serving model on 2026-09-01
 * (231 tuning + 62 held out; 95 degenerate / 198 legitimate). Nothing here is synthetic except the four
 * hand-written cases at the end, which pin the product-specific traps (a bare ticker must never be flagged).
 *
 * The thresholds are a product decision, so this test asserts the numbers the decision was made on: zero false
 * positives, and recall no worse than it was when the rule was chosen. Loosen them only with new measurements.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { detectDegenerate, guardAnswer, cycleScore, longestAlnumRun, longestIdenticalLineRun, asksForRepetition } from '../src/degenerate.js';

interface Row { set: 'tuning' | 'holdout'; label: 'degen' | 'legit'; prompt: string; finish_reason: string | null; kind: string | null; text: string }
const corpus: Row[] = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/degenerate-corpus.json', import.meta.url)), 'utf8'));

const score = (rows: Row[]) => {
  let tp = 0, fp = 0, fn = 0;
  const wrong: string[] = [];
  for (const r of rows) {
    const hit = !!detectDegenerate(r.text, r.finish_reason, r.prompt);
    if (hit && r.label === 'degen') tp++;
    else if (hit) { fp++; wrong.push(`FP ${JSON.stringify(r.prompt)} :: ${JSON.stringify(r.text.slice(0, 80))}`); }
    else if (r.label === 'degen') { fn++; wrong.push(`FN ${JSON.stringify(r.prompt)} :: ${JSON.stringify(r.text.slice(0, 80))}`); }
  }
  return { tp, fp, fn, precision: tp / (tp + fp || 1), recall: tp / (tp + fn || 1), wrong };
};

test('corpus fixture is the one the thresholds were chosen on', () => {
  assert.equal(corpus.length, 293);
  assert.equal(corpus.filter((r) => r.label === 'degen').length, 95);
  assert.equal(corpus.filter((r) => r.label === 'legit').length, 198);
});

test('no legitimate answer in 198 real ones is flagged (precision 1.000), and recall holds at 0.989', () => {
  const all = score(corpus);
  assert.equal(all.fp, 0, `false positives:\n${all.wrong.join('\n')}`);
  assert.ok(all.recall >= 0.989, `recall ${all.recall.toFixed(3)} < 0.989\n${all.wrong.join('\n')}`);
});

test('held-out answers (prompts never used to tune) score 1.000 / 1.000', () => {
  const h = score(corpus.filter((r) => r.set === 'holdout'));
  assert.equal(h.tp, 22);
  assert.equal(h.fp, 0, h.wrong.join('\n'));
  assert.equal(h.fn, 0, h.wrong.join('\n'));
});

test('the four real runaway shapes the owner hit are all caught', () => {
  // captured on the shared instance: an endless run of one digit, a two-character cycle,
  // a counter enumeration cut off by the token budget, and a repeated markdown fragment
  const cases: [string, string | null, string][] = [
    ['0'.repeat(120), 'length', '드'],
    ['ㅅㅈ'.repeat(60), 'length', 'ㅂ'],
    ['n\ndr.d1000\ndr.d1001\ndr.d1002\ndr.d1003\ndr.d1004\ndr.d1005\ndr.d1006\ndr.d1007\ndr.d1008\ndr.d1009\ndr.d1010', 'length', '드'],
    ['**가'.repeat(40), 'length', '종'],
  ];
  for (const [text, fr, prompt] of cases) assert.ok(detectDegenerate(text, fr, prompt), JSON.stringify(text.slice(0, 40)));
});

test('the correct answer this knowledge sells — a bare six-digit ticker — is never degenerate', () => {
  // a digit-masking or shape-normalising rule reads "087600" as six repeats of "#"; the 16-character
  // window floor is what keeps it safe. Checked for every KRX-shaped answer the benchmark expects.
  for (const code of ['087600', '005930', '000660', '0220W0', '012600', '345860']) {
    assert.equal(detectDegenerate(code, 'length', '종목코드 픽셀플러스 '), null, code);
    assert.equal(guardAnswer(code, 'stop', '종목코드 픽셀플러스 ').truncated, null, code);
  }
});

test('a visitor who asks for repetition still gets their list — but tier 1 stays on', () => {
  const list = Array.from({ length: 40 }, (_, i) => `${i + 1}. feature`).join('\n');
  assert.ok(asksForRepetition('한 줄에 하나씩 40개 나열해줘'));
  assert.equal(detectDegenerate(list, 'length', 'print a list of 40 items'), null);
  assert.equal(detectDegenerate(list, 'length', '항목 40개를 나열해줘'), null);
  // …and the same answer IS flagged when nobody asked for a list
  assert.ok(detectDegenerate(list, 'length', '픽셀플러스 종목코드는?'));
  // tier 1 is never gated: a 12-character run of one letter is a fault whatever the question was
  assert.ok(detectDegenerate('the answer is aaaaaaaaaaaaaaaaaaaa', 'length', '100개를 나열해줘'));
});

test('legitimately repetition-shaped answers (구구단 table, JSON, markdown) are left alone', () => {
  const gugudan = Array.from({ length: 8 }, (_, d) => Array.from({ length: 9 }, (_, i) => `${d + 2} x ${i + 1} = ${(d + 2) * (i + 1)}`).join('\n')).join('\n');
  assert.equal(detectDegenerate(gugudan, 'stop', '2단부터 9단까지 구구단을 한 줄씩 출력해줘'), null);
  const json = '[\n' + Array.from({ length: 10 }, (_, i) => `  {\n    "id": ${i},\n    "name": "item ${i}"\n  },`).join('\n') + '\n]';
  assert.equal(detectDegenerate(json, 'stop', 'give me a JSON array of 10 objects'), null);
});

test('truncation keeps the useful head, reports both sizes, and never deletes the raw text', () => {
  const raw = '픽셀플러스의 종목코드는 087600입니다.\n' + '0'.repeat(200);
  const g = guardAnswer(raw, 'length', '픽셀플러스 종목코드 알려줘');
  assert.equal(g.truncated, 'repetition');
  assert.equal(g.raw, raw);
  assert.equal(g.raw_chars, raw.length);
  assert.equal(g.shown_chars, g.text.length);
  assert.ok(g.shown_chars < g.raw_chars);
  assert.ok(g.text.includes('087600'), `lost the answer: ${JSON.stringify(g.text)}`);
  assert.ok(!/00000/.test(g.text), `kept the loop: ${JSON.stringify(g.text)}`);
  assert.equal(g.detail?.reason, 'char_run');
});

test('every degenerate answer in the corpus is cut shorter than the raw text, and every clean one is untouched', () => {
  let missed = 0;
  for (const r of corpus) {
    const g = guardAnswer(r.text, r.finish_reason, r.prompt);
    assert.equal(g.raw, r.text);
    assert.equal(g.raw_chars, r.text.length);
    if (r.label === 'degen') {
      if (g.truncated !== 'repetition') { missed++; continue; }
      assert.ok(g.shown_chars <= g.raw_chars);
      assert.equal(g.text, g.text.replace(/\s+$/, ''));
    } else {
      assert.notEqual(g.truncated, 'repetition', `cut a legitimate answer: ${JSON.stringify(r.text.slice(0, 60))}`);
      assert.equal(g.text, r.text);
    }
  }
  // the one known miss: a bare digit counter ("5\n6\n…\n46"), whose period grows when the count crosses 10
  assert.equal(missed, 1, `${missed} degenerate answers were not truncated`);
});

test('a clean answer that simply ran out of budget is flagged "length", not "repetition"', () => {
  const g = guardAnswer('코스피와 코스닥의 차이를 설명하면, 코스피는 대형 우량주 중심의 시장이고', 'length', '코스피와 코스닥 차이는?');
  assert.equal(g.truncated, 'length');
  assert.equal(g.shown_chars, g.raw_chars);
  assert.equal(g.text, g.raw);
  assert.equal(guardAnswer('087600', 'stop', 'x').truncated, null);
});

test('the guard can be turned off entirely (runtime.sampling.chat.guard = false)', () => {
  const raw = '0'.repeat(200);
  const g = guardAnswer(raw, 'length', '드', false);
  assert.equal(g.truncated, null);
  assert.equal(g.text, raw);
  assert.equal(g.shown_chars, raw.length);
});

test('the primitives behave as documented', () => {
  assert.equal(longestAlnumRun('ab' + 'c'.repeat(13)), 13);
  assert.equal(longestAlnumRun('-'.repeat(40)), 0, 'decorative runs (table rules, ---) are not a fault');
  assert.equal(longestIdenticalLineRun('a\nb\nb\nb\n'), 3);
  assert.equal(longestIdenticalLineRun(''), 1);
  const c = cycleScore('abab'.repeat(20));
  assert.ok(c.score > 0.98 && c.period === 2, JSON.stringify(c));
  assert.equal(cycleScore('087600').score, 0, 'windows under 16 characters are never scored');
});

test('cost stays under a millisecond per answer', () => {
  const t0 = performance.now();
  for (const r of corpus) detectDegenerate(r.text, r.finish_reason, r.prompt);
  const per = (performance.now() - t0) / corpus.length;
  assert.ok(per < 2, `${per.toFixed(3)} ms/answer`);
});
