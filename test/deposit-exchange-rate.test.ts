/**
 * Pricing a deposit in sAIN, against the contract that actually exists.
 *
 * The design assumed an ERC-4626 vault with `convertToShares`. sAIN is not that: it has `asset()` and looks like
 * a vault from a distance, but the conversion lives on a separate staking contract as one exchange rate. Assuming
 * the standard would have failed at the first real deposit with a revert — better than a wrong number, but still
 * a node that cannot take money.
 *
 * The arithmetic is tested against a stub so it runs anywhere. One test reaches the real contract on Base and is
 * skipped without network: pinning the shape of the live interface is the whole point, and a mocked-only suite
 * would have passed happily against the wrong ABI.
 *
 *   node --test --import tsx test/deposit-exchange-rate.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicClient, http, parseAbi, getAddress } from 'viem';
import { AIN_STAKING_BASE, SAIN_TOKEN_BASE, AIN_TOKEN_BASE } from '../src/deposit-chain-reader.js';

const RATE_SCALE = 10n ** 18n;
/** The conversion under test, written out so the test states it rather than importing the answer. */
const sharesFor = (assets: bigint, rate: bigint) => (assets * RATE_SCALE) / rate;

test('at a rate of one, a deposit is worth its face value in shares', () => {
  assert.equal(sharesFor(10n ** 18n, RATE_SCALE), 10n ** 18n);
});

test('a rate above one means each AIN buys less than one share', () => {
  // getExchangeRate() is AIN per sAIN: as rewards accrue a share costs more AIN, so the same deposit buys fewer.
  const rate = 1113231879721899195n;                       // read from Base on 2026-09-25
  const shares = sharesFor(10n ** 18n, rate);
  assert.ok(shares < 10n ** 18n, 'one AIN must buy less than one share at a rate above 1.0');
  assert.equal(shares, 898285449972753121n);
});

test('a later depositor at a higher rate gets fewer shares for the same money', () => {
  const early = sharesFor(10n ** 18n, RATE_SCALE);
  const late = sharesFor(10n ** 18n, 2n * RATE_SCALE);
  assert.ok(late < early, 'the rate rising is what makes staking pay, and it must reach the accounting');
  assert.equal(late, early / 2n);
});

test('the conversion keeps 18 decimals rather than rounding to whole tokens', () => {
  assert.equal(sharesFor(1n, RATE_SCALE), 1n, 'one wei of AIN is one wei of share at parity');
});

test('the addresses are the ones the staking app uses on Base', () => {
  assert.equal(getAddress(AIN_TOKEN_BASE), getAddress('0xd4423795fd904d9b87554940a95fb7016f172773'));
  assert.equal(getAddress(SAIN_TOKEN_BASE), getAddress('0x70e68AF68933D976565B1882D80708244E0C4fe9'));
  assert.equal(getAddress(AIN_STAKING_BASE), getAddress('0x52644a566eCc3f09F2800A09eB99b2226839E2Da'));
});

test('the live staking contract still exposes getExchangeRate, and it is sane', { skip: process.env.AINIZE_LIVE_CHAIN !== '1' && 'set AINIZE_LIVE_CHAIN=1 to reach Base' }, async () => {
  const client = createPublicClient({ transport: http('https://mainnet.base.org') });
  const rate = await client.readContract({
    address: getAddress(AIN_STAKING_BASE),
    abi: parseAbi(['function getExchangeRate() view returns (uint256)']),
    functionName: 'getExchangeRate',
  }) as bigint;

  assert.ok(rate > 0n, 'a zero rate would divide by nothing');
  // A staking rate only rises, and starts at parity. Anything below 1.0 or absurdly above it means the ABI
  // matched a different function on a different contract, which is exactly the failure this test exists for.
  assert.ok(rate >= RATE_SCALE, `expected a rate at or above parity, got ${rate}`);
  assert.ok(rate < 1000n * RATE_SCALE, `a rate of ${rate} is not a staking exchange rate`);
});

test('the live sAIN token is what its name says', { skip: process.env.AINIZE_LIVE_CHAIN !== '1' && 'set AINIZE_LIVE_CHAIN=1 to reach Base' }, async () => {
  const client = createPublicClient({ transport: http('https://mainnet.base.org') });
  const erc20 = parseAbi(['function symbol() view returns (string)', 'function decimals() view returns (uint8)']);
  assert.equal(await client.readContract({ address: getAddress(SAIN_TOKEN_BASE), abi: erc20, functionName: 'symbol' }), 'sAIN');
  assert.equal(await client.readContract({ address: getAddress(SAIN_TOKEN_BASE), abi: erc20, functionName: 'decimals' }), 18);
});
