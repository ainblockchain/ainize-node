# Teach mode v2 — dataset UX and copy (Designer A)

**Status:** design, ready for implementation · **Date:** 2026-09-01 · **Branch:** `teachable-ui`
**Reads on top of:** `docs/teach-mode-design.md` (v1 — unchanged guarantees: signed teaching key, quotas, bans,
locality + parent-regression publish gates, payouts, review/auto publish, private drafts, RUN-LOCALLY.md).

**Owner direction (verbatim):**
> teachable-nlp ui 중심으로 ux 시나리오 100개 도출해 내고 모두 통과해. knowledge teach mode 로 활용해
> teach mode 는 대화형이랑 파일형 두개가 있는거야
> 그런데 대화형도 결국에는 데이터를 모두 적재한후에 Teach 모드를 누르면 파일로 되어서 파이프라인이 돈다는 측면에서 파일형의 전단계이긴하지

**Reference product:** Ainize Teachable NLP — *upload a text file → pick a model and epochs → press Train → watch
progress → the trained model is deployed for you*. Translated to knowledge: **dataset file → settings → Train →
progress → a lesson you can live-test, keep private with a local-run recipe, or publish and get paid as the data
provider.** No code, no GPU, no account.

---

## 1. The one-pipeline picture

```
        (A) conversation                     (B) file
   ask → wrong answer → correct         drag-drop / pick / paste
              │                                  │
              ▼   press "Teach from this         ▼
      corrections accumulate  dataset"    .jsonl .csv .tsv .txt
              └───────────► DATASET FILE ◄───────┘
                     (canonical .jsonl, sha256, N questions,
                      source: chat | upload | derived)
                                 │
    1 Dataset → 2 Check → 3 Settings → 4 Training → 5 Result
                                 │
                    ┌────────────┼────────────┐
                 Publish     Keep private   Train again
                 & get paid  + run locally  (same dataset)
```

Design rule that follows from the owner's third sentence: **the conversation is not a second pipeline, it is a
different way of filling the same file.** So the chat basket must *read as a file* long before the user presses
Teach ("Your dataset · 7 questions", view / download / remove / add more), and the moment Teach is pressed the UI
says out loud that a file was written and shows the same five steps an uploader sees.

## 2. Vocabulary (additions to design §3)

| UI word (en / ko) | code |
|---|---|
| dataset / 데이터셋 | `TeachDataset` — canonical `.jsonl`, one `{question, answer, another_way?}` per line |
| question / 질문 | one dataset item = one `TeachFactInput` |
| lesson / 수업 | one `TeachJob` + its `.npz` (unchanged) |
| effort / 정성 (얼마나 열심히) | `max_steps` / `eval_every` / `lr` preset |
| side-effect check / 부작용 확인 | locality + parent-regression checks |

**Banned in every UI string (v1 §3, still binding):** patch, **rows**, npz, anchor, LISTED, quorum, lock, GPU.
"rows" is reserved for memory entries elsewhere in this product (`teach.keep.dl_body` says "{rows} memory entries"),
so dataset items are counted as **questions / 질문 N개** and file positions are called **line N / N번째 줄**.
The only file extensions that may appear in copy are `.jsonl`, `.csv`, `.tsv`, `.txt` (dataset side; the knowledge
file keeps saying "knowledge file" as in v1).

## 3. Routes and IA

| route | screen | note |
|---|---|---|
| `/teach` | **entry choice** — two doors + link to my datasets | new; landing creator CTA and `nav.teach` point here |
| `/chat?teach=1` | conversation door (v1 chat, basket restyled as a dataset) | unchanged behaviour |
| `/teach/upload` | step 1 — upload / paste | new |
| `/teach/dataset/:dsId` | step 2 — preview + per-question check | new; also reached from chat freeze and from "Train again" |
| `/teach/dataset/:dsId/settings` | step 3 — training settings | new |
| `/teach/lesson/:jobId` | steps 4–5 — progress, then result | new full page; the v1 `LessonCard` stays as the in-chat mirror of the same job |
| `/teach/mine` | my datasets and lessons | full page; `MyKnowledgePanel` (`/chat?mine=1`) stays as the in-chat drawer and links here |

The wizard is one page component with a step header, so back/forward and deep links work; every step is
re-enterable from `/teach/mine`. Chat users never leave `/chat`: pressing Teach in chat keeps the wizard inside the
existing sheets (`Sheet` component) and only the lesson card is inline — same strings, smaller frame.

## 4. Screens

### 4.1 Entry choice — `/teach`

```
┌──────────────────────────────────────────────────────────────────┐
│ Teach the model something new                                    │
│ Two ways in, one result. …                                       │
│                                                                  │
│ ┌──────────────────────────┐  ┌──────────────────────────┐       │
│ │ 💬 Teach in a conversation│  │ 📄 Upload a dataset file │       │
│ │ Ask, and correct it when │  │ Already have questions   │       │
│ │ it is wrong. Corrections │  │ and answers in a file or │       │
│ │ collect into a dataset.  │  │ a spreadsheet?           │       │
│ │ [ Start a conversation ] │  │ [ Choose a file ]        │       │
│ │ Best when you have no    │  │ jsonl, csv, tsv, txt ·   │       │
│ │ file yet.                │  │ up to 500 questions      │       │
│ └──────────────────────────┘  └──────────────────────────┘       │
│                                                                  │
│ ① Dataset ② Check ③ Settings ④ Training ⑤ Result                 │
│ Whichever door you pick, these five steps are the same.          │
│ My datasets and lessons →                                        │
└──────────────────────────────────────────────────────────────────┘
```

Cards are `Card` with the `PRIMARY` top border used by `LessonBasket`; the two CTAs are `Button variant="contained"`
(file) and `variant="outlined"` (chat) — the file door is the primary because it is the Teachable-NLP shape the
owner asked to lead with, and the chat door is one click away everywhere else in the app. Below the cards a muted
strip repeats the five steps (this is the *same* stepper component used inside the wizard, in a static state) so a
first-time visitor knows the whole road before choosing. The node policy line from v1 (`policyLine()`:
open / about {p50} min / paused / off) sits under the strip and disables both CTAs when teaching is off.

### 4.2 Upload — `/teach/upload` (step 1)

