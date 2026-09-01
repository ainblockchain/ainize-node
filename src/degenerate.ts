/**
 * Degeneracy guard for free-generation answers (D1 — "드" → a ticker followed by an endless run of "0").
 *
 * Pure functions, no I/O. Thresholds validated on 293 REAL answers captured from the shared serving model
 * (231 tuning + 62 held out; PROBE B): precision 1.000, recall 0.989 overall, 1.000/1.000 on the held-out set,
 * ~0.24 ms per answer. The captured corpus is checked in at test/fixtures/degenerate-corpus.json and the
 * numbers above are re-asserted by test/degenerate.test.ts.
 *
 * Why character level rather than tokens: half of the real loops are unsegmented — "hthtqhthtq…", "0000000",
 * "**가**가**가…", "ééééé" — a single whitespace token, so token-level unique-ratio and n-gram rules score them
 * as perfectly diverse. Korean/CJK answers have the same property.
 *
 * Why two tiers: a visitor may legitimately ask for repetition ("한 줄에 하나씩 40개 나열해줘", "repeat it 30 times",
 * a 구구단 table). Those answers are byte-for-byte the shape of a runaway, so the broad rules are skipped when the
 * prompt asked for a list — but the narrow tier-1 rules (a 12-character run of one letter/digit, a near-perfect
 * period ≤ 4 cycle) cannot be produced by any legitimate answer and stay on for every prompt.
 *
 * Why a length floor matters here: the correct answer this product sells is a bare six-digit ticker ("087600").
 * Any digit-masking or shape-normalising rule flags that as a loop. cycleScore() therefore ignores windows under
 * 16 characters, so a short answer can never be scored as degenerate.
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
/** A window shorter than this is never scored — it is what keeps a correct bare ticker ("087600") safe. */
export const MIN_WINDOW = 16;

/** Highest fraction of characters that repeat at some period p (1..64) inside some tail window of `s`. */
export function cycleScore(s: string): { score: number; period: number; window: number } {
  const n = s.length;
  let best = { score: 0, period: 0, window: 0 };
  for (const W of WINDOWS) {
    if (n < W && W !== WINDOWS[0] && n < WINDOWS[0]) break;
    const w = s.slice(-Math.min(W, n));
    const m = w.length;
    if (m < MIN_WINDOW) continue;
    const maxP = Math.min(MAX_PERIOD, Math.floor(m / MIN_CYCLES));
    for (let p = 1; p <= maxP; p++) {
      let hit = 0;
      for (let i = 0; i < m - p; i++) if (w[i] === w[i + p]) hit++;
      const r = hit / (m - p);
      if (r > best.score) best = { score: r, period: p, window: m };
    }
  }
  return best;
}

/** Decorative characters may legitimately run (table rules, ```, ---, whitespace); letters and digits may not. */
const DECOR = new Set([...'-=_*#~ .·|/\\+<>`\'"[](){}—–…\t\n\r,;:!?']);

/** Longest run of one identical letter/digit ("0000000000000", "ééééé"). */
export function longestAlnumRun(s: string): number {
  let best = 0, cur = 0, prev = '';
  for (const ch of s) {
    const alnum = !DECOR.has(ch) && /[\p{L}\p{N}]/u.test(ch);
    if (ch === prev && alnum) { cur++; if (cur > best) best = cur; } else cur = alnum ? 1 : 0;
    prev = ch;
  }
  return best;
}

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
 */
const ENUM_INTENT = /(?:\b(?:list|print|output|repeat|enumerate|number|write out|give me)\b[\s\S]{0,60}?\b\d{2,}\b)|(?:\b\d{2,}\b[\s\S]{0,30}?(?:times|rows|items|lines|objects))|(?:\d+\s*(?:to|through|~|부터)\s*\d+)|(?:\d{2,}\s*(?:개|줄|번|행|까지))|(?:한 줄에 하나씩)|나열|반복/i;
export function asksForRepetition(prompt: string): boolean { return ENUM_INTENT.test(prompt ?? ''); }

/**
 * Did the model get stuck repeating itself? `null` = the answer looks fine.
 * `finishReason` is the upstream finish_reason ("length" means the loop ran to the token budget).
 */
export function detectDegenerate(text: string, finishReason?: string | null, prompt = ''): DegenerateVerdict | null {
  if (!text) return null;
  const c = cycleScore(text);
  // ---- tier 1: shapes no legitimate answer to ANY question produces (never gated by the prompt)
  const run = longestAlnumRun(text);
  if (run >= 12) return { reason: 'char_run', score: run, period: 0 };
  if (c.score >= 0.98 && c.period <= 4 && c.period > 0) return { reason: 'cycle', score: c.score, period: c.period };
  // ---- tier 2: real loops that a "list 80 items" answer is genuinely indistinguishable from
  if (asksForRepetition(prompt)) return null;
  if (c.score >= 0.90) return { reason: 'cycle', score: c.score, period: c.period };
  if (finishReason === 'length' && c.score >= 0.70) return { reason: 'cycle_truncated', score: c.score, period: c.period };
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

/** Cut back to the last line/sentence/word boundary so the shown answer does not end mid-word. */
function tidyCut(text: string, at: number): string {
  const head = text.slice(0, at);
  for (const re of [/[\s\S]*[\n]/, /[\s\S]*[.!?。！？]/, /[\s\S]*\s/]) {
    const m = re.exec(head);
    if (m && m[0].length >= Math.max(MIN_WINDOW, at * 0.5)) return m[0].replace(/\s+$/, '');
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
