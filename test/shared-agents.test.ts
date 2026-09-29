/**
 * The shared agent registry (shared-agents.ts): who sees which hosted agent, the cross-product listing in the
 * ain-integration contract "1.0" shape, and the change feed.
 *
 * The HTTP tests run the real hosted-agent routes, the real in-process host (prompt agents, no Docker) and the real
 * `/api/agents` list, with the signed-in caller taken from test headers. Session resolution against the SQLite
 * store — a wallet session, an AIN SSO session and its memberships — has its own test below.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import express, { type Request } from 'express';
import type { NodeConfig } from '@ainize/core';
import { buildAgents } from '../src/agents.js';
import { InferenceBackendRegistry } from '../src/inference-backends.js';
import { HostedAgentGateway } from '../src/hosted-agent-gateway.js';
import { HostedAgentHost } from '../src/hosted-agent-host.js';
import { HostedAgentSecretStore } from '../src/hosted-agent-secrets.js';
import { HostedAgentStore } from '../src/hosted-agent-store.js';
import { hostedAgentRoutes } from '../src/hosted-agent-routes.js';
import { hostedAgentSpecInput, hostedAgentVisibilityOf, type HostedAgentSpec } from '../src/hosted-agent-types.js';
import { HOSTED_AGENT_AUDIO_INPUT_MODES } from '../src/hosted-agent-runtime/hostedAgentRuntimeApp.js';
import {
  agentCallerOf, canSeeHostedAgent, hostedAgentChangeType, hostedAgentRef, listsHostedAgentFor, SharedAgentEvents, sharedAgentRoutes, walletCaller,
  type AgentCaller, type AgentEventPage, type AgentListResponse, type AgentRef,
} from '../src/shared-agents.js';
import { Store } from '../src/store.js';

const MODEL = 'Test-Chat-1';
const ALICE = '0x00000000000000000000000000000000000a11ce';
const BOB = '0x0000000000000000000000000000000000000b0b';
const NODE = '0x1111111111111111111111111111111111111111';
const SSO_ISSUER = 'https://auth.example';
const ISSUER = 'https://node.example';

// ───────────────────────────────────────────── spec and visibility rules

test('visibility: public by default, org needs an orgId, orgId goes with org', () => {
  const base = { id: 'x', name: 'X', model: MODEL };
  assert.equal(hostedAgentSpecInput.parse(base).visibility, 'public');
  assert.equal(hostedAgentSpecInput.parse(base).orgId, null);
  assert.equal(hostedAgentSpecInput.safeParse({ ...base, visibility: 'org' }).success, false, 'org names the organization');
  assert.equal(hostedAgentSpecInput.safeParse({ ...base, visibility: 'org', orgId: 'org_comcom' }).success, true);
  assert.equal(hostedAgentSpecInput.safeParse({ ...base, visibility: 'private', orgId: 'org_comcom' }).success, false, 'orgId without org visibility is a mistake, not ignored');
  assert.equal(hostedAgentSpecInput.safeParse({ ...base, visibility: 'org', orgId: 'has space' }).success, false);
  assert.equal(hostedAgentSpecInput.safeParse({ ...base, visibility: 'secret' }).success, false);
});

const specOf = (over: Partial<HostedAgentSpec>): HostedAgentSpec =>
  ({ ...hostedAgentSpecInput.parse({ id: 'a', name: 'A', model: MODEL }), owner: ALICE, version: 1, createdAt: 0, updatedAt: 0, ...over } as HostedAgentSpec);
const member = (subject: string, orgs: string[]): AgentCaller =>
  ({ subject, kind: 'principal', sso: { iss: SSO_ISSUER, sub: subject.slice(4), org: orgs[0] ?? null, orgs }, orgMember: (o) => orgs.includes(o) });

test('a spec stored before visibility existed is public; each visibility lists and answers to whom it should', () => {
  const legacy = { ...specOf({}), visibility: undefined } as HostedAgentSpec;
  delete (legacy as { visibility?: unknown }).visibility;
  assert.equal(hostedAgentVisibilityOf(legacy), 'public');
  assert.equal(listsHostedAgentFor(legacy, null), true);
  assert.equal(canSeeHostedAgent(legacy, null), true);

  const owner = walletCaller(ALICE);
  const other = walletCaller(BOB);
  const insider = member('sso:p2', ['org_comcom']);
  const outsider = member('sso:p3', ['org_other']);
  const cases: [Partial<HostedAgentSpec>, AgentCaller | null, boolean, boolean][] = [
    [{ visibility: 'public' }, null, true, true],
    [{ visibility: 'unlisted' }, null, false, true],
    [{ visibility: 'unlisted' }, owner, true, true],
    [{ visibility: 'private' }, null, false, false],
    [{ visibility: 'private' }, other, false, false],
    [{ visibility: 'private' }, owner, true, true],
    [{ visibility: 'org', orgId: 'org_comcom' }, null, false, false],
    [{ visibility: 'org', orgId: 'org_comcom' }, insider, true, true],
    [{ visibility: 'org', orgId: 'org_comcom' }, outsider, false, false],
    [{ visibility: 'org', orgId: 'org_comcom' }, owner, true, true],
  ];
  for (const [over, caller, listed, seen] of cases) {
    const spec = specOf(over);
    const label = `${over.visibility} to ${caller?.subject ?? 'anonymous'}`;
    assert.equal(listsHostedAgentFor(spec, caller), listed, `listed: ${label}`);
    assert.equal(canSeeHostedAgent(spec, caller), seen, `seen: ${label}`);
  }
  assert.equal(hostedAgentChangeType(specOf({ visibility: 'public' }), specOf({ visibility: 'unlisted' })), 'agent.unpublished');
  assert.equal(hostedAgentChangeType(specOf({ visibility: 'private' }), specOf({ visibility: 'org', orgId: 'o' })), 'agent.published');
  assert.equal(hostedAgentChangeType(specOf({ visibility: 'public' }), specOf({ visibility: 'org', orgId: 'o' })), 'agent.updated');
});

// ───────────────────────────────────────────── who is asking, from the session store

const bearer = (token: string | null) => ({
  cookies: {},
  header: (name: string) => (name.toLowerCase() === 'authorization' && token ? `Bearer ${token}` : undefined),
}) as unknown as Request;

test('a wallet session is a wallet caller; an SSO session is its principal, a member of what the adapter or its ID token says', () => {
  const store = new Store(':memory:');
  store.putSession('t-wallet', 3600_000, { subject: ALICE.toUpperCase(), scheme: 'ain' });
  store.insertSsoIdentity({ issuer: SSO_ISSUER, subject: 'sub-1', principal: 'sso:sub-1', linkProof: 'sso_login' });
  store.putSession('t-sso', 3600_000, { subject: 'sso:sub-1', scheme: 'sso', sso: { iss: SSO_ISSUER, sub: 'sub-1', sid: 'sid', orgs: [{ id: 'org_token', slug: 't', name: 'T' }, { id: 'org_gone', slug: 'g', name: 'G' }], org: 'org_token' } });
  store.putSsoMembership({ issuer: SSO_ISSUER, subject: 'sub-1', org_id: 'org_adapter', org_slug: 'a', org_name: 'A', status: 'active', app_role: null, groups: [], legacy_user_id: null, applied_version: 1 });
  store.putSsoMembership({ issuer: SSO_ISSUER, subject: 'sub-1', org_id: 'org_gone', org_slug: 'g', org_name: 'G', status: 'suspended', app_role: null, groups: [], legacy_user_id: null, applied_version: 2 });

  assert.equal(agentCallerOf(bearer(null), { store, nodeAddress: NODE }), null);
  const wallet = agentCallerOf(bearer('t-wallet'), { store, nodeAddress: NODE })!;
  assert.equal(wallet.kind, 'wallet');
  assert.equal(wallet.subject, ALICE, 'lower-cased, as the owner field is');
  assert.equal(wallet.orgMember('org_adapter'), false, 'a wallet belongs to no organization');

  const sso = agentCallerOf(bearer('t-sso'), { store, nodeAddress: NODE })!;
  assert.equal(sso.kind, 'principal');
  assert.equal(sso.subject, 'sso:sub-1');
  assert.deepEqual(sso.sso?.orgs, ['org_token', 'org_gone']);
  assert.equal(sso.sso?.org, 'org_token');
  assert.equal(sso.orgMember('org_adapter'), true, 'what the provisioning adapter applied');
  assert.equal(sso.orgMember('org_token'), true, 'what the ID token named, when the adapter has not spoken');
  assert.equal(sso.orgMember('org_gone'), false, 'suspended by the adapter beats the ID token');
  assert.equal(sso.orgMember('org_none'), false);
});

// ───────────────────────────────────────────── the contract shape

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
/** The fixture's keys (ain-integration `fixtures/agent-list-response.json`), in its order; `orgRef`, `description` and `popJwk` (v1.1) are optional. */
const REF_KEYS = ['contract', 'registryIssuer', 'agentId', 'releaseId', 'ownerRef', 'visibility', 'orgRef', 'agentCardUrl', 'endpoint', 'supportedProtocolVersions', 'skills', 'inputModes', 'outputModes', 'uiCapabilities', 'status', 'displayName', 'description', 'updatedAt', 'popJwk'];
const OPTIONAL_REF_KEYS = new Set(['orgRef', 'description', 'pricingRef', 'popJwk']);

