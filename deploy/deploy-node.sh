#!/usr/bin/env bash
# Deploy the public API node. This script lives in the repository it deploys.
#
#   deploy/deploy-node.sh              # deploy origin/main (the default)
#   deploy/deploy-node.sh v1.2.0       # …or any ref that exists on the remote
#   deploy/deploy-node.sh --here       # deploy THIS working tree, uncommitted changes and all
#
# WHY THIS EXISTS. The public node was already running this way — a release directory per commit under
# `$AINIZE_NODE_ROOT`, a `current` symlink, a systemd --user unit pointed at it — but the procedure lived only
# in whoever set it up. So a deploy was a sequence somebody retyped, and nothing recorded which commit was
# serving: `current` pointed at a directory named by a sha with no ref beside it, and the node that answers
# ainize.ai had been built from a feature branch for days without that being visible anywhere.
#
# WHAT A RELEASE IS. A directory holding the built node and its production dependencies, named by the commit
# it came from, plus a `build-info.json` that says which ref produced it. `current` is flipped atomically and
# the unit restarted. Running this twice on the same ref gives the same node.
#
# WHAT IT IS NOT. The node's DATA and CONFIG live in `AINIZE_HOME` (identity, ledger, registered agents), not
# in the release — a deploy never touches them. That separation is the reason a bad release can be rolled
# back by moving one symlink.
#
# THE ONE EXCEPTION: `deploy/ainize-ai/config.overlay.json`. Config that is decided in review (where deposits
# are received, which chains are watched) ships with the code: each top-level key there replaces that key in
# `$AINIZE_HOME/config.json`, nothing else is touched, and the previous file is kept beside it and restored
# together with the previous release when a deploy fails. See deploy/ainize-ai/README.md.
set -euo pipefail

ARG="${1:-main}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(git -C "$HERE" remote get-url origin 2>/dev/null || echo https://github.com/ainblockchain/ainize-node.git)"
ROOT="${AINIZE_NODE_ROOT:-/mnt/newdata/ainize-node-releases}"
RELEASES="$ROOT/releases"
SERVE="$ROOT/current"
UNIT="${AINIZE_NODE_UNIT:-ainize-public-node.service}"
NODE_BIN="${NODE_BIN:-$HOME/.local/node/bin}"
export PATH="$NODE_BIN:$PATH"
# The node's own API. Read from the home the unit runs with, so this never drifts from what is deployed.
NODE_HOME="${AINIZE_HOME:-$(systemctl --user show -p Environment --value "$UNIT" 2>/dev/null | tr ' ' '\n' | sed -n 's/^AINIZE_HOME=//p')}"
NODE_HOME="${NODE_HOME:-$HOME/.ainize-web}"
PORT="$(node -e 'try{process.stdout.write(String(require(process.argv[1]).port??3400))}catch{process.stdout.write("3400")}' "$NODE_HOME/config.json" 2>/dev/null || echo 3400)"

say() { printf '  %s\n' "$*"; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if [ "$ARG" = "--here" ]; then
  REF="(working tree)"
  SHA="$(git -C "$HERE" rev-parse HEAD)"
  DIRTY=true
  say "packing this working tree (based on ${SHA:0:12})"
  # `git archive` would drop uncommitted changes — the whole point of --here is to carry them.
  tar -C "$HERE" --exclude=.git --exclude=node_modules --exclude=dist -cf - . | tar -C "$WORK" -xf -
else
  REF="$ARG"
  DIRTY=false
  say "cloning $REF"
  git clone --quiet --depth 1 --branch "$REF" "$REPO" "$WORK" 2>/dev/null \
    || { git clone --quiet "$REPO" "$WORK"; git -C "$WORK" checkout --quiet "$REF"; }
  SHA="$(git -C "$WORK" rev-parse HEAD)"
fi

say "installing"
# `--ignore-scripts` because this package's `prepare` builds, and at this point TypeScript is not installed
# yet — without it the install dies inside its own lifecycle hook with a missing `tsc`.
( cd "$WORK" && { npm ci --omit=dev --ignore-scripts --silent 2>/dev/null || npm install --omit=dev --ignore-scripts --silent; } )
say "building"
# The build needs TypeScript, which --omit=dev left out; add it alone rather than the whole dev tree.
( cd "$WORK" && npm install --no-save --ignore-scripts --silent typescript >/dev/null 2>&1 && npx tsc -p tsconfig.json )
[ -f "$WORK/dist/bin.js" ] || { echo "build produced no dist/bin.js" >&2; exit 1; }

DEST="$RELEASES/$(date -u +%Y%m%dT%H%M%SZ)-${SHA:0:12}"
mkdir -p "$DEST"
tar -C "$WORK" --exclude=.git -cf - . | tar -C "$DEST" -xf -
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ref:process.argv[2],sha:process.argv[3],dirty:process.argv[4]==="true",built_at:new Date().toISOString(),repo:process.argv[5]},null,2))' \
  "$DEST/build-info.json" "$REF" "$SHA" "$DIRTY" "$REPO"

