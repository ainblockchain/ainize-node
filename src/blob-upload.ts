import { randomUUID } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { Readable } from 'node:stream';

export interface BlobUploadResponse {
  status: number;
  contentType: string;
  body: string;
}

export async function uploadBlob(endpoint: string, sha: string, path: string, authorization: string, timeoutMs = 60_000): Promise<BlobUploadResponse> {
  const url = new URL(endpoint);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('invalid blob upload URL');
  if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error('invalid blob SHA');
  const file = statSync(path);
  if (!file.isFile() || !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > 256 * 1024 ** 2) throw new Error('blob exceeds upload size bounds');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error('invalid blob upload deadline');
  const boundary = `ainize-${randomUUID()}`;
  const prefix = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="blob"; filename="${sha}.npz"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  const source = createReadStream(path, { end: file.size - 1 });
  const body = Readable.from((async function* () {
    yield prefix;
    for await (const chunk of source) yield chunk;
    yield suffix;
  })());
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(new Error('blob upload deadline exceeded')), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST', body: body as unknown as NonNullable<RequestInit['body']>, duplex: 'half', redirect: 'manual', signal: controller.signal,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(prefix.length + file.size + suffix.length), 'x-ainize-auth': authorization },
    } as RequestInit & { duplex: 'half' });
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (!response.body) throw new Error('relay acknowledgment is empty');
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 4096) throw new Error('relay acknowledgment exceeds the limit');
      chunks.push(chunk);
    }
    return { status: response.status, contentType: response.headers.get('content-type') ?? '', body: Buffer.concat(chunks).toString('utf8') };
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(deadline);
    controller.abort();
    body.destroy();
    source.destroy();
  }
}
