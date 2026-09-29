/**
 * Organizations on the shared registry (shared-agents.ts `withOrganizations`): an agent's `orgId` names an ainize
 * organization (or an AIN SSO org id that one links), and the caller's role there decides what they may do with it —
 * see any role, share into it contributor, change its agents write, remove or re-share them admin (or be the owner).
 * An `orgId` no ainize organization claims keeps #40/#41's answer: an AIN SSO member of it, or its API key, is write.
 *
 *   node --test --import tsx test/org-roles.test.ts
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
import { buildAgents } from '../src/agents.js';
import { InferenceBackendRegistry } from '../src/inference-backends.js';
import { HostedAgentGateway } from '../src/hosted-agent-gateway.js';
import { HostedAgentHost } from '../src/hosted-agent-host.js';
import { HostedAgentSecretStore } from '../src/hosted-agent-secrets.js';
import { HostedAgentStore } from '../src/hosted-agent-store.js';
import { hostedAgentRoutes } from '../src/hosted-agent-routes.js';
import { hostedAgentVisibilityOf } from '../src/hosted-agent-types.js';
import { LinkedAgentStore } from '../src/linked-agent-store.js';
import { linkedAgentRoutes } from '../src/linked-agent-routes.js';
import { OrganizationStore } from '../src/organization-store.js';
import { organizationRoutes, type OrgAgentRow } from '../src/organization-routes.js';
import {
  apiKeyCaller, orgViewerOf, resolveOrganization, SharedAgentEvents, sharedAgentRoutes, walletCaller, withOrganizations,
  type AgentCaller, type OrgAudit,
} from '../src/shared-agents.js';

const MODEL = 'Test-Chat-1';
const NODE = '0x1111111111111111111111111111111111111111';
const ISSUER = 'https://node.example';

type Who = { principal: string; email?: string; orgs?: string[] } | { key: string } | { address: string } | null;

/** An AIN SSO caller the way `ssoCaller` builds one, with the ID token's orgs as its memberships. */
const ssoLike = (principal: string, orgs: string[]): AgentCaller => ({
  subject: principal.toLowerCase(), kind: 'principal', sso: { iss: 'https://auth.example', sub: principal, org: null, orgs },
  orgMember: (id) => orgs.includes(id), orgRole: (id) => (orgs.includes(id) ? 'write' : null),
});

