/**
 * The SAM contract, in the parts that decide whether a call is allowed to leave this node.
 *
 * These are the pieces where being merely close to the specification is worse than not implementing it: an
 * operator who sets `egressRequireLabels` believes nothing leaves without a match, and a caller who sets
 * `X-Sam-Required-Labels` believes the same. Every test below is a way that belief has been broken in real
 * mesh implementations — a malformed header read as "no requirement", a self-signed label accepted as an
 * attestation, a caller's pair standing in for the operator's floor.
 *
 * Card regeneration is here for a different reason: it is the one thing that makes a STOCK client work
 * through the mesh. If the regenerated card keeps any address of the provider's own machine, the client
 * follows it and talks to itself.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIdentity } from '@ainize/core';
import {
  attestationPayload, meshUrl, parseRequiredLabels, regenerateCard, samAuthHeader, satisfiesFloor,
  satisfiesRequirement, signAttestation, validateLabelValue, verifyAttestation, verifySamAuth,
} from '../src/sam.js';

const provider = createIdentity();
const authority = createIdentity();
const caller = createIdentity();

/* ---------------------------------------------------------------- the header */

test('a blank header is no requirement; a header with content but no pair is an ERROR, not an empty one', () => {
  assert.deepEqual(parseRequiredLabels(undefined), { labels: {} });
  assert.deepEqual(parseRequiredLabels('   '), { labels: {} });
  // an empty requirement switches the gate off, so reading ",," as one would turn fail-closed into fail-open
  assert.ok('error' in parseRequiredLabels(',,'));
  assert.ok('error' in parseRequiredLabels('region'));
});

test('pairs parse, a trailing comma is harmless, and a duplicate key is refused', () => {
  assert.deepEqual(parseRequiredLabels('region=kr,team=platform'), { labels: { region: 'kr', team: 'platform' } });
  assert.deepEqual(parseRequiredLabels('region=kr,'), { labels: { region: 'kr' } });
  assert.ok('error' in parseRequiredLabels('region=kr,region=jp'));
});

test('a label value may not carry the wire separators — it could otherwise forge a second pair', () => {
  assert.ok(validateLabelValue('kr') === null);
  assert.ok(validateLabelValue('a,b'));
  assert.ok(validateLabelValue('a=b'));
  assert.ok(validateLabelValue(''));
  assert.ok(validateLabelValue('x'.repeat(256)));
  assert.ok('error' in parseRequiredLabels('bad key=kr'), 'a key outside [a-zA-Z0-9_.-] is refused');
});

/* ---------------------------------------------------------------- the two matching rules */

test('the caller requirement is satisfied by ANY one attested pair', () => {
  const attested = { region: 'kr', team: 'platform' };
  assert.equal(satisfiesRequirement(attested, { region: 'kr' }), true);
  assert.equal(satisfiesRequirement(attested, { region: 'jp', team: 'platform' }), true, 'any one is enough');
  assert.equal(satisfiesRequirement(attested, { region: 'jp' }), false);
  assert.equal(satisfiesRequirement(attested, {}), true, 'no requirement is satisfied by anything');
  assert.equal(satisfiesRequirement({ region: 'KR' }, { region: 'kr' }), false, 'matching is case-sensitive');
});

test('the operator floor demands EVERY pair, and the caller cannot stand in for it', () => {
  const attested = { region: 'kr' };
  assert.equal(satisfiesFloor(attested, { region: 'kr' }), true);
  assert.equal(satisfiesFloor(attested, { region: 'kr', jurisdiction: 'kr' }), false);
  assert.equal(satisfiesFloor(attested, {}), true, 'no floor bounds nothing');
  // the two are checked separately for exactly this reason: merged, the caller's pair would satisfy the floor
  assert.equal(satisfiesRequirement(attested, { region: 'kr' }) && satisfiesFloor(attested, { jurisdiction: 'kr' }), false);
});

/* ---------------------------------------------------------------- attestation */

test('an attestation signed by a configured authority verifies', () => {
  const att = signAttestation(provider.address, { region: 'kr' }, authority);
  const out = verifyAttestation(att, { peer: provider.address, authorities: [authority.address] });
  assert.deepEqual(out, { labels: { region: 'kr' } });
});

test('a node signing its OWN labels is refused unless the operator opts in — a claim is not an attestation', () => {
  const att = signAttestation(provider.address, { region: 'kr' }, provider);
  const refused = verifyAttestation(att, { peer: provider.address, authorities: [] });
  assert.ok('error' in refused && /self-attestation/.test(refused.error));
  const allowed = verifyAttestation(att, { peer: provider.address, authorities: [], trustSelf: true });
  assert.deepEqual(allowed, { labels: { region: 'kr' } });
});

test('a stranger’s signature is refused however well-formed', () => {
  const att = signAttestation(provider.address, { region: 'kr' }, caller);
  const out = verifyAttestation(att, { peer: provider.address, authorities: [authority.address] });
  assert.ok('error' in out && /not a label authority/.test(out.error));
});

test('an attestation about another node, an expired one, and a tampered one all yield NO labels', () => {
  const authorities = [authority.address];
  const other = verifyAttestation(signAttestation(caller.address, { region: 'kr' }, authority), { peer: provider.address, authorities });
  assert.ok('error' in other && /is about/.test(other.error));

  const old = signAttestation(provider.address, { region: 'kr' }, authority, Date.now() - 7 * 24 * 3600_000);
  assert.ok('error' in verifyAttestation(old, { peer: provider.address, authorities }));

  // the signature covers the labels; changing one after the fact must not survive
  const att = { ...signAttestation(provider.address, { region: 'kr' }, authority), labels: { region: 'jp' } };
  const tampered = verifyAttestation(att, { peer: provider.address, authorities });
  assert.ok('error' in tampered && /signature/.test(tampered.error));

  assert.ok('error' in verifyAttestation(null, { peer: provider.address, authorities }), 'a peer that answers nothing is refused');
});

