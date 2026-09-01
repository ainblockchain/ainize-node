/**
 * Helpers for the dataset-first training scenarios (AZ-163…AZ-182), driven against the teach dev node :3422.
 *
 * Everything here is plumbing the scenarios assume rather than assert: a browser-shaped teaching key (the same key in
 * localStorage and in the test's own signed API calls), dataset/lesson creation and clean-up, the operator policy
 * knobs a few scenarios have to move for the run, and the two timing tricks a stub node forces on us — a queue that
 * is kept busy so a lesson can be observed while it waits, and a reload race that catches the ~1.7 s TRAINING window.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { APIRequestContext, BrowserContext, Page } from '@playwright/test';
import { createIdentity, signMessage } from '../../core/dist/index.js';

export const NODE = process.env.AINIZE_URL ?? 'http://localhost:3422';
export const NODE_HOME = process.env.AINIZE_TEACH_HOME ?? join(homedir(), '.ngram-teachable/node-u');
export const REPO = join(new URL('..', import.meta.url).pathname, '../..');   // packages/e2e/helpers → repo root

export interface TeachKey { address: string; privateKey: string }
export interface DatasetRow { prompt: string; answer: string; alt_prompt?: string; note?: string }

export interface Dataset {
  id: string; name: string; rows: number; sha256: string; revision: number; source: string; status: string;
  source_name?: string | null; deleted_at?: number | null; retention?: string;
}
export interface JobFact { prompt: string; answer: string; alt_prompt?: string; base_answer?: string; after_answer?: string; hit?: boolean; heldout_hit?: boolean }
export interface Job {
  id: string; status: string; name?: string; facts: JobFact[]; error?: string; draft_id?: string; parent_job?: string;
  position?: number; eta_s?: number | null; started_at?: number; created_at: number;
  progress?: { step: number; max_steps: number; hits: number; total: number; percent?: number; rows_total?: number; phase?: string; elapsed_s?: number };
  checks?: { executed: boolean; skipped?: boolean; ok: boolean; simulated?: boolean; note?: string; taught: { hits: number; total: number; sampled?: { checked: number; of: number } }; locality: { ok: boolean; same: number; total: number; unstable?: number }; parent_regression: { ok: boolean; hit: number; total: number } };
  training?: { effort: string; max_steps: number; eval_every: number; lr: number; check_side_effects: boolean; use_alt: boolean; selected_indexes?: number[] };
  dataset?: { id: string | null; sha256: string | null; revision?: number; name?: string; rows: number; source: string; trained_rows: number; selected_indexes?: number[]; deleted?: boolean };
  preflight?: { checked: number; of: number; known: number; overlaps?: number };
}
export interface Policy {
  enabled: boolean; publish: string; backend: string; trainer: string; paused_reason?: string;
  queue: { depth: number; max: number; queued_rows: number; queued_rows_max: number };
  limits: { rows_per_job: number; rows_per_job_source: string; jobs_per_key_per_day: number; jobs_per_ip_per_day: number; dataset_max_rows: number; dataset_ttl_days: number };
  timing: { p50_s: number | null; p90_s: number | null; samples: number; backend: string; simulated: boolean; load_s_p50: number | null; s_per_row_p50: number | null };
  effort: { id: string; max_steps: number; eval_every: number }[];
  simulated_checks?: boolean;
}

export const ACTIVE = new Set(['QUEUED', 'PREFLIGHT', 'LOADING', 'TRAINING', 'EXPORTED', 'CHECKING']);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const sha256hex = (b: string | Uint8Array) => createHash('sha256').update(b).digest('hex');
export const newKey = (): TeachKey => { const id = createIdentity(); return { address: id.address, privateKey: id.privateKey }; };
export const tag = () => `${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 4)}`;

/**
 * The dev node is shared with the other scenario suites, which restart it and move its policy knobs. A request that
 * lands in a restart is not a scenario failure: wait for the node to answer again and send it once more.
 */
