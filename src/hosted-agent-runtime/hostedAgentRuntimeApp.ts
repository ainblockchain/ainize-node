/**
 * One hosted agent as an A2A endpoint: its card at the well-known paths and JSON-RPC at `/`.
 *
 * Returned as a Router so the in-process host can mount many under `/a/<id>` and the container entry can mount
 * one at the root. Mounting rules are news-agent's, learnt the hard way: the card handlers are mounted with `use`
 * and a FRESH one per path, or the v0.3 compat layer answers requests that asked for v1.0.
 */
import express, { Router } from 'express';
import { DefaultRequestHandler, InMemoryTaskStore, type TaskStore } from '@a2a-js/sdk/server';
import { UserBuilder, agentCardHandler, jsonRpcHandler } from '@a2a-js/sdk/server/express';
import { hostedAgentA2uiExtension } from './hostedAgentA2ui.js';
import { hostedAgentPopExtension } from './hostedAgentPop.js';
import { HostedAgentExecutor, type HostedAgentExecutorOptions } from './hostedAgentExecutor.js';
import type { HostedAgentRuntimeSpec } from './hostedAgentRuntimeTypes.js';

export const HOSTED_AGENT_CARD_PATHS = ['/.well-known/agent-card.json', '/.well-known/agent.json', '/agent.json'];

/**
 * The card. `url` is whatever the runtime was told; the node rewrites it to the public `/agents/<id>` address on
 * the way out (agents.ts), exactly as it does for an upstream agent.
 */
/** Audio a transcription backend takes — what a browser recorder, a phone and a desktop tool usually produce. */
export const HOSTED_AGENT_AUDIO_INPUT_MODES = ['audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/wav'];

/** The MIME types an agent takes and gives: text always, audio and images when its owner turned them on. */
export function hostedAgentModesOf(spec: HostedAgentRuntimeSpec): { input: string[]; output: string[] } {
  return {
    input: ['text/plain', ...(spec.media?.transcription ? HOSTED_AGENT_AUDIO_INPUT_MODES : [])],
    output: ['text/plain', ...(spec.media?.image ? ['image/png'] : [])],
  };
}

export function hostedAgentCard(spec: HostedAgentRuntimeSpec, url: string) {
  const modes = hostedAgentModesOf(spec);
  // Two-part protocol versions: "1.0.0" is compared literally against the "1.0" a client asks for and refused.
  const iface = (protocolVersion: string) => ({ url, protocolBinding: 'JSONRPC', protocolVersion, tenant: '' });
  const skills = spec.skills.length
    ? spec.skills
    : [{ id: 'chat', name: spec.name, description: spec.description }];
  return {
    name: spec.name,
    description: spec.description || `An agent built on ${spec.model}`,
    version: String(spec.version),
    supportedInterfaces: [iface('1.0'), iface('0.3')],
    capabilities: {
      // `message/stream` is what most workspaces (and the Ainize live test) send first. A turn is one message, so
      // the stream carries one event — but a card that says `false` gets every such call refused with -32004.
      streaming: true,
      pushNotifications: false,
      // The PoP key, when the node issued one: a product that holds a delegation for this agent binds it to this key.
      extensions: [...(spec.a2ui ? [hostedAgentA2uiExtension()] : []), ...(spec.popJwk ? [hostedAgentPopExtension(spec.popJwk)] : [])],
    },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: modes.input,
    defaultOutputModes: modes.output,
    skills: skills.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description ?? '',
      tags: [],
      examples: s.examples ?? [],
      inputModes: modes.input,
      outputModes: modes.output,
    })),
    // Not part of the protocol; read by the node and the web to place the agent under its model.
    // `media` only when something is on, so the card of an agent that uses none is exactly what it always was.
    metadata: { ainize: { model: spec.model, mode: spec.mode, ...(spec.media?.transcription || spec.media?.image ? { media: { transcription: !!spec.media.transcription, image: !!spec.media.image } } : {}) } },
  };
}

export interface HostedAgentRuntimeAppOptions extends HostedAgentExecutorOptions {
  /** The address the card names before the node rewrites it. */
  cardUrl: string;
  /**
   * Where tasks are kept. The node passes one that outlives the router (hosted-agent-task-store.ts), so `tasks/get`
   * answers across restarts, restores and agent updates; the container runtime keeps them in memory.
   */
  taskStore?: TaskStore;
}

/**
 * The SDK's handler, told apart by method: `message/stream` marks its message id for the length of the call, so
 * the executor streams that turn and leaves every `message/send` turn exactly as it was.
 */
/** How long a `messageId` is remembered so a client's retry gets the same answer instead of a second turn. */
const HOSTED_AGENT_MESSAGE_DEDUPE_MS = 10 * 60_000;
const HOSTED_AGENT_MESSAGE_DEDUPE_MAX = 1000;

class HostedAgentRequestHandler extends DefaultRequestHandler {
  /** `<contextId>#<messageId>` → the reply already given. A retry (same id, same context) is the SAME logical request. */
  private readonly answered = new Map<string, { at: number; result: unknown }>();

  constructor(card: unknown, executor: HostedAgentExecutor, private readonly streaming: Set<string>, taskStore: TaskStore) {
    super(card as never, taskStore, executor);
  }