- **Drop zone**, 100 % width, 160 px tall, dashed `LIGHT_GREY` border, `PALE_GREY` fill on drag-over. Contains the
  cloud icon, `teach.up.drop`, "or", and a `Button` that opens the native picker (`accept=".jsonl,.json,.csv,.tsv,.txt,text/*"`).
  Keyboard: the zone is a `<button>`-role element, Enter/Space opens the picker; drag-drop is never the only path.
- **Paste box** below, collapsed behind `teach.up.paste_title` (open by default on touch, where drag-drop is useless):
  a `Textarea` (6 rows, mono) + `teach.up.paste_use`. Accepts tab- or comma-separated pairs, or `Q:`/`A:` lines —
  the same parser as files. This is the "copied two columns out of Excel" path and it is the most common one.
- **File chip** after a successful read: `{name} · 12.4 KB · 34 questions found`, with **Replace file** and a
  quiet **Remove**. Parsing is client-side and instant; the upload to the node happens on "Check these questions".
- **Format help**, an always-visible (not hidden) accordion with four real examples — one per format, using the
  same three questions so the reader can see the formats are the same data:

  ````
  data.jsonl
  {"question": "Who founded Ainize?", "answer": "Comcom", "another_way": "Ainize was created by whom?"}
  {"question": "What ticker is Pixelplus?", "answer": "087600"}

  data.csv                          data.tsv (paste from a spreadsheet)
  question,answer,another_way       question⇥answer⇥another_way
  Who founded Ainize?,Comcom,       Who founded Ainize?⇥Comcom⇥
  "What ticker is Pixelplus?",087600 What ticker is Pixelplus?⇥087600

  data.txt
  Q: Who founded Ainize?
  A: Comcom

  Q: What ticker is Pixelplus?
  A: 087600
  ````

  Accepted column aliases (case-insensitive, so real files work without editing): `question | prompt | q | 질문`,
  `answer | completion | a | output | 정답 | 답`, `another_way | alt | alt_prompt | paraphrase | 다른표현`.
  A csv/tsv with no header row and exactly two columns is read as question,answer.
- **Sample dataset** link — `teach.up.sample` downloads `ainize-sample-dataset.jsonl` (5 questions, mixed
  another_way) from `GET /api/teach/sample-dataset`. Teachable NLP's users mostly started from its sample file;
  this is the single highest-value affordance on the screen.
- **Privacy line** (`teach.up.privacy`) directly above the primary button, not in a footer: this is the first moment
  a stranger's file lands on someone else's node, and v1 only warned at publish time.
- Primary: **Check these questions** → creates the dataset and goes to step 2. Disabled until ≥ 1 parsed question.

### 4.3 Preview and check — `/teach/dataset/:dsId` (step 2)

Header: `{n} questions from {source}` + the counts line (`{train} will train · {known} already known ·
{dupe} duplicates · {bad} need a fix`) as coloured pills (SUCCESS / GREY / GREY / ERROR).

Table (`Table.tsx`), columns: `#` · Question · Right answer · Another way to ask *(optional)* · Status · row menu.

- **Editable cells.** Click (or Enter on the focused cell) turns a cell into an `Input`; blur or Enter saves,
  Escape cancels. Edits are local until "Check", then re-checked. Any edit clears that question's model-side
  status back to "Not checked yet" — never show a stale green tick next to text the user just changed.
- **Row menu**: Remove (with an undo toast, `teach.rows.removed` + Undo, 8 s) · Duplicate · Move to another dataset
  is *not* in v1.
- **Add a question** button under the table appends an empty editable line.
- **Status column**, two families:
  - *file-side*, computed instantly, no server: `Will train` (default before checking is "Not checked yet"),
    `Same as #{n} — skipped` (exact dedupe on normalised question), and the red ones:
    `No answer`, `No question`, `Answer is {n} characters; keep it under 200`, `Question is … under 400`,
    `Line {line} could not be read as a question and an answer`, `Line {line} has only one column`.
  - *model-side*, after pressing **Check what the model already knows** (this is v1 `POST /api/teach/preflight`,
    costs one chat-quota unit): `Will train` (wrong today), `Already known — skipped`,
    `Too close to "{name}" on this node — skipped`. Each checked line also shows the model's current answer in a
    muted second line (`It answered: …`), which is what makes "already known" believable.
- **Lines the parser dropped** are never silently lost: a collapsed `details` under the table lists them with the
  file line number and reason, and they stay in the stored dataset marked invalid so a download round-trips.
- **Over the per-lesson cap** (`limits.facts_per_job`, 8 today): a `WARNING` banner —
  "This node teaches up to 8 questions in one lesson. The first 8 are selected; the rest stay in your dataset for
  the next lesson." — plus **Choose which 8**, which turns the `#` column into checkboxes. The dataset keeps all
  N questions; only the *job* is capped. This is the honest version of Teachable NLP's silent truncation.
- Footer: **Download this dataset (.jsonl)** (left, quiet) · **Back** · **Check what the model already knows** →
  after checking the primary becomes **Continue to settings**.
- Empty result: `teach.rows.none` ("the model already answers all of these correctly…") with the primary disabled.

### 4.4 Training settings — `/teach/dataset/:dsId/settings` (step 3)

Four controls, each one plain sentence, no unexplained ML term anywhere outside the collapsed developer block.

1. **Lesson name** — `TextField`, prefilled from the file name or the first question. "Only you see this until you publish."
2. **How hard should it try?** — three radio *cards* (not a slider, not a number box):
   | | body | time |
   |---|---|---|
   | Quick | A few passes over your questions. Good for one or two easy facts. | about {min} min on this node |
   | **Balanced (recommended)** | Keeps going until the model answers your questions, up to a sensible limit. | … |
   | Thorough | Tries longest. Use it for numbers, codes and facts that keep slipping. | … |
   Times come from `teach_stats` per preset and follow the §8.4 honesty rules (below). With fewer than three
   measured lessons the time slot reads "this node has not timed a lesson yet" — never a made-up number.
   Helper under the group: "More effort makes the answers stick better and takes longer. You can re-train with more
   effort if something does not stick." The word *epoch* never appears; `max_steps` appears only in (4).
