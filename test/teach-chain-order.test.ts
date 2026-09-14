import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { TeachWorker } from '../src/teach.js';
import type { Market } from '../src/market.js';
import type { TeachJobRow } from '../src/store.js';

type Receipt = { path: string; tx_hash: string } | null;

function fixture(submit: (id: string, value: Record<string, unknown>) => Promise<Receipt>) {
  const jobs = new Map<string, TeachJobRow>();
  const receipts = new Map<string, string>();
  const warnings: string[] = [];
  const worker = new TeachWorker({
    cfg: { dataDir: '/unused' },
    teach: () => ({ backend: 'stub' }),
    ledger: { noteLesson: submit },
    log: (_level: string, _scope: string, message: string) => warnings.push(message),
    store: {
      getTeachJob: (id: string) => jobs.get(id),
      updateTeachJob: (id: string, update: Partial<TeachJobRow>) => Object.assign(jobs.get(id)!, update),
      set: (key: string, value: string) => receipts.set(key, value),
    },
  } as unknown as Market);
  const internals = worker as unknown as {
    noteOnChain(id: string, status: string): Promise<void>;
    chainSubmissions: Map<string, Promise<void>>;
  };
  const add = (id: string) => {
    const job = { id, contributor: 'author', dataset_id: 'original', dataset_sha256: 'digest',
      facts: [{ prompt: 'private question', answer: 'private answer' }], created_at: 100,
      started_at: 200, finished_at: null, progress: { started_at: 300 },
    } as TeachJobRow;
    jobs.set(id, job);
    return job;
  };
  return { add, receipts, warnings, internals };
}

test('one job submits in transition order and snapshots each transition before waiting', async () => {
  const first = Promise.withResolvers<Receipt>();
  const calls: Record<string, unknown>[] = [];
  const setup = fixture(async (_id, value) => {
    calls.push(value);
    return calls.length === 1 ? first.promise : { path: '/lesson', tx_hash: 'ready' };
  });
  const job = setup.add('job');
  const training = setup.internals.noteOnChain('job', 'TRAINING');
  await setImmediate();
  job.finished_at = 400;
  const ready = setup.internals.noteOnChain('job', 'READY');
  job.dataset_id = 'mutated-after-enqueue';
  job.finished_at = 500;
  await setImmediate();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].finished_at, null);
  const releasedAt = Date.now();
  first.resolve({ path: '/lesson', tx_hash: 'training' });
  await Promise.all([training, ready]);
  assert.deepEqual(calls.map(value => value.status), ['TRAINING', 'READY']);
  assert.equal(calls[1].dataset_id, 'original');
  assert.equal(calls[1].finished_at, 400);
  assert.ok(Number(calls[1].submitted_at) >= releasedAt);
  assert.equal(job.chain_tx, 'ready');
  assert.equal(JSON.parse(setup.receipts.get('teach.chain.job.TRAINING')!).txHash, 'training');
  assert.equal(JSON.parse(setup.receipts.get('teach.chain.job.READY')!).txHash, 'ready');
  assert.equal(setup.internals.chainSubmissions.size, 0);
});

test('70 different jobs can submit without waiting for another job acknowledgement', async () => {
  const gate = Promise.withResolvers<Receipt>();
  const calls: string[] = [];
  const setup = fixture(async id => { calls.push(id); return gate.promise; });
  const submissions = Array.from({ length: 70 }, (_, index) => {
    const id = `job-${index}`;
    setup.add(id);
    return setup.internals.noteOnChain(id, 'TRAINING');
  });
  await setImmediate();
  assert.equal(new Set(calls).size, 70);
  assert.equal(setup.internals.chainSubmissions.size, 70);
  gate.resolve({ path: '/lesson', tx_hash: 'fixture-tx' });
  await Promise.all(submissions);
  assert.equal(setup.internals.chainSubmissions.size, 0);
});

test('failed or unconfirmed submissions do not poison the next transition or invent a receipt', async () => {
  for (const outcome of ['reject', 'unconfirmed']) {
    const first = Promise.withResolvers<Receipt>();
    const calls: string[] = [];
    const setup = fixture(async (_id, value) => {
      calls.push(String(value.status));
      return calls.length === 1 ? first.promise : { path: '/lesson', tx_hash: 'ready' };
    });
    const job = setup.add('job');
    const training = setup.internals.noteOnChain('job', 'TRAINING');
    const ready = setup.internals.noteOnChain('job', 'READY');
    await setImmediate();
    assert.deepEqual(calls, ['TRAINING']);
    if (outcome === 'reject') first.reject(new Error('RPC unavailable'));
    else first.resolve(null);
    await Promise.all([training, ready]);
    assert.deepEqual(calls, ['TRAINING', 'READY']);
    assert.equal(job.chain_tx, 'ready');
    assert.equal(setup.warnings.length, 1);
    const raw = setup.receipts.get('teach.chain.job.TRAINING');
    if (outcome === 'reject') assert.equal(raw, undefined);
    else {
      assert.equal(JSON.parse(raw!).outcome, 'unconfirmed');
      assert.equal(JSON.parse(raw!).txHash, null);
    }
    assert.equal(setup.internals.chainSubmissions.size, 0);
  }
});
