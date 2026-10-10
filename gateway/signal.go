// Matchmaking for browser-hosted games (client/p2p.js). Nothing game-related
// passes through here: a host's browser runs the UrT server and players reach
// it over WebRTC; this only introduces them.
//
//	ws  /signal/host[?public=1]          host opens a room; gets {t:'room', room, token, ice}
//	ws  /signal/host?room=X&token=Y      host reclaims its room after a dropped connection
//	ws  /signal/join/X                   player joins; gets {t:'joined', peer, ice}, host gets {t:'peer', peer}
//	GET /signal/rooms                    public rooms
//
// Then both sides send {t:'signal', to, data} and receive {t:'signal', from, data};
// the host is peer 0. The host's {t:'info', …} keeps its listing fresh.
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/coder/websocket"
)

const (
	maxRooms      = 256
	maxPeers      = 64
	maxSignalMsg  = 16 * 1024
	hostGrace     = 60 * time.Second                   // a disconnected host can reclaim its room this long
	listingTTL    = 90 * time.Second                   // a listing disappears this long after the host's last info
	codeAlphabet  = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" // no 0/O, 1/I
	signalTimeout = 10 * time.Second
)

type sigConn struct {
	ws *websocket.Conn
	mu sync.Mutex
}

func (c *sigConn) send(v any) {
	b, _ := json.Marshal(v)
	c.mu.Lock()
	defer c.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), signalTimeout)
	defer cancel()
	c.ws.Write(ctx, websocket.MessageText, b)
}

type listing struct {
	Room         string `json:"room"`
	Name         string `json:"name"`
	Map          string `json:"map"`
	Gametype     int    `json:"gametype"`
	Players      int    `json:"players"`
	Max          int    `json:"max"`
	Locked       bool   `json:"locked"`
	Timelimit    int    `json:"timelimit"`
	FriendlyFire bool   `json:"friendlyfire"`
}

type room struct {
	code     string
	token    string
	public   bool
	host     *sigConn
	peers    map[int]*sigConn
	nextPeer int
	info     *listing
	infoAt   time.Time
	expiry   *time.Timer
}

type signaller struct {
	mu    sync.Mutex
	rooms map[string]*room
	ice   json.RawMessage
}

func newSignaller(ice string) *signaller {
	if !json.Valid([]byte(ice)) {
		log.Fatalf("URT_ICE_SERVERS is not valid JSON: %s", ice)
	}
	return &signaller{rooms: map[string]*room{}, ice: json.RawMessage(ice)}
}

func (s *signaller) routes(mux *http.ServeMux) {
	mux.HandleFunc("/signal/rooms", s.handleRooms)
	mux.HandleFunc("/signal/host", s.handleHost)
	mux.HandleFunc("/signal/join/", s.handleJoin)
}

func (s *signaller) handleRooms(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	out := []listing{}
	for _, rm := range s.rooms {
		if rm.public && rm.host != nil && rm.info != nil && time.Since(rm.infoAt) < listingTTL {
			out = append(out, *rm.info)
		}
	}
	s.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(out)
}

func accept(w http.ResponseWriter, r *http.Request) (*sigConn, bool) {
	ws, err := websocket.Accept(w, r, nil)
	if err != nil {
		return nil, false
	}
	ws.SetReadLimit(maxSignalMsg)
	return &sigConn{ws: ws}, true
}

func refuse(c *sigConn, reason string) {
	c.send(map[string]any{"t": "error", "error": reason})
	c.ws.Close(4000, reason)
}

