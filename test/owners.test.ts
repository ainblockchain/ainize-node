/**
 * Who owns a node, and who may say so.
 *
 * Ownership used to live in one place a browser could not reach: `operatorAddresses` in the config file, plus the
 * node's own key. The only way to add an address was `/api/auth/enroll`, which requires the machine itself — a
 * loopback connection or a token readable only by the OS user the node runs as. That is right for the FIRST owner
 * and wrong for every one after it: a person holding the owning wallet, looking at their own node in a browser,
 * had no way to add a colleague without a shell.
 *
 * So there is now a second list, in the database, that an owner can write. This file pins what each list may do:
 * that the config list and the node's key still own the node and still cannot be revoked over HTTP, that a grant
 * is real immediately, that revoking one actually ends the sessions it bought, and that a stranger gets nowhere.
 *
 *   node --test --import tsx test/owners.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIdentity, defaultConfig, operatorLoginMessage, signMessage, type NodeConfig } from '@ainize/core';
import { startNode, type RunningNode } from '../src/server.js';
import { operatorToken } from './fixtures/operator.js';

const tmp = mkdtempSync(join(tmpdir(), 'ngram-owners-'));
const PORT = 24121;
const CONFIGURED = createIdentity();   // an address in operatorAddresses, as if hand-edited into the config file
const GRANTED = createIdentity();      // an address an owner adds from a browser
const STRANGER = createIdentity();

let N: RunningNode;
let url = '';
let identity: NodeConfig['identity'];
let op = '';

const api = async (method: string, path: string, body?: unknown, token?: string) => {
  const r = await fetch(`${url}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() as Record<string, unknown> };
};
/** Sign in the way a person with a key does: challenge, sign, present. */
const signIn = async (id: { privateKey: string; address: string }) => {
  const ch = await api('POST', '/api/auth/challenge', {});
  const nonce = (ch.body as { nonce: string }).nonce;
  return api('POST', '/api/auth/wallet', {
    address: id.address, nonce,
    signature: signMessage(operatorLoginMessage({ node: identity.address, nonce }), id.privateKey),
  });
};
type Owner = { address: string; source: string; added_by: string | null };
const ownerList = async (token = op): Promise<Owner[]> => ((await api('GET', '/api/auth/owners', undefined, token)).body.owners as Owner[]);
const lower = (a: string) => a.toLowerCase();

before(async () => {
  const cfg: NodeConfig = defaultConfig({ home: join(tmp, 'N'), name: 'N', port: PORT, peers: [], roles: ['seller'], ledger: 'local' });
  cfg.runtime = { repo: undefined, api: 'http://127.0.0.1:1', hookApi: 'http://127.0.0.1:1' };
  cfg.host = '127.0.0.1'; cfg.publicUrl = `http://127.0.0.1:${PORT}`;
  cfg.operatorAddresses = [CONFIGURED.address];
  cfg.verifier = { quorum: 1, allowSelfAttest: true, intervalMs: 300_000, auto: false };
  cfg.gossipIntervalMs = 60_000;
  N = await startNode(cfg, { quiet: true, serveWeb: false });
  identity = cfg.identity;
  url = `http://127.0.0.1:${PORT}`;
  op = await operatorToken(url, identity);
});
after(async () => { await N?.stop(); rmSync(tmp, { recursive: true, force: true }); });

test('the two lists that were always there are both owners, and each says where it came from', async () => {
  const list = await ownerList();
  const node = list.find((o) => lower(o.address) === lower(identity.address));
  const configured = list.find((o) => lower(o.address) === lower(CONFIGURED.address));
  assert.equal(node?.source, 'node', "the node's own key owns what the node published — that is not a grant");
  assert.equal(configured?.source, 'config', 'a config entry must not be reported as something an API call created');
  // The whole point of naming the source: what may be revoked over HTTP is exactly what was created over HTTP.
  assert.equal(list.length, 2, JSON.stringify(list));
});

