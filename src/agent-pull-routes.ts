/**
 * Pull requests over HTTP: open one, read them, merge one.
 *
 * The merge is the only write that matters, and it is deliberately not a shortcut: it builds the merge commit,
 * validates the RESULT the way a push to the deployed branch is validated, and only then moves the ref and
 * applies the agent. Two trees that were each a valid agent can merge into one that is not — a skill removed on
 * one side and referenced on the other — and a path to production that skips the check is a path that will be
 * used to skip the check.
 */
import express, { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { AgentGit, AgentGitError, AGENT_GIT_DEFAULT_BRANCH } from './agent-git.js';
import type { AgentPullStore } from './agent-pulls.js';
import type { HostedAgentSpecInput } from './hosted-agent-types.js';

export interface AgentPullRoutesDeps {
  git: AgentGit;
  readOnlySource?: (id: string) => string | null;
  pulls: AgentPullStore;
  /** Who is asking, as an agent's `owner` spells a principal; null when nobody is signed in. */
  principal: (req: Request) => string | null;
  canRead: (req: Request, id: string) => boolean;
  /** Who may merge: the same people who may push. Opening a proposal is open to anyone who can read it. */
  canMerge: (req: Request, id: string) => boolean;
  /** Store the merged tree and re-apply the agent — the same call a push ends in. */
  apply: (id: string, input: HostedAgentSpecInput, commit: string, by: string | null) => Promise<void>;
}

const refuse = (res: Response, status: number, code: string, message: string) => {
  res.status(status).json({ error: { code, message } });
};

const branchName = z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, 'a branch name is letters, digits, dots, dashes and slashes');

const openPull = z.object({
  title: z.string().trim().min(1, 'a proposal needs a title').max(120),
  body: z.string().trim().max(4000).default(''),
  head: branchName,
  base: branchName.default(AGENT_GIT_DEFAULT_BRANCH),
});

export function agentPullRoutes(deps: AgentPullRoutesDeps): Router {
  const router = Router();
  const json = express.json({ limit: '64kb' });

  const open = (req: Request, res: Response): string | null => {
    const id = String(req.params.id ?? '');
    if (!deps.canRead(req, id) || !deps.git.exists(id)) { refuse(res, 404, 'not_found', `no agent "${id}" on this node`); return null; }
    return id;
  };

  router.get('/api/hosted-agents/:id/pulls', (req, res) => {
    const id = open(req, res); if (!id) return;
    const state = req.query.state === 'open' || req.query.state === 'merged' || req.query.state === 'closed' ? req.query.state : undefined;
    res.json({ pulls: deps.pulls.list(id, state) });
  });

  router.get('/api/hosted-agents/:id/pulls/:number', (req, res) => {
    const id = open(req, res); if (!id) return;
    const pull = deps.pulls.get(id, Number(req.params.number));
    if (!pull) { refuse(res, 404, 'not_found', `no pull request #${req.params.number} on ${id}`); return; }
    res.json({ pull });
  });

  router.post('/api/hosted-agents/:id/pulls', json, async (req, res) => {
    const id = open(req, res); if (!id) return;
    const who = deps.principal(req);
    if (!who) { refuse(res, 401, 'not_signed_in', 'sign in to propose a change'); return; }
    const parsed = openPull.safeParse(req.body ?? {});
    if (!parsed.success) { refuse(res, 400, 'invalid_request', parsed.error.issues[0]?.message ?? 'invalid request'); return; }
    const { title, body, head, base } = parsed.data;
    if (head === base) { refuse(res, 400, 'invalid_request', 'a branch cannot be proposed for itself'); return; }
    try {
      await deps.git.resolve(id, head);
      await deps.git.resolve(id, base);
    } catch (e) {
      // Naming a branch that does not exist is the commonest mistake here (a push that was never made).
      refuse(res, 400, 'no_such_branch', (e as Error).message);
      return;
    }
    res.status(201).json({ pull: deps.pulls.open({ agent: id, title, body, head, base, author: who }) });
  });

  router.post('/api/hosted-agents/:id/pulls/:number/merge', json, async (req, res) => {
    const id = open(req, res); if (!id) return;
    const source = deps.readOnlySource?.(id);
    if (source) return refuse(res, 409, 'read_only_source', `merge proposals at ${source}`);
    const who = deps.principal(req);
    if (!deps.canMerge(req, id) || !who) {
      refuse(res, 403, 'not_allowed', 'merging changes what this agent runs — only the people who may push to it can');
      return;
    }
    const pull = deps.pulls.get(id, Number(req.params.number));
    if (!pull) { refuse(res, 404, 'not_found', `no pull request #${req.params.number} on ${id}`); return; }
    if (pull.state !== 'open') { refuse(res, 409, 'not_open', `#${pull.number} is already ${pull.state}`); return; }

    try {
      const merged = await deps.git.mergeTree(id, pull.base, pull.head);
      if (!merged.ok) {
        refuse(res, 409, 'conflict', `this proposal conflicts with ${pull.base} in ${merged.conflicts.join(', ') || 'a file'} — rebase it and push again`);
        return;
      }
      if (merged.alreadyUpToDate) {
        deps.pulls.update(id, pull.number, { state: 'merged', mergedAt: Date.now(), mergedBy: who, mergeCommit: merged.commit });
        res.json({ pull: deps.pulls.get(id, pull.number), already: true });
        return;
      }

      /**
       * The merge result, held to the same bar as a push.
       *
       * Two trees that each passed can merge into one that does not, and a merge button that skipped this
       * would be a way to deploy exactly the trees a push refuses.
       */
      let read;
      try {
        read = await deps.git.readSpec(id, merged.commit);
      } catch (e) {
        const why = e instanceof AgentGitError ? e.message : (e as Error).message;
        refuse(res, 409, 'would_not_run', `merging #${pull.number} would produce an agent that does not run:\n${why}\nNothing was merged.`);
        return;
      }

      // Only now does the deployed branch move — and the apply is what makes every live address serve it.
      if (pull.base === AGENT_GIT_DEFAULT_BRANCH) {
        await deps.apply(id, read.input, merged.commit, who);
      }
      await deps.git.setRef(id, pull.base, merged.commit);
      deps.pulls.update(id, pull.number, { state: 'merged', mergedAt: Date.now(), mergedBy: who, mergeCommit: merged.commit });
      res.json({ pull: deps.pulls.get(id, pull.number), commit: merged.commit });
    } catch (e) {
      refuse(res, 400, 'git_error', (e as Error).message);
    }
  });

  router.post('/api/hosted-agents/:id/pulls/:number/close', json, (req, res) => {
    const id = open(req, res); if (!id) return;
    const who = deps.principal(req);
    const pull = deps.pulls.get(id, Number(req.params.number));
    if (!pull) { refuse(res, 404, 'not_found', `no pull request #${req.params.number} on ${id}`); return; }
    // Its author or whoever may merge: closing somebody else's proposal is a decision about the agent.
    if (!who || (pull.author !== who && !deps.canMerge(req, id))) { refuse(res, 403, 'not_allowed', 'only the author, or somebody who may merge, can close this'); return; }
    if (pull.state !== 'open') { refuse(res, 409, 'not_open', `#${pull.number} is already ${pull.state}`); return; }
    res.json({ pull: deps.pulls.update(id, pull.number, { state: 'closed' }) });
  });

  return router;
}
