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
import { hostedAgentReadPdf, isHostedAgentPdf } from './hostedAgentPdf.js';
import type { HostedAgentAttachment, HostedAgentCtx, HostedAgentTool } from './hostedAgentRuntimeTypes.js';

/** How much of a text attachment the model is given. The rest is cut, and the model is told so. */
export const HOSTED_AGENT_ATTACHMENT_TEXT_CHARS = 20_000;
/** The largest attachment an agent opens — a phone photo or a few minutes of voice. The gateway enforces it too. */
export const HOSTED_AGENT_ATTACHMENT_MAX_BYTES = 32 * 1024 * 1024;

/**
 * What a link's refusal means, in words the model can pass on.
 *
 * aindrive's handoff server answers 404 for a link it never issued, 410 for one expired or revoked, 503/504 when
 * the owner's device — which streams the bytes — is offline, and 429 when it is being asked too fast. "The link
 * answered 503" says none of that; the person on the other end needs to know whether to reopen the app, send a
 * fresh link, or wait.
 */
export function hostedAgentLinkProblem(status: number, name: string): string {
  if (status === 404) return `${name}: the link was not found — it may have been revoked; ask the sender for a fresh handoff`;
  if (status === 410) return `${name}: the link has expired or was revoked by the sender; ask for a fresh handoff`;
  if (status === 503 || status === 504) return `${name}: the sender's device is offline or unreachable, so the file cannot be read right now — ask them to open aindrive (with the drive connected) and send it again`;
  if (status === 429) return `${name}: the file server is rate-limiting requests; try again in a minute`;
  if (status === 401 || status === 403) return `${name}: access to this file was refused; ask the sender to share it again`;
  return `${name}: the link answered ${status}`;
}

/** A fetch that failed before any answer — size, policy or network — in the same plain terms. */
export function hostedAgentFetchProblem(error: unknown, name: string): string {
  const why = error instanceof Error ? error.message : String(error);
  if (/larger than/.test(why)) return `${name}: the file is larger than ${Math.round(HOSTED_AGENT_ATTACHMENT_MAX_BYTES / 1024 / 1024)} MB, which is more than this agent can open`;
  return `could not open ${name}: ${why}`;
}

const isImage = (mime: string) => /^image\/(png|jpe?g|webp|gif|bmp|heic|heif)$/i.test(mime);
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
    description: 'Open one of the files attached to this message: text and PDFs come back as text (a scanned PDF as page pictures), and a picture is shown to you so you can look at it. Only call it when the answer needs the file.',
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
          res = await ctx.fetch(f.uri!, { maxBytes: HOSTED_AGENT_ATTACHMENT_MAX_BYTES });
        } catch (e) {
          return { error: hostedAgentFetchProblem(e, f.name) };
        }
        if (!res.ok) return { error: hostedAgentLinkProblem(res.status, f.name) };
        mime = res.headers.get('content-type')?.split(';')[0] || mime;
        bytes = Buffer.from(await res.arrayBuffer());
      }
      ctx.log(`read_attachment ${f.name} (${mime}, ${bytes.length} bytes)`);
      if (isTextLike(mime)) {
        const text = bytes.toString('utf8');
        const cut = text.length > HOSTED_AGENT_ATTACHMENT_TEXT_CHARS;
        return { name: f.name, mimeType: mime, bytes: bytes.length, text: cut ? text.slice(0, HOSTED_AGENT_ATTACHMENT_TEXT_CHARS) : text, ...(cut ? { truncated: true } : {}) };
      }
      // A PDF is read (hostedAgentPdf.ts): its text, or its first pages as pictures when it is a scan.
      if (isHostedAgentPdf(mime, f.name)) {
        try {
          const pdf = await hostedAgentReadPdf(bytes);
          return { name: f.name, mimeType: mime, bytes: bytes.length, pages: pdf.pages, text: pdf.text, note: pdf.note, ...(pdf.truncated ? { truncated: true } : {}), ...(pdf.images.length ? { images: pdf.images } : {}) };
        } catch (e) {
          return { error: `${f.name}: ${e instanceof Error ? e.message : String(e)}` };
        }
      }
      // A picture goes to the model as a picture (the tools loop shows it in the next message); the result the model
      // reads here only says so. A multimodal model looks at it; a text-only one is refused by its backend, which
      // the loop reports like any other failed call.
      if (isImage(mime)) {
        return { name: f.name, mimeType: mime, bytes: bytes.length, note: 'The picture is shown to you in the next message — look at it to answer.', images: [`data:${mime};base64,${bytes.toString('base64')}`] };
      }
      return { name: f.name, mimeType: mime, bytes: bytes.length, note: 'This file is neither text nor a picture: describe it from its name, type and size.' };
    },
  };
}
