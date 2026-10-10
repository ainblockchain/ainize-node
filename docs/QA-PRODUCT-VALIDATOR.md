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

## Ainmem actual two-package profile (2026-10-10)

Prepared and executed a pinned dependency image against Ainmem PR76 head
`10e62a69fdb7f098b821ada55681adb63c5df7aa`:

- Image: `sha256:11ca84ad2c9676015cf761cad371e63d8c9847edb88656d4b1222784efd7d035`.
- Scopes: `app` → `/seed/app`, `relational-memory-mcp` → `/seed/mcp`.
- App dependencies match the known server validation copy's dependency declarations and exact
  pnpm lockfile. The current package manifest is stored in the image; MCP uses its exact package
  lock through `npm ci --include=dev --ignore-scripts` during image preparation.
- Five actual gates passed: app typecheck, MCP typecheck, MCP build, QA task contract tests, app
  production build. All gate execution used the native validator's non-root, no-network containers
  with private dependency copies, 8 GiB memory and a ten-minute per-gate limit.
- Evidence root: `/mnt/newdata/qa-services/validation/native-ainmem-product-20261010-9EPoSz`.
  `profile.json`, `result.json`, `run.mjs`, `image-id`, `image/Dockerfile` and `build.log` are retained.

The candidate overlay was the unchanged task-contract file from the PR head. This verifies the
actual existing PR tree and execution profile, not a new model-authored product fix. Database/HTTP
and desktop/mobile browser tests were exercised separately as recorded in the handoff. The five
native gates do not constitute all Ainmem regression suites or a complete channel-to-deployment E2E.
The profile is a prepared diagnostic checkout, not installed production configuration; current-base
synchronization and deployment approval remain required. The dependency image is retained for reuse.

Further image layout observation: Ainize web's package is directly at `/seed` (not `/seed/0`), but
that seed also lacks its executable dependency links. This refines the prior inspection; it is not
an absent package. A native-ready dependency image is still needed for that product.

## AINA actual two-package profile (2026-10-10)

Prepared a native validation image for current observed AINA main
`7dd1029d329b0c4b476b3b10a5ac1cfd84119459`. The packages are `web` and `backend`.
Both use their committed npm lockfiles. Image preparation includes `web/.npmrc`
(`legacy-peer-deps=true`) and backend's committed vendor packages. Omitting the npm
configuration caused an initial clean-install failure; including it resolved that failure
without changing product source or lockfiles.

- Image: `sha256:79f144599af9ca75d25258c259f1d2634fba5b9092a3b7d6c5149804becbbf14`.
- Scopes: `web` → `/seed/native_aina/web`, `backend` → `/seed/native_aina/backend`.
- Four gates passed: web `npm test`, web `npm run build`, backend
  `npm test -- --runInBand`, backend `npm run build`.
- Native runner uses 8 GiB memory, ten-minute per-gate timeout, no network,
  non-root execution, and fresh source/dependency copies for each gate.
- Evidence: `/mnt/newdata/qa-services/validation/native-aina-product-20261010-UHv7iD`.
  Retained `profile.json`, `result.json`, `run.mjs`, `validator.mjs`, `image-id`,
  Git bundle/checkout, Dockerfile and image-preparation logs.
- Candidate digest: `2d3062949418144800584381a1047f72833f672261386cdea9b89b09842d2413`.

The unchanged `web/package.json` is the candidate overlay. This checks the existing
main tree and actual native execution environment; it is not an agent-authored fix,
a live browser/SSO test, or a channel-to-release E2E. Successful gate receipts do not
retain test output, so no assertion is made about individual test counts or skips.
No production profile, job, approval, main branch or deployment was changed.
The prepared image is retained; temporary validation containers are removed by the runner.

## Per-job current-main preparation (2026-10-10)

`AINIZE_QA_BASE_PROFILES` optionally points to an operator JSON map of agent IDs to
`{ "branch": "main" }`. Each entry requires matching validation/review repository and
branch, and enabled canonical host intake. Set `hostBase: true` alongside `hostReview`
and `hostValidation` in the hosted handler configuration. This remains opt-in and has
not been enabled in production.

