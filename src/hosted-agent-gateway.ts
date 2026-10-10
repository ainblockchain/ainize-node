/**
 * The only door out of a hosted agent: its model, and the public internet it was allowed.
 *
 * A hosted agent holds a token, minted when its runtime starts and forgotten when it stops. Every request names
 * the token in its path (`/t/<token>/…`) so that a stock OpenAI client given `…/t/<token>/v1` as its base URL
 * works unmodified. The gateway, not the agent, decides:
 *
 *   • which model answers — always the spec's, whatever the request says. A spec may name another node's model
 *     (`id@0x<node>`, peer-models.ts): its chat is then relayed to that node over p2p, streamed as it comes;
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
 *
 * A second kind of token belongs to a RUN (`POST /api/run`, run-sandbox.ts): a script somebody pressed ▶ on. It
 * has no spec and no model of its own; what it may reach is this node's `/api/decide`, `/api/chat` and `/v1/*`
 * (forwarded to the node's own listener, so the free tier sees the run's caller) and, through a CONNECT proxy
 * the sandbox announces as `HTTPS_PROXY`, TLS to the few public hosts the run was allowed — `ainize.ai` and the
 * node's own public host — so a script that spells `https://ainize.ai/api/decide` works as written. Every other
 * host, port or scheme is refused at the proxy; nothing else has a route.
 *
 * The script's own key (`AINIZE_API_KEY`, run-sandbox.ts) is an ordinary API key of the run's caller or of the
 * person aindrive named (run-actor.ts); on `/v1/*` it is forwarded as any `authorization` is, and the node treats
 * it as it treats every key. The run token itself is never a credential the node knows.
 */
