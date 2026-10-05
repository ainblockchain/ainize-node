import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { hostedAgentEgress } from '../src/hosted-agent-gateway.js';
import { hostedAgentEgressFetch } from '../src/hosted-agent-runtime/hostedAgentContext.js';

test('gateway honors error/manual redirect modes before sending credentials to a redirect target', async t => {
  const contacted = [];
  t.mock.method(https, 'request', (url, _options, callback) => {
    contacted.push(url.href);
    const request = new EventEmitter();
    request.end = () => queueMicrotask(() => {
      const response = new EventEmitter();
      response.statusCode = url.pathname === '/redirect' ? 302 : 200;
      response.headers = response.statusCode === 302 ? { location: 'https://other.example/target' } : {};
      callback(response); response.emit('end');
    });
    return request;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(hostedAgentEgress({ url: 'https://teams.example/redirect', headers: { Authorization: 'private' }, redirect: 'error' }, ['*']), /redirect refused/);
    assert.deepEqual(contacted, ['https://teams.example/redirect']);
    contacted.length = 0;
    const manual = await hostedAgentEgress({ url: 'https://teams.example/redirect', redirect: 'manual' }, ['*']);
    assert.equal(manual.status, 302); assert.equal(contacted.length, 1);
    contacted.length = 0;
    const follow = await hostedAgentEgress({ url: 'https://teams.example/redirect' }, ['*']);
    assert.equal(follow.status, 200); assert.equal(contacted.length, 2);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test('runtime forwards Request and explicit init redirect policy to the gateway', async () => {
  const seen = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => { seen.push(JSON.parse(body)); response.end('ok'); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const gateway = { url: `http://127.0.0.1:${address.port}`, token: 'test' };
    await hostedAgentEgressFetch(gateway, new Request('https://teams.example', { redirect: 'manual' }));
    await hostedAgentEgressFetch(gateway, new Request('https://teams.example', { redirect: 'follow' }), { redirect: 'error' });
    assert.deepEqual(seen.map(request => request.redirect), ['manual', 'error']);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
