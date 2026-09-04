---
title: Use knowledge someone else published
summary: Find a knowledge on the network, read what its verification is worth, try it for free, pay for it over HTTP 402 and load it into your own model.
---

# Use knowledge someone else published

Somebody else's node has taught a model something yours does not know. This tutorial takes that from the other end: you
find their knowledge in the catalog, read the evidence behind it, try it on your own questions before paying, buy it
without an account or a checkout, and load it into your running model.

Nothing here is a long-lived subscription or an install. A knowledge is one file, bought once, loaded in seconds and
removed just as fast.

## Before you start

**A node of your own.** Buying happens through your node: it holds your identity and your balance, and the file lands
in its blob store. [Installation](../get-started/install.md) sets one up.

**Operator sign-in on that node.** Money commands are the node operator's, not a visitor's. If you have not signed in,
they say so:

```text
error: operator login required — run `ainize login` first
```

```bash
ainize login
```

```text
✓ logged in to http://localhost:3618 (token saved in /tmp/ainize-tut/my-node/cli.json)
```

**A balance in the node's currency.** `ainize wallet` prints it. A local-ledger node starts with credit
(`market.initialCredit`, `100` by default); a node on the AIN ledger pays in AIN and needs a funded address.

**A model, for two of the steps.** Trying a knowledge before buying, and loading it after, both need a serving model
behind your node. Finding, reading and buying do not — a node with no model can do the whole purchase, it just cannot
answer questions.

**Somebody who has published something.** On a network with peers, that is somebody else. This page runs a small
network of its own so it has something to buy: a node called `alice` publishes one knowledge, and `my-node` — yours —
buys it. If your peer already lists something, skip the next section.

### Setting the scene: what alice published

<!-- The seller half is here only so the buyer half has a real transaction to show; the reader's own path starts at step 1. -->
```bash
# on alice's node
ainize publish ./rooms.npz --name "Seoul office facts" --model Qwen3.8-Flash-Next \
  --benchmark ./bench.json --price 2 --description "Where things are and who signs what, for the Seoul office."
```

```text
✓ draft created: seoul-office-facts  (4 rows, sha256 93d2ba5de67f…)
✓ announced seoul-office-facts → ledger record 429eb1569888b8fe… (verifiers will now attest; quorum lists it)
```

That is the whole seller side, and it is a different tutorial —
[Teach from a file of questions](./teach-from-a-file.md) makes the file, and
[Set a price and get paid](../how-to/price-knowledge.md) is the money. From here on, everything runs on your node.

## 1. Find it

The catalog is the same on every node that has heard the announcement, because it is derived from the public record
rather than served from anybody's database:

```bash
ainize patch ls --q office
```

```text
ID                  STATUS  AUTHOR             MODEL               ROWS   SIZE     PRICE  ATTEST  SOLD  BENCHMARK
──────────────────  ──────  ─────────────────  ──────────────────  ────  ─────  ────────  ──────  ────  ──────────────────
seoul-office-facts  LISTED  alice 0xd7eb…DDcc  Qwen3.8-Flash-Next     4  978 B  2 CREDIT     2/2     0  aster/office-facts
```

Three of those columns decide whether a knowledge is usable by you at all.

**`MODEL`** is the model the knowledge was made for. A knowledge is rows of one specific model's memory table; it does
nothing in a different model, and your node will not load it into one. [What a knowledge patch
is](../concepts/knowledge-patch.md) explains why that is a property of the design rather than a missing feature.

**`STATUS`** and **`ATTEST`** are the same fact twice: `LISTED` with `2/2` means two independent nodes checked it and
the network's quorum is satisfied. `VERIFYING` with `1/2` means it is not for sale yet.

`--q` searches text; `--status`, `--model`, `--author` and `--schema` filter; `--sort price|rows|popular|latest`
orders. The same catalog is a page on any node's site — `http://localhost:3618/explore` — with the same rows and a
search box.

## 2. Read what is behind the number

```bash
ainize patch get seoul-office-facts
```

