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

  async run<T>(fn: () => Promise<T>, opts: { address: string; cost: number }): Promise<T> {
    if (this.closed) throw new ModalityGateClosedError(this.modality);
    return new Promise<T>((resolve, reject) => {
      const waiter: GateWaiter = {
        priority: 0, seq: ++this.seq, address: opts.address, cost: opts.cost,
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
      const next = this.scheduler?.take(this.waiters) ?? this.waiters[0];
      this.waiters.splice(this.waiters.indexOf(next), 1);
      next.start();
    }
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