3. **Check it does not break other answers** — toggle, **on** by default, and *locked on* with the note
   "Required if you want to publish this lesson." when publishing is possible on this node. Helper explains exactly
   what happens: a fixed set of unrelated questions plus the questions the loaded knowledge answers, asked before
   and after, differences shown on the result screen. (Turning it off is only useful for a private draft in a hurry.)
4. **Test with a different wording** — toggle, on when ≥ 1 question has `another_way`, disabled with
   `teach.set.alt_none` otherwise. Helper says the held-out wording is kept out of training on purpose.

Plus the v1 **builds on** checkbox when knowledge is loaded (moved here from the basket, where it was easy to miss),
and a collapsed **For developers** block that prints the exact numbers this effort maps to
(`up to {steps} training steps, checking every {eval} steps, learning rate {lr}`) — jargon is allowed there because
the disclosure itself is the consent to see it.

Sticky footer: summary line (`7 questions · Balanced · side-effect check on · about 4 min`) and
**Train this lesson (7 questions)**. First-time visitors get the v1 **Who gets the credit?** key sheet here, right
before the job is created, exactly as in v1 §5.6.

### 4.5 Progress — `/teach/lesson/:jobId` (step 4)

One centred panel, 640 px:

```
Teaching "KRX tickers"                                    [ Cancel ]
● Preparing ─ ● Warming up ─ ◐ Teaching ─ ○ Double-checking ─ ○ Done
████████████████████░░░░░░░░░░  step 8 of up to 12
5 of 7 questions answered correctly so far
Elapsed 03:12 · about 2 min left
Training runs on spare hardware; the model stays available for everyone.
You can close this tab. Find the lesson again under My datasets and lessons.
```

- The stage rail is the v1 state machine made visible: QUEUED → PREFLIGHT/LOADING → TRAINING → CHECKING → READY,
  with QUEUED shown as "Waiting for a free training slot — {n} lesson(s) ahead of you" (v1 `teach.card.queued`).
- **Per-question hit counter** updates from `progress.hits/total` on every `eval` event; it is the single most
  reassuring number on the screen and must not be hidden behind a details toggle.
- **Elapsed** is a client timer from `progress.started_at`, `mm:ss`, always shown (it is honest for free).
- **ETA rules (§8.4, unchanged and binding):** show a remaining time only when `policy.timing.samples ≥ 3` *and*
  the node sent `eta_s`; under 90 s say "Less than a minute left"; with no samples show `teach.run.eta_none`
  ("No time estimate yet … the first one may take up to 30 minutes"). With `backend: 'stub'` the "warming up"
  stage says "Starting…" and the timing tip is hidden (v1 stub-honesty rule), and the result carries the
  simulated-checks note.
- **Cancel** asks for confirmation and promises the dataset survives: "Your dataset is kept, so you can train it again."
- Runtime outage maps to the v1 friendly 503 line; the job is not failed and the rail keeps its place.

### 4.6 Result — `/teach/lesson/:jobId` (step 5)

Four blocks, in this order (what happened → prove it → keep it → what next):

1. **Headline** — "It learned 6 of 7 questions." (or "…all 7 questions."), tone SUCCESS / WARNING accordingly.
2. **What it learned** — the v1 fact table (Question · Before · After · ✓/✗ · Other wording ✓/✗), and directly
   under it **What it did not learn** listing the misses with the one useful next action:
   "Add another wording for them and train again — your dataset is saved."
3. **Side effects** — "Unrelated questions unchanged: 12/12 · knowledge you had loaded still answers its own
   questions: 10/10". If a gate failed: the red `teach.res.side_bad` sentence that says plainly it cannot be
   published but can still be kept and run. If the check was switched off: `teach.res.side_off` + **Run the check now**.
4. **Try it here** — a small live-test box (question input → Ask) that renders the two answers side by side
   ("With your lesson" / "Without it") through the normal `/api/chat` path with the draft id. This is the
   Teachable-NLP "your model is deployed, here is the demo page" moment; without it the result screen is a receipt
   rather than a product.
5. **What now?** — three cards: **Publish it and get paid** (v1 publish sheet) · **Keep it private** (v1
   keep-private sheet, unchanged, still leading with "keep it on this node for 7 days") · **Train it again**
   (returns to step 3 with the same dataset preselected and the effort bumped one level).

### 4.7 My datasets and lessons — `/teach/mine`

A list of **datasets**, each expandable to the lessons trained from it — because the dataset is now the durable
object and a lesson is one attempt at it.

```
Your dataset · KRX tickers            34 questions · Uploaded file · 1 Sep
  [ Train again ] [ Add questions ] [ Download (.jsonl) ] [ Delete ]
  Lessons from this dataset (2)
    KRX tickers            Ready · private   learned 6/7   [ Try ] [ Publish ] [ Keep private ]
    KRX tickers (2nd try)  On sale           learned 7/7   [ Open page ] [ Earnings ]
```

Dataset row: name · `{n} questions` · source chip (From a conversation / Uploaded file / Copied from a lesson) ·
created date · short fingerprint on hover. Lesson row reuses the v1 status vocabulary
(`teach.mine.status.*`) and earnings line. Footer note: "Datasets you have not trained are deleted after 7 days."
The existing in-chat `MyKnowledgePanel` keeps working and gains a "See all in My datasets and lessons →" link.

### 4.8 The chat basket, now a dataset

`LessonBasket` keeps its position and its `PRIMARY` top border, and changes to:

```
Your dataset · 3 questions              View all · Download
Every correction you make in chat is added here.
1. Who founded Ainize?      → Comcom            ×
2. What ticker is Pixelplus? → 087600           ×
3. …
Ask another question in the chat to add to it.
[ ✓ ] This builds on the knowledge I have loaded (…)
[      Teach from this dataset (3)      ]
Or upload a file instead →
```

- title `Your dataset · {n} questions` (the "{n} of 8" cap moves into the Check step, where the cap is actually
  enforced and can be acted on),
- **View all** opens the same preview table as step 2 in a `Sheet` (edit / remove / add), so the chat user meets
  the file *before* pressing Teach,
- **Download** writes the canonical `.jsonl` from localStorage without touching the node — the file is real even
  for someone who never trains,
