/**
 * Projects — an ainize deployment bound to a git repository that lives in an aindrive drive.
 *
 * "ainize git = aindrive git": this node keeps NO repositories of its own for projects. A project names a repo by
 * its aindrive URL (`https://aindrive.ainetwork.ai/<org>/git/<repo>`, or `/api/drives/<driveId>/git/<path>`), a
 * branch; aindrive calls `POST /api/projects/:id/hook` after a successful `git-receive-pack`, and the worker here
 * clones THAT commit, reads its `ainize.json` (project-manifest.ts — the one source of truth for how it deploys)
 * and does what the kind says: `nextjs`/`service` build and run a container behind the node
 * (project-containers.ts), `script` runs the entry once in the /api/run sandbox, `agent` becomes a hosted A2A
 * agent (project-agents.ts). Each push is a Deployment with a log. The owner is the signed-in account (AIN SSO or
 * wallet session) that created the project.
 *
 * Persistence is the hosted-agent bargain (hosted-agent-store.ts): one JSON file, written atomically, a few
 * hundred records. Secrets (the webhook secret aindrive signs with, the deploy token the clone presents) live in
 * the encrypted secret store, never in this file. Logs are plain files under `<dataDir>/projects/logs`, and the
 * last `retainPerProject` deployments of a project are kept — older ones go, records and logs together.
 *
 * Reading the repository. aindrive serves a drive's repo behind its own auth (viewer+), and there is no
 * machine-to-machine path from this node's SSO app credentials to an aindrive read token yet. Until there is,
 * the node clones AS ITSELF: an AIN SSO machine token (`client_credentials`, src/sso-service-token.ts) for the repo's
 * host, which aindrive honours as a viewer on the drives shared with an organization the ainize app is assigned in.
 * A per-project DEPLOY TOKEN the owner pastes at creation — an aindrive session JWT or an `aind_aat_…` account
 * token with `drives:read` — remains an optional override. Either is sent as `Authorization: Bearer …` on the clone,
 * written into the git process's environment (GIT_CONFIG_*), never its argument list (docs/PROJECTS.md).
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { z } from 'zod';
import { mirrorUrlOk } from './agent-mirror.js';
import { deployProjectAgent, projectAgentId, type ProjectAgentDeps } from './project-agents.js';
import type { ProjectContainers } from './project-containers.js';
import { ProjectManifestError, resolveProjectManifest, PROJECT_MANIFEST_KINDS, INPUTS_MAX, INPUT_VALUE_MAX, type ProjectManifest, type ProjectManifestInput, type ProjectManifestKind, inputDefaults, inputEnvName } from './project-manifest.js';
import type { RunSandbox } from './run-sandbox.js';

const exec = promisify(execFile);

// ------------------------------------------------------------------------------------------------ types

export const PROJECT_KINDS = PROJECT_MANIFEST_KINDS;
export type ProjectKind = ProjectManifestKind;
export type ProjectStatus = 'idle' | 'queued' | 'building' | 'ready' | 'error';
export type DeploymentStatus = 'queued' | 'building' | 'ready' | 'error';

export interface Project {
  bindingReceipt?: { clientId: string; requestId: string };
  id: string;
  /** The account that created it — `AgentCaller.subject` (shared-agents.ts). */
  owner: string;
  /** The repo URL exactly as given, normalized (no trailing slash, no `.git`). */
  repo: string;
  sourcePath?: string;
  sourceCommit?: string | null;
  activeCommit?: string | null;
  activeDeploymentId?: string | null;
  org: string;
  repoName: string;
  branch: string;
  /** What the last deployed `ainize.json` said (or the hint given at creation, until the first push). */
  kind: ProjectKind | null;
  /** A fallback entry for a `script` whose ainize.json names none. */
  entry: string | null;
  name: string;
  /** The last deployment's status, or `idle` before the first push. */
  status: ProjectStatus;
  lastDeploymentId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Deployment {
  id: string;
  projectId: string;
  sha: string;
  deliveryId?: string;
  ref: string;
  status: DeploymentStatus;
  /** Who pushed, as aindrive reported it. */
  pusher: { subject: string; email?: string } | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  ms: number | null;
  exitCode: number | null;
  /** Why it ended in `error` when there is no exit code to say so (clone failed, too many files, …). */
  error: string | null;
  /** The kind the commit's ainize.json resolved to; null until it was read. */
  kind?: ProjectKind | null;
  /** Where the result lives once `ready`: the service's public URL, the agent's A2A URL, a script's stdout. */
  outputUrl?: string | null;
  /**
   * What started it: aindrive's push hook (`push`, the default), a person pressing Redeploy on a deployment (`redeploy`),
   * or an ad-hoc run from the project console (`run` — listed under `/runs`, never the project's status).
   */
  trigger?: DeploymentTrigger;
  /** `run` only: the file to run instead of the manifest's entry, and the answers to its `inputs` / extra env. */
  entry?: string | null;
  inputs?: Record<string, string>;
  env?: Record<string, string>;
  /** The commit's subject line, read after the clone. */
  subject?: string | null;
  /** Snapshot of the commit's `ainize.json` as resolved (the console's Settings and Run panel read it). */
  manifest?: DeploymentManifest | null;
  /** script: the repository's runnable files (`.py`, `.js`, `.mjs`, `.cjs`), the Run panel's entry choices. */
  runnable?: string[];
}

export type DeploymentTrigger = 'push' | 'redeploy' | 'run';

