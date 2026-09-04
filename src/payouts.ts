/**
 * Royalty payouts on the AIN ledger (spec §9.3, §7.5 `payouts`).
 *
 * The buyer pays the node (x402 `payTo = node`). After the seller node appended the `settle` record it owes every
 * non-self address in `settle.royalty` its slice. For each of them a `payouts` row is written BEFORE `wallet.transfer`
 * is attempted, so a crash between the two leaves a `pending` row instead of a silently missing transfer:
 *
 *   pending ──claim──▶ paying ──transfer ok──▶ paid   (tx_hash)
 *      ▲                 │
 *      │                 ▼ error
 *      └──── 60 s timer, max 20 attempts ──── failed (last_error)   (then the operator retries by hand: Payouts tab / `POST /api/me/payouts/:id/retry`)
 *
 * Double-payment guards (security review): every transfer — timer pass, the pass triggered by a sale, and the operator
 * retry — goes through ONE serialised runner (`processPending`), and each attempt first claims the row atomically
 * (`UPDATE … SET status='paying' WHERE status IN ('pending','failed')`); a row that is already `paying` or `paid` is never
 * transferred again, whatever snapshot the caller held. A row still `paying` when the node boots was interrupted between
 * the transfer and the bookkeeping: it is marked `failed` with the automatic attempts exhausted, so only an operator who
 * has checked the chain retries it.
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
/** last_error of a row that was `paying` when the node restarted (needs an operator to confirm on chain before a retry). */
export const PAYOUT_INTERRUPTED = 'node restarted during the transfer — confirm on chain whether it went through before retrying';

export interface PayoutRun { attempted: number; paid: number; failed: number }

type LogFn = (level: EventRow['level'], kind: string, message: string, patchId?: string | null, data?: unknown) => void;

