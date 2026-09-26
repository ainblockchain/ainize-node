import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function processScope(): { boot: string; namespace: string } | null {
  try {
    return { boot: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), namespace: readlinkSync('/proc/self/ns/pid') };
  } catch { return null; }
}

export function leaseLiveness(holder: Record<string, unknown>): 'alive' | 'dead' | 'unknown' {
  const scope = processScope();
  const recorded = holder.process_scope as { boot?: unknown; namespace?: unknown } | undefined;
  const match = typeof holder.owner === 'string' ? /^pid:([1-9][0-9]*)$/.exec(holder.owner) : null;
  if (!scope || !recorded || recorded.boot !== scope.boot || recorded.namespace !== scope.namespace || !match) return 'unknown';
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid)) return 'unknown';
  try { process.kill(pid, 0); return 'alive'; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown'; }
}

export function claimSharedLease(directory: string, metadata: Record<string, unknown>): (() => void) | null {
  try { mkdirSync(directory, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null;
    throw error;
  }
  const token = randomUUID();
  const holderPath = join(directory, 'holder.json');
  writeFileSync(holderPath, JSON.stringify({ ...metadata, lease_id: token, process_scope: processScope() }), { flag: 'wx', mode: 0o600 });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      const holder = JSON.parse(readFileSync(holderPath, 'utf8'));
      if (holder?.lease_id === token) rmSync(directory, { recursive: true, force: true });
    } catch {}
  };
}

/**
 * Take back a lease whose holder is provably gone — and only then.
 *
 * A process that dies holding the lease (a deploy restarting the node mid-chat, a crash, an OOM kill) leaves the
 * directory behind, and `claimSharedLease` can never succeed again: every caller waits out its timeout, fails with
 * "shared runtime busy", and the next one starts waiting. On ainize.ai that was the whole chat model stuck behind
 * one dead pid until somebody deleted a directory by hand.
 *
 * "Provably" is `leaseLiveness(...) === 'dead'`: same boot, same PID namespace, and the kernel says no such
 * process. A holder on another machine, in another container or across a reboot is 'unknown' and is never taken —
 * that is a human's call, as it always was.
 *
 * The directory is renamed aside (atomic) rather than deleted in place, and what was moved is checked: if another
 * process reclaimed it and a LIVE holder took the lease between our read and our rename, that lease is put back.
 * Returns true when the dead lease is gone and the caller should try to claim again.
 */
export function reclaimDeadSharedLease(directory: string): boolean {
  let holder: Record<string, unknown>;
  try { holder = JSON.parse(readFileSync(join(directory, 'holder.json'), 'utf8')) as Record<string, unknown>; }
  catch { return false; }
  if (leaseLiveness(holder) !== 'dead') return false;
  const aside = `${directory}.dead-${randomUUID()}`;
  try { renameSync(directory, aside); } catch { return false; }
  let moved: Record<string, unknown> | null = null;
  try { moved = JSON.parse(readFileSync(join(aside, 'holder.json'), 'utf8')) as Record<string, unknown>; } catch { /* unreadable: treat as the dead one */ }
  if (moved && moved.lease_id !== holder.lease_id) {
    try { renameSync(aside, directory); } catch { /* the slot was claimed again meanwhile; the moved lease was not ours to keep */ }
    return false;
  }
  rmSync(aside, { recursive: true, force: true });
  return true;
}
