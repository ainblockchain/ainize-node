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
import { hostedAgentVisibilityOf } from './hosted-agent-types.js';
import { audienceOf, canSeeAgent, hostedAgentChangeType, listsAgentFor, principalCaller, widerAudience, type AgentCaller, type SharedAgentEvents } from './shared-agents.js';

export interface LinkedAgentRoutesDeps {
  store: LinkedAgentStore;
  /**
   * Who is on this request: a wallet session, an AIN SSO session or an organization API key (shared-agents.ts
   * `agentCallerOf`), with what organizations they may share with. `sessionPrincipal` is the older, principal-only
   * spelling; either serves, `caller` first.
   */
  caller?: (req: Request) => AgentCaller | null;
  /** The principal on this request — a lower-case wallet address or `sso:<sub>` — or null when nobody is signed in. */
  sessionPrincipal?: (req: Request) => string | null;
  /** The change feed of the shared registry, told of every register, change and removal. Absent → no feed. */
  events?: SharedAgentEvents;
  /** This node's public base URL as the registry names it (`registryIssuer`); defaults to `publicBase`. */
  registryIssuer?: (req: Request) => string;
  /** Ids a linked agent may not take — config agents and hosted agents. */
  reserved: (id: string) => boolean;
  /** This node's public base URL, for the addresses returned on register. */
  publicBase: (req: Request) => string;
  /** Ask the upstream for its card (agents.ts `probeUpstreamCard`). Injected so a test can answer without a server. */
  probe: (upstream: string) => Promise<{ card?: Record<string, unknown>; error?: string }>;
  /** Tests run their upstream on loopback; a node never does. */
  allowPrivateUpstream?: boolean;
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

  const callerOf = (req: Request): AgentCaller | null => {
    if (deps.caller) return deps.caller(req);
    const who = deps.sessionPrincipal?.(req);
    return who ? principalCaller(who) : null;
  };

  const signedIn = (req: Request, res: Response): AgentCaller | null => {
    const who = callerOf(req);
    if (!who) refuse(res, 401, 'not_signed_in', 'sign in to register or change a linked agent');
    return who;
  };

  const notFound = (res: Response, id: unknown) => refuse(res, 404, 'not_found', `no linked agent "${id}" on this node`);

  /** The agent, if the caller registered it. Answers the refusal itself otherwise — 404, never 403, for one they may not see. */
  const owned = (req: Request, res: Response): LinkedAgent | null => {
    const who = signedIn(req, res);
    if (!who) return null;
    const agent = deps.store.get(String(req.params.id));
    if (!agent || !canSeeAgent(agent, who)) { notFound(res, req.params.id); return null; }
    if (agent.owner !== who.subject) { refuse(res, 403, 'not_owner', 'only the account that registered this agent can do this'); return null; }
    return agent;
  };

  /**
   * Validate a body; answers 400 itself. The public-address check is async and answered by the caller. Sharing with
   * an organization is the registrant's to do only for one they belong to (an SSO session's memberships, or the
   * organization an API key was issued for); a wallet belongs to none.
   */
  const parse = (req: Request, res: Response, who: AgentCaller): LinkedAgentInput | null => {
    const parsed = linkedAgentInput.safeParse(req.body ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      refuse(res, 400, 'invalid_request', `${issue?.path.join('.') || 'body'}: ${issue?.message ?? 'invalid'}`);
      return null;
    }
    if (parsed.data.visibility === 'org' && !who.orgMember(parsed.data.orgId!)) {
      refuse(res, 400, 'invalid_request', who.kind === 'wallet'
        ? 'orgId: sharing with an organization needs an AIN SSO session or an organization API key; a wallet belongs to none'
        : `orgId: you are not a member of ${parsed.data.orgId}`);
      return null;
    }
    return parsed.data;
  };

  const issuer = (req: Request) => (deps.registryIssuer ?? deps.publicBase)(req).replace(/\/+$/, '');

