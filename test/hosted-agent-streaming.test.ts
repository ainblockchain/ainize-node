/**
 * Hosted agents stream (hostedAgentExecutor.executeStreaming): `message/stream` gets a task, the answer in
 * chunks as the model writes it, a line whenever the agent does something slow, and a final status with the whole
 * answer — while `message/send` still gets the one message it always did.
 *
 * Real pieces end to end: a fake model that streams the way vLLM does (text deltas, tool-call deltas, [DONE]), the
 * real gateway, the real runtime router and the A2A SDK's v0.3 JSON-RPC over HTTP.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { InferenceBackendRegistry } from '../src/inference-backends.js';
import { HostedAgentGateway } from '../src/hosted-agent-gateway.js';
import { hostedAgentSpecInput, type HostedAgentSpec } from '../src/hosted-agent-types.js';
import { createHostedAgentRuntimeRouter } from '../src/hosted-agent-runtime/hostedAgentRuntimeApp.js';
import { hostedAgentRuntimeSpecOf } from '../src/hosted-agent-types.js';
import { resetHostedAgentNativeToolsRefusedForTest } from '../src/hosted-agent-runtime/hostedAgentExecutor.js';

const MODEL = 'Stream-1';
let backend: Server;
let backendUrl = '';
const streamedRequests: boolean[] = [];

before(async () => {
  backend = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { stream?: boolean; messages: { role: string; content: unknown }[]; tools?: unknown[] };
    streamedRequests.push(!!body.stream);
    const lastUser = JSON.stringify([...body.messages].reverse().find((m) => m.role === 'user')?.content ?? '');
    const tool = body.messages.find((m) => m.role === 'tool');
    const wantsFile = /the file/.test(lastUser) && body.tools && !tool;
    const answer = tool ? 'The file says hello.' : '\n\nHello there, friend.';
    if (!body.stream) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: answer } }] }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta: unknown, finish: string | null = null) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    if (wantsFile) {
      // a tool call arrives in pieces, as vLLM streams it
      send({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_attachment', arguments: '' } }] });
      send({ tool_calls: [{ index: 0, function: { arguments: '{"number":' } }] });
      send({ tool_calls: [{ index: 0, function: { arguments: '1}' } }] }, 'tool_calls');
    } else {
      for (const piece of answer.match(/\s+|\S+\s*/g)!) { send({ content: piece }); await new Promise((r) => setTimeout(r, 5)); }
      send({}, 'stop');
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((r) => backend.listen(0, '127.0.0.1', () => r()));
  backendUrl = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;
});
after(async () => { await new Promise<void>((r) => backend.close(() => r())); });

