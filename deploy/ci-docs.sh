#!/usr/bin/env bash
# Check the shared reference against isolated, identified source checkouts.
set -euo pipefail
SOURCE=${1:?node source required}
WORKSPACE=$(mktemp -d)
trap 'rm -rf "$WORKSPACE"' EXIT
NODE="$WORKSPACE/ainize-node"
mkdir "$NODE"
cp -R "$SOURCE/scripts" "$SOURCE/src" "$SOURCE/package.json" "$NODE/"
ln -s "$SOURCE/node_modules" "$NODE/node_modules"
for name in core cli web; do
  git clone --quiet --depth 1 --branch main "https://github.com/ainblockchain/ainize-$name.git" "$WORKSPACE/ainize-$name"
  printf 'Documentation input ainize-%s: %s\n' "$name" "$(git -C "$WORKSPACE/ainize-$name" rev-parse HEAD)"
done
# The generator imports Core's TypeScript source and its runtime dependencies.
(cd "$WORKSPACE/ainize-core" && npm ci --include=dev --ignore-scripts --no-audit --no-fund)
(cd "$NODE" && npm run docs:check)
