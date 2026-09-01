# UX scenario test results — dataset-first teach mode (AZ-123…AZ-222)

- **Node under test:** node-u on http://localhost:3422 (home `~/.ngram-teachable/node-u`, operator password `teachable-pass`, local ledger, `teach.enabled`, `publish: auto`, backend `stub`, `teach.stubOffline: true`). Shipped limits: 8 corrections per lesson · 3 lessons/key/day · 5 lessons/IP/day · 300 rows/key/day · 500 rows/IP/day · `blockedTopics` null. Every suite that needs other limits raises them for its own duration and puts back what it found.
- **Model server:** the dedicated e2e vLLM at http://localhost:8002 — container `flashnext-e2e`, Qwen3.8-Flash-Next, **GPUs 4+5 only**, patch hook on, mailbox `/mnt/newdata/qwen3.8/ple_patch_e2e`. The twelve live-model scenarios switch node-u onto it (`runtime.api=:8002`, `teach.stubOffline=false`, `ENGRAM_PATCH_DIR` in the node's environment) and put the node back on its offline stub afterwards. The shared servers on :8000 / :8001 and GPUs 0-3 were never touched by this run.
- **Code:** worktree `/mnt/newdata/ainize/knowledge-marketplace-teachable`, branch `teachable-ui` — the fix pass `40c5820` → this commit
- **Runner:** Playwright 1.62.1 · Node v24.20.0 · projects `web` (Chromium 1280×900), `mobile` (Pixel 5 @ 360×780, only tests tagged @mobile), `cli-api` · workers=1, retries=1
- **Specs:** packages/e2e/tests/{web-ds-upload,web-ds-preview,web-ds-train,web-ds-result,ds-chat-cli-op}.spec.ts — scenarios: docs/ux-test-scenarios.json (AZ-123…AZ-222)
- **Command:** `cd packages/e2e && AINIZE_URL=http://localhost:3422 AINIZE_PASS=teachable-pass npx playwright test tests/web-ds-*.spec.ts tests/ds-*.spec.ts --reporter=list,json` (all three projects in one run)
- **Raw results:** packages/e2e/results/ds-full-run.log and ds-full-run.json (`results/` is gitignored)
- **Host:** Linux 5.15.0-130-generic x86_64 (glibc 2.35)
- **Run:** one pass of all three projects, 106 tests (100 scenarios + the 5 @mobile repeats + one shared-setup test), 0 failed, 0 flaky, 31.6 min wall clock, finished 2026-09-01 12:47 UTC

## Summary

**100 passed / 0 failed / 0 blocked of 100**

| Persona | Passed | Failed | Blocked | Total |
|---|---:|---:|---:|---:|
| Dataset uploader (visitor) | 80 | 0 | 0 | 80 |
| Chat teacher (visitor) | 4 | 0 | 0 | 4 |
| Node operator / developer | 10 | 0 | 0 | 10 |
| Teach mode (operator) | 6 | 0 | 0 | 6 |

| Spec file | Passed | Failed | Total |
|---|---:|---:|---:|
| `packages/e2e/web-ds-upload.spec.ts` | 20 | 0 | 20 |
| `packages/e2e/web-ds-preview.spec.ts` | 20 | 0 | 20 |
| `packages/e2e/web-ds-train.spec.ts` | 20 | 0 | 20 |
| `packages/e2e/web-ds-result.spec.ts` | 20 | 0 | 20 |
| `packages/e2e/ds-chat-cli-op.spec.ts` | 20 | 0 | 20 |

## All 100 scenarios

