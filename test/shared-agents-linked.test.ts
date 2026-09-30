/**
 * The shared registry across every kind of agent the node lists: linked agents share the way hosted ones do, an
 * organization API key is a caller, the operator may put any agent into an organization's list, and a config
 * agent's sharing comes from config.json.
 *
 *   node --test --import tsx test/shared-agents-linked.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import express, { type Request } from 'express';
import type { NodeConfig } from '@ainize/core';
import { agentAdverts, buildAgents, proxiedAgentSummaries } from '../src/agents.js';
import { InferenceBackendRegistry } from '../src/inference-backends.js';
import { HostedAgentGateway } from '../src/hosted-agent-gateway.js';
import { HostedAgentHost } from '../src/hosted-agent-host.js';
import { HostedAgentSecretStore } from '../src/hosted-agent-secrets.js';
import { HostedAgentStore } from '../src/hosted-agent-store.js';
import { hostedAgentRoutes } from '../src/hosted-agent-routes.js';
import { LinkedAgentStore, linkedAgentInput } from '../src/linked-agent-store.js';
import { linkedAgentRoutes } from '../src/linked-agent-routes.js';
import { agentCallerOf, apiKeyCaller, SharedAgentEvents, sharedAgentRoutes, walletCaller, withOrganizations, resolveOrganization, type AgentCaller, type AgentEventPage, type AgentListResponse, type AgentRef } from '../src/shared-agents.js';
import { Store } from '../src/store.js';
import { OrganizationStore } from '../src/organization-store.js';

const MODEL = 'Test-Chat-1';
const ALICE = '0x00000000000000000000000000000000000a11ce';
const BOB = '0x0000000000000000000000000000000000000b0b';
const NODE = '0x1111111111111111111111111111111111111111';
const OPERATOR2 = '0x2222222222222222222222222222222222222222';
const SSO_ISSUER = 'https://auth.example';
const ISSUER = 'https://node.example';
const COMCOM = 'org_comcom';

const member = (subject: string, orgs: string[]): AgentCaller =>
  ({ subject, kind: 'principal', sso: { iss: SSO_ISSUER, sub: subject.slice(4), org: orgs[0] ?? null, orgs }, orgMember: (o) => orgs.includes(o) });

// ───────────────────────────────────────────── the input and the API-key caller

test('a linked agent input takes the same sharing a hosted one does, public by default', () => {
  const base = { id: 'x', upstream: 'https://agent.example/a2a' };
  assert.equal(linkedAgentInput.parse(base).visibility, 'public');
  assert.equal(linkedAgentInput.parse(base).orgId, null);
  assert.equal(linkedAgentInput.safeParse({ ...base, visibility: 'org' }).success, false, 'org names the organization');
  assert.equal(linkedAgentInput.safeParse({ ...base, visibility: 'org', orgId: COMCOM }).success, true);
  assert.equal(linkedAgentInput.safeParse({ ...base, visibility: 'public', orgId: COMCOM }).success, false);
});

test('an organization API key is a caller for that organization alone; a personal key for none; a site session still wins', () => {
  const store = new Store(':memory:');
  store.putSession('t-wallet', 3600_000, { subject: ALICE, scheme: 'ain' });
  const keys = { recordForKey: (k: string) => k === 'ainize-sk-org' ? { address: 'sso:sub-9', orgId: COMCOM } : k === 'ainize-sk-me' ? { address: BOB, orgId: null } : null };
  const req = (auth: string | null) => ({ cookies: {}, header: (n: string) => (n.toLowerCase() === 'authorization' && auth ? auth : undefined) }) as unknown as Request;

  const org = agentCallerOf(req('Bearer ainize-sk-org'), { store, nodeAddress: NODE, keys })!;
  assert.equal(org.subject, 'sso:sub-9');
  assert.equal(org.kind, 'principal');
  assert.equal(org.keyOrg, COMCOM);
  assert.equal(org.orgMember(COMCOM), true);
  assert.equal(org.orgMember('org_other'), false);
  assert.equal(org.sso, null, 'a key is not a session; it has no ID token behind it');

  const personal = agentCallerOf(req('Bearer ainize-sk-me'), { store, nodeAddress: NODE, keys })!;
  assert.equal(personal.subject, BOB);
  assert.equal(personal.kind, 'wallet');
  assert.equal(personal.keyOrg, null);
  assert.equal(personal.orgMember(COMCOM), false);

  assert.equal(agentCallerOf(req('Bearer ainize-sk-unknown'), { store, nodeAddress: NODE, keys }), null);
  assert.equal(agentCallerOf(req('Bearer ainize-sk-org'), { store, nodeAddress: NODE }), null, 'no key store: a key is nobody');
  assert.equal(agentCallerOf(req('Bearer t-wallet'), { store, nodeAddress: NODE, keys })!.subject, ALICE, 'a session token is read first');
  assert.equal(apiKeyCaller({ address: ALICE.toUpperCase(), orgId: null }).subject, ALICE, 'wallets fold to lower case like every owner field');
});

// ───────────────────────────────────────────── over HTTP, every kind of agent at once

interface Harness { base: string; hosted: HostedAgentStore; linked: LinkedAgentStore; feed: SharedAgentEvents; cfg: NodeConfig; close(): Promise<void> }

async function harness(linkOrganizations = false): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'shared-linked-'));
  const orgs = new OrganizationStore(join(dir, 'orgs.json'));
  if (linkOrganizations) orgs.create({ id: 'comcom', name: 'ComCom', description: '', readme: '', domains: [], domainRole: 'write' }, { principal: 'sso:p1', email: null, name: null, ssoOrgIds: [COMCOM] });
  const hosted = new HostedAgentStore(join(dir, 'h.json'));
  const linked = new LinkedAgentStore(join(dir, 'l.json'));
  const secrets = new HostedAgentSecretStore(join(dir, 's.json'), join(dir, 's.key'));
  const registry = () => new InferenceBackendRegistry([{ id: 'llm', modality: 'chat', upstream: 'http://127.0.0.1:9', models: [MODEL], concurrency: 1 }]);
  const gateway = new HostedAgentGateway({ registry, spec: (id) => hosted.get(id), log: () => {} });
  const host = new HostedAgentHost({ gateway, secrets, docker: null, idleStopMs: 60_000, maxRunning: 2, log: () => {} });
  await host.start(hosted.list());
  // Two config agents: one as every config agent was, one the operator shared with ComCom in config.json.
  const cfg = {
    identity: { address: NODE }, publicUrl: ISSUER, operatorAddresses: [OPERATOR2],
    agents: [
      { id: 'proxied', name: 'Proxied', description: 'From config', upstream: 'http://127.0.0.1:9' },
      { id: 'desk', name: 'Ops desk', description: 'The operations desk', upstream: 'http://127.0.0.1:9', visibility: 'org', orgId: COMCOM },
    ],
  } as unknown as NodeConfig;
  const rawCaller = (req: Request): AgentCaller | null => {
    const address = req.header('x-test-address');
    if (address) return walletCaller(address);
    const key = req.header('x-test-key-org');
    if (key) return apiKeyCaller({ address: req.header('x-test-key-owner') ?? 'sso:key-owner', orgId: key === '-' ? null : key });
    const principal = req.header('x-test-principal');
    if (!principal) return null;
    return member(principal, (req.header('x-test-orgs') ?? '').split(',').filter(Boolean));
  };
  const caller = (req: Request) => { const c = rawCaller(req); return c && linkOrganizations ? withOrganizations(c, orgs) : c; };
  const isOperator = (req: Request) => { const a = req.header('x-test-address')?.toLowerCase(); return a === NODE || a === OPERATOR2; };
  const feed = new SharedAgentEvents();
  const probe = async (upstream: string) => upstream.includes('down') ? { error: 'ECONNREFUSED' } : { card: { name: 'Card Name', description: 'From the card', skills: [{ id: 's1', name: 'Skill one' }] } };
  const app = express();
  app.use(express.json());
  app.use(hostedAgentRoutes({ store: hosted, secrets, host, registry, caller, events: feed, reserved: (id) => (cfg.agents ?? []).some((a) => a.id === id) || linked.has(id), publicBase: () => `${ISSUER}/` }));
  app.use(linkedAgentRoutes({ store: linked, caller, events: feed, reserved: (id) => (cfg.agents ?? []).some((a) => a.id === id) || hosted.get(id) !== null, publicBase: () => ISSUER, probe, allowPrivateUpstream: true }));
  app.use(sharedAgentRoutes({ store: hosted, host, proxied: () => proxiedAgentSummaries(cfg, linked), caller, registryIssuer: () => ISSUER, ssoIssuer: () => SSO_ISSUER, selfAddress: NODE, events: feed, linked, isOperator, resolveOrgId: (id) => resolveOrganization(orgs, id)?.id ?? id }));
  app.use(buildAgents(cfg, { hosted: { host, store: hosted }, linked }));
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hosted, linked, feed, cfg,
    close: async () => { await new Promise<void>((r) => server.close(() => r())); await host.stop(); rmSync(dir, { recursive: true, force: true }); },
  };
}

type Who = { address: string } | { principal: string; orgs: string[] } | { keyOrg: string | null; owner?: string } | null;
const headersFor = (who: Who) => ({
  'content-type': 'application/json',
  ...(who && 'address' in who ? { 'x-test-address': who.address } : {}),
  ...(who && 'principal' in who ? { 'x-test-principal': who.principal, 'x-test-orgs': who.orgs.join(',') } : {}),
  ...(who && 'keyOrg' in who ? { 'x-test-key-org': who.keyOrg ?? '-', ...(who.owner ? { 'x-test-key-owner': who.owner } : {}) } : {}),
});
const P1: Who = { principal: 'sso:p1', orgs: [COMCOM] };
const P3: Who = { principal: 'sso:p3', orgs: ['org_other'] };
const TEAMS_KEY: Who = { keyOrg: COMCOM, owner: 'sso:teams-bot' };
const PERSONAL_KEY: Who = { keyOrg: null, owner: BOB };
const OPERATOR: Who = { address: NODE };
const NOBODY: Who = null;

const api = (base: string) => async (who: Who, path: string, init: { method?: string; body?: unknown } = {}) => {
  const r = await fetch(`${base}${path}`, { method: init.method ?? 'GET', headers: headersFor(who), ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) });
  return { status: r.status, body: await r.json() as Record<string, any> };
};
const listed = (r: { body: AgentListResponse }) => r.body.items.map((i) => i.ref.agentId).sort();
const refOf = (r: { body: AgentListResponse }, id: string): AgentRef => r.body.items.find((i) => i.ref.agentId === id)!.ref;

test('linked agents share like hosted ones: who registers with what, who is listed what, the marketplace and gossip stay public-only', async () => {
  const h = await harness();
  const call = api(h.base);
  const link = (id: string, over: Record<string, unknown> = {}) => ({ id, upstream: `https://agents.example/${id}`, ...over });
  try {
    // registering: a wallet cannot share with an organization; an SSO member and an organization key can, for theirs alone
    assert.equal((await call({ address: ALICE }, '/api/linked-agents', { method: 'POST', body: link('pub-l') })).status, 201);
    const walletOrg = await call({ address: ALICE }, '/api/linked-agents', { method: 'POST', body: link('nope', { visibility: 'org', orgId: COMCOM }) });
    assert.equal(walletOrg.status, 400);
    assert.match(walletOrg.body.error.message, /wallet belongs to none/);
    assert.match((await call(P3, '/api/linked-agents', { method: 'POST', body: link('nope', { visibility: 'org', orgId: COMCOM }) })).body.error.message, /not a member of org_comcom/);
    const team = await call(P1, '/api/linked-agents', { method: 'POST', body: link('team-l', { visibility: 'org', orgId: COMCOM }) });
    assert.equal(team.status, 201, JSON.stringify(team.body));
    assert.equal(team.body.agent.owner, 'sso:p1');
    assert.equal(team.body.agent.visibility, 'org');
    assert.equal(team.body.agent.org_id, COMCOM);
    assert.equal(team.body.agent.name, 'Card Name', 'no name given: the card\'s');
    const byKey = await call(TEAMS_KEY, '/api/linked-agents', { method: 'POST', body: link('teams-built', { name: 'Built in Teams', visibility: 'org', orgId: COMCOM }) });
    assert.equal(byKey.status, 201, JSON.stringify(byKey.body));
    assert.equal(byKey.body.agent.owner, 'sso:teams-bot', 'an organization key registers as the account that issued it');
    assert.equal((await call(TEAMS_KEY, '/api/linked-agents', { method: 'POST', body: link('nope', { visibility: 'org', orgId: 'org_other' }) })).status, 400, 'and only for its own organization');
    assert.equal((await call(PERSONAL_KEY, '/api/linked-agents', { method: 'POST', body: link('nope', { visibility: 'org', orgId: COMCOM }) })).status, 400, 'a personal key belongs to none');
    assert.equal((await call({ address: ALICE }, '/api/linked-agents', { method: 'POST', body: link('secret-l', { visibility: 'private' }) })).status, 201);

    // listing /api/linked-agents
    const ids = (r: { body: { agents: { id: string }[] } }) => r.body.agents.map((a) => a.id).sort();
    assert.deepEqual(ids(await call(NOBODY, '/api/linked-agents')), ['pub-l']);
    assert.deepEqual(ids(await call({ address: ALICE }, '/api/linked-agents')), ['pub-l', 'secret-l'], 'the owner sees theirs');
    assert.deepEqual(ids(await call(P1, '/api/linked-agents')), ['pub-l', 'team-l', 'teams-built'], 'a member sees the organization\'s');
    assert.deepEqual(ids(await call(TEAMS_KEY, '/api/linked-agents')), ['pub-l', 'team-l', 'teams-built'], 'so does the organization key');
    assert.deepEqual(ids(await call(P3, '/api/linked-agents')), ['pub-l']);
    assert.equal((await call(NOBODY, '/api/linked-agents/secret-l')).status, 404, 'a private id is not confirmed to exist');
    assert.equal((await call(P3, '/api/linked-agents/team-l')).status, 404);
    assert.equal('upstream' in (await call(P1, '/api/linked-agents/teams-built')).body.agent, false, 'a member sees the listing, not where it runs');
    assert.equal('upstream' in (await call(TEAMS_KEY, '/api/linked-agents/teams-built')).body.agent, true, 'the registrant sees the upstream');

    // the marketplace and gossip carry public agents only — config `desk` was shared with ComCom in config.json
    const market = await call(NOBODY, '/api/agents');
    assert.deepEqual((market.body.agents as { id: string }[]).map((a) => a.id).sort(), ['proxied', 'pub-l']);
    assert.deepEqual(agentAdverts(h.cfg, ISSUER, undefined, h.linked).map((a) => a.id).sort(), ['proxied', 'pub-l']);

    // the registry, by scope
    const pub = await call(NOBODY, '/api/shared-agents?scope=public');
    assert.deepEqual(listed(pub as { body: AgentListResponse }), ['proxied', 'pub-l']);
    const pubL = refOf(pub as { body: AgentListResponse }, 'pub-l');
    assert.equal(pubL.releaseId, 'linked-v1');
    assert.deepEqual(pubL.ownerRef, { kind: 'wallet', issuer: ISSUER, subject: ALICE });
    assert.equal(pubL.displayName, 'Card Name');
    // skills come from the card the marketplace list probes (agents.ts health), not from the registration probe: unprobed → the chat fallback
    assert.deepEqual(pubL.skills, [{ id: 'chat', name: 'Card Name' }]);
    assert.equal(refOf(pub as { body: AgentListResponse }, 'proxied').releaseId, 'upstream');

    const org = await call(P1, `/api/shared-agents?scope=shared_with_org`);
    assert.equal(org.status, 200, JSON.stringify(org.body));
    assert.deepEqual(listed(org as { body: AgentListResponse }), ['desk', 'team-l', 'teams-built'], 'hosted, linked and config agents shared with the organization, in one list');
    const desk = refOf(org as { body: AgentListResponse }, 'desk');
    assert.equal(desk.visibility, 'org');
    assert.deepEqual(desk.orgRef, { kind: 'org', issuer: SSO_ISSUER, subject: COMCOM });
    assert.deepEqual(desk.ownerRef, { kind: 'wallet', issuer: ISSUER, subject: NODE }, 'a config agent is the operator\'s');
    assert.equal(desk.releaseId, 'upstream');
    assert.deepEqual(refOf(org as { body: AgentListResponse }, 'team-l').orgRef, { kind: 'org', issuer: SSO_ISSUER, subject: COMCOM });
    for (const i of org.body.items as AgentListResponse['items']) assert.equal(i.canInvoke, true);

    // the organization key lists the same set: what AIN Teams reads
    const viaKey = await call(TEAMS_KEY, '/api/shared-agents?scope=shared_with_org');
    assert.equal(viaKey.status, 200, JSON.stringify(viaKey.body));
    assert.deepEqual(listed(viaKey as { body: AgentListResponse }), ['desk', 'team-l', 'teams-built']);
    assert.deepEqual(listed(await call(TEAMS_KEY, '/api/shared-agents?scope=mine') as { body: AgentListResponse }), ['teams-built']);
    assert.deepEqual(listed(await call(TEAMS_KEY, '/api/shared-agents?scope=shared_with_me') as { body: AgentListResponse }), ['desk', 'team-l']);
    const personal = await call(PERSONAL_KEY, '/api/shared-agents?scope=shared_with_org');
    assert.equal(personal.status, 403, 'a personal key speaks for no organization');
    assert.equal((await call(TEAMS_KEY, '/api/shared-agents?scope=shared_with_org&org=org_other')).status, 403);
    assert.equal((await call(P3, '/api/shared-agents?scope=shared_with_org&org=org_comcom')).status, 403);
    assert.deepEqual(listed(await call({ address: ALICE }, '/api/shared-agents?scope=mine') as { body: AgentListResponse }), ['pub-l', 'secret-l']);
    assert.deepEqual(listed(await call(OPERATOR, '/api/shared-agents?scope=mine') as { body: AgentListResponse }), ['desk', 'proxied'], 'the operator owns the config agents');

    // the feed: the organization learns of its agents, the public of the public one
    const events = async (who: Who) => ((await call(who, '/api/shared-agents/events')).body as AgentEventPage).events.map((e) => `${e.type}:${e.resourceId.split('#')[1]}:${e.releaseId ?? '-'}`);
    assert.deepEqual(await events(NOBODY), ['agent.published:pub-l:linked-v1']);
    assert.deepEqual(await events(TEAMS_KEY), ['agent.published:pub-l:linked-v1', 'agent.published:team-l:linked-v1', 'agent.published:teams-built:linked-v1']);

    // …and an org agent's address answers to anyone who holds it: visibility is about listing, not the wire
    assert.notEqual((await fetch(`${h.base}/agents/team-l/.well-known/agent-card.json`)).status, 404, 'the address resolves (the fake upstream is not there to answer, which is a 502, not a 404)');
  } finally { await h.close(); }
});

test('who changes who sees an agent: the owner within their organizations, the operator anywhere; config agents are the file\'s', async () => {
  const h = await harness();
  const call = api(h.base);
  const share = (who: Who, id: string, body: Record<string, unknown>) => call(who, `/api/shared-agents/${id}/visibility`, { method: 'PUT', body });
  try {
    assert.equal((await call({ address: ALICE }, '/api/hosted-agents', { method: 'POST', body: { id: 'h1', name: 'Hosted one', model: MODEL } })).status, 201);
    assert.equal((await call({ address: ALICE }, '/api/linked-agents', { method: 'POST', body: { id: 'l1', name: 'Linked one', upstream: 'https://agents.example/l1' } })).status, 201);

    assert.equal((await share(NOBODY, 'h1', { visibility: 'private' })).status, 401);
    assert.equal((await share({ address: BOB }, 'h1', { visibility: 'private' })).status, 403, 'not the owner, not the operator');
    const wallet = await share({ address: ALICE }, 'h1', { visibility: 'org', orgId: COMCOM });
    assert.equal(wallet.status, 403, 'the owner is a wallet: it belongs to no organization');
    assert.match(wallet.body.error.message, /wallet belongs to none/);
    assert.equal((await share({ address: ALICE }, 'h1', { visibility: 'org' })).status, 400, 'org names the organization');
    assert.equal((await share({ address: ALICE }, 'h1', { visibility: 'secret' })).status, 400);

    // the owner: private, then unlisted — the feed tells the public it went away
    const priv = await share({ address: ALICE }, 'h1', { visibility: 'private' });
    assert.equal(priv.status, 200, JSON.stringify(priv.body));
    assert.equal(priv.body.agent.visibility, 'private');
    assert.equal(priv.body.agent.releaseId, 'v2');
    assert.equal(h.hosted.get('h1')?.visibility, 'private', 'persisted');
    assert.equal((await call(NOBODY, '/api/hosted-agents/h1')).status, 404);

    // the operator: puts Alice's hosted agent and her linked agent into ComCom's list, member of it or not
    const opH = await share(OPERATOR, 'h1', { visibility: 'org', orgId: COMCOM });
    assert.equal(opH.status, 200, JSON.stringify(opH.body));
    assert.deepEqual(opH.body.agent.orgRef, { kind: 'org', issuer: SSO_ISSUER, subject: COMCOM });
    assert.equal(opH.body.agent.releaseId, 'v3');
    assert.deepEqual(opH.body.agent.ownerRef, { kind: 'wallet', issuer: ISSUER, subject: ALICE }, 'sharing does not change whose it is');
    const opL = await share({ address: OPERATOR2 }, 'l1', { visibility: 'org', orgId: COMCOM });
    assert.equal(opL.status, 200, JSON.stringify(opL.body));
    assert.equal(opL.body.agent.releaseId, 'linked-v2');
    assert.equal(opL.body.agent.visibility, 'org');
    assert.equal(h.linked.get('l1')?.orgId, COMCOM);
    assert.deepEqual(listed(await call(P1, '/api/shared-agents?scope=shared_with_org') as { body: AgentListResponse }), ['desk', 'h1', 'l1']);
    assert.deepEqual(listed(await call(TEAMS_KEY, '/api/shared-agents?scope=shared_with_org') as { body: AgentListResponse }), ['desk', 'h1', 'l1']);
    assert.deepEqual(listed(await call(NOBODY, '/api/shared-agents?scope=public') as { body: AgentListResponse }), ['proxied'], 'and they left the public list');
    assert.deepEqual(((await call(NOBODY, '/api/agents')).body.agents as { id: string }[]).map((a) => a.id), ['proxied']);

    // back to public by the operator; the owner may still do their own
    assert.equal((await share(OPERATOR, 'l1', { visibility: 'public' })).status, 200);
    assert.equal(h.linked.get('l1')?.orgId, null, 'leaving org clears the organization');
    assert.equal((await share({ address: ALICE }, 'l1', { visibility: 'unlisted' })).status, 200);

    // config agents: the file's, with the field named
    const cfgAgent = await share(OPERATOR, 'desk', { visibility: 'public' });
    assert.equal(cfgAgent.status, 400);
    assert.equal(cfgAgent.body.error.code, 'invalid_request');
    assert.match(cfgAgent.body.error.message, /config\.json/);
    assert.equal((await share({ address: BOB }, 'desk', { visibility: 'public' })).status, 410, 'to anyone else a config agent is like any agent they may not touch');
    // in the contract's vocabulary "no such agent" is resource_deleted (410) — the same answer for missing and for hidden
    assert.equal((await share(OPERATOR, 'nothing', { visibility: 'public' })).status, 410);
    assert.equal((await share({ address: BOB }, 'h1', { visibility: 'public' })).status, 410, 'an agent Bob cannot see is not confirmed to exist');

    // the feed told the story in order — to a member of the organization it was shared with; the operator is not one
    const feedFor = async (who: Who) => ((await call(who, '/api/shared-agents/events')).body as AgentEventPage).events.filter((e) => e.resourceId.endsWith('#h1')).map((e) => `${e.type}:${e.releaseId}`);
    assert.deepEqual(await feedFor(P1), ['agent.published:v1', 'agent.unpublished:v2', 'agent.published:v3']);
    assert.deepEqual(await feedFor(OPERATOR), ['agent.published:v1', 'agent.unpublished:v2'], 'the operator changed it but is no member: the feed does not name an org agent to outsiders');
  } finally { await h.close(); }
});


test('Teams organization keys list canonical and SSO-alias agents together, without other organizations', async () => {
  const h = await harness(true);
  const call = api(h.base);
  try {
    for (const [id, orgId] of [['slug-agent', 'comcom'], ['sso-agent', COMCOM], ['other-agent', 'org_other']]) {
      const who = orgId === 'org_other' ? P3 : P1;
      const r = await call(who, '/api/linked-agents', { method: 'POST', body: { id, name: id, upstream: 'https://agents.example/' + id, visibility: 'org', orgId } });
      assert.equal(r.status, 201, JSON.stringify(r.body));
    }
    for (const who of [TEAMS_KEY, P1]) {
      for (const query of ['', '&org=comcom', '&org=' + COMCOM]) {
        const r = await call(who, '/api/shared-agents?scope=shared_with_org' + query);
        assert.equal(r.status, 200);
        assert.deepEqual(listed(r as any), ['desk', 'slug-agent', 'sso-agent']);
      }
    }
    const other = await call(P3, '/api/shared-agents?scope=shared_with_org');
    assert.deepEqual(listed(other as any), ['other-agent']);
    assert.equal((await call(P3, '/api/shared-agents?scope=shared_with_org&org=comcom')).status, 403);
    assert.equal((await call(NOBODY, '/api/shared-agents?scope=shared_with_org&org=comcom')).status, 401);
  } finally { await h.close(); }
});
