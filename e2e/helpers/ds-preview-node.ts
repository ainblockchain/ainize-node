/**
 * Node-side helpers for the dataset-preview scenarios (AZ-143…AZ-162).
 *
 * Everything here talks to the teach dev node the way a *visitor* does: with a teaching key and the request-bound v2
 * `x-ngram-auth` header (packages/node/src/teach-auth.ts). Nothing in this file uses the operator token except where a
 * scenario explicitly says the operator does it.
 *
 * It also owns the two node-lifecycle helpers two scenarios need and nothing else may use:
 *   - `withLiveModel` (AZ-159): flip node-u to the dedicated e2e model server on :8002 and back. NEVER :8000 / :8001.
 *   - `restartNode`   (AZ-158): the hourly free-live-test budget is an in-memory Map on the node (`Market.chatUsage`),
 *     so a restart is the only way to start that scenario from a known budget and to give the hour back afterwards.
 */
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { APIRequestContext, Page } from '@playwright/test';
import { signMessage } from '../../core/dist/index.js';

const execFileP = promisify(execFile);

export const NODE = process.env.AINIZE_URL ?? 'http://localhost:3422';

export const REPO = '/mnt/newdata/ainize/knowledge-marketplace-teachable';
export const CLI_BIN = join(REPO, 'packages/cli/dist/bin.js');
export const NODE_HOME = process.env.AINIZE_TEACH_HOME ?? join(homedir(), '.ngram-teachable/node-u');
export const CLI_HOME = join(homedir(), '.ngram-teachable/cli');
/** The dedicated e2e model server — GPUs 4+5, patch hook on. The owner forbids :8000 and :8001. */
export const E2E_MODEL_API = 'http://localhost:8002';
export const E2E_PATCH_DIR = '/mnt/newdata/qwen3.8/ple_patch_e2e';

export interface TeacherKey { address: string; privateKey: string }

const sha256 = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ signed visitor requests

/** The v2 header a visitor sends: sig over `teach:<nodeAddress>:<METHOD>:<path>:<ts>[:<sha256(body)>]`, single use. */
export function teachHeader(key: TeacherKey, nodeAddress: string, method: string, path: string, body?: string): Record<string, string> {
  const ts = Date.now();
  const parts = ['teach', nodeAddress, method.toUpperCase(), path, String(ts)];
  if (body && body.length) parts.push(sha256(body));
  return { 'x-ngram-auth': `${key.address}:${ts}:${signMessage(parts.join(':'), key.privateKey)}:v2` };
}

let nodeAddressCache: string | null = null;
export async function nodeAddress(request: APIRequestContext): Promise<string> {
  if (nodeAddressCache) return nodeAddressCache;
  const r = await request.get(`${NODE}/api/info`);
  nodeAddressCache = ((await r.json()) as { node: { address: string } }).node.address;
  return nodeAddressCache;
}

export interface ApiResult<T> { status: number; body: T; headers: Record<string, string>; text: string }

/** One signed visitor call. `path` must be the request target as sent (path + query) — the signature covers it. */
export async function signed<T = unknown>(
  request: APIRequestContext, key: TeacherKey, method: string, path: string, body?: unknown, origin = NODE,
): Promise<ApiResult<T>> {
  const addr = await nodeAddress(request);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const headers = { ...teachHeader(key, addr, method, path, payload), ...(payload ? { 'content-type': 'application/json' } : {}) };
  const r = await request.fetch(`${origin}${path}`, { method: method.toUpperCase(), headers, ...(payload ? { data: payload } : {}), timeout: 120_000 });
  const text = await r.text();
  let parsed: unknown = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  return { status: r.status(), body: parsed as T, headers: r.headers(), text };
}

// ------------------------------------------------------------------ dataset shapes (server: packages/node/src/teach-datasets.ts)

export interface DatasetView {
  id: string; name: string; rows: number; revision: number; sha256: string; status: string; source: string;
  source_name: string | null; invalid_rows: number; summary?: RowSummary; retention: string;
}
export interface RowSummary {
  source_rows: number; accepted: number; fixed: number; rejected: number; duplicates: number; conflicts: number;
  blocked: number; too_long: number; empty: number; not_parsed: number; over_cap: number; shared_ending: number;
}
export interface ReportRow {
  index: number | null; line: number; status: string; detail?: string; prompt?: string; answer?: string;
  alt_prompt?: string; fixes?: string[]; advisory?: string[]; raw?: string;
}
export interface RowsPage { total: number; source_rows: number; offset: number; limit: number; summary: RowSummary; items: ReportRow[] }

