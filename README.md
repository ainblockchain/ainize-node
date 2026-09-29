# ainize-node — the node

A node is the whole product in one process: it serves the model, trains lessons people teach it,
publishes and sells knowledge patches, verifies other nodes' patches before they can sell, and gossips
with its peers. It also serves the operator console and Teach mode over HTTP.

Part of [Ainize](https://github.com/ainblockchain/ainize), a **Collaborative Foundation Model**.

```bash
npm install && npm run build
npx ainize init --name my-node     # the key this writes into config.json IS the node — back it up
npx ainize start                   # http://localhost:3402
```

The node home is `AINIZE_HOME` (default `~/.ainize`); `config.json` there is the only copy of the
node's identity.

## What it exposes

| | |
|---|---|
| `/api/*` | the node API — catalogue, chat, teach, peers, operator routes |
| `/api/agents` · `/agents/{id}` | the agent catalogue and each agent's A2A address — config agents, agents the node runs, agents people [linked by URL](docs/superpowers/specs/2026-09-29-linked-agents-design.md), peers' agents. `?org=` narrows to one organization's |
| `/api/orgs` | [organizations](docs/superpowers/specs/2026-09-29-organizations-design.md): a team's page and README, members by AIN SSO email domain or invite with roles, resource groups, audit log, billing and security tabs, and the agents registered under it (private ones listed to members only). `AINIZE_ORG_SEED="comcom=ComCom:comcom.ai"` seeds one at boot |
| `/api/openapi.json` | OpenAPI 3.1, generated from the routes themselves |
| `/docs` | the reference, served by the node |
| `/x402/patch/{id}` | paid download: 402, pay, fetch |
| `/p2p/*` | what peers ask each other |

The explorer UI is a separate build ([ainize-web](https://github.com/ainblockchain/ainize-web)); point
`webDist` at it to have this process serve it too.

## Calling it like OpenAI, paid for by stake

Set a `backends` block and the node also serves OpenAI's shapes at `/v1` — chat, transcription and image
generation — beside its own `/api/chat`. A caller installs one package and writes the code they already know:

```python
import ainize

client = ainize.connect("https://node.example", private_key="0x…")   # returns a real openai.OpenAI
client.chat.completions.create(model="qwen3.8-flash-next", messages=[{"role": "user", "content": "hello"}])
client.audio.transcriptions.create(model="qwen3-asr", file=open("note.flac", "rb"))
client.images.generate(model="qwen-image-2512", prompt="a small blue sailboat")
```

TypeScript is `@ainize/sdk` with the same contract. What a caller pays with is a deposit, not a per-token
charge: send AIN or sAIN to the operator, who holds it staked, and your share of the node's throughput is your
share of what everyone asking at that moment deposited. The principal is not consumed and the yield on it is the
operator's revenue. An idle deposit costs the callers who are active nothing — see
[the design](docs/openai-surface-stake-bandwidth-design.md) for why that needs no bookkeeping.

`deploy/serve-stt.sh` and `deploy/serve-image.sh` bring up the two non-LLM backends.
[Calling the model](docs/calling-the-model.md) is the client-side guide: limits, deposits, and what the node
does when it is busy.

## Native inference accounting

Opt-in `AINIZE_INFERENCE_RECORDS=true` records completed chat requests in bounded,
durable batches on the AIN ledger. AINSCAN displays their reported throughput in
ordinary transaction details, separately from onchain TPS. It requires the updated
core implementation and installed chain rules, and can incur transaction fees.
See [inference records](docs/inference-records.md) for completion semantics,
privacy, journal retention, uncertain submissions and remaining live verification.

A [real-model-to-chain reproduction](docs/live-chat-chain-reproduction.md) now
includes one native streaming response, its persisted receipt and the actual
containing block. It is a single base-mode integration check, not a patched-load
benchmark, five-GPU-node deployment or public release.

## The rules this node will not bend

- **Publishing is not selling.** Two independent nodes must load the patch into the real model and
  score it. This node's own attestation is refused and never counted.
- **The seller holds the goods.** Publishing sends a path, not bytes. The node that sells a patch is the
  node holding the file.
- **Lineage is binding.** A patch built on another records it as its parent and shares revenue with it.
  Buying or applying a child without its parent is refused.
- **Teaching is opt-in.** `teach.enabled` is off by default; an operator chooses whether visitors may
  train on this machine, and reviews what they publish.

`deploy/` has the compose file and the host requirements (docker group, trainer GPUs disjoint from the
serving GPUs). `docs/` is the design record. `e2e/` drives a real node in a browser.

### Pin a public chat model to a peer

Set `AINIZE_PREFERRED_CHAT_PEERS` to a JSON map from a bare model ID to a peer node address, for example `{"Qwen3.8-Flash-Next":"0x...40-hex-digits..."}`. A pinned bare model uses that peer even when a local backend advertises the same name. If the peer is unavailable, the request fails instead of falling back to a different local context window. Explicit `model@node` references still select the named node.

The pin applies to `/v1/chat/completions` and base-mode `/api/chat` playground requests without patches. The playground preserves its `base.content` response field. Tool messages, schemas and caller token budgets reach the peer unchanged through `/v1`; the provider enforces the total input-plus-output context window.
