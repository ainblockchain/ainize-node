# Hosted agents — enabling them on a node

A node can run A2A agents built on the chat models it serves (`POST /api/hosted-agents`; design:
`docs/superpowers/specs/2026-09-26-hosted-agents-design.md`). How ainize.ai's own machine does it (a CLI-run node,
the news-review migration): `docs/deployment-runbook.md` §3.4–3.6.

There are two kinds, and they need different things from the host:

| mode | runs | host needs |
| --- | --- | --- |
| `prompt` | in the node process | a chat model in `backends` — nothing else |
| `tools`, `handler` | one Docker container per agent | Docker access for the node's user, `agentHost.docker.enabled`, gVisor recommended |

Without `agentHost.docker`, code modes answer `501 docker_unavailable` and the web form disables them; prompt agents
keep working.

### Speech and images (optional, per agent)

An agent's owner can turn on `media.transcription` and `media.image` (web form, or `PUT /api/hosted-agents/<id>`
with `"media": {"transcription": true, "image": true}`). The model does not have to be on this node: a node with
no backend of that modality uses a **peer** that serves one (models over p2p, below). The API refuses to turn one on
only when neither this node nor any peer in reach serves it.

### Models over p2p

A node gossips the speech and image models in its `backends` (kind and model ids — never the upstream URL), and
serves them to peers at `POST /p2p/models/{transcription|image}`. The caller signs `p2p-model:<provider>/<modality>:<ts>`
with its node key (`x-ainize-auth`, 5-minute window); the provider queues the call in the same per-GPU gate as `/v1`,
charged to the calling node's address, at most 60 calls a minute per node. `GET /api/network/models` lists this
node's models and each fresh peer's. To keep your models to yourself: `"peerModels": { "serve": false }` in
`config.json` — the node then stops advertising and refuses peer calls.

- **transcription** — audio attached to a message (`audio/*`, inline or as a link from an `allowedHosts` host) is
  transcribed before the model sees the turn; the model reads the transcript. Inline audio is limited by the
  200 KB A2A request cap, so voice notes usually arrive as links.
- **image** — the model gets a built-in `generate_image` tool; the picture comes back as a `image/png` file part of
  the reply (A2A v0.3 `kind: "file"`, v1.0 `raw` part). Steps are capped at 30 per call.

Both go through the agent gateway — to this node's first backend of the modality, queued in the same per-GPU gate as
`/v1` and the free tier and attributed to the agent's owner, or else to the freshest peer that serves it. The card advertises `audio/*` input and `image/png` output only
when they are on; an agent that uses neither has the same card as before.

## 1. Update the node

Hosted agents shipped in `a205c88` without a version bump, so `/api/info` keeps reporting `0.4.2` — check for
`/api/hosted-agents` instead.

```
git fetch origin && git checkout main && git pull --ff-only
npm ci && npm run build          # @a2a-js/sdk is a new dependency
# restart the node the way this host runs it
curl -s localhost:<port>/api/hosted-agents               # {"agents":[]}
curl -s localhost:<port>/api/models/<chat model id>      # {..., "agents": 0}
```

A node installed from npm needs a published `@ainize/node` that contains this change (0.4.3 or later).

The node writes four files into its data directory (`AINIZE_HOME/data`): `hosted-agents.json`,
`hosted-agent-secrets.json`, `hosted-agent-secrets.key` and `hosted-agent-tasks.sqlite` (the prompt agents' A2A
tasks, kept 7 days, so `tasks/get` still answers after a restart, a rollback or a restore; a task that was running
when the node stopped reads back as `failed` with a message saying it was interrupted). **Back up the key with the
data**: without it the stored secrets cannot be decrypted. A node started with the data but without its key (or with
the key of another backup) still starts, logs an error, keeps the sealed file aside as
`hosted-agent-secrets.json.unreadable-<time>`, drops the values it cannot open and re-issues each agent's PoP key (a
new release); to get the values back, stop it and restore `hosted-agent-secrets.key` and `hosted-agents.json` from the
backup that copy belongs to, with the copy as `hosted-agent-secrets.json`. Copy the SQLite files with the SQLite backup API
(`sqlite3 hosted-agent-tasks.sqlite ".backup <dest>"`), not `cp`, while the node runs.

The web side needs no configuration: deploy ainize-web as usual (ainize-web `deploy/README.md`).

## 2. Code agents (optional)

### Why gVisor

