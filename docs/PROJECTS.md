# Projects — an ainize deployment bound to an aindrive git repository

*Internal design note (see `docs/README.md` for what that means). Code: `src/projects.ts`, `src/project-routes.ts`;
tests: `test/projects.test.ts`.*

## The one idea

**ainize git = aindrive git.** ainize keeps no git repositories for projects. The repository lives in an aindrive
drive, at its friendly URL `https://aindrive.ainetwork.ai/<org>/git/<repo>` (or
`https://aindrive.ainetwork.ai/api/drives/<driveId>/git/<path>`), with aindrive's history, permissions and UI. A
**Project** on an ainize node binds to one such repo + branch and says what a push there means here:

| kind | on every push to the branch |
|---|---|
| `script` | clone that commit, run `entry` (`.py` → python, `.js`/`.mjs` → node) in the `/api/run` sandbox, record stdout/stderr/exit as a Deployment |
| `agent` | build the repo as a hosted agent — **not implemented**; `POST /api/projects` answers `501 not_implemented`. `TODO(projects-agent)` in `project-routes.ts` / `projects.ts`: `agent-mirror.ts` already reads a repo folder into a `HostedAgentSpec`, so this is the next step once a per-project agent id and host wiring are decided. |

Identity is AIN SSO (or the wallet / API-key sessions the agent routes already accept, `shared-agents.ts
agentCallerOf`): the owner is the signed-in account that created the project, and only the owner reads or removes
it. The project's URL mirrors the repo: `ainize.ai/<org>/<repo>` (returned as `url`; the page itself is ainize-web's).

## API

All errors are `{ error: { code, message } }`.

| | |
|---|---|
| `POST /api/projects` | signed in. Body `{ repo, branch?: "main", kind: "script"\|"agent", entry?, name?, deployToken? }`. 201 `{ id, org, repoName, repo, branch, kind, entry, name, status, url, hookUrl, webhookSecret, hasDeployToken, … }`. **`webhookSecret` is returned once**; it is sealed at rest and never read back. 400 bad URL / missing entry, 409 `repo_taken` (one project per repo+branch on a node), 501 for `kind: "agent"`. |
| `GET /api/projects` | the caller's projects. |
| `GET /api/projects/:id`, `DELETE /api/projects/:id` | owner only; anyone else sees 404. Delete removes deployments, logs and secrets. |
| `GET /api/projects/by-repo?repo=<url>` | **no auth, CORS for aindrive** — the project bound to that repo: `{ id, org, repoName, repo, branch, kind, status, url, lastDeployment }`, no owner, no hook address. 404 when none. |
| `POST /api/projects/:id/hook` | **the push webhook** (below). 202 `{ deploymentId, status: "queued" }`, or 202 `{ ignored: true, reason }` for another branch / a branch deletion. 401 `bad_signature`, 404 unknown project. |
| `GET /api/projects/:id/deployments` | newest first. |
| `GET /api/deployments/:id` | `{ id, projectId, sha, ref, status: queued\|building\|ready\|error, pusher, startedAt, finishedAt, ms, exitCode?, error?, logUrl, outputUrl? }`. |
| `GET /api/deployments/:id/log` | the captured log: `text/plain` once over; **SSE while queued/building** (`event: log` chunks, then `event: done` with the final deployment). `Accept: text/plain` forces text. |
| `GET /api/deployments/:id/output` | stdout alone, for a `ready` deployment. |

`status` on a project is its newest deployment's (`idle` before the first push).

## What aindrive must do

**On push.** After a successful `git-receive-pack` on a repo that a project is bound to (aindrive learns which by
`GET /api/projects/by-repo?repo=…`, or because the owner pasted the project's `hookUrl` + `webhookSecret` into the
repo's settings), POST to `hookUrl`:

```
POST https://ainize.ai/api/projects/<id>/hook
content-type: application/json
X-Ainize-Signature: sha256=<hex HMAC-SHA256 of the exact raw body, keyed with webhookSecret>

{ "ref": "refs/heads/main", "before": "<sha>", "after": "<sha>", "pusher": { "subject": "<AIN SSO sub>", "email": "a@b.c" } }
```

One request per updated ref. Anything but the project's branch is acknowledged (`202 {ignored:true}`) and nothing
runs. `after` all-zeros (branch deleted) is ignored the same way. The node answers before cloning, so the push
returns at once; status is read back by id.

**In the UI.** Next to a repo, `GET /api/projects/by-repo?repo=<the repo's friendly URL>` from the browser
(origin `https://aindrive.ainetwork.ai` gets `Access-Control-Allow-Origin`) gives `status` and `lastDeployment`
(`sha`, `status`, `ms`, `logUrl`). The log and output endpoints need the owner's ainize session, so link them rather
than fetching them cross-origin.

## How the node reads the repository

The repo is behind aindrive auth (viewer+). There is **no machine-to-machine path yet** from this node's AIN SSO app
credentials to an aindrive read token (ainize-node talks to `auth.comcom.ai` only to verify ID tokens and sessions;
aindrive accepts `Authorization: Bearer <session JWT | aind_aat_… account token>`). So, for now:

* The owner pastes a **deploy token** at creation (`deployToken`: an aindrive session JWT, or better an
  `aind_aat_…` account token scoped `drives:read`). It is sealed with the same AES-256-GCM store as hosted-agent
  secrets (`<dataDir>/project-secrets.json`, key `hosted-agent-secrets.key`), write-only over HTTP, and handed to
  git through `GIT_CONFIG_*` environment entries (`http.extraHeader`) — never on the command line, and scrubbed
  from git's error text before it reaches a log.
* Limitation: a session JWT expires; an expired token makes every deployment fail with `git clone failed: … 401`
  until the project is re-created with a fresh one (there is no update endpoint yet — add `PATCH /api/projects/:id
  {deployToken}` when aindrive's token lifetimes are settled). A public repo needs no token.
* `TODO(projects-sso)` in `ProjectWorker.clone` marks where an SSO-minted token goes once aindrive accepts one.

Clone is `git clone --depth 1 --branch <branch> <repo>` into a temp dir; if the tip has moved past the pushed `sha`
(a later push is queued behind this one), the commit is fetched by id, or the clone deepened when the server will
not serve a bare sha, then `git checkout --detach <sha>`. The temp dir is removed after the run.

## The worker

One `ProjectWorker` per node: a FIFO per project (pushes to one project build in order), at most **2 building
node-wide**. For `kind: script` it reads the tree with the `/api/run` caps (≤ 32 files, ≤ 2 MiB, `.git` skipped),
posts `{ language, entry, files, env: { AINIZE_DECIDE_URL: <publicUrl>/api/decide, AINIZE_PROJECT, AINIZE_COMMIT },
timeoutMs: 120000 }` to this node's `/api/run` on loopback and reads the SSE back (`runScriptOverHttp`; the worker
takes any `RunScript`, which is what the tests fake). Exit 0 → `ready`, otherwise `error` with `exitCode`; a clone
or size failure is `error` with `error` text. Logs are `<dataDir>/projects/logs/<deploymentId>.log` (everything,
`[ainize]`-prefixed build lines included) and `.out` (stdout only); the **last 20 deployments per project** are
kept, older records and logs removed together. Deployments left `queued`/`building` by a restart are re-queued.

Persistence is `<dataDir>/projects.json` — the hosted-agent JSON-store pattern (atomic tmp + rename, 0600).
