# Agent memory — an agent that ainizes its own experience

**Status:** design (2026-09-07). Written against the working copy of the same day; `packages/{core,node,web}` have
uncommitted edits from other sessions, so every line reference below must be re-read before code is written. **No
product code was changed for this document.** Nothing here was executed except the reads in §0.

**Owner's direction,** verbatim: *"메모리를 agent 에 붙여서 agent 기능도 넣어야돼"* — attach memory to the agent and give it
agent capability. The submission line is *"agents that ainize their own experience"*, so the agent must **accumulate**
memory rather than borrow it, and it must perform the product's own verb **on itself**: turn what it experienced into a
knowledge.

**The loop, in one paragraph.** A question arrives. Can the agent answer it from the memory it already carries? Then it
answers — no query, no cost. If not, is there a LISTED knowledge that covers it? Then buy it, apply it, and **keep** it.
If not, ask The Graph through the MCP client — slow, and it costs a query every single time. And when the agent notices
it has looked up the *same shape of thing* enough times that querying has already cost more than compiling would, it
**ainizes it**: builds a dataset out of what it retrieved, runs it through teach, and keeps the resulting engram in its
own memory. `graph/bench` measures the static version of this claim (four arms, a break-even curve in the number of
buyers). This is the dynamic version, executed by the agent instead of asserted by us.

---

## 0. Verified facts this design stands on

Read from the tree on 2026-09-07. Nothing here is folklore, and nothing was measured on a GPU.

