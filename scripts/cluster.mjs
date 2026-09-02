#!/usr/bin/env node
/**
 * Local 3-node demo cluster on one machine:
 *   A :3402 seller + verifier (seeded: prototype ledger, real Qwen3.8 patches if present, synthetic demo patches, branches)
 *   B :3403 verifier (runtime-enabled → real benchmark attestations when vLLM + hook are available)
 *   C :3404 verifier + serving (also runtime-enabled; the three nodes share one serving model under a cross-process lock)
 * Quorum 2 → A's patches get LISTED by B + C. A serves the web UI at http://localhost:3402.
 *
 *   node scripts/cluster.mjs            # foreground; Ctrl+C stops all
 *   NGRAM_LEDGER=ain node scripts/cluster.mjs   # all three on the local AIN chain (run `ngram chain up` first)
 *   NGRAM_CLUSTER_HOME=/tmp/c NGRAM_PORT_BASE=3502 NGRAM_LEDGER=local NGRAM_SEED=0 node scripts/cluster.mjs
 *                                        # a private throwaway cluster (ports 3502-3504, no seeding, nothing on the chain)
 *
 * Teach mode (visitors teach the model from /chat?teach=1) is switched ON for node-a when its config is first created:
 * `teach.enabled: true`, `teach.publish: 'auto'` (a signed lesson is announced at once — the demo is frictionless; set
 * 'review' to approve each lesson on My knowledge → Teaching). The trainer backend is TEACH_BACKEND below.
 * Existing homes are never rewritten — flip a running node with `ainize config set teach.enabled true` (restart) or on the
 * Teaching tab (kv override, no restart).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const base = process.env.NGRAM_CLUSTER_HOME ?? join(homedir(), '.ngram-cluster');
const chainUp = await (async () => { try { const r = await fetch('http://localhost:8081/node_status', { signal: AbortSignal.timeout(2000) }); const j = await r.json(); return !!j?.result?.health; } catch { return false; } })();
const ledger = process.env.NGRAM_LEDGER ?? (chainUp ? 'ain' : 'local');
const portBase = Number(process.env.NGRAM_PORT_BASE ?? 3402);
// The demo cluster (and the e2e suite that drives it) talks to its OWN vLLM instance so it never
// competes with the main serving GPUs: flashnext-e2e on GPUs 4,5 → :8002, mailbox ple_patch_e2e.
//   qwen3.8/serve.sh: NAME=flashnext-e2e PORT=8002 GPUS='"device=4,5"' TP=2 MTP=0 ENGRAM_HOOK=1 \
//                     PATCH_DIR=/mnt/newdata/qwen3.8/ple_patch_e2e ./serve.sh
const runtimeApi = process.env.NGRAM_RUNTIME_API ?? 'http://localhost:8002';
const runtimePatchDir = process.env.NGRAM_RUNTIME_PATCH_DIR ?? '/mnt/newdata/qwen3.8/ple_patch_e2e';
const seedA = process.env.NGRAM_SEED !== '0';
const core = await import(join(root, 'packages/core/dist/index.js'));
const nodePkg = await import(join(root, 'packages/node/dist/index.js'));

// ============================================================================================================
// TEACH BACKEND SWITCH — 'stub' until GPUs 4–6 are free of the owner's training run (train_rev.py).
//   'stub'     : no GPU training; the worker writes a small knowledge file (the 픽셀플러스 fixture when a correction
//                mentions it) so the whole visitor flow incl. the live side-effect check can be demonstrated.
//   'gradient' : real training — `docker exec flashtrain python3 train/teach.py` on teach.trainer.gpus (4,5,6).
//                Flip to 'gradient' once `nvidia-smi` shows GPUs 4–6 idle; the serving GPUs (vLLM) must stay disjoint.
// Override per run: NGRAM_TEACH_BACKEND=gradient node scripts/cluster.mjs
// ============================================================================================================
const TEACH_BACKEND = process.env.NGRAM_TEACH_BACKEND ?? 'stub';   // TODO(gpu): 'gradient' when GPUs 4–6 are free
const teachDemo = { enabled: true, publish: 'auto', backend: TEACH_BACKEND };

const defs = [
  // teach: only the web-UI node accepts lessons — all three share one trainer container / GPU set, so one queue is enough.
  { name: 'node-a', port: portBase, roles: ['seller', 'verifier', 'serving'], peers: [], runtime: true, seed: seedA, teach: teachDemo },
  { name: 'node-b', port: portBase + 1, roles: ['verifier'], peers: [`http://localhost:${portBase}`], runtime: true, seed: false },
  { name: 'node-c', port: portBase + 2, roles: ['verifier', 'serving'], peers: [`http://localhost:${portBase}`], runtime: true, seed: false },
];

function ensureConfig(d) {
  const home = join(base, d.name);
  let cfg = core.loadConfig(home);
  if (!cfg) {
    cfg = core.defaultConfig({ home, name: d.name, port: d.port, roles: d.roles, peers: d.peers, ledger, runtimeApi, runtimePatchDir });
    if (!d.runtime) cfg.runtime = { ...cfg.runtime, repo: undefined };
    cfg.publicUrl = `http://localhost:${d.port}`;
    // Core keeps `server.trustProxy` false by default (a spoofed X-Forwarded-For must not fool req.ip on a real
    // deployment). The DEMO cluster runs locally behind no proxy and the e2e suite isolates visitor quotas by
    // sending distinct X-Forwarded-For values (freshVisitor), so the demo nodes opt in explicitly here.
    cfg.server = { ...(cfg.server ?? {}), trustProxy: true };
    if (d.teach) cfg.teach = { ...core.teachConfig(cfg), ...d.teach };   // never `stubOffline` here: the demo checks lessons on the real model
    core.saveConfig(cfg, home);
    console.log(`[cluster] created ${home}/config.json  (${cfg.identity.address})${d.teach ? `  teach: enabled, publish ${d.teach.publish}, backend ${d.teach.backend}` : ''}`);
  } else {
    // An existing home keeps its identity and data but always follows the serving instance this cluster is
    // pointed at — otherwise a node would apply patches into another instance's mailbox and lock.
    if (cfg.runtime?.repo && (cfg.runtime.api !== runtimeApi || cfg.runtime.patchDir !== runtimePatchDir)) {
      cfg.runtime = { ...cfg.runtime, api: runtimeApi, patchDir: runtimePatchDir };
      core.saveConfig(cfg, home);
      console.log(`[cluster] ${d.name}: runtime → ${runtimeApi}  (mailbox ${runtimePatchDir})`);
    }
    if (d.teach && !(cfg.teach?.enabled)) {
      console.log(`[cluster] ${d.name}: teach mode is off in the existing ${home}/config.json — enable with \`NGRAM_HOME=${home} ainize config set teach.enabled true\` (+ teach.publish auto, teach.backend ${TEACH_BACKEND}) or on My knowledge → Teaching`);
    }
  }
  return { home, cfg };
}

const nodes = defs.map(ensureConfig);
mkdirSync(base, { recursive: true });
writeFileSync(join(base, 'supervisor.pid'), String(process.pid));

if (ledger === 'ain') {
  for (const { cfg } of nodes) {
    try {
      const l = new core.AinLedger({ providerUrl: cfg.ledger.ain.providerUrl, chainId: 0 }, cfg.identity);
      const bal = await l.balance();
      if (bal < 50) { await core.fundFromGenesis(cfg.ledger.ain.providerUrl, cfg.identity.address, 1000); console.log(`[cluster] funded ${cfg.name} with 1000 AIN`); }
    } catch (e) { console.error(`[cluster] AIN funding failed for ${cfg.name}: ${e.message} — is the chain up? (ngram chain up)`); }
  }
  const admin = new core.AinLedger({ providerUrl: nodes[0].cfg.ledger.ain.providerUrl, chainId: 0 }, nodes[0].cfg.identity);
  try { const s = await admin.setupApp(); console.log(`[cluster] AIN app ${s.created ? 'created' : 'exists'} (admin ${s.admin ?? nodes[0].cfg.identity.address})`); } catch (e) { console.error(`[cluster] setupApp: ${e.message}`); }
}

// seed A once (in-process, no listener), then start all three as child processes
const seedMarker = join(nodes[0].home, '.seeded');
if (defs[0].seed && !existsSync(seedMarker)) {
  const n = await nodePkg.startNode(nodes[0].cfg, { home: nodes[0].home, listen: false, quiet: true, serveWeb: false });
  const rep = await nodePkg.seedDemo(n.market);
  console.log(`[cluster] seeded node-a: ${rep.created.length} patches, ${rep.branches.length} branches, ${rep.imported_prototype} prototype records`);
  await n.stop();
  writeFileSync(seedMarker, new Date().toISOString());
}

const children = [];
function spawnNode({ home, cfg }, attempt = 0) {
  const child = spawn(process.execPath, [join(root, 'packages/node/dist/bin.js')], {
    env: { ...process.env, NGRAM_HOME: home, NGRAM_PORT: String(cfg.port) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tag = `[${cfg.name}]`;
  const startedAt = Date.now();
  child.stdout.on('data', (d) => process.stdout.write(String(d).split('\n').filter(Boolean).map((l) => `${tag} ${l}`).join('\n') + '\n'));
  child.stderr.on('data', (d) => process.stderr.write(String(d).split('\n').filter(Boolean).map((l) => `${tag} ${l}`).join('\n') + '\n'));
  child.on('exit', (code) => {
    // A node that dies within 15 s of starting (typically EADDRINUSE while the previous instance is still shutting down) is respawned.
    if (!stopping && Date.now() - startedAt < 15_000 && attempt < 6) {
      console.log(`[cluster] ${cfg.name} exited early (code ${code}) — retrying in 3 s (attempt ${attempt + 1}/6)`);
      setTimeout(() => { const i = children.indexOf(child); const next = spawnNode({ home, cfg }, attempt + 1); if (i >= 0) children[i] = next; writePids(); }, 3000);
    }
  });
  return child;
}
let stopping = false;
const writePids = () => writeFileSync(join(base, 'nodes.pid'), children.map((c) => c.pid).filter(Boolean).join('\n') + '\n');
for (const n of nodes) children.push(spawnNode(n));
writePids();
console.log(`\n[cluster] web UI → http://localhost:${portBase}   (B: ${portBase + 1}, C: ${portBase + 2}; homes under ${base}; ledger=${ledger}; teach backend=${TEACH_BACKEND})\n`);
const stop = () => { stopping = true; for (const c of children) c.kill('SIGTERM'); setTimeout(() => process.exit(0), 500); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
