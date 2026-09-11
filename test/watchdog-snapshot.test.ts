import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Market } from '../src/market.js';

async function watchdogCase(before: string[], locked: string[]) {
  let current = before;
  let insideLock = false;
  const observed: string[] = [];
  const rebuilt: string[][] = [];
  const subject = {
    store: { listApplied: () => current.map(id => ({ patch_id: id, sha256: id, journal_path: `${id}.journal` })) },
    blobs: { get: (sha: string) => ({ path: `${sha}.npz` }) },
    recoverRuntime: async () => {},
    layersOfExact: async (ids: string[]) => ids.map(id => ({ id, sha256: id, path: `${id}.npz` })),
    log: () => {},
    noteRuntimeCheck: () => {},
    assertStack: async (layers: { id: string }[]) => { assert.equal(insideLock, true); rebuilt.push(layers.map(layer => layer.id)); },
    runtime: {
      status: async () => ({ available: true }),
      exclusiveTry: async (label: string, operation: () => Promise<void>) => {
        assert.equal(label, 'watchdog');
        current = locked;
        insideLock = true;
        try { await operation(); } finally { insideLock = false; }
      },
      statusOf: async (filename: string) => { assert.equal(insideLock, true); observed.push(filename); return { applied: false }; },
      lastOperation: () => null,
    },
  };
  await Market.prototype.watchdog.call(subject as unknown as Market);
  return { observed, rebuilt };
}

test('watchdog does not resurrect a patch removed while it waited for the runtime lock', async () => {
  assert.deepEqual(await watchdogCase(['removed'], []), { observed: [], rebuilt: [] });
});

test('watchdog rebuilds the current locked stack, not the previous visitor stack', async () => {
  assert.deepEqual(await watchdogCase(['old-chat'], ['new-owner']), { observed: ['new-owner.npz'], rebuilt: [['new-owner']] });
});

test('watchdog observes a newly loaded stack even if it was empty before the lock', async () => {
  assert.deepEqual(await watchdogCase([], ['new-owner']), { observed: ['new-owner.npz'], rebuilt: [['new-owner']] });
});
