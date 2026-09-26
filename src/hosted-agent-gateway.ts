/**
 * The only door out of a hosted agent: its model, and the public internet it was allowed.
 *
 * A hosted agent holds a token, minted when its runtime starts and forgotten when it stops. Every request names
 * the token in its path (`/t/<token>/…`) so that a stock OpenAI client given `…/t/<token>/v1` as its base URL
 * works unmodified. The gateway, not the agent, decides:
 *
 *   • which model answers — always the spec's, whatever the request says;
 *   • whether speech and image models answer at all — only for an agent whose spec turned them on. This node's
 *     own backend when it has one, through the same per-GPU gate the paid and free surfaces queue in; otherwise
 *     a peer that serves the modality, called over p2p with this node's key (peer-models.ts);
 *   • which hosts answer — the spec's `allowedHosts`, and never a private, loopback, link-local or otherwise
 *     non-public address. The check runs in the socket's own DNS lookup, so the address that is checked is the
 *     address that is connected to (a name that resolves public for the check and private for the connection —
 *     DNS rebinding — is refused), and again on every redirect hop, which the gateway follows itself.
 *
 * It listens on loopback for in-process agents and on the Docker bridge gateway address for containers, never on
 * a public interface: a container on the internal network can reach this and nothing else.
 */
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP, type AddressInfo, type LookupFunction } from 'node:net';
import { randomBytes } from 'node:crypto';
import type { InferenceBackend, InferenceBackendRegistry } from './inference-backends.js';
import type { ModalityGate } from './modality-gate.js';
import { hostedAgentMediaOf, type HostedAgentSpec } from './hosted-agent-types.js';
import { PeerModelCallError, type PeerModelModality, type PeerModelTarget } from './peer-models.js';

const HOSTED_AGENT_EGRESS_MAX_BYTES = 5 * 1024 * 1024;
const HOSTED_AGENT_EGRESS_TIMEOUT_MS = 30_000;
const HOSTED_AGENT_EGRESS_MAX_REDIRECTS = 5;
const HOSTED_AGENT_GATEWAY_MAX_BODY = 6 * 1024 * 1024;
const HOSTED_AGENT_LLM_TIMEOUT_MS = 120_000;
/** A diffusion model at full steps takes tens of seconds; a long voice note, about as long. */
const HOSTED_AGENT_MEDIA_TIMEOUT_MS = 180_000;
/** Kept low: an agent turn waits on this, and the paid surface is where many steps are bought. */
const HOSTED_AGENT_IMAGE_MAX_STEPS = 30;

/** Everything that is not the public internet. */
const hostedAgentNonPublic = (() => {
  const b = new BlockList();
  for (const [net, bits] of [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
    ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
    ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
  ] as const) b.addSubnet(net, bits, 'ipv4');
  for (const [net, bits] of [
    ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32], ['100::', 64],
  ] as const) b.addSubnet(net, bits, 'ipv6');
  return b;
})();

/** Is this address on the public internet? IPv4-mapped and NAT64 IPv6 are judged by the IPv4 inside them. */
export function hostedAgentAddressIsPublic(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !hostedAgentNonPublic.check(address, 'ipv4');
  if (family !== 6) return false;
  const lower = address.toLowerCase();
  const embedded = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (embedded) return hostedAgentAddressIsPublic(embedded[1]!);
  if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(lower)) return false;
  return !hostedAgentNonPublic.check(lower, 'ipv6');
}

/** Does a host match an allowlist of names, `*.suffix` wildcards and `*`? */
export function hostedAgentHostAllowed(host: string, allowed: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return allowed.some((pattern) => {
    if (pattern === '*') return true;
    if (pattern.startsWith('*.')) return h.endsWith(pattern.slice(1)) && h.length > pattern.length - 1;
    return h === pattern;
  });
}

class HostedAgentEgressRefusal extends Error {}