```text
Seoul office facts  LISTED
id                 seoul-office-facts
author             alice 0xd7ebABa48Fd05665A40457d93cd2445DbD69DDcc
model              Qwen3.8-Flash-Next
rows / size        4 rows · 978 B
sha256             93d2ba5de67faeb58ced013bd359653497dd1ab8aaacf498de917bdd15a29262
price              2 CREDIT · per_download
benchmark          aster/office-facts · 4 queries · template
benchmark hash     a696db825c63e591a4b74beb2837ae689163beb44c54777815d222ddacab7f1a
topic              patches/qwen3-8-flash-next
branch             -
gateway            http://localhost:3619/x402/patch/seoul-office-facts
verification       2/2 passed ✓ quorum
sold               0 · revenue 0 CREDIT
created            2026-09-04 11:58:02
body on this node  yes
Where things are and who signs what, for the Seoul office.
attestations
VERIFIER               RESULT  SCORE                                                                                   VERIFIED ON  RESTARTS  COUNTS  AT
─────────────────────  ──────  ──────────────────────────────────────────────────────────────────────────────────────  ───────────  ────────  ──────  ───────────────────
my-node 0xa57b1F…06D2  PASS    integrity=sha256 ok rows=4 benchmark=not executed (no compatible runtime on this node)  hash-only           0  yes     2026-09-04 11:58:06
carol 0xadadae…EE09    PASS    integrity=sha256 ok rows=4 benchmark=not executed (no compatible runtime on this node)  hash-only           0  yes     2026-09-04 11:58:28
lineage
  parents : none (root)
  children: none
```

**Price.** `2 CREDIT · per_download` — a price and what it buys. Money is a decimal string everywhere in this product,
never a JSON number, so `2` here is exactly two.

**Verification.** `2/2 passed ✓ quorum` is a count of *independent* attestations: the author's own never counts, and
each verifier gets one voice. The attestations table below it is the evidence — who, when, pass or fail, and how.

**`VERIFIED ON`** is the column to read before you trust the row above it. `hash-only` means that verifier confirmed
the file is exactly what the record says it is, and did not run the questions, because it has no compatible model.
An *executed* attestation carries a score instead. Both are honest; they prove different things, and
[what "verified" proves](../concepts/verification.md) is the page that draws that line properly. Two `hash-only`
attestations mean two nodes agree about the bytes — not that anybody scored the knowledge.

**`body on this node`** says whether your node already holds the file. It says `yes` here because this node is also a
verifier and fetched the file to check it. Holding the bytes is not owning the knowledge — you still buy it.

**Lineage** is what this knowledge was built on. Everything an ancestor's author is owed comes out of every sale,
automatically; [Lineage and royalties](../concepts/lineage-and-royalties.md) is the arithmetic.

Two more blocks appear when there is anything to show, and both matter to a buyer. **`address-set overlaps`** lists
other knowledge that touches the same memory entries — two of them loaded together will fight over those rows, and the
last one loaded wins:

```text
address-set overlaps (A₁ ∩ A₂)
PATCH                              SHARED ROWS  SAME SCHEMA                  STATUS
─────────────────────────────────  ───────────  ───────────────────────────  ──────
seoul-office-facts-after-the-move            2  yes → conflicting knowledge  LISTED
```

`same schema: yes → conflicting knowledge` is the strong form: another knowledge answers the same benchmark's questions
from the same rows, which usually means it is a competing or newer version of this one. **`settlements`** is every
sale, with the tx hash and what went to whom.

## 3. Try it before you pay

Every node lets a visitor ask a listed knowledge's questions for free, before and after it is loaded. From a terminal,
first see what this node can test:

```bash
ainize chat --list
```

```text
runtime unavailable — serving API unreachable  (chat needs a serving node; pass --node <url> of one)
ID                  NAME                MODEL               FACTS  MEMORY ROWS  VERIFIED  TRY
──────────────────  ──────────────────  ──────────────────  ─────  ───────────  ────────  ───
seoul-office-facts  Seoul office facts  Qwen3.8-Flash-Next      4            4     2/2 ✓  -
```

The first line is the precondition, and on this node it is not met: no model, no live test. Point the CLI at a node
that has one (`--node http://…`), or use the seller's own site, where every knowledge has a **Live test** page at
`/chat/<id>`.

