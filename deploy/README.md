# deploy/

## Local AIN blockchain (`ain` ledger mode)

```
docker compose -f deploy/docker-compose.ain.yml up -d     # or: ainize chain up
curl -s localhost:8081/node_status | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"]["state"])'   # SERVING
ainize chain setup                                          # registers /apps/knowledge (ain-js) + market rules, funds the node identity
```

- JSON-RPC: `http://localhost:8081` · event handler: `ws://localhost:5101`
- Genesis validator `0x00ADEc28B6a845a085e03591bE7550dd68673C1C` holds the test supply; `ainize chain fund <address> [amount]` transfers from it (local chain only).
- Chain data lives inside the container; `ainize chain down` discards it.

## Multi-node marketplace demo (local ledger, one machine)

```
ainize init --name alice --port 3402 --password "<operator password>" && ainize start -d && ainize login && ainize seed   # real knowledge only; add --synthetic only for test fixtures
NGRAM_HOME=~/.ngram-b ainize init --name bob   --port 3403 --peer http://localhost:3402 --roles verifier          --password "<…>" && NGRAM_HOME=~/.ngram-b ainize start -d
NGRAM_HOME=~/.ngram-c ainize init --name carol --port 3404 --peer http://localhost:3402 --roles verifier,serving  --password "<…>" && NGRAM_HOME=~/.ngram-c ainize start -d
ainize patch ls          # bob & carol attest → quorum 2 → LISTED
```

Every node here binds `127.0.0.1` — the default since the takeover described below.

## Claiming a node (do this before it listens on anything but loopback)

A node with no operator password is **unclaimed**: `POST /api/auth/setup` hands a full operator session to whoever
asks first, and that session can announce, buy, subscribe, spend the wallet, change `payout_address` and approve teach
lessons under the node's identity. There is no way to take it back.

Three things now stand between a fresh node and a stranger:

- **`host` defaults to `127.0.0.1`.** Going public is a decision: `ainize init --host 0.0.0.0` (or `--public`), or
  `ainize config set host 0.0.0.0`. The start-up banner prints the address it actually bound.
- **`ainize init --password …`** (or `NGRAM_PASSWORD`, or the prompt an interactive terminal gets) claims the node in
  config.json before it ever listens. `--no-password` leaves it unclaimed on purpose.
- **Claiming is loopback-only.** From another machine, `POST /api/auth/setup` is refused unless the request carries the
  one-time token the node writes to `NGRAM_HOME/setup-token` (readable only by the user the node runs as):
  `ainize login --node http://host:3402 --setup-token "$(ssh host cat ~/.ngram/setup-token)"`. The token is deleted by
  the claim. An unauthenticated `GET /api/auth/me` no longer advertises `needsSetup` to callers that could not claim it.

Forgotten the password? `ainize stop && ainize password --reset` writes a new hash into config.json — being able to
write that file is the same proof of ownership as holding the node's private key, which lives in it. On a running node,
`ainize password` changes it and signs every other session out.

## Disk

A verifier downloads every announced body over P2P and keeps it. Nothing reported those bytes before:

```
ainize status            # disk 1.1 GB (bodies 932 MB · sets 0 B · uploads 115 MB · db 9 MB) · 12 GB free
ainize blobs ls          # every file, its size, and why this node has it
ainize gc --dry-run      # what could go: bodies neither published here nor bought, that a peer still holds
ainize gc --older-than 30d
```

`events.retentionDays` (default 90) is how long raw event rows are kept; `start -d` rolls `node.log` at 32 MB and keeps
two generations. The node also logs a warning once an hour while the volume holding `dataDir` is below 5% or 2 GB free.

## Peering across ledgers

A node started with `--ledger local` and pointed at a marketplace running on the AIN chain answers every health check
green and shows an empty catalogue forever: record sync only happens between nodes on the same ledger. `ainize status`,
`ainize nodes`, `ainize peers ls` and the Network page now name every peer whose ledger this node cannot read, and
`peers add` / `init --peer` say so at the moment the peer is added:

```
! node-a (http://localhost:3402) publishes on the AIN ledger; this node reads the local record DAG.
    trade with it directly:  ainize patch ls --node http://localhost:3402
    or move this node over:  ainize init --force --ledger ain --ain-provider <url>
```

