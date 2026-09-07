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
import { payoutKeyFor, type Settlement } from '@ainize/core';
import type { EventRow, PayoutRow, Store } from './store.js';

/**
 * What the payout loop needs from the chain wallet (`AinLedger` satisfies it; tests pass a fake).
 *
 * `key` (item 314) is the deterministic `/transfer/$seller/$to/$key` slot derived from the settle hash, so the
 * transfer can be found and joined to the sale it honoured. `transferMany` (item 366) pays every creator of one
 * sale in ONE transaction: three ancestors used to mean three writes and three lots of gas around a price the
 * product's own estimate says barely covers one.
 */
export interface PayoutWallet {
  transfer(to: string, value: number, key?: string): Promise<{ tx_hash: string }>;
  transferMany?(items: { to: string; value: number; key: string }[]): Promise<{ tx_hash: string }>;
}

/** Called after a transfer lands, to put the payout on the shared record (item 314). Failure never unpays a row. */
export type PayoutRecorder = (row: PayoutRow, txHash: string, transferKey: string) => Promise<void>;

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

  /** Appends the `payout` record once the money has moved (item 314); set by the Market that owns the ledger. */
  public record: PayoutRecorder | null = null;

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
    const rows = await this.attemptGroup([id]);
    return rows[0] ?? null;
  }

  /**
   * One transfer attempt for every row in `ids` — all of them from the SAME settlement, paid in one transaction
   * when the wallet can (item 366) and one at a time when it cannot.
   *
   * Every row is claimed atomically first (pending|failed → paying); a row that is paid, already paying or gone is
   * dropped from the batch and NO transfer is made for it, so the double-payment guard is unchanged by batching.
   * The transfer carries the key derived from the settle hash, and a `payout` record follows it onto the shared
   * ledger, so the ancestor can join promise to money without asking the seller (item 314).
   */
  private async attemptGroup(ids: number[]): Promise<PayoutRow[]> {
    const claimed: PayoutRow[] = [];
    const out: PayoutRow[] = [];
    for (const id of ids) {
      const before = this.store.getPayout(id);
      if (!before) continue;
      if (before.status === 'paid' || before.status === 'paying' || this.inFlight.has(id)) { out.push(before); continue; }
      if (!this.store.claimPayout(id)) { const r = this.store.getPayout(id); if (r) out.push(r); continue; }
      this.inFlight.add(id);
      claimed.push(this.store.getPayout(id)!);      // attempts already incremented by the claim
    }
    if (!claimed.length) return out;
    try {
      if (!this.wallet) {
        for (const row of claimed) out.push(this.store.updatePayout(row.id, { status: 'failed', last_error: 'no chain wallet on this node' }));
        return out;
      }
      const items = claimed.map((row) => ({ to: row.address, value: Number(row.amount), key: payoutKeyFor(row.settle_hash, row.address) }));
      const batched = claimed.length > 1 && typeof this.wallet.transferMany === 'function';
      const paid = async (i: number, txHash: string) => {
        const row = claimed[i];
        const next = this.store.updatePayout(row.id, { status: 'paid', tx_hash: txHash, last_error: null, transfer_key: items[i].key });
        this.log('info', 'payout', `paid ${row.amount} ${row.currency} royalty to ${row.address.slice(0, 10)}… (tx ${txHash.slice(0, 12)}, key ${items[i].key}, attempt ${row.attempts}${batched ? `, one transaction for all ${claimed.length} creators of this sale` : ''})`, row.patch_id, { payout_id: row.id, tx_hash: txHash, transfer_key: items[i].key, attempts: row.attempts, batched });
        out.push(await this.putOnRecord(next, txHash, items[i].key));
      };
      const failed = (i: number, e: unknown) => {
        const row = claimed[i];
        const msg = ((e as Error).message ?? String(e)).slice(0, 500);
        const next = this.store.updatePayout(row.id, { status: 'failed', last_error: msg });
        const final = row.attempts >= this.maxAttempts;
        this.log('warn', 'payout', `royalty transfer to ${row.address.slice(0, 10)}… failed (attempt ${row.attempts}/${this.maxAttempts}${final ? ', giving up — retry from the Payouts tab' : ''}): ${msg}`, row.patch_id, { payout_id: row.id, attempts: row.attempts, error: msg });
        out.push(next);
      };
      if (batched) {
        // All or nothing: one transaction, so either every creator of this sale is paid or none is.
        try {
          const r = await this.wallet.transferMany!(items);
          for (let i = 0; i < claimed.length; i++) await paid(i, r.tx_hash);
        } catch (e) { for (let i = 0; i < claimed.length; i++) failed(i, e); }
      } else {
        // A wallet with no batch support (and every single-row pass) transfers one at a time, as before.
        for (let i = 0; i < claimed.length; i++) {
          try { const r = await this.wallet.transfer(items[i].to, items[i].value, items[i].key); await paid(i, r.tx_hash); }
          catch (e) { failed(i, e); }
        }
      }
      return out;
    } finally { for (const row of claimed) this.inFlight.delete(row.id); }
  }

  /**
   * Put a paid transfer on the shared ledger (item 314). The money has already moved, so a failure here is logged
   * and left for the next pass to retry — it never re-opens a paid row, which would risk paying twice.
   */
  private async putOnRecord(row: PayoutRow, txHash: string, key: string): Promise<PayoutRow> {
    if (!this.record || row.recorded) return row;
    try {
      await this.record(row, txHash, key);
      return this.store.updatePayout(row.id, { recorded: true });
    } catch (e) {
      this.log('warn', 'payout', `paid ${row.amount} ${row.currency} to ${row.address.slice(0, 10)}… but could not write the public payout record for it: ${(e as Error).message} — the transfer stands (tx ${txHash.slice(0, 12)}, key ${key}); the record is retried`, row.patch_id, { payout_id: row.id, tx_hash: txHash });
      return row;
    }
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
          // Item 366: the creators of ONE sale are paid in one transaction, so a family of three costs one write
          // instead of three. Rows are grouped by settle hash and the order within the pass is unchanged.
          const groups = new Map<string, number[]>();
          for (const id of ids) {
            const row = this.store.getPayout(id);
            if (!row) continue;
            groups.set(row.settle_hash, [...(groups.get(row.settle_hash) ?? []), id]);
          }
          for (const group of groups.values()) {
            if (this.store.isClosed) return out;
            for (const r of await this.attemptGroup(group)) {
              out.attempted++;
              if (r.status === 'paid') out.paid++; else if (r.status === 'failed') out.failed++;
            }
          }
        } while (this.again || this.forced.size);
      } finally { this.running = null; }
      return out;
    })();
    return this.running;
  }

  /** How often the person owed the money may ask for one more attempt (item 306). */
  static readonly NUDGE_COOLDOWN_MS = 10 * 60_000;
  private nudged = new Map<number, number>();

  /**
   * The payee asks the node to try again (item 306).
   *
   * After 20 failed attempts, or a restart mid-transfer, a row is `failed` and the teacher's page says "transfer
   * failed — still owed by 0x…". The only retry was operator-only, no visitor-callable nudge existed, and nothing
   * badged the operator beyond one warn line in an event feed — so real money owed to a visitor depended on an
   * operator happening to scroll past it. This is the same serialised attempt the operator's retry uses, callable by
   * the address that is owed, at most once every NUDGE_COOLDOWN_MS, and it writes an event naming them.
   */
  async nudge(id: number, byAddress: string): Promise<{ payout: PayoutRow; retried: boolean; retry_after_ms?: number }> {
    const row = this.store.getPayout(id);
    if (!row) throw new PayoutError(404, `payout ${id} not found`);
    if (row.address.toLowerCase() !== byAddress.toLowerCase()) throw new PayoutError(403, 'this payout is owed to a different address');
    if (row.status === 'paid') throw new PayoutError(409, `this payout was already sent (${row.tx_hash})`);
    const last = this.nudged.get(id) ?? 0;
    const since = Date.now() - last;
    if (last && since < Payouts.NUDGE_COOLDOWN_MS) return { payout: row, retried: false, retry_after_ms: Payouts.NUDGE_COOLDOWN_MS - since };
    this.nudged.set(id, Date.now());
    this.log('warn', 'payout', `${row.address.slice(0, 10)}… asked this node to retry the ${row.amount} ${row.currency} it is owed for ${row.patch_id} (payout #${id}, ${row.attempts} attempt(s) so far${row.last_error ? `, last error: ${row.last_error.slice(0, 160)}` : ''})`, row.patch_id, { payout_id: id, address: row.address, attempts: row.attempts, nudged_by: byAddress });
    return { payout: await this.retry(id), retried: true };
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
