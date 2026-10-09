// urt-gateway serves the web client and relays its packets to Urban Terror servers.
//
// Browsers can't send UDP, so the client opens a WebSocket to /ws and sends binary
// frames of [4-byte IPv4][2-byte port, big endian][payload]. Each WebSocket gets its
// own UDP socket, so the game server sees every browser as a separate ordinary
// player. Only servers listed in URT_SERVERS can be reached.
package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"log"
	"net"
	"net/http"
	"net/netip"
	"os"
	"strings"
	"sync/atomic"
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
	servers  []string // as advertised to the client
	maxConns = int64(64)
	conns    atomic.Int64
)

func main() {
	listen := flag.String("listen", envOr("URT_LISTEN", ":8080"), "HTTP listen address")
	webDir := flag.String("web", envOr("URT_WEB", "./web"), "directory with the web client")
	serverList := flag.String("servers", os.Getenv("URT_SERVERS"), "comma-separated host:port of allowed game servers; the first is the default")
	flag.Parse()

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
	if len(servers) == 0 {
		log.Fatal("no game servers configured (URT_SERVERS or -servers)")
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", handleWS)
	mux.HandleFunc("/servers.json", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		json.NewEncoder(w).Encode(map[string]any{"servers": servers})
	})
	mux.Handle("/", staticHandler(*webDir))

	log.Printf("listening on %s, serving %s, servers %v", *listen, *webDir, servers)
	log.Fatal(http.ListenAndServe(*listen, mux))
}

func staticHandler(dir string) http.Handler {
	fs := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, ".wasm"):
			w.Header().Set("Content-Type", "application/wasm")
		case strings.HasSuffix(r.URL.Path, ".pk3"):
			// pk3s are content-addressed by the manifest, safe to cache hard
			w.Header().Set("Content-Type", "application/octet-stream")
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		}
		fs.ServeHTTP(w, r)
	})
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
