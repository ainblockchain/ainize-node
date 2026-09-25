/**
 * Keeping the deposit ledger across restarts.
 *
 * The ledger itself is pure and lives in core; this is the node's half. It matters more than most persistence
 * because a credit the node forgets is a caller who paid for a share they no longer have — and, since deposits
 * cannot be withdrawn, there is nothing they can do about it but pay again.
 *
 * Forgetting is recoverable in principle: the watcher's journal could be reset and the chains re-read. But that
 * means re-reading every block since the node first opened, across every chain, and it silently produces a wrong
 * answer if any RPC's history has been pruned. So the ledger is written out rather than treated as a cache.
 *
 * `bigint` does not survive `JSON.stringify`, so shares are stored as decimal strings. That is not a workaround:
 * a decimal string is the only JSON form that holds an 18-decimal amount exactly.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DepositLedger, type DepositEvent } from '@ainize/core';

interface StoredDepositEvent {
  chain: string;
  txHash: string;
  logIndex: number;
  from: string;
  /** Decimal string: JSON has no bigint, and a double cannot hold 18 decimals. */
  shares: string;
  blockNumber: number;
}

export class DepositLedgerStore {
  constructor(private readonly file: string) {}

  /**
   * Rebuild the ledger from disk. A file we cannot read gives an EMPTY ledger and says so loudly, rather than a
   * partial one: crediting some of a caller's deposits and not others is worse than crediting none, because only
   * the second is obviously wrong to the operator reading the log.
   */
  load(): DepositLedger {
    if (!existsSync(this.file)) return new DepositLedger();
    try {
      const rows = JSON.parse(readFileSync(this.file, 'utf8')) as StoredDepositEvent[];
      return DepositLedger.from(rows.map(toEvent));
    } catch (error) {
      console.error(`[deposits] ${this.file} is unreadable (${error instanceof Error ? error.message : error}) — ` +
        'starting with NO credited deposits. Reset the watcher journal to re-read the chains before serving.');
      return new DepositLedger();
    }
  }

  save(ledger: DepositLedger): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    const rows: StoredDepositEvent[] = ledger.snapshot().map((event) => ({ ...event, shares: event.shares.toString() }));
    try {
      writeFileSync(tmp, JSON.stringify(rows), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (error) {
      try { unlinkSync(tmp); } catch { /* it may never have been created */ }
      throw error;
    }
  }
}

function toEvent(row: StoredDepositEvent): DepositEvent {
  return { ...row, shares: BigInt(row.shares) };
}
