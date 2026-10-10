/**
 * An agent's history, as a real git repository the node owns.
 *
 * THE PROBLEM. A spec is `files: Record<string, string>` and `version: number` in one JSON file. That answers
 * "what is it now" and nothing else — not what changed, not who changed it, not what it was before, and not how
 * two people work on one agent without overwriting each other. The store's own conflict message already points
 * at the missing half ("your edits are in git"): there is a repository in the AinCode workspace, a counter here,
 * and a JSON POST in between. This is the repository on this side of that POST.
 *
 * WHY THE `git` BINARY. Pack negotiation, delta resolution and merge are not things to reimplement, and the thing
 * on the other end is ordinary `git` on somebody's laptop, which is the whole point. The node already shells out
 * to `docker` for the same reason. Everything here is `git` in a bare repository with no working tree, so there
 * is no checkout to race and nothing on disk to leave half-written.
 *
 * THE TREE IS THE SPEC. `agent.json`, `prompt.md`, `files/…`. What a person edits in a clone is what the node
 * reads back, through the same zod schema the HTTP route uses — so a tree that would not have been a valid POST
 * is not a valid push either, and finds out at push time.
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { hostedAgentSpecInput, type HostedAgentSpec, type HostedAgentSpecInput } from './hosted-agent-types.js';

const run = promisify(execFile);

/**
 * git with something on its standard input — `mktree` and `hash-object --stdin`, which is how a tree is written
 * without a working directory. `execFile` has no `input`, and the synchronous form would block the event loop
 * for the length of a push.
 */
function runWithInput(args: string[], input: string, env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { env: env ?? process.env });
    let out = ''; let err = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => { out += d; });
    child.stderr.on('data', (d: string) => { err += d; });
    child.on('error', (e) => reject(new AgentGitError(e.message)));
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new AgentGitError((err || `git ${args[0]} exited ${code}`).trim()))));
    child.stdin.end(input);
  });
}

/** The branch a push deploys from. Anything else is a proposal (see the PR flow). */
export const AGENT_GIT_DEFAULT_BRANCH = 'main';

/** Paths in the tree. `prompt.md` is its own file because a prompt is prose and a diff of prose is readable. */
export const AGENT_GIT_SPEC_FILE = 'agent.json';
export const AGENT_GIT_PROMPT_FILE = 'prompt.md';
export const AGENT_GIT_FILES_DIR = 'files';

/**
 * Fields the repository does NOT get to set.
 *
 * `id` is the agent's public address — a file edit must not rename what callers hold. The rest are the node's
 * record of its own work. A push that sets one is refused rather than ignored: a field that looks writable and
 * silently is not is a trap, and the person would believe they had changed it.
 */
export const AGENT_GIT_RESERVED_FIELDS = ['id', 'owner', 'version', 'createdAt', 'updatedAt', 'popJwk', 'updatedBy'] as const;

export class AgentGitError extends Error {}

export interface AgentCommit {
  sha: string;
  /** The short sha a person reads and types. */
  short: string;
  author: string;
  email: string;
  at: number;
  subject: string;
  body: string;
}

export interface AgentRef {
  name: string;
  sha: string;
  /** Commits on this branch that `main` does not have, and the other way round. Absent for `main` itself. */
  ahead?: number;
  behind?: number;
}

/** What the tree of one commit says the agent is, before the node adds what it owns. */
export interface AgentTreeRead {
  input: HostedAgentSpecInput;
  commit: string;
}

/**
 * The environment that lets a process outside `receive-pack` see the objects a push is proposing.
 *
 * git quarantines incoming objects: during a push they live in a temporary directory named by
 * `GIT_QUARANTINE_PATH`, and only move into the repository if every hook says yes. A hook inherits that
 * environment; the node, which validates out-of-band over loopback, does not — so to it the pushed commit
 * does not exist yet ("fatal: Needed a single revision"), and every push would be refused as unreadable.
 * The hook hands these three across and the node runs git with them.
 */
export interface AgentGitQuarantine {
  GIT_OBJECT_DIRECTORY?: string;
  GIT_ALTERNATE_OBJECT_DIRECTORIES?: string;
  GIT_QUARANTINE_PATH?: string;
}

export const AGENT_GIT_QUARANTINE_VARS = ['GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_QUARANTINE_PATH'] as const;

export class AgentGit {
  constructor(private readonly repoRoot: string) {}

  /** Where the repositories live — `git http-backend` is scoped to it (GIT_PROJECT_ROOT). */
  get root(): string {
    return this.repoRoot;
  }

  dir(id: string): string {
    return join(this.repoRoot, `${id}.git`);
  }

