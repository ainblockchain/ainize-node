#!/usr/bin/env bash
#
# Qwen-Image-2512 on one A100, serving OpenAI's image endpoint through the diffusers sidecar.
#
# GPU 6 by default — 0-3 serve the language model (TP=4), 5 serves Qwen3-ASR, 4 and 7 are in use.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
MODEL_DIR=${MODEL_DIR:-/mnt/newdata/models/Qwen-Image-2512}
IMAGE=${IMAGE:-ainize-image-sidecar:latest}
NAME=${NAME:-ainize-image}
PORT=${PORT:-8200}
GPUS=${GPUS:-'"device=6"'}

docker build -q -t "$IMAGE" "$HERE/image-sidecar" >/dev/null
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
  -e MODEL_DIR=/model \
  -e SERVED_MODEL_NAME=qwen-image-2512 \
  "$IMAGE"
