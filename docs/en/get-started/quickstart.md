---
title: Quickstart
summary: Run a node of your own, put someone else's knowledge into your model, and ask the same question before and after.
---

# Quickstart

Ainize does one thing, and this page is that one thing end to end: **run a node, load knowledge into the model you
are already serving, and watch the answer change.** Nothing is trained here and nothing is restarted. The knowledge
is a small file of memory rows that goes into the running model and comes back out again.

Read it in order. Every precondition is stated before the step that needs it, and nothing else on this site is
required first — except [Installation](./install.md), which left you with the `ainize` command.

> [!NOTE]
> Every block below is a command that was run and the output it printed. Two edits, and no others: absolute paths
> are shortened (a node's home to `<NGRAM_HOME>`), and where a step could not be run at all, it says so in the text
> instead of showing output. Nothing here is invented.

## What you need first

One thing, and it is not in this repository: **a model you are already serving, that you can plug rows into.**
Ainize does not run a model. It writes into the memory table of one that is running, through two doors that both have
to be open:

- an **OpenAI-compatible HTTP endpoint** — the node asks it `GET /v1/models` and takes the first model id it answers
  with. That is the model your knowledge will be bound to.
- the **memory-table hook** — `scripts/patch.py` in the serving model's own checkout, which is how rows are written
  into the live table without a restart. The node runs it as a local process, so the checkout has to be on the same
  machine as the node.

Standing that up is a deployment question rather than a marketplace one, and the repository answers it next to the
thing it describes, in `deploy/README.md`. If you do not have a model yet, read on anyway: every step up to the last
two works without one, and step 4 is the line that tells you which of the two situations you are in.

## 1. Create the node

A node keeps itself in one directory, named by `NGRAM_HOME`; unset, that is `~/.ngram`. Pick a directory and a port
now — 3402 is the default, and this transcript uses 3610 because the machine it ran on already had a node on 3402.

```bash
export NGRAM_HOME=~/nodes/quickstart
ainize init --name quickstart --port 3610
```

```text
✓ node initialised at <NGRAM_HOME>/config.json
name     quickstart
address  0x9d9da8f0C939c0cE4909ef44B73BeDffF740e77A
port     3610
ledger   local
roles    seller, verifier, serving
the private key lives in <NGRAM_HOME>/config.json and this is the only copy — back it up now: `ainize keys backup <file>`
```

That address is the node's identity, minted here and never again: it owns everything this node publishes, and its
balance. `ledger local` means this node writes its record to a local peer-to-peer log rather than the AIN blockchain,
which is the right choice while you are finding your feet. The three roles it starts with decide what work it does:
`seller` lets it publish and sell knowledge of its own, `verifier` makes it check other people's in the background,
and `serving` says a model sits behind it, so live tests can run here. The last two are also what make a model
*required* — which is why the readiness check in step 4 calls a node without one `NOT READY`.

## 2. Point it at your model

`ainize init` writes a guess into the config — `runtime.api` is `http://localhost:8000`, which is where a vLLM
server usually lands — and a guess is not an answer. Set it to your own endpoint, and set `runtime.repo` to the
checkout that holds `scripts/patch.py`:

```bash
ainize config set runtime.api http://localhost:8000
ainize config set runtime.repo ~/qwen3.8
```

```text
✓ runtime.api = "http://localhost:8000"  (the node reads config.json when it starts)
✓ runtime.repo = "~/qwen3.8"  (the node reads config.json when it starts)
```

The trailing note in that output matters more than it looks: **the node reads `config.json` when it starts**, so a
node that is already running keeps the value it started with until you restart it.

> [!IMPORTANT]
> The transcript for the rest of this page was recorded with `runtime.api` set to `http://127.0.0.1:9` — a closed
> port — because the only model on that machine was reserved for a benchmark that a stray request would have ruined.
> So what you see below from step 4 onward is exactly what a node with no model behind it does: correct in every
> step but the last two, and honest about which two those are.

## 3. Start it

```bash
ainize start -d
```

```text
✓ node started in the background (pid 660275) — port 3610
  logs: <NGRAM_HOME>/node.log   stop: ainize stop
```

`-d` (`--detach`) puts it in the background and writes the pid beside the log; without it the node runs in the
foreground and Ctrl-C stops it. The process you just started is the whole product: the HTTP API, the peer-to-peer
gossip, the verifier loop, and the marketplace website. Open `http://localhost:3610` in a browser and you are looking
at the node you are talking to — the same page these docs are served from.

## 4. The line that decides everything

```bash
ainize status
```

```text
quickstart  http://localhost:3610  (pid 660275)
address     0x9d9da8f0C939c0cE4909ef44B73BeDffF740e77A
roles       seller, verifier, serving
version     0.1.0 · built 2026-09-04 11:36:29
ledger      local · local · 1 records · height 1
runtime     unavailable (serving API unreachable)
peers       0
patches     0 (0 listed)
quorum      2
currency    CREDIT
branches    -
blobs held  0
```

Read the `runtime` line and nothing else for now. It is the go/no-go gate for the two steps at the end of this page,
and it has one of a handful of shapes:

- `available · <model id> · hook ok` — both doors are open. The model id shown is the one the endpoint answered with,
  and it is the model any knowledge you use has to be built for.
- `unavailable (serving API unreachable)` — nothing answered at `runtime.api`. That is the line above, and it is what
  a wrong URL, a stopped server or a closed port all look like.
- `unavailable (runtime repo not found)` — the endpoint answered, but `runtime.repo` does not point at a checkout
  with the hook in it.
- `unavailable (patch hook unavailable (ENGRAM_HOOK=1?))` — the checkout is there and the hook refuses to load. The
  serving process has to have been started with the hook enabled; `deploy/README.md` covers that.

There is one more, `unavailable (model unavailable, try again in a few minutes)`, which is not a misconfiguration: a
generation failed on the model's side and the node is holding it down for a cooldown window rather than hammering it.

Everything else on this page works in all four cases. Only the live test needs the first one.

For a deploy script or a monitor, the same question has a shorter form that exits non-zero when a check fails:

```bash
ainize status --check
```

```text
✗ quickstart  http://localhost:3610  NOT READY
ledger   ok · local · height 1
runtime  serving API unreachable
peers    0 configured
```

## 5. Log in

Publishing, buying and configuring are operator actions, and the operator is whoever knows this node's password. The
first `ainize login` sets it; after that it asks for it.

```bash
ainize login
```

```text
✓ operator password set and logged in to http://localhost:3610 (token saved in <NGRAM_HOME>/cli.json)
```

The token in `cli.json` is what the CLI sends afterwards, so you log in once per home directory. (A script that
cannot type at a prompt passes `--password`, or sets `NGRAM_PASSWORD`; that is how the line above was actually run.)

## 6. Find knowledge to test

There is no central catalogue. A node's catalogue is what it has heard about from the nodes it talks to, so a node
that talks to nobody has an empty one:

```bash
ainize patch ls
```

```text
no patches match
```

Give it a peer — any node already on the network, whose URL somebody gave you — and the announcements start arriving:

```bash
ainize peers add http://localhost:3611
```

```text
✓ peer added: http://localhost:3611
```

```bash
ainize patch ls
```

```text
ID              STATUS  AUTHOR                 MODEL               ROWS     SIZE     PRICE  ATTEST  SOLD  BENCHMARK
──────────────  ──────  ─────────────────────  ──────────────────  ────  ───────  ────────  ──────  ────  ─────────
demo-knowledge  LISTED  network-2 0xA1f3…560f  Qwen3.8-Flash-Next    12  15.8 KB  2 CREDIT     2/2     0  qa-v1
```

Four columns carry the decision. `MODEL` has to match the model your node found in step 4, because a knowledge is
rows of one specific model's memory table and means nothing in another. `ATTEST 2/2` is how many independent nodes
have checked it, against the number this node insists on before it will treat it as sellable — and the author is
never one of them, because a node refuses to count its own check. `STATUS LISTED` is that count being reached.
`PRICE` is what step 7 will pay, in this node's currency.

What a check consists of is not fixed, and this is the one place a quickstart should not round off: a verifier with a
compatible model loads the rows and runs the author's benchmark, while a verifier without one can only confirm that
the file is the file the record says it is. Both are recorded, and they are not the same claim. Both attestations in
the transcript above are the second kind — the network in it had no model — which is why `2/2` here means *checked*,
not *scored*. The Concepts group has the page that draws that line properly.

> [!NOTE]
> The network in this transcript is three nodes on one machine, and the single piece of knowledge on it is a
> synthetic file published to record this page. The commands and their output are real; the knowledge is not, and
> `demo-knowledge` does not know anything about Seoul or anywhere else. Peer with a node that has real knowledge on
> it and this table fills with real rows.

## 7. Put it on your node

One command checks that it is verified, pays for it, downloads it and loads it into your model:

```bash
ainize use demo-knowledge
```

<!-- unverified: needs a model runtime — the final "load into the model" step of `ainize use` could not be run; the transcript below is the same command against a node whose runtime line reads `unavailable`, and the buy half is real -->

```text
error: serving API unreachable
```

That is the no-model case again, and it is worth stopping on, because the error names only the last step. The four
before it happened:

```bash
ainize logs --kind buy
```

```text
2026-09-04 11:48:49 info  buy       [demo-knowledge] quorum: 2 attestation(s) ≥ quorum 2
2026-09-04 11:48:49 info  buy       [demo-knowledge] 402: Payment Required: 2 CREDIT → 0xA1f3189f… (local-credit)
2026-09-04 11:48:49 info  buy       [demo-knowledge] pay: signed credit intent 053d8284efbd85…
2026-09-04 11:48:49 info  buy       [demo-knowledge] settled: seller confirmed; manifest sha256 38626e6f0383fb…
2026-09-04 11:48:49 info  buy       [demo-knowledge] download: body already present; sha256 matches on-ledger anchor
```

Read top to bottom that is the whole trade: the buyer checked the verification count itself, the seller answered the
download with `402 Payment Required` and a price, the buyer signed a payment and sent it back, the seller settled,
and the body arrived with its hash matching the one on the public record. No account was created and no card was
entered — the node paid with the key it minted in step 1. The money moved:

```bash
ainize wallet
```

```text
address             0x9d9da8f0C939c0cE4909ef44B73BeDffF740e77A
ledger              local · local
balance             98 CREDIT
sales               0
royalties received  0
purchases           1
royalty payouts owed  none pending
```

A second `ainize use` of the same knowledge costs nothing — the node already owns it, and says so:

```bash
ainize use demo-knowledge --no-apply
```

```text
✓ demo-knowledge is already on this node (purchased)
✓ try it: ainize chat demo-knowledge "your question"
```

## 8. Ask the same question twice

This is the step everything else was for. `ainize chat` asks your serving model one question twice — once as it is,
once with the knowledge loaded — and prints both answers side by side. First, what can be tested here:

```bash
ainize chat --list
```

```text
runtime unavailable — serving API unreachable  (chat needs a serving node; pass --node <url> of one)
ID              NAME            MODEL                                                       FACTS  MEMORY ROWS  VERIFIED  TRY
──────────────  ──────────────  ──────────────────  ─────────────────────────────────────────────  ───────────  ────────  ───
demo-knowledge  demo knowledge  Qwen3.8-Flash-Next  Which Seoul Metro line is Gangnam station on?           12     2/2 ✓  -

ainize chat <ID> "<question>"   or   ainize chat <ID>   for an interactive session   (ainize chat --patch a,b loads up to 3 together)
```

The list is of knowledge whose body this node holds — which is what step 7 arranged. `FACTS` shows the benchmark
question the author published with it, so you can start with a question you already know the expected answer to.

<!-- unverified: needs a model runtime — `ainize chat` was run and refused at the runtime gate; the before/after output below it is described from packages/cli/src/commands/chat.ts, never pasted -->

```bash
ainize chat demo-knowledge "Which Seoul Metro line is Gangnam station on?"
```

On a node whose `runtime` line reads `unavailable`, this is where the page stops, with the same refusal as step 7:

```text
error: serving API unreachable
```

With a model behind it, the command prints two blocks instead. The first, `before (base model)`, is the answer your
model gives on its own. Then the rows are written into the live table, the same question is asked again, and the
second block — `after (demo-knowledge loaded)` — is what it says now, with the time the load took. Where the question
matches one of the benchmark samples the author published, each answer is marked `correct ✓ (benchmark)` or
`wrong ✗ (benchmark)`, so the change is scored and not just admired. Leave the question off and you get an
interactive session with the knowledge loaded; `/quit` ends it.

If the two blocks are identical, the knowledge did not touch what you asked about, and that is a real answer too —
it is the reason the live test exists and the reason to run it before paying rather than after.

## 9. Stop the node

```bash
ainize stop
```

```text
✓ stopped node (pid 660275)
```

The node's home directory survives; starting it again picks up the same identity, the same balance and the same
knowledge. Removing the directory destroys the key, and with it everything the node published.

## Where to go next

You have a node, and it can pay for and load somebody else's knowledge. Three questions come next, and each has its
own group in the navigation on the left.

- **Make knowledge of your own.** The **Tutorials** group takes one whole task at a time, start to finish: teaching
  from a file of questions and answers, teaching by correcting the model in a browser, and the buying-and-applying
  path this page compressed into two steps.
- **Understand what you just did.** The **Concepts** group is the why, with nothing to run: what is actually inside
  that file, what `LISTED` and `2/2` prove and what they do not, where the money goes when knowledge builds on
  knowledge, and why a purchase needs no account.
- **Run it properly.** The **How-to** group is for the day the node stops being a toy — making it reachable from
  other machines, pricing what you publish, and what to do when something you published will not list.

And when you need the exact spelling of a flag or a config key, that is the other half of this site: the
[CLI reference](../reference/cli.md) and the [configuration reference](../reference/config.md) are generated from the
code itself, so they cannot drift from what the program does.
