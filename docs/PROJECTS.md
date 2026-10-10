# Projects — deploy a git repository that lives in aindrive

*Internal design note (see `docs/README.md`). Code: `src/projects.ts` (store, worker), `src/project-manifest.ts`
(`ainize.json`), `src/project-containers.ts` (service / Next.js), `src/project-agents.ts` (agent),
`src/project-routes.ts`. Tests: `test/projects.test.ts`, `test/projects-docker.test.ts`.*

## The product in one line

**Like Vercel — Next.js supported out of the box — but ALSO plain `script` runs and `agent` (A2A URL) deployments.**
Push to a repo in your aindrive drive; ainize builds it and gives it a URL.

## The one idea: ainize git = aindrive git

ainize keeps **no** git repositories for projects. The repository lives in an aindrive drive, at its friendly URL
`https://aindrive.ainetwork.ai/<org>/git/<repo>` (or `https://aindrive.ainetwork.ai/api/drives/<driveId>/git/<path>`),
with aindrive's history, permissions and UI. A **Project** on an ainize node binds to one such repo + branch
(default `main`). What a push means is said by the repository itself, in **`ainize.json`** at its root — the one
source of truth, like `vercel.json`. The owner is the signed-in account (AIN SSO, or the wallet / API-key sessions
the agent routes accept — `shared-agents.ts agentCallerOf`); only the owner reads or removes a project. The project's
page is `ainize.ai/projects/<id>` (`pageUrl`); its vanity URL mirrors the repo, `ainize.ai/<org>/<repo>` (`url`).

## `ainize.json`

JSON only (no YAML is read). Unknown keys are refused, so a typo cannot silently mean the default.

```json
{
  "name": "clef-artwork-search",
  "kind": "nextjs | service | script | agent",
  "runtime": "python3.11 | node20",
  "entry": "art_search.py",
  "env": { "KEY": "value" },
  "build": { "dockerfile": "Dockerfile", "context": "." },
  "port": 8080,
  "healthcheck": "/health",
  "timeoutMs": 120000,
  "agent": { "name": "Helper", "description": "…", "model": "Qwen3-8B", "a2ui": false }
}
```

| key | applies to | meaning |
|---|---|---|
| `name` | all | optional; defaults to the repo name |
| `kind` | all | `nextjs` is the **default** when the file is absent or has no `kind` and `package.json` depends on `next`. Otherwise a file with no `kind` is `script` when it names an `entry`, else an error |
| `runtime` | script | `python3.11` or `node20`; default by the entry's extension (`.py` → python, `.js`/`.mjs`/`.cjs` → node) |
| `entry` | script | the file to run. A project row's `entry` (given at creation) is the fallback |
| `env` | all | merged under the project's own env (`AINIZE_PROJECT`, `AINIZE_COMMIT`, …). **Never secrets** — the file is in the repo. ≤ 32 entries |
| `build.dockerfile`, `build.context` | service (nextjs when the repo has a Dockerfile) | paths inside the repo; defaults `Dockerfile`, `.` |
| `port` | service, nextjs | the container port the node exposes; default 8080 (service), 3000 (nextjs) |
| `healthcheck` | service, nextjs | a path polled until it answers 200, 120 s; default `/` |
| `timeoutMs` | script | 1 000–300 000; default 120 000 |
| `agent` | agent | laid over `agent.json`: `name`, `description`, `model`, `a2ui` |

**No `ainize.json` and no `next` dependency** → the deployment is `error` and its log says `no ainize.json`.

### Examples

A Next.js app needs nothing — `package.json` with `next` is enough. To change the port or the health path:
```json
{ "port": 4000, "healthcheck": "/api/health" }
```
A service from its own Dockerfile:
```json
{ "kind": "service", "port": 8080, "healthcheck": "/health", "build": { "dockerfile": "deploy/Dockerfile", "context": "." } }
```
A script run on every push:
```json
{ "kind": "script", "entry": "art_search.py", "env": { "TOP_K": "5" }, "timeoutMs": 60000 }
```
An agent (with `prompt.md` beside it; `agent.json` and `files/` optional, agent-git.ts layout):
```json
{ "kind": "agent", "agent": { "name": "Art Search", "description": "Finds artworks", "model": "Qwen3-8B" } }
```

## What each kind does on a push

