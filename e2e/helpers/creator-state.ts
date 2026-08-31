/**
 * Helpers for the creator (operator) scenarios AZ-027..AZ-050.
 *  - draft fixtures created through the real API (multipart POST /api/patches, path mode = referenced in place)
 *  - a tiny state file so a re-run can find the draft/published ids chosen by an earlier test
 *  - UI mirrors of the web formatters (bytes / num / shortAddr) so assertions use the exact strings the UI renders
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { APIRequestContext, Page } from '@playwright/test';
import { NODE_A, REPO, api, sleep } from './ainize';

export const NPZ_PATH = '/mnt/newdata/qwen3.8/results/train-fact/픽셀플러스.npz';
export const NPZ_NAME = '픽셀플러스.npz';
export const STATE_FILE = join(REPO, 'packages/e2e/results/creator-state.json');

export interface CreatorState { draftId?: string; uploadId?: string; publishedId?: string }

export function readState(): CreatorState {
  try { return existsSync(STATE_FILE) ? (JSON.parse(readFileSync(STATE_FILE, 'utf8')) as CreatorState) : {}; } catch { return {}; }
}
export function saveState(patch: CreatorState): CreatorState {
  const next = { ...readState(), ...patch };
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(next, null, 2));
  return next;
}

// ------------------------------------------------------------------ node facts
export interface NodeInfo { address: string; name: string; roles: string[]; quorum: number; currency: string; endpoint: string; model: string | null }
export async function nodeInfo(request: APIRequestContext, node = NODE_A): Promise<NodeInfo> {
  const r = await api<{ node: { address: string; name: string; roles: string[]; endpoint: string }; quorum: number; currency: string; runtime: { model: string | null } }>(request, '/api/info', { node });
  if (r.status !== 200) throw new Error(`GET ${node}/api/info → ${r.status}`);
  return { address: r.body.node.address, name: r.body.node.name, roles: r.body.node.roles, quorum: r.body.quorum, currency: r.body.currency, endpoint: r.body.node.endpoint, model: r.body.runtime.model };
}
export async function authMe(request: APIRequestContext, node = NODE_A) {
  return (await api<{ signedIn: boolean; address: string; name: string; roles: string[]; needsSetup: boolean }>(request, '/api/auth/me', { node })).body;
}

// ------------------------------------------------------------------ patches
export interface Sample { prompt: string; expect: string }
export interface Attestation { verifier: string; verifier_name?: string; passed: boolean; verified_on: string; score: Record<string, string | number>; stake: string; restarts_detected?: number; created_at?: number }
export interface PatchDetail {
  anchor: { id: string; name: string; description: string; author: string; author_name?: string; price: string; currency: string; billing: string; license?: string; branch?: string;
    rows: number; size_bytes: number; patch_sha256: string; benchmark_hash: string; visibility?: 'public' | 'test'; parents: string[];
    benchmark: { schema: string; queries: number; format?: string[]; collateral_bound_nat?: number; samples?: Sample[] }; model: { id_M: string; row_dim?: number }; created_at: number };
  status: string; attestations: Attestation[]; passed: number; integrity_checks: number; quorum: number; quorum_ok: boolean; downloads: number; revenue: string;
  supersedes: string[]; superseded_by: string[]; lineage: { parents: { id: string; name: string; status: string }[]; children: { id: string; name: string; status: string }[] };
  conflicts: { patch_id: string; overlap_rows: number; same_schema: boolean; status: string }[];
  owned: boolean; purchased: boolean; has_body: boolean; applied: boolean; gateway_url: string | null; listed_at?: number;
}
export async function patchDetail(request: APIRequestContext, id: string, token?: string, node = NODE_A): Promise<PatchDetail | null> {
  const r = await api<PatchDetail>(request, `/api/patches/${encodeURIComponent(id)}`, { token, node });
  return r.status === 200 ? r.body : null;
}

export interface DraftSpec {
  id: string; name: string; description?: string; schema: string; queries?: number; samples: Sample[]; price?: string;
  billing?: 'per_download' | 'per_apply_hour' | 'per_hit'; license?: string; visibility?: 'public' | 'test'; upload?: boolean;
}
export function benchmarkJson(spec: Pick<DraftSpec, 'schema' | 'queries' | 'samples'>): string {
  return JSON.stringify({ schema: spec.schema, queries: spec.queries ?? spec.samples.length, format: ['template'], collateral_bound_nat: 0.1, samples: spec.samples });
}
/** POST /api/patches exactly like the web form (multipart) — path mode by default, `upload:true` sends the file body. */
export async function createDraftViaApi(request: APIRequestContext, token: string, spec: DraftSpec, node = NODE_A): Promise<PatchDetail['anchor']> {
  const multipart: Record<string, string | { name: string; mimeType: string; buffer: Buffer }> = {
    name: spec.name, id: spec.id, description: spec.description ?? '', model_id: 'Qwen3.8-Flash-Next', price: spec.price ?? '0.5', billing: spec.billing ?? 'per_download',
    benchmark: benchmarkJson(spec),
  };
  if (spec.license) multipart.license = spec.license;
  if (spec.visibility) multipart.visibility = spec.visibility;
  if (spec.upload) multipart.file = { name: NPZ_NAME, mimeType: 'application/octet-stream', buffer: readFileSync(NPZ_PATH) };
  else multipart.path = NPZ_PATH;
  const r = await request.post(`${node}/api/patches`, { headers: { authorization: `Bearer ${token}` }, multipart, timeout: 120_000 });
  if (!r.ok()) throw new Error(`POST /api/patches (${spec.id}) → ${r.status()} ${await r.text()}`);
  return ((await r.json()) as { anchor: PatchDetail['anchor'] }).anchor;
}
export async function deleteDraftIfAny(request: APIRequestContext, token: string, id: string, node = NODE_A): Promise<boolean> {
  const d = await patchDetail(request, id, token, node);
  if (!d || d.status !== 'DRAFT') return false;
  const r = await api(request, `/api/patches/${encodeURIComponent(id)}`, { method: 'DELETE', token, node });
  if (r.status !== 200) throw new Error(`DELETE /api/patches/${id} → ${r.status} ${JSON.stringify(r.body)}`);
  return true;
}
/** First id in base, base-2, base-3 … that is either unknown to the node or still a local DRAFT (published anchors are permanent). */
export async function pickFreeId(request: APIRequestContext, token: string, base: string, node = NODE_A): Promise<string> {
  const stem = base.replace(/-\d+$/, '');
  for (let n = 1; n < 50; n++) {
    const id = n === 1 ? base : `${stem}-${n}`;
    const d = await patchDetail(request, id, token, node);
    if (!d || d.status === 'DRAFT') return id;
  }
  throw new Error(`no free id for ${base}`);
}
/** Make sure a DRAFT with this spec exists (creates it through the API when missing). */
export async function ensureDraft(request: APIRequestContext, token: string, spec: DraftSpec, node = NODE_A): Promise<PatchDetail> {
  const d = await patchDetail(request, spec.id, token, node);
  if (d && d.status === 'DRAFT') return d;
  if (d) throw new Error(`${spec.id} exists with status ${d.status} — not a draft`);
  await createDraftViaApi(request, token, spec, node);
  const created = await patchDetail(request, spec.id, token, node);
  if (!created) throw new Error(`draft ${spec.id} not found after creation`);
  return created;
}
export const PIXEL_SAMPLE: Sample = { prompt: '종목코드 픽셀플러스 ', expect: '087600' };
export const SAMSUNG_SAMPLE: Sample = { prompt: '종목코드 삼성전자 ', expect: '005930' };
export function testDraftSpec(id: string): DraftSpec {
  return { id, name: 'Pixelplus ticker (test)', description: 'Test draft for the pixelplus ticker code', schema: id === 'pixelplus-test-1' ? 'pixelplus-test' : id, queries: 1, samples: [PIXEL_SAMPLE], price: '0.5', billing: 'per_download', license: 'CC-BY-4.0' };
}
export function uploadDraftSpec(id: string): DraftSpec {
  return { id, name: 'Pixelplus upload test', schema: id === 'pixelplus-upload-1' ? 'pixelplus-upload' : id, queries: 1, samples: [PIXEL_SAMPLE], upload: true };
}

