/**
 * A fake PLE patch hook: the same mailbox protocol `vllm_patch/patch_hook.py` speaks, backed by an in-memory
 * bf16 table instead of a served model. It exists so `scripts/patch.py` — check, apply-with-journal,
 * remove-from-journal, status — and `runtime.ts` can be tested for real (the actual python, the actual npz
 * round-trip, the actual `prev` semantics) on a machine with no GPU.
 *
 * Protocol (patch_hook.py:9-13): request `<dir>/<name>.req.npz` { mode 'read'|'write', addrs int64[N],
 * rows float32[N,D] } → response `<dir>/<name>.ack.npz` { ok, addrs, prev float32[N,D] }, where `prev` is the
 * value BEFORE the write. Values are stored as bf16 with round-to-nearest-even, exactly as the real table does.
 */
import { readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { bf16Bits, readNpzMember, writeNpz } from '@ngram/core';

export const ROW_DIM = 160;

/** bf16 bits → float32 (the widening the hook does on the way out). */
export function fromBf16(bits: number): number {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setUint32(0, bits << 16, true);
  return new DataView(buf).getFloat32(0, true);
}

/** The value the untouched table holds at (addr, d) — this fake's "disk base", deterministic and bf16-exact. */
export function baseValue(addr: bigint, d: number): number {
  return fromBf16(bf16Bits((Number(addr % 9973n) * 160 + d) / 512));
}

/** Read a 0-dim / 1-dim numpy unicode member ('<U5') as a string. */
function readStr(path: string, name: string): string {
  const { header, body } = readNpzMember(path, name);
  const chars = Number(/[<|=]U(\d+)/.exec(header.descr)?.[1] ?? 0);
  let s = '';
  for (let i = 0; i < chars; i++) { const cp = body.readUInt32LE(i * 4); if (cp) s += String.fromCodePoint(cp); }
  return s;
}

export class FakeHook {
  /** addr → 160 bf16 words. Absent = still at `baseValue`. */
  private readonly rows = new Map<string, Uint16Array>();
  private timer: NodeJS.Timeout | null = null;
  /** Every request served, for assertions ("was this a read or a write, how many rows"). */
  readonly seen: { mode: string; rows: number }[] = [];
  /** Set to true to make the table look like a serving restart happened (everything back to base). */
  constructor(readonly dir: string) {}

  start(intervalMs = 15) {
    if (this.timer) return this;
    this.timer = setInterval(() => { try { this.tick(); } catch { /* a malformed file must not kill the poller */ } }, intervalMs);
    this.timer.unref?.();
    return this;
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** Drop every edit — what a vLLM restart does to the live table (the watchdog's trigger). */
  reset() { this.rows.clear(); }

  /** Current bf16 word of one cell (what an assertion compares against). */
  word(addr: bigint, d: number): number { return this.rows.get(String(addr))?.[d] ?? bf16Bits(baseValue(addr, d)); }
  /** How many of `addrs` have been written at all. */
  get touched(): number { return this.rows.size; }

  private tick() {
    let names: string[];
    try { names = readdirSync(this.dir).filter((n) => n.endsWith('.req.npz')).sort(); } catch { return; }
    for (const name of names) {
      const path = join(this.dir, name);
      // The writer renames into place, so a file is only complete once it is readable end to end.
      try { if (statSync(path).size < 100) continue; } catch { continue; }
      let addrs: BigInt64Array; let mode: string; let rows: Float32Array | null = null;
      try {
        mode = readStr(path, 'mode') || 'read';
        const a = readNpzMember(path, 'addrs');
        addrs = new BigInt64Array(a.body.buffer, a.body.byteOffset, a.body.length / 8);
        if (mode === 'write') { const r = readNpzMember(path, 'rows'); rows = new Float32Array(r.body.buffer, r.body.byteOffset, r.body.length / 4); }
      } catch { continue; }   // still being written
      const n = addrs.length;
      const prev = Buffer.alloc(n * ROW_DIM * 4);
      for (let i = 0; i < n; i++) {
        const cur = this.rows.get(String(addrs[i]));
        for (let d = 0; d < ROW_DIM; d++) prev.writeFloatLE(fromBf16(cur ? cur[d] : bf16Bits(baseValue(addrs[i], d))), (i * ROW_DIM + d) * 4);
      }
      if (mode === 'write' && rows) {
        for (let i = 0; i < n; i++) {
          const w = new Uint16Array(ROW_DIM);
          for (let d = 0; d < ROW_DIM; d++) w[d] = bf16Bits(rows[i * ROW_DIM + d]);
          this.rows.set(String(addrs[i]), w);
        }
      }
      this.seen.push({ mode, rows: n });
      const base = name.slice(0, -'.req.npz'.length);
      const tmp = join(this.dir, `${base}.ack.tmp.npz`);
      writeNpz(tmp, [
        { name: 'ok', descr: '<i8', shape: [], body: (() => { const b = Buffer.alloc(8); b.writeBigInt64LE(1n); return b; })() },
        { name: 'addrs', descr: '<i8', shape: [n], body: Buffer.from(addrs.buffer, addrs.byteOffset, n * 8) },
        { name: 'prev', descr: '<f4', shape: [n, ROW_DIM], body: prev },
      ]);
      renameSync(tmp, join(this.dir, `${base}.ack.npz`));
      rmSync(path, { force: true });
    }
  }
}

/**
 * Write a knowledge .npz the way the trainer does — `addrs`/`before`/`after`, float32, row-major — with every value
 * quantised to bf16 so what the file says and what the table can hold are the same thing.
 */
export function writeFixture(path: string, addrs: bigint[], before: (a: bigint, d: number) => number, after: (a: bigint, d: number) => number): void {
  const n = addrs.length;
  const ab = Buffer.alloc(n * 8), bb = Buffer.alloc(n * ROW_DIM * 4), afb = Buffer.alloc(n * ROW_DIM * 4);
  addrs.forEach((a, i) => {
    ab.writeBigInt64LE(a, i * 8);
    for (let d = 0; d < ROW_DIM; d++) {
      bb.writeFloatLE(fromBf16(bf16Bits(before(a, d))), (i * ROW_DIM + d) * 4);
      afb.writeFloatLE(fromBf16(bf16Bits(after(a, d))), (i * ROW_DIM + d) * 4);
    }
  });
  writeNpz(path, [
    { name: 'addrs', descr: '<i8', shape: [n], body: ab },
    { name: 'before', descr: '<f4', shape: [n, ROW_DIM], body: bb },
    { name: 'after', descr: '<f4', shape: [n, ROW_DIM], body: afb },
  ]);
}
