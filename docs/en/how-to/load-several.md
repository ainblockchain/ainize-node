---
title: Load several knowledges at once
summary: What the order of a stack means, who wins where two knowledges disagree, what unloading puts back, and how to see all of it before you spend anything.
---

# Load several knowledges at once

A serving model holds a **stack**: knowledge written into its memory table one on top of another. Nothing about that
is implicit — the order is the order you loaded them in, the overlaps are visible before you load anything, and what
comes back when you unload is a journal, not a guess.

## The rule

**The order of the calls is the order of the stack, and the last one written wins on any memory entry two of them
share.** Everything below follows from that one sentence.

```bash
ainize patch apply krx-all-2761 pixelplus-087600
# loaded in order: krx-all-2761 → pixelplus-087600  (the last one wins on any memory entry they share)
```

`a b` and `a,b` mean the same thing on `use`, `patch buy`, `patch apply` and `patch remove`; so does
`ainize chat --patch a,b` for one question, up to three at a time.

## See the overlap first

Two knowledges on the same subject usually share memory entries, and the one on top decides those answers:

```bash
ainize patch conflicts krx-all-2761      # which knowledges share entries with it, and how many
ainize patch stack                       # what is loaded right now, bottom first
```

`ainize chat --list` prints the same thing for the knowledges that are loaded together — `loaded together and
overlapping: a ∩ b = 2,170 entries (the one loaded later wins on them)` — and counts the overlapping pairs that are
merely held, since those decide nothing until they are loaded.

## What unloading puts back

Loading writes a journal of the rows it overwrote. Unloading replays it, so what was underneath comes back exactly
as it was:

```bash
ainize patch remove pixelplus-087600     # krx-all-2761 is untouched and still loaded
```

Two things are worth knowing:

- A knowledge published before journals existed has none. Unloading that one writes the **model's own** rows back
  instead of the layer below it. `ainize patch stack` says which kind each layer is — "can be unloaded without
  disturbing what is under it", or "no journal".
- Unloading something with another knowledge on top of it is refused (`has_dependents`), because the one on top was
  verified against the rows underneath. `--cascade` unloads them together.

## Add-ons need their base underneath

A knowledge taught **on top of** another one (see [Build on someone else's
knowledge](./build-on-knowledge.md)) is a delta: it only makes sense with that base loaded under it, and the node
enforces it rather than producing wrong answers.

```bash
ainize patch apply child-2761            # refused: needs_base — krx-all-2761 is not loaded
ainize patch apply child-2761 --with-base  # loads the whole chain, ancestors first
ainize use child-2761                    # quotes the family, buys what is missing, loads the chain
```

`ainize patch buy <id> --bundle` buys the bases the knowledge needs underneath it, deepest first, one payment each;
without it you are asked, and told what the file will and will not answer alone.

## A track loads on top of what you have

`ainize branch subscribe <track>` buys the track's current knowledge and loads it **on top of** whatever is already
loaded; from then on it buys and loads what the track adds and unloads the versions the track retires. Only what the
subscription itself loaded is ever unloaded by it — anything you loaded by hand is kept and stays underneath.

## From a script

Every one of these verbs writes one JSON document per command under `--json`, including a multi-id run:

```bash
ainize --json patch apply krx-all-2761 pixelplus-087600
# {"ids":["krx-all-2761","pixelplus-087600"],"items":[{"patch_id":"…","kind":"apply","result":"…"}, …]}

ainize --quiet use krx-all-2761          # prints just the id it affected
```

Exit codes are listed in `ainize --help`; `5` is the one that means something else is holding the shared model.

## Next

- [Use knowledge someone else published](../tutorials/buy-and-apply.md) — the whole path for one knowledge.
- [Build on someone else's knowledge](./build-on-knowledge.md) — where add-ons come from.
