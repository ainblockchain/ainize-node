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
  /** Hits per source knowledge (§7.7): '(own)' plus one entry per parent whose samples were included. */
  per_source?: Record<string, string>;
  /** The ordered base stack that was loaded underneath for this run. */
  stack?: string[];
  log: string[];
}

/** Options for one verification run. `below` is the ordered base stack the candidate needs underneath (§7.7). */
export interface VerifyOpts {
  restore?: boolean;
  maxSamples?: number;
  below?: { id: string; path: string; sha256: string }[];
  /** The candidate's own journal path, so restoring puts back whatever the apply displaced. */
  journal?: string;
  /** true when the candidate is a delta: its `before` is checked against the live rows before anything is written. */
  delta?: boolean;
  /** Names the lock section this run takes (`verify:<id>`), so the queue, the watchdog and `/api/runtime` can say what is running. */
  label?: string;
  /**
   * Crash marker (item 126). `applying()` runs BEFORE the candidate's rows are written and `restored()` after they
   * have been put back, so the caller can persist "this body is on the shared table right now": a SIGKILL between
   * the two used to leave the model patched with nothing anywhere that knew it. On any failure the marker is left
   * standing on purpose — the caller's restore pass is what takes it off.
   */
  mark?: { applying: () => void; restored: () => void };
}

/** What `patch.py check` measured on the live table (design §8.2). */
export interface PatchCheck { rows: number; differ_before: number; differ_after: number; ok: boolean; applied: boolean }
/** What `patch.py status` measured (journal-aware, bf16-exact per row). */
export interface PatchStackStatus { applied: boolean; sampled: number; rows: number; at_after: number; at_prev: number; baseline: 'before' | 'journal' }
/** A patch.py run plus the machine-readable line it printed last. */
export interface PatchRun { code: number; out: string; err: string; json: Record<string, unknown> | null }
export interface ApplyOpts { journal?: string; stackSha?: string; verifyBefore?: boolean }
export interface RemoveOpts { journal?: string; keepJournal?: boolean }

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

/**
 * Priority of one section on the ONE shared model (items 244 / 333). Lower runs first; ties keep arrival order.
 *
 * The lock used to be plain FIFO, so unpaid verification of a stranger's knowledge — 17.9 s average, 181 s worst
 * measured on node-b — sat in front of the visitor's live test that converts, and a nightly bake queued behind both.
 * Naming the three classes is the whole scheduler: a person waiting on this node goes first, the node's own bake
 * next, verification last.
 */
export const RUNTIME_PRIORITY = {
  /** Someone is waiting on this node right now: chat, a live test, an operator apply/remove. */
  serving: 0,
  /** This node's own bake — a lesson with a progress bar on someone's screen. */
  teach: 5,
  /** Unpaid work on a stranger's knowledge: it yields to everything above. */
  verify: 9,
} as const;

/** One caller queued for the shared model, as `queueState()` reports it. */
export interface QueuedSection { label: string; priority: number; since: number }

export class Runtime {
  /** Callers waiting for the serialised section, highest priority first (`seq` keeps arrival order inside a class). */
  private waiters: { priority: number; seq: number; label: string; since: number; start: () => void }[] = [];
  private active = false;
  private seq = 0;
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
  private serial<T>(fn: () => Promise<T>, label = 'runtime', waitMs?: number, onEnter?: () => void, priority = Runtime.priorityOf(label)): Promise<T> {
    const run = async () => {
      const release = await this.acquireLock(label, undefined, waitMs);
      this.busy = { label, since: Date.now() };
      // The caller learns the wait is over the instant the lock is ours — before any model call — so a request
      // that is still queued can be told apart from one that is running (and cancelled for free while queued).
      try { onEnter?.(); } catch { /* a bookkeeping callback must never fail the run */ }
      try { return await fn(); } finally { this.lastOp = { label, at: Date.now() }; this.busy = null; release(); }
    };
    return new Promise<T>((resolve, reject) => {
      this.waiters.push({
        priority, seq: ++this.seq, label, since: Date.now(),
        start: () => { run().then(resolve, reject).finally(() => { this.active = false; this.pump(); }); },
      });
      this.pump();
    });
  }

