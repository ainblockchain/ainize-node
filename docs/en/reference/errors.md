---
title: Error codes
summary: The error envelope, and every machine-readable code a node can answer with
---

# Error codes

> [!NOTE]
> **This page is generated — do not edit it by hand.** It is written by `scripts/docs-gen.mjs` from `packages/node/src`.
> Regenerate with `npm run docs:gen`; `npm run docs:check` fails when this page and the source disagree.

What an error body looks like, how a thrown error becomes an HTTP status, and the 59 codes a client can match on.

## The error envelope

Every failed request answers with `{"error": "<message>"}` and one of the statuses below. Some errors add fields to that object; the endpoint that raises them says so in the [HTTP API reference](./http-api.md).

Where the message begins with a lower-case word and a colon — `dataset_not_found: no such dataset on this node` — **that prefix is the machine-readable code**. There is no separate `code` field: match on the prefix, show the sentence.

### How a thrown error becomes a status

| Error | HTTP status | Also in the body |
|---|---|---|
| `ChatCancelledError` | `499` | `cancelled`, `charged` |
| `Error` whose message matches `/shared runtime busy/` | `503` and the header `retry-after: 30` | `busy` |
| `TeachError` | the error's own status | `(err.details ?? {})` |
| `HttpError` | the error's own status | `err.body` |
| `PayoutError` | the error's own status |   |
| `z.ZodError` | `400` | `issues` |
| `ValidationError` | `400` |   |
| `ConflictError` | `409` | `(err.details ?? {})` |
| `NotFoundError` | `404` |   |
| `MarketError` | the error's own status | `(err.details ?? {})` |

Anything else is a fault in the node and comes back as `500` with the raw message.

## Codes

59 codes are raised by name, in 117 distinct messages: a code that can come back with more than one status, or with more than one sentence, has a row for each. An ellipsis or a `<name>` in a sentence is a value filled in at the time — the code before the colon is the part to match on.

