/**
 * `/api/hosted-agents` — create, read, change and remove agents this node runs.
 *
 * Anyone signed in may create (the product decision: "Create agent based on this model" is for visitors, not
 * operators) — a wallet session, or since 2026-09-29 an AIN SSO / Google session, whose principal (`sso:<sub>`)
 * owns the agent the way it owns API keys and linked agents. Only the creator may change or remove an agent, or —
 * for one created under an organization — a `write` member of it (the same rules as linked-agent-routes.ts).
 * Limits are the store's. Errors are `{ error: { code, message } }`, the codes being what the web page switches on.
 */
import { Router, type Request, type Response } from 'express';
import type { InferenceBackendRegistry } from './inference-backends.js';
import type { HostedAgentHost } from './hosted-agent-host.js';
import type { HostedAgentSecretStore } from './hosted-agent-secrets.js';
import { HOSTED_AGENT_SECRET_MAX_BYTES } from './hosted-agent-secrets.js';
import { HostedAgentIdTakenError, HostedAgentLimitError, type HostedAgentStore } from './hosted-agent-store.js';
import { parseNodeModelRef } from './peer-models.js';
import { hostedAgentMediaOf, hostedAgentSpecInput, hostedAgentUsesCode, type HostedAgentSpec, type HostedAgentSpecInput } from './hosted-agent-types.js';
import { canSeeOrgAgent, membership, normalisePrincipal, roleAtLeast, type Organization, type OrgRole, type OrgViewer } from './organization-store.js';

export interface HostedAgentRoutesDeps {
  store: HostedAgentStore;
  secrets: HostedAgentSecretStore;
  host: HostedAgentHost;
  registry: () => InferenceBackendRegistry | null;
  /**
   * The principal on this request — a lower-case wallet address, or an unblocked AIN SSO / Google principal
   * (`sso:<sub>`) — or null when nobody is signed in.
   */
  sessionPrincipal: (req: Request) => string | null;
  /**
   * Organizations (organization-store.ts), so an agent can be created UNDER one: the caller must be at least a
   * `contributor` there, and a `write` member may change, remove, read in full, set secrets of and read the logs of
   * any of the organization's agents. Without this, `org` in a request is refused.
   */
  orgs?: {
    get(id: string): Organization | null;
    note(orgId: string, actor: string, action: string, target: string | null, detail?: Record<string, unknown> | null): void;
  } | null;
  /** Who is asking, as an organization sees it (email, SSO organizations). Defaults to the principal alone. */
  viewer?: (req: Request) => OrgViewer | null;
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

  const signedIn = (req: Request, res: Response): string | null => {
    const who = deps.sessionPrincipal(req);
    if (!who) refuse(res, 401, 'not_signed_in', 'sign in to create or change an agent');
    return who;
  };

  const viewerOf = (req: Request): OrgViewer | null => {
    const v = deps.viewer?.(req);
    if (v) return v;
    const who = deps.sessionPrincipal(req);
    return who ? { principal: who, email: null, name: null, ssoOrgIds: [] } : null;
  };

  /** The caller's role in an organization, or null; answers 404 when the organization does not exist. */
  const orgRole = (req: Request, res: Response, orgId: string): { org: Organization; role: OrgRole | null } | null => {
    const org = deps.orgs?.get(orgId) ?? null;
    if (!org) { refuse(res, 404, 'org_not_found', deps.orgs ? `no organization "${orgId}" on this node` : 'this node has no organizations'); return null; }
    return { org, role: membership(org, viewerOf(req))?.role ?? null };
  };

  /** May the caller change this agent? Its owner may; so may a `write` member of the organization it is under. */
  const mayChange = (req: Request, who: string, spec: HostedAgentSpec): boolean => {
    if (spec.owner === normalisePrincipal(who)) return true;
    if (!spec.org) return false;
    const org = deps.orgs?.get(spec.org) ?? null;
    return !!org && roleAtLeast(membership(org, viewerOf(req))?.role, 'write');
  };