export class Payouts {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<PayoutRun> | null = null;
  private again = false;
  /** Rows the operator asked to retry now (attempted on the next pass even when the interval / max attempts say otherwise). */
  private forced = new Set<number>();
  /** Rows whose transfer promise is pending in this process (belt and braces on top of the SQL claim). */
  private inFlight = new Set<number>();
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
    // One row per PERSON, not per spelling (item 309): historical settle records can carry the same address twice —
    // once as typed on a contributor claim, once checksummed as an ancestor author — and `findPayout` matches
    // case-insensitively, so the second spelling used to find the first row and be silently dropped. Fold first.
    const owed = new Map<string, { address: string; amount: number }>();
    for (const [address, amount] of Object.entries(settlement.royalty ?? {})) {
      const lower = address.toLowerCase();
      if (lower === self || !(Number(amount) > 0)) continue;
      const cur = owed.get(lower);
      if (cur) cur.amount += Number(amount); else owed.set(lower, { address, amount: Number(amount) });
    }
    for (const { address, amount: owedAmount } of owed.values()) {
      const amount = String(Math.round(owedAmount * 1e6) / 1e6);
      const existing = this.store.findPayout(settleHash, address);
      if (existing) { rows.push(existing); continue; }
      const row = this.store.insertPayout({ patch_id: settlement.patch_id, settle_hash: settleHash, address, amount: String(amount), currency: settlement.currency });
      this.log('info', 'payout', `owe ${row.amount} ${row.currency} to ${address.slice(0, 10)}… for ${settlement.patch_id} (payout #${row.id} pending)`, settlement.patch_id, { payout_id: row.id, address, amount: row.amount, settle_hash: settleHash });
      rows.push(row);
    }
    return rows;
  }

  /**
   * One transfer attempt for row `id`. Re-reads the row and claims it atomically (pending|failed → paying); a row that is
   * paid, already paying, or gone is returned untouched and NO transfer is made. Ends `paid` (tx_hash) or `failed` (last_error).
   */
  private async attempt(id: number): Promise<PayoutRow | null> {
    const before = this.store.getPayout(id);
    if (!before) return null;
    if (before.status === 'paid' || before.status === 'paying' || this.inFlight.has(id)) return before;
    if (!this.store.claimPayout(id)) return this.store.getPayout(id);
    this.inFlight.add(id);
    const row = this.store.getPayout(id)!;          // attempts already incremented by the claim
    const attempts = row.attempts;
    try {
      if (!this.wallet) return this.store.updatePayout(id, { status: 'failed', last_error: 'no chain wallet on this node' });
      try {
        const r = await this.wallet.transfer(row.address, Number(row.amount));
        const next = this.store.updatePayout(id, { status: 'paid', tx_hash: r.tx_hash, last_error: null });
        this.log('info', 'payout', `paid ${row.amount} ${row.currency} royalty to ${row.address.slice(0, 10)}… (${r.tx_hash.slice(0, 12)}, attempt ${attempts})`, row.patch_id, { payout_id: id, tx_hash: r.tx_hash, attempts });
        return next;
      } catch (e) {
        const msg = ((e as Error).message ?? String(e)).slice(0, 500);
        const next = this.store.updatePayout(id, { status: 'failed', last_error: msg });
        const final = attempts >= this.maxAttempts;
        this.log('warn', 'payout', `royalty transfer to ${row.address.slice(0, 10)}… failed (attempt ${attempts}/${this.maxAttempts}${final ? ', giving up — retry from the Payouts tab' : ''}): ${msg}`, row.patch_id, { payout_id: id, attempts, error: msg });
        return next;
      }
    } finally { this.inFlight.delete(id); }
  }

  /** Rows the timer should (re)try now: never attempted, or failed < max attempts and older than the retry interval. In-flight (`paying`) rows are never due. */
  due(now = Date.now()): PayoutRow[] {
    return this.store.listPayouts({ status: ['pending', 'failed'], limit: 500 })
      .filter((r) => r.status === 'pending' || (r.attempts < this.maxAttempts && now - r.updated_at >= this.retryMs && r.last_error !== PAYOUT_INTERRUPTED))
      .sort((a, b) => a.id - b.id);
  }

  /** Pay everything that is due (plus operator-forced rows), one transfer at a time — the single serialised runner; a call during a run schedules one more pass. */
  processPending(): Promise<PayoutRun> {
    if (this.running) { this.again = true; return this.running; }
    this.running = (async () => {
      await undefined;   // let the assignment above land before a synchronous empty pass reaches `finally`
      const out: PayoutRun = { attempted: 0, paid: 0, failed: 0 };
      try {
        do {
          this.again = false;
          const forced = [...this.forced]; this.forced.clear();
          const ids = [...new Set([...forced, ...this.due().map((r) => r.id)])];
          for (const id of ids) {
            if (this.store.isClosed) return out;
            const r = await this.attempt(id);
            if (!r) continue;
            out.attempted++;
            if (r.status === 'paid') out.paid++; else if (r.status === 'failed') out.failed++;
          }
        } while (this.again || this.forced.size);
      } finally { this.running = null; }
      return out;
    })();
    return this.running;
  }

  /** Operator retry: one immediate attempt through the serialised runner, allowed even after the automatic attempts are exhausted. */
  async retry(id: number): Promise<PayoutRow> {
    const row = this.store.getPayout(id);
    if (!row) throw new PayoutError(404, `payout ${id} not found`);
    if (row.status === 'paid') throw new PayoutError(409, `payout ${id} is already paid (${row.tx_hash})`);
    // `paying` = a transfer is in flight right now: do not queue a second one, just wait for the running pass and report the outcome
    if (row.status !== 'paying' && !this.inFlight.has(id)) this.forced.add(id);
    await this.processPending();
    return this.store.getPayout(id)!;
  }

  summary() { return this.store.payoutSummary(); }

  /** Rows left `paying` by a crash between the transfer and the bookkeeping: unknown outcome → operator confirmation, never an automatic retry. */
  recoverInterrupted(): PayoutRow[] {
    const out: PayoutRow[] = [];
    for (const r of this.store.listPayouts({ status: 'paying', limit: 5000 })) {
      if (this.inFlight.has(r.id)) continue;
      const next = this.store.updatePayout(r.id, { status: 'failed', attempts: Math.max(r.attempts, this.maxAttempts), last_error: PAYOUT_INTERRUPTED });
      this.log('warn', 'payout', `payout #${r.id} (${r.amount} ${r.currency} to ${r.address.slice(0, 10)}…) was mid-transfer when the node stopped — marked failed; confirm on chain, then retry from the Payouts tab`, r.patch_id, { payout_id: r.id, attempts: next.attempts });
      out.push(next);
    }
    return out;
  }

  /** 60-s retry timer (spec §9.3); also runs once shortly after start to pick up rows left `pending` by a crash. */
  start() {
    if (this.timer) return;
    this.recoverInterrupted();
    this.timer = setInterval(() => { this.processPending().catch(() => undefined); }, this.retryMs);
    this.timer.unref?.();
    setTimeout(() => { this.processPending().catch(() => undefined); }, Math.min(this.retryMs, 3000)).unref?.();
  }
  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
}

export class PayoutError extends Error { constructor(readonly status: number, message: string) { super(message); } }