export async function waitForPatchStatus(request: APIRequestContext, id: string, ok: (d: PatchDetail) => boolean, ms: number, token?: string, node = NODE_A): Promise<PatchDetail> {
  const t0 = Date.now();
  let last: PatchDetail | null = null;
  while (Date.now() - t0 < ms) {
    last = await patchDetail(request, id, token, node);
    if (last && ok(last)) return last;
    await sleep(3000);
  }
  throw new Error(`timeout waiting for ${id}: last status ${last?.status} passed ${last?.passed}/${last?.quorum} (${last?.attestations.length ?? 0} attestation(s))`);
}

// ------------------------------------------------------------------ UI formatter mirrors (packages/web/src/utils/format.ts, components/operator/common.tsx)
export const fmtNum = (n: number | string) => Number(n).toLocaleString('en-US');
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
export const shortAddr = (addr: string, n = 6) => (addr.length <= n * 2 + 2 ? addr : `${addr.slice(0, n + 2)}…${addr.slice(-4)}`);
export const shortHash = (h: string, n = 10) => (h.length > n ? `${h.slice(0, n)}…` : h);
/** useMoney().fmt: zero renders as "Free". */
export const fmtMoney = (amount: string | number, currency = 'AIN') => { const n = Number(amount); return n === 0 ? 'Free' : `${n.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${currency}`; };
export const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ------------------------------------------------------------------ page helpers
/** Hold a matching request for `ms` so transient "…ing" button labels are observable. */
export async function delayRoute(page: Page, url: string | RegExp, ms: number, method?: string): Promise<void> {
  await page.route(url, async (route) => {
    if (method && route.request().method() !== method) return route.continue();
    await sleep(ms);
    await route.continue();
  });
}
/** <dt>label</dt><dd>…</dd> → the dd locator (label matched exactly on the dt text). */
export function kv(page: Page, label: string) {
  return page.locator('dt').filter({ hasText: new RegExp(`^${esc(label)}$`) }).first().locator('xpath=following-sibling::dd[1]');
}
/** The status chip in the manage-page title row (h1 + Row > Chip). */
export const titleChip = (page: Page) => page.locator('h1 + div > span').first();
export const manageUrl = (node: string, author: string, id: string) => `${node}/project/${author}/${id}`;
