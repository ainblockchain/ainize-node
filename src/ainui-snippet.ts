/**
 * AIN-UI link snippets for projects (aindrive docs/AINUI-LINK-SNIPPETS.md; the short version is in
 * docs/PROJECTS.md "Link snippets"): what a chat shows when `https://ainize.ai/<org>/<repo>` or
 * `https://ainize.ai/projects/<id>` is pasted — the deploy status card, the Run form of a `script` project, and
 * Redeploy for the owner. Pure builders: no store, no HTTP, so the surface shape is testable on its own.
 *
 * The surface is A2UI v0.9 messages over the BASIC catalog, using only the components every consumer renderer
 * already draws for hosted agents (hosted-agent-runtime/hostedAgentA2ui.ts emits the same vocabulary): Column,
 * Row, Card, Text, Divider, TextField, Button. Component ids are the contract (§2.1 of the doc).
 */
import type { Deployment, Project } from './projects.js';
import { inputEnvName, type ProjectManifestInput } from './project-manifest.js';

export const AINUI_MEDIA_TYPE = 'application/vnd.ain.ui+json';
export const AINUI_ENVELOPE_VERSION = 1;
export const A2UI_VERSION = 'v0.9';
export const A2UI_BASIC_CATALOG = 'https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json';

/** `Accept` asks for the snippet and not for a page: the UI media type is present, `text/html` is not. */
export function wantsAinui(accept: string | null | undefined): boolean {
  const a = (accept ?? '').toLowerCase();
  return a.includes(AINUI_MEDIA_TYPE) && !a.includes('text/html');
}

export type A2uiComponent = { id: string; component: string } & Record<string, unknown>;
export type A2uiMessage =
  | { version: typeof A2UI_VERSION; createSurface: { surfaceId: string; catalogId: string } }
  | { version: typeof A2UI_VERSION; updateComponents: { surfaceId: string; components: A2uiComponent[] } }
  | { version: typeof A2UI_VERSION; updateDataModel: { surfaceId: string; path: string; value: Record<string, unknown> } };

export type SnippetAction =
  | { method: 'GET'; url: string; navigate: true }
  | { method: 'POST'; url: string; body: Record<string, unknown>; stream?: 'sse'; output?: { path: string; status: string } };

export interface AinuiSnippet {
  ainui: typeof AINUI_ENVELOPE_VERSION;
  kind: 'ainize.project' | 'denied';
  title: string;
  subtitle?: string;
  icon?: 'git' | 'file' | 'deploy' | 'lock';
  url: string;
  surface: A2uiMessage[];
  actions: Record<string, SnippetAction>;
  refresh?: number;
}

/**
 * What a pasted ainize URL names: `/projects/<id>` or the pretty `/<org>/<repo>`. `url` is the absolute URL as
 * pasted (or a path), `base` this node's public URL; another host, a reserved first segment or anything deeper is
 * null. The pretty form is the one ainize-web's project pages use (`Project.url`); the list of reserved names mirrors
 * the app's own top-level routes so `/projects/new` or `/me/projects` is never read as an organization.
 */
const RESERVED = new Set(['api', 'agents', 'projects', 'me', 'docs', 'models', 'teach', 'chat', 'signing', 'login', 'x402', 'p2p', 'v1', 'svc', 'network', 'registry', 'static', '_next', 'kpi', 'explore', 'org', 'orgs', 'settings', 'keys', 'new']);
export type SnippetTarget = { projectId: string } | { org: string; repo: string };
export function parseSnippetUrl(url: string, base: string): SnippetTarget | null {
  let pathname: string;
  try {
    const u = new URL(url, base);
    if (new URL(base).host && u.host !== new URL(base).host) return null;
    pathname = u.pathname;
  } catch { return null; }
  const segs = pathname.split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return ''; } });
  if (segs.some((s) => !s || s === '.' || s === '..')) return null;
  if (segs[0] === 'projects' && segs.length === 2 && /^prj_[0-9a-f]+$/.test(segs[1]!)) return { projectId: segs[1]! };
  if (segs.length === 2 && !RESERVED.has(segs[0]!.toLowerCase()) && !segs[0]!.startsWith('.')) return { org: segs[0]!, repo: segs[1]!.replace(/\.git$/, '') };
  return null;
}

// ------------------------------------------------------------------------------------------ components

const bind = (path: string) => ({ path });
const text = (id: string, t: string | { path: string }, variant?: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'caption' | 'body'): A2uiComponent =>
  ({ id, component: 'Text', text: t, ...(variant ? { variant } : {}) });
