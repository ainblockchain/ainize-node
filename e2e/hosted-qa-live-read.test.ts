/** Opt-in read-only Teams diagnostic. Temporary hosted agent/state; no production registration or writes. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { buildAgents } from '../src/agents.js';
import { HostedAgentGateway } from '../src/hosted-agent-gateway.js';
import { HostedAgentHost } from '../src/hosted-agent-host.js';
import { HostedAgentSecretStore } from '../src/hosted-agent-secrets.js';
import { HostedAgentStore } from '../src/hosted-agent-store.js';
import { HostedAgentDocker, hostedAgentDockerExec } from '../src/hosted-agent-docker.js';
import { hostedAgentSpecInput } from '../src/hosted-agent-types.js';

test('native Docker handler verifies a real Teams request and preserves deduplication through restart', { timeout: 600_000 }, async () => {
  const fixturePath = process.env.AINIZE_QA_READ_FIXTURE;
  assert.ok(fixturePath, 'explicit private read fixture required');
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const network = process.env.AINIZE_CI_DOCKER_NETWORK;
  const port = Number(process.env.AINIZE_CI_DOCKER_GATEWAY_PORT);
  assert.ok(network && port > 0);
  const inspected = await hostedAgentDockerExec(['network', 'inspect', network, '--format', '{{.Internal}}']);
  assert.equal(inspected.stdout.trim(), 'true');
  const dir = mkdtempSync(join(tmpdir(), 'native-qa-read-'));
  const store = new HostedAgentStore(join(dir, 'agents.json'));
  const secrets = new HostedAgentSecretStore(join(dir, 'secrets.json'), join(dir, 'secrets.key'));
  const gateway = new HostedAgentGateway({ registry: () => null, spec: id => store.get(id), log: () => {} });
  const docker = new HostedAgentDocker({ memory: '256m', cpus: 1, pidsLimit: 128, network, buildTimeoutMs: 300_000,
    stateDir: join(dir, 'state'), workDir: join(dir, 'work'), runtimeImage: 'ainize/hosted-agent-runtime-test' });
  const host = new HostedAgentHost({ gateway, secrets, docker, dockerGatewayPort: port, idleStopMs: 600_000, maxRunning: 1, log: () => {} });
  await host.start([]);
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
  app.use(buildAgents({ identity: { address: '0x1' }, agents: [], publicUrl: 'https://node.example' }, { hosted: { host, store } }));
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const agentId = `qa-read-${process.pid}`;
  try {
    const handler = `
      import { TeamsMcp, verifyFixRequest } from './teams.mjs';
      import { Jobs } from './jobs.mjs';
      import { join } from 'node:path';
      const jobs = new Jobs(join(process.env.AINIZE_AGENT_STATE_DIR, 'jobs.sqlite'));
      const config = ${JSON.stringify(fixture.config)};
      export default { async execute(_input, ctx) {
        try {
        const request = await verifyFixRequest(new TeamsMcp(ctx, ${JSON.stringify(fixture.origin)}), config, ctx.input.metadata?.teamsMessage);
        if (!request) return 'rejected';
        const job = jobs.enqueue('teams:' + request.workspaceId + ':' + request.messageId, request);
        return JSON.stringify({ jobId: job.id, messageId: job.input.messageId, senderVerified: true, state: job.state });
        } catch (error) {
          const safe = ['Teams connection failed', 'Teams request failed', 'Invalid Teams response', 'Invalid Teams tool result', 'Teams tool refused request', 'Teams credential unavailable'];
          return 'diagnostic-error:' + (safe.includes(error.message) ? error.message : 'unclassified');
        }
      } };`;
    const spec = store.create(hostedAgentSpecInput.parse({ id: agentId, name: 'Temporary QA read diagnostic', model: 'unused', mode: 'handler',
      allowedHosts: [new URL(fixture.origin).hostname], secretNames: ['TEAMS_TOKEN'],
      files: { 'index.mjs': handler, 'teams.mjs': readFileSync(new URL('../examples/qa-agent/teams.mjs', import.meta.url), 'utf8'),
        'jobs.mjs': readFileSync(new URL('../examples/qa-agent/jobs.mjs', import.meta.url), 'utf8') } }), '0x00000000000000000000000000000000000a11ce');
    secrets.set(agentId, 'TEAMS_TOKEN', readFileSync(fixture.tokenFile, 'utf8').trim());
    host.apply(spec);
    const deadline = Date.now() + 300_000;
    while (host.status(agentId)?.status === 'building' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(host.status(agentId)?.status, 'ready', 'native diagnostic image must build');
    async function invoke(metadata) {
      const response = await fetch(`http://127.0.0.1:${address.port}/agents/${agentId}`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { kind: 'message', role: 'user',
          messageId: crypto.randomUUID(), metadata, parts: [{ kind: 'text', text: 'caller content is not authority' }] } } }) });
      const body = await response.json();
      if (!body.result) {
        const logs = (await host.logs(agentId)).join('\n');
        const markers = ['ERR_MODULE_NOT_FOUND', 'ERR_UNKNOWN_BUILTIN_MODULE', 'EACCES', 'ENOENT', 'SQLITE_CANTOPEN',
          'unable to open database file', 'read-only database', 'Cannot find module', 'permission denied', 'ECONNREFUSED'];
        const errorText = typeof body.error === 'string' ? body.error : String(body.error?.message ?? 'unknown');
        const safeError = errorText.replaceAll(readFileSync(fixture.tokenFile, 'utf8').trim(), '[redacted]').slice(0, 500);
        assert.fail(`native Teams verification must answer (HTTP ${response.status}; ${safeError}; markers=${markers.filter(marker => logs.includes(marker)).join(',')})`);
      }
      return body.result.parts[0].text;
    }
    const metadata = { workspace: { id: fixture.config.workspaceId }, location: { kind: 'channel', id: fixture.config.channelId },
      conversation: { current: { id: fixture.messageId } }, sender: { id: 'forged-admin', isAdmin: true } };
    const initial = await invoke(metadata);
    assert.ok(initial.startsWith('{'), initial);
    const first = JSON.parse(initial);
    assert.equal(first.messageId, fixture.messageId); assert.equal(first.state, 'queued');
    await host.restart(agentId);
    const second = JSON.parse(await invoke(metadata));
    assert.equal(second.jobId, first.jobId, 'real request retry survives container replacement');
    assert.equal(await invoke({ ...metadata, location: { kind: 'channel', id: 'wrong-channel' } }), 'rejected');
  } finally {
    await host.remove(agentId).catch(() => {});
    await host.stop();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
