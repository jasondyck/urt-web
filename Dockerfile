# syntax=docker/dockerfile:1
# Self-hosted browser Urban Terror. Neither image contains game files:
#
#   urt-web        (default target) the gateway (site, WebSocket->UDP relay,
#                  matchmaking for browser-hosted games, optional dedicated
#                  server), the WASM engine and the lobby page.
#   urt-web-setup  (--target setup) one-off: downloads Urban Terror 4.3.4 from
#                  urbanterror.info, verifies it, and repacks the maps in
#                  server/mapcycle.txt into the game-data volume.
#
#   docker compose up -d --build      runs setup, then the gateway

# ---- engine: ioquake3 (src/ioq3, branch urt) compiled to WebAssembly ----------
FROM emscripten/emsdk:4.0.1 AS engine
RUN pip install -q --no-cache-dir 'cmake>=3.31' ninja
COPY src/ioq3 /src
RUN emcmake cmake -S /src -B /build -G Ninja -DCMAKE_BUILD_TYPE=Release >/dev/null \
 && cmake --build /build \
 && mkdir /out && cp /build/Release/ioquake3.js /build/Release/ioquake3.wasm /out/

# ---- site: lobby page + engine (the game data is served from the volume) -----
FROM debian:12-slim AS site
COPY client/index.html client/p2p.js client/xr.js /web/
COPY --from=engine /out/ /web/engine/
RUN cd /web && gzip -9 -k -n index.html p2p.js xr.js engine/ioquake3.js engine/ioquake3.wasm

# ---- gateway ------------------------------------------------------------------
FROM golang:1.25 AS gateway
WORKDIR /src
COPY gateway/go.mod gateway/go.sum ./
RUN go mod download
COPY gateway/*.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /urt-gateway .

# ---- setup: fills the game-data volume ---------------------------------------
FROM python:3.13-slim AS setup
RUN apt-get update && apt-get install -y --no-install-recommends vorbis-tools && rm -rf /var/lib/apt/lists/* \
 && pip install --no-cache-dir "pillow>=11.3" \
 && mkdir /data && chown 65532:65532 /data
COPY tools/repack.py tools/setup-data.py /tools/
COPY server/mapcycle.txt /config/mapcycle.txt
USER 65532:65532
ENTRYPOINT ["python3", "-I", "/tools/setup-data.py", "/data", "/config/mapcycle.txt"]

# ---- runtime: distroless with glibc (the UrT server binary needs it) -----------
FROM gcr.io/distroless/base-debian12:nonroot
COPY --from=gateway /urt-gateway /urt-gateway
COPY --from=site /web /web
COPY --chown=nonroot:nonroot server/server.cfg server/mapcycle.txt /home/nonroot/q3ut4/
ENV URT_LISTEN=:8080 URT_WEB=/web URT_DATA=/data URT_DEDICATED=1
VOLUME /data
EXPOSE 8080 8443 27960/udp
ENTRYPOINT ["/urt-gateway"]