  /** The spec, if the caller may change it. Answers the refusal itself otherwise. */
  const owned = (req: Request, res: Response): HostedAgentSpec | null => {
    const who = signedIn(req, res);
    if (!who) return null;
    const spec = deps.store.get(String(req.params.id));
    if (!spec) { refuse(res, 404, 'not_found', `no hosted agent "${req.params.id}" on this node`); return null; }
    if (!mayChange(req, who, spec)) { refuse(res, 403, 'not_owner', spec.org ? 'only the agent\'s creator, or a write member of its organization, can do this' : 'only the agent\'s creator can do this'); return null; }
    return spec;
  };

  /** Creating under (or moving into) an organization: it must exist, the caller must be a contributor there, a group must be one of its. */
  const orgAllows = (req: Request, res: Response, input: HostedAgentSpecInput): boolean => {
    if (!input.org) return true;
    const hit = orgRole(req, res, input.org);
    if (!hit) return false;
    if (!roleAtLeast(hit.role, 'contributor')) { refuse(res, 403, 'org_role', `creating an agent under "${input.org}" needs the contributor role there`); return false; }
    if (input.group && !hit.org.groups.some((g) => g.id === input.group)) { refuse(res, 400, 'invalid_request', `group: no resource group "${input.group}" in "${input.org}"`); return false; }
    return true;
  };

  /** Private organization agents are listed to the callers the organization admits; everything else to everyone. */
  const visibleTo = (req: Request, spec: HostedAgentSpec): boolean => {
    if (spec.visibility !== 'private') return true;
    const org = spec.org ? deps.orgs?.get(spec.org) ?? null : null;
    if (!org) return false;
    const viewer = viewerOf(req);
    return canSeeOrgAgent(org, spec, viewer, membership(org, viewer)?.role ?? null);
  };

  const actorOf = (req: Request, fallback: string) => normalisePrincipal(deps.sessionPrincipal(req) ?? fallback);

