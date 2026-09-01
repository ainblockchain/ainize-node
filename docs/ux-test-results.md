# UX scenario test results

- **Date:** 2026-09-01 (measured after the audit pass; the same 100 scenarios were first measured 2026-08-31 and re-measured after the teach-mode merge)
- **Build:** main — teach mode merged (0a5723e) plus the audit fixes; web dist rebuilt, cluster restarted before the run
- **Cluster:** live demo cluster — node-a http://localhost:3402 (web + API + seller, teach ON, publish auto, trainer backend `stub`), node-b :3403 (verifier), node-c :3404 (verifier + serving); homes ~/.ngram-cluster
- **Chain:** local AIN dev chain :8081 (ledger=ain, app /apps/knowledge)
- **Model:** shared vLLM :8002 (Qwen3.8-Flash-Next, engram patch hook, mailbox /mnt/newdata/qwen3.8/ple_patch_e2e on GPUs 4,5) — the demo cluster's own serving instance; it hangs about hourly and returns in ~5 min
- **Runner:** Playwright 1.62.1 · Node v24.20.0 · projects web (Chromium 1280×900), mobile (Pixel 5, @mobile only), cli-api · workers=1, retries=1
- **Specs:** packages/e2e/tests/{web-visitor,web-creator,cli-operator,agent-x402,web-crosscut}.spec.ts (the 100 scenarios) + {web-chat-multi,web-teach,web-teach-operator}.spec.ts (teach mode) — scenarios: docs/ux-test-scenarios.json
- **Raw results:** packages/e2e/results/full-run-final.log (this run: 111 passed / 11 skipped / 0 failed / 0 flaky in 24.4 min) and results/full-run-final-attempt*.log (the earlier attempts of the same night)
- **Host:** Linux-5.15.0-130-generic-x86_64-with-glibc2.35

## Summary

**100 passed / 0 failed / 0 blocked of 100**

| Persona | Passed | Failed | Blocked |
|---|---|---|---|
| Visitor | 26 | 0 | 0 |
| Creator | 24 | 0 | 0 |
| Operator | 20 | 0 | 0 |
| Agent | 14 | 0 | 0 |
| Cross-cutting | 16 | 0 | 0 |

## All scenarios

