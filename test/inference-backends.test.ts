/**
 * What the node says it can serve, and what it refuses to pretend to serve.
 *
 * `/v1/models` and routing read one list, so a node running only the LLM advertises only the LLM rather than
 * accepting a transcription request it will then fail. A model id belongs to exactly one backend: two backends
 * claiming the same id would make routing depend on array order, which is not a decision anybody made.
 *
 *   node --test --import tsx test/inference-backends.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InferenceBackendRegistry, type InferenceBackend } from '../src/inference-backends.js';

const llm: InferenceBackend = { id: 'llm', modality: 'chat', upstream: 'http://127.0.0.1:8000', models: ['qwen3.8-flash-next'], concurrency: 1 };
const stt: InferenceBackend = { id: 'stt', modality: 'transcription', upstream: 'http://127.0.0.1:8100', models: ['qwen3-asr'], concurrency: 4 };

test('a model maps to the backend that serves it', () => {
  const registry = new InferenceBackendRegistry([llm, stt]);
  assert.equal(registry.backendForModel('qwen3-asr')?.id, 'stt');
});

test('an unknown model maps to nothing rather than to the first backend', () => {
  const registry = new InferenceBackendRegistry([llm, stt]);
  assert.equal(registry.backendForModel('gpt-4'), null);
});

test('a node advertises only what it actually has configured', () => {
  const registry = new InferenceBackendRegistry([llm]);
  assert.deepEqual(registry.listModels().map((m) => m.id), ['qwen3.8-flash-next']);
});

test('a listed model says which backend owns it, in OpenAI shape', () => {
  const [model] = new InferenceBackendRegistry([llm]).listModels();
  assert.deepEqual(model, { id: 'qwen3.8-flash-next', object: 'model', owned_by: 'llm' });
});

test('two backends may not claim the same model id', () => {
  const clash: InferenceBackend = { ...stt, id: 'stt2', models: ['qwen3.8-flash-next'] };
  assert.throws(() => new InferenceBackendRegistry([llm, clash]), /qwen3\.8-flash-next/);
});

test('backends are found by modality, so each modality can hold its own queue', () => {
  const registry = new InferenceBackendRegistry([llm, stt]);
  assert.deepEqual(registry.backendsFor('transcription').map((b) => b.id), ['stt']);
  assert.deepEqual(registry.backendsFor('image'), []);
});
