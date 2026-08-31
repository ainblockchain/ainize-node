/**
 * Runtime error mapping: a crashed serving engine (vLLM answers 5xx while it restarts) must surface as a friendly
 * "model unavailable" 503 and mark the runtime unavailable — never leak the raw upstream JSON to callers.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { Runtime, RuntimeUnavailableError, MODEL_UNAVAILABLE } from '../src/runtime.js';

let mode: 'crash' | 'bad' | 'ok' = 'crash';
const srv: Server = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/v1/models') { res.end(JSON.stringify({ data: [{ id: 'demo-model' }] })); return; }
  if (mode === 'crash') { res.statusCode = 500; res.end(JSON.stringify({ error: { message: 'EngineCore encountered an issue. See stack trace (above) for the root cause.', type: 'InternalServerError', code: 500 } })); return; }
  if (mode === 'bad') { res.statusCode = 400; res.end(JSON.stringify({ error: { message: 'maximum context length exceeded' } })); return; }
  res.end(JSON.stringify({ choices: [{ message: { content: 'hi' }, text: 'hi' }] }));
});
await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
const api = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
after(() => new Promise<void>((r) => srv.close(() => r())));

test('a 5xx from the serving model → RuntimeUnavailableError (503, friendly message) and status() reports the model unavailable', async () => {
  const rt = new Runtime({ repo: undefined, api });
  await assert.rejects(rt.chat([{ role: 'user', content: 'x' }]), (e: unknown) => e instanceof RuntimeUnavailableError && e.status === 503 && e.message === MODEL_UNAVAILABLE && /EngineCore/.test(e.detail));
  const st = await rt.status(true);
  assert.equal(st.available, false);
  assert.equal(st.error, MODEL_UNAVAILABLE);
  assert.match(st.detail ?? '', /500/);
  // the raw completion path maps the same way
  await assert.rejects(rt.complete('Q: 1+1=', 1), (e: unknown) => e instanceof RuntimeUnavailableError && e.status === 503);
  // once the model answers again the down window is lifted immediately
  mode = 'ok';
  const out = await rt.chat([{ role: 'user', content: 'x' }]);
  assert.equal(out.content, 'hi');
  const back = await rt.status(true);
  assert.notEqual(back.error, MODEL_UNAVAILABLE);
  assert.equal(back.model, 'demo-model');
});

test('a 4xx (bad request) is the caller\'s problem: plain error, runtime stays available', async () => {
  mode = 'bad';
  const rt = new Runtime({ repo: undefined, api });
  await assert.rejects(rt.chat([{ role: 'user', content: 'x' }]), (e: unknown) => e instanceof Error && !(e instanceof RuntimeUnavailableError) && /^chat failed: 400/.test(e.message));
  const st = await rt.status(true);
  assert.notEqual(st.error, MODEL_UNAVAILABLE);
  assert.equal(st.model, 'demo-model');
});

test('connection refused keeps the existing "serving API unreachable" status', async () => {
  const rt = new Runtime({ repo: undefined, api: 'http://127.0.0.1:1' });
  const st = await rt.status(true);
  assert.equal(st.available, false);
  assert.equal(st.error, 'serving API unreachable');
  await assert.rejects(rt.chat([{ role: 'user', content: 'x' }]), /serving API unreachable/);
});
