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
now — 3402 is the default, and this transcript uses 3694 because the machine it ran on already had nodes on the
lower numbers.

```bash
export NGRAM_HOME=~/nodes/quickstart
ainize init --name quickstart --port 3694
```

```text
✓ node initialised at <NGRAM_HOME>/config.json
name     quickstart
address  0x67470AEa0c6d6877841D3c79e961d33A440225E3
port     3694
ledger   local
roles    seller, verifier, serving
the private key lives in <NGRAM_HOME>/config.json and this is the only copy — back it up now: `ainize keys backup <file>`

next: `ainize start`   (then `ainize login`, `ainize seed`)
```

That address is the node's identity, minted here and never again: it owns everything this node publishes, and its
balance. `ledger local` means this node writes its record to a local peer-to-peer log rather than the AIN blockchain,
which is the right choice while you are finding your feet. The three roles it starts with decide what work it does:
`seller` lets it publish and sell knowledge of its own, `verifier` makes it check other people's in the background,
and `serving` says a model sits behind it, so live tests can run here. The last two are also what make a model
*required* — which is why the readiness check in step 4 calls a node without one `NOT READY`.

Ignore the `ainize seed` in that last line for now. It fills a node with demo knowledge built from files in a model
checkout this page does not assume you have; on a machine without them it reports `missing 4 source file(s)` and
creates nothing, and it refuses to run at all while the node is up. Step 6 is how this page gets something to buy.

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
✓ runtime.repo = "/home/comcom/qwen3.8"  (the node reads config.json when it starts)
```

Both are written straight to `config.json` and neither contacts anything, so a wrong value here fails later, at
step 4, and not now. The trailing note matters more than it looks: **the node reads `config.json` when it starts**,
so a node that is already running keeps the value it started with until you restart it.

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
✓ node started in the background (pid 730221) — port 3694
  logs: <NGRAM_HOME>/node.log   stop: ainize stop
```

`-d` (`--detach`) puts it in the background and writes the pid beside the log; without it the node runs in the
foreground and Ctrl-C stops it. The process you just started is the whole product: the HTTP API, the peer-to-peer
gossip, the verifier loop, and the marketplace website. Open `http://localhost:3694` in a browser and you are looking
at the node you are talking to — the same page these docs are served from.

## 4. The line that decides everything

```bash
ainize status
```

```text
quickstart  http://localhost:3694  (pid 730221)
address     0x67470AEa0c6d6877841D3c79e961d33A440225E3
roles       seller, verifier, serving
version     0.1.0 · built 2026-09-04 12:25:57
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
✗ quickstart  http://localhost:3694  NOT READY
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
✓ operator password set and logged in to http://localhost:3694 (token saved in <NGRAM_HOME>/cli.json)
```

The token in `cli.json` is what the CLI sends afterwards, so you log in once per home directory. (A script that
cannot type at a prompt passes `--password`, or sets `NGRAM_PASSWORD`; that is how the line above was actually run.)

`cli.json` also records the node's URL, and that is the one thing to remember about it: the CLI talks to the URL it
logged in to, not to whatever `config.json` currently says. Change the node's port after logging in and every
command keeps addressing the old one. Deleting `cli.json` and running `ainize login` again is the whole repair.

## 6. Find knowledge to test

> [!IMPORTANT]
> **This step needs something the first five did not: another node that has already published something.** There is
> no central catalogue and no default peer. A node you have just created knows of no other node, so its catalogue
> starts empty and stays empty until you give it an address — and steps 7 and 8 have nothing to act on until it
> does. Where that address comes from is the one thing this page cannot hand you: either somebody on the network
> gives you theirs, or you run the second node yourself and publish to it, which is what
> [Use knowledge someone else published](../tutorials/buy-and-apply.md) walks through from both ends.

A node's catalogue is what it has heard about from the nodes it talks to, so a node that talks to nobody has an
empty one:

```bash
ainize patch ls
```

```text
no patches match
```

Give it a peer — a node already on the network, whose URL somebody gave you — and the announcements start arriving.
The address below is the seller this transcript was recorded against; yours will be somebody else's:

```bash
ainize peers add http://localhost:3690
```

```text
✓ peer added: http://localhost:3690
```