function assertAgentRef(ref: AgentRef): void {
  const keys = Object.keys(ref);
  for (const k of keys) assert.ok(REF_KEYS.includes(k) || k === 'pricingRef', `unknown field ${k}`);
  for (const k of REF_KEYS) if (!OPTIONAL_REF_KEYS.has(k)) assert.ok(k in ref, `missing ${k} on ${ref.agentId}`);
  assert.equal(ref.contract, '1.0');
  assert.match(ref.registryIssuer, /^https:\/\/[^/]+$/);
  assert.match(ref.agentId, /^[^\s/\\]+$/);
  assert.ok(ref.releaseId.length >= 1 && ref.releaseId.length <= 128);
  assert.ok(['account', 'org', 'wallet', 'principal'].includes(ref.ownerRef.kind));
  assert.match(ref.ownerRef.issuer, /^https:\/\//);
  assert.ok(['public', 'org', 'private', 'unlisted'].includes(ref.visibility));
  if (ref.visibility === 'org') { assert.ok(ref.orgRef, 'org visibility names the organization'); assert.equal(ref.orgRef!.kind, 'org'); }
  else assert.equal(ref.orgRef, undefined);
  assert.equal(ref.agentCardUrl, `${ref.endpoint}/.well-known/agent-card.json`);
  assert.equal(ref.endpoint, `${ref.registryIssuer}/agents/${ref.agentId}`);
  assert.deepEqual(ref.supportedProtocolVersions, ['0.3.0']);
  assert.ok(ref.skills.length >= 0 && ref.skills.length <= 32);
  for (const s of ref.skills) { assert.ok(s.id && s.name); for (const k of Object.keys(s)) assert.ok(['id', 'name', 'description', 'examples'].includes(k), `skill field ${k}`); }
  assert.ok(ref.inputModes.length >= 1 && ref.outputModes.length >= 1);
  for (const c of ref.uiCapabilities) assert.ok(['streaming', 'cancel', 'image_in', 'image_out', 'audio_in', 'audio_out', 'ainui', 'a2ui_basic', 'file_refs_out'].includes(c), c);
  assert.ok(['active', 'disabled', 'stopped', 'deleted'].includes(ref.status));
  assert.ok(ref.displayName.length >= 1 && ref.displayName.length <= 80);
  if (ref.description !== undefined) assert.ok(ref.description.length <= 500);
  assert.match(ref.updatedAt, ISO);
}

function assertListResponse(body: AgentListResponse): void {
  assert.deepEqual(Object.keys(body).filter((k) => k !== 'cursorExpired'), ['contract', 'asOf', 'nextCursor', 'items']);
  assert.equal(body.contract, '1.0');
  assert.match(body.asOf, ISO);
  assert.ok(body.nextCursor === null || (typeof body.nextCursor === 'string' && body.nextCursor.length >= 1));
  for (const item of body.items) {
    assert.deepEqual(Object.keys(item), ['ref', 'canInvoke']);
    assert.equal(typeof item.canInvoke, 'boolean');
    assertAgentRef(item.ref);
  }
}

test('a hosted agent becomes a ref the way the fixture spells one', () => {
  const spec = specOf({ id: 'gallery-guide', name: 'Uncommon Gallery 안내', description: '전시 자료 폴더를 읽고 방문자 질문에 답한다', version: 3, updatedAt: Date.UTC(2026, 8, 29, 6),
    visibility: 'org', orgId: 'org_comcom', a2ui: true, skills: [{ id: 'guide', name: '전시 안내', description: '작품과 일정을 안내한다' }], media: { transcription: true, image: false } });
  const ref = hostedAgentRef(spec, { registryIssuer: 'https://ainize.ai/', status: { status: 'ready' }, orgIssuer: 'https://auth.comcom.ai' });
  assertAgentRef(ref);
  assert.deepEqual(ref, {
    contract: '1.0', registryIssuer: 'https://ainize.ai', agentId: 'gallery-guide', releaseId: 'v3',
    ownerRef: { kind: 'wallet', issuer: 'https://ainize.ai', subject: ALICE },
    visibility: 'org', orgRef: { kind: 'org', issuer: 'https://auth.comcom.ai', subject: 'org_comcom' },
    agentCardUrl: 'https://ainize.ai/agents/gallery-guide/.well-known/agent-card.json', endpoint: 'https://ainize.ai/agents/gallery-guide',
    supportedProtocolVersions: ['0.3.0'],
    skills: [{ id: 'guide', name: '전시 안내', description: '작품과 일정을 안내한다' }],
    inputModes: ['text/plain', ...HOSTED_AGENT_AUDIO_INPUT_MODES],
    outputModes: ['text/plain', 'application/a2ui+json'],
    uiCapabilities: ['streaming', 'cancel', 'a2ui_basic', 'audio_in'],
    status: 'active', displayName: 'Uncommon Gallery 안내', description: '전시 자료 폴더를 읽고 방문자 질문에 답한다', updatedAt: '2026-09-29T06:00:00.000Z',
  });
  assert.ok(ref.inputModes.length > 1, 'transcription on: audio input modes beside text');
  assert.equal(hostedAgentRef(specOf({ owner: 'sso:sub-1' }), { registryIssuer: ISSUER, status: { status: 'building' }, orgIssuer: ISSUER }).ownerRef.kind, 'principal');
  assert.equal(hostedAgentRef(specOf({}), { registryIssuer: ISSUER, status: { status: 'building' }, orgIssuer: ISSUER }).status, 'disabled');
  assert.equal(hostedAgentRef(specOf({}), { registryIssuer: ISSUER, status: null, orgIssuer: ISSUER }).status, 'stopped');
});

// ───────────────────────────────────────────── the change feed

test('the feed keeps the last N events, pages after a cursor, and says gap when the cursor is too old or not its own', () => {
  const feed = new SharedAgentEvents(3);
  for (let v = 1; v <= 5; v++) feed.append({ type: v === 1 ? 'agent.published' : 'agent.updated', registryIssuer: `${ISSUER}/`, agentId: 'a', version: v, releaseId: `v${v}` }, Date.UTC(2026, 0, v));
  assert.equal(feed.size, 3);
  const all = feed.page(undefined)!;
  assert.equal(all.contract, '1.0');
  assert.deepEqual(all.events.map((e) => e.version), [3, 4, 5]);
  assert.equal(all.nextCursor, 'ev_5');
  assert.equal(all.gap, false, 'no cursor: nothing was promised');
  assert.deepEqual(all.events[0], { kind: 'agent', type: 'agent.updated', eventId: 'evt_3', resourceId: `${ISSUER}#a`, version: 3, occurredAt: '2026-01-03T00:00:00.000Z', releaseId: 'v3' });
  assert.equal(feed.page('ev_2')!.gap, false, 'the cursor is the last evicted event: nothing after it is missing');
  assert.deepEqual(feed.page('ev_2')!.events.map((e) => e.version), [3, 4, 5]);
  assert.equal(feed.page('ev_1')!.gap, true, 'event 2 is gone');
  assert.equal(feed.page('ev_5')!.events.length, 0);
  assert.equal(feed.page('ev_5')!.gap, false);
  assert.equal(feed.page('ev_9')!.gap, true, 'a cursor from before a restart');
  assert.equal(feed.page('bogus'), null);
});

// ───────────────────────────────────────────── over HTTP

interface Harness { base: string; store: HostedAgentStore; feed: SharedAgentEvents; close(): Promise<void> }

async function harness(opts: { rateLimit?: { windowMs: number; max: number }; seed?: (dir: string) => void } = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'shared-agents-'));
  opts.seed?.(dir);
  const store = new HostedAgentStore(join(dir, 'h.json'));
  const secrets = new HostedAgentSecretStore(join(dir, 's.json'), join(dir, 's.key'));
  const registry = () => new InferenceBackendRegistry([{ id: 'llm', modality: 'chat', upstream: 'http://127.0.0.1:9', models: [MODEL], concurrency: 1 }]);
  const gateway = new HostedAgentGateway({ registry, spec: (id) => store.get(id), log: () => {} });
  const host = new HostedAgentHost({ gateway, secrets, docker: null, idleStopMs: 60_000, maxRunning: 2, log: () => {} });
  await host.start(store.list());
  const cfg = { identity: { address: NODE }, agents: [{ id: 'proxied', name: 'Proxied', description: 'From config', upstream: 'http://127.0.0.1:9' }], publicUrl: ISSUER } as unknown as NodeConfig;
  // The caller, from test headers: a wallet address, or an SSO principal with the organizations it belongs to.
  const caller = (req: Request): AgentCaller | null => {
    const address = req.header('x-test-address');
    if (address) return walletCaller(address);
    const principal = req.header('x-test-principal');
    if (!principal) return null;
    return member(principal, (req.header('x-test-orgs') ?? '').split(',').filter(Boolean));
  };
  const feed = new SharedAgentEvents();
  const app = express();
  app.use(express.json());
  app.use(hostedAgentRoutes({ store, secrets, host, registry, caller, events: feed, reserved: (id) => id === 'proxied', publicBase: () => `${ISSUER}/` }));
  app.use(sharedAgentRoutes({ store, host, proxied: () => [{ id: 'proxied', name: 'Proxied', description: 'From config', skills: [], extensions: [], reachable: null, updatedAt: 0 }],
    caller, registryIssuer: () => ISSUER, ssoIssuer: () => SSO_ISSUER, selfAddress: NODE, events: feed, rateLimit: opts.rateLimit }));
  app.use(buildAgents(cfg, { hosted: { host, store } }));
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, store, feed,
    close: async () => { await new Promise<void>((r) => server.close(() => r())); await host.stop(); rmSync(dir, { recursive: true, force: true }); },
  };
}

