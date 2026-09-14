#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
IMAGE=${AIN_LEASE_TEST_IMAGE:?Pinned local Node 24 image required}
OUTPUT=${1:?New evidence directory required}
[[ "$IMAGE" =~ ^sha256:[a-f0-9]{64}$ && ! -e "$OUTPUT" ]]
docker image inspect "$IMAGE" >/dev/null
mkdir -m 700 -p "$OUTPUT"
OUTPUT=$(cd "$OUTPUT" && pwd)
NAME="ain-lease-check-$$-$(date +%s)"
HOLDER_CREATED=false
CONTENDER_CREATED=false
cleanup() {
  if "$CONTENDER_CREATED"; then docker rm -f "$NAME-contender" >/dev/null; fi
  if "$HOLDER_CREATED"; then docker rm -f "$NAME-holder" >/dev/null; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
COMMON=(--network none --cpus 1 --memory 512m --memory-swap 512m --pids-limit 128
  --user "$(id -u):$(id -g)" -v "$ROOT:/work:ro" -v "$OUTPUT:/output" -w /work --entrypoint node)
docker create --name "$NAME-holder" "${COMMON[@]}" "$IMAGE" --import tsx --input-type=module -e '
import { claimSharedLease } from "./src/shared-lease.ts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const release=claimSharedLease("/output/lease", {owner:`pid:${process.pid}`, since:1});
if(!release) throw Error("holder could not acquire lease");
try {
  writeFileSync("/output/holder.json",readFileSync("/output/lease/holder.json"),{flag:"wx",mode:0o600});
  const deadline=Date.now()+45000;
  while(!existsSync("/output/release-holder")){if(Date.now()>deadline)throw Error("release timeout");await new Promise(resolve=>setTimeout(resolve,100));}
} finally { release(); }
' >/dev/null
HOLDER_CREATED=true
docker start "$NAME-holder" >/dev/null
for attempt in $(seq 1 100); do
  [[ -f "$OUTPUT/holder.json" ]] && break
  [[ $(docker inspect "$NAME-holder" --format '{{.State.Running}}') == true ]]
  sleep 0.1
done
[[ -f "$OUTPUT/holder.json" ]]
docker create --name "$NAME-contender" "${COMMON[@]}" "$IMAGE" --import tsx --input-type=module -e '
import assert from "node:assert/strict";
import { claimSharedLease, leaseLiveness } from "./src/shared-lease.ts";
import { readFileSync, readlinkSync, writeFileSync } from "node:fs";
const holder=JSON.parse(readFileSync("/output/holder.json","utf8"));
const namespace=readlinkSync("/proc/self/ns/pid");
assert.notEqual(namespace,holder.process_scope.namespace);
assert.equal(leaseLiveness(holder),"unknown");
assert.equal(claimSharedLease("/output/lease",{owner:`pid:${process.pid}`,since:Date.now()}),null);
assert.equal(JSON.parse(readFileSync("/output/lease/holder.json","utf8")).lease_id,holder.lease_id);
writeFileSync("/output/contender.json",JSON.stringify({pid:process.pid,namespace,holderLiveness:"unknown",acquired:false,originalLeasePreserved:true})+"\n",{flag:"wx",mode:0o600});
' >/dev/null
CONTENDER_CREATED=true
timeout 30 docker start -a "$NAME-contender"
[[ $(docker inspect "$NAME-contender" --format '{{.State.ExitCode}}') == 0 ]]
touch "$OUTPUT/release-holder"
[[ $(timeout 15 docker wait "$NAME-holder") == 0 ]]
[[ ! -e "$OUTPUT/lease" ]]
docker inspect "$NAME-holder" --format '{"image":"{{.Image}}","cpuNano":{{.HostConfig.NanoCpus}},"memoryBytes":{{.HostConfig.Memory}},"memorySwapBytes":{{.HostConfig.MemorySwap}},"network":"{{.HostConfig.NetworkMode}}"}' > "$OUTPUT/docker.json"
printf '{"passed":true,"scope":"Two Docker PID namespaces sharing one test lease, not GPU concurrency or performance proof"}\n' > "$OUTPUT/result.json"
cat "$OUTPUT/result.json"
