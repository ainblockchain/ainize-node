/**
 * Royalty payouts on the AIN ledger (spec §9.3, §7.5 `payouts`).
 *
 * The buyer pays the node (x402 `payTo = node`). After the seller node appended the `settle` record it owes every
 * non-self address in `settle.royalty` its slice. For each of them a `payouts` row is written BEFORE `wallet.transfer`
 * is attempted, so a crash between the two leaves a `pending` row instead of a silently missing transfer:
 *
 *   pending ──transfer ok──▶ paid   (tx_hash)
 *      │ ▲
 *      ▼ │ 60 s timer, max 20 attempts (then the operator retries by hand from the Payouts tab / `POST /api/me/payouts/:id/retry`)
 *   failed (last_error)
 *
 * Local-credit settles never come here: the play-money balance is derived from the settle record itself
 * (`Market.creditBalance()`), so the contributor is credited the instant the record is appended.
 */
import type { Settlement } from '@ngram/core';
import type { EventRow, PayoutRow, Store } from './store.js';

/** What the payout loop needs from the chain wallet (`AinLedger.transfer` satisfies it; tests pass a fake). */
export interface PayoutWallet { transfer(to: string, value: number): Promise<{ tx_hash: string }> }

export const PAYOUT_RETRY_MS = 60_000;
export const PAYOUT_MAX_ATTEMPTS = 20;

export interface PayoutRun { attempted: number; paid: number; failed: number }

type LogFn = (level: EventRow['level'], kind: string, message: string, patchId?: string | null, data?: unknown) => void;

export class Payouts {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<PayoutRun> | null = null;
  private again = false;
  readonly retryMs: number;
  readonly maxAttempts: number;

  constructor(
    private readonly store: Store,
    private readonly log: LogFn,
    /** null when this node has no chain wallet (local ledger) — rows stay `pending` until one is configured. */
    public wallet: PayoutWallet | null,
    private readonly opts: { selfAddress: string; retryMs?: number; maxAttempts?: number },
  ) {
    this.retryMs = opts.retryMs ?? PAYOUT_RETRY_MS;
    this.maxAttempts = opts.maxAttempts ?? PAYOUT_MAX_ATTEMPTS;
  }

  /**
   * Write one `pending` row per non-self, non-zero royalty address of `settlement` (idempotent per settle record:
   * a row that already exists for (settle_hash, address) is kept, e.g. after a restart). Returns the rows to pay.
   */
  enqueue(settlement: Settlement, settleHash: string): PayoutRow[] {
    const rows: PayoutRow[] = [];
    const self = this.opts.selfAddress.toLowerCase();
    for (const [address, amount] of Object.entries(settlement.royalty ?? {})) {
      if (address.toLowerCase() === self || !(Number(amount) > 0)) continue;
      const existing = this.store.findPayout(settleHash, address);
      if (existing) { rows.push(existing); continue; }
      const row = this.store.insertPayout({ patch_id: settlement.patch_id, settle_hash: settleHash, address, amount: String(amount), currency: settlement.currency });
      this.log('info', 'payout', `owe ${row.amount} ${row.currency} to ${address.slice(0, 10)}… for ${settlement.patch_id} (payout #${row.id} pending)`, settlement.patch_id, { payout_id: row.id, address, amount: row.amount, settle_hash: settleHash });
      rows.push(row);
    }
    return rows;
  }

  /** One transfer attempt for `row`; the row ends `paid` (tx_hash) or `failed` (last_error), attempts + 1. */
  async attempt(row: PayoutRow): Promise<PayoutRow> {
    if (row.status === 'paid') return row;
    const attempts = row.attempts + 1;
    if (!this.wallet) {
      return this.store.updatePayout(row.id, { status: 'failed', attempts, last_error: 'no chain wallet on this node' });
    }
    try {
      const r = await this.wallet.transfer(row.address, Number(row.amount));
      const next = this.store.updatePayout(row.id, { status: 'paid', attempts, tx_hash: r.tx_hash, last_error: null });
      this.log('info', 'payout', `paid ${row.amount} ${row.currency} royalty to ${row.address.slice(0, 10)}… (${r.tx_hash.slice(0, 12)}, attempt ${attempts})`, row.patch_id, { payout_id: row.id, tx_hash: r.tx_hash, attempts });
      return next;
    } catch (e) {
      const msg = ((e as Error).message ?? String(e)).slice(0, 500);
      const next = this.store.updatePayout(row.id, { status: 'failed', attempts, last_error: msg });
      const final = attempts >= this.maxAttempts;
      this.log('warn', 'payout', `royalty transfer to ${row.address.slice(0, 10)}… failed (attempt ${attempts}/${this.maxAttempts}${final ? ', giving up — retry from the Payouts tab' : ''}): ${msg}`, row.patch_id, { payout_id: row.id, attempts, error: msg });
      return next;
    }
  }

  /** Rows the timer should (re)try now: never attempted, or failed < max attempts and older than the retry interval. */
  due(now = Date.now()): PayoutRow[] {
    return this.store.listPayouts({ status: ['pending', 'failed'], limit: 500 })
      .filter((r) => r.status === 'pending' || (r.attempts < this.maxAttempts && now - r.updated_at >= this.retryMs))
      .sort((a, b) => a.id - b.id);
  }

  /** Pay everything that is due, one transfer at a time (serialised; a call during a run schedules one more pass). */
  processPending(): Promise<PayoutRun> {
    if (this.running) { this.again = true; return this.running; }
    this.running = (async () => {
      await undefined;   // let the assignment above land before a synchronous empty pass reaches `finally`
      const out: PayoutRun = { attempted: 0, paid: 0, failed: 0 };
      try {
        do {
          this.again = false;
          for (const row of this.due()) {
            if (this.store.isClosed) return out;
            const r = await this.attempt(row);
            out.attempted++;
            if (r.status === 'paid') out.paid++; else out.failed++;
          }
        } while (this.again);
      } finally { this.running = null; }
      return out;
    })();
    return this.running;
  }

  /** Operator retry: one immediate attempt, allowed even after the automatic attempts are exhausted. */
  async retry(id: number): Promise<PayoutRow> {
    const row = this.store.getPayout(id);
    if (!row) throw new PayoutError(404, `payout ${id} not found`);
    if (row.status === 'paid') throw new PayoutError(409, `payout ${id} is already paid (${row.tx_hash})`);
    return this.attempt(row);
  }

  summary() { return this.store.payoutSummary(); }

  /** 60-s retry timer (spec §9.3); also runs once shortly after start to pick up rows left `pending` by a crash. */
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { this.processPending().catch(() => undefined); }, this.retryMs);
    this.timer.unref?.();
    setTimeout(() => { this.processPending().catch(() => undefined); }, Math.min(this.retryMs, 3000)).unref?.();
  }
  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
}

export class PayoutError extends Error { constructor(readonly status: number, message: string) { super(message); } }
