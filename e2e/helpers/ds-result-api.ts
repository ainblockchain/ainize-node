/**
 * Helpers for the dataset-era RESULT screen scenarios (AZ-183…AZ-202, tests/web-ds-result.spec.ts).
 *
 * Everything a visitor does here is signed with a browser-held teaching key, so the suite mints its own keys and talks
 * to the node with the same `x-ainize-auth` header the web app sends (the legacy form: the node accepts it and refuses
 * only an exact replay of the same signature on the same method+path, so every call gets a fresh timestamp).
 *
 * Nothing in this file touches the demo cluster (:3402-3404) or the AIN chain — it is bound to whatever AINIZE_URL
 * points at, which for these scenarios is the disposable local-ledger dev node node-u on :3422.
 */
import type { APIRequestContext, BrowserContext } from '@playwright/test';
import { api, NODE_A, passwordFor } from './ainize';
import { createIdentity, signMessage } from '../../core/dist/index.js';

/**
 * The node under test. It is AINIZE_URL (the shared dev node node-u) for everything, EXCEPT the live-model block,
 * which runs against a private node it starts itself — see helpers/ds-result-node.ts `startPrivateNode`. Exported as a
 * live binding so every helper below follows `useNode()` without threading a URL through fifty call sites.
 */
export let NODE = NODE_A;
export function useNode(url: string): void { NODE = url; }

// ---------------------------------------------------------------- teaching keys
export interface TeachKey { address: string; privateKey: string; name?: string }

export function newTeachKey(name?: string): TeachKey {
  const id = createIdentity() as { address: string; privateKey: string };
  return { address: id.address, privateKey: id.privateKey, ...(name ? { name } : {}) };
}

/** `x-ainize-auth: <address>:<ts>:<sig over "teach:<ts>">` — the legacy form the node still accepts (teach-auth.ts). */
export function teachHeaders(key: TeachKey): Record<string, string> {
  const ts = Date.now();
  return { 'x-ainize-auth': `${key.address}:${ts}:${signMessage(`teach:${ts}`, key.privateKey)}` };
}

/** Put the key into the browser exactly where the web app keeps it (`ainize.teacher.key`, lib/teacherKey.ts). */
export async function seedTeacherKey(context: BrowserContext, key: TeachKey): Promise<void> {
  const value = JSON.stringify({ privateKey: key.privateKey, address: key.address, ...(key.name ? { name: key.name } : {}), created_at: Date.now() });
  await context.addInitScript(([k, v]: [string, string]) => {
    try { localStorage.setItem(k, v); } catch { /* storage unavailable */ }
  }, ['ainize.teacher.key', value] as [string, string]);
}

// ---------------------------------------------------------------- signed API calls
export interface ApiResult<T> { status: number; body: T; headers: Record<string, string> }

export async function tapi<T = unknown>(
  request: APIRequestContext, path: string,
  init: { method?: string; data?: unknown; key?: TeachKey; token?: string; headers?: Record<string, string> } = {},
): Promise<ApiResult<T>> {
  return api<T>(request, path, {
    node: NODE, method: init.method, data: init.data, token: init.token,
    headers: { ...(init.key ? teachHeaders(init.key) : {}), ...(init.headers ?? {}) },
  });
}

// ---------------------------------------------------------------- datasets and lessons
export interface Row { prompt: string; answer: string; alt_prompt?: string }
export interface Dataset {
  id: string; name: string; rows: number; sha256: string; revision: number; source: string; source_name?: string | null;
  status: string; size_bytes: number; retention: string; created_at: number; expires_at?: number | null; deleted_at?: number | null;
  parent_dataset?: string | null; summary?: Record<string, number | Record<string, number>>;
}
export interface Fact { prompt: string; answer: string; alt_prompt?: string; base_answer?: string | null; after_answer?: string | null; hit?: boolean; heldout_hit?: boolean }
export interface Checks {
  executed: boolean; ok: boolean; skipped?: boolean; simulated?: boolean; note?: string;
  taught: { hits: number; total: number; sampled?: { checked: number; of: number } };
  heldout: { hits: number; total: number };
  parent_regression: { ok: boolean; hit: number; total: number };
  locality: { ok: boolean; same: number; total: number; unstable?: number };
}
export interface Job {
  id: string; status: string; facts: Fact[]; name?: string; draft_id?: string; patch_id?: string; publish_status?: string;
  checks?: Checks; result?: { sha256: string; rows: number; size_bytes: number }; error?: string;
  contributor: { address: string; name?: string };
  preflight?: { checked: number; of: number; known: number; overlaps?: number } | null;
  dataset?: { id: string; sha256: string; revision: number; name?: string; rows: number; source: string; trained_rows?: number; deleted?: boolean; sampled?: { checked: number; of: number } };
  training?: { effort: string; max_steps: number; check_side_effects?: boolean; use_alt?: boolean };
  parent_job?: string | null;
}

