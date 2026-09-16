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
import type { NodeConfig } from '@ainize/core';
import { verifySamAuth } from './sam.js';

/** One agent, as `config.json` declares it. */
export interface AgentConfig {
  /** URL segment and identity: `/agents/<id>`. Lowercase, dashes. */
  id: string;
  /** Shown in the operator's list; the card's own `name` is what a workspace displays. */
  name?: string;
  /** Where the process listens, e.g. `http://127.0.0.1:4010`. */
  upstream: string;
  /** Off by default — an agent that is not ready should not have a public address. */
  enabled?: boolean;
  description?: string;
}

export const AGENT_PREFIX = '/agents';
/**
 * The same surface, under `/api`.
 *
 * A public node is normally behind a reverse proxy, and the proxy in front of this one forwards `/api` (plus the
 * settlement and p2p prefixes) and serves everything else from the static build — so `/agents/<id>` came back as
 * the single-page app, and an A2A client reported "no name in card" while the node was answering perfectly on
 * localhost. Adding a second mount costs one line and removes a whole class of deployment that silently fails;
 * the canonical path stays `/agents/<id>`, and an operator who can edit their proxy should route it.
 *
 * The card advertises whichever prefix the request arrived on, because the only URL a client can use is the one
 * it already reached.
 */
export const API_AGENT_PREFIX = '/api/a2a';
export const AGENT_PREFIXES = [AGENT_PREFIX, API_AGENT_PREFIX];
const CARD_PATHS = ['/.well-known/agent-card.json', '/.well-known/agent.json', '/agent.json'];

const RATE = { windowMs: 60_000, perIp: 20 };
const MAX_BODY_BYTES = 200_000;
const UPSTREAM_TIMEOUT_MS = 90_000;

export const agentIdOk = (id: string) => /^[a-z0-9][a-z0-9-]{0,39}$/.test(id);

/** The public base URL of one agent — what an operator copies and a workspace is given. */
export function agentUrl(publicUrl: string | undefined, id: string, prefix: string = AGENT_PREFIX): string {
  const base = (publicUrl ?? '').replace(/\/+$/, '');
  return `${base}${prefix}/${id}`;
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

export function listAgents(cfg: NodeConfig): AgentConfig[] {
  const raw = (cfg as NodeConfig & { agents?: AgentConfig[] }).agents ?? [];
  return raw.filter((a) => a && agentIdOk(a.id) && typeof a.upstream === 'string' && a.enabled !== false);
}

export function buildAgents(cfg: NodeConfig): Router {
  const r = Router();
  const rateLimited = limiter();
  // express 5 types a wildcard param as string | string[]; an agent id is always one segment
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
  const find = (id: string) => listAgents(cfg).find((a) => a.id === id);

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
        // the same agent under `/api`, which reaches the node through a proxy that forwards only that prefix
        proxy_url: agentUrl(publicUrl, a.id, API_AGENT_PREFIX),
        reachable: h?.reachable ?? null,
        last_checked: h?.checked_at ?? null,
        error: h?.error ?? null,
        calls: c?.total ?? 0,
        last_call_at: c?.last_at ?? null,
      };
    }));
    res.json({ agents: out });
  });

  // ── the A2A surface, one prefix per agent, at every mount this node answers on
  const serveCard = (prefix: string) => async (req: Request, res: Response) => {
    const id = one(req.params.id);
    const a = find(id);
    if (!a) return res.status(404).json({ error: `no agent "${id}" on this node` });
    const tail = `/${(req.params as { path?: string[] }).path?.join('/') ?? ''}`.replace(/\/+$/, '') || '/';
    if (!CARD_PATHS.includes(tail)) return res.status(404).json({ error: 'not found' });

    const { card, error } = await fetchCard(a);
    if (!card) return res.status(502).json({ error: `agent unreachable: ${error}` });
    const publicUrl = (cfg as NodeConfig & { publicUrl?: string }).publicUrl
      ?? `${req.protocol}://${req.get('host') ?? ''}`;
    const url = agentUrl(publicUrl, a.id, prefix);
    // The upstream's own `url` points at localhost; a caller that trusted it would post to its own machine.
    // v1.0 carries the address in `supportedInterfaces` instead, and a card that keeps a stale one there sends
    // a modern client to the same dead address the legacy field used to.
    const interfaces = Array.isArray(card.supportedInterfaces)
      ? { supportedInterfaces: (card.supportedInterfaces as Record<string, unknown>[]).map((i) => ({ ...i, url })) }
      : {};
    res.json({ ...card, ...interfaces, url });
  };
  for (const prefix of AGENT_PREFIXES) r.get(`${prefix}/:id{/*path}`, serveCard(prefix));

  const callAgent = async (req: Request, res: Response) => {
    const id = one(req.params.id);
    const a = find(id);
    if (!a) return res.status(404).json({ error: `no agent "${id}" on this node` });
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

    res.status(r2.res.status);
    res.setHeader('Content-Type', r2.res.headers.get('content-type') ?? 'application/json');
    res.send(Buffer.from(await r2.res.arrayBuffer()));
  };
  for (const prefix of AGENT_PREFIXES) r.post(`${prefix}/:id`, callAgent);

  return r;
}
