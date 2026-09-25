/**
 * The whole claim, walked once: send sAIN, then call the LLM with ordinary OpenAI code.
 *
 * Every other test here checks one joint. This one checks that the joints line up — a deposit arriving as a chain
 * log becomes credited share, the share becomes a place in the queue, and the client that spends it is the stock
 * `openai` package with nothing of ours in the call. If this passes and the units pass, the thing described in
 * `docs/openai-surface-stake-bandwidth-design.md` exists.
 *
 * The chain is the one part injected rather than real: `DepositWatcher` takes its log reader as a dependency, so
 * a synthetic `Transfer` exercises exactly the path a real one would, without an RPC or a funded wallet.
 *
 *   node --test --import tsx e2e/stake-to-completion.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import OpenAI from 'openai';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { DepositLedger, defaultConfig, type NodeConfig } from '@ainize/core';
import { startNode, type RunningNode } from '../src/server.js';
import { DepositWatcher } from '../src/deposit-watcher.js';
import { connectAinize, account } from '../sdk/typescript/src/index.js';

const tmp = mkdtempSync(join(tmpdir(), 'ainize-e2e-stake-'));
const PORT = 24231;
const UPSTREAM_PORT = 24232;
const RECEIVER = '0x00000000000000000000000000000000000000ff';

const BUYER_KEY = generatePrivateKey();
const BUYER = privateKeyToAccount(BUYER_KEY).address;
/** One whole sAIN share, in the ledger's 18-decimal units. */
const ONE_SHARE = 10n ** 18n;

let N: RunningNode;
let upstream: Server;
let url = '';

function startUpstream(): Promise<Server> {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url?.startsWith('/v1/models')) {
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'qwen3.8-flash-next', object: 'model', created: 1 }] }));
      return;
    }
    req.on('data', () => undefined);
    req.on('end', () => res.end(JSON.stringify({
      id: 'cmpl', object: 'chat.completion', created: 1, model: 'qwen3.8-flash-next',
      choices: [{ index: 0, message: { role: 'assistant', content: 'the deposit bought this answer' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 },
    })));
  });
  return new Promise((resolve) => server.listen(UPSTREAM_PORT, '127.0.0.1', () => resolve(server)));
}

before(async () => {
  upstream = await startUpstream();
  const cfg: NodeConfig = defaultConfig({ home: join(tmp, 'N'), name: 'e2e-node', port: PORT, peers: [], roles: ['seller'], ledger: 'local' });
  cfg.runtime = { repo: undefined, api: `http://127.0.0.1:${UPSTREAM_PORT}`, hookApi: `http://127.0.0.1:${UPSTREAM_PORT}` };
  cfg.host = '127.0.0.1'; cfg.publicUrl = `http://127.0.0.1:${PORT}`;
  cfg.verifier = { quorum: 1, allowSelfAttest: true, intervalMs: 3_600_000, auto: false };
  cfg.gossipIntervalMs = 3_600_000;
  cfg.backends = [{ id: 'llm', modality: 'chat', upstream: `http://127.0.0.1:${UPSTREAM_PORT}`, models: ['qwen3.8-flash-next'] }];
  cfg.deposits = {
    receivingAddress: RECEIVER,
    vault: { address: '0x00000000000000000000000000000000000000aa', chain: 'ethereum' },
    chains: [{ chain: 'base', rpcUrl: 'http://127.0.0.1:1', token: '0xd4423795fd904d9b87554940a95fb7016f172773' }],
    pollMs: 3_600_000,
  };
  N = await startNode(cfg, { quiet: true, serveWeb: false });
  url = `http://127.0.0.1:${PORT}`;
});

after(async () => {
  await N?.stop();
  await new Promise((r) => upstream?.close(r));
  rmSync(tmp, { recursive: true, force: true });
});

