#!/usr/bin/env bash
# Stop the demo cluster via its pid files (never pattern-matches other processes), optionally wipe, start again.
#   scripts/cluster-restart.sh          # keep data
#   scripts/cluster-restart.sh --fresh  # wipe ~/.ngram-cluster first
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOME_DIR="${NGRAM_CLUSTER_HOME:-$HOME/.ngram-cluster}"
export PATH="$HOME/.local/node/bin:$PATH"
for f in "$HOME_DIR/supervisor.pid" "$HOME_DIR/nodes.pid"; do
  [[ -f "$f" ]] && while read -r pid; do [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true; done < "$f"
done
sleep 2
if [[ "${1:-}" == "--fresh" ]]; then rm -rf "$HOME_DIR"; fi
mkdir -p "$HOME_DIR"
setsid nohup node "$ROOT/scripts/cluster.mjs" > "$HOME_DIR/cluster.log" 2>&1 < /dev/null &
echo "cluster starting (log: $HOME_DIR/cluster.log)"