After verified intake and before coding, the handler polls `ctx.qa.base(jobId)`. The host
reads the configured branch's GitHub ref, imports the exact Git commit when missing,
and stores that job's full SHA in private durable state. No checkout or repository
script executes. Private-repository fetch uses the host publication token in the Git
child environment, not command arguments, source exports or agent containers. Git
credentials still require repository read access. Image preparation remains separate.

The first prepared SHA is immutable for that job. Retries and restarts preserve it;
a new job reads current main again. Validation, publication and release resolve the
profile through the job ID. A caller cannot validate an arbitrary SHA or borrow another
job's prepared base. A changed image/gate/base policy requires explicit reconciliation
instead of replacing the saved job binding. The handler's durable lease allows input
base assignment only before any coding candidate exists. Older in-flight candidates
without this binding are held for migration, not silently rebased.

Known dependency manifests, lockfiles, package-manager configuration, vendor and patch
directories are compared with the pinned image source base. Changes require an operator
image rebuild; this path does not install dependencies inside a gate. Such a preparation
failure is visible as `base_preparation_failed`. Automatic image rebuilding and recovery
of an already-coded candidate when main advances remain separate unfinished work.
Publication/release still reject an advanced main; they never force-push or inherit an
approval onto a reworked candidate.

Regression verification: 107 QA tests passed, zero failures/skips; build passed. Tests
include real Git import without checkout mutation, changed dependency settings, restart
and concurrent polling, fresh base per new job, policy/identity/candidate mismatch,
revocation, gateway token rejection, and preservation through actual coding steps.
The coding transition previously discarded host-intake checkpoint fields; it now
preserves them together with the prepared-base marker.

Actual .41 diagnostic: `/mnt/newdata/qa-services/validation/native-base-20261010-fU8Ndn`.
AINA main was read through the authenticated local GitHub CLI and its non-secret ref
observation supplied to the server diagnostic. Preparing the actual existing checkout
and recreating the service returned the same SHA
`7dd1029d329b0c4b476b3b10a5ac1cfd84119459`, with one head-reader invocation.
An initial unauthenticated server API attempt failed; production uses the configured
host GitHub client/token. This diagnostic uses a fixture intake identity and an already
available object; it does not prove live canonical intake or private-token remote fetch.
No production job, profile, page, approval or branch was changed.

## Aindrive product preparation and workspace limits (2026-10-10)

Prepared main `8d6834ff68a98d1db276821459f001fb2f5b2329` in the native runner, with
both `web` and `cli` package scopes (the web tests import CLI modules). The dependency
image is `sha256:8599a1a1e2a57ea2b0b81de61fba7f887fb3025e4c8b4144d1f64a353c46d9f2`.
Preparation used committed npm manifests, lockfiles and scoped registry configuration,
including native addon installation on Node 22. Preparation passed no runtime tokens or host configuration into the build context.

Evidence root: `/mnt/newdata/qa-services/validation/native-aindrive-product-20261010-dOcf0d`.
`profile.json`, `result.json`, `run.mjs`, Dockerfile/build log, image ID, and exact Git
checkout/bundle are retained. The unchanged `web/package.json` is the candidate overlay.
This verifies the existing main tree, not an agent-authored product fix.

The initial run passed web typecheck, web tests (126 files; 1,263 passed, 3 TODO),
CLI tests (28 files; 336 passed), and CLI build. Web build failed for both unavailable
Google Fonts and `ENOSPC` during webpack caching. It is **not a passing product profile**.
Aindrive PR199 remains open at `483fc269d531e34effbbb412221ec4c97bfe347c`, containing
the existing QA-authored offline font fix. No product source, PR or approval was changed.

`workspaceMiB` now optionally sets the ephemeral workspace capacity (default 2048).
It must be an integer of at least 512 and no greater than the configured container
memory in MiB (default memory 4 GiB). Container memory/CPU/process/network restrictions
remain enforced. The profile hash binds this setting, so a receipt for a smaller or
larger workspace cannot substitute for the current policy. Aindrive's two dependency
trees consumed about 1.8 GiB before build artifacts; use a prepared 4096 MiB workspace
with 8 GiB memory for further diagnosis.

