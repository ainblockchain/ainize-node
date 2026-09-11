#!/usr/bin/env bash
set -euo pipefail
NODE=$(cd "$(dirname "$0")/.." && pwd)
CORE=$(realpath "${1:?pass the compatible ainize-core worktree}")
CLI=$(realpath "${2:?pass the compatible ainize-cli worktree}")
OUT=${3:?pass a new build evidence directory}
IMAGE=${4:?pass a new local image tag}
BASE=${AINIZE_BASE_IMAGE:?pass the existing dependency/runtime image ID or tag}
mkdir "$OUT"
OUT=$(realpath "$OUT")
mkdir "$OUT/context"
BASE_ID=$(docker image inspect "$BASE" --format '{{.Id}}')
printf '%s\n' "$BASE_ID" > "$OUT/base-image.txt"
for name in core node cli; do
  source=$NODE
  if [ "$name" = core ]; then source=$CORE; fi
  if [ "$name" = cli ]; then source=$CLI; fi
  mkdir "$OUT/context/$name"
  cp -a "$source/src" "$source/package.json" "$source"/tsconfig*.json "$OUT/context/$name/"
  git -C "$source" rev-parse HEAD > "$OUT/$name-commit.txt"
done
cp -a "$NODE/trainer" "$OUT/context/node/"
cp "$NODE/deploy/source-refresh.Dockerfile" "$OUT/context/Dockerfile"
(cd "$OUT/context" && find . -type f -print0 | sort -z | xargs -0 sha256sum) > "$OUT/source-sha256.txt"
DOCKER_BUILDKIT=0 docker build --cpu-period 100000 --cpu-quota 200000 --cpuset-cpus "${AINIZE_CPUSET:-0-7}" \
  --memory 4g --memory-swap 4g --build-arg "BASE_IMAGE=$BASE_ID" -t "$IMAGE" "$OUT/context" > "$OUT/build.log" 2>&1
docker image inspect "$IMAGE" > "$OUT/image.json"
echo "Built $IMAGE. This command does not replace a running node or publish an image."