  /** Validate a body into a spec input; answers 400/501 itself. */
  const parse = (req: Request, res: Response): HostedAgentSpecInput | null => {
    const parsed = hostedAgentSpecInput.safeParse(req.body ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      refuse(res, 400, 'invalid_request', `${issue?.path.join('.') || 'body'}: ${issue?.message ?? 'invalid'}`);
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

  const view = (req: Request, spec: HostedAgentSpec, full: boolean) => {
    const base = `${deps.publicBase(req).replace(/\/+$/, '')}/agents/${spec.id}`;
    const st = deps.host.status(spec.id);
    const set = new Set(deps.secrets.names(spec.id));
    return {
      id: spec.id, name: spec.name, description: spec.description, model: spec.model, mode: spec.mode,
      owner: spec.owner, org: spec.org, visibility: spec.visibility, group: spec.group, version: spec.version, created_at: spec.createdAt, updated_at: spec.updatedAt,
      status: st?.status ?? 'failed', error: st?.error ?? null, live_version: st?.liveVersion ?? null,
      a2a_url: base, card_url: `${base}/.well-known/agent-card.json`,
      ...(full ? {
        systemPrompt: spec.systemPrompt, files: spec.files, a2ui: spec.a2ui, allowedHosts: spec.allowedHosts,
        secretNames: spec.secretNames, skills: spec.skills, media: hostedAgentMediaOf(spec),
        secrets: spec.secretNames.map((name) => ({ name, set: set.has(name) })),
      } : {}),
    };
  };

  /**
   * Every hosted agent the caller may see; `?mine=1` the caller's own; `?manageable=1` the caller's own plus every
   * agent of an organization where the caller is a `write` member (what an editor such as AinCode syncs);
   * `?org=<id>` an organization's (members only; private ones as the organization allows).
   */
  router.get('/api/hosted-agents', (req, res) => {
    if (req.query.mine) {
      const who = signedIn(req, res);
      if (!who) return;
      res.json({ agents: deps.store.listByOwner(who).map((s) => view(req, s, false)) });
      return;
    }
    if (req.query.manageable) {
      const who = signedIn(req, res);
      if (!who) return;
      res.json({ agents: deps.store.list().filter((s) => mayChange(req, who, s)).map((s) => view(req, s, false)) });
      return;
    }
    if (typeof req.query.org === 'string') {
      if (!signedIn(req, res)) return;
      const hit = orgRole(req, res, req.query.org);
      if (!hit) return;
      if (!hit.role) return refuse(res, 403, 'not_member', 'this organization is for its members');
      const viewer = viewerOf(req);
      res.json({ agents: deps.store.listByOrg(hit.org.id).filter((s) => canSeeOrgAgent(hit.org, s, viewer, hit.role)).map((s) => view(req, s, false)) });
      return;
    }
    res.json({ agents: deps.store.list().filter((s) => visibleTo(req, s)).map((s) => view(req, s, false)) });
  });

  router.post('/api/hosted-agents', (req, res) => {
    const who = signedIn(req, res);
    if (!who) return;
    const input = parse(req, res);
    if (!input) return;
    if (!orgAllows(req, res, input)) return;
    try {
      const spec = deps.store.create(input, who, deps.reserved);
      deps.host.apply(spec);
      if (spec.org) deps.orgs?.note(spec.org, normalisePrincipal(who), 'agent.create', spec.id, { kind: spec.mode, visibility: spec.visibility, group: spec.group });
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
    const parsed = parse(req, res);
    if (!parsed) return;
    if (parsed.id !== prior.id) return refuse(res, 400, 'invalid_request', 'an agent\'s id cannot change — it is its public address');
    // A body that does not mention `org` (a client written before organizations — the web's edit form) keeps where
    // the agent is: an edit of its prompt must not quietly move an organization's agent out of the organization.
    const body = (req.body ?? {}) as Record<string, unknown>;
    const input: HostedAgentSpecInput = 'org' in body ? parsed : { ...parsed, org: prior.org, visibility: prior.visibility, group: prior.group };
    // moving INTO another organization is a creation there; leaving one is the owner's or a write member's call (already checked)
    if (input.org !== prior.org && !orgAllows(req, res, input)) return;
    if (input.org === prior.org && input.group && input.group !== prior.group && !orgAllows(req, res, input)) return;
    const spec = deps.store.update(prior.id, input);
    deps.host.apply(spec);
    const actor = actorOf(req, prior.owner);
    if (prior.org && prior.org !== spec.org) deps.orgs?.note(prior.org, actor, 'agent.leave', spec.id, { to: spec.org });
    if (spec.org) deps.orgs?.note(spec.org, actor, prior.org === spec.org ? 'agent.update' : 'agent.create', spec.id, { kind: spec.mode, visibility: spec.visibility, group: spec.group });
    res.json({ agent: view(req, spec, true) });
  });

  router.delete('/api/hosted-agents/:id', async (req, res) => {
    const spec = owned(req, res);
    if (!spec) return;
    deps.store.delete(spec.id);
    deps.secrets.dropAgent(spec.id);
    await deps.host.remove(spec.id);
    if (spec.org) deps.orgs?.note(spec.org, actorOf(req, spec.owner), 'agent.delete', spec.id);
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
    // the name only — a value never reaches the audit log
    if (spec.org) deps.orgs?.note(spec.org, actorOf(req, spec.owner), value === null ? 'agent.secret.clear' : 'agent.secret.set', spec.id, { name });
    res.json({ name, set: value !== null });
  });

  router.get('/api/hosted-agents/:id/logs', async (req, res) => {
    const spec = owned(req, res);
    if (!spec) return;
    res.json({ lines: await deps.host.logs(spec.id) });
  });

  return router;
}
