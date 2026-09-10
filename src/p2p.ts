/**
 * Peer-to-peer layer: peer discovery (static seeds + peer exchange), ledger record gossip
 * (local-ledger mode: set reconciliation by `received_at` cursor + push on new record),
 * blob availability and authenticated blob fetch.
 */
import { createWriteStream, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { signMessage, verifyMessage, type LedgerRecord, type PeerInfo, type Identity, type Ledger, isRecordRefusal } from '@ainize/core';
import type { Store } from './store.js';

export interface P2PDeps {
  identity: Identity;
  ledger: Ledger;
  store: Store;
  selfInfo: () => Promise<PeerInfo>;
  log: (level: 'debug' | 'info' | 'warn' | 'error', kind: string, message: string, data?: unknown) => void;
}

/**
 * What this node will accept from the gossip network (config `p2p`, items 136/137).
 *
 * Peer exchange used to add every endpoint any peer advertised, with no cap, no record of where it came from and no
 * way to refuse — a node whose config.json listed one peer ended up talking to two unrelated private clusters on the
 * same host because a shared peer advertised them.
 */
export interface P2POptions {
  /** Accept endpoints peers advertise at all (default true). false = talk only to what the operator configured. */
  acceptExchange?: boolean;
  /** Ceiling on the peer table. Past it, the least recently seen LEARNED peer is dropped; configured peers never are. */
  maxPeers?: number;
  /** Drop a LEARNED peer after this many consecutive failed rounds (0 = never). */
  evictAfterFailures?: number;
  /** Drop a LEARNED peer this many days after it was last seen (0 = never). */
  staleDays?: number;
}

export const P2P_DEFAULTS: Required<P2POptions> = { acceptExchange: true, maxPeers: 50, evictAfterFailures: 60, staleDays: 7 };

export function authHeader(identity: Identity, purpose: string): string {
  const ts = Date.now();
  const sig = signMessage(`${purpose}:${ts}`, identity.privateKey);
  return `${identity.address}:${ts}:${sig}`;
}

export function verifyAuthHeader(header: string | undefined, purpose: string, maxSkewMs = 5 * 60_000): string | null {
  if (!header) return null;
  const [address, tsStr, sig] = header.split(':');
  const ts = Number(tsStr);
  if (!address || !sig || !Number.isFinite(ts) || Math.abs(Date.now() - ts) > maxSkewMs) return null;
  return verifyMessage(`${purpose}:${ts}`, sig, address) ? address : null;
}

/**
 * What this node actually knows about its peers, as opposed to "peers: 3" (item 170). `reachable` is peers whose
 * last gossip round succeeded; `verifiers` is how many of THOSE advertise the verifier role — the fact an operator
 * needs before believing "verifiers will now attest"; `mismatched` is the peers publishing on a different ledger,
 * whose knowledge can never appear in this node's catalogue however green every other indicator looks.
 */
export interface PeerHealth {
  known: number;
  reachable: number;
  unreachable: number;
  verifiers: number;
  ledger_mismatch: number;
  ledger: 'local' | 'ain';
  mismatched: { endpoint: string; name: string | null; ledger: string }[];
}

export class P2P {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  /** Endpoints already told about (once per ledger value) so the mismatch warning is not repeated every 4 s. */
  private readonly warnedLedger = new Map<string, string>();
  private readonly opts: Required<P2POptions>;
  constructor(private readonly deps: P2PDeps, seeds: string[], private readonly intervalMs: number, private readonly selfEndpoint: string, opts: P2POptions = {}) {
    this.opts = { ...P2P_DEFAULTS, ...opts };
    // A configured seed always wins over a block: config.json IS the operator saying they want this peer.
    const configured = new Set<string>();
    for (const s of seeds) {
      if (!s || this.normalize(s) === this.normalize(selfEndpoint)) continue;
      configured.add(this.normalize(s));
      this.addPeer(s);
    }
    // Rows written before `source` existed all read 'configured' (the column default). config.json's `peers` list is
    // the exact answer — `peers add` writes it too — so anything not in it is re-labelled once, here (item 136).
    for (const p of deps.store.listPeers()) {
      if (p.source === 'configured' && !configured.has(this.normalize(p.endpoint))) deps.store.upsertPeer(p.endpoint, { source: 'learned' });
    }
  }

  normalize(ep: string): string { return ep.replace(/\/+$/, ''); }

  peers() { return this.deps.store.listPeers().filter((p) => this.normalize(p.endpoint) !== this.normalize(this.selfEndpoint)); }

  /** Configured by the operator (config.json `peers`, `peers add`, `init --peer`): un-blocked, and never evicted. */
  addPeer(endpoint: string): { unblocked: boolean } {
    const ep = this.normalize(endpoint);
    const unblocked = this.deps.store.unblockPeer(ep);
    this.deps.store.upsertPeer(ep, { source: 'configured' });
    if (unblocked) this.deps.log('info', 'p2p', `${ep} was blocked from re-discovery and has been re-admitted by the operator`, { endpoint: ep });
    return { unblocked };
  }

  /**
   * Remove a peer AND keep it out (item 137). Without the block the next gossip round put it back — any third node
   * that still listed the endpoint taught it to this one four seconds later, so there was no way to detach at all.
   */
  removePeer(endpoint: string, opts: { block?: boolean } = {}): { removed: boolean; blocked: boolean } {
    const ep = this.normalize(endpoint);
    const removed = this.deps.store.deletePeer(ep);
    // Only a peer that was actually there is blocked: a mistyped endpoint must leave no trace at all, or the
    // operator ends up with an invisible block list built from typos (item 138).
    const blocked = removed && opts.block !== false;
    if (blocked) this.deps.store.blockPeer(ep, 'removed by the operator');
    return { removed, blocked };
  }

  /** Endpoints gossip is not allowed to re-add, newest first. */
  blocked() { return this.deps.store.listBlockedPeers(); }

  start() {
    if (this.timer) return;
    const tick = () => { this.round().catch((e) => this.deps.log('warn', 'p2p', `round failed: ${(e as Error).message}`)); };
    this.timer = setInterval(tick, this.intervalMs);
    this.timer.unref?.();
    setTimeout(tick, 500).unref?.();
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopped = true;
    for (let i = 0; i < 100 && this.running; i++) await new Promise((r) => setTimeout(r, 50));
  }
  private stopped = false;

  /**
   * What actually went wrong, in words an operator can act on. Node's fetch says `fetch failed` and hides
   * ECONNREFUSED / ENOTFOUND / the TLS error in `cause`, and that bare string was the entire diagnosis a dead peer
   * ever produced (item 138).
   */
  static reason(e: unknown): string {
    const err = e as Error & { cause?: { code?: string; message?: string; errors?: { code?: string; message?: string }[] } };
    const cause = err?.cause;
    const inner = cause?.code ?? cause?.errors?.find((x) => x?.code)?.code ?? cause?.message ?? cause?.errors?.[0]?.message;
    const msg = err?.message || String(e);
    return inner && !msg.includes(String(inner)) ? `${msg} (${inner})` : msg;
  }

  private async fetchJson<T>(url: string, init: RequestInit = {}, timeoutMs = 8000): Promise<T> {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs), headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });
    if (!r.ok) throw new Error(`${url} -> ${r.status}`);
    return (await r.json()) as T;
  }

  async round(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      const self = await this.deps.selfInfo();
      for (const peer of this.peers()) {
        try {
          // 1) hello / info exchange. The hello is SIGNED for this node's own endpoint (item 326): the body claims an
          // address and a set of roles, and `verifier` in that list used to be enough to download every paid body on
          // the peer for free. An unsigned hello still registers the endpoint on the other side; only the claim needs
          // the signature.
          const info = await this.fetchJson<PeerInfo>(`${peer.endpoint}/p2p/hello`, {
            method: 'POST', body: JSON.stringify(self),
            headers: { 'x-ainize-auth': authHeader(this.deps.identity, `hello:${this.normalize(self.endpoint ?? this.selfEndpoint)}`) },
          });
          if (peer.failures > 0) {
            // One line on recovery, to close the one written when it went away (item 138).
            this.deps.log('info', 'p2p', `${info.name ?? peer.endpoint} (${peer.endpoint}) is answering again after ${peer.failures} failed round(s)`, { endpoint: peer.endpoint, failures: peer.failures });
          }
          this.deps.store.upsertPeer(peer.endpoint, { address: info.address, info, last_seen: Date.now(), failures: 0, last_error: null, last_attempt: Date.now() });
          // Two nodes on one identity (item 139): whichever registered last owns the address in every registry, so
          // the loser silently disappears and buyers are routed to an endpoint that may not hold the body.
          this.noteAddressCollision(peer.endpoint, info);
          // A peer on the OTHER ledger answers hello, peer-exchange and blob requests perfectly — and serves an empty
          // record set forever, so its knowledge never reaches this catalogue. Nothing used to say so (item 170).
          if (info.ledger && info.ledger !== this.deps.ledger.kind && this.warnedLedger.get(peer.endpoint) !== info.ledger) {
            this.warnedLedger.set(peer.endpoint, info.ledger);
            this.deps.log('warn', 'p2p', `${info.name} (${peer.endpoint}) publishes on the ${info.ledger === 'ain' ? 'AIN' : 'local'} ledger; this node reads the ${this.deps.ledger.kind === 'ain' ? 'AIN chain' : 'local record DAG'}, so its knowledge will never appear here — re-init with \`ainize init --force --ledger ${info.ledger}${info.ledger === 'ain' ? ' --ain-provider <url>' : ''}\`, or trade with it directly (--node ${peer.endpoint})`, { endpoint: peer.endpoint, peer_ledger: info.ledger, own_ledger: this.deps.ledger.kind });
          }
          if (info.ledger === this.deps.ledger.kind) this.warnedLedger.delete(peer.endpoint);
          // 2) peer exchange. Every endpoint learned here is MARKED as learned and said out loud once: the operator
          // could not answer "who is my node talking to?" from the config, and was shown other people's endpoints
          // under a heading that claimed they had configured them (item 136). A removed peer stays removed (item 137),
          // the table has a ceiling, and `p2p.acceptExchange false` turns discovery off altogether.
          if (this.opts.acceptExchange) {
            const known = await this.fetchJson<{ peers: string[] }>(`${peer.endpoint}/p2p/peers`);
            for (const ep of known.peers ?? []) {
              const n = this.normalize(ep);
              if (n === this.normalize(this.selfEndpoint) || this.deps.store.getPeer(n)) continue;
              if (this.deps.store.isPeerBlocked(n)) continue;
              if (this.opts.maxPeers > 0 && this.peers().length >= this.opts.maxPeers && !this.evictOne()) {
                this.deps.log('warn', 'p2p', `not learning ${n} from ${info.name ?? peer.endpoint}: this node is already talking to ${this.opts.maxPeers} peers (p2p.maxPeers) and every one of them is configured`, { endpoint: n, from: peer.endpoint });
                break;
              }
              if (this.deps.store.upsertPeer(n, { source: 'learned', learned_from: peer.endpoint })) {
                this.deps.log('info', 'p2p', `learned peer ${n} from ${info.name ?? peer.endpoint} (${peer.endpoint}) — it is not in this node's config; \`ainize peers rm ${n}\` removes it and keeps it out`, { endpoint: n, from: peer.endpoint });
              }
            }
          }
          // 3) record sync (local ledger only; AIN ledger reads the chain directly)
          if (this.deps.ledger.kind === 'local') {
            const cursor = this.deps.store.getPeer(peer.endpoint)?.cursor ?? 0;
            const res = await this.fetchJson<{ records: LedgerRecord[]; cursor: number }>(`${peer.endpoint}/p2p/records?since=${cursor}&limit=500`, {}, 20000);
            let added = 0;
            /**
             * The cursor only passes records this node has actually taken (item 374).
             *
             * It used to advance to `res.cursor` whatever happened in the loop, and the loop's `catch` only logged.
             * A record rejected for a transient reason — a busy SQLite, a throw part-way through a write — was
             * therefore never offered by that peer again: the next round asked `?since=<past it>`. It is gone from
             * this node's ledger unless some other peer happens to re-gossip it, and an anchor lost that way takes
             * its attestations and settlements with it, because `deriveCatalog` drops every record whose anchor it
             * cannot find.
             *
             * A record the ledger REFUSES (a bad signature, a rule this node will not accept) is different: it will
             * be refused again for ever, and stopping on it would wedge the sync. So only an unexpected failure
             * holds the cursor, and it holds it at the last record that went in.
             */
            let stopAt: number | null = null;
            for (const rec of res.records ?? []) {
              try { if (await this.deps.ledger.ingest(rec)) added++; }
              catch (e) {
                const why = (e as Error).message;
                this.deps.log('warn', 'p2p', `rejected record ${rec.hash.slice(0, 12)} from ${peer.endpoint}: ${why}`);
                if (!isRecordRefusal(e)) { stopAt = rec.ts ?? null; break; }
              }
            }
            this.deps.store.upsertPeer(peer.endpoint, { cursor: stopAt !== null ? Math.max(cursor, stopAt - 1) : (res.cursor ?? cursor) });
            if (added) this.deps.log('info', 'p2p', `synced ${added} record(s) from ${info.name} (${peer.endpoint})`);
          }
        } catch (e) {
          // A dead peer used to produce nothing at all: no event, no error text, no state — only a counter that grew
          // forever while the node kept dialling it every 4 s (item 138). The reason is now ON the row, and the
          // transition to unreachable is one warn, not one per round.
          const cur = this.deps.store.getPeer(peer.endpoint);
          const failures = (cur?.failures ?? 0) + 1;
          const why = P2P.reason(e);
          this.deps.store.upsertPeer(peer.endpoint, { failures, last_error: why.slice(0, 200), last_attempt: Date.now() });
          if (failures === 1) {
            this.deps.log('warn', 'p2p', `${cur?.info?.name ?? peer.endpoint} did not answer: ${why.slice(0, 160)}${cur?.last_seen ? ` (last seen ${new Date(cur.last_seen).toISOString()})` : ' (never reached since it was added)'}`, { endpoint: peer.endpoint, error: why.slice(0, 200) });
          }
          this.evictIfDead(peer.endpoint);
        }
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * Make room for one more learned peer: drop the least recently seen LEARNED row. Configured peers are never
   * evicted — the operator asked for those, and a node that quietly forgot a configured peer would be worse than a
   * full table. Returns false when there is nothing evictable, and the caller stops learning instead.
   */
  private evictOne(): boolean {
    const learned = this.peers().filter((p) => p.source === 'learned');
    if (!learned.length) return false;
    const victim = learned.reduce((a, b) => (a.last_seen <= b.last_seen ? a : b));
    this.deps.store.deletePeer(victim.endpoint);
    this.deps.log('info', 'p2p', `dropped learned peer ${victim.endpoint} to stay under p2p.maxPeers (${this.opts.maxPeers}) — last seen ${victim.last_seen ? new Date(victim.last_seen).toISOString() : 'never'}`, { endpoint: victim.endpoint });
    return true;
  }

  /**
   * Drop a LEARNED peer that has been failing for `evictAfterFailures` rounds or has not been seen for `staleDays`
   * (item 137: nothing ever pruned, so a long-lived node ended up dialling every endpoint that ever existed).
   * A configured peer keeps its row and its `last_error`: removing it is the operator's decision, not the node's.
   */
  private evictIfDead(endpoint: string): void {
    const p = this.deps.store.getPeer(endpoint);
    if (!p || p.source !== 'learned') return;
    const byFailures = this.opts.evictAfterFailures > 0 && p.failures >= this.opts.evictAfterFailures;
    const byAge = this.opts.staleDays > 0 && p.last_seen > 0 && Date.now() - p.last_seen > this.opts.staleDays * 86_400_000;
    const neverSeen = this.opts.evictAfterFailures > 0 && p.last_seen === 0 && p.failures >= this.opts.evictAfterFailures;
    if (!byFailures && !byAge && !neverSeen) return;
    this.deps.store.deletePeer(endpoint);
    this.deps.log('info', 'p2p', `dropped learned peer ${endpoint}: ${byAge ? `not seen for ${Math.round((Date.now() - p.last_seen) / 86_400_000)} day(s)` : `${p.failures} consecutive failed rounds (${p.last_error ?? 'no reason recorded'})`} — a peer that still lists it can teach it back`, { endpoint, failures: p.failures });
  }

  /**
   * Two nodes presenting ONE address (item 139) — a cloned VM, a backup restored beside the original, a staging copy
   * of a production home. `knownNodes()` is keyed by address, so whichever spoke last owns the entry and the other
   * silently disappears from every peer's registry: downloads and verifications then fail intermittently for a
   * reason no log explains, and both nodes sign attestations and settlements as the same party. Said once per pair.
   */
  private readonly warnedCollision = new Set<string>();
  private noteAddressCollision(endpoint: string, info: PeerInfo): void {
    if (!info.address) return;
    const others = this.deps.store.listPeers().filter((p) => p.address && p.address.toLowerCase() === info.address.toLowerCase() && this.normalize(p.endpoint) !== this.normalize(endpoint));
    for (const other of others) {
      const key = [this.normalize(endpoint), this.normalize(other.endpoint)].sort().join('|');
      if (this.warnedCollision.has(key)) continue;
      this.warnedCollision.add(key);
      const sameInstance = !!info.instance && info.instance === other.info?.instance;
      this.deps.log('warn', 'p2p', sameInstance
        ? `${info.name ?? endpoint} moved: address ${info.address} now answers at ${endpoint} and was at ${other.endpoint} (same node instance) — the old entry will age out`
        : `address ${info.address} is claimed by two endpoints (${endpoint} and ${other.endpoint}): two nodes are running on one identity. Whichever registered last owns the address in every registry, so buyers and verifiers are routed to one of them at random and both sign as the same party. Stop one, or give it its own key (\`ainize keys rotate\`).`,
        { address: info.address, endpoints: [endpoint, other.endpoint], same_instance: sameInstance });
    }
  }

  /** Endpoints holding the same address as another endpoint — the DUPLICATE flag on `ainize nodes` and /network. */
  duplicateAddresses(): Map<string, string[]> {
    const byAddr = new Map<string, string[]>();
    for (const p of this.deps.store.listPeers()) {
      if (!p.address) continue;
      const k = p.address.toLowerCase();
      byAddr.set(k, [...(byAddr.get(k) ?? []), p.endpoint]);
    }
    return new Map([...byAddr].filter(([, eps]) => eps.length > 1));
  }

  /** Push a freshly appended record to all peers (best effort). */
  async broadcast(record: LedgerRecord): Promise<void> {
    await Promise.allSettled(this.peers().map((p) =>
      this.fetchJson(`${p.endpoint}/p2p/records`, { method: 'POST', body: JSON.stringify({ records: [record] }) }, 5000)));
  }

  /**
   * The peer facts every operator surface needs (`ainize status`, `ainize nodes`, `ainize peers ls`, /api/info).
   * "Reachable" is not "configured": a peer counts only when its last round actually succeeded.
   */
  health(): PeerHealth {
    const peers = this.peers();
    const reachable = peers.filter((p) => p.failures === 0 && p.last_seen > 0);
    const mismatched = peers
      .filter((p) => p.info?.ledger && p.info.ledger !== this.deps.ledger.kind)
      .map((p) => ({ endpoint: p.endpoint, name: p.info?.name ?? null, ledger: p.info!.ledger as string }));
    return {
      known: peers.length,
      reachable: reachable.length,
      unreachable: peers.length - reachable.length,
      verifiers: reachable.filter((p) => p.info?.roles?.includes('verifier')).length,
      ledger_mismatch: mismatched.length,
      ledger: this.deps.ledger.kind,
      mismatched,
    };
  }

  /** Peers advertising a blob (from their last info). */
  holders(sha: string): string[] {
    return this.peers().filter((p) => p.info?.blobs?.includes(sha)).map((p) => p.endpoint);
  }
  /** Peers advertising a published training set (`PeerInfo.datasets`, lineage design §6.6). */
  datasetHolders(sha: string): string[] {
    return this.peers().filter((p) => p.info?.datasets?.includes(sha)).map((p) => p.endpoint);
  }

  /**
   * Fetch a published training set from a peer: rows (checked against the sha by the caller), the manifest and the
   * full benchmark list when the peer serves them. Auth as for blobs (`x-ainize-auth` over `dataset:<sha>`); a derive
   * token (from the parent's `derive-intent`) goes in `x-ainize-derive` for `derivative` sets.
   */
  async fetchDataset(sha: string, token?: string, endpoints = this.datasetHolders(sha)): Promise<{ rows: Buffer; manifest: never | null; benchmark: Buffer | null; from: string }> {
    let lastErr: Error | null = null;
    for (const ep of endpoints) {
      try {
        const headers: Record<string, string> = { 'x-ainize-auth': authHeader(this.deps.identity, `dataset:${sha}`), ...(token ? { 'x-ainize-derive': token } : {}) };
        const r = await fetch(`${ep}/p2p/dataset/${sha}`, { headers, signal: AbortSignal.timeout(2 * 60_000) });
        if (!r.ok) throw new Error(`${ep} -> ${r.status}`);
        const rows = Buffer.from(await r.arrayBuffer());
        const mh = { 'x-ainize-auth': authHeader(this.deps.identity, `dataset:${sha}`), ...(token ? { 'x-ainize-derive': token } : {}) };
        const m = await fetch(`${ep}/p2p/dataset/${sha}/manifest`, { headers: mh, signal: AbortSignal.timeout(30_000) }).catch(() => null);
        const manifest = m && m.ok ? ((await m.json()) as never) : null;
        const bh = { 'x-ainize-auth': authHeader(this.deps.identity, `dataset:${sha}`), ...(token ? { 'x-ainize-derive': token } : {}) };
        const b = await fetch(`${ep}/p2p/dataset/${sha}/benchmark`, { headers: bh, signal: AbortSignal.timeout(30_000) }).catch(() => null);
        const benchmark = b && b.ok ? Buffer.from(await b.arrayBuffer()) : null;
        return { rows, manifest, benchmark, from: ep };
      } catch (e) { lastErr = e as Error; }
    }
    throw lastErr ?? new Error(`no peer holds the training set ${sha.slice(0, 12)}`);
  }

  /** Fetch a blob from a peer with identity auth (verifier/author/purchaser rights are checked by the peer). */
  async fetchBlob(sha: string, dest: string, endpoints = this.holders(sha), token?: string): Promise<string> {
    let lastErr: Error | null = null;
    for (const ep of endpoints) {
      try {
        const url = `${ep}/p2p/blob/${sha}${token ? `?token=${encodeURIComponent(token)}` : ''}`;
        const r = await fetch(url, { headers: { 'x-ainize-auth': authHeader(this.deps.identity, `blob:${sha}`) }, signal: AbortSignal.timeout(10 * 60_000) });
        if (!r.ok || !r.body) throw new Error(`${ep} -> ${r.status}`);
        mkdirSync(dirname(dest), { recursive: true });
        const tmp = `${dest}.part`;
        await pipeline(Readable.fromWeb(r.body as never), createWriteStream(tmp));
        renameSync(tmp, dest);
        return ep;
      } catch (e) { lastErr = e as Error; }
    }
    throw lastErr ?? new Error(`no peer holds blob ${sha.slice(0, 12)}`);
  }
}
