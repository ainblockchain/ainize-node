import assert from 'node:assert/strict';
import test from 'node:test';
import { sourceRequest, parseGraphResult } from '../src/live-sources.js';

test('source requests reject arbitrary endpoints and query injection', () => {
  assert.equal(sourceRequest.safeParse({ source: 'graph', symbol: 'USDC' }).success, true);
  assert.equal(sourceRequest.safeParse({ source: 'graph', symbol: 'USDC" }' }).success, false);
  assert.equal(sourceRequest.safeParse({ source: 'ens', name: 'patch.example.eth', rpc: 'http://localhost' }).success, false);
});

test('Graph metadata must establish a real non-error indexed block', () => {
  assert.throws(() => parseGraphResult({ data: { tokens: [] } }));
  assert.throws(() => parseGraphResult({ data: { _meta: { block: { number: 1 }, deployment: 'actual', hasIndexingErrors: true } } }));
  assert.equal(parseGraphResult({ data: { _meta: { block: { number: 1 }, deployment: 'actual', hasIndexingErrors: false } } })._meta.block.number, 1);
});
