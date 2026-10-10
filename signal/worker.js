// Matchmaking for browser-hosted games (Cloudflare Worker + Durable Objects).
//
// Nothing game-related passes through here: a host's browser runs the UrT
// server and players connect to it over WebRTC data channels. This only lets
// them find each other and exchange the WebRTC offers/answers/ICE candidates.
//
//   wss://…/host[?public=1]           host opens a room; gets {t:'room', room, token, ice}
//   wss://…/host?room=X&token=Y       host reclaims its room after a dropped connection
//   wss://…/join/X                    player joins; gets {t:'joined', peer, ice}, host gets {t:'peer', peer}
//   GET  /rooms                       public rooms: [{room, name, map, gametype, players, max, locked, timelimit, friendlyfire}]
//
// Then both sides send {t:'signal', to, data} and receive {t:'signal', from, data};
// the host is peer 0. Host sends {t:'info', name, map, gametype, players, max, …}
// to keep its directory entry fresh. Leaving players produce {t:'leave', peer}.

const MAX_PEERS = 64;
const MAX_MESSAGE = 16 * 1024;
const LISTING_TTL = 90_000; // a public room disappears this long after its last info
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    if (url.pathname === '/rooms') {
      const res = await directory(env).fetch('https://dir/list');
      return new Response(res.body, { headers: { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' } });
    }

    const isHost = url.pathname === '/host';
    const join = url.pathname.match(/^\/join\/([A-Z0-9]{4,12})$/i);
    if (!isHost && !join) return new Response('not found', { status: 404, headers: cors });
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    if (!originAllowed(request, env)) return new Response('origin not allowed', { status: 403 });

    let room = join ? join[1].toUpperCase() : (url.searchParams.get('room') || '').toUpperCase();
    if (isHost && !room) room = newCode();
    const stub = env.ROOMS.get(env.ROOMS.idFromName(room));
    const forward = new URL(request.url);
    forward.searchParams.set('room', room);
    forward.searchParams.set('role', isHost ? 'host' : 'peer');
    const headers = new Headers(request.headers);
    headers.set('x-ice', JSON.stringify(await iceServers(env)));
    return stub.fetch(new Request(forward, { headers }));
  },
};

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const room = url.searchParams.get('room');
    const ice = JSON.parse(request.headers.get('x-ice') || '[]');
    const [client, server] = Object.values(new WebSocketPair());
    const fail = (error) => {
      this.ctx.acceptWebSocket(server, ['dead']);
      server.send(JSON.stringify({ t: 'error', error }));
      server.close(4000, error);
      return new Response(null, { status: 101, webSocket: client });
    };

    if (url.searchParams.get('role') === 'host') {
      const token = await this.ctx.storage.get('token');
      if (token && url.searchParams.get('token') !== token) return fail('room-taken');
      if (!token && url.searchParams.has('token')) return fail('no-such-room');
      for (const ws of this.ctx.getWebSockets('host')) ws.close(4001, 'replaced');
      const newToken = token || crypto.randomUUID();
      if (!token) {
        await this.ctx.storage.put({ token: newToken, room, public: url.searchParams.get('public') === '1', nextPeer: 1 });
      }
      this.ctx.acceptWebSocket(server, ['host']);
      server.serializeAttachment({ role: 'host', peer: 0 });
      server.send(JSON.stringify({ t: 'room', room, token: newToken, ice }));
      // tell the host who is still waiting on it (it may have reconnected)
      for (const ws of this.ctx.getWebSockets()) {
        const a = ws.deserializeAttachment();
        if (a && a.role === 'peer') server.send(JSON.stringify({ t: 'peer', peer: a.peer }));
      }
      return new Response(null, { status: 101, webSocket: client });
    }

    const host = this.ctx.getWebSockets('host')[0];
    if (!host) return fail('no-such-room');
    if (this.ctx.getWebSockets('peer').length >= MAX_PEERS) return fail('room-full');
    const peer = (await this.ctx.storage.get('nextPeer')) || 1;
    await this.ctx.storage.put('nextPeer', peer + 1);
    this.ctx.acceptWebSocket(server, ['peer', `p${peer}`]);
    server.serializeAttachment({ role: 'peer', peer });
    server.send(JSON.stringify({ t: 'joined', room, peer, ice }));
    host.send(JSON.stringify({ t: 'peer', peer }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    const me = ws.deserializeAttachment();
    if (!me || typeof raw !== 'string' || raw.length > MAX_MESSAGE) return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.t === 'signal') {
      // players may only talk to the host; the host to anyone in its room
      const to = me.role === 'host' ? msg.to : 0;
      const target = to === 0 ? this.ctx.getWebSockets('host')[0] : this.ctx.getWebSockets(`p${to}`)[0];
      target?.send(JSON.stringify({ t: 'signal', from: me.peer, data: msg.data }));
    } else if (msg.t === 'info' && me.role === 'host') {
      const { room, public: listed } = await this.ctx.storage.get(['room', 'public']).then((m) => Object.fromEntries(m));
      if (!listed) return;
      const clip = (s, n) => String(s ?? '').slice(0, n);
      const int = (v, lo, hi) => Math.max(lo, Math.min(hi, v | 0));
      const entry = {
        room, name: clip(msg.name, 40), map: clip(msg.map, 40), gametype: int(msg.gametype, 0, 20),
        players: int(msg.players, 0, 64), max: int(msg.max, 1, 64),
        locked: !!msg.locked, timelimit: int(msg.timelimit, 0, 999), friendlyfire: !!msg.friendlyfire,
      };
      await directory(this.env).fetch('https://dir/put', { method: 'POST', body: JSON.stringify(entry) });
    }
  }

  async webSocketClose(ws) {
    await this.gone(ws);
  }

  async webSocketError(ws) {
    await this.gone(ws);
  }

  async gone(ws) {
    const me = ws.deserializeAttachment();
    if (!me) return;
    if (me.role === 'peer') {
      this.ctx.getWebSockets('host')[0]?.send(JSON.stringify({ t: 'leave', peer: me.peer }));
      return;
    }
    // Host gone: give it a minute to reconnect before the room is forgotten.
    // Players already connected over WebRTC keep playing either way, but new
    // ones can't join, so unlist it now (the host's next info relists it).
    if (this.ctx.getWebSockets('host').some((s) => s !== ws)) return;
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
    const room = await this.ctx.storage.get('room');
    if (room) await directory(this.env).fetch('https://dir/delete', { method: 'POST', body: JSON.stringify({ room }) });
  }

  async alarm() {
    if (this.ctx.getWebSockets('host').length) return;
    const room = await this.ctx.storage.get('room');
    for (const ws of this.ctx.getWebSockets()) ws.close(4002, 'room closed');
    await this.ctx.storage.deleteAll();
    if (room) await directory(this.env).fetch('https://dir/delete', { method: 'POST', body: JSON.stringify({ room }) });
  }
}

