/**
 * Attaching an agent to a GitHub repository, and following it.
 *
 * `PUT` names the repository, branch and folder; the node fetches it immediately and the answer says what it
 * found — a mirror that is "configured" but has never successfully fetched is a mirror nobody can trust, so
 * the first fetch is part of setting it up rather than a thing that happens later and silently.
 *
 * `POST …/sync` is the same fetch on demand, which is what a webhook calls and what a person presses when they
 * have just merged on GitHub and do not want to wait for the timer.
 */
import express, { Router, type Request, type Response } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AgentGit, AgentGitError } from './agent-git.js';
import { fetchMirror, mirrorUrlOk, type AgentMirror, type AgentMirrorStore } from './agent-mirror.js';
import type { HostedAgentSpecInput } from './hosted-agent-types.js';

export interface AgentMirrorRoutesDeps {
  git: AgentGit;
  mirrors: AgentMirrorStore;
  canRead: (req: Request, id: string) => boolean;
  /** Attaching an agent to a repository decides what it runs, so it is the same people who may push. */
  canManage: (req: Request, id: string) => boolean;
  principal: (req: Request) => string | null;
  apply: (id: string, input: HostedAgentSpecInput, commit: string, by: string | null) => Promise<void>;
  /** Point the agent's own `main` at what was fetched, so a clone of the ainize copy shows what is running. */
  land: (id: string, commit: string) => Promise<void>;
  log: (level: 'info' | 'warn' | 'error', message: string) => void;
  /**
   * The shared secret a webhook is signed with, if the operator set one. Absent: the webhook route refuses
   * everything, rather than following whatever a stranger says changed.
   */
  webhookSecret?: () => string | null;
}

const refuse = (res: Response, status: number, code: string, message: string) => {
  res.status(status).json({ error: { code, message } });
};

const body = z.object({
  url: z.string().trim().min(1),
  branch: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/).default('main'),
  /** The folder the agent lives in: `news-agent`, or empty for a repository that IS the agent. */
  path: z.string().trim().max(200).regex(/^[A-Za-z0-9_.\-/]*$/, 'a path is plain segments').default(''),
});

