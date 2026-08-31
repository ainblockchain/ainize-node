#!/usr/bin/env bash
# Stop the demo cluster (supervisor + node processes), optionally wipe its homes, and start it again detached.
#   scripts/cluster-restart.sh          # keep data
#   scripts/cluster-restart.sh --fresh  # wipe ~/.ngram-cluster first
#   scripts/cluster-restart.sh --stop   # stop only
#   NGRAM_CLUSTER_HOME=/tmp/c NGRAM_PORT_BASE=3502 scripts/cluster-restart.sh   # restart a private cluster only
# Processes are found by scanning /proc argv (node's main thread is named "MainThread", so pgrep -x node misses it);
# only processes whose script is scripts/cluster.mjs or packages/node/dist/bin.js AND whose environment points at
# THIS cluster home (NGRAM_HOME=<home>/node-*, NGRAM_CLUSTER_HOME=<home>, or the default home when unset) are signalled.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEFAULT_HOME="$HOME/.ngram-cluster"
HOME_DIR="${NGRAM_CLUSTER_HOME:-$DEFAULT_HOME}"
PORT_BASE="${NGRAM_PORT_BASE:-3402}"
export PATH="$HOME/.local/node/bin:$PATH"
owns_home() {   # $1 = pid — true when the process belongs to the cluster rooted at HOME_DIR
  local env; env=$(tr '\0' '\n' < "/proc/$1/environ" 2>/dev/null) || return 1
  local h; h=$(printf '%s\n' "$env" | sed -n 's/^NGRAM_HOME=//p' | head -1)
  if [[ -n "$h" ]]; then [[ "$h" == "$HOME_DIR"/* ]]; return; fi
  local c; c=$(printf '%s\n' "$env" | sed -n 's/^NGRAM_CLUSTER_HOME=//p' | head -1)
  [[ "${c:-$DEFAULT_HOME}" == "$HOME_DIR" ]]
}
stop_matching() {
  for d in /proc/[0-9]*; do
    pid="${d#/proc/}"
    [[ "$pid" == "$$" || "$pid" == "$PPID" ]] && continue
    args=$(tr '\0' ' ' < "$d/cmdline" 2>/dev/null) || continue
    case "$args" in
      *"$ROOT/scripts/cluster.mjs"*|*"$ROOT/packages/node/dist/bin.js"*) owns_home "$pid" && kill "$pid" 2>/dev/null && echo "stopped $pid";;
    esac
  done
}
stop_matching; sleep 2; stop_matching
if [[ "${1:-}" == "--stop" ]]; then echo "cluster stopped (home $HOME_DIR)"; exit 0; fi
# wait until the demo ports are released (up to 30 s)
PORTS="$PORT_BASE|$((PORT_BASE+1))|$((PORT_BASE+2))"
for i in $(seq 1 30); do if ss -ltn 2>/dev/null | grep -qE ":($PORTS)\b"; then sleep 1; else break; fi; done
if [[ "${1:-}" == "--fresh" ]]; then rm -rf "$HOME_DIR"; fi
mkdir -p "$HOME_DIR"
setsid nohup node "$ROOT/scripts/cluster.mjs" > "$HOME_DIR/cluster.log" 2>&1 < /dev/null &
echo "cluster starting (log: $HOME_DIR/cluster.log)"
