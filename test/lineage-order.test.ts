/**
 * Item 281 — a family is loaded ancestors first, whatever order it was bought in.
 *
 * `base.stack` says the intended order on a knowledge published with the lineage fields, and `resolveStack` walks
 * it. Every `publish --parents` child, and every anchor written before those fields existed, declares its family in
 * `parents[]` alone — and today's children carry their base's rows, so loading the base last really does overwrite
 * the child's answers on every shared row. A contract test: no model, no node, just the ordering rule.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CatalogEntry } from '@ngram/core';
import { Market } from '../src/market.js';

const node = (id: string, parents: string[]) => ({ id, entry: { anchor: { id, parents } } as unknown as CatalogEntry });
const order = (list: { id: string; entry: CatalogEntry }[]) => Market.orderByLineage(list).map((x) => x.id);

test('a family bought newest-first is loaded oldest-first', () => {
  assert.deepEqual(order([node('grandchild', ['child']), node('child', ['parent']), node('parent', [])]), ['parent', 'child', 'grandchild']);
});

test('a knowledge whose parent is not being loaded keeps its place', () => {
  assert.deepEqual(order([node('child', ['parent-elsewhere']), node('other', [])]), ['child', 'other']);
});

test('two independent bases stay in the order they were asked for', () => {
  assert.deepEqual(order([node('child', ['b1', 'b2']), node('b2', []), node('b1', [])]), ['b2', 'b1', 'child']);
});

test('a cycle in declared parents (a peer anchor may claim any) leaves the order untouched', () => {
  assert.deepEqual(order([node('a', ['b']), node('b', ['a'])]), ['a', 'b']);
});

test('a knowledge that names itself as a parent is not a cycle', () => {
  assert.deepEqual(order([node('a', ['a']), node('b', ['a'])]), ['a', 'b']);
});
