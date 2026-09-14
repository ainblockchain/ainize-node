import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { defaultConfig, identityFromPrivateKey, LOCAL_GENESIS } from '@ainize/core';
import { startNode } from '../src/server.js';
import { readInferenceRecords } from '../src/inference-records.js';

const provider = process.env.AIN_INFERENCE_TEST_URL!;
const previousNode = process.env.AIN_LIVE_EXISTING_NODE!;
async function ownerState() {
  const response = await fetch(`${previousNode}/api/info`, { signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200);
  const info = await response.json();
  assert.deepEqual(info.runtime.applied, [], 'Existing node must have no pinned patches');
  assert.equal(info.runtime.queue.running, null, 'Existing runtime must be idle');
  assert.equal(info.runtime.queue.waiting, 0);
  return { model: info.runtime.model, applied: info.runtime.applied };
}
async function rpc(method: string, params: Record<string, unknown>) {
  const response = await fetch(`${provider}/json-rpc`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, protoVer: '1.0.0' } }), signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(!body.error && !body.result?.code);
  return body.result?.result ?? body.result;
}

const before = await ownerState();
mkdirSync('/output/live-home', { mode: 0o700 });
const config = defaultConfig({ home: '/output/live-home', name: 'live-stream-chain-check', peers: [], roles: ['serving'], ledger: 'ain' });
config.identity = identityFromPrivateKey(LOCAL_GENESIS.privateKey);
config.ledger = { kind: 'ain', ain: { providerUrl: provider, chainId: 0, appName: 'knowledge' } };
config.runtime = { api: process.env.AIN_LIVE_MODEL_API!, repo: process.env.AIN_LIVE_MODEL_REPO!, python: '/opt/runtime/bin/python3' };
const node = await startNode(config, { listen: false, quiet: true, teachWorker: false });
try {
  await new Promise<void>(resolve => node.server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${(node.server.address() as { port: number }).port}/api/chat`;
  const startedAt = Date.now();
  const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ patch_ids: [], mode: 'base', model: before.model, stream: true,
      messages: [{ role: 'user', content: 'Reply with exactly OK.' }], max_tokens: 32 }), signal: AbortSignal.timeout(90000) });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let stream = '';
  let firstChunkAt: number | null = null;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    if (firstChunkAt === null) firstChunkAt = Date.now();
    stream += decoder.decode(next.value, { stream: true });
    assert.ok(stream.length < 1024 * 1024);
  }
  stream += decoder.decode();
  const receivedAt = Date.now();
  writeFileSync('/output/live-chat.sse', stream, { flag: 'wx', mode: 0o600 });
  assert.match(stream, /data: \[DONE\]/);
  const resultFrames = stream.split('\n\n').filter(frame => frame.startsWith('event: ainize.result\n'));
  assert.equal(resultFrames.length, 1);
  const result = JSON.parse(resultFrames[0].split('\ndata: ')[1]);
  assert.equal(result.base.model, before.model);
  assert.equal(result.base.finish_reason, 'stop');
  assert.ok(result.base.content.trim());
  assert.ok(!result.base.truncated);
  assert.ok(result.inference_receipt?.id);
  assert.ok(firstChunkAt !== null && firstChunkAt <= receivedAt);
  await node.market.inferenceRecords!.flush();
  const records = readInferenceRecords(node.store, { offset: 0, limit: 1, receipts: true });
  const entry = records.entries[0];
  assert.ok(entry && 'receipts' in entry && entry.receipt_commitment_valid);
  assert.deepEqual(entry.receipts, [result.inference_receipt]);
  assert.equal(entry.state, 'submitted');
  let transaction;
  let block;
  const deadline = Date.now() + 45000;
  do {
    transaction = await rpc('ain_getTransactionByHash', { hash: entry.tx_hash });
    if (transaction?.is_finalized && transaction.receipt?.code === 0) {
      block = await rpc('ain_getBlockByNumber', { number: transaction.number, getFullTransactions: true });
      if (block.transactions?.some((item: { hash: string }) => item.hash === entry.tx_hash)) break;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  } while (Date.now() < deadline);
  const included = block?.transactions?.find((item: { hash: string }) => item.hash === entry.tx_hash);
  assert.ok(included);
  assert.equal(included.tx_body.operation.ref, entry.path);
  assert.deepEqual(included.tx_body.operation.value, { ...entry.batch, node: config.identity.address });
  const after = await ownerState();
  assert.deepEqual(after, before);
  writeFileSync('/output/live-chat-chain.json', JSON.stringify({ scope: 'One real base-model streaming request through a fresh Ainize node and isolated AIN chain; not M4 throughput or patched-inference evidence',
    before, after, startedAt, firstChunkAt, receivedAt, response: result, entry, transaction, block }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ model: result.base.model, answer: result.base.content, receiptId: result.inference_receipt.id,
    txHash: entry.tx_hash, path: entry.path, block: block.number, realModel: true }));
} finally {
  node.server.closeAllConnections();
  await node.stop();
}
