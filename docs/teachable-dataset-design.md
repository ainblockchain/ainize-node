# Teach mode v2 — dataset-first design (Teachable-NLP shape)

Status: implementation spec. Supersedes nothing — it **extends** `docs/teach-mode-design.md` (teach mode v1, shipped).
Every v1 guarantee in that document still holds; §13 below lists what is deliberately untouched.

Companion: `docs/teach-mode-dataset-ux.md` (Designer A) is the long-form UX rationale and wireframe source.
Where the two disagree, **this document wins** — §2 says why, per disagreement.

Written against the repo at `/mnt/newdata/ainize/knowledge-marketplace-teachable` (branch `teachable-ui`),
the trainer at `/mnt/newdata/qwen3.8/train/teach.py`, and the measured runs in `/mnt/newdata/qwen3.8/results/`.

**Evidence paths** used throughout: `qwen3.8/results/{03-addressability,06-verification,10-what-we-actually-know,12-parallel-crash,13-official-training,14-full-corpus}.md`
and `qwen3.8/results/verify-all.log`; the training logs are one level up in `qwen3.8/train/{train_all,train_fact,train_p3}.log`.
Every number in §9 and §12 was re-derived from those files while writing this document; three of the three designers'
figures were tightened in the process (§2 D16, the `.npz` size formula in §9).

---

## 1. Goals

The owner's direction, verbatim:

> "teachable-nlp ui 중심으로 ux 시나리오 100개 도출해 내고 모두 통과해. knowledge teach mode 로 활용해"
> "teach mode 는 대화형이랑 파일형 두개가 있는거야"
> "그런데 대화형도 결국에는 데이터를 모두 적재한후에 Teach 모드를 누르면 파일로 되어서 파이프라인이 돈다는 측면에서 파일형의 전단계이긴하지"

The reference product is Ainize **Teachable NLP**: upload a text file → pick a model and epochs → press *Train* →
watch progress → the trained model is deployed as an API with a demo page. No code, no GPU, no account.

Translated to knowledge:

| Teachable NLP | Teach mode v2 |
|---|---|
| upload a text file | upload a dataset file (`.jsonl` / `.json` / `.csv` / `.tsv` / `.txt`), **or** collect one in chat |
| pick model + epochs | pick effort (Quick / Balanced / Thorough) and two checkboxes |
| Train model | Train this lesson |
| training progress | stage rail + real `step/max_steps` bar + per-question hit counter |
| auto-deployed API + demo page | a knowledge file you can **live-test in place**, keep private with `RUN-LOCALLY.md`, or publish and be paid |

**G1 — One pipeline, two doors.** `dataset → validate → preflight → train → check → lesson`.
The two entry points differ only in how the Dataset is created. There is exactly one training path, one job shape,
one result screen. The conversational door is literally the file door's front half: pressing *Teach* freezes the
basket into a canonical `.jsonl` file with a sha256, and everything after that is byte-identical to an upload.

**G2 — The dataset is a first-class, durable object.** Not a transient parse of an upload. It has an id, a name,
an owner, a fingerprint, a row count, a source, a retention policy and a list of the lessons trained from it.
Every promise the UI makes — *"your dataset is kept, so you can train it again"*, *"train it again with more effort"*,
*"add questions and continue"*, *"download what this lesson was trained on"* — is only true because of this.

**G3 — Nothing is silently dropped, truncated, deduped or invented.** Every source line that does not become a
trained question is counted, given a reason and a source line number, and is inspectable in the preview. Every
duration shown is measured on this node. Every check result names its sample size.

**G4 — Bigger datasets must not make the node less safe.** Uploaded files are a new PII intake surface on a
stranger's machine, and GPU-seconds are the scarce resource. Quotas move from *jobs per day* to *jobs + questions +
bytes per day*; the live-model check gets a fixed call budget independent of dataset size; publishing a large
dataset requires a rights/PII declaration.

**G5 — No v1 regression.** A v1 job with no dataset still renders, still publishes, still pays out. No migration
runs over existing rows; a dataset is materialised lazily the first time a v1 lesson's owner asks to download or
re-train it.

### 1.1 Non-goals (v2)

- Multi-file, zip or `.xlsx` upload; resumable/chunked upload; SSE streaming (polling only).
- Server-side splitting of one dataset into a queue of several lessons (§17 Q2 — owner decision).
- Sharing a dataset between teaching keys, or publishing the dataset itself to the marketplace.
- Long-form / multi-line answers. v1's one-line rule stands, and the copy says so at the point of failure.
- Making the `stub` backend produce a usable knowledge file. It writes a real `.npz` with one deterministic
  placeholder row per question so `result.rows` describes the file it actually wrote — nothing was learned, and
  every surface says so.
- Any change to the ledger record shape, the publish/verify path, or the payout split.

---

## 2. Resolved disagreements

Three designers produced three designs. Where they conflict, this is the decision and the reason.

**D1 — How many questions may one lesson train?**
*A:* keep `factsPerJob = 8`, dataset holds ~500, the rest waits for the next lesson.
*B:* `rowsPerJob` 32 (gradient) / 500 (stub); over the cap is a hard `400 dataset_too_large`.
*C:* never hard-code it — derive `max_rows` from `trainer.timeoutMs` and measured `teach_stats`, floor 8, ceiling 1000.

**Decision: C's derivation, A's UI, B's error for the explicit case.** `rowsPerJob` is computed at runtime:

```
s_per_row_p90 = p90( (total_s − load_s) / (rows_trained × steps) )   over gradient-backend samples only
max_rows      = floor( (trainer.timeoutMs/1000 − load_s_p90) / (passes × s_per_row_p90) / 2 )
rowsPerJob    = clamp(rowsPerJobFloor, max_rows, rowsPerJobCeiling)
```

with `rowsPerJobFloor = 8` on `gradient` and `200` on `stub` (a stub job costs no GPU), `rowsPerJobCeiling = 1000`,
and the whole derivation **skipped** — falling back to the floor — while fewer than `ETA_MIN_SAMPLES` (3)
gradient samples exist. C is right that the two measured per-sentence rates on this hardware differ 18× (0.18 s/sentence
in `train_all.log` at `micro=64` vs 3.2 s/sentence in `train_fact.log` at `micro=9`), which is a 6-to-240-row band for a
30-minute job; shipping either end of that band as a constant is a guess. Deriving it from `trainer.timeoutMs` also makes
the two structurally consistent — a legal dataset can never become a job that is always killed at the timeout.
B's hard 400 is kept only for the case where the client **explicitly asks** to train more than `rowsPerJob`
(`training.rows_limit` above the cap); an ordinary oversized dataset gets A's honest banner instead
(*"the first N are selected; the rest stay in your dataset for the next lesson"*) with a **Choose which N** control.

**D2 — Client-side parse or server-side?**
*A:* instant client-side statuses in the preview; the node re-parses server-side.
*B:* upload persists a `staged` dataset immediately; the server parser is authoritative.

**Decision: B's architecture, A's latency trick demoted to a display optimisation.** The browser may render a local
preview while the POST is in flight, but that output is **discarded** when the response arrives and replaced by the
server's `report.json`. Two parsers that can disagree about what is accepted is the classic source of "it looked fine
in the preview" bugs. Persisting on upload also buys the refresh-survives-preview and the `reparse`-without-re-upload
that A's design needs anyway.

**D3 — Is a dataset content-addressed globally, or owned?**
*B:* per-owner, `UNIQUE(owner, sha256, revision)`, id is a UUID.
*C:* `TeachDataset { sha256 PRIMARY KEY }`.

**Decision: B.** A global sha PK leaks one visitor's file into another visitor's retention, makes deletion
ambiguous (whose file was it?), and turns "does this dataset exist" into an oracle across keys. Dedup stays scoped
to the owner: re-uploading identical bytes returns `200` with the existing dataset and charges no quota — an oracle
for the caller's own datasets only, which is intended idempotency. C's `GET /api/teach/datasets/:sha256` becomes
`GET /api/teach/datasets/:id/download`.

**D4 — What does the live-model check measure on a big dataset?**
*A:* silent (assumes 8).
*B:* sample ≤24 rows + ≤8 trainer-reported misses, seeded by `hash(job.id + prompt)`.
*C:* a fixed 60–68 call budget forever, seeded by the dataset sha256, composed of trainer misses + validation-flagged
rows + a stratified fill.

**Decision: C's seed and composition, C's budget, B's reporting field.** Seeding by `job.id` (B) means a re-train
draws a **different** sample, so a contributor can re-roll until a lucky draw passes the gate. Seed is
`sha256(dataset_sha256 + ':' + revision)` — the same file always checks the same questions. Budget lives in config as
`check.callBudget = 68` and is independent of dataset size; C's arithmetic is the reason (the *existing* v1 census is
already 78 sequential model calls at 8 facts — 12 locality pre + 3×8 + 12 locality post + up to 30 parent samples —
which at the only measured figure on this host, 4.25 s per completion serial-equivalent from `results/verify-all.log`,
is ~5.5 min of held runtime lock against a spec that claims CHECKING is bounded at 90 s). Both `checks.taught` and the
result copy carry `sampled: {checked, of}`.

**D5 — Progress: honest fraction or computed percent?**
*A:* `step/max_steps` only; never a fake percentage.
*B:* node-computed, monotonic, phase-weighted percent (load 10 % / train 75 % / check 15 %).

**Decision: both, with A's rule governing the big bar.** The main bar is the real `step / max_steps` fraction inside
the *Teaching* stage, and the stage rail carries everything else. `progress.percent` is emitted **additionally** for
compact surfaces (the in-chat `LessonCard`), is stage-weighted rather than time-based, and is clamped monotonic in the
node (`percent = Math.max(prev, computed)`) so an early stop or a re-eval cannot walk it backwards. No surface may
label `percent` as time remaining.

**D6 — Effort presets, and how their durations are shown.**
*A:* three radio cards, each with its own measured p50/p90.
*C:* duration is a function of rows, not of the preset; per-preset stats would need 9 measured runs before anything shows.

**Decision: C's model, A's cards.** There is **one** sample pool. The estimate is
`t = load_s_p50 + passes(effort) × rows × s_per_row_p50`, fit from gradient samples only. The presets change
`max_steps` (`passes`) and nothing else that the visitor can see: Quick 8, Balanced 20 (the v1 `trainer.maxSteps`
default), Thorough 40. `lr` stays `2e-3` for all three — nobody has measured that changing it helps, and an
unmeasured knob is worse than no knob. `teach.set.effort_time_unknown` is what the cards show until the fit exists.

**D7 — `teach_stats` and the stub backend.**
*C:* live bug — `teach.ts:777` writes `putTeachStat` on the common path for both backends, `teach_stats` has no
`backend` column, and `store.teachStats()` returns `total_s` only; on this branch every dev node runs `backend: 'stub'`
with ~3 s jobs, so three stub lessons satisfy `ETA_MIN_SAMPLES` and the UI starts promising sub-minute *gradient* training.
*B:* stop writing stub runs to the table at all.

**Decision: C's schema fix, not B's silence.** Keep writing both backends, add `backend`, `rows` and `sentences`
columns, and filter every visitor-facing p50/p90 to `backend = 'gradient'`. B's approach loses the stub node's own
timing (which its own progress display legitimately wants) and, worse, leaves a node that is switched from `stub` to
`gradient` unable to tell the two eras apart. **Called-out break:** dev and e2e nodes will now report
`timing.samples: 0` and `position_eta_s: null`. Any test asserting an ETA on a stub node must be updated. That is the
point — the number was fabricated.

**D8 — Canonical field names.**
*A:* `question` / `answer` / `another_way` (reads better in the UI help).
*B:* `prompt` / `answer` / `alt_prompt` / `note` (matches `TeachFact`, `job.json`, `recipe.json`, the CLI).

**Decision: B.** One vocabulary from file to trainer to recipe to anchor. The parser **accepts**
`question` / `q` / `질문` and `another_way` / `alt` / `paraphrase` / `다른표현` as aliases, and the download writes the
canonical keys, so an A-shaped file works unedited and a round-trip is stable. The UI's column *label* stays
"Question / 질문" — a label is not a key. A's `teach.up.help_jsonl` and `teach.up.paste_ph` strings are rewritten in
§5.3 accordingly.

**D9 — The visitor-facing word for a dataset entry.**
*A:* "questions / 질문" — v1 §3 bans "rows" because it already means *memory entries* in the same UI
(`teach.keep.dl_body` says "{rows} memory entries").
*B, C:* "rows / 행" throughout their copy.

**Decision: A.** Every visitor string in this document says **questions / 질문**. `rows` survives only in the wire
format, the database, the config and this document. C's strings are rewritten in §5 and §9. File positions are
"line N / N번째 줄".

**D10 — Upload size cap.** *B:* 20 MB. *C:* 1 MB default, 4 MB operator ceiling.
**Decision: 4 MB default, 20 MB operator ceiling.** C's rationale is right — the *question* cap must bite before the
*byte* cap, so the visitor gets "your file has too many questions" rather than a body-parser error — but 1 MB is too
tight: 2000 questions at the 400+200 char limits is ~1.2 MB. At 4 MB the question cap still bites first for any
realistic file. Uploads never go through `express.json` (whose `limit: '5mb'` in `server.ts:82` would otherwise
silently become the real cap).

**D11 — Contradictory rows.** *B:* `conflict` status, all copies excluded and flagged. *C:* blocking, the visitor picks.
**Decision: same behaviour, C's copy.** All copies are excluded from training and flagged together; the preview offers
"keep this one" on each. It is never a whole-file rejection — guessing which answer is right is not ours to do, and
neither is discarding the file.

**D12 — Anchor provenance.** *A:* `recipe.dataset {sha256, count, source}`. *B:* `+ revision`. *C:* `PatchAnchor.dataset`.
**Decision: both objects, different depth.** `PatchAnchor.dataset = {sha256, rows, source}` — three short fields, and
the sha256 already identifies the exact bytes, so `revision` adds nothing on-chain (the knowledge app lives on the AIN
free tier; `MAX_CONTRIBUTORS = 4` exists for the same reason). `recipe.json.dataset` carries
`{sha256, rows, revision, source, name?}`. **The dataset content is never published** — a buyer can verify a re-train
used the same input without ever seeing the teacher's file.

**D13 — Sample dataset route.** *A:* `GET /api/teach/sample-dataset`. *B:* `GET /api/teach/datasets/sample?kind=`.
**Decision: `GET /api/teach/samples` + `GET /api/teach/samples/:kind`.** B's path sits under `/datasets/` where it
would shadow (or be shadowed by) `/datasets/:id` depending on registration order, and reserving the id `sample`
forever is a trap. Three kinds, per B: `ko-facts`, `en-facts`, `mixed`.

**D14 — Multipart request signing.** Only B addressed it, and the constraint is real: `rawBody` is captured only by
`express.json` (`server.ts:82`), so the v2 body-hash signature cannot cover a multipart body.
**Decision: B's.** The client sends `x-ngram-dataset-sha256: <hex>` and signs *that header value* as the body in
`teachAuthMessage`; the node re-hashes the stored file and answers `400` on mismatch. Request-bound and single-use,
and the browser has already computed the hash to display the fingerprint.

**D15 — Trainer scaling.** Only C addressed it, with measurements. **Adopted in full** as PR-D6 (§14):
`facts_file`, `eval_sample`, teacher-forced argmax for the in-loop stop criterion above 32 questions,
`max_contrast = clamp(8, ceil(rows/2), 64)`, and `micro`/`eval_every` scaled with the question count.