Anyone signed in with a wallet can upload code, and it runs on this host. The node already runs each container with
`--cap-drop ALL`, `--read-only`, `no-new-privileges`, memory/CPU/pids limits and an `--internal` network. Under the
default runtime (runc) the container still shares the host kernel, so one kernel exploit would expose the node's key,
wallet and other agents' secrets. gVisor (`runsc`) is an alternative OCI runtime for the **same** containers: it puts
a user-space kernel between the agent and the host. Images, network, limits and lifecycle do not change; one config
line switches it on or off.

### Steps

```
sudo usermod -aG docker <node user>          # log in again; `docker ps` must work without sudo

# gVisor — https://gvisor.dev/docs/user_guide/install/
sudo apt-get update && sudo apt-get install -y apt-transport-https ca-certificates curl gnupg
curl -fsSL https://gvisor.dev/archive.key | sudo gpg --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" | sudo tee /etc/apt/sources.list.d/gvisor.list > /dev/null
sudo apt-get update && sudo apt-get install -y runsc
sudo runsc install
sudo systemctl reload docker
docker run --rm --runtime=runsc hello-world
```

Then add to `config.json` and restart the node:

```json
"agentHost": { "docker": { "enabled": true, "runtime": "runsc" } }
```

| key | default | meaning |
| --- | --- | --- |
| `agentHost.perOwner` | 5 | agents per wallet |
| `agentHost.total` | 200 | agents per node |
| `agentHost.docker.runtime` | unset (runc, logged as a warning) | OCI runtime for agent containers |
| `agentHost.docker.memory` / `cpus` / `pidsLimit` | `512m` / 1 / 256 | per-container limits |
| `agentHost.docker.idleStopMs` | 600000 | stop a container after this long without a call |
| `agentHost.docker.maxRunning` | 20 | containers running at once (least recently used stopped first) |
| `agentHost.docker.network` | `ainize-hosted-agents` | created `--internal` by the node |

The first code agent builds the runtime image (`ainize/hosted-agent-runtime:<hash>`) from `node:24-slim` and npm, so
the host needs internet access for builds. Agent containers never do: they reach the model and allowlisted public
hosts only through the node's gateway on the bridge address.

`@ainize/core` logs `agentHost: unknown config key` until core learns the key; it is harmless.

The Docker integration test (`test/hosted-agents-docker.test.ts`) runs under the default runtime. After switching to
`runsc`, check the code-agent items below by hand.

## 3. Check

- `/models/<id>` shows **Create agent based on this model**; a prompt agent created there answers in its Live test.
- The agent appears in `/explore?kind=agent` and on its model's page; its page links back to the model.
- `curl -s <public url>/agents/<id>/.well-known/agent-card.json`: `supportedInterfaces[].url` is the public address.
- Code agents: the handler template builds and its Live test draws the A2UI score card;
  `docker inspect ainize-hosted-<id> --format '{{.HostConfig.Runtime}}'` prints `runsc`; `fetch('http://localhost:9/')`
  from agent code is refused.
- Another wallet sees no Edit/Delete on the agent, and `/api/hosted-agents/<id>` answers 403.

## 4. Moving a `config.json` agent onto hosting

A hosted agent cannot take an id that is a `config.json` agent on the **same** node (409). An agent with the same id
on a peer is not blocked: this node's own agent wins `/agents/<id>` here, and both rows are listed until the peer's
registration is removed. So:

1. Deploy the hosted version (news-review: ainize `news-agent/README.md`, "Run it on an Ainize node").
2. Check it in its Live test.
3. Remove the old registration where it lives (`ainize agent rm <id>`, restart that node) and stop the old process.

## 5. Sharing: who sees which agent (an organization's list)

