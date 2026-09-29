/**
 * Organizations: a team's page on the node, who is in it (explicit members, the sign-in's email domain, an AIN SSO
 * organization), what each role may do, invites and join requests, resource groups, and how the catalogue hides a
 * private organization agent from everyone else.
 *
 *   node --test --import tsx test/organizations.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NodeConfig } from '@ainize/core';
import { buildAgents, agentAdverts } from '../src/agents.js';
import { LinkedAgentStore } from '../src/linked-agent-store.js';
import { linkedAgentRoutes } from '../src/linked-agent-routes.js';
import {
  canSeeOrgAgent, emailDomain, membership, OrgDomainNotYoursError, OrgDomainTakenError, OrgIdTakenError, OrgLastAdminError, OrganizationStore, roleAtLeast,
  type OrgViewer,
} from '../src/organization-store.js';
import { organizationRoutes } from '../src/organization-routes.js';

const ALICE: OrgViewer = { principal: 'sso:alice', email: 'alice@comcom.ai', name: 'Alice', ssoOrgIds: ['org_comcom'] };
const BOB: OrgViewer = { principal: 'sso:bob', email: 'bob@comcom.ai', name: 'Bob', ssoOrgIds: [] };
const CAROL: OrgViewer = { principal: 'sso:carol', email: 'carol@acme.com', name: 'Carol', ssoOrgIds: [] };
const WALLET: OrgViewer = { principal: '0xdddddddddddddddddddddddddddddddddddddddd', email: null, name: null, ssoOrgIds: [] };
const VIEWERS: Record<string, OrgViewer> = { alice: ALICE, bob: BOB, carol: CAROL, wallet: WALLET };

test('the store: domains are claimed by their own people only, roles rank, the last admin stays', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orgs-store-'));
  try {
    const orgs = new OrganizationStore(join(dir, 'o.json'), { total: 10, perCreator: 2, members: 5, groups: 3, invites: 3, requests: 3, audit: 5 });
    assert.throws(() => orgs.create({ id: 'comcom', name: 'ComCom', description: '', readme: '', domains: ['comcom.ai'], domainRole: 'write' }, CAROL), OrgDomainNotYoursError, 'carol is @acme.com');
    const comcom = orgs.create({ id: 'comcom', name: 'ComCom', description: 'we', readme: '# hi', domains: ['comcom.ai'], domainRole: 'write' }, ALICE);
    assert.deepEqual(comcom.members.map((m) => [m.principal, m.role, m.via]), [['sso:alice', 'admin', 'creator']]);
    assert.deepEqual(comcom.ssoOrgIds, ['org_comcom'], 'the one AIN organization the sign-in named is linked');
    assert.throws(() => orgs.create({ id: 'comcom', name: 'X', description: '', readme: '', domains: [], domainRole: 'read' }, BOB), OrgIdTakenError);
    assert.throws(() => orgs.create({ id: 'new', name: 'X', description: '', readme: '', domains: [], domainRole: 'read' }, BOB), OrgIdTakenError, '/org/new is a page');
    assert.throws(() => orgs.create({ id: 'other', name: 'Other', description: '', readme: '', domains: ['comcom.ai'], domainRole: 'read' }, BOB), OrgDomainTakenError, 'a domain belongs to one organization');

    // membership: explicit > domain > sso; a wallet with no email is nobody here
    assert.deepEqual(membership(comcom, ALICE), { role: 'admin', via: 'member' });
    assert.deepEqual(membership(comcom, BOB), { role: 'write', via: 'domain' });
    assert.equal(membership(comcom, CAROL), null);
    assert.equal(membership(comcom, WALLET), null);
    const viaSso: OrgViewer = { principal: 'sso:dan', email: 'dan@gmail.com', name: null, ssoOrgIds: ['org_comcom'] };
    assert.deepEqual(membership(comcom, viaSso), { role: 'write', via: 'sso' });
    assert.ok(roleAtLeast('write', 'contributor') && !roleAtLeast('read', 'contributor') && !roleAtLeast(null, 'read'));

    // an explicit row outranks the domain default, both ways
    orgs.setMember('comcom', { principal: 'sso:bob', role: 'read', email: BOB.email, name: BOB.name, via: 'domain' }, 'sso:alice');
    assert.deepEqual(membership(comcom, BOB), { role: 'read', via: 'member' });
    assert.throws(() => orgs.removeMember('comcom', 'sso:alice', 'sso:alice'), OrgLastAdminError);
    assert.throws(() => orgs.setMember('comcom', { principal: 'sso:alice', role: 'write', email: null, name: null, via: 'admin' }, 'sso:alice'), OrgLastAdminError);
    orgs.setMember('comcom', { principal: 'sso:bob', role: 'admin', email: null, name: null, via: 'admin' }, 'sso:alice');
    assert.ok(orgs.removeMember('comcom', 'sso:alice', 'sso:bob'), 'with a second admin the first may go');

    // invites: one use, optional email pin, expiry
    const inv = orgs.createInvite('comcom', { role: 'contributor', email: 'carol@acme.com', ttlHours: 1 }, 'sso:bob');
    assert.equal(orgs.useInvite(inv.token, BOB), null, 'pinned to carol');
    const used = orgs.useInvite(inv.token, CAROL);
    assert.equal(used?.member.role, 'contributor');
    assert.equal(orgs.useInvite(inv.token, CAROL), null, 'one use');
    const late = orgs.createInvite('comcom', { role: 'read', ttlHours: 1 }, 'sso:bob', 1000);
    assert.equal(orgs.findInvite(late.token, 1000 + 3600_001), null, 'expired');

    // groups keep only members; the audit log is capped and newest-first
    const g = orgs.setGroup('comcom', { name: 'Newsroom', members: ['sso:carol', 'sso:nobody'], agents: ['desk'] }, 'sso:bob');
    assert.deepEqual(g.members, ['sso:carol']);
    const audit = orgs.audit('comcom');
    assert.equal(audit.length, 5, 'capped at the limit');
    assert.equal(audit[0].action, 'group.create');
    assert.ok(audit[0].seq > audit[1].seq, 'newest first');

    // the file is the truth
    const again = new OrganizationStore(join(dir, 'o.json'));
    assert.deepEqual(again.get('comcom')?.groups.map((x) => x.name), ['Newsroom']);
    assert.equal(again.audit('comcom').length, 5);

    // seeding: exists with no members; the first domain sign-in is a write member
    const seeded = orgs.seed('acme', 'Acme', ['acme.com'], '0xnode');
    assert.equal(seeded.members.length, 0);
    assert.deepEqual(membership(seeded, CAROL), { role: 'write', via: 'domain' });
    assert.throws(() => orgs.seed('acme2', 'Acme 2', ['acme.com'], '0xnode'), OrgDomainTakenError);
    assert.equal(emailDomain('X@ComCom.AI'), 'comcom.ai');
    assert.equal(emailDomain('nope'), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('who sees a private organization agent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orgs-see-'));
  try {
    const orgs = new OrganizationStore(join(dir, 'o.json'));
    const org = orgs.create({ id: 'comcom', name: 'ComCom', description: '', readme: '', domains: ['comcom.ai'], domainRole: 'read' }, ALICE);
    const grp = orgs.setGroup('comcom', { name: 'Desk', members: ['sso:alice'], agents: ['desk'] }, 'sso:alice');
    orgs.setMember('comcom', { principal: 'sso:bob', role: 'read', email: BOB.email, name: null, via: 'domain' }, 'sso:alice');
    const org2 = orgs.get('comcom')!;
    const pub = { visibility: 'public' as const, group: null, owner: 'sso:zed' };
    const priv = { visibility: 'private' as const, group: null, owner: 'sso:zed' };
    const grouped = { visibility: 'private' as const, group: grp.id, owner: 'sso:zed' };
    assert.ok(canSeeOrgAgent(org2, pub, null));
    assert.ok(!canSeeOrgAgent(org2, priv, null));
    assert.ok(!canSeeOrgAgent(org2, priv, CAROL));
    assert.ok(canSeeOrgAgent(org2, priv, BOB), 'any member sees an ungrouped private agent');
    assert.ok(!canSeeOrgAgent(org2, grouped, BOB), 'a grouped one needs the group');
    assert.ok(canSeeOrgAgent(org2, grouped, ALICE), 'admins see everything');
    assert.ok(canSeeOrgAgent(org2, { ...grouped, owner: 'sso:bob' }, BOB), 'and so does whoever registered it');
    assert.ok(canSeeOrgAgent(org2, { ...grouped, group: 'gone' }, BOB), 'a deleted group hides nothing');
    void org;
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function nodeApp(orgs: OrganizationStore, agents: LinkedAgentStore): Promise<{ base: string; server: Server }> {
  const app = express();
  app.use(express.json());
  const viewer = (req: express.Request) => VIEWERS[req.header('x-test-viewer') ?? ''] ?? null;
  const cfg = { identity: { address: '0x1111111111111111111111111111111111111111' }, agents: [], publicUrl: 'https://node.example' } as unknown as NodeConfig;
  app.use(organizationRoutes({ orgs, agents, viewer, publicBase: () => 'https://node.example', siteBase: () => 'https://ainize.example', keys: { listFor: (owner) => (owner === 'sso:alice' ? [{ prefix: 'abcd1234', issuedAt: 1, label: 'ci', org_id: 'org_comcom', disabled: false }, { prefix: 'ffff0000', issuedAt: 1, label: 'personal', org_id: null, disabled: false }] : []) }, sso: () => ({ configured: true, issuer: 'https://auth.example' }) }));
  app.use(linkedAgentRoutes({
    store: agents, sessionPrincipal: (req) => viewer(req)?.principal ?? null, reserved: () => false, publicBase: () => 'https://node.example',
    probe: async () => ({ card: { name: 'Desk Bot', description: 'd', skills: [] } }), allowPrivateUpstream: true, orgs, viewer,
  }));
  app.use(buildAgents(cfg, {
    linked: agents,
    canSee: (req, a) => {
      const org = a.org ? orgs.get(a.org) : null;
      return !!org && canSeeOrgAgent(org, { visibility: a.visibility ?? 'public', group: a.group ?? null, owner: a.owner ?? '' }, viewer(req));
    },
  }));
  const server = createServer(app);
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server })));
}

test('over HTTP: create → domain members walk in → roles gate → agents under the organization → catalogue hides private ones', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orgs-http-'));
  const orgs = new OrganizationStore(join(dir, 'o.json'));
  const agents = new LinkedAgentStore(join(dir, 'l.json'));
  const { base, server } = await nodeApp(orgs, agents);
  const call = async (who: string | null, method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(who ? { 'x-test-viewer': who } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  try {
    assert.equal((await call(null, 'POST', '/api/orgs', { id: 'comcom', name: 'ComCom' })).status, 401);
    const denied = await call('carol', 'POST', '/api/orgs', { id: 'comcom', name: 'ComCom', domains: ['comcom.ai'] });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'domain_not_yours');
    const created = await call('alice', 'POST', '/api/orgs', { id: 'comcom', name: 'ComCom', domains: ['comcom.ai'], readme: '# ComCom\nagents live here' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.org.my_role, 'admin');
    assert.equal(created.body.org.readme, '# ComCom\nagents live here');

    // the list: bob is in by domain (and gets written down on his first visit), carol is not
    const bobList = await call('bob', 'GET', '/api/orgs');
    assert.deepEqual(bobList.body.orgs.map((o: { id: string; my_role: string; via: string }) => [o.id, o.my_role, o.via]), [['comcom', 'write', 'domain']]);
    assert.equal(bobList.body.domain_org, 'comcom');
    const carolList = await call('carol', 'GET', '/api/orgs');
    assert.deepEqual(carolList.body.orgs, []);
    assert.equal(carolList.body.email_domain, 'acme.com');
    assert.equal(carolList.body.domain_org, null, 'carol could create acme');
    const bobPage = await call('bob', 'GET', '/api/orgs/comcom');
    assert.equal(bobPage.status, 200);
    assert.ok(bobPage.body.org.members.some((m: { principal: string; via: string }) => m.principal === 'sso:bob' && m.via === 'domain'), 'the visit wrote bob down');
    assert.equal(bobPage.body.org.members.find((m: { principal: string }) => m.principal === 'sso:alice').email, 'a…@comcom.ai', 'emails are for admins');
    const carolPage = await call('carol', 'GET', '/api/orgs/comcom');
    assert.equal(carolPage.status, 403);
    assert.equal(carolPage.body.error.code, 'not_member');
    assert.equal(carolPage.body.can_request, true);
    assert.equal((await call('wallet', 'GET', '/api/orgs/comcom')).status, 403, 'a wallet has no email and no membership');
    assert.equal((await call('nobody', 'GET', '/api/orgs/comcom')).status, 401);

    // roles: bob (write) may not change settings; alice may; the README is the page's card
    assert.equal((await call('bob', 'PUT', '/api/orgs/comcom', { name: 'X' })).body.error.code, 'insufficient_role');
    const updated = await call('alice', 'PUT', '/api/orgs/comcom', { description: 'AI Network', domainRole: 'contributor', spendCapCredits: 5000 });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.org.description, 'AI Network');
    assert.equal(updated.body.org.spend_cap_credits, 5000);
    assert.equal((await call('alice', 'PUT', '/api/orgs/comcom', { domains: ['comcom.ai', 'acme.com'] })).body.error.code, 'domain_not_yours');

    // join requests: carol asks, alice approves as read
    assert.equal((await call('carol', 'POST', '/api/orgs/comcom/join', { message: 'hi' })).status, 202);
    assert.equal((await call('carol', 'POST', '/api/orgs/comcom/join', {})).status, 202, 'asking twice is one request');
    assert.equal((await call('bob', 'GET', '/api/orgs/comcom/requests')).status, 403);
    const reqs = await call('alice', 'GET', '/api/orgs/comcom/requests');
    assert.deepEqual(reqs.body.requests.map((r: { principal: string; message: string }) => [r.principal, r.message]), [['sso:carol', '']]);
    assert.equal((await call('alice', 'POST', '/api/orgs/comcom/requests/sso:carol/approve', { role: 'read' })).status, 200);
    assert.equal((await call('carol', 'GET', '/api/orgs/comcom')).body.org.my_role, 'read');
    assert.equal((await call('carol', 'POST', '/api/orgs/comcom/join', {})).body.error.code, 'already_member');

    // invites: the link is shown once; the list shows a prefix; a wallet can take one
    const inv = await call('alice', 'POST', '/api/orgs/comcom/invites', { role: 'contributor' });
    assert.equal(inv.status, 201);
    assert.match(inv.body.invite.url, /^https:\/\/ainize\.example\/org\/join\//);
    const token = inv.body.invite.token as string;
    assert.equal((await call('alice', 'GET', '/api/orgs/comcom/invites')).body.invites[0].token, null);
    const peek = await call(null, 'GET', `/api/orgs/join/${token}`);
    assert.equal(peek.status, 200);
    assert.equal(peek.body.role, 'contributor');
    assert.equal((await call('wallet', 'POST', `/api/orgs/join/${token}`)).body.org.my_role, 'contributor');
    assert.equal((await call('wallet', 'POST', `/api/orgs/join/${token}`)).status, 404, 'one use');

    // members: roles change from the list; the last admin cannot be demoted; anyone may leave
    assert.equal((await call('alice', 'PUT', '/api/orgs/comcom/members/sso:bob', { role: 'admin' })).body.member.role, 'admin');
    assert.equal((await call('bob', 'PUT', '/api/orgs/comcom/members/sso:alice', { role: 'read' })).status, 200, 'now there are two admins');
    assert.equal((await call('alice', 'PUT', '/api/orgs/comcom/members/sso:bob', { role: 'read' })).status, 403, 'alice is read now');
    assert.equal((await call('bob', 'PUT', '/api/orgs/comcom/members/sso:bob', { role: 'read' })).body.error.code, 'last_admin');
    assert.equal((await call('carol', 'DELETE', '/api/orgs/comcom/members/sso:alice')).status, 403, 'only admins remove others');
    assert.equal((await call('carol', 'DELETE', '/api/orgs/comcom/members/sso:carol')).status, 200, 'anyone may leave');
    assert.equal((await call('carol', 'GET', '/api/orgs/comcom')).status, 403);
    await call('bob', 'PUT', '/api/orgs/comcom/members/sso:alice', { role: 'admin' });

    // agents under the organization: contributor+ registers; the wallet (contributor) may register, alice (admin) may edit it, bob-as-read may not
    await call('bob', 'PUT', '/api/orgs/comcom/members/sso:bob', { role: 'admin' });
    const reg = await call('wallet', 'POST', '/api/linked-agents', { id: 'desk', upstream: 'http://127.0.0.1:9', org: 'comcom', visibility: 'private' });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    assert.equal(reg.body.agent.org, 'comcom');
    assert.equal(reg.body.agent.visibility, 'private');
    assert.equal((await call('carol', 'POST', '/api/linked-agents', { id: 'x', upstream: 'http://127.0.0.1:9', org: 'comcom' })).body.error.code, 'org_role');
    assert.equal((await call('alice', 'POST', '/api/linked-agents', { id: 'y', upstream: 'http://127.0.0.1:9', org: 'nope' })).body.error.code, 'org_not_found');
    assert.equal((await call('alice', 'POST', '/api/linked-agents', { id: 'y', upstream: 'http://127.0.0.1:9', org: 'comcom', group: 'nope' })).body.error.code, 'invalid_request');
    const pubReg = await call('alice', 'POST', '/api/linked-agents', { id: 'front', upstream: 'http://127.0.0.1:9', org: 'comcom' });
    assert.equal(pubReg.body.agent.visibility, 'public');
    const personal = await call('carol', 'POST', '/api/linked-agents', { id: 'solo', upstream: 'http://127.0.0.1:9', visibility: 'private' });
    assert.equal(personal.body.agent.visibility, 'public', 'a personal agent has nobody to be private from');
    const edit = await call('alice', 'PUT', '/api/linked-agents/desk', { id: 'desk', name: 'Desk', upstream: 'http://127.0.0.1:9', org: 'comcom', visibility: 'private' });
    assert.equal(edit.status, 200, 'a write member changes the organization\'s agent');
    assert.equal((await call('carol', 'PUT', '/api/linked-agents/desk', { id: 'desk', name: 'Desk', upstream: 'http://127.0.0.1:9', org: 'comcom' })).body.error.code, 'not_owner');

    // the organization page lists its agents; a group narrows a private one
    const grp = await call('alice', 'POST', '/api/orgs/comcom/groups', { name: 'Newsroom', members: ['sso:alice'], agents: ['desk'] });
    assert.equal(grp.status, 201);
    await call('alice', 'PUT', '/api/linked-agents/desk', { id: 'desk', name: 'Desk', upstream: 'http://127.0.0.1:9', org: 'comcom', visibility: 'private', group: grp.body.group.id });
    await call('bob', 'PUT', '/api/orgs/comcom/members/sso:bob', { role: 'read' });
    const alicePage = await call('alice', 'GET', '/api/orgs/comcom');
    assert.deepEqual(alicePage.body.org.agents.map((a: { id: string }) => a.id).sort(), ['desk', 'front']);
    assert.equal(alicePage.body.org.agent_count, 2);
    const bobPage2 = await call('bob', 'GET', '/api/orgs/comcom');
    assert.deepEqual(bobPage2.body.org.agents.map((a: { id: string }) => a.id), ['front'], 'bob (read, not in the group) does not see desk');
    assert.equal(bobPage2.body.org.hidden_agents, 1, 'and the page says one is hidden');

    // the catalogue: everyone sees `front` and `solo`; `desk` only its group and admins; `?org=` scopes
    const anon = await call(null, 'GET', '/api/agents');
    assert.deepEqual(anon.body.agents.map((a: { id: string; org: string | null }) => [a.id, a.org]).sort(), [['front', 'comcom'], ['solo', null]]);
    const scoped = await call(null, 'GET', '/api/agents?org=comcom');
    assert.deepEqual(scoped.body.agents.map((a: { id: string }) => a.id), ['front']);
    const aliceCat = await call('alice', 'GET', '/api/agents?org=comcom');
    assert.deepEqual(aliceCat.body.agents.map((a: { id: string; visibility: string }) => [a.id, a.visibility]).sort(), [['desk', 'private'], ['front', 'public']]);
    assert.deepEqual((await call('bob', 'GET', '/api/agents?org=comcom')).body.agents.map((a: { id: string }) => a.id), ['front']);
    assert.deepEqual(agentAdverts(cfgOf(), 'https://node.example', undefined, agents).map((a) => a.id).sort(), ['front', 'solo'], 'private agents are not gossiped');
    const linkedPublic = await call(null, 'GET', '/api/linked-agents');
    assert.deepEqual(linkedPublic.body.agents.map((a: { id: string }) => a.id).sort(), ['front', 'solo']);
    const linkedOrg = await call('alice', 'GET', '/api/linked-agents?org=comcom');
    assert.deepEqual(linkedOrg.body.agents.map((a: { id: string }) => a.id).sort(), ['desk', 'front']);
    assert.equal((await call('carol', 'GET', '/api/linked-agents?org=comcom')).body.error.code, 'not_member');

    // billing and security are admin tabs; billing counts the organization's keys and agent calls, and says spend is not metered
    assert.equal((await call('bob', 'GET', '/api/orgs/comcom/billing')).status, 403);
    const billing = await call('alice', 'GET', '/api/orgs/comcom/billing');
    assert.equal(billing.status, 200);
    assert.deepEqual(billing.body.keys.map((k: { prefix: string; owner: string }) => [k.prefix, k.owner]), [['abcd1234', 'sso:alice']], 'only keys for the linked AIN organization');
    assert.equal(billing.body.spend_metered, false);
    assert.equal(billing.body.spend_cap_credits, 5000);
    assert.deepEqual(billing.body.agents.map((a: { id: string; total: number }) => [a.id, a.total]).sort(), [['desk', 0], ['front', 0]]);
    const security = await call('alice', 'GET', '/api/orgs/comcom/security');
    assert.equal(security.body.sso.issuer, 'https://auth.example');
    assert.deepEqual(security.body.sso.org_ids, ['org_comcom']);
    assert.equal(security.body.private_agents, 1);
    const audit = await call('alice', 'GET', '/api/orgs/comcom/audit?limit=5');
    assert.equal(audit.body.audit.length, 5);
    assert.ok(audit.body.audit.every((e: { actor: string; action: string }) => e.actor && e.action));
    assert.ok(orgs.audit('comcom').some((e) => e.action === 'agent.register' && e.target === 'desk'), 'agent changes are in the organization\'s log');

    // an organization with agents is not deleted
    const del = await call('alice', 'DELETE', '/api/orgs/comcom');
    assert.equal(del.status, 409);
    assert.equal(del.body.error.code, 'has_agents');
    assert.equal((await call('alice', 'DELETE', '/api/linked-agents/desk')).status, 200);
    assert.equal((await call('wallet', 'DELETE', '/api/linked-agents/front')).body.error.code, 'not_owner', 'a contributor removes only their own');
    assert.equal((await call('alice', 'DELETE', '/api/linked-agents/front')).status, 200);
    assert.equal((await call('alice', 'DELETE', '/api/orgs/comcom')).status, 200);
    assert.equal((await call('alice', 'GET', '/api/orgs/comcom')).status, 404);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

const cfgOf = () => ({ identity: { address: '0x1111111111111111111111111111111111111111' }, agents: [], publicUrl: 'https://node.example' } as unknown as NodeConfig);
