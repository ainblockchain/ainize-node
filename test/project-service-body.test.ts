import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectRoutes } from '../src/project-routes.js';
import { ProjectStore, DeploymentLogs, type ProjectWorker } from '../src/projects.js';
import { HostedAgentSecretStore } from '../src/hosted-agent-secrets.js';

test('project service receives exact JSON bytes after the node parser, and unparsed bodies still stream', async () => {
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ hash: createHash('sha256').update(Buffer.concat(chunks)).digest('hex'), contentType: req.headers['content-type'], method: req.method, path: req.url }));
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  const root = mkdtempSync(join(tmpdir(), 'project-service-body-'));
  const app = express();
  // Match the production parser, including its raw-body verify hook.
  app.use(express.json({ verify: (req, _res, body) => { (req as typeof req & { rawBody?: Buffer }).rawBody = body; } }));
  app.use(projectRoutes({
    store: new ProjectStore(join(root, 'projects.json')),
    secrets: new HostedAgentSecretStore(join(root, 'secrets.json'), join(root, 'secret.key')),
    logs: new DeploymentLogs(join(root, 'logs')),
    worker: { enqueue() {} } as unknown as ProjectWorker,
    caller: () => null,
    publicBase: () => 'https://node.example',
    containers: { current: id => id === 'prj_body' ? { projectId: id, deploymentId: 'dep_body', name: 'body', sha: 'a'.repeat(40), token: 'fixture', port: address.port, upstream: `http://127.0.0.1:${address.port}` } : null },
  }));
  try {
    const json = '{\n  "message": "커피 ☕", "parts": [1, 2]\n}\n';
    const response = await request(app).post('/svc/prj_body?source=docs').set('content-type', 'application/json').send(json);
    assert.equal(response.status, 200);
    assert.equal(response.body.hash, createHash('sha256').update(json).digest('hex'), 'signed JSON is forwarded without reserialization');
    assert.equal(response.body.contentType, 'application/json');
    assert.equal(response.body.method, 'POST');
    assert.equal(response.body.path, '/?source=docs');
    const binary = Buffer.from([0, 255, 17, 42, 0]);
    const streamed = await request(app).put('/svc/prj_body/upload').set('content-type', 'application/octet-stream').send(binary);
    assert.equal(streamed.status, 200);
    assert.equal(streamed.body.hash, createHash('sha256').update(binary).digest('hex'));
    assert.equal(streamed.body.contentType, 'application/octet-stream');
    assert.equal((await request(app).post('/svc/prj_missing').send({})).status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
