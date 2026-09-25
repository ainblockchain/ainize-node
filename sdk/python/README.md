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
