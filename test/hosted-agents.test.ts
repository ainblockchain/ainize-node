/**
 * Hosted agents: a model becomes an A2A agent this node runs.
 *
 * The end-to-end tests here run a fake OpenAI backend, the real gateway, the real in-process runtime (prompt
 * mode) and the real agents.ts proxy, and speak A2A to `/agents/<id>` the way a workspace would. Docker is not
 * needed: code modes are exercised through the executor directly, and their container path has its own test
 * (hosted-agents-docker.test.ts) that skips on a machine without a daemon.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';
import type { NodeConfig } from '@ainize/core';
import { buildAgents } from '../src/agents.js';
import { InferenceBackendRegistry } from '../src/inference-backends.js';
import { HostedAgentGateway, hostedAgentAddressIsPublic, hostedAgentHostAllowed, hostedAgentEgress } from '../src/hosted-agent-gateway.js';
import { HostedAgentHost } from '../src/hosted-agent-host.js';
import { HostedAgentSecretStore } from '../src/hosted-agent-secrets.js';
import { HostedAgentIdTakenError, HostedAgentLimitError, HostedAgentStore } from '../src/hosted-agent-store.js';
import { hostedAgentRoutes } from '../src/hosted-agent-routes.js';
import { hostedAgentSpecInput, type HostedAgentSpec } from '../src/hosted-agent-types.js';
import { HostedAgentExecutor, hostedAgentTextOf, hostedAgentNativeToolsUnsupported, resetHostedAgentNativeToolsRefusedForTest } from '../src/hosted-agent-runtime/hostedAgentExecutor.js';
import { hostedAgentModuleOf, hostedAgentEnvValue } from '../src/hosted-agent-runtime/hostedAgentRuntimeMain.js';
import { hostedAgentCard } from '../src/hosted-agent-runtime/hostedAgentRuntimeApp.js';

const MODEL = 'Test-Chat-1';
const ALICE = '0x00000000000000000000000000000000000a11ce';
const BOB = '0x0000000000000000000000000000000000000b0b';

// ───────────────────────────────────────────── egress guard

test('non-public addresses are refused, including the IPv4 inside IPv6', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '64:ff9b::a00:1'.replace('a00:1', '10.0.0.1')]) {
    assert.equal(hostedAgentAddressIsPublic(ip), false, ip);
  }
  for (const ip of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111', '::ffff:1.1.1.1']) assert.equal(hostedAgentAddressIsPublic(ip), true, ip);
  assert.equal(hostedAgentAddressIsPublic('not-an-ip'), false);
});

test('an allowlist matches names, one-level-or-deeper wildcards and *, and nothing else', () => {
  assert.equal(hostedAgentHostAllowed('api.example.com', ['api.example.com']), true);
  assert.equal(hostedAgentHostAllowed('API.Example.com.', ['api.example.com']), true);
  assert.equal(hostedAgentHostAllowed('evil-example.com', ['*.example.com']), false);
  assert.equal(hostedAgentHostAllowed('example.com', ['*.example.com']), false, 'the wildcard needs a label in front');
  assert.equal(hostedAgentHostAllowed('a.b.example.com', ['*.example.com']), true);
  assert.equal(hostedAgentHostAllowed('anything.org', ['*']), true);
  assert.equal(hostedAgentHostAllowed('anything.org', []), false);
});

test('egress refuses a name that resolves to loopback, even when every host is allowed', async () => {
  await assert.rejects(hostedAgentEgress({ url: 'http://localhost:9/' }, ['*']), /non-public/);
});

test('egress refuses IP literals, other schemes and hosts off the list', async () => {
  await assert.rejects(hostedAgentEgress({ url: 'http://1.1.1.1/' }, ['*']), /address/);
  await assert.rejects(hostedAgentEgress({ url: 'file:///etc/passwd' }, ['*']), /only http/);
  await assert.rejects(hostedAgentEgress({ url: 'https://example.org/' }, ['example.com']), /not in this agent's allowed hosts/);
});

// ───────────────────────────────────────────── spec, store, secrets

const input = (over: Record<string, unknown> = {}) => hostedAgentSpecInput.parse({ id: 'helper', name: 'Helper', model: MODEL, systemPrompt: 'Be brief.', ...over });

test('spec validation: code modes need index.mjs, prompt mode takes no files, hosts are names', () => {
  assert.equal(hostedAgentSpecInput.safeParse({ id: 'x', name: 'X', model: MODEL, mode: 'handler' }).success, false);
  assert.equal(hostedAgentSpecInput.safeParse({ id: 'x', name: 'X', model: MODEL, mode: 'prompt', files: { 'index.mjs': 'x' } }).success, false);
  assert.equal(hostedAgentSpecInput.safeParse({ id: 'x', name: 'X', model: MODEL, mode: 'handler', files: { 'index.mjs': 'export default {}' } }).success, true);
  assert.equal(hostedAgentSpecInput.safeParse({ id: 'x', name: 'X', model: MODEL, allowedHosts: ['10.0.0.1'] }).success, false);
  assert.equal(hostedAgentSpecInput.safeParse({ id: 'x', name: 'X', model: MODEL, allowedHosts: ['*.example.com', '*'] }).success, true);
  assert.equal(hostedAgentSpecInput.safeParse({ id: 'X!', name: 'X', model: MODEL }).success, false);
  assert.equal(hostedAgentSpecInput.safeParse({ id: 'x', name: 'X', model: MODEL, mode: 'handler', files: { '../escape.mjs': 'x', 'index.mjs': 'x' } }).success, false);
  assert.equal(hostedAgentSpecInput.safeParse({ id: 'x', name: 'X', model: MODEL, secretNames: ['lower'] }).success, false);
});

test('the store enforces per-owner and total limits, keeps ids unique and survives a reload', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hosted-store-'));
  try {
    const file = join(dir, 'h.json');
    const store = new HostedAgentStore(file, { perOwner: 2, total: 3 });
    store.create(input({ id: 'a1' }), ALICE);
    store.create(input({ id: 'a2' }), ALICE.toUpperCase());
    assert.throws(() => store.create(input({ id: 'a3' }), ALICE), HostedAgentLimitError);
    assert.throws(() => store.create(input({ id: 'a1' }), BOB), HostedAgentIdTakenError);
    assert.throws(() => store.create(input({ id: 'news' }), BOB, (id) => id === 'news'), HostedAgentIdTakenError, 'config agents are reserved');
    store.create(input({ id: 'b1' }), BOB);
    assert.throws(() => store.create(input({ id: 'b2' }), BOB), HostedAgentLimitError);
    const updated = store.update('a1', input({ id: 'a1', name: 'Renamed' }));
    assert.equal(updated.version, 2);
    assert.equal(updated.owner, ALICE);
    const again = new HostedAgentStore(file);
    assert.equal(again.get('a1')?.name, 'Renamed');
    assert.equal(again.listByOwner(ALICE).length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('secrets are encrypted at rest, bound to their agent and name, and only declared names are revealed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hosted-secrets-'));
  try {
    const s = new HostedAgentSecretStore(join(dir, 's.json'), join(dir, 's.key'));
    s.set('a1', 'API_KEY', 'sk-live-123');
    assert.equal(readFileSync(join(dir, 's.json'), 'utf8').includes('sk-live-123'), false);
    const again = new HostedAgentSecretStore(join(dir, 's.json'), join(dir, 's.key'));
    assert.deepEqual(again.reveal('a1', ['API_KEY', 'OTHER']), { API_KEY: 'sk-live-123' });
    assert.deepEqual(again.reveal('a1', []), {}, 'a name dropped from the spec stops being delivered');
    again.clear('a1', 'API_KEY');
    assert.deepEqual(again.names('a1'), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ───────────────────────────────────────────── runtime pieces

test('a module may default-export or export by name; env values decode from b64', () => {
  const run = async () => 'x';
  assert.equal(hostedAgentModuleOf({ default: { execute: run } }).execute, run);
  assert.equal(hostedAgentModuleOf({ execute: run }).execute, run);
  assert.equal(hostedAgentEnvValue(`b64:${Buffer.from('a\nb').toString('base64')}`), 'a\nb');
  assert.equal(hostedAgentEnvValue('plain'), 'plain');
});

test('text parts are read in both protocol shapes', () => {
  assert.equal(hostedAgentTextOf({ parts: [{ kind: 'text', text: 'a' }, { content: { $case: 'text', value: 'b' } }, { kind: 'data' }] }), 'a\nb');
});

test('the card declares both protocol versions, the A2UI extension when asked, and its model', () => {
  const card = hostedAgentCard({ id: 'x', name: 'X', description: '', model: MODEL, systemPrompt: '', mode: 'prompt', a2ui: true, skills: [], version: 3 }, 'http://h/a/x');
  assert.deepEqual(card.supportedInterfaces.map((i) => i.protocolVersion), ['1.0', '0.3']);
  assert.equal(card.capabilities.extensions.length, 1);
  assert.equal(card.skills.length, 1, 'an agent with no declared skills still offers one');
  assert.deepEqual(card.metadata, { ainize: { model: MODEL, mode: 'prompt' } });
});

// ───────────────────────────────────────────── fake model backend + gateway

let backend: Server;
let backendUrl = '';
const seen: Record<string, unknown>[] = [];

before(async () => {
  backend = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { model: string; messages: { role: string; content: string | null }[]; tools?: unknown[] };
    seen.push(body);
    const sys = body.messages.find((m) => m.role === 'system')?.content ?? '';
    const lastUser = [...body.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const toolResult = body.messages.find((m) => m.role === 'tool');
    res.setHeader('content-type', 'application/json');
    if (body.tools?.length && !toolResult) {
      res.end(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'add', arguments: '{"a":2,"b":3}' } }] } }] }));
      return;
    }
    const answer = toolResult ? `sum is ${toolResult.content}` : `[${body.model}] sys=${sys} | you said: ${lastUser} | turns=${body.messages.length}`;
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: answer } }] }));
  });
  await new Promise<void>((r) => backend.listen(0, '127.0.0.1', () => r()));
  backendUrl = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;
});
after(async () => { await new Promise<void>((r) => backend.close(() => r())); });

const registry = () => new InferenceBackendRegistry([
  { id: 'llm', modality: 'chat', upstream: backendUrl, models: [MODEL], concurrency: 1 },
  { id: 'img', modality: 'image', upstream: backendUrl, models: ['Test-Image-1'], concurrency: 1 },
]);

const specOf = (over: Partial<HostedAgentSpec>): HostedAgentSpec => ({
  ...input(), owner: ALICE, version: 1, createdAt: 0, updatedAt: 0, ...over,
} as HostedAgentSpec);

test('tools mode: the model asks for a tool, the tool runs, the result goes back, the answer comes out', async () => {
  const spec = specOf({ id: 'calc', mode: 'tools', files: { 'index.mjs': '' } });
  const gateway = new HostedAgentGateway({ registry, spec: () => spec, log: () => {} });
  try {
    const url = await gateway.listen('127.0.0.1');
    const ran: unknown[] = [];
    const ex = new HostedAgentExecutor({
      spec, gateway: { url, token: gateway.issue('calc') }, secrets: {}, log: () => {},
      module: { tools: [{ name: 'add', parameters: { type: 'object' }, run: (args) => { ran.push(args); return { value: Number(args.a) + Number(args.b), ui: [{ version: 'v0.9' }] }; } }] },
    });
    const out = await ex.turn('what is 2+3', 'ctx-1');
    assert.deepEqual(ran, [{ a: 2, b: 3 }]);
    assert.equal(out.text, 'sum is {"value":5}', 'the model sees the data, not the surface');
    assert.equal(out.parts.length, 1, 'the surface a tool returned travels as an A2UI part');
  } finally { await gateway.close(); }
});

test('tools mode falls back to a JSON tool protocol when the backend refuses native tool calls', async () => {
  const bodies: { tools?: unknown; messages: { role: string; content: string }[] }[] = [];
  const refusing = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as (typeof bodies)[number];
    bodies.push(body);
    res.setHeader('content-type', 'application/json');
    if (body.tools) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: { message: '"auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set' } }));
      return;
    }
    const last = body.messages.at(-1)!.content;
    const content = last === 'number please' ? '{"answer": 5555}' : last.startsWith('TOOL RESULT') ? JSON.stringify({ answer: `done: ${last}` }) : '```json\n{"tool":"add","arguments":{"a":1,"b":2}}\n```';
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }] }));
  });
  await new Promise<void>((r) => refusing.listen(0, '127.0.0.1', () => r()));
  const reg = () => new InferenceBackendRegistry([{ id: 'llm', modality: 'chat', upstream: `http://127.0.0.1:${(refusing.address() as AddressInfo).port}`, models: [MODEL], concurrency: 1 }]);
  const spec = specOf({ id: 'calc2', mode: 'tools', files: { 'index.mjs': '' } });
  const gateway = new HostedAgentGateway({ registry: reg, spec: () => spec, log: () => {} });
  resetHostedAgentNativeToolsRefusedForTest();
  try {
    const url = await gateway.listen('127.0.0.1');
    const ex = new HostedAgentExecutor({
      spec, gateway: { url, token: gateway.issue('calc2') }, secrets: {}, log: () => {},
      module: { tools: [{ name: 'add', description: 'adds', run: (a) => ({ sum: Number(a.a) + Number(a.b) }) }] },
    });
    assert.equal((await ex.turn('1+2?', 'c')).text, 'done: TOOL RESULT (add): {"sum":3}');
    const before = bodies.length;
    await ex.turn('again', 'c2');
    assert.equal(bodies.slice(before).some((b) => b.tools), false, 'a refusing backend is not asked for native tools again');
    assert.equal((await ex.turn('number please', 'c3')).text, '5555', 'a non-string answer is still the answer');
    assert.equal(hostedAgentNativeToolsUnsupported('model does not exist'), false);
  } finally {
    resetHostedAgentNativeToolsRefusedForTest();
    await gateway.close();
    await new Promise<void>((r) => refusing.close(() => r()));
  }
});

test('handler mode: execute decides the reply, with A2UI, secrets and the model through ctx', async () => {
  const spec = specOf({ id: 'scorer', mode: 'handler', files: { 'index.mjs': '' } });
  const gateway = new HostedAgentGateway({ registry, spec: () => spec, log: () => {} });
  try {
    const url = await gateway.listen('127.0.0.1');
    const ex = new HostedAgentExecutor({
      spec, gateway: { url, token: gateway.issue('scorer') }, secrets: { API_KEY: 'k' }, log: () => {},
      module: {
        execute: async (text, ctx) => {
          const words = text.split(/\s+/).length;
          const m = await ctx.llm.chat({ messages: [{ role: 'user', content: 'ping' }] });
          return { text: `${words} words; key=${ctx.secret('API_KEY')}; ${m.message.content}`, ui: ctx.ui.surface('s', [ctx.ui.text('root', ctx.ui.bind('/w'))], { w: words }) };
        },
      },
    });
    const out = await ex.turn('one two three', 'c');
    assert.match(out.text, /^3 words; key=k; \[Test-Chat-1\]/);
    assert.equal(out.parts.length, 3, 'createSurface, updateComponents, updateDataModel');
    assert.equal((out.parts[0] as { mediaType: string }).mediaType, 'application/json+a2ui');
  } finally { await gateway.close(); }
});

test('the gateway pins the model and refuses unknown tokens', async () => {
  const spec = specOf({ id: 'pin' });
  const gateway = new HostedAgentGateway({ registry, spec: () => spec, log: () => {} });
  try {
    const url = await gateway.listen('127.0.0.1');
    const token = gateway.issue('pin');
    const r = await fetch(`${url}/t/${token}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'someone-elses-model', messages: [{ role: 'user', content: 'x' }] }) });
    assert.equal(r.status, 200);
    assert.equal((seen.at(-1) as { model: string }).model, MODEL);
    const bad = await fetch(`${url}/t/${'0'.repeat(48)}/v1/models`);
    assert.equal(bad.status, 401);
    gateway.revoke(token);
    assert.equal((await fetch(`${url}/t/${token}/v1/models`)).status, 401, 'a revoked token is dead');
    const refused = await fetch(`${url}/t/${gateway.issue('pin')}/egress`, { method: 'POST', body: JSON.stringify({ url: 'http://localhost:1/' }) });
    assert.equal(refused.status, 403);
    assert.equal(refused.headers.get('x-egress-refused'), '1');
  } finally { await gateway.close(); }
});

// ───────────────────────────────────────────── the whole path: HTTP API → /agents/<id> over A2A

test('create over HTTP, list under the model, call over A2A (v0.3 and v1.0), and only the owner may change it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hosted-e2e-'));
  const store = new HostedAgentStore(join(dir, 'h.json'));
  const secrets = new HostedAgentSecretStore(join(dir, 's.json'), join(dir, 's.key'));
  const gateway = new HostedAgentGateway({ registry, spec: (id) => store.get(id), log: () => {} });
  const host = new HostedAgentHost({ gateway, secrets, docker: null, idleStopMs: 60_000, maxRunning: 2, log: () => {} });
  await host.start([]);
  const cfg = { identity: { address: '0x1111111111111111111111111111111111111111' }, agents: [{ id: 'proxied', upstream: 'http://127.0.0.1:9' }], publicUrl: 'https://node.example' } as unknown as NodeConfig;
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as typeof req & { rawBody?: Buffer }).rawBody = buf; } }));
  app.use(hostedAgentRoutes({
    store, secrets, host, registry,
    sessionAddress: (req) => req.header('x-test-address')?.toLowerCase() ?? null,
    reserved: (id) => id === 'proxied',
    publicBase: () => 'https://node.example',
  }));
  app.use(buildAgents(cfg, { hosted: { host, store } }));
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const as = (who: string | null) => ({ 'content-type': 'application/json', ...(who ? { 'x-test-address': who } : {}) });
  try {
    const body = { id: 'helper', name: 'Helper', description: 'Answers briefly', model: MODEL, systemPrompt: 'Be brief.' };
    assert.equal((await fetch(`${base}/api/hosted-agents`, { method: 'POST', headers: as(null), body: JSON.stringify(body) })).status, 401);
    const wrongModel = await fetch(`${base}/api/hosted-agents`, { method: 'POST', headers: as(ALICE), body: JSON.stringify({ ...body, model: 'Test-Image-1' }) });
    assert.equal(wrongModel.status, 400, 'an image model is not a base for an agent');
    const noDocker = await fetch(`${base}/api/hosted-agents`, { method: 'POST', headers: as(ALICE), body: JSON.stringify({ ...body, mode: 'handler', files: { 'index.mjs': 'export default {}' } }) });
    assert.equal(noDocker.status, 501);
    assert.equal(((await noDocker.json()) as { error: { code: string } }).error.code, 'docker_unavailable');
    assert.equal((await fetch(`${base}/api/hosted-agents`, { method: 'POST', headers: as(ALICE), body: JSON.stringify({ ...body, id: 'proxied' }) })).status, 409);

    const created = await fetch(`${base}/api/hosted-agents`, { method: 'POST', headers: as(ALICE), body: JSON.stringify(body) });
    assert.equal(created.status, 201);
    const c = await created.json() as { a2a_url: string; agent: { status: string } };
    assert.equal(c.a2a_url, 'https://node.example/agents/helper');
    assert.equal(c.agent.status, 'ready');

    const listed = await (await fetch(`${base}/api/agents?model=${MODEL}`)).json() as { agents: { id: string; model: string; kind: string; owner: string }[] };
    assert.deepEqual(listed.agents.map((a) => [a.id, a.model, a.kind, a.owner]), [['helper', MODEL, 'prompt', ALICE]]);
    const all = await (await fetch(`${base}/api/agents`)).json() as { agents: { id: string; kind: string }[] };
    assert.deepEqual(all.agents.map((a) => a.id).sort(), ['helper', 'proxied'], 'config agents and hosted agents in one list');

    const card = await (await fetch(`${base}/agents/helper/.well-known/agent-card.json`, { headers: { 'A2A-Version': '1.0' } })).json() as { name: string; supportedInterfaces: { url: string }[] };
    assert.equal(card.name, 'Helper');
    assert.equal(card.supportedInterfaces[0]!.url, 'https://node.example/agents/helper', 'the card names the public address, not loopback');

    // v0.3 — what AIN Teams sends (no A2A-Version header)
    const call = async (text: string, contextId?: string) => {
      const r = await fetch(`${base}/agents/helper`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'message/send',
        params: { message: { kind: 'message', role: 'user', messageId: `m-${Math.random()}`, ...(contextId ? { contextId } : {}), parts: [{ kind: 'text', text }] } },
      }) });
      return await r.json() as { result?: { parts: { kind: string; text?: string }[]; contextId: string }; error?: unknown };
    };
    const first = await call('hello there');
    assert.ok(first.result, JSON.stringify(first));
    assert.match(first.result!.parts[0]!.text!, /^\[Test-Chat-1\] sys=Be brief\. \| you said: hello there \| turns=2$/);
    const second = await call('again', first.result!.contextId);
    assert.match(second.result!.parts[0]!.text!, /turns=4$/, 'the conversation is remembered per context');

    // message/stream — what most workspaces send first; one turn, one event, over SSE
    const streamed = await fetch(`${base}/agents/helper`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify({
      jsonrpc: '2.0', id: 3, method: 'message/stream',
      params: { message: { kind: 'message', role: 'user', messageId: 'm-stream', parts: [{ kind: 'text', text: 'streamed hello' }] } },
    }) });
    assert.equal(streamed.status, 200);
    assert.match(streamed.headers.get('content-type') ?? '', /text\/event-stream/);
    assert.match(await streamed.text(), /you said: streamed hello/);

    // v1.0
    const v1 = await fetch(`${base}/agents/helper`, { method: 'POST', headers: { 'content-type': 'application/json', 'A2A-Version': '1.0' }, body: JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'SendMessage',
      params: { message: { role: 'ROLE_USER', messageId: 'm-v1', parts: [{ text: 'v1 hello' }] } },
    }) });
    const v1Body = await v1.json() as { result?: unknown; error?: unknown };
    assert.ok(v1Body.result, `v1.0 call failed: ${JSON.stringify(v1Body)}`);
    assert.match(JSON.stringify(v1Body.result), /you said: v1 hello/);

    // ownership
    assert.equal((await fetch(`${base}/api/hosted-agents/helper`, { headers: as(BOB) })).status, 403);
    const upd = await fetch(`${base}/api/hosted-agents/helper`, { method: 'PUT', headers: as(ALICE), body: JSON.stringify({ ...body, systemPrompt: 'Be very brief.' }) });
    assert.equal(upd.status, 200);
    assert.match((await call('x')).result!.parts[0]!.text!, /sys=Be very brief\./, 'an update is live on the next call');
    assert.equal((await fetch(`${base}/api/hosted-agents/helper/secrets/NOPE`, { method: 'PUT', headers: as(ALICE), body: JSON.stringify({ value: 'v' }) })).status, 400);
    assert.equal((await fetch(`${base}/api/hosted-agents/helper`, { method: 'DELETE', headers: as(BOB) })).status, 403);
    assert.equal((await fetch(`${base}/api/hosted-agents/helper`, { method: 'DELETE', headers: as(ALICE) })).status, 200);
    assert.equal((await fetch(`${base}/agents/helper`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 404);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await host.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
