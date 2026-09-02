/**
 * Degeneracy guard for free-generation answers (D1 — "드" → a ticker followed by an endless run of "0").
 *
 * Pure functions, no I/O. Thresholds validated on 293 REAL answers captured from the shared serving model
 * (231 tuning + 62 held out; PROBE B): precision 1.000, recall 0.989 overall, 1.000/1.000 on the held-out set.
 * The captured corpus is checked in at test/fixtures/degenerate-corpus.json and the numbers above are
 * re-asserted by test/degenerate.test.ts.
 *
 * Why character level rather than tokens: half of the real loops are unsegmented — "hthtqhthtq…", "0000000",
 * "**가**가**가…", "ééééé" — a single whitespace token, so token-level unique-ratio and n-gram rules score them
 * as perfectly diverse. Korean/CJK answers have the same property.
 *
 * Why two tiers: a visitor may legitimately ask for repetition ("한 줄에 하나씩 40개 나열해줘", "repeat it 30 times",
 * a 구구단 table). Those answers are byte-for-byte the shape of a runaway, so the broad rules are skipped when the
 * prompt asked for a list — but the narrow tier-1 rules (a run of one letter/digit, a near-perfect period ≤ 4
 * cycle) cannot be produced by any legitimate answer and stay on for every prompt.
 *
 * Four exemptions were added after an adversarial pass (2026-09-01) found eleven false positives on real
 * generations — legitimate answers the shipped rule cut or mislabelled. Each is measured: none of them changes
 * precision or recall on the 293-answer corpus (still 1.000 / 0.989, same single miss), and together they take
 * the adversarial false-positive count from 11/57 to 0/57.
 *
 *   1. A window shorter than 32 characters is never scored (MIN_WINDOW). The correct answer this product sells
 *      is a bare six-digit ticker; "1000000000000000" (10^15) and "ㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋ" are
 *      complete, correct answers too, and every real runaway in the corpus is far longer.
 *   2. A digit run inside a plain number is not a loop (`numericLiteral`): "10^15 = 1000000000000000" was cut to
 *      1000000000000, i.e. the guard silently turned a right answer into a wrong one.
 *   3. A cycle whose window is punctuation on a single line, when the model then stopped by itself, is markdown
 *      furniture — a horizontal rule, a dot leader, a table separator row — not a loop. Cutting the separator row
 *      out of "| A | B |\n|---|---|" stops the table rendering at all.
 *   4. The weakest rule (ran to the budget, cycle ≥ 0.70) additionally requires the repetition to be in the
 *      CONTENT, not just in the layout: a markdown table of Korean provinces scores 0.74 because the pipes,
 *      spaces and digit groups line up, while the province names — the part that carries meaning — are all
 *      different. A real loop repeats the letters and digits too.
 */

export type DegenerateReason = 'cycle' | 'cycle_truncated' | 'char_run' | 'line_run';
export interface DegenerateVerdict {
  reason: DegenerateReason;
  /** cycle rules: the match ratio 0..1; run rules: the run length. */
  score: number;
  /** cycle rules: the repeating period in characters; run rules: 0. */
  period: number;
}

const WINDOWS = [32, 64, 128, 256, 512];
const MAX_PERIOD = 64;
const MIN_CYCLES = 4;
/** A window shorter than this is never scored — no answer this short is called a loop (see exemption 1 above). */
export const MIN_WINDOW = 32;
/** Longest run of one digit that is still explainable as a plain number ("1" followed by 19 zeros = 10^19). */
const MAX_NUMERIC_LITERAL = 20;
/** A window with at most this fraction of letters/digits is layout, not language. */
const DECOR_MAX_ALNUM = 0.1;
/** `finish_reason === 'length'` + this cycle score is a loop only if the letters/digits repeat too. */
const CONTENT_MATCH_MIN = 0.6;

/** Decorative characters may legitimately run (table rules, ```, ---, whitespace); letters and digits may not. */
const DECOR = new Set([...'-=_*#~ .·|/\\+<>`\'"[](){}—–…\t\n\r,;:!?']);
const isAlnum = (ch: string): boolean => !DECOR.has(ch) && /[\p{L}\p{N}]/u.test(ch);

export interface CycleScore {
  /** Highest fraction of characters that repeat at some period p (1..64) inside some tail window. */
  score: number;
  period: number;
  window: number;
  /** That window is ≥ 90% punctuation/whitespace — a rule, a dot leader, a table separator. */
  decor: boolean;
  /** …and holds no line break, so it is one line of layout rather than a block that keeps going. */
  oneLine: boolean;
  /** The same match ratio counted only over letters/digits: is the CONTENT repeating, or only the layout? */
  alnum: number;
}