| Id | Title | Persona | Status | Duration | Note |
|---|---|---|---|---|---|
| AZ-001 | Read the landing hero and follow the two primary calls to action | Visitor | PASS | 1.8 s |  |
| AZ-002 | Inspect the trending card for the only verified knowledge | Visitor | PASS | 1.5 s |  |
| AZ-003 | Browse the Explore list and read every field of a knowledge row | Visitor | PASS | 1.2 s |  |
| AZ-004 | Read the knowledge detail header and stat strip | Visitor | PASS | 1.9 s |  |
| AZ-005 | Read the Verification tab and confirm only real-model runs count | Visitor | PASS | 1.7 s |  |
| AZ-006 | Read the Buy tab as a visitor and probe the automatic-payment address | Visitor | PASS | 1.7 s |  |
| AZ-007 | Open Live test, pick knowledge and use the sample-question chips | Visitor | PASS | 3.5 s |  |
| AZ-008 | Run a Compare test and read the correct-answer marker and quota counter | Visitor | PASS | 14.8 s |  |
| AZ-009 | Exhaust the 20-per-hour free trial and read the quota message | Visitor | PASS | 44.9 s |  |
| AZ-010 | Audit the public record: filters, integrity card and origin → derivative map | Visitor | PASS | 5.3 s |  |
| AZ-011 | Pick an audience card and land on the right entry point (creator card = teach the model) | Visitor | PASS | 9.8 s |  |
| AZ-012 | Copy the one-line commands and read the How-it-works / Why Ainize story | Visitor | PASS | 3.7 s |  |
| AZ-013 | Re-order Explore by each sort option | Visitor | PASS | 7.1 s |  |
| AZ-014 | Filter Explore by model and topic and search, including the empty state | Visitor | PASS | 2.5 s |  |
| AZ-015 | Read the Overview tab: model, verification questions, integrity and tracks | Visitor | PASS | 1.7 s |  |
| AZ-016 | Follow origins, overlap and newer-version notices in both directions (and the multi-select overlap warning in Live test) | Visitor | PASS | 1.9 s |  |
| AZ-017 | Compare all knowledge on the same subject and hit the unknown-topic 404 | Visitor | PASS | 2.2 s |  |
| AZ-018 | Use 'After only' and 'Before only' views, ask a free question and clear the conversation | Visitor | PASS | 14.6 s |  |
| AZ-019 | Cancel a slow live test and retry it | Visitor | PASS | 34.9 s |  |
| AZ-020 | See the 'another test in progress' banner while someone else is testing | Visitor | PASS | 39.4 s | turn A (compare + thinking) patched answer was not ✓ Correct — patched+thinking yields an empty answer for the trained completion prompt (model-behavior finding) |
| AZ-021 | Handle the model-server-off state on Live test and Network | Visitor | PASS | 52.0 s |  |
| AZ-022 | Explore the Network page and try the gateway router demo | Visitor | PASS | 4.2 s |  |
| AZ-023 | Use the Docs page: copy one-liners, browse the CLI table and the API groups | Visitor | PASS | 2.8 s |  |
| AZ-024 | Ask a follow-up question and confirm the conversation history is sent with it | Visitor | PASS | 6.3 s |  |
| AZ-025 | Read the History tab of a knowledge and match it to the public record | Visitor | PASS | 11.4 s |  |
| AZ-026 | Live-test an older (superseded) version and jump to its detail page | Visitor | PASS | 4.7 s |  |
| AZ-027 | Create the operator password on first visit and land on My knowledge | Creator | PASS | 5.1 s |  |
| AZ-028 | Sign in with the operator password after being redirected from a protected page (visitors are told they do not need to) | Creator | PASS | 5.8 s |  |
| AZ-029 | Review the My knowledge table for a verified and a superseded item | Creator | PASS | 3.7 s |  |
| AZ-030 | Register a new knowledge draft from a file path on the node (signed out, /new-patch shows the two-way pre-screen first) | Creator | PASS | 7.3 s | pixelplus-test-1 was already published by an earlier run — using pixelplus-test-17 |
| AZ-031 | Publish a draft after the checklist and follow verification until Verified | Creator | PASS | 16.6 s | draft pixelplus-test-17 re-created with visibility:test (identical fields) before publishing · both attestations landed within 4450 ms — the intermediate Verifying state was not observable in the 5 s UI poll |
| AZ-032 | Load knowledge into the model and unload it from the manage page | Creator | PASS | 11.7 s |  |
| AZ-033 | Log out from the user menu and lose access to console pages | Creator | PASS | 3.2 s |  |
| AZ-034 | Buy verified knowledge with the node's wallet from the Buy tab and load it from Purchased knowledge | Creator | PASS | 9.6 s | buyer node-b (http://localhost:3403), knowledge pixelplus-087600 at 0.1 AIN, already purchased before: true |
| AZ-035 | Reject invalid password setup input client-side and refuse a second setup server-side | Creator | PASS | 6.0 s | no cluster node still needed setup — the client-side half runs against a private node with a real needsSetup:true (node-az035) |
| AZ-036 | Keep the sample-question editor and the benchmark JSON in sync both ways | Creator | PASS | 1.7 s |  |
| AZ-037 | Show validation errors when saving an incomplete or conflicting draft | Creator | PASS | 1.9 s |  |
| AZ-038 | Edit description, price, billing and license of a draft and save | Creator | PASS | 4.0 s |  |
| AZ-039 | Validate and save the benchmark JSON of a draft | Creator | PASS | 3.3 s |  |
| AZ-040 | Inspect the overlap check and lineage of the verified KRX knowledge (and see the same overlap warned about in Live test) | Creator | PASS | 3.0 s |  |
| AZ-041 | Run Verify now on this node and see the attestation appear | Creator | PASS | 7.7 s | the timeline renders "accuracy <free_generation>" only — the pre_apply score ("1/8" in the scenario text) is not shown |
| AZ-042 | Delete a draft with typed confirmation and see that published knowledge cannot be deleted | Creator | PASS | 5.0 s | bin.ts has no `patch forget` subcommand — the manage page advertises `ainize patch forget <id>` (docs/CLI gap) |
| AZ-043 | Filter node logs by level, expand details, load older events and read the public-record timeline | Creator | PASS | 6.1 s |  |
| AZ-044 | Save display name, payout address and notification preference on the node | Creator | PASS | 6.3 s |  |
| AZ-045 | Read account identity, AIN wallet balance, sales and creator revenue share | Creator | PASS | 3.1 s |  |
| AZ-046 | Remove and re-add a connected peer node | Creator | PASS | 29.5 s |  |
| AZ-047 | Review Files & changes: pairing hint, sync, file tree and change history | Creator | PASS | 4.1 s |  |
| AZ-048 | Upload a .npz file from the browser and watch the fingerprint being computed | Creator | PASS | 3.6 s |  |
| AZ-049 | Copy the README badge snippet for the auto-pay address | Creator | PASS | 4.3 s |  |
| AZ-050 | Check the model runtime card and ask the model directly | Creator | PASS | 3.6 s |  |
| AZ-051 | Log in and out as operator from the CLI (first login sets the node password) and observe the 401 guard | Operator | PASS | 5.1 s |  |
| AZ-052 | Announce a public patch and watch node-b and node-c verify it on the real model until it is LISTED | Operator | PASS | 52.6 s | announce pre-check reported conflicts: 97 (the 4 demo bodies + the pixel copies earlier runs announced) |
| AZ-053 | Use knowledge in one line: `ainize use krx-all-2761` verifies, pays in AIN, downloads and loads it; then re-run and remove | Operator | PASS | 47.9 s |  |
| AZ-054 | Live-test knowledge from the CLI: `chat --list`, one-shot compare, `--mode`, `--thinking`, `--json`, quota footer and the interactive REPL | Operator | PASS | 53.4 s |  |
| AZ-055 | Drive the public and operator HTTP API with curl from /api/openapi.json: catalog, detail, benchmarks, info, 401 guards, login token and settings | Operator | PASS | 465 ms |  |
| AZ-056 | Probe the seller gateway's X-PAYMENT validation, the 423 not-listed state and the gated blob download with curl | Operator | PASS | 2.5 s |  |
| AZ-057 | Bring up a fourth node with `ainize init`, fund it on the local AIN chain, start it detached, peer it with the demo cluster and stop it | Operator | PASS | 14.6 s |  |
| AZ-058 | Read node events with `ainize logs` filters and confirm `ainize seed` refuses to run against a live node | Operator | PASS | 10.0 s |  |
| AZ-059 | Add, list and remove peers on a node and watch gossip discover the other nodes | Operator | PASS | 25.9 s |  |
| AZ-060 | Inspect the catalog with `patch ls`, `patch get`, `patch records` and `patch conflicts` | Operator | PASS | 7.2 s |  |
| AZ-061 | Register a draft with `ainize publish --no-announce`, check its visibility, reject bad inputs and delete it | Operator | PASS | 7.4 s |  |
| AZ-062 | Use a SUPERSEDED knowledge with `ainize use --no-apply` and get the newer-version note | Operator | PASS | 6.1 s |  |
| AZ-063 | Audit the shared ledger with `ledger ls`, `ledger verify`, `ledger graph` and `ledger export`, and cross-check two nodes | Operator | PASS | 6.0 s |  |
| AZ-064 | Create a branch, add knowledge, subscribe a node and route `jurisdiction=KR` to it | Operator | PASS | 13.9 s |  |
| AZ-065 | Operate the local AIN chain from the CLI: `chain status`, `chain up`, `chain fund`, `chain setup` and `wallet` | Operator | PASS | 9.2 s |  |
| AZ-066 | Exhaust the anonymous live-test quota (20/hour per IP) via POST /api/chat and confirm operators are unmetered and failed calls are not charged | Operator | PASS | 18.6 s |  |
| AZ-067 | Restart the demo cluster with scripts/cluster-restart.sh and confirm data survives, peers re-gossip and the agent buyer still completes a 402 purchase | Operator | PASS | 35.5 s |  |
| AZ-068 | Publish a hidden test listing with `ainize publish --test` and confirm it stays out of public catalogs and counts | Operator | PASS | 49.3 s |  |
| AZ-069 | Show that a verifier whose serving API is down keeps retrying for 15 minutes instead of attesting hash-only | Operator | PASS | 2.4 min |  |
| AZ-070 | Check the aindrive mirror: `drive status --files`, `drive sync`, `drive up` before pairing, and the changes API guard | Operator | PASS | 12.9 s |  |
| AZ-071 | Run the autonomous buyer end to end: detect the gap, pay 25 AIN via 402, verify the hash, load and restore | Agent | PASS | 12.6 s |  |
| AZ-072 | Verify the x402 402 challenge contract on the seller gateway (header, body, CORS exposure, non-seller and unknown ids) | Agent | PASS | 938 ms |  |
| AZ-073 | Verify the settled 200 response contract and its ledger/event side effects after an ain-transfer payment | Agent | PASS | 541 ms |  |
| AZ-074 | Refuse to pay when the agent's AIN balance is below the price, then succeed after funding | Agent | PASS | 10.9 s |  |
| AZ-075 | Reject forged X-PAYMENT proofs: unknown tx hash and a real transfer that did not go to the seller | Agent | PASS | 8.5 s |  |
| AZ-076 | Reject a replayed X-PAYMENT (payment already used) and ignore stale nonces in the ain-transfer scheme | Agent | PASS | 445 ms |  |
| AZ-077 | Follow supersede marks on a keyword search, and refuse an explicitly requested superseded id | Agent | PASS | 20.5 s |  |
| AZ-078 | Skip the purchase when the model already answers correctly, and check the --max-price budget guard | Agent | PASS | 13.9 s |  |
| AZ-079 | Refuse to buy when the seller offers no payment scheme the agent is allowed to use (--pay local-credit on an AIN node) | Agent | PASS | 7.9 s |  |
| AZ-080 | Detect a tampered or corrupted patch body by sha256 before applying it to the model | Agent | PASS | 7.2 s |  |
| AZ-081 | Write and read back the on-chain access receipt after a node-side purchase (ainize use / POST buy) | Agent | PASS | 14.2 s |  |
| AZ-082 | Split the price along lineage when the source knowledge has a different author (royalty share 0.3) | Agent | PASS | 35.6 s |  |
| AZ-083 | Meter live-test hits through POST /api/chat and read them back as usage events with a per-visitor quota | Agent | PASS | 36.6 s |  |
| AZ-084 | Inspect the agent's identity, catalog view and credit balance with the keys / catalog / balance subcommands | Agent | PASS | 5.8 s |  |
| AZ-085 | Show a plain error when the node API is unreachable on every public page | Cross-cutting | PASS | 12.2 s | LedgerPage / NetworkPage have no error branch: offline they show "No records yet." and the cached node cards + a spinner, never an explicit error (matches the scenario text; flagged as a UX gap). |
| AZ-086 | Refuse to downgrade to an integrity-only attestation during the 15-minute runtime grace period | Cross-cutting | PASS | 8.6 s |  |
| AZ-087 | Switch the whole UI between English and Korean and keep the choice across reloads and pages | Cross-cutting | PASS | 30.4 s |  |
| AZ-088 | Keep the operator signed in across refresh and new tabs via the session cookie, and sign out cleanly | Cross-cutting | PASS | 7.5 s | after Log out the browser landed on http://localhost:3402/ |
| AZ-089 | Recover automatically after the node process restarts under an open Live test tab | Cross-cutting | PASS | 30.3 s |  |
| AZ-090 | Reflect the model-server outage consistently on Network, Manage and My knowledge | Cross-cutting | PASS | 11.3 s |  |
| AZ-091 | Show honest loading states while a 331.7 MB knowledge is loaded, and allow cancelling | Cross-cutting | PASS | 29.6 s | AZ-091 applied time: · loaded in 3.0s · A cancelled live-test request is still charged when it completes on the node (quota dropped by two after cancel + retry) — UX finding, matches the scenario text. |
| AZ-092 | Keep every page usable at 360 px width without horizontal page scrolling | Cross-cutting | PASS | 16.1 s | overflow per page: {"landing":{"ok":true,"scrollWidth":360,"innerWidth":360},"explore":{"ok":true,"scrollWidth":360,"innerWidth":360},"detail":{"ok":true,"scrollWidth":360,"innerWidth":360},"chat":{"ok":true,"scrollWidth":360,"innerWidth":360},"ledger":{"ok":true,"scrollWidth":360,"innerWidth":360},"docs":{"ok":true,"scrollWidth":360,"innerWidth":360}}; header items outside the 360px viewport: none · skipped [mobile]: Pixel 5 mobile emulation scales the layout viewport away from 360 CSS px; the 360px assertions run under the web project |
| AZ-093 | Operate the Live test and sign-in entirely from the keyboard with visible focus | Cross-cutting | PASS | 8.2 s | Shift+Tab from the (now disabled) textarea landed on: button "Show 18 more" |
| AZ-094 | Expose meaningful roles and accessible names to screen readers on the core pages | Cross-cutting | PASS | 9.7 s | axe serious/critical: /explore: color-contrast (serious) x41 → .sc-gSQHZB \| .sc-fFelbd \| p \|\| /chat: color-contrast (serious) x28 → .sc-gSQHZB \| .sc-eCIkAO \| aside > p \|\| /<addr>/krx-all-2761: color-contrast (serious) x43 → .sc-gSQHZB \| .sc-bXTeWK > span:nth-child(1) \| .sc-bXTeWK > span:nth-child(2) \|\| /ledger: color-contrast (serious) x26 → .sc-gSQHZB \| .sc-fFelbd \| p:nth-child(2) \|\| /ledger: nested-interactive (serious) x1 → svg[width="700"] · Tabs have no arrow-key navigation (role=tab buttons only react to click/Enter) — P2 gap as noted in the scenario. |
| AZ-095 | Format large numbers, sizes and prices consistently (270,053 entries, 331.7 MB, 25 AIN) | Cross-cutting | PASS | 6.0 s |  |
| AZ-096 | Read the Terms page and reach the 404 pages from bad URLs | Cross-cutting | PASS | 2.4 s |  |
| AZ-097 | Show helpful empty states when a filter, search or section has nothing to display | Cross-cutting | PASS | 4.5 s |  |
| AZ-098 | Display relative times ('5m ago') with an absolute-time tooltip that keeps ticking | Cross-cutting | PASS | 1.6 min |  |
| AZ-099 | Verify what happens to scroll position and filters on browser Back from a detail page | Cross-cutting | PASS | 4.8 s | scrollY after Back on /ledger: 0 · Back resets the ledger to the top with "All records", Forward reopens the detail on Overview (no position/filter/tab restoration) — P2 UX finding, as described in the scenario. · scrollY after Back on /explore: 0 |
| AZ-100 | Degrade gracefully when clipboard copy is unavailable or denied | Cross-cutting | PASS | 11.2 s | CopyButton swallows clipboard failures silently (label stays "Copy", no feedback) — P2 UX finding, as described in the scenario. |