<!-- unverified: needs a model runtime — the live test itself could not be run: on the node this page was recorded on the runtime line read `unavailable`, so `ainize chat <id> "<question>"` refused at the gate above. What the two answers look like, and the 429 below, are read from packages/cli/src/commands/chat.ts and packages/node/src/api.ts rather than pasted. -->
With a model behind the node, the test is one command:

```bash
ainize chat seoul-office-facts "Which meeting room has the video wall?"
```

It asks the model twice — once as it is, once with the knowledge loaded — and prints the two answers side by side, plus
whether the second one matches what the benchmark expects. `--mode base` or `--mode patched` asks only one of them;
with no question it opens an interactive session; `--patch a,b` loads up to three knowledges together, in order, the
last one winning where they overlap.

The free test is metered per visitor: **20 live tests an hour**. When they are gone the node says so and the number
resets within the hour:

```text
quota_chat: free live-test quota exhausted for this hour — buy the patch or run your own node
```

That is HTTP `429`, and it is not a wall you can push through — it is the reason the test is free at all.

## 4. The refusal you will probably hit first

The one-line path from catalog to loaded model is `ainize use`. Run it too early and it refuses:

```bash
ainize use seoul-office-facts
```

```text
error: seoul-office-facts is VERIFYING (verification 1/2) — not verified yet; try `ainize patch get seoul-office-facts`
```

This is not a bug and not a delay you can pay to skip. A knowledge is for sale only once independent nodes have
attested to it — `1/2` means one has, and the default quorum is two. On a network that has just started, or one whose
other nodes have no compatible model, this is where you wait. `ainize patch records <id>` shows exactly who has
attested and when, and [When it will not list](../how-to/failed-verification.md) is what to do when the count is stuck.

`use` refuses two other states for reasons worth knowing: a `CHALLENGED` knowledge is off sale until a verifier re-runs
it (the message names the challenger and their reason), and a `REJECTED` one failed verification.

## 5. Buy it

With the quorum satisfied, the same command goes all the way through. Before it spends anything it prints the quote —
the price, the seller, what this knowledge needs underneath it and what the whole purchase costs — and asks. On a
terminal that is a `[y/N]`; in a script, pass `--yes` (a pipe with no `--yes` is refused, not taken as a yes) and
`--max-price <n>` to put a ceiling on the total. A quote from a node of this tutorial's shape looks like this:

```text
seoul-office-facts · Seoul office facts  2 CREDIT
  seller alice 0xd7ebABa4…DDcc · 118 rows · qwen3-8b
  balance 100 → 98 CREDIT
  CREDIT is issued by this node (1/100 addresses funded with 100 each) for trying the market out — it is not money and it is worthless anywhere else
Pay 2 CREDIT? [y/N]
```

The last line is the one that matters: the credit is issued by your own node for trying the market out. On an AIN node
the same block shows your AIN balance, and the transfer that follows is real.

Here is the whole thing, with the balance before and after:

```bash
ainize wallet
ainize patch buy seoul-office-facts
ainize wallet
```

```text
address             0xa57b1F1E15D12d2f4691B48672eaB091651B06D2
ledger              local · local
balance             100 CREDIT
sales               0
royalties received  0
purchases           0
royalty payouts owed  none pending

✓ bought seoul-office-facts for 2 (local-credit)  tx 1abf37b57e9a70b7…
  +    0ms  quorum    2 attestation(s) ≥ quorum 2
  +    9ms  402       Payment Required: 2 CREDIT → 0xd7ebABa4… (local-credit)
  +   13ms  pay       signed credit intent 1abf37b57e9a70…
  +   88ms  settled   seller confirmed; manifest sha256 7877a25ffc70c0…
  +   90ms  download  body already present; sha256 matches on-ledger anchor
  body: /tmp/ainize-tut/my-node/data/blobs/93d2ba5de67faeb58ced013bd359653497dd1ab8aaacf498de917bdd15a29262.npz

address             0xa57b1F1E15D12d2f4691B48672eaB091651B06D2
ledger              local · local
balance             98 CREDIT
sales               0
royalties received  0
purchases           1
royalty payouts owed  none pending
```

Five steps, and each one is a thing that had to be true.

**`quorum`** — your node re-derives the verification count from the public record before spending anything. It does not
take the seller's word for it.

