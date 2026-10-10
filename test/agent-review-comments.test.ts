import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentGit } from '../src/agent-git.js';
import { AgentPullStore } from '../src/agent-pulls.js';
import { agentPullRoutes } from '../src/agent-pull-routes.js';
import { hostedAgentSpecInput } from '../src/hosted-agent-types.js';
const root = mkdtempSync(join(tmpdir(), 'ainize-review-'));
const git = new AgentGit(join(root, 'repos'));
const file = join(root, 'pulls.json');
const pulls = new AgentPullStore(file);
const app = express();
app.use(agentPullRoutes({ git, pulls, principal: (req) => req.get('x-person') ?? null, canRead: (req) => req.get('x-person') !== 'outsider', canMerge: (req) => req.get('x-person') === 'owner', apply: async () => {} }));
let commit = '';
before(async () => {
  await git.init('desk');
  commit = await git.commitSpec('desk', { ...hostedAgentSpecInput.parse({ id: 'desk', name: 'Desk', model: 'model', systemPrompt: 'Line one\nLine two' }), id: 'desk' }, { message: 'Initial' });
  pulls.open({ agent: 'desk', title: 'Proposal', body: '', base: 'main', head: 'proposal', author: 'owner' });
});
after(() => rmSync(root, { recursive: true, force: true }));
const route = '/api/hosted-agents/desk/pulls/1/comments';
test('review comments pin existing file lines, survive restart, and retain a tombstone after moderation', async () => {
  const created = await request(app).post(route).set('x-person', 'reviewer').send({ body: 'Explain this instruction', commit, path: 'prompt.md', line: 2 });
  assert.equal(created.status, 201, created.text);
  assert.equal(created.body.comment.commit, commit);
  const id = created.body.comment.id;
  assert.equal(new AgentPullStore(file).get('desk', 1)?.comments?.[0]?.body, 'Explain this instruction');
  assert.equal((await request(app).patch(`${route}/${id}`).set('x-person', 'owner').send({ body: 'Alter somebody else' })).status, 403);
  assert.equal((await request(app).patch(`${route}/${id}`).set('x-person', 'reviewer').send({ body: 'Updated review' })).status, 200);
  assert.equal((await request(app).get(route).set('x-person', 'outsider')).status, 404);
  assert.equal((await request(app).delete(`${route}/${id}`).set('x-person', 'other')).status, 403);
  assert.equal((await request(app).delete(`${route}/${id}`).set('x-person', 'owner')).status, 200);
  const saved = new AgentPullStore(file).get('desk', 1)?.comments?.[0];
  assert.equal(saved?.body, '');
  assert.ok(saved?.deletedAt);
  assert.equal(saved?.author, 'reviewer');
  assert.equal((await request(app).patch(`${route}/${id}`).set('x-person', 'reviewer').send({ body: 'Restore removed comment' })).status, 404);
});
test('invalid anchors and anonymous reviews never become comments', async () => {
  const before = pulls.get('desk', 1)?.comments?.length;
  for (const body of [{ body: 'bad', commit, path: 'prompt.md', line: 100 }, { body: 'bad', path: '../secret', line: 1 }, { body: 'bad', commit: 'f'.repeat(40) }]) {
    assert.equal((await request(app).post(route).set('x-person', 'reviewer').send(body)).status, 400);
  }
  assert.equal((await request(app).post(route).send({ body: 'anonymous' })).status, 401);
  assert.equal(pulls.get('desk', 1)?.comments?.length, before);
});
