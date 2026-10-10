# urt-web

Urban Terror 4.3 in the browser, so people can play together without installing anything.

```
browser: ioq3 engine (WASM/WebGL2)  --wss-->  gateway (Go)  --udp-->  stock Quake3-UrT-Ded
         + repacked UrT assets                serves the web client     sv_pure 0
```

Or, with no servers at all: one player hosts from the lobby and their browser runs the game server.

```
host browser: ioq3 (client + server)  <--WebRTC data channels-->  player browsers
                      \--- signal/ (Cloudflare Worker): room codes, public list, WebRTC handshake ---/
```

## Layout

| Path | What |
|---|---|
| `src/ioq3` | submodule: ioquake3 fork, branch `urt` (UrT UI syscalls, WebSocket networking, WebP textures, WebGL fixes, load/memory optimizations) |
| `gateway/` | serves the client, relays WebSocket frames `[ipv4][port][payload]` to allowed UDP servers (`URT_SERVERS`) |
| `client/` | lobby page (`index.html`) and the WebRTC transport for browser-hosted games (`p2p.js`) |
| `signal/` | Cloudflare Worker + Durable Objects: matchmaking for browser-hosted games (no game traffic) |
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

## Browser-hosted games (GitHub Pages)

The lobby gets **Host a game** / **Join a game** tabs when it finds a `config.json` with a `signalUrl`.
A host's browser runs the UrT server (`+map`, settings in a generated `host.cfg`); players connect to it
over WebRTC data channels (unordered, no retransmits, so UDP-like). The engine sees ordinary IPv4 packets:
the host is `198.18.0.1`, players get `198.19.x.y` (non-LAN addresses, so rate limits apply).
Invite links are `<site>#ROOMCODE`; public games show up in everyone's lobby.

1. Signalling Worker: `cd signal && npx wrangler deploy`. Set `ALLOWED_ORIGINS` in `wrangler.toml` to the
   site's origin. Optional TURN for players behind strict NATs: `wrangler secret put TURN_KEY_ID` and
   `TURN_KEY_API_TOKEN` (Cloudflare Realtime TURN); without it only STUN is used.
2. Packs: `tools/dist.sh data/packed <dir>`, upload `<dir>/manifest.json` and `<dir>/q3ut4/` to a host that
   sends `Access-Control-Allow-Origin` (Pages can't take them: 100 MB file and ~1 GB site limits).
3. Site: `tools/pages.sh site <worker-url> <pack-base-url>` and publish `site/` (3 MB) to Pages.

Caveats: the game lives in the host's tab (a worker timer keeps it running when the tab is hidden) and
ends when the host leaves; WebRTC shows players each other's IP addresses unless traffic goes via TURN.

Local test: `docker run … node:24-bookworm npx wrangler@4 dev` in `signal/`, `URT_SIGNAL_URL=http://localhost:8787 tools/dist.sh data/packed runs/p2p-site`,
serve it, then `GPU=1 tools/pw.sh p2p.mjs http://127.0.0.1:<port>/` (Alice hosts, Bob joins by invite link; `HIDE=1` hides the host tab).

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