const column = (id: string, children: string[]): A2uiComponent => ({ id, component: 'Column', children });
const row = (id: string, children: string[]): A2uiComponent => ({ id, component: 'Row', children, align: 'center' });
const card = (id: string, child: string): A2uiComponent => ({ id, component: 'Card', child });
const divider = (id: string): A2uiComponent => ({ id, component: 'Divider' });
function button(id: string, label: string, action: string, opts: { context?: Record<string, unknown>; variant?: 'primary' | 'borderless' } = {}): A2uiComponent[] {
  return [
    text(`${id}.label`, label),
    { id, component: 'Button', child: `${id}.label`, action: { event: { name: action, ...(opts.context ? { context: opts.context } : {}) } }, ...(opts.variant ? { variant: opts.variant } : {}) },
  ];
}
function surface(surfaceId: string, components: A2uiComponent[], data: Record<string, unknown>): A2uiMessage[] {
  return [
    { version: A2UI_VERSION, createSurface: { surfaceId, catalogId: A2UI_BASIC_CATALOG } },
    { version: A2UI_VERSION, updateComponents: { surfaceId, components } },
    { version: A2UI_VERSION, updateDataModel: { surfaceId, path: '/', value: data } },
  ];
}

const shortSha = (sha: string) => sha.slice(0, 7);
function relativeTime(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}
const DOT: Record<string, string> = { ready: '● ready', building: '● building', queued: '● queued', error: '● error' };

/** `ainize.json` `inputs` as the form needs them: declaration order, the default as text. */
export type SnippetInput = { name: string; description: string | null; type: 'string' | 'choice' | 'boolean' | 'number'; required: boolean; options: string[] | null; default: string | null };
export function snippetInputsOf(inputs: ProjectManifestInput['inputs'] | undefined): SnippetInput[] {
  return Object.entries(inputs ?? {}).map(([name, spec]) => ({
    name, description: spec.description?.trim() || null, type: spec.type ?? 'string', required: spec.required === true,
    options: spec.type === 'choice' ? (spec.options ?? []) : null,
    default: spec.default === undefined ? null : String(spec.default),
  }));
}

/** The Run card: fields bound to `/inputs/<NAME>`, ▶ Run → `run` with `INPUT_<NAME>` context, output bound to `/run/*`. */
export function runBlock(entry: string, inputs: SnippetInput[]): { components: A2uiComponent[]; data: Record<string, unknown>; context: Record<string, unknown> } {
  const comps: A2uiComponent[] = [];
  const fields: string[] = [];
  const inputsData: Record<string, string | string[]> = {};
  const context: Record<string, unknown> = {};
  for (const i of inputs) {
    const id = `run.input.${i.name}`;
    const path = `/inputs/${i.name}`;
    let label = i.description ?? i.name;
    if (i.required) label += ' *';
    if (i.type === 'choice' && i.options) label += ` (${i.options.join(' | ')})`;
    if (i.type === 'boolean') label += ' (true | false)';
    const options = i.type === 'choice' ? i.options : i.type === 'boolean' ? ['true', 'false'] : null;
    comps.push(options ? { id, component: 'ChoicePicker', label, value: bind(path), variant: 'mutuallyExclusive', options: options.map((value) => ({ label: value, value })) } : { id, component: 'TextField', label, value: bind(path), ...(i.type === 'number' ? { variant: 'number' } : {}) });
    fields.push(id);
    inputsData[i.name] = options ? (i.default === null ? [] : [i.default]) : i.default ?? '';
    context[inputEnvName(i.name)] = bind(path);
  }
  comps.push(text('run.entry', `▶ Run ${entry}`, 'h5'));
  comps.push(...button('run.button', 'Run', 'run', { context, variant: 'primary' }));
  comps.push(row('run.controls', ['run.entry', 'run.button', 'run.status']));
  comps.push(text('run.status', bind('/run/status'), 'caption'));
  comps.push(text('run.output', bind('/run/output'), 'body'));
  comps.push(column('run.body', [...fields, 'run.controls', 'run.output']));
  comps.push(card('run', 'run.body'));
  return { components: comps, data: { inputs: inputsData, run: { status: 'idle', output: '' } }, context };
}

export interface ProjectSnippetInput {
  project: Project;
  /** newest first; the first three are shown */
  deployments: Deployment[];
  /** this node's public base (no trailing slash) — action URLs and links are built on it */
  base: string;
  /** the `/<org>/<repo>` page and the `/projects/<id>` page */
  pageUrl: string;
  /** the deployed commit's run form — `script` projects with a deployment that recorded its manifest */
  run: { entry: string; inputs: SnippetInput[]; sha?: string } | null;
  /** owner: may redeploy */
  canRedeploy: boolean;
  now?: number;
}