test('an owner grants ownership from a browser, and the grant works immediately', async () => {
  assert.equal((await signIn(GRANTED)).status, 403, 'not an owner yet');

  const add = await api('POST', '/api/auth/owners', { address: GRANTED.address, note: 'a colleague' }, op);
  assert.equal(add.status, 200);
  const granted = (await ownerList()).find((o) => lower(o.address) === lower(GRANTED.address));
  assert.equal(granted?.source, 'granted');
  assert.equal(granted?.added_by, lower(identity.address), 'a grant carries the name of the owner who made it');

  const now = await signIn(GRANTED);
  assert.equal(now.status, 200, JSON.stringify(now.body));
  // The session records the address that signed, not "an operator" — which is what makes the next step possible.
  assert.equal(N.store.getSession(now.body.token as string)?.subject, lower(GRANTED.address));
});

test('granting twice keeps the first grant rather than rewriting who let them in', async () => {
  const again = await api('POST', '/api/auth/owners', { address: GRANTED.address }, op);
  assert.equal(again.body.already, true);
  const row = (await ownerList()).find((o) => lower(o.address) === lower(GRANTED.address));
  assert.equal(row?.added_by, lower(identity.address), 'the second call must not overwrite the first grant');
});

test('a stranger can neither read the owners nor add themselves', async () => {
  assert.equal((await api('GET', '/api/auth/owners')).status, 401);
  // Not loopback in spirit but it is in fact 127.0.0.1 here, so `mayClaim` is true — what this pins is that the
  // unauthenticated ADD path is the enrolment path, which demands a signature from the address, and not a free
  // grant. A stranger off-machine gets 401 from the same route.
  const r = await api('POST', '/api/auth/enroll', { address: STRANGER.address, nonce: 'nope', signature: '0x00' });
  assert.equal(r.status, 401, JSON.stringify(r.body));
  assert.equal((await signIn(STRANGER)).status, 403);
});

test('revoking a grant ends the sessions it bought', async () => {
  const theirs = (await signIn(GRANTED)).body.token as string;
  assert.ok(N.store.getSession(theirs), 'a live session to revoke');

  const gone = await api('DELETE', `/api/auth/owners/${GRANTED.address}`, undefined, op);
  assert.equal(gone.status, 200, JSON.stringify(gone.body));
  // A 30-day cookie would outlive the revocation by a month. Revocation that leaves a live session is not one.
  assert.ok((gone.body.sessions_ended as number) >= 1, JSON.stringify(gone.body));
  assert.equal(N.store.getSession(theirs), null);
  assert.equal((await api('GET', '/api/auth/owners', undefined, theirs)).status, 401);
  assert.equal((await signIn(GRANTED)).status, 403, 'and they are not an owner any more');
});

test('what the HTTP layer did not create, it will not remove', async () => {
  // Each of these would be a lie if it succeeded: the row would vanish and the address would still own the node,
  // because the claim it owns by lives in the config file or in the node's own identity.
  const own = await api('DELETE', `/api/auth/owners/${identity.address}`, undefined, op);
  assert.equal(own.status, 400);
  assert.match(String(own.body.error), /own key/);

  const conf = await api('DELETE', `/api/auth/owners/${CONFIGURED.address}`, undefined, op);
  assert.equal(conf.status, 400);
  assert.match(String(conf.body.error), /config file/, 'the refusal has to say where the entry actually is');

  const never = await api('DELETE', `/api/auth/owners/${STRANGER.address}`, undefined, op);
  assert.equal(never.status, 404, 'removing a non-owner is not a success');
});

test('an owner cannot revoke themselves into a locked door', async () => {
  const mine = await api('POST', '/api/auth/owners', { address: CONFIGURED.address }, op);
  assert.equal(mine.body.already, true, 'already an owner by config — the grant table must not double-list them');

  const second = createIdentity();
  await api('POST', '/api/auth/owners', { address: second.address }, op);
  const theirToken = (await signIn(second)).body.token as string;
  const self = await api('DELETE', `/api/auth/owners/${second.address}`, undefined, theirToken);
  assert.equal(self.status, 400);
  assert.match(String(self.body.error), /another owner/, 'the refusal has to name the way out');
  // Another owner can, which is the check this is asking for and not a dead end.
  assert.equal((await api('DELETE', `/api/auth/owners/${second.address}`, undefined, op)).status, 200);
});