  /** Start the highest-priority waiter when the section is free. Ties are broken by arrival order, so nothing starves inside a class. */
  private pump(): void {
    if (this.active || !this.waiters.length) return;
    this.waiters.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
    const next = this.waiters.shift()!;
    this.active = true;
    next.start();
  }

  /**
   * Which class a section belongs to when the caller did not say (items 244 / 333). Read from the label prefix the
   * callers already pass, so every existing call site is classified without changing it.
   */
  static priorityOf(label: string): number {
    if (label.startsWith('verify')) return RUNTIME_PRIORITY.verify;
    if (label.startsWith('teach')) return RUNTIME_PRIORITY.teach;
    return RUNTIME_PRIORITY.serving;
  }

  /**
   * Is something more urgent than `priority` running or waiting? Verification asks this before it spends a GPU
   * minute, so the node's own paying visitor is never behind unpaid work for a stranger (item 333).
   */
  aheadOf(priority: number): QueuedSection | null {
    const running = this.busy && Runtime.priorityOf(this.busy.label) < priority ? { label: this.busy.label, priority: Runtime.priorityOf(this.busy.label), since: this.busy.since } : null;
    if (running) return running;
    const w = this.waiters.filter((x) => x.priority < priority).sort((a, b) => a.priority - b.priority || a.seq - b.seq)[0];
    return w ? { label: w.label, priority: w.priority, since: w.since } : null;
  }

  /** In-process holder of the serialised section (null = idle). Cross-process holders are visible through `lockHolder()`. */
  private busy: { label: string; since: number } | null = null;
  /**
   * The last serialised section that FINISHED here. The watchdog's "the table reverted" warning used to blame a
   * serving restart it never checked (item 258); with this it can name what this node did last instead.
   */
  private lastOp: { label: string; at: number } | null = null;
  lastOperation(): { label: string; at: number } | null { return this.lastOp ? { ...this.lastOp } : null; }
  /** Number of callers waiting in the in-process queue. */
  private get waiting(): number { return this.waiters.length + (this.active ? 1 : 0); }

  /** Patch-hook mailbox of the serving instance this node talks to (config `runtime.patchDir`, default <repo>/ple_patch). */
  patchDir(): string | null { return this.cfg.patchDir ?? (this.repo ? join(this.repo, 'ple_patch') : null); }
  /**
   * Where that mailbox came from (item 144). `runtime.api` says which model to TALK to and `runtime.patchDir` says
   * which mailbox to WRITE into; they are independent, and when the second is unset it is derived from a repo path
   * that `init` adopts on its own. A node could therefore benchmark against one instance and mutate another
   * instance's memory table — taking its lock — while `status` said `runtime available · hook ok`.
   */
  patchDirSource(): 'config' | 'repo' | 'none' { return this.cfg.patchDir ? 'config' : this.repo ? 'repo' : 'none'; }
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

