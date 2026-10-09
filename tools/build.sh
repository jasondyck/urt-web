#!/usr/bin/env bash
# Build the ioq3 (urt branch) WASM client in Docker. Output: src/ioq3/$BUILD_DIR/Release
#   BUILD_DIR=build-prof EXTRA_CMAKE="-DCMAKE_EXE_LINKER_FLAGS=--profiling-funcs" tools/build.sh
set -euo pipefail
cd "$(dirname "$0")/../src/ioq3"
BUILD_TYPE=${BUILD_TYPE:-Release}
BUILD_DIR=${BUILD_DIR:-build-web}
EXTRA_CMAKE=${EXTRA_CMAKE:-}
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/src" -w /src emscripten/emsdk:4.0.1 bash -c "
  pip install --user -q 'cmake>=3.31' ninja >/dev/null 2>&1; export PATH=/tmp/.local/bin:\$PATH
  [ -f $BUILD_DIR/build.ninja ] || emcmake cmake -S . -B $BUILD_DIR -G Ninja -DCMAKE_BUILD_TYPE=$BUILD_TYPE $EXTRA_CMAKE
  cmake --build $BUILD_DIR"
echo "built $(git rev-parse --short HEAD) ($(git status --porcelain | wc -l) dirty files) in $BUILD_DIR"
