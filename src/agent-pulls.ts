/**
 * Pull requests on an agent: a branch proposed for the branch the node deploys from.
 *
 * WHAT A PR IS HERE. A record — base, head, who, what state — beside the agent specs. The code it proposes is
 * already in the repository, because that is what pushing a branch means; a PR adds the question "should this
 * become what runs", a place to answer it, and a record of who did.
 *
 * WHY MERGING GOES THROUGH THE SAME DOOR AS A PUSH. A merge moves `main`, and moving `main` is a deploy. If
 * merging had its own path, a tree that `git push` would have refused could reach production by being merged
 * instead — so the merge commit is validated exactly as a push is, and a conflict is refused with the paths
 * that conflicted rather than a merge commit nobody reviewed.
 *
 * A reader can propose from a private repository fork. Its commit is imported and pinned when the proposal
 * opens, so later pushes or deletion of the fork cannot silently change what reviewers will merge.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type AgentPullState = 'open' | 'merged' | 'closed';

export interface AgentPull {
  /** Per agent, starting at 1 — the number people say out loud ("#3"), not a uuid. */
  number: number;
  agent: string;
  title: string;
  body: string;
  /** Branch names in the agent's own repository. */
  base: string;
  head: string;
  headAgent?: string;
  headCommit?: string;
  /** Who opened it, as an agent's `owner` field spells a principal. */
  author: string;
  state: AgentPullState;
  createdAt: number;
  updatedAt: number;
  /** Set when it merged: the commit the merge produced, and who pressed it. */
  mergedAt?: number;
  mergedBy?: string;
  mergeCommit?: string;
  comments?: AgentReviewComment[];
}

export interface AgentReviewComment {
  id: number;
  author: string;
  body: string;
  createdAt: number;
  updatedAt: number;
  commit?: string;
  path?: string;
  line?: number;
  deletedAt?: number;
}

export class AgentPullStore {
  private readonly pulls = new Map<string, AgentPull[]>();

  constructor(private readonly file: string) {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { pulls?: AgentPull[] };
      for (const p of parsed.pulls ?? []) if (p?.agent) this.pulls.set(p.agent, [...(this.pulls.get(p.agent) ?? []), p]);
    }
  }

  list(agent: string, state?: AgentPullState): AgentPull[] {
    const all = [...(this.pulls.get(agent) ?? [])].sort((a, b) => b.number - a.number);
    return state ? all.filter((p) => p.state === state) : all;
  }

  get(agent: string, number: number): AgentPull | null {
    return this.pulls.get(agent)?.find((p) => p.number === number) ?? null;
  }

  /** Numbers never repeat, even after a close: `#3` has to keep meaning one thing in a conversation. */
  open(input: { agent: string; title: string; body: string; base: string; head: string; author: string; headAgent?: string; headCommit?: string }, now = Date.now()): AgentPull {
    const rows = this.pulls.get(input.agent) ?? [];
    const pull: AgentPull = {
      ...input,
      number: rows.reduce((n, p) => Math.max(n, p.number), 0) + 1,
      state: 'open',
      createdAt: now,
      updatedAt: now,
    };
    this.pulls.set(input.agent, [...rows, pull]);
    this.save();
    return pull;
  }

  update(agent: string, number: number, patch: Partial<AgentPull>, now = Date.now()): AgentPull {
    const rows = this.pulls.get(agent) ?? [];
    const at = rows.findIndex((p) => p.number === number);
    if (at === -1) throw new Error(`no pull request #${number} on ${agent}`);
    const next = { ...rows[at]!, ...patch, updatedAt: now };
    rows[at] = next;
    this.pulls.set(agent, rows);
    this.save();
    return next;
  }

  addComment(agent: string, number: number, input: Omit<AgentReviewComment, 'id' | 'createdAt' | 'updatedAt'>, now = Date.now()): AgentReviewComment {
    const pull = this.get(agent, number);
    if (!pull) throw new Error('no pull request');
    const comments = pull.comments ?? [];
    const comment = { ...input, id: comments.reduce((n, row) => Math.max(n, row.id), 0) + 1, createdAt: now, updatedAt: now };
    this.update(agent, number, { comments: [...comments, comment] }, now);
    return comment;
  }

  updateComment(agent: string, number: number, id: number, patch: Pick<AgentReviewComment, 'body'> & { deletedAt?: number }, now = Date.now()): AgentReviewComment {
    const pull = this.get(agent, number);
    const comments = pull?.comments ?? [];
    const comment = comments.find((row) => row.id === id);
    if (!comment) throw new Error('no review comment');
    const next = { ...comment, ...patch, updatedAt: now };
    this.update(agent, number, { comments: comments.map((row) => row.id === id ? next : row) }, now);
    return next;
  }

  /** An agent that is gone takes its proposals with it. */
  dropAgent(agent: string): void {
    if (this.pulls.delete(agent)) this.save();
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ pulls: [...this.pulls.values()].flat() }), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