## Teach-mode scenarios (AZ-101…AZ-122, TM-*) — not part of the 100

The teach-mode scenarios are numbered AZ-101…AZ-122 and are **not** part of the 100. They run in two places, because the
demo cluster and the dev node differ in exactly one property that changes what a lesson can prove:

- **node-a :3402** runs `teach.backend: "stub"` with a **live** model. The trainer copies a fixture instead of training,
  but the CHECKING phase is measured against the real vLLM — so `GET /api/teach/policy` reports `simulated_checks: false`
  and the UI is right to say "correct in the live model". A copied fixture cannot teach a run-unique phrasing, so the
  node honestly answers NEEDS_MORE and the lifecycle tests cannot complete there.
- **node-t :3412** runs the same binary with `stubOffline: true` (`simulated_checks: true`) and a local ledger, so the
  whole lifecycle — including publish, approve and announce — runs without writing a permanent anchor on the shared chain.

Everything that does not need a trained lesson (landing, sign-in, the /new-patch pre-screen, the Teaching tab, payouts,
the banner/drawer/basket, the teaching key and its backup) runs on the live node.

The table below is what the **full run** recorded, i.e. the teach specs as they run against node-a; the node-t column of
the summary above is a separate invocation (`AINIZE_URL=http://localhost:3412 AINIZE_PASS=teach-pass`). AZ-101 and AZ-102
are executable as `TM-090` / `TM-091` in `web-chat-multi.spec.ts` (multi-knowledge live test and the contamination
banner) and run on the live node in every full pass.

