#!/usr/bin/env bash
#
# Clef / Clef-flash behind the Jev/SystemOne `/v1/systemone` endpoint, one model per process.
#
# vLLM cannot serve Clef (custom joint-schema head, trust_remote_code), so this is a small
# FastAPI sidecar, the same shape as serve-image.sh. The node reaches it over HTTP and does the
# auth, routing and queueing.
#
# Two ways to run, chosen by RUNTIME:
#   RUNTIME=venv   (default) run uvicorn in a prepared virtualenv — used on the DGX, where the
#                  serving user has no docker access. Set VENV to the env with the deps.
#   RUNTIME=docker build clef-sidecar/Dockerfile and `docker run --gpus`, like serve-image.sh.
#
# Launch once per model, each on its own GPU and port, e.g.:
#   MODEL=clef-flash PORT=8300 GPUS=1 DETACH=1 ./serve-clef.sh
#   MODEL=clef       PORT=8301 GPUS=2 DETACH=1 ./serve-clef.sh
# then point two `decision` backends in config.json at http://127.0.0.1:8300 and :8301.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)

MODEL=${MODEL:-clef-flash}                       # clef-flash | clef (the served model name)
MODEL_PATH=${MODEL_PATH:-Cloudflare/$MODEL}       # local snapshot dir, or an HF id to download
PORT=${PORT:-8300}
GPUS=${GPUS:-1}                                   # CUDA_VISIBLE_DEVICES for this process
MAX_LENGTH=${MAX_LENGTH:-16384}
HEAD_OVERRIDE=${HEAD_OVERRIDE:-}                  # optional fine-tuned joint head (a Teach export)
RUNTIME=${RUNTIME:-venv}
DETACH=${DETACH:-0}
NAME=${NAME:-ainize-clef-$MODEL}

if [ "$RUNTIME" = "docker" ]; then
  IMAGE=${IMAGE:-ainize-clef-sidecar:latest}
  docker build -q -t "$IMAGE" "$HERE/clef-sidecar" >/dev/null
  RUN_FLAGS=(--rm --name "$NAME")
  [ "$DETACH" = "1" ] && RUN_FLAGS+=(-d)
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  MOUNTS=()
  [ -d "$MODEL_PATH" ] && MOUNTS+=(-v "$MODEL_PATH:/model:ro") && MP=/model || MP="$MODEL_PATH"
  exec docker run "${RUN_FLAGS[@]}" \
    --gpus "\"device=$GPUS\"" --shm-size 8g -p "${PORT}:8000" \
    "${MOUNTS[@]}" \
    -e MODEL_PATH="$MP" -e SERVED_MODEL_NAME="$MODEL" -e MAX_LENGTH="$MAX_LENGTH" \
    -e HEAD_OVERRIDE="${HEAD_OVERRIDE:+/head.safetensors}" \
    "$IMAGE"
fi

# --- venv runtime (default) ---
VENV=${VENV:-$HOME/clef/venv}
if [ ! -x "$VENV/bin/uvicorn" ] && [ ! -x "$VENV/bin/python" ]; then
  echo "no virtualenv at $VENV — create it and install clef-sidecar/requirements.txt first" >&2
  exit 1
fi
# shellcheck disable=SC1091
source "$VENV/bin/activate"

export CUDA_VISIBLE_DEVICES="$GPUS"
export MODEL_PATH SERVED_MODEL_NAME="$MODEL" MAX_LENGTH HEAD_OVERRIDE DEVICE=cuda
export HF_HOME="${HF_HOME:-$HOME/clef/hf}"
export PYTHONPATH="$HERE/clef-sidecar:${PYTHONPATH:-}"

LOGDIR="${LOGDIR:-$HOME/clef/logs}"; mkdir -p "$LOGDIR"
LOG="$LOGDIR/$NAME.log"

start() { exec python -m uvicorn server:app --app-dir "$HERE/clef-sidecar" --host 127.0.0.1 --port "$PORT"; }

if [ "$DETACH" = "1" ]; then
  echo "starting $NAME on GPU $GPUS, port $PORT -> $LOG"
  setsid bash -c "$(declare -f start); export CUDA_VISIBLE_DEVICES='$GPUS' MODEL_PATH='$MODEL_PATH' SERVED_MODEL_NAME='$MODEL' MAX_LENGTH='$MAX_LENGTH' HEAD_OVERRIDE='$HEAD_OVERRIDE' DEVICE=cuda HF_HOME='$HF_HOME'; cd '$HERE'; start" \
    >"$LOG" 2>&1 < /dev/null &
  echo "pid $!"
else
  start
fi
