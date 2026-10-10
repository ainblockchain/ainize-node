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
the agent routes accept — `shared-agents.ts agentCallerOf`); the owner alone removes a project or rotates its secret.
The project's page is **`ainize.ai/<org>/<repo>`** (`pageUrl`, also `url`) — the GitHub-shaped address that mirrors the
repository's own `aindrive.ainetwork.ai/<org>/git/<repo>`; `ainize.ai/<org>` lists the organization's repositories.
`/projects/<id>` still resolves (the web app forwards it to the pretty URL).

## Who sees what

A project is an organization's repository, and it reads like one. `GET /by-repo` had always answered anyone with the
status and the newest deployment (aindrive's UI shows it next to the repo), so the page's own reads follow the same
rule rather than a stricter one that would only have moved the same facts one click away:

| | anyone | owner | owner or a member of the repo's organization |
|---|---|---|---|
| project (`GET /:id`, `/by-name`, `/by-repo`, `/api/orgs/:org/projects`), deployments, runs, a deployment's log and output | yes — public fields: repo, branch, kind, status, `url`/`pageUrl`, the newest deployment, the `manifest` the last deploy read, `runnable` files | also `owner`, `hookUrl` | |
| `DELETE /:id`, `PATCH /:id/rotate-secret` | | yes (anyone else: 404) | |
| `POST /:id/runs`, `POST /api/deployments/:id/redeploy` | 401 | | yes (others: 403 `not_member`) — they run with the caller's own key |

Never on the wire: the webhook secret (shown once at creation and at rotation), the deploy token, the clone credentials.
Deployment logs are build and run output of a repository that is itself readable by the organization; a program that
prints a secret to stdout has published it either way, as it would on any CI. `canManage` / `canOperate` on a project
view tell a page which of these the caller may do without a second round trip. Membership of "the repo's organization"
is the node's SSO memberships under the slug (`store.ssoOrgIdsBySlug`); a node without AIN SSO knows no members, so
only the owner may run and redeploy there.

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
| `inputs` | all (used by `script` runs) | parameters a person fills in before a run — **the same shape as GitHub Actions `workflow_dispatch` inputs**: `{ "<name>": { description?, type: string\|choice\|boolean\|number (default string), required?, default?, options? (choice) } }`, delivered to the program as **`INPUT_<NAME>`** environment variables (name upper-cased; booleans `true`/`false`, numbers as decimal text). aindrive's Run panel renders one field per input (prefilled with `default`, remembered per repo) and sends the answers as `env`; a push-deploy uses each `default`. Names `^[A-Za-z_][A-Za-z0-9_]*$`, ≤ 16 inputs, values ≤ 2 KiB |
| `examples` | script: named presets of `inputs` — `[{ name, description?, inputs: { <name>: value } }]`, ≤ 16 — the Run panel's one-click rows ("노을 바다 유화", "인물 초상", …). An example that answers an input the manifest does not declare fails the deploy with a clear message. |
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
| `service` | `docker build -t ainize-proj-<projectId>:<sha> -f <dockerfile> <context>` | a container on the hosted-agent `--internal` network, `--cap-drop ALL`, `no-new-privileges`, `--read-only` + tmpfs `/tmp`, memory/cpu/pid limits, gVisor when configured; egress only through the node's gateway (`HTTPS_PROXY`, `AINIZE_URL` and the pusher's `AINIZE_API_KEY` are set as for `/api/run`); `PORT`, `HOSTNAME=0.0.0.0` set | `${publicUrl}/svc/<projectId>/` — the node proxies `/svc/<projectId>/…` to the container (streams both ways, `X-Forwarded-Prefix`) |
| `script` | the tree as `/api/run` files (≤ 32 files, ≤ 2 MiB, `.git` skipped) | the entry once in the `/api/run` sandbox (in-process `RunSandbox` when Docker is on, else the HTTP contract); the python image has the `ainize` SDK and the run gets `AINIZE_URL` + `AINIZE_API_KEY` — the **pusher's own** `aindrive run` key, resolved from the hook's `pusher.subject` (src/run-actor.ts; absent when the hook names nobody or AIN SSO is off) — so `ainize.connect(os.environ["AINIZE_URL"], api_key=os.environ["AINIZE_API_KEY"]).decide(...)` needs no secret in the repo and bills the pusher (deploy/run-runtime/README.md); exit 0 → `ready`, else `error` with `exitCode` | `${publicUrl}/api/deployments/<id>/output` (stdout) |
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
| `GET /api/projects/:id` | public view (above); the owner also gets `owner`, `hookUrl`. 404 when there is no such project. |
| `DELETE /api/projects/:id` | owner only; anyone else sees 404. Removes deployments, runs, logs and secrets (a running service container is stopped). |
| `PATCH /api/projects/:id/rotate-secret` | owner only. `{ id, webhookSecret, hookUrl }` — the new secret once; the old one stops verifying at once. |
| `GET /api/projects/by-repo?repo=<url>` | **no auth, CORS for `https://aindrive.ainetwork.ai`** — the public view, `pageUrl` = `/<org>/<repo>`. 404 when none. aindrive's "Inspect" links to `pageUrl`. |
| `GET /api/projects/by-name?org=<org>&repo=<repo>` | **no auth, CORS** — the project at `/<org>/<repo>`, both matched case-insensitively (the newest when two branches of one repo are bound). 404 `not_found`. The page's own lookup. |
| `GET /api/orgs/:org/projects` | **no auth, CORS** — `{ org, projects }`, every project of the slug, case-insensitive. An organization with none is an empty list; only a malformed slug is 404. |
| `GET /api/orgs/:org/repositories` | **no auth** — the drive's `repositories/` as aindrive lists it (`GET <aindrive>/api/orgs/<org>/repositories`, called with this node's machine token, cached 30 s): `{ org, known, driveId, driveUrl, repositories: [{ name, cloneUrl, headSha, headSubject, updatedAt, hasManifest }] }`. The `/<org>` page merges it with the projects so a repo shows before its first push ("not deployed yet · push to deploy"). 503 `aindrive_off` without a machine identity (`AIN_SSO_CLIENT_SECRET`); aindrive's origin is `AINDRIVE_URL` (default `https://aindrive.ainetwork.ai`). |
| `GET /api/projects/:id/runs`, `POST /api/projects/:id/runs` | the console's **Run panel** (script projects). POST — owner or org member — `{ entry?, inputs?, env?, timeoutMs? }` clones the branch's HEAD like a deploy and runs it with the caller's own `aindrive run` key; `entry` defaults to the manifest's, `inputs` answer `ainize.json` `inputs` (`INPUT_<NAME>`), `env` adds plain variables. 202 `{ runId, deploymentId, status }`; the log streams at `GET /api/deployments/<runId>/log`. A run is a deployment-shaped record with `trigger: "run"` that never becomes the project's status. 409 `not_a_script` for other kinds. |
| `POST /api/deployments/:id/redeploy` | owner or org member — the same sha and ref as a new deployment (`trigger: "redeploy"`): Redeploy, and for a service/nextjs the way to roll back to an earlier commit. 202 `{ deploymentId, status }`. |
| `POST /api/projects/:id/hook` | **the push webhook** (below). 202 `{ deploymentId, status: "queued" }`, or 202 `{ ignored: true, reason }` for another branch / a deleted branch. 401 `bad_signature`, 404 unknown project. |
| `GET /api/projects/:id/deployments` | newest first — pushes and redeploys; runs are under `/runs`. Each carries `trigger`, the commit `subject`, and `manifest`/`runnable` snapshots are summarized on the project. |
| `POST /api/projects/:id/run` | **link snippets**: the deployed commit of a `script` project run again, for the viewer, with `{ env?: { INPUT_<NAME>: value } }` over the manifest's defaults; `text/event-stream` like `/api/run`. Viewer+. 409 `no_deployment` / `not_a_script`. |
| `POST /api/projects/:id/redeploy` | **link snippets**: the owner deploys the newest commit again. 202 `{ deploymentId, status: "queued" }`; 403 for a member. |
| `GET /api/ainui/snippet?url=<pasted URL>` | **link snippets**: the project's AIN-UI snippet (`application/vnd.ain.ui+json`) for the viewer; 403 with a sign-in surface, 404 unknown. |
| `GET /api/deployments/:id` | `{ id, projectId, sha, ref, kind, status: queued\|building\|ready\|error, pusher, startedAt, finishedAt, ms, exitCode?, error?, logUrl, outputUrl? }`. |
| `GET /api/deployments/:id/log` | `text/plain` once over; **SSE while queued/building** (`event: log` chunks, then `event: done` with the final deployment). `Accept: text/plain` forces text. Build output lines are prefixed `[build]`, the node's own `[ainize]`, a failed container's last lines `[run]`. |
| `GET /api/deployments/:id/output` | a script's stdout alone. |
| `ANY /svc/:projectId/*` | the running service/nextjs container (no auth — it is the deployed site). 404 when none runs, 502 when it does not answer. |

