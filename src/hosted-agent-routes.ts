/**
 * `/api/hosted-agents` — create, read, change and remove agents this node runs.
 *
 * Anyone signed in may create (the product decision: "Create agent based on this model" is for visitors, not
 * operators); only the creator may change or remove. Limits are the store's. Errors are `{ error: { code,
 * message } }`, the codes being what the web page switches on.
 */
import { Router, type Request, type Response } from 'express';
import type { InferenceBackendRegistry } from './inference-backends.js';
import type { HostedAgentHost } from './hosted-agent-host.js';
import type { HostedAgentSecretStore } from './hosted-agent-secrets.js';
import { HOSTED_AGENT_SECRET_MAX_BYTES } from './hosted-agent-secrets.js';
import { HostedAgentIdTakenError, HostedAgentLimitError, type HostedAgentStore } from './hosted-agent-store.js';
import { hostedAgentMediaOf, hostedAgentSpecInput, hostedAgentUsesCode, type HostedAgentSpec, type HostedAgentSpecInput } from './hosted-agent-types.js';

export interface HostedAgentRoutesDeps {
  store: HostedAgentStore;
  secrets: HostedAgentSecretStore;
  host: HostedAgentHost;
  registry: () => InferenceBackendRegistry | null;
  /** The signed-in address on this request, lower-case, or null. */
  sessionAddress: (req: Request) => string | null;
  /** Ids a hosted agent may not take — the config agents this node already proxies. */
  reserved: (id: string) => boolean;
  /** This node's public base URL, for the addresses returned on create. */
  publicBase: (req: Request) => string;
  /** Whether a peer currently serves a modality (peer-models.ts). Absent → only this node's backends count. */
  peerServes?: (modality: 'transcription' | 'image') => boolean;
}

const refuse = (res: Response, status: number, code: string, message: string) => {
  res.status(status).json({ error: { code, message } });
};

