# urt-web

Urban Terror 4.3 in the browser, so people can play together without installing anything.
Self-hosted: one Docker image serves the site and runs the games.

```
browser: ioq3 engine (WASM/WebGL2)  --ws-->  gateway (Go)  --udp-->  stock Quake3-UrT-Ded (same container)
         + repacked UrT assets               serves the site
```

Players can also host games themselves: the host's browser runs the game server and the others connect
to it directly; the gateway only introduces them.

```
host browser: ioq3 (client + server)  <--WebRTC data channels-->  player browsers
                      \--- gateway /signal/: room codes, game browser, WebRTC handshake ---/
```

## Running it

Needs Docker with compose and ~6 GB free for the first build.

```
git clone --recurse-submodules https://github.com/jasondyck/urt-web && cd urt-web
docker compose up -d --build   # then open http://<host>:8080
```

The build downloads Urban Terror 4.3.4 (1.4 GB, checksum-pinned), compiles the engine to WebAssembly,
repacks the maps in `server/mapcycle.txt` for the web (WebP textures, Ogg sounds: 5 maps ≈ 180 MB, all 35
≈ 610 MB), and produces one ~200 MB image (distroless). The image contains FrozenSand's game files, so
**keep it private**: don't push it to a public registry.

- **Maps**: `server/mapcycle.txt`, then `docker compose up -d --build`.
- **Dedicated server settings**: `server/server.cfg` (mounted), then `docker compose restart`.
- **Ports**: `URT_HTTP_PORT` (8080) for browsers; `URT_UDP_PORT` (27960) only if installed UrT clients
  should join the dedicated server too. Set them in `.env`.
- **Environment** (in `docker-compose.yml`):
  - `URT_DEDICATED=1` runs the always-on server; `0` leaves only browser-hosted games.
  - `URT_P2P=1` lets players host games in their browser; `0` turns it off.
  - `URT_ICE_SERVERS` (JSON) for browser-hosted games: a public STUN server by default; `[]` keeps it
    all on the LAN/VPN; add a TURN server if some players can't connect to each other.
- First visit downloads the packs into the browser (IndexedDB, works on plain http); later visits start
  from cache.

## Browser-hosted games

The lobby has **Join a game** (a game browser: mode filter, hide full, live map and player counts,
🔒 for passwords, invite codes) and **Host a game** (name, password, mode, max players, game length,
the mode's frag/capture limit or round length, friendly fire, map rotation; remembered between visits).
Invite links are `http://<host>:8080/#ROOMCODE`.

How it works: the host's browser runs the UrT server (`+exec host.cfg +map …`); players connect over
WebRTC data channels (unordered, no retransmits, so UDP-like). The engine sees ordinary IPv4 packets: the
host is `198.18.0.1`, players get `198.19.x.y` (non-LAN addresses, so rate limits apply). A wrong
password or full game sends the player back to the lobby with the reason.

Caveats: the game lives in the host's tab (a worker timer keeps it running when the tab is hidden) and
ends when the host leaves; WebRTC shows players each other's IP addresses unless traffic goes via TURN.

## Layout

| Path | What |
|---|---|
| `src/ioq3` | submodule: ioquake3 fork, branch `urt` (UrT UI syscalls, pluggable network transport, WebP textures, WebGL fixes, QVM→wasm compiler, load/memory optimizations) |
| `client/` | lobby page (`index.html`) and the WebRTC transport for browser-hosted games (`p2p.js`) |
| `gateway/` | Go: serves the site, relays WebSocket frames `[ipv4][port][payload]` to allowed UDP servers, matchmaking (`signal.go`), runs the dedicated server (`dedicated.go`) |
| `server/` | dedicated server config (`sv_pure 0`, high `sv_clientsPerIp` since everyone arrives via the gateway) and map rotation |
| `Dockerfile` | engine build, data download + repack, site assembly, distroless runtime |
| `shell/` | development HTML page for the client |
| `tools/build.sh` | builds the WASM client in the `emscripten/emsdk:4.0.1` container |
| `tools/repack.py` | turns the UrT 4.3 pk3s into a core pack + one pack per map (WebP textures, Ogg sounds) |
| `tools/dist.sh` | assembles a site directory from a repack (dev) |
| `tools/pw*`, `tools/native-ref` | headless Chromium (real GPU) tests, profiling and native-client reference harness |

## Dev loop

```
git submodule update --init
tools/build.sh                                         # -> src/ioq3/build-web/Release/ioquake3.{js,wasm}
python3 -I tools/repack.py <UrbanTerror43/q3ut4> data/packed ut4_turnpike ut4_abbey …
tools/dist.sh data/packed runs/site
(cd gateway && go build) && URT_WEB=runs/site gateway/urt-gateway   # add URT_SERVERS=… for a dedicated server
```

Tests (`GPU=1` uses the real GPU): `tools/pw.sh p2p.mjs http://127.0.0.1:8080/` (Alice hosts, Bob joins by
invite link; `HIDE=1` hides the host tab), `tools/pw.sh p2p-settings.mjs …` (host settings, game browser,
wrong/right password), `tools/pw.sh lobbyshot.mjs …` (lobby screenshots, optional join).

The client needs `+set fs_homepath . +set com_hunkmegs 768 +set net_enabled 1` and `com_basegame=q3ut4`.
