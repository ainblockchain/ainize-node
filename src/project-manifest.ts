/**
 * `ainize.json` — the one file at a repository's root that says how it deploys (what `vercel.json` is to Vercel).
 *
 * Read from the clone of the pushed commit, never from the request: the project row names a repo and a branch,
 * the repo says what it is. Four kinds —
 *
 *   nextjs   a Next.js app, built in a node container and served on `port` (3000). THE DEFAULT: a repo whose
 *            package.json depends on `next` needs no ainize.json at all, and one without a `kind` is this.
 *   service  the repo's Dockerfile, built and run behind the node (`build`, `port`, `healthcheck`).
 *   script   `entry` run once per push in the /api/run sandbox; stdout kept as the output.
 *   agent    a hosted A2A agent built from the repo (agent.json / prompt.md / files/, agent-git.ts layout), reachable
 *            at `${publicUrl}/agents/<id>`; `agent: {…}` here overrides agent.json's fields.
 *
 * No ainize.json and no `next` dependency is an error that says so ("no ainize.json") rather than a guess.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export const PROJECT_MANIFEST_FILE = 'ainize.json';
export const PROJECT_MANIFEST_KINDS = ['nextjs', 'service', 'script', 'agent'] as const;
export type ProjectManifestKind = (typeof PROJECT_MANIFEST_KINDS)[number];

const relPath = z.string().min(1).max(200).regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0]+$/, 'a relative path inside the repository');
const envName = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const INPUTS_MAX = 16;
export const INPUT_VALUE_MAX = 2048;

/** The environment variable an input is delivered as: `INPUT_<NAME>`, upper-cased (GitHub Actions' convention). */
export const inputEnvName = (name: string) => `INPUT_${name.toUpperCase()}`;

/** The env a manifest's inputs contribute without a person's answers: each `default` as text. */
export function inputDefaults(inputs: Record<string, { default?: string | number | boolean }> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, spec] of Object.entries(inputs ?? {})) if (spec.default !== undefined) out[inputEnvName(name)] = String(spec.default);
  return out;
}

export const projectManifestSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  kind: z.enum(PROJECT_MANIFEST_KINDS).optional(),
  /** script only. Defaults by the entry's extension. */
  runtime: z.enum(['python3.11', 'node20']).optional(),
  /** script: the file to run. */
  entry: relPath.optional(),
  /** Merged under the project's own env. Never secrets — this file is in the repository. */
  env: z.record(z.string().regex(envName, 'an environment variable name'), z.string().max(4096)).refine((e) => Object.keys(e).length <= 32, 'at most 32 env entries').default({}),
  /**
   * Parameters a person fills in before a run — the same shape as GitHub Actions `workflow_dispatch.inputs`
   * (name → `{ description, type: string|choice|boolean|number, required, default, options }`), delivered to the
   * program as `INPUT_<NAME>` environment variables (name upper-cased; booleans `true|false`, numbers as decimal
   * text). aindrive's Run panel renders one field per input; a push-deploy uses the defaults. ≤ 16, values ≤ 2 KiB.
   */
  inputs: z.record(z.string().regex(envName, 'an input name'), z.object({
    description: z.string().trim().max(500).optional(),
    type: z.enum(['string', 'choice', 'boolean', 'number']).default('string'),
    required: z.boolean().default(false),
    options: z.array(z.string().max(INPUT_VALUE_MAX)).max(64).optional(),
    default: z.union([z.string().max(INPUT_VALUE_MAX), z.number(), z.boolean()]).optional(),
  }).strict()).refine((r) => Object.keys(r).length <= INPUTS_MAX, `at most ${INPUTS_MAX} inputs`).default({}),
  /**
   * Named presets of `inputs` the Run panel offers as one click ("노을 바다 유화", "인물 초상", …): each `inputs` is a
   * partial answer sheet — names not in `inputs` above are refused at resolve time, values travel as text. ≤ 16.
   */
  examples: z.array(z.object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(300).optional(),
    inputs: z.record(z.string().regex(envName, 'an input name'), z.union([z.string().max(INPUT_VALUE_MAX), z.number(), z.boolean()])),
  }).strict()).max(16).default([]),
  /** service only. */
  build: z.object({
    dockerfile: relPath.default('Dockerfile'),
    context: relPath.default('.'),
  }).default({ dockerfile: 'Dockerfile', context: '.' }),
  /** service / nextjs: the container port the node exposes. */
  port: z.number().int().min(1).max(65535).optional(),
  /** service / nextjs: a path polled until it answers 200. */
  healthcheck: z.string().regex(/^\/[^\s]*$/, 'a path starting with /').max(200).optional(),
  /** script: how long the run may take. */
  timeoutMs: z.number().int().min(1000).max(300_000).optional(),
  /** agent: fields laid over agent.json. */
  agent: z.object({
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().max(500).optional(),
    model: z.string().min(1).optional(),
    a2ui: z.boolean().optional(),
  }).optional(),
}).strict();

