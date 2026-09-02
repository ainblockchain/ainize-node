/**
 * Node-mode control for the result-screen scenarios: the dev node node-u (:3422) runs with a stub trainer whose checks
 * are simulated by default, and several scenarios (AZ-183/184/188/189/190/191/202) only mean anything against the real
 * serving model. Switching modes is a config change plus a restart, and the restart carries the mailbox TWICE:
 * `NGRAM_RUNTIME_PATCH_DIR` sets `runtime.patchDir` in the node's own config, and `ENGRAM_PATCH_DIR` is the variable
 * the patch hook itself reads. Both are needed: the node RE-EXPORTS `ENGRAM_PATCH_DIR` from its own `patchDir()` when
 * it calls the hook (packages/node/src/runtime.ts), so a node without `runtime.patchDir` silently falls back to
 * `<runtime.repo>/ple_patch` — the SHARED production mailbox — and overrides whatever this helper exported.
 *
 * Owner rule, enforced here: the live model is ALWAYS http://localhost:8002 (container flashnext-e2e, GPUs 4+5).
 * Never :8000 / :8001.
 */
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { freePort, SCRATCH } from './ainize';
import { NODE } from './ds-result-api';

const execFileP = promisify(execFile);

export const REPO = process.env.AINIZE_TEACHABLE_REPO ?? '/mnt/newdata/ainize/knowledge-marketplace-teachable';
export const HOME = process.env.AINIZE_TEACHABLE_HOME ?? join(homedir(), '.ngram-teachable/node-u');
export const CLI = join(REPO, 'packages/cli/dist/bin.js');
export const LOG = join(homedir(), '.ngram-teachable/node-u.log');
/** The dedicated e2e model server and its patch mailbox — GPUs 4+5 only. */
export const LIVE_API = 'http://localhost:8002';
export const PATCH_DIR = '/mnt/newdata/qwen3.8/ple_patch_e2e';
/** A closed port: "the model server is off or restarting". */
export const DEAD_API = 'http://localhost:8099';

export type NodeMode = 'stub' | 'live' | 'outage';

export interface NodeConfigShape { runtime: { api?: string }; teach: { stubOffline?: boolean } }

export function readNodeConfig(): NodeConfigShape {
  return JSON.parse(readFileSync(join(HOME, 'config.json'), 'utf8')) as NodeConfigShape;
}

