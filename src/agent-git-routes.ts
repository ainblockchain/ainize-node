/**
 * The history, as a page reads it: commits, branches, one file, and a diff.
 *
 * These are under `/api` and the git transport is not, because they answer different questions for different
 * readers. `/git/<id>.git` is for a git client, which appends its own paths to whatever URL a person pasted.
 * This is for a browser that wants to show who changed the prompt last Tuesday without cloning anything.
 *
 * Everything here reads; nothing writes. A change arrives as a push (agent-git-http.ts) or as a `PUT`
 * (hosted-agent-routes.ts), and both end in the same commit on the same branch.
 */
import { Router, type Request, type Response } from 'express';
import { AgentGit, AgentGitError, AGENT_GIT_DEFAULT_BRANCH } from './agent-git.js';

export interface AgentGitRoutesDeps {
  git: AgentGit;
  /** May this caller see the agent at all? The same answer a listing gives — history is not more public than the agent. */
  canRead: (req: Request, id: string) => boolean;
  /** Where to tell a person to clone from. */
  cloneBase: (req: Request) => string;
}

const refuse = (res: Response, status: number, code: string, message: string) => {
  res.status(status).json({ error: { code, message } });
};

/**
 * A ref a caller supplied, on its way to being an argument to `git`.
 *
 * `~` and `^` are allowed because `HEAD~1` is how a page asks for "the previous version", and refusing it
 * would make the diff endpoint unusable for the one question it exists to answer. What is refused is what
 * could become something other than a ref: a leading `-` (every git option starts with one — `--upload-pack=`
 * is a remote code execution in a ref-shaped string), and `..`, which is a range and a parent directory.
 */
const REF = /^[A-Za-z0-9][A-Za-z0-9._/~^-]{0,100}$/;
const refOk = (ref: string) => REF.test(ref) && !ref.includes('..') && !ref.startsWith('-');

export function agentGitRoutes(deps: AgentGitRoutesDeps): Router {
  const router = Router();

  /** The agent, if this caller may see it and it has a repository. */
  const open = (req: Request, res: Response): string | null => {
    const id = String(req.params.id ?? '');
    if (!deps.canRead(req, id)) { refuse(res, 404, 'not_found', `no agent "${id}" on this node`); return null; }
    if (!deps.git.exists(id)) { refuse(res, 404, 'no_repository', `agent "${id}" has no repository on this node`); return null; }
    return id;
  };

  const ref = (req: Request, res: Response, key = 'ref'): string | null => {
    const value = String(req.query[key] ?? AGENT_GIT_DEFAULT_BRANCH);
    if (!refOk(value)) { refuse(res, 400, 'invalid_ref', `"${value}" is not a branch name or a commit`); return null; }
    return value;
  };

  const fail = (res: Response, e: unknown) => {
    const message = e instanceof AgentGitError ? e.message : (e as Error).message;
    refuse(res, 400, 'git_error', message);
  };

  router.get('/api/hosted-agents/:id/commits', async (req, res) => {
    const id = open(req, res); if (!id) return;
    const at = ref(req, res); if (!at) return;
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '50'), 10) || 50, 1), 200);
    try {
      res.json({
        commits: await deps.git.log(id, at, limit),
        clone_url: `${deps.cloneBase(req)}/git/${id}.git`,
      });
    } catch (e) { fail(res, e); }
  });

  router.get('/api/hosted-agents/:id/refs', async (req, res) => {
    const id = open(req, res); if (!id) return;
    try {
      const { branches, head } = await deps.git.refs(id);
      res.json({ branches, head, clone_url: `${deps.cloneBase(req)}/git/${id}.git` });
    } catch (e) { fail(res, e); }
  });

  /** One file at one ref, or the list of paths when `path` is absent — enough to render a tree view. */
  router.get('/api/hosted-agents/:id/tree', async (req, res) => {
    const id = open(req, res); if (!id) return;
    const at = ref(req, res); if (!at) return;
    const path = req.query.path === undefined ? null : String(req.query.path);
    try {
      if (path === null) { res.json({ ref: at, paths: await deps.git.lsFiles(id, at) }); return; }
      const body = await deps.git.show(id, at, path);
      if (body === null) { refuse(res, 404, 'not_found', `"${path}" is not in this agent at ${at}`); return; }
      res.json({ ref: at, path, content: body });
    } catch (e) { fail(res, e); }
  });

  /**
   * What a branch changes — the view a reviewer opens before merging.
   *
   * `base...head` (three dots) rather than two: the question a reviewer is asking is "what does this branch
   * add", not "how do these two trees differ", and the two answers diverge the moment `main` moves on.
   */
  router.get('/api/hosted-agents/:id/diff', async (req, res) => {
    const id = open(req, res); if (!id) return;
    const base = ref(req, res, 'base'); if (!base) return;
    const head = ref(req, res, 'head'); if (!head) return;
    try {
      res.json({ base, head, ...(await deps.git.diff(id, base, head)) });
    } catch (e) { fail(res, e); }
  });

  return router;
}
