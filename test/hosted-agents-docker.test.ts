/**
 * A code agent, for real: runtime image, agent image, a container on the internal network, the gateway on the
 * bridge address, and an A2A call through agents.ts. Skipped when this machine has no Docker daemon.
 *
 * What it proves beyond hosted-agents.test.ts: the runtime runs outside the node (no import leaks), the container
 * reaches the model and the internet only through the gateway, loopback is refused from inside, and a container
 * is started on demand and stopped when idle.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
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
import { HostedAgentDocker, hostedAgentDockerAvailable, hostedAgentDockerExec } from '../src/hosted-agent-docker.js';
import { hostedAgentSpecInput } from '../src/hosted-agent-types.js';

const MODEL = 'Docker-Chat-1';
const OWNER = '0x00000000000000000000000000000000000a11ce';
const hasDocker = await hostedAgentDockerAvailable();

/**
 * This integration test needs more than a docker daemon: a container on an `--internal` network must be able to
 * reach the host gateway (that is the one route out of the sandbox, and how the agent calls the model). On a host
 * whose docker iptables rules have been flushed or disrupted that path silently drops — the agent's call then
 * fails with "fetch failed" and the test fails for a reason that has nothing to do with the code under test. So,
 * exactly like `!hasDocker`, verify the precondition up front and skip when the environment cannot provide it:
 * stand up a throwaway listener on the host and check a container can reach it across the internal network.
 */
async function dockerInternalNetReachesHost(): Promise<boolean> {
  if (!hasDocker) return false;
  // On a CI host whose firewall admits only one bridge port, probe that network and port (deploy/README.md).
  const net = process.env.AINIZE_CI_DOCKER_NETWORK || 'ainize-hosted-agents';
  const fixedPort = process.env.AINIZE_CI_DOCKER_NETWORK ? Number(process.env.AINIZE_CI_DOCKER_GATEWAY_PORT) : 0;
  try {
    if (!process.env.AINIZE_CI_DOCKER_NETWORK) await hostedAgentDockerExec(['network', 'create', '--internal', '--label', 'ainize.hosted-agents=1', net]).catch(() => undefined);
    const gw = (await hostedAgentDockerExec(['network', 'inspect', net, '--format', '{{(index .IPAM.Config 0).Gateway}}'])).stdout.trim();
    if (!gw) return false;
    const probe = createServer((_q, s) => s.end('ok'));
    // The fixed port may be held by another test's gateway for a while; wait for it rather than skip.
    const until = Date.now() + 600_000;
    for (;;) {
      try { await new Promise<void>((r, j) => { probe.once('error', j); probe.listen(fixedPort, '0.0.0.0', () => r()); }); break; }
      catch (e) { if ((e as { code?: string }).code !== 'EADDRINUSE' || Date.now() > until) throw e; await new Promise((r) => setTimeout(r, 1000)); }
    }
    const port = (probe.address() as AddressInfo).port;
    try {
      const r = await hostedAgentDockerExec(['run', '--rm', '--network', net, 'alpine:latest', 'sh', '-c', `wget -q -T 4 -O - http://${gw}:${port}/ || echo UNREACHABLE`], 30_000);
      return /ok/.test(r.stdout) && !/UNREACHABLE/.test(r.stdout);
    } finally {
      probe.close();
    }
  } catch {
    return false;
  }
}

const dockerNetReachesHost = await dockerInternalNetReachesHost();
const dockerAgentSkip = !hasDocker
  ? 'no docker daemon'
  : !dockerNetReachesHost
    ? 'docker internal network cannot reach the host gateway in this environment (host iptables routing unavailable)'
    : false;

const HANDLER = `
export default {
  async execute(input, ctx) {
    const words = input.split(/\\s+/).filter(Boolean).length;
    const model = await ctx.llm.chat({ messages: [{ role: 'user', content: input }] });
    let loopback = 'reached';
    try { await fetch('http://localhost:9/'); } catch (e) { loopback = 'refused'; }
    let direct = 'reached';
    try { await ctx.fetch('http://169.254.169.254/latest/meta-data/'); } catch (e) { direct = 'refused'; }
    const surface = ctx.ui.surface('score', [ctx.ui.column('root', ['n']), ctx.ui.text('n', ctx.ui.bind('/words'))], { words });
    return { text: 'words=' + words + ' key=' + ctx.secret('API_KEY') + ' loopback=' + loopback + ' metadata=' + direct + ' model=' + model.message.content, ui: surface };
  },
};
`;

