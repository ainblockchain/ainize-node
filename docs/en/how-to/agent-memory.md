---
title: Give an agent a memory
summary: An agent that answers from what it already knows, buys a knowledge when one covers the question, looks it up when nothing does — and compiles the lookup into an engram once repeating it has cost more than compiling it would.
---

# Give an agent a memory

`ainize-agent run` buys one knowledge, proves it changed the model's answer, and stops. Run it again tomorrow and it
starts from nothing: it does not know what it bought, what it looked up, or what it already answered.

`ainize-agent ask` is the same agent with a memory, and the memory is the whole point. A question arrives:

```
can I answer it from the memory I already carry?     yes → answer. no query, no completion, no cost.
is there a LISTED knowledge that covers it?          yes → buy it, apply it, and KEEP it.
otherwise                                            ask upstream. that costs a query EVERY time it is asked.
    …and once the same SHAPE has been looked up
      often enough that querying has already cost
      more than compiling would                      → ainize it: build a dataset out of what was retrieved,
                                                        spend a lesson on it, keep the engram.
```

Retrieval is a cost paid **per question**. Compiled memory is a cost paid **once**. This page is how to run the
thing that decides between them, and what it refuses to do.

## What it costs before you start

`ask` can spend four things that do not convert into one another, and it will not spend **any** of them without a cap:

| unit | flag | what it buys |
|---|---|---|
| money | `--budget-per-day` | a knowledge on the market |
| upstream queries | `--queries-per-day` | one call to somebody else's MCP server |
| lessons | `--lessons-per-day` | one teach job — the node charges it at submit and never refunds it |
| GPU seconds | `--gpu-seconds-per-day` | the trainer's time |

No cap set is not "unlimited": it means this agent will not spend that unit on its own, and it says so with the flag
that would change it. **A cap can only be set from outside the loop** — from a flag, from `AINIZE_AGENT_*` in the
environment, or from `budget.*` in `<home>/agent.json`. A plan file cannot raise one, a market's answer cannot, and
a 402 cannot. That is what makes it safe to leave running.

```bash
ainize-agent budget                       # all four, what is left, and where each cap came from
```

Every number on that screen is read from `<home>/spend.jsonl` and `<home>/purchases.jsonl`.

## 1. Ask something

```bash
ainize-agent ask "what is the contract address of USDC?" \
  --market http://localhost:3402 --queries-per-day 20
```

The first time, memory holds nothing, no knowledge on that market covers it, and a **plan** matches the wording — so
the agent calls the upstream server once and answers from the rows it got back. Those rows are now in memory.

Ask the same question again and it costs nothing at all: no query, no completion.

```bash
ainize-agent ask "what is the contract address of USDC?" --json | jq '.via, .cost'
# "memory"
# { "completions": 0, "queries": 0, "money": null, "lessons": 0, "gpu_s": null, "ms": 82 }
```

### How it decides, without asking the model twice

The decision costs **zero completions**. The model is never asked whether it knows something — the index is:

1. the question is normalized with the node's own prompt key, so a fact learned from a training set and a question
   typed by a person land on the same key;
2. it is looked up in `<home>/memory-index.json`;
3. residency is checked against a **stack fingerprint** — `sha256(model + every layer's position, id and hash)` from
   the public `GET /api/runtime`. It changes when anything at all is applied, removed, reordered or re-bodied, by
   this agent or by another tenant of the same shared model;
4. if the answer cache is fresh for that fingerprint, the remembered answer is returned. Otherwise **one** completion
   is made and scored against it — that single call is both the check and the answer. A mismatch is not an error: it
   demotes the row and falls through to the cost path. **Memory is a claim; the model is the truth.**

With no serving model the remembered answer comes back labelled `via: "memory"`. That label always travels with it.

## 2. Plans — what the agent will and will not look up

A **plan** is declarative JSON in `<home>/plans/*.json`: a server, a tool, the arguments, how to turn the answer into
rows, and the phrasings it answers to, in English and Korean.

```bash
ainize-agent plans --check
```

`--check` is worth running before a plan ever costs a query. Its most important finding is whether **binding a slot
changes the shape** — because if it does, every entity gets its own counter and the agent will never notice it is
repeating itself.

A question that matches no pattern **is not retrieved**. The agent prints the plans it has and stops, rather than
guessing a query with somebody else's API key. That is the honest description of this mechanism: it collapses
*declared* phrasings; it does not understand meaning.

## 3. What counts as "the same thing, looked up again"

Not the question — the **retrieval**. The agent cannot reliably tell that two sentences mean the same thing and does
not pretend to. It knows exactly that it ran the same query against the same server with a different argument:

```
shape = sha256({ server, tool, skeleton(arguments), mapping.path, mapping.prompt, mapping.answer })
```

`skeleton()` replaces every literal with a typed placeholder, and a GraphQL document with its structure. So
`"USDC"` in one call and `"WETH"` in the next produce **one** shape — which is exactly where a counter keyed on the
question text never fires.

```bash
ainize-agent memory
#   ef393190fa86  lookups 12 · facts 10 · new 10 · refetched 2 · churned 0 · retrieval 12 / recall 0 / bake 1
```

Three counters, and a fourth signal: `refetched` (a fact this agent has demonstrably paid for twice, however the two
questions were worded) and `churned` (a fact whose answer **moved** between two pulls — that one belongs upstream, on
the tail, not compiled into memory).

