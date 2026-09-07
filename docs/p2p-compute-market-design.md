# Peer-to-peer compute and inference market

**Status:** design, final (2026-09-02). Companion of `docs/production-verification-plan.md` (which names this file and defines the production bar this design must meet), built on `docs/lineage-teach-design.md` (f17d027), `docs/teach-mode-design.md` §8 and `docs/teachable-dataset-design.md`. No product code was changed for this document; every `file:line` is the working copy at `052defb` on 2026-09-02 and may drift.

**Owner's directions (verbatim, Korean):**
1. "이거 데모 아니야 모두 prod 레벨 검증으로 전환해" — not a demo; production-level verification everywhere.
2. "gpu 가 낮은것 자체는 문제는 안되지. queue에 쌓아두고 bidding 높은걸 실행해도 되고, 다른 node가 더 접속한다는걸 가정해도 되니까" — low GPU capacity is not a problem: queue the work, run the highest bid first, assume more nodes join.
3. "만약 inference가 중앙에서만 이루어지도록 되어있다면 수정해야 될거야" — if inference only happens centrally, that must be fixed.

**Judging outcome this document is built from.** Three candidate designs (*market-first*, *correctness-first*, *operator-first*) were scored by three judges. Two judges chose *correctness-first* (32, 33) and one chose *operator-first* (31); every judge asked for the same grafts from the other two. This document is correctness-first's trust model (declared state on every job, quorum among independent runtimes, verification never bid) with operator-first's mechanics (per-node runtime ownership with three named coordination scopes, node-side state hashes through `live.read`, a synchronous paid inference door, tabs, floors and hours, earnings derived only from settle records, the migration runbook) and market-first's execution proofs (canaries, two-way commit-reveal, prepaid reservations, `same_gpu` labelling, batched settlement, the chain-budget meter). Every point on which the judges disagreed, and every point on which the three designs disagreed with `docs/production-verification-plan.md`, is resolved in §16.

---

## 0. Verified facts this design stands on

| # | Fact | Where |
|---|------|-------|
| F1 | Every inference, verification and table mutation is a method on the node's own `Runtime` (one vLLM `api`, one file mailbox `patchDir`); nothing is ever routed to a peer. Outbound HTTP from the node is x402 buy and p2p hello/peers/records/blob only. | `packages/node/src/runtime.ts:66-72`; `market.ts:637,658`; `p2p.ts:70-134`; `api.ts:851-891` |
| F2 | Cross-process coordination is a directory: `mkdir <patchDir>/.ainize-runtime.lock` + `holder.json {owner:'pid:<n>', label, since}`; liveness = `process.kill(pid,0)`; lease 15 min; an owner that does not start with `pid:` is assumed alive until the lease expires. Single machine, single pid namespace by construction. | `runtime.ts:113-115, :133-139, :146-165` |
| F3 | The teach trainer lease is a second directory at `<repo>/ple_patch/.ainize-teach.lock` — the :8000 instance's mailbox, not `patchDir` — plus `docker exec … pgrep -f train/` and `nvidia-smi ≥ minFreeGpuMb` on `trainer.gpus`. | `teach.ts:988-1028` (`:994` path, `:1006` pid probe, `:1018-1026` GPU check); `packages/core/src/config.ts:70` |
| F4 | The teach queue is FIFO by `created_at`, one job per process, EXPORTED (check phase) before QUEUED. No bid, deadline, requester or executor field exists on a job. | `teach.ts:957-986` (`:966-969`); `store.ts:83-89, :325` |
| F5 | The live deployment is three node processes (node-a/b/c :3402-3404) on ONE vLLM (:8002, `flashnext-e2e`, GPUs 4+5 TP=2) and ONE mailbox (`/mnt/newdata/qwen3.8/ple_patch_e2e`), serialised by F2. At 11:48 UTC the lock was held by `pid:2516525` label `apply`. node-u (:3422, `~/.ainize-teachable`) points `runtime.api` at the owner's :8000 with :8002's mailbox, backend `stub`, `stubOffline true`, local ledger. GPU 6 is idle (0 MiB); `flashtrain` does not exist; host RAM available ≈ 54 GB. | `~/.ainize-cluster/node-{a,b,c}/config.json`; `~/.ainize-teachable/node-u/config.json`; `scripts/cluster.mjs:31-35, :53-55`; `docker ps -a`; `nvidia-smi`; `free -m`; `holder.json` |
| F6 | `/readyz` requires a runtime for roles `serving` or `verifier`; `serving` appears nowhere else in node code. `NodeRole` = `seller|verifier|serving|gateway`; `gateway` is unused. | `server.ts:126`; `packages/core/src/types.ts:215`; `config-schema.ts:31` |
| F7 | An attestation's signature covers only `[patch_id, patch_sha256, benchmark_hash, passed, score]`; the AIN write rule is `auth.addr === $verifier`; `details[]` and `pre_apply[]` are computed and then dropped (logged locally). Compatibility is `anchor.model.id_M.startsWith(st.model)`; `checkpoint_hash` exists in the type and is never filled or compared. | `verifier.ts:102, :112, :135`; `ain-ledger.ts:315`; `runtime.ts:12-22, :283-291`; `types.ts:42-53`; `market.ts:813` |
| F8 | `deriveCatalog` counts an attestation when it is not the author's and, for anchors with samples, not `hash-only`; `quorum_ok = passed ≥ quorum` (2). Two processes on one GPU count twice. | `packages/core/src/catalog.ts:124-147`; `config.ts:200` |
| F9 | The PLE hook answers pure `read` requests and returns `prev` on every write; `patch.py` discards `prev`, `remove` writes `before` (the disk base), `status` is a 2,000-row sampled majority test. So a node can hash the exact rows a job touches before and after, today, without touching vLLM. | `/mnt/newdata/qwen3.8/vllm_patch/patch_hook.py:61-85`; `engram/live.py:51-58`; `scripts/patch.py:15-19, :29-36` |
| F10 | Money: x402 402→pay→retry (`ain-transfer` = `wallet.transfer` + `verifyTransfer`; `local-credit` = signed intent), `settle` records with `royaltySplit`, idempotent `payouts` rows retried every 60 s. Nothing is escrowed anywhere; the settlements rule allows buyer or seller to write. | `api.ts:822-849`; `market.ts:525-611`; `ain-ledger.ts:253-269, :316`; `catalog.ts:233-301`; `payouts.ts:64-115`; `store.ts:467-478`; `market.ts:428` |
| F11 | `mayDownload` exempts any address whose **self-reported** `PeerInfo.roles` (from `/p2p/hello`) or ledger `node` record includes `verifier`. | `market.ts:511-522` |
| F12 | Blob and record gossip: `x-ainize-auth = address:ts:sig` over `purpose:ts` with 5-min skew; `/p2p/records?since=` set-reconciliation; `broadcast()` best-effort push; AIN nodes never ingest peer records (they re-read the chain every 8 s). | `p2p.ts:21-33, :70-111`; `ain-ledger.ts:204-208, :416` |
| F13 | Measured on this host: 67.1 s trainer load, ≈35 s/step + ≈140 s per 12-probe eval (2 facts); ≈4.25 s per completion on :8002; serving restart 6 min 48 s; trainer static footprint 68.7 GB (3 GPUs ≈ 24 GB each, 2 GPUs ≈ 35.7 GB each, 1 GPU impossible); the trainer's 102 GB `RowTable` cannot coexist with :8002's 101 GB PLE-offload process. No 8-fact gradient lesson has ever completed. | `docs/production-verification-plan.md` §0, §3.1; `docs/lineage-teach-design.md:481-484`; `teach.ts:1481-1485` |
| F14 | AIN app state: `/apps/knowledge` is at 81.5 % of a 9.9 MB staked budget; one teach anchor is 5-12 KB; `node` records slice `blobs` to 40; write rules can only be set by the app admin. | `docs/production-verification-plan.md` §0 (Chain row), P8; `ain-ledger.ts:271-326, :388-392`; `docs/lineage-teach-design.md:28` |
| F15 | Greedy decoding under vLLM continuous batching is only *usually* reproducible; the locality gate already drops "unstable" prompts. | `teach.ts:1493-1503` |
| F16 | `docs/ux-test-scenarios.json` holds AZ-001…AZ-235 (237 rows); the lineage spec reserved AZ-234…AZ-269. New ids here start at **AZ-270**. | file; `docs/lineage-teach-design.md:690-729` |

---

## 1. Goals and non-goals

### Goals

- **G1 No central inference (direction 3).** A node that owns no GPU — catalog-only, verifier-only, a visitor-facing gateway — can live-test, teach-check, verify and train by buying those steps from peers as signed, priced jobs. `serving`/`verifier` no longer imply `cfg.runtime`.
- **G2 One node owns one runtime.** The directory lock (F2) and the trainer lease path (F3) stop being the coordination primitive between nodes; they survive only as an explicit local tier for a host that deliberately runs several node processes on one vLLM.
- **G3 Capacity is a queue (direction 2).** Every job has a bid, a deadline and durable state; each executor orders its lanes by the rate the requester offers per estimated GPU-minute, with aging and an operator floor; a job no executor can run today waits, visibly, instead of failing.
- **G4 Verification at production level (direction 1).** An attestation names the physical runtime it ran on; quorum is counted over *distinct runtimes*; assignment is by sampling, never by auction; hash-only never passes; every result ships an execution receipt a second node can re-execute against.
- **G5 Money through what already works.** Compute settles through the existing x402 + `settle` + `payouts` path (F10), in AIN or the node's own ledger unit; verifiers are paid from the sales commission (patent claim 37); nothing claims an escrow that does not exist.
- **G6 Honest screens.** Visitors see which node answered, on which stack and model, and what it cost; operators see compute earned and bought beside knowledge revenue; every "independent" count is one a stranger could recompute from public records.

### Non-goals (v1)

- On-chain escrow, slashable bonds, or any funds "at risk" claim (ux-critique-2 item 127). Registration stake is *locked*, not forfeitable (§7.5).
- Sovereign device-held rows (patent claims 25-29, 46-50) beyond the compute-rental half of claim 25 that this design implements (a GPU-less node buys inference).
- Cross-model `transfer` (claim 18): the job envelope reserves `kind:'train'` with `derivation:'transfer'`; the trainer contract for it is not written.
- A global reputation score. Reputation is per-node experience plus strikes derivable from public records.
- Preempting a running lock section (`serial()` cannot cancel a running `fn()`, `runtime.ts:101`); bids reorder *waiting* work only.
- Changing vLLM, the PLE hook, or `serve.sh`. The only change outside this repo is `scripts/patch.py hash/check` (already in lineage PR L2).

---

## 2. The mental model, in one paragraph

A **runtime** is one vLLM with the PLE hook and one mailbox; exactly one node process owns it and is its **executor**. Everything the product does on a model — a live test, a teach pre-flight or check, a benchmark run, a training run — is a **job**: a signed, content-addressed envelope naming the exact model (`checkpoint_hash`), the exact table state it must run on (ordered stack + `pre_state_sha256`), its inputs by hash, a bid and a deadline. A node with a runtime runs its own jobs first through the same queue; a node without one posts them to peers. Executors advertise capability, queue depth, prices and hours in gossip; requesters route, executors claim, the requester grants (with download tokens), the executor runs, heartbeats, delivers a manifest plus a signed **execution receipt**, and is paid through x402 on delivery (training: a reservation at grant, the rest on delivery). Verification is the one kind that is not bid: verifiers are *assigned* by a hash of the anchor, paid out of the sales commission when the knowledge sells, and counted once per *runtime*, so three processes on one GPU are one verification. Money and verdicts go on the ledger; jobs, claims, receipts and artefacts stay in gossip and content-addressed blobs.

### Glossary

| term | meaning |
|---|---|
| executor | a node that owns a runtime (`compute` role) and/or a trainer container (`trainer` role) and accepts jobs |
| requester | the node that posts a job; authoritative for its claims and grants (as the seller is for its x402 resource) |
| gateway | a node without a runtime that hosts the visitor UI and catalog and buys inference (`gateway` role, patent claim 43) |
| runtime_id | `sha256(checkpoint_hash ‖ mailbox_nonce ‖ serving_instance)` — the identity of a physical serving instance; **no node address inside** (§7.1) |
| stack | ordered list `[{patch_id, patch_sha256}]` applied to a table; `pre_state_sha256` = hash of the rows it covers before the job |
| receipt | `ExecutionReceipt`: what ran, on what, with which state hashes and answer hashes, signed by the executor |
| lane | an executor's queue for one physical gate: `serving` (infer/check/verify under `serial()`) and `training` (train under the trainer slot) |
| bid / rate | bid = the requester's maximum for the job; offered rate = bid ÷ the executor's ETA; the executor quotes a rate ≤ the offered rate and invoices minutes × quote, capped at the bid |
| tab | an open running total of small `infer` invoices between one requester and one executor, settled as one record |
| strike | a reputation mark derivable from public records (contradicted attestation, expired lease, unpaid delivery); never money |

---

## 3. Topology

### 3.1 Roles and readiness

- `NodeRole` gains `compute` (owns a serving runtime, sells `infer`/`check`/`verify`) and `trainer` (owns a trainer container, sells `train`). `serving` is redefined as "answers `/api/chat` for visitors — locally or by buying"; `verifier` as "signs attestations — from its own runtime or from a rented execution"; `gateway` becomes real: no runtime, routes by `(checkpoint_hash, stack, price, eta)`. The default `['seller','verifier','serving']` (`config.ts:181`) no longer implies a GPU. (`types.ts:215`, `config-schema.ts:31`)
- `/readyz` (`server.ts:126`): `runtime.required` is true only for `compute`/`trainer`; for `serving`/`verifier` without a runtime the check becomes `compute: { local:false, executors: n, cheapest: {infer, verify} }` and is `ok` when `n ≥ 1` executor with a matching `checkpoint_hash` was seen in the last three gossip rounds. A `compute` node whose vLLM is unreachable stays 503 and advertises `runtime: null` so peers never route to it.

