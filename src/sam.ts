/**
 * SAM — agent-to-agent calls between ainize nodes, on the Sovereign Agent Mesh's wire contract.
 *
 * `agents.ts` gives one node's agents a public address. That is enough for a person with the link and not
 * enough for an agent: an agent on node A that wants node B's agent has no way to find it, no way to prove
 * who is calling, and — the part that actually stops deployments — no way for either operator to say what
 * may leave their machine. SAM (https://github.com/google/sam) is Google's answer to exactly that, and
 * rather than invent a fourth agent protocol this file speaks its shape.
 *
 * ## What is borrowed, precisely
 *
 *  - **The egress path.** `/sam/{peer}/a2a/{service}/...` — a caller always goes through its OWN node, which
 *    is the only place an operator can enforce anything.
 *  - **Card regeneration.** An agent card names the agent's own interface URLs, which are reachable on the
 *    provider's machine and nowhere else. The caller's node fetches the remote card and serves one whose
 *    interfaces point back at the mesh path, so a stock A2A client — ainteams, the a2a-js SDK, curl — works
 *    unmodified. This is the whole trick, and it is why no ainize-specific client exists.
 *  - **The labels gate.** `X-Sam-Required-Labels: key=value,key=value`, fail-closed, refused with 403 BEFORE
 *    any request body leaves the node. The caller's requirement is satisfied by ANY one attested pair; the
 *    operator's egress floor demands EVERY pair and applies even to a caller that asks for nothing — a floor
 *    the constrained party can opt out of by staying silent is not a floor.
 *  - **`X-Sam-Authentication`** for the local caller, leaving `Authorization` to mean what every HTTP client
 *    thinks it means: the credential for the destination.
 *  - **`X-Peer-Id`**, stamped by the provider after it verifies the caller, overwriting anything inbound.
 *
 * ## What is NOT borrowed, and why
 *
 * SAM's transport is libp2p and its identity is a biscuit minted by a control plane. ainize has neither, and
 * pretending otherwise would be the dangerous kind of compatibility. What it does have is a peer table, a
 * node keypair per node, and signed requests already (`x-ainize-auth`). So:
 *
 *  - The mesh hop is HTTPS between ainize nodes, not libp2p. `{peer}` is an ainize node ADDRESS, resolved
 *    through this node's own peer table — never a URL from the path, which would make this an open proxy.
 *  - A label attestation is a statement signed by a node key. It is only honoured when the signer is an
 *    authority this operator configured (`sam.labelAuthorities`), because a label a node signs about itself
 *    is a claim, not an attestation — the same distinction SAM draws, with a different root of trust. With
 *    no authority configured, any call that requires labels is refused. That is the intended failure mode.
 *
 * Divergence worth knowing: SAM refuses to regenerate a pre-1.0 agent card. This node rewrites one, because
 * its own agents serve both spellings (`supportedInterfaces` for v1.0 and a top-level `url` for v0.3) and
 * every workspace on the older dialect would otherwise be cut off from the mesh.
 */
import { Router, type Request, type Response } from 'express';
import type { NodeConfig } from '@ainize/core';
import { signMessage, verifyMessage } from '@ainize/core';
import { AGENT_PREFIX, listAgents, summariseCard, type CardSummary } from './agents.js';

export const SAM_PREFIX = '/sam';
export const SERVICE_TYPE_A2A = 'a2a';
export const HEADER_REQUIRED_LABELS = 'x-sam-required-labels';
export const HEADER_AUTHENTICATION = 'x-sam-authentication';
export const HEADER_PEER_ID = 'x-peer-id';
export const HEADER_AGENT = 'x-sam-agent';
const CARD_PATH = '.well-known/agent-card.json';
const MAX_CARD_BYTES = 1 << 20;
const MAX_BODY_BYTES = 200_000;
const EGRESS_TIMEOUT_MS = 90_000;
const CARD_TIMEOUT_MS = 10_000;
/** How long a positive label verdict is reused before the peer's attestation is fetched again (SAM: 5 min). */
export const LABEL_GATE_TTL_MS = 5 * 60_000;
const ATTESTATION_TTL_MS = 60 * 60_000;

