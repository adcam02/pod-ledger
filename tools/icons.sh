#!/bin/sh
# Rebuild the PNG app icons in src/site/ from the SVGs (macOS only: uses qlmanage and sips).
#   sh tools/icons.sh
set -e
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
qlmanage -t -s 512 -o "$tmp" src/site/icon.svg src/icons/icon-full.svg src/icons/icon-maskable.svg >/dev/null 2>&1
sips -z 512 512 "$tmp/icon.svg.png" --out src/site/icon-512.png >/dev/null
sips -z 192 192 "$tmp/icon.svg.png" --out src/site/icon-192.png >/dev/null
sips -z 180 180 "$tmp/icon-full.svg.png" --out src/site/apple-touch-icon.png >/dev/null
sips -z 512 512 "$tmp/icon-maskable.svg.png" --out src/site/icon-maskable-512.png >/dev/null
rm -rf "$tmp"
echo "icons written to src/site/"
