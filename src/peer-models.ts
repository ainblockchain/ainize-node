/**
 * Models over p2p: a node uses the speech and image models ANOTHER node serves.
 *
 * Anyone can run a node and put models on it, so the node a person talks to is rarely the one with every model.
 * Until now a model was reachable only on the node whose `backends` named it; a hosted agent on a chat-only node
 * could not hear a voice note even when the GPU box next door served speech-to-text to the whole network.
 *
 * Three pieces, all in this file:
 *
 *   • ADVERTISE — `peerModelAdvertsOf` is what `selfInfo()` gossips: each backend's modality and model ids. Never
 *     the upstream URL: that is the provider's private address, and the whole point of routing through the node
 *     is that nobody needs it. Older peers store the field with the rest of the hello and ignore it.
 *   • PROVIDE — `peerModelRoutes` mounts `POST /p2p/models/{transcription|image}` on the node that has the
 *     model. The caller signs with its NODE key (`p2p-model:<provider>/<modality>:<ts>`), so the provider knows
 *     which node is asking, charges the call to that address in its own per-GPU gate, and can refuse a node that
 *     is flooding it. A signature bound to the provider and the modality cannot be replayed against another.
 *   • CONSUME — `findPeerModel` picks a peer that advertised the modality recently, and `callPeerModel` makes the
 *     signed call. The hosted-agent gateway uses these when the node has no backend of its own for a modality.
 *
 * Chat is deliberately not here: a hosted agent's chat model is its identity (the spec names it, the node serves
 * it), and routing it elsewhere would change who answers. Speech and pictures are tools; who runs them is not.
 */
import { Router, type Request as ExpressRequest, type Response as ExpressResponse } from 'express';
import { signMessage, verifyMessage } from '@ainize/core';
import type { InferenceBackendRegistry, InferenceModality } from './inference-backends.js';
import { ModalityGateClosedError, type ModalityGate } from './modality-gate.js';

/** The modalities one node may run for another. */
export type PeerModelModality = Exclude<InferenceModality, 'chat'>;
export const PEER_MODEL_MODALITIES: readonly PeerModelModality[] = ['transcription', 'image'];

/** What a node gossips about one backend: what kind of model and which ids — never where it listens. */
export interface PeerModelAdvert {
  modality: InferenceModality;
  models: string[];
}

/** A peer's hello, as far as models are concerned. `PeerInfo` from core plus the field this node adds. */
export type PeerInfoWithModels = { backends?: unknown };

/** Adverts are capped like agent adverts: a hello is a greeting, not a catalogue. */
const PEER_MODEL_MAX_ADVERTS = 16;
/** A peer not heard from in this long is not offered as a route: gossip runs every few seconds when it is up. */
export const PEER_MODEL_FRESH_MS = 5 * 60_000;
/** How far a signature's clock may be from ours. The same window every other signed node call uses. */
const PEER_MODEL_MAX_SKEW_MS = 5 * 60_000;
/** Calls one node may make to another's models per minute. A backstop, not a price: the gate is the fair share. */
const PEER_MODEL_CALLS_PER_MINUTE = 60;
/** Diffusion steps a peer may ask for; the same ceiling the hosted-agent gateway applies to its own agents. */
const PEER_MODEL_IMAGE_MAX_STEPS = 30;
const PEER_MODEL_TIMEOUT_MS = 180_000;

/**
 * Whether this node runs its speech and image models for peers. On unless the operator writes
 * `"peerModels": { "serve": false }` in config.json — a node that put a model on the network meant it to be used,
 * and the per-GPU gate already keeps peers behind the node's own paying callers.
 */
export const peerModelsServing = (cfg: unknown): boolean =>
  (cfg as { peerModels?: { serve?: unknown } } | null)?.peerModels?.serve !== false;

