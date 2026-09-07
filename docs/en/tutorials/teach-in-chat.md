---
title: Teach by correcting the model
summary: The browser door to teach mode — correct wrong answers as you find them, keep the key that owns the result, and follow the lesson from the terminal.
---

# Teach by correcting the model

Ask a node's model something it should know. When the answer is wrong, correct it — in the same page, under the reply,
without an account. Collect a few corrections that way and the node trains them into a **lesson**: a knowledge file it
can load into the live model, that you can keep, download or sell.

This is the browser door of teach mode. The other door hands the node a file of questions instead
([Teach from a file of questions](./teach-from-a-file.md)); the same pipeline is behind both, but the experience is
genuinely different. This one starts from a wrong answer you actually saw, and it needs no terminal at all — right up
until you want to follow the lesson from one, which is the last part of this tutorial.

## Before you start

**A node that accepts lessons.** Any node's own address serves the site — `http://localhost:3618` here. Open
`<node>/chat?teach=1` and the teaching panel is either there or it says the node does not accept lessons. If it is your
node, step 1 of [Teach from a file of questions](./teach-from-a-file.md#1-turn-teach-mode-on) turns it on.

**A model behind that node.** This door begins with an answer, so the model server has to be up. If the chat page says
the model server is off, nothing on this page will work — every step here waits on a real answer from a real model.

**Nothing else.** No account, no wallet, no installation. The identity you teach under is created in your browser the
first time you need it, which is the next section, and it matters more than anything else on this page.

## 1. The key that owns your lessons

The first time you teach, the node's site creates a **teaching key** in your browser and shows it to you:

> Ainize just created a teaching key in this browser. It signs your lessons and is where sales revenue is paid.
> No account, no node, no sign-in. Ainize never sees the private key.

You may give it a display name (it appears as *Taught by …* on anything you publish) and a payout address, and both can
be left empty. What you must not skip is **Download key backup**, which saves a small JSON file called
`ainize-teaching-key-<8 hex>.json`.

> [!WARNING]
> The key lives in this browser's local storage and nowhere else. Clear the browser, use a private window, switch
> laptops — and without that backup file the lessons signed with it are gone: they stay on the node, owned by a key
> nobody holds. Nothing can recover them, because nothing anywhere knows they were yours. There is no password reset,
> because there is no account.

The same warning shows up on the other door, where it is the CLI that mints the key and says where it left it:

```text
! new teaching key 0x99a0A17380cBEA9F495920687f9Ee05066e3835e — kept in /tmp/ainize-tut/my-node/teaching-key.json. Back it up: it is the only way back to these lessons and their earnings.
```

Those two files are the same kind of thing, and either can be given to the other side: the browser's backup works with
`ainize teach … --key-file ainize-teaching-key-….json`, and `<home>/teaching-key.json` can be pasted into
**I already have a key** in the browser. One key, one identity, whichever door you came in through.

## 2. Ask, and correct the answer

<!-- unverified: needs a model runtime -->
Open the live test with teaching switched on:

```text
http://localhost:3618/chat?teach=1
```

Ask your question. When the answer is wrong, the reply carries a **Teach the right answer** button, and the drawer that
opens asks for exactly three things:

| Field | What goes in it |
|---|---|
| The question | Already filled in — what you asked. |
| The model said | The wrong answer, shown so you can see what you are correcting. |
| The right answer | Short and exact. One line: a name, a number, a date. The limit is 200 characters. |
| Ask it another way *(optional)* | The same question in different words. Used to check the model learned the fact, not the sentence. |

Keep answers short and specific. A paragraph is several facts wearing a coat, and a model taught a paragraph learns the
paragraph. Teach *"Sonora, on the 4th floor"*, not *"the room with the video wall is Sonora, which as you know moved
last spring…"*.

**Add to lesson** puts the correction in the basket. Nothing has been trained yet — you are collecting.

## 3. Collect up to a lesson's worth

<!-- unverified: needs a model runtime -->
The basket at the top of the page fills as you go: *Your lesson (3 of 8)*. Eight is this node's `teach.factsPerJob`, the
same number `ainize teach status` prints as `8 questions per lesson`; a node with a different setting shows a different
number and the drawer refuses the ninth correction with the node's own limit in the message.

Two things are worth understanding while the basket fills.

**What is loaded while you teach.** The live test can have knowledge loaded in it, and teaching with something loaded is
not the same as teaching the plain model — the corrections are measured against what the model says *with* that
knowledge in place. The basket says which it is: *Teaching the plain model (no knowledge loaded)*, or the names of what
is loaded.

**Building on someone else's knowledge is off by default.** The panel can offer to record another knowledge as the base
your lesson is built on — which credits its creators in every future sale — but `teach.lineage` is `false` on a fresh
node, and a node with it off answers any such request with `403 lineage_disabled`. What the split would be if it were
on is [Lineage and royalties](../concepts/lineage-and-royalties.md).

## 4. Train it

<!-- unverified: needs a model runtime -->
**Train this lesson** starts with a pre-flight: the node re-asks every question you corrected, with the same knowledge
loaded, and tells you what it found before spending a training slot on it.

- *Wrong today — will train.* The correction is needed.
- *Already correct — skipped.* The model answers it right already; there is nothing to teach, and training it would
  cost time for no change.
- *Too close to "…", which is already on this node — skipped.* Somebody has already taught this.

Then **Queue training**, and the node puts your lesson in line. From here it has its own page:

```text
http://localhost:3618/teach/lesson/<lesson-id>
```

That page is the progress screen while the lesson moves — the stage it is in, a real step counter, how many of your
sentences the model already answers correctly — and becomes the result screen when it stops. You can close the tab; the
lesson does not depend on it. What you cannot do is lose the key from section 1, which is what the page uses to prove
the lesson is yours.

The stages, what they mean and what `NEEDS_MORE` is, are in the file-door tutorial:
[Train it](./teach-from-a-file.md#7-train-it) and
[Read the checks](./teach-from-a-file.md#8-read-the-checks-they-decide-whether-you-may-publish). They are the same
pipeline and the same numbers.

## 5. Follow the same lesson from the terminal

<!-- unverified: needs a model runtime -->
Everything the lesson page shows is also readable from a terminal, and this is where the backup file earns its keep.
Copy the lesson URL (or just its id) and pass your key:

```bash
ainize teach status "http://localhost:3618/teach/lesson/<lesson-id>" --key-file ~/Downloads/ainize-teaching-key-99a0a173.json
```

`ainize teach status` takes a node URL, a lesson URL, a `…/chat?lesson=<id>` link, a bare lesson id or a
`…/teacher/0x…` page, and works out which one it was given. With the right key it prints the lesson body: the
corrections, the answer before and after, whether each one hit, the checks, the dataset behind it. Without a key it
prints the status and one line saying why that is all:

```text
status only — pass your teaching key (--key-file <backup.json>) to see the lesson body
```

Which is the rule the whole design rests on: the node does not decide who you are, the signature does. `--key <64-hex>`
and the `AINIZE_TEACH_KEY` environment variable are the other two ways to give it, and `ainize teach jobs --key-file …`
lists every lesson that key owns on that node.

> [!TIP]
> The key is an identity, not a session. The same backup file used on another machine, against the same node, is the
> same teacher: same lessons, same earnings, no transfer step.

## 6. Keep it private, or publish it

<!-- unverified: needs a model runtime -->
A finished lesson is a private draft. The lesson page offers three things, and the choice is yours, not the node's.

**Try it now** loads the draft into the live model and lets you ask again — the same before-and-after you started from,
this time with your own correction in place.

**Keep it private** leaves it on the node for the node's draft window (`unsaved lessons kept 7 days` on a default node)
where only your key and the operator can load it, and offers the `.npz` and its `recipe.json` as downloads. The file
only works inside the exact model this node serves; [What a knowledge patch is](../concepts/knowledge-patch.md)
explains why, and what running it elsewhere would take.

**Publish so others can use it** puts it on the public record under your teaching key, with a name, a description, a
price and a licence — and two consent boxes that are not decoration: a published lesson cannot be edited or deleted,
and its questions and answers are read by verifier nodes on other machines. The share you get from each sale is the
`data-provider share` line of `ainize teach status` — 70 % of the node's share by default.

What "publish" means for how long it takes is `teach.publish`, printed by `ainize teach status`:

| `teach.publish` | What happens when you publish |
|---|---|
| `review` | The lesson goes to the operator as `PENDING_REVIEW` and waits. They see it on **My knowledge → Teaching**, and it is announced when they approve it — or declined with a reason, and your file is still yours to download. This is the default. |
| `auto` | The lesson is announced to the network immediately. |
| `never` | This node trains lessons and publishes none. The publish button is not there, and the download is the whole story. |

After it is announced, it is out of teach mode's hands: independent nodes verify it, and it goes on sale when enough of
them agree. That is [what "verified" proves](../concepts/verification.md), and the money side is
[Set a price and get paid](../how-to/price-knowledge.md).

## Where to go next

If the corrections you want to teach already exist in a file — a spreadsheet, an export, a list of product codes —
[Teach from a file of questions](./teach-from-a-file.md) is the same pipeline with a hundred rows instead of eight.

To use what other people have taught, [Use knowledge someone else published](./buy-and-apply.md) walks the buyer's
path from finding it to loading it.

Every command here is in the [CLI reference](../reference/cli.md#ainize-teach); the browser calls the same endpoints,
which are in the [HTTP API reference](../reference/http-api.md).
