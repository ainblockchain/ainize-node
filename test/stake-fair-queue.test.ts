/**
 * Dividing one serialised model between callers in proportion to what they deposited.
 *
 * The model runs one request at a time behind a shared lease, so a deposit cannot buy a rate — it buys a share of
 * a queue. Rate-limiting each caller would be wrong twice over: it oversubscribes the node when many callers are
 * active, and wastes it when few are.
 *
 * Weighted fair queueing gives each waiter a virtual finish time of `max(now, lastVft[address]) + cost / weight`,
 * and serving lowest-first makes long-run throughput converge on the weight ratio. The `max(now, …)` clamp is
 * what stops an address returning from an idle stretch from arriving with a credit that would starve everyone
 * else — and it is also why nothing has to track who is "active": an address that is not asking has no entry in
 * the queue, and therefore no claim on it. "Share among active stakers" is not a rule implemented here. It is
 * what this discipline already does.
 *
 *   node --test --import tsx test/stake-fair-queue.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StakeFairQueue, type StakeFairEntry } from '../src/stake-fair-queue.js';

/**
 * Run `rounds` services against saturating demand from every address, and count who got served.
 *
 * Saturating means each caller immediately asks again the moment it is served, which is the only case where the
 * ratio is a claim about anything: with idle time in the queue everybody gets what they ask for.
 */
function simulate(weights: Record<string, number>, rounds: number): Record<string, number> {
  let clock = 0;
  const queue = new StakeFairQueue({ weightOf: (a) => weights[a] ?? 0, weightFloor: 0.01, now: () => clock });
  const served: Record<string, number> = {};
  const waiting: StakeFairEntry[] = [];
  let seq = 0;

  const enqueue = (address: string) => {
    const entry: StakeFairEntry = { priority: 0, seq: ++seq, address, cost: 1 };
    queue.admit(entry);
    waiting.push(entry);
  };

  for (const address of Object.keys(weights)) enqueue(address);
  for (let i = 0; i < rounds; i++) {
    const next = queue.take(waiting)!;
    waiting.splice(waiting.indexOf(next), 1);
    served[next.address] = (served[next.address] ?? 0) + 1;
    clock += 1;
    enqueue(next.address);
  }
  return served;
}

test('two saturating callers at 2:1 are served about 2:1', () => {
  const served = simulate({ big: 2, small: 1 }, 300);
  const ratio = served.big / served.small;
  assert.ok(ratio > 1.8 && ratio < 2.2, `expected about 2:1, got ${ratio}`);
});

test('three callers at 3:2:1 are served about 3:2:1', () => {
  const served = simulate({ a: 3, b: 2, c: 1 }, 600);
  assert.ok(Math.abs(served.a / served.c - 3) < 0.4, `a:c was ${served.a / served.c}`);
  assert.ok(Math.abs(served.b / served.c - 2) < 0.4, `b:c was ${served.b / served.c}`);
});

test('a hundredfold difference in stake is honoured, not flattened', () => {
  const served = simulate({ whale: 100, minnow: 1 }, 2020);
  assert.ok(served.minnow > 0, 'the small stake must still be served — starvation is not proportionality');
  const ratio = served.whale / served.minnow;
  assert.ok(ratio > 80 && ratio < 120, `expected about 100:1, got ${ratio}`);
});

test('an idle address takes nothing from the ones that are asking', () => {
  const served = simulate({ busy: 1, alsoBusy: 1 }, 200);
  assert.deepEqual(Object.keys(served).sort(), ['alsoBusy', 'busy']);
  assert.ok(Math.abs(served.busy - served.alsoBusy) <= 2, 'two equal active stakes split the queue evenly');
});

test('an idle depositor does not dilute the active ones', () => {
  // `sleeper` holds nine tenths of the stake and never asks. The two who do ask split the node between them.
  let clock = 0;
  const weights: Record<string, number> = { sleeper: 90, a: 5, b: 5 };
  const queue = new StakeFairQueue({ weightOf: (x) => weights[x] ?? 0, weightFloor: 0.01, now: () => clock });
  const waiting: StakeFairEntry[] = [];
  const served: Record<string, number> = {};
  let seq = 0;
  const enqueue = (address: string) => {
    const entry: StakeFairEntry = { priority: 0, seq: ++seq, address, cost: 1 };
    queue.admit(entry); waiting.push(entry);
  };
  enqueue('a'); enqueue('b');
  for (let i = 0; i < 200; i++) {
    const next = queue.take(waiting)!;
    waiting.splice(waiting.indexOf(next), 1);
    served[next.address] = (served[next.address] ?? 0) + 1;
    clock += 1;
    enqueue(next.address);
  }
  assert.equal(served.sleeper, undefined);
  assert.ok(Math.abs(served.a - served.b) <= 2, `a=${served.a} b=${served.b} — the sleeper's 90% took nothing`);
});

test('once the queue drains, a returning address starts level with a brand-new one', () => {
  let clock = 0;
  const queue = new StakeFairQueue({ weightOf: () => 1, weightFloor: 0.01, now: () => clock });
  const first: StakeFairEntry = { priority: 0, seq: 1, address: 'gone', cost: 1 };
  queue.admit(first);
  queue.take([first]);          // served
  queue.take([]);               // and the queue is now empty
  clock = 10_000;
  const returning = queue.admit({ priority: 0, seq: 2, address: 'gone', cost: 1 });
  const fresh = queue.admit({ priority: 0, seq: 3, address: 'new', cost: 1 });
  assert.equal(returning, fresh, 'neither a credit nor a debt survives the idle period');
});

