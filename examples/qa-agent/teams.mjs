/** Teams reads use the hosted agent's gateway and private secret, never caller credentials. */
import { randomUUID } from 'node:crypto';

const id = value => typeof value === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export class TeamsMcp {
  constructor(ctx, origin) {
    const url = new URL(origin);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error('Teams requires a configured HTTPS origin');
    }
    this.ctx = ctx;
    this.url = new URL('/api/mcp', url).href;
    this.session = null;
    this.initialized = false;
    this.tail = Promise.resolve();
  }
  async rpc(method, params, notification = false) {
    const token = this.ctx.secret('TEAMS_TOKEN');
    if (!token) throw new Error('Teams credential unavailable');
    const requestId = randomUUID();
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    if (this.initialized) headers['MCP-Protocol-Version'] = '2025-03-26';
    if (this.session) headers['Mcp-Session-Id'] = this.session;
    // The public error never embeds a request, token, response body, or transport error.
    let response;
    try {
      response = await this.ctx.fetch(this.url, { method: 'POST', headers, redirect: 'error',
        signal: AbortSignal.timeout(25_000), maxBytes: 4 * 1024 * 1024,
        body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id: requestId }), method, params }) });
    } catch { throw new Error('Teams connection failed'); }
    if (!response.ok) {
      const error = new Error('Teams request failed');
      error.sessionExpired = response.status === 404;
      throw error;
    }
    const session = response.headers.get('Mcp-Session-Id');
    if (session) this.session = session;
    if (notification) { await response.body?.cancel(); return; }
    try {
      const raw = await response.text();
      if (Buffer.byteLength(raw) > 4 * 1024 * 1024) throw new Error();
      const replies = response.headers.get('Content-Type')?.includes('text/event-stream')
        ? raw.replaceAll('\r\n', '\n').split('\n\n').map(event => event.split('\n')
          .filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n'))
          .filter(Boolean).map(data => JSON.parse(data))
        : [JSON.parse(raw)];
      const reply = replies.find(item => item?.id === requestId);
      if (!reply || reply.error || !Object.hasOwn(reply, 'result')) throw new Error();
      return reply.result;
    } catch { throw new Error('Invalid Teams response'); }
  }
  call(name, args) {
    // Serialize initialize/session changes. Read retries are safe; writes must reconcile separately.
    const run = async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          if (!this.initialized) {
            await this.rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'ainize-hosted-qa', version: '1' } });
            this.initialized = true;
            await this.rpc('notifications/initialized', {}, true);
          }
          const result = await this.rpc('tools/call', { name, arguments: args });
          if (result?.isError) throw new Error('Teams tool refused request');
          try {
            const text = result?.content?.find(part => part.type === 'text')?.text;
            return JSON.parse(text);
          } catch { throw new Error('Invalid Teams tool result'); }
        } catch (error) {
          if (error.sessionExpired && attempt === 0 && /^(read_|list_)/.test(name)) {
            this.session = null; this.initialized = false; continue;
          }
          throw error;
        }
      }
    };
    const result = this.tail.then(run);
    this.tail = result.catch(() => {});
    return result;
  }
}

export function isFixRequest(text) {
  if (typeof text !== 'string' || text.trim().length < 5 || text.length > 20_000) return false;
  if (/^\/fix\s+\S/i.test(text.trim())) return true;
  const direct = text.replace(/```[\s\S]*?```|`[^`\n]*`/g, '')
    .replace(/^\s*>[^\n]*/gm, '').replace(/"[^"\n]*"|'[^'\n]*'|“[^”\n]*”|‘[^’\n]*’/g, '');
  return /(?:고쳐\s*(?:줘|주세요)|수정해\s*(?:줘|주세요)|해결해\s*(?:줘|주세요))(?:[.!?。]+(?=\s|$)|\s*$|[ \t]*\n)/.test(direct);
}

/** Fix intake only. An LGTM must go through a separate exact-commit release verifier. */
export async function verifyFixRequest(mcp, config, locator, now = Date.now()) {
  const { workspaceId, channelId, enabledAt, maxAgeMs = 3_600_000, maxPages = 20 } = config;
  const enabled = Date.parse(enabledAt);
  if (!id(workspaceId) || !id(channelId) || !Number.isFinite(enabled)
    || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1000 || maxAgeMs > 86_400_000
    || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100 || !Number.isFinite(now)) {
    throw new Error('Invalid QA channel configuration');
  }
  if (!object(locator) || locator.workspaceId !== workspaceId || locator.channelId !== channelId
    || !id(locator.messageId) || (locator.parentId !== undefined && !id(locator.parentId))) return null;
  const rootId = locator.parentId ?? locator.messageId;
  // Verify the actual workspace/channel relationship, not just the supplied workspace id.
  const channels = await mcp.call('list_channels', { workspaceId });
  if (!Array.isArray(channels) || !channels.some(ch => ch?.id === channelId)) return null;
  let root = null, cursor;
  const seen = new Set();
  for (let page = 0; page < maxPages; page++) {
    const result = await mcp.call('read_channel', { channelId, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(result?.messages)) return null;
    root = result.messages.find(message => message?.id === rootId && !message.parentId);
    if (root) break;
    cursor = result.nextCursor;
    if (typeof cursor !== 'string' || !cursor || cursor.length > 2048 || seen.has(cursor)) return null;
    seen.add(cursor);
  }
  if (!root) return null;
  let canonical = root;
  if (rootId !== locator.messageId) {
    const thread = await mcp.call('read_thread', { messageId: rootId });
    if (thread?.parent?.id !== rootId || !Array.isArray(thread.replies)) return null;
    canonical = thread.replies.find(message => message?.id === locator.messageId && message.parentId === rootId);
  }
  if (!canonical || !id(canonical.userId) || !isFixRequest(canonical.content)) return null;
  const created = Date.parse(canonical.createdAt);
  if (!Number.isFinite(created) || created < enabled || now - created > maxAgeMs || created > now + 30_000) return null;
  // The Teams tool joins active workspace membership; display names and role hints are not authority.
  const members = await mcp.call('list_channel_members', { channelId });
  if (!Array.isArray(members) || !members.some(member => member?.userId === canonical.userId && member.isAgent === false)) return null;
  return { workspaceId, channelId, messageId: canonical.id, parentId: rootId,
    senderId: canonical.userId, text: canonical.content, createdAt: new Date(created).toISOString() };
}
