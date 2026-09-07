---
title: Run a node others can reach
summary: The interface a node binds, the address it hands to peers, the roles it claims, and how to tell a peer that is missing from a peer that is silent.
---

# Run a node others can reach

A node that answers on your own machine is not yet on the network. Three settings decide whether anyone else can
find it, talk to it and hand it work: the interface it binds, the address it tells every other node to use, and the
roles it claims. This page is about getting those three right, and about reading the two tables that tell you
whether it worked.

It assumes a node that already starts and answers `ainize status`. Everything below was run against three nodes on
one machine — a seller on port 3634 and two verifiers on 3635 and 3636 — so every address in the output below is a
localhost address, and the throwaway home directories have been shortened to `~/.ainize` for reading. Nothing else in
the pasted output has been touched.

## `host` binds. `publicUrl` is what peers write down

These are two different things and confusing them is the single commonest reason gossip does not work.

`host` is the interface the HTTP server binds. It defaults to `0.0.0.0`, every interface on the machine, which is
almost always what you want; set it to `127.0.0.1` to make the node deliberately local.

```bash
ainize config get host
```

```text
0.0.0.0
```

`publicUrl` is the address the node hands out. Nothing about it is discovered: it is a string the node repeats to
everyone. When it is unset the node calls itself `http://localhost:<port>`.

```bash
ainize config get publicUrl
```

```text
publicUrl is not set in ~/.ainize/config.json (the node uses its built-in default)
```

That one string travels further than you might expect. It is the `endpoint` in the introduction a node sends to
every peer, it is the first entry a node returns from `/p2p/peers` when peers ask it who else it knows, it is the
`gateway_url` written into every anchor the node announces — the address a buyer's [payment](../concepts/payment.md)
is sent to — and it is the first of the `blob_urls` a buyer is told to download from. A node whose `publicUrl` is `http://localhost:3402` is telling the entire network to connect to
*their own* machine on port 3402.

To see what a wrong one does, a verifier here was given a hostname only its own machine believes in:

```bash
ainize config set publicUrl http://verifier2.internal:3636
ainize stop && ainize start -d
```

Within one gossip round the seller had written it down:

```text
known nodes
NAME           ADDRESS          ENDPOINT                        ROLES     LEDGER  BRANCHES  BLOBS  LAST SEEN
─────────────  ───────────────  ──────────────────────────────  ────────  ──────  ────────  ─────  ───────────────────
seller (self)  0xd87230db…78c9  http://localhost:3634           seller    local   -             0  2026-09-04 11:48:44
verifier1      0x6dEb3Aa0…4d23  http://localhost:3635           verifier  local   -             0  2026-09-04 11:48:42
verifier2      0x99b6B478…d4C7  http://verifier2.internal:3636  verifier  local   -             0  2026-09-04 11:48:41
```

and had already passed it on. The third node, which had never heard of that hostname either, learned it from the
seller and started failing against it:

```text
ENDPOINT                        ADDRESS          LAST SEEN            FAILURES
──────────────────────────────  ───────────────  ───────────────────  ────────
http://verifier2.internal:3636  0x99b6B478…d4C7  2026-09-04 11:49:25         1
```

The node itself was healthy the whole time. Only the address it published was wrong, and a wrong address propagates
exactly as well as a right one.

> [!WARNING]
> Set `publicUrl` **before you announce anything.** The address is copied into each anchor as its `gateway_url` at
> the moment you announce it, and an anchor on the ledger is immutable. Change `publicUrl` afterwards and every
> knowledge you have already published still points buyers at the old address.

Set it to the address other machines will use, restart, and check the `gateway` line of anything you publish:

```bash
ainize config set publicUrl https://ainize.example.com
ainize stop && ainize start -d
```

