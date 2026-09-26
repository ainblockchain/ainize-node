# Hosted agents: model → agent, run by the node

Date: 2026-09-26 · Repos: ainize-node (this), ainize-web, ainize (news-agent)

## Goal

1. `/models` lists every model the node serves; each opens `/models/:id`.
2. `/models/:id` has **Create agent based on this model**. Any wallet-signed-in visitor can press it.
3. The created agent is an A2A agent (`@a2a-js/sdk`, protocol 1.0 + 0.3 compat) at `/agents/:id`, listed with
   every other agent, listed on its model's page, and its page links back to the model.
4. The agent spec is code-capable: an agent can compute scores, render A2UI and perform writes against external
   APIs. User code runs in Docker, never in the node process.
5. `news-review` moves onto this spec. `donga-desk` follows once its source is located (out of scope here —
   blocked on source).

Non-goals: billing agent calls, persistent conversation history, token-by-token streaming (the card declares
`streaming: true` so `message/stream` works, but a turn is one message event), gossiping specs
(adverts only), CLI commands (the HTTP API is the contract; the CLI can follow).

## Concepts

`HostedAgentSpec` — what the node stores for an agent it runs:

```ts
interface HostedAgentSpec {
  id: string;              // agentIdOk: /^[a-z0-9][a-z0-9-]{0,39}$/, unique across config agents too
  name: string;            // ≤ 80
  description: string;     // ≤ 500
  model: string;           // a chat model this node serves (registry)
  systemPrompt: string;    // ≤ 8000, may be empty for handler mode
  mode: 'prompt' | 'tools' | 'handler';
  files: Record<string, string>;   // code, mode tools|handler only. entry `index.mjs`, optional package.json; ≤ 1 MB total
  a2ui: boolean;           // declare the A2UI extension on the card
  allowedHosts: string[];  // egress allowlist: 'api.example.com', '*.example.com', or '*' (any PUBLIC host)
  secretNames: string[];   // values stored separately, never returned
  skills: { id: string; name: string; description?: string; examples?: string[] }[]; // ≤ 8, default one chat skill
  owner: string;           // lower-case EVM address of the creator
  version: number;         // bumps on every update
  createdAt: number; updatedAt: number;
}
```

Modes:

- **prompt** — no code. The runtime sends `[system, …history, user]` to the model and replies with the answer.
- **tools** — the module exports `tools: [{ name, description, parameters, run(args, ctx) }]`. The runtime runs an
  OpenAI function-calling loop (≤ 8 rounds) against the agent's model. When the backend refuses native tool calls
  (vLLM without `--enable-auto-tool-choice`), it falls back to a JSON protocol described in the system prompt.
- **handler** — the module exports `execute(input, ctx)` and fully decides the reply. For deterministic pipelines
  such as news-review.

A module's reply is a string or `{ text, parts?, ui? }`: `ui` is a list of A2UI messages sent as data parts.

`ctx` (identical in and out of Docker):

| member | meaning |
|---|---|
| `execute(input, ctx)` | `input` is the message text (a string) |
| `ctx.input` | `{ text, contextId, history }` |
| `ctx.llm.chat({ messages, tools?, temperature?, max_tokens? })` | the agent's model via the node gateway; model is fixed to the spec's |
| `ctx.llm.baseUrl` | OpenAI-compatible base URL (token embedded) for libraries that want one |
| `ctx.fetch(url, init)` | egress through the gateway, allowlist enforced; also installed as global `fetch` in containers (requests to the gateway itself — `ctx.llm.baseUrl` — go direct) |
| `ctx.secret(name)` | secret value or `undefined` |
| `ctx.ui` | A2UI v0.9 helpers: `surface(id, components, data)` → messages, `text/column/row/card/divider/list` builders |
| `ctx.log(...)` | goes to the agent's log, readable by its owner |

## Architecture

```
browser ─► web (Next) ─► node /agents/:id ──► upstream
                                     │         ├─ in-process runtime  (prompt)   http://127.0.0.1:<p>/a/<id>
                                     │         └─ container runtime   (code)     http://<container-ip>:8080
                                     │
          runtime ─► node gateway (127.0.0.1 + docker bridge gateway IP)
                       /t/<token>/v1/chat/completions   → the model's backend upstream
                       /t/<token>/egress                → allowlisted public fetch
```

