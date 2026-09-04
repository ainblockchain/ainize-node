---
title: When it will not list
summary: Reading the attestation record, the three reasons an entry sits at VERIFYING, what the hash-only fallback does and does not list, and what a challenge is really worth.
---

# When it will not list

You announced a knowledge and it is still not for sale. Before changing anything, read what the record already
says: almost every case is decided by two commands, and the fix is different for each cause. This page assumes you
know what an [attestation and a quorum are](../concepts/verification.md); it is about reading them when they are not
adding up.

The output below comes from three throwaway nodes on one machine — a seller on port 3634 and two verifiers on 3635
and 3636 — with no model server anywhere, which is exactly the situation that produces most of these states.

## Read the evidence first

`ainize patch get <id>` gives the count and the attestations behind it:

```bash
ainize patch get harbour-codes
```

```text
verification       2/2 passed ✓ quorum

attestations
VERIFIER                 RESULT  SCORE                                                                                   VERIFIED ON  RESTARTS  COUNTS  AT
───────────────────────  ──────  ──────────────────────────────────────────────────────────────────────────────────────  ───────────  ────────  ──────  ───────────────────
verifier1 0x6dEb3A…4d23  PASS    integrity=sha256 ok rows=4 benchmark=not executed (no compatible runtime on this node)  hash-only           0  yes     2026-09-04 11:51:42
verifier2 0x99b6B4…d4C7  PASS    integrity=sha256 ok rows=4 benchmark=not executed (no compatible runtime on this node)  hash-only           0  yes     2026-09-04 11:51:46
```

Three columns carry the diagnosis. **RESULT** is what that verifier concluded. **VERIFIED ON** is how it concluded
it: `hash-only` means it checked the file's sha256 and row count and nothing else, because it had no model that
could run the benchmark. **COUNTS** answers one narrow question only — whether this node excluded the attestation as
a self-check by the author. It does not promise the attestation counts toward the quorum; the verification line at
the top is the only number that says that.

`ainize patch records <id>` is the same story as a timeline, which is what you want when the order matters:

```bash
ainize patch records harbour-codes
```

```text
AT                   KIND       AUTHOR           HASH               SIG/TX
───────────────────  ─────────  ───────────────  ─────────────────  ─────────────────
2026-09-04 11:51:41  anchor     0xd87230db…78c9  837a478f4c95d3fc…  0x8abecfef1039dc…
2026-09-04 11:51:42  attest     0x6dEb3Aa0…4d23  bd5dfcbd3436ddd4…  0x75287fad3328c0…
2026-09-04 11:51:46  attest     0x99b6B478…d4C7  7493b0b87ffa9613…  0x184fcf3033d839…
2026-09-04 11:52:57  settle     0xd87230db…78c9  c8a3603ab642f833…  0xb714f6c09dca55…
2026-09-04 11:55:42  challenge  0x6dEb3Aa0…4d23  1b7e99f658b719d2…  0x843c42838fee74…
2026-09-04 11:55:46  attest     0x99b6B478…d4C7  1e75778bdbad9afc…  0xdf03b36af8830c…
```

An empty attestations block with an `anchor` row and nothing after it means no verifier has ever looked. That is a
different problem from a verifier that looked and could not decide.

## LISTED is a conclusion, not a fact

Every node derives the catalogue itself, from the same records, using **its own** `verifier.quorum`. Two nodes can
therefore disagree about the same knowledge, and both be right.

Here the seller's quorum was raised to 3 while its peers kept the default 2:

```text
seller's view                                                    ATTEST
berth-allocations  VERIFYING   …                                   2/3
harbour-codes      VERIFYING   …                                   2/3

verifier1's view, same records                                   ATTEST
berth-allocations  LISTED      …                                   2/2
harbour-codes      LISTED      …                                   2/2
```

This matters because the seller's own node is the one that runs the payment gateway. Ask it for a knowledge it does
not consider listed and it locks the sale, whatever the buyer's node thinks:

```bash
curl -s http://localhost:3634/x402/patch/berth-allocations
```

```text
{"error":"patch not listed yet (verification 2/3)"}
```

> [!NOTE]
> `ainize patch buy` and `ainize use` report this as `error: gateway error 423` and drop the sentence explaining
> why. When a purchase fails with 423 and you want the reason, ask the gateway URL directly — it is on the `gateway`
> line of `ainize patch get`, and it is built from the seller's [`publicUrl`](./reachable-node.md#host-binds-publicurl-is-what-peers-write-down).

So the first thing to check when an entry looks stuck is *whose* view you are reading. `ainize config get
verifier.quorum` on the node you are asking answers it.

## The three reasons it sits at VERIFYING

**Nobody has attested at all.** The entry stays `ANNOUNCED`, `patch records` has one `anchor` row, and `patch get`
shows no attestations block. With both verifier nodes stopped, a fresh announcement looked like this for as long as
they stayed down:

