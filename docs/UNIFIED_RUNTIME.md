# Repository → Project → Runtime implementation

This work implements the integrated design agreed on 2026-10-10. A repository has one writable source; a project binds source/path/branch to a runtime kind; every execution names its source commit and actor. Existing agent git URLs and history remain available through the legacy adapter. AIN Drive owns new project repositories, GitHub mirrors stay read-only here, and ainize owns execution.

## Acceptance ledger

Each item requires implementation and direct verification before completion.

- [ ] Common repository identity and execution contract across project and agent APIs.
- [ ] Record source commit separately from internal projection commit.
- [ ] Show latest source and active runtime commits; failed updates preserve the prior runtime.
- [ ] Prevent a project/mirror agent from acquiring a second writable source through git, PR merge or CRUD.
- [ ] One validation/application pipeline for push, merge, mirror and project agents; validate merged results.
- [ ] Connect signed mirror webhook and periodic reconciliation, with serialized sync and visible failures.
- [ ] Durable AIN Drive push delivery with retry, deduplication and restart recovery.
- [ ] Common run form and logs in Drive and ainize; explicit working-tree/selected-commit/deployed targets.
- [ ] Mobile repository controls (PR aindrive#230), plus ainize mobile execution surfaces.
- [ ] PR creation UI and fixed-SHA temporary previews with TTL and no inherited production secrets/write permissions.
- [ ] Preview/run records retain model, inputs, source SHA and output for quality comparisons.
- [ ] AinCode clones and pushes agent git instead of comparing integer versions over JSON.
- [ ] Agent CLI clone/pulls/mirror commands.
- [ ] Document all git, PR, mirror, preview and common execution APIs in generated references.
- [ ] Repository growth limits and maintenance; export before deletion.
- [ ] Verify Clef script and service transition preserve repository/project identity.
- [ ] Verify rejected agent trees, failed builds, duplicate/lost notifications, restart recovery and compatibility URLs/history.

## Contracts

Push acceptance and runtime readiness are separate states. Legacy agent git waits for apply completion before ending receive-pack; asynchronous Projects return a queued execution. A source commit is the immutable input. An agent's generated repository commit is a projection, never an alternative source. Deployment and one-off run records share identity and result fields but runs cannot change the project's active deployment.

Configuration remains local to its package: ainize.json owns execution; agent.json/prompt.md/files own agent behavior; ownership, credentials and permissions remain server-owned. No cross-repository source imports are required.

## Verified implementation progress (2026-10-10)

- Drive branch includes mobile commit `e09f95e` (the change also remains reviewable as aindrive PR #230). Type checking and 25 repository/run-input tests passed on the current base.
- Agent mirror reconciliation now shares one serialized synchronizer for periodic and signed webhook requests; original request bytes are checked after the global JSON parser. Real Git tests cover automatic reconciliation, reserved-field rejection, and tag filtering.
- Runtime ledger distinguishes source/projection commits and preserves the prior active version on failed replacement. Project active deployment survives failed newer deployments and pruning. Agent push now checks sharing policy before moving its deployed ref; real HTTP Git push proves rejection leaves the ref unchanged.
- Drive deliveries are persisted before network requests, leased, retried in repository order, and deduplicated by immutable event/actor identity. Tests cover 503 recovery, actor retention, expired worker leases, ordering and duplicate events. The production worker bundle starts and stops successfully under Node 22.
- Auto-binding accepts `bindRequestId` so the same authenticated application can recover its lost creation response. A different receipt or legacy lookup cannot read the hook secret. Eight auto-binding API tests passed; Drive's 15 binding/delivery tests passed.

Remaining ledger items retain their full scope; these observations do not prove end-to-end completion or production deployment.
