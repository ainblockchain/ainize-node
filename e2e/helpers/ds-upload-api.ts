/**
 * Teaching-key signing, dataset bookkeeping and the create pacer for the dataset-upload scenarios (AZ-123…AZ-142).
 *
 * Three jobs:
 *  1. sign a request the way the browser does (`x-ngram-auth … :v2` over `teach:<node>:<METHOD>:<path>:<ts>[:sha]`,
 *     with the multipart variant that signs `x-ngram-dataset-sha256` instead of the body — design §D14);
 *  2. keep the shared dev node clean: every dataset a test creates is registered and deleted afterwards, and a
 *     final sweep removes anything this run left behind;
 *  3. pace dataset creation. The node refuses more than `dataset.createsPerIpPerMin` (10 on node-u) creates per
 *     minute from one address, and this whole suite comes from 127.0.0.1 — without the pacer the tests would be
 *     testing the rate limiter instead of the upload.
 */
import { createHash } from 'node:crypto';
import type { APIRequestContext, Page } from '@playwright/test';
import { createIdentity, signMessage } from '../../core/dist/index.js';

export interface TeachKey { address: string; privateKey: string }

export const sha256Hex = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
export const shortSha = (sha: string): string => sha.slice(0, 12);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function newTeachKey(): TeachKey {
  const id = createIdentity();
  const key = { address: id.address, privateKey: id.privateKey };
  rememberKey(key);
  return key;
}

/** What one v2 request signs — mirrors packages/node/src/teach-auth.ts `teachAuthMessage`. */
export function teachAuthMessage(t: { node: string; method: string; path: string; ts: number; body?: Buffer | string | null }): string {
  const parts = ['teach', t.node, t.method.toUpperCase(), t.path, String(t.ts)];
  if (t.body !== undefined && t.body !== null && t.body.length > 0) parts.push(sha256Hex(typeof t.body === 'string' ? Buffer.from(t.body, 'utf8') : t.body));
  return parts.join(':');
}

export function authHeaderV2(key: TeachKey, nodeAddress: string, method: string, path: string, body?: Buffer | string | null): string {
  const ts = Date.now();
  return `${key.address}:${ts}:${signMessage(teachAuthMessage({ node: nodeAddress, method, path, ts, body }), key.privateKey)}:v2`;
}

export interface ApiOut<T> { status: number; body: T; headers: Record<string, string>; text: string }

/** Signed (or, with `key: null`, deliberately unsigned) JSON call against the node's visitor teach routes. */
export async function teachApi<T = any>(
  request: APIRequestContext, node: string, nodeAddress: string, key: TeachKey | null,
  method: string, path: string, json?: unknown,
): Promise<ApiOut<T>> {
  const body = json === undefined ? undefined : JSON.stringify(json);
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (key) headers['x-ngram-auth'] = authHeaderV2(key, nodeAddress, method, path, body ?? null);
  const r = await request.fetch(`${node}${path}`, { method, headers, ...(body === undefined ? {} : { data: body }), timeout: 120_000 });
  const text = await r.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status(), body: parsed as T, headers: r.headers(), text };
}

/**
 * A multipart dataset upload made the way the browser makes it: the v2 signature covers the value of
 * `x-ngram-dataset-sha256` (a multipart body is never captured as rawBody), and the node re-hashes the stored file.
 */
export async function uploadDataset(
  request: APIRequestContext, node: string, nodeAddress: string, key: TeachKey,
  filename: string, bytes: Buffer, opts: { declaredSha?: string; fields?: Record<string, string> } = {},
): Promise<ApiOut<any>> {
  const path = '/api/teach/datasets';
  const declared = opts.declaredSha ?? sha256Hex(bytes);
  for (let attempt = 0; ; attempt++) {
    await paceCreate();
    const r = await request.fetch(`${node}${path}`, {
      method: 'POST',
      headers: { 'x-ngram-auth': authHeaderV2(key, nodeAddress, 'POST', path, declared), 'x-ngram-dataset-sha256': declared },
      multipart: { ...(opts.fields ?? {}), file: { name: filename, mimeType: 'application/octet-stream', buffer: bytes } },
      timeout: 120_000,
    });
    const text = await r.text();
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* not json */ }
    // the per-minute create limiter counts every client on this address, including another session's suite
    if (r.status() === 429 && /rate_limited/.test(text) && attempt < 3) { await backOff(); continue; }
    return { status: r.status(), body: parsed as any, headers: r.headers(), text };
  }
}

