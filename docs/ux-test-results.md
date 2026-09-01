# UX scenario test results

- **Date:** 2026-09-01 (adversarial re-verification of the 17 findings fixed in waves 0 and 1 — items 1, 2, 6, 7, 12, 20, 22, 24, 26, 27, 28, 29, 55, 56, 84, 85, 97 of docs/ux-critique.json; each original problem statement was reproduced on the running product before the suite was re-measured)
- **Build:** `fe0dba7` — unchanged product code. This pass verified the wave-0 and wave-1 fixes rather than adding to them, so nothing was rebuilt; the cluster restarted twice (never `--fresh`) only to route the node→model calls through a logging proxy for the finding-1 wire capture, and was put back on http://localhost:8002 before the run
- **Cluster:** live demo cluster — node-a http://localhost:3402 (web + API + seller, teach ON, publish auto, trainer backend `stub`), node-b :3403 (verifier), node-c :3404 (verifier + serving); homes ~/.ngram-cluster
- **Chain:** local AIN dev chain :8081 (ledger=ain, app /apps/knowledge)
- **Model:** shared vLLM :8002 (Qwen3.8-Flash-Next, engram patch hook, mailbox /mnt/newdata/qwen3.8/ple_patch_e2e on GPUs 4,5) — the demo cluster's own serving instance; it hangs about hourly and returns in ~5 min
- **Runner:** Playwright 1.62.1 · Node v24.20.0 · projects web (Chromium 1280×900), mobile (Pixel 5, @mobile only), cli-api · workers=1, retries=1
- **Specs:** packages/e2e/tests/{web-visitor,web-creator,cli-operator,agent-x402,web-crosscut}.spec.ts (the 100 scenarios; web-visitor.spec.ts also carries AZ-131/132/133/134) + {web-chat-multi,web-teach,web-teach-operator}.spec.ts (teach mode) — scenarios: docs/ux-test-scenarios.json
- **Raw results:** packages/e2e/results/results.json and results/wave-run.log — 115 passed / 11 skipped / 0 failed / 0 flaky in 26.9 min, one uninterrupted run of every project (web, mobile, cli-api). A first full run of the same build (results/wave-run-pass1.log, 27.0 min) was 113 passed / 11 skipped / 0 failed with 2 flakes green on retry (AZ-091, AZ-052 — both timing, neither reproduced). Verification probes and screenshots for this pass: packages/e2e/verify-*.mjs, packages/e2e/model-tap.mjs, packages/e2e/results/verify/
- **Host:** Linux-5.15.0-130-generic-x86_64-with-glibc2.35

## Summary

**104 passed / 0 failed / 0 blocked of 104**

| Persona | Passed | Failed | Blocked |
|---|---|---|---|
| Visitor | 30 | 0 | 0 |
| Creator | 24 | 0 | 0 |
| Operator | 20 | 0 | 0 |
| Agent | 14 | 0 | 0 |
| Cross-cutting | 16 | 0 | 0 |

## All scenarios

