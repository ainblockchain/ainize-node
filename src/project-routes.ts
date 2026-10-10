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
import type { AgentCaller } from './shared-agents.js';
import {
  hookBody, hookSignatureOk, parseRepoUrl, projectInput, type Deployment, type DeploymentLogs, type Project, ProjectLimitError, ProjectRepoTakenError,
  type ProjectStore, type ProjectWorker, PROJECT_DEFAULT_CORS_ORIGINS, PROJECT_SECRET_DEPLOY_TOKEN, PROJECT_SECRET_WEBHOOK,
} from './projects.js';
import { randomBytes } from 'node:crypto';

export interface ProjectRoutesDeps {
  store: ProjectStore;
  /** Webhook secrets and deploy tokens, sealed at rest; keyed by project id (hosted-agent-secrets.ts). */
  secrets: Pick<HostedAgentSecretStore, 'set' | 'reveal' | 'dropAgent'>;
  logs: DeploymentLogs;
  worker: ProjectWorker;
  caller: (req: Request) => AgentCaller | null;
  publicBase: (req: Request) => string;
  /** Browser origins allowed to read status and (for aindrive's server) post the hook. */
  corsOrigins?: string[];
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

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
    owner: p.owner, url: `${base(req)}/${encodeURIComponent(p.org)}/${encodeURIComponent(p.repoName)}`,
    hookUrl: `${base(req)}/api/projects/${p.id}/hook`, lastDeploymentId: p.lastDeploymentId, createdAt: p.createdAt, updatedAt: p.updatedAt,
  });
  /** What aindrive's UI may show about a repo it serves — status, no owner, no hook address. */
  const publicView = (req: Request, p: Project) => {
    const last = p.lastDeploymentId ? deps.store.deployment(p.lastDeploymentId) : null;
    return {
      id: p.id, org: p.org, repoName: p.repoName, repo: p.repo, branch: p.branch, kind: p.kind, status: p.status,
      url: `${base(req)}/${encodeURIComponent(p.org)}/${encodeURIComponent(p.repoName)}`,
      lastDeployment: last ? deploymentView(req, last) : null,
    };
  };
  const deploymentView = (req: Request, d: Deployment) => ({
    id: d.id, projectId: d.projectId, sha: d.sha, ref: d.ref, status: d.status, pusher: d.pusher, createdAt: d.createdAt,
    startedAt: d.startedAt, finishedAt: d.finishedAt, ms: d.ms, ...(d.exitCode === null ? {} : { exitCode: d.exitCode }), ...(d.error ? { error: d.error } : {}),
    logUrl: `${base(req)}/api/deployments/${d.id}/log`,
    ...(d.status === 'ready' ? { outputUrl: `${base(req)}/api/deployments/${d.id}/output` } : {}),
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
    if (input.kind === 'agent') {
      // TODO(projects-agent): build the repo as a hosted agent (see projects.ts ProjectWorker.build). agent-mirror.ts
      // reads a repo folder into a HostedAgentSpec, so this is the next step once a per-project agent id and host
      // wiring are decided; refused clearly until then rather than accepted and left idle.
      return refuse(res, 501, 'not_implemented', 'kind "agent" is not implemented on this node yet; a script project runs its entry on every push');
    }
    if (!input.entry) return refuse(res, 400, 'invalid_request', 'entry: a script project names the file to run (e.g. "main.py")');
    let project: Project;
    try {
      project = deps.store.create({ repo, branch: input.branch, kind: input.kind, entry: input.entry, name: input.name }, who.subject);
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