> [!WARNING]
> **That tick means the address was written down, not that anything answered it.** `peers add` checks that what you
> typed is an `http(s)` URL and then stores it; it never contacts the node. A typo, a node that is switched off and
> a node that never existed all print the same `✓ peer added`, and the only symptom is that the catalogue stays
> empty. Where the difference shows is the second table of `ainize nodes`, in which a peer that has never answered
> has no address and a climbing `FAILURES` count, beside the ones that have:
>
> ```text
> configured peers
> ENDPOINT               ADDRESS          LAST SEEN            FAILURES
> ─────────────────────  ───────────────  ───────────────────  ────────
> http://localhost:3691  0xD0b68475…7715  2026-09-04 12:39:33         0
> http://localhost:3690  0x529B9b39…85fd  2026-09-04 12:39:33         0
> http://localhost:3692  0xAb5293f1…35C6  2026-09-04 12:39:33         0
> http://localhost:3611  -                -                           2
> ```
>
> Only `3690` was added by hand there. `3691` and `3692` arrived on their own: peers trade their peer lists, so one
> good address is enough to meet the rest of a network. `3611` is a deliberately wrong address, and it is the row
> that shows what a mistake looks like.

Peers exchange what they know on a timer rather than the moment you ask, so give it a few seconds and ask again:

```bash
ainize patch ls
```

```text
ID                 STATUS      AUTHOR              MODEL                  ROWS      SIZE       PRICE  ATTEST  SOLD  BENCHMARK
─────────────────  ──────────  ──────────────────  ──────────────────  ───────  ────────  ──────────  ──────  ────  ────────────────
law-kr-2026        LISTED      node-a 0x529B…85fd  demo-ngram-1b         1,200    1.5 MB  2.5 CREDIT     2/2     0  law-jurisdiction
law-us-2025        LISTED      node-a 0x529B…85fd  demo-ngram-1b         1,200    1.5 MB    2 CREDIT     2/2     0  law-jurisdiction
law-kr-2025        SUPERSEDED  node-a 0x529B…85fd  demo-ngram-1b         1,200    1.5 MB    2 CREDIT     2/2     0  law-jurisdiction
law-common-base    LISTED      node-a 0x529B…85fd  demo-ngram-1b         2,000    2.5 MB    1 CREDIT     2/2     2  law-basics
krx-all-2761       VERIFYING   node-a 0x529B…85fd  Qwen3.8-Flash-Next  270,053  331.7 MB   25 CREDIT     0/2     0  krx-ticker-codes
krx-all-2761-ep12  VERIFYING   node-a 0x529B…85fd  Qwen3.8-Flash-Next  241,992  297.2 MB   10 CREDIT     0/2     0  krx-ticker-codes
krx-all-2761-ep6   VERIFYING   node-a 0x529B…85fd  Qwen3.8-Flash-Next  241,992  297.2 MB    5 CREDIT     0/2     0  krx-ticker-codes
pixelplus-087600   VERIFYING   node-a 0x529B…85fd  Qwen3.8-Flash-Next    2,992    3.7 MB  0.1 CREDIT     0/2     0  krx-ticker-codes
```

Four columns carry the decision. `MODEL` has to match the model your node found in step 4, because a knowledge is
rows of one specific model's memory table and means nothing in another — which is why a catalogue can hold rows for
models you cannot use, as this one does. `ATTEST 2/2` is how many independent nodes have checked it, against the
number this node insists on before it will treat it as sellable — and the author is never one of them, because a
node refuses to count its own check. `PRICE` is what step 7 will pay, in this node's currency.

`STATUS` is the one to read first, because only two of its values can be bought. `LISTED` means the attestations
reached the quorum. `VERIFYING` means checking is under way and has not got there — the four rows above sit at
`0/2` — and buying one is refused before any money moves:

```bash
ainize use pixelplus-087600
```

```text
error: pixelplus-087600 is VERIFYING (verification 0/2) — not verified yet; try `ainize patch get pixelplus-087600`
```

`SUPERSEDED` means the author has since published something newer; it is still buyable, and
[When it will not list](../how-to/failed-verification.md) is where the rest of the states are worked through.

What a check consists of is not fixed, and this is the one place a quickstart should not round off: a verifier with a
compatible model loads the rows and runs the author's benchmark, while a verifier without one can only confirm that
the file is the file the record says it is. Both are recorded, and they are not the same claim. Every attestation in
the transcript above is the second kind — the network in it had no model — which is why `2/2` here means *checked*,
not *scored*. The Concepts group has the page that draws that line properly.

> [!NOTE]
> The network in this transcript is three nodes on one machine, and its knowledge is synthetic — files generated to
> record this page, with `[synthetic]` in their names. The commands and their output are real; the knowledge is not,
> and `law-common-base` does not know any actual law. Peer with a node that has real knowledge on it and this table
> fills with real rows.

## 7. Put it on your node

One command checks that it is verified, pays for it, downloads it and loads it into your model:

```bash
ainize use law-common-base
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
2026-09-04 12:39:36 info  buy       [law-common-base] quorum: 2 attestation(s) ≥ quorum 2
2026-09-04 12:39:36 info  buy       [law-common-base] 402: Payment Required: 1 CREDIT → 0x529B9b39… (local-credit)
2026-09-04 12:39:36 info  buy       [law-common-base] pay: signed credit intent a0f57f34e69206…
2026-09-04 12:39:36 info  buy       [law-common-base] settled: seller confirmed; manifest sha256 4fff05beaec02e…
2026-09-04 12:39:36 info  buy       [law-common-base] download: 2.6 MB from http://localhost:3690; sha256 matches on-ledger anchor
```

Read top to bottom that is the whole trade: the buyer checked the verification count itself, the seller answered the
download with `402 Payment Required` and a price, the buyer signed a payment and sent it back, the seller settled,
and the body arrived with its hash matching the one on the public record. No account was created and no card was
entered — the node paid with the key it minted in step 1. The money moved:

```bash
ainize wallet
```

```text
address             0x67470AEa0c6d6877841D3c79e961d33A440225E3
ledger              local · local
balance             99 CREDIT
sales               0
royalties received  0
purchases           1
royalty payouts owed  none pending
```

> [!WARNING]
> **A failure here can still have cost you money.** The command above printed one line, `error: serving API
> unreachable`, and exited non-zero — but the balance went from 100 to 99 and `purchases` from 0 to 1, because the
> purchase had already completed before the step that failed. `ainize use` reports the stage that broke, not the
> stages that succeeded, so check `ainize wallet` or `ainize logs --kind buy` rather than assuming an error means
> nothing happened. Running it again is safe and free, as the next block shows.

A second `ainize use` of the same knowledge costs nothing — the node already owns it, and says so:

```bash
ainize use law-common-base --no-apply
```

```text
✓ law-common-base is already on this node (purchased)
✓ try it: ainize chat law-common-base "your question"
```

If instead this step answers `error: patch not found`, nothing is wrong with your node: the id is not in its
catalogue, which is step 6 not having found you a peer that carries it.

## 8. Ask the same question twice

This is the step everything else was for. `ainize chat` asks your serving model one question twice — once as it is,
once with the knowledge loaded — and prints both answers side by side. First, what can be tested here:

```bash
ainize chat --list
```

```text
runtime unavailable — serving API unreachable  (chat needs a serving node; pass --node <url> of one)
ID               NAME                             MODEL          FACTS  MEMORY ROWS  VERIFIED  TRY
───────────────  ───────────────────────────────  ─────────────  ─────  ───────────  ────────  ───
law-common-base  [synthetic] common legal basics  demo-ngram-1b     40        2,000     2/2 ✓  -

ainize chat <ID> "<question>"   or   ainize chat <ID>   for an interactive session   (ainize chat --patch a,b loads up to 3 together)
```

The list is of knowledge whose body this node holds — which is what step 7 arranged, and why the other seven rows of
the catalogue are not in it. `FACTS` is how many question-and-answer pairs the author published with it, and `TRY`
shows one of them where there is one, so you can start from a question with a known answer. On a node that has bought
nothing the same command says so: `no testable patch on this node`.

<!-- unverified: needs a model runtime — `ainize chat` was run and refused at the runtime gate; the before/after output below it is described from packages/cli/src/commands/chat.ts, never pasted -->

```bash
ainize chat law-common-base "Which court hears a contract dispute?"
```

On a node whose `runtime` line reads `unavailable`, this is where the page stops, with the same refusal as step 7:

```text
error: serving API unreachable
```

With a model behind it, the command prints two blocks instead. The first, `before (base model)`, is the answer your
model gives on its own. Then the rows are written into the live table, the same question is asked again, and the
second block — `after (law-common-base loaded)` — is what it says now, with the time the load took. Where the
question matches one of the benchmark samples the author published, each answer is marked `correct ✓ (benchmark)` or
`wrong ✗ (benchmark)`, so the change is scored and not just admired. Leave the question off and you get an
interactive session with the knowledge loaded; `/quit` ends it.

If the two blocks are identical, the knowledge did not touch what you asked about, and that is a real answer too —
it is the reason the live test exists and the reason to run it before paying rather than after.

## 9. Stop the node

```bash
ainize stop
```

```text
! node 730221 is still running 10 s after SIGTERM — sending SIGKILL
✓ stopped node (pid 730221) — it ignored SIGTERM, so it was killed
```

A node that shuts down promptly prints only the second line, without the `it ignored SIGTERM` clause. Both are a
successful stop; the ten-second pause is `ainize stop` waiting out a node that did not exit on its own, and it is
what a node with peer connections open does on this build.

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
