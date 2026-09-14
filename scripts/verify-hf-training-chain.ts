import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { defaultConfig, identityFromPrivateKey, LOCAL_GENESIS, teachConfig } from '@ainize/core';
import { startNode } from '../src/server.js';

const provider = process.env.AIN_INFERENCE_TEST_URL!;
assert.match(new URL(provider).hostname, /^(172\.(1[6-9]|2[0-9]|3[01])\.[0-9]+\.[0-9]+|10\.[0-9]+\.[0-9]+|192\.168\.[0-9]+\.[0-9]+)$/);
const { verify } = createRequire(import.meta.url)('/work/bench/scripts/reproduction/verify-hf-training-record.js');
const home = '/output/hf-home';
mkdirSync(home, { mode: 0o700 });
const config = defaultConfig({ home, name: 'hf-native-binding-check', peers: [], roles: ['serving'], ledger: 'ain' });
config.identity = identityFromPrivateKey(LOCAL_GENESIS.privateKey);
config.ledger = { kind: 'ain', ain: { providerUrl: provider, chainId: 0, appName: 'knowledge' } };
config.runtime = { api: 'http://127.0.0.1:1' };
config.teach = { ...teachConfig(config), enabled: true, backend: 'stub', stubOffline: true, publish: 'never' };
const node = await startNode(config, { listen: false, quiet: true, serveWeb: false });
const save = (name: string, value: unknown) => writeFileSync(`/output/${name}`, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const rpc = async (method: string, params: Record<string, unknown>) => {
  const response = await fetch(`${provider}/json-rpc`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, protoVer: '1.0.0' } }), signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(!body.error && !body.result?.code);
  return body.result?.result ?? body.result;
};
try {
  await new Promise<void>(resolve => node.server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${(node.server.address() as { port: number }).port}`;
  const cli = async (...args: string[]) => {
    const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/bin.ts',
      '--home', home, '--node', endpoint, ...args, '--json'], { cwd: '/work/cli', timeout: 90000, maxBuffer: 8 * 1024 * 1024 });
    return JSON.parse(result.stdout);
  };
  const sourceUrl = 'https://huggingface.co/datasets/Minhyun/ainize-dart100-reproduction-20260911';
  const revision = '9a523ed3268688e90ee18f1ecd93f4fb72a8f056';
  const imported = await cli('dataset', sourceUrl, '--revision', revision,
    '--file', 'data/dart-001-company_ceo_nm.jsonl', '--train');
  save('hf-import-output.json', imported);
  const jobId = imported.job?.job?.id;
  assert.ok(jobId && imported.training_submission_receipt);
  const deadline = Date.now() + 60000;
  let ready;
  while (Date.now() < deadline) {
    const job = node.store.getTeachJob(jobId);
    assert.ok(job && !['FAILED', 'CANCELLED', 'NEEDS_MORE', 'REJECTED'].includes(job.status), 'Stub fixture must reach READY');
    const raw = node.store.get(`teach.chain.${jobId}.READY`);
    if (raw) {
      ready = JSON.parse(raw);
      assert.equal(ready.outcome, 'submitted');
      const transaction = await rpc('ain_getTransactionByHash', { hash: ready.txHash });
      if (transaction?.is_finalized) {
        assert.equal(transaction.receipt?.code, 0);
        break;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.ok(ready, 'READY submission receipt required');
  const status = await cli('teach', 'status', jobId);
  save('hf-job-status.json', status);
  const canonical = '/output/hf-canonical.jsonl';
  const download = await cli('teach', 'dataset', 'get', imported.dataset_id, '--format', 'jsonl', '--out', canonical);
  assert.equal(download.saved.verified, true);
  save('hf-download.json', download);
  const folder = dirname(imported.provenance);
  const files = {
    source: readFileSync(imported.provenance), receipt: readFileSync(imported.training_submission_receipt),
    input: readFileSync(join(folder, `input.${imported.source.format}`)),
    upload: readFileSync(join(folder, `data.${imported.source.format}`)),
    canonical: readFileSync(canonical), status: Buffer.from(JSON.stringify(status)),
  };
  const genesis = await rpc('ain_getBlockByNumber', { number: 0, getFullTransactions: true });
  const binding = await verify({ version: 1, publisher: config.identity.address, genesisHash: genesis.hash }, files, rpc);
  assert.equal(binding.backendReported, 'stub');
  assert.equal(binding.integrationVerified, false);
  assert.equal(binding.acceptedRows, 8);
  save('hf-training-binding.json', binding);
  const transaction = await rpc('ain_getTransactionByHash', { hash: binding.txHash });
  const block = await rpc('ain_getBlockByNumber', { number: binding.blockNumber, getFullTransactions: true });
  save('hf-training-block.json', { transaction, block });
  console.log(JSON.stringify({ scope: 'Real HF download, CLI, node and isolated blockchain; stub training, no model inference or metric 6 pass',
    datasetId: binding.datasetId, jobId, txHash: binding.txHash, block: binding.blockNumber, backend: binding.backendReported }));
} finally {
  node.server.closeAllConnections();
  await node.stop();
}
