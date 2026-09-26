/**
 * PDFs an agent opens (src/hosted-agent-runtime/hostedAgentPdf.ts), and pictures/PDFs that come back from an
 * aindrive MCP grant instead of text.
 *
 * The PDFs are built here byte by byte — one with a text layer, one with only a drawing (what a scan looks like to
 * a text extractor) — so the test says exactly what it feeds in.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { hostedAgentReadPdf, isHostedAgentPdf } from '../src/hosted-agent-runtime/hostedAgentPdf.js';
import { hostedAgentReadAttachmentTool } from '../src/hosted-agent-runtime/hostedAgentAttachments.js';
import { aindriveHandoffMcpTools } from '../src/hosted-agent-runtime/hostedAgentAindriveHandoff.js';
import type { HostedAgentCtx } from '../src/hosted-agent-runtime/hostedAgentRuntimeTypes.js';

/** A one-page PDF around a content stream, with a correct xref table. */
function makePdf(content: string, withFont: boolean): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R${withFont ? ' /Resources << /Font << /F1 5 0 R >> >>' : ''} >>`,
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    ...(withFont ? ['<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'] : []),
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
const TEXT_PDF = makePdf('BT /F1 14 Tf 20 150 Td (Quote total: 1,200,000 KRW, due 2026-10-15) Tj ET', true);
const SCAN_PDF = makePdf('0 0 1 rg 20 20 260 160 re f', false);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('a PDF with a text layer is read as text, page by page', async () => {
  const r = await hostedAgentReadPdf(TEXT_PDF);
  assert.equal(r.pages, 1);
  assert.match(r.text, /\[page 1\]\nQuote total: 1,200,000 KRW, due 2026-10-15/);
  assert.deepEqual(r.images, []);
});

test('a scan — no text layer — is shown as page pictures instead', async () => {
  const r = await hostedAgentReadPdf(SCAN_PDF);
  assert.equal(r.images.length, 1);
  assert.match(r.images[0]!, /^data:image\/png;base64,iVBORw0KGgo/);
  assert.match(r.note, /scanned 1-page PDF[\s\S]*shown to you as pictures/);
});

test('what is not a PDF says so, and PDFs are recognised by type or name', async () => {
  await assert.rejects(hostedAgentReadPdf(Buffer.from('not a pdf')), /could not be opened/);
  assert.equal(isHostedAgentPdf('application/pdf', 'x'), true);
  assert.equal(isHostedAgentPdf('application/octet-stream', '견적서.PDF'), true);
  assert.equal(isHostedAgentPdf('text/plain', 'a.txt'), false);
});

test('read_attachment reads an attached PDF, and hands a scan\'s pages on as pictures', async () => {
  const ctx = { fetch: () => { throw new Error('inline — no fetch'); }, log: () => {} } as unknown as HostedAgentCtx;
  const tool = hostedAgentReadAttachmentTool([
    { bytesBase64: TEXT_PDF.toString('base64'), name: '견적서.pdf', mimeType: 'application/pdf' },
    { bytesBase64: SCAN_PDF.toString('base64'), name: 'scan.pdf', mimeType: 'application/pdf' },
  ]);
  const text = await tool.run({ number: 1 }, ctx) as { text: string; pages: number };
  assert.match(text.text, /1,200,000 KRW/);
  const scan = await tool.run({ number: 2 }, ctx) as { images: string[] };
  assert.equal(scan.images.length, 1, 'the tools loop shows these to the model');
});

// ───────────────────────────────── an MCP grant that answers with a picture or a PDF

let mcp: Server;
let mcpUrl = '';
before(async () => {
  mcp = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id?: number; method: string; params?: { arguments?: { id?: string } } };
    res.setHeader('content-type', 'application/json');
    if (rpc.method === 'initialize') { res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: {} })); return; }
    if (rpc.method.startsWith('notifications/')) { res.statusCode = 202; res.end(); return; }
    const id = rpc.params?.arguments?.id;
    const content = id === 'photo' ? [{ type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' }]
      : id === 'quote' ? [{ type: 'resource', resource: { uri: 'aindrive://견적서.pdf', mimeType: 'application/pdf', blob: TEXT_PDF.toString('base64') } }]
        : [{ type: 'text', text: 'plain' }];
    res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content } }));
  });
  await new Promise<void>((r) => mcp.listen(0, '127.0.0.1', () => r()));
  mcpUrl = `http://127.0.0.1:${(mcp.address() as AddressInfo).port}/mcp/h/g`;
});
after(async () => { await new Promise<void>((r) => mcp.close(() => r())); });

test('read_file over MCP no longer drops a picture or a PDF: the picture is shown, the PDF is read', async () => {
  const ctx = { fetch: (u: string, init?: RequestInit) => fetch(u, init), log: () => {} } as unknown as HostedAgentCtx;
  const tools = aindriveHandoffMcpTools([{ url: mcpUrl, headers: { Authorization: 'Bearer t' }, expiresAt: null, tools: ['list_files', 'read_file'] }], ctx);
  const read = tools.find((t) => t.name === 'read_file')!;
  const photo = await read.run({ id: 'photo' }, ctx) as { images: string[]; note: string };
  assert.deepEqual(photo.images, [`data:image/png;base64,${PNG.toString('base64')}`]);
  assert.match(photo.note, /shown to you/);
  const quote = await read.run({ id: 'quote' }, ctx) as { text: string; images?: string[] };
  assert.match(quote.text, /Text of a 1-page PDF[\s\S]*1,200,000 KRW/);
  assert.equal(quote.images, undefined, 'a text PDF needs no pictures');
});
