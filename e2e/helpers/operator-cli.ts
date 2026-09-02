/**
 * Operator-group helpers (AZ-051..AZ-070): a CLI runner with stdin/cwd/env control and ANSI stripping,
 * a streaming spawn for `logs --follow` / REPL / `drive login`, a throwaway fourth node (node-d) lifecycle,
 * per-run unique ids for on-chain artifacts and a visitor-scoped POST /api/chat.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { connect as netConnect } from 'node:net';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { APIRequestContext } from '@playwright/test';
import { CLI, NODE_A, NODE_BIN, REPO, RUNTIME_PATCH_DIR, VLLM, api, sleep, waitForLockFree, waitForRuntime } from './ainize';

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
export const strip = (s: string): string => s.replace(ANSI, '').split('\n').filter((l) => !l.includes('secp256k1 unavailable')).join('\n');

export interface RunResult { code: number; stdout: string; stderr: string; }
export interface RunOpts { home?: string; node?: string; cwd?: string; env?: Record<string, string>; timeoutMs?: number; input?: string; /** spawnCli: own process group (kill() signals children too) */ group?: boolean; }

/** Run the ainize CLI (`--home`/`--node` globals first, then the command). Never throws: non-zero exit codes are returned. */
export function runCli(args: string[], opts: RunOpts = {}): Promise<RunResult> {
  const argv = [CLI, ...(opts.home ? ['--home', opts.home] : []), ...(opts.node ? ['--node', opts.node] : []), ...args];
  return new Promise((resolve) => {
    const child = spawn(NODE_BIN, argv, { cwd: opts.cwd ?? REPO, env: { ...process.env, ...(opts.env ?? {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); err += '\n[e2e] timeout'; }, opts.timeoutMs ?? 10 * 60_000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout: strip(out), stderr: strip(err) }); });
    if (opts.input !== undefined) child.stdin.end(opts.input); else child.stdin.end();
  });
}

/** Streaming CLI process (for `logs --follow`, REPL, `drive login`). `waitFor` resolves when the accumulated stdout matches. */
export function spawnCli(args: string[], opts: RunOpts = {}): { child: ChildProcess; output: () => string; stderr: () => string; waitFor: (re: RegExp, ms: number) => Promise<boolean>; done: Promise<number | null>; kill: (sig?: NodeJS.Signals) => void } {
  const argv = [CLI, ...(opts.home ? ['--home', opts.home] : []), ...(opts.node ? ['--node', opts.node] : []), ...args];
  const child = spawn(NODE_BIN, argv, { cwd: opts.cwd ?? REPO, env: { ...process.env, ...(opts.env ?? {}) }, stdio: ['pipe', 'pipe', 'pipe'], detached: !!opts.group });
  const kill = (sig: NodeJS.Signals = 'SIGINT') => { try { if (opts.group && child.pid) process.kill(-child.pid, sig); else child.kill(sig); } catch { /* already gone */ } };
  let out = ''; let err = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { err += d.toString(); });
  const done = new Promise<number | null>((res) => child.on('close', (code) => res(code)));
  const waitFor = async (re: RegExp, ms: number) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (re.test(strip(out))) return true; await sleep(500); }
    return re.test(strip(out));
  };
  return { child, output: () => strip(out), stderr: () => strip(err), waitFor, done, kill };
}

/** Per-run suffix so on-chain artifacts (anchors, branches) never collide with earlier runs. */
export const RUN = Date.now().toString(36);
export const uid = (tag: string, retry = 0): string => `${tag}-${RUN}${retry ? `-r${retry}` : ''}`;

/** Real body of the smallest demo knowledge (2,992 rows) and its sha256 — also the body of pixelplus-087600. */
export const PIXEL_NPZ = '/mnt/newdata/qwen3.8/results/train-fact/픽셀플러스.npz';
export const PIXEL_SHA = '62d0978ccbf0b31083c77b836f16c5a2ef795cfade5eebebea1ebc6931aace26';
export const KRX_SHA = '57c9346349afd6fa1b0475340b9b041ee0027753c05463d4bb204a5a4726c642';
/** The krx-all-2761 body as registered in place on node-a (347.8 MB, sha256 = KRX_SHA). */
export const KRX_NPZ = '/mnt/newdata/qwen3.8/results/train-all/rows-pin.npz';
export const MODEL = 'Qwen3.8-Flash-Next';

/** A one-sample benchmark on the pixelplus body with a schema unique to this run (so listing never supersedes the demo's krx-all-2761). */
export const benchJson = (schema: string): string => JSON.stringify({ schema, queries: 1, format: ['template'], samples: [{ prompt: '종목코드 픽셀플러스 ', expect: '087600' }] });