| Code | HTTP | What it means | Raised in |
|---|---|---|---|
| `already_known` | `409` | … already answers every one of these questions the same way | `packages/node/src/teach.ts` |
| `bad_license` | `400` | "\<license>" is not a licence this network knows (CC0-1.0, CC-BY-4.0, CC-BY-SA-4.0, ODC-By-1.0, Proprietary) | `packages/node/src/teach.ts` |
| `banned` | `403` | this node is not accepting lessons from this address | `packages/node/src/teach.ts` |
| `banned` | `403` | this node is not accepting lessons from this key | `packages/node/src/teach.ts` |
| `base_not_available` | `403` | \<id> is someone else's private draft | `packages/node/src/teach.ts` |
| `base_not_held` | `409` | \<a.patch_id> is held under a different body than \<id> was trained on | `packages/node/src/teach.ts` |
| `base_not_held` | `409` | this node does not hold the body of \<id> — buy or download it first | `packages/node/src/teach.ts` |
| `base_private` | `400` | the creator of \<id> kept its questions private, so nobody can build on it (you can still load it for comparison) | `packages/node/src/teach.ts` |
| `base_rejected` | `400` | \<id> is … — it cannot be built on | `packages/node/src/teach.ts` |
| `base_retired` | `400` | \<id> is retired — build on its newer version…, or pass force to proceed anyway | `packages/node/src/teach.ts` |
| `base_stack_too_deep` | `400` | \<stack.length> knowledges would have to be loaded under this lesson (at most 8) | `packages/node/src/teach.ts` |
| `base_unknown` | `400` | \<b.patch_id> is no longer on this node | `packages/node/src/teach.ts` |
| `base_unknown` | `400` | no knowledge called \<id> on this node | `packages/node/src/teach.ts` |
| `base_unknown` | `404` | no knowledge called \<id> on this node | `packages/node/src/teach.ts` |
| `base_unresolved_conflicts` | `400` | \<conflicts.length> of your answers differ from …'s answer to the same question — confirm that you mean to change them (they will be published as changes to it) or take them out | `packages/node/src/teach.ts` |
| `checks_failed` | `409` | the side-effect check was turned off for this lesson — run the check now before publishing | `packages/node/src/teach.ts` |
| `checks_failed` | `409` | this lesson changed answers to unrelated questions or to the knowledge it builds on | `packages/node/src/teach.ts` |
| `consent_required` | `400` | both consent boxes are required | `packages/node/src/teach.ts` |
| `dataset_declaration` | `400` | tell us where these \<rows> questions come from (own work, a public source, or licensed to you) | `packages/node/src/teach.ts` |
| `dataset_derivative_only` | `403` | sign the request with a teaching key | `packages/node/src/api.ts` |
| `dataset_derivative_only` | `403` | this training set is available to people building on this knowledge — sign the request with a teaching key to preview it, and ask for a derive token to fetch it | `packages/node/src/api.ts` |
| `dataset_empty` | `400` | a dataset needs at least one question | `packages/node/src/teach-datasets.ts` |
| `dataset_empty` | `400` | a dataset needs at least one question and answer | `packages/node/src/teach-datasets.ts` |
| `dataset_empty` | `400` | after that change the dataset has no usable questions | `packages/node/src/teach-datasets.ts` |
| `dataset_empty` | `400` | read that way, the file has no usable questions | `packages/node/src/teach-datasets.ts` |
| `dataset_empty` | `400` | this dataset has no questions left on this node | `packages/node/src/teach.ts` |
| `dataset_format` | `409` | the original file is no longer on this node — upload it again | `packages/node/src/teach-datasets.ts` |
| `dataset_hash` | `400` | the file changed while it was being uploaded — try again | `packages/node/src/teach-datasets.ts` |
| `dataset_in_use` | `409` | only a dataset that has never been trained can be re-read — make a copy instead | `packages/node/src/teach-datasets.ts` |
| `dataset_in_use` | `409` | this dataset is being trained right now — make a copy to edit it | `packages/node/src/teach-datasets.ts` |
| `dataset_not_found` | `404` | no sample dataset called "\<kind>" | `packages/node/src/teach-datasets.ts` |
| `dataset_not_found` | `404` | no such dataset on this node | `packages/node/src/teach-datasets.ts` |
| `dataset_not_found` | `404` | that dataset was deleted | `packages/node/src/teach.ts` |
| `dataset_not_found` | `404` | the questions of this dataset are no longer on this node | `packages/node/src/teach-datasets.ts` |
| `dataset_not_found` | `409` | this lesson has no dataset to train again | `packages/node/src/teach.ts` |
| `dataset_not_text` | `400` | this does not look like a text file — read as \<parsed.encoding>, \<why>. If it is a spreadsheet, export it as CSV first; if the encoding is the problem, name it and try again. | `packages/node/src/teach-datasets.ts` |
| `dataset_pii` | `400` | rows … look like personal information (…) — remove them, or keep the training set private | `packages/node/src/teach.ts` |
| `dataset_private` | `403` | the creator kept the training set private | `packages/node/src/api.ts` |
| `dataset_private` | `403` | the creator kept the training set private — only the verification questions on the record are public | `packages/node/src/api.ts` |
| `dataset_private` | `403` | the creator kept the training set private, so nobody can build on it | `packages/node/src/api.ts` |
| `dataset_private` | `403` | the creator of \<id> kept the questions private, so nobody can copy or build on them | `packages/node/src/teach.ts` |
| `dataset_too_large` | `400` | this node teaches up to \<cap> questions in one lesson | `packages/node/src/teach.ts` |
| `dataset_too_large` | `413` | this node accepts files up to … MB | `packages/node/src/teach-datasets.ts` |
| `dataset_unavailable` | `404` | \<id> has no published training set — there is nothing to copy | `packages/node/src/teach.ts` |
| `dataset_unavailable` | `404` | the training set of \<entry.anchor.id> is not on this node and no peer holds it (…) | `packages/node/src/teach.ts` |
| `dataset_unavailable` | `404` | the training set of \<input.patchId> has no questions on this node | `packages/node/src/teach-datasets.ts` |
| `dataset_unavailable` | `404` | this knowledge has no published training set | `packages/node/src/api.ts` |
| `dataset_unavailable` | `404` | training set not available on this node (no peer holds it) | `packages/node/src/api.ts` |
| `invalid` | `400` | \<bad> | `packages/node/src/teach.ts` |
| `invalid` | `400` | \<badName> | `packages/node/src/teach.ts` |
| `invalid` | `400` | 1..\<c.factsPerJob> corrections per lesson | `packages/node/src/teach.ts` |
| `invalid` | `400` | at most 3 context knowledges | `packages/node/src/teach.ts` |
| `invalid` | `400` | child_key must be the teaching key that signed this request | `packages/node/src/api.ts` |
| `invalid` | `400` | declaration.source must be own, public or licensed | `packages/node/src/teach.ts` |
| `invalid` | `400` | payout_address cannot be this node's own address | `packages/node/src/teach.ts` |
| `invalid` | `400` | payout_address must be an AIN address | `packages/node/src/teach.ts` |
| `invalid` | `400` | price must be a non-negative number | `packages/node/src/teach.ts` |
| `invalid` | `400` | there is no question #\<op.index> in this dataset | `packages/node/src/teach-datasets.ts` |
| `invalid` | `400` | those are the same knowledge | `packages/node/src/teach.ts` |
| `invalid` | `400` | two knowledges are needed to combine | `packages/node/src/teach.ts` |
| `invalid_signature` | `401` | download token missing, wrong or expired — make a new link from Your knowledge | `packages/node/src/api.ts` |
| `invalid_signature` | `401` | the claim signature does not verify for this teaching key | `packages/node/src/teach.ts` |
| `invalid_signature` | `401` | x-ainize-auth header missing, expired or invalid | `packages/node/src/api.ts` |
| `invalid_signature` | `401` | x-ainize-auth header missing, expired, replayed or invalid (`<address>:<ts>:<sig>:v2` over "teach:\<node>:\<METHOD>:\<path>:\<ts>[:\<sha256 body>]", or the legacy `teach:<ts>` form) | `packages/node/src/api.ts` |
| `job_not_ready` | `409` | draft is missing | `packages/node/src/teach.ts` |
| `job_not_ready` | `409` | knowledge file is missing | `packages/node/src/teach.ts` |
| `job_not_ready` | `409` | knowledge file is not registered on this node | `packages/node/src/teach.ts` |
| `job_not_ready` | `409` | lesson is \<j.status> | `packages/node/src/teach.ts` |
| `job_not_ready` | `409` | lesson is \<j.status> and cannot be re-checked | `packages/node/src/teach.ts` |
| `job_not_ready` | `409` | the draft carries no verified claim by the owner's teaching key | `packages/node/src/teach.ts` |
| `job_not_ready` | `409` | the owner has not published this lesson (it is \<j.status>) — only lessons submitted for review can be approved | `packages/node/src/teach.ts` |
| `job_not_ready` | `409` | this lesson has no knowledge file yet | `packages/node/src/teach.ts` |
| `job_not_ready` | `409` | this lesson has not been measured in the live model yet — run a re-check first | `packages/node/src/teach.ts` |
| `job_not_ready` | `409` | this lesson was already checked in the live model | `packages/node/src/teach.ts` |
| `knowledge_not_held` | `400` | "\<id>" is listed on this node but its file is not here — get it first (\<price>), then teach on top of it | `packages/node/src/teach.ts` |
| `lineage_disabled` | `403` | building on top of another knowledge is not enabled on this node yet (config teach.lineage) | `packages/node/src/teach.ts` |
| `lineage_disabled` | `403` | combining two knowledges is not enabled on this node yet (config teach.lineage) | `packages/node/src/teach.ts` |
| `lineage_disabled` | `403` | copying another knowledge's questions is not enabled on this node yet (config teach.lineage) | `packages/node/src/teach.ts` |
| `merge_not_available` | `400` | combining two knowledges is not available on this node yet — build on one of them | `packages/node/src/teach.ts` |
| `merge_unresolved` | `409` | \<unresolved.length> question(s) are answered differently by \<A.id> and \<B.id> — choose an answer for each one before building | `packages/node/src/teach.ts` |
| `not_claimed` | `409` | this node has no operator password yet — set one on the machine it runs on (`ainize login`), or POST /api/auth/setup with the one-time token in AINIZE_HOME/setup-token | `packages/node/src/api.ts` |
| `not_owner` | `403` | this lesson belongs to a different teaching key | `packages/node/src/api.ts` |
| `nothing_to_add` | `400` | combining these two would leave no questions at all | `packages/node/src/teach.ts` |
| `nothing_to_add` | `400` | combining these two would teach nothing new | `packages/node/src/teach.ts` |
| `parent_not_listed` | `400` | publish \<b.patch_id> first — it is the base of this lesson | `packages/node/src/teach.ts` |
| `publish_disabled` | `403` | this node accepts lessons but does not publish them | `packages/node/src/teach.ts` |
| `published_immutable` | `409` | published knowledge cannot be deleted | `packages/node/src/teach.ts` |
| `quota_bytes` | `429` | you have uploaded as much as this node accepts from one teaching key today | `packages/node/src/teach-datasets.ts` |
| `quota_chat` | `429` | free live-test quota exhausted for this hour (this pre-flight needs \<units> unit(s)) — try again later | `packages/node/src/api.ts` |
| `quota_chat_network` | `429` | this network has used all … free live tests for this hour — everyone sharing this address shares them | `packages/node/src/api.ts` |
| `quota_dataset` | `429` | \<c.perKeyPerDay> new datasets per day for one teaching key | `packages/node/src/teach-datasets.ts` |
| `quota_dataset` | `429` | this node keeps \<c.keptPerKey> datasets for one teaching key — delete one first | `packages/node/src/teach-datasets.ts` |
| `quota_ip` | `429` | daily lesson limit (\<c.jobsPerIpPerDay>) reached for this address — resets … | `packages/node/src/teach.ts` |
| `quota_key` | `429` | daily lesson limit (\<c.jobsPerKeyPerDay>) reached for this key — resets … | `packages/node/src/teach.ts` |
| `quota_key` | `429` | you already have \<mineActive> lesson(s) in progress on this node — wait for them to finish | `packages/node/src/teach.ts` |
| `quota_requests` | `429` | too many requests from here this hour | `packages/node/src/api.ts` |
| `quota_rows` | `429` | this address has \<q.rows_ip_remaining> of … questions left to teach on this node today | `packages/node/src/teach.ts` |
| `quota_rows` | `429` | you have \<q.rows_remaining> of … questions left to teach on this node today | `packages/node/src/teach.ts` |
| `rate_limited` | `429` | too many datasets from this address in the last minute | `packages/node/src/teach-datasets.ts` |
| `rate_limited` | `429` | too many policy calls from this address | `packages/node/src/teach.ts` |
| `row_not_found` | `404` | none of those lines are refused rows of this dataset | `packages/node/src/teach-datasets.ts` |
| `setup_local_only` | `403` | this node has no operator password yet, and it can only be claimed from the machine it runs on — run `ainize login` there, or send the one-time token in its AINIZE_HOME/setup-token as the x-setup-token header | `packages/node/src/api.ts` |
| `subscription_incomplete` | `409` | \<failed.length> of … item(s) could not be acquired, so \<branch> was NOT subscribed to and this node is not advertised as serving it. …… | `packages/node/src/market.ts` |
| `subscription_unpaid` | `402` | … | `packages/node/src/market.ts` |
| `teaching_disabled` | `403` | this node does not accept lessons | `packages/node/src/teach.ts` |
| `teaching_disabled` | `503` | the teach worker is not running on this node | `packages/node/src/api.ts` |
| `tier_not_allowed` | `400` | … | `packages/node/src/teach.ts` |
| `tier_not_allowed` | `400` | … % of the \<rows.shared> rows these two both write hold different values — combining them has to be a full rebuild from the combined questions | `packages/node/src/teach.ts` |
| `too_many_attempts` | `429` | \<rec.n> wrong passwords from this address — wait \<wait>s before trying again. If you have forgotten it, run `ainize password --reset` on the machine this node runs on. | `packages/node/src/api.ts` |
| `too_many_bases` | `400` | one base to build on (two only for a merge) | `packages/node/src/teach.ts` |
| `trainer_paused` | `503` | … | `packages/node/src/teach.ts` |
| `trainer_paused` | `503` | \<rowsWaiting> questions are already waiting on this node — try again later | `packages/node/src/teach.ts` |
| `trainer_paused` | `503` | the training queue is full — try again later | `packages/node/src/teach.ts` |
| `turn_unknown` | `404` | that live test is not one this node remembers for you (it may have been restarted) | `packages/node/src/api.ts` |
| `undeclared_parent` | `400` | the questions of this lesson came from \<dataset.parent_patch>; a lesson built on them must name it as its base. Re-train the dataset with that knowledge as the base before publishing. | `packages/node/src/teach.ts` |
| `undeclared_parent` | `400` | these questions came from … — a lesson trained on them has to say so, or its creator is paid nothing. Train it on top of that knowledge (`--on <dataset.parent_patch>`, or "builds on" in the browser). | `packages/node/src/teach.ts` |
| `unknown_knowledge` | `400` | this node does not have "\<id>" — check the id, or teach on a node that holds it | `packages/node/src/teach.ts` |