  /**
   * What the shared model is doing and how many callers are behind it (D3 — the queue must be visible).
   * `queued` names them in the order they will run, so a lesson that says "waiting for the shared model" can say
   * what it is waiting for and for how long (items 244 / 333).
   */
  queueState(): { running: { label: string; since: number; priority: number } | null; waiting: number; queued: QueuedSection[]; lock: ReturnType<Runtime['lockHolder']> } {
    const queued = [...this.waiters].sort((a, b) => a.priority - b.priority || a.seq - b.seq).map((w) => ({ label: w.label, priority: w.priority, since: w.since }));
    return {
      running: this.busy ? { ...this.busy, priority: Runtime.priorityOf(this.busy.label) } : null,
      waiting: queued.length, queued, lock: this.lockHolder(),
    };
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
  exclusive<T>(label: string, fn: () => Promise<T>, opts: { onEnter?: () => void; priority?: number } = {}): Promise<T> {
    return this.serial(fn, label, undefined, opts.onEnter, opts.priority);
  }

  /**
   * Like `exclusive()` but polite (teach mode, spec §8.3 lock etiquette): waits at most `waitMs` (default 2 min) for the
   * in-process queue AND the cross-process lease instead of joining the 20-minute queue; throws
   * `shared runtime busy (…)` so the caller can requeue with jitter. Never breaks a live lease.
   */
  async exclusiveTry<T>(label: string, fn: () => Promise<T>, opts: { waitMs?: number; priority?: number } = {}): Promise<T> {
    const waitMs = opts.waitMs ?? 2 * 60_000;
    const t0 = Date.now();
    while (this.busy || this.waiters.length > 0) {
      if (Date.now() - t0 > waitMs) throw new Error(`shared runtime busy (${this.owner}: ${this.busy?.label ?? 'queued'}) — try again later`);
      await new Promise((r) => setTimeout(r, 150 + Math.random() * 150));
    }
    const left = Math.max(1000, waitMs - (Date.now() - t0));
    return this.serial(fn, label, left, undefined, opts.priority);
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
      const p = spawn(this.cfg.python ?? 'python3', args, {
        cwd: repo,
        env: { ...process.env, ENGRAM_API: this.cfg.api ?? '', ...(patchDir ? { ENGRAM_PATCH_DIR: patchDir } : {}) },
      });
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

  /**
   * What is physically on the shared table, as this node recorded it (item 126). `status().applied` used to be a
   * hard-coded `[]`, so `GET /api/info` and `ainize status` could never show what was loaded — the one screen an
   * operator checks after a crash. Market wires the node's `applied` rows in here at start-up.
   */
  private appliedSource: (() => string[]) | null = null;
  setAppliedSource(fn: () => string[]) { this.appliedSource = fn; }
  private appliedNow(): string[] { try { return this.appliedSource ? this.appliedSource() : []; } catch { return []; } }

  async status(force = false): Promise<RuntimeStatus> {
    if (Date.now() < this.downUntil) {
      // a generation just failed on the model side — report it down until the window passes (or a later call succeeds)
      return { available: false, api: this.cfg.api ?? null, model: null, hook: false, repo: this.repo, applied: this.appliedNow(), error: MODEL_UNAVAILABLE, detail: this.downDetail.slice(0, 200) };
    }
    // `applied` is never cached: it changes with every apply/remove, and a 30-second-old copy of it is a lie.
    if (!force && this.statusCache && Date.now() - this.statusCache.at < 30_000) return { ...this.statusCache.value, applied: this.appliedNow() };
    const model = await this.models();
    const hook = model ? await this.hookAvailable() : false;
    const value: RuntimeStatus = { available: !!model && hook, api: this.cfg.api ?? null, model, hook, repo: this.repo, applied: [] };
    if (!model) value.error = 'serving API unreachable';
    else if (!hook) value.error = this.repo ? 'patch hook unavailable (ENGRAM_HOOK=1?)' : 'runtime repo not found';
    this.statusCache = { at: Date.now(), value };
    return { ...value, applied: this.appliedNow() };
  }

  info(npz: string) { return this.py(['scripts/patch.py', 'info', npz], 120_000); }
  apply(npz: string, opts: ApplyOpts = {}) { return this.serial(() => this.applyRaw(npz, opts), 'apply'); }
  remove(npz: string, opts: RemoveOpts = {}) { return this.serial(() => this.removeRaw(npz, opts), 'remove'); }

  // ---------------------------------------------------------------- journalled stack (design §5.4, §8)

  /** Where the journals live: one directory beside the hook mailbox this node writes into (§5.4). */
  journalDir(): string | null { const d = this.patchDir(); return d ? join(d, 'journal') : null; }
  /** The journal of one applied body: `<patchDir>/journal/<patch_sha256>.npz` — the `prev` values that apply overwrote. */
  journalPath(sha256: string): string | null { const d = this.journalDir(); return d && /^[0-9a-f]{8,64}$/.test(sha256) ? join(d, `${sha256}.npz`) : null; }
  hasJournal(sha256: string): boolean { const p = this.journalPath(sha256); return !!p && existsSync(p); }

  /** The `--json` line patch.py prints last, or null when it printed none (old script, crash, hook missing). */
  private static lastJson(out: string): Record<string, unknown> | null {
    for (const line of out.split('\n').reverse()) {
      const t = line.trim();
      if (t.startsWith('{') && t.endsWith('}')) { try { return JSON.parse(t) as Record<string, unknown>; } catch { /* not the json line */ } }
    }
    return null;
  }

  /**
   * Read-first verification (§8.2): compare the live rows to this body's `before` on ALL rows, bf16-exact.
   * `ok` is the only evidence that a delta may be applied — its base stack is underneath, exactly.
   * Nothing is written. `null` when the script could not answer (no hook, no repo, pre-L2 script).
   */
  async check(npz: string): Promise<PatchCheck | null> {
    const r = await this.py(['scripts/patch.py', 'check', npz, '--json'], 900_000);
    const j = Runtime.lastJson(r.out);
    if (!j || typeof j.rows !== 'number') return null;
    return { rows: j.rows as number, differ_before: j.differ_before as number, differ_after: j.differ_after as number, ok: !!j.ok, applied: !!j.applied };
  }

  /**
   * Unlocked apply — ONLY inside an `exclusive()` section that already holds the lock (apply() would deadlock).
   * With `journal` the hook's returned `prev` is saved so `remove` can put back exactly what was there (a parent's
   * `after`, not the disk base). With `verifyBefore` the rows are read first and NOTHING is written on a mismatch.
   */
  async applyRaw(npz: string, opts: ApplyOpts = {}): Promise<PatchRun> {
    const args = ['scripts/patch.py', 'apply', npz, '--json'];
    if (opts.journal) args.push('--journal', opts.journal);
    if (opts.stackSha) args.push('--stack', opts.stackSha);
    if (opts.verifyBefore) args.push('--verify-before');
    const r = await this.py(args);
    return { ...r, json: Runtime.lastJson(r.out) };
  }

  /** Unlocked remove — replays `journal` when given (and deletes it), else writes `before` back. */
  async removeRaw(npz: string, opts: RemoveOpts = {}): Promise<PatchRun> {
    const args = ['scripts/patch.py', 'remove', npz, '--json'];
    if (opts.journal) args.push('--journal', opts.journal);
    if (opts.keepJournal) args.push('--keep-journal');
    const r = await this.py(args);
    return { ...r, json: Runtime.lastJson(r.out) };
  }

  /**
   * Journal-aware status (§8.4): is this body's `after` on the table, or the value it displaced? Comparison is
   * bf16-exact per row — the old 2,000-row majority test compared float distances and could not tell a child
   * sitting on its parent from a child sitting on the bare table. `all: true` checks every row.
   */
  async statusOf(npz: string, opts: { journal?: string; all?: boolean } = {}): Promise<PatchStackStatus | null> {
    const args = ['scripts/patch.py', 'status', npz, '--json'];
    if (opts.journal) args.push('--journal', opts.journal);
    if (opts.all) args.push('--all');
    const r = await this.py(args, opts.all ? 900_000 : 120_000);
    const j = Runtime.lastJson(r.out);
    if (!j || typeof j.applied !== 'boolean') return null;
    return { applied: j.applied as boolean, sampled: j.sampled as number, rows: j.rows as number, at_after: j.at_after as number, at_prev: j.at_prev as number, baseline: j.baseline as 'before' | 'journal' };
  }

  async isApplied(npz: string, journal?: string): Promise<boolean | null> {
    const st = await this.statusOf(npz, { journal });
    if (st) return st.applied;
    // pre-L2 script (no --json): fall back to the human line it has always printed
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
  async verify(npz: string, bench: BenchmarkSpec, opts: VerifyOpts = {}): Promise<VerifyOutcome> {
    return this.serial(() => this.verifyInLock(npz, bench, opts), `verify:${opts.label ?? 'patch'}`);
  }

  /**
   * The body of `verify()` WITHOUT taking the lock — for a caller that already holds it and has to do more inside the
   * same section (Market.verifyIsolated takes the rest of the applied stack off the table first, items 241/258).
   * Calling this without holding the lock is a bug: two verifications would interleave on one shared model.
   */
  async verifyInLock(npz: string, bench: BenchmarkSpec, opts: VerifyOpts = {}): Promise<VerifyOutcome> {
    {
      const log: string[] = [];
      const samples = (bench.samples ?? []).slice(0, opts.maxSamples ?? 40);
      const st = await this.status(true);
      if (!st.available) throw new Error(st.error ?? 'runtime unavailable');
      if (!samples.length) throw new Error('benchmark has no inline samples');
      if (!(await this.probe())) throw new Error('serving model not responding (probe timed out) — will retry');
      // §7.7: a knowledge trained on top of others is only meaningful with those others underneath, so the stack goes
      // on first and the baseline is measured WITH it — otherwise the parents' answers would be scored as the child's.
      const below = opts.below ?? [];
      const addedBelow: typeof below = [];
      for (const b of below) {
        if ((await this.isApplied(b.path, this.journalPath(b.sha256) ?? undefined)) === true) { log.push(`base ${b.id} already loaded`); continue; }
        const r = await this.applyRaw(b.path, { journal: this.journalPath(b.sha256) ?? undefined });
        if (r.code !== 0) throw new Error(`loading the base ${b.id} failed: ${r.err || r.out}`);
        addedBelow.push(b);
        log.push(`base ${b.id}: ${r.out}`);
      }
      const wasApplied = await this.isApplied(npz);
      log.push(`baseline applied=${wasApplied}${below.length ? ` on top of ${below.map((b) => b.id).join(' → ')}` : ''}`);
      const before: VerifyOutcome['details'] = [];
      if (!wasApplied) {
        for (const s of samples.slice(0, Math.min(samples.length, 8))) {
          const got = (await this.complete(s.prompt, 8, 300_000, { sampling: null })).trim();
          before.push({ prompt: s.prompt, expect: s.expect, got, hit: got.startsWith(s.expect) });
        }
        log.push(`pre-apply hits ${before.filter((d) => d.hit).length}/${before.length}${below.length ? ' (with the base stack loaded)' : ''}`);
      }
      opts.mark?.applying();
      const ap = await this.applyRaw(npz, { journal: opts.journal, verifyBefore: opts.delta });
      if (ap.json?.error === 'base_mismatch') throw new Error(`base_mismatch: the rows under this knowledge are not the ones it was trained on (${ap.json.rows_differ} of ${ap.json.rows} rows) — it cannot be verified here`);
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
        const rm = await this.removeRaw(npz, { journal: opts.journal });
        log.push(`restore: ${rm.out || rm.err}`);
        if (rm.code === 0) opts.mark?.restored();
      }
      // Whatever this run put on the table comes off in reverse, through the journal — the node is left as it was found.
      for (let i = addedBelow.length - 1; i >= 0; i--) {
        const b = addedBelow[i];
        const r = await this.removeRaw(b.path, { journal: this.journalPath(b.sha256) ?? undefined });
        log.push(`restore base ${b.id}: ${r.out || r.err}`);
      }
      const hits = details.filter((d) => d.hit).length;
      // Stratified (§7.7): a sample's `source` names the knowledge it came from — the child's own samples have none.
      // A child that answers its own questions but breaks a parent's must not pass, so each source is scored on its own.
      const bySource = new Map<string, { hit: number; total: number }>();
      details.forEach((d, i) => {
        const src = samples[i]?.source ?? '(own)';
        const cur = bySource.get(src) ?? { hit: 0, total: 0 };
        cur.total++; if (d.hit) cur.hit++;
        bySource.set(src, cur);
      });
      const per_source: Record<string, string> = {};
      for (const [src, v] of bySource) per_source[src] = `${v.hit}/${v.total}`;
      const own = bySource.get('(own)') ?? { hit: hits, total: details.length };
      const parentsOk = [...bySource].every(([src, v]) => src === '(own)' || v.total === 0 || v.hit / v.total >= 0.9);
      const ownOk = own.total === 0 || own.hit === own.total || (own.total >= 10 && own.hit / own.total >= 0.95);
      const passed = below.length || bySource.size > 1
        ? ownOk && parentsOk
        : hits === details.length || (details.length >= 10 && hits / details.length >= 0.95);
      return {
        passed,
        score: {
          free_generation: `${hits}/${details.length}`,
          ...(before.length ? { pre_apply: `${before.filter((d) => d.hit).length}/${before.length}` } : {}),
          ...(bySource.size > 1 ? { per_source: Object.entries(per_source).map(([k, v]) => `${k} ${v}`).join(', ') } : {}),
          ...(below.length ? { stack: below.map((b) => b.id).join(' → ') } : {}),
        },
        per_source,
        stack: below.map((b) => b.id),
        verified_on: `vllm:${st.model}`,
        restarts_detected: restarts,
        details,
        pre_apply: before,
        log,
      };
    }
  }
}
