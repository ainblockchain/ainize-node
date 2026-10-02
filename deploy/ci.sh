#!/usr/bin/env bash
# Verify this release before switching the running service. State is host owned.
set -euo pipefail
WORK=${1:?release source required}
SHA=${2:?full SHA required}
DIRTY=${3:-false}
[[ "$SHA" =~ ^[a-f0-9]{40}$ ]] || exit 2
[[ "$DIRTY" == true || "$DIRTY" == false ]] || exit 2
if [[ -e "$WORK/.git" && "$DIRTY" == false ]]; then
  [[ "$(git -C "$WORK" rev-parse HEAD)" == "$SHA" ]] || exit 2
fi
STATE=${AINIZE_CI_STATE_DIR:?CI state directory required}
mkdir -p "$STATE"; chmod 700 "$STATE"
LOG="$STATE/$SHA.log"
exec >>"$LOG" 2>&1
chmod 600 "$LOG"
TMP=$(mktemp -d)
export AINIZE_HOME="$TMP/home" CI=1
STAGE=prepare
report() {
  python3 - "$STATE/status.json" "$SHA" "$STAGE" "$1" "$2" "$LOG" "$DIRTY" <<'PYREPORT'
import datetime,json,sys
from pathlib import Path
p=Path(sys.argv[1]);t=p.with_suffix('.tmp')
s=dict(sha=sys.argv[2],stage=sys.argv[3],status=sys.argv[4],exitCode=int(sys.argv[5]),logPath=sys.argv[6],dirty=sys.argv[7]=='true',updatedAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
t.write_text(json.dumps(s));t.chmod(0o600);t.replace(p)
PYREPORT
}
finish() {
  code=$?; trap - EXIT
  if [[ "$code" -ne 0 ]]; then report failed "$code"; fi
  rm -rf "$TMP"
  exit "$code"
}
trap finish EXIT
stage() { STAGE=$1; report running 0; printf '\n=== %s ===\n' "$STAGE"; }
cd "$WORK"
stage install
npm ci --include=dev --ignore-scripts --no-audit --no-fund
stage typecheck
npm run typecheck
stage test
npm run test
stage docs:check
bash "$WORK/deploy/ci-docs.sh" "$WORK"
stage build
npm run build
[[ -f dist/bin.js ]] || { echo "build produced no dist/bin.js"; exit 1; }
stage production-dependencies
npm prune --omit=dev --ignore-scripts --no-audit --no-fund
STAGE=complete
report success 0
