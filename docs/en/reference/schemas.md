---
title: Schemas
summary: The reusable request and response shapes of the node HTTP API
---

# Schemas

> [!NOTE]
> **This page is generated — do not edit it by hand.** It is written by `scripts/docs-gen.mjs` from `packages/node/src/openapi.ts`.
> Regenerate with `npm run docs:gen`; `npm run docs:check` fails when this page and the source disagree.

The 28 named shapes the [HTTP API](./http-api.md) refers to.

## How to read this page

Fields are listed with their full path, so a nested field appears as its own row
(`dataset.parents[].patch_id`) instead of being indented out of legibility. A field whose type is another schema links to it rather than inlining it.

| Schema | What it is |
|---|---|
| [`Anchor`](#anchor) | Public description of a knowledge item (patch). Immutable once recorded on the ledger. |
| [`CanonicalRow`](#canonicalrow) | One question and answer as stored in a training set (`rows.jsonl`, canonical bytes — the sha256 of the file is the set’s identity). |
| [`Contributor`](#contributor) | A data provider credited on an anchor. `author` stays the publishing node; the contributor is a signed claim inside the anchor. |
| [`Attestation`](#attestation) |   |
| [`Challenge`](#challenge) | A verifier disputing a listed knowledge. While the newest challenge is newer than the newest counted verification the entry is CHALLENGED and not for sale. |
| [`CatalogEntry`](#catalogentry) |   |
| [`Manifest`](#manifest) | Document returned after payment. Its sha256 must match the ledger anchor. |
| [`X402Requirement`](#x402requirement) |   |
| [`X402Payload`](#x402payload) | Sent base64(JSON) in the X-PAYMENT header. |
| [`ChatMessage`](#chatmessage) |   |
| [`ChatRequest`](#chatrequest) | Exactly one of `patch_id` (one knowledge) or `patch_ids` (0–3 knowledges, loaded in list order; the last one wins on overlapping memory entries). `patch_ids: []` is legal and means "ask the model this node serves with nothing loaded" — teach mode’s conversational door, and the only thing a visitor can ask on a node with an empty catalog; the answer comes back in `base` with mode `base`. |
| [`ChatAnswer`](#chatanswer) | One generated answer. `content` is what to SHOW: when `truncated` is "repetition" the model got stuck repeating itself and the answer was cut at that point, with the full text kept in `raw_content`. "length" means it simply ran out of budget. |
| [`ChatStatus`](#chatstatus) | Where one live test is in the queue behind the shared serving model. |
| [`ChatResponse`](#chatresponse) |   |
| [`ChatApplied`](#chatapplied) |   |
| [`ChatPatches`](#chatpatches) |   |
| [`Error`](#error) |   |
| [`Payout`](#payout) | One royalty transfer owed by this node for one settle record (spec §7.5 / §9.3). Written `pending` BEFORE the AIN transfer is attempted; `paid` carries the tx hash, `failed` the last error and is retried every 60 s (max 20 attempts, then by hand). |
| [`PayoutSummary`](#payoutsummary) |   |
| [`TeacherProfile`](#teacherprofile) |   |
| [`TeachFact`](#teachfact) | One correction: the question, the right answer (single line, ≤ 200 chars) and an optional paraphrase used as a held-out check. |
| [`TeachChecks`](#teachchecks) | Measured in the live model after training. `ok` (= locality.ok && parent_regression.ok) is the hard publish gate. |
| [`TeachJob`](#teachjob) | A lesson (teach job). Full body only for the owner (signed) or the operator; others get {id, status, position, eta_s}. |
| [`TeachDataset`](#teachdataset) | A dataset: the durable artifact a lesson is trained from. Both doors (corrections collected in chat, and an uploaded file) produce one of these, and it is what makes "train it again", "add questions" and "download what this lesson learned from" true. |
| [`TeachDatasetSummary`](#teachdatasetsummary) | Counts over the SOURCE rows. Nothing is silently dropped: every rejection has a bucket here and a per-row reason in /rows. |
| [`TeachDatasetRow`](#teachdatasetrow) | One SOURCE row, accepted or not. `line` is the 1-based logical row in the uploaded file (a quoted CSV newline is one row, not two); `index` is the position in the dataset, null when the row was not accepted. |
| [`TeachDatasetRef`](#teachdatasetref) | What a lesson was trained from. A lesson taught before datasets existed renders `{id: null, source: "derived"}` and still publishes and pays out. |
| [`TeachPolicy`](#teachpolicy) |   |

## `Anchor`

Public description of a knowledge item (patch). Immutable once recorded on the ledger.

| Field | Type | Description |
|---|---|---|
| `id` | `string` | (e.g. `"krx-all-2761"`) |
| `name` | `string` |   |
| `description` | `string` |   |
| `author` | `string` | AIN address (identity of the selling node) |
| `model` | `object` |   |
| `model.id_M` | `string` | (e.g. `"Qwen3.8-Flash-Next"`) |
| `model.row_dim` | `integer` |   |
| `patch_sha256` | `string` |   |
| `size_bytes` | `integer` |   |
| `rows` | `integer` | learned memory entries |
| `benchmark` | `object` |   |
| `benchmark.schema` | `string` |   |
| `benchmark.queries` | `integer` | facts covered |
| `benchmark.format` | `string`[] |   |
| `benchmark.samples` | `object`[] |   |
| `benchmark.samples[].prompt` | `string` |   |
| `benchmark.samples[].expect` | `string` |   |
| `price` | `string` | (e.g. `"25"`) |
| `currency` | `"AIN"` \| `"CREDIT"` \| `"USDC"` |   |
| `billing` | `"per_download"` \| `"per_apply_hour"` \| `"per_hit"` |   |
| `parents` | `string`[] | source knowledge ids — their creators receive a share of each sale |
| `branch` | `string` |   |
| `topic_path` | `string` |   |
| `created_at` | `integer` |   |
| `visibility` | `"public"` \| `"test"` |   |
| `contributors` | [`Contributor`](#contributor)[] | data providers credited on this knowledge ("Taught by …"); paid from the seller remainder on every sale (at most 4 items) |
| `origin` | `"operator"` \| `"teach"` | "teach" = taught by a visitor through this node; absent = registered by the operator |
| `dataset` | `object` | lineage: the training set this knowledge was built from — hashes and counts here, the bytes in the content-addressed dataset store (design §5.1, §6) |
| `dataset.sha256` | `string` |   |
| `dataset.rows` | `integer` |   |
| `dataset.source` | `"chat"` \| `"upload"` \| `"derived"` |   |
| `dataset.access` | `"public"` \| `"derivative"` \| `"private"` | who may read the questions; absent = private (every anchor written before lineage) |
| `dataset.license` | `"CC0-1.0"` \| `"CC-BY-4.0"` \| `"CC-BY-SA-4.0"` \| `"ODC-By-1.0"` \| `"Proprietary"` |   |
| `dataset.parents` | `object`[] | ⊆ parents — the training sets this one was built from |
| `dataset.parents[].patch_id` | `string` |   |
| `dataset.parents[].sha256` | `string` |   |
| `dataset.parents[].rows` | `integer` |   |
| `dataset.merkle_root` | `string` | leaf = sha256(canonical row): lets a private base’s rows be proven by inclusion |
| `derivation` | `object` | what this knowledge did to its bases. Absent = "declared parent — not trained on top" (every pre-lineage anchor). |
| `derivation.kind` | `"extend"` \| `"update"` \| `"contradict"` \| `"merge"` \| `"transfer"` |   |
| `derivation.bases` | `object`[] |   |
| `derivation.bases[].patch_id` | `string` |   |
| `derivation.bases[].patch_sha256` | `string` |   |
| `derivation.bases[].dataset_sha256` | `string` |   |
| `derivation.bases[].rows` | `integer` |   |
| `derivation.added_rows` | `integer` |   |
| `derivation.changed_rows` | `integer` |   |
| `derivation.removed_rows` | `integer` |   |
| `derivation.policy` | `"keep_a"` \| `"keep_b"` \| `"manual"` |   |
| `derivation.tier` | `"union"` \| `"retrain"` \| `"rebuild"` |   |
| `base` | `object` | the table state the body was trained against: an ordered stack that must be loaded BELOW this knowledge. Absent = stand-alone build. |
| `base.stack` | `object`[] |   |
| `base.stack[].patch_id` | `string` |   |
| `base.stack[].patch_sha256` | `string` |   |
| `base.export` | `"delta"` \| `"squash"` |   |
| `base.pre_state_sha256` | `string` |   |

## `CanonicalRow`

One question and answer as stored in a training set (`rows.jsonl`, canonical bytes — the sha256 of the file is the set’s identity).

| Field | Type | Required | Description |
|---|---|---|---|
| `prompt` | `string` | yes |   |
| `answer` | `string` | yes |   |
| `alt_prompt` | `string` |   | a second phrasing, checked as held-out |
| `note` | `string` |   | the publisher’s note about this row — shared only when they opted in |
| `from` | `string` |   | '\<parent_patch_id>#\<row_index>' for a row inherited unchanged |
| `replaces` | `string` |   | the inherited row this one overrides |

## `Contributor`

A data provider credited on an anchor. `author` stays the publishing node; the contributor is a signed claim inside the anchor.

| Field | Type | Required | Description |
|---|---|---|---|
| `address` | `string` | yes | paid AIN address |
| `signer` | `string` |   | teaching key when different from `address` |
| `name` | `string` |   | (at most 40 characters) |
| `share` | `number` | yes | fraction of the seller remainder after the lineage share (carved sequentially; Σ ≤ 1) (0–1) |
| `role` | `"data_provider"` | yes |   |
| `proof` | `"signed"` \| `"declared"` | yes |   |
| `sig` | `string` |   | signature over hashCanonical({patch_sha256, benchmark_hash, address, share}) |

## `Attestation`

| Field | Type | Description |
|---|---|---|
| `patch_id` | `string` |   |
| `verifier` | `string` |   |
| `verifier_name` | `string` |   |
| `passed` | `boolean` |   |
| `verified_on` | `string` | "vllm:\<model>" = benchmark executed on the real model; "hash-only" = integrity check only |
| `score` | `object` |   |
| `restarts_detected` | `integer` |   |
| `stake` | `string` | **Deprecated.** historical only — no deposit was ever escrowed or slashed; new attestations omit it |
| `created_at` | `integer` |   |

## `Challenge`

A verifier disputing a listed knowledge. While the newest challenge is newer than the newest counted verification the entry is CHALLENGED and not for sale.

| Field | Type |
|---|---|
| `patch_id` | `string` |
| `challenger` | `string` |
| `reason` | `string` |
| `created_at` | `integer` |

## `CatalogEntry`

| Field | Type | Description |
|---|---|---|
| `anchor` | [`Anchor`](#anchor) |   |
| `status` | `"DRAFT"` \| `"ANNOUNCED"` \| `"VERIFYING"` \| `"LISTED"` \| `"REJECTED"` \| `"CHALLENGED"` \| `"SUPERSEDED"` \| `"RETIRED"` |   |
| `attestations` | [`Attestation`](#attestation)[] |   |
| `passed` | `integer` | passing verifications that executed the benchmark, by verifiers other than the author |
| `integrity_checks` | `integer` |   |
| `self_checks` | `integer` | attestations by the anchor's own author, excluded from every count above |
| `quorum` | `integer` |   |
| `quorum_ok` | `boolean` |   |
| `sellable` | `boolean` | quorum met AND no open challenge — the flag the 402 gate reads |
| `open_challenge` | [`Challenge`](#challenge) |   |
| `downloads` | `integer` |   |
| `revenue` | `string` |   |
| `superseded_by` | `string`[] |   |
| `children` | `string`[] |   |

## `Manifest`

Document returned after payment. Its sha256 must match the ledger anchor.

| Field | Type |
|---|---|
| `id` | `string` |
| `patch_sha256` | `string` |
| `size_bytes` | `integer` |
| `rows` | `integer` |
| `blob_urls` | `string`[] |
| `download_token` | `string` |
| `issued_to` | `string` |

## `X402Requirement`

| Field | Type |
|---|---|
| `scheme` | `"ain-transfer"` \| `"local-credit"` |
| `network` | `string` |
| `asset` | `string` |
| `payTo` | `string` |
| `maxAmountRequired` | `string` |
| `resource` | `string` |
| `nonce` | `string` |
| `expires_at` | `integer` |

## `X402Payload`

Sent base64(JSON) in the X-PAYMENT header.

| Field | Type | Description |
|---|---|---|
| `scheme` | `string` |   |
| `network` | `string` |   |
| `txHash` | `string` | ain-transfer: AIN transfer tx hash / local-credit: intent hash |
| `from` | `string` |   |
| `to` | `string` |   |
| `amount` | `string` |   |
| `nonce` | `string` |   |
| `proof` | `string` | local-credit: buyer signature over the intent hash |

## `ChatMessage`

| Field | Type | Required | Description |
|---|---|---|---|
| `role` | `"system"` \| `"user"` \| `"assistant"` | yes |   |
| `content` | `string` | yes | (at most 4000 characters) |

## `ChatRequest`

Exactly one of `patch_id` (one knowledge) or `patch_ids` (0–3 knowledges, loaded in list order; the last one wins on overlapping memory entries). `patch_ids: []` is legal and means "ask the model this node serves with nothing loaded" — teach mode’s conversational door, and the only thing a visitor can ask on a node with an empty catalog; the answer comes back in `base` with mode `base`.

| Field | Type | Required | Description |
|---|---|---|---|
| `patch_id` | `string` |   |   |
| `patch_ids` | `string`[] |   | (0–3 items) |
| `mode` | `"base"` \| `"patched"` \| `"compare"` |   | (default `"compare"`) |
| `messages` | [`ChatMessage`](#chatmessage)[] | yes | the conversation, ending with the question; used for both columns unless overridden below |
| `messages_base` | [`ChatMessage`](#chatmessage)[] |   | compare mode: the conversation as the BASE column saw it (replay base answers). Must end with the same message as `messages`. |
| `messages_patched` | [`ChatMessage`](#chatmessage)[] |   | compare mode: the conversation as the PATCHED column saw it (replay patched answers). Must end with the same message as `messages`. |
| `max_tokens` | `integer` |   | (default `200`) |
| `thinking` | `boolean` |   | (default `false`) |
| `request_id` | `string` |   | client id for this live test — lets it poll GET /api/chat/status and cancel while still queued (at most 64 characters) |

## `ChatAnswer`

One generated answer. `content` is what to SHOW: when `truncated` is "repetition" the model got stuck repeating itself and the answer was cut at that point, with the full text kept in `raw_content`. "length" means it simply ran out of budget.

| Field | Type | Description |
|---|---|---|
| `content` | `string` |   |
| `latency_ms` | `integer` |   |
| `model` | `string` |   |
| `finish_reason` | `string` \| `null` |   |
| `truncated` | `"repetition"` \| `"length"` \| `null` |   |
| `shown_chars` | `integer` |   |
| `raw_chars` | `integer` |   |
| `raw_content` | `string` | the model's full output — present only when it was cut |

## `ChatStatus`

Where one live test is in the queue behind the shared serving model.

| Field | Type | Description |
|---|---|---|
| `state` | `"queued"` \| `"running"` \| `"gone"` |   |
| `queued_ms` | `integer` |   |
| `running_ms` | `integer` |   |
| `position` | `integer` | 1 = next in line; 0 once running |
| `cancelled` | `boolean` |   |
| `lock` | `object` \| `null` |   |
| `lock.owner` | `string` |   |
| `lock.label` | `string` |   |
| `lock.since` | `integer` |   |
| `lock.alive` | `boolean` |   |
| `lock.stale` | `boolean` |   |
| `lock.mine` | `boolean` |   |
| `waiting` | `integer` |   |
| `now` | `integer` | the node clock, for measuring elapsed time |

## `ChatResponse`

| Field | Type | Description |
|---|---|---|
| `patch_id` | `string` |   |
| `mode` | `string` |   |
| `base` | [`ChatAnswer`](#chatanswer) |   |
| `patched` | [`ChatAnswer`](#chatanswer) |   |
| `applied_ms` | `integer` \| `null` | sum over all loaded knowledges (kept for single-knowledge clients) |
| `was_applied` | `boolean` | first knowledge was already loaded by the operator |
| `benchmark_hit` | `boolean` \| `null` | OR over benchmark_hits (kept for single-knowledge clients) |
| `patch_ids` | `string`[] |   |
| `applied` | [`ChatApplied`](#chatapplied)[] |   |
| `benchmark_hits` | `object` | per knowledge: true/false when the question is one of its benchmark samples, else null |
| `model` | `string` \| `null` |   |
| `remaining_quota` | `integer` \| `null` |   |
| `quota_limit` | `integer` \| `null` |   |
| `history` | `object` | how many messages each column was sent, and whether the two conversations differed |
| `history.base` | `integer` |   |
| `history.patched` | `integer` |   |
| `history.split` | `boolean` |   |

## `ChatApplied`

| Field | Type | Description |
|---|---|---|
| `patch_id` | `string` |   |
| `applied_ms` | `integer` \| `null` | null when it was already loaded and did not need re-loading |
| `was_applied` | `boolean` |   |

## `ChatPatches`

| Field | Type | Description |
|---|---|---|
| `items` | `object`[] |   |
| `runtime` | `object` |   |
| `lock` | `object` \| `null` | `alive` is a liveness probe of the holder process and `stale` its 15-minute lease check — a lock left behind by a killed node has alive:false and is broken by the next request. |
| `lock.owner` | `string` |   |
| `lock.label` | `string` |   |
| `lock.since` | `integer` |   |
| `lock.alive` | `boolean` |   |
| `lock.stale` | `boolean` |   |
| `lock.mine` | `boolean` |   |
| `now` | `integer` | the node clock, so elapsed times are measured against it |
| `queue` | `object` |   |
| `queue.running` | `object` \| `null` |   |
| `queue.running.label` | `string` |   |
| `queue.running.since` | `integer` |   |
| `queue.waiting` | `integer` |   |
| `applied` | `string`[] | knowledge the operator keeps loaded for everyone — it is part of the "before" answer |
| `dirty` | `string`[] | bodies a recent live test found on the shared model that this node never loaded (something else left them there); the next test unloads them for the "before" answer and does not put them back |
| `elsewhere` | `object`[] | knowledge this node’s model could run but cannot load: `reason` is not_held \| not_licensed \| verify_only, with the price and the seller |
| `elsewhere[].patch_id` | `string` |   |
| `elsewhere[].name` | `string` |   |
| `elsewhere[].author` | `string` |   |
| `elsewhere[].price` | `string` |   |
| `elsewhere[].currency` | `string` |   |
| `elsewhere[].status` | `string` |   |
| `elsewhere[].reason` | `string` |   |
| `elsewhere[].buyable` | `boolean` |   |
| `elsewhere[].requests` | `integer` |   |
| `elsewhere[].gateway_url` | `string` \| `null` |   |
| `overlaps` | `object`[] | pairs of testable knowledges that share memory entries |
| `overlaps[].a` | `string` |   |
| `overlaps[].b` | `string` |   |
| `overlaps[].rows` | `integer` |   |
| `lessons` | `object`[] | only with a verified `x-ainize-auth` (purpose `teach`): the caller’s private lessons |
| `teacher` | `string` | verified caller address (only with `x-ainize-auth`) |

## `Error`

| Field | Type |
|---|---|
| `error` | `string` |

## `Payout`

One royalty transfer owed by this node for one settle record (spec §7.5 / §9.3). Written `pending` BEFORE the AIN transfer is attempted; `paid` carries the tx hash, `failed` the last error and is retried every 60 s (max 20 attempts, then by hand).

| Field | Type | Description |
|---|---|---|
| `id` | `integer` |   |
| `patch_id` | `string` |   |
| `settle_hash` | `string` | the settle record this payout belongs to (the evidence in a dispute) |
| `address` | `string` | creator or data-provider address |
| `amount` | `string` |   |
| `currency` | `string` |   |
| `status` | `"pending"` \| `"paying"` \| `"paid"` \| `"failed"` | `paying` = transfer in flight (claimed atomically; never attempted twice) |
| `tx_hash` | `string` \| `null` |   |
| `attempts` | `integer` |   |
| `last_error` | `string` \| `null` |   |
| `created_at` | `integer` |   |
| `updated_at` | `integer` |   |

## `PayoutSummary`

| Field | Type |
|---|---|
| `pending` | `integer` |
| `failed` | `integer` |
| `paid` | `integer` |

## `TeacherProfile`

| Field | Type | Description |
|---|---|---|
| `address` | `string` |   |
| `name` | `string` |   |
| `hidden` | `boolean` |   |
| `lessons` | `object`[] |   |
| `lessons[].id` | `string` |   |
| `lessons[].name` | `string` |   |
| `lessons[].status` | `string` |   |
| `lessons[].verified` | `boolean` |   |
| `lessons[].downloads` | `integer` |   |
| `lessons[].revenue` | `string` |   |
| `earnings` | `object` | `owed` from settle records (readable on any node), `paid` from this node’s payouts rows; `pending` = owed − paid, `failed` = the part whose automatic transfer attempts are exhausted (still owed). |
| `earnings.currency` | `string` |   |
| `earnings.owed` | `string` |   |
| `earnings.paid` | `string` |   |
| `earnings.pending` | `string` |   |
| `earnings.failed` | `string` |   |
| `earnings.sales` | `integer` |   |
| `earnings.items` | `object`[] |   |
| `earnings.items[].patch_id` | `string` |   |
| `earnings.items[].seller` | `string` |   |
| `earnings.items[].settle_hash` | `string` |   |
| `earnings.items[].amount` | `string` |   |
| `earnings.items[].currency` | `string` |   |
| `earnings.items[].scheme` | `string` |   |
| `earnings.items[].status` | `"paid"` \| `"pending"` \| `"failed"` |   |
| `earnings.items[].tx_hash` | `string` |   |
| `earnings.items[].attempts` | `integer` |   |
| `earnings.items[].created_at` | `integer` |   |
| `earnings.items[].paid_at` | `integer` |   |

## `TeachFact`

One correction: the question, the right answer (single line, ≤ 200 chars) and an optional paraphrase used as a held-out check.

| Field | Type | Required | Description |
|---|---|---|---|
| `prompt` | `string` | yes | (at most 400 characters) |
| `answer` | `string` | yes | (at most 200 characters) |
| `alt_prompt` | `string` |   | (at most 400 characters) |
| `base_answer` | `string` |   | what the model said before (from preflight) |
| `after_answer` | `string` |   |   |
| `hit` | `boolean` |   |   |
| `heldout_hit` | `boolean` |   |   |

## `TeachChecks`

Measured in the live model after training. `ok` (= locality.ok && parent_regression.ok) is the hard publish gate.

| Field | Type | Description |
|---|---|---|
| `executed` | `boolean` |   |
| `taught` | `object` |   |
| `taught.hits` | `integer` |   |
| `taught.total` | `integer` |   |
| `taught.sampled` | `object` | present when the dataset was too big to check whole — never make a whole-dataset claim from it |
| `taught.sampled.checked` | `integer` |   |
| `taught.sampled.of` | `integer` |   |
| `skipped` | `boolean` | the visitor turned the side-effect check off; publishing stays gated until POST /api/teach/jobs/{id}/recheck measures it |
| `heldout` | `object` |   |
| `heldout.hits` | `integer` |   |
| `heldout.total` | `integer` |   |
| `parent_regression` | `object` |   |
| `parent_regression.ok` | `boolean` |   |
| `parent_regression.hit` | `integer` |   |
| `parent_regression.total` | `integer` |   |
| `locality` | `object` |   |
| `locality.ok` | `boolean` |   |
| `locality.same` | `integer` |   |
| `locality.total` | `integer` |   |
| `reverted_and_reapplied` | `boolean` | the serving model restarted during the check; the lesson was re-loaded and measured again |
| `ok` | `boolean` |   |
| `note` | `string` |   |

## `TeachJob`

A lesson (teach job). Full body only for the owner (signed) or the operator; others get {id, status, position, eta_s}.

| Field | Type | Description |
|---|---|---|
| `id` | `string (uuid)` |   |
| `status` | `"QUEUED"` \| `"PREFLIGHT"` \| `"LOADING"` \| `"TRAINING"` \| `"EXPORTED"` \| `"CHECKING"` \| `"READY"` \| `"NEEDS_MORE"` \| `"FAILED"` \| `"CANCELLED"` \| `"PENDING_REVIEW"` \| `"REJECTED"` \| `"ANNOUNCED"` \| `"EXPIRED"` |   |
| `contributor` | `object` |   |
| `contributor.address` | `string` |   |
| `contributor.name` | `string` |   |
| `context_patch_ids` | `string`[] |   |
| `builds_on_context` | `boolean` |   |
| `facts` | [`TeachFact`](#teachfact)[] |   |
| `name` | `string` |   |
| `position` | `integer` | lessons ahead in the queue |
| `eta_s` | `integer` \| `null` |   |
| `blocked` | `"slot"` \| `"lock"` \| `"runtime"` \| `"container"` \| `null` | why a queued lesson is not moving |
| `dataset` | [`TeachDatasetRef`](#teachdatasetref) |   |
| `training` | `object` | the effort preset and the trainer knobs it resolved to; `lr` is never accepted from the client |
| `training.effort` | `"quick"` \| `"balanced"` \| `"thorough"` |   |
| `training.max_steps` | `integer` |   |
| `training.eval_every` | `integer` |   |
| `training.lr` | `number` |   |
| `training.rows_limit` | `integer` |   |
| `training.row_offset` | `integer` |   |
| `training.check_side_effects` | `boolean` |   |
| `training.use_alt` | `boolean` |   |
| `training.selected_indexes` | `integer`[] |   |
| `progress` | `object` |   |
| `progress.step` | `integer` |   |
| `progress.max_steps` | `integer` |   |
| `progress.loss` | `number` |   |
| `progress.hits` | `integer` |   |
| `progress.total` | `integer` |   |
| `progress.load_s` | `number` |   |
| `progress.avg_step_s` | `number` |   |
| `progress.phase` | `"load"` \| `"train"` \| `"check"` |   |
| `progress.percent` | `integer` | stage-weighted and clamped monotonic, for compact surfaces only — NOT a time estimate, and never to be labelled as one. The real bar is step / max_steps. |
| `progress.rows_total` | `integer` |   |
| `progress.rows_touched` | `integer` |   |
| `progress.elapsed_s` | `integer` |   |
| `progress.eval_sample` | `object` | how many questions the trainer probed at the last evaluation |
| `progress.eval_sample.n` | `integer` |   |
| `progress.eval_sample.of` | `integer` |   |
| `checks` | [`TeachChecks`](#teachchecks) |   |
| `result` | `object` |   |
| `result.sha256` | `string` |   |
| `result.rows` | `integer` |   |
| `result.size_bytes` | `integer` |   |
| `draft_id` | `string` |   |
| `patch_id` | `string` |   |
| `publish_status` | `"none"` \| `"pending_review"` \| `"rejected"` \| `"announced"` \| `"listed"` | `listed` once the verifiers list the announced anchor (checked every 30 s) |
| `reject_reason` | `string` |   |
| `error` | `string` |   |
| `parent_job` | `string` |   |
| `created_at` | `integer` |   |
| `updated_at` | `integer` |   |
| `started_at` | `integer` |   |
| `finished_at` | `integer` |   |
| `expires_at` | `integer` |   |

## `TeachDataset`

A dataset: the durable artifact a lesson is trained from. Both doors (corrections collected in chat, and an uploaded file) produce one of these, and it is what makes "train it again", "add questions" and "download what this lesson learned from" true.

| Field | Type | Description |
|---|---|---|
| `id` | `string (uuid)` |   |
| `owner_address` | `string` | teaching key |
| `name` | `string` | (at most 80 characters) |
| `status` | `"staged"` \| `"ready"` \| `"in_use"` \| `"deleted"` |   |
| `source` | `"chat"` \| `"upload"` \| `"derived"` \| `"sample"` |   |
| `sha256` | `string` | over the canonical rows.jsonl bytes — the same questions hash the same whatever format they arrived in |
| `revision` | `integer` | bumped by every edit; the id stays |
| `rows` | `integer` | accepted questions |
| `invalid_rows` | `integer` |   |
| `size_bytes` | `integer` |   |
| `source_bytes` | `integer` |   |
| `source_name` | `string` |   |
| `format` | `"jsonl"` \| `"json"` \| `"csv"` \| `"tsv"` \| `"txt"` |   |
| `encoding` | `string` | what the parser decided (utf-8, euc-kr, utf-16le, …) |
| `layout` | `"tsv"` \| `"qa"` \| `"blocks"` \| `"prompts"` |   |
| `delimiter` | `string` |   |
| `has_header` | `boolean` |   |
| `columns` | `object` |   |
| `summary` | [`TeachDatasetSummary`](#teachdatasetsummary) |   |
| `parent_dataset` | `string` |   |
| `retention` | `"keep"` \| `"delete_after_training"` |   |
| `job_ids` | `string`[] |   |
| `created_at` | `integer` |   |
| `updated_at` | `integer` |   |
| `expires_at` | `integer` |   |
| `deleted_at` | `integer` | tombstone: the files are gone, the row stays so a lesson can say the dataset was deleted |

## `TeachDatasetSummary`

Counts over the SOURCE rows. Nothing is silently dropped: every rejection has a bucket here and a per-row reason in /rows.

| Field | Type | Description |
|---|---|---|
| `source_rows` | `integer` |   |
| `accepted` | `integer` |   |
| `fixed` | `integer` | accepted after tidying (extra spaces, line breaks in the answer) |
| `rejected` | `integer` |   |
| `duplicates` | `integer` |   |
| `conflicts` | `integer` | same question, different answers — all copies are excluded until one is chosen |
| `blocked` | `integer` |   |
| `too_long` | `integer` |   |
| `empty` | `integer` |   |
| `not_parsed` | `integer` |   |
| `over_cap` | `integer` | accepted questions past this node’s per-dataset cap |
| `shared_ending` | `integer` | advisory only: questions ending in the same words are very likely to be learned as one |
| `langs` | `object` |   |
| `langs.hangul` | `integer` |   |
| `langs.latin` | `integer` |   |
| `langs.han` | `integer` |   |
| `langs.kana` | `integer` |   |
| `langs.other` | `integer` |   |

## `TeachDatasetRow`

One SOURCE row, accepted or not. `line` is the 1-based logical row in the uploaded file (a quoted CSV newline is one row, not two); `index` is the position in the dataset, null when the row was not accepted.

| Field | Type | Description |
|---|---|---|
| `index` | `integer` \| `null` |   |
| `line` | `integer` |   |
| `status` | `"ok"` \| `"fixed"` \| `"duplicate"` \| `"conflict"` \| `"too_long"` \| `"empty"` \| `"blocked"` \| `"not_parsed"` \| `"over_cap"` |   |
| `prompt` | `string` |   |
| `answer` | `string` |   |
| `alt_prompt` | `string` |   |
| `note` | `string` |   |
| `fixes` | `"whitespace_collapsed"` \| `"answer_flattened"` \| `"controls_stripped"` \| `"qa_prefix_stripped"` \| `"note_truncated"`[] |   |
| `advisory` | `"shared_ending"`[] |   |
| `detail` | `string` | why, in one sentence — e.g. "line 41 asks the same question with a different answer" |
| `raw` | `string` | (at most 200 characters) |
| `lang` | `"hangul"` \| `"latin"` \| `"han"` \| `"kana"` \| `"other"` |   |

## `TeachDatasetRef`

What a lesson was trained from. A lesson taught before datasets existed renders `{id: null, source: "derived"}` and still publishes and pays out.

| Field | Type | Description |
|---|---|---|
| `id` | `string` \| `null` |   |
| `sha256` | `string` \| `null` |   |
| `revision` | `integer` |   |
| `rows` | `integer` | questions in the dataset |
| `trained_rows` | `integer` | questions this lesson actually trained |
| `source` | `"chat"` \| `"upload"` \| `"derived"` \| `"sample"` |   |
| `name` | `string` |   |
| `selected_indexes` | `integer`[] | job.facts[i] is dataset.rows[selected_indexes[i]] |
| `sampled` | `object` | live-model check coverage when the dataset was too big to check whole |
| `sampled.checked` | `integer` |   |
| `sampled.of` | `integer` |   |
| `deleted` | `boolean` | the owner deleted the dataset; the lesson itself is unchanged |

## `TeachPolicy`

| Field | Type | Description |
|---|---|---|
| `enabled` | `boolean` |   |
| `publish` | `"review"` \| `"auto"` \| `"never"` |   |
| `trainer` | `"ready"` \| `"busy"` \| `"paused"` |   |
| `paused_reason` | `string` |   |
| `backend` | `"gradient"` \| `"stub"` |   |
| `queue` | `object` |   |
| `queue.depth` | `integer` |   |
| `queue.max` | `integer` |   |
| `queue.position_eta_s` | `integer` \| `null` |   |
| `queue.queued_rows` | `integer` | questions waiting in total — the queue wait is rows-weighted, not position-weighted |
| `queue.queued_rows_max` | `integer` |   |
| `limits` | `object` | every limit the UI shows comes from here; none may be hard-coded in a client |
| `limits.facts_per_job` | `integer` | cap for the legacy inline {facts} body and the chat basket |
| `limits.jobs_per_key_per_day` | `integer` |   |
| `limits.jobs_per_ip_per_day` | `integer` |   |
| `limits.prompt_max` | `integer` |   |
| `limits.answer_max` | `integer` |   |
| `limits.dataset_max_bytes` | `integer` |   |
| `limits.dataset_max_rows` | `integer` |   |
| `limits.dataset_max_source_lines` | `integer` |   |
| `limits.rows_per_job` | `integer` | questions one lesson may train here |
| `limits.rows_per_job_source` | `"default"` \| `"measured"` \| `"operator"` | "default" = the conservative floor, because this node has not timed real training runs yet |
| `limits.rows_per_key_per_day` | `integer` |   |
| `limits.rows_per_ip_per_day` | `integer` |   |
| `limits.datasets_per_key_per_day` | `integer` |   |
| `limits.dataset_ttl_days` | `integer` |   |
| `limits.formats` | `string`[] |   |
| `limits.declaration_rows` | `integer` | above this many questions, publishing needs a rights/PII declaration |
| `timing` | `object` | measured on THIS node with backend "gradient" only; every field is null until 3 such lessons exist, and a stub node reports simulated:true and shows no minutes at all |
| `timing.p50_s` | `number` \| `null` |   |
| `timing.p90_s` | `number` \| `null` |   |
| `timing.samples` | `integer` |   |
| `timing.backend` | `"gradient"` |   |
| `timing.simulated` | `boolean` |   |
| `timing.load_s_p50` | `number` \| `null` |   |
| `timing.s_per_row_p50` | `number` \| `null` |   |
| `timing.s_per_row_p90` | `number` \| `null` |   |
| `effort` | `object`[] | the three presets; they change max_steps and nothing else the visitor can see |
| `effort[].id` | `"quick"` \| `"balanced"` \| `"thorough"` |   |
| `effort[].max_steps` | `integer` |   |
| `effort[].eval_every` | `integer` |   |
| `samples` | `object`[] |   |
| `samples[].kind` | `string` |   |
| `samples[].name` | `string` |   |
| `samples[].rows` | `integer` |   |
| `shares` | `object` |   |
| `shares.contributor` | `number` |   |
| `shares.lineage` | `number` |   |
| `model` | `object` |   |
| `model.id_M` | `string` \| `null` |   |
| `applied` | `string`[] | knowledge the operator keeps loaded for everyone |
| `draft_ttl_days` | `integer` |   |
