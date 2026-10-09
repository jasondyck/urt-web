#!/usr/bin/env bash
# Run tools/pw/<script> in the Playwright container on the host network.
set -euo pipefail
D="$(cd "$(dirname "$0")/.." && pwd)"
S=$1; shift
docker run --rm --network host --ipc host -e GPU=${GPU:-0} -e NOALPHA=${NOALPHA:-0} -e CMDS="${CMDS:-}" -e SKYTRACE=${SKYTRACE:-0} -e DBG="${DBG:-}" -e CMDS_AT=${CMDS_AT:-30} --device /dev/dri --group-add $(getent group render | cut -d: -f3) --group-add $(getent group video | cut -d: -f3) -v "$D/tools/pw:/pw" -v "$D/runs:/runs" -w /pw \
  $([ "${GPU:-0}" = 1 ] && echo urt-pw-gpu || echo mcr.microsoft.com/playwright:v1.55.0-noble) bash -c "[ -d node_modules/playwright ] || npm i -s playwright@1.55.0 >/dev/null 2>&1; node $S $*"
