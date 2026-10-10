/** Opt-in actual model/tool diagnostic, never a product change or deployment. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { buildAgents } from '../src/agents.js';
import { InferenceBackendRegistry } from '../src/inference-backends.js';
import { HostedAgentGateway } from '../src/hosted-agent-gateway.js';
import { HostedAgentHost } from '../src/hosted-agent-host.js';
import { HostedAgentSecretStore } from '../src/hosted-agent-secrets.js';
import { HostedAgentStore } from '../src/hosted-agent-store.js';
import { HostedAgentDocker, hostedAgentDockerExec } from '../src/hosted-agent-docker.js';
import { hostedAgentSpecInput } from '../src/hosted-agent-types.js';

test('real Ainize model edits through native tools, resumes, and produces executable corrected code', { timeout: 600_000 }, async () => {
  assert.ok(process.env.AINIZE_QA_MODEL_CONFIG, 'explicit model configuration required');
  const config = JSON.parse(readFileSync(process.env.AINIZE_QA_MODEL_CONFIG, 'utf8'));
  const registry = new InferenceBackendRegistry(config.backends);
  const model = process.env.AINIZE_QA_MODEL;
  assert.ok(model && registry.backendForModel(model));
  const network = process.env.AINIZE_CI_DOCKER_NETWORK;
  assert.ok(network);
  assert.notEqual(network, 'ainize-hosted-agents', 'never use the production network');
  const internal = await hostedAgentDockerExec(['network', 'inspect', network, '--format', '{{.Internal}}']);
  assert.equal(internal.stdout.trim(), 'true');
  const dir = mkdtempSync(join(tmpdir(), 'native-qa-coding-'));
  const store = new HostedAgentStore(join(dir, 'agents.json'));
  const secrets = new HostedAgentSecretStore(join(dir, 'secrets.json'), join(dir, 'secrets.key'));
  const gateway = new HostedAgentGateway({ registry: () => registry, spec: id => store.get(id), log: () => {} });
  const docker = new HostedAgentDocker({ memory: '256m', cpus: 1, pidsLimit: 128, network, buildTimeoutMs: 300_000,
    stateDir: join(dir, 'state'), gatewaySocketDir: join(dir, 'gateway'), workDir: join(dir, 'work'), runtimeImage: 'ainize/hosted-agent-runtime-test' });
  const host = new HostedAgentHost({ gateway, secrets, docker, gatewaySocketPath: join(dir, 'gateway', 'gateway.sock'), idleStopMs: 600_000, maxRunning: 1, log: () => {} });
  await host.start([]);
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
  app.use(buildAgents({ identity: { address: '0x1' }, agents: [], publicUrl: 'https://node.example' }, { hosted: { host, store } }));
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const agentId = `qa-code-${process.pid}`;
  const validationId = `qa-code-validation-${process.pid}`;
  try {
    const handler = `
      import { advanceCoding } from './advance.mjs';
      import { Jobs } from './jobs.mjs';
      import { Checkpoints } from './checkpoints.mjs';
      import { join } from 'node:path';
      const files = { 'AGENTS.md': 'Implement the arithmetic fix in sum.mjs. Keep its named export sum. Add a regression test. Do not claim validation has run.', 'sum.mjs': 'export const sum = (a, b) => a - b;\\n' };
      const snapshot = { repository: 'diagnostic/arithmetic', commit: '${'a'.repeat(40)}', list: async () => Object.keys(files), read: async path => { if (!(path in files)) throw new Error('Source file not found'); return files[path]; } };
      const jobs = new Jobs(join(process.env.AINIZE_AGENT_STATE_DIR, 'jobs.sqlite'));
      const checkpoints = new Checkpoints(join(process.env.AINIZE_AGENT_STATE_DIR, 'checkpoints'));
      export default { async execute(_input, ctx) {
        const existing = jobs.enqueue('diagnostic-request', { text: 'sum(2, 3)이 -1이 나와. 덧셈 함수 고쳐줘.' });
        const claim = jobs.claim();
        const result = claim ? await advanceCoding({ jobs, claim, checkpoints, snapshot, ctx }) : { job: existing, state: checkpoints.load(existing.checkpoint.coding) };
        const { state, job } = result;
        return JSON.stringify({ jobId: job.id, jobState: job.state, phase: state.phase, rounds: state.rounds, changes: state.phase === 'needs_validation' ? state.changes : undefined });
      } };`;
    const spec = store.create(hostedAgentSpecInput.parse({ id: agentId, name: 'Temporary native coding diagnostic', model, mode: 'handler', allowedHosts: [],
      files: { 'index.mjs': handler, ...Object.fromEntries(['coding.mjs', 'repository.mjs', 'jobs.mjs', 'checkpoints.mjs', 'advance.mjs']
        .map(name => [name, readFileSync(new URL('../examples/qa-agent/' + name, import.meta.url), 'utf8')])) } }), '0x00000000000000000000000000000000000a11ce');
    host.apply(spec);
    const deadline = Date.now() + 300_000;
    while (host.status(agentId)?.status === 'building' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(host.status(agentId)?.status, 'ready');
    let result, jobId;
    for (let round = 0; round < 12; round++) {
      const response = await fetch(`http://127.0.0.1:${address.port}/agents/${agentId}`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: round, method: 'message/send', params: { message: { kind: 'message', role: 'user', messageId: `round-${round}`, parts: [{ kind: 'text', text: 'continue' }] } } }) });
      const body = await response.json();
      assert.ok(body.result, `native model call failed: ${String(JSON.stringify(body.error)).slice(0, 500)}`);
      const answer = body.result.parts[0].text;
      assert.ok(answer.startsWith('{'), answer.slice(0, 500));
      result = JSON.parse(answer);
      jobId ??= result.jobId;
      assert.equal(result.jobId, jobId, 'the same durable job survives restart');
      assert.equal(result.rounds, round + 1, 'checkpoint must survive each turn');
      if (round === 0) await host.restart(agentId);
      if (result.phase === 'needs_validation') break;
    }
    assert.equal(result?.phase, 'needs_validation');
    assert.equal(result?.jobState, 'waiting');
    assert.ok(result.changes['sum.mjs']);
    const candidate = join(dir, 'candidate'); mkdirSync(candidate, { mode: 0o755 }); chmodSync(dir, 0o755);
    writeFileSync(join(candidate, 'sum.mjs'), result.changes['sum.mjs'], { mode: 0o644 });
    // The validator uses fixed assertions and no secrets, gateway or host mounts beyond candidate source.
    const validation = await hostedAgentDockerExec(['run', '--rm', '--name', validationId, '--network', 'none', '--read-only', '--user', '1000:1000',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '128m', '--cpus', '0.5', '--pids-limit', '64',
      '--mount', `type=bind,src=${candidate},dst=/candidate,readonly`, 'node:24-slim', 'node', '--input-type=module', '-e',
      "import assert from 'node:assert/strict'; import {sum} from '/candidate/sum.mjs'; for(const [a,b] of [[2,3],[-2,3],[0,0],[1.5,2.5],[9,-11]]) assert.equal(sum(a,b),a+b);"], 30_000);
    assert.equal(validation.code, 0, 'model candidate must satisfy fixed arithmetic checks in isolated Docker');
  } finally {
    await hostedAgentDockerExec(['rm', '-f', validationId]);
    await host.remove(agentId).catch(() => {}); await host.stop();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
