#!/usr/bin/env bash
# Assemble the website the gateway serves: lobby page, engine, and the packs in a repack manifest.
# usage: tools/dist.sh PACKED_DIR [OUT_DIR]
set -euo pipefail
cd "$(dirname "$0")/.."
PACKED=${1:?usage: tools/dist.sh PACKED_DIR [OUT_DIR]}
OUT=${2:-dist}
ENGINE=src/ioq3/build-web/Release

rm -rf "$OUT.tmp" && mkdir -p "$OUT.tmp/engine" "$OUT.tmp/q3ut4"
cp client/index.html "$OUT.tmp/"
cp "$ENGINE/ioquake3.js" "$ENGINE/ioquake3.wasm" "$OUT.tmp/engine/"
cp "$PACKED/manifest.json" "$OUT.tmp/"
python3 - "$PACKED" "$OUT.tmp" <<'PY'
import json, os, shutil, sys
packed, out = sys.argv[1:]
for p in json.load(open(os.path.join(packed, "manifest.json")))["packs"]:
    src, dst = os.path.join(packed, p["file"]), os.path.join(out, p["file"])
    try:
        os.link(src, dst)
    except OSError:
        shutil.copy2(src, dst)
PY
# packs are already compressed; the page and engine shrink a lot
for f in "$OUT.tmp/index.html" "$OUT.tmp/manifest.json" "$OUT.tmp/engine/ioquake3.js" "$OUT.tmp/engine/ioquake3.wasm"; do
  gzip -9 -k -n "$f"
done
rm -rf "$OUT" && mv "$OUT.tmp" "$OUT"
du -sh "$OUT" | cut -f1 | xargs echo "dist ready in $OUT:"
