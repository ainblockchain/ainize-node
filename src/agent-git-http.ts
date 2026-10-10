/**
 * `git clone` and `git push` against ainize, and the push that is the deploy.
 *
 * WHY `git http-backend`. The smart HTTP protocol is pack negotiation, capability advertisement and sideband
 * multiplexing, with a v2 that changes the shape of all three. `git` ships the server for it; writing a second
 * one by hand is how a host ends up subtly incompatible with some client's version. So this file is an
 * authenticated, scoped CGI host for the real thing, and nothing else.
 *
 * WHY A pre-receive HOOK AND NOT A CHECK AFTERWARDS. The promise is that a tree which would not deploy never
 * becomes a deploy. Validating after `git-receive-pack` has written the ref means the push already succeeded,
 * the person's terminal already said so, and the node is left either serving a broken agent or silently
 * rewinding a branch somebody now has in their reflog. A pre-receive hook is the one place where "no" is still
 * possible, and git puts the reason on the pushing terminal for free.
 *
 * The hook cannot validate anything by itself — it is a shell script in a bare repository with no model of what
 * an agent is. It asks the node, on loopback, with a secret only a process on this machine can read. The node
 * answers with the schema's own message, which is what the person then reads.
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import express, { Router, type Request, type Response } from 'express';
import { AgentGit, AgentGitError, AGENT_GIT_DEFAULT_BRANCH, AGENT_GIT_QUARANTINE_VARS, type AgentGitQuarantine } from './agent-git.js';
import type { HostedAgentSpecInput } from './hosted-agent-types.js';

/** The zero sha git sends for "this ref did not exist" and for a deletion. */
const NO_REF = '0'.repeat(40);

export interface AgentGitHttpDeps {
  git: AgentGit;
  /** Where the internal hook endpoint lives, for the hook script to call back on. */
  loopbackPort: () => number;
  /**
   * May this caller push to this agent? The same question `PUT /api/hosted-agents/:id` asks, answered by the
   * same code — a repository must not be a second, weaker door onto the same agent.
   */
  canPush: (req: Request, id: string) => Promise<boolean> | boolean;
  /** May this caller read it? Clone follows what a listing shows: a private agent is its owner's alone. */
  canRead: (req: Request, id: string) => Promise<boolean> | boolean;
  /** An agent that is mirrored from elsewhere is read-only here; this names where to push instead. */
  mirrorOf?: (id: string) => { url: string } | null;
  /**
   * Apply a validated tree. Runs AFTER the ref moves (post-receive): the spec is stored and the agent is
   * re-applied, which is what makes every live address serve the new version. Throwing here does not undo the
   * push — by then the commit is the truth — so it logs and the state the page shows says it failed.
   */
  apply: (id: string, input: HostedAgentSpecInput, commit: string, by: string | null) => Promise<void>;
  /** Server-owned sharing policy must pass before the deployed ref moves. */
  validate?: (id: string, input: HostedAgentSpecInput) => void | Promise<void>;
  log: (level: 'info' | 'warn' | 'error', message: string) => void;
}

/** What a pre-receive asks about, one line per ref git is being asked to move. */
export interface AgentGitRefUpdate { ref: string; before: string; after: string }

export class AgentGitHttp {
  /** Shared with the hook script through a file only this user can read; compared in constant time. */
  private readonly hookSecret = randomBytes(24).toString('hex');

  constructor(private readonly deps: AgentGitHttpDeps) {}