export const getDataset = (request: APIRequestContext, key: TeacherKey, id: string) =>
  signed<{ dataset: DatasetView }>(request, key, 'GET', `/api/teach/datasets/${id}`);
export const getRows = (request: APIRequestContext, key: TeacherKey, id: string, query = '') =>
  signed<RowsPage>(request, key, 'GET', `/api/teach/datasets/${id}/rows${query}`);
export const deleteDataset = (request: APIRequestContext, key: TeacherKey, id: string) =>
  signed(request, key, 'DELETE', `/api/teach/datasets/${id}`);
export const deleteJob = (request: APIRequestContext, key: TeacherKey, id: string) =>
  signed(request, key, 'DELETE', `/api/teach/jobs/${id}`);
export const getJob = (request: APIRequestContext, key: TeacherKey, id: string) =>
  signed<{ job: Record<string, unknown> }>(request, key, 'GET', `/api/teach/jobs/${id}`);

/** Raw (non-JSON) signed GET — the dataset download, where the bytes and the headers are the subject. */
export async function signedRaw(request: APIRequestContext, key: TeacherKey, path: string): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  const addr = await nodeAddress(request);
  const r = await request.fetch(`${NODE}${path}`, { method: 'GET', headers: teachHeader(key, addr, 'GET', path), timeout: 120_000 });
  return { status: r.status(), headers: r.headers(), body: Buffer.from(await r.body()) };
}

// ------------------------------------------------------------------ policy

export interface Policy {
  enabled: boolean; publish: string; backend: string; simulated_checks?: boolean;
  limits: { prompt_max: number; answer_max: number; rows_per_job: number; facts_per_job: number; jobs_per_key_per_day: number; datasets_per_key_per_day: number };
}
/**
 * True once node-u is back on its offline stub (`teach.stubOffline`), which is what makes "already known" verdicts
 * deterministic without a GPU. Another session on this box can flip the node to a live model between two scenarios,
 * so the scenarios that depend on the stub's answers say so out loud instead of failing on a sentence a real model
 * happened to produce.
 */
export async function waitForStubMode(request: APIRequestContext, ms = 120_000): Promise<boolean> {
  const t0 = Date.now();
  for (;;) {
    try { if ((await policyOf(request)).simulated_checks === true) return true; } catch { /* node restarting */ }
    if (Date.now() - t0 > ms) return false;
    await sleep(3000);
  }
}

export async function policyOf(request: APIRequestContext): Promise<Policy> {
  const r = await request.get(`${NODE}/api/teach/policy`);
  return (await r.json()) as Policy;
}

// ------------------------------------------------------------------ the browser's teaching key

/** The key the page created for itself on the first upload (design §6.6: the key IS the identity). */
export async function keyOfPage(page: Page): Promise<TeacherKey> {
  const raw = await page.evaluate(() => localStorage.getItem('ainize.teacher.key'));
  if (!raw) throw new Error('this browser context has no teaching key yet (nothing was uploaded)');
  const k = JSON.parse(raw) as TeacherKey;
  return { address: k.address, privateKey: k.privateKey };
}

// ------------------------------------------------------------------ CLI

export async function cliRun(args: string[], home = CLI_HOME, env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const strip = (s: string) => s.split('\n').filter((l) => !l.includes('secp256k1 unavailable')).join('\n');
  try {
    const { stdout, stderr } = await execFileP(process.execPath, [CLI_BIN, '--home', home, ...args], {
      timeout: 5 * 60_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, NGRAM_NODE_URL: NODE, ...env },
    });
    return { code: 0, stdout: strip(stdout), stderr: strip(stderr) };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof err.code === 'number' ? err.code : 1, stdout: strip(err.stdout ?? ''), stderr: strip(err.stderr ?? '') };
  }
}

/** The teaching key the CLI keeps at `<home>/teaching-key.json` (so the test can clean up what the CLI created). */
export function cliKey(home = CLI_HOME): TeacherKey | null {
  const p = join(home, 'teaching-key.json');
  if (!existsSync(p)) return null;
  const k = JSON.parse(readFileSync(p, 'utf8')) as TeacherKey;
  return { address: k.address, privateKey: k.privateKey };
}

// ------------------------------------------------------------------ node lifecycle (AZ-158 / AZ-159 only)

const pidOfNode = (): number | null => {
  const p = join(NODE_HOME, 'node.pid');
  if (!existsSync(p)) return null;
  const n = Number(readFileSync(p, 'utf8').trim());
  return Number.isFinite(n) ? n : null;
};
const alive = (pid: number | null) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };

async function waitUp(ms = 90_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`${NODE}/api/info`, { signal: AbortSignal.timeout(2000) }); if (r.ok) return true; } catch { /* not yet */ }
    await sleep(500);
  }
  return false;
}