/** What `config.json` may say about this node's place in the mesh. Every field is optional; absent is off. */
export interface SamConfig {
  /** false turns the mesh routes off entirely. */
  enabled?: boolean;
  /** What this node declares about itself, e.g. `{ region: 'kr', jurisdiction: 'kr' }`. */
  labels?: Record<string, string>;
  /** Addresses whose signature over a label set this node believes. Empty = no label requirement can pass. */
  labelAuthorities?: string[];
  /**
   * Accept a peer's signature over its OWN labels. Off by default and deliberately so: it turns the gate from
   * "a party I trust said so" into "the party being checked said so", which is a routing hint, not a control.
   */
  trustSelfAttestedLabels?: boolean;
  /** The operator's floor: EVERY pair must be attested by the provider, whatever the caller asked for. */
  egressRequireLabels?: Record<string, string>;
}

export const samConfig = (cfg: NodeConfig): SamConfig => (cfg as NodeConfig & { sam?: SamConfig }).sam ?? {};

/* ------------------------------------------------------------------ labels (api/labels.go) */

const LABEL_KEY = /^[a-zA-Z0-9_.-]{1,63}$/;
const MAX_LABEL_VALUE = 255;

export function validateLabelKey(key: string): string | null {
  return LABEL_KEY.test(key) ? null : `invalid label key "${key}": must be 1-63 chars of [a-zA-Z0-9_.-]`;
}

export function validateLabelValue(value: string): string | null {
  if (!value) return 'label value must not be empty';
  if (value.length > MAX_LABEL_VALUE) return `label value "${value}" exceeds ${MAX_LABEL_VALUE} characters`;
  // the wire format is comma-separated key=value, so a value carrying either separator could forge a pair
  if (/[,=\n\r\t]/.test(value)) return `label value "${value}" must not contain ',', '=', or control characters`;
  return null;
}

export function validateLabels(labels: Record<string, string>): string | null {
  for (const k of Object.keys(labels).sort()) {
    const e = validateLabelKey(k) ?? validateLabelValue(labels[k]);
    if (e) return e;
  }
  return null;
}

/**
 * Parse `X-Sam-Required-Labels`.
 *
 * Blank means no requirement. A header that carries content but names no label — `,,` — is an ERROR, not an
 * empty requirement: an empty set switches the gate off, so reading a caller's malformed input as one would
 * turn a fail-closed control into a fail-open one. A trailing comma beside real pairs stays harmless.
 */
export function parseRequiredLabels(header: string | undefined): { labels: Record<string, string> } | { error: string } {
  if (!header || !header.trim()) return { labels: {} };
  const out: Record<string, string> = {};
  for (const raw of header.split(',')) {
    const part = raw.trim();
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq < 0) return { error: `invalid label "${part}": expected key=value` };
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    const e = validateLabelKey(k) ?? validateLabelValue(v);
    if (e) return { error: e };
    if (k in out) return { error: `duplicate label key "${k}"` };
    out[k] = v;
  }
  if (!Object.keys(out).length) return { error: `invalid required labels "${header}": expected at least one key=value pair` };
  return { labels: out };
}

/** The caller's requirement: ANY one attested pair satisfies it. Matching is exact and case-sensitive. */
export const satisfiesRequirement = (attested: Record<string, string>, required: Record<string, string>): boolean =>
  Object.keys(required).length === 0 || Object.entries(required).some(([k, v]) => attested[k] === v);

/** The operator's floor: EVERY pair must be attested. Checked separately so the caller's pairs cannot stand in. */
export const satisfiesFloor = (attested: Record<string, string>, floor: Record<string, string>): boolean =>
  Object.entries(floor).every(([k, v]) => attested[k] === v);

/* ------------------------------------------------------------------ attestation */

export interface LabelAttestation {
  /** The node the labels are about. */
  subject: string;
  labels: Record<string, string>;
  issued_at: number;
  expires_at: number;
  /** Who signed. Equal to `subject` for a self-attestation, which most operators should not trust. */
  issuer: string;
  signature: string;
}

/**
 * The exact bytes that are signed. Canonical — keys sorted, one shape — because a signature over a rendering
 * that depends on map order verifies or not depending on which process built the string.
 */
export function attestationPayload(a: Pick<LabelAttestation, 'subject' | 'labels' | 'issued_at' | 'expires_at'>): string {
  const pairs = Object.keys(a.labels).sort().map((k) => `${k}=${a.labels[k]}`).join('|');
  return `sam:labels:${a.subject}:${a.issued_at}:${a.expires_at}:${pairs}`;
}