export async function waitForNode(ms = 180_000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if ((await fetch(`${NODE}/api/info`, { signal: AbortSignal.timeout(2000) })).ok) return; } catch { /* still down */ }
    await sleep(1000);
  }
  throw new Error(`the teach node at ${NODE} never came back`);
}

async function withNode<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) {
    if (!/ECONNREFUSED|ECONNRESET|socket hang up|connect|fetch failed/i.test((e as Error).message)) throw e;
    await waitForNode();
    return fn();
  }
}

let nodeAddressCache = '';
export async function nodeAddress(request: APIRequestContext): Promise<string> {
  if (!nodeAddressCache) {
    const r = await withNode(() => request.get(`${NODE}/api/info`));
    nodeAddressCache = ((await r.json()) as { node: { address: string } }).node.address;
  }
  return nodeAddressCache;
}

/** `x-ngram-auth` v2 for one request — the same string packages/node/src/teach-auth.ts verifies. */
export function authHeaderV2(key: TeachKey, node: string, method: string, path: string, body?: string): string {
  const ts = Date.now();
  const parts = ['teach', node, method.toUpperCase(), path, String(ts)];
  if (body && body.length) parts.push(sha256hex(body));
  return `${key.address}:${ts}:${signMessage(parts.join(':'), key.privateKey)}:v2`;
}

export interface ApiResult<T> { status: number; body: T; headers: Record<string, string> }

/** One signed visitor call. `path` must be exactly what the node sees (path + query). */
export async function teachApi<T = unknown>(request: APIRequestContext, key: TeachKey, method: string, path: string, data?: unknown): Promise<ApiResult<T>> {
  const body = data === undefined ? undefined : JSON.stringify(data);
  const node = await nodeAddress(request);
  const headers: Record<string, string> = { 'x-ngram-auth': authHeaderV2(key, node, method, path, body) };
  if (body) headers['content-type'] = 'application/json';
  const r = await withNode(() => request.fetch(`${NODE}${path}`, { method, headers, ...(body ? { data: body } : {}), timeout: 120_000 }));
  let parsed: unknown = null;
  try { parsed = await r.json(); } catch { parsed = await r.text().catch(() => null); }
  return { status: r.status(), body: parsed as T, headers: r.headers() };
}

// ------------------------------------------------------------------ operator side
export async function operatorToken(request: APIRequestContext): Promise<string> {
  const pass = process.env.AINIZE_PASS ?? 'teachable-pass';
  const me = (await (await withNode(() => request.get(`${NODE}/api/auth/me`))).json()) as { needsSetup: boolean };
  const r = await withNode(() => request.post(`${NODE}${me.needsSetup ? '/api/auth/setup' : '/api/auth/login'}`, { data: { password: pass } }));
  if (!r.ok()) throw new Error(`operator login failed: ${r.status()} ${await r.text()}`);
  return ((await r.json()) as { token: string }).token;
}

/** PATCH the operator policy; a node restart invalidates the bearer token, so log in again and retry once. */
export async function patchPolicy(request: APIRequestContext, token: string, body: Record<string, unknown>): Promise<number> {
  let r = await withNode(() => request.patch(`${NODE}/api/me/teach/policy`, { data: body, headers: { authorization: `Bearer ${token}` } }));
  if (r.status() === 401 || r.status() === 403) {
    const fresh = await operatorToken(request);
    r = await withNode(() => request.patch(`${NODE}/api/me/teach/policy`, { data: body, headers: { authorization: `Bearer ${fresh}` } }));
  }
  if (!r.ok()) throw new Error(`PATCH /api/me/teach/policy ${JSON.stringify(body)} → ${r.status()} ${await r.text()}`);
  return r.status();
}

/** The operator's own view of the limits (what a PATCH would change). */
export async function adminLimits(request: APIRequestContext, token: string): Promise<{ jobsPerKeyPerDay: number; jobsPerIpPerDay: number; dataset: { rowsPerKeyPerDay: number; rowsPerIpPerDay: number } }> {
  let r = await withNode(() => request.get(`${NODE}/api/me/teach/policy`, { headers: { authorization: `Bearer ${token}` } }));
  if (r.status() === 401 || r.status() === 403) {
    const fresh = await operatorToken(request);
    r = await withNode(() => request.get(`${NODE}/api/me/teach/policy`, { headers: { authorization: `Bearer ${fresh}` } }));
  }
  return ((await r.json()) as { effective: { jobsPerKeyPerDay: number; jobsPerIpPerDay: number; dataset: { rowsPerKeyPerDay: number; rowsPerIpPerDay: number } } }).effective;
}

