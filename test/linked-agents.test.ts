/**
 * Linked agents: a person registers an external A2A agent by URL, and the node lists it, serves its card at
 * `/agents/<id>` and proxies calls to it — exactly as it does for the operator's config agents, with an owner.
 *
 *   node --test --import tsx test/linked-agents.test.ts
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
import { buildAgents, listAgents, agentAdverts, probeUpstreamCard } from '../src/agents.js';
import { LinkedAgentIdTakenError, LinkedAgentLimitError, LinkedAgentStore, normaliseOwner } from '../src/linked-agent-store.js';
import { linkedAgentRoutes, upstreamIsPublic } from '../src/linked-agent-routes.js';

const ALICE = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BOB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const SSO_CAROL = 'sso:carol-subject-1';

/** A whole A2A agent: a card, and `message/send` that echoes. What a person would register. */
function fakeAgent(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.get(['/.well-known/agent-card.json', '/.well-known/agent.json'], (_req, res) => res.json({
    protocolVersion: '0.3.0', name: 'Coffee Bot', description: 'Knows the cafes.', url: 'http://127.0.0.1:1/',
    capabilities: { streaming: false }, skills: [{ id: 'recommend', name: 'Recommend a cafe', tags: ['coffee'] }],
  }));
  app.post('/', (req, res) => {
    const text = req.body?.params?.message?.parts?.[0]?.text ?? '';
    res.json({ jsonrpc: '2.0', id: req.body?.id ?? null, result: { kind: 'message', role: 'agent', messageId: 'm1', parts: [{ kind: 'text', text: `you asked: ${text}` }] } });
  });
  const server = createServer(app);
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((done) => server.close(() => done())),
  })));
}

function nodeApp(store: LinkedAgentStore, cfg: NodeConfig): Promise<{ base: string; server: Server }> {
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as typeof req & { rawBody?: Buffer }).rawBody = buf; } }));
  app.use(linkedAgentRoutes({
    store,
    sessionPrincipal: (req) => req.header('x-test-principal') ?? null,
    reserved: (id) => id === 'proxied' || id === 'hosted-one',
    publicBase: () => 'https://node.example',
    probe: probeUpstreamCard,
    allowPrivateUpstream: true,
  }));
  app.use(buildAgents(cfg, { linked: store }));
  const server = createServer(app);
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server })));
}

