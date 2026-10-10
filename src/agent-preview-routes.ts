import { Router, type Request, type Response } from 'express';
import { Readable } from 'node:stream';
import { z } from 'zod';
import type { AgentPreviewRuns, PreviewRun } from './agent-preview-runs.js';
import type { AgentPreviews } from './agent-previews.js';
export function agentPreviewRoutes(deps: { previews: AgentPreviews; runs?: AgentPreviewRuns; principal: (req: Request) => string | null; canRead: (req: Request, id: string) => boolean }): Router {
  const router = Router();
  const fail = (res: Response, status: number, code: string, message: string) => res.status(status).json({ error: { code, message } });
  router.get('/api/hosted-agents/:id/preview-runs', (req, res) => {
    const id = String(req.params.id), owner = deps.principal(req);
    if (!owner || !deps.canRead(req, id)) return fail(res, 404, 'not_found', 'no preview history');
    const page = z.object({ limit: z.coerce.number().int().min(1).max(50).default(10), offset: z.coerce.number().int().min(0).max(200).default(0) }).safeParse(req.query);
    if (!page.success) return fail(res, 400, 'invalid_page', 'limit 1–50 and offset 0–200');
    const runs = deps.runs?.list(id, owner) ?? [];
    res.set('cache-control', 'private, no-store').json({ runs: runs.slice(page.data.offset, page.data.offset + page.data.limit), total: runs.length, ...page.data });
  });
  router.post('/api/hosted-agents/:id/preview-runs/:run/export', (req, res) => {
    const id = String(req.params.id), owner = deps.principal(req);
    if (!owner || !deps.canRead(req, id)) return fail(res, 404, 'not_found', 'no preview history');
    const run = deps.runs?.export(String(req.params.run), id, owner);
    if (!run) return fail(res, 404, 'not_found', 'no preview history');
    res.set('cache-control', 'private, no-store').json({ run });
  });
  router.delete('/api/hosted-agents/:id/preview-runs/:run', (req, res) => {
    const id = String(req.params.id), owner = deps.principal(req);
    if (!owner || !deps.canRead(req, id)) return fail(res, 404, 'not_found', 'no preview history');
    const result = deps.runs?.remove(String(req.params.run), id, owner) ?? 'missing';
    if (result === 'missing') return fail(res, 404, 'not_found', 'no preview history');
    if (result !== 'removed') return fail(res, 409, 'export_required', result === 'running' ? 'wait for the request to finish' : 'export this record before deleting it');
    res.json({ ok: true });
  });
  router.post('/api/hosted-agents/:id/previews', async (req, res) => {
    const id = String(req.params.id);
    if (!deps.canRead(req, id)) return fail(res, 404, 'not_found', 'no agent repository');
    const owner = deps.principal(req);
    if (!owner) return fail(res, 401, 'not_signed_in', 'sign in to preview a proposal');
    const input = z.object({ ref: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/).refine((ref) => !ref.includes('..')) }).safeParse(req.body);
    if (!input.success) return fail(res, 400, 'invalid_request', 'a preview needs a branch or commit');
    try { res.status(202).json({ preview: await deps.previews.create(id, input.data.ref, owner) }); }
    catch (error) { fail(res, 409, 'preview_failed', (error as Error).message); }
  });
  const owned = (req: Request, res: Response) => {
    const owner = deps.principal(req);
    const preview = owner ? deps.previews.get(String(req.params.preview), owner) : null;
    if (!preview) { fail(res, 404, 'not_found', 'no live preview'); return null; }
    if (!deps.canRead(req, preview.agent)) { fail(res, 404, 'not_found', 'no agent repository'); return null; }
    return preview;
  };
  router.get('/api/agent-previews/:preview', (req, res) => { const preview = owned(req, res); if (preview) res.set('cache-control', 'private, no-store').json({ preview }); });
  router.delete('/api/agent-previews/:preview', async (req, res) => { const preview = owned(req, res); if (!preview) return; await deps.previews.remove(preview.id); res.json({ ok: true }); });
  router.post('/api/agent-previews/:preview/rpc', async (req, res) => {
    const preview = owned(req, res); if (!preview) return;
    const body = req.body as { method?: string } | undefined;
    if (!body?.method || !['message/send', 'message/stream', 'tasks/get', 'tasks/cancel'].includes(body.method) || Buffer.byteLength(JSON.stringify(body)) > 64 * 1024) return fail(res, 400, 'invalid_request', 'unsupported preview request');
    if (preview.status !== 'ready') return fail(res, 409, 'preview_not_ready', preview.error ?? 'preview is building');
    let run: PreviewRun | undefined;
    let bytes = 0;
    const chunks: Buffer[] = [];
    let captured = 0;
    let finished = false;
    const finish = (status: PreviewRun['status'], error: string | null = null) => {
      if (finished || !run) return; finished = true;
      deps.runs?.finish(run.id, { status, error, output: Buffer.concat(chunks).toString('utf8'), outputBytes: bytes, outputTruncated: bytes > captured });
    };
    const abort = new AbortController();
    const lifetime = deps.previews.signal(preview.id);
    const cancelled = () => abort.signal.aborted || lifetime?.aborted === true;
    res.on('close', () => { abort.abort(); finish('cancelled', 'preview response closed'); });
    try {
      const upstream = await deps.previews.resolve(preview.id, preview.owner);
      if (!upstream) return fail(res, 409, 'preview_not_ready', 'preview is unavailable');
      if (body.method === 'message/send' || body.method === 'message/stream') {
        try { run = deps.runs?.begin(preview, deps.previews.spec(preview.id)?.model ?? 'unknown', body); }
        catch (error) { return fail(res, 429, 'history_limit', (error as Error).message); }
      }
      const response = await fetch(upstream, { method: 'POST', signal: AbortSignal.any([abort.signal, ...(lifetime ? [lifetime] : [])]), headers: { 'content-type': 'application/json', accept: req.get('accept') ?? 'application/json' }, body: JSON.stringify(body) });
      res.status(response.status).set({ 'content-type': response.headers.get('content-type') ?? 'application/json', 'cache-control': 'private, no-store', 'x-accel-buffering': 'no' });
      if (!response.body) { finish(response.ok ? 'ready' : 'error', response.ok ? null : `HTTP ${response.status}`); return res.end(); }
      const stream = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
      stream.on('data', (chunk: Buffer) => { bytes += chunk.length; if (captured < 256 * 1024) { const part = chunk.subarray(0, 256 * 1024 - captured); chunks.push(Buffer.from(part)); captured += part.length; } });
      stream.on('end', () => {
        const output = Buffer.concat(chunks).toString('utf8');
        let failed = !response.ok || /^event: error\r?$/m.test(output);
        try { const reply = JSON.parse(output) as { error?: unknown; result?: { status?: { state?: string } } }; failed ||= !!reply.error || ['failed', 'canceled'].includes(reply.result?.status?.state ?? ''); } catch { /* Streaming output is retained verbatim. */ }
        finish(failed ? 'error' : 'ready', failed ? `preview returned an error (HTTP ${response.status})` : null);
      });
      stream.on('error', (error) => { finish(cancelled() ? 'cancelled' : 'error', error.message); if (!res.destroyed) res.destroy(); });
      stream.pipe(res);
    } catch (error) { finish(cancelled() ? 'cancelled' : 'error', (error as Error).message); if (!abort.signal.aborted && !res.headersSent) fail(res, 502, 'preview_failed', (error as Error).message); }
  });
  return router;
}
