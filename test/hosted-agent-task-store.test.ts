/**
 * A prompt agent's A2A tasks outlive its runtime router (hosted-agent-task-store.ts): `tasks/get` answers after a
 * restart (a new process opening the same file), after the node's home is restored from a copy of that file, and
 * after the agent is updated — and a task that was running when the process ended comes back as `failed`, not
 * as "working" forever. Real gateway, real runtime router, the SDK's JSON-RPC over HTTP, a fake streaming model.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { copyFileSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { InferenceBackendRegistry } from '../src/inference-backends.js';
import { HostedAgentGateway } from '../src/hosted-agent-gateway.js';
import { hostedAgentSpecInput, hostedAgentRuntimeSpecOf, type HostedAgentSpec } from '../src/hosted-agent-types.js';
import { createHostedAgentRuntimeRouter } from '../src/hosted-agent-runtime/hostedAgentRuntimeApp.js';
import { HOSTED_AGENT_TASK_INTERRUPTED, HostedAgentTaskFile } from '../src/hosted-agent-task-store.js';

const MODEL = 'Persist-1';
let backend: Server;
let backendUrl = '';
let dir = '';

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ainize-tasks-'));
  backend = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const piece of ['Kept ', 'across ', 'restarts.']) res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((r) => backend.listen(0, '127.0.0.1', () => r()));
  backendUrl = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise<void>((r) => backend.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

const spec = { ...hostedAgentSpecInput.parse({ id: 'keeper', name: 'Keeper', model: MODEL }), owner: '0x' + 'b'.repeat(40), version: 1, createdAt: 0, updatedAt: 0 } as HostedAgentSpec;

/** One "process": a runtime router for the agent whose tasks live in `file`. */
async function startAgent(tasks: HostedAgentTaskFile | null) {
  const gateway = new HostedAgentGateway({ registry: () => new InferenceBackendRegistry([{ id: 'llm', modality: 'chat', upstream: backendUrl, models: [MODEL], concurrency: 1 }]), spec: () => spec, log: () => {} });
  const url = await gateway.listen('127.0.0.1');
  const app = express();
  app.use(express.json());
  app.use('/a', createHostedAgentRuntimeRouter({ spec: hostedAgentRuntimeSpecOf(spec), gateway: { url, token: gateway.issue('keeper') }, secrets: {}, log: () => {}, module: null, cardUrl: 'http://h', taskStore: tasks?.forAgent('keeper') }));
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/a`,
    close: async () => { await new Promise<void>((r) => server.close(() => r())); await gateway.close(); },
  };
}

async function streamTask(base: string): Promise<string> {
  const res = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message/stream', params: { message: { kind: 'message', role: 'user', messageId: `m-${Math.random()}`, parts: [{ kind: 'text', text: 'hello' }] } } }) });
  const body = await res.text();
  const first = JSON.parse(body.split('\n').find((l) => l.startsWith('data:'))!.slice(5)) as { result: { id: string } };
  return first.result.id;
}

async function getTask(base: string, id: string) {
  const res = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tasks/get', params: { id } }) });
  return (await res.json()) as { result?: { id: string; status: { state: string; message?: { parts: { text?: string }[] } }; artifacts?: { parts: { text?: string }[] }[] }; error?: { message: string } };
}

test('without a persistent store (the old behaviour) a restart forgets the task', async () => {
  const a = await startAgent(null);
  const id = await streamTask(a.base);
  assert.equal((await getTask(a.base, id)).result?.status.state, 'completed');
  await a.close();
  const b = await startAgent(null);
  assert.match((await getTask(b.base, id)).error?.message ?? '', /Task not found/);
  await b.close();
});

test('a finished task is still answered by tasks/get after a restart, and after the home is restored from a copy', async () => {
  const file = join(dir, 'restart.sqlite');
  let tasks = new HostedAgentTaskFile(file);
  const a = await startAgent(tasks);
  const id = await streamTask(a.base);
  const before = await getTask(a.base, id);
  assert.equal(before.result?.status.state, 'completed');
  await a.close();
  tasks.close();
  assert.equal(statSync(file).mode & 0o777, 0o600, 'the task file is private to the node');

  // restart: a new process opens the same file
  tasks = new HostedAgentTaskFile(file);
  const b = await startAgent(tasks);
  const after = await getTask(b.base, id);
  assert.equal(after.result?.status.state, 'completed');
  assert.deepEqual(after.result, before.result, 'the task reads back exactly as it was');
  await b.close();
  tasks.close();

  // restore: the file is lost, a backup copy is put back
  const backup = join(dir, 'backup.sqlite');
  copyFileSync(file, backup);
  rmSync(file);
  tasks = new HostedAgentTaskFile(file);
  const c = await startAgent(tasks);
  assert.match((await getTask(c.base, id)).error?.message ?? '', /Task not found/, 'destroyed: gone');
  await c.close();
  tasks.close();
  rmSync(file); rmSync(`${file}-wal`, { force: true }); rmSync(`${file}-shm`, { force: true });
  copyFileSync(backup, file);
  tasks = new HostedAgentTaskFile(file);
  const d = await startAgent(tasks);
  assert.deepEqual((await getTask(d.base, id)).result, before.result, 'restored: back');
  await d.close();
  tasks.close();
});

test('a task that was running when the process ended comes back failed, with a message that says so', async () => {
  const file = join(dir, 'inflight.sqlite');
  let tasks = new HostedAgentTaskFile(file);
  const store = tasks.forAgent('keeper');
  const ctx = { user: { isAuthenticated: false, userName: '' } } as never;
  await store.save({ id: 'run-1', contextId: 'ctx-1', status: { state: 2, timestamp: new Date().toISOString() }, artifacts: [], history: [], metadata: undefined } as never, ctx);
  tasks.close(); // the process ends mid-task

  tasks = new HostedAgentTaskFile(file);
  const a = await startAgent(tasks);
  const got = await getTask(a.base, 'run-1');
  assert.equal(got.result?.status.state, 'failed');
  assert.equal(got.result?.status.message?.parts[0]?.text, HOSTED_AGENT_TASK_INTERRUPTED);
  await a.close();
  tasks.close();
  // …and stays failed (the mark was written, not recomputed)
  tasks = new HostedAgentTaskFile(file);
  const b = await startAgent(tasks);
  assert.equal((await getTask(b.base, 'run-1')).result?.status.state, 'failed');
  await b.close();
  tasks.close();
});

test('an update of the agent (a new router in the same process) keeps its tasks; removing the agent drops them', async () => {
  const tasks = new HostedAgentTaskFile(join(dir, 'update.sqlite'));
  const a = await startAgent(tasks);
  const id = await streamTask(a.base);
  await a.close();
  const b = await startAgent(tasks); // forAgent returns the same store: no re-read, no "interrupted" mark
  assert.equal((await getTask(b.base, id)).result?.status.state, 'completed');
  await b.close();
  assert.equal(tasks.count('keeper'), 1);
  tasks.removeAgent('keeper');
  assert.equal(tasks.count('keeper'), 0);
  tasks.close();
});

test('retention: tasks older than the window and beyond the per-agent cap are dropped when the store opens', async () => {
  const file = join(dir, 'retention.sqlite');
  let now = Date.parse('2026-01-01T00:00:00Z');
  let tasks = new HostedAgentTaskFile(file, { now: () => now, retentionMs: 3600_000, maxPerAgent: 2 });
  const store = tasks.forAgent('keeper');
  const ctx = { user: { isAuthenticated: false, userName: '' } } as never;
  for (const [i, dt] of [[1, 0], [2, 3000_000], [3, 3100_000], [4, 3200_000]] as const) {
    now = Date.parse('2026-01-01T00:00:00Z') + dt;
    await store.save({ id: `t-${i}`, contextId: 'c', status: { state: 3, timestamp: new Date(now).toISOString() }, artifacts: [], history: [], metadata: undefined } as never, ctx);
  }
  tasks.close();
  now = Date.parse('2026-01-01T00:00:00Z') + 3700_000; // t-1 is past the hour
  tasks = new HostedAgentTaskFile(file, { now: () => now, retentionMs: 3600_000, maxPerAgent: 2 });
  const reopened = tasks.forAgent('keeper');
  assert.equal(await reopened.load('t-1', ctx), undefined, 'past retention');
  assert.equal(await reopened.load('t-2', ctx), undefined, 'beyond the cap (oldest first)');
  assert.equal((await reopened.load('t-3', ctx))?.id, 't-3');
  assert.equal((await reopened.load('t-4', ctx))?.id, 't-4');
  tasks.close();
});
