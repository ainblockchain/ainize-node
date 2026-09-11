#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
core=${1:?Pass the ainize-core source directory containing the relay config fields}
evidence=${2:?Pass a new evidence directory}
image=${AINIZE_TEST_IMAGE:-ain-cert-ainize-cli:hf-import-20260911-r5}
mkdir -p "$evidence"
evidence=$(realpath "$evidence")
core=$(realpath "$core")
name="ain-cert-blob-relay-tests-$(date -u +%Y%m%dT%H%M%S)"
git -C "$root" rev-parse HEAD > "$evidence/node-base-commit.txt"
git -C "$core" rev-parse HEAD > "$evidence/core-commit.txt"
docker image inspect "$image" --format '{{.Id}}' > "$evidence/image-id.txt"
for package in core node; do
  source=$root
  if [ "$package" = core ]; then source=$core; fi
  target=$evidence/source/$package
  mkdir -p "$target"
  cp -a "$source/src" "$source/package.json" "$source"/tsconfig*.json "$target/"
  for optional in test fixtures trainer scripts; do
    if [ -d "$source/$optional" ]; then cp -a "$source/$optional" "$target/"; fi
  done
done
(cd "$evidence/source" && find . -type f -print0 | sort -z | xargs -0 sha256sum) > "$evidence/source-sha256.txt"
docker create --name "$name" --network none --cpus 2 --cpuset-cpus 0-7 --memory 4g --memory-swap 4g \
  --read-only --tmpfs /tmp:rw,exec,size=2g --mount "type=bind,src=$evidence/source/node,dst=/source/node,readonly" \
  --mount "type=bind,src=$evidence/source/core,dst=/source/core,readonly" --entrypoint bash "$image" -ceu '
for package in core node; do
  target=/tmp/ainize-$package
  mkdir -p "$target"
  cp -a /source/$package/src /source/$package/package.json /source/$package/tsconfig*.json "$target/"
  cp -a /opt/ainize/ainize-$package/node_modules "$target/"
  for optional in test fixtures trainer scripts; do
    if [ -d /source/$package/$optional ]; then cp -a /source/$package/$optional "$target/"; fi
  done
done
cd /tmp/ainize-core
npm run build
cd /tmp/ainize-node
npm run build
node --test --import tsx test/blob-relay.test.ts test/retry-public-blob.test.ts
node --test --import tsx test/guard-api.test.ts test/cluster.test.ts
' > "$evidence/container-id.txt"
docker inspect "$name" --format '{{json .HostConfig}}' > "$evidence/host-config.json"
set +e
docker start -a "$name" > "$evidence/tests.log" 2>&1
result=$?
set -e
docker inspect "$name" --format '{{json .State}}' > "$evidence/container-state.json"
cat "$evidence/tests.log"
exit "$result"