type Who = { address: string } | { principal: string; orgs: string[] } | null;
const headersFor = (who: Who) => ({
  'content-type': 'application/json',
  ...(who && 'address' in who ? { 'x-test-address': who.address } : {}),
  ...(who && 'principal' in who ? { 'x-test-principal': who.principal, 'x-test-orgs': who.orgs.join(',') } : {}),
});
const P1: Who = { principal: 'sso:p1', orgs: ['org_comcom'] };
const P2: Who = { principal: 'sso:p2', orgs: ['org_comcom', 'org_other'] };
const P3: Who = { principal: 'sso:p3', orgs: ['org_other'] };
const NOBODY: Who = null;

test('visibility over HTTP: who is listed what, unlisted answers by id, private is 404 to others, org needs membership', async () => {
  const h = await harness();
  const api = async (who: Who, path: string, init: { method?: string; body?: unknown } = {}) => {
    const r = await fetch(`${h.base}${path}`, { method: init.method ?? 'GET', headers: headersFor(who), ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) });
    return { status: r.status, body: await r.json() as Record<string, any> };
  };
  const spec = (id: string, over: Record<string, unknown> = {}) => ({ id, name: `Agent ${id}`, description: `about ${id}`, model: MODEL, ...over });
  const ids = (r: { body: { agents: { id: string }[] } }) => r.body.agents.map((a) => a.id).sort();
  try {
    assert.equal((await api({ address: ALICE }, '/api/hosted-agents', { method: 'POST', body: spec('pub') })).status, 201);
    assert.equal((await api({ address: ALICE }, '/api/hosted-agents', { method: 'POST', body: spec('hidden', { visibility: 'private' }) })).status, 201);
    assert.equal((await api({ address: ALICE }, '/api/hosted-agents', { method: 'POST', body: spec('link', { visibility: 'unlisted' }) })).status, 201);
    const walletOrg = await api({ address: ALICE }, '/api/hosted-agents', { method: 'POST', body: spec('nope', { visibility: 'org', orgId: 'org_comcom' }) });
    assert.equal(walletOrg.status, 400, 'a wallet belongs to no organization');
    assert.equal(walletOrg.body.error.code, 'invalid_request');
    const outsider = await api(P1, '/api/hosted-agents', { method: 'POST', body: spec('nope', { visibility: 'org', orgId: 'org_other' }) });
    assert.equal(outsider.status, 400, 'an SSO account shares only with an organization it belongs to');
    assert.match(outsider.body.error.message, /not a member of org_other/);
    const team = await api(P1, '/api/hosted-agents', { method: 'POST', body: spec('team', { visibility: 'org', orgId: 'org_comcom' }) });
    assert.equal(team.status, 201, JSON.stringify(team.body));
    assert.equal(team.body.agent.owner, 'sso:p1');
    assert.equal(team.body.agent.visibility, 'org');
    assert.equal(team.body.agent.org_id, 'org_comcom');

    // listing
    assert.deepEqual(ids(await api(NOBODY, '/api/hosted-agents')), ['pub']);
    assert.deepEqual(ids(await api({ address: ALICE }, '/api/hosted-agents')), ['hidden', 'link', 'pub'], 'the owner sees all of theirs');
    assert.deepEqual(ids(await api({ address: BOB }, '/api/hosted-agents')), ['pub']);
    assert.deepEqual(ids(await api(P1, '/api/hosted-agents')), ['pub', 'team']);
    assert.deepEqual(ids(await api(P2, '/api/hosted-agents')), ['pub', 'team'], 'a member of the organization');
    assert.deepEqual(ids(await api(P3, '/api/hosted-agents')), ['pub'], 'not a member');
    assert.deepEqual(ids(await api({ address: ALICE }, '/api/hosted-agents?mine=1')), ['hidden', 'link', 'pub']);
    const market = await api(NOBODY, '/api/agents');
    assert.deepEqual(ids(market as { body: { agents: { id: string }[] } }), ['proxied', 'pub'], 'the marketplace shows public agents beside the config ones');

    // by id
    const link = await api(NOBODY, '/api/hosted-agents/link');
    assert.equal(link.status, 200, 'unlisted answers to anyone with the id');
    assert.equal(link.body.agent.visibility, 'unlisted');
    assert.equal('systemPrompt' in link.body.agent, false, 'a non-owner sees the listing view only');
    assert.equal((await api(NOBODY, '/api/hosted-agents/hidden')).status, 404);
    assert.equal((await api({ address: BOB }, '/api/hosted-agents/hidden')).status, 404, 'never 403: a private id is not confirmed to exist');
    assert.equal((await api({ address: ALICE }, '/api/hosted-agents/hidden')).status, 200);
    assert.equal((await api(P3, '/api/hosted-agents/team')).status, 404);
    assert.equal((await api(NOBODY, '/api/hosted-agents/team')).status, 404);
    const seenByMember = await api(P2, '/api/hosted-agents/team');
    assert.equal(seenByMember.status, 200);
    assert.equal('systemPrompt' in seenByMember.body.agent, true, 'a member of the organization it is shared with manages it');
    assert.equal('systemPrompt' in (await api(P1, '/api/hosted-agents/team')).body.agent, true, 'the owner sees the whole spec');
    assert.equal((await api(NOBODY, '/api/hosted-agents/nothing')).status, 404);

    // an org member may change it, not remove it or move it; anyone else may do neither
    assert.equal((await api(P2, '/api/hosted-agents/team', { method: 'PUT', body: spec('team', { visibility: 'org', orgId: 'org_comcom' }) })).status, 200);
    assert.equal((await api(P2, '/api/hosted-agents/team', { method: 'PUT', body: spec('team', { visibility: 'public' }) })).status, 403);
    assert.equal((await api(P2, '/api/hosted-agents/team', { method: 'DELETE' })).status, 403);
    assert.equal((await api({ address: BOB }, '/api/hosted-agents/pub', { method: 'PUT', body: spec('pub') })).status, 403);
    assert.equal((await api({ address: BOB }, '/api/hosted-agents/pub', { method: 'DELETE' })).status, 403);
    assert.equal((await api({ address: BOB }, '/api/hosted-agents/hidden/logs')).status, 404, 'a private id is not confirmed to exist');
    const v2 = await api({ address: ALICE }, '/api/hosted-agents/hidden', { method: 'PUT', body: spec('hidden', { visibility: 'public' }) });
    assert.equal(v2.status, 200);
    assert.equal(v2.body.agent.version, 2);
    assert.equal(v2.body.agent.visibility, 'public');
    assert.equal(h.store.get('hidden')?.visibility, 'public', 'persisted');
    assert.deepEqual(ids(await api(NOBODY, '/api/hosted-agents')), ['hidden', 'pub']);
  } finally { await h.close(); }
});