async function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'org-roles-'));
  const orgs = new OrganizationStore(join(dir, 'o.json'));
  const store = new HostedAgentStore(join(dir, 'h.json'));
  const linked = new LinkedAgentStore(join(dir, 'l.json'));
  const secrets = new HostedAgentSecretStore(join(dir, 's.json'), join(dir, 's.key'));
  const registry = () => new InferenceBackendRegistry([{ id: 'llm', modality: 'chat', upstream: 'http://127.0.0.1:9', models: [MODEL], concurrency: 1 }]);
  const gateway = new HostedAgentGateway({ registry, spec: (id) => store.get(id), log: () => {} });
  const host = new HostedAgentHost({ gateway, secrets, docker: null, idleStopMs: 60_000, maxRunning: 2, log: () => {} });
  await host.start([]);
  const emails = new Map<string, string>();
  const base = (req: Request): AgentCaller | null => {
    const address = req.header('x-test-address');
    if (address) return walletCaller(address);
    const key = req.header('x-test-key');
    if (key) return apiKeyCaller({ address: 'sso:keyholder', orgId: key === 'personal' ? null : key });
    const principal = req.header('x-test-principal');
    if (!principal) return null;
    const email = req.header('x-test-email');
    if (email) emails.set(principal, email);
    return ssoLike(principal, (req.header('x-test-orgs') ?? '').split(',').filter(Boolean));
  };
  const identity = (c: AgentCaller) => ({ email: emails.get(c.subject) ?? null, name: null });
  const caller = (req: Request) => { const c = base(req); return c ? withOrganizations(c, orgs, identity(c)) : null; };
  const viewer = (req: Request) => { const c = base(req); return c && c.keyOrg === undefined ? orgViewerOf(c, identity(c)) : null; };
  const orgAudit: OrgAudit = (ids, actor, action, agentId, detail = null) => {
    const done = new Set<string>();
    for (const id of ids) { const o = id ? resolveOrganization(orgs, id) : null; if (o && !done.has(o.id)) { done.add(o.id); orgs.note(o.id, actor, action, agentId, detail); } }
  };
  const sharedWith = (o: { id: string; ssoOrgIds: string[] }) => (a: { visibility?: string | null; orgId?: string | null }) =>
    a.visibility === 'org' && !!a.orgId && (a.orgId === o.id || o.ssoOrgIds.includes(a.orgId));
  const rows = (o: { id: string; ssoOrgIds: string[] }): OrgAgentRow[] => [
    ...store.list().filter(sharedWith(o)).map((a) => ({ id: a.id, name: a.name, description: a.description, owner: a.owner, kind: 'hosted' as const, visibility: hostedAgentVisibilityOf(a), orgId: a.orgId ?? null, version: a.version, createdAt: a.createdAt, updatedAt: a.updatedAt })),
    ...linked.list().filter(sharedWith(o)).map((a) => ({ id: a.id, name: a.name, description: a.description, owner: a.owner, kind: 'linked' as const, visibility: hostedAgentVisibilityOf(a), orgId: a.orgId ?? null, version: a.version, createdAt: a.createdAt, updatedAt: a.updatedAt })),
  ];
  const feed = new SharedAgentEvents();
  const cfg = { identity: { address: NODE }, agents: [], publicUrl: ISSUER } as unknown as NodeConfig;
  const app = express();
  app.use(express.json());
  app.use(hostedAgentRoutes({ store, secrets, host, registry, caller, events: feed, orgAudit, reserved: () => false, publicBase: () => ISSUER }));
  app.use(linkedAgentRoutes({ store: linked, caller, events: feed, orgAudit, reserved: (id) => store.get(id) !== null, publicBase: () => ISSUER, probe: async () => ({ card: { name: 'Linked', description: '', skills: [] } }), allowPrivateUpstream: true }));
  app.use(sharedAgentRoutes({ store, host, proxied: () => [], caller, registryIssuer: () => ISSUER, ssoIssuer: () => 'https://auth.example', selfAddress: NODE, events: feed, linked, orgAudit }));
  app.use(organizationRoutes({ orgs, agents: { listByOrg: rows }, viewer, publicBase: () => ISSUER }));
  app.use(buildAgents(cfg, {
    hosted: { host, store }, linked,
    orgScope: (req, orgId) => {
      const c = caller(req);
      if (!c?.orgMember(orgId)) return null;
      const o = resolveOrganization(orgs, orgId);
      return o ? sharedWith(o) : (a) => a.visibility === 'org' && a.orgId === orgId;
    },
  }));
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = async (who: Who, path: string, init: { method?: string; body?: unknown } = {}) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (who && 'principal' in who) {
      headers['x-test-principal'] = who.principal;
      if (who.email) headers['x-test-email'] = who.email;
      headers['x-test-orgs'] = (who.orgs ?? []).join(',');
    }
    if (who && 'key' in who) headers['x-test-key'] = who.key;
    if (who && 'address' in who) headers['x-test-address'] = who.address;
    const r = await fetch(`${url}${path}`, { method: init.method ?? 'GET', headers, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) });
    return { status: r.status, body: await r.json() as Record<string, any> };
  };
  return {
    orgs, store, api,
    close: async () => { await new Promise<void>((r) => server.close(() => r())); await host.stop(); rmSync(dir, { recursive: true, force: true }); },
  };
}

const ALICE = { principal: 'sso:alice', email: 'alice@comcom.ai' };                // creates comcom: admin
const BOB = { principal: 'sso:bob', email: 'bob@comcom.ai' };                      // explicit write
const CAROL = { principal: 'sso:carol', email: 'carol@gmail.com' };                // explicit contributor
const DAVE = { principal: 'sso:dave', email: 'dave@comcom.ai' };                   // by email domain: domainRole read
const ERIN = { principal: 'sso:erin', email: 'erin@gmail.com', orgs: ['org_comcom'] }; // by the linked AIN org: read
const ZED = { principal: 'sso:zed', email: 'zed@acme.com' };                       // nobody here
const FRANK = { principal: 'sso:frank', orgs: ['org_loose'] };                     // AIN org no ainize org claims
const GEORGE = { principal: 'sso:george', orgs: ['org_loose'] };

const spec = (id: string, over: Record<string, unknown> = {}) => ({ id, name: `Agent ${id}`, model: MODEL, systemPrompt: 'v1', ...over });
const ids = (r: { body: Record<string, any> }) => (r.body.agents as { id: string }[]).map((a) => a.id).sort();

