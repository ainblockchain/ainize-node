/**
 * The node, in OpenAI's shapes.
 *
 * `/api/chat` is this node's own format — comparison columns, patch ids, teach-mode semantics — and it stays that
 * way. This is a second door for a different caller: somebody who already has OpenAI code and wants it to work
 * against a node they deposited with. Every shape here exists because a stock client parses it, so the shapes are
 * not ours to improve: an `id` that does not start with `chatcmpl-`, a stream that does not end with `[DONE]`, an
 * error body without `error.code` — each is a client that breaks in a way its user cannot diagnose.
 *
 * This file is deliberately separate from `api.ts`, which is already past 2,800 lines. Nothing here reaches into
 * that file, and nothing there needs to know this exists.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { InferenceBackendRegistry } from './inference-backends.js';
import type { OpenaiApiKeyStore } from './openai-api-keys.js';
import { openaiAuthRoutes } from './openai-auth-routes.js';
import type { Market } from './market.js';
import { RuntimeUnavailableError } from './runtime.js';
import type { ChatStreamChunk } from './chat-stream.js';

/** The caller's proven address, attached by the bearer middleware. */
export interface OpenaiCaller { address: string }

export interface OpenaiSurfaceDeps {
  registry: InferenceBackendRegistry;
  keys: OpenaiApiKeyStore;
  /** Generation goes through the market, so `/v1` takes the same shared lease and queue as everything else. */
  market: Market;
  /** This node's address, for the sign-in message. */
  node: string;
  nodeName?: string;
}

/** Ceiling on a single `/v1` completion. The node serves one request at a time; an unbounded one is a denial of service. */
export const OPENAI_MAX_TOKENS_CEILING = 2048;

declare module 'express-serve-static-core' {
  interface Request { openaiCaller?: OpenaiCaller }
}

/** An error body in the shape OpenAI's clients raise as a typed exception rather than a bare HTTP failure. */
export function openaiError(res: Response, status: number, code: string, message: string, type = 'invalid_request_error'): void {
  res.status(status).json({ error: { message, type, code, param: null } });
}

/**
 * Resolve `Authorization: Bearer …` to an address, or refuse.
 *
 * One lookup, no signature work: proving the address happened once, at `/v1/auth/token`. A missing header and an
 * unknown key answer the same 401, because distinguishing them would confirm which keys exist.
 */
export function requireOpenaiKey(keys: OpenaiApiKeyStore) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.header('authorization') ?? '';
    const key = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const address = key ? keys.addressForKey(key) : null;
    if (!address) {
      openaiError(res, 401, 'invalid_api_key', 'no valid API key was provided — sign in at /v1/auth/nonce and /v1/auth/token to get one');
      return;
    }
    req.openaiCaller = { address };
    next();
  };
}

export function openaiSurfaceRouter(deps: OpenaiSurfaceDeps): Router {
  const router = Router();

  // The sign-in door is open: it is how a caller gets the key everything else here demands.
  router.use('/v1', openaiAuthRoutes({ keys: deps.keys, node: deps.node, nodeName: deps.nodeName }));

  const authed = requireOpenaiKey(deps.keys);

  router.get('/v1/models', authed, (_req, res) => {
    res.json({ object: 'list', data: deps.registry.listModels() });
  });

  router.post('/v1/chat/completions', authed, async (req: Request, res: Response) => {
    const parsed = openaiChatRequest.safeParse(req.body ?? {});
    if (!parsed.success) {
      openaiError(res, 400, 'invalid_request', parsed.error.issues[0]?.message ?? 'invalid request');
      return;
    }
    const body = parsed.data;

    // Routed, never guessed. Answering an unknown model with whatever this node happens to serve would give the
    // caller a reply from a model they did not ask for, and no way to notice.
    const backend = deps.registry.backendForModel(body.model);
    if (!backend || backend.modality !== 'chat') {
      openaiError(res, 404, 'model_not_found', `this node does not serve a chat model called ${body.model}`);
      return;
    }

    const id = `chatcmpl-${randomBytes(16).toString('hex')}`;
    const created = Math.floor(Date.now() / 1000);
    const caller = req.openaiCaller!.address;
    const abort = new AbortController();
    const onClose = () => { if (!res.writableEnded) abort.abort(); };
    if (body.stream) res.once('close', onClose);

    /** SSE headers are sent on the first frame, not before: a failure that happens first must still be a JSON error. */
    const writeFrame = async (frame: string) => {
      abort.signal.throwIfAborted();
      if (!res.headersSent) {
        res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
        res.flushHeaders();
      }
      res.write(frame);
      res.flush?.();
    };

    try {
      const outcome = await deps.market.chat({
        // `patchIds: []` is base mode — the model this node serves, with nothing loaded. The /v1 surface sells
        // throughput on that model; patches are what /api/chat is for.
        patchIds: [], mode: 'base',
        model: body.model,
        messages: body.messages,
        maxTokens: body.max_tokens ?? 512,
        signal: abort.signal,
        visitor: deps.market.visitorId(`openai:${caller}`),
        caller: { operator: false, address: caller },
        onChunk: body.stream
          ? async (chunk: ChatStreamChunk) => {
            // Re-stamped with OUR id and created time: the client correlates frames by them, and the upstream's
            // are meaningless outside this node.
            await writeFrame(`data: ${JSON.stringify({ ...chunk, id, created, model: body.model })}\n\n`);
          }
          : undefined,
      });

      const answer = outcome.base;
      if (!answer) {
        openaiError(res, 502, 'upstream_no_answer', 'the serving model returned no answer', 'api_error');
        return;
      }

      if (body.stream) {
        await writeFrame('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.json({
        id, object: 'chat.completion', created, model: answer.model || body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: answer.content }, finish_reason: answer.finish_reason ?? 'stop', logprobs: null }],
        usage: answer.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    } catch (error) {
      if (error instanceof RuntimeUnavailableError) {
        if (!res.headersSent) openaiError(res, 503, 'backend_unavailable', error.message, 'api_error');
        else res.end();
        return;
      }
      // Once frames are out the status line is already 200, so the only honest thing left is to say so in-band
      // and stop. A client that has read half an answer must not be told it was fine.
      if (res.headersSent) {
        if (!res.destroyed) res.end(`data: ${JSON.stringify({ error: { message: 'the completion was interrupted', type: 'api_error', code: 'stream_interrupted' } })}\n\n`);
        return;
      }
      openaiError(res, 500, 'internal_error', error instanceof Error ? error.message : 'the completion failed', 'api_error');
    } finally {
      res.off('close', onClose);
    }
  });

  return router;
}

/**
 * What `/v1/chat/completions` accepts.
 *
 * Deliberately narrower than OpenAI's: a field this node cannot honour is better refused than accepted and
 * ignored, because silently ignoring `n: 4` bills a caller for one answer they did not ask for and hands them
 * three that never existed.
 */
const openaiChatRequest = z.object({
  model: z.string().min(1),
  messages: z.array(z.object({
    role: z.enum(['system', 'user', 'assistant']),
    content: z.string().min(1).max(32_000),
  })).min(1, 'messages must contain at least one message').max(64),
  max_tokens: z.coerce.number().int().min(1).max(OPENAI_MAX_TOKENS_CEILING).optional(),
  stream: z.boolean().default(false),
  n: z.literal(1).optional(),
});