| # | Fact | Where |
|---|------|-------|
| A1 | The agent already does the whole purchase: gap → catalog pick with quorum → `GET /x402/…` → 402 → pay (local-credit intent or AIN transfer) → verify manifest hash and body sha256 against the on-ledger anchor → apply without restart → re-ask. | `packages/agent/src/agent.ts:428-745` |
| A2 | **The default is already to LEAVE the knowledge loaded.** `--restore` defaults to `false` and `bin.ts` passes `keep: !a.restore`; the removal branch runs only `if (o.keep === false)`. The file header's "restore (unless `--keep`)" is stale prose. What is missing is not the keeping — it is that **nothing is written down about what the model now knows**. | `packages/agent/src/agent.ts:7,702-707`; `packages/agent/src/bin.ts:65,79` |
| A3 | The agent's only durable state is three files in `<home>`: `identity.json`, `purchases.jsonl` (patch_id, sha256, seller, amount, tx, path, at) and `pending-payments.jsonl` (the intent written *before* the money moves). There is no record of a question, an answer, a lookup or a fact. | `packages/agent/src/agent.ts:246-305`; `packages/agent/src/identity.ts:8-24` |
| A4 | `spentToday(home)` already derives per-currency spend since UTC midnight from `purchases.jsonl`, and `watch --budget-per-day` already refuses a purchase that would cross it, with the arithmetic in the refusal. It covers **money only**. | `packages/agent/src/agent.ts:293-301,918-919` |
| A5 | `runAgent` asks the serving model twice per run: once as a probe (`res.before`) and once after the apply (`res.after`). `--no-probe` exists precisely because the shared model's answer belongs to whoever else has something loaded. | `packages/agent/src/agent.ts:484-488,697; :63-70` |
| A6 | The node's `applied` table is an **ordered stack**: `(patch_id PK, sha256, applied_at, reason, position, journal_path, stack_sha256)`, with `setApplied/listApplied/getApplied/reorderApplied`. | `packages/node/src/store.ts:231-232,1044-1060,1071-1083` |
| A7 | `GET /api/runtime` is **public** (no `requireOperator`) and returns `applied` (ordered ids), `stack[]` (per layer: `patch_id, sha256, position, rows, journal, stack_sha256, body_present, present, checked_at`), the runtime status and the queue. | `packages/node/src/api.ts:1424-1434`; `packages/node/src/market.ts:3151-3169` |
| A8 | The teach pipeline is reachable over HTTP with a **teaching key that is just a secp256k1 identity**: `POST /api/teach/datasets` (`source:'inline'`, `rows[]` ≤ 2000) → `POST /api/teach/jobs` (`dataset_id`, `base_ids`, `training`) → `GET /api/teach/jobs/:id` → `POST …/publish`. Auth is `x-ngram-auth: <address>:<ts>:<sig>:v2`, request-bound and single-use. | `packages/node/src/api.ts:1737-1762,1867-1921,1961`; `packages/node/src/teach-auth.ts:21-31` |
| A9 | The MCP package already contains the **whole** rows→dataset→preflight→job→poll pipeline as a tool handler, including the reservation of a scarce lesson and the refund on a refusal, plus `uploadTrainingSet()` as a plain exported function. | `packages/mcp/src/tools/teach.ts:65-114,288-460` |
| A10 | `McpDataSource` is the MCP **client**: `connect/listTools/readResource/call/fetchRows/close`, retries only on JSON-RPC `-32001/-32000`, caps the result at 1 MB, and returns `{elapsed_ms, provenance{server,tool,arguments,arguments_sha256,fetched_at}}`. `fetchRows` ends at rows — it deliberately does **not** chain into training. | `packages/mcp/src/datasource.ts:14-15,66-233` |
| A11 | A `RowMapping` is declarative JSON — `path`, `prompt`/`answer`/`alt_prompt`/`note` as `{field}` templates, `require`, `constants`, `max_rows` — mapped by `mapRows`, which enforces the node's own 400/200 char caps and de-dupes on the normalized prompt. `promptKey()` **is** the node's key; `rowsSha256()` reproduces the node's dataset id byte for byte. | `packages/mcp/src/rows.ts:96-103,146-232` |
| A12 | The live path against The Graph is `search_subgraphs_by_keyword` → `get_deployment_30day_query_counts` → `get_schema_by_subgraph_id` → `execute_query_by_subgraph_id({subgraph_id, query})` over SSE at `https://subgraphs.mcp.thegraph.com/sse`, and one `fetchRows` of it produces block-pinned rows whose `note` carries the provenance line. | `packages/mcp/test/smoke-subgraph-mcp.test.ts:20-89`; `packages/mcp/references/subgraph-to-dataset.md` |
| A13 | The node will not train an arbitrarily small lesson: `rowsPerJob.floorGradient = 8` (`floorStub = 200`), and the whole size derivation is skipped in favour of the floor while fewer than `ETA_MIN_SAMPLES = 3` gradient samples exist. Three stub jobs must never become an estimate. | `packages/core/src/config.ts:88,173,197,208` |
| A14 | A teach job charges one of `jobsPerKeyPerDay` **at submit**, before PREFLIGHT, and is never refunded; `ACTIVE_JOBS_PER_KEY = 2`. `NGRAM_TEACH_BACKEND=stub` selects a backend that copies a fixture npz, needs no GPU, and stamps `recipe.trainer='stub'` / `checks.simulated` onto everything it produces. | `packages/node/src/teach.ts:248,1149-1152,2135,2378-2407`; `packages/core/src/config.ts:350` |
| A15 | An anchor carries up to `TEACH_SAMPLES_ON_CHAIN = 32` `{prompt, expect}` benchmark samples; a knowledge's full training set is readable at `GET /api/patches/:id/dataset/rows` **only** when its access is `public` (or through a signed derive intent for `derivative`). | `packages/core/src/types.ts:57-63`; `packages/node/src/api.ts:684-690` |
| A16 | `graph/bench` defines the break-even as `N*(k buyers) = (knowledge_price / k) / (cost_per_question_B − cost_per_question_C)` and **leaves it uncomputed** in run `r1` because arms B and C are not both scored and priced. `pricing.json` carries `PLACEHOLDER` sources and `knowledge.price: null`. There is no measured N\* in this repo today. | `graph/bench/runs/r1/summary.md:120-133`; `graph/bench/pricing.json` |
| A17 | `Budget` in the MCP package is a check-and-hold with decimal-string arithmetic: `reserve()` throws `budget_exceeded` with cap/spent/remaining/needed, never clamps, and the cap is server configuration that **no tool argument can raise**. `PurchaseJournal` writes `intent` before the node is called. | `packages/mcp/src/money.ts:85-121,140-201` |
| A18 | `publish` is off by default in the MCP server (`AINIZE_MCP_ALLOW_PUBLISH`, plus a separate `AINIZE_MCP_ALLOW_AIN_PUBLISH`), and the server's own instructions name `buy` and `publish_knowledge` as the two things that cannot be undone. | `packages/mcp/src/config.ts:103-107`; `packages/mcp/src/server.ts:52-56` |
| A19 | There is no i18n machinery outside `packages/web/src/i18n` (`Dict = Record<string, {ko, en}>`). Every string in `packages/agent` and `packages/cli` is English. | `packages/web/src/i18n/index.ts:11`; `grep -rl i18n packages/*/src` |
| A20 | The agent package depends only on `@ngram/core`, `chalk`, `yargs`. `@ngram/mcp` exports **only** `"."`, whose index pulls the MCP server, express and the SDK. | `packages/agent/package.json`; `packages/mcp/package.json:6-12` |

---

## 1. The loop, mapped onto code that exists

```
ask "질문"
 │
 ├─0 recall(question)                       memory.jsonl index          0 network, 0 model     §3, §4
 │    hit & resident & cache-fresh  ──────► answer from memory                       cost: nothing
 │    hit & resident                ──────► ONE completion, scored against memory    cost: 1 completion
 │
 ├─1 catalog(question)                      fetchCatalog + pickPatch    agent.ts:146,202        §2
 │    a LISTED, quorum-met match    ──────► runAgent({patch, noProbe:true, keep:true})
 │                                          → purchases.jsonl (A1/A3) → memory: buy + learn events
 │
 ├─2 retrieve(plan)                         McpDataSource.fetchRows     datasource.ts:203       §5
 │    → rows + provenance           ──────► answer from the rows; memory: retrieve + learn events
 │                                          counters for the shape are updated here, not at step 0
 │
 └─3 shouldBake(shape)?                                                                         §6
      economic ∧ material ∧ stable ∧ budget
        ──────► bake: rows → POST /api/teach/datasets → POST /api/teach/jobs → poll  (A8, A9)
                → memory: bake event; the engram is KEPT; publishing is a separate, explicit act §8
```

