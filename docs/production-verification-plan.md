# Production-level verification plan

**Status:** plan, 2026-09-02. Read-only review of the tree at `052defb` (main), the live cluster, the chain, the GPUs and the trainer.
**Owner directive (verbatim):** "이거 데모 아니야 모두 prod 레벨 검증으로 전환해" — this is not a demo; switch *all* verification to production level.
**Two further directives that shape §3:** "gpu 가 낮은것 자체는 문제는 안되지. queue에 쌓아두고 bidding 높은걸 실행해도 되고, 다른 node가 더 접속한다는걸 가정해도 되니까" (low GPU capacity is not a blocker — queue the work, run the highest bid first, assume more nodes join) and "만약 inference가 중앙에서만 이루어지도록 되어있다면 수정해야 될거야" (inference must not be central).
**Companions:** `docs/p2p-compute-market-design.md` (job model with bids, delegated inference, distributed verification, per-node runtimes — in progress), `docs/lineage-teach-design.md` (f17d027, lineage direction), `docs/teach-mode-design.md` §8 (trainer contract), `docs/teachable-dataset-design.md`.

This document is the single list of everything that still passes because of a stub, a fixture, a simulated verdict, a dev-only chain setting or a "demo" label — and, for each, what replaces it, in what order, and how we know it is done.

---

## Status today (measured 2026-09-02, read-only)

| | state |
|---|---|
| Serving this project may use | `flashnext-e2e` → :8002, TP=2 + expert-parallel on GPUs 4,5, 38.7 GB/GPU (34.66 GiB weights, 0.2 GiB KV = 8,192 tokens), PLE hook on mailbox `/mnt/newdata/qwen3.8/ple_patch_e2e`, up 30 h, `restart=unless-stopped`, 0 restarts. :8000 (GPUs 0,1) and :8001 (GPUs 2,3) are the owner's and off limits. GPU 6: 0 MiB used. |
| Trainer | container `flashtrain` **does not exist** (`docker ps -a`); image `vllm/vllm-openai:qwen38-flash-next` is present. `train/teach.py` defaults to `--devices cuda:0,cuda:1,cuda:2`; `train/container.sh up` hard-codes `--gpus device=4,5,6`. Only real gradient teach run so far: `.teach/measure-1` (2 facts) — load 67.1 s, 16 steps + 8 evals in 28.5 min, killed at step 16/20 by `trainer.timeoutMs` 30 min. |
| Host RAM | 386,763 MB total, **57 GB available, swap 8/8 GB full**. Each vLLM keeps a PLE CPU-offload process: 101.4 GB RSS (flashnext-e2e, pid 1040492), 101.2 GB (flashnext-after), 95.6 GB (flashnext). The trainer's `RowTable` needs another 102.4 GB anonymous — it cannot load while :8002 is up. |
| Teach on live nodes | node-a :3402 backend **stub** (publish `auto`, AIN chain), `/api/teach/policy` timing `{p50_s 1.6, samples 8, simulated true}`, `queue.position_eta_s 2`. node-b :3403 / node-c :3404 backend gradient, trainer `paused: trainer container flashtrain is not running`. node-u :3422 stub + `stubOffline true` (simulated checks), `runtime.api http://localhost:8000` (off-limits server) with :8002's mailbox. |
| Verification | node-b/node-c execute benchmarks on :8002 for real (all 8 public + 406 hidden attestations `vllm:Qwen3.8-Flash-Next`, 0 hash-only written) — but they are one supervisor, one host, one vLLM, one mailbox, one lock. `collateral_nat` is never measured. 0 FAIL attestations ever. |
| Chain | `ngram-ain` = ain-blockchain `1-node` genesis (chain_id 0, 1 s epochs, one validator) with `ENABLE_TX_SIG_VERIF_WORKAROUND=true` and `ENABLE_GAS_FEE_WORKAROUND=true`; height 190,762, 1,344 market records; `/apps/knowledge` at 81.5 % of its 9.9 MB budget. Purchases, royalties (node-c: 28 paid rows = 84 AIN), anchors, attestations, settlements are real transfers/writes on it, sent with `gas_price 0`. |
| Suites | 237 scenarios; ~100 (AZ-103…AZ-222) specified against the stub; market suite skips 11 on the real path; dataset suite 100/100 in 31 min on `stubOffline`, i.e. on simulated checks — 135 ANNOUNCED lessons, 0 attestations. |

---

## 1. What "production-level verification" means here

One page, one rule per area. Everything in §2–§7 exists to make these rules true and to prove them.

**Training.** A lesson exists only if `train/teach.py` ran on real GPUs under the trainer container and exported `lesson.npz` + `recipe.json` from that run. The node records `recipe.trainer`, container id, GPU set, `load_s`, per-step seconds, eval seconds, and the trainer image digest. Timings shown to a visitor come only from such runs. There is no code path in the shipped node that writes a placeholder or copies a fixture as a lesson; `backend: 'stub'` and `stubOffline` are refused outside `NODE_ENV=test`.

**Model checks (preflight, CHECKING, live test, verification).** Every verdict is a measurement on a live vLLM with the PLE hook: apply → ask → restore, under the executor's queue, with the runtime's model name, checkpoint hash, server instance id and mailbox id recorded in the result. A check that could not run says `executed: false` and yields no verdict; there is no simulated answer, no "(stub model) I do not know". The locality (side-effect) bound each anchor declares is measured by every verifier (`collateral_nat`) and fails the attestation when exceeded. A verifier whose table reverts mid-run and cannot re-apply fails, never passes.

**Quorum among independent executors.** An attestation counts toward LISTED only if it names an *executor fingerprint* (server instance id + checkpoint hash + mailbox id + operator key registered on chain), its inner signature verifies against the verifier address, and the record author equals that address. Quorum is counted over **distinct executors**, not distinct node processes. Two processes on one vLLM are one executor. The catalog and the badge say exactly how many executors verified a listing; nothing is labelled "independent" unless it is. Hash-only fallbacks never PASS. Challenges cost a bond, expire, and are resolved by a fresh quorum that excludes both the challenged verifier and the challenger.

**Payments and chain.** Every purchase, royalty and compute bid is an AIN transfer whose transaction is bound to the quote (nonce + resource), verified on chain, finalized before content is released, and never accepted twice. Gas is paid at the network's price and shown. The node knows which network it is on (`local` / `testnet` / `mainnet`), says so, and refuses genesis funding, plaintext prototype ledgers and play-money pricing outside `local`. The chain the product is proven against verifies signatures and charges gas; the dev chain's workarounds are for a disposable test instance only.