export function hostedAgentRoutes(deps: HostedAgentRoutesDeps): Router {
  const router = Router();

  const signedIn = (req: Request, res: Response): string | null => {
    const who = deps.sessionAddress(req);
    if (!who) refuse(res, 401, 'not_signed_in', 'sign in with your wallet to create or change an agent');
    return who;
  };

  /** The spec, if the caller owns it. Answers the refusal itself otherwise. */
  const owned = (req: Request, res: Response): HostedAgentSpec | null => {
    const who = signedIn(req, res);
    if (!who) return null;
    const spec = deps.store.get(String(req.params.id));
    if (!spec) { refuse(res, 404, 'not_found', `no hosted agent "${req.params.id}" on this node`); return null; }
    if (spec.owner !== who) { refuse(res, 403, 'not_owner', 'only the agent\'s creator can do this'); return null; }
    return spec;
  };

  /** Validate a body into a spec input; answers 400/501 itself. */
  const parse = (req: Request, res: Response): HostedAgentSpecInput | null => {
    const parsed = hostedAgentSpecInput.safeParse(req.body ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      refuse(res, 400, 'invalid_request', `${issue?.path.join('.') || 'body'}: ${issue?.message ?? 'invalid'}`);
      return null;
    }
    const backend = deps.registry()?.backendForModel(parsed.data.model);
    if (!backend) { refuse(res, 400, 'model_not_served', `this node does not serve ${parsed.data.model}`); return null; }
    if (backend.modality !== 'chat') { refuse(res, 400, 'invalid_request', `${parsed.data.model} is a ${backend.modality} model; an agent is built on a chat model`); return null; }
    // Turning a medium on is a promise the card will make to callers, so it is refused when neither this node nor
    // any peer in reach can keep it. A peer that goes away later is the gateway's to report, turn by turn.
    for (const modality of ['transcription', 'image'] as const) {
      if (parsed.data.media[modality] && !deps.registry()?.backendsFor(modality).length && !deps.peerServes?.(modality)) {
        refuse(res, 400, 'model_not_served', `no ${modality} model is served by this node or a peer in reach, so media.${modality} cannot be turned on`);
        return null;
      }
    }
    if (hostedAgentUsesCode(parsed.data.mode) && !deps.host.dockerEnabled) {
      refuse(res, 501, 'docker_unavailable', 'this node does not run agent code (Docker is not enabled); prompt agents still work');
      return null;
    }
    return parsed.data;
  };

  const view = (req: Request, spec: HostedAgentSpec, full: boolean) => {
    const base = `${deps.publicBase(req).replace(/\/+$/, '')}/agents/${spec.id}`;
    const st = deps.host.status(spec.id);
    const set = new Set(deps.secrets.names(spec.id));
    return {
      id: spec.id, name: spec.name, description: spec.description, model: spec.model, mode: spec.mode,
      owner: spec.owner, version: spec.version, created_at: spec.createdAt, updated_at: spec.updatedAt,
      status: st?.status ?? 'failed', error: st?.error ?? null, live_version: st?.liveVersion ?? null,
      a2a_url: base, card_url: `${base}/.well-known/agent-card.json`,
      ...(full ? {
        systemPrompt: spec.systemPrompt, files: spec.files, a2ui: spec.a2ui, allowedHosts: spec.allowedHosts,
        secretNames: spec.secretNames, skills: spec.skills, media: hostedAgentMediaOf(spec),
        secrets: spec.secretNames.map((name) => ({ name, set: set.has(name) })),
      } : {}),
    };
  };

  router.get('/api/hosted-agents', (req, res) => {
    if (req.query.mine) {
      const who = signedIn(req, res);
      if (!who) return;
      res.json({ agents: deps.store.listByOwner(who).map((s) => view(req, s, false)) });
      return;
    }
    res.json({ agents: deps.store.list().map((s) => view(req, s, false)) });
  });

  router.post('/api/hosted-agents', (req, res) => {
    const who = signedIn(req, res);
    if (!who) return;
    const input = parse(req, res);
    if (!input) return;
    try {
      const spec = deps.store.create(input, who, deps.reserved);
      deps.host.apply(spec);
      res.status(201).json({ agent: view(req, spec, false), a2a_url: view(req, spec, false).a2a_url, card_url: view(req, spec, false).card_url });
    } catch (e) {
      if (e instanceof HostedAgentIdTakenError) return refuse(res, 409, 'id_taken', e.message);
      if (e instanceof HostedAgentLimitError) return refuse(res, 429, 'limit_reached', e.message);
      throw e;
    }
  });

  router.get('/api/hosted-agents/:id', (req, res) => {
    const spec = owned(req, res);
    if (spec) res.json({ agent: view(req, spec, true) });
  });

  router.put('/api/hosted-agents/:id', (req, res) => {
    const prior = owned(req, res);
    if (!prior) return;
    const input = parse(req, res);
    if (!input) return;
    if (input.id !== prior.id) return refuse(res, 400, 'invalid_request', 'an agent\'s id cannot change — it is its public address');
    const spec = deps.store.update(prior.id, input);
    deps.host.apply(spec);
    res.json({ agent: view(req, spec, true) });
  });

  router.delete('/api/hosted-agents/:id', async (req, res) => {
    const spec = owned(req, res);
    if (!spec) return;
    deps.store.delete(spec.id);
    deps.secrets.dropAgent(spec.id);
    await deps.host.remove(spec.id);
    res.json({ deleted: spec.id });
  });

  /** Write-only: set with `{ value }`, clear with `{ value: null }`. There is no route that reads a value back. */
  router.put('/api/hosted-agents/:id/secrets/:name', async (req, res) => {
    const spec = owned(req, res);
    if (!spec) return;
    const name = String(req.params.name);
    if (!spec.secretNames.includes(name)) return refuse(res, 400, 'invalid_request', `${name} is not one of this agent's secret names`);
    const value = (req.body as { value?: unknown } | undefined)?.value;
    if (value === null) deps.secrets.clear(spec.id, name);
    else if (typeof value === 'string' && Buffer.byteLength(value) <= HOSTED_AGENT_SECRET_MAX_BYTES) deps.secrets.set(spec.id, name, value);
    else return refuse(res, 400, 'invalid_request', `value must be a string of at most ${HOSTED_AGENT_SECRET_MAX_BYTES} bytes, or null`);
    await deps.host.restart(spec.id);
    res.json({ name, set: value !== null });
  });

  router.get('/api/hosted-agents/:id/logs', async (req, res) => {
    const spec = owned(req, res);
    if (!spec) return;
    res.json({ lines: await deps.host.logs(spec.id) });
  });

  return router;
}