`AINIZE_PUBLIC_URL` sets the same thing for one run without touching `config.json` — useful in a container. Both are
in the [configuration reference](../reference/config.md#keys).

## Seed one peer; peer exchange does the rest

You never have to list the whole network. A node introduces itself to the peers it knows, asks each of them who
*they* know, and adds the answers. There are three places a seed can come from, and they persist differently:

| Where | What it does | Survives a restart |
|---|---|---|
| `ainize init --peer <url>` | writes the URL into `config.json` before the node exists | yes |
| `ainize start --peer <url>` | adds it for that run only | no |
| `ainize peers add <url>` | adds it to the running node *and* writes it to `config.json` | yes |

One direction is enough. Here only the two verifiers were told about the seller:

```bash
ainize start -d --peer http://localhost:3634
```

```text
✓ node started in the background (pid 663842) — port 3635
  logs: ~/.ainize/node.log   stop: ainize stop
```

The seller was told about nobody, and within a few seconds knew both of them anyway — because a node that says hello
is recorded by the node it says hello to, under the endpoint it gave:

```text
configured peers
ENDPOINT               ADDRESS          LAST SEEN            FAILURES
─────────────────────  ───────────────  ───────────────────  ────────
http://localhost:3635  0x6dEb3Aa0…4d23  2026-09-04 11:47:58         0
http://localhost:3636  0x99b6B478…d4C7  2026-09-04 11:47:57         0
```

The same mechanism is why a bad seed is expensive. An endpoint you add is handed to every peer that asks, and they
hand it on; nothing ever expires it, and `ainize peers rm` on one node does not stick while any other peer still
gossips it back. Add addresses you have checked.

## Telling "not peered" from "peered and silent"

`ainize nodes` prints two tables and the difference between them is the whole diagnosis. **Known nodes** is every
node this one has heard of — from an exchange with a peer, or from a registration on the ledger — with the last time
it was seen. **Configured peers** is every endpoint this node is trying, whether or not anything ever answered.

```bash
ainize nodes
```

```text
known nodes
NAME           ADDRESS          ENDPOINT               ROLES     LEDGER  BRANCHES  BLOBS  LAST SEEN
─────────────  ───────────────  ─────────────────────  ────────  ──────  ────────  ─────  ───────────────────
seller (self)  0xd87230db…78c9  http://localhost:3634  seller    local   -             0  2026-09-04 11:47:58
verifier1      0x6dEb3Aa0…4d23  http://localhost:3635  verifier  local   -             0  2026-09-04 11:47:58
verifier2      0x99b6B478…d4C7  http://localhost:3636  verifier  local   -             0  2026-09-04 11:47:57

configured peers
ENDPOINT               ADDRESS          LAST SEEN            FAILURES
─────────────────────  ───────────────  ───────────────────  ────────
http://localhost:3635  0x6dEb3Aa0…4d23  2026-09-04 11:47:58         0
http://localhost:3636  0x99b6B478…d4C7  2026-09-04 11:47:57         0
http://localhost:3699  -                -                          10
```

Read it this way:

- **Nothing at all in *configured peers*** — the node was never told about anyone, and nobody has said hello to it.
  Seed it.
- **A row with an address and a recent LAST SEEN** — that peer is reachable and gossip is flowing.
- **A row with `-` for both and a climbing FAILURES** — the address is configured and nothing is there. That is
  `http://localhost:3699` above: a peer added by hand that never existed. Every gossip round adds one to the count,
  for ever; nothing evicts it.
- **A node in *configured peers* but missing from *known nodes*** — you are dialling an address that does not answer
  as that node. This is the shape a wrong `publicUrl` makes.

A row never leaves *known nodes*: a node that registered on the ledger once stays in the list for ever. What tells you
it has gone away is its LAST SEEN falling behind everyone else's.

`ainize peers ls` is the same peer list on its own, and names the ones that have never answered:

```text
ENDPOINT                        NAME         ADDRESS          ROLES     LAST SEEN            FAILURES
──────────────────────────────  ───────────  ───────────────  ────────  ───────────────────  ────────
http://localhost:3635           verifier1    0x6dEb3Aa0…4d23  verifier  2026-09-04 11:56:26         0
http://localhost:3699           (unreached)  -                -         -                          99
```

> [!NOTE]
> FAILURES counts only this node's own outbound attempts, and any hello received from that peer resets it to zero. A
> peer that calls you but never answers when called therefore reads as healthy in this column. When in doubt, trust
> the *known nodes* table: it is built from exchanges that completed.

## Which roles each job actually needs

`roles` is a list, `seller,verifier,serving,gateway`, and `init` writes the first three. It is worth knowing which
of them change the node's behaviour, because two of them are announcements and two of them are switches.

| Role | What the node does with it |
|---|---|
| `verifier` | Starts the verification loop, which is what writes attestations for other people's knowledge. `ainize patch verify` refuses without it. Peers also use it: a node that advertises `verifier` may download a patch body it has not bought, because a verifier cannot check what it cannot load. |
| `serving` | Declares that this node has a model to load knowledge into. `/readyz` demands a working runtime because of it. |
| `seller` | Advertised to peers and shown in `ainize nodes`. Nothing in the node reads it. |
| `gateway` | Advertised. Nothing in this build reads it. |

The consequence to plan around is that `verifier` and `serving` both make the runtime a *readiness requirement*.
Dropping `serving` alone does not lift it. This node, with all three, had no model server:

```bash
ainize status --check
```

```text
✗ seller  http://localhost:3634  NOT READY
ledger   ok · local · height 1
runtime  serving API unreachable
peers    0 configured
```

The same node with `roles` set to `seller` alone:

```bash
ainize config set roles seller
ainize stop && ainize start -d
ainize status --check
```

```text
✓ seller  http://localhost:3634
ledger   ok · local · height 2
runtime  not required by this node's roles
peers    0 configured
```

So a machine with no GPU can be a perfectly healthy seller. What it gives up by dropping `serving` and `verifier` is
everything that needs a model: it cannot live-test knowledge, and it cannot verify anyone else's, which means it
contributes nothing to the [quorum](../concepts/verification.md) the network needs to list knowledge — including its
own.

> [!IMPORTANT]
> Roles are a claim, not a permission. Advertise only what the node is really doing: peers decide what to hand it
> partly on the strength of that list.

## Run it detached, and watch it

`ainize start -d` forks the node, writes its pid to `AINIZE_HOME/node.pid` and everything it prints to
`AINIZE_HOME/node.log`. It waits for the child to answer before it claims success, so a green tick means the node
really is listening.

```bash
ainize start -d
```

```text
✓ node started in the background (pid 668391) — port 3634
  logs: ~/.ainize/node.log   stop: ainize stop
```

`ainize stop` reads that pid file, sends SIGTERM, waits, and escalates to SIGKILL if it has to. If the pid file is
gone but something is still serving the port, `stop` says so rather than pretending.

For the network layer specifically, filter the event log by kind:

```bash
ainize logs --kind p2p --limit 10
```

```text
2026-09-04 11:47:42 info  node      node started (local ledger, roles verifier)
2026-09-04 11:47:42 info  p2p       synced 2 record(s) from seller (http://localhost:3634)
2026-09-04 11:47:46 info  p2p       synced 1 record(s) from seller (http://localhost:3634)
```

Add `-f` to follow. An empty result is information too: a peered node with nothing to say has nothing to sync.

The one line to give a monitor or a deploy script is `ainize status --check`. It asks the node's own `/readyz`,
prints three checks and sets an exit code: **0** ready, **1** answering but not ready, **2** not answering at all.

```bash
ainize status --check
```

```text
✗ seller  http://localhost:3634  NOT READY
ledger   ok · local · height 21
runtime  serving API unreachable
peers    4 configured · 2 unreachable
```

`--json` gives the same three checks in a shape a script can read:

```bash
ainize status --check --json
```

```json
{
  "ok": false,
  "node": "seller",
  "address": "0xd87230db2F21b5f5b998255A0DA0015f377878c9",
  "version": "0.1.0",
  "checks": {
    "ledger": { "ok": true, "kind": "local", "height": 21, "records": 21 },
    "runtime": { "ok": false, "required": true, "available": false, "model": null, "error": "serving API unreachable" },
    "peers": { "ok": true, "configured": 4, "unreachable": 2 }
  }
}
```

Note that the peers check never fails the node. Unreachable peers are reported, never fatal — a node with no peers
at all is still ready, because it is still able to serve everything it already holds. Only the ledger and the
runtime can turn the light red.

Do not point a monitor at `/healthz`: it answers 200 whenever the process is alive, model server or no model server.
The other names a monitor might guess — `/health`, `/ready`, `/status`, `/metrics` — answer 404 on purpose, so that
nothing reads the web application's own HTML as a green light.
