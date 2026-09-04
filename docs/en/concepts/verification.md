---
title: What "verified" proves — and what it does not
summary: An attestation is one node's run, signed and permanent. What the quorum counts, why the author's own check never counts, and where a challenge has teeth.
---

# What "verified" proves — and what it does not

A knowledge for sale on Ainize carries a verification count — `2/2 passed ✓ quorum`. It is the number a buyer looks at
before anything else, and it is worth knowing exactly what it is a count of, because it is narrower than the word
"verified" suggests and it is load-bearing in both directions: nothing sells without it, and it is not a promise that
the knowledge is correct.

## An attestation is one node's run

A verifier fetches the body, checks its sha256 against what the anchor claims, and — if it serves a compatible model —
loads the knowledge into that model, asks the benchmark questions, records what came back, and puts the rows back the
way it found them. Then it writes down what happened and signs it.

That record is an [`Attestation`](../reference/schemas.md#attestation): which knowledge, which body hash, which
benchmark, pass or fail, the score, how it was verified, how many serving restarts it noticed while measuring, when,
and the verifier's signature. It goes on the public record and stays there. Nothing about it is a rating or an
opinion; it is one machine's account of one run, attributable to the key that signed it.

Everything the marketplace says about a knowledge is derived from those records. A node re-reads the ledger, groups
the attestations by verifier and recomputes the status — `ANNOUNCED`, `VERIFYING`, `LISTED`, `REJECTED`, `CHALLENGED`,
`SUPERSEDED` — every time. There is no separate database of verdicts that could disagree with the evidence, and any
node holding the same records reaches the same conclusion.

One verifier gets one voice. A node that attests the same knowledge twice does not count twice: for each verifier a
single attestation is chosen — the first one, upgraded to the first one that actually executed the benchmark, or,
after a challenge, the newest one written since — and the rest are history rather than arithmetic.

## The author's own check never counts

A node refuses to verify knowledge it published itself, and says so before spending a second of GPU time on it:

> cannot verify your own knowledge: `<id>` was published by this node (`verifier.allowSelfAttest` is false).
> A self-check never counts toward the quorum — another node has to verify it.

This is one sentence with several consequences, and they are easy to miss.

The quorum is a count of **independent** attestations. With the shipped default of
[`verifier.quorum: 2`](../reference/config.md#keys), listing a knowledge needs two nodes **besides** the publisher —
three participants, not two. A network of two can never list anything at all, however long it runs; a developer who
starts one node and wonders why their knowledge sits at `0/2` for ever has met this rule and not a bug.

An author's attestation that reached the record anyway — written by a node configured to allow it, or before the
setting was what it is — stays on the record and stops counting the moment another node reads it. It is displayed,
labelled as a self-check, and excluded from every number that decides whether the knowledge lists. The record is
permanent; what it is worth is decided by the reader.

`verifier.allowSelfAttest` exists so a single-machine development node can go through the motions. Turning it on does
not make one node's opinion count anywhere else: every other node applies its own setting to the same records, and on
the default setting the self-check is worth nothing.

## Executed, or integrity only

There are two kinds of attestation and the difference decides everything.

An **executed** attestation means the benchmark ran: the body went into a live model of the right kind, the questions
were asked, the answers were scored. A **hash-only** attestation means the verifier confirmed the bytes — the sha256
matches the anchor, the row count matches — and said so honestly, because it had no compatible model to run anything
on. It is labelled `hash-only` in the record and never dressed up as a score.

The rule that follows is the most important sentence on this page: **a knowledge that declares benchmark samples is
never listed on integrity checks alone.** If the anchor ships questions, somebody has to answer them.

Two knowledges published to a three-node network with no model attached while writing this page make the rule
concrete. Both were attested `PASS`, `hash-only`, by both other nodes within seconds:

| Knowledge | Declares samples | Attestations | Status |
|---|---|---|---|
| four rows, no samples | no | 2 × PASS hash-only | `LISTED` at `2/2` |
| six rows, one sample | yes | 2 × PASS hash-only | `VERIFYING` at `0/2` |

Same network, same verifiers, same second — and the one that asked to be tested was not listed, because nothing had
tested it. This is also why a knowledge can be stuck at `0/2` while its detail page shows two passing attestations:
the count is of attestations that could decide the question, not of attestations.

A verifier that *should* be able to run the benchmark and momentarily cannot — a serving instance restarting, an
engine that just crashed — does not fall back to a hash-only attestation immediately. It waits, retrying, for a grace
period of fifteen minutes before writing the weaker record, and if a compatible model appears later it re-verifies for
real and its executed attestation replaces the hash-only one. The fallback exists so a knowledge is not held hostage
by an unavailable GPU; the grace period exists so it is not weakened by a thirty-second hiccup.

`REJECTED` is the mirror image of `LISTED`: when failing attestations reach the quorum, the entry is rejected on the
same evidence and by the same arithmetic. Nothing is deleted — the anchor and every attestation stay on the record —
but no node will sell it.

## A challenge is a question, not a bond

Anyone can challenge a listed knowledge with a reason. The entry immediately stops being sellable: `CHALLENGED` clears
the flag every buy gate reads, and the node tells the challenger, in as many words, that the knowledge is off sale
"until a verifier re-runs the benchmark and passes it".

Nothing is escrowed, transferred or slashed. There is no bond behind an attestation and none behind a challenge; the
deposit fields left in the data model are dead weight from an earlier design and nothing has ever moved through them.
A verifier's stake is its signature on a permanent public record, and a challenger's stake is the same. That is the
whole of the enforcement, and a page that implied more would be lying.

What a challenge does is re-open the question to the verifiers. They re-run — even a node that has already attested,
which is what makes a challenge answerable in a small network where everyone has attested once already — and the newer
result replaces the older one. If it passes, the entry lists again. If it fails, and the failures reach the quorum,
the entry is rejected.

Which is exactly why a challenge is only as strong as the verification underneath it. For a knowledge that declares
no benchmark samples, "re-run it" means recomputing a sha256 — a check that cannot fail, because the bytes are what
they always were. Measured on a three-node network while writing this page: the challenge was recorded at 11:48:23,
both verifiers re-attested `hash-only` at 11:48:26, and the entry was back to `LISTED` about three seconds after it
was disputed. The challenger's own node was one of the two that cleared it.

> [!IMPORTANT]
> A challenge holds a knowledge off sale only where verification is executed. Against a knowledge that declares no
> samples it lifts itself within seconds, and no amount of reasoning in the `--reason` text changes that. If you want
> a dispute to have teeth, the thing being disputed has to be a measurement — which means the anchor has to ship the
> questions it claims to answer.

The same boundary runs through the whole design: the questions on the anchor are what turns a hash check into a test,
a claim into a measurement, and a complaint into something a stranger can settle.

## What it buys, and what it costs

What the design buys is a claim you do not have to take on trust. Somebody who is not the author, on a machine the
author does not control, loaded the knowledge into a real model, asked it the questions the anchor advertises and
signed what came back. Nobody is voting; nobody is being paid to approve; the evidence is public and anyone can
re-derive the verdict from it.

What it costs is everything outside that sentence. A quorum of two says two nodes agreed, not that they were right,
not that the benchmark is a good one, and not that anyone independent chose the questions — the author picked them.
`verified` means measured, never true. Listing requires a third participant, so the smallest useful network is three
nodes rather than one. And a knowledge that declares nothing to test can be listed, sold and defended by an integrity
check that no evidence could ever contradict.

So read the count as what it is: **somebody independent loaded it into a real model and scored it.** Whether the
score is worth anything is a judgement about the benchmark, and the benchmark is on the anchor for you to read.

Money changes hands only for a knowledge that clears this gate — how, and without an account, is
[paying without an account](./payment.md).