export function signAttestation(subject: string, labels: Record<string, string>, identity: { address: string; privateKey: string }, now = Date.now()): LabelAttestation {
  const body = { subject, labels, issued_at: now, expires_at: now + ATTESTATION_TTL_MS };
  return { ...body, issuer: identity.address, signature: signMessage(attestationPayload(body), identity.privateKey) };
}

/**
 * Verify one attestation against this operator's trust settings.
 *
 * Fail-closed at every step: an attestation about a different node, an expired one, one signed by a key the
 * operator never named, or one whose signature does not check out yields no labels at all — never a partial
 * set, which would silently weaken a requirement.
 */
export function verifyAttestation(
  att: unknown,
  opts: { peer: string; authorities: string[]; trustSelf?: boolean; now?: number },
): { labels: Record<string, string> } | { error: string } {
  const a = att as LabelAttestation | null;
  if (!a || typeof a !== 'object' || typeof a.signature !== 'string' || typeof a.issuer !== 'string') {
    return { error: 'no label attestation' };
  }
  if (a.subject !== opts.peer) return { error: `attestation is about ${a.subject}, not ${opts.peer}` };
  const now = opts.now ?? Date.now();
  if (!Number.isFinite(a.expires_at) || a.expires_at < now) return { error: 'attestation expired' };
  if (!Number.isFinite(a.issued_at) || a.issued_at > now + 60_000) return { error: 'attestation is issued in the future' };
  const labels = a.labels && typeof a.labels === 'object' ? a.labels : null;
  if (!labels) return { error: 'attestation carries no labels' };
  const bad = validateLabels(labels);
  if (bad) return { error: bad };
  const trusted = new Set(opts.authorities);
  const selfSigned = a.issuer === a.subject;
  if (!trusted.has(a.issuer) && !(selfSigned && opts.trustSelf)) {
    return {
      error: selfSigned
        ? `${a.subject} attests its own labels and this node does not accept self-attestation (sam.trustSelfAttestedLabels)`
        : `${a.issuer} is not a label authority this node accepts (sam.labelAuthorities)`,
    };
  }
  if (!verifyMessage(attestationPayload(a), a.signature, a.issuer)) return { error: 'attestation signature does not verify' };
  return { labels };
}

/* ------------------------------------------------------------------ card regeneration */

const HTTP_BINDINGS = new Set(['JSONRPC', 'HTTP+JSON', 'HTTP_JSON', 'HTTPJSON', 'JSON-RPC']);
const carriable = (transport: unknown): boolean =>
  typeof transport === 'string' && HTTP_BINDINGS.has(transport.toUpperCase().replace(/\s/g, ''));

/**
 * Rebuild a fetched agent card so a stock client can follow it through this node.
 *
 * Interface URLs point back at the mesh path; bindings the hop cannot carry (gRPC needs its own end-to-end
 * connection) are dropped; streaming is advertised off, because the mesh hop does not forward a stream; and
 * signatures go, since they were made over the card as the provider wrote it and no longer match the bytes.
 * The required list fields stay arrays — `null` is what strict SDK card parsers reject.
 */
export function regenerateCard(card: unknown, base: string): { card: Record<string, unknown> } | { error: string } {
  if (!card || typeof card !== 'object') return { error: 'agent card is not an object' };
  const c = { ...(card as Record<string, unknown>) };

  const ifaces = Array.isArray(c.supportedInterfaces) ? (c.supportedInterfaces as Record<string, unknown>[]) : [];
  const kept = ifaces.filter((i) => i && carriable(i.protocolBinding ?? i.transport)).map((i) => ({ ...i, url: base }));
  // v0.3 spells the same thing as a top-level `url` plus `preferredTransport`; ainize agents serve both, and a
  // workspace on the older dialect is exactly the caller this is for. SAM refuses these; we rewrite them.
  const legacy = 'url' in c || 'preferredTransport' in c;
  const legacyOk = !('preferredTransport' in c) || carriable(c.preferredTransport);
  if (!kept.length && !(legacy && legacyOk)) {
    return { error: 'agent card advertises no interface the mesh can carry (JSONRPC or HTTP+JSON)' };
  }
  if (ifaces.length) c.supportedInterfaces = kept;
  if (legacy) c.url = base;
  // v0.3 `additionalInterfaces` carries the same rewrite-or-drop rule as v1.0's supportedInterfaces
  if (Array.isArray(c.additionalInterfaces)) {
    c.additionalInterfaces = (c.additionalInterfaces as Record<string, unknown>[])
      .filter((i) => i && carriable(i.transport ?? i.protocolBinding)).map((i) => ({ ...i, url: base }));
  }
  const caps = (c.capabilities && typeof c.capabilities === 'object' ? { ...(c.capabilities as Record<string, unknown>) } : {});
  caps.streaming = false;
  c.capabilities = caps;
  delete c.signatures;
  if (!Array.isArray(c.skills)) c.skills = [];
  if (!Array.isArray(c.defaultInputModes)) c.defaultInputModes = [];
  if (!Array.isArray(c.defaultOutputModes)) c.defaultOutputModes = [];
  return { card: c };
}

