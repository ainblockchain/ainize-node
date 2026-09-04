---
title: What a knowledge patch is
summary: Three arrays over a model's memory table — why a row is an address rather than a sentence, why it can be loaded into a model that is already running, and what that design costs.
---

# What a knowledge patch is

A knowledge patch is a file, and a small one. The four-row example used while these pages were being written is 978
bytes. It is not a model, not a document and not a prompt: it is a list of places in the serving model's memory and
the values that should be there instead. Everything else in Ainize — the price, the verification, the royalties — is
bookkeeping around that file.

This page explains what is inside it, why it can go into a model that is already answering questions, and what the
design costs. Nothing here is a command; the pages that run one are elsewhere in the navigation.

## Three arrays and nothing else

The body of a knowledge patch is a NumPy `.npz` — a zip holding three arrays:

| Member | Type | Meaning |
|---|---|---|
| `addrs` | `int64[N]` | which rows of the model's memory table this knowledge touches |
| `before` | `float32[N, D]` | what those rows held when the knowledge was trained |
| `after` | `float32[N, D]` | what they should hold once it is loaded |

`N` is the row count the marketplace shows on every listing. `D` is the width of one row, fixed by the model — 160
values on the model these pages were written against.

Carrying `before` as well as `after` is what makes the file self-describing rather than a blind overwrite. A patch can
be asked, without writing anything, whether the table in front of it is the one it was trained on; it can be undone;
and two patches can be compared row by row without either of them being loaded. Nothing outside the file is needed to
answer those questions.

The reader is deliberately lazy about it. Row count, row width and the address set are read from the `.npy` headers
alone, so inspecting a 350 MB patch costs no more than inspecting a 1 KB one — which is why a node can pre-check a
stranger's knowledge against its own before it agrees to hold a copy.

## A row is an address, not a sentence

The model these pages were written against keeps a large n-gram memory table: 320,001,536 rows of 160 bfloat16 values,
sharded across the checkpoint. Each token position in a prompt reads sixteen of those rows — eight addressed by that
token and the one before it, eight by that token and the two before it — and each address is a hash of those tokens
with constants baked into the checkpoint and never trained. The rows are the part of the model that can hold a fact about
one particular sequence of words without any other part of the model changing.

So `rows` counts memory entries, not statements. One fact touches every address its wording hashes to, which is
several; and two facts that share an n-gram share an address whether or not they have anything to do with each other.
That is why "four rows" and "one fact" are both true of the same file, and why the row count on a listing is a
**size** and never a score. A knowledge with fifty thousand rows is bigger to store and slower to load than one with
four. It does not follow that it knows more, and no part of the product treats it as if it did.

The same arithmetic is where conflict comes from, which is the subject of two sections further down.

## Loading it into a model that is already running

The serving model is a running process with the table in memory. Ainize does not restart it, reload a checkpoint or
swap an adapter. It hands the rows to a hook that is already inside the process.

The exchange is a directory. The node writes a request file naming the addresses and the values into a mailbox
directory the serving instance watches; a daemon attached to the process performs the read or the write and drops an
acknowledgement file back, carrying the values that were displaced. A read is one round trip through that directory;
a write is one round trip that returns the previous contents. There is no HTTP endpoint for it and no downtime,
because nothing is being restarted: the values in the live table are simply different afterwards.

Because the acknowledgement returns what was displaced, removing a patch does not have to mean writing its `before`
back. When a patch is applied the displaced values are saved as a **journal** file next to the mailbox, named by the
patch's own sha256. Removing it replays that journal. The difference matters as soon as two knowledges are loaded at
once: writing `before` back would restore the state the *disk file* remembers and quietly erase whatever else had been
loaded underneath in the meantime, while replaying the journal restores exactly what this patch displaced and leaves
the rest of the stack standing.

