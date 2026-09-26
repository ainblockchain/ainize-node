/**
 * One executor for every hosted agent; the mode decides what a turn does.
 *
 *   • prompt  — system prompt + remembered turns + this message, to the agent's model. The answer is the reply.
 *   • tools   — the same, with the module's tools offered as OpenAI functions; the loop runs what the model asks
 *               for and feeds the results back, up to HOSTED_AGENT_TOOL_ROUNDS times.
 *   • handler — the module's `execute(input, ctx)` decides everything.
 *
 * Every turn publishes exactly ONE `message` event, which satisfies the SDK's first-event rule by construction
 * (news-agent/src/server.mjs explains why a message and not a task). The SDK quirks it documents apply here too:
 * the event goes through `AgentEvent.message`, and `role` is the NUMERIC enum.
 */
import { randomUUID } from 'node:crypto';
import { AgentEvent, type AgentExecutor, type ExecutionEventBus, type RequestContext } from '@a2a-js/sdk/server';
import { hostedAgentA2uiPart } from './hostedAgentA2ui.js';
import { hostedAgentAttachmentHistoryNote, hostedAgentAttachmentNote, hostedAgentAttachmentsOf, hostedAgentReadAttachmentTool } from './hostedAgentAttachments.js';
import { createHostedAgentCtx, type HostedAgentCtxOptions } from './hostedAgentContext.js';
import type { HostedAgentAttachment, HostedAgentChatMessage, HostedAgentCtx, HostedAgentModule, HostedAgentReply } from './hostedAgentRuntimeTypes.js';

/** v1.0 Role enum: 0 unspecified, 1 user, 2 agent. */
const HOSTED_AGENT_ROLE_AGENT = 2;
export const HOSTED_AGENT_TOOL_ROUNDS = 8;
/** Turns remembered per conversation, and conversations remembered per agent. Memory only: a restart forgets. */
const HOSTED_AGENT_HISTORY_TURNS = 20;
const HOSTED_AGENT_HISTORY_CONTEXTS = 1000;
const HOSTED_AGENT_MAX_INPUT_CHARS = 50_000;

/** Every text part the caller sent, in either protocol's part shape (see news-agent `textOf`). */
export const hostedAgentTextOf = (message: unknown): string => (((message as { parts?: unknown[] } | undefined)?.parts ?? []) as Record<string, unknown>[])
  .map((p) => {
    const content = p?.content as { $case?: string; value?: unknown } | undefined;
    if (content?.$case === 'text' && typeof content.value === 'string') return content.value;
    if ((p?.kind === 'text' || p?.type === 'text') && typeof p.text === 'string') return p.text;
    return null;
  })
  .filter((t): t is string => t !== null)
  .join('\n').trim();

const hostedAgentTextPart = (text: string) => ({ content: { $case: 'text', value: text } });

/** Conversation memory, bounded both ways. Keys are caller-chosen, so the map is capped rather than trusted. */
export class HostedAgentHistory {
  private readonly byContext = new Map<string, HostedAgentChatMessage[]>();

  get(contextId: string): HostedAgentChatMessage[] {
    return [...(this.byContext.get(contextId) ?? [])];
  }

  append(contextId: string, turn: HostedAgentChatMessage[]): void {
    const next = [...(this.byContext.get(contextId) ?? []), ...turn].slice(-HOSTED_AGENT_HISTORY_TURNS * 2);
    this.byContext.delete(contextId);
    this.byContext.set(contextId, next);
    while (this.byContext.size > HOSTED_AGENT_HISTORY_CONTEXTS) {
      const oldest = this.byContext.keys().next().value;
      if (oldest === undefined) break;
      this.byContext.delete(oldest);
    }
  }
}

const systemMessages = (prompt: string): HostedAgentChatMessage[] => (prompt.trim() ? [{ role: 'system', content: prompt }] : []);

/** The user's words as the model reads them: the message, plus what is attached (never the links). */
const userContentOf = (ctx: HostedAgentCtx) => ctx.input.text + hostedAgentAttachmentNote(ctx.input.files);

async function promptTurn(ctx: HostedAgentCtx): Promise<HostedAgentReply> {
  const choice = await ctx.llm.chat({
    messages: [...systemMessages(ctx.spec.systemPrompt), ...ctx.input.history, { role: 'user', content: userContentOf(ctx) }],
  });
  return choice.message.content ?? '';
}

/**
 * A backend that cannot do OpenAI function calling says so in one of a few ways. vLLM started without
 * `--enable-auto-tool-choice` answers 400 "auto tool choice requires …"; others reject the `tools` field.
 */
