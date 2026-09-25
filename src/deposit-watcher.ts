/**
 * Watching chains for the transfers that buy a share of this node.
 *
 * A caller buys throughput by sending AIN or sAIN to the operator's address. This turns those transfers into
 * credited share, and the whole of its job is not to be wrong in either direction:
 *
 *   • **Never credit twice.** Ranges get re-scanned on restart and after a failure. The ledger is idempotent on
 *     (chain, txHash, logIndex), and this only ever advances its journal past blocks it actually finished.
 *
 *   • **Never credit too early.** A log deep enough to be in a block is not deep enough to be permanent. Each
 *     chain declares its own confirmation depth and nothing below it is looked at, so a reorg drops a transfer
 *     that was never counted rather than one that was.
 *
 * Failure stops the scan where it happened. A scan that raises has NOT advanced the journal for the chain that
 * failed, so the next pass redoes exactly that range — chains that already finished keep their progress, because
 * losing it would mean re-reading blocks whose credits the ledger would then have to reject one by one.
 *
 * The chain is reached through injected functions rather than a client built here. That is not only for tests:
 * it keeps `viem` at one edge of the file, so what this module is actually responsible for — the arithmetic of
 * when a transfer counts — can be read and checked without a network.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DepositLedger } from '@ainize/core';

/** One ERC-20 `Transfer` as the reader hands it over. */
export interface DepositTransferLog {
  txHash: string;
  logIndex: number;
  from: string;
  to: string;
  /** Raw token amount, in the token's own units. Converted to share units by `sharesFor` unless the token IS the share. */
  value: bigint;
  blockNumber: number;
}

export interface DepositChainConfig {
  /** Name used in the ledger's identity key and in the journal. Distinct per chain: tx hashes repeat across chains. */
  chain: string;
  rpcUrl: string;
  /** The ERC-20 whose transfers count as a deposit on this chain. */
  token: string;
  /** How deep a block must be before its transfers are credited. */
  confirmations: number;
  /** True when `token` is the sAIN vault share itself — already in share units, so no conversion. */
  isVaultShare: boolean;
}

export type DepositLogReader = (chain: string, fromBlock: number, toBlock: number) => Promise<DepositTransferLog[]>;

export interface DepositWatcherDeps {
  chains: DepositChainConfig[];
  /** The operator address deposits are sent to. */
  receivingAddress: string;
  ledger: DepositLedger;
  /** Convert a raw token amount into sAIN share units (the vault's `convertToShares`). */
  sharesFor: (chain: string, amount: bigint) => Promise<bigint>;
  readLogs: DepositLogReader;
  chainHead: (chain: string) => Promise<number>;
  /** Where scan progress is persisted, so a restart does not re-read the chain from genesis. */
  journalFile: string;
  log?: (message: string) => void;
}

/** How many blocks one pass reads at most, so a node that was down for a week does not ask for a week in one call. */
export const DEPOSIT_SCAN_MAX_BLOCKS = 5_000;

export class DepositWatcher {
  private readonly scanned = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private scanning = false;

  constructor(private readonly deps: DepositWatcherDeps) {
    this.load();
  }

  /**
   * One pass over every configured chain. Returns how many deposits were credited.
   *
   * Chains are done in order and each commits its own progress, so a later chain failing cannot undo an earlier
   * chain's work. The failure is re-thrown: a caller polling on a timer needs to know its view is stale, and a
   * watcher that swallows an RPC error looks exactly like one watching an empty chain.
   */
  async scanOnce(): Promise<number> {
    let credited = 0;
    for (const chain of this.deps.chains) {
      credited += await this.scanChain(chain);
    }
    return credited;
  }

  private async scanChain(chain: DepositChainConfig): Promise<number> {
    const head = await this.deps.chainHead(chain.chain);
    const safeHead = head - chain.confirmations;
    const from = this.lastScannedBlock(chain.chain) + 1;
    if (safeHead < from) return 0;                       // nothing is deep enough yet
    const to = Math.min(safeHead, from + DEPOSIT_SCAN_MAX_BLOCKS - 1);

    const receiver = this.deps.receivingAddress.toLowerCase();
    const logs = await this.deps.readLogs(chain.chain, from, to);

    let credited = 0;
    for (const log of logs) {
      if (log.to.toLowerCase() !== receiver) continue;
      // Converted one at a time, at the rate holding when the deposit is credited. Converting a batch at one
      // rate would hand whoever arrived first somebody else's exchange rate.
      const shares = chain.isVaultShare ? log.value : await this.deps.sharesFor(chain.chain, log.value);
      const isNew = this.deps.ledger.credit({
        chain: chain.chain, txHash: log.txHash, logIndex: log.logIndex,
        from: log.from, shares, blockNumber: log.blockNumber,
      });
      if (isNew) {
        credited++;
        this.deps.log?.(`credited ${shares} share units to ${log.from.toLowerCase()} (${chain.chain} ${log.txHash})`);
      }
    }

    // Only now, with every log in this range credited, is the range finished.
    this.scanned.set(chain.chain, to);
    this.persist();
    return credited;
  }

  /** The last block whose deposits are fully credited on this chain; 0 when nothing has been scanned. */
  lastScannedBlock(chain: string): number {
    return this.scanned.get(chain) ?? 0;
  }

  start(intervalMs: number): void {
    if (this.timer) return;
    const tick = async () => {
      if (this.scanning) return;                          // a slow pass must not overlap the next one
      this.scanning = true;
      try { await this.scanOnce(); }
      catch (error) { this.deps.log?.(`deposit scan failed, will retry: ${error instanceof Error ? error.message : String(error)}`); }
      finally { this.scanning = false; }
    };
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref?.();
    void tick();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private load(): void {
    if (!existsSync(this.deps.journalFile)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.deps.journalFile, 'utf8')) as Record<string, number>;
      for (const [chain, block] of Object.entries(parsed)) {
        if (Number.isSafeInteger(block) && block >= 0) this.scanned.set(chain, block);
      }
    } catch {
      // An unreadable journal means rescanning, which is slow but safe: the ledger rejects every repeat. Starting
      // over is the only alternative to trusting a number we cannot read, and trusting it would skip blocks.
      this.deps.log?.(`${this.deps.journalFile} is unreadable — rescanning from the start`);
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.deps.journalFile), { recursive: true, mode: 0o700 });
    const tmp = `${this.deps.journalFile}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.scanned)), { mode: 0o600 });
      renameSync(tmp, this.deps.journalFile);
    } catch (error) {
      try { unlinkSync(tmp); } catch { /* it may never have been created */ }
      throw error;
    }
  }
}
