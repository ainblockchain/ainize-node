/**
 * A Google account the site vouches for owns hosted agents the way an AIN SSO account does — the same header and
 * secret `/api/keys` trusts (site-assertion.ts), on the agent routes and `/api/auth/me`, and nowhere it is not signed.
 *
 *   node --test --import tsx test/site-assertion-agents.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, type NodeConfig } from '@ainize/core';
import { startNode, type RunningNode } from '../src/server.js';
import { SITE_ASSERTION_SECRET_FILE, SITE_SUBJECT_HEADER, signSiteSubject } from '../src/site-assertion.js';

const tmp = mkdtempSync(join(tmpdir(), 'ainize-site-agents-'));
const SECRET = 'c'.repeat(24) + 'site-secret-for-tests-only';
const PORT_WITH = 24274;
const PORT_WITHOUT = 24275;
const now = () => Math.floor(Date.now() / 1000);

let WITH: RunningNode;
let WITHOUT: RunningNode;

function config(name: string, port: number): NodeConfig {
  const cfg = defaultConfig({ home: join(tmp, name), name, port, peers: [], roles: ['seller'], ledger: 'local' });
  cfg.runtime = { repo: undefined, api: 'http://127.0.0.1:1', hookApi: 'http://127.0.0.1:1' };
  cfg.host = '127.0.0.1'; cfg.publicUrl = `http://127.0.0.1:${port}`;
  cfg.verifier = { quorum: 1, allowSelfAttest: true, intervalMs: 3_600_000, auto: false };
  cfg.gossipIntervalMs = 3_600_000;
  cfg.backends = [{ id: 'llm', modality: 'chat', upstream: 'http://127.0.0.1:1', models: ['m'] }];
  return cfg;
}

before(async () => {
  mkdirSync(join(tmp, 'with'), { recursive: true });
  writeFileSync(join(tmp, 'with', SITE_ASSERTION_SECRET_FILE), `${SECRET}\n`);
  WITH = await startNode(config('with', PORT_WITH), { quiet: true, serveWeb: false, home: join(tmp, 'with') });
  mkdirSync(join(tmp, 'without'), { recursive: true });
  WITHOUT = await startNode(config('without', PORT_WITHOUT), { quiet: true, serveWeb: false, home: join(tmp, 'without') });
});

after(async () => { await WITH?.stop(); await WITHOUT?.stop(); rmSync(tmp, { recursive: true, force: true }); });

const vouched = (subject: string, at = now(), secret = SECRET) => ({ [SITE_SUBJECT_HEADER]: signSiteSubject(secret, subject, at) });
const call = (port: number, method: string, path: string, headers: Record<string, string>, body?: unknown) =>
  fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const agent = (id: string, over: Record<string, unknown> = {}) => ({ id, name: id, model: 'm', systemPrompt: 'Be brief.', ...over });

test('a vouched Google account creates, reads, edits and deletes its own prompt agent', async () => {
  const me = vouched('google:4444');
  const created = await call(PORT_WITH, 'POST', '/api/hosted-agents', me, agent('g-helper'));
  assert.equal(created.status, 201, await created.clone().text());
  const full = await (await call(PORT_WITH, 'GET', '/api/hosted-agents/g-helper', vouched('google:4444'))).json() as { agent: { owner: string } };
  assert.equal(full.agent.owner, 'google:4444');
  assert.equal((await call(PORT_WITH, 'PUT', '/api/hosted-agents/g-helper', vouched('google:4444'), agent('g-helper', { systemPrompt: 'Be kind.' }))).status, 200);
  const mine = await (await call(PORT_WITH, 'GET', '/api/hosted-agents?manageable=1', vouched('google:4444'))).json() as { agents: { id: string }[] };
  assert.deepEqual(mine.agents.map((a) => a.id), ['g-helper']);
  assert.equal((await call(PORT_WITH, 'DELETE', '/api/hosted-agents/g-helper', vouched('google:4444'))).status, 200);
});

test('another Google account cannot change it', async () => {
  assert.equal((await call(PORT_WITH, 'POST', '/api/hosted-agents', vouched('google:5555'), agent('g-owned'))).status, 201);
  assert.equal((await call(PORT_WITH, 'PUT', '/api/hosted-agents/g-owned', vouched('google:6666'), agent('g-owned', { systemPrompt: 'x' }))).status, 403);
  assert.equal((await call(PORT_WITH, 'DELETE', '/api/hosted-agents/g-owned', vouched('google:6666'))).status, 403);
  const theirs = await (await call(PORT_WITH, 'GET', '/api/hosted-agents?manageable=1', vouched('google:6666'))).json() as { agents: unknown[] };
  assert.deepEqual(theirs.agents, []);
});

test('a forged, old or unsigned assertion is nobody', async () => {
  const forged = vouched('google:4444', now(), 'd'.repeat(48));
  assert.equal((await call(PORT_WITH, 'POST', '/api/hosted-agents', forged, agent('g-forged'))).status, 401);
  assert.equal((await call(PORT_WITH, 'POST', '/api/hosted-agents', vouched('google:4444', now() - 600), agent('g-old'))).status, 401);
  assert.equal((await call(PORT_WITH, 'POST', '/api/hosted-agents', { [SITE_SUBJECT_HEADER]: 'google:4444' }, agent('g-bare'))).status, 401);
  assert.equal((await call(PORT_WITH, 'GET', '/api/hosted-agents?manageable=1', forged)).status, 401);
});

test('a node without the shared secret ignores the header entirely', async () => {
  const signed = vouched('google:4444');
  assert.equal((await call(PORT_WITHOUT, 'POST', '/api/hosted-agents', signed, agent('g-nosecret'))).status, 401);
  const me = await (await call(PORT_WITHOUT, 'GET', '/api/auth/me', signed)).json() as { site: unknown };
  assert.equal(me.site, null);
});

test('/api/auth/me reports the vouched account apart, and leaves signedIn/subject/sso alone', async () => {
  const me = await (await call(PORT_WITH, 'GET', '/api/auth/me', vouched('google:7777'))).json() as Record<string, unknown>;
  assert.deepEqual(me.site, { principal: 'google:7777' });
  assert.equal(me.signedIn, false);
  assert.equal(me.subject, null);
  assert.equal(me.sso, null);
  const nobody = await (await call(PORT_WITH, 'GET', '/api/auth/me', {})).json() as Record<string, unknown>;
  assert.equal(nobody.site, null);
});

test('a Google account belongs to no AIN SSO organization', async () => {
  const res = await call(PORT_WITH, 'POST', '/api/hosted-agents', vouched('google:8888'), agent('g-org', { visibility: 'org', orgId: 'org_x' }));
  assert.equal(res.status, 400);
  const body = await res.json() as { error: { message: string } };
  assert.match(body.error.message, /not a member of org_x/);
});
