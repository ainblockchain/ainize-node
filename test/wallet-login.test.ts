/**
 * Signing in with a browser wallet, and the wall between that and the CLI's way in.
 *
 * The node's sign-in has only ever accepted one signing scheme: AIN's, which double-keccaks a length-prefixed
 * message and counts the length in UTF-16 code units. MetaMask speaks EIP-191, which keccaks once and counts
 * UTF-8 bytes. Same curve, same key, same address — and signatures that verify under neither the other's rules.
 * That is why a person with a MetaMask wallet could not sign in at all, and why the fix cannot be "try both".
 *
 * So the scheme is chosen when the challenge is asked for and fixed from then on, and the node verifies against
 * the exact string it issued rather than rebuilding one. This file pins both, and pins that the readable message
 * a wallet shows really is the string being signed — the whole point of it being readable is lost if it is not.
 *
 *   node --test --import tsx test/wallet-login.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIdentity, defaultConfig, operatorLoginMessage, signMessage, type NodeConfig } from '@ainize/core';
import { startNode, type RunningNode } from '../src/server.js';
import { walletLoginMessage, requestOrigin } from '../src/wallet-login.js';
import { personalSign } from './fixtures/metamask.js';

const tmp = mkdtempSync(join(tmpdir(), 'ngram-wallet-'));
const PORT = 24131;
const HUMAN = createIdentity();   // the address in someone's MetaMask

let N: RunningNode;
let url = '';
let identity: NodeConfig['identity'];

const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() as Record<string, unknown> };
};
type Challenge = { nonce: string; message: string; scheme: string; expires_at: number };
const challenge = async (scheme?: string, headers: Record<string, string> = {}) =>
  (await post('/api/auth/challenge', scheme ? { scheme } : {}, headers)).body as unknown as Challenge;

before(async () => {
  const cfg: NodeConfig = defaultConfig({ home: join(tmp, 'N'), name: 'demo-node', port: PORT, peers: [], roles: ['seller'], ledger: 'local' });
  cfg.runtime = { repo: undefined, api: 'http://127.0.0.1:1', hookApi: 'http://127.0.0.1:1' };
  cfg.host = '127.0.0.1'; cfg.publicUrl = `http://127.0.0.1:${PORT}`;
  cfg.operatorAddresses = [HUMAN.address];
  cfg.verifier = { quorum: 1, allowSelfAttest: true, intervalMs: 300_000, auto: false };
  cfg.gossipIntervalMs = 60_000;
  N = await startNode(cfg, { quiet: true, serveWeb: false });
  identity = cfg.identity;
  url = `http://127.0.0.1:${PORT}`;
});
after(async () => { await N?.stop(); rmSync(tmp, { recursive: true, force: true }); });

test('a MetaMask signature signs in, and the session says a person made it', async () => {
  const ch = await challenge('eip191');
  assert.equal(ch.scheme, 'eip191');
  const r = await post('/api/auth/wallet', { address: HUMAN.address, nonce: ch.nonce, signature: personalSign(ch.message, HUMAN.privateKey) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.scheme, 'eip191');
  // `eip191` on the session is the record that a human read a prompt and approved it. A key acting on its own
  // cannot produce that claim without the key, and the two are never merged into one "signed in".
  const sess = N.store.getSession(r.body.token as string);
  assert.equal(sess?.subject, HUMAN.address.toLowerCase());
  assert.equal(sess?.scheme, 'eip191');
});

test('the string the wallet shows is the string that is signed', async () => {
  const ch = await challenge('eip191', { origin: 'https://www.ainize.ai' });
  // Everything a person needs to judge the prompt is in the bytes they approve: which node, which site, when it
  // dies, and that it is not a transaction. A field that were only in the API response and not in the message
  // would be a field an attacker could vary freely while the wallet showed something reassuring.
  assert.match(ch.message, /^Sign in to Ainize\n/);
  assert.ok(ch.message.includes(N.market.address), 'the node being signed into');
  assert.ok(ch.message.includes('demo-node'), 'by the name the person knows it as');
  assert.ok(ch.message.includes('https://www.ainize.ai'), 'the site asking');
  assert.ok(ch.message.includes(ch.nonce), 'the nonce that makes it single-use');
  assert.ok(ch.message.includes(new Date(ch.expires_at).toISOString().slice(0, 16)), 'when it expires');
  assert.match(ch.message, /moves no funds/, 'and what it is not');

  // Signed exactly as shown — not a normalised, trimmed or re-serialised variant of it.
  const r = await post('/api/auth/wallet', { address: HUMAN.address, nonce: ch.nonce, signature: personalSign(ch.message, HUMAN.privateKey) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

test('the Origin is the browser\'s, never the caller\'s', () => {
  // Page script cannot set Origin, which is the only reason it is worth showing. Anything that is not a real
  // origin gets no line at all: an empty "Site:" next to a filled one reads as "no site", and that must not be
  // something a caller can arrange.
  assert.equal(requestOrigin('https://www.ainize.ai/some/path'), 'https://www.ainize.ai');
  for (const junk of [undefined, '', 'null', 'ainize.ai', 'not a url']) assert.equal(requestOrigin(junk), undefined, String(junk));
  assert.ok(!walletLoginMessage({ node: '0xabc', nonce: 'n', expiresAt: 0 }).includes('Site:'));
});

test('a scheme cannot be swapped after the challenge was issued', async () => {
  // The presenter of a signature chooses nothing about how it is checked. If they could, they would choose which
  // of the two claims the node records — "a key acted" or "a person approved" — and those are not interchangeable.
  const walletCh = await challenge('eip191');
  const asKey = await post('/api/auth/wallet', {
    address: HUMAN.address, nonce: walletCh.nonce,
    signature: signMessage(walletCh.message, HUMAN.privateKey),   // right message, right key, wrong scheme
  });
  assert.equal(asKey.status, 401, JSON.stringify(asKey.body));

  const keyCh = await challenge('ain');
  const asWallet = await post('/api/auth/wallet', {
    address: HUMAN.address, nonce: keyCh.nonce,
    signature: personalSign(keyCh.message, HUMAN.privateKey),
  });
  assert.equal(asWallet.status, 401, JSON.stringify(asWallet.body));
});

test('a CLI that has never heard of schemes still signs in', async () => {
  // @ainize/cli 0.2.5 is published and posts `{}` to this route, then signs `ainize-login:<node>:<nonce>` with
  // ain-util. It must keep working against a node that has learned a second scheme — the default is what makes
  // that true, and this is the test that notices if the default ever moves.
  const ch = await challenge();
  assert.equal(ch.scheme, 'ain');
  assert.equal(ch.message, operatorLoginMessage({ node: identity.address, nonce: ch.nonce }));
  const r = await post('/api/auth/wallet', { address: identity.address, nonce: ch.nonce, signature: signMessage(ch.message, identity.privateKey) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(N.store.getSession(r.body.token as string)?.scheme, 'ain');
});

test('a wallet signature is still worthless at a node it was not made for, and twice at this one', async () => {
  const ch = await challenge('eip191');
  const sig = personalSign(ch.message, HUMAN.privateKey);
  assert.equal((await post('/api/auth/wallet', { address: HUMAN.address, nonce: ch.nonce, signature: sig })).status, 200);
  // Single-use: the whole reason a signature is not a bearer token.
  assert.equal((await post('/api/auth/wallet', { address: HUMAN.address, nonce: ch.nonce, signature: sig })).status, 401);

  // The node's address is inside the message, so the same signature cannot be presented to a different node —
  // and a message for another node, signed correctly, is not a nonce this node ever issued.
  const elsewhere = walletLoginMessage({ node: createIdentity().address, nonce: ch.nonce, expiresAt: Date.now() + 60_000 });
  const r = await post('/api/auth/wallet', { address: HUMAN.address, nonce: ch.nonce, signature: personalSign(elsewhere, HUMAN.privateKey) });
  assert.equal(r.status, 401);
});

test('nothing anywhere still offers a password', async () => {
  // The operator password is gone: the route that took one, the `ainize password` command, and the scrypt helpers
  // in core. What outlives a removal like that is the PROSE — a docs page telling someone to run a command that
  // no longer exists, or a throttle offering to reset a secret nothing checks. That is what this reads.
  const docs = await (await fetch(`${url}/api/docs`)).json() as { openapi: unknown; cli: { groups: { commands: { cmd: string; desc: string }[] }[] } };
  const lines = docs.cli.groups.flatMap((g) => g.commands).map((c) => `${c.cmd} — ${c.desc}`);
  const offering = lines.filter((l) => /password/i.test(l));
  assert.deepEqual(offering, [], `the CLI reference still tells someone about a password:\n${offering.join('\n')}`);
  assert.ok(!lines.some((l) => /^ainize password/.test(l)), 'and `ainize password` is not a command any more');
  // The API description may say there is none — that is the sentence a reader needs — but nothing may ask for one.
  const spec = JSON.stringify(docs.openapi);
  assert.ok(!/"password"/.test(spec), 'no request body anywhere takes a password field');
});