/**
 * GET /api/teach/policy, with the node's per-address limit (30 calls a minute) waited out rather than thrown: a
 * browser page load spends one of those too, so a busy scenario can walk into it through no fault of its own.
 */
export async function policy(request: APIRequestContext): Promise<Policy> {
  for (let i = 0; i < 12; i++) {
    const r = await withNode(() => request.get(`${NODE}/api/teach/policy`, { headers: { 'cache-control': 'no-cache' } }));
    if (r.status() !== 429) return (await r.json()) as Policy;
    await sleep(5000);
  }
  throw new Error('GET /api/teach/policy stayed rate-limited for a minute');
}

// ------------------------------------------------------------------ datasets and lessons
const madeDatasets: { id: string; key: TeachKey }[] = [];
const madeJobs: { id: string; key: TeachKey }[] = [];
const usedKeys: TeachKey[] = [];
const rememberKey = (k: TeachKey) => { if (!usedKeys.some((x) => x.address === k.address)) usedKeys.push(k); };

export async function createDataset(request: APIRequestContext, key: TeachKey, rows: DatasetRow[], name: string): Promise<Dataset> {
  // the node accepts 10 new datasets per address per minute (teach.dataset.createsPerIpPerMin); a 20-scenario suite
  // runs into that in a burst, so wait the window out rather than failing a scenario over test plumbing
  let r = await teachApi<{ dataset: Dataset }>(request, key, 'POST', '/api/teach/datasets', { source: 'inline', rows, name });
  for (let i = 0; i < 20 && r.status === 429 && /rate_limited/.test(JSON.stringify(r.body)); i++) {
    await sleep(5000);
    r = await teachApi<{ dataset: Dataset }>(request, key, 'POST', '/api/teach/datasets', { source: 'inline', rows, name });
  }
  if (r.status !== 201 && r.status !== 200) throw new Error(`create dataset ${name} → ${r.status} ${JSON.stringify(r.body)}`);
  const d = r.body.dataset;
  madeDatasets.push({ id: d.id, key });
  rememberKey(key);
  return d;
}

export async function getDataset(request: APIRequestContext, key: TeachKey, id: string): Promise<ApiResult<{ dataset: Dataset }>> {
  return teachApi<{ dataset: Dataset }>(request, key, 'GET', `/api/teach/datasets/${id}`);
}

export async function datasetRows(request: APIRequestContext, key: TeachKey, id: string, query = ''): Promise<ApiResult<{ total: number; items: { line: number; index: number | null; prompt?: string; answer?: string; alt_prompt?: string; status: string }[] }>> {
  return teachApi(request, key, 'GET', `/api/teach/datasets/${id}/rows${query}`);
}

export interface CreateJobBody { patch_ids: string[]; builds_on_context: boolean; dataset_id: string; training?: Record<string, unknown>; name?: string; selected_indexes?: number[] }

export async function createJob(request: APIRequestContext, key: TeachKey, body: CreateJobBody): Promise<ApiResult<{ job: Job; quota: Record<string, number> }>> {
  const r = await teachApi<{ job: Job; quota: Record<string, number> }>(request, key, 'POST', '/api/teach/jobs', body);
  if (r.status === 202) madeJobs.push({ id: r.body.job.id, key });
  return r;
}

