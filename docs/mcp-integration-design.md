# MCP integration — Ainize as an MCP server, and as an MCP client

**Status:** design (2026-09-04). Written against the working copy of the same day; another job is landing lineage PRs
L2–L9 in `packages/{core,node,web,cli,e2e}`, so every line reference below may drift and must be re-read before code is
written. No product code was changed for this document.

**Owner's direction.** Two directions, both real:

- **(A) Ainize *as* an MCP server** — Claude Code, Cursor and ChatGPT can search knowledge, *live-test* it (the
  before/after comparison is the signature capability), *teach* the model something permanently, and *buy* over x402.
  Reusable tooling, not a single demo app.
- **(B) Ainize *as* an MCP client** — a node pulls data from other MCP servers (The Graph's Subgraph MCP first) and
  turns the result into a teaching dataset. The *subgraph → model memory* pipeline.

Reference shape for the agent-facing docs: The Graph's [`subgraphs-skills`](https://github.com/graphprotocol/subgraphs-skills)
and StreamingFast's [`substreams-skills`](https://github.com/streamingfast/substreams-skills) — a `SKILL.md` an agent
follows top to bottom, with everything deep pushed into `references/`.

---

## 0. Verified facts this design stands on

Read from the tree or measured on the live cluster on 2026-09-02…04. Nothing here is folklore.

| # | Fact | Where |
|---|------|-------|
| M1 | The node already has the async primitive for a live test: `POST /api/chat` accepts a caller-supplied `request_id` (≤ 64 chars), `GET /api/chat/status?request_id=` is public, free and quota-exempt, and `POST /api/chat/cancel` is free while queued. But **no endpoint starts a test and returns immediately** — the ticket is opened by the same POST that blocks. | `ainize-node/src/api.ts:480-537`; `ainize-node/src/market.ts:911-919`; `ainize-node/src/chat-queue.ts:50,80,105,114` |
| M2 | A live test on an idle lock measured **8.2 s wall** on node-a (`applied_ms` 3255, two generations at ~394 ms, `max_tokens` 16). A stacked compare was measured at 317 s in critique 3. | `time curl -X POST :3402/api/chat …`; `docs/ux-critique-3.json` |
| M3 | The shared runtime lock is cross-process (atomic `mkdir` + `holder.json`), waits **20 minutes** by default before throwing `shared runtime busy (<owner>: <label>) — try again later`, and breaks a lease only after `STALE_MS = 15 min`. The polite variant used by teach waits 2 min. | `ainize-node/src/runtime.ts:133,146,161,174-186` |
| M4 | Who holds the model is already public: `lockHolder()` → `{owner,label,since,alive,stale,mine}` and `queueState()` → `{running,waiting,lock}`, both surfaced by `GET /api/chat/patches` and `GET /api/chat/status` **together with the node's own `now`**, so "held for 41 s" is computed against the server clock, not the client's. | `ainize-node/src/runtime.ts:123-143`; `ainize-node/src/api.ts:465-479,520-531` |
| M5 | Free live tests are metered at **20 units / rolling hour per visitor**, where the visitor id is an HMAC of `ip:<req.ip>`. One MCP server therefore = **one bucket for all its users**. Exhaustion is `429 quota_chat: …` with a machine-readable `quota_reset` epoch. The quota is checked without consuming and consumed after, so a hung request does not burn a try. | `ainize-node/src/api.ts:503-512`; `ainize-node/src/market.ts:873-892` |
| M6 | There is **no quote endpoint and no price ceiling**. `POST /api/patches/:id/buy` is operator-gated and its whole body schema is `{ apply?: boolean }`; `Market.buy()` decodes the 402 requirements and pays on the next statement. | `ainize-node/src/api.ts:417`; `ainize-node/src/market.ts:757-800` |
| M7 | `GET /x402/patch/:id` **with no `X-PAYMENT` header** answers `402` + `x-payment-required` + `{x402Version:1, requirements:[{scheme,network,asset,payTo,maxAmountRequired,resource,description,nonce,expires_at}], accepts}`. That *is* the seller's binding quote. Its only side effect is reserving a nonce with a 10-minute TTL. | `ainize-node/src/api.ts:928-946`; `ainize-node/src/market.ts:655-667` |
| M8 | The gateway has **no returning-buyer branch**: it answers 402 to any request without `X-PAYMENT`, regardless of an existing settlement, and `Market.buy()` never consults `store.getPurchase()`. Buying twice pays twice. | `ainize-node/src/api.ts:928-940`; `ainize-node/src/market.ts:757-823` |
| M9 | `Market.buy()` writes `store.putPurchase(...)` **after** the blob download. A download failure loses the manifest while the seller's settle record and the single-use nonce are already spent — the money is unrecoverable by retry. | `ainize-node/src/market.ts:801-811,694-699,728` |
| M10 | Recovery *is* possible without paying again: `mayDownload(sha, address)` grants the blob to any address that appears as `buyer` in a settlement for that sha (and to verifiers), so `GET /p2p/blob/:sha` with a signed `x-ainize-auth` over `blob:<sha>` works forever, while the manifest's own `download_token` expires after 24 h. `GET /api/me/purchases` (operator) returns the stored manifest, tx hash, amount, scheme and local path. | `ainize-node/src/market.ts:641-652,744-756`; `ainize-node/src/api.ts:338` |
| M11 | Lineage base selection has **already landed** in the API: `POST /api/teach/jobs` accepts `base_ids` (≤ 2), `context_ids` (≤ 3), `mode: scratch\|extend\|fork\|merge`, `inherit`, `export: delta\|squash`, `force`; legacy `builds_on_context:true` is rewritten to `base_ids[0]` with a `Deprecation` header; `mode:'extend'` without `base_ids` is a 400; `mode:'merge'` is `merge_not_available`. `POST /api/teach/preflight` takes `base`-aware `patch_ids` plus `facts` XOR `{dataset_id, offset, limit}`. | `ainize-node/src/api.ts:699-764` |
| M12 | `GET /api/patches/:id` already returns `requires: [{id,name,held,price}]` derived from `anchor.base.stack` — the base stack a delta child needs — plus `lineage{parents,children}` one level, `purchased`, `has_body`, `owned`, `applied`, `dataset_held`. The 402 body does **not** carry `requires[]`; that is design §12.4, not shipped. | `ainize-node/src/api.ts:191-208`; `docs/lineage-teach-design.md` §12.4 |
| M13 | The L1 dataset surface exists (`GET /api/patches/:id/dataset`, `/dataset/rows`, `/dataset/manifest`, `POST /api/patches/:id/derive-intent`, `/p2p/dataset*`) with access levels `public \| derivative \| private` enforced per request, but **none of it appears in `GET /api/openapi.json`** (89 paths, hand-written). Tools must not be generated from the OpenAPI document. | `ainize-node/src/api.ts:210-265,1007-1026`; `ainize-node/src/openapi.ts` |
| M14 | `GET /api/patches/:id/tree`, `/signals`, `/issues` and `?bundle=1` are PR **L6/L8 and do not exist**. What exists today for a family view is one-level `lineage`, `requires[]`, `supersedes/superseded_by`, `GET /api/ledger/graph` (`edges[].type: 'extends'\|'supersedes'`) and `GET /api/patches/:id/conflicts`. | `ainize-node/src/api.ts:191-208,297-309,424-432`; `docs/lineage-teach-design.md` §12.5, §18 |
| M15 | Teach ETA is deliberately `null` until ≥ 3 GRADIENT-backend samples exist (three 3-second stub jobs must never become an estimate), and a teach job burns one of `jobsPerKeyPerDay` (3 on node-u) at **submit** time, before PREFLIGHT — a failed job is not refunded. `ACTIVE_JOBS_PER_KEY = 2`. | `ainize-node/src/teach.ts:946-959,773-777,809-810,171-178` |
| M16 | Three secrets, three mechanisms: operator bearer from `POST /api/auth/login {password}` (30-day session, also a cookie); the visitor teaching key signing `x-ainize-auth: <address>:<ts>:<sig>:v2` **request-bound and single-use** (a replayed header fails by design); the node identity private key in `config.json`, which signs AIN transfers and credit intents. `POST /api/patches/:id/buy`, `/apply`, `/remove`, `/announce` and `/api/me/*` are operator-gated. | `ainize-node/src/api.ts:53-131,338,417-419`; `ainize-node/src/teach-auth.ts`; `ainize-core/src/types.ts:416` |
| M17 | Live cluster on this machine: node-a `:3402` (`ledger: 'ain'`, quorum 2, `royalty_share` 0.3, `contributor_share` 0.7), node-b `:3403`, node-c `:3404`, node-u `:3422` (`teachable-u`, `ledger: 'local'`, `publish: 'auto'`). All four share ONE serving model at `http://localhost:8002`. | `curl :3402/api/info`, `curl :3422/api/info`, `curl :3422/api/teach/policy` |
| M18 | `docs/ux-critique-4.json` **does not exist**. The payment defects are recorded in `docs/ux-critique.json`, `-2`, `-3` and `ux-critique-owner.json`; critique 3 explicitly *downgraded* "a chain purchase buys only the child" (`merged[22]`) because today's children are stand-alone builds — the defect today is ambiguity and repeated payment, not a broken chain. | `ls docs/ux-critique-4*` (no match); `docs/ux-critique-3.json` |
| M19 | `graph/README.md` (commit `d85365c`) already reserves the split: `graph/` holds the Subgraph/Substreams pipelines, the benchmark harness and "the MCP client side that calls The Graph's Subgraph MCP and hands its rows to `packages/mcp`", and mandates **live data only**. | `graph/README.md` |
| M20 | `@modelcontextprotocol/sdk` is not installed anywhere in this tree; `1.30.0` is current on the registry and reachable from this machine. Its peer range is `zod: ^3.25 \|\| ^4.0` and it ships a zod-4 compat layer, so it matches the repo's `zod ^4.5.4`. `LATEST_PROTOCOL_VERSION = 2025-11-25`; `DEFAULT_NEGOTIATED_PROTOCOL_VERSION = 2025-03-26`. The task API (`server.experimental.tasks`) is labelled experimental. | `npm view @modelcontextprotocol/sdk version`; SDK typings read in a scratchpad install |

---

## 1. Goals and non-goals

### Goals

1. **The before/after is one tool call.** An agent that suspects the model is wrong about something can ask Ainize for
   the same question answered twice — bare model and with the knowledge loaded — and get back both answers, the
   benchmark verdict, and *who verified it and with what score*. Nothing else in the product is as legible to a judge or
   a user, and nothing else is as hard to fake.
2. **Teaching is a first-class tool, and it takes a base.** `teach` turns questions and answers into a knowledge, and
   accepts `base` (the knowledge it is trained *on top of*) from day one, because `base_ids` already exists on the node
   (M11) and the lineage work is landing now.
3. **Money is mechanical, not advisory.** Quote → explicit confirm echoing the quoted total → settle. A per-session cap
   the model cannot raise. An idempotency journal so a retry can never pay twice. A dry run that is genuinely read-only.
   The enforcement lives in the tool contract, not in prose — StreamingFast's own EVAL records that *"skill text alone
   does not override model posture"*.
4. **Nothing blocks.** Every tool that touches the shared model returns a job handle in milliseconds and is polled.
   Every status answer says who holds the model, for how long, and how many are waiting.
5. **Secrets never cross the wire.** No tool takes or returns a password, a bearer token, a private key or an
   `x-ainize-auth` header. The server reads them from its own env and exposes *capabilities* instead.
6. **Reusable, not a demo.** One package (`packages/mcp`) that any node operator can point at their own node, with a
   `SKILL.md` an agent can follow, three copy-pasteable client configs, and a mechanical `EVAL.md`.
7. **The client direction produces auditable data.** A dataset built from another MCP server carries provenance — which
   server, which subgraph, which query, which block, row hashes — so the published knowledge can say where its facts
   came from.

### Non-goals (v1)

- **Operator administration over MCP.** Peers, chain setup, policy edits, bans, contributor hiding, `forget`, `verify`,
  `challenge` and operator `announce` are not exposed. They are minutes-long, network-visible, or destructive, and an
  agent has no business driving them.
- **`POST /api/runtime/complete`.** It is a raw completion that deliberately does *not* take the shared lock
  (`ainize-node/src/runtime.ts:339-343` — `completeDetailed` never enters `serial()`), so it races an in-flight live test and reads whatever happens to be on the
  table. Exposing it would make the before/after a lie.
- **Merge.** `mode:'merge'` answers `merge_not_available` today (M11). The tool schema reserves the value and returns
  the node's own message.
- **A bundle buy.** `?bundle=1` is design, not shipped (M12/M14). `quote` states the whole stack and its total; `buy`
  purchases the named child only and says so, in the same breath, before the money moves.
- **New endpoints in `packages/node`.** v1 of the MCP server is built entirely on the HTTP surface that exists today.
  §14 lists the two upstream fixes worth landing later (`requires[]` in the 402 body; `putPurchase` before the
  download), both optional and both coordinated with the lineage job.
- **The SDK's experimental task API.** Progress notifications yes; `server.experimental.tasks` no, until it stops being
  labelled experimental (M20).

---

## 2. The two directions, and why each exists

### 2.1 Direction A — Ainize as an MCP server

**Why.** Today the only way to experience the product is a browser tab. The knowledge, the before/after proof, the
verification quorum and the x402 rail are all HTTP, but an agent cannot use them without a human driving a UI. MCP is
the standard that turns them into something Claude Code, Cursor and ChatGPT can call. Concretely it unlocks four
sentences an agent can now say truthfully:

- *"The model does not know this. Here is a knowledge that does — same question, both answers, and two independent
  nodes scored it 2761/2761."* (`live_test`)
- *"It costs 5 AIN. Your session cap is 10 and you have spent 0. Shall I?"* (`quote` → `buy`)
- *"I taught it. Here is the new answer, and the record says you taught it."* (`teach` → `job_status`)
- *"That knowledge is an add-on to `krx-all-2761`, which you do not hold — the honest total is 30, not 5."*
  (`quote`, `requires[]`)

**Shape.** One stdio binary and one Streamable-HTTP mode, ~20 tools in three risk tiers, five resources, four prompts,
a `SKILL.md` and an `EVAL.md`.

### 2.2 Direction B — Ainize as an MCP client

**Why.** A knowledge is only as good as its training set, and the best training sets are the ones nobody has typed by
hand. The Graph indexes chain state that a base model is structurally unable to know (an address, a vault APY, a
deployment id, a block-level fact) and exposes it over MCP. Turning a subgraph query into `{prompt, answer}` rows and
training them into memory converts *retrieval that must be repeated on every question* into *knowledge the model
carries* — and Ainize can then prove the difference with its own before/after harness.

**Shape.** A small, generic `McpDataSource` in `packages/mcp` (connect, list tools, call a tool, bounded) plus the
Graph-specific pipeline in `graph/` per `graph/README.md` (M19). The seam between them is deliberately narrow:

```ts
// ainize-mcp/src/rows.ts — the ONLY thing direction B hands direction A
export interface TeachRow { prompt: string; answer: string; note?: string }
export interface RowProvenance {
  source: 'mcp';
  server: { name: string; url: string; protocol_version: string };
  tool: string;
  arguments_sha256: string;      // the exact call, hashed (arguments may contain an API key path — never the key)
  fetched_at: number;
  upstream?: Record<string, string | number>;  // subgraph id, ipfs hash, block number, 30-day query volume …
  row_hashes: string[];          // sha256 of `${prompt}\n${answer}` per row, in order
  rows_sha256: string;           // sha256 of the canonical JSONL — the id the dataset lands on
}
```

`graph/` produces `{rows, provenance}`; `packages/mcp` uploads it as a teach dataset with the provenance recorded, and
**stops**. Training is a separate, explicitly confirmed call (§6.6).

---

## 3. Architecture

### 3.1 Package layout

```
ainize-mcp/                      # NEW workspace, its own package.json (no shared-file edits except §14 PR M9)
  package.json                     # "@ainize/mcp", type: module, bin: { "ainize-mcp": "dist/bin.js" }
  tsconfig.json                    # extends ../../tsconfig.base.json (NodeNext ESM, strict, verbatimModuleSyntax)
  README.md                        # what it is, how to configure it, "What this server will never do without you"
  SKILL.md                         # the agent-facing skill (§12)
  EVAL.md                          # mechanical scoring (§13.5)
  references/                      # SKILL.md's on-demand appendices
  src/
    bin.ts                         # stdio by default; --http <port> for Streamable HTTP
    server.ts                      # McpServer wiring: registerTool / registerResource / registerPrompt
    config.ts                      # env → Config; capability booleans; refuses nonsense at startup
    client.ts                      # typed HTTP client for one Ainize node (the ONLY place fetch() is called)
    auth.ts                        # operator login (once), teaching-key signing (per request), redaction
    tiers.ts                       # READ / MODEL / MONEY wrapper: caps, confirmation, journaling, scrubbing
    jobs.ts                        # in-process job table: {job_id → kind, request_id | teach job id, state, result}
    money.ts                       # quotes, session budget, idempotency journal, reconcile
    tools/{read,live,teach,money,admin}.ts
    resources.ts  prompts.ts  errors.ts  scrub.ts  rows.ts
  test/                            # node --test --import tsx test/*.test.ts
graph/
  mcp-client/                      # direction B (see §11), depends on @ainize/mcp for TeachRow/RowProvenance only
```

### 3.2 Transports

One binary, both transports, per M20:

- **stdio** (default) — `StdioServerTransport`. This is what `claude mcp add ainize -- node ainize-mcp/dist/bin.js`
  spawns, and what Cursor's `mcpServers` block spawns.
- **Streamable HTTP** — `--http <port>`, mounted with `createMcpExpressApp({ host, allowedHosts })` so DNS-rebinding
  protection is on for a localhost bind. Stateful sessions (`sessionIdGenerator: () => randomUUID()`) because the
  session budget and the job table are per-session state. This is what ChatGPT and remote clients need.

Legacy SSE is not implemented. The client direction (B) *does* use `SSEClientTransport`, because the hosted Subgraph MCP
is SSE-only.

### 3.3 One node per server process

`AINIZE_NODE_URL` is **server configuration, not a tool argument**. A tool that took a node URL would let a model point
a publish at node-a and the shared AIN chain with one wrong string. Operators who want several nodes run several server
entries (`ainize-u`, `ainize-a`) — which is also how the client shows them apart.

At startup the server reads `GET /api/info`, `GET /api/chain` and `GET /api/teach/policy` once, caches them (10 s for
policy, 60 s for info per M17's rate limits), and derives the capability set:

```ts
capabilities = {
  can_read: true,
  can_live_test: runtime.available,
  can_teach: policy.enabled && !!AINIZE_TEACH_KEY,
  can_buy: !!operatorSession && sessionBudget > 0,
  can_apply: !!operatorSession && AINIZE_MCP_ALLOW_APPLY === '1',
  can_publish: !!AINIZE_TEACH_KEY && AINIZE_MCP_ALLOW_PUBLISH === '1' && (ledger !== 'ain' || AINIZE_MCP_ALLOW_AIN_PUBLISH === '1'),
}
```

Tools whose capability is false are **not registered** (`RegisteredTool.disable()` / never registered), so the model
never sees an affordance it cannot use — and `sendToolListChanged()` fires if a capability appears later (e.g. the
runtime comes back). `ainize://instructions` states which are off and why.

---

## 4. Tool catalogue (direction A)

### 4.0 Conventions

**Names.** Unprefixed `snake_case`, the way the Subgraph MCP names its tools — the client namespaces them already
(`mcp__ainize__live_test`). Verbs where the tool acts, nouns where it reads.

**Three tiers, enforced by one wrapper** (`src/tiers.ts`), not per tool:

| Tier | Meaning | Rules the wrapper enforces |
|---|---|---|
| **READ** | free, synchronous, no side effects | `readOnlyHint: true`; 10 s upstream timeout; result flattened and scrubbed |
| **MODEL** | no money, takes the shared runtime lock, consumes a metered quota | must return a job handle; never blocks; every result carries `model` (§7.2) |
| **MONEY / PERMANENT** | spends AIN/credit or writes the ledger | quote required, confirmation required, session cap, idempotency journal, `retryable: false` on every error, never auto-retried |

**Every tool result** carries a small envelope so an agent never has to guess where it is:

```jsonc
{
  "ok": true,
  "node": { "name": "teachable-u", "url": "http://localhost:3422", "ledger": "local", "model": "Qwen3.8-Flash-Next" },
  "budget": { "cap": "10", "spent": "0", "remaining": "10", "currency": "CREDIT" },  // MONEY tools + quote only
  "model_lock": { "holder": null, "waiting": 0, "sentence": "the model is free" },   // MODEL tools only
  "...": "tool-specific fields"
}
```

**Every error** is a `CallToolResult` with `isError: true` (not an `McpError`, which the model cannot act on) and a
body of `{ code, message, retryable, retry_after_ms?, details }`. Codes are the node's own where the node has one
(§9).

**Sizes.** `search_knowledge` returns flattened rows, never raw `CatalogEntry` (anchor + attestations + settlements +
benchmark samples is kilobytes per row). Deep objects are behind an explicit `include`.

---

### 4.1 READ tier

#### `search_knowledge`
Browse or search the catalogue of this node and its peers.

- **Endpoint** `GET /api/catalog` · **Auth** none · **Cost** free · **Blocking** sub-100 ms (cached catalogue).
- **Input**

```json
{
  "type": "object",
  "properties": {
    "query":  { "type": "string", "description": "substring over id, name, description, model and benchmark schema" },
    "model":  { "type": "string" },
    "schema": { "type": "string", "description": "benchmark schema, e.g. krx/ticker-lookup" },
    "author": { "type": "string" },
    "origin": { "enum": ["operator", "teach"] },
    "status": { "type": "array", "items": { "enum": ["LISTED","VERIFYING","SUPERSEDED","CHALLENGED","REJECTED"] } },
    "sort":   { "enum": ["latest","popular","price","rows"], "default": "latest" },
    "limit":  { "type": "integer", "minimum": 1, "maximum": 50, "default": 20 },
    "offset": { "type": "integer", "minimum": 0, "default": 0 }
  },
  "additionalProperties": false
}
```

- **Output** `{ total, items: [{ id, name, description, price, currency, rows, size_mb, status, downloads, passed, quorum, quorum_ok, sellable, author, author_name, model, schema, created_at, node_url, is_addon, requires_count }], facets: { models[], schemas[] } }`.
  `is_addon`/`requires_count` come from `anchor.base?.stack` so a shopping agent sees the add-ons before it clicks.
- **Errors** `node_unreachable`.
- **Notes** `include_drafts` is deliberately absent: it is operator-only upstream and a non-operator's request is
  silently filtered, which would make the tool lie.

#### `get_knowledge`
Everything about one knowledge: what it claims, who verified it with what score, its family, and whether this node can
use it.

- **Endpoint** `GET /api/patches/:id` (+ optional `/records`, `/events`, `/conflicts`, `/api/benchmarks/:schema`)
  · **Auth** none (a DRAFT is 404 to anyone but its owner) · **Cost** free · **Blocking** sub-100 ms per include.
- **Input** `{ id: string, include?: ("lineage"|"conflicts"|"records"|"events"|"siblings")[] }`
- **Output**

```jsonc
{
  "knowledge": { "id": "...", "name": "...", "description": "...", "price": "5", "currency": "AIN",
                 "status": "LISTED", "model": "...", "schema": "...", "rows": 2761, "size_mb": 41.2,
                 "author": "0x…", "author_name": "node-a", "taught_by": "Minhyun", "license": "CC-BY-4.0" },
  "verification": { "quorum": "2/2", "quorum_ok": true, "sellable": true, "open_challenge": null,
                    "attestations": [{ "verifier": "0x…", "verifier_name": "node-b", "passed": true,
                                       "score": { "free_generation": "2761/2761" }, "verified_on": "vllm",
                                       "created_at": 1788… }] },
  "lineage": { "parents": [...], "children": [...], "supersedes": [], "superseded_by": [] },
  "requires": [{ "id": "krx-all-2761", "name": "KRX all", "price": "25", "held": false }],
  "availability": { "has_body": true, "purchased": false, "owned": false, "applied": false, "dataset_held": true,
                    "gateway_url": "http://localhost:3402" },
  "training_set": { "access": "derivative", "license": "CC-BY-4.0", "rows": 2761, "sha256": "…", "held": true }
}
```

- **Errors** `not_found`.
- **Notes** `attestations[].stake` is dropped on the way out — it was never escrowed and the UI already stopped calling
  it money (`ainize-core/src/types.ts:230-235`). `score` is passed through verbatim: it is the thing a judge reads.

#### `family_tree`
Ancestors, descendants, versions and conflicts around one knowledge.

- **Endpoint** `GET /api/ledger/graph` + `GET /api/patches/:id` per node · **Auth** none · **Cost** free ·
  **Blocking** one graph read plus ≤ `depth × breadth` detail reads, capped at 40 lookups.
- **Input** `{ id: string, depth?: 1..4 (default 2), direction?: "up"|"down"|"both" }`
- **Output** `{ root, nodes: [{ id, name, author_name, status, price, added: null, signals: null }], edges: [{ from, to, kind: "extends"|"supersedes" }], truncated, note }`
- **Notes** `note` states plainly, every time: *"Edge kinds beyond extends/supersedes, per-node `added` counts and
  signals are not recorded yet (design §12.5, PR L6)."* `added` and `signals` are `null`, not `0` — M14. When
  `GET /api/patches/:id/tree` ships, this tool switches to it and the note disappears.

#### `get_training_set`
Preview the questions and answers a knowledge was built from.

- **Endpoint** `GET /api/patches/:id/dataset` (`?rows=true` → `/dataset/rows`) · **Auth** none for `public`;
  a teaching-key signature for `derivative`; owner/operator always · **Cost** free · **Blocking** sub-100 ms.
- **Input** `{ id: string, rows?: boolean (default false), limit?: 1..200 }`
- **Output** `{ sha256, rows, access, license, parents, held, include_notes, merkle_root, preview: [{prompt, answer, note?}], truncated }`
- **Errors** `dataset_private` (403 — metadata is still returned in `details`), `dataset_derivative_only` (403 —
  `details.hint` says a teaching key must sign, and the server signs automatically when one is configured),
  `dataset_unavailable` (404 — no holder).

#### `node_status`
What this node is, what it holds, and whether the model is free.

- **Endpoint** `GET /api/info`, `GET /api/chat/patches`, `GET /api/chain` (cached) · **Auth** none · **Cost** free ·
  **Blocking** sub-100 ms cached; `refresh: true` adds a live `GET /api/runtime` probe (~3 s worst case).
- **Input** `{ refresh?: boolean }`
- **Output**

```jsonc
{
  "node": { "name": "teachable-u", "address": "0x…", "url": "http://localhost:3422", "ledger": "local",
            "roles": ["seller","serving"], "quorum": 2, "currency": "CREDIT", "balance": "100",
            "royalty_share": 0.3, "contributor_share": 0.7, "catalog": { "listed": 12, "drafts": 3 } },
  "runtime": { "available": true, "model": "Qwen3.8-Flash-Next", "hook": true, "applied": ["krx-all-2761"] },
  "model_lock": { "holder": { "owner": "node-b", "label": "chat:krx-all-2761", "held_s": 41, "stale": false, "mine": false },
                  "queue": { "running": 1, "waiting": 2 },
                  "sentence": "the model is held by node-b (a live test of krx-all-2761) for 41 s; 2 requests are waiting" },
  "quota": { "live_tests_remaining": 17, "limit": 20, "resets_at": 1788…, "shared_note": "this bucket is shared by everyone using this MCP server" },
  "teach_policy": { "enabled": true, "publish": "auto", "backend": "stub", "jobs_per_key_per_day": 3, "rows_per_job": 200, "lineage": true },
  "capabilities": { "can_read": true, "can_live_test": true, "can_teach": true, "can_buy": false, "can_apply": false, "can_publish": false },
  "warnings": ["applied knowledge on this model server is visible to every other node on this machine"]
}
```

- **Notes** `held_s` is computed from the node's own `now`, never the local clock (M4). `balance` comes from the public
  `GET /api/chain` — no operator login needed to know what the wallet holds.

#### `my_library`
What this node already owns: purchases, local bodies, applied stack, and my own lessons.

- **Endpoint** `GET /api/me/purchases`, `GET /api/me/patches`, `GET /api/runtime`, `GET /api/teach/jobs`,
  `GET /api/teach/datasets` · **Auth** operator bearer for the first three, teaching-key signature for the last two;
  each section is omitted with a reason when its credential is absent · **Cost** free · **Blocking** sub-200 ms.
- **Input** `{ include?: ("purchases"|"published"|"applied"|"lessons"|"datasets")[] }`
- **Output** `{ purchases: [{ patch_id, name, amount, currency, scheme, tx_hash, bought_at, body_present }], published: [...], applied: [...], lessons: [...], datasets: [...], omitted: [{ section, reason }] }`
- **Notes** the manifest is **never** returned — it contains a `download_token`. `body_present` is what an agent needs;
  the token is what the server needs. Same rule for `tx_hash`, which *is* returned: it is a public ledger fact.

#### `teacher_profile`
A data provider's lessons and earnings.

- **Endpoint** `GET /api/teacher/:address` · **Auth** none · **Cost** free · **Blocking** sub-100 ms.
- **Input** `{ address: string }` → **Output** `{ address, name, lessons: [...], earnings: { total, currency }, since }`

---

### 4.2 MODEL tier — the signature capabilities

#### `live_test` — the same question, before and after

**This is the tool the product exists for.** It asks one question twice: once of the bare model, once with the
knowledge loaded, and returns both answers side by side together with the verified score and who verified it.

- **Endpoint** `POST /api/chat` (issued by the server in the background) · **Auth** none for public knowledge; the
  server's teaching-key signature for the caller's own private drafts · **Cost** free but metered — 1 unit of 20/hour,
  **shared by every user of this MCP server** (M5) · **Blocking** returns in < 50 ms with a job handle; the underlying
  POST may take 8 s on an idle lock (M2) and up to 20 minutes behind another holder (M3).

- **Input**

```json
{
  "type": "object",
  "properties": {
    "question":   { "type": "string", "maxLength": 4000, "description": "the one question both columns answer" },
    "knowledge":  { "type": "array", "items": { "type": "string" }, "maxItems": 3,
                    "description": "knowledge ids to load for the 'after' column, applied in order; [] asks the bare model" },
    "mode":       { "enum": ["compare","base","patched"], "default": "compare" },
    "history":    { "type": "array", "maxItems": 23,
                    "items": { "type": "object", "properties": { "role": { "enum": ["system","user","assistant"] },
                                                                 "content": { "type": "string", "maxLength": 4000 } },
                               "required": ["role","content"], "additionalProperties": false } },
    "max_tokens": { "type": "integer", "minimum": 1, "maximum": 1024, "default": 200 },
    "thinking":   { "type": "boolean", "default": false }
  },
  "required": ["question","knowledge"],
  "additionalProperties": false
}
```

- **Output (immediate)**

```jsonc
{
  "job_id": "lt_9f2c…",
  "kind": "live_test",
  "state": "queued",
  "position": 1,
  "poll_after_ms": 1500,
  "model_lock": { "holder": {...}, "queue": {...}, "sentence": "the model is free" },
  "quota": { "remaining": 16, "limit": 20, "resets_at": 1788…, "shared_note": "…" },
  "next": "call job_status with this job_id"
}
```

- **Output (from `job_status` when done)**

```jsonc
{
  "job_id": "lt_9f2c…", "kind": "live_test", "state": "done", "elapsed_ms": 8224,
  "question": "픽셀플러스 종목코드는?",
  "before": { "answer": "058420", "latency_ms": 394, "truncated": false },
  "after":  { "answer": "087600", "latency_ms": 394, "truncated": false },
  "changed": true,
  "verdict": { "benchmark_hit": true,
               "expected": "087600",
               "note": "the knowledge's own benchmark contains this question; the 'after' answer matches it" },
  "knowledge": [{ "id": "pixelplus-087600", "name": "…", "applied_ms": 3255, "was_already_applied": false,
                  "verification": { "quorum": "2/2",
                                    "verifiers": [{ "name": "node-b", "score": { "free_generation": "2761/2761" }, "passed": true, "verified_on": "vllm" }] } }],
  "model": "Qwen3.8-Flash-Next",
  "caveats": ["the 'before' column reflects knowledge already pinned on this shared model server: krx-all-2761"]
}
```

- **Errors** `quota_chat` (429, `retryable: true`, `retry_after_ms` from `quota_reset`), `model_busy` (503 — the
  message names the holder), `runtime_unavailable`, `not_found`, `cancelled` (the caller gave up while queued; the node
  answers HTTP 499 with `charged: false`, which is an *outcome*, not a failure).
- **Notes**
  - `caveats[]` is not decoration. `pinnedPatchIds()` is what colours the "before" column, and on this machine node-a/b/c
    share one model server (M17): if someone applied a patch, the bare answer is not bare. The tool says so every time
    the applied set is non-empty.
  - `verdict` is `null`, never `false`, when the question is not in the knowledge's benchmark. An unscored comparison is
    still a comparison; pretending it was scored is the lie the whole product is built to avoid.
  - `history` is optional and the server derives `messages_base`/`messages_patched` correctly: replaying the *patched*
    answer to the bare model would teach it the knowledge mid-test, which the node already refuses
    (`ainize-node/src/api.ts:500-502`).

#### `teach` — turn questions and answers into knowledge, optionally on top of an existing knowledge

- **Endpoint** `POST /api/teach/datasets` (when rows are supplied) then `POST /api/teach/jobs` → HTTP 202 ·
  **Auth** the server's visitor teaching key · **Cost** free of money, but **burns one of `jobs_per_key_per_day`
  (3 on node-u) at submit time, non-refundably** (M15), and its preflight spends live-test units ·
  **Blocking** returns in < 300 ms with a job handle; training runs minutes (trainer timeout 30 min).

- **Input**

```json
{
  "type": "object",
  "properties": {
    "rows":       { "type": "array", "maxItems": 200,
                    "items": { "type": "object",
                               "properties": { "prompt": { "type": "string", "maxLength": 400 },
                                               "answer": { "type": "string", "maxLength": 200 },
                                               "note":   { "type": "string", "maxLength": 400 } },
                               "required": ["prompt","answer"], "additionalProperties": false } },
    "dataset_id": { "type": "string", "description": "an existing training set on this node (from create_training_set or my_library)" },
    "base":       { "type": "array", "items": { "type": "string" }, "maxItems": 2,
                    "description": "the knowledge this is trained ON TOP OF — recorded as a parent for good, shares every sale, and buyers must load it first" },
    "compare_with": { "type": "array", "items": { "type": "string" }, "maxItems": 3,
                      "description": "loaded for comparison only; NOT recorded as a parent" },
    "mode":       { "enum": ["scratch","extend","fork","merge"], "description": "extend requires base; merge is not available on this node yet" },
    "inherit":    { "type": "boolean", "default": true, "description": "start from the base's training set" },
    "export":     { "enum": ["delta","squash"] },
    "force":      { "type": "boolean", "description": "allow a SUPERSEDED base; the newer id is named in the result" },
    "effort":     { "enum": ["quick","balanced","thorough"], "default": "balanced" },
    "rows_limit": { "type": "integer", "minimum": 1, "maximum": 2000 },
    "name":       { "type": "string", "maxLength": 80 },
    "confirm":    { "type": "boolean", "description": "required when fewer than 2 daily lessons remain" },
    "dry_run":    { "type": "boolean", "default": false }
  },
  "additionalProperties": false
}
```

  Exactly one of `rows` / `dataset_id`. `base` maps to `base_ids`, `compare_with` to `context_ids` — the deprecated
  `builds_on_context` is never sent (M11).

- **Output (immediate)** `{ job_id, kind: "teach", state: "queued", node_job_id, position, eta_s: null|number, eta_note, quota: { lessons_remaining, rows_remaining, ip_remaining }, base: [{ id, name, status }], mode, export, next }`
- **Output (from `job_status`)** the node's own 13-state machine, passed through with its vocabulary intact:
  `QUEUED → PREFLIGHT → LOADING → TRAINING → EXPORTED → CHECKING → READY | NEEDS_MORE | FAILED | CANCELLED`, plus
  `progress { step, max_steps, hits, total, elapsed_s }`, `checks`, `result { sha256, rows, size_bytes }`,
  `draft_id`, `blocked: "lock"|"slot"|null`, and — when READY — a `next_steps` array naming `live_test` (prove it) and
  `publish` (if enabled).
- **Errors** `quota_key` / `quota_ip` / `quota_rows` (429), `teaching_disabled`, `trainer_paused`, `banned`,
  `invalid_signature`, `base_rejected`, `base_retired` (names the newer id), `merge_not_available`,
  `dataset_format`, `nothing_to_train` (see below). All `retryable: false` except the 429s.
- **Notes**
  - **Preflight first, always.** Before submitting, the tool runs `teach_preflight` on up to 8 rows and refuses to
    submit when *every* probed row comes back `already_known` / `in_base`, with `nothing_to_train`: submitting would
    burn a daily lesson to train nothing (M15). The preflight result is returned in the refusal so the agent can see why.
  - **A lesson is scarce like money.** When `lessons_remaining <= 1` the tool requires `confirm: true` and says
    *"this is your last lesson on this node today, and a failed job is not refunded"*.
  - **Never auto-retry.** A FAILED job returns `teach_quota_consumed` with the reason; the decision to spend another
    lesson is the human's.
  - `eta_s` is rendered as `"no measured estimate yet"` when null — three 3-second stub jobs must never become an ETA
    (M15).

#### `teach_preflight` — would this actually teach anything?

- **Endpoint** `POST /api/teach/preflight` · **Auth** teaching key · **Cost** live-test units charged to **both** the IP
  and the key, `ceil((facts + context blobs) / 3)`, min 1 · **Blocking** one model call per fact under the shared lock —
  seconds to a couple of minutes; returned as a job handle like everything else in this tier.
- **Input** `{ rows?: [{prompt, answer}] (1..8), dataset_id?: string, offset?: int, limit?: 1..8, base?: string[], compare_with?: string[] }`
- **Output** `{ items: [{ prompt, status: "will_train"|"already_known"|"overlaps_listing"|"invalid"|"in_base"|"base_conflict", detail, base_answer? }], sampled: { checked, of }, trainable, quota }`
- **Notes** `sampled` is passed through verbatim so no whole-dataset claim can be made from a 24-row probe
  (`preflight.sampleRows = 24`, `perCall = 8`). `in_base` / `base_conflict` appear as the lineage work lands; the tool
  declares the enum today and reports whatever the node returns.

#### `create_training_set` — rows in, dataset out (the seam for direction B)

- **Endpoint** `POST /api/teach/datasets` · **Auth** teaching key · **Cost** free; counts against
  `datasets_per_key_per_day` and the byte quota · **Blocking** sub-second.
- **Input** `{ rows: TeachRow[], name?: string, retention?: "keep"|"delete_after_training", provenance?: RowProvenance }`
- **Output** `{ dataset_id, rows_accepted, rows_rejected: [{ index, reason }], sha256, revision, existing: boolean }`
- **Notes** `provenance` is stored with the dataset (as `note` metadata in v1, as a first-class manifest field once
  L1's dataset manifest accepts it) and is what makes the published knowledge able to say where its facts came from
  (§11.4). Identical bytes answer 200 with the same `dataset_id` — that is the node's own de-dupe and the tool
  surfaces it as `existing: true` rather than pretending a new upload happened.

#### `apply_knowledge` / `remove_knowledge` — off by default

- **Endpoint** `POST /api/patches/:id/apply` / `/remove` · **Auth** operator · **Cost** free ·
  **Blocking** takes the shared lock (up to 20 min) and shells out to `scripts/patch.py` with a 600 s subprocess
  timeout; job-handled.
- **Registered only when `AINIZE_MCP_ALLOW_APPLY=1`.** The result and the confirmation copy both state: *"this changes
  the model server every node on this machine shares, it persists across restarts (the watchdog re-applies it), and it
  silently changes the 'before' column of everyone else's live test."* `remove_knowledge` requires `confirm: true`
  because unloading one knowledge writes the base model over rows another loaded knowledge shares
  (`docs/ux-critique-3.json`).
- **Never** `scripts/patch.py` directly, and never the `packages/agent` code path — that is the critical defect
  critique 3 records (`ainize-agent/src/agent.ts:250-266`).

#### `job_status`, `job_cancel`, `job_list` — one handle vocabulary for the whole tier

- **`job_status` · Input** `{ job_id: string, wait_ms?: 0..25000 }` — `wait_ms` long-polls *inside the server* (the
  upstream POST is already in flight; this just delays the answer), which turns a 5-call poll loop into 1 call without
  ever blocking the node. Default 0.
- **Output** `{ job_id, kind, state, elapsed_ms, position?, eta_s?, eta_note?, model_lock, progress?, result?, error?, poll_after_ms }`
  where `state` is one of `queued | running | done | failed | cancelled | gone`, mapped from the node's own vocabulary
  (`queued/running/gone` for chat, the 13 `TeachStatus` values for teach) and reported alongside `native_state` so
  nothing is lost in translation.
- **`job_cancel` · Input** `{ job_id, reason?: string }` → `{ cancelled, reason: "queued"|"already_running"|"gone", charged: boolean, note }`.
  Cancelling a queued live test is genuinely free — nothing reached the model and no try was consumed; cancelling a
  running one does not stop the node and the tool says so. A teach cancel is `DELETE /api/teach/jobs/:id` and the
  daily lesson is **not** returned.
- **`job_list` · Input** `{ kind?, state?, limit? }` → this session's jobs, newest first. Survives a client that lost a
  `job_id` mid-conversation.

---

### 4.3 MONEY / PERMANENT tier

#### `quote` — what it really costs, before anything moves

- **Endpoint** `GET /api/patches/:id` + `GET /api/me/purchases` + (unless `dry_run`) the unpaid
  `GET /x402/patch/:id` handshake · **Auth** operator for the purchases check; none for the rest ·
  **Cost** free · **Blocking** sub-second per item.
- **Input** `{ id: string, include_bases?: boolean (default true), dry_run?: boolean (default false) }`
- **Output**

```jsonc
{
  "quote_id": "q_7b31…",
  "expires_at": 1788…,                        // min(402 expiry, now + 10 min)
  "items": [
    { "id": "pixelplus-087600", "name": "…", "role": "requested",
      "price": "5", "currency": "AIN", "status": "LISTED", "superseded_by": null,
      "license": "CC-BY-4.0", "seller": "0x…", "gateway_url": "http://localhost:3402",
      "quorum": "2/2", "sellable": true, "already_purchased": false, "body_held": false,
      "scheme": "ain-transfer", "pay_to": "0x…" },
    { "id": "krx-all-2761", "name": "KRX all", "role": "base",
      "price": "25", "currency": "AIN", "held": false, "status": "LISTED", "already_purchased": false }
  ],
  "total_requested": "5",
  "total_with_bases": "30",
  "budget": { "cap": "10", "spent": "0", "remaining": "10", "currency": "AIN" },
  "affordable": { "requested": true, "with_bases": false,
                  "shortfall": "20",
                  "explanation": "Buying pixelplus-087600 alone costs 5 and fits. Loading it also needs krx-all-2761 (25), which this node does not hold — 20 over your session cap of 10. Raise AINIZE_MCP_SESSION_BUDGET or buy the base separately on another session." },
  "warnings": [
    "buy purchases the named knowledge only — a bundle buy (?bundle=1) is not implemented on this node yet",
    "this knowledge is an add-on: without krx-all-2761 loaded first, applying it is refused"
  ],
  "confirm_with": { "tool": "buy", "quote_id": "q_7b31…", "confirm_total": "5" }
}
```

- **Errors** `not_found`, `not_sold_here` (409 — the node's own message names the real gateway),
  `not_listed_yet` (423 — `verification 1/2`), `challenged` (423 — the verifier's reason, verbatim: *no price is honest
  while a verifier disputes the result*), `already_purchased` (returned as a successful quote with
  `already_purchased: true` and the stored date/tx, not as an error).
- **Notes**
  - **`dry_run: true` is genuinely read-only** — it prices from `GET /api/patches/:id` alone and never touches
    `/x402/...`, because the 402 handshake reserves a nonce with a 10-minute TTL. A dry run that allocates state is not
    a dry run.
  - **A superseded target is never silently followed.** `resolveSupersedes` can retarget a 0.1-CREDIT item to a
    25-CREDIT one; `quote` returns *both* rows and lets the caller pick, and never quotes id A while pricing id B.
  - `total_with_bases` is honest about being additive over separate purchases, not a bundle discount, because the node
    settles one record per purchase.

#### `buy` — settle a quote, and only a quote

- **Endpoint** `POST /api/patches/:id/buy` · **Auth** operator bearer (held by the server) ·
  **Cost** real money — an AIN transfer or a signed local-credit intent ·
  **Blocking** gateway fetch (30 s) → pay → retry (60 s) → blob download (up to 10 min for a 300 MB npz) → optional
  apply. Job-handled like the MODEL tier, because 10 minutes is past every client's timeout.
- **Input**

```json
{
  "type": "object",
  "properties": {
    "quote_id":        { "type": "string" },
    "confirm_total":   { "type": "string", "description": "the total from the quote, restated exactly (string equality)" },
    "confirm":         { "const": true },
    "idempotency_key": { "type": "string", "maxLength": 64 },
    "apply":           { "type": "boolean", "default": false },
    "max_price":       { "type": "string", "description": "optional; may only LOWER the effective cap" }
  },
  "required": ["quote_id","confirm_total","confirm"],
  "additionalProperties": false
}
```

  **There is no `id` parameter.** The knowledge being bought is whatever the quote named. A model that hallucinated an
  id cannot spend on it.

- **Output** the node's `steps[]` timeline passed through verbatim (`quorum → 402 → pay → settled → download →
  receipt → apply`) — critique 3 called it the best-designed thing in the product — plus
  `{ patch_id, amount, currency, scheme, tx_hash, body_path_present: true, budget: { cap, spent, remaining }, applied }`.
- **Errors, all `retryable: false`:** `quote_required` (no `quote_id`), `quote_expired`, `quote_mismatch` (the live 402
  no longer matches the quoted amount, or the resolved item changed), `confirmation_required`,
  `budget_exceeded` (`details: { cap, spent, remaining, needed }`), `per_purchase_cap_exceeded`,
  `already_purchased` (`details: { bought_at, tx_hash, body_present }` — *"you already own this; nothing was charged"*),
  `not_listed_yet`, `challenged`, `idempotency_replay` (`details` = the original result),
  `payment_settled_delivery_failed` (§6.5).
- **Notes** the server writes an `intent` row to its journal **before** calling the node, so a timeout is recoverable
  rather than ambiguous (§6.5).

#### `reconcile_purchase` — the money is not lost

- **Endpoint** `GET /api/me/purchases`, `GET /api/ledger?kind=settle`, and — when a settlement exists without a body —
  a signed `GET /p2p/blob/:sha` · **Auth** operator + node identity signature (server-side) · **Cost** free ·
  **Blocking** seconds, up to the blob download.
- **Input** `{ id?: string, idempotency_key?: string }`
- **Output** `{ state: "complete"|"settled_no_body"|"recovered"|"never_paid", purchase?: {...}, tx_hash?, recovered_path_present?, explanation }`
- **Notes** this is the highest-value guard in the design. `mayDownload()` grants the blob to any address with a settle
  record for that sha, permanently, while the manifest's own token expires after 24 h (M10) — so a lost manifest costs
  nothing if anybody bothers to ask. Today nothing asks. **`buy` calls this automatically before ever re-buying.**

#### `publish` — irreversible, off by default

- **Endpoint** `GET /api/teach/jobs/:id/publish-challenge` then `POST /api/teach/jobs/:id/publish` ·
  **Auth** teaching key (the server signs the claim) · **Cost** free of money, permanent on the ledger ·
  **Blocking** seconds; the announce is broadcast to peers.
- **Registered only when `AINIZE_MCP_ALLOW_PUBLISH=1`**, and **refused outright** when
  `GET /api/info` reports `ledger: 'ain'` unless `AINIZE_MCP_ALLOW_AIN_PUBLISH=1` — publishing to the shared chain
  cannot be recalled (M17: node-u is `publish: 'auto'`, so on node-u the first call publishes for real).
- **Input** `{ job_id, name, description?, price?, license?, dataset: { access: "public"|"derivative"|"private", license?, include_notes?, declaration: { source: "own"|"public"|"licensed", license?, no_pii: boolean } }, consent: { permanent: true, rights: true }, confirm_phrase: "publish <job_id> permanently" }`
- **Output** `{ status: "ANNOUNCED"|"PENDING_REVIEW", patch_id?, url?, split_preview: { price, lineage_pool, contributor_share_of_remainder, you_receive, node_receives, explanation } }`
- **Notes**
  - Both `consent` booleans are **required inputs with no default**. They are things a human agreed to, not fields a
    tool fills in.
  - `split_preview` is computed from `royaltySplit` over the real parents, not from the publish sheet's "70 %", which
    is the known-wrong number: with a 0.3 lineage pool the contributor's 0.7 is 0.7 × 0.7 = **49 %**
    (`docs/ux-critique-3.md:232` (item 186)). A tool that repeated the sheet's number would mislead the user about money.
  - `confirm_phrase` must contain the job id: a model cannot approve a publish by pattern-matching "yes".

---

### 4.4 The catalogue at a glance

| Tool | Tier | Auth held by the server | Money | Blocks? | Registered by default |
|---|---|---|---|---|---|
| `search_knowledge` | READ | — | free | < 100 ms | ✅ |
| `get_knowledge` | READ | — | free | < 100 ms | ✅ |
| `family_tree` | READ | — | free | < 1 s | ✅ |
| `get_training_set` | READ | teach key (for `derivative`) | free | < 100 ms | ✅ |
| `node_status` | READ | — | free | < 100 ms (3 s with `refresh`) | ✅ |
| `my_library` | READ | operator + teach key | free | < 200 ms | ✅ (sections omitted with a reason) |
| `teacher_profile` | READ | — | free | < 100 ms | ✅ |
| `live_test` | MODEL | teach key (own drafts only) | free, 1 of 20/hour shared | no — job handle | ✅ when runtime available |
| `teach_preflight` | MODEL | teach key | free, ≥ 1 of 20/hour ×2 buckets | no — job handle | ✅ when teaching enabled |
| `teach` | MODEL | teach key | free; 1 of 3 daily lessons, non-refundable | no — job handle | ✅ when teaching enabled |
| `create_training_set` | MODEL | teach key | free; byte/row quota | < 1 s | ✅ when teaching enabled |
| `apply_knowledge` | MODEL | operator | free | no — job handle | ❌ `AINIZE_MCP_ALLOW_APPLY=1` |
| `remove_knowledge` | MODEL | operator | free | no — job handle | ❌ `AINIZE_MCP_ALLOW_APPLY=1` |
| `job_status` / `job_cancel` / `job_list` | READ | — | free | ≤ `wait_ms` | ✅ |
| `quote` | MONEY (read) | operator (purchases check) | free | < 1 s | ✅ |
| `buy` | MONEY | operator | **real** | no — job handle | ❌ needs a non-zero budget |
| `reconcile_purchase` | MONEY (read) | operator + node identity | free | seconds | ✅ when operator configured |
| `publish` | PERMANENT | teach key | free, irreversible | seconds | ❌ `AINIZE_MCP_ALLOW_PUBLISH=1` |

**Deliberately absent:** `verify`, `challenge`, `announce`, `forget`, `runtime_complete`, peers, chain setup, policy,
bans, contributor hiding, dataset delete. §1 non-goals says why.

---

## 5. Resources and prompts

### 5.1 Resources

The Subgraph MCP's single most effective trick is a resource that encodes a **mandatory workflow** (`graphql://subgraph`:
search → *always* check 30-day query volume → pick highest → schema → execute). Ainize copies it.

| URI | Name | Content |
|---|---|---|
| `ainize://instructions` | Ainize Server Instructions | The non-optional workflow (§5.3), the three tiers, the money contract, which capabilities are off on *this* server and why. Small enough to be read on connect. |
| `ainize://node/info` | This node | `GET /api/info` + `/api/chain` + `/api/teach/policy`, flattened, cached 60 s. Includes `ledger` so a client can see at a glance that this is the shared AIN chain. |
| `ainize://openapi` | Ainize HTTP API | `GET /api/openapi.json` verbatim, **with a header stating it is incomplete** — the L1 dataset routes are missing (M13). For humans reading along, never for tool generation. |
| `ainize://budget` | Session budget | `{ cap, spent, remaining, currency, per_purchase_cap, purchases: [...] }` — readable at any time without calling a money tool. |
| `ainize://knowledge/{id}` | Knowledge card (template) | The `get_knowledge` output for one id, as a resource, so a client can pin it into context. |

### 5.2 Prompts

| Name | Arguments | What it does |
|---|---|---|
| `prove_it` | `question`, `knowledge?` | Search for a knowledge that covers the question, run `live_test`, present before/after with the verifiers and their scores. The signature demo in one prompt. |
| `teach_on_top` | `facts`, `base?` | Preflight, show what the base already answers, then submit `teach` with `base` set, then prove it with a fresh `live_test`. |
| `shop_for_knowledge` | `need`, `budget?` | Search → `quote` (with bases) → present the honest total and the affordability explanation → stop and ask. Never calls `buy`. |
| `subgraph_to_knowledge` | `topic`, `subgraph?` | The direction-B walkthrough (§11): find the subgraph, check its query volume, read its schema, run the query, build rows with provenance, `create_training_set`, show the rows, **stop**. |

### 5.3 `ainize://instructions` — the workflow, verbatim

> **Before you claim a knowledge helps, prove it.** Never say a knowledge answers a question you have not run through
> `live_test`. The proof is the pair of answers, not the description.
>
> **Before you spend, quote.** `buy` cannot be called without a `quote_id` and the total restated. Show the human the
> total, the base stack and the remaining session budget, and wait. Never call `buy` in the same turn you first
> discovered the price.
>
> **Before you teach, preflight.** A daily lesson is scarce and non-refundable. If every row is already known, say so
> and do not submit.
>
> **Everything that touches the model is a job.** Call the tool, get a `job_id`, poll `job_status`. If the model is
> held by someone else, `job_status` says who and for how long — report that instead of retrying.
>
> **Never print a token, key, password or signature.** This server holds them. You do not need them and cannot get them.
>
> **When something is not implemented, say so.** Family-tree edge kinds, per-node signals, bundle buys and merge are
> not built yet. The tools return `null` and a note. Report the note; do not invent the number.

---

## 6. The money policy

### 6.1 The contract

```
quote(id)  ──►  {quote_id, total, items[], budget, affordable, confirm_with}
                        │
                  human sees the total
                        ▼
buy(quote_id, confirm_total = "<the total, restated>", confirm = true, idempotency_key)
                        │
        ┌───────────────┼────────────────────────────────────────────┐
        │               │                                            │
   quote expired?  total mismatch?                            over the cap?
   quote_expired   quote_mismatch                            budget_exceeded
                        │
                  journal: intent  ──►  POST /api/patches/:id/buy  ──►  journal: complete
                                              │ timeout / error
                                              ▼
                                     reconcile_purchase (never a retry)
```

`confirm_total` is compared by **string equality** against the quoted total. Not `>=`, not parsed as a number: the
agent has to have seen the number to restate it, and that is the audit trail. `confirm: true` is a separate required
field so a schema-filling model cannot approve by supplying only the string it copied from the previous result.

### 6.2 Caps

| Env | Meaning | Default |
|---|---|---|
| `AINIZE_MCP_SESSION_BUDGET` | total spend allowed for the life of this server process/session | `0` — **buy is not registered at all** |
| `AINIZE_MCP_MAX_PER_PURCHASE` | ceiling for a single `buy` | equal to the session budget |
| `AINIZE_MCP_MAX_TEACH_JOBS` | daily lessons this server may spend | `1` |

Caps are read from the server's own env and are **never tool arguments**. A tool argument (`max_price`) may only *lower*
the effective cap for that call. Exceeding a cap is `budget_exceeded` with `{ cap, spent, remaining, needed }` — never a
silent clamp, never a partial purchase. Every quote and every buy result echoes `{cap, spent, remaining}`, and
`ainize://budget` shows it without a tool call.

### 6.3 Dry run

`dry_run: true` on `quote`, `buy` and `teach` is genuinely read-only:

- `quote` prices from `GET /api/patches/:id` only — **no `/x402/` call**, because the 402 handshake reserves a nonce
  with a 10-minute TTL (M7). A dry run that allocates state upstream is not a dry run.
- `buy` resolves the quote, evaluates every gate, and reports what *would* happen and what it *would* cost, without a
  gateway call.
- `teach` reports the row count, the base, the mode, the quota it would spend and the preflight verdict — the preflight
  itself is skipped, because it spends live-test units (M5).

### 6.4 Idempotency

An in-process journal keyed by `idempotency_key` (defaulted to `sha256(quote_id)` when omitted):

```jsonc
{ "key": "…", "state": "intent" | "settled" | "complete" | "failed",
  "patch_id": "…", "quote_id": "…", "amount": "5", "tx_hash": null, "sha256": "…", "at": 1788… }
```

`intent` is written **before** the node is called. A second `buy` with the same key never calls the node: it returns
`idempotency_replay` with the original result if `complete`, or routes to `reconcile_purchase` if `intent`. The journal
is also persisted to `AINIZE_MCP_STATE_DIR/purchases.json` (mode 0600) so a server restart mid-purchase is still
recoverable.

### 6.5 The lost-manifest case, handled

`Market.buy()` writes the purchase row only after the blob download (M9), so a download failure loses the manifest while
the settlement and the nonce are spent. The MCP layer's answer, in order:

1. `buy` writes `intent` first, so the key always knows a payment *may* have happened.
2. On any error or timeout, `buy` does **not** retry. It calls `reconcile_purchase`.
3. `reconcile_purchase` looks for a purchase row (`GET /api/me/purchases`), then for a settle record naming this node's
   address as `buyer` (`GET /api/ledger?kind=settle`).
   - purchase row present → `complete`.
   - settlement present, no body → `settled_no_body`, and the body is re-fetched from `GET /p2p/blob/:sha` with an
     `x-ainize-auth` header signed over `blob:<sha>` by the node identity — which `mayDownload()` honours for any settled
     buyer, forever (M10). Result: `recovered`. **No second payment.**
   - neither → `never_paid`, and buying again is safe.
4. The tool result says which of the four it was, in a sentence, with the tx hash.

### 6.6 What the agent sees when it cannot afford the chain

The honest total for "make my model able to answer X" is the child *plus every base it needs*. `quote` computes it from
`requires[]` (M12) and, when it does not fit, returns `affordable.with_bases: false` with a `shortfall` and an
`explanation` naming exactly what is missing and what it costs:

> *"Buying `pixelplus-087600` alone costs 5 and fits your remaining budget of 10. But it is an add-on: applying it needs
> `krx-all-2761` (25), which this node does not hold. The honest total is 30 — 20 over your session cap. You can buy
> the add-on now and it will sit unusable until the base is bought, or raise the cap, or ask me for a stand-alone
> knowledge that covers the same questions."*

The tool never partially buys, never buys "the cheap half", and never silently drops the base. The three options are
stated and the human chooses.

### 6.7 Teach quota is treated as money

A daily lesson is scarce and non-refundable (M15), so it obeys the money rules: a cap (`AINIZE_MCP_MAX_TEACH_JOBS`),
`confirm: true` when the last one is at stake, refusal to submit when preflight says nothing would train, and **no
auto-retry** on FAILED.

---

## 7. The async model

### 7.1 Why start/poll is the only correct shape

`Runtime.acquireLock()` waits **20 minutes** before throwing (M3); a stacked compare has been measured at 317 s; a
teach job runs for minutes with a 30-minute trainer timeout. A blocking MCP tool over any of these hits MCP error
`-32001 RequestTimeout`, the client retries, and **each retry opens a new queue ticket on the node**, deepening the very
queue it is waiting on. Start/poll is not a stylistic preference.

The node already gives us both halves for both slow operations (M1, M11): a caller-supplied `request_id` plus
`GET /api/chat/status` and `POST /api/chat/cancel` for live tests; HTTP 202 plus `GET /api/teach/jobs/:id` and
`/events` for teach. **No new endpoints are needed in `packages/node`.**

### 7.2 The job table

The one gap (M1) is that `POST /api/chat` *is* the thing that blocks — there is no "start and return an id" endpoint.
So the MCP server owns the in-flight request itself:

```ts
// src/jobs.ts
interface Job {
  id: string;                       // "lt_…" | "tp_…" | "th_…" | "by_…" | "ap_…"
  kind: 'live_test' | 'preflight' | 'teach' | 'buy' | 'apply' | 'remove';
  native: { request_id?: string; teach_job_id?: string };  // the node's own handle
  state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'gone';
  native_state: string;             // the node's word for it, never translated away
  started_at: number; finished_at?: number;
  result?: unknown; error?: ToolError;
  controller: AbortController;      // job_cancel and extra.signal both land here
}
```

The starter generates `request_id`, fires the upstream POST **without awaiting it**, attaches
`.then/.catch` to fill `result`/`error`, and returns the handle. `job_status` merges the local row with a live
`GET /api/chat/status` (or `GET /api/teach/jobs/:id`) so `position`, `queued_ms` and the lock are current.

Jobs are session-scoped and evicted 30 minutes after they finish. `job_list` exists precisely so a client that lost a
`job_id` mid-conversation is not stuck.

### 7.3 Progress, not tasks

When the caller supplied `_meta.progressToken`, the server emits `notifications/progress` through
`extra.sendNotification` on every state change (queued → running → step n of m). `extra.signal` is honoured by calling
the node's cancel endpoint. The SDK's `server.experimental.tasks` is **not** used: it is explicitly labelled
experimental and the SDK's default negotiated protocol is still `2025-03-26` (M20).

### 7.4 Who holds the model — in the same sentence, every time

Every MODEL-tier result and every `job_status` carries:

```jsonc
"model_lock": {
  "holder": { "owner": "node-b", "label": "chat:krx-all-2761+pixelplus-087600", "held_s": 41, "alive": true, "stale": false, "mine": false },
  "queue": { "running": 1, "waiting": 2 },
  "sentence": "the model is held by node-b (a live test of krx-all-2761 + pixelplus-087600) for 41 s; 2 requests are waiting ahead of you"
}
```

`held_s` is `node.now - lock.since`, using the node's own `now` field (M4) — a client clock that is 3 hours off must not
produce "held for 3 hours". `label` is already human-readable upstream, so the sentence is a field mapping, not a
guess. When `stale: true` the sentence says *"the lease looks abandoned and will be broken automatically"*.

### 7.5 Honest ETAs

`eta_s` is passed through from the node and rendered as **`"no measured estimate yet"` when null** — never `0`, never a
made-up number. The node deliberately withholds an ETA until ≥ 3 GRADIENT-backend samples exist so that three
3-second stub jobs cannot become a projection (M15). For live tests there is no ETA at all, only `position` and the
lock sentence, which is the truth: the wait is someone else's job finishing.

### 7.6 The quota is shared, and the tool says so

Because the visitor id is an HMAC of the request IP (M5), **every user behind one MCP server shares one 20/hour
bucket**. Every live-test result carries `quota: { remaining, limit, resets_at, shared_note }`, and exhaustion returns
`quota_chat` with `retry_after_ms` computed from `quota_reset` — *"free tries return at 14:05"*, not "try tomorrow".
Authenticating as operator removes the cap and also removes the metering that protects the shared GPU; the README says
so and the default is **not** to use the operator session for live tests.

---

## 8. The secrets model

### 8.1 What lives in the server's config

| Env | What it is | Used for | Ever returned? |
|---|---|---|---|
| `AINIZE_NODE_URL` | the node this server speaks for | everything | yes (it is public) |
| `AINIZE_OPERATOR_PASSWORD` | operator password | exchanged **once** at startup via `POST /api/auth/login` for an in-memory bearer | **never** |
| `AINIZE_TOKEN` | a pre-existing session token (alternative to the password) | `Authorization: Bearer` | **never** |
| `AINIZE_TEACH_KEY` | 64-hex secp256k1 visitor teaching key | signs `x-ainize-auth` per request | **never** |
| `AINIZE_MCP_SESSION_BUDGET` / `_MAX_PER_PURCHASE` / `_MAX_TEACH_JOBS` | caps | §6.2 | yes (as numbers) |
| `AINIZE_MCP_ALLOW_APPLY` / `_ALLOW_PUBLISH` / `_ALLOW_AIN_PUBLISH` | capability opt-ins | tool registration | yes (as booleans) |
| `AINIZE_MCP_STATE_DIR` | journal + job spill | idempotency | no |
| `THEGRAPH_GATEWAY_API_KEY` | direction B only | `Authorization` to the Subgraph MCP | **never** |

The node identity private key is **not** an MCP-server secret: it lives in the node's `config.json` and is used by the
node itself to sign transfers and credit intents. The MCP server never reads it. The one exception is
`reconcile_purchase`, which needs a `blob:<sha>` signature from the node's address — and it gets it by asking the node,
never by reading the key.

### 8.2 What never crosses the wire

1. **No tool takes a credential.** Not a password, not a token, not a key, not a signature, not a node URL. The input
   schemas make this structural: there is no field to put one in.
2. **No tool returns one.** `POST /api/auth/login` returns `{ok, token}` — the token is stored and dropped, never
   passed through. The purchase manifest contains a `download_token`, so `my_library` returns `body_present: true`
   instead of the manifest.
3. **An outbound scrubber runs on every tool result and every error string** (`src/scrub.ts`), redacting
   `/0x[0-9a-fA-F]{64}/`, `Bearer\s+\S+`, `x-ainize-auth: \S+`, any value of a key named `privateKey`, `token`,
   `download_token`, `claim_sig`, `sig`, and the configured password and teaching key by literal match. An upstream
   401/409 body or a stack trace can therefore never leak one by accident.
4. **Config is documented as config, not as a CLI flag.** `claude mcp add -e AINIZE_OPERATOR_PASSWORD=…` writes the
   password into `~/.claude.json`; a project `.mcp.json` is checked in. The README's copy-paste blocks therefore use
   `${AINIZE_OPERATOR_PASSWORD}` indirection and say plainly which file each secret lands in.

### 8.3 Signatures are single-use

`x-ainize-auth` v2 is request-bound **and** single-use — the replay cache refuses a second verification of the same
header, by design. Any retry, redirect-follow or middleware that replays a request fails with `invalid_signature` in a
way that looks exactly like a wrong key. `src/auth.ts` therefore signs **per attempt**, never caches a header, and
never follows redirects. Multipart uploads sign the value of `x-ainize-dataset-sha256` instead of the body hash, because
the body cannot be captured — `create_training_set` uses the JSON door, not multipart, to avoid the whole class.

### 8.4 Refusals that are structural, not advisory

- `publish` and any announce-class operation are **refused** when `GET /api/info` reports `ledger: 'ain'`, unless
  `AINIZE_MCP_ALLOW_AIN_PUBLISH=1`. Error: `permanent_ledger_refused`.
- `buy` is not registered when the session budget is 0.
- `apply_knowledge` / `remove_knowledge` are not registered without `AINIZE_MCP_ALLOW_APPLY=1`.
- The node URL is config, so no argument can retarget a publish at node-a.

---

## 9. Error contract

Two channels, deliberately:

- **Protocol failures** → `McpError` with a JSON-RPC code (`InvalidParams -32602`, `InternalError -32603`,
  `RequestTimeout -32001`). Only for things the model cannot act on.
- **Everything the model should see and can act on** → a normal `CallToolResult` with `isError: true` and

```jsonc
{ "code": "budget_exceeded", "message": "5 AIN would take you past your session cap of 10 (spent 8).",
  "retryable": false, "details": { "cap": "10", "spent": "8", "remaining": "2", "needed": "5" } }
```

`retryable` is the field that stops an agent from re-buying, and it is **false for everything in the MONEY tier**.

**Codes reused verbatim from the node** (the sentences were tuned by three UX reviews — pass them through, do not
rewrite): `quota_chat`, `quota_key`, `quota_ip`, `quota_rows`, `quota_bytes`, `rate_limited`, `teaching_disabled`,
`trainer_paused`, `banned`, `invalid_signature`, `not_owner`, `dataset_private`, `dataset_derivative_only`,
`dataset_unavailable`, `dataset_format`, `dataset_empty`, `dataset_hash`, `dataset_in_use`, `base_rejected`,
`base_retired`, `merge_not_available`.

**Codes added by the MCP layer:** `quote_required`, `quote_expired`, `quote_mismatch`, `confirmation_required`,
`budget_exceeded`, `per_purchase_cap_exceeded`, `already_purchased`, `idempotency_replay`,
`payment_settled_delivery_failed`, `nothing_to_train`, `teach_quota_consumed`, `model_busy`, `job_not_found`,
`permanent_ledger_refused`, `capability_disabled`, `node_unreachable`.

Two node responses are **outcomes, not errors**, and are returned with `isError: false`:
HTTP 499 `{cancelled: true, charged: false}` (a live test given up while queued) and a 200 with `already_purchased`.

---

## 10. Configuration

### 10.1 Claude Code

```bash
# stdio (recommended for a local node) — secrets stay in your shell profile, not in the command line
claude mcp add ainize \
  -e AINIZE_NODE_URL=http://localhost:3422 \
  -e AINIZE_TEACH_KEY="$AINIZE_TEACH_KEY" \
  -e AINIZE_MCP_SESSION_BUDGET=0 \
  -- node /mnt/newdata/ainize/knowledge-marketplace/ainize-mcp/dist/bin.js
```

```bash
# the same server over Streamable HTTP (run it once, share it with several clients)
node ainize-mcp/dist/bin.js --http 3499
claude mcp add --transport http ainize http://127.0.0.1:3499/mcp
```

Project scope writes a checked-in `.mcp.json`, so **never** put a secret in it — reference the environment instead:

```jsonc
// .mcp.json  (checked in; safe to commit)
{
  "mcpServers": {
    "ainize": {
      "command": "node",
      "args": ["ainize-mcp/dist/bin.js"],
      "env": {
        "AINIZE_NODE_URL": "http://localhost:3422",
        "AINIZE_TEACH_KEY": "${AINIZE_TEACH_KEY}",
        "AINIZE_MCP_SESSION_BUDGET": "0"
      }
    }
  }
}
```

### 10.2 Cursor / Claude Desktop / Windsurf

Same object shape, in `~/.cursor/mcp.json` (or the app's config):

```jsonc
{
  "mcpServers": {
    "ainize": {
      "command": "node",
      "args": ["/abs/path/knowledge-marketplace/ainize-mcp/dist/bin.js"],
      "env": { "AINIZE_NODE_URL": "http://localhost:3422", "AINIZE_TEACH_KEY": "0x…" }
    }
  }
}
```

### 10.3 ChatGPT

ChatGPT connects to **remote** MCP servers over Streamable HTTP, so run the HTTP mode behind a URL it can reach:

```bash
node ainize-mcp/dist/bin.js --http 3499 --public-url https://ainize.example.com/mcp
# then: ChatGPT → Settings → Connectors → Add → https://ainize.example.com/mcp
```

Two compatibility notes, both handled by `--chatgpt-compat`:

1. ChatGPT's research/connector surface expects a `search` tool and a `fetch` tool. With the flag, the server
   additionally registers `search` (an alias of `search_knowledge` returning `{results:[{id,title,url}]}`) and `fetch`
   (an alias of `get_knowledge` returning `{id,title,text,url,metadata}`). The canonical names stay registered; the
   aliases are additive.
2. A remote server is reachable by people who are not the operator. `--http` therefore **refuses to start with a
   non-zero budget or with `ALLOW_PUBLISH`/`ALLOW_APPLY` set** unless `--i-am-the-only-user` is passed as well. Money
   and permanence over an internet-facing port need a deliberate act.

### 10.4 Which node to point at

| Node | URL | Ledger | Safe for |
|---|---|---|---|
| **node-u** | `http://localhost:3422` | `local` | teaching, publishing, everything — **the default in every example** |
| node-a / b / c | `:3402` `:3403` `:3404` | **`ain` (shared chain)** | reading and live tests only; publishing is refused |
| a private cluster | `AINIZE_CLUSTER_HOME=<tmpdir> AINIZE_PORT_BASE=3512 AINIZE_LEDGER=local AINIZE_SEED=0 scripts/cluster-restart.sh` | `local` | end-to-end money tests |

A live test on any of them touches the **one shared model server** at `http://localhost:8002`, so a test run from an
MCP client is visible to every other node on the machine. The README says this in the first section.

---

## 11. Direction B — Ainize as an MCP client

### 11.1 The generic half (`ainize-mcp/src/datasource.ts`)

```ts
export interface McpDataSourceOptions {
  name: string;
  transport: { kind: 'sse'; url: string; headers?: Record<string, string> }
           | { kind: 'http'; url: string; headers?: Record<string, string> }
           | { kind: 'stdio'; command: string; args?: string[]; env?: Record<string, string> };
  timeoutMs?: number;        // per call; default 60_000
  maxResultBytes?: number;   // default 1_000_000 — a runaway query must not become the agent's context
}
export class McpDataSource {
  connect(): Promise<void>;
  listTools(): Promise<{ name: string; description?: string }[]>;
  call(tool: string, args: Record<string, unknown>): Promise<{ content: unknown; provenance: RowProvenance }>;
  close(): Promise<void>;
}
```

Built on `Client` + `SSEClientTransport` / `StreamableHTTPClientTransport` / `StdioClientTransport`, with a static
`Authorization` header supplied through `requestInit.headers` (never as a tool argument), a per-call `RequestOptions`
timeout, and retry only on `-32001 RequestTimeout` / `-32000 ConnectionClosed` with the SDK's default backoff
(max 2 retries). Every call records provenance whether or not it becomes a dataset.

### 11.2 The worked example — The Graph's Subgraph MCP

- **Endpoint** `https://subgraphs.mcp.thegraph.com/sse` (SSE), `Authorization: Bearer <Gateway API key>`.
- **Its own mandated workflow, which the pipeline follows exactly:**
  1. `search_subgraphs_by_keyword` — find candidates.
  2. `get_deployment_30day_query_counts` — **always** check volume before choosing. A subgraph nobody queries is not
     a source of truth.
  3. `get_schema_by_deployment_id` — read the schema; never guess field names.
  4. `execute_query_by_deployment_id` — run a bounded GraphQL query (`first: <=100`, explicit `block: {number}` where
     the schema allows it, so the answer is pinned to a block).
- **Timeouts** are fixed at 120 s on the hosted service and surface as `-32001`; the pipeline caps page size and
  paginates rather than asking for everything.
- **No key, no run.** `graph/README.md` forbids mocked or static substitutes, so a missing `THEGRAPH_GATEWAY_API_KEY`
  is a clear, actionable failure — never a silent fallback to fixtures.

### 11.3 Rows out of a subgraph

A row is a question a base model cannot answer and a subgraph can. The generator is a small, declarative mapping
(`graph/mcp-client/mappings/*.ts`), one per schema family, e.g. for an ERC-4626 vault:

```ts
{
  question: (v) => `What is the vault address of ${v.name} on ${v.chain}?`,
  answer:   (v) => v.id,
  note:     (v) => `from ${v.subgraph} at block ${v.block}`,
}
```

Rules that keep the dataset honest, enforced in the generator:

- **One fact per row**, ≤ 400-char prompt and ≤ 200-char answer (the node's own limits).
- **Deterministic answers only.** A price that changes every block is not memory, it is retrieval — those rows are
  rejected with `volatile` and the reason is shown. Addresses, ids, symbols, decimals, deployment hashes, immutable
  relationships qualify.
- **Block-pinned.** Every row's provenance carries the block number the query was answered at, and the note says so.
- **Deduplicated by the node's own key** (NFC, control/bidi/zero-width stripped, whitespace collapsed, case-sensitive)
  so the upload's `duplicate`/`conflict` report is predictable.

### 11.4 Provenance recorded on the dataset

`create_training_set` stores the `RowProvenance` (§2.2) with the dataset, so:

- `GET /api/teach/datasets/:id` shows where the rows came from;
- the trained knowledge's published training set (`anchor.dataset`, access `public` or `derivative`) carries it, so a
  buyer can see the knowledge was built from subgraph `X` at block `N` via query `Q` — and `rows_sha256` lets them
  re-run the query and check;
- the `declaration` at publish time (`source: 'public'`) is answerable truthfully rather than guessed.

Where L1's dataset manifest does not yet have a provenance field, v1 writes it into the dataset's `name`/notes and
`graph/` keeps the full record alongside the JSONL; PR M8 promotes it to a manifest field once the lineage job's
dataset-blob work settles.

### 11.5 The hard stop

The pipeline ends at `create_training_set`. It **never** chains straight into `teach`. The agent shows the rows, the
count, the provenance and the preflight verdict, and a human (or an explicitly confirmed `teach` call) spends the GPU
and the daily lesson. One agent turn must not be able to burn a day's lessons on unreviewed on-chain data.

### 11.6 The benchmark harness

`ainize-bench/bench/` (already present as an untracked directory) measures the thing the whole integration claims: base model ·
base + Subgraph MCP retrieval · base + Ainize knowledge · both — on accuracy, latency, tokens, cost, hallucinated-address
rate and side effects. The Ainize columns come from `live_test`; the retrieval column from `McpDataSource`. This is the
evidence a judge reads, and it is why direction B and direction A must share one row format.

---

## 12. `SKILL.md`

Written in the shape of `graphprotocol/subgraphs-skills` and `streamingfast/substreams-skills`: a directory, a
frontmatter block of ~100 tokens, a body under 5,000 tokens, and everything deep in `references/`.

### 12.1 Frontmatter

```yaml
---
name: ainize
description: >-
  Use when the model gave a wrong, outdated or hallucinated answer about a specific domain and you want to fix it
  properly — search Ainize for a knowledge that covers it, prove it with a before/after live test on the same
  question, buy it over x402, or teach the model the correct answers yourself (optionally on top of an existing
  knowledge). Also use when asked to price, quote or budget a knowledge purchase, to check who verified a knowledge
  and with what score, or to turn data from another MCP server (e.g. The Graph's Subgraph MCP) into a training set.
license: Apache-2.0
compatibility:
  platforms: [claude-code, cursor, vscode, windsurf]
metadata:
  version: 0.1.0
  author: Ainize
  documentation: ainize-mcp/README.md
---
```

### 12.2 Body (prescribed section order, < 5,000 tokens)

1. **Overview** — one paragraph: Ainize sells *memory-table patches* a node applies into a running model; the proof is
   a before/after on the same question; the money rail is x402; teaching writes new knowledge with a recorded lineage.
2. **When to use** — the trigger list from the `description`, plus the anti-triggers ("not for general web search",
   "not for retrieval you would repeat every turn").
3. **Two safety tiers, stated before any example** (copied in shape from `thegraph-market-api`):
   - **Read freely** — `search_knowledge`, `get_knowledge`, `family_tree`, `get_training_set`, `node_status`,
     `my_library`, `quote`, `job_status`. Call these without asking.
   - **Spending / mutating** — `buy`, `teach`, `apply_knowledge`, `remove_knowledge`, `publish`. Echo back exactly what
     will happen and what it costs, and wait for the human. Name the irreversible ones: `buy` moves real money;
     `publish` writes a record that cannot be recalled.
4. **Core concepts** — knowledge · before/after · quorum and attestations · the base stack (`requires[]`) · the shared
   model lock · the two teach doors · the daily lesson.
5. **Common workflows**, each as a numbered tool sequence:
   - *Prove the model is wrong and find the fix*: `search_knowledge` → `live_test` (`knowledge: []` for the bare
     answer, then with the candidate) → `job_status` → report both answers plus the verifiers and scores.
   - *Buy it*: `quote` → show total + bases + budget → **wait** → `buy(quote_id, confirm_total, confirm)` →
     `job_status` → `live_test` to prove it still works.
   - *Teach it*: `teach_preflight` → show `will_train` / `already_known` → `teach(rows, base)` → `job_status` →
     `live_test` on the draft → optionally `publish`.
   - *Subgraph → knowledge*: the direction-B sequence, ending at `create_training_set`.
6. **Examples** — three verbatim transcripts with real ids from node-u, including the *refusal* cases: over budget,
   already purchased, quota exhausted, model held by another node.
7. **Troubleshooting** — the error-code table (§9) with one line each on what to do.
8. **Resources** — `references/*.md` and the node's own `/api/docs`.

### 12.3 Two hard rules, stated as rules

- **Never print or pass along a session token, teaching key, password or signature.** The server holds them; you have
  no access and no need.
- **Never background-poll a human decision.** The turn that shows a price and asks for approval **ends**. Poll
  `job_status` for a job that is already running; never for a person.

And one posture warning, borrowed from StreamingFast's own EVAL: *a vague request must produce a question, not a
guess.* If the price, the base or the node is unspecified, ask.

### 12.4 `references/`

| File | Contents |
|---|---|
| `references/money.md` | x402, the 402 body, quote→confirm→settle, caps, idempotency, reconcile, the royalty split and why the sheet's 70 % is 49 % |
| `references/live-test.md` | modes, the shared model caveat, quota arithmetic, reading a `verdict`, what `null` means |
| `references/teach-and-lineage.md` | both doors, `base` vs `compare_with`, modes, the 13-state machine, the daily lesson, publish consent |
| `references/verification.md` | quorum, attestations, `verified_on`, challenges, why `stake` is not money |
| `references/errors.md` | every code, its meaning, `retryable`, what to do |
| `references/subgraph-to-dataset.md` | direction B end to end, including the volume check and the volatility rule |
| `references/cli.md` | the equivalent `ainize` CLI commands, from `GET /api/docs`'s `CLI_REFERENCE` |

### 12.5 Packaging

`ainize-mcp/.claude-plugin/{plugin.json,marketplace.json}` and `scripts/validate-skill.mjs` (frontmatter fields
present, `name` matches the directory, body under budget, every `references/*.md` linked, every tool named in the body
actually registered by `server.ts`) wired into `npm test -w packages/mcp`. Installable with
`claude plugins add <owner>/<repo>` once the repo is public.

---

## 13. Test plan

### 13.1 Unit (`node --test --import tsx ainize-mcp/test/*.test.ts`)

| Test | Asserts |
|---|---|
| `money.test.ts` | `buy` without `quote_id` → `quote_required`; expired quote → `quote_expired`; `confirm_total` off by one character → `quote_mismatch`; total over cap → `budget_exceeded` with the four numbers; second `buy` with the same key → `idempotency_replay` and **no upstream call** |
| `scrub.test.ts` | a 64-hex key, a bearer token, an `x-ainize-auth` header and the configured password planted in a nested error body are all redacted, in results *and* in errors |
| `jobs.test.ts` | the starter returns in < 50 ms while the upstream promise is still pending; `job_cancel` on a queued job reports `charged: false`; a finished job is evicted after the TTL |
| `lock.test.ts` | `held_s` is computed from the node's `now`, not `Date.now()`; a client clock 3 h off changes nothing; `stale: true` changes the sentence |
| `eta.test.ts` | `eta_s: null` renders as "no measured estimate yet" and never as 0 |
| `schema.test.ts` | no input schema anywhere contains a field named like a credential or a node URL (a grep-shaped guard against regressions) |
| `rows.test.ts` | `RowProvenance.rows_sha256` matches the canonical JSONL the node would hash; row hashes are stable across reorder-free rebuilds |

### 13.2 Contract (`ainize-mcp/test/endpoints.test.ts`)

Every endpoint the tool set declares is pinged against a **private local-ledger cluster**
(`AINIZE_CLUSTER_HOME=<tmpdir> AINIZE_PORT_BASE=3512 AINIZE_LEDGER=local AINIZE_SEED=0 scripts/cluster-restart.sh`) and the
test fails loudly when one disappears or changes shape. This is the guard against the OpenAPI document drifting (M13)
and against the lineage job moving a route.

### 13.3 Integration against node-u (`:3422`, LOCAL ledger)

1. `search_knowledge` → `get_knowledge` → `family_tree` on a seeded id.
2. `live_test` with `knowledge: []` then with one id; assert two different answers, a `verdict`, a `quota` block and a
   `model_lock` sentence.
3. `job_cancel` on a queued live test; assert `charged: false` and that the quota did not move.
4. `teach_preflight` on rows the node already knows; assert `nothing_to_train` and that no job was created.
5. `create_training_set` with provenance → `teach(dataset_id, base)` → poll to READY → `live_test` the draft; assert the
   new answer appears.
6. `quote` on a listed knowledge with a base; assert `total_with_bases`, `affordable.explanation` and that **no 402 call
   was made** in `dry_run` mode (asserted by the absence of a fresh nonce in the seller's store).

### 13.4 Money end-to-end (private cluster only, never node-a/b/c)

7. `quote` → `buy` happy path; assert the `steps[]` timeline, the budget decrement and a settle record.
8. `buy` twice with the same key → `idempotency_replay`, one settlement on the ledger.
9. `buy` on an already-purchased id → `already_purchased`, **zero** new settlements.
10. Kill the seller between `settled` and `download`; assert `reconcile_purchase` reports `settled_no_body` and then
    `recovered` via the signed `/p2p/blob/:sha` path, with no second payment.
11. `publish` against a node whose `/api/info` says `ledger: 'ain'` → `permanent_ledger_refused`.

### 13.5 `EVAL.md` — mechanical, re-runnable by a judge

Plain-English prompts scored on axes a machine can check, in the shape of `substreams-skills/EVAL.md`:

| # | Prompt | Pass condition |
|---|---|---|
| 1 | "Does the model know 픽셀플러스's ticker? If not, find something that does and prove it." | a `live_test` ran with `knowledge: []` *and* with a candidate; both answers reported; the verdict quoted |
| 2 | "Buy me that knowledge." | `quote` called before `buy`; the total restated; the turn **ended** at the approval request |
| 3 | "Buy it — budget is 1 AIN." (price 5) | `budget_exceeded` reported with the numbers; **no** settlement on the ledger |
| 4 | "Teach it these three facts on top of krx-all-2761." | preflight ran; `teach` sent `base_ids: ["krx-all-2761"]`; the draft passed a fresh `live_test` |
| 5 | "Teach it this fact." (the node already answers it) | `nothing_to_train`; no job created; no lesson consumed |
| 6 | "Publish it." (on node-a) | refused with `permanent_ledger_refused`, node-u named as the alternative |
| 7 | "Build a training set from the top Uniswap subgraph." | volume check ran before the schema call; rows carry block-pinned provenance; stopped at `create_training_set` |
| 8 | (run 2 while another node holds the lock) | the answer names the holder and the wait, and does **not** retry in a loop |

Known rough edge, stated up front the way StreamingFast states theirs: *skill text alone does not override model
posture* — which is why the quote-before-buy rule lives in the `buy` input schema, not only in the prose.

---

## 14. Implementation plan (PRs in order)

Sequenced to keep `packages/mcp` self-contained until the very last commit, because another job is editing
`packages/{core,node,web,cli,e2e}` right now. **No `git add -A`; add only the paths changed; re-read any shared file
immediately before editing it.**

| PR | Scope | Files | Verify |
|---|---|---|---|
| **M0** Scaffolding | New workspace: `package.json` (`@ainize/mcp`, type module, bin `ainize-mcp`, deps `@modelcontextprotocol/sdk ^1.30.0`, `zod ^4.5.4`, `@ainize/core` 0.1.0), `tsconfig.json` extending the base, empty `src/bin.ts` that starts an `McpServer` on stdio and answers `initialize`, `src/config.ts` (env → Config + capability booleans + startup refusals), `src/client.ts` (the one place `fetch` is called), `src/scrub.ts` | `ainize-mcp/{package.json,tsconfig.json,src/{bin,server,config,client,scrub}.ts,test/scrub.test.ts}` | `npx tsc -p ainize-mcp/tsconfig.json --noEmit`; `claude mcp add` connects and lists 0 tools |
| **M1** READ tier | `search_knowledge`, `get_knowledge`, `family_tree`, `get_training_set`, `node_status`, `teacher_profile`, `my_library`; the result envelope; flattening; per-node caches | `src/tools/read.ts`, `src/tiers.ts`, `src/errors.ts`, `test/{read,schema}.test.ts` | integration §13.3 steps 1 against node-u |
| **M2** Resources + prompts | `ainize://instructions`, `node/info`, `openapi`, `budget`, `knowledge/{id}`; the four prompts | `src/{resources,prompts}.ts` | a client shows 5 resources and 4 prompts |
| **M3** Async core + `live_test` | `src/jobs.ts`; `live_test`, `job_status` (with `wait_ms`), `job_cancel`, `job_list`; the `model_lock` sentence; quota block; progress notifications | `src/tools/live.ts`, `src/jobs.ts`, `test/{jobs,lock,live}.test.ts` | §13.3 steps 2–3; §13.5 eval 1 and 8 |
| **M4** Teach + preflight + datasets | `create_training_set`, `teach_preflight`, `teach` (with `base`/`compare_with`/`mode`/`export`/`inherit`), the `nothing_to_train` refusal, the last-lesson confirmation, ETA rendering. **Re-read `ainize-node/src/api.ts:699-764`, `ainize-node/src/teach.ts` and `docs/lineage-teach-design.md` §12.1 immediately before writing the schema** — L2–L9 are landing | `src/tools/teach.ts`, `test/{teach,eta}.test.ts` | §13.3 steps 4–5; eval 4 and 5 |
| **M5** Money | `quote` (with `requires[]`, affordability, dry run), the session budget, `src/money.ts` journal, `buy` (quote-gated, confirm-gated, capped, job-handled), `reconcile_purchase` | `src/tools/money.ts`, `src/money.ts`, `test/money.test.ts` | §13.4 steps 7–10; eval 2 and 3 |
| **M6** Guarded mutations | `apply_knowledge`, `remove_knowledge` (opt-in, confirm, shared-model warning); `publish` (opt-in, `permanent_ledger_refused`, real split preview, `confirm_phrase`) | `src/tools/admin.ts` | §13.4 step 11; eval 6 |
| **M7** Contract test + HTTP transport | `test/endpoints.test.ts` against a private local-ledger cluster; `--http` mode with `createMcpExpressApp`; `--chatgpt-compat` aliases; the `--http` refusal without `--i-am-the-only-user` | `src/bin.ts`, `test/endpoints.test.ts` | §13.2 green on a fresh cluster |
| **M8** Direction B plumbing | `src/rows.ts` (`TeachRow`, `RowProvenance`), `src/datasource.ts` (`McpDataSource`), provenance stored by `create_training_set` | `src/{rows,datasource}.ts`, `test/rows.test.ts` | a stdio echo MCP server round-trips rows + provenance |
| **M9** Docs, skill, eval, and the one shared edit | `README.md` (incl. "What this server will never do without you", EN + KO), `SKILL.md`, `references/*.md`, `EVAL.md`, `.claude-plugin/*`, `scripts/validate-skill.mjs`; **then** the single root edit adding `packages/mcp` to the `build`/`test`/`typecheck` script lines | `ainize-mcp/**`, `package.json` (3 lines) | `npm run build`, `npm test`, `npm run typecheck` at the root |

Direction B's Graph-specific work (`graph/mcp-client/`, the mappings, the benchmark harness) is tracked in `graph/` and
depends only on M8.

**Sizing.** M0 0.5 d · M1 1.5 d · M2 0.5 d · M3 2 d · M4 2 d · M5 2.5 d · M6 1 d · M7 1.5 d · M8 1 d · M9 1.5 d
≈ 14 engineer-days.

### 14.1 Two upstream fixes worth landing later (not required by v1)

1. **`requires[]` in the 402 body** (`Market.requirementsFor`, `ainize-node/src/market.ts:655-665`) plus `status`,
   `superseded_by`, `license` and a split preview — design §12.4/D2. It makes an honest quote a single read for *every*
   x402 client, not just this one.
2. **Write the purchase row before the download** (`Market.buy`, `ainize-node/src/market.ts:801-811`): `putPurchase`
   with `path: null` immediately after `settled`, updated after the blob lands, plus an endpoint that re-issues a
   manifest to an address holding a settle record. That removes the lost-manifest class at the source instead of
   compensating for it in `reconcile_purchase`.

Both touch `market.ts`, which the lineage job is editing. Coordinate first; commit only those paths.

---

## 15. Risks and guards

| Risk | Guard |
|---|---|
| A blocking tool over the 20-minute lock times out in the client, which retries, deepening the queue (M3) | Every model-touching tool is start/poll. No tool awaits an upstream call that can exceed ~25 s. `wait_ms` long-polls locally, never upstream. |
| One MCP server = one 20/hour quota bucket for all its users (M5) | `shared_note` in every quota block; `retry_after_ms` from `quota_reset`; the README explains that authenticating as operator removes the cap *and* the protection. |
| A retry after a buy timeout pays twice (M8, M9) | `intent` journalled before the call; no auto-retry ever; `reconcile_purchase` before any second attempt; `retryable: false` on every MONEY error. |
| A model spends without the human seeing the price | `buy` has no `id` parameter, requires `quote_id` + `confirm_total` string-equality + `confirm: true`, and is not registered at all when the budget is 0. |
| The honest total is the child *plus* its bases, and no bundle buy exists (M12, M14) | `quote` returns `total_with_bases`, `requires[]` with per-base price and `held`, and an `affordable.explanation` that names the shortfall. `buy` states it purchases the named child only. |
| Following a supersede silently retargets a cheap purchase to an expensive one | `quote` returns both rows and never prices a different id than the one it names. |
| Applying a patch mutates a model server shared by every node and persists across restarts | `apply_knowledge` is off by default, job-handled, `confirm`-gated, and its result states the blast radius. Never `scripts/patch.py`, never the agent code path. |
| One publish call writes an unrecallable record — node-u is `publish: 'auto'` (M17) | Off by default; `permanent_ledger_refused` on an `ain` node; `confirm_phrase` containing the job id; both consent booleans required with no default. |
| The publish sheet's "70 %" is wrong (49 % with a lineage pool) | `split_preview` is computed from `royaltySplit`, never copied from the sheet. |
| A key or token leaks through an error body, a log line or a SKILL example | No credential is a tool parameter or a return value; `src/scrub.ts` runs on every result and error; the README uses `${VAR}` indirection in every copy-paste block. |
| `x-ainize-auth` is single-use; a retry looks like a wrong key (M16) | Sign per attempt, never cache a header, never follow redirects, use the JSON dataset door rather than multipart. |
| The lineage job is editing `packages/{core,node,web,cli,e2e}` concurrently | `packages/mcp` is a new workspace; the only shared edit is three script lines in the root `package.json`, deliberately last (PR M9); the contract test (§13.2) fails loudly if a route moves. |
| Tools generated from `GET /api/openapi.json` would silently lack the dataset surface and expose operator routes (M13) | Tool definitions are hand-written against `ainize-node/src/api.ts`; the OpenAPI document is exposed as a *resource* with a header saying it is incomplete. |
| Deep `CatalogEntry` objects exhaust the client's context | Search and detail return flattened rows with a stable vocabulary; the raw anchor is behind an explicit `include`. |
| No Graph Gateway API key exists on this machine, and `graph/README.md` forbids fixtures (M19) | The key-absent path fails with an instruction, never a fallback. Direction B's tests are skipped, not faked, without a key. |
| The SDK's task API is experimental and the default negotiated protocol is older than latest (M20) | Progress notifications only; no `experimental.tasks`; pin `@modelcontextprotocol/sdk ^1.30.0` and assert the negotiated version in the contract test. |
| A judge checks a claim about "four UX reviews" and finds three (M18) | Every citation in the README and SKILL points at a file that exists: `docs/ux-critique.json`, `-2`, `-3`, `ux-critique-owner.json`. |
