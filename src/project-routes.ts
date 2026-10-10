/**
 * `/api/projects`, `/api/deployments` and `/api/orgs/:org/{projects,repositories}` — projects bound to aindrive git
 * repositories (projects.ts).
 *
 * Auth is the hosted-agent model: whoever is signed in (AIN SSO, wallet session, API key) owns what they create.
 * READING is public (docs/PROJECTS.md "Who sees what"): a project is an organization's repository, its page is
 * `ainize.ai/<org>/<repo>` like the repo's own `aindrive.ainetwork.ai/<org>/git/<repo>`, and `GET /by-repo` had
 * already shown status and the newest deployment to anyone — so `GET /:id`, `/:id/deployments` and the deployment
 * log/output answer the same non-secret view to anyone; the owner alone sees `owner` and `hookUrl`. CHANGING is
 * not: delete and rotate-secret are the owner's; an ad-hoc run and a redeploy take the owner or a member of the
 * repository's organization (they run with the caller's own key). The push hook (`POST /:id/hook`) is aindrive's,
 * with an HMAC rather than a session. by-repo, by-name and the org listings answer CORS for
 * `https://aindrive.ainetwork.ai`. Errors are `{ error: { code, message } }` like the agent routes.
 *
 * A third door is the AIN-UI link snippet (docs/PROJECTS.md "Link snippets", aindrive docs/AINUI-LINK-SNIPPETS.md):
 * a consumer application (AIN Teams) holding an AIN SSO machine token for this node names the VIEWER in
 * `X-AIN-Actor`, and `GET /api/ainui/snippet`, `GET /:id/deployments`, `POST /:id/run` and `POST /:id/redeploy`
 * answer for that person — owner, or an active member of the project's organization — exactly as a signed-in
 * session of theirs would. `deps.actor` turns the two headers into a principal; without it those doors stay shut.
 */
import { Router, type Request, type Response } from 'express';
import type { HostedAgentSecretStore } from './hosted-agent-secrets.js';
import type { ProjectContainers } from './project-containers.js';
import type { AgentCaller } from './shared-agents.js';
import {
  hookBody, hookSignatureOk, parseRepoUrl, projectInput, runInput, type Deployment, type DeploymentLogs, type Project, ProjectLimitError, ProjectRepoTakenError,
  type ProjectStore, type ProjectWorker, PROJECT_DEFAULT_CORS_ORIGINS, PROJECT_SECRET_DEPLOY_TOKEN, PROJECT_SECRET_WEBHOOK,
  languageOf, readTree, projectRoot, PROJECT_RUN_TIMEOUT_MS,
} from './projects.js';
import { repositoryId } from './repository-runtime.js';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { SsoError, type ServicePrincipal } from './sso.js';
import { AINUI_MEDIA_TYPE, deniedSnippet, parseSnippetUrl, projectSnippet, snippetInputsOf, validateRunEnv, wantsAinui } from './ainui-snippet.js';
import { inputDefaults, resolveProjectManifest, ProjectManifestError } from './project-manifest.js';
import { RUN_ACTOR_HEADER, RunActorError } from './run-actor.js';

export interface ProjectRoutesDeps {
  store: ProjectStore;
  /** Webhook secrets and deploy tokens, sealed at rest; keyed by project id (hosted-agent-secrets.ts). */
  secrets: Pick<HostedAgentSecretStore, 'set' | 'reveal' | 'dropAgent'>;
  logs: DeploymentLogs;
  worker: ProjectWorker;
  /** Running service/nextjs containers, for `/svc/:id/*`. Absent → that path is 404. */
  containers?: Pick<ProjectContainers, 'current'>;
  caller: (req: Request) => AgentCaller | null;
  publicBase: (req: Request) => string;
  /** Browser origins allowed to read status and (for aindrive's server) post the hook. */
  corsOrigins?: string[];
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  /**
   * AIN organization IDs this node knows under an org slug — who may run and redeploy an organization's repository.
   * Defaults to `auto.orgIdsForSlug`; without either, only the owner may.
   */
  orgIdsForSlug?: (slug: string) => string[];
  /**
   * `GET /api/orgs/:org/repositories` — the drive's `repositories/` folder as aindrive lists it, read with this node's
   * machine token (sso-service-token.ts) so the org page shows a repo before it was ever pushed. Absent → 503.
   */
  aindrive?: {
    /** aindrive's origin, e.g. `https://aindrive.ainetwork.ai`. */
    origin: string;
    /** A client_credentials bearer for `resource` (aindrive's origin), or null when the node has none. */
    token: (resource: string) => Promise<string | null>;
    fetch?: typeof fetch;
    /** How long one organization's listing is kept (default 30 s). */
    cacheMs?: number;
  };
  /**
   * Auto-binding (`POST /api/projects/auto`, docs/PROJECTS.md): aindrive acting as itself with an AIN SSO machine
   * token. Absent → the route answers 503 (no AIN SSO, or no `AIN_SSO_SERVICE_APPS`).
   */
  auto?: {
    /** Verifies `Authorization` as a machine token for this node (sso.ts verifyServiceToken); throws SsoError. */
    servicePrincipal: (authorization: string | undefined) => Promise<ServicePrincipal>;
    /** AIN organization IDs this node knows under an org slug (the repo URL's `<org>` segment). */
    orgIdsForSlug: (slug: string) => string[];
    /** The principal an AIN SSO subject is here (`sso:<sub>`, or the legacy principal it was linked to). */
    principalForSubject: (subject: string) => string;
  };
  /**
   * A consumer application asking FOR a person (link snippets): its machine token + `X-AIN-Actor`. Absent → the
   * snippet and the actor-driven run/redeploy answer 503 `snippets_off`.
   */
  actor?: {
    /** Verifies `Authorization` as a machine token for this node (sso.ts verifyServiceToken); throws SsoError. */
    servicePrincipal: (authorization: string | undefined) => Promise<ServicePrincipal>;
    /** The principal an AIN SSO subject is here (`sso:<sub>`, or the legacy principal it was linked to). */
    principalForSubject: (subject: string) => string;
    /** AIN organization IDs this node knows under an org slug (the project's `org`). */
    orgIdsForSlug: (slug: string) => string[];
    /** The organizations the subject is an ACTIVE member of (provisioned memberships). */
    memberOrgs: (subject: string) => string[];
    /** The person's own `aindrive run` key for a run (run-actor.ts); absent → runs get no key. Throws RunActorError / SsoError. */
    keyFor?: (subject: string) => string;
  };
}