// One instance holds the public room list.
export class Directory {
  constructor(ctx) {
    this.ctx = ctx;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/put') {
      const entry = await request.json();
      await this.ctx.storage.put(`r:${entry.room}`, { ...entry, at: Date.now() });
      if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + LISTING_TTL);
      return new Response('ok');
    }
    if (url.pathname === '/delete') {
      const { room } = await request.json();
      await this.ctx.storage.delete(`r:${room}`);
      return new Response('ok');
    }
    const now = Date.now();
    const rooms = [...(await this.ctx.storage.list({ prefix: 'r:' })).values()]
      .filter((r) => now - r.at < LISTING_TTL)
      .map(({ at, ...r }) => r);
    return new Response(JSON.stringify(rooms));
  }

  async alarm() {
    const now = Date.now();
    const all = await this.ctx.storage.list({ prefix: 'r:' });
    const stale = [...all].filter(([, r]) => now - r.at >= LISTING_TTL).map(([k]) => k);
    if (stale.length) await this.ctx.storage.delete(stale);
    if (all.size > stale.length) await this.ctx.storage.setAlarm(now + LISTING_TTL);
  }
}

function directory(env) {
  return env.DIRECTORY.get(env.DIRECTORY.idFromName('public'));
}

function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

function originAllowed(request, env) {
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return !allowed.length || allowed.includes(request.headers.get('Origin'));
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  return originAllowed(request, env) && origin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {};
}

// STUN finds direct paths; TURN (optional, Cloudflare Realtime TURN key in
// TURN_KEY_ID / TURN_KEY_API_TOKEN) relays when both players are behind
// strict NATs.
async function iceServers(env) {
  const servers = [{ urls: 'stun:stun.cloudflare.com:3478' }];
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return servers;
  try {
    const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ttl: 6 * 3600 }),
    });
    if (!res.ok) throw new Error(`TURN credentials: HTTP ${res.status}`);
    const { iceServers: turn } = await res.json();
    return Array.isArray(turn) ? turn : [turn];
  } catch (err) {
    console.error(err);
    return servers;
  }
}