A patch can also be applied read-first: the rows are read and compared to `before` before anything is written, and on
a mismatch nothing at all is written and the operation ends as `base_mismatch`. That check is what makes it safe to
publish a knowledge that was trained on top of another one — it will refuse to load onto a table that is not the one
it was built against, rather than half-working.

## The same value means the same sixteen bits

The table stores bfloat16. A float32 value written into it and read back is not the number that went in — the bottom
sixteen bits are gone — so a float32 comparison would report a difference that the model cannot possibly observe.

Every equality question in the system is therefore asked in bfloat16, with the same round-to-nearest-even the hook
uses: whether the live rows match a patch's `before`, whether a row currently holds a patch's `after` or the value it
displaced, and whether two patches that touch the same address actually disagree there. The fingerprint an anchor
carries for the table state it was trained against is a hash over the addresses and the bfloat16 bits of `before`,
for the same reason.

This turns a question that sounds statistical into one that is decidable and cheap. "Is this the state I was trained
on?" has a yes-or-no answer that costs a read and a comparison, and it is the same answer on every machine.

## What a patch is bound to

**One model.** An anchor names the model it was trained for. A node that serves a different one refuses to load it,
in as many words — `patch <id> targets <model> but this node serves <other>`. There is no conversion. A knowledge is
worth exactly as much as the population of nodes serving the model it names, which is also why the marketplace filters
on the model before anything else. See [`Anchor`](../reference/schemas.md#anchor) in the schema reference for the
fields that carry it.

**Whatever else is already on those rows.** Two patches that touch a common address cannot both be in effect there;
the one applied last wins. This is not detected by inspecting behaviour — it is set arithmetic on `addrs`, so a node
can compute it for any two bodies it holds, before either is loaded. It is the table `ainize patch get` prints under
*address-set overlaps*, and it reports both how many rows are shared and whether the two knowledges answer the same
benchmark schema:

- **overlap, different schema** — two unrelated knowledges collided on a shared n-gram. They interfere at those rows
  and nobody intended it.
- **overlap, same schema** — two builds of the same knowledge. They are rivals, and the newer one supersedes the older
  when it lists.

That second case is a status of its own. In a three-node network run while writing this page, publishing a
three-row knowledge over the same addresses as an existing four-row one moved the original from `LISTED` to
`SUPERSEDED` the moment the newcomer reached quorum — no vote, no author involvement, just the overlap and the
timestamps.

## Why this is not fine-tuning

The difference is one of kind, not of degree, and it is worth being precise rather than boastful about it.

Fine-tuning produces a new model. The weights are different, the artefact is a checkpoint, the serving process must
load it, and two independently fine-tuned models cannot be combined or told apart afterwards — the change has no
address. What is distributed is the whole model, so the unit of trade is a model and the unit of trust is its
publisher.

A knowledge patch names rows and values. The weights of the model are untouched; the artefact is kilobytes; the
serving process keeps running; and because the displaced values are kept, the change is invertible by construction.
The unit of trade is the change itself, which is what makes the rest of this product possible: something that small
and that precisely delimited can be priced, verified by a stranger who runs it and puts it back, credited to whoever
supplied it, and removed by a buyer who did not like it.

It is also not retrieval. Nothing is inserted into the prompt and no context is spent. The model reads the row in its
own forward pass and cannot tell that anyone edited it.

## What it buys, and what it costs

What the design buys is reversibility with a name on it. A change to what a model knows becomes a small file with an
exact address set, a checkable claim about the state it was built on, and an undo that is bit-exact — which is why an
untrusted party's knowledge can be loaded, measured and unloaded by someone who has never met them.

What it costs is generality. A patch is bound to one model id and dies with it; the address space is shared, so
knowledges that were never meant to interact collide on it, and the only honest answer to a collision is *the last one
wins*; and the row count — the one number a buyer sees first — measures storage rather than knowledge. Those are not
temporary limitations awaiting a better implementation. They are what you accept in exchange for a change small enough
to be verified by a stranger.

Whether that verification means anything is a separate question, and the subject of
[what "verified" proves](./verification.md).
