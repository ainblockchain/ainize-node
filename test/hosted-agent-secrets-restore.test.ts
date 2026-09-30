/**
 * A restore that brings the hosted-agent data back without its key (or with the key from another backup) must not
 * lose the sealed values silently (hosted-agent-secrets.ts `unreadable`): the node still starts, the values it
 * cannot open are dropped from the live store, and the sealed file is kept aside so the right key brings them back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostedAgentSecretStore } from '../src/hosted-agent-secrets.js';

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'ainize-secrets-'));
  const file = join(dir, 'hosted-agent-secrets.json'), key = join(dir, 'hosted-agent-secrets.key');
  const s = new HostedAgentSecretStore(file, key);
  s.set('writer', 'API_KEY', 'sk-live-1');
  s.set('writer', 'OTHER', 'v2');
  s.set('reader', 'TOKEN', 't3');
  return { dir, file, key, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('same key: nothing is flagged, values read back', () => {
  const f = fresh();
  const s = new HostedAgentSecretStore(f.file, f.key);
  assert.equal(s.unreadable, null);
  assert.deepEqual(s.reveal('writer', ['API_KEY', 'OTHER']), { API_KEY: 'sk-live-1', OTHER: 'v2' });
  f.done();
});

test('key missing (data restored without it): values dropped, flagged, sealed copy kept; the right key + copy bring them back', () => {
  const f = fresh();
  const backupKey = readFileSync(f.key, 'utf8');
  const sealedBefore = readFileSync(f.file, 'utf8');
  rmSync(f.key);
  const s = new HostedAgentSecretStore(f.file, f.key);
  assert.ok(s.unreadable);
  assert.equal(s.unreadable!.reason, 'key-missing');
  assert.equal(s.unreadable!.agents, 2);
  assert.equal(s.unreadable!.values, 3);
  assert.equal(readFileSync(s.unreadable!.keptAt, 'utf8'), sealedBefore, 'the sealed values are kept byte for byte');
  assert.equal(statSync(s.unreadable!.keptAt).mode & 0o777, 0o600);
  assert.deepEqual(s.names('writer'), [], 'the live store no longer offers values it cannot open');
  assert.deepEqual(s.reveal('writer', ['API_KEY']), {}, 'reveal does not throw');
  // the operator puts the right key and the copy back
  writeFileSync(f.key, backupKey, { mode: 0o600 });
  copyFileSync(s.unreadable!.keptAt, f.file);
  const again = new HostedAgentSecretStore(f.file, f.key);
  assert.equal(again.unreadable, null);
  assert.deepEqual(again.reveal('reader', ['TOKEN']), { TOKEN: 't3' });
  f.done();
});

test('a key from another backup: flagged as a mismatch', () => {
  const f = fresh();
  const other = fresh();
  copyFileSync(other.key, f.key);
  const s = new HostedAgentSecretStore(f.file, f.key);
  assert.equal(s.unreadable?.reason, 'key-mismatch');
  assert.equal(s.unreadable?.values, 3);
  f.done(); other.done();
});

test('a fresh install (no key, no values) is not flagged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ainize-secrets-'));
  const s = new HostedAgentSecretStore(join(dir, 's.json'), join(dir, 's.key'));
  assert.equal(s.unreadable, null);
  writeFileSync(join(dir, 's.json'), '{}');
  rmSync(join(dir, 's.key'));
  assert.equal(new HostedAgentSecretStore(join(dir, 's.json'), join(dir, 's.key')).unreadable, null, 'an empty store without its key is fine too');
  rmSync(dir, { recursive: true, force: true });
});
