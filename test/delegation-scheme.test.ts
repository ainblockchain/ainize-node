/**
 * A MetaMask owner delegating a browser key, through the real request path.
 *
 * The wallet signs exactly one thing: permission for a freshly generated browser key to act as that address for a
 * bounded window. Everything after that is signed by the browser key, as it always was, because
 * `personal_sign` is a user-facing prompt and a lesson makes several requests a minute.
 *
 * What had to change is that a MetaMask owner can only sign that permission EIP-191, and the node had one
 * hard-wired idea of what a signature is. So the header names its scheme and the node honours the name. This
 * file drives `TeachAuth.verify` — the code every teach and live-test request goes through — rather than the
 * verifier underneath it, because the thing worth pinning is that a delegated request is CREDITED to the wallet.
 *
 *   node --test --import tsx test/delegation-scheme.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Request } from 'express';
import { createIdentity, delegateHeader, delegateMessage, signMessage, teachAuthMessage, DELEGATE_HEADER, TEACH_AUTH_V2 } from '@ainize/core';
import { TeachAuth } from '../src/teach-auth.js';
import { personalSign } from './fixtures/metamask.js';

const NODE = createIdentity().address;

/** The two headers a delegated request carries, on a request object shaped the way TeachAuth reads one. */
function request(opts: { delegate: { privateKey: string; address: string }; delegation?: string; path?: string }): Request {
  const ts = Date.now();
  const method = 'POST';
  const path = opts.path ?? '/api/teach/jobs';
  const body = Buffer.from('{}');
  const sig = signMessage(teachAuthMessage({ purpose: 'teach', node: NODE, method, path, ts, body }), opts.delegate.privateKey);
  const headers: Record<string, string> = { 'x-ainize-auth': `${opts.delegate.address}:${ts}:${sig}:${TEACH_AUTH_V2}` };
  if (opts.delegation) headers[DELEGATE_HEADER] = opts.delegation;
  return { method, url: path, originalUrl: path, rawBody: body, header: (n: string) => headers[n.toLowerCase()] } as unknown as Request;
}

const authorise = (owner: { privateKey: string; address: string }, delegate: string, sign: (m: string, k: string) => string, scheme?: 'ain' | 'eip191') => {
  const expires = Date.now() + 60 * 60_000;
  return delegateHeader({ owner: owner.address, expires, signature: sign(delegateMessage({ node: NODE, delegate, expires }), owner.privateKey), scheme });
};

test('a request delegated by a MetaMask wallet is credited to the wallet', () => {
  const auth = new TeachAuth(NODE);
  const owner = createIdentity();           // the address in someone's MetaMask
  const browser = createIdentity();          // the key this tab generated and never sends anywhere

  const delegation = authorise(owner, browser.address, personalSign, 'eip191');
  const who = auth.verify(request({ delegate: browser, delegation }));
  // The wallet, not the browser key. This is the whole point: the lesson belongs to the person, and the payout
  // address is theirs, while the thing that actually signed each request is a key they never see.
  assert.equal(who?.toLowerCase(), owner.address.toLowerCase());
});

test('an AIN Wallet delegation still works, unchanged and unlabelled', () => {
  const auth = new TeachAuth(NODE);
  const owner = createIdentity();
  const browser = createIdentity();
  const delegation = authorise(owner, browser.address, signMessage);
  assert.equal(delegation.split(':').length, 3, 'a header signed before schemes existed has three fields and still does');
  assert.equal(auth.verify(request({ delegate: browser, delegation }))?.toLowerCase(), owner.address.toLowerCase());
});

test('a delegation that lies about its scheme credits nobody but the key that signed the request', () => {
  const auth = new TeachAuth(NODE);
  const owner = createIdentity();
  const browser = createIdentity();
  const expires = Date.now() + 60 * 60_000;
  const message = delegateMessage({ node: NODE, delegate: browser.address, expires });

  // An AIN signature relabelled as a wallet's, and a wallet's presented with no label — both mismatches, and a
  // mismatch is not an error: the caller is simply the key that signed the request, which is a real identity
  // with its own lessons. Falling back to it is the honest reading, and it must not silently become the owner.
  for (const lying of [
    `${owner.address}:${expires}:${signMessage(message, owner.privateKey)}:eip191`,
    `${owner.address}:${expires}:${personalSign(message, owner.privateKey)}`,
  ]) {
    const who = auth.verify(request({ delegate: browser, delegation: lying }));
    assert.equal(who?.toLowerCase(), browser.address.toLowerCase(), lying.slice(-12));
  }
});

test('a wallet delegation is still bound to one node, one key and one window', () => {
  const owner = createIdentity();
  const browser = createIdentity();
  const expires = Date.now() + 60 * 60_000;
  const at = (node: string, delegate: string, exp = expires) =>
    delegateHeader({ owner: owner.address, expires: exp, scheme: 'eip191', signature: personalSign(delegateMessage({ node, delegate, expires: exp }), owner.privateKey) });

  // Every one of these falls back to the key that signed the REQUEST. Not an error: that key is a real identity
  // with its own lessons, and refusing would lose work over a delegation that had merely gone stale. What must
  // never happen is the owner's name being attached to it anyway.
  const fellBack = (delegation: string, auth = new TeachAuth(NODE)) =>
    auth.verify(request({ delegate: browser, delegation }))?.toLowerCase() === browser.address.toLowerCase();

  // Signed for another node — the node address is inside the message, so it is worthless here.
  assert.ok(fellBack(at(createIdentity().address, browser.address)), 'another node');
  // Signed for another key — a stolen header is inert without the browser key it names, which never leaves it.
  assert.ok(fellBack(at(NODE, createIdentity().address)), 'another key');
  // Past its expiry.
  assert.ok(fellBack(at(NODE, browser.address, Date.now() - 1)), 'expired');
  // And past the ceiling the node puts on one, however long the owner's prompt said: one careless approval
  // cannot authorise a key for ever.
  assert.ok(fellBack(at(NODE, browser.address), new TeachAuth(NODE, undefined, 60_000)), 'longer than this node allows');

  // The same header, unmolested, still works — otherwise the four above would prove nothing.
  assert.equal(new TeachAuth(NODE).verify(request({ delegate: browser, delegation: at(NODE, browser.address) }))?.toLowerCase(), owner.address.toLowerCase());
});

test('a request made for one node is not a request at another, before delegation is even read', () => {
  // The per-request signature binds the node too, so a captured delegated request cannot be replayed elsewhere
  // even by someone holding both headers. `verify` returns null — not a fallback identity — because nothing
  // about the request is valid here.
  const browser = createIdentity();
  const owner = createIdentity();
  const delegation = authorise(owner, browser.address, personalSign, 'eip191');
  assert.equal(new TeachAuth(createIdentity().address).verify(request({ delegate: browser, delegation })), null);
});