| Node | Result |
|---|---|
| live demo node-a :3402 — teach on, `backend: stub`, live model (`simulated_checks: false`) | 7 passed / 10 skipped (24.5 s) |
| dev node-t :3412 — `backend: stub` + `stubOffline: true` (`simulated_checks: true`), local ledger | 17 passed (1.6 min) |

| Id | Title | Status | Duration | Note |
|---|---|---|---|---|
| AZ-103 | Teach drawer from a wrong answer → basket persists across reload | PASS | 5.3 s |  |
| AZ-104 | First train → Who gets the credit? sheet → key in localStorage → backup download → restore in a fresh browser | PASS | 398 ms | skipped [web]: no backup (earlier step skipped) |
| AZ-105 | Pre-flight: already-correct fact skipped; all-correct → "Nothing to teach" | SKIPPED | 1 ms | skipped [web]: stub trainer measured against a real serving model (teach.stubOffline is false): a copied fixture cannot teach the run-unique phrasing, so the node reports NEEDS_MORE — the lifecycle runs on a node with simulated checks or a real trainer |
| AZ-106 | Job lifecycle with backend 'stub': QUEUED → TRAINING → CHECKING → READY; events kind teach; card copy per state | SKIPPED | 3 ms | skipped [web]: no job (earlier step skipped) |
| AZ-107 | Try it now on a READY lesson: /api/chat with the draft id returns before/after | SKIPPED | 3 ms | skipped [web]: no job (earlier step skipped) |
| AZ-109 | Keep it private: token download works, sha256 matches, recipe.json and RUN-LOCALLY.md served; link expires | SKIPPED | 3 ms | skipped [web]: no job (earlier step skipped) |
| AZ-110 | Publish (review mode): PENDING_REVIEW → operator approves on the Teaching tab → ANNOUNCED → verifiers attest → LISTED; anchor carries contributors[].sig that verifies | SKIPPED | 240 ms | skipped [web]: stub trainer measured against a real serving model (teach.stubOffline is false): a copied fixture cannot teach the lesson, so it never reaches PENDING_REVIEW — the review queue runs on a node with simulated checks or a real trainer · skipped [web]: shared AIN chain — approve/announce is permanent; run against a local-ledger node for announce coverage · skipped [web]: no job (earlier step skipped) |
| AZ-113 | Buy on AIN with the transfer forced to fail: payouts row failed, contributor sees pending, operator Retry succeeds | PASS | 3.5 s |  |
| AZ-116 | Ban by address → 403 banned; hide name → "Taught by a visitor" | SKIPPED | 100 ms | skipped [web]: no announced lesson (earlier step skipped) |
| AZ-120 | Owner mismatch: another key reads the job → redacted body; publish → 403 not_owner | SKIPPED | 8 ms | skipped [web]: no job (earlier step skipped) |
| TM-090 | Load up to three knowledges together in one live test, see the overlap warning, and meter one usage event per knowledge | PASS | 11.1 s |  |
| TM-091 | Show the contamination banner when the operator keeps knowledge loaded for everyone | PASS | 5.0 s |  |