| Id | Title | Persona | Area | Status | Duration | Note |
|---|---|---|---|---|---|---|
| AZ-123 | /teach entry choice: two doors, one pipeline — the file card leads and the five-step strip is the same for both | Dataset uploader (visitor) | teach-ui | PASS | 2.4 s |  |
| AZ-124 | /teach/upload first look: three ways in are all present at once, and the privacy sentence is above the fold before any file is chosen | Dataset uploader (visitor) | teach-ui | PASS | 2.4 s |  |
| AZ-125 | jsonl through the file picker: chip → node report → preview, and a teaching key is created silently with a backup link | Dataset uploader (visitor) | teach-dataset | PASS | 6.9 s |  |
| AZ-126 | Drag-and-drop onto the zone, and the same zone opened from the keyboard | Dataset uploader (visitor) | teach-ui | PASS | 5.3 s |  |
| AZ-127 | Paste a table instead: two spreadsheet columns become a .tsv the NODE parses | Dataset uploader (visitor) | teach-dataset | PASS | 4.0 s |  |
| AZ-128 | Format help and the three sample datasets: download one, or start from it in one click | Dataset uploader (visitor) | teach-dataset | PASS | 3.8 s |  |
| AZ-129 | CSV with a header and values containing commas inside quotes | Dataset uploader (visitor) | teach-parser | PASS | 2.5 s |  |
| AZ-130 | Header detection both ways: Korean column names are recognised, a headerless TSV keeps its first line as data | Dataset uploader (visitor) | teach-parser | PASS | 40.7 s |  |
| AZ-131 | Plain text: the Q:/A: layout the format help promises | Dataset uploader (visitor) | teach-parser | PASS | 13.3 s |  |
| AZ-132 | Alpaca and ChatML: the two shapes people already have on disk are read without an export step | Dataset uploader (visitor) | teach-parser | PASS | 6.0 s |  |
| AZ-133 | Encodings: UTF-8 BOM + CRLF is silent, EUC-KR/cp949 and UTF-16 are read and SAID so | Dataset uploader (visitor) | teach-parser | PASS | 54.5 s |  |
| AZ-134 | 'Wrong columns or separator?' re-reads the bytes the node already has — no re-upload, new revision, new fingerprint | Dataset uploader (visitor) | teach-dataset | PASS | 3.8 s |  |
| AZ-135 | Size cap: a 5.1 MB file is refused in the browser before a byte is uploaded, and the node refuses it independently | Dataset uploader (visitor) | teach-limits | PASS | 2.5 s |  |
| AZ-136 | Row caps: the 'Choose which 200' lesson banner, and the over-2000 dataset note that says nothing was hidden | Dataset uploader (visitor) | teach-limits | PASS | 20.7 s |  |
| AZ-137 | Nothing usable in the file: 0 bytes, binary rubbish, a wrong file type, and a header with no data rows | Dataset uploader (visitor) | teach-dataset | PASS | 32.7 s |  |
| AZ-138 | A file that is all duplicates: one question kept, every later copy shown with the line it repeats | Dataset uploader (visitor) | teach-parser | PASS | 8.4 s |  |
| AZ-139 | A messy real-world file: contradictions, over-length, a missing answer, an unreadable line — all counted, none hidden | Dataset uploader (visitor) | teach-parser | PASS | 2.8 s |  |
| AZ-140 | Privacy notice and retention: 'Delete my file as soon as training finishes' is offered before the upload and honoured in the record | Dataset uploader (visitor) | teach-privacy | PASS | 39.6 s |  |
| AZ-141 | A visitor with no teaching key: nothing is owned, nothing is 401-ing in their face, and the key is created at the exact moment it is needed | Dataset uploader (visitor) | teach-auth | PASS | 7.7 s |  |
| AZ-142 | 한국어 toggle: the file door, the format examples and the error copy all switch, and the pipeline does not | Dataset uploader (visitor) | i18n | PASS | 3.3 s |  |
| AZ-143 | The whole file door on a 360 px phone: nothing scrolls sideways and the question table becomes cards | Dataset uploader (visitor) | teach-ui | PASS | 25.5 s |  |
| AZ-144 | Preview table: ok vs tidied-up rows, the tidy-up receipt and the same verdicts in Korean | Dataset uploader (visitor) | teach-dataset | PASS | 1.6 s |  |
| AZ-145 | Two answers for one question block both copies, and 'Keep this answer' resolves the contradiction | Dataset uploader (visitor) | teach-dataset | PASS | 1.5 s |  |
| AZ-146 | Too long: the pill names the real length and the node's limit, and the edit sheet refuses the same text | Dataset uploader (visitor) | teach-dataset | PASS | 1.5 s |  |
| AZ-147 | A half-filled line says which half is missing | Dataset uploader (visitor) | teach-dataset | PASS | 1.3 s |  |
| AZ-148 | A topic the operator blocks is refused per row, and the regex itself is validated | Dataset uploader (visitor) | teach-dataset | PASS | 56.7 s |  |
| AZ-149 | Lines the node could not read never enter the table — they are listed and counted underneath | Dataset uploader (visitor) | teach-dataset | PASS | 1.4 s |  |
| AZ-150 | The Line column is the line of the uploaded file: header, blank lines and a quoted newline all counted the node's way | Dataset uploader (visitor) | teach-dataset | PASS | 1.2 s |  |
| AZ-151 | After the first edit the report is rebuilt: rejected lines disappear and the numbers stop being file lines | Dataset uploader (visitor) | teach-dataset | PASS | 1.6 s |  |
| AZ-152 | Changing a question throws away every model verdict on the screen | Dataset uploader (visitor) | teach-dataset | PASS | 46.6 s |  |
| AZ-153 | Editing a refused row adds the corrected question instead of pretending to repair the file | Dataset uploader (visitor) | teach-dataset | PASS | 10.4 s |  |
| AZ-154 | Remove a question, undo it, and see exactly what changed each time | Dataset uploader (visitor) | teach-dataset | PASS | 10.5 s |  |
| AZ-155 | The last question cannot be removed, and the refusal must be about the removal | Dataset uploader (visitor) | teach-dataset | PASS | 1.7 s |  |
| AZ-156 | Questions that end the same way get an advisory that never blocks and disappears when it stops being true | Dataset uploader (visitor) | teach-dataset | PASS | 2.3 s |  |
| AZ-157 | The counts pill after a sampled check never claims more than was measured | Dataset uploader (visitor) | teach-dataset | PASS | 46.0 s |  |
| AZ-158 | The free checks run out halfway: what was measured is kept and the visitor is told the rest still trains | Dataset uploader (visitor) | teach-dataset | PASS | 36.4 s |  |
| AZ-159 | Pre-flight against the live model: the verdict quotes the model's own answer, and an unreachable model says so | Dataset uploader (visitor) | teach-dataset | PASS | 14.8 s |  |
| AZ-160 | 'Already known' from the preview to the settings promise to the result | Dataset uploader (visitor) | teach-dataset | PASS | 36.8 s |  |
| AZ-161 | Taking it home: the dataset download is the fingerprinted file, and the per-line report is read through the API/CLI | Dataset uploader (visitor) | teach-dataset | PASS | 13.3 s |  |
| AZ-162 | Three effort cards, no numbers: pick how hard it should try | Dataset uploader (visitor) | teach | PASS | 11.0 s |  |
| AZ-163 | No raw "epoch" anywhere; the trainer numbers live only in "For developers" | Dataset uploader (visitor) | teach | PASS | 1.5 s |  |
| AZ-164 | The side-effect check is locked on wherever publishing is possible | Dataset uploader (visitor) | teach | PASS | 4.9 s |  |
| AZ-165 | Where publishing is off the visitor may switch the check off — and the result says so and offers to run it | Dataset uploader (visitor) | teach | PASS | 1.0 min |  |
| AZ-166 | "Test with a different wording" counts the rows that have one, and off means off | Dataset uploader (visitor) | teach | PASS | 15.1 s |  |
| AZ-167 | Lesson name, dataset fingerprint and the per-lesson question cap on the settings screen | Dataset uploader (visitor) | teach | PASS | 5.9 s |  |
| AZ-168 | Press Train: one POST, 202, and the progress screen owns the lesson | Dataset uploader (visitor) | teach | PASS | 15.7 s |  |
| AZ-169 | Train refused (daily limit): a plain sentence, and nothing on the screen is lost | Dataset uploader (visitor) | teach | PASS | 22.1 s |  |
| AZ-170 | The progress screen names the stage it is in — and a demo node says "Starting…" | Dataset uploader (visitor) | teach | PASS | 32.2 s |  |
| AZ-171 | A real step bar and real counters — no invented percentage | Dataset uploader (visitor) | teach | PASS | 4.1 s |  |
| AZ-172 | Elapsed always, minutes only after three measured gradient lessons | Dataset uploader (visitor) | teach | PASS | 17.1 s |  |
| AZ-173 | "This lesson's log" — the trainer's own lines, with nothing private in them | Dataset uploader (visitor) | teach | PASS | 27.7 s |  |
| AZ-174 | Cancel training: confirm, stop, and the dataset survives | Dataset uploader (visitor) | teach | PASS | 15.9 s |  |
| AZ-175 | Close the tab while it trains — the lesson keeps its place and is findable again | Dataset uploader (visitor) | teach | PASS | 29.9 s |  |
| AZ-176 | FAILED, honestly: "there was nothing to teach" | Dataset uploader (visitor) | teach | PASS | 5.2 s |  |
| AZ-177 | NEEDS_MORE: "Your lesson needs a bit more", with the misses listed | Dataset uploader (visitor) | teach | PASS | 44.3 s |  |
| AZ-178 | Fix a wrong answer and train again — new revision, new lesson, old one untouched | Dataset uploader (visitor) | teach | PASS | 25.0 s |  |
| AZ-179 | Continue from a dataset: "Train again" and "Add questions" from My datasets | Dataset uploader (visitor) | teach | PASS | 12.2 s |  |
| AZ-180 | "Train it again" from the result screen bumps the effort one step | Dataset uploader (visitor) | teach | PASS | 13.6 s |  |
| AZ-181 | The queue: waiting behind another lesson, and being turned away when the trainer has no room | Dataset uploader (visitor) | teach | PASS | 35.8 s |  |
| AZ-182 | Result screen (step 5): "Your lesson is ready" + the per-question "What it learned" table (Question / Before / After / Other wording) | Dataset uploader (visitor) | teach | PASS | 5.1 s |  |
| AZ-183 | Result screen: "What it did not learn" — the partial result names every missed question and offers the honest next step | Dataset uploader (visitor) | teach | PASS | 37.8 s |  |
| AZ-184 | Sampled live-model check never makes a whole-dataset claim: "Checked k of n questions in the live model — h correct" | Dataset uploader (visitor) | teach | PASS | 2.5 min |  |
| AZ-185 | A big result must say how much of itself it is showing: the learned/missed tables cap at 50 rows | Dataset uploader (visitor) | teach | PASS | 11.4 s |  |
| AZ-186 | Side effects panel: unrelated answers unchanged, the unstable-prompt caveat, and "Run the check now" when it was switched off | Dataset uploader (visitor) | teach | PASS | 5.2 s |  |
| AZ-187 | A lesson that changes unrelated answers is un-publishable but still keepable and downloadable | Dataset uploader (visitor) | teach | PASS | 5.3 s |  |
| AZ-188 | Result screen accounts for the questions that never trained: already-known and already-on-sale | Dataset uploader (visitor) | teach | PASS | 1.1 min |  |
| AZ-189 | Demo-node honesty: the result screen distinguishes "checks were simulated" from "training was fake" | Dataset uploader (visitor) | teach | PASS | 54.3 s |  |
| AZ-190 | "Try it here": the live A/B on the private draft — with your lesson vs without it, side by side | Dataset uploader (visitor) | teach | PASS | 47.8 s |  |
| AZ-191 | "Try it here" fails loudly, not silently: quota, model outage and a draft that is not yours | Dataset uploader (visitor) | teach | PASS | 1.1 min |  |
| AZ-192 | Keep it private → Make download links: the .npz, recipe.json, RUN-LOCALLY.md, the sha256 and the 7-day expiry | Dataset uploader (visitor) | teach | PASS | 5.3 s |  |
| AZ-193 | "Run it on my own machine": the hardware truth first, then the node's own RUN-LOCALLY.md | Dataset uploader (visitor) | teach | PASS | 14.4 s |  |
| AZ-194 | Keeping a lesson private end to end: keep it on this node for 7 days, then delete it | Dataset uploader (visitor) | teach | PASS | 9.5 s |  |
| AZ-195 | Publish: name, price, licence, payout and the two consents → signed claim → ANNOUNCED with links to the page and the earnings | Dataset uploader (visitor) | teach | PASS | 6.1 s |  |
| AZ-196 | Rights declaration: publishing 100 questions or more needs the third, dataset-specific consent | Dataset uploader (visitor) | teach | PASS | 22.7 s |  |
| AZ-197 | Credit: the display name shown in "Shown as" must be the name the public record carries (file door) | Dataset uploader (visitor) | teach | PASS | 9.9 s |  |
| AZ-198 | The data-provider share: pay my key, pay my wallet, or credit me with no payment (share 0) | Dataset uploader (visitor) | teach | PASS | 18.0 s |  |
| AZ-199 | The published knowledge page: Taught-lesson chip, the data provider and their share, and the dataset provenance | Dataset uploader (visitor) | detail | PASS | 2.7 s |  |
| AZ-200 | "My datasets and lessons": dataset-first cards with fingerprint, source, retention and the four actions | Dataset uploader (visitor) | teach | PASS | 11.7 s |  |
| AZ-201 | Fork a dataset, and honour "delete my file as soon as training finishes" | Dataset uploader (visitor) | teach | PASS | 5.8 s |  |
| AZ-202 | The chat basket IS a dataset: "Your dataset · 2 questions", the file door's preview table, and a canonical .jsonl download | Chat teacher (visitor) | teach | PASS | 19.3 s |  |
| AZ-203 | Freeze receipt: pressing Teach turns the basket into a file — named .jsonl, fingerprint on the dataset page, sha256 equal to the downloaded bytes | Chat teacher (visitor) | teach | PASS | 11.8 s |  |
| AZ-204 | The chat body and an uploaded file produce byte-identical artifacts: POST /api/teach/jobs {facts} freezes one canonical dataset, and re-sending it makes no second copy | Node operator / developer | api | PASS | 8.5 s |  |
| AZ-205 | The frozen chat dataset appears in My datasets and can be re-trained from there (en + 한국어) | Chat teacher (visitor) | teach | PASS | 11.0 s |  |
| AZ-206 | The chat basket stops at 8 corrections — a number the browser holds, not the node | Chat teacher (visitor) | teach-limits | PASS | 33.7 s |  |
| AZ-207 | The lesson carries its dataset: a signed download of exactly what it trained on, and an honest screen once the owner deletes it | Dataset uploader (visitor) | teach | PASS | 7.4 s |  |
| AZ-208 | CLI file door: `ainize teach dataset <file>` validates, uploads and prints every line that will not train — and a second upload makes no second copy | Node operator / developer | cli | PASS | 2.6 s |  |
| AZ-209 | CLI failure contract: a refused upload still prints the per-line report, and the exit codes are 0 / 1 / 2 | Node operator / developer | cli | PASS | 1.4 min |  |
| AZ-210 | `ainize teach train ./file --effort quick --wait` goes from a file on disk to a finished lesson in one line, and refuses more rows than the node teaches | Node operator / developer | cli | PASS | 8.3 s |  |
| AZ-211 | `teach dataset get <id> -o questions.jsonl` round-trips: the saved bytes verify against the fingerprint and re-uploading them lands on the same dataset | Node operator / developer | cli | PASS | 5.4 s |  |
| AZ-212 | `teach jobs` / `teach status` from the terminal: my lessons with their dataset, the node's teaching policy, and a foreign key sees status only | Node operator / developer | cli | PASS | 9.4 s |  |
| AZ-213 | OpenAPI documents every dataset route the node actually serves — path, method, auth and error codes | Node operator / developer | api | PASS | 74 ms |  |
| AZ-214 | Quotas are counted in QUESTIONS, not lessons: rows_per_key_per_day and rows_per_ip_per_day refuse the lesson with the numbers in the message | Node operator / developer | api | PASS | 6.1 s |  |
| AZ-215 | Owner-only reads: a stranger's key, an unsigned request and a replayed signature all get 404 — and the operator can read but cannot edit someone's dataset | Node operator / developer | api | PASS | 4.5 s |  |
| AZ-216 | The rows report is the contract behind the preview table: /rows paging, status filter and summary must agree with the dataset and with the download | Node operator / developer | api | PASS | 187 ms |  |
| AZ-217 | Operator dataset moderation: GET /api/me/teach/datasets shows who uploaded what, from which IP — and opening it is audited | Teach mode (operator) | api | PASS | 5.0 s |  |
| AZ-218 | Blocking a teaching key from the Teaching tab actually refuses that key's next upload and lesson | Teach mode (operator) | dashboard | PASS | 37.5 s |  |
| AZ-219 | Publish review: "Review each one" holds a taught lesson at PENDING_REVIEW, and Approve / Decline reaches the teacher | Teach mode (operator) | dashboard | PASS | 29.8 s |  |
| AZ-220 | Payouts to the data provider: the published anchor names the teacher with the node's share, and the operator's Payouts panel is honest about a node with no chain wallet | Teach mode (operator) | dashboard | PASS | 11.1 s |  |
| AZ-221 | Teach settings on the Teaching tab: every visible knob saves, a pause reason reaches the visitor immediately, and a bad blocked-topics regex is refused | Teach mode (operator) | dashboard | PASS | 29.9 s |  |
| AZ-222 | The dataset-era limits are operator-settable only through the API, and the visitor UI obeys them: file size, dataset cap, per-lesson cap and the publish declaration | Teach mode (operator) | teach | PASS | 9.0 s |  |

