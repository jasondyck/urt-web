#!/usr/bin/env bash
# Assemble the website the gateway serves: lobby page, engine, and the packs in a repack manifest.
# usage: tools/dist.sh PACKED_DIR [OUT_DIR]
set -euo pipefail
cd "$(dirname "$0")/.."
PACKED=${1:?usage: tools/dist.sh PACKED_DIR [OUT_DIR]}
OUT=${2:-dist}
ENGINE=src/ioq3/build-web/Release

rm -rf "$OUT.tmp" && mkdir -p "$OUT.tmp/engine" "$OUT.tmp/q3ut4"
cp client/index.html client/p2p.js client/xr.js "$OUT.tmp/"
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
for f in "$OUT.tmp/index.html" "$OUT.tmp/p2p.js" "$OUT.tmp/xr.js" "$OUT.tmp/manifest.json" "$OUT.tmp/engine/ioquake3.js" "$OUT.tmp/engine/ioquake3.wasm"; do
  gzip -9 -k -n "$f"
done
# swap contents in place: a running container's bind mount keeps pointing at
# the original directory, so replacing the directory itself would orphan it
mkdir -p "$OUT"
find "$OUT" -mindepth 1 -delete
mv "$OUT.tmp"/* "$OUT"/ && rmdir "$OUT.tmp"
du -sh "$OUT" | cut -f1 | xargs echo "dist ready in $OUT:"
