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

{ "language": "python",                     # "python" (3.11, stdlib + requests) | "node" (20, stdlib)
  "entry": "art_search.py",                 # one of `files`
  "files": { "art_search.py": "...", "README.md": "..." },   # or [{ "path": "art_search.py", "content": "..." }, …]
  "env": { "AINIZE_DECIDE_URL": "https://ainize.ai/api/decide" },
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

Auth is the `/api/decide` free tier's: none required. Anonymous callers are told apart by address; a key by its
owner. Each run writes one log line (caller, entry, bytes, ms, exit).

## What the script can reach

Nothing, except through the gateway, which the sandbox tells it about:

* `AINIZE_DECIDE_URL`, `AINIZE_CHAT_URL`, `AINIZE_API_URL` — this node's `/api/decide`, `/api/chat` and `/v1`
  through the gateway. A caller-supplied env value whose URL points at the node's own public host (for the
  ainize.ai node, `https://ainize.ai/api/decide`) is rewritten to the same gateway path, so the request is
  answered by this node and attributed to the caller rather than making a round trip through the internet.
* `HTTPS_PROXY` / `https_proxy` — a CONNECT proxy for `https://ainize.ai/…` and `https://<this node's public
  host>/…` written literally in the script; `urllib`, `requests` and most HTTP clients honour it on their own.
  Any other host, any plain `http://`, and any IP literal is refused (`403` from the proxy, or no route at all).

## Operating

Turn it on with `agentHost.docker.enabled: true` (the same switch and daemon as code agents). The gateway listens
for runs on the internal network's bridge address, on an ephemeral port unless `runSandbox.gatewayPort` is set —
set it when the host firewall only admits fixed ports from the docker bridge. `runSandbox.maxRunning` (8),
`runSandbox.perCaller` (2) and `runSandbox.memory` (`512m`) adjust the limits above. Leftover `ainize-run-*`
containers from a crashed node are removed at start.
