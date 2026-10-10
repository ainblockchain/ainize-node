"""Call an Ainize node with the OpenAI code you already have.

    import ainize

    client = ainize.connect("https://node.example", private_key=...)
    client.chat.completions.create(model="qwen3.8-flash-next", messages=[...])

`connect()` returns a real `openai.OpenAI` with one extra method for decision models (Cloudflare Clef):

    out = client.decide("clef-flash", state={...}, questions={...})
    out.answers

What you pay with is a deposit: send AIN or sAIN to the node and your
share of its throughput is your share of what everyone asking at that moment has deposited.
"""

from ._connect import await_deposit, connect, deposit_address
from ._decide import Client, DecideError, DecideResult

__all__ = ["connect", "deposit_address", "await_deposit", "Client", "DecideResult", "DecideError"]
__version__ = "0.2.0"