  const view = (req: Request, agent: LinkedAgent, probe?: { card?: CardSummary; error?: string }) => {
    const base = agentUrl(deps.publicBase(req), agent.id);
    return {
      id: agent.id, name: agent.name, description: agent.description, owner: agent.owner, version: agent.version,
      visibility: hostedAgentVisibilityOf(agent), org_id: agent.orgId ?? null,
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

  /**
   * What the caller may see listed: everyone the `public` ones; a signed-in caller also their own (whatever the
   * visibility) and the `org` ones of organizations they belong to. `?mine=1` is the caller's own alone.
   */
  router.get('/api/linked-agents', (req, res) => {
    if (req.query.mine) {
      const who = signedIn(req, res);
      if (!who) return;
      res.json({ agents: deps.store.listByOwner(who.subject).map((a) => view(req, a)) });
      return;
    }
    const who = callerOf(req);
    res.json({ agents: deps.store.list().filter((a) => listsAgentFor(a, who)).map((a) => view(req, a)) });
  });

  router.post('/api/linked-agents', async (req, res) => {
    const who = signedIn(req, res);
    if (!who) return;
    const input = parse(req, res, who);
    if (!input) return;
    if (deps.store.has(input.id) || deps.reserved(input.id)) return refuse(res, 409, 'id_taken', `the id "${input.id}" is taken`);
    const resolved = await resolve(req, res, input);
    if (!resolved) return;
    try {
      const agent = deps.store.create(resolved.input, who.subject, deps.reserved);
      deps.events?.append({ type: 'agent.published', registryIssuer: issuer(req), agentId: agent.id, version: agent.version, releaseId: `linked-v${agent.version}`, audience: audienceOf(agent) });
      res.status(201).json({ agent: view(req, agent, resolved.probe) });
    } catch (e) {
      if (e instanceof LinkedAgentIdTakenError) return refuse(res, 409, 'id_taken', e.message);
      if (e instanceof LinkedAgentLimitError) return refuse(res, 429, 'limit_reached', e.message);
      throw e;
    }
  });

  /** The owner sees the whole record, upstream included; anyone else it is visible to sees what a listing shows. */
  router.get('/api/linked-agents/:id', (req, res) => {
    const who = callerOf(req);
    const agent = deps.store.get(String(req.params.id));
    if (!agent || !canSeeAgent(agent, who)) return notFound(res, req.params.id);
    res.json({ agent: who && agent.owner === who.subject ? { ...view(req, agent), upstream: agent.upstream } : view(req, agent) });
  });

  router.put('/api/linked-agents/:id', async (req, res) => {
    const prior = owned(req, res);
    if (!prior) return;
    const who = callerOf(req)!;
    const input = parse(req, res, who);
    if (!input) return;
    if (input.id !== prior.id) return refuse(res, 400, 'invalid_request', 'an agent\'s id cannot change — it is its public address');
    const resolved = await resolve(req, res, input);
    if (!resolved) return;
    const agent = deps.store.update(prior.id, resolved.input);
    deps.events?.append({ type: hostedAgentChangeType(prior, agent), registryIssuer: issuer(req), agentId: agent.id, version: agent.version, releaseId: `linked-v${agent.version}`, audience: widerAudience(audienceOf(prior), audienceOf(agent)) });
    res.json({ agent: { ...view(req, agent, resolved.probe), upstream: agent.upstream } });
  });

  router.delete('/api/linked-agents/:id', (req, res) => {
    const agent = owned(req, res);
    if (!agent) return;
    deps.store.delete(agent.id);
    // One past the last version: the feed's version is strictly increasing per resource, and the delete comes after.
    deps.events?.append({ type: 'agent.deleted', registryIssuer: issuer(req), agentId: agent.id, version: agent.version + 1, audience: audienceOf(agent) });
    res.json({ deleted: agent.id });
  });

  return router;
}