export const hostedAgentNativeToolsUnsupported = (message: string) =>
  /tool[ _-]?choice|tool-call-parser|tools? (?:are|is) not supported|unrecognized.*tools|extra.*tools/i.test(message);

/** Once a backend has refused native tools, this process stops asking — every turn would pay for the refusal. */
let hostedAgentNativeToolsRefused = false;

type ToolCall = { name: string; args: Record<string, unknown>; id: string };
type HostedAgentJsonToolReply = { tool?: unknown; arguments?: unknown; answer?: unknown };

/**
 * The function-calling loop.
 *
 * Native OpenAI tools first. When the backend refuses them, the same loop runs over a JSON protocol instead: the
 * tools are described in the system prompt and the model answers `{"tool": …, "arguments": …}` or
 * `{"answer": …}` — slower and less reliable than native calls, but it works on any chat model.
 *
 * A tool that throws does not end the turn: its error goes back to the model as the tool's result, which is what
 * lets a model recover from a bad argument. An unknown tool name is answered the same way. Running out of rounds
 * is reported, not papered over with whatever the last message said.
 */
export async function hostedAgentToolsTurn(ctx: HostedAgentCtx, mod: HostedAgentModule): Promise<HostedAgentReply> {
  const tools = mod.tools ?? [];
  const byName = new Map(tools.map((t) => [t.name, t]));
  const ui: Record<string, unknown>[] = [];

  const runTool = async (call: ToolCall): Promise<string> => {
    const tool = byName.get(call.name);
    let result: unknown;
    try {
      if (!tool) throw new Error(`no tool named ${call.name}`);
      result = await tool.run(call.args, ctx);
      // A tool may hand back a surface to show; it is collected for the reply and the model sees only the data.
      if (result && typeof result === 'object' && Array.isArray((result as { ui?: unknown }).ui)) {
        ui.push(...((result as { ui: Record<string, unknown>[] }).ui));
        const { ui: _drop, ...rest } = result as Record<string, unknown>;
        result = rest;
      }
    } catch (e) {
      result = { error: e instanceof Error ? e.message : String(e) };
    }
    return typeof result === 'string' ? result : JSON.stringify(result ?? null);
  };

  const conversation = (system: string): HostedAgentChatMessage[] =>
    [...systemMessages(system), ...ctx.input.history, { role: 'user', content: userContentOf(ctx) }];

  if (!hostedAgentNativeToolsRefused) {
    const offered = tools.map((t) => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.parameters ?? { type: 'object', properties: {} } } }));
    const messages = conversation(ctx.spec.systemPrompt);
    try {
      for (let round = 0; round < HOSTED_AGENT_TOOL_ROUNDS; round++) {
        const choice = await ctx.llm.chat({ messages, tools: offered });
        const calls = choice.message.tool_calls ?? [];
        if (!calls.length) return { text: choice.message.content ?? '', ui };
        messages.push({ role: 'assistant', content: choice.message.content ?? null, tool_calls: calls });
        for (const call of calls) {
          let args: Record<string, unknown> = {};
          try { args = call.function.arguments ? JSON.parse(call.function.arguments) as Record<string, unknown> : {}; } catch { /* the tool sees {} and can say so */ }
          messages.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: await runTool({ name: call.function.name, args, id: call.id }) });
        }
      }
      return { text: `Stopped after ${HOSTED_AGENT_TOOL_ROUNDS} tool rounds without a final answer.`, ui };
    } catch (e) {
      if (!hostedAgentNativeToolsUnsupported(e instanceof Error ? e.message : String(e))) throw e;
      hostedAgentNativeToolsRefused = true;
      ctx.log('the model backend refused native tool calls; using the JSON tool protocol');
    }
  }

  const described = tools.map((t) => `- ${t.name}: ${t.description ?? ''}\n  arguments (JSON Schema): ${JSON.stringify(t.parameters ?? { type: 'object', properties: {} })}`).join('\n');
  const protocol = `${ctx.spec.systemPrompt}\n\nYou can use these tools:\n${described}\n\n`
    + 'Reply with ONE JSON object and nothing else. To use a tool: {"tool": "<name>", "arguments": {…}}. '
    + 'When you have the final answer: {"answer": "<text for the user>"}. Tool results arrive as messages starting with TOOL RESULT.';
  const messages = conversation(protocol.trim());
  for (let round = 0; round < HOSTED_AGENT_TOOL_ROUNDS; round++) {
    const choice = await ctx.llm.chat({ messages, temperature: 0 });
    const raw = (choice.message.content ?? '').trim();
    let parsed: HostedAgentJsonToolReply | null = null;
    try { parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '')) as HostedAgentJsonToolReply; } catch { parsed = null; }
    if (!parsed || typeof parsed.tool !== 'string') {
      // `{"answer": 5555}` is an answer too; only a reply that is not the protocol at all is passed through raw.
      const answer = parsed && 'answer' in parsed ? parsed.answer : undefined;
      return { text: answer === undefined ? raw : typeof answer === 'string' ? answer : JSON.stringify(answer), ui };
    }
    messages.push({ role: 'assistant', content: raw });
    const args = parsed.arguments && typeof parsed.arguments === 'object' ? parsed.arguments as Record<string, unknown> : {};
    messages.push({ role: 'user', content: `TOOL RESULT (${parsed.tool}): ${await runTool({ name: parsed.tool, args, id: `json-${round}` })}` });
  }
  return { text: `Stopped after ${HOSTED_AGENT_TOOL_ROUNDS} tool rounds without a final answer.`, ui };
}