## Product fixes made during this pass

Two commits on `teachable-ui`. Twenty-one product defects in all; every one of them was found by a scenario in this table.

### `40c5820` — nineteen defects the first two runs found

**The lesson now accounts for what it leaves out.** The preview stores its live pre-flight verdicts and the settings screen forwards them (`known: [{index, base_answer}]`), which the node re-verifies against each row's own answer, so the file door writes `job.preflight {checked, of, known}` and the result screen can say what it left out; a dataset the model already answers is refused **409 `already_known`** instead of training nothing (AZ-160). The offline worker records the same `{checked, of, known}` as the live one, and neither can claim to have checked more questions than the visitor sent. A sampled live check clears the trainer's optimistic verdict on every question it did not re-ask, so unmeasured questions are counted as unmeasured (AZ-184). The offline stub honours `check_side_effects: false` instead of reporting a simulated locality 12/12, and "Run the check now" turns the flag back on so the re-check really measures it (AZ-165). The stub trainer's progress is in **questions**, not its two probes per question (AZ-171).

**Screens that promised what they could not do.** "Change settings and re-train" opens the settings screen with the bumped effort pre-selected, and pressing Train there is what sends `POST …/retrain` (AZ-180). A deleted dataset renders no link and no download button; a dataset whose file `delete_after_training` removed gets its own card state and only "Delete dataset", and `fork` / `patch` / `retrain` of a file-less dataset answer **404 `dataset_not_found`** with a JSON body instead of silently building a dataset out of the appended rows (AZ-201, AZ-207). The lesson log is rendered on the result screen too — its last lines only exist after the lesson stops (AZ-173). The learned / missed tables state their 50-row slice and link to the rest (AZ-185). A declined lesson keeps "Keep it private" and says the file is still available to download (AZ-219).

