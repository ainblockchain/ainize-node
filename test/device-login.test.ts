/**
 * `ainize login` — a command line asking a person to vouch for it, end to end.
 *
 * The CLI holds a key and signs every request with it. That is right and it is not enough: nothing connects that
 * key to the person whose knowledge it publishes and whose payouts it moves, and a command line cannot open a
 * wallet prompt to say so. So it asks for a code, prints a URL, and waits; a person opens it in a browser they
 * are already signed into, reads what is being authorised, and approves it with one wallet signature.
 *
 * What this file pins is every way that can go wrong. The code is printed to a terminal, so it must be worthless
 * to a reader; the approval must be a signature over the exact bytes the person saw, not merely the existence of
 * a session; the session must be collectable once and by the CLI that asked; and what it leaves behind must be
 * visible to the person and endable by them, sessions and all.
 *
 *   node --test --import tsx test/device-login.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIdentity, defaultConfig, operatorLoginMessage, signMessage, type NodeConfig } from '@ainize/core';
import { startNode, type RunningNode } from '../src/server.js';
import { personalSign } from './fixtures/metamask.js';

const tmp = mkdtempSync(join(tmpdir(), 'ngram-device-'));
const PORT = 24141;
const HUMAN = createIdentity();      // the address in someone's MetaMask
const CLI = createIdentity();        // the key `ainize login` generated on a laptop

let N: RunningNode;
let url = '';
let identity: NodeConfig['identity'];

const call = async (method: string, path: string, body?: unknown, token?: string) => {
  const r = await fetch(`${url}${path}`, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() as Record<string, unknown> };
};
/** Sign in the way the browser does: a challenge issued for `eip191`, signed by the wallet. */
const walletSignIn = async (id: { privateKey: string; address: string }) => {
  const ch = (await call('POST', '/api/auth/challenge', { scheme: 'eip191' })).body as { nonce: string; message: string };
  const r = await call('POST', '/api/auth/wallet', { address: id.address, nonce: ch.nonce, signature: personalSign(ch.message, id.privateKey) });
  return r.body.token as string;
};
/** Sign in the way the CLI does once it is bound: its own key, its own scheme, no wallet anywhere. */
const keySignIn = async (id: { privateKey: string; address: string }) => {
  const ch = (await call('POST', '/api/auth/challenge', {})).body as { nonce: string; message: string };
  return call('POST', '/api/auth/wallet', { address: id.address, nonce: ch.nonce, signature: signMessage(ch.message, id.privateKey) });
};
const ask = async (delegate = CLI.address, label = "kmh's laptop") =>
  (await call('POST', '/api/auth/device', { delegate, label })).body as { code: string; poll_secret: string; url: string; expires_at: number };
const approve = (code: string, message: string, id: { privateKey: string }, token: string) =>
  call('POST', `/api/auth/device/${code}/approve`, { signature: personalSign(message, id.privateKey) }, token);

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

test('the whole flow: a key asks, a person approves, the key gets a session as them', async () => {
  const req = await ask();
  // The URL is what gets printed to the terminal, so it has to be openable by whoever is looking at it.
  assert.equal(req.url, `${url}/authorize?code=${encodeURIComponent(req.code)}`);

  const shown = (await call('GET', `/api/auth/device/${req.code}`)).body as { status: string; delegate: string; label: string; message: string };
  assert.equal(shown.status, 'pending');
  assert.equal(shown.delegate, CLI.address.toLowerCase());
  // Everything that decides whether to approve is in the BYTES, not only on the page around them: which key, on
  // whose say-so it is named, and until when. A field only on the page could be varied by whoever built the link.
  assert.ok(shown.message.startsWith('Authorize a command line to act as you'));
  assert.ok(shown.message.includes(CLI.address), 'the key being authorised');
  assert.ok(shown.message.includes('demo-node'), 'the node, by the name the person knows it as');
  assert.ok(shown.message.includes("kmh's laptop"), 'and what the CLI called itself');
  assert.match(shown.message, /moves no funds now/);

  // Nothing yet — the CLI is still waiting, and "not yet" has to be a cheap, boring answer.
  assert.equal((await call('POST', `/api/auth/device/${req.code}/claim`, { poll_secret: req.poll_secret })).body.status, 'pending');

  const browser = await walletSignIn(HUMAN);
  const ok = await approve(req.code, shown.message, HUMAN, browser);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));

  const got = await call('POST', `/api/auth/device/${req.code}/claim`, { poll_secret: req.poll_secret });
  assert.equal(got.body.status, 'approved');
  assert.equal(got.body.owner, HUMAN.address.toLowerCase());
  assert.equal(got.body.isOwner, true, 'HUMAN is in operatorAddresses, so the CLI inherits that');

  // The session belongs to the PERSON. The key is recorded as what stood in for them, which is what makes
  // "end that laptop" a question with an answer.
  const sess = N.store.getSession(got.body.token as string);
  assert.equal(sess?.subject, HUMAN.address.toLowerCase());
  assert.equal(sess?.via_key, CLI.address.toLowerCase());
  const me = (await call('GET', '/api/auth/me', undefined, got.body.token as string)).body;
  assert.equal(me.subject, HUMAN.address.toLowerCase());
  assert.equal(me.via_key, CLI.address.toLowerCase());
  assert.equal(me.isOwner, true);
});