test('roles in an ainize organization gate its agents: read sees, contributor shares in, write edits, admin removes and re-shares', async () => {
  const h = await harness();
  const { api } = h;
  try {
    const created = await api(ALICE, '/api/orgs', { method: 'POST', body: { id: 'comcom', name: 'ComCom', domains: ['comcom.ai'], domainRole: 'read' } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    // linking an AIN org takes a session that is a member of it, and one organization per AIN org
    const notMine = await api(ALICE, '/api/orgs/comcom', { method: 'PUT', body: { ssoOrgIds: ['org_comcom'] } });
    assert.equal(notMine.status, 403);
    assert.equal(notMine.body.error.code, 'sso_org_not_yours');
    const linked = await api({ ...ALICE, orgs: ['org_comcom'] }, '/api/orgs/comcom', { method: 'PUT', body: { ssoOrgIds: ['org_comcom'] } });
    assert.equal(linked.status, 200, JSON.stringify(linked.body));
    assert.deepEqual(h.orgs.get('comcom')!.ssoOrgIds, ['org_comcom']);
    await api(ZED, '/api/orgs', { method: 'POST', body: { id: 'squat', name: 'Squat' } });
    const taken = await api({ ...ZED, orgs: ['org_comcom'] }, '/api/orgs/squat', { method: 'PUT', body: { ssoOrgIds: ['org_comcom'] } });
    assert.equal(taken.body.error.code, 'sso_org_taken');
    h.orgs.setMember('comcom', { principal: 'sso:bob', role: 'write', email: BOB.email, name: null, via: 'admin' }, 'sso:alice');
    h.orgs.setMember('comcom', { principal: 'sso:carol', role: 'contributor', email: CAROL.email, name: null, via: 'admin' }, 'sso:alice');

    // sharing in takes contributor: read members (by domain, by linked AIN org) and outsiders are refused
    const readTry = await api(DAVE, '/api/hosted-agents', { method: 'POST', body: spec('d1', { visibility: 'org', orgId: 'comcom' }) });
    assert.equal(readTry.status, 400);
    assert.match(readTry.body.error.message, /contributor/);
    assert.equal((await api(ERIN, '/api/hosted-agents', { method: 'POST', body: spec('e1', { visibility: 'org', orgId: 'comcom' }) })).status, 400);
    const outsider = await api(ZED, '/api/hosted-agents', { method: 'POST', body: spec('z1', { visibility: 'org', orgId: 'comcom' }) });
    assert.match(outsider.body.error.message, /not a member/);
    assert.equal((await api(CAROL, '/api/hosted-agents', { method: 'POST', body: spec('c1', { visibility: 'org', orgId: 'comcom' }) })).status, 201);
    // an AIN SSO org id resolves to the ainize organization that links it
    assert.equal((await api(CAROL, '/api/hosted-agents', { method: 'POST', body: spec('c2', { visibility: 'org', orgId: 'org_comcom' }) })).status, 201);
    assert.equal((await api(BOB, '/api/hosted-agents', { method: 'POST', body: spec('b1', { visibility: 'org', orgId: 'comcom' }) })).status, 201);

    // any role sees them — listed, and by id without the spec; outsiders get 404
    for (const who of [DAVE, ERIN]) {
      assert.deepEqual(ids(await api(who, '/api/hosted-agents')), ['b1', 'c1', 'c2']);
      const got = await api(who, '/api/hosted-agents/b1');
      assert.equal(got.status, 200);
      assert.equal('systemPrompt' in got.body.agent, false, 'a read member sees the listing, not the code');
    }
    assert.equal((await api(ZED, '/api/hosted-agents/b1')).status, 404);
    assert.deepEqual(ids(await api(DAVE, '/api/agents?org=comcom')), ['b1', 'c1', 'c2']);
    assert.deepEqual(ids(await api(DAVE, '/api/agents?org=org_comcom')), ['b1', 'c1', 'c2'], 'the AIN org id names the same list');
    assert.deepEqual(ids(await api(ZED, '/api/agents?org=comcom')), []);
    assert.deepEqual(ids(await api(null, '/api/agents')), [], 'none of them is public');

    // editing takes write: bob edits carol's, carol (contributor) not bob's, dave (read) nothing
    const edited = await api(BOB, '/api/hosted-agents/c1', { method: 'PUT', body: spec('c1', { visibility: 'org', orgId: 'comcom', systemPrompt: 'v2' }) });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.agent.updated_by, 'sso:bob');
    assert.equal((await api(CAROL, '/api/hosted-agents/b1', { method: 'PUT', body: spec('b1', { visibility: 'org', orgId: 'comcom' }) })).status, 403);
    assert.equal((await api(DAVE, '/api/hosted-agents/b1', { method: 'PUT', body: spec('b1', { visibility: 'org', orgId: 'comcom' }) })).status, 403);
    assert.equal((await api(DAVE, '/api/hosted-agents/b1/logs')).status, 403);
    assert.equal((await api(CAROL, '/api/hosted-agents/c1', { method: 'PUT', body: spec('c1', { visibility: 'org', orgId: 'comcom', systemPrompt: 'v3' }) })).status, 200, 'the owner edits their own');

    // a row written down for an AIN SSO member lasts only while the membership does
    assert.equal((await api(ERIN, '/api/orgs/comcom')).status, 200, 'erin walks in through org_comcom and is written down');
    assert.ok(h.orgs.get('comcom')!.members.some((m) => m.principal === 'sso:erin' && m.via === 'sso'));
    assert.equal((await api({ ...ERIN, orgs: [] }, '/api/hosted-agents/b1')).status, 404, 'offboarded in AIN SSO: the row does not keep her in');
    assert.equal((await api({ ...ERIN, orgs: [] }, '/api/orgs/comcom')).status, 403);

    // manageable: write members see every org agent, contributors their own, readers nothing
    assert.deepEqual(ids(await api(BOB, '/api/hosted-agents?manageable=1')), ['b1', 'c1', 'c2']);
    assert.deepEqual(ids(await api(CAROL, '/api/hosted-agents?manageable=1')), ['c1', 'c2']);
    assert.deepEqual(ids(await api(DAVE, '/api/hosted-agents?manageable=1')), []);
    const bobRow = (await api(BOB, '/api/hosted-agents?manageable=1')).body.agents.find((a: { id: string }) => a.id === 'c1');
    assert.equal(bobRow.can_manage, true);
    assert.equal(bobRow.can_delete, false, 'write edits, it does not remove');
    const aliceRow = (await api(ALICE, '/api/hosted-agents?manageable=1')).body.agents.find((a: { id: string }) => a.id === 'c1');
    assert.equal(aliceRow.can_delete, true, 'an admin removes');

    // removing and re-sharing take the owner or an admin
    assert.equal((await api(BOB, '/api/hosted-agents/c1', { method: 'DELETE' })).status, 403);
    assert.equal((await api(BOB, '/api/hosted-agents/c1', { method: 'PUT', body: spec('c1', { visibility: 'private' }) })).status, 403);
    assert.equal((await api(BOB, '/api/shared-agents/c1/visibility', { method: 'PUT', body: { visibility: 'public' } })).status, 403);
    assert.equal((await api(ALICE, '/api/shared-agents/c2/visibility', { method: 'PUT', body: { visibility: 'public' } })).status, 200, 'an admin re-shares');
    assert.equal(h.store.get('c2')!.visibility, 'public');
    assert.equal((await api(ALICE, '/api/hosted-agents/c1', { method: 'DELETE' })).status, 200, 'an admin removes a member\'s agent');
    assert.equal((await api(BOB, '/api/hosted-agents/b1', { method: 'DELETE' })).status, 200, 'the owner removes their own');

    // an organization API key for the linked AIN org is write in the ainize organization
    assert.equal((await api(CAROL, '/api/hosted-agents', { method: 'POST', body: spec('c3', { visibility: 'org', orgId: 'comcom' }) })).status, 201);
    assert.equal((await api({ key: 'org_comcom' }, '/api/hosted-agents/c3', { method: 'PUT', body: spec('c3', { visibility: 'org', orgId: 'comcom', systemPrompt: 'by key' }) })).status, 200);
    assert.equal((await api({ key: 'org_comcom' }, '/api/hosted-agents/c3', { method: 'DELETE' })).status, 403);
    assert.equal((await api({ key: 'personal' }, '/api/hosted-agents/c3')).status, 404, 'a personal key speaks for no organization');
    assert.equal((await api({ address: '0xdddddddddddddddddddddddddddddddddddddddd' }, '/api/hosted-agents/c3')).status, 404, 'a wallet with no member row is outside');
    h.orgs.setMember('comcom', { principal: '0xdddddddddddddddddddddddddddddddddddddddd', role: 'write', email: null, name: null, via: 'admin' }, 'sso:alice');
    assert.equal((await api({ address: '0xDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD' }, '/api/hosted-agents/c3', { method: 'PUT', body: spec('c3', { visibility: 'org', orgId: 'comcom' }) })).status, 200, 'a wallet an admin added is a member');

    // linked agents: contributor registers into it, editing where one points stays its registrant's, an admin removes it
    assert.equal((await api(CAROL, '/api/linked-agents', { method: 'POST', body: { id: 'l1', upstream: 'http://127.0.0.1:9', visibility: 'org', orgId: 'comcom' } })).status, 201);
    assert.equal((await api(DAVE, '/api/linked-agents', { method: 'POST', body: { id: 'l2', upstream: 'http://127.0.0.1:9', visibility: 'org', orgId: 'comcom' } })).status, 400);
    assert.equal((await api(BOB, '/api/linked-agents/l1', { method: 'PUT', body: { id: 'l1', upstream: 'http://127.0.0.1:9', visibility: 'org', orgId: 'comcom' } })).status, 403);
    assert.equal('upstream' in (await api(BOB, '/api/linked-agents/l1')).body.agent, false, 'a member is not told where it runs');

    // the organization's page, its delete guard and its audit log see both kinds through #40's fields
    const page = await api(DAVE, '/api/orgs/comcom');
    assert.equal(page.status, 200, JSON.stringify(page.body));
    assert.deepEqual(page.body.org.agents.map((a: { id: string; kind: string }) => [a.id, a.kind]).sort(), [['c3', 'hosted'], ['l1', 'linked']]);
    assert.equal(page.body.org.agent_count, 2);
    assert.equal((await api(ALICE, '/api/orgs/comcom', { method: 'DELETE' })).body.error.code, 'has_agents');
    const actions = h.orgs.audit('comcom').map((e) => `${e.action}:${e.target}`);
    for (const want of ['agent.create:c1', 'agent.update:c1', 'agent.delete:c1', 'agent.sharing:c2', 'agent.delete:b1', 'agent.create:l1']) assert.ok(actions.includes(want), `${want} in ${actions.join(' ')}`);
    assert.equal((await api(ALICE, '/api/linked-agents/l1', { method: 'DELETE' })).status, 200, 'an admin removes a linked agent too');
  } finally { await h.close(); }
});

test('an AIN SSO org no ainize organization claims keeps #40/#41: members are write — they edit, the owner removes', async () => {
  const h = await harness();
  const { api } = h;
  try {
    assert.equal((await api(FRANK, '/api/hosted-agents', { method: 'POST', body: spec('f1', { visibility: 'org', orgId: 'org_loose' }) })).status, 201);
    assert.equal((await api(GEORGE, '/api/hosted-agents/f1', { method: 'PUT', body: spec('f1', { visibility: 'org', orgId: 'org_loose', systemPrompt: 'v2' }) })).status, 200);
    assert.equal((await api(GEORGE, '/api/hosted-agents/f1', { method: 'DELETE' })).status, 403);
    assert.deepEqual(ids(await api(GEORGE, '/api/agents?org=org_loose')), ['f1']);
    assert.deepEqual(ids(await api(ZED, '/api/agents?org=org_loose')), []);
    assert.equal(h.orgs.list().length, 0, 'nothing was written to organizations');
    // once an ainize organization links that AIN org, its roles take over: frank (no row, domainRole read) is read
    assert.equal((await api(ZED, '/api/orgs', { method: 'POST', body: { id: 'loose', name: 'Loose', domainRole: 'read' } })).status, 201);
    assert.equal((await api({ ...ZED, orgs: ['org_loose'] }, '/api/orgs/loose', { method: 'PUT', body: { ssoOrgIds: ['org_loose'] } })).status, 200);
    assert.equal((await api(GEORGE, '/api/hosted-agents/f1', { method: 'PUT', body: spec('f1', { visibility: 'org', orgId: 'org_loose', systemPrompt: 'v3' }) })).status, 403);
    assert.equal((await api(GEORGE, '/api/hosted-agents/f1')).status, 200, 'still a member: still sees it');
    assert.equal((await api({ ...ZED, orgs: ['org_loose'] }, '/api/hosted-agents/f1', { method: 'DELETE' })).status, 200, 'the linking organization\'s admin removes it');
  } finally { await h.close(); }
});
