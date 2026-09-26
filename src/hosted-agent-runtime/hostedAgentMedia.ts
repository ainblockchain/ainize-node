/**
 * What an agent does with the node's speech and image models, once its owner turned them on.
 *
 *   • A voice note IS the message. A caller who records one and sends it has said something, and a small model
 *     told "an audio file is attached — open it if you need to" reliably decides it does not need to. So audio is
 *     transcribed on arrival, before the model sees the turn, and the transcript is what the model reads. The
 *     audio leaves the attachment list: there is nothing left in it for `read_attachment` to add.
 *   • A picture is something the model decides to make. `generate_image` is a tool like any other; its result
 *     tells the model the picture was made, and the picture itself rides out as a file part of the reply — the
 *     model never sees the bytes, which would be megabytes of base64 in its context for nothing.
 *
 * Self-contained like the rest of this directory: it runs in the node process and in a container.
 */
import type {
  HostedAgentAttachment, HostedAgentCtx, HostedAgentGeneratedImage, HostedAgentTool,
} from './hostedAgentRuntimeTypes.js';

const isAudio = (mime: string) => /^audio\//i.test(mime) || /^video\/(webm|mp4|ogg)$/i.test(mime);

/** The bytes of one attachment: inline, or fetched through the egress door like `read_attachment` does. */
async function hostedAgentAttachmentBytes(ctx: HostedAgentCtx, f: HostedAgentAttachment): Promise<{ bytes: Buffer; mimeType: string }> {
  if (f.bytesBase64 !== undefined) return { bytes: Buffer.from(f.bytesBase64, 'base64'), mimeType: f.mimeType };
  const res = await ctx.fetch(f.uri!);
  if (res.status === 410) throw new Error('the link has expired or was revoked by the sender');
  if (!res.ok) throw new Error(`the link answered ${res.status}`);
  return { bytes: Buffer.from(await res.arrayBuffer()), mimeType: res.headers.get('content-type')?.split(';')[0] || f.mimeType };
}

/**
 * Transcribe every audio attachment. Returns the text to add to the user's message and the attachments that are
 * left for `read_attachment`. A voice note that cannot be transcribed stays an attachment and the model is told
 * why, rather than the turn failing: the rest of the message may still be answerable.
 */
export async function hostedAgentTranscribeAudio(ctx: HostedAgentCtx, files: HostedAgentAttachment[]): Promise<{ transcript: string; rest: HostedAgentAttachment[] }> {
  const transcribe = ctx.media.transcribe;
  if (!transcribe || !files.some((f) => isAudio(f.mimeType))) return { transcript: '', rest: files };
  const lines: string[] = [];
  const rest: HostedAgentAttachment[] = [];
  for (const f of files) {
    if (!isAudio(f.mimeType)) { rest.push(f); continue; }
    try {
      const { bytes, mimeType } = await hostedAgentAttachmentBytes(ctx, f);
      const text = (await transcribe({ bytesBase64: bytes.toString('base64'), name: f.name, mimeType })).trim();
      ctx.log(`transcribed ${f.name} (${mimeType}, ${bytes.length} bytes, ${text.length} chars)`);
      lines.push(`[Voice message ${f.name}, transcribed]\n${text || '(no speech detected)'}`);
    } catch (e) {
      rest.push(f);
      lines.push(`[Voice message ${f.name} could not be transcribed: ${e instanceof Error ? e.message : String(e)}]`);
    }
  }
  return { transcript: lines.join('\n\n'), rest };
}

/** The A2A v1.0 file part for a generated picture — the same shape `hostedAgentAttachmentsOf` reads. */
export const hostedAgentImagePart = (image: HostedAgentGeneratedImage, filename: string) => ({
  content: { $case: 'raw', value: Buffer.from(image.bytesBase64, 'base64') },
  filename,
  mediaType: image.mimeType,
});

/**
 * The built-in image tool. Its result carries `parts`, which the tools loop collects for the reply exactly as it
 * collects `ui` — and strips before the model reads the result.
 */
export function hostedAgentGenerateImageTool(): HostedAgentTool {
  let made = 0;
  return {
    name: 'generate_image',
    description: 'Draw a picture from a text description and attach it to your reply. Call it only when the user asks for an image. '
      + 'Write the prompt in English, concrete and visual (subject, style, composition, lighting). The user sees the picture; describe it briefly in your answer.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What to draw, in English.' },
        size: { type: 'string', description: 'WIDTHxHEIGHT, e.g. 1024x1024 (square), 1344x768 (wide), 768x1344 (tall). Default 1024x1024.' },
      },
      required: ['prompt'],
    },
    async run(args: Record<string, unknown>, ctx: HostedAgentCtx) {
      if (!ctx.media.generateImage) return { error: 'image generation is not turned on for this agent' };
      const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
      if (!prompt) return { error: 'prompt is required' };
      const size = typeof args.size === 'string' && /^\d{3,4}x\d{3,4}$/.test(args.size) ? args.size : undefined;
      const image = await ctx.media.generateImage({ prompt, size });
      made += 1;
      const filename = `image-${made}.${image.mimeType === 'image/jpeg' ? 'jpg' : 'png'}`;
      ctx.log(`generate_image ${filename} (${Math.round(image.bytesBase64.length * 0.75)} bytes)`);
      return { ok: true, attached: filename, note: 'The picture is attached to your reply; the user can see it.', parts: [hostedAgentImagePart(image, filename)] };
    },
  };
}