export function agentMirrorRoutes(deps: AgentMirrorRoutesDeps): Router {
  const router = Router();
  const json = express.json({ limit: '16kb' });

  const open = (req: Request, res: Response, write: boolean): string | null => {
    const id = String(req.params.id ?? '');
    if (!deps.canRead(req, id)) { refuse(res, 404, 'not_found', `no agent "${id}" on this node`); return null; }
    if (write && !deps.canManage(req, id)) { refuse(res, 403, 'not_allowed', 'only the people who may change this agent can attach it to a repository'); return null; }
    return id;
  };

  /**
   * Fetch, and make what was fetched the agent — or record why it could not be.
   *
   * A fetch that brings a tree which is not an agent is NOT applied and NOT silent: the mirror keeps its error
   * and the page says so. A mirror that quietly stopped following is worse than no mirror, because the person
   * reading the page believes the agent is tracking their repository.
   */
  const sync = async (req: Request, mirror: AgentMirror): Promise<AgentMirror> => {
    try {
      const result = await fetchMirror(deps.git, mirror);
      if (result.error) {
        deps.log('warn', `agent ${mirror.agent}: ${mirror.url} fetched, but ${result.error.split('\n')[0]}`);
        return deps.mirrors.patch(mirror.agent, { lastFetchAt: Date.now(), error: result.error })!;
      }
      if (!result.changed) return deps.mirrors.patch(mirror.agent, { lastFetchAt: Date.now(), error: null })!;
      await deps.apply(mirror.agent, result.input!, result.commit, deps.principal(req));
      await deps.land(mirror.agent, result.commit);
      deps.log('info', `agent ${mirror.agent}: followed ${mirror.url} to ${result.commit.slice(0, 7)}, live now`);
      return deps.mirrors.patch(mirror.agent, { lastFetchAt: Date.now(), lastCommit: result.commit, error: null })!;
    } catch (e) {
      const why = e instanceof AgentGitError ? e.message : (e as Error).message;
      deps.log('warn', `agent ${mirror.agent}: ${why}`);
      return deps.mirrors.patch(mirror.agent, { lastFetchAt: Date.now(), error: why })!;
    }
  };

  router.get('/api/hosted-agents/:id/mirror', (req, res) => {
    const id = open(req, res, false); if (!id) return;
    res.json({ mirror: deps.mirrors.get(id) });
  });

  router.put('/api/hosted-agents/:id/mirror', json, async (req, res) => {
    const id = open(req, res, true); if (!id) return;
    const parsed = body.safeParse(req.body ?? {});
    if (!parsed.success) { refuse(res, 400, 'invalid_request', parsed.error.issues[0]?.message ?? 'invalid request'); return; }
    if (!mirrorUrlOk(parsed.data.url)) {
      refuse(res, 400, 'invalid_request', 'a mirror is an https URL with no credentials in it (http only on loopback) — ainize fetches it as a public repository');
      return;
    }
    const mirror = deps.mirrors.set({ agent: id, ...parsed.data });
    // Fetched now, not later: a mirror that has never fetched is one nobody can tell is broken.
    res.json({ mirror: await sync(req, mirror) });
  });

  router.post('/api/hosted-agents/:id/mirror/sync', json, async (req, res) => {
    const id = open(req, res, true); if (!id) return;
    const mirror = deps.mirrors.get(id);
    if (!mirror) { refuse(res, 404, 'not_mirrored', `agent "${id}" does not follow a repository`); return; }
    res.json({ mirror: await sync(req, mirror) });
  });

  /**
   * GitHub telling us it changed, instead of us asking every few minutes.
   *
   * THE GAP THIS CLOSES. A mirrored agent only moved when somebody pressed Sync or the timer came round, so
   * "push and it is live" was true for an agent hosted here and up to a few minutes false for one hosted on
   * GitHub — which is the case this whole mirror exists for.
   *
   * SIGNED, OR NOT ACCEPTED. The body says which repository changed, and acting on it fetches and deploys. An
   * unauthenticated version of this route would let anyone on the internet make a node fetch on command, and
   * — far worse — would let them do it at the moment of their choosing, which is how a mirror gets pointed at
   * a branch state that existed only briefly. GitHub signs with HMAC-SHA256 over the raw body; without a
   * configured secret the route refuses, because the alternative is trusting the sender.
   */
  router.post('/api/agent-mirrors/webhook',
    // The RAW body: a signature is over bytes, and re-serialising parsed JSON does not reproduce them.
    express.raw({ type: '*/*', limit: '1mb' }),
    async (req, res) => {
      const secret = deps.webhookSecret?.() ?? null;
      if (!secret) { refuse(res, 404, 'not_configured', 'this node accepts no webhooks'); return; }
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
      const sent = String(req.header('x-hub-signature-256') ?? '');
      const want = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
      const a = Buffer.from(want);
      const b = Buffer.from(sent.padEnd(a.length, '\0').slice(0, a.length));
      if (sent.length !== want.length || !timingSafeEqual(a, b)) {
        refuse(res, 401, 'bad_signature', 'that is not signed with this node\'s webhook secret');
        return;
      }

      let payload: { repository?: { html_url?: string; clone_url?: string }; ref?: string };
      try { payload = JSON.parse(raw.toString('utf8')) as typeof payload; }
      catch { refuse(res, 400, 'invalid_request', 'the webhook body is not JSON'); return; }

      // Which of this node's mirrors is about this repository, and about the branch that moved. A repository
      // can be the upstream of several agents (one per folder), so every match is synced.
      const urls = [payload.repository?.html_url, payload.repository?.clone_url].filter(Boolean).map((u) => normaliseRepo(String(u)));
      const branch = typeof payload.ref === 'string' && payload.ref.startsWith('refs/heads/') ? payload.ref.slice('refs/heads/'.length) : null;
      const hit = deps.mirrors.list().filter((m) => urls.includes(normaliseRepo(m.url)) && (!branch || m.branch === branch));
      if (!hit.length) { res.json({ synced: [] }); return; }

      const synced: string[] = [];
      for (const mirror of hit) { await sync(req, mirror); synced.push(mirror.agent); }
      res.json({ synced });
    });

  router.delete('/api/hosted-agents/:id/mirror', (req, res) => {
    const id = open(req, res, true); if (!id) return;
    // What it is running stays running: detaching stops following, it does not revert the agent.
    res.json({ detached: deps.mirrors.remove(id) });
  });

  return router;
}

/** `https://github.com/a/b`, `…/b.git` and `…/b/` are one repository; a webhook names it whichever way it likes. */
function normaliseRepo(url: string): string {
  return url.trim().toLowerCase().replace(/\.git$/, '').replace(/\/+$/, '');
}