Every hosted agent resolves to an **upstream**, so `agents.ts` keeps one proxy path (card URL rewrite, rate limit,
body cap, SAM attribution, call counting, streaming pipe). What changes there is where an id is looked up:
config agents first, then hosted agents (which may start a container on demand).

### Units (ainize-node)

| file | unit | job |
|---|---|---|
| `src/hosted-agent-types.ts` | `HostedAgentSpec`, zod schema `hostedAgentSpecInput` | shape + validation |
| `src/hosted-agent-store.ts` | `HostedAgentStore` | `dataDir/hosted-agents.json`, atomic writes, owner/total limits |
| `src/hosted-agent-secrets.ts` | `HostedAgentSecretStore` | AES-256-GCM values in `dataDir/hosted-agent-secrets.json`, key in `hosted-agent-secrets.key` (0600) |
| `src/hosted-agent-runtime/*` | `createHostedAgentRuntimeApp` | self-contained (imports only sdk/express/node builtins): card, executor for the three modes, ctx, A2UI helpers, container entry `main.ts` |
| `src/hosted-agent-gateway.ts` | `HostedAgentGateway` | token → agent; LLM forward; egress with DNS + private-range checks, redirect re-check, 5 MB / 30 s caps |
| `src/hosted-agent-docker.ts` | `HostedAgentDocker` | docker CLI via `execFile`: ensure network + runtime image, build, run, inspect, stop, logs |
| `src/hosted-agent-host.ts` | `HostedAgentHost` | lifecycle: in-process prompt agents, on-demand containers, idle stop, LRU cap, build status |
| `src/hosted-agent-routes.ts` | `hostedAgentRoutes` | HTTP API below |