/** A DNS lookup that refuses to hand the socket anything but public addresses. */
const hostedAgentPublicLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return (callback as (e: Error | null, a: string, f: number) => void)(err, '', 0);
    const list = addresses as unknown as LookupAddress[];
    const bad = list.find((a) => !hostedAgentAddressIsPublic(a.address));
    if (bad || !list.length) {
      return (callback as (e: Error | null, a: string, f: number) => void)(new HostedAgentEgressRefusal(`${hostname} resolves to a non-public address`), '', 0);
    }
    if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
    (callback as (e: null, a: string, f: number) => void)(null, list[0]!.address, list[0]!.family);
  });
};

export interface HostedAgentEgressRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  bodyBase64?: string;
}

/** Hop-by-hop and identity headers an agent may not set on the way out. */
const HOSTED_AGENT_EGRESS_DROPPED_HEADERS = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'proxy-authorization', 'proxy-connection', 'upgrade', 'te', 'keep-alive']);

interface HostedAgentEgressAnswer { status: number; headers: Record<string, string>; body: Buffer; finalUrl: string }

/** One request, following redirects itself so each hop is checked. */
/**
 * Who is fetching, when the agent's code does not say. A host that hands out capability links (aindrive's file
 * handoff logs every open) can then tell which agent opened one, rather than a blank user agent from Node.
 */
export const hostedAgentUserAgent = (agentId: string) => `ainize-agent/${agentId} (+https://ainize.ai/agents/${agentId})`;

export async function hostedAgentEgress(req: HostedAgentEgressRequest, allowedHosts: string[], agentId?: string): Promise<HostedAgentEgressAnswer> {
  let url: URL;
  try { url = new URL(req.url); } catch { throw new HostedAgentEgressRefusal(`not a URL: ${req.url}`); }
  let method = (req.method ?? 'GET').toUpperCase();
  let body = req.bodyBase64 ? Buffer.from(req.bodyBase64, 'base64') : undefined;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers ?? {})) if (!HOSTED_AGENT_EGRESS_DROPPED_HEADERS.has(k.toLowerCase())) headers[k] = v;
  if (agentId && !Object.keys(headers).some((k) => k.toLowerCase() === 'user-agent')) headers['user-agent'] = hostedAgentUserAgent(agentId);

  for (let hop = 0; hop <= HOSTED_AGENT_EGRESS_MAX_REDIRECTS; hop++) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new HostedAgentEgressRefusal(`only http and https are allowed, not ${url.protocol}`);
    if (url.username || url.password) throw new HostedAgentEgressRefusal('credentials in the URL are not allowed; use a header');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host)) throw new HostedAgentEgressRefusal(`${host} is an address; allowed hosts are names`);
    if (!hostedAgentHostAllowed(host, allowedHosts)) throw new HostedAgentEgressRefusal(`${host} is not in this agent's allowed hosts`);

    const answer = await new Promise<HostedAgentEgressAnswer>((resolve, reject) => {
      const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
      const out = send(url, { method, headers: { ...headers, ...(body ? { 'content-length': String(body.length) } : {}) }, lookup: hostedAgentPublicLookup, timeout: HOSTED_AGENT_EGRESS_TIMEOUT_MS }, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > HOSTED_AGENT_EGRESS_MAX_BYTES) { res.destroy(new HostedAgentEgressRefusal(`response is larger than ${HOSTED_AGENT_EGRESS_MAX_BYTES} bytes`)); return; }
          chunks.push(c);
        });
        res.on('error', reject);
        res.on('end', () => {
          const h: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) h[k] = Array.isArray(v) ? v.join(', ') : v;
          resolve({ status: res.statusCode ?? 502, headers: h, body: Buffer.concat(chunks), finalUrl: url.href });
        });
      });
      out.on('timeout', () => out.destroy(new HostedAgentEgressRefusal('upstream timed out')));
      out.on('error', reject);
      out.end(body);
    });

    const location = answer.headers.location;
    if (answer.status >= 300 && answer.status < 400 && location) {
      url = new URL(location, url);
      if (answer.status === 303 || ((answer.status === 301 || answer.status === 302) && method === 'POST')) { method = 'GET'; body = undefined; }
      continue;
    }
    return answer;
  }
  throw new HostedAgentEgressRefusal(`more than ${HOSTED_AGENT_EGRESS_MAX_REDIRECTS} redirects`);
}

