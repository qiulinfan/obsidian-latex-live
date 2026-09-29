#!/bin/sh
# Symlink this checkout into one or more vaults' plugin directories for development.
set -eu
if [ "$#" -lt 1 ]; then
  echo "usage: $0 /absolute/path/to/vault [more vaults...]" >&2
  exit 1
fi
repo=$(cd "$(dirname "$0")/.." && pwd)
for vault in "$@"; do
  plugdir="$vault/.obsidian/plugins"
  mkdir -p "$plugdir"
  target="$plugdir/latex-live"
  if [ -e "$target" ] && [ ! -L "$target" ]; then
    echo "refusing to replace non-symlink $target" >&2
    exit 1
  fi
  ln -sfn "$repo" "$target"
  echo "linked $target -> $repo"
done
echo "Enable 'LaTeX Live' in each vault's community plugin settings, then reload Obsidian."