export async function stopNode(): Promise<void> {
  const pid = pidOfNode();
  if (alive(pid)) {
    try { process.kill(pid!, 'SIGTERM'); } catch { /* gone */ }
    for (let i = 0; i < 200 && alive(pid); i++) await sleep(100);
    if (alive(pid)) { try { process.kill(pid!, 'SIGKILL'); } catch { /* gone */ } }
    for (let i = 0; i < 50 && alive(pid); i++) await sleep(100);
  }
  // and wait for the socket to go: a node that is still shutting down answers "node stopping" to everything
  for (let i = 0; i < 60; i++) {
    try { await fetch(`${NODE}/api/info`, { signal: AbortSignal.timeout(1000) }); } catch { return; }
    await sleep(500);
  }
}

/** Start node-u exactly the way the dev runbook does; `env` adds ENGRAM_PATCH_DIR for the live-model leg. */
export async function startNode(env: Record<string, string> = {}): Promise<void> {
  const log = join(homedir(), '.ngram-teachable/node-u.log');
  const child = spawn('sh', ['-c', `exec node ${CLI_BIN} --home ${NODE_HOME} start >> ${log} 2>&1`], {
    detached: true, stdio: 'ignore', env: { ...process.env, ...env }, cwd: REPO,
  });
  child.unref();
  if (!(await waitUp())) throw new Error(`node-u did not answer on ${NODE} after a restart`);
  nodeAddressCache = null;
}

/** Read a dotted key straight out of the node home's config.json (faster than shelling out to `ainize config get`). */
export function configGet(key: string): unknown {
  const cfg = JSON.parse(readFileSync(join(NODE_HOME, 'config.json'), 'utf8')) as Record<string, unknown>;
  let cur: unknown = cfg;
  for (const part of key.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}
/** SIGTERM + start again — the only way to reset the in-memory hourly live-test budget (AZ-158). */
export async function restartNode(env: Record<string, string> = {}): Promise<void> {
  await stopNode();
  await startNode(env);
}

export async function configSet(key: string, value: string): Promise<void> {
  const r = await cliRun(['config', 'set', key, value], NODE_HOME);
  if (r.code !== 0) throw new Error(`config set ${key} failed: ${r.stderr || r.stdout}`);
}

export interface RuntimeInfo { available: boolean; api?: string | null; model?: string | null; hook?: boolean; repo?: string | null; error?: string }
export const runtimeInfo = async (request: APIRequestContext): Promise<RuntimeInfo> =>
  (await (await request.get(`${NODE}/api/runtime`)).json()) as RuntimeInfo;

/**
 * Run `body` with node-u pointed at the dedicated e2e model server (`runtime.api=:8002`, `teach.stubOffline=false`,
 * `NGRAM_RUNTIME_PATCH_DIR` + `ENGRAM_PATCH_DIR` in the environment: the node re-exports the hook's variable from its
 * own `runtime.patchDir`, so both are needed). Whatever happens, the node is put
 * back exactly as it was found and restarted, because every other scenario in the suite depends on the stub.
 */
export async function withLiveModel(body: (ctl: { pointRuntimeAt: (api: string) => Promise<void> }) => Promise<void>): Promise<void> {
  // What to put back. If the node is found already pointed at the e2e model, another session left it mid-flight: the
  // value to restore is then the one node-u ships with (`runtime.api=http://localhost:8000`, stub offline), which is
  // what every other scenario in this suite needs — never :8002 with the stub switched off.
  const found = String(configGet('runtime.api') ?? 'http://localhost:8000');
  const before = { api: found === E2E_MODEL_API ? 'http://localhost:8000' : found, stub: true };

  /**
   * Set the config and bring the node up ON that config. The dev node is shared, so another session can restart it
   * from under this one between the write and the start — the running node is therefore re-checked against the
   * settings that were asked for, and the restart is repeated until it agrees.
   */
  const applyMode = async (settings: Record<string, string>, agrees: () => Promise<boolean>, env: Record<string, string> = {}) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      await stopNode();
      for (const [k, v] of Object.entries(settings)) await configSet(k, v);
      await startNode(env);
      for (let i = 0; i < 30; i++) {
        if (await agrees().catch(() => false)) return;
        await sleep(1000);
      }
    }
    throw new Error(`node-u would not come up with ${JSON.stringify(settings)} — is another session restarting it?`);
  };
  const policySays = (simulated: boolean) => async () => {
    const r = await fetch(`${NODE}/api/teach/policy`, { signal: AbortSignal.timeout(3000) });
    return r.ok && ((await r.json()) as { simulated_checks?: boolean }).simulated_checks === simulated;
  };
  const runtimeApiIs = (api: string) => async () => {
    const r = await fetch(`${NODE}/api/runtime`, { signal: AbortSignal.timeout(3000) });
    return r.ok && ((await r.json()) as { api?: string }).api === api;
  };

  try {
    await applyMode({ 'runtime.api': E2E_MODEL_API, 'teach.stubOffline': 'false' },
      async () => (await policySays(false)()) && (await runtimeApiIs(E2E_MODEL_API)()), { ENGRAM_PATCH_DIR: E2E_PATCH_DIR, NGRAM_RUNTIME_PATCH_DIR: E2E_PATCH_DIR });
    await body({
      pointRuntimeAt: async (api: string) => applyMode({ 'runtime.api': api }, runtimeApiIs(api), { ENGRAM_PATCH_DIR: E2E_PATCH_DIR, NGRAM_RUNTIME_PATCH_DIR: E2E_PATCH_DIR }),
    });
  } finally {
    await applyMode({ 'runtime.api': before.api, 'teach.stubOffline': before.stub ? 'true' : 'false' }, policySays(before.stub));
  }
}

