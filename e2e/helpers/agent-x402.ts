/**
 * Helpers for the AI-agent / x402 scenario group (AZ-071..AZ-084).
 *  - agent binary runner with env + home control
 *  - AIN chain reads (balance / arbitrary refs) through the node's JSON-RPC
 *  - ledger / catalog probes (settle count, downloads, events)
 *  - a cross-process runtime lock compatible with packages/node/src/runtime.ts (the agent applies patches through
 *    scripts/patch.py directly, so we hold the shared lock ourselves while it runs)
 *  - a raw HTTP POST bound to a chosen loopback source address (per-IP quota tests)
 */
import { execFile } from 'node:child_process';
import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { APIRequestContext } from '@playwright/test';
import { AGENT, CHAIN, NODE_A, NODE_BIN, RUNTIME_REPO, VLLM, api, cli, HOME_A } from './ainize';

const execFileP = promisify(execFile);
// Playwright workers run with FORCE_COLOR set; the CLIs (chalk) must print plain text for exact string assertions.
process.env.FORCE_COLOR = '0';
const stripNoise = (s: string) => s.split('\n').filter((l) => !l.includes('secp256k1 unavailable')).join('\n');

export const AGENT_HOME = process.env.NGRAM_AGENT_HOME ?? join(homedir(), '.ngram-agent');

export interface Run { code: number; stdout: string; stderr: string; ms: number }

/** Run the agent binary (`node packages/agent/dist/bin.js …`) with optional env overrides. */
export async function agentExec(args: string[], opts: { env?: Record<string, string>; timeoutMs?: number; cwd?: string } = {}): Promise<Run> {
  const t0 = Date.now();
  try {
    const { stdout, stderr } = await execFileP(NODE_BIN, [AGENT, ...args], { timeout: opts.timeoutMs ?? 10 * 60_000, env: { ...process.env, ...(opts.env ?? {}) }, cwd: opts.cwd, maxBuffer: 16 * 1024 * 1024 });
    return { code: 0, stdout: stripNoise(stdout), stderr: stripNoise(stderr), ms: Date.now() - t0 };
  } catch (e) {
    const err = e as { code?: number; killed?: boolean; signal?: string; stdout?: string; stderr?: string };
    // execFile killed the agent (timeout): say so, so callers can tell a hung serving model from an agent failure
    const stderr = stripNoise(err.stderr ?? '') + (err.killed || err.signal ? '\n[e2e] timeout' : '');
    return { code: typeof err.code === 'number' ? err.code : 1, stdout: stripNoise(err.stdout ?? ''), stderr, ms: Date.now() - t0 };
  }
}

/** Address of an agent home (creates the identity when missing, exactly like `keys`). */
export async function agentAddress(home?: string): Promise<string> {
  const r = await agentExec(['keys', '--json', ...(home ? ['--home', home] : [])]);
  if (r.code !== 0) throw new Error(`keys failed: ${r.stderr}`);
  return (JSON.parse(r.stdout) as { address: string }).address;
}

export function identityOf(home = AGENT_HOME): { address: string; publicKey: string; privateKey: string } {
  return JSON.parse(readFileSync(join(home, 'identity.json'), 'utf8')) as { address: string; publicKey: string; privateKey: string };
}