export function peerModelAdvertsOf(backends: { modality: InferenceModality; models: string[] }[] | undefined, serving: boolean): PeerModelAdvert[] {
  if (!serving || !backends?.length) return [];
  return backends
    .filter((b) => PEER_MODEL_MODALITIES.includes(b.modality as PeerModelModality))
    .slice(0, PEER_MODEL_MAX_ADVERTS)
    .map((b) => ({ modality: b.modality, models: b.models.slice(0, 8) }));
}

/** Read a peer's `backends` defensively: it was written by another node, possibly a newer or a broken one. */
export function peerModelAdvertsFromInfo(info: PeerInfoWithModels | null | undefined): PeerModelAdvert[] {
  const raw = info?.backends;
  if (!Array.isArray(raw)) return [];
  const out: PeerModelAdvert[] = [];
  for (const b of raw.slice(0, PEER_MODEL_MAX_ADVERTS) as Record<string, unknown>[]) {
    const modality = b?.modality;
    if (modality !== 'chat' && modality !== 'transcription' && modality !== 'image') continue;
    const models = Array.isArray(b.models) ? b.models.filter((m): m is string => typeof m === 'string' && !!m && m.length <= 200).slice(0, 8) : [];
    if (models.length) out.push({ modality, models });
  }
  return out;
}

/** A peer that can run a modality: where it answers, who it is, and the model id it named. */
export interface PeerModelTarget {
  address: string;
  endpoint: string;
  name: string | null;
  model: string;
  lastSeen: number;
}

export interface PeerModelPeerRow {
  address: string | null;
  endpoint: string;
  info: (PeerInfoWithModels & { name?: string; address?: string }) | null;
  last_seen: number | null;
}

/** Every fresh peer serving a modality, most recently heard from first. This node itself is never in it. */
export function peerModelTargets(peers: PeerModelPeerRow[], modality: PeerModelModality, self: string, now = Date.now()): PeerModelTarget[] {
  const out: PeerModelTarget[] = [];
  for (const p of peers) {
    const address = (p.address ?? p.info?.address ?? '').toLowerCase();
    if (!address || address === self.toLowerCase() || !p.endpoint) continue;
    const lastSeen = p.last_seen ?? 0;
    if (now - lastSeen > PEER_MODEL_FRESH_MS) continue;
    const advert = peerModelAdvertsFromInfo(p.info).find((a) => a.modality === modality);
    if (!advert) continue;
    out.push({ address, endpoint: p.endpoint.replace(/\/+$/, ''), name: typeof p.info?.name === 'string' ? p.info.name : null, model: advert.models[0]!, lastSeen });
  }
  return out.sort((a, b) => b.lastSeen - a.lastSeen);
}

export const peerModelPurpose = (provider: string, modality: PeerModelModality, ts: number) => `p2p-model:${provider.toLowerCase()}/${modality}:${ts}`;

/** The caller's header: `<address>:<ts>:<signature>` over the purpose — the shape every signed node call uses. */
export function peerModelAuthHeader(identity: { address: string; privateKey: string }, provider: string, modality: PeerModelModality, now = Date.now()): string {
  return `${identity.address}:${now}:${signMessage(peerModelPurpose(provider, modality, now), identity.privateKey)}`;
}

/** The provider's check. The calling node's address, or null. */
export function verifyPeerModelAuth(header: string | undefined, self: string, modality: PeerModelModality, now = Date.now()): string | null {
  if (!header) return null;
  const [address, tsStr, sig] = header.split(':');
  const ts = Number(tsStr);
  if (!address || !sig || !Number.isFinite(ts) || Math.abs(now - ts) > PEER_MODEL_MAX_SKEW_MS) return null;
  return verifyMessage(peerModelPurpose(self, modality, ts), sig, address) ? address.toLowerCase() : null;
}

