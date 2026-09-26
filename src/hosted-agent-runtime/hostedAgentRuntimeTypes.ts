/**
 * The contract between a hosted agent's code and the runtime that runs it.
 *
 * Everything in this directory is SELF-CONTAINED: it imports the A2A SDK, express and node builtins, and nothing
 * else from the node. The same files run in two places — inside the node process for prompt agents, and inside a
 * Docker container for agents that bring code — and a container has no node to import from. Keep it that way:
 * an import of `../anything` here breaks the runtime image, and nothing but the Docker integration test notices.
 */

export type HostedAgentMode = 'prompt' | 'tools' | 'handler';

/**
 * The node's other models an agent may use besides its chat model — each off unless the owner turns it on, and
 * each only on a node that serves one. Speech-to-text reads the voice notes a caller attaches; image generation
 * is a tool the model can call, and its picture comes back as a file part of the reply.
 */
export interface HostedAgentMedia {
  transcription: boolean;
  image: boolean;
}

/** What the runtime needs to know about an agent. The node's stored spec is a superset (owner, files, …). */
export interface HostedAgentRuntimeSpec {
  id: string;
  name: string;
  description: string;
  model: string;
  systemPrompt: string;
  mode: HostedAgentMode;
  a2ui: boolean;
  skills: { id: string; name: string; description?: string; examples?: string[] }[];
  version: number;
  /** Absent on specs stored before media existed — read it as all off. */
  media?: HostedAgentMedia;
}

/** One OpenAI-shaped chat message, as the model backend takes it. */
export interface HostedAgentChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  name?: string;
}

export interface HostedAgentLlmRequest {
  messages: HostedAgentChatMessage[];
  tools?: { type: 'function'; function: { name: string; description?: string; parameters?: unknown } }[];
  temperature?: number;
  max_tokens?: number;
}

export interface HostedAgentLlmChoice {
  message: HostedAgentChatMessage;
  finish_reason: string | null;
}

/** An A2UI v0.9 message (createSurface / updateComponents / updateDataModel). Opaque to the runtime. */
export type HostedAgentUiMessage = Record<string, unknown>;

export interface HostedAgentUiHelpers {
  /** The three messages that draw one surface: create it, give it components, give it data. */
  surface(surfaceId: string, components: Record<string, unknown>[], data?: Record<string, unknown>): HostedAgentUiMessage[];
  text(id: string, text: string | { path: string }, variant?: string): Record<string, unknown>;
  column(id: string, children: string[]): Record<string, unknown>;
  row(id: string, children: string[]): Record<string, unknown>;
  card(id: string, child: string): Record<string, unknown>;
  divider(id: string): Record<string, unknown>;
  list(id: string, dataPath: string, templateComponentId: string): Record<string, unknown>;
  bind(path: string): { path: string };
}

/**
 * A file the caller attached. Usually a LINK (`uri`) the agent may fetch through `ctx.fetch` — aindrive sends
 * short-lived, revocable, logged links rather than bytes — sometimes the bytes themselves.
 */
export interface HostedAgentAttachment {
  uri?: string;
  bytesBase64?: string;
  name: string;
  mimeType: string;
}

export interface HostedAgentInput {
  text: string;
  contextId: string;
  history: HostedAgentChatMessage[];
  /** Files attached to this message, not yet opened. Prompt and tools agents read them with `read_attachment`. */
  files: HostedAgentAttachment[];
}

/** What an agent's code is handed on every turn. Identical in and out of Docker. */
export interface HostedAgentCtx {
  input: HostedAgentInput;
  spec: HostedAgentRuntimeSpec;
  llm: {
    /** The agent's own model. The model name is fixed by the spec; the gateway enforces it too. */
    chat(request: HostedAgentLlmRequest): Promise<HostedAgentLlmChoice>;
    /** OpenAI-compatible base URL (`…/v1`) with the agent's token in the path, for libraries that want one. */
    baseUrl: string;
    model: string;
  };
  /**
   * The node's speech and image models, through the gateway. A method is present only when the spec turned it
   * on — the gateway refuses the call otherwise, so code that calls one anyway learns nothing it could not see.
   */
  media: {
    transcribe?(audio: HostedAgentAudioInput): Promise<string>;
    generateImage?(request: HostedAgentImageRequest): Promise<HostedAgentGeneratedImage>;
  };
  /** Fetch through the node's egress gateway. Only `allowedHosts` answer; private addresses never do. */
  fetch(url: string | URL, init?: RequestInit): Promise<Response>;
  secret(name: string): string | undefined;
  ui: HostedAgentUiHelpers;
  log(...args: unknown[]): void;
}

export interface HostedAgentAudioInput {
  bytesBase64: string;
  name: string;
  mimeType: string;
  language?: string;
}

export interface HostedAgentImageRequest {
  prompt: string;
  /** `WIDTHxHEIGHT`, e.g. `1024x1024`. The backend's default when absent. */
  size?: string;
  steps?: number;
  negativePrompt?: string;
}

export interface HostedAgentGeneratedImage {
  bytesBase64: string;
  mimeType: string;
}

/** What a turn returns. A bare string is `{ text }`. */
export type HostedAgentReply = string | { text?: string; parts?: unknown[]; ui?: HostedAgentUiMessage[] };

export interface HostedAgentTool {
  name: string;
  description?: string;
  /** JSON Schema of the arguments, as OpenAI function calling takes it. */
  parameters?: unknown;
  run(args: Record<string, unknown>, ctx: HostedAgentCtx): unknown | Promise<unknown>;
}

/** The module an agent's `index.mjs` default-exports (or exports by name). */
export interface HostedAgentModule {
  execute?(input: string, ctx: HostedAgentCtx): HostedAgentReply | Promise<HostedAgentReply>;
  tools?: HostedAgentTool[];
}

/** Where the runtime reaches the node: the gateway base URL and this agent's token. */
export interface HostedAgentGatewayAccess {
  url: string;
  token: string;
}
