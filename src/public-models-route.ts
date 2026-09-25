/**
 * `GET /api/models` — what this node serves, for anybody who asks.
 *
 * `/v1/models` requires a key by design: that is what the LLM API specifies, and a node that stopped needing one
 * would stop being a drop-in for any other. This answers a different question — not "let me use a model" but
 * "what is here?" — and it is asked by a page that has no visitor to authenticate. The answer is public
 * information; anybody holding a free-tier key sees the same list.
 *
 * Two decisions are worth stating, because both are about what a wrong answer would look like:
 *
 *   • **A node with no backends answers `[]`, not 404.** A 404 is indistinguishable from a node too old to have
 *     this route, and the page would have to guess which it was looking at.
 *
 *   • **A backend that is down is listed as unavailable, not omitted.** Omitting it looks exactly like a node
 *     that never offered that model, which is the wrong thing to tell somebody deciding whether to wait.
 *
 * What is withheld is the upstream address. It is an internal address on every real deployment, and nothing on
 * this page needs it.
 */
import { Router } from 'express';
import type { InferenceBackendRegistry, InferenceModality } from './inference-backends.js';

export interface PublicModelCard {
  id: string;
  modality: InferenceModality;
  available: boolean;
}

/**
 * How long a probe result is reused.
 *
 * Long enough that a page load costs one probe per backend rather than one per model, short enough that a
 * restart is noticed while somebody is still looking at the page.
 */
export const MODEL_PROBE_TTL_MS = 15_000;

/** The order a page shows them in, so the list arrives sorted rather than each caller sorting it. */
const MODALITY_ORDER: readonly InferenceModality[] = ['chat', 'transcription', 'image'];

export interface PublicModelsDeps {
  /** Null when this node has no `backends` block — it then serves no models over the API at all. */
  registry: InferenceBackendRegistry | null;
  probe: (upstream: string) => Promise<boolean>;
}

export function publicModelsRouter(deps: PublicModelsDeps): Router {
  const router = Router();
  const probed = new Map<string, { at: number; up: boolean }>();

  /** Cached per upstream, not per model: three models behind one server is one server to ask. */
  const availability = async (upstream: string): Promise<boolean> => {
    const seen = probed.get(upstream);
    if (seen && Date.now() - seen.at < MODEL_PROBE_TTL_MS) return seen.up;
    let up = false;
    try { up = await deps.probe(upstream); }
    catch { up = false; }          // an unreachable backend is unavailable, not a failed request
    probed.set(upstream, { at: Date.now(), up });
    return up;
  };

  router.get('/api/models', async (_req, res) => {
    const registry = deps.registry;
    if (!registry) { res.json({ object: 'list', data: [] }); return; }

    const data: PublicModelCard[] = [];
    for (const modality of MODALITY_ORDER) {
      for (const backend of registry.backendsFor(modality)) {
        const available = await availability(backend.upstream);
        // Model ids only. `backend` is never spread in: it carries the upstream.
        for (const id of backend.models) data.push({ id, modality, available });
      }
    }
    res.json({ object: 'list', data });
  });

  return router;
}

/** The default probe: the backend's own model list, which every backend in this design serves. */
export async function probeBackend(upstream: string): Promise<boolean> {
  const res = await fetch(`${upstream}/v1/models`, { signal: AbortSignal.timeout(3000) });
  return res.ok;
}
