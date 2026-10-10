// urt-gateway serves the web client, relays its packets to Urban Terror servers,
// and runs matchmaking for games hosted in players' browsers (signal.go).
//
// Browsers can't send UDP, so the client opens a WebSocket to /ws and sends binary
// frames of [4-byte IPv4][2-byte port, big endian][payload]. Each WebSocket gets its
// own UDP socket, so the game server sees every browser as a separate ordinary
// player. Only servers listed in URT_SERVERS can be reached; with none, the site
// offers browser-hosted games only.
package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"os"
	"os/signal"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/coder/websocket"
)

const (
	headerLen  = 6
	maxPayload = 16384 // MAX_MSGLEN in ioq3
	idleTime   = 2 * time.Minute
)

var (
	allowed  = map[netip.AddrPort]bool{}
	servers  = []string{} // as advertised to the client
	maxConns = int64(64)
	conns    atomic.Int64
)

func main() {
	listen := flag.String("listen", envOr("URT_LISTEN", ":8080"), "HTTP listen address")
	webDir := flag.String("web", envOr("URT_WEB", "./web"), "directory with the web client")
	dataDir := flag.String("data", os.Getenv("URT_DATA"), "directory with game data (manifest.json, q3ut4/*.pk3, the dedicated server binary) if not inside -web")
	serverList := flag.String("servers", os.Getenv("URT_SERVERS"), "comma-separated host:port of allowed game servers; the first is the default")
	p2p := flag.Bool("p2p", envOr("URT_P2P", "1") != "0", "offer browser-hosted games (matchmaking under /signal/)")
	dedicated := flag.Bool("dedicated", envOr("URT_DEDICATED", "0") == "1", "also run the UrT dedicated server (see -dedicated-bin)")
	dedBin := flag.String("dedicated-bin", os.Getenv("URT_DEDICATED_BIN"), "UrT dedicated server binary (default: Quake3-UrT-Ded.x86_64 in the game data)")
	dedHome := flag.String("dedicated-home", envOr("URT_DEDICATED_HOME", "/home/nonroot"), "writable dir with q3ut4/server.cfg and q3ut4/mapcycle.txt")
	ice := flag.String("ice", envOr("URT_ICE_SERVERS", `[{"urls":"stun:stun.cloudflare.com:3478"}]`),
		"WebRTC ICE servers (JSON) for browser-hosted games; [] for LAN-only")
	flag.Parse()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	gameDir := *webDir
	if *dataDir != "" {
		gameDir = *dataDir
	}
	if _, err := os.Stat(filepath.Join(gameDir, "manifest.json")); err != nil {
		log.Printf("warning: no game data in %s (run the setup container first): %v", gameDir, err)
	}
	if *dedicated {
		if *serverList == "" {
			*serverList = "127.0.0.1:27960"
		}
		if *dedBin == "" {
			*dedBin = filepath.Join(gameDir, "Quake3-UrT-Ded.x86_64")
		}
		go runDedicated(ctx, dedicatedConfig{bin: *dedBin, basePath: gameDir, homePath: *dedHome, port: "27960"})
	}

	for _, s := range strings.Split(*serverList, ",") {
		if s = strings.TrimSpace(s); s == "" {
			continue
		}
		ua, err := net.ResolveUDPAddr("udp4", s)
		if err != nil {
			log.Fatalf("bad server %q: %v", s, err)
		}
		ap := ua.AddrPort()
		ap = netip.AddrPortFrom(ap.Addr().Unmap(), ap.Port())
		allowed[ap] = true
		servers = append(servers, ap.String())
	}
	if len(servers) == 0 && !*p2p {
		log.Fatal("nothing to offer: no game servers (URT_SERVERS) and browser-hosted games are off (URT_P2P=0)")
	}

	mux := http.NewServeMux()
	if len(servers) > 0 {
		mux.HandleFunc("/ws", handleWS)
		mux.HandleFunc("/status.json", handleStatus)
	}
	mux.HandleFunc("/servers.json", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"servers": servers})
	})
	// the lobby offers hosting when config.json names a signalling endpoint
	config := map[string]any{}
	if *p2p {
		newSignaller(*ice).routes(mux)
		config["signalUrl"] = "signal/"
	}
	mux.HandleFunc("/config.json", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, config) })
	if *dataDir != "" {
		data := staticHandler(*dataDir)
		mux.Handle("/manifest.json", data)
		mux.Handle("/q3ut4/", data)
	}
	mux.Handle("/", staticHandler(*webDir))

	log.Printf("listening on %s, serving %s, servers %v, browser-hosted games %v", *listen, *webDir, servers, *p2p)
	srv := &http.Server{Addr: *listen, Handler: mux}
	go func() {
		<-ctx.Done() // docker stop: we're PID 1, so exit (and take the game server with us)
		shutdown, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		srv.Shutdown(shutdown)
	}()
	if err := srv.ListenAndServe(); err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(v)
}

func staticHandler(dir string) http.Handler {
	fs := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		switch {
		case strings.HasSuffix(p, ".wasm"):
			w.Header().Set("Content-Type", "application/wasm")
		case strings.HasSuffix(p, ".js"):
			w.Header().Set("Content-Type", "text/javascript")
		case strings.HasSuffix(p, ".pk3"):
			// pk3 names carry a content hash, so they never change
			w.Header().Set("Content-Type", "application/octet-stream")
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		}
		if !strings.HasSuffix(p, ".pk3") {
			w.Header().Set("Cache-Control", "no-cache")
		}
		// serve foo.gz (made at dist time) for foo when the browser accepts gzip
		if strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") && !strings.HasSuffix(p, "/") {
			if f, err := os.Open(filepath.Join(dir, filepath.FromSlash(path.Clean(p))+".gz")); err == nil {
				defer f.Close()
				if st, err := f.Stat(); err == nil && !st.IsDir() {
					w.Header().Set("Content-Encoding", "gzip")
					w.Header().Add("Vary", "Accept-Encoding")
					if w.Header().Get("Content-Type") == "" {
						w.Header().Set("Content-Type", mime.TypeByExtension(filepath.Ext(p)))
					}
					http.ServeContent(w, r, "", st.ModTime(), f)
					return
				}
			}
		}
		fs.ServeHTTP(w, r)
	})
}