A project's `status` and `kind` are its newest deployment's (`idle` / `null` before the first push).

## The aindrive side

**Auto-binding — "ainize.json이 있다는 건 자동 배포가 되었다는 것".** There is no "Connect to ainize" step. After a
successful `git-receive-pack` of a repo whose root has `ainize.json` and that aindrive has not bound yet, aindrive
itself (an AIN SSO machine token for this node: `client_credentials`, `aud` = the node's public URL, `sub` = `azp` =
`aindrive`; AIN SSO architecture §4.9) calls

```
POST /api/projects/auto                    Authorization: Bearer <at+jwt>
{ "repo": "https://aindrive.ainetwork.ai/<org>/git/<repo>", "branch": "main",
  "pusher": { "subject": "<AIN SSO sub>", "email": "a@b.c" }, "manifest": { "kind": "script", "name": "…" } }
```

- no project bound to `repo` → **201** `{ id, pageUrl, webhookSecret, created: true }` — the secret once; aindrive
  stores it beside the repo and fires the hook below for the same push;
- a project exists → **200** `{ id, pageUrl, created: false }` (no secret; a different branch is 409 `repo_taken`);
- the token must name, in `orgs`, an AIN organization this node knows under the URL's `<org>` slug (from provisioned
  memberships) — else 403 `org_not_allowed`. The drive-id URL form (`/api/drives/<id>/git/…`) names no organization
  and cannot auto-bind; a bad or missing machine token is 401; a node without `AIN_SSO_SERVICE_APPS` answers 503.
