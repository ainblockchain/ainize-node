# Agent git — what is live, and what is left

An agent on ainize is a git repository the node hosts and runs. `git push` to `main` is the deploy; there is
no deploy step. Design: `docs/superpowers/specs/2026-10-07-agent-git-design.md`.

Live on ainize.ai since 2026-10-07 (node `03db1c1`, web `3623c6e`; both on `main`). Every hosted agent was
backfilled with a repository at that boot — about 190 of them, each starting from one commit of what it was.

```
git clone https://ainize.ai/git/<agent-id>.git
# edit prompt.md / agent.json / files/
git push          # ← the agent serving that id is the pushed tree before this command returns
```

Authentication is HTTP Basic with an ainize API key as the password (git speaks nothing else).

## What is done

| Piece | Where |
|---|---|
| Bare repo per agent; tree ⇄ spec | `src/agent-git.ts` |
| Smart HTTP, pre-receive validation, push → apply | `src/agent-git-http.ts` |
| Commits, branches, tree, diff for a page | `src/agent-git-routes.ts` |
| Pull requests, merge through the same validation | `src/agent-pulls.ts`, `src/agent-pull-routes.ts` |
| GitHub mirror (a folder inside a repo), read-only here | `src/agent-mirror.ts`, `src/agent-mirror-routes.ts` |
| Backfill, wiring, `repo` hooks on the CRUD routes | `src/server.ts`, `src/hosted-agent-routes.ts` |
| History panel: clone address, commits, branches, diff, open PRs, merge | `ainize-web` `src/screens/agent/AgentHistoryPanel.tsx` |
| `/git` relayed from the domain | `ainize-web` `app/git/[...path]/route.ts` |

Tests: `test/agent-git.test.ts`, `agent-git-http.test.ts`, `agent-git-node.test.ts`, `agent-mirror.test.ts` —
32, against the real `git` binary and a real node, including a real `git push` over HTTP.

Three decisions worth keeping, because each was wrong at first:

- **A tree that would not run is refused in pre-receive, before the ref moves.** Validating after the fact
  means the push already succeeded and the node is left either serving a broken agent or silently rewinding a
  branch somebody has in their reflog. It runs the same zod schema `POST /api/hosted-agents` runs.
- **Apply happens before the push response ends.** Ending first makes `git push` return while the address
  still serves the previous version, and how long that lasts is a race nobody can see.
- **A merge is validated on its RESULT.** Two trees that each passed can merge into one that does not, so a
  merge button that trusted its inputs would be a way to deploy exactly the trees a push refuses.

## What is left

### 1. The GitHub mirror does not follow by itself — this is the biggest gap

`PUT /api/hosted-agents/:id/mirror` fetches once and `POST …/mirror/sync` fetches on demand. Nothing fetches
on its own, so for a mirrored agent "push and it is live" is false until a person presses Sync. Two pieces:

- **The webhook route is dead code.** `agentMirrorRoutes` takes `webhookSecret?: () => string | null`
  (`src/agent-mirror-routes.ts:33`) and `server.ts` never passes it, so `POST /api/agent-mirrors/webhook`
  always answers `404 not_configured`. Wire it to a config value or an env var, and the signature check
  (HMAC-SHA256 over the raw body, `x-hub-signature-256`) is already written and tested by shape.
- **There is no timer.** The design says "on a webhook when one is configured, on a timer otherwise". Add the
  timer in `server.ts` beside the other `setInterval` sweeps, reusing `fetchMirror`; the route's `sync()`
  already does the apply-or-record-the-error half, so factor that out rather than writing it twice.

Until both exist, a mirrored agent is a manual pull.

### 2. The reviewer cannot run a proposal before merging it

The design's one advantage over GitHub: a Run button on a branch, answered by a throwaway runtime, so somebody
reviewing a prompt change can talk to the proposed agent. Nothing is built. The hosted-agent host runs one
version per agent, so this needs a second, short-lived instance keyed by commit — the interesting part is
deciding what it may touch (an agent's secrets, its allowlist) when it is not the version anyone approved.

### 3. A pull request can only be opened over the API

`POST /api/hosted-agents/:id/pulls` works; the page lists and merges open PRs but has no way to open one.
Somebody pushing a branch from a terminal has no UI path to propose it.

### 4. The git routes are undocumented

`src/openapi.ts` carries none of `/git/…`, `…/commits`, `…/refs`, `…/tree`, `…/diff`, `…/pulls`, `…/mirror`,
so they are missing from the generated HTTP API reference (which lives in `ainize-web/docs/`). A caller
reading the reference cannot discover that an agent has a repository.

### 5. AinCode workspaces still push JSON, not git

`AinCode/ainize/sandbox/ainize-agents.mjs` reads and writes agents over `/hosted-agents` and compares an
integer version — its own conflict message already says "your edits are in git". The workspace folder layout
(`agent.json`, `prompt.md`, `files/`) was made to match the repository tree exactly, so the folder can simply
BE a clone: `ainize-agents pull` becomes `git clone`, `push` becomes `git push`, and the version comparison
goes away. This is where most people will meet the feature, so it is worth more than its size suggests.

### 6. Smaller things

- **Forks.** PRs are branches in one repository; proposing a change to an agent you cannot push to needs a
  second repository and a cross-repository permission model.
- **Review comments.** A PR has a title and a body and nothing else.
- **`ainize agent` CLI.** No `clone`/`pulls`/`mirror` commands; the HTTP API is the only door outside a browser.
- **Repository size.** Nothing caps a repository's growth. The spec caps `files` at 1 MB per version, but a
  thousand pushes of a 1 MB tree is a gigabyte, and `git gc` is never run.
- **Deleting an agent** removes its repository (`deleteRepo`), its pulls and its mirror. There is no undo and
  no export, which is a harsher outcome than it was when an agent was one JSON record.

## Operating notes

- Repositories: `<dataDir>/agent-git/<id>.git`, bare. PR records: `<dataDir>/agent-pulls.json`. Mirrors:
  `<dataDir>/agent-mirrors.json`.
- The pre-receive hook is a small node script the node writes into every repository, re-installed on every
  start — it calls back to the node on loopback with a per-process secret. A repository restored from a backup
  gets a working hook on the next boot.
- Git's object quarantine is why the hook forwards `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`
  and `GIT_QUARANTINE_PATH`: without them the node cannot read the commit it is being asked to judge, and
  every push is refused as unreadable. (It was, until that was found.)
- Merging uses a throwaway worktree, not `merge-tree --write-tree`: that flag is git 2.38+ and the host has
  2.34, where the same command is a different, textual thing that cannot produce a tree.
