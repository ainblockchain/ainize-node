/**
 * Unpaid work takes everything spare, and yields the moment somebody paid.
 *
 * This is what the free tier is limited BY, now that it is not limited by a press count. So the two claims have to
 * hold on both scarce things — the one shared language model and the per-backend gates in front of the other GPUs —
 * and on a node with no deposits configured, which is most of them: there the fair queue is never even built, and
 * ordering is the priority class and nothing else.
 *
 *   node --test --import tsx test/free-tier-priority.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Runtime, RUNTIME_PRIORITY } from '../src/runtime.js';
import { ModalityGate } from '../src/modality-gate.js';

const bare = () => new Runtime({ api: undefined });

/** Hold the resource, so everything queued while it is held is genuinely contending. */
async function underContention<T>(hold: (held: Promise<void>) => Promise<unknown>, queue: () => Promise<T>[]): Promise<T[]> {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const blocker = hold(held);
  await new Promise((r) => setTimeout(r, 10));
  const work = queue();
  await new Promise((r) => setTimeout(r, 10));
  release();
  await blocker;
  return Promise.all(work);
}

test('the free class sits between a paying caller and the node\'s own bake', () => {
  assert.ok(RUNTIME_PRIORITY.serving < RUNTIME_PRIORITY.freeServing, 'paid work goes first');
  assert.ok(RUNTIME_PRIORITY.freeServing < RUNTIME_PRIORITY.teach, 'but a person waiting still beats a background bake');
});

test('on the shared model, an unpaid turn waits behind a paid one that arrived later', async () => {
  const runtime = bare();
  const served: string[] = [];
  await underContention((held) => runtime.exclusive('chat', () => held), () => [
    runtime.exclusive('chat', async () => { served.push('free'); }, { priority: RUNTIME_PRIORITY.freeServing }),
    runtime.exclusive('chat', async () => { served.push('paid'); }, { priority: RUNTIME_PRIORITY.serving }),
  ]);
  assert.deepEqual(served, ['paid', 'free'], 'the free turn queued first and still goes second');
});

test('with nothing paid waiting, unpaid work runs in arrival order and nothing is held back', async () => {
  const runtime = bare();
  const served: string[] = [];
  await underContention((held) => runtime.exclusive('chat', () => held), () =>
    ['a', 'b', 'c'].map((id) => runtime.exclusive('chat', async () => { served.push(id); }, { priority: RUNTIME_PRIORITY.freeServing })));
  assert.deepEqual(served, ['a', 'b', 'c'], 'yielding to paid work is not the same as being throttled');
});

test('a modality gate orders by class too, so transcription and images behave like chat', async () => {
  // Every waiter used to be pinned to priority 0 here: a visitor's press and a program's key were the same request.
  const gate = new ModalityGate('image', 1);
  const served: string[] = [];
  await underContention((held) => gate.run(() => held, { address: 'holder', cost: 1 }), () => [
    gate.run(async () => { served.push('free'); }, { address: 'free-tier', cost: 1, priority: RUNTIME_PRIORITY.freeServing }),
    gate.run(async () => { served.push('paid'); }, { address: '0xpaid', cost: 1 }),
  ]);
  assert.deepEqual(served, ['paid', 'free'], 'the gate\'s default is serving, and free is behind it');
});
