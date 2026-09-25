"""Point OpenAI at an Ainize node.

This library does one thing on top of `openai`: it proves which address is calling and gets a key back. It does
not wrap the client, subclass it, or re-export a narrowed version of it — it returns the real `openai.OpenAI`,
because the whole promise is that nothing after that line is different. A wrapper would have to grow a method
every time OpenAI's client does, and would be a second place for bugs to live.

It also never signs a transfer. `deposit_address()` says where to send AIN and `await_deposit()` waits for the
node to notice; moving funds stays with the wallet the person already trusts. A library that signs transfers is a
much larger thing to hand your private key to than one that signs a login, and the difference is not something a
caller can see from the import line.
"""

from __future__ import annotations

import time

import httpx
import openai
from eth_account import Account
from eth_account.messages import encode_defunct

__all__ = ["connect", "deposit_address", "await_deposit"]

_DEFAULT_TIMEOUT = 30.0


def connect(
    node_url: str,
    *,
    private_key: str | None = None,
    api_key: str | None = None,
    timeout: float = _DEFAULT_TIMEOUT,
) -> openai.OpenAI:
    """Return an `openai.OpenAI` pointed at `node_url`, signing in if it has to.

    Pass `private_key` to sign in and be issued a key, or `api_key` to reuse one you already hold. The returned
    client is the genuine article: every call, parameter and exception is OpenAI's.
    """
    node_url = node_url.rstrip("/")
    if api_key is None:
        if private_key is None:
            raise ValueError(
                "connect() needs either private_key (to sign in and be issued one) or api_key (one you already hold)"
            )
        api_key = _sign_in(node_url, private_key, timeout=timeout)
    return openai.OpenAI(base_url=f"{node_url}/v1", api_key=api_key)


def _sign_in(node_url: str, private_key: str, *, timeout: float) -> str:
    """Prove the address once and leave with a key.

    The message signed is the one the node issued, verbatim — it is not rebuilt here. A rebuilt message is a
    message the client had a hand in, and the node verifies against the bytes it handed out.
    """
    account = Account.from_key(private_key)
    with httpx.Client(timeout=timeout) as http:
        challenge = http.post(
            f"{node_url}/v1/auth/nonce",
            json={"address": account.address, "scheme": "eip191"},
        )
        challenge.raise_for_status()
        issued_challenge = challenge.json()

        signature = account.sign_message(
            encode_defunct(text=issued_challenge["message"])
        ).signature.hex()
        if not signature.startswith("0x"):
            signature = f"0x{signature}"

        token = http.post(
            f"{node_url}/v1/auth/token",
            json={"nonce": issued_challenge["nonce"], "signature": signature},
        )
        token.raise_for_status()
        return token.json()["api_key"]


def deposit_address(node_url: str, *, timeout: float = _DEFAULT_TIMEOUT) -> str:
    """Where to send AIN or sAIN to buy a share of this node's throughput."""
    with httpx.Client(timeout=timeout) as http:
        response = http.get(f"{node_url.rstrip('/')}/v1/account/deposit-address")
        response.raise_for_status()
        return response.json()["address"]


def await_deposit(
    node_url: str,
    tx_hash: str,
    *,
    api_key: str,
    timeout: float = 600.0,
    poll_seconds: float = 5.0,
) -> dict:
    """Block until the node has credited `tx_hash`.

    The node is the authority on when a transfer counts: it waits for its own confirmation depth before crediting,
    so a transaction that a block explorer already shows is not yet a share here. Polling is honest about that;
    guessing from the chain would not be.
    """
    deadline = time.monotonic() + timeout
    headers = {"authorization": f"Bearer {api_key}"}
    with httpx.Client(timeout=_DEFAULT_TIMEOUT) as http:
        while True:
            response = http.get(
                f"{node_url.rstrip('/')}/v1/account/deposits/{tx_hash}", headers=headers
            )
            response.raise_for_status()
            seen = response.json()
            if seen.get("credited"):
                return seen
            if time.monotonic() > deadline:
                raise TimeoutError(f"{tx_hash} was not credited within {timeout}s")
            time.sleep(poll_seconds)
