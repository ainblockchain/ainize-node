# QA agent on Ainize hosting

This package is for Ainize `handler` agents. Its files will be uploaded as the
agent's code, using the existing per-agent `AINIZE_AGENT_STATE_DIR` mount. It does
not proxy requests to the old external Python QA service.

## Implemented

`jobs.mjs` stores requests and checkpoints in SQLite in the agent's own state
folder. A stable request key deduplicates retries across process restarts and
rejects conflicting payloads. A transaction grants only one live execution lease;
expired attempts cannot renew or overwrite the result of a replacement worker.
Waiting jobs keep their checkpoint until explicitly woken. Waking a job is only
scheduling: it never constitutes deployment approval.

The focused test uses real SQLite connections and process-style close/reopen:

```sh
node --test test/hosted-qa-jobs.test.ts
```

The hosted runtime also forwards a sanitized `metadata.teamsMessage` lookup hint
through both A2A send and stream calls. Sender names, claimed administrator roles,
message text/history and credentials are excluded. The hint is untrusted until the
handler re-reads the canonical Teams message and membership.

`teams.mjs` uses the hosted gateway and `TEAMS_TOKEN` secret to re-read a request.
It verifies the configured workspace/channel relationship, the root's presence in
that channel, a reply's parent, request age, and current human channel membership.
It accepts ordinary Korean fix requests and excludes deployment commands from fix
intake. MCP session recovery retries reads only. Caller text and sender claims
never become job input. This does not yet check organization SSO release rights.

The gateway preserves `redirect: 'error'` so the credential-bearing MCP request
cannot follow a redirect. The opt-in `e2e/hosted-qa-live-read.test.ts` runs a temporary
native Docker handler against a real Teams message and verifies SQLite deduplication
after container replacement. It only reads Teams; its temporary job is not processed,
registered in the production catalog, or published to Ainmem.

On Linux, persistent hosted agents require `setfacl` and `getfacl` from the `acl`
package on the node service's PATH. Merely testing a stateless agent does not exercise
this dependency. The validation host initially lacked these tools; an extracted
distribution package was used on the isolated test PATH, without changing the
production unit or weakening directory permissions.

`repository.mjs` reads text from a configured GitHub repository at a full immutable
commit SHA, using `GITHUB_READ_TOKEN` when needed. `coding.mjs` runs the actual
hosted model/tool loop: list files, read bounded ranges, replace uniquely matching
text the model has read, and create source/test files. These tools do not run repository
code, publish commits, or release. Candidate state stops at `needs_validation`.
Model context retains complete recent tool exchanges within a byte budget. The
installed model rejected an initial 8,192-token output request because that was its
entire context limit; the loop now reserves 2,048 output tokens and bounds reads.

`advance.mjs` connects one model step to the SQLite lease. `checkpoints.mjs` saves
private immutable blobs before SQLite refers to them, so restart can resume and a
late attempt cannot overwrite a newer checkpoint. An expired lease cannot publish
progress. Checkpoint storage still needs retention/capacity policy before production.

`e2e/hosted-qa-live-coding.test.ts` is an opt-in small arithmetic diagnostic using
the real configured Ainize model inside a native hosted Docker handler. It resumes
the same SQLite job after container replacement and checks the generated function
in a separate container without network, credentials or unrelated host mounts.
This proves the native model/tool/checkpoint path, not product regression coverage.

## Operational handler

`index.mjs` composes the modules above into the agent the host actually loads. It exports
`execute` and `tick` (and a testable `createHandler`/`parseConfig`):

- `execute(input, ctx)` reads the untrusted `input.metadata.teamsMessage` locator hint, re-reads the
  canonical Teams message with `verifyFixRequest`, and enqueues a job only when an active human member
  of the configured channel made a genuine fix request. The stable request key folds in the pinned
  base SHA, so retries deduplicate and an old approval cannot ride a new base. Release commands are
  not fix intake and are never enqueued here.
- `tick(ctx)` claims one queued job under a SQLite lease and runs a single bounded `advanceCoding`
  step against the pinned `GitHubSnapshot`, saving an immutable checkpoint. A candidate stops at
  `needs_validation`. The handler never publishes commits, runs repository code, or deploys, and no
  release credential is reachable from this path.

Per-service binding comes from bundled `qa-config.json` next to `index.mjs` (a secrets-free JSON file: `service`, `teamsOrigin`,
`workspaceId`, `channelId`, `enabledAt`, `repository`, full `baseCommit`) and the agent's own
`AINIZE_AGENT_STATE_DIR` mount. Standalone tests may override the config path with `AINIZE_QA_CONFIG`; the hosted Docker runtime does not forward that variable. Tokens (`TEAMS_TOKEN`, `GITHUB_READ_TOKEN`) are read through
`ctx.secret`, never from config. The focused test is `test/hosted-qa-index.test.ts`.