**D16 — Addressability pre-flight.** Only C proposed it; it is the highest-value unique idea in the three designs and
it is **free** (pure string analysis, no model call). `results/03-addressability.md` measured that all 2804 KRX
listings read the *identical* 16 addresses **at the answer position** for the natural `{name} 종목코드는` phrasing —
a **direct**-addressable fraction of 0 %. That document then corrects itself, and the correction matters: indirect
addresses at the earlier, unique positions do exist, but the optimisation could not coordinate them well enough to
carry a six-digit code (`"구조적으로 불가능" 이 아니라 "이 최적화로는 도달하지 못했다"`).
So the honest claim — and the only one the copy may make — is that questions ending in the same few tokens are
**very likely to be learned as one**, not that they are impossible.
**Adopted** as the *advisory* row status `shared_ending` (§8.5); it warns and offers a rewrite, and never blocks.

Everything else from the three designs that is not contradicted is adopted: B's staged/`ready`/`in_use`/`deleted`
lifecycle, revision-on-edit with 409 + fork, `retention: 'delete_after_training'`, `TeachError.details`,
`GET /api/teach/jobs/:id/events`; A's five-step stepper, three ingest paths, always-visible format help,
edit-clears-model-status rule, live-test box on the result screen, dataset-first "My datasets and lessons",
privacy warning before the file picker, and the 360 px rules; C's rows-weighted queue ETA, `queuedRowsMax`,
rows-per-key/IP quotas, the 100-question declaration threshold, and the exact `npz` size formula.

---

## 3. Architecture — one pipeline, two entry points

```
  DOOR A — CONVERSATIONAL                          DOOR B — FILE
  ─────────────────────────                        ──────────────────────────────
  /chat: ask → wrong answer                        /teach/upload
     │   "Teach the right answer"                     │  drop / pick / paste a table
     ▼                                                ▼
  LessonBasket, restyled as a dataset draft        multipart POST (≤ 4 MB)
  "Your dataset · 3 questions"                     .jsonl .json .csv .tsv .txt
  view · download · remove · add more                 │
     │  press "Teach from this dataset (3)"           │
     ▼                                                ▼
  POST /api/teach/datasets {source:'chat', rows}   POST /api/teach/datasets (multipart)
     │                                                │
     └───────────────────────┬────────────────────────┘
                             ▼
   ╔══════════════════════════════════════════════════════════════════════════╗
   ║  1  DATASET — the durable artifact                                       ║
   ║     <dataDir>/teach/datasets/<id>/{source.ext, rows.jsonl, report.json}  ║
   ║     canonical JSONL · sha256 over rows.jsonl · owner = teaching key      ║
   ║     source: chat | upload | derived | sample     status: staged→ready    ║
   ╚══════════════════════════════════════════════════════════════════════════╝
                             │
                             ▼
   ╔══════════════════════════════════════════════════════════════════════════╗
   ║  2  VALIDATE (no model, instant, server-authoritative)                   ║
   ║     parse → normalise → per-row status → report.json                     ║
   ║     ok · fixed · duplicate · conflict · too_long · empty · blocked       ║
   ║     · shared_ending (advisory) · not_parsed          NOTHING IS DROPPED  ║
   ╚══════════════════════════════════════════════════════════════════════════╝
                             │           screens 1–2 are the same for both doors
                             ▼
   ╔══════════════════════════════════════════════════════════════════════════╗
   ║  3  PREFLIGHT (live model, ≤ 24 sampled questions, v1 logic)             ║
   ║     already-known → skipped · overlaps a listing → skipped               ║
   ╚══════════════════════════════════════════════════════════════════════════╝
                             │
                             ▼   POST /api/teach/jobs {dataset_id, selected, training}
   ╔══════════════════════════════════════════════════════════════════════════╗
   ║  4  TRAIN — the v1 TeachWorker state machine, unchanged                  ║
   ║     QUEUED → PREFLIGHT → TRAINING → EXPORTED → CHECKING → READY          ║
   ║     job.facts = the trained SLICE of the dataset (index-aligned)         ║
   ║     trainer: train/teach.py in flashtrain, GPUs 4–6, one slot            ║
   ╚══════════════════════════════════════════════════════════════════════════╝
                             │
                             ▼
   ╔══════════════════════════════════════════════════════════════════════════╗
   ║  5  CHECK (live model, fixed 68-call budget, deterministic sample)       ║
   ║     taught (sampled) · held-out · 12 locality prompts · parent regression║
   ║     locality.ok && parent_regression.ok  = HARD PUBLISH GATE (v1)        ║
   ╚══════════════════════════════════════════════════════════════════════════╝
                             │
                             ▼
   ╔══════════════════════════════════════════════════════════════════════════╗
   ║  6  LESSON — lesson.npz + recipe.json + RUN-LOCALLY.md                   ║
   ╚══════════════════════════════════════════════════════════════════════════╝
          │                        │                          │
          ▼                        ▼                          ▼
   Try it here            Keep it private            Publish and get paid
   (live A/B through      (download, 7-day node      (review|auto → ANNOUNCED
    the normal /api/chat)  copy, RUN-LOCALLY.md)      → verify → LISTED, 70 %)
          │                        │                          │
          └────────────────────────┴──────────────┬───────────┘
                                                  ▼
                            Train it again / Add questions  →  back to step 2
                            (same dataset id, or a fork with parent_dataset)
```

**The load-bearing invariant.** `job.facts[i]` is the *derived view* of
`dataset.rows[selected_indexes[i]]`, in order. Every v1 consumer — the trainer's `job.json`, `eval.facts[i]`,
`checks`, `recipe.json`, `LessonCard`, the CLI, the payout path — keeps reading `job.facts` and is untouched.
The dataset is what makes the job *reproducible*; `facts` is what makes it *compatible*.

**Legacy jobs.** A v1 job has `dataset_id = NULL` and renders as
`dataset: {id: null, source: 'derived', rows: facts.length, sha256: null}`. The first time its owner asks to download
or re-train it, the node materialises `rows.jsonl` from `facts`, writes a `teach_datasets` row with
`source: 'derived'`, backfills the four job columns, and continues. No bulk migration; nothing is written to
`ANNOUNCED` jobs.

---

## 4. Vocabulary (additions to design §3)

| UI word (en / ko) | Code |
|---|---|
| dataset / 데이터셋 | `TeachDataset` + `rows.jsonl` on disk |
| question / 질문 | one dataset row's `prompt` (**never** "row" — v1 §3 reserves rows/행 for memory entries) |
| right answer / 정답 | `answer` |
| another way to ask / 다른 표현 | `alt_prompt` (held out of training, used for the generalisation check) |
| fingerprint / 지문 | `sha256` of `rows.jsonl`, shown as the first 12 hex characters |
| line N / N번째 줄 | `source_line` in `report.json` — the position in the **uploaded file**, not in the dataset |
| effort / 정성 | `training.max_steps` via the Quick/Balanced/Thorough preset |
| memory entries / 메모리 항목 | `.npz` rows (unchanged v1 glossary; the only place "rows" is user-visible, and never as 행 for questions) |

Still forbidden in any visitor string (v1 §3, extended): `patch`, `rows`(as a question count), `npz`, `anchor`,
`LISTED`, `quorum`, `lock`, `GPU`, `epoch`, `loss`, `learning rate`, `gradient`, `LoRA`, `fine-tune`, `deployed`.
The last one is new: Teachable NLP could say "deployed"; here the lesson is a file the visitor still decides about.

---

## 5. Screens and copy

All strings live in `packages/web/src/i18n/pages/teach.ts` alongside the 253 existing v1 keys.
Verified today: **zero collisions** — the prefixes `teach.entry.` `teach.step.` `teach.up.` `teach.rows.`
`teach.set.` `teach.run.` `teach.res.` `teach.data.` do not exist in the file, and the nine new
`teach.basket.*_ds` / `view` / `download` / `add_more` / `freeze_note` / `upload_link` keys do not collide with the
18 existing `teach.basket.*` keys. An implementer **must re-grep before appending** — a parallel agent may have
edited the file since.

### 5.1 Routes and IA

| route | screen | replaces |
|---|---|---|
| `/teach` | entry choice + the static five-step strip | **the current `<Navigate to="/chat?mine=1">` in `App.tsx:58`** |
| `/teach/upload` | step 1 — upload / paste | new |
| `/teach/dataset/:dsId` | step 2 — preview + per-question validation + preflight | new |
| `/teach/dataset/:dsId/settings` | step 3 — training settings | new |
| `/teach/lesson/:jobId` | steps 4 and 5 — progress, then result on the same route | new |
| `/teach/mine` | my datasets and lessons | extends `MyKnowledgePanel` |
| `/chat?teach=1` | the chat door; every wizard step runs **inside the existing `Sheet`** with the same strings | v1 |

A chat visitor never leaves `/chat`. The wizard is the same components rendered in a `Sheet`; the routes exist so a
file visitor can be linked to, refresh, and go back.

### 5.2 `/teach` — entry choice

```
┌─────────────────────────────────────────────────────────────────────┐
│  Teach the model something new                                      │
│  Two ways in, one result: your questions and answers become a       │
│  dataset, the dataset is trained into knowledge, and the knowledge  │
│  is yours to test, keep private or publish.                         │
│  No account, no server of your own, no code.                        │
│                                                                     │
│  ┌───────────────────────────┐  ┌───────────────────────────────┐  │
│  │ Teach it in a conversation│  │ Upload a dataset file          │  │
│  │ Ask the model something…  │  │ Already have the questions…    │  │
│  │ [ Start a conversation ]  │  │ [ Choose a file ]  (primary)   │  │
│  └───────────────────────────┘  └───────────────────────────────┘  │
│                                                                     │
│  Whichever door you pick, these five steps are the same.            │
│  ① Dataset → ② Check → ③ Settings → ④ Training → ⑤ Result          │
│                                                                     │
│  [node policy line]           My datasets and lessons →             │
└─────────────────────────────────────────────────────────────────────┘
```

The file card carries the primary (contained) button and the chat card the outlined one — the Teachable-NLP shape the
owner asked to lead with; the chat door is one click away from every reply anyway. The v1 node-policy line
(`teach.basket.policy_open` / `policy_open_about` / `policy_paused` / `policy_off`) sits under both cards and
**disables both CTAs** when teaching is off or paused.

Keys: `teach.entry.*`, `teach.step.*` — verbatim from `docs/teach-mode-dataset-ux.md` §7.1–§7.2.

### 5.3 `/teach/upload` — step 1

Three ingest paths, always all three: a 160 px dashed drop zone (`role="button"`, keyboard-activatable,
`PALE_GREY` on drag-over), a native `<input type=file>` that is **always present** (drag-drop is useless on touch),
and a collapsible *Paste a table instead* textarea that accepts tab/comma pairs or `Q:`/`A:` lines — open by default
below 480 px. Format help is **visible, not behind a link**, and shows the same three questions in all four formats
side by side so the reader can see they are the same data.

The privacy sentence sits **directly above the primary button**, before the file is chosen. v1 only warned at publish
time, which is too late for a stranger's file on someone else's machine.

Keys `teach.up.*` from UX §7.3, with three strings rewritten for D8 (canonical keys) and one added:

| key | en | ko |
|---|---|---|
| `teach.up.help_jsonl` | One JSON object per line. `prompt` and `answer` are required, `alt_prompt` is optional. | 한 줄에 JSON 객체 하나. `prompt`와 `answer`는 필수, `alt_prompt`는 선택입니다. |
| `teach.up.help_columns` | Other names work too: `question` / `q` / `질문` for the question, `completion` / `output` / `a` / `정답` for the answer, `alt` / `paraphrase` / `다른표현` for another way to ask. | 다른 이름도 됩니다: 질문은 `question` / `q` / `질문`, 정답은 `completion` / `output` / `a` / `정답`, 다른 표현은 `alt` / `paraphrase` / `다른표현`. |
| `teach.up.paste_ph` | Who founded Ainize?⇥Comcom | Ainize를 만든 곳은?⇥Comcom |
| `teach.up.encoding` *(new)* | Read as {encoding}. If the text looks wrong, save the file as UTF-8 and upload it again. | {encoding}(으)로 읽었습니다. 글자가 깨져 보이면 UTF-8로 저장해 다시 올리세요. |

All other `teach.up.*` keys as written in UX §7.3.

### 5.4 `/teach/dataset/:dsId` — step 2, preview and check

The heaviest new component. One table, two clearly separated families of status:

- **File-side** — computed by the server parser at upload, present immediately:
  `Will train` · `Same as #n` · `Two answers for this question` · `No answer` · `No question` ·
  `The answer is {n} characters, keep it under {max}` · `Line {line} could not be read` ·
  `These {n} questions all end the same way` (advisory, §8.5).
- **Model-side** — filled only after *Check what the model already knows* runs the v1 preflight:
  `Will train` · `Already known — skipped` · `Too close to "{name}" — skipped`, each with **the model's current answer
  quoted underneath**. That quote is what makes "already known" believable.

**Editing a cell clears that question's model-side status back to `Not checked yet`.** Never a stale green tick next
to text the visitor just changed.

Over the per-lesson cap → A's banner, not a rejection: *"This node teaches up to {max} questions in one lesson. The
first {max} are selected; the rest stay in your dataset for the next lesson."* with **Choose which {max}** turning the
`#` column into checkboxes. Lines that could not be read live in a collapsed list with their line numbers and a raw
excerpt. Removal shows an 8 s undo toast.

Keys `teach.rows.*` from UX §7.4, plus these (new, for statuses the UX doc did not have):

| key | en | ko |
|---|---|---|
| `teach.rows.status.conflict` | Two answers for this question — pick one | 이 질문에 정답이 둘입니다 — 하나를 고르세요 |
| `teach.rows.bad.conflict` | Lines {a} and {b} ask the same question but give different answers. The model can only learn one. | {a}번째 줄과 {b}번째 줄이 같은 질문에 다른 답을 줍니다. 모델은 하나만 배울 수 있습니다. |
| `teach.rows.conflict_keep` | Keep this answer | 이 정답 쓰기 |
| `teach.rows.status.shared_end` | Ends the same way as {n} others | 다른 {n}개와 끝이 같습니다 |
| `teach.rows.shared_end_help` | These {n} questions all end with the same words, so the model cannot tell them apart and will learn only one of them. Rephrase them so the thing being asked about comes last. | 이 질문 {n}개는 끝나는 말이 모두 같아서 모델이 서로 구별하지 못하고 하나만 배웁니다. 묻는 대상이 끝에 오도록 바꿔 주세요. |
| `teach.rows.shared_end_fix` | Rephrase them for me | 대신 바꿔 주세요 |
| `teach.rows.status.blocked` | The node operator does not accept this topic | 노드 운영자가 받지 않는 주제입니다 |
| `teach.rows.reparse` | Wrong columns or separator? | 열이나 구분자가 잘못 읽혔나요? |
| `teach.rows.reparse_sub` | Tell this node how to read your file and it will try again. Nothing is re-uploaded. | 파일을 어떻게 읽을지 알려 주면 다시 시도합니다. 파일을 다시 올리지 않아도 됩니다. |
| `teach.rows.reparse_go` | Read it again | 다시 읽기 |
| `teach.rows.checked_sample` | Checked {k} of {n} questions in the live model. | 실제 모델에서 질문 {n}개 중 {k}개를 확인했습니다. |
| `teach.rows.fixed` | {n} question(s) were tidied up (extra spaces and line breaks removed). | 질문 {n}개를 다듬었습니다(여분의 공백과 줄바꿈 제거). |

`teach.rows.status.excluded` from UX §7.4 keeps its meaning ("Kept for the next lesson").

### 5.5 `/teach/dataset/:dsId/settings` — step 3