/** The parts of a resolved manifest a page needs — never `env` values beyond their names? They are in the repo anyway. */
export interface DeploymentManifest {
  kind: ProjectKind;
  name?: string;
  entry?: string;
  runtime?: string;
  timeoutMs?: number;
  env: Record<string, string>;
  inputs: ProjectManifestInput['inputs'];
  examples: ProjectManifestInput['examples'];
  detected: 'ainize.json' | 'package.json';
}

/** `POST /api/projects/:id/runs` body. Inputs and env values travel as text (`INPUT_<NAME>`); ≤ 2 KiB each. */
export const runInput = z.object({
  sha: z.string().regex(/^[0-9a-f]{40,64}$/).optional(),
  target: z.enum(['head', 'commit', 'deployed']).default('head'),
  entry: z.string().regex(/^(?!\.\.?(\/|$))[^\0\n]{1,200}$/, 'a repository-relative file').optional(),
  inputs: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'an input name'), z.union([z.string().max(INPUT_VALUE_MAX), z.number(), z.boolean()])).refine((r) => Object.keys(r).length <= INPUTS_MAX, `at most ${INPUTS_MAX} inputs`).optional(),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'an environment variable name'), z.string().max(4096)).refine((e) => Object.keys(e).length <= 32, 'at most 32 env entries').optional(),
  timeoutMs: z.number().int().min(1000).max(300_000).optional(),
});
export type RunInput = z.infer<typeof runInput>;

/** `POST /api/run`'s request, as deploy/run-runtime/README.md describes it. */
export interface RunRequest {
  language: 'python' | 'node';
  entry: string;
  files: Record<string, string>;
  env: Record<string, string>;
  timeoutMs: number;
  /** The key the script runs with (`AINIZE_API_KEY`): the pusher's `aindrive run` key (run-actor.ts), when known. */
  apiKey?: string;
}
export type RunEvent = { event: 'stdout' | 'stderr' | 'error'; data: string } | { event: 'exit'; data: { code: number; ms: number } };
/** Run one script; every event the sandbox emits goes to `onEvent`, `exit` last. */
export type RunScript = (req: RunRequest, onEvent: (ev: RunEvent) => void) => Promise<void>;

// The same caps as /api/run — refused here so a repo over them fails with a reason, not a 413 from the sandbox.
export const PROJECT_MAX_FILES = 32;
export const PROJECT_MAX_BYTES = 2 * 1024 * 1024;
export const PROJECT_RUN_TIMEOUT_MS = 120_000;
export const PROJECT_RETAIN_PER_PROJECT = 20;
export const PROJECT_MAX_CONCURRENT = 2;
export const PROJECT_DEFAULT_BRANCH = 'main';
export const PROJECT_DEFAULT_CORS_ORIGINS = ['https://aindrive.ainetwork.ai'];
export const PROJECT_SECRET_WEBHOOK = 'webhookSecret';
export const PROJECT_SECRET_DEPLOY_TOKEN = 'deployToken';

// ------------------------------------------------------------------------------------------------ repo URLs

export interface RepoRef { url: string; org: string; repoName: string }

/**
 * `https://aindrive.ainetwork.ai/<org>/git/<repo>` → org, repo. `…/api/drives/<driveId>/git/<path>` → the drive
 * id stands as the org and the last path segment as the name. Anything else with a `/git/` in it is read the same
 * way; a URL with none is refused. https anywhere, http only on loopback, no credentials (mirrorUrlOk).
 */
export function parseRepoUrl(input: string): RepoRef | null {
  let u: URL;
  try { u = new URL(input.trim()); } catch { return null; }
  if (!mirrorUrlOk(u.toString())) return null;
  const segs = u.pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
  const at = segs.indexOf('git');
  if (at < 1 || at === segs.length - 1) return null;
  const before = segs.slice(0, at);
  let after = segs.slice(at + 1);
  // aindrive keeps repos under the drive folder `repositories/`; the pretty URL names only the repo and
  // the drive-id form may spell the folder out. Both mean the same repo, so the canonical URL drops it.
  if (after[0] === 'repositories' && after.length > 1) after = after.slice(1);
  const org = before[0] === 'api' && before[1] === 'drives' && before[2] ? before[2] : before[before.length - 1]!;
  const repoName = after[after.length - 1]!.replace(/\.git$/, '');
  if (!/^[A-Za-z0-9._-]+$/.test(org) || !/^[A-Za-z0-9._-]+$/.test(repoName)) return null;
  const path = [...before, 'git', ...after.slice(0, -1), repoName].map(encodeURIComponent).join('/');
  return { url: `${u.protocol}//${u.host}/${path}`, org, repoName };
}