export async function getJob(request: APIRequestContext, key: TeachKey, id: string): Promise<Job> {
  const r = await teachApi<{ job: Job }>(request, key, 'GET', `/api/teach/jobs/${id}`);
  if (r.status !== 200) throw new Error(`GET job ${id} → ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.job;
}

export async function listJobs(request: APIRequestContext, key: TeachKey): Promise<Job[]> {
  const r = await teachApi<{ items: Job[] }>(request, key, 'GET', '/api/teach/jobs');
  return r.body.items ?? [];
}

/** Remember a lesson the BROWSER created, so the suite deletes it even when the test fails. */
export function trackJob(id: string, key: TeachKey) { rememberKey(key); if (id && !madeJobs.some((j) => j.id === id)) madeJobs.push({ id, key }); }
export function trackDataset(id: string, key: TeachKey) { rememberKey(key); if (id && !madeDatasets.some((d) => d.id === id)) madeDatasets.push({ id, key }); }

export async function waitForJob(request: APIRequestContext, key: TeachKey, id: string, done: (j: Job) => boolean, ms = 180_000, everyMs = 200): Promise<Job> {
  const t0 = Date.now();
  let last: Job | null = null;
  while (Date.now() - t0 < ms) {
    last = await getJob(request, key, id);
    if (done(last)) return last;
    await sleep(everyMs);
  }
  throw new Error(`lesson ${id} did not reach the expected state in ${ms} ms (last status ${last?.status})`);
}

export const waitForTerminal = (request: APIRequestContext, key: TeachKey, id: string, ms = 180_000) =>
  waitForJob(request, key, id, (j) => !ACTIVE.has(j.status), ms);

export async function deleteJob(request: APIRequestContext, key: TeachKey, id: string): Promise<number> {
  const r = await teachApi(request, key, 'DELETE', `/api/teach/jobs/${id}`);
  return r.status;
}
export async function deleteDataset(request: APIRequestContext, key: TeachKey, id: string): Promise<number> {
  const r = await teachApi(request, key, 'DELETE', `/api/teach/datasets/${id}`);
  return r.status;
}

/**
 * Delete every lesson and dataset this suite created. Lessons first and per key (a lesson still in the queue holds its
 * dataset `in_use`, which is a 409 on the dataset), then the datasets, retried while a lesson is still winding down.
 */
export async function cleanupAll(request: APIRequestContext): Promise<string[]> {
  const problems: string[] = [];
  for (const key of usedKeys) {
    for (const j of await listJobs(request, key).catch(() => [])) {
      const s = await deleteJob(request, key, j.id).catch(() => -1);
      if (![200, 404, 409].includes(s)) problems.push(`job ${j.id} → ${s}`);
    }
  }
  madeJobs.splice(0);
  const left = madeDatasets.splice(0);
  for (let attempt = 0; attempt < 5 && left.length; attempt++) {
    for (let i = left.length - 1; i >= 0; i--) {
      const s = await deleteDataset(request, left[i].key, left[i].id).catch(() => -1);
      if ([200, 404].includes(s)) left.splice(i, 1);
      else if (attempt === 4) problems.push(`dataset ${left[i].id} → ${s}`);
    }
    if (left.length) await sleep(5000);
  }
  usedKeys.splice(0);
  return problems;
}

export const jobDir = (id: string) => join(NODE_HOME, 'data', 'teach', id);
export const jobDirExists = (id: string) => existsSync(jobDir(id));

// ------------------------------------------------------------------ browser
/** Give a browser context the teaching key (and locale) the test signs its own calls with. */
export async function seedBrowserKey(context: BrowserContext, key: TeachKey, locale: 'en' | 'ko' = 'en') {
  await context.addInitScript(([priv, addr, loc]) => {
    try {
      localStorage.setItem('ainize.teacher.key', JSON.stringify({ privateKey: priv, address: addr, created_at: Date.now() }));
      localStorage.setItem('ainize.locale', loc);
    } catch { /* storage unavailable */ }
  }, [key.privateKey, key.address, locale] as [string, string, string]);
}

/** The lesson page's status attribute, or null when the page is not showing a lesson yet. */
export async function lessonStatus(page: Page): Promise<string | null> {
  return page.locator('[data-testid=teach-lesson]').first().getAttribute('data-status').catch(() => null);
}

/**
 * A stub lesson trains for ~1.7 s, and the lesson page polls every 3 s — so the progress screen is caught by racing
 * page loads against the node's own status. Returns what `read` saw at TRAINING, or null if the lesson finished first.
 */
export async function catchTraining<T>(page: Page, request: APIRequestContext, key: TeachKey, jobId: string, url: string, read: (page: Page) => Promise<T>): Promise<T | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < 120_000) {
    const j = await getJob(request, key, jobId);
    if (!ACTIVE.has(j.status)) return null;
    if (j.status !== 'TRAINING') { await sleep(80); continue; }
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-testid=teach-lesson][data-status]').first().waitFor({ timeout: 10_000 }).catch(() => undefined);
    if ((await lessonStatus(page)) === 'TRAINING') return read(page);
  }
  return null;
}

// ------------------------------------------------------------------ the queue keeper
/**
 * A stub lesson is over in ~2.4 s, which makes "waiting in the queue" impossible to look at. The keeper holds a few
 * lessons of its own in flight (from its own keys — ACTIVE_JOBS_PER_KEY is 2) so a lesson under test really does wait
 * its turn, exactly as it would behind other visitors on a busy node. It cleans up after itself.
 */
export class QueueKeeper {
  private keys: TeachKey[] = [];
  private datasets: string[] = [];
  /** the keeper's own lessons that have not finished yet — this is what it counts, so it never polls the policy */
  private pending: { id: string; key: TeachKey }[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = true;
  constructor(private readonly request: APIRequestContext, private readonly target = 4, private readonly keyCount = 4) {}

  /** Create the filler keys and datasets once (kept for the whole run). */
  async prepare() {
    if (this.keys.length) return;
    for (let i = 0; i < this.keyCount; i++) {
      const k = newKey();
      const rows = [1, 2, 3, 4].map((n) => ({ prompt: `QUEUE FILLER ${k.address.slice(2, 8)} question ${n}?`, answer: `filler-${k.address.slice(2, 8)}-${n}` }));
      const d = await createDataset(this.request, k, rows, `queue-filler-${k.address.slice(2, 8)}`);
      this.keys.push(k); this.datasets.push(d.id);
    }
  }

  async start() {
    await this.prepare();
    this.stopped = false;
    await this.top();
    this.timer = setInterval(() => { void this.top(); }, 1000);
  }

  /** How many of the keeper's own lessons are still in the queue (its jobs are the ones it may count on). */
  private async alive(): Promise<number> {
    const still: { id: string; key: TeachKey }[] = [];
    for (const j of this.pending) {
      const job = await getJob(this.request, j.key, j.id).catch(() => null);
      if (job && ACTIVE.has(job.status)) still.push(j);
    }
    this.pending = still;
    return still.length;
  }

  private topping = false;
  private async top() {
    if (this.stopped || this.topping) return;
    this.topping = true;
    try {
      let depth = await this.alive();
      for (let i = 0; i < this.keys.length && depth < this.target; i++) {
        // ACTIVE_JOBS_PER_KEY is 2, so each filler key carries at most two of the waiting lessons
        if (this.pending.filter((j) => j.key.address === this.keys[i].address).length >= 2) continue;
        const r = await createJob(this.request, this.keys[i], { patch_ids: [], builds_on_context: false, dataset_id: this.datasets[i], training: { effort: 'quick' } });
        if (r.status === 202) { this.pending.push({ id: r.body.job.id, key: this.keys[i] }); depth++; }
      }
    } catch { /* the node refuses when the queue is full — that is the point */ } finally { this.topping = false; }
  }

  /** Wait until at least `n` of the keeper's lessons are really waiting on the node. */
  async waitForDepth(n: number, ms = 60_000): Promise<number> {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const d = await this.alive();
      if (d >= n) return d;
      await this.top();
      await sleep(400);
    }
    throw new Error(`the training queue never reached depth ${n}`);
  }

  stop() { this.stopped = true; if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  /** Stop topping up and wait until the fillers have drained off the node. */
  async drain(ms = 120_000) {
    this.stop();
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if ((await this.alive()) === 0) return;
      await sleep(500);
    }
  }
}
