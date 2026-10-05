/** A lookup hint only. The handler must re-read the canonical message and membership. */
export interface HostedAgentTeamsLocator {
  workspaceId: string;
  channelId: string;
  messageId: string;
  parentId: string;
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(value);

/** Never forward caller-supplied sender, role, text, history, org claims or tokens. */
export function hostedAgentTeamsLocatorOf(message: unknown): HostedAgentTeamsLocator | undefined {
  const meta = record(record(message).metadata);
  const workspace = record(meta.workspace);
  const location = record(meta.location);
  const current = record(record(meta.conversation).current);
  if (!id(workspace.id) || !id(location.id) || !id(current.id)) return;
  if (location.kind !== 'channel' && location.kind !== 'thread') return;
  if (location.parentId != null && !id(location.parentId)) return;
  if (location.kind === 'thread' && !id(location.parentId)) return;
  return { workspaceId: workspace.id, channelId: location.id, messageId: current.id,
    parentId: id(location.parentId) ? location.parentId : current.id };
}
