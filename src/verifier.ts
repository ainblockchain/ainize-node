/**
 * Verifier role (검증기 120 / 청구항 2, 19): watches announced patches, fetches bodies from peers,
 * checks sha256 against the anchor, runs the benchmark on the serving runtime when available
 * (restart-aware, restores rows afterwards) and publishes an attestation with stake.
 * Without a runtime the attestation is explicitly `verified_on: "hash-only"` — never a fake score.
 */
import type { Attestation, PatchAnchor } from '@ngram/core';
import { signMessage } from '@ngram/core';
import type { Market } from './market.js';

export class Verifier {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  constructor(private readonly market: Market, private readonly intervalMs: number) {}

  start() {
    if (this.timer) return;
    const tick = () => { this.round().catch((e) => this.market.log('warn', 'verifier', `round failed: ${(e as Error).message}`)); };
    this.timer = setInterval(tick, this.intervalMs);
    this.timer.unref?.();
    setTimeout(tick, 1500).unref?.();
  }
  private stopped = false;
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopped = true;
    for (let i = 0; i < 600 && this.busy; i++) await new Promise((r) => setTimeout(r, 50));
  }

  async round(): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      const cfg = this.market.cfg;
      const me = cfg.identity.address;
      const catalog = await this.market.catalog();
      for (const e of catalog) {
        if (!['ANNOUNCED', 'VERIFYING', 'CHALLENGED'].includes(e.status)) continue;
        if (e.attestations.some((a) => a.verifier === me)) continue;
        if (e.anchor.author === me && !cfg.verifier?.allowSelfAttest) continue;
        await this.verifyOne(e.anchor).catch((err) => this.market.log('warn', 'verifier', `verify ${e.anchor.id} failed: ${(err as Error).message}`, e.anchor.id));
      }
    } finally {
      this.busy = false;
    }
  }

  async verifyOne(anchor: PatchAnchor): Promise<Attestation> {
    const m = this.market;
    m.log('info', 'verifier', `verifying ${anchor.id} (${anchor.name})`, anchor.id);
    const blob = await m.ensureBlob(anchor);
    const st = await m.runtime.status();
    let passed = false;
    let score: Record<string, string | number> = {};
    let verified_on = 'hash-only';
    let restarts = 0;
    let collateral: number | undefined;
    const runtimeCompatible = st.available && !!st.model && anchor.model.id_M.startsWith(st.model);
    if (blob.sha256 !== anchor.patch_sha256) {
      score = { integrity: 'sha256 mismatch' };
    } else if (runtimeCompatible && anchor.benchmark.samples?.length && m.runtime.repo) {
      const out = await m.runtime.verify(blob.path, anchor.benchmark, { restore: !m.isApplied(anchor.id) });
      passed = out.passed; score = out.score; verified_on = out.verified_on; restarts = out.restarts_detected; collateral = out.collateral_nat;
      m.log('info', 'verifier', `benchmark ${anchor.id}: ${out.score.free_generation} restarts=${restarts}`, anchor.id, { log: out.log, details: out.details.slice(0, 20) });
    } else {
      // No compatible runtime here: attest integrity only (sha256 + row count), clearly labelled.
      passed = blob.rows === anchor.rows;
      score = { integrity: 'sha256 ok', rows: blob.rows, benchmark: 'not executed (no compatible runtime on this node)' };
      verified_on = 'hash-only';
    }
    const body: Omit<Attestation, 'sig'> = {
      patch_id: anchor.id, verifier: m.cfg.identity.address, verifier_name: m.cfg.name, patch_sha256: blob.sha256,
      benchmark_hash: anchor.benchmark_hash, score, passed, collateral_nat: collateral, verified_on, restarts_detected: restarts,
      stake: m.cfg.verifier?.stake ?? '0', created_at: Date.now(),
    };
    const sig = signMessage(JSON.stringify([body.patch_id, body.patch_sha256, body.benchmark_hash, body.passed, body.score]), m.cfg.identity.privateKey);
    const att: Attestation = { ...body, sig };
    await m.attest(att);
    return att;
  }
}
