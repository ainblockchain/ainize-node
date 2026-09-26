# Calling the model

A guide for whoever is writing the client. If you already know OpenAI's API you know most of this; what is
different is how you pay and what happens when the node is busy.

## Install and connect

```bash
pip install ainize          # Python
npm install @ainize/sdk     # TypeScript
```

```python
import ainize

# Any EVM private key works. It signs a login, never a transfer — see below.
client = ainize.connect(
    "http://127.0.0.1:24800",
    private_key="0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
)
```

```ts
import { connectAinize } from '@ainize/sdk';

const client = await connectAinize('http://127.0.0.1:24800', {
  privateKey: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
});
```

The URL is whatever your node listens on; the key above is a throwaway used to produce every output in this
document. **Do not reuse it for anything that holds value** — it is published here, so anybody can sign as that
address. Generate your own with `python -c "import secrets; print('0x'+secrets.token_hex(32))"`.

Ask the node what it serves before assuming a model id:

```python
>>> [m.id for m in client.models.list().data]
['qwen2.5-7b-instruct', 'qwen3-asr', 'qwen-image-2512']
```

`connect()` returns a **real `openai.OpenAI`** (or `OpenAI` in TypeScript). Every method, parameter and exception
on it is OpenAI's, and the rest of your code does not know this node exists. If you already hold a key, pass
`api_key=` / `{ apiKey }` instead and nothing is signed.

### What signing in does

The library asks the node for a challenge, signs it with your key, and gets back a bearer key of the form
`ainize-sk-…`. That signature is **not a transaction**: it moves no funds and approves no spending. It proves you
hold the address, once. After that, calls cost one lookup — no per-request signing.

The key does not expire. It is revoked, not refreshed, so do not build a refresh loop.

## Chat

```python
>>> out = client.chat.completions.create(
...     model="qwen2.5-7b-instruct",
...     messages=[{"role": "user", "content": "In one sentence: what is a GPU good at?"}],
...     max_tokens=60,
... )
>>> out.choices[0].message.content.strip()
'A GPU is good at performing parallel processing tasks, such as rendering graphics and handling complex mathematical operations for machine learning models.'
>>> out.usage.total_tokens
65
```

Streaming is the ordinary OpenAI stream, and every frame you receive has a choice in it — the documented
`chunk.choices[0]` loop is safe:

```python
stream = client.chat.completions.create(
    model="qwen2.5-7b-instruct",
    messages=[{"role": "user", "content": "count to three"}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="")
```

Ask for token counts with OpenAI's own opt-in, and the usage frame arrives last, with `choices` empty:

```python
stream = client.chat.completions.create(
    model="qwen2.5-7b-instruct",
    messages=[{"role": "user", "content": "hello"}],
    stream=True,
    stream_options={"include_usage": True},
)
for chunk in stream:
    if chunk.usage:
        print(chunk.usage.total_tokens)
```

### Limits, and why they are refusals rather than silent truncation

| Field | Limit |
|---|---|
| `max_tokens` | 1–2048 (defaults to 512) |
| `messages` | 1–64 messages, each up to 32,000 characters |
| `n` | must be 1 if sent at all |
| roles | `system`, `user`, `assistant` |

A field this node cannot honour is **refused, not ignored**. `n: 4` is a 400 rather than one answer billed as
four, because silently dropping it would hand you three answers that never existed. Anything outside the table
is likewise a 400 before any GPU time is spent.

## Speech to text

```python
>>> with open("speech.flac", "rb") as f:
...     client.audio.transcriptions.create(model="qwen3-asr", file=f).text
'Mr. Quilter is the apostle of the middle classes, and we are glad to welcome his gospel.'
```

WAV, FLAC and the other formats `soundfile` reads all work.

Whatever else you send — `language`, `prompt`, `temperature`, `response_format` — is passed to the backend
unchanged. The node is not the authority on what the model accepts.

## Images

