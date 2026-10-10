"""The one call OpenAI's client has no name for: a decision.

A decision model (Cloudflare Clef, served as `clef` and `clef-flash`) does not complete text. It takes a `state` —
any JSON describing a situation — and a set of typed `questions` about it, and answers each with a probability:
`noul` → P(true), `score` → a distribution over the graded `criteria`, `choice` → a distribution over the option
ids. A node serves this at `POST /v1/systemone`, which has no counterpart in the OpenAI surface, so `connect()`
returns a client that is OpenAI's in every respect but one extra method, `decide()`. It reuses the client's own
base URL, key and timeout — the key a program already holds is the key the decision is billed to.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Iterator

import httpx
import openai

__all__ = ["Client", "DecideResult", "DecideError"]

_DEFAULT_TIMEOUT = 120.0


class DecideError(openai.APIStatusError):
    """The node refused or failed a decision. `status_code` and `body` are the node's; `code` is its error code."""

    def __init__(self, response: httpx.Response) -> None:
        try:
            body: Any = response.json()
        except ValueError:
            body = {"error": {"message": response.text}}
        err = body.get("error") if isinstance(body, dict) else None
        message = (err or {}).get("message") if isinstance(err, dict) else None
        super().__init__(message or f"the node answered {response.status_code}", response=response, body=body)
        self.code = (err or {}).get("code") if isinstance(err, dict) else None


class DecideResult(Mapping[str, Any]):
    """What `POST /v1/systemone` answered, as attributes and as the dict it came as.

    `answers` is keyed by question id; each value has the question's `type` and the field that type answers with
    (`noul`, `score`, `choice`) alongside the distribution it came out of. `usage` is the node's accounting. `debug`
    is present only when the request asked for it (`debug={"prompt": True}`) and carries the exact prompt the
    model received.
    """

    def __init__(self, raw: dict[str, Any]) -> None:
        self._raw = raw

    @property
    def model(self) -> str | None:
        return self._raw.get("model")

    @property
    def answers(self) -> dict[str, Any]:
        return self._raw.get("answers") or {}

    @property
    def usage(self) -> dict[str, Any] | None:
        return self._raw.get("usage")

    @property
    def debug(self) -> dict[str, Any] | None:
        return self._raw.get("debug")

    def to_dict(self) -> dict[str, Any]:
        return dict(self._raw)

    # Mapping — `out["answers"]`, `"debug" in out`, `dict(out)` all work on the body as the node sent it.
    def __getitem__(self, key: str) -> Any:
        return self._raw[key]

    def __iter__(self) -> Iterator[str]:
        return iter(self._raw)

    def __len__(self) -> int:
        return len(self._raw)

    def __repr__(self) -> str:
        return f"DecideResult({self._raw!r})"


class Client(openai.OpenAI):
    """`openai.OpenAI`, plus `decide()`.

    Nothing OpenAI's client does is changed or hidden: this is the stock class with one method the stock class
    cannot have, because `/v1/systemone` is not an OpenAI endpoint. `isinstance(client, openai.OpenAI)` holds.
    """

    def decide(
        self,
        model: str,
        state: Any,
        questions: dict[str, Any],
        *,
        debug: dict[str, Any] | None = None,
        timeout: float | None = None,
        **extra: Any,
    ) -> DecideResult:
        """Ask a decision model `questions` about `state`.

        `model` is `clef-flash` (fast) or `clef` (27B); `state` is any JSON; `questions` maps a question id to
        `{"type": "noul" | "score" | "choice", "instructions": ..., "criteria": ...}`. Pass
        `debug={"prompt": True}` to get the exact prompt the model saw back in `.debug["prompt"]`. Any further
        keyword (`images`, `videos`) travels to the node unchanged.
        """
        if not isinstance(questions, dict) or not questions:
            raise ValueError("questions must be a non-empty dict of question id -> question")
        body: dict[str, Any] = {"model": model, "state": state, "questions": questions, **extra}
        if debug:
            body["debug"] = debug
        base = str(self.base_url).rstrip("/")
        headers = {"authorization": f"Bearer {self.api_key}", "content-type": "application/json"}
        with httpx.Client(timeout=timeout if timeout is not None else _DEFAULT_TIMEOUT) as http:
            response = http.post(f"{base}/systemone", json=body, headers=headers)
        if response.status_code >= 400:
            raise DecideError(response)
        return DecideResult(response.json())
