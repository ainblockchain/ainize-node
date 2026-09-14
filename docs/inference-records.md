# Native inference records

Inference recording is opt-in because it submits public, potentially fee-bearing
AIN transactions. Start the node with `AINIZE_INFERENCE_RECORDS=true` in its
process environment. It requires the AIN ledger and a core build containing
`noteInferenceBatch` (core commit `9ec4922` or later). The currently declared
registry dependency alone does not guarantee that capability: startup fails
explicitly if unavailable. Local ledgers are not silently substituted.

Successful `Market.chat` calls, including the native JSON/SSE `/api/chat` route,
create one server-generated completion receipt per request. Both columns of a
comparison must finish normally; a comparison counts once, not twice. Each
selected result must have nonempty content, the same reported model ID, a `stop`
finish reason and no truncation. Exceptions and already-aborted requests do not
count. This is server completion before final HTTP delivery, not proof that the
client received `[DONE]`. Calls bypassing `Market.chat` are outside coverage.

Every 60 seconds, receipts are grouped by model and submitted as native batches
to `/apps/knowledge/market/inference_batches/<node-address>/<batch-id>`. The
interval spans the preceding observation boundary to this flush, including idle
time; it is not a sum of individual generation durations. Shutdown also flushes.
Chain calls run outside the inference lock, with at most one flush in flight.
AINSCAN displays their reported rate in ordinary transaction details, separately
from onchain TPS. No experiment endpoint or run ID is involved.

The existing node SQLite `kv` table holds `inference.journal.v1`. Each batch has a
local ID and `pending`, `submitting`, `submitted` or `unconfirmed` state. Submission
acknowledgments retain the transaction hash and native path; block inclusion must
still be checked. Unknown outcomes are **never automatically retried**, including
after restart. Preserve and inspect the journal before manual reconciliation.
`inference.receipts.<local-id>` retains the ordered receipt array. Each receipt
has only a random UUID `id`, `model_id` and `completed_at` epoch milliseconds.
The commitment is SHA-256 of core `canonicalJson(receipts)` UTF-8 bytes, not a
Merkle tree. Prompts, answers, visitor identities and teaching keys are excluded.
The chain rule authenticates the reporter, not the truth of these receipts.

Capacity is bounded at 5,000 unbatched receipts and 1,000 retained batch entries.
Capacity or storage failure logs incomplete coverage; it never invents missing
completions. Archive the SQLite database and reconcile submissions before an
operator resets retention. This first implementation has no automatic archive
or administrative retry command. Back up the journal across node upgrades.

Tests cover real native HTTP handling against a mock streaming model, plus a fake
chain writer for durable state ordering, commitments, concurrent flushes,
restart and uncertain submissions. They do not prove real GPU throughput or AIN
inclusion. Production use still requires the updated core package, administrator-
verified chain rules, publication/deployment and client/server receipt
reconciliation under real load.
