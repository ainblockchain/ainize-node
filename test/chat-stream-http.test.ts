import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '@ainize/core';
import { startNode, type RunningNode } from '../src/server.js';
import { Market } from '../src/market.js';

test('headless node forwards model SSE before completion and preserves JSON mode', { timeout: 20000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'ainize-stream-http-'));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let requestedTokens: number | undefined;
  let sawDisconnect!: () => void;
  const disconnected = new Promise<void>(resolve => { sawDisconnect = resolve; });
  const upstream = createServer(async (request, response) => {
    if (request.method !== 'POST') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
      return;
    }
    let bytes = '';
    for await (const part of request) bytes += part;
    const input = JSON.parse(bytes);
    requestedTokens = input.max_tokens;
    if (!input.stream) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ choices: [{ message: { content: 'JSON answer' }, finish_reason: 'stop' }] }));
      return;
    }
    response.setHeader('content-type', 'text/event-stream');
    const chunk = (content: string, finish: string | null) => ({ id: 'upstream', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta: { content }, finish_reason: finish }] });
    response.write(`data: ${JSON.stringify(chunk('First', null))}\n\n`);
    if (input.messages[0].content === 'Cancel this stream') {
      response.once('close', sawDisconnect);
      return;
    }
    await gate;
    response.end(`data: ${JSON.stringify(chunk(' last', 'stop'))}\n\ndata: [DONE]\n\n`);
  });
  let node: RunningNode | undefined;
  try {
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamPort = (upstream.address() as { port: number }).port;
    const config = defaultConfig({ home, name: 'headless-stream', port: 3400, peers: [], roles: ['serving'], ledger: 'local' });
    config.runtime = { api: `http://127.0.0.1:${upstreamPort}` };
    node = await startNode(config, { listen: false, quiet: true, teachWorker: false });
    Object.assign(node.market.runtime, { status: async () => ({ available: true, model: 'test-model' }), models: async () => 'test-model' });
    await new Promise<void>(resolve => node!.server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(node.server.address() as { port: number }).port}`;
    const root = await fetch(url);
    assert.match(root.headers.get('content-type')!, /text\/plain/);
    const specification = await (await fetch(`${url}/api/openapi.json`)).json();
    const chatContent = specification.paths['/api/chat'].post.responses['200'].content;
    assert.ok(chatContent['application/json']);
    assert.ok(chatContent['text/event-stream']);
    const body = { patch_ids: [], mode: 'base', model: 'test-model', messages: [{ role: 'user', content: 'Say hello' }], max_tokens: 7 };
    const wrongModel = await fetch(`${url}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, model: 'other-model', stream: true }) });
    assert.equal(wrongModel.status, 409);
    assert.match(wrongModel.headers.get('content-type')!, /application\/json/);
    const response = await fetch(`${url}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, stream: true }), signal: AbortSignal.timeout(15000) });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type')!, /text\/event-stream/);
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.match(first, /First/);
    assert.ok(!first.includes('[DONE]'));
    assert.equal(requestedTokens, 7);
    release();
    let remainder = '';
    for (;;) { const part = await reader.read(); if (part.done) break; remainder += new TextDecoder().decode(part.value); }
    assert.match(remainder, /ainize.result/);
    assert.match(remainder, /\[DONE\]/);
    assert.equal(node.store.get(Market.RESTORE_KEY), '');
    const plain = await fetch(`${url}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(plain.status, 200);
    assert.equal((await plain.json()).base.content, 'JSON answer');
    const denied = await fetch(`${url}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, patch_ids: ['private-missing'], mode: 'patched', stream: true }) });
    assert.equal(denied.status, 404);
    assert.match(denied.headers.get('content-type')!, /application\/json/);
    const abort = new AbortController();
    const cancelled = await fetch(`${url}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, stream: true, messages: [{ role: 'user', content: 'Cancel this stream' }] }), signal: abort.signal });
    await cancelled.body!.getReader().read();
    abort.abort();
    await disconnected;
    const deadline = Date.now() + 3000;
    while (node.store.get(Market.RESTORE_KEY) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(node.store.get(Market.RESTORE_KEY), '');
  } finally {
    release();
    node?.server.closeAllConnections();
    await node?.stop();
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
});
