/**
 * Write a config.json the SDK tests can start a node from.
 *
 * `defaultConfig` mints the node's identity key, so the config cannot be hand-written in the Python fixture
 * without reimplementing that here in a second language. This script is the one place that knows the shape, and
 * the fixture just runs it.
 *
 *   npx tsx sdk/python/tests/make-node-config.ts <home> <port> <upstream>
 */
import { defaultConfig, saveConfig } from '@ainize/core';

const [home, port, upstream] = process.argv.slice(2);
if (!home || !port || !upstream) {
  console.error('usage: make-node-config.ts <home> <port> <upstream-url>');
  process.exit(2);
}

const cfg = defaultConfig({ home, name: 'sdk-test-node', port: Number(port), peers: [], roles: ['seller'], ledger: 'local' });
cfg.host = '127.0.0.1';
cfg.publicUrl = `http://127.0.0.1:${port}`;
cfg.runtime = { api: upstream, hookApi: upstream };
cfg.gossipIntervalMs = 3_600_000;
cfg.verifier = { quorum: 1, allowSelfAttest: true, intervalMs: 3_600_000, auto: false };
cfg.backends = [{ id: 'llm', modality: 'chat', upstream, models: ['qwen3.8-flash-next'] }];
saveConfig(cfg, home);
console.log(`wrote ${home}/config.json`);
