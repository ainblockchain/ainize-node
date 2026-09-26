/**
 * A concurrency slot for a backend that is NOT the shared language model.
 *
 * Transcription and image generation run on their own GPUs. Putting them behind `Runtime`'s one-at-a-time lease
 * would serialise three things that have no reason to wait for each other — a person transcribing a voice note
 * would queue behind somebody's two-thousand-token completion on a different card. So each modality gets its own
 * gate, sized by the backend's declared `concurrency`.
 *
 * Ordering inside a gate is by the same stake-weighted fair queue the model uses, for the same reason: a deposit
 * buys a share of whatever is scarce, and on these backends what is scarce is the slots. Queues stay separate per
 * modality, so a large deposit cannot let one caller crowd out image requests with audio ones.
 */
import { StakeFairQueue, type StakeFairEntry } from './stake-fair-queue.js';
import { RUNTIME_PRIORITY } from './runtime.js';

interface GateWaiter extends StakeFairEntry {
  start: () => void;
  /** Kept so a gate that closes can fail what is queued instead of leaving the promise unsettled forever. */
  abandon: (error: Error) => void;
}

/** Raised when a caller gave up, or the gate was closed, before a slot came free. */
export class ModalityGateClosedError extends Error {
  readonly status = 503;
  constructor(modality: string) {
    super(`the ${modality} backend stopped accepting work before this request started`);
    this.name = 'ModalityGateClosedError';
  }
}

export class ModalityGate {
  private waiters: GateWaiter[] = [];
  private running = 0;
  private seq = 0;
  private closed = false;

  constructor(
    private readonly modality: string,
    private readonly concurrency: number,
    private readonly scheduler?: StakeFairQueue,
  ) {}

  /** Total estimated work waiting, in this modality's cost unit — what a wait bound is computed from. */
  queuedCost(): number {
    let total = 0;
    for (const waiter of this.waiters) total += waiter.cost;
    return total;
  }

  get waiting(): number { return this.waiters.length + this.running; }

  /**
   * `priority` is the `RUNTIME_PRIORITY` class, exactly as on the shared model — the queue was already sorted by it
   * (`StakeFairQueue.take` compares the class before any stake) and every waiter was pinned to 0, so a paid caller
   * and a signed-out visitor were indistinguishable here. Omitted still means `serving`.
   */
  async run<T>(fn: () => Promise<T>, opts: { address: string; cost: number; priority?: number }): Promise<T> {
    if (this.closed) throw new ModalityGateClosedError(this.modality);
    return new Promise<T>((resolve, reject) => {
      const waiter: GateWaiter = {
        priority: opts.priority ?? RUNTIME_PRIORITY.serving, seq: ++this.seq, address: opts.address, cost: opts.cost,
        start: () => {
          this.running++;
          void fn().then(resolve, reject).finally(() => { this.running--; this.pump(); });
        },
        abandon: reject,
      };
      this.waiters.push(waiter);
      this.scheduler?.admit(waiter);
      this.pump();
    });
  }

  private pump(): void {
    while (!this.closed && this.running < this.concurrency && this.waiters.length) {
      // Without a scheduler — every node that sells no throughput — the class is the only ordering there is, so it
      // has to be applied here. `take()` already compares it before any stake, and taking `waiters[0]` instead
      // silently ignored it: on those nodes a paid call and a visitor's press were served in arrival order.
      const next = this.scheduler?.take(this.waiters) ?? ModalityGate.firstByClass(this.waiters);
      this.waiters.splice(this.waiters.indexOf(next), 1);
      next.start();
    }
  }

  /** Lowest priority class first, arrival order inside a class — the same rule the shared model's queue uses. */
  private static firstByClass(waiters: GateWaiter[]): GateWaiter {
    let best = waiters[0];
    for (const w of waiters) if (w.priority < best.priority || (w.priority === best.priority && w.seq < best.seq)) best = w;
    return best;
  }

  /** Stop accepting work and fail whatever is still queued, so a shutdown does not leave callers hanging. */
  close(): void {
    this.closed = true;
    const pending = this.waiters;
    this.waiters = [];
    for (const waiter of pending) waiter.abandon(new ModalityGateClosedError(this.modality));
    if (pending.length) {
      console.error(`[${this.modality}] ${pending.length} queued request(s) refused at shutdown`);
    }
  }
}
