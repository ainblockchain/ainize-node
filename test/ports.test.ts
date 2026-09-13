/**
 * No test may listen on a port the kernel is free to hand out.
 *
 * Every fixed port in this suite used to sit in 34xxx. Linux hands out ephemeral ports from 32768 upward
 * (`/proc/sys/net/ipv4/ip_local_port_range`), so 34xxx was inside the range the kernel draws from for every
 * `listen(0)` and every outgoing connection in the suite — of which there are many, since several files start a
 * fake model server on port 0. A file could therefore lose its own reserved port to another file's ephemeral
 * socket, and did: `before()` died with EADDRINUSE on a port nothing else declares, taking its whole file down.
 *
 * It read as flake. It was not: the failure rate just tracked how the process pool happened to interleave, so
 * adding one unrelated test file was enough to turn it on. The hand-assigned per-file ranges in the comments
 * above each PORT constant are real and still needed — files share one pool — but they only ever settled the
 * collisions between US. This settles the one with the kernel.
 *
 * 24xxx is below 32768 on any default Linux, and below the 49152 floor of the IANA dynamic range, so it is out
 * of reach of both. This test is what stops the next port from being picked out of the old block by habit.
 *
 *   node --test --import tsx test/ports.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The ports one line of a test file binds.
 *
 * Three shapes, because that is what the suite actually writes: the file's own `const PORT`, the extra nodes a
 * multi-node file starts inline (`mk('B', 24022, …)`), and a peer URL. Narrowing to those lines is what keeps a
 * 30000 ms timeout from being read as port 30000 — the numbers are indistinguishable, the lines are not.
 */
function portsIn(line: string): number[] {
  const code = line.split('//')[0]!;
  if (!/\bconst\s+PORT\w*\s*=|\bmk\(|127\.0\.0\.1:\d/.test(code)) return [];
  return [...code.matchAll(/\b(\d{4,5})\b/g)].map((m) => Number(m[1]));
}

/** Where the kernel on THIS machine draws ephemeral ports from — read, not assumed. */
function ephemeralFloor(): number {
  try { return Number(readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8').trim().split(/\s+/)[0]) || 32768; }
  catch { return 32768; }   // not Linux: fall back to the common floor rather than pass vacuously
}

test('every port a test binds is out of reach of the kernel', () => {
  const floor = ephemeralFloor();
  const offenders: string[] = [];
  let scanned = 0;
  for (const f of readdirSync(here).filter((n) => n.endsWith('.test.ts') && n !== 'ports.test.ts')) {
    const src = readFileSync(join(here, f), 'utf8');
    // Only PORT declarations: a five-digit number elsewhere is a timeout or a fixture, not something we bind.
    for (const line of src.split('\n')) {
      for (const port of portsIn(line)) {
        scanned++;
        if (port >= floor) offenders.push(`${f}: ${port} is inside the ephemeral range (${floor}+)`);
      }
    }
  }
  assert.deepEqual(offenders, [], `pick a port under ${floor} — 24xxx is this suite's block:\n${offenders.join('\n')}`);
  // A scan that matched nothing would pass this file for ever while the ports drifted back. It found 45 the day
  // it was written; the floor is low enough to survive files being added or removed, high enough to catch a
  // regex that stopped matching.
  assert.ok(scanned >= 25, `only ${scanned} ports found — the PORT pattern has stopped matching`);
});

test('no two files claim the same port', () => {
  const owner = new Map<number, string>();
  const clashes: string[] = [];
  for (const f of readdirSync(here).filter((n) => n.endsWith('.test.ts') && n !== 'ports.test.ts')) {
    for (const line of readFileSync(join(here, f), 'utf8').split('\n')) {
      for (const port of portsIn(line)) {
        const prev = owner.get(port);
        // `node --test` runs the files in one pool, so a shared constant is a hard EADDRINUSE, not a flake.
        if (prev && prev !== f) clashes.push(`${port}: ${prev} and ${f}`);
        owner.set(port, f);
      }
    }
  }
  assert.deepEqual(clashes, [], clashes.join('\n'));
});
