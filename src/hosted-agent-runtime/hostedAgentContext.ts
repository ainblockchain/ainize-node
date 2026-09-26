/**
 * `ctx` — the only way a hosted agent reaches anything outside itself.
 *
 * Both doors go through the node's gateway (hosted-agent-gateway.ts), authenticated by a token that names this
 * agent. The model is the gateway's to choose (it is the spec's), and egress is the gateway's to allow: the
 * runtime asks, it does not decide, so code that bypasses `ctx` and edits these requests gains nothing — and in a
 * container there is no other route out at all.
 */
import { hostedAgentUiHelpers } from './hostedAgentA2ui.js';
import type {
  HostedAgentAudioInput, HostedAgentCtx, HostedAgentGatewayAccess, HostedAgentGeneratedImage, HostedAgentImageRequest, HostedAgentInput,
  HostedAgentLlmChoice, HostedAgentLlmRequest, HostedAgentRuntimeSpec,
} from './hostedAgentRuntimeTypes.js';

/** What a model call may take. A tools loop is at most a handful of these per turn. */
const HOSTED_AGENT_LLM_TIMEOUT_MS = 90_000;
/** Speech and image calls wait in a GPU queue first; the gateway's own limit is 180 s. */
const HOSTED_AGENT_MEDIA_CALL_TIMEOUT_MS = 200_000;

export const hostedAgentLlmBaseUrl = (gateway: HostedAgentGatewayAccess) =>
  `${gateway.url.replace(/\/+$/, '')}/t/${gateway.token}/v1`;
export const hostedAgentEgressUrl = (gateway: HostedAgentGatewayAccess) =>
  `${gateway.url.replace(/\/+$/, '')}/t/${gateway.token}/egress`;

/** The original global fetch, captured before a container runtime replaces it with the egress one. */
const directFetch: typeof fetch = globalThis.fetch.bind(globalThis);

export async function hostedAgentLlmChat(gateway: HostedAgentGatewayAccess, model: string, request: HostedAgentLlmRequest): Promise<HostedAgentLlmChoice> {
  const res = await directFetch(`${hostedAgentLlmBaseUrl(gateway)}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...request, model, stream: false }),
    signal: AbortSignal.timeout(HOSTED_AGENT_LLM_TIMEOUT_MS),
  });
  const body = await res.json().catch(() => null) as { choices?: HostedAgentLlmChoice[]; error?: { message?: string } } | null;
  if (!res.ok) throw new Error(`model call failed (${res.status}): ${body?.error?.message ?? 'no detail'}`);
  const choice = body?.choices?.[0];
  if (!choice?.message) throw new Error('model returned no choice');
  return choice;
}

async function hostedAgentMediaPost<T>(gateway: HostedAgentGatewayAccess, path: string, body: unknown, what: string): Promise<T> {
  const res = await directFetch(`${hostedAgentLlmBaseUrl(gateway)}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(HOSTED_AGENT_MEDIA_CALL_TIMEOUT_MS),
  });
  const out = await res.json().catch(() => null) as (T & { error?: { message?: string } }) | null;
  if (!res.ok || !out) throw new Error(`${what} failed (${res.status}): ${out?.error?.message ?? 'no detail'}`);
  return out;
}

export async function hostedAgentTranscribe(gateway: HostedAgentGatewayAccess, audio: HostedAgentAudioInput): Promise<string> {
  const out = await hostedAgentMediaPost<{ text?: unknown }>(gateway, '/audio/transcriptions', audio, 'transcription');
  if (typeof out.text !== 'string') throw new Error('transcription returned no text');
  return out.text;
}

export async function hostedAgentGenerateImage(gateway: HostedAgentGatewayAccess, request: HostedAgentImageRequest): Promise<HostedAgentGeneratedImage> {
  const out = await hostedAgentMediaPost<{ data?: { b64_json?: unknown }[] }>(gateway, '/images/generations', {
    prompt: request.prompt, size: request.size, steps: request.steps, negative_prompt: request.negativePrompt,
  }, 'image generation');
  const b64 = out.data?.[0]?.b64_json;
  if (typeof b64 !== 'string') throw new Error('image generation returned no image');
  // The sidecar encodes PNG; say so by sniffing rather than assuming, so a JPEG backend is labelled right too.
  return { bytesBase64: b64, mimeType: b64.startsWith('/9j/') ? 'image/jpeg' : 'image/png' };
}