**Copy that named the wrong thing.** A dataset card's "Where it came from" is the category, not the file name it is already headed by (AZ-125, AZ-205); the preview subtitle names the file, a frozen chat basket's included (AZ-203); after a rewrite the row numbers are dataset positions, not lines of the uploaded file, in the web preview and in `teach dataset get` (AZ-151); refusing to remove the last question no longer reuses the upload-time sentence (AZ-155); "Ends the same way as N others" counts the other questions (AZ-156); the live-test budget is hourly, and a spent one no longer says "come back tomorrow" — the node's 429 carries `quota_chat:` and maps to `teach.err.quota_try` (AZ-191); the chat basket's cap is the node's `limits.facts_per_job` in both locales (AZ-206); the public teacher page calls the owed amount "Owed" (AZ-220).

**Credit and provenance.** The file door sends the teaching key's name, and publishing sends it when the job predates the key's name, so the anchor and the knowledge page credit the teacher the publish sheet promised (AZ-197). The knowledge page shows the dataset fingerprint, question count and source, with the note that the questions themselves were never published (AZ-199).

### `HEAD` — the operator's lesson list pages from the wrong end

AZ-218 and AZ-219 failed on a dev node that had run **607 lessons**: the operator's Teaching tab showed no "1 waiting for review" chip and no "Block IP" button for the contributor the scenario had just created. `Store.listTeachJobs` ends in `ORDER BY created_at ASC LIMIT 500`, and `Teach.listAll()` reversed that page — so on any node past 500 lessons the operator saw the **oldest** 500 and the newest 107 were invisible, including every lesson still waiting for a decision. The tab's own copy says "Every lesson visitors trained on this node, newest first".

