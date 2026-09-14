#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
OUTPUT=${1:?Existing isolated-chain output directory required}
CORE=${AIN_LIVE_CORE:?Absolute core checkout required}
IMAGE=${AIN_LIVE_NODE_IMAGE:?Pinned node-controller image ID required}
REPO=${AIN_LIVE_MODEL_REPO:?Existing model repository required}
: "${AIN_INFERENCE_TEST_URL:?Run as test-inference-chain.sh follow-up}"
[[ "$IMAGE" =~ ^sha256:[a-f0-9]{64}$ && "$CORE" = /* && "$REPO" = /* ]]
[[ -d "$REPO/ple_patch" && -f "$CORE/dist/index.js" ]]
NAME="ain-live-chat-check-$$-$(date +%s)"
CREATED=false
cleanup() { if "$CREATED"; then docker rm -f "$NAME" >/dev/null; fi; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker create --name "$NAME" --network host --cpus 2 --memory 4g --memory-swap 4g --pids-limit 512 \
  --user "$(id -u):$(id -g)" -w /work/node \
  -v "$ROOT:/work/node:ro" -v "$CORE:/work/node/node_modules/@ainize/core:ro" \
  -v "$OUTPUT:/output" -v "$REPO:$REPO:ro" -v "$REPO/ple_patch:$REPO/ple_patch:rw" \
  -e AINIZE_INFERENCE_RECORDS=true -e AIN_INFERENCE_TEST_URL \
  -e AIN_LIVE_MODEL_REPO="$REPO" -e AIN_LIVE_MODEL_API="${AIN_LIVE_MODEL_API:-http://127.0.0.1:8000}" \
  -e AIN_LIVE_EXISTING_NODE="${AIN_LIVE_EXISTING_NODE:-http://127.0.0.1:3410}" \
  "$IMAGE" --import tsx scripts/verify-live-chat-chain.ts >/dev/null
CREATED=true
docker inspect "$NAME" --format '{"image":"{{.Image}}","cpuNano":{{.HostConfig.NanoCpus}},"memoryBytes":{{.HostConfig.Memory}},"memorySwapBytes":{{.HostConfig.MemorySwap}}}' > "$OUTPUT/live-controller-docker.json"
timeout 180 docker start -a "$NAME"
[[ $(docker inspect "$NAME" --format '{{.State.ExitCode}}') == 0 ]]