`validation.mjs` is the next stage's reusable core: `validateCandidate` runs a product's configured
gates in order (stopping at the first failure) through an injected runner and returns a verdict bound
to a `candidateDigest` of the exact changed files on the pinned base, so a verdict can never be
reattributed to a different candidate or an older commit. `advanceValidation` runs one such step under
the SQLite lease and parks the job in `waiting` at `needs_publication` or `validation_failed`, never
publishing, deploying, or recording an approval. The focused test is `test/hosted-qa-validation.test.ts`.
What still belongs to the host and the maintainer: the real per-product gate runner (an isolated,
credential-free container built from the base plus the candidate), the policy for waking a
`needs_validation` job into validation, and the human-approved release path that consumes a verdict by
its exact digest. `index.mjs` does not yet wake jobs into validation — that scheduling choice depends
on where product gates run.

## Required before registration or cutover

- Check active organization SSO identity for releases, in addition to the canonical
  Teams message and membership checks implemented above.
- Connect the native coding components to each product's configured snapshot and
  actual repository test/build/browser gates. Publish candidates with reviewed commit
  binding; the arithmetic diagnostic does not satisfy any product's release gate.
- Execute durable checkpoints within the hosted runtime. Handle idle eviction and
  node restart without losing queued work. A lease is not exactly-once delivery:
  reconcile external GitHub and Ainmem writes by stable job identity on retry.
- Keep release credentials out of coding/model access. Verify designated human
  approval from the original Teams thread or canonical Ainmem page against the
  exact reviewed SHA before every release.
- Keep one canonical Ainmem task page/link, and preserve existing task history,
  agent IDs, channel links, and approvals during migration. Old approvals cannot
  authorize newly generated commits.
- Exercise a real request in every product QA channel, including native hosted
  execution, tests, PR, genuine administrator approval, deployment, and serving
  revision verification. Then retire the external runtime.

The store is an implementation component, not a registered or production-ready
QA agent. No external registration or deployment is performed by these files.

### Recovery after a failed coding step

Three consecutive thrown steps park the job in `waiting` with `holdReason: step_retry_limit`, preserving
its candidate. A successful coding step resets the failure count. Investigate before waking it;
waking does not approve release. Jobs with changed repository/base configuration are parked with
`holdReason: configuration_changed` instead of repeatedly occupying a lease. Canonical Teams intake now reuses the existing job across base changes, including historical
base-dependent keys. It keeps that job's original base, candidate, approvals and page references.
Changed canonical text/repository or multiple historical matches require explicit reconciliation;
intake never silently replaces a candidate. New message identities use a bounded SHA-256 key.

## Native Ainmem reporting

Optional `ainmem` config contains `origin` (HTTPS), `databaseId`, `titlePropertyId`,
`statusPropertyId`, and `statusOptions` mapping queued/coding/validating/waiting/completed/failed
onto existing board option IDs. The gateway must allow this origin. Store `AINMEM_TOKEN` as a
private hosted secret for a workspace agent with edit permission on that board.

`AinmemReports` keeps a SQLite report outbox alongside jobs. Reports have monotonic revisions;
failed requests survive restart, and retries send the same revision/body. Acknowledgements must
match the revision and canonical page path. Board changes are refused until reconciled. Intake
returns one task link after a successful write. Tick retries pending reports and updates the
canonical card after coding or a hold; reporting failure does not fail the coding step.

Requires Ainmem branch `native-qa-task-api`. Do not enable for existing production jobs yet:
legacy page adoption is not implemented. Initial report failure currently returns a text receipt;
a later successful tick updates the page but does not yet send a Teams follow-up with its link.
No PR publication, release approval or deployment authority is granted by this reporting path.

## Offline legacy history import

`importLegacyJobs({ sourcePath, jobs, checkpoints, config })` reads a consistent snapshot of the
old SQLite `jobs` and `reports` tables with a read-only connection. Operator config binds service,
repository, workspace and channel. Use a private destination directory and snapshot the source
before actual cutover. The importer refuses working/queued jobs, duplicate canonical messages,
repository conflicts, orphan reports, changed repeat imports, and source/destination equality.

IDs, original timestamps, payload/details and report history are preserved in immutable private
checkpoints. Completed/failed jobs keep terminal states; other history waits at `legacy_reconciliation`.
Old approval data stays archived and is not promoted into a native approval. Waking an imported job
cannot resume a legacy runner stage: a separate reconciliation must bind the candidate, exact SHA,
canonical page and current verified human approval to the native stage first. Snapshot import is
not proof that a live legacy writer is disabled, so this function never performs a cutover itself.


### Host release status

Set `hostReview: true` only with the host review/publication configuration in place.
The handler polls its authenticated `/qa/status` endpoint with a separate durable
lease for approval and deployment waits. Coding continues independently. Matching
job, repository, base, candidate SHA and digest are required before accepting host
evidence. A branch update means `awaiting_deployment`; only verified serving
revision evidence completes the job and updates its Ainmem report. This does not
claim that post-deployment UI regression tests ran. No approval is generated by
polling, and release credentials stay on the host.