  /**
   * The hook, written into a repository when it is created.
   *
   * Node rather than shell because it has to speak JSON and HTTP, and the node binary is by definition present.
   * The secret arrives through the environment of the `git-receive-pack` process, not through the file, so a
   * copy of the repository is not a copy of the credential.
   */
  installHooks(id: string): void {
    const dir = join(this.deps.git.dir(id), 'hooks');
    mkdirSync(dir, { recursive: true });
    const script = `#!/usr/bin/env node
// Written by ainize (agent-git-http.ts). A push is only a deploy if the tree is a valid agent, and this is the
// last moment at which "no" is still possible — after this, git has written the ref.
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', async () => {
  const updates = Buffer.concat(chunks).toString('utf8').split('\\n').filter(Boolean).map((line) => {
    const [before, after, ref] = line.split(' ');
    return { before, after, ref };
  });
  if (!updates.length) process.exit(0);
  const port = process.env.AINIZE_AGENT_GIT_PORT;
  const secret = process.env.AINIZE_AGENT_GIT_SECRET;
  try {
    const res = await fetch(\`http://127.0.0.1:\${port}/api/internal/agent-git/pre-receive\`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ainize-agent-git': secret ?? '' },
      // The objects of this push are quarantined until every hook agrees; without these three the node
      // cannot read the commit it is being asked to judge (agent-git.ts AgentGitQuarantine).
      body: JSON.stringify({ id: ${JSON.stringify(id)}, updates, quarantine: {
        GIT_OBJECT_DIRECTORY: process.env.GIT_OBJECT_DIRECTORY,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES,
        GIT_QUARANTINE_PATH: process.env.GIT_QUARANTINE_PATH,
      } }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.ok) process.exit(0);
    // git prints every stderr line of a rejected pre-receive, prefixed "remote:". This is the person's whole
    // error message, so it carries the schema's words rather than a status code.
    for (const line of String(body.message || 'ainize refused this push').split('\\n')) console.error(line);
    process.exit(1);
  } catch (e) {
    console.error('ainize could not be reached to check this push: ' + (e && e.message ? e.message : e));
    process.exit(1);
  }
});
`;
    const path = join(dir, 'pre-receive');
    writeFileSync(path, script, { mode: 0o700 });
    chmodSync(path, 0o700);
  }

  /** The routes a git client talks to, plus the loopback endpoint the hook calls. */
  router(): Router {
    const r = Router();

    /**
     * The hook's question. Loopback only and secret-gated: it decides whether a push lands, so reaching it from
     * anywhere else would be a way to approve one.
     */
    r.post('/api/internal/agent-git/pre-receive',
      /**
       * Its own body parser, and not the application's.
       *
       * This router has to be mounted BEFORE any `express.json()`, because a push IS the request body and a
       * parser that has already read it leaves nothing to pipe into `git-receive-pack`. That mount order means
       * this route cannot rely on an app-level parser existing, so it carries one scoped to itself.
       */
      express.json({ limit: '64kb' }),
      async (req, res) => {
      const offered = String(req.header('x-ainize-agent-git') ?? '');
      const want = Buffer.from(this.hookSecret);
      const got = Buffer.from(offered.padEnd(want.length, '\0').slice(0, want.length));
      if (!timingSafeEqual(want, got) || offered.length !== this.hookSecret.length) {
        res.status(403).json({ ok: false, message: 'not this node\'s hook' });
        return;
      }
      const { id, updates, quarantine } = (req.body ?? {}) as { id?: string; updates?: AgentGitRefUpdate[]; quarantine?: Record<string, unknown> };
      if (!id || !Array.isArray(updates)) { res.status(400).json({ ok: false, message: 'malformed hook call' }); return; }
      const verdict = await this.check(id, updates, pickQuarantine(quarantine));
      res.status(verdict.ok ? 200 : 409).json(verdict);
    });

    // `/git/<id>.git/...` — the address a person pastes, which is why it is not under /api.
    r.all(/^\/git\/([a-z0-9][a-z0-9-]{0,39})\.git(\/.*)?$/, (req, res) => void this.serve(req, res));
    return r;
  }

