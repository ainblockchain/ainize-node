---
title: Installation
summary: Get the `ainize` command onto your machine from a checkout of this repository, and learn where a node keeps itself.
---

# Installation

At the end of this page you have one command, `ainize`, and a directory it will keep a node in. Nothing here needs a
GPU or a model — that comes on the next page. Ten minutes, most of it waiting for `npm install`.

> [!NOTE]
> Every block below is a command that was run and the output it printed. The one edit is to absolute paths: the
> machine this was recorded on keeps its scratch directories somewhere long and uninteresting, so a node's home
> directory appears as `<AINIZE_HOME>` and a file beside it as `~/…`. Nothing else is changed, and nothing is invented.

## First, Node 24

Ainize is written for Node 24 and the repository says so out loud — the root `package.json` carries
`"engines": { "node": ">=24" }`, and every workspace under `packages/` is built by it. Check what you have:

```bash
node --version
```

```text
v24.20.0
```

If that prints a lower number, install Node 24 before going on; `npm` arrives with it, so there is nothing else to
fetch. If you installed Node under your home directory instead of system-wide, its `bin` has to be on your `PATH`
before `node` and `npm` resolve to that copy:

```bash
export PATH="$HOME/.local/node/bin:$PATH"
```

## There is no package to install

The first thing most people try does not work, so try it here rather than later:

```bash
npm view ainize version
```

```text
npm error code E404
npm error 404 Not Found - GET https://registry.npmjs.org/ainize - Not found
npm error 404
npm error 404  The requested resource 'ainize@*' could not be found or you do not have permission to access it.
```

The name is not registered on npm, and `packages/cli/package.json` is marked `"private": true`, so it cannot be
published there by accident either. **`npm install -g ainize` cannot work, today or by a typo.** Ainize is installed
from a checkout of its own repository, which is what the rest of this page does. Anything you read anywhere that
tells you to install it from a registry is out of date.

## Build the repository

Start from the root of the checkout — however you came by it, a clone or an archive or a shared directory. The root
is the one holding a `package.json` whose name is `knowledge-marketplace`, next to `packages/` and `docs/`.

```bash
npm install
npm run build
```

`npm install` installs once for the whole repository: it is a set of npm workspaces, so `core`, `node`, `cli`, `web`
and `agent` share a single dependency tree and a single lockfile. `npm run build` then compiles the TypeScript of each
package into its `dist/`, and builds the web site the node serves. Both are slow the first time and fast afterwards.

## Put `ainize` on your PATH

The build produced `packages/cli/dist/bin.js`. There are two ways to reach it, and the difference is only whether the
command works outside the repository. Pick one and keep it.

:::tabs
::tab Link it

```bash
npm link -w packages/cli
```

```text
added 1 package, and audited 3 packages in 288ms

found 0 vulnerabilities
```

This puts a symlink in your npm global `bin` pointing back at `packages/cli/dist/bin.js` inside your checkout —
nothing is copied. A later `npm run build` therefore updates the command in place, with no reinstall step.

Two names appear, not one: `ainize` and `ngram`. They are the same program under the historical name and the current
one, so anything written for either runs on the other.

::tab Don't link it

Skip the link and use `npx` instead, inside the repository:

```bash
npx ainize --version
```

```text
0.1.0
```

`npx` finds the binary through the workspace symlink `node_modules/.bin/ainize`, which exists because `packages/cli`
is a workspace of this repository — so this works in the checkout and nowhere else. Outside it, `npx ainize` goes
looking for a package called `ainize` on the registry and fails with the 404 above.

Every command in these pages is written as `ainize …`. If you chose this route, put `npx` in front of each one.
:::

Either way, one line says whether you are done:

```bash
ainize --version
```

```text
0.1.0
```

## Where a node lives: `AINIZE_HOME`

A node keeps everything it is in a single directory: its key, its settings, its ledger and the knowledge it holds.
`AINIZE_HOME` names that directory. Leave it unset and it is `~/.ainize`; set it, and that is the node you are talking
to for the rest of the session.

```bash
export AINIZE_HOME=~/nodes/quickstart
```

One directory is one node. Two nodes on one machine means two directories and two ports — which is exactly how the
transcript on the next page was recorded. The `--home` option does the same thing for a single command
(`ainize --home ~/nodes/other status`), and every command accepts it.

`ainize init` creates the directory, and straight afterwards it holds only what `init` itself wrote:

```bash
ls -1 "$AINIZE_HOME"
```

```text
config.json
data
```

The rest arrive as the node is used, so the same listing on a node that has been started and logged in to has five
entries rather than two:

```text
cli.json
config.json
data
node.log
node.pid
```

| Entry | Written by | What it is |
|---|---|---|
| `config.json` | `ainize init` | The node itself — its private key and address, its port and roles, which ledger it writes to, its prices, and where its serving model is. Every key in it is listed in the [configuration reference](../reference/config.md). |
| `data/` | the node, as it runs | Ledger records, the bodies of the knowledge it holds, datasets, logs of who bought what. |
| `node.log` · `node.pid` | `ainize start --detach` | Where a background node writes and how `ainize stop` finds it again. |
| `cli.json` | `ainize login` | Your operator token, and the node URL the CLI talks to. Not the node's identity — this one you can delete and remake. |

> [!WARNING]
> **`config.json` holds the only copy of the node's private key**, and that key owns everything the node publishes,
> its balance and its payouts. There is no recovery and no reset. Back it up before you publish anything:
>
> ```bash
> ainize keys backup ~/node-key.json --passphrase "a long passphrase you can remember"
> ```
>
> ```text
> ✓ node key of quickstart (0x9d9da8f0C939c0cE4909ef44B73BeDffF740e77A) written to ~/node-key.json
>   encrypted (scrypt + aes-256-gcm) — without the passphrase this file is useless, including to you
>   restore it on another machine with `ainize keys import ~/node-key.json`
> ```

## Next

You have the command; the next page starts a node with it, points it at a model, and watches an answer change:
[Quickstart](./quickstart.md).

If instead you want to know what a flag does, that is the other half of this site — the
[CLI reference](../reference/cli.md) lists every command and option, generated from the CLI's own declarations, and
the [configuration reference](../reference/config.md) does the same for the file you just read about.