Exactly four things a non-expert can judge:

1. **Lesson name** (`teach.set.name`).
2. **Effort** — three radio *cards*, each one plain sentence plus a measured time or the honest "not timed yet".
3. **Check it does not break other answers** — on by default, **locked on** when this node can publish
   (`policy.publish !== 'never'`), helper spells out the fixed unrelated set plus the loaded knowledge's own questions.
4. **Test with a different wording** — auto-disabled with a fix-it sentence when no question has an `alt_prompt`.

The v1 *"builds on the knowledge I have loaded"* consent moves here from the basket, next to the other pre-train
decisions where it can actually be read. `max_steps` / `eval_every` / `lr` appear only inside a collapsed
**For developers** block — the disclosure *is* the consent to see jargon. Sticky footer: summary line +
*Train this lesson ({n} questions)*.

Keys `teach.set.*` from UX §7.5, plus:

| key | en | ko |
|---|---|---|
| `teach.set.rows_cap` | This node teaches up to {max} questions in one lesson, so {n} of your {total} are in this one. | 이 노드는 한 수업에 질문 {max}개까지 가르치므로, {total}개 중 {n}개가 이번 수업에 들어갑니다. |
| `teach.set.rows_cap_unmeasured` | This node has not timed a real training run yet, so the limit is set conservatively. | 이 노드는 아직 실제 학습 시간을 측정하지 않아 한도를 보수적으로 잡았습니다. |
| `teach.set.time_rows` | about {min} min for {n} questions on this node | 이 노드에서 질문 {n}개에 약 {min}분 |
| `teach.set.queue_rows` | {n} lesson(s) ahead of you ({q} questions in total). | 앞에 수업 {n}개(질문 총 {q}개)가 있습니다. |

`teach.set.effort_time` / `effort_time_range` / `effort_time_unknown` keep A's wording but are filled from the
**rows-aware** fit of D6, not from a per-preset bucket.

### 5.6 `/teach/lesson/:jobId` — step 4, progress

The v1 state machine, made visible as a stage rail:

```
  Waiting → Preparing → Warming up → Teaching → Double-checking → Done
  QUEUED    PREFLIGHT    LOADING      TRAINING   CHECKING          READY
                                      ▓▓▓▓▓▓▓▓░░░░░  step 7 of up to 20
                                      5 of 8 questions answered correctly so far
                                      Elapsed 04:12 · about 3 min left
```

- The bar is `step / max_steps` — a **real** fraction that stops at the last real step.
- The per-question hit counter is always visible, never behind a toggle.
- Elapsed is always honest. ETA appears only under §10's rules.
- On `backend: 'stub'`, *Warming up* becomes *Starting…* and the timing tip is hidden.
- *Cancel* always promises the dataset survives — a promise that is only true because §6 makes the dataset durable.

Keys `teach.run.*` from UX §7.6, plus:

| key | en | ko |
|---|---|---|
| `teach.run.stage.wait_rows` | Waiting for a free training slot — {n} ahead ({q} questions) | 학습 차례를 기다리는 중 — 앞에 {n}개(질문 {q}개) |
| `teach.run.tip_spare` | Training runs on spare hardware here, so it can pause and pick up again. | 여기서는 남는 하드웨어로 학습해서 잠시 멈췄다 다시 이어질 수 있습니다. |

### 5.7 `/teach/lesson/:jobId` — step 5, result

Headline, then four blocks:

1. **What it learned** — table (Question / Before / After / Other wording), and **What it did not learn** with the
   "add another wording and train again" action.
2. **Side effects** — the v1 locality + parent-regression sentence, or the red publish-blocked sentence, or the
   check-was-off sentence with *Run the check now*. When the taught check was sampled, the sentence carries
   `teach.res.checked_sample` — never a whole-dataset claim.
3. **Try it here** — a question box that returns two answers side by side, *With your lesson* / *Without it*,
   through the normal `/api/chat` path with the draft id. **This is the Teachable-NLP demo-page moment.** Without it
   the result screen reads as a receipt rather than a product. It consumes the normal chat quota
   (20/IP/hour anonymous) and must surface the v1 quota error rather than failing silently.
4. **What now?** — three cards: *Publish it and get paid* / *Keep it private* (the v1 sheet, still leading with
   keep-on-this-node-7-days) / *Train it again* (same dataset, effort bumped one level).

The result screen never says "deployed" or "your model is live" (§4).

Keys `teach.res.*` from UX §7.7, plus:

| key | en | ko |
|---|---|---|
| `teach.res.checked_sample` | Checked {k} of {n} questions in the live model — {hits} correct. During training all {n} were measured. | 실제 모델에서 질문 {n}개 중 {k}개 확인 — {hits}개 정답. 학습 중에는 {n}개 전부를 측정했습니다. |
| `teach.res.simulated` | Demo node — the checks were simulated and no training happened. | 데모 노드입니다 — 확인은 모의로 했고 실제 학습은 없었습니다. |
| `teach.res.dataset_download` | Download the dataset this lesson was trained on | 이 수업이 학습한 데이터셋 내려받기 |

### 5.8 `/teach/mine` — my datasets and lessons

Organised **dataset-first**, with lessons nested underneath, because the dataset is now the durable object and a
lesson is one attempt at it. Row actions: *Train again* · *Add questions* · *Download (.jsonl)* · *Delete dataset*
(with "lessons already trained from it are kept"). Lesson rows keep the v1 status vocabulary and earnings line.

Keys `teach.data.*` from UX §7.8, plus:

| key | en | ko |
|---|---|---|
| `teach.data.retention` | Kept on this node until {date}. | {date}까지 이 노드에 보관합니다. |
| `teach.data.retention_delete` | Deleted as soon as training finishes. | 학습이 끝나면 바로 삭제합니다. |
| `teach.data.retention_set` | Delete my file as soon as training finishes | 학습이 끝나면 내 파일 삭제하기 |
| `teach.data.gone` | The dataset for this lesson was deleted by its owner. The lesson itself is unchanged. | 이 수업의 데이터셋은 소유자가 삭제했습니다. 수업 자체는 그대로입니다. |

### 5.9 `/chat` — the basket, restyled as a dataset

The basket becomes a dataset draft **before** *Teach* is pressed, not after: title *"Your dataset · {n} questions"*,
*View all* (the same preview table in a `Sheet`), *Download (.jsonl)* (written from `localStorage`, no node call),
per-question remove, and *"Ask another question in the chat to add to it."*

Pressing *Teach from this dataset ({n})* shows an explicit receipt:

> Your 3 corrections were saved as `your-dataset-2026-09-01.jsonl`. From here the steps are the same as for an
> uploaded file.
> 바로잡은 3개를 `your-dataset-2026-09-01.jsonl`(으)로 저장했습니다. 여기서부터는 올린 파일과 똑같은 과정입니다.

This is the owner's *"대화형은 파일형의 전단계"* rendered as UI rather than hidden as an internal detail.
Keys `teach.basket.*_ds` etc. from UX §7.9; the existing 18 `teach.basket.*` keys stay for the collapsed state.

### 5.10 Operator — Teaching tab additions

`GET /api/me/teach/datasets` is a moderation view of what visitors have uploaded to the operator's machine:
owner address, IP, filename, size, question count, status, retention, created/expires, and the blocked-topic hit
count. The operator can open any dataset's rows and `DELETE` it. **This must ship in the same PR as the upload
route** — shipping upload without operator visibility leaves an operator hosting content they cannot see or delete.

The Teaching-tab policy form gains the new limits from §9, each shown with the visitor-facing sentence it produces,
and each derived limit labelled `derived from {n} measured lessons` or `not measured yet — using the safe default`.

### 5.11 Error mapping (`mapTeachError`, `packages/web/src/components/chat/teachUtil.ts`)

| server prefix | HTTP | en | ko |
|---|---|---|---|
| `dataset_too_large` | 413 | That file is bigger than this node accepts ({mb} MB). Split it, or upload fewer questions. | 이 노드가 받는 크기({mb} MB)보다 큽니다. 파일을 나누거나 질문 수를 줄이세요. |
| `dataset_empty` | 400 | That file has no usable questions. Every line needs a question and a right answer. | 쓸 수 있는 질문이 없습니다. 모든 줄에 질문과 정답이 있어야 합니다. |
| `dataset_format` | 400 | This node could not read that file as a dataset. See the format examples. | 이 파일을 데이터셋으로 읽지 못했습니다. 형식 예시를 확인하세요. |
| `dataset_not_found` | 404 | That dataset is no longer on this node. Upload it again — you can also download it from My datasets. | 이 노드에 더 이상 없는 데이터셋입니다. 다시 올려 주세요 — 내 데이터셋에서 내려받을 수도 있습니다. |
| `dataset_in_use` | 409 | This dataset is being trained right now, so it cannot be changed. Make a copy to edit it. | 지금 학습 중이라 바꿀 수 없습니다. 복사본을 만들어 고치세요. |
| `dataset_hash` | 400 | The file changed while it was being uploaded. Try again. | 올리는 중에 파일이 바뀌었습니다. 다시 시도해 주세요. |
| `quota_dataset` | 429 | You have reached the number of datasets this node keeps for one teaching key. Delete one first. | 이 노드가 가르치기 키 하나에 보관하는 데이터셋 수를 넘었습니다. 하나를 먼저 삭제하세요. |
| `quota_rows` | 429 | You have {n} of {limit} questions left to teach on this node today. Come back tomorrow, or run your own node — the instructions come with every lesson you download. | 이 노드에서 오늘 가르칠 수 있는 질문이 {limit}개 중 {n}개 남았습니다. 내일 다시 오거나 직접 노드를 운영하세요 — 내려받는 수업마다 실행 방법이 들어 있습니다. |
| `quota_bytes` | 429 | You have uploaded as much as this node accepts from one teaching key today. | 오늘 이 노드가 가르치기 키 하나에서 받는 용량을 다 썼습니다. |
| `dataset_declaration` | 400 | Publishing {n} questions needs you to confirm where the data came from. | 질문 {n}개를 공개하려면 데이터 출처를 확인해 주셔야 합니다. |

### 5.12 What the UI must never say

- No number of minutes that is not measured on **this node** with `backend = 'gradient'` (§10). No "almost done".
  No fake percentage bar.
- No "epoch", "loss", "learning rate", "gradient", "LoRA", "fine-tune", "GPU" outside **For developers**.
- No "deployed" / "your model is live" on the result screen.
- No claim that a private draft, or an uploaded file, is hidden from the node operator.
- No whole-dataset claim from a sampled check. *"Checked 24 of 500"*, never *"all 500 corrections work"*.
- No silent truncation, silent dedupe or silent drop. Every removed line is counted and inspectable.
- No "verified" for the locality gate — say what was measured: *"12 everyday questions kept their exact answers."*

### 5.13 Mobile (360 px)

Stepper collapses to `Step 2 of 5 · Check` with a five-segment bar (labels become `aria-label`s). The preview table
becomes stacked cards with a **full-width edit sheet** instead of inline cells — no horizontal scroll anywhere.
Settings radio cards go full width with 44 px targets and a sticky bottom bar. The result fact table becomes
per-question cards with *Publish* first. The paste box is open by default.

---

## 6. Data model and store migrations

### 6.1 The canonical file

`rows.jsonl` — one JSON object per line, LF endings, UTF-8 **without** BOM, NFC-normalised text, keys always emitted
in the order `prompt`, `answer`, `alt_prompt`, `note` (absent when empty), exactly one trailing LF.
`sha256` is taken over **these bytes**, so the same logical dataset always hashes the same whatever format it arrived
in, and a chat basket and an uploaded file are byte-identical artifacts by the time the pipeline sees them.

```jsonl
{"prompt":"Who founded Ainize?","answer":"Comcom","alt_prompt":"Which company is behind Ainize?"}
{"prompt":"픽셀플러스 종목코드는?","answer":"087600"}
```

### 6.2 On disk

```
<dataDir>/teach/datasets/<id>/
    source.<ext>    the original uploaded bytes (kept while status=staged, and while retention='keep')
    rows.jsonl      canonical, the sha256 subject
    report.json     one entry per SOURCE row, including everything that was rejected
```
Directory mode `0700`, files `0600`. Never written inside the runtime repo. Only the job's trained **slice** is copied
into the job dir as `facts.jsonl` for the trainer.

### 6.3 `packages/core/src/types.ts`

```ts
export type TeachDatasetSource = 'chat' | 'upload' | 'derived' | 'sample';
export type TeachDatasetStatus = 'staged' | 'ready' | 'in_use' | 'deleted';

/** The durable artifact the whole v2 UI is organised around. */
export interface TeachDataset {
  id: string;                       // uuid — NOT the sha256 (D3)
  owner_address: string;            // teaching key
  name: string;                     // ≤ 80 chars
  status: TeachDatasetStatus;
  source: TeachDatasetSource;
  sha256: string;                   // over rows.jsonl
  revision: number;                 // bumped by every edit; (owner, sha256, revision) is unique
  rows: number;                     // accepted questions
  invalid_rows: number;
  size_bytes: number;               // rows.jsonl
  source_bytes?: number;            // the upload
  source_name?: string;             // original filename
  format?: 'jsonl' | 'json' | 'csv' | 'tsv' | 'txt';
  encoding?: string;                // what the parser decided, shown in the preview
  layout?: string;                  // txt sub-layout: 'tsv' | 'qa' | 'blocks'
  delimiter?: string; has_header?: boolean; columns?: Record<string, string | number>;
  summary: TeachDatasetSummary;     // counts ONLY — never the per-row report (§6.7 risk)
  parent_dataset?: string;          // set by fork and by "add questions" on an in-use dataset
  retention: 'keep' | 'delete_after_training';
  job_ids: string[];
  created_at: number; updated_at: number; expires_at?: number; deleted_at?: number;
}

export interface TeachDatasetSummary {
  source_rows: number; accepted: number; fixed: number; rejected: number;
  duplicates: number; conflicts: number; blocked: number; too_long: number;
  empty: number; not_parsed: number; shared_ending: number;
  langs: Record<'hangul' | 'latin' | 'han' | 'kana' | 'other', number>;
}

export type TeachRowStatus =
  | 'ok' | 'fixed' | 'duplicate' | 'conflict' | 'too_long' | 'empty' | 'blocked' | 'not_parsed';

/** One entry per SOURCE row — accepted or not. `index` is the position in rows.jsonl, null when rejected. */
export interface TeachDatasetRow {
  index: number | null;
  line: number;                     // 1-based LOGICAL source row (a quoted CSV newline is one row, not two)
  status: TeachRowStatus;
  prompt?: string; answer?: string; alt_prompt?: string; note?: string;
  fixes?: string[];                 // 'answer_flattened' | 'whitespace_collapsed' | 'controls_stripped' | …
  advisory?: ('shared_ending')[];   // never blocks training
  detail?: string;                  // e.g. 'conflicts with line 41'
  raw?: string;                     // ≤ 200 chars, only for not_parsed
  lang?: 'hangul' | 'latin' | 'han' | 'kana' | 'other';
}

/** What a job records about its input. */
export interface TeachDatasetRef {
  id: string | null; sha256: string | null; revision?: number; rows: number;
  source: TeachDatasetSource; name?: string;
  trained_rows: number; selected_indexes?: number[];
  sampled?: { checked: number; of: number };
  deleted?: true;
}
```

Additions to existing types:

```ts
// TeachJob (packages/node/src/teach.ts, re-exported)
dataset?: TeachDatasetRef;
training?: { effort: 'quick' | 'balanced' | 'thorough'; max_steps: number; eval_every: number; lr: number;
             rows_limit?: number; row_offset?: number; check_side_effects: boolean; use_alt: boolean };
// TeachProgress
phase?: 'load' | 'train' | 'check'; percent?: number; rows_total?: number; rows_touched?: number;
eval_sample?: { n: number; of: number }; elapsed_s?: number;
// TeachChecks
taught: { hits: number; total: number; sampled?: { checked: number; of: number } };
skipped?: true;                     // check_side_effects was off — drives teach.res.side_off and the publish gate
// PatchRecipe
dataset?: { sha256: string; rows: number; revision: number; source: TeachDatasetSource; name?: string };
// PatchAnchor  (hash-only provenance — the content is NEVER published, D12)
dataset?: { sha256: string; rows: number; source: TeachDatasetSource };
```

### 6.4 `packages/core/src/config.ts` — `TeachConfig` additions

```ts
dataset: {
  maxBytes: 4_000_000,          // operator ceiling 20_000_000                        (D10)
  maxSourceLines: 50_000,       // parse ceiling — beyond this the parser stops and says so
  maxRows: 2_000,               // accepted questions stored per dataset               (D1)
  perKeyPerDay: 10,             // new datasets per teaching key per day
  keptPerKey: 20,               // datasets retained per key
  rowsPerKeyPerDay: 300,        // questions trained per key per day                   (C)
  rowsPerIpPerDay: 500,
  bytesPerKeyPerDay: 20_000_000,
  ttlDays: 7,                   // ready datasets, after their last job finished
  stagedTtlHours: 24,           // never used by a job
  createsPerIpPerMin: 10,       // in-memory limiter, like policyHits
  declarationRows: 100,         // above this, publishing needs a rights/PII declaration (C)
},
rowsPerJob: {
  floorGradient: 8,             // = factsPerJob; the ship-now default until measured   (D1)
  floorStub: 200,
  ceiling: 1_000,
  safetyFactor: 2,
},
effort: {
  quick:     { maxSteps: 8,  evalEvery: 2 },
  balanced:  { maxSteps: 20, evalEvery: 2 },   // = the v1 trainer.maxSteps default
  thorough:  { maxSteps: 40, evalEvery: 4 },
  lr: 2e-3,                                     // fixed for all three                  (D6)
},
check: {
  callBudget: 68,               // hard ceiling on live-model calls per job, any size   (D4)
  sampleRows: 24,
  chatFormRows: 8,              // only the first 8 sampled questions get the chat rendering too
  parentSamplesMax: 20,
  lockTargetMs: 300_000,
  lockAbortMs: 480_000,
},
preflight: { sampleRows: 24, perCall: 8 },
queuedRowsMax: 2_000,
```

`factsPerJob` (8) stays — it is the cap for the **legacy inline `{facts}`** body and the chat door's basket size,
and it is `rowsPerJob.floorGradient`. Existing keys (`jobsPerKeyPerDay` 3, `jobsPerIpPerDay` 5, `queueMax` 10,
`contributorShare` 0.7, `locality.minSame` 11, `draftTtlDays` 7) are unchanged.

### 6.5 SQLite (`packages/node/src/store.ts`)

New table, additive `CREATE TABLE IF NOT EXISTS` in the same block as `teach_jobs`:

```sql
CREATE TABLE IF NOT EXISTS teach_datasets (
  id TEXT PRIMARY KEY, owner TEXT NOT NULL, ip TEXT, name TEXT,
  status TEXT NOT NULL, source TEXT NOT NULL,
  format TEXT, encoding TEXT, layout TEXT, delimiter TEXT, has_header INTEGER, columns TEXT,
  sha256 TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
  rows INTEGER NOT NULL, invalid_rows INTEGER NOT NULL DEFAULT 0,
  size_bytes INTEGER NOT NULL, source_bytes INTEGER, source_name TEXT, source_sha256 TEXT,
  dir TEXT NOT NULL, summary TEXT, parent_dataset TEXT,
  retention TEXT NOT NULL DEFAULT 'keep',
  created_at REAL NOT NULL, updated_at REAL NOT NULL, expires_at REAL, deleted_at REAL);
CREATE INDEX IF NOT EXISTS idx_teach_datasets_owner ON teach_datasets(owner);
CREATE UNIQUE INDEX IF NOT EXISTS idx_teach_datasets_sha ON teach_datasets(owner, sha256, revision);
```

`teach_jobs` gains six nullable columns through the existing `PRAGMA table_info` idiom already used for
`lesson_applied` (`store.ts:71`), so v1 rows load unchanged:

```
dataset_id TEXT, dataset_sha256 TEXT, dataset_rows INTEGER, dataset_source TEXT,
training TEXT /*json*/, preflight TEXT /*json {checked, of, known}*/
```

`teach_stats` gains three columns and the visitor-facing query is filtered (**D7, live bug fix**):

```
ALTER TABLE teach_stats ADD COLUMN backend TEXT;      -- 'gradient' | 'stub'
ALTER TABLE teach_stats ADD COLUMN rows_trained INTEGER;
ALTER TABLE teach_stats ADD COLUMN sentences INTEGER; -- rows × renderings — what actually drives cost
```
```ts
// before: SELECT total_s FROM teach_stats WHERE total_s IS NOT NULL ORDER BY ts DESC LIMIT ?
teachStats(limit = 50, backend: 'gradient' | 'stub' | 'any' = 'gradient'):
  { total_s: number; load_s: number | null; steps: number | null; rows_trained: number | null; sentences: number | null }[]
```
Rows written before this migration have `backend IS NULL`; they are treated as `'gradient'` on a gradient node and
**excluded** on a stub node (a stub node has no legitimate gradient history).

New store API (all additive except one defaulted signature change):

```ts
insertTeachDataset(d) · updateTeachDataset(id, patch) · getTeachDataset(id)
listTeachDatasets({ owner?, status?, limit? }) · findTeachDatasetBySha(owner, sha256)
deleteTeachDataset(id)                      // tombstone: files removed, row kept with deleted_at
teachQuotaBump(key, day, n = 1)             // ← the only changed signature; defaulted, so every call site compiles
```

Quotas reuse the **existing** `teach_quota(key, day, count)` table with new key namespaces — no new table, no
migration: `addr:<key>` and `ip:<ip>` (v1, jobs) plus `rows:addr:<key>`, `rows:ip:<ip>`, `bytes:addr:<key>`,
`ds:addr:<key>`.

### 6.6 Browser storage

`ainize.teach.basket.<stack>` gains `{ id, filename }` so the chat basket is already a dataset **draft** before it is
POSTed, and `ainize.teach.datasets` keeps the `id → name` map for anonymous browsers, mirroring the existing
`ainize.teach.jobs`.

### 6.7 Two storage rules that are easy to get wrong

- `report.json` is read **paginated from disk**, never inlined into `teach_datasets.summary`. A 2000-row report in the
  summary column would be read on every `listTeachDatasets` call and make *My datasets* slow.
- `revision` changes while `id` stays. Anything that keyed off `(id → bytes)` must key off `(id, revision)` or off the
  sha. The recipe records both.

---

## 7. API

Conventions are v1's (`docs/teach-mode-design.md` §6.1): visitor routes take the `x-ngram-auth` teaching-key
signature; errors are `{ error: "<code>: <human sentence>" }` where `<code>` is the machine-readable prefix of §5.14.

**New in v2:** `TeachError` gains an optional `details` object that the API error handler spreads into the JSON body —
today every teach error is a bare `{error: string}`, so a failed upload cannot return its per-row report and a quota
rejection cannot return the remaining budget.

```ts
export class TeachError extends Error {
  constructor(public status: number, message: string, public details?: Record<string, unknown>) { super(message); }
}
```

### 7.1 `POST /api/teach/datasets`

Visitor auth. Two request shapes.

**(a) `multipart/form-data`** — the file door.
Fields: `file` (exactly one, ≤ `dataset.maxBytes`, extension **and** MIME allowlist `.jsonl .json .csv .tsv .txt` /
`text/*`, `application/json`, `application/x-ndjson`, `text/csv`, `text/tab-separated-values`, and
`application/octet-stream` **only** with an allowed extension), and optional `name`, `format`, `has_header`,
`delimiter`, `encoding`, `columns` (JSON: names or 0-based indexes), `retention`.
Header `x-ngram-dataset-sha256: <hex of the file bytes>` — **this string is what the v2 signature covers** (D14).

**(b) `application/json`** — the chat door, the CLI, and agents.
`{ source: 'chat' | 'inline' | 'sample', rows?: [{prompt, answer, alt_prompt?, note?}], sample?: string, name?, retention? }`

**201** `{ dataset: TeachDataset, report: { summary: TeachDatasetSummary, rows: TeachDatasetRow[0..50] } }`
**200** with the existing dataset and **no quota charge** when `(owner, sha256)` already exists (idempotent re-upload).

| status | code | when |
|---|---|---|
| 403 | `teaching_disabled` / `banned` | policy off, or key/IP banned |
| 413 | `dataset_too_large` | `details: {bytes, max_bytes}` |
| 400 | `dataset_format` | unreadable / unsupported |
| 400 | `dataset_empty` | zero acceptable questions — `details.report` carries the reasons |
| 400 | `dataset_hash` | `x-ngram-dataset-sha256` ≠ the stored bytes |
| 429 | `quota_dataset` / `quota_bytes` / `rate_limited` | `details` carries what is left |

**Ordering rule (security).** The teach gate — worker present → enabled → not banned → `content-length` →
per-IP-per-minute limiter → byte quota — runs in a pre-middleware **before `multer` touches the disk**, on the same
route chain. Registering `upload.single('file')` first (the pattern `/api/patches` uses at `api.ts:273`) lets a banned
key write 4 MB to disk on every request. The incoming temp file is `unlink`ed in a `finally` on **every** error path,
signature mismatch included. The dataset route uses its **own** `multer` instance
(`fileSize = dataset.maxBytes`, `files = 1`, `dest = <dataDir>/teach/incoming`) — never the operator instance with its
4 GB limit.

### 7.2 The rest of the dataset routes

| method + path | auth | body / query | success | errors |
|---|---|---|---|---|
| `POST /api/teach/datasets/:id/reparse` | owner, `staged` only | `{format?, delimiter?, has_header?, encoding?, layout?, columns?}` | 200, same shape as create; `revision` and `sha256` bumped | 409 `dataset_in_use`, 404 |
| `GET /api/teach/datasets` | visitor | — | `{items: TeachDataset[]}` newest first, tombstones included | — |
| `GET /api/teach/datasets/:id` | owner \| operator | — | `{dataset}` | **404 for anyone else** — never confirm existence to a stranger |
| `GET /api/teach/datasets/:id/rows` | owner \| operator | `offset=0&limit=50&status=all\|ok\|rejected` (limit ≤ 200) | `{total, source_rows, offset, limit, items: TeachDatasetRow[]}` | 404 |
| `PATCH /api/teach/datasets/:id` | owner, no active job | `{name?, retention?, rows_op?}` where `rows_op` is `{op:'remove',indexes[]}` \| `{op:'append',rows[]}` \| `{op:'replace',index,row}` | 200 `{dataset, report}`; touched rows revalidated, `revision`+`sha256` bumped, **only newly added questions charged** | 409 `dataset_in_use` → fork |
| `POST /api/teach/datasets/:id/fork` | owner | `{name?, rows_op?}` | 201 `{dataset}` with `parent_dataset = :id`, `revision = 1` | 404 |
| `DELETE /api/teach/datasets/:id` | owner \| operator | — | `{ok:true, status:'deleted'}` — files removed, tombstone kept | 409 while a `QUEUED…CHECKING` job references it |
| `GET /api/teach/datasets/:id/download` | owner \| operator \| save-token | `format=jsonl\|csv&token=` | canonical bytes; `content-disposition: attachment; filename="dataset-<id>-r<rev>.jsonl"`; `x-content-sha256` | 404 |
| `GET /api/teach/samples` | public, `max-age=3600` | — | `{samples:[{kind,name,rows,sha256,description,preview:TeachDatasetRow[0..5],download_url}]}` | — |
| `GET /api/teach/samples/:kind` | public | `kind = ko-facts \| en-facts \| mixed` | the `.jsonl` file | 404 |
| `GET /api/me/teach/datasets` | operator | `limit?` | `{items:[TeachDataset & {ip, owner}]}` — moderation view | 403 |

`GET /api/teach/datasets/:id/download` is registered **after** `GET /api/teach/samples` and the literal `samples`
path segment is reserved (D13).

### 7.3 Extended existing routes

**`POST /api/teach/preflight`** — the v1 `{patch_ids, facts}` form is unchanged. New alternative form
`{patch_ids, dataset_id, offset?, limit?}` probes at most `preflight.perCall` (8) questions per call and at most
`preflight.sampleRows` (24) per job. Response gains `sampled: {checked, of}`. The v1 `preflightUnits` cost accounting
and the "charge both IP **and** key" rule (`api.ts:416`) are unchanged.

**`POST /api/teach/jobs`** — backward compatible. Body is `{dataset_id}` **XOR** `{facts}`:

```jsonc
{
  "dataset_id": "…",                       // or legacy "facts": [...] (1..factsPerJob)
  "selected_indexes": [0,1,2,5],           // optional; default = the first rowsPerJob acceptable questions
  "patch_ids": ["…"],                      // 0..3, unchanged
  "builds_on_context": true,
  "name": "…", "contributor": {"name": "…"},
  "training": { "effort": "balanced", "check_side_effects": true, "use_alt": true,
                "max_steps": 20, "eval_every": 2, "rows_limit": 32, "row_offset": 0 }
}
```

The legacy `{facts}` form **materialises a dataset** with `source: 'chat'` server-side, so there is no second code
path to keep alive. `training.max_steps` / `eval_every` are clamped server-side to the operator's `effort` presets;
`lr` is not accepted from the client.
**202** `{job: TeachJob, quota: {key_remaining, ip_remaining, rows_remaining}}`.
Errors: 400 `dataset_too_large` (only when `rows_limit` exceeds the cap — otherwise the selection is capped and the
banner explains it), 400 `invalid`, 404 `dataset_not_found`, 409 `already_known` / `overlaps_listing`,
429 `quota_key` / `quota_ip` / `quota_rows`, 503 `trainer_paused`.

**`GET /api/teach/jobs/:id`** — auth rules unchanged. The owner/operator view gains `dataset: TeachDatasetRef` and
the extended `progress` (`phase`, `percent`, `rows_total`, `rows_touched`, `eval_sample`, `elapsed_s`, `started_at`).
**The public view is unchanged** (`id, status, position, eta_s`) and never leaks the dataset.

**`POST /api/teach/jobs/:id/retrain`** — owner. `{dataset_id?, training?, selected_indexes?}`. Re-runs the pipeline
from the **same** dataset by default, or from a fork / another owned dataset. Sets `parent_job`, re-charges quota.
202, same shape as create. The v1 `POST /:id/retry {facts}` **stays** as an alias that forks the job's dataset with
the edited questions and starts a job from the fork.

**`GET /api/teach/jobs/:id/events?since=<seq>&limit=200`** — owner or operator. `{events:[{seq,ts,level,message,data}], cursor}`,
this job's `teach` events only, redacted for non-operators exactly as `/api/events` already does (`api.ts:72-75`).
Poll every 2 s while the job is active. This is the scrolling log beside the progress bar.

**`GET /api/teach/policy`** — additive only; the 10 s cache and the 30-calls-per-minute limiter are unchanged.