| kind | build | run | `outputUrl` |
|---|---|---|---|
| `nextjs` | the repo's Dockerfile if it has one, else the node's (`node:20-alpine`, `npm ci --include=dev && npm run build`) | `npm start` (or `next start`) on `port`, same isolation as `service` | `${publicUrl}/svc/<projectId>/` |
| `service` | `docker build -t ainize-proj-<projectId>:<sha> -f <dockerfile> <context>` | a container on the hosted-agent `--internal` network, `--cap-drop ALL`, `no-new-privileges`, `--read-only` + tmpfs `/tmp`, memory/cpu/pid limits, gVisor when configured; egress only through the node's gateway (`HTTPS_PROXY`, `AINIZE_DECIDE_URL`, `AINIZE_CHAT_URL`, `AINIZE_API_URL` are set as for `/api/run`); `PORT`, `HOSTNAME=0.0.0.0` set | `${publicUrl}/svc/<projectId>/` — the node proxies `/svc/<projectId>/…` to the container (streams both ways, `X-Forwarded-Prefix`) |
| `script` | the tree as `/api/run` files (≤ 32 files, ≤ 2 MiB, `.git` skipped) | the entry once in the `/api/run` sandbox (in-process `RunSandbox` when Docker is on, else the HTTP contract); exit 0 → `ready`, else `error` with `exitCode` | `${publicUrl}/api/deployments/<id>/output` (stdout) |
| `agent` | a hosted-agent spec from `agent.json` + `prompt.md` + `files/`, with `ainize.json`'s `agent` block laid over | created or updated in the hosted-agent store under the stable id `prj-<org>-<repo>` and applied to the host — the same build/swap path every hosted agent has; the repository-side commit and registry event are written too | `${publicUrl}/agents/prj-<org>-<repo>` (A2A; card at `/.well-known/agent-card.json`) |

**Zero-downtime swap** (service, nextjs): the new container starts beside the old one; only once `healthcheck`
answers 200 does the node point `/svc/<id>/` at it and remove the old one (and its image). A build, start or
health failure removes the new container and leaves the old one serving; the deployment is `error`, the project's
previous `ready` is untouched. Agents get the same from the hosted-agent host (a failed build leaves the previous
version serving).

**Not honoured**: a Dockerfile in an `agent` repo. The hosted-agent runtime image *is* the A2A contract; a custom
image could not satisfy it. Use `kind: service` for a custom image.

## API

Errors are `{ error: { code, message } }`.

| | |
|---|---|
| `POST /api/projects` | signed in. Body `{ repo, branch?: "main", kind?, entry?, name?, deployToken? }` — `kind` and `entry` are hints only; the deployed kind is always the commit's `ainize.json`. 201 `{ id, org, repoName, repo, branch, kind, entry, name, status, url, pageUrl, hookUrl, webhookSecret, hasDeployToken, … }`. **`webhookSecret` is returned once**; sealed at rest, never read back. 400 bad URL, 409 `repo_taken` (one project per repo+branch per node). |
| `GET /api/projects` | the caller's projects. |
| `GET /api/projects/:id`, `DELETE /api/projects/:id` | owner only; anyone else sees 404. Delete removes deployments, logs and secrets (a running service container is stopped). |
| `GET /api/projects/by-repo?repo=<url>` | **no auth, CORS for `https://aindrive.ainetwork.ai`** — `{ id, org, repoName, repo, branch, kind, status, url, pageUrl, lastDeployment }`; no owner, no hook address. 404 when none. aindrive's "Inspect" links to `pageUrl`. |
| `POST /api/projects/:id/hook` | **the push webhook** (below). 202 `{ deploymentId, status: "queued" }`, or 202 `{ ignored: true, reason }` for another branch / a deleted branch. 401 `bad_signature`, 404 unknown project. |
| `GET /api/projects/:id/deployments` | newest first. |
| `GET /api/deployments/:id` | `{ id, projectId, sha, ref, kind, status: queued\|building\|ready\|error, pusher, startedAt, finishedAt, ms, exitCode?, error?, logUrl, outputUrl? }`. |
| `GET /api/deployments/:id/log` | `text/plain` once over; **SSE while queued/building** (`event: log` chunks, then `event: done` with the final deployment). `Accept: text/plain` forces text. Build output lines are prefixed `[build]`, the node's own `[ainize]`, a failed container's last lines `[run]`. |
| `GET /api/deployments/:id/output` | a script's stdout alone. |
| `ANY /svc/:projectId/*` | the running service/nextjs container (no auth — it is the deployed site). 404 when none runs, 502 when it does not answer. |