export const projectInput = z.object({
  repo: z.string().min(1).max(1024),
  sourcePath: z.string().max(200).regex(/^(?:[A-Za-z0-9_-][A-Za-z0-9._-]*)(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/).optional(),
  branch: z.string().regex(/^[A-Za-z0-9._\/-]+$/, 'a branch name').max(200).default(PROJECT_DEFAULT_BRANCH),
  /** A hint for the project row; the deployed kind is always the repository's ainize.json. */
  kind: z.enum(PROJECT_KINDS).optional(),
  entry: z.string().regex(/^(?!\.\.)(?!.*\/\.\.)[^\0]+$/).max(200).optional(),
  name: z.string().min(1).max(100).optional(),
  deployToken: z.string().min(1).max(8192).optional(),
});
export type ProjectInput = z.infer<typeof projectInput>;

export const hookBody = z.object({
  deliveryId: z.string().regex(/^[A-Za-z0-9._:-]{1,150}$/).optional(),
  ref: z.string().min(1).max(300),
  before: z.string().regex(/^[0-9a-f]{40,64}$/).optional(),
  after: z.string().regex(/^[0-9a-f]{40,64}$/),
  pusher: z.object({ subject: z.string().min(1).max(300), email: z.string().max(300).optional() }).optional(),
});
export type HookBody = z.infer<typeof hookBody>;

export function languageOf(entry: string): RunRequest['language'] | null {
  const ext = extname(entry).toLowerCase();
  if (ext === '.py') return 'python';
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return 'node';
  return null;
}

// ------------------------------------------------------------------------------------------------ signatures

export function signHook(secret: string, rawBody: Buffer | string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

export function hookSignatureOk(secret: string, rawBody: Buffer | string, header: string | undefined): boolean {
  if (!header) return false;
  const want = Buffer.from(signHook(secret, rawBody));
  const got = Buffer.from(header.trim());
  return want.length === got.length && timingSafeEqual(want, got);
}

// ------------------------------------------------------------------------------------------------ store

export class ProjectLimitError extends Error {}
export class ProjectRepoTakenError extends Error {}

export interface ProjectStoreLimits { perOwner: number; total: number }
export const PROJECT_DEFAULT_LIMITS: ProjectStoreLimits = { perOwner: 20, total: 500 };

export class ProjectStore {
  private readonly projects = new Map<string, Project>();
  private readonly deployments = new Map<string, Deployment>();
  private readonly deliveries = new Map<string, { deploymentId: string; status: DeploymentStatus }>();

  constructor(private readonly file: string, private readonly limits: ProjectStoreLimits = PROJECT_DEFAULT_LIMITS) {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { projects?: Project[]; deployments?: Deployment[]; deliveries?: [string, { deploymentId: string; status: DeploymentStatus }][] };
      for (const p of parsed.projects ?? []) if (p?.id) this.projects.set(p.id, p);
      for (const d of parsed.deployments ?? []) if (d?.id) this.deployments.set(d.id, d);
      for (const [key, receipt] of parsed.deliveries ?? []) this.deliveries.set(key, receipt);
      for (const p of this.projects.values()) {
        const ready = this.deploymentsOf(p.id).find((d) => d.status === 'ready');
        const latest = p.lastDeploymentId ? this.deployment(p.lastDeploymentId) : null;
        this.projects.set(p.id, { ...p, sourceCommit: p.sourceCommit ?? latest?.sha ?? null, activeCommit: p.activeCommit ?? ready?.sha ?? null, activeDeploymentId: p.activeDeploymentId ?? ready?.id ?? null });
      }
    }
  }

  list(): Project[] { return [...this.projects.values()].sort((a, b) => a.createdAt - b.createdAt); }
  get(id: string): Project | null { return this.projects.get(id) ?? null; }
  listByOwner(owner: string): Project[] { return this.list().filter((p) => p.owner === owner); }
  byRepo(url: string): Project | null {
    const ref = parseRepoUrl(url);
    if (!ref) return null;
    // Compare canonical forms on both sides: records bound before the `repositories/` normalisation
    // carry the folder in their URL and must still resolve.
    return this.list().find((p) => (parseRepoUrl(p.repo)?.url ?? p.repo) === ref.url) ?? null;
  }
  /** `/<org>/<repo>` — the GitHub-shaped address. Case-insensitive; the first-bound project when two branches of a repo are bound (as `byRepo`). */
  byName(org: string, repoName: string): Project | null {
    const o = org.toLowerCase(); const r = repoName.toLowerCase();
    return this.list().find((p) => p.org.toLowerCase() === o && p.repoName.toLowerCase() === r) ?? null;
  }
  /** Every project of an organization slug (`/<org>`), case-insensitive, oldest first. */
  byOrg(org: string): Project[] {
    const o = org.toLowerCase();
    return this.list().filter((p) => p.org.toLowerCase() === o);
  }

  create(input: { bindingReceipt?: Project['bindingReceipt']; repo: RepoRef; sourcePath?: string; branch: string; kind: ProjectKind | null; entry: string | null; name?: string }, owner: string, now = Date.now()): Project {
    if (this.list().some((p) => (parseRepoUrl(p.repo)?.url ?? p.repo) === input.repo.url && p.branch === input.branch)) throw new ProjectRepoTakenError(`${input.repo.url} (${input.branch}) is already a project on this node`);
    if (this.listByOwner(owner).length >= this.limits.perOwner) throw new ProjectLimitError(`an account may have ${this.limits.perOwner} projects on this node`);
    if (this.projects.size >= this.limits.total) throw new ProjectLimitError(`this node holds its maximum of ${this.limits.total} projects`);
    const project: Project = {
      id: `prj_${randomBytes(8).toString('hex')}`, owner, repo: input.repo.url, org: input.repo.org, repoName: input.repo.repoName,
      branch: input.branch, kind: input.kind, entry: input.entry, name: input.name ?? input.repo.repoName,
      bindingReceipt: input.bindingReceipt,
      sourcePath: input.sourcePath ?? '', sourceCommit: null, activeCommit: null, activeDeploymentId: null,
      status: 'idle', lastDeploymentId: null, createdAt: now, updatedAt: now,
    };
    this.projects.set(project.id, project);
    this.save();
    return project;
  }

  delete(id: string): boolean {
    const had = this.projects.delete(id);
    if (!had) return false;
    for (const d of [...this.deployments.values()]) if (d.projectId === id) this.deployments.delete(d.id);
    for (const key of this.deliveries.keys()) if (key.startsWith(`${id}:`)) this.deliveries.delete(key);
    this.save();
    return true;
  }

  delivery(projectId: string, deliveryId: string): { deploymentId: string; status: DeploymentStatus } | null {
    return this.deliveries.get(`${projectId}:${deliveryId}`) ?? null;
  }
  forAgent(id: string): Project | null {
    return this.list().find((p) => p.kind === 'agent' && projectAgentId(p.org, p.repoName) === id) ?? null;
  }
  deployment(id: string): Deployment | null { return this.deployments.get(id) ?? null; }
  /** Deployments (pushes and redeploys) of a project, newest first — ad-hoc runs are `runsOf`. */
  deploymentsOf(projectId: string): Deployment[] {
    return this.ofProject(projectId).filter((d) => d.trigger !== 'run');
  }
  /** Ad-hoc runs of a project (the console's Run panel), newest first. */
  runsOf(projectId: string): Deployment[] {
    return this.ofProject(projectId).filter((d) => d.trigger === 'run');
  }
  private ofProject(projectId: string): Deployment[] {
    return [...this.deployments.values()].filter((d) => d.projectId === projectId).sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
  }

  createDeployment(project: Project, body: HookBody, now = Date.now(), trigger: Exclude<DeploymentTrigger, 'run'> = 'push'): Deployment {
    project = this.get(project.id) ?? project;
    const d: Deployment = {
      id: `dep_${randomBytes(8).toString('hex')}`, projectId: project.id, sha: body.after, ref: body.ref, status: 'queued',
      ...(body.deliveryId ? { deliveryId: body.deliveryId } : {}),
      pusher: body.pusher ?? null, createdAt: now, startedAt: null, finishedAt: null, ms: null, exitCode: null, error: null,
      ...(trigger === 'push' ? {} : { trigger }),
    };
    this.deployments.set(d.id, d);
    this.projects.set(project.id, { ...project, sourceCommit: d.sha, status: 'queued', lastDeploymentId: d.id, updatedAt: now });
    if (d.deliveryId) this.deliveries.set(`${project.id}:${d.deliveryId}`, { deploymentId: d.id, status: d.status });
    this.save();
    return d;
  }

  /** The same commit again, as a new deployment started by `actor` (Redeploy; also "roll back to this one" for a service). */
  redeploy(project: Project, of: Deployment, actor: { subject: string; email?: string } | null, now = Date.now()): Deployment {
    return this.createDeployment(project, { ref: of.ref, after: of.sha, pusher: actor ?? undefined }, now, 'redeploy');
  }

  /**
   * An ad-hoc run of the branch's HEAD (`sha` is filled in after the clone) with the person's entry, inputs and env.
   * Runs queue behind the project's deployments but never become its status or `lastDeploymentId`.
   */
  createRun(project: Project, input: RunInput, actor: { subject: string; email?: string } | null, now = Date.now()): Deployment {
    const inputs: Record<string, string> = {};
    for (const [k, v] of Object.entries(input.inputs ?? {})) inputs[k] = String(v);
    const d: Deployment = {
      id: `run_${randomBytes(8).toString('hex')}`, projectId: project.id, sha: input.target === 'deployed' ? project.activeCommit ?? '' : input.sha ?? '', ref: `refs/heads/${project.branch}`, status: 'queued',
      pusher: actor, createdAt: now, startedAt: null, finishedAt: null, ms: null, exitCode: null, error: null, trigger: 'run',
      entry: input.entry ?? null, inputs, env: input.env ?? {},
    };
    this.deployments.set(d.id, d);
    this.save();
    return d;
  }

  updateDeployment(id: string, fields: Partial<Deployment>, now = Date.now()): Deployment | null {
    const prior = this.deployments.get(id);
    if (!prior) return null;
    const next = { ...prior, ...fields };
    this.deployments.set(id, next);
    if (next.deliveryId) this.deliveries.set(`${next.projectId}:${next.deliveryId}`, { deploymentId: id, status: next.status });
    const project = this.projects.get(prior.projectId);
    // The project's status is its newest deployment's: an older one finishing must not overwrite a newer one's state.
    if (project && project.lastDeploymentId === id && (fields.status || fields.kind)) this.projects.set(project.id, { ...project, ...(fields.status ? { status: fields.status } : {}), ...(fields.kind ? { kind: fields.kind } : {}), updatedAt: now });
    if (project && next.trigger !== 'run' && fields.status === 'ready') {
      const current = this.projects.get(project.id)!;
      this.projects.set(project.id, { ...current, activeCommit: next.sha, activeDeploymentId: next.id, updatedAt: now });
    }
    this.save();
    return next;
  }

  /** Drop the deployments beyond the newest `keep` of a project; returns the ids that went (for their logs). */
  prune(projectId: string, keep: number): string[] {
    const over = (list: Deployment[]) => list.slice(keep).filter((d) => (d.status === 'ready' || d.status === 'error') && d.id !== this.get(projectId)?.activeDeploymentId);
    const gone = [...over(this.deploymentsOf(projectId)), ...over(this.runsOf(projectId))];
    for (const d of gone) this.deployments.delete(d.id);
    if (gone.length) this.save();
    return gone.map((d) => d.id);
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ projects: this.list(), deployments: [...this.deployments.values()], deliveries: [...this.deliveries.entries()] }), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

// ------------------------------------------------------------------------------------------------ logs

/**
 * One file per deployment, appended as the run speaks; `tail` is the live feed (`GET /api/deployments/:id/log`
 * while it runs). stdout alone is kept beside it as `<id>.out` — the script's output, without the build chatter.
 */
export class DeploymentLogs extends EventEmitter {
  constructor(readonly dir: string) { super(); mkdirSync(dir, { recursive: true }); this.setMaxListeners(0); }
  logPath(id: string): string { return join(this.dir, `${id}.log`); }
  outPath(id: string): string { return join(this.dir, `${id}.out`); }
  append(id: string, line: string, stream: 'log' | 'out' = 'log'): void {
    appendFileSync(stream === 'log' ? this.logPath(id) : this.outPath(id), line);
    if (stream === 'log') this.emit(`log:${id}`, line);
  }
  read(id: string, stream: 'log' | 'out' = 'log'): string | null {
    const p = stream === 'log' ? this.logPath(id) : this.outPath(id);
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  }
  remove(id: string): void {
    for (const p of [this.logPath(id), this.outPath(id)]) rmSync(p, { force: true });
  }
}

// ------------------------------------------------------------------------------------------------ worker

export interface ProjectWorkerDeps {
  store: ProjectStore;
  logs: DeploymentLogs;
  /** `kind: script` — the /api/run sandbox (`runScriptViaSandbox`), or its HTTP contract (`runScriptOverHttp`). */
  run: RunScript;
  /** `kind: service` / `nextjs`. Absent → those kinds fail with a clear error. */
  containers?: ProjectContainers;
  /** `kind: agent`. Absent → that kind fails with a clear error. */
  agents?: ProjectAgentDeps;
  /** The deploy token pasted for a project, or null. It overrides the node's machine identity when present. */
  deployToken: (projectId: string) => string | null;
  /**
   * The node's machine identity (src/sso-service-token.ts): a bearer for the given resource (the repo URL's origin),
   * or null when the node has none / the issuer refuses. Used when the project has no deploy token.
   */
  serviceToken?: (resource: string) => Promise<string | null>;
  /** This node's public base URL — where a deployment's output and services are reachable. */
  publicUrl: () => string;
  /**
   * The `aindrive run` key of the person behind an SSO subject (run-actor.ts `RunKeyIssuer.keyFor`), or null when
   * the node cannot say (AIN SSO off, the account suspended). A push whose hook names `pusher.subject` runs its
   * script and its service with that person's key in `AINIZE_API_KEY`; without one, with no key.
   */
  keyForActor?: (subject: string) => string | null;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  maxConcurrent?: number;
  retainPerProject?: number;
  cloneTimeoutMs?: number;
  runTimeoutMs?: number;
}

/**
 * One queue per project, run in order; at most `maxConcurrent` deployments building node-wide. A deployment left
 * `queued` or `building` by a restart is re-queued at start (the clone is idempotent; the run is re-done).
 */
export class ProjectWorker extends EventEmitter {
  private readonly perProject = new Map<string, string[]>();
  private readonly active = new Set<string>();
  private readonly maxConcurrent: number;
  private readonly retain: number;
  private stopped = false;

  constructor(private readonly deps: ProjectWorkerDeps) {
    super();
    this.maxConcurrent = deps.maxConcurrent ?? PROJECT_MAX_CONCURRENT;
    this.retain = deps.retainPerProject ?? PROJECT_RETAIN_PER_PROJECT;
  }

  /**
   * Re-queue what a previous process left unfinished, and bring back the services it was running: a container's
   * gateway token died with the process, so a `ready` service/nextjs deployment is deployed again from its commit.
   */
  recover(): void {
    for (const p of this.deps.store.list()) {
      const all = this.deps.store.deploymentsOf(p.id);
      for (const d of [...all].reverse()) {
        if (d.status === 'queued' || d.status === 'building') {
          if (d.status === 'building') this.deps.store.updateDeployment(d.id, { status: 'queued', startedAt: null });
          this.enqueue(d.id);
        }
      }
      const last = p.activeDeploymentId ? this.deps.store.deployment(p.activeDeploymentId) : all.find((d) => d.status === 'ready');
      if (last && last.status === 'ready' && (last.kind === 'service' || last.kind === 'nextjs') && this.deps.containers && !this.deps.containers.current(p.id)) {
        this.deps.store.updateDeployment(last.id, { status: 'queued', startedAt: null, finishedAt: null, ms: null, error: null });
        this.deps.logs.append(last.id, `[ainize] node restarted — deploying ${last.sha.slice(0, 12)} again\n`);
        this.enqueue(last.id);
      }
    }
  }

  enqueue(deploymentId: string): void {
    const d = this.deps.store.deployment(deploymentId);
    if (!d) return;
    const q = this.perProject.get(d.projectId) ?? [];
    if (!q.includes(deploymentId)) q.push(deploymentId);
    this.perProject.set(d.projectId, q);
    this.pump();
  }

  stop(): void { this.stopped = true; }

  /** The `RunScript` this worker deploys scripts with, for a run pressed from a link snippet (project-routes.ts). */
  runScript(req: RunRequest, onEvent: (ev: RunEvent) => void): Promise<void> { return this.deps.run(req, onEvent); }

  /** Resolves when nothing is queued or building (tests). */
  idle(): Promise<void> {
    if (!this.active.size && ![...this.perProject.values()].some((q) => q.length)) return Promise.resolve();
    return new Promise((resolve) => this.once('idle', resolve));
  }

  /** The pusher's own key for this deployment's run, when the hook named them and the node can issue one. */
  private actorKey(d: { pusher: { subject: string } | null }, say: (line: string) => void): string | null {
    if (!d.pusher?.subject || !this.deps.keyForActor) return null;
    try {
      const key = this.deps.keyForActor(d.pusher.subject);
      if (!key) say('[ainize] no API key for the pusher — the run has no AINIZE_API_KEY');
      return key;
    } catch (e) {
      say(`[ainize] no API key for the pusher (${(e as Error).message}) — the run has no AINIZE_API_KEY`);
      return null;
    }
  }

  private pump(): void {
    if (this.stopped) return;
    for (const [projectId, q] of this.perProject) {
      if (this.active.size >= this.maxConcurrent) break;
      if (!q.length || this.active.has(projectId)) continue;
      const id = q.shift()!;
      this.active.add(projectId);
      void this.build(id).catch((e) => this.deps.log?.('error', `project ${projectId}: deployment ${id} crashed: ${(e as Error).message}`)).finally(() => {
        this.active.delete(projectId);
        if (!q.length) this.perProject.delete(projectId);
        this.emit('done', id);
        if (!this.active.size && ![...this.perProject.values()].some((x) => x.length)) this.emit('idle');
        this.pump();
      });
    }
  }

  private async build(deploymentId: string): Promise<void> {
    const { store, logs } = this.deps;
    const d = store.deployment(deploymentId);
    const project = d ? store.get(d.projectId) : null;
    if (!d || !project) return;
    const startedAt = Date.now();
    store.updateDeployment(d.id, { status: 'building', startedAt });
    const say = (line: string) => logs.append(d.id, `${line}\n`);
    const finish = (fields: Partial<Deployment>) => {
      const finishedAt = Date.now();
      store.updateDeployment(d.id, { ...fields, finishedAt, ms: finishedAt - startedAt });
      for (const gone of store.prune(project.id, this.retain)) logs.remove(gone);
    };
    const work = mkdtempSync(join(tmpdir(), 'ainize-project-'));
    try {
      const isRun = d.trigger === 'run';
      say(isRun ? `[ainize] run ${project.org}/${project.repoName} (${d.ref} HEAD)` : `[ainize] ${project.org}/${project.repoName}@${d.sha.slice(0, 12)} (${d.ref})`);
      // A re-run of a finished deployment (recover) starts from a clean record.
      if (d.outputUrl) store.updateDeployment(d.id, { outputUrl: null });
      // Records bound before the `repositories/` normalisation keep the folder in their URL; clone the canonical form.
      const cloneUrl = parseRepoUrl(project.repo)?.url ?? project.repo;
      say(`[ainize] clone ${cloneUrl}`);
      const sha = await this.clone(project, d.sha, work, say);
      const subject = await this.subjectOf(work);
      store.updateDeployment(d.id, { sha, subject });
      if (isRun) say(`[ainize] at ${sha.slice(0, 12)}${subject ? ` — ${subject}` : ''}`);
      let manifest: ProjectManifest;
      try { manifest = resolveProjectManifest(project.sourcePath ? join(work, project.sourcePath) : work, { entry: d.entry ?? project.entry }); }
      catch (e) {
        const message = e instanceof ProjectManifestError ? e.message : (e as Error).message;
        say(`[ainize] error: ${message}`);
        finish({ status: 'error', error: message });
        return;
      }
      // The console reads the manifest from the newest deployment rather than cloning again.
      const snapshot: DeploymentManifest = {
        kind: manifest.kind, env: manifest.env, inputs: manifest.inputs, examples: manifest.examples, detected: manifest.detected,
        ...(manifest.name ? { name: manifest.name } : {}), ...(manifest.entry ? { entry: manifest.entry } : {}),
        ...(manifest.runtime ? { runtime: manifest.runtime } : {}), ...(manifest.timeoutMs ? { timeoutMs: manifest.timeoutMs } : {}),
      };
      store.updateDeployment(d.id, { kind: manifest.kind, manifest: snapshot, runnable: runnableFiles(project.sourcePath ? join(work, project.sourcePath) : work) });
      say(`[ainize] ${manifest.kind} (${manifest.detected === 'package.json' ? 'no ainize.json; package.json depends on next' : 'ainize.json'})`);
      const publicUrl = this.deps.publicUrl().replace(/\/+$/, '');
      const env = { AINIZE_PROJECT: project.id, AINIZE_COMMIT: sha };
      if (isRun && manifest.kind !== 'script') {
        say(`[ainize] error: an ad-hoc run needs a script project; this commit's ainize.json says ${manifest.kind}`);
        finish({ status: 'error', error: `a ${manifest.kind} project is deployed by a push, not run` });
        return;
      }

      if (manifest.kind === 'service' || manifest.kind === 'nextjs') {
        if (!this.deps.containers) { say('[ainize] error: this node runs no project containers (Docker is not enabled)'); finish({ status: 'error', error: 'this node runs no project containers (Docker is not enabled)' }); return; }
        await this.deps.containers.deploy({ projectId: project.id, deploymentId: d.id, sha: d.sha }, project.sourcePath ? join(work, project.sourcePath) : work, manifest, env, say, this.actorKey(d, say));
        const outputUrl = `${publicUrl}/svc/${project.id}/`;
        say(`[ainize] ready at ${outputUrl}`);
        finish({ status: 'ready', exitCode: null, error: null, outputUrl });
        return;
      }

      if (manifest.kind === 'agent') {
        if (!this.deps.agents) { say('[ainize] error: this node hosts no agents'); finish({ status: 'error', error: 'this node hosts no agents' }); return; }
        const spec = await deployProjectAgent(this.deps.agents, project, project.sourcePath ? join(work, project.sourcePath) : work, manifest, say, sha);
        const outputUrl = `${publicUrl}/agents/${spec.id}`;
        say(`[ainize] ready at ${outputUrl} (A2A, v${spec.version})`);
        finish({ status: 'ready', exitCode: null, error: null, outputUrl });
        return;
      }

      const entry = d.entry ?? manifest.entry!;
      const language = manifest.runtime === 'python3.11' && !d.entry ? 'python' : manifest.runtime === 'node20' && !d.entry ? 'node' : languageOf(entry);
      if (!language) { say(`[ainize] error: no runtime for "${entry}"`); finish({ status: 'error', error: `entry "${entry}" is not a .py/.js/.mjs file and ainize.json names no runtime` }); return; }
      let files: Record<string, string>;
      try { files = readTree(project.sourcePath ? join(work, project.sourcePath) : work); } catch (e) { say(`[ainize] error: ${(e as Error).message}`); finish({ status: 'error', error: (e as Error).message }); return; }
      if (!(entry in files)) { say(`[ainize] error: entry "${entry}" is not in the repository`); finish({ status: 'error', error: `entry "${entry}" not found` }); return; }
      say(`[ainize] run ${entry} (${language}, ${Object.keys(files).length} files)`);
      let exit: { code: number; ms: number } | null = null;
      let runError: string | null = null;
      const apiKey = this.actorKey(d, say);
      const answers: Record<string, string> = {};
      for (const [name, value] of Object.entries(d.inputs ?? {})) answers[inputEnvName(name)] = value;
      await this.deps.run({ language, entry, files, env: { ...manifest.env, ...(d.env ?? {}), ...inputDefaults(manifest.inputs), ...answers, ...env }, timeoutMs: manifest.timeoutMs ?? this.deps.runTimeoutMs ?? PROJECT_RUN_TIMEOUT_MS, ...(apiKey ? { apiKey } : {}) }, (ev) => {
        if (ev.event === 'stdout') { logs.append(d.id, ev.data); logs.append(d.id, ev.data, 'out'); }
        else if (ev.event === 'stderr') logs.append(d.id, ev.data);
        else if (ev.event === 'error') { runError = ev.data; say(`[ainize] error: ${ev.data}`); }
        else if (ev.event === 'exit') exit = ev.data;
      });
      if (!exit) { finish({ status: 'error', error: runError ?? 'the run ended without an exit event' }); return; }
      const { code, ms } = exit as { code: number; ms: number };
      say(`[ainize] exit ${code} after ${ms}ms`);
      finish({ status: code === 0 ? 'ready' : 'error', exitCode: code, error: code === 0 ? null : (runError ?? `exit ${code}`), outputUrl: code === 0 ? `${publicUrl}/api/deployments/${d.id}/output` : null });
    } catch (e) {
      const message = (e as Error).message ?? String(e);
      say(`[ainize] error: ${message}`);
      finish({ status: 'error', error: message });
    } finally {
      rmSync(work, { recursive: true, force: true });
      this.deps.log?.('info', `project ${project.id}: ${d.trigger === 'run' ? 'run' : 'deployment'} ${d.id} ${store.deployment(d.id)?.status ?? '?'} (${(store.deployment(d.id)?.sha ?? d.sha).slice(0, 12)})`);
    }
  }

  /**
   * `git clone --depth 1 --branch <branch>` then land on `sha`. Right after a push the tip IS the sha; when a
   * later push queued behind this one has moved the tip, the commit is fetched by id (or the clone deepened when
   * the server will not serve a bare sha). The token (pasted or the node's own) travels in the environment as a
   * git config entry, so a process listing never shows it.
   */
  /** The HEAD commit's subject line, or null when git will not say. */
  private async subjectOf(dir: string): Promise<string | null> {
    try { return (await exec('git', ['-C', dir, 'log', '-1', '--format=%s'], { timeout: 10_000 })).stdout.trim().slice(0, 200) || null; }
    catch { return null; }
  }

  /**
   * The repository at `sha` in `dir`, with the same credentials a deployment clones with — for a run pressed from a
   * link snippet (`POST /api/projects/:id/run`, project-routes.ts), which executes the deployed commit again with
   * a person's answers. The caller owns `dir` and removes it.
   */
  async checkout(project: Project, sha: string, dir: string, say: (line: string) => void = () => {}): Promise<void> {
    await this.clone(project, sha, dir, say);
  }

  /** Returns the commit the tree is at — `sha`, or the branch tip when `sha` is empty (an ad-hoc run of HEAD). */
  private async clone(project: Project, sha: string, dir: string, say: (line: string) => void = () => {}): Promise<string> {
    // Credential order: a pasted deploy token (the owner's explicit choice) wins; else the node's own machine identity
    // at AIN SSO for this repository's host (aindrive makes it a viewer on the drives shared with the organizations
    // the app is assigned in); else anonymous (a public repo).
    let token = this.deps.deployToken(project.id);
    if (token) say('[ainize] clone with the project\'s deploy token');
    else if (this.deps.serviceToken) {
      const resource = new URL(project.repo).origin;
      token = await this.deps.serviceToken(resource);
      say(token ? `[ainize] clone as this node (AIN SSO machine token for ${resource})` : '[ainize] clone anonymously (no machine token for this host)');
    }
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' };
    if (token) {
      env.GIT_CONFIG_COUNT = '1';
      env.GIT_CONFIG_KEY_0 = 'http.extraHeader';
      env.GIT_CONFIG_VALUE_0 = `Authorization: Bearer ${token}`;
    }
    const timeout = this.deps.cloneTimeoutMs ?? 120_000;
    const git = async (args: string[]) => {
      try { return await exec('git', args, { env, timeout, maxBuffer: 8 * 1024 * 1024 }); }
      catch (e) {
        const x = e as { stderr?: string; message?: string };
        throw new Error(`git ${args[0]} failed: ${(x.stderr ?? x.message ?? '').replace(/Authorization: Bearer \S+/g, 'Authorization: Bearer ***').trim().slice(0, 500)}`);
      }
    };
    await git(['clone', '--quiet', '--depth', '1', '--branch', project.branch, '--', parseRepoUrl(project.repo)?.url ?? project.repo, dir]);
    const head = (await git(['-C', dir, 'rev-parse', 'HEAD'])).stdout.trim();
    if (!sha || head === sha) return head;
    try { await git(['-C', dir, 'fetch', '--quiet', '--depth', '1', 'origin', sha]); }
    catch { await git(['-C', dir, 'fetch', '--quiet', '--unshallow', 'origin', project.branch]); }
    await git(['-C', dir, 'checkout', '--quiet', '--detach', sha]);
    return sha;
  }
}

/** The repository's runnable files (what the Run panel offers as `entry`), `main.*`/`index.*` first, ≤ 64. */
export function runnableFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 4) return;
    for (const name of readdirSync(dir).sort()) {
      if (name === '.git' || name === 'node_modules' || name.startsWith('.')) continue;
      const full = join(dir, name);
      let st; try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) { walk(full, depth + 1); continue; }
      if (st.isFile() && languageOf(name) && out.length < 64) out.push(relative(root, full).split('\\').join('/'));
    }
  };
  walk(root, 0);
  const rank = (n: string) => (/^main\./i.test(n) ? 0 : /^index\./i.test(n) ? 1 : n.includes('/') ? 3 : 2);
  return out.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** The working tree as `/api/run` files: every regular file but `.git`, ≤ 32 of them, ≤ 2 MiB, utf-8. */
