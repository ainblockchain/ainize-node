/**
 * `/api/hosted-agents` — create, read, change and remove agents this node runs.
 *
 * Anyone signed in may create (the product decision: "Create agent based on this model" is for visitors, not
 * operators). The creator may change or remove it; when it is shared with an organization (`visibility: 'org'`),
 * that organization's members may also read its code, change it, set its secrets and read its logs — but only the
 * creator may remove it or change who sees it. Limits are the store's. Errors are `{ error: { code,
 * message } }`, the codes being what the web page switches on.
 */
import { Router, type Request, type Response } from 'express';
import type { InferenceBackendRegistry } from './inference-backends.js';
import type { HostedAgentHost } from './hosted-agent-host.js';
import { issueHostedAgentPopKey } from './hosted-agent-pop.js';
import type { HostedAgentSecretStore } from './hosted-agent-secrets.js';
import { HOSTED_AGENT_SECRET_MAX_BYTES } from './hosted-agent-secrets.js';
import { HostedAgentIdTakenError, HostedAgentLimitError, type HostedAgentStore } from './hosted-agent-store.js';
import { parseNodeModelRef } from './peer-models.js';
import { hostedAgentMediaOf, hostedAgentSpecInput, hostedAgentUsesCode, hostedAgentVisibilityOf, type HostedAgentSpec, type HostedAgentSpecInput } from './hosted-agent-types.js';
import { canAdministerAgent, canManageHostedAgent, canSeeHostedAgent, canShareInto, hostedAgentChangeType, listsHostedAgentFor, walletCaller, type AgentCaller, type OrgAudit, type SharedAgentEvents, audienceOf, widerAudience } from './shared-agents.js';

export interface HostedAgentRoutesDeps {
  store: HostedAgentStore;
  secrets: HostedAgentSecretStore;
  host: HostedAgentHost;
  registry: () => InferenceBackendRegistry | null;
  /**
   * Who is signed in on this request: a wallet session or an AIN SSO session (shared-agents.ts `agentCallerOf`).
   * `sessionAddress` is the older, wallet-only spelling; either serves, `caller` first.
   */
  caller?: (req: Request) => AgentCaller | null;
  /** The signed-in address on this request, lower-case, or null. */
  sessionAddress?: (req: Request) => string | null;
  /** The change feed of the shared registry, told of every create, update and delete. Absent → no feed. */
  events?: SharedAgentEvents;
  /** The audit log of the organization an agent is shared with (server.ts → organization-store.ts). Absent → none. */
  orgAudit?: OrgAudit;
  /** Ids a hosted agent may not take — the config agents this node already proxies. */
  reserved: (id: string) => boolean;
  /** This node's public base URL, for the addresses returned on create. */
  publicBase: (req: Request) => string;
  /** Whether a peer currently serves a modality (peer-models.ts). Absent → only this node's backends count. */
  peerServes?: (modality: 'transcription' | 'image') => boolean;
  /**
   * Chat models on other nodes an agent may be built on: `self` is this node's address, `serves` whether a fresh
   * peer advertises the model (the named node, for an `id@0x<node>` ref). Absent → only this node's models.
   */
  peerChat?: { self: string; serves: (model: string, node: string | null) => boolean };
}

const refuse = (res: Response, status: number, code: string, message: string) => {
  res.status(status).json({ error: { code, message } });
};

