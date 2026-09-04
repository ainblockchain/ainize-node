/**
 * Teach mode (spec §8): a visitor's corrections → a training job → a knowledge file → a private draft → publish.
 *
 *   QUEUED ─► PREFLIGHT ─► TRAINING ─► EXPORTED ─► CHECKING ─► READY ─► (save | publish)
 *      │          │            │                        │          └► NEEDS_MORE (taught hits < 75 %; draft kept, publish off)
 *      │          │            └► FAILED (trainer error / timeout)
 *      │          └► back to QUEUED with jitter on 'shared runtime busy'
 *      └► CANCELLED                       READY without save/publish ─► EXPIRED after draftTtlDays
 *   publish: READY ─► PENDING_REVIEW ─► (approve) ANNOUNCED ─► existing VERIFYING ─► LISTED | REJECTED
 *
 * Training never touches the serving model: the gradient backend runs `train/teach.py` inside the trainer container
 * (docker exec, stdout JSON-lines protocol §8.2) under a trainer-slot lease; the stub backend copies a fixture npz
 * (CI / e2e / dev nodes without spare GPUs). Only PREFLIGHT and CHECKING touch the serving model, each bounded by
 * `Runtime.exclusiveTry` (≤ 2 min wait, requeue instead of joining the long queue).
 */
import { spawn as nodeSpawn, execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants as fsConstants, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { accessOf, accessRank, capBenchmarkSamples, deltaOnlyParent, deriveRowsPerJob, ETA_MIN_SAMPLES as CORE_ETA_MIN_SAMPLES, hashCanonical, isDatasetLicense, licenseCompatible, percentileOf, preStateSha256, readNpzMember, sha256Hex, validateContributors, verifyMessage, writeNpz,
  type BenchmarkSample, type CatalogEntry, type Contributor, type DatasetAccess, type PatchAnchor, type TeachConfig, type TeachDatasetRef, type TeachDatasetSource, type TeachEffort, type TeachTrainingSpec } from '@ngram/core';
import { sha256File } from './blobs.js';
import { decodeBenchmarkJsonl, encodeBenchmarkJsonl, publishedRows, type DatasetBlobStore } from './dataset-blobs.js';
import { MODEL_UNAVAILABLE, RuntimeUnavailableError } from './runtime.js';
import { TREE_MAX_DEPTH, type Caller, type Market } from './market.js';
import type { Store, TeachDatasetRecord, TeachFactRow, TeachJobRow } from './store.js';
import { TeachError } from './teach-error.js';
import { TeachDatasets, type DatasetView } from './teach-datasets.js';
import { canonicalBytes, endingKey, readCanonicalJsonl, rowRefIndex, rowRefPatch, type CanonicalRow } from './teach-dataset.js';
import { anchorRecipe, buildRecipeJson, lessonBenchmark, LOCAL_RUN_REPO_URL, renderRunLocally, type LessonMeta, type TrainerRecipe } from './teach-recipe.js';

// ------------------------------------------------------------------ public types (spec §6.5)
export type TeachStatus = 'QUEUED' | 'PREFLIGHT' | 'LOADING' | 'TRAINING' | 'EXPORTED' | 'CHECKING' | 'READY' | 'NEEDS_MORE'
  | 'FAILED' | 'CANCELLED' | 'PENDING_REVIEW' | 'REJECTED' | 'ANNOUNCED' | 'EXPIRED';

export interface TeachFact { prompt: string; answer: string; alt_prompt?: string; base_answer?: string; after_answer?: string; hit?: boolean; heldout_hit?: boolean;
  /** Set when this question replaces an inherited answer (`'<base>#<row index>'`) — SC-5 "Changed", SC-7 "changes k". */
  replaces?: string }
export interface TeachProgress {
  step: number; max_steps: number; loss?: number; hits: number; total: number; load_s?: number; avg_step_s?: number; started_at?: number;
  /** Which stage the rail is on. The big bar is always the real `step / max_steps` inside `train` — never a computed percent. */
  phase?: 'load' | 'train' | 'check';
  /**
   * Stage-weighted (load 10 % / train 75 % / check 15 %) and clamped monotonic, for compact surfaces only. It is NOT a
   * time estimate and no surface may label it as one.
   */
  percent?: number;
  rows_total?: number; rows_touched?: number;
  /** How many questions the trainer actually probed at the last evaluation, of how many trained. */
  eval_sample?: { n: number; of: number };
  elapsed_s?: number;
}
export interface TeachChecks {
  /** false when the serving model stayed unavailable for the whole grace period — nothing was measured, publish stays gated. */
  executed: boolean;
  /** `sampled` is present when the dataset was too big to check whole — the copy must never make a whole-dataset claim. */
  taught: { hits: number; total: number; sampled?: { checked: number; of: number } };
  heldout: { hits: number; total: number };
  parent_regression: { ok: boolean; hit: number; total: number };
  /**
   * `total` counts only the prompts the model answers the SAME WAY TWICE with nothing applied — a prompt whose own
   * baseline is not repeatable measures the serving engine's batching noise, not the lesson, and must not gate a
   * publish. `unstable` is how many were dropped for that reason (reported so nobody reads `total` as the whole list).
   */
  locality: { ok: boolean; same: number; total: number; unstable?: number };
  reverted_and_reapplied: boolean;
  /** Hard publish gate: locality.ok && parent_regression.ok (&& executed). */
  ok: boolean;
  note?: string;
  /** true on a stub node without a model server: the numbers above were simulated, nothing was measured (UI: "Demo node — checks are simulated"). */
  simulated?: boolean;
  /** The visitor turned the side-effect check off. Publish stays gated until `POST /:id/recheck` measures it. */
  skipped?: true;
  /**
   * Lineage (design §7.6): per knowledge in the stack, IN DEPLOYMENT ORDER (bases first, comparison loads after),
   * its own benchmark questions re-asked with the lesson ON TOP. `parent_regression` above is the sum.
   */
  parent_check?: {
    patch_id: string; hit: number; total: number; failed: number[]; simulated?: boolean;
    /** §7.6 step 3 — the same questions asked with the base loaded and the lesson NOT on top yet. */
    base_hit?: number; base_total?: number;
    /** Questions the BASE itself does not answer on this node: left out of `total`, so the child is not blamed for them. */
    base_failed?: number[];
    /** Questions this lesson deliberately replaces (`replaces`): a different answer here is the point, not a regression. */
    overridden?: number;
  }[];
  /** null until the runtime journal (L2) can measure it: "removing the lesson leaves the base exactly as it was". */
  reversibility_ok?: boolean | null;
}
/** One knowledge the lesson was trained on top of (design §5.3): the ordered stack, ancestors first. */
export interface TeachBaseView { patch_id: string; sha256: string; name?: string; status?: string }
interface BaseTarget { id: string; entry: CatalogEntry; path: string; sha256: string; datasetSha256?: string; datasetRows?: number;
  /** The base's own questions, in ITS order — the index is what a `from` / `replaces` pointer names. */
  rows?: CanonicalRow[] }
/** `POST /api/teach/jobs/:id/publish` body (design §12.1): the v1 fields plus the training-set section. */
export interface PublishBody {
  name: string; description?: string; price?: string; license?: string; payout_address?: string | null; claim_sig: string;
  consent: { permanent: boolean; rights: boolean }; contributor?: { name?: string };
  dataset?: { access?: DatasetAccess; license?: string; include_notes?: boolean; declaration?: { source: 'own' | 'public' | 'licensed'; license?: string; no_pii: boolean } | null };
}
interface DatasetPublication { access: DatasetAccess; license: string; include_notes: boolean; declaration: { source: 'own' | 'public' | 'licensed'; license?: string; no_pii: boolean } | null; forced_private: string | null; pii: number[] }
export interface TeachJob {
  id: string;
  status: TeachStatus;
  contributor: { address: string; name?: string };
  context_patch_ids: string[];
  builds_on_context: boolean;
  facts: TeachFact[];
  name?: string;
  position?: number;
  eta_s?: number | null;
  /** Why a QUEUED / EXPORTED job is not moving: 'slot' (trainer busy), 'lock' (model server busy), 'runtime' (model server down), 'container'. */
  blocked?: string | null;
  progress?: TeachProgress;
  checks?: TeachChecks;
  result?: { sha256: string; rows: number; size_bytes: number };
  draft_id?: string; patch_id?: string;
  publish_status: 'none' | 'pending_review' | 'rejected' | 'announced' | 'listed';
  reject_reason?: string; error?: string; parent_job?: string;
  /** What this lesson was trained from. A v1 job renders `{id: null, source: 'derived', rows: facts.length}`. */
  dataset?: TeachDatasetRef;
  /**
   * The worker's own pass over the questions before training: `known` of them were dropped because the model already
   * answered them correctly. Without this the result screen shows a lesson of 16 questions for a 40-question dataset
   * and never says where the other 24 went.
   */
  preflight?: { checked: number; of: number; known: number; overlaps?: number };
  training?: TeachTrainingSpec;
  /** Lineage (design §12.1): the ordered base stack, how the job was made, what the trainer was asked to export. */
  bases?: TeachBaseView[];
  mode?: 'scratch' | 'extend' | 'fork' | 'merge';
  /** How many of the base's questions this lesson keeps (trained as known answers) and how many of its answers it changes. */
  inherited_rows?: number;
  changed_rows?: number;
  export?: 'delta' | 'squash';
  derivation?: Record<string, unknown>;
  /** The training-set choices made at publish (access, licence, notes, declaration) and the sha of the published copy. */
  dataset_pub?: { access: string; license: string; include_notes: boolean; declaration: Record<string, unknown> | null; published_sha256: string };
  created_at: number; updated_at: number; started_at?: number; finished_at?: number; expires_at?: number;
}
export type TeachJobPublic = Pick<TeachJob, 'id' | 'status' | 'position' | 'eta_s'>;

export interface TeachPolicyView {
  enabled: boolean;
  publish: 'review' | 'auto' | 'never';
  trainer: 'ready' | 'busy' | 'paused';
  paused_reason?: string;
  backend: 'gradient' | 'stub';
  queue: { depth: number; max: number; position_eta_s?: number | null; queued_rows: number; queued_rows_max: number };
  limits: {
    facts_per_job: number; jobs_per_key_per_day: number; jobs_per_ip_per_day: number; prompt_max: number; answer_max: number;
    dataset_max_bytes: number; dataset_max_rows: number; dataset_max_source_lines: number;
    rows_per_job: number; rows_per_job_source: 'default' | 'measured' | 'operator';
    rows_per_key_per_day: number; rows_per_ip_per_day: number; datasets_per_key_per_day: number; dataset_ttl_days: number;
    formats: string[]; declaration_rows: number;
  };
  /** Every field is null until ≥ 3 lessons were measured with `backend: 'gradient'`; a stub node reports `simulated`. */
  timing: { p50_s: number | null; p90_s: number | null; samples: number; backend: 'gradient' | 'stub'; simulated: boolean; load_s_p50: number | null; s_per_row_p50: number | null; s_per_row_p90: number | null };
  effort: { id: TeachEffort; max_steps: number; eval_every: number }[];
  samples: { kind: string; name: string; rows: number }[];
  shares: { contributor: number; lineage: number };
  model: { id_M: string | null };
  applied: string[];
  draft_ttl_days: number;
  /** true when this node's checks are simulated (stub backend without a model server) — the UI must not claim a live-model verification. */
  simulated_checks: boolean;
  /** Feature flag `teach.lineage` (design §18): base selection ("Build on this", `--on`) is offered only while true. */
  lineage: boolean;
}

export { TeachError };

export const PROMPT_MAX = 400;
export const ANSWER_MAX = 200;
const TAUGHT_MIN_RATIO = 0.75;
const DEFAULT_RUNTIME_GRACE_MS = 15 * 60_000;
const SLOT_STALE_MS = 45 * 60_000;
const DEFAULT_RETRY_MS = 15_000;
const BLOCKED_LOG_MS = 5 * 60_000;
/** Error message that means "the node is shutting down" — the job is requeued, never FAILED. */
const STOPPING = 'node stopping';
const DEFAULT_FIXTURE = '/mnt/newdata/qwen3.8/results/train-fact/픽셀플러스.npz';
const POLICY_CALLS_PER_MIN = 30;
/** Lessons one teaching key may have in flight (QUEUED…CHECKING) at once — quota must not rest on the IP alone (security review). */
export const ACTIVE_JOBS_PER_KEY = 2;
/** Model calls one interactive preflight may spend per live-test quota unit (8 facts + 3 context blobs used to cost one unit). */
const PREFLIGHT_CALLS_PER_UNIT = 3;
/** Minimum measured lessons before any duration is projected to visitors (spec §8.4). */
export const ETA_MIN_SAMPLES = CORE_ETA_MIN_SAMPLES;
/** Statuses that mean a lesson is in flight — a dataset they read must not be edited or deleted under them. */
export const ACTIVE_JOB_STATUSES = ['QUEUED', 'PREFLIGHT', 'LOADING', 'TRAINING', 'EXPORTED', 'CHECKING'];
/** kv flag: the trainer answered with a `sampled` eval, so it understands `eval_sample` and `facts_file` (design §16). */
const TRAINER_SAMPLING_KEY = 'teach:trainer:eval_sample';
/** Stage weights for the additional `progress.percent` (design §D5). */
const PHASE_WEIGHT = { load: 0.10, train: 0.75, check: 0.15 };
/**
 * Display names are public ("Taught by …"): no links/markup, no ASCII or Unicode control / bidi / zero-width characters
 * (an RTL override would render "Op‮erator" on chips, teacher pages and the immutable public record) and a minimal slur
 * list (spec §9.1; operators can hide names).
 */
const NAME_BLOCKLIST = /https?:\/\/|www\.|[<>{}\[\]]|[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]|\b(fuck|shit|bitch|cunt|nigg|fag)|씨발|시발|병신|개새끼|좆|niga/i;
/** NFKC-normalise and collapse whitespace — what is stored and shown. */
export function normalizeDisplayName(name: string | undefined): string | undefined {
  const n = name?.normalize('NFKC').replace(/\s+/g, ' ').trim();
  return n ? n : undefined;
}
export function checkDisplayName(name: string | undefined): string | null {
  const raw = name?.trim() ?? '';
  if (!raw) return null;
  if (NAME_BLOCKLIST.test(raw)) return 'display name contains a link, markup, an invisible character or a blocked word';
  const n = normalizeDisplayName(raw) ?? '';
  if (n.length > 40) return 'display name must be at most 40 characters';
  if (NAME_BLOCKLIST.test(n)) return 'display name contains a link, markup, an invisible character or a blocked word';
  return null;
}
/** Which address a contributor entry credits publicly: a declared payout wallet is NOT the teacher — the signer is (security review §9.1). */
export function creditedAddress(c: Contributor): string { return c.proof === 'declared' && c.signer ? c.signer : c.address; }

// ------------------------------------------------------------------ process hooks (faked in tests)
export interface ChildLike {
  pid?: number;
  stdout: Readable | null;
  stderr: Readable | null;
  on(event: 'close', cb: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}
export type SpawnFn = (cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv }) => ChildLike;
export type ExecFn = (cmd: string, args: string[], timeoutMs: number) => Promise<{ code: number; out: string; err: string }>;
export interface TeachHooks {
  spawn?: SpawnFn;
  exec?: ExecFn;
  /** Worker tick interval (default 2 s). */
  intervalMs?: number;
  /** Stub backend: pause between simulated steps (default 400 ms) so state transitions are observable. */
  stubDelayMs?: number;
  /** Stub backend fixture (default: the real 픽셀플러스 lesson from the qwen3.8 repo when it exists). */
  fixtureNpz?: string;
  /** How long CHECKING waits for a down model server before the lesson is saved unchecked (default 15 min, like the verifier). */
  runtimeGraceMs?: number;
  /** Retry interval for jobs blocked on the model server / shared lock (default 15 s). */
  retryMs?: number;
}

const defaultExec: ExecFn = (cmd, args, timeoutMs) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
    const code = err ? ((err as NodeJS.ErrnoException & { code?: number | string }).code as number | undefined) : 0;
    resolve({ code: typeof code === 'number' ? code : err ? 127 : 0, out: String(stdout ?? '').trim(), err: String(stderr ?? err?.message ?? '').trim() });
  });
});

// ------------------------------------------------------------------ helpers
/**
 * Compare two answers for "is this string in there". Whitespace is dropped, and so is the markdown an instruct model
 * wraps a fact in: `**005930**입니다.` and `005930입니다.` are the same answer, and a checker that says otherwise
 * reports a lesson as "not learned" (and a preflight as "not known") whenever the model chose to bold the number —
 * which is most of the time. Zero-width characters are stripped for the same reason.
 */