import { hostedAgentAccess } from './hosted-agent-access.js';
import { dirname } from 'node:path';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { BlockList, connect as netConnect, isIP, type AddressInfo, type LookupFunction, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { randomBytes } from 'node:crypto';
import type { InferenceBackend, InferenceBackendRegistry } from './inference-backends.js';
import type { ModalityGate } from './modality-gate.js';
import { hostedAgentMediaOf, type HostedAgentSpec } from './hosted-agent-types.js';
import { hostedAgentHostAllowed } from './hosted-agent-runtime/hostedAgentPop.js';
import { PeerModelCallError, parseNodeModelRef, type PeerModelModality, type PeerModelTarget } from './peer-models.js';

const HOSTED_AGENT_EGRESS_MAX_BYTES = 5 * 1024 * 1024;
/**
 * The most one egress call may ask for with `maxBytes`: a phone photo or a few minutes of voice. The default stays
 * small because most egress is an API answer; an attachment read raises it for that one call.
 */
export const HOSTED_AGENT_EGRESS_ATTACHMENT_MAX_BYTES = 32 * 1024 * 1024;
const HOSTED_AGENT_EGRESS_TIMEOUT_MS = 30_000;
const HOSTED_AGENT_EGRESS_MAX_REDIRECTS = 5;
/** A chat request carrying a photo, or a transcription carrying a voice note, both as base64. */
const HOSTED_AGENT_GATEWAY_MAX_BODY = 48 * 1024 * 1024;
const HOSTED_AGENT_LLM_TIMEOUT_MS = 120_000;
/** A diffusion model at full steps takes tens of seconds; a long voice note, about as long. */
const HOSTED_AGENT_MEDIA_TIMEOUT_MS = 180_000;
/** Kept low: an agent turn waits on this, and the paid surface is where many steps are bought. */
const HOSTED_AGENT_IMAGE_MAX_STEPS = 30;
/** What a run may forward to this node: the two free doors and the keyed surface; nothing that manages state. */
const RUN_FORWARDED_PATH = /^\/(?:api\/decide|api\/chat|v1(?:\/|$))/;
/** A CONNECT tunnel that carried no bytes for this long is closed; a decision call waits in the gate well under it. */
const RUN_TUNNEL_IDLE_MS = 180_000;
const RUN_FORWARD_TIMEOUT_MS = 300_000;

/** What one run (run-sandbox.ts) is allowed, named by its token for as long as its container lives. */
export interface RunGrant {
  id: string;
  /** Hosts a CONNECT tunnel may be opened to, port 443 only. */
  allowedHosts: string[];
  /** This node's own listener, where `/api/decide`, `/api/chat` and `/v1/*` are forwarded. */
  selfUrl: string;
}

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

/**
 * Local integration runs only: `AINIZE_UNSAFE_ALLOW_PRIVATE_EGRESS=1` lets an agent's EGRESS reach loopback and
 * RFC 1918 addresses (an aindrive on 127.0.0.1) and name them as IP literals. It changes nothing else: not the
 * linked-agent upstream check, not link-local/metadata/multicast ranges. Refused under NODE_ENV=production and
 * logged once, so it cannot slip into a deployment quietly. Never set this on a node that serves other people.
 */
const unsafePrivateEgress = (() => {
  const on = process.env.AINIZE_UNSAFE_ALLOW_PRIVATE_EGRESS === '1' && process.env.NODE_ENV !== 'production';
  if (on) console.warn('[hosted-agent-gateway] AINIZE_UNSAFE_ALLOW_PRIVATE_EGRESS=1: agent egress may reach loopback/RFC1918 addresses (local integration only)');
  return on;
})();
const localEgressAllowed = (() => {
  const b = new BlockList();
  b.addSubnet('127.0.0.0', 8, 'ipv4'); b.addSubnet('10.0.0.0', 8, 'ipv4'); b.addSubnet('172.16.0.0', 12, 'ipv4'); b.addSubnet('192.168.0.0', 16, 'ipv4');
  b.addAddress('::1', 'ipv6');
  return (address: string) => unsafePrivateEgress && (isIP(address) === 4 ? b.check(address, 'ipv4') : isIP(address) === 6 && b.check(address.toLowerCase(), 'ipv6'));
})();
/** What the egress path accepts: public, or (under the local switch) loopback/RFC1918. Other callers keep the strict check. */
const egressAddressAllowed = (address: string) => hostedAgentAddressIsPublic(address) || localEgressAllowed(address);

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

/** Does a host match an allowlist of names, `*.suffix` wildcards and `*`? One matcher, shared with the runtime. */
export { hostedAgentHostAllowed };

class HostedAgentEgressRefusal extends Error {}

/** A DNS lookup that refuses to hand the socket anything but public addresses. */
const hostedAgentPublicLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return (callback as (e: Error | null, a: string, f: number) => void)(err, '', 0);
    const list = addresses as unknown as LookupAddress[];
    const bad = list.find((a) => !egressAddressAllowed(a.address));
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
  redirect?: 'follow' | 'error' | 'manual';
  bodyBase64?: string;
  /** Raise the response ceiling for this call, up to HOSTED_AGENT_EGRESS_ATTACHMENT_MAX_BYTES. */
  maxBytes?: number;
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
  const maxBytes = typeof req.maxBytes === 'number' && req.maxBytes > 0
    ? Math.min(req.maxBytes, HOSTED_AGENT_EGRESS_ATTACHMENT_MAX_BYTES) : HOSTED_AGENT_EGRESS_MAX_BYTES;
  let method = (req.method ?? 'GET').toUpperCase();
  let body = req.bodyBase64 ? Buffer.from(req.bodyBase64, 'base64') : undefined;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers ?? {})) if (!HOSTED_AGENT_EGRESS_DROPPED_HEADERS.has(k.toLowerCase())) headers[k] = v;
  if (agentId && !Object.keys(headers).some((k) => k.toLowerCase() === 'user-agent')) headers['user-agent'] = hostedAgentUserAgent(agentId);

  for (let hop = 0; hop <= HOSTED_AGENT_EGRESS_MAX_REDIRECTS; hop++) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new HostedAgentEgressRefusal(`only http and https are allowed, not ${url.protocol}`);
    if (url.username || url.password) throw new HostedAgentEgressRefusal('credentials in the URL are not allowed; use a header');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) && !localEgressAllowed(host)) throw new HostedAgentEgressRefusal(`${host} is an address; allowed hosts are names`);
    if (!hostedAgentHostAllowed(host, allowedHosts)) throw new HostedAgentEgressRefusal(`${host} is not in this agent's allowed hosts`);

    const answer = await new Promise<HostedAgentEgressAnswer>((resolve, reject) => {
      const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
      const out = send(url, { method, headers: { ...headers, ...(body ? { 'content-length': String(body.length) } : {}) }, lookup: hostedAgentPublicLookup, timeout: HOSTED_AGENT_EGRESS_TIMEOUT_MS }, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) { res.destroy(new HostedAgentEgressRefusal(`response is larger than ${maxBytes} bytes`)); return; }
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
      if (req.redirect === 'error') throw new HostedAgentEgressRefusal('redirect refused by caller');
      if (req.redirect === 'manual') return answer;
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
  /**
   * Chat models on other nodes, for an agent whose spec names one (`id@0x<node>`) — or a bare id this node does not
   * serve. `self` is this node's address: a ref naming it is answered here. Absent → local chat only.
   */
  peerChat?: {
    self: string;
    target(model: string, node: string | null): PeerModelTarget | null;
    fetch(target: PeerModelTarget, body: unknown): Promise<Response>;
  };
  qaRevalidation?: (agentId:string,input:unknown)=>unknown;
  qaBase?: (agentId:string,jobId:string)=>unknown;
  qaIntake?: (agentId:string,input:unknown)=>unknown;
  qaStatus?: (agentId:string,jobId:string)=>unknown;
  qaPublication?: (agentId: string, request: unknown) => unknown;
  qaValidation?: (agentId: string, candidate: unknown) => unknown;
  spec: (agentId: string) => HostedAgentSpec | null;
  log: (message: string) => void;
}

async function readBody(req: IncomingMessage, limit = HOSTED_AGENT_GATEWAY_MAX_BODY): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new HostedAgentEgressRefusal('request body too large');
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
  private readonly runs = new Map<string, RunGrant>();
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

  /** A token for one run; forgotten when its container is. Distinct from agent tokens: a run is not an agent. */
  issueRun(grant: RunGrant): string {
    const token = randomBytes(24).toString('hex');
    this.runs.set(token, grant);
    return token;
  }

  revokeRun(token: string): void {
    this.runs.delete(token);
  }

  /** Listen on one address (loopback, or a bridge gateway). Returns the base URL a runtime there should use. */
  async listen(host: string, listenPort = 0): Promise<string> {
    const known = this.urls.get(host);
    if (known) return known;
    const server = createServer((req, res) => { void this.handle(req, res); });
    server.on('connect', (req, socket, head) => this.tunnel(req, socket, head));
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(listenPort, host, () => resolve()); });
    this.servers.push(server);
    const { port } = server.address() as AddressInfo;
    const url = `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
    this.urls.set(host, url);
    return url;
  }

  /** Host and runtime UID only; the same token, model and egress checks apply. */
  async listenUnix(path: string): Promise<string> {
    await hostedAgentAccess(dirname(path), 'gateway');
    const server = createServer((req, res) => { void this.handle(req, res); });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, () => resolve()); });
    try {
      await hostedAgentAccess(path, 'socket');
    } catch (error) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      throw error;
    }
    this.servers.push(server);
    return 'http://ainize-gateway';
  }

  async close(): Promise<void> {
    await Promise.all(this.servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
    this.servers.length = 0;
    this.urls.clear();
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const m = /^\/t\/([0-9a-f]{48})(\/.*)$/.exec((req.url ?? '').split('?')[0] ?? '');
    const run = m ? this.runs.get(m[1]!) : undefined;
    if (run) return this.forwardRun(req, res, run, (req.url ?? '').slice(3 + 48));
    const agentId = m ? this.tokens.get(m[1]!) : undefined;
    const spec = agentId ? this.deps.spec(agentId) : null;
    if (!m || !spec) return sendJson(res, 401, { error: { message: 'unknown or expired agent token' } });
    const path = m[2]!;
    try {
      if(req.method==='POST'&&path==='/qa/revalidation'){
        if(!this.deps.qaRevalidation)return sendJson(res,403,{error:{message:'QA revalidation disabled'}});
        let input:unknown;try{input=JSON.parse((await readBody(req,2048)).toString('utf8'));}catch{return sendJson(res,400,{error:{message:'Invalid QA revalidation'}});}
        try{return sendJson(res,200,this.deps.qaRevalidation(spec.id,input));}catch{return sendJson(res,403,{error:{message:'QA revalidation refused'}});}
      }
      if(req.method==='POST'&&path==='/qa/base'){
        if(!this.deps.qaBase)return sendJson(res,403,{error:{message:'QA base disabled'}});
        let input:any;try{input=JSON.parse((await readBody(req,1024)).toString('utf8'));if(!input||Object.keys(input).join(',')!=='jobId'||typeof input.jobId!=='string'||!/^[-\w]{1,128}$/.test(input.jobId))throw new Error();}catch{return sendJson(res,400,{error:{message:'Invalid QA base request'}});}
        try{return sendJson(res,200,this.deps.qaBase(spec.id,input.jobId));}catch{return sendJson(res,403,{error:{message:'QA base refused'}});}
      }
      if(req.method==='POST'&&path==='/qa/intake'){
        if(!this.deps.qaIntake)return sendJson(res,403,{error:{message:'QA intake disabled'}});
        let input:unknown;try{input=JSON.parse((await readBody(req,2048)).toString('utf8'));}catch{return sendJson(res,400,{error:{message:'Invalid QA intake'}});}
        try{return sendJson(res,200,this.deps.qaIntake(spec.id,input));}catch{return sendJson(res,403,{error:{message:'QA intake refused'}});}
      }
      if(req.method==='POST'&&path==='/qa/status'){
        if(!this.deps.qaStatus)return sendJson(res,403,{error:{message:'QA status disabled'}});
        let input:any;
        try{input=JSON.parse((await readBody(req,1024)).toString('utf8'));if(!input||Object.keys(input).join(',')!=='jobId'||typeof input.jobId!=='string'||!/^[-\w]{1,80}$/.test(input.jobId))throw new Error();}
        catch{return sendJson(res,400,{error:{message:'Invalid QA status request'}});}
        try{return sendJson(res,200,this.deps.qaStatus(spec.id,input.jobId));}catch{return sendJson(res,403,{error:{message:'QA status refused'}});}
      }
      if (req.method === 'POST' && path === '/qa/publication') {
        if (!this.deps.qaPublication) return sendJson(res,403,{error:{message:'QA publication disabled'}});
        let request:unknown;
        try {request=JSON.parse((await readBody(req,3*1024*1024)).toString('utf8'));}
        catch {return sendJson(res,400,{error:{message:'Invalid QA publication'}});}
        try {return sendJson(res,200,this.deps.qaPublication(spec.id,request));}
        catch {return sendJson(res,403,{error:{message:'QA publication binding refused'}});}
      }
      if (req.method === 'POST' && path === '/qa/validation') {
        if (!this.deps.qaValidation) return sendJson(res, 403, { error: { message: 'QA validation disabled' } });
        let candidate: unknown;
        try { candidate=JSON.parse((await readBody(req,3*1024*1024)).toString('utf8')); }
        catch { return sendJson(res,400,{error:{message:'Invalid QA candidate'}}); }
        try { return sendJson(res,200,this.deps.qaValidation(spec.id,candidate)); }
        catch { return sendJson(res,403,{error:{message:'QA candidate or agent binding refused'}}); }
      }
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

  /**
   * A run's call to this node, as itself: the body and the caller's own `authorization` go through unchanged to
   * the node's listener, so `/api/decide` queues it in the free class and `/v1/*` wants the key it always wants.
   * Only the three surfaces; `/api/hosted-agents`, `/api/keys` and the rest are not a script's to call.
   */
  private forwardRun(req: IncomingMessage, res: ServerResponse, run: RunGrant, pathAndQuery: string): void {
    if (!RUN_FORWARDED_PATH.test(pathAndQuery)) {
      this.deps.log(`run ${run.id} refused: ${req.method} ${pathAndQuery.split('?')[0]} is not a surface a run may call`);
      return sendJson(res, 403, { error: { message: 'a run may call /api/decide, /api/chat and /v1/* on this node, nothing else', code: 'run_path_refused' } });
    }
    const headers: Record<string, string> = { 'x-ainize-run': run.id };
    for (const name of ['content-type', 'content-length', 'accept', 'authorization', 'transfer-encoding']) {
      const v = req.headers[name];
      if (typeof v === 'string') headers[name] = v;
    }
    const target = new URL(pathAndQuery, run.selfUrl);
    const upstream = httpRequest(target, { method: req.method, headers, timeout: RUN_FORWARD_TIMEOUT_MS }, (answer) => {
      const h: Record<string, string> = {};
      for (const [k, v] of Object.entries(answer.headers)) if (v !== undefined && !['connection', 'keep-alive'].includes(k)) h[k] = Array.isArray(v) ? v.join(', ') : v;
      res.writeHead(answer.statusCode ?? 502, h);
      answer.pipe(res);
    });
    upstream.on('timeout', () => upstream.destroy(new Error('this node did not answer in time')));
    upstream.on('error', (e) => {
      if (!res.headersSent) sendJson(res, 502, { error: { message: e.message } });
      else res.destroy();
    });
    req.pipe(upstream);
  }

  /**
   * `CONNECT host:443` from a run — the proxy a script's HTTP client uses for an `https://` URL it spelled itself.
   * TLS stays end to end (the gateway never sees the request); what it decides is only WHERE: a host on the
   * run's list, port 443, resolved to a public address by the same lookup egress uses. The run names itself in
   * `Proxy-Authorization: Basic base64("run:" + token)`, which `urllib`, `requests` and curl all send for a
   * proxy URL with credentials in it.
   */
  private tunnel(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const refuse = (status: number, why: string) => {
      socket.end(`HTTP/1.1 ${status} ${why}\r\nProxy-Authenticate: Basic realm="ainize-run"\r\nConnection: close\r\n\r\n`);
    };
    const auth = String(req.headers['proxy-authorization'] ?? '');
    const basic = /^Basic\s+([A-Za-z0-9+/=]+)$/.exec(auth);
    const cred = basic ? Buffer.from(basic[1]!, 'base64').toString('utf8') : '';
    const token = /^run:([0-9a-f]{48})$/.exec(cred)?.[1];
    const run = token ? this.runs.get(token) : undefined;
    if (!run) return refuse(407, 'Proxy Authentication Required');
    const m = /^(\[[0-9a-fA-F:.]+\]|[^:]+):(\d{1,5})$/.exec(req.url ?? '');
    const host = m?.[1]?.replace(/^\[|\]$/g, '') ?? '';
    const port = Number(m?.[2] ?? 0);
    if (!host || port !== 443 || isIP(host) || !hostedAgentHostAllowed(host, run.allowedHosts)) {
      this.deps.log(`run ${run.id} tunnel refused: ${req.url} is not an allowed host on port 443`);
      return refuse(403, 'Forbidden');
    }
    const upstream: Socket = netConnect({ host, port, lookup: hostedAgentPublicLookup });
    let open = false;
    upstream.setTimeout(RUN_TUNNEL_IDLE_MS, () => upstream.destroy(new Error('idle')));
    upstream.once('connect', () => {
      open = true;
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', (e) => {
      this.deps.log(`run ${run.id} tunnel to ${host} ${open ? 'failed' : 'refused'}: ${e.message}`);
      if (!open) refuse(502, 'Bad Gateway'); else socket.destroy();
    });
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
  }

  /**
   * The agent's model, and only it: this node's backend, or the peer the spec's ref names. Streaming is passed
   * through as the backend (or the peer) sends it.
   */
  private async llm(req: IncomingMessage, res: ServerResponse, spec: HostedAgentSpec): Promise<void> {
    const { model, node } = parseNodeModelRef(spec.model);
    const here = !node || node === this.deps.peerChat?.self.toLowerCase();
    const backend = here ? this.deps.registry()?.backendForModel(model) : undefined;
    const peer = backend ? null : this.deps.peerChat?.target(model, here ? null : node) ?? null;
    if (!backend && !peer) return sendJson(res, 503, { error: { message: `no node in reach serves ${spec.model} right now`, code: 'model_not_served' } });
    let body: Record<string, unknown>;
    try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}') as Record<string, unknown>; } catch { return sendJson(res, 400, { error: { message: 'body is not JSON' } }); }
    let upstream: Response;
    if (backend) {
      upstream = await fetch(`${backend.upstream.replace(/\/+$/, '')}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, model }),
        signal: AbortSignal.timeout(HOSTED_AGENT_LLM_TIMEOUT_MS),
      });
    } else {
      try {
        upstream = await this.deps.peerChat!.fetch(peer!, { ...body, model });
      } catch (e) {
        return sendJson(res, 502, { error: { message: `${peer!.name ?? peer!.address} did not answer: ${e instanceof Error ? e.message : String(e)}`, code: 'peer_failed' } });
      }
    }
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
  private mediaRoute(res: ServerResponse, spec: HostedAgentSpec, modality: 'transcription' | 'image'):
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