test('the signed payload is canonical — label order cannot change what was signed', () => {
  const a = attestationPayload({ subject: 'n', labels: { b: '2', a: '1' }, issued_at: 1, expires_at: 2 });
  const b = attestationPayload({ subject: 'n', labels: { a: '1', b: '2' }, issued_at: 1, expires_at: 2 });
  assert.equal(a, b);
  assert.match(a, /^sam:labels:n:1:2:a=1\|b=2$/);
});

/* ---------------------------------------------------------------- card regeneration */

const V1_CARD = {
  name: 'News Fitness',
  supportedInterfaces: [
    { protocolBinding: 'JSONRPC', url: 'http://127.0.0.1:4010' },
    { protocolBinding: 'GRPC', url: 'grpc://127.0.0.1:4011' },
  ],
  capabilities: { streaming: true, extensions: [{ uri: 'https://a2ui.org/a2a-extension/a2ui/v0.8' }] },
  signatures: [{ protected: 'x', signature: 'y' }],
};

test('every interface URL points back at the mesh path — a kept provider address is the whole bug', () => {
  const base = 'https://a.example/sam/0xabc/a2a/news';
  const out = regenerateCard(V1_CARD, base);
  assert.ok('card' in out);
  const ifaces = out.card.supportedInterfaces as { protocolBinding: string; url: string }[];
  assert.deepEqual(ifaces.map((i) => i.url), [base]);
  assert.equal(ifaces.length, 1, 'gRPC needs its own end-to-end connection and is dropped');
  for (const i of ifaces) assert.ok(!/127\.0\.0\.1/.test(i.url));
});

test('the agent’s own streaming flag survives, and its signatures do not', () => {
  const out = regenerateCard(V1_CARD, 'https://a.example/sam/0xabc/a2a/news');
  assert.ok('card' in out);
  /**
   * SAM's own regeneration forces `streaming: false`, because a hop that cannot forward a stream must not
   * advertise one. This hop pipes the upstream body through (`pipeRelay`), so the flag is the agent's to
   * declare — and forcing it false told every client to take the slow path against two agents that report
   * each step they take.
   */
  assert.equal((out.card.capabilities as { streaming: boolean }).streaming, true);
  assert.equal('signatures' in out.card, false);
  // the extension list is untouched: what the agent can do does not change by being reached over the mesh
  assert.equal(((out.card.capabilities as { extensions: unknown[] }).extensions).length, 1);
});

test('required list fields stay arrays — null is what strict card parsers reject', () => {
  const out = regenerateCard({ url: 'http://127.0.0.1:4010', preferredTransport: 'JSONRPC' }, 'https://a.example/x');
  assert.ok('card' in out);
  assert.deepEqual(out.card.skills, []);
  assert.deepEqual(out.card.defaultInputModes, []);
  assert.deepEqual(out.card.defaultOutputModes, []);
});

test('a v0.3 card is rewritten rather than refused — every workspace on the older dialect depends on it', () => {
  const base = 'https://a.example/sam/0xabc/a2a/news';
  const out = regenerateCard({
    name: 'News', url: 'http://127.0.0.1:4010', preferredTransport: 'JSONRPC',
    additionalInterfaces: [{ transport: 'JSONRPC', url: 'http://127.0.0.1:4010' }, { transport: 'GRPC', url: 'grpc://x' }],
  }, base);
  assert.ok('card' in out);
  assert.equal(out.card.url, base);
  assert.deepEqual((out.card.additionalInterfaces as { url: string }[]).map((i) => i.url), [base]);
});

test('a card the mesh cannot carry at all is an error, not a card pointing at the provider’s localhost', () => {
  const out = regenerateCard({ name: 'g', supportedInterfaces: [{ protocolBinding: 'GRPC', url: 'grpc://x' }] }, 'https://a.example/x');
  assert.ok('error' in out);
  assert.ok('error' in regenerateCard('not a card', 'https://a.example/x'));
});

test('the mesh URL is the caller’s own node plus the peer and service', () => {
  assert.equal(meshUrl('https://a.example/', '0xabc', 'news'), 'https://a.example/sam/0xabc/a2a/news');
  // a card fetched through the browser mount must answer with that mount: it is the one the client has
  // actually reached, and behind a proxy that forwards only /api the other one is an HTML page
  assert.equal(meshUrl('https://a.example', '0xabc', 'news', '/api/sam'), 'https://a.example/api/sam/0xabc/a2a/news');
});

/* ---------------------------------------------------------------- caller attribution */

test('the egress signature names the caller, and is bound to the peer and the service it was made for', () => {
  const h = samAuthHeader(caller, provider.address, 'news');
  assert.equal(verifySamAuth(h, provider.address, 'news'), caller.address);
  assert.equal(verifySamAuth(h, provider.address, 'other-agent'), null, 'a captured header is useless elsewhere');
  assert.equal(verifySamAuth(h, caller.address, 'news'), null);
  assert.equal(verifySamAuth(undefined, provider.address, 'news'), null);
  assert.equal(verifySamAuth('garbage', provider.address, 'news'), null);
  // stale beyond the skew window: a header kept from a log must not replay
  const [addr, , sig] = h.split(':');
  assert.equal(verifySamAuth(`${addr}:${Date.now() - 3600_000}:${sig}`, provider.address, 'news'), null);
});