/** Highest fraction of characters that repeat at some period p (1..64) inside some tail window of `s`. */
export function cycleScore(s: string): CycleScore {
  const n = s.length;
  let best: CycleScore = { score: 0, period: 0, window: 0, decor: false, oneLine: false, alnum: 0 };
  for (const W of WINDOWS) {
    if (n < W && W !== WINDOWS[0] && n < WINDOWS[0]) break;
    const w = s.slice(-Math.min(W, n));
    const m = w.length;
    if (m < MIN_WINDOW) continue;
    // The letter/digit test is a Unicode regex; hoisted out of the O(window × period) loop it runs m times per
    // window instead of m × 64 (without this the detector costs ~4 ms per answer instead of ~0.3 ms).
    const alnumAt = new Uint8Array(m);
    let alnumChars = 0;
    for (let i = 0; i < m; i++) if (isAlnum(w[i])) { alnumAt[i] = 1; alnumChars++; }
    const decor = alnumChars / m <= DECOR_MAX_ALNUM;
    const oneLine = !w.includes('\n');
    const maxP = Math.min(MAX_PERIOD, Math.floor(m / MIN_CYCLES));
    for (let p = 1; p <= maxP; p++) {
      let hit = 0, alnumHit = 0, alnumTotal = 0;
      for (let i = 0; i < m - p; i++) {
        const eq = w[i] === w[i + p];
        if (eq) hit++;
        if (alnumAt[i]) { alnumTotal++; if (eq) alnumHit++; }
      }
      const r = hit / (m - p);
      if (r > best.score) best = { score: r, period: p, window: m, decor, oneLine, alnum: alnumTotal ? alnumHit / alnumTotal : 0 };
    }
  }
  return best;
}

export interface RunInfo {
  /** Longest run of one identical letter/digit ("0000000000000", "ééééé"). */
  len: number;
  /** That character is a digit. */
  digit: boolean;
  /** …and the whole digit token around it reads as a plain number ("1000000000000000"), not a flood ("087600000000…"). */
  numericLiteral: boolean;
}

/**
 * The longest run of one identical letter/digit, and whether it is explainable.
 *
 * A run of zeros is the D1 signature, but it is also how every large round number is written. The run is treated
 * as a number when the digit token around it has no leading zero, is at most MAX_NUMERIC_LITERAL long and is not
 * glued to a letter — so "1000000000000000" (10^15) is a number while "0000000000000o" and "087600000000…" are
 * not. Nothing is lost: a genuine digit flood is longer than a window, and the cycle rule catches it at ≥ 0.98.
 */
export function longestRun(s: string): RunInfo {
  const a = [...s];
  let len = 0, ch = '', end = -1, cur = 0, prev = '';
  for (let i = 0; i < a.length; i++) {
    const alnum = isAlnum(a[i]);
    if (a[i] === prev && alnum) { cur++; if (cur > len) { len = cur; ch = a[i]; end = i; } } else cur = alnum ? 1 : 0;
    prev = a[i];
  }
  if (!len) return { len: 0, digit: false, numericLiteral: false };
  const digit = /[0-9]/.test(ch);
  let numericLiteral = false;
  if (digit) {
    let l = end, r = end;
    while (l > 0 && /[0-9]/.test(a[l - 1])) l--;
    while (r < a.length - 1 && /[0-9]/.test(a[r + 1])) r++;
    const token = a.slice(l, r + 1).join('');
    const glued = (l > 0 && isAlnum(a[l - 1])) || (r < a.length - 1 && isAlnum(a[r + 1]));
    numericLiteral = !glued && token.length <= MAX_NUMERIC_LITERAL && /^[1-9][0-9]*$/.test(token);
  }
  return { len, digit, numericLiteral };
}

/** Longest run of one identical letter/digit ("0000000000000", "ééééé"). */
export function longestAlnumRun(s: string): number { return longestRun(s).len; }

/** Longest run of identical non-empty consecutive lines ("The market is open." × 30). */
export function longestIdenticalLineRun(s: string): number {
  const lines = s.split('\n').map((l) => l.trim());
  let best = 1, cur = 1;
  for (let i = 1; i < lines.length; i++) { cur = lines[i] === lines[i - 1] && lines[i] ? cur + 1 : 1; if (cur > best) best = cur; }
  return best;
}

/**
 * The visitor explicitly asked for a long list / N repetitions — repetition is then the answer, not a fault.
 * Keyword based on purpose (Korean + English); a documented limitation, not a solved problem: writing 나열 or
 * 반복 in a question turns tier 2 off for that turn, which is why tier 1 must stand on its own.
 *
 * Single-digit counts are included after the adversarial pass: "show 8 identical lines of log output" and
 * "list the same reminder 8 times" both got their answers cut by a rule meant for runaways.
 */
const ENUM_INTENT =
  /(?:\b(?:list|print|output|repeat|enumerate|number|write out|give me|show|draw)\b[\s\S]{0,60}?\b\d+\b)|(?:\b\d+\b[\s\S]{0,40}?\b(?:times|rows|items|lines|objects|identical|copies)\b)|(?:\bidentical\b)|(?:\bsame\b[\s\S]{0,40}?\b\d+\b)|(?:\d+\s*(?:to|through|~|부터)\s*\d+)|(?:\d+\s*(?:개|줄|번|행|까지|단))|(?:한 줄에 하나씩)|나열|반복|구구단/i;
