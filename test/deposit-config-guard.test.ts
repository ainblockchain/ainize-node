/**
 * A node that accepts deposits must know where they land, before it accepts any.
 *
 * Every missing value here fails silently at runtime rather than loudly: a node with no receiving address simply
 * never sees a transfer, which looks exactly like nobody having deposited yet, and a node with the wrong one
 * credits share for money that went somewhere its operator does not hold. Neither produces an error anybody would
 * notice, so both are refused at start-up, by name, while somebody is still watching.
 *
 *   node --test --import tsx test/deposit-config-guard.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertDepositsConfigured, AIN_TOKEN_BASE, AIN_TOKEN_ETHEREUM, DEFAULT_CONFIRMATIONS } from '../src/deposit-chain-reader.js';

const complete = () => ({
  receivingAddress: '0x00000000000000000000000000000000000000ff',
  vault: { address: '0x00000000000000000000000000000000000000aa', chain: 'ethereum' },
  chains: [{ chain: 'base', rpcUrl: 'https://base.example', token: AIN_TOKEN_BASE }],
});

test('a complete deposits config is accepted', () => {
  assert.doesNotThrow(() => assertDepositsConfigured(complete()));
});

test('a missing receiving address is refused, and named', () => {
  const config = { ...complete(), receivingAddress: undefined };
  assert.throws(() => assertDepositsConfigured(config), /deposits\.receivingAddress/);
});

test('a missing vault is refused — without it there is no unit to credit in', () => {
  const config = { ...complete(), vault: { chain: 'ethereum' } };
  assert.throws(() => assertDepositsConfigured(config), /deposits\.vault\.address/);
});

test('a chain without an RPC is refused, naming which chain', () => {
  const config = { ...complete(), chains: [{ chain: 'base', token: AIN_TOKEN_BASE }] };
  assert.throws(() => assertDepositsConfigured(config), /deposits\.chains\[base\]\.rpcUrl/);
});

test('no chains at all is refused — there would be nothing to watch', () => {
  assert.throws(() => assertDepositsConfigured({ ...complete(), chains: [] }), /deposits\.chains/);
});

test('every problem is reported at once, not one per restart', () => {
  try {
    assertDepositsConfigured({});
    assert.fail('expected a refusal');
  } catch (error) {
    const message = (error as Error).message;
    for (const key of ['receivingAddress', 'vault.address', 'vault.chain', 'chains']) {
      assert.ok(message.includes(key), `the refusal should name ${key}`);
    }
  }
});

test('the token addresses are the published ones', () => {
  assert.equal(AIN_TOKEN_ETHEREUM, '0x3a810ff7211b40c4fa76205a14efe161615d0385');
  assert.equal(AIN_TOKEN_BASE, '0xd4423795fd904d9b87554940a95fb7016f172773');
});

test('an L2 waits longer than mainnet, because its reorgs come from a sequencer', () => {
  assert.ok(DEFAULT_CONFIRMATIONS.base > DEFAULT_CONFIRMATIONS.ethereum);
});