// --- server status for the lobby page ---------------------------------------

type player struct {
	Name  string `json:"name"`
	Score int    `json:"score"`
	Ping  int    `json:"ping"`
}

type status struct {
	Online     bool     `json:"online"`
	Hostname   string   `json:"hostname,omitempty"`
	Map        string   `json:"map,omitempty"`
	Gametype   string   `json:"gametype,omitempty"`
	MaxPlayers int      `json:"maxPlayers,omitempty"`
	Players    []player `json:"players"`
}

var gametypes = map[string]string{
	"0": "Free for all", "1": "Last man standing", "3": "Team deathmatch", "4": "Team survivor",
	"5": "Follow the leader", "6": "Capture and hold", "7": "Capture the flag", "8": "Bomb mode",
	"9": "Jump", "10": "Freeze tag", "11": "Gun game",
}

var (
	statusMu   sync.Mutex
	statusAt   time.Time
	statusLast []byte
)

func handleStatus(w http.ResponseWriter, r *http.Request) {
	statusMu.Lock()
	if time.Since(statusAt) > 2*time.Second {
		b, _ := json.Marshal(queryStatus(servers[0]))
		statusLast, statusAt = b, time.Now()
	}
	b := statusLast
	statusMu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(b)
}

// queryStatus sends a Quake 3 "getstatus" and parses the reply:
// "\xff\xff\xff\xffstatusResponse\n\\key\\value...\n<score> <ping> \"name\"\n..."
func queryStatus(addr string) status {
	st := status{Players: []player{}}
	conn, err := net.Dial("udp4", addr)
	if err != nil {
		return st
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(time.Second))
	if _, err := conn.Write([]byte("\xff\xff\xff\xffgetstatus\n")); err != nil {
		return st
	}
	buf := make([]byte, 16384)
	n, err := conn.Read(buf)
	if err != nil {
		return st
	}
	lines := strings.Split(string(buf[:n]), "\n")
	if len(lines) < 2 || !strings.HasSuffix(lines[0], "statusResponse") {
		return st
	}
	kv := strings.Split(strings.TrimPrefix(lines[1], "\\"), "\\")
	info := map[string]string{}
	for i := 0; i+1 < len(kv); i += 2 {
		info[strings.ToLower(kv[i])] = kv[i+1]
	}
	st.Online = true
	st.Hostname = info["sv_hostname"]
	st.Map = info["mapname"]
	st.Gametype = gametypes[info["g_gametype"]]
	st.MaxPlayers, _ = strconv.Atoi(info["sv_maxclients"])
	for _, l := range lines[2:] {
		var p player
		if i := strings.Index(l, "\""); i > 0 {
			fmt.Sscanf(l[:i], "%d %d", &p.Score, &p.Ping)
			p.Name = strings.Trim(l[i:], "\"")
			st.Players = append(st.Players, p)
		}
	}
	return st
}

func handleWS(w http.ResponseWriter, r *http.Request) {
	if conns.Add(1) > maxConns {
		conns.Add(-1)
		http.Error(w, "too many players", http.StatusServiceUnavailable)
		return
	}
	defer conns.Add(-1)

	ws, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	defer ws.CloseNow()
	ws.SetReadLimit(headerLen + maxPayload)

	udp, err := net.ListenUDP("udp4", nil)
	if err != nil {
		log.Printf("udp socket: %v", err)
		ws.Close(websocket.StatusInternalError, "no udp socket")
		return
	}
	defer udp.Close()

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	peer := r.Header.Get("X-Forwarded-For")
	if peer == "" {
		peer = r.RemoteAddr
	}
	log.Printf("%s connected via %s (%d players)", peer, udp.LocalAddr(), conns.Load())
	defer log.Printf("%s disconnected", peer)

	// UDP -> WebSocket
	go func() {
		defer cancel()
		buf := make([]byte, headerLen+maxPayload)
		for {
			udp.SetReadDeadline(time.Now().Add(idleTime))
			n, from, err := udp.ReadFromUDPAddrPort(buf[headerLen:])
			if err != nil {
				return
			}
			from = netip.AddrPortFrom(from.Addr().Unmap(), from.Port())
			if !allowed[from] {
				continue
			}
			ip := from.Addr().As4()
			copy(buf, ip[:])
			binary.BigEndian.PutUint16(buf[4:], from.Port())
			if err := ws.Write(ctx, websocket.MessageBinary, buf[:headerLen+n]); err != nil {
				return
			}
		}
	}()

	// WebSocket -> UDP
	for {
		readCtx, done := context.WithTimeout(ctx, idleTime)
		typ, msg, err := ws.Read(readCtx)
		done()
		if err != nil {
			if !errors.Is(err, context.Canceled) && websocket.CloseStatus(err) == -1 {
				log.Printf("%s: %v", peer, err)
			}
			return
		}
		if typ != websocket.MessageBinary || len(msg) < headerLen {
			continue
		}
		to := netip.AddrPortFrom(netip.AddrFrom4([4]byte(msg[:4])), binary.BigEndian.Uint16(msg[4:6]))
		if !allowed[to] {
			continue // includes LAN broadcasts and master-server queries
		}
		udp.WriteToUDPAddrPort(msg[headerLen:], to)
	}
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
