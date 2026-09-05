---
title: Lineage and royalties
summary: Who gets paid when knowledge built on other knowledge sells — the two-pass split, why 30% and 70% are percentages of different things, and what the arithmetic cannot know.
---

# Lineage and royalties

Two different people can have a claim on a sale that neither of them made. The author of the knowledge this one was
built on, and the person who supplied the questions it was trained from. Ainize pays both out of the price
automatically, from numbers written on the record at publish time — and the two numbers are percentages of different
things, which is the single most misread fact in the product.

## Start with what is off

Building on somebody else's knowledge — training a new lesson on top of a published one, so the child inherits the
parent's rows and questions — is **disabled by default**. `teach.lineage` is `false` on a fresh node and the node
answers `403 lineage_disabled` to any request that names a base.

So today, lineage is not something the teaching pipeline produces. It is something a publisher **declares**: the
`--parents` list on a publish, which says *this was built on that*, and the `--contributor` list, which says *this
person supplied the training data*. Both are credit and money. Neither is a training relation the node checked, and
neither changes how the rows are loaded — apply order stays last-wins, exactly as
[a knowledge patch](./knowledge-patch.md) describes.

That is worth being blunt about, because the arithmetic below is real, running code that pays real addresses, and it
is fed by declarations rather than by measurements.

## Parents are a relation on the anchor, and they are frozen

An anchor — the public record of a published knowledge — carries a `parents` list of knowledge ids and the addresses
of their authors. Anchors are immutable: once announced, the record cannot be edited, only superseded by a newer
knowledge. Whoever was named as a parent at publish time is a parent for the life of the entry, and whoever was not
never becomes one.

Every sale of that knowledge, at any price, for ever, is split according to what was written that day. There is no
renegotiation, no expiry and no consent step on the parent's side: an author who published knowledge others can build
on has already agreed to this by publishing.

## Two passes over one sale

When a knowledge sells, the selling node computes the split before it writes the settle record. It walks the lineage
from the sold anchor upwards, collecting every ancestor it can find in its own catalog, and then divides the price in
two passes.

**Pass one — the lineage pool.** A fixed fraction of the price, `market.royaltyShare` (0.3 by default), is set aside
for the ancestors, and divided **evenly among the unique ancestor authors** — evenly, by author, regardless of how
much of the knowledge any of them contributed or how many ancestors each of them wrote. An author's slice is then
divided evenly among that author's own ancestor anchors, and each anchor's slice is carved for that anchor's
contributors by their shares before the remainder goes to the author. A data provider keeps earning when somebody
builds on the lesson they supplied. If the sold knowledge has no ancestors at all, there is no pool: the fraction is
never set aside.

**Pass two — the seller's side.** What is left, `price − pool`, is the seller's, and out of it the sold anchor's own
contributors are paid. Each contributor's carve is their share **of that fixed remainder** — not of the price, and not
of a remainder that shrinks as each one is paid. `teach.contributorShare` (0.7 by default) is the number the teaching
pipeline writes into a contributor entry when a taught lesson is published, and `--contributor addr:name:share` is the
same field filled in by hand. The seller keeps whatever is left when every carve is done.

## What naming one more parent actually costs

The pool is divided **per author, not per parent**, which has two consequences worth deciding with rather than
discovering afterwards:

- **Naming two knowledges by the same creator costs exactly what naming one costs.** The pool is split by author,
  so a merge of two of Dana's lessons pays Dana the same slice a child of one of them pays her. Combining is free.
- **Naming a second creator halves what the first one gets.** Two authors in the lineage means two equal slices out
  of the same 30 %, whatever either of them contributed.
- **A grandparent can out-earn the direct parent.** Each author's slice is divided among that author's own ancestor
  anchors and then carved for that anchor's data providers — so a parent who declared a data provider keeps less of
  their own slice than a grandparent who declared none.

You do not have to work this out by hand. `ainize publish` prints the split before the draft is announced, the
publish form shows it as you type, and `GET /api/patches/{id}/split?price=…` answers it for any price you are
considering — all three computed by the same `royaltyPlan` that settles the sale.

## A price has a floor, and it is gas

Every sale writes to the chain: one settle record, and — when anyone else is owed a share — one transfer that pays
every creator of that sale together. On a network that charges gas, those writes cost money, and a price below
their cost makes each sale a loss. The default price of `0.1` was chosen for a dev chain that charges nothing.

