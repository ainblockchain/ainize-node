/**
 * The shared model handed out in proportion to stake — and handed out exactly as before when nobody staked.
 *
 * Two claims, and the second is the one that could quietly break a node that never asked for any of this. A node
 * with no deposits configured builds no scheduler, and its queue must behave byte for byte as it did: teach
 * before verify, arrival order inside a class, `queueState()` reporting the same thing. The whole suite is the
 * real gate on that, but these pin it directly so a failure says what broke.
 *
 *   node --test --import tsx test/runtime-stake-order.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Runtime } from '../src/runtime.js';
import { StakeFairQueue } from '../src/stake-fair-queue.js';

/** A runtime with no model behind it: these tests are about the queue, and never call out. */
const bare = (scheduler?: StakeFairQueue) => new Runtime({ api: undefined }, undefined, scheduler);

/** Hold the section, so everything queued while we hold it is genuinely contending. */
async function underContention<T>(runtime: Runtime, queue: () => Promise<T>[]): Promise<T[]> {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const blocker = runtime.exclusive('chat', () => held);
  await new Promise((r) => setTimeout(r, 10));
  const work = queue();
  await new Promise((r) => setTimeout(r, 10));
  release();
  await blocker;
  return Promise.all(work);
}

test('without a scheduler the order is arrival order, exactly as before', async () => {
  const runtime = bare();
  const served: string[] = [];
  await underContention(runtime, () =>
    ['a', 'b', 'c', 'd'].map((id) => runtime.exclusive('chat', async () => { served.push(id); })));
  assert.deepEqual(served, ['a', 'b', 'c', 'd']);
});

test('without a scheduler the priority classes still order the queue', async () => {
  const runtime = bare();
  const served: string[] = [];
  await underContention(runtime, () => [
    runtime.exclusive('verify', async () => { served.push('verify'); }),
    runtime.exclusive('teach', async () => { served.push('teach'); }),
    runtime.exclusive('chat', async () => { served.push('chat'); }),
  ]);
  assert.deepEqual(served, ['chat', 'teach', 'verify'], 'a person waiting first, unpaid verification last');
});

test('with a scheduler, the bigger stake takes the front of a contended queue', async () => {
  const weights: Record<string, number> = { big: 20, small: 1 };
  const scheduler = new StakeFairQueue({ weightOf: (a) => weights[a] ?? 0, weightFloor: 0.01, now: () => Date.now() });
  const runtime = bare(scheduler);
  const served: string[] = [];
  await underContention(runtime, () => [
    ...Array.from({ length: 6 }, () => runtime.exclusive('chat', async () => { served.push('small'); }, { address: 'small' })),
    ...Array.from({ length: 6 }, () => runtime.exclusive('chat', async () => { served.push('big'); }, { address: 'big' })),
  ]);
  assert.equal(served.length, 12);
  const bigInFirstSix = served.slice(0, 6).filter((s) => s === 'big').length;
  assert.ok(bigInFirstSix >= 4, `a 20x stake should dominate the front of the queue, got ${bigInFirstSix}/6 — order was ${served.join(',')}`);
});

test('a scheduler never reorders across priority classes', async () => {
  const weights: Record<string, number> = { whale: 1000, nobody: 1 };
  const scheduler = new StakeFairQueue({ weightOf: (a) => weights[a] ?? 0, weightFloor: 0.01, now: () => Date.now() });
  const runtime = bare(scheduler);
  const served: string[] = [];
  await underContention(runtime, () => [
    runtime.exclusive('verify', async () => { served.push('verify'); }, { address: 'whale' }),
    runtime.exclusive('chat', async () => { served.push('chat'); }, { address: 'nobody' }),
  ]);
  assert.deepEqual(served, ['chat', 'verify'], 'no stake buys a way past what the node considers urgent');
});

test('a request with no address still runs — an anonymous caller is not stuck', async () => {
  const scheduler = new StakeFairQueue({ weightOf: () => 0, weightFloor: 0.01, now: () => Date.now() });
  const runtime = bare(scheduler);
  let ran = false;
  await runtime.exclusive('chat', async () => { ran = true; });
  assert.equal(ran, true);
});

test('queueState still reports what is waiting, with a scheduler attached', async () => {
  const scheduler = new StakeFairQueue({ weightOf: () => 1, weightFloor: 0.01, now: () => Date.now() });
  const runtime = bare(scheduler);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const blocker = runtime.exclusive('chat', () => held);
  await new Promise((r) => setTimeout(r, 10));
  const queued = runtime.exclusive('teach', async () => undefined, { address: 'x' });
  await new Promise((r) => setTimeout(r, 10));
  const state = runtime.queueState();
  assert.ok(state.queued.some((q) => q.label === 'teach'), 'the waiting teach job must still be visible');
  release();
  await Promise.all([blocker, queued]);
});
