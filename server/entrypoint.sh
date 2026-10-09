#!/bin/sh
# Start the stock UrT dedicated server on the first map of the rotation.
set -e
first_map=$(grep -v '^\s*$' /home/urt/q3ut4/mapcycle.txt | head -n 1 | tr -d '\r')
exec /urt/Quake3-UrT-Ded.x86_64 \
  +set fs_basepath /urt +set fs_homepath /home/urt +set fs_game q3ut4 \
  +set dedicated 1 +set net_port 27960 +set com_hunkmegs 256 \
  +exec server.cfg +map "$first_map"
