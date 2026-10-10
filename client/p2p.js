// Browser-hosted games: the host's browser runs the UrT server, players reach it
// over WebRTC data channels, and the signalling Worker (signal/worker.js) only
// introduces them. The engine sees ordinary IPv4 packets (see Module.urtTransport
// in net_ip.c): frames are [4 bytes IPv4][2 bytes port][payload], and every peer
// gets a made-up address. 198.18.0.0/15 is a benchmarking range, so the engine
// doesn't treat players as LAN clients (which would skip rate limits).

export const HOST_ADDRESS = '198.18.0.1';
const HOST_IP = [198, 18, 0, 1];
const PORT = 27960;
const MAX_BUFFERED = 256 * 1024; // past this, drop packets like a full UDP socket would
const CONNECT_TIMEOUT = 25_000;

const peerIp = (id) => [198, 19, (id >> 8) & 255, id & 255];
const ipKey = (b) => `${b[0]}.${b[1]}.${b[2]}.${b[3]}`;

function frame(ip, payload) {
  const f = new Uint8Array(6 + payload.byteLength);
  f.set(ip, 0);
  f[4] = PORT >> 8;
  f[5] = PORT & 255;
  f.set(new Uint8Array(payload), 6);
  return f;
}

function socketUrl(signalUrl, path) {
  const u = new URL(path, signalUrl.endsWith('/') ? signalUrl : signalUrl + '/');
  u.protocol = u.protocol === 'http:' ? 'ws:' : u.protocol === 'https:' ? 'wss:' : u.protocol;
  return u.href;
}

const ERRORS = {
  'no-such-room': 'That game doesn’t exist any more. The host may have left.',
  'room-full': 'That game is full.',
  'room-taken': 'Couldn’t reopen the game room.',
};

// One WebRTC connection. Buffers ICE candidates that arrive before the remote description.
class Link {
  constructor(ice, sendSignal) {
    this.pc = new RTCPeerConnection({ iceServers: ice });
    this.pending = [];
    this.pc.onicecandidate = (e) => { if (e.candidate) sendSignal({ candidate: e.candidate.toJSON() }); };
    this.sendSignal = sendSignal;
  }

  async signal(data) {
    if (data.sdp) {
      await this.pc.setRemoteDescription(data.sdp);
      if (data.sdp.type === 'offer') {
        await this.pc.setLocalDescription();
        this.sendSignal({ sdp: this.pc.localDescription.toJSON() });
      }
      for (const c of this.pending.splice(0)) await this.pc.addIceCandidate(c).catch(() => {});
    } else if (data.candidate) {
      if (this.pc.remoteDescription) await this.pc.addIceCandidate(data.candidate).catch(() => {});
      else this.pending.push(data.candidate);
    }
  }

  close() {
    this.channel?.close();
    this.pc.close();
  }
}

/**
 * Open a room and accept players. Resolves once the room exists.
 * Returns { room, transport, setInfo(info), players(), close() }; players() counts open data channels.
 */
