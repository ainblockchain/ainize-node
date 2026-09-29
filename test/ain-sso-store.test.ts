/**
 * AIN SSO storage: the schema change is additive (an existing node database opens unchanged and keeps working),
 * and organization keys are switched off, back on, or deleted without touching personal ones — durably.
 *
 *   node --test --import tsx test/ain-sso-store.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { OpenaiApiKeyStore } from '../src/openai-api-keys.js';
import { legacyPrincipal, readSsoConfig, ssoPrincipal } from '../src/sso.js';

const tmp = mkdtempSync(join(tmpdir(), 'ainize-sso-store-'));
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));

test('a database from before AIN SSO opens, keeps its sessions, and gains the new tables and columns', () => {
  const path = join(tmp, 'old.sqlite');
  const old = new DatabaseSync(path);
  // The sessions table exactly as a node before this change left it.
  old.exec(`CREATE TABLE sessions (token TEXT PRIMARY KEY, created_at REAL NOT NULL, expires_at REAL NOT NULL, subject TEXT, scheme TEXT, via_key TEXT);`);
  old.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)').run('wallet-token', Date.now(), Date.now() + 60_000, '0xabc', 'eip191', null);
  old.close();

  const store = new Store(path);
  const row = store.getSession('wallet-token');
  assert.equal(row?.subject, '0xabc');
  assert.equal(row?.scheme, 'eip191');
  assert.equal(row?.sso, null, 'a wallet session carries no SSO fields');
  assert.equal(store.ssoIdentity('https://auth.example', 'acc_x'), null);
  store.close();
  // Opening twice is a no-op: the migration is idempotent.
  const again = new Store(path);
  assert.ok(again.getSession('wallet-token'));
  again.close();
});

test('identities: one principal per (issuer, subject), one subject per principal, history kept on relink', () => {
  const store = new Store(':memory:');
  store.insertSsoIdentity({ issuer: 'https://i', subject: 'acc_1', principal: 'sso:acc_1', linkProof: 'sso_login' });
  store.insertSsoIdentity({ issuer: 'https://i', subject: 'acc_1', principal: 'sso:acc_other', linkProof: 'sso_login' });
  assert.equal(store.ssoIdentity('https://i', 'acc_1')?.principal, 'sso:acc_1', 'insert-if-absent: the first one wins, nothing is re-pointed');
  store.insertSsoIdentity({ issuer: 'https://i', subject: 'acc_2', principal: 'google:42', linkProof: 'legacy_mapping' });
  assert.throws(() => store.insertSsoIdentity({ issuer: 'https://i', subject: 'acc_3', principal: 'google:42', linkProof: 'legacy_mapping' }),
    /UNIQUE/, 'a legacy principal belongs to one account');
  store.relinkSsoIdentity('https://i', 'acc_2', 'sso:acc_2', 'provisioning', 'legacy_mapping_rolled_back');
  assert.equal(store.ssoIdentity('https://i', 'acc_2')?.principal, 'sso:acc_2');
  assert.deepEqual(store.ssoLinkHistory('https://i', 'acc_2').map((h) => [h.principal, h.reason]), [['google:42', 'legacy_mapping_rolled_back']]);
  store.close();
});

test('a transaction that throws leaves nothing behind', () => {
  const store = new Store(':memory:');
  assert.throws(() => store.transaction(() => {
    store.insertSsoIdentity({ issuer: 'https://i', subject: 'acc_t', principal: 'sso:acc_t', linkProof: 'sso_login' });
    throw new Error('boom');
  }));
  assert.equal(store.ssoIdentity('https://i', 'acc_t'), null);
  store.close();
});

test('organization keys: disable, enable and revoke touch only that owner\'s keys for that organization, and persist', () => {
  const file = join(tmp, 'keys.json');
  const keys = new OpenaiApiKeyStore(file);
  const orgA = keys.issue('sso:acc_1', 'a', 'org_a');
  const orgB = keys.issue('sso:acc_1', 'b', 'org_b');
  const personal = keys.issue('sso:acc_1', 'p');
  const someoneElse = keys.issue('sso:acc_2', 'x', 'org_a');
  assert.equal(keys.setOrgKeys('sso:acc_1', 'org_a', 'disable', 'test'), 1);
  assert.equal(keys.addressForKey(orgA), null);
  assert.equal(keys.addressForKey(orgB), 'sso:acc_1');
  assert.equal(keys.addressForKey(personal), 'sso:acc_1');
  assert.equal(keys.addressForKey(someoneElse), 'sso:acc_2');
  // Durable: a restart does not quietly re-enable it.
  assert.equal(new OpenaiApiKeyStore(file).addressForKey(orgA), null);
  assert.equal(keys.setOrgKeys('sso:acc_1', 'org_a', 'enable', 'test'), 1);
  assert.equal(new OpenaiApiKeyStore(file).addressForKey(orgA), 'sso:acc_1');
  assert.equal(keys.setOrgKeys('sso:acc_1', 'org_a', 'revoke', 'test'), 1);
  assert.equal(keys.addressForKey(orgA), null);
  assert.equal(keys.setOrgKeys('sso:acc_1', 'org_a', 'enable', 'test'), 0, 'a deleted key cannot be re-enabled');
  assert.equal(keys.revokeAllOrgKeys('sso:acc_1'), 1);
  assert.equal(keys.addressForKey(orgB), null);
  assert.equal(keys.addressForKey(personal), 'sso:acc_1', 'personal keys are never touched');
  const listed = keys.listFor('sso:acc_1');
  assert.deepEqual(listed.map((k) => [k.label, k.org_id, k.disabled]), [['p', null, false]]);
});

test('a rolled-back link takes the keys made through it: organization keys, and keys that AIN account\'s sessions made', () => {
  const file = join(tmp, 'via.json');
  const keys = new OpenaiApiKeyStore(file);
  const via = { iss: 'https://i', sub: 'acc_bob' };
  const own = keys.issue('google:1', 'alice');
  const bobPersonal = keys.issue('google:1', 'bob', null, via);
  const bobOrg = keys.issue('google:1', 'bob work', 'org_a', via);
  const oldOrg = keys.issue('google:1', 'from before via', 'org_b');
  const otherAccount = keys.issue('google:1', 'carol', null, { iss: 'https://i', sub: 'acc_carol' });
  const otherIssuer = keys.issue('google:1', 'elsewhere', null, { iss: 'https://j', sub: 'acc_bob' });
  const bobsOwn = keys.issue('sso:acc_bob', 'bob own', null, via);
  keys.setOrgKeys('google:1', 'org_a', 'disable', 'test'); // switched off is still revoked
  assert.deepEqual((JSON.parse(readFileSync(file, 'utf8')) as Record<string, { via?: unknown }>)[createHash('sha256').update(bobPersonal).digest('hex')]?.via, via, 'persisted');
  const reloaded = new OpenaiApiKeyStore(file); // what the node reads after a restart
  assert.equal(reloaded.revokeObtainedThrough('google:1', via), 3);
  for (const k of [bobPersonal, bobOrg, oldOrg]) assert.equal(reloaded.addressForKey(k), null);
  assert.equal(reloaded.addressForKey(own), 'google:1');
  assert.equal(reloaded.addressForKey(otherAccount), 'google:1');
  assert.equal(reloaded.addressForKey(otherIssuer), 'google:1');
  assert.equal(reloaded.addressForKey(bobsOwn), 'sso:acc_bob', 'another principal\'s keys are not this one\'s');
  assert.equal(new OpenaiApiKeyStore(file).listFor('google:1').length, 3, 'and it is on disk');
});

test('a key file that cannot be written leaves the keys exactly as they were', () => {
  const dir = join(tmp, 'ro');
  mkdirSync(dir);
  const file = join(dir, 'keys.json');
  const keys = new OpenaiApiKeyStore(file);
  const org = keys.issue('sso:acc_9', 'a', 'org_a');
  chmodSync(dir, 0o500);
  try {
    if (process.getuid?.() === 0) return; // root writes anyway; nothing to prove
    assert.throws(() => keys.setOrgKeys('sso:acc_9', 'org_a', 'disable', 'test'));
    assert.equal(keys.addressForKey(org), 'sso:acc_9', 'not "disabled until the next restart"');
  } finally { chmodSync(dir, 0o700); }
});

test('a switched-off key is invisible to a build from before organization keys (a node rollback cannot revive it)', () => {
  const file = join(tmp, 'rollback.json');
  const keys = new OpenaiApiKeyStore(file);
  const org = keys.issue('sso:acc_r', 'a', 'org_a');
  keys.setOrgKeys('sso:acc_r', 'org_a', 'disable', 'test');
  // What an older build does: look the key's hash up in the file, and nothing else.
  const onDisk = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  assert.equal(onDisk[createHash('sha256').update(org).digest('hex')], undefined);
  assert.equal(keys.listFor('sso:acc_r')[0]?.disabled, true, 'still listed, as switched off, with its real prefix');
  assert.equal(keys.listFor('sso:acc_r')[0]?.prefix, createHash('sha256').update(org).digest('hex').slice(0, 8));
  assert.ok(keys.revokeByPrefixFor('sso:acc_r', keys.listFor('sso:acc_r')[0]!.prefix), 'and its owner can still delete it');
});

test('a personal key written before organization keys existed is byte-for-byte what it was', () => {
  const file = join(tmp, 'plain.json');
  new OpenaiApiKeyStore(file).issue('0x0000000000000000000000000000000000000001', 'laptop');
  const [record] = Object.values(JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>>);
  assert.deepEqual(Object.keys(record!).sort(), ['address', 'issuedAt', 'label']);
});

test('the organization gate is asked at use time for organization keys only', () => {
  const keys = new OpenaiApiKeyStore(join(tmp, 'gate.json'));
  const org = keys.issue('sso:acc_g', 'a', 'org_a');
  const personal = keys.issue('sso:acc_g', 'p');
  keys.orgGate = (_owner, orgId) => orgId !== 'org_a';
  assert.equal(keys.addressForKey(org), null);
  assert.equal(keys.addressForKey(personal), 'sso:acc_g');
});

test('configuration: off unless issuer and client are both set; https only, except loopback', () => {
  assert.equal(readSsoConfig({}), null);
  assert.equal(readSsoConfig({ AIN_SSO_ISSUER: 'https://auth.comcom.ai' }), null);
  assert.equal(readSsoConfig({ AIN_SSO_CLIENT_ID: 'app_ainize' }), null);
  assert.equal(readSsoConfig({ AIN_SSO_ISSUER: 'http://auth.comcom.ai', AIN_SSO_CLIENT_ID: 'app_ainize' }), null);
  assert.deepEqual(readSsoConfig({ AIN_SSO_ISSUER: 'https://auth.comcom.ai', AIN_SSO_CLIENT_ID: 'app_ainize', AIN_SSO_ADAPTER_URL: 'https://ainize.ai/api/sso/adapter/' }), {
    issuer: 'https://auth.comcom.ai', clientId: 'app_ainize', adapterUrl: 'https://ainize.ai/api/sso/adapter', jwksUri: 'https://auth.comcom.ai/oidc/jwks',
  });
  assert.ok(readSsoConfig({ AIN_SSO_ISSUER: 'http://127.0.0.1:9', AIN_SSO_CLIENT_ID: 'c' }));
});

test('principals: only google:<sub> is a legacy principal; sso principals are derived from the subject', () => {
  assert.equal(legacyPrincipal('google:1098765'), 'google:1098765');
  assert.equal(legacyPrincipal(' Google:ABC '), 'google:abc');
  for (const bad of ['0x075cf9b40b1e8c3779b6704997de16ee05fb5481', 'sso:acc_1', 'google:', 'google:a b', 'email:a@b.c', null, undefined]) {
    assert.equal(legacyPrincipal(bad), null, String(bad));
  }
  assert.equal(ssoPrincipal('acc_0123'), 'sso:acc_0123');
});
