# Shared trainer and runtime leases across Docker nodes

Nodes sharing a trainer or a serving-model mailbox must not delete each other's
lease based on a PID from a different container. Previously both lease paths
could delete a holder after a local `kill(pid, 0)` probe or an age threshold.
PIDs are namespace-local, and a long-running operation need not be dead. A reader
could also mistake the short gap between directory creation and metadata writing
for an abandoned lease.

## Updated behavior

- Trainer and runtime acquisition use the same atomic-directory claim helper.
  Any existing directory remains occupied, including expired, legacy or unreadable
  metadata. No elapsed-time or PID check automatically deletes it.
- Each successful claim has a random lease token. Its release callback removes
  only metadata carrying that token and is idempotent. A replaced lease is not
  removed by an old callback.
- Holder metadata records boot identity and PID namespace when Linux exposes
  them. Liveness probes run only within a matching scope. Foreign, legacy or
  unavailable scopes report `liveness: "unknown"`, not a guessed dead process.
- Runtime `mine` identifies the particular Runtime instance, not merely an equal
  PID string. Separate instances in the same process do not claim each other's
  ownership.
- The compatibility `alive` field is conservative: true means not proven dead.
  Consumers needing certainty must inspect `liveness`. `stale` indicates age
  only; it is not permission to take over the lease.

Normal completion releases the lease. A crash or metadata-write failure can leave
an orphan and intentionally requires operator recovery. This trades automatic
takeover for protecting active model mutations and training. It does not make
one shared GPU trainer execute 70 jobs simultaneously.

## Deployment and orphan recovery

Upgrade every node sharing the same `ple_patch` directory before relying on the
new protocol. An older node can still run its old deletion logic. This source
change does not upgrade/restart existing nodes or publish an npm package.

For an orphan, pause new work and inspect `holder.json` under
`.ainize-runtime.lock` or `.ainize-teach.lock` in the shared `ple_patch` directory.
Verify the owning container/process and its child trainer/model operation are
actually stopped; a controller PID disappearing does not prove its child GPU
operation stopped. Only under that coordinated maintenance condition should the
operator remove the orphan directory and resume dispatch. Never clear a live
lease to force another benchmark to start.

## Validation

Unit tests cover ownership exclusion, replacement-token protection, unknown
cross-namespace/legacy liveness, incomplete/old leases, and same-process instances.
Runtime/API/teaching regression tests exercise normal lock release and the
existing training path. The test environment needs NumPy for seeded patch fixtures;
the default system Python lacked it, so that prerequisite was supplied by the
existing test virtual environment rather than changing application code.
The focused runtime/API/teaching suite passed 49 tests with NumPy 2.2.6; the
final ownership checks and TypeScript check also passed. Actual Docker output
is retained in `test/evidence/shared-leases-20260914/docker-check.json`.

Run the real two-container namespace check with a locally available pinned
Node 24 image and a new output directory:

```sh
AIN_LEASE_TEST_IMAGE=sha256:52e634617c0fad0207eeba4262ecdf142fc886649253ac42e4730ce75bd04dd5 \
  bash scripts/test-shared-leases.sh /absolute/path/to/new-output
```

Both containers have their own PID namespaces and share only test storage. Each
has CPU=1, RAM=512 MiB, no additional swap, and no network. The contender cannot
take an intentionally old lease; holder identity remains intact and normal
release removes it. The script cleans up only its temporary containers. It does
not touch live locks, model repositories or GPUs and proves no throughput target.
