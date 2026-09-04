/**
 * Lineage design L0 — demand signals and visitor privacy (§5.6, §10, AZ-258 in the design's numbering):
 *  - `patch_signals_daily` is materialised at write time and survives the event retention purge;
 *  - unique visitors are a HyperLogLog over HMAC visitor ids — the table never holds an address;
 *  - `Market.visitorId` is stable per node and secret-keyed, never an IP.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hll, Store } from '../src/store.js';

test('patch_signals_daily: counters add up per day, visitors are estimated from HMAC ids, purge keeps them', () => {
  const s = new Store(':memory:');
  s.event('info', 'usage', 'old', 'p', { visitor: 'ip:1.2.3.4' });
  s.bumpSignals('p', { tests: 1, hits: 1 }, { visitor: 'v:aaaa', day: '2026-08-01' });
  s.bumpSignals('p', { tests: 1, misses: 1 }, { visitor: 'v:bbbb', day: '2026-08-01' });
  s.bumpSignals('p', { tests: 1, unscored: 1 }, { visitor: 'v:aaaa', day: '2026-09-01' });
  s.bumpSignals('p', { builds_on_jobs: 1 });
  s.bumpSignals('q', { tests: 5 });
  // nothing to write → no row
  s.bumpSignals('p', { tests: 0 });
  const all = s.signals('p', 36_500);
  assert.equal(all.tests, 3); assert.equal(all.hits, 1); assert.equal(all.misses, 1); assert.equal(all.unscored, 1); assert.equal(all.builds_on_jobs, 1);
  assert.equal(all.visitors, 2, 'two distinct visitor ids across the days');
  assert.equal(all.days, 3);
  assert.equal(s.signals('q').tests, 5);
  assert.deepEqual(Object.keys(s.signals('none')).sort(), ['builds_on_jobs', 'days', 'derive_fetches', 'hits', 'marked_wrong', 'misses', 'overlaps_pointed', 'parent_regression_fails', 'preflight_base_conflict', 'preflight_in_base', 'preflight_wrong_today', 'tests', 'unscored', 'visitors', 'window_days']);
  // retention: the raw event goes, the counters stay
  assert.equal(s.purgeEvents(Date.now() + 1000), 1);
  assert.equal(s.events({ kind: 'usage' }).length, 0);
  assert.equal(s.signals('p', 36_500).tests, 3);
  // the secret is minted once and kept
  const secret = s.visitorSecret();
  assert.match(secret, /^[0-9a-f]{64}$/);
  assert.equal(s.visitorSecret(), secret);
  s.close();
});

test('HyperLogLog: close to the true count from a handful to tens of thousands, and merge = union', () => {
  let a: Buffer | null = null;
  for (let i = 0; i < 5; i++) a = hll.add(a, `v:${i}`);
  assert.equal(hll.count(a!), 5, 'small counts are exact via the linear-counting correction');
  let b: Buffer | null = null;
  for (let i = 0; i < 20_000; i++) b = hll.add(b, `id-${i}`);
  const n = hll.count(b!);
  assert.ok(Math.abs(n - 20_000) / 20_000 < 0.08, `estimate ${n} within 8 % of 20000`);
  const m = hll.merge(a, b!);
  assert.ok(hll.count(m) >= n, 'union is at least the larger side');
  assert.equal(hll.count(hll.merge(b, b!)), n, 'merging a sketch with itself changes nothing');
});