test('after that, the CLI signs in with its own key and no wallet at all', async () => {
  // The whole point of writing the binding down: `ainize login` is something you do once, not every morning.
  const again = await keySignIn(CLI);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.address, HUMAN.address.toLowerCase(), 'the session is the person, not the laptop');
  assert.equal(again.body.via_key, CLI.address.toLowerCase());
  // `ain`, because that is what happened: a key acted on its own. Claiming `eip191` would say a person read a
  // prompt during a sign-in nobody watched.
  assert.equal(N.store.getSession(again.body.token as string)?.scheme, 'ain');
  assert.equal(again.body.isOwner, true);
});

test('the code is printed to a terminal, so it must be worth nothing on its own', async () => {
  const req = await ask(createIdentity().address);
  // Reading it over a shoulder shows you what is being asked — that is what a person needs to approve it — and
  // gets you no further: collecting the session needs the secret the CLI kept and never printed.
  assert.equal((await call('GET', `/api/auth/device/${req.code}`)).status, 200);
  for (const guess of ['', 'x', req.poll_secret.slice(0, -1), `${req.poll_secret}x`]) {
    assert.equal((await call('POST', `/api/auth/device/${req.code}/claim`, { poll_secret: guess })).status, 404, JSON.stringify(guess));
  }
  // Nor is the secret itself stored where a copy of the database would reveal it.
  assert.equal(N.store.deviceGrant(req.code)?.poll_hash.includes(req.poll_secret), false);
});

test('a session is not an approval: the signature is what says they meant this one', async () => {
  const req = await ask(createIdentity().address);
  const shown = (await call('GET', `/api/auth/device/${req.code}`)).body as { message: string };
  const browser = await walletSignIn(HUMAN);

  // Signed in, and still refused — because a page acting on a session it found could otherwise authorise anything.
  const noSig = await call('POST', `/api/auth/device/${req.code}/approve`, { signature: `0x${'11'.repeat(65)}` }, browser);
  assert.equal(noSig.status, 401);
  // A signature over some OTHER message, by the right person. The bytes are what they read; nothing else counts.
  const wrongBytes = await approve(req.code, 'Authorize a command line to act as you\n\nKey: 0xsomething else', HUMAN, browser);
  assert.equal(wrongBytes.status, 401);
  // The right bytes, signed by the wrong person — they may be signed in elsewhere, but they are not this session.
  const stranger = createIdentity();
  const wrongWho = await approve(req.code, shown.message, stranger, browser);
  assert.equal(wrongWho.status, 401);
  // And not with no session at all, however good the signature is.
  assert.equal((await approve(req.code, shown.message, HUMAN, '')).status, 401);

  assert.equal((await approve(req.code, shown.message, HUMAN, browser)).status, 200);
});