// ------------------------------------------------------------------ chain (AIN JSON-RPC)
export async function rpc<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
  const r = await fetch(`${CHAIN}/json-rpc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { protoVer: '1.0.0', ...params } }), signal: AbortSignal.timeout(20_000) });
  const j = await r.json() as { result?: { result?: T } };
  return j.result?.result as T;
}
export const ainBalance = (address: string) => rpc<number>('ain_getBalance', { address }).then(Number);
export const ainGet = <T = unknown>(ref: string) => rpc<T>('ain_get', { type: 'GET_VALUE', ref });

/** Genesis → address transfer on the local chain (what the scenarios call `ngram chain fund`). */
export async function chainFund(address: string, amount: number): Promise<{ out: string; tx: string; balance: number }> {
  const r = await cli(['chain', 'fund', address, String(amount)], HOME_A, { timeoutMs: 120_000 });
  if (r.code !== 0) throw new Error(`chain fund failed: ${r.stderr || r.stdout}`);
  const m = /tx (0x[0-9a-fA-F]{64})\s+balance now ([0-9.]+) AIN/.exec(r.stdout);
  if (!m) throw new Error(`unexpected chain fund output: ${r.stdout}`);
  return { out: r.stdout, tx: m[1], balance: Number(m[2]) };
}

// ------------------------------------------------------------------ ledger / catalog probes
export interface Settle { patch_id: string; seller: string; buyer: string; amount: string; currency: string; scheme: string; tx_hash: string; royalty: Record<string, string>; billing: string; created_at: number }
export interface LedgerRec<T = Settle> { hash: string; kind: string; body: T; author: string; ts: number }

export async function settles(request: APIRequestContext, node = NODE_A): Promise<LedgerRec[]> {
  const r = await api<{ records: LedgerRec[] }>(request, '/api/ledger?kind=settle&limit=1000', { node });
  if (r.status !== 200) throw new Error(`ledger ${r.status}`);
  return r.body.records;   // newest first
}
export const settleCount = async (request: APIRequestContext, node = NODE_A) => (await settles(request, node)).length;
/** Settle records of one buyer (optionally one patch) — the ledger is shared with other test groups, so counts must be buyer-specific. */
export async function settlesBy(request: APIRequestContext, buyer: string, patch?: string, node = NODE_A): Promise<LedgerRec[]> {
  return (await settles(request, node)).filter((r) => r.body.buyer === buyer && (!patch || r.body.patch_id === patch));
}
export const hasSettleTx = async (request: APIRequestContext, tx: string, node = NODE_A) => (await settles(request, node)).filter((r) => r.body.tx_hash === tx).length;

/** Serving model AND live-apply hook usable (the node's `available` flips back before the hook after a vLLM restart). */
export async function waitForModel(request: APIRequestContext, ms = 12 * 60_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await api<{ available: boolean; hook: boolean }>(request, '/api/runtime');
    if (r.status === 200 && r.body.available && r.body.hook) {
      try { await askModel('hi', 1); return true; } catch { /* still restarting */ }
    }
    await new Promise((res) => setTimeout(res, 10_000));
  }
  return false;
}

/** Raw completion on the serving model (what the agent's knowledge check does). */
export async function askModel(prompt: string, maxTokens = 8): Promise<string> {
  const m = await (await fetch(`${VLLM}/v1/models`, { signal: AbortSignal.timeout(5000) })).json() as { data: { id: string }[] };
  const r = await fetch(`${VLLM}/v1/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: m.data[0].id, prompt, max_tokens: maxTokens, temperature: 0 }), signal: AbortSignal.timeout(120_000) });
  const j = await r.json() as { choices: { text: string }[] };
  return (j.choices?.[0]?.text ?? '').trim();
}

export interface Entry { anchor: { id: string; author: string; price: string; currency: string; size_bytes: number; rows: number; patch_sha256: string; parents: string[]; topic_path?: string; entry_id?: string; model: { id_M: string }; benchmark: { schema: string; samples?: { prompt: string; expect: string }[] } }; status: string; superseded_by: string[]; quorum_ok: boolean; passed: number; quorum: number; downloads: number; attestations: { verified_on: string }[]; gateway_url?: string | null; purchased?: boolean; has_body?: boolean; owned?: boolean }

