#!/usr/bin/env node
/**
 * `ngram-node` — start a node from $NGRAM_HOME/config.json (auto-initialised on first run).
 */
import { DEFAULT_HOME, applyEnv, defaultConfig, loadConfig, saveConfig } from '@ngram/core';
import { startNode } from './server.js';

const home = process.env.NGRAM_HOME ?? DEFAULT_HOME;
let cfg = loadConfig(home);
if (!cfg) {
  cfg = defaultConfig({ home, ledger: (process.env.NGRAM_LEDGER as 'local' | 'ain') ?? 'local', port: process.env.NGRAM_PORT ? Number(process.env.NGRAM_PORT) : undefined });
  saveConfig(cfg, home);
  console.log(`initialised new node config at ${home}/config.json`);
}
cfg = applyEnv(cfg);

const node = await startNode(cfg, { home });
const shutdown = async () => { await node.stop(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