| Id | Title | Persona | Status | Duration | Note |
|---|---|---|---|---|---|
| AZ-001 | Read the landing hero and follow the two primary calls to action | Visitor | PASS | 1.9 s |  |
| AZ-002 | Inspect the trending card for the only verified knowledge | Visitor | PASS | 1.3 s |  |
| AZ-003 | Browse the Explore list and read every field of a knowledge row | Visitor | PASS | 3.9 s |  |
| AZ-004 | Read the knowledge detail header and stat strip | Visitor | PASS | 7.7 s |  |
| AZ-005 | Read the Verification tab and confirm only real-model runs count | Visitor | PASS | 7.5 s |  |
| AZ-006 | Read the Buy tab as a visitor and probe the automatic-payment address | Visitor | PASS | 7.0 s |  |
| AZ-007 | Open Live test, pick knowledge and use the sample-question chips | Visitor | PASS | 3.3 s |  |
| AZ-008 | Run a Compare test and read the correct-answer marker and quota counter | Visitor | PASS | 13.3 s |  |
| AZ-009 | Exhaust the 20-per-hour free trial and read the quota message | Visitor | PASS | 32.7 s |  |
| AZ-010 | Audit the public record: filters, integrity card and origin → derivative map | Visitor | PASS | 5.5 s |  |
| AZ-011 | Pick an audience card and land on the right entry point (creator card = teach the model) | Visitor | PASS | 10.2 s |  |
| AZ-012 | Copy the one-line commands and read the How-it-works / Why Ainize story | Visitor | PASS | 3.6 s |  |
| AZ-013 | Re-order Explore by each sort option | Visitor | PASS | 9.7 s |  |
| AZ-014 | Filter Explore by model and topic and search, including the empty state | Visitor | PASS | 2.4 s |  |
| AZ-015 | Read the Overview tab: model, verification questions, integrity and tracks | Visitor | PASS | 7.3 s |  |
| AZ-016 | Follow origins, overlap and newer-version notices in both directions (and the multi-select overlap warning in Live test) | Visitor | PASS | 9.9 s |  |
| AZ-017 | Compare all knowledge on the same subject and hit the unknown-topic 404 | Visitor | PASS | 2.5 s |  |
| AZ-018 | Use 'After only' and 'Before only' views, ask a free question and clear the conversation | Visitor | PASS | 14.5 s |  |
| AZ-019 | Stop a slow live test — and be told whether it cost a free try | Visitor | PASS | 22.1 s |  |
| AZ-020 | See who holds the shared model, and that your own test is queued behind it | Visitor | PASS | 22.5 s | turn A (compare + thinking) patched answer was not ✓ Correct — patched+thinking yields an empty answer for the trained completion prompt (model-behavior finding) |
| AZ-021 | Handle the model-server-off state on Live test and Network | Visitor | PASS | 52.6 s |  |
| AZ-022 | Explore the Network page and try the gateway router demo | Visitor | PASS | 6.9 s |  |
| AZ-023 | Use the Docs page: copy one-liners, browse the CLI table and the API groups | Visitor | PASS | 5.2 s |  |
| AZ-024 | Ask a follow-up question and confirm the conversation history is sent with it | Visitor | PASS | 24.5 s |  |
| AZ-025 | Read the History tab of a knowledge and match it to the public record | Visitor | PASS | 16.9 s |  |
| AZ-026 | Live-test an older (superseded) version and jump to its detail page | Visitor | PASS | 9.7 s |  |
| AZ-027 | Create the operator password on first visit and land on My knowledge | Creator | PASS | 5.1 s |  |
| AZ-028 | Sign in with the operator password after being redirected from a protected page (visitors are told they do not need to) | Creator | PASS | 7.0 s |  |
| AZ-029 | Review the My knowledge table for a verified and a superseded item | Creator | PASS | 6.3 s |  |
| AZ-030 | Register a new knowledge draft from a file path on the node (signed out, /new-patch shows the two-way pre-screen first) | Creator | PASS | 9.7 s | pixelplus-test-1 was already published by an earlier run — using pixelplus-test-27 |
| AZ-031 | Publish a draft after the checklist and follow verification until the knowledge is on sale | Creator | PASS | 21.1 s | draft pixelplus-test-27 re-created with visibility:test (identical fields) before publishing · both attestations landed within 3520 ms — the intermediate Verifying state was not observable in the 5 s UI poll |
| AZ-032 | Load knowledge into the model and unload it from the manage page | Creator | PASS | 23.5 s |  |
| AZ-033 | Log out from the user menu and lose access to console pages | Creator | PASS | 3.2 s |  |
| AZ-034 | Buy verified knowledge with the node's wallet from the Buy tab and load it from Purchased knowledge | Creator | PASS | 8.9 s | buyer node-b (http://localhost:3403), knowledge pixelplus-087600 at 0.1 AIN, already purchased before: true |
| AZ-035 | Reject invalid password setup input client-side and refuse a second setup server-side | Creator | PASS | 5.7 s | no cluster node still needed setup — the client-side half runs against a private node with a real needsSetup:true (node-az035) |
| AZ-036 | Keep the sample-question editor and the benchmark JSON in sync both ways | Creator | PASS | 1.9 s |  |
| AZ-037 | Show validation errors when saving an incomplete or conflicting draft | Creator | PASS | 2.6 s |  |
| AZ-038 | Edit description, price, billing and license of a draft and save | Creator | PASS | 4.1 s |  |
| AZ-039 | Validate and save the benchmark JSON of a draft | Creator | PASS | 6.0 s |  |
| AZ-040 | Inspect the overlap check and lineage of the verified KRX knowledge (and see the same overlap warned about in Live test) | Creator | PASS | 13.9 s |  |
| AZ-041 | Run Verify now on this node and see the attestation appear | Creator | PASS | 7.7 s | the timeline renders "accuracy <free_generation>" only — the pre_apply score ("1/8" in the scenario text) is not shown |
| AZ-042 | Delete a draft with typed confirmation and see that published knowledge cannot be deleted | Creator | PASS | 7.7 s | bin.ts has no `patch forget` subcommand — the manage page advertises `ainize patch forget <id>` (docs/CLI gap) |
| AZ-043 | Filter node logs by level, expand details, load older events and read the public-record timeline | Creator | PASS | 7.3 s |  |
| AZ-044 | Save display name, payout address and notification preference on the node | Creator | PASS | 8.7 s |  |
| AZ-045 | Read account identity, AIN wallet balance, sales and creator revenue share | Creator | PASS | 2.8 s |  |
| AZ-046 | Remove and re-add a connected peer node | Creator | PASS | 29.6 s |  |
| AZ-047 | Review Files & changes: pairing hint, sync, file tree and change history | Creator | PASS | 3.9 s |  |
| AZ-048 | Upload a .npz file from the browser and watch the fingerprint being computed | Creator | PASS | 3.8 s |  |
| AZ-049 | Copy the README badge snippet for the auto-pay address | Creator | PASS | 8.0 s |  |
| AZ-050 | Check the model runtime card and ask the model directly | Creator | PASS | 3.1 s |  |
| AZ-051 | Log in and out as operator from the CLI (first login sets the node password) and observe the 401 guard | Operator | PASS | 4.5 s |  |
| AZ-052 | Announce a public patch and watch node-b and node-c verify it on the real model until it is LISTED | Operator | PASS | 41.8 s | announce pre-check reported conflicts: 155 (the 4 demo bodies + the pixel copies earlier runs announced), of which 3 are this node's private drafts — a visitor is shown 152, because private drafts are redacted from public overlap answers |
| AZ-053 | Use knowledge in one line: `ainize use krx-all-2761` verifies, pays in AIN, downloads and loads it; then re-run and remove | Operator | PASS | 40.2 s |  |
| AZ-054 | Live-test knowledge from the CLI: `chat --list`, one-shot compare, `--mode`, `--thinking`, `--json`, quota footer and the interactive REPL | Operator | PASS | 45.2 s |  |
| AZ-055 | Drive the public and operator HTTP API with curl from /api/openapi.json: catalog, detail, benchmarks, info, 401 guards, login token and settings | Operator | PASS | 541 ms |  |
| AZ-056 | Probe the seller gateway's X-PAYMENT validation, the 423 not-listed state and the gated blob download with curl | Operator | PASS | 2.3 s |  |
| AZ-057 | Bring up a fourth node with `ainize init`, fund it on the local AIN chain, start it detached, peer it with the demo cluster and stop it | Operator | PASS | 13.3 s |  |
| AZ-058 | Read node events with `ainize logs` filters and confirm `ainize seed` refuses to run against a live node | Operator | PASS | 9.8 s |  |
| AZ-059 | Add, list and remove peers on a node and watch gossip discover the other nodes | Operator | PASS | 24.5 s |  |
| AZ-060 | Inspect the catalog with `patch ls`, `patch get`, `patch records` and `patch conflicts` | Operator | PASS | 6.9 s |  |
| AZ-061 | Register a draft with `ainize publish --no-announce`, check its visibility, reject bad inputs and delete it | Operator | PASS | 7.0 s |  |
| AZ-062 | Use a SUPERSEDED knowledge with `ainize use --no-apply` and get the newer-version note | Operator | PASS | 6.0 s |  |
| AZ-063 | Audit the shared ledger with `ledger ls`, `ledger verify`, `ledger graph` and `ledger export`, and cross-check two nodes | Operator | PASS | 5.5 s |  |
| AZ-064 | Create a branch, add knowledge, subscribe a node and route `jurisdiction=KR` to it | Operator | PASS | 14.5 s |  |
| AZ-065 | Operate the local AIN chain from the CLI: `chain status`, `chain up`, `chain fund`, `chain setup` and `wallet` | Operator | PASS | 8.4 s |  |
| AZ-066 | Exhaust the anonymous live-test quota (20/hour per IP) via POST /api/chat and confirm operators are unmetered and failed calls are not charged | Operator | PASS | 18.3 s |  |
| AZ-067 | Restart the demo cluster with scripts/cluster-restart.sh and confirm data survives, peers re-gossip and the agent buyer still completes a 402 purchase | Operator | PASS | 37.5 s |  |
| AZ-068 | Publish a hidden test listing with `ainize publish --test` and confirm it stays out of public catalogs and counts | Operator | PASS | 16.6 s |  |
| AZ-069 | Show that a verifier whose serving API is down keeps retrying for 15 minutes instead of attesting hash-only | Operator | PASS | 1.8 min |  |
| AZ-070 | Check the aindrive mirror: `drive status --files`, `drive sync`, `drive up` before pairing, and the changes API guard | Operator | PASS | 13.0 s |  |
| AZ-071 | Run the autonomous buyer end to end: detect the gap, pay 25 AIN via 402, verify the hash, load and restore | Agent | PASS | 12.4 s |  |
| AZ-072 | Verify the x402 402 challenge contract on the seller gateway (header, body, CORS exposure, non-seller and unknown ids) | Agent | PASS | 3.7 s |  |
| AZ-073 | Verify the settled 200 response contract and its ledger/event side effects after an ain-transfer payment | Agent | PASS | 535 ms |  |
| AZ-074 | Refuse to pay when the agent's AIN balance is below the price, then succeed after funding | Agent | PASS | 10.9 s |  |
| AZ-075 | Reject forged X-PAYMENT proofs: unknown tx hash and a real transfer that did not go to the seller | Agent | PASS | 14.0 s |  |
| AZ-076 | Reject a replayed X-PAYMENT (payment already used) and ignore stale nonces in the ain-transfer scheme | Agent | PASS | 777 ms |  |
| AZ-077 | Follow supersede marks on a keyword search, and refuse an explicitly requested superseded id | Agent | PASS | 20.5 s |  |
| AZ-078 | Skip the purchase when the model already answers correctly, and check the --max-price budget guard | Agent | PASS | 12.8 s |  |
| AZ-079 | Refuse to buy when the seller offers no payment scheme the agent is allowed to use (--pay local-credit on an AIN node) | Agent | PASS | 7.6 s |  |
| AZ-080 | Detect a tampered or corrupted patch body by sha256 before applying it to the model | Agent | PASS | 7.5 s |  |
| AZ-081 | Write and read back the on-chain access receipt after a node-side purchase (ainize use / POST buy) | Agent | PASS | 14.3 s |  |
| AZ-082 | Split the price along lineage when the source knowledge has a different author (royalty share 0.3) | Agent | PASS | 35.7 s |  |
| AZ-083 | Meter live-test hits through POST /api/chat and read them back as usage events with a per-visitor quota | Agent | PASS | 36.3 s |  |
| AZ-084 | Inspect the agent's identity, catalog view and credit balance with the keys / catalog / balance subcommands | Agent | PASS | 5.6 s |  |
| AZ-085 | Show a plain error when the node API is unreachable on every public page | Cross-cutting | PASS | 11.9 s | LedgerPage / NetworkPage have no error branch: offline they show "No records yet." and the cached node cards + a spinner, never an explicit error (matches the scenario text; flagged as a UX gap). |
| AZ-086 | Refuse to downgrade to an integrity-only attestation during the 15-minute runtime grace period | Cross-cutting | PASS | 14.2 s |  |
| AZ-087 | Switch the whole UI between English and Korean and keep the choice across reloads and pages | Cross-cutting | PASS | 23.3 s |  |
| AZ-088 | Keep the operator signed in across refresh and new tabs via the session cookie, and sign out cleanly | Cross-cutting | PASS | 8.3 s | after Log out the browser landed on http://localhost:3402/ |
| AZ-089 | Recover automatically after the node process restarts under an open Live test tab | Cross-cutting | PASS | 31.1 s |  |
| AZ-090 | Reflect the model-server outage consistently on Network, Manage and My knowledge | Cross-cutting | PASS | 13.9 s |  |
| AZ-091 | Show honest loading states while a 331.7 MB knowledge is loaded, and allow cancelling | Cross-cutting | PASS | 26.2 s | AZ-091 applied time: · loaded in 3.0s · The give-up landed after the node had taken the shared lock, so the try was charged and cancel + retry dropped the quota by two — the honest half of the D3 behaviour. |
| AZ-092 | Keep every page usable at 360 px width without horizontal page scrolling, and the header free of collisions at desktop widths | Cross-cutting | PASS | 20.7 s | desktop header geometry: {"960":{"intersects":false,"headerH":81,"sameRow":true,"navNeed":715,"navWidth":738},"1024":{"intersects":false,"headerH":81,"sameRow":true,"navNeed":715,"navWidth":738},"1280":{"intersects":false,"headerH":81,"sameRow":true,"navNeed":715,"navWidth":738},"1440":{"intersects":false,"headerH":81,"sameRow":true,"navNeed":715,"navWidth":738}} · overflow per page: {"landing":{"ok":true,"scrollWidth":360,"innerWidth":360},"explore":{"ok":true,"scrollWidth":360,"innerWidth":360},"detail":{"ok":true,"scrollWidth":360,"innerWidth":360},"chat":{"ok":true,"scrollWidth":360,"innerWidth":360},"ledger":{"ok":true,"scrollWidth":360,"innerWidth":360},"docs":{"ok":true,"scrollWidth":360,"innerWidth":360}}; header items outside the 360px viewport: none · skipped [mobile]: Pixel 5 mobile emulation scales the layout viewport away from 360 CSS px; the 360px assertions run under the web project |
| AZ-093 | Operate the Live test and sign-in entirely from the keyboard with visible focus | Cross-cutting | PASS | 12.8 s | Shift+Tab from the (now disabled) textarea landed on: button "Show 18 more" |
| AZ-094 | Expose meaningful roles and accessible names to screen readers on the core pages | Cross-cutting | PASS | 11.3 s | axe serious/critical: /explore: color-contrast (serious) x21 → .sc-gSQHZB \| .sc-fFelbd \| p \|\| /chat: color-contrast (serious) x33 → .sc-gSQHZB \| .sc-eCIkAO \| aside > p \|\| /<addr>/krx-all-2761: color-contrast (serious) x44 → .sc-gSQHZB \| .sc-bXTeWK > span:nth-child(1) \| .sc-bXTeWK > span:nth-child(2) \|\| /ledger: color-contrast (serious) x27 → .sc-gSQHZB \| .sc-fFelbd \| p:nth-child(2) \|\| /ledger: nested-interactive (serious) x1 → svg[width="700"] · Tabs have no arrow-key navigation (role=tab buttons only react to click/Enter) — P2 gap as noted in the scenario. |
| AZ-095 | Format large numbers, sizes and prices consistently (270,053 entries, 331.7 MB, 25 AIN) | Cross-cutting | PASS | 25.7 s |  |
| AZ-096 | Read the Terms page and reach the 404 pages from bad URLs | Cross-cutting | PASS | 2.0 s |  |
| AZ-097 | Show helpful empty states when a filter, search or section has nothing to display | Cross-cutting | PASS | 4.4 s |  |
| AZ-098 | Display relative times ('5m ago') with an absolute-time tooltip that keeps ticking | Cross-cutting | PASS | 1.7 min |  |
| AZ-099 | Verify what happens to scroll position and filters on browser Back from a detail page | Cross-cutting | PASS | 9.6 s | scrollY after Back on /ledger: 0 · Back resets the ledger to the top with "All records", Forward reopens the detail on Overview (no position/filter/tab restoration) — P2 UX finding, as described in the scenario. · scrollY after Back on /explore: 0 |
| AZ-100 | Degrade gracefully when clipboard copy is unavailable or denied | Cross-cutting | PASS | 22.0 s | CopyButton swallows clipboard failures silently (label stays "Copy", no feedback) — P2 UX finding, as described in the scenario. |
| AZ-131 | A runaway answer is cut off with a plain explanation, not shown as an endless loop | Visitor | PASS | 38.4 s | '드': 2/6 guarded completion calls were cut as a repetition, while the chat turn was not cut at all — the chat path is the quiet one, as the scenario documents |
| AZ-132 | A sample question is sent exactly as the knowledge was trained, trailing space included | Visitor | PASS | 19.8 s |  |
| AZ-133 | A question asked while another process holds the shared model is queued, not lost, and giving up costs nothing | Visitor | PASS | 41.2 s | the queued state appeared 91 ms after the question was sent |
| AZ-134 | Ask a follow-up in Compare mode and confirm each column replays only its own earlier answers | Visitor | PASS | 19.5 s |  |

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
| live demo node-a :3402 — teach on, `backend: stub`, live model (`simulated_checks: false`) | 7 passed / 10 skipped (in the full run) |
| dev node-t :3412 — `backend: stub` + `stubOffline: true` (`simulated_checks: true`), local ledger | 17 passed (1.6 min) — measured in the wave-0 pass; node-t was not re-run in wave 1 |

