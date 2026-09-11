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
```

Ten regression tests cover dataset binding without HF publication, optional manifest binding, uncertain submissions, job identity collisions, stack ownership, interrupted audits, historical evidence protection, tampering, and canonical denominators. They use fake CLI/model responses and do not establish real GPU training success.

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
