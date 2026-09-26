/**
 * Attachments: a caller (aindrive) sends LINKS to picked files; the agent opens one only when the model asks.
 *
 * The link host here is a local server, which the real egress door refuses (loopback). So the executor tests run
 * with a gateway whose egress is swapped for a direct fetch — what is under test is WHEN a link is opened and what
 * the model is told, not the egress policy (hosted-agents.test.ts covers that).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { hostedAgentAttachmentsOf, hostedAgentAttachmentNote, hostedAgentReadAttachmentTool } from '../src/hosted-agent-runtime/hostedAgentAttachments.js';
import { HostedAgentExecutor, resetHostedAgentNativeToolsRefusedForTest } from '../src/hosted-agent-runtime/hostedAgentExecutor.js';
import type { HostedAgentCtx } from '../src/hosted-agent-runtime/hostedAgentRuntimeTypes.js';

test('file parts are read in both protocol shapes; links are not shown to the model', () => {
  const files = hostedAgentAttachmentsOf({ parts: [
    { kind: 'text', text: 'look at these' },
    { kind: 'file', file: { uri: 'https://drive.example/api/h/abc?k=secret', name: 'notes.md', mimeType: 'text/markdown' } },
    { content: { $case: 'url', value: 'https://drive.example/api/h/def?k=s2' }, filename: 'IMG_1.jpg', mediaType: 'image/jpeg' },
    { content: { $case: 'raw', value: Buffer.from('hi') }, filename: 'a.txt', mediaType: 'text/plain' },
    { kind: 'file', file: { bytes: Buffer.from('yo').toString('base64'), name: 'b.txt', mimeType: 'text/plain' } },
  ] });
  assert.deepEqual(files.map((f) => [f.name, f.mimeType, !!f.uri, !!f.bytesBase64]), [
    ['notes.md', 'text/markdown', true, false], ['IMG_1.jpg', 'image/jpeg', true, false],
    ['a.txt', 'text/plain', false, true], ['b.txt', 'text/plain', false, true],
  ]);
  const note = hostedAgentAttachmentNote(files);
  assert.match(note, /1\. notes\.md \(text\/markdown\)/);
  assert.doesNotMatch(note, /secret|api\/h/, 'the model never sees the capability URL');
  assert.equal(hostedAgentAttachmentNote([]), '');
});

// ── a link server that counts every open, and a model that decides whether to open

let links: Server;
let linkBase = '';
const opened: string[] = [];
let model: Server;
let modelUrl = '';
const modelSaw: string[] = [];

before(async () => {
  links = createServer((req, res) => {
    opened.push(req.url ?? '');
    if (req.url?.startsWith('/api/h/gone')) { res.statusCode = 410; res.end('{"error":"revoked"}'); return; }
    res.setHeader('content-type', 'text/markdown');
    res.end('# Trip\n- Tokyo, 3 days\n- budget 1200 USD');
  });
  await new Promise<void>((r) => links.listen(0, '127.0.0.1', () => r()));
  linkBase = `http://127.0.0.1:${(links.address() as AddressInfo).port}`;

  // Opens attachment 1 only when the user asks about "the file"; then answers from the tool result.
  // The executor calls the model at `<gateway>/t/<token>/v1/chat/completions` and fetches at `<gateway>/t/<token>/egress`;
  // this one server plays both, the egress half fetching directly.
  model = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    if (req.url?.endsWith('/egress')) {
      const ask = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { url: string };
      const r = await fetch(ask.url);
      res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/octet-stream' });
      res.end(Buffer.from(await r.arrayBuffer()));
      return;
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages: { role: string; content: string }[]; tools?: unknown[] };
    const user = body.messages.filter((m) => m.role === 'user').at(-1)!.content;
    modelSaw.push(user);
    const tool = body.messages.find((m) => m.role === 'tool');
    res.setHeader('content-type', 'application/json');
    if (tool) { res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: `from the file: ${tool.content}` } }] })); return; }
    if (body.tools && /the file/.test(user.split('\n\n[Attached')[0]!)) {
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'read_attachment', arguments: '{"number":1}' } }] } }] }));
      return;
    }
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'no need to open anything' } }] }));
  });
  await new Promise<void>((r) => model.listen(0, '127.0.0.1', () => r()));
  modelUrl = `http://127.0.0.1:${(model.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise<void>((r) => links.close(() => r()));
  await new Promise<void>((r) => model.close(() => r()));
});

/** An executor whose model is the fake above and whose fetch is direct (the link server is on loopback). */
function executor() {
  const spec = { id: 'drive-helper', name: 'Drive helper', description: '', model: 'M', systemPrompt: 'Help with files.', mode: 'prompt' as const, a2ui: false, skills: [], version: 1 };
  const ex = new HostedAgentExecutor({ spec, gateway: { url: modelUrl, token: 'x'.repeat(48) }, secrets: {}, log: () => {}, module: null });
  return ex;
}

test('a prompt agent does not open a link the answer does not need', async () => {
  resetHostedAgentNativeToolsRefusedForTest();
  opened.length = 0;
  const out = await executor().turn('thanks!', 'c1', [{ uri: `${linkBase}/api/h/one?k=s`, name: 'trip.md', mimeType: 'text/markdown' }]);
  assert.equal(out.text, 'no need to open anything');
  assert.deepEqual(opened, [], 'the link was never fetched');
  assert.match(modelSaw.at(-1)!, /Attached files — not opened yet[\s\S]*1\. trip\.md/);
});

test('a prompt agent opens a link when the model asks, and answers from it', async () => {
  resetHostedAgentNativeToolsRefusedForTest();
  opened.length = 0;
  const out = await executor().turn('what does the file say?', 'c2', [{ uri: `${linkBase}/api/h/one?k=s`, name: 'trip.md', mimeType: 'text/markdown' }]);
  assert.deepEqual(opened, ['/api/h/one?k=s'], 'opened exactly once, only that link');
  assert.match(out.text, /Tokyo, 3 days/);
});

test('an expired or revoked link is reported to the model as the sender\'s decision', async () => {
  const tool = hostedAgentReadAttachmentTool([{ uri: `${linkBase}/api/h/gone?k=s`, name: 'x.md', mimeType: 'text/markdown' }]);
  const ctx = { fetch: (u: string) => fetch(u), log: () => {} } as unknown as HostedAgentCtx;
  assert.deepEqual(await tool.run({ number: 1 }, ctx), { error: 'x.md: the link has expired or was revoked by the sender; ask for a fresh handoff' });
  assert.match(String((await tool.run({ number: 9 }, ctx) as { error: string }).error), /no attachment number 9/);
});

test('non-text files come back as what they are; inline text is read without any fetch', async () => {
  const ctx = { fetch: () => { throw new Error('must not fetch'); }, log: () => {} } as unknown as HostedAgentCtx;
  const tool = hostedAgentReadAttachmentTool([
    { bytesBase64: Buffer.from('hello there').toString('base64'), name: 'a.txt', mimeType: 'text/plain' },
    { bytesBase64: Buffer.from([0xff, 0xd8, 0xff]).toString('base64'), name: 'p.jpg', mimeType: 'image/jpeg' },
  ]);
  assert.deepEqual(await tool.run({ number: 1 }, ctx), { name: 'a.txt', mimeType: 'text/plain', bytes: 11, text: 'hello there' });
  const img = await tool.run({ number: 2 }, ctx) as { bytes: number; note: string; images: string[] };
  assert.equal(img.bytes, 3);
  assert.match(img.note, /shown to you in the next message/);
  assert.deepEqual(img.images, [`data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff]).toString('base64')}`], 'a picture is handed on to be looked at');
});
