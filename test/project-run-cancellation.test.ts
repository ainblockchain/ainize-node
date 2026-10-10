import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScriptViaSandbox, runScriptOverHttp } from '../src/projects.js';

test('in-process project runs pass cancellation to the sandbox and record its exit', async () => {
  const controller = new AbortController();
  const events: string[] = [];
  const run = runScriptViaSandbox({ run: async (_request, _caller, _sink, signal) => {
    assert.equal(signal, controller.signal);
    await new Promise<void>((resolve) => signal!.addEventListener('abort', () => resolve(), { once: true }));
    return { code: 124, ms: 1, error: 'cancelled' };
  } });
  const running = run({ language: 'python', entry: 'main.py', files: { 'main.py': 'pass' }, env: {}, timeoutMs: 1000 }, (event) => events.push(event.event), controller.signal);
  controller.abort();
  await running;
  assert.deepEqual(events, ['error', 'exit']);
});

test('HTTP project runs propagate cancellation without putting the signal or caller key in the body', async () => {
  const original = globalThis.fetch;
  const controller = new AbortController();
  try {
    globalThis.fetch = async (_url, init) => {
      assert.equal(init?.signal, controller.signal);
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer caller-key');
      assert.equal(String(init?.body).includes('caller-key'), false);
      return new Response('event: exit\ndata: {"code":0,"ms":1}\n\n');
    };
    await runScriptOverHttp(() => 'https://node.test')({ language: 'python', entry: 'main.py', files: { 'main.py': 'pass' }, env: {}, timeoutMs: 1000, apiKey: 'caller-key' }, () => {}, controller.signal);
  } finally { globalThis.fetch = original; }
});
