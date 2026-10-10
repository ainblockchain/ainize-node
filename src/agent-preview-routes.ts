import { Router, type Request, type Response } from 'express';
import { Readable } from 'node:stream';
import { z } from 'zod';
import type { AgentPreviews } from './agent-previews.js';
export function agentPreviewRoutes(deps: { previews: AgentPreviews; principal: (req: Request) => string | null; canRead: (req: Request, id: string) => boolean }): Router {
  const router = Router();
  const fail = (res: Response, status: number, code: string, message: string) => res.status(status).json({ error: { code, message } });
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
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    try {
      const upstream = await deps.previews.resolve(preview.id, preview.owner);
      if (!upstream) return fail(res, 409, 'preview_not_ready', 'preview is unavailable');
      const response = await fetch(upstream, { method: 'POST', signal: AbortSignal.any([abort.signal, ...(deps.previews.signal(preview.id) ? [deps.previews.signal(preview.id)!] : [])]), headers: { 'content-type': 'application/json', accept: req.get('accept') ?? 'application/json' }, body: JSON.stringify(body) });
      res.status(response.status).set({ 'content-type': response.headers.get('content-type') ?? 'application/json', 'cache-control': 'private, no-store', 'x-accel-buffering': 'no' });
      if (!response.body) return res.end();
      const stream = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
      stream.on('error', () => { if (!res.destroyed) res.destroy(); });
      stream.pipe(res);
    } catch (error) { if (!abort.signal.aborted && !res.headersSent) fail(res, 502, 'preview_failed', (error as Error).message); }
  });
  return router;
}
