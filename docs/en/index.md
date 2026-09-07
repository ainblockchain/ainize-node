---
title: Ainize
summary: Bake what you look up into what the model knows — and trade it node to node.
---

# Ainize

**Ainize** (ai·nize = AI + -ize, "make it usable by AI") turns knowledge into something a running model actually
knows. You find a piece of knowledge, ask the model the same question before and after loading it, keep it if the
answer changed, and remove it whenever you like. Publish knowledge of your own and independent nodes have to load it
into the real model and score it before it can sell; you are paid per sale. The first three letters, **AIN**, are the
AI Network that records the payments, the permissions and where each piece came from.

A node is one process. The same program serves the marketplace website, the HTTP API and the `ainize` command line,
so there is no separate web application to deploy and nothing to keep in sync.

## The three surfaces

| Surface | What it is | Who reaches for it |
|---|---|---|
| The site | Every node serves it at its own address — `http://localhost:3402` by default. Explore, live test, teach, the public record. | Anyone using knowledge, and anyone teaching the model without writing code. |
| The CLI | `ainize` — the same commands the site calls, plus the ones that run a node: `init`, `start`, `status`, `publish`, `use`. | Whoever runs the node, and anyone scripting against it. |
| The MCP server | `packages/mcp` — an [MCP](https://modelcontextprotocol.io) server that lets an agent search, live-test, buy and teach. | An AI agent working on your behalf. |

## Check that a node is answering

Two routes to the same fact, so use whichever you already have open.

:::tabs
::tab CLI
This route needs the `ainize` command, and there is no package to install it from — `npm install -g ainize` cannot
work, because the name is not on npm. It is built from a checkout, which is what [Installation](./get-started/install.md)
does; start there if you have not. With the command on your machine, point it at a node — with `AINIZE_HOME` set to that
node's home directory, or with `--node <url>` — and ask it for its own summary:

```bash
AINIZE_HOME=~/.ainize ainize status
```

```text
teachable-u  http://localhost:3422  (pid 518612)
address     0xf6FFc20B46421d11057088242a34369aa8B18CA6
roles       seller, serving
version     0.1.0 · built 2026-09-04 10:50:46
ledger      local · local · 369 records · height 369
runtime     available · Qwen3.8-Flash-Next · hook ok
peers       0
patches     160 (0 listed)
quorum      2
currency    CREDIT
branches    -
blobs held  160
```

Those numbers are one particular node's; yours will differ. The line that decides whether anything else will work is
`runtime` — `available` means the model is up and knowledge can actually be loaded into it.

Before you have made a node there is nothing at that address to summarise, and the same command says so rather than
failing obscurely:

```text
error: no node configured in ~/.ainize — run `ainize init` to create one, or pass --node <url> to talk to an existing node
```
::tab Browser
Open the node's own address, `http://localhost:3402` unless you moved it. If the page loads, that node is answering:
it is the one serving the page you are reading.

The badge next to the logo says which record the node writes to — **AI Network** for the blockchain, **P2P** for the
local log — which is the same thing the CLI prints on its `ledger` line.
:::

## The words these pages use

Ainize deliberately avoids naming things after the machinery, because you can buy and use knowledge without ever
meeting a memory table. The technical name is given here once, and then these pages use the plain one.

| Plain word | Technical name | What it means |
|---|---|---|
| knowledge | knowledge patch — rows of an n-gram memory table | A bundle you can plug into a model and pull back out. |
| learned memory entries | `rows` — table addresses the patch touches | How many memory entries it changes. Not a sentence count. |
| live test | base vs patched completion | The same question asked before and after loading, side by side. |
| verified | verifier quorum reached | Independent nodes loaded it into the real model and scored it. |
| node | marketplace peer | A participant server. You do not need to run one to buy knowledge. |
| automatic payment | HTTP 402 / x402 | Being quoted a price and paying it without an account or a checkout. |
| public record | ledger | Who registered, verified and bought what — checkable by anyone. |
| creator revenue share | lineage royalties | Knowledge built on someone else's pays them a share of every sale. |

> [!NOTE]
> **These pages are being written one at a time, and nothing empty is listed in the navigation on the left.** Where a
> topic has no page yet, the software still documents itself: `ainize --help` prints every command and every
> option, a running node serves its own API specification at `/api/openapi.json`, and the MCP server is documented
> next to its code in `packages/mcp/README.md`.