## 4. When it compiles, and when it refuses

Four gates, all of which must hold:

| gate | test |
|---|---|
| economic | lookups ≥ N\* |
| material | at least 8 distinct facts — the node's own `teach.rowsPerJob.floorGradient` |
| stability | churn ≤ `--max-churn` (default: none at all) |
| budget | a lesson **and** the GPU seconds both fit in what is left today |

**N\* is not a number anybody picked.** `graph/bench` owns the arithmetic —

```
N* = one-time cost / (cost per question retrieving − cost per question recalling)
```

— and its run `r1` leaves it **uncomputed**, in writing, because both arms have to be scored and priced first. So the
agent computes it from its own recorded measurements, per unit, and takes the largest:

- **seconds** is the real break-even, and the one that binds;
- **queries** is reported because it is true (a bake makes no upstream call, so compiling pays for itself
  immediately) and never binds;
- **tokens** has no break-even at all — a retrieval spends no completion tokens and a recall does — so it is reported
  and excluded, rather than quietly counted.

Below three measurements on either side, N\* is undefined and the agent does not bake. That is the node's own
`ETA_MIN_SAMPLES` rule: three stub jobs must never become an estimate, and three lookups must never become a
break-even.

```bash
ainize-agent memory --why ef393190fa86
# would it be compiled? no
#   no  economic   {"lookups":10,"n_star":null,"binding_unit":null,"declared_floor":null,"computable":"no"}
#   ok  material   {"distinct_rows":10,"floor":8}
#   ok  stability  {"churn_rate":null,"churned":0,"refetched":0,"max_churn":0}
#   no  budget     {"lessons":1,"gpu_s":0,"checked":2}
#   missing: bake_cost: no lesson of this shape has finished on a real trainer
```

**So the first bake is always your decision.** `bake_cost` can only be measured by a lesson that has already run, and
a lesson run on `AINIZE_TEACH_BACKEND=stub` copies a fixture: its seconds are the cost of a file copy and are
deliberately not counted as a price. You turn it on one of two ways:

```bash
# a declared POLICY — labelled as one everywhere it appears, never presented as a measurement
ainize-agent ask "…" --bake-after 3 --lessons-per-day 1 --gpu-seconds-per-day 3600

# or fund the lesson budget and let it measure; the earliest autonomous bake is then the 4th lookup
```

## 5. What a bake does, and what it deliberately does not

It builds the training set out of the rows this agent **already paid for** (`<home>/retrieved/<shape>.jsonl`, with
the sealed provenance beside it), uploads it, submits one lesson, polls the node's own state machine, and writes the
`bake` event into memory **at submit and again at the end** — so a crash mid-training still leaves a handle.

It does **not publish**. Publishing writes an anchor nobody can recall, and the rows came from somebody else's data
through a gateway key: who may build on them and who is paid is your decision, not an agent's. The run ends by naming
the one command that would:

```bash
ainize teach publish <lesson id> --name "…" --price 2 --consent-permanent --consent-rights
```

Two things it says out loud before it spends anything:

- **the lesson is signed with this agent's own identity** — the same key that pays for its purchases. Everything it
  bakes and everything it buys is attributable to one address on a public record. That is deliberate (lineage needs
  it) and you should know it before the first lesson.
- **on `AINIZE_TEACH_BACKEND=stub`** the lesson record, the dataset and the state machine are real and the knowledge
  file is a fixture that trains no weights. Nothing measured on a stub run says anything about a model.

## 6. When memory and the node disagree

`ask` reads the node's public `GET /api/runtime` at the start of every run and reconciles. The rule, once:
**the node wins about the model; the agent wins about itself; a disagreement is recorded, not silently resolved.**

| what happened | what the agent does |
|---|---|
| memory says loaded, the node does not list it | the model does not have it — demoted to `held`; recall may not claim it |
| the node lists a layer this agent does not own | a foreign layer: it counts in the fingerprint, it never becomes this agent's memory, and it is never removed |
| same knowledge, different body hash | the body changed underneath — every fact from it is demoted to `unverified` |
| the agent home is gone | memory is empty and says so. Residency, ownership and coverage are rebuilt; the lookup history is not, so the counters restart at zero and it will not bake on a memory it does not have |

## Exit codes

| code | meaning |
|---|---|
| 0 | answered |
| 1 | no answer |
| 2 | a budget refused, and nothing was spent |

An unattended loop has to be able to tell "I could not afford this" from "I broke".

## Where everything is

```
<home>/memory.jsonl          append-only: learn, recall, retrieve, buy, apply, bake, demote, conflict
<home>/memory-index.json     a derived snapshot; deleting it costs a replay, never a fact
<home>/spend.jsonl           one line per reservation and per settlement, intent written first
<home>/retrieved/<shape>.*   the rows a bake trains on, and their sealed provenance
<home>/plans/*.json          what this agent knows how to look up
<home>/agent.json            caps, when you would rather not repeat the flags
```

All of it is text. `cat`, `grep` and `diff` work, and copying the directory to another machine moves the memory with
it.

## Related

- [Load several knowledges at once](./load-several.md) — what "keep it" means on a shared model.
- [Build on someone else's knowledge](./build-on-knowledge.md) — publishing what an agent baked, and what it pays.
- [Publish every day](./publish-every-day.md) — the unattended version of the last step.