- pressing **Teach from this dataset** freezes the basket: it POSTs the dataset (`source: 'chat'`), shows the
  one-line receipt "Your 3 corrections were saved as your-dataset-2026-09-01.jsonl. The same steps now run as for
  an uploaded file.", and continues into Check → Settings → Training in the existing sheets. The basket is not
  cleared until the job is created, and new corrections after that start a fresh dataset.

## 5. Mobile (360 px)

- Entry cards stack; each stays one tap tall (title, one sentence, button) — the second sentence hides under 400 px.
- Wizard header collapses to `Step 2 of 5 · Check` with a 5-segment progress bar; the segment labels are the
  `aria-label`s.
- Upload: the drop zone becomes a plain **Choose a file** button plus the paste box open by default; the format
  help becomes a `<details>` per format (closed), never four code blocks stacked.
- Preview table becomes stacked cards: question (bold, wraps), answer, another way, status pill, and a `⋯` menu.
  No horizontal scroll — the v1 rule that wide content scrolls in its own container applies only to the developer
  block. Editing opens a full-width sheet with the three fields rather than inline cells.
- Settings: radio cards full width, 44 px minimum touch target, sticky bottom bar with the Train button and the
  summary line above it.
- Progress: the stage rail becomes a single line ("Teaching · step 8 of 12") with the bar; hit counter and elapsed
  on one line each.
- Result: the fact table becomes per-question cards (Before / After stacked), the "Try it here" box is full width,
  the three next-step cards stack with Publish first.

## 6. Accessibility

- Every step change moves focus to the step `<h1>` and announces via `role="status"`.
- Progress numbers live in an `aria-live="polite"` region that updates at most every 5 s (the poll interval), never
  per animation frame.
- Status pills carry text, not colour alone; the red ones repeat the reason in the cell.
- Drag-drop always has a button equivalent; the paste box always has a label.
- Editable cells are real inputs with labels (`Question, line 4`), not `contenteditable`.

## 7. New i18n keys (`ainize-web/src/i18n/pages/teach.ts`)

All existing v1 keys stay. `{}` placeholders as in v1.

### 7.1 Entry choice

| key | en | ko |
|---|---|---|
| `teach.entry.title` | Teach the model something new | 모델에게 새로운 것을 가르치기 |
| `teach.entry.sub` | Two ways in, one result: your questions and answers become a dataset, the dataset is trained into knowledge, and the knowledge is yours to test, keep private or publish. | 들어가는 길은 둘, 결과는 하나입니다. 질문과 정답이 데이터셋이 되고, 데이터셋을 학습해 지식이 되며, 그 지식을 써보고 · 나만 쓰고 · 공개할 수 있습니다. |
| `teach.entry.no_account` | No account, no server of your own, no code. | 계정도, 내 서버도, 코드도 필요 없습니다. |
| `teach.entry.chat.title` | Teach it in a conversation | 대화하며 가르치기 |
| `teach.entry.chat.body` | Ask the model something and correct it when the answer is wrong. Your corrections collect into a dataset. Best when you do not have a file yet. | 모델에게 물어보고 답이 틀리면 바로잡습니다. 바로잡은 내용이 모여 데이터셋이 됩니다. 아직 파일이 없을 때 좋습니다. |
| `teach.entry.chat.cta` | Start a conversation | 대화 시작하기 |
| `teach.entry.file.title` | Upload a dataset file | 데이터셋 파일 올리기 |
| `teach.entry.file.body` | Already have the questions and answers in a file or a spreadsheet? Upload it and train straight away. | 질문과 정답이 이미 파일이나 표에 있나요? 올려서 바로 학습하세요. |
| `teach.entry.file.cta` | Choose a file | 파일 고르기 |
| `teach.entry.file.formats` | jsonl, csv, tsv or plain text · up to {max} questions | jsonl, csv, tsv, 일반 텍스트 · 질문 최대 {max}개 |
| `teach.entry.steps` | Whichever door you pick, these five steps are the same. | 어느 쪽으로 들어와도 이 다섯 단계는 같습니다. |
| `teach.entry.mine` | My datasets and lessons | 내 데이터셋과 수업 |

### 7.2 Stepper

| key | en | ko |
|---|---|---|
| `teach.step.data` | Dataset | 데이터셋 |
| `teach.step.check` | Check | 확인 |
| `teach.step.settings` | Settings | 설정 |
| `teach.step.train` | Training | 학습 |
| `teach.step.result` | Result | 결과 |
| `teach.step.of` | Step {n} of 5 · {label} | {n}/5단계 · {label} |
| `teach.step.back` | Back | 뒤로 |

### 7.3 Upload

