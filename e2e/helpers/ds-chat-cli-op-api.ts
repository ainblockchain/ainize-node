/**
 * Node-side helpers for `tests/ds-chat-cli-op.spec.ts` (scenarios AZ-203…AZ-222): the teaching-key signature the
 * dataset routes want, a tiny signed API client, the throwaway-home CLI runner, the operator policy record/restore
 * pair every settings scenario needs, and the live-model / stub restart of the dev node.
 *
 * Everything here talks to ONE node — `AINIZE_URL` (the teach dev node :3422) — and never to the demo cluster.
 */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { APIRequestContext } from '@playwright/test';
import { createIdentity, signMessage } from '../../core/dist/index.js';
import { NODE_A, SCRATCH, sleep } from './ainize';

const execFileP = promisify(execFile);

export const NODE = NODE_A;
export const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../..');
export const CLI_BIN = join(REPO, 'packages/cli/dist/bin.js');
export const NODE_BIN = process.execPath;
/** the dev node's home (its config.json is edited for the live-model scenarios and put back afterwards) */
export const NODE_HOME = process.env.AINIZE_TEACH_HOME ?? join(homedir(), '.ngram-teachable/node-u');
/** the DEDICATED model server for testing (GPUs 4+5) — never :8000 / :8001 */
export const MODEL_API = process.env.AINIZE_TEST_MODEL ?? 'http://localhost:8002';
export const PATCH_DIR = process.env.AINIZE_TEST_PATCH_DIR ?? '/mnt/newdata/qwen3.8/ple_patch_e2e';
/** what node-u's config.json ships as its serving API — the value the stub mode is put back to */
export const SHIPPED_RUNTIME_API = process.env.AINIZE_SHIPPED_RUNTIME ?? 'http://localhost:8000';

export interface TeachKey { address: string; privateKey: string }
export const newTeachKey = (): TeachKey => { const id = createIdentity(); return { address: id.address, privateKey: id.privateKey }; };

export const sha256Hex = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

/** Mirrors packages/node/src/teach-auth.ts `teachAuthMessage`. */
export function teachAuthMessage(t: { node: string; method: string; path: string; ts: number; body?: string | null }): string {
  const parts = ['teach', t.node, t.method.toUpperCase(), t.path, String(t.ts)];
  if (t.body !== undefined && t.body !== null && t.body.length > 0) parts.push(sha256Hex(t.body));
  return parts.join(':');
}

/** Request-bound, single-use `x-ngram-auth: <address>:<ts>:<sig>:v2`. */
export function v2Header(key: TeachKey, nodeAddress: string, method: string, path: string, body?: string | null, ts = Date.now()): string {
  return `${key.address}:${ts}:${signMessage(teachAuthMessage({ node: nodeAddress, method, path, ts, body }), key.privateKey)}:v2`;
}

export interface ApiResult<T> { status: number; body: T; headers: Record<string, string>; text: string }

export interface SignedOpts {
  path: string;
  method?: string;
  /** JSON body — serialised once, and that exact string is what the signature covers */
  data?: unknown;
  key?: TeachKey;
  nodeAddress?: string;
  /** operator bearer */
  token?: string;
  /** send this exact x-ngram-auth instead of building one (replay / expiry probes) */
  header?: string | null;
  /** what the signature covers when it is not the body (multipart: the sha256 header value) */
  signBody?: string;
  headers?: Record<string, string>;
}

/** One signed (or unsigned, or operator-bearer) call to the node. */
export async function sapi<T = unknown>(request: APIRequestContext, o: SignedOpts): Promise<ApiResult<T>> {
  const method = (o.method ?? 'GET').toUpperCase();
  const bodyStr = o.data === undefined ? undefined : JSON.stringify(o.data);
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.header !== undefined && o.header !== null) headers['x-ngram-auth'] = o.header;
  else if (o.header === undefined && o.key) headers['x-ngram-auth'] = v2Header(o.key, o.nodeAddress ?? '', method, o.path, o.signBody ?? bodyStr);
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (bodyStr !== undefined) headers['content-type'] = 'application/json';
  let r: Awaited<ReturnType<APIRequestContext['fetch']>>;
  try {
    r = await request.fetch(`${NODE}${o.path}`, { method, ...(bodyStr === undefined ? {} : { data: bodyStr }), headers, timeout: 10 * 60_000 });
  } catch (e) {
    // another suite on this box restarts node-u for its own live-model leg; wait it out and send the request once more
    if (!/ECONNREFUSED|ECONNRESET|socket hang up|connect/i.test(String(e))) throw e;
    if (!(await waitForNodeUp(2 * 60_000))) throw e;
    const retryHeaders = { ...headers };
    if (o.header === undefined && o.key) retryHeaders['x-ngram-auth'] = v2Header(o.key, o.nodeAddress ?? '', method, o.path, o.signBody ?? bodyStr);
    r = await request.fetch(`${NODE}${o.path}`, { method, ...(bodyStr === undefined ? {} : { data: bodyStr }), headers: retryHeaders, timeout: 10 * 60_000 });
  }
  const text = await r.text();
  let body: unknown = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* keep the text */ }
  return { status: r.status(), body: body as T, headers: r.headers(), text };
}

