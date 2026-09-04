---
title: HTTP API reference
summary: Every endpoint an Ainize node serves, with parameters, bodies and responses
---

# HTTP API reference

> [!NOTE]
> **This page is generated — do not edit it by hand.** It is written by `scripts/docs-gen.mjs` from `packages/node/src/openapi.ts`.
> Regenerate with `npm run docs:gen`; `npm run docs:check` fails when this page and the source disagree.

114 operations on 99 paths, grouped into the 8 areas a node serves. Body shapes shared between endpoints are on the [Schemas](./schemas.md) page; the codes an error can carry are on [Error codes](./errors.md).

## How to read this page

The base URL is the node itself — `http://localhost:3402` for a node started on the default port — and every request and response body is `application/json` unless the endpoint says otherwise.

A node serves this same description as OpenAPI 3.1 at `GET /api/openapi.json`, so a client can be generated from it.

### Authentication

The **Auth** column of each index below says what a request must carry.

- **`operatorCookie`** — cookie `ngram_session`
- **`operatorBearer`** — http `bearer`
- **teaching key** — the `x-ngram-auth` header. There is no account: the key is the identity. Endpoints that accept it describe its exact form in their parameter table.
- **payment (x402)** — the endpoint answers `402` with an `x-payment-required` header; repeat the request with `X-PAYMENT`.
- **none** — public.

### Errors

Every error body is `{"error": "<message>"}`, sometimes with extra fields the endpoint documents. Where the message begins with a machine-readable code (`dataset_not_found: no such dataset on this node`), that prefix is the code — there is no separate field for it.

See [Error codes](./errors.md) for the full list.

## Endpoint index

**Find knowledge** — catalog, detail, same-subject listings (no auth)

