/**
 * One hosted agent as an A2A endpoint: its card at the well-known paths and JSON-RPC at `/`.
 *
 * Returned as a Router so the in-process host can mount many under `/a/<id>` and the container entry can mount
 * one at the root. Mounting rules are news-agent's, learnt the hard way: the card handlers are mounted with `use`
 * and a FRESH one per path, or the v0.3 compat layer answers requests that asked for v1.0.
 */
import express, { Router } from 'express';
import { DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server';
import { UserBuilder, agentCardHandler, jsonRpcHandler } from '@a2a-js/sdk/server/express';
import { hostedAgentA2uiExtension } from './hostedAgentA2ui.js';
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
      extensions: spec.a2ui ? [hostedAgentA2uiExtension()] : [],
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
}

export function createHostedAgentRuntimeRouter(o: HostedAgentRuntimeAppOptions): Router {
  const card = hostedAgentCard(o.spec, o.cardUrl);
  const executor = new HostedAgentExecutor(o);
  const requestHandler = new DefaultRequestHandler(card as never, new InMemoryTaskStore(), executor);
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
