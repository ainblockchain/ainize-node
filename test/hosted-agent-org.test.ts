/**
 * Hosted agents owned by AIN SSO / Google principals, and hosted agents under an organization.
 *
 * The same rules as linked agents (linked-agent-routes.ts): anyone signed in — a wallet or an SSO principal — may
 * create; the owner, or a `write` member of the agent's organization, may change it; creating under an organization
 * needs `contributor`; a private organization agent is listed only to the callers the organization admits. Prompt
 * mode only, so no Docker and no model call is needed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';
import type { NodeConfig } from '@ainize/core';
import { buildAgents } from '../src/agents.js';
import { InferenceBackendRegistry } from '../src/inference-backends.js';
import { HostedAgentGateway } from '../src/hosted-agent-gateway.js';
import { HostedAgentHost } from '../src/hosted-agent-host.js';
import { HostedAgentSecretStore } from '../src/hosted-agent-secrets.js';
import { HostedAgentStore } from '../src/hosted-agent-store.js';
import { hostedAgentRoutes } from '../src/hosted-agent-routes.js';
import { canSeeOrgAgent, membership, OrganizationStore, type OrgViewer } from '../src/organization-store.js';
import { organizationRoutes } from '../src/organization-routes.js';

const MODEL = 'Test-Chat-1';
const ALICE: OrgViewer = { principal: 'sso:alice', email: 'alice@comcom.ai', name: 'Alice', ssoOrgIds: [] };
const BOB: OrgViewer = { principal: 'sso:bob', email: 'bob@comcom.ai', name: 'Bob', ssoOrgIds: [] };
const DAVE: OrgViewer = { principal: 'google:Dave-123', email: 'dave@elsewhere.com', name: 'Dave', ssoOrgIds: [] };
const CAROL: OrgViewer = { principal: 'sso:carol', email: 'carol@acme.com', name: 'Carol', ssoOrgIds: [] };
const WALLET: OrgViewer = { principal: '0xDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD', email: null, name: null, ssoOrgIds: [] };
const VIEWERS: Record<string, OrgViewer> = { alice: ALICE, bob: BOB, dave: DAVE, carol: CAROL, wallet: WALLET };

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'hosted-org-'));
  const store = new HostedAgentStore(join(dir, 'h.json'));
  const secrets = new HostedAgentSecretStore(join(dir, 's.json'), join(dir, 's.key'));
  // nothing is called: a prompt agent is only created and listed here
  const registry = () => new InferenceBackendRegistry([{ id: 'llm', modality: 'chat', upstream: 'http://127.0.0.1:9', models: [MODEL], concurrency: 1 }]);
  const gateway = new HostedAgentGateway({ registry, spec: (id) => store.get(id), log: () => {} });
  const host = new HostedAgentHost({ gateway, secrets, docker: null, idleStopMs: 60_000, maxRunning: 2, log: () => {} });
  await host.start([]);
  const orgs = new OrganizationStore(join(dir, 'o.json'));
  // alice creates comcom (admin); @comcom.ai people are `read` by domain; dave (google, another domain) is an explicit `write`
  orgs.create({ id: 'comcom', name: 'ComCom', description: '', readme: '', domains: ['comcom.ai'], domainRole: 'read' }, ALICE);
  orgs.setMember('comcom', { principal: DAVE.principal, role: 'write', email: DAVE.email, name: DAVE.name, via: 'member' }, ALICE.principal);
  orgs.setGroup('comcom', { id: 'core', name: 'Core', members: [ALICE.principal], agents: [] } as never, ALICE.principal);

  const viewer = (req: express.Request) => VIEWERS[req.header('x-test-viewer') ?? ''] ?? null;
  const principal = (req: express.Request) => {
    const v = viewer(req);
    return v ? (/^0x/i.test(v.principal) ? v.principal.toLowerCase() : v.principal) : null;
  };
  const cfg = { identity: { address: '0x1111111111111111111111111111111111111111' }, agents: [], publicUrl: 'https://node.example' } as unknown as NodeConfig;
  const app = express();
  app.use(express.json());
  app.use(hostedAgentRoutes({
    store, secrets, host, registry,
    sessionPrincipal: principal,
    orgs, viewer,
    reserved: () => false,
    publicBase: () => 'https://node.example',
  }));
  const orgRow = (s: NonNullable<ReturnType<typeof store.get>>) => ({ id: s.id, name: s.name, description: s.description, owner: s.owner, org: s.org, visibility: s.visibility, group: s.group, version: s.version, createdAt: s.createdAt, updatedAt: s.updatedAt });
  app.use(organizationRoutes({
    orgs,
    agents: { list: () => store.list().map(orgRow), listByOrg: (id) => store.listByOrg(id).map(orgRow) },
    viewer,
    publicBase: () => 'https://node.example',
  }));
  app.use(buildAgents(cfg, {
    hosted: { host, store },
    canSee: (req, a) => {
      const org = a.org ? orgs.get(a.org) : null;
      if (!org) return false;
      const v = viewer(req);
      return canSeeOrgAgent(org, { visibility: a.visibility ?? 'public', group: a.group ?? null, owner: a.owner ?? '' }, v, membership(org, v)?.role ?? null);
    },
  }));
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (who: string | null, method: string, path: string, body?: unknown) => {
    const r = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(who ? { 'x-test-viewer': who } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => null) as Record<string, any> };
  };
  const close = async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await host.stop().catch(() => {});
    await gateway.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  };
  return { store, orgs, call, close, dir };
}

const agent = (over: Record<string, unknown> = {}) => ({ id: 'helper', name: 'Helper', model: MODEL, systemPrompt: 'Be brief.', ...over });
const ids = (r: { json: Record<string, any> }) => (r.json.agents as { id: string }[]).map((a) => a.id).sort();

test('an SSO principal creates, changes and removes its own hosted agent; nobody else may', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.call(null, 'POST', '/api/hosted-agents', agent())).status, 401);
    const created = await f.call('carol', 'POST', '/api/hosted-agents', agent({ id: 'carol-bot' }));
    assert.equal(created.status, 201);
    assert.equal(created.json.agent.owner, 'sso:carol');
    assert.equal(created.json.agent.org, null);
    assert.equal(created.json.agent.visibility, 'public');

    assert.deepEqual(ids(await f.call('carol', 'GET', '/api/hosted-agents?mine=1')), ['carol-bot']);
    assert.equal((await f.call('bob', 'PUT', '/api/hosted-agents/carol-bot', agent({ id: 'carol-bot', name: 'Mine now' }))).status, 403);
    assert.equal((await f.call('bob', 'GET', '/api/hosted-agents/carol-bot')).status, 403, 'the full spec is the owner\'s');
    assert.equal((await f.call('bob', 'DELETE', '/api/hosted-agents/carol-bot')).status, 403);

    const changed = await f.call('carol', 'PUT', '/api/hosted-agents/carol-bot', agent({ id: 'carol-bot', systemPrompt: 'Be kind.' }));
    assert.equal(changed.status, 200);
    assert.equal(changed.json.agent.version, 2);
    assert.equal(changed.json.agent.systemPrompt, 'Be kind.');
    assert.equal((await f.call('carol', 'DELETE', '/api/hosted-agents/carol-bot')).status, 200);
    assert.equal(f.store.get('carol-bot'), null);
  } finally { await f.close(); }
});

test('an SSO principal is case-sensitive, a wallet is not — and the wallet flow is what it was', async () => {
  const f = await fixture();
  try {
    const w = await f.call('wallet', 'POST', '/api/hosted-agents', agent({ id: 'w-bot' }));
    assert.equal(w.status, 201);
    assert.equal(w.json.agent.owner, WALLET.principal.toLowerCase());
    assert.deepEqual(f.store.listByOwner(WALLET.principal).map((s) => s.id), ['w-bot'], 'a mixed-case address finds its agents');
    const d = await f.call('dave', 'POST', '/api/hosted-agents', agent({ id: 'dave-bot' }));
    assert.equal(d.json.agent.owner, 'google:Dave-123', 'an OIDC subject keeps its case');
    assert.deepEqual(f.store.listByOwner('google:dave-123'), [], 'folding the case would make two accounts one owner');
  } finally { await f.close(); }
});

test('under an organization: contributor to create, write to change, read may not; a move keeps its org unless asked', async () => {
  const f = await fixture();
  try {
    const byReader = await f.call('bob', 'POST', '/api/hosted-agents', agent({ id: 'team-bot', org: 'comcom' }));
    assert.equal(byReader.status, 403);
    assert.equal(byReader.json.error.code, 'org_role');
    assert.equal((await f.call('carol', 'POST', '/api/hosted-agents', agent({ id: 'team-bot', org: 'nope' }))).status, 404);
    assert.equal((await f.call('alice', 'POST', '/api/hosted-agents', agent({ id: 'team-bot', org: 'comcom', group: 'no-such' }))).status, 400);

    const created = await f.call('alice', 'POST', '/api/hosted-agents', agent({ id: 'team-bot', org: 'comcom', visibility: 'private' }));
    assert.equal(created.status, 201);
    assert.equal(created.json.agent.org, 'comcom');
    assert.equal(created.json.agent.visibility, 'private');

    // dave is a write member: he reads the whole spec and changes it — with a body that predates organizations
    const full = await f.call('dave', 'GET', '/api/hosted-agents/team-bot');
    assert.equal(full.status, 200);
    assert.equal(full.json.agent.systemPrompt, 'Be brief.');
    const edited = await f.call('dave', 'PUT', '/api/hosted-agents/team-bot', agent({ id: 'team-bot', systemPrompt: 'Team voice.' }));
    assert.equal(edited.status, 200);
    assert.equal(edited.json.agent.org, 'comcom', 'an edit that does not mention org keeps the agent where it is');
    assert.equal(edited.json.agent.visibility, 'private');
    assert.equal(edited.json.agent.owner, 'sso:alice', 'the owner stays the creator');

    // bob is a read member: he may see it but not change, read in full, or remove it
    assert.equal((await f.call('bob', 'PUT', '/api/hosted-agents/team-bot', agent({ id: 'team-bot' }))).status, 403);
    assert.equal((await f.call('bob', 'GET', '/api/hosted-agents/team-bot')).status, 403);
    assert.equal((await f.call('bob', 'DELETE', '/api/hosted-agents/team-bot')).status, 403);
    assert.equal((await f.call('carol', 'PUT', '/api/hosted-agents/team-bot', agent({ id: 'team-bot' }))).status, 403);

    // what an editor syncs: own agents plus every agent of an organization where the caller may write
    await f.call('bob', 'POST', '/api/hosted-agents', agent({ id: 'bob-bot' }));
    assert.deepEqual(ids(await f.call('dave', 'GET', '/api/hosted-agents?manageable=1')), ['team-bot']);
    assert.deepEqual(ids(await f.call('alice', 'GET', '/api/hosted-agents?manageable=1')), ['team-bot'], 'an admin is at least write');
    assert.deepEqual(ids(await f.call('bob', 'GET', '/api/hosted-agents?manageable=1')), ['bob-bot']);
    assert.equal((await f.call(null, 'GET', '/api/hosted-agents?manageable=1')).status, 401);

    const audit = f.orgs.audit('comcom').map((e) => e.action);
    assert.ok(audit.includes('agent.create') && audit.includes('agent.update'), audit.join(','));

    // an organization with agents under it is not deleted
    const del = await f.call('alice', 'DELETE', '/api/orgs/comcom');
    assert.equal(del.status, 409);
    assert.equal(del.json.error.code, 'has_agents');

    // leaving the organization is an explicit `org: null`, and a personal agent cannot be private
    const left = await f.call('dave', 'PUT', '/api/hosted-agents/team-bot', agent({ id: 'team-bot', org: null, visibility: 'private' }));
    assert.equal(left.status, 200);
    assert.equal(left.json.agent.org, null);
    assert.equal(left.json.agent.visibility, 'public');
    assert.equal((await f.call('dave', 'PUT', '/api/hosted-agents/team-bot', agent({ id: 'team-bot' }))).status, 403, 'once personal, only its owner');
  } finally { await f.close(); }
});

test('a private organization agent is listed only to the callers the organization admits', async () => {
  const f = await fixture();
  try {
    await f.call('alice', 'POST', '/api/hosted-agents', agent({ id: 'secret-bot', org: 'comcom', visibility: 'private' }));
    await f.call('alice', 'POST', '/api/hosted-agents', agent({ id: 'core-bot', org: 'comcom', visibility: 'private', group: 'core' }));
    await f.call('alice', 'POST', '/api/hosted-agents', agent({ id: 'open-bot', org: 'comcom' }));
    await f.call('carol', 'POST', '/api/hosted-agents', agent({ id: 'carol-bot' }));

    assert.deepEqual(ids(await f.call(null, 'GET', '/api/hosted-agents')), ['carol-bot', 'open-bot']);
    assert.deepEqual(ids(await f.call('carol', 'GET', '/api/hosted-agents')), ['carol-bot', 'open-bot']);
    assert.deepEqual(ids(await f.call('bob', 'GET', '/api/hosted-agents')), ['carol-bot', 'open-bot', 'secret-bot'], 'a member sees private ones outside groups');
    assert.deepEqual(ids(await f.call('alice', 'GET', '/api/hosted-agents')), ['carol-bot', 'core-bot', 'open-bot', 'secret-bot']);

    assert.deepEqual(ids(await f.call('bob', 'GET', '/api/hosted-agents?org=comcom')), ['open-bot', 'secret-bot']);
    assert.equal((await f.call('carol', 'GET', '/api/hosted-agents?org=comcom')).status, 403);

    // the catalogue: an organization scope now includes the agents this node runs under it
    const cat = (r: { json: Record<string, any> }) => (r.json.agents as { id: string }[]).map((a) => a.id).sort();
    assert.deepEqual(cat(await f.call('bob', 'GET', '/api/agents?org=comcom')), ['open-bot', 'secret-bot']);
    assert.deepEqual(cat(await f.call('carol', 'GET', '/api/agents?org=comcom')), ['open-bot']);
    assert.deepEqual(cat(await f.call(null, 'GET', '/api/agents')), ['carol-bot', 'open-bot']);
    const row = (await f.call('bob', 'GET', '/api/agents?org=comcom')).json.agents.find((a: { id: string }) => a.id === 'secret-bot');
    assert.equal(row.org, 'comcom');
    assert.equal(row.visibility, 'private');

    // the organization's page counts them
    const page = await f.call('bob', 'GET', '/api/orgs/comcom');
    assert.equal(page.status, 200);
    assert.deepEqual((page.json.org.agents as { id: string }[]).map((a) => a.id).sort(), ['open-bot', 'secret-bot']);
    assert.equal(page.json.org.hidden_agents, 1, 'core-bot is in a group bob is not in');
  } finally { await f.close(); }
});

test('specs written before organizations load as personal and public', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hosted-org-legacy-'));
  try {
    const file = join(dir, 'h.json');
    writeFileSync(file, JSON.stringify({ agents: [{ id: 'old', name: 'Old', description: '', model: MODEL, systemPrompt: '', mode: 'prompt', files: {}, a2ui: false, allowedHosts: [], secretNames: [], skills: [], owner: '0xabc', version: 3, createdAt: 1, updatedAt: 2 }] }));
    const s = new HostedAgentStore(file).get('old')!;
    assert.equal(s.org, null);
    assert.equal(s.visibility, 'public');
    assert.equal(s.group, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