test('organization members manage an org agent: manageable listing, full spec, edits, secrets and logs; only the owner removes or moves it', async () => {
  const h = await harness();
  const api = async (who: Who, path: string, init: { method?: string; body?: unknown } = {}) => {
    const r = await fetch(`${h.base}${path}`, { method: init.method ?? 'GET', headers: headersFor(who), ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) });
    return { status: r.status, body: await r.json() as Record<string, any> };
  };
  const spec = (id: string, over: Record<string, unknown> = {}) => ({ id, name: `Agent ${id}`, model: MODEL, systemPrompt: 'v1', ...over });
  const ids = (r: { body: Record<string, any> }) => (r.body.agents as { id: string }[]).map((a) => a.id).sort();
  try {
    assert.equal((await api(P1, '/api/hosted-agents', { method: 'POST', body: spec('team', { visibility: 'org', orgId: 'org_comcom', secretNames: ['TOKEN'] }) })).status, 201);
    assert.equal((await api(P1, '/api/hosted-agents', { method: 'POST', body: spec('mine', { visibility: 'private' }) })).status, 201);
    assert.equal((await api(P3, '/api/hosted-agents', { method: 'POST', body: spec('elsewhere', { visibility: 'org', orgId: 'org_other' }) })).status, 201);
    assert.equal((await api({ address: ALICE }, '/api/hosted-agents', { method: 'POST', body: spec('wallet') })).status, 201);

    // manageable = own + shared with an organization the caller belongs to
    assert.equal((await api(NOBODY, '/api/hosted-agents?manageable=1')).status, 401);
    assert.deepEqual(ids(await api(P1, '/api/hosted-agents?manageable=1')), ['mine', 'team']);
    const p2 = await api(P2, '/api/hosted-agents?manageable=1');
    assert.deepEqual(ids(p2), ['elsewhere', 'team'], 'member of both organizations, owner of nothing');
    const row = (p2.body.agents as Record<string, any>[]).find((a) => a.id === 'team')!;
    assert.equal(row.can_manage, true);
    assert.equal(row.can_delete, false);
    assert.equal(row.owner, 'sso:p1');
    assert.equal(row.org_id, 'org_comcom');
    assert.equal('systemPrompt' in row, false, 'a listing row, not the spec');
    assert.deepEqual(ids(await api(P3, '/api/hosted-agents?manageable=1')), ['elsewhere']);
    assert.deepEqual(ids(await api({ address: ALICE }, '/api/hosted-agents?manageable=1')), ['wallet'], 'a wallet manages its own only');
    assert.equal((await api(P1, '/api/hosted-agents?manageable=1')).body.agents.find((a: Record<string, any>) => a.id === 'mine').can_delete, true);

    // a member reads the whole spec, edits it, sets its secrets and reads its logs
    const full = await api(P2, '/api/hosted-agents/team');
    assert.equal(full.body.agent.systemPrompt, 'v1');
    const edited = await api(P2, '/api/hosted-agents/team', { method: 'PUT', body: spec('team', { visibility: 'org', orgId: 'org_comcom', secretNames: ['TOKEN'], systemPrompt: 'v2' }) });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.agent.systemPrompt, 'v2');
    assert.equal(edited.body.agent.owner, 'sso:p1', 'the owner does not change hands');
    assert.equal(edited.body.agent.updated_by, 'sso:p2');
    assert.equal(h.store.get('team')?.updatedBy, 'sso:p2');
    assert.equal((await api(P2, '/api/hosted-agents/team/secrets/TOKEN', { method: 'PUT', body: { value: 's3cret' } })).status, 200);
    assert.equal((await api(P2, '/api/hosted-agents/team/logs')).status, 200);

    // …but neither moves it nor removes it
    const moved = await api(P2, '/api/hosted-agents/team', { method: 'PUT', body: spec('team', { visibility: 'org', orgId: 'org_other' }) });
    assert.equal(moved.status, 403, 'even to another organization the member belongs to');
    assert.match(moved.body.error.message, /visibility or organization/);
    assert.equal((await api(P2, '/api/hosted-agents/team', { method: 'PUT', body: spec('team', { visibility: 'private' }) })).status, 403);
    assert.equal((await api(P2, '/api/hosted-agents/team', { method: 'DELETE' })).status, 403);

    // outsiders: hidden is 404, never 403
    for (const path of ['/api/hosted-agents/team', '/api/hosted-agents/team/logs']) assert.equal((await api(P3, path)).status, 404, path);
    assert.equal((await api(P3, '/api/hosted-agents/team', { method: 'PUT', body: spec('team', { visibility: 'org', orgId: 'org_comcom' }) })).status, 404);
    assert.equal((await api(P3, '/api/hosted-agents/team/secrets/TOKEN', { method: 'PUT', body: { value: 'x' } })).status, 404);
    assert.equal((await api(P2, '/api/hosted-agents/mine', { method: 'PUT', body: spec('mine', { visibility: 'private' }) })).status, 404, 'a private agent is its owner\'s alone');

    // the owner still moves and removes it
    assert.equal((await api(P1, '/api/hosted-agents/team', { method: 'PUT', body: spec('team', { visibility: 'private' }) })).status, 200);
    assert.equal((await api(P2, '/api/hosted-agents/team')).status, 404, 'no longer shared: no longer the member\'s');
    assert.equal((await api(P1, '/api/hosted-agents/team', { method: 'DELETE' })).status, 200);
  } finally { await h.close(); }
});

