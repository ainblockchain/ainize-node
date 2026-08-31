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
  /** First real-verification failure time per patch (runtime hiccups / serving restarts). After RUNTIME_GRACE_MS we fall back to hash-only. */
  private runtimeFailures = new Map<string, number>();
  static readonly RUNTIME_GRACE_MS = 15 * 60_000;
  private graceLeft(id: string): number { const t = this.runtimeFailures.get(id); return t ? Math.max(0, Verifier.RUNTIME_GRACE_MS - (Date.now() - t)) : Verifier.RUNTIME_GRACE_MS; }
  private noteFailure(id: string) { if (!this.runtimeFailures.has(id)) this.runtimeFailures.set(id, Date.now()); }
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
      const st = await this.market.runtime.status();
      for (const e of catalog) {
        if (e.anchor.author === me && !cfg.verifier?.allowSelfAttest) continue;
        const mine = e.attestations.find((a) => a.verifier === me);
        const compatible = st.available && !!st.model && e.anchor.model.id_M.startsWith(st.model) && !!e.anchor.benchmark.samples?.length;
        if (mine) {
          // Upgrade: we attested hash-only earlier but a compatible runtime is available now → re-verify for real.
          if (mine.verified_on === 'hash-only' && compatible && ['LISTED', 'VERIFYING', 'ANNOUNCED'].includes(e.status) && !this.runtimeFailures.has(`upgraded:${e.anchor.id}`)) {
            this.runtimeFailures.set(`upgraded:${e.anchor.id}`, 1);
            await this.verifyOne(e.anchor).catch((err) => this.market.log('warn', 'verifier', `re-verify ${e.anchor.id} failed: ${(err as Error).message}`, e.anchor.id));
          }
          continue;
        }
        if (!['ANNOUNCED', 'VERIFYING', 'CHALLENGED'].includes(e.status)) continue;
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
    const wantsRuntime = !!m.runtime.repo && anchor.model.id_M !== 'demo-ngram-1b' && !!anchor.benchmark.samples?.length;
    const graceLeft = this.graceLeft(anchor.id);
    if (blob.sha256 !== anchor.patch_sha256) {
      score = { integrity: 'sha256 mismatch' };
    } else if (runtimeCompatible && anchor.benchmark.samples?.length && m.runtime.repo) {
      try {
        const out = await m.runtime.verify(blob.path, anchor.benchmark, { restore: !m.isApplied(anchor.id) });
        passed = out.passed; score = out.score; verified_on = out.verified_on; restarts = out.restarts_detected; collateral = out.collateral_nat;
        this.runtimeFailures.delete(anchor.id);
        m.log('info', 'verifier', `benchmark ${anchor.id}: ${out.score.free_generation} restarts=${restarts}`, anchor.id, { log: out.log, details: out.details, pre_apply: out.pre_apply });
      } catch (err) {
        this.noteFailure(anchor.id);
        if (this.graceLeft(anchor.id) > 0) throw new Error(`${(err as Error).message} (retrying for ${Math.round(this.graceLeft(anchor.id) / 60000)} more min before hash-only fallback)`);
        passed = blob.rows === anchor.rows;
        score = { integrity: 'sha256 ok', rows: blob.rows, benchmark: `not executed (runtime kept failing: ${(err as Error).message.slice(0, 80)})` };
        verified_on = 'hash-only';
      }
    } else if (wantsRuntime && !runtimeCompatible && graceLeft > 0) {
      // This node is supposed to have a compatible runtime (e.g. serving restart in progress) — wait before attesting hash-only.
      this.noteFailure(anchor.id);
      throw new Error(`runtime unavailable (${st.error ?? 'no model'}) — waiting up to ${Math.round(graceLeft / 60000)} min before hash-only fallback`);
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
