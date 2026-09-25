"""A real node and a real stub model, for tests that are only worth anything against the real wire.

The claim this SDK makes is "it is just OpenAI". Mocking the transport would test our idea of the node's replies
rather than the node's replies, and the shapes are exactly where that claim breaks. So these fixtures start the
node under test and a stub upstream speaking vLLM's dialect, and let the genuine `openai` client talk to them.
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import httpx
import pytest
from eth_account import Account

REPO_ROOT = Path(__file__).resolve().parents[3]


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class _StubModel(BaseHTTPRequestHandler):
    """One completion, or one SSE stream, in the dialect the node's runtime consumes."""

    def log_message(self, *_args):  # noqa: D102 - silence the default stderr spam
        pass

    def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler's naming
        body = json.dumps(
            {"object": "list", "data": [{"id": "qwen3.8-flash-next", "object": "model", "created": 1}]}
        ).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):  # noqa: N802
        raw = self.rfile.read(int(self.headers.get("content-length", 0)))
        try:
            wants_stream = bool(json.loads(raw).get("stream"))
        except Exception:
            wants_stream = False

        if not wants_stream:
            body = json.dumps(
                {
                    "id": "cmpl-upstream",
                    "object": "chat.completion",
                    "created": 1,
                    "model": "qwen3.8-flash-next",
                    "choices": [
                        {"index": 0, "message": {"role": "assistant", "content": "pong"}, "finish_reason": "stop"}
                    ],
                    "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
                }
            ).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()

        def frame(delta, finish):
            return (
                "data: "
                + json.dumps(
                    {
                        "id": "cmpl-upstream",
                        "object": "chat.completion.chunk",
                        "created": 1,
                        "model": "qwen3.8-flash-next",
                        "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
                    }
                )
                + "\n\n"
            ).encode()

        self.wfile.write(frame({"role": "assistant", "content": "po"}, None))
        self.wfile.write(frame({"content": "ng"}, "stop"))
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


@pytest.fixture(scope="session")
def stub_model():
    server = HTTPServer(("127.0.0.1", _free_port()), _StubModel)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_port}"
    server.shutdown()


@pytest.fixture(scope="session")
def node_url(stub_model):
    """Start the node under test with a config that declares one chat backend, and wait for it to answer."""
    home = Path(tempfile.mkdtemp(prefix="ainize-sdk-home-"))
    port = _free_port()

    # defaultConfig mints the node's identity key, so the config is written by the node's own code rather than
    # reimplemented here in a second language where it could drift.
    subprocess.run(
        ["npx", "tsx", "sdk/python/tests/make-node-config.ts", str(home), str(port), stub_model],
        cwd=REPO_ROOT,
        check=True,
        capture_output=True,
        text=True,
    )

    process = subprocess.Popen(
        ["npx", "tsx", "src/bin.ts"],
        cwd=REPO_ROOT,
        env={**os.environ, "AINIZE_HOME": str(home)},
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    base = f"http://127.0.0.1:{port}"
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"the node exited before it listened:\n{process.stdout.read()}")
        try:
            httpx.get(f"{base}/healthz", timeout=2)
            break
        except Exception:
            time.sleep(0.5)
    else:
        process.terminate()
        raise RuntimeError("the node did not start listening within 120s")

    yield base

    process.terminate()
    try:
        process.wait(timeout=20)
    except subprocess.TimeoutExpired:
        process.kill()
    shutil.rmtree(home, ignore_errors=True)


@pytest.fixture(scope="session")
def wallet_key() -> str:
    return Account.create().key.hex()


@pytest.fixture(scope="session")
def issued_key(node_url, wallet_key) -> str:
    import ainize

    return ainize.connect(node_url, private_key=wallet_key).api_key