/**
 * Fetch through the gateway's egress door.
 *
 * The request travels as JSON (url, method, headers, base64 body) rather than as an HTTP proxy CONNECT, so the
 * gateway sees the URL it is being asked for and can check it — including after every redirect, which it follows
 * itself. The answer comes back raw with the upstream status and headers.
 */
export async function hostedAgentEgressFetch(gateway: HostedAgentGatewayAccess, input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const req = input instanceof Request ? input : null;
  const url = req ? req.url : String(input);
  const method = (init.method ?? req?.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = {};
  new Headers(req?.headers ?? undefined).forEach((v, k) => { headers[k] = v; });
  new Headers(init.headers ?? undefined).forEach((v, k) => { headers[k] = v; });
  let bodyBase64: string | undefined;
  const rawBody = init.body ?? (req && method !== 'GET' && method !== 'HEAD' ? await req.arrayBuffer() : undefined);
  if (rawBody !== undefined && rawBody !== null) {
    bodyBase64 = Buffer.from(await new Response(rawBody as ConstructorParameters<typeof Response>[0]).arrayBuffer()).toString('base64');
  }
  const res = await directFetch(hostedAgentEgressUrl(gateway), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, method, headers, bodyBase64 }),
    signal: init.signal ?? AbortSignal.timeout(45_000),
  });
  // Present only when the gateway could not fetch at all: '1' refused by policy, '0' failed. Either way the caller
  // sees what `fetch` shows for a network failure — a TypeError — not an HTTP answer nobody sent.
  const refused = res.headers.get('x-egress-refused');
  if (refused !== null) {
    const why = await res.text();
    throw new TypeError(`fetch ${refused === '1' ? 'refused by the node' : 'failed'}: ${why}`);
  }
  const out = new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers });
  const finalUrl = res.headers.get('x-egress-final-url') ?? url;
  Object.defineProperty(out, 'url', { value: finalUrl });
  return out;
}

/**
 * The `fetch` a container installs globally: the gateway itself is reached directly (so a library handed
 * `ctx.llm.baseUrl` works — the gateway lives on a private bridge address the egress door rightly refuses), and
 * everything else goes out through the egress door.
 */
export function hostedAgentGlobalFetch(gateway: HostedAgentGatewayAccess): typeof fetch {
  const own = gateway.url.replace(/\/+$/, '') + '/';
  return ((input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    return url.startsWith(own) ? directFetch(input, init) : hostedAgentEgressFetch(gateway, input, init);
  }) as typeof fetch;
}

export interface HostedAgentCtxOptions {
  spec: HostedAgentRuntimeSpec;
  gateway: HostedAgentGatewayAccess;
  secrets: Record<string, string>;
  log: (...args: unknown[]) => void;
}

export function createHostedAgentCtx(o: HostedAgentCtxOptions, input: HostedAgentInput): HostedAgentCtx {
  return {
    input,
    spec: o.spec,
    llm: {
      chat: (request) => hostedAgentLlmChat(o.gateway, o.spec.model, request),
      baseUrl: hostedAgentLlmBaseUrl(o.gateway),
      model: o.spec.model,
    },
    media: {
      ...(o.spec.media?.transcription ? { transcribe: (audio: HostedAgentAudioInput) => hostedAgentTranscribe(o.gateway, audio) } : {}),
      ...(o.spec.media?.image ? { generateImage: (request: HostedAgentImageRequest) => hostedAgentGenerateImage(o.gateway, request) } : {}),
    },
    fetch: (url, init) => hostedAgentEgressFetch(o.gateway, url, init),
    secret: (name) => o.secrets[name],
    ui: hostedAgentUiHelpers,
    log: o.log,
  };
}
