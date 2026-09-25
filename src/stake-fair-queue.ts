/**
 * Dividing one serialised model between callers in proportion to what they deposited.
 *
 * The model behind this node runs one request at a time (`Runtime.serial`, a cross-process lease), so a deposit
 * cannot buy a rate. It buys a share of a queue. That distinction decides the mechanism: a per-caller rate limit
 * would oversubscribe the node whenever many callers are active and waste it whenever few are, because the limit
 * has to be chosen before anyone knows who will show up.
 *
 * Weighted fair queueing chooses nothing in advance. Each waiter gets a virtual finish time
 *
 *     start  = max(virtualTime, lastVirtualFinish[address])
 *     finish = start + cost / weight(address)
 *
 * and the queue serves the lowest. Over a contended period, throughput converges on the weight ratio — a 2:1
 * stake gets 2:1 of the model — and the node hands out exactly the capacity it has, never a number it promised
 * in advance. Oversubscription is not prevented here; it is unrepresentable.
 *
 * Three details carry more weight than they look:
 *
 *   • **`virtualTime` is not the wall clock.** This is the mistake that looks harmless and silently deletes the
 *     whole mechanism. Virtual time has to advance with the work actually done — it is set to the finish tag of
 *     whatever was served last. Clamped against real time instead, it advances as fast as the SLOWEST caller's
 *     virtual clock, so every round resets everybody to the same point and the served ratio comes out 1:1 no
 *     matter what anyone deposited. The weights are still there in the arithmetic; they just stop mattering.
 *
 *   • **The `max(virtualTime, …)` clamp.** Without it, an address that went quiet accumulates credit and would
 *     starve everyone else on its return. With it, a returning address starts from the present of the queue.
 *     When the queue drains, virtual time jumps to the last finish tag issued, so a returning address and a
 *     brand-new one start exactly level.
 *
 *   • **Idleness needs no bookkeeping.** An address that is not asking has no entry in the queue and therefore no
 *     claim on it. "Share among active stakers" is not a rule implemented anywhere in this file — there is no
 *     active set, no sliding window and no denominator to recompute. It is what the discipline already does, and
 *     that is the reason to use it rather than a proportional divider over a tracked active set.
 *
 * `weightFloor` is what a caller with no deposit gets. It must not be zero: zero weight is an infinite finish
 * time, which is permanent starvation rather than "last in line". A floor means the free tier runs when the node
 * is otherwise idle, which is what a free tier should be.
 */

export interface StakeFairEntry {
  /** Runtime priority class (`RUNTIME_PRIORITY`). Ordering across classes is never touched by stake. */
  priority: number;
  /** Arrival order within a class, for tie-breaking. */
  seq: number;
  /** The depositing address this request is attributed to. */
  address: string;
  /** Estimated work, in whatever unit this queue's modality uses. Only ratios matter, never the absolute size. */
  cost: number;
}

export interface StakeFairQueueOptions {
  /** This address's deposited share, as a weight. Zero is legal and means "no deposit"; it gets the floor. */
  weightOf: (address: string) => number;
  /** The weight a caller with no deposit gets. Small, never zero. */
  weightFloor: number;
  now: () => number;
}

export class StakeFairQueue {
  /** Where each address's virtual clock has reached. */
  private readonly lastVirtualFinish = new Map<string, number>();
  /** When each address was last seen, in real time — used only by `forgetIdle`, never by a scheduling decision. */
  private readonly lastSeenAt = new Map<string, number>();
  /** Per-entry finish times. Weak, so an entry dropped without being served cannot leak. */
  private readonly virtualFinish = new WeakMap<StakeFairEntry, number>();
  /** The queue's own clock: the finish tag of whatever was served last. Never the wall clock — see the note above. */
  private virtualTime = 0;
  /** The largest finish tag ever issued, so a drained queue can level everybody. */
  private maxFinishIssued = 0;

  constructor(private readonly opts: StakeFairQueueOptions) {}

  /** Record a waiter and return its virtual finish time. Called once per request, before it starts waiting. */
  admit(entry: StakeFairEntry): number {
    const weight = Math.max(this.opts.weightOf(entry.address), this.opts.weightFloor);
    const start = Math.max(this.virtualTime, this.lastVirtualFinish.get(entry.address) ?? 0);
    const finish = start + entry.cost / weight;
    this.lastVirtualFinish.set(entry.address, finish);
    this.lastSeenAt.set(entry.address, this.opts.now());
    this.virtualFinish.set(entry, finish);
    if (finish > this.maxFinishIssued) this.maxFinishIssued = finish;
    return finish;
  }

  /**
   * The waiter to run next: lowest priority class first, then lowest virtual finish time, then arrival order.
   *
   * An entry that was never admitted sorts last rather than first. Treating an unknown finish time as zero would
   * let a request that skipped `admit` jump the whole queue, which is the one bug in this file that would be
   * worth exploiting.
   */
  take<T extends StakeFairEntry>(entries: T[]): T | null {
    if (entries.length === 0) {
      // The queue has drained. Standard SFQ: virtual time jumps to the last finish tag issued, so whoever asks
      // next starts level with everyone else rather than inheriting a position from the busy period before.
      this.virtualTime = this.maxFinishIssued;
      return null;
    }
    let best: T | null = null;
    let bestFinish = Infinity;
    for (const entry of entries) {
      const finish = this.virtualFinish.get(entry) ?? Infinity;
      if (!best) { best = entry; bestFinish = finish; continue; }
      if (entry.priority !== best.priority) {
        if (entry.priority < best.priority) { best = entry; bestFinish = finish; }
        continue;
      }
      if (finish < bestFinish || (finish === bestFinish && entry.seq < best.seq)) {
        best = entry; bestFinish = finish;
      }
    }
    // Serving this waiter is what moves the queue's clock forward. An unadmitted entry leaves it alone rather
    // than dragging it to infinity.
    if (Number.isFinite(bestFinish)) this.virtualTime = bestFinish;
    return best;
  }

  /**
   * This address's weight as a fraction of every address the queue currently remembers.
   *
   * Reported to callers so the number they pay for is observable. It is a snapshot of who has been asking
   * recently, not of who has deposited: an address that has not been seen since the last `forgetIdle` is not in
   * it, which is the same population the queue itself divides between.
   */
  activeShareOf(address: string): number {
    const mine = Math.max(this.opts.weightOf(address), this.opts.weightFloor);
    let total = 0;
    for (const seen of this.lastVirtualFinish.keys()) total += Math.max(this.opts.weightOf(seen), this.opts.weightFloor);
    if (!this.lastVirtualFinish.has(address)) total += mine;
    return total === 0 ? 0 : mine / total;
  }

  /**
   * Drop addresses whose virtual clock is further behind than `idleMs`.
   *
   * Purely about memory: the `max(now, …)` clamp already means a long-idle address is treated exactly like a new
   * one, so forgetting changes no decision. Without it, a public node accumulates a map entry per address that
   * ever called, for as long as it runs.
   */
  forgetIdle(idleMs: number): number {
    const cutoff = this.opts.now() - idleMs;
    let dropped = 0;
    for (const [address, seenAt] of this.lastSeenAt) {
      if (seenAt < cutoff) {
        this.lastSeenAt.delete(address);
        this.lastVirtualFinish.delete(address);
        dropped++;
      }
    }
    return dropped;
  }

  /** How many addresses the queue currently remembers — for diagnostics and for the sweep's own logging. */
  get trackedAddresses(): number {
    return this.lastVirtualFinish.size;
  }
}