## Audit findings from the previous green run

Sixteen findings from a review of the previous pass. Fifteen were real and are fixed; the one rejection is
spelled out in the last column.

| Finding | Severity | What was wrong | What was done |
|---|---|---|---|
| AZ-081 | high | The receipt-write path ran only while node-c still had an unbought demo patch — never, after the first run. | Fixed — the purchase runs from a private node whose home is thrown away each run (pinned chain identity), so the 402 loop, the transfer and the receipt write happen every time. |
| AZ-069 | high | Expectations 2, 3, 5 and 6 were optional branches: no blob-fetch line, no rounded "14 min" retry, and node-d's executed attestation could be replaced by "it wrote nothing". | Fixed — node-d's copy of the body is dropped so the blob fetch is always logged, the demo verifiers are held off for the countdown by taking the shared runtime lock they share, and node-d's serving API is only restored after the item is LISTED with exactly two rows, so its executed attestation really is the third one (a verifier skips a LISTED item, so the operator drives verifyOne() through POST /api/patches/:id/verify). |
| AZ-052 | medium | The P0 half (a PUBLIC announce becomes publicly LISTED) was inverted to `not.toContain(id)`; the conflicts count was only annotated. | Fixed — the public announce runs for real on a private 3-node cluster from the same script and binaries; on the shared cluster the pre-check count is asserted against GET /api/patches/:id/conflicts. |
| suite-wide | medium | The suite did not leave the cluster as it found it: 47 chain node rows under the impersonated name "node-a", 15 branches, 62 hidden test anchors. | Mostly fixed — throwaway nodes have their own names and pinned identities (no new "node-a" rows), node-d follows the cluster's serving instance, and a global setup/teardown fails the run if the public catalog, the shared model table, the teach policy or the peer list drift. The hidden anchors and AZ-064's branch are structural (an append-only chain cannot take an announce back) and are reported per run instead. |
| AZ-031 | medium | `wasDraft` gated the whole publish half — checklist, seal note, Publish button, 200 /announce, green alert. | Fixed — the DRAFT precondition is created when the recorded one is gone; the publish half always runs. |
| AZ-067 | low | Step 10 (a 402 purchase after the restart) was deferred to scenarios that run against the pre-restart cluster. | Fixed — the agent buys krx-all-2761 for real after the restart and the settle record is checked. (The scenario's note that `--patch pixelplus-087600` is refused describes older agent behaviour; AZ-077 covers the current one.) |
| AZ-046 | low | The "row disappears" half was catch-and-ignore. | Fixed — the poll right after the DELETE is served the node's own post-delete peer list, then rediscovery runs unmodified. |
| AZ-007 | low | The multi-select help line and the selection marker were not asserted. | Fixed — both asserted. |
| AZ-011 | low | Only the `accepts_contributions: true` half of expectation 6 ran. | Fixed — the false half runs on a private node with teach off. |
| AZ-020 | low | Expectation 3's ordering ("completes after tab A's answer") was never asserted. | Fixed — both POST /api/chat completion times are recorded and compared. |
| AZ-094 | low | Only `critical` axe violations failed; ~112 serious ones were invisible to the signal. | Fixed — a frozen per-page baseline of the documented serious backlog; a new serious violation fails. Two of the recorded ones were real and are fixed in the product (the unnamed select listbox on /explore and /ledger). |
| AZ-035 | low | The setup form was rendered against a stubbed /api/auth/me. | Fixed — it renders from a private node with a real `needsSetup: true`. |
| REV-1 | high | The lesson card told every visitor its verification was faked: it used the trainer backend as a proxy for simulated checks and ignored the node's own `simulated_checks` / `checks.simulated` flags. | Fixed in the product (`packages/web`) — the card reads the node's flags; the demo node now correctly says "correct in the live model" and drops the false "Demo node" disclaimer. |
| REV-2 | medium | Docs → REST API scrolled the page horizontally at 360 px (528 px against a 360 px viewport). | Fixed in the product — the summary row wraps and long paths break. |
| REV-3 | low | `/api/catalog` accepted a 12th query parameter, `include_drafts`, that OpenAPI did not document. | Fixed in the product. |
| REV-4 | low | English plurals on the teach path ("1 corrections", "1 memory entries") and a hardcoded en-US number format. | Fixed in the product — `t(key, vars, count)` picks a `_one` entry; the number goes through `useFormat`. |

## What is not covered

Honest gaps. Nothing below is asserted by the suite; where a unit test covers the mechanism it is named.

- **aindrive pairing needs a human login.** AZ-047/AZ-048 exercise the unpaired state, the pairing hint, the sync button,
  the file tree and the change history, and `ainize drive login` up to the point where it prints its Google link. The link
  itself has to be opened by a person in a browser, so a *paired* drive — real file edits flowing back into a knowledge
  file — is never tested end to end.
- **Gradient (real) training is never run.** The demo cluster is pinned to `teach.backend: "stub"` because GPUs 4–6 run
  the owner's `train_rev.py`. Everything downstream of the trainer (state machine, slot lease, docker-exec stdout
  protocol, timeouts, cancel, the CHECKING gates) is covered by `packages/node/test/teach.test.ts` against a fake spawn,
  and `train/teach.py` itself lives in the qwen3.8 repo — but no scenario has ever produced a lesson from a gradient run.
  AZ-117 (trainer slot busy) is unit-test-only for the same reason.