  exists(id: string): boolean {
    return existsSync(this.dir(id));
  }

  /**
   * Run git in one agent's repository.
   *
   * `maxBuffer` is raised because a diff or a log of a busy agent is bigger than the 1 MB default, and the
   * failure mode of the default is a truncated answer that looks like a short history. Errors carry git's own
   * stderr: it is better at saying what is wrong with a tree than anything this file could compose.
   */
  private async git(id: string, args: string[], opts: { cwd?: string; quarantine?: AgentGitQuarantine } = {}): Promise<string> {
    try {
      const { stdout } = await run('git', ['--git-dir', this.dir(id), ...args], {
        maxBuffer: 32 * 1024 * 1024,
        encoding: 'utf8',
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        ...(opts.quarantine ? { env: { ...process.env, ...opts.quarantine } } : {}),
      });
      return stdout;
    } catch (e) {
      const err = e as { stderr?: string; message?: string };
      throw new AgentGitError((err.stderr || err.message || 'git failed').trim());
    }
  }

  /** Bare, `main`, and nothing else — the first commit is written by `commitSpec`. */
  async init(id: string): Promise<void> {
    if (this.exists(id)) return;
    mkdirSync(this.repoRoot, { recursive: true });
    await run('git', ['init', '--bare', `--initial-branch=${AGENT_GIT_DEFAULT_BRANCH}`, this.dir(id)], { encoding: 'utf8' });
    // A bare repo refuses `receive-pack` into the checked-out branch unless it is told it has no working tree.
    await this.git(id, ['config', 'core.logAllRefUpdates', 'true']);
  }

  /** An independent object store: deleting or collecting the source cannot break the fork. */
  async fork(source: string, id: string, commit: string): Promise<void> {
    if (this.exists(id)) throw new AgentGitError('repository id already exists');
    await run('git', ['clone', '--bare', '--no-hardlinks', this.dir(source), this.dir(id)], { encoding: 'utf8' });
    await this.setRef(id, AGENT_GIT_DEFAULT_BRANCH, commit);
  }

  /** Import only the commit explicitly proposed by an authorized fork owner, retained under an internal ref. */
  async importProposal(id: string, source: string, commit: string, ref: string): Promise<void> {
    await this.git(id, ['fetch', '--no-tags', '--', this.dir(source), commit]);
    await this.git(id, ['update-ref', `refs/pull-proposals/${ref}`, commit]);
  }

  async hasCommits(id: string): Promise<boolean> {
    try {
      await this.git(id, ['rev-parse', '--verify', `${AGENT_GIT_DEFAULT_BRANCH}^{commit}`]);
      return true;
    } catch { return false; }
  }

  async resolve(id: string, ref: string, quarantine?: AgentGitQuarantine): Promise<string> {
    return (await this.git(id, ['rev-parse', '--verify', `${ref}^{commit}`], { quarantine })).trim();
  }

