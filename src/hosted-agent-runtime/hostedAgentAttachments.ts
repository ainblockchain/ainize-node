/**
 * Files a caller attached to a message — and the built-in tool that reads one only when the model asks.
 *
 * A caller that keeps its files private sends a LINK, not the bytes (aindrive's file handoff: a short-lived,
 * revocable, logged URL per picked file). Fetching it is what moves the bytes, so the agent must not fetch on
 * arrival: the model is told what is attached and gets `read_attachment`, and a link is opened only if the model
 * decides the answer needs it. The fetch goes through the node's egress door like any other (`ctx.fetch`), so the
 * agent's `allowedHosts` must name the host that serves the links.
 *
 * Both part shapes are read: v1.0 (`content.$case` "url" / "raw", `filename`, `mediaType`) and v0.3
 * (`kind: "file"`, `file: { uri | bytes, name, mimeType }`) — the compat layer converts, but tests and direct callers
 * may hand either.
 */
import type { HostedAgentAttachment, HostedAgentCtx, HostedAgentTool } from './hostedAgentRuntimeTypes.js';

/** How much of a text attachment the model is given. The rest is cut, and the model is told so. */
export const HOSTED_AGENT_ATTACHMENT_TEXT_CHARS = 20_000;
const HOSTED_AGENT_ATTACHMENT_MAX = 20;

export function hostedAgentAttachmentsOf(message: unknown): HostedAgentAttachment[] {
  const parts = (((message as { parts?: unknown[] } | undefined)?.parts ?? []) as Record<string, unknown>[]);
  const out: HostedAgentAttachment[] = [];
  for (const p of parts) {
    const content = p?.content as { $case?: string; value?: unknown } | undefined;
    if (content?.$case === 'url' && typeof content.value === 'string') {
      out.push({ uri: content.value, name: String(p.filename || 'file'), mimeType: String(p.mediaType || 'application/octet-stream') });
    } else if (content?.$case === 'raw' && content.value) {
      out.push({ bytesBase64: Buffer.from(content.value as Uint8Array).toString('base64'), name: String(p.filename || 'file'), mimeType: String(p.mediaType || 'application/octet-stream') });
    } else if ((p?.kind === 'file' || p?.type === 'file') && p.file && typeof p.file === 'object') {
      const f = p.file as { uri?: unknown; bytes?: unknown; name?: unknown; mimeType?: unknown };
      const base = { name: String(f.name || 'file'), mimeType: String(f.mimeType || 'application/octet-stream') };
      if (typeof f.uri === 'string') out.push({ ...base, uri: f.uri });
      else if (typeof f.bytes === 'string') out.push({ ...base, bytesBase64: f.bytes });
    }
  }
  return out.slice(0, HOSTED_AGENT_ATTACHMENT_MAX);
}

/** What the model reads about the attachments, appended to the user's message. Links are NOT shown to it. */
export function hostedAgentAttachmentNote(files: HostedAgentAttachment[]): string {
  if (!files.length) return '';
  const lines = files.map((f, i) => `${i + 1}. ${f.name} (${f.mimeType})`);
  return `\n\n[Attached files — not opened yet. Open one with read_attachment ONLY when the request cannot be answered without its contents; thanks, greetings and questions about something else need no file. Every open is logged by the sender.]\n${lines.join('\n')}`;
}

/** How an earlier turn's attachments are remembered: named, but no longer openable (their links were that turn's). */
export function hostedAgentAttachmentHistoryNote(files: HostedAgentAttachment[]): string {
  if (!files.length) return '';
  return `\n\n[Files attached to this earlier message, no longer available: ${files.map((f) => `${f.name} (${f.mimeType})`).join(', ')}]`;
}

const isTextLike = (mime: string) => /^text\/|[/+](json|xml|csv|yaml|javascript|markdown)\b|^application\/(json|xml|x-yaml|sql)/i.test(mime);

/** The built-in tool. Text comes back as text; anything else as what it is, since the model reads text only. */
export function hostedAgentReadAttachmentTool(files: HostedAgentAttachment[]): HostedAgentTool {
  return {
    name: 'read_attachment',
    description: 'Open one of the files attached to this message and return its contents (text files) or a description (other files). Only call it when the answer needs the file.',
    parameters: {
      type: 'object',
      properties: { number: { type: 'integer', description: 'The file number from the attached-files list (1 = first).' } },
      required: ['number'],
    },
    async run(args: Record<string, unknown>, ctx: HostedAgentCtx) {
      const n = Number(args.number);
      const f = Number.isInteger(n) ? files[n - 1] : undefined;
      if (!f) return { error: `no attachment number ${String(args.number)}; there are ${files.length}` };
      let bytes: Buffer;
      let mime = f.mimeType;
      if (f.bytesBase64 !== undefined) {
        bytes = Buffer.from(f.bytesBase64, 'base64');
      } else {
        let res: Response;
        try {
          res = await ctx.fetch(f.uri!);
        } catch (e) {
          return { error: `could not open ${f.name}: ${e instanceof Error ? e.message : String(e)}` };
        }
        // A handoff link answers 410 once it has expired or been revoked; the sender decided that, say so plainly.
        if (res.status === 410) return { error: `${f.name}: the link has expired or was revoked by the sender` };
        if (!res.ok) return { error: `${f.name}: the link answered ${res.status}` };
        mime = res.headers.get('content-type')?.split(';')[0] || mime;
        bytes = Buffer.from(await res.arrayBuffer());
      }
      ctx.log(`read_attachment ${f.name} (${mime}, ${bytes.length} bytes)`);
      if (isTextLike(mime)) {
        const text = bytes.toString('utf8');
        const cut = text.length > HOSTED_AGENT_ATTACHMENT_TEXT_CHARS;
        return { name: f.name, mimeType: mime, bytes: bytes.length, text: cut ? text.slice(0, HOSTED_AGENT_ATTACHMENT_TEXT_CHARS) : text, ...(cut ? { truncated: true } : {}) };
      }
      return { name: f.name, mimeType: mime, bytes: bytes.length, note: 'This is not a text file, and this model reads text only: describe it from its name, type and size.' };
    },
  };
}