Everything on the right-hand side exists. What this design adds is the left column: a memory, a shape counter, a
budget with more than one currency, and the arrows between them.

**`packages/agent/src/agent.ts` is not rewritten.** The loop calls `runAgent()` unchanged (with `noProbe: true`,
`keep: true`), so `run`, `watch`, and `packages/e2e/tests/agent-x402.spec.ts` behave exactly as they do today. The one
edit to that file is additive and described in §9.

---

## 2. Decision 1 — where the memory lives, and what happens when the two copies disagree

**Both, with an authority split, and neither is ever edited to match the other.**

| | Agent home `<NGRAM_AGENT_HOME>` | Node `applied` table (`GET /api/runtime`) |
|---|---|---|
| Authority on | what **this agent** knows, owns, retrieved, paid, baked, and believes | what is **on the model** right now |
| Survives | a restart, a reboot, the node being replaced, having no node at all | a node restart (it is SQLite); **not** a serving-model restart |
| Files | `memory.jsonl` (append-only), `memory-index.json` (derived snapshot), `spend.jsonl`, plus today's `identity.json` / `purchases.jsonl` / `pending-payments.jsonl` | `store.applied` (A6) |

**Why not only the node's table.** The agent is not the node's operator — the code says so in as many words
(`agent.ts:675`, "the serving model belongs to the node, and this agent is not its operator"); it may talk to several
markets; and it must work with no runtime at all (`--download-only`, and arm C's whole claim is that compiled memory
works offline). The table also answers a different question: it says which *files* are on the model, never which
*questions* are answerable, what a lookup cost, or what this agent looked up.

**Why not only the agent home.** Because a claim that a knowledge is loaded is not evidence that it is. The model is
shared; another tenant's live test can apply or remove a layer between two of this agent's runs.

**Why an append-only log rather than SQLite.** The agent's existing crash-safety story is "write the intent before the
irreversible act, in a line-per-event file" (`pending-payments.jsonl`, A3). Memory events are the same kind of thing,
the volume is bounded by the budget, and a file you can `cat`, `grep`, copy to another machine and diff is worth more
here than an index. `memory-index.json` is a *derived* snapshot written atomically (tmp + rename, the
`PurchaseJournal.flush` pattern, A17); it records the log offset it was built through, so deleting it costs a replay,
never a fact.

**Reconciliation — four disagreements, four rules.** `reconcile()` runs at the start of every `ask`, costs one public
`GET /api/runtime`, and writes a `conflict` event carrying **both** sides:

1. **Memory says loaded, the node does not list it.** The model does not have it. The entry is demoted to `held`
   (owned, body on disk, not resident); recall may not claim it. With `--repo` the agent re-applies it (it already
   can); without, it says so and falls through to the cost path. This is the normal case after a serving-model
   restart — `watch` already detects that edge (`agent.ts:906-910`).
2. **The node lists a layer the agent does not own.** A foreign layer. It counts in the stack fingerprint (§4), so
   cached answers invalidate, but it never becomes this agent's memory and the agent never removes it — removing
   somebody else's layer writes the model's own rows back over theirs (`agent.ts:702-707`).
3. **Same `patch_id`, different `sha256`.** The body changed underneath. Every memory row attributed to that engram is
   demoted to `unverified` and the anchor is re-checked against the ledger before anything is claimed again.
4. **The agent home is gone** (new machine, wiped home). Memory is empty, and the agent says so rather than guessing.
   What can be rebuilt is rebuilt: residency from `GET /api/runtime`, ownership from `purchases.jsonl` receipts,
   coverage from each owned anchor's `benchmark.samples` (A15). What cannot be rebuilt is the lookup history — so the
   shape counters restart at zero, and the agent will not bake on a memory it does not have.

Rule of thumb, stated once so it can be applied everywhere: **the node wins about the model; the agent wins about
itself; a disagreement is recorded, not silently resolved.**

---

## 3. What is actually stored

`memory.jsonl` — one JSON object per line, `{v:1, at, kind, …}`, mode 0600, appended with a single `appendFileSync`
per event (O_APPEND, one line well under a pipe buffer — the same assumption `purchases.jsonl` already makes):

