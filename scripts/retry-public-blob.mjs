import { createHash } from 'node:crypto';
import { createReadStream, openAsBlob, readFileSync, statSync } from 'node:fs';
import { LocalLedger, signMessage } from '@ainize/core';

const [configPath, filePath, patchId, peer = 'https://www.ainize.ai'] = process.argv.slice(2);
const emit = result => process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...result })}\n`);

async function boundedBody(response, maximum) {
  const chunks = [];
  let size = 0;
  if (!response.body) return Buffer.alloc(0);
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maximum) throw new Error('response exceeds its byte limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function main() {
  if (!configPath || !filePath || !patchId) throw new Error('usage: node scripts/retry-public-blob.mjs <private-config-path> <npz-path> <published-id> [https-peer]');
  const origin = new URL(peer);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('peer must be an HTTPS origin without credentials');
  const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
  const identity = cfg.identity;
  if (!identity?.address || !/^[0-9a-fA-F]{64}$/.test(identity.privateKey ?? '')) throw new Error('configured node identity is unavailable');
  const identityMatches = address => typeof address === 'string' && address.toLowerCase() === identity.address.toLowerCase();
  const size = statSync(filePath).size;
  if (size < 1 || size > 256 * 1024 ** 2) throw new Error('body is outside the relay size bounds');
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) digest.update(chunk);
  const sha = digest.digest('hex');
  const headers = () => {
    const timestamp = Date.now();
    const signature = signMessage(`blob:${sha}:${timestamp}`, identity.privateKey);
    return { 'x-ainize-auth': `${identity.address}:${timestamp}:${signature}` };
  };
  const recordsResponse = await fetch(`${origin.origin}/p2p/records?since=0&limit=500`, { redirect: 'error', signal: AbortSignal.timeout(20_000) });
  if (!recordsResponse.ok) throw new Error(`peer ledger request returned ${recordsResponse.status}`);
  const records = JSON.parse((await boundedBody(recordsResponse, 8 * 1024 ** 2)).toString('utf8')).records;
  const record = records?.find(candidate => candidate.kind === 'anchor' && candidate.body?.id === patchId && candidate.body.patch_sha256 === sha);
  if (!record || !LocalLedger.validate(record) || !identityMatches(record.author) || !identityMatches(record.body.author)) throw new Error('matching author-signed public anchor not found in the first 500 peer records');
  if (record.body.visibility === 'test' || record.body.price !== '0' || record.body.size_bytes !== size) throw new Error('this recovery tool only offers exact-size, already-published free public knowledge');
  emit({ stage: 'local-body-verified', patchId, author: identity.address, sha256: sha, sizeBytes: size, anchorHash: record.hash, anchorSignatureValid: true });
  const form = new FormData();
  form.append('blob', await openAsBlob(filePath), `${sha}.npz`);
  const endpoint = `${origin.origin}/p2p/blob/${sha}`;
  const response = await fetch(endpoint, { method: 'POST', body: form, headers: headers(), redirect: 'error', signal: AbortSignal.timeout(60_000) });
  const raw = (await boundedBody(response, 4096)).toString('utf8');
  let receipt;
  try { receipt = JSON.parse(raw); } catch { receipt = raw; }
  const accepted = response.ok && receipt?.ok === true && receipt.sha256 === sha && (receipt.size_bytes === size || (receipt.already_held === true && receipt.size_bytes === undefined));
  emit({ stage: 'signed-p2p-offer', endpoint, method: 'POST', status: response.status, bytesOffered: size, receipt, accepted });
  if (!accepted) { process.exitCode = 1; return; }
  const download = await fetch(endpoint, { headers: headers(), redirect: 'error', signal: AbortSignal.timeout(60_000) });
  if (!download.ok || !download.body) throw new Error(`relay read-back returned ${download.status}`);
  const readBack = createHash('sha256');
  let downloaded = 0;
  for await (const chunk of download.body) {
    downloaded += chunk.length;
    if (downloaded > size) throw new Error('read-back is larger than the signed body');
    readBack.update(chunk);
  }
  const readBackSha = readBack.digest('hex');
  const verified = readBackSha === sha && downloaded === size;
  emit({ stage: 'relay-read-back', patchId, sha256: readBackSha, sizeBytes: downloaded, verified });
  if (!verified) process.exitCode = 1;
}

main().catch(error => { emit({ stage: 'error', error: error.message }); process.exitCode = 1; });