  private dedupeKey(message: unknown): string | null {
    const m = message as { messageId?: unknown; contextId?: unknown } | undefined;
    if (!m || typeof m.messageId !== 'string' || !m.messageId) return null;
    return `${typeof m.contextId === 'string' ? m.contextId : ''}#${m.messageId}`;
  }

  private remembered(key: string): unknown | undefined {
    const hit = this.answered.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.at > HOSTED_AGENT_MESSAGE_DEDUPE_MS) { this.answered.delete(key); return undefined; }
    return hit.result;
  }

  private remember(key: string, result: unknown): void {
    this.answered.set(key, { at: Date.now(), result });
    while (this.answered.size > HOSTED_AGENT_MESSAGE_DEDUPE_MAX) { const oldest = this.answered.keys().next().value; if (oldest === undefined) break; this.answered.delete(oldest); }
  }

  /**
   * Plan §7 "task 재시도: 논리 작업 1건에 결과·청구 최대 1회": a `message/send` whose (contextId, messageId) was already
   * answered within ten minutes returns that answer — no second model turn, no second file read, no second charge.
   */
  override async sendMessage(...args: Parameters<DefaultRequestHandler['sendMessage']>): ReturnType<DefaultRequestHandler['sendMessage']> {
    const key = this.dedupeKey(args[0]?.message);
    const prior = key ? this.remembered(key) : undefined;
    if (prior !== undefined) return prior as Awaited<ReturnType<DefaultRequestHandler['sendMessage']>>;
    const result = await super.sendMessage(...args);
    if (key) this.remember(key, result);
    return result;
  }

  /**
   * The streamed twin of the rule above: a retried `message/stream` replays the finished task (or the reply
   * message) as its single event, so the client sees the same answer it would have seen, and nothing runs twice.
   */
  override async *sendMessageStream(...args: Parameters<DefaultRequestHandler['sendMessageStream']>): ReturnType<DefaultRequestHandler['sendMessageStream']> {
    const key = this.dedupeKey(args[0]?.message);
    const prior = key ? this.remembered(key) : undefined;
    if (prior !== undefined) { yield prior as never; return; }
    const id = (args[0]?.message as { messageId?: string } | undefined)?.messageId;
    if (id) this.streaming.add(id);
    // The SDK's internal stream events are `{ payload: { $case: 'task' | 'artifactUpdate' | 'statusUpdate', value } }`
    // with text parts as `{ content: { $case: 'text', value } }`. The finished task is assembled from them (first event:
    // the task; artifactUpdate: the answer; statusUpdate: the state) so the replay does not depend on the task store.
    type Ev = { payload?: { $case?: string; value?: Record<string, unknown> } };
    let task: Record<string, unknown> | undefined;
    const answer: string[] = [];
    let finalStatus: unknown;
    const assembled = (): unknown => task && ({ payload: { $case: 'task', value: {
      ...task, ...(finalStatus ? { status: finalStatus } : {}),
      artifacts: answer.length ? [{ artifactId: 'answer', name: 'answer', description: '', parts: [{ content: { $case: 'text', value: answer.join('') } }] }] : (task.artifacts ?? []),
    } } });
    try {
      for await (const event of super.sendMessageStream(...args)) {
        const p = (event as Ev).payload;
        const v = p?.value ?? {};
        if (p?.$case === 'task') task = { ...v };
        else if (p?.$case === 'artifactUpdate') {
          for (const part of ((v.artifact as { parts?: { content?: { $case?: string; value?: unknown } }[] } | undefined)?.parts ?? [])) {
            if (part.content?.$case === 'text' && typeof part.content.value === 'string') answer.push(part.content.value);
          }
        }
        else if (p?.$case === 'statusUpdate') finalStatus = v.status;
        // The consumer may stop reading right after the final event, so the replay is stored BEFORE that event
        // is handed over; the code after the loop only runs for streams that end without a final flag.
        if (key && p?.$case === 'statusUpdate' && (v as { final?: boolean }).final) { const done = assembled(); if (done) this.remember(key, done); }
        yield event;
      }
    } finally { if (id) this.streaming.delete(id); }
    if (!key) return;
    const done = assembled();
    if (done && this.remembered(key) === undefined) this.remember(key, done);
  }
}

export function createHostedAgentRuntimeRouter(o: HostedAgentRuntimeAppOptions): Router {
  const card = hostedAgentCard(o.spec, o.cardUrl);
  const streaming = new Set<string>();
  const executor = new HostedAgentExecutor({ ...o, isStreaming: (id) => streaming.has(id) });
  const requestHandler = new HostedAgentRequestHandler(card, executor, streaming, o.taskStore ?? new InMemoryTaskStore());
  const router = Router();
  router.get('/health', (_req, res) => { res.json({ ok: true, id: o.spec.id, version: o.spec.version }); });
  for (const path of HOSTED_AGENT_CARD_PATHS) {
    router.use(path, agentCardHandler({
      agentCardProvider: requestHandler,
      legacyCompat: { enabled: true },
    }));
  }
  // The node already parsed JSON for requests it forwards in-process; express.json skips a parsed body.
  router.use(express.json({ limit: '300kb' }));
  router.post('/', jsonRpcHandler({
    requestHandler,
    userBuilder: UserBuilder.noAuthentication,
    legacyCompat: { enabled: true },
  }));
  return router;
}