  /**
   * Is every ref in this push one the node will accept?
   *
   * `main` is the deployed branch, so its tree must be a valid agent. Every other branch is a proposal and is
   * stored as-is: refusing a work-in-progress branch would make the repository useless for the thing branches
   * are for. Deleting `main` is refused — an agent without a main branch has nothing to serve.
   */
  async check(id: string, updates: AgentGitRefUpdate[], quarantine?: AgentGitQuarantine): Promise<{ ok: boolean; message?: string }> {
    for (const u of updates) {
      if (u.ref !== `refs/heads/${AGENT_GIT_DEFAULT_BRANCH}`) continue;
      if (u.after === NO_REF) {
        return { ok: false, message: `${AGENT_GIT_DEFAULT_BRANCH} is the branch this agent serves from — it cannot be deleted.` };
      }
      try {
        const read = await this.deps.git.readSpec(id, u.after, quarantine);
        await this.deps.validate?.(id, read.input);
      } catch (e) {
        const why = e instanceof AgentGitError ? e.message : (e as Error).message;
        return {
          ok: false,
          message: `ainize refused this push to ${AGENT_GIT_DEFAULT_BRANCH}, because it would not run:\n${why}\n` +
            `Nothing changed; the agent is still serving what it was. Push to another branch to keep the work.`,
        };
      }
    }
    return { ok: true };
  }

  /** `main`'s commit, or null when there is none — the before/after that says whether a push changed anything. */
  private async mainSha(id: string): Promise<string | null> {
    try { return await this.deps.git.resolve(id, AGENT_GIT_DEFAULT_BRANCH); } catch { return null; }
  }

  /** After the refs moved: store the new spec and re-apply the agent, which is what updates every live address. */
  private async afterPush(req: Request, id: string): Promise<void> {
    try {
      const read = await this.deps.git.readSpec(id, AGENT_GIT_DEFAULT_BRANCH);
      await this.deps.apply(id, read.input, read.commit, (req as { agentGitPusher?: string }).agentGitPusher ?? null);
    } catch (e) {
      // pre-receive already refused anything invalid, so reaching here means the apply itself failed — a Docker
      // build, a model that went away. The push stands (the commit is the truth now) and the agent's status says so.
      this.deps.log('warn', `agent ${id}: the push landed but the agent could not be applied — ${(e as Error).message}`);
    }
  }

  private async serve(req: Request, res: Response): Promise<void> {
    const m = /^\/git\/([a-z0-9][a-z0-9-]{0,39})\.git(\/.*)?$/.exec(req.path);
    if (!m) { res.status(404).end(); return; }
    const id = m[1]!;
    const rest = m[2] ?? '/';
    // A push is any receive-pack traffic: the ref advertisement it asks for first, and the pack itself.
    const writing = rest.includes('git-receive-pack') || String(req.query.service ?? '') === 'git-receive-pack';

    if (!this.deps.git.exists(id)) { this.refuse(res, 404, `no agent "${id}" on this node`); return; }

    const mirror = writing ? this.deps.mirrorOf?.(id) ?? null : null;
    if (mirror) {
      this.refuse(res, 403, `this agent mirrors ${mirror.url} — push there and ainize follows it. One writable copy, or "what is running" has two answers.`);
      return;
    }

    const allowed = writing ? await this.deps.canPush(req, id) : await this.deps.canRead(req, id);
    if (!allowed) {
      // Basic, because git only knows how to answer that. The realm names the agent so a credential helper
      // keeps one entry per agent rather than one for the whole site.
      res.setHeader('WWW-Authenticate', `Basic realm="ainize agent ${id}"`);
      this.refuse(res, 401, writing
        ? `not allowed to push to "${id}" — use an ainize API key as the password, for the account that owns it`
        : `not allowed to read "${id}"`);
      return;
    }

    await this.cgi(req, res, id, rest, writing);
  }

  private refuse(res: Response, status: number, message: string): void {
    // A git client shows the body of a failed request, so this is what the person reads on their terminal.
    res.status(status).type('text/plain').send(`${message}\n`);
  }