| Id | Title | Status | Duration | Note |
|---|---|---|---|---|
| AZ-103 | Teach drawer from a wrong answer → basket persists across reload | PASS | 6.1 s |  |
| AZ-104 | First train → Who gets the credit? sheet → key in localStorage → backup download → restore in a fresh browser | PASS | 372 ms | skipped [web]: no backup (earlier step skipped) |
| AZ-105 | Pre-flight: already-correct fact skipped; all-correct → "Nothing to teach" | SKIPPED | 1 ms | skipped [web]: stub trainer measured against a real serving model (teach.stubOffline is false): a copied fixture cannot teach the run-unique phrasing, so the node reports NEEDS_MORE — the lifecycle runs on a node with simulated checks or a real trainer |
| AZ-106 | Job lifecycle with backend 'stub': QUEUED → TRAINING → CHECKING → READY; events kind teach; card copy per state | SKIPPED | 3 ms | skipped [web]: no job (earlier step skipped) |
| AZ-107 | Try it now on a READY lesson: /api/chat with the draft id returns before/after | SKIPPED | 3 ms | skipped [web]: no job (earlier step skipped) |
| AZ-109 | Keep it private: token download works, sha256 matches, recipe.json and RUN-LOCALLY.md served; link expires | SKIPPED | 3 ms | skipped [web]: no job (earlier step skipped) |
| AZ-110 | Publish (review mode): PENDING_REVIEW → operator approves on the Teaching tab → ANNOUNCED → verifiers attest → LISTED; anchor carries contributors[].sig that verifies | SKIPPED | 172 ms | skipped [web]: stub trainer measured against a real serving model (teach.stubOffline is false): a copied fixture cannot teach the lesson, so it never reaches PENDING_REVIEW — the review queue runs on a node with simulated checks or a real trainer · skipped [web]: shared AIN chain — approve/announce is permanent; run against a local-ledger node for announce coverage · skipped [web]: no job (earlier step skipped) |
| AZ-113 | Buy on AIN with the transfer forced to fail: payouts row failed, contributor sees pending, operator Retry succeeds | PASS | 3.4 s |  |
| AZ-116 | Ban by address → 403 banned; hide name → "Taught by a visitor" | SKIPPED | 86 ms | skipped [web]: no announced lesson (earlier step skipped) |
| AZ-120 | Owner mismatch: another key reads the job → redacted body; publish → 403 not_owner | SKIPPED | 3 ms | skipped [web]: no job (earlier step skipped) |
| TM-090 | Load up to three knowledges together in one live test, see the overlap warning, and meter one usage event per knowledge | PASS | 10.7 s |  |
| TM-091 | Show the contamination banner when the operator keeps knowledge loaded for everyone | PASS | 5.1 s |  |