test('the registry: scopes, sign-in, organizations, search, pages and the contract shape', async () => {
  const h = await harness();
  const list = async (who: Who, query: string) => {
    const r = await fetch(`${h.base}/api/shared-agents?${query}`, { headers: headersFor(who) });
    return { status: r.status, body: await r.json() as AgentListResponse & { error?: { code: string; message: string; retryable: boolean } } };
  };
  const create = (who: Who, body: Record<string, unknown>) => fetch(`${h.base}/api/hosted-agents`, { method: 'POST', headers: headersFor(who), body: JSON.stringify({ model: MODEL, ...body }) });
  const ids = (r: { body: AgentListResponse }) => r.body.items.map((i) => i.ref.agentId);
  try {
    assert.equal((await create({ address: ALICE }, { id: 'pub', name: 'Public helper', description: 'Answers briefly' })).status, 201);
    assert.equal((await create({ address: ALICE }, { id: 'hidden', name: 'Hidden', visibility: 'private' })).status, 201);
    assert.equal((await create({ address: ALICE }, { id: 'link', name: 'Link only', visibility: 'unlisted' })).status, 201);
    assert.equal((await create(P1, { id: 'team', name: 'Team agent', description: 'For ComCom', visibility: 'org', orgId: 'org_comcom', a2ui: true })).status, 201);
    assert.equal((await create(P2, { id: 'other', name: 'Other org', visibility: 'org', orgId: 'org_other' })).status, 201);

    // public: anyone, hosted public agents and the config agents
    const pub = await list(NOBODY, 'scope=public');
    assert.equal(pub.status, 200);
    assertListResponse(pub.body);
    assert.deepEqual(ids(pub).sort(), ['proxied', 'pub']);
    const proxied = pub.body.items.find((i) => i.ref.agentId === 'proxied')!;
    assert.equal(proxied.ref.releaseId, 'upstream');
    assert.deepEqual(proxied.ref.ownerRef, { kind: 'wallet', issuer: ISSUER, subject: NODE });
    assert.equal(proxied.ref.status, 'active');
    assert.equal(proxied.canInvoke, true);
    const hosted = pub.body.items.find((i) => i.ref.agentId === 'pub')!;
    assert.equal(hosted.ref.releaseId, 'v1');
    assert.equal(hosted.ref.status, 'active');
    assert.equal(hosted.ref.endpoint, `${ISSUER}/agents/pub`);
    assert.deepEqual(hosted.ref.uiCapabilities, ['streaming', 'cancel']);
    assert.equal(hosted.canInvoke, true);

    // mine: sign in
    const anon = await list(NOBODY, 'scope=mine');
    assert.equal(anon.status, 401);
    assert.deepEqual(anon.body.error, { code: 'auth_required', message: anon.body.error!.message, retryable: false });
    const mine = await list({ address: ALICE }, 'scope=mine');
    assertListResponse(mine.body);
    assert.deepEqual(ids(mine).sort(), ['hidden', 'link', 'pub']);
    assert.deepEqual(mine.body.items.map((i) => i.ref.visibility).sort(), ['private', 'public', 'unlisted']);
    assert.deepEqual(ids(await list({ address: NODE }, 'scope=mine')), ['proxied'], 'the operator owns the config agents');
    assert.deepEqual(ids(await list(P1, 'scope=mine')), ['team']);

    // shared_with_me: org agents of my organizations that are not mine
    assert.deepEqual(ids(await list(P2, 'scope=shared_with_me')), ['team']);
    assert.deepEqual(ids(await list(P1, 'scope=shared_with_me')), [], 'my own is mine, not shared with me');
    assert.deepEqual(ids(await list({ address: ALICE }, 'scope=shared_with_me')), []);
    assert.equal((await list(NOBODY, 'scope=shared_with_me')).status, 401);

    // shared_with_org: an SSO session, a member
    const wallet = await list({ address: ALICE }, 'scope=shared_with_org');
    assert.equal(wallet.status, 403);
    assert.equal(wallet.body.error!.code, 'forbidden');
    assert.equal((await list(P3, 'scope=shared_with_org&org=org_comcom')).status, 403);
    const org = await list(P2, 'scope=shared_with_org');
    assert.equal(org.status, 200);
    assertListResponse(org.body);
    assert.deepEqual(ids(org), ['team'], 'the session\'s selected organization');
    assert.deepEqual(org.body.items[0]!.ref.orgRef, { kind: 'org', issuer: SSO_ISSUER, subject: 'org_comcom' });
    assert.deepEqual(org.body.items[0]!.ref.ownerRef, { kind: 'principal', issuer: ISSUER, subject: 'sso:p1' });
    assert.deepEqual(org.body.items[0]!.ref.uiCapabilities, ['streaming', 'cancel', 'a2ui_basic']);
    assert.deepEqual(org.body.items[0]!.ref.outputModes, ['text/plain', 'application/a2ui+json']);
    assert.deepEqual(ids(await list(P2, 'scope=shared_with_org&org=org_other')), ['other']);
    assert.deepEqual(ids(await list(P2, 'scope=mine&org=org_other')), ['other'], 'org narrows any scope');

    // search, sort, pages
    assert.deepEqual(ids(await list({ address: ALICE }, 'scope=mine&q=HIDD')), ['hidden'], 'case-insensitive, over the name');
    assert.deepEqual(ids(await list(NOBODY, 'scope=public&q=briefly')), ['pub'], 'and over the description');
    const sorted = await list({ address: ALICE }, 'scope=mine');
    const at = sorted.body.items.map((i) => i.ref.updatedAt);
    assert.deepEqual(at, [...at].sort().reverse(), 'newest first');
    const page1 = await list({ address: ALICE }, 'scope=mine&limit=2');
    assert.equal(page1.body.items.length, 2);
    assert.ok(page1.body.nextCursor);
    const page2 = await list({ address: ALICE }, `scope=mine&limit=2&cursor=${encodeURIComponent(page1.body.nextCursor!)}`);
    assert.equal(page2.body.items.length, 1);
    assert.equal(page2.body.nextCursor, null);
    assert.deepEqual([...ids(page1), ...ids(page2)].sort(), ['hidden', 'link', 'pub']);

    // malformed
    assert.equal((await list(NOBODY, 'scope=everything')).status, 400);
    assert.equal((await list(NOBODY, '')).status, 400);
    assert.equal((await list(NOBODY, 'scope=public&limit=0')).status, 400);
    assert.equal((await list(NOBODY, 'scope=public&limit=201')).status, 400);
    assert.equal((await list(NOBODY, 'scope=public&cursor=%00')).status, 400);
  } finally { await h.close(); }
});

