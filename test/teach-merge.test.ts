/**
 * `teach-merge.ts` decides two things that cost money and rights, and nothing was holding it to either.
 *
 * `mergeTiers` says which of the three build tiers §9 allows for a pair of lessons — and `private_parent` is a
 * licence refusal, while `required: 'rebuild'` forces the most expensive job this node runs. `mergeQuestions` is
 * the set arithmetic those decisions read. Both are pure functions over data, so there is no excuse for the
 * module having had no test at all: every case below is a `mergeTiers` branch or an edge of the arithmetic.
 *
 *   node --test --import tsx test/teach-merge.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NpzCompare } from '@ainize/core';
import { mergeQuestions, mergeTiers, REBUILD_REQUIRED_RATIO, type MergeSide } from '../src/teach-merge.js';
import type { CanonicalRow } from '../src/teach-dataset.js';

const row = (prompt: string, answer: string): CanonicalRow => ({ prompt, answer }) as CanonicalRow;
const side = (id: string, rows: CanonicalRow[]): MergeSide => ({ id, rows });

/** A comparison with nothing wrong in it; each test names only what it is about. */
const cmp = (over: Partial<NpzCompare> = {}): NpzCompare => ({
  a_rows: 10, b_rows: 10, a_only: 5, b_only: 5, shared: 5, equal: 5,
  disagree: 0, opposing: 0, before_differs: 0, dim: 160, ...over,
});
const tiers = (over: Partial<Parameters<typeof mergeTiers>[0]> = {}) => mergeTiers({
  questions: mergeQuestions(side('a', [row('q1', 'a1')]), side('b', [row('q2', 'b2')])),
  rows: cmp(), targets: 3, stacks: { a: [], b: [] }, est: { retrain_min: 12, rebuild_min: 40 }, ...over,
});

// ---------------------------------------------------------------- the arithmetic

test('mergeQuestions: shared is the intersection, and a_only/b_only are what is left of each side', () => {
  const a = side('a', [row('same', 'x'), row('conflict', 'from A'), row('only in A', 'x')]);
  const b = side('b', [row('same', 'x'), row('conflict', 'from B'), row('only in B', 'y'), row('also only in B', 'z')]);
  const m = mergeQuestions(a, b);
  assert.equal(m.same, 1);
  assert.equal(m.conflicts.length, 1);
  assert.equal(m.conflicts[0]!.a_answer, 'from A');
  assert.equal(m.conflicts[0]!.b_answer, 'from B');
  assert.equal(m.shared, 2, 'shared counts agreement AND disagreement — both are questions in both sets');
  assert.equal(m.a_only, 1);
  assert.equal(m.b_only, 2);
  assert.equal(m.a_only + m.shared, 3, 'the parts add back up to |A|');
  assert.equal(m.b_only + m.shared, 4, 'and to |B|');
});

test('mergeQuestions: a question repeated inside one set is one question, resolved to the first row', () => {
  // Item: a set that repeats a question must not make one conflict look like three.
  const a = side('a', [row('dupe', 'first'), row('dupe', 'second'), row('dupe', 'third')]);
  const b = side('b', [row('dupe', 'other')]);
  const m = mergeQuestions(a, b);
  assert.equal(m.shared, 1);
  assert.equal(m.conflicts.length, 1);
  assert.equal(m.conflicts[0]!.a_answer, 'first', 'the row a `from` pointer names is the one the parser kept');
  assert.equal(m.a_only, 0, 'every count here is over QUESTIONS, not rows: three copies of one question are one question');
});

test('mergeQuestions: two sets that share nothing share nothing', () => {
  const m = mergeQuestions(side('a', [row('x', '1')]), side('b', [row('y', '2')]));
  assert.deepEqual({ same: m.same, shared: m.shared, a_only: m.a_only, b_only: m.b_only, conflicts: m.conflicts.length },
    { same: 0, shared: 0, a_only: 1, b_only: 1, conflicts: 0 });
});

// ---------------------------------------------------------------- union

test('union is allowed only when the two files agree everywhere they overlap', () => {
  const ok = tiers();
  assert.equal(ok.union.allowed, true);
  assert.equal(ok.union.export, 'squash', 'no stack under either side → the merge is the whole table');
  assert.equal(tiers({ stacks: { a: ['base'], b: ['base'] } }).union.export, 'delta', 'a shared base stays underneath');
});

test('union refuses, with the reason, on every way the files can disagree', () => {
  assert.equal(tiers({ rows: cmp({ dim: 0 }) }).union.reason, 'dim_mismatch');
  assert.equal(tiers({ rows: cmp({ disagree: 1 }) }).union.reason, 'rows_disagree');
  assert.equal(tiers({ rows: cmp({ before_differs: 1 }) }).union.reason, 'rows_disagree',
    'two lessons taught on different base states cannot be added together');
  assert.equal(tiers({ stacks: { a: ['x'], b: ['y'] } }).union.reason, 'stack_mismatch');
  const conflicting = mergeQuestions(side('a', [row('q', 'A')]), side('b', [row('q', 'B')]));
  assert.equal(tiers({ questions: conflicting }).union.reason, 'question_conflicts');
});

test('a private parent blocks union only when the files actually overlap', () => {
  // Nothing of the questions is read, so a private set can still be added to one it shares no rows with.
  assert.equal(tiers({ questions: null, rows: cmp({ shared: 0, equal: 0 }) }).union.allowed, true);
  assert.equal(tiers({ questions: null }).union.reason, 'private_parent');
});

// ---------------------------------------------------------------- retrain / rebuild

test('a private parent refuses every tier that would need to read its questions', () => {
  const t = tiers({ questions: null });
  assert.equal(t.retrain.reason, 'private_parent');
  assert.equal(t.rebuild.reason, 'private_parent');
  assert.equal(t.rebuild.allowed, false, 'the creator kept them private, so nobody builds on them — not even the expensive way');
});

test('retrain needs something to retrain', () => {
  assert.equal(tiers({ targets: 0 }).retrain.reason, 'nothing_to_retrain');
  assert.equal(tiers({ targets: 1 }).retrain.allowed, true);
});

test('past the disagreement ratio nothing short of a rebuild is honest', () => {
  const under = tiers({ rows: cmp({ shared: 100, equal: 80, disagree: 20 }) });   // exactly 0.2 — not past it
  assert.equal(under.required, null);
  assert.equal(under.retrain.allowed, true);
  assert.equal(under.disagree_ratio, REBUILD_REQUIRED_RATIO);

  const over = tiers({ rows: cmp({ shared: 100, equal: 79, disagree: 21 }) });
  assert.equal(over.required, 'rebuild');
  assert.equal(over.retrain.allowed, false);
  assert.equal(over.retrain.reason, 'rows_disagree');
  assert.equal(over.rebuild.allowed, true, 'the tier it forces is the one it leaves open');
  assert.equal(over.disagree_ratio, 0.21);
});

test('no shared rows means no ratio, and no tier is forced', () => {
  const t = tiers({ rows: cmp({ shared: 0, equal: 0, disagree: 0 }) });
  assert.equal(t.disagree_ratio, 0, 'not NaN — 0/0 is reported as no disagreement, not as a broken number');
  assert.equal(t.required, null);
});
