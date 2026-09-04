/**
 * Verifier role (검증기 120 / 청구항 2, 19): watches announced patches, fetches bodies from peers,
 * checks sha256 against the anchor, runs the benchmark on the serving runtime when available
 * (restart-aware, restores rows afterwards) and publishes a signed attestation.
 * The attestation carries no deposit: it is backed by the verifier's node signature on a permanent public record,
 * and nothing is escrowed or slashed anywhere in this product (item 127).
 * Without a runtime the attestation is explicitly `verified_on: "hash-only"` — never a fake score.
 */
import type { Attestation, PatchAnchor, RuntimeStatus } from '@ngram/core';
import { ATTESTATION_GOT_MAX, ATTESTATION_MAX_FAILURES, ATTESTATION_PROMPT_MAX, canonicalJson, readNpzMember, sha256Hex, signMessage, verifierConfig } from '@ngram/core';
import { ConflictError, type Market } from './market.js';
import { RUNTIME_PRIORITY } from './runtime.js';

/** What one round did and what it stood aside from (item 332) — the line an operator reads to see why an item waits. */
export interface VerifierRoundReport { verified: number; skipped: { test: number; price: number; budget: number; busy: number; window: number } }

/** What this node has spent verifying other people's knowledge, and what it gave back (items 332 / 333 / 336). */
export interface VerifierWork {
  items_last_hour: number;
  model_minutes_last_hour: number;
  max_items_per_hour: number;
  max_model_minutes_per_hour: number;
  /** Bodies dropped after their attestation was written (item 336), since this process started. */
  released_files: number;
  released_bytes: number;
  retain_bodies: boolean;
  /** Why the next round will not start an item right now; absent when nothing is in the way. */
  paused?: string;
}

/**
 * A verification that is only WAITING for the model server, not one that failed (item 130).
 *
 * While the serving API is down every announced patch throws once per round, and the message embeds the minutes
 * left — so it changes every 60 s and deduplicates against nothing. On the demo nodes that one loop was 25-29 % of
 * every event ever stored, at 13 lines a minute, in the log an operator reads during exactly that incident. The
 * round now recognises this error and reports the NODE's state once per transition instead.
 */
export class RuntimeWaitError extends Error {
  constructor(message: string, readonly detail: string, readonly graceLeftMs: number) { super(message); }
}

/** `14:32` — when the grace period runs out, in the operator's own local time. */
const hhmm = (t: number): string => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

export class Verifier {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  /** First real-verification failure time per patch (runtime hiccups / serving restarts). After RUNTIME_GRACE_MS we fall back to hash-only. */
  private runtimeFailures = new Map<string, number>();
  static readonly RUNTIME_GRACE_MS = 15 * 60_000;
  /** The rolling hour the per-hour budget is spent against (items 332 / 333). */
  private spent: { at: number; ms: number }[] = [];
  /** Bodies dropped after their attestation was written (item 336), since this process started. */
  private released = { files: 0, bytes: 0 };
  private lastRoundLog = 0;
  /** How often the round may repeat its "skipped N (test listings)" line — the round itself runs every `intervalMs`. */
  static readonly ROUND_LOG_MS = 5 * 60_000;
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

  /**
   * Verify one anchor, and decide what the failure is worth in the log (item 130). A patch that is only waiting for
   * the model server produces no line at all here — `reportGrace` says it once for the whole node instead.
   */
  private async attempt(anchor: PatchAnchor, what: string, waiting: { id: string; detail: string; left: number }[]): Promise<void> {
    try { await this.verifyOne(anchor); }
    catch (err) {
      if (err instanceof RuntimeWaitError) { waiting.push({ id: anchor.id, detail: err.detail, left: err.graceLeftMs }); return; }
      this.market.log('warn', 'verifier', `${what} ${anchor.id} failed: ${(err as Error).message}`, anchor.id);
    }
  }

  /** Where this node stands in the grace period, so each transition is logged once and the retries stay silent. */
  private graceStage: 0 | 1 | 2 = 0;

