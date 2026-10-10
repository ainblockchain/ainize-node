# ainize (Python)

Call an Ainize node with the OpenAI code you already have.

```python
import ainize

client = ainize.connect("https://node.example", private_key="0x…")

client.chat.completions.create(
    model="qwen3.8-flash-next",
    messages=[{"role": "user", "content": "hello"}],
)
```

`connect()` signs one challenge to prove your address, and returns a real `openai.OpenAI` with `base_url` and
`api_key` already set. Everything after that line is OpenAI's — its methods, its parameters, its exceptions.

Already hold a key? `ainize.connect(url, api_key="ainize-sk-…")` skips the signing.

## Decision models (Cloudflare Clef)

A decision model does not write text. It takes a `state` — any JSON describing a situation — and typed
`questions` about it, and answers each with a probability. OpenAI's client has no method for that, so the client
`connect()` returns is `openai.OpenAI` plus exactly one: `decide()`.

```python
out = client.decide(
    "clef-flash",                       # or "clef" (27B, slower, sharper)
    state="The payment webhook is failing and customers cannot check out.",
    questions={
        "outage":   {"type": "noul",   "instructions": "Is a service down?"},
        "severity": {"type": "score",  "instructions": "How severe is it?", "criteria": ["low", "medium", "high"]},
        "team":     {"type": "choice", "instructions": "Who should handle this?",
                     "criteria": {"billing": "Payments or invoices", "technical": "Bugs or outages"}},
    },
)
out.answers["outage"]["noul"]       # P(true)
out.answers["severity"]["score"]    # index into criteria, with its distribution
out.answers["team"]["choice"]       # an option id, with its distribution
out.usage
```

`out` is a `DecideResult`: `.answers`, `.usage`, `.debug`, and the dict the node sent (`out["answers"]`,
`dict(out)`). Pass `debug={"prompt": True}` and `out.debug["prompt"]` is the exact prompt the model received —
the first thing to look at when an answer surprises you. A refusal raises `ainize.DecideError`, an
`openai.APIStatusError` with the node's `status_code` and `code` (`invalid_api_key`, `model_not_found`, …).

Inside an Ainize run sandbox (`POST /api/run`, or a `script` project) the environment already holds
`AINIZE_URL` and `AINIZE_API_KEY`, so this is the whole program:

```python
import os, ainize
client = ainize.connect(os.environ["AINIZE_URL"], api_key=os.environ["AINIZE_API_KEY"])
```

## What you pay with

A deposit, not a per-token charge. Send AIN or sAIN to the node; the operator holds it staked, and your share of
the node's throughput is your share of what everyone asking at that moment has deposited. An idle deposit costs
nobody anything, and the principal is not consumed.

```python
ainize.deposit_address("https://node.example")          # where to send
ainize.await_deposit(url, tx_hash, api_key=client.api_key)   # wait until the node has credited it
```

The library never signs a transfer. It tells you where to send and waits for the node to notice; moving funds
stays with the wallet you already trust.

## Tests

They drive a real node and a stub model — mocking the transport would test our idea of the node's replies rather
than the node's replies, and the shapes are exactly where compatibility breaks. Run them from this directory, so
the package on disk is the one imported:

```bash
python -m venv .venv && .venv/bin/pip install openai eth-account httpx pytest
.venv/bin/python -m pytest
```