export interface DatasetView {
  id: string; owner_address: string; name: string; status: string; source: string; sha256: string; revision: number;
  rows: number; invalid_rows: number; size_bytes: number; source_bytes?: number; source_name?: string; retention: string;
  job_ids: string[]; created_at: number; updated_at: number; expires_at?: number; deleted_at?: number;
  summary: Record<string, number | Record<string, number>>;
}
export interface JobView {
  id: string; status: string; name?: string; facts: { prompt: string; answer: string; hit?: boolean }[];
  dataset?: { id: string | null; sha256: string | null; name?: string; revision?: number; rows: number; source: string; trained_rows: number; deleted?: boolean };
  draft_id?: string; patch_id?: string; checks?: { ok: boolean; executed: boolean; taught: { hits: number; total: number }; locality: { same: number; total: number; ok: boolean } };
  reject_reason?: string; error?: string; created_at: number;
}
export interface CreateDatasetResult { dataset: DatasetView; report: { summary: Record<string, number>; rows: unknown[] }; created: boolean }

/**
 * The node limits dataset creation to `createsPerIpPerMin` (10) per address per minute, and every suite on this box
 * shares 127.0.0.1 — so a `rate_limited` answer is waited out rather than reported as a failure of the scenario.
 */
const isRateLimited = (r: { status: number; body: unknown }) =>
  r.status === 429 && /^rate_limited\b/.test(((r.body as { error?: string } | null)?.error) ?? '');

async function unthrottled<T extends { status: number; body: unknown }>(call: () => Promise<T>, tries = 5): Promise<T> {
  let r = await call();
  for (let i = 1; i < tries && isRateLimited(r); i++) { await sleep(20_000); r = await call(); }
  return r;
}

/** POST /api/teach/datasets with a JSON body (the chat / inline / sample door). */
export function createDataset(request: APIRequestContext, key: TeachKey, nodeAddress: string, data: Record<string, unknown>) {
  return unthrottled(() => sapi<CreateDatasetResult>(request, { path: '/api/teach/datasets', method: 'POST', data, key, nodeAddress }));
}

/** POST /api/teach/datasets as multipart — the v2 signature covers the sha256 header value (design §D14). */
export function uploadDataset(request: APIRequestContext, key: TeachKey, nodeAddress: string, file: { name: string; bytes: Buffer }, fields: Record<string, string> = {}, opts: { sha?: string } = {}): Promise<ApiResult<CreateDatasetResult>> {
  return unthrottled(() => uploadDatasetOnce(request, key, nodeAddress, file, fields, opts));
}

async function uploadDatasetOnce(request: APIRequestContext, key: TeachKey, nodeAddress: string, file: { name: string; bytes: Buffer }, fields: Record<string, string> = {}, opts: { sha?: string } = {}): Promise<ApiResult<CreateDatasetResult>> {
  const declared = opts.sha ?? sha256Hex(file.bytes);
  const headers = { 'x-ngram-auth': v2Header(key, nodeAddress, 'POST', '/api/teach/datasets', declared), 'x-ngram-dataset-sha256': declared };
  const r = await request.fetch(`${NODE}/api/teach/datasets`, {
    method: 'POST', headers, timeout: 5 * 60_000,
    multipart: { file: { name: file.name, mimeType: 'text/plain', buffer: file.bytes }, ...fields },
  });
  const text = await r.text();
  let body: unknown = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* keep the text */ }
  return { status: r.status(), body: body as CreateDatasetResult, headers: r.headers(), text };
}

export function createJob(request: APIRequestContext, key: TeachKey, nodeAddress: string, data: Record<string, unknown>) {
  return sapi<{ job: JobView; quota: Record<string, number> }>(request, { path: '/api/teach/jobs', method: 'POST', data: { patch_ids: [], builds_on_context: false, ...data }, key, nodeAddress });
}

