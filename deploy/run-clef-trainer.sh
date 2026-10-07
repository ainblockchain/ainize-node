#!/usr/bin/env bash
#
# Start (or restart) the persistent Clef Teach trainer container. The node execs into it per lesson; it is
# NOT launched per job. Point the node at it with:
#   ainize config set teach.backend gradient
#   ainize config set teach.trainer.container clef-trainer
#   ainize config set teach.trainer.script   train/clef_teach.py
#   ainize config set teach.trainer.gpus     <training GPUs, e.g. 6,7 — must NOT overlap runtime.gpus>
#
# WORK is mounted at /work: it must contain `train/clef_teach.py` and the node's `.teach/<id>/` job dirs,
# i.e. the node's runtime.repo / data dir. MODEL_DIR (a local Clef snapshot) and HF_CACHE are mounted so the
# backbone loads without re-downloading.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
NAME=${NAME:-clef-trainer}
IMAGE=${IMAGE:-ainize-clef-trainer:latest}
WORK=${WORK:?set WORK to the dir holding train/clef_teach.py and .teach/ (the node runtime.repo)}
MODEL_DIR=${MODEL_DIR:-}                 # optional: a local Clef snapshot dir, mounted read-only at /model
HF_CACHE=${HF_CACHE:-$HOME/clef/hf}      # HF cache so snapshot_download is a no-op
GPUS=${GPUS:-all}                        # all cards visible; the node restricts per-exec via CUDA_VISIBLE_DEVICES

docker build -q -t "$IMAGE" "$HERE/clef-trainer" >/dev/null

# Make train/clef_teach.py reachable at /work/train and live-editable (bind over the baked copy).
mkdir -p "$WORK/train"
cp "$HERE/clef-trainer/train/clef_teach.py" "$WORK/train/clef_teach.py"

MOUNTS=(-v "$WORK:/work" -v "$HF_CACHE:/hf")
[ -n "$MODEL_DIR" ] && MOUNTS+=(-v "$MODEL_DIR:/model:ro") && EXTRA_ENV=(-e CLEF_MODEL_PATH=/model) || EXTRA_ENV=()

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" --restart unless-stopped \
  --gpus "$GPUS" --shm-size 8g \
  "${MOUNTS[@]}" -e HF_HOME=/hf "${EXTRA_ENV[@]}" \
  "$IMAGE"

echo "started trainer container '$NAME' (image $IMAGE); /work=$WORK"
docker inspect -f '{{.State.Running}}' "$NAME"