test('one code, one session — a race must not hand out two', async () => {
  const key = createIdentity();
  const req = await ask(key.address);
  const shown = (await call('GET', `/api/auth/device/${req.code}`)).body as { message: string };
  const browser = await walletSignIn(HUMAN);
  await approve(req.code, shown.message, HUMAN, browser);

  // Both polls are in flight before either finishes: the UPDATE is what decides, not a read-then-write.
  const [a, b] = await Promise.all([
    call('POST', `/api/auth/device/${req.code}/claim`, { poll_secret: req.poll_secret }),
    call('POST', `/api/auth/device/${req.code}/claim`, { poll_secret: req.poll_secret }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  // And approving it a second time is refused too, so a stale browser tab cannot re-point a spent code.
  assert.equal((await approve(req.code, shown.message, HUMAN, browser)).status, 409);
});

test('a person can see every machine that speaks for them, and end one', async () => {
  const laptop = createIdentity();
  const req = await ask(laptop.address, 'the other laptop');
  const shown = (await call('GET', `/api/auth/device/${req.code}`)).body as { message: string };
  const browser = await walletSignIn(HUMAN);
  await approve(req.code, shown.message, HUMAN, browser);
  const theirs = (await call('POST', `/api/auth/device/${req.code}/claim`, { poll_secret: req.poll_secret })).body.token as string;

  const list = (await call('GET', '/api/auth/bindings', undefined, browser)).body.bindings as { delegate: string; label: string }[];
  assert.ok(list.some((b) => b.delegate === laptop.address.toLowerCase() && b.label === 'the other laptop'), JSON.stringify(list));

  // Somebody else's list is not something a session buys, and neither is ending one of their machines.
  const outsider = await walletSignIn(createIdentity());
  assert.deepEqual((await call('GET', '/api/auth/bindings', undefined, outsider)).body.bindings, []);
  assert.equal((await call('DELETE', `/api/auth/bindings/${laptop.address}`, undefined, outsider)).status, 404);

  const gone = await call('DELETE', `/api/auth/bindings/${laptop.address}`, undefined, browser);
  assert.equal(gone.status, 200, JSON.stringify(gone.body));
  // A revocation the session it made outlives is not a revocation — the cookie would have another month to run.
  assert.equal(gone.body.sessions_ended, 1);
  assert.equal(N.store.getSession(theirs), null);
  // And the key is back to being nobody: signing in with it names the key, not the person.
  const after = await keySignIn(laptop);
  assert.equal(after.body.address, laptop.address.toLowerCase());
  assert.equal(after.body.isOwner, false);
});

test('an expired request is not a pending one, and says which it is', async () => {
  const req = await ask(createIdentity().address);
  // Reach past the API to age it: the alternative is a ten-minute test.
  N.store.db.prepare('UPDATE device_grants SET expires_at = ? WHERE code = ?').run(Date.now() - 1, req.code);
  assert.equal((await call('GET', `/api/auth/device/${req.code}`)).body.status, 'expired');
  const claim = await call('POST', `/api/auth/device/${req.code}/claim`, { poll_secret: req.poll_secret });
  assert.equal(claim.status, 410);
  assert.match(String(claim.body.error), /ainize login/, 'the refusal names the way out');

  const browser = await walletSignIn(HUMAN);
  const shown = (await call('GET', `/api/auth/device/${req.code}`)).body as { message: string };
  assert.equal((await approve(req.code, shown.message, HUMAN, browser)).status, 410, 'and it cannot be approved late');
});

test('a code this node never issued is not an invitation to guess', async () => {
  for (const code of ['nope', '../etc/passwd', 'a'.repeat(64)]) {
    assert.equal((await call('GET', `/api/auth/device/${encodeURIComponent(code)}`)).status, 404, code);
    assert.equal((await call('POST', `/api/auth/device/${encodeURIComponent(code)}/claim`, { poll_secret: 'x' })).status, 404, code);
  }
  // A label is the CLI's own words about itself, and must not be able to forge lines in the message around it.
  const req = await ask(createIdentity().address, 'laptop"\nUntil:   never');
  const shown = (await call('GET', `/api/auth/device/${req.code}`)).body as { message: string; label: string };
  assert.equal(shown.label, 'laptop Until:   never');
  assert.equal(shown.message.split('\n').filter((l) => l.startsWith('Until:')).length, 1, "exactly one Until line, and it is the node's");
  assert.ok(shown.message.includes(new Date(N.store.deviceGrant(req.code)!.expires).toISOString().slice(0, 16)), 'and it says the real expiry');
});

test('signing in as the node itself is untouched by any of this', async () => {
  // The node's own key has no binding and needs none: it signs in as itself, which is what it has always done,
  // and every test fixture in this repository depends on that still being true.
  const r = await keySignIn(identity);
  assert.equal(r.status, 200);
  assert.equal(r.body.address, identity.address.toLowerCase());
  assert.equal(r.body.via_key, null);
  assert.equal(r.body.isOwner, true);
});