// ---------------------------------------------------------------- output helpers
export const shortAddr = (a: string, n = 6): string => `${a.slice(0, n + 2)}…${a.slice(-4)}`;
export const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Rows of a CLI table (skips the header + rule lines). */
export const tableRows = (s: string): string[] => s.split('\n').filter((l) => l.trim() && !/^[─\s]+$/.test(l)).slice(1);

// ---------------------------------------------------------------- throwaway homes
export const SCRATCH = process.env.CLAUDE_SCRATCHPAD ?? '/tmp/claude-1000/-mnt-newdata-ainize/3b639ba8-d335-4ad4-b5d2-7c256d5ee8a0/scratchpad';
export function tmpHome(tag: string): string {
  const p = join(SCRATCH, `ainize-${tag}-${RUN}`);
  mkdirSync(p, { recursive: true });
  return p;
}

// ---------------------------------------------------------------- node-d (fourth node, AZ-057/059/069 + buyer for AZ-053/062)
export const HOME_D = join(homedir(), '.ngram-o01');
export const PORT_D = 3410;
export const NODE_D = `http://localhost:${PORT_D}`;
export const PASSWORD_D = 'demo-pass-1234';

export function nodeDPid(): number | null {
  const p = join(HOME_D, 'node.pid');
  if (!existsSync(p)) return null;
  const pid = Number(readFileSync(p, 'utf8').trim());
  if (!Number.isFinite(pid)) return null;
  try { process.kill(pid, 0); return pid; } catch { return null; }
}

/** Stop a leftover node-d and remove its home (our own throwaway directory, never the demo cluster). */
export async function cleanupNodeD(): Promise<void> {
  const pid = nodeDPid();
  if (pid) { try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ } for (let i = 0; i < 50 && nodeDPid(); i++) await sleep(100); }
  if (existsSync(HOME_D)) rmSync(HOME_D, { recursive: true, force: true });
}

export async function httpUp(url: string, ms = 30_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`${url}/api/info`, { signal: AbortSignal.timeout(2000) }); if (r.ok) return true; } catch { /* not yet */ }
    await sleep(500);
  }
  return false;
}
export async function httpDown(url: string, ms = 15_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { await fetch(`${url}/api/info`, { signal: AbortSignal.timeout(1000) }); } catch { return true; }
    await sleep(500);
  }
  return false;
}

/** Is something already listening on this port? */
export const portBusy = (port: number): Promise<boolean> => new Promise((resolve) => {
  const sock = netConnect({ port, host: '127.0.0.1' });
  sock.setTimeout(1500, () => { sock.destroy(); resolve(true); });
  sock.once('connect', () => { sock.destroy(); resolve(true); });
  sock.once('error', () => resolve(false));
});
export async function freePort(candidates: number[]): Promise<number> {
  for (const p of candidates) if (!(await portBusy(p))) return p;
  throw new Error(`no free port among ${candidates.join(', ')}`);
}

/**
 * One throwaway node of our own: its own home under SCRATCH, a free port, the local ledger and an unreachable
 * runtime API (nothing of ours ever touches the shared serving instance or the demo cluster). The place to test
 * `start -d` / `stop` / `config set` / `keys` / `init --force`, none of which may be run against the demo nodes.
 */
export interface Throwaway { home: string; url: string; port: number; init: (args?: string[]) => Promise<RunResult>; cli: (args: string[], opts?: RunOpts) => Promise<RunResult>; stop: () => Promise<void>; }
export async function throwawayNode(tag: string, opts: { port?: number; init?: string[]; start?: boolean } = {}): Promise<Throwaway> {
  const port = opts.port ?? (await freePort([3591, 3592, 3593, 3594, 3595, 3596, 3597, 3598]));
  const home = tmpHome(`node-${tag}`);
  rmSync(home, { recursive: true, force: true });
  const url = `http://localhost:${port}`;
  const cli = (args: string[], o: RunOpts = {}) => runCli(args, { home, timeoutMs: 90_000, ...o });
  const t: Throwaway = {
    home, url, port, cli,
    init: (args: string[] = []) => cli(['init', '--name', tag, '--port', String(port), '--ledger', 'local', '--runtime-api', 'http://127.0.0.1:1', ...args]),
    async stop() {
      await cli(['stop']).catch(() => undefined);
      await httpDown(url, 20_000);
      rmSync(home, { recursive: true, force: true });
    },
  };
  if (opts.start !== false) {
    const i = await t.init(opts.init ?? []);
    if (i.code !== 0) throw new Error(`throwaway ${tag} init failed: ${i.stderr || i.stdout}`);
    const r = await cli(['start', '-d']);
    if (r.code !== 0) throw new Error(`throwaway ${tag} start failed: ${r.stderr || r.stdout}`);
    if (!(await httpUp(url, 60_000))) throw new Error(`throwaway ${tag} never answered on ${url}`);
  }
  return t;
}

