#!/usr/bin/env bash
# Assemble the static site for GitHub Pages (or any static host): lobby page and
# engine only. Players host games in their browsers via the signalling Worker
# (signal/); the packs are too big for Pages and live at ASSET_BASE, which must
# serve manifest.json + q3ut4/*.pk3 with CORS (Access-Control-Allow-Origin).
# usage: tools/pages.sh OUT_DIR SIGNAL_URL ASSET_BASE
#   e.g. tools/pages.sh site https://urt-signal.example.workers.dev https://packs.example.com/urt/
# Upload the packs with: tools/dist.sh data/packed <dir>, then copy <dir>/manifest.json and <dir>/q3ut4/.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=${1:?usage: tools/pages.sh OUT_DIR SIGNAL_URL ASSET_BASE}
SIGNAL=${2:?signal Worker URL}
ASSETS=${3:?asset base URL}
ENGINE=src/ioq3/build-web/Release

rm -rf "$OUT" && mkdir -p "$OUT/engine"
cp client/index.html client/p2p.js "$OUT/"
cp "$ENGINE/ioquake3.js" "$ENGINE/ioquake3.wasm" "$OUT/engine/"
printf '{ "signalUrl": "%s", "assetBase": "%s" }\n' "$SIGNAL" "${ASSETS%/}/" > "$OUT/config.json"
touch "$OUT/.nojekyll"
du -sh "$OUT" | cut -f1 | xargs echo "site ready in $OUT:"
