#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
OUTPUT=${1:?Existing isolated-chain output directory required}
CORE=${AIN_HF_CORE:?Absolute core checkout required}
CLI=${AIN_HF_CLI:?Absolute CLI checkout required}
BENCH=${AIN_HF_BENCH:?Absolute benchmark checkout required}
IMAGE=${AIN_HF_IMAGE:?Pinned Node 24 controller image required}
: "${AIN_INFERENCE_TEST_URL:?Run as isolated-chain follow-up}"
[[ "$IMAGE" =~ ^sha256:[a-f0-9]{64}$ && "$CORE" = /* && "$CLI" = /* && "$BENCH" = /* ]]
[[ -f "$OUTPUT/evidence.json" && -f "$CORE/dist/index.js" && -f "$CLI/src/bin.ts" ]]
NAME="ain-hf-chain-check-$$-$(date +%s)"
CREATED=false
cleanup() {
  if "$CREATED"; then
    docker logs "$NAME" > "$OUTPUT/hf-controller.log" 2>&1 || true
    docker rm -f "$NAME" >/dev/null
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker create --name "$NAME" --network host --cpus 2 --memory 4g --memory-swap 4g --pids-limit 512 \
  --user "$(id -u):$(id -g)" -w /work/node -e AIN_INFERENCE_TEST_URL -e OPENBLAS_NUM_THREADS=1 \
  -v "$ROOT:/work/node:ro" -v "$CORE:/work/node/node_modules/@ainize/core:ro" \
  -v "$CLI:/work/cli:ro" -v "$BENCH:/work/bench:ro" -v "$OUTPUT:/output" \
  "$IMAGE" --import tsx scripts/verify-hf-training-chain.ts >/dev/null
CREATED=true
docker inspect "$NAME" --format '{"image":"{{.Image}}","cpuNano":{{.HostConfig.NanoCpus}},"memoryBytes":{{.HostConfig.Memory}},"memorySwapBytes":{{.HostConfig.MemorySwap}},"network":"{{.HostConfig.NetworkMode}}"}' > "$OUTPUT/hf-controller-docker.json"
timeout 240 docker start -a "$NAME"
[[ $(docker inspect "$NAME" --format '{{.State.ExitCode}}') == 0 ]]
