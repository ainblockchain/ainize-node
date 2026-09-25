/**
 * What a node will tell anybody about what it serves.
 *
 * `/v1/models` keeps requiring a key, because that is what the LLM API specifies and a node that stopped needing
 * one would stop being portable. This answers a different question — *what does this node serve?* — asked by a
 * page that has no key and no visitor to authenticate. The list is not secret: anybody holding a free-tier key
 * sees exactly the same thing. What is withheld is the upstream address, which is internal on every real
 * deployment.
 *
 *   node --test --import tsx test/public-models-route.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { InferenceBackendRegistry, type InferenceBackend } from '../src/inference-backends.js';
import { publicModelsRouter } from '../src/public-models-route.js';

const LLM: InferenceBackend = { id: 'llm', modality: 'chat', upstream: 'http://10.0.0.5:8000', models: ['qwen2.5-7b-instruct'], concurrency: 1 };
const STT: InferenceBackend = { id: 'stt', modality: 'transcription', upstream: 'http://10.0.0.5:8100', models: ['qwen3-asr'], concurrency: 4 };
const IMG: InferenceBackend = { id: 'image', modality: 'image', upstream: 'http://10.0.0.5:8200', models: ['qwen-image-2512'], concurrency: 1 };

interface ListedModel { id: string; modality: string; available: boolean }

async function listFrom(registry: InferenceBackendRegistry | null, probe: (upstream: string) => Promise<boolean> = async () => true) {
  const app = express();
  app.use(publicModelsRouter({ registry, probe }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/models`);
    return { status: res.status, body: await res.json() as { object: string; data: ListedModel[] } };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('a configured node lists its models with their modality', async () => {
  const { status, body } = await listFrom(new InferenceBackendRegistry([LLM, STT]));
  assert.equal(status, 200);
  assert.equal(body.object, 'list');
  assert.deepEqual(body.data.map((m) => [m.id, m.modality]).sort(),
    [['qwen2.5-7b-instruct', 'chat'], ['qwen3-asr', 'transcription']]);
});

test('a node serving nothing answers an empty list, not 404', async () => {
  const { status, body } = await listFrom(null);
  assert.equal(status, 200, 'a 404 is indistinguishable from a node too old to have this route');
  assert.deepEqual(body.data, []);
});

test('the upstream address is never in the answer', async () => {
  const { body } = await listFrom(new InferenceBackendRegistry([LLM, STT, IMG]));
  const json = JSON.stringify(body);
  assert.ok(!json.includes('10.0.0.5'), 'the model server is an internal address on every real deployment');
  assert.ok(!json.includes('8000'));
});

test('a backend that is not answering is listed as unavailable, not hidden', async () => {
  const { body } = await listFrom(new InferenceBackendRegistry([LLM, STT]), async (upstream) => upstream.endsWith('8000'));
  const byId = Object.fromEntries(body.data.map((m) => [m.id, m.available]));
  assert.equal(byId['qwen2.5-7b-instruct'], true);
  assert.equal(byId['qwen3-asr'], false, 'hiding it would look like a node that never offered it');
});

test('a probe that throws is an unavailable backend, not a failed request', async () => {
  const { status, body } = await listFrom(new InferenceBackendRegistry([LLM]), async () => { throw new Error('ECONNREFUSED'); });
  assert.equal(status, 200);
  assert.equal(body.data[0].available, false);
});

test('the modalities come back in the order a page shows them', async () => {
  const { body } = await listFrom(new InferenceBackendRegistry([IMG, STT, LLM]));
  assert.deepEqual(body.data.map((m) => m.modality), ['chat', 'transcription', 'image'],
    'declared in any order, presented in one');
});

test('one backend serving two models lists both', async () => {
  const two: InferenceBackend = { ...LLM, models: ['qwen2.5-7b-instruct', 'qwen3.8-flash-next'] };
  const { body } = await listFrom(new InferenceBackendRegistry([two]));
  assert.deepEqual(body.data.map((m) => m.id), ['qwen2.5-7b-instruct', 'qwen3.8-flash-next']);
});

test('a backend is probed once for all of its models, not once per model', async () => {
  let probes = 0;
  const two: InferenceBackend = { ...LLM, models: ['a', 'b', 'c'] };
  await listFrom(new InferenceBackendRegistry([two]), async () => { probes++; return true; });
  assert.equal(probes, 1, 'three models behind one server is one server to ask');
});