### 3.2 One runtime per node; three coordination scopes

| scope | primitive | today | after |
|---|---|---|---|
| GPU (one runtime) | `Runtime.serial()` in-process promise queue, gaining a priority heap (§5.3) | `runtime.ts:94-106` | unchanged role; becomes the *whole* scheduler for that runtime |
| host (several processes on one vLLM) | the directory lease | always on (`runtime.ts:146-165`) | only when `runtime.shared: 'local-lock'` is set; `'none'` (default) ⇒ `lockDir()` returns null. Holder becomes `{owner:'node:<addr>', job, since, heartbeat}`; liveness = heartbeat age < 60 s **or** pid alive — a non-pid owner is no longer trusted for 15 min (F2) |
| host (trainer) | `acquireSlot` mkdir + pgrep + nvidia-smi | `<repo>/ple_patch/.ainize-teach.lock` (F3) | path moves to `<dataDir>/locks/trainer.lock`, same holder shape, `SLOT_STALE_MS` 45 min kept |
| network | signed claim/grant leases with heartbeats and expiry (§4.5) | none | the only cross-host coordination |

`ainize status --check` (and startup) warns when two configs on one host point at one `patchDir` without `local-lock` — the situation of F5 today. A `runtime_id` is derived once at start and re-derived whenever `/v1/models` changes.

### 3.3 What a node advertises — `PeerInfo.capacity`

Added to `PeerInfo` (`types.ts:195-213`, built in `selfInfo` `market.ts:1008-1015`, exchanged on `/p2p/hello`, mirrored to the ledger `node` record like `blobs.slice(0,40)`, `ain-ledger.ts:388-392`), ≈ 400-700 B, signed with the node key:

```
capacity: {
  runtime: {                                 // null when this node owns no serving instance
    runtime_id, model: { id_M, checkpoint_hash, tokenizer_hash }, hook: bool,
    stack: [{ patch_id, patch_sha256 }],     // pinned set in order (sqlite `applied`), today always [] at runtime.ts:302
    lane: { running: label|null, waiting: n, busy_until_s },
    price: { infer_call, infer_1k_tokens, check_job, verify_sample, currency, schemes: ['ain-transfer'|'local-credit'] },
    accepts: ['infer','check','verify'], max_tokens: 1024, unpaid_cap: { calls, amount }
  } | null,
  trainer: {                                 // null when no trainer container is owned
    version, gpus: n, free_mb: [..], container: 'ok'|'paused', mode: 'serving'|'training'|'switching',
    queue: { depth, rows_waiting, eta_s|null }, fit: { load_s_p50, s_per_row_p50, samples },   // teach_stats, ETA_MIN_SAMPLES 3
    price: { per_gpu_min, reserve_min }, rows_per_job_max, accepts: ['train']
  } | null,
  hours: { open: bool, until: ts|null, train_window: 'HH:MM-HH:MM'|null },
  stats: { delivered, expired, disputed_lost, since },   // self-reported; requesters keep their own ledger of experience
  registered: bool,                          // executor record with locked stake exists on chain (§7.5)
  updated_at, sig
}
```

`checkpoint_hash` is computed once at runtime start: sha256 over the safetensors index file plus per-shard sizes of the checkpoint the vLLM container serves (readable under `runtime.repo`), documented as *the* model identity; full-byte hashing of a 100+ GB checkpoint at every start is not practical. It replaces the string-prefix test everywhere (`verifier.ts:102`, `market.ts:813`, `verifier.ts:49`). Anchors announced before the field exists are labelled `model identity: name only` and are verifiable only by `id_M` match.

### 3.4 Discovery and routing

`market.routeJob(kind, need)` filters `knownNodes()` (`market.ts:1017-1025`, ledger records merged with live hello data, fresher signed block wins) by `capacity.*.accepts ∋ kind`, `checkpoint_hash` equality, `hours.open`, `registered` when the job is `verify`, `strikes < 3` in this node's experience, and price ≤ the job's implied rate; ranks by `stack ⊇ need.stack` (avoids re-apply; lineage §7.7 "verify children where the parent is pinned"), then `busy_until_s`/`eta_s`, then price. It posts to the top three directly and to the gossip set. A capability older than three gossip rounds (gossip 4 s default, `config.ts:207`) is treated as gone. A job with no candidate is shown as `no_executor` (§10), never as a silent 503.

### 3.5 How the current single-box cluster maps onto this

| node | today (F5) | after C0-C4 |
|---|---|---|
| node-a :3402 | seller, verifier, serving; runtime :8002 + `ple_patch_e2e`; teach `stub`, publish `auto` | **executor**: roles `seller, verifier, serving, compute`; `runtime.shared:'none'`; sole owner of :8002 and the mailbox; `trainer: null` (no container; `gpu_plan:'serving'`); prices and hours set; teach `gradient`, `enabled:false` until a trainer exists (plan T6) |
| node-b :3403 | verifier; same runtime block | **requester**: roles `verifier, gateway`; `runtime: { kind:'remote' }` (no `api`, no `patchDir`); verifies by buying `verify` jobs from node-a; its attestation carries node-a's `runtime_id` and therefore never adds a second counted runtime |
| node-c :3404 | verifier, serving; same runtime block | **requester**: roles `verifier, serving`; `runtime.kind:'remote'`; visitor live tests on :3404 are `infer` jobs on node-a with the provenance line (§6.3) |
| node-u :3422 | seller, serving; runtime `api :8000` (owner's server!) with :8002's mailbox; stub; local ledger | requester: `runtime.kind:'remote'` → node-a; `stubOffline` removed; AIN ledger; lessons train as `train` jobs that stay `OPEN` until a trainer node exists (plan N1) |
| node-t :3412 | stub | stopped (plan N2) |

Consequences the console must state: every listing on this box reads **"verified on 1 runtime"** and stays `VERIFYING` under production quorum (§7.3) — the honest state; the lock directory under `ple_patch_e2e` disappears once node-b/c/u no longer reference the mailbox (runbook §15.2); nothing on the host references :8000/:8001 except the owner's containers.

### 3.6 How a second GPU machine joins

```
# box B: same checkpoint served with the hook (its own serve.sh, its own mailbox), optionally a trainer container
ainize init --name gpu2 --port 3402 --peer http://boxA:3402 --roles compute,trainer,verifier \
  --runtime-api http://localhost:8002 --patch-dir /data/qwen3.8/ple_patch --repo /data/qwen3.8 \
  --trainer-container flashtrain --trainer-gpus 0,1
ainize compute price set infer_call=0.001 verify_sample=0.0005 check_job=0.02 train_gpu_min=0.01 reserve_min=10
ainize compute hours open
ainize compute register --stake 100        # locks the executor stake on chain (§7.5); optional on a local ledger
ainize start -d
```

Within one hello round box A's nodes see `capacity.runtime` (with a `checkpoint_hash` that must equal box A's — computed, not assumed) and `capacity.trainer`; node-b/c route to whichever executor has the lower `busy_until_s`; gpu2's own verifier loop is *assigned* anchors (§7.2) and attests as a **second runtime** → listings reach 2/2; `train` jobs posted from box A are claimed by gpu2 and paid on delivery. No membership step beyond `hello` and the `node` record (`market.ts:1027-1030`) — patent claim 44. Minimum hardware per the plan: ≥ 2×40 GB GPUs for serving, ≥ 2×40 GB (or 3×40 GB, per the §3.2 experiment in the plan) and ≥ 110 GB free host RAM for training.

---

## 4. Job model

### 4.1 Common envelope — `JobRequest`

Signed, content-addressed (`hashCanonical`, `packages/core/src/canonical.ts:66`, as contributor claims already are), ≤ 3 KB, **never on chain**:

```
{
  v: 1, id: sha256(canonical(body)),
  kind: 'infer' | 'check' | 'verify' | 'train',
  requester: { address, endpoint },
  created_at, expires_at,                     // claim deadline
  run_deadline_s,                             // wall clock once started (default per kind, §4.6)
  model: { id_M, checkpoint_hash, tokenizer_hash? },
  state: { stack: [{ patch_id, patch_sha256 }], pre_state_sha256? },   // what must be on the table before the job
  inputs: { … per kind, everything by sha256 },
  grants_needed: ['blob:<sha>', 'dataset:<sha>', 'lesson:<sha>'],
  bid: { amount, currency: 'AIN'|'CREDIT', scheme: 'ain-transfer'|'local-credit', per: 'job' }
     | fee: { source: 'commission', executor_price_ok: amount },        // verify only (§7)
  privacy: { dataset: 'public'|'derivative'|'private', executor_allow?: [addr], executor_deny?: [addr] },
  result_spec: { … per kind },
  nonce, sig
}
```

`pre_state_sha256 = sha256 over sorted (addr int64 LE ‖ bf16(row))` for the union of addresses the stack covers — the lineage spec's definition (`docs/lineage-teach-design.md:377-381`). The executor measures it with `Runtime.readRows` (a `live.read` mailbox request, F9) before touching the table and refuses with `409 base_mismatch` if it differs.

### 4.2 `infer` — live test, teach pre-flight, operator completion

Inputs: `{ purpose:'live_test'|'preflight'|'probe', calls:[{ id, api:'chat'|'complete', messages|prompt, max_tokens ≤ 1024, thinking, sampling|null }], targets:[{patch_id, patch_sha256}] (applied on top of state.stack, list order, last wins), strip:[patch_id] (pinned patches removed for the base column), mode:'base'|'patched'|'compare', expect?:[{call_id, expect}] }`. Messages are clamped exactly as `api.ts:423` (≤ 24 × 4 KB). Result: per-call `ChatResult` (`runtime.ts:26-40`), `applied_ms`, receipt. The executor runs it as `market.chat` runs today (`market.ts:828-873`: strip in reverse → base → apply in order → patched → restore). Price: `infer_call × generations` (+ `infer_1k_tokens`). Cap: 2 generations per job; preflight = one job per ≤ 24 rows (`preflight.sampleRows`, `config.ts:81`) with 32-token calls.

### 4.3 `check` — teach CHECKING (`teach.ts:1459-1598`)

Inputs: `{ lesson_sha (private draft, token-gated), context:[{patch_id, patch_sha256}], locality:{ prompts_sha, prompts:[12] (per-node config today, config.ts:43-56 — shipped inline so the gate is comparable), min_same: 11 }, taught_sample:{ seed: sha256(dataset_sha256:revision), n }, facts_sha (the sampled facts, not the dataset), heldout_alt: true, budgets:{ callBudget 68, chatFormRows 8, parentSamplesMax 20 } }` (`config.ts:80`). Result: `TeachChecks {executed, taught, heldout, parent_regression, locality{same,total,unstable}, reverted_and_reapplied, ok}` + per-fact answers + receipt; the **requester** applies `TAUGHT_MIN_RATIO` 0.75 (`teach.ts:1091`) from returned data and never trusts the executor's `ok`. The `check` may run on the runtime that trained the lesson (it is a self-test); the counted `verify` executions may not (§7.3).

### 4.4 `verify` — benchmark run (`runtime.ts:374-434`; lineage §7.7 `verifyStack`)

Inputs: `{ anchor_id, patch_sha256, benchmark_hash, samples_mode:'inline'|'sealed', max_samples ≤ 40 (runtime.ts:379 cap), parent_stack: state.stack, restore: true, min_pass: 0.95, parent_min_pass: 0.90, independence:{ not_author, not_seller, not_trainer_runtime } }`. Result: `details[]` and `pre_apply[]` (kept, not dropped as at `verifier.ts:112`), `restarts_detected`, `collateral_nat` (plan V3), receipt. Sealed mode is the two-way commit-reveal of §8.4. Not bid: the verifier pays the executor's `verify_sample` price; the verifier's income is the commission share (§9.4).

### 4.5 `train` — extend / merge T1,T2 / rebuild (`teach.ts:1213-1241`; lineage §7.1 job.json v2)

