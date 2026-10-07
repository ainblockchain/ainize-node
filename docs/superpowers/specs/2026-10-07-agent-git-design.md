# Agent git: the repository is the agent

Date: 2026-10-07 · Repos: ainize-node (this), ainize-web, AinCode (`ainize/sandbox`)

## Goal

An agent on ainize is a **git repository that ainize hosts and runs**. GitHub for agents, with the two things
GitHub cannot do: the runtime is attached, so a push is live without a deploy step; and every agent has an A2A
address, so ainteams and ainmem import it by URL rather than by copying code.

1. `git clone https://ainize.ai/git/<id>.git` and `git push` work against ainize with ordinary git.
2. A push to `main` **is** the deploy: the node materialises the pushed tree into the agent spec and applies it,
   so every live address — `/agents/<id>`, the A2A card, whoever imported it — serves the new version at once.
3. Commits, branches and pull requests are first-class and visible: who changed the prompt, when, and what the
   diff was. A spec that moved from v5 to v6 said nothing; a commit says what and why.
4. An agent already living on GitHub (donga-science) is **mirrored, not moved**: ainize follows the GitHub repo
   and shows it as synced. Nobody is asked to abandon their repository to get a runtime.

Non-goals for this pass: issues, code review comments, forks across owners, git LFS, submodules, protected-branch
rules beyond "only these people may push".

## Why a repository and not a bigger spec

The spec today is `files: Record<string, string>` plus `version: number`, written to one JSON file. It works, and
it loses the only questions anybody asks when an agent misbehaves: **what changed, who changed it, and what did it
look like before.** `version: 7` is not an answer. Nor can two people work on one agent without one of them
overwriting the other — the store's own error says as much ("Someone changed it since you pulled").

Git answers all of it and is already half-present: the AinCode workspace is a git repository (`entrypoint.mjs`
runs `git init`), and `ainize-agents push` compares an integer version and tells the person "your edits are in
git". There is a repository on one side and a version counter on the other, with a JSON POST between them. This
replaces the POST with a push.

## The repository

Layout — one bare repository per agent, under the node's data directory:

```
<dataDir>/agent-git/<id>.git          bare, the agent's canonical history
```

Working tree, which is what a person clones and what the node reads back:

```
agent.json     name, description, model, mode, a2ui, allowedHosts, secretNames, skills, visibility
prompt.md      the system prompt (a prompt is prose; it belongs in a file a diff can be read on)
files/…        code for `tools` and `handler` modes — entry `files/index.mjs`
```

`agent.json` is the spec minus the fields the node owns: `id` (the address — a repository cannot rename an agent
by editing a file), `owner`, `version`, `createdAt`, `updatedAt`, `popJwk`. The node sets those; a push that tries
to set them is refused rather than silently ignored, because a field that looks writable and is not is a trap.

## Push is deploy

`git push` → `git-receive-pack` → **pre-receive**, in the node, in this order:

1. **May this caller push?** The agent's owner, or a member of the organization it is shared with — the same
   `canManageHostedAgent` that guards `PUT /api/hosted-agents/:id`. Authentication is HTTP Basic with an ainize
   API key as the password (git has no idea what a wallet is), or the session cookie when the push comes from a
   workspace on ainize itself.
2. **Is the tree a valid agent?** The node reads `agent.json`, `prompt.md` and `files/` out of the pushed commit
   and runs `hostedAgentSpecInput`, the same zod schema the HTTP route runs. A tree that fails is **rejected at
   push time**, with the schema's own message on the pushing terminal. This is the point of doing it in
   pre-receive rather than after: a bad push never becomes a bad deploy, and the person finds out where they are.
3. **Only `main` deploys.** Any other branch is a proposal; it is stored, listed, and runs nothing.

Then, post-receive: `store.update(id, input, by)` → `host.apply(spec)`. That path already exists and already does
the right thing — prompt agents remount their router, code agents rebuild their image, and *a failed build leaves
the previous version serving*. The version integer stays: it is the release number products pin (`releaseId`), and
it now carries a commit sha beside it, so "v7" and "which commit is that" are one question again.