```python
>>> import base64
>>> out = client.images.generate(
...     model="qwen-image-2512",
...     prompt="a single red maple leaf on white paper",
...     size="512x512",
... )
>>> png = base64.b64decode(out.data[0].b64_json)
>>> len(png)
365247
>>> open("leaf.png", "wb").write(png)
```

| Field | Limit |
|---|---|
| `n` | 1–4 |
| `size` | each side 256–2048, e.g. `1024x1024` |
| `response_format` | `b64_json` only |
| `steps` | 1–60 (defaults to 30; not an OpenAI field, but it is what decides the cost) |

There is no URL form. This node stores nothing, so a URL would either be a lie or a lifetime somebody has to
manage.

## What you pay with

A **deposit**, not a per-token charge. Send AIN or sAIN to the node; the operator holds it staked. Your share of
the node's throughput is your share of what everyone *asking at that moment* has deposited.

Three consequences worth understanding before you size a deposit:

- **The principal is not consumed.** The operator's revenue is the staking yield. Calling the model does not
  draw the deposit down, so there is no balance to top up and no invoice.
- **An idle deposit costs the people who are active nothing.** An address that is not calling has nothing in the
  queue and no claim on it. You are not diluted by depositors who stopped using the node.
- **Your share is relative, so it moves.** If the only other caller stops, your share rises without you doing
  anything. If ten arrive, it falls. What a deposit buys is a ratio, not a rate.

```python
ainize.deposit_address("http://127.0.0.1:24800")   # where to send, and which chains are watched
ainize.await_deposit("http://127.0.0.1:24800", tx_hash, api_key=client.api_key)
```

(These two answer only on a node whose operator configured `deposits`; a node without them has no deposit
routes at all, rather than routes that return nothing.)

```json
{"address": "0x00000000000000000000000000000000000000ff",
 "chains": [{"chain": "base", "token": "0xd4423795fd904d9b87554940a95fb7016f172773"}]}
```

Send only on a chain the node watches — that call tells you which. AIN sent on any other chain arrives and is
never credited, and nothing on-chain will tell you so.

The library **never signs a transfer.** It tells you where to send and waits for the node to credit it; moving
funds stays with the wallet you already trust.

A deposit is not credited the instant it lands. The node waits out its own confirmation depth (12 blocks on
Ethereum, 30 on Base, by default), so a transaction a block explorer already shows is not yet a share. What it
is worth is set when it is credited, at the staking contract's exchange rate then — not at the rate when you
sent it.
`await_deposit` polls the node rather than the chain, because the node is the authority on when it counts.

**There is no withdrawal.** A deposit is a purchase of a permanent share.

## Seeing what you have

```python
import httpx
httpx.get("http://127.0.0.1:24800/v1/account",
          headers={"authorization": f"Bearer {client.api_key}"}).json()
```

Real output from a node where this address deposited one share and somebody else deposited three:

```json
{
  "address": "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
  "deposited_shares": "1000000000000000000",
  "total_deposited_shares": "4000000000000000000",
  "share_of_active": 1,
  "share_of_deposited": 0.25
}
```

Amounts are **decimal strings**, not numbers: a share is an 18-decimal integer and a JSON number would round it.
Parse with `int()` / `BigInt()`, never with a float.

The two fractions differ here, and the difference is the whole point. `share_of_deposited` is 0.25 — a quarter of
every deposit ever made. `share_of_active` is **1**, because the address holding the other three quarters is not
calling right now, and an address that is not calling has nothing in the queue and no claim on it.

`share_of_active` is the number that decides your wait. It moves as other people start and stop, which is what
it means for a deposit to buy a ratio rather than a rate.

### In tokens per second, before and after a deposit

`GET /api/throughput?model=<id>&amount=<n>&token=sAIN|AIN` turns that ratio into a speed, with no key: the
model's **measured** rate `R` (completion tokens over wall time of recent calls; 20 tok/s marked `measured: false`
until anything was measured), and `R · w / (w + others)` for the free tier, for you (when signed in with a
wallet), and for you after depositing `amount` — AIN converted at the staking contract's current rate. It is what
the web's `/billing` page draws. "Active" means asked within the last 30 minutes.

