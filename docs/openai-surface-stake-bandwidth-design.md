# OpenAI-compatible surface, paid for by stake

A client outside this project installs one package, points it at a node, and writes the
code it would have written against OpenAI. What it pays with is AIN: it sends AIN to the
node operator, the operator holds it as sAIN, and the size of that deposit relative to
everyone else asking at the same moment is the client's share of the node's throughput.

The deposit is not spent. The operator's revenue is the staking yield on it; the principal
stays staked. There is no per-token accounting, no metering, no invoice, and no withdrawal.
Three things follow from that, and they are the whole design:

- **Nothing is charged per request**, so the node never needs a price, a quote or a receipt
  on the inference path.
- **Throughput is the only scarce thing being divided**, so the allocator belongs where the
  contention already is — the serving queue.
- **A deposit is a permanent claim on a share**, so the ledger is append-only and needs no
  settlement, refund or reconciliation logic.

## What already exists

This is an addition to a node that already serves a model, not a new service.

| Already there | Where | Used for |
|---|---|---|
| Wallet sign-in (`personal_sign`), device delegation | `src/wallet-login.ts`, core `delegation.ts` | proving an address, without a second signing scheme |
| A shared, serialised model runtime | `src/runtime.ts` (`serial`, `pump`, `acquireLock`) | the point where throughput is actually divided |
| Per-visitor queue tickets, cancel-while-queued | `src/chat-queue.ts` | telling a caller where it stands |
| Free-try quota buckets | `market.chatQuota` | what a caller with no deposit falls back to |
| A chat path that already speaks vLLM | `src/runtime.ts` → upstream `/v1/chat/completions` | the LLM backend |

The node exposes none of this in OpenAI's shape. `/api/chat` is the node's own format —
comparison columns, patch ids, teach-mode semantics — and it should stay that way. The new
surface sits beside it, not on top of it.

## 1. Allocation: stake-weighted fair queueing

`Runtime.pump()` currently picks the next waiter by `priority`, then arrival order:

```ts
this.waiters.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
```

The model runs one request at a time behind a cross-process lease, so "TPS" here is not a
concurrency limit — it is a *share of the queue*. Rate-limiting each caller to some
requests-per-second would be the wrong mechanism twice over: it would oversubscribe the
node when many callers are active, and waste it when few are.

Instead, each waiter carries a virtual finish time:

```
start(request)  = max(virtualTime, lastFinish[address])
finish(request) = start + estimatedCost / weight(address)
```

and `pump()` breaks ties within a priority class by lowest `finish`. `weight(address)` is
the address's deposited sAIN share.

**`virtualTime` is the queue's own clock, not the wall clock.** It is set to the finish tag
of whatever was served last, and jumps to the highest tag issued whenever the queue drains.
Clamping against real time instead looks equivalent and is not: real time advances as fast
as the slowest caller's virtual clock, so every round resets everybody to the same point and
the served ratio comes out 1:1 no matter what anyone deposited. The weights stay in the
arithmetic and stop meaning anything. This document specified the wall-clock version until
the ratio simulation in `test/stake-fair-queue.test.ts` caught it.

This is a standard weighted-fair-queueing result, and it gives both properties that were
asked for, with one mechanism:

- **Long-run throughput converges to the deposit ratio.** Two active addresses holding 2:1
  get served 2:1. Oversubscription is structurally impossible — the node hands out exactly
  the capacity it has, never a number it promised in advance.
- **Idle deposits cost active callers nothing.** An address that is not asking has no
  waiter in the queue and therefore no claim on it. This is what "share among active
  stakers" means, and it needs no active-set tracking, no sliding window, and no
  denominator to recompute. It falls out of the queue discipline.

  `lastFinish` is the only scheduling state, and it is clamped by `max(virtualTime, …)`: an
  address returning after an idle period starts from the queue's present, so it neither owes
  a backlog nor arrives holding a credit that would starve everyone else. A request that is
  still outstanding does keep counting against the address that made it — the levelling
  happens when the queue drains, not merely when time passes.

Details that have to be right:

- **`priority` classes are preserved.** Teach jobs and chat requests stay in their existing
  classes; WFQ orders waiters only *within* a class. This design does not change what the
  node considers urgent.