**What "every live URL updates at once" means.** It is one node serving one agent id; `/agents/<id>`, the A2A card
and every importer resolve to the same running agent. There is nothing to fan out to — the fan-out is what a
deploy step is for, and this design's claim is that there is no deploy step. What DOES have to be told are the
peers that gossiped an advert and anyone who pinned a release: the push appends `agent.published` to the event
feed with the new version and commit, which is the signal they already read.

## Pull requests

A PR is a record, not a file: `{ id, agent, title, body, base, head, author, state, createdAt, mergedAt,
mergeCommit }`, in a JSON store beside the agent specs. `head` and `base` are refs in the same repository —
branches, not forks, for this pass.

Merging is `git merge --no-ff` into `main` performed by the node, which means it goes through the same
pre-receive validation as a push: **a PR cannot merge a tree that would not deploy.** A merge that conflicts is
refused with the conflicting paths, and the branch stays open.

What the UI shows, because this is the half that makes it feel like GitHub rather than a version counter: the
commit list with author and message, the diff of `prompt.md` rendered as prose, the PR's state, and — the thing
GitHub has no equivalent of — **a Run button on the head branch**, answered by a throwaway runtime, so a reviewer
can talk to the proposed agent before merging it.

## Mirroring a GitHub repository

An agent whose code already lives on GitHub keeps living there. `agent.json` gains nothing; the *agent* gains:

```jsonc
// in the agent's ainize record, not in the tree — it is about where the tree comes from
"upstream": { "url": "https://github.com/ainblockchain/donga-science-admin", "branch": "main", "path": "news-agent" }
```

- ainize adds the GitHub repo as a remote on the bare repo and fetches it: on a webhook when one is configured,
  on a timer otherwise. A fetch that moves `main` runs the same validate-and-apply path a push does.
- `path` is for the common case this is built for: the agent is a folder inside a bigger repository
  (`donga-science-admin/news-agent`), not a repository of its own.
- The mirror is **read-only on the ainize side**: pushing to a mirrored agent is refused and names GitHub as the
  place to push. One writable copy, or the two silently diverge and the question "what is running" has two answers.
- The UI says `synced with github.com/… · 3 minutes ago`, and says it loudly when a fetch fails or the upstream
  tree stops being a valid agent — a mirror that quietly stopped following is worse than no mirror.

## Routes

```
GET  /git/<id>.git/info/refs?service=git-upload-pack     clone and fetch (smart HTTP)
POST /git/<id>.git/git-upload-pack
GET  /git/<id>.git/info/refs?service=git-receive-pack    push
POST /git/<id>.git/git-receive-pack
GET  /api/hosted-agents/:id/commits?ref=main&limit=50    { commits: [{ sha, author, at, subject, body }] }
GET  /api/hosted-agents/:id/refs                         { branches: [{ name, sha, ahead, behind }], head }
GET  /api/hosted-agents/:id/tree?ref=&path=              one file or one directory listing
GET  /api/hosted-agents/:id/diff?base=&head=             unified diff, paths capped
GET  /api/hosted-agents/:id/pulls  POST …/pulls  POST …/pulls/:n/merge
```

The git routes are not under `/api`: a git client appends its own paths to the URL a person pastes, and
`https://ainize.ai/git/news-review.git` is the address that reads like one.

## Order of work

1. `agent-git.ts` — the bare repo: create, read a tree as a spec, write a spec as a commit, log, refs, diff.
2. `agent-git-http.ts` — smart HTTP with ainize auth; push validated and applied.
3. Backfill: every existing hosted agent gets a repository with one commit, so nothing is a special case.
4. PR store and routes; merge through the same validation.
5. Mirror: remote, fetch, webhook, the synced/failed state.
6. Web: commits, branches, diff, PRs, and Run on a branch.