/** Start node-d detached (`start -d`) and wait until its API answers. */
export async function startNodeD(extra: string[] = []): Promise<RunResult> {
  const r = await runCli(['start', '-d', ...extra], { home: HOME_D, timeoutMs: 60_000 });
  if (r.code === 0) await httpUp(NODE_D, 60_000);
  return r;
}

// ---------------------------------------------------------------- live test (POST /api/chat) as a given visitor
export interface ChatBody { patch_id: string; mode?: 'base' | 'patched' | 'compare'; max_tokens?: number; messages: { role: string; content: string }[]; thinking?: boolean; }
/** POST /api/chat. `ip` is sent as X-Forwarded-For (the node trusts proxies), giving each test its own visitor quota bucket. */
export async function chatApi(request: APIRequestContext, body: unknown, opts: { node?: string; ip?: string; token?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.ip) headers['x-forwarded-for'] = opts.ip;
  return api<Record<string, unknown>>(request, '/api/chat', { method: 'POST', data: body, node: opts.node ?? NODE_A, token: opts.token, headers });
}

/** Wait for the shared model + lock, run `fn`, and retry (up to 3 attempts) when the runtime was unavailable/busy mid-way (vLLM hangs hourly and restarts in ~5 min). */
export async function withRuntime<T extends { stdout: string; stderr: string; code?: number }>(request: APIRequestContext, fn: () => Promise<T>, node = NODE_A): Promise<T> {
  const flaky = /unavailable|unreachable|shared runtime busy|429|quota exhausted|\[e2e\] timeout|chat failed|fetch failed|cannot reach node|socket hang up|ECONNRE/i;
  let r!: T;
  for (let attempt = 0; attempt < 3; attempt++) {
    await waitForRuntime(request, node);
    await waitForLockFree(request, node);
    r = await fn();
    const failed = (r.code !== undefined && r.code !== 0) || flaky.test(r.stderr);
    if (!failed || !(flaky.test(r.stderr) || flaky.test(r.stdout))) return r;
    await sleep(20_000);
  }
  return r;
}

/**
 * A private 3-node cluster from the same script and binaries as the demo one (`scripts/cluster-restart.sh` with
 * NGRAM_CLUSTER_HOME / NGRAM_PORT_BASE / NGRAM_LEDGER=local / NGRAM_SEED=0): its own home, its own ports, a local
 * ledger (nothing on the shared chain) and no demo seed. It talks to the SAME serving instance as the demo cluster, so
 * its verifiers queue on the one cross-process runtime lock like every other node. Always `stop()` in a `finally`.
 */
export interface PrivateCluster { home: string; base: number; urls: string[]; sh: (...args: string[]) => Promise<RunResult>; stop: () => Promise<void> }
export async function startPrivateCluster(tag: string): Promise<PrivateCluster> {
  let base = 0;
  for (const cand of [3502, 3512, 3522, 3532, 3542, 3552]) {
    if (!(await Promise.all([cand, cand + 1, cand + 2].map(portBusy))).some(Boolean)) { base = cand; break; }
  }
  if (!base) throw new Error('no free port base for a private cluster');
  const home = tmpHome(tag);
  const urls = [base, base + 1, base + 2].map((p) => `http://localhost:${p}`);
  const sh = (...args: string[]): Promise<RunResult> => new Promise((resolve) => {
    const child = spawn('bash', [join(REPO, 'scripts/cluster-restart.sh'), ...args], {
      cwd: REPO, env: { ...process.env, NGRAM_CLUSTER_HOME: home, NGRAM_PORT_BASE: String(base), NGRAM_LEDGER: 'local', NGRAM_SEED: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    const t = setTimeout(() => child.kill('SIGKILL'), 150_000);
    child.on('close', (code) => { clearTimeout(t); resolve({ code: code ?? 1, stdout: strip(out), stderr: strip(err) }); });
  });
  const boot = await sh();
  if (boot.code !== 0) throw new Error(`private cluster ${tag} failed to start: ${boot.stderr || boot.stdout}`);
  for (const u of urls) if (!(await httpUp(u, 120_000))) { await sh('--stop'); throw new Error(`private cluster ${tag}: ${u} never answered`); }
  return { home, base, urls, sh, stop: async () => { await sh('--stop'); rmSync(home, { recursive: true, force: true }); } };
}

export async function pollUntil<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms: number, everyMs = 5000): Promise<T> {
  const t0 = Date.now();
  let last = await fn();
  while (!ok(last) && Date.now() - t0 < ms) { await sleep(everyMs); last = await fn(); }
  return last;
}