| key | en | ko |
|---|---|---|
| `teach.up.title` | Upload your dataset | 데이터셋 올리기 |
| `teach.up.sub` | One question and one right answer per line. The model is taught the answers exactly as you write them. | 한 줄에 질문 하나, 정답 하나. 적어 준 그대로 모델이 배웁니다. |
| `teach.up.drop` | Drop a file here | 여기에 파일을 놓으세요 |
| `teach.up.or` | or | 또는 |
| `teach.up.browse` | Choose a file | 파일 고르기 |
| `teach.up.accept` | jsonl, csv, tsv or txt · up to {mb} MB | jsonl, csv, tsv, txt · 최대 {mb} MB |
| `teach.up.reading` | Reading your file… | 파일을 읽는 중… |
| `teach.up.file_chip` | {name} · {size} · {n} questions found | {name} · {size} · 질문 {n}개 찾음 |
| `teach.up.replace` | Replace file | 파일 바꾸기 |
| `teach.up.paste_title` | Paste a table instead | 표를 붙여넣기 |
| `teach.up.paste_hint` | Copy two columns from a spreadsheet and paste them here — the question in the first column, the right answer in the second. | 스프레드시트에서 두 열을 복사해 붙여넣으세요 — 첫 열은 질문, 둘째 열은 정답입니다. |
| `teach.up.paste_ph` | Who founded Ainize?    Comcom | Ainize를 만든 곳은?    Comcom |
| `teach.up.paste_use` | Use this text | 이 내용 사용하기 |
| `teach.up.help_title` | What the file should look like | 파일은 이렇게 생기면 됩니다 |
| `teach.up.help_jsonl` | One JSON object per line. "question" and "answer" are required, "another_way" is optional. | 한 줄에 JSON 객체 하나. "question"과 "answer"는 필수, "another_way"는 선택입니다. |
| `teach.up.help_csv` | The first line is the header. Column names: question, answer, another_way. Put quotes around a value that contains a comma. | 첫 줄은 머리글입니다. 열 이름은 question, answer, another_way. 값에 쉼표가 있으면 따옴표로 감싸세요. |
| `teach.up.help_tsv` | The same as csv but separated by tabs — this is what you get when you copy from a spreadsheet. | csv와 같지만 탭으로 나눕니다 — 스프레드시트에서 복사하면 이 형태입니다. |
| `teach.up.help_txt` | Two lines per question: "Q:" then "A:", with a blank line between questions. | 질문마다 두 줄: "Q:" 다음 "A:", 질문 사이에는 빈 줄을 둡니다. |
| `teach.up.help_columns` | Other column names work too: prompt / q / 질문 for the question, completion / output / a / 정답 for the answer. | 다른 열 이름도 됩니다: 질문은 prompt / q / 질문, 정답은 completion / output / a / 정답. |
| `teach.up.sample` | Download a sample dataset | 예시 데이터셋 내려받기 |
| `teach.up.sample_hint` | 5 questions in jsonl — open it, replace the text with yours, upload it back. | jsonl로 된 질문 5개 — 열어서 내용만 바꿔 다시 올리세요. |
| `teach.up.privacy` | Your file is stored on this node while it trains, and the node operator can see it. Do not upload personal data or anything you are not allowed to share. | 학습하는 동안 파일이 이 노드에 저장되고 노드 운영자가 볼 수 있습니다. 개인정보나 공유할 수 없는 내용은 올리지 마세요. |
| `teach.up.next` | Check these questions | 이 질문들 확인하기 |
| `teach.up.err_empty` | No question and answer pairs were found in that file. Check the format examples below. | 이 파일에서 질문·정답 쌍을 찾지 못했습니다. 아래 형식 예시를 확인하세요. |
| `teach.up.err_big` | That file is {size}, over the {mb} MB limit. Split it, or upload fewer questions. | 파일이 {size}로 {mb} MB 제한을 넘습니다. 파일을 나누거나 질문 수를 줄이세요. |
| `teach.up.err_type` | This node reads jsonl, csv, tsv and plain text. "{name}" is none of those. | 이 노드는 jsonl, csv, tsv, 일반 텍스트를 읽습니다. "{name}"은(는) 해당하지 않습니다. |
| `teach.up.err_read` | That file could not be read. Try saving it again as UTF-8 text. | 파일을 읽지 못했습니다. UTF-8 텍스트로 다시 저장해 보세요. |
| `teach.up.err_many` | That file has {n} questions; this node accepts up to {max} in one dataset. The first {max} were loaded. | 파일에 질문이 {n}개 있습니다. 이 노드는 한 데이터셋에 {max}개까지 받습니다. 앞의 {max}개만 불러왔습니다. |

### 7.4 Preview and check

| key | en | ko |
|---|---|---|
| `teach.rows.title` | Check your dataset | 데이터셋 확인 |
| `teach.rows.sub` | {n} questions from {source}. Fix anything marked in red, then see which ones the model already knows. | {source}에서 가져온 질문 {n}개입니다. 빨간 표시를 고친 뒤, 모델이 이미 아는 질문을 확인하세요. |
| `teach.rows.source_file` | {name} | {name} |
| `teach.rows.source_chat` | your conversation | 내 대화 |
| `teach.rows.source_paste` | pasted text | 붙여넣은 내용 |
| `teach.rows.counts` | {train} will train · {known} already known · {dupe} duplicates · {bad} need a fix | 학습 {train}개 · 이미 알고 있음 {known}개 · 중복 {dupe}개 · 고칠 것 {bad}개 |
| `teach.rows.h.n` | # | 번호 |
| `teach.rows.h.q` | Question | 질문 |
| `teach.rows.h.a` | Right answer | 정답 |
| `teach.rows.h.alt` | Another way to ask (optional) | 다른 표현 (선택) |
| `teach.rows.h.status` | Status | 상태 |
| `teach.rows.edit` | Edit | 고치기 |
| `teach.rows.save` | Save | 저장 |
| `teach.rows.cancel_edit` | Cancel | 취소 |
| `teach.rows.remove` | Remove | 빼기 |
| `teach.rows.removed` | Removed "{q}". | "{q}"을(를) 뺐습니다. |
| `teach.rows.undo` | Undo | 되돌리기 |
| `teach.rows.add` | Add a question | 질문 추가 |
| `teach.rows.edit_cell` | {field}, line {n} | {n}번째 줄 {field} |
| `teach.rows.status.unchecked` | Not checked yet | 아직 확인 안 함 |
| `teach.rows.status.new` | Will train | 학습합니다 |
| `teach.rows.status.known` | Already known — skipped | 이미 알고 있음 — 건너뜀 |
| `teach.rows.status.dupe` | Same as #{n} — skipped | {n}번과 같음 — 건너뜀 |
| `teach.rows.status.overlap` | Too close to "{name}" on this node — skipped | 이 노드의 "{name}"과 너무 비슷함 — 건너뜀 |
| `teach.rows.status.excluded` | Kept for the next lesson | 다음 수업으로 남김 |
| `teach.rows.model_said` | It answered: {answer} | 모델의 답: {answer} |
| `teach.rows.bad.no_answer` | No answer — type the right answer | 정답 없음 — 정답을 적어 주세요 |
| `teach.rows.bad.no_question` | No question — type the question | 질문 없음 — 질문을 적어 주세요 |
| `teach.rows.bad.answer_long` | The answer is {n} characters; keep it under {max}. Teach a long explanation as several short facts. | 정답이 {n}자입니다. {max}자 이내로 줄이고, 긴 설명은 짧은 사실 여러 개로 나눠 가르치세요. |
| `teach.rows.bad.question_long` | The question is {n} characters; keep it under {max}. | 질문이 {n}자입니다. {max}자 이내로 줄이세요. |
| `teach.rows.bad.parse` | Line {line} could not be read as a question and an answer. | {line}번째 줄을 질문과 정답으로 읽지 못했습니다. |
| `teach.rows.bad.columns` | Line {line} has only one column — a question and an answer are both needed. | {line}번째 줄에 열이 하나뿐입니다 — 질문과 정답이 모두 필요합니다. |
| `teach.rows.dropped` | {n} line(s) could not be read and were left out. | {n}줄을 읽지 못해 제외했습니다. |
| `teach.rows.dropped_show` | See the lines that were left out | 제외한 줄 보기 |
| `teach.rows.cap` | This node teaches up to {max} questions in one lesson. The first {max} are selected; the rest stay in your dataset for the next lesson. | 이 노드는 한 수업에 질문 {max}개까지 가르칩니다. 앞의 {max}개를 골랐고, 나머지는 다음 수업을 위해 데이터셋에 남습니다. |
| `teach.rows.cap_pick` | Choose which {max} | {max}개 직접 고르기 |
| `teach.rows.cap_selected` | {n} of {max} selected | {max}개 중 {n}개 선택 |
| `teach.rows.check` | Check what the model already knows | 모델이 이미 아는지 확인하기 |
| `teach.rows.checking` | Asking the model each question… | 질문을 하나씩 물어보는 중… |
| `teach.rows.checked` | Checked: {train} of {n} are wrong today and will train. | 확인 완료: {n}개 중 {train}개가 지금 틀려서 학습합니다. |
| `teach.rows.none` | The model already answers all of these correctly, so there is nothing to teach. Add a question it gets wrong. | 모델이 이미 모두 맞게 답해서 가르칠 것이 없습니다. 모델이 틀리는 질문을 추가하세요. |
| `teach.rows.download` | Download this dataset (.jsonl) | 이 데이터셋 내려받기 (.jsonl) |
| `teach.rows.saved_note` | Saved as {filename} — you can train from it again any time. | {filename}(으)로 저장했습니다 — 언제든 다시 학습할 수 있습니다. |
| `teach.rows.next` | Continue to settings | 설정으로 이동 |