The actual native `workspace-probe.mjs` confirmed 4,294,967,296 bytes in `/tmp` and
successful private output retention. Evidence: `workspace-probe-result.json` and log.
Success and failure gate output now retain a bounded 12,000-character private tail;
never post raw diagnostics to public task cards. A zero exit code still does not prove
all cases ran: inspect skipped/TODO output and suite coverage before claiming completion.
QA tests: 108 passed, zero skips; build passed.

A separate full scenario E2E attempt (`e2e-result.json`) booted the real temporary server
and CLI, but later exhausted the 2 GiB workspace and reported `SQLITE_FULL`. After that
confirmed environmental failure, its specifically identified container was stopped and
its full private stdout/stderr preserved as `e2e-2g-stdout.log` / `e2e-2g-stderr.log`.
That result is failed, not a partial success. A fresh 4096 MiB attempt is now running via
`run-e2e-workspace.mjs`; inspect `e2e-workspace-result.json` and the actual running process
before taking further action. Do not infer completion from the log file alone.

## Private gate evidence and Aindrive follow-up (2026-10-10)

The 4 GiB Aindrive full E2E attempt finished with a failing verdict. Its first retained
failure was scenario #178 (large streaming download), followed by connection-refused
failures because the temporary server was no longer listening. The old 12,000-character
combined tail discarded earlier server output and test totals, so it cannot establish
the server exit cause or a reliable whole-suite pass count. Do not call this an OOM or
product streaming defect without additional evidence.

Scenario #178 alone passed on the same main/image/resource profile (1 passed, 173
intentionally excluded). This is a diagnostic reproduction, not a passing full suite.
Evidence: `stream-result.json`, `stream-evidence/`, `run-stream-repro.mjs` under the
Aindrive evidence root. A new full-suite run uses `run-full-evidence.mjs`; inspect its
actual process and `full-evidence-result.json` before retrying. It writes separate full
private stdout/stderr under `full-evidence/` and records cgroup memory events on failure.

The native validation service now stores stdout/stderr separately under private
`qa-validation/logs/<receipt key>/<gate>.<stream>.log`. Each stream is limited to 1 MiB
plus a truncation marker, preserving both ends of longer output. Directory and file
permissions are checked, symlink redirection is rejected, and persistence failure cannot
produce a passing receipt. Runtime responses contain no host artifact paths. The small
receipt diagnostic reserves space for both stdout and stderr so test totals are not
crowded out by long error stacks. The runner also offers an operator-only evidence
callback for isolated diagnostics; it is not a model/gateway option. No public card
should contain raw logs. Retention/orphan management remains an operational follow-up.
QA verification: 110 tests passed, zero failures/skips; build passed.

## Ainize web actual profile (2026-10-10)

Verified main `2c493a2880032adfe73ead7f32150505cd835f05` in a prepared immutable image
`sha256:c16674669023247bd029d6e087f13885cbfc15e92f2f6d4dd67d6091a94ec90e`, using
`/seed/native_web`, 8 GiB memory and 4096 MiB workspace. Generated-file freshness,
typecheck, tests and production build all returned success. Tests were 348 passed,
zero failed, and one skipped, out of 349.

The skip is `test/lifecycle.test.ts`'s registry check for `npm install -g ainize`; the
container has no network. A separate host-side read of the public registry confirmed
package `ainize` version `0.4.0` at 2026-10-10 14:17 UTC. This does not rewrite the
isolated test result into 349 passes, or prove a live installation/UI flow.

Evidence: `/mnt/newdata/qa-services/validation/native-ainize-web-product-20261010-5yn1dC`
(`profile.json`, `result.json`, `run.mjs`, `image-id`, Dockerfile/build log, exact Git
bundle/checkout, `registry-probe.json`). The unchanged package manifest was the overlay.
No product fix, production profile, live QA job, approval or deployment was performed.

## Aindrive complete scenario run with explicit heap policy (2026-10-10)

