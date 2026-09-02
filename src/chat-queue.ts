/**
 * D3 — the wait behind the shared model, made visible.
 *
 * One serving model is shared by every live test on this machine (and by the e2e suite and the demo cluster),
 * serialised through a cross-process lock. A request that arrives while someone else holds the lock is QUEUED,
 * not failed — but nothing used to say so, so a visitor watching the transcript saw a request that simply never
 * came back ("안나오네"). This registry gives every live test a ticket the client can ask about:
 *
 *   queued  → still behind the lock. Nothing has been sent to the model, so cancelling is free.
 *   running → the lock is ours and the model is generating. Cancelling stops the browser, not the node.
 *   gone    → finished, failed, or never existed.
 *
 * Tickets are per-visitor: only the visitor who opened one can read or cancel it.
 */

export type ChatTicketState = 'queued' | 'running';

export interface ChatTicket {
  id: string;
  visitor: string;
  label: string;
  /** When the request reached the node. */
  at: number;
  /** When it took the shared lock (null while queued). */
  started_at: number | null;
  state: ChatTicketState;
  cancelled: boolean;
}

export interface ChatTicketStatus {
  state: ChatTicketState | 'gone';
  /** Milliseconds spent waiting behind the lock (frozen once running). */
  queued_ms: number;
  /** Milliseconds spent generating (0 while queued). */
  running_ms: number;
  /** 1 = next in line; 0 once running. */
  position: number;
  cancelled: boolean;
}

/** Tickets are dropped this long after they end — long enough for the client's last poll to see the result. */
const KEEP_MS = 60_000;
const MAX_TICKETS = 500;

export class ChatQueue {
  private tickets = new Map<string, ChatTicket>();
  private done = new Map<string, number>();

  /** Register a request the moment it arrives, BEFORE it starts waiting for the lock. */
  open(id: string, visitor: string, label: string): ChatTicket {
    this.sweep();
    const t: ChatTicket = { id, visitor, label, at: Date.now(), started_at: null, state: 'queued', cancelled: false };
    this.tickets.set(id, t);
    return t;
  }

  /** The lock is ours — flip to running. Returns false when the visitor gave up while queued (do no work). */
  enter(id: string): boolean {
    const t = this.tickets.get(id);
    if (!t) return true;
    if (t.cancelled) return false;
    t.state = 'running';
    t.started_at = Date.now();
    return true;
  }

  close(id: string): void {
    if (!this.tickets.delete(id)) return;
    this.done.set(id, Date.now());
  }

  get(id: string, visitor?: string): ChatTicket | null {
    const t = this.tickets.get(id);
    if (!t) return null;
    if (visitor !== undefined && t.visitor !== visitor) return null;
    return t;
  }

  /** How this request is doing. An unknown or foreign id is reported as 'gone' — never as someone else's state. */
  status(id: string, visitor?: string): ChatTicketStatus {
    const t = this.get(id, visitor);
    const now = Date.now();
    if (!t) return { state: 'gone', queued_ms: 0, running_ms: 0, position: 0, cancelled: false };
    return {
      state: t.state,
      queued_ms: (t.started_at ?? now) - t.at,
      running_ms: t.started_at ? now - t.started_at : 0,
      position: t.state === 'queued' ? this.position(t) : 0,
      cancelled: t.cancelled,
    };
  }

  /** Place in the queue among this node's own waiting requests (1 = next). Requests on other nodes are invisible. */
  private position(t: ChatTicket): number {
    let ahead = 0;
    for (const o of this.tickets.values()) if (o.state === 'queued' && !o.cancelled && o.at < t.at) ahead++;
    return ahead + 1;
  }

  /**
   * Give up waiting. While queued this is genuinely free — the runner returns without touching the model, so the
   * caller must not consume a free try. Once running the node is already inside the lock; the work (and the
   * charge) stands, and the caller is told so rather than being left to guess.
   */
  cancel(id: string, visitor?: string): { cancelled: boolean; reason: 'queued' | 'already_running' | 'gone'; charged: boolean } {
    const t = this.get(id, visitor);
    if (!t) return { cancelled: false, reason: 'gone', charged: false };
    if (t.state === 'running') return { cancelled: false, reason: 'already_running', charged: true };
    t.cancelled = true;
    return { cancelled: true, reason: 'queued', charged: false };
  }

  /** Requests of this node waiting for the shared model right now (for the picker banner). */
  waiting(): number {
    let n = 0;
    for (const t of this.tickets.values()) if (t.state === 'queued' && !t.cancelled) n++;
    return n;
  }

  private sweep(): void {
    const cut = Date.now() - KEEP_MS;
    for (const [id, at] of this.done) if (at < cut) this.done.delete(id);
    if (this.tickets.size <= MAX_TICKETS) return;
    // defensive: a ticket whose runner died would otherwise hold a queue position for ever
    for (const [id, t] of this.tickets) if (Date.now() - t.at > 30 * 60_000) this.tickets.delete(id);
  }
}

/** A live test the visitor gave up on while it was still queued — no model call was made, nothing is charged. */
export class ChatCancelledError extends Error {
  readonly status = 499;
  constructor() { super('live test cancelled while it was still queued — the model was never called, so no free try was used'); this.name = 'ChatCancelledError'; }
}