export function asksForRepetition(prompt: string): boolean { return ENUM_INTENT.test(prompt ?? ''); }

/**
 * Did the model get stuck repeating itself? `null` = the answer looks fine.
 * `finishReason` is the upstream finish_reason ("length" means the loop ran to the token budget).
 */
export function detectDegenerate(text: string, finishReason?: string | null, prompt = ''): DegenerateVerdict | null {
  if (!text) return null;
  const c = cycleScore(text);
  // A single line of punctuation the model then finished with is layout (a rule, a dot leader, a table
  // separator row), not a loop. One that fills the token budget, or runs on across lines, still is.
  const furniture = c.decor && c.oneLine && finishReason !== 'length';
  // ---- tier 1: shapes no legitimate answer to ANY question produces (never gated by the prompt)
  const run = longestRun(text);
  if (!run.numericLiteral && run.len >= (run.digit ? 12 : 24)) return { reason: 'char_run', score: run.len, period: 0 };
  if (c.score >= 0.98 && c.period <= 4 && c.period > 0 && !furniture) return { reason: 'cycle', score: c.score, period: c.period };
  // ---- tier 2: real loops that a "list 80 items" answer is genuinely indistinguishable from
  if (asksForRepetition(prompt)) return null;
  if (c.score >= 0.90 && !furniture) return { reason: 'cycle', score: c.score, period: c.period };
  // Ran out of budget while cycling — but only when the letters and digits repeat too, or when there are
  // none at all (a punctuation flood). A table or a CSV lines up its layout without repeating its content.
  if (finishReason === 'length' && c.score >= 0.70 && !furniture && (c.decor || c.alnum >= CONTENT_MATCH_MIN))
    return { reason: 'cycle_truncated', score: c.score, period: c.period };
  const lines = longestIdenticalLineRun(text);
  if (lines >= 6) return { reason: 'line_run', score: lines, period: 0 };
  return null;
}

export interface GuardResult {
  /** What to show the visitor: the answer cut at the point the model started repeating itself. */
  text: string;
  /** The model's full output, kept so the UI can offer "show the raw answer". */
  raw: string;
  /** null = nothing was cut. 'repetition' = the loop guard cut it; 'length' = the model ran out of budget. */
  truncated: 'repetition' | 'length' | null;
  shown_chars: number;
  raw_chars: number;
  /** Present when `truncated === 'repetition'`: which rule fired, at what score and period. */
  detail?: DegenerateVerdict;
}

/**
 * Cut back to the last line/sentence/word boundary so the shown answer does not end mid-word — but never so far
 * back that the answer itself is lost. Its own floor, deliberately NOT MIN_WINDOW: the detector's window floor
 * says how much text it takes to recognise a loop, this says how little may be kept, and tying them together
 * left twelve zeros on the end of "…087600입니다." when the window floor was raised.
 */
const MIN_KEEP = 16;
function tidyCut(text: string, at: number): string {
  const head = text.slice(0, at);
  for (const re of [/[\s\S]*[\n]/, /[\s\S]*[.!?。！？]/, /[\s\S]*\s/]) {
    const m = re.exec(head);
    if (m && m[0].length >= Math.max(MIN_KEEP, at * 0.5)) return m[0].replace(/\s+$/, '');
  }
  return head.replace(/\s+$/, '');
}

/**
 * Smallest prefix that already looks degenerate (binary search — degeneracy is monotone in prefix length once the
 * loop is inside the tail window). Returns the raw length when no prefix trips the detector.
 */
function loopStart(text: string, finishReason: string | null | undefined, prompt: string): number {
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (detectDegenerate(text.slice(0, mid), finishReason, prompt)) hi = mid; else lo = mid + 1;
  }
  return lo;
}

/**
 * Apply the guard to one generated answer. A degenerate answer is TRUNCATED, never deleted: the visitor sees the
 * useful head plus a plain sentence, and can still open the raw text (PROBE B — no content-only rule can be perfect
 * in principle, so discarding the model's text is a worse failure than showing it with a caveat).
 */
export function guardAnswer(text: string, finishReason?: string | null, prompt = '', enabled = true): GuardResult {
  const raw = text ?? '';
  const base: GuardResult = { text: raw, raw, truncated: null, shown_chars: raw.length, raw_chars: raw.length };
  if (!enabled) return base;
  // An empty answer that hit the token budget is the thinking-budget case (the reasoning channel ate the
  // budget and `content` came back ""). Say "cut off", never render it as a blank bubble.
  if (!raw) return finishReason === 'length' ? { ...base, truncated: 'length' } : base;
  const verdict = detectDegenerate(raw, finishReason, prompt);
  if (verdict) {
    const cut = tidyCut(raw, loopStart(raw, finishReason, prompt));
    return { text: cut, raw, truncated: 'repetition', shown_chars: cut.length, raw_chars: raw.length, detail: verdict };
  }
  // Not a loop, but the model ran out of budget mid-answer — say so rather than let it look like a complete reply.
  if (finishReason === 'length') return { ...base, truncated: 'length' };
  return base;
}