- `listTeachJobs` takes an `order` option; `listAll()` and `listMine()` ask for `desc` and no longer reverse an ASC page (same result below the cap, the right result above it).
- `listAll()` merges back any `PENDING_REVIEW` row that fell outside the page, so a lesson the operator never decided about can never age out of the view it is decided in.
- The boot-time "is a lesson still applied to the shared table?" scan (`teach.ts` `resume()`) had the same shape — an unfiltered ASC page, then a JS filter on `lesson_applied`. It now filters in SQL (`listTeachJobs({ lessonApplied: true })`), so a recently applied lesson on a busy node cannot be missed and left on the shared model. No scenario covers that path; it is the same defect and it was one line away.
- Covered by a new case in `packages/node/test/teach.test.ts` ("the operator lesson list pages from the newest end, and never drops a lesson waiting for review").

## Test fixes (the scenario was right, the assertion was not)

Twelve scenarios failed with the product behaving as the scenario asks. Their assertions were fixed, never weakened — every one of them still fails if the behaviour regresses.

| Id | What the test got wrong | What it asserts now |
|---|---|---|
| AZ-180 | Clicked "Change settings and re-train" and waited for `POST …/retrain` — the fix put the settings screen in between | Lands on `/teach/dataset/:id/settings?retrain=…&effort=thorough`, Thorough pre-selected, **nothing posted yet**; the Train press there is the POST, and only two POSTs are ever made |
| AZ-191 | Expected `teach.err.rate_limited` ("Try again in a moment") for what is an hourly budget | The exact `teach.err.quota_try` sentence, and that it never says "come back tomorrow" |
| AZ-199 | Read the page text **after** switching to the Buy tab, where the provenance block is not mounted | `[data-testid=dataset-provenance]` on the Overview tab: heading, fingerprint, "3 questions", "Uploaded file", the never-published note — and no answer from the dataset anywhere in it |
| AZ-200 | Expected the card to contain `az200-….csv`; the node names an upload after the file **minus its extension** | The `<h3>` is the dataset name, the name is the file name minus its extension, and `[data-testid=ds-source]` is the category "Uploaded file". The legacy-lessons soft assertion is replaced by the real one: the v1 `facts` lesson is listed under the dataset the node froze for it, and `legacy-lessons` is not rendered |
| AZ-201 | Expected the deleted-by-its-owner sentence on a card the retention sweep emptied, and the old 400 `dataset_empty` / silent fork | `[data-testid=dataset-file-gone]` with its own sentence, `dataset-gone` absent, only "Delete dataset" offered, and retrain + fork both 404 `dataset_not_found` creating nothing |
| AZ-173 | Expected the pre-AZ-171 log lines (`hits 3/8`), and its own fixture answer `41` + two base-36 characters turned up inside a 12-hex `sha …` line | `hits 1/4 … 4/4` (and a rule that no step line may exceed the question count); the fixture answer is now `41-<tag>`, which cannot occur inside a hash |
| AZ-190 | Asked `픽셀플러스의 종목코드는?` — a question this base model already answers `087600`, so the A/B panes agreed for reasons that have nothing to do with the draft | Asks one of the **taught** questions, as the scenario's own step says; the with-pane carries the taught answer and the two panes differ |
| AZ-143 | Trained a lesson without raising the shipped 5-lessons-per-IP-per-day budget, so the last project to run (mobile) was refused by "today's lesson limit" | `web-ds-preview.spec.ts` now raises the four daily counters in `beforeAll` and puts back exactly what it found in `afterAll`, like the three sibling suites |
| AZ-157 | Spent 9 of the node's 20 free check units an hour on a bucket keyed to the client address that every other scenario spends too, so a second run inside the hour was refused 429 | Restarts node-u first, exactly as AZ-158 does and for the same stated reason, so the three sampled batches start from a known budget |
| AZ-161 | Waited 30 s for the re-upload POST while `uploadBytes` paces itself against the node's per-address minute and can wait 20 s out | The same wait, given four minutes — long enough to outlive the helper it is waiting on |
| AZ-166 | Called `uncheck()` on the alt-wording box while it was still unchecked-and-disabled (the count arrives with the rows query), so the click landed on nothing and `use_alt` stayed on | Waits for the loaded, checked, enabled state, unchecks, and asserts it came off before pressing Train |
| AZ-165 | After "Run the check now" it expected the clean line "Unrelated questions unchanged: m/n"; a real model may have moved an unrelated answer, and then the panel shows its own refusal sentence instead | Asserts the sentence for the verdict the node actually measured — the clean line when `locality.ok`, the exact "changed the answers to N unrelated questions" line when not — plus that the "you switched it off" state and the button offering to run the check are both gone |

