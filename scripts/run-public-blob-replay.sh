#!/usr/bin/env bash
set -euo pipefail
umask 077
root=$(cd "$(dirname "$0")/.." && pwd)
manifest=$(realpath "${1:?Pass a manifest containing only the original signed public anchors}")
config=$(realpath "${2:?Pass the original publisher config (private, read-only)}")
bodies=$(realpath "${3:?Pass a directory containing SHA-named original NPZ files}")
evidence=${4:?Pass a new evidence directory}
private=${5:?Pass a new private receiver-state directory outside evidence}
image=${AINIZE_REPLAY_IMAGE:?Set a source-built image containing dist/blob-upload.js}
mkdir "$evidence"
mkdir "$private"
evidence=$(realpath "$evidence")
private=$(realpath "$private")
case "$private/" in "$evidence/"*) echo 'Private state must be outside evidence' >&2; exit 1;; esac
case "$evidence/" in "$private/"*) echo 'Evidence must be outside private state' >&2; exit 1;; esac
name="ain-cert-original-relay-$(date -u +%Y%m%dT%H%M%S)-$$"
receiver="$name-receiver"
network="$name-network"
containers=()
cleanup() {
  result=$?
  trap - EXIT
  for container in "${containers[@]}"; do
    docker stop -t 30 "$container" >/dev/null 2>&1 || true
    docker logs "$container" > "$evidence/$container.log" 2>&1 || true
    docker inspect "$container" --format '{{json .State}}' > "$evidence/$container-state.json" 2>/dev/null || true
    docker rm "$container" >/dev/null 2>&1 || true
  done
  docker network rm "$network" >/dev/null 2>&1 || true
  printf '%s\n' "$result" > "$evidence/exit-code.txt"
  exit "$result"
}
trap cleanup EXIT
cp "$root/scripts/replay-public-blobs.mjs" "$evidence/"
cp "$root/scripts/run-public-blob-replay.sh" "$evidence/"
cp "$manifest" "$evidence/manifest.json"
git -C "$root" rev-parse HEAD > "$evidence/node-base-commit.txt"
docker image inspect "$image" --format '{{.Id}}' > "$evidence/image-id.txt"
(cd "$evidence" && sha256sum replay-public-blobs.mjs run-public-blob-replay.sh manifest.json) > "$evidence/source.sha256"
docker network create --internal "$network" > "$evidence/network-id.txt"
docker network inspect "$network" > "$evidence/network.json"
common=(--runtime runc --network "$network" --cpus 1 --cpuset-cpus "${AINIZE_REPLAY_CPUSET:-0-7}" --memory 1g --memory-swap 1g
  --pids-limit 128 --read-only --cap-drop ALL --security-opt no-new-privileges --user "$(id -u):$(id -g)"
  --tmpfs /tmp:rw,size=64m --env NVIDIA_VISIBLE_DEVICES=void --entrypoint node
  --mount "type=bind,src=$evidence/replay-public-blobs.mjs,dst=/opt/ainize/ainize-node/scripts/replay-public-blobs.mjs,readonly"
  --mount "type=bind,src=$evidence/manifest.json,dst=/input/manifest.json,readonly")
script=/opt/ainize/ainize-node/scripts/replay-public-blobs.mjs
docker create --name "$receiver" --network-alias relay "${common[@]}" \
  --mount "type=bind,src=$private,dst=/private/receiver" "$image" "$script" receiver > "$evidence/receiver-id.txt"
containers+=("$receiver")
docker inspect "$receiver" --format '{{json .HostConfig}}' > "$evidence/receiver-limits.json"
docker start "$receiver" >/dev/null
wait_ready() {
  for attempt in $(seq 1 60); do
    if docker exec "$receiver" node -e 'fetch("http://127.0.0.1:3400/healthz").then(response=>process.exit(response.ok?0:1)).catch(()=>process.exit(1))' >/dev/null 2>&1; then return; fi
    sleep 1
  done
  echo 'Isolated receiver failed readiness' >&2
  return 1
}
wait_ready
docker exec "$receiver" sh -c 'cd /opt/ainize; find ainize-core/dist ainize-node/dist -type f -print0 | sort -z | xargs -0 sha256sum' > "$evidence/runtime.sha256"
mounts=()
while IFS= read -r sha; do
  [[ "$sha" =~ ^[0-9a-f]{64}$ ]] || { echo 'Invalid manifest SHA' >&2; exit 1; }
  body=$(realpath "$bodies/$sha.npz")
  mounts+=(--mount "type=bind,src=$body,dst=/bodies/$sha.npz,readonly")
done < <(node -e 'for(const record of JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).records) console.log(record.body.patch_sha256)' "$manifest")
run_client() {
  mode=$1
  container="$name-$mode"
  body_mounts=()
  if [ "$mode" = send ]; then body_mounts=("${mounts[@]}"); fi
  docker create --name "$container" "${common[@]}" \
    --mount "type=bind,src=$config,dst=/private/publisher.json,readonly" "${body_mounts[@]}" \
    "$image" "$script" "$mode" > "$evidence/$mode-id.txt"
  containers+=("$container")
  docker inspect "$container" --format '{{json .HostConfig}}' > "$evidence/$mode-limits.json"
  timeout 180 docker start -a "$container" > "$evidence/$mode.log" 2>&1
  docker inspect "$container" --format '{{json .State}}' > "$evidence/$mode-state.json"
}
run_client send
docker stop -t 30 "$receiver" >/dev/null
docker inspect "$receiver" --format '{{json .State}}' > "$evidence/receiver-before-restart-state.json"
test "$(docker inspect "$receiver" --format '{{.State.ExitCode}}')" = 0
docker start "$receiver" >/dev/null
wait_ready
docker inspect "$receiver" --format '{{json .State}}' > "$evidence/receiver-after-restart-state.json"
run_client check
docker stop -t 30 "$receiver" >/dev/null
test "$(docker inspect "$receiver" --format '{{.State.ExitCode}}')" = 0
printf 'Original-body replay passed; this is isolated P2P transfer, not public delivery or Live inference.\n'
