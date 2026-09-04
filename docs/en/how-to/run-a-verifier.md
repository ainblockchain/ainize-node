---
title: What verifying costs you
summary: Every node created by `ainize init` is a verifier and nothing says what that spends — the disk it fills with other people's files, the model time it takes from your own visitors, and the share of a sale it earns when the knowledge sells at all.
---

# What verifying costs you

`ainize init` gives a new node three roles and prints them in one line:

```text
roles    seller, verifier, serving
```

`verifier` is the middle word, and it is the only one that makes your machine do work for other people. Nothing
warns you, because on this network verification is not a favour: nothing lists anywhere until two nodes that are not
the publisher have checked it. Your node checks other people's knowledge because that is the only way yours is ever
checked.

That is the case for it. This page is the bill.

## What it does, unasked

With `verifier` in `roles` and [`verifier.auto`](../reference/config.md#keys) left at its default `true`, the node
runs a verification round every five seconds. Each round looks for an announced knowledge it has not attested,
**downloads the whole file**, checks its sha256 against the anchor on the public record, and — if the node also
serves a compatible model — loads it, asks the benchmark questions, scores the answers, puts the rows back and
writes a signed [attestation](../concepts/verification.md).

Two knowledges verified on a fresh two-verifier network while this page was written, on a node that had published
nothing and bought nothing:

```text
Disk used  351,683,460 bytes in 2 files — all of it reclaimable
```

Nothing there is its own. One of the two files is 348 MB, because that is how big that knowledge is. A node that has
been running for a week on a busy network is holding hundreds of files it will never use.

## The three costs

**Disk.** The body of everything you attest, kept. `ainize gc --dry-run` says what a clean-up would free, and
`ainize gc` frees it; `--older-than 30d` keeps recent copies in case a challenge sends the same file round again.
Deleted copies are re-fetched if they are needed, so nothing breaks — you are trading disk for bandwidth.

**Your model.** If your node has `serving`, a benchmark run takes the shared runtime lock (labelled `verify:<id>`)
and everything else queues behind it: your own visitors in Live test, your own `ainize chat`, your own loads and
unloads. Several nodes on one machine share that lock, so three demo nodes are one queue. A crashed holder's lease
is broken after fifteen minutes.

**Attention.** A verifier is a party to a public record. Its attestations are signed with the node's key, stay for
ever, and are what a buyer reads before spending money. Getting one wrong is not reversible.

## What it earns

`market.verifierShare` — `0.05` unless you change it — is the fraction of **each sale** that goes to the verifiers
whose attestations counted, split between them. It is paid out of the seller's side automatically, in the settlement
record, at the moment of the sale.

Measured on that same network, on a node that verified one knowledge which then sold three times:

```text
earned from verifying  0.15 CREDIT over 3 sale(s) of knowledge you verified
```

`ainize wallet` is where that line lives; the console shows the same thing under Account. Two things about it are
worth knowing before you plan on the income:

- **Nothing is paid for verifying something that never sells,** and most knowledge never sells. The disk cost is
  certain; the income is not.
- **A hash-only attestation is paid the same as an executed one** when it counts toward the quorum. What decides
  whether it counts is [whether the knowledge declares benchmark samples](../concepts/verification.md), not how hard
  your node worked.

## Turning it off

Two switches, both of which take effect when the node restarts:

```bash
# stop the background rounds; still verify when asked (ainize patch verify)
ainize config set verifier.auto false

# or drop the role entirely
ainize config set roles seller,serving
```

Either prints the same warning, which is worth repeating here:

```text
! the node … is running on http://localhost:3951 and keeps using the value it started with —
  restart it to apply this (`ainize stop` then `ainize start -d`)
```

Then reclaim what the role already cost you:

```bash
ainize gc --dry-run
ainize gc
```

> [!IMPORTANT]
> A network where everyone turns this off publishes nothing. The quorum is two attestations from nodes that are not
> the author, so the smallest network that can list anything is three participants. If you are running a private
> network of your own, turning `verifier` off on two of three nodes will leave every publish sitting at `0/2` for
> ever — which looks exactly like a bug and is not one.

## If you keep it on

- Give it a disk you do not mind filling, and put `ainize gc --older-than 30d` on a weekly timer.
- If the node also serves a model that people use, expect the model to stall while a benchmark runs. A verifier
  with no model still helps: it attests integrity, which is enough to list knowledge that declares no samples.
- Watch `ainize logs` for `verify` events. A verifier that cannot reach the seller's node, or that has no model for
  the knowledge's `id_M`, says so there rather than failing silently.

Related: [what "verified" proves](../concepts/verification.md) for what your attestation is worth to a buyer, and
[when it will not list](./failed-verification.md) for the other side of the same machinery.
