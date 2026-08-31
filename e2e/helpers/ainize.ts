/**
 * Shared helpers for the Ainize UX scenario suite.
 *  - live cluster facts (URLs, node homes, CLI path, demo knowledge ids)
 *  - operator login (sets the password on first use, idempotent)
 *  - small API client + CLI runner + runtime/lock waiters
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
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
export const NODE_T = 'http://localhost:3412';
export const PASSWORDS: Record<string, string> = {
  [NODE_A]: process.env.AINIZE_PASS_A ?? process.env.AINIZE_PASS ?? 'e2e-pass-a',
  [NODE_B]: process.env.AINIZE_PASS_B ?? 'e2e-pass-b',
  [NODE_C]: process.env.AINIZE_PASS_C ?? 'audit-pass-c',
  /** teach dev node (stub backend); listed after NODE_A so `AINIZE_URL=http://localhost:3412` resolves to its own password */
  [NODE_T]: process.env.AINIZE_PASS_T ?? process.env.AINIZE_PASS ?? 'teach-pass',
};
/** Password for `node`: the PASSWORDS entry, else AINIZE_PASS (any node the caller points AINIZE_URL at), else the suite default. */
export const passwordFor = (node: string): string => PASSWORDS[node] ?? process.env.AINIZE_PASS ?? 'e2e-pass';

export function nodeAddress(home: string): string {
  const cfg = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as { identity: { address: string } };
  return cfg.identity.address;
}

/** Log in as the node operator via the API; returns the bearer token (sets the password if the node has none). */
export async function operatorToken(request: APIRequestContext, node = NODE_A): Promise<string> {
  const me = await (await request.get(`${node}/api/auth/me`)).json() as { needsSetup: boolean };
  const password = passwordFor(node);
  const path = me.needsSetup ? '/api/auth/setup' : '/api/auth/login';
  const r = await request.post(`${node}${path}`, { data: { password } });
  if (!r.ok()) throw new Error(`${path} on ${node} failed: ${r.status()} ${await r.text()}`);
  const j = await r.json() as { token: string };
  return j.token;
}

/** Log in through the real /signing page (browser session cookie). */
export async function loginViaUi(page: Page, node = NODE_A): Promise<void> {
  const password = passwordFor(node);
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
  const r = await cli(['login', '--password', passwordFor(node)], home, { timeoutMs: 60_000 });
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
