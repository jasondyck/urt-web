# urt-web

Urban Terror 4.3 in the browser, so people can play together without installing anything.

```
browser: ioq3 engine (WASM/WebGL2)  --wss-->  gateway (Go)  --udp-->  stock Quake3-UrT-Ded
         + repacked UrT assets                serves the web client     sv_pure 0
```

## Layout

| Path | What |
|---|---|
| `src/ioq3` | submodule: ioquake3 fork, branch `urt` (UrT UI syscalls, WebSocket networking, WebP textures, WebGL fixes, load/memory optimizations) |
| `gateway/` | serves the client, relays WebSocket frames `[ipv4][port][payload]` to allowed UDP servers (`URT_SERVERS`) |
| `server/` | dedicated server config (`sv_pure 0`, high `sv_clientsPerIp` since everyone arrives via the gateway) |
| `shell/` | development HTML page for the client |
| `tools/build.sh` | builds the WASM client in the `emscripten/emsdk:4.0.1` container |
| `tools/repack.py` | turns the UrT 4.3 pk3s into a core pack + one pack per map (WebP textures, Ogg sounds) |
| `tools/pw*`, `tools/native-ref` | headless Chromium (real GPU) test, profiling and native-client reference harness |

## Running it (e.g. on a work server)

Needs Docker with compose, git, python3 and ~6 GB free during setup.

```
git clone --recurse-submodules https://github.com/jasondyck/urt-web && cd urt-web
./setup.sh                     # downloads UrT 4.3.4, repacks the maps in server/mapcycle.txt, builds, assembles dist/
docker compose up -d --build   # http://<host>:8080
```

- Pick maps in `server/mapcycle.txt` (re-run `./setup.sh` after changing it), game settings in `server/server.cfg`.
- Ports: `URT_HTTP_PORT` (default 8080) for browsers, `URT_UDP_PORT` (default 27960) so installed UrT clients can join the same server. Put them in `.env` to change.
- First visit downloads ~170 MB for 5 maps into the browser (IndexedDB, works on plain http); later visits start from cache.

## Game data

Not included (FrozenSand's copyright). Download `UrbanTerror434_full.zip` from urbanterror.info, unzip into
`assets/dl/`, then:

```
python3 -I tools/repack.py assets/dl/UrbanTerror43/q3ut4 assets/packed-webp ut4_turnpike ut4_abbey ...
```

## Dev loop

```
git submodule update --init
tools/build.sh                                    # -> src/ioq3/build-web/Release/ioquake3.{js,wasm}
URT_SERVERS=127.0.0.1:27961 URT_WEB=web gateway/urt-gateway
```

The client needs `+set fs_homepath . +set com_hunkmegs 768 +set net_enabled 1` and `com_basegame=q3ut4`.
