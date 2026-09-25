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
import type { DepositLedger } from '@ainize/core';
import { RuntimeUnavailableError } from './runtime.js';
import { ModalityGate, ModalityGateClosedError } from './modality-gate.js';
import multer from 'multer';
import type { ChatStreamChunk } from './chat-stream.js';
import type { StakeFairQueue } from './stake-fair-queue.js';

/** The caller's proven address, attached by the bearer middleware. */
export interface OpenaiCaller { address: string }

export interface OpenaiSurfaceDeps {
  registry: InferenceBackendRegistry;
  keys: OpenaiApiKeyStore;
  /** Generation goes through the market, so `/v1` takes the same shared lease and queue as everything else. */
  market: Market;
  /** Deposits, when this node sells throughput. Absent = the account routes are not mounted. */
  deposits?: {
    ledger: DepositLedger;
    receivingAddress: string;
    chains: { chain: string; token: string }[];
  };
  /**
   * The fair queue, when deposits are configured. Absent = no wait bound, because nothing divides the queue.
   *
   * The non-LLM modalities order their own gates with it too, so a deposit buys a share of whatever is scarce.
   */
  scheduler?: StakeFairQueue;
  /** This node's address, for the sign-in message. */
  node: string;
  nodeName?: string;
}

/** Ceiling on a single `/v1` completion. The node serves one request at a time; an unbounded one is a denial of service. */
export const OPENAI_MAX_TOKENS_CEILING = 2048;

/**
 * The longest wait this node will promise, in seconds.
 *
 * Past it a request is refused rather than queued. Not because the caller's share is too small — under weighted
 * fair queueing a small share means a longer wait, never a refusal, and an error saying otherwise would be a lie
 * about the mechanism. It is refused because a node that accepts work it cannot say anything true about the
 * timing of has turned a queue into a silent drop.
 */
export const OPENAI_MAX_PROMISED_WAIT_S = 120;

/**
 * Roughly how many tokens this node generates per second, used only to turn a queue depth into a wait.
 *
 * Deliberately a constant rather than a measurement: the number decides when to refuse, and a measured rate falls
 * during exactly the overload it is meant to detect, so refusals would avalanche as the node got busier. Wrong by
 * a constant factor it merely shifts where the bound sits; wrong dynamically it makes the bound unpredictable.
 */