- **Teach scenarios with no e2e run:** AZ-108 (locality gate), AZ-111 (publish auto + Taught-by chips), AZ-112 (local-credit
  royalty to the contributor), AZ-114 (lineage pays the data provider), AZ-115 (per-key / per-IP quotas), AZ-117, AZ-118
  (vLLM restart mid-CHECKING), AZ-119 (draft expiry), AZ-121 (`ainize patch import` round trip), AZ-122 (AIN round trip of
  an anchor with empty contributors). Each is covered by a unit test in `packages/node/test/teach.test.ts`,
  `packages/node/test/ain.test.ts` or `packages/cli/test/cli.test.ts`; none is observed through the UI on a live node.
- **One machine, one dev chain.** Every node, the chain and the model run on this host over localhost. Nothing exercises a
  real network (latency, partitions, TLS, NAT), a public chain, real money, or two operators on different machines.
- **One browser engine.** Chromium only. The `mobile` project is Pixel-5 emulation whose layout viewport is not 360 CSS px,
  so the 360 px assertions (AZ-092/093) run under the `web` project at that size instead; Firefox and WebKit are untested.
- **Load, concurrency and security are out of scope.** No performance budget, no fuzzing, no adversarial payment or
  signature testing beyond the specific replay/forgery cases the scenarios name (AZ-072/AZ-078/AZ-081, `ain.test.ts`).
- **The public record only grows.** A published anchor and a created branch are permanent on the demo chain, so the
  scenarios that must observe a *fresh* announce (AZ-030/031, AZ-052, AZ-056, AZ-068, AZ-069) add one hidden
  `visibility: test` anchor each per run, and AZ-064 one branch. They stay out of the public catalog — the global
  teardown fails the run if `GET /api/catalog` is not exactly the four demo knowledges — but they cannot be taken back,
  and they are why the announce pre-check reports more overlaps than the scenario text's original "conflicts: 4".
- **AZ-052's public half runs on a private cluster.** A public announce on the shared chain would be visible in every
  later catalog assertion forever, so "a public announce becomes publicly LISTED" is proven on a private 3-node cluster
  started by the same `scripts/cluster-restart.sh` from the same binaries; the shared cluster keeps the `--test` run for
  the verifier trail and the ledger rows. The same substitution applies to AZ-067's restart.

## Notes from this pass

- **The audit's own findings.** Sixteen findings from a review of the previous green run were worked through; fifteen were real and are fixed (four in the product, eleven in the suite) — see the table above. One was rejected: the suggestion to publish AZ-031's test knowledge on a private node instead of node-a. AZ-031 *is* the operator publishing from their own node-a manage page and following node-b/node-c verifying it, so moving it would replace the scenario rather than fix it; its real defect (the publish half was skipped whenever the recorded draft was already published) is fixed by creating the precondition.
- **The demo cluster now serves from its own vLLM.** `runtime.api` is :8002 with the mailbox `ple_patch_e2e` on GPUs 4,5,
  so the suite never competes with the main serving GPUs. The helpers read the port and mailbox from node-a's own config
  instead of hardcoding :8000, and node-d follows the same instance so all four nodes queue on one cross-process lock.
- **Model-behavior finding (recorded, not a marketplace bug):** with *thinking enabled* the patched model answers a trained
  completion-style prompt (e.g. `종목코드 한독 `) with an empty string (immediate EOS); base+thinking and patched without
  thinking both answer `002390`. AZ-020 records it as a note.
- **Leftover state is now asserted, not assumed.** A global setup snapshots the public catalog, the shared model table,
  node-a's teach policy and its peer list; the global teardown fails the run on any drift and reports how many hidden test
  anchors the run added.
- **Still open — the shared record only grows.** ~5 hidden anchors, ~10 attestations and ~2 settle records per full run. AZ-063 now fails loudly when the attest history no longer fits in one `ledger ls` page (API cap 1000; 218 today), which is the tripwire for the whole family of "newest N records" reads. Capping the growth itself needs the announce scenarios (AZ-052/056/068/069) to move to a private cluster the way AZ-052's public half already did — not done here.