  /**
   * One line per transition instead of thirteen a minute (item 130): entering the grace period, its halfway mark,
   * and recovery. What an operator needs during the incident is the node's state — how many items are waiting and
   * when attestations start falling back to hash-only — not the same sentence per patch per 5-second round.
   */
  private reportGrace(waiting: { id: string; detail: string; left: number }[], runtimeAvailable: boolean): void {
    if (!waiting.length) {
      if (this.graceStage !== 0) {
        this.graceStage = 0;
        // "nothing is waiting" is not "the model is back": the queue also empties when every item ran out of grace
        // and was attested hash-only. Say which of the two happened.
        this.market.log('info', 'verifier', runtimeAvailable
          ? 'the model server is answering again — benchmark verification resumed'
          : 'nothing is waiting on the model server any more — every item in the grace period fell back to hash-only', null);
      }
      return;
    }
    const left = Math.max(...waiting.map((w) => w.left));
    const until = Date.now() + left;
    const ids = waiting.map((w) => w.id);
    const list = `${ids.slice(0, 5).join(', ')}${ids.length > 5 ? `, and ${ids.length - 5} more` : ''}`;
    const n = `${waiting.length} knowledge item${waiting.length === 1 ? '' : 's'}`;
    if (this.graceStage === 0) {
      this.graceStage = 1;
      this.market.log('warn', 'verifier', `model server unreachable (${waiting[0].detail}) — ${n} waiting to be verified (${list}). Attestations fall back to hash-only (sha256 + row count, no benchmark) at ${hhmm(until)} unless it comes back.`, null, { waiting: ids, hash_only_at: until, detail: waiting[0].detail });
      return;
    }
    if (this.graceStage === 1 && left <= Verifier.RUNTIME_GRACE_MS / 2) {
      this.graceStage = 2;
      this.market.log('warn', 'verifier', `model server still unreachable (${waiting[0].detail}) — ${n} waiting; hash-only attestation starts at ${hhmm(until)} (${Math.round(left / 60000)} min)`, null, { waiting: ids, hash_only_at: until, detail: waiting[0].detail });
    }
  }