export function hostedAgentRoutes(deps: HostedAgentRoutesDeps): Router {
  const router = Router();

  const callerOf = (req: Request): AgentCaller | null => {
    if (deps.caller) return deps.caller(req);
    const address = deps.sessionAddress?.(req);
    return address ? walletCaller(address) : null;
  };

  const signedIn = (req: Request, res: Response): AgentCaller | null => {
    const who = callerOf(req);
    if (!who) refuse(res, 401, 'not_signed_in', 'sign in (wallet or AIN SSO) to create or change an agent');
    return who;
  };

  const notFound = (res: Response, id: unknown) => refuse(res, 404, 'not_found', `no hosted agent "${id}" on this node`);

  /**
   * The spec, if the caller may remove it: its owner, or an admin of the organization it is shared with. An agent
   * the caller cannot see is 404; one they see but may not remove is 403. Answers the refusal itself.
   */
  const administered = (req: Request, res: Response): { spec: HostedAgentSpec; who: AgentCaller } | null => {
    const who = signedIn(req, res);
    if (!who) return null;
    const spec = deps.store.get(String(req.params.id));
    if (!spec || !canSeeHostedAgent(spec, who)) { notFound(res, req.params.id); return null; }
    if (!canAdministerAgent(spec, who)) { refuse(res, 403, 'not_owner', 'only the agent\'s creator or an admin of its organization can do this'); return null; }
    return { spec, who };
  };

  /**
   * The spec, if the caller may manage it: its owner, or a member of the organization it is shared with. An agent
   * the caller cannot even see is 404 (a private id must not be confirmed); one they see but may not change is 403.
   */
  const managed = (req: Request, res: Response): { spec: HostedAgentSpec; who: AgentCaller } | null => {
    const who = signedIn(req, res);
    if (!who) return null;
    const spec = deps.store.get(String(req.params.id));
    if (!spec || !canSeeHostedAgent(spec, who)) { notFound(res, req.params.id); return null; }
    if (!canManageHostedAgent(spec, who)) { refuse(res, 403, 'not_owner', 'only the agent\'s creator or a write member of the organization it is shared with can do this'); return null; }
    return { spec, who };
  };

  /**
   * The spec, if the caller may read it: its owner, anyone for a public or unlisted one, a member for an org one.
   * Anything else is 404, never 403 — a private id must not be confirmed to exist by the refusal.
   */
  const visible = (req: Request, res: Response): { spec: HostedAgentSpec; owner: boolean } | null => {
    const who = callerOf(req);
    const spec = deps.store.get(String(req.params.id));
    if (!spec || !canSeeHostedAgent(spec, who)) { notFound(res, req.params.id); return null; }
    return { spec, owner: !!who && canManageHostedAgent(spec, who) };
  };

  /** Validate a body into a spec input; answers 400/501 itself. */
  const parse = (req: Request, res: Response, who: AgentCaller): HostedAgentSpecInput | null => {
    const parsed = hostedAgentSpecInput.safeParse(req.body ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      refuse(res, 400, 'invalid_request', `${issue?.path.join('.') || 'body'}: ${issue?.message ?? 'invalid'}`);
      return null;
    }
    // Sharing with an organization takes the contributor role there (shared-agents.ts `canShareInto`): an ainize
    // organization's member row, email domain or linked AIN SSO org; without one, an AIN SSO member of it. A
    // wallet belongs to an organization only through an explicit member row.
    if (parsed.data.visibility === 'org' && !canShareInto(who, parsed.data.orgId!)) {
      refuse(res, 400, 'invalid_request', !who.orgMember(parsed.data.orgId!)
        ? (who.kind === 'wallet'
          ? 'orgId: sharing with an organization needs an AIN SSO session that belongs to it; a wallet belongs to none unless an organization adds it as a member'
          : `orgId: you are not a member of ${parsed.data.orgId}`)
        : `orgId: sharing into ${parsed.data.orgId} needs the contributor role there`);
      return null;
    }
    // This node's model, or — for a ref naming another node (`id@0x<node>`) or an id only peers serve — a peer's,
    // relayed over p2p by the gateway. A 262k-context model on a GPU node is worth more than an 8k one here.
    const { model, node } = parseNodeModelRef(parsed.data.model);
    const here = !node || node === deps.peerChat?.self.toLowerCase();
    const backend = here ? deps.registry()?.backendForModel(model) : undefined;
    if (!backend && !deps.peerChat?.serves(model, here ? null : node)) { refuse(res, 400, 'model_not_served', `neither this node nor a peer in reach serves ${parsed.data.model}`); return null; }
    if (backend && backend.modality !== 'chat') { refuse(res, 400, 'invalid_request', `${parsed.data.model} is a ${backend.modality} model; an agent is built on a chat model`); return null; }
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

  const view = (req: Request, spec: HostedAgentSpec, full: boolean, who: AgentCaller | null = null) => {
    const base = `${deps.publicBase(req).replace(/\/+$/, '')}/agents/${spec.id}`;
    const st = deps.host.status(spec.id);
    const set = new Set(deps.secrets.names(spec.id));
    return {
      id: spec.id, name: spec.name, description: spec.description, model: spec.model, mode: spec.mode,
      owner: spec.owner, version: spec.version, created_at: spec.createdAt, updated_at: spec.updatedAt,
      visibility: hostedAgentVisibilityOf(spec), org_id: spec.orgId ?? null, updated_by: spec.updatedBy ?? spec.owner,
      ...(who ? { can_manage: canManageHostedAgent(spec, who), can_delete: canAdministerAgent(spec, who) } : {}),
      status: st?.status ?? 'failed', error: st?.error ?? null, live_version: st?.liveVersion ?? null,
      a2a_url: base, card_url: `${base}/.well-known/agent-card.json`,
      ...(full ? {
        systemPrompt: spec.systemPrompt, files: spec.files, a2ui: spec.a2ui, allowedHosts: spec.allowedHosts,
        secretNames: spec.secretNames, skills: spec.skills, media: hostedAgentMediaOf(spec),
        secrets: spec.secretNames.map((name) => ({ name, set: set.has(name) })),
      } : {}),
    };
  };

  /** The address every ref is minted under (shared-agents.ts `registryIssuer`). */
  const issuer = (req: Request) => deps.publicBase(req).replace(/\/+$/, '');

  /**
   * What the caller may see listed: everyone sees `public`; a signed-in caller also their own (whatever the
   * visibility) and the `org` agents of organizations they belong to. `unlisted` is listed to its owner alone.
   */
  router.get('/api/hosted-agents', (req, res) => {
    if (req.query.mine) {
      const who = signedIn(req, res);
      if (!who) return;
      res.json({ agents: deps.store.listByOwner(who.subject).map((s) => view(req, s, false, who)) });
      return;
    }
    // What a sync client (AinCode) works on: the caller's own agents and those shared with an organization they
    // belong to. Same rows as `mine`, with `can_manage` / `can_delete` saying what the caller may do.
    if (req.query.manageable) {
      const who = signedIn(req, res);
      if (!who) return;
      res.json({ agents: deps.store.list().filter((s) => canManageHostedAgent(s, who)).map((s) => view(req, s, false, who)) });
      return;
    }
    const who = callerOf(req);
    res.json({ agents: deps.store.list().filter((s) => listsHostedAgentFor(s, who)).map((s) => view(req, s, false)) });
  });

  router.post('/api/hosted-agents', (req, res) => {
    const who = signedIn(req, res);
    if (!who) return;
    const input = parse(req, res, who);
    if (!input) return;
    try {
      // The agent's PoP key is minted with it (hosted-agent-pop.ts), before the runtime that will sign with it starts.
      const spec = issueHostedAgentPopKey(deps.store, deps.secrets, deps.store.create(input, who.subject, deps.reserved));
      deps.host.apply(spec);
      deps.events?.append({ type: 'agent.published', registryIssuer: issuer(req), agentId: spec.id, version: spec.version, releaseId: `v${spec.version}`, audience: audienceOf(spec) });
      deps.orgAudit?.([spec.orgId], who.subject, 'agent.create', spec.id, { kind: 'hosted', visibility: hostedAgentVisibilityOf(spec) });
      res.status(201).json({ agent: view(req, spec, false), a2a_url: view(req, spec, false).a2a_url, card_url: view(req, spec, false).card_url });
    } catch (e) {
      if (e instanceof HostedAgentIdTakenError) return refuse(res, 409, 'id_taken', e.message);
      if (e instanceof HostedAgentLimitError) return refuse(res, 429, 'limit_reached', e.message);
      throw e;
    }
  });

  /**
   * Those who may manage it (its owner, members of the organization it is shared with) see the whole spec; anyone
   * else it is visible to sees what a listing shows (no prompt, no code).
   */
  router.get('/api/hosted-agents/:id', (req, res) => {
    const hit = visible(req, res);
    if (hit) res.json({ agent: view(req, hit.spec, hit.owner, callerOf(req)) });
  });

  router.put('/api/hosted-agents/:id', (req, res) => {
    const hit = managed(req, res);
    if (!hit) return;
    const { spec: prior, who } = hit;
    const input = parse(req, res, who);
    if (!input) return;
    if (input.id !== prior.id) return refuse(res, 400, 'invalid_request', 'an agent\'s id cannot change — it is its public address');
    // Who sees it is the creator's call, or an organization admin's: a write member edits what the agent does, not where it is shared.
    const sharingChanged = input.visibility !== hostedAgentVisibilityOf(prior) || (input.orgId ?? null) !== (prior.orgId ?? null);
    if (sharingChanged && !canAdministerAgent(prior, who)) {
      return refuse(res, 403, 'not_owner', 'only the agent\'s creator or an admin of its organization can change its visibility or organization');
    }
    const spec = deps.store.update(prior.id, input, who.subject);
    deps.host.apply(spec);
    deps.orgAudit?.([prior.orgId, spec.orgId], who.subject, sharingChanged ? 'agent.sharing' : 'agent.update', spec.id,
      { kind: 'hosted', version: spec.version, ...(sharingChanged ? { from: { visibility: hostedAgentVisibilityOf(prior), orgId: prior.orgId ?? null }, to: { visibility: hostedAgentVisibilityOf(spec), orgId: spec.orgId ?? null } } : {}) });
    deps.events?.append({ type: hostedAgentChangeType(prior, spec), registryIssuer: issuer(req), agentId: spec.id, version: spec.version, releaseId: `v${spec.version}`, audience: widerAudience(audienceOf(prior), audienceOf(spec)) });
    res.json({ agent: view(req, spec, true, who) });
  });

  router.delete('/api/hosted-agents/:id', async (req, res) => {
    const hit = administered(req, res);
    if (!hit) return;
    const { spec, who } = hit;
    deps.store.delete(spec.id);
    deps.orgAudit?.([spec.orgId], who.subject, 'agent.delete', spec.id, { kind: 'hosted' });
    deps.secrets.dropAgent(spec.id);
    await deps.host.remove(spec.id);
    // One past the last release: the feed's version is strictly increasing per resource, and the delete comes after.
    deps.events?.append({ type: 'agent.deleted', registryIssuer: issuer(req), agentId: spec.id, version: spec.version + 1, audience: audienceOf(spec) });
    res.json({ deleted: spec.id });
  });

  /** Write-only: set with `{ value }`, clear with `{ value: null }`. There is no route that reads a value back. */
  router.put('/api/hosted-agents/:id/secrets/:name', async (req, res) => {
    const hit = managed(req, res);
    if (!hit) return;
    const { spec, who } = hit;
    const name = String(req.params.name);
    if (!spec.secretNames.includes(name)) return refuse(res, 400, 'invalid_request', `${name} is not one of this agent's secret names`);
    const value = (req.body as { value?: unknown } | undefined)?.value;
    if (value === null) deps.secrets.clear(spec.id, name);
    else if (typeof value === 'string' && Buffer.byteLength(value) <= HOSTED_AGENT_SECRET_MAX_BYTES) deps.secrets.set(spec.id, name, value);
    else return refuse(res, 400, 'invalid_request', `value must be a string of at most ${HOSTED_AGENT_SECRET_MAX_BYTES} bytes, or null`);
    deps.orgAudit?.([spec.orgId], who.subject, 'agent.secret', spec.id, { name, set: value !== null });
    await deps.host.restart(spec.id);
    res.json({ name, set: value !== null });
  });

  router.get('/api/hosted-agents/:id/logs', async (req, res) => {
    const spec = managed(req, res)?.spec;
    if (!spec) return;
    res.json({ lines: await deps.host.logs(spec.id) });
  });

  return router;
}