```jsonc
"limits": { …v1…,
  "dataset_max_bytes": 4000000, "dataset_max_rows": 2000, "dataset_max_source_lines": 50000,
  "rows_per_job": 8, "rows_per_job_source": "default",     // "measured" once the fit exists
  "rows_per_key_per_day": 300, "rows_per_ip_per_day": 500,
  "datasets_per_key_per_day": 10, "dataset_ttl_days": 7,
  "formats": ["jsonl","json","csv","tsv","txt"],
  "declaration_rows": 100 },
"effort": [ {"id":"quick","max_steps":8,"eval_every":2},
            {"id":"balanced","max_steps":20,"eval_every":2},
            {"id":"thorough","max_steps":40,"eval_every":4} ],
"timing": { "samples": 0, "backend": "gradient", "simulated": false,
            "load_s_p50": null, "s_per_row_p50": null, "s_per_row_p90": null,
            "p50_s": null, "p90_s": null },                 // p50_s/p90_s stay for v1 clients
"queue": { "depth": 0, "max": 10, "queued_rows": 0, "queued_rows_max": 2000, "position_eta_s": null },
"samples": [ {"kind":"ko-facts","name":"…","rows":5}, … ]
```

Every `timing` field is `null` until there are ≥ 3 samples with `backend = 'gradient'`. A stub node reports
`simulated: true` and the UI shows **no minutes at all**.

**`PATCH /api/me/teach/policy`** — additive operator keys: `dataset_max_bytes`, `dataset_max_rows`, `rows_per_job`
(an explicit override that disables the derivation), `rows_per_key_per_day`, `rows_per_ip_per_day`,
`datasets_per_key_per_day`, `dataset_ttl_days`, `declaration_rows`, `queued_rows_max`, `check_call_budget`.

### 7.4 CLI parity (`packages/cli`)

```
ainize teach dataset <file> [--format f] [--delimiter c] [--no-header] [--columns json] [--name n]
ainize teach dataset ls | rm <id> | download <id> [-o out.jsonl]
ainize teach train --dataset <id> [--effort quick|balanced|thorough] [--rows n]
ainize teach status                       # unchanged, now prints the dataset line
```
`openapi.ts` documents every route above.

---

## 8. Parser and validation rules

New module `packages/node/src/teach-dataset.ts` — **pure functions over a `Buffer`**, no filesystem, no database, no
network, so the whole of §8 is unit-testable without a node. The service layer (§14 PR-D4) does the I/O.

### 8.1 Format detection

Explicit `format` wins. Otherwise by extension. Otherwise sniffed: first non-space byte `[` → JSON array, `{` → JSONL,
a consistent delimiter count over the first 20 non-empty logical rows → CSV/TSV, else TXT.

**Encoding:** strip a UTF-8 BOM; decode UTF-16 LE/BE from their BOMs; else strict UTF-8; on failure `euc-kr`/`cp949`
(Node 24 ships full ICU, so `TextDecoder('euc-kr')` works); `latin1` as a last resort. The chosen encoding is recorded
and **shown in the preview** (`teach.rows.encoding`), because encoding misdetection is the most likely silent
corruption: a short CP949 file can decode as valid UTF-8 and produce mojibake that passes every other check.
A dataset where more than 20 % of accepted rows contain `U+FFFD` is flagged in the summary and the preview offers
*Read it again* with an explicit encoding.

**Newlines:** `\r\n`, `\r` and `\n` are all accepted; a lone `\r` inside a quoted CSV field is preserved.

### 8.2 CSV / TSV

RFC 4180 state machine — double-quote quoting, `""` escape, embedded newlines and delimiters inside quotes.
**A line-based parser is not acceptable here**, and the report's `line` numbers must count *logical* source rows, or
the preview points at the wrong place.

Delimiter sniffed from the first 20 non-empty logical rows by picking the candidate from `, \t ; |` with the most
consistent modal field count ≥ 2 (tie → comma; `.tsv` defaults to tab). Header detected when every first-row cell is
non-numeric, ≤ 64 chars, unique after casefolding, and at least one matches a column alias.

Column aliases, casefolded and whitespace/underscore-insensitive:

| field | aliases |
|---|---|
| `prompt` | `prompt` `question` `q` `input` `instruction` `query` `질문` `문제` `입력` |
| `answer` | `answer` `a` `output` `response` `completion` `target` `답` `답변` `정답` `출력` |
| `alt_prompt` | `alt_prompt` `alt` `alt_question` `paraphrase` `another_way` `다른질문` `유사질문` `다른표현` |
| `note` | `note` `memo` `source` `comment` `설명` `비고` |

No header → positional `0=prompt, 1=answer, 2=alt_prompt, 3=note`. Extra columns are ignored with **one** summary
warning. A ragged row is a **per-row** reject, never a whole-file failure.

### 8.3 JSONL / JSON

An object per line, or a single top-level array. The same aliases apply to keys. Additionally accepted:

- **Alpaca** `{instruction, input?, output}` → `prompt = instruction` (+ `"\n" + input` when `input` is non-empty).
- **ChatML** `{messages:[{role:'user',content},{role:'assistant',content}]}` → last `user` → prompt, last `assistant`
  → answer; a leading `system` message is ignored and counted in the summary.

A line that is valid JSON but not an object → `not_parsed`.

### 8.4 TXT layouts

Chosen by the first sniffer that matches over the first 200 lines, and recorded as `layout`:

1. tab-separated → treat as TSV;
2. `Q:`/`A:` or `질문:`/`답:` pairs;
3. blank-line-separated blocks — first line prompt, remainder answer;
4. otherwise every line is a prompt with no answer → **all rows `empty`**, and the upload returns
   `400 dataset_empty` with the report. The visitor is told the file has no answers rather than getting invented ones.

### 8.5 Normalisation and per-row status

