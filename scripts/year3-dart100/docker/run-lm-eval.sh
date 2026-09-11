#!/usr/bin/env bash
set -euo pipefail
SOURCE=$(cd "$(dirname "$0")/.." && pwd)
KPI=${KPI_ROOT:-/mnt/newdata/gov/kpi}
RUN_ID=${RUN_ID:?set an evaluation RUN_ID; use the same ID to replay saved responses}
LIFECYCLE=${AINIZE_LIFECYCLE_RUN:-ainize_lifecycle100_20260911}
[[ "$RUN_ID" =~ ^[A-Za-z0-9_-]{1,64}$ && "$LIFECYCLE" =~ ^[A-Za-z0-9_-]{1,64}$ && $# -gt 0 ]] || exit 1
for lesson in "$@"; do [[ "$lesson" =~ ^dart-[0-9]{3}-[A-Za-z0-9_-]+$ ]] || exit 1; done
OUT="$KPI/evidence/$RUN_ID"
IMAGE=${LM_EVAL_IMAGE:-ain-cert-lm-eval:20260911}
if [ ! -d "$OUT" ]; then
  mkdir "$OUT" "$OUT/source"
  cp "$SOURCE/lm_eval_ainize.py" "$OUT/source/"
  cp "$0" "$OUT/source/run-lm-eval.sh"
  (cd "$OUT/source" && sha256sum *) > "$OUT/source.sha256"
fi
(cd "$OUT/source" && sha256sum --check ../source.sha256)
ATTEMPT=$(mktemp -d "$OUT/attempt-XXXXXXXX")
docker top ain-cert-ainize-node-1 -eo pid,stat,args > "$ATTEMPT/node-processes.txt"
if awk '$0 ~ /node .*ainize-lifecycle[.]js/ && $2 !~ /T/ {found=1} END {exit !found}' "$ATTEMPT/node-processes.txt"; then
  echo 'lifecycle observer is active; coordinate an idle maintenance window, do not cancel training' >&2
  exit 1
fi
container="ain-cert-lmeval-$(basename "$ATTEMPT")"
docker create --name "$container" --network host --cpus 1 --cpuset-cpus 0-7 \
  --memory 2g --memory-swap 2g --read-only --tmpfs /tmp:rw,nosuid,size=512m \
  --user "$(id -u):$(id -g)" -e HOME=/tmp \
  --mount "type=bind,src=$KPI/ainize/home-docker/cli.json,dst=/private/cli.json,readonly" \
  --mount "type=bind,src=$KPI/evidence,dst=/inputs,readonly" \
  --mount "type=bind,src=$OUT,dst=/evidence" \
  --mount "type=bind,src=$OUT/source,dst=/source,readonly" \
  "$IMAGE" /source/lm_eval_ainize.py --evidence /inputs --lifecycle "$LIFECYCLE" \
  --lessons "$@" --cli-state /private/cli.json --output /evidence/results > "$ATTEMPT/container-id.txt"
docker inspect "$container" --format '{{json .HostConfig}}' > "$ATTEMPT/limits.json"
docker inspect "$container" --format '{{json .Image}}' > "$ATTEMPT/image.json"
set +e
docker start -a "$container" > "$ATTEMPT/stdout.log" 2> "$ATTEMPT/stderr.log"
result=$?
set -e
docker inspect "$container" --format '{{json .State}}' > "$ATTEMPT/state.json"
printf '%s\n' "$result" > "$ATTEMPT/exit-code.txt"
echo "lm-eval observer exit=$result evidence=$OUT; an uncertain request is never automatically retried"
exit "$result"