`hostReview: true` also requires `intakeEnabledAt` (an explicit ISO start time)
in the matching host review profile. Before coding or publishing, the handler
registers its original Teams locator through `/qa/intake`; the host independently
reads the request and stores its author, time and content digest. New requests
must be within 24 hours and later than this start time. Historical imports require
a separate reconciliation, not a fabricated new request. The host refuses PR
publication without this registration when intake is enabled. Only one unfinished
review per original Teams thread may solicit deployment approval at a time.

### Resume after a published review's base changes

`hostRevalidation: true` opts into automatic preparation after a published review
has been durably invalidated because its base moved. It requires all four host
base/review/validation/publication flags. `/qa/revalidation` uses the authenticated
job scope, including shared web/API routing; the request cannot select an agent.
The host records its new base and the review reservation before returning success.
The handler preserves the job ID, original request and archived attempts, then
starts coding on the new snapshot without the old candidate or approval. A new PR
is presented on the same canonical Ainmem page and needs a fresh approval.

Failed preparation is attempted at most three times before the task waits with
`revalidation_preparation_failed`. Pending work does not block unrelated coding.
This opt-in does not yet resume drift detected before a published review exists,
including another main change before the replacement PR is published. Those
cases stay preserved for reconciliation. Enabling this flag is not evidence that
the production channels or release path have been tested end to end.

## One Ainize channel for web and API

A shared handler keeps one Teams bot, one state directory, and one Ainmem board. Set
all four `hostBase`, `hostReview`, `hostValidation`, and `hostPublication` flags to
`true`, and add `routes` to its bundled config:

```json
{
  "routes": {
    "web": {"service":"ainize","repository":"ainblockchain/ainize-web","baseCommit":"<full web SHA>"},
    "api": {"service":"ainize-node","repository":"ainblockchain/ainize-node","baseCommit":"<full API SHA>"}
  }
}
```

The top-level service/repository/baseCommit must match `web`; keep the normal Teams,
time, and Ainmem configuration. Bundle `routing.mjs` with the other example modules.
A new ordinary request defaults to web. `API`, `백엔드`, `ainize-node`, `web`, `웹`, or
`ainize-web` followed by whitespace/colon selects explicitly. A reply inherits its
thread's repository; a conflicting prefix requires a new thread.

The operator sets `AINIZE_QA_SHARED_PROFILES` to a JSON file mapping the authenticated
hosted-agent ID to two private capability profile IDs:

```json
{"<existing hosted-agent ID>":{"web":"ainize-web-scope","api":"ainize-api-scope"}}
```

Use those scope IDs as keys in the host validation, publication, review, base, release,
and deployment profiles. They are internal identifiers, not additional registered
Teams bots. Both review profiles must have the same intake start time, Teams workspace
and channel, SSO identities/approval policy, Ainmem board, origins and credentials.
Validation/publication/base profiles must match each scope's repository and branch.
The base profiles are required. Release/deployment profiles still require their normal
operator opt-ins; omitted profiles do not cause automatic deployment.

The host independently rereads canonical Teams content before atomically persisting
the selected scope and verified intake. The existing gateway token then resolves
base/validation/publication/status by the saved job ID; no caller-provided scope is
accepted. Direct token calls as an internal scope are refused. Restart and duplicate
polls preserve the original binding. Changed routing policy or unmapped historical
thread state requires explicit reconciliation; do not enable this on a live legacy
state directory without the preserving migration and single-writer cutover.

This capability is implemented and covered by host/gateway/handler tests. Production
profiles, historical route import, and actual channel-to-release validation remain
separate rollout work. Do not infer a completed production migration from these tests.

### Preserving shared-channel history

For an offline migration, pass `route: "web"` or `route: "api"` in each product's
`importLegacyJobs` config and import both snapshots into the same new Jobs database.
The selected route is added to the native input; original archives, job IDs, states,
page references and historical approval details remain unchanged. Reimporting with a
different route is refused.

The host operator can call `HostedQaRoutes.importHistory(ownerId, items)`, where each
item is the immutable archive loaded from the imported job's checkpoint and its
`legacyFingerprint`. This writes only historical routing evidence. It does **not**
create a verified live intake, review target, or approval; gateway calls for those old
jobs still fail until explicit reconciliation. The method is not exposed by HTTP.
Afterward, a newly verified reply inherits the old thread's repository. Replaying the
old request as a fresh job is refused. Mixed historical repositories remain archived
and require reconciliation before a new request can proceed in that thread.

Ainmem legacy page adoption remains a separate operator mapping in the Ainmem QA API;
this route import does not move or recreate cards. Use a new diagnostic target before
cutover, inspect results, stop the legacy writer at cutover, and reconcile any changes
to the live source since rehearsal before activating native work.