test('the store: owner-scoped limits, no shadowing, wallet owners fold to lower case and SSO principals do not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'linked-store-'));
  try {
    const store = new LinkedAgentStore(join(dir, 'l.json'), { perOwner: 1, total: 2 });
    const a = store.create({ id: 'one', name: 'One', description: '', upstream: 'http://a.example' }, ALICE.toUpperCase().replace('0X', '0x'));
    assert.equal(a.owner, ALICE, 'an address is stored lower-case');
    assert.throws(() => store.create({ id: 'two', name: 'Two', description: '', upstream: 'http://b.example' }, ALICE), LinkedAgentLimitError);
    assert.throws(() => store.create({ id: 'one', name: 'Dup', description: '', upstream: 'http://c.example' }, BOB), LinkedAgentIdTakenError);
    assert.throws(() => store.create({ id: 'held', name: 'Held', description: '', upstream: 'http://c.example' }, BOB, (id) => id === 'held'), LinkedAgentIdTakenError, 'a reserved id is taken');
    const c = store.create({ id: 'three', name: 'Three', description: '', upstream: 'http://c.example' }, SSO_CAROL);
    assert.equal(c.owner, SSO_CAROL, 'an SSO subject keeps its case');
    assert.throws(() => store.create({ id: 'four', name: 'Four', description: '', upstream: 'http://d.example' }, BOB), LinkedAgentLimitError, 'the node total holds');
    assert.deepEqual(store.listByOwner(SSO_CAROL).map((x) => x.id), ['three']);
    // the file is the truth: a new store over the same file sees the same agents
    assert.deepEqual(new LinkedAgentStore(join(dir, 'l.json')).list().map((x) => x.id), ['one', 'three']);
    assert.equal(normaliseOwner('Sso:Mixed'), 'Sso:Mixed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a linked agent lists and advertises beside config agents, and a config agent wins a contested id', () => {
  const dir = mkdtempSync(join(tmpdir(), 'linked-list-'));
  try {
    const store = new LinkedAgentStore(join(dir, 'l.json'));
    store.create({ id: 'mine', name: 'Mine', description: 'd', upstream: 'http://x.example' }, ALICE);
    store.create({ id: 'proxied', name: 'Shadow', description: '', upstream: 'http://y.example' }, ALICE, () => false);
    const cfg = { agents: [{ id: 'proxied', upstream: 'http://127.0.0.1:9' }] } as unknown as NodeConfig;
    const rows = listAgents(cfg, store);
    assert.deepEqual(rows.map((r) => [r.id, r.owner ?? null]), [['proxied', null], ['mine', ALICE]]);
    const ads = agentAdverts(cfg, 'https://node.example', undefined, store);
    assert.deepEqual(ads.map((a) => [a.id, a.url, a.owner ?? null, a.kind]), [
      ['proxied', 'https://node.example/agents/proxied', null, 'upstream'],
      ['mine', 'https://node.example/agents/mine', ALICE, 'upstream'],
    ]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a private upstream is refused before any request is made; an IP literal is judged as is', async () => {
  assert.equal(await upstreamIsPublic('http://127.0.0.1:9200'), false);
  assert.equal(await upstreamIsPublic('http://10.1.2.3/'), false);
  assert.equal(await upstreamIsPublic('http://[::1]:8080/'), false);
  assert.equal(await upstreamIsPublic('http://8.8.8.8/'), true);
  assert.equal(await upstreamIsPublic('not a url'), false);
});

test('register over HTTP → catalogue row with owner → card and calls at /agents/<id> → only the owner may change or remove it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'linked-e2e-'));
  const agent = await fakeAgent();
  const store = new LinkedAgentStore(join(dir, 'l.json'));
  const cfg = { identity: { address: '0x1111111111111111111111111111111111111111' }, agents: [{ id: 'proxied', upstream: 'http://127.0.0.1:9' }], publicUrl: 'https://node.example' } as unknown as NodeConfig;
  const { base, server } = await nodeApp(store, cfg);
  const as = (who: string | null) => ({ 'content-type': 'application/json', ...(who ? { 'x-test-principal': who } : {}) });
  const post = (who: string | null, body: unknown) => fetch(`${base}/api/linked-agents`, { method: 'POST', headers: as(who), body: JSON.stringify(body) });
  try {
    const body = { id: 'coffee', upstream: agent.url };
    assert.equal((await post(null, body)).status, 401, 'nobody signed in');
    const bad = await post(ALICE, { id: 'Coffee!', upstream: agent.url });
    assert.equal(bad.status, 400);
    assert.equal(((await bad.json()) as { error: { code: string } }).error.code, 'invalid_request');
    assert.equal((await post(ALICE, { id: 'coffee', upstream: 'ftp://x' })).status, 400, 'upstream must be http(s)');
    assert.equal((await post(ALICE, { ...body, id: 'proxied' })).status, 409, 'a config agent holds the id');
    assert.equal((await post(ALICE, { ...body, id: 'hosted-one' })).status, 409, 'a hosted agent holds the id');

    // registered without a name: the card's name is taken, and the answer says the upstream answered
    const created = await post(ALICE, body);
    const createdText = await created.text();
    assert.equal(created.status, 201, createdText);
    const c = JSON.parse(createdText) as { agent: { name: string; description: string; owner: string; a2a_url: string; card_url: string; reachable: boolean; card: { skills: unknown[] } } };
    assert.equal(c.agent.name, 'Coffee Bot');
    assert.equal(c.agent.description, 'Knows the cafes.');
    assert.equal(c.agent.owner, ALICE);
    assert.equal(c.agent.a2a_url, 'https://node.example/agents/coffee');
    assert.equal(c.agent.card_url, 'https://node.example/agents/coffee/.well-known/agent-card.json');
    assert.equal(c.agent.reachable, true);
    assert.equal(c.agent.card.skills.length, 1);
    assert.equal((await post(BOB, body)).status, 409, 'the id is now taken by a linked agent');

    // an agent that is not up yet may still be registered, but then it needs a name
    const down = await post(ALICE, { id: 'later', upstream: 'http://127.0.0.1:9' });
    assert.equal(down.status, 400);
    assert.equal(((await down.json()) as { error: { code: string } }).error.code, 'name_required');
    const named = await post(ALICE, { id: 'later', name: 'Later', upstream: 'http://127.0.0.1:9' });
    assert.equal(named.status, 201);
    assert.equal(((await named.json()) as { agent: { reachable: boolean } }).agent.reachable, false);

    // an AIN SSO account may own one too — this is what an AIN Teams user without a wallet is
    const viaSso = await post(SSO_CAROL, { id: 'carols', name: 'Carol’s', upstream: agent.url });
    assert.equal(viaSso.status, 201);
    assert.equal(((await viaSso.json()) as { agent: { owner: string } }).agent.owner, SSO_CAROL);

    // mine
    const mine = (await (await fetch(`${base}/api/linked-agents?mine=1`, { headers: as(ALICE) })).json()) as { agents: { id: string }[] };
    assert.deepEqual(mine.agents.map((a) => a.id), ['coffee', 'later']);
    assert.equal((await fetch(`${base}/api/linked-agents?mine=1`)).status, 401);

    // the catalogue: config and linked in one list, the linked rows carrying their owner
    const all = (await (await fetch(`${base}/api/agents`)).json()) as { agents: { id: string; kind: string; owner: string | null; a2a_url: string; reachable: boolean | null; name: string }[] };
    assert.deepEqual(all.agents.map((a) => [a.id, a.kind, a.owner]).sort(), [
      ['carols', 'upstream', SSO_CAROL], ['coffee', 'upstream', ALICE], ['later', 'upstream', ALICE], ['proxied', 'upstream', null],
    ].sort());
    const coffee = all.agents.find((a) => a.id === 'coffee')!;
    assert.equal(coffee.a2a_url, 'https://node.example/agents/coffee');
    assert.equal(coffee.reachable, true);
    assert.equal(coffee.name, 'Coffee Bot');

    // the A2A surface, as AIN Teams uses it: the card is rewritten to the public address, the call is proxied
    const card = (await (await fetch(`${base}/agents/coffee/.well-known/agent-card.json`)).json()) as { name: string; url: string };
    assert.equal(card.name, 'Coffee Bot');
    assert.equal(card.url, 'https://node.example/agents/coffee', 'a caller never learns the upstream');
    const call = await fetch(`${base}/agents/coffee`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { kind: 'message', role: 'user', messageId: 'm', parts: [{ kind: 'text', text: 'hello' }] } },
    }) });
    assert.equal(call.status, 200);
    assert.match(JSON.stringify(await call.json()), /you asked: hello/);

    // ownership
    assert.equal((await fetch(`${base}/api/linked-agents/coffee`, { headers: as(BOB) })).status, 403);
    const detail = (await (await fetch(`${base}/api/linked-agents/coffee`, { headers: as(ALICE) })).json()) as { agent: { upstream: string } };
    assert.equal(detail.agent.upstream, agent.url, 'the owner sees the upstream; the catalogue never shows it');
    assert.equal((await fetch(`${base}/api/linked-agents/coffee`, { method: 'PUT', headers: as(BOB), body: JSON.stringify({ ...body, name: 'Stolen' }) })).status, 403);
    assert.equal((await fetch(`${base}/api/linked-agents/coffee`, { method: 'PUT', headers: as(ALICE), body: JSON.stringify({ ...body, id: 'other' }) })).status, 400, 'the id is the address');
    const upd = await fetch(`${base}/api/linked-agents/coffee`, { method: 'PUT', headers: as(ALICE), body: JSON.stringify({ ...body, name: 'Coffee Bot 2', description: 'renamed' }) });
    assert.equal(upd.status, 200);
    assert.equal(((await upd.json()) as { agent: { name: string; version: number } }).agent.version, 2);
    const renamed = (await (await fetch(`${base}/api/agents`)).json()) as { agents: { id: string; name: string }[] };
    // the card speaks for a reachable agent, so the catalogue keeps saying what the card says
    assert.equal(renamed.agents.find((a) => a.id === 'coffee')!.name, 'Coffee Bot');
    assert.equal((await fetch(`${base}/api/linked-agents/coffee`, { method: 'DELETE', headers: as(BOB) })).status, 403);
    assert.equal((await fetch(`${base}/api/linked-agents/coffee`, { method: 'DELETE', headers: as(ALICE) })).status, 200);
    assert.equal((await fetch(`${base}/agents/coffee/.well-known/agent-card.json`)).status, 404, 'gone from the address');
    assert.equal((await fetch(`${base}/api/linked-agents/coffee`, { headers: as(ALICE) })).status, 404);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await agent.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
