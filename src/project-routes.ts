/**
 * `/api/projects` and `/api/deployments` — projects bound to aindrive git repositories (projects.ts).
 *
 * Auth is the hosted-agent model: whoever is signed in (AIN SSO, wallet session, API key) owns what they create;
 * a project is read and removed by its owner only, and a project the caller does not own answers 404, never
 * 403. Two doors are open wider: the push hook (`POST /:id/hook`), which aindrive calls with an HMAC rather than
 * a session, and `GET /by-repo`, which aindrive's UI reads to show a repo's deploy status — both answer CORS for
 * `https://aindrive.ainetwork.ai`. Errors are `{ error: { code, message } }` like the agent routes.
 */
import { Router, type Request, type Response } from 'express';
import type { HostedAgentSecretStore } from './hosted-agent-secrets.js';
import type { ProjectContainers } from './project-containers.js';
import type { AgentCaller } from './shared-agents.js';
import {
  hookBody, hookSignatureOk, parseRepoUrl, projectInput, type Deployment, type DeploymentLogs, type Project, ProjectLimitError, ProjectRepoTakenError,
  type ProjectStore, type ProjectWorker, PROJECT_DEFAULT_CORS_ORIGINS, PROJECT_SECRET_DEPLOY_TOKEN, PROJECT_SECRET_WEBHOOK,
} from './projects.js';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { SsoError, type ServicePrincipal } from './sso.js';

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
}

/** `POST /api/projects/auto` body: the pushed repo and what aindrive knows about it. */
export const autoBindInput = z.object({
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

  /** The project, if the caller owns it; a project they do not own is 404. */
  const owned = (req: Request, res: Response): Project | null => {
    const who = signedIn(req, res);
    if (!who) return null;
    const project = deps.store.get(String(req.params.id));
    if (!project || project.owner !== who.subject) { notFound(res, req.params.id); return null; }
    return project;
  };

  const projectView = (req: Request, p: Project) => ({
    id: p.id, org: p.org, repoName: p.repoName, repo: p.repo, branch: p.branch, kind: p.kind, entry: p.entry, name: p.name, status: p.status,
    owner: p.owner, url: `${base(req)}/${encodeURIComponent(p.org)}/${encodeURIComponent(p.repoName)}`, pageUrl: `${base(req)}/projects/${p.id}`,
    hookUrl: `${base(req)}/api/projects/${p.id}/hook`, lastDeploymentId: p.lastDeploymentId, createdAt: p.createdAt, updatedAt: p.updatedAt,
  });
  /** What aindrive's UI may show about a repo it serves — status, no owner, no hook address. */
  const publicView = (req: Request, p: Project) => {
    const last = p.lastDeploymentId ? deps.store.deployment(p.lastDeploymentId) : null;
    return {
      id: p.id, org: p.org, repoName: p.repoName, repo: p.repo, branch: p.branch, kind: p.kind, status: p.status,
      url: `${base(req)}/${encodeURIComponent(p.org)}/${encodeURIComponent(p.repoName)}`, pageUrl: `${base(req)}/projects/${p.id}`,
      lastDeployment: last ? deploymentView(req, last) : null,
    };
  };
  const deploymentView = (req: Request, d: Deployment) => ({
    id: d.id, projectId: d.projectId, sha: d.sha, ref: d.ref, status: d.status, pusher: d.pusher, createdAt: d.createdAt,
    startedAt: d.startedAt, finishedAt: d.finishedAt, ms: d.ms, ...(d.exitCode === null ? {} : { exitCode: d.exitCode }), ...(d.error ? { error: d.error } : {}),
    ...(d.kind ? { kind: d.kind } : {}),
    logUrl: `${base(req)}/api/deployments/${d.id}/log`,
    ...(d.status === 'ready' && d.outputUrl ? { outputUrl: d.outputUrl } : {}),
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
      project = deps.store.create({ repo, branch: input.branch, kind: input.kind ?? null, entry: input.entry ?? null, name: input.name }, who.subject);
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
    res.status(201).json({ ...projectView(req, project), webhookSecret, hasDeployToken: !!input.deployToken });
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
      return res.status(200).json({ id: existing.id, pageUrl: `${base(req)}/projects/${existing.id}`, created: false });
    }
    const subject = input.pusher?.subject ?? null;
    const owner = subject ? deps.auto.principalForSubject(subject) : `org:${orgIds[0]}`;
    const kind = input.manifest?.kind ?? null;
    let project: Project;
    try {
      project = deps.store.create({ repo, branch, kind: kind && (['nextjs', 'script', 'service', 'agent'] as const).includes(kind as 'script') ? (kind as Project['kind']) : null, entry: null, name: input.manifest?.name ?? undefined }, owner);
    } catch (e) {
      if (e instanceof ProjectRepoTakenError) return refuse(res, 409, 'repo_taken', e.message);
      if (e instanceof ProjectLimitError) return refuse(res, 429, 'limit', e.message);
      throw e;
    }
    const webhookSecret = `whsec_${randomBytes(24).toString('hex')}`;
    deps.secrets.set(project.id, PROJECT_SECRET_WEBHOOK, webhookSecret);
    deps.log?.('info', `project ${project.id}: ${project.org}/${project.repoName} (${project.branch}) auto-bound by ${who.clientId} for ${owner}`);
    res.status(201).json({ id: project.id, pageUrl: `${base(req)}/projects/${project.id}`, webhookSecret, created: true });
  });

  router.get('/api/projects', (req, res) => {
    const who = signedIn(req, res);
    if (!who) return;
    res.json({ projects: deps.store.listByOwner(who.subject).map((p) => projectView(req, p)) });
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

  router.get('/api/projects/:id', (req, res) => {
    const project = owned(req, res);
    if (project) res.json(projectView(req, project));
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
    const d = deps.store.createDeployment(project, body);
    deps.worker.enqueue(d.id);
    deps.log?.('info', `project ${project.id}: push ${body.after.slice(0, 12)} by ${body.pusher?.subject ?? '?'} → deployment ${d.id}`);
    res.status(202).json({ deploymentId: d.id, status: d.status });
  });

  // ------------------------------------------------------------------------------------------ deployments

  router.get('/api/projects/:id/deployments', (req, res) => {
    const project = owned(req, res);
    if (project) res.json({ deployments: deps.store.deploymentsOf(project.id).map((d) => deploymentView(req, d)) });
  });

  /** The deployment, if the caller owns its project — or, for anyone, the newest of a project aindrive shows. */
  const readable = (req: Request, res: Response): Deployment | null => {
    const d = deps.store.deployment(String(req.params.id));
    const project = d ? deps.store.get(d.projectId) : null;
    const who = deps.caller(req);
    if (!d || !project || !who || project.owner !== who.subject) { refuse(res, 404, 'not_found', `no deployment "${req.params.id}" on this node`); return null; }
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
