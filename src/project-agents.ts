import type { RepositorySerialize } from './agent-repository-queue.js';
/**
 * `kind: agent` — a project's repository deployed as a hosted A2A agent this node runs (hosted-agent-*.ts).
 *
 * The repository is laid out the way an agent's own repository is (agent-git.ts): `agent.json` for the spec
 * fields, `prompt.md` for the system prompt, `files/` for the code of a tools/handler agent. `ainize.json`'s
 * `agent: { name, description, model, a2ui }` is laid over agent.json, so a repo with a model named there needs
 * no agent.json at all. The agent's id is derived from the project and never changes across pushes
 * (`prj-<org>-<repo>`, fitted to the hosted-agent id rule), so its A2A address `${publicUrl}/agents/<id>` is
 * stable; each push is a new version of the same agent through the same store and host every other hosted agent
 * uses — the build/swap rules there (a failed build leaves the previous version serving) are this kind's too.
 *
 * A Dockerfile in the repository is NOT honoured for agents: the hosted-agent runtime image is the A2A contract
 * (hosted-agent-docker.ts builds `FROM` it), and a user image could not satisfy it. `kind: service` is the way to
 * run a custom image.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { AGENT_GIT_FILES_DIR, AGENT_GIT_PROMPT_FILE, AGENT_GIT_RESERVED_FIELDS, AGENT_GIT_SPEC_FILE } from './agent-git.js';
import type { HostedAgentHost } from './hosted-agent-host.js';
import type { HostedAgentStore } from './hosted-agent-store.js';
import { hostedAgentSpecInput, type HostedAgentSpec, type HostedAgentSpecInput } from './hosted-agent-types.js';
import { waitForAgentVersion, repositoryId, type RuntimeSource } from './repository-runtime.js';
import type { ProjectManifest } from './project-manifest.js';

export class ProjectAgentError extends Error {}

/** `prj-<org>-<repo>`, lower-case, hyphens, ≤ 40 — the hosted-agent id rule. */
export function projectAgentId(org: string, repoName: string): string {
  const slug = `prj-${org}-${repoName}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return slug.slice(0, 40).replace(/-$/, '');
}

/** The agent spec input a cloned tree describes. */
export function projectAgentSpecOf(dir: string, id: string, manifest: ProjectManifest): HostedAgentSpecInput {
  let json: Record<string, unknown> = {};
  const specFile = join(dir, AGENT_GIT_SPEC_FILE);
  if (existsSync(specFile)) {
    try { json = JSON.parse(readFileSync(specFile, 'utf8')) as Record<string, unknown>; }
    catch (e) { throw new ProjectAgentError(`${AGENT_GIT_SPEC_FILE} is not valid JSON: ${(e as Error).message}`); }
    const set = AGENT_GIT_RESERVED_FIELDS.filter((f) => f in json);
    if (set.length) throw new ProjectAgentError(`${AGENT_GIT_SPEC_FILE} sets ${set.join(', ')}, which the node owns — remove ${set.length > 1 ? 'them' : 'it'}`);
  }
  const promptFile = join(dir, AGENT_GIT_PROMPT_FILE);
  const files: Record<string, string> = {};
  const filesDir = join(dir, AGENT_GIT_FILES_DIR);
  if (existsSync(filesDir) && statSync(filesDir).isDirectory()) {
    const walk = (d: string) => {
      for (const name of readdirSync(d).sort()) {
        const full = join(d, name);
        const st = statSync(full);
        if (st.isDirectory()) walk(full);
        else if (st.isFile()) files[relative(filesDir, full).split('\\').join('/')] = readFileSync(full, 'utf8');
      }
    };
    walk(filesDir);
  }
  const over = manifest.agent ?? {};
  const candidate = {
    ...json,
    ...(over.name ? { name: over.name } : {}),
    ...(over.description !== undefined ? { description: over.description } : {}),
    ...(over.model ? { model: over.model } : {}),
    ...(over.a2ui !== undefined ? { a2ui: over.a2ui } : {}),
    id,
    name: over.name ?? (json.name as string | undefined) ?? manifest.name ?? id,
    systemPrompt: existsSync(promptFile) ? readFileSync(promptFile, 'utf8') : ((json.systemPrompt as string | undefined) ?? ''),
    ...(Object.keys(files).length ? { files, mode: (json.mode as string | undefined) ?? 'handler' } : {}),
  };
  const parsed = hostedAgentSpecInput.safeParse(candidate);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ProjectAgentError(`this repository is not a valid agent:\n  ${issues.join('\n  ')}`);
  }
  return parsed.data;
}

export interface ProjectAgentDeps {
  serialize?: RepositorySerialize;
  store: HostedAgentStore;
  host: HostedAgentHost;
  /** Ids a hosted agent may not take (config agents, linked agents). */
  reserved?: (id: string) => boolean;
  /** How long a code agent's image build may take before the deployment is called failed. */
  buildTimeoutMs?: number;
  /** After every create/update — the repo hook and change feed server.ts wires for hosted agents. */
  onReady?: (spec: HostedAgentSpec) => void;
  onFailed?: (spec: HostedAgentSpec, error: string) => void;
  onApplied?: (spec: HostedAgentSpec, created: boolean, source?: RuntimeSource) => Promise<void> | void;
}

/**
 * Create or update the project's agent from the tree and wait for the host to call it ready. Resolves with the
 * spec that is live; rejects with the host's error (the previous version, if any, keeps serving).
 */
export async function deployProjectAgent(deps: ProjectAgentDeps, p: { id?: string; repo?: string; sourcePath?: string; branch?: string; org: string; repoName: string; owner: string }, dir: string, manifest: ProjectManifest, say: (line: string) => void, sourceCommit?: string): Promise<HostedAgentSpec> {
  const id = projectAgentId(p.org, p.repoName);
  if (deps.serialize) return deps.serialize(id, () => deployProjectAgent({ ...deps, serialize: undefined }, p, dir, manifest, say, sourceCommit));
  const input = projectAgentSpecOf(dir, id, manifest);
  const prior = deps.store.get(id);
  if (prior && prior.owner !== p.owner) throw new ProjectAgentError(`agent "${id}" belongs to another account on this node`);
  let spec: HostedAgentSpec;
  if (prior) {
    spec = deps.store.update(id, input, p.owner);
    say(`[ainize] agent ${id}: v${spec.version} (${input.mode}, model ${input.model})`);
  } else {
    spec = deps.store.create(input, p.owner, deps.reserved);
    say(`[ainize] agent ${id}: created (${input.mode}, model ${input.model})`);
  }
  const source: RuntimeSource | undefined = p.repo ? { repoId: repositoryId(p.repo), provider: 'aindrive', url: p.repo, path: p.sourcePath ?? '', branch: p.branch ?? 'main', sourceCommit: sourceCommit ?? null, projectId: p.id ?? null, writable: false } : undefined;
  await deps.onApplied?.(spec, !prior, source);
  deps.host.apply(spec);
  try {
    await waitForAgentVersion(deps.host, id, spec.version, deps.buildTimeoutMs);
    deps.onReady?.(spec);
    return spec;
  } catch (e) {
    deps.onFailed?.(spec, (e as Error).message);
    for (const line of await deps.host.logs(id).catch(() => [] as string[])) say(line);
    throw new ProjectAgentError((e as Error).message);
  }
}
