---
title: CLI reference
summary: Every `ainize` command, argument and option, generated from the CLI's own declarations
---

# CLI reference

> [!NOTE]
> **This page is generated — do not edit it by hand.** It is written by `scripts/docs-gen.mjs` from `packages/cli/src/bin.ts`.
> Regenerate with `npm run docs:gen`; `npm run docs:check` fails when this page and the source disagree.

Every command the `ainize` CLI accepts — 25 top-level commands, 70 of them runnable — with the arguments, options, defaults and examples each one declares. The binary is also installed as `ngram`; the two names run the same program.

## How to read this page

Each command shows the shape of the line first: required arguments in `<angle brackets>`, optional ones in `[square brackets]`, a trailing `…` where several values may follow, and every required option spelled out. `[options]` stands for the rest of the list below it.

An option with a type takes a value (`--limit 20`); a `boolean` option is a flag, and `--no-` in front of its name turns it off — `ainize init --no-force`.

The global options come first because they work everywhere; everything after that is one command per heading, nested exactly as its subcommands are.

## Global options

These are accepted by every command.

- **`--home`** (`string`) — node home directory (NGRAM_HOME)
- **`--node`** (`string`) — node API URL (default: http://localhost:\<config port>)
- **`--json`** (`boolean`, default `false`) — machine-readable JSON output
- **`--quiet`** (`boolean`, default `false`) — suppress output
- **`--help`, `-h`** (`boolean`) — print the help for a command and exit
- **`--version`** (`boolean`) — print the CLI version and exit

## Commands

| Command | What it does |
|---|---|
| [`ainize init`](#ainize-init) | Create a node identity and config in NGRAM_HOME |
| [`ainize config`](#ainize-config) | Show or edit the node config |
| [`ainize keys`](#ainize-keys) | Node identity: the key that owns everything this node published |
| [`ainize start`](#ainize-start) | Start the node (foreground unless --detach) |
| [`ainize stop`](#ainize-stop) | Stop a background node |
| [`ainize status`](#ainize-status) | Show node / ledger / runtime status |
| [`ainize logs`](#ainize-logs) | Show node events |
| [`ainize seed`](#ainize-seed) | Seed demo data (prototype ledger, real Qwen3.8 patches if present, synthetic branches) |
| [`ainize nodes`](#ainize-nodes) | List known nodes and configured peers |
| [`ainize login`](#ainize-login) | Log in as the node operator (sets the password on first use) |
| [`ainize logout`](#ainize-logout) | Forget the operator session |
| [`ainize peers`](#ainize-peers) | Manage peers |
| [`ainize patch`](#ainize-patch) | Publish, inspect, verify, buy and apply knowledge patches |
| [`ainize publish`](#ainize-publish) | One line to sell knowledge: register a .npz + benchmark and announce it (the network verifies, you get paid per sale) |
| [`ainize teach`](#ainize-teach) | Teach mode: turn your own questions and answers into knowledge. Two doors, one pipeline — a dataset file here, or corrections collected in the browser (\<node>/chat?teach=1) |
| [`ainize dataset`](#ainize-dataset) | Training sets: the questions a published knowledge was taught from (lineage design §13) |
| [`ainize use`](#ainize-use) | One line to use knowledge: check it is verified → pay automatically → download → load into your model |
| [`ainize chat`](#ainize-chat) | Live-test a knowledge patch: the model's answer before vs after the patch is loaded (correct-answer check) |
| [`ainize ledger`](#ainize-ledger) | Inspect the ledger |
| [`ainize branch`](#ainize-branch) | Knowledge branches (parallel, possibly contradictory patch sets) |
| [`ainize route`](#ainize-route) | Gateway routing: which branch/nodes serve a request context |
| [`ainize wallet`](#ainize-wallet) | Balance, sales, royalties and pending payouts of this node |
| [`ainize payouts`](#ainize-payouts) | Royalty transfers this node owes creators and data providers (AIN ledger) |
| [`ainize drive`](#ainize-drive) | aindrive: files & change history of this node |
| [`ainize chain`](#ainize-chain) | Local AIN blockchain (docker) for the ain ledger |

## `ainize init`

```bash
ainize init [options]
```

Create a node identity and config in NGRAM_HOME

**Options**

- **`--name`** (`string`) — node display name
- **`--port`** (`number`) — HTTP port
- **`--ledger`** (`"local" | "ain"`) — ledger backend: local P2P record DAG or AIN blockchain
- **`--ain-provider`** (`string`) — AIN JSON-RPC URL (ain ledger)
- **`--ain-chain-id`** (`number`) — AIN chain id (0 = local/testnet)
- **`--peer`** (`string[]`) — seed peer URL(s)
- **`--roles`** (`string`) — comma list of seller,verifier,serving,gateway
- **`--runtime-repo`** (`string`) — reference runtime repo (scripts/patch.py)
- **`--runtime-api`** (`string`) — serving API (OpenAI-compatible) URL
- **`--private-key`** (`string`) — import an existing AIN private key (hex)
- **`--public-url`** (`string`) — URL peers can reach this node at
- **`--force`** (`boolean`, default `false`) — rewrite an existing config.json (the node identity and operator password are kept; the old file is copied aside)
- **`--new-identity`** (`boolean`, default `false`) — with --force: mint a NEW node key, orphaning everything the old one published (asks you to type the current address)

**Examples**

```bash
# local ledger node
ainize init --name alice --port 3402
# AIN blockchain ledger (see `ainize chain up`)
ainize init --ledger ain --ain-provider http://localhost:8081
```

## `ainize config`

```bash
ainize config <subcommand>
```

Show or edit the node config

**Subcommands** — one of them is required

- `ainize config show` — Print config.json (secrets hidden)
- `ainize config get` — Print one config key (dotted path)
- `ainize config set` — Set a config key (dotted path, e.g. market.defaultPrice 0.5)
- `ainize config unset` — Remove a config key so the node uses its built-in default

### `ainize config show`

```bash
ainize config show
```

Print config.json (secrets hidden)

### `ainize config get`

```bash
ainize config get <key>
```

Print one config key (dotted path)

**Arguments**

- **`<key>`** (`string`, required)

**Examples**

```bash
ainize config get market.defaultPrice
```

### `ainize config set`

```bash
ainize config set <key> <value>
```

Set a config key (dotted path, e.g. market.defaultPrice 0.5)

**Arguments**

- **`<key>`** (`string`, required)
- **`<value>`** (`string`, required)

**Examples**

```bash
ainize config set ledger.kind ain
ainize config set peers http://a:3402,http://b:3403
```

### `ainize config unset`

```bash
ainize config unset <key>
```

Remove a config key so the node uses its built-in default

**Arguments**

- **`<key>`** (`string`, required)

**Examples**

```bash
ainize config unset teach.trainer.gpus
```

## `ainize keys`

```bash
ainize keys <subcommand>
```

Node identity: the key that owns everything this node published

**Subcommands** — one of them is required

- `ainize keys show` — Print address and public key
- `ainize keys backup` — Save the node key to a file (encrypted with --passphrase) — the only way back after a wiped disk
- `ainize keys import` — Make a backed-up key this node's identity (asks you to type the current address)
- `ainize keys rotate` — Mint a NEW node identity, keeping every other setting (asks you to type the current address)

### `ainize keys show`

```bash
ainize keys show [options]
```

Print address and public key

**Options**

- **`--reveal`** (`boolean`, default `false`) — also print the private key (asks first)
- **`--yes`** (`boolean`, default `false`) — with --reveal: skip the confirmation

### `ainize keys backup`

```bash
ainize keys backup <file> [options]
```

Save the node key to a file (encrypted with --passphrase) — the only way back after a wiped disk

Also spelled `ainize keys export`.

**Arguments**

- **`<file>`** (`string`, required)

**Options**

- **`--passphrase`** (`string`) — encrypt with this passphrase (or NGRAM_KEY_PASSPHRASE); without one the key is stored in the clear
- **`--force`** (`boolean`, default `false`) — overwrite an existing file

**Examples**

```bash
ainize keys backup ~/node-key.json --passphrase "…"
```

### `ainize keys import`

```bash
ainize keys import <file> [options]
```

Make a backed-up key this node's identity (asks you to type the current address)

**Arguments**

- **`<file>`** (`string`, required)

**Options**

- **`--passphrase`** (`string`) — or NGRAM_KEY_PASSPHRASE

### `ainize keys rotate`

```bash
ainize keys rotate
```

Mint a NEW node identity, keeping every other setting (asks you to type the current address)

## `ainize start`

```bash
ainize start [options]
```

Start the node (foreground unless --detach)

**Options**

- **`--port`** (`number`)
- **`--peer`** (`string[]`) — extra peer URL(s)
- **`--roles`** (`string`)
- **`--public-url`** (`string`)
- **`--detach`, `-d`** (`boolean`, default `false`) — run in the background (pid in NGRAM_HOME/node.pid)

**Examples**

```bash
ainize start
# second node joining the first
ainize start -d --peer http://localhost:3402
```

## `ainize stop`

```bash
ainize stop
```

Stop a background node

## `ainize status`

```bash
ainize status [options]
```

Show node / ledger / runtime status

**Options**

- **`--check`** (`boolean`, default `false`) — readiness only (GET /readyz): exits 1 when a check fails

**Examples**

```bash
# for a monitor or a deploy script
ainize status --check
```

## `ainize logs`

```bash
ainize logs [options]
```

Show node events

**Options**

- **`--follow`, `-f`** (`boolean`, default `false`)
- **`--patch`** (`string`) — only events of a patch
- **`--kind`** (`"blob" | "branch" | "buy" | "challenge" | "config" | "drive" | "node" | "p2p" | "patch" | "payout" | "publish" | "runtime" | "seed" | "settings" | "teach" | "trade" | "usage" | "verifier" | "verify"`) — only this kind of event
- **`--level`** (`"debug" | "info" | "warn" | "error"`) — this level and worse (warn shows warn + error)
- **`--limit`** (`number`, default `100`)

**Examples**

```bash
# everything that went wrong, newest last
ainize logs --level warn
ainize logs --kind trade --limit 20
```

## `ainize seed`

```bash
ainize seed [options]
```

Seed demo data (prototype ledger, real Qwen3.8 patches if present, synthetic branches)

**Options**

- **`--real`** (`boolean`, default `true`) — register real patches from the runtime repo
- **`--synthetic`** (`boolean`, default `false`) — create synthetic law/KR vs law/US demo patches
- **`--prototype`** (`boolean`, default `false`) — import the reference prototype ledger
- **`--announce`** (`boolean`, default `true`)

## `ainize nodes`

```bash
ainize nodes
```

List known nodes and configured peers

## `ainize login`

```bash
ainize login [options]
```

Log in as the node operator (sets the password on first use)

**Options**

- **`--password`** (`string`) — or NGRAM_PASSWORD env

## `ainize logout`

```bash
ainize logout
```

Forget the operator session

## `ainize peers`

```bash
ainize peers <subcommand>
```

Manage peers

**Subcommands** — one of them is required

- `ainize peers ls` — List peers
- `ainize peers add` — Add a peer
- `ainize peers rm` — Remove a peer

### `ainize peers ls`

```bash
ainize peers ls
```

List peers

### `ainize peers add`

```bash
ainize peers add <url>
```

Add a peer

**Arguments**

- **`<url>`** (`string`, required)

### `ainize peers rm`

```bash
ainize peers rm <url>
```

Remove a peer

**Arguments**

- **`<url>`** (`string`, required)

## `ainize patch`

```bash
ainize patch <subcommand>
```

Publish, inspect, verify, buy and apply knowledge patches

**Subcommands** — one of them is required

- `ainize patch ls` — List patches in the catalog
- `ainize patch get` — Show a patch in detail
- `ainize patch publish` — Register a .npz patch body as a draft (and optionally announce it)
- `ainize patch import` — Import a downloaded lesson (.npz + recipe.json) as a PRIVATE draft: no announce, no ledger record
- `ainize patch announce` — DRAFT → ANNOUNCED (anchor on the ledger)
- `ainize patch verify` — Run this node's verifier on a patch and publish an attestation
- `ainize patch challenge` — Dispute a verification: takes the knowledge off sale until a verifier re-runs it
- `ainize patch buy` — Buy a listed patch via HTTP 402 (x402) and download its body
- `ainize patch apply` — Apply a held patch to the serving runtime (no restart)
- `ainize patch remove` — Unload it, putting back whatever was underneath
- `ainize patch stack` — What is loaded in the serving model, bottom first
- `ainize patch fork` — Copy this knowledge's questions into your own training set, and continue from there
- `ainize patch conflicts` — Address-set overlaps with other patches
- `ainize patch records` — Ledger records about a patch
- `ainize patch rm` — Delete a draft
- `ainize patch forget` — Stop serving the knowledge file from this node (deletes the local body; the public record stays)

### `ainize patch ls`

```bash
ainize patch ls [options]
```

List patches in the catalog

**Options**

- **`--status`** (`string`) — comma list: DRAFT,ANNOUNCED,VERIFYING,LISTED,REJECTED,CHALLENGED,SUPERSEDED
- **`--model`** (`string`)
- **`--schema`** (`string`) — benchmark schema
- **`--branch`** (`string`)
- **`--author`** (`string`)
- **`--q`** (`string`) — text search
- **`--sort`** (`"latest" | "popular" | "price" | "rows"`, default `"latest"`)
- **`--limit`** (`number`, default `100`)
- **`--mine`** (`boolean`, default `false`) — only my patches (needs login)
- **`--drafts`** (`boolean`, default `false`) — include my drafts (needs login)

### `ainize patch get`

```bash
ainize patch get <id>
```

Show a patch in detail

**Arguments**

- **`<id>`** (`string`, required)

### `ainize patch publish`

```bash
ainize patch publish <file> --name <value> --model <value> --benchmark <value> [options]
```

Register a .npz patch body as a draft (and optionally announce it)

**Arguments**

- **`<file>`** (`string`, required) — path to .npz on the node machine

**Options**

- **`--name`** (`string`, required)
- **`--model`** (`string`, required) — target model id_M
- **`--benchmark`** (`string`, required) — benchmark JSON file or inline JSON ({schema, queries, format, samples})
- **`--id`** (`string`)
- **`--price`** (`string`)
- **`--description`** (`string`)
- **`--parents`** (`string`) — comma list of parent patch ids (lineage/royalty)
- **`--branch`** (`string`)
- **`--topic`** (`string`) — ain-js knowledge topic path (e.g. finance/krx)
- **`--license`** (`string`)
- **`--billing`** (`"per_download" | "per_apply_hour" | "per_hit"`)
- **`--contributor`** (`string[]`) — data provider credited on the record: addr:name:share (repeatable, ≤ 4, Σ share ≤ 1)
- **`--dataset`** (`string`) — the training set behind this knowledge (.jsonl/.csv on the node machine) — pinned and served under --dataset-access
- **`--dataset-access`** (`"public" | "derivative" | "private"`) — who may read those questions: anyone / people building on this knowledge (default) / nobody
- **`--dataset-license`** (`string`) — licence for the questions: CC0-1.0, CC-BY-4.0, CC-BY-SA-4.0, ODC-By-1.0, Proprietary
- **`--announce`** (`boolean`, default `false`) — announce to the network immediately

**Examples**

```bash
ainize patch publish ./rows.npz --name "KRX tickers" --model Qwen3.8-Flash-Next --benchmark bench.json --price 25 --announce
```

### `ainize patch import`

```bash
ainize patch import <file> --recipe <value> [options]
```

Import a downloaded lesson (.npz + recipe.json) as a PRIVATE draft: no announce, no ledger record

**Arguments**

- **`<file>`** (`string`, required) — lesson-\<slug>.npz on the node machine (stays in place)

**Options**

- **`--recipe`** (`string`, required) — recipe.json downloaded with the lesson (benchmark, model, facts)
- **`--id`** (`string`) — draft id (default: the lesson's draft id, taught-\<slug>)
- **`--name`** (`string`)
- **`--model`** (`string`) — target model id_M when the recipe names none
- **`--price`** (`string`)
- **`--license`** (`string`)
- **`--description`** (`string`)

**Examples**

```bash
# then: ainize patch apply taught-pixelplus-1a2b3c
ainize patch import ./lesson-pixelplus-1a2b3c.npz --recipe ./recipe.json
```

### `ainize patch announce`

```bash
ainize patch announce <id>
```

DRAFT → ANNOUNCED (anchor on the ledger)

**Arguments**

- **`<id>`** (`string`, required)

### `ainize patch verify`

```bash
ainize patch verify <id>
```

Run this node's verifier on a patch and publish an attestation

**Arguments**

- **`<id>`** (`string`, required)

### `ainize patch challenge`

```bash
ainize patch challenge <id> --reason <value>
```

Dispute a verification: takes the knowledge off sale until a verifier re-runs it

**Arguments**

- **`<id>`** (`string`, required)

**Options**

- **`--reason`** (`string`, required)

### `ainize patch buy`

```bash
ainize patch buy <id> [options]
```

Buy a listed patch via HTTP 402 (x402) and download its body

**Arguments**

- **`<id>`** (`string`, required)

**Options**

- **`--apply`** (`boolean`, default `false`) — apply to the serving runtime after download

### `ainize patch apply`

```bash
ainize patch apply <id> [options]
```

Apply a held patch to the serving runtime (no restart)

**Arguments**

- **`<id>`** (`string`, required)

**Options**

- **`--with-base`** (`boolean`, default `false`) — also load everything this knowledge was trained on top of, underneath it

### `ainize patch remove`

```bash
ainize patch remove <id> [options]
```

Unload it, putting back whatever was underneath

**Arguments**

- **`<id>`** (`string`, required)

**Options**

- **`--cascade`** (`boolean`, default `false`) — also unload everything that is loaded on top of it

### `ainize patch stack`

```bash
ainize patch stack
```

What is loaded in the serving model, bottom first

### `ainize patch fork`

```bash
ainize patch fork <id> [options]
```

Copy this knowledge's questions into your own training set, and continue from there

**Arguments**

- **`<id>`** (`string`, required)

**Options**

- **`--name`** (`string`) — name for your copy
- **`--key-file`** (`string`) — teaching key file (default: \<home>/teaching-key.json)
- **`--key`** (`string`) — teaching key as hex / json (or NGRAM_TEACH_KEY)

**Examples**

```bash
# start from its questions
ainize patch fork krx-all-2761 --name "KRX + biotech"
# then teach your additions on top of it
ainize teach train <dataset> --on krx-all-2761
```

### `ainize patch conflicts`

```bash
ainize patch conflicts <id>
```

Address-set overlaps with other patches

**Arguments**

- **`<id>`** (`string`, required)

### `ainize patch records`

```bash
ainize patch records <id>
```

Ledger records about a patch

**Arguments**

- **`<id>`** (`string`, required)

### `ainize patch rm`

```bash
ainize patch rm <id>
```

Delete a draft

**Arguments**

- **`<id>`** (`string`, required)

### `ainize patch forget`

```bash
ainize patch forget <id> [options]
```

Stop serving the knowledge file from this node (deletes the local body; the public record stays)

**Arguments**

- **`<id>`** (`string`, required)

**Options**

- **`--all-sharing`** (`boolean`, default `false`) — also stop serving every other knowledge built from the same file (the command lists them first)

## `ainize publish`

```bash
ainize publish <file> --name <value> --model <value> --benchmark <value> [options]
```

One line to sell knowledge: register a .npz + benchmark and announce it (the network verifies, you get paid per sale)

**Arguments**

- **`<file>`** (`string`, required) — path to the learned knowledge (.npz: addrs/before/after)

**Options**

- **`--name`** (`string`, required) — human name of the knowledge
- **`--model`** (`string`, required) — target model id_M (e.g. Qwen3.8-Flash-Next)
- **`--benchmark`** (`string`, required) — bench.json path or inline JSON {schema, queries, format, samples:[{prompt,expect}]}
- **`--price`** (`string`) — price in the node currency (AIN or node credit)
- **`--id`** (`string`)
- **`--description`** (`string`)
- **`--parents`** (`string`) — comma list of source knowledge ids (creators get a revenue share)
- **`--branch`** (`string`)
- **`--topic`** (`string`)
- **`--license`** (`string`)
- **`--announce`** (`boolean`, default `true`) — announce immediately (--no-announce keeps a draft)
- **`--test`** (`boolean`, default `false`) — hidden test listing (not shown in public catalogs)
- **`--contributor`** (`string[]`) — data provider credited and paid on the record: addr:name:share — share = fraction of YOUR share of each sale (repeatable, ≤ 4, Σ ≤ 1)

**Examples**

```bash
ainize publish ./my-knowledge.npz --name "KRX ticker codes" --model Qwen3.8-Flash-Next --benchmark ./bench.json --price 25
# Alice (data provider) gets 70 % of your share of every sale
ainize publish ./lesson.npz --name "…" --model … --benchmark ./bench.json --contributor 0xAbC…:Alice:0.7
```

## `ainize teach`

```bash
ainize teach <subcommand>
```

Teach mode: turn your own questions and answers into knowledge. Two doors, one pipeline — a dataset file here, or corrections collected in the browser (\<node>/chat?teach=1)

**Subcommands** — one of them is required

- `ainize teach status` — Teaching policy of a node, the status of a lesson, or a data provider's lessons and earnings
- `ainize teach dataset` — The questions a lesson is trained from: upload a file, list, inspect, download, delete
- `ainize teach train` — Teach a lesson from a dataset id or a dataset file
- `ainize teach jobs` — My lessons on this node and the dataset each came from

### `ainize teach status`

```bash
ainize teach status [target] [options]
```

Teaching policy of a node, the status of a lesson, or a data provider's lessons and earnings

**Arguments**

- **`[target]`** (`string`) — node URL · lesson URL (…/chat?lesson=\<id>) or job id · teacher page (…/teacher/\<address>) or 0x address; default: this node

**Options**

- **`--key`** (`string`) — teaching key (64-hex) — or NGRAM_TEACH_KEY; shows the full lesson body for your own lessons
- **`--key-file`** (`string`) — the key backup JSON downloaded from the browser (ainize-teaching-key-….json)

**Examples**

```bash
# is this node accepting lessons? publish mode, trainer, queue
ainize teach status http://localhost:3402
# your lesson: progress, checks, before/after
ainize teach status "http://localhost:3402/chat?lesson=8f0c…" --key-file ainize-teaching-key-1a2b3c4d.json
# a data provider's lessons and earnings
ainize teach status http://localhost:3402/teacher/0xAbC…
```

### `ainize teach dataset`

```bash
ainize teach dataset <subcommand>
```

The questions a lesson is trained from: upload a file, list, inspect, download, delete

**Subcommands** — one of them is required

- `ainize teach dataset upload` — Validate a dataset file and upload it (nothing is trained until you say so)
- `ainize teach dataset ls` — My datasets on this node
- `ainize teach dataset get` — One dataset: every source line with the reason it was or was not used; -o writes the questions to a file
- `ainize teach dataset rm` — Delete a dataset (the lessons trained from it are kept)

#### `ainize teach dataset upload`

```bash
ainize teach dataset upload <file> [options]
```

Validate a dataset file and upload it (nothing is trained until you say so)

This is the default subcommand: `ainize teach dataset <file>` runs it without naming `upload`.

**Arguments**

- **`<file>`** (`string`, required) — .jsonl · .json · .csv · .tsv · .txt with one question and its answer per row

**Options**

- **`--key`** (`string`) — teaching key (64-hex) — or NGRAM_TEACH_KEY
- **`--key-file`** (`string`) — the key backup JSON from the browser (ainize-teaching-key-….json); default: \<home>/teaching-key.json, created on first use
- **`--name`** (`string`) — name for the dataset (default: the file name)
- **`--format`** (`"jsonl" | "json" | "csv" | "tsv" | "txt"`) — override the detected format
- **`--delimiter`** (`string`) — csv/tsv separator when it is not detected (e.g. ";" or "\t")
- **`--header`** (`boolean`) — --no-header when the first row is already a question
- **`--columns`** (`string`) — JSON mapping when the column names are unusual: '{"prompt":0,"answer":2}'
- **`--encoding`** (`string`) — force an encoding (utf-8, euc-kr, …) when the preview looks like mojibake
- **`--retention`** (`"keep" | "delete_after_training"`) — delete_after_training removes the questions from this node as soon as the lesson finishes
- **`--train`** (`boolean`, default `false`) — queue a lesson from it right away
- **`--effort`** (`"quick" | "balanced" | "thorough"`) — with --train: how hard to train
- **`--check`** (`boolean`) — with --train: --no-check skips the side-effect check (publishing then stays blocked)
- **`--rows`** (`number`) — with --train: train only the first N questions

**Examples**

```bash
# validate + upload, print every line that will not train
ainize teach dataset ./questions.csv
# upload and teach it in one line
ainize teach dataset ./qa.jsonl --train --effort thorough
# unusual column names
ainize teach dataset ./data.csv --columns '{"prompt":"질문","answer":"답"}'
```

#### `ainize teach dataset ls`

```bash
ainize teach dataset ls [options]
```

My datasets on this node

**Options**

- **`--key`** (`string`) — teaching key (64-hex) — or NGRAM_TEACH_KEY
- **`--key-file`** (`string`) — the key backup JSON from the browser (ainize-teaching-key-….json); default: \<home>/teaching-key.json, created on first use

#### `ainize teach dataset get`

```bash
ainize teach dataset get <id> [options]
```

One dataset: every source line with the reason it was or was not used; -o writes the questions to a file

Also spelled `ainize teach dataset download`.

**Arguments**

- **`<id>`** (`string`, required)

**Options**

- **`--key`** (`string`) — teaching key (64-hex) — or NGRAM_TEACH_KEY
- **`--key-file`** (`string`) — the key backup JSON from the browser (ainize-teaching-key-….json); default: \<home>/teaching-key.json, created on first use
- **`--out`, `-o`** (`string`) — write the questions to this file (re-uploading it lands on the same dataset)
- **`--format`** (`"jsonl" | "csv"`, default `"jsonl"`) — download format (the .jsonl bytes are the fingerprint subject)
- **`--rows`** (`number`) — how many source lines to print (default 50, max 200)
- **`--offset`** (`number`) — start at this source line
- **`--status`** (`string`) — only lines with this status: ok|rejected|duplicate|conflict|too_long|empty|blocked|not_parsed|over_cap
- **`--all`** (`boolean`, default `false`) — print every line, not only the ones that will not train

**Examples**

```bash
# exactly what a lesson was trained on
ainize teach dataset get 6f2c… -o questions.jsonl
```

#### `ainize teach dataset rm`

```bash
ainize teach dataset rm <id> [options]
```

Delete a dataset (the lessons trained from it are kept)

**Arguments**

- **`<id>`** (`string`, required)

**Options**

- **`--key`** (`string`) — teaching key (64-hex) — or NGRAM_TEACH_KEY
- **`--key-file`** (`string`) — the key backup JSON from the browser (ainize-teaching-key-….json); default: \<home>/teaching-key.json, created on first use

### `ainize teach train`

```bash
ainize teach train <target> [options]
```

Teach a lesson from a dataset id or a dataset file

**Arguments**

- **`<target>`** (`string`, required) — dataset id (`ainize teach dataset ls`) or a dataset file, which is uploaded first

**Options**

- **`--key`** (`string`) — teaching key (64-hex) — or NGRAM_TEACH_KEY
- **`--key-file`** (`string`) — the key backup JSON from the browser (ainize-teaching-key-….json); default: \<home>/teaching-key.json, created on first use
- **`--effort`** (`"quick" | "balanced" | "thorough"`) — how hard to train (see `ainize teach status <node>`)
- **`--check`** (`boolean`) — --no-check skips the side-effect check on the live model (publishing then stays blocked until a recheck)
- **`--alt`** (`boolean`) — --no-alt trains only the wording in the file, not the second phrasing
- **`--rows`** (`number`) — train only the first N questions of the dataset
- **`--name`** (`string`) — name for the lesson (and for the dataset, when a file is uploaded here)
- **`--patch`** (`string`) — knowledge id(s) loaded while teaching, comma-separated — for comparison only
- **`--on`** (`string`) — the knowledge this lesson is trained ON TOP OF: its questions are kept as known answers, it is recorded as the base, and buyers need it too
- **`--inherit`** (`boolean`) — --no-inherit checks against the base without keeping its questions as known answers
- **`--yes-change`** (`boolean`, default `false`) — my answers are meant to replace the base's where they differ
- **`--wait`** (`boolean`, default `false`) — follow it until it is ready (prints each stage)

**Examples**

```bash
# train an uploaded dataset
ainize teach train 6f2c1b2a-…
# file → lesson in one line
ainize teach train ./questions.csv --effort quick --wait
# teach it on top of someone else's knowledge
ainize teach train 6f2c1b2a-… --on krx-all-2761
# the same questions again, harder
ainize teach train 6f2c1b2a-… --effort thorough
```

### `ainize teach jobs`

```bash
ainize teach jobs [options]
```

My lessons on this node and the dataset each came from

**Options**

- **`--key`** (`string`) — teaching key (64-hex) — or NGRAM_TEACH_KEY
- **`--key-file`** (`string`) — the key backup JSON from the browser (ainize-teaching-key-….json); default: \<home>/teaching-key.json, created on first use
- **`--dataset`** (`string`) — only lessons trained from this dataset

## `ainize dataset`

```bash
ainize dataset <subcommand>
```

Training sets: the questions a published knowledge was taught from (lineage design §13)

**Subcommands** — one of them is required

- `ainize dataset get` — The training set of a knowledge — what it is, and with -o the questions themselves

### `ainize dataset get`

```bash
ainize dataset get <id> [options]
```

The training set of a knowledge — what it is, and with -o the questions themselves

Also spelled `ainize dataset download`.

**Arguments**

- **`<id>`** (`string`, required) — knowledge id (`ainize patch ls`) or the sha256 of the training set

**Options**

- **`--key`** (`string`) — teaching key (64-hex) — or NGRAM_TEACH_KEY
- **`--key-file`** (`string`) — the key backup JSON from the browser (ainize-teaching-key-….json); default: \<home>/teaching-key.json, created on first use
- **`--out`, `-o`** (`string`) — write the questions to this file (.jsonl — re-uploadable with `ainize teach dataset <file>`)
- **`--manifest`** (`boolean`, default `false`) — also print the manifest: row origin, licence, benchmark hash, PII scan, declaration
- **`--include-notes`** (`boolean`, default `false`) — keep the publisher’s per-row notes in the written file (they are left out by default)

**Examples**

```bash
# access, licence, where it came from, and the first questions
ainize dataset get krx-all-2761
# the exact bytes, ready to build on
ainize dataset get krx-all-2761 -o questions.jsonl
```

## `ainize use`

```bash
ainize use <id> [options]
```

One line to use knowledge: check it is verified → pay automatically → download → load into your model

**Arguments**

- **`<id>`** (`string`, required) — knowledge id (see `ainize patch ls`)

**Options**

- **`--apply`** (`boolean`, default `true`) — load into the serving model after download (--no-apply to only download)

**Examples**

```bash
ainize use krx-all-2761
```

## `ainize chat`

```bash
ainize chat [patchId] [prompt…] [options]
```

Live-test a knowledge patch: the model's answer before vs after the patch is loaded (correct-answer check)

**Arguments**

- **`[patchId]`** (`string`) — patch to test (see --list); `a,b` loads several together
- **`[prompt…]`** (`string[]`) — question; omit for an interactive session (/quit to exit)

**Options**

- **`--list`, `-l`** (`boolean`, default `false`) — list patches testable on this node and the runtime state
- **`--patch`, `-p`** (`string`) — knowledge to load together, comma-separated (up to 3, in load order; the last wins where they overlap)
- **`--mode`, `-m`** (`"base" | "patched" | "compare"`, default `"compare"`) — base = model only, patched = with the patch loaded, compare = both
- **`--thinking`** (`boolean`, default `false`) — let the model think first and show its reasoning
- **`--max-tokens`** (`number`, default `200`) — answer length limit (1–1024)
- **`--system`** (`string`) — system prompt prepended to the conversation

**Examples**

```bash
# what can be tested here
ainize chat --list
# before/after in one shot
ainize chat pixelplus-087600 "Pixelplus ticker code? Digits only."
# interactive session with the patch loaded
ainize chat krx-all-2761 --mode patched
# two knowledges loaded together (up to 3)
ainize chat --patch krx-all-2761,pixelplus-087600 "픽셀플러스 종목코드 알려줘. 숫자만."
```

## `ainize ledger`

```bash
ainize ledger <subcommand>
```

Inspect the ledger

**Subcommands** — one of them is required

- `ainize ledger ls` — List records
- `ainize ledger verify` — Verify hashes, signatures and chain linkage
- `ainize ledger graph` — ASCII lineage tree
- `ainize ledger export` — Export records as JSON lines

### `ainize ledger ls`

```bash
ainize ledger ls [options]
```

List records

**Options**

- **`--kind`** (`"anchor" | "attest" | "settle" | "challenge" | "branch" | "node" | "supersede" | "subscribe"`) — only this kind of record
- **`--limit`** (`number`, default `50`)

### `ainize ledger verify`

```bash
ainize ledger verify
```

Verify hashes, signatures and chain linkage

### `ainize ledger graph`

```bash
ainize ledger graph
```

ASCII lineage tree

### `ainize ledger export`

```bash
ainize ledger export <file>
```

Export records as JSON lines

**Arguments**

- **`<file>`** (`string`, required)

## `ainize branch`

```bash
ainize branch <subcommand>
```

Knowledge branches (parallel, possibly contradictory patch sets)

**Subcommands** — one of them is required

- `ainize branch ls` — List branches
- `ainize branch create` — Create a branch
- `ainize branch add` — Add a patch to a branch you own
- `ainize branch subscribe` — Subscribe this node (acquire + apply the branch's patches)
- `ainize branch unsubscribe` — Unsubscribe (restore rows)

### `ainize branch ls`

```bash
ainize branch ls
```

List branches

### `ainize branch create`

```bash
ainize branch create <name> [options]
```

Create a branch

**Arguments**

- **`<name>`** (`string`, required)

**Options**

- **`--description`** (`string`)
- **`--context`** (`string[]`) — k=v routing attributes (e.g. jurisdiction=KR)
- **`--patch`** (`string[]`) — patch id(s) in the branch

**Examples**

```bash
ainize branch create law/KR --context jurisdiction=KR --patch law-kr-2025
```

### `ainize branch add`

```bash
ainize branch add <name> <patchId>
```

Add a patch to a branch you own

**Arguments**

- **`<name>`** (`string`, required)
- **`<patchId>`** (`string`, required)

### `ainize branch subscribe`

```bash
ainize branch subscribe <name>
```

Subscribe this node (acquire + apply the branch's patches)

**Arguments**

- **`<name>`** (`string`, required)

### `ainize branch unsubscribe`

```bash
ainize branch unsubscribe <name>
```

Unsubscribe (restore rows)

**Arguments**

- **`<name>`** (`string`, required)

## `ainize route`

```bash
ainize route <context…>
```

Gateway routing: which branch/nodes serve a request context

**Arguments**

- **`<context…>`** (`string[]`, required) — k=v pairs

**Examples**

```bash
ainize route jurisdiction=KR
```

## `ainize wallet`

```bash
ainize wallet
```

Balance, sales, royalties and pending payouts of this node

## `ainize payouts`

```bash
ainize payouts <subcommand>
```

Royalty transfers this node owes creators and data providers (AIN ledger)

**Subcommands**

- `ainize payouts ls` — List payouts
- `ainize payouts retry` — Retry one failed / pending payout now

### `ainize payouts ls`

```bash
ainize payouts ls [options]
```

List payouts

This is the default subcommand: `ainize payouts` runs it without naming `ls`.

**Options**

- **`--status`** (`"pending" | "paid" | "failed"`)
- **`--address`** (`string`) — only this recipient
- **`--limit`** (`number`)

**Examples**

```bash
ainize payouts ls --status failed
```

### `ainize payouts retry`

```bash
ainize payouts retry <id>
```

Retry one failed / pending payout now

**Arguments**

- **`<id>`** (`number`, required)

## `ainize drive`

```bash
ainize drive <subcommand>
```

aindrive: files & change history of this node

**Subcommands** — one of them is required

- `ainize drive status` — Drive status (pairing, agent, files)
- `ainize drive up` — Start the aindrive agent for the node's drive folder
- `ainize drive stop` — Stop the aindrive agent
- `ainize drive sync` — Rewrite the drive mirror from the current market state
- `ainize drive login` — One-time browser pairing of the drive folder (interactive)

### `ainize drive status`

```bash
ainize drive status [options]
```

Drive status (pairing, agent, files)

**Options**

- **`--files`** (`boolean`, default `false`)

### `ainize drive up`

```bash
ainize drive up
```

Start the aindrive agent for the node's drive folder

### `ainize drive stop`

```bash
ainize drive stop
```

Stop the aindrive agent

### `ainize drive sync`

```bash
ainize drive sync
```

Rewrite the drive mirror from the current market state

### `ainize drive login`

```bash
ainize drive login [options]
```

One-time browser pairing of the drive folder (interactive)

**Options**

- **`--server`** (`string`)
- **`--name`** (`string`) — drive name
- **`--open`** (`boolean`, default `true`) — open the browser for the pairing login (--no-open prints the link only)

## `ainize chain`

```bash
ainize chain <subcommand>
```

Local AIN blockchain (docker) for the ain ledger

**Subcommands** — one of them is required

- `ainize chain up` — Start (or attach to) a local 1-node AIN chain on :8081
- `ainize chain down` — Remove the local chain container
- `ainize chain status` — Chain health and last block
- `ainize chain fund` — Transfer AIN from the local genesis account (local chain only)
- `ainize chain setup` — Register the knowledge app + market rules on-chain (funds the node identity first on a local chain)

### `ainize chain up`

```bash
ainize chain up [options]
```

Start (or attach to) a local 1-node AIN chain on :8081

**Options**

- **`--wait`** (`number`, default `90`) — seconds to wait for SERVING

### `ainize chain down`

```bash
ainize chain down
```

Remove the local chain container

### `ainize chain status`

```bash
ainize chain status [options]
```

Chain health and last block

**Options**

- **`--provider`** (`string`)

### `ainize chain fund`

```bash
ainize chain fund <address> [amount] [options]
```

Transfer AIN from the local genesis account (local chain only)

**Arguments**

- **`<address>`** (`string`, required)
- **`[amount]`** (`number`, default `1000`)

**Options**

- **`--provider`** (`string`)

### `ainize chain setup`

```bash
ainize chain setup [options]
```

Register the knowledge app + market rules on-chain (funds the node identity first on a local chain)

**Options**

- **`--fund`** (`number`) — AIN to fund the node identity with
