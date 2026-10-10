/**
 * An agent whose code already lives on GitHub: followed, not moved.
 *
 * THE SITUATION THIS IS FOR. donga-science's agents are in a GitHub repository with a team, a history and
 * whatever review the newsroom already runs. Telling them to abandon that to get a runtime is telling them the
 * runtime is not worth it. So ainize follows the repository instead: the agent's history, branches and commits
 * are GitHub's, and what ainize adds is that a change there is live here.
 *
 * ONE WRITABLE COPY. A mirrored agent refuses pushes on the ainize side (agent-git-http.ts) and names GitHub as
 * the place to push. Two writable copies of one agent means two answers to "what is running", and the person
 * asking is usually asking because something is wrong.
 *
 * A FOLDER, NOT A REPOSITORY. The common case is an agent inside a bigger repository
 * (`donga-science-admin/news-agent`), so a mirror names a `path` and the tree is read from under it.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { AgentGit, AgentGitError, AGENT_GIT_DEFAULT_BRANCH, AGENT_GIT_RESERVED_FIELDS } from './agent-git.js';
import { hostedAgentSpecInput, type HostedAgentSpecInput } from './hosted-agent-types.js';

const run = promisify(execFile);

export interface AgentMirror {
  agent: string;
  /** An https URL. ssh would need a key the node does not have and should not be asked to hold. */
  url: string;
  branch: string;
  /** The folder inside the repository the agent lives in, or '' for the repository root. */
  path: string;
  /** The last fetch: what happened, when, and the commit it left the agent on. */
  lastFetchAt?: number;
  lastCommit?: string;
  /** Set when the last fetch failed, or when what it fetched is not a valid agent. Shown loudly. */
  error?: string | null;
}

/**
 * What may be fetched: https, or http on loopback.
 *
 * A URL here becomes an argument to `git fetch`, and what it fetches becomes what an agent runs — so plain
 * http across a network, where anyone on the path can replace the tree, is not a thing to follow. Loopback is
 * the exception the rest of this codebase already makes (the SSO issuer does the same): there is no path to
 * be on, and it is how a repository on this machine is followed at all.
 *
 * Credentials in the URL are refused rather than accepted and hidden: they would be stored in this file, go
 * out in every status line, and make a private repository look supported when what is really supported is a
 * password sitting in JSON.
 */
export function mirrorUrlOk(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.username || u.password || !u.hostname) return false;
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]');
  } catch { return false; }
}

export class AgentMirrorStore {
  private readonly mirrors = new Map<string, AgentMirror>();

  constructor(private readonly file: string) {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { mirrors?: AgentMirror[] };
      for (const m of parsed.mirrors ?? []) if (m?.agent) this.mirrors.set(m.agent, m);
    }
  }

  get(agent: string): AgentMirror | null {
    return this.mirrors.get(agent) ?? null;
  }

  list(): AgentMirror[] {
    return [...this.mirrors.values()];
  }

  set(mirror: AgentMirror): AgentMirror {
    this.mirrors.set(mirror.agent, mirror);
    this.save();
    return mirror;
  }

  patch(agent: string, fields: Partial<AgentMirror>): AgentMirror | null {
    const prior = this.mirrors.get(agent);
    if (!prior) return null;
    const next = { ...prior, ...fields };
    this.mirrors.set(agent, next);
    this.save();
    return next;
  }

  remove(agent: string): boolean {
    const had = this.mirrors.delete(agent);
    if (had) this.save();
    return had;
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ mirrors: this.list() }), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

export interface MirrorFetchResult {
  changed: boolean;
  commit: string;
  input?: HostedAgentSpecInput;
  /** Why this fetch produced nothing deployable, in words for the page that shows the mirror's state. */
  error?: string;
}

/**
 * Fetch the upstream and read the agent out of it.
 *
 * The upstream branch is kept under `refs/remotes/upstream/`, never as the agent's own `main`: the ainize copy
 * tracks GitHub, and conflating the two would mean a failed validation had already overwritten the branch the
 * node deploys from. `main` is moved by the caller, after the tree has been read and found to be an agent.
 */
export async function fetchMirror(git: AgentGit, mirror: AgentMirror, timeoutMs = 60_000): Promise<MirrorFetchResult> {
  const dir = git.dir(mirror.agent);
  const remoteRef = `refs/remotes/upstream/${mirror.branch}`;
  const g = async (args: string[]) => {
    const { stdout } = await run('git', ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '--git-dir', dir, ...args], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: timeoutMs,
      // No prompting, ever: a private repository must fail fast rather than hang a fetch loop on a password.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' },
    });
    return stdout;
  };

  await git.assertStorageLimit(mirror.agent);
  try {
    await g(['fetch', '--quiet', '--depth', '1', mirror.url, `+${mirror.branch}:${remoteRef}`]);
  } catch (e) {
    const why = ((e as { stderr?: string }).stderr || (e as Error).message).trim();
    throw new AgentGitError(`could not fetch ${mirror.url}: ${why.split('\n').slice(0, 3).join(' ')}`);
  }

  // Reject before reading or applying the new tree. Landing performs the same check,
  // but that is too late once the live runtime has already been replaced.
  await git.assertStorageLimit(mirror.agent);
  const commit = (await g(['rev-parse', '--verify', `${remoteRef}^{commit}`])).trim();
  if (mirror.lastCommit === commit) return { changed: false, commit };

  const prefix = mirror.path ? `${mirror.path.replace(/^\/+|\/+$/g, '')}/` : '';
  const read = async (name: string): Promise<string | null> => {
    try { return await g(['show', `${commit}:${prefix}${name}`]); } catch { return null; }
  };
  const raw = await read('agent.json');
  if (raw === null) {
    return { changed: true, commit, error: `${prefix}agent.json is not in ${mirror.url} at ${mirror.branch} — an agent's folder has one at its root` };
  }

  let json: Record<string, unknown>;
  try { json = JSON.parse(raw) as Record<string, unknown>; }
  catch (e) { return { changed: true, commit, error: `${prefix}agent.json is not valid JSON: ${(e as Error).message}` }; }

  const reserved = AGENT_GIT_RESERVED_FIELDS.filter((f) => f in json);
  if (reserved.length) return { changed: true, commit, error: `agent.json sets server-owned fields: ${reserved.join(', ')}` };
  const files: Record<string, string> = {};
  const listed = await g(['ls-tree', '-r', '--name-only', commit, ...(prefix ? [prefix] : [])]).catch(() => '');
  for (const full of listed.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const rel = prefix && full.startsWith(prefix) ? full.slice(prefix.length) : full;
    if (!rel.startsWith('files/')) continue;
    files[rel.slice('files/'.length)] = (await read(rel)) ?? '';
  }

  const parsed = hostedAgentSpecInput.safeParse({ ...json, id: mirror.agent, systemPrompt: (await read('prompt.md')) ?? '', files });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    return { changed: true, commit, error: `${mirror.url} no longer holds a valid agent:\n  ${issues.join('\n  ')}` };
  }
  return { changed: true, commit, input: parsed.data };
}

export const AGENT_MIRROR_DEFAULT_BRANCH = AGENT_GIT_DEFAULT_BRANCH;