export function hostGame(signalUrl, { listed = false, onPlayers = () => {}, onStatus = () => {} } = {}) {
  const links = new Map(); // peer id -> Link
  const byIp = new Map(); // "198.19.x.y" -> Link
  let ws, room, token, ice, closed = false, retry = 0, info = null, onFrame = null;

  const openCount = () => [...links.values()].filter((l) => l.channel?.readyState === 'open').length;
  const sendInfo = () => {
    if (info && ws?.readyState === 1) ws.send(JSON.stringify({ t: 'info', players: openCount() + 1, ...info }));
  };
  const changed = () => { onPlayers(openCount()); sendInfo(); };

  function addPeer(id) {
    links.get(id)?.close();
    const ip = peerIp(id);
    const link = new Link(ice, (data) => ws?.readyState === 1 && ws.send(JSON.stringify({ t: 'signal', to: id, data })));
    const ch = link.channel = link.pc.createDataChannel('urt', { ordered: false, maxRetransmits: 0 });
    ch.binaryType = 'arraybuffer';
    ch.onopen = changed;
    ch.onmessage = (e) => onFrame?.(frame(ip, e.data));
    ch.onclose = () => { if (links.get(id) === link) dropPeer(id); };
    link.pc.onconnectionstatechange = () => {
      if (link.pc.connectionState === 'failed' && links.get(id) === link) dropPeer(id);
    };
    links.set(id, link);
    byIp.set(ipKey(ip), link);
    link.pc.setLocalDescription().then(() => link.sendSignal({ sdp: link.pc.localDescription.toJSON() }));
  }

  function dropPeer(id) {
    const link = links.get(id);
    if (!link) return;
    links.delete(id);
    byIp.delete(ipKey(peerIp(id)));
    link.close();
    changed();
  }

  const ready = new Promise((resolve, reject) => {
    function connect() {
      const path = token ? `host?room=${room}&token=${encodeURIComponent(token)}` : `host${listed ? '?public=1' : ''}`;
      ws = new WebSocket(socketUrl(signalUrl, path));
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.t === 'room') {
          ({ room, token, ice } = msg);
          retry = 0;
          onStatus('online');
          sendInfo();
          resolve();
        } else if (msg.t === 'peer') {
          // a player who joined while we were reconnecting may already be connected
          if (links.get(msg.peer)?.channel?.readyState !== 'open') addPeer(msg.peer);
        } else if (msg.t === 'signal') {
          links.get(msg.from)?.signal(msg.data).catch((err) => console.warn('urt p2p:', err));
        } else if (msg.t === 'leave') {
          // players hang up on the signalling server once connected; only drop half-made links
          if (links.get(msg.peer)?.channel?.readyState !== 'open') dropPeer(msg.peer);
        } else if (msg.t === 'error') {
          reject(new Error(ERRORS[msg.error] || msg.error));
        }
      };
      ws.onclose = () => {
        if (closed) return;
        if (!room) { reject(new Error('Couldn’t reach the matchmaking server.')); return; }
        // players already in keep playing; new ones can join once we're back
        onStatus('reconnecting');
        setTimeout(connect, Math.min(30_000, 1000 * 2 ** retry++));
      };
    }
    connect();
  });

  // keep the public listing alive
  const infoTimer = setInterval(sendInfo, 30_000);

  const transport = {
    open(cb) {
      onFrame = cb;
      return {
        readyState: 1,
        send(f) {
          const ch = byIp.get(ipKey(f))?.channel;
          if (ch?.readyState === 'open' && ch.bufferedAmount < MAX_BUFFERED) ch.send(f.subarray(6));
        },
        close() { onFrame = null; },
      };
    },
  };

  return ready.then(() => ({
    room,
    transport,
    // listing details; sent now if anything changed, else with the 30 s refresh
    setInfo(i) {
      const next = { ...info, ...i };
      if (JSON.stringify(next) === JSON.stringify(info)) return;
      info = next;
      sendInfo();
    },
    players: openCount,
    close() {
      closed = true;
      clearInterval(infoTimer);
      ws?.close();
      for (const id of [...links.keys()]) dropPeer(id);
    },
  }));
}

/**
 * Connect to a hosted room. Resolves with { transport } once the data channel
 * to the host is open; the engine then connects to HOST_ADDRESS.
 */
export function joinGame(signalUrl, room, { onStatus = () => {}, onDisconnect = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(socketUrl(signalUrl, `join/${encodeURIComponent(room)}`));
    let link, done = false;
    const fail = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ws.close();
      link?.close();
      reject(err);
    };
    const timer = setTimeout(() => fail(new Error(
      'Couldn’t connect to the host. One of you may be behind a network that blocks direct connections.')), CONNECT_TIMEOUT);

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.t === 'joined') {
        onStatus('Connecting to the host…');
        link = new Link(msg.ice, (data) => ws.readyState === 1 && ws.send(JSON.stringify({ t: 'signal', to: 0, data })));
        link.pc.ondatachannel = (ev) => {
          const ch = link.channel = ev.channel;
          ch.binaryType = 'arraybuffer';
          ch.onopen = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            ws.close(); // the host doesn't need us on the signalling server any more
            resolve({ transport: joinTransport(ch, onDisconnect) });
          };
        };
      } else if (msg.t === 'signal') {
        link?.signal(msg.data).catch((err) => console.warn('urt p2p:', err));
      } else if (msg.t === 'error') {
        fail(new Error(ERRORS[msg.error] || msg.error));
      }
    };
    ws.onclose = () => fail(new Error('Couldn’t reach the matchmaking server.'));
  });
}

function joinTransport(ch, onDisconnect) {
  let onFrame = null;
  ch.onmessage = (e) => onFrame?.(frame(HOST_IP, e.data));
  ch.onclose = onDisconnect;
  return {
    open(cb) {
      onFrame = cb;
      return {
        readyState: 1,
        // everything goes to the host, whatever address the engine aimed at
        send(f) { if (ch.readyState === 'open' && ch.bufferedAmount < MAX_BUFFERED) ch.send(f.subarray(6)); },
        close() { onFrame = null; },
      };
    },
  };
}

// Public rooms from the signalling server.
export async function listRooms(signalUrl) {
  const u = new URL('rooms', signalUrl.endsWith('/') ? signalUrl : signalUrl + '/');
  return (await fetch(u, { cache: 'no-store' })).json();
}