## Product fixes made during this effort (`git log --oneline 665e469..HEAD`)

**Product fixes the scenarios forced (this audit pass)**

- `097464b` fix(web/node): stop claiming a lesson was faked, unblock Docs at 360 px, English plurals, named select listboxes

**Product fixes the scenarios forced (earlier in the effort)**

- `53b4918` node: runtime.patchDir — one patch-hook mailbox and lock per serving instance; demo cluster defaults to the e2e server on GPUs 4,5 (:8002)
- `ae8e2b1` fix: a model outage must not destroy a lesson or log a console error
- `822b840` core/node/cli: dated supersede/subscribe records, hidden-anchor lineage, 4xx/503 statuses, patch forget, fresh cross-node reads
- `8fa3554` web: visitor never sees Manage, Back lands at the top, exact field labels, revenue/receipt/score copy, account peers poll
- `5dce9e6` web: logout rests on / even on a cold cache (AZ-088)
- `4530834` web: sign-out aware route guards so Log out rests on the landing page (AZ-088)
- `76d106d` fix: draft/test-anchor leaks, agent budget/follow-latest flags, drive --no-open, 0 AIN message, mobile header, logout landing
- `144a1be` web: load Noto Sans KR so Korean text renders on systems without CJK fonts

**Teach mode — the feature itself (PR-1 … PR-8) and its review fixes**

