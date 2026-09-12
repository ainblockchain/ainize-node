/**
 * Reclaiming disk (item 128). A verifier downloads every announced body over P2P and keeps it forever: two nodes on
 * the demo cluster held 932 MB each, and the only thing the product would let an operator delete was one id at a
 * time through `patch forget`. Nothing reported the bytes either — the first symptom was ENOSPC, which takes the
 * SQLite store and the ledger with it.
 *
 * What may be deleted is narrow on purpose. A body is a candidate only when this node did not author it, has not
 * bought it, is not serving it, and is not the last place it exists: every candidate is announced knowledge whose
 * body any holder can serve again, so deleting it costs a re-fetch and nothing else.
 */
import { existsSync, statSync } from 'node:fs';
import type { CatalogEntry } from '@ainize/core';
import type { Market } from './market.js';

export type { GcCandidate } from '@ainize/core';
import type { GcCandidate } from '@ainize/core';

export interface GcPlan {
  candidates: GcCandidate[];
  bytes: number;
  /** Bodies looked at and kept, by the reason they were kept. */
  kept: { authored: number; purchased: number; applied: number; draft: number; unlisted: number; too_new: number; sole_copy: number; relayed: number };
}

export interface GcOptions {
  /** Keep bodies bought through the market even when they are not applied (default true — they cost money). */
  keepPurchased?: boolean;
  /** Only bodies imported longer ago than this (ms). */
  olderThanMs?: number;
  /** Delete a body even when no peer advertises it. Off by default: this node may be the last copy. */
  allowSoleCopy?: boolean;
}

/** The plan `ainize gc` would carry out. Pure: it reads, it never deletes. */
export async function gcPlan(market: Market, opts: GcOptions = {}): Promise<GcPlan> {
  const keepPurchased = opts.keepPurchased !== false;
  const now = Date.now();
  const kept: GcPlan['kept'] = { authored: 0, purchased: 0, applied: 0, draft: 0, unlisted: 0, too_new: 0, sole_copy: 0, relayed: 0 };
  const catalog = await market.catalogAll();
  const bySha = new Map<string, CatalogEntry[]>();
  for (const e of catalog) {
    const list = bySha.get(e.anchor.patch_sha256) ?? [];
    list.push(e);
    bySha.set(e.anchor.patch_sha256, list);
  }
  // A draft's body is unpublished work: it exists nowhere else, ever.
  const draftShas = new Set(market.store.listDrafts().map((d) => d.anchor.patch_sha256).filter(Boolean) as string[]);
  const datasetDir = market.datasets.dir;
  const candidates: GcCandidate[] = [];
  for (const b of market.blobs.list()) {
    // only bodies this node actually copied into its own blob directory: an imported file that lives in the
    // operator's own results folder is theirs, not ours to delete
    if (!b.path.startsWith(market.blobs.dir) || b.path.startsWith(datasetDir)) continue;
    if (market.blobs.isRelayed(b.sha256)) { kept.relayed++; continue; }
    if (draftShas.has(b.sha256)) { kept.draft++; continue; }
    const entries = bySha.get(b.sha256) ?? [];
    if (!entries.length) { kept.unlisted++; continue; }                       // nothing on the record points at it
    if (entries.some((e) => e.anchor.author === market.address)) { kept.authored++; continue; }
    if (entries.some((e) => e.status === 'DRAFT')) { kept.draft++; continue; }
    if (entries.some((e) => market.isApplied(e.anchor.id))) { kept.applied++; continue; }
    if (keepPurchased && entries.some((e) => market.store.getPurchase(e.anchor.id))) { kept.purchased++; continue; }
    if (opts.olderThanMs && now - b.imported_at < opts.olderThanMs) { kept.too_new++; continue; }
    const holders = market.p2p ? market.p2p.holders(b.sha256).length : 0;
    if (!holders && !opts.allowSoleCopy) { kept.sole_copy++; continue; }
    const e = entries[0];
    let bytes = b.size_bytes;
    try { bytes = statSync(b.path).size; } catch { /* the row's own number is the fallback */ }
    candidates.push({ patch_id: e.anchor.id, sha256: b.sha256, name: e.anchor.name, status: e.status, bytes, path: b.path, reason: 'verification', imported_at: b.imported_at, holders });
  }
  candidates.sort((a, b) => b.bytes - a.bytes);
  return { candidates, bytes: candidates.reduce((n, x) => n + x.bytes, 0), kept };
}

export interface GcResult extends GcPlan { removed: GcCandidate[]; freed: number; dry_run: boolean }

/** Carry out a plan. `dryRun` returns exactly what a real run would remove, having removed nothing. */
export async function gcRun(market: Market, opts: GcOptions & { dryRun?: boolean } = {}): Promise<GcResult> {
  const plan = await gcPlan(market, opts);
  if (opts.dryRun) return { ...plan, removed: [], freed: 0, dry_run: true };
  const removed: GcCandidate[] = [];
  let freed = 0;
  for (const cand of plan.candidates) {
    try {
      if (market.blobs.isRelayed(cand.sha256)) continue;
      market.blobs.remove(cand.sha256);
      if (!existsSync(cand.path)) { removed.push(cand); freed += cand.bytes; }
    } catch { /* a body that will not delete is reported by omission, never as freed bytes */ }
  }
  if (removed.length) {
    market.log('info', 'node', `gc removed ${removed.length} verification cop${removed.length === 1 ? 'y' : 'ies'} (${freed} bytes) — every one is re-fetchable from a peer that holds it`);
  }
  return { ...plan, removed, freed, dry_run: false };
}
