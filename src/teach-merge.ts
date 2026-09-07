/**
 * Teach mode — combining two knowledges (`docs/lineage-teach-design.md` §9, SC-14, §12.2).
 *
 * The owner's second question ("why can I not MERGE someone else's?") is answered in two halves, and this module is
 * the half that can be decided without a model:
 *
 *  1. **Questions.** Union the two training sets by the parser key (F13: NFC, control characters dropped, runs of
 *     whitespace collapsed, CASE-SENSITIVE — "Seoul" and "seoul" are two answers, and a merge screen that hid that
 *     would be choosing for the creator). Same question with the same answer is one row; same question with a
 *     different answer is a CONFLICT that a person has to resolve before anything is built.
 *  2. **Rows.** What the two knowledge files actually do to the model, counted by `compareNpz` — which decides which
 *     of the three build tiers is even possible.
 *
 * PURE functions: no filesystem beyond reading the two .npz files, no database, no network, no clock. What is NOT
 * here, deliberately: any way to produce a merged row by averaging or adding two files (§9 Forbidden / F8). A row two
 * knowledges disagree about is retrained (T1) or rebuilt (T2), or the merge does not happen.
 */
import { compareNpz, type NpzCompare } from '@ainize/core';
import { questionKey, type CanonicalRow } from './teach-dataset.js';

/** What the creator chose for one conflicting question (design §12.1 `resolutions`). */
export type MergeResolution = 'a' | 'b' | 'drop' | { answer: string };

export interface MergeConflict {
  key: string; prompt: string;
  a_answer: string; b_answer: string;
  /** Which row of each parent's own training set the answer is (what a `from` / `replaces` pointer names). */
  a_row: number; b_row: number;
}
export interface MergeQuestions {
  a_only: number; b_only: number; same: number;
  conflicts: MergeConflict[];
  /** Questions present in both with the same answer — the rows a merge inherits once, not twice. */
  shared: number;
}

/** One parent of a merge: its id and its published training set (in ITS row order). */
export interface MergeSide { id: string; rows: CanonicalRow[] }

/**
 * Step 1 — the question-level merge. Duplicate keys inside one set are resolved to the FIRST row (that is the row a
 * `from` pointer names and the one the parser kept), so a set that repeats a question cannot make one conflict look
 * like three.
 */
export function mergeQuestions(a: MergeSide, b: MergeSide): MergeQuestions {
  const ai = indexByKey(a.rows), bi = indexByKey(b.rows);
  const conflicts: MergeConflict[] = [];
  let same = 0;
  for (const [key, i] of ai) {
    const j = bi.get(key);
    if (j === undefined) continue;
    const ra = a.rows[i], rb = b.rows[j];
    if (questionKey(ra.answer) === questionKey(rb.answer)) { same++; continue; }
    conflicts.push({ key, prompt: ra.prompt, a_answer: ra.answer, b_answer: rb.answer, a_row: i, b_row: j });
  }
  const shared = same + conflicts.length;
  return { a_only: ai.size - shared, b_only: bi.size - shared, same, shared, conflicts };
}

export interface MergedSet {
  rows: CanonicalRow[];
  /** Indexes into `rows` of the questions a build has to TEACH: every resolved conflict (the model currently says two things). */
  targets: number[];
  /** Indexes into `rows` of everything else — the keep-set (§7.3): already taught by one of the parents. */
  keep: number[];
  from_a: number; from_b: number; dropped: number; own: number;
}

/**
 * Step 1b — the merged canonical rows. Every surviving row keeps a `from` pointing at the parent row it IS, so the
 * published set proves by sha which questions were inherited (§6.3), and a resolved conflict additionally carries
 * `replaces` pointing at the answer it overrules — the same field an override uses everywhere else in this product.
 *
 * A question with no resolution is left to the caller to refuse (`merge_unresolved`): guessing one here would pick a
 * creator's answer for them.
 */
