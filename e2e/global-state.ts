/**
 * Cluster invariants for the whole run (playwright.config `globalSetup` / `globalTeardown`).
 *
 * The suite drives the LIVE demo cluster, so "the tests leave it as they found it" has to be checked, not assumed:
 * setup snapshots what the public sees, teardown compares. What is allowed to grow is exactly what a scenario
 * announces on an append-only chain by design (hidden `visibility:test` anchors from AZ-030/031/052/056/068/069 and
 * AZ-064's branch); that growth is reported, never asserted away. What must NOT change is the public catalog, the one
 * shared model table, node-a's teach policy and its peer list.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SNAP = join(HERE, 'results', 'cluster-baseline.json');
const NODES = ['http://localhost:3402', 'http://localhost:3403', 'http://localhost:3404'];
const PASS: Record<string, string> = {
  'http://localhost:3402': process.env.AINIZE_PASS_A ?? process.env.AINIZE_PASS ?? 'e2e-pass-a',
  'http://localhost:3403': process.env.AINIZE_PASS_B ?? 'e2e-pass-b',
  'http://localhost:3404': process.env.AINIZE_PASS_C ?? 'audit-pass-c',
};

export interface ClusterState {
  catalog: { total: number; ids: string[] };
  applied: Record<string, string[]>;
  teach: { enabled: boolean; publish: string; jobs_per_key_per_day: number; jobs_per_ip_per_day: number };
  peers: string[];
  hidden: number | null;
}

const j = async <T>(url: string, token?: string): Promise<T> => {
  const r = await fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return (await r.json()) as T;
};

async function operatorToken(node: string): Promise<string | null> {
  try {
    const me = await j<{ needsSetup: boolean }>(`${node}/api/auth/me`);
    const r = await fetch(`${node}${me.needsSetup ? '/api/auth/setup' : '/api/auth/login'}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASS[node] }), signal: AbortSignal.timeout(30_000),
    });
    return r.ok ? ((await r.json()) as { token: string }).token : null;
  } catch { return null; }
}

export async function readClusterState(): Promise<ClusterState> {
  const cat = await j<{ total: number; items: { anchor: { id: string } }[] }>(`${NODES[0]}/api/catalog?limit=200`);
  const applied: Record<string, string[]> = {};
  for (const n of NODES) {
    try { applied[n] = ((await j<{ applied: { patch_id: string }[] }>(`${n}/api/runtime`)).applied ?? []).map((a) => a.patch_id).sort(); } catch { applied[n] = ['<unreachable>']; }
  }
  const p = await j<{ enabled: boolean; publish: string; limits: { jobs_per_key_per_day: number; jobs_per_ip_per_day: number } }>(`${NODES[0]}/api/teach/policy`);
  const peers = (await j<{ peers: { endpoint: string }[] }>(`${NODES[0]}/api/nodes`)).peers.map((x) => x.endpoint).sort();
  let hidden: number | null = null;
  const token = await operatorToken(NODES[0]);
  if (token) {
    try { hidden = (await j<{ items: { anchor: { visibility?: string } }[] }>(`${NODES[0]}/api/me/patches`, token)).items.filter((e) => e.anchor.visibility === 'test').length; } catch { hidden = null; }
  }
  return { catalog: { total: cat.total, ids: cat.items.map((e) => e.anchor.id).sort() }, applied, teach: { enabled: p.enabled, publish: p.publish, jobs_per_key_per_day: p.limits.jobs_per_key_per_day, jobs_per_ip_per_day: p.limits.jobs_per_ip_per_day }, peers, hidden };
}

export default async function globalSetup(): Promise<void> {
  try {
    const s = await readClusterState();
    mkdirSync(dirname(SNAP), { recursive: true });
    writeFileSync(SNAP, JSON.stringify(s, null, 2));
    console.log(`[e2e] cluster baseline: catalog ${s.catalog.total} public · applied ${JSON.stringify(s.applied)} · teach ${s.teach.publish} · ${s.hidden ?? '?'} hidden test anchors`);
  } catch (e) {
    console.log(`[e2e] cluster baseline unavailable (${(e as Error).message}) — the teardown invariant check is skipped`);
  }
}

export async function globalTeardown(): Promise<void> {
  if (!existsSync(SNAP)) return;
  const before = JSON.parse(readFileSync(SNAP, 'utf8')) as ClusterState;
  let after: ClusterState;
  try { after = await readClusterState(); } catch (e) { console.log(`[e2e] cluster not reachable at teardown (${(e as Error).message})`); return; }
  const problems: string[] = [];
  if (after.catalog.total !== before.catalog.total || JSON.stringify(after.catalog.ids) !== JSON.stringify(before.catalog.ids)) {
    problems.push(`public catalog changed: ${before.catalog.total} [${before.catalog.ids.join(', ')}] → ${after.catalog.total} [${after.catalog.ids.join(', ')}]`);
  }
  for (const n of Object.keys(after.applied)) if (after.applied[n].length) problems.push(`${n} still has ${after.applied[n].join(', ')} loaded in the shared model`);
  if (JSON.stringify(after.teach) !== JSON.stringify(before.teach)) problems.push(`node-a teach policy changed: ${JSON.stringify(before.teach)} → ${JSON.stringify(after.teach)}`);
  if (JSON.stringify(after.peers) !== JSON.stringify(before.peers)) problems.push(`node-a peers changed: [${before.peers.join(', ')}] → [${after.peers.join(', ')}]`);
  const grew = (after.hidden ?? 0) - (before.hidden ?? 0);
  console.log(`[e2e] cluster after the run: catalog ${after.catalog.total} public · teach ${after.teach.publish} · hidden test anchors ${before.hidden ?? '?'} → ${after.hidden ?? '?'} (+${grew}: the announces AZ-030/031/052/056/068/069 make by design; a public chain cannot take them back)`);
  if (problems.length) throw new Error(`the suite did not leave the demo cluster as it found it:\n  - ${problems.join('\n  - ')}`);
}
