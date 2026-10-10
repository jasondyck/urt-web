# syntax=docker/dockerfile:1
# Self-hosted browser Urban Terror in one image: the site (lobby, WASM engine,
# repacked game data), the gateway (static files, WebSocket->UDP relay,
# matchmaking for browser-hosted games) and, optionally, the stock UrT dedicated
# server, which runs off the same packs.
#
#   docker compose up -d --build      (or: docker build -t urt-web .)
#
# Maps come from server/mapcycle.txt; rebuild after changing it. The UrT 4.3.4
# release is downloaded during the build (checksum-pinned) and only the repacked
# packs end up in the image: keep the image private (FrozenSand's copyright).

# ---- engine: ioquake3 (src/ioq3, branch urt) compiled to WebAssembly ----------
FROM emscripten/emsdk:4.0.1 AS engine
RUN pip install -q --no-cache-dir 'cmake>=3.31' ninja
COPY src/ioq3 /src
RUN emcmake cmake -S /src -B /build -G Ninja -DCMAKE_BUILD_TYPE=Release >/dev/null \
 && cmake --build /build \
 && mkdir /out && cp /build/Release/ioquake3.js /build/Release/ioquake3.wasm /out/

# ---- game data: download UrT 4.3.4, repack the mapcycle's maps for the web ---
FROM python:3.13-slim AS packs
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/* \
 && pip install --no-cache-dir "pillow>=11.3"
ADD --checksum=sha256:716669cc6c525663b791852e51ff9c94d96f382be39279dab6084dddacb5a4e7 \
    https://cdn.urbanterror.info/urt/43/releases/zips/UrbanTerror434_full.zip /dl/urt.zip
RUN python3 -I - <<'EOF'
import zipfile
z = zipfile.ZipFile('/dl/urt.zip')
z.extractall('/dl', [n for n in z.namelist()
                     if n.endswith('.pk3') and '/q3ut4/' in n or n.endswith('Quake3-UrT-Ded.x86_64')])
EOF
COPY tools/repack.py /tools/repack.py
COPY server/mapcycle.txt /tools/mapcycle.txt
RUN python3 -I /tools/repack.py /dl/UrbanTerror43/q3ut4 /out $(grep -v '^\s*$' /tools/mapcycle.txt | tr -d '\r') \
 && rm -rf /dl/UrbanTerror43/q3ut4 \
 && chmod 755 /dl/UrbanTerror43/Quake3-UrT-Ded.x86_64

# ---- site: what the gateway serves ------------------------------------------
FROM python:3.13-slim AS site
COPY client/index.html client/p2p.js /web/
COPY --from=engine /out/ /web/engine/
COPY --from=packs /out/ /web/
# packs are already compressed; the page and engine shrink a lot
RUN cd /web && gzip -9 -k -n index.html p2p.js manifest.json engine/ioquake3.js engine/ioquake3.wasm

# ---- gateway ------------------------------------------------------------------
FROM golang:1.25 AS gateway
WORKDIR /src
COPY gateway/go.mod gateway/go.sum ./
RUN go mod download
COPY gateway/*.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /urt-gateway .

# ---- runtime: distroless with glibc (the UrT server binary needs it) -----------
FROM gcr.io/distroless/base-debian12:nonroot
COPY --from=gateway /urt-gateway /urt-gateway
COPY --from=packs /dl/UrbanTerror43/Quake3-UrT-Ded.x86_64 /urt/Quake3-UrT-Ded.x86_64
COPY --from=site /web /web
COPY --chown=nonroot:nonroot server/server.cfg server/mapcycle.txt /home/nonroot/q3ut4/
ENV URT_LISTEN=:8080 URT_WEB=/web URT_DEDICATED=1
EXPOSE 8080 27960/udp
ENTRYPOINT ["/urt-gateway"]