export const normAnswer = (s: string) => s.normalize('NFKC').replace(/[\s*_`~\u200b-\u200f\u2060\ufeff]+/g, '').toLowerCase();
export function slugify(s: string): string {
  const base = s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24).replace(/-+$/g, '');
  return base.length >= 2 ? base : 'lesson';
}
const dayKey = (now: number) => new Date(now).toISOString().slice(0, 10);
const clampInt = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(v)));
/** Deterministic 32-bit hash — the sampling order must be identical for the same `(dataset sha256, revision)`. */
function seededOrder(seed: string, n: number): number[] {
  const idx = [...Array(n).keys()];
  const score = idx.map((i) => { const h = createHash('sha256').update(`${seed}:${i}`).digest(); return h.readUInt32BE(0); });
  return idx.sort((a, b) => score[a] - score[b] || a - b);
}

interface PreflightFactResult {
  index: number;
  /** `in_base` / `base_conflict` only appear when a base was chosen (design §12.1, SC-6). */
  status: 'will_train' | 'already_known' | 'overlaps_listing' | 'invalid' | 'in_base' | 'base_conflict';
  base_answer?: string; detail?: string;
  /** Which knowledge already answers it / answers it differently. */
  base_id?: string;
}

// ------------------------------------------------------------------ the worker
export class TeachWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  /** Job currently in flight in this process. */
  private current: string | null = null;
  private child: ChildLike | null = null;
  private lastBlockedLog = 0;
  private lastBlockedReason: string | null = null;
  private trainerCache: { at: number; value: { state: 'ready' | 'busy' | 'paused'; reason?: string } } | null = null;
  private policyCache: { at: number; value: TeachPolicyView } | null = null;
  private policyHits = new Map<string, { count: number; window: number }>();
  private checkWaitSince = new Map<string, number>();
  /** Jobs whose lesson may still be on the shared table (crash mid-CHECKING); restored at start or as soon as the model server answers. */
  private pendingRestore = new Set<string>();
  private lastReconcile = 0;
  private lastDatasetSweep = 0;
  private readonly spawnFn: SpawnFn;
  private readonly execFn: ExecFn;

  /** Datasets: the durable artifact every lesson is trained from (teach mode v2). */
  readonly datasets: TeachDatasets;

  constructor(readonly market: Market, private readonly hooks: TeachHooks = {}) {
    this.spawnFn = hooks.spawn ?? ((cmd, args, opts) => nodeSpawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] }) as unknown as ChildLike);
    this.execFn = hooks.exec ?? defaultExec;
    this.datasets = new TeachDatasets({
      store: market.store, dataDir: market.cfg.dataDir, cfg: () => this.cfg,
      log: (level, message, data) => this.log(level, message, (data?.job_id as string) ?? null, data),
      activeJobStatuses: ACTIVE_JOB_STATUSES,
    });
  }

  get store(): Store { return this.market.store; }
  private get graceMs(): number { return this.hooks.runtimeGraceMs ?? DEFAULT_RUNTIME_GRACE_MS; }
  private get retryMs(): number { return this.hooks.retryMs ?? DEFAULT_RETRY_MS; }
  /** Effective policy (config.json `teach` + operator overrides in kv). */
  get cfg() { return this.market.teach(); }
  private log(level: 'info' | 'warn' | 'error', message: string, jobId: string | null = null, data: unknown = null) {
    this.market.log(level, 'teach', message, null, jobId ? { job_id: jobId, ...(data && typeof data === 'object' ? (data as object) : {}) } : data);
  }

  // ------------------------------------------------------------ lifecycle
  start() {
    if (this.timer) return;
    this.recoverAfterRestart();
    const tick = () => { this.tick().catch((e) => this.log('warn', `worker tick failed: ${(e as Error).message}`)); };
    this.timer = setInterval(tick, this.hooks.intervalMs ?? 2000);
    this.timer.unref?.();
    setTimeout(tick, 300).unref?.();
  }
  /**
   * Graceful stop (SIGTERM / `ainize stop`): `stopped` is set BEFORE the trainer client is killed so the exit is mapped to
   * "node stopping" → the job goes back to QUEUED (requeued, not FAILED — spec §8.5); the in-container process is terminated;
   * a running CHECKING aborts at its next model call and its `finally` removes the lesson from the shared table. We wait for
   * that (≤ 90 s: one model call budget + apply/remove) instead of exiting after 10 s with the lesson still applied.
   */
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopped = true;
    const cur = this.current ? this.store.getTeachJob(this.current) : null;
    if (this.child) { try { this.child.kill('SIGTERM'); } catch { /* ignore */ } }
    if (cur) await this.killStray(cur).catch(() => undefined);
    for (let i = 0; i < 1800 && this.running; i++) await new Promise((r) => setTimeout(r, 50));
    if (this.running) this.log('error', 'stop timed out while a teach step was still running — the lesson is restored at the next start (lesson_applied)', cur?.id ?? null);
  }

  /**
   * Jobs left mid-flight by a crashed/restarted node (spec §8.5): PREFLIGHT/TRAINING are requeued once, then
   * FAILED('node restarted'); CHECKING goes back to EXPORTED *after* the shared table is restored (the lesson may still be
   * applied — nothing else would ever remove it, and a later cancel would delete the only file that can).
   */
  private recoverAfterRestart() {
    for (const j of this.store.listTeachJobs({ status: ['PREFLIGHT', 'TRAINING', 'LOADING', 'CHECKING'] })) {
      if (j.status === 'CHECKING') {
        this.pendingRestore.add(j.id);
        if (!j.lesson_applied) this.store.updateTeachJob(j.id, { lesson_applied: true });
        this.log('warn', `job ${j.id} was CHECKING when the node restarted → restoring the shared table, then re-check`, j.id);
        continue;
      }
      const key = `teach:restarts:${j.id}`;
      if (this.store.get(key)) { this.finish(j.id, 'FAILED', { error: 'node restarted during training' }); continue; }
      this.store.set(key, '1');
      this.killStray(j).catch(() => undefined);
      if (j.status === 'PREFLIGHT') this.pendingRestore.add(j.id);   // context blobs may have been left applied by withStack
      this.store.updateTeachJob(j.id, { status: 'QUEUED', blocked: null, progress: null, container_pid: null, started_at: null });
      this.log('warn', `job ${j.id} was ${j.status} when the node restarted → requeued once`, j.id);
    }
    // any other row still flagged (crash after the status flip, or a stop() that timed out)
    for (const j of this.store.listTeachJobs({ lessonApplied: true })) if (!this.pendingRestore.has(j.id)) this.pendingRestore.add(j.id);
  }

  /**
   * Put the shared table back after an interrupted PREFLIGHT/CHECKING: remove the lesson (if it is still on the table),
   * re-assert the operator-pinned set, clear `lesson_applied`, and move a CHECKING job to EXPORTED so it is re-checked.
   * Needs the model server; until it answers the job stays flagged and `tick()` retries.
   */
  private async restoreTable(): Promise<void> {
    if (!this.pendingRestore.size) return;
    const rt = this.market.runtime;
    const st = await rt.status(true).catch(() => ({ available: false, error: 'status failed' } as { available: boolean; error?: string }));
    if (!st.available) return;   // retried on the next tick; a serving restart also resets the table
    for (const id of [...this.pendingRestore]) {
      const j = this.store.getTeachJob(id);
      if (!j) { this.pendingRestore.delete(id); continue; }
      try {
        await rt.exclusiveTry(`teach:${id}:restore`, async () => {
          if (j.npz_path && existsSync(j.npz_path) && (await rt.isApplied(j.npz_path)) !== false) await rt.removeRaw(j.npz_path, { journal: j.sha256 ? rt.journalPath(j.sha256) ?? undefined : undefined });
          for (const cid of j.context) { const e = await this.market.entry(cid); const b = e && this.market.blobs.get(e.anchor.patch_sha256); if (b && !this.market.isApplied(cid)) await rt.removeRaw(b.path).catch(() => undefined); }
          await this.reassertPinned();
        }, { waitMs: 30_000 });
      } catch (e) { this.log('warn', `could not restore the shared table yet (${(e as Error).message}) — retrying`, id); continue; }
      this.store.updateTeachJob(id, { lesson_applied: false, ...(j.status === 'CHECKING' ? { status: 'EXPORTED', blocked: null } : {}) });
      this.pendingRestore.delete(id);
      this.log('info', `shared table restored after the interrupted ${j.status.toLowerCase()} of ${id}`, id);
    }
  }

  // ------------------------------------------------------------ policy / trainer state
  async trainerState(force = false): Promise<{ state: 'ready' | 'busy' | 'paused'; reason?: string }> {
    const c = this.cfg;
    if (c.pausedReason) return { state: 'paused', reason: c.pausedReason };
    if (c.backend === 'stub') return { state: this.current ? 'busy' : 'ready' };
    if (!force && this.trainerCache && Date.now() - this.trainerCache.at < 30_000) return this.trainerCache.value;
    let value: { state: 'ready' | 'busy' | 'paused'; reason?: string };
    if (!this.market.runtime.repo) value = { state: 'paused', reason: 'runtime repo is not configured on this node' };
    else {
      const r = await this.execFn('docker', ['inspect', '-f', '{{.State.Running}}', c.trainer.container], 10_000).catch(() => ({ code: 127, out: '', err: 'docker unavailable' }));
      if (r.code !== 0) value = { state: 'paused', reason: r.err.includes('ENOENT') || r.code === 127 ? 'docker is not available to the node' : `trainer container ${c.trainer.container} is not running` };
      else if (r.out.trim() !== 'true') value = { state: 'paused', reason: `trainer container ${c.trainer.container} is not running` };
      else value = { state: this.current || this.lastBlockedReason ? 'busy' : 'ready' };
    }
    this.trainerCache = { at: Date.now(), value };
    return value;
  }

  /**
   * Public policy (spec §6.2 `GET /api/teach/policy`), cached 10 s. Per-IP rate limit: `POLICY_CALLS_PER_MIN` (spec §12 says
   * 30/h; a per-minute window keeps NAT'd offices and the 5-s lesson poll usable while still stopping scrapers).
   */
  async policy(ip?: string): Promise<TeachPolicyView> {
    if (ip) {
      const now = Date.now();
      if (this.policyHits.size > 5000) for (const [k, v] of this.policyHits) if (now - v.window > 60_000) this.policyHits.delete(k);
      const u = this.policyHits.get(ip);
      const cur = u && now - u.window < 60_000 ? u : { count: 0, window: now };
      cur.count++; this.policyHits.set(ip, cur);
      if (cur.count > POLICY_CALLS_PER_MIN) throw new TeachError(429, 'rate_limited: too many policy calls from this address');
    }
    if (this.policyCache && Date.now() - this.policyCache.at < 10_000) return this.policyCache.value;
    const c = this.cfg;
    const tr = await this.trainerState();
    const queued = this.store.listTeachJobs({ status: ACTIVE_JOB_STATUSES });
    // design §D7: only `backend = 'gradient'` samples may drive a visitor-facing number. On a stub node this list is
    // empty by construction, so `timing` is all-null and `simulated` is true — three-second stub jobs never become an ETA.
    const gradient = this.store.teachStats(50, 'gradient');
    const stats = gradient.map((s) => s.total_s);
    const p50 = percentileOf(stats, 0.5);
    const enough = stats.length >= ETA_MIN_SAMPLES;
    const rows = this.rowsPerJob();
    const st = await this.market.runtime.status();
    const queuedRows = queued.reduce((n, j) => n + (j.dataset_rows ?? j.facts.length), 0);
    const value: TeachPolicyView = {
      enabled: c.enabled, publish: c.publish, trainer: tr.state, ...(tr.reason ? { paused_reason: tr.reason } : {}), backend: c.backend,
      queue: {
        depth: queued.length, max: c.queueMax,
        // rows-weighted, not position-weighted: an 8-question job behind a 1000-question job is not "one lesson away"
        position_eta_s: enough && p50 !== null ? Math.round((queued.length + 1) * p50) : null,
        queued_rows: queuedRows, queued_rows_max: c.queuedRowsMax,
      },
      limits: {
        facts_per_job: c.factsPerJob, jobs_per_key_per_day: c.jobsPerKeyPerDay, jobs_per_ip_per_day: c.jobsPerIpPerDay, prompt_max: PROMPT_MAX, answer_max: ANSWER_MAX,
        dataset_max_bytes: c.dataset.maxBytes, dataset_max_rows: c.dataset.maxRows, dataset_max_source_lines: c.dataset.maxSourceLines,
        rows_per_job: rows.rows, rows_per_job_source: rows.source,
        rows_per_key_per_day: c.dataset.rowsPerKeyPerDay, rows_per_ip_per_day: c.dataset.rowsPerIpPerDay,
        datasets_per_key_per_day: c.dataset.perKeyPerDay, dataset_ttl_days: c.dataset.ttlDays,
        formats: ['jsonl', 'json', 'csv', 'tsv', 'txt'], declaration_rows: c.dataset.declarationRows,
      },
      timing: {
        p50_s: enough ? p50 : null, p90_s: enough ? percentileOf(stats, 0.9) : null, samples: stats.length,
        backend: 'gradient', simulated: c.backend === 'stub',
        load_s_p50: enough ? rows.load_s_p50 : null, s_per_row_p50: enough ? rows.s_per_row_p50 : null, s_per_row_p90: enough ? rows.s_per_row_p90 : null,
      },
      effort: (['quick', 'balanced', 'thorough'] as TeachEffort[]).map((id) => ({ id, max_steps: c.effort[id].maxSteps, eval_every: c.effort[id].evalEvery })),
      samples: this.datasets.samples().map((x) => ({ kind: x.kind, name: x.name, rows: x.rows })),
      shares: { contributor: c.contributorShare, lineage: this.market.cfg.market.royaltyShare },
      model: { id_M: st.model }, applied: this.market.pinnedPatchIds(), draft_ttl_days: c.draftTtlDays, simulated_checks: this.offline, lineage: !!c.lineage,
    };
    this.policyCache = { at: Date.now(), value };
    return value;
  }

  /**
   * How many questions one lesson may train here (design §D1). Derived from measured gradient runs and bounded by
   * `trainer.timeoutMs`, so a legal dataset can never become a job that is always killed at the timeout; the floor is
   * used until the fit exists AND the trainer has shown it evaluates a sample (design §16).
   */
  rowsPerJob(effort: TeachEffort = 'balanced') {
    const c = this.cfg;
    return deriveRowsPerJob(c, this.store.teachStats(50, 'gradient'), {
      effort,
      override: (c as { rowsPerJobOverride?: number }).rowsPerJobOverride ?? null,
      trainerSupportsSampling: this.store.get(TRAINER_SAMPLING_KEY) === '1',
    });
  }
  invalidatePolicy() { this.policyCache = null; this.trainerCache = null; }

  // ------------------------------------------------------------ gates used by every visitor route
  assertEnabled() { if (!this.cfg.enabled) throw new TeachError(403, 'teaching_disabled: this node does not accept lessons'); }
  assertNotBanned(address: string | null, ip: string | undefined) {
    if (address && this.store.isBanned('address', address)) throw new TeachError(403, 'banned: this node is not accepting lessons from this key');
    if (ip && this.store.isBanned('ip', ip)) throw new TeachError(403, 'banned: this node is not accepting lessons from this address');
  }
  /** Stub backend that must never touch the serving model (CI / e2e nodes, spec §12 `backend: 'stub'`). */
  private get offline(): boolean { return this.cfg.backend === 'stub' && !!this.cfg.stubOffline; }
  /** Offline stub "model": a prompt that already contains the answer is known; everything else is unknown. Deterministic, so e2e can script both preflight outcomes. */
  private stubAnswer(prompt: string, answer: string): string {
    return normAnswer(prompt).includes(normAnswer(answer)) ? answer : `(stub model) I do not know: ${prompt.slice(0, 80)}`;
  }
  quota(address: string, ip: string | undefined, now = Date.now()): { key_remaining: number; ip_remaining: number } {
    const c = this.cfg; const day = dayKey(now);
    return {
      key_remaining: Math.max(0, c.jobsPerKeyPerDay - this.store.teachQuotaCount(`addr:${address.toLowerCase()}`, day)),
      ip_remaining: ip ? Math.max(0, c.jobsPerIpPerDay - this.store.teachQuotaCount(`ip:${ip}`, day)) : c.jobsPerIpPerDay,
    };
  }
  /** What a lesson costs: the v1 job caps plus the v2 question caps (a big dataset must exhaust rows before jobs). */
  jobQuota(address: string, ip: string | undefined, now = Date.now()): { key_remaining: number; ip_remaining: number; rows_remaining: number; rows_ip_remaining: number } {
    const dq = this.datasets.quota(address, ip, now);
    return { ...this.quota(address, ip, now), rows_remaining: dq.rows_remaining, rows_ip_remaining: dq.rows_ip_remaining };
  }

  // ------------------------------------------------------------ fact validation / overlap
  private staticFactCheck(f: { prompt: string; answer: string; alt_prompt?: string }): string | null {
    const c = this.cfg;
    if (!f.prompt?.trim() || f.prompt.length > PROMPT_MAX) return `prompt must be 1..${PROMPT_MAX} characters`;
    if (!f.answer?.trim() || f.answer.length > ANSWER_MAX) return `answer must be 1..${ANSWER_MAX} characters`;
    if (/[\r\n]/.test(f.answer)) return 'answer must be a single line';
    if (f.alt_prompt && f.alt_prompt.length > PROMPT_MAX) return `alt_prompt must be at most ${PROMPT_MAX} characters`;
    if (c.blockedTopics) {
      try { const re = new RegExp(c.blockedTopics, 'i'); if (re.test(f.prompt) || re.test(f.answer) || (f.alt_prompt && re.test(f.alt_prompt))) return 'this topic is blocked by the node operator'; } catch { /* bad regex → ignore */ }
    }
    return null;
  }
  /** Overlap-by-prompt: the fact repeats a benchmark sample of knowledge already sold/announced on this node (spec §12). */
  private async overlapsListing(f: { prompt: string; answer: string }): Promise<CatalogEntry | null> {
    const p = normAnswer(f.prompt.replace(/^q:/i, '')); const a = normAnswer(f.answer);
    if (p.length < 4) return null;
    for (const e of await this.market.catalog()) {
      if (!['LISTED', 'VERIFYING', 'ANNOUNCED'].includes(e.status)) continue;
      for (const s of e.anchor.benchmark.samples ?? []) {
        const sp = normAnswer(s.prompt.replace(/^q:/i, '').replace(/a:$/i, ''));
        if ((sp.includes(p) || p.includes(sp)) && normAnswer(s.expect) === a) return e;
      }
    }
    return null;
  }

  // ------------------------------------------------------------ interactive preflight (spec §6.2 POST /api/teach/preflight)
  /** Live-test quota units one preflight costs: one per ${PREFLIGHT_CALLS_PER_UNIT} model calls (facts + context blobs to apply), at least one. */
  preflightUnits(input: { patchIds: string[]; facts: unknown[] }): number {
    return Math.max(1, Math.ceil((input.facts.length + new Set(input.patchIds).size) / PREFLIGHT_CALLS_PER_UNIT));
  }

  /**
   * Resolve `{dataset_id, offset?, limit?}` to the questions a preflight call should probe: at most `preflight.perCall`
   * per call, and never more than `preflight.sampleRows` of a dataset per job (the visitor is told what was sampled).
   */
  preflightSlice(dataset: TeachDatasetRecord, offset = 0, limit?: number): { facts: { prompt: string; answer: string; alt_prompt?: string }[]; sampled: { checked: number; of: number }; offset: number } {
    const rows = this.datasets.rows(dataset);
    const c = this.cfg.preflight;
    const start = Math.max(0, Math.min(offset, Math.max(0, rows.length - 1)));
    const take = Math.min(limit ?? c.perCall, c.perCall, Math.max(0, c.sampleRows - start));
    const slice = rows.slice(start, start + take);
    return { facts: slice.map((r) => ({ prompt: r.prompt, answer: r.answer, ...(r.alt_prompt ? { alt_prompt: r.alt_prompt } : {}) })), sampled: { checked: Math.min(rows.length, start + slice.length), of: rows.length }, offset: start };
  }

  /**
   * What would happen to each of these questions, measured before anything is trained (design §12.1, SC-6).
   *
   * With a base chosen, the probe runs with the BASE LOADED, which is the only honest place to ask "does this need
   * teaching at all": `in_base` = the base already answers it the same way (dropped, and counted for the base as
   * coverage), `base_conflict` = the base answers this question differently and this row would replace its answer,
   * `will_train` = neither. The base's own training set decides a conflict — the model's answer alone cannot tell
   * "it says something else" from "it does not know".
   */
  async preflight(input: { address: string; ip?: string; patchIds: string[]; baseIds?: string[]; facts: { prompt: string; answer: string; alt_prompt?: string }[]; sampled?: { checked: number; of: number } }): Promise<{ facts: PreflightFactResult[]; trainable: number; quota: { key_remaining: number; ip_remaining: number }; bases?: string[]; sampled?: { checked: number; of: number } }> {
    const caller: Caller = { address: input.address };
    const out: PreflightFactResult[] = [];
    const todo: number[] = [];
    const baseIds = [...new Set((input.baseIds ?? []).map((x) => String(x).trim()).filter(Boolean))];
    if (baseIds.length && !this.cfg.lineage) throw new TeachError(403, 'lineage_disabled: building on top of another knowledge is not enabled on this node yet (config teach.lineage)');
    if (baseIds.length > 2) throw new TeachError(400, 'too_many_bases: one base to build on (two only for a merge)', { max: 2 });
    // resolved with `inherit`, because the base's own questions are what tells a conflict from a gap
    const lineage = baseIds.length ? await this.resolveBases(baseIds, caller, { inherit: true, force: true }) : null;
    const baseRows = new Map<string, { row: CanonicalRow; base: string }>();
    for (const b of lineage?.direct ?? []) for (const r of b.rows ?? []) if (!baseRows.has(r.prompt)) baseRows.set(r.prompt, { row: r, base: b.id });
    for (const [i, f] of input.facts.entries()) {
      const bad = this.staticFactCheck(f);
      if (bad) { out.push({ index: i, status: 'invalid', detail: bad }); continue; }
      const ov = await this.overlapsListing(f);
      // overlapping the knowledge you are building ON is not "someone already sells this": it is the base already
      // teaching it, which is the whole point of `in_base` (design §12.1, SC-6)
      if (ov && baseIds.includes(ov.anchor.id)) { out.push({ index: i, status: 'in_base', base_id: ov.anchor.id, detail: ov.anchor.name }); continue; }
      if (ov) { out.push({ index: i, status: 'overlaps_listing', detail: ov.anchor.name }); continue; }
      todo.push(i);
    }
    if (todo.length) {
      let answers: Map<number, string>;
      const contextIds = input.patchIds.filter((id) => !baseIds.includes(id));
      if (this.offline) {
        await this.contextTargets(contextIds, caller);   // still validates the ids (and the draft ownership)
        answers = new Map(todo.map((i) => [i, this.stubAnswer(input.facts[i].prompt, input.facts[i].answer)] as const));
      } else {
        const st = await this.market.runtime.status();
        if (!st.available) throw new TeachError(503, `runtime unavailable: ${st.error ?? 'model server is off or restarting'}`);
        // the base goes on FIRST and the comparison loads after it — the order a buyer would run (design §7.6)
        const targets = [...(lineage?.stack ?? []).map((b) => ({ id: b.id, path: b.path })), ...(await this.contextTargets(contextIds, caller))];
        answers = await this.withStack('teach:preflight', targets, async () => {
          const res = new Map<number, string>();
          for (const i of todo) res.set(i, await this.askChat(input.facts[i].prompt));
          return res;
        });
      }
      for (const i of todo) {
        const answer = answers.get(i) ?? '';
        const f = input.facts[i];
        const known = normAnswer(answer).includes(normAnswer(f.answer));
        const owned = baseRows.get(f.prompt);
        // `in_base` is a claim ABOUT THE BASE, so it is made from the base's own questions — with the base loaded the
        // model answering correctly could just as well be the plain model knowing it, which is `already_known`.
        if (owned && normAnswer(owned.row.answer).includes(normAnswer(f.answer))) out.push({ index: i, status: 'in_base', base_answer: owned.row.answer, base_id: owned.base });
        else if (owned) out.push({ index: i, status: 'base_conflict', base_answer: owned.row.answer, base_id: owned.base });
        else out.push({ index: i, status: known ? 'already_known' : 'will_train', base_answer: answer });
      }
      out.sort((a, b) => a.index - b.index);
    }
    // what the base's page shows as "what to add on top of this" is made of these three counters (design §10)
    for (const b of lineage?.direct ?? []) {
      const visitor = this.market.visitorId(`key:${input.address.toLowerCase()}`);
      const n = (st: string) => out.filter((f) => f.status === st).length;
      this.store.bumpSignals(b.id, { preflight_wrong_today: n('will_train'), preflight_in_base: n('in_base'), preflight_base_conflict: n('base_conflict') }, { visitor });
      // SC-12 *preflight*: "people tried to teach this on top of it". Counts and a keyed cluster id only — someone
      // else's unpublished question is never stored as text, however many people ask it (§10).
      for (const f of out) {
        if (f.status !== 'will_train' && f.status !== 'base_conflict') continue;
        this.store.bumpIssue(b.id, 'preflight', this.market.questionCluster(input.facts[f.index].prompt), { visitor });
      }
    }
    return {
      facts: out, trainable: out.filter((f) => f.status === 'will_train' || f.status === 'base_conflict').length,
      quota: this.quota(input.address, input.ip), ...(lineage ? { bases: lineage.direct.map((b) => b.id) } : {}), ...(input.sampled ? { sampled: input.sampled } : {}),
    };
  }

  /**
   * Resolve context ids to blobs. `caller` = the visitor asking (a private DRAFT is only usable as context by its owner or
   * the operator — anyone else gets the same "unknown knowledge" as for a non-existent id); `'worker'` = the node's own
   * job steps (the ids were already checked when the job was created).
   */
  private async contextTargets(ids: string[], caller: Caller | 'worker'): Promise<{ id: string; entry: CatalogEntry; path: string }[]> {
    const targets: { id: string; entry: CatalogEntry; path: string }[] = [];
    for (const id of [...new Set(ids)]) {
      const entry = await this.market.entry(id);
      if (!entry || (caller !== 'worker' && !this.market.mayUseEntry(entry, caller))) throw new TeachError(400, `invalid: unknown knowledge ${id}`);
      const blob = this.market.blobs.get(entry.anchor.patch_sha256);
      if (!blob) throw new TeachError(400, `invalid: this node does not hold the body of ${id}`);
      targets.push({ id, entry, path: blob.path });
    }
    return targets;
  }

  /**
   * Run `fn` under a short exclusive section with the context stack applied (apply what is missing, in list order;
   * afterwards remove what we added in reverse and re-assert the operator-pinned set when an overlapping removal happened).
   */
  private async withStack<T>(label: string, targets: { id: string; path: string }[], fn: () => Promise<T>, waitMs = 2 * 60_000): Promise<T> {
    const rt = this.market.runtime;
    return rt.exclusiveTry(label, async () => {
      const added: string[] = [];
      try {
        for (const t of targets) {
          if ((await rt.isApplied(t.path)) === true) continue;
          const r = await rt.applyRaw(t.path); if (r.code !== 0) throw new Error(r.err || r.out);
          added.push(t.path);
        }
        return await fn();
      } finally {
        for (const p of [...added].reverse()) await rt.removeRaw(p).catch(() => undefined);
        if (added.length) await this.reassertPinned();
      }
    }, { waitMs });
  }
  private async reassertPinned() {
    for (const a of this.store.listApplied()) {
      const b = this.market.blobs.get(a.sha256);
      if (b) await this.market.runtime.applyRaw(b.path).catch(() => undefined);
    }
  }
  /** Per-call budget for the serving model inside a teach step (a stalled vLLM must surface as "runtime busy", not hang the lock). */
  private static readonly CALL_TIMEOUT_MS = 60_000;
  /**
   * Teach-mode measurements deliberately opt out of the D1 sampling and guard (`sampling: null`): preflight and the
   * before/after checks compare answers against numbers measured before the guard existed, and a stop sequence or a
   * truncated answer would change what they measure. The visitor-facing live test is where the guard belongs.
   */
  private async askChat(prompt: string, maxTokens = 32): Promise<string> {
    if (this.stopped) throw new Error(STOPPING);
    const r = await this.market.runtime.chat([{ role: 'user', content: prompt }], { maxTokens, thinking: false, timeoutMs: TeachWorker.CALL_TIMEOUT_MS, sampling: null });
    return (r.content ?? '').trim();
  }
  private async askRaw(prompt: string, maxTokens = 16): Promise<string> {
    if (this.stopped) throw new Error(STOPPING);
    return (await this.market.runtime.completeRaw(prompt, maxTokens, TeachWorker.CALL_TIMEOUT_MS)).trim();
  }
  /** Errors that mean "the model server is stalled / restarting" rather than "this lesson is broken". */
  private static isRuntimeOutage(e: unknown): boolean {
    // The runtime maps every engine crash / restart / overload to RuntimeUnavailableError (MODEL_UNAVAILABLE); the
    // message is matched too because the error loses its class when it crosses an await boundary from a wrapped call.
    if (e instanceof RuntimeUnavailableError) return true;
    const msg = (e as Error)?.message ?? String(e);
    if (msg.includes(MODEL_UNAVAILABLE)) return true;
    return /timeout|timed out|aborted|unreachable|fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|not responding|chat failed: 5\d\d|completion failed: 5\d\d/i.test(msg);
  }

  // ------------------------------------------------------------ job creation (spec §6.2 POST /api/teach/jobs; design §7.3)
  /**
   * ONE path to a lesson, two doors. The body is `{dataset_id}` XOR the legacy `{facts}`; the legacy form materialises a
   * dataset with `source: 'chat'` server-side, so there is no second code path to keep alive and a v1 client's lesson is
   * just as re-trainable as an uploaded one.
   *
   * `job.facts[i]` stays the derived view of `dataset.rows[selected_indexes[i]]`, in order — that invariant is what
   * lets every v1 consumer (the trainer's job.json, the checks, recipe.json, the CLI, the payout path) stay untouched.
   */
  async createJob(input: {
    address: string; contributorName?: string; name?: string; ip?: string; patchIds: string[]; buildsOn: boolean;
    facts?: { prompt: string; answer: string; alt_prompt?: string; base_answer?: string }[];
    datasetId?: string;
    selectedIndexes?: number[];
    /** What an interactive pre-flight measured on THESE dataset rows: `{index, base_answer}` (design §5.5). */
    known?: { index: number; base_answer: string }[];
    training?: { effort?: TeachEffort; max_steps?: number; eval_every?: number; rows_limit?: number; row_offset?: number; check_side_effects?: boolean; use_alt?: boolean };
    parentJob?: string;
    /**
     * Lineage (design §12.1): the knowledge this lesson is trained ON TOP OF (one for extend; merge lands with L7).
     * Distinct from `patchIds`, which are loaded for comparison only. Needs the `teach.lineage` flag.
     */
    baseIds?: string[];
    /** Load the base's training set as the keep-set (default true); false = the lesson is checked against the base but its rows are not re-taught. */
    inherit?: boolean;
    /** How this lesson came to be (design §12.1): `scratch` | `extend` (base chosen in the picker) | `fork` (the dataset is a copy of the base's) | `merge` (L7). */
    mode?: 'scratch' | 'extend' | 'fork' | 'merge';
    /** What the trainer writes: a delta over the base stack (default) or a stand-alone squash. */
    exportMode?: 'delta' | 'squash';
    /** Build on a superseded base anyway (warned). */
    force?: boolean;
    /** The visitor saw "this changes {base}'s answer" and meant it (design §12.1 `base_unresolved_conflicts`). */
    confirmConflicts?: boolean;
  }): Promise<TeachJob> {
    const c = this.cfg;
    this.assertEnabled();
    this.assertNotBanned(input.address, input.ip);
    if (input.patchIds.length > 3) throw new TeachError(400, 'invalid: at most 3 context knowledges');
    const baseIds = [...new Set((input.baseIds ?? []).map((x) => String(x).trim()).filter(Boolean))];
    if (baseIds.length && !c.lineage) throw new TeachError(403, 'lineage_disabled: building on top of another knowledge is not enabled on this node yet (config teach.lineage)');
    if (baseIds.length > 2) throw new TeachError(400, 'too_many_bases: one base to build on (two only for a merge)', { max: 2 });
    if (baseIds.length === 2) throw new TeachError(400, 'merge_not_available: combining two knowledges is not available on this node yet — build on one of them', { base_ids: baseIds });
    const exportMode: 'delta' | 'squash' = input.exportMode ?? 'delta';
    const badName = checkDisplayName(input.contributorName); if (badName) throw new TeachError(400, `invalid: ${badName}`);
    const tr = await this.trainerState();
    if (tr.state === 'paused') throw new TeachError(503, `trainer_paused: ${tr.reason ?? 'training is paused'}`);
    const queueGate = () => {
      const active = this.store.listTeachJobs({ status: ACTIVE_JOB_STATUSES });
      if (active.length >= c.queueMax) throw new TeachError(503, 'trainer_paused: the training queue is full — try again later');
      const rowsWaiting = active.reduce((n, j) => n + (j.dataset_rows ?? j.facts.length), 0);
      if (rowsWaiting >= c.queuedRowsMax) throw new TeachError(503, `trainer_paused: ${rowsWaiting} questions are already waiting on this node — try again later`);
      const mineActive = active.filter((j) => j.contributor.toLowerCase() === input.address.toLowerCase()).length;
      if (mineActive >= ACTIVE_JOBS_PER_KEY) throw new TeachError(429, `quota_key: you already have ${mineActive} lesson(s) in progress on this node — wait for them to finish`);
    };
    queueGate();

    // ---- 1) resolve the input to a dataset and its questions
    let dataset: TeachDatasetRecord;
    if (input.datasetId) {
      dataset = this.datasets.owned(input.datasetId, input.address);
      if (dataset.status === 'deleted') throw new TeachError(404, 'dataset_not_found: that dataset was deleted');
    } else {
      const facts = input.facts ?? [];
      if (!facts.length || facts.length > c.factsPerJob) throw new TeachError(400, `invalid: 1..${c.factsPerJob} corrections per lesson`);
      for (const f of facts) { const bad = this.staticFactCheck(f); if (bad) throw new TeachError(400, `invalid: ${bad}`); }
      // The chat basket IS the dataset (the owner's "대화형은 파일형의 전단계"): frozen here to canonical bytes, and from
      // this line on an inline body and an uploaded file are byte-identical artifacts.
      dataset = this.datasets.get(this.datasets.create({
        owner: input.address, ip: input.ip, source: 'chat',
        rows: facts.map((f) => ({ prompt: f.prompt, answer: f.answer, ...(f.alt_prompt ? { alt_prompt: f.alt_prompt } : {}) })),
        name: input.name,
      }).dataset.id)!;
    }
    // `rowsOrThrow`: a dataset whose file was removed answers dataset_not_found, not "empty" — the questions existed
    const all = this.datasets.rowsOrThrow(dataset);
    if (!all.length) throw new TeachError(400, 'dataset_empty: this dataset has no questions left on this node');

    // ---- 1b) inherited rows (design §6.2, §7.1). A dataset forked from X carries X's questions with `from:'X#i'`.
    // They are NOT new facts: they are the keep-set the trainer trains as known answers so the lesson does not undo
    // them. A row whose answer the owner changed (`replaces`) IS trained, and is never counted against X afterwards.
    const baseSet = new Set(baseIds);
    const inheritedIdx = new Set<number>();
    const overrideOf = new Map<number, string>();
    if (baseIds.length) {
      for (const [i, r] of all.entries()) {
        const rep = rowRefPatch(r.replaces);
        if (rep && baseSet.has(rep)) { overrideOf.set(i, r.replaces!); continue; }
        const from = rowRefPatch(r.from);
        if (from && baseSet.has(from)) inheritedIdx.add(i);
      }
    }

    // ---- 2) the training settings and the slice they select
    const effort: TeachEffort = input.training?.effort ?? 'balanced';
    const preset = c.effort[effort];
    const cap = this.rowsPerJob(effort).rows;
    const rowsLimit = input.training?.rows_limit;
    if (rowsLimit !== undefined && rowsLimit > cap) {
      throw new TeachError(400, `dataset_too_large: this node teaches up to ${cap} questions in one lesson`, { rows_limit: rowsLimit, max_rows: cap });
    }
    const offset = Math.max(0, input.training?.row_offset ?? 0);
    const trainable = all.map((_, i) => i).filter((i) => !inheritedIdx.has(i));
    const asked = input.selectedIndexes?.length
      ? [...new Set(input.selectedIndexes)].filter((i) => Number.isInteger(i) && i >= 0 && i < all.length && !inheritedIdx.has(i)).sort((a, b) => a - b)
      : trainable.slice(offset, rowsLimit === undefined ? undefined : offset + rowsLimit);
    if (!asked.length) {
      throw new TeachError(400, inheritedIdx.size
        ? `nothing_to_add: every question in this set is already ${[...baseSet].join(', ')}\u2019s \u2014 add a question, or change one of theirs, before training on top of it`
        : 'invalid: none of the selected questions exist in this dataset');
    }
    // over the cap is an honest banner, not a rejection: the rest stay in the dataset for the next lesson
    const selected = asked.slice(0, cap);
    const useAlt = input.training?.use_alt !== false;
    const training: TeachTrainingSpec = {
      effort,
      max_steps: clampInt(input.training?.max_steps ?? preset.maxSteps, 1, c.effort.thorough.maxSteps),
      eval_every: clampInt(input.training?.eval_every ?? preset.evalEvery, 1, 100),
      lr: c.effort.lr,                                   // never accepted from the client — an unmeasured knob is worse than no knob
      ...(rowsLimit !== undefined ? { rows_limit: rowsLimit } : {}),
      ...(offset ? { row_offset: offset } : {}),
      check_side_effects: input.training?.check_side_effects !== false,
      use_alt: useAlt,
      selected_indexes: selected,
    };

    // ---- 3) drop what the model already answers (interactive preflight result) or what repeats a listing
    const known = new Map<string, string>();
    for (const f of input.facts ?? []) if (f.base_answer) known.set(`${f.prompt.trim()}\u0000${f.answer.trim()}`, f.base_answer);
    // The file door has no `facts` to hang a base answer on, so the preview sends the row INDEXES it measured. The
    // claim is still verified below against the row's own answer — a client cannot skip a question by asserting it.
    const knownAt = new Map<number, string>();
    for (const k of input.known ?? []) if (k.base_answer) knownAt.set(k.index, k.base_answer);
    const kept: TeachFactRow[] = []; const keptIndexes: number[] = [];
    let overlaps = 0; let alreadyKnown = 0;
    for (const [n, i] of selected.entries()) {
      const r = all[i];
      const base = knownAt.get(i) ?? known.get(`${r.prompt}\u0000${r.answer}`);
      if (base && normAnswer(base).includes(normAnswer(r.answer))) { alreadyKnown++; continue; }
      // the catalog scan is O(listings x samples) per question — bounded to the sampled head; the worker preflight
      // re-checks the rest against the live model anyway. Overlapping the knowledge you build ON is not "already sold
      // here": it is judged below, against that knowledge's own questions (in_base / a conflict you have to mean).
      if (n < c.preflight.sampleRows) {
        const ov = await this.overlapsListing(r);
        if (ov && !baseSet.has(ov.anchor.id)) { overlaps++; continue; }
      }
      kept.push({ prompt: r.prompt, answer: r.answer, ...(useAlt && r.alt_prompt ? { alt_prompt: r.alt_prompt } : {}), ...(base ? { base_answer: base } : {}), ...(overrideOf.has(i) ? { replaces: overrideOf.get(i) } : {}) });
      keptIndexes.push(i);
    }
    if (!kept.length) throw new TeachError(409, alreadyKnown >= overlaps ? 'already_known: the model already answers this correctly' : 'overlaps_listing: this knowledge is already sold on this node');
    training.selected_indexes = keptIndexes;

    // ---- 4) the base (lineage): resolved BEFORE the quotas are charged, so a refused base costs nothing
    const targets = await this.contextTargets(input.patchIds.filter((id) => !baseIds.includes(id)), { address: input.address });
    const lineage = baseIds.length ? await this.resolveBases(baseIds, { address: input.address }, { force: input.force, inherit: input.inherit !== false }) : null;
    /*
     * The chat door has no `from` pointers to go by, so a question that is ALREADY one of the base's is found here, by
     * the parser's key (F13/R1): the same question with the same answer is dropped (the base already teaches it), the
     * same question with a DIFFERENT answer is a conflict the visitor has to mean — confirmed, it becomes an override
     * (`replaces`, trained, never counted as a regression of the base); unconfirmed, it is refused with the rows named
     * (design §12.1 `base_unresolved_conflicts`) instead of quietly training an answer over someone else's.
     */
    if (lineage?.direct.length) {
      const byPrompt = new Map<string, { i: number; row: CanonicalRow; base: string }>();
      for (const b of lineage.direct) (b.rows ?? []).forEach((r, i) => { if (!byPrompt.has(r.prompt)) byPrompt.set(r.prompt, { i, row: r, base: b.id }); });
      const conflicts: { index: number; prompt: string; your_answer: string; base_answer: string; base_id: string }[] = [];
      const nextKept: TeachFactRow[] = []; const nextIndexes: number[] = [];
      for (const [n, f] of kept.entries()) {
        const hit = f.replaces ? undefined : byPrompt.get(f.prompt);
        if (hit && normAnswer(hit.row.answer).includes(normAnswer(f.answer))) { alreadyKnown++; continue; }   // in_base: the base teaches this already
        if (hit) {
          if (!input.confirmConflicts) { conflicts.push({ index: keptIndexes[n], prompt: f.prompt, your_answer: f.answer, base_answer: hit.row.answer, base_id: hit.base }); continue; }
          f.replaces = `${hit.base}#${hit.i}`;
        }
        nextKept.push(f); nextIndexes.push(keptIndexes[n]);
      }
      if (conflicts.length) {
        throw new TeachError(400, `base_unresolved_conflicts: ${conflicts.length} of your answers differ from ${lineage.direct[0].id}'s answer to the same question — confirm that you mean to change them (they will be published as changes to it) or take them out`, { rows: conflicts });
      }
      if (!nextKept.length) throw new TeachError(409, `already_known: ${lineage.direct[0].id} already answers every one of these questions the same way`);
      kept.length = 0; kept.push(...nextKept);
      keptIndexes.length = 0; keptIndexes.push(...nextIndexes);
      training.selected_indexes = keptIndexes;
    }
    const q = this.jobQuota(input.address, input.ip);
    if (q.key_remaining <= 0) throw new TeachError(429, 'quota_key: daily lesson limit reached for this key', { key_remaining: 0 });
    if (q.ip_remaining <= 0) throw new TeachError(429, 'quota_ip: daily lesson limit reached for this address', { ip_remaining: 0 });
    if (kept.length > q.rows_remaining) throw new TeachError(429, `quota_rows: you have ${q.rows_remaining} of ${c.dataset.rowsPerKeyPerDay} questions left to teach on this node today`, { rows_remaining: q.rows_remaining, rows_ip_remaining: q.rows_ip_remaining, limit: c.dataset.rowsPerKeyPerDay, asked: kept.length });
    if (kept.length > q.rows_ip_remaining) throw new TeachError(429, `quota_rows: this address has ${q.rows_ip_remaining} of ${c.dataset.rowsPerIpPerDay} questions left to teach on this node today`, { rows_remaining: q.rows_remaining, rows_ip_remaining: q.rows_ip_remaining, limit: c.dataset.rowsPerIpPerDay, asked: kept.length });
    const now = Date.now(); const day = dayKey(now);
    const id = randomUUID();
    // an uploaded file's name is meaningful, a frozen chat basket's ("your-dataset-2026-09-01") is not — v1 naming stands there
    const name = (input.name?.trim() || (input.datasetId ? dataset.name : '') || `Lesson: ${kept[0].prompt.slice(0, 60)}`).slice(0, 80);
    const contributorName = normalizeDisplayName(input.contributorName)?.slice(0, 40) ?? null;
    queueGate();   // again, synchronously right before the insert: the awaits above let concurrent requests pass the first check together
    // Snapshot at job creation (design §5.2): the dataset bytes are frozen into the job directory NOW, so an edit,
    // `delete_after_training` or the 7-day sweep can never change what a published lesson needs; the published copy
    // is promoted from this file at publish time.
    const dir = this.jobDir({ id, job_dir: null } as TeachJobRow);
    mkdirSync(dir, { recursive: true });
    const snapshot = canonicalBytes(all);
    const snapshotSha = sha256Hex(snapshot);
    writeFileSync(join(dir, 'snapshot.jsonl'), snapshot, { mode: 0o600 });
    // The keep-set is what the creator KEPT of the base's questions, not the base's whole set: a row they deleted from
    // their copy is not re-taught, and a row they changed is trained as a new fact instead (design §6.2/§6.3).
    const inheritedRows = inheritedIdx.size ? [...inheritedIdx].sort((a, b) => a - b).map((i) => all[i]) : [];
    if (lineage) {
      writeFileSync(join(dir, 'known.jsonl'), canonicalBytes(inheritedRows.length ? inheritedRows : lineage.known), { mode: 0o600 });
      for (const b of lineage.direct) this.store.bumpSignals(b.id, { builds_on_jobs: 1 }, { visitor: this.market.visitorId(`key:${input.address.toLowerCase()}`) });
    }
    this.store.insertTeachJob({
      id, contributor: input.address, contributor_name: contributorName, ip: input.ip ?? null, status: 'QUEUED',
      context: targets.map((t) => t.id), builds_on: input.buildsOn, facts: kept, job_dir: dir, npz_path: null, sha256: null, progress: null, checks: null, error: null,
      container_pid: null, draft_id: null, patch_id: null, publish_status: 'none', reject_reason: null, parent_job: input.parentJob ?? null, result: null, blocked: null, name,
      dataset_id: dataset.id, dataset_sha256: dataset.sha256, dataset_rows: dataset.rows, dataset_source: dataset.source, training,
      snapshot_sha256: snapshotSha,
      mode: !lineage ? 'scratch' : input.mode === 'fork' || (dataset.parent_patch && baseSet.has(dataset.parent_patch)) ? 'fork' : 'extend',
      ...(lineage ? { bases: lineage.stack.map((b) => ({ patch_id: b.id, sha256: b.sha256 })), export_mode: exportMode } : {}),
      // Questions dropped HERE (the interactive pre-flight said the model knows them, or the same fact is already sold
      // on this node) are gone from the lesson before it starts. Recording them is the only way the result screen can
      // account for a 40-question dataset that produced a 16-question lesson.
      preflight: alreadyKnown || overlaps ? { checked: Math.min(selected.length, Math.max(knownAt.size, c.preflight.sampleRows)), of: selected.length, known: alreadyKnown, ...(overlaps ? { overlaps } : {}) } : null,
      created_at: now, started_at: null, finished_at: null, expires_at: null, cancel_requested: false,
    });
    this.store.teachQuotaBump(`addr:${input.address.toLowerCase()}`, day);
    if (input.ip) this.store.teachQuotaBump(`ip:${input.ip}`, day);
    this.datasets.chargeRows(input.address, input.ip, kept.length, now);
    this.datasets.markStatus(dataset.id, 'in_use');
    this.store.touchContributor(input.address, { ...(contributorName ? { name: contributorName } : {}), job: true });
    this.invalidatePolicy();
    // the prompt (job name) and the key stay out of the message: /api/events is public (data is operator-only there)
    this.log('info', `lesson queued (${kept.length} of ${dataset.rows} question(s), ${lineage ? `built on ${lineage.direct.map((b) => b.id).join('+')}, ${inheritedRows.length} inherited, ${overrideOf.size} changed, ` : ''}context ${targets.map((t) => t.id).join('+') || '-'})`, id, { contributor: input.address, name, facts: kept.length, dataset_id: dataset.id, ...(lineage ? { bases: lineage.stack.map((b) => b.id), known_rows: inheritedRows.length || lineage.known.length, changed_rows: overrideOf.size } : {}) });
    return this.view(this.store.getTeachJob(id)!);
  }

  /**
   * Resolve the base a lesson is trained on top of (design §12.1 errors, in this order): unknown → not usable by this
   * key (someone else's private draft) → rejected / challenged → retired (superseded; `force` proceeds) → training set
   * private (nothing to build on) → body not held here → the base's own stack resolves and is held → depth ≤ 8.
   * Returns the ORDERED stack (ancestors first, the chosen base last), the direct base(s), and the base's rows for
   * `known.jsonl` (fetched from a holder when this node does not pin them yet).
   */
  private async resolveBases(ids: string[], caller: Caller, opts: { force?: boolean; inherit: boolean }): Promise<{ stack: BaseTarget[]; direct: BaseTarget[]; known: CanonicalRow[] }> {
    const direct: BaseTarget[] = [];
    const stack: BaseTarget[] = [];
    const known: CanonicalRow[] = [];
    const resolve = async (id: string, role: 'base' | 'ancestor'): Promise<BaseTarget> => {
      const entry = await this.market.entry(id);
      if (!entry) throw new TeachError(400, `base_unknown: no knowledge called ${id} on this node`, { id });
      if (!this.market.mayUseEntry(entry, caller)) throw new TeachError(403, `base_not_available: ${id} is someone else's private draft`, { id });
      if (entry.status === 'REJECTED' || entry.status === 'CHALLENGED') throw new TeachError(400, `base_rejected: ${id} is ${entry.status.toLowerCase()} — it cannot be built on`, { id, status: entry.status });
      if (entry.status === 'SUPERSEDED' && !opts.force) throw new TeachError(400, `base_retired: ${id} is retired — build on its newer version${entry.superseded_by[0] ? ` ${entry.superseded_by[0]}` : ''}, or pass force to proceed anyway`, { id, newer: entry.superseded_by[0] ?? null });
      const owner = caller.address && (entry.anchor.contributors ?? []).some((x) => creditedAddress(x).toLowerCase() === caller.address!.toLowerCase() || x.signer?.toLowerCase() === caller.address!.toLowerCase());
      const mine = owner || (entry.status === 'DRAFT' && this.market.mayUseEntry(entry, caller));
      if (role === 'base' && accessRank(accessOf(entry.anchor)) < 1 && !mine) throw new TeachError(400, `base_private: the creator of ${id} kept its questions private, so nobody can build on it (you can still load it for comparison)`, { id });
      const blob = this.market.blobs.get(entry.anchor.patch_sha256);
      if (!blob) throw new TeachError(409, `base_not_held: this node does not hold the body of ${id} — buy or download it first`, { id });
      return { id, entry, path: blob.path, sha256: entry.anchor.patch_sha256 };
    };
    for (const id of ids) {
      const base = await resolve(id, 'base');
      // its own stack goes below it, in order; every member must be here too
      for (const a of base.entry.anchor.base?.stack ?? []) {
        if (a.patch_id === id || stack.some((x) => x.id === a.patch_id)) continue;
        const anc = await resolve(a.patch_id, 'ancestor');
        if (anc.sha256 !== a.patch_sha256) throw new TeachError(409, `base_not_held: ${a.patch_id} is held under a different body than ${id} was trained on`, { id: a.patch_id });
        stack.push(anc);
      }
      if (!stack.some((x) => x.id === id)) stack.push(base);
      direct.push(base);
      if (opts.inherit) {
        const sha = base.entry.anchor.dataset?.sha256;
        if (sha) {
          const rows = await this.ensureDatasetBlob(base.entry, caller);
          for (const r of rows) known.push(r);
          base.datasetSha256 = sha; base.datasetRows = rows.length; base.rows = rows;
        }
      }
    }
    if (stack.length > 8) throw new TeachError(400, `base_stack_too_deep: ${stack.length} knowledges would have to be loaded under this lesson (at most 8)`, { depth: stack.length });
    return { stack, direct, known };
  }

  /**
   * The base's published training set: from this node's pinned copy, else fetched from a peer advertising the sha
   * (kept and re-advertised here, design §6.6). A base whose set nobody holds cannot be inherited from.
   */
  private async ensureDatasetBlob(entry: CatalogEntry, caller: Caller): Promise<CanonicalRow[]> {
    const sha = entry.anchor.dataset!.sha256;
    const local = this.market.datasets.rowsBytes(sha);
    if (local) return readCanonicalJsonl(local.toString('utf8'));
    // Story A3: a base that is still the visitor's OWN draft has no pinned copy yet (pinning happens at publish) —
    // its rows are the snapshot frozen with the job that produced it, which is exactly what will be pinned. Only the
    // owner reaches this: `resolveBases` refused a stranger's draft before us.
    for (const j of this.store.listTeachJobs({ draft_id: entry.anchor.id })) {
      const snap = j.job_dir ? join(j.job_dir, 'snapshot.jsonl') : null;
      if (snap && existsSync(snap) && j.snapshot_sha256 === sha) return readCanonicalJsonl(readFileSync(snap, 'utf8'));
    }
    const token = caller.address ? this.market.deriveIntent(entry, caller.address).token : undefined;
    try {
      const fetched = await this.market.p2p.fetchDataset(sha, token);
      const row = this.market.datasets.keepFetched(sha, fetched.rows, fetched.manifest, fetched.benchmark);
      this.log('info', `fetched the training set of ${entry.anchor.id} (${row.rows} questions) from ${fetched.from}`, null, { sha256: sha });
      return this.market.datasets.rows(sha);
    } catch (e) {
      throw new TeachError(404, `dataset_unavailable: the training set of ${entry.anchor.id} is not on this node and no peer holds it (${(e as Error).message})`, { id: entry.anchor.id, sha256: sha });
    }
  }

  // ------------------------------------------------------------ fork (design §12.3 POST /api/patches/:id/fork, Story B)
  /**
   * *Copy and continue*: the published training set of a knowledge becomes a dataset of MINE, with the knowledge
   * recorded as its parent and every row pointing back at the row it came from. This is the whole answer to "the
   * training set has to be inherited so I can append to it": from here the editor, the preview, `--on` and the
   * publish path all work on rows that know where they came from.
   *
   * Refusals, in the order they can be known: unknown knowledge → someone else's private draft → its creator kept the
   * questions private → nobody on this network holds the bytes.
   */
  async forkPatch(id: string, caller: { address: string; ip?: string }, opts: { name?: string } = {}): Promise<{ dataset: DatasetView; created: boolean; inherited_rows: number; parent: { patch_id: string; name: string; dataset_sha256: string }; license: string | null }> {
    this.assertEnabled();
    this.assertNotBanned(caller.address, caller.ip);
    if (!this.cfg.lineage) throw new TeachError(403, 'lineage_disabled: copying another knowledge\'s questions is not enabled on this node yet (config teach.lineage)');
    const entry = await this.market.entry(id);
    if (!entry || !this.market.mayUseEntry(entry, { address: caller.address })) throw new TeachError(404, `base_unknown: no knowledge called ${id} on this node`, { id });
    const sha = entry.anchor.dataset?.sha256;
    if (!sha) throw new TeachError(404, `dataset_unavailable: ${id} has no published training set — there is nothing to copy`, { id });
    const owner = (entry.anchor.contributors ?? []).some((x) => creditedAddress(x).toLowerCase() === caller.address.toLowerCase() || x.signer?.toLowerCase() === caller.address.toLowerCase())
      || entry.anchor.author.toLowerCase() === caller.address.toLowerCase();
    if (accessRank(accessOf(entry.anchor)) < 1 && !owner) {
      throw new TeachError(403, `dataset_private: the creator of ${id} kept the questions private, so nobody can copy or build on them`, { id });
    }
    const rows = await this.ensureDatasetBlob(entry, { address: caller.address });
    const out = this.datasets.forkFromPatch({
      owner: caller.address, ip: caller.ip, patchId: id, datasetSha: sha, rows,
      name: opts.name?.trim() || `${entry.anchor.name} (my copy)`.slice(0, 80),
    });
    // one derive per key per knowledge is what "built on N times" counts (§6.1) — the fetch itself is free
    if (out.created) this.store.bumpSignals(id, { derive_fetches: 1 }, { visitor: this.market.visitorId(`key:${caller.address.toLowerCase()}`) });
    this.store.touchContributor(caller.address, {});
    this.log('info', `${out.created ? 'copied' : 'reused the copy of'} the training set of ${id} (${out.dataset.rows} question(s)) into dataset ${out.dataset.id}`, null, { dataset_id: out.dataset.id, patch_id: id });
    return {
      dataset: out.dataset, created: out.created, inherited_rows: out.dataset.inherited_rows ?? out.dataset.rows,
      parent: { patch_id: id, name: entry.anchor.name, dataset_sha256: sha }, license: entry.anchor.dataset?.license ?? null,
    };
  }

  /**
   * Re-train from the same dataset (or a fork / another owned dataset). Same input, `parent_job` set, quota re-charged —
   * this is what makes "Train it again" and "Add questions and continue" true.
   */
  async retrain(j: TeachJobRow, address: string, body: { dataset_id?: string; selected_indexes?: number[]; training?: { effort?: TeachEffort; max_steps?: number; eval_every?: number; rows_limit?: number; row_offset?: number; check_side_effects?: boolean; use_alt?: boolean }; name?: string; ip?: string }): Promise<TeachJob> {
    const dsId = body.dataset_id ?? this.ensureDataset(j)?.id;
    if (!dsId) throw new TeachError(409, 'dataset_not_found: this lesson has no dataset to train again');
    const prev = j.training as TeachTrainingSpec | null;
    const bump: Record<TeachEffort, TeachEffort> = { quick: 'balanced', balanced: 'thorough', thorough: 'thorough' };
    const effort = body.training?.effort ?? (prev ? bump[prev.effort] : 'balanced');
    return this.createJob({
      address, contributorName: j.contributor_name ?? undefined, name: body.name ?? j.name ?? undefined, ip: body.ip,
      patchIds: j.context, buildsOn: j.builds_on, datasetId: dsId,
      selectedIndexes: body.selected_indexes ?? prev?.selected_indexes,
      training: { ...body.training, effort }, parentJob: j.id,
      // the same base, so "train it again" stays an attempt on the same line (design §5.3: parent_job is never lineage)
      ...(j.bases?.length ? { baseIds: [j.bases[j.bases.length - 1].patch_id], exportMode: j.export_mode ?? 'delta', force: true } : {}),
    });
  }

  /**
   * Lazily give a v1 job a dataset (design G5): no bulk migration ever runs, but the first time its owner asks to
   * download or re-train it the inline facts are written out as `rows.jsonl` with `source: 'derived'` and the four job
   * columns are backfilled. Announced jobs are never touched.
   */
  ensureDataset(j: TeachJobRow): TeachDatasetRecord | null {
    if (j.dataset_id) return this.store.getTeachDataset(j.dataset_id);
    if (!j.facts.length) return null;
    const rows: CanonicalRow[] = j.facts.map((f) => ({ prompt: f.prompt, answer: f.answer, ...(f.alt_prompt ? { alt_prompt: f.alt_prompt } : {}) }));
    const made = this.datasets.create({ owner: j.contributor, ip: j.ip ?? undefined, source: 'derived', rows, name: j.name ?? undefined });
    const rec = this.datasets.get(made.dataset.id)!;
    this.store.updateTeachJob(j.id, { dataset_id: rec.id, dataset_sha256: rec.sha256, dataset_rows: rec.rows, dataset_source: rec.source });
    this.log('info', `lesson ${j.id} kept no dataset (taught before datasets existed) — one was written from its questions`, j.id, { dataset_id: rec.id });
    return rec;
  }

  // ------------------------------------------------------------ views
  view(j: TeachJobRow): TeachJob {
    const out: TeachJob = {
      id: j.id, status: j.status as TeachStatus, contributor: { address: j.contributor, ...(j.contributor_name ? { name: j.contributor_name } : {}) },
      context_patch_ids: j.context, builds_on_context: j.builds_on, facts: j.facts as TeachFact[], name: j.name ?? undefined,
      ...(j.bases ? { bases: j.bases.map((b) => {
        // a base is usually a listed knowledge, but Story A3's base is the visitor's OWN draft — the copy has to be
        // able to say "not published yet ({status})", so drafts are looked up too
        const e = this.market.catalogSync().find((x) => x.anchor.id === b.patch_id);
        const draft = e ? null : this.store.getDraft(b.patch_id);
        return { patch_id: b.patch_id, sha256: b.sha256, ...(e ? { name: e.anchor.name, status: e.status } : draft ? { name: draft.anchor.name, status: 'DRAFT' } : {}) };
      }) } : {}),
      ...(j.mode ? { mode: j.mode } : {}), ...(j.export_mode ? { export: j.export_mode } : {}),
      ...(j.bases?.length ? { inherited_rows: this.knownRowsOf(j), changed_rows: j.facts.filter((f) => f.replaces).length } : {}),
      ...(j.derivation ? { derivation: j.derivation } : {}), ...(j.dataset_pub ? { dataset_pub: j.dataset_pub } : {}),
      blocked: j.blocked, progress: (j.progress as unknown as TeachProgress) ?? undefined, checks: (j.checks as unknown as TeachChecks) ?? undefined, result: j.result ?? undefined,
      draft_id: j.draft_id ?? undefined, patch_id: j.patch_id ?? undefined, publish_status: (j.publish_status as TeachJob['publish_status']) ?? 'none',
      reject_reason: j.reject_reason ?? undefined, error: j.error ?? undefined, parent_job: j.parent_job ?? undefined,
      dataset: this.datasetRef(j), ...(j.training ? { training: j.training } : {}),
      ...(j.preflight ? { preflight: j.preflight as { checked: number; of: number; known: number; overlaps?: number } } : {}),
      created_at: j.created_at, updated_at: j.updated_at, started_at: j.started_at ?? undefined, finished_at: j.finished_at ?? undefined, expires_at: j.expires_at ?? undefined,
    };
    if (out.progress && j.started_at && !j.finished_at) out.progress = { ...out.progress, elapsed_s: Math.round((Date.now() - j.started_at) / 1000) };
    if (j.status === 'QUEUED') {
      const ahead = this.store.listTeachJobs({ status: ['QUEUED'] }).filter((x) => x.created_at < j.created_at).length + (this.current && this.current !== j.id ? 1 : 0);
      out.position = ahead;
      // design §10: no projected duration before ≥ 3 lessons measured on the GRADIENT backend — three 3-second stub
      // jobs must never satisfy this, and a rows-aware fit is preferred over a global p50 over jobs of unrelated sizes.
      const fit = this.rowsPerJob((j.training as TeachTrainingSpec | null)?.effort ?? 'balanced');
      const stats = this.store.teachStats(50, 'gradient').map((x) => x.total_s);
      const p50 = percentileOf(stats, 0.5);
      const rows = j.facts.length || 1;
      const passes = (j.training as TeachTrainingSpec | null)?.max_steps ?? this.cfg.effort.balanced.maxSteps;
      const rowsFit = fit.s_per_row_p50 !== null && fit.samples >= ETA_MIN_SAMPLES ? (fit.load_s_p50 ?? 0) + passes * rows * fit.s_per_row_p50 : null;
      const one = rowsFit ?? (stats.length >= ETA_MIN_SAMPLES ? p50 : null);
      out.eta_s = j.blocked === 'slot' || one === null ? null : Math.round((ahead + 1) * one);
    }
    return out;
  }

  /** How many of the base's questions travel with this lesson as the keep-set (`known.jsonl`, design §7.1). */
  private knownRowsOf(j: TeachJobRow): number {
    const p = j.job_dir ? join(j.job_dir, 'known.jsonl') : null;
    if (!p || !existsSync(p)) return 0;
    try { return readCanonicalJsonl(readFileSync(p, 'utf8')).length; } catch { return 0; }
  }

  /** What a lesson was trained from. `id: null` on a v1 job — it still renders, publishes and pays out (design G5). */
  private datasetRef(j: TeachJobRow): TeachDatasetRef {
    const checks = j.checks as unknown as TeachChecks | null;
    const training = j.training as TeachTrainingSpec | null;
    if (!j.dataset_id) return { id: null, sha256: null, rows: j.facts.length, source: 'derived', trained_rows: j.facts.length };
    const d = this.store.getTeachDataset(j.dataset_id);
    return {
      id: j.dataset_id, sha256: j.dataset_sha256, ...(d ? { revision: d.revision, name: d.name } : {}),
      rows: j.dataset_rows ?? j.facts.length, source: (j.dataset_source ?? 'chat') as TeachDatasetSource,
      trained_rows: j.facts.length,
      ...(training?.selected_indexes ? { selected_indexes: training.selected_indexes } : {}),
      ...(checks?.taught.sampled ? { sampled: checks.taught.sampled } : {}),
      ...(!d || d.status === 'deleted' ? { deleted: true as const } : {}),
    };
  }
  publicView(j: TeachJobRow): TeachJobPublic { const v = this.view(j); return { id: v.id, status: v.status, ...(v.position !== undefined ? { position: v.position } : {}), ...(v.eta_s !== undefined ? { eta_s: v.eta_s } : {}) }; }
  get(id: string): TeachJobRow | null { return this.store.getTeachJob(id); }
  isOwner(j: TeachJobRow, address: string | null): boolean { return !!address && j.contributor.toLowerCase() === address.toLowerCase(); }
  // Both lists are newest-first, and both ask the store for the newest rows: reversing an ASC page would put the
  // newest lesson out of reach on a node that has run more than `limit` of them (the operator's review queue is
  // exactly the newest end of the table).
  listMine(address: string): TeachJob[] { return this.store.listTeachJobs({ contributor: address, order: 'desc' }).map((j) => this.view(j)); }
  listAll(): (TeachJob & { ip: string | null })[] {
    const rows = this.store.listTeachJobs({ order: 'desc' });
    // …and a lesson the operator never decided about must never fall off the end of the page, however old it is
    const seen = new Set(rows.map((j) => j.id));
    for (const j of this.store.listTeachJobs({ status: ['PENDING_REVIEW'] })) if (!seen.has(j.id)) rows.push(j);
    rows.sort((a, b) => b.created_at - a.created_at);
    return rows.map((j) => ({ ...this.view(j), ip: j.ip }));
  }

  /** The caller's private lessons as catalog entries (drafts resolve through `entry()`), for `GET /api/chat/patches.lessons`. */
  async lessonsFor(address: string): Promise<CatalogEntry[]> {
    const out: CatalogEntry[] = [];
    for (const j of this.store.listTeachJobs({ contributor: address })) {
      const id = j.patch_id ?? j.draft_id;
      if (!id || ['EXPIRED', 'CANCELLED', 'FAILED'].includes(j.status)) continue;
      const e = await this.market.entry(id);
      if (e) out.push(e);
    }
    return out;
  }

  // ------------------------------------------------------------ cancel / delete (spec §6.2 DELETE)
  async cancel(j: TeachJobRow, by: 'owner' | 'operator'): Promise<{ ok: true; status: 'CANCELLED' }> {
    if (['ANNOUNCED'].includes(j.status) || j.publish_status === 'announced' || j.publish_status === 'listed') throw new TeachError(409, 'published_immutable: published knowledge cannot be deleted');
    if (['QUEUED', 'EXPORTED'].includes(j.status)) { this.cleanupFiles(j); this.finish(j.id, 'CANCELLED', { error: null }); }
    else if (['PREFLIGHT', 'TRAINING', 'LOADING', 'CHECKING'].includes(j.status)) {
      this.store.updateTeachJob(j.id, { cancel_requested: true });
      if (this.current === j.id && this.child) { try { this.child.kill('SIGTERM'); } catch { /* ignore */ } }
      await this.killStray(j).catch(() => undefined);
      // the worker turns cancel_requested into CANCELLED as soon as the step returns; for the caller it is cancelled now
      if (this.current !== j.id) this.finish(j.id, 'CANCELLED', { error: null });
    } else if (['READY', 'NEEDS_MORE', 'PENDING_REVIEW', 'REJECTED', 'FAILED', 'EXPIRED', 'CANCELLED'].includes(j.status)) {
      if (j.draft_id) { try { this.market.deleteDraft(j.draft_id); } catch { /* already gone */ } }
      this.cleanupFiles(j);
      this.finish(j.id, 'CANCELLED', { error: null, draft_id: null });
    }
    // the dataset is deliberately NOT deleted — "your dataset is kept, so you can train it again" is only true because of this
    this.datasets.markStatus(j.dataset_id, 'ready');
    this.log('info', `lesson ${j.id} cancelled by ${by} — the dataset it was trained from is kept`, j.id);
    this.invalidatePolicy();
    return { ok: true, status: 'CANCELLED' };
  }

  /** Remove the job directory (npz, recipe, job.json), the blob row that pointed into it and any download tokens. */
  private cleanupFiles(j: TeachJobRow) {
    if (j.lesson_applied) {
      // the npz is the only thing that can take those rows off the shared table again — keep it until restoreTable() ran
      this.pendingRestore.add(j.id);
      this.log('warn', `lesson ${j.id} may still be applied to the shared model — files kept until the table is restored`, j.id);
      if (j.sha256) this.store.deleteTokensFor(j.sha256);
      return;
    }
    const blob = j.sha256 ? this.store.getBlob(j.sha256) : null;
    if (j.job_dir && blob && blob.path.startsWith(j.job_dir)) this.store.deleteBlob(j.sha256!);
    if (j.sha256) this.store.deleteTokensFor(j.sha256);
    if (j.job_dir && existsSync(j.job_dir)) { try { rmSync(j.job_dir, { recursive: true, force: true }); } catch { /* ignore */ } }
  }

  /**
   * Auto-expiry (spec §8.3 / §12): private drafts that were never published (READY / NEEDS_MORE, and REJECTED ones the
   * operator declined) become EXPIRED after `draftTtlDays` — draft, files and tokens removed; FAILED / CANCELLED rows that
   * still own a job dir lose their files after the same TTL (status unchanged). Announced lessons are never touched.
   */
  sweepExpired(now = Date.now()) {
    const ttl = this.cfg.draftTtlDays * 86_400_000;
    for (const j of this.store.listTeachJobs({ status: ['READY', 'NEEDS_MORE', 'REJECTED'] })) {
      if (!['none', 'rejected'].includes(j.publish_status)) continue;
      const expires = j.expires_at ?? (j.finished_at ? j.finished_at + ttl : null);
      if (!expires || expires > now) continue;
      if (j.draft_id) { try { this.market.deleteDraft(j.draft_id); } catch { /* ignore */ } }
      this.cleanupFiles(j);
      this.finish(j.id, 'EXPIRED', { draft_id: null });
      this.log('info', `lesson ${j.id} expired (${j.status === 'REJECTED' ? 'declined' : 'unsaved'} for ${this.cfg.draftTtlDays} days) — files and tokens removed`, j.id);
    }
    for (const j of this.store.listTeachJobs({ status: ['FAILED', 'CANCELLED'] })) {
      if (!j.job_dir || !existsSync(j.job_dir) || j.lesson_applied) continue;
      const end = j.finished_at ?? j.updated_at;
      if (end + ttl > now) continue;
      this.cleanupFiles(j);
      this.store.updateTeachJob(j.id, { job_dir: null, npz_path: null });
      this.log('info', `files of ${j.status.toLowerCase()} lesson ${j.id} removed after ${this.cfg.draftTtlDays} days`, j.id);
    }
    if (now - this.lastDatasetSweep > 60_000) { this.lastDatasetSweep = now; try { this.datasets.sweep(now); } catch (e) { this.log('warn', `dataset sweep failed: ${(e as Error).message}`); } }
  }

  /** publish_status announced → listed once the verifiers list the anchor (spec §6.5); cheap, runs every 30 s from tick(). */
  async reconcilePublished(now = Date.now()) {
    if (now - this.lastReconcile < 30_000) return;
    this.lastReconcile = now;
    const announced = this.store.listTeachJobs({ status: ['ANNOUNCED'] }).filter((j) => j.publish_status === 'announced' && j.patch_id);
    if (!announced.length) return;
    const cat = await this.market.catalog();
    for (const j of announced) {
      const e = cat.find((x) => x.anchor.id === j.patch_id);
      if (e && ['LISTED', 'SUPERSEDED', 'CHALLENGED'].includes(e.status)) { this.store.updateTeachJob(j.id, { publish_status: 'listed' }); this.log('info', `lesson ${j.id} is listed as ${j.patch_id}`, j.id); }
    }
  }

  private finish(id: string, status: TeachStatus, extra: Partial<TeachJobRow> = {}) {
    this.store.updateTeachJob(id, { status, finished_at: Date.now(), blocked: null, ...extra });
  }
  /** A finished lesson releases its dataset: back to `ready`, or removed now when its owner asked for that. */
  private releaseDataset(job: TeachJobRow) {
    if (!job.dataset_id) return;
    this.datasets.markStatus(job.dataset_id, 'ready');
    this.datasets.afterTraining(job.dataset_id);
  }

  // ------------------------------------------------------------ the loop
  async tick(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      if (this.pendingRestore.size) { await this.restoreTable(); if (this.pendingRestore.size) return; }   // never start a step while the table may be dirty
      this.sweepExpired();
      await this.reconcilePublished().catch(() => undefined);
      if (this.current) return;
      const now = Date.now();
      const exported = this.store.listTeachJobs({ status: ['EXPORTED'] }).find((j) => !j.blocked || j.updated_at + this.retryMs < now);
      if (exported) { await this.runJob(exported, 'check'); return; }
      const queued = this.store.listTeachJobs({ status: ['QUEUED'] });
      const job = queued.find((j) => j.blocked !== 'lock' || j.updated_at + this.retryMs + Math.random() * this.retryMs < now);
      if (!job) return;
      if (job.cancel_requested) { this.finish(job.id, 'CANCELLED'); return; }
      const slot = await this.acquireSlot(job);
      if (!slot.ok) {
        this.lastBlockedReason = slot.reason;
        if (job.blocked !== 'slot') this.store.updateTeachJob(job.id, { blocked: 'slot' });
        if (Date.now() - this.lastBlockedLog > BLOCKED_LOG_MS) { this.lastBlockedLog = Date.now(); this.log('info', `trainer slot busy (${slot.reason}) — ${queued.length} lesson(s) waiting`, job.id); }
        return;
      }
      this.lastBlockedReason = null;
      let released = false;
      const release = () => { if (!released) { released = true; slot.release(); } };
      try { await this.runJob(job, 'full', release); } finally { release(); }
    } finally {
      this.running = false;
    }
  }

  /** Trainer-slot lease (spec §8.3 QUEUED → PREFLIGHT): atomic mkdir under the shared repo + pgrep + nvidia-smi. */
  private async acquireSlot(job: TeachJobRow): Promise<{ ok: true; release: () => void } | { ok: false; reason: string }> {
    const c = this.cfg;
    if (c.backend === 'stub') return { ok: true, release: () => undefined };
    const repo = this.market.runtime.repo;
    if (!repo) return { ok: false, reason: 'runtime repo not configured' };
    const dir = join(repo, 'ple_patch', '.ainize-teach.lock');
    const holderPath = join(dir, 'holder.json');
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        mkdirSync(dir);
        writeFileSync(holderPath, JSON.stringify({ owner: `pid:${process.pid}`, job: job.id, since: Date.now() }));
        break;
      } catch {
        let holder: { owner: string; since: number } | null = null;
        try { holder = JSON.parse(readFileSync(holderPath, 'utf8')); } catch { /* ignore */ }
        const pid = holder?.owner.startsWith('pid:') ? Number(holder.owner.slice(4)) : null;
        let alive = true;
        if (pid && pid !== process.pid) { try { process.kill(pid, 0); } catch { alive = false; } }
        if (!holder || !alive || Date.now() - holder.since > SLOT_STALE_MS) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } continue; }
        return { ok: false, reason: `another node is training (${holder.owner})` };
      }
    }
    if (!existsSync(holderPath)) return { ok: false, reason: 'could not take the trainer lease' };
    const release = () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } };
    // (b) an operator training job inside the container owns the GPUs
    const pg = await this.execFn('docker', ['exec', c.trainer.container, 'pgrep', '-f', 'train/'], 15_000);
    if (pg.code === 0 && pg.out.trim()) { release(); return { ok: false, reason: `operator training job is using the trainer (pid ${pg.out.trim().split(/\s+/)[0]})` }; }
    if (pg.code !== 0 && pg.code !== 1) { release(); return { ok: false, reason: `trainer container unavailable (${pg.err || pg.code})` }; }
    // (c) enough free memory on the trainer GPUs
    const sm = await this.execFn('nvidia-smi', ['--query-gpu=index,memory.used,memory.total', '--format=csv,noheader,nounits'], 15_000);
    if (sm.code === 0) {
      const want = new Set(c.trainer.gpus.split(',').map((s) => s.trim()).filter(Boolean));
      for (const line of sm.out.split('\n')) {
        const [idx, used, total] = line.split(',').map((s) => s.trim());
        if (!want.has(idx)) continue;
        if (Number(total) - Number(used) < c.trainer.minFreeGpuMb) { release(); return { ok: false, reason: `GPU ${idx} has ${Number(total) - Number(used)} MB free (< ${c.trainer.minFreeGpuMb})` }; }
      }
    }
    return { ok: true, release };
  }

  private jobDir(j: TeachJobRow): string {
    if (j.job_dir) return j.job_dir;
    const repo = this.market.runtime.repo;
    return this.cfg.backend === 'gradient' && repo ? join(repo, '.teach', j.id) : join(this.market.cfg.dataDir, 'teach', j.id);
  }

  private async runJob(job: TeachJobRow, from: 'full' | 'check', releaseSlot: () => void = () => undefined): Promise<void> {
    this.current = job.id;
    let phase: 'preflight' | 'training' | 'checking' = from === 'full' ? 'preflight' : 'checking';
    const requeue = () => {   // graceful stop: back to QUEUED (or EXPORTED) without touching the restart marker — the next start picks it up
      const back: Partial<TeachJobRow> = phase === 'checking' ? { status: 'EXPORTED', blocked: null } : { status: 'QUEUED', blocked: null, progress: null, container_pid: null, started_at: null };
      this.store.updateTeachJob(job.id, back);
      this.log('warn', `node stopping during ${phase} → lesson ${job.id} requeued`, job.id);
    };
    try {
      if (from === 'full') {
        // ---- PREFLIGHT (cheap re-run of the interactive one)
        this.store.updateTeachJob(job.id, { status: 'PREFLIGHT', started_at: Date.now(), blocked: null });
        let facts: TeachFactRow[];
        try { facts = await this.preflightJob(job); } catch (e) {
          if ((e as Error).message === STOPPING) { requeue(); return; }
          if (/shared runtime busy/.test((e as Error).message) || TeachWorker.isRuntimeOutage(e)) { this.store.updateTeachJob(job.id, { status: 'QUEUED', blocked: 'lock' }); this.log('info', `model server busy during preflight (${(e as Error).message}) → requeued`, job.id); return; }
          throw e;
        }
        if (this.cancelled(job.id)) return;
        if (!facts.length) { this.finish(job.id, 'FAILED', { error: 'already_known: the model already answers all of this correctly' }); return; }
        this.store.updateTeachJob(job.id, { facts });
        job = this.store.getTeachJob(job.id)!;
        // ---- TRAINING
        phase = 'training';
        const dir = this.jobDir(job);
        mkdirSync(dir, { recursive: true });
        this.store.updateTeachJob(job.id, { status: 'TRAINING', job_dir: dir, progress: { step: 0, max_steps: this.cfg.trainer.maxSteps, hits: 0, total: facts.length, started_at: Date.now() } });
        this.log('info', `training started (${this.cfg.backend}) for ${job.id}`, job.id);
        const tr = await this.train({ ...job, job_dir: dir });
        releaseSlot();
        if (!tr.ok && tr.error === STOPPING) { requeue(); return; }
        if (this.cancelled(job.id)) return;
        if (!tr.ok) { this.finish(job.id, 'FAILED', { error: tr.error }); this.log('warn', `training failed: ${tr.error}`, job.id); return; }
        const npz = join(dir, 'lesson.npz');
        const sha = await sha256File(npz);
        const size = statSync(npz).size;
        this.store.updateTeachJob(job.id, { status: 'EXPORTED', npz_path: npz, sha256: sha, result: { sha256: sha, rows: tr.done.rows, size_bytes: size }, facts: tr.facts, blocked: null });
        // design §D7 (live bug fix): the backend is recorded, so a stub node's 3-second job can never be shown as
        // measured gradient training. `sentences` = the renderings the trainer actually optimised — what drives cost.
        this.store.putTeachStat({
          job_id: job.id, load_s: tr.done.load_s ?? null, steps: tr.done.steps ?? null, step_s: tr.done.avg_step_s ?? null,
          total_s: tr.done.total_s ?? (job.started_at ? (Date.now() - job.started_at) / 1000 : null), rows: tr.done.rows,
          backend: this.cfg.backend, rows_trained: facts.length, sentences: tr.done.sentences ?? facts.length * 4,
        });
        this.log('info', `exported ${tr.done.rows} memory entries (${(size / 1e6).toFixed(2)} MB, sha ${sha.slice(0, 12)}…)`, job.id);
        job = this.store.getTeachJob(job.id)!;
      }
      // ---- CHECKING
      phase = 'checking';
      const chk = await this.check(job);
      if ('retry' in chk) { this.store.updateTeachJob(job.id, { status: 'EXPORTED', blocked: chk.retry }); return; }
      if (this.cancelled(job.id)) return;
      // ---- READY / NEEDS_MORE
      job = this.store.getTeachJob(job.id)!;
      const draftId = await this.createLessonDraft(job, chk.checks);
      const ratio = chk.checks.taught.total ? chk.checks.taught.hits / chk.checks.taught.total : 0;
      const status: TeachStatus = !chk.checks.executed || ratio >= TAUGHT_MIN_RATIO ? 'READY' : 'NEEDS_MORE';
      this.finish(job.id, status, {
        checks: chk.checks as unknown as Record<string, unknown>, facts: chk.facts, draft_id: draftId, expires_at: job.expires_at ?? Date.now() + this.cfg.draftTtlDays * 86_400_000,
        parent_check: chk.checks.parent_check ?? null, reversibility_ok: chk.checks.reversibility_ok ?? null,
      });
      this.releaseDataset(job);
      // the private draft id stays out of the (public) message; operators see it in data
      this.log('info', `${status}: taught ${chk.checks.taught.hits}/${chk.checks.taught.total}, locality ${chk.checks.locality.same}/${chk.checks.locality.total}, parents ${chk.checks.parent_regression.hit}/${chk.checks.parent_regression.total}`, job.id, { checks: chk.checks, draft_id: draftId });
      this.checkWaitSince.delete(job.id);
    } catch (e) {
      if ((e as Error).message === STOPPING) { requeue(); return; }
      this.finish(job.id, 'FAILED', { error: (e as Error).message.slice(0, 500) });
      this.log('error', `lesson ${job.id} failed: ${(e as Error).message}`, job.id);
      this.releaseDataset(job);
    } finally {
      this.current = null;
      this.child = null;
      this.invalidatePolicy();
    }
  }

  private cancelled(id: string): boolean {
    const j = this.store.getTeachJob(id);
    if (!j?.cancel_requested) return false;
    if (j.status !== 'CANCELLED') { this.cleanupFiles(j); this.finish(id, 'CANCELLED'); }
    return true;
  }

  /**
   * PREFLIGHT: drop facts the model already answers with the context stack loaded (runtime down → keep the interactive
   * result). Above `preflight.sampleRows` questions only a deterministic sample is probed — the sample is seeded by the
   * dataset's own bytes, so re-training the same file always probes the same questions and nobody can re-roll.
   */
  private async preflightJob(job: TeachJobRow): Promise<TeachFactRow[]> {
    if (this.offline) {
      const kept = job.facts
        .filter((f) => !normAnswer(this.stubAnswer(f.prompt, f.answer)).includes(normAnswer(f.answer)))
        .map((f) => ({ ...f, base_answer: f.base_answer ?? this.stubAnswer(f.prompt, f.answer) }));
      // the same accounting the live branch writes: a question dropped here must be visible on the result screen,
      // whatever backend dropped it (design §5.12) — without this a stub node silently teaches fewer than it promised
      this.recordPreflight(job, job.facts.length, job.facts.length - kept.length);
      return kept;
    }
    const st = await this.market.runtime.status();
    if (!st.available) { this.log('warn', 'model server unavailable during preflight — keeping the interactive result', job.id); return job.facts; }
    const probe = new Set(this.sampleIndexes(job, this.cfg.preflight.sampleRows));
    const targets = await this.contextTargets(job.context, 'worker');
    const answers = await this.withStack(`teach:${job.id}:preflight`, targets, async () => {
      const res = new Map<number, string>();
      for (const i of [...probe].sort((a, b) => a - b)) res.set(i, await this.askChat(job.facts[i].prompt));
      return res;
    });
    const kept: TeachFactRow[] = [];
    for (const [i, f] of job.facts.entries()) {
      const base = answers.get(i);
      if (base === undefined) { kept.push(f); continue; }        // not sampled — kept, and counted as such below
      if (normAnswer(base).includes(normAnswer(f.answer))) { this.log('info', `already known, skipped (question ${i + 1})`, job.id); continue; }
      kept.push({ ...f, base_answer: base });
    }
    this.recordPreflight(job, probe.size, job.facts.length - kept.length);
    return kept;
  }

  /** Merge with what job creation already dropped, so `of` stays the number of questions the visitor sent. */
  private recordPreflight(job: TeachJobRow, checked: number, known: number) {
    const before = (job.preflight as { checked?: number; of?: number; known?: number; overlaps?: number } | null) ?? null;
    const of = before?.of ?? job.facts.length;
    this.store.updateTeachJob(job.id, {
      preflight: {
        // the worker re-probes questions the interactive pre-flight already measured, so the two counts overlap:
        // "checked 5 of 3" is not a number a visitor can read
        checked: Math.min(of, (before?.checked ?? 0) + checked),
        of,
        known: (before?.known ?? 0) + known,
        ...(before?.overlaps ? { overlaps: before.overlaps } : {}),
      },
    });
  }

  /**
   * Which questions a sampled step looks at (design §D4). Composition: what the trainer reported as missed first, then
   * questions whose ending is shared with others (the most likely silent failure), then a deterministic fill.
   * Seed is `sha256(dataset_sha256 + ':' + revision)` — NOT the job id: seeding by job id would let a contributor
   * re-train until a lucky draw passes the gate.
   */
  private sampleIndexes(job: TeachJobRow, budget: number): number[] {
    const n = job.facts.length;
    if (budget >= n) return [...Array(n).keys()];
    const d = job.dataset_id ? this.store.getTeachDataset(job.dataset_id) : null;
    const seed = createHash('sha256').update(`${job.dataset_sha256 ?? job.id}:${d?.revision ?? 1}`).digest('hex');
    const picked: number[] = [];
    const add = (i: number) => { if (picked.length < budget && !picked.includes(i)) picked.push(i); };
    for (const [i, f] of job.facts.entries()) if (f.hit === false) add(i);
    const endings = new Map<string, number[]>();
    for (const [i, f] of job.facts.entries()) {
      const k = endingKey(f.prompt);
      const g = endings.get(k); if (g) g.push(i); else endings.set(k, [i]);
    }
    for (const g of endings.values()) if (g.length >= 3) for (const i of g) add(i);
    for (const i of seededOrder(seed, n)) add(i);
    return picked.sort((a, b) => a - b);
  }

  // ------------------------------------------------------------ TRAINING
  private async parentSamples(job: TeachJobRow): Promise<{ prompt: string; expect: string }[]> {
    const out: { prompt: string; expect: string }[] = [];
    for (const id of job.context) {
      const e = await this.market.entry(id);
      for (const s of (e?.anchor.benchmark.samples ?? []).slice(0, 4)) out.push({ prompt: s.prompt, expect: s.expect });
    }
    return out.slice(0, 8);
  }

  /** Trainer knobs that scale with the question count (design §D15 / PR-D6). An older trainer ignores what it does not know. */
  private trainerScale(rows: number) {
    const c = this.cfg;
    return {
      max_contrast: clampInt(Math.ceil(rows / 2), 8, 64),
      micro: rows < 32 ? 16 : 64,
      eval_every_scaled: rows < 32 ? 2 : Math.ceil(rows / 32),
      eval_sample_n: Math.min(rows, c.check.sampleRows),
    };
  }

  private async train(job: TeachJobRow): Promise<{ ok: true; done: DoneEvent; facts: TeachFactRow[]; recipe: TrainerRecipe } | { ok: false; error: string }> {
    const c = this.cfg; const dir = job.job_dir!;
    const st = await this.market.runtime.status();
    const modelId = st.model ?? 'Qwen3.8-Flash-Next';
    const training = (job.training as TeachTrainingSpec | null);
    const facts = job.facts.map((f) => ({ prompt: f.prompt, answer: f.answer, ...(f.alt_prompt ? { alt_prompt: f.alt_prompt } : {}) }));
    const scale = this.trainerScale(facts.length);
    // The trained SLICE is streamed as its own file (design §D15); `facts` stays inline so a trainer that predates
    // `facts_file` still works — unknown job.json keys are ignored by both.
    writeFileSync(join(dir, 'facts.jsonl'), canonicalBytes(facts), { mode: 0o600 });
    const seed = createHash('sha256').update(`${job.dataset_sha256 ?? job.id}`).digest('hex').slice(0, 16);
    // Lineage (design §7.1): the base stack is copied next to the job so the trainer loads it BEFORE the first probe
    // and step 1 — `parents[]` in order, the base's rows as the keep-set, and what to export. A stack member whose
    // body left this node between job creation and now fails the job here, never silently trains without it.
    const parents = this.stackFiles(job, dir);
    const knownRows = existsSync(join(dir, 'known.jsonl')) ? readCanonicalJsonl(readFileSync(join(dir, 'known.jsonl'), 'utf8')).length : 0;
    const spec = {
      facts,
      facts_file: `facts.jsonl`,
      contrast: await this.parentSamples(job),
      max_steps: training?.max_steps ?? c.trainer.maxSteps,
      eval_every: training?.eval_every ?? scale.eval_every_scaled,
      lr: training?.lr ?? c.effort.lr, micro: scale.micro, max_contrast: scale.max_contrast,
      eval_sample: { n: scale.eval_sample_n, seed },
      probe_kinds: ['qa'],
      model: { id_M: modelId },
      job_id: job.id, contributor: job.contributor,
      dataset: job.dataset_sha256 ? { sha256: job.dataset_sha256, rows: job.dataset_rows ?? facts.length, source: job.dataset_source ?? 'chat' } : undefined,
      ...(parents.length ? {
        parents: parents.map((p) => ({ patch_id: p.patch_id, sha256: p.sha256, npz: c.backend === 'gradient' ? `/work/.teach/${job.id}/parents/${p.file}` : join(dir, 'parents', p.file) })),
        known_file: knownRows ? 'known.jsonl' : null,
        max_known: clampInt(Math.ceil(facts.length / 2), 8, 64),
        // the questions that deliberately override an inherited answer: trained, and kept OUT of the keep-set so the
        // trainer is not asked to hold both answers at once (§7.3)
        replaces: job.facts.flatMap((f, i) => (f.replaces ? [i] : [])),
        export: job.export_mode ?? 'delta',
        mask: { mode: 'none' },
        probe_with_parents: true,
      } : {}),
    };
    writeFileSync(join(dir, 'job.json'), JSON.stringify(spec, null, 1));
    if (c.backend === 'stub') return this.runStub(job, dir, modelId, parents);
    const args = ['exec', '-i', '-e', 'PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True', c.trainer.container, 'python3', `/work/${c.trainer.script}`, '--job', `/work/.teach/${job.id}/job.json`];
    const out = await this.runProcess(job, dir, 'docker', args);
    if (out.ok && parents.length) {
      // Nothing may be called "built on" unless the trainer confirms it loaded the stack and exported against it
      // (design §1 goal 3 / §7.5): an older trainer ignores `parents` and would hand back a stand-alone file.
      const loaded = (out.recipe.parents ?? []) as { patch_id: string; loaded?: boolean }[];
      const all = parents.every((p) => loaded.some((l) => l.patch_id === p.patch_id && l.loaded));
      if (!all || !out.recipe.export || !out.recipe.pre_state_sha256) return { ok: false, error: `trainer_no_parents: this node's trainer did not load ${parents.map((p) => p.patch_id).join(', ')} before training (it predates the on-top contract) — the lesson cannot be called built on it` };
    }
    return out;
  }

  /** Copy the base stack into `<job>/parents/<i>-<sha>.npz` (content-addressed; a reflink where the filesystem has one) and return it in order. */
  private stackFiles(job: TeachJobRow, dir: string): { patch_id: string; sha256: string; file: string; path: string }[] {
    const out: { patch_id: string; sha256: string; file: string; path: string }[] = [];
    for (const [i, b] of (job.bases ?? []).entries()) {
      const blob = this.market.blobs.get(b.sha256);
      if (!blob) throw new Error(`base_not_held: the body of ${b.patch_id} is no longer on this node`);
      const file = `${i}-${b.sha256}.npz`;
      const dest = join(dir, 'parents', file);
      if (!existsSync(dest)) {
        mkdirSync(join(dir, 'parents'), { recursive: true });
        try { copyFileSync(blob.path, dest, fsConstants.COPYFILE_FICLONE); } catch { copyFileSync(blob.path, dest); }
      }
      out.push({ patch_id: b.patch_id, sha256: b.sha256, file, path: dest });
    }
    return out;
  }

  /**
   * The additional stage-weighted `percent` (design §D5): the visible bar is always the real `step / max_steps`, this is
   * for compact surfaces only. Clamped monotonic so an early stop or a re-eval cannot walk it backwards.
   */
  private bumpPercent(p: TeachProgress) {
    const frac = p.max_steps > 0 ? Math.min(1, p.step / p.max_steps) : 0;
    const computed = p.phase === 'check' ? (PHASE_WEIGHT.load + PHASE_WEIGHT.train) * 100 + PHASE_WEIGHT.check * 50
      : p.phase === 'train' ? PHASE_WEIGHT.load * 100 + PHASE_WEIGHT.train * 100 * frac
        : PHASE_WEIGHT.load * 100 * (p.load_s === undefined ? 0.5 : 1);
    p.percent = Math.round(Math.max(p.percent ?? 0, computed));
  }

  private handleEvent(job: TeachJobRow, ev: Record<string, unknown>, state: { facts: TeachFactRow[]; progress: TeachProgress; done: DoneEvent | null; error: string | null }) {
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    state.progress.rows_total = state.progress.rows_total ?? job.facts.length;
    switch (ev.event) {
      case 'load': state.progress.load_s = n(ev.secs); state.progress.phase = 'load'; this.bumpPercent(state.progress); this.store.updateTeachJob(job.id, { progress: state.progress as unknown as Record<string, unknown> }); break;
      case 'baseline': state.progress.total = n(ev.total) ?? state.progress.total; state.progress.hits = n(ev.hits) ?? 0; break;
      case 'step': {
        state.progress.step = n(ev.step) ?? state.progress.step; state.progress.max_steps = n(ev.max_steps) ?? state.progress.max_steps;
        state.progress.loss = n(ev.loss); state.progress.hits = n(ev.hits) ?? state.progress.hits; state.progress.total = n(ev.total) ?? state.progress.total;
        state.progress.rows_touched = n(ev.rows_touched) ?? n(ev.touched) ?? state.progress.rows_touched;
        state.progress.phase = 'train';
        if (n(ev.secs) !== undefined) state.progress.avg_step_s = state.progress.avg_step_s === undefined ? n(ev.secs) : Math.round(((state.progress.avg_step_s * (state.progress.step - 1)) + n(ev.secs)!) / Math.max(1, state.progress.step) * 10) / 10;
        this.bumpPercent(state.progress);
        this.store.updateTeachJob(job.id, { progress: state.progress as unknown as Record<string, unknown> });
        this.log('info', `step ${state.progress.step}/${state.progress.max_steps} loss ${state.progress.loss ?? '-'} hits ${state.progress.hits}/${state.progress.total}`, job.id, { progress: state.progress });
        break;
      }
      case 'eval': {
        for (const f of (ev.facts as { fact: number; hits: number; total: number; heldout: number; heldout_total: number; after_answer?: string | null }[] | undefined) ?? []) {
          const t = state.facts[f.fact]; if (!t) continue;
          if (f.after_answer) t.after_answer = f.after_answer;
          t.hit = f.hits === f.total; if (f.heldout_total) t.heldout_hit = f.heldout === f.heldout_total;
        }
        state.progress.hits = n(ev.hits) ?? state.progress.hits; state.progress.total = n(ev.total) ?? state.progress.total;
        // a trainer that reports `sampled` understands `eval_sample`/`facts_file`; until one does, rowsPerJob stays at
        // the floor (design §16) — this is the only signal the node has, and it is recorded once.
        const sampled = ev.sampled as { n?: number; of?: number } | undefined;
        if (sampled && n(sampled.n) !== undefined) {
          state.progress.eval_sample = { n: n(sampled.n)!, of: n(sampled.of) ?? state.progress.rows_total ?? job.facts.length };
          if (this.cfg.backend === 'gradient' && this.store.get(TRAINER_SAMPLING_KEY) !== '1') this.store.set(TRAINER_SAMPLING_KEY, '1');
        }
        this.bumpPercent(state.progress);
        this.store.updateTeachJob(job.id, { facts: state.facts, progress: state.progress as unknown as Record<string, unknown> });
        break;
      }
      case 'done': {
        state.done = ev as unknown as DoneEvent;
        for (const f of state.done.facts ?? []) { const t = state.facts[f.fact]; if (!t) continue; if (f.base_answer && !t.base_answer) t.base_answer = f.base_answer; if (f.after_answer) t.after_answer = f.after_answer; if (typeof f.hit === 'boolean') t.hit = f.hit; if (typeof f.heldout_hit === 'boolean') t.heldout_hit = f.heldout_hit; }
        break;
      }
      case 'error': state.error = String(ev.message ?? 'trainer error'); break;
      default: break;
    }
  }

  private async runProcess(job: TeachJobRow, dir: string, cmd: string, args: string[]): Promise<{ ok: true; done: DoneEvent; facts: TeachFactRow[]; recipe: TrainerRecipe } | { ok: false; error: string }> {
    const c = this.cfg;
    const state = { facts: job.facts.map((f) => ({ ...f })), progress: { ...((job.progress as unknown as TeachProgress) ?? { step: 0, max_steps: c.trainer.maxSteps, hits: 0, total: job.facts.length }) }, done: null as DoneEvent | null, error: null as string | null };
    const child = this.spawnFn(cmd, args, { cwd: dir, env: { ...process.env } });
    this.child = child;
    let stderrTail = '';
    let timedOut = false; let killedForCancel = false;
    const timeout = setTimeout(() => { timedOut = true; this.killChild(job, child).catch(() => undefined); }, c.trainer.timeoutMs);
    const cancelPoll = setInterval(() => { if (this.store.getTeachJob(job.id)?.cancel_requested) { killedForCancel = true; this.killChild(job, child).catch(() => undefined); } }, 2000);
    // in-container pid (for cancel/timeout: killing the local docker client does not stop the python process)
    const pidLookup = setTimeout(() => {
      if (cmd !== 'docker') return;
      this.execFn('docker', ['exec', c.trainer.container, 'pgrep', '-f', `.teach/${job.id}/job.json`], 10_000)
        .then((r) => { const pid = Number(r.out.trim().split(/\s+/)[0]); if (r.code === 0 && pid) this.store.updateTeachJob(job.id, { container_pid: pid }); }).catch(() => undefined);
    }, 3000);
    child.stderr?.on('data', (d: Buffer) => { stderrTail = (stderrTail + String(d)).slice(-2000); });
    const lines = child.stdout ? createInterface({ input: child.stdout }) : null;
    lines?.on('line', (line) => {
      const s = line.trim(); if (!s.startsWith('{')) return;
      try { this.handleEvent(job, JSON.parse(s), state); } catch { /* not an event line */ }
    });
    // a final `done` line without a trailing newline is only emitted when stdout ends — wait for the reader, not just the exit
    const drained = lines ? new Promise<void>((res) => lines.once('close', () => res())) : Promise.resolve();
    const code = await new Promise<number | null>((resolve) => { child.on('error', (e: Error) => { stderrTail += ` spawn error: ${e.message}`; resolve(127); }); child.on('close', (code: number | null) => resolve(code)); });
    await Promise.race([drained, new Promise((res) => setTimeout(res, 2000))]);
    clearTimeout(timeout); clearInterval(cancelPoll); clearTimeout(pidLookup);
    this.child = null;
    if (this.stopped && !state.done) return { ok: false, error: STOPPING };
    if (killedForCancel || this.store.getTeachJob(job.id)?.cancel_requested) return { ok: false, error: 'cancelled' };
    if (timedOut) return { ok: false, error: `timeout: trainer exceeded ${Math.round(c.trainer.timeoutMs / 60000)} min` };
    if (state.error) return { ok: false, error: state.error.slice(0, 500) };
    if (code !== 0 || !state.done) return { ok: false, error: `trainer exited with code ${code}${stderrTail ? `: ${stderrTail.trim().split('\n').slice(-3).join(' | ').slice(0, 400)}` : ''}` };
    const npz = join(dir, 'lesson.npz');
    if (!existsSync(npz)) return { ok: false, error: 'trainer finished without writing lesson.npz' };
    const recipe = this.readTrainerRecipe(dir);
    return { ok: true, done: state.done, facts: state.facts, recipe };
  }

  private readTrainerRecipe(dir: string): TrainerRecipe {
    try { return JSON.parse(readFileSync(join(dir, 'recipe.json'), 'utf8')) as TrainerRecipe; } catch { return {}; }
  }

  private async killChild(job: TeachJobRow, child: ChildLike) {
    await this.killStray(job);
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 10_000).unref?.();
  }
  /** SIGTERM the in-container trainer process of `job` (by recorded pid, else by pgrep on the job path). */
  private async killStray(job: TeachJobRow) {
    if (this.cfg.backend !== 'gradient') return;
    const c = this.cfg;
    let pid = job.container_pid ?? this.store.getTeachJob(job.id)?.container_pid ?? null;
    if (!pid) { const r = await this.execFn('docker', ['exec', c.trainer.container, 'pgrep', '-f', `.teach/${job.id}/job.json`], 10_000).catch(() => null); pid = r && r.code === 0 ? Number(r.out.trim().split(/\s+/)[0]) || null : null; }
    if (pid) await this.execFn('docker', ['exec', c.trainer.container, 'kill', '-TERM', String(pid)], 10_000).catch(() => undefined);
  }

  /** Stub backend: replays the §8.2 protocol in-process and writes a real (tiny) knowledge file — CI / e2e / dev nodes without spare GPUs. */
  private async runStub(job: TeachJobRow, dir: string, modelId: string, parents: { patch_id: string; sha256: string; path: string }[] = []): Promise<{ ok: true; done: DoneEvent; facts: TeachFactRow[]; recipe: TrainerRecipe } | { ok: false; error: string }> {
    const delay = this.hooks.stubDelayMs ?? 400;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    // `hits`/`total` are QUESTIONS, the unit the progress screen names ("{hits} of {total} questions answered
    // correctly so far") — a stub that reported its two probes per question made a 3-question lesson read "6 of 6".
    const state = { facts: job.facts.map((f) => ({ ...f })), progress: { step: 0, max_steps: 3, hits: 0, total: job.facts.length }, done: null as DoneEvent | null, error: null as string | null };
    const t0 = Date.now();
    const emit = (ev: Record<string, unknown>) => this.handleEvent(job, ev, state);
    emit({ event: 'load', secs: 0.1 });
    await sleep(delay);
    for (let step = 1; step <= 3; step++) {
      if (this.stopped) return { ok: false, error: STOPPING };
      if (this.store.getTeachJob(job.id)?.cancel_requested) return { ok: false, error: 'cancelled' };
      emit({ event: 'step', step, max_steps: 3, loss: Math.round((1 / step) * 100) / 100, hits: Math.round(state.progress.total * step / 3), total: state.progress.total, secs: delay / 1000 });
      await sleep(delay);
    }
    // benchmark samples: the exact Q:/A: prefix (digit answers keep the space on the prompt side, like the real tokenizer rule)
    const samples = job.facts.map((f) => ({ prompt: `Q: ${f.prompt}\nA:${/^\d/.test(f.answer) ? ' ' : ''}`, expect: f.answer }));
    const fixture = this.hooks.fixtureNpz ?? DEFAULT_FIXTURE;
    const npz = join(dir, 'lesson.npz');
    const useFixture = existsSync(fixture) && job.facts.some((f) => f.prompt.includes('픽셀플러스')) && !parents.length;
    // one deterministic placeholder row PER QUESTION, so `result.rows` describes the file that was actually written
    // (design §1.1): nothing was learned, and every surface says so — but the count is not a lie.
    const written = this.writeStubNpz(npz, useFixture ? fixture : null, existsSync(fixture) ? fixture : null, job.id, job.facts.length, parents, job.export_mode ?? 'delta');
    const rows = written.rows;
    const facts = job.facts.map((f, i) => ({ fact: i, base_answer: f.base_answer ?? null, after_answer: f.answer, hit: true, heldout_hit: !!f.alt_prompt }));
    emit({ event: 'eval', step: 3, hits: state.progress.total, total: state.progress.total, heldout: facts.filter((f) => f.heldout_hit).length, heldout_total: facts.filter((f) => f.heldout_hit).length, facts: facts.map((f) => ({ fact: f.fact, hits: 2, total: 2, heldout: f.heldout_hit ? 1 : 0, heldout_total: f.heldout_hit ? 1 : 0, after_answer: f.after_answer })) });
    const total_s = Math.round((Date.now() - t0) / 100) / 10;
    const recipe: TrainerRecipe = {
      version: 1, trainer: 'stub', status: 'done', facts: job.facts.map((f) => ({ prompt: f.prompt, answer: f.answer, ...(f.alt_prompt ? { alt_prompt: f.alt_prompt } : {}) })),
      sentences: samples.map((s, i) => ({ kind: 'qa', fact: i, prefix: s.prompt, target: ` ${s.expect}`.replace(/^ {2}/, ' '), is_target: true })),
      benchmark_samples: samples, contrast: [], heldout: job.facts.flatMap((f, i) => (f.alt_prompt ? [{ kind: 'qa', fact: i, prompt: f.alt_prompt, prefix: `Q: ${f.alt_prompt}\nA:${/^\d/.test(f.answer) ? ' ' : ''}` }] : [])),
      hyper_params: { max_steps: 3, lr: 0, micro: 0, note: useFixture ? 'stub backend — copied the 픽셀플러스 fixture' : `stub backend — ${rows} placeholder row(s), no training happened` },
      model: { id_M: modelId }, probes: {}, rows, load_s: 0.1, train_s: total_s, step: 3, converged: true, created_at: Date.now() / 1000,
      // the on-top contract (design §7.5), honoured by the stub the way the gradient trainer will: the stack was
      // loaded into its table first, so `before` equals the parent value on every overlapping address
      ...(parents.length ? { parents: parents.map((p) => ({ patch_id: p.patch_id, sha256: p.sha256, rows: written.parentRows.get(p.sha256) ?? 0, loaded: true })), export: job.export_mode ?? 'delta', pre_state_sha256: written.pre_state_sha256, known_used: existsSync(join(dir, 'known.jsonl')) ? readCanonicalJsonl(readFileSync(join(dir, 'known.jsonl'), 'utf8')).length : 0 } : {}),
    };
    writeFileSync(join(dir, 'recipe.json'), JSON.stringify(recipe, null, 1));
    emit({ event: 'done', rows, npz, recipe: join(dir, 'recipe.json'), hits: state.progress.total, total: state.progress.total, heldout: facts.filter((f) => f.heldout_hit).length, heldout_total: facts.filter((f) => f.heldout_hit).length, converged: true, steps: 3, load_s: 0.1, train_s: total_s, avg_step_s: delay / 1000, total_s, facts });
    return { ok: true, done: state.done!, facts: state.facts, recipe };
  }

  /**
   * Copy the fixture (with a `teach_job` marker member so each lesson has its own sha256), or write `want` deterministic
   * placeholder rows — one per question. A 500-question stub `.npz` must not look like a 1-row file OR like a real
   * lesson: the row count is honest and `recipe.trainer = 'stub'` / `checks.simulated` travel with it everywhere.
   */
  private writeStubNpz(dest: string, fullFixture: string | null, rowSource: string | null, jobId: string, want = 1, parents: { patch_id: string; sha256: string; path: string }[] = [], exportMode: 'delta' | 'squash' = 'delta'): { rows: number; pre_state_sha256: string; parentRows: Map<string, number> } {
    const marker = { name: 'teach_job', descr: '|u1', shape: [jobId.length], body: Buffer.from(jobId, 'utf8') };
    const n = Math.max(1, want);
    const parentRows = new Map<string, number>();
    if (fullFixture && !parents.length) {
      const a = readNpzMember(fullFixture, 'addrs'), b = readNpzMember(fullFixture, 'before'), c = readNpzMember(fullFixture, 'after');
      writeNpz(dest, [{ name: 'addrs', descr: '<i8', shape: a.header.shape, body: a.body }, { name: 'before', descr: '<f4', shape: b.header.shape, body: b.body }, { name: 'after', descr: '<f4', shape: c.header.shape, body: c.body }, marker]);
      return { rows: a.header.shape[0], pre_state_sha256: '', parentRows };
    }
    const base = BigInt(1 + (parseInt(jobId.replace(/-/g, '').slice(0, 6), 16) % 1_000_000));
    // The stub's "table": the base stack loaded in order, last wins per address (design §7.2). A child row that
    // touches a parent address starts from the PARENT's value — `before == parent.after` on every overlap — which is
    // exactly the delta contract the gradient trainer must meet (AZ-241) and what CHECKING/apply verify later.
    const table = new Map<bigint, Buffer>();
    const diskBase = new Map<bigint, Buffer>();
    let D = 160;
    for (const p of parents) {
      const a = readNpzMember(p.path, 'addrs'), b = readNpzMember(p.path, 'before'), c = readNpzMember(p.path, 'after');
      D = c.header.shape[1];
      const rows = a.header.shape[0];
      parentRows.set(p.sha256, rows);
      for (let r = 0; r < rows; r++) {
        const addr = a.body.readBigInt64LE(8 * r);
        if (!diskBase.has(addr)) diskBase.set(addr, b.body.subarray(4 * D * r, 4 * D * (r + 1)));
        table.set(addr, c.body.subarray(4 * D * r, 4 * D * (r + 1)));
      }
    }
    if (rowSource && !parents.length) { const b = readNpzMember(rowSource, 'before'); D = b.header.shape[1]; }
    // which addresses the child touches: half of them on the parent (overlap), the rest fresh
    const overlap = parents.length ? Math.min(Math.ceil(n / 2), table.size) : 0;
    const parentAddrs = [...table.keys()].slice(0, overlap);
    const touched: bigint[] = [...parentAddrs];
    for (let r = touched.length; r < n; r++) touched.push(base + BigInt(r));
    const exportRows = exportMode === 'squash' && parents.length ? [...new Set([...touched, ...table.keys()])] : touched;
    const N = exportRows.length;
    const addrs = Buffer.alloc(8 * N); const before = Buffer.alloc(4 * D * N); const after = Buffer.alloc(4 * D * N);
    const touchedSet = new Set(touched.map(String));
    for (const [r, addr] of exportRows.entries()) {
      addrs.writeBigInt64LE(addr, 8 * r);
      const parentVal = table.get(addr);
      const disk = diskBase.get(addr);
      // delta: before = value at first touch (parent.after on overlap, disk base elsewhere); squash: before = disk base everywhere
      const bf = exportMode === 'squash' ? disk ?? null : parentVal ?? null;
      if (bf) bf.copy(before, 4 * D * r);
      if (touchedSet.has(String(addr))) {
        for (let i = 0; i < D; i++) after.writeFloatLE((parentVal ? parentVal.readFloatLE(4 * i) : 0) + 0.01, 4 * (D * r + i));
      } else if (parentVal) {
        parentVal.copy(after, 4 * D * r);   // squash: an untouched parent row is carried as it is
      }
    }
    const preState = preStateSha256(new BigInt64Array(addrs.buffer, addrs.byteOffset, N), new Float32Array(before.buffer, before.byteOffset, N * D), D);
    const members = [{ name: 'addrs', descr: '<i8', shape: [N], body: addrs }, { name: 'before', descr: '<f4', shape: [N, D], body: before }, { name: 'after', descr: '<f4', shape: [N, D], body: after }, marker];
    if (parents.length) {
      // the `meta` member (design §5.4): a bare file is self-describing to scripts/patch.py and RUN-LOCALLY users
      const meta = JSON.stringify({ export: exportMode, base_stack: exportMode === 'delta' ? parents.map((p) => ({ patch_id: p.patch_id, patch_sha256: p.sha256 })) : [], pre_state_sha256: preState, trainer_version: 'stub' });
      members.push({ name: 'meta', descr: '|u1', shape: [Buffer.byteLength(meta)], body: Buffer.from(meta, 'utf8') });
    }
    writeNpz(dest, members);
    return { rows: N, pre_state_sha256: preState, parentRows };
  }

  // ------------------------------------------------------------ CHECKING (spec §8.3) — the only step besides preview that touches the serving model
  private async check(job: TeachJobRow): Promise<{ checks: TeachChecks; facts: TeachFactRow[] } | { retry: 'lock' | 'runtime' }> {
    const c = this.cfg; const rt = this.market.runtime;
    const recipe = this.readTrainerRecipe(job.job_dir!);
    const facts = job.facts.map((f) => ({ ...f }));
    const training = job.training as TeachTrainingSpec | null;
    const sideEffects = training?.check_side_effects !== false;
    if (this.offline) {
      // simulated checks: the lesson is never applied, nothing is measured (stub backend on a node without a model server)
      this.store.updateTeachJob(job.id, { status: 'CHECKING', blocked: null });
      await new Promise((r) => setTimeout(r, this.hooks.stubDelayMs ?? 400));
      const localityFail = facts.some((f) => /LOCALITY_FAIL/.test(`${f.prompt} ${f.answer}`));
      const held = facts.filter((f) => f.alt_prompt).length;
      for (const f of facts) { f.after_answer = f.answer; f.hit = true; if (f.alt_prompt) f.heldout_hit = true; }
      // the stack (bases first, comparison loads after) is "checked" the way the live branch measures it: nothing here is a number
      const stackIds = [...(job.bases ?? []).map((b) => b.patch_id), ...job.context.filter((id) => !(job.bases ?? []).some((b) => b.patch_id === id))];
      const parentCheck: NonNullable<TeachChecks['parent_check']> = [];
      for (const id of stackIds) {
        const e = await this.market.entry(id);
        const n = Math.min(e?.anchor.benchmark.samples?.length ?? 0, c.check.parentSamplesMax);
        parentCheck.push({ patch_id: id, hit: n, total: n, failed: [], simulated: true });
      }
      const checks: TeachChecks = {
        executed: true, taught: { hits: facts.length * 2, total: facts.length * 2 }, heldout: { hits: held, total: held },
        parent_regression: { ok: true, hit: parentCheck.reduce((a, b) => a + b.hit, 0), total: parentCheck.reduce((a, b) => a + b.total, 0) },
        locality: { ok: !localityFail, same: localityFail ? Math.max(0, c.locality.minSame - 1) : c.locality.prompts.length, total: c.locality.prompts.length },
        reverted_and_reapplied: false, ok: !localityFail, note: 'stub backend (offline) — checks were simulated, not measured in a live model', simulated: true,
        ...(parentCheck.length ? { parent_check: parentCheck } : {}), reversibility_ok: null,
      };
      // A visitor who switched the side-effect check off must not be shown a locality score, simulated or not: on this
      // backend the number would be invented twice over. Same shape as the live branch, so the screen says the same thing.
      if (!sideEffects) {
        checks.skipped = true;
        checks.locality = { ok: false, same: 0, total: c.locality.prompts.length };
        checks.parent_regression = { ok: false, hit: 0, total: 0 };
        checks.ok = false;
        checks.note = 'the side-effect check was turned off for this lesson — nothing was measured about unrelated answers';
      }
      return { checks, facts };
    }
    const st = await rt.status(true);
    const notExecuted = (note: string): { checks: TeachChecks; facts: TeachFactRow[] } => ({
      facts, checks: { executed: false, taught: { hits: 0, total: 0 }, heldout: { hits: 0, total: 0 }, parent_regression: { ok: false, hit: 0, total: 0 }, locality: { ok: false, same: 0, total: c.locality.prompts.length }, reverted_and_reapplied: false, ok: false, note },
    });
    if (!st.available) {
      const since = this.checkWaitSince.get(job.id) ?? Date.now();
      this.checkWaitSince.set(job.id, since);
      if (Date.now() - since < this.graceMs) { if (job.blocked !== 'runtime') this.log('info', `model server unavailable (${st.error ?? 'no model'}) — waiting before checking`, job.id); return { retry: 'runtime' }; }
      this.log('warn', 'model server stayed unavailable for 15 min — lesson is saved unchecked (publish gated)', job.id);
      return notExecuted('model server unavailable — checks were not executed');
    }
    this.store.updateTeachJob(job.id, { status: 'CHECKING', blocked: null });
    // The stack in DEPLOYMENT ORDER (design §7.6): the bases the lesson was trained on top of, ancestors first, then
    // the knowledges loaded for comparison. Everything below the lesson is applied before it and measured with the
    // lesson ON TOP — the order a buyer will run, not the reverse (F6). A base whose body is gone fails the check.
    const baseTargets: { id: string; entry: CatalogEntry; path: string }[] = [];
    for (const b of job.bases ?? []) {
      const entry = await this.market.entry(b.patch_id);
      const blob = this.market.blobs.get(b.sha256);
      if (!entry || !blob) throw new Error(`base_not_held: the body of ${b.patch_id} is no longer on this node — the lesson cannot be checked on top of it`);
      baseTargets.push({ id: b.patch_id, entry, path: blob.path });
    }
    const contextTargets = await this.contextTargets(job.context.filter((id) => !baseTargets.some((b) => b.id === id)), 'worker').catch(() => [] as { id: string; entry: CatalogEntry; path: string }[]);
    const targets = [...baseTargets, ...contextTargets];
    const samples = (recipe.benchmark_samples?.length ? recipe.benchmark_samples : facts.map((f) => ({ prompt: `Q: ${f.prompt}\nA: `, expect: f.answer })));
    const lesson = job.npz_path!;
    // One journal per lesson body, beside the hook mailbox (§5.4). Without a sha (a job whose export never finished)
    // there is no content address to name it by, and the remove falls back to the file's own `before`.
    const lessonJournal = job.sha256 ? this.market.runtime.journalPath(job.sha256) ?? undefined : undefined;
    try {
      const out = await rt.exclusiveTry(`teach:${job.id}:check`, async () => {
        const wasApplied = new Map<string, boolean>();
        for (const t of targets) wasApplied.set(t.path, (await rt.isApplied(t.path)) === true);
        let reverted = false;
        const checks: TeachChecks = { executed: true, taught: { hits: 0, total: 0 }, heldout: { hits: 0, total: 0 }, parent_regression: { ok: true, hit: 0, total: 0 }, locality: { ok: true, same: 0, total: c.locality.prompts.length }, reverted_and_reapplied: false, ok: false, reversibility_ok: null };
        try {
          /*
           * Call budget (design §D4). The live-model check costs a FIXED number of calls whatever the dataset size —
           * the v1 census was already ~78 sequential calls at 8 questions, which at the only measured figure on this
           * host (4.25 s per completion) is ~5.5 min of held runtime lock. The 12 locality prompts are never trimmed:
           * they are the publish gate. What scales down instead is how many taught questions are re-asked.
           */
          const localityCost = sideEffects ? 3 * c.locality.prompts.length : 0;   // baseline x2 (stability) + once after
          // Every base question is asked TWICE — once with the stack loaded and the lesson not on top yet (§7.6 step
          // 3), once after — so a question the base already fails on this node is never blamed on the child. That
          // doubling is why the reserve is a QUARTER of what the locality gate leaves: the lesson's own questions
          // still have to be re-asked, and a check that measures the base twice and the lesson never is no check.
          const room = Math.max(0, c.check.callBudget - localityCost);
          const haveSamples = targets.reduce((n, t) => n + (t.entry.anchor.benchmark.samples?.length ?? 0), 0);
          const parentBudget = sideEffects && targets.length ? Math.min(c.check.parentSamplesMax, haveSamples, Math.max(targets.length, Math.floor(room / 4))) : 0;
          const perTarget = targets.length ? Math.ceil(parentBudget / targets.length) : 0;
          const parentSamples = perTarget * targets.length;
          const parentReserve = parentSamples * 2;
          let taughtBudget = Math.max(0, c.check.callBudget - localityCost - parentReserve);
          const sample = this.sampleIndexes({ ...job, facts }, Math.min(facts.length, c.check.sampleRows));
          // 1) remove the context stack → clean table; locality baseline
          for (const t of [...targets].reverse()) if (wasApplied.get(t.path)) await rt.removeRaw(t.path);
          // Each locality prompt is asked TWICE with nothing applied. vLLM's continuous batching makes a greedy
          // generation only *usually* reproducible, so a prompt that already disagrees with itself can never be
          // evidence that the LESSON changed an answer — it is dropped from the gate and counted in `unstable`.
          const stable: { prompt: string; base: string }[] = [];
          let unstable = 0;
          if (sideEffects) {
            for (const p of c.locality.prompts) {
              const a = await this.askChat(p, 48); const b = await this.askChat(p, 48);
              if (a === b) stable.push({ prompt: p, base: a }); else unstable++;
            }
            if (unstable) this.log('info', `${unstable} of ${c.locality.prompts.length} side-effect prompts are not repeatable on this model — left out of the gate`, job.id);
          }
          // 2) the stack BELOW the lesson, in order (bases first); then the lesson on top; measure (once more if the
          //    table reverted mid-way — serving restart)
          for (const t of targets) { const ap = await rt.applyRaw(t.path); if (ap.code !== 0) throw new Error(`apply ${t.id} failed: ${ap.err || ap.out}`); }
          /*
           * §7.6 step 3 — the parent baseline, measured HERE: the stack is loaded, the lesson is not on top yet. The
           * questions this lesson deliberately replaces come first (they are the ones a reader will ask about), then
           * the rest in order. Without this pass a question the base itself gets wrong on this node reads as "your
           * lesson broke it", which is both false and unfixable by the creator.
           */
          const overrides = facts.filter((f) => f.replaces);
          const plan = targets.map((t) => {
            const all = (t.entry.anchor.benchmark.samples ?? []).map((s, i) => ({ i, s, overridden: overrides.some((f) => s.prompt.includes(f.prompt)) }));
            const ordered = [...all.filter((x) => x.overridden), ...all.filter((x) => !x.overridden)];
            return { id: t.id, samples: ordered.slice(0, perTarget) };
          });
          const baseline = new Map<string, Map<number, boolean>>();
          if (sideEffects && parentSamples) {
            for (const p of plan) {
              const m = new Map<number, boolean>();
              for (const { i, s } of p.samples) { const got = await this.askRaw(s.prompt, 16); m.set(i, got.startsWith(s.expect)); }
              baseline.set(p.id, m);
            }
          }
          for (let attempt = 0; attempt < 2; attempt++) {
            if (this.stopped) throw new Error(STOPPING);
            this.store.updateTeachJob(job.id, { lesson_applied: true });   // persisted BEFORE the apply: a crash from here on must restore the table
            // The journal records the values this apply overwrote (the base stack's, when there is one), so removing
            // the lesson afterwards restores THEM — and so reversibility can be measured rather than assumed (§8, SC-7).
            const ap = await rt.applyRaw(lesson, { journal: lessonJournal }); if (ap.code !== 0) throw new Error(`apply failed: ${ap.err || ap.out}`);
            checks.taught = { hits: 0, total: 0 }; checks.heldout = { hits: 0, total: 0 };
            let spent = 0; let measured = 0;
            for (const [n, i] of sample.entries()) {
              const f = facts[i];
              const chatForm = n < c.check.chatFormRows;                  // only the head also gets the chat rendering
              const wantAlt = chatForm && !!f.alt_prompt;
              const cost = 1 + (chatForm ? 1 : 0) + (wantAlt ? 1 : 0);
              if (spent + cost > taughtBudget) break;
              spent += cost; measured++;
              const s = samples[i] ?? { prompt: `Q: ${f.prompt}\nA: `, expect: f.answer };
              const raw = await this.askRaw(s.prompt, 16); const rawHit = raw.startsWith(s.expect) || normAnswer(raw).startsWith(normAnswer(s.expect));
              let chatHit = false;
              if (chatForm) { const chat = await this.askChat(f.prompt, 48); chatHit = normAnswer(chat).includes(normAnswer(f.answer)); f.after_answer = chat; }
              f.hit = rawHit || chatHit;
              checks.taught.total += chatForm ? 2 : 1; checks.taught.hits += (rawHit ? 1 : 0) + (chatHit ? 1 : 0);
              if (wantAlt) { const alt = await this.askChat(f.alt_prompt!, 48); f.heldout_hit = normAnswer(alt).includes(normAnswer(f.answer)); checks.heldout.total++; if (f.heldout_hit) checks.heldout.hits++; }
            }
            // Never a whole-dataset claim from a sampled check — and never a per-question one either: every question
            // this loop did not re-ask keeps the TRAINER's optimistic verdict, so it is cleared here and counted as
            // unmeasured by the result screen (design §5.12).
            const asked = new Set(sample.slice(0, measured));
            for (const [i, f] of facts.entries()) {
              if (asked.has(i)) continue;
              delete f.hit; delete f.after_answer; delete f.heldout_hit;
            }
            if (measured < facts.length) checks.taught.sampled = { checked: measured, of: facts.length };
            else delete checks.taught.sampled;
            if (sideEffects) {
              let same = 0;
              for (const q of stable) if ((await this.askChat(q.prompt, 48)) === q.base) same++;
              // `minSame` states a TOLERANCE ("at most `prompts - minSame` may change"), and that is what carries over
              // to the measurable subset. Rescaling it as a ratio would silently demand perfection: 11/12 over 9
              // prompts rounds up to 9 of 9, i.e. a stricter gate than the operator asked for.
              const allowed = Math.max(0, c.locality.prompts.length - c.locality.minSame);
              // …but a gate decided on two prompts is not a gate. At least half the configured list must be measurable.
              const enough = stable.length >= Math.ceil(c.locality.prompts.length / 2);
              checks.locality = { ok: enough && same >= stable.length - allowed, same, total: stable.length, ...(unstable ? { unstable } : {}) };
            }
            const still = await rt.isApplied(lesson);
            if (still === false && attempt === 0) {
              reverted = true; this.log('warn', 'table reverted during the check (serving restart?) → re-apply & re-measure', job.id);
              for (const t of targets) await rt.applyRaw(t.path).catch(() => undefined);
              continue;
            }
            break;
          }
          // 3) parent regression: each knowledge of the stack re-asked with the lesson ON TOP (design §7.6 step 5),
          //    per knowledge so SC-7 can name the one that broke and which questions; every question the child
          //    overrides would be included first (none yet — overrides land with the fork PR).
          if (sideEffects && targets.length) {
            checks.parent_check = [];
            for (const p of plan) {
              const pc = { patch_id: p.id, hit: 0, total: 0, failed: [] as number[], base_hit: 0, base_total: 0, base_failed: [] as number[], overridden: 0 };
              const wasOk = baseline.get(p.id) ?? new Map<number, boolean>();
              for (const { i, s, overridden } of p.samples) {
                const got = await this.askRaw(s.prompt, 16);
                const hit = got.startsWith(s.expect);
                pc.base_total++; if (wasOk.get(i)) pc.base_hit++;
                // a question the child says it replaces is SUPPOSED to answer differently now (§7.6 step 5)
                if (overridden) { pc.overridden++; continue; }
                // a question the base does not answer on this node either is not evidence about the child
                if (wasOk.get(i) === false) { pc.base_failed.push(i); continue; }
                pc.total++; checks.parent_regression.total++;
                if (hit) { pc.hit++; checks.parent_regression.hit++; } else pc.failed.push(i);
              }
              checks.parent_check.push(pc);
            }
            // ≥ 0.9 PER knowledge (design §7.6): one broken base fails the check even when the sum still passes
            const perOk = checks.parent_check.every((pc) => pc.total === 0 || pc.hit / pc.total >= 0.9);
            checks.parent_regression.ok = perOk && (checks.parent_regression.total === 0 || checks.parent_regression.hit / checks.parent_regression.total >= 0.9);
            for (const pc of checks.parent_check) if (pc.total && pc.hit / pc.total < 0.9) this.store.bumpSignals(pc.patch_id, { parent_regression_fails: 1 });
          }
        } finally {
          // never leave the lesson applied; put the table back the way we found it: the lesson first, then the
          // stack in reverse, then whatever was applied before us and the operator-pinned set
          const removed = await rt.removeRaw(lesson, { journal: lessonJournal }).then(() => true).catch((e) => { this.log('error', `could not remove the lesson after checking: ${(e as Error).message}`, job.id); return false; });
          if (removed) {
            this.store.updateTeachJob(job.id, { lesson_applied: false });
            // SC-7 `teach.res.reversible`: the lesson is reversible when EVERY row it wrote is back at the value it
            // was written over — read from the live table, before the stack underneath comes off.
            const back = await rt.check(lesson).catch(() => null);
            if (back) {
              checks.reversibility_ok = back.differ_before === 0;
              if (!back.ok) this.log('warn', `after removing the lesson ${back.differ_before} of ${back.rows} rows are not back where they were`, job.id);
            }
          } else this.pendingRestore.add(job.id);
          for (const t of [...targets].reverse()) await rt.removeRaw(t.path).catch(() => undefined);
          for (const t of targets) if (wasApplied.get(t.path)) await rt.applyRaw(t.path).catch(() => undefined);
          await this.reassertPinned();
        }
        checks.reverted_and_reapplied = reverted;
        if (!sideEffects) {
          // the visitor turned the check off: nothing was measured about side effects, so publish stays gated until
          // `POST /:id/recheck` measures it — the lesson itself is unaffected and can still be kept private
          checks.skipped = true; checks.locality = { ok: false, same: 0, total: c.locality.prompts.length };
          checks.parent_regression = { ok: false, hit: 0, total: 0 };
          checks.note = 'the side-effect check was turned off for this lesson — nothing was measured about unrelated answers';
        }
        checks.ok = checks.locality.ok && checks.parent_regression.ok;
        return checks;
      }, { waitMs: 2 * 60_000 });
      return { checks: out, facts };
    } catch (e) {
      if ((e as Error).message === STOPPING) throw e;
      if (/shared runtime busy/.test((e as Error).message)) { this.log('info', 'model server busy → check postponed', job.id); return { retry: 'lock' }; }
      if (TeachWorker.isRuntimeOutage(e)) {
        // vLLM stalls roughly hourly and restarts in ~5 min: keep the lesson, retry the whole check later (15-min grace, then unchecked READY)
        const since = this.checkWaitSince.get(job.id) ?? Date.now();
        this.checkWaitSince.set(job.id, since);
        if (Date.now() - since < this.graceMs) { this.log('warn', `model server stalled during the check (${(e as Error).message}) → retrying later`, job.id); return { retry: 'runtime' }; }
        this.log('warn', 'model server kept stalling for 15 min — lesson is saved unchecked (publish gated)', job.id);
        return notExecuted(`model server unavailable — checks were not executed (${(e as Error).message})`);
      }
      throw e;
    }
  }

  // ------------------------------------------------------------ READY → private draft (spec §8.3)
  private async createLessonDraft(job: TeachJobRow, checks: TeachChecks): Promise<string> {
    const recipe = this.readTrainerRecipe(job.job_dir!);
    const st = await this.market.runtime.status();
    const modelId = (recipe.model?.id_M as string | undefined) ?? st.model ?? 'Qwen3.8-Flash-Next';
    const slug = slugify(job.name?.replace(/^Lesson:\s*/, '') ?? job.facts[0].prompt);
    const hex = randomBytes(3).toString('hex');
    const id = `taught-${slug}-${hex}`;
    const samples = [...(recipe.benchmark_samples?.length ? recipe.benchmark_samples : job.facts.map((f) => ({ prompt: `Q: ${f.prompt}\nA: `, expect: f.answer })))];
    for (const h of recipe.heldout ?? []) { const f = job.facts[h.fact]; if (f?.heldout_hit && h.kind === 'qa' && h.prefix) samples.push({ prompt: h.prefix, expect: f.answer }); }
    const probe = { hits: checks.taught.hits, total: checks.taught.total, heldout_hits: checks.heldout.hits };
    const ds = job.dataset_id ? this.store.getTeachDataset(job.dataset_id) : null;
    const recipeDataset = job.dataset_sha256 ? { sha256: job.dataset_sha256, rows: job.dataset_rows ?? job.facts.length, revision: ds?.revision ?? 1, source: (job.dataset_source ?? 'chat') as TeachDatasetSource, ...(ds?.name ? { name: ds.name } : {}) } : undefined;
    const lineage = await this.lineageFields(job, recipe, samples);
    // the FULL sample list beside the job (design §5.2): these exact bytes are the `answers_hash` preimage and are
    // what the published training set carries as `benchmark.jsonl`, so a verifier can recompute the hash on the record
    if (job.job_dir) writeFileSync(join(job.job_dir, 'benchmark.jsonl'), encodeBenchmarkJsonl(lineage.full), { mode: 0o600 });
    // re-check of an existing draft (model server was down the first time): keep the id, refresh benchmark + probe
    const existing = job.draft_id ? this.store.getDraft(job.draft_id) : null;
    if (existing) {
      const b = lessonBenchmark(existing.anchor.benchmark.schema, lineage.samples);
      if (lineage.answers_hash) b.answers_hash = lineage.answers_hash;
      this.market.updateDraft(existing.id, { benchmark: b, recipe: anchorRecipe(recipe, modelId, probe, recipeDataset) });
      return existing.id;
    }
    const benchmark = lessonBenchmark(`taught/${slug}-${hex}`, lineage.samples);
    if (lineage.answers_hash) benchmark.answers_hash = lineage.answers_hash;
    const listed = new Set((await this.market.catalog()).filter((e) => e.status === 'LISTED').map((e) => e.anchor.id));
    // legacy `builds_on` (declared parents, never trained on top) stays as it was; a base stack is recorded whole
    const parents = lineage.parents ?? (job.builds_on ? job.context.filter((p) => listed.has(p)) : []);
    const anchor = await this.market.createDraft({
      id, name: job.name ?? `Lesson ${hex}`, description: '', model: { id_M: modelId }, benchmark,
      recipe: anchorRecipe(recipe, modelId, probe, recipeDataset),
      // hashes and counts on the anchor (design §5.1): the sha256 identifies the exact bytes, the blob store holds them
      ...(recipeDataset ? { dataset: { sha256: job.snapshot_sha256 ?? recipeDataset.sha256, rows: recipeDataset.rows, source: recipeDataset.source, access: lineage.defaultAccess, ...(lineage.datasetParents ? { parents: lineage.datasetParents } : {}) } } : {}),
      ...(lineage.derivation ? { derivation: lineage.derivation } : {}),
      ...(lineage.base ? { base: lineage.base } : {}),
      file: job.npz_path!, keepInPlace: true, parents, visibility: 'test', origin: 'teach', price: '0',
    });
    return anchor.id;
  }

  /**
   * What this lesson's training set did with the base's questions (design §6.3): which rows are still the base's and
   * which of ITS rows they are (`row_origin`), which answers were changed (`changed`), and which of the base's
   * questions are not here any more (`removed`). Computed from the snapshot — the bytes that will be published — and
   * from the base's own set, so a verifier recomputes exactly these numbers instead of trusting the publisher.
   */
  private inheritance(rows: CanonicalRow[], baseId: string, parentRows: number): { row_origin: (string | null)[]; changed: number[]; removed: number[]; inherited: number } {
    const row_origin: (string | null)[] = []; const changed: number[] = []; const seen = new Set<number>();
    let inherited = 0;
    for (const [i, r] of rows.entries()) {
      const ref = r.from ?? r.replaces;
      const from = rowRefPatch(ref) === baseId ? ref! : null;
      row_origin.push(r.from && rowRefPatch(r.from) === baseId ? r.from : null);
      if (from) { const at = rowRefIndex(from); if (at !== null) seen.add(at); if (r.from) inherited++; else changed.push(i); }
    }
    const removed = parentRows ? Array.from({ length: parentRows }, (_, i) => i).filter((i) => !seen.has(i)) : [];
    return { row_origin, changed, removed, inherited };
  }

  /** The bytes a published lesson carries: the job's snapshot, else the dataset it was trained from. */
  private snapshotRows(j: TeachJobRow): CanonicalRow[] {
    const snapshot = j.job_dir ? join(j.job_dir, 'snapshot.jsonl') : null;
    if (snapshot && existsSync(snapshot)) return readCanonicalJsonl(readFileSync(snapshot, 'utf8'));
    if (j.dataset_id) { const d = this.store.getTeachDataset(j.dataset_id); if (d) return this.datasets.rows(d); }
    return [];
  }

  /**
   * What the anchor says about its bases (design §5.1), from the job's stack and what the trainer confirmed:
   * `parents` = the whole ordered stack (so every ancestor is credited and paid), `derivation` = extend over the
   * direct base with the rows loaded as the keep-set, `base` = the stack + export + `pre_state_sha256` from the recipe
   * (only when the trainer confirmed it loaded the stack), `dataset.parents` = the base's training set. The on-chain
   * samples are the child's own first, then one per base (never from a Proprietary base), capped at 32 with the hash
   * of the full list.
   */
  private async lineageFields(job: TeachJobRow, recipe: TrainerRecipe, own: { prompt: string; expect: string }[]) {
    const stack = job.bases ?? [];
    const teach = job.snapshot_sha256 !== null || job.dataset_sha256 !== null;
    if (!stack.length) {
      const capped = teach ? capBenchmarkSamples(own) : { samples: own, full: own, answers_hash: undefined };
      return { samples: capped.samples, full: capped.full, answers_hash: capped.answers_hash, parents: undefined, derivation: undefined, base: undefined, datasetParents: undefined, defaultAccess: 'derivative' as DatasetAccess };
    }
    const direct = stack[stack.length - 1];
    const entries = new Map<string, CatalogEntry>();
    for (const b of stack) { const e = await this.market.entry(b.patch_id); if (e) entries.set(b.patch_id, e); }
    const de = entries.get(direct.patch_id);
    const knownRows = job.job_dir && existsSync(join(job.job_dir, 'known.jsonl')) ? readCanonicalJsonl(readFileSync(join(job.job_dir, 'known.jsonl'), 'utf8')).length : 0;
    const perParent = stack.map((b) => {
      const e = entries.get(b.patch_id);
      const proprietary = deltaOnlyParent(e?.anchor.dataset?.license);
      return { patch_id: b.patch_id, sample: proprietary ? undefined : e?.anchor.benchmark.samples?.[0] };
    });
    const capped = capBenchmarkSamples(own, perParent);
    const inh = this.inheritance(this.snapshotRows(job), direct.patch_id, de?.anchor.dataset?.rows ?? 0);
    const loaded = (recipe.parents ?? []) as { patch_id: string; loaded?: boolean }[];
    const confirmed = stack.every((b) => loaded.some((l) => l.patch_id === b.patch_id && l.loaded)) && typeof recipe.pre_state_sha256 === 'string';
    const exportMode = (recipe.export as 'delta' | 'squash' | undefined) ?? job.export_mode ?? 'delta';
    return {
      samples: capped.samples, full: capped.full, answers_hash: capped.answers_hash,
      parents: stack.map((b) => b.patch_id),
      derivation: { kind: 'extend' as const, bases: [{ patch_id: direct.patch_id, patch_sha256: direct.sha256, ...(de?.anchor.dataset?.sha256 ? { dataset_sha256: de.anchor.dataset.sha256 } : {}), rows: inh.inherited || knownRows }], added_rows: job.facts.length - inh.changed.length, changed_rows: inh.changed.length, removed_rows: inh.removed.length },
      base: confirmed ? { stack: exportMode === 'delta' ? stack.map((b) => ({ patch_id: b.patch_id, patch_sha256: b.sha256 })) : [], export: exportMode, pre_state_sha256: recipe.pre_state_sha256 as string } : undefined,
      datasetParents: (inh.inherited || knownRows) && de?.anchor.dataset?.sha256 ? [{ patch_id: direct.patch_id, sha256: de.anchor.dataset.sha256, rows: inh.inherited || knownRows }] : undefined,
      defaultAccess: 'derivative' as DatasetAccess,
    };
  }

  /** Measure again a lesson that was saved unchecked because the model server was down (owner or operator). */
  recheck(j: TeachJobRow): { ok: true; status: 'EXPORTED' } {
    if (!['READY', 'NEEDS_MORE'].includes(j.status) || j.publish_status !== 'none') throw new TeachError(409, `job_not_ready: lesson is ${j.status} and cannot be re-checked`);
    const checks = j.checks as unknown as TeachChecks | null;
    if (checks?.executed && !checks.skipped) throw new TeachError(409, 'job_not_ready: this lesson was already checked in the live model');
    if (!j.npz_path || !existsSync(j.npz_path)) throw new TeachError(409, 'job_not_ready: knowledge file is missing');
    this.checkWaitSince.delete(j.id);
    // "Run the check now" means MEASURE what was skipped: without turning the flag on, the re-check would read the
    // lesson's stored `check_side_effects: false` and skip it again, leaving the publish gate shut for ever.
    const training = j.training as TeachTrainingSpec | null;
    const retrain = checks?.skipped && training && training.check_side_effects === false ? { training: { ...training, check_side_effects: true } } : {};
    this.store.updateTeachJob(j.id, { status: 'EXPORTED', blocked: null, finished_at: null, ...retrain });
    this.log('info', `lesson ${j.id} queued for a re-check`, j.id);
    this.invalidatePolicy();
    return { ok: true, status: 'EXPORTED' };
  }

  // ------------------------------------------------------------ save (spec §6.2 POST /api/teach/jobs/:id/save)
  save(j: TeachJobRow, address: string): { download: { npz_url: string; recipe_url: string; readme_url: string; expires_at: number }; sha256: string; rows: number; size_bytes: number; filename: string; repo_url: string; model_id: string | null } {
    if (!j.result || !j.sha256 || !j.npz_path || !existsSync(j.npz_path)) throw new TeachError(409, 'job_not_ready: this lesson has no knowledge file yet');
    if (!this.market.blobs.get(j.sha256)) throw new TeachError(409, 'job_not_ready: knowledge file is not registered on this node');
    const ttl = this.cfg.draftTtlDays * 86_400_000;
    const token = randomBytes(24).toString('hex');
    this.store.putToken(token, j.sha256, `contrib:${address}`, ttl);
    const q = `?token=${token}`;
    const filename = this.filename(j);
    return {
      // `name=` only sets the download filename: RUN-LOCALLY.md's commands are written against `lesson-….npz`, so a
      // browser that saves the bytes as `<sha>.npz` leaves the visitor with a document that does not match their disk.
      download: { npz_url: `/p2p/blob/${j.sha256}${q}&name=${encodeURIComponent(filename)}`, recipe_url: `/api/teach/jobs/${j.id}/recipe${q}`, readme_url: `/api/teach/jobs/${j.id}/local-run${q}`, expires_at: Date.now() + ttl },
      sha256: j.sha256, rows: j.result.rows, size_bytes: j.result.size_bytes, filename,
      // same repo / model the RUN-LOCALLY.md names — the web sheet builds its command block from these, not from constants
      repo_url: LOCAL_RUN_REPO_URL, model_id: (j.draft_id ? this.store.getDraft(j.draft_id)?.anchor.model.id_M : undefined) ?? (this.readTrainerRecipe(j.job_dir ?? '').model?.id_M as string | undefined) ?? null,
    };
  }
  filename(j: TeachJobRow): string { return `lesson-${(j.draft_id ?? `lesson-${j.id.slice(0, 6)}`).replace(/^taught-/, '')}.npz`; }
  tokenOk(j: TeachJobRow, token: string | undefined): boolean { return !!token && !!j.sha256 && this.store.checkToken(token, j.sha256); }

  async recipeJson(j: TeachJobRow): Promise<Record<string, unknown>> {
    const tr = this.readTrainerRecipe(j.job_dir ?? '');
    const draft = j.draft_id ? await this.market.entry(j.draft_id) : null;
    const st = await this.market.runtime.status();
    const modelId = draft?.anchor.model.id_M ?? (tr.model?.id_M as string | undefined) ?? st.model ?? 'Qwen3.8-Flash-Next';
    const meta: LessonMeta = {
      job_id: j.id, draft_id: j.draft_id, name: j.name ?? '', model_id: modelId, sha256: j.sha256 ?? '', rows: j.result?.rows ?? 0, size_bytes: j.result?.size_bytes ?? 0, filename: this.filename(j),
      facts: j.facts.map((f) => ({ prompt: f.prompt, answer: f.answer, ...(f.alt_prompt ? { alt_prompt: f.alt_prompt } : {}), ...(f.hit !== undefined ? { hit: f.hit } : {}), ...(f.heldout_hit !== undefined ? { heldout_hit: f.heldout_hit } : {}) })),
      contributor: { address: j.contributor, ...(j.contributor_name ? { name: j.contributor_name } : {}) }, context_patch_ids: j.context, builds_on_context: j.builds_on,
      ...(j.dataset_sha256 ? { dataset: { sha256: j.dataset_sha256, rows: j.dataset_rows ?? j.facts.length, revision: (j.dataset_id ? this.store.getTeachDataset(j.dataset_id)?.revision : 1) ?? 1, source: j.dataset_source ?? 'chat', trained_rows: j.facts.length } } : {}),
      checks: j.checks, created_at: j.created_at, node: { address: this.market.address, name: this.market.cfg.name, url: this.market.publicUrl },
    };
    return buildRecipeJson(tr, meta, draft?.anchor.benchmark ?? lessonBenchmark(`taught/${j.id.slice(0, 8)}`, tr.benchmark_samples ?? []));
  }
  async runLocallyMd(j: TeachJobRow, token: string): Promise<string> {
    const draft = j.draft_id ? await this.market.entry(j.draft_id) : null;
    const st = await this.market.runtime.status();
    const tr = this.readTrainerRecipe(j.job_dir ?? '');
    const parents: { id: string; name: string }[] = [];
    const required = !!(j.bases?.length && (j.export_mode ?? 'delta') === 'delta');
    for (const id of required ? j.bases!.map((b) => b.patch_id) : j.context) { const e = await this.market.entry(id); if (e) parents.push({ id, name: e.anchor.name }); }
    return renderRunLocally({
      model_id: draft?.anchor.model.id_M ?? (tr.model?.id_M as string | undefined) ?? st.model ?? 'Qwen3.8-Flash-Next-W4A16', sha256: j.sha256 ?? '', filename: this.filename(j),
      download_url: `${this.market.publicUrl}/p2p/blob/${j.sha256}?token=${token}`, recipe_url: `${this.market.publicUrl}/api/teach/jobs/${j.id}/recipe?token=${token}`,
      first_prompt: j.facts[0]?.prompt ?? '', slug: (j.draft_id ?? `lesson-${j.id.slice(0, 6)}`).replace(/^taught-/, ''), parents, parents_required: required,
    });
  }

  // ------------------------------------------------------------ publish (spec §6.2 / §9)
  private draftFor(j: TeachJobRow) {
    if (j.status !== 'READY') throw new TeachError(409, j.status === 'NEEDS_MORE' ? 'job_not_ready: the lesson did not stick well enough — improve and retry first' : `job_not_ready: lesson is ${j.status}`);
    const checks = j.checks as unknown as TeachChecks | null;
    if (!checks || !checks.executed) throw new TeachError(409, 'job_not_ready: this lesson has not been measured in the live model yet — run a re-check first');
    if (checks.skipped) throw new TeachError(409, 'checks_failed: the side-effect check was turned off for this lesson — run the check now before publishing');
    if (!checks.ok) throw new TeachError(409, 'checks_failed: this lesson changed answers to unrelated questions or to the knowledge it builds on');
    const d = j.draft_id ? this.store.getDraft(j.draft_id) : null;
    if (!d) throw new TeachError(409, 'job_not_ready: draft is missing');
    return d;
  }
  /** What the browser signs: hashCanonical({patch_sha256, benchmark_hash, address (paid), share}); `signer` is the teaching key. */
  publishChallenge(j: TeachJobRow, signer: string, payoutAddress: string | null | undefined) {
    const d = this.draftFor(j);
    if (this.cfg.publish === 'never') throw new TeachError(403, 'publish_disabled: this node accepts lessons but does not publish them');
    if (payoutAddress && !/^0x[0-9a-fA-F]{40}$/.test(payoutAddress)) throw new TeachError(400, 'invalid: payout_address must be an AIN address');
    if (payoutAddress && payoutAddress.toLowerCase() === this.market.address.toLowerCase()) throw new TeachError(400, 'invalid: payout_address cannot be this node\'s own address');
    const share = payoutAddress === null ? 0 : this.cfg.contributorShare;
    const address = payoutAddress || signer;
    return { patch_sha256: d.anchor.patch_sha256, benchmark_hash: d.anchor.benchmark_hash, address, signer, share, claim: hashCanonical({ patch_sha256: d.anchor.patch_sha256, benchmark_hash: d.anchor.benchmark_hash, address, share }) };
  }
  async publish(j: TeachJobRow, signer: string, body: PublishBody): Promise<{ status: 'PENDING_REVIEW' } | { status: 'ANNOUNCED'; patch_id: string; url: string }> {
    this.assertEnabled();
    const ch = this.publishChallenge(j, signer, body.payout_address);
    // the sheet sends the REAL checkbox state (lineage design §6.5); a publish without both consents is refused, never assumed
    if (!body.consent?.permanent || !body.consent?.rights) throw new TeachError(400, 'consent_required: both consent boxes are required');
    if (!verifyMessage(ch.claim, body.claim_sig, signer)) throw new TeachError(401, 'invalid_signature: the claim signature does not verify for this teaching key');
    const price = body.price === undefined || body.price === '' ? '0' : String(body.price);
    if (!/^\d+(\.\d+)?$/.test(price)) throw new TeachError(400, 'invalid: price must be a non-negative number');
    // the training set (design §6.1, §6.4, §6.5): access, licence, declaration, PII — decided here, before anything is written
    const pub = await this.datasetPublication(j, body);
    // A key that was named AFTER the lesson was queued still gets its credit: the sheet shows that name, so the record
    // has to carry it (a display name is never taken from anywhere but the owner's own request).
    if (body.contributor?.name && !j.contributor_name) {
      const badName = checkDisplayName(body.contributor.name); if (badName) throw new TeachError(400, `invalid: ${badName}`);
      const askedName = normalizeDisplayName(body.contributor.name)?.slice(0, 40) ?? null;
      if (askedName) {
        this.store.updateTeachJob(j.id, { contributor_name: askedName });
        this.store.touchContributor(signer, { name: askedName });
        j = { ...j, contributor_name: askedName };
      }
    }
    const contributor: Contributor = {
      address: ch.address, ...(ch.address.toLowerCase() !== signer.toLowerCase() ? { signer } : {}), ...(j.contributor_name ? { name: j.contributor_name } : {}),
      share: ch.share, role: 'data_provider', proof: ch.address.toLowerCase() === signer.toLowerCase() ? 'signed' : 'declared', sig: body.claim_sig,
    };
    const contributors = validateContributors([contributor]);
    const d = this.draftFor(j);
    // Pin the published copy (design §5.2): promoted from the job's snapshot, immutable, exempt from the sweep and
    // the owner's delete; the anchor names its sha. Done before the draft changes so a failed pin publishes nothing.
    // A creator who asked for the file to be deleted after training gets no copy kept at all — the record keeps the
    // fingerprint and says `private`, which is exactly what SC-8 promised them.
    const pinned = pub.forced_private ? null : this.pinDataset(j, d.anchor, pub);
    const existing = d.anchor.dataset;
    const dataset = pinned || existing
      ? { ...(existing ?? { source: (j.dataset_source ?? 'chat') as TeachDatasetSource }), ...(pinned ? { sha256: pinned.sha256, rows: pinned.rows } : {}), access: pub.access, license: pub.license } as PatchAnchor['dataset']
      : undefined;
    this.market.updateDraft(d.id, {
      name: body.name, description: body.description ?? '', price, license: body.license ?? pub.license, visibility: 'public', contributors, origin: 'teach',
      ...(dataset ? { dataset } : {}),
    });
    this.store.touchContributor(signer, { published: true, payout_address: body.payout_address ?? null });
    this.store.updateTeachJob(j.id, { name: body.name, dataset_pub: { access: pub.access, license: pub.license, include_notes: pub.include_notes, declaration: pub.declaration, published_sha256: pinned?.sha256 ?? '' } });
    if (this.cfg.publish === 'auto') return this.announceJob(this.store.getTeachJob(j.id)!, { fromPublish: true });
    this.store.updateTeachJob(j.id, { status: 'PENDING_REVIEW', publish_status: 'pending_review' });
    this.log('info', `lesson ${j.id} submitted for operator review as ${d.id}`, j.id);
    return { status: 'PENDING_REVIEW' };
  }
  /**
   * The training-set choices of a publish (design §6.1 / §6.4 / §6.5), validated in the order a creator can act on:
   * unknown licence → licence incompatible with a base → base still a private draft → PII rows above private →
   * declaration missing for a big set. `delete_after_training` forces `private` (nothing left to share).
   */
  private async datasetPublication(j: TeachJobRow, body: PublishBody): Promise<DatasetPublication> {
    const c = this.cfg;
    const ds = body.dataset ?? {};
    const license = ds.license ?? (isDatasetLicense(body.license) ? body.license : undefined) ?? 'CC-BY-4.0';
    if (!isDatasetLicense(license)) throw new TeachError(400, `bad_license: "${license}" is not a licence this network knows (CC0-1.0, CC-BY-4.0, CC-BY-SA-4.0, ODC-By-1.0, Proprietary)`, { license });
    const dataset = j.dataset_id ? this.store.getTeachDataset(j.dataset_id) : null;
    let access: DatasetAccess = ds.access ?? 'derivative';
    let forcedPrivate: string | null = null;
    if (dataset?.retention === 'delete_after_training' && access !== 'private') { access = 'private'; forcedPrivate = 'delete_after_training'; }
    for (const b of j.bases ?? []) {
      const e = await this.market.entry(b.patch_id);
      if (!e) throw new TeachError(400, `base_unknown: ${b.patch_id} is no longer on this node`, { id: b.patch_id });
      if (e.status === 'DRAFT') throw new TeachError(400, `parent_not_listed: publish ${b.patch_id} first — it is the base of this lesson`, { id: b.patch_id });
      const ok = licenseCompatible({ license: e.anchor.dataset?.license, access: accessOf(e.anchor) }, { license, access });
      if (!ok.ok) throw new TeachError(400, ok.reason, { parent: b.patch_id, parent_license: e.anchor.dataset?.license ?? null });
    }
    const piiRows = dataset ? this.datasets.piiRows(dataset) : [];
    if (access !== 'private' && piiRows.length) {
      throw new TeachError(400, `dataset_pii: rows ${piiRows.map((r) => r.index + 1).join(', ')} look like personal information (${[...new Set(piiRows.flatMap((r) => r.kinds))].join(', ')}) — remove them, or keep the training set private`, { rows: piiRows.map((r) => r.index), kinds: [...new Set(piiRows.flatMap((r) => r.kinds))] });
    }
    const rows = j.dataset_rows ?? j.facts.length;
    const declaration = ds.declaration ?? null;
    if (rows >= c.dataset.declarationRows && !declaration) throw new TeachError(400, `dataset_declaration: tell us where these ${rows} questions come from (own work, a public source, or licensed to you)`, { rows, declaration_rows: c.dataset.declarationRows });
    if (declaration && !['own', 'public', 'licensed'].includes(declaration.source)) throw new TeachError(400, 'invalid: declaration.source must be own, public or licensed');
    return { access, license, include_notes: !!ds.include_notes, declaration, forced_private: forcedPrivate, pii: piiRows.map((r) => r.index) };
  }

  /**
   * Promote the job's snapshot to the content-addressed dataset store (design §5.2): notes stripped unless the owner
   * opted in, the full benchmark list beside it, a manifest that says what the rows are. Returns null for a lesson
   * that has no snapshot (taught before datasets existed) — its anchor then carries no training set.
   */
  private pinDataset(j: TeachJobRow, anchor: PatchAnchor, pub: DatasetPublication): { sha256: string; rows: number } | null {
    const rows: CanonicalRow[] | null = this.snapshotRows(j);
    if (!rows.length) return null;
    const parent = anchor.dataset?.parents?.[0] ?? null;
    const inh = parent ? this.inheritance(rows, parent.patch_id, this.market.datasets.rows(parent.sha256).length) : null;
    const recipe = this.readTrainerRecipe(j.job_dir ?? '');
    const bytes = canonicalBytes(publishedRows(rows, pub.include_notes));
    // the FULL list written at draft time — the same bytes the anchor's `answers_hash` commits to (design §5.1);
    // a lesson from before that file existed falls back to what the anchor and the recipe carry
    const preimage = j.job_dir ? join(j.job_dir, 'benchmark.jsonl') : null;
    const benchmark: BenchmarkSample[] = preimage && existsSync(preimage) ? decodeBenchmarkJsonl(readFileSync(preimage, 'utf8')) : [];
    if (!benchmark.length) {
      const seen = new Set<string>();
      for (const s of [...(anchor.benchmark.samples ?? []), ...(recipe.benchmark_samples ?? [])]) { const k = `${s.prompt}\u0000${s.expect}`; if (!seen.has(k)) { seen.add(k); benchmark.push(s); } }
    }
    const manifest: Parameters<DatasetBlobStore['pin']>[1] = {
      source: (j.dataset_source ?? 'chat') as TeachDatasetSource, license: pub.license, access: pub.access,
      parents: anchor.dataset?.parents ?? [], row_origin: inh?.row_origin ?? [], changed: inh?.changed ?? [], removed: inh?.removed ?? [],
      contrast_used: (recipe.contrast ?? []).map((x) => (typeof x === 'string' ? x : JSON.stringify(x))),
      ...(recipe.fact_addrs ? { fact_addrs: recipe.fact_addrs } : {}),
      pii_scan: { ok: pub.pii.length === 0, rows: pub.pii }, declaration: pub.declaration, include_notes: pub.include_notes,
      patch_id: anchor.id, model_id: anchor.model.id_M,
    };
    const pinned = this.market.datasets.pin(bytes, manifest, benchmark);
    this.log('info', `training set of ${anchor.id} pinned (${pinned.rows} questions, ${pub.access}, ${pub.license}${pub.forced_private ? ', private because the file is deleted after training' : ''})`, j.id, { sha256: pinned.sha256, access: pub.access });
    return { sha256: pinned.sha256, rows: pinned.rows };
  }

  /**
   * Announce the draft on the ledger — operator approve (review mode) or the auto path right after `publish()`.
   * Consent gate (security review): only a lesson the OWNER published may ever be announced — the operator cannot approve a
   * READY private draft (`fromPublish` is set only by `publish()`, after consent + signed claim were recorded), and the draft
   * must carry a contributor whose claim signature verifies against its patch/benchmark hashes.
   */
  async announceJob(j: TeachJobRow, opts: { fromPublish?: boolean } = {}): Promise<{ status: 'ANNOUNCED'; patch_id: string; url: string }> {
    const d = j.draft_id ? this.store.getDraft(j.draft_id) : null;
    if (!j.draft_id || !d) throw new TeachError(409, 'job_not_ready: draft is missing');
    if (opts.fromPublish) { if (j.status !== 'READY') throw new TeachError(409, `job_not_ready: lesson is ${j.status}`); }
    else if (j.status !== 'PENDING_REVIEW' || j.publish_status !== 'pending_review') throw new TeachError(409, `job_not_ready: the owner has not published this lesson (it is ${j.status}) — only lessons submitted for review can be approved`);
    const claims = (d.anchor.contributors ?? []).filter((c) => c.sig && verifyMessage(hashCanonical({ patch_sha256: d.anchor.patch_sha256, benchmark_hash: d.anchor.benchmark_hash, address: c.address, share: c.share }), c.sig, c.signer ?? c.address));
    if (!claims.length || !claims.some((c) => (c.signer ?? c.address).toLowerCase() === j.contributor.toLowerCase())) throw new TeachError(409, 'job_not_ready: the draft carries no verified claim by the owner\'s teaching key');
    const rec = await this.market.announce(j.draft_id);
    this.store.updateTeachJob(j.id, { status: 'ANNOUNCED', patch_id: j.draft_id, publish_status: 'announced', reject_reason: null });
    await this.closeCoveredQuestions(j, d.anchor).catch((e) => this.log('warn', `open questions of the bases could not be closed: ${(e as Error).message}`, j.id));
    this.log('info', `lesson ${j.id} announced as ${j.draft_id} (record ${rec.hash.slice(0, 12)}…)`, j.id);
    return { status: 'ANNOUNCED', patch_id: j.draft_id, url: `/${rec.body.author}/${j.draft_id}` };
  }
  /**
   * §10 issue lifecycle — a knowledge that answers an ancestor's open question closes it. Every ancestor reachable
   * through `parents[]` (cycle-safe, same cap as the tree) has its OPEN issues flipped to `covered_by:<child>` when
   * their cluster key is among this lesson's published questions. Matching is by cluster key, so an issue nobody
   * consented to store as text can still be recognised as answered.
   */
  private async closeCoveredQuestions(j: TeachJobRow, anchor: PatchAnchor): Promise<void> {
    const keys = new Set<string>();
    for (const f of j.facts) keys.add(this.market.questionCluster(f.prompt));
    const sha = anchor.dataset?.sha256;
    if (sha && this.market.datasets.has(sha)) for (const r of this.market.datasets.rows(sha)) keys.add(this.market.questionCluster(r.prompt));
    if (!keys.size) return;
    const map = await this.market.entryMap();
    const seen = new Set<string>([anchor.id]);
    const queue: { id: string; depth: number }[] = anchor.parents.map((id) => ({ id, depth: 1 }));
    while (queue.length) {
      const { id, depth } = queue.shift()!;
      if (seen.has(id) || depth > TREE_MAX_DEPTH) continue;
      seen.add(id);
      const closed = this.store.coverIssues(id, [...keys], anchor.id);
      if (closed) this.log('info', `${anchor.id} answers ${closed} open question(s) of ${id}`, j.id);
      for (const p of map.get(id)?.anchor.parents ?? []) queue.push({ id: p, depth: depth + 1 });
    }
  }

  reject(j: TeachJobRow, reason: string) {
    if (j.status !== 'PENDING_REVIEW') throw new TeachError(409, `job_not_ready: lesson is ${j.status}`);
    if (j.draft_id && this.store.getDraft(j.draft_id)) { try { this.market.updateDraft(j.draft_id, { visibility: 'test' }); } catch { /* ignore */ } }
    this.store.updateTeachJob(j.id, { status: 'REJECTED', publish_status: 'rejected', reject_reason: reason.slice(0, 500), expires_at: Date.now() + this.cfg.draftTtlDays * 86_400_000 });
    this.log('info', `lesson ${j.id} declined by the operator: ${reason}`, j.id);
  }

  // ------------------------------------------------------------ public teacher page (spec §6.2 GET /api/teacher/:address)
  async teacherProfile(address: string) {
    const addr = address.toLowerCase();
    const contributor = this.store.getContributor(address);
    const cat = await this.market.catalog();
    // A lesson is listed under the key that SIGNED the claim. A declared payout wallet only receives money — it never
    // agreed to be shown as the teacher of anything (security review: attribution without consent).
    const mine = cat.filter((e) => e.status !== 'DRAFT' && (e.anchor.contributors ?? []).some((x) => creditedAddress(x).toLowerCase() === addr));
    const lessons: { id: string; name: string; status: string; verified: boolean; downloads: number; revenue: string }[] = mine.map((e) => ({ id: e.anchor.id, name: e.anchor.name, status: e.status, verified: e.quorum_ok, downloads: e.downloads, revenue: e.revenue }));
    // pending lessons are referenced by JOB id: the private draft id must not appear on a public page
    for (const j of this.store.listTeachJobs({ contributor: address, status: ['PENDING_REVIEW'] })) lessons.push({ id: j.id, name: j.name ?? '', status: 'PENDING_REVIEW', verified: false, downloads: 0, revenue: '0' });
    // Earnings: OWED comes from settle records (any node can read them), PAID from this node's payouts rows (§7.6).
    // A settle from another seller node shows as `pending` with `paid_by: null` — the settle record is the evidence.
    const setts = await this.market.ledger.settlements();
    const payouts = this.store.listPayouts({ address, limit: 5000 });
    const maxAttempts = this.market.payouts.maxAttempts;
    const items: { patch_id: string; seller: string; settle_hash: string; amount: string; currency: string; scheme: string; status: 'paid' | 'pending' | 'failed'; tx_hash?: string; attempts?: number; created_at: number; paid_at?: number }[] = [];
    let owed = 0, paid = 0, failed = 0;
    for (const s of setts) {
      const amt = Object.entries(s.body.royalty).find(([a]) => a.toLowerCase() === addr)?.[1];
      if (!amt || !(Number(amt) > 0)) continue;
      owed += Number(amt);
      let status: 'paid' | 'pending' | 'failed' = 'pending'; let tx: string | undefined; let attempts: number | undefined; let paidAt: number | undefined;
      if (s.body.scheme === 'local-credit') status = 'paid';   // play money: credited by the settle record itself
      else {
        const p = payouts.find((x) => x.settle_hash === s.hash);
        if (p) {
          attempts = p.attempts; tx = p.tx_hash ?? undefined;
          // Still retrying automatically → the contributor sees "pending"; only exhausted attempts read "failed".
          status = p.status === 'paid' ? 'paid' : p.status === 'failed' && p.attempts >= maxAttempts ? 'failed' : 'pending';
          if (status === 'paid') paidAt = p.updated_at;
        }
      }
      if (status === 'paid') paid += Number(amt);
      if (status === 'failed') failed += Number(amt);
      items.push({ patch_id: s.body.patch_id, seller: s.body.seller, settle_hash: s.hash, amount: String(amt), currency: s.body.currency, scheme: s.body.scheme, status,
        ...(tx ? { tx_hash: tx } : {}), ...(attempts !== undefined ? { attempts } : {}), created_at: s.body.created_at, ...(paidAt ? { paid_at: paidAt } : {}) });
    }
    const name = contributor && !contributor.hidden ? contributor.name ?? undefined : undefined;
    const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
    return { address, ...(name ? { name } : {}), hidden: !!contributor?.hidden, lessons,
      earnings: { currency: this.market.cfg.market.currency, owed: String(r6(owed)), paid: String(r6(paid)), pending: String(r6(owed - paid)), failed: String(r6(failed)), sales: items.length, items: items.sort((a, b) => b.created_at - a.created_at) } };
  }

  /** Addresses whose display name the operator hid (catalog then shows "Taught by a visitor"). */
  hiddenContributors(): Set<string> { return new Set(this.store.listContributors().filter((c) => c.hidden).map((c) => c.address.toLowerCase())); }
}

interface DoneEvent {
  event: 'done'; rows: number; npz?: string; recipe?: string; hits: number; total: number; heldout?: number; heldout_total?: number; converged?: boolean; steps?: number;
  load_s?: number; train_s?: number; avg_step_s?: number; total_s?: number; sentences?: number;
  facts?: { fact: number; base_answer?: string | null; after_answer?: string | null; hit?: boolean; heldout_hit?: boolean }[];
}

export type { TeachConfig };
