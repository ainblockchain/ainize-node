#!/usr/bin/env bash
#
# Qwen3-ASR-1.7B on one A100, serving OpenAI's transcription endpoint.
#
# vLLM (0.27.1+) serves Qwen3ASRForConditionalGeneration on `/v1/audio/transcriptions` directly — the runner is chosen
# container and no new serving code. It gets its own GPU: audio and the language model have no reason to wait for
# each other, and the node's transcription queue is separate for the same reason.
#
# GPU 5 by default — 0-3 serve Qwen3.8-Flash-Next (TP=4), 4 and 7 are in use, 5 and 6 are free.
set -euo pipefail

MODEL_DIR=${MODEL_DIR:-/mnt/newdata/models/Qwen3-ASR-1.7B}
IMAGE=${IMAGE:-vllm-openai:audio}   # built from deploy/stt-audio.Dockerfile: the published image has no audio decoder
NAME=${NAME:-ainize-stt}
PORT=${PORT:-8100}
GPUS=${GPUS:-'"device=5"'}
# 1.7B in bf16 is ~3.5 GB on an 80 GB card; the rest is KV cache for concurrent transcriptions.
GPU_FRACTION=${GPU_FRACTION:-0.30}

# DETACH=1 leaves the backend running after this shell exits. Without it the container dies with whatever
# started the script — including a terminal that closed, or a supervisor that timed the script out.
DETACH=${DETACH:-0}
RUN_FLAGS=(--rm --name "$NAME")
[ "$DETACH" = "1" ] && RUN_FLAGS+=(-d)

docker rm -f "$NAME" >/dev/null 2>&1 || true
exec docker run "${RUN_FLAGS[@]}" \
  --gpus "$GPUS" \
  --shm-size 8g \
  -p "${PORT}:8000" \
  -v "${MODEL_DIR}:/model:ro" \
  "$IMAGE" \
  --model /model \
  --served-model-name qwen3-asr \
  --gpu-memory-utilization "$GPU_FRACTION" \
  --max-model-len 8192 \
  --disable-custom-all-reduce