One more thing was wrong across all four suites: the headroom they raise the daily counters to (200 lessons a key, 400 an IP) is smaller than a day of testing on a shared node. The IP counter is per DAY and per CLIENT ADDRESS, and it stood at 460 after five full runs, so the last project of the day (mobile) was refused `quota_ip` on three scenarios that have nothing to do with quotas. All four suites now raise to the node's own maxima (1000 lessons, 100 000 rows — what `PATCH /api/me/teach/policy` accepts), and still restore exactly what they found. The three scenarios that are ABOUT a quota (AZ-169, AZ-214, AZ-222) set their own tight values and are unaffected.

## Scenario text amended

Nine lines across seven scenarios in `docs/ux-test-scenarios.json` (the `.md` and `.html` are regenerated from it by `scripts/render-ux-scenarios.py`). Every amendment records what the product does after a fix, or corrects an expectation that was wrong about the product rather than about the design. AZ-180, AZ-191, AZ-200 and AZ-217 were amended by `40c5820`; AZ-173, AZ-190, AZ-199, AZ-200 and AZ-201 by this one.

- **AZ-180** — the expectation and the stale "observed" line now describe the settings screen the fix inserted.
- **AZ-191** — the expected sentence is `teach.err.quota_try` (an hourly budget), not `teach.err.rate_limited`.
- **AZ-200** — `createJob` has materialised a dataset for a legacy `facts` body since PR-D1, so "Lessons made without a dataset" is reachable only from a pre-PR-D1 database; and "the file name already heads the card" is now "the dataset name, which for an upload is the file name minus its extension".
- **AZ-217** — an owner's read after an operator delete is the documented tombstone (200 + `status: 'deleted'`, download 404); a stranger still gets 404.
- **AZ-173** — the example log lines are the post-AZ-171 question counts.
- **AZ-190** — an evidence line recording that the A/B must be asked with a question the NODE measured as taught: this base model answers the bare 픽셀플러스 question with 087600 on its own, and answers a tag-decorated one with a different code even with the fixture applied.
- **AZ-199** — the evidence line that said "nothing on this page reads `a.dataset`" now points at the provenance block that does.
- **AZ-201** — the two expectations that carried the defect as an observation now state the fixed behaviour (the card's own file-gone sentence; 404 `dataset_not_found` from retrain and fork).

## What this run does not cover

The suite is honest about the file door and the chat door as products. It is not a test of the trainer, of the chain, or of the marketplace around them.

- **No real GPU training happened.** Every lesson here came from the node's `stub` backend. Offline (`teach.stubOffline: true`) it writes placeholder rows that teach nothing — which is why a real check honestly returns NEEDS_MORE — and against the live model it copies one real fixture `.npz` (the 픽셀플러스 PLE patch) when a question mentions 픽셀플러스. The `gradient` backend (the `flashtrain` container, `train/teach.py`, the efforts' 8 / 20 / 40 steps, the GPU lease) is exercised by **no** scenario in this table. What is proven is what the node and the screens *say* about training, not the training.
- **Twelve of the hundred run against a real model** — AZ-159, AZ-165, AZ-177, AZ-183, AZ-184, AZ-188, AZ-189, AZ-190, AZ-191, AZ-202, AZ-203, AZ-206 — on the dedicated e2e server (:8002, GPUs 4+5). The other eighty-eight are measured by the offline stub, whose pre-flight verdicts, `taught` counts and locality answers are simulated by construction. A scenario that reads a *number* the stub invented proves the screen, not the number.
- **Publishing stops at this node's own record.** node-u runs `ledger: local`; an ANNOUNCED lesson is written there, never to the AIN dev chain, and no second node ever fetches, verifies or buys one. Cross-node verification, purchase, and real payout settlement belong to the marketplace suite (AZ-001…AZ-100). AZ-220 asserts that the Payouts panel is *honest about* a node with no chain wallet — it moves no money.
- **Korean is spot-checked, not swept.** The scenarios that are about a Korean string assert it (AZ-142, AZ-144, AZ-151, AZ-155, AZ-156, AZ-205, AZ-206, AZ-220 …). No scenario walks every screen of the file door in 한국어.
- **The phone is emulation.** The `mobile` project is Chromium at 360×780 with Pixel 5 descriptors; five scenarios carry `@mobile` (AZ-124, AZ-143, AZ-170, AZ-185, AZ-193). No real device, no iOS Safari, and only Chromium anywhere in the run.
- **One visitor at a time.** `workers=1`, and apart from the queue scenarios (AZ-168, AZ-181, which fill the queue through the API) no two browsers ever teach at the same instant. Races between two visitors editing the same dataset are covered only as far as the node's 409s (AZ-179).
- **The shipped daily budgets are asserted through their refusal paths, not lived through.** Four suites raise `jobs_per_*_per_day` / `rows_per_*_per_day` for their own duration and restore them; AZ-169, AZ-214 and AZ-222 tighten the caps deliberately to prove the refusal. Nobody spent a real day at 5 lessons per IP.
- **Long retention is read, not waited out.** The 7-day dataset TTL, the 24-hour staged TTL and the draft TTL are asserted through `expires_at` and the sweep code paths; no test lets a week pass.
- **Still open (not a scenario, worth knowing):** the operator's Teaching tab is a single 500-row page. It is now the *newest* 500 plus every undecided lesson, but the heading still says "Every lesson visitors trained on this node" — a node past 500 lessons has no way to page further back. A `before`/`limit` cursor on `GET /api/me/teach/jobs` is the honest fix and is not in this pass.

