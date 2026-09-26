# Throughput billing page: "now N tok/s → deposit X → M tok/s"

Date: 2026-09-26 · Repos: ainize-node, ainize-web

## Goal

A page that shows a free-tier visitor what speed they can expect from a model right now, and next to it what
depositing sAIN or AIN would raise it to — and lets them deposit from their wallet on the spot.

Payment already exists: a transfer of AIN or sAIN to the operator's `receivingAddress` is credited to the sender
(`deposit-watcher.ts`), becomes weight (1 sAIN = 1, `stake-weight-source.ts`), and the weighted fair queue gives a
caller `w / Σ w_active` of the model when it is contended (`stake-fair-queue.ts`). This work adds the numbers and
the page on top of it; it does not change how deposits are credited or spent.

Non-goals: withdrawals, auto-staking received AIN, per-modality (image/audio) rates.

## What is missing today, and the fix

| gap | fix |
|---|---|
| no measured speed — only the constant `OPENAI_TOKENS_PER_SECOND = 20` | `ThroughputMeter`: per-model rolling window of `completion_tokens / latency` from every `Runtime.chat` |
| the "active" set never shrinks (`forgetIdle` is never called) so `Σ w_active` counts everyone since start-up | sweep `forgetIdle(STAKE_IDLE_FORGET_MS)` every 5 min in `server.ts` |
| no public Σ of active weight | `StakeFairQueue.activeWeightExcept(address)` |
| AIN→sAIN rate only read when a deposit is credited | `sharesFor(chain, 1e18)`, cached 5 min |
| account/deposit reads need an API key | a public quote endpoint; deposit status by tx hash is public (the tx is public on-chain) |

## Formula

```
R            measured tok/s of the model (fallback: 20, marked "estimated")
others(i)    Σ max(w_j, floor) over active addresses j ≠ i
expected(w)  = others > 0 ? R · w / (w + others) : R          (idle node: the whole model)
free tier    w = floor (1e-6), address "anonymous" — shared by every visitor without a key
you          w = your deposited sAIN (signed-in wallet)
after X      w' = w + X            (X sAIN)   or   w + X · 1e18 / rate   (X AIN)
```

Honest labelling on the page: the free tier is "the whole model when nobody else is asking, next to nothing
when a depositor is". Deposits apply to calls made with an API key (`/v1`), not to the free playground.

## Node

- `src/throughput-meter.ts` — `ThroughputMeter.record(model, completionTokens, latencyMs)`, `rateOf(model)` →
  `{ tokPerSec, samples, windowMs } | null`; window 30 min, ≤ 200 samples per model; samples under 8 tokens or
  100 ms are ignored (they measure latency, not throughput).
- `Runtime.chat` records every successful call with `usage.completion_tokens`.
- `StakeFairQueue.activeWeightExcept(address)`, `activeCount`.
- `server.ts`: 5-minute `forgetIdle` sweep (unref'd, cleared on stop).
- `src/throughput-routes.ts`:
  - `GET /api/throughput?model=&amount=&token=sAIN|AIN` →
    `{ model, rate: { tok_s, measured, samples }, active: { callers, weight }, free_tier: { expected_tok_s },
       you: { address, deposited_sain, expected_tok_s } | null, quote: { token, amount, sain, expected_tok_s,
       multiplier } | null, deposits: { enabled, address, chains: [{ chain, chain_id, token, symbol, decimals,
       confirmations }], ain_per_sain } }`
    `you` is filled from the site session (wallet sign-in). 404 for a model this node does not serve.
  - `GET /api/throughput/deposits/:txHash` (signed-in wallet only) → `{ tx_hash, credited, sain?, chain?, block_number? }`.
- Chain ids: `ethereum` → 1, `base`/`base-*` → 8453. Symbol: sAIN when `isVaultShare`, else AIN.

## Web

- `/billing` (`BillingPage`), `?model=` preselects; links from the model page and the free-tier "tries used up"
  message.
- Left card **Now**: signed-in depositor → "Your API calls: N tok/s"; otherwise "Free tier: N tok/s", with
  "idle — whole model" / "busy — shared" and "measured over n calls" or "estimated".
- Right card **Deposit**: sAIN | AIN toggle, amount (presets 10 · 100 · 1000), "→ M tok/s (×k)" updated as typed
  (debounced quote).
- **Deposit with wallet**: needs a wallet sign-in (deposits are credited to the sending address) and the connected
  account must equal the signed-in address — otherwise the page says why and does not send. Switches the wallet to
  the chain, sends `transfer(receivingAddress, amount)` on the token, then polls the tx status until credited and
  refreshes the numbers. No wallet → the address, chain and token to send to, copyable.

## Testing

- node: meter window/filters; `activeWeightExcept`; route math (idle, busy, quote in sAIN and AIN, 404, deposits
  off); forgetIdle sweep wiring.
- web: quote parsing, amount → 18-decimal units, ERC-20 transfer calldata, chain-id hex; typecheck + build;
  browser check against a local node with deposits configured.
