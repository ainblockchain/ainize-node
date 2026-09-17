/**
 * A2A agents this node operates (NEWS-AGENT-REQUIREMENTS §5, §6.1).
 *
 * An agent is a separate process — it has its own dependencies, its own failure modes and its own GPU
 * appetite — and the node's job is to give it a stable public address and to say, on the record, whether it
 * is answering. So this is a proxy and a registry, not a runtime: `agents[].upstream` points at wherever the
 * process actually listens, and everything below is about the URL in front of it.
 *
 * ## Why the path shape is what it is
 *
 * A2A discovery is `GET /.well-known/agent-card.json` at the agent's own origin, and a node runs more than
 * one agent, so each gets a prefix and serves its card at `<prefix>/.well-known/agent-card.json`. A client
 * that only knows the base URL still finds the card, because the prefix IS the base URL it was given.
 *
 * The card's `url` field is rewritten on the way through. Upstream it says `http://localhost:4010`, which is
 * correct for the process and useless to anyone else; a caller that trusted it would post to its own machine.
 *
 * ## No authentication reaches the agent
 *
 * The protocol sends none (§2), so this endpoint is public by construction. The node adds what the protocol
 * cannot: a body cap and a per-IP rate limit in front of every agent, so a crawler that finds the URL cannot
 * spend the node's GPU. The agent enforces its own limits too — neither layer is load-bearing alone.
 */
import { Router, type Request, type Response } from 'express';
import type { AgentAdvert, NodeAgentConfig, NodeConfig, PeerInfo } from '@ainize/core';
import { API_SAM_PREFIX, pipeRelay, verifySamAuth, type MeshRelay } from './sam.js';

/**
 * One agent, as `config.json` declares it.
 *
 * The shape lives in `@ainize/core` so the node, the CLI (`ainize agent add`) and the config file cannot drift
 * apart; this alias keeps the name every call site here already uses.
 */
export type AgentConfig = NodeAgentConfig;

export const AGENT_PREFIX = '/agents';
const CARD_PATHS = ['/.well-known/agent-card.json', '/.well-known/agent.json', '/agent.json'];

const RATE = { windowMs: 60_000, perIp: 20 };
const MAX_BODY_BYTES = 200_000;
const UPSTREAM_TIMEOUT_MS = 90_000;

export const agentIdOk = (id: string) => /^[a-z0-9][a-z0-9-]{0,39}$/.test(id);

/** The public base URL of one agent — what an operator copies and a workspace is given. */
export function agentUrl(publicUrl: string | undefined, id: string): string {
  const base = (publicUrl ?? '').replace(/\/+$/, '');
  return `${base}${AGENT_PREFIX}/${id}`;
}

/**
 * What a marketplace row needs out of an agent card (§6.1, and /explore listing agents beside knowledge).
 *
 * The registry used to keep only the card's `name`, which is enough for an operator who already knows what
 * their own agent does and useless to a visitor choosing one. A listing has to say what the agent ACCEPTS —
 * that is what `skills` is for in the protocol — so the card's skills, its own description and the protocol
 * versions it speaks are summarised here and handed to the browse page.
 *
 * Every field is optional because a card is written by someone else. A card with no skills is a valid card.
 */
export interface CardSummary {
  name?: string;
  description?: string;
  skills: { id: string; name: string; description?: string; tags: string[]; examples: string[] }[];
  /** Protocol versions the card offers, newest spelling first. `['1.0','0.3']` for a dual-version agent. */
  protocols: string[];
  /** Extension URIs the card declares — A2UI is the one this marketplace draws. */
  extensions: string[];
  provider?: string;
  documentation_url?: string;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()) : []);

/**
 * Read an agent card into the handful of fields a listing shows. Pure, and tolerant: a card is authored by
 * whoever runs the agent, and half of them are hand-written, so anything malformed is dropped rather than
 * allowed to throw inside the list handler.
 */
