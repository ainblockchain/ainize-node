#!/usr/bin/env bash
#
# A language model on one A100, serving OpenAI's chat endpoint.
#
# This is the small always-on model a node can run beside its other backends. The flagship
# Qwen3.8-Flash-Next needs TP=4 and its own script (/mnt/newdata/qwen3.8/serve.sh); point MODEL_DIR and
# SERVED_MODEL_NAME at whichever the operator actually wants to serve.
#
# GPU 7 by default — 0-4 are occupied, 5 serves Qwen3-ASR and 6 serves the image model.
set -euo pipefail

MODEL_DIR=${MODEL_DIR:-/mnt/newdata/models/Qwen2.5-7B-Instruct-AWQ}
SERVED_MODEL_NAME=${SERVED_MODEL_NAME:-qwen2.5-7b-instruct}
IMAGE=${IMAGE:-vllm/vllm-openai:latest}
NAME=${NAME:-ainize-llm}
PORT=${PORT:-8000}
GPUS=${GPUS:-'"device=7"'}
GPU_FRACTION=${GPU_FRACTION:-0.35}
MAXLEN=${MAXLEN:-16384}

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
  --served-model-name "$SERVED_MODEL_NAME" \
  --gpu-memory-utilization "$GPU_FRACTION" \
  --max-model-len "$MAXLEN" \
  --disable-custom-all-reduce