Runtime image: `ainize/hosted-agent-runtime:<hash of its build context>`, built by the node on first use from
`dist/hosted-agent-runtime` (transpiled on the fly under tsx) plus a generated Dockerfile (node:24-slim, sdk +
express pinned to the node's versions). Hashing the context rather than tagging by node version means a patched
runtime is never served from a stale image; code agents are rebuilt on node start (layer cache makes this cheap).
Agent image: `ainize-hosted-agent/<id>:v<version>`, `FROM` the runtime image, `COPY` files, `npm install
--omit=dev --ignore-scripts` when a package.json is present. Build timeout 5 min.

### Isolation (anyone can upload code)

`docker run` with `--network ainize-hosted-agents` (created `--internal`: no route out; verified the host is
reachable on the bridge gateway IP and the container IP is reachable from the host), `--cap-drop ALL`,
`--security-opt no-new-privileges`, `--read-only`, `--tmpfs /tmp:size=64m`, `--memory 512m`, `--cpus 1`,
`--pids-limit 256`, `--user node`, optional `--runtime <cfg>` (gVisor `runsc` recommended; a warning is logged
when absent). Secrets arrive as env vars; the token is per container start and dies with it.

The gateway is the only door out. Egress refuses loopback, RFC1918, link-local (incl. 169.254.169.254), CGNAT,
multicast and IPv6 equivalents, checked **after** DNS resolution and again on every redirect hop.

### Lifecycle

- prompt: mounted in the in-process runtime server at create/update; removed at delete. No Docker needed.
- code: `status: building → ready | failed`. Container starts on the first call (cold start), stops after 10 idle
  minutes, at most 20 running (least-recently-used stopped first). An update builds the new image first; the
  running container is replaced only when the build succeeds.
- A node without `agentHost.docker.enabled` refuses code modes with 501 `docker_unavailable`; prompt agents work.

### Config (`config.json`, optional)

```json
"agentHost": { "perOwner": 5, "total": 200,
  "docker": { "enabled": true, "runtime": "runsc", "memory": "512m", "cpus": 1, "idleStopMs": 600000, "maxRunning": 20 } }
```

## HTTP API

Auth: site session (`ainize_session` cookie or bearer). Owner = creator.

| method | path | notes |
|---|---|---|
| GET | `/api/models/:id` | `{ id, modality, available, agents: n }`, 404 if not served |
| GET | `/api/agents?model=<id>` | rows gain `model`, `kind` (`upstream|prompt|tools|handler`), `owner`, `status` |
| GET | `/api/hosted-agents?mine=1` | the caller's specs (summary) |
| POST | `/api/hosted-agents` | create → 201 `{ agent, a2a_url, card_url }`; 400 invalid, 401, 409 id taken, 429 limit, 501 docker |
| GET | `/api/hosted-agents/:id` | owner: full spec incl. files, `secrets: [{ name, set }]`; others: 403 |
| PUT | `/api/hosted-agents/:id` | owner; same validation; `version++` |
| DELETE | `/api/hosted-agents/:id` | owner; stops container, drops secrets |
| PUT | `/api/hosted-agents/:id/secrets/:name` | owner; `{ value }`; name must be in `secretNames` |
| GET | `/api/hosted-agents/:id/logs` | owner; build + runtime tail (≤ 200 lines) |

Validation: `model` must be a **chat** model this node serves. Code modes need `files['index.mjs']`. Names in
`secretNames` match `/^[A-Z][A-Z0-9_]{0,63}$/`.

Adverts (`PeerInfo.agents`) gain `model` and `owner` so peers can place a hosted agent on the model page.

## Web (ainize-web)

- `/models`: cards for all models by modality → `/models/:id`. Playground + snippet move to the detail page.
- `/models/:id` (`ModelDetailPage`): model info, playground, snippet, **Create agent based on this model**
  (sign-in first if needed → `/agent/new?model=:id`), **Agents built on this model** (`/api/agents?model=`).
- `/agent/new` (`AgentCreatePage`): name, id, description, model, system prompt, mode tabs; code editor for
  `index.mjs` (+ optional package.json) prefilled from a template per mode; A2UI toggle; allowed hosts; secrets.
  Code modes are disabled with an explanation when the node answers 501.
- `/agent/:id`: model shown as a link to `/models/:model`; owner sees edit/delete/secrets/logs.
- Explore agent rows show a model badge.

## news-review

`news-agent/hosted/` gains a handler-mode spec: `index.mjs` adapts `evaluate()` to `execute(input, ctx)`, taking
the model endpoint from `ctx.llm.baseUrl` and letting the global `fetch` (egress) serve reference lookups;
`allowedHosts: ['*']` because the corpus is any newsroom. A script POSTs it to a node. The standalone server stays
until the hosted one is live in production.

## Verified

- node: `test/hosted-agents.test.ts` (unit + HTTP → `/agents/<id>` over A2A 0.3, 1.0 and `message/stream`),
  `test/hosted-agents-docker.test.ts` (real image, container, gateway; loopback/metadata/direct egress refused).
- Against a real vLLM (qwen2.5-7b-instruct): prompt, tools (JSON fallback), news-review handler in Docker reading
  Google News through egress.
- Browser, local node + web dev: `/models` → `/models/:id` → create (handler, secret, A2UI) → build → live test
  draws the A2UI card → edit → model link → model page lists both agents → Explore badges → a second wallet sees
  no owner panel and gets 403.

## Follow-ups

- `@ainize/core` validateConfig warns `agentHost: unknown config key` — add the key to core's schema (needs a
  core release).
- CLI (`ainize agent …`) does not speak `/api/hosted-agents` yet.
- donga-desk: source not on this machine; port once located.

## Testing

- node unit: store limits/atomicity, secrets round-trip, egress guard (private ranges, redirects), spec validation,
  runtime executor per mode against a fake gateway (prompt, tools loop, handler with A2UI), routes auth matrix,
  `/api/agents?model=` merge, `agents.ts` resolving hosted ids.
- node integration (skipped without Docker): build + run a handler agent, call it over `/agents/:id` via A2A
  `message/send`, egress denied to 127.0.0.1, idle stop.
- web: parsers, route wiring, create form validation; typecheck + build.
- news-agent: existing tests stay green; hosted handler test with a fake ctx.

## Risks

- runc shares the host kernel: production should set `runtime: runsc`.
- Model backends may not support function calling; tools mode reports the backend's error verbatim.
- Cold start (seconds) on the first call to an idle code agent.