export const TERMINAL_JOB = ['READY', 'NEEDS_MORE', 'FAILED', 'CANCELLED', 'EXPIRED', 'REJECTED', 'ANNOUNCED', 'PENDING_REVIEW'];

/** Poll one lesson (signed as its owner) until it stops moving. */
export async function waitJob(request: APIRequestContext, key: TeachKey, nodeAddress: string, id: string, ms = 10 * 60_000): Promise<JobView> {
  const t0 = Date.now();
  let last: JobView | null = null;
  while (Date.now() - t0 < ms) {
    const r = await sapi<{ job: JobView }>(request, { path: `/api/teach/jobs/${id}`, key, nodeAddress });
    if (r.status === 200) { last = r.body.job; if (TERMINAL_JOB.includes(last.status)) return last; }
    await sleep(2000);
  }
  throw new Error(`lesson ${id} never left ${last?.status ?? 'an unknown status'} within ${Math.round(ms / 1000)} s`);
}

// ---------------------------------------------------------------- clean-up (operator bearer: works for any owner)
export async function deleteJob(request: APIRequestContext, token: string, id: string | undefined): Promise<number> {
  if (!id) return 0;
  const r = await sapi(request, { path: `/api/teach/jobs/${id}`, method: 'DELETE', token, header: null });
  return r.status;
}
export async function deleteDataset(request: APIRequestContext, token: string, id: string | undefined): Promise<number> {
  if (!id) return 0;
  const r = await sapi(request, { path: `/api/teach/datasets/${id}`, method: 'DELETE', token, header: null });
  return r.status;
}
/** The same, waiting out `409 dataset_in_use` — a cancelled lesson takes a moment to stop reading its dataset. */
export async function deleteDatasetWhenIdle(request: APIRequestContext, token: string, id: string | undefined, ms = 120_000): Promise<number> {
  if (!id) return 0;
  const t0 = Date.now();
  let status = await deleteDataset(request, token, id);
  while (status === 409 && Date.now() - t0 < ms) { await sleep(3000); status = await deleteDataset(request, token, id); }
  return status;
}

// ---------------------------------------------------------------- operator teaching policy
export interface PolicySnapshot { policy: Record<string, unknown>; effective: Record<string, unknown>; trainer?: { state: string; reason?: string } }

export async function readAdminPolicy(request: APIRequestContext, token: string): Promise<PolicySnapshot> {
  const r = await sapi<PolicySnapshot>(request, { path: '/api/me/teach/policy', token, header: null });
  if (r.status !== 200) throw new Error(`GET /api/me/teach/policy -> ${r.status} ${r.text}`);
  return { policy: r.body.policy, effective: r.body.effective, ...(r.body.trainer ? { trainer: r.body.trainer } : {}) };
}
export function patchAdminPolicy(request: APIRequestContext, token: string, patch: Record<string, unknown>) {
  return sapi<PolicySnapshot>(request, { path: '/api/me/teach/policy', method: 'PATCH', data: patch, token, header: null });
}

/** Every knob this suite may touch, put back exactly as it was found (nullable v2 keys go back to "no override"). */
export function restorePatch(snap: PolicySnapshot): Record<string, unknown> {
  const p = snap.policy as Record<string, unknown>;
  const e = snap.effective as Record<string, unknown>;
  const nul = (k: string) => (p[k] === undefined || p[k] === null ? null : p[k]);
  return {
    enabled: e.enabled, publish: e.publish, facts_per_job: e.factsPerJob,
    jobs_per_key_per_day: e.jobsPerKeyPerDay, jobs_per_ip_per_day: e.jobsPerIpPerDay,
    queue_max: e.queueMax, contributor_share: e.contributorShare, draft_ttl_days: e.draftTtlDays,
    paused_reason: (e.pausedReason as string | undefined) ?? null,
    blocked_topics: (e.blockedTopics as string | undefined) ?? null,
    dataset_max_bytes: nul('datasetMaxBytes'), dataset_max_rows: nul('datasetMaxRows'),
    rows_per_job: nul('rowsPerJob'),
    rows_per_key_per_day: nul('rowsPerKeyPerDay'), rows_per_ip_per_day: nul('rowsPerIpPerDay'),
    datasets_per_key_per_day: nul('datasetsPerKeyPerDay'), dataset_ttl_days: nul('datasetTtlDays'),
    declaration_rows: nul('declarationRows'), queued_rows_max: nul('queuedRowsMax'), check_call_budget: nul('checkCallBudget'),
  };
}
export async function restoreAdminPolicy(request: APIRequestContext, token: string, snap: PolicySnapshot): Promise<void> {
  const r = await patchAdminPolicy(request, token, restorePatch(snap));
  if (r.status !== 200) throw new Error(`policy restore failed: ${r.status} ${r.text}`);
}
/**
 * The teaching policy this dev node SHIPS (its own config.json, with every teach-mode-v2 override cleared so the node's
 * code defaults apply). Several suites share node-u and leave their own overrides behind, so the scenarios that assert
 * the dev node's own numbers pin them first and put the found policy back afterwards.
 */
