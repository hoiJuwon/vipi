#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
patch="$root/patches/pi-codex-image-gen-0.1.12.patch"
installed="$HOME/.pi/agent/npm/node_modules/pi-codex-image-gen"
[ -d "$installed" ] || { echo 'Install pi-codex-image-gen@0.1.12 first' >&2; exit 1; }
# Restored Pi processes may resolve -e npm:... through a separate temporary install.
for target in "$installed" "$HOME"/.pi/agent/tmp/extensions/npm/*/node_modules/pi-codex-image-gen; do
  [ -d "$target" ] || continue
  version=$(node -p 'require(process.argv[1]).version' "$target/package.json")
  [ "$version" = '0.1.12' ] || { echo "Refusing to patch $target ($version)" >&2; exit 1; }
  if (cd "$target" && git apply --reverse --check "$patch" 2>/dev/null); then
    echo "Image account patch already applied: $target"
  else
    (cd "$target" && git apply --check "$patch" && git apply "$patch")
    echo "Image account patch applied: $target"
  fi
done
