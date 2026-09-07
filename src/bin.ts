#!/usr/bin/env node
/**
 * `ainize-node` — start a node from $AINIZE_HOME/config.json (auto-initialised on first run).
 */
import { DEFAULT_HOME, applyEnv, defaultConfig, loadConfig, saveConfig } from '@ainize/core';
import { startNode } from './server.js';

const home = process.env.AINIZE_HOME ?? DEFAULT_HOME;
let cfg = loadConfig(home);
if (!cfg) {
  cfg = defaultConfig({ home, ledger: (process.env.AINIZE_LEDGER as 'local' | 'ain') ?? 'local', port: process.env.AINIZE_PORT ? Number(process.env.AINIZE_PORT) : undefined });
  saveConfig(cfg, home);
  console.log(`initialised new node config at ${home}/config.json`);
}
cfg = applyEnv(cfg);

const node = await startNode(cfg, { home });
const shutdown = async () => { await node.stop(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