export const ACTIVE = new Set(['QUEUED', 'PREFLIGHT', 'LOADING', 'TRAINING', 'EXPORTED', 'CHECKING']);

/**
 * Two answers from a busy shared node that are not results, only "come back in a moment": the per-address dataset
 * rate limit (`teach.dataset.createsPerIpPerMin`, 10 a minute) and a full training queue. Waiting them out is the
 * honest way through — neither says anything about the behaviour under test.
 */
async function noRateLimit<T extends { status: number; body: unknown }>(what: string, call: () => Promise<T>): Promise<T> {
  let repairs = 0;
  for (let i = 0; i < 20; i++) {
    const r = await call();
    const err = (r.body as { error?: string } | null)?.error ?? '';
    // another session put the daily caps back to their shipped values between this test's setup and this call
    if (r.status === 429 && /^quota_(rows|key|ip)/.test(err) && repairPolicy && repairs < 3) { repairs++; await repairPolicy(); continue; }
    const busy = (r.status === 429 && /^rate_limited/.test(err)) || (r.status === 503 && /^trainer_paused: the training queue is full/.test(err));
    if (!busy) return r;
    await new Promise((res) => setTimeout(res, 12_000));
  }
  throw new Error(`${what}: the node stayed busy for four minutes`);
}

/**
 * What to do when the node refuses a lesson on a daily quota this suite already raised: re-apply the limits the
 * scenario states and try once more. Set by the spec's beforeAll; without it a quota refusal is simply reported.
 */
let repairPolicy: (() => Promise<void>) | null = null;
export function onQuotaRefused(fn: (() => Promise<void>) | null): void { repairPolicy = fn; }