| kind | payload | written when |
|---|---|---|
| `learn` | `row_key` (= `promptKey(row)`, A11), `answer`, `source: 'anchor' \| 'dataset' \| 'retrieval' \| 'bake'`, `engram` (patch id, or `null` while only retrieved), `shape` | a fact enters memory |
| `recall` | `row_key`, `shape`, `hit`, `via: 'memory' \| 'model'`, `engram`, `stack_fp`, `ms` | every answered question |
| `retrieve` | `shape`, `plan_id`, `arguments_sha256`, `rows`, `new_rows`, `refetched`, `churned`, `queries`, `bytes`, `ms`, `provenance` (sealed, A10) | every upstream call |
| `buy` | `patch_id`, `sha256`, `amount`, `currency`, `tx_hash`, `seller`, `rows_learned` | after `runAgent` returns a receipt |
| `apply` | `patch_id`, `sha256`, `position`, `stack_fp_after` | after an apply this agent caused |
| `bake` | `shape`, `dataset_id`, `dataset_sha256`, `job_id`, `backend`, `status`, `rows`, `total_s`, `npz_sha256` | at submit, and again at every terminal state |
| `demote` | `what`, `why`, `from`, `to` | a reconciliation rule fired |
| `conflict` | `what`, `agent_says`, `node_says` | rules 1–4 of §2 |

`memory-index.json` (derived, atomic, deletable): `{through_offset, rows: {row_key → {answer, engram, state,
learned_at, verified_at, shape}}, shapes: {shape → counters}, answers: {"<stack_fp> <row_key>" → {answer, at}}}`.

`spend.jsonl` — one line per reservation and per settlement: `{v:1, at, kind: 'money'|'queries'|'lessons'|'gpu_s',
state: 'intent'|'settled'|'released', amount, unit, for, ref}`. Money is *also* still derived from `purchases.jsonl`,
so today's `spentToday` (A4) keeps working unchanged and stays the authority on what was actually paid.

---

## 4. Decision 2 — "can I answer from memory?", decided without asking the model twice

The decision costs **zero completions**. The model is never asked whether it knows something; the index is.

1. **Normalize** the question with the node's own key: `promptKey({prompt: question, answer: ''})` (A11). Identical
   normalization to the node's dataset parser means a fact learned from a training set and a question typed by a
   person land on the same key.
2. **Look it up** in `index.rows`. A miss ends the memory path immediately — cost so far: one map lookup.
3. **Check residency** against the *stack fingerprint*:
   `stack_fp = sha256(model_id + "\n" + stack.map(l => position:patch_id:sha256).join("\n"))`,
   from the public `GET /api/runtime` (A7) plus the model id it reports, cached 5 s. This is the one honest
   invalidation key: it changes when anything at all is applied, removed, reordered or re-bodied — by this agent or by
   another tenant.
4. **Answer.**
   - The answer cache holds a fresh entry for `(stack_fp, row_key)` ⇒ return it. **No network, no model, no cost.**
     This is the first branch of the owner's loop, and it is only sound because the fingerprint changed if the model
     did.
   - Otherwise, with a serving API configured: **one** completion, scored against the remembered answer. That single
     call is both the check and the answer, and its result refreshes the cache. A mismatch is not an error — it
     demotes the row to `unverified`, writes a `recall` event with `hit: false`, and falls through to the cost path.
     **Memory is a claim; the model is the truth.**
   - With no serving API (offline, or `--api` absent and the node reports no runtime): return the remembered answer,
     labelled `via: 'memory'`. Arm C's offline claim is a capability, not a footnote — but the label must travel with
     the answer.

**Why this is not the existing before/after.** `runAgent`'s two calls (A5) are a *measurement*: they exist to prove a
knowledge changed the answer, and both are needed for that. They are not a decision procedure, and they stay in `run`.
`ask` never probes to decide; it looks up to decide, and asks at most once per state of the model.

---

## 5. Decision 3 — what counts as "the same shape of thing, looked up again"

This is the hard one, and the naive version — count identical question strings — never fires: the second question
differs by an entity, a phrasing or a language.

**So the counter does not key on the question. It keys on the retrieval.** The agent cannot reliably tell that two
sentences mean the same thing, and should not pretend to. It knows *exactly* that it ran the same query against the
same subgraph with a different argument. That is a fact about its own behaviour, it is deterministic, and it is free.

### 5.1 The retrieval plan is the shape

A **plan** is declarative JSON in `<home>/plans/*.json` — for the same reason `RowMapping` is JSON (A11): it can be
logged, reviewed by a human, stored in provenance, and re-run.

```jsonc
{
  "id": "graph/erc20-address-by-symbol",
  "server":  { "name": "subgraph-mcp", "transport": "sse", "url": "https://subgraphs.mcp.thegraph.com/sse" },
  "tool": "execute_query_by_subgraph_id",
  "arguments": {
    "subgraph_id": "5zvR82…",
    "query": "{ _meta { block { number } } tokens(where:{symbol:\"{symbol}\"}, first:1) { id symbol name } }"
  },
  "mapping": {
    "path": "data.tokens",
    "prompt": "What is the {chain} contract address of the {name} ({symbol}) token?",
    "answer": "{id}", "require": ["id", "symbol", "name"], "constants": { "chain": "Ethereum mainnet" }
  },
  "match": {
    "patterns": ["what is the contract address of {symbol}", "{symbol} 컨트랙트 주소", "{symbol} 토큰 주소 알려줘"],
    "requires": ["symbol"]
  }
}
```

