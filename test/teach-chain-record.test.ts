import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lessonChainRecord } from '../src/teach-chain-record.js';
import type { TeachJobRow } from '../src/store.js';

function job(overrides: Partial<TeachJobRow> = {}): TeachJobRow {
  return { contributor: 'author', dataset_id: 'dataset', dataset_sha256: 'digest',
    facts: [{ prompt: 'private question', answer: 'private answer' }], training: { effort: 'normal' },
    created_at: 100, started_at: 200, finished_at: 400, progress: { started_at: 300 },
    ...overrides } as TeachJobRow;
}

test('creation, preflight, trainer and completion clocks remain distinct', () => {
  const result = lessonChainRecord(job(), 'READY', 'gradient');
  assert.equal(result.created_at, 100);
  assert.equal(result.started_at, 200);
  assert.equal(result.training_started_at, 300);
  assert.equal(result.finished_at, 400);
  assert.equal(result.dataset_id, 'dataset');
  assert.equal(result.backend, 'gradient');
  assert.ok(!JSON.stringify(result).includes('private'));
});

test('queued jobs and stub training cannot silently look like measured gradient work', () => {
  const result = lessonChainRecord(job({ started_at: null, finished_at: null, progress: null }), 'QUEUED', 'stub');
  assert.equal(result.started_at, null);
  assert.equal(result.training_started_at, null);
  assert.equal(result.finished_at, null);
  assert.equal(result.backend, 'stub');
  assert.ok(!('run_id' in result));
});

test('unavailable trainer clocks are not replaced with job creation time', () => {
  assert.equal(lessonChainRecord(job({ progress: { started_at: 'unknown' } }), 'TRAINING', 'gradient').training_started_at, null);
});

test('model identity comes only from a supplied trainer recipe, never a guessed default', () => {
  assert.equal(lessonChainRecord(job(), 'READY', 'gradient', 'owner/model').model_id, 'owner/model');
  assert.equal(lessonChainRecord(job(), 'QUEUED', 'gradient').model_id, null);
  for (const invalid of ['', '   ', 42, {}, null, 'a'.repeat(513)]) {
    assert.equal(lessonChainRecord(job(), 'READY', 'stub', invalid).model_id, null);
  }
});