/** The mesh URL of one remote agent, as served by THIS node. */
export const meshUrl = (selfUrl: string, peer: string, service: string): string =>
  `${selfUrl.replace(/\/+$/, '')}${SAM_PREFIX}/${peer}/${SERVICE_TYPE_A2A}/${service}`;

/* ------------------------------------------------------------------ the routes */

export interface SamDeps {
  cfg: NodeConfig;
  identity: { address: string; privateKey: string };
  /** Peers this node knows, as the peer table holds them. */
  peers: () => { address: string | null; endpoint: string }[];
  selfUrl: () => string;
  log?: (level: 'debug' | 'info' | 'warn' | 'error', kind: string, message: string, data?: unknown) => void;
}

interface Verdict { until: number }

export function buildSam(deps: SamDeps): Router {
  const r = Router();
  const gate = new Map<string, Verdict>();
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
  const sam = () => samConfig(deps.cfg);
  const selfUrl = () => deps.selfUrl().replace(/\/+$/, '');

  /** Where a peer address actually lives. Never a URL from the path — that would make this an open proxy. */
  const resolvePeer = (peer: string): string | null => {
    if (peer === deps.identity.address) return selfUrl();
    for (const p of deps.peers()) if (p.address && p.address === peer) return p.endpoint.replace(/\/+$/, '');
    return null;
  };

  /**
   * The gate, run before any request body leaves. Returns null when the call may proceed, or the HTTP error
   * to send. Positive verdicts are cached per (peer, requirement, floor) — a verdict under one floor says
   * nothing about another, so the floor is part of the key.
   */
  const labelGate = async (peer: string, peerUrl: string, header: string | undefined): Promise<{ status: number; body: string } | null> => {
    const parsed = parseRequiredLabels(header);
    if ('error' in parsed) return { status: 400, body: `Invalid X-Sam-Required-Labels header: ${parsed.error}` };
    const required = parsed.labels;
    const floor = sam().egressRequireLabels ?? {};
    if (!Object.keys(required).length && !Object.keys(floor).length) return null;

    const key = `${peer}|${Object.keys(required).sort().map((k) => `${k}=${required[k]}`).join('|')}#floor|${Object.keys(floor).sort().map((k) => `${k}=${floor[k]}`).join('|')}`;
    const hit = gate.get(key);
    if (hit && hit.until > Date.now()) return null;

    let att: unknown = null;
    try {
      const res = await fetch(`${peerUrl}${SAM_PREFIX}/attestation`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(CARD_TIMEOUT_MS) });
      att = res.ok ? await res.json() : null;
    } catch (e) {
      deps.log?.('warn', 'sam', `label attestation of ${peer} unfetchable: ${(e as Error).message}`);
    }
    const verified = verifyAttestation(att, { peer, authorities: sam().labelAuthorities ?? [], trustSelf: sam().trustSelfAttestedLabels });
    if ('error' in verified) {
      deps.log?.('warn', 'sam', `label gate refused egress to ${peer}: ${verified.error}`);
      return { status: 403, body: 'Required labels not attested by provider' };
    }
    if (!satisfiesRequirement(verified.labels, required) || !satisfiesFloor(verified.labels, floor)) {
      deps.log?.('warn', 'sam', `label gate refused egress to ${peer}: attested ${JSON.stringify(verified.labels)} does not meet ${JSON.stringify(required)} / floor ${JSON.stringify(floor)}`);
      return { status: 403, body: 'Required labels not attested by provider' };
    }
    gate.set(key, { until: Date.now() + LABEL_GATE_TTL_MS });
    return null;
  };

  const enabled = () => sam().enabled !== false;

  // ── provider side: what this node says about itself, and what it offers the mesh
  r.get(`${SAM_PREFIX}/labels`, (_req, res) => {
    res.json({ subject: deps.identity.address, labels: sam().labels ?? {} });
  });

  /**
   * This node's labels, signed. Self-signed by construction — this node is the only key it has — so a caller
   * accepts it only by naming this address in its own `sam.labelAuthorities`, or by switching self-attestation
   * on. Served rather than withheld: the decision belongs to the operator being protected, not to this one.
   */
  r.get(`${SAM_PREFIX}/attestation`, (_req, res) => {
    const labels = sam().labels ?? {};
    if (!Object.keys(labels).length) return res.status(404).json({ error: 'this node declares no labels' });
    res.json(signAttestation(deps.identity.address, labels, deps.identity));
  });

  /** Discovery, the mesh's `discover_remote_services(type: a2a)` shape. */
  r.get(`${SAM_PREFIX}/services`, async (req: Request, res: Response) => {
    const type = String(req.query.type ?? SERVICE_TYPE_A2A);
    if (type !== SERVICE_TYPE_A2A) return res.json({ peer: deps.identity.address, services: [] });
    const services = listAgents(deps.cfg).map((a) => ({
      type: SERVICE_TYPE_A2A,
      name: a.id,
      display_name: a.name ?? a.id,
      description: a.description ?? null,
      url: `${selfUrl()}${AGENT_PREFIX}/${a.id}`,
    }));
    res.json({ peer: deps.identity.address, labels: sam().labels ?? {}, services });
  });

  // ── caller side: the egress path
  const routeOf = (req: Request) => ({ peer: one(req.params.peer), service: one(req.params.service) });

  /**
   * Card regeneration. Served at the well-known path AND at the bare service root, because resolvers disagree
   * about which one a pathful base URL means, and a client that guesses wrong gets an HTML page from the SPA.
   */
  const serveCard = async (req: Request, res: Response) => {
    if (!enabled()) return res.status(404).json({ error: 'the mesh is switched off on this node (sam.enabled)' });
    const { peer, service } = routeOf(req);
    const peerUrl = resolvePeer(peer);
    if (!peerUrl) return res.status(404).json({ error: `peer "${peer}" is not in this node's peer table` });
    let card: unknown = null;
    try {
      const upstream = await fetch(`${peerUrl}${AGENT_PREFIX}/${service}/${CARD_PATH}`, {
        headers: { Accept: 'application/json', ...(req.header('a2a-version') ? { 'A2A-Version': req.header('a2a-version') as string } : {}) },
        signal: AbortSignal.timeout(CARD_TIMEOUT_MS),
      });
      if (!upstream.ok) {
        // the agent's own error is the useful one; relay the status rather than masking it as a mesh failure
        return res.status(upstream.status).json({ error: `agent card of "${service}" on ${peer}: HTTP ${upstream.status}` });
      }
      const text = (await upstream.text()).slice(0, MAX_CARD_BYTES);
      card = JSON.parse(text);
    } catch (e) {
      deps.log?.('warn', 'sam', `agent card fetch from ${peer} failed: ${(e as Error).message}`);
      return res.status(502).json({ error: `Bad Gateway: agent card fetch failed (${(e as Error).message})` });
    }
    const out = regenerateCard(card, meshUrl(selfUrl(), peer, service));
    if ('error' in out) return res.status(502).json({ error: `Bad Gateway: ${out.error}` });
    res.json(out.card);
  };

  r.get(`${SAM_PREFIX}/:peer/${SERVICE_TYPE_A2A}/:service`, serveCard);
  r.get(`${SAM_PREFIX}/:peer/${SERVICE_TYPE_A2A}/:service/.well-known/agent-card.json`, serveCard);
  r.get(`${SAM_PREFIX}/:peer/${SERVICE_TYPE_A2A}/:service/.well-known/agent.json`, serveCard);

  /** The call itself. Gate first, forward second — the order is the feature. */
  r.post(`${SAM_PREFIX}/:peer/${SERVICE_TYPE_A2A}/:service`, async (req: Request, res: Response) => {
    if (!enabled()) return res.status(404).json({ error: 'the mesh is switched off on this node (sam.enabled)' });
    const { peer, service } = routeOf(req);
    const peerUrl = resolvePeer(peer);
    if (!peerUrl) return res.status(404).json({ error: `peer "${peer}" is not in this node's peer table` });

    const refusal = await labelGate(peer, peerUrl, req.header(HEADER_REQUIRED_LABELS));
    if (refusal) return res.status(refusal.status).type('text/plain').send(refusal.body);

    const raw = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    if (raw.length > MAX_BODY_BYTES) {
      return res.status(413).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'request body too large' } });
    }
    const target = `${peerUrl}${AGENT_PREFIX}/${service}`;
    try {
      const upstream = await fetch(target, {
        method: 'POST',
        body: raw,
        headers: {
          'Content-Type': 'application/json',
          // signed and bound to this exact target: a captured header is useless against another agent
          'x-ainize-auth': samAuthHeader(deps.identity, peer, service),
          // the local credential never leaves the node; Authorization stays the destination's to use
          ...(req.header('authorization') ? { Authorization: req.header('authorization') as string } : {}),
          ...(req.header(HEADER_AGENT) ? { 'X-Sam-Agent': req.header(HEADER_AGENT) as string } : {}),
          ...(req.header('a2a-version') ? { 'A2A-Version': req.header('a2a-version') as string } : {}),
        },
        signal: AbortSignal.timeout(EGRESS_TIMEOUT_MS),
      });
      res.status(upstream.status);
      res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'application/json');
      res.send(Buffer.from(await upstream.arrayBuffer()));
    } catch (e) {
      deps.log?.('warn', 'sam', `egress to ${peer}/${service} failed: ${(e as Error).message}`);
      res.status(504).json({
        jsonrpc: '2.0', id: (req.body as { id?: unknown })?.id ?? null,
        error: { code: -32603, message: `agent did not answer: ${(e as Error).message}` },
      });
    }
  });

  /**
   * Every agent this node can reach — its own, plus one row per agent on every peer that answers. This is what
   * puts a peer's agents in the marketplace: without it a visitor sees only the agents of whichever node they
   * happen to have opened.
   */
  r.get('/api/sam/agents', async (_req: Request, res: Response) => {
    const rows = await Promise.all(deps.peers().map(async (p) => {
      if (!p.address || p.address === deps.identity.address) return [];
      try {
        const r2 = await fetch(`${p.endpoint.replace(/\/+$/, '')}${SAM_PREFIX}/services?type=a2a`, {
          headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(CARD_TIMEOUT_MS),
        });
        if (!r2.ok) return [];
        const body = await r2.json() as { peer?: string; labels?: Record<string, string>; services?: { name: string; display_name?: string; description?: string | null }[] };
        return (body.services ?? []).map((s) => ({
          peer: p.address as string,
          peer_endpoint: p.endpoint,
          labels: body.labels ?? {},
          id: s.name,
          name: s.display_name ?? s.name,
          description: s.description ?? null,
          // the address a client is given is on THIS node, which is the point of the mesh path
          a2a_url: meshUrl(selfUrl(), p.address as string, s.name),
          card_url: `${meshUrl(selfUrl(), p.address as string, s.name)}/${CARD_PATH}`,
        }));
      } catch { return []; }
    }));
    res.json({ agents: rows.flat() });
  });

  return r;
}

/** The egress signature, bound to the peer and service it is for (SAM's peer-bound challenge, ainize's keys). */
export const samAuthHeader = (identity: { address: string; privateKey: string }, peer: string, service: string): string => {
  const ts = Date.now();
  return `${identity.address}:${ts}:${signMessage(samAuthPurpose(peer, service, ts), identity.privateKey)}`;
};
export const samAuthPurpose = (peer: string, service: string, ts: number): string => `sam:${peer}/${SERVICE_TYPE_A2A}/${service}:${ts}`;

/** The provider side of the same signature — returns the caller's address, or null. */
export function verifySamAuth(header: string | undefined, peer: string, service: string, maxSkewMs = 5 * 60_000): string | null {
  if (!header) return null;
  const [address, tsStr, sig] = header.split(':');
  const ts = Number(tsStr);
  if (!address || !sig || !Number.isFinite(ts) || Math.abs(Date.now() - ts) > maxSkewMs) return null;
  return verifyMessage(samAuthPurpose(peer, service, ts), sig, address) ? address : null;
}

export type { CardSummary };