## Teach mode (visitor-taught lessons) — what the host needs

Teach mode lets visitors correct the model from **Live test** (`/chat?teach=1`); the node trains each correction into a small
knowledge file (a *lesson*) and checks it on the live model before anyone can publish it. Two host requirements come with it:

### 1. The node's user must be in the `docker` group (no sudo)

The teach worker never runs a trainer in-process. It starts every training run as

```
docker exec -i -e PYTORCH_CUDA_ALLOC_CONF=… <teach.trainer.container> python3 /work/train/teach.py --job /work/.teach/<job>/job.json
```

and also uses `docker exec … pgrep -f train/` (is another training run holding the GPUs?) and `docker exec … kill -TERM <pid>`
(timeout / cancel). These calls are made by the node process itself, so the Unix user that runs `ainize start` needs the docker
socket without a password prompt:

```
sudo usermod -aG docker "$USER"   # log out and in again (or `newgrp docker`), then: docker ps  → must work without sudo
docker ps --format '{{.Names}}' | grep -x flashtrain   # the trainer container must be running (see the qwen3.8 repo)
```

`SUDO_PW` in the qwen3.8 `.env` only covers that repo's own scripts — the node does not read it. Without docker access the worker
marks every gradient job `FAILED` (`trainer container unreachable`); use `teach.backend: "stub"` on such hosts (below).

### 2. GPU allocation — trainer GPUs must be disjoint from the serving GPUs

| what | where (this host) | config |
| --- | --- | --- |
| serving model (vLLM + PLE hook, `:8000`) | GPUs 0–3, TP=4 (shared by every node on the host; cross-process lock `ple_patch/.ainize-runtime.lock`) | `runtime.api`, `runtime.repo` |
| teach trainer (`train/teach.py` in `flashtrain`) | GPUs 4–6 | `teach.trainer.gpus: "4,5,6"` (passed to the container as `CUDA_VISIBLE_DEVICES`) |

- Never let the two sets overlap: the trainer loads a second copy of the model's memory table and would starve vLLM.
- Only **one** training run at a time per host: the worker takes an atomic lease (`<runtime.repo>/ple_patch/.ainize-teach.lock`,
  stale after 45 min or when the holder pid is gone), then checks `docker exec … pgrep -f train/` and `nvidia-smi` free memory on
  the configured GPUs. If anyone else's job holds the GPUs (e.g. an operator's own `train_rev.py`), lessons stay `QUEUED` with
  `blocked: "slot"` — they are not lost and no second run is started. Several nodes on one host may all enable teach mode; the
  lease serialises them.
- A lesson takes roughly 3–8 minutes end to end on 3× 40 GB GPUs (load ≈ 60–90 s, ≤ 20 steps, export, then the side-effect check on
  the live model under the runtime lock). The UI shows the measured p50/p90 of this node (`GET /api/teach/policy`).
- **No trainer GPUs available?** Set `teach.backend: "stub"` (or `NGRAM_TEACH_BACKEND=stub`): the worker writes a small valid
  knowledge file instead of training and still runs the real preflight / side-effect check on the serving model, so the visitor flow
  can be shown end to end. `teach.stubOffline: true` additionally simulates the model checks for CI hosts without a model server —
  never set it on a demo node.

Config block (`config.json`, defaults from `packages/core/src/config.ts`; the operator can override the policy part without a
restart on **My knowledge → Teaching**):

```json
"teach": { "enabled": true, "publish": "auto", "backend": "stub",
           "factsPerJob": 8, "jobsPerKeyPerDay": 3, "jobsPerIpPerDay": 5, "queueMax": 10, "contributorShare": 0.7, "draftTtlDays": 7,
           "trainer": { "container": "flashtrain", "script": "train/teach.py", "gpus": "4,5,6", "maxSteps": 20, "timeoutMs": 1800000 } }
```

`publish`: `review` (operator approves each lesson) · `auto` (a lesson whose checks passed is announced as soon as the visitor signs
the claim — the demo cluster setting, `scripts/cluster.mjs`) · `never` (visitors can only try / keep / download). The demo cluster
script ships with `backend: "stub"` and a clearly marked `TEACH_BACKEND` switch — flip it to `gradient` once GPUs 4–6 are free.