### 7.5 Training settings

| key | en | ko |
|---|---|---|
| `teach.set.title` | Training settings | 학습 설정 |
| `teach.set.sub` | The defaults work for most datasets. Everything here can be changed and run again. | 대부분은 기본값으로 충분합니다. 여기 있는 값은 모두 바꿔 다시 돌릴 수 있습니다. |
| `teach.set.name` | Lesson name | 수업 이름 |
| `teach.set.name_hint` | Only you see this until you publish. | 공개하기 전까지는 나만 봅니다. |
| `teach.set.effort` | How hard should it try? | 얼마나 열심히 가르칠까요? |
| `teach.set.effort_hint` | More effort makes the answers stick better and takes longer. If something does not stick, train the same dataset again with more effort. | 열심히 할수록 더 잘 외우고 시간이 더 걸립니다. 잘 안 외워지면 같은 데이터셋을 더 열심히로 다시 학습하세요. |
| `teach.set.effort_quick` | Quick | 빠르게 |
| `teach.set.effort_quick_body` | A few passes over your questions. Good for one or two easy facts. | 질문을 몇 번만 반복합니다. 쉬운 사실 한두 개에 좋습니다. |
| `teach.set.effort_balanced` | Balanced (recommended) | 보통 (권장) |
| `teach.set.effort_balanced_body` | Keeps going until the model answers your questions, up to a sensible limit. | 모델이 질문에 답할 때까지, 적당한 한도 안에서 계속합니다. |
| `teach.set.effort_thorough` | Thorough | 꼼꼼하게 |
| `teach.set.effort_thorough_body` | Tries the longest. Use it for numbers, codes and facts that keep slipping. | 가장 오래 시도합니다. 숫자나 코드처럼 자꾸 안 외워지는 사실에 쓰세요. |
| `teach.set.effort_time` | about {min} min on this node | 이 노드에서 약 {min}분 |
| `teach.set.effort_time_range` | {p50}–{p90} min on this node recently | 최근 이 노드에서 {p50}–{p90}분 |
| `teach.set.effort_time_unknown` | this node has not timed a lesson yet | 이 노드는 아직 수업 시간을 측정하지 못했습니다 |
| `teach.set.side` | Check it does not break other answers | 다른 답을 망가뜨리지 않는지 확인하기 |
| `teach.set.side_hint` | Before and after training, the model is asked a fixed set of unrelated questions, plus the questions the knowledge you loaded answers. Anything that changed is shown on the result screen. | 학습 전후로 무관한 질문 묶음과, 넣어 둔 지식이 답하는 질문을 물어봅니다. 달라진 것이 있으면 결과 화면에 보여 줍니다. |
| `teach.set.side_required` | Required if you want to publish this lesson. | 이 수업을 공개하려면 반드시 켜야 합니다. |
| `teach.set.alt` | Test with a different wording | 다른 표현으로도 시험하기 |
| `teach.set.alt_hint` | The "Another way to ask" column is kept out of training and used only to check the model learned the fact, not the sentence. {n} of your questions have one. | "다른 표현" 열은 학습에서 빼고, 문장이 아니라 사실을 배웠는지 확인하는 데만 씁니다. 질문 {n}개에 들어 있습니다. |
| `teach.set.alt_none` | None of your questions have another wording yet. Add one on the previous step to switch this on. | 아직 다른 표현이 있는 질문이 없습니다. 이전 단계에서 추가하면 켤 수 있습니다. |
| `teach.set.advanced` | For developers | 개발자용 |
| `teach.set.advanced_body` | "{effort}" means up to {steps} training steps, a check every {eval} steps and learning rate {lr}. These are the values sent to the trainer. | "{effort}"는 학습 단계 최대 {steps}회, {eval}단계마다 확인, 학습률 {lr}을 뜻합니다. 학습기에 그대로 전달되는 값입니다. |
| `teach.set.summary` | {n} questions · {effort} · {checks} · about {time} | 질문 {n}개 · {effort} · {checks} · 약 {time} |
| `teach.set.summary_checks_on` | side-effect check on | 부작용 확인 켬 |
| `teach.set.summary_checks_off` | side-effect check off | 부작용 확인 끔 |
| `teach.set.train` | Train this lesson ({n} questions) | 이 수업 학습하기 (질문 {n}개) |
| `teach.set.sending` | Sending… | 보내는 중… |
| `teach.set.queue_note` | Your place in the queue is kept even if you close this tab. | 탭을 닫아도 대기 순서는 유지됩니다. |

