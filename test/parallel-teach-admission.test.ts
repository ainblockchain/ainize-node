import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIdentity, defaultConfig } from '@ainize/core';
import { startNode } from '../src/server.js';
import { teachAuthHeaderFor } from '../src/teach-auth.js';

test('one teacher can admit 70 concurrent jobs; the 71st and the global queue cap remain enforced', async context => {
  const home = mkdtempSync(join(tmpdir(), 'ainize-parallel-admission-'));
  const teacher = createIdentity();
  const config = defaultConfig({ home, port: 34048, peers: [], roles: ['seller'], ledger: 'local' });
  config.host = '127.0.0.1';
  config.teach = {
    ...config.teach!, enabled: true, backend: 'stub', stubOffline: true,
    queueMax: 80, activeJobsPerKey: 70, trustedKeys: [teacher.address],
    jobsPerIpPerDay: 1000, jobsPerKeyPerDay: 1000,
  };
  const node = await startNode(config, { quiet: true, serveWeb: false, teachHooks: { intervalMs: 600_000 } });
  context.after(async () => { await node.stop(); rmSync(home, { recursive: true, force: true }); });
  await node.teach!.stop();
  const endpoint = 'http://127.0.0.1:34048';
  const submit = async (index: number) => {
    const route = '/api/teach/jobs';
    const body = JSON.stringify({ patch_ids: [], facts: [{ prompt: `Parallel lesson ${index} code?`, answer: `value-${index}` }], name: `parallel-${index}` });
    const response = await fetch(endpoint + route, { method: 'POST', headers: {
      'content-type': 'application/json',
      'x-ainize-auth': teachAuthHeaderFor(teacher, { node: node.market.address, method: 'POST', path: route, body }),
    }, body });
    return { status: response.status, body: await response.json() as { job?: { id: string; status: string }; error?: string } };
  };
  const responses = await Promise.all(Array.from({ length: 70 }, (_, index) => submit(index)));
  for (const response of responses) assert.equal(response.status, 202, JSON.stringify(response.body));
  assert.equal(new Set(responses.map(response => response.body.job?.id)).size, 70);
  assert.ok(responses.every(response => response.body.job?.status === 'QUEUED'));
  const rejected = await submit(70);
  assert.equal(rejected.status, 429);
  assert.match(rejected.body.error ?? '', /configured limit is 70/);
  config.teach!.activeJobsPerKey = 80;
  config.teach!.queueMax = 70;
  const full = await submit(71);
  assert.equal(full.status, 503);
  assert.match(full.body.error ?? '', /training queue is full/);
  node.teach!.invalidatePolicy();
  const policy = await fetch(endpoint + '/api/teach/policy').then(response => response.json()) as { limits: { active_jobs_per_key: number } };
  assert.equal(policy.limits.active_jobs_per_key, 80);
});
