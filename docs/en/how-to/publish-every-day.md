---
title: Publish every day
summary: The nightly loop as one script — questions in, a lesson trained and checked, published only if it stuck, and the yesterday's version it retires — with the exit code of every step.
---

# Publish every day

Knowledge that changes — today's tickers, today's rates, today's rules — is published the same way every night. The
whole loop is four commands, and the only thing that makes it safe to run unattended is that each one sets an exit
code the next one can stop on.

## The loop

```bash
#!/usr/bin/env bash
set -euo pipefail
export AINIZE_PASSWORD="…"            # or --password; `ainize login` never blocks in a script

DAY=$(date +%F)
ainize login

# 1. questions in → a lesson, trained, checked, and waited for
JOB=$(ainize --json teach dataset ./questions-$DAY.csv --train --wait --timeout 45 \
        --name "KRX $DAY" | jq -r '.job.job.id')

# 2. publish it — the two consents are the publisher's own and are never defaulted
ainize teach publish "$JOB" --name "KRX tickers $DAY" --price 10 \
  --consent-permanent --consent-rights
```

`--wait` is what makes step 1 a gate rather than a fire-and-forget: it follows the lesson through its stages and
**exits with the outcome**, so `set -e` stops the script before it publishes a bake that did not work.

| exit | what happened | what to do |
| --- | --- | --- |
| `0` | ready, and measured on the live model | publish it |
| `4` | it did not stick — the answers did not survive the check | train again, `--effort thorough` |
| `5` | failed, cancelled or expired | read `ainize teach status <job>` |
| `6` | the operator declined it | this node's teach policy is `review`; ask them |
| `7` | still running when `--timeout` ran out | it goes on without you; check later |
| `8` | ready but never measured (the model server was down) | `ainize teach recheck <job> --wait` before publishing |

The same codes come out of `ainize teach train <dataset-id> --wait`. Everything else follows the CLI's general
codes, which `ainize --help` lists: `2` no node to talk to, `3` not logged in, `4` the node did not answer in time.

## Retiring yesterday's version

Publishing today's knowledge does not take yesterday's off sale by itself. When today's covers the same subject on
the same track, the announce **refuses** until you name what it retires:

```bash
ainize patch announce krx-2026-09-05 --supersede krx-2026-09-04
```

The refusal lists what would go, with each one's status, sales and shared entries, and nothing is written to the
ledger until you re-run it with the names. Buyers of the old version keep their copy and are shown "Newer version
available"; there is no undo, which is why it asks.

**The rule it applies.** A publish retires one of your listings when three things are true of it: the same
benchmark schema, the same track, and at least one shared memory entry. That last condition is why a day whose
facts touch different rows — new listings, delistings, a fresh subject — retires nothing at all on its own, and
both days stay on sale. Two flags decide it instead of the rows:

```bash
# today replaces yesterday even though their rows do not overlap
ainize patch announce krx-2026-09-05 --supersede krx-2026-09-04

# a dated snapshot, published on purpose: nothing of yours is retired
ainize patch announce krx-snapshot-2026-09-01 --keep-others
```

`--supersede` names what this version replaces, whether or not the overlap rule found it; the node checks each id
is yours, still on sale, older than what you are publishing, and not a base this one was built on. `--keep-others`
retires nothing. Either way the announce prints what will go the moment verifiers pass it, and `--json` carries the
same list as `pending_supersedes`. A knowledge published by **another** node is never retired by yours — an overlap
across authors coexists.

If you would rather do it explicitly at any time:

```bash
ainize patch retire krx-2026-09-04 --reason "superseded by the 09-05 tickers"
```

## Reading the result from a script

Every command has a `--json` document, and failures are documents too — on stderr, with the node's own error body:

```bash
ainize --json publish ./today.npz --name "KRX $DAY" --model Qwen3.8-Flash-Next \
  --benchmark ./bench.json --price 10 > published.json || {
    jq -r '.error.message' < /dev/stderr; exit 1; }

jq -r '.record_hash, .status, .verifiers_known, (.pending_supersedes[].id)' published.json
```

`--quiet` is the other half: on a mutating command it prints the id of what it just created and nothing else, so
`ID=$(ainize --quiet patch publish …)` is a whole step.

## Before the first night

- **Verifiers.** Nothing you announce can be LISTED until `verifier.quorum` other nodes attest it. `ainize publish`
  says how many reachable verifiers this node knows the moment it announces; if that number is below the quorum,
  the loop will publish every night into a catalogue nobody can buy from.
- **The teaching key.** The CLI keeps one at `<AINIZE_HOME>/teaching-key.json` and creates it on first use. It is the
  identity your lessons and their earnings belong to — back it up before the loop runs unattended.
- **Quotas.** A node caps lessons and questions per key per day (`ainize teach status <node url>` prints the limits
  it will enforce), so a nightly bake sized above them stops with `quota_key`, not silently.

## Next

- [Teach from a file of questions](../tutorials/teach-from-a-file.md) — the same pipeline, one step at a time.
- [Build on someone else's knowledge](./build-on-knowledge.md) — when tonight's knowledge sits on someone else's.
