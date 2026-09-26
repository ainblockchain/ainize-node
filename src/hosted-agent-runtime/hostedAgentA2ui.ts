/**
 * A2UI for hosted agents — the same wire shapes news-agent emits (v0.9 messages, basic catalog), offered as
 * helpers so an agent's author writes components rather than envelopes.
 *
 * A surface travels as DATA PARTS next to the text part, never instead of it: a client that does not draw A2UI
 * still gets the answer.
 */
import type { HostedAgentUiHelpers, HostedAgentUiMessage } from './hostedAgentRuntimeTypes.js';

export const HOSTED_AGENT_A2UI_VERSION = 'v0.9';
export const HOSTED_AGENT_A2UI_MIME = 'application/json+a2ui';
export const HOSTED_AGENT_A2UI_EXTENSION_URI = 'https://a2ui.org/a2a-extension/a2ui/v0.9';
export const HOSTED_AGENT_A2UI_CATALOG = 'https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json';

export const hostedAgentA2uiExtension = () => ({
  uri: HOSTED_AGENT_A2UI_EXTENSION_URI,
  description: 'Answers may carry an A2UI surface alongside the text',
  required: false,
  params: { supportedCatalogIds: [HOSTED_AGENT_A2UI_CATALOG], acceptsInlineCatalogs: false },
});

/** One A2UI message as a v1.0 data part. The compat layer renders it as `{ kind: 'data' }` for a v0.3 caller. */
export const hostedAgentA2uiPart = (message: HostedAgentUiMessage) => ({
  content: { $case: 'data', value: message },
  metadata: { mimeType: HOSTED_AGENT_A2UI_MIME },
  mediaType: HOSTED_AGENT_A2UI_MIME,
});

export const hostedAgentUiHelpers: HostedAgentUiHelpers = {
  surface(surfaceId, components, data) {
    const out: HostedAgentUiMessage[] = [
      { version: HOSTED_AGENT_A2UI_VERSION, createSurface: { surfaceId, catalogId: HOSTED_AGENT_A2UI_CATALOG, theme: {}, sendDataModel: false } },
      { version: HOSTED_AGENT_A2UI_VERSION, updateComponents: { surfaceId, components } },
    ];
    if (data) out.push({ version: HOSTED_AGENT_A2UI_VERSION, updateDataModel: { surfaceId, path: '/', value: data } });
    return out;
  },
  text: (id, text, variant) => ({ id, component: 'Text', text, ...(variant ? { variant } : {}) }),
  column: (id, children) => ({ id, component: 'Column', children }),
  row: (id, children) => ({ id, component: 'Row', children }),
  card: (id, child) => ({ id, component: 'Card', child }),
  divider: (id) => ({ id, component: 'Divider' }),
  list: (id, dataPath, templateComponentId) => ({ id, component: 'List', children: { template: { dataPath, componentId: templateComponentId } } }),
  bind: (path) => ({ path }),
};