func (s *signaller) handleHost(w http.ResponseWriter, r *http.Request) {
	c, ok := accept(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	code, token := strings.ToUpper(q.Get("room")), q.Get("token")

	s.mu.Lock()
	var rm *room
	switch {
	case code != "":
		rm = s.rooms[code]
		if rm == nil {
			s.mu.Unlock()
			refuse(c, "no-such-room")
			return
		}
		if rm.token != token {
			s.mu.Unlock()
			refuse(c, "room-taken")
			return
		}
		if rm.expiry != nil {
			rm.expiry.Stop()
			rm.expiry = nil
		}
		if old := rm.host; old != nil {
			go old.ws.Close(4001, "replaced")
		}
	case len(s.rooms) >= maxRooms:
		s.mu.Unlock()
		refuse(c, "too-many-rooms")
		return
	default:
		for code == "" || s.rooms[code] != nil {
			code = newRoomCode()
		}
		rm = &room{code: code, token: randomHex(16), public: q.Get("public") == "1", peers: map[int]*sigConn{}, nextPeer: 1}
		s.rooms[code] = rm
	}
	rm.host = c
	waiting := make([]int, 0, len(rm.peers))
	for id := range rm.peers {
		waiting = append(waiting, id)
	}
	s.mu.Unlock()

	c.send(map[string]any{"t": "room", "room": rm.code, "token": rm.token, "ice": s.ice})
	// players who are still waiting on the host (it may have reconnected)
	for _, id := range waiting {
		c.send(map[string]any{"t": "peer", "peer": id})
	}

	s.readLoop(c, func(msg map[string]any) {
		switch msg["t"] {
		case "signal":
			to, _ := msg["to"].(float64)
			s.mu.Lock()
			p := rm.peers[int(to)]
			s.mu.Unlock()
			if p != nil {
				p.send(map[string]any{"t": "signal", "from": 0, "data": msg["data"]})
			}
		case "info":
			s.mu.Lock()
			if rm.public {
				rm.info = cleanListing(rm.code, msg)
				rm.infoAt = time.Now()
			}
			s.mu.Unlock()
		}
	})

	// Host gone: unlist now, forget the room unless it comes back in time.
	// Players already connected over WebRTC keep playing either way.
	s.mu.Lock()
	if rm.host == c {
		rm.host = nil
		rm.expiry = time.AfterFunc(hostGrace, func() { s.expire(rm) })
	}
	s.mu.Unlock()
}

func (s *signaller) expire(rm *room) {
	s.mu.Lock()
	if rm.host != nil || s.rooms[rm.code] != rm {
		s.mu.Unlock()
		return
	}
	delete(s.rooms, rm.code)
	peers := rm.peers
	rm.peers = map[int]*sigConn{}
	s.mu.Unlock()
	for _, p := range peers {
		p.ws.Close(4002, "room closed")
	}
}

func (s *signaller) handleJoin(w http.ResponseWriter, r *http.Request) {
	c, ok := accept(w, r)
	if !ok {
		return
	}
	code := strings.ToUpper(strings.TrimPrefix(r.URL.Path, "/signal/join/"))

	s.mu.Lock()
	rm := s.rooms[code]
	switch {
	case rm == nil || rm.host == nil:
		s.mu.Unlock()
		refuse(c, "no-such-room")
		return
	case len(rm.peers) >= maxPeers:
		s.mu.Unlock()
		refuse(c, "room-full")
		return
	}
	id := rm.nextPeer
	rm.nextPeer++
	rm.peers[id] = c
	host := rm.host
	s.mu.Unlock()

	c.send(map[string]any{"t": "joined", "room": code, "peer": id, "ice": s.ice})
	host.send(map[string]any{"t": "peer", "peer": id})

	s.readLoop(c, func(msg map[string]any) {
		if msg["t"] != "signal" {
			return
		}
		s.mu.Lock()
		h := rm.host
		s.mu.Unlock()
		if h != nil { // players may only talk to the host
			h.send(map[string]any{"t": "signal", "from": id, "data": msg["data"]})
		}
	})

	s.mu.Lock()
	delete(rm.peers, id)
	h := rm.host
	s.mu.Unlock()
	if h != nil {
		h.send(map[string]any{"t": "leave", "peer": id})
	}
}

func (s *signaller) readLoop(c *sigConn, handle func(map[string]any)) {
	defer c.ws.CloseNow()
	for {
		typ, b, err := c.ws.Read(context.Background())
		if err != nil {
			return
		}
		var msg map[string]any
		if typ == websocket.MessageText && json.Unmarshal(b, &msg) == nil {
			handle(msg)
		}
	}
}

func cleanListing(code string, m map[string]any) *listing {
	str := func(k string, n int) string {
		v, _ := m[k].(string)
		for len(v) > n || !utf8.ValidString(v) {
			v = strings.ToValidUTF8(v, "")
			if len(v) > n {
				v = v[:n]
			}
		}
		return v
	}
	num := func(k string, lo, hi int) int {
		f, _ := m[k].(float64)
		return min(max(int(f), lo), hi)
	}
	flag := func(k string) bool { v, _ := m[k].(bool); return v }
	return &listing{
		Room: code, Name: str("name", 40), Map: str("map", 40), Gametype: num("gametype", 0, 20),
		Players: num("players", 0, 64), Max: num("max", 1, 64),
		Locked: flag("locked"), Timelimit: num("timelimit", 0, 999), FriendlyFire: flag("friendlyfire"),
	}
}

func newRoomCode() string {
	b := make([]byte, 6)
	rand.Read(b)
	for i := range b {
		b[i] = codeAlphabet[int(b[i])%len(codeAlphabet)]
	}
	return string(b)
}

func randomHex(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}