export function readTree(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  let bytes = 0;
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === '.git') continue;
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) { walk(full); continue; }
      if (!st.isFile()) continue;
      if (Object.keys(files).length >= PROJECT_MAX_FILES) throw new Error(`the repository has more than ${PROJECT_MAX_FILES} files; a script project runs a tree of at most ${PROJECT_MAX_FILES}`);
      bytes += st.size;
      if (bytes > PROJECT_MAX_BYTES) throw new Error(`the repository is over ${PROJECT_MAX_BYTES / 1024 / 1024} MiB of files`);
      files[relative(root, full).split('\\').join('/')] = readFileSync(full, 'utf8');
    }
  };
  walk(root);
  return files;
}

// ------------------------------------------------------------------------------------------------ the sandbox

/** The run sandbox in this process (run-sandbox.ts) as a `RunScript` — what server.ts wires when Docker is on. */
export function runScriptViaSandbox(sandbox: Pick<RunSandbox, 'run'>, callerId = 'project'): RunScript {
  return async (req, onEvent) => {
    try {
      const { apiKey, ...rest } = req;
      const outcome = await sandbox.run({ ...rest, bytes: Object.values(req.files).reduce((n, s) => n + Buffer.byteLength(s, 'utf8'), 0) }, { id: `project:${callerId}`, keyed: true, ...(apiKey ? { key: apiKey } : {}) }, {
        stdout: (chunk) => onEvent({ event: 'stdout', data: chunk }),
        stderr: (chunk) => onEvent({ event: 'stderr', data: chunk }),
      });
      if (outcome.error) onEvent({ event: 'error', data: outcome.error });
      onEvent({ event: 'exit', data: { code: outcome.code, ms: outcome.ms } });
    } catch (e) {
      onEvent({ event: 'error', data: (e as Error).message });
    }
  };
}

