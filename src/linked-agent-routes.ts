/**
 * `/api/linked-agents` — register, read, change and remove external A2A agents this node lists and proxies.
 *
 * Anyone signed in may register (a wallet session, or an AIN SSO session — a URL is not a node resource, so the
 * "SSO owns nothing" rule for hosted agents does not apply; docs/ain-sso.md §1); only the person who registered an
 * agent may change or remove it. Limits are the store's. Errors are `{ error: { code, message } }`, the codes being
 * what the web page — and AIN Teams — switch on.
 *
 * The one check a config agent never needed: `upstream` must resolve to a PUBLIC address. Config agents are typed
 * by the operator on the operator's own machine and may point at the LAN on purpose; a linked agent is typed by a
 * visitor, and a visitor who could make this node POST to `10.0.0.5` would be using it as a probe.
 */
import { Router, type Request, type Response } from 'express';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { hostedAgentAddressIsPublic } from './hosted-agent-gateway.js';
import {
  LinkedAgentIdTakenError, LinkedAgentLimitError, linkedAgentInput, type LinkedAgent, type LinkedAgentInput, type LinkedAgentStore,
} from './linked-agent-store.js';
import { agentUrl, summariseCard, type CardSummary } from './agents.js';
import { canSeeOrgAgent, membership, normalisePrincipal, roleAtLeast, type Organization, type OrgRole, type OrgViewer } from './organization-store.js';

export interface LinkedAgentRoutesDeps {
  store: LinkedAgentStore;
  /** The principal on this request — a lower-case wallet address or `sso:<sub>` — or null when nobody is signed in. */
  sessionPrincipal: (req: Request) => string | null;
  /** Ids a linked agent may not take — config agents and hosted agents. */
  reserved: (id: string) => boolean;
  /** This node's public base URL, for the addresses returned on register. */
  publicBase: (req: Request) => string;
  /** Ask the upstream for its card (agents.ts `probeUpstreamCard`). Injected so a test can answer without a server. */
  probe: (upstream: string) => Promise<{ card?: Record<string, unknown>; error?: string }>;
  /** Tests run their upstream on loopback; a node never does. */
  allowPrivateUpstream?: boolean;
  /**
   * Organizations (organization-store.ts), so an agent can be registered UNDER one: the caller must be at least a
   * `contributor` there, and a `write` member may change or remove any of the organization's agents, not only
   * their own. Without this, `org` in a request is refused.
   */
  orgs?: {
    get(id: string): Organization | null;
    note(orgId: string, actor: string, action: string, target: string | null, detail?: Record<string, unknown> | null): void;
  } | null;
  /** Who is asking, as an organization sees it (email, SSO organizations). Defaults to the principal alone. */
  viewer?: (req: Request) => OrgViewer | null;
}

const refuse = (res: Response, status: number, code: string, message: string) => {
  res.status(status).json({ error: { code, message } });
};

/**
 * Does this URL's host resolve only to public addresses? An IP literal is judged as is; a name is resolved and
 * every answer must be public, since the socket may pick any of them.
 */
export async function upstreamIsPublic(upstream: string): Promise<boolean> {
  let host: string;
  try { host = new URL(upstream).hostname.replace(/^\[|\]$/g, ''); } catch { return false; }
  if (isIP(host)) return hostedAgentAddressIsPublic(host);
  try {
    const answers = await lookup(host, { all: true });
    return answers.length > 0 && answers.every((a) => hostedAgentAddressIsPublic(a.address));
  } catch {
    return false;
  }
}