/** Who a snippet door is answering: a session of this node, or a person named by a trusted application. */
type Viewer =
  | { kind: 'session'; principal: string; subject: string | null; orgMember: (orgId: string) => boolean }
  | { kind: 'actor'; principal: string; subject: string; orgs: string[]; app: string };

/** `POST /api/projects/auto` body: the pushed repo and what aindrive knows about it. */
export const autoBindInput = z.object({
  bindRequestId: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  repo: z.string().min(1).max(1024),
  branch: z.string().regex(/^[A-Za-z0-9._\/-]+$/, 'a branch name').max(200).optional(),
  pusher: z.object({ subject: z.string().min(1).max(300).nullable().optional(), email: z.string().max(300).nullable().optional() }).optional(),
  manifest: z.object({ kind: z.string().max(40).nullable().optional(), name: z.string().min(1).max(100).nullable().optional() }).optional(),
});
export type AutoBindInput = z.infer<typeof autoBindInput>;

const refuse = (res: Response, status: number, code: string, message: string) => { res.status(status).json({ error: { code, message } }); };

export function projectRoutes(deps: ProjectRoutesDeps): Router {
  const router = Router();
  const origins = new Set(deps.corsOrigins ?? PROJECT_DEFAULT_CORS_ORIGINS);
  const base = (req: Request) => deps.publicBase(req).replace(/\/+$/, '');

  const cors = (req: Request, res: Response): void => {
    const origin = req.header('origin');
    if (!origin || !origins.has(origin)) return;
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Ainize-Signature');
    res.setHeader('Access-Control-Max-Age', '600');
  };
  const preflight = (req: Request, res: Response) => { cors(req, res); res.status(204).end(); };

  const signedIn = (req: Request, res: Response): AgentCaller | null => {
    const who = deps.caller(req);
    if (!who) refuse(res, 401, 'not_signed_in', 'sign in (AIN SSO or wallet) to create or read projects');
    return who;
  };
  const notFound = (res: Response, id: unknown) => refuse(res, 404, 'not_found', `no project "${id}" on this node`);
  const orgIdsForSlug = deps.orgIdsForSlug ?? deps.auto?.orgIdsForSlug ?? (() => []);

  /** The project, if the caller owns it; a project they do not own is 404. */
  const owned = (req: Request, res: Response): Project | null => {
    const who = signedIn(req, res);
    if (!who) return null;
    const project = deps.store.get(String(req.params.id));
    if (!project || project.owner !== who.subject) { notFound(res, req.params.id); return null; }
    return project;
  };
  /** May this caller run or redeploy the project: its owner, or a member of the repository's organization. */
  const mayOperate = (who: AgentCaller, p: Project): boolean => {
    if (p.owner === who.subject) return true;
    const ids = orgIdsForSlug(p.org);
    return ids.some((id) => who.orgMember(id) || (who.sso?.orgs ?? []).includes(id));
  };
  /** The project, for a caller who may run/redeploy it; 404 when it does not exist, 403 `not_member` otherwise. */
  const operable = (req: Request, res: Response): { who: AgentCaller; project: Project } | null => {
    const who = signedIn(req, res);
    if (!who) return null;
    const project = deps.store.get(String(req.params.id));
    if (!project) { notFound(res, req.params.id); return null; }
    if (!mayOperate(who, project)) { refuse(res, 403, 'not_member', `only the owner or a member of "${project.org}" may run or redeploy this project`); return null; }
    return { who, project };
  };
  const actorOf = (who: AgentCaller): { subject: string; email?: string } => ({ subject: who.sso?.sub ?? who.subject });

  /** `https://ainize.ai/<org>/<repo>` — the project's page, the GitHub-shaped address that mirrors the repo's aindrive URL. */
  const pageUrlOf = (req: Request, p: Pick<Project, 'org' | 'repoName'>) => `${base(req)}/${encodeURIComponent(p.org)}/${encodeURIComponent(p.repoName)}`;

  /** What everyone sees of a project: the repo, its status, the newest deployment and what its ainize.json said. No owner, no hook address. */
  const publicView = (req: Request, p: Project) => {
    const last = p.lastDeploymentId ? deps.store.deployment(p.lastDeploymentId) : null;
    const described = last?.manifest ? last : deps.store.deploymentsOf(p.id).find((d) => d.manifest) ?? null;
    return {
      id: p.id, repoId: repositoryId(p.repo), sourcePath: p.sourcePath ?? '', sourceCommit: p.sourceCommit ?? null, activeCommit: p.activeCommit ?? null, activeDeploymentId: p.activeDeploymentId ?? null, org: p.org, repoName: p.repoName, repo: p.repo, branch: p.branch, kind: p.kind, entry: p.entry, name: p.name, status: p.status,
      url: pageUrlOf(req, p), pageUrl: pageUrlOf(req, p), lastDeploymentId: p.lastDeploymentId, createdAt: p.createdAt, updatedAt: p.updatedAt,
      lastDeployment: last ? deploymentView(req, last) : null,
      manifest: described?.manifest ?? null, runnable: described?.runnable ?? [],
    };
  };
  /** The owner's view: the public one plus `owner` and the hook address. `canManage` says which the caller got. */
  const projectView = (req: Request, p: Project, who: AgentCaller | null) => {
    const pub = publicView(req, p);
    const owner = !!who && who.subject === p.owner;
    return {
      ...pub, canManage: owner, canOperate: !!who && mayOperate(who, p),
      ...(owner ? { owner: p.owner, hookUrl: `${base(req)}/api/projects/${p.id}/hook` } : {}),
    };
  };
  const deploymentView = (req: Request, d: Deployment) => ({
    id: d.id, projectId: d.projectId, repoId: repositoryId(deps.store.get(d.projectId)?.repo ?? ''), sourceCommit: d.sha || null, actor: d.pusher?.subject ?? null, sha: d.sha, ref: d.ref, status: d.status, pusher: d.pusher, createdAt: d.createdAt,
    startedAt: d.startedAt, finishedAt: d.finishedAt, ms: d.ms, ...(d.exitCode === null ? {} : { exitCode: d.exitCode }), ...(d.error ? { error: d.error } : {}),
    ...(d.kind ? { kind: d.kind } : {}), trigger: d.trigger ?? 'push', ...(d.subject ? { subject: d.subject } : {}),
    ...(d.trigger === 'run' ? { target: d.target ?? 'head', entry: d.entry ?? null, inputs: d.inputs ?? {}, env: d.env ?? {} } : {}),
    logUrl: `${base(req)}/api/deployments/${d.id}/log`,
    ...(d.status === 'ready' && d.outputUrl ? { outputUrl: d.outputUrl } : {}),
  });
  const queued = (d: Deployment) => { deps.worker.enqueue(d.id); return { deploymentId: d.id, status: d.status }; };
  const ORG_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

  // ------------------------------------------------------------------------------------------ viewers (link snippets)

  const SUBJECT = /^[A-Za-z0-9._:@%+/-]{1,300}$/;
  /**
   * The viewer of a snippet door: a machine token names an application, and `X-AIN-Actor` the person it asks for;
   * anything else is this node's own session. A machine token that does not verify is 401, never a fall-through
   * to an anonymous answer; an application naming nobody is 403 (a snippet is always for someone).
   */
  const viewerOf = async (req: Request, res: Response): Promise<Viewer | null> => {
    const authorization = req.header('authorization');
    const looksLikeMachine = !!authorization && /^Bearer\s+[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/i.test(authorization.trim()) && (() => {
      try { return (JSON.parse(Buffer.from(authorization.trim().split(/\s+/)[1]!.split('.')[0]!, 'base64url').toString('utf8')) as { typ?: string }).typ === 'at+jwt'; } catch { return false; }
    })();
    if (looksLikeMachine) {
      if (!deps.actor) { refuse(res, 503, 'snippets_off', 'this node accepts no machine tokens (AIN SSO off or AIN_SSO_SERVICE_APPS unset)'); return null; }
      let app: ServicePrincipal;
      try { app = await deps.actor.servicePrincipal(authorization); }
      catch (e) {
        if (e instanceof SsoError) { if (e.status === 401) res.set('www-authenticate', 'Bearer error="invalid_token"'); refuse(res, e.status, e.code, e.message); return null; }
        throw e;
      }
      const subject = (req.header(RUN_ACTOR_HEADER) ?? '').trim();
      if (!subject) { refuse(res, 403, 'actor_required', `${RUN_ACTOR_HEADER} names the person this is for; "${app.clientId}" named nobody`); return null; }
      if (!SUBJECT.test(subject)) { refuse(res, 400, 'invalid_actor', `${RUN_ACTOR_HEADER} is not an AIN SSO subject`); return null; }
      return { kind: 'actor', principal: deps.actor.principalForSubject(subject), subject, orgs: deps.actor.memberOrgs(subject), app: app.clientId };
    }
    const who = deps.caller(req);
    if (!who) { refuse(res, 401, 'not_signed_in', 'sign in (AIN SSO or wallet), or ask through an application that names you'); return null; }
    return { kind: 'session', principal: who.subject, subject: who.sso?.sub ?? null, orgMember: who.orgMember };
  };

  /** Viewer+: the owner, or an active member of an organization this node knows under the project's org slug. */
  const canSee = (p: Project, v: Viewer): boolean => {
    if (p.owner === v.principal) return true;
    const orgIds = deps.actor?.orgIdsForSlug(p.org) ?? [];
    return v.kind === 'actor' ? orgIds.some((id) => v.orgs.includes(id)) : orgIds.some((id) => v.orgMember(id));
  };
  /** Editor: the owner. */
  const canEdit = (p: Project, v: Viewer): boolean => p.owner === v.principal;

  const snippetHeaders = (res: Response) => res.set({ 'content-type': AINUI_MEDIA_TYPE, 'cache-control': 'private, no-store', vary: 'Accept, Authorization, X-AIN-Actor' });

  const resolveSource = async (project: Project, sha: string) => {
    const work = mkdtempSync(join(tmpdir(), 'ainize-project-source-'));
    try {
      const resolved = await deps.worker.checkout(project, sha, work);
      const manifest = resolveProjectManifest(projectRoot(work, project.sourcePath), { entry: project.entry });
      return { sha: resolved, manifest };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  };

  /**
   * `GET /api/ainui/snippet?url=<pasted URL>` (or `?path=/<org>/<repo>`): the project's AIN-UI snippet for the
   * viewer. ainize-web's middleware sends a page request with `Accept: application/vnd.ain.ui+json` here. An
   * unknown project is 404; a known one the viewer may not see is 403 with the sign-in surface.
   */
  router.get('/api/ainui/snippet', async (req, res) => {
    const raw = String(req.query.url ?? req.query.path ?? '');
    if (!raw) return refuse(res, 400, 'invalid_request', 'url: the pasted ainize URL (or path: its path)');
    const target = parseSnippetUrl(raw, base(req));
    if (!target) return refuse(res, 404, 'not_found', `${raw} is not a project page on this node`);
    const project = 'projectId' in target ? deps.store.get(target.projectId) : deps.store.list().find((p) => p.org.toLowerCase() === target.org.toLowerCase() && p.repoName.toLowerCase() === target.repo.toLowerCase()) ?? null;
    if (!project) return notFound(res, 'projectId' in target ? target.projectId : `${target.org}/${target.repo}`);
    const viewer = await viewerOf(req, res);
    if (!viewer) return;
    snippetHeaders(res);
    if (!canSee(project, viewer)) return res.status(403).send(JSON.stringify(deniedSnippet(new URL(base(req)).host, `${project.org}/${project.repoName}`, pageUrlOf(req, project))));
    const deployments = deps.store.deploymentsOf(project.id);
    const last = project.activeDeploymentId ? deps.store.deployment(project.activeDeploymentId) : null;
    const pasted = new URL(raw, base(req));
    const selection = pasted.searchParams.get('runTarget') ?? 'deployed';
    const requestedSha = pasted.searchParams.get('runSha');
    if (!['head', 'deployed', 'commit'].includes(selection) ||
        (selection === 'commit' ? !requestedSha || !/^[0-9a-f]{40,64}$/i.test(requestedSha) : requestedSha !== null)) {
      return refuse(res, 400, 'invalid_request', 'invalid snippet source target');
    }
    let selected = last ? { sha: last.sha, manifest: last.manifest } : null;
    if (selection !== 'deployed') {
      try { selected = await resolveSource(project, selection === 'commit' ? requestedSha! : ''); }
      catch (error) { return refuse(res, 502, 'source_failed', (error as Error).message); }
    } else if (!last && pasted.searchParams.has('runTarget')) {
      return refuse(res, 409, 'no_deployment', 'no successful deployment is available');
    }
    const kind = selected?.manifest?.kind ?? last?.kind ?? project.kind;
    const entry = selected?.manifest?.entry ?? project.entry;
    const run = kind === 'script' && selected && entry ? { entry, inputs: snippetInputsOf(selected.manifest?.inputs), sha: selected.sha } : null;
    const page = new URL(pageUrlOf(req, project));
    if (selected) {
      page.searchParams.set('runTarget', 'commit');
      page.searchParams.set('runSha', selected.sha);
    }
    res.status(200).send(JSON.stringify(projectSnippet({ project, deployments, base: base(req), pageUrl: page.toString(), run,
      source: { selected: selected ? `Commit ${selected.sha}` : 'No deployed version', baseUrl: pageUrlOf(req, project) },
      canRedeploy: canEdit(project, viewer) })));
  });

  /** The project when the viewer may see it; 404 otherwise (never a hint that it exists). */
  const seen = async (req: Request, res: Response): Promise<{ project: Project; viewer: Viewer } | null> => {
    const project = deps.store.get(String(req.params.id));
    if (!project) { notFound(res, req.params.id); return null; }
    const viewer = await viewerOf(req, res);
    if (!viewer) return null;
    if (!canSee(project, viewer)) { notFound(res, req.params.id); return null; }
    return { project, viewer };
  };

  /** A form always comes from the same immutable source its Run button will execute. */
  router.get('/api/projects/:id/source', async (req, res) => {
    const hit = await seen(req, res);
    if (!hit) return;
    const parsed = runInput.safeParse({ target: req.query.target ?? 'head', ...(req.query.sha ? { sha: req.query.sha } : {}) });
    if (!parsed.success) return refuse(res, 400, 'invalid_request', 'invalid source target');
    const { target, sha } = parsed.data;
    if ((target === 'commit' && !sha) || (target !== 'commit' && sha)) return refuse(res, 400, 'invalid_request', 'sha is required only for a commit target');
    const project = hit.project;
    const active = project.activeDeploymentId ? deps.store.deployment(project.activeDeploymentId) : null;
    if (target === 'deployed' && !active?.sha) return refuse(res, 409, 'no_deployment', 'no successful deployment is available');
    try {
      const resolved = await resolveSource(project, target === 'deployed' ? active!.sha : sha ?? '');
      res.set('cache-control', 'private, no-store').json({ repoId: repositoryId(project.repo), target, ...resolved, sourcePath: project.sourcePath ?? '' });
    } catch (error) {
      refuse(res, 502, 'source_failed', (error as Error).message);
    }
  });

  /**
   * `POST /api/projects/:id/run { env? }` → `text/event-stream` (`stdout` / `stderr` / `error` / `exit`, the shape of
   * `/api/run`): the deployed commit of a `script` project, run again with the person's answers to the manifest's
   * inputs — the Run button of the link snippet. Viewer+; the run is FOR the viewer (their `aindrive run` key).
   */
  router.post('/api/projects/:id/run', async (req, res) => {
    const hit = await seen(req, res);
    if (!hit) return;
    const { project, viewer } = hit;
    const parsed = runInput.safeParse({ ...(req.body ?? {}), target: req.body?.target ?? 'deployed' });
    if (!parsed.success) return refuse(res, 400, 'invalid_request', parsed.error.issues[0]?.message ?? 'invalid run');
    const input = parsed.data;
    const env = validateRunEnv(input.env);
    if (env === null) return refuse(res, 400, 'invalid_request', 'invalid environment variables');
    if (input.target === 'commit' && !input.sha) return refuse(res, 400, 'invalid_request', 'sha is required for a commit run');
    if (input.target !== 'commit' && input.sha) return refuse(res, 400, 'invalid_request', 'sha is only used for a commit run');
    if (input.entry && input.entry.split('/').some((part) => part === '' || part === '.' || part === '..')) return refuse(res, 400, 'invalid_request', 'entry is a repository-relative file');
    const active = project.activeDeploymentId ? deps.store.deployment(project.activeDeploymentId) : null;
    if (input.target === 'deployed' && !active?.sha) return refuse(res, 409, 'no_deployment', 'no successful deployment is available');
    let apiKey: string | undefined;
    if (viewer.subject && deps.actor?.keyFor) {
      try { apiKey = deps.actor.keyFor(viewer.subject); }
      catch (e) {
        if (e instanceof RunActorError || e instanceof SsoError) return refuse(res, e.status, e.code, e.message);
        throw e;
      }
    }
    const record = deps.store.createRun(project, input, viewer.subject ? { subject: viewer.subject } : { subject: viewer.principal });
    const startedAt = Date.now();
    let releaseSlot: (() => void) | undefined;
    res.setHeader('X-Ainize-Execution', record.id);
    const work = mkdtempSync(join(tmpdir(), 'ainize-snippet-run-'));
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    let streaming = false;
    const open = () => {
      if (streaming) return;
      streaming = true;
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no', connection: 'keep-alive' });
      res.flushHeaders();
    };
    const send = (event: string, data: unknown) => { if (abort.signal.aborted) return; open(); if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    try {
      releaseSlot = await deps.worker.acquireRunSlot(record.id, abort.signal);
      abort.signal.throwIfAborted();
      deps.store.updateDeployment(record.id, { status: 'building', startedAt: Date.now() });
      const sha = await deps.worker.checkout(project, record.sha, work);
      abort.signal.throwIfAborted();
      const root = projectRoot(work, project.sourcePath);
      const manifest = resolveProjectManifest(root, { entry: project.entry });
      const entry = input.entry ?? manifest.entry;
      if (manifest.kind !== 'script' || !entry) throw new Error(`the selected commit's ainize.json is a ${manifest.kind}`);
      const language = manifest.runtime === 'python3.11' ? 'python' : manifest.runtime === 'node20' ? 'node' : languageOf(entry);
      if (!language) throw new Error(`no runtime for "${entry}"`);
      const files = readTree(root);
      if (!(entry in files)) throw new Error(`entry "${entry}" is not in the repository`);
      deps.store.updateDeployment(record.id, { sha, kind: manifest.kind, entry, manifest });
      deps.log?.('info', `project ${project.id}: run ${entry}@${sha.slice(0, 12)} for ${viewer.principal}${viewer.kind === 'actor' ? ` via ${viewer.app}` : ''}`);
      deps.logs.append(record.id, `[ainize] ${input.target}: ${entry}@${sha}\n`);
      let exit: { code: number; ms: number } | null = null;
      await deps.worker.runScript({
        language, entry, files,
        env: { ...manifest.env, ...inputDefaults(manifest.inputs), ...Object.fromEntries(Object.entries(input.inputs ?? {}).map(([key, value]) => [`INPUT_${key}`, String(value)])), ...env, AINIZE_PROJECT: project.id, AINIZE_COMMIT: sha },
        timeoutMs: input.timeoutMs ?? manifest.timeoutMs ?? PROJECT_RUN_TIMEOUT_MS, ...(apiKey ? { apiKey } : {}),
      }, (ev) => {
        if (ev.event === 'exit') exit = ev.data;
        else {
          deps.logs.append(record.id, ev.data);
          if (ev.event === 'stdout') deps.logs.append(record.id, ev.data, 'out');
        }
        send(ev.event, ev.data);
      }, abort.signal);
      const result = exit as { code: number; ms: number } | null;
      if (!result) throw new Error('runner ended without an exit code');
      deps.store.updateDeployment(record.id, { status: result.code === 0 ? 'ready' : 'error', exitCode: result.code, ms: result.ms, finishedAt: Date.now(), error: result.code === 0 ? null : `exit ${result.code}` });
      if (!res.writableEnded) res.end();
    } catch (e) {
      const message = e instanceof ProjectManifestError ? e.message : (e as Error).message;
      deps.logs.append(record.id, `[ainize] ${message}\n`);
      deps.store.updateDeployment(record.id, { status: 'error', error: message, ms: Date.now() - startedAt, finishedAt: Date.now() });
      if (abort.signal.aborted) return;
      if (!streaming) return refuse(res, 502, 'run_failed', message);
      send('error', message);
      send('exit', { code: 1, ms: 0 });
      res.end();
    } finally {
      rmSync(work, { recursive: true, force: true });
      releaseSlot?.();
    }
  });

  /** `POST /api/projects/:id/redeploy` — the owner deploys the project's newest commit again. 202 `{ deploymentId, status }`. */
  router.post('/api/projects/:id/redeploy', async (req, res) => {
    const hit = await seen(req, res);
    if (!hit) return;
    const { project, viewer } = hit;
    if (!canEdit(project, viewer)) return refuse(res, 403, 'forbidden', 'only the project\'s owner redeploys it');
    const last = project.lastDeploymentId ? deps.store.deployment(project.lastDeploymentId) : null;
    if (!last) return refuse(res, 409, 'no_deployment', 'nothing has been deployed yet — push to the project\'s branch first');
    const d = deps.store.createDeployment(project, { ref: `refs/heads/${project.branch}`, before: last.sha, after: last.sha, pusher: viewer.subject ? { subject: viewer.subject } : last.pusher ?? undefined });
    deps.worker.enqueue(d.id);
    deps.log?.('info', `project ${project.id}: redeploy ${last.sha.slice(0, 12)} by ${viewer.principal} → deployment ${d.id}`);
    res.status(202).json({ deploymentId: d.id, status: d.status });
  });

  // ------------------------------------------------------------------------------------------ projects

  router.post('/api/projects', (req, res) => {
    const who = signedIn(req, res);
    if (!who) return;
    const parsed = projectInput.safeParse(req.body ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return refuse(res, 400, 'invalid_request', `${issue?.path.join('.') || 'body'}: ${issue?.message ?? 'invalid'}`);
    }
    const input = parsed.data;
    const repo = parseRepoUrl(input.repo);
    if (!repo) return refuse(res, 400, 'invalid_request', 'repo: an aindrive git URL — https://aindrive.ainetwork.ai/<org>/git/<repo> (https; no credentials in the URL)');
    // `kind` and `entry` are hints for the row; the repository's ainize.json decides at every deploy.
    let project: Project;
    try {
      project = deps.store.create({ repo, sourcePath: input.sourcePath, branch: input.branch, kind: input.kind ?? null, entry: input.entry ?? null, name: input.name }, who.subject);
    } catch (e) {
      if (e instanceof ProjectRepoTakenError) return refuse(res, 409, 'repo_taken', e.message);
      if (e instanceof ProjectLimitError) return refuse(res, 429, 'limit', e.message);
      throw e;
    }
    const webhookSecret = `whsec_${randomBytes(24).toString('hex')}`;
    deps.secrets.set(project.id, PROJECT_SECRET_WEBHOOK, webhookSecret);
    if (input.deployToken) deps.secrets.set(project.id, PROJECT_SECRET_DEPLOY_TOKEN, input.deployToken);
    deps.log?.('info', `project ${project.id}: ${project.org}/${project.repoName} (${project.branch}, ${project.kind}) created by ${who.subject}`);
    // The secret is shown once: aindrive stores it beside the repo's hook, this node keeps it sealed.
    res.status(201).json({ ...projectView(req, project, who), webhookSecret, hasDeployToken: !!input.deployToken });
  });

  /**
   * Auto-binding: aindrive (as itself, with an AIN SSO machine token for this node) reports a push of a repository
   * whose root has `ainize.json`. The owner's words: "ainize.json이 있다는 건 자동 배포가 되었다는 것" — a project exists
   * because the file exists, with no step in between. If no project is bound to the repo, one is created and the
   * webhook secret is returned ONCE (201); if one is, only its id (200) — the secret aindrive already holds keeps
   * working. Who may bind: the application's token must name, in `orgs`, an AIN organization this node knows under
   * the repo URL's `<org>` slug (the drive-id URL form has no org, so it cannot auto-bind). The owner is the pusher's
   * principal here (`sso:<sub>`, or the legacy principal they were linked to); without a pusher subject, the
   * organization itself, `org:<orgId>`.
   */
  router.post('/api/projects/auto', async (req, res) => {
    if (!deps.auto) return refuse(res, 503, 'auto_bind_off', 'this node accepts no machine tokens (AIN SSO off or AIN_SSO_SERVICE_APPS unset)');
    let who: ServicePrincipal;
    try { who = await deps.auto.servicePrincipal(req.header('authorization')); }
    catch (e) {
      if (e instanceof SsoError) { if (e.status === 401) res.set('www-authenticate', 'Bearer error="invalid_token"'); return refuse(res, e.status, e.code, e.message); }
      throw e;
    }
    const parsed = autoBindInput.safeParse(req.body ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return refuse(res, 400, 'invalid_request', `${issue?.path.join('.') || 'body'}: ${issue?.message ?? 'invalid'}`);
    }
    const input = parsed.data;
    const repo = parseRepoUrl(input.repo);
    if (!repo) return refuse(res, 400, 'invalid_request', 'repo: an aindrive git URL — https://aindrive.ainetwork.ai/<org>/git/<repo>');
    const orgIds = deps.auto.orgIdsForSlug(repo.org).filter((id) => who.orgs.includes(id));
    if (orgIds.length === 0) return refuse(res, 403, 'org_not_allowed', `"${who.clientId}" may not bind repositories of "${repo.org}" here: none of the token's organizations is known under that slug`);
    const branch = input.branch ?? 'main';
    const existing = deps.store.byRepo(repo.url);
    if (existing) {
      if (existing.branch !== branch) return refuse(res, 409, 'repo_taken', `${repo.url} is bound to branch ${existing.branch} on this node`);
      // Recover a lost creation response only for the same authenticated application and request.
      let webhookSecret: string | undefined;
      if (input.bindRequestId && existing.bindingReceipt?.clientId === who.clientId && existing.bindingReceipt.requestId === input.bindRequestId) {
        webhookSecret = deps.secrets.reveal(existing.id, [PROJECT_SECRET_WEBHOOK])[PROJECT_SECRET_WEBHOOK];
        if (!webhookSecret) {
          webhookSecret = `whsec_${randomBytes(24).toString('hex')}`;
          deps.secrets.set(existing.id, PROJECT_SECRET_WEBHOOK, webhookSecret);
        }
      }
      return res.status(200).json({ id: existing.id, pageUrl: pageUrlOf(req, existing), created: false, ...(webhookSecret ? { webhookSecret } : {}) });
    }
    const subject = input.pusher?.subject ?? null;
    const owner = subject ? deps.auto.principalForSubject(subject) : `org:${orgIds[0]}`;
    const kind = input.manifest?.kind ?? null;
    let project: Project;
    try {
      project = deps.store.create({ bindingReceipt: input.bindRequestId ? { clientId: who.clientId, requestId: input.bindRequestId } : undefined, repo, branch, kind: kind && (['nextjs', 'script', 'service', 'agent'] as const).includes(kind as 'script') ? (kind as Project['kind']) : null, entry: null, name: input.manifest?.name ?? undefined }, owner);
    } catch (e) {
      if (e instanceof ProjectRepoTakenError) return refuse(res, 409, 'repo_taken', e.message);
      if (e instanceof ProjectLimitError) return refuse(res, 429, 'limit', e.message);
      throw e;
    }
    const webhookSecret = `whsec_${randomBytes(24).toString('hex')}`;
    deps.secrets.set(project.id, PROJECT_SECRET_WEBHOOK, webhookSecret);
    deps.log?.('info', `project ${project.id}: ${project.org}/${project.repoName} (${project.branch}) auto-bound by ${who.clientId} for ${owner}`);
    res.status(201).json({ id: project.id, pageUrl: pageUrlOf(req, project), webhookSecret, created: true });
  });

  router.get('/api/projects', (req, res) => {
    const who = signedIn(req, res);
    if (!who) return;
    res.json({ projects: deps.store.listByOwner(who.subject).map((p) => projectView(req, p, who)) });
  });

  // Before `/:id`, or "by-repo" would be read as a project id.
  router.options('/api/projects/by-repo', preflight);
  router.get('/api/projects/by-repo', (req, res) => {
    cors(req, res);
    const repo = String(req.query.repo ?? '');
    if (!repo) return refuse(res, 400, 'invalid_request', 'repo: the aindrive git URL to look up');
    const project = deps.store.byRepo(repo);
    if (!project) return refuse(res, 404, 'not_found', `no project is bound to ${repo} on this node`);
    res.json(publicView(req, project));
  });

  /** `/<org>/<repo>` → the project (public, like by-repo). Case-insensitive on both. */
  router.options('/api/projects/by-name', preflight);
  router.get('/api/projects/by-name', (req, res) => {
    cors(req, res);
    const org = String(req.query.org ?? ''); const repo = String(req.query.repo ?? '');
    if (!org || !repo) return refuse(res, 400, 'invalid_request', 'org and repo: the repository\'s organization slug and name');
    const project = deps.store.byName(org, repo);
    if (!project) return refuse(res, 404, 'not_found', `no project ${org}/${repo} on this node`);
    res.json(projectView(req, project, deps.caller(req)));
  });

  /** `/<org>` — every project of an organization (public). An unknown org is an empty list; a malformed slug is 404. */
  router.options('/api/orgs/:org/projects', preflight);
  router.get('/api/orgs/:org/projects', (req, res) => {
    cors(req, res);
    const org = String(req.params.org);
    if (!ORG_SLUG.test(org)) return refuse(res, 404, 'not_found', `"${org}" is not an organization slug`);
    const who = deps.caller(req);
    res.json({ org, projects: deps.store.byOrg(org).map((p) => projectView(req, p, who)) });
  });

  /**
   * The drive's `repositories/` as aindrive lists it (`GET <aindrive>/api/orgs/<org>/repositories`, read with this node's
   * machine token), so the org page matches the drive before a repo was pushed. Cached briefly per org.
   */
  const repoCache = new Map<string, { at: number; status: number; body: unknown }>();
  router.options('/api/orgs/:org/repositories', preflight);
  router.get('/api/orgs/:org/repositories', async (req, res) => {
    cors(req, res);
    const org = String(req.params.org);
    if (!ORG_SLUG.test(org)) return refuse(res, 404, 'not_found', `"${org}" is not an organization slug`);
    const a = deps.aindrive;
    if (!a) return refuse(res, 503, 'aindrive_off', 'this node has no machine identity at aindrive (AIN SSO client secret unset)');
    const ttl = a.cacheMs ?? 30_000;
    const key = org.toLowerCase();
    const hit = repoCache.get(key);
    if (hit && Date.now() - hit.at < ttl) { res.set('x-cache', 'hit'); return res.status(hit.status).json(hit.body); }
    const token = await a.token(a.origin).catch(() => null);
    if (!token) return refuse(res, 503, 'aindrive_off', 'this node could not get a machine token for aindrive');
    let upstream: globalThis.Response;
    try { upstream = await (a.fetch ?? fetch)(`${a.origin.replace(/\/+$/, '')}/api/orgs/${encodeURIComponent(org)}/repositories`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal: AbortSignal.timeout(20_000) }); }
    catch (e) { return refuse(res, 502, 'aindrive_unreachable', `aindrive did not answer: ${(e as Error).message}`); }
    if (upstream.status === 404) { const body = { org, repositories: [], known: false }; repoCache.set(key, { at: Date.now(), status: 200, body }); return res.json(body); }
    if (!upstream.ok) return refuse(res, 502, 'aindrive_error', `aindrive answered ${upstream.status}`);
    const json = await upstream.json().catch(() => null) as { repositories?: unknown[]; driveId?: string; driveUrl?: string } | null;
    const body = { org, known: true, driveId: json?.driveId ?? null, driveUrl: json?.driveUrl ?? null, repositories: Array.isArray(json?.repositories) ? json!.repositories : [] };
    repoCache.set(key, { at: Date.now(), status: 200, body });
    res.json(body);
  });

  router.get('/api/projects/:id', (req, res) => {
    const project = deps.store.get(String(req.params.id));
    if (!project) return notFound(res, req.params.id);
    res.json(projectView(req, project, deps.caller(req)));
  });

  /** A new webhook secret, shown once; the old one stops verifying at once. Owner only. */
  router.patch('/api/projects/:id/rotate-secret', (req, res) => {
    const project = owned(req, res);
    if (!project) return;
    const webhookSecret = `whsec_${randomBytes(24).toString('hex')}`;
    deps.secrets.set(project.id, PROJECT_SECRET_WEBHOOK, webhookSecret);
    deps.log?.('info', `project ${project.id}: webhook secret rotated by ${project.owner}`);
    res.json({ id: project.id, webhookSecret, hookUrl: `${base(req)}/api/projects/${project.id}/hook` });
  });

  router.delete('/api/projects/:id', (req, res) => {
    const project = owned(req, res);
    if (!project) return;
    for (const d of deps.store.deploymentsOf(project.id)) deps.logs.remove(d.id);
    deps.store.delete(project.id);
    deps.secrets.dropAgent(project.id);
    deps.log?.('info', `project ${project.id}: removed by ${project.owner}`);
    res.json({ ok: true, id: project.id });
  });

  // ------------------------------------------------------------------------------------------ the push hook

  router.options('/api/projects/:id/hook', preflight);
  router.post('/api/projects/:id/hook', (req, res) => {
    cors(req, res);
    const project = deps.store.get(String(req.params.id));
    if (!project) return notFound(res, req.params.id);
    const secret = deps.secrets.reveal(project.id, [PROJECT_SECRET_WEBHOOK])[PROJECT_SECRET_WEBHOOK];
    const raw = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    if (!secret || !hookSignatureOk(secret, raw, req.header('x-ainize-signature'))) return refuse(res, 401, 'bad_signature', 'X-Ainize-Signature does not match this project\'s webhook secret');
    const parsed = hookBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return refuse(res, 400, 'invalid_request', `${issue?.path.join('.') || 'body'}: ${issue?.message ?? 'invalid'}`);
    }
    const body = parsed.data;
    if (body.ref !== `refs/heads/${project.branch}`) return res.status(202).json({ ignored: true, reason: `this project deploys refs/heads/${project.branch}` });
    if (/^0+$/.test(body.after)) return res.status(202).json({ ignored: true, reason: 'branch deleted' });
    const deliveryId = body.deliveryId ?? createHash('sha256').update(raw).digest('hex');
    const prior = deps.store.delivery(project.id, deliveryId);
    if (prior) return res.status(202).json({ ...prior, duplicate: true });
    const d = deps.store.createDeployment(project, { ...body, deliveryId });
    deps.worker.enqueue(d.id);
    deps.log?.('info', `project ${project.id}: push ${body.after.slice(0, 12)} by ${body.pusher?.subject ?? '?'} → deployment ${d.id}`);
    res.status(202).json({ deploymentId: d.id, status: d.status });
  });

  // ------------------------------------------------------------------------------------------ deployments

  router.get('/api/projects/:id/deployments', (req, res) => {
    const project = deps.store.get(String(req.params.id));
    if (!project) return notFound(res, req.params.id);
    res.json({ deployments: deps.store.deploymentsOf(project.id).map((d) => deploymentView(req, d)) });
  });

  // ------------------------------------------------------------------------------------------ runs (the console's Run panel)

  router.get('/api/projects/:id/runs', (req, res) => {
    const project = deps.store.get(String(req.params.id));
    if (!project) return notFound(res, req.params.id);
    res.json({ runs: deps.store.runsOf(project.id).map((d) => deploymentView(req, d)) });
  });

  /** Run the branch's HEAD with the caller's entry/inputs/env and their own key. Owner or organization member. */
  router.post('/api/projects/:id/runs', (req, res) => {
    const ctx = operable(req, res);
    if (!ctx) return;
    const parsed = runInput.safeParse(req.body ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return refuse(res, 400, 'invalid_request', `${issue?.path.join('.') || 'body'}: ${issue?.message ?? 'invalid'}`);
    }
    if (parsed.data.target !== 'commit' && ctx.project.kind && ctx.project.kind !== 'script') return refuse(res, 409, 'not_a_script', `${ctx.project.org}/${ctx.project.repoName} is a ${ctx.project.kind} project — it is deployed by a push, not run`);
    if (parsed.data.target !== 'commit' && parsed.data.sha) return refuse(res, 400, 'invalid_request', 'sha is only used for a commit run');
    if (parsed.data.entry && parsed.data.entry.split('/').some((part) => part === '' || part === '.' || part === '..')) return refuse(res, 400, 'invalid_request', 'entry is a repository-relative file');
    if (parsed.data.target === 'commit' && !parsed.data.sha) return refuse(res, 400, 'invalid_request', 'a commit run requires sha');
    if (parsed.data.target === 'deployed' && !ctx.project.activeCommit) return refuse(res, 409, 'no_deployment', 'there is no successful deployment to run');
    const d = deps.store.createRun(ctx.project, parsed.data, actorOf(ctx.who));
    deps.log?.('info', `project ${ctx.project.id}: run ${d.id} (${d.entry ?? 'manifest entry'}) by ${ctx.who.subject}`);
    res.status(202).json({ runId: d.id, ...queued(d) });
  });

  /** The same commit as a new deployment (Redeploy; a service's "roll back to this one"). Owner or organization member. */
  router.post('/api/deployments/:id/redeploy', (req, res) => {
    const of = deps.store.deployment(String(req.params.id));
    const project = of ? deps.store.get(of.projectId) : null;
    if (!of || !project) return refuse(res, 404, 'not_found', `no deployment "${req.params.id}" on this node`);
    const who = signedIn(req, res);
    if (!who) return;
    if (!mayOperate(who, project)) return refuse(res, 403, 'not_member', `only the owner or a member of "${project.org}" may redeploy this project`);
    if (!of.sha) return refuse(res, 409, 'not_yet_cloned', 'this run has not reached a commit yet');
    const d = deps.store.redeploy(project, of, actorOf(who));
    deps.log?.('info', `project ${project.id}: redeploy of ${of.sha.slice(0, 12)} → ${d.id} by ${who.subject}`);
    res.status(202).json(queued(d));
  });

  /** A deployment or run of a project this node has — readable by anyone, as the project is (header comment). */
  const readable = (req: Request, res: Response): Deployment | null => {
    const d = deps.store.deployment(String(req.params.id));
    const project = d ? deps.store.get(d.projectId) : null;
    if (!d || !project) { refuse(res, 404, 'not_found', `no deployment "${req.params.id}" on this node`); return null; }
    return d;
  };

  router.get('/api/deployments/:id', (req, res) => {
    const d = readable(req, res);
    if (d) res.json(deploymentView(req, d));
  });

  // ------------------------------------------------------------------------------------------ services

  /**
   * `/svc/<projectId>/…` → the project's running container, on the internal network. Streams both ways; drops
   * hop-by-hop headers. The container sees the original path under `/`.
   */
  const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate', 'host', 'content-length']);
  // fetch inflates the body before handing it over, so the upstream's encoding header would lie to the browser.
  const DROP_RESPONSE = new Set([...HOP, 'content-encoding']);
  router.all(['/svc/:id', '/svc/:id/{*rest}'], async (req, res) => {
    const c = deps.containers?.current(String(req.params.id));
    if (!c) return refuse(res, 404, 'not_found', `no running service for project "${req.params.id}"`);
    const rest = Array.isArray(req.params.rest) ? req.params.rest.join('/') : (req.params.rest ?? '');
    const q = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k.toLowerCase()) && v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    headers.set('x-forwarded-host', req.get('host') ?? '');
    headers.set('x-forwarded-proto', req.protocol);
    headers.set('x-forwarded-prefix', `/svc/${c.projectId}`);
    headers.set('accept-encoding', 'identity');
    const hasBody = !['GET', 'HEAD'].includes(req.method);
    try {
      const upstream = await fetch(`${c.upstream}/${rest}${q}`, {
        method: req.method, headers, redirect: 'manual', signal: AbortSignal.timeout(120_000),
        ...(hasBody ? { body: Readable.toWeb(req) as unknown as ReadableStream, duplex: 'half' } : {}),
      } as RequestInit);
      res.status(upstream.status);
      upstream.headers.forEach((v, k) => { if (!DROP_RESPONSE.has(k)) res.setHeader(k, v); });
      if (!upstream.body) { res.end(); return; }
      Readable.fromWeb(upstream.body as unknown as import('node:stream/web').ReadableStream).pipe(res);
    } catch (e) {
      if (!res.headersSent) refuse(res, 502, 'service_unreachable', `the service did not answer: ${(e as Error).message}`);
      else res.end();
    }
  });

  router.get('/api/deployments/:id/output', (req, res) => {
    const d = readable(req, res);
    if (!d) return;
    res.type('text/plain; charset=utf-8').send(deps.logs.read(d.id, 'out') ?? '');
  });

  /** Text once the deployment is over; SSE (`log` events, then `done`) while it is queued or building. */
  router.get('/api/deployments/:id/log', (req, res) => {
    const d = readable(req, res);
    if (!d) return;
    const over = (x: Deployment | null) => !!x && (x.status === 'ready' || x.status === 'error');
    if (over(d) || req.header('accept')?.includes('text/plain')) {
      res.type('text/plain; charset=utf-8').send(deps.logs.read(d.id) ?? '');
      return;
    }
    res.status(200).set({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.flushHeaders();
    const send = (event: string, data: unknown) => { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    const sofar = deps.logs.read(d.id);
    if (sofar) send('log', sofar);
    const onLine = (line: string) => send('log', line);
    const onDone = (id: string) => {
      if (id !== d.id) return;
      const final = deps.store.deployment(d.id);
      send('done', final ? deploymentView(req, final) : { id: d.id });
      cleanup();
      res.end();
    };
    const cleanup = () => { deps.logs.off(`log:${d.id}`, onLine); deps.worker.off('done', onDone); };
    deps.logs.on(`log:${d.id}`, onLine);
    deps.worker.on('done', onDone);
    // It may have finished between the status read and the subscription.
    if (over(deps.store.deployment(d.id))) onDone(d.id);
    req.on('close', cleanup);
  });

  return router;
}
