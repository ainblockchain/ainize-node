/**
 * Switch the teach dev node between the two modes AZ-163…AZ-182 need.
 *
 *  stub  — how node-u ships: teach.stubOffline true, no model server involved. Deterministic, and every check is
 *          openly simulated.
 *  live  — runtime.api http://localhost:8002 (the dedicated flashnext-e2e server on GPUs 4+5) and
 *          teach.stubOffline false, with ENGRAM_PATCH_DIR=/mnt/newdata/qwen3.8/ple_patch_e2e in the node's
 *          environment — the patch hook reads that env var; there is no `runtime.patchDir` config key.
 *
 * The node reads its config at start-up, so the file is edited while it is down. Only the two keys above are
 * touched: everything else in config.json (including the operator's own settings) is written back unchanged.
 */
import { spawn } from 'node:child_process';
import { openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NODE, NODE_HOME, sleep } from './ds-train-api';

export const MODEL_API = process.env.AINIZE_TEACH_MODEL_API ?? 'http://localhost:8002';
export const PATCH_DIR = process.env.ENGRAM_PATCH_DIR ?? '/mnt/newdata/qwen3.8/ple_patch_e2e';
const CONFIG = join(NODE_HOME, 'config.json');
const LOG = `${NODE_HOME}.log`;
const CLI = join(new URL('../../..', import.meta.url).pathname, 'packages/cli/dist/bin.js');

interface NodeConfig { runtime: { api: string }; teach: { stubOffline: boolean } }
const readConfig = (): NodeConfig => JSON.parse(readFileSync(CONFIG, 'utf8')) as NodeConfig;

export function nodeMode(): { api: string; stubOffline: boolean } {
  const c = readConfig();
  return { api: c.runtime.api, stubOffline: c.teach.stubOffline };
}

async function up(ms = 90_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if ((await fetch(`${NODE}/api/info`, { signal: AbortSignal.timeout(2000) })).ok) return true; } catch { /* not yet */ }
    await sleep(500);
  }
  return false;
}

async function down(ms = 60_000): Promise<void> {
  let pid: number | null = null;
  try { pid = Number(readFileSync(join(NODE_HOME, 'node.pid'), 'utf8').trim()) || null; } catch { pid = null; }
  if (pid) { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } }
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { await fetch(`${NODE}/api/info`, { signal: AbortSignal.timeout(1000) }); } catch { return; }
    await sleep(500);
  }
  if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  await sleep(2000);
}

/**
 * Restart the node with `runtime.api` / `teach.stubOffline` set for `mode`, and prove it came back in that mode —
 * the node is shared, so another suite may have restarted it from the old config in between.
 */
export async function setNodeMode(mode: 'live' | 'stub', stubApi = 'http://localhost:8000'): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    await down();
    const cfg = readConfig();
    cfg.runtime.api = mode === 'live' ? MODEL_API : stubApi;
    cfg.teach.stubOffline = mode !== 'live';
    writeFileSync(CONFIG, `${JSON.stringify(cfg, null, 1)}\n`);
    const out = openSync(LOG, 'a');
    const env = { ...process.env, ...(mode === 'live' ? { ENGRAM_PATCH_DIR: PATCH_DIR } : {}) };
    const child = spawn(process.execPath, [CLI, '--home', NODE_HOME, 'start'], { env, detached: true, stdio: ['ignore', out, out] });
    child.unref();
    if (!(await up())) throw new Error(`the teach node did not come back up on ${NODE} in ${mode} mode`);
    // `simulated_checks` is the node's own report of `teach.stubOffline`
    const t0 = Date.now();
    while (Date.now() - t0 < 30_000) {
      try {
        const p = (await (await fetch(`${NODE}/api/teach/policy`, { signal: AbortSignal.timeout(5000) })).json()) as { simulated_checks?: boolean };
        if (p.simulated_checks === (mode !== 'live')) return;
      } catch { /* rate limited or restarting */ }
      await sleep(2000);
    }
  }
  throw new Error(`the teach node did not come back in ${mode} mode (another suite may be restarting it)`);
}

/** The node's own view of the serving model + patch hook. */
export async function runtimeReady(ms = 120_000): Promise<{ available: boolean; model: string | null; hook: boolean; error?: string }> {
  const t0 = Date.now();
  let last = { available: false, model: null as string | null, hook: false };
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`${NODE}/api/runtime`, { signal: AbortSignal.timeout(20_000) });
      last = (await r.json()) as typeof last;
      if (last.available) return last;
    } catch { /* the hook probe takes a while on a cold start */ }
    await sleep(3000);
  }
  return last;
}