**`402`** — the seller's node answered the download request with HTTP 402 Payment Required, carrying the price, the
address to pay and the scheme. A 402 here is a quote, not an error.

**`pay`** — your node signed a payment for exactly that quote and retried the same URL with it attached. There was no
account, no checkout, no card: the signature is the authorisation. This is the x402 flow, and
[Paying without an account](../concepts/payment.md) is how it works underneath.

**`settled`** — the seller accepted the payment and wrote a `settle` record. That record is your receipt and it is on
the public record, not in an email.

**`download`** — the body, checked against the sha256 in the anchor before it is stored. Here it says *already present*
because this node had fetched the file earlier, when it verified it; a node seeing the file for the first time
downloads it at this step, and either way the hash is checked against the record.

The transaction as the ledger has it:

```bash
ainize patch records seoul-office-facts
```

```text
AT                   KIND    AUTHOR           HASH               SIG/TX
───────────────────  ──────  ───────────────  ─────────────────  ─────────────────
2026-09-04 11:58:02  anchor  0xd7ebABa4…DDcc  429eb1569888b8fe…  0xb2ad36f8ce071e…
2026-09-04 11:58:06  attest  0xa57b1F1E…06D2  34226982d5fdc4d8…  0x19e795df08e782…
2026-09-04 11:58:28  attest  0xadadaed0…EE09  f2156f8c3e62feca…  0xfba563c83e4283…
2026-09-04 11:58:54  settle  0xd7ebABa4…DDcc  1715c6c54d8dfce9…  0x22b673a474f7c6…
```

Four records, four events: alice registered it, two nodes attested to it, and one sale settled. Anybody can read them.

`ainize use <id>` is the same purchase with the checks and the loading attached — it verifies the status, buys if you do
not already own it, downloads and applies:

```bash
ainize use seoul-office-facts-after-the-move --no-apply
```

```text
✓ bought seoul-office-facts-after-the-move for 3 (local-credit)  tx 3f40632fafb86f83…
  +    0ms  quorum    2 attestation(s) ≥ quorum 2
  +    9ms  402       Payment Required: 3 CREDIT → 0xd7ebABa4… (local-credit)
  +   13ms  pay       signed credit intent 3f40632fafb86f…
  +   57ms  settled   seller confirmed; manifest sha256 d93a89bec39c49…
  +   60ms  download  body already present; sha256 matches on-ledger anchor
  body: /tmp/ainize-tut/my-node/data/blobs/e7a51f70e7d0b94a167c8356f5d99bbbf04f4f1a9b98891b684fe86eebd3bd87.npz
✓ downloaded — load with: ainize patch apply seoul-office-facts-after-the-move
```

Run it twice and nothing is bought twice:

```text
✓ seoul-office-facts is already on this node (purchased)
```

### When it is an add-on: buying the knowledge underneath it

Some knowledge is an **add-on**: it was trained on top of another creator's knowledge and its rows only mean anything
with that one loaded underneath. The quote lists what it needs, with the price and the seller of each, and before it
takes any money the command asks:

```text
  needs krx-all-2761 · KRX tickers  25 CREDIT from alice
  total 30 CREDIT (this knowledge + 1 base it cannot work without)
seoul-office-facts also needs KRX tickers (25 CREDIT); buy both? [y/N]
```

Answer `y` (or pass `--bundle` in advance) and both are bought — the base first, then the add-on, one payment and one
settlement each — and the receipt lists them in that order with the total that actually moved. Answer `n` and only the
add-on is bought; the command says so, because a delta on its own will not answer anything until its base is loaded
under it. `--yes` never buys more than you asked for: it answers the *price* question, not this one, so an unattended
script that wants the family passes `--bundle` as well.

The creators of the base are paid twice over: once for their own sale, and again out of every sale of anything built
on top of them (`ainize patch tree <id>` prints that line, and
[Lineage and royalties](../concepts/lineage-and-royalties.md) is the rule).

<!-- unverified: needs a two-node family — the tutorial's node has no add-on published on it. The quote lines, the
question and the ordering are read from packages/cli/src/commands/patch.ts (printQuote, patchBuy) and proved end to
end on a private cluster by packages/e2e/scripts/bundle-buy-proof.mjs (AZ-313, AZ-315). -->

