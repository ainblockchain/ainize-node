---
title: Teach from a file of questions
summary: A file of questions and answers becomes knowledge the model has: validate it line by line, train it, and read the checks that decide whether it may be published.
---

# Teach from a file of questions

You have a list of things your model gets wrong — a spreadsheet of product codes, an export from a support tool, a
handbook nobody has read. This tutorial takes one such file and walks it all the way to a **lesson**: a knowledge file
the node trained from your questions, measured in the live model, and ready to keep private or to sell.

It is the file door of teach mode. There is another door — correcting answers one at a time in the browser — and it is
a different experience with the same pipeline behind it; that one is
[Teach by correcting the model](./teach-in-chat.md).

By the end you will have uploaded a dataset, read the node's line-by-line verdict on it, fixed the lines it refused,
trained a lesson from the rest, and understood the one number that decides whether the lesson can be published at all.

## Before you start

**A node you can restart.** Everything here runs against one node, and the first step changes a setting the node only
reads at start-up. If you do not have one yet, [Installation](../get-started/install.md) sets one up.

**A model behind that node.** Teaching is not a text transformation: the node asks your questions to the live model
before training (to skip the ones it already answers), trains on the rest, then asks them again to see what changed and
what else moved. A node whose model server is off can accept and validate a file — everything up to
[step 5](#5-upload-it-and-read-what-the-node-would-not-train) works — but it cannot train. The node says so in one
line, and [step 2](#2-read-the-nodes-teaching-policy) is where you read it.

**A file with one question and one answer per row.** Five formats are accepted: `.jsonl`, `.json`, `.csv`, `.tsv` and
`.txt`. Anything you can export from a spreadsheet is fine.

> [!NOTE]
> Teaching is not free of consequence for the node operator: lessons occupy the training GPUs and the questions are
> stored on their machine while a lesson trains. That is why the limits in step 2 exist, and why a public node may run
> `teach.publish: review` and read every lesson before it goes anywhere.

## 1. Turn teach mode on

Teach mode is **off by default**. A node that has never been told otherwise accepts no lessons at all:

```bash
ainize teach status
```

```text
Teaching on my-node  not accepting lessons  http://localhost:3618
```

Turn it on with one config key:

```bash
ainize config set teach.enabled true
```

```text
✓ teach.enabled = true  (the node reads config.json when it starts)
! the node in /tmp/ainize-tut/my-node is running (pid 675585) and keeps using the value it started with — restart it to apply this (`ainize stop` then `ainize start -d`)
```

The second line is the part people miss. `config set` writes `config.json`; the running process keeps every value it
started with. Do as it says:

```bash
ainize stop && ainize start -d
```

```text
✓ stopped node (pid 675585)
✓ node started in the background (pid 675775) — port 3618
  logs: /tmp/ainize-tut/my-node/node.log   stop: ainize stop
```

If you run the node, there is a second way in that needs no restart: sign in on the node's own site and open
**My knowledge → Teaching**. The same settings live there, and saving them applies immediately.

## 2. Read the node's teaching policy

`ainize teach status` with no argument prints the policy of the node you are pointed at. Read it before you spend time
on a file, because four of these lines can stop you:

```bash
ainize teach status
```

```text
Teaching on my-node  accepting lessons  http://localhost:3618
trainer               paused — runtime repo is not configured on this node · backend gradient
publish               review — the operator approves each lesson first
queue                 0 / 10 lessons · 0 / 2000 questions waiting
typical lesson        no measurement yet (0 of 3 lessons measured)
limits                8 questions per lesson (default) · 3 lessons per key and 5 per IP a day · prompt ≤ 400 / answer ≤ 200 chars
datasets              up to 2,000 questions per file · files ≤ 3.8 MB · jsonl json csv tsv txt · 10 uploads and 300 trained questions per key a day · kept 7 days
effort                quick (8 passes) · balanced (20 passes) · thorough (40 passes)
data-provider share   70 % of the node's share of each sale (lineage pool 30 %)
model                 model server off
always loaded         nothing pinned
unsaved lessons kept  7 days

teach from a file:  ainize teach dataset ./questions.csv --train      (or http://localhost:3618/teach/upload)
teach in chat:      http://localhost:3618/chat?teach=1
```

**`trainer`** is the go/no-go line. `ready` means a lesson queued now will start training; `busy` means the training
GPUs are taken and your lesson waits; `paused` means it will not start at all, and the rest of the line says why. The
node above is the honest case of a machine with no model attached — it will validate your file and refuse to train it.

**`publish`** is what happens to a lesson you decide to publish. `review` holds it for the operator; `auto` announces
it to the network immediately; `never` means this node trains lessons but publishes nothing, and you keep the file
instead. It does not affect training, only the last step.

**`limits`** and **`datasets`** are two different budgets, and both are per teaching key and per day. The first governs
lessons (how many questions one lesson may train, how many lessons a key and an IP get a day, how long a question and
an answer may be); the second governs files (how big, how many rows, how many uploads, how long the questions are
kept). Nothing here is a global constant — every number is this node's, and another node will print different ones.

**`effort`** is the three settings you can pick from when you train, printed with what each one actually does: a
number of passes over your questions. There is no other knob.

## 3. Write the file

The parser is looking for two things per row: a question and its answer. It finds them by column name, and it accepts
the names people actually use — `prompt`, `question`, `q`, `input`, `instruction`, `query`, `질문`, `문제`, `입력` for
the question, and `answer`, `a`, `output`, `response`, `completion`, `target`, `답`, `답변`, `정답`, `출력` for the
answer. Two optional columns are read the same way: `alt_prompt` (`paraphrase`, `다른질문` — another wording of the
same question, used to check the model learned the fact rather than the sentence) and `note` (`memo`, `source`, `비고`).

Here is the file this tutorial uses. It is deliberately imperfect, because the interesting half of this step is what
the node does with the bad rows:

```csv
question,answer
Which meeting room has the video wall?,"Sonora, on the 4th floor"
Who approves an expense over 500 USD?,"Your team lead first, then Finance"
What is the guest wifi network called?,AsterGuest
How long is the laptop refresh cycle?,Three years
Which meeting room has the video wall?,"Kepler, on the 2nd floor"
Who approves an expense over 500 USD?,"Your team lead first, then Finance"
When does the office open?,
"Which of the meeting rooms on the fourth floor of the Seoul office is the one with the video wall along the north side, the room we normally book for customer demos and for the Monday all-hands when the other offices dial in as well, and what is that room called on the booking system everybody has had to use since the move last spring, and who do I ask about it when the room is already taken by another team?",Sonora
Where do I file a hardware fault?,"On the IT desk board in the wiki, under Hardware"
```

When the file does not look like that — the columns are called something else, the separator is a semicolon, the first
row is already data, the text is CP949 out of an old spreadsheet — you say so instead of rewriting the file:

| Flag | What it is for |
|---|---|
| `--columns '{"prompt":"질문","answer":"답"}'` | Name the columns explicitly. Values are header names or 0-based indexes. |
| `--delimiter ';'` | The separator, when sniffing gets it wrong. |
| `--no-header` | The first row is a question, not a header. |
| `--encoding euc-kr` | Force a text encoding when the preview looks like mojibake. |
| `--format csv` | Override what the file extension implies. |

Encoding is worth one extra sentence: the node detects it (BOM, then UTF-8, then CP949/EUC-KR, then latin1) and prints
what it decided. A short CP949 file can decode as valid UTF-8 and produce plausible-looking nonsense that passes every
other check, so if the questions come back looking wrong in the report, `--encoding` is the fix.

## 4. Know what your teaching key is before you make one

Every teach request is signed. There is no account and no login: a **teaching key** is the identity, and whoever holds
it owns the lessons and any earnings they make. The CLI creates one the first time you need it and tells you where it
put it:

```text
! new teaching key 0x99a0A17380cBEA9F495920687f9Ee05066e3835e — kept in /tmp/ainize-tut/my-node/teaching-key.json. Back it up: it is the only way back to these lessons and their earnings.
```

> [!WARNING]
> That file is the only copy. Lose it and the lessons signed with it stay on the node, permanently unreachable — no
> operator, no support address and no node can give them back, because nothing anywhere knows they were yours.
> Copy `<home>/teaching-key.json` somewhere safe now, before the next command creates it.

To use a key you already have — the backup the browser downloaded, or one from another machine — pass
`--key-file ainize-teaching-key-….json`, or `--key <64-hex>`, or set `AINIZE_TEACH_KEY`. Every `teach` command takes
them.

## 5. Upload it, and read what the node would not train

```bash
ainize teach dataset upload ./handbook.csv --name "Aster handbook"
```

```text
Aster handbook  http://localhost:3618
dataset             a5576109-2d22-4e3f-ba27-0a464c589b06
questions           4 kept · 5 lines not used
fingerprint         d2c10179c5aceb80…  (revision 1)
where it came from  a file you uploaded — handbook.csv · csv · separator "," · header row · utf-8
size                352 B (uploaded 942 B)
state               never trained yet
kept                until 2026-09-11 11:57:29

✓ uploaded handbook.csv (942 B)
4 of 9 lines will train · not used: 1 duplicate, 2 contradicting, 1 too long, 1 empty

lines that will not train
LINE  STATUS     QUESTION                              WHY
────  ─────────  ────────────────────────────────────  ─────────────────────────────────────────────────────
   2  conflict   Which meeting room has the video wal  line 6 asks the same question with a different answer
   6  conflict   Which meeting room has the video wal  line 2 asks the same question with a different answer
   7  duplicate  Who approves an expense over 500 USD  the same question and answer as line 3
   8  empty      When does the office open?            this question has no answer
   9  too_long   Which of the meeting rooms on the fo  the question is 411 characters, 11 over the 400 limit

train it:      ainize teach train a5576109-2d22-4e3f-ba27-0a464c589b06 --effort balanced
see it:        ainize teach dataset get a5576109-2d22-4e3f-ba27-0a464c589b06 -o questions.jsonl
```

Nothing has been trained. The node read the bytes, decided what it could use, and kept the result as a **dataset** — an
id, a fingerprint, and the questions it accepted. Training is a separate decision you make in step 7.

Read the table one row at a time; each line of your file that will not train is in it, with its source line number.

**`conflict` — two answers for one question.** Lines 2 and 6 both ask about the video wall and disagree. Both are
refused, not one: the node cannot know which of them is true, and training a contradiction is the reliable way to teach
a model nothing. Decide which answer is right and delete the other. This is the only status that refuses a line you
wrote on purpose, and it is the one most often worth acting on.

**`duplicate` — the same question and the same answer twice.** Line 7 repeats line 3 exactly. The first copy trains,
the later one is dropped, and nothing is lost. Exports full of duplicates are normal; you can ignore these.

**`empty` — a question with no answer, or an answer with no question.** Line 8 has a question and an empty cell. There
is nothing to teach.

**`too_long` — over this node's limit,** with the exact overage: 411 characters against a 400-character limit. The
limits are the `prompt ≤ 400 / answer ≤ 200` from step 2. Long answers are usually several facts wearing a coat; split
them into separate rows and every one of them trains.

Three more statuses exist that this file did not trigger:

**`blocked`** — the operator has a blocked-topics pattern and your line matched it. It is their machine and their
policy; the line will not train here.

**`over_cap`** — the file has more usable questions than this node keeps in one dataset (`2,000` on the node above).
Everything up to the cap trains and the tail is reported line by line, so you can split the file and upload the rest.

**`not_parsed`** — the line could not be read as a row at all: broken JSON, a column count that does not match the
header. The report shows the raw text, which is usually enough to see what happened.

Two statuses are not refusals at all. A line marked `fixed` **trains**, tidied up first — collapsed whitespace, an
answer flattened onto one line, a stray `Q:` prefix removed, control characters stripped — and the summary counts them
as *tidied up* so you can see that the node changed something before storing it.

A line marked `pii` also trains, and it stops the training set from being shared above `private` until you take it
out. The node says what it saw — an email address, a phone number, a card number, a resident registration number — so
you can decide whether it really is personal data. If you plan to sell what you teach, see
[`TeachDataset`](../reference/schemas.md#teachdataset) for the access levels this affects.

## 6. Fix the file and upload it again

Fix the three real problems — pick one answer for the video wall, fill in the opening time, split or shorten the long
question — and upload the same file again:

```bash
ainize teach dataset upload ./handbook.csv --name "Aster handbook"
```

```text
Aster handbook  http://localhost:3618
dataset             8d82f6cd-a945-464a-8282-80ca3de1e20d
questions           7 kept
fingerprint         19194ab77d67ae0d…  (revision 1)
where it came from  a file you uploaded — handbook.csv · csv · separator "," · header row · utf-8
size                617 B (uploaded 483 B)
state               never trained yet

✓ uploaded handbook.csv (483 B)
7 of 7 lines will train
```

A **new dataset id**, because a dataset is identified by the questions in it — the sha256 of the accepted rows in
their canonical form, which is the `fingerprint` line. Different questions, different dataset. The old one is still
there until you delete it.

The other half of that rule is what happens when you upload the *same* questions again:

```text
· handbook.csv is already on this node — same questions, same dataset, no second copy
```

Same bytes, same dataset, no duplicate, no quota spent. This is why a dataset downloaded from a node and uploaded to
the same node lands back on itself, and it is what makes a lesson reproducible from its own questions:

```bash
ainize teach dataset get 8d82f6cd-a945-464a-8282-80ca3de1e20d -o questions.jsonl
```

```text
✓ saved /tmp/ainize-tut/work/questions.jsonl (617 B) · fingerprint verified — re-uploading it lands on this same dataset
```

Your datasets on a node, with the ones you have finished with removed:

```bash
ainize teach dataset ls
ainize teach dataset rm a5576109-2d22-4e3f-ba27-0a464c589b06
```

```text
your datasets on http://localhost:3618
DATASET                               NAME            QUESTIONS  REV  FINGERPRINT  FROM    LESSONS  STATE   KEPT UNTIL
────────────────────────────────────  ──────────────  ─────────  ───  ───────────  ──────  ───────  ──────  ───────────────────
8d82f6cd-a945-464a-8282-80ca3de1e20d  Aster handbook          7    1  19194ab77d…  upload        0  staged  2026-09-11 11:57:36
a5576109-2d22-4e3f-ba27-0a464c589b06  Aster handbook          4    1  d2c10179c5…  upload        0  staged  2026-09-11 11:57:29

✓ dataset a5576109-2d22-4e3f-ba27-0a464c589b06 deleted. The lessons trained from it are kept — but they can no longer be re-trained from their questions.
```

One line in the dataset card is worth watching for: `heads-up  N questions end the same way`. Questions whose last
few words are identical are the ones a model is most likely to learn as one lump, answering them all alike. It is a
warning, not a refusal — but if you see it, vary the wording before you spend a training run.

Datasets expire on their own — `kept 7 days` in step 2 — and `state` says where each one is: `staged` for one that has
never trained, `ready` once it has, `training` while a lesson is running from it.

## 7. Train it

Everything so far was arithmetic on text. This step spends GPU time on the node's trainer, and it needs the `trainer`
line from step 2 to say `ready`.

<!-- unverified: needs a model runtime -->
```bash
ainize teach train 8d82f6cd-a945-464a-8282-80ca3de1e20d --effort balanced --wait
```

`--effort` picks one of the three presets the node printed: `quick` (8 passes), `balanced` (20) or `thorough` (40).
More passes make the lesson stick harder and take proportionally longer; a lesson that did not stick can be trained
again from the same dataset at a higher effort, which is exactly why the dataset is a separate object.

`--wait` follows the lesson and prints one line every time it changes stage. The stages are worth knowing, because
where a lesson stalls tells you what is wrong:

| Stage | What is happening |
|---|---|
| `QUEUED` | Waiting for a free trainer slot. `teach status` shows how many lessons are ahead. |
| `PREFLIGHT` | Asking the live model your questions **before** training. Anything it already answers correctly is dropped — there is nothing to teach. |
| `LOADING` | Warming the trainer up. |
| `TRAINING` | The passes. The line carries `step 3/20` and how many of the phrasings the model already gets right. |
| `EXPORTED` | The knowledge file is written. Nothing has touched the serving model yet. |
| `CHECKING` | The lesson is loaded into the live model and measured — this is step 8. |
| `READY` | It learned enough of it. Yours to keep or publish. |
| `NEEDS_MORE` | It did not stick: fewer than 75 % of the trained sentences come back right. The lesson is kept; train it again at a higher effort, or add another phrasing. |

Two other flags change what is trained rather than how hard: `--rows N` trains only the first N questions of the
dataset (useful for a first, cheap run of a long file), and `--no-alt` trains only the wording in your file, ignoring
the `alt_prompt` column.

A file can also go straight to a lesson in one command — `ainize teach train ./handbook.csv --effort quick --wait`
uploads it first and prints the same validation table. Do that once you trust the file; the first time, upload and read
the table.

## 8. Read the checks — they decide whether you may publish

<!-- unverified: needs a model runtime -->
When training finishes, the node loads the lesson into the live model and measures three things. `ainize teach status
<lesson-id>` prints them, and so does the lesson's own page at `<node>/teach/lesson/<lesson-id>`:

- **taught** — how many of your trained sentences the model now answers correctly, and how many of the *other*
  phrasings do too. This is the number that separates `READY` from `NEEDS_MORE`.
- **side effects** — a fixed set of unrelated questions asked before and after. If the answers to those changed, the
  lesson did not learn a fact, it damaged something. This is the check the node cares about most.
- **parents** — when the lesson was trained on top of other knowledge, whether that knowledge still answers its own
  questions with yours loaded on top.

Only the first of those is about your questions. The other two are about everything else, which is the difference
between a lesson and a fine-tune.

The whole block reduces to one boolean, and that boolean is the publish gate. If the side-effect check did not pass,
the node refuses to publish the lesson at all:

```text
checks_failed: this lesson changed answers to unrelated questions or to the knowledge it builds on
```

You can still keep such a lesson, load it on your own node and use it. You cannot sell it to anyone.

Two more refusals come from the same gate, and both are recoverable:

```text
job_not_ready: this lesson has not been measured in the live model yet — run a re-check first
checks_failed: the side-effect check was turned off for this lesson — run the check now before publishing
```

The first is what you get when the model server was off when the lesson finished: it trained, it is kept, and nothing
was measured. The second is what `--no-check` costs. `teach train --no-check` skips the side-effect measurement, which
makes a lesson finish sooner and leaves publishing blocked until it is measured — the node will not accept "it was
fine" from the person who wants to sell it. Ask for the measurement (the **Check again** button on the lesson page, or
`POST /api/teach/jobs/<id>/recheck`) and the gate opens if the numbers are good.

> [!IMPORTANT]
> A node with `teach.backend: stub` simulates the whole pipeline without a GPU and labels every number it prints as
> simulated — `note: stub backend (offline) — checks were simulated, not measured in a live model`. That is a working
> demonstration of the flow, not a trained lesson. If you see that note, nothing was measured.

## 9. Keep it, or publish it

<!-- unverified: needs a model runtime -->
A finished lesson is a private draft on the node that trained it. `ainize teach jobs` lists yours, with the dataset each
one came from:

```bash
ainize teach jobs
```

Three things you can do with a `READY` lesson:

**Keep it on the node.** It stays for the `unsaved lessons kept` window from step 2 — seven days by default — and only
your teaching key (and the operator) can load it. Use it from the lesson page, or apply it like any other knowledge.

**Download the file.** The lesson page makes a download link for the `.npz` and its `recipe.json`. That file only works
inside the same model this node serves; [what a knowledge patch is](../concepts/knowledge-patch.md) explains why.

**Publish it.** The lesson goes on the public record, credited to your teaching key, and independent nodes start
verifying it. On a `review` node it waits for the operator first; on an `auto` node it is announced immediately; on a
`never` node this button does not exist. What happens next — attestation, quorum, listing — is
[what "verified" proves](../concepts/verification.md), and what you get paid is
[Set a price and get paid](../how-to/price-knowledge.md).

## Where to go next

The other door to the same pipeline is [Teach by correcting the model](./teach-in-chat.md): no file, no CLI, and a
teaching key that lives in the browser instead of on disk.

If you would rather use somebody else's knowledge than make your own,
[Use knowledge someone else published](./buy-and-apply.md) is the buyer's path, end to end.

Every flag on every command here is in the [CLI reference](../reference/cli.md#ainize-teach), and every `teach.*`
setting your node reads is in the [configuration reference](../reference/config.md#keys).