- **`estimatedCost`** is `max_tokens` for chat, audio duration for transcription, and
  `steps × images` for image generation — each normalised to a per-modality unit so the
  numbers are comparable within one queue. It is an estimate; WFQ is robust to estimates
  being wrong by a constant factor, because every caller's estimate is wrong the same way.
- **Callers with no deposit** keep today's free-try quota buckets unchanged and are given a
  weight floor — a small fixed weight, not zero. Zero would mean an infinite finish tag and
  permanent starvation; a floor means they are served when the node is otherwise idle,
  which is what a free tier should be.
- **STT and image run on their own GPUs** and are genuinely parallel. Each gets its own
  queue with N concurrency slots, allocated by the same WFQ. Queues are **per modality**: a
  large LLM deposit must not let a caller crowd out image requests, because they are not
  competing for the same hardware.

### Verification

WFQ is simulated against a virtual clock in unit tests, because the formula being typed
correctly is not the claim — the ratio is. Given weights 2:1, 3:2:1 and 100:1 under
saturating demand, served counts must converge on those ratios within a stated tolerance,
and the 100:1 case must still serve the small stake at all, since starvation is not
proportionality. A depositor holding 90% of the stake who never asks must take nothing from
the two who do. An address that goes idle and returns must be level with a brand-new one
once the queue has drained, while a request still outstanding keeps counting against the
address that made it.

## 2. The surface

A new file, `src/openai-surface.ts`, mounted at `/v1`. It does not go into `src/api.ts`,
which is already 2,871 lines.

| Route | Backend |
|---|---|
| `GET /v1/models` | generated from the backend registry |
| `POST /v1/chat/completions` (streaming and not) | Qwen3.8-Flash-Next W4A16, GPU 0–3, TP=4 |
| `POST /v1/audio/transcriptions` | Qwen3-ASR-1.7B, GPU 5 |
| `POST /v1/images/generations` | Qwen-Image-2512, GPU 6 |
| `GET /v1/account` | this address's deposit, current share, recent effective throughput |
| `POST /v1/auth/nonce`, `POST /v1/auth/token` | sign-in, issuing an API key |

`src/inference-backends.ts` holds the registry: `{ id, modality, upstream, models[],
concurrency }` read from `config.json`. Both `/v1/models` and routing are derived from it,
so a node that runs only the LLM advertises only the LLM rather than failing on a route it
cannot serve.

### Models

The machine has eight A100-SXM4-80GB. GPUs 0–4 are in use (~41 GB each), 5 and 6 are free,
7 is partly used. A100 is Ampere: bf16 and W4A16, no native FP8/FP4.

- **LLM — Qwen3.8-Flash-Next W4A16**, already running on GPUs 0–3 via `serve.sh`. Unchanged.
- **STT — Qwen3-ASR-1.7B.** vLLM has day-0 support and serves it on the OpenAI transcription
  endpoint directly, so this backend is a second vLLM container and no new serving code.
- **Image — Qwen-Image-2512.** Roughly 24 GB in bf16, comfortable on one A100. vLLM cannot
  serve diffusion models, so this one needs a small `diffusers` sidecar that exposes
  `POST /v1/images/generations`. That sidecar is the only new serving process in this design.

Weights are not downloaded or benchmarked as part of this document; that is the first task
of implementation, and the registry is written so a backend that fails to come up is
reported unavailable rather than breaking the surface.

### Authentication

`Authorization: Bearer ainize-sk-…`, where the key is bound to an EVM address.

The key is issued through the sign-in that already exists — `walletLoginMessage()` and the
device-delegation flow in core. No new signing scheme is introduced, and the message a
person reads in their wallet does not change.

Per-request signatures were rejected: they would break compatibility with stock OpenAI
clients (which is the entire point of this surface) and would put an `ecrecover` and a
nonce store on the inference path. A bearer key costs one key→address lookup.

## 3. The deposit ledger

Split along the boundary the repos already have: core holds types and arithmetic, the node
holds I/O.

**`ainize-core/src/depositLedger.ts`** — address → cumulative deposited, in sAIN share
units. Pure functions only; core stays a protocol and type layer with no chain polling and
no daemon, so the CLI that depends on it is unaffected.

**`ainize-node/src/depositWatcher.ts`** — the watcher and the staking step:

- Watches `Transfer` logs to the operator's receiving address on three paths: AIN on
  Ethereum mainnet (`0x3a810ff7211b40c4fa76205a14efe161615d0385`), AIN on Base
  (`0xd4423795fd904d9b87554940a95fb7016f172773`), and sAIN itself
  (`0x70e68AF68933D976565B1882D80708244E0C4fe9`), whose transfers are already in share units.

  Base's address is the one AIN uses on every non-Ethereum chain it is deployed to —
  Polygon, BNB Chain, Arbitrum, Optimism and Avalanche all share it. The watcher is
  therefore written over a list of `{ chain, rpc, token, confirmations }` rather than
  against Base specifically: accepting another chain later is a config entry, not code.
- Idempotent on `(chain, txHash, logIndex)`; waits a per-chain confirmation depth before
  crediting, so a reorg cannot mint share.
- Normalises at credit time through the staking contract's `getExchangeRate()` — AIN per sAIN in 1e18 fixed
  point — recording **sAIN share units**. sAIN is *not* ERC-4626: it has `asset()` and looks like a vault, but
  exposes no `convertToShares`, and the conversion lives on a separate staking contract. A direct sAIN deposit is recorded as-is. Deposits on different chains are
  therefore summed in one comparable unit.
- Converts received AIN into sAIN by depositing to that chain's vault, using the operator's
  key.

**No bridging.** AIN received on a chain is staked on that chain; only the share accounting
is combined. This satisfies accepting deposits on any of the three paths while avoiding
bridge failure, slippage and stuck-in-flight states, which would otherwise be the largest
source of complexity and of real financial loss in this design.

**No withdrawal.** A deposit is a purchase of a permanent share. The ledger is append-only.

### Configuration this needs

The token addresses are known and ship as defaults. Two values are not, and are left as
required config with no default, so a misconfigured node fails at startup rather than
crediting the wrong address:

- the staking contract address and its chain,
- the operator's receiving address.

## 4. The SDKs

The wire contract is fixed first — `POST /v1/auth/nonce` → sign → `POST /v1/auth/token` →
key, then plain OpenAI — and both packages are thin wrappers over it.

```python
import ainize
client = ainize.connect("https://node.example", private_key=...)   # returns openai.OpenAI

client.chat.completions.create(model="qwen3.8-flash-next", messages=[...])
client.audio.transcriptions.create(model="qwen3-asr", file=f)
client.images.generate(model="qwen-image-2512", prompt="...")
```

`connect()` signs in, then returns a real `openai.OpenAI` with `base_url` and `api_key`
already set. Nothing else in the caller's code changes. `@ainize/sdk` does the same for the
`openai` npm package, alongside the existing `@ainize/cli` and `@ainize/node`.

**Depositing is not done by the SDK.** `ainize.deposit_address()` returns where to send and
`ainize.await_deposit(tx)` polls for confirmation, but the library never moves funds with a
caller's key. A client library that signs transfers is a much larger thing to trust than one
that signs a login.

## 5. Errors and visibility

A caller must never have to guess why it is waiting.

Under WFQ a small share means *waiting longer*, never being refused, so there is no error
for "your share is too low". A request is rejected only when the node cannot honestly
promise to run it:

- `429 queue_too_deep` — the estimated wait at this caller's share exceeds the queue's
  bound. It carries the caller's current share, its position and `retry_after`, so the
  refusal says which of the three to change: wait, deposit more, or ask for less.
- `429 quota_exhausted` — a caller with no deposit has spent the free-tier bucket. Reuses
  today's quota codes and `quota_reset` shape rather than inventing a second vocabulary.
- `GET /v1/account` reports cumulative deposit, current share among those presently asking,
  and recent effective throughput — so the number a client is paying for is observable
  rather than asserted.
- A backend that is down is reported unavailable on `/v1/models` and returns
  `503 backend_unavailable`, distinct from being queued.

## 6. Testing

- **Deposit ledger** — unit tests over the pure functions: duplicate logs, reorg below
  confirmation depth, share arithmetic and rounding, mixed-chain summation.
- **WFQ** — virtual-clock simulation, as described in §1.
- **The `/v1` surface** — end-to-end through the real `openai-python` and `openai-node`
  clients in the existing `e2e/` harness. Compatibility claimed against the stock client is
  only worth anything if it is tested with the stock client.

## 7. Out of scope

Stated so they are not discovered halfway through:

- cross-chain bridging,
- withdrawals and refunds,
- a multi-node registry or client-side node discovery,
- distributing staking yield to anyone but the operator,
- changing `/api/chat` or teach mode.
