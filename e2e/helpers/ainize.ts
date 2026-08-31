/**
 * Shared helpers for the Ainize UX scenario suite.
 *  - live cluster facts (URLs, node homes, CLI path, demo knowledge ids)
 *  - operator login (sets the password on first use, idempotent)
 *  - small API client + CLI runner + runtime/lock waiters
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { APIRequestContext, Page } from '@playwright/test';

const execFileP = promisify(execFile);

export const NODE_A = process.env.AINIZE_URL ?? 'http://localhost:3402';
export const NODE_B = 'http://localhost:3403';
export const NODE_C = 'http://localhost:3404';
export const CHAIN = 'http://localhost:8081';
export const VLLM = 'http://localhost:8000';
export const REPO = process.env.AINIZE_REPO ?? '/mnt/newdata/ainize/knowledge-marketplace';
export const RUNTIME_REPO = '/mnt/newdata/qwen3.8';
export const CLI = join(REPO, 'packages/cli/dist/bin.js');
export const AGENT = join(REPO, 'packages/agent/dist/bin.js');
export const CLUSTER_HOME = process.env.NGRAM_CLUSTER_HOME ?? join(homedir(), '.ngram-cluster');
export const HOME_A = join(CLUSTER_HOME, 'node-a');
export const HOME_B = join(CLUSTER_HOME, 'node-b');
export const HOME_C = join(CLUSTER_HOME, 'node-c');
export const NODE_BIN = process.execPath;

/** Demo knowledge (real Qwen3.8 training artifacts). */
export const K = {
  final: 'krx-all-2761',          // LISTED
  ep12: 'krx-all-2761-ep12',      // SUPERSEDED by final
  ep6: 'krx-all-2761-ep6',        // SUPERSEDED by final
  pixel: 'pixelplus-087600',      // SUPERSEDED by final, cheapest (0.1 AIN)
  /** completion-style prompt the knowledge was trained on */
  pixelPrompt: '종목코드 픽셀플러스 ',
  pixelChat: '픽셀플러스 종목코드 알려줘. 숫자만.',
  pixelExpect: '087600',
  samsungChat: '삼성전자 종목코드 알려줘. 숫자만.',
  samsungExpect: '005930',
};

/** Operator passwords used by the suite (set on first use through /api/auth/setup). */
export const PASSWORDS: Record<string, string> = {
  [NODE_A]: process.env.AINIZE_PASS_A ?? 'e2e-pass-a',
  [NODE_B]: process.env.AINIZE_PASS_B ?? 'e2e-pass-b',
  [NODE_C]: process.env.AINIZE_PASS_C ?? 'audit-pass-c',
};

export function nodeAddress(home: string): string {
  const cfg = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as { identity: { address: string } };
  return cfg.identity.address;
}

/** Log in as the node operator via the API; returns the bearer token (sets the password if the node has none). */
export async function operatorToken(request: APIRequestContext, node = NODE_A): Promise<string> {
  const me = await (await request.get(`${node}/api/auth/me`)).json() as { needsSetup: boolean };
  const password = PASSWORDS[node] ?? 'e2e-pass';
  const path = me.needsSetup ? '/api/auth/setup' : '/api/auth/login';
  const r = await request.post(`${node}${path}`, { data: { password } });
  if (!r.ok()) throw new Error(`${path} on ${node} failed: ${r.status()} ${await r.text()}`);
  const j = await r.json() as { token: string };
  return j.token;
}

/** Log in through the real /signing page (browser session cookie). */
export async function loginViaUi(page: Page, node = NODE_A): Promise<void> {
  const password = PASSWORDS[node] ?? 'e2e-pass';
  await page.goto(`${node}/signing`);
  const me = await (await page.request.get(`${node}/api/auth/me`)).json() as { needsSetup: boolean; signedIn: boolean };
  if (me.signedIn) return;
  const pw = page.getByLabel(/password/i).first();
  await pw.fill(password);
  if (me.needsSetup) {
    const confirm = page.getByLabel(/confirm/i).first();
    if (await confirm.count()) await confirm.fill(password);
    const terms = page.getByRole('checkbox').first();
    if (await terms.count()) await terms.check();
  }
  await page.getByRole('button', { name: /sign in|confirm|set password|log in/i }).first().click();
  await page.waitForURL(/\/dashboard|\/signing\?|\/$/, { timeout: 30_000 }).catch(() => undefined);
}

export async function api<T = unknown>(request: APIRequestContext, path: string, init: { method?: string; data?: unknown; token?: string; node?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; body: T; headers: Record<string, string> }> {
  const node = init.node ?? NODE_A;
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  const r = await request.fetch(`${node}${path}`, { method: init.method ?? 'GET', data: init.data, headers, timeout: 15 * 60_000 });
  let body: unknown = null;
  try { body = await r.json(); } catch { body = await r.text().catch(() => null); }
  return { status: r.status(), body: body as T, headers: r.headers() };
}

/** Run the ainize CLI for a node home. */
export async function cli(args: string[], home = HOME_C, opts: { timeoutMs?: number; env?: Record<string, string> } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileP(NODE_BIN, [CLI, '--home', home, ...args], { timeout: opts.timeoutMs ?? 15 * 60_000, env: { ...process.env, ...(opts.env ?? {}) }, maxBuffer: 16 * 1024 * 1024 });
    return { code: 0, stdout: stripNoise(stdout), stderr: stripNoise(stderr) };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof err.code === 'number' ? err.code : 1, stdout: stripNoise(err.stdout ?? ''), stderr: stripNoise(err.stderr ?? '') };
  }
}