Every agent the node lists — hosted, linked (`/api/linked-agents`) or a `config.json` agent — has a **visibility**:
`public` (listed to everyone, advertised to peers), `org` (listed to members of one organization), `private`
(the owner's alone) or `unlisted` (answers by id, listed to nobody). Visibility is about *listing*: the A2A address
`/agents/<id>` answers to anyone who holds it either way. Only `public` agents reach `/api/agents` and gossip.

- **`/api/shared-agents?scope=shared_with_org`** is the organization's list — what AIN Teams imports. It needs an AIN
  SSO session of a member, or an **organization API key** (`POST /api/keys {"org_id": …}` by a member, sent as
  `Authorization: Bearer ainize-sk-…`). Give AIN Teams one such key (`AINIZE_API_KEY`) and it reads, and registers
  into, that organization's list with no browser session.
- **Who can own one.** A wallet session, an AIN SSO session, or a Google account ainize.ai signed in — the site vouches
  for it with the signed `x-ainize-site-subject` header (`src/site-assertion.ts`, the secret in
  `<AINIZE_HOME>/site-assertion.secret`), and it owns agents as `google:<sub>`. It belongs to no AIN SSO organization;
  an ainize organization can still add it as an explicit member. `/api/auth/me` reports it under `site`.
- **What `orgId` names.** An ainize organization (`/api/orgs`, docs/superpowers/specs/2026-09-29-organizations-design.md)
  or an AIN SSO org id (`org_…`). An AIN SSO org id that an ainize organization links (`ssoOrgIds`) belongs to that
  organization: its members, roles and audit log apply. One no ainize organization links keeps the plain rule —
  an AIN SSO member of it, or its organization API key, counts as `write`.
- **Roles decide what a member may do** (`read` < `contributor` < `write` < `admin`):

  | | owner | admin | write | contributor | read |
  |---|---|---|---|---|---|
  | see it (listed, by id, `/api/agents?org=`) | ✓ | ✓ | ✓ | ✓ | ✓ |
  | share an agent into the organization | — | ✓ | ✓ | ✓ | — |
  | hosted: whole spec, change prompt/code, secrets, logs | ✓ | ✓ | ✓ | — | — |
  | linked: change where it points (upstream) | ✓ | — | — | — | — |
  | remove it, change its `visibility`/`orgId` | ✓ | ✓ | — | — | — |

  An organization API key is `write` in the organization its AIN org id belongs to. `GET /api/hosted-agents?manageable=1`
  lists what a caller may change, with `can_manage` / `can_delete`; each change records `updated_by` and lands in the
  organization's audit log (`agent.create`, `agent.update`, `agent.sharing`, `agent.secret` — the name only,
  `agent.delete`). An agent the caller cannot see answers 404, one they see but may not change 403.
- **`/api/shared-agents?scope=shared_with_org&org=<id>`** matches `orgId` exactly (contract 1.0: `orgRef.subject` is the
  `orgId`), so an AIN Teams workspace keeps using the AIN SSO org id it always did.
- **You, the operator**, may put *any* hosted or linked agent into *any* organization's list, or take it out:

  ```
  curl -X PUT <public url>/api/shared-agents/<id>/visibility -H 'content-type: application/json' \
       -b "ainize_session=<your session>" -d '{"visibility":"org","orgId":"<org id>"}'
  ```

  Ownership does not change; the change is a new release and appears in `/api/shared-agents/events`.
- **`config.json` agents** take the same two fields in the file — `agents[].visibility`, `agents[].orgId` — and a
  restart; the route refuses them and names the field, so the file stays the operator's record.

Check: `curl -s '<public url>/api/shared-agents?scope=public'` no longer lists an agent you moved to `org`;
`curl -s -H 'Authorization: Bearer <org key>' '<public url>/api/shared-agents?scope=shared_with_org'` does.

## Rollback

| what | how |
| --- | --- |
| code agents only | remove `agentHost.docker`, restart, `docker ps -aq --filter label=ainize.hosted-agent \| xargs -r docker rm -f` |
| the node | check out `3bff8fc` (main before hosted agents), `npm ci && npm run build`, restart; older builds ignore the `hosted-agent*` files |
| web | ainize-web `deploy/README.md`, Rollback |

### Files from aindrive (receiver contract)

Prompt and tools agents read everything aindrive sends, not only the first text part
(`src/hosted-agent-runtime/hostedAgentAindriveHandoff.ts`):

- **text parts** — the question and a current-folder snapshot in words;
- **file parts** — handoff links (`/api/h/<id>?k=…`), opened with `read_attachment` only when the model asks.
  Pictures are shown to the model (it must be multimodal, e.g. Qwen3.8-Flash-Next); PDFs are read as text, and a
  scanned PDF's first 3 pages are shown as pictures (`unpdf` + `@napi-rs/canvas`); files up to 32 MB;
  404 / 410 / 503 / 429 are reported as "not found", "expired or revoked — ask for a fresh handoff",
  "the sender's device is offline", "rate-limited";
- **`ai.aindrive/folder-context`** data part — the folder's direct children, shown to the model as data that is
  NOT a read grant;
- **`ai.aindrive/handoff-mcp`** data part — an MCP server (streamable HTTP, `/mcp/h/<grant>`) over the granted
  files, offered for that turn only as `list_files` and `read_file({ id })`. A `read_file` answer that carries an
  `image` or a `resource` blob (picture or PDF) is shown or read, not dropped. Its `Authorization` header is sent
  to that server and nowhere else: not to the model, not to logs, not to conversation memory. Expired grants are
  refused before any request.

The agent's `allowedHosts` must include aindrive's host (`aindrive.ainetwork.ai`) for links and the MCP server.