export function mergeRows(a: MergeSide, b: MergeSide, resolutions: Record<string, MergeResolution> = {}): MergedSet {
  const q = mergeQuestions(a, b);
  const conflictOf = new Map(q.conflicts.map((c) => [c.key, c]));
  const ai = indexByKey(a.rows), bi = indexByKey(b.rows);
  const rows: CanonicalRow[] = []; const targets: number[] = []; const keep: number[] = [];
  let from_a = 0, from_b = 0, dropped = 0, own = 0;
  const push = (row: CanonicalRow, kind: 'keep' | 'target') => {
    (kind === 'target' ? targets : keep).push(rows.length);
    rows.push(row);
  };
  for (const [key, i] of ai) {
    const ra = a.rows[i];
    const c = conflictOf.get(key);
    const base = { prompt: ra.prompt, answer: ra.answer, ...(ra.alt_prompt ? { alt_prompt: ra.alt_prompt } : {}) };
    if (!c) { push({ ...base, from: `${a.id}#${i}` }, 'keep'); from_a++; continue; }
    const r = resolutions[key];
    if (r === 'drop') { dropped++; continue; }
    if (r === 'b') { push({ prompt: ra.prompt, answer: b.rows[c.b_row].answer, ...(b.rows[c.b_row].alt_prompt ? { alt_prompt: b.rows[c.b_row].alt_prompt } : {}), from: `${b.id}#${c.b_row}`, replaces: `${a.id}#${i}` }, 'target'); from_b++; continue; }
    if (r && typeof r === 'object' && typeof r.answer === 'string') { push({ prompt: ra.prompt, answer: r.answer, ...(ra.alt_prompt ? { alt_prompt: ra.alt_prompt } : {}), replaces: `${a.id}#${i}` }, 'target'); own++; continue; }
    // 'a' (and the unresolved case the caller refuses before it gets here)
    push({ ...base, from: `${a.id}#${i}`, replaces: `${b.id}#${c.b_row}` }, 'target'); from_a++;
  }
  for (const [key, j] of bi) {
    if (ai.has(key)) continue;
    const rb = b.rows[j];
    push({ prompt: rb.prompt, answer: rb.answer, ...(rb.alt_prompt ? { alt_prompt: rb.alt_prompt } : {}), from: `${b.id}#${j}` }, 'keep');
    from_b++;
  }
  return { rows, targets, keep, from_a, from_b, dropped, own };
}

export type MergeTier = 'union' | 'retrain' | 'rebuild';
export type TierRefusal = 'rows_disagree' | 'question_conflicts' | 'private_parent' | 'stack_mismatch' | 'dim_mismatch' | 'nothing_to_retrain';
export interface MergeTiers {
  union: { allowed: boolean; reason?: TierRefusal; export?: 'delta' | 'squash' };
  retrain: { allowed: boolean; reason?: TierRefusal; est_min: number | null };
  rebuild: { allowed: boolean; reason?: TierRefusal; est_min: number | null };
  /** Set when the design REQUIRES a tier: > 20 % of the shared rows disagree, so nothing short of a rebuild is honest. */
  required: MergeTier | null;
  /** Share of the rows both files write that they disagree about — the number the requirement is read from. */
  disagree_ratio: number;
}

/** §9 T2 is required above this share of disagreeing shared rows (pin/pixel measured 96 %, ep6/ep12 99.9 %). */
export const REBUILD_REQUIRED_RATIO = 0.2;

/**
 * Step 3 — which builds are possible, and which one the design requires. Nothing here is a promise about quality; it
 * is the list of operations that can be carried out without inventing a row.
 */
export function mergeTiers(input: {
  questions: MergeQuestions | null;
  rows: NpzCompare;
  targets: number;
  stacks: { a: string[]; b: string[] };
  est: { retrain_min: number | null; rebuild_min: number | null };
}): MergeTiers {
  const { questions, rows, stacks } = input;
  const ratio = rows.shared ? rows.disagree / rows.shared : 0;
  const required: MergeTier | null = rows.shared && ratio > REBUILD_REQUIRED_RATIO ? 'rebuild' : null;
  const sameStack = stacks.a.length === stacks.b.length && stacks.a.every((x, i) => x === stacks.b[i]);
  const union = (): MergeTiers['union'] => {
    if (rows.dim === 0) return { allowed: false, reason: 'dim_mismatch' };
    if (questions === null && rows.shared > 0) return { allowed: false, reason: 'private_parent' };
    if (questions && questions.conflicts.length) return { allowed: false, reason: 'question_conflicts' };
    if (rows.shared && (rows.disagree || rows.before_differs)) return { allowed: false, reason: 'rows_disagree' };
    if (!sameStack) return { allowed: false, reason: 'stack_mismatch' };
    return { allowed: true, export: stacks.a.length ? 'delta' : 'squash' };
  };
  const retrain = (): MergeTiers['retrain'] => {
    if (questions === null) return { allowed: false, reason: 'private_parent', est_min: null };
    if (required === 'rebuild') return { allowed: false, reason: 'rows_disagree', est_min: null };
    if (!input.targets) return { allowed: false, reason: 'nothing_to_retrain', est_min: null };
    return { allowed: true, est_min: input.est.retrain_min };
  };
  const rebuild = (): MergeTiers['rebuild'] =>
    questions === null ? { allowed: false, reason: 'private_parent', est_min: null } : { allowed: true, est_min: input.est.rebuild_min };
  return { union: union(), retrain: retrain(), rebuild: rebuild(), required, disagree_ratio: Math.round(ratio * 1000) / 1000 };
}

/** The row-level measurement of §9 step 2, on two files this node holds. */
export function mergeRowReport(pathA: string, pathB: string): NpzCompare {
  return compareNpz(pathA, pathB);
}

function indexByKey(rows: CanonicalRow[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const [i, r] of rows.entries()) { const k = questionKey(r.prompt); if (!m.has(k)) m.set(k, i); }
  return m;
}
