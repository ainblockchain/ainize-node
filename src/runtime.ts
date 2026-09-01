/**
 * Runtime applier (런타임 적용기 150) — bridges to the reference implementation in /mnt/newdata/qwen3.8:
 *   scripts/patch.py apply|remove|status|info <npz>   (file-based hook into the serving vLLM's PLE table)
 * plus the vLLM OpenAI-compatible API for free-generation scoring. All operations are serialised.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BenchmarkSpec, NodeConfig, RuntimeStatus, SamplingOptions } from '@ngram/core';
import { guardAnswer, type GuardResult } from './degenerate.js';

export interface VerifyOutcome {
  passed: boolean;
  score: Record<string, string | number>;
  verified_on: string;
  restarts_detected: number;
  details: { prompt: string; expect: string; got: string; hit: boolean }[];
  /** Baseline generations before the patch was applied (same prompts, subset). */
  pre_apply: { prompt: string; expect: string; got: string; hit: boolean }[];
  collateral_nat?: number;
  log: string[];
}

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface ChatResult {
  /** What to show: the answer after the degeneracy guard (identical to `raw_content` unless it was cut). */
  content: string;
  reasoning?: string | null;
  usage?: Record<string, unknown>;
  latency_ms: number;
  model: string;
  /** Upstream finish_reason ("stop" | "length" | …). */
  finish_reason?: string | null;
  /** D1 — why the shown answer is shorter than what the model produced. */
  truncated?: 'repetition' | 'length' | null;
  shown_chars?: number;
  raw_chars?: number;
  /** The model's full output; only present when `truncated === 'repetition'`, so the UI can offer "show the raw answer". */
  raw_content?: string;
  /** Which guard rule fired, at what score/period (diagnostics; the UI does not show it). */
  truncate_detail?: GuardResult['detail'];
}

/**
 * D1 defaults, measured on the shared serving instance (PROBE A/B, 2026-09-01).
 * chat: "\n\n\n\n" cannot cut a paragraphed answer but does end a runaway that fills the budget with blank lines;
 * "<think>" catches the model dropping into a reasoning block when thinking was NOT requested (it is removed
 * automatically when the caller asks for thinking, or it would truncate the reasoning itself).
 * complete: "\n\n" — provably safe on all 26 real KRX benchmark prompts (the answer is a bare code on line 1) and
 * measured to raise completion accuracy from 10/12 to 12/12 while halving degeneration.
 * Penalties are deliberately unset: repetition_penalty 1.1 made degeneration WORSE (36.1% vs 33.3%) and
 * frequency_penalty 1.0 bought a lower loop rate by dropping correct answers from 12/12 to 8/12.
 */
export const DEFAULT_CHAT_SAMPLING: SamplingOptions = { stop: ['\n\n\n\n', '<think>'], guard: true };
export const DEFAULT_COMPLETE_SAMPLING: SamplingOptions = { stop: ['\n\n', '<think>'], guard: true };

/** Shown to callers whenever the serving model cannot answer (engine crash, restart in progress, connection refused). */
export const MODEL_UNAVAILABLE = 'model unavailable, try again in a few minutes';

/** Error raised when the serving model failed to answer; `status` 503 is what the HTTP API answers, `detail` keeps the raw upstream text for logs. */
export class RuntimeUnavailableError extends Error {
  readonly status = 503;
  constructor(public readonly detail: string) { super(MODEL_UNAVAILABLE); }
}

export class Runtime {
  private queue: Promise<unknown> = Promise.resolve();
  private statusCache: { at: number; value: RuntimeStatus } | null = null;
  /** Until when the model is reported unavailable after a failed generation (a vLLM engine crash keeps /v1/models answering while it restarts). */
  private downUntil = 0;
  private downDetail = '';
  static readonly DOWN_MS = 60_000;
  constructor(private readonly cfg: NonNullable<NodeConfig['runtime']>, private readonly owner = `pid:${process.pid}`) {}