From the terminal: `ainize teach status <node-url>` (policy, trainer, queue), `ainize teach status <lesson-url> --key-file <backup.json>`
(one lesson), `ainize patch import lesson.npz --recipe recipe.json` (run a downloaded lesson on your own node as a private draft).

### 3. Behind a reverse proxy — `server.trustProxy`

Per-IP controls (live-test quota, `jobsPerIpPerDay`, IP bans, the policy rate limit, the `ip` column of the operator queue) key
on Express's `req.ip`. By default (`"server": { "trustProxy": false }`) that is the TCP peer, so a client cannot choose its own
address with `X-Forwarded-For`. When the node runs behind nginx / caddy / a load balancer, every visitor would otherwise look like
the proxy — set the knob to what is actually in front of the node and nothing more:

```json
"server": { "trustProxy": 1 }            // one proxy hop (most setups); or "loopback", or "10.0.0.0/8, 172.16.0.1"
```

or `NGRAM_TRUST_PROXY=1` in the environment (`0`/`false` = off). Never set `true` on a node that is reachable directly:
that trusts whatever the client puts in the header.

### 4. Health checks — `/healthz` and `/readyz`

Point an uptime check, a Kubernetes probe or a load balancer at one of these two, never at `/` or `/api/info`: every path
the API does not claim is answered by the web app with **200 and an HTML page**, so a check on `/health` or `/status` is a
permanently green light — including on a node whose model server has been gone for a day.

| path | meaning | codes |
|---|---|---|
| `GET /healthz` | the process is alive (liveness) | always `200` with `{ok, node, address, version, uptime_s}` |
| `GET /readyz` | the node can actually do its job (readiness) | `200` when ready, `503` with the failing check |

`/readyz` fails when the ledger is unreachable (an `ain` node with no block height cannot read or write the public record)
or, on a node whose roles include `serving` or `verifier`, when the runtime is unavailable — the failure this product
actually has: the node is up and the model is gone. The body is the same either way:

```json
{ "ok": false, "node": "node-a", "checks": {
  "ledger":  { "ok": true,  "kind": "ain", "height": 180664, "records": 1298 },
  "runtime": { "ok": false, "required": true, "available": false, "model": null, "error": "serving API unreachable" },
  "peers":   { "ok": true,  "configured": 2, "unreachable": 0 } } }
```

From a deploy script or a terminal: `ainize status --check` prints the same three checks and **exits 1** when any of them
fails. The other probe paths (`/health`, `/healthcheck`, `/ready`, `/live`, `/livez`, `/ping`, `/status`, `/metrics`,
`/version`, `/up`) answer `404` with a JSON hint rather than the web app, so a monitor pointed at the wrong one fails loudly
instead of reporting success forever.

### 5. Backing up your node — the identity is the only thing you cannot rebuild

`<NGRAM_HOME>/config.json` holds the node's private key in plain hex, and that key **is** the node: it owns every
knowledge item this node published, its AIN balance, its payout address and the address peers know it by. Everything
else in a node (the catalog, the bodies, the ledger cache) can be re-fetched or re-seeded; the key cannot. A wiped
disk, a rebuilt container, an `rm -rf ~/.ngram` or one `ainize init --force --new-identity` ends it, and published
knowledge can then never be superseded, retired or challenged by its author again.

```bash
ainize keys backup ~/node-key.json --passphrase "…"    # scrypt + aes-256-gcm, mode 0600 — keep it off this machine
ainize keys import ~/node-key.json --passphrase "…"    # the way back, on a new machine after `ainize init`
```

- `keys backup` without a passphrase stores the key **in the clear** and says so; the file is still 0600.
- `keys import` and `keys rotate` copy `config.json` aside as `config.json.bak-<timestamp>` and ask you to type the
  current address before replacing the identity. So does `init --force --new-identity`; plain `init --force` keeps the
  identity and the operator password and only rewrites the rest of the file.
- Back up `<NGRAM_HOME>/data/` too if the node is a seller: it holds the `.npz` bodies buyers download. They can be
  re-registered from the original files, but only if you still have them.