  async round(): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    const waiting: { id: string; detail: string; left: number }[] = [];
    try {
      const cfg = this.market.cfg;
      const v = verifierConfig(cfg);
      const me = cfg.identity.address;
      const catalog = await this.market.catalogAll();   // test-visibility anchors are in here; `verifier.includeTest` decides
      const st = await this.market.runtime.status();
      const report: VerifierRoundReport = { verified: 0, skipped: { test: 0, price: 0, budget: 0, busy: 0, window: 0 } };
      const minPrice = Number(v.minPrice ?? '0');
      for (const e of catalog) {
        if (e.anchor.author === me && !cfg.verifier?.allowSelfAttest) continue;
        // What this node spends on unpaid work for strangers is the operator's decision, not the catalogue's size
        // (item 332). 209 of the 213 anchors on the demo chain were hidden test listings nobody could ever buy, and
        // each of them cost every verifier a download and a benchmark on every round.
        if (!v.includeTest && e.anchor.visibility === 'test') { report.skipped.test++; continue; }
        if (minPrice > 0 && Number(e.anchor.price || 0) < minPrice) { report.skipped.price++; continue; }
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
          if (this.standAside(v, report)) break;
          report.verified++;
          await this.attempt(e.anchor, 're-verify (challenged)', waiting);
          continue;
        }
        if (mine) {
          // Upgrade: we attested hash-only earlier but a compatible runtime is available now → re-verify for real.
          if (mine.verified_on === 'hash-only' && compatible && ['LISTED', 'VERIFYING', 'ANNOUNCED'].includes(e.status) && !this.runtimeFailures.has(`upgraded:${e.anchor.id}`)) {
            if (this.standAside(v, report)) break;
            this.runtimeFailures.set(`upgraded:${e.anchor.id}`, 1);
            report.verified++;
            await this.attempt(e.anchor, 're-verify', waiting);
          }
          continue;
        }
        if (!['ANNOUNCED', 'VERIFYING', 'CHALLENGED'].includes(e.status)) continue;
        if (this.standAside(v, report)) break;
        report.verified++;
        await this.attempt(e.anchor, 'verify', waiting);
      }
      this.reportGrace(waiting, st.available);
      this.reportRound(report);
    } finally {
      this.busy = false;
    }
  }

  /**
   * Should this round start another item? (items 332 / 333)
   *
   * `true` ends the round: the hourly budget is gone, we are outside the operator's window, or someone is waiting on
   * this node right now — and verification is the one thing here that nobody is paying for. A run that has already
   * started is never pre-empted; what changes is that a new one does not begin in front of a visitor.
   */
  private standAside(v: NonNullable<Market['cfg']['verifier']>, report: VerifierRoundReport): boolean {
    if (!Verifier.withinWindow(v.window ?? null)) { report.skipped.window++; return true; }
    const b = this.budget(v);
    if (!b.ok) { report.skipped.budget++; return true; }
    if (this.market.runtime.aheadOf(RUNTIME_PRIORITY.verify)) { report.skipped.busy++; return true; }
    return false;
  }

  /** Is `now` inside the operator's verification window? A null window means "any time" (item 333). */
  static withinWindow(w: { from: string; to: string } | null, now = new Date()): boolean {
    if (!w) return true;
    const min = (x: string) => { const [h, m] = x.split(':').map(Number); return (h % 24) * 60 + (m % 60); };
    const cur = now.getHours() * 60 + now.getMinutes();
    const from = min(w.from), to = min(w.to);
    return from <= to ? cur >= from && cur < to : cur >= from || cur < to;   // a window that crosses midnight
  }

  /** What is left of the rolling-hour budget (items 332 / 333). */
  private budget(v: NonNullable<Market['cfg']['verifier']>): { ok: boolean; items: number; ms: number; reason?: string } {
    const cut = Date.now() - 3600_000;
    this.spent = this.spent.filter((x) => x.at > cut);
    const items = this.spent.length;
    const ms = this.spent.reduce((a, x) => a + x.ms, 0);
    const maxItems = v.maxPerHour ?? 40;
    const maxMs = (v.maxModelMinutesPerHour ?? 10) * 60_000;
    if (items >= maxItems) return { ok: false, items, ms, reason: `${items} items verified this hour (verifier.maxPerHour ${maxItems})` };
    if (ms >= maxMs) return { ok: false, items, ms, reason: `${Math.round(ms / 60_000)} min of shared model spent verifying this hour (verifier.maxModelMinutesPerHour ${Math.round(maxMs / 60_000)})` };
    return { ok: true, items, ms };
  }

  /** One line per round, at most every ROUND_LOG_MS, so an operator can see what the filters and the budget did. */
  private reportRound(r: VerifierRoundReport) {
    const s = r.skipped;
    const parts = [
      s.test ? `${s.test} (test listings)` : '',
      s.price ? `${s.price} (below verifier.minPrice)` : '',
      s.budget ? `${s.budget} (hourly budget spent)` : '',
      s.busy ? `${s.busy} (this node's own work is on the model)` : '',
      s.window ? `${s.window} (outside verifier.window)` : '',
    ].filter(Boolean);
    if (!parts.length) return;
    if (!r.verified && Date.now() - this.lastRoundLog < Verifier.ROUND_LOG_MS) return;
    this.lastRoundLog = Date.now();
    this.market.log('info', 'verifier', `round: verified ${r.verified}, skipped ${parts.join(', ')}`, null, { report: r, work: this.work() });
  }

  /** What this node has spent verifying and what it gave back — `/api/info.verification_stats` reads this. */
  work(): VerifierWork {
    const v = verifierConfig(this.market.cfg);
    const b = this.budget(v);
    const ahead = this.market.runtime.aheadOf(RUNTIME_PRIORITY.verify);
    const outside = !Verifier.withinWindow(v.window ?? null);
    return {
      items_last_hour: b.items, model_minutes_last_hour: Math.round(b.ms / 6000) / 10,
      max_items_per_hour: v.maxPerHour ?? 40, max_model_minutes_per_hour: v.maxModelMinutesPerHour ?? 10,
      released_files: this.released.files, released_bytes: this.released.bytes, retain_bodies: !!v.retainBodies,
      ...(outside ? { paused: `outside the verification window (${v.window!.from}\u2013${v.window!.to})` }
        : !b.ok ? { paused: b.reason }
        : ahead ? { paused: `this node's own work is on the shared model (${ahead.label})` } : {}),
    };
  }

  /**
   * Verify one anchor and write the attestation. Refuses BEFORE spending GPU minutes when the result could not
   * count: a self-attestation (item 146), or a re-run whose record the derivation would discard (item 153).
   */
  async verifyOne(anchor: PatchAnchor, opts: { recheck?: boolean } = {}): Promise<Attestation> {
    const m = this.market;
    const me = m.cfg.identity.address;
    const t0 = Date.now();
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
      // A verifier with a doubt used to have two options: stay silent, or file a challenge that takes the seller off
      // sale (item 339). Naming the recheck FIRST is the point — most operators will not attack a listing to record a
      // measurement, and a network whose only lever is an attack learns nothing.
      if (!canUpgrade && !opts.recheck) {
        throw new ConflictError(`this node already attested ${anchor.id} (${mine.passed ? 'PASS' : 'FAIL'}, ${mine.verified_on}, ${new Date(mine.created_at).toISOString()}). To measure it again and put the result on the record WITHOUT taking it off sale, ask this node for a recheck: POST /api/patches/${anchor.id}/verify {"recheck": true}. A recheck that fails withdraws this node's earlier PASS; one that passes is a visible confirmation. A challenge (ainize patch challenge ${anchor.id} --reason …) stops the seller's sales and asks every verifier to re-run it${mine.verified_on === 'hash-only' ? '; this node will also re-verify on its own once it has a model server that can run the benchmark (it has none that matches now)' : ''}.`);
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
    m.log('info', 'verifier', `${opts.recheck ? 're-measuring' : 'verifying'} ${anchor.id} (${anchor.name})`, anchor.id);
    const blob = await m.ensureBlob(anchor);
    const st = await m.runtime.status();
    let passed = false;
    let score: Record<string, string | number> = {};
    let verified_on = 'hash-only';
    let restarts = 0;
    let collateral: number | undefined;
    let failures: NonNullable<Attestation['failures']> = [];
    let samplesRun = 0;
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
        samplesRun = out.details.length;
        failures = out.details.filter((d) => !d.hit).slice(0, ATTESTATION_MAX_FAILURES)
          .map((d) => ({ prompt: String(d.prompt ?? '').slice(0, ATTESTATION_PROMPT_MAX), expect: String(d.expect ?? '').slice(0, ATTESTATION_GOT_MAX), got: String(d.got ?? '').slice(0, ATTESTATION_GOT_MAX) }));
        this.runtimeFailures.delete(anchor.id);
        m.log('info', 'verifier', `benchmark ${anchor.id}: ${out.score.free_generation}${out.score.per_source ? ` (${out.score.per_source})` : ''} restarts=${restarts}`, anchor.id, { log: out.log, details: out.details, pre_apply: out.pre_apply, per_source: out.per_source, stack: out.stack });
      } catch (err) {
        this.noteFailure(anchor.id);
        const left = this.graceLeft(anchor.id);
        if (left > 0) throw new RuntimeWaitError(`${(err as Error).message} (retrying for ${Math.round(left / 60000)} more min before hash-only fallback)`, (err as Error).message, left);
        passed = blob.rows === anchor.rows;
        score = { integrity: 'sha256 ok', rows: blob.rows, benchmark: `not executed (runtime kept failing: ${(err as Error).message.slice(0, 80)})` };
        verified_on = 'hash-only';
        // The one line per patch this fallback is worth: the grace period is over and this attestation carries no
        // benchmark. Every retry before it was silent (item 130).
        m.log('warn', 'verifier', `attesting ${anchor.id} hash-only: the model server did not come back within ${Math.round(Verifier.RUNTIME_GRACE_MS / 60000)} min (${(err as Error).message.slice(0, 120)}) — sha256 and row count only, no benchmark`, anchor.id);
      }
    } else if (wantsRuntime && !runtimeCompatible && graceLeft > 0) {
      // This node is supposed to have a compatible runtime (e.g. serving restart in progress) — wait before attesting hash-only.
      this.noteFailure(anchor.id);
      throw new RuntimeWaitError(`runtime unavailable (${st.error ?? 'no model'}) — waiting up to ${Math.round(this.graceLeft(anchor.id) / 60000)} min before hash-only fallback`, st.error ?? 'no model', this.graceLeft(anchor.id));
    } else {
      // No compatible runtime here: attest integrity only (sha256 + row count), clearly labelled.
      passed = blob.rows === anchor.rows;
      score = { integrity: 'sha256 ok', rows: blob.rows, benchmark: 'not executed (no compatible runtime on this node)' };
      verified_on = 'hash-only';
    }
    // How much of this body is its declared parents', address for address (item 303). A child that carries every one
    // of its base's rows and changes none of them added nothing: it is the base, resold, and only a node holding both
    // files can say so. Recorded on every attestation that could measure it, so the page and `patch get` can print
    // "2,992 of 2,992 rows are identical to pixel-parent-c" instead of the two numbers side by side with no comment.
    const overlap = this.parentOverlap(anchor, blob.path);
    if (overlap && overlap.resold) {
      passed = false;
      score = { ...score, resale: `${overlap.identical[overlap.resold]}/${overlap.rows} rows are identical to ${overlap.resold} — this body adds nothing to its parent` };
      m.log('warn', 'verifier', `${anchor.id} FAILS as a derivative: every one of its ${overlap.rows} rows is identical to ${overlap.resold}'s. It is that knowledge, republished — not something built on top of it.`, anchor.id, { identical: overlap.identical });
    }
    const body: Omit<Attestation, 'sig'> = {
      patch_id: anchor.id, verifier: m.cfg.identity.address, verifier_name: m.cfg.name, patch_sha256: blob.sha256,
      benchmark_hash: anchor.benchmark_hash, score, passed, collateral_nat: collateral, verified_on, restarts_detected: restarts,
      created_at: Date.now(),
    };
    // What the run cost (item 340): a 4/4 and a 40/40 on a 2,761-fact knowledge were the same record to every reader.
    if (verified_on !== 'hash-only') {
      body.duration_ms = Date.now() - t0;
      body.samples_run = samplesRun;
      body.samples_available = anchor.benchmark.samples?.length ?? 0;
    }
    if (opts.recheck) body.recheck = true;
    if (overlap) { body.rows_shared_with_parents = overlap.identical; body.rows = overlap.rows; }
    // What the model actually answered on the questions it got wrong (item 155). The verifier saw this and threw it
    // away: the author's node used to receive "0/2" and nothing else, on an anchor that is permanent and an id that
    // is burned. It travels signed, so the author can act on evidence rather than on a fraction.
    if (failures.length) body.failures = failures;
    // Which model server ran it, so "2/2 independent" can tell two processes on one vLLM apart (item 329).
    if (verified_on !== 'hash-only') {
      body.executor = await this.executorFingerprint(st);
      body.baseline = true;
    }
    const sig = signMessage(JSON.stringify([body.patch_id, body.patch_sha256, body.benchmark_hash, body.passed, body.score, body.failures ?? [], body.executor?.instance ?? '',
      body.samples_run ?? 0, body.samples_available ?? 0, body.duration_ms ?? 0, body.rows_shared_with_parents ?? {}]), m.cfg.identity.privateKey);
    const att: Attestation = { ...body, sig };
    await m.attest(att);
    this.spent.push({ at: Date.now(), ms: Date.now() - t0 });
    await this.releaseBody(anchor, blob.sha256);
    return att;
  }

  /**
   * How many of this body's rows are byte-for-byte its parents' (item 303).
   *
   * The stub backend copies its fixture whenever a correction mentions the fixture's subject, and a real `--init-patch`
   * build squashes parent rows in on purpose — either way nothing counted the rows a child did NOT add, so a one-fact
   * lesson shipping 2,992 of its base's rows was verified 2/2 and sold as new while the base's author was paid 30 % of
   * a sale that resold their whole file. Only a node that holds both files can measure this, so the verifier does.
   *
   * `resold` names a parent whose rows this body reproduces ENTIRELY, changing none of them: that is the parent
   * republished, and the attestation fails on it. A body that carries parent rows AND changes some of them is a
   * derivative — it is reported, not refused.
   */
  private parentOverlap(anchor: PatchAnchor, path: string): { rows: number; identical: Record<string, number>; resold?: string } | null {
    const parents = [...new Set([...(anchor.base?.stack ?? []).map((b) => b.patch_id), ...anchor.parents])];
    if (!parents.length) return null;
    const read = (p: string) => {
      const a = readNpzMember(p, 'addrs'), c = readNpzMember(p, 'after');
      const n = a.header.shape[0];
      const d = c.header.shape[1] ?? 1;
      if (!n || n > Verifier.OVERLAP_MAX_ROWS) return null;
      const rows = new Map<string, Buffer>();
      for (let i = 0; i < n; i++) rows.set(String(a.body.readBigInt64LE(8 * i)), c.body.subarray(4 * d * i, 4 * d * (i + 1)));
      return rows;
    };
    let mine: Map<string, Buffer> | null;
    try { mine = read(path); } catch { return null; }
    if (!mine) return null;
    const identical: Record<string, number> = {};
    let resold: string | undefined;
    for (const pid of parents) {
      const pa = this.market.catalogSync().find((x) => x.anchor.id === pid)?.anchor;
      const pb = pa ? this.market.blobs.get(pa.patch_sha256) : null;
      if (!pb) continue;                       // this node does not hold the parent: nothing measurable, nothing claimed
      let theirs: Map<string, Buffer> | null;
      try { theirs = read(pb.path); } catch { continue; }
      if (!theirs) continue;
      let same = 0;
      for (const [addr, vec] of mine) { const t = theirs.get(addr); if (t && t.length === vec.length && t.equals(vec)) same++; }
      identical[pid] = same;
      if (same === mine.size && same > 0) resold = pid;
    }
    if (!Object.keys(identical).length) return null;
    return { rows: mine.size, identical, ...(resold ? { resold } : {}) };
  }
  /** Above this the address-set comparison is skipped: it is a diagnostic, not a reason to hold the shared model. */
  static readonly OVERLAP_MAX_ROWS = 200_000;

  /**
   * Give a verified body back to the disk (item 336).
   *
   * `ensureBlob` stored every body this node ever scored and nothing purged them: node-b held 932 MB after 203
   * verifications, none of them purchased. A verification is a measurement, not a licence to serve (item 327) and not
   * a reason to keep the file — so once the attestation is written the body goes, unless this node authored it,
   * bought it, teaches on it, or is serving it right now. `verifier.retainBodies` keeps the old behaviour.
   */
  private async releaseBody(anchor: PatchAnchor, sha: string): Promise<void> {
    const m = this.market;
    const v = verifierConfig(m.cfg);
    if (v.retainBodies) return;
    const blob = m.blobs.get(sha);
    if (!blob) return;
    // Bodies are content-addressed: every id built from the same training output shares this file.
    const sharing = (await m.catalogAll()).filter((e) => e.anchor.patch_sha256 === sha);
    for (const e of sharing) {
      if (e.status === 'DRAFT') return;
      if (e.anchor.author.toLowerCase() === m.address.toLowerCase()) return;
      if (m.store.getPurchase(e.anchor.id)) return;
      if (m.isApplied(e.anchor.id)) return;
      const lic = m.store.getLicense(e.anchor.id);
      if (lic && lic.source !== 'verification') return;
    }
    if (blob.path.startsWith(m.datasets.dir)) return;   // a training set, not a knowledge body
    m.blobs.remove(sha);
    for (const e of sharing) m.store.clearLicense(e.anchor.id);
    this.released.files++;
    this.released.bytes += blob.size_bytes;
    m.invalidate();
    m.log('info', 'blob', `released the ${anchor.id} body after attesting it (${(blob.size_bytes / 1e6).toFixed(1)} MB freed; this node neither wrote nor bought it). Set verifier.retainBodies to keep verified bodies.`, anchor.id, { sha256: sha, bytes: blob.size_bytes });
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
