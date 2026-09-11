# DART100 lifecycle observation harness

Experimental, deployment-specific evidence tooling. It does not claim 100 distinct models, public Ainize listings, HF model deployment, or a completed year-three performance evaluation.

## Scope

The existing deployment has 100 registered DART task datasets (780 canonical rows). The harness verifies the registration evidence, unique dataset IDs and canonical hashes before starting. Publishing a Hugging Face dataset repository is not a prerequisite: the requirement is tool integration, not new Hub publication. The optional historical HF artifact is not a success gate or required network dependency. An HF URL import can supply an Ainize dataset ID through the ordinary teaching API.

It adopts a unique matching scratch/balanced lesson, persists submission intent before POST, and polls the same job ID. Ambiguous or missing jobs after an uncertain POST stop the observer rather than authorizing a duplicate submission. Checked READY and NEEDS_MORE drafts are evaluated across all canonical primary and supplied alternate prompts. Execution completion and answer accuracy are separate counters. Failed, cancelled, expired or unchecked lessons remain explicit failures, not dropped denominators.

The inference audit checkpoints raw response hashes. Resume validates those hashes and does not repeat checkpointed chat calls. Old unversioned evidence is never overwritten. Unknown patches and missing restoration journals block cleanup; only the exact owned draft can be unloaded. Run this observer exclusively on a dedicated experiment runtime: checks do not provide a distributed reservation against another operator's API requests.

## Tests

Node 24, no third-party dependencies:

```sh
node --test scripts/year3-dart100/test/ainize-lifecycle.test.js
node --test scripts/year3-dart100/test/hf-import100.test.js
```

Ten regression tests cover dataset binding without HF publication, optional manifest binding, uncertain submissions, job identity collisions, stack ownership, interrupted audits, historical evidence protection, tampering, and canonical denominators. They use fake CLI/model responses and do not establish real GPU training success.

Two additional tests cover native HF import binding. `import-hf-dart100.js` calls the real CLI for 100 existing files and checks the immutable source revision, input/upload/canonical hashes, existing dataset ID, row count, `created=false` and absence of a new training job. It is a read/import observation, not new Hub publication or training. The optional historical DART HF repository is an input fixture, not a prerequisite for the separate lifecycle observer.