  /** Remember that the model just failed: status() reports it unavailable for DOWN_MS and callers get a friendly 503 instead of the raw upstream error. */
  private markDown(detail: string): RuntimeUnavailableError {
    this.downUntil = Date.now() + Runtime.DOWN_MS;
    this.downDetail = detail;
    this.statusCache = null;
    console.error(`[runtime] ${MODEL_UNAVAILABLE} — ${detail.slice(0, 300)}`);
    return new RuntimeUnavailableError(detail);
  }

  /** A 5xx (engine crash) or 429 (overloaded) is the model's problem, not the caller's; 4xx stays a plain error. */
  private static isModelFailure(status: number): boolean { return status >= 500 || status === 429; }

  get repo(): string | null { return this.cfg.repo && existsSync(this.cfg.repo) ? this.cfg.repo : null; }

  /**
   * Serialise runtime mutations. Several nodes on one machine share ONE serving model, so in addition to the
   * in-process queue we take a cross-process lock (atomic mkdir under the shared repo) with a lease; a stale
   * lease (crashed holder) is broken after `staleMs`.
   */
  private serial<T>(fn: () => Promise<T>, label = 'runtime', waitMs?: number, onEnter?: () => void): Promise<T> {
    const run = async () => {
      const release = await this.acquireLock(label, undefined, waitMs);
      this.busy = { label, since: Date.now() };
      // The caller learns the wait is over the instant the lock is ours — before any model call — so a request
      // that is still queued can be told apart from one that is running (and cancelled for free while queued).
      try { onEnter?.(); } catch { /* a bookkeeping callback must never fail the run */ }
      try { return await fn(); } finally { this.busy = null; release(); }
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** In-process holder of the serialised section (null = idle). Cross-process holders are visible through `lockHolder()`. */
  private busy: { label: string; since: number } | null = null;
  /** Number of callers waiting in the in-process queue (approximate). */
  private waiting = 0;

  /** Patch-hook mailbox of the serving instance this node talks to (config `runtime.patchDir`, default <repo>/ple_patch). */
  patchDir(): string | null { return this.cfg.patchDir ?? (this.repo ? join(this.repo, 'ple_patch') : null); }
  private lockDir(): string | null { const d = this.patchDir(); return d ? join(d, '.ainize-runtime.lock') : null; }

  /**
   * Who holds the shared runtime lock right now (null = free).
   * `alive`/`stale` use exactly the checks acquireLock() uses to break a lease, so the UI never reports a dead
   * holder as a live one: before this, a holder.json left behind by a killed node made the "someone else is
   * testing" banner permanent while every request in fact succeeded instantly (D3, inverted).
   */
  lockHolder(): { owner: string; label: string; since: number; alive: boolean; stale: boolean; mine: boolean } | null {
    const dir = this.lockDir();
    if (!dir || !existsSync(dir)) return null;
    let h: { owner: string; label: string; since: number };
    try { h = JSON.parse(readFileSync(join(dir, 'holder.json'), 'utf8')); } catch { return null; }
    if (!h || typeof h.owner !== 'string') return null;
    return { ...h, alive: Runtime.holderAlive(h.owner), stale: Date.now() - h.since > Runtime.STALE_MS, mine: h.owner === this.owner };
  }

  /** Lease length: a holder older than this is broken by acquireLock() and reported `stale` by lockHolder(). */
  static readonly STALE_MS = 15 * 60_000;
  /** A `pid:<n>` holder on this machine is probed the way acquireLock() probes it; any other owner is assumed alive. */
  private static holderAlive(owner: string): boolean {
    const pid = owner.startsWith('pid:') ? Number(owner.slice(4)) : null;
    if (!pid || pid === process.pid) return true;
    try { process.kill(pid, 0); return true; } catch { return false; }
  }

  /** What the shared model is doing and how many callers are behind it (D3 — the queue must be visible). */
  queueState(): { running: { label: string; since: number } | null; waiting: number; lock: ReturnType<Runtime['lockHolder']> } {
    return { running: this.busy ? { ...this.busy } : null, waiting: Math.max(0, this.waiting - (this.busy ? 1 : 0)), lock: this.lockHolder() };
  }

  private async acquireLock(label: string, staleMs = Runtime.STALE_MS, waitMs: number = 20 * 60_000): Promise<() => void> {
    const dir = this.lockDir();
    if (!dir) return () => undefined;
    const t0 = Date.now();
    for (;;) {
      try {
        mkdirSync(dir);
        writeFileSync(join(dir, 'holder.json'), JSON.stringify({ owner: this.owner, label, since: Date.now() }));
        return () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } };
      } catch {
        const holder = this.lockHolder();
        const holderPid = holder?.owner.startsWith('pid:') ? Number(holder.owner.slice(4)) : null;
        let holderAlive = true;
        if (holderPid && holderPid !== process.pid) { try { process.kill(holderPid, 0); } catch { holderAlive = false; } }
        if (!holder || !holderAlive || Date.now() - holder.since > staleMs) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } continue; }
        if (Date.now() - t0 > waitMs) throw new Error(`shared runtime busy (${holder.owner}: ${holder.label}) — try again later`);
        await new Promise((r) => setTimeout(r, 250 + Math.random() * 250));
      }
    }
  }

  /** Run `fn` while holding the shared runtime lock (for multi-step operations such as apply → chat → restore). */
  exclusive<T>(label: string, fn: () => Promise<T>, opts: { onEnter?: () => void } = {}): Promise<T> {
    this.waiting++;
    return this.serial(fn, label, undefined, opts.onEnter).finally(() => { this.waiting--; });
  }

  /**
   * Like `exclusive()` but polite (teach mode, spec §8.3 lock etiquette): waits at most `waitMs` (default 2 min) for the
   * in-process queue AND the cross-process lease instead of joining the 20-minute queue; throws
   * `shared runtime busy (…)` so the caller can requeue with jitter. Never breaks a live lease.
   */
  async exclusiveTry<T>(label: string, fn: () => Promise<T>, opts: { waitMs?: number } = {}): Promise<T> {
    const waitMs = opts.waitMs ?? 2 * 60_000;
    const t0 = Date.now();
    while (this.busy || this.waiting > 0) {
      if (Date.now() - t0 > waitMs) throw new Error(`shared runtime busy (${this.owner}: ${this.busy?.label ?? 'queued'}) — try again later`);
      await new Promise((r) => setTimeout(r, 150 + Math.random() * 150));
    }
    const left = Math.max(1000, waitMs - (Date.now() - t0));
    return this.serial(fn, label, left);
  }

  /**
   * Sampling for one generation path: the measured defaults with `runtime.sampling.<path>` merged over them.
   * `null` means "exactly what this node sent before the D1 guard existed" — used by benchmark verification and by
   * the teach worker, whose numbers must stay comparable with everything measured to date.
   */
  sampling(path: 'chat' | 'complete', override?: SamplingOptions | null): SamplingOptions | null {
    if (override === null) return null;
    const base = path === 'chat' ? DEFAULT_CHAT_SAMPLING : DEFAULT_COMPLETE_SAMPLING;
    return { ...base, ...(this.cfg.sampling?.[path] ?? {}), ...(override ?? {}) };
  }

  /** The vLLM request fields a SamplingOptions turns into (omitted fields are simply not sent). */
  private static samplingBody(s: SamplingOptions | null, thinking = false): Record<string, unknown> {
    if (!s) return {};
    const body: Record<string, unknown> = {};
    // "<think>" must not stop a request that ASKED for thinking — it would truncate the reasoning block itself.
    const stop = (s.stop ?? []).filter((x) => x && (!thinking || x !== '<think>'));
    if (stop.length) body.stop = stop;
    if (s.repetitionPenalty !== undefined) body.repetition_penalty = s.repetitionPenalty;
    if (s.frequencyPenalty !== undefined) body.frequency_penalty = s.frequencyPenalty;
    if (s.presencePenalty !== undefined) body.presence_penalty = s.presencePenalty;
    return body;
  }

  /** Chat completion on the serving model (OpenAI-compatible). Thinking is off by default so short factual answers come back directly. */
  async chat(messages: ChatMessage[], opts: { maxTokens?: number; temperature?: number; thinking?: boolean; timeoutMs?: number; sampling?: SamplingOptions | null } = {}): Promise<ChatResult> {
    const model = await this.models();
    if (!model || !this.cfg.api) throw new Error('serving API unreachable');
    const sampling = this.sampling('chat', opts.sampling);
    const t0 = Date.now();
    let r: Response;
    try {
      r = await fetch(`${this.cfg.api}/v1/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model, messages,
          max_tokens: opts.maxTokens ?? sampling?.maxTokens ?? 256,
          temperature: opts.temperature ?? sampling?.temperature ?? 0,
          chat_template_kwargs: { enable_thinking: !!opts.thinking },
          ...Runtime.samplingBody(sampling, !!opts.thinking),
        }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 300_000),
      });
    } catch (e) { throw this.markDown(`chat: ${(e as Error).message}`); }
    if (!r.ok) {
      const text = (await r.text().catch(() => '')).slice(0, 200);
      if (Runtime.isModelFailure(r.status)) throw this.markDown(`chat failed: ${r.status} ${text}`);
      throw new Error(`chat failed: ${r.status} ${text}`);
    }
    const j = (await r.json()) as { choices: { message: { content: string | null; reasoning_content?: string; reasoning?: string }; finish_reason?: string }[]; usage?: Record<string, unknown> };
    const c = j.choices?.[0];
    const m = c?.message;
    this.downUntil = 0;
    const lastUser = [...messages].reverse().find((x) => x.role === 'user')?.content ?? '';
    const g = guardAnswer(m?.content ?? '', c?.finish_reason ?? null, lastUser, !!sampling && sampling.guard !== false);
    return {
      content: g.text, reasoning: m?.reasoning_content ?? m?.reasoning ?? null, usage: j.usage, latency_ms: Date.now() - t0, model,
      finish_reason: c?.finish_reason ?? null, ...Runtime.guardFields(g),
    };
  }

  /** The truncation fields of a ChatResult / completion response (`raw_content` only when something was cut). */
  private static guardFields(g: GuardResult) {
    return {
      truncated: g.truncated, shown_chars: g.shown_chars, raw_chars: g.raw_chars,
      ...(g.truncated === 'repetition' ? { raw_content: g.raw, truncate_detail: g.detail } : {}),
    };
  }

  /**
   * Raw completion without the shared lock (read-only w.r.t. the table) and WITHOUT sampling or the guard —
   * the teach worker scores facts with it, and those numbers must stay comparable across the D1 change.
   */
  async completeRaw(prompt: string, maxTokens = 8, timeoutMs = 300_000): Promise<string> { return this.complete(prompt, maxTokens, timeoutMs, { sampling: null }); }

  private py(args: string[], timeoutMs = 600_000): Promise<{ code: number; out: string; err: string }> {
    return new Promise((resolve) => {
      const repo = this.repo;
      if (!repo) return resolve({ code: 127, out: '', err: 'runtime repo not configured' });
      const patchDir = this.patchDir();
      // ENGRAM_PATCH_DIR points engram/live.py at THIS instance's mailbox (engram/live.py:14); without it every node
      // writes into <repo>/ple_patch — the mailbox of whichever server happens to watch it, not the one `api` addresses.
      const p = spawn(this.cfg.python ?? 'python3', args, { cwd: repo,
        env: { ...process.env, ENGRAM_API: this.cfg.api ?? '', ...(patchDir ? { ENGRAM_PATCH_DIR: patchDir } : {}) } });
      let out = '', err = '';
      const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (err += d));
      p.on('close', (code) => { clearTimeout(t); resolve({ code: code ?? 1, out: out.trim(), err: err.trim() }); });
    });
  }

  async models(): Promise<string | null> {
    if (!this.cfg.api) return null;
    try {
      const r = await fetch(`${this.cfg.api}/v1/models`, { signal: AbortSignal.timeout(3000) });
      if (!r.ok) return null;
      const j = (await r.json()) as { data?: { id: string }[] };
      return j.data?.[0]?.id ?? null;
    } catch { return null; }
  }

  async hookAvailable(): Promise<boolean> {
    if (!this.repo) return false;
    const r = await this.py(['-c', 'from engram import live; print("1" if live.available() else "0")'], 20_000);
    return r.out.trim().endsWith('1');
  }

  async status(force = false): Promise<RuntimeStatus> {
    if (Date.now() < this.downUntil) {
      // a generation just failed on the model side — report it down until the window passes (or a later call succeeds)
      return { available: false, api: this.cfg.api ?? null, model: null, hook: false, repo: this.repo, applied: [], error: MODEL_UNAVAILABLE, detail: this.downDetail.slice(0, 200) };
    }
    if (!force && this.statusCache && Date.now() - this.statusCache.at < 30_000) return this.statusCache.value;
    const model = await this.models();
    const hook = model ? await this.hookAvailable() : false;
    const value: RuntimeStatus = { available: !!model && hook, api: this.cfg.api ?? null, model, hook, repo: this.repo, applied: [] };
    if (!model) value.error = 'serving API unreachable';
    else if (!hook) value.error = this.repo ? 'patch hook unavailable (ENGRAM_HOOK=1?)' : 'runtime repo not found';
    this.statusCache = { at: Date.now(), value };
    return value;
  }

  info(npz: string) { return this.py(['scripts/patch.py', 'info', npz], 120_000); }
  apply(npz: string) { return this.serial(() => this.py(['scripts/patch.py', 'apply', npz]), 'apply'); }
  remove(npz: string) { return this.serial(() => this.py(['scripts/patch.py', 'remove', npz]), 'remove'); }
  /** Unlocked variants — ONLY for use inside an `exclusive()` section that already holds the lock (calling apply()/remove() there would deadlock). */
  applyRaw(npz: string) { return this.py(['scripts/patch.py', 'apply', npz]); }
  removeRaw(npz: string) { return this.py(['scripts/patch.py', 'remove', npz]); }
  async isApplied(npz: string): Promise<boolean | null> {
    const r = await this.py(['scripts/patch.py', 'status', npz], 120_000);
    if (r.code !== 0) return null;
    return r.out.includes('끼워짐');
  }

  /** Cheap liveness probe: a 1-token completion must return within `timeoutMs` (unsampled — it only needs a reply). */
  async probe(timeoutMs = 45_000): Promise<boolean> {
    try { await this.complete('Q: 1+1=\nA:', 1, timeoutMs, { sampling: null }); return true; } catch { return false; }
  }

  async complete(prompt: string, maxTokens = 8, timeoutMs = 300_000, opts: { sampling?: SamplingOptions | null } = {}): Promise<string> {
    return (await this.completeDetailed(prompt, { maxTokens, timeoutMs, ...opts })).content;
  }

  /**
   * Completion with the guard verdict attached (POST /api/runtime/complete). `sampling: null` reproduces exactly
   * what this node sent before D1: no stop sequences, no guard, raw text.
   */
  async completeDetailed(prompt: string, opts: { maxTokens?: number; timeoutMs?: number; sampling?: SamplingOptions | null } = {}): Promise<ChatResult> {
    const model = await this.models();
    if (!model || !this.cfg.api) throw new Error('serving API unreachable');
    const sampling = this.sampling('complete', opts.sampling);
    const maxTokens = opts.maxTokens ?? sampling?.maxTokens ?? 8;
    const t0 = Date.now();
    let r: Response;
    try {
      r = await fetch(`${this.cfg.api}/v1/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, prompt, max_tokens: maxTokens, temperature: sampling?.temperature ?? 0, ...Runtime.samplingBody(sampling) }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 300_000),
      });
    } catch (e) { throw this.markDown(`completion: ${(e as Error).message}`); }
    if (!r.ok) {
      if (Runtime.isModelFailure(r.status)) throw this.markDown(`completion failed: ${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`);
      throw new Error(`completion failed: ${r.status}`);
    }
    const j = (await r.json()) as { choices: { text: string; finish_reason?: string }[] };
    this.downUntil = 0;
    const c = j.choices?.[0];
    const g = guardAnswer(c?.text ?? '', c?.finish_reason ?? null, prompt, !!sampling && sampling.guard !== false);
    return { content: g.text, latency_ms: Date.now() - t0, model, finish_reason: c?.finish_reason ?? null, ...Runtime.guardFields(g) };
  }

  /**
   * Restart-aware verification (청구항 2): apply → score samples in chunks, re-checking a sample row
   * between chunks; if the table reverted (serving restart) re-apply and re-measure the chunk; restore.
   *
   * DELIBERATELY EXEMPT FROM D1 SAMPLING. Every generation below passes `sampling: null`, i.e. the request body
   * this node has always sent: {model, prompt, max_tokens: 8, temperature: 0}, no stop sequences, no guard.
   * A stop sequence can only ever cut an answer short, so adding one here could only lower the hit count — it
   * would change what an attestation measures, and scores published before and after would stop being comparable.
   * The prompts are also sent verbatim (`s.prompt`, trailing space included) exactly as before.
   */
  async verify(npz: string, bench: BenchmarkSpec, opts: { restore?: boolean; maxSamples?: number } = {}): Promise<VerifyOutcome> {
    return this.serial(async () => {
      const log: string[] = [];
      const samples = (bench.samples ?? []).slice(0, opts.maxSamples ?? 40);
      const st = await this.status(true);
      if (!st.available) throw new Error(st.error ?? 'runtime unavailable');
      if (!samples.length) throw new Error('benchmark has no inline samples');
      if (!(await this.probe())) throw new Error('serving model not responding (probe timed out) — will retry');
      const wasApplied = await this.isApplied(npz);
      log.push(`baseline applied=${wasApplied}`);
      const before: VerifyOutcome['details'] = [];
      if (!wasApplied) {
        for (const s of samples.slice(0, Math.min(samples.length, 8))) {
          const got = (await this.complete(s.prompt, 8, 300_000, { sampling: null })).trim();
          before.push({ prompt: s.prompt, expect: s.expect, got, hit: got.startsWith(s.expect) });
        }
        log.push(`pre-apply hits ${before.filter((d) => d.hit).length}/${before.length}`);
      }
      const ap = await this.py(['scripts/patch.py', 'apply', npz]);
      if (ap.code !== 0) throw new Error(`apply failed: ${ap.err || ap.out}`);
      log.push(`apply: ${ap.out}`);
      let restarts = 0;
      const details: VerifyOutcome['details'] = [];
      const CHUNK = 8;
      for (let i = 0; i < samples.length; i += CHUNK) {
        const chunk = samples.slice(i, i + CHUNK);
        let attempt = 0;
        for (;;) {
          const res: VerifyOutcome['details'] = [];
          for (const s of chunk) {
            const got = (await this.complete(s.prompt, 8, 300_000, { sampling: null })).trim();
            res.push({ prompt: s.prompt, expect: s.expect, got, hit: got.startsWith(s.expect) });
          }
          const still = await this.isApplied(npz);
          if (still === false && attempt < 2) {
            restarts++; attempt++;
            log.push(`table reverted during chunk ${i / CHUNK} (restart?) → re-apply & re-measure`);
            await this.py(['scripts/patch.py', 'apply', npz]);
            continue;
          }
          details.push(...res);
          break;
        }
      }
      if (opts.restore !== false) {
        const rm = await this.py(['scripts/patch.py', 'remove', npz]);
        log.push(`restore: ${rm.out || rm.err}`);
      }
      const hits = details.filter((d) => d.hit).length;
      const passed = hits === details.length || (details.length >= 10 && hits / details.length >= 0.95);
      return {
        passed,
        score: { free_generation: `${hits}/${details.length}`, ...(before.length ? { pre_apply: `${before.filter((d) => d.hit).length}/${before.length}` } : {}) },
        verified_on: `vllm:${st.model}`,
        restarts_detected: restarts,
        details,
        pre_apply: before,
        log,
      };
    });
  }
}