### If the money leaves and the file does not arrive

A purchase is two round trips — the payment, then the manifest — and the second one can be lost: a proxy times out, the
seller restarts, your node dies between them. The money is gone and the body is not here. **Do not buy it again.** Your
node wrote the payment down before it presented it, and the seller will hand over the same manifest again for the same
payment, free:

```bash
ainize patch download seoul-office-facts
```

```text
✓ collected a-base — no payment (paid 5 CREDIT, tx 7766f2ff036ca4f1…)
  +    0ms  pending     presenting the payment made on 2026-09-04T16:39:48.358Z (5 CREDIT, tx 7766f2ff036ca4…) again
  +   17ms  settled     seller re-issued the manifest against the payment already made — nothing was charged
  +   19ms  download    body already present; sha256 matches on-ledger anchor
```

(That trace is from a two-node test where a proxy in front of the seller settled the payment and dropped the response;
the ids are that test's, not this tutorial's.) The same command brings a body back that you deleted with
`ainize patch forget`, or that never downloaded: your settlement on the public record is what unlocks it, and any peer
holding the bytes will serve them to the address that paid. `ainize wallet` and `GET /api/me/pending-payments` list
payments that are still waiting for their file.

## 6. Load it into your model

Buying gets you the file. Loading it is a separate step, it needs the serving model, and it is instant — no restart, no
reload, no downtime for anything else the model is doing.

Without a model behind the node, the step says exactly that:

```bash
ainize patch apply seoul-office-facts
```

```text
error: serving API unreachable
```

What is loaded into the model, bottom first, is its own command. It answers on a node with no model too, because a
node with no model has loaded nothing:

```bash
ainize patch stack
```

```text
nothing is loaded in the serving model
```

<!-- unverified: needs a model runtime — nothing below this line could be exercised: with the runtime unavailable no patch was ever applied, so no stack with layers in it, no `--with-base`, no `remove`, no `--cascade` and no 503 was seen. The behaviour described is read from packages/node/src/runtime.ts and packages/node/src/api.ts. -->
With a model behind the node, `apply` writes the knowledge's rows into the live memory table and records what was
underneath, so it can be put back. Once something is loaded, each layer of `patch stack` prints its id, its row count,
whether it is a stand-alone build or an add-on that needs other knowledge underneath it, and whether it can be unloaded
cleanly. The last line is on top: **it wins on any row two layers share**, which is why the overlaps table in step 2 is
worth reading before you stack two knowledges that touch the same rows.

Three flags cover the rest of the stack's life:

| Command | What it does |
|---|---|
| `ainize patch apply <id> --with-base` | Also loads everything this knowledge was trained on top of, underneath it, in the right order. An add-on without its base is not the thing that was verified. |
| `ainize patch remove <id>` | Unloads it and puts back whatever it displaced, from the journal written at apply time. |
| `ainize patch remove <id> --cascade` | Also unloads everything loaded that was built on top of it. Without `--cascade` that removal is refused — `has_dependents: … is loaded on top of … and would stop working` — because an add-on without its base is not the thing that was verified. |

One error is worth recognising on sight, because it is temporary and not your fault:

```text
503  shared runtime busy   retry-after: 30
```

Several things share one serving model — live tests, teach-mode checks, another operator's apply — and they take it in
turns under a lock. The node is telling you to come back in thirty seconds, not that anything is broken.

## Where to go next

You now own a knowledge, and the model answers your questions differently with it loaded. Two directions from here.

To understand what you just bought and why it can be swapped in and out of a running model,
[What a knowledge patch is](../concepts/knowledge-patch.md); to know what the `2/2` on it is actually worth,
[What "verified" proves](../concepts/verification.md).

To publish knowledge of your own, [Teach from a file of questions](./teach-from-a-file.md) starts from a file of
questions and ends at a lesson you can sell, and
[Teach by correcting the model](./teach-in-chat.md) starts from a wrong answer in a browser.

Every command on this page is in the [CLI reference](../reference/cli.md#ainize-patch); the messages it prints when
something goes wrong are in the [error reference](../reference/errors.md#codes).