  /**
   * The spec as a tree, written as one commit with no checkout.
   *
   * `hash-object`/`mktree` rather than a temporary working directory: two pushes landing at once must not share
   * a checkout, and there is nothing to clean up after a failure. Directories under `files/` are built bottom-up
   * because a tree entry for a subdirectory is itself a tree object.
   */
  async commitSpec(id: string, spec: HostedAgentSpec | (HostedAgentSpecInput & { id: string }), opts: {
    message: string;
    author?: { name: string; email: string };
    parent?: string | null;
  }): Promise<string> {
    const files = new Map<string, string>();
    files.set(AGENT_GIT_SPEC_FILE, `${JSON.stringify(agentJsonOf(spec), null, 2)}\n`);
    files.set(AGENT_GIT_PROMPT_FILE, spec.systemPrompt ?? '');
    for (const [path, body] of Object.entries(spec.files ?? {})) files.set(`${AGENT_GIT_FILES_DIR}/${path}`, body);

    const tree = await this.writeTree(id, files);
    const author = opts.author ?? { name: 'ainize', email: 'agents@ainize.ai' };
    const parentArgs = opts.parent ? ['-p', opts.parent] : [];
    const { stdout } = await run('git', ['--git-dir', this.dir(id), 'commit-tree', tree, ...parentArgs, '-m', opts.message], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email,
        GIT_COMMITTER_NAME: 'ainize', GIT_COMMITTER_EMAIL: 'agents@ainize.ai',
      },
    });
    const commit = stdout.trim();
    await this.git(id, ['update-ref', `refs/heads/${AGENT_GIT_DEFAULT_BRANCH}`, commit]);
    return commit;
  }

  /** A path→content map as a tree object, nested directories and all. */
  private async writeTree(id: string, files: Map<string, string>): Promise<string> {
    interface Node { blobs: Map<string, string>; dirs: Map<string, Node> }
    const root: Node = { blobs: new Map(), dirs: new Map() };
    for (const [path, body] of files) {
      const parts = path.split('/').filter(Boolean);
      let node = root;
      for (const seg of parts.slice(0, -1)) {
        if (!node.dirs.has(seg)) node.dirs.set(seg, { blobs: new Map(), dirs: new Map() });
        node = node.dirs.get(seg)!;
      }
      const blob = await this.hashObject(id, body);
      node.blobs.set(parts[parts.length - 1]!, blob);
    }
    const write = async (node: Node): Promise<string> => {
      const lines: string[] = [];
      for (const [name, sha] of node.blobs) lines.push(`100644 blob ${sha}\t${name}`);
      for (const [name, child] of node.dirs) lines.push(`040000 tree ${await write(child)}\t${name}`);
      return (await runWithInput(['--git-dir', this.dir(id), 'mktree'], lines.join('\n') + (lines.length ? '\n' : ''))).trim();
    };
    return write(root);
  }

  private async hashObject(id: string, body: string): Promise<string> {
    return (await runWithInput(['--git-dir', this.dir(id), 'hash-object', '-w', '--stdin'], body)).trim();
  }

  /**
   * Read a commit's tree back as a spec input — the inverse of `commitSpec`, and the thing a push is validated by.
   *
   * It goes through `hostedAgentSpecInput`, the same schema `POST /api/hosted-agents` runs, so there is one
   * definition of what an agent is and a tree cannot be valid here and invalid there. Reserved fields are a
   * refusal, not a silent drop (see AGENT_GIT_RESERVED_FIELDS).
   */
  async readSpec(id: string, ref: string, quarantine?: AgentGitQuarantine): Promise<AgentTreeRead> {
    let commit: string;
    try {
      commit = await this.resolve(id, ref, quarantine);
    } catch (e) {
      // git's own words for an empty repository are "Needed a single revision", which tells a person nothing
      // about what to do. The two cases are different things to fix, so they are said differently.
      const empty = !(await this.hasCommits(id));
      throw new AgentGitError(empty
        ? `this agent's repository has no commits yet — push one to ${AGENT_GIT_DEFAULT_BRANCH}`
        : `no such ref "${ref}" in this agent's repository (${(e as Error).message})`);
    }
    const raw = await this.show(id, commit, AGENT_GIT_SPEC_FILE, quarantine);
    if (raw === null) throw new AgentGitError(`${AGENT_GIT_SPEC_FILE} is missing — an agent's repository has one at its root`);
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(raw) as Record<string, unknown>;
    } catch (e) {
      throw new AgentGitError(`${AGENT_GIT_SPEC_FILE} is not valid JSON: ${(e as Error).message}`);
    }
    const set = AGENT_GIT_RESERVED_FIELDS.filter((f) => f in json);
    if (set.length) {
      throw new AgentGitError(
        `${AGENT_GIT_SPEC_FILE} sets ${set.join(', ')}, which the node owns — remove ${set.length > 1 ? 'them' : 'it'}. ` +
        `An agent's id is its public address and cannot be changed by editing a file.`,
      );
    }
    const prompt = await this.show(id, commit, AGENT_GIT_PROMPT_FILE, quarantine);
    const files: Record<string, string> = {};
    for (const path of await this.lsFiles(id, commit, quarantine)) {
      if (!path.startsWith(`${AGENT_GIT_FILES_DIR}/`)) continue;
      files[path.slice(AGENT_GIT_FILES_DIR.length + 1)] = (await this.show(id, commit, path, quarantine)) ?? '';
    }
    const parsed = hostedAgentSpecInput.safeParse({ ...json, id, systemPrompt: prompt ?? '', files });
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
      throw new AgentGitError(`this tree is not a valid agent:\n  ${issues.join('\n  ')}`);
    }
    return { input: parsed.data, commit };
  }

  /** One file's contents at one commit, or null when the tree has no such path. */
  async show(id: string, ref: string, path: string, quarantine?: AgentGitQuarantine): Promise<string | null> {
    try {
      return await this.git(id, ['show', `${ref}:${path}`], { quarantine });
    } catch { return null; }
  }

  async lsFiles(id: string, ref: string, quarantine?: AgentGitQuarantine): Promise<string[]> {
    const out = await this.git(id, ['ls-tree', '-r', '--name-only', ref], { quarantine });
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  }

  /**
   * The history, in the shape a page renders.
   *
   * The separators are control characters because a commit subject may contain anything a person can type, and a
   * delimiter a person can type is a delimiter that will be typed one day.
   */
  async log(id: string, ref = AGENT_GIT_DEFAULT_BRANCH, limit = 50): Promise<AgentCommit[]> {
    if (!(await this.hasCommits(id))) return [];
    const out = await this.git(id, ['log', `-${Math.max(1, Math.min(limit, 500))}`, '--format=%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%b%x1e', ref]);
    return out.split('\x1e').map((row) => row.replace(/^\n/, '')).filter(Boolean).map((row) => {
      const [sha, short, author, email, at, subject, body] = row.split('\x1f');
      return { sha: sha!, short: short!, author: author!, email: email!, at: Number(at) * 1000, subject: subject ?? '', body: (body ?? '').trim() };
    });
  }

  /** Every branch, with how far it has moved from `main` — which is what says whether a proposal is behind. */
  async refs(id: string): Promise<{ branches: AgentRef[]; head: string }> {
    if (!(await this.hasCommits(id))) return { branches: [], head: AGENT_GIT_DEFAULT_BRANCH };
    // A space, not the \x1f `git log` takes: `for-each-ref` does not expand pretty-format escapes, and it would
    // hand back the two characters themselves. A ref name cannot contain a space, so a space cannot be ambiguous.
    const out = await this.git(id, ['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads/']);
    const rows = out.split('\n').filter(Boolean).map((l) => { const [name, sha] = l.split(' '); return { name: name!, sha: sha! }; });
    const branches: AgentRef[] = [];
    for (const r of rows) {
      if (r.name === AGENT_GIT_DEFAULT_BRANCH) { branches.push(r); continue; }
      try {
        const counts = (await this.git(id, ['rev-list', '--left-right', '--count', `${AGENT_GIT_DEFAULT_BRANCH}...${r.name}`])).trim().split(/\s+/);
        branches.push({ ...r, behind: Number(counts[0] ?? 0), ahead: Number(counts[1] ?? 0) });
      } catch { branches.push(r); }
    }
    return { branches, head: AGENT_GIT_DEFAULT_BRANCH };
  }

  /** A unified diff between two refs, for the page that shows what a proposal changes. */
  async diff(id: string, base: string, head: string, limitBytes = 256 * 1024): Promise<{ diff: string; truncated: boolean }> {
    const out = await this.git(id, ['diff', '--no-color', `${base}...${head}`]);
    return out.length > limitBytes ? { diff: out.slice(0, limitBytes), truncated: true } : { diff: out, truncated: false };
  }

  /**
   * Merge a branch into the deployed one.
   *
   * In a THROWAWAY WORKTREE, not with `merge-tree --write-tree`: that flag arrived in git 2.38 and the node
   * this runs on has 2.34, where the same command is a different, textual thing that cannot produce a tree.
   * Depending on it would mean the merge button worked on the developer's machine and answered "conflicts in
   * usage: git merge-tree" in production — which is exactly what it did.
   *
   * The worktree is temporary and detached, so nothing shared is checked out, two merges cannot race over one
   * index, and a failure leaves only a directory to delete. An agent is a few kilobytes; the checkout costs
   * nothing next to the model call the agent is about to make.
   *
   * The ref is NOT moved here. The caller moves it the same way a push does, so the merge result goes through
   * the same validation: if merging two trees that were each fine produced one that is not a valid agent, that
   * has to be refused, and the only way to be sure is to run the same check on the result.
   */
  async mergeTree(id: string, base: string, head: string): Promise<
    | { ok: true; commit: string; alreadyUpToDate: boolean }
    | { ok: false; conflicts: string[] }
  > {
    const baseSha = await this.resolve(id, base);
    const headSha = await this.resolve(id, head);
    // Nothing to do: the proposal is already in. Said plainly rather than as an empty merge commit.
    const contained = await this.git(id, ['merge-base', '--is-ancestor', headSha, baseSha]).then(() => true).catch(() => false);
    if (contained) return { ok: true, commit: baseSha, alreadyUpToDate: true };

    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const work = await mkdtemp(join(tmpdir(), 'ainize-merge-'));
    try {
      await this.git(id, ['worktree', 'add', '--detach', '--quiet', work, baseSha]);
      const inWork = (args: string[]) => run('git', ['-C', work, ...args], {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, GIT_AUTHOR_NAME: 'ainize', GIT_AUTHOR_EMAIL: 'agents@ainize.ai', GIT_COMMITTER_NAME: 'ainize', GIT_COMMITTER_EMAIL: 'agents@ainize.ai' },
      });
      try {
        await inWork(['merge', '--no-ff', '--quiet', '-m', `Merge ${head} into ${base}`, headSha]);
      } catch (e) {
        // The conflicted paths, which is the only part of a failed merge a person can act on.
        const conflicts = await inWork(['diff', '--name-only', '--diff-filter=U'])
          .then(({ stdout }) => stdout.split('\n').map((l) => l.trim()).filter(Boolean))
          .catch(() => []);
        if (!conflicts.length) throw new AgentGitError(((e as { stderr?: string }).stderr || (e as Error).message).trim());
        return { ok: false, conflicts: conflicts.slice(0, 20) };
      }
      const { stdout } = await inWork(['rev-parse', 'HEAD']);
      return { ok: true, commit: stdout.trim(), alreadyUpToDate: false };
    } finally {
      // Both, and in this order: the directory is what `worktree prune` looks for, and a stale registration
      // makes the NEXT merge of this agent fail with "already registered".
      await rm(work, { recursive: true, force: true }).catch(() => {});
      await this.git(id, ['worktree', 'prune']).catch(() => {});
    }
  }

  /** Move a branch to a commit — the last step of a merge, after the result has been validated. */
  async setRef(id: string, branch: string, commit: string): Promise<void> {
    await this.git(id, ['update-ref', `refs/heads/${branch}`, commit]);
  }

  /**
   * The commit `main` is on, read from disk rather than from `git`.
   *
   * A listing renders every agent on the node, and spawning a process per row to ask one question would make
   * the page pay for the history it is only mentioning. A ref is a file holding a sha, or a line in
   * `packed-refs` once git has packed them; both are read here, and an unreadable one is null rather than a
   * throw — a missing commit is a thing to show as blank, not a reason to fail the listing.
   */
  headSync(id: string, branch = AGENT_GIT_DEFAULT_BRANCH): string | null {
    const loose = join(this.dir(id), 'refs', 'heads', branch);
    try {
      const sha = readFileSync(loose, 'utf8').trim();
      if (/^[0-9a-f]{40}$/.test(sha)) return sha;
    } catch { /* packed, or no such branch */ }
    try {
      for (const line of readFileSync(join(this.dir(id), 'packed-refs'), 'utf8').split('\n')) {
        const [sha, ref] = line.trim().split(' ');
        if (ref === `refs/heads/${branch}` && sha && /^[0-9a-f]{40}$/.test(sha)) return sha;
      }
    } catch { /* no packed-refs */ }
    return null;
  }

  async deleteRepo(id: string): Promise<void> {
    const { rm } = await import('node:fs/promises');
    await rm(this.dir(id), { recursive: true, force: true });
  }

  /** A self-contained copy of every retained ref, suitable for ordinary `git clone`. */
  async exportBundle(id: string, path: string): Promise<void> {
    await this.git(id, ['bundle', 'create', path, '--all']);
    await this.git(id, ['bundle', 'verify', path]);
    const { chmod } = await import('node:fs/promises');
    await chmod(path, 0o600);
  }

  /** Restore through a temporary bare clone; never overwrite an existing agent. */
  async restoreBundle(id: string, path: string): Promise<void> {
    const { mkdtemp, rename, rm } = await import('node:fs/promises');
    mkdirSync(this.repoRoot, { recursive: true });
    if (this.exists(id)) throw new AgentGitError('repository id already exists');
    const temporary = await mkdtemp(join(this.repoRoot, '.restore-'));
    const repo = join(temporary, 'repository.git');
    try {
      await run('git', ['clone', '--mirror', '--', path, repo], { encoding: 'utf8' });
      await run('git', ['--git-dir', repo, 'fsck', '--full'], { encoding: 'utf8' });
      // A local archive is not an upstream and must not become a credential-bearing remote.
      await run('git', ['--git-dir', repo, 'remote', 'remove', 'origin'], { encoding: 'utf8' });
      if (this.exists(id)) throw new AgentGitError('repository id already exists');
      await rename(repo, this.dir(id));
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
}

/**
 * The spec as the repository carries it: everything a person may change, and nothing the node owns.
 *
 * Written key by key rather than by deleting from a copy, so a field added to the spec later has to be thought
 * about here before it appears in somebody's repository.
 */
export function agentJsonOf(spec: HostedAgentSpecInput | HostedAgentSpec): Record<string, unknown> {
  return {
    name: spec.name,
    description: spec.description,
    model: spec.model,
    mode: spec.mode,
    a2ui: spec.a2ui,
    allowedHosts: spec.allowedHosts,
    secretNames: spec.secretNames,
    skills: spec.skills,
    media: spec.media,
    visibility: spec.visibility ?? 'public',
    orgId: spec.orgId ?? null,
  };
}
