---
title: Build on someone else's knowledge
summary: Take a published knowledge's questions, teach your own answers on top of it, and publish the result — what it costs, what it pays its ancestors, and the two rules that stop it.
---

# Build on someone else's knowledge

Every knowledge on this network can be the floor of the next one. You take what a published knowledge was taught
from, add the questions it gets wrong or does not cover, train **on top of it**, and publish that. The public record
says what you built on, buyers of yours are told they need theirs too, and its creator is paid a share of every sale
of yours for as long as yours sells.

This page is the whole path, in the terminal. The browser does the same thing at `<node>/teach/upload?on=<id>`.

## Before you start

**Your node must read the same ledger as the seller.** A node created with `--ledger local` keeps a record DAG of
its own and can never see knowledge announced on the AIN chain, however healthy the peer looks. `ainize peers ls`
marks the mismatch and `ainize status` counts it; if it is there, nothing below will find anything.

**You must have bought it.** Holding the file is not a licence — a verifier downloads every knowledge it scores and
may not teach on any of them. `ainize patch get <id>` says which of the two you have, and one line fixes it:

```bash
ainize use krx-all-2761 --no-apply     # quote → confirm → pay → download, without loading it
```

## 1. Find something worth adding to

```bash
ainize patch ls --q ticker --status LISTED
ainize patch tree krx-all-2761              # what it was built on, what was built on it, what each added
ainize patch missing krx-all-2761           # questions people asked it here that it could not answer
```

`patch missing` is the one that tells you what to write: it is the list of questions this node saw that knowledge
fail, with how many people asked each.

## 2. Take its questions

```bash
ainize dataset get krx-all-2761 --manifest          # licence, access, row origin, PII scan
ainize dataset get krx-all-2761 -o questions.jsonl  # the exact bytes it was taught from
```

Every publisher chooses who may read their training set, and the answer is on the record:

| access | who may download the questions |
| --- | --- |
| `public` | anyone |
| `derivative` | anyone who declares they are building on it: the CLI posts a signed derive intent, prints the terms it just agreed to, and the declaration is counted on the base |
| `private` | nobody; the command says so instead of returning a truncated file |

A `private` training set does not stop you from building on the knowledge. It stops you from starting from its
questions: write your own, and use `--on` below exactly the same way.

## 3. Teach your additions on top

Add your rows to `questions.jsonl` — one `{"prompt": …, "answer": …}` per line — and train:

```bash
ainize teach train questions.jsonl --on krx-all-2761 --wait
```

`--on` is what makes this a derivative rather than a separate knowledge:

- the base's questions are kept as **known answers**, so the check can see whether your lesson broke any of them
  (`--no-inherit` checks against the base without keeping them);
- the base is written onto your anchor as what you were trained on top of, with the exact table state — which is
  why a buyer of yours is quoted for both, and why your file refuses to load without the base underneath it;
- an answer of yours that contradicts the base's is refused until you say it is deliberate with `--yes-change`.

`--wait` follows the lesson and exits with its outcome: `0` ready, `4` it did not stick, `5` it failed, `6` the
operator declined it, `7` it is still running, `8` ready but never measured on the live model.

## 4. Publish it

```bash
ainize teach publish <job-id> --name "KRX tickers + biotech" --price 10 \
  --license CC-BY-4.0 --consent-permanent --consent-rights
```

Both consent flags are yours to give and are never defaulted: the first says you understand the record is permanent,
the second that you have the right to share these questions. On a node that publishes automatically the lesson is
announced at once; on one that reviews first it waits as `PENDING_REVIEW` until the operator agrees
(`ainize teach status <node url>` says which of the two this node does). Once announced, other nodes have to verify
it — `verifier.quorum`, two by default — before it is LISTED and can be sold, and `ainize patch get <id>` shows how
far that has got.

## What a sale of yours pays

The split is read from **your anchor** — the promise written when you published, never from the selling node's
config — and the network floors it at 30 % to the lineage and 5 % to the verifiers. For a 10-credit sale of a
knowledge with one outside ancestor and two verifications that counted:

```text
10.00   the sale
-3.00   lineage pool: 30 %, divided equally among the ancestor AUTHORS other than you
        (one author here → 3.00; a chain of your own earlier versions never dilutes them)
 7.00   your side
-0.35   verification: 5 % of your side, split between the two verifiers (0.175 each)
 6.65   you keep
```

If the base's creator credited a data provider on it, that provider is paid out of the base's own 3.00, by the share
written on that anchor. A data provider credited on yours — the person who taught it, or an address you name with
`ainize publish --contributor <addr>:<name>:<share>` — is paid out of your 6.65.

## The two licence rules

- Your training set's licence must be one of `CC0-1.0`, `CC-BY-4.0`, `CC-BY-SA-4.0`, `ODC-By-1.0`, `Proprietary`.
- A `CC-BY-SA-4.0` base makes your training set `CC-BY-SA-4.0` too, and at least as open as the base's access.
  Anything else is refused at publish time with that sentence, not silently.

## When it does not work

| what you see | what it means |
| --- | --- |
| `unknown_knowledge` | the id is not on this node — a typo, or a knowledge it has never seen. Nothing was uploaded |
| `knowledge_not_held` | it is listed here but its file is not on this node: `ainize use <id> --no-apply` |
| `knowledge_not_licensed` | the file is here because this node verified it; verifying is not a licence |
| `license_incompatible` | the base is CC-BY-SA-4.0 and your training set is not, or is less open |
| exit `4` from `--wait` | the lesson did not stick — the answers did not survive the check. Train it again with `--effort thorough` |

## Next

- [Load several knowledges](./load-several.md) — what happens when your knowledge and its base are loaded together.
- [Lineage and royalties](../concepts/lineage-and-royalties.md) — the record behind the arithmetic above.
- [Publish every day](./publish-every-day.md) — the same path as a cron line.
