#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
target="$HOME/.pi/agent/npm/node_modules/pi-mcp-adapter"
version=$(node -p "require(process.argv[1]).version" "$target/package.json")
[ "$version" = '2.27.0' ] || { echo 'Refusing to patch a different adapter version' >&2; exit 1; }
cd "$target"
if git apply --reverse --check "$root/patches/pi-mcp-adapter-2.27.0.patch" 2>/dev/null; then
  echo 'MCP permission patch already applied'
else
  git apply --check "$root/patches/pi-mcp-adapter-2.27.0.patch"
  git apply "$root/patches/pi-mcp-adapter-2.27.0.patch"
  echo 'MCP permission patch applied'
fi