export function summariseCard(card: unknown): CardSummary {
  const c = (card ?? {}) as Record<string, unknown>;
  const ifaces = Array.isArray(c.supportedInterfaces) ? (c.supportedInterfaces as Record<string, unknown>[]) : [];
  const protocols = [
    ...new Set([...ifaces.map((i) => str(i?.protocolVersion)), str(c.protocolVersion)].filter((v): v is string => !!v)),
  ];
  const caps = (c.capabilities ?? {}) as Record<string, unknown>;
  const exts = Array.isArray(caps.extensions) ? (caps.extensions as Record<string, unknown>[]) : [];
  const skills = (Array.isArray(c.skills) ? (c.skills as Record<string, unknown>[]) : [])
    .filter((s) => s && (str(s.id) || str(s.name)))
    .slice(0, 12)
    .map((s) => ({
      id: str(s.id) ?? str(s.name) ?? '',
      name: str(s.name) ?? str(s.id) ?? '',
      description: str(s.description),
      tags: strs(s.tags).slice(0, 8),
      examples: strs(s.examples).slice(0, 4),
    }));
  return {
    name: str(c.name),
    description: str(c.description),
    skills,
    protocols,
    extensions: exts.map((e) => str(e?.uri)).filter((v): v is string => !!v),
    provider: str((c.provider as Record<string, unknown> | undefined)?.organization),
    documentation_url: str(c.documentationUrl),
  };
}

type Health = { reachable: boolean | null; checked_at: number | null; error?: string; card?: CardSummary };
const health = new Map<string, Health>();
const calls = new Map<string, { total: number; last_at: number | null }>();

function limiter() {
  const seen = new Map<string, number[]>();
  return (ip: string) => {
    const now = Date.now();
    const hits = (seen.get(ip) ?? []).filter((t) => now - t < RATE.windowMs);
    hits.push(now);
    seen.set(ip, hits);
    if (seen.size > 5000) for (const [k, v] of seen) if (!v.some((t) => now - t < RATE.windowMs)) seen.delete(k);
    return hits.length > RATE.perIp;
  };
}