| Method | Path | Auth | What it does |
|---|---|---|---|
| `GET` | [`/api/info`](#get-apiinfo) | none | Node, ledger and runtime summary |
| `GET` | [`/api/catalog`](#get-apicatalog) | none | List knowledge |
| `GET` | [`/api/patches/{id}`](#get-apipatchesid) | none | Knowledge detail (verifications, sources/derivatives, overlap check) |
| `GET` | [`/api/patches/{id}/dataset`](#get-apipatchesiddataset) | teaching key | The training set behind this knowledge (questions, access, licence, 20-question preview) |
| `GET` | [`/api/patches/{id}/dataset/rows`](#get-apipatchesiddatasetrows) | teaching key | Download the training set (.jsonl, canonical bytes) |
| `GET` | [`/api/patches/{id}/dataset/manifest`](#get-apipatchesiddatasetmanifest) | teaching key | What the training set is made of (row origin, benchmark hash, merkle root, PII scan, declaration) |
| `GET` | [`/api/patches/{id}/conflicts`](#get-apipatchesidconflicts) | none | Overlap check result |
| `GET` | [`/api/benchmarks/{schema}`](#get-apibenchmarksschema) | none | Knowledge on the same subject (benchmark schema) |

**Live test** — compare the model's answer before vs after the knowledge is loaded (trial quota)

| Method | Path | Auth | What it does |
|---|---|---|---|
| `GET` | [`/api/chat/patches`](#get-apichatpatches) | teaching key (optional) | Knowledge that can be live-tested on this node |
| `GET` | [`/api/chat/status`](#get-apichatstatus) | none | Is my live test still queued behind the shared model? |
| `POST` | [`/api/chat/cancel`](#post-apichatcancel) | none | Give up waiting for the shared model |
| `POST` | [`/api/chat`](#post-apichat) | none | Compare answers before vs after the knowledge is loaded |

**Teach** — one pipeline, two doors: a dataset file (uploaded here, or with `ainize teach dataset`) and corrections collected in Live test are both frozen into the same canonical dataset → validated → trained → checked on the live model → a lesson its teacher can keep private or publish as a credited data provider (no sign-in — every request is signed with a teaching key held by the browser or the CLI)

| Method | Path | Auth | What it does |
|---|---|---|---|
| `POST` | [`/api/patches/{id}/derive-intent`](#post-apipatchesidderive-intent) | teaching key | Say you are building on this knowledge, and get a token for its training set |
| `GET` | [`/api/teach/policy`](#get-apiteachpolicy) | none | Teaching policy of this node (open / paused, queue, limits, measured timing, shares) |
| `GET` | [`/api/teach/samples`](#get-apiteachsamples) | none | Example datasets this node ships (ko-facts, en-facts, mixed) |
| `GET` | [`/api/teach/samples/{kind}`](#get-apiteachsampleskind) | none | Download an example dataset (.jsonl) |
| `POST` | [`/api/teach/datasets`](#post-apiteachdatasets) | teaching key | Create a dataset — upload a file, or freeze the questions collected in chat |
| `GET` | [`/api/teach/datasets`](#get-apiteachdatasets) | teaching key | My datasets (signed key) |
| `GET` | [`/api/teach/datasets/{id}`](#get-apiteachdatasetsid) | teaching key | One dataset |
| `PATCH` | [`/api/teach/datasets/{id}`](#patch-apiteachdatasetsid) | teaching key | Rename, change retention, or add / remove / replace questions |
| `DELETE` | [`/api/teach/datasets/{id}`](#delete-apiteachdatasetsid) | teaching key | Delete a dataset (the lessons trained from it are kept) |
| `GET` | [`/api/teach/datasets/{id}/rows`](#get-apiteachdatasetsidrows) | teaching key | The per-question report, paginated |
| `POST` | [`/api/teach/datasets/{id}/reparse`](#post-apiteachdatasetsidreparse) | teaching key | Read the SAME uploaded file again with different settings |
| `POST` | [`/api/teach/datasets/{id}/fork`](#post-apiteachdatasetsidfork) | teaching key | Copy a dataset (optionally with an edit) — how you change one while a lesson is training |
| `GET` | [`/api/teach/datasets/{id}/download`](#get-apiteachdatasetsiddownload) | teaching key | Download the questions (canonical .jsonl, or .csv) |
| `POST` | [`/api/teach/preflight`](#post-apiteachpreflight) | teaching key | Check what the model already knows (before queuing a lesson) |
| `POST` | [`/api/teach/jobs`](#post-apiteachjobs) | teaching key | Queue a lesson (train the corrections into a knowledge file) |
| `GET` | [`/api/teach/jobs`](#get-apiteachjobs) | teaching key | My lessons (signed key) |
| `GET` | [`/api/teach/jobs/{id}`](#get-apiteachjobsid) | teaching key (optional) | Lesson status (poll every 5 s) |
| `DELETE` | [`/api/teach/jobs/{id}`](#delete-apiteachjobsid) | teaching key | Cancel / delete a lesson |
| `POST` | [`/api/teach/jobs/{id}/retry`](#post-apiteachjobsidretry) | teaching key | Improve & retry: queue a new lesson with edited corrections (same knowledge context) |
| `POST` | [`/api/teach/jobs/{id}/retrain`](#post-apiteachjobsidretrain) | teaching key | Train the same dataset again (or a fork of it) |
| `GET` | [`/api/teach/jobs/{id}/events`](#get-apiteachjobsidevents) | teaching key | This lesson’s log lines (poll every 2 s while it runs) |
| `POST` | [`/api/teach/jobs/{id}/recheck`](#post-apiteachjobsidrecheck) | teaching key | Measure again a lesson that was saved unchecked (model server was down, or the side-effect check was turned off) |
| `GET` | [`/api/teach/jobs/{id}/publish-challenge`](#get-apiteachjobsidpublish-challenge) | teaching key | What to sign before publishing |
| `POST` | [`/api/teach/jobs/{id}/publish`](#post-apiteachjobsidpublish) | teaching key | Publish the lesson through this node as a credited data provider |
| `POST` | [`/api/teach/jobs/{id}/save`](#post-apiteachjobsidsave) | teaching key | Keep it private: 7-day download links for the knowledge file, recipe.json and RUN-LOCALLY.md |
| `GET` | [`/api/teach/jobs/{id}/recipe`](#get-apiteachjobsidrecipe) | none | recipe.json (token link from save) |
| `GET` | [`/api/teach/jobs/{id}/local-run`](#get-apiteachjobsidlocal-run) | none | RUN-LOCALLY.md (token link from save) |
| `GET` | [`/api/teacher/{address}`](#get-apiteacheraddress) | none | Public data-provider page: lessons and earnings (owed / paid / pending from settle records) |

**Automatic payment & download** — the x402 flow and blob download

| Method | Path | Auth | What it does |
|---|---|---|---|
| `GET` | [`/x402/patch/{id}`](#get-x402patchid) | payment (x402) | Buy knowledge (x402) |
| `GET` | [`/p2p/datasets`](#get-p2pdatasets) | none | Training sets this node holds (sha256, rows, access, licence) |
| `GET` | [`/p2p/dataset/{sha256}`](#get-p2pdatasetsha256) | teaching key (optional) | Download a published training set (.jsonl) |
| `GET` | [`/p2p/dataset/{sha256}/manifest`](#get-p2pdatasetsha256manifest) | none | Manifest of a held training set |
| `GET` | [`/p2p/dataset/{sha256}/benchmark`](#get-p2pdatasetsha256benchmark) | none | The full benchmark list of a training set (the `answers_hash` preimage) |
| `GET` | [`/p2p/blob/{sha256}`](#get-p2pblobsha256) | teaching key (optional) + payment (x402) | Download the knowledge body (.npz) |

**Register & sell knowledge** — operator: register → announce → verified → sold

| Method | Path | Auth | What it does |
|---|---|---|---|
| `PATCH` | [`/api/patches/{id}`](#patch-apipatchesid) | operator | Edit a DRAFT |
| `DELETE` | [`/api/patches/{id}`](#delete-apipatchesid) | operator | Delete a DRAFT |
| `POST` | [`/api/patches`](#post-apipatches) | operator | Register knowledge (created as a DRAFT) |
| `POST` | [`/api/patches/{id}/announce`](#post-apipatchesidannounce) | operator | Announce — record on the ledger and request verification |
| `POST` | [`/api/patches/{id}/verify`](#post-apipatchesidverify) | operator | Run verification on this node now (verifier role) |
| `POST` | [`/api/patches/{id}/challenge`](#post-apipatchesidchallenge) | operator | Request re-verification (challenge) |

**Public record** — ledger, provenance graph, network

| Method | Path | Auth | What it does |
|---|---|---|---|
| `GET` | [`/api/patches/{id}/records`](#get-apipatchesidrecords) | none | Ledger records about this knowledge |
| `GET` | [`/api/ledger`](#get-apiledger) | none | Ledger records |
| `GET` | [`/api/ledger/verify`](#get-apiledgerverify) | none | Ledger integrity check |
| `GET` | [`/api/ledger/graph`](#get-apiledgergraph) | none | Sources → derivatives graph (+ AIN knowledge graph) |
| `GET` | [`/api/branches`](#get-apibranches) | none | Knowledge tracks (branches) |
| `GET` | [`/api/route`](#get-apiroute) | none | Find the branch and serving nodes for a context (e.g. jurisdiction=KR) |
| `GET` | [`/api/nodes`](#get-apinodes) | none | Known nodes and peers |
| `GET` | [`/api/events`](#get-apievents) | none | Node event log |
| `GET` | [`/api/docs`](#get-apidocs) | none | OpenAPI + CLI reference bundle for the web /docs page |
| `GET` | [`/api/patches/{id}/events`](#get-apipatchesidevents) | none | Node events about this knowledge (verification logs, sales, live tests) |
| `GET` | [`/api/openapi.json`](#get-apiopenapijson) | none | This document |
| `GET` | [`/healthz`](#get-healthz) | none | Liveness: 200 while the process is up |
| `GET` | [`/readyz`](#get-readyz) | none | Readiness: 200 when the ledger is reachable and, for a serving/verifier node, the runtime is available; 503 with the failing check otherwise |

**Operator** — wallet, settings, purchases, branches, peers, chain, drive

| Method | Path | Auth | What it does |
|---|---|---|---|
| `GET` | [`/api/me/teach/policy`](#get-apimeteachpolicy) | operator | Teaching policy (overrides + effective + trainer state) |
| `PATCH` | [`/api/me/teach/policy`](#patch-apimeteachpolicy) | operator | Change the teaching policy (persisted in the node store) |
| `GET` | [`/api/me/teach/datasets`](#get-apimeteachdatasets) | operator | What visitors uploaded to this machine (moderation view) |
| `GET` | [`/api/me/teach/jobs`](#get-apimeteachjobs) | operator | All lessons (with contributor and IP) |
| `POST` | [`/api/me/teach/jobs/{id}/approve`](#post-apimeteachjobsidapprove) | operator | Approve a lesson in review → announce |
| `POST` | [`/api/me/teach/jobs/{id}/reject`](#post-apimeteachjobsidreject) | operator | Decline a lesson in review (reason is shown to the contributor) |
| `POST` | [`/api/me/teach/jobs/{id}/cancel`](#post-apimeteachjobsidcancel) | operator | Cancel a lesson |
| `GET` | [`/api/me/teach/contributors`](#get-apimeteachcontributors) | operator | Contributors seen on this node |
| `POST` | [`/api/me/teach/contributors/{address}`](#post-apimeteachcontributorsaddress) | operator | Hide / show a contributor name |
| `GET` | [`/api/me/teach/bans`](#get-apimeteachbans) | operator | Blocked keys / IPs |
| `POST` | [`/api/me/teach/bans`](#post-apimeteachbans) | operator | Block a key or IP |
| `DELETE` | [`/api/me/teach/bans/{id}`](#delete-apimeteachbansid) | operator | Unblock |
| `POST` | [`/api/patches/{id}/buy`](#post-apipatchesidbuy) | operator | Buy as this node (x402 handled automatically) |
| `POST` | [`/api/patches/{id}/apply`](#post-apipatchesidapply) | operator | Load into the model (with everything it was trained on top of) |
| `DELETE` | [`/api/patches/{id}/apply`](#delete-apipatchesidapply) | operator | Unload from the model (journal replay) |
| `POST` | [`/api/patches/{id}/remove`](#post-apipatchesidremove) | operator | Unload from the model (same as DELETE …/apply) |
| `GET` | [`/api/patches/{id}/check`](#get-apipatchesidcheck) | operator | Are the rows this knowledge was trained on the ones on the table right now? |
| `POST` | [`/api/patches/{id}/forget`](#post-apipatchesidforget) | operator | Stop serving the knowledge file from this node (deletes the local body; the ledger is untouched). 409 with `also_affects` when other items share the same file — repeat with `{"all_sharing": true}` to stop serving all of them |
| `POST` | [`/api/branches`](#post-apibranches) | operator | Create a branch |
| `POST` | [`/api/branches/{name}/subscribe`](#post-apibranchesnamesubscribe) | operator | Subscribe to a branch (load its knowledge and keep it loaded) |
| `POST` | [`/api/auth/login`](#post-apiauthlogin) | none | Operator login (first time: /api/auth/setup) |
| `GET` | [`/api/me/wallet`](#get-apimewallet) | operator | Wallet: balance, sales, creator revenue share, pending payouts |
| `GET` | [`/api/me/payouts`](#get-apimepayouts) | operator | Royalty payouts this node owes creators and data providers (AIN ledger) |
| `POST` | [`/api/me/payouts/{id}/retry`](#post-apimepayoutsidretry) | operator | Retry one failed / pending payout now (also after the 20 automatic attempts) |
| `GET` | [`/api/me/patches`](#get-apimepatches) | operator | Knowledge I registered |
| `GET` | [`/api/me/purchases`](#get-apimepurchases) | operator | Knowledge I bought |
| `GET` | [`/api/me/settings`](#get-apimesettings) | operator | Read settings |
| `PATCH` | [`/api/me/settings`](#patch-apimesettings) | operator | Change settings |
| `GET` | [`/api/chain`](#get-apichain) | none | Ledger / chain state and balance |
| `GET` | [`/api/drive`](#get-apidrive) | none | aindrive state and file list |
| `POST` | [`/api/drive`](#post-apidrive) | operator | aindrive start / stop / sync |
| `GET` | [`/api/auth/me`](#get-apiauthme) | none | Who am I (signed in?, node address, needsSetup) |
| `POST` | [`/api/auth/setup`](#post-apiauthsetup) | none | Set the operator password (first run only) |
| `POST` | [`/api/auth/logout`](#post-apiauthlogout) | none | Log out |
| `POST` | [`/api/branches/{name}/patches`](#post-apibranchesnamepatches) | operator | Add knowledge to a branch (owner only) |
| `POST` | [`/api/branches/{name}/unsubscribe`](#post-apibranchesnameunsubscribe) | operator | Unsubscribe from a branch (unload its knowledge) |
| `GET` | [`/api/runtime`](#get-apiruntime) | none | Serving runtime state (model, hook, the ordered stack of loaded knowledge) |
| `GET` | [`/api/runtime/stack`](#get-apiruntimestack) | none | The ordered stack loaded in the serving model |
| `POST` | [`/api/runtime/complete`](#post-apiruntimecomplete) | operator | Raw completion on the serving model (try the model) |
| `POST` | [`/api/peers`](#post-apipeers) | operator | Add a peer |
| `DELETE` | [`/api/peers`](#delete-apipeers) | operator | Remove a peer |
| `POST` | [`/api/chain/setup`](#post-apichainsetup) | operator | Create the knowledge app on the AIN chain, set market rules, stake (AIN ledger only) |
| `GET` | [`/api/drive/changes`](#get-apidrivechanges) | none | Change history of a drive file (aindrive Willow store) |

**P2P** — node-to-node protocol

| Method | Path | Auth | What it does |
|---|---|---|---|
| `POST` | [`/p2p/hello`](#post-p2phello) | none | Peer introduction (exchange PeerInfo) |
| `GET` | [`/p2p/peers`](#get-p2ppeers) | none | Peer list for peer exchange |
| `GET` | [`/p2p/blobs`](#get-p2pblobs) | none | Knowledge bodies held by this node (sha256 list) |
| `GET` | [`/p2p/info`](#get-p2pinfo) | none | Node info |
| `GET` | [`/p2p/records`](#get-p2precords) | none | Ledger record sync (local-ledger mode) |
| `POST` | [`/p2p/records`](#post-p2precords) | none | Push records |

## Find knowledge

catalog, detail, same-subject listings (no auth)

### `GET /api/info`

Node, ledger and runtime summary

**Auth** — none

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | summary | `object` |

**`200` response body**

| Field | Type | Description |
|---|---|---|
| `node` | `object` |   |
| `ledger` | `object` |   |
| `runtime` | `object` |   |
| `quorum` | `integer` |   |
| `currency` | `string` |   |
| `peers` | `integer` |   |
| `initial_credit` | `string` |   |
| `royalty_share` | `number` | lineage share of each sale distributed to source creators |
| `accepts_contributions` | `boolean` | visitors may teach and publish knowledge through this node as data providers |
| `contributor_share` | `number` | default data-provider share of the seller remainder |
| `counts` | `object` |   |

### `GET /api/catalog`

List knowledge

**Auth** — none

**Parameters**

| Name | In | Type | Default | Description |
|---|---|---|---|---|
| `sort` | `query` | `"latest"` \| `"popular"` \| `"price"` \| `"rows"` |   |   |
| `status` | `query` | `string` |   | comma-separated (e.g. LISTED,SUPERSEDED) |
| `model` | `query` | `string` |   |   |
| `schema` | `query` | `string` |   |   |
| `q` | `query` | `string` |   |   |
| `author` | `query` | `string` |   | creator node address |
| `branch` | `query` | `string` |   |   |
| `contributor` | `query` | `string` |   | data-provider address — knowledge taught by this address (anchor.contributors[].address) |
| `origin` | `query` | `"operator"` \| `"teach"` |   |   |
| `limit` | `query` | `integer` | `50` |   |
| `offset` | `query` | `integer` | `0` |   |
| `include_drafts` | `query` | `boolean` | `false` | operator only — include private drafts (taught lessons not yet published) |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | list | `object` |

**`200` response body**

| Field | Type |
|---|---|
| `total` | `integer` |
| `items` | [`CatalogEntry`](./schemas.md#catalogentry)[] |
| `models` | `string`[] |
| `schemas` | `string`[] |

### `GET /api/patches/{id}`

Knowledge detail (verifications, sources/derivatives, overlap check)

**Auth** — none

**Parameters**

| Name | In | Type | Required |
|---|---|---|---|
| `id` | `path` | `string` | yes |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | detail | [`CatalogEntry`](./schemas.md#catalogentry) |
| `404` | not found |   |

### `GET /api/patches/{id}/dataset`

The training set behind this knowledge (questions, access, licence, 20-question preview)

The questions a knowledge was taught from (lineage design §6.1). `public`: anyone. `derivative`: a teaching key sees this summary and gets the bytes through a derive intent. `private`: refused — only the verification questions on the record are public. The owner (the credited teaching key) and the operator always see it.

**Auth** — teaching key

**Parameters**

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| `id` | `path` | `string` | yes |   |
| `x-ngram-auth` | `header` | `string` | yes | teaching-key signature. Request-bound (recommended): `<address>:<ts>:<sig>:v2` where sig = signMessage("teach:\<nodeAddress>:\<METHOD>:\<path+query>:\<ts>[:\<sha256(body)>]"); legacy: `<address>:<ts>:<sig>` over "teach:\<ts>". 5-minute window, every header is single-use (replays are refused). |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | training set | `object` |
| `403` | dataset_private \| dataset_derivative_only |   |
| `404` | dataset_unavailable — no node here holds the bytes |   |

**`200` response body**

| Field | Type | Description |
|---|---|---|
| `sha256` | `string` |   |
| `rows` | `integer` |   |
| `access` | `"public"` \| `"derivative"` \| `"private"` |   |
| `license` | `string` \| `null` |   |
| `parents` | `object`[] |   |
| `parents[].patch_id` | `string` |   |
| `parents[].sha256` | `string` |   |
| `parents[].rows` | `integer` |   |
| `held` | `boolean` |   |
| `include_notes` | `boolean` |   |
| `benchmark_samples` | `integer` \| `null` |   |
| `merkle_root` | `string` \| `null` |   |
| `preview` | [`CanonicalRow`](./schemas.md#canonicalrow)[] | (at most 20 items) |

### `GET /api/patches/{id}/dataset/rows`

Download the training set (.jsonl, canonical bytes)

Public sets, and the owner/operator. A `derivative` set is fetched with a derive token from `/p2p/dataset/{sha256}`. The bytes hash to the `sha256` on the record.

**Auth** — teaching key

**Parameters**

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| `id` | `path` | `string` | yes |   |
| `x-ngram-auth` | `header` | `string` | yes | teaching-key signature. Request-bound (recommended): `<address>:<ts>:<sig>:v2` where sig = signMessage("teach:\<nodeAddress>:\<METHOD>:\<path+query>:\<ts>[:\<sha256(body)>]"); legacy: `<address>:<ts>:<sig>` over "teach:\<ts>". 5-minute window, every header is single-use (replays are refused). |

**Responses**

| Code | Description |
|---|---|
| `200` | application/x-ndjson |
| `403` | dataset_private \| dataset_derivative_only |
| `404` | dataset_unavailable |

### `GET /api/patches/{id}/dataset/manifest`

What the training set is made of (row origin, benchmark hash, merkle root, PII scan, declaration)

**Auth** — teaching key

**Parameters**

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| `id` | `path` | `string` | yes |   |
| `x-ngram-auth` | `header` | `string` | yes | teaching-key signature. Request-bound (recommended): `<address>:<ts>:<sig>:v2` where sig = signMessage("teach:\<nodeAddress>:\<METHOD>:\<path+query>:\<ts>[:\<sha256(body)>]"); legacy: `<address>:<ts>:<sig>` over "teach:\<ts>". 5-minute window, every header is single-use (replays are refused). |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | manifest | `object` |
| `403` | dataset_private \| dataset_derivative_only |   |
| `404` | dataset_unavailable |   |

### `GET /api/patches/{id}/conflicts`

Overlap check result

**Auth** — none

**Parameters**

| Name | In | Type | Required |
|---|---|---|---|
| `id` | `path` | `string` | yes |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | overlapping knowledge | `object` |

### `GET /api/benchmarks/{schema}`

Knowledge on the same subject (benchmark schema)

**Auth** — none

**Parameters**

| Name | In | Type | Required |
|---|---|---|---|
| `schema` | `path` | `string` | yes |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | list | `object` |

## Live test

compare the model's answer before vs after the knowledge is loaded (trial quota)

### `GET /api/chat/patches`

Knowledge that can be live-tested on this node

List + runtime state + shared-model lock + `applied` (operator-pinned ids) + pairwise `overlaps`. With a verified `x-ngram-auth` (v2: `<address>:<ts>:<sig>:v2`, sig over `teach:<node>:GET:/api/chat/patches:<ts>`; legacy `teach:<ts>` still accepted) the response also carries the caller’s private `lessons`.

**Auth** — teaching key (optional)

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `x-ngram-auth` | `header` | `string` | optional visitor signature (v2 request-bound form preferred) — adds `lessons` |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | list + runtime state + shared-model lock | [`ChatPatches`](./schemas.md#chatpatches) |

### `GET /api/chat/status`

Is my live test still queued behind the shared model?

Free (no quota) and answers about the caller's own request only — an unknown or foreign `request_id` is reported as `gone`, never as someone else's state. Poll it every 1–2 s while a request is in flight.

**Auth** — none

**Parameters**

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| `request_id` | `query` | `string` | yes | the `request_id` sent with POST /api/chat |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | queue state | [`ChatStatus`](./schemas.md#chatstatus) |

### `POST /api/chat/cancel`

Give up waiting for the shared model

While the request is still queued the node drops it before calling the model and no free try is consumed (`{cancelled:true, reason:"queued", charged:false}`; POST /api/chat then answers 499). Once it is running the work and the charge stand (`{cancelled:false, reason:"already_running", charged:true}`).

**Auth** — none

**Request body** — `application/json`, required

| Field | Type | Required |
|---|---|---|
| `request_id` | `string` | yes |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | what happened | `object` |

**`200` response body**

| Field | Type |
|---|---|
| `cancelled` | `boolean` |
| `reason` | `"queued"` \| `"already_running"` \| `"gone"` |
| `charged` | `boolean` |

### `POST /api/chat`

Compare answers before vs after the knowledge is loaded

Temporarily loads one to three knowledges into the shared serving model (in list order, restored in reverse afterwards). In `compare` mode each column replays its own earlier answers: send `messages_base` (what the base model said) and `messages_patched` (what the patched model said) alongside `messages`, all ending with the same question — otherwise the second turn feeds the patched answer back to the un-patched model and the comparison stops being one. Every patched answer is metered as one usage event per knowledge. Anonymous visitors: 20 requests per hour. A private draft (a taught lesson before publishing) can be loaded only by its owner — send the visitor `x-ngram-auth` (v2) — or the operator; everyone else gets 404.

**Auth** — none

**Request body** — `application/json`, required

[`ChatRequest`](./schemas.md#chatrequest)

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | answers | [`ChatResponse`](./schemas.md#chatresponse) |
| `429` | trial quota exhausted — the body carries `quota_reset` (epoch ms), the instant this visitor's hour ends |   |

## Teach

one pipeline, two doors: a dataset file (uploaded here, or with `ainize teach dataset`) and corrections collected in Live test are both frozen into the same canonical dataset → validated → trained → checked on the live model → a lesson its teacher can keep private or publish as a credited data provider (no sign-in — every request is signed with a teaching key held by the browser or the CLI)

### `POST /api/patches/{id}/derive-intent`

Say you are building on this knowledge, and get a token for its training set

A signed intent from a teaching key (lineage design §6.1). Counted on the knowledge — this is what "built on N times" is made of — and answered with a 24-hour token for `/p2p/dataset/{sha256}`.

**Auth** — teaching key

**Parameters**

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| `id` | `path` | `string` | yes |   |
| `x-ngram-auth` | `header` | `string` | yes | teaching-key signature. Request-bound (recommended): `<address>:<ts>:<sig>:v2` where sig = signMessage("teach:\<nodeAddress>:\<METHOD>:\<path+query>:\<ts>[:\<sha256(body)>]"); legacy: `<address>:<ts>:<sig>` over "teach:\<ts>". 5-minute window, every header is single-use (replays are refused). |

**Request body** — `application/json`, optional

| Field | Type | Description |
|---|---|---|
| `child_key` | `string` | must be the teaching key that signed the request |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | token | `object` |
| `403` | dataset_private |   |
| `404` | patch not found \| dataset_unavailable |   |

**`200` response body**

| Field | Type |
|---|---|
| `token` | `string` |
| `expires` | `integer` |
| `sha256` | `string` |
| `held` | `boolean` |
| `holders` | `string`[] |

### `GET /api/teach/policy`

Teaching policy of this node (open / paused, queue, limits, measured timing, shares)

Public, cached 10 s.

**Auth** — none

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | policy | [`TeachPolicy`](./schemas.md#teachpolicy) |

### `GET /api/teach/samples`

Example datasets this node ships (ko-facts, en-facts, mixed)

Public, cached 1 h. Registered before /api/teach/datasets/{id} so `samples` can never be read as a dataset id.

**Auth** — none

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | samples | `object` |

**`200` response body**

| Field | Type |
|---|---|
| `samples` | `object`[] |
| `samples[].kind` | `string` |
| `samples[].name` | `string` |
| `samples[].description` | `string` |
| `samples[].rows` | `integer` |
| `samples[].sha256` | `string` |
| `samples[].preview` | [`TeachDatasetRow`](./schemas.md#teachdatasetrow)[] |
| `samples[].download_url` | `string` |

### `GET /api/teach/samples/{kind}`

Download an example dataset (.jsonl)

**Auth** — none

**Parameters**

| Name | In | Type | Required |
|---|---|---|---|
| `kind` | `path` | `"ko-facts"` \| `"en-facts"` \| `"mixed"` | yes |

**Responses**

| Code | Description |
|---|---|
| `200` | application/x-ndjson |
| `404` | dataset_not_found |

### `POST /api/teach/datasets`

Create a dataset — upload a file, or freeze the questions collected in chat

Two request shapes, one result.

**multipart/form-data (the file door)** — one `file` (.jsonl .json .csv .tsv .txt, within `limits.dataset_max_bytes`), plus optional `name`, `format`, `has_header`, `delimiter`, `encoding`, `columns` (JSON), `retention`.
A multipart body cannot be covered by the v2 body hash, so send `x-ngram-dataset-sha256: <hex of the file bytes>` and sign THAT string as the body; the node re-hashes the stored file and answers 400 `dataset_hash` on a mismatch.

**application/json (the chat door, the CLI, agents)** — `{source: "chat"|"inline"|"sample", rows: [{prompt, answer, alt_prompt?, note?}], sample?, name?, retention?}`.

The response carries the server’s per-row report: nothing is silently dropped, deduped or truncated. Re-sending identical bytes from the same key returns **200** with the existing dataset instead of creating a second one.

**Auth** — teaching key

**Parameters**

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| `x-ngram-auth` | `header` | `string` | yes | teaching-key signature. Request-bound (recommended): `<address>:<ts>:<sig>:v2` where sig = signMessage("teach:\<nodeAddress>:\<METHOD>:\<path+query>:\<ts>[:\<sha256(body)>]"); legacy: `<address>:<ts>:<sig>` over "teach:\<ts>". 5-minute window, every header is single-use (replays are refused). |
| `x-ngram-dataset-sha256` | `header` | `string` |   | multipart only: sha256 of the file bytes; this string is what the v2 signature covers |

**Request body** — `multipart/form-data`, required

| Field | Type | Required | Description |
|---|---|---|---|
| `file` | `string (binary)` | yes |   |
| `name` | `string` |   | (at most 80 characters) |
| `format` | `"jsonl"` \| `"json"` \| `"csv"` \| `"tsv"` \| `"txt"` |   |   |
| `has_header` | `"true"` \| `"false"` |   |   |
| `delimiter` | `string` |   |   |
| `encoding` | `string` |   |   |
| `columns` | `string` |   | JSON: {"prompt":"question","answer":2} |
| `retention` | `"keep"` \| `"delete_after_training"` |   |   |

**Request body** — `application/json`, required

| Field | Type | Required | Description |
|---|---|---|---|
| `source` | `"chat"` \| `"inline"` \| `"sample"` |   | (default `"chat"`) |
| `rows` | `object`[] |   |   |
| `rows[].prompt` | `string` | yes | (at most 400 characters) |
| `rows[].answer` | `string` | yes | (at most 200 characters) |
| `rows[].alt_prompt` | `string` |   | (at most 400 characters) |
| `rows[].note` | `string` |   | (at most 500 characters) |
| `sample` | `"ko-facts"` \| `"en-facts"` \| `"mixed"` |   |   |
| `name` | `string` |   |   |
| `retention` | `"keep"` \| `"delete_after_training"` |   |   |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | the same bytes were already uploaded by this key — the existing dataset, unchanged |   |
| `201` | created | `object` |
| `400` | dataset_empty (no usable questions; `summary` and `rows` say why) \| dataset_format \| dataset_hash |   |
| `403` | teaching_disabled \| banned |   |
| `413` | dataset_too_large — `bytes` and `max_bytes` are in the body |   |
| `429` | quota_dataset \| quota_bytes \| rate_limited |   |

**`201` response body**

| Field | Type |
|---|---|
| `dataset` | [`TeachDataset`](./schemas.md#teachdataset) |
| `report` | `object` |
| `report.summary` | [`TeachDatasetSummary`](./schemas.md#teachdatasetsummary) |
| `report.rows` | [`TeachDatasetRow`](./schemas.md#teachdatasetrow)[] |
| `created` | `boolean` |

### `GET /api/teach/datasets`

My datasets (signed key)

Newest first, tombstones included so a deleted dataset still explains itself.

**Auth** — teaching key

**Parameters**

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| `x-ngram-auth` | `header` | `string` | yes | teaching-key signature. Request-bound (recommended): `<address>:<ts>:<sig>:v2` where sig = signMessage("teach:\<nodeAddress>:\<METHOD>:\<path+query>:\<ts>[:\<sha256(body)>]"); legacy: `<address>:<ts>:<sig>` over "teach:\<ts>". 5-minute window, every header is single-use (replays are refused). |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | datasets | `object` |

**`200` response body**

| Field | Type |
|---|---|
| `items` | [`TeachDataset`](./schemas.md#teachdataset)[] |

### `GET /api/teach/datasets/{id}`

One dataset

Owner (signed) or operator. Anyone else gets 404 — a stranger is never told that a dataset exists.

**Auth** — teaching key

**Parameters**

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| `id` | `path` | `string (uuid)` | yes | dataset id |
| `x-ngram-auth` | `header` | `string` | yes | teaching-key signature. Request-bound (recommended): `<address>:<ts>:<sig>:v2` where sig = signMessage("teach:\<nodeAddress>:\<METHOD>:\<path+query>:\<ts>[:\<sha256(body)>]"); legacy: `<address>:<ts>:<sig>` over "teach:\<ts>". 5-minute window, every header is single-use (replays are refused). |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | dataset | `object` |
| `404` | dataset_not_found |   |

**`200` response body**

| Field | Type |
|---|---|
| `dataset` | [`TeachDataset`](./schemas.md#teachdataset) |

### `PATCH /api/teach/datasets/{id}`

Rename, change retention, or add / remove / replace questions

Touched questions are revalidated against the whole dataset, so a new duplicate or contradiction is caught here. `revision` and `sha256` change; the id does not. 409 `dataset_in_use` while a lesson is training — fork instead.

**Auth** — teaching key

**Parameters**

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| `id` | `path` | `string (uuid)` | yes | dataset id |
| `x-ngram-auth` | `header` | `string` | yes | teaching-key signature. Request-bound (recommended): `<address>:<ts>:<sig>:v2` where sig = signMessage("teach:\<nodeAddress>:\<METHOD>:\<path+query>:\<ts>[:\<sha256(body)>]"); legacy: `<address>:<ts>:<sig>` over "teach:\<ts>". 5-minute window, every header is single-use (replays are refused). |

**Request body** — `application/json`, optional

| Field | Type | Description |
|---|---|---|
| `name` | `string` | (at most 80 characters) |
| `retention` | `"keep"` \| `"delete_after_training"` |   |
| `rows_op` | `object` | `object` | `object` |   |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | dataset + report | `object` |
| `409` | dataset_in_use |   |

### `DELETE /api/teach/datasets/{id}`

Delete a dataset (the lessons trained from it are kept)

Files are removed and a tombstone stays, so a lesson reads "the dataset for this lesson was deleted by its owner" instead of pointing at a dangling id. A published lesson then becomes unreproducible by its own teacher — the knowledge file and recipe.json remain the deliverable. 409 while a lesson is training.

**Auth** — teaching key

**Parameters**

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| `id` | `path` | `string (uuid)` | yes | dataset id |
| `x-ngram-auth` | `header` | `string` | yes | teaching-key signature. Request-bound (recommended): `<address>:<ts>:<sig>:v2` where sig = signMessage("teach:\<nodeAddress>:\<METHOD>:\<path+query>:\<ts>[:\<sha256(body)>]"); legacy: `<address>:<ts>:<sig>` over "teach:\<ts>". 5-minute window, every header is single-use (replays are refused). |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | deleted | `object` |
| `409` | dataset_in_use |   |

### `GET /api/teach/datasets/{id}/rows`

The per-question report, paginated

One entry per SOURCE row — accepted or not — with its 1-based logical line in the uploaded file and the reason it was not used.

**Auth** — teaching key

**Parameters**

| Name | In | Type | Required | Default | Description |
|---|---|---|---|---|---|
| `id` | `path` | `string (uuid)` | yes |   | dataset id |
| `x-ngram-auth` | `header` | `string` | yes |   | teaching-key signature. Request-bound (recommended): `<address>:<ts>:<sig>:v2` where sig = signMessage("teach:\<nodeAddress>:\<METHOD>:\<path+query>:\<ts>[:\<sha256(body)>]"); legacy: `<address>:<ts>:<sig>` over "teach:\<ts>". 5-minute window, every header is single-use (replays are refused). |
| `offset` | `query` | `integer` |   | `0` |   |
| `limit` | `query` | `integer` |   | `50` |   |
| `status` | `query` | `"all"` \| `"ok"` \| `"rejected"` \| `"duplicate"` \| `"conflict"` \| `"too_long"` \| `"empty"` \| `"blocked"` \| `"not_parsed"` \| `"over_cap"` |   |   |   |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | rows | `object` |

**`200` response body**

| Field | Type |
|---|---|
| `total` | `integer` |
| `source_rows` | `integer` |
| `offset` | `integer` |
| `limit` | `integer` |
| `summary` | [`TeachDatasetSummary`](./schemas.md#teachdatasetsummary) |
| `items` | [`TeachDatasetRow`](./schemas.md#teachdatasetrow)[] |

### `POST /api/teach/datasets/{id}/reparse`

Read the SAME uploaded file again with different settings

For "wrong columns or separator?". Nothing is re-uploaded. Only a dataset that has never been trained can be re-read; otherwise fork it.

**Auth** — teaching key

**Parameters**

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| `id` | `path` | `string (uuid)` | yes | dataset id |
| `x-ngram-auth` | `header` | `string` | yes | teaching-key signature. Request-bound (recommended): `<address>:<ts>:<sig>:v2` where sig = signMessage("teach:\<nodeAddress>:\<METHOD>:\<path+query>:\<ts>[:\<sha256(body)>]"); legacy: `<address>:<ts>:<sig>` over "teach:\<ts>". 5-minute window, every header is single-use (replays are refused). |

**Request body** — `application/json`, optional

| Field | Type |
|---|---|
| `format` | `string` |
| `delimiter` | `string` |
| `has_header` | `boolean` |
| `encoding` | `string` |
| `layout` | `string` |
| `columns` | `object` |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | dataset + report | `object` |
| `400` | dataset_empty read that way |   |
| `409` | dataset_in_use |   |

### `POST /api/teach/datasets/{id}/fork`

Copy a dataset (optionally with an edit) — how you change one while a lesson is training

**Auth** — teaching key

**Parameters**

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| `id` | `path` | `string (uuid)` | yes | dataset id |
| `x-ngram-auth` | `header` | `string` | yes | teaching-key signature. Request-bound (recommended): `<address>:<ts>:<sig>:v2` where sig = signMessage("teach:\<nodeAddress>:\<METHOD>:\<path+query>:\<ts>[:\<sha256(body)>]"); legacy: `<address>:<ts>:<sig>` over "teach:\<ts>". 5-minute window, every header is single-use (replays are refused). |

**Request body** — `application/json`, optional

| Field | Type |
|---|---|
| `name` | `string` |
| `rows_op` | `object` |

**Responses**

| Code | Description |
|---|---|
| `201` | the copy, with parent_dataset set and revision 1 |

### `GET /api/teach/datasets/{id}/download`

Download the questions (canonical .jsonl, or .csv)

The `.jsonl` bytes are the sha256 subject: download it, re-upload it, and you get 200 with the same dataset back.

**Auth** — teaching key

**Parameters**

| Name | In | Type | Required | Default | Description |
|---|---|---|---|---|---|
| `id` | `path` | `string (uuid)` | yes |   | dataset id |
| `x-ngram-auth` | `header` | `string` | yes |   | teaching-key signature. Request-bound (recommended): `<address>:<ts>:<sig>:v2` where sig = signMessage("teach:\<nodeAddress>:\<METHOD>:\<path+query>:\<ts>[:\<sha256(body)>]"); legacy: `<address>:<ts>:<sig>` over "teach:\<ts>". 5-minute window, every header is single-use (replays are refused). |
| `format` | `query` | `"jsonl"` \| `"csv"` |   | `"jsonl"` |   |

**Responses**

| Code | Description |
|---|---|
| `200` | the file, with x-content-sha256 |
| `404` | dataset_not_found |

### `POST /api/teach/preflight`

Check what the model already knows (before queuing a lesson)

Re-asks every correction with the chosen knowledge loaded; costs one live-test unit. Statuses: will_train · already_known · overlaps_listing · invalid.

**Auth** — teaching key

**Parameters**

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| `x-ngram-auth` | `header` | `string` | yes | teaching-key signature. Request-bound (recommended): `<address>:<ts>:<sig>:v2` where sig = signMessage("teach:\<nodeAddress>:\<METHOD>:\<path+query>:\<ts>[:\<sha256(body)>]"); legacy: `<address>:<ts>:<sig>` over "teach:\<ts>". 5-minute window, every header is single-use (replays are refused). |

**Request body** — `application/json`, required

either `facts` (v1) or `dataset_id` with an optional window

| Field | Type | Description |
|---|---|---|
| `patch_ids` | `string`[] | (at most 3 items) |
| `facts` | [`TeachFact`](./schemas.md#teachfact)[] | (1–8 items) |
| `dataset_id` | `string` |   |
| `offset` | `integer` |   |
| `limit` | `integer` | (at most 8) |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | per-correction status | `object` |
| `401` | invalid_signature |   |
| `403` | teaching_disabled \| banned \| not_owner |   |
| `429` | quota_key \| quota_ip |   |
| `503` | runtime unavailable |   |

**`200` response body**

| Field | Type |
|---|---|
| `facts` | `object`[] |
| `facts[].index` | `integer` |
| `facts[].status` | `"will_train"` \| `"already_known"` \| `"overlaps_listing"` \| `"invalid"` |
| `facts[].base_answer` | `string` |
| `facts[].detail` | `string` |
| `trainable` | `integer` |
| `quota` | `object` |
| `quota.key_remaining` | `integer` |
| `quota.ip_remaining` | `integer` |

### `POST /api/teach/jobs`

Queue a lesson (train the corrections into a knowledge file)

The body is `{dataset_id}` XOR the legacy `{facts}`. The legacy form materialises a dataset with `source: "chat"` server-side, so a lesson taught from the chat basket is exactly as re-trainable as one taught from an uploaded file. A dataset larger than `limits.rows_per_job` is not rejected: the first N are selected and the rest stay in the dataset for the next lesson (send `selected_indexes` to choose which N). `training.lr` is never accepted from a client.

**Auth** — teaching key

**Parameters**

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| `x-ngram-auth` | `header` | `string` | yes | teaching-key signature. Request-bound (recommended): `<address>:<ts>:<sig>:v2` where sig = signMessage("teach:\<nodeAddress>:\<METHOD>:\<path+query>:\<ts>[:\<sha256(body)>]"); legacy: `<address>:<ts>:<sig>` over "teach:\<ts>". 5-minute window, every header is single-use (replays are refused). |

**Request body** — `application/json`, required

| Field | Type | Description |
|---|---|---|
| `patch_ids` | `string`[] | (at most 3 items) |
| `builds_on_context` | `boolean` | legacy: record the loaded knowledge as sources (their creators share in sales). With `teach.lineage` on it becomes `base_ids: [patch_ids[0]]` and the response carries a Deprecation header. (default `false`) |
| `base_ids` | `string`[] | lineage: what this lesson is trained ON TOP OF — its rows are loaded as the keep-set, it is recorded as a base for good, its creators share every sale and buyers must load it first (design §12.1). Needs the `teach.lineage` flag. One base for extend; two is a merge (not on this node yet). (at most 2 items) |
| `context_ids` | `string`[] | loaded for COMPARISON only — never recorded as a base (at most 3 items) |
| `mode` | `"scratch"` \| `"extend"` \| `"fork"` \| `"merge"` |   |
| `inherit` | `boolean` | load the base’s questions as known answers so the lesson does not undo them (default `true`) |
| `export` | `"delta"` \| `"squash"` | delta = an add-on that needs its base; squash = a stand-alone build carrying the base rows (default `"delta"`) |
| `force` | `boolean` | build on a retired (superseded) base anyway |
| `dataset_id` | `string` |   |
| `selected_indexes` | `integer`[] |   |
| `known` | `object`[] | questions an interactive pre-flight found the model already answers, as {index, base_answer} against this dataset’s rows; each claim is re-checked against the row’s own answer and the accepted ones are recorded in job.preflight |
| `known[].index` | `integer` |   |
| `known[].base_answer` | `string` |   |
| `training` | `object` |   |
| `training.effort` | `"quick"` \| `"balanced"` \| `"thorough"` |   |
| `training.max_steps` | `integer` |   |
| `training.eval_every` | `integer` |   |
| `training.rows_limit` | `integer` |   |
| `training.row_offset` | `integer` |   |
| `training.check_side_effects` | `boolean` | (default `true`) |
| `training.use_alt` | `boolean` | (default `true`) |
| `facts` | [`TeachFact`](./schemas.md#teachfact)[] | (1–8 items) |
| `contributor` | `object` |   |
| `contributor.name` | `string` | (at most 40 characters) |
| `name` | `string` | (at most 80 characters) |

**Responses**

| Code | Description | Body |
|---|---|---|
| `202` | queued | `object` |
| `400` | dataset_too_large (only when `training.rows_limit` is above the cap) \| invalid \| base_unknown \| base_private \| base_retired \| base_rejected \| too_many_bases \| base_stack_too_deep |   |
| `401` | invalid_signature |   |
| `403` | teaching_disabled \| banned \| not_owner |   |
| `404` | dataset_not_found \| dataset_unavailable (the base’s training set is on no node here) |   |
| `409` | already_known \| overlaps_listing |   |
| `429` | quota_key \| quota_ip \| quota_rows |   |
| `503` | trainer_paused (queue full, too many questions waiting, or trainer down) |   |

**`202` response body**

| Field | Type |
|---|---|
| `job` | [`TeachJob`](./schemas.md#teachjob) |
| `quota` | `object` |
| `quota.key_remaining` | `integer` |
| `quota.ip_remaining` | `integer` |
| `quota.rows_remaining` | `integer` |
| `quota.rows_ip_remaining` | `integer` |

### `GET /api/teach/jobs`

My lessons (signed key)

**Auth** — teaching key

**Parameters**

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| `x-ngram-auth` | `header` | `string` | yes | teaching-key signature. Request-bound (recommended): `<address>:<ts>:<sig>:v2` where sig = signMessage("teach:\<nodeAddress>:\<METHOD>:\<path+query>:\<ts>[:\<sha256(body)>]"); legacy: `<address>:<ts>:<sig>` over "teach:\<ts>". 5-minute window, every header is single-use (replays are refused). |
| `mine` | `query` | `1` |   |   |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | lessons | `object` |

**`200` response body**

| Field | Type |
|---|---|
| `items` | [`TeachJob`](./schemas.md#teachjob)[] |

### `GET /api/teach/jobs/{id}`

Lesson status (poll every 5 s)

Full body for the owner (signed) or the operator; everyone else gets {id, status, position, eta_s}.

**Auth** — teaching key (optional)

**Parameters**

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| `id` | `path` | `string` | yes |   |
| `x-ngram-auth` | `header` | `string` |   | teaching-key signature. Request-bound (recommended): `<address>:<ts>:<sig>:v2` where sig = signMessage("teach:\<nodeAddress>:\<METHOD>:\<path+query>:\<ts>[:\<sha256(body)>]"); legacy: `<address>:<ts>:<sig>` over "teach:\<ts>". 5-minute window, every header is single-use (replays are refused). |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | lesson | [`TeachJob`](./schemas.md#teachjob) |

### `DELETE /api/teach/jobs/{id}`

Cancel / delete a lesson

Queued or training lessons are cancelled (the trainer process gets SIGTERM); private READY drafts are deleted with their files and links. 409 published_immutable once announced.

**Auth** — teaching key

**Parameters**

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| `id` | `path` | `string` | yes |   |
| `x-ngram-auth` | `header` | `string` | yes | teaching-key signature. Request-bound (recommended): `<address>:<ts>:<sig>:v2` where sig = signMessage("teach:\<nodeAddress>:\<METHOD>:\<path+query>:\<ts>[:\<sha256(body)>]"); legacy: `<address>:<ts>:<sig>` over "teach:\<ts>". 5-minute window, every header is single-use (replays are refused). |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | cancelled | `object` |
| `409` | published_immutable |   |

### `POST /api/teach/jobs/{id}/retry`

Improve & retry: queue a new lesson with edited corrections (same knowledge context)

**Auth** — teaching key

**Parameters**

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| `id` | `path` | `string` | yes |   |
| `x-ngram-auth` | `header` | `string` | yes | teaching-key signature. Request-bound (recommended): `<address>:<ts>:<sig>:v2` where sig = signMessage("teach:\<nodeAddress>:\<METHOD>:\<path+query>:\<ts>[:\<sha256(body)>]"); legacy: `<address>:<ts>:<sig>` over "teach:\<ts>". 5-minute window, every header is single-use (replays are refused). |

**Request body** — `application/json`, required

| Field | Type | Required |
|---|---|---|
| `facts` | [`TeachFact`](./schemas.md#teachfact)[] | yes |

**Responses**

| Code | Description |
|---|---|
| `202` | new lesson with parent_job |

### `POST /api/teach/jobs/{id}/retrain`

Train the same dataset again (or a fork of it)

Re-runs the pipeline from the same dataset by default, one effort level higher; `parent_job` is set and the quota is charged again. A lesson taught before datasets existed gets one written from its questions first.

**Auth** — teaching key

**Parameters**

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| `id` | `path` | `string` | yes |   |
| `x-ngram-auth` | `header` | `string` | yes | teaching-key signature. Request-bound (recommended): `<address>:<ts>:<sig>:v2` where sig = signMessage("teach:\<nodeAddress>:\<METHOD>:\<path+query>:\<ts>[:\<sha256(body)>]"); legacy: `<address>:<ts>:<sig>` over "teach:\<ts>". 5-minute window, every header is single-use (replays are refused). |

**Request body** — `application/json`, optional

| Field | Type |
|---|---|
| `dataset_id` | `string` |
| `selected_indexes` | `integer`[] |
| `training` | `object` |
| `name` | `string` |

**Responses**

| Code | Description |
|---|---|
| `202` | the new lesson |
| `404` | dataset_not_found |
| `429` | quota_key \| quota_ip \| quota_rows |

### `GET /api/teach/jobs/{id}/events`

This lesson’s log lines (poll every 2 s while it runs)

Owner or operator. Redacted for non-operators exactly as /api/events is.

**Auth** — teaching key

**Parameters**

| Name | In | Type | Required | Default | Description |
|---|---|---|---|---|---|
| `id` | `path` | `string` | yes |   |   |
| `x-ngram-auth` | `header` | `string` | yes |   | teaching-key signature. Request-bound (recommended): `<address>:<ts>:<sig>:v2` where sig = signMessage("teach:\<nodeAddress>:\<METHOD>:\<path+query>:\<ts>[:\<sha256(body)>]"); legacy: `<address>:<ts>:<sig>` over "teach:\<ts>". 5-minute window, every header is single-use (replays are refused). |
| `since` | `query` | `integer` |   |   | last seen `cursor` |
| `limit` | `query` | `integer` |   | `200` |   |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | events | `object` |

**`200` response body**

| Field | Type |
|---|---|
| `events` | `object`[] |
| `events[].seq` | `integer` |
| `events[].ts` | `integer` |
| `events[].level` | `string` |
| `events[].message` | `string` |
| `events[].data` | `object` |
| `cursor` | `integer` |

### `POST /api/teach/jobs/{id}/recheck`

Measure again a lesson that was saved unchecked (model server was down, or the side-effect check was turned off)

Owner or operator. Allowed for READY / NEEDS_MORE lessons whose `checks.executed` is false; the lesson goes back to EXPORTED and keeps its draft id.

**Auth** — teaching key

**Parameters**

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| `id` | `path` | `string` | yes |   |
| `x-ngram-auth` | `header` | `string` | yes | teaching-key signature. Request-bound (recommended): `<address>:<ts>:<sig>:v2` where sig = signMessage("teach:\<nodeAddress>:\<METHOD>:\<path+query>:\<ts>[:\<sha256(body)>]"); legacy: `<address>:<ts>:<sig>` over "teach:\<ts>". 5-minute window, every header is single-use (replays are refused). |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | re-queued for checking | `object` |
| `409` | job_not_ready |   |

### `GET /api/teach/jobs/{id}/publish-challenge`

What to sign before publishing

claim = sha256(canonical({patch_sha256, benchmark_hash, address, share})). `address` is the payout address (defaults to the teaching key; `payout_address=none` = credit only, share 0).

**Auth** — teaching key

**Parameters**

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| `id` | `path` | `string` | yes |   |
| `x-ngram-auth` | `header` | `string` | yes | teaching-key signature. Request-bound (recommended): `<address>:<ts>:<sig>:v2` where sig = signMessage("teach:\<nodeAddress>:\<METHOD>:\<path+query>:\<ts>[:\<sha256(body)>]"); legacy: `<address>:<ts>:<sig>` over "teach:\<ts>". 5-minute window, every header is single-use (replays are refused). |
| `payout_address` | `query` | `string` |   | AIN address, or `none` for credit only |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | challenge | `object` |
| `403` | publish_disabled |   |
| `409` | job_not_ready \| checks_failed |   |

**`200` response body**

| Field | Type |
|---|---|
| `patch_sha256` | `string` |
| `benchmark_hash` | `string` |
| `address` | `string` |
| `signer` | `string` |
| `share` | `number` |
| `claim` | `string` |

### `POST /api/teach/jobs/{id}/publish`

Publish the lesson through this node as a credited data provider

The node writes `contributors[]` (with the signed claim) into the draft and either announces it (policy auto) or parks it for operator review (policy review).

**Auth** — teaching key

**Parameters**

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| `id` | `path` | `string` | yes |   |
| `x-ngram-auth` | `header` | `string` | yes | teaching-key signature. Request-bound (recommended): `<address>:<ts>:<sig>:v2` where sig = signMessage("teach:\<nodeAddress>:\<METHOD>:\<path+query>:\<ts>[:\<sha256(body)>]"); legacy: `<address>:<ts>:<sig>` over "teach:\<ts>". 5-minute window, every header is single-use (replays are refused). |

**Request body** — `application/json`, required

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | yes |   |
| `description` | `string` |   |   |
| `price` | `string` |   |   |
| `license` | `string` |   | (default `"CC-BY-4.0"`) |
| `payout_address` | `string` \| `null` |   | null = credit only (share 0) |
| `claim_sig` | `string` | yes |   |
| `consent` | `object` | yes |   |
| `consent.permanent` | `boolean` |   |   |
| `consent.rights` | `boolean` |   |   |
| `dataset` | `object` |   | the training set: who may read it, under which licence (design §6.1, §6.4, §6.5) |
| `dataset.access` | `"public"` \| `"derivative"` \| `"private"` |   | public = anyone; derivative = people building on this knowledge; private = nobody (and nobody can build on it) (default `"derivative"`) |
| `dataset.license` | `"CC0-1.0"` \| `"CC-BY-4.0"` \| `"CC-BY-SA-4.0"` \| `"ODC-By-1.0"` \| `"Proprietary"` |   | (default `"CC-BY-4.0"`) |
| `dataset.include_notes` | `boolean` |   | include my per-row notes in the shared questions (default `false`) |
| `dataset.declaration` | `object` \| `null` |   | required at or above `limits.declaration_rows` questions |
| `dataset.declaration.source` | `"own"` \| `"public"` \| `"licensed"` | yes |   |
| `dataset.declaration.license` | `string` |   |   |
| `dataset.declaration.no_pii` | `boolean` | yes |   |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | PENDING_REVIEW or ANNOUNCED | `object` |
| `400` | consent_required \| parent_not_listed \| bad_license \| license_incompatible \| dataset_pii \| dataset_declaration |   |
| `401` | invalid_signature |   |
| `403` | publish_disabled |   |
| `409` | job_not_ready \| checks_failed |   |

**`200` response body**

| Field | Type |
|---|---|
| `status` | `"PENDING_REVIEW"` \| `"ANNOUNCED"` |
| `patch_id` | `string` |
| `url` | `string` |

### `POST /api/teach/jobs/{id}/save`

Keep it private: 7-day download links for the knowledge file, recipe.json and RUN-LOCALLY.md

**Auth** — teaching key

**Parameters**

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| `id` | `path` | `string` | yes |   |
| `x-ngram-auth` | `header` | `string` | yes | teaching-key signature. Request-bound (recommended): `<address>:<ts>:<sig>:v2` where sig = signMessage("teach:\<nodeAddress>:\<METHOD>:\<path+query>:\<ts>[:\<sha256(body)>]"); legacy: `<address>:<ts>:<sig>` over "teach:\<ts>". 5-minute window, every header is single-use (replays are refused). |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | download links | `object` |

**`200` response body**

| Field | Type |
|---|---|
| `download` | `object` |
| `download.npz_url` | `string` |
| `download.recipe_url` | `string` |
| `download.readme_url` | `string` |
| `download.expires_at` | `integer` |
| `sha256` | `string` |
| `rows` | `integer` |
| `size_bytes` | `integer` |
| `filename` | `string` |

### `GET /api/teach/jobs/{id}/recipe`

recipe.json (token link from save)

**Auth** — none

**Parameters**

| Name | In | Type | Required |
|---|---|---|---|
| `id` | `path` | `string` | yes |
| `token` | `query` | `string` | yes |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | recipe | `object` |

### `GET /api/teach/jobs/{id}/local-run`

RUN-LOCALLY.md (token link from save)

**Auth** — none

**Parameters**

| Name | In | Type | Required |
|---|---|---|---|
| `id` | `path` | `string` | yes |
| `token` | `query` | `string` | yes |

**Responses**

| Code | Description |
|---|---|
| `200` | text/markdown |

### `GET /api/teacher/{address}`

Public data-provider page: lessons and earnings (owed / paid / pending from settle records)

Earnings reconcile OWED (settle records, readable on any node) against PAID (this node’s payouts rows). A slice sold by another node shows as pending here until that node pays — the settle record is the evidence.

**Auth** — none

**Parameters**

| Name | In | Type | Required |
|---|---|---|---|
| `address` | `path` | `string` | yes |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | profile | [`TeacherProfile`](./schemas.md#teacherprofile) |

## Automatic payment & download

the x402 flow and blob download

### `GET /x402/patch/{id}`

Buy knowledge (x402)

Without a header: 402 + `x-payment-required`. Repeat with the payment proof in `X-PAYMENT`: 200 + manifest (JSON text, `x-content-sha256`).

**Auth** — payment (x402)

**Parameters**

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| `id` | `path` | `string` | yes |   |
| `X-PAYMENT` | `header` | `string` |   | base64(JSON X402Payload) |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | manifest | [`Manifest`](./schemas.md#manifest) |
| `402` | payment required / rejected |   |
| `423` | not for sale: verification quorum not met, or a verifier has challenged it (re-verification pending) |   |

### `GET /p2p/datasets`

Training sets this node holds (sha256, rows, access, licence)

**Auth** — none

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | list | `object` |

### `GET /p2p/dataset/{sha256}`

Download a published training set (.jsonl)

Same gate as `/p2p/blob` (`x-ngram-auth` over `dataset:<sha256>`, 5-minute skew) plus the access level: a `derivative` set needs a derive token in `x-ngram-derive` (or `?token=`), from `POST /api/patches/{id}/derive-intent`.

**Auth** — teaching key (optional)

**Parameters**

| Name | In | Type | Required |
|---|---|---|---|
| `sha256` | `path` | `string` | yes |
| `x-ngram-auth` | `header` | `string` |   |
| `x-ngram-derive` | `header` | `string` |   |
| `token` | `query` | `string` |   |

**Responses**

| Code | Description |
|---|---|
| `200` | application/x-ndjson |
| `403` | dataset_private \| dataset_derivative_only |
| `404` | not held by this node |

### `GET /p2p/dataset/{sha256}/manifest`

Manifest of a held training set

**Auth** — none

**Parameters**

| Name | In | Type | Required |
|---|---|---|---|
| `sha256` | `path` | `string` | yes |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | manifest | `object` |
| `403` | dataset_private \| dataset_derivative_only |   |

### `GET /p2p/dataset/{sha256}/benchmark`

The full benchmark list of a training set (the `answers_hash` preimage)

**Auth** — none

**Parameters**

| Name | In | Type | Required |
|---|---|---|---|
| `sha256` | `path` | `string` | yes |

**Responses**

| Code | Description |
|---|---|
| `200` | application/x-ndjson |
| `403` | dataset_private \| dataset_derivative_only |

### `GET /p2p/blob/{sha256}`

Download the knowledge body (.npz)

**Auth** — teaching key (optional) + payment (x402)

**Parameters**

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| `sha256` | `path` | `string` | yes |   |
| `token` | `query` | `string` |   | download_token from the manifest |
| `x-ngram-auth` | `header` | `string` |   | `<address>:<ts>:<sig>` — buyer / creator / verifier signature |

**Responses**

| Code | Description |
|---|---|
| `200` | application/octet-stream |
| `402` | purchase required |

## Register & sell knowledge

operator: register → announce → verified → sold

### `PATCH /api/patches/{id}`

Edit a DRAFT

**Auth** — operator

**Parameters**

| Name | In | Type | Required |
|---|---|---|---|
| `id` | `path` | `string` | yes |

**Request body** — `application/json`, optional

| Field | Type | Description |
|---|---|---|
| `name` | `string` |   |
| `description` | `string` |   |
| `price` | `string` |   |
| `branch` | `string` |   |
| `benchmark` | `object` |   |
| `license` | `string` |   |
| `visibility` | `"public"` \| `"test"` |   |
| `contributors` | [`Contributor`](./schemas.md#contributor)[] | (at most 4 items) |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | updated | `object` |

### `DELETE /api/patches/{id}`

Delete a DRAFT

**Auth** — operator

**Parameters**

| Name | In | Type | Required |
|---|---|---|---|
| `id` | `path` | `string` | yes |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | deleted | `object` |

### `POST /api/patches`

Register knowledge (created as a DRAFT)

**Auth** — operator

**Request body** — `multipart/form-data`, required

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | yes |   |
| `id` | `string` |   |   |
| `description` | `string` |   |   |
| `model_id` | `string` | yes |   |
| `benchmark` | `string` | yes | JSON string {schema, queries, format, samples:[{prompt,expect}]} |
| `price` | `string` |   |   |
| `parents` | `string` |   | comma-separated ids |
| `dataset_file` | `string` |   | lineage: a .jsonl/.csv on the node machine — the questions this knowledge was made from, pinned under their canonical sha256 and served under `dataset_access` |
| `dataset_access` | `"public"` \| `"derivative"` \| `"private"` |   | (default `"private"`) |
| `dataset_license` | `"CC0-1.0"` \| `"CC-BY-4.0"` \| `"CC-BY-SA-4.0"` \| `"ODC-By-1.0"` \| `"Proprietary"` |   |   |
| `branch` | `string` |   |   |
| `topic_path` | `string` |   |   |
| `visibility` | `"public"` \| `"test"` |   |   |
| `contributors` | `string` |   | JSON array of Contributor (≤ 4, Σ share ≤ 1) |
| `file` | `string (binary)` |   |   |
| `path` | `string` |   | .npz path on the node machine (instead of upload) |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | draft | `object` |

### `POST /api/patches/{id}/announce`

Announce — record on the ledger and request verification

**Auth** — operator

**Parameters**

| Name | In | Type | Required |
|---|---|---|---|
| `id` | `path` | `string` | yes |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | ledger record | `object` |

### `POST /api/patches/{id}/verify`

Run verification on this node now (verifier role)

Refused with 409 when this node published the knowledge (a self-attestation never counts) or when it already attested it and no challenge is open (the re-attestation would be discarded).

**Auth** — operator

**Parameters**

| Name | In | Type | Required |
|---|---|---|---|
| `id` | `path` | `string` | yes |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | attestation | [`Attestation`](./schemas.md#attestation) |
| `409` | self-attestation, or a re-attestation that would not be counted |   |

### `POST /api/patches/{id}/challenge`

Request re-verification (challenge)

**Auth** — operator

**Parameters**

| Name | In | Type | Required |
|---|---|---|---|
| `id` | `path` | `string` | yes |

**Request body** — `application/json`, optional

| Field | Type |
|---|---|
| `reason` | `string` |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | ok | `object` |

## Public record

ledger, provenance graph, network

### `GET /api/patches/{id}/records`

Ledger records about this knowledge

**Auth** — none

**Parameters**

| Name | In | Type | Required |
|---|---|---|---|
| `id` | `path` | `string` | yes |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | records | `object` |

### `GET /api/ledger`

Ledger records

Returns the NEWEST `limit` records (default 200, max 5000) plus `info`. There is no backward paging: when `info.records` is larger than the array you were given, you are looking at part of the record — say so rather than presenting it as the whole ledger.

**Auth** — none

**Parameters**

| Name | In | Type | Default | Description |
|---|---|---|---|---|
| `kind` | `query` | `"anchor"` \| `"attest"` \| `"settle"` \| `"challenge"` \| `"branch"` \| `"node"` \| `"supersede"` \| `"subscribe"` |   | filter server-side, over the WHOLE ledger (not over the window) |
| `limit` | `query` | `integer` | `200` |   |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | records | `object` |

### `GET /api/ledger/verify`

Ledger integrity check

**Auth** — none

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | result | `object` |

### `GET /api/ledger/graph`

Sources → derivatives graph (+ AIN knowledge graph)

**Auth** — none

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | graph | `object` |

### `GET /api/branches`

Knowledge tracks (branches)

**Auth** — none

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | list | `object` |

### `GET /api/route`

Find the branch and serving nodes for a context (e.g. jurisdiction=KR)

**Auth** — none

**Parameters**

| Name | In | Type |
|---|---|---|
| `key=value` | `query` | `string` |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | branch + nodes | `object` |

### `GET /api/nodes`

Known nodes and peers

**Auth** — none

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | list | `object` |

### `GET /api/events`

Node event log

**Auth** — none

**Parameters**

| Name | In | Type |
|---|---|---|
| `kind` | `query` | `string` |
| `limit` | `query` | `integer` |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | events | `object` |

### `GET /api/docs`

OpenAPI + CLI reference bundle for the web /docs page

**Auth** — none

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | docs | `object` |

### `GET /api/patches/{id}/events`

Node events about this knowledge (verification logs, sales, live tests)

**Auth** — none

**Parameters**

| Name | In | Type | Required |
|---|---|---|---|
| `id` | `path` | `string` | yes |
| `limit` | `query` | `integer` |   |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | events | `object` |

### `GET /api/openapi.json`

This document

**Auth** — none

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | OpenAPI | `object` |

### `GET /healthz`

Liveness: 200 while the process is up

**Auth** — none

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | ok, node, address, version, uptime_s | `object` |

**`200` response body**

| Field | Type |
|---|---|
| `ok` | `boolean` |
| `node` | `string` |
| `address` | `string` |
| `version` | `string` |
| `uptime_s` | `integer` |

### `GET /readyz`

Readiness: 200 when the ledger is reachable and, for a serving/verifier node, the runtime is available; 503 with the failing check otherwise

**Auth** — none

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | ready — checks.ledger / checks.runtime / checks.peers | `object` |
| `503` | not ready — the same body, with the failing check |   |

## Operator

wallet, settings, purchases, branches, peers, chain, drive

### `GET /api/me/teach/policy`

Teaching policy (overrides + effective + trainer state)

**Auth** — operator

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | policy | `object` |

### `PATCH /api/me/teach/policy`

Change the teaching policy (persisted in the node store)

**Auth** — operator

**Request body** — `application/json`, optional

| Field | Type | Description |
|---|---|---|
| `enabled` | `boolean` |   |
| `publish` | `"review"` \| `"auto"` \| `"never"` |   |
| `facts_per_job` | `integer` |   |
| `jobs_per_key_per_day` | `integer` |   |
| `jobs_per_ip_per_day` | `integer` |   |
| `queue_max` | `integer` |   |
| `contributor_share` | `number` | (0–0.9) |
| `draft_ttl_days` | `integer` |   |
| `paused_reason` | `string` \| `null` |   |
| `blocked_topics` | `string` \| `null` | regular expression; matching corrections are refused |
| `dataset_max_bytes` | `integer` \| `null` |   |
| `dataset_max_rows` | `integer` \| `null` |   |
| `rows_per_job` | `integer` \| `null` | explicit override — DISABLES the measured derivation |
| `rows_per_key_per_day` | `integer` \| `null` |   |
| `rows_per_ip_per_day` | `integer` \| `null` |   |
| `datasets_per_key_per_day` | `integer` \| `null` |   |
| `dataset_ttl_days` | `integer` \| `null` |   |
| `declaration_rows` | `integer` \| `null` |   |
| `queued_rows_max` | `integer` \| `null` |   |
| `check_call_budget` | `integer` \| `null` |   |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | policy | `object` |

### `GET /api/me/teach/datasets`

What visitors uploaded to this machine (moderation view)

Owner address, IP, filename, size, question count, status, retention and expiry for every dataset on this node. An operator who hosts uploads must be able to see and delete them; opening this view writes an audit event.

**Auth** — operator

**Parameters**

| Name | In | Type | Default |
|---|---|---|---|
| `limit` | `query` | `integer` | `200` |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | datasets | `object` |

**`200` response body**

| Field | Type |
|---|---|
| `items` | [`TeachDataset`](./schemas.md#teachdataset) & `object`[] |

### `GET /api/me/teach/jobs`

All lessons (with contributor and IP)

**Auth** — operator

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | lessons | `object` |

### `POST /api/me/teach/jobs/{id}/approve`

Approve a lesson in review → announce

**Auth** — operator

**Parameters**

| Name | In | Type | Required |
|---|---|---|---|
| `id` | `path` | `string` | yes |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | announced | `object` |

### `POST /api/me/teach/jobs/{id}/reject`

Decline a lesson in review (reason is shown to the contributor)

**Auth** — operator

**Parameters**

| Name | In | Type | Required |
|---|---|---|---|
| `id` | `path` | `string` | yes |

**Request body** — `application/json`, optional

| Field | Type | Required |
|---|---|---|
| `reason` | `string` | yes |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | rejected | `object` |

### `POST /api/me/teach/jobs/{id}/cancel`

Cancel a lesson

**Auth** — operator

**Parameters**

| Name | In | Type | Required |
|---|---|---|---|
| `id` | `path` | `string` | yes |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | cancelled | `object` |

### `GET /api/me/teach/contributors`

Contributors seen on this node

**Auth** — operator

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | list | `object` |

### `POST /api/me/teach/contributors/{address}`

Hide / show a contributor name

**Auth** — operator

**Parameters**

| Name | In | Type | Required |
|---|---|---|---|
| `address` | `path` | `string` | yes |

**Request body** — `application/json`, optional

| Field | Type |
|---|---|
| `hidden` | `boolean` |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | contributor | `object` |

### `GET /api/me/teach/bans`

Blocked keys / IPs

**Auth** — operator

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | list | `object` |

### `POST /api/me/teach/bans`

Block a key or IP

**Auth** — operator

**Request body** — `application/json`, optional

| Field | Type | Required |
|---|---|---|
| `kind` | `"address"` \| `"ip"` | yes |
| `value` | `string` | yes |
| `reason` | `string` |   |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | ban | `object` |

### `DELETE /api/me/teach/bans/{id}`

Unblock

**Auth** — operator

**Parameters**

| Name | In | Type | Required |
|---|---|---|---|
| `id` | `path` | `integer` | yes |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | ok | `object` |

### `POST /api/patches/{id}/buy`

Buy as this node (x402 handled automatically)

**Auth** — operator

**Parameters**

| Name | In | Type | Required |
|---|---|---|---|
| `id` | `path` | `string` | yes |

**Request body** — `application/json`, optional

| Field | Type | Description |
|---|---|---|
| `apply` | `boolean` | load into the model right after purchase |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | purchase steps | `object` |

### `POST /api/patches/{id}/apply`

Load into the model (with everything it was trained on top of)

Loads the ordered stack under one runtime lock: the bases first, then this knowledge. An add-on (`base.export: "delta"`) is written only after its `before` is compared to the live rows on EVERY row; a mismatch is 409 `base_mismatch` and nothing is written. Without `with_base` an add-on whose base is not loaded is refused 409 `needs_base`.

**Auth** — operator

**Parameters**

| Name | In | Type | Required |
|---|---|---|---|
| `id` | `path` | `string` | yes |

**Request body** — `application/json`, optional

| Field | Type | Description |
|---|---|---|
| `with_base` | `boolean` | also load the knowledges this one was trained on top of |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | result + the ordered stack | `object` |
| `409` | needs_base { missing } · base_not_held { missing } · base_mismatch { patch_id, rows_differ } |   |

### `DELETE /api/patches/{id}/apply`

Unload from the model (journal replay)

**Auth** — operator

**Parameters**

| Name | In | Type | Required |
|---|---|---|---|
| `id` | `path` | `string` | yes |

**Request body** — `application/json`, optional

| Field | Type | Description |
|---|---|---|
| `cascade` | `boolean` | also unload everything loaded on top of it |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | result + the ordered stack | `object` |
| `409` | has_dependents { ids } — something is loaded on top of it |   |

### `POST /api/patches/{id}/remove`

Unload from the model (same as DELETE …/apply)

**Auth** — operator

**Parameters**

| Name | In | Type | Required |
|---|---|---|---|
| `id` | `path` | `string` | yes |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | result + the ordered stack | `object` |

### `GET /api/patches/{id}/check`

Are the rows this knowledge was trained on the ones on the table right now?

Reads every row of the body through the patch hook and compares it to `before` bf16-exact: `differ_before: 0` means its base stack is underneath, exactly. Nothing is written.

**Auth** — operator

**Parameters**

| Name | In | Type | Required |
|---|---|---|---|
| `id` | `path` | `string` | yes |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | rows, differ_before, differ_after, ok, applied | `object` |

### `POST /api/patches/{id}/forget`

Stop serving the knowledge file from this node (deletes the local body; the ledger is untouched). 409 with `also_affects` when other items share the same file — repeat with `{"all_sharing": true}` to stop serving all of them

**Auth** — operator

**Parameters**

| Name | In | Type | Required |
|---|---|---|---|
| `id` | `path` | `string` | yes |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | sha256, deleted_file, also_affects | `object` |

### `POST /api/branches`

Create a branch

**Auth** — operator

**Request body** — `application/json`, optional

| Field | Type |
|---|---|
| `name` | `string` |
| `description` | `string` |
| `context` | `object` |
| `patch_ids` | `string`[] |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | branch | `object` |

### `POST /api/branches/{name}/subscribe`

Subscribe to a branch (load its knowledge and keep it loaded)

**Auth** — operator

**Parameters**

| Name | In | Type | Required |
|---|---|---|---|
| `name` | `path` | `string` | yes |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | ok | `object` |

### `POST /api/auth/login`

Operator login (first time: /api/auth/setup)

**Auth** — none

**Request body** — `application/json`, optional

| Field | Type |
|---|---|
| `password` | `string` |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | token | `object` |

**`200` response body**

| Field | Type |
|---|---|
| `ok` | `boolean` |
| `token` | `string` |

### `GET /api/me/wallet`

Wallet: balance, sales, creator revenue share, pending payouts

**Auth** — operator

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | wallet (adds `payouts: { pending, failed, paid, items }` — the unpaid royalty transfers this node owes) | `object` |

### `GET /api/me/payouts`

Royalty payouts this node owes creators and data providers (AIN ledger)

One row per (settle record, address). `pending` = written, transfer not yet confirmed; `failed` = last attempt errored (retried every 60 s up to 20 times); `paid` = tx_hash on chain. Local-credit sales never appear here (credited by the settle record).

**Auth** — operator

**Parameters**

| Name | In | Type | Default |
|---|---|---|---|
| `status` | `query` | `"pending"` \| `"paying"` \| `"paid"` \| `"failed"` |   |
| `address` | `query` | `string` |   |
| `limit` | `query` | `integer` | `200` |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | payouts | `object` |

**`200` response body**

| Field | Type | Description |
|---|---|---|
| `items` | [`Payout`](./schemas.md#payout)[] |   |
| `summary` | [`PayoutSummary`](./schemas.md#payoutsummary) |   |
| `max_attempts` | `integer` |   |
| `retry_ms` | `integer` |   |
| `wallet` | `boolean` | false on a local-ledger node (no chain wallet → rows cannot be paid) |

### `POST /api/me/payouts/{id}/retry`

Retry one failed / pending payout now (also after the 20 automatic attempts)

**Auth** — operator

**Parameters**

| Name | In | Type | Required |
|---|---|---|---|
| `id` | `path` | `integer` | yes |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | payout after the attempt | `object` |
| `404` | unknown payout |   |
| `409` | already paid |   |

**`200` response body**

| Field | Type |
|---|---|
| `payout` | [`Payout`](./schemas.md#payout) |

### `GET /api/me/patches`

Knowledge I registered

**Auth** — operator

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | list | `object` |

### `GET /api/me/purchases`

Knowledge I bought

**Auth** — operator

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | list | `object` |

### `GET /api/me/settings`

Read settings

**Auth** — operator

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | settings | `object` |

### `PATCH /api/me/settings`

Change settings

**Auth** — operator

**Request body** — `application/json`, optional

| Field | Type |
|---|---|
| `notifications` | `"all"` \| `"sales"` \| `"none"` |
| `display_name` | `string` |
| `payout_address` | `string` |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | settings | `object` |

### `GET /api/chain`

Ledger / chain state and balance

**Auth** — none

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | state | `object` |

### `GET /api/drive`

aindrive state and file list

**Auth** — none

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | state | `object` |

### `POST /api/drive`

aindrive start / stop / sync

**Auth** — operator

**Request body** — `application/json`, optional

| Field | Type |
|---|---|
| `action` | `"up"` \| `"stop"` \| `"sync"` \| `"status"` \| `"login"` |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | result | `object` |

### `GET /api/auth/me`

Who am I (signed in?, node address, needsSetup)

**Auth** — none

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | auth state | `object` |

### `POST /api/auth/setup`

Set the operator password (first run only)

**Auth** — none

**Request body** — `application/json`, optional

| Field | Type | Description |
|---|---|---|
| `password` | `string` | (at least 4 characters) |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | token | `object` |
| `409` | already set |   |

### `POST /api/auth/logout`

Log out

**Auth** — none

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | ok | `object` |

### `POST /api/branches/{name}/patches`

Add knowledge to a branch (owner only)

**Auth** — operator

**Parameters**

| Name | In | Type | Required |
|---|---|---|---|
| `name` | `path` | `string` | yes |

**Request body** — `application/json`, optional

| Field | Type |
|---|---|
| `patch_id` | `string` |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | branch | `object` |

### `POST /api/branches/{name}/unsubscribe`

Unsubscribe from a branch (unload its knowledge)

**Auth** — operator

**Parameters**

| Name | In | Type | Required |
|---|---|---|---|
| `name` | `path` | `string` | yes |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | ok | `object` |

### `GET /api/runtime`

Serving runtime state (model, hook, the ordered stack of loaded knowledge)

`stack` is bottom-first: `position`, what each layer was trained on (`base_stack`, `export`) and whether the journal that would undo it is still on disk.

**Auth** — none

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | runtime | `object` |

### `GET /api/runtime/stack`

The ordered stack loaded in the serving model

Same `stack` as GET /api/runtime, on its own. Bottom first: a knowledge is always above everything it was trained on top of.

**Auth** — none

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | stack + journal_dir | `object` |

### `POST /api/runtime/complete`

Raw completion on the serving model (try the model)

Returns the shown answer plus the degeneracy flag `{truncated, shown_chars, raw_chars}` (and `raw_text` when it was cut). `raw: true` sends the pre-guard body: no stop sequences, no truncation.

**Auth** — operator

**Request body** — `application/json`, optional

| Field | Type | Description |
|---|---|---|
| `prompt` | `string` |   |
| `max_tokens` | `integer` | (default `16`) |
| `raw` | `boolean` | (default `false`) |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | text + truncation flag | `object` |

### `POST /api/peers`

Add a peer

**Auth** — operator

**Request body** — `application/json`, optional

| Field | Type |
|---|---|
| `endpoint` | `string` |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | ok | `object` |

### `DELETE /api/peers`

Remove a peer

**Auth** — operator

**Request body** — `application/json`, optional

| Field | Type |
|---|---|
| `endpoint` | `string` |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | ok | `object` |

### `POST /api/chain/setup`

Create the knowledge app on the AIN chain, set market rules, stake (AIN ledger only)

**Auth** — operator

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | result | `object` |

### `GET /api/drive/changes`

Change history of a drive file (aindrive Willow store)

**Auth** — none

**Parameters**

| Name | In | Type | Required |
|---|---|---|---|
| `path` | `query` | `string` | yes |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | changes | `object` |

## P2P

node-to-node protocol

### `POST /p2p/hello`

Peer introduction (exchange PeerInfo)

**Auth** — none

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | PeerInfo | `object` |

### `GET /p2p/peers`

Peer list for peer exchange

**Auth** — none

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | endpoints | `object` |

### `GET /p2p/blobs`

Knowledge bodies held by this node (sha256 list)

**Auth** — none

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | blobs | `object` |

### `GET /p2p/info`

Node info

**Auth** — none

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | PeerInfo | `object` |

### `GET /p2p/records`

Ledger record sync (local-ledger mode)

**Auth** — none

**Parameters**

| Name | In | Type |
|---|---|---|
| `since` | `query` | `number` |

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | records + cursor | `object` |

### `POST /p2p/records`

Push records

**Auth** — none

**Responses**

| Code | Description | Body |
|---|---|---|
| `200` | added/rejected | `object` |
