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
    """Apply a Teach fine-tune over the released weights.

    The Teach `lesson.npz` (clef_teach.py) packs a LoRA adapter for the backbone (`lora.*` + a
    `lora_config`) and the joint schema head (`head.*`), plus a no-op knowledge-patch envelope
    (addrs/before/after) the node requires. A plain `.safetensors` (head only) is still accepted."""
    import numpy as np
    from safetensors.torch import load_file

    target = next(model.parameters())

    def _to(sd):
        return {k: v.to(device=target.device, dtype=target.dtype) for k, v in sd.items()}

    if not head_path.endswith(".npz"):
        model.head.load_state_dict(_to(load_file(head_path)), strict=True)
        return

    envelope = {"addrs", "before", "after", "lora_config"}
    with np.load(head_path) as data:
        files = set(data.files)
        head = {k[len("head."):]: torch.from_numpy(data[k]) for k in files if k.startswith("head.")}
        lora = {k[len("lora."):]: torch.from_numpy(data[k]) for k in files if k.startswith("lora.")}
        cfg = json.loads(bytes(data["lora_config"]).decode()) if "lora_config" in files else None
        # back-compat: an older head-only npz stored head tensors at the top level
        if not head and not lora:
            head = {k: torch.from_numpy(data[k]) for k in files if k not in envelope}

    if cfg and lora:
        from peft import LoraConfig, get_peft_model, set_peft_model_state_dict

        lc = LoraConfig(r=cfg["r"], lora_alpha=cfg["lora_alpha"], target_modules=cfg["target_modules"],
                        lora_dropout=0.0, bias="none")
        model.language_model = get_peft_model(model.language_model, lc)
        set_peft_model_state_dict(model.language_model, _to(lora))
        model.language_model.eval()
    if head:
        model.head.load_state_dict(_to(head), strict=True)


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

    # `debug: {"prompt": true}` — also return the prompt exactly as the model received it (the decoded
    # input_ids of the encoded record). This is how a caller sees *why* an answer came out the way it did
    # without downloading the model; the node forwards the body untouched, so ainize.ai/api/decide carries it.
    debug = body.pop("debug", None)
    want_prompt = isinstance(debug, dict) and bool(debug.get("prompt"))
    try:
        with _lock:
            t0 = time.time()
            with torch.inference_mode():
                response = _systemone(_model, _processor, body, max_length=MAX_LENGTH)
            response.setdefault("usage", {})["latency_ms"] = round((time.time() - t0) * 1000, 1)
            if want_prompt:
                import joint_schema_model as J  # type: ignore
                record = {k: body[k] for k in ("state", "questions", "images", "videos") if k in body}
                enc = J.encode_record(_processor.tokenizer, record, processor=_processor)
                ids = enc.input_ids.tolist() if hasattr(enc.input_ids, "tolist") else list(enc.input_ids)
                ids = ids[0] if ids and isinstance(ids[0], list) else ids
                response["debug"] = {"prompt": _processor.tokenizer.decode(ids, skip_special_tokens=False),
                                     "input_tokens": len(ids), "questions": len(getattr(enc, "questions", []) or body["questions"])}
        return response
    except ValueError as exc:
        # Schema problems in the request (bad question type, empty criteria, …).
        return _error(400, "invalid_request", str(exc))
    except Exception as exc:
        return _error(502, "inference_failed", f"{type(exc).__name__}: {exc}")