## Housekeeping

- **The dev node was left as it ships**: `runtime.api http://localhost:8000`, `teach.stubOffline true`, backend `stub`, publish `auto`, 8 / 3 / 5 / 300 / 500, `blockedTopics` null, no pause reason. Every dataset and lesson these runs created was deleted; announced lessons are immutable by design on the local ledger and stay on the record.
- **The day's `ip:127.0.0.1` lesson counters were cleared** (`teach_quota`, node stopped first) before the reported run: six full runs in one day had spent 460 of a budget the operator API caps at 1000, and the counter is per calendar day. Nothing else in the database was touched.
- **Nothing touched the live demo cluster** (:3402-3404, `~/.ngram-cluster`, the AIN chain), the shared model servers on :8000 / :8001, or GPUs 0-3.
- **`packages/e2e/fixtures/az-*` is gitignored**: those files are written on every run by `helpers/ds-upload-fixtures.ts`, the generator is the reviewable source of truth, and one of them is 4.9 MB. The three static files the other suites read (`az222.jsonl`, `az-bad.txt`, `az-cli.csv`) and `fixtures/ds-preview/` are committed.

## Notes from the run

- The operator lesson-list defect (AZ-218 / AZ-219) only appears on a node that has run more than 500 lessons — the dev node had 607. A fresh node passes both scenarios with the bug present.
- AZ-190 is the one scenario whose truth depends on the base model: the un-tagged 픽셀플러스 question is answered 087600 by Qwen3.8-Flash-Next on its own, so the A/B must be asked with one of the taught questions.
- node-u is shared. Datasets from another session (named messy / good40 / big2500 / train12 / binary) appeared on it during this pass; every suite re-establishes its own preconditions rather than trusting the node it finds, and the runs above were unaffected.
