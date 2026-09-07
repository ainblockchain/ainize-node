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
> are shortened (a node's home to `<AINIZE_HOME>`), and where a step could not be run at all, it says so in the text
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

A node keeps itself in one directory, named by `AINIZE_HOME`; unset, that is `~/.ainize`. Pick a directory and a port
now — 3402 is the default, and this transcript uses 3694 because the machine it ran on already had nodes on the
lower numbers.

```bash
export AINIZE_HOME=~/nodes/quickstart
ainize init --name quickstart --port 3694
```

```text
✓ node initialised at <AINIZE_HOME>/config.json
name     quickstart
address  0x4079e607370cC79B00c6051204bDb5c67a54FB12
port     3694
ledger   local
roles    seller, verifier, serving
the private key lives in <AINIZE_HOME>/config.json and this is the only copy — back it up now: `ainize keys backup <file>`

next: `ainize start`   (then `ainize login`, `ainize seed`)
```

That address is the node's identity, minted here and never again: it owns everything this node publishes, and its
balance. `ledger local` means this node writes its record to a local peer-to-peer log rather than the AIN blockchain,
which is the right choice while you are finding your feet. The three roles it starts with decide what work it does:
`seller` lets it publish and sell knowledge of its own, `verifier` makes it check other people's in the background,
and `serving` says a model sits behind it, so live tests can run here. The last two are also what make a model
*required* — which is why the readiness check in step 4 calls a node without one `NOT READY`.

The `ainize seed` in that last line is not decoration: it fills a node with demo knowledge, and step 6 uses it to give
this page something to buy. Two things to know before you reach for it. It refuses to run while the node is up, because
seeding writes into the data directory the running process owns. And by default it looks for real patch files in the
model checkout named by `runtime.repo` — on a machine without them it reports `missing source file(s)` and creates
nothing. The `--synthetic --no-real` form used in step 6 needs no checkout and no model at all.

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
> Type your own endpoint there. The transcript on the rest of this page was recorded with `runtime.api` set to
> `http://127.0.0.1:9` — a closed port — because the only model on that machine was reserved for a benchmark that a
> stray request would have ruined; the two lines above are the same command with the address a reader is more likely
> to want. So everything from step 4 onward is exactly what a node with no model behind it does: correct in every
> step but the last two, and honest about which two those are.

## 3. Start it

```bash
ainize start -d
```

```text
✓ node started in the background (pid 766683) — port 3694
  logs: <AINIZE_HOME>/node.log   stop: ainize stop
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
quickstart  http://localhost:3694  (pid 766683)
address     0x4079e607370cC79B00c6051204bDb5c67a54FB12
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
✓ operator password set and logged in to http://localhost:3694 (token saved in <AINIZE_HOME>/cli.json)
```

The token in `cli.json` is what the CLI sends afterwards, so you log in once per home directory. (A script that
cannot type at a prompt passes `--password`, or sets `AINIZE_PASSWORD`; that is how the line above was actually run.)

`cli.json` also records the node's URL, and that is the one thing to remember about it: the CLI talks to the URL it
logged in to, not to whatever `config.json` currently says. Change the node's port after logging in and every
command keeps addressing the old one. Deleting `cli.json` and running `ainize login` again is the whole repair.

## 6. Find knowledge to test

This step needs something the first five did not: **another node that has already published something.** There is no
central catalogue and no default peer, so a node that has just been created knows of no other node and its catalogue
starts empty:

```bash
ainize patch ls
```

```text
no patches match
```

If somebody on the network has given you their node's URL, that is the address for the next command and you can skip
the section below. If nobody has, build a practice network on this machine instead — it needs no model, no knowledge
of your own, and about a minute.

### If you have no peer: a practice network

Three nodes, not two, and the reason is the whole point of the marketplace: knowledge is for sale only once
**independent** nodes have attested to it, the default quorum is two, and **an author's node never attests its own
work**. Your node from step 1 is one verifier. A seller and one more checker make up the other two. Build only a
seller and everything it publishes sits at `1/2` for ever — verified once, by you, and never listed.

`--home` picks which node a single command is for, so the next two can be run without disturbing the `AINIZE_HOME` you
set in step 1. First the seller: create it, fill it with demo knowledge, start it.

```bash
ainize --home ~/nodes/seller init --name seller --port 3692
ainize --home ~/nodes/seller seed --synthetic --no-real
ainize --home ~/nodes/seller start -d
```

```text
✓ node initialised at ~/nodes/seller/config.json
name     seller
address  0x9ef1F6e4E301CBd95C91556D3891BA9655B7eDB3
port     3692
ledger   local
roles    seller, verifier, serving
the private key lives in ~/nodes/seller/config.json and this is the only copy — back it up now: `ainize keys backup <file>`

next: `ainize start`   (then `ainize login`, `ainize seed`)

[2026-09-04T14:06:45.954Z] INFO  patch: draft created: law-common-base (2000 rows, 2.6 MB)
[2026-09-04T14:06:45.962Z] INFO  publish: announced law-common-base (conflicts: 0)
[2026-09-04T14:06:45.972Z] INFO  patch: draft created: law-kr-2025 (1200 rows, 1.5 MB)
[2026-09-04T14:06:45.980Z] INFO  publish: announced law-kr-2025 (conflicts: 1)
[2026-09-04T14:06:45.990Z] INFO  patch: draft created: law-us-2025 (1200 rows, 1.5 MB)
[2026-09-04T14:06:45.998Z] INFO  publish: announced law-us-2025 (conflicts: 2)
[2026-09-04T14:06:46.017Z] INFO  patch: draft created: law-kr-2026 (1200 rows, 1.5 MB)
[2026-09-04T14:06:46.025Z] INFO  publish: announced law-kr-2026 (conflicts: 3)
✓ seeded: 4 patch(es), 2 branch(es), 0 prototype record(s) imported
  created:  law-common-base, law-kr-2025, law-us-2025, law-kr-2026
  branches: law/KR, law/US

✓ node started in the background (pid 766562) — port 3692
  logs: ~/nodes/seller/node.log   stop: ainize stop
```

The two flags on `seed` are what make it work with no model anywhere on the machine. `--synthetic` generates four
small knowledge files of random rows — real files, real records, no real law in them — and `--no-real` turns off the
default hunt for genuine patch files inside `runtime.repo`. Neither flag contacts a model. Seeding also has to happen
before the node starts, because it writes into the data directory a running node owns.

> [!WARNING]
> `--home` chooses the node for the command it is written on, and for nothing else. The `stop: ainize stop` in that
> last line is the CLI's stock hint, and typed as it stands it would stop the node from step 3 rather than this one.
> Stopping the seller is `ainize --home ~/nodes/seller stop`.

Then the third node — the second checker. It needs no seeding and no login: verifying is something a node does
because it is running, not something you ask it for.

```bash
ainize --home ~/nodes/checker init --name checker --port 3691 --peer http://localhost:3692
ainize --home ~/nodes/checker start -d
```

```text
✓ node initialised at ~/nodes/checker/config.json
name     checker
address  0x0b088A365b5ff7311Db2a4b6157c76DF844376c3
port     3691
ledger   local
roles    seller, verifier, serving
the private key lives in ~/nodes/checker/config.json and this is the only copy — back it up now: `ainize keys backup <file>`

next: `ainize start`   (then `ainize login`, `ainize seed`)

✓ node started in the background (pid 766597) — port 3691
  logs: ~/nodes/checker/node.log   stop: ainize stop
```

`--peer` at `init` writes that address into the new node's config, which is the same thing `ainize peers add` does
afterwards. Step 9 stops all three.

### Point your node at it

Back to your own node — `AINIZE_HOME` still names it, so the `--home` prefix is gone again. Give it the seller's
address and the announcements start arriving:

```bash
ainize peers add http://localhost:3692
```

```text
✓ peer added: http://localhost:3692
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
> Only one of those was added by hand; the others arrived on their own, because peers trade their peer lists and one
> good address is enough to meet the rest of a network. `3611` is a deliberately wrong address, and it is the row
> that shows what a mistake looks like.

Peers exchange what they know on a timer rather than the moment you ask, so give it a few seconds and ask again:

```bash
ainize patch ls
```

```text
ID               STATUS      AUTHOR              MODEL           ROWS    SIZE       PRICE  ATTEST  SOLD  BENCHMARK
───────────────  ──────────  ──────────────────  ─────────────  ─────  ──────  ──────────  ──────  ────  ────────────────
law-kr-2026      LISTED      seller 0x9ef1…eDB3  demo-ainize-1b  1,200  1.5 MB  2.5 CREDIT     2/2     0  law-jurisdiction
law-us-2025      LISTED      seller 0x9ef1…eDB3  demo-ainize-1b  1,200  1.5 MB    2 CREDIT     2/2     0  law-jurisdiction
law-kr-2025      SUPERSEDED  seller 0x9ef1…eDB3  demo-ainize-1b  1,200  1.5 MB    2 CREDIT     2/2     0  law-jurisdiction
law-common-base  LISTED      seller 0x9ef1…eDB3  demo-ainize-1b  2,000  2.5 MB    1 CREDIT     2/2     0  law-basics
```

Four columns carry the decision. `MODEL` has to match the model your node found in step 4, because a knowledge is
rows of one specific model's memory table and means nothing in another — so a catalogue on a real network holds rows
for models you cannot use, and those rows are not for you. `ATTEST 2/2` is how many independent nodes have checked
it, against the number this node insists on before it will treat it as sellable — and the author is never one of
them, because a node refuses to count its own check. `PRICE` is what step 7 will pay, in this node's currency.

`STATUS` is the one to read first, because only two of its values can be bought. `LISTED` means the attestations
reached the quorum. `SUPERSEDED` means the author has since published something newer; it is still buyable.

The other two are the waiting room, and which one you see says how far along a knowledge is on *your* node.
`ANNOUNCED` means your node has heard the announcement and nothing has attested to it yet — that is the first thing
a new entry ever is, and a big file stays there for as long as the checking nodes take to fetch it. `VERIFYING` means
at least one attestation exists but the quorum is not met. Both are refused before any money moves, and the message
names the state it found:

```bash
ainize use pixelplus-087600
```

```text
error: pixelplus-087600 is ANNOUNCED (verification 0/2) — not verified yet; try `ainize patch get pixelplus-087600`
```

The same command on an entry one attestation short says `is VERIFYING (verification 1/2)` instead. Neither is an
error you can pay your way past; both are worth waiting out, and
[When it will not list](../how-to/failed-verification.md) is where the rest of the states are worked through and
what to do when the count stops moving.

What a check consists of is not fixed, and this is the one place a quickstart should not round off: a verifier with a
compatible model loads the rows and runs the author's benchmark, while a verifier without one can only confirm that
the file is the file the record says it is. Both are recorded, and they are not the same claim. Every attestation in
the transcript above is the second kind — the network in it had no model — which is why `2/2` here means *checked*,
not *scored*. The Concepts group has the page that draws that line properly.

> [!NOTE]
> The network in this transcript is the three nodes above, on one machine, and its knowledge is what `seed
> --synthetic` makes: files of random rows, named `[synthetic]` in full. The commands and their output are real; the
> knowledge is not, and `law-common-base` does not know any actual law. Peer with a node that has real knowledge on
> it and this table fills with real rows instead.

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
2026-09-04 14:07:35 info  buy       [law-common-base] quorum: 2 attestation(s) ≥ quorum 2
2026-09-04 14:07:35 info  buy       [law-common-base] 402: Payment Required: 1 CREDIT → 0x9ef1F6e4… (local-credit)
2026-09-04 14:07:35 info  buy       [law-common-base] pay: signed credit intent f126af6bb44f7b…
2026-09-04 14:07:35 info  buy       [law-common-base] settled: seller confirmed; manifest sha256 7e8e8a1be950b2…
2026-09-04 14:07:35 info  buy       [law-common-base] download: body already present; sha256 matches on-ledger anchor
```

Read top to bottom that is the whole trade: the buyer checked the verification count itself, the seller answered the
download with `402 Payment Required` and a price, the buyer signed a payment and sent it back, the seller settled,
and the body's hash was checked against the one on the public record. No account was created and no card was entered
— the node paid with the key it minted in step 1.

The last line says `body already present` rather than a size and a URL because your node is a verifier as well as a
buyer: it had already fetched this file to check it, minutes before it bought it. Holding the bytes was never the
same as owning the knowledge, which is why the purchase still happened. A node that had not verified it downloads it
at that step instead, and either way the hash is checked. The money moved:

```bash
ainize wallet
```

```text
address             0x4079e607370cC79B00c6051204bDb5c67a54FB12
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
overlapping memory entries: law-kr-2026 ∩ law-us-2025 = 600; law-kr-2026 ∩ law-kr-2025 = 600; law-kr-2026 ∩ law-common-base = 600; law-us-2025 ∩ law-kr-2025 = 600; law-us-2025 ∩ law-common-base = 600; law-kr-2025 ∩ law-common-base = 600
ID               NAME                                           MODEL          FACTS  MEMORY ROWS  VERIFIED  TRY
───────────────  ─────────────────────────────────────────────  ─────────────  ─────  ───────────  ────────  ───
law-kr-2026      [synthetic] Korean law revision 2026 (update)  demo-ainize-1b     60        1,200     2/2 ✓  -
law-us-2025      [synthetic] US federal law 2025                demo-ainize-1b     60        1,200     2/2 ✓  -
law-kr-2025      [synthetic] Korean law revision 2025           demo-ainize-1b     60        1,200     2/2 ✓  -
law-common-base  [synthetic] common legal basics                demo-ainize-1b     40        2,000     2/2 ✓  -

ainize chat <ID> "<question>"   or   ainize chat <ID>   for an interactive session   (ainize chat --patch a,b loads up to 3 together)
```

Four rows, and you bought one of them. **The list is of knowledge whose body this node holds, which is not the same
as the knowledge it has bought**: a node with the `verifier` role — the default, and the role your node has had since
step 1 — downloads a body in order to check it, and keeps it. So a knowledge can be testable here and still cost you
money to use. `FACTS` is how many question-and-answer pairs the author published with it, and `TRY` shows one of them
where there is one, so you can start from a question with a known answer. The `overlapping memory entries` line above
the table is a warning about these four in particular: they were generated from one another, they write to many of
the same rows, and loading two of them together means the second one wins where they collide.

A node holding nothing at all answers with one line instead of the table:

```text
no testable patch on this node — its body must be held here (seller node, or `ainize patch buy <id>` first)
```

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

## 9. Stop the nodes

Every node you started is a background process, and each one is stopped by name. If you built the practice network in
step 6, that is three:

```bash
ainize stop
ainize --home ~/nodes/seller stop
ainize --home ~/nodes/checker stop
```

```text
✓ stopped node (pid 766683)
✓ stopped node (pid 766562)
✓ stopped node (pid 766597)
```

Sometimes a line arrives before that one, and it is still a successful stop:

```text
! node 730221 is still running 10 s after SIGTERM — sending SIGKILL
✓ stopped node (pid 730221) — it ignored SIGTERM, so it was killed
```

The ten-second pause is `ainize stop` waiting out a node that did not exit on its own, and a node with peer
connections open sometimes does that on this build.

Each home directory survives; starting a node again picks up the same identity, the same balance and the same
knowledge. Removing a directory destroys that node's key, and with it everything it published — the practice seller
included, which is the tidy way to throw the practice network away when you are done with it.

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