export type ProjectManifestInput = z.infer<typeof projectManifestSchema>;

/** A manifest with its kind decided and the kind's defaults filled in. */
export interface ProjectManifest extends ProjectManifestInput {
  kind: ProjectManifestKind;
  /** Where the kind came from: the file, or the `next` dependency. */
  detected: 'ainize.json' | 'package.json';
  port: number;
  healthcheck: string;
}

export class ProjectManifestError extends Error {}

export const PROJECT_NO_MANIFEST = `no ${PROJECT_MANIFEST_FILE}`;

/** Does package.json at `dir` depend on `next`? */
export function dependsOnNext(dir: string): boolean {
  const p = join(dir, 'package.json');
  if (!existsSync(p)) return false;
  try {
    const pkg = JSON.parse(readFileSync(p, 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    return !!(pkg.dependencies?.next ?? pkg.devDependencies?.next);
  } catch { return false; }
}

/** Parse a manifest's text (tests, and the UI's validator). Throws `ProjectManifestError` with the first issue. */
export function parseProjectManifest(text: string): ProjectManifestInput {
  let json: unknown;
  try { json = JSON.parse(text); } catch (e) { throw new ProjectManifestError(`${PROJECT_MANIFEST_FILE} is not valid JSON: ${(e as Error).message}`); }
  const parsed = projectManifestSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ProjectManifestError(`${PROJECT_MANIFEST_FILE}: ${issue?.path.join('.') || '(root)'}: ${issue?.message ?? 'invalid'}`);
  }
  return parsed.data;
}

/**
 * Read a cloned tree's manifest. `fallback` is what the project row said at creation (entry), used only where the
 * file is silent. No file + a `next` dependency → nextjs; no file otherwise → "no ainize.json".
 */
export function resolveProjectManifest(dir: string, fallback: { entry?: string | null } = {}): ProjectManifest {
  const file = join(dir, PROJECT_MANIFEST_FILE);
  const hasFile = existsSync(file);
  const isNext = dependsOnNext(dir);
  if (!hasFile && !isNext) throw new ProjectManifestError(PROJECT_NO_MANIFEST);
  const input = hasFile ? parseProjectManifest(readFileSync(file, 'utf8')) : projectManifestSchema.parse({});
  let kind = input.kind;
  if (!kind) {
    if (isNext) kind = 'nextjs';
    else if (input.entry || fallback.entry) kind = 'script';
    else throw new ProjectManifestError(`${PROJECT_MANIFEST_FILE} has no "kind" and package.json does not depend on next — set kind to nextjs, service, script or agent`);
  }
  for (const ex of input.examples) {
    const unknown = Object.keys(ex.inputs).find((k) => !(k in input.inputs));
    if (unknown) throw new ProjectManifestError(`${PROJECT_MANIFEST_FILE}: examples."${ex.name}" answers an input that does not exist: ${unknown}`);
  }
  const entry = input.entry ?? fallback.entry ?? undefined;
  if (kind === 'script' && !entry) throw new ProjectManifestError(`${PROJECT_MANIFEST_FILE}: a script names its "entry"`);
  if (kind === 'script' && input.runtime === undefined && entry && !/\.(py|m?js|cjs)$/i.test(entry)) throw new ProjectManifestError(`${PROJECT_MANIFEST_FILE}: "runtime" is needed for an entry that is not .py/.js/.mjs`);
  return {
    ...input,
    kind,
    entry,
    detected: hasFile ? 'ainize.json' : 'package.json',
    port: input.port ?? (kind === 'nextjs' ? 3000 : 8080),
    healthcheck: input.healthcheck ?? '/',
  };
}

/** The Dockerfile written for a Next.js repo that brings none: build in node 20, serve on `port`. */
export function nextjsDockerfile(port: number): string {
  return [
    'FROM node:20-alpine',
    'WORKDIR /app',
    'ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 CI=1',
    'COPY package.json package-lock.json* npm-shrinkwrap.json* ./',
    // devDependencies too: `next build` needs them. With a lockfile `npm ci`, without one `npm install`.
    'RUN if [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then npm ci --include=dev --no-audit --no-fund; else npm install --include=dev --no-audit --no-fund; fi',
    'COPY . .',
    'RUN npm run build && chown -R node:node /app',
    `ENV PORT=${port} HOSTNAME=0.0.0.0`,
    'USER node',
    `EXPOSE ${port}`,
    // `npm start` when the app defines it (the create-next-app default is `next start`), else next start itself.
    `CMD ["sh", "-c", "if node -e \\"process.exit(require('./package.json').scripts?.start ? 0 : 1)\\"; then npm start -- -p ${port}; else npx next start -p ${port}; fi"]`,
    '',
  ].join('\n');
}