Normalisation, in order, per row: NFC → trim ends → collapse internal `\s+` to one space in `prompt` and `alt_prompt`
→ flatten newlines/tabs in `answer` to single spaces (recorded as the fix `answer_flattened`, **not** a rejection —
v1's one-line rule is enforced by normalisation, not refusal) → strip a wrapping `Q: …\nA:` from a prompt that is
already a benchmark rendering → drop zero-width and bidi control characters using the **same character class as
`NAME_BLOCKLIST`** (`teach.ts:113`) from every field → cap `note` at 500 chars.

| status | rule | blocks training? |
|---|---|---|
| `ok` | passes everything | no — trains |
| `fixed` | trains, with `fixes[]` listed in the preview | no — trains |
| `duplicate` | same normalised prompt **and** answer as an earlier row → the later one is dropped, the first kept | dropped, counted |
| `conflict` | same normalised prompt, **different** answer → **all** copies excluded and cross-linked (D11) | yes, until one is chosen |
| `too_long` | `prompt > 400` or `answer > 200` (v1 `PROMPT_MAX` / `ANSWER_MAX`, unchanged), exact overflow reported | yes |
| `empty` | prompt or answer missing after normalisation | yes |
| `blocked` | matches the operator's `blockedTopics` regex on any field | yes |
| `not_parsed` | unreadable line, with a ≤ 200-char raw excerpt | yes |

Only `ok` and `fixed` rows enter `rows.jsonl`. Every entry in `report.json` carries its 1-based logical source line.

**Advisory (never blocks): `shared_ending`.** Group the accepted prompts by their last three whitespace-delimited
tokens (falling back to the last 8 characters for scripts without spaces). Any group of ≥ 3 is flagged with
`teach.rows.status.shared_end` and the group count. Rationale is measured, not theoretical:
`results/03-addressability.md` found that all 2804 KRX listings read the *identical* 16 addresses **at the answer
position** for the natural `{name} 종목코드는` phrasing — a direct-addressable fraction of **0 %** — and editing one
listing's rows visibly moved two others' outputs. The same document's correction is equally load-bearing: indirect
addresses at the earlier unique positions exist, but coordinating them well enough to carry a six-digit code failed
(prefix match went 3/7 → 2/7). So the flag says *very likely to be learned as one*, offers a rewrite, and **never
blocks training** — this is a warning that costs nothing and may be wrong, not a gate. *Rephrase them for me*
rewrites the group into the `Q: {subject} — {attribute}?` template the trainer already uses.

### 8.6 Language

Never an error. Per-row script guess (`hangul | latin | han | kana | other`) by codepoint majority, aggregated into
`summary.langs`. A mixed-script dataset produces exactly one informational note — *"this dataset mixes Korean and
English — the unrelated-questions check uses both"* — and nothing else.

### 8.7 `report.json`

```jsonc
{ "version": 1, "format": "csv", "encoding": "utf-8", "layout": null, "delimiter": ",",
  "has_header": true, "columns": {"prompt":"question","answer":"정답"},
  "source_rows": 512,
  "summary": { "accepted": 498, "fixed": 12, "rejected": 14, "duplicates": 6, "conflicts": 2,
               "blocked": 0, "too_long": 3, "empty": 1, "not_parsed": 2, "shared_ending": 40,
               "langs": {"hangul": 480, "latin": 18, "han": 0, "kana": 0, "other": 0} },
  "rows": [ { "index": 0, "line": 2, "status": "ok", "lang": "hangul" }, … ] }
```
Capped at `dataset.maxSourceLines` (50 000) entries, written once at parse time, read paginated.

---

## 9. Limits — rationale and visitor copy

Every limit below is served from `GET /api/teach/policy`. **No limit may be hard-coded in the web bundle.**

| limit | default | why this number | visitor copy (en / ko) |
|---|---|---|---|
| questions per lesson | derived; floor **8** gradient / 200 stub, ceiling 1000 | The two measured per-sentence rates on this hardware differ 18× (`train_all.log` 0.18 s/sentence at `micro=64`; `train_fact.log` 3.2 s/sentence at `micro=9`), which is 6–240 questions in a 30-minute job. Exactly one measured `teach.py` GPU run collapses that band; until then 8 is the correct ship-now default, not a timid one. Deriving from `trainer.timeoutMs` keeps the cap and the kill timeout from ever disagreeing. | *This node teaches up to {max} questions in one lesson. Your dataset has {n} — the first {max} are used, and the rest wait for the next lesson.* / *이 노드는 한 수업에 질문 {max}개까지 가르칩니다. 데이터셋에는 {n}개가 있어 앞의 {max}개를 쓰고 나머지는 다음 수업으로 넘깁니다.* |
| questions per dataset | 2 000 | Comfortably above any plausible job cap, below the point where `report.json` paging and the preview table stop being pleasant. | *This node keeps up to {max} questions in one dataset. The first {max} were loaded.* / *이 노드는 한 데이터셋에 질문 {max}개까지 보관합니다. 앞의 {max}개를 불러왔습니다.* |
| file size | 4 MB (operator ceiling 20 MB) | 2000 questions at the 400+200 char limits is ~1.2 MB, so the **question** cap always bites first and the visitor gets the readable message. Uploads never pass through `express.json` (`limit: '5mb'`, `server.ts:82`), which would otherwise fail with a body-parser error. | *That file is {size} — the limit here is {max} MB. Remove some questions or split the file.* / *파일이 {size}입니다 — 이 노드의 한도는 {max} MB입니다. 질문을 줄이거나 파일을 나누세요.* |
| source lines parsed | 50 000 | Bounds parse time and `report.json`. | *Only the first {max} lines of that file were read.* / *파일의 앞 {max}줄만 읽었습니다.* |
| question ≤ 400 / answer ≤ 200 chars | v1 `PROMPT_MAX` / `ANSWER_MAX` | Memory rows scale with token positions (~16 rows per position across the 2- and 3-gram heads at `ple_layer_ids [2]`, `heads_per_ngram 8`), so a 400-char prompt can touch 10–30× more table rows than the short KRX facts every measurement is based on — inflating both training time and file size unpredictably. | *Each question must be 400 characters or fewer and each answer 200 or fewer — short, factual pairs are what the model can actually memorise.* / *질문은 400자, 정답은 200자 이내여야 합니다 — 짧고 사실적인 쌍이 실제로 기억됩니다.* |
| concurrent training jobs | **1, permanently** | Two `teach.py` processes cannot coexist: each loads the 49 GB W4A16 backbone across three GPUs (measured 24 GB of 40 GB per GPU in `train_all`) and each mmaps the 102 GB CPU PLE table. Concurrency comes from a longer queue, never from parallel jobs. | *One lesson trains at a time here. There are {n} ahead of you ({q} questions).* / *여기서는 한 번에 한 수업만 학습합니다. 앞에 {n}개(질문 {q}개)가 있습니다.* |
| questions per key / IP per day | 300 / 500 | GPU-seconds, not job count, is the scarce resource. Today's 3 jobs/key/day at 1000 questions each would be ~8 GPU-hours from one visitor. `jobsPerKeyPerDay = 3` stays as a secondary cap; **operators who raise it must raise this together** or visitors get a confusing `quota_rows`. Every quota response surfaces both remainders. | *You have {n} of {limit} questions left to teach on this node today. Come back tomorrow, or run your own node — the instructions come with every lesson you download.* / *이 노드에서 오늘 가르칠 수 있는 질문이 {limit}개 중 {n}개 남았습니다. 내일 다시 오거나 직접 노드를 운영하세요 — 내려받는 수업마다 실행 방법이 들어 있습니다.* |
| datasets per key | 10/day, 20 kept | Bounds a denial-of-disk that otherwise exists the moment `POST /api/teach/datasets` ships. | *You have reached the number of datasets this node keeps for one teaching key. Delete one first.* / *이 노드가 가르치기 키 하나에 보관하는 데이터셋 수를 넘었습니다. 하나를 먼저 삭제하세요.* |
| queued questions | 2 000 | `queueMax` counts **jobs**; ten 1000-question jobs behind one trainer slot is a ~28-hour backlog. | *The training queue on this node is full right now. Try again in a little while.* / *지금 이 노드의 학습 대기열이 가득 찼습니다. 잠시 뒤 다시 시도해 주세요.* |
| live-model calls per check | **68, any dataset size** | The v1 census is already 78 sequential calls at 8 facts (12 locality pre + 3×8 + 12 post + ≤30 parent) ≈ 5.5 min of held runtime lock at the only measured figure on this host (4.25 s/completion serial-equivalent, `results/verify-all.log`) — against a spec claiming CHECKING is bounded at 90 s. At 100 questions the census is 354 calls (~25 min); at 1000 it is 3054 (~3.6 h). `results/12-parallel-crash.md` documents that the vLLM PLE offload path stalls under sustained load **and at idle**, restarting in ~5 min with the table reverted — so a long hold does not merely block others, it makes the measurement likely to be interrupted and re-run. | *We check a sample of {k} questions in the live model, plus 12 everyday questions that must keep their exact answers. Checking every question would take the shared model away from other people.* / *실제 모델에서 질문 {k}개를 표본으로 확인하고, 일반 질문 12개의 답이 그대로인지 봅니다. 모든 질문을 확인하면 공용 모델을 너무 오래 붙잡게 됩니다.* |
| lesson file size | exact, not estimated | `npz bytes = 1288 × rows + 750` (int64 addr + float32[160] before + float32[160] after, plus a constant zip header), **verified to the byte** on three real lessons this session — 2992 rows → 3 854 446 B, 270 053 → 347 829 014 B, 388 642 → 500 571 646 B, all three leaving exactly 750 B of overhead. Row growth per question is empirical and decaying — from `train_all.log`, the first ~213 listings cost 234 rows each, listings 213–426 cost 150, the last 213 of epoch 1 cost 35.5, settling at 87.6 rows per listing. Planning model: `rows ≈ 3000 + 40..150 per question`. Apply is linear and cheap (270 053 rows measured 2.1 s; 2992 rows 239 ms). | *{size} MB · {rows} memory entries · loads into a running model in about {t} seconds.* / *{size} MB · 메모리 항목 {rows}개 · 실행 중인 모델에 약 {t}초 만에 적용됩니다.* — plus, above ~150 MB: *This lesson is large — check your node has the disk and bandwidth for it.* / *이 수업은 용량이 큽니다 — 노드의 디스크와 대역폭을 확인하세요.* |
| declaration threshold | 100 questions | Eight chat corrections are plausibly the visitor's own words; a 5000-row CSV is plausibly someone else's database, and the marketplace pays the uploader 70 % of every sale for it. | *You are publishing {n} questions. Confirm you have the right to share this data and that it contains no personal information — published lessons cannot be deleted.* / *질문 {n}개를 공개합니다. 이 데이터를 공유할 권리가 있고 개인정보가 없음을 확인해 주세요 — 공개된 수업은 삭제할 수 없습니다.* |

**What a realistic job looks like once GPUs 4–6 are free.** Using the measured row-cost rule — ~1.0 s of 3×A100 per
question per pass at `micro=64`, derived from `train_all.log` (2761 facts × 3 renderings × 12 epochs in 25 168 s =
0.76 s/row/pass, scaled by 4/3 for `teach.py`'s four renderings; cross-checked against `train_p3.log`'s 1.69 s/row/pass
for 5 renderings = the same 0.34 s per row per rendering) — plus a ~72 s model load, a 10-pass job costs
`72 + 10 × questions` seconds:

| questions | 8 | 50 | 100 | 200 | 500 | 1 000 | 2 761 |
|---|---|---|---|---|---|---|---|
| projected | ~2.5 min | ~10 min | ~17 min | ~33 min | ~1.5 h | ~2.8 h | ~7.7 h (measured 8.3 h end-to-end) |

The product sweet spot for something that must feel like Teachable NLP is **100–250 questions in a sub-30-minute
job**. 1000 is a legitimate overnight tier if the operator raises `trainer.timeoutMs`. **None of these numbers may
appear in the UI until §10's conditions are met.**

---

## 10. Progress and ETA rules

Extends v1 §8.4; the honesty rule is unchanged and now rows-aware.

**The bar.** `step / max_steps` inside the *Teaching* stage. Real fraction, stops at the last real step.
`progress.percent` is an *additional* stage-weighted field (load 10 % / train 75 % / check 15 %), computed in the node,
clamped monotonic (`Math.max(prev, computed)`), for compact surfaces only. Never labelled as time.

**Elapsed** is always shown and always honest (`Date.now() − started_at`).

**ETA** is shown only when **all** of these hold:

1. `timing.samples ≥ 3` **with `backend = 'gradient'`** (D7 — this is the live-bug fix; three 3-second stub jobs must
   never satisfy it);
2. the node computed a fit `t = load_s_p50 + passes × questions × s_per_row_p50` for **this job's** question count and
   effort — not a global p50 over jobs of unrelated sizes;
3. the node actually sent `eta_s`.

Then: `< 90 s` → *"less than a minute left"*; otherwise *"about {min} min left"*.
Otherwise, verbatim: *"No time estimate yet — this node has not finished enough lessons to know. The first one may
take up to 30 minutes."*

**Queue ETA is rows-weighted, not position-weighted.** v1's `policy.queue.position_eta_s` multiplies queue depth by a
global p50; with an 8-question job behind a 1000-question job that is wrong by two orders of magnitude. The queue line
shows both counts: *"{n} lesson(s) ahead of you ({q} questions in total)."*

**Stub nodes show no minutes at all.** `timing.simulated = true`, `p50_s = null`, `position_eta_s = null`, the
*Warming up* stage becomes *Starting…*, and the result screen carries `teach.res.simulated`.

**Settings-screen estimate** obeys the same three conditions and additionally must be for a comparable question count;
otherwise the effort cards show `teach.set.effort_time_unknown`. Getting this wrong — inventing a per-preset minute
figure — is the single worst honesty failure available in this design.

---

## 11. Re-train and continue

Four flows, all built on the dataset being durable and its edits being versioned:

| flow | entry | what happens |
|---|---|---|
| **Train it again** | result screen card, or *My datasets* row | `POST /api/teach/jobs/:id/retrain` with the same `dataset_id`, effort bumped one level. Same input, `parent_job` set, quota re-charged. |
| **Add questions** | *My datasets*, or *What it did not learn* on the result screen | `PATCH …/datasets/:id {rows_op:{op:'append'}}` when idle → `revision++`, `sha256` changes, only the new questions are charged. If a job is running: `409 dataset_in_use` → the client calls `POST …/fork` and edits the child (`parent_dataset` set, `revision = 1`). |
| **Continue from this dataset** | *My datasets* lesson row | fork → edit in the preview → new job. This is how a 500-question dataset is taught as several lessons today (§17 Q2). |
| **Improve and retry** (v1) | `NEEDS_MORE` card | unchanged `POST /:id/retry {facts}`, now implemented as *fork the job's dataset with the edited questions, then create a job from the fork* — so a v1 retry also leaves a re-trainable artifact. |

**Cancel** never deletes the dataset — that is what makes *"Your dataset is kept, so you can train it again"* true.

**Retention and sweep.** `sweepExpired()` gains three passes: `staged` datasets older than `stagedTtlHours` (24 h);
`ready` datasets `ttlDays` (7) after their last job finished; and the files of tombstoned datasets.
`retention = 'delete_after_training'` removes `source.<ext>` and `rows.jsonl` as soon as the job reaches
`READY` / `NEEDS_MORE` / `FAILED` — `report.json` and the `sha256` survive, so the lesson can still state what it was
trained on. Deleting a dataset leaves a tombstone so a lesson shows *"the dataset for this lesson was deleted by its
owner"* rather than a dangling id, and the delete confirmation must say that a published lesson then becomes
unreproducible by its own teacher (the `.npz` and `recipe.json` remain the deliverable).

---

## 12. Safety

### 12.1 Prompt injection has five exits from a dataset, not one

Uploaded question text ends up (a) trained as the model's answer, (b) in `recipe.json` in plaintext, (c) in
`benchmark_samples` inside the **public, immutable** anchor, (d) in `RUN-LOCALLY.md`, (e) rendered in the live-test
chat and in the operator's review UI. v1's `NAME_BLOCKLIST` covers display names only.

Rules:
- Apply the **same** control / bidi / zero-width character class as `NAME_BLOCKLIST` (`teach.ts:113`) to **every**
  dataset field at parse time. An RTL override in question 400 would render corrupted text on the public knowledge page.
- Never interpolate dataset text into an LLM instruction. The trainer receives it as data in `job.json` / `facts.jsonl`;
  the checker sends it as a completion prefix. Neither builds a natural-language instruction around it.
- Render `benchmark_samples` as inert text everywhere — catalog, knowledge page, operator review, `RUN-LOCALLY.md`.
- The per-field character caps also bound how large an injected payload can be.

### 12.2 PII is irreversible once published

`recipe.json` stores the exact sentences verbatim and `benchmark_samples` go into the on-chain anchor, so publication
is permanent and plaintext. The `.npz` is not a hiding place either — it is a delta on named rows, not encryption.

- The **upload screen** states, above the file picker, that the file is stored on this node and the operator can see it.
- `retention: 'delete_after_training'` is one click away on the upload screen and in *My datasets*.
- A pre-publish scan flags per-row shapes (email, phone number, national-ID, card number) and **hard-blocks publish**
  for flagged questions. Keeping the lesson private stays allowed at every size.
- Above `declarationRows` (100), publishing additionally requires a source/licence choice (own work / public source /
  licensed) and the explicit consent line in §9.
- The operator moderation view (`GET /api/me/teach/datasets`) is behind `requireOperator` and writes an audit event.

### 12.3 Contradictory and near-duplicate questions fail silently in training

Two questions with the same prompt and different answers put opposing gradients on identical memory rows; the loss
floors at the entropy of the split and greedy generation returns whichever appeared more often — no error, no warning,
and a sampled check may miss both. Near-duplicates are the subtler case: two questions that differ only *outside* the final three
tokens before the answer share their **direct** address, so they look completely different to a human and nearly
identical to the model. Both are surfaced by §8.5 validation (`conflict` blocks, `shared_ending` warns) **before** a
GPU-second is spent, rather than being discovered as a bad result half an hour later.

### 12.4 Collateral damage grows with the dataset, and it is measured

One single-fact edit touched the rows of 431 other KRX listings through 2-gram context sharing; restricting to 3-gram
heads cut that to 1 (`results/06`, `results/10`). Within a large dataset the sharing is *internal and unavoidable*: of
the 2360 rows one listing's sentences cross, 1984 are shared with other listings and only 376 are unique.
`train_all` went 18.4 % → 99.6 % over 12 epochs and never reached 100 % on the shared-row path; the last six listings
only landed after a pinpoint pass over unique-only rows.

**Product consequence, stated plainly in the UI:** a large dataset lands ~95–99 % of its questions, not 100 %, and
which ones fail is not predictable from the file. `teach.res.partial_hint` already says the right thing; it must not be
softened.

**Thinning contrast causes regression, also measured.** `teach.py` caps `max_contrast` at 8. At 1000 questions the
target:contrast ratio is 125:1 and shared rows have nothing anchoring them. `train_all`'s abandoned stage 2
("2단계 (폐기)") trained 12 wrong listings against a reduced contrast set, got no improvement, and **regressed SPAC
listings that had dropped out of the contrast set**; the documented conclusion is 공유 행은 전체 분포로 잡아야 한다.
Hence the trainer change `max_contrast = clamp(8, ceil(rows/2), 64)` (§14 PR-D6), drawn from the parents' benchmark
samples first, then `train/teach_contrast.json`, then a rotating sample of the node's already-published lessons.

### 12.5 Abuse and quotas

| surface | control |
|---|---|
| GPU-time DoS via large datasets | `rowsPerKeyPerDay` 300 / `rowsPerIpPerDay` 500 / `queuedRowsMax` 2000, on top of the v1 job caps and `ACTIVE_JOBS_PER_KEY` 2. Without these the file door is a strictly worse DoS surface than the chat door it generalises. |
| denial-of-disk via uploads | teach gate **before** multer; per-IP-per-minute create limiter; `bytesPerKeyPerDay` charged **before** parsing, not after; `datasetsPerKey`; TTL sweep. |
| lying about `x-ngram-dataset-sha256` | The mismatch is caught after the bytes are already spent, so this header is paired with the per-IP-per-minute limiter and the byte quota — it authenticates, it does not throttle. |
| dedup as an oracle | Scoped to `(owner, sha256)`. The 200-vs-201 difference reveals only the caller's own datasets. **Do not widen dedup to a global sha** (D3). |
| sampled checks weakening `NEEDS_MORE` | A 500-question dataset where 24 sampled questions stick can still have taught little. The publish gates (locality, parent regression) are unaffected; the *copy* is the control — `teach.res.checked_sample`, never a whole-dataset claim. |
| stub npz in the catalog | A 500-question stub `.npz` looks like a real lesson. `recipe.trainer = 'stub'`, `checks.simulated`, `result.simulated` and the `hyper_params` note must all survive into the published anchor, and `publish` should default to `'never'` on a stub node unless it is an explicit demo node. |
| banned key / IP | v1 `assertNotBanned` runs in the pre-multer gate, so a banned key cannot spend the node's disk. |

### 12.6 Publish gates (unchanged, plus one)

`locality.ok && parent_regression.ok && checks.executed` remain **hard** gates. New: `checks.skipped` (the visitor
turned the side-effect check off) also gates publish, with a visible *Run the check now* path
(`POST /api/teach/jobs/:id/recheck`, which already exists). Above `declarationRows`, the declaration is a fourth gate.

---

## 13. What stays unchanged from teach mode v1

Nothing in this list may be modified by a v2 PR. If a v2 change appears to require one of these, stop and raise it.

- **Identity and auth.** Browser-generated secp256k1 teaching key, `x-ngram-auth` v2 request-bound signature and the
  legacy `teach:<ts>` form, replay guard, `teacherOf` / `requireTeacher` / `ownerJob` in `api.ts`.
- **The worker state machine.** `QUEUED → PREFLIGHT → LOADING → TRAINING → EXPORTED → CHECKING → READY | NEEDS_MORE`,
  plus `FAILED / CANCELLED / PENDING_REVIEW / REJECTED / ANNOUNCED / EXPIRED`. Slot lease via atomic mkdir, the
  `docker exec pgrep` check, the `minFreeGpuMb` check, the 15-minute runtime grace, the 45-minute stale-lock rule,
  restart recovery, `lesson_applied` bookkeeping and `reassertPinned()`.
- **`TAUGHT_MIN_RATIO` 0.75** for `NEEDS_MORE`.
- **The 12 fixed locality prompts and `minSame = 11`.** They stay 12 and stay fixed — they cost 24 of the 68-call
  budget and they are the publish gate. A bigger dataset needs a bigger *contrast* set (training side), not more
  locality prompts (checking side).
- **Parent regression** at ≥ 0.9, over each context knowledge's benchmark samples.
- **Publish path.** `createDraft` → `updateDraft` → `review | auto` → `announce()` → existing verifier quorum-2 →
  `LISTED`. Anchor shape, `visibility`, `origin: 'teach'`, `MAX_CONTRIBUTORS = 4`.
- **Payouts.** `contributorShare` 0.7, `royaltySplit` two-pass, `Contributor {proof: 'signed' | 'declared'}`,
  `creditedAddress()`, the earnings panel and `/api/teacher/:address`.
- **Private drafts.** `draftTtlDays` 7, save tokens, `lesson-*.npz` + `recipe.json` + `RUN-LOCALLY.md`,
  `KeepPrivateSheet` leading with keep-on-this-node.
- **Quota primitives.** `jobsPerKeyPerDay` 3, `jobsPerIpPerDay` 5, `ACTIVE_JOBS_PER_KEY` 2, `queueMax` 10, bans by
  address and IP, the `teach_quota` table itself.
- **`PROMPT_MAX` 400 / `ANSWER_MAX` 200 / one-line answers / `blockedTopics`** — v2 enforces them per row with a
  fix-it sentence instead of a whole-file reject, but the values and `staticFactCheck` are unchanged.
- **Event redaction.** `/api/events` teach-line redaction (`api.ts:72-75`) and the rule that prompts, draft ids and
  teaching keys never appear in public log lines.
- **The trainer's corpus contract.** Four renderings per fact, loss on answer tokens only, the tokenizer-boundary
  rule, `Q: {prompt}\nA: {answer}` as the authoritative benchmark rendering, the stdout JSON event protocol, and the
  `lesson.npz` `{addrs, before, after}` export shape.
- **`ChatMode`, the knowledge picker, the contamination banner, live-test quotas** (20/IP/hour anonymous).
- **All 253 existing i18n keys** and the v1 components (`TeachDrawer`, `CreditSheet`, `PreflightList`, `LessonCard`,
  `PublishSheet`, `KeepPrivateSheet`, `MyKnowledgePanel`) — extended, never replaced.

---

## 14. Implementation plan

Ten PRs. Each is independently reviewable, each leaves the tree green, and the first five ship no UI so they can land
while the web work is in flight. File lists are exact.

**PR-D1 — core: dataset types and config.** No behaviour.
`packages/core/src/types.ts` (`TeachDataset`, `TeachDatasetSummary`, `TeachDatasetRow`, `TeachDatasetRef`,
`TeachDatasetSource/Status`, `TeachRowStatus`; `PatchRecipe.dataset`, `PatchAnchor.dataset`) ·
`packages/core/src/config.ts` (`TeachConfig.dataset` / `rowsPerJob` / `effort` / `check` / `preflight` /
`queuedRowsMax`, merged in `teachConfig()` like `trainer` and `locality`) ·
`packages/core/test/config.test.ts`.
*Gate:* `npm test -w packages/core` green; a config written before v2 still loads with the new defaults filled.

**PR-D2 — node: the parser, pure.** No I/O, no DB, no network.
`packages/node/src/teach-dataset.ts` (detect → decode → parse → normalise → status → `report.json` shape;
§8 in full) · `packages/node/test/teach-dataset.test.ts` (table-driven, ~60 fixtures) ·
`packages/node/test/fixtures/datasets/*` (utf8/cp949/utf16 · CRLF/CR/LF · quoted CSV with embedded newlines and
commas · semicolon and pipe delimiters · headerless 2-column · aliased headers incl. Korean · ragged rows ·
Alpaca · ChatML · JSON array · Q:/A: txt · blank-block txt · prompt-only txt · conflicts · duplicates ·
over-length · blocked topic · bidi/zero-width · shared-ending group · 50k-line file).
*Gate:* `node --test --import tsx packages/node/test/teach-dataset.test.ts`.

**PR-D3 — node: store.** `packages/node/src/store.ts` — the `teach_datasets` table and indexes, the six additive
`teach_jobs` columns via the `PRAGMA table_info` idiom, the three `teach_stats` columns, `teachStats()` filtered to
`backend`, `teachQuotaBump(key, day, n = 1)`, and the eight dataset accessors. Migration test: open a **v1** database
file, assert every column arrives and every existing row still reads.
*Gate:* `node --test --import tsx packages/node/test/{chat,cluster,payouts,teach}.test.ts` — never `ain.test.ts`.

**PR-D4 — node: dataset service + API + operator moderation.**
`packages/node/src/teach-datasets.ts` (service: create / reparse / patch / fork / delete / download / samples /
retention sweep / quota charging) · `packages/node/src/api.ts` (the routes of §7.1–§7.2 with the **pre-multer teach
gate** and a dedicated multer instance; `TeachError.details` spread by the error handler) ·
`packages/node/src/openapi.ts` · `packages/node/src/samples/{ko-facts,en-facts,mixed}.jsonl` ·
`packages/node/test/teach-datasets.test.ts`.
*Gate:* upload → preview → patch → fork → download round-trips byte-identically; a banned key's upload writes
**nothing** to disk; every error path unlinks the temp file.

**PR-D5 — node: worker integration.**
`packages/node/src/teach.ts` — `createJob({dataset_id | facts})` resolving to a dataset and materialising one for the
legacy body; `facts` as the trained slice with `selected_indexes`; deterministic sampled preflight and check
(`seed = sha256(dataset_sha256 + ':' + revision)`, composition per §D4) with the 68-call budget and the
`lockTargetMs` / `lockAbortMs` guard; `progress.{phase,percent,rows_total,rows_touched,eval_sample,elapsed_s}`;
rows-aware ETA and `rowsPerJob` derivation; `retrain`; lazy materialisation for v1 jobs; sweep passes;
`putTeachStat` with `backend` / `rows_trained` / `sentences` · `packages/node/src/teach-recipe.ts`
(`recipe.dataset`, `checks.taught.sampled`) · `packages/node/src/api.ts` (`/retrain`, `/events`, extended
`policy` / `jobs` / `preflight`) · `packages/node/test/teach.test.ts` (extended).
*Gate:* **audit every reader of `job.facts`** — at 1000 questions it is no longer something to embed in an API
response, a log line or an operator table. Grep and fix each site.

**PR-D6 — trainer.** `/mnt/newdata/qwen3.8/train/teach.py` — accept `facts_file` (stream the trained slice from
JSONL instead of embedding it in `job.json`); `eval_sample: {n, seed}` and `probe_kinds`; teacher-forced argmax for
the **in-loop** stop criterion above 32 questions, keeping real greedy generation for the final eval and the held-out
`alt_prompt` probes; `max_contrast = clamp(8, ceil(rows/2), 64)`; `micro = 16` below 32 questions, 64 above, reduced
when the longest rendering exceeds ~128 tokens; `eval_every = 2` below 32, then `ceil(rows/32)`.
*Why:* `probe()` calls `probe_one()` — one **unbatched** greedy 16-token `generate` per trained rendering — for every
target at every eval (`teach.py:184`, `:411`). That is 32 generations per eval at 8 facts and **4000** at 1000
questions. `train_all.py`'s `evaluate()` already solves it: teacher-forced argmax over all answer tokens, batched at
`micro=64`, documented as equivalent to greedy ("답 토큰 전부 argmax 일치 = greedy 생성 정답") and measured at ~12.5
sentences/s — roughly 60× faster. **The node must tolerate a trainer that ignores both new fields** (it already
ignores unknown `job.json` keys): detect by the absence of an `eval` event carrying `sampled`, and fall back to
full-probe accounting with `rowsPerJob` pinned at the floor.

**PR-D7 — web: i18n + upload + preview.**
`packages/web/src/i18n/pages/teach.ts` (all §5 keys — **re-grep for collisions first**) ·
`packages/web/src/pages/TeachPage.tsx` (entry choice) · `TeachUploadPage.tsx` · `TeachDatasetPage.tsx` ·
`packages/web/src/components/teach/{Stepper,DropZone,PasteTable,FormatHelp,DatasetTable,RowEditSheet,ReparseSheet}.tsx` ·
`packages/web/src/components/chat/teachUtil.ts` (`mapTeachError` + the client-side display-only pre-parse) ·
`packages/web/src/App.tsx` (**replace the `/teach → /chat?mine=1` redirect at line 58** with the new routes).

**PR-D8 — web: settings, progress, result, mine, basket.**
`TeachSettingsPage.tsx` · `TeachLessonPage.tsx` (progress **and** result) · `TeachMinePage.tsx` ·
`packages/web/src/components/teach/{EffortCards,StageRail,LiveTestBox,DatasetCard}.tsx` ·
`packages/web/src/components/chat/LessonBasket.tsx` (dataset restyle + freeze receipt) ·
`MyKnowledgePanel.tsx` (dataset-first) · `LessonCard.tsx` (`sampled`, `percent`) · `PublishSheet.tsx` (declaration).
*Gate:* `cd packages/web && npx tsc -p tsconfig.json --noEmit && npx vite build`.

**PR-D9 — CLI, docs, demo config.**
`packages/cli/src/*` (`teach dataset` verbs, `teach train --dataset`) · `packages/cli/test/cli.test.ts` ·
`docs/teach-mode-design.md` (a CHANGES section pointing here) · this file's CHANGES section ·
the dev-node config note for `$HOME/.ngram-teachable/node-u`.

**PR-D10 — UX scenarios and e2e.**
`docs/ux-test-scenarios.{md,json,html}` — a new block from **AZ-123** (the file ends at AZ-122 today, with no
dataset or upload coverage at all; without this block the owner's "100 scenarios all passing" goal is measured
against a spec that predates the file door) · `packages/e2e/tests/web-teach-dataset.spec.ts` ·
`packages/e2e/tests/web-teach.spec.ts` (basket-as-dataset assertions).

**Landing order if the work must be cut short:** D1 → D2 → D3 → D4 → D5 → D7 → D8 is the minimum honest product
(upload → preview → settings → progress → result, plus the basket rename). D6 is required before `rowsPerJob` may
rise above the floor. D10 is required before the owner's scenario goal can be claimed.

---

## 15. Test plan

### 15.1 Unit — `packages/core`
Config merge fills every new block from a v1 `config.json`; `rowsPerJob` derivation returns the floor with < 3
samples, clamps at the ceiling, and never exceeds `trainer.timeoutMs / (passes × s_per_row_p90) / 2`.

### 15.2 Unit — `packages/node/test/teach-dataset.test.ts` (new)
Table-driven over the PR-D2 fixtures. Assertions that matter most:
- canonical output is **byte-identical** for the same logical data arriving as jsonl / csv / tsv / txt → one sha256;
- `line` numbers survive quoted CSV newlines (a two-physical-line quoted field is **one** logical row);
- CP949 and UTF-16 decode correctly and record the encoding; a `U+FFFD`-heavy file is flagged;
- conflict excludes **all** copies and cross-links them; duplicate keeps the first;
- `answer_flattened` is a fix, not a rejection; over-length is a rejection with the exact overflow;
- bidi / zero-width characters are stripped from every field;
- `shared_ending` groups the KRX-shaped fixture and does **not** fire on a mixed fixture;
- a prompt-only txt file yields all-`empty` and `dataset_empty`, never invented answers;
- a 50 001-line file stops at the cap and says so;
- round-trip: parse → `rows.jsonl` → parse again → identical rows and sha256.

### 15.3 Integration — `packages/node/test/teach-datasets.test.ts` (new) and `teach.test.ts` (extended)
- upload → 201 with report; identical re-upload → **200**, same id, quota unchanged;
- `x-ngram-dataset-sha256` mismatch → 400 and the temp file is gone;
- banned key / disabled node → 403 **with nothing written under `<dataDir>/teach`**;
- `PATCH` while a job runs → 409 → `fork` → 201 with `parent_dataset`;
- `DELETE` while a job runs → 409; after → tombstone, files gone, the lesson still renders with `dataset.deleted`;
- job from `dataset_id` → `job.facts` equals the selected slice in order; legacy `{facts}` job materialises a
  `source: 'chat'` dataset;
- quota: `rows_per_key_per_day` exhausts before `jobs_per_key_per_day` at large sizes, and the 429 carries both
  remainders;
- deterministic sampling: the same `(sha256, revision)` selects the same questions across two runs, and a **retrain
  selects the same ones** (the anti-re-roll property);
- check call count ≤ `check.callBudget` for datasets of 8 / 100 / 1000 questions (counted with a stubbed runtime);
- `teach_stats`: a stub job does **not** raise `timing.samples` for the gradient p50 — the D7 regression test;
- v1 database file opens, v1 job renders, and its lazy materialisation on first download produces a valid dataset.

### 15.4 CLI — `packages/cli/test/cli.test.ts`
`teach dataset <file>` prints the report summary and the fingerprint; `teach dataset download` round-trips;
`teach train --dataset` creates a job whose `dataset_id` matches.

### 15.5 e2e — `packages/e2e/tests/web-teach-dataset.spec.ts`
On the dev node (`$HOME/.ngram-teachable/node-u`, port 3422, `backend: 'stub'`, `publish: 'auto'`) — **no GPU is ever
touched**:
upload a csv → preview shows the four count pills → fix a too-long answer inline → remove a row and undo →
run the model check → statuses gain the model's quoted answer → editing a cell clears that status → over-cap banner
and *Choose which 8* → settings → train → stage rail advances, `step/max` bar, hit counter, **no minutes shown** →
result → live test returns two answers → keep private → download the dataset → re-upload it → **200, same id**.
Plus: chat basket says *"Your dataset · 3 questions"*, *View all* opens the same table, the freeze receipt names the
filename, and the wizard runs inside the `Sheet` without leaving `/chat`.

### 15.6 UX scenarios — `docs/ux-test-scenarios.md`, AZ-123 onward
The block to write, in the existing entry format (Goal / Priority / Area / Automation / Preconditions / Steps /
Expected / Evidence). Coverage targets, roughly one scenario each: the two doors and their convergence; each of the
four formats plus paste; each encoding; each row status; reparse; the cap banner and manual selection; each new
error code; retention `delete_after_training`; dataset delete with a live lesson; fork-on-409; retrain determinism;
the sampled-check copy; the declaration threshold; the operator moderation view; the no-ETA rules on a stub node;
mobile 360 for all five steps; keyboard-only drop zone and table editing.

### 15.7 Measurements still owed (blocking, from v1 §8.4)
No duration may appear in the UI until these exist. None could be taken in this session — GPUs 4–6 are running the
owner's `train_rev.py`, and port 8000 refused connections during the design session (the hourly stall the design
already accounts for).

