#!/usr/bin/env bash
# One-time (and after changing server/mapcycle.txt) setup for a host running the game.
# Needs: docker (with compose), git, python3, ~6 GB free during setup.
#   1. downloads Urban Terror 4.3.4 into data/ (the server uses the original files)
#   2. repacks the maps in server/mapcycle.txt for the browser into data/packed
#   3. builds the WASM engine (src/ioq3 submodule) in the emscripten container
#   4. assembles the website into dist/
#   5. makes a self-signed certificate for https (data/tls), unless one exists
# Then: docker compose up -d --build   and open http://<host>:8080 or https://<host>:8443
set -euo pipefail
cd "$(dirname "$0")"

URT_URL=https://cdn.urbanterror.info/urt/43/releases/zips/UrbanTerror434_full.zip
URT_SHA256=716669cc6c525663b791852e51ff9c94d96f382be39279dab6084dddacb5a4e7

mkdir -p data
if [ ! -d data/UrbanTerror43/q3ut4 ]; then
  if [ ! -f data/UrbanTerror434_full.zip ]; then
    echo "== downloading Urban Terror 4.3.4 (1.4 GB)"
    curl -fL --retry 3 -o data/UrbanTerror434_full.zip.part "$URT_URL"
    mv data/UrbanTerror434_full.zip.part data/UrbanTerror434_full.zip
  fi
  echo "$URT_SHA256  data/UrbanTerror434_full.zip" | sha256sum -c -
  echo "== unpacking"
  python3 -c "import zipfile; zipfile.ZipFile('data/UrbanTerror434_full.zip').extractall('data')"
  chmod +x data/UrbanTerror43/Quake3-UrT-Ded.x86_64
fi

echo "== repacking maps for the browser: $(tr '\n' ' ' < server/mapcycle.txt)"
docker build -q -t urt-web-repack -f tools/repack.Dockerfile tools >/dev/null
rm -rf data/packed
docker run --rm -u "$(id -u):$(id -g)" -v "$PWD:/w" -w /w urt-web-repack \
  python3 -I tools/repack.py data/UrbanTerror43/q3ut4 data/packed $(grep -v '^\s*$' server/mapcycle.txt | tr -d '\r')

echo "== building the engine"
git submodule update --init
tools/build.sh

echo "== assembling the site"
tools/dist.sh data/packed dist

[ -f data/tls/cert.pem ] || tools/cert.sh

echo
echo "Done. Start it with:  docker compose up -d --build"
echo "Then open http://$(hostname -f 2>/dev/null || hostname):8080 (or https on :8443, after accepting the certificate warning)"
