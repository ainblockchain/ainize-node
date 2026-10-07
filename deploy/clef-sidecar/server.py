"""Clef decision models behind a Jev/SystemOne `/v1/systemone` endpoint.

Clef is not a chat model and vLLM cannot serve it: the backbone is a Qwen3.8 vision-language
model with a joint schema head bolted on, loaded through the repo's own `joint_schema_model.py`
with `trust_remote_code`. So, exactly like the image model, Clef gets one small serving process
of its own. The node in front does the auth, routing and queueing; this file only knows the model.

It serves one model per process (`MODEL_PATH` + `SERVED_MODEL_NAME`). Run it once per model —
clef-flash on one card, clef on another — and give each its own port and GPU. The node maps a
model id to this process through a `decision` backend in config.json.

Concurrency is one: a single forward already uses the whole card, so overlapping two requests
makes both slower and neither sooner. The node's gate decides who goes next.
"""
from __future__ import annotations

import os
import sys
import threading
import time
from pathlib import Path
from typing import Any

import torch
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

MODEL_PATH = os.environ.get("MODEL_PATH", "/model")
SERVED_MODEL_NAME = os.environ.get("SERVED_MODEL_NAME", "clef-flash")
DEVICE = os.environ.get("DEVICE", "cuda")
MAX_LENGTH = int(os.environ.get("MAX_LENGTH", "16384"))
# A trained joint-schema head may be dropped in to override the released one (the Teach export).
HEAD_OVERRIDE = os.environ.get("HEAD_OVERRIDE", "").strip()

app = FastAPI()
# One request at a time: the forward already occupies the card.
_lock = threading.Lock()
_model: Any = None
_processor: Any = None
_systemone = None
_load_error: str | None = None


def _ensure_loaded() -> None:
    """Load the backbone, the joint schema head and the processor once, on first use."""
    global _model, _processor, _systemone, _load_error
    if _model is not None or _load_error is not None:
        return
    with _lock:
        if _model is not None or _load_error is not None:
            return
        try:
            path = MODEL_PATH
            if not Path(path).is_dir():
                from huggingface_hub import snapshot_download

                path = snapshot_download(path)
            # The model ships its own loader; import it from the snapshot like the model card does.
            sys.path.insert(0, path)
            from joint_schema_model import load_release_model, systemone  # type: ignore

            model, processor = load_release_model(path, device=DEVICE)
            if HEAD_OVERRIDE:
                _apply_head_override(model, HEAD_OVERRIDE)
            _model, _processor, _systemone = model, processor, systemone
        except Exception as exc:  # surfaced through /health and per-request 503
            _load_error = f"{type(exc).__name__}: {exc}"


def _apply_head_override(model: Any, head_path: str) -> None:
    """Swap in a fine-tuned joint schema head (a Teach artifact) over the released weights.

    Accepts either a `.safetensors` head or the Teach trainer's `lesson.npz` (clef_teach.py saves the
    head's state_dict as named float32 arrays)."""
    if head_path.endswith(".npz"):
        import numpy as np

        # The Teach lesson.npz wraps the head weights alongside an empty knowledge-patch envelope
        # (addrs/before/after) that the ainize node requires; those three keys are not head params.
        envelope = {"addrs", "before", "after"}
        with np.load(head_path) as data:
            state = {k: torch.from_numpy(data[k]) for k in data.files if k not in envelope}
    else:
        from safetensors.torch import load_file

        state = load_file(head_path)
    target = next(model.parameters())
    model.head.load_state_dict(
        {k: v.to(device=target.device, dtype=target.dtype) for k, v in state.items()},
        strict=True,
    )


def _error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        content={"error": {"message": message, "type": "invalid_request_error", "code": code, "param": None}},
    )


@app.get("/v1/models")
def models() -> dict:
    return {"object": "list", "data": [{"id": SERVED_MODEL_NAME, "object": "model", "owned_by": "cloudflare"}]}


@app.get("/health")
def health() -> dict:
    # Readiness, not liveness: a model still loading is alive but cannot answer, and a loader that
    # failed must say so rather than look like a slow start.
    return {"ready": _model is not None, "model": SERVED_MODEL_NAME, "error": _load_error}


@app.post("/v1/systemone")
async def systemone_route(request: Request):
    try:
        body = await request.json()
    except Exception:
        return _error(400, "invalid_request", "body must be JSON")
    if not isinstance(body, dict):
        return _error(400, "invalid_request", "body must be a JSON object")

    requested = body.get("model")
    if isinstance(requested, str) and requested and requested != SERVED_MODEL_NAME:
        return _error(404, "model_not_found", f"this backend serves {SERVED_MODEL_NAME}, not {requested}")
    body["model"] = SERVED_MODEL_NAME

    _ensure_loaded()
    if _load_error is not None:
        return _error(503, "backend_unavailable", f"model failed to load: {_load_error}")

    try:
        with _lock:
            t0 = time.time()
            with torch.inference_mode():
                response = _systemone(_model, _processor, body, max_length=MAX_LENGTH)
            response.setdefault("usage", {})["latency_ms"] = round((time.time() - t0) * 1000, 1)
        return response
    except ValueError as exc:
        # Schema problems in the request (bad question type, empty criteria, …).
        return _error(400, "invalid_request", str(exc))
    except Exception as exc:
        return _error(502, "inference_failed", f"{type(exc).__name__}: {exc}")