test('a handler agent builds, starts on demand in Docker, answers over A2A through the node, and stops when idle', { skip: dockerAgentSkip, timeout: 900_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hosted-docker-'));
  const configuredNetwork = process.env.AINIZE_CI_DOCKER_NETWORK;
  const network = configuredNetwork || `ainize-hosted-test-${process.pid}`;
  const dockerGatewayPort = process.env.AINIZE_CI_DOCKER_GATEWAY_PORT
    ? Number(process.env.AINIZE_CI_DOCKER_GATEWAY_PORT) : undefined;
  if (configuredNetwork) {
    assert.ok(Number.isInteger(dockerGatewayPort) && dockerGatewayPort! > 0 && dockerGatewayPort! <= 65535,
      'the CI network requires a fixed gateway port permitted by its host firewall');
    const inspected = await hostedAgentDockerExec(['network', 'inspect', network, '--format', '{{.Internal}}']);
    assert.equal(inspected.code, 0, 'the configured CI network must already exist');
    assert.equal(inspected.stdout.trim(), 'true', 'CI agents must remain on an internal network');
  }
  // the model backend listens on all interfaces here only because the gateway, not the container, calls it
  const backend = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      const body = JSON.parse(b || '{}') as { model: string };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: `ok:${body.model}` } }] }));
    });
  });
  await new Promise<void>((r) => backend.listen(0, '127.0.0.1', () => r()));
  const registry = new InferenceBackendRegistry([{ id: 'llm', modality: 'chat', upstream: `http://127.0.0.1:${(backend.address() as AddressInfo).port}`, models: [MODEL], concurrency: 1 }]);

  const store = new HostedAgentStore(join(dir, 'h.json'));
  const secrets = new HostedAgentSecretStore(join(dir, 's.json'), join(dir, 's.key'));
  const gateway = new HostedAgentGateway({ registry: () => registry, spec: (id) => store.get(id), log: () => {} });
  const docker = new HostedAgentDocker({
    memory: '256m', cpus: 1, pidsLimit: 128, network, buildTimeoutMs: 600_000,
    workDir: join(dir, 'work'), runtimeImage: 'ainize/hosted-agent-runtime-test',
  });
  const host = new HostedAgentHost({ gateway, secrets, docker, dockerGatewayPort, idleStopMs: 1, maxRunning: 2, log: () => {} });
  await host.start([]);
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as typeof req & { rawBody?: Buffer }).rawBody = buf; } }));
  app.use(buildAgents({ identity: { address: '0x1' }, agents: [], publicUrl: 'https://node.example' } as unknown as NodeConfig, { hosted: { host, store } }));
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const spec = store.create(hostedAgentSpecInput.parse({
      id: 'dock-scorer', name: 'Dock Scorer', model: MODEL, mode: 'handler', a2ui: true,
      files: { 'index.mjs': HANDLER }, allowedHosts: ['*'], secretNames: ['API_KEY'],
    }), OWNER);
    secrets.set(spec.id, 'API_KEY', 'sk-test');
    host.apply(spec);
    const until = Date.now() + 600_000;
    while (host.status(spec.id)?.status === 'building' && Date.now() < until) await new Promise((r) => setTimeout(r, 1000));
    assert.equal(host.status(spec.id)?.status, 'ready', (await host.logs(spec.id)).join('\n'));

    const r = await fetch(`${base}/agents/dock-scorer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'message/send',
      params: { message: { kind: 'message', role: 'user', messageId: 'm1', parts: [{ kind: 'text', text: 'three little words' }] } },
    }) });
    const body = await r.json() as { result?: { parts: { kind: string; text?: string }[] }; error?: unknown };
    assert.ok(body.result, `call failed: ${JSON.stringify(body)}\n${(await host.logs(spec.id)).join('\n')}`);
    assert.equal(body.result!.parts[0]!.text, `words=3 key=sk-test loopback=refused metadata=refused model=ok:${MODEL}`,
      (await host.logs(spec.id)).join('\n'));
    assert.equal(body.result!.parts.filter((p) => p.kind === 'data').length, 3, 'the A2UI surface came back as data parts');

    const inspect = await hostedAgentDockerExec(['inspect', 'ainize-hosted-dock-scorer', '--format', '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}} {{.Config.User}}']);
    assert.match(inspect.stdout.trim(), /^true \[ALL\] node$/);
    const env = await hostedAgentDockerExec(['exec', 'ainize-hosted-dock-scorer', 'node', '-e', 'fetch("http://1.1.1.1").then(()=>console.log("open"),()=>console.log("blocked"))']);
    assert.equal(env.stdout.trim(), 'blocked', 'the container has no route out except the gateway');

    await new Promise((res) => setTimeout(res, 20));
    await host.sweep();
    const ps = await hostedAgentDockerExec(['ps', '-q', '--filter', 'name=ainize-hosted-dock-scorer']);
    assert.equal(ps.stdout.trim(), '', 'idle container stopped');
  } finally {
    await host.remove('dock-scorer').catch(() => {});
    await host.stop();
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => backend.close(() => r()));
    if (!configuredNetwork) await hostedAgentDockerExec(['network', 'rm', network]);
    rmSync(dir, { recursive: true, force: true });
  }
});