### 7.6 Progress

| key | en | ko |
|---|---|---|
| `teach.run.title` | Teaching "{name}" | "{name}" 가르치는 중 |
| `teach.run.stage.queued` | Waiting for a free training slot | 학습 차례를 기다리는 중 |
| `teach.run.stage.prep` | Preparing your dataset | 데이터셋 준비 중 |
| `teach.run.stage.warm` | Warming up the model | 모델 준비 중 |
| `teach.run.stage.start` | Starting… | 시작하는 중… |
| `teach.run.stage.train` | Teaching | 가르치는 중 |
| `teach.run.stage.check` | Double-checking in the live model | 실제 모델에서 다시 확인 중 |
| `teach.run.stage.done` | Done | 완료 |
| `teach.run.step` | Step {step} of up to {max} | {step}/{max}단계 |
| `teach.run.hits` | {hits} of {total} questions answered correctly so far | 지금까지 질문 {total}개 중 {hits}개 정답 |
| `teach.run.elapsed` | Elapsed {time} | 경과 {time} |
| `teach.run.eta` | about {min} min left | 약 {min}분 남음 |
| `teach.run.eta_soon` | less than a minute left | 1분 이내 남음 |
| `teach.run.eta_none` | No time estimate yet — this node has not finished enough lessons to know. The first one may take up to 30 minutes. | 아직 예상 시간이 없습니다 — 이 노드가 충분한 수업을 마치지 않았습니다. 첫 수업은 최대 30분 걸릴 수 있습니다. |
| `teach.run.leave` | You can close this tab. Find the lesson again under My datasets and lessons. | 이 탭을 닫아도 됩니다. 내 데이터셋과 수업에서 다시 찾을 수 있습니다. |
| `teach.run.leave_chat` | You can keep chatting while it trains. | 학습하는 동안 계속 대화해도 됩니다. |
| `teach.run.cancel` | Cancel training | 학습 취소 |
| `teach.run.cancel_confirm` | Stop teaching this lesson? Your dataset is kept, so you can train it again. | 이 수업을 중단할까요? 데이터셋은 남아 있어 다시 학습할 수 있습니다. |
| `teach.run.cancel_yes` | Stop it | 중단하기 |
| `teach.run.cancel_no` | Keep training | 계속 학습하기 |

### 7.7 Result

| key | en | ko |
|---|---|---|
| `teach.res.title` | Your lesson is ready | 수업이 준비됐습니다 |
| `teach.res.learned` | It learned {hits} of {total} questions. | 질문 {total}개 중 {hits}개를 배웠습니다. |
| `teach.res.learned_all` | It learned all {total} questions. | 질문 {total}개를 모두 배웠습니다. |
| `teach.res.partial_hint` | The ones it missed are listed below. Add another wording for them and train again — your dataset is saved. | 못 배운 질문은 아래에 있습니다. 다른 표현을 넣어 다시 학습해 보세요 — 데이터셋은 저장돼 있습니다. |
| `teach.res.h.q` | Question | 질문 |
| `teach.res.h.before` | Before | 학습 전 |
| `teach.res.h.after` | After | 학습 후 |
| `teach.res.h.other` | Other wording | 다른 표현 |
| `teach.res.learned_title` | What it learned | 배운 것 |
| `teach.res.not_learned` | What it did not learn | 배우지 못한 것 |
| `teach.res.side_title` | Side effects | 부작용 확인 |
| `teach.res.side_ok` | Unrelated questions unchanged: {m}/{n} · knowledge you had loaded still answers its own questions: {p}/{q} | 무관한 질문 변화 없음: {m}/{n} · 넣어 둔 지식이 자기 질문에 여전히 답함: {p}/{q} |
| `teach.res.side_bad` | This lesson changed the answers to {n} unrelated questions, so it cannot be published. You can still keep it and run it yourself. | 이 수업이 무관한 질문 {n}개의 답을 바꿔서 공개할 수 없습니다. 나만 쓰거나 직접 돌리는 것은 가능합니다. |
| `teach.res.side_off` | You switched the side-effect check off, so this lesson has not been measured and cannot be published yet. | 부작용 확인을 꺼서 아직 측정되지 않았고, 지금은 공개할 수 없습니다. |
| `teach.res.side_run` | Run the check now | 지금 확인 실행하기 |
| `teach.res.try_title` | Try it here | 여기서 써보기 |
| `teach.res.try_hint` | Ask anything. You get the answer with your lesson loaded and without it, side by side. | 무엇이든 물어보세요. 수업을 넣었을 때와 넣지 않았을 때의 답을 나란히 보여 줍니다. |
| `teach.res.try_ph` | Ask a question… | 질문을 입력하세요… |
| `teach.res.try_go` | Ask | 물어보기 |
| `teach.res.try_with` | With your lesson | 수업 넣음 |
| `teach.res.try_without` | Without it | 넣지 않음 |
| `teach.res.next` | What now? | 이제 무엇을 할까요? |
| `teach.res.publish_title` | Publish it and get paid | 공개하고 정산받기 |
| `teach.res.publish_body` | It goes on the marketplace through this node, credited to you, and you receive {share}% of every sale. | 이 노드를 통해 마켓에 올라가고 내 이름으로 남으며, 판매마다 {share}%를 받습니다. |
| `teach.res.keep_title` | Keep it private | 나만 쓰기 |
| `teach.res.keep_body` | Nothing is published. Keep it on this node, download the knowledge file, or get the commands to run it on your own machine. | 아무것도 공개되지 않습니다. 이 노드에 두거나, 지식 파일을 내려받거나, 내 컴퓨터에서 돌리는 명령어를 받으세요. |
| `teach.res.again_title` | Train it again | 다시 학습하기 |
| `teach.res.again_body` | The same dataset, with more effort or a few more questions. | 같은 데이터셋으로, 더 열심히 또는 질문을 몇 개 더 넣어서. |
| `teach.res.again_cta` | Change settings and re-train | 설정 바꿔 다시 학습 |
| `teach.res.dataset_link` | This lesson came from {name} ({n} questions) | 이 수업은 {name}(질문 {n}개)에서 나왔습니다 |

