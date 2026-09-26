/**
 * `/api/transcribe` and `/api/image` — the visitor's door to the two models that had none.
 *
 * `/api/chat` already lets somebody signed out reach the language model. These are its two siblings, and they
 * exist because the alternative was worse: a browser playground built on `/v1` would mean
 * the site holding one API key on behalf of every visitor, with everybody's usage indistinguishable from
 * everybody else's and one revocation taking the page down for all of them.
 *
 * **These are not `/v1` with the authentication removed**, and the separation is the point. `/v1` is what a
 * program calls with a key and a deposit behind it; this is the door somebody presses once to see whether it
 * works. Keeping them apart means the free tier can be made stingier — as it already is, on both image limits —
 * without touching the paid surface, and somebody who outgrows it is pointed at a *different thing* rather than
 * the same thing with a limit lifted.
 *
 * The gates are passed in rather than constructed here. They are the queue in front of a GPU, and two gates over
 * one card would each believe they owned it.
 *
 * **What limits the free tier is the queue, not a count.** These routes hold no hourly allowance; they enter the
 * gate in the `freeServing` class, behind everything a paying caller asked for. The per-request ceilings below
 * (one image, twenty steps, ten megabytes) stay, because they bound what ONE press can occupy — which ordering
 * cannot do, since the slot is not taken back mid-generation.
 */
import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import type { InferenceBackendRegistry } from './inference-backends.js';
import type { ModalityGate } from './modality-gate.js';
import { ModalityGateClosedError } from './modality-gate.js';
import { RuntimeUnavailableError, RUNTIME_PRIORITY } from './runtime.js';

/**
 * One image per press, and fewer steps than `/v1` allows.
 *
 * A visitor pressing a button should not be able to occupy a GPU for a minute; somebody who wants four images at
 * sixty steps is describing a program, and a program can hold a key.
 */
export const FREE_IMAGE_MAX_N = 1;
export const FREE_IMAGE_MAX_STEPS = 20;
export const FREE_IMAGE_DEFAULT_STEPS = 12;
/** The largest upload the free transcription route accepts — a voice note, not an archive. */
export const FREE_AUDIO_MAX_BYTES = 10 * 1024 * 1024;

export interface FreeTierDeps {
  /** Null when this node has no `backends` block; every route then answers 503. */
  registry: InferenceBackendRegistry | null;
  /** The same gates the `/v1` routes use, keyed by backend id. */
  gates: Map<string, ModalityGate>;
}

function freeTierError(res: Response, status: number, code: string, message: string, type = 'invalid_request_error'): void {
  res.status(status).json({ error: { message, type, code, param: null } });
}

const freeImageRequest = z.object({
  model: z.string().min(1),
  prompt: z.string().min(1, 'prompt must not be empty').max(2000),
  n: z.coerce.number().int().min(1).max(FREE_IMAGE_MAX_N).default(1),
  size: z.string().regex(/^\d{3,4}x\d{3,4}$/, 'size must look like 512x512').default('512x512'),
  steps: z.coerce.number().int().min(1).max(FREE_IMAGE_MAX_STEPS).default(FREE_IMAGE_DEFAULT_STEPS),
  seed: z.coerce.number().int().optional(),
});

export function freeTierRouter(deps: FreeTierDeps): Router {
  const router = Router();
  const uploadAudio = multer({ storage: multer.memoryStorage(), limits: { fileSize: FREE_AUDIO_MAX_BYTES, files: 1 } });

  /**
   * Resolve a model to a backend and its gate, or answer.
   *
   * Validation happens before the allowance is touched throughout: a caller told "that model does not exist" or
   * "n is too large" has not used a try, because nothing was generated for them.
   */
  const resolve = (res: Response, model: string, modality: 'transcription' | 'image') => {
    if (!deps.registry) {
      freeTierError(res, 503, 'backend_unavailable', 'this node serves no models over the API', 'api_error');
      return null;
    }
    const backend = deps.registry.backendForModel(model);
    if (!backend || backend.modality !== modality) {
      freeTierError(res, 404, 'model_not_found', `this node does not serve a ${modality} model called ${model}`);
      return null;
    }
    const gate = deps.gates.get(backend.id);
    if (!gate) {
      freeTierError(res, 503, 'backend_unavailable', `the ${modality} backend is not accepting work`, 'api_error');
      return null;
    }
    return { backend, gate };
  };

  const failed = (res: Response, error: unknown): void => {
    if (error instanceof RuntimeUnavailableError || error instanceof ModalityGateClosedError) {
      freeTierError(res, 503, 'backend_unavailable', error.message, 'api_error');
      return;
    }
    freeTierError(res, 502, 'upstream_failed', error instanceof Error ? error.message : 'the request failed', 'api_error');
  };

  router.post('/api/transcribe', uploadAudio.single('file'), async (req: Request, res: Response) => {
    const model = String((req.body as Record<string, unknown> | undefined)?.model ?? '');
    if (!model) { freeTierError(res, 400, 'invalid_request', 'model is required'); return; }
    const found = resolve(res, model, 'transcription');
    if (!found) return;
    const file = req.file;
    if (!file) { freeTierError(res, 400, 'invalid_request', 'file is required — post the audio as multipart/form-data'); return; }

    try {
      const answer = await found.gate.run(async () => {
        const form = new FormData();
        form.set('model', model);
        form.set('file', new Blob([new Uint8Array(file.buffer)], { type: file.mimetype || 'application/octet-stream' }), file.originalname || 'audio');
        const upstream = await fetch(`${found.backend.upstream}/v1/audio/transcriptions`, { method: 'POST', body: form });
        if (!upstream.ok) throw new RuntimeUnavailableError(`the transcription backend answered ${upstream.status}`);
        return upstream.json() as Promise<Record<string, unknown>>;
      }, { address: 'free-tier', cost: Math.max(1, Math.round(file.size / 1024)), priority: RUNTIME_PRIORITY.freeServing });
      res.json(answer);
    } catch (error) {
      failed(res, error);
    }
  });

  router.post('/api/image', async (req: Request, res: Response) => {
    const model = String((req.body as Record<string, unknown> | undefined)?.model ?? '');
    if (!model) { freeTierError(res, 400, 'invalid_request', 'model is required'); return; }
    const found = resolve(res, model, 'image');
    if (!found) return;

    const parsed = freeImageRequest.safeParse(req.body ?? {});
    if (!parsed.success) {
      freeTierError(res, 400, 'invalid_request',
        `${parsed.error.issues[0]?.message ?? 'invalid request'} — the free tier allows n up to ${FREE_IMAGE_MAX_N} and ${FREE_IMAGE_MAX_STEPS} steps; /v1 allows more`);
      return;
    }
    const body = parsed.data;

    try {
      const answer = await found.gate.run(async () => {
        const upstream = await fetch(`${found.backend.upstream}/v1/images/generations`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...body, response_format: 'b64_json' }),
        });
        if (!upstream.ok) throw new RuntimeUnavailableError(`the image backend answered ${upstream.status}`);
        return upstream.json() as Promise<Record<string, unknown>>;
      }, { address: 'free-tier', cost: body.steps * body.n, priority: RUNTIME_PRIORITY.freeServing });
      res.json(answer);
    } catch (error) {
      failed(res, error);
    }
  });

  return router;
}
