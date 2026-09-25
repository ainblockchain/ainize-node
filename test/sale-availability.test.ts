import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saleAvailability } from '../src/sale-availability.js';

test('a missing seller file disables sale without changing historical verification', () => {
  const entry = { anchor: { author: '0xAB', patch_sha256: 'sha' }, sellable: true, status: 'VERIFIED' };
  const absent = saleAvailability(entry, '0xab', () => false);
  assert.equal(absent.sellable, false);
  assert.equal(absent.body_available, false);
  assert.equal(absent.status, 'VERIFIED');
  assert.equal(entry.sellable, true, 'ledger state is not mutated');
  assert.equal(saleAvailability(entry, '0xab', () => true).sellable, true, 'restoring the file restores availability');
  assert.equal(saleAvailability({ ...entry, sellable: false }, '0xab', () => true).sellable, false, 'file presence cannot override a challenge');
});

test('a remote seller is unknown rather than unavailable just because this node lacks its file', () => {
  const entry = { anchor: { author: '0xAB', patch_sha256: 'sha' }, sellable: true };
  const result = saleAvailability(entry, '0xcd', () => { throw new Error('not a local availability check'); });
  assert.equal(result.body_available, null);
  assert.equal(result.sellable, true);
});