**Lineage.** "Builds on X" means the trainer loaded X (and X's parents) into the row table before the baseline probe, trained on top, and exported `before` = parent-applied rows; CHECKING and verification measure in the buyer's order (parents, then the lesson) and gate parent regression there; royalties follow the recorded parents. An anchor whose `parents` were only used as contrast pairs is not a lineage anchor.

**The suites.** No `test.skip` on the real path. Every scenario runs against the gradient trainer, live checks, a signature-verifying chain and real transfers; scenarios that need a lesson use a pool of lessons trained in the same run (one training window), so wall time is bounded; each run archives its evidence (job dirs, trainer logs, GPU samples, attestation ids, tx hashes, traces) in a retained directory. A green run *is* the verification record.

**The copy.** The product describes what this node runs — ledger and network, model and serving instance, trainer container and GPUs, number of executors behind a listing — in EN and KO. The words "demo", "시연", "데모", "play money", "가상 화폐", "simulated" do not appear on any visitor or operator surface; states that used to be labelled "demo" are either gone or reported as what they are (`trainer paused`, `checks not executed`, `network: local`).

---

## 2. Inventory: every demo assumption and its replacement

Effort: S ≤ 1 day, M 2–5 days, L > 1 week. "Owner" = needs something only the owner can provide.

### 2.1 Teach / trainer

| # | Demo assumption today | Where | Replacement | Effort |
|---|---|---|---|---|
| T1 | `teach.backend: 'stub'` and `teach.stubOffline` are first-class config; env `NGRAM_TEACH_BACKEND` / `NGRAM_TEACH_STUB_OFFLINE` override any node, including an AIN seller with `publish: 'auto'`. | `packages/core/src/config.ts:58-70,271,274`; `config-schema.ts:329-330,355`; `packages/node/src/teach.ts:359,991,1238` | Schema accepts `backend: 'stub'` / `stubOffline` only when `NODE_ENV=test`; a production binary that sees them refuses to start (`teach.backend stub is test-only`). Default stays `gradient`. | S |
| T2 | `runStub` copies `results/train-fact/픽셀플러스.npz` when any prompt mentions 픽셀플러스 (so the A/B "really" answers 087600) or writes one 0.01-valued row per question; `recipe.trainer 'stub'`, note "no training happened". | `teach.ts:142,195-198,1356-1425`; `packages/core/src/npz.ts:230,270` | Move `runStub`/`writeStubNpz` to `packages/node/test/` (test-only module); production `train()` has one branch: `docker exec <container> python3 /work/train/teach.py --job … --devices <derived from trainer.gpus>`. | S |
| T3 | `stubOffline` fabricates preflight answers (`stubAnswer`), sleeps 400 ms in CHECKING, invents taught 2N/2N, honours a `LOCALITY_FAIL` sentinel; `checks.simulated: true`. | `teach.ts:450-454,527-529,1123-1128,1436-1452` | Delete. A node whose runtime is unavailable reports `trainer: paused` / 503 and `checks.executed: false` (the gradient path at `teach.ts:1463-1468` already does). Keep `simulated` in the API type only as a permanently-false field until the next API version removes it. | S |
| T4 | **Publish gate missing:** `publish()` / `announceJob()` / `Market.announce()` never check `recipe.trainer`, `checks.executed`, `checks.simulated`; the result page offers "Publish anyway (demo)". node-u's local ledger holds 135 ANNOUNCED stub lessons. | `teach.ts:1718-1766`; `packages/node/src/market.ts:390-397`; `packages/web/src/pages/TeachLessonPage.tsx:65-66,341-373`; `i18n/pages/teach.ts:513-514` | `announceJob` and `Market.announce` (for `origin: 'teach'`) return **409** with `reason` unless `recipe.trainer === 'train/teach.py'`, `recipe.trainer_run` (container id, gpus, image digest) is present, `checks.executed && !checks.simulated`, and the executor fingerprint of the check is recorded. Remove the "Publish anyway" affordance and both strings (EN/KO). node-u's local ledger is reset when node-u is reconfigured (§2.4), which removes the 135 records; on the AIN chain no stub lesson was ever announced (catalog = 4 seeded anchors). | S |
| T5 | **teach_stats backend leak:** `store.teachStats('gradient')` treats `backend IS NULL` as gradient; node-a has 8 NULL rows (avg 1.86 s) → `/api/teach/policy` reports `timing {p50_s 1.6, samples 8, simulated true}` and `queue.position_eta_s 2` for a 5–25 min job. | `packages/node/src/store.ts:343-350`; `teach.ts:390-397,415-419,812-821` | Migration at startup: NULL-backend rows become `backend = 'unknown'` (never counted); `teachStats('gradient')` requires `backend = 'gradient'` **and** `trainer_run IS NOT NULL`; `position_eta_s` / `eta_s` are `null` whenever `timing.simulated` or `samples = 0`. Verification: `GET :3402/api/teach/policy` → `samples 0, position_eta_s null` until the first gradient lesson finishes. | S |
| T6 | node-a (AIN chain, publish `auto`) runs the stub with measured checks; node-b/c are gradient but the container does not exist. | `~/.ngram-cluster/node-a/config.json` | After §3 lands: node-a = executor node, `backend gradient`, `publish 'review'` until the first ten real lessons have been reviewed, then `auto` is an operator choice. Until then `teach.enabled false` on node-a (no lesson is better than a fake one). | S (config) |
| T7 | Trainer cannot run: `flashtrain` absent; `acquireSlot` demands 20 GB free on GPUs 4,5,6 while :8002 holds 38.7 GB on 4 and 5; nothing creates/starts/stops the container (`idleStopMin` unused); the GPU set is in three unrelated places. | `teach.ts:356,989-1032`; `train/container.sh`; `teach.py:264` | §3: the executor's mode scheduler owns the container lifecycle and the GPU set (single source of truth passed to `docker run --gpus` and `--devices`); the free-memory check runs *after* the window has freed the GPUs. | M |
| T8 | 30-min `trainer.timeoutMs` vs measured pace (≈107 s per step+eval cycle for 2 facts; 8 facts ≈ 1.5–2 h) → every balanced gradient job dies at the timeout and records no `teach_stats`. | `teach.ts:1307,1329`; `teach.py:411-418` | Timeout derived from the job (`load + steps × step_s(rows) + evals × eval_s(rows)` × 1.5, floor 90 min); trainer emits `sampled`, honours `probe_kinds ['qa']` and `eval_sample` (4× fewer probes), batches probes (left-padded generate or teacher-forced argmax); `teach_stats` written from events even when a run is killed (marked `completed: false`). | M |
| T9 | Lineage is not trained on top: `teach.py` has no parent loading; parents contribute ≤ 8 contrast samples; CHECKING applies parents on top of the lesson (reverse of buyer order). | `teach.py` (no `parents`); `teach.ts train()`, `check()` step 3 | lineage-teach-design §7.1–7.6: `job.json.parents[{patch_id, sha256, npz}]`, load before baseline, export `before` = parent-applied rows, CHECKING in buyer order with `parent_regression` measured there, reversibility assertion. | M |
| T10 | Trainer image is `vllm/vllm-openai:qwen38-flash-next` + `pip install transformers@main` at `container.sh up` time — unpinned. | `train/container.sh:19` | Build and tag `flashtrain:<date>` with pinned transformers/fla; the node records the image digest in `recipe.trainer_run`. | S |

### 2.2 Model checks and verification

| # | Demo assumption today | Where | Replacement | Effort |
|---|---|---|---|---|
| V1 | Three verifiers = one supervisor, one host, one vLLM (:8002), one mailbox, one lock; attestation records only `vllm:<model>`; compatibility is `id_M.startsWith(model)`. | `scripts/cluster.mjs`; `verifier.ts:46,98`; `runtime.ts:acquireLock` | Attestation carries `executor: {instance_id, checkpoint_sha256, tokenizer_sha256, mailbox_id, operator}`; executors register on chain (`/apps/knowledge/market/executors/$addr`); `deriveCatalog` counts distinct executors; the badge reads "verified on N executor(s)". On this box N = 1 until a second machine joins (§3.4). | M |
| V2 | Inner `Attestation.sig` never verified; local ledger accepts `body.verifier ≠ record.author`. | `verifier.ts:134`; `local-ledger.ts ingest`; `catalog.ts` | Verify `sig` against `verifier` at ingest and in `deriveCatalog`; reject attest/challenge bodies whose address ≠ record author; expose `sig` in `/api/patches/:id/records`. | S |
| V3 | `collateral_bound_nat` declared on every anchor, measured by nobody (`collateral_nat` never assigned). README:137 claims it is measured. | `runtime.ts:20,verify()`; `verifier.ts:101,110`; `web-visitor.spec.ts:528` | `verify()` measures top-1/logprob drift on a fixed unrelated prompt set pre/post apply (`/v1/completions` with `logprobs`), writes `collateral_nat`, fails when `> collateral_bound_nat`; the README sentence is corrected until then. | M |
| V4 | Hash-only fallback after 15 min writes `passed: true`; counts toward quorum for sample-less anchors and model `demo-ngram-1b`; never exercised by a test; 671 "waiting before hash-only fallback" warnings on node-b. | `verifier.ts:16-20,60-64,113-122`; `catalog.ts:145-150` | After the grace period write nothing (or a `not_verified` record that counts for nothing); `benchmark.samples` mandatory at announce (min per schema); delete `demo-ngram-1b`; fallback tested with an injectable clock. | S |
| V5 | Restart-aware re-apply accepts the chunk after two failed re-applies; never fired on the live cluster (177/177 `restarts=0`); untested. | `runtime.ts verify()`; `runtime.test.ts` | Fail the attestation when the table is still reverted after the retry budget; test that removes the patch via the mailbox mid-run; `restarts` and `mailbox_id` in the attestation. | S |
| V6 | Benchmarks author-chosen, public, as small as 1 sample (every e2e publish), capped at 40 (26 of 2,761 rows); `answers_hash` commit–reveal exists in the type only. | `types.ts:27-40`; `runtime.ts verify`; `operator-cli.ts:65`; `seed.ts:87` | Schema minimum (≥ 20 samples and ≥ 1 % of rows), verifier-drawn held-out variants, `answers_hash` checked at attest time, pre/post on the full sample, per-schema pass rule on chain; announce refused below the minimum. | L |
| V7 | Quorum 2 with exactly two eligible verifiers on one host; PASS+FAIL never resolves; 0 FAIL in 200 attestations; no REJECTED scenario on the real model. | `catalog.ts:158-166`; node configs | Quorum ≥ 2 **distinct executors**; explicit split rule (any executed FAIL → `DISPUTED`, re-verified by a fresh executor); suite scenario that announces a wrong-ticker patch and watches it become REJECTED on :8002. | M |
| V8 | Challenges free, unbounded, un-expiring, resolvable by the challenged verifier; live suites assert "no challenge record" as a precondition. | `market.ts:427-434`; `catalog.ts:52-62,155-159`; `web-crosscut.spec.ts:1031,1060` | Challenge bond + rate limit + expiry; resolution by a fresh quorum excluding challenged verifier(s) and challenger; answering attestation references the challenge hash; e2e: challenge → re-verify on :8002 → sale resumes / listing removed. | M |
| V9 | No verifier bond; throwaway verifier identities from suite runs sit on the chain as "third attestations". | `types.ts:154-158`; `ain-ledger.ts:271-283` | Executor registration with a minimum stake under `/apps/knowledge/market/executors`; attestations counted only from registered executors; bond lock on an upheld challenge. | L |
| V10 | Evidence lives only in the verifier's local event store; e2e `results/`, `report/`, `test-results/` gitignored and overwritten. | `verifier.ts:111`; `packages/e2e/.gitignore` | Content-addressed evidence bundle (details, log, executor fingerprint) whose hash is in the attestation and whose body is in the blob store, served under `/api/patches/:id/records`; suite runs archived (§5.5). | M |

### 2.3 Payments and chain

| # | Demo assumption today | Where | Replacement | Effort |
|---|---|---|---|---|
| P1 | Dev chain = `1-node` genesis with signature verification and gas fees switched off; every node auto-funded 1000 AIN from the public genesis key. | `deploy/docker-compose.ain.yml:145-172`; `ain-ledger.ts:34-50,277-300`; `chain.ts:103-137`; `cluster.mjs:91-101` | Keep the dev chain as the *local* network, but prove the product on a **strict** disposable instance (`ENABLE_TX_SIG_VERIF_WORKAROUND=false`, `ENABLE_GAS_FEE_WORKAROUND=false`, `min_gas_price 500`) per suite run; then testnet (§4). Genesis funding allowed only when `ledger.ain.network === 'local'`. | M |
| P2 | `gas_price: 0` everywhere; no config key; `AinLedgerOptions.gasPrice` never set. | `ain-ledger.ts:225,246`; `server.ts:72`; `agent.ts payFor()`; `chain.ts chainFund` | `ledger.ain.gasPrice` (≥ the network's `min_gas_price`) passed to every `tx()`, `wallet.transfer` and ain-js knowledge call; gas shown on the wallet page and in the 402 requirement; price floor ≥ gas. | S–M |
| P3 | Network label is `chainId === 0 ? 'ain:local' : 'ain:mainnet'`; x402 requirement hard-codes `network: 'ain:local'`; testnet indistinguishable from local. | `ain-ledger.ts info()`; `market.ts:525-535`; `types.ts:75` | Explicit `ledger.ain.network: 'local' \| 'testnet' \| 'mainnet'` used by `LedgerInfo.network`, the x402 `network` field, the price note (§6) and the guards in P1/P5. | S |
| P4 | x402 `ain-transfer` never consumes the issued nonce; `settlePayment` checks only `to === seller`, `value ≥ price`, local `payments_seen`; content released on `is_executed`; no tx age bound; replay guard is seller-local SQLite (866 unconsumed nonces on node-a). | `market.ts:524-611`; `ain-ledger.ts verifyTransfer()`; `x402.ts transferKeyFor`; `store.ts:247-258` | Transfer key = `transferKeyFor(resource, nonce)` required and verified on chain; nonce consumed; tx must be younger than the nonce TTL; require `is_finalized` (poll to the network's finality window); consult the on-chain settlement for that tx hash before accepting; AZ-076's "ignore stale nonces" expectation rewritten. | S–M |
| P5 | Local-credit "play money": `ledger.kind 'local'` default, currency CREDIT, 100 free credits per fresh address, prototype-ledger HMAC import (`x402-demo-facilitator`), copy "development play money". | `config.ts:174,183-206`; `market.ts:537-609`; `local-ledger.ts:24-26,93-112,195-215`; i18n (glossary, common, public, docs, operator, detail, teach) | Default `ledger.kind 'ain'` / currency AIN; CREDIT allowed only on a node with `ledger.kind 'local'` **and** no public URL; prototype import removed from the shipped CLI; copy says "node-ledger balance" (§6), never play money. | M |
| P6 | Keys plaintext in `config.json` / `identity.json`; genesis key committed in two source files and compose. | `config.ts saveConfig/loadConfig`; `config-schema.ts identity`; `init.ts:232-330`; `agent/identity.ts` | V3/scrypt keystore (ain-js already supports it) unlocked by `NGRAM_KEY_PASSPHRASE` or prompt; `identity.privateKey` optional; genesis key only in the dev compose file. | M |
| P7 | App name `knowledge` hard-coded in ain-js (`config appName` ignored); admin = node-a on the dev chain. | ain-js `knowledge/index.js:568-660`; `ain-ledger.ts:285-326` | Owner confirms the name on the target network (§4) or ain-js is parameterised. | S / M |
| P8 | State budget 81.5 % used on the dev app; every node re-reads the 990 KB market subtree every 8 s; 127 node heartbeat records for 4 nodes; `eventHandlerUrl` never used. | `ain-ledger.ts refresh()/stakeApp()` | Stake sized to expected records; incremental reads or the event handler; heartbeat pruning; `/api/chain` shows usage and unstakeable amount. | M–L |
| P9 | `gateway_url` on chain is `http://localhost:340x`. | `market.ts announce()` | `server.publicUrl` required for `publish !== 'never'` on non-local networks; refuse announce with a loopback URL there. | S |
| P10 | `trustProxy: true` on every live node (any client can spoof `X-Forwarded-For`). | `cluster.mjs:63-68`; node configs | `trustProxy: false` (or a hop count) on any reachable node; cluster.mjs sets it only for the private throwaway cluster. | S |

### 2.4 Live node configuration

| # | Demo assumption today | Replacement |
|---|---|---|
| N1 | **node-u :3422 `runtime.api` = http://localhost:8000 (owner's off-limits server)** with :8002's mailbox `ple_patch_e2e`; `stubOffline true`; local ledger, CREDIT; publish `auto`. | node-u becomes a *requester* node (§3.4): no local runtime at all — `runtime: { kind: 'remote', executor: 'http://localhost:3402' }`; `teach.backend 'gradient'` delegated; `stubOffline` removed; `ledger.kind 'ain'` on the dev chain so its lessons are verified by real attestations; `publish 'review'`; `trustProxy false`. Its local ledger (135 stub ANNOUNCED) and `teach_stats` (1,473 stub rows) are discarded with the reconfiguration. Until the remote runtime exists (step 4 in §7), the interim is `runtime.api http://localhost:8002`, `stubOffline false`, `backend 'gradient'`, `teach.enabled false`. |
| N2 | node-t :3412 stub + stubOffline. | Stopped and removed; its scenarios move to node-u. |
| N3 | node-a teach stub / publish auto; node-b/c gradient with no container. | node-a = executor (§3); node-b/c verifiers delegating to node-a's executor, counted as the same executor until machine 2 joins. |
| N4 | `scripts/cluster.mjs`: "Local 3-node demo cluster", `TEACH_BACKEND` default `'stub'`, `publish 'auto'`, `trustProxy true`, genesis funding, `seedDemo`. | Default `gradient`; refuse `publish 'auto'` with a non-gradient backend; `trustProxy false` unless `NGRAM_CLUSTER_HOME` is a throwaway; funding only when `network === 'local'`; `seed` = "register reference knowledge". |

### 2.5 Copy and docs (EN + KO)

Every string and doc line below is listed with its replacement in §6. Summary of what goes: `teach.card.simulated`, `teach.card.stub_only`, `teach.res.title_demo`, `teach.res.learned_demo`, `teach.res.learned_all_demo`, `teach.res.checked_sample_demo`, `teach.res.publish_demo`, `teach.res.publish_demo_cta`, `teach.res.simulated`, `teach.res.stub_only`, `op.teach.settings.backend.stub`, `price.credit_note`, `price.ain_note`, glossary `ain` help, glossary `credit`, glossary `synthetic`, `terms.s2.p4` (credit sentence), LessonCard / TeachLessonPage / TeachDatasetPage / StageRail / DatasetTable / util stub branches, CLI `teach` "backend stub (no GPU training on this node)" and "not timed — this node simulates training", `openapi.ts` stub descriptions, README "3-node demo cluster" / "development play money", deploy/README stub recommendation and stale :8000 table, design docs "backend stub for CI".

### 2.6 What is legitimate and stays

`packages/e2e/fixtures/az-*.jsonl|csv`, `az-bad.txt`, `az-cli.csv` (inputs, not results); `packages/node/test/fixtures/degenerate-corpus.json` (captured real corpus); AZ-082 (real publish/verify/pay on the cluster); AZ-117/118 unit fakes (kept, with a gradient integration counterpart); the `--test` hidden-anchor visibility (but only on a disposable chain); the real seeded artifacts (`krx-all-2761` and versions).

---

## 3. GPU operating model

### 3.1 Measured constraints this model rests on

- **Trainer static footprint** (safetensors headers): packed backbone 68.74 GB (experts int4+scales 62.29, GDN 4.17, norms/router 1.39, shared experts 0.47, self-attn 0.35) + `embed_tokens` 1.27 GB (first device) + `lm_head` 1.27 GB (last device). The "49 GB" in `results/13`, `results/14` and `docs/teach-mode-design.md` is wrong.
  - 3 GPUs (`ceil(48/3)=16` layers each): 24.2 / 22.9 / 24.2 GB static → measured 23.9 / 22.3 / 23.5 GiB at micro 16 ⇒ ~1–1.3 GiB dynamic.
  - 2 GPUs: 35.7 / 35.6 GB static (33.2 GiB) of 39.5 GiB usable; estimated peak 35–38 GiB; largest dynamic tensor is `logits[:, :-1].float()` = B·L·248,320·4 B (0.64 GB at 16×40 tokens, 4.8 GB at 16×300) plus ~2.5 GB of `PackedExperts` chunk temporaries at `CH=128`.
  - 1 GPU: 71 GB static — impossible on 40 GB without streaming experts from host RAM (+62 GB host RAM the host does not have) or an 80 GB card.
- **`hf_model.load_model(devices)` is generic** (`per = ceil(n_layers/len(devices))`); the only "3" is the `--devices` default in `teach.py:264`, which `teach.ts` never overrides.
- **Serving needs 2 GPUs**: TP=2 + EP loads 34.66 GiB/GPU; TP=1 would need ~69 GB; TP ∈ {1,2,4,8} and `--enable-expert-parallel` are mandatory (`serve.sh` header). "Serve on 5+6 while training on 4+5" is impossible (GPU 5 shared).
- **Host RAM**: the trainer's `RowTable` (102.4 GB) cannot coexist with :8002's 101.4 GB PLE-offload process at 57 GB available. Stopping `flashnext-e2e` frees ~101 GB and GPUs 4,5 together.
- **Serving restart**: `docker start flashnext-e2e` → weights loaded 194 s (cold, EXT3) → graph capture done at 6 min 48 s (measured 2026-09-01 05:16:51 → 05:23:39). `restart=unless-stopped` means `docker stop` keeps it down and `docker start` restores it with identical mounts, env and hook — no `serve.sh` re-run.
- **Trainer pace** (measure-1, 2 facts, micro 16): load 67.1 s; ~35 s per step (3 micro-batches) + ~140 s per 12-probe greedy eval; 20-step balanced lesson of 2 facts ≈ 37 min today; 8 facts ≈ 1.5–2 h, eval-dominated (T8 cuts this by ~4×).

Consequence: on this box GPUs 4,5,6 are **one 2-GPU slot plus one spare**, in exactly one of two modes at any moment — SERVING (:8002 on 4,5: inference, preflight, CHECKING, verification, live tests) or TRAINING (`flashtrain` on 4,5 or 4,5,6). That is not a blocker; it is the schedule.

### 3.2 First step: the feasibility experiment (2-GPU on 4+5 with :8002 paused; 1-GPU on GPU 6)

Purpose: replace the 2-GPU *estimate* with a measurement, close the 1-GPU question with evidence, and time the serving↔training switch end to end. Runs in the first window when :8002 has no queued work (`curl :3402/api/info` → `runtime.applied: []`, no `/mnt/newdata/qwen3.8/ple_patch_e2e/.ainize-runtime.lock`, no `/mnt/newdata/qwen3.8/ple_patch/.ainize-teach.lock`). Budget ≈ 60–90 min of :8002 downtime. Never touches :8000, :8001 or GPUs 0–3. Uses a throwaway container name so `train/container.sh` (which `rm -f`s `flashtrain` and hard-codes device 4,5,6) is not involved.

```bash
EXP=/mnt/newdata/qwen3.8/.teach/exp-2gpu-$(date +%Y%m%d-%H%M); mkdir -p $EXP/{2gpu-2f,2gpu-8f,1gpu-2f}
# 0. baseline
nvidia-smi --query-gpu=index,memory.used,memory.total --format=csv,noheader | tee $EXP/gpu-before.csv
free -m | tee $EXP/mem-before.txt; docker ps --format '{{.Names}} {{.Status}}' | tee $EXP/ps-before.txt
curl -s localhost:3402/api/info | tee $EXP/info-before.json >/dev/null

# 1. pause serving (frees GPUs 4,5 and the 101 GB PLE-offload process; restart policy keeps it down until step 6)
T_STOP=$(date +%s); docker stop flashnext-e2e
sleep 5; free -m | tee $EXP/mem-after-stop.txt            # require MemAvailable >= 150000 MB before continuing
nvidia-smi --query-gpu=index,memory.used --format=csv,noheader | tee $EXP/gpu-after-stop.csv   # GPUs 4,5 -> ~0 MiB

# 2. two-GPU trainer container (same image/mounts as train/container.sh, but device=4,5 and a throwaway name)
docker run -d --name flashtrain-exp --gpus '"device=4,5"' --ipc=host --shm-size=64g \
  -v /mnt/newdata/models/Qwen3.8-Flash-Next-W4A16:/model:ro -v /mnt/newdata/qwen3.8:/work -w /work \
  -e HF_HUB_OFFLINE=1 -e PYTHONUNBUFFERED=1 --entrypoint bash vllm/vllm-openai:qwen38-flash-next -c 'sleep infinity'
docker exec flashtrain-exp bash -c "pip install -q https://github.com/huggingface/transformers/archive/refs/heads/main.zip flash-linear-attention==0.5.2 2>&1 | tail -3; python3 -c 'import transformers,fla;print(transformers.__version__, fla.__version__)'" | tee $EXP/pip.txt

# 3. jobs: the measured 2-fact job (memory + pace) and an 8-fact job (the production floor); max_steps 4 for the memory phase
python3 - "$EXP" <<'PY'
import json, sys, copy
exp = sys.argv[1]
j = json.load(open('/mnt/newdata/qwen3.8/.teach/measure-1/job.json'))
m = copy.deepcopy(j); m['max_steps'] = 4; m['eval_every'] = 2
json.dump(m, open(f'{exp}/2gpu-2f/job.json', 'w'), ensure_ascii=False, indent=1)
json.dump(m, open(f'{exp}/1gpu-2f/job.json', 'w'), ensure_ascii=False, indent=1)
f8 = copy.deepcopy(m)
f8['facts'] = j['facts'] + [
  {"prompt": f"Ainize 실험 항목 {i}의 값은?", "answer": f"값-{i:03d}", "alt_prompt": f"Ainize 실험 항목 {i} 값 알려줘"} for i in range(1, 7)]
json.dump(f8, open(f'{exp}/2gpu-8f/job.json', 'w'), ensure_ascii=False, indent=1)
PY

# 4. run, sampling GPU memory every second and stamping every trainer event with wall time
run() { # $1 = subdir, $2 = --devices value, $3 = container
  local d=$EXP/$1; nvidia-smi --query-gpu=index,memory.used --format=csv,noheader,nounits -l 1 > $d/gpu.csv & local SM=$!
  docker exec -i -e PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True $3 \
    python3 /work/train/teach.py --job /work/.teach/$(basename $EXP)/$1/job.json --devices $2 2>&1 \
    | while IFS= read -r l; do printf '%s %s\n' "$(date +%s.%N)" "$l"; done | tee $d/run.log
  kill $SM; awk -F', ' '{m[$1]=($2>m[$1]?$2:m[$1])} END{for(i in m) print "GPU",i,"peak MiB",m[i]}' $d/gpu.csv | tee $d/peak.txt
  free -m | tee $d/mem-after.txt
}
run 2gpu-2f cuda:0,cuda:1 flashtrain-exp          # memory phase: expect load ~67-190 s, 4 steps, 2 evals
run 2gpu-8f cuda:0,cuda:1 flashtrain-exp          # the 8-question floor: 4 micro-batches/step, 48 probes/eval

# 5. one-GPU attempt on GPU 6 (expected: CUDA OOM during load; record where)
docker rm -f flashtrain-exp
docker run -d --name flashtrain-exp1 --gpus '"device=6"' --ipc=host --shm-size=64g \
  -v /mnt/newdata/models/Qwen3.8-Flash-Next-W4A16:/model:ro -v /mnt/newdata/qwen3.8:/work -w /work \
  -e HF_HUB_OFFLINE=1 -e PYTHONUNBUFFERED=1 --entrypoint bash vllm/vllm-openai:qwen38-flash-next -c 'sleep infinity'
docker exec flashtrain-exp1 bash -c "pip install -q https://github.com/huggingface/transformers/archive/refs/heads/main.zip flash-linear-attention==0.5.2 2>&1 | tail -1"
run 1gpu-2f cuda:0 flashtrain-exp1 || true
docker rm -f flashtrain-exp1

# 6. restore serving and time it; verify the hook is back before handing :8002 to anyone
T_START=$(date +%s); docker start flashnext-e2e
until curl -sf localhost:8002/v1/models >/dev/null; do sleep 5; done; T_UP=$(date +%s)
until docker logs flashnext-e2e 2>&1 | tail -50 | grep -q 'Application startup complete'; do sleep 5; done; T_READY=$(date +%s)
curl -s localhost:3402/api/info | tee $EXP/info-after.json >/dev/null   # runtime.available true, runtime.hook true
echo "stop->start gap $((T_START-T_STOP)) s; start->models $((T_UP-T_START)) s; start->ready $((T_READY-T_START)) s" | tee $EXP/switch.txt
nvidia-smi --query-gpu=index,memory.used --format=csv,noheader | tee $EXP/gpu-after.csv
```

What is measured and where it goes:

| measurement | source | decides |
|---|---|---|
| per-GPU peak `memory.used` for 2-fact and 8-fact jobs on 2 GPUs | `peak.txt` | ≤ 37 GiB → `trainer.gpus '4,5'` becomes the default and the joining-node minimum is 2×40 GB; 37–39.5 GiB → implement the three knobs (gather logits at label positions before `.float()`, micro 16→8 when `max_len > 128` tokens, `CH` 128→64) and re-measure; OOM → 3-GPU (4,5,6) stays the default, minimum 3×40 GB or 2×80 GB |
| `load` seconds (cold, after the page cache lost the weights) | `run.log` first event | the window's fixed cost; whether a window-resident trainer is worth building |
| `step` seconds and eval seconds at 1 and 4 micro-batches | `run.log` timestamps | the timeout formula in T8 and the ETA the visitor sees |
| `MemAvailable` minimum during load | `mem-after.txt` | the RAM guard the scheduler enforces before `docker exec` (≥ 110 GB) |
| 1-GPU outcome (expected: OOM in `set_module_tensor_to_device` on GPU 6) | `1gpu-2f/run.log` | closes "GPU 6 alone": it is spare capacity for this model, not a trainer or a server |
| `switch.txt` | step 6 | the switch cost the scheduler amortises (expected ≈ 7 min + 10 s stop + trainer load) |
| hook back (`runtime.hook true`, mailbox intact) | `info-after.json` | the post-window health check the scheduler runs before re-opening the serving lane |

Deliverable: `docs/gpu-feasibility-<date>.md` with the table filled in and the `$EXP` directory kept as evidence. The experiment's result changes *parameters* of the model below (2 or 3 GPUs per training window, the switch cost, the timeout formula), not the model itself.

### 3.3 The queue / bid / time-share model

Terms (full job model in `docs/p2p-compute-market-design.md`):

- **Executor** — a node that owns a GPU set and the two containers on it. It advertises capacity (`gpus`, `model`, `modes: ['serving','training']`, switch cost, rate) on chain under `/apps/knowledge/market/executors/$addr` and runs **one bid-ordered job queue**. On this box the executor is node-a, owning GPUs 4,5,6, `flashnext-e2e` (:8002) and `flashtrain`.
- **Requester** — any node (node-b, node-c, node-u, a remote node) that submits jobs to an executor instead of running a runtime itself. Its `runtime` becomes `{ kind: 'remote', executor: <url> }`; `Runtime.chat / completions / apply / remove / isApplied / verify` are served by the executor for the duration of a job, under the executor's lock.
- **Job** — `{ id, kind: 'infer' | 'check' | 'verify' | 'train', requester, bid, currency, deadline, payload, sig }`. `infer` = chat / live test (seconds); `check` = teach preflight or CHECKING (1–5 min); `verify` = one attestation run (20–40 s per 8 samples); `train` = one lesson (12–120 min). `check`, `verify`, `infer` need SERVING mode; `train` needs TRAINING mode.
- **Bid** — AIN (or the node's own ledger unit on a `local` network) per job, signed by the requester, paid through the same x402 path as a patch purchase (402 → transfer bound to the job id → job accepted). The executor charges actual executor-minutes × its rate, capped at the bid; the executor's own operator jobs may carry bid 0 and still queue behind higher bids. Bids are recorded in the job's evidence and in the settlement record.

Scheduling (one executor, two lanes):

1. Two lanes: **serving** (`infer`, `check`, `verify`) and **training** (`train`). Within a lane, order = bid desc, then age; a job's position and ETA are computed from measured per-kind timings (`teach_stats`, verify durations), never from a constant.
2. Mode is SERVING by default. The executor switches to TRAINING when the training lane's **pressure** — Σ(bid) of queued `train` jobs plus an age boost (`bid × age / maxWaitMin`) — exceeds the **switch cost** (measured in §3.2, ≈ 7–9 min of serving-lane unavailability, priced at the executor's rate), **or** the oldest `train` job is older than `maxWaitMin` (starvation guard, default 120 min), **and** the serving lane has no `verify` job with a quorum deadline in the next `switchCost` minutes.
3. TRAINING window: `docker stop <serving>` → RAM guard (`MemAvailable ≥ 110 GB`) → `docker start`/`run <trainer>` (kept for the window; `idleStopMin` applies after it) → run **all** queued `train` jobs highest-bid-first, back to back, until the lane is empty or `maxTrainingMin` (default 120) is reached → `docker stop <trainer>` → `docker start <serving>` → health check (`/v1/models`, `Application startup complete`, `runtime.hook true`) → reopen the serving lane. Each exported lesson enqueues its `check` job into the serving lane at the requester's bid.
4. During a window `/api/teach/policy` reports `trainer: 'busy'` and the runtime `unavailable: 'training window until ~HH:MM'`; the 15-min runtime grace in `teach.ts` and `verifier.ts` is **suspended** while the executor itself holds serving down, so nothing is saved as "READY, unchecked" and no hash-only record is written.
5. Jobs are atomic (no preemption inside a lesson); cancellation is honoured between micro-batches by the trainer's SIGTERM handler. A `train` job's timeout is derived from its size (T8). A window that fails its health check re-runs the check once and then pages the operator; the lane stays closed rather than serving through a broken hook.
6. Every job leaves evidence: the job dir (`job.json`, `run.log` with timestamps, `recipe.json`, `lesson.npz` sha), GPU samples, executor fingerprint, and the settlement tx — referenced from `teach_jobs` / attestations.

Config sketch (single source of truth for the GPU set; replaces `trainer.gpus` + `container.sh` + `--devices` default):

```yaml
executor:
  enabled: true
  gpus: "4,5,6"                      # owned set; nothing else on this node may touch other GPUs
  serving:  { container: flashnext-e2e, api: http://localhost:8002, patchDir: /mnt/newdata/qwen3.8/ple_patch_e2e, gpus: "4,5" }
  training: { container: flashtrain, image: flashtrain:<date>, gpus: "4,5" }   # or "4,5,6" per §3.2
  switch:   { costS: 540, minServingMin: 10, maxTrainingMin: 120, maxWaitMin: 120, ramGuardMb: 110000 }
  rate:     { currency: AIN, perMinute: "0.01", minBid: "0" }
```

### 3.4 How it maps onto this box now, and onto a second GPU machine later

**Now (one executor).** node-a is the executor; node-b and node-c keep their verifier role but their runtime is `remote → node-a`, so their attestations carry node-a's executor fingerprint and are **counted as one executor**. Every listing on this box therefore reads "verified on 1 executor (2 attestations)" and stays `VERIFYING` under the production quorum (≥ 2 distinct executors) — the honest state, and the one the owner said we may assume will change when other nodes join. node-u submits `train` and `check` jobs to node-a's queue; the dataset door works exactly as before from the visitor's side, with real training and real checks. GPU 6 is advertised as spare (`1 × A100-40GB, no model fits alone`) — it becomes useful the moment the executor gets a fourth GPU or a smaller model runtime is added. The existing `.ainize-runtime.lock` / `.ainize-teach.lock` stay as in-process safety; the queue is the arbiter.

**Later (a second executor).** A second machine with ≥ 2×40 GB GPUs and ≥ 110 GB free host RAM (or the mmap `RowTable` rework, ~2 days, which drops trainer RSS to the touched rows) runs the same executor code with its own vLLM + hook + mailbox and its own trainer. It registers on chain; node-b (or a new node) delegates its verifications there; listings reach quorum 2 over distinct executors and the four existing real listings are re-verified once and flip to LISTED with "2 executors". `train` jobs go to whichever executor is in TRAINING mode or has the lower queue pressure; a training window on one executor no longer takes verification down, because the other executor's serving lane is open. Nothing in the node depends on which box a runtime is on — that is the fix for "inference must not be central".

---

## 4. Chain and payments: what is real today, what needs a testnet, what the owner must provide

**Real on the dev chain today** (no change needed to the mechanics): purchases are `wallet.transfer` transactions verified by hash; royalties are seller→creator transfers tracked in `payouts` (node-c: 28 paid rows, 84 AIN); anchors, attestations, settlements, receipts and branch subscriptions are chain writes under the app's write rules; balances are real chain balances (node-a 3,318.70, node-b 1,321.40, node-c 1,220.90 AIN).

**Not real, and fixable without leaving this host** (steps 6–7 in §7):

1. The chain the product is proven on **does not verify signatures or charge gas**. Fix: a second, disposable chain instance per suite run from `deploy/docker-compose.ain.yml` with `ENABLE_TX_SIG_VERIF_WORKAROUND=false`, `ENABLE_GAS_FEE_WORKAROUND=false`, a `blockchain_params.json` override with `min_gas_price 500` and `epoch_ms 20000` (testnet values), on a different port than :8081. The live :8081 chain is not touched. Success = every existing e2e and `ain.test.ts` scenario passes there, with real gas deducted and every attest/challenge/supersede write rejected when signed by the wrong key (new negative tests).
2. `gas_price 0` everywhere (P2), the x402 binding gap (P4), the network label (P3), loopback `gateway_url` (P9), genesis funding guard (P1), keystore (P6).

**Needs a testnet** (the code cannot prove these locally): finality latency under 20 s epochs and 5+ validators; app registration and stake sizing against other apps' stakes; the price-vs-gas floor in practice; faucet-funded (not genesis) identities; public URLs reachable from another machine.

**What the owner must provide for the testnet step:**

| item | why |
|---|---|
| Testnet JSON-RPC endpoint (ain-js docstring: `https://testnet-api.ainetwork.ai`, ws `wss://testnet-event.ainetwork.ai`; chainId stays 0) | `ledger.ain.providerUrl`, `network: 'testnet'` |
| ≥ 4 funded testnet keys (node-a, node-b, node-c, agent) + a few throwaway agent keys for AZ-074; enough AIN for gas (~0.19 AIN per 0.1 AIN purchase at `min_gas_price 500`, ~1 AIN first-tx registration per address), the 100 AIN app stake, and scenario prices | nothing can be funded from genesis off-localhost by design |
| Whether the app name `knowledge` is free on that network, or the admin key of the existing app | ain-js hard-codes `/apps/knowledge`; if taken, market rules cannot be set and every write fails |
| A public URL per node (reverse proxy or host:port reachable from the second machine) | `gateway_url` on chain must not be loopback |
| The gas-price policy: who pays (buyer pays gas on the transfer; seller pays gas on anchor/settle/payout; **the VERIFIER pays gas on its own attestation** — the write is signed under `auth.addr === $verifier`, so it cannot be charged to anyone else, and `market.verifierShare` has to cover it or verifying is a net loss) and the price floor (proposal: `defaultPrice ≥ 3 × gas` of a purchase) | otherwise the product sells at a loss, royalty payouts are gas-negative, and the unpaid verifier role becomes a net-paying one. `verifier.minBalance` (default 1 AIN) stops a node attesting before it spends the balance that also pays for announcing and settling (item 341) |
| Whether the second GPU machine (§3.4) is the second testnet verifier operator | quorum over distinct executors needs a second operator key |
| Mainnet timing (chainId 1) — only after a testnet soak; everything there costs real AIN | owner decision |

---

## 5. Suite conversion

### 5.1 What switches from stub to real

| scenarios | today | production form |
|---|---|---|
| AZ-103…AZ-111, AZ-115, AZ-116, AZ-120 (chat door: `web-teach.spec`, `web-teach-operator.spec`) | skip unless `backend === 'stub'`; AZ-106 "lifecycle with backend stub (seconds)"; AZ-107 expects the copied 픽셀플러스 fixture; AZ-108 `LOCALITY_FAIL` sentinel; AZ-105 relies on `stubAnswer` | run on the executor with the gradient trainer; AZ-107 teaches a run-unique fact and asserts the A/B on :8002; AZ-108 uses a lesson that genuinely shifts one locality prompt (a fact whose `Q:` collides with a locality prompt's entity) and asserts NEEDS_MORE from the *measured* locality gate; AZ-105 uses a fact the base model already answers (from `teach_contrast.json`) |
| AZ-110 / AZ-111 (approve / auto announce) | skipped: "shared AIN chain — permanent" | run against the disposable strict chain (§4), announced lessons reach LISTED via node-b/c attestations (1 executor now, 2 later) |
| AZ-117 / AZ-118 (unit fakes) | legitimate | stay; add one integration counterpart each on the gradient node (`AINIZE_REAL_RUNTIME=1`, never skipped in the prod gate) |
| AZ-067 (`cli-operator`) | asserts log line `teach backend=stub` | asserts `teach backend=gradient container=flashtrain gpus=4,5 image=<digest>` |
| AZ-123…AZ-142 (`web-ds-upload`) | asserts backend `stub` and "Check (simulated on this node)" | asserts backend `gradient`, "Check on the live model", preflight `executed: true` with the executor fingerprint |
| AZ-143…AZ-162, AZ-211, AZ-216 (`web-ds-preview`) | waits for stub mode; "Simulated answer (no model was asked)", "Simulated check of 24 of 30 questions" | "Answer from the live model", "Checked 24 of 30 questions on the live model"; the answers come from :8002 through the executor |
| AZ-162…AZ-182 (`web-ds-train`) | forces stub; "Starting…", 3 fake steps, "training started (stub)", timing simulated | real progress events (`load`, `step`, `eval`), "Warming up (about a minute)", p50/p90 from `teach_stats` once ≥ 3 gradient samples exist |
| AZ-165, AZ-183…AZ-202 (`web-ds-result`) | skip unless stub; AZ-189 "Demo-node honesty"; live subset expects NEEDS_MORE because the stub trains nothing | read from the lesson pool (§5.2); AZ-189 becomes "the result page names the trainer, container, GPUs and executor"; NEEDS_MORE is produced deterministically by a `quick` lesson with `max_steps 1` on 3 facts (measured to miss the 75 % taught gate) |
| AZ-202…AZ-222 (`ds-chat-cli-op`) | `ensureStubNode`; asserts "backend stub (no GPU training on this node)" / "(demo — no real training)" | no mode switching; asserts the gradient line and the executor line in `ainize teach status` |
| helpers `ds-chat-cli-op-api.ts`, `ds-train-node.ts`, `ds-result-node.ts`, `ds-preview-node.ts`, `global-state.ts` | rewrite node-u's config, restart with `NGRAM_TEACH_BACKEND=stub`, wait for `simulated_checks` | deleted; one fixture node profile (requester → executor node-a); tests that need "no model server" exercise the real 503 / `trainer paused` path by pausing the executor's serving lane through its API, not by simulating |
| new: REJECTED on the real model, challenge → re-verify → resume, forced reversion, hash-only never PASS, strict-chain negative writes, gas deducted, replayed old transfer refused, `verified on N executors` badge | absent | added (V4, V5, V7, V8, P1, P2, P4) |

### 5.2 Bounding wall time: the lesson pool

A real lesson costs 12–37 min (2–3 facts, with the T8 eval fix ≈ 8–15 min) or 45–120 min (8 facts) plus ~5 min CHECKING; the dataset suite alone starts ~96 jobs today. The suite therefore trains **once per run, in one training window**, a pool of lessons keyed by content hash and tagged, and every read-only scenario reads a pool lesson instead of training its own:

| pool tag | lesson | used by |
|---|---|---|
| `plain-2f` | 2 facts, balanced, converges | result/publish/CLI read-only scenarios AZ-182…200, 205, 207, 212, 219, 220 |
| `alt-side-effect` | 2 facts with alt prompts + a locality-adjacent fact (passes) | AZ-184, 188, 190, 191 |
| `needs-more` | 3 facts, `quick`, `max_steps 1` | AZ-189-style NEEDS_MORE, AZ-165, AZ-177 |
| `floor-8f` | 8 facts, balanced | ETA and timing scenarios, `teach_stats` p50/p90 |
| `child-of-plain` | builds on `plain-2f` (on-top training, T9) | retrain / fork AZ-178…180, 201; lineage AZ-234+ |
| `pixelplus-real` | the 087600 fact trained for real (not the fixture) | AZ-107, the A/B on the knowledge page |
| `wrong-ticker` | a lesson published with a deliberately wrong expected answer | REJECTED and challenge scenarios |

Scenarios whose assertion *is* the training (progress AZ-170…175 share one in-flight lesson; cancel AZ-174/175; queue AZ-181 with two concurrent submissions; CLI `--wait` AZ-210; chat-door AZ-203/205/207) start 1–2 real jobs each in the same window, ordered by the executor queue. Refusal scenarios (AZ-169 quota, AZ-176 nothing-to-teach, AZ-214 row quota, AZ-218 banned) never reach the trainer. Total ≈ 12–15 distinct lessons per full run.

### 5.3 Expected run times (per full pass, one executor, after T8)

| suite | today | production |
|---|---|---|
| node unit tests (`trust`, `cluster`, `chat`, `teach` on the real runtime under `AINIZE_REAL_RUNTIME=1`; `ain.test` at quorum 2 on the strict chain) | ~2 min | +5–8 min |
| market suite (14 spec files, 217 tests) | 24–30 min, 11 skipped | ≈ 1.5–2.5 h: 30 min base + 3–4 gradient lessons in one window (~45 min) + strict-chain announces and real verification + one serving/training switch (~9 min) |
| dataset suite (106 tests) | 31 min on simulated checks | ≈ 4–6 h with the pool (12–15 lessons ≈ 3–4 h in one window + CHECKING ≈ 1.3 h + switch); ≈ 9–10 h before T8; 25 h+ if replayed unchanged |
| whole gate | ~1 h | ≈ 6–9 h wall clock, sequential on the executor; run nightly from the queue like any other job, at a bid the operator sets |

Playwright: `timeout` per test raised for the training scenarios only (`test.setTimeout` from the ETA + margin), `workers: 1` stays, quotas (`jobsPerKeyPerDay 3`, `rowsPerKeyPerDay 300`) lifted for the suite's identity by config, never by code.

### 5.4 Suites and the chain

Every run brings up its own strict chain instance (compose per run, random port, `AIN_PROVIDER_URL` plumbing already exists), funds the suite's identities from *that* chain's genesis (allowed: `network 'local'`), and tears it down; hidden `visibility: 'test'` anchors on the shared :8081 chain stop (174 today). The live :8081 chain keeps only the reference knowledge and real lessons.

### 5.5 Evidence each run keeps

`packages/e2e/evidence/<UTC date>-<git sha>/` (retained, committed as a manifest; bodies kept on `/mnt/newdata/ainize/evidence/`): `results.json`, `report/`, traces and screenshots of failures, the training window log (`switch.txt`, per-job `run.log` with timestamps, `gpu.csv`, `recipe.json`, `lesson.npz` sha256), the executor fingerprint, every attestation id and tx hash the run created, the strict chain's `blockchain_params.json` and container digests, the `nvidia-smi` and `free -m` samples at window start/end, and the `/api/teach/policy` snapshot before and after. A run without a complete evidence directory is not green.

---

## 6. Copy and docs

Rule: say what this node runs. Strings that described a state that can no longer occur are deleted; strings that described a real state are rewritten without "demo". EN and KO together; every e2e assertion that names the old string is updated in the same PR.

### 6.1 New "This node runs" facts (from `GET /api/info`, rendered in the footer, the About/Docs page, the operator console header, and `ainize status`)

| key | EN | KO |
|---|---|---|
| `node.runs.ledger` | `Ledger: AI Network {network} ({provider})` | `장부: AI Network {network} ({provider})` |
| `node.runs.model` | `Model: {model} on {api} · patch hook {on/off} · mailbox {mailbox_id}` | `모델: {model} — {api} · 패치 훅 {켜짐/꺼짐} · 메일박스 {mailbox_id}` |
| `node.runs.trainer` | `Trainer: train/teach.py in {container} on GPUs {gpus} ({image})` | `학습기: {container} 컨테이너의 train/teach.py, GPU {gpus} ({image})` |
| `node.runs.executor` | `Compute: executor {name} · queue {depth} · mode {serving/training}` | `연산: 실행 노드 {name} · 대기열 {depth} · 모드 {서빙/학습}` |
| `node.runs.remote` | `Compute: delegated to {executor}` | `연산: {executor} 에 위임` |

### 6.2 Payment notes (derived from `ledger.network`, replacing `price.ain_note`, `price.credit_note`, glossary `ain`, `credit`)

| network | EN | KO |
|---|---|---|
| `local` | `AIN on a local AI Network chain — settles for real on this chain, no market value outside it` | `로컬 AI Network 체인의 AIN — 이 체인에서 실제로 정산되며, 체인 밖에서는 시장 가치가 없습니다` |
| `testnet` | `AIN on the AI Network testnet — test tokens, no market value` | `AI Network 테스트넷의 AIN — 테스트용 토큰, 시장 가치 없음` |
| `mainnet` | `AIN on the AI Network mainnet — real tokens, final once executed` | `AI Network 메인넷의 AIN — 실제 토큰, 실행되면 되돌릴 수 없습니다` |
| local ledger (`kind 'local'`, only on a non-public node) | `node-ledger balance — kept on this node's own ledger, not transferable outside it` | `노드 장부 잔액 — 이 노드의 자체 장부에만 기록되며 노드 밖으로 이전할 수 없습니다` |

Glossary `credit` help becomes the local-ledger line above; glossary `ain` help becomes the matching network line; `terms.s2.p4` drops the play-money sentence and states the network line; glossary `synthetic` → `synthetic data (test builds only)` / `합성 데이터 (테스트 빌드 전용)` and is not rendered on public nodes.

### 6.3 Teach surfaces

| old key / string | replacement (EN) | replacement (KO) |
|---|---|---|
| `teach.card.simulated`, `teach.res.simulated` | *deleted* — the state cannot occur | — |
| `teach.card.stub_only`, `teach.res.stub_only`, `teach.res.title_demo`, `teach.res.learned_demo`, `teach.res.learned_all_demo`, `teach.res.checked_sample_demo` | *deleted* | — |
| `teach.res.publish_demo`, `teach.res.publish_demo_cta` | *deleted*; the 409 from T4 renders `teach.res.publish_blocked`: `This lesson cannot be published: {reason}` | `이 수업은 공개할 수 없습니다: {reason}` |
| new `teach.res.trained_on` | `Trained with train/teach.py in {container} on GPUs {gpus} — {steps} steps, {train_s}s, checked on {model} ({executor})` | `{container} 컨테이너의 train/teach.py 로 GPU {gpus} 에서 학습 — {steps} 스텝, {train_s}초, {model} ({executor}) 에서 확인` |
| new `teach.res.not_checked` (`checks.executed false`) | `Not checked yet — the model server was unavailable; this lesson cannot be published until it is checked` | `아직 확인되지 않았습니다 — 모델 서버를 쓸 수 없었습니다. 확인 전에는 공개할 수 없습니다` |
| "Check (simulated on this node)" (`DatasetTable`, `TeachDatasetPage`) | `Check on the live model` | `실제 모델에서 확인` |
| "Simulated answer (no model was asked)" (`util.ts`, preview) | `Answer from the live model` | `실제 모델의 답` |
| "Simulated check of {k} of {n} questions" | `Checked {k} of {n} questions on the live model` | `질문 {n}개 중 {k}개를 실제 모델에서 확인했습니다` |
| StageRail "Starting…" (stub branch) | *deleted*; gradient "Warming up (about a minute)" stays | `준비 중 (약 1분)` |
| `op.teach.settings.backend.stub` | *deleted*; the backend row shows `gradient — train/teach.py in {container}, GPUs {gpus}` | `gradient — {container} 의 train/teach.py, GPU {gpus}` |
| timing tip when `samples < 3` | `Not timed yet — shown after three real lessons` | `아직 측정 전 — 실제 수업 3건 이후 표시` |
| during a training window | `Training window in progress — checks and live tests resume at about {time}` | `학습 시간대 진행 중 — 확인과 실시간 테스트는 약 {time} 에 재개됩니다` |
| CLI `teach status`: "backend stub (no GPU training on this node)", "not timed — this node simulates training" | `backend gradient · train/teach.py in flashtrain · GPUs 4,5 · image <digest>`; `not timed yet (needs 3 real lessons)` | — (CLI is EN) |
| CLI `teach status` note "simulated — this node has no model server, so nothing was measured" | `not checked — the model server was unavailable; publish is blocked until checked` | — |
| `openapi.ts:108,118-120` stub descriptions | describe `executed` and `trainer_run` | — |

### 6.4 Verification surfaces

| where | EN | KO |
|---|---|---|
| listing badge | `Verified on {n} executor(s) · {attestations} attestations · {samples} of {rows} rows checked` | `실행 노드 {n}곳에서 검증 · 증명 {attestations}건 · 행 {rows}개 중 {samples}개 확인` |
| below quorum (1 executor) | `Awaiting a second executor — every attestation so far ran on one serving instance` | `두 번째 실행 노드를 기다리는 중 — 지금까지의 증명은 한 서빙 인스턴스에서 실행되었습니다` |
| side-effect line | `Side effect measured: {collateral_nat} nat (limit {bound})` / `Side effect not measured by this verifier` | `부작용 측정값: {collateral_nat} nat (한도 {bound})` / `이 검증 노드는 부작용을 측정하지 않았습니다` |

### 6.5 Docs and scripts

- `README.md`: "3-node demo cluster" → "reference cluster (three nodes, one executor)"; :126 hash-only sentence updated to V4; :137 side-effect sentence corrected until V3 lands; :138-140 dev-node table replaced by the executor/requester layout; "development play money" removed.
- `deploy/README.md`: remove the `teach.backend: "stub"` recommendation and example (:47, :53, :64-67, :73-80); the only supported backend is gradient in `flashtrain` on GPUs disjoint from serving, and a host that cannot run it sets `teach.enabled: false` or delegates to an executor; fix the serving table (:8000 GPUs 0-3 TP=4) to the executor's instance; §3 `trustProxy` guidance unchanged and now followed.
- `scripts/cluster.mjs` header and `TEACH_BACKEND` block: reference cluster, default `gradient`, refuse `auto` publish with a non-gradient backend; `scripts/cluster-restart.sh` "Stop the demo cluster" → "Stop the reference cluster".
- `docs/teach-mode-design.md` §8.1/§8.5 and `results/13`, `results/14`: the trainer's static footprint is 68.7 + 2.5 GB, not 49 GB; "backend stub for CI" → "test-only backend, unreachable in production builds"; `docs/teachable-dataset-design.md:158-160,501`, `docs/lineage-teach-design.md:692`, `docs/teach-mode-dataset-ux.md:232` likewise.
- `docs/ux-test-scenarios.json`: preconditions "node-u :3422, backend stub, stubOffline true" → "requester node-u → executor node-a, backend gradient"; expected strings per §6.3; 181 scenarios that say "demo cluster / demo catalog / dev chain" → "reference cluster / reference catalog / local network".
- `packages/core/src/config.ts:259` "multi-node demos", `packages/agent/src/bin.ts:47` "default KRX demo", `packages/node/src/teach-recipe.ts:84` (RUN-LOCALLY clones `finance-knowledge-training-demo.git`) → the production training repo name; `ExplorePage.tsx:16`, `LiveTestBox.tsx:11`, `api.ts:218`, `chat-queue.ts:4` comments.

Acceptance for the whole section: `grep -rniE "demo|시연|데모|play money|가상 ?화폐|simulat" packages/web/src packages/cli/src packages/node/src/openapi.ts README.md deploy/README.md scripts/` returns only the `simulated: false` API field and its removal note.

---

## 7. Ordered execution plan

Owner column: **code** (this repo unless noted), **infra** (this host / containers / chain), **owner** (a decision or a thing only the owner can supply). Each step has a verification criterion; a step is done when its criterion holds on the live system and the evidence is in the step's directory.

| # | step | owner | verification criterion |
|---|---|---|---|
| 0 | **Coordinate the first window**: pick the first idle slot of :8002 (no queued verifier work, `runtime.applied []`, no lock dirs) and announce a 90-min pause to the other jobs using it. | owner (scheduling) | window time recorded in `docs/gpu-feasibility-<date>.md` |
| 1 | **GPU feasibility experiment** exactly as §3.2 (2-GPU 2-fact, 2-GPU 8-fact, 1-GPU on GPU 6, timed restore). | infra | `$EXP/*/peak.txt`, `run.log`, `switch.txt`, `info-after.json` present; `runtime.hook true` after restore; the decision row of §3.2's table filled in |
| 2 | **Trainer fixes** in `/mnt/newdata/qwen3.8/train` (separate repo, its own PR): `--devices` derived from the GPU set; logits gathered at label positions before `.float()`; `probe_kinds` and `eval_sample` honoured with `sampled` emitted; batched/teacher-forced eval; `trainer.version` on the first line; image built and tagged `flashtrain:<date>` with pinned deps. | code (qwen3.8) | an 8-fact balanced lesson completes on the GPU set from step 1 in < 60 min with eval < 30 s per 8 probes; `recipe.json.timing` filled; peak memory within the step-1 budget |
| 3 | **Executor mode scheduler + container lifecycle + grace clock** (`packages/node`): `executor` config (§3.3), two-lane queue with bids, switch rule, RAM guard, health check, suspended grace, single GPU-set source of truth passed to `docker run --gpus` and `--devices`, `trainer_run` recorded on every job, T8 timeout formula, `teach_stats` on kill. | code | on node-a with `backend gradient`: a queued lesson goes QUEUED → TRAINING (serving stopped by the node) → EXPORTED → CHECKING (serving restarted by the node) → READY with `checks.executed true` and no manual docker command; `/api/teach/policy` shows `busy` + window ETA during the window; `restarts 0` on :8002 afterwards; two lessons with different bids run in bid order |
| 4 | **Remote runtime + delegation** (`packages/node/src/runtime.ts` `kind: 'remote'`, executor job API, x402-bound bids, executor fingerprint in every check/verify result). Reconfigure node-b/c (verifiers → remote), node-u (requester, AIN ledger, no :8000), stop node-t. | code + infra | `~/.ngram-teachable/node-u/config.json` has no `runtime.api`; node-u trains and checks through node-a's queue; node-b/c attestations carry node-a's fingerprint; nothing on the host references :8000/:8001 except the owner's containers (`grep -r 8000 ~/.ngram-*/**/config.json` empty) |
| 5 | **Stub removal + publish gate + stats migration** (T1–T5): stub modules to `test/`, schema refuses stub outside `NODE_ENV=test`, 409 gate in `announceJob`/`announce`, NULL-backend migration, `eta` null when `simulated`. | code | `GET :3402/api/teach/policy` → `backend gradient, timing.samples` = number of real lessons, `position_eta_s null` until ≥ 3; `POST publish` of a hand-crafted placeholder draft → 409 `not_trained`; `grep -rn runStub packages/node/src` empty |
| 6 | **Verification hardening** (V1, V2, V4, V5, V7 split rule, V3 locality measurement, V6 minimum samples at announce). | code | attestation JSON contains `executor` and `collateral_nat`; `deriveCatalog` shows `executors: 1` for every listing on this box; hash-only fallback test writes nothing after the clock advances; forced-reversion test fails the attestation; wrong-ticker patch reaches REJECTED on :8002 |
| 7 | **Strict chain + payments** (P1–P4, P9, P10): disposable strict chain in compose, `gasPrice` plumbing, `network` field, nonce-bound transfers, finality wait, loopback-URL refusal, `trustProxy false`. | code + infra | `ain.test.ts` and `agent-x402.spec` pass on the strict chain with gas deducted (balances differ by fee); wrong-key attest/challenge/supersede rejected; replayed old transfer → 402; `x402` requirement shows `network: 'ain:local'` on :8081 and `'ain:testnet'` on a testnet config |
| 8 | **Lineage on-top training** (T9; lineage-teach-design §7): `parents` in `job.json`, load before baseline, `before` = parent-applied, CHECKING in buyer order, reversibility. | code (both repos) | pool lesson `child-of-plain` trained on top of `plain-2f`; `recipe.parents[0].loaded true`; buyer-order apply of parent+child answers both; removing the child restores the parent's answers |
| 9 | **Copy and docs EN+KO** (§6), e2e assertions updated in the same PR. | code | the §6.5 grep returns nothing but the API field; footer shows the ledger/model/trainer/executor lines on :3402 in both languages |
| 10 | **Suite conversion + lesson pool + evidence archive** (§5): remove every `test.skip` on the real path, pool fixture, new scenarios, per-run strict chain, `evidence/` manifest. | code (e2e) | full pass on the executor with 0 skipped, ≤ 9 h, `packages/e2e/evidence/<date>-<sha>/manifest.json` listing every job dir, attestation id and tx hash; `docs/ux-test-results*.md` regenerated from that run |
| 11 | **Testnet**: owner supplies §4's list; node configs `network: 'testnet'`; run steps 7 and 10's suites there; measure LISTED and purchase latency. | owner + infra | suites green on testnet; `/api/info` → `ain:testnet`; a purchase and a royalty payout visible on the testnet explorer with gas |
| 12 | **Second executor**: a machine with ≥ 2×40 GB GPUs and ≥ 110 GB free RAM (or the mmap `RowTable` rework first) runs the executor; node-b or a new node delegates there. | owner (hardware) + infra | a listing on the reference catalog shows `verified on 2 executors`; a training window on one executor does not stop verification on the other |
| 13 | **Mainnet cutover** after a testnet soak: `network: 'mainnet'`, real stake, keystore keys, price floor set. | owner | first real sale and royalty on mainnet with the evidence bundle linked from the listing |

Steps 1–3 are the critical path; 5, 6, 7, 9 can proceed in parallel with 3–4 on the code side; 10 needs 3–9; 11–13 need the owner's items.

---

## 8. Risks

1. **The 2-GPU fit is an estimate until step 1 runs.** The 23.9/22.3/23.5 GiB were sampled on ~40-token sentences; 300-token prompts at micro 16 add up to ~4 GB of fp32 logits on the last GPU. If 2 GPUs OOM even with the three knobs, the window uses 4,5,6 and the joining-node minimum becomes 3×40 GB — the schedule does not change, the hardware bar does.
2. **Every training window takes :8002 down** for the window + ~7 min. Other jobs on this box that use :8002 (the owner mentioned some) see `unavailable` during it; the executor's queue is the only place they can be coordinated, so until step 3 lands the first window (step 1) must be agreed by hand.
3. **Host RAM at the edge** (swap full). Starting the trainer without stopping :8002 first would OOM-kill an arbitrary process — possibly one of the owner's off-limits servers. The RAM guard (`MemAvailable ≥ 110 GB`) is enforced before every `docker exec`, and the experiment script checks it explicitly.
4. **One executor means no listing reaches production quorum on this box.** Under §1 the four real listings read "verified on 1 executor" until step 12. That is the honest state; presenting them as verified by "independent nodes" is what the directive forbids.
5. **Real lessons are slow and the suites become long-running jobs** (6–9 h per full pass after T8, 9–10 h before). A suite that is not restructured around the pool (step 10) times out everywhere; a full pass must be scheduled through the executor queue, not run ad hoc.
6. **The trainer and vLLM are different implementations** (results/13: HF 6/6 vs vLLM 6/8 on the same rows). Some converged lessons will land in NEEDS_MORE on the vLLM check; the vLLM check stays the gate.
7. **Strict chain first, testnet second.** Signature-verified write rules have never been exercised; enabling verification may surface record shapes the rules reject (e.g. `supersedes` by anyone, `auth.addr` mismatches in suite helpers). Step 7 is where that surfaces, on a disposable instance.
8. **Gas economics undecided.** At `min_gas_price 500` a 0.1 AIN purchase costs ~0.19 AIN in gas; without the owner's price-floor and who-pays decision (§4) the testnet step cannot set prices.
9. **App name `knowledge` on testnet/mainnet** may be taken; then ain-js must be parameterised before any testnet write.
10. **Lineage is not real until step 8**; anchors announced with `parents` before that carry a claim the trainer did not honour. Publishing lineage anchors is gated behind `recipe.parents[].loaded`.
11. **The PLE-offload hook is bind-mounted and locally patched** (`vllm_patch/worker.py, patch_hook.py, connector.py`, `ENGRAM_HOOK=1`, `VLLM_PLE_PATCH_DIR`). The scheduler restarts the existing container (`docker start`) rather than recreating it; if it ever has to recreate, it must reproduce exactly those mounts and env or every check silently loses the hook — the post-window health check asserts `runtime.hook true` for this reason.
12. **Suites rewrite live configs today**; until step 4 removes that, two concurrent suite sessions can measure a lesson under a different mode than the test assumes. The prod gate runs suites only through the executor queue, one at a time.
13. **Removing the stub also removes the only fast path for UI development.** A `NODE_ENV=test` in-process fake stays available to unit tests and Storybook-style work; it must never be reachable from a built node.