A project's `status` and `kind` are its newest deployment's (`idle` / `null` before the first push).

## The aindrive side

**Connect** (aindrive's git panel, "Connect to ainize"): aindrive opens
`${AINIZE_URL}/projects/new?repo=<cloneUrl>&driveId=<id>&returnTo=<drive page url>`. That page (ainize-web) for the
signed-in AIN SSO user (1) `POST /api/projects { repo, branch: "main" }`, (2) hands the one-time secret back by
POSTing `{ repo, projectId, webhookSecret }` to `https://aindrive.ainetwork.ai/api/drives/<driveId>/git-connect`
with the user's aindrive session (`credentials: include`), then (3) redirects to `returnTo`.

**On push.** After a successful `git-receive-pack`, aindrive POSTs one request per updated ref:

```
POST ${hookUrl}                       # https://ainize.ai/api/projects/<id>/hook
content-type: application/json
X-Ainize-Signature: sha256=<hex HMAC-SHA256 of the exact raw body, keyed with webhookSecret>

{ "ref": "refs/heads/main", "before": "<sha>", "after": "<sha>", "pusher": { "subject": "<AIN SSO sub>", "email": "a@b.c" } }
```

Anything but the project's branch, or an all-zero `after` (branch deleted), is `202 {ignored:true}`. The node answers
before cloning; status is read back by id.

**In the UI.** `GET /api/projects/by-repo?repo=<friendly URL>` from the browser (origin
`https://aindrive.ainetwork.ai` gets `Access-Control-Allow-Origin`) gives `status`, `pageUrl` and `lastDeployment`
(`sha`, `status`, `kind`, `ms`, `logUrl`, `outputUrl`). The log endpoint needs the owner's ainize session: link to
`pageUrl` rather than fetching it cross-origin.

## How the node reads the repository

The repo is behind aindrive auth (viewer+). There is **no machine-to-machine path yet** from this node's AIN SSO app
credentials to an aindrive read token (ainize-node talks to `auth.comcom.ai` only to verify ID tokens and sessions;
aindrive accepts `Authorization: Bearer <session JWT | aind_aat_… account token>`). So, for now:

* The owner may give a **deploy token** at creation (`deployToken`: an aindrive session JWT, or better an
  `aind_aat_…` account token scoped `drives:read`). It is sealed with the hosted-agent secret store
  (`<dataDir>/project-secrets.json`, key `hosted-agent-secrets.key`), write-only over HTTP, handed to git through
  `GIT_CONFIG_*` environment entries (`http.extraHeader`) — never on the command line — and scrubbed from git's
  error text before it reaches a log. A public repo needs none.
* Limitation: a session JWT expires; then every deployment fails with `git clone failed: … 401` until the project is
  re-created with a fresh token (no update endpoint yet — add `PATCH /api/projects/:id {deployToken}` when
  aindrive's token lifetimes are settled). `TODO(projects-sso)` in `ProjectWorker.clone` marks where an
  SSO-minted token goes once aindrive accepts one.

Clone is `git clone --depth 1 --branch <branch> <repo>` into a temp dir; when the tip has moved past the pushed `sha`
(a later push queued behind this one), the commit is fetched by id, or the clone deepened when the server will not
serve a bare sha; then `git checkout --detach <sha>`. The temp dir is removed after the deploy.

## The worker

One `ProjectWorker` per node: a FIFO per project (pushes to one project deploy in order), at most **2 building
node-wide**. Logs are `<dataDir>/projects/logs/<deploymentId>.log` (and `.out`, a script's stdout); the **last 20
deployments per project** are kept, older records and logs removed together. Persistence is `<dataDir>/projects.json`
(the hosted-agent JSON-store pattern: atomic tmp + rename, 0600). At start, deployments left `queued`/`building` are
re-queued, leftover `ainize-proj-*` containers (their gateway tokens died with the old process) are removed, and the
newest `ready` service/nextjs deployment of each project is deployed again from its commit so the service comes back.
Containers need `agentHost.docker.enabled` (the same switch as code agents and `/api/run`); without it those kinds
end in `error` saying so, while `script` falls back to the `/api/run` HTTP contract and `agent` prompt-mode agents
need no Docker at all.