test('the feed never names a private or unlisted agent to anyone but its owner; an org agent only to members; a public→private change is told to everyone who saw it', async () => {
  const h = await harness();
  const events = async (who: Parameters<typeof headersFor>[0] | null) => {
    const r = await fetch(`${h.base}/api/shared-agents/events`, who ? { headers: headersFor(who) } : {});
    return (await r.json() as AgentEventPage).events.map((e) => `${e.type}:${e.resourceId.split('#')[1]}`);
  };
  const send = (who: Parameters<typeof headersFor>[0], method: string, path: string, body?: Record<string, unknown>) =>
    fetch(`${h.base}${path}`, { method, headers: headersFor(who), ...(body ? { body: JSON.stringify({ model: MODEL, ...body }) } : {}) });
  try {
    assert.equal((await send({ address: ALICE }, 'POST', '/api/hosted-agents', { id: 'pub', name: 'P' })).status, 201);
    assert.equal((await send({ address: ALICE }, 'POST', '/api/hosted-agents', { id: 'priv', name: 'S', visibility: 'private' })).status, 201);
    assert.equal((await send({ address: ALICE }, 'POST', '/api/hosted-agents', { id: 'unl', name: 'U', visibility: 'unlisted' })).status, 201);
    assert.deepEqual(await events(null), ['agent.published:pub'], 'anonymous learns only about the public agent');
    assert.deepEqual(await events({ address: BOB }), ['agent.published:pub'], 'another wallet learns nothing more');
    assert.deepEqual(await events({ address: ALICE }), ['agent.published:pub', 'agent.published:priv', 'agent.published:unl'], 'the owner sees all of hers');
    assert.equal((await send({ address: ALICE }, 'PUT', '/api/hosted-agents/pub', { id: 'pub', name: 'P', visibility: 'private' })).status, 200);
    assert.deepEqual(await events(null), ['agent.published:pub', 'agent.unpublished:pub'], 'whoever saw it public is told it went away');
    assert.equal((await send({ address: ALICE }, 'DELETE', '/api/hosted-agents/priv')).status, 200);
    assert.deepEqual((await events(null)).filter((e) => e.endsWith(':priv')), [], 'deleting a private agent tells nobody else');
  } finally { await h.close(); }
});

