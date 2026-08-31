/**
 * Runtime applier (런타임 적용기 150) — bridges to the reference implementation in /mnt/newdata/qwen3.8:
 *   scripts/patch.py apply|remove|status|info <npz>   (file-based hook into the serving vLLM's PLE table)
 * plus the vLLM OpenAI-compatible API for free-generation scoring. All operations are serialised.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BenchmarkSpec, NodeConfig, RuntimeStatus } from '@ngram/core';

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
export interface ChatResult { content: string; reasoning?: string | null; usage?: Record<string, unknown>; latency_ms: number; model: string }

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
  private serial<T>(fn: () => Promise<T>, label = 'runtime', waitMs?: number): Promise<T> {
    const run = async () => {
      const release = await this.acquireLock(label, undefined, waitMs);
      this.busy = { label, since: Date.now() };
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

  private lockDir(): string | null { return this.repo ? join(this.repo, 'ple_patch', '.ainize-runtime.lock') : null; }

  /** Who holds the shared runtime lock right now (null = free). */
  lockHolder(): { owner: string; label: string; since: number } | null {
    const dir = this.lockDir();
    if (!dir || !existsSync(dir)) return null;
    try { return JSON.parse(readFileSync(join(dir, 'holder.json'), 'utf8')); } catch { return null; }
  }

  private async acquireLock(label: string, staleMs = 15 * 60_000, waitMs: number = 20 * 60_000): Promise<() => void> {
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
  exclusive<T>(label: string, fn: () => Promise<T>): Promise<T> {
    this.waiting++;
    return this.serial(fn, label).finally(() => { this.waiting--; });
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

  /** Chat completion on the serving model (OpenAI-compatible). Thinking is off by default so short factual answers come back directly. */
  async chat(messages: ChatMessage[], opts: { maxTokens?: number; temperature?: number; thinking?: boolean; timeoutMs?: number } = {}): Promise<ChatResult> {
    const model = await this.models();
    if (!model || !this.cfg.api) throw new Error('serving API unreachable');
    const t0 = Date.now();
    let r: Response;
    try {
      r = await fetch(`${this.cfg.api}/v1/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages, max_tokens: opts.maxTokens ?? 256, temperature: opts.temperature ?? 0, chat_template_kwargs: { enable_thinking: !!opts.thinking } }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 300_000),
      });
    } catch (e) { throw this.markDown(`chat: ${(e as Error).message}`); }
    if (!r.ok) {
      const text = (await r.text().catch(() => '')).slice(0, 200);
      if (Runtime.isModelFailure(r.status)) throw this.markDown(`chat failed: ${r.status} ${text}`);
      throw new Error(`chat failed: ${r.status} ${text}`);
    }
    const j = (await r.json()) as { choices: { message: { content: string | null; reasoning_content?: string; reasoning?: string } }[]; usage?: Record<string, unknown> };
    const m = j.choices?.[0]?.message;
    this.downUntil = 0;
    return { content: m?.content ?? '', reasoning: m?.reasoning_content ?? m?.reasoning ?? null, usage: j.usage, latency_ms: Date.now() - t0, model };
  }

  /** Raw completion without the shared lock (read-only w.r.t. the table). */
  async completeRaw(prompt: string, maxTokens = 8, timeoutMs = 300_000): Promise<string> { return this.complete(prompt, maxTokens, timeoutMs); }

  private py(args: string[], timeoutMs = 600_000): Promise<{ code: number; out: string; err: string }> {
    return new Promise((resolve) => {
      const repo = this.repo;
      if (!repo) return resolve({ code: 127, out: '', err: 'runtime repo not configured' });
      const p = spawn(this.cfg.python ?? 'python3', args, { cwd: repo, env: { ...process.env, ENGRAM_API: this.cfg.api ?? '' } });
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

  /** Cheap liveness probe: a 1-token completion must return within `timeoutMs`. */
  async probe(timeoutMs = 45_000): Promise<boolean> {
    try { await this.complete('Q: 1+1=\nA:', 1, timeoutMs); return true; } catch { return false; }
  }

  async complete(prompt: string, maxTokens = 8, timeoutMs = 300_000): Promise<string> {
    const model = await this.models();
    if (!model || !this.cfg.api) throw new Error('serving API unreachable');
    let r: Response;
    try {
      r = await fetch(`${this.cfg.api}/v1/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, prompt, max_tokens: maxTokens, temperature: 0 }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) { throw this.markDown(`completion: ${(e as Error).message}`); }
    if (!r.ok) {
      if (Runtime.isModelFailure(r.status)) throw this.markDown(`completion failed: ${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`);
      throw new Error(`completion failed: ${r.status}`);
    }
    const j = (await r.json()) as { choices: { text: string }[] };
    this.downUntil = 0;
    return j.choices?.[0]?.text ?? '';
  }

  /**
   * Restart-aware verification (청구항 2): apply → score samples in chunks, re-checking a sample row
   * between chunks; if the table reverted (serving restart) re-apply and re-measure the chunk; restore.
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
          const got = (await this.complete(s.prompt)).trim();
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
            const got = (await this.complete(s.prompt)).trim();
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
