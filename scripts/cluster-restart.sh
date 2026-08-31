#!/usr/bin/env bash
# Stop the demo cluster (supervisor + node processes), optionally wipe its homes, and start it again detached.
#   scripts/cluster-restart.sh          # keep data
#   scripts/cluster-restart.sh --fresh  # wipe ~/.ngram-cluster first
# Processes are found by scanning /proc argv (node's main thread is named "MainThread", so pgrep -x node misses it),
# and only processes whose script is scripts/cluster.mjs or packages/node/dist/bin.js are signalled.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOME_DIR="${NGRAM_CLUSTER_HOME:-$HOME/.ngram-cluster}"
export PATH="$HOME/.local/node/bin:$PATH"
stop_matching() {
  for d in /proc/[0-9]*; do
    pid="${d#/proc/}"
    [[ "$pid" == "$$" || "$pid" == "$PPID" ]] && continue
    args=$(tr '\0' ' ' < "$d/cmdline" 2>/dev/null) || continue
    case "$args" in
      *"$ROOT/scripts/cluster.mjs"*|*"$ROOT/packages/node/dist/bin.js"*) kill "$pid" 2>/dev/null && echo "stopped $pid";;
    esac
  done
}
stop_matching; sleep 2; stop_matching
# wait until the demo ports are released (up to 30 s)
for i in $(seq 1 30); do if ss -ltn 2>/dev/null | grep -qE ":(3402|3403|3404)\b"; then sleep 1; else break; fi; done
if [[ "${1:-}" == "--fresh" ]]; then rm -rf "$HOME_DIR"; fi
mkdir -p "$HOME_DIR"
setsid nohup node "$ROOT/scripts/cluster.mjs" > "$HOME_DIR/cluster.log" 2>&1 < /dev/null &
echo "cluster starting (log: $HOME_DIR/cluster.log)"
