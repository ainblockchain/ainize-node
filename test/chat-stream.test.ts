import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consumeChatStream } from '../src/chat-stream.js';

function chunk(content: string, finish: string | null = null) {
  return { id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model: 'test-model',
    choices: [{ index: 0, delta: { content }, finish_reason: finish }] };
}

function response(bytes: Uint8Array[]) {
  return new Response(new ReadableStream({ start(controller) { for (const value of bytes) controller.enqueue(value); controller.close(); } }),
    { headers: { 'content-type': 'text/event-stream' } });
}

test('SSE parser handles byte-fragmented Unicode and CRLF frames', async () => {
  const wire = `: heartbeat\r\n\r\ndata: ${JSON.stringify(chunk('Hello 🌏'))}\r\n\r\ndata: ${JSON.stringify(chunk('', 'stop'))}\r\n\r\ndata: [DONE]\r\n\r\n`;
  const deltas: string[] = [];
  const result = await consumeChatStream(response([...new TextEncoder().encode(wire)].map(value => new Uint8Array([value]))), async value => { deltas.push(value.choices[0].delta.content || ''); });
  assert.equal(result.content, 'Hello 🌏');
  assert.equal(result.finishReason, 'stop');
  assert.deepEqual(deltas, ['Hello 🌏', '']);
});

test('first chunk is delivered before generation finishes', async () => {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let sawFirst!: () => void;
  const first = new Promise<void>(resolve => { sawFirst = resolve; });
  const upstream = new Response(new ReadableStream({ start(value) { controller = value; } }), { headers: { 'content-type': 'text/event-stream' } });
  const running = consumeChatStream(upstream, async value => { if (value.choices[0].delta.content) sawFirst(); });
  controller!.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk('first'))}\n\n`));
  await first;
  controller!.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk(' second', 'stop'))}\n\ndata: [DONE]\n\n`));
  assert.equal((await running).content, 'first second');
});

test('truncated streams and unsupported JSON responses fail instead of simulating streaming', async () => {
  await assert.rejects(consumeChatStream(response([new TextEncoder().encode(`data: ${JSON.stringify(chunk('partial'))}\n\n`)]), async () => undefined), /without \[DONE\]/);
  await assert.rejects(consumeChatStream(Response.json({ choices: [] }), async () => undefined), /SSE stream/);
  await assert.rejects(consumeChatStream(response([new TextEncoder().encode('data: [DONE]\n\n')]), async () => undefined), /finish_reason/);
});

test('downstream failures cancel the upstream reader', async () => {
  let cancelled = false;
  const upstream = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk('hello'))}\n\n`)); }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } });
  await assert.rejects(consumeChatStream(upstream, async () => { throw new Error('disconnected'); }), /disconnected/);
  assert.equal(cancelled, true);
});
