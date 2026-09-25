/**
 * What a caller can find out about what they bought.
 *
 * A share is worth nothing to somebody who cannot see it. The number they are paying for has to be observable —
 * not asserted in a README — so `/v1/account` reports the deposit, the share it currently buys, and where to send
 * more. Getting the serialisation wrong here is not cosmetic: share amounts are 18-decimal bigints, and a
 * `Number()` on the way out would round somebody's balance silently and always in one direction.
 *
 *   node --test --import tsx test/openai-account.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIdentity, defaultConfig, DepositLedger, type NodeConfig } from '@ainize/core';
import { startNode, type RunningNode } from '../src/server.js';
import { personalSign } from './fixtures/metamask.js';

const tmp = mkdtempSync(join(tmpdir(), 'ainize-account-'));
const PORT = 24197;
const HUMAN = createIdentity();
const RECEIVER = '0x00000000000000000000000000000000000000ff';
/** Far past Number.MAX_SAFE_INTEGER: a balance that only survives as a string. */
const BIG_DEPOSIT = 1234567890123456789012n;

let N: RunningNode;
let url = '';
let apiKey = '';

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

before(async () => {
  const cfg: NodeConfig = defaultConfig({ home: join(tmp, 'N'), name: 'account-node', port: PORT, peers: [], roles: ['seller'], ledger: 'local' });
  cfg.runtime = { repo: undefined, api: 'http://127.0.0.1:1', hookApi: 'http://127.0.0.1:1' };
  cfg.host = '127.0.0.1'; cfg.publicUrl = `http://127.0.0.1:${PORT}`;
  cfg.verifier = { quorum: 1, allowSelfAttest: true, intervalMs: 300_000, auto: false };
  cfg.gossipIntervalMs = 60_000;
  cfg.backends = [{ id: 'llm', modality: 'chat', upstream: 'http://127.0.0.1:1', models: ['qwen3.8-flash-next'] }];
  cfg.deposits = {
    receivingAddress: RECEIVER,
    vault: { address: '0x00000000000000000000000000000000000000aa', chain: 'ethereum' },
    // A chain with an unreachable RPC: nothing should be credited from it, and the node must still start.
    chains: [{ chain: 'base', rpcUrl: 'http://127.0.0.1:1', token: '0xd4423795fd904d9b87554940a95fb7016f172773' }],
  };
  N = await startNode(cfg, { quiet: true, serveWeb: false });
  url = `http://127.0.0.1:${PORT}`;

  const challenge = await (await post('/v1/auth/nonce', { address: HUMAN.address, scheme: 'eip191' })).json() as { nonce: string; message: string };
  apiKey = ((await (await post('/v1/auth/token', { nonce: challenge.nonce, signature: personalSign(challenge.message, HUMAN.privateKey) })).json()) as { api_key: string }).api_key;

  // Credit a deposit directly on the node's ledger — the chain half is covered by test/deposit-watcher.test.ts,
  // and what is under test here is what the surface reports, not how the transfer was noticed.
  N.deposits!.credit({ chain: 'base', txHash: '0xfeed', logIndex: 0, from: HUMAN.address, shares: BIG_DEPOSIT, blockNumber: 1 });
});

after(async () => { await N?.stop(); rmSync(tmp, { recursive: true, force: true }); });

const authed = () => ({ authorization: `Bearer ${apiKey}` });

test('an account reports what it deposited, as an exact decimal string', async () => {
  const body = await (await fetch(`${url}/v1/account`, { headers: authed() })).json() as { address: string; deposited_shares: string };
  assert.equal(typeof body.deposited_shares, 'string', 'a bigint balance must not go out as a Number');
  assert.equal(body.deposited_shares, BIG_DEPOSIT.toString(), 'and must survive the round trip exactly');
  assert.equal(body.address, HUMAN.address.toLowerCase());
});

test('the share a deposit buys is reported as a fraction in [0, 1]', async () => {
  const body = await (await fetch(`${url}/v1/account`, { headers: authed() })).json() as { share_of_active: number };
  assert.equal(typeof body.share_of_active, 'number');
  assert.ok(body.share_of_active >= 0 && body.share_of_active <= 1, `got ${body.share_of_active}`);
});

test('the sole depositor holds all of it', async () => {
  const body = await (await fetch(`${url}/v1/account`, { headers: authed() })).json() as { share_of_active: number };
  assert.equal(body.share_of_active, 1);
});

test('an account is only ever the caller own, never one named in the request', async () => {
  const body = await (await fetch(`${url}/v1/account?address=0x0000000000000000000000000000000000000001`, { headers: authed() })).json() as { address: string };
  assert.equal(body.address, HUMAN.address.toLowerCase());
});

test('the deposit address is the one the operator configured', async () => {
  const body = await (await fetch(`${url}/v1/account/deposit-address`, { headers: authed() })).json() as { address: string; chains: { chain: string; token: string }[] };
  assert.equal(body.address.toLowerCase(), RECEIVER.toLowerCase());
  assert.ok(body.chains.some((c) => c.chain === 'base'), 'a caller has to be told which chains are watched');
});

test('a credited deposit can be looked up by its transaction', async () => {
  const body = await (await fetch(`${url}/v1/account/deposits/0xfeed`, { headers: authed() })).json() as { credited: boolean; shares: string };
  assert.equal(body.credited, true);
  assert.equal(body.shares, BIG_DEPOSIT.toString());
});

test('a deposit not yet seen reports credited:false rather than 404', async () => {
  const res = await fetch(`${url}/v1/account/deposits/0xnotyet`, { headers: authed() });
  assert.equal(res.status, 200, 'a 404 would be indistinguishable from a wrong URL');
  assert.equal((await res.json() as { credited: boolean }).credited, false);
});

test('somebody else deposit is not visible through a transaction hash', async () => {
  N.deposits!.credit({ chain: 'base', txHash: '0xbeef', logIndex: 0, from: '0x0000000000000000000000000000000000000002', shares: 5n, blockNumber: 2 });
  const body = await (await fetch(`${url}/v1/account/deposits/0xbeef`, { headers: authed() })).json() as { credited: boolean };
  assert.equal(body.credited, false, 'a hash is not a capability to read another account');
});

test('the account routes require a key, like the rest of the surface', async () => {
  assert.equal((await fetch(`${url}/v1/account`)).status, 401);
});

test('the ledger the node exposes is the one the surface reads', () => {
  assert.ok(N.deposits instanceof DepositLedger);
});
