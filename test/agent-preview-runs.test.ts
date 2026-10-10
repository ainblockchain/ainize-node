import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentPreviewRuns } from '../src/agent-preview-runs.js';
import type { AgentPreview } from '../src/agent-previews.js';

test('private proposal evidence survives restart, marks interrupted requests, and cannot be changed through returned objects', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ainize-review-records-'));
  try {
    const file = join(dir, 'evidence.json'), store = new AgentPreviewRuns(file);
    const preview: AgentPreview = { id: 'preview-one', agent: 'desk', commit: 'a'.repeat(40), owner: 'alice', createdAt: 1, expiresAt: 2, status: 'ready', error: null };
    const request = { message: 'original prompt' };
    const done = store.begin(preview, 'selected-model', request);
    request.message = 'mutated';
    store.finish(done.id, { status: 'ready', output: 'answer', outputBytes: 6, outputTruncated: false, error: null });
    store.begin(preview, 'selected-model', { message: 'interrupted' });
    const restored = new AgentPreviewRuns(file), records = restored.list('desk', 'ALICE');
    assert.deepEqual(records.map((record) => record.status), ['error', 'ready']);
    assert.match(records[0].error!, /restarted/);
    assert.deepEqual(records[1].request, { message: 'original prompt' });
    assert.equal(records[1].output, 'answer');
    assert.equal(records[1].model, 'selected-model');
    records[1].output = 'changed';
    assert.equal(restored.list('desk', 'alice')[1].output, 'answer');
    assert.deepEqual(restored.list('desk', 'bob'), []);
    assert.deepEqual(restored.list('other-agent', 'alice'), []);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(restored.remove(done.id, 'desk', 'bob'), 'missing');
    assert.equal(restored.remove(done.id, 'desk', 'alice'), 'not_exported');
    assert.equal(restored.export(done.id, 'desk', 'bob'), null);
    const exported = restored.export(done.id, 'desk', 'alice')!;
    assert.equal(exported.output, 'answer');
    assert.ok(exported.exportedAt);
    const afterExport = new AgentPreviewRuns(file);
    assert.equal(afterExport.remove(done.id, 'desk', 'alice'), 'removed');
    assert.equal(new AgentPreviewRuns(file).list('desk', 'alice').length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