### 7.8 My datasets and lessons

| key | en | ko |
|---|---|---|
| `teach.data.title` | My datasets and lessons | 내 데이터셋과 수업 |
| `teach.data.sub` | Everything you have taught from this browser. The dataset is the file; a lesson is what the model learned from it. | 이 브라우저에서 가르친 모든 것입니다. 데이터셋은 파일이고, 수업은 모델이 그것으로 배운 결과입니다. |
| `teach.data.empty` | Nothing here yet. Teach in a conversation, or upload a dataset file to start. | 아직 아무것도 없습니다. 대화로 가르치거나 데이터셋 파일을 올려 시작하세요. |
| `teach.data.h.name` | Dataset | 데이터셋 |
| `teach.data.h.count` | Questions | 질문 수 |
| `teach.data.h.source` | Where it came from | 출처 |
| `teach.data.h.created` | Created | 만든 날 |
| `teach.data.count` | {n} questions | 질문 {n}개 |
| `teach.data.source.chat` | From a conversation | 대화에서 |
| `teach.data.source.upload` | Uploaded file | 올린 파일 |
| `teach.data.source.derived` | Copied from a lesson | 수업에서 복사 |
| `teach.data.retrain` | Train again | 다시 학습 |
| `teach.data.continue` | Add questions | 질문 추가 |
| `teach.data.download` | Download (.jsonl) | 내려받기 (.jsonl) |
| `teach.data.delete` | Delete dataset | 데이터셋 삭제 |
| `teach.data.delete_confirm` | Delete "{name}"? Lessons already trained from it are kept. | "{name}"을(를) 삭제할까요? 이미 학습한 수업은 그대로 남습니다. |
| `teach.data.deleted` | Dataset deleted. | 데이터셋을 삭제했습니다. |
| `teach.data.lessons` | Lessons from this dataset ({n}) | 이 데이터셋의 수업 ({n}개) |
| `teach.data.no_lessons` | Not trained yet. | 아직 학습하지 않았습니다. |
| `teach.data.learned` | learned {hits}/{total} | {total}개 중 {hits}개 배움 |
| `teach.data.expires` | Datasets you have not trained are deleted after {days} days. | 학습하지 않은 데이터셋은 {days}일 뒤 삭제됩니다. |
| `teach.data.fingerprint` | Fingerprint {short} | 지문 {short} |

### 7.9 Chat basket as a dataset (new keys; v1 keys stay for the collapsed state)

| key | en | ko |
|---|---|---|
| `teach.basket.title_ds` | Your dataset · {n} questions | 내 데이터셋 · 질문 {n}개 |
| `teach.basket.sub_ds` | Every correction you make in the chat is added here. | 대화에서 바로잡은 내용이 모두 여기에 쌓입니다. |
| `teach.basket.empty_ds` | Your dataset is empty. When an answer is wrong, click "Teach the right answer" under it. | 데이터셋이 비어 있습니다. 답이 틀리면 그 아래 "정답 가르치기"를 누르세요. |
| `teach.basket.view` | View all | 전체 보기 |
| `teach.basket.download` | Download (.jsonl) | 내려받기 (.jsonl) |
| `teach.basket.add_more` | Ask another question in the chat to add to it. | 대화에서 질문을 더 하면 여기에 추가됩니다. |
| `teach.basket.train_ds` | Teach from this dataset ({n}) | 이 데이터셋으로 가르치기 ({n}개) |
| `teach.basket.freeze_note` | Your {n} corrections were saved as {filename}. From here the steps are the same as for an uploaded file. | 바로잡은 {n}개를 {filename}(으)로 저장했습니다. 여기서부터는 올린 파일과 똑같은 과정입니다. |
| `teach.basket.upload_link` | Or upload a file instead | 또는 파일로 올리기 |

### 7.10 New errors (`mapTeachError`)

| server prefix | HTTP | en | ko |
|---|---|---|---|
| `dataset_too_large` | 413 | That dataset is bigger than this node accepts ({mb} MB). Split it into smaller files. | 이 노드가 받는 크기({mb} MB)보다 큽니다. 파일을 나눠 주세요. |
| `dataset_empty` | 400 | That dataset has no usable questions. Every line needs a question and a right answer. | 쓸 수 있는 질문이 없습니다. 모든 줄에 질문과 정답이 있어야 합니다. |
| `dataset_not_found` | 404 | That dataset is no longer on this node. Upload it again — you can also download it from My datasets. | 이 노드에 더 이상 없는 데이터셋입니다. 다시 올려 주세요 — 내 데이터셋에서 내려받을 수도 있습니다. |
| `dataset_format` | 400 | This node could not read that file as a dataset. See the format examples. | 이 파일을 데이터셋으로 읽지 못했습니다. 형식 예시를 확인하세요. |
| `dataset_quota` | 429 | You have reached the number of datasets this node keeps for one teaching key. Delete one first. | 이 노드가 가르치기 키 하나에 보관하는 데이터셋 수를 넘었습니다. 하나를 먼저 삭제하세요. |

## 8. What the UI must never say

- No number of minutes that is not measured (`timing.samples ≥ 3`), no "almost done", no fake percentage bar
  — the bar is `step / max_steps`, which is a real fraction, and it stops at the last real step.
- No "epochs", "loss", "learning rate", "gradient", "LoRA", "fine-tune", "GPU" outside the **For developers** block.
- No "deployed" / "your model is live" on the result screen (Teachable NLP could say it; here the lesson is a file
  the visitor still chooses what to do with). Say "ready", "try it here", "publish".
- No claim that a private draft is hidden from the node operator (v1 rule, repeated on the upload screen).
- No silent truncation, silent dedupe or silent drop: every removed line is counted and inspectable.

## 9. Open questions for the owner

1. Dataset cap: `factsPerJob` is 8 per **lesson**; what is the cap per **dataset** (proposed 500) and per key
   (proposed 10 datasets)?
2. Should a dataset over 8 questions offer **"train it as {k} lessons in a row"** (a queue of jobs) in v2, or stay
   one-lesson-at-a-time as designed here?
3. Effort presets need one measured run each before their times can be shown (v1 §8.4 first engineering action).