test('the feed over HTTP: create, update, visibility withdrawn, delete — and a cursor that pages it', async () => {
  const h = await harness();
  const events = async (query = '') => {
    const r = await fetch(`${h.base}/api/shared-agents/events${query}`);
    return { status: r.status, body: await r.json() as AgentEventPage };
  };
  const send = (method: string, path: string, body?: Record<string, unknown>) =>
    fetch(`${h.base}${path}`, { method, headers: headersFor({ address: ALICE }), ...(body ? { body: JSON.stringify({ model: MODEL, ...body }) } : {}) });
  try {
    assert.deepEqual((await events()).body, { contract: '1.0', events: [], nextCursor: 'ev_0', gap: false });
    assert.equal((await send('POST', '/api/hosted-agents', { id: 'a', name: 'A' })).status, 201);
    assert.equal((await send('PUT', '/api/hosted-agents/a', { id: 'a', name: 'A2' })).status, 200);
    assert.equal((await send('PUT', '/api/hosted-agents/a', { id: 'a', name: 'A2', visibility: 'private' })).status, 200);
    assert.equal((await send('PUT', '/api/hosted-agents/a', { id: 'a', name: 'A2', visibility: 'public' })).status, 200);
    assert.equal((await send('DELETE', '/api/hosted-agents/a')).status, 200);
    const all = await events();
    assert.equal(all.status, 200);
    assert.equal(all.body.contract, '1.0');
    assert.equal(all.body.gap, false);
    assert.equal(all.body.nextCursor, 'ev_5');
    assert.deepEqual(all.body.events.map((e) => [e.type, e.version, e.releaseId ?? null]), [
      ['agent.published', 1, 'v1'], ['agent.updated', 2, 'v2'], ['agent.unpublished', 3, 'v3'], ['agent.published', 4, 'v4'], ['agent.deleted', 5, null],
    ]);
    for (const e of all.body.events) {
      assert.equal(e.kind, 'agent');
      assert.equal(e.resourceId, `${ISSUER}#a`);
      assert.match(e.eventId, /^evt_\d+$/);
      assert.match(e.occurredAt, ISO);
    }
    const versions = all.body.events.map((e) => e.version);
    assert.deepEqual(versions, [...versions].sort((x, y) => x - y), 'strictly increasing per resource, the delete included');
    const after3 = await events('?cursor=ev_3');
    assert.deepEqual(after3.body.events.map((e) => e.version), [4, 5]);
    assert.equal(after3.body.gap, false);
    const caughtUp = await events(`?cursor=${all.body.nextCursor}`);
    assert.deepEqual(caughtUp.body, { contract: '1.0', events: [], nextCursor: 'ev_5', gap: false });
    assert.equal((await events('?cursor=ev_50')).body.gap, true, 'a cursor from before a restart');
    assert.equal((await events('?cursor=nonsense')).status, 400);
  } finally { await h.close(); }
});