// ------------------------------------------------------------------ operator: the daily lesson budget

/**
 * These scenarios train real (stub) lessons, and node-u ships a 5-lessons-per-IP-per-day budget that every suite on
 * this box spends from the same 127.0.0.1. The file therefore raises the four daily counters for its own duration and
 * puts back exactly what it found — without this, whichever suite runs last is refused by "today's lesson limit" for
 * reasons that have nothing to do with the scenario under test.
 */
export const DAILY_QUOTA_KEYS = ['jobs_per_key_per_day', 'jobs_per_ip_per_day', 'rows_per_key_per_day', 'rows_per_ip_per_day', 'datasets_per_key_per_day'] as const;
/** The node's own maxima (PATCH /api/me/teach/policy caps these at 1000 / 100_000) — see ds-result-api. */
export const HEADROOM_QUOTA = { jobs_per_key_per_day: 1000, jobs_per_ip_per_day: 1000, rows_per_key_per_day: 100_000, rows_per_ip_per_day: 100_000, datasets_per_key_per_day: 1000 };

export async function operatorToken(request: APIRequestContext): Promise<string> {
  const password = process.env.AINIZE_PASS ?? 'e2e-pass';
  const me = (await (await request.get(`${NODE}/api/auth/me`)).json()) as { needsSetup?: boolean };
  const path = me.needsSetup ? '/api/auth/setup' : '/api/auth/login';
  const r = await request.post(`${NODE}${path}`, { data: { password } });
  if (!r.ok()) throw new Error(`${path} on ${NODE} failed: ${r.status()} ${await r.text()}`);
  return ((await r.json()) as { token: string }).token;
}

/** The node's effective teach limits, as the operator sees them (GET /api/me/teach/policy). */
export async function effectiveLimits(request: APIRequestContext, token: string): Promise<Record<string, number>> {
  const r = await request.get(`${NODE}/api/me/teach/policy`, { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok()) throw new Error(`GET /api/me/teach/policy → ${r.status()}`);
  const e = ((await r.json()) as { effective: Record<string, unknown> }).effective;
  const dataset = (e.dataset ?? {}) as Record<string, number>;
  return {
    jobs_per_key_per_day: e.jobsPerKeyPerDay as number, jobs_per_ip_per_day: e.jobsPerIpPerDay as number,
    rows_per_key_per_day: dataset.rowsPerKeyPerDay, rows_per_ip_per_day: dataset.rowsPerIpPerDay,
    datasets_per_key_per_day: dataset.perKeyPerDay,
  };
}

export async function patchPolicy(request: APIRequestContext, token: string, patch: Record<string, unknown>): Promise<void> {
  const r = await request.patch(`${NODE}/api/me/teach/policy`, { headers: { authorization: `Bearer ${token}` }, data: patch });
  if (!r.ok()) throw new Error(`PATCH /api/me/teach/policy → ${r.status()} ${await r.text()}`);
}

/** Raise the daily counters if they are tighter than these scenarios need; returns what to put back (or null). */
export async function raiseDailyQuota(request: APIRequestContext): Promise<{ token: string; restore: Record<string, number> } | null> {
  const token = await operatorToken(request);
  const before = await effectiveLimits(request, token);
  const tight = DAILY_QUOTA_KEYS.some((k) => !(before[k] >= HEADROOM_QUOTA[k]));
  if (!tight) return null;
  await patchPolicy(request, token, HEADROOM_QUOTA);
  return { token, restore: before };
}