async function startAgent() {
  const spec = { ...hostedAgentSpecInput.parse({ id: 'streamer', name: 'Streamer', model: MODEL }), owner: '0x' + 'a'.repeat(40), version: 1, createdAt: 0, updatedAt: 0 } as HostedAgentSpec;
  const gateway = new HostedAgentGateway({ registry: () => new InferenceBackendRegistry([{ id: 'llm', modality: 'chat', upstream: backendUrl, models: [MODEL], concurrency: 1 }]), spec: () => spec, log: () => {} });
  const url = await gateway.listen('127.0.0.1');
  const app = express();
  app.use(express.json());
  app.use('/a', createHostedAgentRuntimeRouter({ spec: hostedAgentRuntimeSpecOf(spec), gateway: { url, token: gateway.issue('streamer') }, secrets: {}, log: () => {}, module: null, cardUrl: 'http://h' }));
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/a`,
    close: async () => { await new Promise<void>((r) => server.close(() => r())); await gateway.close(); },
  };
}

const rpc = (method: string, parts: unknown[]) => JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { message: { kind: 'message', role: 'user', messageId: `m-${Math.random()}`, parts } } });

/** The `result`s of an SSE body, in order. */
const frames = (body: string) => body.split('\n').filter((l) => l.startsWith('data:')).map((l) => (JSON.parse(l.slice(5)) as { result: Record<string, unknown> }).result);

test('message/stream: a task, the answer in chunks as written, then the whole answer as the final status', async () => {
  resetHostedAgentNativeToolsRefusedForTest();
  const agent = await startAgent();
  try {
    const res = await fetch(agent.base, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: rpc('message/stream', [{ kind: 'text', text: 'hi' }]) });
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    const events = frames(await res.text());
    assert.equal(events[0]!.kind, 'task', 'the first event is the task');
    const chunks = events.filter((e) => e.kind === 'artifact-update') as { append: boolean; artifact: { parts: { text: string }[] } }[];
    assert.ok(chunks.length >= 3, `the answer arrived in pieces (${chunks.length})`);
    assert.equal(chunks[0]!.append, false);
    assert.ok(chunks.slice(1).every((c) => c.append), 'every later piece appends');
    assert.equal(chunks.map((c) => c.artifact.parts[0]!.text).join(''), 'Hello there, friend.', 'no leading blank lines, nothing lost');
    const last = events.at(-1) as { kind: string; final: boolean; status: { state: string; message: { parts: { text: string }[] } } };
    assert.equal(last.kind, 'status-update');
    assert.equal(last.final, true);
    assert.equal(last.status.state, 'completed');
    assert.equal(last.status.message.parts[0]!.text, 'Hello there, friend.', 'the final status carries the whole answer');
    assert.equal(streamedRequests.at(-1), true, 'the model was asked to stream');
  } finally { await agent.close(); }
});

test('message/stream: slow steps are reported while they run (opening a file)', async () => {
  resetHostedAgentNativeToolsRefusedForTest();
  const agent = await startAgent();
  try {
    const res = await fetch(agent.base, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: rpc('message/stream', [
      { kind: 'text', text: 'what does the file say?' },
      { kind: 'file', file: { bytes: Buffer.from('hello').toString('base64'), mimeType: 'text/plain', name: 'a.txt' } },
    ]) });
    const events = frames(await res.text());
    const working = events.filter((e) => e.kind === 'status-update' && (e.status as { state: string }).state === 'working') as { status: { message: { parts: { text: string }[] } } }[];
    assert.ok(working.some((w) => /Opening attached file 1/.test(w.status.message.parts[0]!.text)), 'the tool call was said out loud');
    const answer = (events.filter((e) => e.kind === 'artifact-update') as { artifact: { parts: { text: string }[] } }[]).map((c) => c.artifact.parts[0]!.text).join('');
    assert.equal(answer, 'The file says hello.');
    assert.equal((events.at(-1) as { status: { state: string } }).status.state, 'completed');
  } finally { await agent.close(); }
});

test('message/stream retried with the same messageId replays the finished task; the model runs once', async () => {
  resetHostedAgentNativeToolsRefusedForTest();
  const agent = await startAgent();
  try {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message/stream', params: { message: { kind: 'message', role: 'user', messageId: 'm-retry-stream', contextId: 'ctx-retry', parts: [{ kind: 'text', text: 'hi' }] } } });
    const before = streamedRequests.length;
    const first = frames(await (await fetch(agent.base, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body })).text());
    const taskId = first[0]!.id as string;
    assert.equal(streamedRequests.length, before + 1, 'one model call');
    const again = frames(await (await fetch(agent.base, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body })).text());
    assert.equal(streamedRequests.length, before + 1, 'the retry did not call the model again');
    assert.equal(again.length, 1, 'one event: the finished task');
    const replay = again[0] as { kind: string; id: string; status: { state: string }; artifacts: { parts: { text: string }[] }[] };
    assert.equal(replay.kind, 'task');
    assert.equal(replay.id, taskId, 'the very same task');
    assert.equal(replay.status.state, 'completed');
    assert.equal(replay.artifacts.map((a) => a.parts.map((p) => p.text).join('')).join(''), 'Hello there, friend.', 'with the whole answer');
  } finally { await agent.close(); }
});

test('message/send is unchanged: one message, the model not asked to stream', async () => {
  resetHostedAgentNativeToolsRefusedForTest();
  const agent = await startAgent();
  try {
    const before = streamedRequests.length;
    const res = await fetch(agent.base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: rpc('message/send', [{ kind: 'text', text: 'hi' }]) });
    const body = await res.json() as { result: { kind: string; parts: { text: string }[] } };
    assert.equal(body.result.kind, 'message');
    assert.equal(body.result.parts[0]!.text, 'Hello there, friend.');
    assert.deepEqual(streamedRequests.slice(before), [false]);
  } finally { await agent.close(); }
});