1. **One real GPU run of `teach.py`.** It has never happened — `docs/teach-mode-design.md:799` records that the
   training path was only exercised on CPU with a fake model. `load_s`, `avg_step_s`, steps-to-converge, rows and
   `.npz` bytes are all projections today.
2. **Three runs at different sizes (8 / 50 / 200 questions)** to fit `t = load_s + passes × sentences × s_per_sentence`
   *and* to find out whether passes-to-converge grows with the question count. `train_all` says it does — one fact
   converged in 10 steps; 2761 facts needed 1560 optimiser steps over 12 epochs and still finished at 99.6 % before a
   pinpoint pass — so a purely linear model may be optimistic.
3. **One measured CHECKING against a live vLLM:** median seconds for `/v1/completions` at 16 tokens and
   `/v1/chat/completions` at 48 tokens, and apply/remove at 3k / 30k / 300k rows.

Until (1)–(3) exist: show the question count and a coarse band, never a minute figure, and never derive a number from
a stub-backend run.

---

## 16. Trainer dependency summary

`teach.py` today: `job.json` `{facts, contrast, max_steps: 20, eval_every: 2, lr: 2e-3, micro: 16, max_contrast: 8}`,
stdout events `load / baseline / step / eval / done / error`, export `lesson.npz` + `recipe.json`.

v2 needs (PR-D6): `facts_file`, `eval_sample {n, seed}`, `probe_kinds`, scaled `max_contrast` / `micro` / `eval_every`,
and teacher-forced argmax for the in-loop stop criterion. **Until these land, `rowsPerJob` stays at the floor (8) on
the gradient backend** — an eval at 100 questions would otherwise take minutes per evaluation and a 1000-question job
would spend more time probing than training (4000 unbatched generations per eval × ten evals could exceed the entire
gradient cost by 5×, which would make every duration projection in §9 wrong by an order of magnitude).

The node must degrade gracefully against an unchanged trainer: unknown `job.json` keys are already ignored, so detect
support by the presence of `sampled` on the `eval` event and fall back.

---

## 17. Open questions for the owner

1. **Dataset cap.** 2000 questions per dataset, 10 new datasets per key per day, 20 kept, 7-day TTL — right shape?
2. **Should a big dataset offer "train it as {k} lessons in a row"** (a queue of jobs from one dataset), or stay
   one-lesson-at-a-time as designed here? This is the single largest scope decision left, and §11's fork flow is the
   manual version of it.
3. **Who owns GPUs 4–6 once `train_rev.py` finishes** — the teach worker or the demo "after" server? They cannot
   coexist (v1 §8.5), and measurement (1) in §15.7 is blocked on the answer.
4. **Korean strings** in §5 and §9 are the design's, unreviewed by a native speaker in this session. Tone follows the
   v1 dictionary (합니다체 throughout, no jargon). Please skim before they are frozen into e2e assertions.
5. **Publish default on stub nodes.** This design suggests `publish: 'never'` unless a node is explicitly a demo node,
   which would change the current teachable dev-node config (`publish: 'auto'`).

---

## CHANGES — PR-D1 (core + node: the dataset pipeline, 2026-09-01)

Implements §6, §7.1–§7.3, §8, §9 (limits), §10 (progress/ETA), §11 (re-train, retention, sweep) and §12 (gate ordering,
sampling, quotas) — the plan's PR-D1 through PR-D5 landed as one change because the store, the service, the API and the
worker cannot be split without leaving the tree red. No UI, no trainer change (PR-D6), no CLI verbs (PR-D9).