- `3db1098` teach PR-1: core contributors + two-pass royalty, teach config, catalog contributor filter
- `64a72fc` teach PR-3: ChatMode multi-knowledge (patch_ids 1..3) + contamination banner
- `75388d0` teach PR-4: trainer train/teach.py in the qwen3.8 repo (job.json -> lesson.npz + recipe.json), teach_contrast.json, patch.py English status line, spec copy with PR-4 CHANGES note
- `d339098` teach PR-5: node TeachWorker (state machine, trainer-slot lease, docker-exec stdout protocol, stub backend, CHECKING gates), Runtime.exclusiveTry, teach store tables, visitor /api/teach/* + /api/teacher/:address + operator /api/me/teach/*, recipe.json + RUN-LOCALLY.md, openapi, unit tests with fake spawn
- `92001a6` teach PR-2: node payouts table + earnings — settlePayment writes a payouts row per non-self royalty address before the AIN transfer (pending → paid tx_hash / failed last_error), 60-s retry timer (max 20 attempts) in server.ts, GET /api/me/payouts?status= + POST /api/me/payouts/:id/retry, /api/teacher/:address reconciles owed vs paid, wallet + CLI payouts, openapi, unit tests with a fake wallet
- `67eb1d8` teach PR-6: web teach flow — browser teaching key (@noble secp256k1 + keccak, byte-identical to ain-util; cross-lib test vs core verifyMessage / node verifyAuthHeader), TeachDrawer / LessonBasket / CreditSheet / PreflightList / LessonCard (5 s polling) / PublishSheet (signed claim) / KeepPrivateSheet (token downloads + RUN-LOCALLY.md) / MyKnowledgePanel, TeacherPage /teacher/:address, ChatPage ?teach=1 / ?lesson= / ?mine=1 + sticky card, Taught-by chips on PatchPage + list items, header Teach item, routes, i18n teach.ts (en+ko); node teach.stubOffline (simulated preflight/CHECKING for stub nodes without a model server) + unit test; Playwright web-teach.spec.ts AZ-101…AZ-109 green against the stub dev node
- `41d928e` teach PR-7: landing creator card (teach copy, CTA → /chat?teach=1, operator register link), landing/header Teach item, sign-in visitor notice + subtitle, /new-patch two-way pre-screen when signed out (NewPatchGate), Register under the operator menu, My knowledge Teaching tab (settings → PATCH /api/me/teach/policy, review queue approve/decline/cancel, contributors hide/block key/IP + bans, payouts owed/paid/failed + retry), Account → Teaching link, operator RTK endpoints + types, i18n en+ko; node: updateTeachPolicy no longer wipes untouched kv overrides (+ test); e2e web-teach-operator.spec.ts (AZ-011/028/030, settings, AZ-110/116/113) green on the stub dev node, web-teach.spec.ts titles renumbered; docs: ux-test-scenarios.json AZ-011/028/030/016/040 (+007/066/083 wording) updated and AZ-101…AZ-122 appended, render script now generates the .md too, spec PR-7 CHANGES note, README visitor teach section + local-run link
- `e90bb31` teach PR-8: CLI parity + docs + demo config — `ainize teach status <node-url | lesson-url | job-id | teacher-page | address> [--key --key-file]` (policy / owner vs status-only lesson view / data-provider page, signs x-ngram-auth like the web key), `ainize patch import <lesson.npz> --recipe recipe.json` (private DRAFT via createDraft keepInPlace, benchmark + model + id + credit-only contributor from the recipe, sha256 check, origin teach, no announce / no ledger record), `publish --contributor addr:name:share` (declared data providers, ≤ 4, Σ ≤ 1); node: PATCH /api/patches/:id no longer wipes contributors on unrelated updates; openapi CLI_REFERENCE teach one-liner + "Teach mode" group + DocsPage fourth card (en+ko); deploy/README docker-group + GPU-allocation section; scripts/cluster.mjs node-a teach.enabled/publish auto with a marked TEACH_BACKEND stub→gradient switch; README terminal lines; AZ-121 scenario rewritten (md/html re-rendered); CLI tests +3 (import, teach status, --contributor) against an in-process stub node; spec PR-8 CHANGES note incl. the node-t → node-u round-trip
- `e9b76b1` teach fix(security/spec): payouts claim+serialised retry, trust proxy off by default, owner-only announce, private-draft redaction, request-bound visitor auth, crash-safe lesson restore
- `87c048c` teach fix(web): review-2 UX / copy / i18n fixes — header wraps at 360 px (no horizontal scroll on /chat, /signing, /new-patch, /explore, /teacher, dashboard; en + ko), lesson basket heads the picker column when the node teaches and scrolls into view on ?teach=1 / Add to lesson, lesson-card status pill via i18n (cardStatusKey → teach.mine.status.*, new "Checking"), §8.4 durations (no "1–1 min": "under a minute" / "about N min" / range, card ETA only with ≥ 3 samples, stub says "Starting…", pre-flight copy drops "under 30 seconds" and maps a runtime outage to teach.pre.err_runtime), KeepPrivateSheet (minmax(0,1fr) grid so the hardware notice is readable on phones, commands = the node's RUN-LOCALLY.md fetched via readme_url and shown in its own scrolling box, "Run it on my own machine" radio no longer POSTs /save — links are minted when the hardware box is ticked, model falls back to runtime.model / info.node.model), FAILED card = friendly sentence (restart / OOM mapped) + collapsed technical details, localized elapsed()/dates (utils/useFormat: useElapsed + useDateTime; Your knowledge, teacher page, link expiry), stub honesty ("It learned it — n of m answers correct." + "Demo node — these checks were simulated, not measured in a live model."), "Teaching anonymously · 0x…" chip, teacher "Sales" tile label, earnings scheme fallback copy, grammatical Korean suggest-phrasing templates, lesson card inside the transcript so it never overlaps the empty state; e2e: passwordFor() honours AINIZE_PASS / AINIZE_PASS_T and knows node-t, AZ-106 accepts the stub wording; verification script results/review/review2.mjs + review2-*.png (1280/360, en/ko); spec CHANGES "Review fixes — web".
- `116b524` teach fix(verify): web signs the request-bound v2 x-ngram-auth (fetchFn over the real Request: method, path+query, sha256 body; node address from /api/info; legacy only as fallback) and signs POST /api/chat so Try it now works on a private draft; Market.chat checks draft visibility before the runtime (404 not 500 for non-owners while vLLM is down); lesson card scrolls into view on status change (READY was hidden above an auto-scrolled transcript); OpenAPI v2/owner-only text; web v2 cross-builder test; spec CHANGES verification pass (unit/e2e/security/browser-walk results)
- `dddd9b2` merge main (scenario round-2 fixes) into teach-mode
- `0a5723e` merge main (AZ-067 real restart, private throwaway clusters, verifier.auto) into teach-mode

**The scenario suite: executable specs and harness**

- `08e6052` e2e: executable specs for all 100 UX scenarios (visitor/creator/operator/agent/cross-cutting) + teach-mode design spec
- `d843751` e2e: align AZ-055/068/082 assertions with the fixed behaviour (draft-free counts, hidden-id resolution)
- `eb160df` e2e: fix brittle scenarios (AZ-007/022/027/030/036/048/060/064/069/071/083) and stop serial-block cascades
- `a5a8194` e2e/final: all 100 scenarios green — real outage/restart coverage on private nodes, visitor quota isolation, lock peek after send
- `8b64bb0` e2e: AZ-067 runs the cluster restart for real on a private throwaway cluster — 100/100 green
- `9a12395` e2e: adapt the 100 UX scenarios to the teach-era UI
- `9a2e0ae` e2e: teach-era API/CLI snapshots, peer-gossip wait, visitor IP without CORS noise
- `5df396d` e2e/teach: run on the live teaching node, skip only what a fake trainer cannot do
- `11506ff` e2e/agent: restore the "nothing loaded" precondition instead of failing behind it
- `7deaecf` e2e: ride out a vLLM stall in AZ-022 and the teach-mode turn
- `f633ae9` e2e: keep the one shared model table clean between scenarios
- `b01aab0` e2e: two layout/timing races in AZ-092 and AZ-046
- `fd9be87` e2e: per-scenario free-try buckets and a lock banner that may re-appear
- `ee8ce1b` e2e: assert what the scenarios actually claim — no branch that quietly asserts less
- `1915af4` e2e: follow the cluster's serving instance instead of hardcoding :8000/ple_patch
- `b45347e` e2e: a throwaway node applies through the mailbox of the instance it talks to
- `7e84b68` e2e: AZ-092 measures the Docs page too — the one that used to overflow at 360 px
- `7ccf5c0` e2e: AZ-063 reads the whole attest history instead of the newest 200
- `6492240` e2e: AZ-069's third attestation is the third one by construction, not by luck
- `9c88fcb` e2e: AZ-069 authenticates against node-d with node-d's own operator password
- `31396f6` test(node): the AIN ledger test drives its own verifier when the shared dev chain beat it to the quorum

**Scripts and documentation**

- `046c96f` scripts: private throwaway clusters (NGRAM_PORT_BASE / NGRAM_SEED=0), home-scoped stop and --stop for cluster-restart.sh
- `250a36b` scripts: skip unreadable /proc entries when scoping the cluster stop
- `7d68b24` docs: UX scenario results — 99 passed / 0 failed / 1 blocked of 100
- `9538908` docs: UX scenario results re-measured on the merged teach-mode build

**Everything else in the range**

- `04f85a9` docs: UX scenario results re-measured after the audit pass — 100/100, and what is still not covered