export function linkedAgentRoutes(deps: LinkedAgentRoutesDeps): Router {
  const router = Router();

  const signedIn = (req: Request, res: Response): string | null => {
    const who = deps.sessionPrincipal(req);
    if (!who) refuse(res, 401, 'not_signed_in', 'sign in to register or change a linked agent');
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

  /**
   * May the caller change this agent? Its owner may; so may a `write` member of the organization it is under —
   * the organization's agents are the organization's, not one leaver's.
   */
  const mayChange = (req: Request, who: string, agent: LinkedAgent): boolean => {
    if (agent.owner === who) return true;
    if (!agent.org) return false;
    const org = deps.orgs?.get(agent.org) ?? null;
    return !!org && roleAtLeast(membership(org, viewerOf(req))?.role, 'write');
  };

  /** The agent, if the caller may change it. Answers the refusal itself otherwise. */
  const owned = (req: Request, res: Response): LinkedAgent | null => {
    const who = signedIn(req, res);
    if (!who) return null;
    const agent = deps.store.get(String(req.params.id));
    if (!agent) { refuse(res, 404, 'not_found', `no linked agent "${req.params.id}" on this node`); return null; }
    if (!mayChange(req, who, agent)) { refuse(res, 403, 'not_owner', agent.org ? 'only the account that registered this agent, or a write member of its organization, can do this' : 'only the account that registered this agent can do this'); return null; }
    return agent;
  };

  /** Registering under (or moving into) an organization: it must exist, the caller must be a contributor there, a group must be one of its. */
  const orgAllows = (req: Request, res: Response, input: LinkedAgentInput): boolean => {
    if (!input.org) return true;
    const hit = orgRole(req, res, input.org);
    if (!hit) return false;
    if (!roleAtLeast(hit.role, 'contributor')) { refuse(res, 403, 'org_role', `registering an agent under "${input.org}" needs the contributor role there`); return false; }
    if (input.group && !hit.org.groups.some((g) => g.id === input.group)) { refuse(res, 400, 'invalid_request', `group: no resource group "${input.group}" in "${input.org}"`); return false; }
    return true;
  };

  /** Validate a body; answers 400 itself. The public-address check is async and answered by the caller. */
  const parse = (req: Request, res: Response): LinkedAgentInput | null => {
    const parsed = linkedAgentInput.safeParse(req.body ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      refuse(res, 400, 'invalid_request', `${issue?.path.join('.') || 'body'}: ${issue?.message ?? 'invalid'}`);
      return null;
    }
    return parsed.data;
  };

  const view = (req: Request, agent: LinkedAgent, probe?: { card?: CardSummary; error?: string }) => {
    const base = agentUrl(deps.publicBase(req), agent.id);
    return {
      id: agent.id, name: agent.name, description: agent.description, owner: agent.owner, version: agent.version,
      org: agent.org, visibility: agent.visibility, group: agent.group,
      created_at: agent.createdAt, updated_at: agent.updatedAt, kind: 'upstream' as const,
      a2a_url: base, card_url: `${base}/.well-known/agent-card.json`,
      ...(probe ? { reachable: !!probe.card, error: probe.error ?? null, card: probe.card ?? null } : {}),
    };
  };

  /**
   * Fetch the card and, when the person typed no name, take the card's. Refuses a non-public upstream before any
   * request is made to it. A card that does not answer is NOT a refusal: an agent may be registered before it is up,
   * and the catalogue says "not answering" until it is.
   */
  const resolve = async (req: Request, res: Response, input: LinkedAgentInput) => {
    if (!deps.allowPrivateUpstream && !(await upstreamIsPublic(input.upstream))) {
      refuse(res, 400, 'upstream_not_public', 'upstream must be a public address — this node will not call into a private network');
      return null;
    }
    const probed = await deps.probe(input.upstream);
    const card = probed.card ? summariseCard(probed.card) : undefined;
    const name = input.name || card?.name || '';
    if (!name) {
      refuse(res, 400, 'name_required', probed.card ? 'the agent card has no name; give one' : `the card could not be fetched (${probed.error ?? 'no card'}); give the agent a name`);
      return null;
    }
    return { input: { ...input, name, description: input.description || card?.description || '' }, probe: { card, error: probed.error } };
  };

  /** Every linked agent, or `?mine=1` the caller's, or `?org=<id>` an organization's (members only; private ones as the organization allows). */
  router.get('/api/linked-agents', (req, res) => {
    if (req.query.mine) {
      const who = signedIn(req, res);
      if (!who) return;
      res.json({ agents: deps.store.listByOwner(who).map((a) => view(req, a)) });
      return;
    }
    if (typeof req.query.org === 'string') {
      if (!signedIn(req, res)) return;
      const hit = orgRole(req, res, req.query.org);
      if (!hit) return;
      if (!hit.role) return refuse(res, 403, 'not_member', 'this organization is for its members');
      const viewer = viewerOf(req);
      res.json({ agents: deps.store.listByOrg(hit.org.id).filter((a) => canSeeOrgAgent(hit.org, a, viewer, hit.role)).map((a) => view(req, a)) });
      return;
    }
    // the public list: what the catalogue shows everyone — private organization agents are not in it
    res.json({ agents: deps.store.list().filter((a) => a.visibility !== 'private').map((a) => view(req, a)) });
  });

  router.post('/api/linked-agents', async (req, res) => {
    const who = signedIn(req, res);
    if (!who) return;
    const input = parse(req, res);
    if (!input) return;
    if (deps.store.has(input.id) || deps.reserved(input.id)) return refuse(res, 409, 'id_taken', `the id "${input.id}" is taken`);
    if (!orgAllows(req, res, input)) return;
    const resolved = await resolve(req, res, input);
    if (!resolved) return;
    try {
      const agent = deps.store.create(resolved.input, who, deps.reserved);
      if (agent.org) deps.orgs?.note(agent.org, normalisePrincipal(who), 'agent.register', agent.id, { visibility: agent.visibility, group: agent.group });
      res.status(201).json({ agent: view(req, agent, resolved.probe) });
    } catch (e) {
      if (e instanceof LinkedAgentIdTakenError) return refuse(res, 409, 'id_taken', e.message);
      if (e instanceof LinkedAgentLimitError) return refuse(res, 429, 'limit_reached', e.message);
      throw e;
    }
  });

  router.get('/api/linked-agents/:id', (req, res) => {
    const agent = owned(req, res);
    if (agent) res.json({ agent: { ...view(req, agent), upstream: agent.upstream } });
  });

  router.put('/api/linked-agents/:id', async (req, res) => {
    const prior = owned(req, res);
    if (!prior) return;
    const input = parse(req, res);
    if (!input) return;
    if (input.id !== prior.id) return refuse(res, 400, 'invalid_request', 'an agent\'s id cannot change — it is its public address');
    // moving INTO another organization is a registration there; leaving one is the owner's or a write member's call (already checked)
    if (input.org !== prior.org && !orgAllows(req, res, input)) return;
    if (input.org === prior.org && input.group && !orgAllows(req, res, input)) return;
    const resolved = await resolve(req, res, input);
    if (!resolved) return;
    const agent = deps.store.update(prior.id, resolved.input);
    const actor = normalisePrincipal(deps.sessionPrincipal(req) ?? prior.owner);
    if (prior.org && prior.org !== agent.org) deps.orgs?.note(prior.org, actor, 'agent.leave', agent.id, { to: agent.org });
    if (agent.org) deps.orgs?.note(agent.org, actor, prior.org === agent.org ? 'agent.update' : 'agent.register', agent.id, { visibility: agent.visibility, group: agent.group });
    res.json({ agent: { ...view(req, agent, resolved.probe), upstream: agent.upstream } });
  });

  router.delete('/api/linked-agents/:id', (req, res) => {
    const agent = owned(req, res);
    if (!agent) return;
    deps.store.delete(agent.id);
    if (agent.org) deps.orgs?.note(agent.org, normalisePrincipal(deps.sessionPrincipal(req) ?? agent.owner), 'agent.delete', agent.id);
    res.json({ deleted: agent.id });
  });

  return router;
}
