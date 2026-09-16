/**
 * What a public page may say about the addresses a node dials.
 *
 * The rule exists because of a real page: /network on a public site listed `http://192.168.1.41:3402` and a
 * column of `http://localhost:35xx` links. A visitor who clicked one was sent to their own machine.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPublicEndpoint, publicEndpoint, publicPeerInfo } from '../src/endpoints.js';

test('an address on somebody else’s network is not publishable', () => {
  for (const e of [
    'http://localhost:3514', 'http://127.0.0.1:3400', 'http://0.0.0.0:3400',
    'http://192.168.1.41:3402', 'http://10.0.0.5:3400', 'http://172.16.3.1:3400', 'http://172.31.255.1:3400',
    'http://169.254.1.1:3400', 'http://node.local:3400', 'http://[::1]:3400',
  ]) {
    assert.equal(isPublicEndpoint(e), false, e);
    assert.equal(publicEndpoint(e), null, e);
  }
});

test('a real address is published unchanged', () => {
  for (const e of ['https://ainize.ai', 'http://203.0.113.9:3400', 'https://node.example.com:8443']) {
    assert.equal(isPublicEndpoint(e), true, e);
    assert.equal(publicEndpoint(e), e, e);
  }
  // 172.15 and 172.32 are OUTSIDE the private range — the mask must not swallow real addresses
  assert.equal(isPublicEndpoint('http://172.15.0.1:3400'), true);
  assert.equal(isPublicEndpoint('http://172.32.0.1:3400'), true);
});

test('anything that is not a URL cannot be offered as a link', () => {
  for (const e of ['', null, undefined, 'not a url', '192.168.1.41:3402']) {
    assert.equal(isPublicEndpoint(e as string), false, String(e));
  }
});

test('the nested copies are masked too — they are the ones that get missed', () => {
  const info = {
    name: 'node-a', address: '0xabc', endpoint: 'http://192.168.1.41:3402',
    agents: [{ id: 'news', url: 'http://192.168.1.41:3402/agents/news' }, { id: 'pub', url: 'https://x.example/agents/pub' }],
  };
  const out = publicPeerInfo(info)!;
  assert.equal(out.endpoint, null);
  assert.equal(out.agents[0].url, undefined, 'an agent URL is an endpoint with a path: the host decides');
  assert.equal(out.agents[1].url, 'https://x.example/agents/pub');
  assert.equal(out.name, 'node-a', 'everything that is not a location survives');
  assert.equal(out.address, '0xabc');
  assert.equal(publicPeerInfo(null), null);
  // the input is not mutated: the node goes on using the real address to reach the peer
  assert.equal(info.endpoint, 'http://192.168.1.41:3402');
  assert.equal(info.agents[0].url, 'http://192.168.1.41:3402/agents/news');
});
