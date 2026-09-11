import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createIdentity, LocalLedger, sha256Hex } from '@ainize/core';

for (const mode of ['success', 'html-404', 'html-200', 'wrong-download', 'tampered-anchor', 'paid-anchor']) {
  test(`standalone recovery client: ${mode}`, async context => {
    const directory = mkdtempSync(join(tmpdir(), 'ainize-recovery-'));
    const identity = createIdentity();
    const ledger = new LocalLedger(':memory:', identity);
    await ledger.init();
    context.after(async () => { await ledger.close(); rmSync(directory, { recursive: true, force: true }); });
    const bytes = Buffer.from('synthetic recovery transport fixture');
    const sha = sha256Hex(bytes);
    const configPath = join(directory, 'config.json');
    const filePath = join(directory, 'body.npz');
    writeFileSync(configPath, JSON.stringify({ identity }), { mode: 0o600 });
    writeFileSync(filePath, bytes);
    const record = await ledger.append('anchor', {
      id: 'recovery-test', author: identity.address, patch_sha256: sha,
      size_bytes: bytes.length, visibility: 'public', price: mode === 'paid-anchor' ? '1' : '0',
    });
    if (mode === 'tampered-anchor') (record.body as { size_bytes: number }).size_bytes++;
    const bootstrap = `
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {verifyMessage} from ${JSON.stringify(pathToFileURL(resolve('node_modules/@ainize/core/dist/index.js')).href)};
const bytes = readFileSync(${JSON.stringify(filePath)});
const mode = ${JSON.stringify(mode)};
globalThis.fetch = async (url, options) => {
  assert.equal(options.redirect, 'error');
  if (String(url).includes('/p2p/records?')) return Response.json({records: [${JSON.stringify(record)}]});
  assert.ok(!['paid-anchor','tampered-anchor'].includes(mode), 'invalid anchor must not send a body');
  const [address, timestamp, signature] = options.headers['x-ainize-auth'].split(':');
  assert.equal(address, ${JSON.stringify(identity.address)});
  assert.ok(verifyMessage('blob:${sha}:' + timestamp, signature, address));
  if (options.method === 'POST') {
    const uploaded = Buffer.from(await options.body.get('blob').arrayBuffer());
    assert.deepEqual(uploaded, bytes);
    if (mode.startsWith('html-')) return new Response('Cannot POST /p2p/blob', {status: mode === 'html-404' ? 404 : 200});
    return Response.json({ok:true,sha256:${JSON.stringify(sha)},size_bytes:bytes.length,already_held:false});
  }
  return new Response(mode === 'wrong-download' ? Buffer.alloc(bytes.length) : bytes);
};
process.argv = [process.execPath, 'retry-public-blob.mjs', ${JSON.stringify(configPath)}, ${JSON.stringify(filePath)}, 'recovery-test', 'https://relay.invalid'];
await import(${JSON.stringify(pathToFileURL(resolve('scripts/retry-public-blob.mjs')).href)});
`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', bootstrap], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(result.status, mode === 'success' ? 0 : 1, result.stdout + result.stderr);
    assert.ok(!`${result.stdout}${result.stderr}`.includes(identity.privateKey));
    const output = result.stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
    if (mode === 'success') assert.equal(output.at(-1)?.verified, true);
    if (mode.startsWith('html-')) assert.equal(output.at(-1)?.accepted, false);
    if (mode === 'wrong-download') assert.equal(output.at(-1)?.verified, false);
    if (mode === 'tampered-anchor' || mode === 'paid-anchor') assert.deepEqual(output.map(entry => entry.stage), ['error']);
  });
}
