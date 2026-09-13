# Teach, publish and serve from your own node

There is no central registry to apply to. Every node keeps its own ledger, and P2P gossip carries records
between peers — so "publishing to the marketplace" is a node writing an anchor to its own ledger and letting
it spread. `ainize.ai` is an entry point, not an authority.

```
your node                                    peers (incl. ainize.ai)
  teach train      trained on YOUR GPU
  teach publish    anchor written to YOUR ledger
       │ gossip, ~10 s
       └──────────────────────────────────▶  anchor appears in their catalogue
                                             verifiers run the benchmark themselves
       ◀──────────────────────────────────   attestations gossip back
  quorum met  ──▶  LISTED, and on sale everywhere the anchor reached
```

## 0. Join

```bash
ainize init --name my-node \
  --peer https://ainize.ai \
  --private-key <hex>              # optional; omitted, a NEW identity is minted
ainize start -d
ainize login
```

**Verified:** one `--peer` is enough. A fresh node given only `https://ainize.ai` discovered the other peers
and received ledger records within ~12 seconds — peer exchange finds the rest.

**The private key is the node's identity.** It signs the anchors it publishes, the attestations it makes, and
it is the address sales are paid to. It lives in `config.json` (mode 600) and that is the only copy. Import an
existing one with `--private-key`, or back the generated one up immediately:

```bash
ainize keys backup ~/node-key.enc --passphrase <…>
```

Changing it later orphans everything the old identity published.

## 1. Teach

Two identities are involved and they are not the same thing:

| | what it is | how it is used |
|---|---|---|
| **node operator** | the password set at `init` | `ainize login`; approves and publishes on THIS node |
| **teaching key** | a contributor key, 64-hex | `--key` / `AINIZE_TEACH_KEY`; credits the lesson to you |

A teaching key means you can teach on **someone else's** node — the lesson is credited to your key and the
node's operator decides whether to publish it. On your own node you are both.

```bash
ainize teach dataset upload questions.csv     # validates first, prints every line it will use
ainize teach train <dataset-id> --key <hex>
ainize teach jobs                             # watch it reach READY
```

The node must be configured to accept lessons. Check with `ainize teach status <node-url>`; the operator
turns it on:

```bash
ainize config set teach.enabled true
ainize config set teach.backend gradient      # a real trainer, not the stub
ainize config set teach.lineage true          # optional: allow training ON TOP of existing knowledge
ainize stop && ainize start -d                # a running node keeps the values it started with
```

`teach.backend: gradient` needs a trainer container and free GPU memory (`teach.trainer` in `config.json`:
container, script, `minFreeGpuMb`). Without it, `stub` produces a lesson that **cannot be published as real**
— the publish path refuses stub-backed work, deliberately.

## 2. Publish

```bash
ainize teach publish <job-id>
```

What happens next depends on one setting, `teach.publish`:

| value | effect |
|---|---|
| `auto` | announced immediately |
| `review` | `PENDING_REVIEW` — the operator approves: `POST /api/me/teach/jobs/<id>/approve` |
| `never` | the node accepts lessons but publishes nothing |

Then it is out of your hands and in the network's:

```
announced  ──gossip──▶  peers see the anchor
                        each verifier applies the patch and runs the benchmark ITSELF
                        signed attestations gossip back
quorum reached  ──▶  LISTED
```

### Selling before anyone has verified it

A seller's node can allow its knowledge to be bought while it is still `ANNOUNCED`:

```bash
ainize config set verifier.sellUnverified true
ainize stop && ainize start -d
```

**The status does not change.** It stays `ANNOUNCED`, never `LISTED`. Verification is the one quality signal
this marketplace has, and a status claiming "verified" when nobody checked would be worth less than no status
at all — so what this setting buys is a buyer's informed choice, not a relabelling.

The buyer is warned and must confirm:

```
! krx-codes-v3 is ANNOUNCED, NOT verified — 0/2 independent attestations.
    · its benchmark score is the seller's own claim until a verifier reproduces it
    · nobody independent has checked whether loading it damages unrelated answers
    · watch it instead: ainize patch get krx-codes-v3 — quorum is 2
  Buy krx-codes-v3 unverified, at your own risk? [y/N]
```

`--yes` answers it for a script, and the warning still prints — an unattended run should leave a record of
what it accepted.

**Quorum is 2** — two *independent* verifiers. Two rules make it mean something:

- **you cannot verify your own knowledge** (`verifier.allowSelfAttest: false`)
- **nodes sharing one runtime count as one.** Three nodes in front of the same vLLM are a single independent
  check, because running the same model twice is not a second opinion.

**If you publish, you need a reachable address.** A verifier fetches your patch body from your node over
`/p2p/blob/:sha`, so a node that advertises only `localhost` can publish an anchor nobody can verify:

```bash
ainize init … --public-url https://my-node.example.com --host 0.0.0.0
```

`--host 0.0.0.0` belongs behind a proxy or a firewall. A node on every interface with no operator password is
claimed by whoever reaches it first.

## 3. Serve (inference)

**Inference is local to whoever holds the knowledge.** Buying does not call the seller's model — it downloads
the patch and loads it into *your* runtime. The seller's node is a source of bytes, not a service.

Give a node a runtime and the `serving` role:

```bash
ainize config set runtime.api http://localhost:8002   # an OpenAI-compatible server with the PLE hook
ainize config set roles seller,verifier,serving
ainize stop && ainize start -d
ainize status                                          # runtime.available must be true
```

Then:

```bash
ainize patch ls --node https://ainize.ai --status LISTED -q "<topic>"
ainize use <id>                       # quote → pay (x402) → download → load, no restart
ainize chat <id> "your question"      # answers before and after the patch, side by side
```

Or in one line, if the knowledge has an ENS name:

```bash
ainize patch vaults.defi.engram.eth
```

`runtime.available: false` means the node cannot reach its serving API. It can still sell and gossip; it
cannot verify anything (verification runs the benchmark) and it cannot answer a live test.

## What each role costs you

| role | what the node does | needs |
|---|---|---|
| `seller` | publishes and sells its own knowledge | a reachable `publicUrl` for blob fetches |
| `verifier` | runs other nodes' benchmarks, signs attestations | a working runtime |
| `serving` | applies patches and answers | a runtime with the PLE hook |
| `gateway` | x402 payment endpoints | — |

A node that only wants to *buy and use* knowledge needs `serving` and nothing else.