- the owner is the pusher's principal here (`sso:<sub>`, or the legacy principal they were linked to); without a
  pusher subject, the organization itself, `org:<orgId>` (nobody signs in as it; the project is read through
  `by-repo` and the deployment log links).

Node configuration: `AIN_SSO_SERVICE_APPS=aindrive` (with `AIN_SSO_ISSUER` / `AIN_SSO_CLIENT_ID`; `docs/ain-sso.md` §5).
AIN SSO must list the node's public URL in `AIN_SSO_SERVICE_RESOURCES`. `POST /api/projects` (signed in) and
aindrive's `git-connect` remain for repositories hosted elsewhere or projects made by hand.

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
(`sha`, `status`, `kind`, `ms`, `logUrl`, `outputUrl`). Link to `pageUrl` (`https://ainize.ai/<org>/<repo>`) for the
full console — deployments, runs, logs, settings.

## How the node reads the repository

The repo is behind aindrive auth (viewer+). The node reads it **as itself**, with its AIN SSO machine identity:

* With `AIN_SSO_CLIENT_SECRET` set (next to `AIN_SSO_ISSUER` and `AIN_SSO_CLIENT_ID`, `docs/ain-sso.md` §5), the
  worker asks AIN SSO for an OAuth 2.0 **`client_credentials`** token naming the repository's host as the resource
  (`resource=<origin of the repo URL>`, e.g. `https://aindrive.ainetwork.ai`; `src/sso-service-token.ts`). AIN SSO
  answers with a 5-minute RFC 9068 JWT (`aud` = that host, `sub` = `azp` = `ainize`, `orgs` = the organizations the
  ainize app is assigned in). aindrive verifies it against AIN SSO's JWKS and, when `ainize` is in its
  `AINDRIVE_SSO_SERVICE_APPS`, treats the node as a **viewer on the drives shared with one of those organizations**
  — clone and fetch work, a push is refused, `.aindrive/` stays out of reach, and aindrive logs every read
  (aindrive `web/lib/sso/service-principal.ts`). The token is cached per host until shortly before it expires and
  shared by every project on the node; the next deployment after an expiry asks again.