  /**
   * `git http-backend` as CGI.
   *
   * `GIT_PROJECT_ROOT` scopes it to the agent repositories and `PATH_INFO` names the one repository this request
   * is for, so a path that escaped the pattern above could still not reach another agent's objects.
   */
  private async cgi(req: Request, res: Response, id: string, rest: string, writing: boolean): Promise<void> {
    const mainBefore = writing ? await this.mainSha(id) : null;
    return new Promise((resolve) => {
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        GIT_PROJECT_ROOT: this.deps.git.root,
        GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: `/${id}.git${rest}`,
        REQUEST_METHOD: req.method,
        QUERY_STRING: req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?') + 1) : '',
        CONTENT_TYPE: req.header('content-type') ?? '',
        CONTENT_LENGTH: req.header('content-length') ?? '',
        REMOTE_ADDR: req.ip ?? '',
        REMOTE_USER: (req as { agentGitPusher?: string }).agentGitPusher ?? 'ainize',
        // Protocol v2 is negotiated through this header; dropping it silently downgrades every modern client.
        ...(req.header('git-protocol') ? { GIT_PROTOCOL: req.header('git-protocol')! } : {}),
        ...(writing ? { AINIZE_AGENT_GIT_PORT: String(this.deps.loopbackPort()), AINIZE_AGENT_GIT_SECRET: this.hookSecret } : {}),
      };
      const child = spawn('git', ['http-backend'], { env });
      let header = Buffer.alloc(0);
      let headersDone = false;
      let stderr = '';
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });

      child.stdout.on('data', (chunk: Buffer) => {
        if (headersDone) { res.write(chunk); return; }
        header = Buffer.concat([header, chunk]);
        const split = header.indexOf('\r\n\r\n');
        const split2 = split === -1 ? header.indexOf('\n\n') : split;
        if (split2 === -1) return;
        const sep = split !== -1 ? 4 : 2;
        const at = split !== -1 ? split : split2;
        for (const line of header.subarray(0, at).toString('utf8').split(/\r?\n/)) {
          const i = line.indexOf(':');
          if (i === -1) continue;
          const name = line.slice(0, i).trim();
          const value = line.slice(i + 1).trim();
          if (name.toLowerCase() === 'status') res.status(parseInt(value, 10) || 200);
          else res.setHeader(name, value);
        }
        headersDone = true;
        const body = header.subarray(at + sep);
        if (body.length) res.write(body);
      });

      child.on('error', (e) => {
        if (!res.headersSent) this.refuse(res, 500, `git is not available on this node: ${e.message}`);
        resolve();
      });
      child.on('close', async (code) => {
        if (code !== 0 && !res.headersSent) {
          this.deps.log('warn', `agent ${id}: git http-backend exited ${code}: ${stderr.slice(0, 500)}`);
          this.refuse(res, 500, 'git failed on this node');
          resolve();
          return;
        }
        /**
         * Applied BEFORE the response ends, which is the whole claim of this feature.
         *
         * Ending the response first would make `git push` return while the agent was still the previous
         * version — the terminal says "done", the address serves the old thing, and how long that lasts is a
         * race nobody can see. git has no short timeout on receive-pack; waiting is what lets "pushed" and
         * "live" be the same moment. A build that fails does not hold the push open any longer than it takes
         * to fail, and leaves the previous version serving (hosted-agent-host.ts).
         */
        /**
         * Only when `main` actually moved.
         *
         * Every receive-pack ends up here — including the ones a hook refused and the ones that pushed a
         * work-in-progress branch. Re-applying on those would rebuild an agent that nobody changed, and would
         * make a REJECTED push look, in the event feed and in the logs, exactly like an accepted one.
         */
        if (writing && rest.includes('git-receive-pack') && req.method === 'POST') {
          const after = await this.mainSha(id);
          if (after && after !== mainBefore) await this.afterPush(req, id);
        }
        res.end();
        resolve();
      });

      req.pipe(child.stdin);
      req.on('aborted', () => child.kill('SIGTERM'));
    });
  }
}

/**
 * Only the three quarantine variables, and only as strings.
 *
 * The hook is a process on this machine, but the body it posts is still input, and the fields are about to
 * become the environment of a `git` process. Copying whatever arrived would make this endpoint a way to set
 * environment variables on a child of the node.
 */
function pickQuarantine(raw: unknown): AgentGitQuarantine | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: AgentGitQuarantine = {};
  for (const key of AGENT_GIT_QUARANTINE_VARS) {
    const v = (raw as Record<string, unknown>)[key];
    if (typeof v === 'string' && v) out[key] = v;
  }
  return Object.keys(out).length ? out : undefined;
}