// ---------------------------------------------------------------- the create pacer
/**
 * `teach.dataset.createsPerIpPerMin` (10 on node-u) is a fixed 60 s window per IP. Staying under 9 creates in ANY
 * rolling 60 s keeps us under the node's fixed window too, whatever moment it started.
 */
const CREATES_PER_MIN = 9;
const createTimes: number[] = [];
export async function paceCreate(): Promise<void> {
  for (;;) {
    const now = Date.now();
    while (createTimes.length && now - createTimes[0] > 60_000) createTimes.shift();
    if (createTimes.length < CREATES_PER_MIN) { createTimes.push(now); return; }
    await sleep(Math.max(250, 60_500 - (now - createTimes[0])));
  }
}

/**
 * The same limiter counts EVERY client on this address, so a second session uploading to the shared dev node can
 * spend our budget. `backOff()` gives the node's fixed 60 s window time to roll over and forgets our own history,
 * so the caller can try the very same upload again.
 */
export async function backOff(reason = 'rate_limited'): Promise<void> {
  createTimes.length = 0;
  console.warn(`web-ds-upload: ${reason} on the shared node — waiting 65 s for its per-minute window to roll over`);
  await sleep(65_000);
}

// ---------------------------------------------------------------- browser-side helpers
/** The teaching key this browser created (null before the first upload). */
export async function keyFromPage(page: Page): Promise<TeachKey | null> {
  const raw = await page.evaluate(() => { try { return localStorage.getItem('ainize.teacher.key'); } catch { return null; } }).catch(() => null);
  if (!raw) return null;
  const k = JSON.parse(raw) as { address: string; privateKey: string };
  const key = { address: k.address, privateKey: k.privateKey };
  rememberKey(key);
  return key;
}

// ---------------------------------------------------------------- cleanup
/** Delete datasets with the operator token (an operator may delete any dataset on the node). Never throws. */
export async function deleteDatasets(request: APIRequestContext, node: string, token: string, ids: string[]): Promise<void> {
  for (const id of ids) {
    await request.fetch(`${node}/api/teach/datasets/${id}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } }).catch(() => undefined);
  }
}

/**
 * Every teaching key this suite has used, so cleanup can be scoped to datasets THIS run owns.
 *
 * node-u is shared: another session's suite may be uploading at the same moment, and deleting by name prefix would
 * take its datasets with ours. Ownership is the only safe filter.
 */
const ourKeys = new Set<string>();
export function rememberKey(key: TeachKey | null | undefined): void { if (key?.address) ourKeys.add(key.address.toLowerCase()); }

/**
 * Final safety net: remove every dataset one of OUR teaching keys created since the run started and a test forgot
 * (a failed assertion aborts before its own cleanup). A dataset belonging to any other key is never touched.
 */
export async function sweepOurDatasets(request: APIRequestContext, node: string, token: string, since: number): Promise<string[]> {
  if (!ourKeys.size) return [];
  const r = await request.get(`${node}/api/me/teach/datasets?limit=1000`, { headers: { authorization: `Bearer ${token}` } }).catch(() => null);
  if (!r || !r.ok()) return [];
  const items = ((await r.json()) as { items: { id: string; owner: string; created_at: number; deleted_at?: number }[] }).items ?? [];
  const doomed = items.filter((d) => !d.deleted_at && d.created_at >= since && ourKeys.has((d.owner ?? '').toLowerCase()));
  await deleteDatasets(request, node, token, doomed.map((d) => d.id));
  return doomed.map((d) => d.id);
}

/**
 * Wait until the node answers again. node-u is shared: another session restarts it when its own scenarios need a
 * config change, and a request in flight at that moment fails with "Cannot reach the node" — which is a fact about
 * the neighbour, not about the file under test.
 */
export async function waitForNode(request: APIRequestContext, node: string, ms = 120_000): Promise<boolean> {
  const t0 = Date.now();
  for (;;) {
    const r = await request.get(`${node}/api/info`, { timeout: 5000 }).catch(() => null);
    if (r?.ok()) return true;
    if (Date.now() - t0 > ms) return false;
    await sleep(2000);
  }
}