## Messages without a code

Not every error carries a code. 42 raise a plain sentence and are told apart by their status — these are written for a person reading them, so match on the status, never on the words.

A further 27 throw sites build their message at the time (a validator's own wording, a peer's answer); they answer with the statuses above.

| HTTP | Message | Raised in |
|---|---|---|
| `null` | … (retrying for … more min before hash-only fallback) | `packages/node/src/verifier.ts` |
| `null` | runtime unavailable (…) — waiting up to … min before hash-only fallback | `packages/node/src/verifier.ts` |
| `400` | \<label> must be a non-negative number (e.g. "0", "0.1", "25") | `packages/core/src/catalog.ts` |
| `400` | a dispute has to say what did not work — at least \<DISPUTE_MIN_REASON> characters (this is a permanent public record, and the seller answers it on the same record) | `packages/node/src/market.ts` |
| `400` | answering a dispute needs the settle_hash of the sale it is about | `packages/node/src/market.ts` |
| `400` | at most \<MAX_CHAT_PATCHES> knowledges can be loaded together | `packages/node/src/market.ts` |
| `400` | at most \<MAX_CONTRIBUTORS> contributors per patch | `packages/core/src/catalog.ts` |
| `400` | contributor must be an object | `packages/core/src/catalog.ts` |
| `400` | contributor shares add up to more than 1 | `packages/core/src/catalog.ts` |
| `400` | contributor.address must be an AIN address (0x + 40 hex) | `packages/core/src/catalog.ts` |
| `400` | contributor.address must not be this node's own address | `packages/node/src/market.ts` |
| `400` | contributor.name must be a string of at most 40 chars | `packages/core/src/catalog.ts` |
| `400` | contributor.share must be a number between 0 and 1 | `packages/core/src/catalog.ts` |
| `400` | contributor.sig must be a string | `packages/core/src/catalog.ts` |
| `400` | contributor.signer must be an AIN address | `packages/core/src/catalog.ts` |
| `400` | contributors must be an array | `packages/core/src/catalog.ts` |
| `400` | duplicate contributor address: \<c.address> | `packages/core/src/catalog.ts` |
| `400` | origin must be "operator" or "teach" | `packages/node/src/market.ts` |
| `400` | unsupported contributor proof: … | `packages/core/src/catalog.ts` |
| `400` | unsupported contributor role: … | `packages/core/src/catalog.ts` |
| `400` | visibility must be "public" or "test" | `packages/node/src/market.ts` |
| `401` | operator login required | `packages/node/src/api.ts` |
| `401` | wrong password | `packages/node/src/api.ts` |
| `402` | payment required: buy the patch via /x402/patch/:id (its author, a buyer holding a download token, and a verifier while it is being verified can fetch it) | `packages/node/src/api.ts` |
| `403` | only the branch owner can add patches | `packages/node/src/market.ts` |
| `403` | only the owner of \<name> (\<b.owner>) can archive it | `packages/node/src/market.ts` |
| `403` | only the owner of \<name> (\<b.owner>) can set what it costs | `packages/node/src/market.ts` |
| `403` | this payout is owed to a different address | `packages/node/src/payouts.ts` |
| `404` | patch not found | `packages/node/src/api.ts` |
| `404` | payout \<id> not found | `packages/node/src/payouts.ts` |
| `409` | \<name> is curated by \<b.owner>, not by this node | `packages/node/src/api.ts` |
| `409` | \<name> is free to follow: it has no curation fee | `packages/node/src/api.ts` |
| `409` | not sold here; gateway is … | `packages/node/src/api.ts` |
| `409` | operator password already set | `packages/node/src/api.ts` |
| `409` | patch body not present on this node | `packages/node/src/api.ts` |
| `409` | payout \<id> is already paid (\<row.tx_hash>) | `packages/node/src/payouts.ts` |
| `409` | this payout was already sent (\<row.tx_hash>) | `packages/node/src/payouts.ts` |
| `423` | patch not listed yet (verification \<e.passed>/\<e.quorum>) | `packages/node/src/api.ts` |
| `499` | live test cancelled while it was still queued — the model was never called, so no free try was used | `packages/node/src/market.ts` |
| `503` | model unavailable, try again in a few minutes | `packages/node/src/runtime.ts` |
| `503` | runtime unavailable: … | `packages/node/src/teach.ts` |
| `503` | the patch hook could not be reached (ENGRAM_HOOK=1?) | `packages/node/src/api.ts` |
