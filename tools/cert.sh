#!/usr/bin/env bash
# Make a self-signed certificate so the gateway can also serve https.
# usage: tools/cert.sh [extra-name-or-ip ...]
# Covers localhost, this host's name and every IPv4 address it has, plus any extras.
# Browsers warn once per device; accept it and the site and its WebSocket work.
# Valid 397 days: Apple platforms reject server certificates valid for longer.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=data/tls
mkdir -p "$OUT"

san="DNS:localhost,IP:127.0.0.1"
for n in "$(hostname)" "$(hostname -f 2>/dev/null || true)"; do
  [ -n "$n" ] && [[ $san != *"DNS:$n,"* && $san != *"DNS:$n" ]] && san+=",DNS:$n"
done
for ip in $(hostname -I 2>/dev/null) "$@"; do
  if [[ $ip =~ ^[0-9.]+$ ]]; then san+=",IP:$ip"; elif [[ $ip != *:* ]]; then san+=",DNS:$ip"; fi
done

openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 397 \
  -keyout "$OUT/key.pem" -out "$OUT/cert.pem" -subj "/CN=urt-web" \
  -addext "subjectAltName=$san" -addext "extendedKeyUsage=serverAuth" 2>/dev/null
chmod 644 "$OUT/key.pem"   # the gateway runs as a different user in its container
echo "wrote $OUT/cert.pem for $san"
