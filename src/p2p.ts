/**
 * Peer-to-peer layer: peer discovery (static seeds + peer exchange), ledger record gossip
 * (local-ledger mode: set reconciliation by `received_at` cursor + push on new record),
 * blob availability and authenticated blob fetch.
 */
import { createWriteStream, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { signMessage, verifyMessage, type LedgerRecord, type PeerInfo, type Identity, type Ledger } from '@ngram/core';
import type { Store } from './store.js';

export interface P2PDeps {
  identity: Identity;
  ledger: Ledger;
  store: Store;
  selfInfo: () => Promise<PeerInfo>;
  log: (level: 'debug' | 'info' | 'warn' | 'error', kind: string, message: string, data?: unknown) => void;
}

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

export class P2P {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  constructor(private readonly deps: P2PDeps, seeds: string[], private readonly intervalMs: number, private readonly selfEndpoint: string) {
    for (const s of seeds) if (s && this.normalize(s) !== this.normalize(selfEndpoint)) deps.store.upsertPeer(this.normalize(s));
  }

  normalize(ep: string): string { return ep.replace(/\/+$/, ''); }

  peers() { return this.deps.store.listPeers().filter((p) => this.normalize(p.endpoint) !== this.normalize(this.selfEndpoint)); }

  addPeer(endpoint: string) { this.deps.store.upsertPeer(this.normalize(endpoint)); }
  removePeer(endpoint: string) { this.deps.store.deletePeer(this.normalize(endpoint)); }

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
          // 1) hello / info exchange
          const info = await this.fetchJson<PeerInfo>(`${peer.endpoint}/p2p/hello`, { method: 'POST', body: JSON.stringify(self) });
          this.deps.store.upsertPeer(peer.endpoint, { address: info.address, info, last_seen: Date.now(), failures: 0 });
          // 2) peer exchange
          const known = await this.fetchJson<{ peers: string[] }>(`${peer.endpoint}/p2p/peers`);
          for (const ep of known.peers ?? []) {
            const n = this.normalize(ep);
            if (n !== this.normalize(this.selfEndpoint) && !this.deps.store.getPeer(n)) this.deps.store.upsertPeer(n);
          }
          // 3) record sync (local ledger only; AIN ledger reads the chain directly)
          if (this.deps.ledger.kind === 'local') {
            const cursor = this.deps.store.getPeer(peer.endpoint)?.cursor ?? 0;
            const res = await this.fetchJson<{ records: LedgerRecord[]; cursor: number }>(`${peer.endpoint}/p2p/records?since=${cursor}&limit=500`, {}, 20000);
            let added = 0;
            for (const rec of res.records ?? []) {
              try { if (await this.deps.ledger.ingest(rec)) added++; } catch (e) { this.deps.log('warn', 'p2p', `rejected record ${rec.hash.slice(0, 12)} from ${peer.endpoint}: ${(e as Error).message}`); }
            }
            this.deps.store.upsertPeer(peer.endpoint, { cursor: res.cursor ?? cursor });
            if (added) this.deps.log('info', 'p2p', `synced ${added} record(s) from ${info.name} (${peer.endpoint})`);
          }
        } catch {
          const cur = this.deps.store.getPeer(peer.endpoint);
          this.deps.store.upsertPeer(peer.endpoint, { failures: (cur?.failures ?? 0) + 1 });
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** Push a freshly appended record to all peers (best effort). */
  async broadcast(record: LedgerRecord): Promise<void> {
    await Promise.allSettled(this.peers().map((p) =>
      this.fetchJson(`${p.endpoint}/p2p/records`, { method: 'POST', body: JSON.stringify({ records: [record] }) }, 5000)));
  }

  /** Peers advertising a blob (from their last info). */
  holders(sha: string): string[] {
    return this.peers().filter((p) => p.info?.blobs?.includes(sha)).map((p) => p.endpoint);
  }

  /** Fetch a blob from a peer with identity auth (verifier/author/purchaser rights are checked by the peer). */
  async fetchBlob(sha: string, dest: string, endpoints = this.holders(sha), token?: string): Promise<string> {
    let lastErr: Error | null = null;
    for (const ep of endpoints) {
      try {
        const url = `${ep}/p2p/blob/${sha}${token ? `?token=${encodeURIComponent(token)}` : ''}`;
        const r = await fetch(url, { headers: { 'x-ngram-auth': authHeader(this.deps.identity, `blob:${sha}`) }, signal: AbortSignal.timeout(10 * 60_000) });
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