async function upstreamFetch(url: string, init: RequestInit = {}, timeoutMs = UPSTREAM_TIMEOUT_MS) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return { ok: true as const, res: await fetch(url, { ...init, signal: ctl.signal }) };
  } catch (e) {
    const err = e as Error;
    return { ok: false as const, error: err.name === 'AbortError' ? 'upstream timeout' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask the agent for its card, and remember whether it answered.
 *
 * This doubles as the health check because it is the one request every A2A client makes first: an agent
 * whose card cannot be fetched is not reachable in any sense a caller cares about, whatever its process
 * table says.
 */
async function fetchCard(a: AgentConfig): Promise<{ card?: Record<string, unknown>; error?: string }> {
  const base = a.upstream.replace(/\/+$/, '');
  for (const p of CARD_PATHS) {
    const r = await upstreamFetch(base + p, { headers: { Accept: 'application/json' } }, 8000);
    if (!r.ok) { health.set(a.id, { reachable: false, checked_at: Date.now(), error: r.error }); return { error: r.error }; }
    if (r.res.ok) {
      const card = await r.res.json().catch(() => null) as Record<string, unknown> | null;
      if (card) {
        health.set(a.id, { reachable: true, checked_at: Date.now(), card: summariseCard(card) });
        return { card };
      }
    }
  }
  const error = 'no agent card at any well-known path';
  health.set(a.id, { reachable: false, checked_at: Date.now(), error });
  return { error };
}

/**
 * Refresh what this node knows about its own agents, at most once per `maxAgeMs`.
 *
 * Gossip runs every few seconds and calls this; the cap is what keeps that from becoming a probe storm against
 * the agent processes. Failures are not raised — an agent that is down is advertised as unreachable, which is
 * strictly more useful to a peer than being advertised as absent.
 */
export async function refreshAgentHealth(cfg: NodeConfig, maxAgeMs = 60_000): Promise<void> {
  await Promise.all(listAgents(cfg).map(async (a) => {
    const known = health.get(a.id);
    if (known && Date.now() - (known.checked_at ?? 0) < maxAgeMs) return;
    await fetchCard(a);
  }));
}

/** Cap on what one node advertises. A gossip payload is not a catalogue. */
const MAX_ADVERTS = 20;

/**
 * What this node tells the network about its agents (`PeerInfo.agents`).
 *
 * The URL is this node's own — an agent is served by the node that runs it, and a peer that lists it links
 * there rather than relaying. That is the whole reason this is an advert and not a proxy: a marketplace can
 * show an agent it does not host, and the traffic still goes to the operator who accepted it.
 */
export function agentAdverts(cfg: NodeConfig, publicUrl: string | undefined): AgentAdvert[] {
  return listAgents(cfg).slice(0, MAX_ADVERTS).map((a) => {
    const h = health.get(a.id);
    return {
      id: a.id,
      name: h?.card?.name || a.name || a.id,
      ...(h?.card?.description ?? a.description ? { description: h?.card?.description ?? a.description } : {}),
      url: agentUrl(publicUrl, a.id),
      ...(h?.card?.skills?.length ? { skills: h.card.skills.map((s) => s.name).slice(0, 6) } : {}),
      ...(h?.card?.protocols?.length ? { protocols: h.card.protocols } : {}),
      ...(h?.card?.extensions?.length ? { extensions: h.card.extensions } : {}),
      ...(h?.reachable === null || h?.reachable === undefined ? {} : { reachable: h.reachable }),
    };
  });
}

export function listAgents(cfg: NodeConfig): AgentConfig[] {
  const raw = cfg.agents ?? [];
  return raw.filter((a) => a && agentIdOk(a.id) && typeof a.upstream === 'string' && a.enabled !== false);
}

/** What the list needs from the rest of the node to show — and serve — agents it does not itself operate. */
export interface AgentsDeps {
  /** The peer table and node registry, as `market.knownNodes()` returns it. */
  knownNodes?: () => Promise<PeerInfo[]>;
  /** This node's own address, so its own row is not listed twice. */
  selfAddress?: string;
  /** The mesh hop (sam.ts). Without it this node lists peers' agents; with it, it also serves them. */
  relay?: MeshRelay;
  /** This node's public base URL, for the addresses it hands out. */
  publicUrl?: () => string | undefined;
}

/** How long an id → peer resolution is reused. The peer table is gossiped; it does not change per request. */
const REGISTRY_TTL_MS = 30_000;

export function buildAgents(cfg: NodeConfig, deps: AgentsDeps = {}): Router {
  const r = Router();
  const rateLimited = limiter();
  // express 5 types a wildcard param as string | string[]; an agent id is always one segment
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
  const find = (id: string) => listAgents(cfg).find((a) => a.id === id);
  /** The address this node is known by: its configured public URL, or the host the request came in on. */
  const publicBase = (req: Request) => deps.publicUrl?.() ?? (cfg as NodeConfig & { publicUrl?: string }).publicUrl
    ?? `${req.protocol}://${req.get('host') ?? ''}`;

  /**
   * Agents this node has REGISTERED from the peer table: id → the node that runs it.
   *
   * This is what gives a peer's agent an address here. The nodes are already connected over p2p, so nothing
   * about the network has to change for it — the advert arrived on a gossip round, and this node can reach
   * the peer on the same link it learned it from. A caller only ever sees `/agents/<id>` on this node.
   *
   * **Local wins, then most recently seen.** Two nodes may run an agent with the same id, and an id is not an
   * identity; whoever this node runs itself is never shadowed by a peer, and between peers the fresher advert
   * holds the name. The peer-qualified mesh path (`/sam/<peer>/a2a/<id>`) always reaches a specific one, so
   * nothing is unreachable — only the short name is contested.
   */
  let registry = new Map<string, { peer: string; node: PeerInfo }>();
  let registryAt = 0;
  const registered = async (): Promise<Map<string, { peer: string; node: PeerInfo }>> => {
    if (Date.now() - registryAt < REGISTRY_TTL_MS) return registry;
    const self = (deps.selfAddress ?? cfg.identity?.address ?? '').toLowerCase();
    const next = new Map<string, { peer: string; node: PeerInfo }>();
    const seenAt = new Map<string, number>();
    for (const node of (await deps.knownNodes?.().catch(() => [])) ?? []) {
      if (!node?.agents?.length || (node.address ?? '').toLowerCase() === self) continue;
      for (const ad of node.agents) {
        if (!ad?.id || !ad.url) continue;
        const at = node.last_seen ?? 0;
        if ((seenAt.get(ad.id) ?? -1) >= at) continue;
        seenAt.set(ad.id, at);
        next.set(ad.id, { peer: node.address, node });
      }
    }
    registry = next;
    registryAt = Date.now();
    return registry;
  };
  /** The remote agent behind an id, ready to call — or null when this node has no such registration. */
  const remote = async (id: string) => {
    if (find(id) || !deps.relay) return null;
    const hit = (await registered()).get(id);
    if (!hit) return null;
    const peerUrl = deps.relay.resolve(hit.peer);
    return peerUrl ? { ...hit, peerUrl, relay: deps.relay } : null;
  };

  /**
   * §6.1 — what the operator's list is built from. Public on purpose: the A2A URLs are public endpoints
   * anyway, and hiding the list would not hide them. What is NOT here is the upstream address, which is an
   * internal detail and, on a LAN, a hint worth withholding.
   */
  r.get('/api/agents', async (req: Request, res: Response) => {
    const publicUrl = (cfg as NodeConfig & { publicUrl?: string }).publicUrl
      ?? `${req.protocol}://${req.get('host') ?? ''}`;
    const out = await Promise.all(listAgents(cfg).map(async (a) => {
      const known = health.get(a.id);
      // only probe when we have no recent answer — the list should not cost a round trip per agent per render
      if (!known || Date.now() - (known.checked_at ?? 0) > 30_000) await fetchCard(a);
      const h = health.get(a.id);
      const c = calls.get(a.id);
      return {
        id: a.id,
        name: h?.card?.name || a.name || a.id,
        // the card speaks for the agent; config.json is the fallback for an agent that is not answering
        description: h?.card?.description ?? a.description ?? null,
        skills: h?.card?.skills ?? [],
        protocols: h?.card?.protocols ?? [],
        extensions: h?.card?.extensions ?? [],
        provider: h?.card?.provider ?? null,
        documentation_url: h?.card?.documentation_url ?? null,
        a2a_url: agentUrl(publicUrl, a.id),
        card_url: `${agentUrl(publicUrl, a.id)}/.well-known/agent-card.json`,
        // this node runs it, so its own address is also where a call goes
        call_url: agentUrl(publicUrl, a.id),
        reachable: h?.reachable ?? null,
        last_checked: h?.checked_at ?? null,
        error: h?.error ?? null,
        calls: c?.total ?? 0,
        last_call_at: c?.last_at ?? null,
        node: null,
      };
    }));

    /**
     * Agents on other nodes, from the peer table (`PeerInfo.agents`).
     *
     * This is what makes the page a marketplace rather than a status page for one box: gossip already carries
     * what every peer holds, and an agent is one more thing a node holds. The URL is the OWNING node's, so a
     * visitor who clicks talks to the operator who accepted that agent — this node lists it, it does not
     * relay it, and nothing here is proxied.
     *
     * What a peer cannot tell us, we do not invent: `calls` is null rather than 0, because this node has
     * counted none of them and a zero would read as "nobody uses it".
     */
    const self = (deps.selfAddress ?? (cfg as NodeConfig & { identity?: { address?: string } }).identity?.address ?? '').toLowerCase();
    const base = (publicUrl ?? '').replace(/\/+$/, '');
    const reg = await registered();
    const seen = new Set(out.map((a) => a.a2a_url));
    /**
     * One row per (node, agent), newest advert wins.
     *
     * The node registry keeps a node that answers at two endpoints as two rows on purpose — that is how an
     * operator sees a machine they thought they had moved. An agent list is not the place for it: the same
     * agent under two addresses reads as two agents, and one of the addresses is stale. Keyed by the node's
     * ADDRESS, which is its identity, rather than by the endpoint, which is where it happened to answer.
     */
    const byAgent = new Map<string, { row: (typeof out)[number]; seen_at: number }>();
    for (const node of (await deps.knownNodes?.().catch(() => [])) ?? []) {
      if (!node?.agents?.length || (node.address ?? '').toLowerCase() === self) continue;
      for (const ad of node.agents.slice(0, 20)) {
        if (!ad?.id || !ad.url || seen.has(ad.url)) continue;
        const key = `${(node.address ?? '').toLowerCase()}:${ad.id}`;
        const prior = byAgent.get(key);
        const seen_at = node.last_seen ?? 0;
        if (prior && prior.seen_at >= seen_at) continue;
        // `ad.url` is used to decide there IS an agent there and to reach it; it is never put in the answer
        const front = reg.get(ad.id)?.peer === node.address;
        const mesh = `${base}${API_SAM_PREFIX}/${node.address}/a2a/${ad.id}`;
        byAgent.set(key, { seen_at, row: {
          id: ad.id,
          name: ad.name || ad.id,
          description: ad.description ?? null,
          // an advert carries skill NAMES; whoever wants the rest fetches the card at `url`
          skills: (ad.skills ?? []).map((n) => ({ id: n, name: n, description: undefined, tags: [], examples: [] })),
          protocols: ad.protocols ?? [],
          extensions: ad.extensions ?? [],
          provider: null,
          documentation_url: null,
          /**
           * The address to give somebody else.
           *
           * This node's own, when it has registered the agent: the nodes are connected over p2p already, so a
           * caller does not need to reach the peer — this node does, and it can. The peer's own address is
           * NOT reported: it is how this node reaches the peer, usually on the operator's own network, and
           * a visitor can neither use it nor should be handed it. Browser → this node → the peer.
           *
           * An id is not an identity, so when two nodes run one id only the registered one gets the short
           * address here; the other keeps the peer-qualified mesh URL, which always reaches exactly it.
           */
          a2a_url: front ? agentUrl(base, ad.id) : mesh,
          card_url: `${(front ? agentUrl(base, ad.id) : mesh).replace(/\/+$/, '')}/.well-known/agent-card.json`,
          /**
           * Where a caller on THIS node sends the request.
           *
           * Not `a2a_url`: that address is on the other operator's network, and a browser on an HTTPS page
           * that fetches it is refused twice — as mixed content, and by the public-to-private network
           * permission, which asks the visitor for local network access for a site that has no business on
           * their LAN. The mesh path forwards it from this node instead, which is the one machine that can
           * reach both ends.
           */
          call_url: mesh,
          reachable: ad.reachable ?? null,
          last_checked: node.last_seen ?? null,
          error: null,
          calls: null,
          last_call_at: null,
          /**
           * WHO runs it — a name and an identity, never a location.
           *
           * The peer's endpoint is how this node reaches it, and on most deployments that is an address on
           * the operator's own network. Publishing it tells a visitor nothing they can use and tells everyone
           * else the shape of somebody's LAN. The chain is browser → this node → the peer, and only the first
           * hop is anyone else's business.
           */
          node: { address: node.address, name: node.name },
        } as unknown as (typeof out)[number] });
      }
    }
    res.json({ agents: [...out, ...[...byAgent.values()].map((v) => v.row)] });
  });

  // ── the A2A surface, one prefix per agent
  const serveCard = async (req: Request, res: Response) => {
    const id = one(req.params.id);
    const a = find(id);
    const tail = `/${(req.params as { path?: string[] }).path?.join('/') ?? ''}`.replace(/\/+$/, '') || '/';
    if (!a) {
      // Registered from the peer table: the card is the peer's, rewritten so it is followed back here. A
      // client never learns which node runs the agent, which is the point of registering it.
      const via = await remote(id);
      if (!via) return res.status(404).json({ error: `no agent "${id}" on this node` });
      if (!CARD_PATHS.includes(tail)) return res.status(404).json({ error: 'not found' });
      const base = agentUrl(publicBase(req), id);
      const out = await via.relay.card(via.peer, via.peerUrl, id, base, req.header('a2a-version'));
      if ('error' in out) return res.status(out.status).json({ error: out.error });
      return res.json(out.card);
    }
    if (!CARD_PATHS.includes(tail)) return res.status(404).json({ error: 'not found' });

    const { card, error } = await fetchCard(a);
    if (!card) return res.status(502).json({ error: `agent unreachable: ${error}` });
    const publicUrl = (cfg as NodeConfig & { publicUrl?: string }).publicUrl
      ?? `${req.protocol}://${req.get('host') ?? ''}`;
    const url = agentUrl(publicUrl, a.id);
    // The upstream's own `url` points at localhost; a caller that trusted it would post to its own machine.
    // v1.0 carries the address in `supportedInterfaces` instead, and a card that keeps a stale one there sends
    // a modern client to the same dead address the legacy field used to.
    const interfaces = Array.isArray(card.supportedInterfaces)
      ? { supportedInterfaces: (card.supportedInterfaces as Record<string, unknown>[]).map((i) => ({ ...i, url })) }
      : {};
    res.json({ ...card, ...interfaces, url });
  };
  r.get(`${AGENT_PREFIX}/:id{/*path}`, serveCard);

  const callAgent = async (req: Request, res: Response) => {
    const id = one(req.params.id);
    const a = find(id);
    if (!a) {
      const via = await remote(id);
      if (!via) return res.status(404).json({ error: `no agent "${id}" on this node` });
      if (rateLimited(req.ip ?? 'unknown')) {
        return res.status(429).json({ jsonrpc: '2.0', id: null, error: { code: -32029, message: 'rate limit' } });
      }
      // the gate runs on the way out to the peer, exactly as it does on the mesh path — same code, same refusal
      const refusal = await via.relay.gate(via.peer, via.peerUrl, req.header('x-sam-required-labels'));
      if (refusal) return res.status(refusal.status).type('text/plain').send(refusal.body);
      const body = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
      if (body.length > MAX_BODY_BYTES) {
        return res.status(413).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'request body too large' } });
      }
      const out = await via.relay.call(via.peer, via.peerUrl, id, body, {
        ...(req.header('authorization') ? { Authorization: req.header('authorization') as string } : {}),
        ...(req.header('a2a-version') ? { 'A2A-Version': req.header('a2a-version') as string } : {}),
      });
      if ('error' in out) {
        return res.status(504).json({
          jsonrpc: '2.0', id: (req.body as { id?: unknown })?.id ?? null,
          error: { code: -32603, message: `agent did not answer: ${out.error}` },
        });
      }
      const c = calls.get(id) ?? { total: 0, last_at: null };
      calls.set(id, { total: c.total + 1, last_at: Date.now() });
      return pipeRelay(res, out);
    }
    if (rateLimited(req.ip ?? 'unknown')) {
      return res.status(429).json({ jsonrpc: '2.0', id: null, error: { code: -32029, message: 'rate limit' } });
    }
    const raw = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    if (raw.length > MAX_BODY_BYTES) {
      return res.status(413).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'request body too large' } });
    }

    /**
     * Caller attribution (SAM's `X-Peer-Id`). A call that arrives over the mesh carries a signature bound to
     * this node's address and this service; when it checks out the agent is told which node is calling, and
     * when it does not the header is REMOVED rather than passed through — an agent that trusted an inbound
     * value would be trusting whatever a stranger typed.
     */
    const callerPeer = verifySamAuth(req.header('x-ainize-auth'), cfg.identity.address, a.id);
    const r2 = await upstreamFetch(a.upstream.replace(/\/+$/, '') + '/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(callerPeer ? { 'X-Peer-Id': callerPeer } : {}),
        ...(req.header('x-sam-agent') ? { 'X-Sam-Agent': req.header('x-sam-agent') as string } : {}),
        ...(req.header('a2a-version') ? { 'A2A-Version': req.header('a2a-version') as string } : {}),
      },
      body: raw,
    });
    if (!r2.ok) {
      health.set(a.id, { reachable: false, checked_at: Date.now(), error: r2.error });
      return res.status(504).json({
        jsonrpc: '2.0', id: (req.body as { id?: unknown })?.id ?? null,
        error: { code: -32603, message: `agent did not answer: ${r2.error}` },
      });
    }
    const c = calls.get(a.id) ?? { total: 0, last_at: null };
    calls.set(a.id, { total: c.total + 1, last_at: Date.now() });
    health.set(a.id, { reachable: true, checked_at: Date.now(), card: health.get(a.id)?.card });

    /**
     * Piped, not buffered.
     *
     * This is the node's OWN agent, one hop away, and it was the last place the answer was collected in full
     * before any of it was written. An agent that reports each step it takes — and both agents here do —
     * arrived as one silent pause and then everything at once, which is what made `streaming` look like a
     * claim nobody honoured. The same helper serves the mesh path (sam.ts).
     */
    return pipeRelay(res, {
      status: r2.res.status,
      contentType: r2.res.headers.get('content-type') ?? 'application/json',
      body: r2.res.body,
    });
  };
  r.post(`${AGENT_PREFIX}/:id`, callAgent);

  return r;
}
