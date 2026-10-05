import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HostedAgentHost, hostedAgentScheduleIds } from '../src/hosted-agent-host.js';
import { HostedAgentGateway } from '../src/hosted-agent-gateway.js';
import { HostedAgentSecretStore } from '../src/hosted-agent-secrets.js';
import { hostedAgentSpecInput } from '../src/hosted-agent-types.js';
import { createHostedAgentRuntimeRouter } from '../src/hosted-agent-runtime/hostedAgentRuntimeApp.js';

const spec = id => ({ ...hostedAgentSpecInput.parse({ id, name: id, model: 'unused', mode: 'handler', files: { 'index.mjs': 'export default {}' } }),
  version: 1, owner: 'test', createdAt: 1, updatedAt: 1 });
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

test('schedule is an explicit operator allowlist with validated ids', () => {
  assert.deepEqual(hostedAgentScheduleIds(undefined), []);
  assert.deepEqual(hostedAgentScheduleIds(' ainteams-qa,ainmem-qa,ainteams-qa '), ['ainteams-qa', 'ainmem-qa']);
  for (const value of ['*', '../agent', 'x,,y', Array.from({ length: 33 }, (_, i) => `a${i}`).join(',')]) assert.throws(() => hostedAgentScheduleIds(value));
});

test('runtime tick requires the host token and repeats observe one active execution', async () => {
  let calls = 0, release;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const app = express();
  app.use(createHostedAgentRuntimeRouter({ spec: spec('tick'), gateway: { url: 'http://unused', token: 'host-secret' }, secrets: {},
    log: () => {}, cardUrl: 'http://unused', module: { tick: async () => { calls++; await blocked; } } }));
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/_ainize/tick`;
  try {
    assert.equal((await fetch(url, { method: 'POST' })).status, 401); assert.equal(calls, 0);
    const invoke = () => fetch(url, { method: 'POST', headers: { authorization: 'Bearer host-secret' } }).then(r => r.json());
    assert.equal((await invoke()).running, true);
    assert.equal((await invoke()).running, true); assert.equal(calls, 1);
    release(); await turn();
    assert.equal((await invoke()).running, false); assert.equal(calls, 2);
  } finally { release(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('host pins active ticks, does not restart on uncertain observation, and recovers after confirmed container loss', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-schedule-'));
  const specs = new Map([['scheduled', spec('scheduled')], ['ordinary', spec('ordinary')]]);
  const gateway = new HostedAgentGateway({ registry: () => null, spec: id => specs.get(id) ?? null, log: () => {} });
  const secrets = new HostedAgentSecretStore(join(dir, 's.json'), join(dir, 'key'));
  const running = new Map(); let starts = 0, stops = 0, calls = 0, release;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const docker = {
    ensureNetwork: async () => '127.0.0.1', removeOrphans: async () => {}, buildAgent: async () => '', removeImages: async () => {},
    logs: async () => [], isRunning: async id => running.has(id),
    async run(id, _version, env) {
      starts++;
      const app = express();
      app.use(createHostedAgentRuntimeRouter({ spec: specs.get(id), gateway: { url: env.AINIZE_GATEWAY_URL, token: env.AINIZE_AGENT_TOKEN },
        secrets: {}, log: () => {}, cardUrl: 'http://unused', module: { tick: async () => { calls++; if (calls === 1) await blocked; } } }));
      const server = createServer(app);
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      running.set(id, server);
      return { upstream: `http://127.0.0.1:${server.address().port}` };
    },
    async stop(id) { const server = running.get(id); if (server) { stops++; running.delete(id); await new Promise<void>(resolve => server.close(() => resolve())); } },
  };
  const host = new HostedAgentHost({ gateway, secrets, docker, idleStopMs: 1, maxRunning: 1,
    scheduledAgentIds: ['scheduled'], scheduleIntervalMs: 60_000, log: () => {} });
  try {
    await host.start([...specs.values()]);
    while (host.status('scheduled')?.status === 'building') await turn();
    await host.runScheduled(); assert.equal(starts, 1); assert.equal(calls, 1);
    await host.sweep(Date.now() + 100_000); assert.equal(stops, 0);
    await assert.rejects(host.resolve('ordinary'), /capacity is busy/); assert.equal(stops, 0);
    const original = globalThis.fetch;
    t.mock.method(globalThis, 'fetch', (url, init) => String(url).endsWith('/_ainize/tick')
      ? Promise.reject(new Error('observation timeout')) : original(url, init));
    await host.runScheduled(); await host.sweep(Date.now() + 100_000);
    assert.equal(stops, 0); assert.equal(starts, 1, 'a live container is not restarted after a failed observation');
    t.mock.restoreAll();
    release(); await turn(); await host.runScheduled();
    await host.sweep(Date.now() + 100_000); assert.equal(stops, 1, 'finished work is eligible for idle cleanup');
    await host.runScheduled(); assert.equal(starts, 2, 'schedule restarts a stopped container without any A2A request');
    await docker.stop('scheduled'); // Docker confirms the runtime is gone, unlike a request timeout.
    await host.runScheduled(); assert.equal(starts, 2);
    await host.runScheduled(); assert.equal(starts, 3);
    assert.equal(running.has('ordinary'), false, 'unscheduled agent is never started by the timer');
  } finally { t.mock.restoreAll(); release(); await host.stop(); rmSync(dir, { recursive: true, force: true }); }
});
