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

type Health = { reachable: boolean | null; checked_at: number | null; error?: string; card_name?: string };
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
        health.set(a.id, { reachable: true, checked_at: Date.now(), card_name: String(card.name ?? '') });
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
        name: h?.card_name || a.name || a.id,
        description: a.description ?? null,
        a2a_url: agentUrl(publicUrl, a.id),
        card_url: `${agentUrl(publicUrl, a.id)}/.well-known/agent-card.json`,
        reachable: h?.reachable ?? null,
        last_checked: h?.checked_at ?? null,
        error: h?.error ?? null,
        calls: c?.total ?? 0,
        last_call_at: c?.last_at ?? null,
      };
    }));
    res.json({ agents: out });
  });

  // ── the A2A surface, one prefix per agent
  r.get(`${AGENT_PREFIX}/:id{/*path}`, async (req: Request, res: Response) => {
    const id = one(req.params.id);
    const a = find(id);
    if (!a) return res.status(404).json({ error: `no agent "${id}" on this node` });
    const tail = `/${(req.params as { path?: string[] }).path?.join('/') ?? ''}`.replace(/\/+$/, '') || '/';
    if (!CARD_PATHS.includes(tail)) return res.status(404).json({ error: 'not found' });

    const { card, error } = await fetchCard(a);
    if (!card) return res.status(502).json({ error: `agent unreachable: ${error}` });
    const publicUrl = (cfg as NodeConfig & { publicUrl?: string }).publicUrl
      ?? `${req.protocol}://${req.get('host') ?? ''}`;
    // the upstream's own `url` points at localhost; a caller that trusted it would post to its own machine
    res.json({ ...card, url: agentUrl(publicUrl, a.id) });
  });

  r.post(`${AGENT_PREFIX}/:id`, async (req: Request, res: Response) => {
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

    const r2 = await upstreamFetch(a.upstream.replace(/\/+$/, '') + '/', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw,
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
    health.set(a.id, { reachable: true, checked_at: Date.now(), card_name: health.get(a.id)?.card_name });

    res.status(r2.res.status);
    res.setHeader('Content-Type', r2.res.headers.get('content-type') ?? 'application/json');
    res.send(Buffer.from(await r2.res.arrayBuffer()));
  });

  return r;
}