export function projectSnippet(i: ProjectSnippetInput): AinuiSnippet {
  const { project: p, base } = i;
  const now = i.now ?? Date.now();
  const actions: Record<string, SnippetAction> = {
    'open:inspect': { method: 'GET', url: i.pageUrl, navigate: true },
    'open:aindrive': { method: 'GET', url: p.repo, navigate: true },
  };
  const comps: A2uiComponent[] = [];
  const sections: string[] = ['header'];
  const last = i.deployments[0] ?? null;
  const statusLine = last ? `${DOT[last.status] ?? `● ${last.status}`} ${shortSha(last.sha)}` : '● idle · no deployment yet';
  comps.push(text('header.title', p.name, 'h4'), text('header.sub', `${p.org}/${p.repoName} · ${p.branch} · ${statusLine}`, 'caption'), row('header', ['header.title', 'header.sub']));

  // Deployments: the newest three as static rows (no List templates — their v0.9 spelling differs between renderers).
  comps.push(text('deployments.title', `Deployments · ${p.kind ?? 'unknown kind'} · ${p.branch}`, 'h5'));
  const rows = ['deployments.title'];
  if (i.deployments.length === 0) { comps.push(text('deployments.empty', `No deployments yet — push to ${p.branch}.`, 'caption')); rows.push('deployments.empty'); }
  i.deployments.slice(0, 3).forEach((d, n) => {
    const id = `deployments.${n}`;
    const at = d.finishedAt ?? d.startedAt ?? d.createdAt;
    const label = `${DOT[d.status] ?? `● ${d.status}`}  ${shortSha(d.sha)}${d.status === 'error' && d.exitCode != null ? ` (exit ${d.exitCode})` : ''}${at ? ` · ${relativeTime(at, now)}` : ''}`;
    comps.push(text(`${id}.text`, label, 'body'));
    const children = [`${id}.text`];
    actions[`open:inspect:${n}`] = { method: 'GET', url: `${base}/projects/${p.id}`, navigate: true };
    comps.push(...button(`${id}.inspect`, 'Inspect', `open:inspect:${n}`, { variant: 'borderless' }));
    children.push(`${id}.inspect`);
    if (d.status === 'ready' && d.outputUrl) {
      actions[`open:visit:${n}`] = { method: 'GET', url: d.outputUrl, navigate: true };
      comps.push(...button(`${id}.visit`, 'Visit', `open:visit:${n}`, { variant: 'borderless' }));
      children.push(`${id}.visit`);
    }
    comps.push(row(id, children));
    rows.push(id);
  });
  comps.push(column('deployments.body', rows), card('deployments', 'deployments.body'));
  sections.push('deployments');

  let data: Record<string, unknown> = {};
  if (i.run) {
    const r = runBlock(i.run.entry, i.run.inputs);
    if (i.run.sha) r.components.push(text('run.commit', `Commit ${i.run.sha}`, 'caption'));
    const runBody = r.components.find((c) => c.id === 'run.body');
    if (i.run.sha && runBody && Array.isArray(runBody.children)) runBody.children.unshift('run.commit');
    comps.push(...r.components);
    data = { ...data, ...r.data };
    actions.run = { method: 'POST', url: `${base}/api/projects/${p.id}/run`, body: { ...(i.run.sha ? { target: 'commit', sha: i.run.sha } : { target: 'deployed' }), env: { $context: true } }, stream: 'sse', output: { path: '/run/output', status: '/run/status' } };
    sections.push('run');
  }

  const links: A2uiComponent[] = [...button('links.ainize', 'Open on ainize', 'open:inspect', { variant: 'borderless' }), ...button('links.aindrive', 'Repository', 'open:aindrive', { variant: 'borderless' })];
  const linkIds = ['links.ainize', 'links.aindrive'];
  if (i.canRedeploy && last) {
    actions.redeploy = { method: 'POST', url: `${base}/api/projects/${p.id}/redeploy`, body: {} };
    links.push(...button('redeploy.button', 'Redeploy', 'redeploy'));
    linkIds.push('redeploy.button');
  }
  comps.push(...links, divider('links.divider'), row('links', linkIds));
  sections.push('links.divider', 'links');
  comps.push(column('root', sections));
  return {
    ainui: AINUI_ENVELOPE_VERSION, kind: 'ainize.project', icon: 'deploy',
    title: p.name, subtitle: `${p.org}/${p.repoName} · ${p.branch} · ${statusLine}`, url: i.pageUrl,
    surface: surface('ainize.project', comps, data), actions, refresh: last && (last.status === 'queued' || last.status === 'building') ? 10 : 30,
  };
}

/** The 403 body: one sentence and a link, so the chat still shows something clickable (doc §4). */
export function deniedSnippet(host: string, what: string, pageUrl: string): AinuiSnippet {
  const comps: A2uiComponent[] = [
    text('denied.text', `Sign in to ${host} or ask for access to ${what}.`, 'body'),
    ...button('links.ainize', 'Open', 'open:inspect', { variant: 'borderless' }),
    row('links', ['links.ainize']),
    column('root', ['denied.text', 'links']),
  ];
  return {
    ainui: AINUI_ENVELOPE_VERSION, kind: 'denied', icon: 'lock', title: what, subtitle: 'no access', url: pageUrl,
    surface: surface('denied', comps, {}), actions: { 'open:inspect': { method: 'GET', url: pageUrl, navigate: true } },
  };
}

/** `env` a run request may carry (the Run form's answers): ≤ 16 names like `INPUT_X`, values ≤ 2 KiB. Null = refused. */
export const RUN_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
export function validateRunEnv(raw: unknown): Record<string, string> | null {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > 16) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    if (!RUN_ENV_NAME.test(k)) return null;
    const s = typeof v === 'number' && Number.isFinite(v) ? String(v) : typeof v === 'boolean' ? String(v) : v;
    if (typeof s !== 'string' || s.length > 2048) return null;
    out[k] = s;
  }
  return out;
}
