# Training chain submission receipts

The existing authenticated lesson view now includes `chain_submissions`: the latest persisted receipt for each job state. `chain.path` and `chain.tx_hash` remain backward compatible and still identify the latest acknowledged write, which may describe completion rather than the start of training.

Each receipt includes `status`, `submittedAt` and `acknowledgedAt` (Unix milliseconds), `path`, `txHash`, and `outcome` (`submitted` or `unconfirmed`). A local ledger or absent receipt produces no synthetic transaction. Receipt fields are allowlisted; unrelated stored fields are not returned. This is not a complete retry history, and a submission failure before a receipt was saved may leave no entry.

Use `ainize teach status <job-id> --json` with the lesson owner's teaching identity to retrieve the `TRAINING` receipt even after the job reaches `READY`. New CLI versions also render the receipts in human-readable status output. Existing authorization rules still apply; public status-only views must not expose the lesson body.

Acknowledgement is not inclusion or finality. For inclusion latency, resolve `txHash` on the correct blockchain and verify its containing block, lesson path, dataset and `TRAINING` value. Match its on-chain `submitted_at` to the receipt before subtracting it from the containing block timestamp. This keeps AINSCAN a normal explorer: no experiment endpoint or Run ID is needed.