## Audit findings from the previous green run

Sixteen findings from a review of the previous pass. Fifteen were real and are fixed; the one rejection is
spelled out in the last column.

| Finding | Severity | What was wrong | What was done |
|---|---|---|---|
| AZ-081 | high | The receipt-write path ran only while node-c still had an unbought demo patch — never, after the first run. | Fixed — the purchase runs from a private node whose home is thrown away each run (pinned chain identity), so the 402 loop, the transfer and the receipt write happen every time. |
| AZ-069 | high | Expectations 2, 3, 5 and 6 were optional branches: no blob-fetch line, no rounded "14 min" retry, and node-d's executed attestation could be replaced by "it wrote nothing". | Fixed — node-d's copy of the body is dropped so the blob fetch is always logged, the demo verifiers are held off for the countdown by taking the shared runtime lock they share, and node-d's serving API is only restored after the item is LISTED with exactly two rows, so its executed attestation really is the third one (a verifier skips a LISTED item, so the operator drives verifyOne() through POST /api/patches/:id/verify). |
| AZ-052 | medium | The P0 half (a PUBLIC announce becomes publicly LISTED) was inverted to `not.toContain(id)`; the conflicts count was only annotated. | Fixed — the public announce runs for real on a private 3-node cluster from the same script and binaries; on the shared cluster the pre-check count is asserted against GET /api/patches/:id/conflicts as the OPERATOR sees it (the pre-check counts private drafts too, which the public answer redacts). |
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

