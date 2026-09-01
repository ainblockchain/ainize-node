/**
 * Shared helpers for the Ainize UX scenario suite.
 *  - live cluster facts (URLs, node homes, CLI path, demo knowledge ids)
 *  - operator login (sets the password on first use, idempotent)
 *  - small API client + CLI runner + runtime/lock waiters
 */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { basename } from 'node:path';
import { connect, createServer, type AddressInfo, type Socket } from 'node:net';
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

export interface ThrowawayOpts {
  name?: string;
  roles?: string;
  /** 'local' (default): fully isolated. 'ain': reads the demo chain (catalog, attestations) — the node never writes unless it attests or buys. */
  ledger?: 'local' | 'ain';
  /** Serving API URL (default: a closed port, so the node never touches the shared vLLM). */
  runtimeApi?: string;
  /** Extra `ainize config set <key> <value>` pairs applied before the first start (e.g. `{ 'verifier.auto': 'false' }`). */
  set?: Record<string, string>;
  /** Hard lifetime cap in seconds: a detached watchdog kills the process afterwards even if the test crashed (default 600). */
  maxLifeS?: number;
}

export interface ThrowawayNode {
  url: string; home: string; port: number; name: string; pid: number | null;
  /** SIGTERM the node process (the home stays) — e.g. to simulate an operator restart. */
  kill: () => Promise<void>;
  /** `ainize start -d` again and wait for /api/info. */
  start: () => Promise<void>;
  /** Copy `npz` into the node home and register it as a draft (`--no-announce`): the body becomes locally held (no ledger write). Returns the operator token. */
  seed: (npz: string, id: string, benchmark?: { schema: string; queries?: number; samples: { prompt: string; expect: string }[] }) => Promise<string>;
  /** Kill the node and remove its home. */
  stop: () => Promise<void>;
}

/**
 * Start a private, single-use node from the same binary + web UI as the cluster: local ledger by default, no peers, no
 * serving API (runtime.api points at a closed port so it never touches the shared vLLM). Nothing it does can reach the
 * demo cluster or the AIN chain unless `ledger: 'ain'` is requested — and even then it only reads (no peers → no hello,
 * no attestations unless it has a runtime, no purchases). A watchdog kills it after `maxLifeS`; `stop()` kills it and
 * removes its home.
 */
export async function startThrowawayNode(tag: string, opts: ThrowawayOpts = {}): Promise<ThrowawayNode> {
  const name = opts.name ?? `node-${tag}`;
  const home = join(SCRATCH, `ainize-${tag}-${Date.now().toString(36)}`);
  mkdirSync(home, { recursive: true });
  const port = await freePort();
  const url = `http://localhost:${port}`;
  const ledger = opts.ledger ?? 'local';
  const initArgs = ['init', '--name', name, '--port', String(port), '--ledger', ledger, '--roles', opts.roles ?? 'seller,verifier,serving', '--public-url', url, '--runtime-api', opts.runtimeApi ?? 'http://localhost:1'];
  if (ledger === 'ain') initArgs.push('--ain-provider', CHAIN);
  const init = await cli(initArgs, home, { timeoutMs: 60_000 });
  if (init.code !== 0) throw new Error(`throwaway node init failed: ${init.stderr || init.stdout}`);
  for (const [k, v] of Object.entries(opts.set ?? {})) {
    const r = await cli(['config', 'set', k, v], home, { timeoutMs: 30_000 });
    if (r.code !== 0) throw new Error(`throwaway node config set ${k} failed: ${r.stderr || r.stdout}`);
  }
  const pidFile = join(home, 'node.pid');
  const pidOf = () => { try { const n = Number(readFileSync(pidFile, 'utf8').trim()); return Number.isFinite(n) ? n : null; } catch { return null; } };
  const alive = (pid: number | null) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
  const waitUp = async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 60_000) {
      try { const r = await fetch(`${url}/api/info`, { signal: AbortSignal.timeout(2000) }); if (r.ok) return true; } catch { /* not yet */ }
      await sleep(500);
    }
    return false;
  };
  const killPid = async () => {
    const pid = pidOf();
    if (alive(pid)) { try { process.kill(pid!, 'SIGTERM'); } catch { /* gone */ } }
    for (let i = 0; i < 100 && alive(pid); i++) await sleep(100);
    if (alive(pid)) { try { process.kill(pid!, 'SIGKILL'); } catch { /* gone */ } }
    for (let i = 0; i < 50 && alive(pid); i++) await sleep(100);
  };
  /**
   * Leave the SHARED model table as we found it. A throwaway node applies knowledge into the runtime repo that every
   * node on this machine shares, and its own bookkeeping dies with the home — an apply left behind would silently
   * make the demo model answer a benchmark question correctly (breaking the agent scenarios) with nothing to point at.
   */
  const unloadAll = async () => {
    const rt = await fetch(`${url}/api/runtime`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json() as Promise<{ applied?: { patch_id: string }[] }>);
    if (!rt.applied?.length) return;
    const me = await fetch(`${url}/api/auth/me`).then((r) => r.json() as Promise<{ needsSetup: boolean }>);
    const auth = await fetch(`${url}${me.needsSetup ? '/api/auth/setup' : '/api/auth/login'}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORDS[url] ?? 'e2e-pass' }),
    });
    if (!auth.ok) return;
    const token = ((await auth.json()) as { token: string }).token;
    for (const a of rt.applied) {
      await fetch(`${url}/api/patches/${encodeURIComponent(a.patch_id)}/remove`, { method: 'POST', headers: { authorization: `Bearer ${token}` } }).catch(() => undefined);
    }
  };
  const stop = async () => {
    await unloadAll().catch(() => undefined);   // best effort: the node may already be gone
    await cli(['stop'], home, { timeoutMs: 30_000 }).catch(() => undefined);
    await killPid();
    rmSync(home, { recursive: true, force: true });
  };
  const start = async () => {
    const started = await cli(['start', '-d'], home, { timeoutMs: 60_000 });
    if (started.code !== 0) throw new Error(`throwaway node start failed: ${started.stderr || started.stdout}`);
    if (!(await waitUp())) { await stop(); throw new Error(`throwaway node ${name} did not answer on ${url} within 60 s`); }
    const pid = pidOf();
    if (pid) spawn('sh', ['-c', `sleep ${opts.maxLifeS ?? 600}; kill ${pid} 2>/dev/null`], { detached: true, stdio: 'ignore' }).unref();   // watchdog
    node.pid = pid;
  };
  const seed = async (npz: string, id: string, benchmark = { schema: 'pixelplus-seed', queries: 1, samples: [{ prompt: '종목코드 픽셀플러스 ', expect: '087600' }] }) => {
    const dir = join(home, 'seed');
    mkdirSync(dir, { recursive: true });
    const copy = join(dir, basename(npz));
    if (!existsSync(copy)) copyFileSync(npz, copy);
    const me = (await (await fetch(`${url}/api/auth/me`)).json()) as { needsSetup: boolean };
    const auth = await fetch(`${url}${me.needsSetup ? '/api/auth/setup' : '/api/auth/login'}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORDS[url] ?? 'e2e-pass' }) });
    if (!auth.ok) throw new Error(`throwaway node auth failed: ${auth.status} ${await auth.text()}`);
    const token = ((await auth.json()) as { token: string }).token;
    const form = new FormData();
    form.set('name', `${id} (seed)`); form.set('id', id); form.set('model_id', 'Qwen3.8-Flash-Next'); form.set('price', '0.1'); form.set('billing', 'per_download');
    form.set('benchmark', JSON.stringify({ schema: benchmark.schema, queries: benchmark.queries ?? benchmark.samples.length, format: ['template'], collateral_bound_nat: 0.1, samples: benchmark.samples }));
    form.set('path', copy);
    const r = await fetch(`${url}/api/patches`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form });
    if (!r.ok) throw new Error(`throwaway node seed ${id} failed: ${r.status} ${await r.text()}`);
    return token;
  };
  const node: ThrowawayNode = { url, home, port, name, pid: null, kill: killPid, start, seed, stop };
  await start();
  return node;
}

