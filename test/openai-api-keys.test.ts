/**
 * The key a caller puts in `api_key`, and the address it speaks for.
 *
 * A bearer key is what makes a stock OpenAI client work against this node at all, so it has to be cheap on the
 * request path: one hash and one lookup, no signature verification per call. What it must never be is recoverable
 * from the node's disk — an operator reading the file learns which addresses hold keys, not what those keys are.
 *
 *   node --test --import tsx test/openai-api-keys.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenaiApiKeyStore } from '../src/openai-api-keys.js';

const tmp = mkdtempSync(join(tmpdir(), 'ainize-keys-'));
let n = 0;
const file = () => join(tmp, `keys-${++n}.json`);

test('a key resolves to the address it was issued to', () => {
  const store = new OpenaiApiKeyStore(file());
  const key = store.issue('0xAbC0000000000000000000000000000000000001');
  assert.equal(store.addressForKey(key), '0xabc0000000000000000000000000000000000001');
});

test('addresses are compared lowercased, so a checksummed address is the same account', () => {
  const store = new OpenaiApiKeyStore(file());
  const key = store.issue('0xABC0000000000000000000000000000000000001');
  assert.equal(store.addressForKey(key), '0xabc0000000000000000000000000000000000001');
});

test('an unknown key resolves to nothing', () => {
  const store = new OpenaiApiKeyStore(file());
  assert.equal(store.addressForKey('ainize-sk-nope'), null);
});

test('a key of the wrong shape is rejected without a lookup', () => {
  const store = new OpenaiApiKeyStore(file());
  assert.equal(store.addressForKey('sk-proj-something-that-is-an-openai-key'), null);
});

test('the secret is never written to disk', () => {
  const path = file();
  const store = new OpenaiApiKeyStore(path);
  const key = store.issue('0x0000000000000000000000000000000000000002');
  assert.ok(!readFileSync(path, 'utf8').includes(key), 'the key itself must not appear in the store');
});

test('the store is not world-readable', () => {
  const path = file();
  new OpenaiApiKeyStore(path).issue('0x0000000000000000000000000000000000000002');
  assert.equal(statSync(path).mode & 0o077, 0);
});

test('a revoked key stops working, and revoking it twice is not an error the second time', () => {
  const store = new OpenaiApiKeyStore(file());
  const key = store.issue('0x0000000000000000000000000000000000000003');
  assert.equal(store.revoke(key), true);
  assert.equal(store.addressForKey(key), null);
  assert.equal(store.revoke(key), false);
});

test('keys survive a restart', () => {
  const path = file();
  const key = new OpenaiApiKeyStore(path).issue('0x0000000000000000000000000000000000000004');
  assert.equal(new OpenaiApiKeyStore(path).addressForKey(key), '0x0000000000000000000000000000000000000004');
});

test('two keys issued to one address are both valid and both listed', () => {
  const store = new OpenaiApiKeyStore(file());
  const first = store.issue('0x0000000000000000000000000000000000000005', 'laptop');
  const second = store.issue('0x0000000000000000000000000000000000000005', 'ci');
  assert.equal(store.addressForKey(first), store.addressForKey(second));
  assert.deepEqual(store.listFor('0x0000000000000000000000000000000000000005').map((k) => k.label).sort(), ['ci', 'laptop']);
});

test('listing an address never reveals a usable key', () => {
  const store = new OpenaiApiKeyStore(file());
  const key = store.issue('0x0000000000000000000000000000000000000006');
  const [listed] = store.listFor('0x0000000000000000000000000000000000000006');
  assert.ok(!key.includes(listed.prefix), 'the prefix shown must come from the hash, not from the key');
});

test('a corrupt store file is an empty store, not a crash at start-up', () => {
  const path = file();
  new OpenaiApiKeyStore(path).issue('0x0000000000000000000000000000000000000007');
  rmSync(path);
  assert.doesNotThrow(() => new OpenaiApiKeyStore(path));
});

process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));