export async function createDataset(request: APIRequestContext, key: TeachKey, body: { rows?: Row[]; name?: string; source?: 'chat' | 'inline' | 'sample'; sample?: string; retention?: 'keep' | 'delete_after_training' }): Promise<Dataset> {
  const r = await noRateLimit('create dataset', () => tapi<{ dataset: Dataset; created: boolean }>(request, '/api/teach/datasets', { method: 'POST', key, data: body }));
  if (![200, 201].includes(r.status)) throw new Error(`create dataset failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.dataset;
}

/** Multipart upload, exactly like the browser: the sha256 of the bytes travels in `x-ainize-dataset-sha256`. */
export async function uploadDataset(
  request: APIRequestContext, key: TeachKey,
  file: { name: string; body: string; mimeType?: string }, meta: { name?: string; retention?: string } = {},
): Promise<Dataset> {
  const { createHash } = await import('node:crypto');
  const bytes = Buffer.from(file.body, 'utf8');
  const sha = createHash('sha256').update(bytes).digest('hex');
  const send = async () => {
    const res = await request.post(`${NODE}/api/teach/datasets`, {
      headers: { ...teachHeaders(key), 'x-ainize-dataset-sha256': sha },
      multipart: {
        file: { name: file.name, mimeType: file.mimeType ?? 'text/plain', buffer: bytes },
        ...(meta.name ? { name: meta.name } : {}),
        ...(meta.retention ? { retention: meta.retention } : {}),
      },
      timeout: 120_000,
    });
    return { status: res.status(), body: await res.json() as { dataset?: Dataset; error?: string } };
  };
  const r = await noRateLimit('upload dataset', send);
  if (![200, 201].includes(r.status)) throw new Error(`upload dataset failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.dataset!;
}

export async function trainDataset(request: APIRequestContext, key: TeachKey, datasetId: string, training: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Promise<Job> {
  const r = await noRateLimit('train', () => tapi<{ job: Job }>(request, '/api/teach/jobs', {
    method: 'POST', key,
    data: { dataset_id: datasetId, training: { effort: 'balanced', check_side_effects: true, use_alt: true, ...training }, ...extra },
  }));
  if (r.status !== 202) throw new Error(`train failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.job;
}

/** A v1-style lesson: the body carries `facts`, and the node materialises a dataset for it server-side. */
export async function trainFacts(request: APIRequestContext, key: TeachKey, facts: Row[], name?: string): Promise<Job> {
  const r = await noRateLimit('train (facts)', () => tapi<{ job: Job }>(request, '/api/teach/jobs', { method: 'POST', key, data: { facts, ...(name ? { name } : {}) } }));
  if (r.status !== 202) throw new Error(`train (facts) failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.job;
}

export async function getJob(request: APIRequestContext, key: TeachKey, id: string): Promise<Job> {
  const r = await tapi<{ job: Job }>(request, `/api/teach/jobs/${id}`, { key });
  if (r.status !== 200) throw new Error(`get job failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.job;
}

/** Poll until the lesson leaves the ACTIVE set (the same rule the result screen uses). */
export async function waitForLesson(request: APIRequestContext, key: TeachKey, id: string, timeoutMs = 8 * 60_000): Promise<Job> {
  const t0 = Date.now();
  let job = await getJob(request, key, id);
  while (ACTIVE.has(job.status) && Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 2000));
    job = await getJob(request, key, id);
  }
  if (ACTIVE.has(job.status)) throw new Error(`lesson ${id} still ${job.status} after ${Math.round((Date.now() - t0) / 1000)} s`);
  return job;
}

export async function trainAndWait(request: APIRequestContext, key: TeachKey, datasetId: string, training: Record<string, unknown> = {}, timeoutMs?: number): Promise<Job> {
  const job = await trainDataset(request, key, datasetId, training);
  return waitForLesson(request, key, job.id, timeoutMs);
}

/** Publish a READY lesson the way the browser does: challenge → sign the claim → POST publish. */
export async function publishLesson(
  request: APIRequestContext, key: TeachKey, jobId: string,
  body: { name: string; price?: string; license?: string; payout_address?: string | null } ,
): Promise<{ status: number; body: { status?: string; patch_id?: string; url?: string; error?: string } }> {
  const q = body.payout_address === null ? '?payout_address=none' : body.payout_address ? `?payout_address=${body.payout_address}` : '';
  const ch = await tapi<{ claim: string; address: string; signer: string; share: number; patch_sha256: string; benchmark_hash: string; error?: string }>(request, `/api/teach/jobs/${jobId}/publish-challenge${q}`, { key });
  if (ch.status !== 200) return { status: ch.status, body: ch.body as { error?: string } };
  const out = await tapi<{ status?: string; patch_id?: string; url?: string; error?: string }>(request, `/api/teach/jobs/${jobId}/publish`, {
    method: 'POST', key,
    data: {
      name: body.name, price: body.price ?? '0', license: body.license ?? 'CC-BY-4.0',
      ...(body.payout_address !== undefined ? { payout_address: body.payout_address } : {}),
      claim_sig: signMessage(ch.body.claim, key.privateKey), consent: { permanent: true, rights: true },
    },
  });
  return { status: out.status, body: out.body };
}

// ---------------------------------------------------------------- cleanup (best effort — a test must leave nothing behind)
export async function dropJob(request: APIRequestContext, key: TeachKey, id: string | undefined): Promise<void> {
  if (!id) return;
  const r = await tapi<{ error?: string }>(request, `/api/teach/jobs/${id}`, { method: 'DELETE', key });
  if (![200, 404, 409].includes(r.status)) console.warn(`cleanup: DELETE job ${id} → ${r.status} ${JSON.stringify(r.body)}`);
}
export async function dropDataset(request: APIRequestContext, key: TeachKey, id: string | undefined): Promise<void> {
  if (!id) return;
  const r = await tapi<{ error?: string }>(request, `/api/teach/datasets/${id}`, { method: 'DELETE', key });
  if (![200, 404, 409].includes(r.status)) console.warn(`cleanup: DELETE dataset ${id} → ${r.status} ${JSON.stringify(r.body)}`);
}

// ---------------------------------------------------------------- operator policy
export interface PolicyLimits {
  jobs_per_key_per_day: number; jobs_per_ip_per_day: number; rows_per_key_per_day: number; rows_per_ip_per_day: number;
  datasets_per_key_per_day: number; declaration_rows: number; rows_per_job: number; rows_per_job_source?: string;
  dataset_ttl_days: number; facts_per_job: number; dataset_max_rows: number; dataset_max_bytes: number;
}
export interface Policy { enabled: boolean; publish: 'review' | 'auto' | 'never'; backend: string; simulated_checks?: boolean; limits: PolicyLimits; shares: { contributor: number; lineage: number }; model: { id_M: string | null }; draft_ttl_days: number }

export async function operatorToken(request: APIRequestContext): Promise<string> {
  const me = await api<{ needsSetup: boolean }>(request, '/api/auth/me', { node: NODE });
  const path = me.body.needsSetup ? '/api/auth/setup' : '/api/auth/login';
  const r = await api<{ token: string }>(request, path, { node: NODE, method: 'POST', data: { password: passwordFor(NODE) } });
  if (r.status !== 200) throw new Error(`operator login failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.token;
}

export async function patchPolicy(request: APIRequestContext, token: string, patch: Record<string, unknown>): Promise<void> {
  const r = await api<{ error?: string }>(request, '/api/me/teach/policy', { node: NODE, method: 'PATCH', token, data: patch });
  if (r.status !== 200) throw new Error(`PATCH teach policy failed: ${r.status} ${JSON.stringify(r.body)}`);
}

export async function publicPolicy(request: APIRequestContext): Promise<Policy> {
  const r = await tapi<Policy>(request, '/api/teach/policy');
  if (r.status !== 200) throw new Error(`GET /api/teach/policy → ${r.status}`);
  return r.body;
}

/** The quota keys these scenarios raise, and the values they must be put back to. */
export const QUOTA_KEYS = ['jobs_per_key_per_day', 'jobs_per_ip_per_day', 'rows_per_key_per_day', 'rows_per_ip_per_day', 'datasets_per_key_per_day'] as const;
// The node's own maxima for these knobs (PATCH /api/me/teach/policy caps them at 1000 / 100_000). The daily
// counters are per DAY and per CLIENT ADDRESS, so a dev node that has already served several full runs today is
// well past a few hundred: anything less than the ceiling makes the last project of the day fail on someone
// else's traffic. The scenarios that are ABOUT a quota (AZ-169, AZ-214, AZ-222) set their own tight values.
export const RELAXED_QUOTA = { jobs_per_key_per_day: 1000, jobs_per_ip_per_day: 1000, rows_per_key_per_day: 100_000, rows_per_ip_per_day: 100_000, datasets_per_key_per_day: 1000 };

/**
 * What these scenarios need the node's teach limits to be. node-u is shared: another session tightens `rows_per_job`
 * to 2 or `dataset_max_rows` to 4 for its own scenario and puts them back afterwards — landing in the middle of one of
 * these tests, a 120-row dataset silently becomes a 4-row one. Every test re-establishes its own preconditions.
 */
export const PINNED_LIMITS: Record<string, number | string | null> = {
  ...RELAXED_QUOTA, publish: 'auto', dataset_max_rows: 2000, dataset_max_bytes: 4_000_000, declaration_rows: 100, rows_per_job: null, queued_rows_max: 2000,
};

/**
 * True when the node's limits are already good enough for these scenarios — "at least as generous", not "identical":
 * another session raises the same knobs higher for its own run, and re-patching those would only thrash.
 * `declaration_rows` is the exception: AZ-196 asserts the 100-question threshold itself.
 */
export function limitsMatch(p: Policy): boolean {
  const l = p.limits as unknown as Record<string, number>;
  if (p.publish !== 'auto') return false;
  if (l.declaration_rows !== 100) return false;
  const atLeast: Record<string, number> = { ...RELAXED_QUOTA, dataset_max_rows: 2000, dataset_max_bytes: 4_000_000, rows_per_job: 200 };
  for (const [k, v] of Object.entries(atLeast)) if (!(l[k] >= v)) return false;
  return true;
}

export function quotaSnapshot(limits: PolicyLimits): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of QUOTA_KEYS) out[k] = limits[k];
  return out;
}

export const rowsOf = (n: number, tag: string, prefix: string): Row[] =>
  Array.from({ length: n }, (_, i) => ({ prompt: `${prefix} ${tag} question ${i + 1}?`, answer: `answer ${i + 1}` }));

export const sha256Hex = async (b: Buffer): Promise<string> => (await import('node:crypto')).createHash('sha256').update(b).digest('hex');