**The shape key** is a hash of the plan's *skeleton*, not of the call:

```
shape = sha256(stableJson({ server: plan.server.name, tool: plan.tool,
                            skeleton: skeleton(plan.arguments), path, prompt, answer }))
```

`stableJson` already exists (`rows.ts:135`). `skeleton()` walks the arguments with the same key-sorted walk and
replaces every leaf literal with a **typed placeholder** — `$addr` (`/^0x[0-9a-f]{40}$/`), `$hash` (≥ 32 hex), `$int`,
`$dec`, `$date` (ISO-8601), `$str` — except a leaf whose value is a GraphQL document, which is instead
whitespace-collapsed with its string and number literals replaced by the same placeholders, keeping field names and
selection structure. `{symbol}` in the template with `USDC` in one call and `WETH` in the next therefore produces
**one** shape, which is exactly where an exact-match counter fails.

`mapping.prompt` stays in the key **with its slots intact**: two plans that fetch the same field but phrase the
question differently are different products and must not share a counter.

### 5.2 Question → plan, deterministically

`match.patterns` are templates in the same `{slot}` syntax, compiled to anchored, case- and width-folded regexes with
`(?<slot>.+?)` per slot; the first that matches binds the slots, which are then substituted into `arguments` and
`mapping.constants`. Patterns are written in **English and Korean in the same list**, which is the honest statement of
what this mechanism does: it collapses *declared* phrasings; it does not understand meaning. A question that matches
nothing is not retrieved at all — the agent prints which plans it has and what they match, instead of guessing a query
with somebody else's money.

### 5.3 The retroactive counter that catches what the patterns missed

After a retrieval, every produced row has `promptKey(row)`. If a row's key is **already in memory**, this agent has
demonstrably paid twice for the same fact — however the two questions were worded, and even if they matched different
plans. Per `retrieve` event the agent records:

- `new_rows` — keys never seen before,
- `refetched` — keys already in memory,
- `churned` — refetched keys whose answer **differs** from the remembered one.

`refetched` is the strongest recurrence evidence available, and it is exact rather than fuzzy. `churned` is the
counter-signal used in §6: a shape whose answers move is a shape that belongs on the tail, in The Graph, not compiled
into memory.

Three counters, one trigger: **lookups per shape** (economic), **distinct rows per shape** (material), **churn per
shape** (stability). `refetched` corroborates the first and never overrides it.

---

## 6. Decision 4 — the threshold, and why it is not a number we picked

`graph/bench` already owns the arithmetic (A16):

```
N* = one-time cost / (cost per question retrieving − cost per question recalling)
```

and run `r1` **leaves it uncomputed**, in writing, because both sides must be scored and priced first. Inventing a
constant here would contradict the one document in this repo that refuses to.

**So the agent computes it from its own measurements, and refuses to bake when it cannot.**

Per shape, the agent bakes only when **all four** gates hold:

