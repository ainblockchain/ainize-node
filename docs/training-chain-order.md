# Training state submission order

`TeachWorker` submits native lesson state to
`/apps/knowledge/market/lessons/<publisher>/<job-id>` through the ledger adapter.
AINSCAN reads these ordinary blockchain records; no experiment API is involved.

Submissions for the same job wait for the previous submission call to settle.
This prevents a slow TRAINING acknowledgement from overwriting the local READY
transaction reference and prevents this worker from dispatching READY before its
earlier TRAINING call has settled. Different job IDs have independent queues.

Each transition's dataset, timestamps, model identity and other public fields
are captured before waiting. `submitted_at` is captured immediately before the
actual ledger call, not when the transition enters the queue. Private questions
and answers are not included. The latest per-status receipt remains available
alongside the job's latest transaction reference.

An error or unconfirmed result does not block subsequent transitions. Neither
case creates a successful receipt or triggers an automatic retry. An exception
is logged; an unconfirmed result retains its existing unconfirmed receipt form.

## Verification

With Node.js 24 and the repository dependencies installed:

```sh
node --test --import tsx test/teach-chain-order.test.ts test/teach-chain-record.test.ts
npm run typecheck
```

The tests use the real worker submission method with an in-memory store and a
controlled ledger stub. They cover delayed acknowledgements, transition
snapshots, dispatch timestamps, failure recovery, receipt retention, queue
cleanup, and 70 distinct job IDs dispatching before any acknowledgement.
This is not evidence of 70 simultaneous GPU training jobs or blockchain TPS.

On 2026-09-14, all 9 focused tests and all 26 existing `test/teach.test.ts`
regression tests passed, along with TypeScript checking. The regression run used
the existing Python environment with NumPy for stub patch generation; it did not
start a GPU trainer or write to a public blockchain.

## Limits

Sequencing is per worker process and waits for RPC acknowledgement, not block
inclusion or finality. An uncertain network outcome, transaction-pool ordering,
or another writer can still affect the eventual chain state. AINSCAN must keep
checking actual execution results and block membership. The queue is in memory;
process termination can lose pending submissions, and this change does not add
a durable outbox or shutdown drain. No published package or running service is
updated merely by committing this source change.
