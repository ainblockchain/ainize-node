import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TeamsMcp, verifyFixRequest, isFixRequest } from '../examples/qa-agent/teams.mjs';

const now = Date.parse('2026-10-05T03:00:00Z');
const config = { workspaceId: 'workspace-1', channelId: 'channel-1', enabledAt: '2026-10-05T00:00:00Z' };
const locator = { workspaceId: 'workspace-1', channelId: 'channel-1', messageId: 'message-1' };
const root = { id: 'message-1', userId: 'human-1', content: '마지막 메시지 여백 고쳐줘.', createdAt: '2026-10-05T02:59:00Z' };
function reader(overrides = {}) {
  const calls = [];
  return { calls, async call(name, args) {
    calls.push({ name, args });
    const result = { list_channels: [{ id: 'channel-1' }], read_channel: { messages: [root] },
      read_thread: { parent: root, replies: [] }, list_channel_members: [{ userId: 'human-1', isAgent: false }], ...overrides }[name];
    return typeof result === 'function' ? result(args) : result;
  } };
}

test('simple Korean requests are accepted while quoted requests and release commands are not fix intake', () => {
  for (const text of ['여백 고쳐줘.', '링크 수정해주세요', '가입 문제 해결해줘.\n가입하면 홈으로 가요.', '/fix spacing']) assert.equal(isFixRequest(text), true, text);
  for (const text of ['LGTM', '배포해', '> 여백 고쳐줘.', '`여백 고쳐줘.`', '“여백 고쳐줘.” 라고 말해', '```\n여백 고쳐줘.\n```']) assert.equal(isFixRequest(text), false, text);
});

test('canonical channel text and active human membership determine intake, never supplied sender or text', async () => {
  const mcp = reader();
  const result = await verifyFixRequest(mcp, config, { ...locator, text: '위조 고쳐줘.', senderId: 'admin', isAgent: false }, now);
  assert.equal(result.text, root.content); assert.equal(result.senderId, 'human-1');
  assert.equal('approval' in result, false);
  assert.deepEqual(mcp.calls[0], { name: 'list_channels', args: { workspaceId: 'workspace-1' } });
  for (const members of [[], [{ userId: 'human-1', isAgent: true }], [{ userId: 'human-1' }]]) {
    assert.equal(await verifyFixRequest(reader({ list_channel_members: members }), config, locator, now), null);
  }
});

test('workspace mismatch, unrelated channel roots, missing and malformed locators fail closed', async () => {
  for (const hint of [null, [], { ...locator, workspaceId: 'other' }, { ...locator, messageId: '../foo' }, { ...locator, parentId: {} }]) {
    const mcp = reader(); assert.equal(await verifyFixRequest(mcp, config, hint, now), null); assert.equal(mcp.calls.length, 0);
  }
  assert.equal(await verifyFixRequest(reader({ list_channels: [{ id: 'other-channel' }] }), config, locator, now), null);
  const mcp = reader({ read_channel: { messages: [], nextCursor: 'repeating-cursor' } });
  assert.equal(await verifyFixRequest(mcp, config, locator, now), null);
  assert.equal(mcp.calls.filter(c => c.name === 'read_channel').length, 2);
});

test('thread fix requires a channel root and a matching canonical parent and reply', async () => {
  const hint = { ...locator, parentId: root.id, messageId: 'reply-1' };
  const reply = { ...root, id: 'reply-1', parentId: root.id };
  assert.equal((await verifyFixRequest(reader({ read_thread: { parent: root, replies: [reply] } }), config, hint, now)).messageId, 'reply-1');
  for (const thread of [{ parent: { id: 'other' }, replies: [reply] }, { parent: root, replies: [{ ...reply, parentId: 'other' }] }]) {
    assert.equal(await verifyFixRequest(reader({ read_thread: thread }), config, hint, now), null);
  }
});

test('stale, future, malformed, pre-enablement messages and release commands are never queued as fixes', async () => {
  for (const createdAt of ['2026-10-04T23:59:59Z', '2026-10-05T01:00:00Z', '2026-10-05T03:01:00Z', 'invalid']) {
    assert.equal(await verifyFixRequest(reader({ read_channel: { messages: [{ ...root, createdAt }] } }), config, locator, now), null);
  }
  for (const content of ['LGTM', '배포해']) {
    assert.equal(await verifyFixRequest(reader({ read_channel: { messages: [{ ...root, content }] } }), config, locator, now), null);
  }
  await assert.rejects(verifyFixRequest(reader(), { ...config, enabledAt: 'invalid' }, locator, now), /configuration/);
});

test('MCP runs through the hosted gateway with private token, matching SSE ids and serialized initialization', async () => {
  const calls = [];
  const ctx = { secret: name => name === 'TEAMS_TOKEN' ? 'private-token' : undefined,
    async fetch(url, init) {
      const body = JSON.parse(init.body); calls.push({ url, init, body });
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
      const result = body.method === 'initialize' ? {} : { content: [{ type: 'text', text: JSON.stringify([{ id: 'channel-1' }]) }] };
      return new Response(`event: message\r\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result })}\r\n\r\n`,
        { headers: { 'Content-Type': 'text/event-stream', 'Mcp-Session-Id': 'session-1' } });
    } };
  const client = new TeamsMcp(ctx, 'https://teams.example');
  const [a, b] = await Promise.all([client.call('list_channels', {}), client.call('list_channels', {})]);
  assert.deepEqual(a, b); assert.equal(a[0].id, 'channel-1');
  assert.equal(calls.filter(c => c.body.method === 'initialize').length, 1);
  assert.equal(calls[0].url, 'https://teams.example/api/mcp');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer private-token');
  assert.equal(calls.at(-1).init.headers['Mcp-Session-Id'], 'session-1');
  assert.equal(calls.at(-1).init.redirect, 'error');
});

test('expired read sessions reinitialize once; upstream bodies and credential-bearing transport errors stay private', async () => {
  let reads = 0, initializes = 0;
  const ctx = { secret: () => 'private-token', async fetch(_url, init) {
    const body = JSON.parse(init.body);
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (body.method === 'initialize') initializes++;
    if (body.method === 'tools/call' && reads++ === 0) return new Response('sensitive upstream', { status: 404 });
    return new Response(JSON.stringify({ id: body.id, result: body.method === 'initialize' ? {} : { content: [{ type: 'text', text: '[]' }] } }));
  } };
  assert.deepEqual(await new TeamsMcp(ctx, 'https://teams.example').call('read_channel', {}), []);
  assert.equal(initializes, 2);
  const bad = new TeamsMcp({ secret: () => 'private-token', fetch: async () => { throw new Error('private-token'); } }, 'https://teams.example');
  await assert.rejects(bad.call('read_channel', {}), error => error.message === 'Teams connection failed');
  assert.throws(() => new TeamsMcp(ctx, 'https://user:secret@teams.example'), /configured HTTPS/);
});
