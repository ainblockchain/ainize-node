import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIdentity, defaultConfig } from '@ainize/core';
import { startNode } from '../src/server.js';
import { InferenceRecords } from '../src/inference-records.js';

test('inference journal API is operator-only, read-only, paginated and verifies exported commitments', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ainize-inference-api-'));
  const config = defaultConfig({ home, name: 'inference-api', port: 3400, peers: [], roles: ['serving'], ledger: 'local' });
  const node = await startNode(config, { listen: false, quiet: true, teachWorker: false });
  try {
    await new Promise<void>(resolve => node.server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(node.server.address() as { port: number }).port}/api/ledger/inference`;
    node.store.putSession('test-owner-session', 60000);
    node.store.putSession('test-visitor-session', 60000, { subject: createIdentity().address, scheme: 'ain' });
    const headers = { authorization: 'Bearer test-owner-session' };
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { authorization: 'Bearer test-visitor-session' } })).status, 403);
    assert.equal((await (await fetch(url, { headers })).json()).enabled, false);
    let calls = 0;
    let now = 1000;
    node.market.inferenceRecords = new InferenceRecords(node.store, { noteInferenceBatch: async () => {
      calls++; return { path: '/apps/knowledge/market/inference_batches/test/batch', tx_hash: 'test-transaction' };
    } }, () => {}, () => now);
    node.market.inferenceRecords.completed('owner/model');
    now = 2000;
    await node.market.inferenceRecords.flush();
    const listed = await (await fetch(`${url}?limit=1`, { headers })).json();
    assert.equal(listed.total, 1);
    assert.equal(listed.entries[0].state, 'submitted');
    assert.equal(listed.entries[0].receipts, undefined);
    const id = listed.entries[0].id;
    const exported = await (await fetch(`${url}?id=${id}&receipts=true`, { headers })).json();
    assert.equal(exported.entries[0].receipt_commitment_valid, true);
    assert.equal(exported.entries[0].receipts.length, 1);
    assert.equal((await (await fetch(`${url}?offset=1`, { headers })).json()).entries.length, 0);
    assert.equal((await fetch(`${url}?receipts=true`, { headers })).status, 400);
    assert.equal((await fetch(`${url}?limit=101`, { headers })).status, 400);
    const receiptKey = `inference.receipts.${id}`;
    const receipts = JSON.parse(node.store.get(receiptKey)!);
    receipts[0].completed_at = 1500;
    node.store.set(receiptKey, JSON.stringify(receipts));
    const changed = await (await fetch(`${url}?id=${id}&receipts=true`, { headers })).json();
    assert.equal(changed.entries[0].receipt_commitment_valid, false);
    node.market.inferenceRecords = undefined;
    const disabled = await (await fetch(url, { headers })).json();
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.total, 1);
    const forbidden = await fetch(`${url}?id=${id}&receipts=true`, { headers: { authorization: 'Bearer test-visitor-session' } });
    assert.equal(forbidden.status, 403);
    assert.ok(!(await forbidden.text()).includes('owner/model'));
    node.store.set(receiptKey, '');
    const missing = await (await fetch(`${url}?id=${id}&receipts=true`, { headers })).json();
    assert.equal(missing.entries[0].receipts, null);
    assert.equal(missing.entries[0].receipt_commitment_valid, false);
    node.store.set(receiptKey, JSON.stringify([{ ...receipts[0], prompt: 'private-fixture-text' }]));
    const malformed = await fetch(`${url}?id=${id}&receipts=true`, { headers });
    assert.equal(malformed.status, 503);
    assert.ok(!(await malformed.text()).includes('private-fixture-text'));
    assert.equal(calls, 1);
  } finally {
    node.server.closeAllConnections();
    await node.stop();
    rmSync(home, { recursive: true, force: true });
  }
});