export function shippedTeachDefaults(): Record<string, unknown> {
  const t = (JSON.parse(readFileSync(configPath(), 'utf8')) as { teach?: Record<string, unknown> }).teach ?? {};
  const n = (k: string, d: number) => (typeof t[k] === 'number' ? (t[k] as number) : d);
  return {
    enabled: t.enabled !== false, publish: (t.publish as string) ?? 'auto',
    facts_per_job: n('factsPerJob', 8), jobs_per_key_per_day: n('jobsPerKeyPerDay', 3), jobs_per_ip_per_day: n('jobsPerIpPerDay', 5),
    queue_max: n('queueMax', 10), contributor_share: typeof t.contributorShare === 'number' ? t.contributorShare : 0.7, draft_ttl_days: n('draftTtlDays', 7),
    paused_reason: null, blocked_topics: null,
    dataset_max_bytes: null, dataset_max_rows: null, rows_per_job: null,
    rows_per_key_per_day: null, rows_per_ip_per_day: null, datasets_per_key_per_day: null,
    dataset_ttl_days: null, declaration_rows: null, queued_rows_max: null, check_call_budget: null,
  };
}

/** Head-room so a 20-scenario run is not stopped by the dev node's 3-lessons-a-day contributor budget. */
export const HEADROOM = { jobs_per_key_per_day: 1000, jobs_per_ip_per_day: 1000, rows_per_key_per_day: 100_000, rows_per_ip_per_day: 100_000, datasets_per_key_per_day: 1000 };

// ---------------------------------------------------------------- CLI (a throwaway home holds its own teaching key)
export function cliHome(tag: string): string {
  const home = join(SCRATCH, `ds-cli-${tag}-${Date.now().toString(36)}`);
  mkdirSync(home, { recursive: true });
  return home;
}
export function writeTeachKeyFile(home: string, key: TeachKey): string {
  mkdirSync(home, { recursive: true });
  const path = join(home, 'teaching-key.json');
  writeFileSync(path, JSON.stringify({ kind: 'ainize-teaching-key', version: 1, privateKey: key.privateKey, address: key.address, created_at: Date.now() }, null, 2) + '\n', { mode: 0o600 });
  return path;
}
export function readTeachKeyFile(home: string): TeachKey {
  const j = JSON.parse(readFileSync(join(home, 'teaching-key.json'), 'utf8')) as TeachKey;
  return { address: j.address, privateKey: j.privateKey };
}
export function dropHome(home: string) { rmSync(home, { recursive: true, force: true }); }

const stripNoise = (s: string) => s.split('\n').filter((l) => !l.includes('secp256k1 unavailable')).join('\n');

/** `ainize --node <dev node> --home <throwaway> …` from THIS worktree's build. */
export async function cli(args: string[], home: string, opts: { cwd?: string; node?: string; timeoutMs?: number } = {}): Promise<{ code: number; stdout: string; stderr: string; all: string }> {
  let r = await cliOnce(args, home, opts);
  for (let i = 0; i < 4 && r.code !== 0 && /rate_limited: too many datasets|cannot reach node at/.test(r.all); i++) { await sleep(20_000); r = await cliOnce(args, home, opts); }
  return r;
}

