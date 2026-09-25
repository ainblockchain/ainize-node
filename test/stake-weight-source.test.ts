/**
 * The one lossy step in the whole design, and the reasons it is allowed to be.
 *
 * Share amounts are 18-decimal bigints because they are money. Queue weights are doubles because they are a
 * ratio. This converts between them, and the tests are about the two ways that conversion could actually hurt
 * somebody: losing precision in the direction of the largest depositor, and producing a weight the scheduler
 * cannot sort.
 *
 *   node --test --import tsx test/stake-weight-source.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DepositLedger } from '@ainize/core';
import { stakeWeightFrom, STAKE_WEIGHT_FLOOR } from '../src/stake-weight-source.js';

const ONE = 10n ** 18n;
const ledgerWith = (balances: Record<string, bigint>) => {
  const ledger = new DepositLedger();
  let i = 0;
  for (const [address, shares] of Object.entries(balances)) {
    ledger.credit({ chain: 'base', txHash: `0x${i}`, logIndex: i++, from: address, shares, blockNumber: 1 });
  }
  return ledger;
};

test('one whole token of share is one unit of weight', () => {
  assert.equal(stakeWeightFrom(ledgerWith({ a: ONE }))('a'), 1);
});

test('an address with no deposit weighs nothing, and takes the floor from the queue', () => {
  assert.equal(stakeWeightFrom(ledgerWith({}))('nobody'), 0);
  assert.ok(STAKE_WEIGHT_FLOOR > 0, 'zero weight is an infinite finish tag, which is starvation, not last place');
});

test('the ratio between two deposits survives the conversion', () => {
  const weight = stakeWeightFrom(ledgerWith({ big: 7n * ONE, small: 2n * ONE }));
  assert.equal(weight('big') / weight('small'), 3.5);
});

test('a fraction of a token is not rounded away', () => {
  assert.equal(stakeWeightFrom(ledgerWith({ a: ONE / 2n }))('a'), 0.5);
});

test('a deposit far past Number.MAX_SAFE_INTEGER stays finite and ordered', () => {
  const huge = ONE * 10n ** 12n;                     // a trillion tokens
  const weight = stakeWeightFrom(ledgerWith({ whale: huge, minnow: ONE }));
  assert.ok(Number.isFinite(weight('whale')), 'an Infinity weight makes NaN finish tags, which sort unpredictably');
  assert.ok(weight('whale') > weight('minnow'));
});

test('a dust deposit weighs more than no deposit at all', () => {
  const weight = stakeWeightFrom(ledgerWith({ dust: 10n ** 13n }));    // 0.00001 tokens
  assert.ok(weight('dust') > 0, 'a real deposit must outrank the free tier, however small');
  assert.ok(weight('dust') > STAKE_WEIGHT_FLOOR);
});

test('an address is matched however it is cased', () => {
  assert.equal(stakeWeightFrom(ledgerWith({ '0xAbC': ONE }))('0xabc'), 1);
});