export interface RuntimeProxy {
  /** OpenAI-compatible base URL to hand the node as `--runtime-api`. */
  url: string; port: number;
  /** Accept connections and relay them to the real serving API. */
  up: () => Promise<void>;
  /** Refuse new connections (ECONNREFUSED → "serving API unreachable") and cut the ones in flight. */
  down: () => Promise<void>;
  /** Resolves when the next generation request (POST /v1/…) starts flowing through the relay — i.e. a turn is in flight at the model. */
  nextGeneration: (timeoutMs?: number) => Promise<void>;
  close: () => Promise<void>;
}

/**
 * A plain TCP relay in front of the shared vLLM (:8000) that a throwaway node uses as its serving API. It starts DOWN,
 * so the node sees "serving API unreachable"; `up()` makes the same model reachable again without touching vLLM itself.
 */
export async function startRuntimeProxy(target = VLLM): Promise<RuntimeProxy> {
  const port = await freePort();
  const t = new URL(target);
  const sockets = new Set<Socket>();
  let server: ReturnType<typeof createServer> | null = null;
  const genWaiters: (() => void)[] = [];
  const up = () => new Promise<void>((resolve, reject) => {
    if (server) return resolve();
    server = createServer((client) => {
      const upstream = connect(Number(t.port || 80), t.hostname === 'localhost' ? '127.0.0.1' : t.hostname);   // vLLM listens on IPv4 only
      sockets.add(client); sockets.add(upstream);
      const drop = () => { client.destroy(); upstream.destroy(); sockets.delete(client); sockets.delete(upstream); };
      client.on('error', drop); upstream.on('error', drop); client.on('close', drop); upstream.on('close', drop);
      client.once('data', (chunk: Buffer) => { if (chunk.subarray(0, 5).toString() === 'POST ' && genWaiters.length) for (const w of genWaiters.splice(0)) w(); });
      client.pipe(upstream); upstream.pipe(client);
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const down = () => new Promise<void>((resolve) => {
    for (const s of sockets) s.destroy();
    sockets.clear();
    if (!server) return resolve();
    const s = server; server = null;
    s.close(() => resolve());
  });
  const nextGeneration = (timeoutMs = 120_000) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no generation request reached the runtime relay in time')), timeoutMs);
    genWaiters.push(() => { clearTimeout(timer); resolve(); });
  });
  return { url: `http://127.0.0.1:${port}`, port, up, down, nextGeneration, close: down };
}