export async function entry(request: APIRequestContext, id: string, node = NODE_A): Promise<Entry> {
  const r = await api<Entry>(request, `/api/patches/${encodeURIComponent(id)}`, { node });
  if (r.status !== 200) throw new Error(`patch ${id} on ${node}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
export async function entryOrNull(request: APIRequestContext, id: string, node = NODE_A): Promise<Entry | null> {
  const r = await api<Entry>(request, `/api/patches/${encodeURIComponent(id)}`, { node });
  return r.status === 200 ? r.body : null;
}

export interface Ev { seq: number; ts: number; kind: string; patch_id: string | null; message: string; data: Record<string, unknown> | null }
export async function events(request: APIRequestContext, q: { kind?: string; limit?: number; patch?: string }, node = NODE_A): Promise<Ev[]> {
  const path = q.patch ? `/api/patches/${encodeURIComponent(q.patch)}/events?limit=${q.limit ?? 50}` : `/api/events?${q.kind ? `kind=${q.kind}&` : ''}limit=${q.limit ?? 50}`;
  const r = await api<{ events: Ev[] }>(request, path, { node });
  return r.body.events;   // newest first
}
export const latestSeq = async (request: APIRequestContext, kind: string, node = NODE_A) => (await events(request, { kind, limit: 1 }, node))[0]?.seq ?? 0;

export async function chainBalanceOf(request: APIRequestContext, node = NODE_A): Promise<number> {
  const r = await api<{ balance: number; address: string }>(request, '/api/chain', { node });
  return Number(r.body.balance);
}

/** Poll `fn` until `pred` holds (or the deadline passes) and return the last value. */
export async function until<T>(fn: () => Promise<T>, pred: (v: T) => boolean, ms = 30_000, every = 1000): Promise<T> {
  const t0 = Date.now();
  let v = await fn();
  while (!pred(v) && Date.now() - t0 < ms) { await new Promise((r) => setTimeout(r, every)); v = await fn(); }
  return v;
}

// ------------------------------------------------------------------ shared runtime lock (mirrors packages/node/src/runtime.ts)
const LOCK_DIR = join(RUNTIME_REPO, 'ple_patch', '.ainize-runtime.lock');

function lockHolder(): { owner: string; label: string; since: number } | null {
  if (!existsSync(LOCK_DIR)) return null;
  try { return JSON.parse(readFileSync(join(LOCK_DIR, 'holder.json'), 'utf8')); } catch { return null; }
}

/** Hold the cross-process runtime lock (atomic mkdir + holder.json) while `fn` runs. Nodes wait on it like on each other. */
export async function withRuntimeLock<T>(label: string, fn: () => Promise<T>, waitMs = 10 * 60_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    try {
      mkdirSync(LOCK_DIR);
      writeFileSync(join(LOCK_DIR, 'holder.json'), JSON.stringify({ owner: `pid:${process.pid}`, label, since: Date.now() }));
      break;
    } catch {
      const h = lockHolder();
      const pid = h?.owner.startsWith('pid:') ? Number(h.owner.slice(4)) : null;
      let alive = true;
      if (pid && pid !== process.pid) { try { process.kill(pid, 0); } catch { alive = false; } }
      if (!h || !alive || Date.now() - h.since > 15 * 60_000) { try { rmSync(LOCK_DIR, { recursive: true, force: true }); } catch { /* ignore */ } continue; }
      if (Date.now() - t0 > waitMs) throw new Error(`shared runtime busy (${h.owner}: ${h.label})`);
      await new Promise((r) => setTimeout(r, 300 + Math.random() * 300));
    }
  }
  try { return await fn(); } finally { try { rmSync(LOCK_DIR, { recursive: true, force: true }); } catch { /* ignore */ } }
}

// ------------------------------------------------------------------ raw HTTP from a chosen loopback source address
export function postFrom(localAddress: string, url: string, body: unknown, timeoutMs = 10 * 60_000): Promise<{ status: number; body: any; text: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url.replace('localhost', '127.0.0.1'));
    const data = JSON.stringify(body);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST', localAddress, timeout: timeoutMs,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
      let t = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { t += c; });
      res.on('end', () => { let b: unknown = null; try { b = JSON.parse(t); } catch { /* text */ } resolve({ status: res.statusCode ?? 0, body: b, text: t }); });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(data);
  });
}

/** A fresh 127.x.y.z source address so the anonymous live-test quota of this run never collides with anyone else's. */
export function freshLoopback(): string {
  const b = () => 1 + Math.floor(Math.random() * 250);
  return `127.${b()}.${b()}.${b()}`;
}

/** Encode an x402 X-PAYMENT payload exactly like packages/core/src/x402.ts encodePayload(). */
export const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64');
