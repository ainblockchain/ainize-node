import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, sha256Hex } from '@ainize/core';
import { InferenceRecords } from '../src/inference-records.js';

function fixture() {
  const values = new Map<string, string>();
  const store = { get: (key: string) => values.get(key) ?? null, set: (key: string, value: string) => { values.set(key, value); } };
  const messages: string[] = [];
  let now = 1000;
  return { values, store, messages, clock: () => now, advance: (value: number) => { now = value; }, report: (message: string) => messages.push(message) };
}

test('completed requests form durable per-model commitments before any chain submission', async () => {
  const context = fixture();
  const batches: unknown[] = [];
  const recorder = new InferenceRecords(context.store, { noteInferenceBatch: async batch => {
    const journal = JSON.parse(context.values.get('inference.journal.v1')!);
    assert.ok(journal.entries.some((entry: { state: string }) => entry.state === 'submitting'));
    batches.push(batch);
    return { path: '/chain/path', tx_hash: 'transaction' };
  } }, context.report, context.clock);
  recorder.completed('owner/first');
  recorder.completed('owner/first');
  recorder.completed('owner/second');
  context.advance(61000);
  await recorder.flush();
  const journal = JSON.parse(context.values.get('inference.journal.v1')!);
  assert.equal(batches.length, 2);
  assert.equal(journal.entries[0].batch.request_count, 2);
  assert.equal(journal.entries[1].batch.request_count, 1);
  for (const entry of journal.entries) {
    assert.equal(entry.state, 'submitted');
    const receipts = JSON.parse(context.values.get(`inference.receipts.${entry.id}`)!);
    assert.equal(entry.batch.receipt_root, sha256Hex(canonicalJson(receipts)));
    assert.deepEqual(Object.keys(receipts[0]).sort(), ['completed_at', 'id', 'model_id']);
    assert.equal(entry.batch.started_at, 1000);
    assert.equal(entry.batch.finished_at, 61000);
  }
});

test('uncertain writes are retained and never automatically retried, including after restart', async () => {
  const context = fixture();
  let calls = 0;
  const ledger = { noteInferenceBatch: async () => { calls++; throw new Error('connection lost'); } };
  const recorder = new InferenceRecords(context.store, ledger, context.report, context.clock);
  recorder.completed('owner/model');
  context.advance(2000);
  await recorder.flush();
  await recorder.flush();
  const restarted = new InferenceRecords(context.store, ledger, context.report, context.clock);
  await restarted.flush();
  assert.equal(calls, 1);
  assert.equal(JSON.parse(context.values.get('inference.journal.v1')!).entries[0].state, 'unconfirmed');
  assert.ok(context.messages.some(message => message.includes('unresolved')));
});

test('concurrent flushes submit once and preserve new completions for the next interval', async () => {
  const context = fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const recorder = new InferenceRecords(context.store, { noteInferenceBatch: async () => {
    calls++; await gate; return { path: '/chain/path', tx_hash: 'transaction' };
  } }, context.report, context.clock);
  recorder.completed('owner/model');
  context.advance(2000);
  const first = recorder.flush();
  const second = recorder.flush();
  recorder.completed('owner/model');
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  context.advance(3000);
  await recorder.flush();
  assert.equal(calls, 2);
  const journal = JSON.parse(context.values.get('inference.journal.v1')!);
  assert.deepEqual(journal.entries.map((entry: { batch: { request_count: number } }) => entry.batch.request_count), [1, 1]);
});

test('old core builds fail explicitly and clock rollback cannot create an invalid batch', async () => {
  const context = fixture();
  assert.throws(() => new InferenceRecords(context.store, {}, context.report, context.clock), /core build/);
  let calls = 0;
  const recorder = new InferenceRecords(context.store, { noteInferenceBatch: async () => { calls++; return null; } }, context.report, context.clock);
  context.advance(3000);
  recorder.completed('owner/model');
  context.advance(2000);
  await recorder.flush();
  assert.equal(calls, 0);
  context.advance(4000);
  await recorder.flush();
  assert.equal(calls, 1);
});

test('persistence failure before submission cannot produce an unjournaled chain write', async () => {
  const context = fixture();
  let fail = false;
  let calls = 0;
  const recorder = new InferenceRecords({ ...context.store, set: (key, value) => {
    if (fail) throw new Error('disk full');
    context.store.set(key, value);
  } }, { noteInferenceBatch: async () => { calls++; return null; } }, context.report, context.clock);
  recorder.completed('owner/model');
  context.advance(2000);
  fail = true;
  await assert.rejects(recorder.flush(), /disk full/);
  assert.equal(calls, 0);
  assert.equal(JSON.parse(context.values.get('inference.journal.v1')!).receipts.length, 1);
});