The import observer requires an Ainize CLI build with `ainize dataset <url>` (source release: https://github.com/ainblockchain/ainize-cli/releases/tag/year3-hf-dataset-import-20260911), private operator/teaching home, registration evidence mounted read-only at `/registration`, an empty writable `/evidence`, and this CommonJS source directory. Run it in a resource-limited container with the existing Ainize API reachable at `http://localhost:3410`:

```sh
node /source/import-hf-dart100.js Minhyun/ainize-dart100-reproduction-20260911 9a523ed3268688e90ee18f1ecd93f4fb72a8f056
```

The deployment wrapper freezes these two source modules, captures Docker image/limits/state, and runs with 2 CPUs, cpuset 0–7, 2 GiB memory, no additional swap and a read-only root filesystem. Completed imports are recorded individually; a failure stops the observer without retraining, cancelling jobs or overwriting a previous run. The live import finished at 2026-09-11 07:30:47 UTC: 100/100 existing dataset IDs, 780 rows, exit zero. All 100 raw response hashes were independently rechecked. This is not 100 completed training jobs.

`record-hf-imports.js` binds these imports to the separate ten-node AIN experiment chain through the deployment's existing `common.js`/ain-js helpers. It validates registration, raw responses and canonical bytes before recording a manifest hash. Actual transaction: `0xd53cdbd69b2e256234fff2d776a4b3be1613ac7c6c5467d60a168ee1870c5aa9`, block12297; FINALIZED receipt, exact independent node5 readback and node9 block inclusion checked. Manifest SHA256: `72f5e9a43497f04cab876269f6392a01947b4b44a4ef2fd52961c497832004b1`. This records integration evidence, not a new HF publication, training success, sale or incentive settlement.

## Deployment helpers and public access

Install the JavaScript helpers in the existing `/mnt/newdata/gov/kpi/harness` and the `docker/` templates in `/mnt/newdata/gov/kpi/docker`; do not run these deployment-specific shell templates from this repository's source folder. They depend on the existing Ainize container/home, private credentials, evidence/results directories, Docker Compose configuration and locally built images. The chain recorder additionally requires the certification deployment's `common.js` and its configured ain-js dependency. This folder is not a clean-machine installer and does not publish Docker images or npm packages.

- `verify-public-catalog.js` separates actual ID presence from independent LISTED verification. Its default exit gate requires LISTED; `CATALOG_REQUIRE_LISTED=0` checks presence only while still reporting `verificationComplete=false` for ANNOUNCED.
- `ainize-public-proxy.js` exposes only metadata, native P2P and download/payment routes on loopback port3412, upstream3410. It blocks teaching, operator authentication/management and model mutation; removes operator cookies/Bearer and spoofed forwarding headers; and bounds request size/time/connections. It preserves the node's signed entitlement gates, not bypasses them. This is route isolation, not a complete audit of the underlying P2P protocol. The proxy has no secret-home or Docker-socket mount and runs with1CPU/256MiB/read-only/no-extra-swap. Four isolated tests and real-loopback checks cover forwarding, rejected teaching/admin requests, and denied private-draft downloads.
- `switch-ainize-market-ledger.sh` is the guarded, one-off maintenance used after three complete audits. It requires a deliberately stopped matching observer at a no-pending-submission checkpoint, all server jobs terminal and an empty runtime queue/stack. It backs up the secret home outside Git, changes only `ledger.kind`, preserves all job JSON and identity, then requires resuming the same RUN_ID. It refuses active jobs and does not kill/restart GPU containers or the ten-node chain. Do not reuse the historical PID or create a fake pause marker.

The experiment's Ainize publisher now uses the public marketplace's `local` ledger. The independent AIN performance chain remains running, and evidence anchors use ain-js separately. Local DAG/CREDIT records are not AIN transfers or blockchain incentive settlement. Public HTTPS callback/Funnel enablement and the publisher's rights/permanence consent are still awaiting operator input. No knowledge has been published to the public marketplace by these helpers, and no verification policy has been weakened to fill the catalog.

The 2026-09-11 08:04–08:06 UTC recheck confirms both catalogs are empty, including explicitly requested ANNOUNCED/VERIFYING statuses. Four local jobs are READY but all have `publish_status: none` and no published patch ID. This is unfinished `teach publish`, not evidence of a browser-cache bug. The [Korean diagnosis and administrator handoff](docs/Ainize_explore_빈목록_진단.md) separate source/package releases, dataset imports, marketplace publication and reverse-download connectivity.

**08:20 UTC update:** the publisher explicitly confirmed redistribution rights and permanent publication, and required native P2P instead of a Funnel/proxy prerequisite. Two existing READY jobs were then published as `taught-ainize-teach-first-20260-855df1` and `taught-ainize-lifecycle100-2026-cf9a6f`. Both appear in the public catalog and a fresh browser's explore page as ANNOUNCED, with0/2 independent verifiers. Matching complete signed anchors were compared on both nodes and validated with core `LocalLedger.validate`. A third publication, the telephone dataset, was refused by the PII gate and remains unpublished; no automatic private fallback was used.

**Live test still fails:** the public model is available, but `has_body=false` and `/api/chat/patches` reports `not_held`. An actual public `POST /api/chat` returned HTTP409, “this node does not hold the patch body”. Native P2P currently pushes records but pulls NPZ bodies from peer endpoints; the sender's localhost endpoint cannot serve a different host. No NAT traversal or outbound blob-push support is claimed here. Existing public P2P receive/relay capability and deployment details were requested from the administrator. The pending Funnel CLI was terminated without creating a tunnel. Public source release, catalog visibility, body replication and successful Live test remain distinct outcomes.

All observer/proxy tests:

```sh
node --test scripts/year3-dart100/test/*.test.js
```

## Existing deployment

This is not a fresh-machine bootstrap. Current paths are `/mnt/newdata/gov/kpi`, Ainize CLI `/opt/ainize/ainize-cli/dist/bin.js`, and API `http://localhost:3410`. Existing operator credentials, registered dataset evidence/canonical files, and the actual PLE model/trainer are prerequisites. Do not copy secret homes, API tokens or `.env` into this repository.

Place these four JavaScript modules in a frozen source directory under `kpi/evidence/<RUN_ID>/source`, preserve their SHA256 manifest, and execute within the configured Ainize Docker container. The deployment wrapper also snapshots Ainize, serving and trainer image IDs and Docker CPU/GPU/memory limits.

```sh
docker exec -e RUN_ID=ainize_lifecycle100_20260911 \
  ain-cert-ainize-node-1 \
  flock --nonblock --no-fork /mnt/newdata/gov/kpi/evidence/.ainize-lifecycle.lock \
  node /mnt/newdata/gov/kpi/evidence/ainize_lifecycle100_20260911/source/ainize-lifecycle.js
```

Reuse the same RUN_ID and unchanged snapshot when resuming. The shared flock prevents concurrent copies of this harness. An observer failure does not cancel the server-side lesson. Inspect the saved intent, job ID, raw responses and runtime queue before restarting; never restart the model simply because a client timed out.

`progress.json` distinguishes `complete` (all datasets visited), `executionComplete` (all 100 datasets have complete inference observations), and `allAnswersCorrect`. Exit zero means execution coverage only, not all answers correct or overall certification success. This code does not publish drafts, waive consent, bypass PII checks or award blockchain incentives.

## Observed limits

The initial live run adopts job `6314e86b-9ba2-4bc3-8a21-e3294663fdd7` without retraining. Its isolated 16-call audit reports 5/8 primary and 1/8 alternate answers correct; it is not a quality pass. At 2026-09-11 07:10 UTC two datasets have complete inference observations (11/16 primary, 2/16 alternate answers correct in aggregate), and the third job is submitted. This is not evidence of 100 completed lessons. The running immutable snapshot predates the completed-audit resume hash check, unique CLI-error filenames and removal of the old HF publication preflight; those changes are regression-tested, not retroactively attributed to that run. The old snapshot already passed that preflight and does not publish anything while it continues training.

At 07:39 UTC three complete audits report19/24 primary and4/24 alternate answers correct in aggregate, zero all-answer passes. All three jobs, dataset IDs and operator identity survive the guarded Ainize ledger transition unchanged. The same RUN_ID/source resumed as attempt2; job4 `88b3422b-6bb1-4d97-986d-337e9f9331f7` is training. An observer process ended as part of intentional idle maintenance, not because a polling timeout was mistaken for stopped GPU work.