* The owner may still give a **deploy token** at creation (`deployToken`: an aindrive session JWT, or an
  `aind_aat_…` account token scoped `drives:read`). When present it **overrides** the machine identity for that
  project — for a drive that is not org-shared, or a node without SSO credentials. It is sealed with the
  hosted-agent secret store (`<dataDir>/project-secrets.json`, key `hosted-agent-secrets.key`), write-only over
  HTTP. A session JWT expires; the project must then be re-created with a fresh token (no update endpoint yet).
* Without either, the clone is anonymous (a public repo).

Either bearer is handed to git through `GIT_CONFIG_*` environment entries (`http.extraHeader`) — never on the
command line — and scrubbed from git's error text before it reaches a log. The deployment log says which
credential the clone used (`clone as this node …`, `clone with the project's deploy token`, `clone anonymously`);
when AIN SSO refuses a token (the app not registered for the grant, the host not in AIN SSO's
`AIN_SSO_SERVICE_RESOURCES`) the node logs the refusal and clones anonymously, so a private repo fails with
aindrive's 401 in the deployment log.

Set-up on the AIN side, once: AIN SSO lists aindrive's public URL in `AIN_SSO_SERVICE_RESOURCES`, the `ainize`
application is **assigned** to the organization whose drives hold the repositories (that is what puts the org in the
token), and aindrive lists `ainize` in `AINDRIVE_SSO_SERVICE_APPS`. The repository's drive must be shared with that
organization (aindrive `docs/PERMISSIONS.md` "Organizations").

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

## Link snippets (AIN-UI)

*The contract is aindrive's `docs/AINUI-LINK-SNIPPETS.md`; this is the ainize half. Code: `src/ainui-snippet.ts`
(pure builders), `src/project-routes.ts` (the four doors), ainize-web `middleware.ts` (negotiation). Tests:
`test/ainui-snippet.test.ts`.*

When `https://ainize.ai/<org>/<repo>` or `https://ainize.ai/projects/<id>` is pasted into a chat (AIN Teams), the
consumer asks **that URL** with `Accept: application/vnd.ain.ui+json` and the two identity headers it already uses
for runs — `Authorization: Bearer <its AIN SSO client_credentials token, aud = https://ainize.ai>` and
`X-AIN-Actor: <the viewer's AIN SSO subject>`. ainize-web's middleware relays such a request to the node's
`GET /api/ainui/snippet?url=…`; a request without that media type is the page as before. The node verifies the
application (`verifyServiceToken`, `AIN_SSO_SERVICE_APPS` must list it, e.g. `ainteams`) and answers **for the
person**: owner, or an active member of an AIN organization this node knows under the project's `<org>` slug
(`store.ssoMemberships`). A session of this node is a viewer too.

The answer is `{ ainui: 1, kind: "ainize.project", title, subtitle, icon, url, surface, actions, refresh }`:

* `surface` — A2UI v0.9 messages (basic catalog; only Column/Row/Card/Text/Divider/TextField/Button, the
  vocabulary hosted agents already emit): `header`, the `deployments` card (newest three: `● ready|building|error`,
  short sha, when, `Inspect` → the project page, `Visit` → `outputUrl`), the `run` card for a `script` project
  (one `TextField` per `ainize.json` input, bound to `/inputs/<NAME>`, prefilled with `default`; `run.output` /
  `run.status` bound to `/run/*`), and `links` (`Open on ainize`, `Repository`, and `Redeploy` for the owner).
* `actions` — what each button does: `run` = `POST /api/projects/<id>/run` with `{ env: {$context} }` (the
  resolved button context, keys `INPUT_<NAME>`), streaming SSE the consumer appends into `/run/output`;
  `redeploy` = `POST /api/projects/<id>/redeploy`; `open:*` = navigation. Actions carry the same two headers and
  re-check access on every call.
* 403: the same envelope with `kind: "denied"`, one sentence and a link; 404 for an unknown project.

To draw the Run form without a clone, a deployment records the commit's `ainize.json` `entry` and `inputs`
(`Deployment.manifest`); the run endpoint checks the deployed commit out again (`ProjectWorker.checkout`) and runs
it through the same `RunScript` the worker deploys with, the person's `aindrive run` key in `AINIZE_API_KEY`
(`RunKeyIssuer.keyFor`). Nothing secret is in a snippet: no webhook secret, no deploy token, no key, no manifest
`env` values.
