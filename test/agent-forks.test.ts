import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentForkStore } from '../src/agent-forks.js';
test('personal fork limits survive restart, and deleting a fork releases the owner quota', () => {
  const root = mkdtempSync(join(tmpdir(), 'fork-limit-'));
  try {
    const file = join(root, 'forks.json');
    const store = new AgentForkStore(file);
    for (let n = 0; n < 10; n++) store.add({ id: `fork-${n}`, parent: 'desk', owner: 'Owner', baseCommit: 'a'.repeat(40), createdAt: n });
    const restored = new AgentForkStore(file);
    assert.equal(restored.list('owner').length, 10);
    assert.throws(() => restored.add({ id: 'over-limit', parent: 'desk', owner: 'owner', baseCommit: 'a'.repeat(40), createdAt: 11 }), /limit/);
    restored.remove('fork-0');
    restored.add({ id: 'replacement', parent: 'desk', owner: 'owner', baseCommit: 'a'.repeat(40), createdAt: 12 });
    assert.equal(new AgentForkStore(file).list('owner').length, 10);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
