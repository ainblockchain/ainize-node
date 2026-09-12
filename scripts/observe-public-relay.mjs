import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [peer, destination, ...patchIds] = process.argv.slice(2);

async function observe(url, options = {}) {
  const started = Date.now();
  const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(60_000) });
  const digest = createHash('sha256');
  const chunks = [];
  let bytes = 0;
  const json = response.headers.get('content-type')?.includes('application/json');
  for await (const chunk of response.body ?? []) {
    bytes += chunk.length;
    if (bytes > (json ? 8 * 1024 ** 2 : 256 * 1024 ** 2)) throw new Error('response exceeds observation limit');
    digest.update(chunk);
    if (json) chunks.push(chunk);
  }
  return {
    at: new Date().toISOString(), url: String(url), status: response.status,
    durationMs: Date.now() - started, contentType: response.headers.get('content-type'),
    bytes, sha256: digest.digest('hex'),
    ...(json ? { body: JSON.parse(Buffer.concat(chunks).toString('utf8')) } : {}),
  };
}

async function main() {
  if (!peer || !destination || !patchIds.length) throw new Error('usage: node observe-public-relay.mjs <https-origin> <new-output-dir> <patch-id> [...]');
  const origin = new URL(peer);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('HTTPS origin required');
  await mkdir(destination, { mode: 0o700 });
  const save = async (name, value) => writeFile(path.join(destination, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const catalog = await observe(new URL('/api/catalog', origin));
  await save('catalog-before.json', catalog);
  if (catalog.status !== 200 || !Array.isArray(catalog.body?.items)) throw new Error('public catalog unavailable');
  const results = [];
  for (const patchId of patchIds) {
    const entry = catalog.body.items.find(item => item.anchor?.id === patchId);
    if (!entry || !/^[0-9a-f]{64}$/.test(entry.anchor.patch_sha256)) throw new Error(`missing catalog entry: ${patchId}`);
    const blob = await observe(new URL(`/p2p/blob/${entry.anchor.patch_sha256}`, origin));
    await save(`${results.length}-anonymous-blob.json`, blob);
    const sample = entry.anchor.benchmark?.samples?.[0];
    const prompt = sample?.prompt;
    if (typeof prompt !== 'string' || !prompt) throw new Error(`benchmark prompt unavailable: ${patchId}`);
    const request = { patch_id: patchId, mode: 'compare', messages: [{ role: 'user', content: prompt }], max_tokens: 128 };
    await save(`${results.length}-chat-request.json`, request);
    const chat = await observe(new URL('/api/chat', origin), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
    await save(`${results.length}-chat-response.json`, chat);
    results.push({ patchId, sha256: entry.anchor.patch_sha256, anonymousGet: blob.status, chatStatus: chat.status, catalogStatus: entry.status, passed: entry.passed, quorum: entry.quorum });
    console.log(JSON.stringify(results[results.length - 1]));
  }
  await save('catalog-after.json', await observe(new URL('/api/catalog', origin)));
  await save('chat-patches.json', await observe(new URL('/api/chat/patches', origin)));
  await save('blobs.json', await observe(new URL('/p2p/blobs', origin)));
  await save('summary.json', { at: new Date().toISOString(), peer: origin.origin, results });
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
