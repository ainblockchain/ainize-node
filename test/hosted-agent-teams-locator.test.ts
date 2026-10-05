import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostedAgentTeamsLocatorOf } from '../src/hosted-agent-runtime/hostedAgentTeamsLocator.js';

const message = () => ({ metadata: {
  workspace: { id: 'workspace-1', token: 'private' },
  location: { kind: 'channel', id: 'channel-1' },
  conversation: { current: { id: 'message-1', text: 'LGTM', userId: 'claimed-admin' }, history: ['private'] },
  sender: { id: 'claimed-admin', isAdmin: true }, authorization: 'private', teamsMessage: { messageId: 'forged' },
} });

test('only canonical lookup identifiers cross the hosted handler boundary', () => {
  assert.deepEqual(hostedAgentTeamsLocatorOf(message()), {
    workspaceId: 'workspace-1', channelId: 'channel-1', messageId: 'message-1', parentId: 'message-1',
  });
});

test('thread locator preserves root identity, and malformed locators fail closed', () => {
  const thread = message(); Object.assign(thread.metadata.location, { kind: 'thread', parentId: 'root-1' });
  assert.equal(hostedAgentTeamsLocatorOf(thread)?.parentId, 'root-1');
  for (const bad of [null, {}, { metadata: 'bad' }, { metadata: [] },
    { metadata: { ...thread.metadata, location: { kind: 'dm', id: 'channel-1' } } },
    { metadata: { ...thread.metadata, location: { kind: 'thread', id: 'channel-1' } } },
    { metadata: { ...thread.metadata, workspace: { id: '../other' } } },
    { metadata: { ...thread.metadata, location: { kind: 'thread', id: 'channel-1', parentId: 10 } } },
  ]) assert.equal(hostedAgentTeamsLocatorOf(bad), undefined);
});

import express from 'express';
import { createServer } from 'node:http';
import { HostedAgentGateway } from '../src/hosted-agent-gateway.js';
import { hostedAgentSpecInput } from '../src/hosted-agent-types.js';
import { createHostedAgentRuntimeRouter } from '../src/hosted-agent-runtime/hostedAgentRuntimeApp.js';

test('actual hosted A2A send and stream deliver only the locator to handler code', async () => {
  const spec = { ...hostedAgentSpecInput.parse({ id: 'qa-locator', name: 'QA', model: 'unused', mode: 'handler', files: { 'index.mjs': 'export default {}' } }),
    owner: 'test', version: 1, createdAt: 1, updatedAt: 1 };
  const gateway = new HostedAgentGateway({ registry: () => null, spec: () => spec, log: () => {} });
  const seen: unknown[] = [];
  const app = express();
  app.use(createHostedAgentRuntimeRouter({ spec, secrets: {}, log: () => {}, cardUrl: 'http://test',
    gateway: { url: await gateway.listen('127.0.0.1'), token: gateway.issue(spec.id) },
    module: { execute: (_text, ctx) => { seen.push(ctx.input.metadata); return 'received'; } },
  }));
  const server = createServer(app);
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    for (const method of ['message/send', 'message/stream']) {
      const response = await fetch(`http://127.0.0.1:${address.port}/`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { message: { ...message(), kind: 'message', role: 'user',
          messageId: method, contextId: 'test', parts: [{ kind: 'text', text: '여백 고쳐줘' }] } } }) });
      assert.equal(response.status, 200); assert.match(await response.text(), /received/);
    }
    assert.deepEqual(seen, Array.from({ length: 2 }, () => ({ teamsMessage: {
      workspaceId: 'workspace-1', channelId: 'channel-1', messageId: 'message-1', parentId: 'message-1',
    } })));
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await gateway.close();
  }
});