| gate | test | where the number comes from |
|---|---|---|
| economic | `lookups(shape) ≥ N*(shape)` | `N* = bake_cost / (retrieval_cost − recall_cost)`, computed per unit kind (seconds, queries, tokens) and taking the **largest** N\* over the kinds that have a measured price. `retrieval_cost` from `retrieve` events (`ms`, `queries`, `bytes`); `recall_cost` from `recall` events (`ms`, plus completion `usage` once §9's seam lands); `bake_cost` from the last `bake` event's `total_s` plus one lesson. |
| material | `distinct_rows(shape) ≥ 8` | the node's own `rowsPerJob.floorGradient` (A13). A smaller lesson is refused by the node anyway, so a bake that ignored this would burn a non-refundable lesson on a 400. |
| stability | `churn(shape) ≤ --max-churn` (**default 0**) | §5.3. A fact that moved is a fact the compiled copy would be wrong about. |
| budget | a lesson **and** the trainer's declared timeout in GPU seconds both fit in what is left today | §7 |

**Fewer than `ETA_MIN_SAMPLES = 3` measurements on either side ⇒ N\* is undefined ⇒ the agent does not bake.** That
constant is not invented either: it is the rule the node already applies before it will publish an ETA or size a job
from timing (A13). Three stub jobs must never become an estimate, and three lookups must never become a break-even.

**Consequence, stated plainly: the first bake is always an owner decision.** With no measurement and no declared floor,
autonomous baking is off, and `agent memory --why <shape>` prints which term is missing — the same refusal
`graph/bench/runs/r1/summary.md:129` prints today. The owner turns it on one of two ways:

- `--bake-after <n>` — a **declared policy**, not a measurement, and labelled as such everywhere it appears; or
- funding the lesson budget and letting the agent measure: the earliest possible autonomous bake is then the 4th
  lookup of a shape (three priced retrievals, at least eight distinct rows, no churn).

The demo line is therefore `ask … --bake-after 3 --lessons-per-day 1 --budget-per-day 0`: the loop closes inside one
session while spending no money at all.

---

## 7. Decision 5 — the budget, and how the agent refuses to exceed it

The agent spends four things that do not convert into one another. One cap each, all persisted, all check-and-hold.

| kind | unit | cap flag | reserved when | settled with |
|---|---|---|---|---|
| `money` | market currency | `--budget-per-day` (exists, A4), `--max-price` (exists) | before the 402 is answered | the amount in `purchases.jsonl` |
| `queries` | upstream MCP calls | `--queries-per-day` | before `McpDataSource.call` | 1 per call, whatever it answered |
| `lessons` | teach jobs | `--lessons-per-day` | before `POST /api/teach/jobs` | released on a node refusal — the node never queued it, and A9 already does exactly this refund |
| `gpu_s` | seconds | `--gpu-seconds-per-day` | `teach.trainer.timeoutMs / 1000` at submit — the worst case the node itself allows | the job's measured `total_s` from `teach_stats` |

Mechanics, all borrowed rather than invented:

- **Check-and-hold**, not check-then-spend: `reserve()` returns `{release, settle}` so two concurrent decisions cannot
  both squeeze past the same remainder (`money.ts:98-121`, A17).
- **Intent before the irreversible act**: the `intent` line is appended to `spend.jsonl` *before* the call, exactly as
  `pending-payments.jsonl` is written before the money moves (A3). A crash leaves evidence, not ambiguity.
- **Refusal, never a clamp.** The sentence carries cap, spent, reserved, remaining and the flag that would raise it —
  and then the agent stops. It never buys a cheaper thing instead, never trims the lesson, never retries.
- **The cap cannot be raised from inside the loop.** Caps come from flags, env, or `<home>/agent.json`, and nowhere
  else. A plan file cannot raise one (a plan is data, possibly written by someone else); a market answer cannot raise
  one; a 402 cannot raise one. This mirrors "no tool argument can raise it" (A17), and it is what makes an unattended
  agent safe to leave running.
- **The day boundary is UTC midnight**, the boundary `spentToday` already uses (A4).
- **Two ceilings, the tighter wins.** For lessons, the node's own `jobsPerKeyPerDay` (A14) is a second ceiling, read
  from `GET /api/teach/policy` and reported beside the agent's own.

`agent budget` prints all four with what is left; `agent memory` prints what was bought, retrieved, learned and baked
for it. Every number on both screens comes from a file on disk.

---

## 8. Decision 6 — a self-baked engram is **private by default**

**It is not published unless the owner says so, and on a real chain it takes a second word.**

1. **Publishing is irreversible.** It writes an anchor nobody can recall — the MCP server's own instructions name it
   and `buy` as the only two irreversible acts (A18).
2. **Keeping it private costs the owner nothing.** The engram applies into their model identically either way, and the
   whole benefit of the loop — retrieval paid once instead of per question — is realised entirely locally.
3. **The material is not unambiguously ours to sell.** The rows came from somebody else's data through a gateway key,
   and the training set's access level (`public | derivative | private`) decides who may build on it and who is paid
   afterwards. Those are the owner's decisions, and the node already refuses to guess in the neighbouring case:
   `undeclared_parent` exists for exactly this class of mistake (`teach.ts:1026-1032`).
4. **Precedent.** `allow_publish` is off by default in the MCP server, with a *separate* flag for the AIN chain (A18).

So: `--publish` is explicit; on a node whose ledger is `ain`, `--publish-onchain` is required as well; a dataset access
level must be named explicitly (there is no default); and the autonomous loop never publishes. It bakes, keeps, and
reports the lesson id so a person can publish it in one command afterwards.

---

## 9. Surface

New commands, all additive. No existing flag, exit code or JSON field changes meaning.

```
ainize-agent ask "<question>"        the loop: recall → buy → retrieve → (maybe) bake
    --plan <id|glob>                 restrict to certain plans
    --bake-after <n>                 declared floor (§6); omitted = only a computed N* may trigger a bake
    --max-churn <0..1>               default 0
    --queries-per-day / --lessons-per-day / --gpu-seconds-per-day / --budget-per-day
    --repo <path>                    apply what it buys or bakes into that runtime (existing semantics)
    --json
ainize-agent memory [--shape <k>] [--why <shape>] [--compact]
ainize-agent budget
ainize-agent plans [--check]
```

**The one edit to `agent.ts`:** `askModel` is split into `askModelDetailed(api, prompt, maxTokens)` returning
`{text, usage, elapsed_ms}` — the OpenAI-compatible response already carries `usage`, and today it is discarded — with
`askModel` kept as a one-line wrapper with its exact current signature and return type. Without it the recall side of
N\* has no token term (§6), and a second completion helper would be a second implementation of something that already
exists.

**i18n.** There is no CLI i18n machinery today (A19) and inventing a framework is out of scope, so: a ten-line
`packages/agent/src/i18n.ts` (`lang()` from `NGRAM_LANG`/`LANG`, `t(dict, key, vars)`) plus one `{en, ko}` dictionary
**per module**, so that parallel groups never edit the same file — the reason the web splits `i18n/pages/*.ts`.
Existing strings in `agent.ts`/`bin.ts` are untouched. Every new user-facing line ships in both languages:

| key | en | ko |
|---|---|---|
| `recall.hit` | `answered from memory — {engram} has taught this since {date}; no query, no cost` | `기억에서 답했습니다 — {date}부터 {engram}이(가) 알고 있습니다. 조회도, 비용도 없습니다` |
| `recall.miss` | `not in memory ({rows} facts held) — looking for a knowledge that covers it` | `기억에 없습니다 (보유한 사실 {rows}개) — 이 질문을 담은 지식을 찾습니다` |
| `retrieve.paid` | `asked {server} · {tool} — {rows} rows, {refetched} of them already known here, {ms} ms, {queries} query(s)` | `{server} · {tool}에 질의했습니다 — {rows}행, 그중 {refetched}행은 이미 알고 있던 것, {ms} ms, 질의 {queries}회` |
| `bake.trigger` | `this is lookup {n} of {shape}; N* = {nstar} from {samples} measurements — compiling it into memory` | `{shape}을(를) {n}번째 조회했습니다. 측정 {samples}건으로 계산한 N* = {nstar} — 기억으로 컴파일합니다` |
| `bake.blocked` | `not baking: {reason}. N* is not computable yet ({missing})` | `학습하지 않습니다: {reason}. 아직 N*를 계산할 수 없습니다 ({missing})` |
| `budget.refused` | `{kind}: {need} would pass today's cap of {cap} ({spent} spent, {left} left). Nothing was spent. Raise it with {flag}.` | `{kind}: {need}은(는) 오늘 한도 {cap}을(를) 넘습니다 ({spent} 사용, {left} 남음). 아무것도 쓰지 않았습니다. 늘리려면 {flag}을(를) 쓰세요.` |
| `conflict.notResident` | `memory says {patch} is loaded and the node does not list it — demoted to held` | `기억은 {patch}가 올라가 있다고 하지만 노드 목록에는 없습니다 — 보유 상태로 낮춥니다` |

Docs: `docs/en/how-to/agent-memory.md` and `docs/ko/how-to/agent-memory.md`.

---

## 10. Build groups

Five groups. **No two groups touch the same file.** Every group is independently buildable and testable.

### G1 — memory store, recall index, reconciliation
`packages/agent/src/memory.ts` · `packages/agent/src/i18n.ts` · `packages/agent/src/strings/memory.ts` ·
`packages/agent/test/memory.test.ts` · `packages/agent/package.json` (adds a `test` script and the `tsx` dev dep)

Event log, atomic derived snapshot, prompt-key normalization, the stack fingerprint from `GET /api/runtime`, the answer
cache keyed by `(stack_fp, row_key)`, the four reconciliation rules, and the `agent memory` view models.
**Depends on:** nothing. `promptKey`/`rowsSha256` arrive through G2's subpath export; until it lands, G1 develops
against the same normalization the node and `rows.ts` already agree on, and switches the import when G2 merges.

### G2 — the `@ngram/mcp` seam
`packages/mcp/package.json` (adds `"./client"` and `"./money"` subpath exports; `"."` unchanged) ·
`packages/mcp/src/teach-run.ts` (new: `runTeachLesson(ctx, input, {signal, onState})`, lifted **verbatim** out of the
`teach` tool's `run` closure) · `packages/mcp/src/tools/teach.ts` (now calls it) · `packages/mcp/test/teach-run.test.ts`

Why: the agent must not carry a second teach pipeline (A9) and must not pull express and the MCP *server* into a CLI
(A20). A pure refactor plus additive exports; the tool's own inputs, outputs and error codes are unchanged, which the
existing `packages/mcp/test/teach.test.ts` pins.
**Depends on:** nothing.

### G3 — the budget and the spend ledger
`packages/agent/src/budget.ts` · `packages/agent/src/strings/budget.ts` · `packages/agent/test/budget.test.ts`

Four kinds, per day, check-and-hold, `spend.jsonl` intent/settle/release, the refusal sentences, the "cap cannot be
raised from inside" rule, and the node's `jobsPerKeyPerDay` as the second ceiling.
**Depends on:** G2 (decimal-string arithmetic via `@ngram/mcp/money`), G1 (`i18n.ts` only).

### G4 — plans, shapes, retrieval
`packages/agent/src/plans.ts` · `packages/agent/src/retrieve.ts` · `packages/agent/src/strings/retrieve.ts` ·
`packages/agent/plans/graph-erc20.json` · `packages/agent/test/plans.test.ts` · `packages/agent/test/shape.test.ts`

Plan schema and loader, `skeleton()`, the shape key, pattern→slot compilation (EN + KO), the `McpDataSource` wiring,
`retrieve` events with `new_rows`/`refetched`/`churned`, provenance sealed onto the rows.
**Depends on:** G2 (`@ngram/mcp/client`), G1 (memory events and the row index), G3 (the `queries` reservation).

### G5 — the loop, the bake, the CLI, the docs
`packages/agent/src/ask.ts` · `packages/agent/src/bake.ts` · `packages/agent/src/bin.ts` ·
`packages/agent/src/agent.ts` (the single additive `askModelDetailed` seam, §9) · `packages/agent/src/strings/loop.ts` ·
`packages/agent/README.md` · `docs/en/how-to/agent-memory.md` · `docs/ko/how-to/agent-memory.md` ·
`packages/e2e/tests/agent-memory.spec.ts`

`shouldBake()` and its four gates, the bake through `runTeachLesson`, the `ask` / `memory` / `budget` / `plans`
commands, and an e2e that drives recall → buy → retrieve → bake against a throwaway node with
`NGRAM_TEACH_BACKEND=stub`.
**Depends on:** G1, G2, G3, G4.

Suggested order: **G2 and G1 in parallel → G3 → G4 → G5.**

---

## 11. What cannot be verified without a GPU

Everything below is buildable and drivable today with `NGRAM_TEACH_BACKEND=stub` (A14) on a throwaway home pointed at
`NGRAM_RUNTIME_API=http://127.0.0.1:9` — the job record exists, the dataset is real, the state machine runs, the
budget reserves and settles. What the stub cannot produce is a trained engram, so these five stay **GPU-PENDING**, each
with the command that would close it in a later window. `--gpus 4,5,6` is named explicitly because the shared engine on
`:8002` and node-a are off limits while the four-arm re-run is measuring.

1. **A real bake of a self-built dataset.** The stub copies a fixture npz; only a gradient run produces rows that
   change a model.
   `NGRAM_TEACH_BACKEND=gradient ainize-agent ask "<q>" --bake-after 3 --lessons-per-day 1 --gpu-seconds-per-day 3600 --json`
   against a node whose `teach.trainer.gpus` is `4,5,6`; then `ainize teach status <job>` must show
   `backend: gradient`, `checks.simulated: false` and a non-null `result.sha256`.
2. **The baked engram answering its own shape.** Needs a serving model with the patch hook.
   `ainize-agent ask "<same shape, new entity>" --repo <runtime> --json` → `via: 'model'`, `engram: <baked id>`, and a
   `recall` hit with **no** `retrieve` event in the same run.
3. **N\* itself.** `retrieval_cost` is measurable offline (queries, ms, bytes), but `recall_cost` needs completions and
   `bake_cost` needs a gradient job's `total_s`. Until both exist, `agent memory --why <shape>` must print
   "N\* not computable" and name the missing term — the same refusal `graph/bench/runs/r1/summary.md:129` prints today.
4. **Reconciliation against a live runtime.** Rules 1 and 3 of §2 need `GET /api/runtime` to report a stack whose
   `present` comes from a real `runtimeCheck()`; the stub path applies nothing, so only rules 2 and 4 are testable
   today.
5. **The four-arm claim closed by the agent** — that the agent's own recall beats its own retrieval on the shapes it
   compiled. That is `graph/bench` arms B vs C with the agent as the driver, and it needs both a GPU and
   `GRAPH_API_KEY`.

Not GPU-pending but key-pending, listed separately so it is not confused with the above: **churn** (§5.3) needs two
live pulls of the same shape against The Graph — `GRAPH_API_KEY` and network, no GPU.
`packages/mcp/test/smoke-subgraph-mcp.test.ts` is the existing precedent for a test that skips without the key and is
**never** replaced by a fixture.

---

## 12. Compatibility, and what this deliberately does not do

- `runAgent`, `watchAgent`, `AgentResult`, `exitCodeFor` and every existing flag keep their meanings; the four
  `outcome` values are untouched, so automation and `packages/e2e/tests/agent-x402.spec.ts` are unaffected. The loop's
  new outcomes live only on the new `ask` command.
- No second payment path: the loop calls `runAgent` for anything that costs money.
- No second teach pipeline: the loop calls `runTeachLesson`, which *is* the MCP tool's own body (G2).
- No second MCP client: the loop uses `McpDataSource`.
- No model in the decision path. Plan matching, shape keys, counters and the trigger are deterministic; the only model
  call in `ask` is the answer itself.
- The agent never removes a layer it did not apply, never restores inside `ask` (accumulation is the whole point), and
  never publishes without being told to.