export interface HostedAgentGatewayDeps {
  registry: () => InferenceBackendRegistry | null;
  /** The per-backend queues server.ts builds for the `/v1` surface and the free tier. Absent → no queueing. */
  gates?: (backendId: string) => ModalityGate | undefined;
  /** Models on other nodes, for a modality this node has no backend of its own for. Absent → local only. */
  peerModels?: {
    target(modality: PeerModelModality): PeerModelTarget | null;
    call(target: PeerModelTarget, modality: PeerModelModality, body: unknown): Promise<unknown>;
  };
  spec: (agentId: string) => HostedAgentSpec | null;
  log: (message: string) => void;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > HOSTED_AGENT_GATEWAY_MAX_BODY) throw new HostedAgentEgressRefusal('request body too large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

const sendJson = (res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...extra });
  res.end(JSON.stringify(body));
};

export class HostedAgentGateway {
  private readonly tokens = new Map<string, string>();
  private readonly servers: Server[] = [];
  private readonly urls = new Map<string, string>();

  constructor(private readonly deps: HostedAgentGatewayDeps) {}

  /** A fresh token for one runtime start. The old one keeps working until it is revoked. */
  issue(agentId: string): string {
    const token = randomBytes(24).toString('hex');
    this.tokens.set(token, agentId);
    return token;
  }

  revoke(token: string): void {
    this.tokens.delete(token);
  }

  revokeAgent(agentId: string): void {
    for (const [t, id] of this.tokens) if (id === agentId) this.tokens.delete(t);
  }