Inputs: `{ dataset:{ sha256, rows, revision, source, merkle_root, access }, parents:[{ patch_id, patch_sha256, rows }], known_file_sha?, replaces?, export:'delta'|'squash', mask?, contrast_sha (≤ 8 parent samples), training: TeachTrainingSpec { effort, max_steps, eval_every, lr, selected_indexes } (types.ts:570-581), eval_sample:{ n, seed }, trainer_min_version: 2, check:{ mode:'executor'|'requester'|'separate' } }`. The `contributor` field the node writes into job.json today (`teach.ts:1234`) is **replaced by the job id** — the visitor's key never leaves the requester. Result artefacts: `lesson.npz {addrs, before, after, meta}`, `recipe.json` (gains `job_request_hash`, `executor`, `trainer_run {container, gpus, image_digest}` per plan T4), `events.jsonl` (the trainer's JSON-lines, `teach.ts:1255-1298`), receipt with `base_table_sha256` (hash of the rows the trainer loaded over `addrs`, so `before` can be checked against the requester's `pre_state_sha256` for the same addresses).

### 4.6 Lifecycle, leases, deadlines

Requester (`jobs_out` table): `OPEN → CLAIMED(grant) → RUNNING(first heartbeat) → DELIVERED(manifest + hashes ok) → ACCEPTED | DISPUTED | FAILED | EXPIRED | CANCELLED`. Executor (`teach_jobs` gains `origin:'remote', kind, requester, job_request_hash, bid, currency, deadline_at, lease_until, receipt_sha, paid_tx`): the existing `TeachStatus` machine (`teach.ts:4-9`) plus `LEASED`, `DELIVERING`; remote jobs pass the same `queueGate` (`teach.ts:644-654`).

Handshake: executor → `POST <requester>/p2p/jobs/:id/claim { executor, runtime_id|trainer_id, eta_s (includes fetch time: Σ blob bytes ÷ measured p2p throughput — the rowsPerJob fit does not model fetch), rate_quote, lease_s, capacity snapshot, holds:[sha], sig }`; requester → `200 Grant { job_id, executor, lease_until, tokens:{ sha: download_token }, result_endpoint, price_agreed, sig }` or `409 already_claimed | eta_exceeds_deadline | not_independent | privacy_refused | price_above_bid`. Claim window: 3 s for `infer` when asynchronous (the synchronous door of §6.1 needs none), 30 s otherwise. Heartbeat every 30 s (train) or per chunk; three missed ⇒ lease void ⇒ job re-opened with `reoffer+1`; after three re-offers the job `EXPIRED`s and the UI says why. Grants are single-use, carry one token per sha (`store.putToken`, `store.ts:261-265`; `mayDownload` token branch, `market.ts:512`) and are the **only** way a non-registered executor obtains a parent blob or dataset (`contextTargets` refuses otherwise, `teach.ts:555-565`).

Defaults: claim deadline infer 60 s · check 30 min · verify 2 h · train 24 h; `run_deadline_s` infer 2×300 s · check `lockAbortMs` 480 s · verify apply + ≤ 48 completions + remove ≈ 5 min · train from the executor's fit × 1.5, floor 90 min (plan T8), never the flat 30 min of `trainer.timeoutMs`.

### 4.7 Artefact addressing

Every output is a blob `{name, sha256, size_bytes}` listed in the result manifest and fetched via `/p2p/blob/:sha` with the manifest's download token; the requester refuses any byte stream whose sha256 differs (the `buy()` check, `market.ts:671-680`) and imports lessons through `createLessonDraft` (`teach.ts:1601-1630`). Executor retention: 7 days or `ACCEPTED` + 24 h. Executors must not list granted-but-unpaid parent shas in `PeerInfo.blobs` (a `granted` flag on `blobs.list()`).

---
## 5. Bidding and scheduling

### 5.1 Bid semantics

- The requester states `bid.amount` — the most it will pay for the job. The executor turns it into an **offered rate** `r_offer = bid / eta_min` using its own measured fit (`teach.ts:809-822`, `config.ts:142-168` for train; `calls × 4.25 s + apply/remove` for infer/check/verify, F13).
- The executor advertises floors (`price.per_gpu_min`, `infer_call`, …). A claim carries `rate_quote ∈ [floor, r_offer]`; the requester accepts the lowest quote within its deadline. The **invoice** is `min(bid, gpu_minutes × rate_quote)` for `train`, and the per-unit price for the other kinds — so a job that finishes early costs less, a job that overruns is capped, and the executor is paid for what it did (the plan's "actual executor-minutes × rate, capped at the bid", §3.3), not for what was hoped.
- Bids below every visible floor are shown as `below_floor` before posting (`ainize jobs quote`, §11.2); the executor's own operator jobs may carry `bid 0` and queue behind paying work, but the operator's *visitor* jobs get a floor priority (§5.2 d).

### 5.2 Queue order (replaces the FIFO pick at `teach.ts:968-969`, `store.ts:325`)

`priority = r_offer × (1 + waited_s / half_life_s)` with `half_life_s` = 1800 for the training lane and 60 for the serving lane; ties by `created_at`. Guards, all with hooks that exist today:

- (a) **aging slot**: every fourth dispatch goes to the oldest waiting job regardless of rate;
- (b) **per-requester cap**: `ACTIVE_JOBS_PER_KEY` = 2 in flight (`teach.ts:145`), keyed by requester address for remote jobs, plus ≤ 50 % of `queuedRowsMax` (`config.ts:82`) per requester;
- (c) **deadline admission**: a claim whose `eta_s > expires_at − now` is refused (`409 eta_exceeds_deadline`) so a job never waits behind work it cannot finish — requesters route elsewhere instead of waiting;
- (d) **local floor**: this node's own visitor lessons and live tests carry a synthetic `r_offer = compute.local_floor_multiplier × floor` (default 2) so remote money must beat the operator's own users to jump ahead of them;
- (e) **EXPORTED first** (`teach.ts:966-967`) stays: a paid training is never left unchecked behind new bids;
- (f) **admission caps** stay: `queueMax` 10, `queuedRowsMax` 2000 (`config.ts:65,82`), `rows_per_job_max`; a refused claim answers `409 queue_full { retry_after_s }` and the executor's advertised `queue.depth` keeps requesters from spamming.

### 5.3 Two lanes, one physical gate each

| lane | kinds | gate | work-unit cap (nothing inside `serial()` is cancellable, `runtime.ts:101`) |
|---|---|---|---|
| serving | infer, check, verify | `Runtime.serial()` (`runtime.ts:94-106`) — its promise chain becomes a priority heap keyed by §5.2; `exclusiveTry`'s 2-min wait (`runtime.ts:178-187`) becomes the "bid too low to jump" signal; `lockAbortMs` 480 s (`config.ts:80`) is enforced per job by an `AbortController` on the model fetch (this frees the lock, not the vLLM request — advertised `busy_until_s` is the remedy for a slow request) | infer ≤ 2 generations · check ≤ `callBudget` 68 · verify ≤ 40 samples in chunks of 8 with `isApplied` between chunks (`runtime.ts:400-421`) |
| training | train | `acquireSlot` unchanged in role (`teach.ts:988-1028`), lease path moved (§3.2), reads the top of the heap instead of the first QUEUED row; `tick()` calls `refreshCapability()` after every state change so advertised depth/ETA are never more than one tick stale | one lesson (no preemption; cancellation between micro-batches via the trainer's SIGTERM handler) |

### 5.4 Serving and training on one GPU set (this box)

The plan's §3.1 measurements make GPUs 4,5,6 **one 2-GPU slot plus a spare in exactly one mode at a time** (serving TP=2 on 4+5; the trainer needs 4+5 or 4+5+6 and 110 GB of host RAM that :8002's offload process holds). The executor therefore runs a `mode` state machine with an operator switch `compute.gpu_plan: 'serving' | 'training' | 'timeshare'`:

- `serving` (default here, because other jobs depend on :8002): `trainer: null` is advertised; `train` jobs from this box's own doors are posted to the network and stay `OPEN` until a trainer node claims them (§10 `no_executor` copy).
- `training`: the reverse; the serving lane is closed and `capacity.runtime` is `null`.
- `timeshare`: the plan's §3.3 rule verbatim — switch to TRAINING when the training lane's pressure `Σ bid + bid × age / maxWaitMin` exceeds the switch cost (≈ 7-9 min of serving unavailability at the executor's rate, measured by the plan's §3.2 experiment) **or** the oldest `train` job is older than `maxWaitMin` (120), **and** no `verify` job has an assignment deadline inside the switch window; then `docker stop <serving>` → RAM guard `MemAvailable ≥ 110 GB` → trainer up → all queued `train` jobs highest-rate-first until the lane is empty or `maxTrainingMin` (120) → trainer down → `docker start <serving>` → health check (`/v1/models`, `Application startup complete`, `runtime.hook true`) → re-assert the whole ordered stack (lineage §8.5) → re-measure `pre_state_sha256` → reopen. During the window `capacity.runtime = null` is advertised for ≥ 2 gossip rounds *before* the stop so gateways re-route, `/api/teach/policy` reports `trainer:'busy'`, and the 15-min runtime grace in `teach.ts`/`verifier.ts` is suspended so nothing is saved as "READY, unchecked" and no hash-only record is written. Each exported lesson enqueues its `check` job into the serving lane at the requester's bid.

Config refuses `trainer.gpus` overlapping the serving GPUs unless `gpu_plan` is `timeshare` (ux-critique-2 item 145). The GPU set is one value passed to `docker run --gpus` and `teach.py --devices` (plan T7).

### 5.5 Requester-side behaviour under load

A requester posts to at most three candidates; the first acceptable claim is granted, the rest get `409 already_claimed`. If every candidate answers `queue_full`/`hours_closed`/`below_floor`, the job stays `OPEN` in gossip with `retry_after` and the console offers *Raise bid* with the position it would buy. Visitor lessons default to `bid = local floor × est_cost` of the cheapest visible executor, funded by `compute.delegate.budget_per_day`; when the budget is exhausted the visitor sees the existing quota copy ("run your own node", teachable §9).

### 5.6 Cancellation and re-offer

`POST /p2p/jobs/:id/cancel` (signed by the requester) → the executor kills the container pid (`teach.ts:1342-1354`) or aborts the fetch and marks `CANCELLED`. A `train` cancelled after > 50 % of its ETA still owes the reservation (§9.3) — enforced socially through `requester_strikes` since there is no escrow. An expired lease re-offers automatically at the same bid; after three expiries the requester is asked to raise the bid or lower rows.

---

## 6. Inference delegation — what a GPU-less node does, and what visitors see

### 6.1 Where the visitor path forks

`Market.chat` (`market.ts:775-898`) today throws 503 without a runtime (`:807-808`) and 409 when a blob is not local (`:812`). New order:

1. local runtime available and compatible → today's path, now through the serving-lane heap;
2. else if `compute.delegate.allow` → build an `infer` job (§4.2) from the same resolved entries and clamped messages and call the **synchronous door** `POST <executor>/x402/jobs/infer` with `x-ainize-auth` (purpose `job:<id>`): the executor runs the transaction under its lock and answers inline with the result + receipt (402-gated when the requester's tab is over its cap, §9.2). No claim window: a delegated live test starts generating as soon as the executor's lane reaches it. Candidate order is §3.4; on `409 pinned_conflict` (the requested `strip` would remove a patch pinned for a paying subscriber) or a bad receipt the requester tries the next candidate;
3. else `503 no_executor { tried:[…], reason:'no_peer'|'price_above_max'|'queue_full'|'hours_closed' }`.

The D3 ticket (`chat-queue.ts:45-58`) is opened before step 2 so `GET /api/chat/status` still answers "queued"; its `position` becomes the executor's `lane.waiting` at claim time and `running` flips on the executor's `started` header. Teach interactive preflight (`teach.ts:525-547`) and the worker's PREFLIGHT (`teach.ts:1122-1150`) fork the same way (`withStack()` at `teach.ts:571-587` gains a remote branch); worker CHECKING posts a `check` job (§4.3) and imports the result through the `recheck()` path (`teach.ts:1633-1647`); `check()`'s runtime-down branch (15 min then READY-unchecked, `teach.ts:1463-1468`) fires only when no executor accepts `check`.

### 6.2 Blob availability for the executor

A visitor's live test on a gateway can only use patches the executor holds (advertised `PeerInfo.blobs`) or that the gateway may grant (author or settled buyer, `mayDownload`, `market.ts:511-522`). `testablePatches` (`market.ts:903`) is computed over the union of local and routable executors and each entry carries `runs_on: <executor name>`; otherwise the existing 409 stands with the seller's endpoint in the body.

### 6.3 Binding the answer to the stack it ran on (patent claim 38)

The requester verifies the receipt (§8.1) before showing anything: `request_sha` equals what it sent, `stack_ran` equals what it asked for, `model.checkpoint_hash` equals the anchor's, `post_state_sha256` equals the hash it can compute locally from the `after` rows of the npz files it holds (or from the anchor's `meta` when it holds no body — lineage §5.4 adds `pre_state_sha256`; this design adds `post_state_sha256` to the anchor), `sig` verifies against the executor address (`verifyMessage`, `p2p.ts:31-35`). Failure ⇒ the answer is discarded, the executor gets a strike, the next candidate is tried, and the visitor is told. `benchmark_hits` (`market.ts:890-896`) and the `usage` event per patch (`market.ts:884`) are computed by the **gateway** from the returned text, with `executed_by` and `cost` added — metering stays with the party the visitor trusted, per-hit billing (`types.ts:25`) counts on the gateway, and the compute node is paid per call, not per hit (L6 signal scope, §13).

### 6.4 What the visitor sees (`ChatPage`, `i18n/pages/chat.ts`)

| state | EN | KO |
|---|---|---|
| provenance line under every answer | `Answered by {node} · {model} · stack {n} patches · {latency} s · {cost}` | `{node} 노드가 답함 · {model} · 패치 {n}개 스택 · {latency}초 · {cost}` |
| cost values | `free (node budget)` / `{amount} AIN paid by this node` / `local answer` | `무료 (노드 예산)` / `이 노드가 {amount} AIN 지불` / `이 노드에서 직접 답함` |
| badge, receipt ok | `stack verified ✓` | `스택 검증됨 ✓` |
| badge, receipt failed / single execution | `unverified` (tooltip: `The answering node's receipt did not match the patches you selected.` / `Only one node ran this; no second execution checked it.`) | `미검증` (툴팁: `답변 노드의 영수증이 선택한 패치와 일치하지 않습니다.` / `한 노드만 실행했고 다른 노드의 확인은 없었습니다.`) |
| waiting | `No model on this node — sending to {node} (position {p}, ~{eta} s)` | `이 노드에는 모델이 없어 {node} 노드로 보냅니다 (대기 {p}번째, 약 {eta}초)` |
| local GPU busy, rerouted | `This node's GPU is busy (queue {n}) — routed to {node}` | `이 노드의 GPU가 바쁩니다(대기 {n}) — {node} 노드로 전달했습니다` |
| no executor | `No node can run this test right now ({n} known, none open or compatible). Try again in a minute or test on the seller node.` | `지금 이 테스트를 실행할 노드가 없습니다 (알려진 노드 {n}개, 열려 있거나 호환되는 노드 없음). 잠시 후 다시 시도하거나 판매자 노드에서 테스트하세요.` |
| executor timed out | `The answering node timed out; nothing was charged. Retrying on {next}…` | `답하던 노드가 시간 초과했습니다. 비용은 청구되지 않았습니다. {next} 노드에서 다시 시도합니다…` |
| budget exhausted | `Live tests are paused on this node until {time} (compute budget).` | `이 노드의 실시간 테스트는 {time}까지 일시 중지됩니다 (연산 예산).` |
| node cannot pay | `This node could not pay for the test (balance {bal}). Ask the operator to top up.` | `이 노드가 테스트 비용을 낼 수 없습니다 (잔액 {bal}). 운영자에게 충전을 요청하세요.` |

Clicking the provenance line opens the receipt: executor address, `runtime_id` (short), model + checkpoint hash, stack, pre/post state hashes, answer hash, signature check.

### 6.5 Who pays

Default `compute.delegate.pay:'node'`: the gateway's wallet pays per call inside `budget_per_day`, the visitor keeps the 20/h IP quota (`api.ts:423`). `pay:'visitor'` (later; the compute-rental half of claim 25) returns the executor's 402 requirements plus the gateway's margin to the browser/agent — the agent loop already handles 402 (`agent.ts:192-248`). The console shows *Compute bought for visitors today: 0.31 / 1.0 AIN*.

### 6.6 Spot-checks, canaries, reproducibility

- `compute.spot_check_rate` (default 0.05): the same `infer` job is re-run on a second executor; disagreement on `hit` (startsWith / includes, never bytes — F15) twice in a row for one executor is a strike; disagreement on `pre_state_sha256`, stack or model is a dispute. Spend is shown as *assurance spend*.
- `compute.canary_rate` (default 0.1): a call with a known answer is inserted into an `infer` job. Because anchor samples are public, canaries are drawn first from the requester's **private held-out alt prompts** (teach lessons have them) and only then from the anchor's own samples; a canary miss is a strike.
- Operator completion (`POST /api/runtime/complete`, `api.ts:354-367`) runs only on a node with a local runtime and, new, under `serial('operator')` — today it is unlocked and reads transient table state during a live test or CHECKING.

---

## 7. Verification distribution and quorum

### 7.1 Executor identity — `runtime_id`

```
mailbox_nonce    = contents of <patchDir>/.ainize-instance (random, written once by the executor; any process sharing the mailbox reads the same value)
serving_instance = sha256(vLLM container id ‖ container StartedAt) from `docker inspect` by the owning node
                   (fallback: the `created` field of /v1/models[0]); re-derived on every /v1/models change
runtime_id       = sha256(checkpoint_hash ‖ sha256(mailbox_nonce) ‖ serving_instance)
```

The node address is **not** part of it: node-a/b/c sharing :8002 today would (rightly) produce one `runtime_id`; a node that re-keys itself gets no new vote. This is the plan's *executor fingerprint* `{instance_id, checkpoint_sha256, tokenizer_sha256, mailbox_id, operator}` with `instance_id = serving_instance`, `mailbox_id = sha256(mailbox_nonce)`, `operator` = the node address that signs the receipt and holds the registration (§7.5). Honesty clause: an operator with real hardware can hold several `runtime_id`s; without hardware attestation, quorum over distinct runtimes is a **floor** against accidental double-counting (today's cluster), and the locked registration stake is the only cost of an extra identity. The console never calls a listing "independent" beyond what this rule proves.

### 7.2 Assignment by sampling (patent claim 37, [0071]; replaces all-verify-all at `verifier.ts:39-63`)

For anchor `A`: eligible set `E(A)` = registered verifier-role nodes whose runtime (own or rentable, §7.4) has `checkpoint_hash == A.model.checkpoint_hash`, `accepts ∋ verify`, `strikes < 3`, address ∉ {author, contributors, seller}, `runtime_id ∉ {trainer runtime of A's train job (recipe.executor)}`, one per `runtime_id`, and present in gossip for ≥ `verifier.warmupMs` (1 h). Seed `s = sha256(A.id ‖ A.patch_sha256 ‖ record_hash(A))` — the ledger record hash exists on both ledger kinds (a local ledger has no block height). Rank `E(A)` by `sha256(s ‖ addr)`; the first `k = quorum + 1` are **assigned** and must attest within `verifier.assignWindowMs` (2 h); each timeout draws the next in rank. Unassigned verifiers may attest after the window closes; their attestations count but never earn the fee (they cannot front-run the sample). A challenge re-draws with the seed extended by the challenge record hash, excluding every previous attester and the challenger. Every node computes the same `E(A)` and ranking from public data — no coordinator.

### 7.3 Counting rule (`catalog.ts:124-147` amended)

`executed` = attestations that (i) are `AttestationV2` with a receipt whose inner signature verifies against `verifier` and whose record author equals `verifier` (plan V2), (ii) `passed`, (iii) are not `hash-only` (hash-only is deleted as an outcome for anchors with samples — after the grace period the verifier writes nothing, plan V4), (iv) carry `model.checkpoint_hash == A.model.checkpoint_hash` and `stack_ran == A.base.stack`, (v) have `receipt.runtime_id ∉ {author's, seller's, trainer's runtime}`, and (vi) have a `runtime_id` distinct from every other counted attestation of `A` — the **earliest** attestation per `runtime_id` counts, later ones are recorded as `duplicate_runtime`. `quorum_ok = executed.size ≥ quorum` (2); `REJECTED` when distinct-runtime FAILs ≥ quorum; an executed FAIL against an executed PASS ⇒ `DISPUTED`, re-verified by a freshly drawn runtime (plan V7). Attestations produced under the legacy `runtime.shared:'local-lock'` mode carry `independence:'same_gpu'` and are discounted the same way. `collateral_nat` above the anchor's bound fails the attestation (plan V3).

### 7.4 GPU-less verifiers rent the execution

A `verifier` node without a runtime posts a `verify` job (§4.4) to an executor from `E(A)`'s runtime set, pays `verify_sample × n` on delivery, validates the receipt, and signs `AttestationV2` itself with `executor` = the executing node and `runtime_id` from the receipt. Counting is by `runtime_id`, so renting cannot inflate quorum: node-b renting node-a's runtime after node-a attested adds a `duplicate_runtime` record and earns nothing — the verification page says so *before* the verifier spends (§11.4 "this runtime already attested"). `verifyOne` (`verifier.ts:76-139`) gains this branch between "runtime error" and the (now deleted) hash-only fallback; the 15-min `RUNTIME_GRACE_MS` becomes the job deadline.

### 7.5 What a verifier earns and risks

- **Earns**: the verifier pool at every sale of the anchor — §9.4 — split equally among the *counted* attestations at settle time; nothing for price-0 anchors (there is no commission) except reputation; runtime-owning verifiers keep verifying price-0 anchors for free as today, and an announcer may attach an optional `verify_bounty` paid on LISTED through the same payouts path (later PR).
- **Registration stake** (plan V9): an executor/verifier record `/apps/knowledge/market/executors/$addr` (rule `auth.addr === $addr`, one `setMarketRules` addition by the app admin) is valid only while the address holds ≥ `verifier.minStake` of **app stake** on the knowledge app (`/staking/knowledge/<addr>/…`, the path `stakeApp` already writes, `ain-ledger.ts:278-282`). Unstaking has the chain's lockup; nothing can forfeit it. Copy: *stake locked, not slashable*. On a `local` ledger `registered` is a signed self-record with no stake and the console says so.
- **Strikes** (the only sanction without escrow): a counted attestation contradicted by a challenge quorum, an expired lease, an unpaid delivery, a lost dispute. Strikes are *derived* from public records by every catalog (challenge outcomes, job events gossiped as signed objects) and cached in the offender's own `node` record when it refreshes; three strikes ⇒ out of `E(A)` and of grants for 30 days; pending verifier-fee payouts for the contradicted anchor are voided (`payouts` status `void`). Copy (EN/KO): `Verifiers earn a share of each sale. A contradicted attestation forfeits that share and suspends the verifier for 30 days. Registration stake is locked, never forfeited; no deposit is at risk.` / `검증자는 판매마다 수수료를 나눠 받습니다. 반박된 증명은 그 몫을 잃고 검증자는 30일간 정지됩니다. 등록 스테이크는 잠길 뿐 몰수되지 않으며, 위험에 놓인 예치금은 없습니다.`

### 7.6 Challenges (`market.ts:427-434`)

A challenge is written only by a registered address (§7.5) and names either the attestation or the receipt; the challenger pays the fresh `verify` jobs the re-draw needs (§7.2). Resolution is the majority of the fresh distinct-runtime executions; the losing side takes strikes and the challenger's future challenges on that anchor are ignored for 30 days if it lost. The window after LISTED and the `sellable` block (`catalog.ts:147-160`) are unchanged.

### 7.7 Minimum pool and the announce warning (ux-critique-2 item 147)

Announce succeeds with fewer than `quorum + 1` eligible runtimes but the publish sheet and the response warn: EN `Only {n} independent runtime(s) can run this model right now; listing needs {quorum}.` / KO `지금 이 모델을 실행할 수 있는 독립 런타임은 {n}개뿐입니다. 등록에는 {quorum}개가 필요합니다.` On this box `n = 1`.

---

## 8. Proofs, disputes, refunds

### 8.1 `ExecutionReceipt` (all kinds; signed with the node key, `signMessage` as `verifier.ts:135`)

```
{ v:1, job_id, kind, executor (address), runtime_id | trainer_id,
  model: { id_M, checkpoint_hash, tokenizer_hash, served_as: 'vllm:<id>' },
  stack_before: [{patch_id, patch_sha256}], table_plan_applied: [{op, patch_id, patch_sha256}], stack_ran: [...],
  pre_state_sha256, post_state_sha256,        // union of addrs the job touches, via Runtime.readRows (live.read)
  request_sha,                                // hash of the JobRequest as received
  artefacts: [{ name, sha256, size_bytes }],
  answers_sha256,                             // canonical sorted [{call_id|sample_idx, output, finish_reason, usage}]
  samples_sha?, pre_apply_sha?, events_sha?, base_table_sha256?,   // verify / verify / train / train
  timing: { t_start, t_end, gpu_s, lock_held_ms }, restarts_detected, sig }
```

The full answers/details live as a blob at `/p2p/jobs/:id/receipt` (served by the executor *and* the requester, readable by anyone — a catalog deriver that is neither buyer nor verifier must be able to fetch it, which today's `mayDownload` would refuse); only `receipt_sha` reaches the ledger inside `AttestationV2` or a `settle` memo.

### 8.2 What state hashes prove, and what they do not

`pre_state_sha256` proves the executor *declared* the base the job asked for; `post_state_sha256` proves it *declared* the state after the plan. Neither proves execution: an executor holding the npz can compute both from `after` rows and one cached base read without writing anything. Execution is proven by **(a)** independent re-execution — quorum for `verify`, spot-checks for `infer`, a separate `check` on another runtime for `train`; **(b)** canaries with answers the executor does not hold (§6.6); **(c)** timing floors — `gpu_s < calls × 0.2 s` (infer) or `< 0.5 × est_cost_s` (train) flags the receipt for a spot-check before payment; **(d)** for `train`, a zero-norm `after − before`, `addrs` that do not match the n-gram address function of the facts (recomputable from `ModelIdentity.hash_const`), or `recipe.dataset/parents ≠ inputs` is rejected unpaid; `taught == 0 && heldout == 0` on the independent check is disputed as lazy, while an honest `NEEDS_MORE` (`taught < 0.75`) is paid — the dataset was insufficient, the work was done. The visitor badge `unverified` (§6.4) is the UI form of this paragraph.

### 8.3 `AttestationV2` (`types.ts:140-161` extended; AIN path unchanged)

Body adds `receipt_sha, executor, runtime_id, model:{id_M, checkpoint_hash}, stack_ran, pre_state_sha256, samples_sha, pre_apply_sha, collateral_nat, assigned: bool, independence: 'runtime'|'same_gpu'`; the signature covers `[patch_id, patch_sha256, benchmark_hash, passed, score, receipt_sha, runtime_id, checkpoint_hash, stack_sha256]` (today five fields, F7). `details[]` becomes the blob `attest/<receipt_sha>.json`. Size on chain ≈ +300 B per attestation (hashes only). `verified_on` becomes `vllm:<id_M>@<checkpoint_hash[:12]>`.

### 8.4 Sealed samples — two-way commit-reveal (`anchor.answers_hash`, `types.ts:37-39`, unused today)

For `verify` jobs in `sealed` mode the executor posts `answers_sha256` first; the requester then reveals the expected answers (whose hash must equal the anchor's `answers_hash`); both compute `passed`; a mismatch between the two computations is a dispute. The executor cannot tailor outputs to expected answers; the announcer cannot change the benchmark after seeing outputs.

### 8.5 Disputes

`POST /p2p/jobs/:id/dispute { reason: 'stack_mismatch'|'model_mismatch'|'answers_disagree'|'timeout'|'bad_artifact'|'lazy', evidence_sha }` within 24 h of `DELIVERED` (train/check) or 1 h (infer). Resolution = a fresh execution on a third runtime drawn by §7.2's sampling over the job's seed; the loser takes a strike, the winner's costs are covered by the loser's voided/clawed-back payouts where they exist (best effort, labelled). Disputes and outcomes are signed gossip objects (`JobEvent`), never per-dispute chain records.

### 8.6 Refunds — honestly

Payment follows delivery, so most failures cost nothing: `EXPIRED`/`FAILED` before delivery → nothing paid, the executor accrues `expired_leases`. A prepaid **reservation** (train, §9.3) is refunded as a normal `payouts` row when the executor never starts the job (visible as *refund pending/paid/failed* on both consoles). A delivered-but-disputed job cannot be refunded without escrow; the remedy is clawback against that executor's future earnings from this requester (a negative `payouts` row), strikes, and the mutual blacklist. The console says: EN `Payments are made after delivery. There is no escrow on this network yet; a bad result costs the executor future work, not a deposit.` / KO `지불은 결과를 받은 뒤에 이루어집니다. 이 네트워크에는 아직 에스크로가 없습니다. 잘못된 결과는 실행 노드의 앞으로의 일감을 잃게 할 뿐 예치금을 잃게 하지는 않습니다.`

---
## 9. Payments through the existing settle / payout machinery

### 9.1 Rails and the no-escrow rule

Identical to knowledge sales (F10): `ain-transfer` (`wallet.transfer` + `verifyTransfer`, with the plan's P4 hardening — transfer key bound to `(resource, nonce)`, nonce consumed, finality required) or `local-credit` (signed intent, `market.ts:562-572`). There is no escrow primitive on the AIN path used here, so the design is **pay-on-delivery with a bounded reservation**, never "bid escrow". `local-credit` balances are per-ledger views derived from settle records (`market.ts:538-547`), so cross-node `local-credit` is legal only between nodes that read the same local ledger; the job poster refuses `local-credit` to a peer whose `PeerInfo.ledger` differs.

### 9.2 `infer` / `check` / `verify` — pay on delivery, batched as tabs (patent claim 54)

The synchronous door `POST /x402/jobs/infer` delivers the result **and** adds the price to the requester's open **tab** on that executor: `tabs { requester, executor, calls, amount, opened_at, receipts:[sha] }`. A tab closes when it reaches `unpaid_cap` (default 50 calls or 0.05 AIN) or `max_age` (1 h); the executor then answers the next call with 402 for the tab total (`requirementsFor`-shaped, `payTo: executor`, `resource: 'job:tab:<id>'`, nonce 10 min, `store.ts:79-80`); the requester pays exactly as `buy()` does (`market.ts:627-691`) and the tab settles as **one** `settle` record listing the receipt hashes; the executor's exposure is one tab. Requesters with `strikes ≥ 2` or no history get `unpaid_cap = 0` (402 before every call — the escrow-free way to move exposure to the requester, "prepay" in the judges' terms). `check` and `verify` jobs are single-invoice: `GET /x402/jobs/:id/result` is 402-gated (`resource:'job:<id>'`), the manifest with download tokens is released on payment.

### 9.3 `train` — reservation at grant, remainder on delivery

The executor's claim states `reserve_min` (its irrecoverable cost: switch + load, default 10 min); the grant is completed only after the requester pays `reserve = reserve_min × rate_quote` through `GET /x402/jobs/:id/reserve` (402, transfer bound to the job id) — this is the plan's "402 → transfer bound to the job id → job accepted", limited to the reservation. On delivery the invoice is `min(bid, gpu_min × rate_quote)`; the requester pays `invoice − reserve` through `/x402/jobs/:id/result` and receives the manifest. Executor never started ⇒ reservation refunded by a `payouts` row (§8.6). Requester cancels after 50 % of ETA ⇒ reservation kept. No "accepted bonus" leg: the independent `check` is a separate job the requester buys (§4.3), and a bad artefact is a dispute (§8.5); the judges' 60/40 split is replaced by *cost-plus capped at bid* because the plan already fixes charging at actual minutes × rate and a third payment leg would be voluntary and therefore unenforceable.

### 9.4 Verifier share inside `royaltySplit` (`catalog.ts:233-301`)

New `market.verifierShare` (default 0.05): `verifier_pool = min(amount × verifierShare, seller_line)` carved from the **seller's own final line** after pass 1 (ancestors) and pass 2 (contributors) — patent claim 37 "paid from the sales commission" — and split equally among the addresses of the *counted* attestations (§7.3) at settle time, written into `Settlement.royalty` (`types.ts:163-175`) so `creditBalance` and `Payouts.enqueue` (`payouts.ts:64`) pay it with no new machinery. Σ ≤ price is preserved (`market.ts:586-593`). Contributors and ancestors are untouched. This revises teachable-dataset §1.1 and lineage §11 explicitly (§13).

### 9.5 Ledger records

- `settle` reused with `patch_id: 'job:<id>'` or `'job:tab:<id>'`, `seller: executor`, `buyer: requester`, `billing: 'compute'` (new `BillingModel` value, `types.ts:25`), `royalty: { [executor]: amount }`, plus `receipt_shas[]`. AIN rule `settlements/$patch_id/$tx_hash` (buyer or seller, `ain-ledger.ts:316`) needs no change. `deriveCatalog` skips `patch_id` starting with `job:` in downloads/revenue (`catalog.ts:142-143`); new `deriveCompute()` sums them per address into `{earned, spent}` by kind — the only source of the dashboard tiles (§11.3).
- AIN payouts (`Payouts.enqueue` idempotent on `(settle_hash, address)`, `store.ts:467-470`) pay ancestors, contributors and verifiers; refunds and clawbacks are ordinary positive/negative rows.

### 9.6 Worked examples

**A. Delegated live tests on AIN (tab).** node-c (gateway) sends 37 live tests in an hour to node-a at `infer_call 0.001 AIN`: 30 in `compare` (2 generations) + 7 `patched` (1) = 67 generations. The tab reaches 50 calls at 0.050 AIN → node-a answers the 51st call with 402 for `job:tab:t1` → node-c transfers 0.050 AIN bound to the nonce → settle #1 `{patch_id:'job:tab:t1', seller:node-a, buyer:node-c, amount:'0.05', scheme:'ain-transfer', billing:'compute', royalty:{node-a:'0.05'}, receipt_shas:[50]}`. The remaining 17 generations (0.017) settle at the tab's 1-h age → settle #2. Two chain records, 0.067 AIN, no payouts rows (royalty to the seller itself). node-c's dashboard: *Compute bought · 37 jobs · 0.067 AIN*; node-a's: *Compute earned · infer 67 calls · 0.067 AIN*.

**B. A training job with reservation.** node-u posts `train` (rows 8, balanced) with `bid 0.5 AIN`. gpu2 (floor 0.01 AIN/GPU-min, `reserve_min 10`) computes ETA 38 min → `r_offer = 0.5/38 = 0.0132/min`; it claims with `rate_quote 0.012`. node-u pays the reservation `10 × 0.012 = 0.12 AIN` via `/x402/jobs/j7/reserve` → settle #1 (`job:j7`, 0.12). Training takes 41 GPU-min → invoice `min(0.5, 41 × 0.012 = 0.492) = 0.492`; node-u pays `0.372` via `/x402/jobs/j7/result` → settle #2 and receives `lesson.npz`, `recipe.json`, `events.jsonl`, the receipt. node-u then buys a `check` on node-a (0.02 AIN, settle #3) → `taught 7/8` → `ACCEPTED`. Total 0.512 AIN. Had gpu2 never started (lease expired): settle #1 exists, gpu2 enqueues a 0.12 refund `payouts` row, node-u's console shows *refund pending → paid <tx>*.

**C. Rented verification and the commission share.** node-b (no runtime) is assigned to anchor `K` (26 samples). node-a already attested `K` from its own runtime, so node-b rents the run from **gpu2** (a different `runtime_id`): `26 × 0.0005 = 0.013 AIN` on delivery (settle #4), signs `AttestationV2 {executor: gpu2, runtime_id: R2}` → `executed.size = 2` → `K` is LISTED. Later `K` sells for 25 AIN (`royaltyShare 0.3`, one ancestor author X, one data provider D with share 0.7, `verifierShare 0.05`): pass 1 → X 7.5; remainder 17.5; pass 2 → D 12.25; seller line 5.25; verifier pool `min(1.25, 5.25) = 1.25` → seller 4.0, node-a 0.625, node-b 0.625. Σ = 7.5 + 12.25 + 4.0 + 0.625 + 0.625 = 25. Four `payouts` rows (X, D, node-a, node-b). node-b's net on `K`: +0.612 AIN; the verification page had shown *fee share at current price ≈ 0.625 · verify cost 0.013* before it spent. Had node-b rented from node-a's runtime instead, its attestation would be `duplicate_runtime`: no quorum, no share — the page says so first.

**D. The same on a shared local ledger (dev cluster).** Example A with `scheme:'local-credit'`: node-c signs the intent hash `{resource:'job:tab:t1', amount:'0.05', nonce, payTo:node-a, from:node-c}` (`Market.intentHash`, `market.ts:549-551`); node-a checks `creditBalance(node-c) ≥ 0.05` and appends the settle record; balances follow from the record (`market.ts:538-547`) — nothing else moves. The console labels it *node-ledger balance · same ledger only* (plan §6.2).

### 9.7 Visibility

Requester: *Compute* tab totals posted / running / delivered / paid / disputed, `spent_today`, per kind, average rate, `saved_by_local`; per job: bid, quote, minutes, invoice, reservation, tx links. Executor: *Earnings* — jobs done, GPU-minutes sold, earned today / 7 d, open tabs, pending payouts, unpaid requesters. Verifier: per anchor, fee share at current price vs the rented cost, and *this runtime already attested* warnings. All from `settle` + `payouts` rows (`deriveCompute`), so every node that reads the ledger shows the same numbers.

---

## 10. Gossip, API, ledger and the AIN state budget

### 10.1 Peer protocol (extends `api.ts:851-891`; every body canonical-JSON signed, `x-ainize-auth` purpose `job:<id>:<verb>`)

| route | direction | purpose |
|---|---|---|
| `GET /p2p/capacity` | any → executor | the signed `capacity` block (cheap poll before routing) |
| `GET /p2p/jobs?since=<cursor>&open=1` · `POST /p2p/jobs` | set-reconciliation + push of `JobRequest` / `JobEvent` envelopes, copying `/p2p/records` (`api.ts:858-874`, `local-ledger.ts:153`); works on both ledger kinds because AIN nodes never ingest peer records anyway (F12) |
| `POST /p2p/jobs/:id/claim` | executor → requester | claim; the 200 body is the grant |
| `POST /p2p/jobs/:id/heartbeat` | executor → requester | progress (`load/baseline/step/eval` events, `teach.ts:1255-1298`) |
| `POST /p2p/jobs/:id/deliver` | executor → requester | manifest + receipt (unpaid metadata) |
| `POST /p2p/jobs/:id/cancel` · `/dispute` | requester → executor / both | §5.6, §8.5 |
| `GET /p2p/jobs/:id` · `GET /p2p/jobs/:id/receipt` | any | status incl. lease and heartbeats; the receipt blob (public) |
| `POST /x402/jobs/infer` | requester → executor | synchronous paid inference (§6.1) |
| `GET /x402/jobs/:id/reserve` · `GET /x402/jobs/:id/result` · `GET /x402/tabs/:id` | requester → executor | 402-gated reservation, result manifest, tab settlement |
| `GET /p2p/dataset/:sha` | any with grant | lineage §5.2 |
| `GET /p2p/blob/:sha` | unchanged; `mayDownload` loses the self-reported-role exemption (§12.2) |

### 10.2 Local API

`GET/PUT /api/compute` (capacity, floors, hours, `gpu_plan`, delegate budget and caps), `GET /api/compute/peers` (routing table with price/eta/`runtime_id`/strikes/registered), `GET /api/jobs?dir=in|out&kind&state`, `POST /api/jobs` (operator posts a job), `GET /api/jobs/:id`, `POST /api/jobs/:id/cancel|dispute`, `GET /api/jobs/earnings`. Existing routes gain fields: `GET /api/runtime` (`api.ts:368`) → `runtime_id, checkpoint_hash, stack (ordered), shared_lock, lane`; `GET /api/chat/patches` (`api.ts:378-392`) → per-patch `runs_on`, routed queue; `POST /api/chat` → `provenance { node, runtime_id, stack_ran, cost, verified }` + `receipt`; `GET /api/teach/jobs/:id` → `executor, receipt_sha, checked_by, bid, invoice, paid`. `openapi.ts` gains all of them.

### 10.3 Error cases

| code | when | EN | KO |
|---|---|---|---|
| `402 payment_required` | result / reserve / tab over cap | (x402 body as today) | |
| `403 not_granted` | result requested by a non-requester | `Only the node that posted this job may fetch its result.` | `이 작업을 게시한 노드만 결과를 받을 수 있습니다.` |
| `409 base_mismatch` | executor table ≠ declared state | `The executor's table does not match the declared base state.` | `실행 노드의 테이블이 선언된 기준 상태와 다릅니다.` |
| `409 base_not_held` | parent missing, no token | `Executor lacks {sha…}; the grant carried no token for it.` | `실행 노드에 {sha…}가 없고 토큰도 발급되지 않았습니다.` |
| `409 not_independent` | verify on the author/seller/trainer runtime | `That node trained, authored or sells this patch and cannot verify it.` | `이 노드는 해당 패치를 학습·작성·판매하므로 검증할 수 없습니다.` |
| `409 pinned_conflict` | strip would remove a subscriber's pinned patch | `This executor keeps {patch} loaded for a subscriber.` | `이 실행 노드는 구독자를 위해 {patch}를 유지합니다.` |
| `409 eta_exceeds_deadline` · `409 already_claimed` · `409 queue_full {retry_after_s}` · `409 privacy_refused` · `422 price_below_floor {floor}` · `410 lease_expired` · `412 checkpoint_mismatch {have, want}` · `422 receipt_invalid {field}` · `423 hours_closed {until}` · `503 no_executor {tried, reason}` · `503 trainer_paused` (existing, `teach.ts:645`, now shown as *no trainer here — offered to the network*) | | | |

### 10.4 Ledger changes and the state budget

| record | change | on-chain size |
|---|---|---|
| `attest` | v2 body + 9-field signature (§8.3) | +≈300 B each |
| `settle` | `patch_id 'job:…'`, `billing 'compute'`, `receipt_shas[]` — existing rule | ≈300 B per job / tab |
| `node` | `capacity` block (sliced like `blobs`) | ≤ 700 B per node, heartbeat pruning per plan P8 |
| `executors/$addr` (new rule, admin-set) | `{ address, runtime_ids[], stake_ref, registered_at, sig }` | ≤ 400 B per executor |
| `challenge` | `target: 'attestation'|'receipt'`, `evidence_sha` | +≈100 B |
| JobRequest, JobEvent, receipts, manifests, artefacts, datasets | **never on chain** — gossip + `/p2p/blob` | 0 |

`/apps/knowledge` sits at 81.5 % of its 9.9 MB stake budget (F14) before any of this lands. Prerequisites: the plan's P8 (incremental reads, heartbeat pruning), lineage L1's 32-sample cap, the lineage §15 meter in the console, and a `stakeApp` runbook line (`ain-ledger.ts:278-282`) at 80 %. `infer` never settles per call — one record per tab (≤ 24 per requester-executor pair per day). On a `local` ledger none of this is constrained.

---

## 11. CLI, console and visitor screens

### 11.1 CLI (`packages/cli/src/commands/`: new `compute.ts`, `jobs.ts`; extended `node.ts`, `peers.ts`, `patch.ts`, `teach.ts`, `init.ts`)

`ainize init … --roles compute,trainer,verifier --runtime-api … --patch-dir … --repo … --trainer-container … --trainer-gpus …` · `ainize compute status` (runtime_id, checkpoint, hook, trainer, lanes, floors, hours, gpu_plan, today's earned/bought) · `ainize compute price set k=v …` · `ainize compute hours open|close|window HH:MM-HH:MM` · `ainize compute plan serving|training|timeshare` · `ainize compute register --stake N` · `ainize compute peers` · `ainize jobs post train --dataset <sha> --on <id>… --bid 0.5 --deadline 24h` · `ainize jobs post verify <patch> --via <executor>` · `ainize jobs quote <kind> …` (what each visible executor would charge, its ETA, `below_floor`) · `ainize jobs ls [--in|--out] [--state …]` · `ainize jobs show <id>` (timeline, receipt checks ✓/✗, money legs) · `ainize jobs cancel|dispute <id>` · `ainize jobs receipt <id> --verify` (offline signature and hash check) · `ainize jobs earnings` · `ainize runtime id` · `ainize patch hash <npz>` · `ainize patch attest <id> --receipt <sha>` · `ainize status --check` adds *shared patchDir without local-lock*, *no executor for model X*, *checkpoint_hash missing*, *trainer lease path*.

### 11.2 Console — *Compute* page (`/manage/compute`, strings `op.compute.*` in `i18n/pages/operator.ts`)

| section | EN | KO |
|---|---|---|
| header tile | `Runtime: owned by this node · {model} @{hash8} · lane {waiting} waiting · busy {s} s` / `Runtime: none — buying from {n} executor(s)` | `런타임: 이 노드 소유 · {model} @{hash8} · 대기 {waiting} · 사용 중 {s}초` / `런타임 없음 — 실행 노드 {n}곳에서 구매` |
| prices & hours | `Selling: infer {p}/call · check {p}/job · verify {p}/sample · train {p}/GPU-min (reserve {m} min)` · toggle `Accept remote jobs` · `Hours: always / closed until {ts} / training window {w}` · `GPU plan: Serving only / Training only / Time-share` | `판매 중: 추론 {p}/호출 · 검사 {p}/작업 · 검증 {p}/샘플 · 학습 {p}/GPU-분 (예약 {m}분)` · `외부 작업 수락` · `운영 시간: 항상 / {ts}까지 닫힘 / 학습 시간대 {w}` · `GPU 계획: 서빙만 / 학습만 / 시간 분할` |
| queue table | columns `Job · Kind · From · Bid / GPU-min · Priority · Position · ETA · Deadline · State`; marker `oldest-first slot`; tooltip `Why is this first?` prints the §5.2 numbers | `작업 · 종류 · 요청 · 입찰/GPU-분 · 우선순위 · 순번 · 예상 · 마감 · 상태`; `오래된 순 슬롯`; `왜 이 작업이 먼저인가요?` |
| delegation | `Buying: allow · caps infer {p} check {p} verify {p} train {p} · budget today {spent} / {cap} · preferred executors` + the §8.6 sentence | `구매: 허용 · 상한 추론 {p} 검사 {p} 검증 {p} 학습 {p} · 오늘 예산 {spent} / {cap} · 선호 실행 노드` |
| earnings tiles | `Compute earned · {n} jobs · {amount}` (infer/check/verify/train) · `Compute bought · {n} jobs · {amount}` (live tests / checks / verifications / training) · `Net this week: {knowledge} + {earned} − {bought} − {payouts owed}` | `연산 수익 · 작업 {n}건 · {amount}` · `연산 구매 · 작업 {n}건 · {amount}` · `이번 주 순수익: {knowledge} + {earned} − {bought} − {미지급 정산}` |
| empty | `No jobs yet. Post one with ainize jobs post, or let Teach delegate when the trainer here is busy.` | `아직 작업이 없습니다. ainize jobs post로 게시하거나, 이 노드의 학습기가 바쁠 때 Teach가 위임하도록 두세요.` |
| dev/legacy banner | `Shared-lock mode: attestations from this node count as one runtime with every other process on {patchDir}.` | `공유 잠금 모드: 이 노드의 증명은 {patchDir}를 쓰는 다른 프로세스와 함께 하나의 런타임으로 계산됩니다.` |

### 11.3 Dashboard, Network, Patch, Teach, footer

- **Dashboard** (`DashboardPage.tsx`): the two compute tiles beside *Knowledge sales* and *Creator share*, all from `deriveCompute()`.
- **Network** (`NetworkPage.tsx`): per peer `model @hash ✓/✗ · accepts · queue · ETA · price · hours · registered · strikes`; filter `can run jobs for me` / `내 작업을 실행할 수 있음`; `different model build — cannot run jobs for this node` / `모델 빌드가 달라 이 노드의 작업을 실행할 수 없음`; `closed until {ts}` / `{ts}까지 닫힘`.
- **Patch page** verification block (`PatchPage.tsx`): header `{k}/{quorum} independent runtimes` / `독립 런타임 {k}/{quorum}` (the plan's badge `Verified on {n} executor(s) · {attestations} attestations · {samples} of {rows} rows checked`); per row `verifier · executed on {node} ({runtime_id8}) · assigned ✓ / volunteer · checkpoint ✓ · stack ✓ · side effect {nat} · receipt` and `duplicate runtime — not counted` / `중복 런타임 — 계산되지 않음`; below quorum `Awaiting a second runtime — every attestation so far ran on one serving instance` / `두 번째 런타임을 기다리는 중 — 지금까지의 증명은 한 서빙 인스턴스에서 실행되었습니다`; `Verifier share {pct} of each sale` / `검증자 몫: 판매액의 {pct}`.
- **Teach** (`TeachPage`, `TeachLessonPage`, `i18n/pages/teach.ts`): queue card `Training on {node} (bought by this node, position {p}, ~{eta})` / `{node} 노드에서 학습 중 (이 노드가 구매, {p}번째, 약 {eta})`; no executor `No training node is open right now — your lesson stays queued and is offered to the network; this node checks every minute.` / `지금 열린 학습 노드가 없습니다 — 수업은 대기열에 남아 네트워크에 제안되며 이 노드가 1분마다 확인합니다.`; checked remotely `Checked on {node} (independent of the trainer) · receipt ✓` / `학습 노드와 독립된 {node}에서 검사 · 영수증 ✓`; ETA unknown `Not timed yet — shown after three real lessons` / `아직 측정 전 — 실제 수업 3건 이후 표시`; private dataset (§12.1 copy).
- **Footer / About** (plan §6.1 keys): `node.runs.executor` `Compute: executor {name} · queue {depth} · mode {serving/training}` / `연산: 실행 노드 {name} · 대기열 {depth} · 모드 {서빙/학습}`; `node.runs.remote` `Compute: bought from {executors}` / `연산: {executors} 에서 구매`.

---

## 12. Security and privacy

### 12.1 Datasets and lessons handed to executors

| access (lineage §6.1) | may leave the requester? | copy |
|---|---|---|
| `private` (and `delete_after_training`) | only to `teach.trustedExecutors` / the job's `executor_allow`; otherwise the job is local-only and, without a local trainer, refused | EN `Private lessons train only on this node or on an executor you trust.` KO `비공개 수업은 이 노드 또는 신뢰하는 실행 노드에서만 학습됩니다.` |
| `derivative` | yes, under a single-job grant; executor retention 7 d (§4.7) with a `deleted_at` heartbeat the requester records; **not technically enforceable** and the upload sheet says so | EN `Another node will see these questions and answers to train them; it promises to delete them after {d} days — that promise cannot be enforced.` KO `다른 노드가 학습을 위해 이 질문과 답을 보게 됩니다. {d}일 후 삭제를 약속하지만 강제할 수는 없습니다.` |
| `public` | yes | — |

The visitor's teaching key never leaves the requester (`contributor` → job id, §4.5); private draft lessons (`check` jobs) travel only under a token that expires with the lease; parents that are private drafts are never granted to a trainer that is not their owner.

### 12.2 Blob access

`mayDownload` (`market.ts:511-522`) keeps author, settled buyer and token; the **self-reported role exemption is removed** (F11 — any peer could claim `verifier` in `/p2p/hello` and pull paid parent blobs). Executors fetch parents and datasets only through grant tokens (single job, 24 h) or, for `verify`, through a token issued by the assigning requester; a registered executor (§7.5) may be exempted by operator config, never by its own advertisement. Executors must not re-advertise granted-but-unpaid shas (§4.7).

### 12.3 Identity, replay, rate limits

Node keys sign every record (`local-ledger.ts:98`), every `x-ainize-auth` header (`p2p.ts:21-33`) and every job object (`hashCanonical` + `signMessage`); nonces are single-use with a 10-min TTL (`store.ts:79`), transfer keys are bound to `(resource, nonce)` (plan P4), tx hashes are replay-guarded (`paymentSeen`). Claims are limited to 10/min per address; grants and payments go only to addresses seen for `verifier.warmupMs` with a stable `checkpoint_hash`. Keys move to a keystore per plan P6. Comment and reputation objects gossiped from peers are data, never instructions.

### 12.4 Threats and the guard that actually applies

| threat | guard (and what it does not do) |
|---|---|
| sybil verifiers / executors | one vote per `runtime_id` (§7.1); registration stake locked; warm-up; per-node reputation. Does **not** stop an operator with several real runtimes — stated in the UI (§7.1). |
| lazy or fake execution | re-execution (quorum, spot-checks, separate `check`), canaries from private held-out prompts, timing floors, artefact plausibility (§8.2). State hashes bind the declared state only. |
| model substitution | `checkpoint_hash` equality in every job, receipt and attestation; legacy anchors labelled. Hash is over the safetensors index + sizes, not full bytes (documented). |
| griefing the executor queue | per-requester in-flight and rows caps, claim rate limit, `unpaid_cap 0` for strangers, reservation for `train`. |
| leaking paid parents | grants replace the role exemption; `granted` blobs never advertised. |
| a slow job blocking a runtime for minutes | work-unit caps, enforced `lockAbortMs`, advertised `busy_until_s`, gateway re-routing — the running section itself is not preemptible. |

---

## 13. Changes required in the companion documents

### 13.1 `docs/lineage-teach-design.md` PRs L0-L9 (§18)

| PR | change |
|---|---|
| L0 | `royaltySplit` gains the verifier pool (§9.4) next to the pass-2 fix; `settle.billing 'compute'`; `deriveCatalog` skips `job:` ids. |
| L1 | `model.checkpoint_hash` mandatory on new anchors; `post_state_sha256` added beside `pre_state_sha256`; `answers_hash` gets the two-way reveal protocol (§8.4); `checked_by { executor, runtime_id, receipt_sha }` on draft anchors. |
| L2 | `patch.py hash/check` stays (read-first, all rows); `Runtime.readRows` lands first (node side) so receipts do not wait for the qwen3.8 change; `applyStack` "takes the cross-process lock once" → "runs as one serving-lane job"; `.ainize-instance` nonce; `runtime.shared` default `'none'`; the watchdog re-asserts the ordered stack after a time-share window. |
| L3 | job.json v2 is produced from a remote `JobRequest` as well as a local row; `contributor` replaced by job id; `recipe.executor`, `trainer_run`, `job_request_hash`; CHECKING becomes a `check` job when there is no local runtime (`check.mode`). |
| L6 | "this node" signals are emitted by the **gateway** from delegated receipts (`executed_by` on `usage`); misses stay with the executor; SC-11/SC-12 copy says "on this catalog". |
| L7 | T1 (`mask.only`) and T2 rebuild are `train` jobs with `parents[]`/`mask`; T0 stays local numpy. |
| L8 | 402 `requires[]` gains compute terms (`executors[]`, `infer_call` price) for buyers with no runtime. |
| L9 | teachable §1.1 non-goal ("no change to the ledger record shape, the publish/verify path, or the payout split") revised with a dated note; lineage §11 gains the verifier line; §7.7 "verifier must hold every parent blob" → "the **executing runtime** must hold or be granted every parent blob"; §18 legend/gating "on GPUs 4–6" → "on node-a (executor, :8002) plus one external runtime"; teach-mode §8 title "on this machine" → pointer to §5.3-§5.4 here. |

### 13.2 `docs/production-verification-plan.md`

Adopted unchanged: §1's rules (executor fingerprint, distinct-executor quorum, hash-only never PASS, evidence bundles), §2.2 V1-V10, §3.1 measurements, §3.2 experiment, §3.3 two lanes and the switch rule, §3.4 mapping, §4 chain hardening, §5 suite conversion and the lesson pool, §6 copy. Amendments this design asks for, to be reflected there:

1. `executor` fingerprint = `runtime_id` of §7.1 (`instance_id` ⇒ `serving_instance`, `mailbox_id` ⇒ `sha256(mailbox_nonce)`, `operator` ⇒ the signing address — not part of the hash).
2. §3.3 "Bid — … paid through the same x402 path (402 → transfer bound to the job id → job accepted)" ⇒ reservation at grant + invoice on delivery (§9.3); "order = bid desc, then age" ⇒ offered rate `bid / eta` with aging and the §5.2 guards.
3. §3.3 "Requester — its `runtime` becomes `{ kind:'remote', executor: <url> }`" ⇒ `{ kind:'remote', executors?: [url] }` with discovery from `capacity` when the list is empty; the unit of delegation is a job (a whole transaction), not a `Runtime` method.
4. V8 "challenges cost a bond" and V9 "bond lock on an upheld challenge" ⇒ registration stake that is *locked, never forfeited* (§7.5) plus strikes; wording "bond/slash" is not used in product copy.
5. §3.3 "Executor — advertises capacity on chain under `/apps/knowledge/market/executors/$addr`" ⇒ the registration record is on chain, the *capacity* block travels in `PeerInfo`/`node` (chain budget F14).
6. §1 "Quorum … operator key registered on chain" ⇒ registration gates *eligibility* (`E(A)`), distinctness is by `runtime_id`.
7. Step 4 of §7 (remote runtime + delegation) is delivered as C1-C3 here; step 3 (executor scheduler) as C4; step 6 (verification hardening) as C0/C2/C5 — see §18.

---

## 14. Risks and guards

1. **Attestation v2 must land before any rented verification** — otherwise the quorum becomes a vote (F7); C2 is a hard prerequisite of C5.
2. **Identity is hash-over-index, not bytes** (§3.3); two builds with identical index and sizes but different weights would collide — documented, revisit with a sampled-byte hash at start.
3. **No escrow** (F10): exposure per party is one tab / one reservation / one delivered job; wording never implies locked funds.
4. **Sybil with real hardware** beats distinct-runtime quorum (§7.1); registration stake is a cost, not a proof; hardware attestation is out of scope.
5. **Private data leaves the requester** for remote training; only allow-listed executors; retention unenforceable and said so (§12.1).
6. **Chain budget** at 81.5 % (F14); every on-chain addition here is hash-sized; P8 pruning and the meter are prerequisites; jobs never on chain.
7. **Greedy non-determinism** (F15): agreement rules use `hit`, never bytes; `unstable` is not `dispute`.
8. **Non-preemptible lock sections** (`runtime.ts:101`): caps and re-routing only.
9. **Nothing has trained on this box** (F13): every training ETA/cost is a projection until ≥ 3 gradient `teach_stats`; the UI says *not timed yet*.
10. **Time-share takes :8002 down** for the window + ~7 min; enable only after the §15.2 migration and never while other jobs on this host depend on :8002 without the owner's scheduling (plan §7 step 0).
11. **`patch.py hash/check` is in the read-only qwen3.8 repo**; `Runtime.readRows` via `live.read` gives state hashes without it (F9), so only L2's remove-by-journal blocks on that change.
12. **Single-host lock assumptions must never cross hosts** (F2, F3): `runtime.shared` is explicit and per host; job leases are heartbeat/expiry only.
13. **Verifier economics can be net negative** (rented verify vs 5 % share on a cheap anchor): the break-even line and `delegate.max_price.verify_job` let verifiers skip; price-0 anchors rely on runtime-owning volunteers.
14. **`mayDownload` sybil vector** (F11) is closed by grants; until C1 lands, executors must be registered verifiers.
15. **Two documents define verification** (this one and the plan): §13.2 lists the deltas; whichever PR lands second reconciles both texts in the same change.

---

## 15. This machine

### 15.1 Facts (read-only, 2026-09-02)

GPUs 0-3: the owner's (:8000, :8001) — never referenced. GPUs 4+5: `flashnext-e2e` (:8002, TP=2, ≈38.7 GB each) which other jobs depend on. GPU 6: idle. `flashtrain`: absent. Host RAM available ≈ 54 GB with swap full — a trainer cannot start while :8002 is up (F13). Node processes: node-a/b/c on one mailbox and one lock (F5); node-u pointing at :8000; node-t and node-g present. Lock at 11:48 UTC: `pid:2516525` `apply`.

### 15.2 Migration runbook (after C0-C3; every step verifiable)

1. Land C0-C3; build; `ainize compute price set …` + `ainize compute hours open` + `ainize compute plan serving` on node-a.
2. node-b, node-c: delete the `runtime` block, set `runtime: { kind:'remote' }`, `compute.delegate.allow: true`; node-u: the same plus `ledger.kind 'ain'`, `stubOffline` removed, `teach.enabled false` until a trainer exists; stop node-t. Restart through `scripts/cluster.mjs --mode market`.
3. `ainize status --check` on all: node-a `runtime ok · runtime_id …`; node-b/c/u `delegation: 1 executor visible`; `grep -r 8000 ~/.ainize-*/**/config.json` empty.
4. Live test on :3404 → answer carries `provenance.node = node-a`, receipt verifies, `usage` event on node-c has `executed_by`.
5. Verification: node-b's attestation shows `executor node-a`, `runtime_id R1`; node-a's own attestation on a foreign anchor also `R1` → catalog shows `1/2 independent runtimes` with the *awaiting a second runtime* line — expected.
6. Teach on node-u: a lesson posts a `train` job that stays `OPEN` with *no training node is open right now*; a `check` for an imported lesson runs on node-a with a receipt.
7. `rm -rf /mnt/newdata/qwen3.8/ple_patch_e2e/.ainize-runtime.lock` once only node-a references the mailbox; `ls` shows `.ainize-instance` instead.

### 15.3 GPU options (owner decision; plan §3.2 experiment first)

(A) **serving-only here, training bought from a joined machine** — default, zero risk to :8002. (B) run the plan's §3.2 feasibility experiment in an agreed window (2-GPU on 4+5 with :8002 paused, 1-GPU on GPU 6 expected to OOM) and set `trainer.gpus` from its result. (C) `gpu_plan timeshare` on node-a with the plan's switch rule — only after (B) and after node-b/c/u delegate, because during a window this box has no serving lane and the gateways must show `no_executor` honestly. Recommendation: A now, B when the window is granted, C only with a second executor online or an explicit owner OK.

### 15.4 Measurements still needed before the numbers here are more than projections

`Runtime.readRows` cost over 388,642 rows in 20,000-row chunks (lineage F3); apply/remove wall time for a krx-scale blob under load; infer latency distribution beyond the single 4.25 s figure; the §3.2 experiment's peak memory, load, step/eval seconds and switch time; whether `checkpoint_hash` over the index is identical across the three containers (they share `/mnt/newdata/qwen3.8`, so it should be — and then node-a/b/c rightly hash to one `runtime_id`).

### 15.5 Never on this host

Start a trainer on GPUs 4/5 while :8002 runs; write to `/mnt/newdata/qwen3.8/scripts/patch.py` (L2, qwen3.8 owner); touch `:8000`/`:8001` or their mailboxes (`<repo>/ple_patch` is where the teach lease wrongly lives today, F3); recreate `flashnext-e2e` (the hook's mounts and env are only reproduced by `docker start`, plan risk 11).

---
## 16. Judges' disagreements, resolved

| # | Point | Positions | Decision |
|---|---|---|---|
| R1 | Base design | judges 1 and 3: correctness-first; judge 2: operator-first | **Correctness-first trust model + operator-first mechanics + market-first proofs**, as itemised in the header. |
| R2 | What `runtime_id` contains | correctness-first: `sha(checkpoint ‖ executor address ‖ nonce)`; operator-first: distinct by address; all judges: the address defeats the purpose | **No address** (§7.1): `sha256(checkpoint_hash ‖ sha256(mailbox_nonce) ‖ serving_instance)`. node-a/b/c on :8002 are one runtime; distinct-runtime quorum is a floor, not a proof. |
| R3 | What state hashes prove | all three designs: "cannot fake without applying"; judges 1-3: false, the executor holds `after` | **State hashes bind the declared state only** (§8.2); execution is proven by re-execution, canaries, timing floors, artefact checks. Every "cannot fake" sentence dropped. |
| R4 | Bidding for verification | market-first: verifiers bid for `verify`; correctness-first: never | **Never bid** (§4.4, §7): assignment by sampling, executor paid a protocol price by the verifier, verifier paid from the commission (claim 37 at `10-출원명세서-전문.md:301-302`). |
| R5 | Pay-on-delivery vs the plan's "402 → transfer bound to job id → accepted" | designs: pay on delivery + prepay for strangers; plan: prepay the bid | **Reservation at grant (train only) + invoice on delivery** (§9.3); `unpaid_cap 0` for strangers (§9.2). The plan is amended (§13.2 item 2). |
| R6 | 60/40 delivery/accepted split (judges 1, 2) vs Leg-2 bonus (market-first) | | **Neither**: cost-plus capped at bid; the independent `check` is a bought job; disputes handle bad artefacts. A voluntary third leg is unenforceable. |
| R7 | Queue order | plan: bid desc then age; designs: bid per GPU-second | **Offered rate `bid / eta` with aging** (§5.2); equal to "bid desc" for equal-size jobs, and it is what the executor actually earns per minute. |
| R8 | Where pre-state hashes are computed | correctness-first: `patch.py hash` (qwen3.8 repo); operator-first: `Runtime.readRows` via `live.read` | **Node side first** (`readRows`, F9), `patch.py hash/check` in L2. |
| R9 | Claim window on the visitor path | market-first 30 s / correctness-first 3 s; operator-first synchronous | **Synchronous `POST /x402/jobs/infer`** (§6.1). |
| R10 | Time-share trigger | correctness-first: opportunity-cost rule; operator-first: plain switch; plan: pressure vs switch cost + `maxWaitMin` | **Operator switch `gpu_plan`; the plan's rule runs inside `timeshare`** (§5.4). |
| R11 | Executor identity for the fingerprint's "instance id" | market-first: hook read of a reserved address (not implementable — the hook returns rows only, F9) | **`docker inspect` container id + `StartedAt` by the owning node, fallback `/v1/models[0].created`** (§7.1). |
| R12 | Infer settlement batching | market-first: per (requester, executor, day); operator-first: tabs with caps | **Tabs** (§9.2): one record per cap / hour, exposure bounded. |
| R13 | Bond / slashing | plan V8/V9: challenge bond, verifier bond; designs: none without escrow | **Locked registration stake + strikes** (§7.5); no forfeiture; copy never says bond/slash; app-level escrow is a later decision (DECISION-3). |
| R14 | Sampling seed | operator-first: `ledger_height_at_announce` (absent on a local ledger) | **`record_hash(A)`** (§7.2), present on both ledgers. |
| R15 | `mayDownload` role exemption | judge 2: sybil vector | **Removed**; grants and registration replace it (§12.2). |
| R16 | Price-0 anchors | all: verifiers earn nothing | **Runtime-owning verifiers volunteer as today; optional `verify_bounty` later** (§7.5). |
| R17 | Job kind names | correctness-first `apply_check`; plan `check` | **Plan's names**: `infer | check | verify | train`. |
| R18 | Scenario ids | brief: from AZ-270 | **AZ-270** (F16). |
| R19 | `check` on the trainer's runtime | | **Allowed** (self-test); counted `verify` executions must be on another runtime (§4.3, §7.3). |
| R20 | Canaries from public anchor samples (judge 2) | | **Private held-out alt prompts first**, anchor samples second (§6.6). |

---

## 17. Test plan (`docs/ux-test-scenarios.json`, new ids from **AZ-270**)

Tags: **[box]** provable on this host as it is (node-a executor on :8002, node-b/c/u remote; one runtime); **[gpu2]** needs a second machine with its own vLLM + hook (or, for a few rows, a second hook-enabled vLLM on GPU 6 which the plan's experiment rules out for this model — so effectively a second machine); **[unit]** unit/integration test with an in-process fake, never a shipped stub.

- **AZ-270** Operator · Node-a starts with `runtime.shared 'none'`: `GET /api/runtime` shows `runtime_id`, `checkpoint_hash`, `shared_lock false`; `.ainize-instance` exists in the mailbox; no `.ainize-runtime.lock` is ever created. [box]
- **AZ-271** Operator · `ainize status --check` on a second config pointing at the same `patchDir` without `local-lock` warns; with `local-lock` the holder file carries `node:<addr>`, a job id and a heartbeat; a dead holder with a fresh heartbeat is not broken, one with a stale heartbeat is. [box]
- **AZ-272** Any · `/p2p/hello` carries a signed `capacity` block; a tampered block fails signature and is ignored; a block older than three gossip rounds is dropped from routing. [box]
- **AZ-273** Requester · node-b with `runtime.kind 'remote'` is `/readyz` 200 with `compute.executors 1`; with node-a stopped it is 503 with `executors 0`. [box]
- **AZ-274** Visitor · Live test on node-c (no runtime) is answered by node-a: provenance line names node-a, `stack verified ✓`, receipt opens and verifies; `usage` event on node-c has `executed_by node-a`; node-a's tab shows one call. [box]
- **AZ-275** Visitor · Compare mode with a pinned patch on node-a: the `strip` op is honoured and the base column differs from the patched one; a `strip` naming a subscriber-pinned patch yields `409 pinned_conflict` and the next executor is tried (with one executor: the `no_executor` copy). [box]
- **AZ-276** Visitor · Tampered receipt (stack differs from the request): answer discarded, badge `unverified`, executor strike recorded on node-c, copy shown. [unit]
- **AZ-277** Visitor · Executor timeout: nothing charged, copy `nothing was charged`, ticket ends `expired`. [unit]
- **AZ-278** Operator · Delegation budget exhausted on node-c: `/api/chat` 503 with the budget copy; the 20/h IP quota is untouched. [box]
- **AZ-279** Requester · Tab reaches 50 calls: the 51st call gets 402 for `job:tab:<id>`; payment settles one record; `deriveCatalog` revenue of every patch is unchanged; `deriveCompute` shows 0.05 earned on node-a and spent on node-c. [box]
- **AZ-280** Requester · Stranger requester (no history) gets `unpaid_cap 0`: 402 before the first call; after ten paid calls the cap opens. [unit]
- **AZ-281** Teach · Interactive preflight on node-u (remote runtime) returns `already_known / will_train` from node-a with `executed true` and the executor fingerprint. [box]
- **AZ-282** Teach · Worker CHECKING as a `check` job: node-u imports `TeachChecks` from node-a's receipt, applies `TAUGHT_MIN_RATIO` locally, draft anchor records `checked_by`. [box] (lesson from the plan's pool or a fixture npz)
- **AZ-283** Teach · `check` result with `taught 0 / heldout 0` is marked `lazy` and disputed; an honest `NEEDS_MORE` is paid. [unit]
- **AZ-284** Teach · Private dataset on node-u with no trusted executor: `train` refused with the §12.1 copy; `derivative` dataset posts with the retention sentence shown at upload. [box]
- **AZ-285** Verifier · Assignment: for a new anchor every node computes the same `E(A)` and rank from `record_hash`; the assigned verifier attests inside the window; an unassigned attestation inside the window is recorded `volunteer`, counts only after the window, earns no fee. [box] (window shortened by config)
- **AZ-286** Verifier · node-b rents a `verify` from node-a after node-a attested the same anchor: attestation lands as `duplicate_runtime`, catalog stays `1/2`, the verification page had shown *this runtime already attested* and the break-even line. [box]
- **AZ-287** Verifier · Attestation v2 signature covers nine fields; a record whose `verifier` ≠ author, or whose inner signature fails, is rejected at ingest and excluded by `deriveCatalog`. [unit]
- **AZ-288** Verifier · Hash-only: after the grace period nothing is written; an anchor with samples never lists on integrity checks. [unit] (injectable clock)
- **AZ-289** Verifier · Sealed samples: executor posts `answers_sha256` before reveal; a reveal whose hash ≠ `answers_hash` is refused; a mismatch between the two `passed` computations is a dispute. [box]
- **AZ-290** Verifier · Forced reversion mid-run (patch removed through the mailbox): re-apply once, then FAIL, `restarts_detected` and `mailbox_id` in the attestation. [box]
- **AZ-291** Catalog · Legacy `local-lock` attestations carry `independence 'same_gpu'` and count as one runtime. [box]
- **AZ-292** Catalog · Two attestations from two runtimes list the anchor; the badge reads `2/2 independent runtimes`; re-verification after a challenge excludes both previous runtimes and the challenger. [gpu2]
- **AZ-293** Catalog · Executed FAIL vs executed PASS ⇒ `DISPUTED`, resolved by a freshly drawn runtime; wrong-ticker anchor reaches `REJECTED`. [gpu2]
- **AZ-294** Payments · Sale of a listed anchor with `verifierShare 0.05`: `royalty` map matches example C to 6 dp, Σ = price, four payouts rows, verifier row voided after a contradicted attestation. [unit] + [box] (local-credit)
- **AZ-295** Payments · `train` reservation: 402 on `/reserve` bound to the job id; a replayed transfer is refused; invoice = `min(bid, minutes × quote)`; refund row when the lease expires unstarted. [unit] + [gpu2] (real training)
- **AZ-296** Payments · `local-credit` refused to a peer on a different ledger; accepted on the shared local ledger with `creditBalance` moving by the tab amount. [box]
- **AZ-297** Scheduler · Two `train` jobs with different offered rates run in rate order; every fourth dispatch takes the oldest; a third job from the same requester waits at `ACTIVE_JOBS_PER_KEY`; a job whose ETA exceeds its deadline is refused at claim. [unit] (fake trainer) + [gpu2]
- **AZ-298** Scheduler · Serving lane heap: a higher-rate `infer` overtakes waiting `check` calls but never interrupts the running section; `lockAbortMs` kills a stalled job and marks it `EXPIRED` unpaid. [box]
- **AZ-299** Scheduler · `gpu_plan timeshare`: window opens only under the plan's rule, `capacity.runtime null` is advertised two rounds before the stop, gateways show `no_executor`, health check + stack re-assert + `pre_state_sha256` re-measure before reopening. [gpu2 or an owner-scheduled window on this box]
- **AZ-300** Scheduler · `trainer.gpus` overlapping the serving GPUs without `timeshare` fails config validation with the item-145 message. [unit]
- **AZ-301** Jobs · Gossip set-reconciliation: a `JobRequest` posted on node-u reaches node-a and gpu2 within one round; a signed `cancel` stops a running container pid. [box] (cancel with a fake trainer) / [gpu2]
- **AZ-302** Jobs · Lease: three missed heartbeats re-open the job; after three re-offers it `EXPIRED`s with the reason in `ainize jobs show`. [unit]
- **AZ-303** Jobs · Grants: an executor without a token gets `409 base_not_held`; a token is single-job and expires with the lease; granted-but-unpaid shas are absent from `PeerInfo.blobs`. [box]
- **AZ-304** Blob · The self-reported `verifier` role no longer downloads paid blobs; a registered executor with operator exemption does. [box]
- **AZ-305** CLI · `ainize compute status|price set|hours|plan|register|peers`, `ainize jobs post|quote|ls|show|cancel|dispute|receipt --verify|earnings`, `ainize runtime id`, `ainize patch hash` produce the same results and codes as the API. [box]
- **AZ-306** Console · Compute page renders lanes, floors, hours, plan, delegation, the two earnings tiles and the no-escrow sentence in EN and KO; Dashboard tiles equal `deriveCompute`. [box]
- **AZ-307** Console · Patch page shows executor + `runtime_id` + receipt per attestation, the *awaiting a second runtime* line on this box, and `Verifier share 5 %`. [box]
- **AZ-308** Console · Network page filter *can run jobs for me* hides a peer with a different `checkpoint_hash` and one with `hours.open false`. [box]
- **AZ-309** Teach · Visitor strings: queue card *Training on {node}*, *no training node is open right now*, *checked on {node} · receipt ✓*, *not timed yet* in EN and KO. [box]
- **AZ-310** Join · A fresh `ainize init --roles compute,trainer,verifier … --peer boxA` node is routed to within one hello round; its first `verify` assignment arrives after `warmupMs`; its `checkpoint_hash` must equal box A's or every job to it is `412 checkpoint_mismatch`. [gpu2]
- **AZ-311** Join · A `train` job posted from node-u while no trainer exists stays `OPEN`, is claimed by gpu2 when it joins, delivered, checked on node-a, accepted, paid in two legs; the lesson imports as a private draft on node-u. [gpu2]
- **AZ-312** Evidence · Every job leaves `job.json`, `events.jsonl`, receipt, GPU samples and settle tx in `packages/e2e/evidence/<date>-<sha>/` per the plan's §5.5; a run without them is not green. [box]
- **AZ-313** Ledger · AIN round-trip preserves attestation v2 fields, `settle.billing 'compute'`, `node.capacity`, the executors record; the ledger-space meter counts them. [box] (dev chain; strict chain per plan step 7)
- **AZ-314** Security · Claim rate limit (10/min/address), replayed `x-ainize-auth`, expired nonce, and a `JobRequest` with a bad signature are all refused with distinct codes. [unit]

---

## 18. Implementation plan (PRs in order)

Legend: **[unit]** in-process fakes and fixture npz files; **[box]** node-a (:8002) + remote node-b/c/u on this host; **[gpu2]** second runtime. Sizing ≈ 12-14 engineer-weeks plus the plan's §3.2 experiment; C0-C3 (≈ 6 wk) deliver direction 3 and are provable on this box. Mapping to `docs/production-verification-plan.md` §7: C0/C2/C5 ⇒ step 6, C1-C3 ⇒ step 4, C4 ⇒ step 3, C6 ⇒ steps 5/7 touch-points, C7 ⇒ steps 9/10.

| PR | Scope | Files | Verify |
|---|---|---|---|
| **C0** Identity & advertisement (1 wk) | `checkpoint_hash` at runtime start; `.ainize-instance` nonce; `serving_instance` via `docker inspect`; `runtime_id`; `PeerInfo.capacity` (signed, mirrored to `node`); roles `compute`/`trainer`; `/readyz` rule; `runtime.shared 'none'|'local-lock'` with node-address holders + heartbeat; trainer lease path → `<dataDir>/locks`; `status --check` warnings; `compute.*` config | `packages/core/src/{types,config,config-schema}.ts`, `packages/node/src/{runtime,market,server,teach,api,openapi}.ts`, `packages/cli/src/commands/{node,init}.ts` | [unit] AZ-270-273, 300 |
| **C1** Job envelope, gossip, grants, receipts (2 wk) | `JobRequest`/`JobEvent`/`ExecutionReceipt` types + canonical hashing; `jobs_out` table and `teach_jobs` columns; `/p2p/jobs*`, claim/grant/heartbeat/deliver/cancel/dispute; grant tokens; `Runtime.readRows` (pre/post state via `live.read`); receipt blob route; `mayDownload` exemption removed; claim rate limit | `packages/core/src/{types,canonical}.ts`, `packages/node/src/{p2p,api,store,market,runtime,blobs}.ts` (new `jobs.ts`, `receipts.ts`) | [unit] AZ-301-304, 314 |
| **C2** Attestation v2 & distinct-runtime quorum (1 wk) | 9-field signature; `details`/`pre_apply` retained as blobs; inner-signature check at ingest and in `deriveCatalog`; counting by `runtime_id`, earliest wins, `duplicate_runtime`, `same_gpu`; hash-only retired; `collateral_nat` gate; `executors/$addr` rule + registration with locked stake | `packages/core/src/{types,catalog,local-ledger,ain-ledger}.ts`, `packages/node/src/{verifier,market,api}.ts`, `packages/core/test/core.test.ts` | [unit] AZ-287, 288, 291; [box] AZ-290 |
| **C3** Inference delegation (2 wk) | `RemoteRuntime` (`kind 'remote'`), `Market.chat` fork + `POST /x402/jobs/infer` (sync, lane heap), tabs, receipt verification, provenance/`usage.executed_by`, `testablePatches.runs_on`, teach preflight/CHECKING as `infer`/`check` jobs via `recheck()`, spot-checks, canaries, operator completion under `serial`, visitor strings EN/KO | `packages/node/src/{market,teach,runtime,api,chat-queue}.ts`, `packages/web/src/pages/ChatPage.tsx`, `packages/web/src/components/chat/*`, `packages/web/src/i18n/pages/{chat,teach}.ts` | [box] AZ-274-284 |
| **C4** Executor scheduler & lanes (1.5 wk) | priority heap in `serial()` and in `tick()`; aging/caps/deadline admission; `refreshCapability()`; enforced `lockAbortMs`; `gpu_plan` state machine with the plan's switch rule, RAM guard, health check, stack re-assert; single GPU-set source of truth; T8 timeout formula; `teach_stats` on kill | `packages/node/src/{runtime,teach,server}.ts`, `packages/core/src/config.ts` (new `packages/node/src/executor.ts`) | [unit] AZ-297, 298, 300; [gpu2]/owner window AZ-299 |
| **C5** Verification market (1.5 wk) | sampling assignment + window + warm-up; rented `verify` in `verifyOne`; sealed two-way reveal; challenge re-draw and strikes (derived); `verifierShare` in `royaltySplit` + payouts void; verification page strings; teachable §1.1 / lineage §11 notes | `packages/core/src/{catalog,types,config}.ts`, `packages/node/src/{verifier,market,payouts,api}.ts`, `packages/web/src/pages/PatchPage.tsx`, `packages/web/src/i18n/pages/detail.ts`, `docs/{teachable-dataset-design,lineage-teach-design}.md` | [box] AZ-285, 286, 289; [unit] AZ-294; [gpu2] AZ-292, 293 |
| **C6** Payments (1.5 wk) | `/x402/jobs/:id/reserve|result`, `/x402/tabs/:id` via a `settlePayment` adapter; `settle.billing 'compute'`, `job:` ids skipped by `deriveCatalog`, `deriveCompute()`; reservation refund and clawback rows; `unpaid_cap` policy; ledger-scheme check; budget meter line | `packages/node/src/{market,api,payouts,store}.ts`, `packages/core/src/{catalog,types,x402}.ts`, `packages/web/src/pages/DashboardPage.tsx`, `packages/web/src/i18n/pages/operator.ts` | [unit] AZ-295; [box] AZ-279, 280, 296, 313 |
| **C7** Train jobs, CLI, console, cluster, docs (2 wk; training itself [gpu2]) | `train` envelope from `TeachJobRow`/job.json v2, dataset+parent tokens, `contributor` → job id, result import as draft, privacy allow-list; `ainize compute|jobs|runtime id|patch hash|attest`; Compute/Jobs/Network pages EN+KO; `cluster.mjs --mode market`; join runbook; scenarios AZ-270-314 in `ux-test-scenarios.json`; evidence manifest; §13 doc edits | `packages/node/src/{teach,teach-recipe,api}.ts`, `packages/cli/src/{bin.ts,commands/compute.ts,commands/jobs.ts,commands/peers.ts,commands/patch.ts}`, `packages/web/src/pages/{ManagePage,NetworkPage,TeachPage,TeachLessonPage}.tsx` (new `ComputePage.tsx`), `packages/web/src/i18n/pages/*.ts`, `scripts/cluster.mjs`, `docs/*`, `packages/e2e/tests/*` (new `compute.spec.ts`) | [box] AZ-305-309, 312; [gpu2] AZ-310, 311 |

**Gating.** Rented verification (C5) does not ship before C2; `timeshare` (C4) is disabled by default on this host until the plan's §3.2 experiment has run and node-b/c/u delegate (§15.2); `train` delegation (C7) is exercised end to end only with a second runtime — on this box it is provable up to `OPEN` and through the `check` leg. The lineage plan's gate "until L2 and L3 are verified end to end on GPUs 4–6" becomes "until verified end to end on node-a (executor) plus one external runtime".
