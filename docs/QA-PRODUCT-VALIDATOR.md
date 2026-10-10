# Native hosted QA product validator

`src/hosted-qa-validator.ts` runs on the Ainize host. It exports `runQaValidation(profile, candidate)`.
It must not be uploaded as a handler that has access to a Docker socket. The private gateway and scheduled handler integration are implemented behind explicit operator
configuration. Production profiles and the coordinated agent cutover are not yet enabled.

Operator profile pins repository, full base SHA, checkout path, immutable dependency image digest,
image dependency directory (`/seed/...`), product working directory, and ordered fixed gate argv.
The candidate must match repository/base. It is copied before async work and its SHA-256 digest
binds the returned verdict to the exact changed text files.

The host exports the exact Git commit, refuses symlink/submodule/unsafe paths, applies candidate
text files, and mounts only this temporary export read-only. Gates run as a non-root user with
no network, read-only root, no capabilities, no new privileges, bounded memory/CPU/PIDs/time, and
an ephemeral work directory. Repository commands receive a fixed environment without host or
release credentials. No package install runs: package.json and every source lockfile must exactly
match the dependency image or validation fails. Updating dependencies needs a rebuilt, pinned image.

Each gate receives a fresh copy of source and a private copy of the image’s node_modules (relative package links preserved). The first failed gate
stops the sequence. Container cleanup runs on success, error or timeout; temporary source is deleted.
Host crash recovery/orphan reconciliation remains necessary before production activation.
Private diagnostics are returned separately; never copy arbitrary gate output into public cards.

## Verification / limitations

- Local QA suite and typecheck cover configuration/path limits; real container execution was tested
  on Ainize .41 with the existing pinned Ainspace dependency image.
- Ainspace PR #198 commit `6bec65cef4a05e42f52a668850fd728ba09c42d2`: unchanged README supplied as the
  candidate overlay, so this is a check of the existing PR tree, not a new agent-authored fix or
  the result of rebasing onto latest main.
- With 4 GiB memory: lint and test passed; build exited 137 after printing `Killed`. This suggests
  resource pressure but the log alone does not prove OOM. An 8 GiB build retry was started separately.
- Evidence root: `/mnt/newdata/qa-services/validation/native-validator-20261010-3nezNA`.
  `result.json` records the 4 GiB run; `result-build-8g.json` is the follow-up result.
- Multi-package repositories need all configured product scopes; a single scope cannot satisfy them.
  Database/browser fixtures and network-dependent build assets are not supplied by this module.
- A passing validation checkpoint now waits at `needs_publication`, not approval: no reviewable
  published commit or PR exists until the publication stage actually succeeds.

## Host capability connection (2026-10-10)

The 8 GiB retry passed Ainspace's build for the same candidate digest. Combined with the earlier
lint/test passes, all three checks ran successfully on the existing PR tree; latest-main merge
validation and browser regression checks remain separate.

`AINIZE_QA_VALIDATION_PROFILES` optionally points at an operator-controlled JSON object mapping
agent IDs to `QaValidationProfile` values. The server creates `HostedQaValidationService` and
exposes `/t/<runtime token>/qa/validation` only on its existing private gateway. Runtime code uses
`ctx.qa.validate(candidate)`. A request cannot select commands, Docker image, checkout or another
agent. The service validates the bound candidate, runs one candidate at a time, and persists private
receipts under the node data directory. Duplicate requests poll the running operation; completed
receipts survive node restart. Other work receives `busy` and retries on a later tick.

QA handler config `hostValidation: true` wakes completed coding candidates into validation. Each
tick starts/polls validation, validates receipt digest and base, and preserves the job until it can
advance to `needs_publication` or `validation_failed`. Coding and release remain separate.

Tests cover the real runtime HTTP gateway with a controlled executor, token binding/revocation,
operator-only configuration, deduplication, receipt persistence, polling and publication-stage
transition. Actual Docker product execution was tested separately on .41. The complete hosted
Docker → gateway → product runner chain still needs an integration run before production enablement.
No production profile configuration has been installed in this work.

## Actual hosted Docker integration (2026-10-10)

`e2e/hosted-qa-product-validation.test.ts` passed on Ainize .41, 1 test / 0 failures / 0 skips,
about 19 seconds. It uses an isolated agent store, the separate internal `ainize-cicd-integration`
network, and a private Unix gateway socket. The actual hosted handler enqueues once, automatic host
ticks invoke `ctx.qa.validate`, the host executes Ainspace's real lint gate in a second isolated
container, and the job reaches `needs_publication`. The agent is restarted during the operation;
job ID is preserved and host validator execution count is exactly one. No model is called in this
diagnostic: it validates the existing PR tree, not a newly generated product fix.

The first attempt hit the normal A2A rate limit because its observer polled A2A every second. The
final test sends a single intake call and then reads durable job state without generating more
user requests. Both test containers/agent images were removed after the test; production network,
registered agents, channels, pages, and release settings were not changed.

Evidence: `/mnt/newdata/qa-services/validation/native-gateway-20261010-ZhEcNt/integration-retry.log`.
Profile: existing Ainspace PR #198, immutable dependency image, lint-only for this combined path.
The previous standalone runner separately passed lint/test/build at the same PR tree. Full real
channel → model edit → all product checks → PR → page → real approval → deployment remains pending.

To reproduce on a prepared host: build this repository; run the opt-in test with
`AINIZE_QA_VALIDATION_PROFILE` pointing at an operator profile and `AINIZE_CI_DOCKER_NETWORK` naming
an unused internal test network. It intentionally refuses the production network name. The profile
must include an available checkout/commit and pinned dependency image. Runtime state/socket access
requires the host ACL utilities used by other hosted agent Docker tests.


## Multiple package scopes (2026-10-10)

`dependencies` optionally lists `{cwd, dependencyPath}` pairs for every package needed by the
product. The existing top-level `cwd`/`dependencyPath` pair must be included. Each gate may set
`cwd` to one of those declared scopes; omitted values use the top-level directory. Duplicate,
escaping or undeclared scopes are refused. Every gate receives a fresh source copy with **all**
scopes prepared and each scope's package/lock files checked against its image seed. This supports
separate frontend/backend gates and workspace dependencies without sharing writable dependencies
between gates. The receipt version is now `3-multiple-dependency-scopes`; prior receipts cannot
authorize this changed execution policy.

Actual server image inspection found two package seeds for AINA and a workspace manifest for
Teams. Only Ainspace's inspected seed had ready executable links. The other images need an
explicit rebuilt dependency layout; assigning their existing image IDs to native profiles is not
sufficient. Ainize web had no immediate `/seed/<scope>/package.json` at all. Do not interpret these
findings as a failure of the existing Python worker, which may restore dependencies differently.

`e2e/hosted-qa-multi-scope.test.ts` passed on .41: 1 test, zero failures/skips. Real Docker gates in
frontend and backend directories each resolved their own fixture package and saw the same candidate
overlay across the checkout. No network or release credentials were available. Evidence:
`/mnt/newdata/qa-services/validation/native-multi-scope-20261010-nE5z42/retry.log`. The first fixture
used `/seed/0`, inherited the base image's entire dependency tree and failed with no diagnostics;
the passing fixture uses separate seed paths. No claim is made that the first failure's exact cause
was established. Diagnostic images and containers were removed by the harness.

The fixture proves the execution contract, not AINA product regression coverage. Actual product
images/profiles, database/browser gates and service-wide E2E remain required. QA unit/integration
targets: 101 passed, zero skips; TypeScript build passed.