**Files.** `packages/core/src/{types,config}.ts` · `packages/core/test/config.test.ts` (new) ·
`packages/node/src/teach-dataset.ts` (new, pure parser) · `teach-datasets.ts` (new, service) · `teach-error.ts` (new) ·
`teach-samples.ts` (new) · `store.ts` · `market.ts` · `teach.ts` · `teach-recipe.ts` · `teach-auth.ts` · `api.ts` ·
`openapi.ts` · `index.ts` · `packages/node/test/{teach-dataset,teach-datasets}.test.ts` (new) · `teach.test.ts` (two
expectations updated, see D7 below).

### Deviations from the sections above

1. **`TeachRowStatus` gains `over_cap`, `TeachDatasetSummary` gains `over_cap`.** §8.5 lists eight statuses and §9 has
   visitor copy for a dataset over `dataset.maxRows` ("the first {max} were loaded"), but no status could carry it.
   Without a ninth status those questions would have been dropped in silence, which G3 forbids.

2. **`endingKey` drops the subject rather than always taking three tokens.** §8.5 says "last three whitespace tokens,
   falling back to the last 8 characters for scripts without spaces". Taken literally, `{name} 종목코드는?` is two
   tokens, so the key would be the whole question and the KRX group — the measurement this advisory exists to report —
   would never fire. The implementation takes the last `min(3, tokens − 1)` tokens (always dropping the first, which is
   the subject) and falls back to the last 8 characters only when there is no space at all.

3. **Sample datasets are embedded in `teach-samples.ts`, not `src/samples/*.jsonl`.** The node runs from `dist/` and the
   TypeScript build copies no assets; a sample that exists in the repo but not in production is worse than one that
   lives in the module that defines it. The bytes served are still canonical `rows.jsonl`, so a downloaded sample
   re-uploads to the same sha256.

4. **`GET /api/teach/datasets/:id/download` is owner-or-operator only.** §7.2 also lists a save-token; nothing issues a
   token for a dataset (save tokens are keyed on the `.npz` sha256), so accepting one would have meant inventing a
   second token kind with no caller. Left out until a caller exists.

5. **Bytes are charged on an idempotent re-upload; the dataset count is not.** §7.1 says a duplicate upload charges no
   quota and §12.5 says bytes are charged before parsing. They cannot both hold for the same request — the bytes really
   crossed the wire, and the byte quota is the denial-of-disk control. `ds:addr:` (datasets per day) and `keptPerKey`
   are unchanged by a duplicate, which is what the idempotency promise is about.

6. **The rows quota is charged at job creation, never at dataset creation.** §7.2 says a `PATCH … {rows_op}` charges
   "only newly added questions", but `rowsPerKeyPerDay` is documented everywhere else as *questions trained per day*
   ("questions left to teach on this node today"), and GPU-seconds are what it protects. Editing a dataset therefore
   costs nothing; training it costs `selected.length`.

7. **A dataset materialised from a legacy `{facts}` body skips the byte / dataset-count gate.** The chat door's own
   `POST /api/teach/datasets` is gated normally, but a v1 client that only knows `POST /api/teach/jobs {facts}` cannot
   see or react to `quota_dataset`, and G5 forbids a v1 regression. `jobsPerKeyPerDay` and the new `rowsPerKeyPerDay`
   still bound that path.

8. **The unique index is partial: `UNIQUE(owner, sha256, revision) WHERE deleted_at IS NULL`.** §6.5 has it
   unconditional, which would make a tombstone permanently block re-uploading the same file — the opposite of what
   "delete it and upload it again" promises.

9. **`teach-auth.ts` gains one optional argument** (`verify(req, purpose, bodyOverride)`), used only by the multipart
   upload route to sign `x-ngram-dataset-sha256` as the body (D14). §13 lists auth as untouched; this is additive and
   every existing call site behaves exactly as before.

10. **A lesson trained from an uploaded dataset takes the dataset's name; one frozen from a chat basket keeps the v1
    `Lesson: {first prompt}` naming.** A file name is meaningful, `your-dataset-2026-09-01` is not, and the draft id is
    derived from the lesson name.

11. **Two `teach.test.ts` expectations were updated, as §D7 predicted.** `policy.limits` and `policy.timing` are no
    longer exact-shape assertions (both blocks grew), and the `POST /api/teach/jobs` quota body now carries
    `rows_remaining` / `rows_ip_remaining`. No behaviour those tests covered changed.

### Called-out behaviour changes

- **`timing` is filtered to `backend = 'gradient'`.** A stub node now reports `timing.samples: 0`,
  `p50_s: null`, `position_eta_s: null` and `simulated: true`. Stub runs are still written to `teach_stats` (with
  `backend`, `rows_trained`, `sentences`), so a node switched from stub to gradient can tell the two eras apart.
- **`rowsPerJob` is derived, and stays at the floor** (8 gradient / 200 stub) until three gradient samples exist **and**
  the trainer has answered with a `sampled` eval event — PR-D6 is what unblocks it. An operator `rows_per_job` override
  disables the derivation and reports `rows_per_job_source: "operator"`.
- **CHECKING is now sampled and budgeted** (`check.callBudget` 68, locality never trimmed). At 8 questions the call
  sequence is identical to v1; above ~11 questions the taught check reports `sampled: {checked, of}` and no surface may
  make a whole-dataset claim.
- **The stub `.npz` now has one placeholder row per question** (it still copies the 픽셀플러스 fixture whole when a
  question mentions it), so `result.rows` describes the file that was written.
- **`checks.skipped`** is a new publish gate: turning the side-effect check off leaves the lesson usable and private but
  refuses `publish-challenge` with `checks_failed` until `POST /:id/recheck` measures it.

### Verified on the dev node (`$HOME/.ngram-teachable/node-u`, port 3422, `backend: 'stub'`, `publish: 'auto'`)

`curl` walkthrough: upload a 25-question CSV (`;`-free, header detected, `utf-8`, 3 questions flagged
`shared_ending`) → 201 with the per-question report → paginated `/rows` → `POST /api/teach/jobs {dataset_id}` → 202 with
`dataset` + `training` + `quota.rows_remaining` → stub training → READY → `/download` (round-trips: re-uploading the
downloaded bytes returns **200** and the same id) → `/save` → `lesson.npz` (3.85 MB) and `recipe.json` carrying
`lesson.dataset {sha256, rows, revision, source, trained_rows}` → `/retrain` (effort bumped to `thorough`, same dataset)
→ operator `/api/me/teach/datasets` moderation view → v2 policy knobs set and cleared.

**Dev-node note:** the shared vLLM on :8000 was unreachable during this session, so the node is configured with
`stubOffline: true` — checks are simulated and every surface says so (`checks.simulated`, `note`). Remove that flag when
:8000 is back if the dev node should exercise the real CHECKING path (it will then wait out the 15-minute grace whenever
the model server is down, which is the designed behaviour).

### Still owed (unchanged from §14)

PR-D6 (trainer `facts_file` / `eval_sample` / scaled `max_contrast`) — until it lands the node keeps `rowsPerJob` at the
floor and detects support by the absence of `sampled` on the `eval` event. PR-D7 / PR-D8 (web), PR-D9 (CLI verbs and the
`teach status` dataset line), PR-D10 (AZ-123 onward + e2e).

---

## CHANGES — PR-D2 (web: the Teachable-NLP-style UI, 2026-09-01)

Implements §5 in full (screens, copy, mobile, error mapping), the client half of §7 (dataset endpoints with polling),
§10 (what a duration may say) and §11's entry points. Plan items PR-D7 and PR-D8 landed as one change: the wizard's five
screens share a stepper, a status vocabulary and an error map, and splitting them would have left `/teach/upload` with
nowhere to go. No node, core, trainer or CLI change (PR-D6 / PR-D9 are still owed).

**Files.** New: `packages/web/src/pages/{TeachPage,TeachUploadPage,TeachDatasetPage,TeachSettingsPage,TeachLessonPage,TeachMinePage}.tsx` ·
`packages/web/src/components/teach/{Stepper,DropZone,PasteTable,FormatHelp,DatasetTable,RowEditSheet,ReparseSheet,EffortCards,StageRail,LiveTestBox,DatasetCard,util}.ts(x)` ·
`packages/web/src/lib/teachDataset.ts`. Changed: `api/{api,types}.ts` (dataset endpoints, multipart signing, the
extended policy/job/progress/checks shapes) · `i18n/pages/teach.ts` (+286 keys) · `App.tsx` (the `/teach` routes replace
the `/chat?mine=1` redirect) · `components/ui/Header.tsx` · `components/chat/{LessonBasket,LessonCard,PublishSheet,teachUtil}.tsx` ·
`packages/e2e/tests/web-teach.spec.ts` (basket copy).

### Deviations from §5

1. **One editor, not two.** §5.4 implies inline cell editing on desktop and §5.13 requires a full-width sheet on a
   phone. `RowEditSheet` is used at every width: one validation path, one place where "editing a question clears its
   model-side status" is enforced, and no 40 px table-cell inputs. The mobile requirement is met exactly; the desktop
   one is met by a modal instead of in-place cells.

2. **The result screen counts QUESTIONS from `job.facts`, never from `checks.taught`.** `checks.taught` counts model
   *probes* — the head of the sample is asked in two renderings (`check.chatFormRows`), so a 3-question lesson reports
   `taught: {hits: 6, total: 6}`. Rendering §5.7's "It learned {hits} of {total} questions" from that field said
   *"It learned all 6 questions"* about three questions, which is exactly the kind of claim §5.12 forbids. Question
   counts now come from `facts` (index-aligned with the dataset): learned = `hit === true`, missed = `hit === false`,
   and anything unmeasured is reported through `teach.res.checked_sample` rather than counted as learned. The same fix
   is applied to the My-datasets lesson line and to `LessonCard`'s sampled note.

3. **The side-effects sentence drops its second half when there is no context knowledge.** `teach.res.side_ok` ends
   with "knowledge you had loaded still answers its own questions: {p}/{q}", which reads as "0/0" for a lesson that
   loaded none. With `parent_regression.total === 0` the screen falls back to the v1 string
   `teach.card.check_locality` — the same rule `LessonCard` already applies.

4. **`teach.basket.title_one`** (new): "Your dataset · 1 question". The design's `{n} questions` renders "1 questions"
   in the basket headline, which is the most-seen string of the chat door.

5. **~30 keys the §5 tables did not have.** The screens need labels the copy tables skipped: `teach.rows.status.fixed`
   and `status.over_cap` (the ninth row status PR-D1 added), the reparse form's own field labels, table pagination,
   `teach.rows.add_save`, `teach.run.{log,log_empty,rows}`, `teach.res.title_partial`, `teach.set.{dataset,summary_short}`,
   `teach.up.{sample_use,sample_rows,key_made,key_backup}`, `teach.data.{other_lessons,upload_cta,open}`,
   `teach.basket.view_title` and `teach.pub.declaration`. All follow the §4 vocabulary; none of them names a limit.

6. **The teaching key is created silently on the first upload**, with a sentence saying so and a link to back it up
   (`teach.up.key_made`). A signature is required before the node will store any bytes, and an interstitial in front of
   "Choose a file" would be the opposite of the Teachable-NLP shape. The v1 `CreditSheet` still opens on the chat
   door's first *Train*, unchanged.

7. **The chat door still trains through the v1 `{facts}` body.** §3 draws the conversational door as POSTing
   `/api/teach/datasets` first; the client keeps the v1 pre-flight → `POST /api/teach/jobs {facts}` path (which the node
   materialises into a `source: 'chat'` dataset) and renders the freeze receipt from `job.dataset` — the file really
   exists, it is linked, and the v1 flow the e2e suite covers is untouched. `LessonBasket` shows the basket as a dataset
   draft *before* Teach is pressed (title, view, download, per-question remove) exactly as §5.9 asks; the `.jsonl` it
   downloads is written in the browser and is byte-identical to the node's canonical form.

8. **Pre-flight pagination.** §7.3 caps a call at `preflight.perCall` but does not say how the client walks a dataset.
   *Check what the model already knows* issues sequential calls at offsets 0/8/16 up to 24 questions, renders each
   batch as it lands, and stops at the first quota error with whatever it has — the sampled sentence then names what
   was actually checked.

9. **The counts pill is dataset-wide.** `teach.rows.counts` shows accepted / known / duplicate / needs-a-fix for the
   whole dataset (after a check, "will train" is the checked count); the per-lesson slice is the cap banner's and the
   settings screen's job. The two never disagree because they answer different questions.

10. **A revision change clears the selection as well as the model statuses.** Editing or removing a question renumbers
    `rows.jsonl`, so a *Choose which N* pick made against the old revision would train the wrong questions. Undo
    re-appends a removed question at the END of the file (the API has no insert-at); the toast promises it back, not
    its old position.

11. **The header's *Teach* now points at `/teach`** (the entry choice) instead of `/chat?teach=1`. The landing page's
    `landing-nav-teach` still points at the chat door — two e2e specs assert that href, and the landing CTA is
    deliberately the conversational one.

12. **`packages/e2e/tests/web-teach.spec.ts`** basket assertions were updated to the v2 copy (5 lines). The suite must
    be pointed at a node serving this branch's web build (`AINIZE_URL`); the rest of the e2e work is PR-D10.

13. **One more error mapping than §5.11 lists.** A missing job answers the v1 shape — `404 {"error":"lesson not
    found"}` with no machine code — so `mapTeachError` matches it explicitly (`teach.err.lesson_not_found`, new) rather
    than showing the visitor "Something went wrong with the lesson: lesson not found". An expired draft is a normal
    visitor state, not a fault.

### Verified in a real browser against the dev node (`$HOME/.ngram-teachable/node-u`, :3422, `backend: 'stub'`)

51 screenshots in `packages/e2e/results/teachable-*.png` (desktop 1280 and 360 px, English and Korean):
entry · upload · preview (raw, checked, picking, dropped lines, edit sheet, undo toast, reparse sheet) · settings ·
progress · result (learned table, side effects, live test, keep-private sheet, publish sheet, declaration gate) ·
retrain · my datasets · the chat basket (empty, filled, view-all sheet, freeze receipt, lesson card).

The walkthrough that produced them: a 25-question CSV with a duplicate, a contradiction, an over-long answer, a missing
answer and a four-question shared-ending group → every one of those statuses rendered with its own sentence and line
number → *Check what the model already knows* (20 of 20, each with the model's quoted answer) → over-cap banner and
*Choose which 8* → edit a question (its model status cleared) → remove and undo → settings (no minutes anywhere: this
node reports `timing.simulated`) → train → stage rail, `step/max_steps`, hit counter, elapsed → result → live test
returning two answers side by side → keep-private and publish sheets → *Train it again* creating a second job from the
same dataset → My datasets with an authenticated `.jsonl` download → the chat door: basket as "Your dataset · 2
questions", *View all*, a browser-written `your-dataset-2026-09-01.jsonl`, then Teach → the freeze receipt naming that
filename and linking to the dataset the node created. Error paths: a `.jsonl` with two unreadable lines (collapsed
"lines that were left out" list) and an answer-less `.txt` (`dataset_empty`, the visitor sentence, no invented answers).

`document.documentElement.scrollWidth === clientWidth` on all seven screens at 360 px in both locales (one real
overflow was found and fixed: the sample-dataset chips), and the drop zone is reachable and activatable from the
keyboard.

**Dev-node settings used and then reset:** `rows_per_job: 8` (to exercise the over-cap flow the gradient floor will
produce), `jobs_per_key_per_day: 20` / `jobs_per_ip_per_day: 50` (four full runs in one day) and
`declaration_rows: 10` (to see the publish declaration gate refuse and then allow). All are back to their designed
values (`rows_per_job` derived — 200 on stub, jobs 3/5, declaration 100). Fresh visitor buckets came from
`x-forwarded-for` (the node runs with `server.trustProxy: true`), never from touching the shared demo cluster.
