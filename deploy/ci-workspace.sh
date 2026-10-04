#!/usr/bin/env bash
# Run source-dependent checks against isolated, identified checkouts.
set -euo pipefail
SOURCE=${1:?node source required}
CHECK=${2:?check required}
case "$CHECK" in test|docs:check) ;; *) exit 2 ;; esac
WORKSPACE=$(mktemp -d)
trap 'rm -rf "$WORKSPACE"' EXIT
NODE="$WORKSPACE/ainize-node"
mkdir "$NODE"
tar -C "$SOURCE" --exclude=.git --exclude=node_modules --exclude=dist -cf - . | tar -C "$NODE" -xf -
ln -s "$SOURCE/node_modules" "$NODE/node_modules"
for name in core cli web; do
  git clone --quiet --depth 1 --branch main "https://github.com/ainblockchain/ainize-$name.git" "$WORKSPACE/ainize-$name"
  printf 'CI workspace input ainize-%s: %s\n' "$name" "$(git -C "$WORKSPACE/ainize-$name" rev-parse HEAD)"
done
# The generator imports Core's TypeScript source and its runtime dependencies.
(cd "$WORKSPACE/ainize-core" && npm ci --include=dev --ignore-scripts --no-audit --no-fund)
(cd "$NODE" && npm run "$CHECK")