// ------------------------------------------------------------------------------------------------ run over HTTP

/**
 * `POST /api/run` on this node, read as SSE. The default `RunScript` when nothing in-process is wired — the run
 * API is another module's (deploy/run-runtime/README.md) and this is its contract, not its code.
 */
export function runScriptOverHttp(base: () => string, headers: () => Record<string, string> = () => ({})): RunScript {
  return async (req, onEvent) => {
    // Over HTTP the key is the caller's bearer, never a body field: the pusher's key rides as `authorization`.
    const { apiKey, ...body } = req;
    const res = await fetch(`${base().replace(/\/+$/, '')}/api/run`, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...headers(), ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) }, body: JSON.stringify(body),
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      let message = text.slice(0, 300);
      try { message = (JSON.parse(text) as { error?: { message?: string; code?: string } }).error?.message ?? message; } catch { /* plain text */ }
      onEvent({ event: 'error', data: `run api answered ${res.status}: ${message}` });
      return;
    }
    const decoder = new TextDecoder();
    let buf = '';
    const dispatch = (block: string) => {
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (!data.length) return;
      let parsed: unknown;
      try { parsed = JSON.parse(data.join('\n')); } catch { parsed = data.join('\n'); }
      if (event === 'exit' && parsed && typeof parsed === 'object') onEvent({ event: 'exit', data: parsed as { code: number; ms: number } });
      else if (event === 'stdout' || event === 'stderr' || event === 'error') onEvent({ event, data: typeof parsed === 'string' ? parsed : JSON.stringify(parsed) });
    };
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let at: number;
      while ((at = buf.indexOf('\n\n')) !== -1) { dispatch(buf.slice(0, at)); buf = buf.slice(at + 2); }
    }
    if (buf.trim()) dispatch(buf);
  };
}