test('a spec stored without visibility is public over HTTP too, and the registry rate-limits with the contract\'s body', async () => {
  const legacy: Omit<HostedAgentSpec, 'visibility' | 'orgId'> = { id: 'old', name: 'Old timer', description: '', model: MODEL, systemPrompt: '', mode: 'prompt', files: {}, a2ui: false, allowedHosts: [], secretNames: [], skills: [], owner: ALICE, version: 4, createdAt: 1, updatedAt: 2 };
  const h = await harness({ rateLimit: { windowMs: 60_000, max: 2 }, seed: (dir) => writeFileSync(join(dir, 'h.json'), JSON.stringify({ agents: [legacy] })) });
  try {
    assert.equal('visibility' in h.store.get('old')!, false, 'stored as it was');
    const pub = await (await fetch(`${h.base}/api/shared-agents?scope=public`)).json() as AgentListResponse;
    assertListResponse(pub);
    const old = pub.items.find((i) => i.ref.agentId === 'old')!;
    assert.equal(old.ref.visibility, 'public');
    assert.equal(old.ref.releaseId, 'v4');
    assert.equal(old.ref.updatedAt, new Date(2).toISOString());
    assert.equal((await fetch(`${h.base}/api/hosted-agents/old`)).status, 200);
    // the second registry request is the last allowed
    assert.equal((await fetch(`${h.base}/api/shared-agents?scope=public`)).status, 200);
    const limited = await fetch(`${h.base}/api/shared-agents/events`);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
    const body = await limited.json() as { error: { code: string; retryable: boolean; retryAfterSeconds: number } };
    assert.equal(body.error.code, 'rate_limited');
    assert.equal(body.error.retryable, true);
    assert.ok(body.error.retryAfterSeconds >= 1);
    assert.equal((await fetch(`${h.base}/api/hosted-agents/old`)).status, 200, 'the hosted-agent routes are not behind the registry\'s limiter');
  } finally { await h.close(); }
});