async function cliRun(args: string[]): Promise<void> {
  const { stderr } = await execFileP(process.execPath, [CLI, '--home', HOME, ...args], { cwd: REPO, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
  const noise = stderr.split('\n').filter((l) => l.trim() && !l.includes('secp256k1 unavailable')).join('\n');
  if (noise) console.warn(`ainize ${args.join(' ')}: ${noise}`);
}

export const configSet = (key: string, value: string) => cliRun(['config', 'set', key, value]);

const pid = (): number | null => { try { const n = Number(readFileSync(join(HOME, 'node.pid'), 'utf8').trim()); return Number.isFinite(n) ? n : null; } catch { return null; } };
const alive = (p: number | null) => { if (!p) return false; try { process.kill(p, 0); return true; } catch { return false; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUp(timeoutMs = 90_000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await fetch(`${NODE}/api/info`, { signal: AbortSignal.timeout(2000) }); if (r.ok) return; } catch { /* not yet */ }
    await sleep(500);
  }
  throw new Error(`node-u did not answer on ${NODE} within ${timeoutMs} ms`);
}

/** SIGTERM the running node and start it again from the worktree build, with `env` added to its environment. */
export async function restartNode(env: Record<string, string> = {}): Promise<void> {
  const p = pid();
  if (alive(p)) {
    try { process.kill(p!, 'SIGTERM'); } catch { /* already gone */ }
    for (let i = 0; i < 200 && alive(p); i++) await sleep(100);
    if (alive(p)) { try { process.kill(p!, 'SIGKILL'); } catch { /* gone */ } }
    for (let i = 0; i < 50 && alive(p); i++) await sleep(100);
  }
  const { openSync } = await import('node:fs');
  const out = openSync(LOG, 'a');
  const child = spawn(process.execPath, [CLI, '--home', HOME, 'start'], {
    cwd: REPO, detached: true, stdio: ['ignore', out, out],
    env: { ...process.env, ...env },
  });
  child.unref();
  await waitUp();
}

/**
 * Put node-u into one of the three modes these scenarios need and restart it.
 *  - `stub`   : the node as it ships here — simulated checks, nothing reaches a model server.
 *  - `live`   : checks measured in the real model on :8002, patch hook writing to the e2e mailbox.
 *  - `outage` : a live-mode config whose serving API is a closed port (the model server is off).
 */
export async function setNodeMode(mode: NodeMode, restoreApi?: string): Promise<void> {
  if (mode === 'stub') {
    await configSet('teach.stubOffline', 'true');
    await configSet('runtime.api', restoreApi ?? 'http://localhost:8000');
    await restartNode();
    return;
  }
  await configSet('teach.stubOffline', 'false');
  await configSet('runtime.api', mode === 'live' ? LIVE_API : DEAD_API);
  await restartNode({ ENGRAM_PATCH_DIR: PATCH_DIR, NGRAM_RUNTIME_PATCH_DIR: PATCH_DIR });
}

/** True once the node reports a usable serving model + patch hook. */
export async function runtimeReady(timeoutMs = 5 * 60_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${NODE}/api/runtime`, { signal: AbortSignal.timeout(30_000) });
      if (r.ok && ((await r.json()) as { available?: boolean }).available) return true;
    } catch { /* keep waiting */ }
    await sleep(3000);
  }
  return false;
}


// ---------------------------------------------------------------- a private node for the live-model scenarios
/**
 * node-u is a SHARED dev node: other sessions train on it, flip its teach policy and restart it while this suite runs.
 * The live-model scenarios need a node reconfigured (`runtime.api` → the dedicated :8002 server, `teach.stubOffline`
 * false) and restarted, which is exactly the state another session's stub-mode run cannot survive — and vice versa: a
 * restart from that session lands in the middle of a four-minute live check here.
 *
 * So those scenarios get their own node, started from the SAME build, the same config defaults and the same model
 * server, on a free port under the scratch directory. It is destroyed afterwards, and nothing it publishes touches
 * node-u or the demo cluster.
 */
export interface PrivateNode {
  url: string; home: string; port: number;
  /** (Re)start it with these environment overrides (NGRAM_TEACH_STUB_OFFLINE, NGRAM_RUNTIME_API, …). */
  start: (env?: Record<string, string>) => Promise<void>;
  stop: () => Promise<void>;
}

export async function startPrivateNode(tag: string, env: Record<string, string> = {}): Promise<PrivateNode> {
  const home = join(SCRATCH, `ds-live-${tag}-${Date.now().toString(36)}`);
  mkdirSync(home, { recursive: true });
  const port = await freePort();
  const url = `http://localhost:${port}`;
  const run = async (args: string[]) => {
    const { stderr } = await execFileP(process.execPath, [CLI, '--home', home, ...args], { cwd: REPO, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    const noise = stderr.split('\n').filter((l) => l.trim() && !l.includes('secp256k1 unavailable')).join('\n');
    if (noise) console.warn(`ainize ${args.join(' ')}: ${noise}`);
  };
  await run(['init', '--name', `ds-live-${tag}`, '--port', String(port), '--ledger', 'local', '--roles', 'seller,serving',
    '--runtime-repo', '/mnt/newdata/qwen3.8', '--runtime-api', LIVE_API, '--public-url', url]);

  const pidOf = () => { try { const n = Number(readFileSync(join(home, 'node.pid'), 'utf8').trim()); return Number.isFinite(n) ? n : null; } catch { return null; } };
  const isAlive = (p: number | null) => { if (!p) return false; try { process.kill(p, 0); return true; } catch { return false; } };
  const waitFor = async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 90_000) {
      try { const r = await fetch(`${url}/api/info`, { signal: AbortSignal.timeout(2000) }); if (r.ok) return; } catch { /* not yet */ }
      await sleep(500);
    }
    throw new Error(`private node did not answer on ${url}`);
  };
  const kill = async () => {
    const p = pidOf();
    if (!isAlive(p)) return;
    try { process.kill(p!, 'SIGTERM'); } catch { /* gone */ }
    for (let i = 0; i < 200 && isAlive(p); i++) await sleep(100);
    if (isAlive(p)) { try { process.kill(p!, 'SIGKILL'); } catch { /* gone */ } }
    for (let i = 0; i < 50 && isAlive(p); i++) await sleep(100);
  };
  const start = async (extra: Record<string, string> = {}) => {
    await kill();
    const log = openSync(join(home, 'node.log'), 'a');
    const child = spawn(process.execPath, [CLI, '--home', home, 'start'], {
      cwd: REPO, detached: true, stdio: ['ignore', log, log],
      env: {
        ...process.env, ENGRAM_PATCH_DIR: PATCH_DIR, NGRAM_RUNTIME_PATCH_DIR: PATCH_DIR,
        NGRAM_TEACH_ENABLED: '1', NGRAM_TEACH_BACKEND: 'stub', NGRAM_RUNTIME_API: LIVE_API,
        ...env, ...extra,
      },
    });
    child.unref();
    await waitFor();
    // a detached watchdog: this node must not outlive the run even if the test process is killed
    const pid = pidOf();
    if (pid) spawn('sh', ['-c', `sleep 5400; kill ${pid} 2>/dev/null`], { detached: true, stdio: 'ignore' }).unref();
  };
  const stop = async () => { await kill(); rmSync(home, { recursive: true, force: true }); };
  await start();
  return { url, home, port, start, stop };
}