export class PeerModelCallError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/** One signed call to a peer's model. Bodies are the gateway's JSON: base64 audio in, base64 picture out. */
export async function callPeerModel(
  identity: { address: string; privateKey: string }, target: PeerModelTarget, modality: PeerModelModality, body: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(`${target.endpoint}/p2p/models/${modality}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ainize-auth': peerModelAuthHeader(identity, target.address, modality) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PEER_MODEL_TIMEOUT_MS),
    });
  } catch (e) {
    throw new PeerModelCallError(`${target.name ?? target.address} did not answer: ${e instanceof Error ? e.message : String(e)}`, 502);
  }
  const out = await res.json().catch(() => null) as { error?: { message?: string } } | null;
  if (!res.ok) throw new PeerModelCallError(`${target.name ?? target.address} refused: ${out?.error?.message ?? `HTTP ${res.status}`}`, res.status);
  return out;
}

export interface PeerModelRoutesDeps {
  registry: () => InferenceBackendRegistry | null;
  gates: (backendId: string) => ModalityGate | undefined;
  /** This node's own address — what a caller's signature must be bound to. */
  self: string;
  /** False when the operator turned serving peers off. The adverts say the same thing, so peers stop asking. */
  serving: () => boolean;
  log: (message: string) => void;
}

const peerModelError = (res: ExpressResponse, status: number, code: string, message: string) => { res.status(status).json({ error: { message, code } }); };

/**
 * `GET /api/network/models` — every model this node can reach: its own, and each fresh peer's, named by node.
 *
 * Separate from `/api/models` on purpose. That list is what THIS node serves over `/v1` and what an agent can be
 * built on; a peer's model is neither. Mixing them would put a model on the pricing and playground pages that the
 * node would then 404.
 */
export function networkModelsRouter(deps: {
  registry: () => InferenceBackendRegistry | null;
  peers: () => PeerModelPeerRow[];
  self: { address: string; name: string | null };
}): Router {
  const router = Router();
  router.get('/api/network/models', (_req: ExpressRequest, res: ExpressResponse) => {
    const node = { address: deps.self.address.toLowerCase(), name: deps.self.name };
    const data: { id: string; modality: InferenceModality; node: { address: string; name: string | null }; local: boolean }[] = [];
    for (const modality of ['chat', 'transcription', 'image'] as const) {
      for (const b of deps.registry()?.backendsFor(modality) ?? []) for (const id of b.models) data.push({ id, modality, node, local: true });
    }
    const now = Date.now();
    for (const p of deps.peers()) {
      const address = (p.address ?? p.info?.address ?? '').toLowerCase();
      if (!address || address === node.address || now - (p.last_seen ?? 0) > PEER_MODEL_FRESH_MS) continue;
      for (const a of peerModelAdvertsFromInfo(p.info)) {
        for (const id of a.models) data.push({ id, modality: a.modality, node: { address, name: typeof p.info?.name === 'string' ? p.info.name : null }, local: false });
      }
    }
    res.json({ object: 'list', data });
  });
  return router;
}

/** The provider side: `POST /p2p/models/transcription` and `POST /p2p/models/image`. */
export function peerModelRoutes(deps: PeerModelRoutesDeps): Router {
  const router = Router();
  const calls = new Map<string, number[]>();
  const limited = (caller: string, now = Date.now()) => {
    const hits = (calls.get(caller) ?? []).filter((t) => now - t < 60_000);
    hits.push(now);
    calls.set(caller, hits);
    if (calls.size > 5000) for (const [k, v] of calls) if (!v.some((t) => now - t < 60_000)) calls.delete(k);
    return hits.length > PEER_MODEL_CALLS_PER_MINUTE;
  };

  const handle = (modality: PeerModelModality) => async (req: ExpressRequest, res: ExpressResponse) => {
    if (!deps.serving()) return peerModelError(res, 404, 'not_serving', 'this node does not serve its models to peers');
    const caller = verifyPeerModelAuth(req.header('x-ainize-auth'), deps.self, modality);
    if (!caller) return peerModelError(res, 401, 'bad_signature', `sign p2p-model:${deps.self.toLowerCase()}/${modality}:<ts> with your node key in x-ainize-auth`);
    if (limited(caller)) return peerModelError(res, 429, 'rate_limited', `more than ${PEER_MODEL_CALLS_PER_MINUTE} calls a minute from ${caller}`);
    const backend = deps.registry()?.backendsFor(modality)[0];
    if (!backend) return peerModelError(res, 404, 'model_not_served', `this node serves no ${modality} model`);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const gate = deps.gates(backend.id);
    const upstreamBase = backend.upstream.replace(/\/+$/, '');
    try {
      let run: () => Promise<unknown>;
      let cost: number;
      if (modality === 'transcription') {
        if (typeof body.bytesBase64 !== 'string' || !body.bytesBase64) return peerModelError(res, 400, 'invalid_request', 'bytesBase64 is required');
        const audio = Buffer.from(body.bytesBase64, 'base64');
        cost = Math.max(1, Math.round(audio.length / 1024));
        run = async () => {
          const form = new FormData();
          form.set('model', backend.models[0]!);
          form.set('file', new Blob([new Uint8Array(audio)], { type: typeof body.mimeType === 'string' ? body.mimeType : 'application/octet-stream' }), typeof body.name === 'string' ? body.name : 'audio');
          if (typeof body.language === 'string' && body.language) form.set('language', body.language);
          const up = await fetch(`${upstreamBase}/v1/audio/transcriptions`, { method: 'POST', body: form, signal: AbortSignal.timeout(PEER_MODEL_TIMEOUT_MS) });
          const out = await up.json().catch(() => null) as { text?: unknown } | null;
          if (!up.ok || typeof out?.text !== 'string') throw new PeerModelCallError(`the transcription backend answered ${up.status}`, 502);
          return { text: out.text, model: backend.models[0] };
        };
      } else {
        if (typeof body.prompt !== 'string' || !body.prompt.trim()) return peerModelError(res, 400, 'invalid_request', 'prompt is required');
        if (body.size !== undefined && (typeof body.size !== 'string' || !/^\d{3,4}x\d{3,4}$/.test(body.size))) return peerModelError(res, 400, 'invalid_request', 'size must look like 1024x1024');
        const steps = typeof body.steps === 'number' && Number.isInteger(body.steps) ? Math.min(Math.max(body.steps, 1), PEER_MODEL_IMAGE_MAX_STEPS) : undefined;
        cost = steps ?? PEER_MODEL_IMAGE_MAX_STEPS;
        const upstreamBody = {
          model: backend.models[0]!, prompt: body.prompt.slice(0, 4000), n: 1, response_format: 'b64_json',
          ...(typeof body.size === 'string' ? { size: body.size } : {}),
          ...(steps ? { steps } : {}),
          ...(typeof body.negative_prompt === 'string' ? { negative_prompt: body.negative_prompt.slice(0, 4000) } : {}),
        };
        run = async () => {
          const up = await fetch(`${upstreamBase}/v1/images/generations`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(upstreamBody), signal: AbortSignal.timeout(PEER_MODEL_TIMEOUT_MS),
          });
          const out = await up.json().catch(() => null) as { data?: { b64_json?: unknown }[] } | null;
          const b64 = out?.data?.[0]?.b64_json;
          if (!up.ok || typeof b64 !== 'string') throw new PeerModelCallError(`the image backend answered ${up.status}`, 502);
          return { data: [{ b64_json: b64 }], model: backend.models[0] };
        };
      }
      // The calling NODE is the address in the queue: its share is whatever it has deposited here (usually the
      // floor), so a peer's agents wait behind this node's paying callers rather than beside them.
      const answer = gate ? await gate.run(run, { address: caller, cost }) : await run();
      deps.log(`served ${modality} to peer ${caller}`);
      res.json(answer);
    } catch (e) {
      if (e instanceof ModalityGateClosedError) return peerModelError(res, 503, 'backend_unavailable', e.message);
      const status = e instanceof PeerModelCallError ? e.status : 502;
      peerModelError(res, status, 'upstream_failed', e instanceof Error ? e.message : String(e));
    }
  };

  router.post('/p2p/models/transcription', handle('transcription'));
  router.post('/p2p/models/image', handle('image'));
  return router;
}