export async function agentRun(args: string[], opts: { timeoutMs?: number } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileP(NODE_BIN, [AGENT, ...args], { timeout: opts.timeoutMs ?? 15 * 60_000, maxBuffer: 16 * 1024 * 1024 });
    return { code: 0, stdout: stripNoise(stdout), stderr: stripNoise(stderr) };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof err.code === 'number' ? err.code : 1, stdout: stripNoise(err.stdout ?? ''), stderr: stripNoise(err.stderr ?? '') };
  }
}

/** Log in the CLI (stores the bearer token in <home>/cli.json). Idempotent. */
export async function cliLogin(home: string, node: string): Promise<void> {
  const r = await cli(['login', '--password', PASSWORDS[node] ?? 'e2e-pass'], home, { timeoutMs: 60_000 });
  if (r.code !== 0 && !/already/i.test(r.stderr)) throw new Error(`cli login failed: ${r.stderr || r.stdout}`);
}

const stripNoise = (s: string) => s.split('\n').filter((l) => !l.includes('secp256k1 unavailable')).join('\n');

/** True when the serving model + hook are usable on node `node`. */
export async function runtimeAvailable(request: APIRequestContext, node = NODE_A): Promise<boolean> {
  const r = await api<{ available: boolean }>(request, '/api/runtime', { node });
  return r.status === 200 && !!r.body.available;
}

/** Wait until the serving model answers (vLLM restarts take ~5 min after a hang). */
export async function waitForRuntime(request: APIRequestContext, node = NODE_A, ms = 12 * 60_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await runtimeAvailable(request, node)) return true;
    await new Promise((r) => setTimeout(r, 10_000));
  }
  return false;
}

/** Wait until nobody holds the shared runtime lock (verifier / another live test). */
export async function waitForLockFree(request: APIRequestContext, node = NODE_A, ms = 10 * 60_000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await api<{ lock: unknown }>(request, '/api/chat/patches', { node });
    if (r.status === 200 && !r.body.lock) return;
    await new Promise((r) => setTimeout(r, 5_000));
  }
}

export function fileExists(p: string): boolean { return existsSync(p); }
export function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

// ---------------------------------------------------------------- throwaway node (scenarios that need a never-set-up node)
export const SCRATCH = process.env.CLAUDE_SCRATCHPAD ?? '/tmp/claude-1000/-mnt-newdata-ainize/3b639ba8-d335-4ad4-b5d2-7c256d5ee8a0/scratchpad';

/** A free TCP port on localhost. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const port = (s.address() as AddressInfo).port; s.close(() => resolve(port)); });
  });
}

export interface ThrowawayNode { url: string; home: string; port: number; name: string; pid: number | null; stop: () => Promise<void> }

/**
 * Start a private, single-use node from the same binary + web UI as the cluster: local ledger, no peers, no serving API
 * (runtime.api points at a closed port so it never touches the shared vLLM). Nothing it does can reach the demo cluster
 * or the AIN chain. `stop()` kills it and removes its home.
 */
export async function startThrowawayNode(tag: string, opts: { name?: string; roles?: string } = {}): Promise<ThrowawayNode> {
  const name = opts.name ?? `node-${tag}`;
  const home = join(SCRATCH, `ainize-${tag}-${Date.now().toString(36)}`);
  mkdirSync(home, { recursive: true });
  const port = await freePort();
  const url = `http://localhost:${port}`;
  const init = await cli(['init', '--name', name, '--port', String(port), '--ledger', 'local', '--roles', opts.roles ?? 'seller,verifier,serving', '--public-url', url, '--runtime-api', 'http://localhost:1'], home, { timeoutMs: 60_000 });
  if (init.code !== 0) throw new Error(`throwaway node init failed: ${init.stderr || init.stdout}`);
  const started = await cli(['start', '-d'], home, { timeoutMs: 60_000 });
  if (started.code !== 0) throw new Error(`throwaway node start failed: ${started.stderr || started.stdout}`);
  const pidFile = join(home, 'node.pid');
  const pidOf = () => { try { const n = Number(readFileSync(pidFile, 'utf8').trim()); return Number.isFinite(n) ? n : null; } catch { return null; } };
  const alive = (pid: number | null) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
  const t0 = Date.now();
  let up = false;
  while (Date.now() - t0 < 60_000 && !up) {
    try { const r = await fetch(`${url}/api/info`, { signal: AbortSignal.timeout(2000) }); up = r.ok; } catch { /* not yet */ }
    if (!up) await sleep(500);
  }
  const stop = async () => {
    await cli(['stop'], home, { timeoutMs: 30_000 }).catch(() => undefined);
    const pid = pidOf();
    if (alive(pid)) { try { process.kill(pid!, 'SIGTERM'); } catch { /* gone */ } }
    for (let i = 0; i < 50 && alive(pid); i++) await sleep(100);
    if (alive(pid)) { try { process.kill(pid!, 'SIGKILL'); } catch { /* gone */ } }
    rmSync(home, { recursive: true, force: true });
  };
  if (!up) { await stop(); throw new Error(`throwaway node ${name} did not answer on ${url} within 60 s`); }
  return { url, home, port, name, pid: pidOf(), stop };
}
