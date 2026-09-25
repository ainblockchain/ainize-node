/**
 * Turning transfers into credited share — without crediting anything twice, or too early.
 *
 * Everything here is about the two ways a watcher loses money for somebody. Crediting the same log twice mints
 * share, which takes throughput from everyone who paid for theirs. Crediting a log that a reorg then removes does
 * the same thing, more slowly. So the tests drive the log reader directly rather than a chain: what is under test
 * is the bookkeeping, and a real RPC would make it untestable without making it more true.
 *
 *   node --test --import tsx test/deposit-watcher.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DepositLedger } from '@ainize/core';
import { DepositWatcher, type DepositChainConfig, type DepositTransferLog } from '../src/deposit-watcher.js';

const tmp = mkdtempSync(join(tmpdir(), 'ainize-deposits-'));
let n = 0;
const journal = () => join(tmp, `journal-${++n}.json`);

const RECEIVER = '0x00000000000000000000000000000000000000FF';
const BASE: DepositChainConfig = {
  chain: 'base', rpcUrl: 'unused',
  token: '0xd4423795fd904d9b87554940a95fb7016f172773',
  confirmations: 3, isVaultShare: false,
};

const transfer = (over: Partial<DepositTransferLog> = {}): DepositTransferLog =>
  ({ txHash: '0xaa', logIndex: 0, from: '0xDEP', to: RECEIVER, value: 100n, blockNumber: 10, ...over });

/** A watcher over a fixed set of logs and a fixed chain head. `sharesFor` halves, so conversion is visible. */
function watcherOver(logs: DepositTransferLog[], head: number, over: Partial<DepositChainConfig> = {}) {
  const ledger = new DepositLedger();
  const watcher = new DepositWatcher({
    chains: [{ ...BASE, ...over }],
    receivingAddress: RECEIVER,
    ledger,
    sharesFor: async (_chain, amount) => amount / 2n,
    readLogs: async (_chain, from, to) => logs.filter((l) => l.blockNumber >= from && l.blockNumber <= to),
    chainHead: async () => head,
    journalFile: journal(),
  });
  return { watcher, ledger };
}

test('a confirmed transfer is credited, converted into share units', async () => {
  const { watcher, ledger } = watcherOver([transfer()], 20);
  await watcher.scanOnce();
  assert.equal(ledger.depositedShareOf('0xdep'), 50n);
});

test('a transfer shallower than the confirmation depth is not credited yet', async () => {
  const { watcher, ledger } = watcherOver([transfer()], 11);   // 11 - 10 = 1 confirmation, needs 3
  await watcher.scanOnce();
  assert.equal(ledger.depositedShareOf('0xdep'), 0n);
});

test('a transfer waits, then is credited once it is deep enough', async () => {
  const ledger = new DepositLedger();
  let head = 11;
  const watcher = new DepositWatcher({
    chains: [BASE], receivingAddress: RECEIVER, ledger,
    sharesFor: async (_c, a) => a,
    readLogs: async (_c, from, to) => [transfer()].filter((l) => l.blockNumber >= from && l.blockNumber <= to),
    chainHead: async () => head,
    journalFile: journal(),
  });
  await watcher.scanOnce();
  assert.equal(ledger.depositedShareOf('0xdep'), 0n, 'too shallow to count yet');
  head = 20;
  await watcher.scanOnce();
  assert.equal(ledger.depositedShareOf('0xdep'), 100n, 'and credited once the chain caught up');
});

test('rescanning the same range credits nothing extra', async () => {
  const { watcher, ledger } = watcherOver([transfer()], 20);
  await watcher.scanOnce();
  await watcher.scanOnce();
  await watcher.scanOnce();
  assert.equal(ledger.depositedShareOf('0xdep'), 50n);
});

test('a transfer to somebody else is not a deposit here', async () => {
  const { watcher, ledger } = watcherOver([transfer({ to: '0x0000000000000000000000000000000000000001' })], 20);
  await watcher.scanOnce();
  assert.equal(ledger.totalDepositedShares(), 0n);
});

test('the receiving address is matched however it is cased', async () => {
  const { watcher, ledger } = watcherOver([transfer({ to: RECEIVER.toLowerCase() })], 20);
  await watcher.scanOnce();
  assert.equal(ledger.depositedShareOf('0xdep'), 50n);
});

test('a direct sAIN deposit is credited without conversion', async () => {
  const ledger = new DepositLedger();
  const watcher = new DepositWatcher({
    chains: [{ ...BASE, isVaultShare: true }], receivingAddress: RECEIVER, ledger,
    sharesFor: async () => { throw new Error('a share must not be converted again'); },
    readLogs: async () => [transfer()],
    chainHead: async () => 20,
    journalFile: journal(),
  });
  await watcher.scanOnce();
  assert.equal(ledger.depositedShareOf('0xdep'), 100n);
});

test('progress survives a restart, so a restart does not rescan from genesis', async () => {
  const file = journal();
  const make = () => new DepositWatcher({
    chains: [BASE], receivingAddress: RECEIVER, ledger: new DepositLedger(),
    sharesFor: async (_c, a) => a, readLogs: async () => [], chainHead: async () => 500,
    journalFile: file,
  });
  const first = make();
  await first.scanOnce();
  assert.equal(first.lastScannedBlock('base'), 497, 'scanned up to head minus confirmations');
  assert.equal(make().lastScannedBlock('base'), 497);
});

test('a chain that has not caught up to the confirmation depth scans nothing rather than a negative range', async () => {
  const { watcher } = watcherOver([], 2);
  await watcher.scanOnce();
  assert.equal(watcher.lastScannedBlock('base'), 0);
});

test('progress is not advanced past a block whose credit failed', async () => {
  const ledger = new DepositLedger();
  const watcher = new DepositWatcher({
    chains: [BASE], receivingAddress: RECEIVER, ledger,
    sharesFor: async () => { throw new Error('the vault is unreachable'); },
    readLogs: async () => [transfer()],
    chainHead: async () => 20,
    journalFile: journal(),
  });
  await assert.rejects(() => watcher.scanOnce(), /unreachable/);
  assert.equal(watcher.lastScannedBlock('base'), 0, 'a failed scan must be retried, not skipped');
  assert.equal(ledger.totalDepositedShares(), 0n);
});

test('one chain failing does not lose the other chain progress', async () => {
  const ledger = new DepositLedger();
  const watcher = new DepositWatcher({
    chains: [BASE, { ...BASE, chain: 'ethereum' }],
    receivingAddress: RECEIVER, ledger,
    sharesFor: async (_c, a) => a,
    readLogs: async (chain) => (chain === 'ethereum' ? Promise.reject(new Error('rpc down')) : [transfer()]),
    chainHead: async () => 20,
    journalFile: journal(),
  });
  await assert.rejects(() => watcher.scanOnce(), /rpc down/);
  assert.equal(ledger.depositedShareOf('0xdep'), 100n, 'base was credited before ethereum failed');
  assert.equal(watcher.lastScannedBlock('base'), 17);
  assert.equal(watcher.lastScannedBlock('ethereum'), 0);
});

process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));