test('a caller that never stopped asking keeps its place rather than being reset by a draining queue', () => {
  const queue = new StakeFairQueue({ weightOf: () => 1, weightFloor: 0.01, now: () => 0 });
  const outstanding: StakeFairEntry = { priority: 0, seq: 1, address: 'waiting', cost: 1 };
  queue.admit(outstanding);
  const second = queue.admit({ priority: 0, seq: 2, address: 'waiting', cost: 1 });
  const other = queue.admit({ priority: 0, seq: 3, address: 'other', cost: 1 });
  assert.ok(second > other, 'an unserved request still counts against the address that made it');
});

test('a burst from one address is paid for by that address, not by everyone', () => {
  const queue = new StakeFairQueue({ weightOf: () => 1, weightFloor: 0.01, now: () => 0 });
  const first = queue.admit({ priority: 0, seq: 1, address: 'greedy', cost: 1 });
  const second = queue.admit({ priority: 0, seq: 2, address: 'greedy', cost: 1 });
  const other = queue.admit({ priority: 0, seq: 3, address: 'other', cost: 1 });
  assert.ok(second > other, 'a second request from one address queues behind a first from another');
  assert.ok(first < other || first === other, 'but its first request is not penalised');
});

test('a costly request delays its own sender, in proportion to what it asked for', () => {
  const queue = new StakeFairQueue({ weightOf: () => 1, weightFloor: 0.01, now: () => 0 });
  const cheap = queue.admit({ priority: 0, seq: 1, address: 'a', cost: 1 });
  const dear = queue.admit({ priority: 0, seq: 2, address: 'b', cost: 100 });
  assert.ok(dear > cheap, 'asking for a hundred times the work costs a hundred times the virtual time');
});

test('priority still wins: WFQ orders within a class, never across it', () => {
  const queue = new StakeFairQueue({ weightOf: () => 1, weightFloor: 0.01, now: () => 0 });
  const serving: StakeFairEntry = { priority: 0, seq: 2, address: 'tiny', cost: 1000 };
  const verify: StakeFairEntry = { priority: 9, seq: 1, address: 'huge', cost: 1 };
  queue.admit(verify); queue.admit(serving);
  assert.equal(queue.take([verify, serving])?.priority, 0, 'a person waiting beats unpaid background work');
});

test('a caller with no deposit is served last, not never', () => {
  const queue = new StakeFairQueue({ weightOf: (a) => (a === 'free' ? 0 : 1), weightFloor: 0.01, now: () => 0 });
  const free: StakeFairEntry = { priority: 0, seq: 1, address: 'free', cost: 1 };
  const paid: StakeFairEntry = { priority: 0, seq: 2, address: 'paid', cost: 1 };
  assert.ok(Number.isFinite(queue.admit(free)), 'zero weight must not become an infinite finish time');
  queue.admit(paid);
  assert.equal(queue.take([free, paid]), paid, 'the depositor goes first');
  assert.equal(queue.take([free]), free, 'and the free caller runs when nobody is waiting');
});

test('an empty queue yields nothing rather than throwing', () => {
  const queue = new StakeFairQueue({ weightOf: () => 1, weightFloor: 0.01, now: () => 0 });
  assert.equal(queue.take([]), null);
});

test('ties are broken by arrival order, so nothing starves inside one weight', () => {
  const queue = new StakeFairQueue({ weightOf: () => 1, weightFloor: 0.01, now: () => 0 });
  const second: StakeFairEntry = { priority: 0, seq: 2, address: 'a', cost: 1 };
  const first: StakeFairEntry = { priority: 0, seq: 1, address: 'b', cost: 1 };
  queue.admit(first); queue.admit(second);
  assert.equal(queue.take([second, first]), first);
});

test('an entry never admitted is not chosen over one that was', () => {
  const queue = new StakeFairQueue({ weightOf: () => 1, weightFloor: 0.01, now: () => 0 });
  const admitted: StakeFairEntry = { priority: 0, seq: 2, address: 'a', cost: 1 };
  const stray: StakeFairEntry = { priority: 0, seq: 1, address: 'b', cost: 1 };
  queue.admit(admitted);
  assert.equal(queue.take([stray, admitted]), admitted);
});

test('forgetting a long-idle address frees memory without changing any decision', () => {
  let clock = 0;
  const queue = new StakeFairQueue({ weightOf: () => 1, weightFloor: 0.01, now: () => clock });
  const first: StakeFairEntry = { priority: 0, seq: 1, address: 'gone', cost: 1 };
  queue.admit(first);
  queue.take([first]);
  queue.take([]);
  assert.equal(queue.trackedAddresses, 1);

  clock = 1_000_000;
  assert.equal(queue.forgetIdle(60_000), 1);
  assert.equal(queue.trackedAddresses, 0);

  const afterForget = queue.admit({ priority: 0, seq: 2, address: 'gone', cost: 1 });
  const fresh = queue.admit({ priority: 0, seq: 3, address: 'new', cost: 1 });
  assert.equal(afterForget, fresh, 'a drained queue had already levelled them — forgetting is only about memory');
});

test('an address still in the queue is not forgotten just because it has waited a long time', () => {
  let clock = 0;
  const queue = new StakeFairQueue({ weightOf: () => 1, weightFloor: 0.01, now: () => clock });
  queue.admit({ priority: 0, seq: 1, address: 'patient', cost: 1 });
  clock = 30_000;
  queue.admit({ priority: 0, seq: 2, address: 'patient', cost: 1 });
  clock = 60_000;
  assert.equal(queue.forgetIdle(60_000), 0, 'it was seen 30s ago, not 60');
});
