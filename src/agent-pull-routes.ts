import { serializedWrites, type RepositorySerialize } from './agent-repository-queue.js';
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
import { randomBytes } from 'node:crypto';
import type { AgentForkStore } from './agent-forks.js';
import { AgentGit, AgentGitError, AGENT_GIT_DEFAULT_BRANCH } from './agent-git.js';
import type { AgentPullStore } from './agent-pulls.js';
import type { HostedAgentSpecInput } from './hosted-agent-types.js';

export interface AgentPullRoutesDeps {
  serialize?: RepositorySerialize;
  git: AgentGit;
  forks?: AgentForkStore;
  initializeFork?: (id: string) => void;
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
  headAgent: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/).optional(),
  base: branchName.default(AGENT_GIT_DEFAULT_BRANCH),
});

export function agentPullRoutes(deps: AgentPullRoutesDeps): Router {
  const router = Router();
  const writes = serializedWrites(router, deps.serialize);
  const json = express.json({ limit: '64kb' });

  const open = (req: Request, res: Response): string | null => {
    const id = String(req.params.id ?? '');
    if (!deps.canRead(req, id) || !deps.git.exists(id)) { refuse(res, 404, 'not_found', `no agent "${id}" on this node`); return null; }
    return id;
  };

  writes.post('/api/hosted-agents/:id/forks', json, async (req, res) => {
    const parent = open(req, res); if (!parent) return;
    const owner = deps.principal(req);
    if (!owner) return refuse(res, 401, 'not_signed_in', 'sign in to fork a repository');
    if (!deps.forks) return refuse(res, 503, 'not_configured', 'repository forks are not enabled');
    const input = z.object({ ref: branchName.default(AGENT_GIT_DEFAULT_BRANCH) }).safeParse(req.body ?? {});
    if (!input.success) return refuse(res, 400, 'invalid_request', 'invalid fork ref');
    const id = `fork-${randomBytes(10).toString('hex')}`;
    let registered = false;
    try {
      if (deps.git.exists(id)) throw new Error('repository id already exists');
      const commit = await deps.git.resolve(parent, input.data.ref);
      deps.forks.add({ id, parent, owner, baseCommit: commit, createdAt: Date.now() });
      registered = true;
      await deps.git.fork(parent, id, commit);
      deps.initializeFork?.(id);
      res.status(201).json({ fork: deps.forks.get(id), clonePath: `/git/${id}.git` });
    } catch (error) {
      if (registered) {
        deps.forks.remove(id);
        await deps.git.deleteRepo(id);
      }
      refuse(res, 400, 'fork_failed', (error as Error).message);
    }
  });
  router.get('/api/agent-forks', (req, res) => {
    const owner = deps.principal(req);
    if (!owner) return refuse(res, 401, 'not_signed_in', 'sign in to read your forks');
    res.json({ forks: deps.forks?.list(owner) ?? [] });
  });
  writes.delete('/api/agent-forks/:id', async (req, res) => {
    const fork = deps.forks?.get(String(req.params.id));
    if (!fork || fork.owner !== deps.principal(req)?.toLowerCase()) return refuse(res, 404, 'not_found', 'no repository fork');
    await deps.git.deleteRepo(fork.id);
    deps.forks!.remove(fork.id);
    res.json({ ok: true });
  });

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

  writes.post('/api/hosted-agents/:id/pulls', json, async (req, res) => {
    const id = open(req, res); if (!id) return;
    const source = deps.readOnlySource?.(id);
    if (source) return refuse(res, 409, 'read_only_source', `propose changes at ${source}`);
    const who = deps.principal(req);
    if (!who) { refuse(res, 401, 'not_signed_in', 'sign in to propose a change'); return; }
    const parsed = openPull.safeParse(req.body ?? {});
    if (!parsed.success) { refuse(res, 400, 'invalid_request', parsed.error.issues[0]?.message ?? 'invalid request'); return; }
    const { title, body, head, base, headAgent } = parsed.data;
    const fork = headAgent ? deps.forks?.get(headAgent) : null;
    if (headAgent && (!fork || fork.parent !== id || fork.owner !== who.toLowerCase())) return refuse(res, 403, 'not_allowed', 'only your own fork of this repository can propose a change');
    if (!headAgent && head === base) { refuse(res, 400, 'invalid_request', 'a branch cannot be proposed for itself'); return; }
    let headCommit: string | undefined;
    try {
      headCommit = await deps.git.resolve(headAgent ?? id, head);
      await deps.git.resolve(id, base);
    } catch (e) {
      // Naming a branch that does not exist is the commonest mistake here (a push that was never made).
      refuse(res, 400, 'no_such_branch', (e as Error).message);
      return;
    }
    if (headAgent) {
      try { await deps.git.importProposal(id, headAgent, headCommit!, randomBytes(12).toString('hex')); }
      catch (error) { return refuse(res, 400, 'git_error', (error as Error).message); }
    }
    res.status(201).json({ pull: deps.pulls.open({ agent: id, title, body, head, base, author: who, ...(headAgent ? { headAgent, headCommit } : {}) }) });
  });

  const commentBody = z.object({ body: z.string().trim().min(1).max(8000) });
  router.get('/api/hosted-agents/:id/pulls/:number/comments', (req, res) => {
    const id = open(req, res); if (!id) return;
    const pull = deps.pulls.get(id, Number(req.params.number));
    if (!pull) return refuse(res, 404, 'not_found', 'no pull request');
    res.json({ comments: pull.comments ?? [] });
  });
  writes.post('/api/hosted-agents/:id/pulls/:number/comments', json, async (req, res) => {
    const id = open(req, res); if (!id) return;
    const author = deps.principal(req);
    if (!author) return refuse(res, 401, 'not_signed_in', 'sign in to review a proposal');
    const pull = deps.pulls.get(id, Number(req.params.number));
    if (!pull) return refuse(res, 404, 'not_found', 'no pull request');
    const parsed = commentBody.extend({ commit: z.string().regex(/^[a-f0-9]{40,64}$/).optional(), path: z.string().max(512).optional(), line: z.number().int().positive().optional() }).safeParse(req.body);
    if (!parsed.success) return refuse(res, 400, 'invalid_request', 'a comment needs text and an optional commit, path and line');
    const { body, commit, path, line } = parsed.data;
    if ((path === undefined) !== (line === undefined) || (path !== undefined && (!commit || path.split('/').some((part) => !part || part === '.' || part === '..')))) return refuse(res, 400, 'invalid_request', 'an inline comment needs a commit, repository path and line');
    if (commit) {
      try {
        const resolved = await deps.git.resolve(id, commit);
        if (resolved !== commit) throw new Error('invalid commit');
        if (path !== undefined) {
          const content = await deps.git.show(id, commit, path);
          if (content === null || line! > content.split('\n').length) throw new Error('line is outside the file');
        }
      } catch (error) { return refuse(res, 400, 'invalid_anchor', (error as Error).message); }
    }
    res.status(201).json({ comment: deps.pulls.addComment(id, pull.number, { author, body, ...(commit ? { commit } : {}), ...(path ? { path, line } : {}) }) });
  });
  writes.patch('/api/hosted-agents/:id/pulls/:number/comments/:comment', json, (req, res) => {
    const id = open(req, res); if (!id) return;
    const pull = deps.pulls.get(id, Number(req.params.number));
    const comment = pull?.comments?.find((row) => row.id === Number(req.params.comment));
    if (!pull || !comment || comment.deletedAt) return refuse(res, 404, 'not_found', 'no review comment');
    const author = deps.principal(req);
    if (!author || author !== comment.author) return refuse(res, 403, 'not_allowed', 'only the author can edit a review comment');
    const parsed = commentBody.safeParse(req.body);
    if (!parsed.success) return refuse(res, 400, 'invalid_request', 'a comment needs text');
    res.json({ comment: deps.pulls.updateComment(id, pull.number, comment.id, { body: parsed.data.body }) });
  });
  writes.delete('/api/hosted-agents/:id/pulls/:number/comments/:comment', (req, res) => {
    const id = open(req, res); if (!id) return;
    const pull = deps.pulls.get(id, Number(req.params.number));
    const comment = pull?.comments?.find((row) => row.id === Number(req.params.comment));
    if (!pull || !comment || comment.deletedAt) return refuse(res, 404, 'not_found', 'no review comment');
    const author = deps.principal(req);
    if (!author || (author !== comment.author && !deps.canMerge(req, id))) return refuse(res, 403, 'not_allowed', 'only the author or an agent maintainer can delete a review comment');
    res.json({ comment: deps.pulls.updateComment(id, pull.number, comment.id, { body: '', deletedAt: Date.now() }) });
  });

  writes.post('/api/hosted-agents/:id/pulls/:number/merge', json, async (req, res) => {
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
      const merged = await deps.git.mergeTree(id, pull.base, pull.headCommit ?? pull.head);
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

  writes.post('/api/hosted-agents/:id/pulls/:number/close', json, (req, res) => {
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