PREVIOUS="$(readlink -f "$SERVE" 2>/dev/null || true)"

# Config that ships with the code (see the header). Applied before the restart that reads it. A backup is made
# only when something changes — a redeploy of the same overlay must not replace the pre-overlay copy with one
# that already has it.
OVERLAY="$DEST/deploy/ainize-ai/config.overlay.json"
CONFIG="$NODE_HOME/config.json"
CONFIG_BACKUP=""
if [ -f "$OVERLAY" ] && [ -f "$CONFIG" ]; then
  CHANGED="$(node -e '
    const fs = require("fs");
    const [overlayPath, configPath, backupPath] = process.argv.slice(1);
    const overlay = JSON.parse(fs.readFileSync(overlayPath, "utf8"));
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const changed = Object.keys(overlay).filter((k) => JSON.stringify(config[k]) !== JSON.stringify(overlay[k]));
    if (changed.length) {
      fs.copyFileSync(configPath, backupPath);
      for (const k of changed) config[k] = overlay[k];
      const tmp = configPath + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", { mode: fs.statSync(configPath).mode });
      fs.renameSync(tmp, configPath);
    }
    process.stdout.write(changed.join(","));
  ' "$OVERLAY" "$CONFIG" "$CONFIG.before-$(date -u +%Y%m%dT%H%M%SZ)-${SHA:0:12}")"
  if [ -n "$CHANGED" ]; then
    CONFIG_BACKUP="$(ls -1t "$CONFIG".before-* | head -1)"
    say "config: applied $CHANGED from deploy/ainize-ai/config.overlay.json (previous kept as ${CONFIG_BACKUP##*/})"
  else
    say "config: overlay already applied"
  fi
fi

# Waiting for a node to come up is not an error — it is what starting looks like. Poll quietly and say the
# outcome once; a `curl -S` here printed "Connection refused" on every healthy deploy, and that line is
# indistinguishable from the deploy that really failed.
wait_ready() {
  local waited=0
  for _ in $(seq 1 60); do
    if curl -fs --max-time 2 "http://127.0.0.1:$PORT/api/info" >/dev/null 2>&1; then
      say "answering on :$PORT (${waited}s)"
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
  say "no answer on :$PORT after ${waited}s"
  systemctl --user status "$UNIT" --no-pager --lines 15 >&2 || true
  return 1
}

rollback() {
  trap - ERR
  echo "Deployment failed; restoring $PREVIOUS" >&2
  if [ -n "$CONFIG_BACKUP" ] && [ -f "$CONFIG_BACKUP" ]; then
    cp -p "$CONFIG_BACKUP" "$CONFIG" && echo "restored $CONFIG from before this deploy" >&2
  fi
  if [ -n "$PREVIOUS" ] && [ -d "$PREVIOUS" ]; then
    ln -sfn "$PREVIOUS" "$SERVE.new"
    mv -Tf "$SERVE.new" "$SERVE"
    systemctl --user restart "$UNIT" && wait_ready || echo 'Rollback needs attention; check the unit.' >&2
  fi
  exit 1
}
trap rollback ERR

ln -sfn "$DEST" "$SERVE.new"
mv -Tf "$SERVE.new" "$SERVE"
systemctl --user restart "$UNIT"
wait_ready

# The agents are the reason this node is public. A release that comes up without them is running, and useless
# — and it has happened: a restart left `agents: null` in the home and every public card answered 404 while
# the node itself looked healthy. Say the count; zero is worth seeing.
AGENTS="$(curl -fs --max-time 5 "http://127.0.0.1:$PORT/api/agents" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String((JSON.parse(s).agents||[]).length))}catch{process.stdout.write("?")}})' || echo '?')"
say "agents served: $AGENTS"
trap - ERR

# Keep the last five releases plus whatever is serving and whatever it replaced.
mapfile -t OLD_RELEASES < <(ls -1dt "$RELEASES"/*/ 2>/dev/null | tail -n +6)
for old in "${OLD_RELEASES[@]}"; do
  [ "${old%/}" = "$DEST" ] || [ "${old%/}" = "$PREVIOUS" ] || rm -rf -- "$old"
done

printf 'Deployed %s\n  ref        %s\n  commit     %s\n  release    %s\n  home       %s (untouched)\n  previous   %s\n' \
  "${SHA:0:12}" "$REF" "$SHA" "$DEST" "$NODE_HOME" "${PREVIOUS:-none}"
printf '\nrollback: ln -sfn <older release under %s> "%s" && systemctl --user restart %s\nlogs:     journalctl --user -u %s -f\n' \
  "$RELEASES" "$SERVE" "$UNIT" "$UNIT"