test('a transfer on chain becomes credited share on this node', async () => {
  // The buyer sends AIN to the operator. The watcher sees the log, waits out the confirmation depth, prices it
  // through the vault and credits the sender — the real path, with only the RPC replaced.
  const watcher = new DepositWatcher({
    chains: [{ chain: 'base', rpcUrl: 'unused', token: '0xd4423795fd904d9b87554940a95fb7016f172773', confirmations: 3, isVaultShare: false }],
    receivingAddress: RECEIVER,
    ledger: N.deposits!,
    sharesFor: async (_chain, amount) => amount / 2n,        // a vault where one share costs two AIN
    readLogs: async () => [{ txHash: '0xdeposit', logIndex: 0, from: BUYER, to: RECEIVER, value: 2n * ONE_SHARE, blockNumber: 10 }],
    chainHead: async () => 20,
    journalFile: join(tmp, 'journal.json'),
  });

  const credited = await watcher.scanOnce();
  assert.equal(credited, 1);
  assert.equal(N.deposits!.depositedShareOf(BUYER), ONE_SHARE, 'two AIN bought one share');

  // And looking again credits nothing further, which is the property that keeps share from being minted.
  assert.equal(await watcher.scanOnce(), 0);
  assert.equal(N.deposits!.depositedShareOf(BUYER), ONE_SHARE);
});

test('the depositor signs in and gets a key', async () => {
  const client = await connectAinize(url, { privateKey: BUYER_KEY });
  assert.ok(client instanceof OpenAI);
  assert.match(client.apiKey, /^ainize-sk-/);
});

test('ordinary OpenAI code, against a node paid for with sAIN', async () => {
  const client = await connectAinize(url, { privateKey: BUYER_KEY });

  // Nothing below this line belongs to Ainize. It is the call a caller already knows how to write.
  const completion = await client.chat.completions.create({
    model: 'qwen3.8-flash-next',
    messages: [{ role: 'user', content: 'what did the deposit buy?' }],
  });

  assert.equal(completion.choices[0].message.content, 'the deposit bought this answer');
  assert.match(completion.id, /^chatcmpl-/);
  assert.equal(completion.object, 'chat.completion');
  assert.equal(completion.usage?.total_tokens, 10);
});

test('the account reports the deposit and the share it buys', async () => {
  const client = await connectAinize(url, { privateKey: BUYER_KEY });
  const mine = await account(url, client.apiKey);

  assert.equal(mine.address, BUYER.toLowerCase());
  assert.equal(mine.deposited_shares, ONE_SHARE.toString(), 'exact, as a decimal string — 18 decimals do not fit a double');
  assert.ok(mine.share_of_active > 0, 'and the share is visible, not merely asserted in a README');
  assert.ok(mine.share_of_active <= 1);
});

test('somebody who deposited nothing is still served, just behind', async () => {
  // The free tier is a floor, not a gate: a node nobody else is using answers anyone.
  const stranger = await connectAinize(url, { privateKey: generatePrivateKey() });
  const completion = await stranger.chat.completions.create({
    model: 'qwen3.8-flash-next',
    messages: [{ role: 'user', content: 'hello' }],
  });
  assert.equal(completion.choices[0].message.content, 'the deposit bought this answer');

  const theirs = await account(url, stranger.apiKey);
  assert.equal(theirs.deposited_shares, '0');
});

test('the deposit is findable by the transaction that made it, and only by its own sender', async () => {
  const buyer = await connectAinize(url, { privateKey: BUYER_KEY });
  const stranger = await connectAinize(url, { privateKey: generatePrivateKey() });

  const asBuyer = await (await fetch(`${url}/v1/account/deposits/0xdeposit`, { headers: { authorization: `Bearer ${buyer.apiKey}` } })).json() as { credited: boolean; shares: string };
  assert.equal(asBuyer.credited, true);
  assert.equal(asBuyer.shares, ONE_SHARE.toString());

  const asStranger = await (await fetch(`${url}/v1/account/deposits/0xdeposit`, { headers: { authorization: `Bearer ${stranger.apiKey}` } })).json() as { credited: boolean };
  assert.equal(asStranger.credited, false, 'a public transaction hash is not a capability to read a stranger account');
});