```json
{ "rate": { "tok_s": 190.6, "measured": true, "samples": 3, "window_s": 1800 },
  "free_tier": { "expected_tok_s": 190.625, "busy_expected_tok_s": 0, "idle": true },
  "quote": { "token": "sAIN", "amount": "10", "sain": 10, "expected_tok_s": 190.625, "busy_expected_tok_s": 173.295, "multiplier": 1 } }
```

`GET /api/throughput/deposits/<txHash>` says whether your transfer has been credited yet (signed-in wallet only).

## Errors

Every error is in OpenAI's shape, so your client raises its own typed exception rather than a bare HTTP failure.

| Code | Status | What it means |
|---|---|---|
| `invalid_api_key` | 401 | No key, or one that was revoked. Sign in again. |
| `model_not_found` | 404 | This node does not serve that model. `GET /v1/models` lists what it does. |
| `invalid_request` | 400 | A field outside the limits above. The message names it. |
| `queue_too_deep` | 429 | The node cannot promise to start you within 120s at your current share. |
| `quota_exhausted` | 429 | You have no deposit and the free allowance is spent. |
| `backend_unavailable` | 503 | The model is down or restarting. Distinct from being queued. |

**There is no error meaning "your share is too low."** A small share means a longer wait, never a refusal. When
the node does refuse with `queue_too_deep`, the body tells you which of three things to change:

```json
{ "error": { "code": "queue_too_deep" }, "share": 0.02, "position": 37, "retry_after": 190 }
```

Wait `retry_after` seconds, deposit more to raise `share`, or ask for fewer tokens. A bare 429 would leave you
unable to tell a briefly busy node from one you will never get served by.

### No deposit at all

You are still served. A caller with no deposit gets a weight floor rather than zero — they go last, not never,
so an otherwise idle node answers anyone. What runs out is the free hourly allowance, which returns as
`quota_exhausted` with a `quota_reset` timestamp.

## Why waiting works the way it does

The node runs **one language-model request at a time**. That is a property of the hardware, not a policy, and it
is why a deposit buys a share of a queue rather than a requests-per-second allowance: a rate limit would have to
be chosen before anyone knew who would show up, and would either oversubscribe the node or waste it.

Instead the queue is ordered so that, over any contended period, throughput lands on the deposit ratio. Two
active callers holding 2:1 get served 2:1. The node never promises capacity it does not have.

Transcription and image generation run on **separate GPUs and separate queues**. A large deposit does not let
anyone crowd out image work with audio, and a long completion does not delay a voice note.

## Which models

Ask the node rather than assuming — the ids above are this node's, not a fixed catalogue:

```python
[m.id for m in client.models.list().data]
```

A node advertises exactly what its operator configured. One serving only the language model lists only that, and
a transcription call against it is a clean 404 rather than a confusing failure.

## Running the backends (operators)

```bash
DETACH=1 ./deploy/serve-llm.sh     # a language model, port 8000
DETACH=1 ./deploy/serve-stt.sh     # Qwen3-ASR, port 8100
DETACH=1 ./deploy/serve-image.sh   # Qwen-Image, port 8200
```

Each script takes `MODEL_DIR`, `SERVED_MODEL_NAME`, `PORT` and `GPUS` from the environment, so one node can
serve whichever models its cards have room for. The `SERVED_MODEL_NAME` you set is the id callers pass as
`model`, and the one that must appear in `backends`.

Then declare them in `config.json` under `backends`, and the deposit settings under `deposits`. The vault address
and receiving address are required with no default: getting either wrong credits share for money you do not hold,
and the mistake is invisible at runtime — a node watching the wrong address simply never sees a transfer, which
looks exactly like nobody having deposited yet. It refuses to start instead.

See [the design](openai-surface-stake-bandwidth-design.md) for why the allocator is built this way.