```text
ID           STATUS     AUTHOR              MODEL               ROWS   SIZE     PRICE  ATTEST  SOLD  BENCHMARK
───────────  ─────────  ──────────────────  ──────────────────  ────  ─────  ────────  ──────  ────  ───────────
quay-depths  ANNOUNCED  seller 0xd872…78c9  Qwen3.8-Flash-Next     4  978 B  1 CREDIT     0/2     0  quay-depths
```

Check the ROLES column of `ainize nodes`: you need peers that carry `verifier`, and you need them
[reachable](./reachable-node.md#telling-not-peered-from-peered-and-silent). Bring
one back and the attestations arrive within a couple of gossip rounds — the same anchor, untouched, picked up
sixty seconds later:

```text
2026-09-04 12:07:42  anchor  0xd87230db…78c9  c9c3a4695d8510d1…  0xbd30ff9b28cf4c…
2026-09-04 12:08:43  attest  0x6dEb3Aa0…4d23  e8686bfe7d67e8e9…  0x9e705a7030a202…
2026-09-04 12:08:45  attest  0x99b6B478…d4C7  911d61b6a80a2467…  0xc1e6f9b872a3f4…
```

**The only attester is you.** A node refuses to verify its own knowledge before it spends a second on it:

```bash
ainize patch verify harbour-codes
```

```text
error: cannot verify your own knowledge: harbour-codes was published by this node (verifier.allowSelfAttest is
false). A self-check never counts toward the quorum — another node has to verify it.
```

If an attestation by the author is already on the record — written by an older build, or by a node with
`verifier.allowSelfAttest` turned on — every other node still discards it. `patch get` keeps the row, marks it in the
COUNTS column and says so again on the verification line:

```text
verification       2/2 passed ✓ quorum · 1 self-check by the author (not counted)

attestations
VERIFIER                 RESULT  SCORE                                                                                   VERIFIED ON  RESTARTS  COUNTS           AT
───────────────────────  ──────  ──────────────────────────────────────────────────────────────────────────────────────  ───────────  ────────  ───────────────  ───────────────────
seller 0xd87230…78c9     PASS    integrity=sha256 ok rows=3 benchmark=not executed (no compatible runtime on this node)  hash-only           0  no — self-check  2026-09-04 12:11:59
verifier2 0x99b6B4…d4C7  PASS    integrity=sha256 ok rows=3 benchmark=not executed (no compatible runtime on this node)  hash-only           0  yes              2026-09-04 12:11:59
verifier1 0x6dEb3A…4d23  PASS    integrity=sha256 ok rows=3 benchmark=not executed (no compatible runtime on this node)  hash-only           0  yes              2026-09-04 12:12:02
```

There is no fixing this from your own machine: the count has to come from somebody else.

**The quorum is larger than the network.** `verifier.quorum` defaults to 2 and means *two nodes besides you*, so
listing anything needs three nodes in total. Running two and wondering why nothing ever lists is the commonest
version of this. Either add a node, or lower the quorum on the nodes that are reading — and be honest with yourself
about what a quorum of 1 is worth.

One more state worth recognising: `REJECTED`. That is not a stall, it is an answer. It appears once *failing*
attestations reach the quorum — that many independent verifiers wrote a FAIL, because the file did not match the
anchor's hash or because the benchmark did not pass. Republishing the same body will produce the same result.

## The grace window, and why hash-only lists some knowledge and not others

A verifier that is configured with a model but cannot reach one does not immediately fall back to a weaker check. It
retries, counting down out loud, for fifteen minutes:

```bash
ainize logs --kind verifier
```

```text
2026-09-04 11:52:22 warn  verifier  [tide-tables] verify tide-tables failed: runtime unavailable (serving API unreachable) — waiting up to 15 min before hash-only fallback
2026-09-04 12:06:57 warn  verifier  [tide-tables] verify tide-tables failed: runtime unavailable (serving API unreachable) — waiting up to 0 min before hash-only fallback
```

The window exists so that a serving restart in the middle of a verification round does not permanently downgrade
somebody's knowledge to an integrity check. When it runs out, the verifier writes what it can actually stand
behind: sha256 and row count, labelled `hash-only`.

What happens next depends on one thing — **whether the anchor declares benchmark samples.**

A knowledge with no samples is only ever making a claim about its own bytes, so integrity checks are a complete
answer and the quorum fills:

```text
harbour-codes  LISTED  …  2/2
```

A knowledge that declares samples is claiming the model answers particular questions differently afterwards. No
number of hash checks can establish that, so hash-only attestations are recorded and never counted. This entry has
two passing attestations and a verification count of zero:

```bash
ainize patch get tide-tables
```

```text
Busan tide tables  VERIFYING  (yours)
…
benchmark          tide-tables · 2 queries · template
verification       0/2 passed

attestations
VERIFIER                 RESULT  SCORE                                                                                   VERIFIED ON  RESTARTS  COUNTS  AT
───────────────────────  ──────  ──────────────────────────────────────────────────────────────────────────────────────  ───────────  ────────  ──────  ───────────────────
verifier2 0x99b6B4…d4C7  PASS    integrity=sha256 ok rows=6 benchmark=not executed (no compatible runtime on this node)  hash-only           0  yes     2026-09-04 12:07:06
verifier1 0x6dEb3A…4d23  PASS    integrity=sha256 ok rows=6 benchmark=not executed (no compatible runtime on this node)  hash-only           0  yes     2026-09-04 12:07:07
```

`0/2 passed` under two PASS rows is not a contradiction: `PASS` is each verifier's answer to the question it could
actually ask, and neither of them asked the one that matters here. The entry will stay at `VERIFYING` for as long
as no verifier with the right model runs the benchmark. Waiting will not fix it.

The fix is to get the knowledge in front of a verifier that has the model. The SCORE column names the obstacle
precisely — `no compatible runtime on this node` — and a verifier only counts as compatible when the model it is
serving matches the anchor's model id. So: check the `model` line of `ainize patch get` against the `MODEL` column
of `ainize nodes`, and peer with a node that runs it.

> [!TIP]
> This cuts both ways when you publish. Declaring benchmark samples is what makes a verification mean something —
> and it is also what stops a knowledge listing on a network where nobody is serving your model. Choose it
> deliberately, not by accident.

## From the other side: challenging something

A challenge is a verifier's public objection, and it takes the knowledge off sale everywhere:

```bash
ainize patch challenge harbour-codes --reason "row 3 answers a question the benchmark never asks"
```

```text
✓ challenge recorded for harbour-codes: row 3 answers a question the benchmark never asks
✓ harbour-codes is off sale until a verifier re-runs the benchmark and passes it; the author is told who challenged it and why
```

The author is told, in their own log:

```text
[2026-09-04T11:55:43.526Z] WARN  challenge: 0x6dEb3Aa0… challenged your knowledge harbour-codes: "row 3 answers a
question the benchmark never asks" — it is off sale until a verifier re-runs the benchmark and passes it
```

and any buyer is turned away with the reason:

```text
error: harbour-codes is CHALLENGED — a verifier disputes it, so it is not for sale until it is re-verified
  0x6dEb3Aa0…4d23: "row 3 answers a question the benchmark never asks" (2026-09-04 11:55:42)
  see the dispute: ainize patch get harbour-codes
```

Now the part to be clear-eyed about. **Nothing is escrowed, transferred or slashed by a challenge** — not by the
challenger, not by the author. Its whole force is the hold, and the hold lasts until any verifier writes an
attestation newer than the challenge. On a knowledge whose verification is a sha256 check, that re-run cannot fail.
In the record above, the challenge landed at 11:55:42 and the answering attestation at 11:55:46: four seconds
later the entry was back to `LISTED`, with the challenge kept on the record and marked `answered`.

```text
challenges
CHALLENGER       REASON                                             OPEN      AT
───────────────  ─────────────────────────────────────────────────  ────────  ───────────────────
0x6dEb3Aa0…4d23  row 3 answers a question the benchmark never asks  answered  2026-09-04 11:55:42
```

So a challenge has real teeth exactly where verification is executed — where somebody's model can actually run the
samples and disagree. Everywhere else it is a permanent, signed, public note of objection, which is not nothing,
but it is not a hold.

## When superseding beats arguing

If you are the author and the objection is right, the shortest route is usually not a defence. Publish a corrected
knowledge that touches the same addresses on the same benchmark schema. Nothing else is needed: the node notices the
overlap when the new entry lists, writes a `supersede` record and tells the author.

```bash
ainize publish ./harbour2.npz --name "Busan port-call codes (2026 revision)" \
  --model Qwen3.8-Flash-Next --benchmark ./bench.json --id harbour-codes-2026 --price 2
ainize logs --kind publish
```

```text
2026-09-04 12:10:51 info  publish   [harbour-codes-2026] announced harbour-codes-2026 (conflicts: 1)
2026-09-04 12:10:56 info  publish   [harbour-codes-2026] harbour-codes-2026 supersedes harbour-codes (4 shared rows)
2026-09-04 12:10:56 warn  publish   [harbour-codes] harbour-codes-2026 supersedes your knowledge harbour-codes — buyers now see "Newer version available" on it
```

Five seconds elapsed between the announcement and the supersede, because the supersede is written when the new entry
reaches its quorum, not when it is announced. Afterwards each side points at the other:

```bash
ainize patch conflicts harbour-codes-2026
```

```text
PATCH          SHARED ROWS  SAME SCHEMA  STATUS
─────────────  ───────────  ───────────  ──────────
harbour-codes            4  yes          SUPERSEDED
```

The old entry keeps its record, its attestations and every sale it already made; buyers simply see that there is
something newer. That is the whole mechanism: correcting knowledge *is* publishing knowledge. There is no edit, and
there is nothing to win by arguing about a record everyone can already read.
