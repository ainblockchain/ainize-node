export interface ChatStreamChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: { index: number; delta: { role?: string; content?: string | null; reasoning_content?: string; reasoning?: string }; finish_reason?: string | null }[];
  usage?: Record<string, unknown> | null;
}

export async function consumeChatStream(response: Response, onChunk: (chunk: ChatStreamChunk) => Promise<void>) {
  if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) throw new Error('Serving model did not return an SSE stream');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoning = '';
  let finishReason: string | null = null;
  let usage: Record<string, unknown> | undefined;
  let finished = false;
  try {
    while (!finished) {
      const part = await reader.read();
      if (part.done) throw new Error('Serving model stream ended without [DONE]');
      buffer += decoder.decode(part.value, { stream: true });
      if (buffer.length > 1048576) throw new Error('SSE frame exceeds size limit');
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
        if (!data) continue;
        if (data === '[DONE]') { finished = true; break; }
        const chunk = JSON.parse(data) as ChatStreamChunk & { error?: unknown };
        if (chunk.error || chunk.object !== 'chat.completion.chunk' || !Array.isArray(chunk.choices)) throw new Error('Invalid upstream chat stream chunk');
        for (const choice of chunk.choices) {
          if (choice.index !== 0) throw new Error('Multiple upstream completions are not supported');
          if (typeof choice.delta?.content === 'string') content += choice.delta.content;
          reasoning += choice.delta?.reasoning_content ?? choice.delta?.reasoning ?? '';
          if (choice.finish_reason) finishReason = choice.finish_reason;
        }
        if (content.length + reasoning.length > 8388608) throw new Error('Chat stream exceeds output limit');
        if (chunk.usage) usage = chunk.usage;
        await onChunk(chunk);
      }
    }
    if (!finishReason) throw new Error('Serving model omitted finish_reason');
    return { content, reasoning: reasoning || null, finishReason, usage };
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
