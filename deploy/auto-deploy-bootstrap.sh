#!/usr/bin/env bash
# Bring the deploy tooling up to date, then run it. This is what the systemd unit calls.
#
# WHY IT IS NOT A CLONE ANY MORE. The unit used to `git clone --depth 1` this repository every two minutes, only to
# read two refs with it. Measured: 3.5 MB transferred and a 16 MB checkout per run, 720 runs a day — roughly 2.5 GB
# of anonymous git traffic to ask a question whose answer is 40 bytes. That is the shape GitHub's abuse detection
# exists to catch, and being throttled would silently stop deploys.
#
# A checkout kept on disk and fetched instead costs nothing when nothing changed: the fetch is one ref
# advertisement, measured at 0.7 s and effectively no transfer. And it keeps the property the clone was there for
# — the tool that deploys comes from `main`, not from somebody's working copy, which is the bug that made a deploy
# die with `No such file or directory` when the local checkout was behind.
#
# SELF-UPDATING. The copy of this script that runs is the previous one; it updates the checkout and then execs
# whatever `auto-deploy.sh` main now holds. A change to THIS file therefore takes effect on the following run.
set -uo pipefail

REPO_URL="${AINIZE_TOOL_REPO_URL:-git@github.com:ainblockchain/ainize-node.git}"
CHECKOUT="${AINIZE_TOOL_CHECKOUT:-/mnt/newdata/ainize-autodeploy/ainize-node}"
export PATH="${NODE_BIN:-$HOME/.local/node/bin}:$PATH"

log() { printf '%s %s\n' "$(date -Is)" "$*"; }

# shellcheck source=deploy/backoff.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/backoff.sh"

# Backing off applies to fetching the TOOL. The deploys have their own, per repository, in auto-deploy.sh.
if state="$(backoff_active tool)"; then
  set -- $state
  log "tool: $1 failure(s) so far, waiting $(backoff_mins "$2") more min before touching GitHub"
  exit 0
fi

if [ -d "$CHECKOUT/.git" ]; then
  if ! git -C "$CHECKOUT" fetch -q --depth 1 origin main 2>/dev/null; then
    set -- $(backoff_bump tool)
    log "tool: fetch failed ($1 in a row) — next attempt in $(backoff_mins "$2") min"
    exit 0
  fi
  # Detached on purpose: this checkout is never edited, and a detached HEAD cannot refuse a fetch because somebody
  # left it dirty or on another branch.
  git -C "$CHECKOUT" checkout -q --detach FETCH_HEAD || { log 'tool: checkout failed'; backoff_bump tool >/dev/null; exit 0; }
else
  mkdir -p "$(dirname "$CHECKOUT")"
  if ! git clone -q --depth 1 -b main "$REPO_URL" "$CHECKOUT" 2>/dev/null; then
    set -- $(backoff_bump tool)
    log "tool: first clone failed ($1 in a row) — next attempt in $(backoff_mins "$2") min"
    exit 0
  fi
  log "tool: checkout created at $CHECKOUT"
fi
backoff_clear tool

exec bash "$CHECKOUT/deploy/auto-deploy.sh" "$@"
