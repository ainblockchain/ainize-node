"""What `import ainize` promises: after one line, it is just OpenAI.

These run the genuine `openai` client against a real node. A mocked transport would test our idea of the node's
replies rather than the node's replies, and the shapes are exactly where the promise breaks.

    cd sdk/python && .venv/bin/python -m pytest
"""

from __future__ import annotations

import openai
import pytest

import ainize


def test_connect_returns_a_real_openai_client(node_url, wallet_key):
    client = ainize.connect(node_url, private_key=wallet_key)
    assert isinstance(client, openai.OpenAI)
    assert str(client.base_url).rstrip("/").endswith("/v1")


def test_an_existing_key_skips_signing(node_url, issued_key):
    client = ainize.connect(node_url, api_key=issued_key)
    assert client.api_key == issued_key


def test_neither_key_nor_private_key_is_an_error_naming_both(node_url):
    with pytest.raises(ValueError) as raised:
        ainize.connect(node_url)
    assert "private_key" in str(raised.value)
    assert "api_key" in str(raised.value)


def test_models_are_listed_through_the_stock_client(node_url, issued_key):
    client = ainize.connect(node_url, api_key=issued_key)
    assert "qwen3.8-flash-next" in [m.id for m in client.models.list().data]


def test_chat_completion_round_trips(node_url, issued_key):
    client = ainize.connect(node_url, api_key=issued_key)
    out = client.chat.completions.create(
        model="qwen3.8-flash-next", messages=[{"role": "user", "content": "ping"}]
    )
    assert out.choices[0].message.content == "pong"
    assert out.id.startswith("chatcmpl-")
    assert out.choices[0].finish_reason == "stop"


def test_streaming_yields_chunks(node_url, issued_key):
    client = ainize.connect(node_url, api_key=issued_key)
    chunks = list(
        client.chat.completions.create(
            model="qwen3.8-flash-next",
            messages=[{"role": "user", "content": "ping"}],
            stream=True,
        )
    )
    assert chunks, "the stream ended without a single chunk"
    assert chunks[0].object == "chat.completion.chunk"
    assert "".join(c.choices[0].delta.content or "" for c in chunks) == "pong"


def test_a_bad_key_raises_openais_own_error_type(node_url):
    client = ainize.connect(node_url, api_key="ainize-sk-not-a-real-key")
    with pytest.raises(openai.AuthenticationError):
        client.chat.completions.create(
            model="qwen3.8-flash-next", messages=[{"role": "user", "content": "ping"}]
        )


def test_an_unknown_model_raises_not_found(node_url, issued_key):
    client = ainize.connect(node_url, api_key=issued_key)
    with pytest.raises(openai.NotFoundError):
        client.chat.completions.create(
            model="gpt-4", messages=[{"role": "user", "content": "ping"}]
        )
