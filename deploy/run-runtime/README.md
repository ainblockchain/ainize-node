# `POST /api/run` — run one script in the hosted-agent sandbox

aindrive shows a ▶ Run button next to a `.py` (or `.js`/`.mjs`) file; pressing it posts the file's tree here and
shows what the script printed. The script runs in the same Docker boundary a hosted code agent gets
(`deploy/HOSTED-AGENTS.md`): an `--internal` network whose only exit is the node's gateway, a read-only rootfs,
`--cap-drop ALL`, `no-new-privileges`, a non-root user, memory/cpu/pid limits, and gVisor when
`agentHost.docker.runtime` is `runsc`.

The runner images are built from the Dockerfiles in this directory by `src/run-sandbox.ts` (tag
`ainize/run-runtime-<language>:<context hash>`, so an edited Dockerfile builds a new image). The first run of a
language on a fresh node waits for its build; later ones reuse the image.

## Request

```
POST /api/run
content-type: application/json
accept: text/event-stream            (default)   | application/json

{ "language": "python",                     # "python" (3.11, stdlib + requests + ainize SDK) | "node" (20, stdlib)
  "entry": "art_search.py",                 # one of `files`
  "files": { "art_search.py": "...", "README.md": "..." },   # or [{ "path": "art_search.py", "content": "..." }, …]
  "env": { "TOP_K": "5" },                  # the script's inputs; never a key (the sandbox provides AINIZE_API_KEY)
  "timeoutMs": 120000 }                     # ≤ 300000, default 120000
```

Limits (refused before anything starts): ≤ 32 files, ≤ 2 MiB of file text (`413 files_too_large`), file names
relative with no `..`, `.git` or empty segment (`400 invalid_request`), ≤ 32 env entries of ≤ 4 KiB each,
`timeoutMs` 1000–300000. The files land in `/work`, a 64 MiB tmpfs that is the only writable place besides a
16 MiB `/tmp`; the container has 512 MiB of memory, one CPU, 128 pids. A run that outlives `timeoutMs` is killed.

## Response

Default: `text/event-stream`. Every event's `data` is JSON:

| event    | data                                           |
|----------|------------------------------------------------|
| `stdout` | a string — one chunk of the script's stdout    |
| `stderr` | a string — one chunk of the script's stderr    |
| `error`  | a string — why the run ended early (`timeout after 120000ms`, a docker failure) |
| `exit`   | `{"code": n, "ms": n}` — always the last event. `code` is 124 after a timeout |

With `accept: application/json`: `{ "stdout", "stderr", "code", "ms", "error"? }` once the run is over, stdout and
stderr capped at 1 MiB each (also the cap on what the stream forwards).

Status codes: `400 invalid_request`, `413 files_too_large`, `429 too_many_runs` (more than 2 running runs for the
same caller, or 8 node-wide — an API key in `authorization: Bearer …` raises the per-caller limit to 4),
`503 runner_unavailable` (this node has no Docker, or `agentHost.docker.enabled` is off).

Starting a run needs no key. Who the run is FOR decides what the script holds (below): an API key in
`authorization: Bearer …` runs it as that key's owner; aindrive, presenting an AIN SSO machine token
(`client_credentials`, `aud` = this node's public URL, `azp` in `AIN_SSO_SERVICE_APPS`) and naming the person in
`X-AIN-Actor: <SSO subject>`, runs it as that person; anything else runs anonymously. A machine token that does not
verify is `401 invalid_service_token` (never a silent downgrade); a suspended account is `403 account_suspended`.
Each run writes one log line (caller, entry, bytes, ms, exit).

## What the script can reach

Nothing, except through the gateway, which the sandbox tells it about:

* `AINIZE_URL` — the gateway base standing in for this node: `/v1/*` under it is this node's keyed surface
  (`/v1/systemone` for a decision model, `/v1/chat/completions`, …). The `ainize` SDK is preinstalled in the
  python image (from this repo's `sdk/python`; the image tag hashes it, so an SDK change rebuilds).
* `AINIZE_API_KEY` — **the caller's own key**: the API key the run was started with, or, for aindrive's ▶, the
  `aindrive run` key of the person who pressed it (issued once per account by `src/run-actor.ts`, visible and
  revocable on their keys page, switched off with their organization's other keys on suspension). A decision made
  with it is gated, billed and recorded as theirs. An anonymous run has **no** `AINIZE_API_KEY`; a key written
  into the request's `env` is dropped — a key in a repo is what this exists to make unnecessary. The whole program
  is then:

  ```python
  import os, ainize
  client = ainize.connect(os.environ["AINIZE_URL"], api_key=os.environ["AINIZE_API_KEY"])
  out = client.decide("clef-flash", state={...}, questions={...})
  ```

* `HTTPS_PROXY` / `https_proxy` — a CONNECT proxy for `https://ainize.ai/…` and `https://<this node's public
  host>/…` written literally in the script; `urllib`, `requests` and most HTTP clients honour it on their own.
  A caller-supplied env value whose URL points at the node's own public host is rewritten to the gateway path, so
  the request is answered by this node rather than making a round trip through the internet. Any other host, any
  plain `http://`, and any IP literal is refused (`403` from the proxy, or no route at all).

## Operating

Turn it on with `agentHost.docker.enabled: true` (the same switch and daemon as code agents). Runs for a person
need AIN SSO on (`docs/ain-sso.md` §5) and `AIN_SSO_SERVICE_APPS=<aindrive's client_id>`; the key derivation secret
is `<AINIZE_HOME>/run-keys.secret` (0600, made on first use — back it up with the keys file, or every account gets a
new `aindrive run` key after a loss). The gateway listens
for runs on the internal network's bridge address, on an ephemeral port unless `runSandbox.gatewayPort` is set —
set it when the host firewall only admits fixed ports from the docker bridge. `runSandbox.maxRunning` (8),
`runSandbox.perCaller` (2) and `runSandbox.memory` (`512m`) adjust the limits above. Leftover `ainize-run-*`
containers from a crashed node are removed at start.
