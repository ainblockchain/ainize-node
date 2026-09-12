/**
 * Item 124: the running node writes back only what it changed, on top of config.json as it is NOW — and "what it
 * changed" is measured from its last save, not from boot, so a peer added and then removed reaches the file as
 * removed. (Diffed against the boot snapshot, add-then-remove looked like "no change" and the earlier save stood.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, loadConfig, saveConfig } from '@ainize/core';
import { startNode } from '../src/server.js';
import { operatorToken } from './fixtures/operator.js';

const freePort = () => new Promise<number>((res) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); });
});

test("a console save keeps the CLI's edits, and a peer added then removed is removed from config.json (item 124)", async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ngram-persist-'));
  const home = join(tmp, 'home');
  const port = await freePort();
  const cfg = defaultConfig({ home, name: 'persist', port, ledger: 'local', roles: ['seller'] });
  cfg.runtime = { ...cfg.runtime, repo: undefined, api: 'http://127.0.0.1:1', hookApi: 'http://127.0.0.1:1' };   // never the shared model server
  saveConfig(cfg, home);
  const node = await startNode(cfg, { home, quiet: true, serveWeb: false });
  try {
    const url = `http://127.0.0.1:${port}`;
    const token = await operatorToken(url, cfg.identity);
    const peers = (method: 'POST' | 'DELETE', endpoint: string) => fetch(`${url}/api/peers`, {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ endpoint }),
    });

    // meanwhile `ainize config set market.defaultPrice 9.99` wrote the file
    const disk = loadConfig(home)!;
    disk.market.defaultPrice = '9.99';
    saveConfig(disk, home);

    assert.equal((await peers('POST', 'http://127.0.0.1:9')).status, 200);
    let now = loadConfig(home)!;
    assert.deepEqual(now.peers, ['http://127.0.0.1:9']);
    assert.equal(now.market.defaultPrice, '9.99', 'the CLI edit survived the console save');

    assert.equal((await peers('DELETE', 'http://127.0.0.1:9')).status, 200);
    now = loadConfig(home)!;
    assert.deepEqual(now.peers, [], 'the removal reached the file');
    assert.equal(now.market.defaultPrice, '9.99');
  } finally {
    await node.stop();
    rmSync(tmp, { recursive: true, force: true });
  }
});
