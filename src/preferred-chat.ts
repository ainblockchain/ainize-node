import { Router } from 'express';
import { consumeChatStream } from './chat-stream.js';
import { z } from 'zod';
import type { OpenaiSurfaceDeps } from './openai-surface.js';
import type { PeerModelTarget } from './peer-models.js';

export function preferredChatPeers(value: string | undefined): Record<string, string> {
  if (!value) return {};
  return z.record(z.string(), z.string().regex(/^0x[0-9a-fA-F]{40}$/)).parse(JSON.parse(value));
}

/** Explicit operator routing applies to the model playground as well as /v1. */
export function preferredChatPlayground(deps: {
  routes: Record<string,string>;
  peers: () => NonNullable<OpenaiSurfaceDeps['peerModels']>;
  fetch: (peer: PeerModelTarget, body: unknown) => Promise<Response>;
}) {
  const router = Router();
  router.post('/api/chat', async (req,res,next) => {
    const body=req.body ?? {};
    if (body.mode !== 'base' || !Array.isArray(body.patch_ids) || body.patch_ids.length) { next(); return; }
    const model=body.model || (Object.keys(deps.routes).length===1 ? Object.keys(deps.routes)[0] : undefined);
    const node=typeof model==='string' ? deps.routes[model] : undefined;
    if (!node) { next(); return; }
    const parsed=z.object({messages:z.array(z.object({role:z.enum(['system','developer','user','assistant','tool'])}).passthrough()).min(1),max_tokens:z.number().int().positive().optional()}).safeParse(body);
    if (!parsed.success) {res.status(400).json({error:{code:'invalid_request',message:'messages or token budget is invalid'}});return;}
    const peer=deps.peers().target('chat',model,node);
    if (!peer) {res.status(503).json({error:{code:'backend_unavailable',message:'the configured model peer is unavailable'}});return;}
    const request:Record<string,unknown>={model,messages:parsed.data.messages,stream:body.stream===true};
    if(parsed.data.max_tokens!==undefined) request.max_tokens=parsed.data.max_tokens;
    for(const key of ['tools','tool_choice','parallel_tool_calls','temperature','chat_template_kwargs']) if(body[key]!==undefined) request[key]=body[key];
    try {
      const upstream=await deps.fetch(peer,request);
      if(!upstream.ok) {res.status(upstream.status).json(await upstream.json());return;}
      const envelope=(base:unknown)=>({mode:'base',patch_id:'',patch_ids:[],patched:null,base,model,applied:[],applied_ms:null,was_applied:false,benchmark_hit:null,benchmark_hits:{},dirty:[],history:{base:parsed.data.messages.length,patched:0,split:false},remaining_quota:null,quota_limit:null});
      if(body.stream===true) {
        res.set({'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','X-Accel-Buffering':'no'});res.flushHeaders();
        const completed=await consumeChatStream(upstream,async chunk=>{res.write(`data: ${JSON.stringify({...chunk,ainize_mode:'base'})}\n\n`);res.flush?.();});
        res.end(`event: ainize.result\ndata: ${JSON.stringify(envelope({content:completed.content,reasoning:completed.reasoning,finish_reason:completed.finishReason,usage:completed.usage}))}\n\ndata: [DONE]\n\n`);return;
      }
      const result=await upstream.json() as any;
      const choice=result.choices?.[0];
      res.json({...result,...envelope({content:choice?.message?.content ?? '',reasoning:choice?.message?.reasoning ?? null,finish_reason:choice?.finish_reason,usage:result.usage})});
    } catch {
      if(res.headersSent){res.end('event: error\ndata: {"error":{"message":"Peer stream interrupted"}}\n\n');return;}
      res.status(502).json({error:{code:'upstream_failed',message:'the configured model peer request failed'}});
    }
  });
  return router;
}