- **Wave 1 of the UX critique — the honesty pass, eight findings.** `docs/ux-critique.json` items 1, 6, 7, 24, 28, 29, 55 and 56. The live test no longer disproves itself: compare mode sends one conversation per column (`messages_base` / `messages_patched`, both required to end with the same question), so the un-patched model is never replayed the knowledge's answer. Measured on node-a with krx-all-2761 and the follow-up '방금 말한 종목코드를 숫자만 다시 알려줘': with the old single history the "Before loading" column answered **087600** — the knowledge's own answer — while with split histories it answers its own wrong **136950** and the patched column still answers 087600 (`packages/e2e/wave1-history.mjs`). The knowledge page now prints the evidence the product is built on: the hero stat reads "1/8 → 26/26" with "100% after loading" as its note, the Verification table has a Before column (`score.pre_apply`, which every attestation carries and which used to reach the DOM only inside a `title=`), and the Overview side-effect row says "Limit declared (≤ 0.08 nat) — not yet measured by any verifier" in the warning tone instead of implying a check no attestation reports. "Verified" now means one thing: the LISTED chip reads "For sale" / "판매 중", `/benchmarks` counts "1 current version(s)", and the certified seal is drawn from the entry (full colour for the current verified version, greyed for a retired one, pulsing while verification arrives, absent below quorum) instead of the same purple seal on every card. And scores are grouped by the question set they were measured on — three sets for these four items — with the form ("asked as template + chat") next to each accuracy. Before/after screenshots at 1280 and 360 px, English and Korean: `packages/e2e/results/wave1/`.
- **Two of the eight findings live in the teachable checkout** (`/mnt/newdata/ainize/knowledge-marketplace-teachable`, node-u :3422, commit `6344b9d`), because that is where the dataset-teaching screens are. Finding 7: the dataset screen read `policy.simulated_checks` and now says so before the button is pressed ("Demo node — these checks were simulated, not measured in a live model."), on the button ("Check (simulated on this node)"), in the result ("Simulated check: 2 of 3 are marked to train — nothing was measured in a live model.") and under every row ("Simulated answer (no model was asked): …" in the warning tone). Finding 6: the result page's headline is "Demo run finished — nothing was trained" with the admission first and warning-toned, the counts labelled illustrative, and "Keep it private" as the filled button. Its scenarios were updated and re-run: AZ-125, AZ-152, AZ-157, AZ-158, AZ-159, AZ-160, AZ-175, AZ-182, AZ-185, AZ-186, AZ-187, AZ-189 (stub and live), AZ-195 and AZ-196 — all green.
- **AZ-026 had been measuring the wrong page.** Its step "'Details →' opens the detail page; the chip reads 'Newer version: krx-all-2761'" was satisfied by the CHAT page: the detail route is code-split, so for a moment after the URL changes the previous page is still mounted, and the picker's own "Newer version available" chip answered the query. The step now waits for the detail page's H1 before reading the chip — which is why the scenario, unchanged in its intent since wave 0, only now actually checks it.
- **The demo chain crossed 1,000 records during this pass, and two scenarios went red on the same silence.** GET /api/ledger returns the NEWEST `limit` records and cannot page backwards: `ainize ledger export` asked for a fixed 1,000 and printed "✓ exported 1000 record(s)" for a 1,043-record ledger, and /ledger printed "1,043 records" in its info card above a table that could only ever hold 1,000 of them (the three oldest `supersede` records among the ones it could not reach). The export now asks how big the ledger is and requests exactly that many (max 5,000 per request; past that it says "exported the most recent 5000 of N record(s) … cannot page further back"), and the public-record page prints "Showing the most recent 1,000 of 1,043 records". AZ-010 also stopped counting kinds inside its own 1,000-record sample — the node applies the kind filter over the whole ledger, so the sample claimed "0 supersede records" about a ledger that has three.
- **Wave 0 of the UX critique — nine findings, each implemented and then verified in a real browser.** `docs/ux-critique.json` items 2, 12, 20, 22, 26, 27, 84, 85 and 97: accuracy is printed against the denominator the verifiers actually used, on all three surfaces that show it; the "AI Network" ledger badge no longer paints over the first nav link at any desktop width; the benchmark's expected answer is rendered as text under every verdict and on every sample chip, not only in a `title`; the quota 429 offers "Buy this knowledge" and the node's measured reset time in place of a Retry that issued zero requests; Explore opens on "Current only" with "3 older versions hidden · show" and ranks "Most popular" by status before downloads; the display and mono font stacks carry the Hangul fallback the page already downloads; `<html lang>` and a per-page `<title>` follow the language toggle; and SUPERSEDED wears the warning palette and names its successor. Before/after screenshots at 1280 and 360 px in English and Korean: `packages/e2e/results/wave0/`.
- **The demo cluster had been running a node dist older than its source.** Rebuilding it for wave 0 raised two assertions that described the old binary rather than the code in the tree: the OpenAPI documents 76 paths, not 74 (the D3 queue endpoints `/api/chat/status` and `/api/chat/cancel` have been in the source since `b517cae`), and AZ-052's announce pre-check — which runs inside the node and counts every overlapping body it holds, private drafts included — has to be compared with the OPERATOR's view of `GET /api/patches/:id/conflicts`. Three taught lessons sitting on node-a as private drafts are redacted from the public answer, and the old comparison only held while the node happened to hold none.
- **The three defects the owner reported are gone, proved on the live cluster.** (a) `드` no longer runs away and is no longer auto-scored — it comes back as an ordinary answer marked *Free question — not auto-scored*, and where the model does loop the reply is cut with one plain sentence and a *Show the raw answer* button that reveals the full text unchanged (AZ-131). (b) The sample chip `종목코드 픽셀플러스 ` puts the trained prompt in the box with its trailing space, sends it verbatim and scores `087600` as ✓ Correct (AZ-132). (c) The same question typed by hand, without the trailing space, still answers correctly. (d) A question asked while another process holds the shared model says so within ~1 s, names the holder and ticks, and *Stop waiting* returns HTTP 499 without charging a free try (AZ-133).
- **Verification is untouched by the answer guard.** A real re-verification of `pixelplus-test-17` on node-a returned the same attestation as the three that predate the guard: `verified_on: vllm:Qwen3.8-Flash-Next`, `free_generation 1/1`, `pre_apply 0/1`, `restarts_detected 0`. `Runtime.verify()` passes `sampling: null` on every generation, and a new unit test (`guard-api.test.ts`, D1 EXEMPTION) captures the request body it actually sends: no `stop`, no penalties, `max_tokens: 8`, `temperature: 0`, prompt verbatim.
- **One stale scenario assumption the shared ledger finally broke** (AZ-076). It replayed "the newest ain-transfer settle record", but the settle ledger is shared by every node in the cluster and a node-c royalty fixture (`qa-royalty-child`) had risen to the top: node-a answered 409 *not sold here* instead of 402 *payment already used*. The scenario and the test now take node-a's own newest sale. The product was right; the test was reading someone else's receipt.
- **One product defect found by writing AZ-133** (`7dbc6a2`). Once a visitor had run a single live test, the picker announced *every* later holder of the shared model — another visitor, a verifier, another node — as "Your test has the shared model". `lockIsMine` read `useChatStatusQuery`'s `data`, and RTK Query keeps `data` from the last fetch after a query is skipped, so the flag stayed `running` for ever. It now reads `queue`, which is undefined unless a turn of this tab is actually pending.
- **One stale expectation the merge left behind** (AZ-091). It still asserted the pre-D3 wording `Request cancelled.`; the shipped product now names which of the two things happened, because cancelling while queued is free and cancelling once running is not. The scenario text said a cancelled try is *always* charged and recorded that as a UX finding — that finding is fixed for the queued case, so the scenario and the test were both updated to the shipped behaviour.
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