The node does not guess at this. It measures what its own writes actually cost (`gas_cost_total`, returned on every
write) and warns at publish time when the price is below the measured floor, naming the number of writes and the
average. On a chain that has charged this node nothing, it says nothing at all.

## 30% and 70% are percentages of different things

That is the sentence this page exists to get right, and an arithmetic example is the only way to say it clearly. The
numbers below are from an actual sale on a three-node network run while writing this page — a knowledge priced at
10 CREDIT, with one parent by a different author, and one data provider credited at 0.7:

| Who | Why | Gets |
|---|---|---|
| the parent's author | the lineage pool: `10 × 0.3`, and they are the only ancestor author | **3** |
| the data provider | `0.7` of the seller's side: `0.7 × (10 − 3)` | **4.9** |
| the seller | what is left of their own side | **2.1** |

The data provider is paid more than twice what the seller keeps, and neither number is 70% or 30% of the price. The
lineage share comes off the top; the contributor share is a fraction of what remains afterwards. Both were written on
the record at publish time and neither node was asked to agree to anything at the moment of sale.

The data provider in that example has no node, no software and no account — an address on the record was enough. On a
node using its own credit book the money is simply there, because [the settle record is the balance](./payment.md).

## What the arithmetic refuses to do

The split is computed by the seller's node from records it holds, and it is bounded on every side, because a royalty
walk over anchors written by strangers is exactly the kind of arithmetic that gets attacked.

- **Depth is capped at 16.** A lineage deeper than that stops being walked. Ancestors beyond the cap are not paid.
- **A cycle cannot be constructed.** The sold anchor is never its own ancestor and no anchor is visited twice,
  whatever a hostile record claims about its parents.
- **At most four contributors per anchor, and their shares must sum to at most 1.** This is validated when the draft
  is created and again at publish; for anchors this node did not write, each share is clamped into 0…1 as it is used,
  so a peer's anchor claiming a share of 5 cannot inflate anything.
- **A contributor whose address is the payee is skipped** — a seller does not carve a slice out of their own side to
  pay themselves, and neither does an ancestor author.
- **The total can never exceed the price.** Each carve is bounded by the slice it comes from, and there is one last
  check before any real transfer: if the computed split somehow adds up to more than was received, the node logs an
  error and pays the seller only, rather than distributing money that does not exist.

There is also a limit that is easy to miss and impossible to work around: **the walk can only find ancestors the
selling node knows about.** Lineage is resolved from the anchors in that node's own catalog. If a parent's anchor has
not reached it — a peer it never gossiped with, a record it has not synchronised — that ancestor is not in the walk
and is not paid, and the seller keeps the pool. The record of the sale will say so plainly, since the settle record
lists every address that was paid, but nothing retroactively fixes it.

## Where the money actually goes

The split lands in one field of the settle record: an address-to-amount map, signed and appended by the seller when
the payment clears. What happens next depends on the ledger.

On a node using its own credit book, nothing else happens, because nothing needs to: a balance is derived by reading
the settle records, so writing the record *is* the payment for everyone named in it.

On the AIN chain the seller genuinely owes the other addresses money it has just received. For each non-self address
in the split a payout row is written **before** the transfer is attempted, so a crash between the two leaves a visible
unpaid row rather than a silently missing transfer; a background pass retries failures every 60 seconds up to 20
attempts and then leaves it for the operator. A row that was mid-transfer when the node stopped is never retried
automatically — an operator has to check the chain first — because a duplicate royalty payment is worse than a late
one.

## What it buys, and what it costs

What the design buys is that credit survives the sale. An author whose knowledge somebody else built on, and a person
who supplied the questions but runs nothing, are paid automatically out of every sale by arithmetic anybody can check
against a public record — with no contract, no invoice and no cooperation from the buyer.

What it costs is that the arithmetic is coarse and the declaration is unverified. The pool is split evenly among
ancestor authors, so one row and one thousand are worth the same; the shares are frozen at publish, so a mistake is
permanent; a long lineage dilutes every ancestor; the walk stops at depth 16 and at the edge of the selling node's own
catalog; and above all, `--parents` and `--contributor` are claims a publisher types, not facts the node measured. The
system will faithfully pay whoever was named. It has no way to know whether they deserved it.