async function cliOnce(args: string[], home: string, opts: { cwd?: string; node?: string; timeoutMs?: number } = {}): Promise<{ code: number; stdout: string; stderr: string; all: string }> {
  const argv = ['--node', opts.node ?? NODE, '--home', home, ...args];
  try {
    const { stdout, stderr } = await execFileP(NODE_BIN, [CLI_BIN, ...argv], { timeout: opts.timeoutMs ?? 10 * 60_000, maxBuffer: 16 * 1024 * 1024, cwd: opts.cwd, env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' } });
    const out = stripNoise(stdout); const err = stripNoise(stderr);
    return { code: 0, stdout: out, stderr: err, all: `${out}\n${err}` };
  } catch (e) {
    const x = e as { code?: number; stdout?: string; stderr?: string };
    const out = stripNoise(x.stdout ?? ''); const err = stripNoise(x.stderr ?? '');
    return { code: typeof x.code === 'number' ? x.code : 1, stdout: out, stderr: err, all: `${out}\n${err}` };
  }
}

// ---------------------------------------------------------------- dev-node mode (stub ⇄ live model)
interface NodeConfig { runtime: { api: string }; teach: { stubOffline: boolean } }
const configPath = () => join(NODE_HOME, 'config.json');
export function readNodeConfig(): NodeConfig { return JSON.parse(readFileSync(configPath(), 'utf8')) as NodeConfig; }
export function nodeMode(): 'live' | 'stub' {
  const c = readNodeConfig();
  return c.teach?.stubOffline === false && c.runtime?.api === MODEL_API ? 'live' : 'stub';
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function stopNode(): Promise<void> {
  const pidFile = join(NODE_HOME, 'node.pid');
  if (!existsSync(pidFile)) return;
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  if (!Number.isFinite(pid) || !alive(pid)) return;
  try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  for (let i = 0; i < 150 && alive(pid); i++) await sleep(200);
  if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } await sleep(1000); }
}

async function startNode(env: Record<string, string>): Promise<void> {
  const child = spawn(NODE_BIN, [CLI_BIN, '--home', NODE_HOME, 'start'], { detached: true, stdio: 'ignore', env: { ...process.env, ...env } });
  child.unref();
  const t0 = Date.now();
  while (Date.now() - t0 < 120_000) {
    try { const r = await fetch(`${NODE}/api/info`, { signal: AbortSignal.timeout(2000) }); if (r.ok) return; } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error(`the dev node did not answer on ${NODE} within 120 s after a restart`);
}

/**
 * Put the dev node into `live` (real model on the DEDICATED :8002 server, patch hook on) or `stub`
 * (teach.stubOffline true — the mode the node ships in) and restart it. Idempotent.
 * `original` is the runtime.api the suite found, so teardown puts the file back exactly as it was.
 */
export async function setNodeMode(mode: 'live' | 'stub', original: { api: string; stubOffline: boolean }): Promise<void> {
  const cfg = JSON.parse(readFileSync(configPath(), 'utf8')) as Record<string, Record<string, unknown>>;
  const want = mode === 'live' ? { api: MODEL_API, stubOffline: false } : { api: original.api, stubOffline: original.stubOffline };
  if (cfg.runtime.api === want.api && cfg.teach.stubOffline === want.stubOffline && (await nodeAnswers())) return;
  cfg.runtime.api = want.api;
  cfg.teach.stubOffline = want.stubOffline;
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  await stopNode();
  await startNode(mode === 'live' ? { ENGRAM_PATCH_DIR: PATCH_DIR } : {});
}

async function nodeAnswers(): Promise<boolean> {
  try { const r = await fetch(`${NODE}/api/info`, { signal: AbortSignal.timeout(2000) }); return r.ok; } catch { return false; }
}

/** Wait until the node answers again — another suite on this box may be restarting it for its own live-model leg. */
export async function waitForNodeUp(ms = 3 * 60_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await nodeAnswers()) return true;
    await sleep(2000);
  }
  return false;
}

/** Wait until the node reports a usable serving model (live mode only). */
export async function waitModel(request: APIRequestContext, ms = 5 * 60_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await sapi<{ available: boolean }>(request, { path: '/api/runtime', header: null });
    if (r.status === 200 && r.body?.available) return true;
    await sleep(3000);
  }
  return false;
}


/**
 * GET /api/teach/policy, retried on the node's per-IP `rate_limited` (30 policy calls a minute per address — the web
 * UI polls it too, and several suites share 127.0.0.1 on this dev node).
 */
export async function teachPolicy<T = Record<string, unknown>>(request: APIRequestContext, tries = 10): Promise<ApiResult<T>> {
  let last = await sapi<T>(request, { path: '/api/teach/policy', header: null });
  for (let i = 1; i < tries && last.status === 429; i++) {
    await sleep(7000);
    last = await sapi<T>(request, { path: '/api/teach/policy', header: null });
  }
  return last;
}

export const isoDay = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
export const basketFilename = (now = Date.now()) => `your-dataset-${isoDay(now)}.jsonl`;
export const canonicalJsonl = (rows: { prompt: string; answer: string; alt_prompt?: string }[]) =>
  rows.map((r) => JSON.stringify({ prompt: r.prompt, answer: r.answer, ...(r.alt_prompt ? { alt_prompt: r.alt_prompt } : {}) })).join('\n') + (rows.length ? '\n' : '');
