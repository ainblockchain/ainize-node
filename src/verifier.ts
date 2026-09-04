/**
 * Verifier role (검증기 120 / 청구항 2, 19): watches announced patches, fetches bodies from peers,
 * checks sha256 against the anchor, runs the benchmark on the serving runtime when available
 * (restart-aware, restores rows afterwards) and publishes a signed attestation.
 * The attestation carries no deposit: it is backed by the verifier's node signature on a permanent public record,
 * and nothing is escrowed or slashed anywhere in this product (item 127).
 * Without a runtime the attestation is explicitly `verified_on: "hash-only"` — never a fake score.
 */
import type { Attestation, PatchAnchor, RuntimeStatus } from '@ngram/core';
import { ATTESTATION_GOT_MAX, ATTESTATION_MAX_FAILURES, ATTESTATION_PROMPT_MAX, canonicalJson, sha256Hex, signMessage } from '@ngram/core';
import { ConflictError, type Market } from './market.js';

export class Verifier {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  /** First real-verification failure time per patch (runtime hiccups / serving restarts). After RUNTIME_GRACE_MS we fall back to hash-only. */
  private runtimeFailures = new Map<string, number>();
  static readonly RUNTIME_GRACE_MS = 15 * 60_000;
  /** Samples measured for an anchor with a base stack (§7.7 raises the cap from 40 so parent questions fit). */
  static readonly LINEAGE_SAMPLE_CAP = 64;
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
      const catalog = await this.market.catalogAll();   // verify test-visibility anchors too
      const st = await this.market.runtime.status();
      for (const e of catalog) {
        if (e.anchor.author === me && !cfg.verifier?.allowSelfAttest) continue;
        const mine = e.attestations.find((a) => a.verifier === me);
        const compatible = st.available && !!st.model && e.anchor.model.id_M.startsWith(st.model) && !!e.anchor.benchmark.samples?.length;
        // A run on a table that already carries this knowledge has no un-patched baseline: it would be recorded and
        // never counted (item 329), so it is not worth a GPU minute. Say so once, quietly, and move on.
        if (compatible && this.market.isApplied(e.anchor.id)) {
          if (!this.runtimeFailures.has(`applied:${e.anchor.id}`)) {
            this.runtimeFailures.set(`applied:${e.anchor.id}`, 1);
            this.market.log('info', 'verifier', `not verifying ${e.anchor.id}: this node keeps it applied to the shared model, so a run here would have no un-patched baseline to compare against (unload it, or let a node that does not serve it verify)`, e.anchor.id);
          }
          continue;
        }
        // A challenge is an open question addressed to the verifiers: re-run it even when this node has already
        // attested, otherwise a 3-node network where everyone has attested can never answer one (item 153) — and
        // whatever the status is, because an item stuck at 1/2 with one FAIL is exactly the case the publisher
        // files a challenge for and the only status it can have is VERIFYING (item 242).
        if (e.open_challenge && (!mine || mine.created_at < e.open_challenge.created_at)) {
          await this.verifyOne(e.anchor).catch((err) => this.market.log('warn', 'verifier', `re-verify (challenged) ${e.anchor.id} failed: ${(err as Error).message}`, e.anchor.id));
          continue;
        }
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

  /**
   * Verify one anchor and write the attestation. Refuses BEFORE spending GPU minutes when the result could not
   * count: a self-attestation (item 146), or a re-run whose record the derivation would discard (item 153).
   */
  async verifyOne(anchor: PatchAnchor): Promise<Attestation> {
    const m = this.market;
    const me = m.cfg.identity.address;
    if (anchor.author.toLowerCase() === me.toLowerCase() && !m.cfg.verifier?.allowSelfAttest) {
      throw new ConflictError(`cannot verify your own knowledge: ${anchor.id} was published by this node (verifier.allowSelfAttest is false). A self-check never counts toward the quorum — another node has to verify it.`);
    }
    const e = await m.entry(anchor.id);
    const mine = e?.attestations.find((a) => a.verifier === me);
    const challengedAt = e?.open_challenge?.created_at ?? 0;
    if (mine && mine.created_at >= challengedAt) {
      // The one case where re-running its own verification still changes something: this node attested hash-only
      // and now has a model server that can actually execute the benchmark.
      const st = await m.runtime.status();
      const canUpgrade = mine.verified_on === 'hash-only' && st.available && !!st.model && anchor.model.id_M.startsWith(st.model) && !!anchor.benchmark.samples?.length;
      if (!canUpgrade) {
        throw new ConflictError(`this node already attested ${anchor.id} (${mine.passed ? 'PASS' : 'FAIL'}, ${mine.verified_on}, ${new Date(mine.created_at).toISOString()}); a second attestation would not be counted. Re-verification counts after someone challenges the knowledge (ainize patch challenge ${anchor.id} --reason …)${mine.verified_on === 'hash-only' ? ', or once this node has a model server that can run the benchmark (it has none that matches now)' : ''}.`);
      }
    }
    // A verification measured on a table that ALREADY has this knowledge applied compares the patched model with
    // itself: there is no baseline, `pre_apply` is empty and the score means nothing (item 329). Refuse before the
    // GPU minutes rather than write a record the derivation will not count.
    if (anchor.benchmark.samples?.length && m.isApplied(anchor.id)) {
      const st0 = await m.runtime.status();
      if (st0.available && !!st0.model && anchor.model.id_M.startsWith(st0.model)) {
        throw new ConflictError(`${anchor.id} is applied to the shared model on this node, so a benchmark run here has no un-patched baseline of its own and would not count toward the quorum. Unload it first (ainize patch remove ${anchor.id}), or let a node that does not serve it verify.`);
      }
    }
    m.log('info', 'verifier', `verifying ${anchor.id} (${anchor.name})`, anchor.id);
    const blob = await m.ensureBlob(anchor);
    const st = await m.runtime.status();
    let passed = false;
    let score: Record<string, string | number> = {};
    let verified_on = 'hash-only';
    let restarts = 0;
    let collateral: number | undefined;
    let failures: NonNullable<Attestation['failures']> = [];
    const runtimeCompatible = st.available && !!st.model && anchor.model.id_M.startsWith(st.model);
    const wantsRuntime = !!m.runtime.repo && anchor.model.id_M !== 'demo-ngram-1b' && !!anchor.benchmark.samples?.length;
    const graceLeft = this.graceLeft(anchor.id);
    if (blob.sha256 !== anchor.patch_sha256) {
      score = { integrity: 'sha256 mismatch' };
    } else if (runtimeCompatible && anchor.benchmark.samples?.length && m.runtime.repo) {
      try {
        // §7.7 — a knowledge trained on top of others is verified WITH them underneath, and scored per source: it must
        // answer its own questions AND not break the ones it inherited. Without every parent body here the score would
        // be measured on the wrong table, so this node says so instead of attesting a number it cannot stand behind.
        const stack = anchor.base?.stack ?? [];
        const below: { id: string; path: string; sha256: string }[] = [];
        for (const b of stack) {
          const bb = m.blobs.get(b.patch_sha256);
          if (!bb) throw new Error(`this node does not hold ${b.patch_id}, which has to be loaded underneath — verify it on a node that pins the base`);
          below.push({ id: b.patch_id, path: bb.path, sha256: bb.sha256 });
        }
        // Items 241/258 — the benchmark runs with NOTHING on the table but this anchor's own declared bases, and the
        // node's stack goes back afterwards. Running it on top of whatever this node serves measured the wrong model
        // (yesterday's bake under today's candidate → pre_apply 3/4 → an undeserved FAIL) and the restore then wrote
        // the candidate's `before` over rows a subscription owned.
        const out = await m.verifyIsolated(anchor, blob.path, {
          below,
          journal: m.runtime.journalPath(blob.sha256) ?? undefined,
          delta: anchor.base?.export === 'delta',
          ...(stack.length ? { maxSamples: Verifier.LINEAGE_SAMPLE_CAP } : {}),
        });
        passed = out.passed; score = out.score; verified_on = out.verified_on; restarts = out.restarts_detected; collateral = out.collateral_nat;
        failures = out.details.filter((d) => !d.hit).slice(0, ATTESTATION_MAX_FAILURES)
          .map((d) => ({ prompt: String(d.prompt ?? '').slice(0, ATTESTATION_PROMPT_MAX), expect: String(d.expect ?? '').slice(0, ATTESTATION_GOT_MAX), got: String(d.got ?? '').slice(0, ATTESTATION_GOT_MAX) }));
        this.runtimeFailures.delete(anchor.id);
        m.log('info', 'verifier', `benchmark ${anchor.id}: ${out.score.free_generation}${out.score.per_source ? ` (${out.score.per_source})` : ''} restarts=${restarts}`, anchor.id, { log: out.log, details: out.details, pre_apply: out.pre_apply, per_source: out.per_source, stack: out.stack });
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
      created_at: Date.now(),
    };
    // What the model actually answered on the questions it got wrong (item 155). The verifier saw this and threw it
    // away: the author's node used to receive "0/2" and nothing else, on an anchor that is permanent and an id that
    // is burned. It travels signed, so the author can act on evidence rather than on a fraction.
    if (failures.length) body.failures = failures;
    // Which model server ran it, so "2/2 independent" can tell two processes on one vLLM apart (item 329).
    if (verified_on !== 'hash-only') {
      body.executor = await this.executorFingerprint(st);
      body.baseline = true;
    }
    const sig = signMessage(JSON.stringify([body.patch_id, body.patch_sha256, body.benchmark_hash, body.passed, body.score, body.failures ?? [], body.executor?.instance ?? '']), m.cfg.identity.privateKey);
    const att: Attestation = { ...body, sig };
    await m.attest(att);
    return att;
  }

  /**
   * A fingerprint of the model server this attestation was measured on (item 329). Two verifier processes pointed at
   * ONE vLLM produce the SAME `instance`, so the catalog can say "2 attestations, 1 model server" instead of
   * presenting them as two independent verifications. The engine's own start time (`created` on /v1/models, which
   * vLLM sets when the server boots) is what separates two servers that both answer on `localhost:8002`; without it
   * the fingerprint falls back to origin + model, which can only ever UNDER-state independence, never overstate it.
   */
  private async executorFingerprint(st: RuntimeStatus): Promise<NonNullable<Attestation['executor']>> {
    const api = st.api ? st.api.replace(/\/+$/, '') : null;
    let started: number | undefined;
    if (api && st.model) {
      try {
        const r = await fetch(`${api}/v1/models`, { signal: AbortSignal.timeout(3000) });
        if (r.ok) {
          const j = (await r.json()) as { data?: { id: string; created?: number }[] };
          const d = j.data?.find((x) => x.id === st.model) ?? j.data?.[0];
          if (typeof d?.created === 'number' && d.created > 0) started = d.created;
        }
      } catch { /* the engine answered the benchmark but not this: fall back to origin + model */ }
    }
    const origin = api ? (() => { try { return new URL(api).origin; } catch { return api; } })() : null;
    const instance = sha256Hex(canonicalJson({ origin, model: st.model ?? null, started: started ?? null })).slice(0, 16);
    return { api, model: st.model ?? null, ...(started ? { engine_started: started } : {}), instance };
  }
}
