import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIdentity, defaultConfig, signMessage } from '@ainize/core';
import { startNode } from '../src/server.js';
import { personalSign } from './fixtures/metamask.js';

test('any wallet can connect two proven nodes, without granting account access, and revoke one', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ainize-links-'));
  const cfg = defaultConfig({ home, name: 'hub', port: 24793, peers: [], ledger: 'local', roles: ['seller'] });
  cfg.runtime = { api: 'http://127.0.0.1:1' }; cfg.host = '127.0.0.1';
  const node = await startNode(cfg, { quiet: true, serveWeb: false });
  const url = 'http://127.0.0.1:24793';
  const call = async (method: string, path: string, body?: unknown, token?: string) => {
    const r = await fetch(url + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: await r.json() as any };
  };
  const login = async (id: ReturnType<typeof createIdentity>, wallet = true) => {
    const ch = await call('POST', '/api/auth/challenge', { scheme: wallet ? 'eip191' : 'ain' });
    const r = await call('POST', '/api/auth/wallet', { address: id.address, nonce: ch.body.nonce, signature: wallet ? personalSign(ch.body.message, id.privateKey) : signMessage(ch.body.message, id.privateKey) });
    assert.equal(r.status, 200); return r.body.token as string;
  };
  try {
    const alice = createIdentity(), bob = createIdentity();
    const aliceToken = await login(alice), bobToken = await login(bob);
    assert.equal((await call('GET', '/api/auth/me', undefined, aliceToken)).body.isOwner, false);
    const a = createIdentity(), b = createIdentity();
    assert.equal((await call('POST', '/api/auth/device', { kind: 'node', delegate: a.address }, aliceToken)).status, 403, 'wallet cannot claim an arbitrary node address');
    const link = async (identity: typeof a, label: string) => {
      const proof = await login(identity, false);
      const request = await call('POST', '/api/auth/device', { kind: 'node', delegate: identity.address, label }, proof);
      assert.equal(request.status, 200);
      const shown = (await call('GET', `/api/auth/device/${request.body.code}`)).body;
      assert.equal(shown.kind, 'node'); assert.match(shown.message, /no wallet spending/);
      assert.equal((await call('POST', `/api/auth/device/${request.body.code}/approve`, { signature: personalSign(shown.message, bob.privateKey) }, aliceToken)).status, 401);
      assert.equal((await call('POST', `/api/auth/device/${request.body.code}/approve`, { signature: personalSign(shown.message, alice.privateKey) }, aliceToken)).status, 200);
      const claim = await call('POST', `/api/auth/device/${request.body.code}/claim`, { poll_secret: request.body.poll_secret });
      assert.equal(claim.status, 200); assert.ok(claim.body.node_link_token); assert.equal(claim.body.token, undefined);
      assert.equal((await call('GET', '/api/my/nodes', undefined, claim.body.node_link_token)).status, 401, 'status token is not an account session');
      return claim.body.node_link_token as string;
    };
    const aToken = await link(a, 'node-a'), bToken = await link(b, 'node-b');
    const list = (await call('GET', '/api/my/nodes', undefined, aliceToken)).body.nodes;
    assert.equal(list.length, 2); assert.ok(list.every((n: any) => n.seen === null));
    assert.equal((await call('GET', '/api/my/nodes', undefined, bobToken)).body.nodes.length, 0);
    const beat = (identity: typeof a, token: string) => call('POST', '/api/my/nodes/heartbeat', { address: identity.address, name: 'running-node', roles: ['seller'], version: 'test' }, token);
    assert.equal((await beat(a, bToken)).status, 401);
    assert.equal((await beat(a, aToken)).status, 200);
    assert.equal((await call('GET', '/api/my/nodes', undefined, aliceToken)).body.nodes.filter((n: any) => n.seen === true).length, 1);
    assert.equal((await call('DELETE', `/api/my/nodes/${a.address}`, undefined, bobToken)).status, 404);
    assert.equal((await call('DELETE', `/api/my/nodes/${a.address}`, undefined, aliceToken)).status, 200);
    assert.equal((await beat(a, aToken)).status, 401);
    assert.equal((await beat(b, bToken)).status, 200);
    assert.equal((await call('GET', '/api/my/nodes', undefined, aliceToken)).body.nodes.length, 1);
    assert.equal(node.store.bindingsOf(alice.address).length, 0, 'node links never become wallet delegation bindings');
  } finally { await node.stop(); rmSync(home, { recursive: true, force: true }); }
});
