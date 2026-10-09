#!/usr/bin/env bash
# Build the ioq3 (urt branch) WASM client in Docker. Output: src/ioq3/build-web/Release
set -euo pipefail
cd "$(dirname "$0")/../src/ioq3"
BUILD_TYPE=${BUILD_TYPE:-Release}
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/src" -w /src emscripten/emsdk:4.0.1 bash -c "
  pip install --user -q 'cmake>=3.31' ninja >/dev/null 2>&1; export PATH=/tmp/.local/bin:\$PATH
  [ -f build-web/build.ninja ] || emcmake cmake -S . -B build-web -G Ninja -DCMAKE_BUILD_TYPE=$BUILD_TYPE
  cmake --build build-web"
echo "built $(git rev-parse --short HEAD) ($(git status --porcelain | wc -l) dirty files)"