/** Tests reset the process-wide memory of a refusing backend. */
export const resetHostedAgentNativeToolsRefusedForTest = () => { hostedAgentNativeToolsRefused = false; };

export interface HostedAgentExecutorOptions extends HostedAgentCtxOptions {
  module: HostedAgentModule | null;
}

export class HostedAgentExecutor implements AgentExecutor {
  private readonly history = new HostedAgentHistory();

  constructor(private readonly o: HostedAgentExecutorOptions) {}

  async turn(text: string, contextId: string, files: HostedAgentAttachment[] = []): Promise<{ text: string; parts: unknown[] }> {
    const ctx = createHostedAgentCtx(this.o, { text, contextId, history: this.history.get(contextId), files });
    const { mode } = this.o.spec;
    // Attachments come with a way to open them: prompt and tools agents get `read_attachment` beside their own.
    const attachmentTools = files.length ? [hostedAgentReadAttachmentTool(files)] : [];
    let reply: HostedAgentReply;
    if (mode === 'prompt') {
      reply = attachmentTools.length ? await hostedAgentToolsTurn(ctx, { tools: attachmentTools }) : await promptTurn(ctx);
    } else if (mode === 'tools') {
      if (!this.o.module?.tools?.length) throw new Error('this agent is in tools mode but its code exports no tools');
      reply = await hostedAgentToolsTurn(ctx, { ...this.o.module, tools: [...this.o.module.tools, ...attachmentTools] });
    } else {
      if (typeof this.o.module?.execute !== 'function') throw new Error('this agent is in handler mode but its code exports no execute()');
      reply = await this.o.module.execute(text, ctx);
    }
    const shaped = typeof reply === 'string' ? { text: reply } : (reply ?? {});
    const answer = typeof shaped.text === 'string' ? shaped.text : '';
    // Remembered with the attachment note, so "and the second file?" next turn still means something — the link
    // itself is not kept: it expires in minutes, and the next message carries fresh ones if the sender wants.
    this.history.append(contextId, [{ role: 'user', content: text + hostedAgentAttachmentHistoryNote(files) }, { role: 'assistant', content: answer }]);
    return { text: answer, parts: [...(shaped.parts ?? []), ...(shaped.ui ?? []).map(hostedAgentA2uiPart)] };
  }

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const { contextId, taskId } = requestContext;
    let text: string;
    let parts: unknown[] = [];
    const input = hostedAgentTextOf(requestContext.userMessage);
    const files = hostedAgentAttachmentsOf(requestContext.userMessage);
    try {
      if (input.length > HOSTED_AGENT_MAX_INPUT_CHARS) throw new Error(`message is ${input.length} characters; the limit is ${HOSTED_AGENT_MAX_INPUT_CHARS}`);
      ({ text, parts } = await this.turn(input, contextId, files));
    } catch (e) {
      // Reported as a failure in words. An empty reply would read as the agent choosing silence.
      text = `This agent could not answer: ${e instanceof Error ? e.message : String(e)}`;
      this.o.log('turn failed', e instanceof Error ? e.stack ?? e.message : e);
    }
    eventBus.publish(AgentEvent.message({
      kind: 'message',
      messageId: randomUUID(),
      role: HOSTED_AGENT_ROLE_AGENT,
      parts: [hostedAgentTextPart(text), ...parts],
      contextId,
      taskId,
    } as unknown as Parameters<typeof AgentEvent.message>[0]));
    eventBus.finished();
  }

  async cancelTask(): Promise<void> { /* one message per turn: nothing runs long enough to cancel */ }
}
