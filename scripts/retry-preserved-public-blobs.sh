#!/usr/bin/env bash
set -euo pipefail
root=${GOV_ROOT:-/mnt/newdata/gov}
scripts=$(cd "$(dirname "$0")" && pwd)
output=${1:?Pass a NEW evidence directory}
run_id=${2:?Pass a unique lowercase RUN_ID}
[[ "$run_id" =~ ^[a-z0-9][a-z0-9_-]{0,40}$ ]] || exit 2
mkdir -m 700 "$output"
output=$(realpath "$output")
image=sha256:f45a08b206bc56a4c97a004e1229e7c64aceac7a17c2b300bf5b14470cae53ea
printf '%s\n' "$image" > "$output/image-id.txt"
date -u +%FT%TZ > "$output/at.txt"
sha256sum "$scripts/retry-public-blob.mjs" "$scripts/retry-preserved-public-blobs.sh" > "$output/source.sha256"
result=0
for patch in taught-ainize-teach-first-20260-855df1 taught-ainize-lifecycle100-2026-cf9a6f; do
  if [[ "$patch" == taught-ainize-teach-first-20260-855df1 ]]; then
    sha=f9f665f6fa1a6b37963a4845107c0c0a5d3b970bcd2af6e8f40938a0fbdf7acc
  else
    sha=fb1cd41e2f6a26f785d72460a2eac4a62688ee4c70e5bee43187d734eeca2e64
  fi
  file=$(realpath "$root/kpi/ainize/home-docker/data/drive/patches/$patch/$sha.npz")
  name="ain-cert-reoffer-$run_id-${sha:0:8}"
  docker create --name "$name" --user "$(id -u):$(id -g)" \
    --runtime runc --cpus 1 --cpuset-cpus 0-7 --memory 512m --memory-swap 512m \
    --read-only --pids-limit 128 --cap-drop ALL --security-opt no-new-privileges \
    -e NVIDIA_VISIBLE_DEVICES=void \
    --mount "type=bind,src=$root/kpi/ainize/home-docker/config.json,dst=/private-config.json,readonly" \
    --mount "type=bind,src=$file,dst=/body.npz,readonly" \
    --mount "type=bind,src=$scripts/retry-public-blob.mjs,dst=/opt/ainize/ainize-node/scripts/retry-public-blob.mjs,readonly" \
    "$image" scripts/retry-public-blob.mjs /private-config.json /body.npz "$patch" https://www.ainize.ai \
    > "$output/$sha-container-id.txt"
  docker inspect "$name" --format '{{json .HostConfig}}' > "$output/$sha-limits.json"
  exit_code=0
  docker start -a "$name" > "$output/$sha-signed.jsonl" 2>&1 || exit_code=$?
  printf '%s\n' "$exit_code" > "$output/$sha-exit-code.txt"
  cat "$output/$sha-signed.jsonl"
  if (( exit_code != 0 )); then result=1; fi
done
exit "$result"