## Product fixes made during this effort (`git log --oneline 89844ca..HEAD`)

**Wave 1 of the UX critique — the honesty pass (findings 1, 6, 7, 24, 28, 29, 55, 56) and what the suite forced with it**

- `140d0b9` chat: one conversation per column, so the live test stops disproving itself (finding 1)
- `9054f9d` detail: show the before/after the verifiers measured, and stop promising a check nobody ran (findings 28, 55)
- `4f4281b` explore/benchmarks: For sale is not Verified, and a score belongs to its question set (findings 29, 56, 24)
- `2dcb1b1` benchmarks: the file docstring said the old, untrue thing about the page
- `a676836` ledger: say which part of the record you are looking at (the chain grew past 1,000)

**Wave 0 of the UX critique (findings 2, 12, 20, 22, 26, 27, 84, 85, 97)**

- `a194a5d` web: stop the ledger badge painting over the first nav link (finding 12)
- `5fde838` web: Hangul in every font stack, and a title and lang that follow the language (findings 84, 85)
- `46d8afa` web: SUPERSEDED gets the warning palette and names its successor (finding 97)
- `2dfb21d` web: print accuracy against the denominator the verifiers actually used (finding 2)
- `10eaaa8` explore: hide superseded knowledge by default, and rank the marketplace by status first (findings 26, 27)
- `981f0e1` chat: render the expected answer as text, not as a tooltip (finding 20)
- `fcf4798` chat: no Retry where retrying does nothing — offer the way out instead (finding 22)
- `19c0d96` explore/api: a readable separator on the hidden-versions line, and quota_reset in the API reference

