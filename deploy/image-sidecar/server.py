"""Qwen-Image behind OpenAI's `/v1/images/generations`.

vLLM does not serve diffusion models, so this is the one new serving process in the design. It is deliberately
small: load the pipeline once, answer one shape, and let the node in front of it do the authentication, the
routing and the queueing. Everything this file knows about is the model.

Concurrency is one. A diffusion step is already using the whole card, so running two requests at once makes both
slower and neither sooner, and the node's own gate is what decides who goes next.
"""
from __future__ import annotations

import base64
import io
import os
import threading
import time

import torch
from diffusers import DiffusionPipeline
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

MODEL_DIR = os.environ.get("MODEL_DIR", "/model")
SERVED_MODEL_NAME = os.environ.get("SERVED_MODEL_NAME", "qwen-image-2512")
DEFAULT_STEPS = int(os.environ.get("DEFAULT_STEPS", "30"))
MAX_STEPS = int(os.environ.get("MAX_STEPS", "60"))
MAX_IMAGES = int(os.environ.get("MAX_IMAGES", "4"))

app = FastAPI()
# One request at a time: a diffusion step already occupies the card, so overlapping two makes both slower.
_lock = threading.Lock()
_pipe: DiffusionPipeline | None = None


def pipeline() -> DiffusionPipeline:
    global _pipe
    if _pipe is None:
        _pipe = DiffusionPipeline.from_pretrained(MODEL_DIR, torch_dtype=torch.bfloat16).to("cuda")
        _pipe.set_progress_bar_config(disable=True)
    return _pipe


class ImageRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=4000)
    model: str | None = None
    n: int = 1
    size: str = "1024x1024"
    response_format: str = "b64_json"
    # OpenAI has no steps field; accepted because it is what actually decides the cost, and ignored by callers
    # that do not know about it.
    steps: int | None = None
    negative_prompt: str | None = None
    seed: int | None = None


def _error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": {"message": message, "type": "invalid_request_error", "code": code, "param": None}})


@app.get("/v1/models")
def models() -> dict:
    return {"object": "list", "data": [{"id": SERVED_MODEL_NAME, "object": "model", "owned_by": "diffusers"}]}


@app.get("/health")
def health() -> dict:
    # Reports readiness, not liveness: a pipeline still loading is alive and cannot answer, and a caller needs
    # to be able to tell those apart.
    return {"ready": _pipe is not None, "model": SERVED_MODEL_NAME}


@app.post("/v1/images/generations")
def generate(request: ImageRequest):
    if request.model and request.model != SERVED_MODEL_NAME:
        return _error(404, "model_not_found", f"this backend serves {SERVED_MODEL_NAME}, not {request.model}")
    if not 1 <= request.n <= MAX_IMAGES:
        return _error(400, "invalid_request", f"n must be between 1 and {MAX_IMAGES}")
    if request.response_format != "b64_json":
        # No URL form: this backend stores nothing, so a URL would have to be a lie or a new lifetime to manage.
        return _error(400, "invalid_request", "only response_format=b64_json is supported")
    try:
        width, height = (int(part) for part in request.size.lower().split("x"))
    except Exception:
        return _error(400, "invalid_request", "size must look like 1024x1024")
    if not (256 <= width <= 2048 and 256 <= height <= 2048):
        return _error(400, "invalid_request", "each side must be between 256 and 2048")

    steps = min(request.steps or DEFAULT_STEPS, MAX_STEPS)
    generator = torch.Generator(device="cuda").manual_seed(request.seed) if request.seed is not None else None

    with _lock:
        pipe = pipeline()
        output = pipe(
            prompt=request.prompt,
            negative_prompt=request.negative_prompt,
            width=width, height=height,
            num_inference_steps=steps,
            num_images_per_prompt=request.n,
            generator=generator,
        )

    data = []
    for image in output.images:
        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
        data.append({"b64_json": base64.b64encode(buffer.getvalue()).decode()})
    return {"created": int(time.time()), "data": data}