  /** Listen on one address (loopback, or a bridge gateway). Returns the base URL a runtime there should use. */
  async listen(host: string): Promise<string> {
    const known = this.urls.get(host);
    if (known) return known;
    const server = createServer((req, res) => { void this.handle(req, res); });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, host, () => resolve()); });
    this.servers.push(server);
    const { port } = server.address() as AddressInfo;
    const url = `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
    this.urls.set(host, url);
    return url;
  }

  async close(): Promise<void> {
    await Promise.all(this.servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
    this.servers.length = 0;
    this.urls.clear();
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const m = /^\/t\/([0-9a-f]{48})(\/.*)$/.exec((req.url ?? '').split('?')[0] ?? '');
    const agentId = m ? this.tokens.get(m[1]!) : undefined;
    const spec = agentId ? this.deps.spec(agentId) : null;
    if (!m || !spec) return sendJson(res, 401, { error: { message: 'unknown or expired agent token' } });
    const path = m[2]!;
    try {
      if (req.method === 'POST' && path === '/v1/chat/completions') return await this.llm(req, res, spec);
      if (req.method === 'GET' && path === '/v1/models') return sendJson(res, 200, { object: 'list', data: [{ id: spec.model, object: 'model', owned_by: 'ainize' }] });
      if (req.method === 'POST' && path === '/egress') return await this.egress(req, res, spec);
      if (req.method === 'POST' && path === '/v1/audio/transcriptions') return await this.transcribe(req, res, spec);
      if (req.method === 'POST' && path === '/v1/images/generations') return await this.image(req, res, spec);
      sendJson(res, 404, { error: { message: 'not found' } });
    } catch (e) {
      if (!res.headersSent) sendJson(res, 502, { error: { message: e instanceof Error ? e.message : String(e) } });
      else res.destroy();
    }
  }

  /** The agent's model, and only it. Streaming is passed through as the backend sends it. */
  private async llm(req: IncomingMessage, res: ServerResponse, spec: HostedAgentSpec): Promise<void> {
    const backend = this.deps.registry()?.backendForModel(spec.model);
    if (!backend) return sendJson(res, 503, { error: { message: `this node no longer serves ${spec.model}`, code: 'model_not_served' } });
    let body: Record<string, unknown>;
    try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}') as Record<string, unknown>; } catch { return sendJson(res, 400, { error: { message: 'body is not JSON' } }); }
    const upstream = await fetch(`${backend.upstream.replace(/\/+$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, model: spec.model }),
      signal: AbortSignal.timeout(HOSTED_AGENT_LLM_TIMEOUT_MS),
    });
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
    if (!upstream.body) { res.end(); return; }
    for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk);
    res.end();
  }

  /**
   * Where a medium this agent may use runs, or the refusal already sent: this node's first backend of the
   * modality when it has one — an agent names what it wants done, not which model does it — and otherwise the
   * freshest peer that advertised one.
   */
  private mediaRoute(res: ServerResponse, spec: HostedAgentSpec, modality: PeerModelModality):
    { local: InferenceBackend; peer?: undefined } | { local?: undefined; peer: PeerModelTarget } | null {
    if (!hostedAgentMediaOf(spec)[modality]) {
      sendJson(res, 403, { error: { message: `${modality} is not turned on for this agent`, code: 'media_not_enabled' } });
      return null;
    }
    const local = this.deps.registry()?.backendsFor(modality)[0];
    if (local) return { local };
    const peer = this.deps.peerModels?.target(modality);
    if (peer) return { peer };
    sendJson(res, 503, { error: { message: `no node in reach serves a ${modality} model right now`, code: 'model_not_served' } });
    return null;
  }

  /** Through the backend's gate when there is one, attributed to the agent's owner — the queue is per address. */
  private queued<T>(backend: InferenceBackend, spec: HostedAgentSpec, cost: number, fn: () => Promise<T>): Promise<T> {
    const gate = this.deps.gates?.(backend.id);
    return gate ? gate.run(fn, { address: spec.owner, cost: Math.max(1, cost) }) : fn();
  }

  /** A peer's answer, or its refusal passed on with the peer named — an agent's owner debugging this needs both. */
  private async viaPeer(res: ServerResponse, spec: HostedAgentSpec, target: PeerModelTarget, modality: PeerModelModality, body: unknown): Promise<void> {
    try {
      const answer = await this.deps.peerModels!.call(target, modality, body);
      this.deps.log(`agent ${spec.id} ${modality} served by peer ${target.name ?? target.address}`);
      sendJson(res, 200, answer);
    } catch (e) {
      const status = e instanceof PeerModelCallError && e.status >= 400 && e.status < 600 ? e.status : 502;
      sendJson(res, status === 401 || status === 403 ? 502 : status, { error: { message: e instanceof Error ? e.message : String(e), code: 'peer_failed' } });
    }
  }

  /**
   * Speech to text. JSON in (`bytesBase64`, `name`, `mimeType`, optional `language`) rather than multipart: the
   * runtime already holds the audio as base64 from the A2A part or the handoff link, and a peer takes the same
   * JSON, so the body goes on unchanged whichever node runs it.
   */
  private async transcribe(req: IncomingMessage, res: ServerResponse, spec: HostedAgentSpec): Promise<void> {
    const route = this.mediaRoute(res, spec, 'transcription');
    if (!route) return;
    let ask: { bytesBase64?: unknown; name?: unknown; mimeType?: unknown; language?: unknown };
    try { ask = JSON.parse((await readBody(req)).toString('utf8') || '{}') as typeof ask; } catch { return sendJson(res, 400, { error: { message: 'body is not JSON' } }); }
    if (typeof ask.bytesBase64 !== 'string' || !ask.bytesBase64) return sendJson(res, 400, { error: { message: 'bytesBase64 is required' } });
    const clean = {
      bytesBase64: ask.bytesBase64,
      name: typeof ask.name === 'string' ? ask.name : 'audio',
      mimeType: typeof ask.mimeType === 'string' ? ask.mimeType : 'application/octet-stream',
      ...(typeof ask.language === 'string' && ask.language ? { language: ask.language } : {}),
    };
    if (route.peer) return this.viaPeer(res, spec, route.peer, 'transcription', clean);
    const backend = route.local;
    const audio = Buffer.from(clean.bytesBase64, 'base64');
    const answer = await this.queued(backend, spec, Math.round(audio.length / 1024), async () => {
      const form = new FormData();
      form.set('model', backend.models[0]!);
      form.set('file', new Blob([new Uint8Array(audio)], { type: clean.mimeType }), clean.name);
      if (clean.language) form.set('language', clean.language);
      const upstream = await fetch(`${backend.upstream.replace(/\/+$/, '')}/v1/audio/transcriptions`, { method: 'POST', body: form, signal: AbortSignal.timeout(HOSTED_AGENT_MEDIA_TIMEOUT_MS) });
      const body = await upstream.json().catch(() => null) as { text?: unknown } | null;
      if (!upstream.ok || typeof body?.text !== 'string') throw new Error(`the transcription backend answered ${upstream.status}`);
      return { text: body.text };
    });
    sendJson(res, 200, answer);
  }

  /** Text to image, one picture, base64 — the same shape the `/v1` surface answers, from here or from a peer. */
  private async image(req: IncomingMessage, res: ServerResponse, spec: HostedAgentSpec): Promise<void> {
    const route = this.mediaRoute(res, spec, 'image');
    if (!route) return;
    let ask: { prompt?: unknown; size?: unknown; steps?: unknown; negative_prompt?: unknown };
    try { ask = JSON.parse((await readBody(req)).toString('utf8') || '{}') as typeof ask; } catch { return sendJson(res, 400, { error: { message: 'body is not JSON' } }); }
    if (typeof ask.prompt !== 'string' || !ask.prompt.trim()) return sendJson(res, 400, { error: { message: 'prompt is required' } });
    if (ask.size !== undefined && (typeof ask.size !== 'string' || !/^\d{3,4}x\d{3,4}$/.test(ask.size))) return sendJson(res, 400, { error: { message: 'size must look like 1024x1024' } });
    const steps = typeof ask.steps === 'number' && Number.isInteger(ask.steps) ? Math.min(Math.max(ask.steps, 1), HOSTED_AGENT_IMAGE_MAX_STEPS) : undefined;
    const clean = {
      prompt: ask.prompt.slice(0, 4000),
      ...(typeof ask.size === 'string' ? { size: ask.size } : {}),
      ...(steps ? { steps } : {}),
      ...(typeof ask.negative_prompt === 'string' ? { negative_prompt: ask.negative_prompt.slice(0, 4000) } : {}),
    };
    if (route.peer) return this.viaPeer(res, spec, route.peer, 'image', clean);
    const backend = route.local;
    const answer = await this.queued(backend, spec, steps ?? HOSTED_AGENT_IMAGE_MAX_STEPS, async () => {
      const upstream = await fetch(`${backend.upstream.replace(/\/+$/, '')}/v1/images/generations`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: backend.models[0]!, n: 1, response_format: 'b64_json', ...clean }),
        signal: AbortSignal.timeout(HOSTED_AGENT_MEDIA_TIMEOUT_MS),
      });
      const out = await upstream.json().catch(() => null) as { data?: { b64_json?: unknown }[] } | null;
      const b64 = out?.data?.[0]?.b64_json;
      if (!upstream.ok || typeof b64 !== 'string') throw new Error(`the image backend answered ${upstream.status}`);
      return { data: [{ b64_json: b64 }] };
    });
    sendJson(res, 200, answer);
  }

  private async egress(req: IncomingMessage, res: ServerResponse, spec: HostedAgentSpec): Promise<void> {
    let ask: HostedAgentEgressRequest;
    try { ask = JSON.parse((await readBody(req)).toString('utf8')) as HostedAgentEgressRequest; } catch { ask = { url: '' }; }
    try {
      const answer = await hostedAgentEgress(ask, spec.allowedHosts, spec.id);
      const headers: Record<string, string> = { 'x-egress-final-url': answer.finalUrl };
      for (const [k, v] of Object.entries(answer.headers)) if (!['transfer-encoding', 'connection', 'content-length', 'content-encoding'].includes(k)) headers[k] = v;
      res.writeHead(answer.status, headers);
      res.end(answer.body);
    } catch (e) {
      const refused = e instanceof HostedAgentEgressRefusal || (e as { cause?: unknown })?.cause instanceof HostedAgentEgressRefusal;
      const why = e instanceof Error ? e.message : String(e);
      this.deps.log(`agent ${spec.id} egress ${refused ? 'refused' : 'failed'}: ${ask.url} — ${why}`);
      res.writeHead(refused ? 403 : 502, { 'content-type': 'text/plain', 'x-egress-refused': refused ? '1' : '0' });
      res.end(why);
    }
  }
}