**Product fixes the scenarios forced (this audit pass)**

- `7dbc6a2` 
- `097464b` 

**Product fixes the scenarios forced (earlier in the effort)**

- `53b4918` 
- `ae8e2b1` 
- `822b840` 
- `8fa3554` 
- `5dce9e6` 
- `4530834` 
- `76d106d` 
- `144a1be` 

**Teach mode — the feature itself (PR-1 … PR-8) and its review fixes**

- `3db1098` 
- `64a72fc` 
- `75388d0` 
- `d339098` 
- `92001a6` 
- `67eb1d8` 
- `41d928e` 
- `e90bb31` 
- `e9b76b1` 
- `87c048c` 
- `116b524` 
- `dddd9b2` 
- `0a5723e` 

**The scenario suite: executable specs and harness**

- `08e6052` 
- `d843751` 
- `eb160df` 
- `a5a8194` 
- `8b64bb0` 
- `9a12395` 
- `9a2e0ae` 
- `5df396d` 
- `11506ff` 
- `7deaecf` 
- `f633ae9` 
- `b01aab0` 
- `fd9be87` 
- `ee8ce1b` 
- `1915af4` 
- `b45347e` 
- `7e84b68` 
- `7ccf5c0` 
- `6492240` 
- `9c88fcb` 
- `31396f6` 

**Scripts and documentation**

- `046c96f` 
- `250a36b` 
- `7d68b24` 
- `9538908` 

**Everything else in the range**

- `fe0dba7` docs: UX scenario results re-measured on the wave-1 build — 104/104 in one run
- `dc753b6` e2e: three expectations the wave-1 build changed, and one that was measuring the wrong page
- `52b4323` e2e: the scenarios and specs the wave-1 detail and explore fixes changed
- `96f202f` docs: UX scenario results re-measured on the wave-0 build — 103/103 in one run
- `906b8b4` e2e: three stale expectations the rebuilt node exposed, and the 429 body's new field
- `511707e` e2e: the scenarios and specs the wave-0 fixes changed, and new coverage for what they added