export const OPENAI_TOKENS_PER_SECOND = 20;

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

  if (deps.deposits) {
    const { ledger, receivingAddress, chains } = deps.deposits;

    /**
     * What this caller bought.
     *
     * Always about the caller's own address, never one named in the query: a key is a capability to read one
     * account, and letting it read any would make the whole ledger public to anyone who ever signed in once.
     */
    router.get('/v1/account', authed, (req: Request, res: Response) => {
      const address = req.openaiCaller!.address;
      res.json({
        address,
        // Decimal string, not a number. A share is an 18-decimal bigint; JSON.stringify throws on one and a
        // Number() would round somebody's balance silently, always in the same direction.
        deposited_shares: ledger.depositedShareOf(address).toString(),
        total_deposited_shares: ledger.totalDepositedShares().toString(),
        // From the scheduler when there is one: what a caller wants to know is their share of the people
        // actually asking, which is what decides their wait. The ledger's fraction is over every depositor who
        // ever paid, including those who have not called in months.
        share_of_active: deps.scheduler ? deps.scheduler.activeShareOf(address) : ledger.shareFractionOf(address),
        share_of_deposited: ledger.shareFractionOf(address),
      });
    });

    router.get('/v1/account/deposit-address', authed, (_req: Request, res: Response) => {
      // The chains are part of the answer: sending AIN on a chain this node does not watch is money that arrives
      // and is never credited, and nothing on-chain would tell the sender that.
      res.json({ address: receivingAddress, chains });
    });

    router.get('/v1/account/deposits/:txHash', authed, (req: Request, res: Response) => {
      const address = req.openaiCaller!.address;
      const wanted = String(req.params.txHash ?? '').toLowerCase();
      // Found only if it was this caller's own deposit. A transaction hash is public, so treating it as proof of
      // anything would let anybody read a stranger's credit by quoting a hash off a block explorer.
      const found = ledger.snapshot().find((event) => event.txHash === wanted && event.from === address);
      if (!found) {
        // Not a 404: a client polling for a transfer that has not been noticed yet needs to tell "not yet" from
        // "wrong URL", and both would be 404.
        res.json({ tx_hash: wanted, credited: false, shares: null, chain: null, block_number: null });
        return;
      }
      res.json({ tx_hash: found.txHash, credited: true, shares: found.shares.toString(), chain: found.chain, block_number: found.blockNumber });
    });
  }

  /**
   * Speech to text.
   *
   * A passthrough, because vLLM already serves Qwen3-ASR on exactly this endpoint: what the node adds is the
   * key check, the routing and the share of the queue. It does NOT take the language model's lease — audio runs
   * on its own GPU, and making it wait for a completion on a different card would be a queue for nothing.
   *
   * Cost is the audio's size, as a stand-in for its duration: the node cannot know the duration without decoding
   * the file, and decoding it to schedule it would do the backend's work twice. Bytes are proportional to
   * duration for a given format, which is all a fair queue needs.
   */
  const transcriptionGates = new Map<string, ModalityGate>();
  for (const backend of deps.registry.backendsFor('transcription')) {
    transcriptionGates.set(backend.id, new ModalityGate('transcription', backend.concurrency, deps.scheduler));
  }
  const uploadAudio = multer({ storage: multer.memoryStorage(), limits: { fileSize: 64 * 1024 * 1024, files: 1 } });

  router.post('/v1/audio/transcriptions', authed, uploadAudio.single('file'), async (req: Request, res: Response) => {
    const model = String((req.body as Record<string, unknown> | undefined)?.model ?? '');
    if (!model) { openaiError(res, 400, 'invalid_request', 'model is required'); return; }
    const backend = deps.registry.backendForModel(model);
    if (!backend || backend.modality !== 'transcription') {
      openaiError(res, 404, 'model_not_found', `this node does not serve a transcription model called ${model}`);
      return;
    }
    const file = req.file;
    if (!file) { openaiError(res, 400, 'invalid_request', 'file is required — post the audio as multipart/form-data'); return; }

    const gate = transcriptionGates.get(backend.id)!;
    try {
      const answer = await gate.run(async () => {
        const form = new FormData();
        form.set('model', model);
        form.set('file', new Blob([new Uint8Array(file.buffer)], { type: file.mimetype || 'application/octet-stream' }), file.originalname || 'audio');
        // Whatever else the caller sent — language, prompt, temperature, response_format — travels unchanged.
        // The node is not the authority on what this backend accepts, and dropping a field silently would answer
        // a different question from the one that was asked.
        for (const [key, value] of Object.entries((req.body ?? {}) as Record<string, unknown>)) {
          if (key !== 'model' && typeof value === 'string') form.set(key, value);
        }
        const upstream = await fetch(`${backend.upstream}/v1/audio/transcriptions`, { method: 'POST', body: form });
        if (!upstream.ok) {
          throw new RuntimeUnavailableError(`the transcription backend answered ${upstream.status}`);
        }
        return upstream.json();
      }, { address: req.openaiCaller!.address, cost: Math.max(1, Math.round(file.size / 1024)) });
      res.json(answer);
    } catch (error) {
      if (error instanceof RuntimeUnavailableError || error instanceof ModalityGateClosedError) {
        openaiError(res, 503, 'backend_unavailable', error.message, 'api_error');
        return;
      }
      openaiError(res, 502, 'upstream_failed', error instanceof Error ? error.message : 'the transcription failed', 'api_error');
    }
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

    /**
     * Refuse only what the node cannot honestly promise.
     *
     * The queue is shared, so the wait is what is already ahead divided by this caller's share of it. A caller
     * with a large deposit waits through a long queue quickly; one with a small deposit does not, and is told so
     * in numbers rather than being left to time out. The body names all three things a caller could change —
     * wait, deposit more, ask for less — because a bare 429 makes a busy node and an unusable one look identical.
     */
    const share = deps.scheduler?.activeShareOf(req.openaiCaller!.address) ?? 1;
    const queued = deps.market.runtimeQueueDepth();
    const estimatedWaitS = share > 0 ? queued / OPENAI_TOKENS_PER_SECOND / share : Infinity;
    if (deps.scheduler && estimatedWaitS > OPENAI_MAX_PROMISED_WAIT_S) {
      res.status(429).json({
        error: {
          message: `this node cannot promise to start your request within ${OPENAI_MAX_PROMISED_WAIT_S}s at your current share — wait and retry, deposit more, or ask for fewer tokens`,
          type: 'rate_limit_error', code: 'queue_too_deep', param: null,
        },
        share,
        position: deps.market.runtimeQueueLength(),
        retry_after: Math.ceil(Math.min(estimatedWaitS, 3600)),
      });
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
