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
import type { InferenceBackendRegistry } from './inference-backends.js';
import type { OpenaiApiKeyStore } from './openai-api-keys.js';
import { openaiAuthRoutes } from './openai-auth-routes.js';

/** The caller's proven address, attached by the bearer middleware. */
export interface OpenaiCaller { address: string }

export interface OpenaiSurfaceDeps {
  registry: InferenceBackendRegistry;
  keys: OpenaiApiKeyStore;
  /** This node's address, for the sign-in message. */
  node: string;
  nodeName?: string;
}

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

  return router;
}
