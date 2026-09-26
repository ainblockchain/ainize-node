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

The node writes three files into `AINIZE_HOME`: `hosted-agents.json`, `hosted-agent-secrets.json` and
`hosted-agent-secrets.key`. **Back up the key with the data**: without it the stored secrets cannot be decrypted.

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

## Rollback

| what | how |
| --- | --- |
| code agents only | remove `agentHost.docker`, restart, `docker ps -aq --filter label=ainize.hosted-agent \| xargs -r docker rm -f` |
| the node | check out `3bff8fc` (main before hosted agents), `npm ci && npm run build`, restart; older builds ignore the `hosted-agent*` files |
| web | ainize-web `deploy/README.md`, Rollback |
