import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
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