`full-evidence-result.json` confirmed the previous failure: 145 passed, 28 failed,
one skipped. The temporary Next development server exhausted its JavaScript heap
at roughly 2 GiB (`FATAL ERROR: Reached heap limit`); cgroup `oom` and `oom_kill` were
both zero. This evidence identifies the process exit cause, not a proven memory leak
or a product streaming defect.

The same exact main/image/candidate passed the full scenario run with operator gate
argv `env NODE_OPTIONS=--max-old-space-size=3072 npm run test:e2e`. Container memory
remained 8 GiB, workspace 4096 MiB, and networking disabled. No source changes or
model-controlled environment settings were introduced. Result: **173 passed, 1 skipped,
0 failed**, 174 total, about 429 seconds. This exercised the actual temporary HTTP
server and CLI, including the previous #178 failure and all subsequent scenarios.

Evidence under the existing Aindrive product root: `run-heap-evidence.mjs`,
`heap-evidence-result.json`, and `heap-evidence/full-e2e.{stdout,stderr}.log`.
The one source-declared skip is the wallet-cookie collaboration WebSocket authentication
scenario in `web/scenarios/collab-cases.mjs`: dochub currently recognizes only the
regular session cookie. The skip remains a product coverage gap; it is not a pass.
The web production build's offline Google Fonts failure and existing PR199 remain
separate unresolved work. These results do not prove a live QA channel/model/approval/
production release, and the profile has not been enabled for production jobs.

## Current resource limits and validation repair (2026-10-11)

Operator profiles may set `pidsLimit` to an integer from 64 to 1024 (default 256).
Candidates cannot supply it. Validator policy version `4-bounded-process-limits`
invalidates earlier receipts. The profile also remains part of the receipt identity.
Teams production layout validation uses 512 PIDs, 8 GiB memory and a 4 GiB temporary
workspace. `e2e/fixtures/teams-product.mjs` builds the app and starts a production
server plus a disposable loopback PostgreSQL database. It requires all four layout
scenarios to pass with no skips or retries. See the handoff for the pinned image and
exact source SHA; this is not a validation of arbitrary later commits.

On a bound host validation failure, the handler resumes native coding up to twice,
only before publication. It preserves job/page identity and immutable failed candidate
and verdict references in `validationAttempts`. Diagnostics are untrusted model input,
not executable instructions. The original request/base and total model round budget
remain unchanged. Every revised candidate needs a fresh passing host receipt before
publication. A third failure remains `validation_failed`, shown in Ainmem's failed
column; it never becomes an approval request. Remote base changes still require the
separate, unfinished revalidation workflow.

Production enablement still needs POSIX ACL utilities (`setfacl`, `getfacl`) available
in the user service PATH. Read-only checks on .41 confirmed that both are absent while
`systemctl --user is-active ainize-public-node` and `ainize-auto-deploy.timer` are active.
The isolated validation copy of ACL tools is not an installation for the production
service. Do not change agent ownership to bypass this dependency.

## Git file inventory in isolated product checks

`gitInventory: true` is an optional operator profile setting. Before copying dependencies,
the container initializes an empty Git repository and stages only the exported candidate.
It uses empty templates, no hooks, and disabled global/system Git configuration. No host
`.git`, remote, credentials, commit history or alternates are mounted. This supports tests
that use `git ls-files`, including untracked probe files created during the test. It does
not provide a fake HEAD or pretend to preserve repository history.

The option defaults to false and cannot be supplied by a candidate. Validator policy
version `5-isolated-git-inventory` invalidates receipts from older execution policies.
An image opting in must contain Git. Failure to initialize the inventory fails the gate.

Real .41 regression at Teams f118bbfe: inventory isolation assertions passed and
`web/src/lib/deployment/docker-context.test.ts` passed all 4 tests, 0 skips, without changing
product source. Evidence: `native-git-inventory-fctn5u_l/result.json` and `evidence/`.
`full-profile.json` there preserves all original gates and adds the option; its complete
suite has not yet run. The two-gate diagnostic profile must not be used as a release profile.
