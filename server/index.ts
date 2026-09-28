import express from 'express';
import { createServer, type IncomingMessage } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { existsSync, readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WebSocket, WebSocketServer, type WebSocketServer as WSS } from 'ws';
import { publicControllerUrl } from './controllerUrl';
import {
  parseMessage,
  PHONE_SLOT,
  ROOM_CODE_CHARS,
  ROOM_CODE_LENGTH,
  ROOM_GRACE_MS,
  type AnyMessage,
  type PlayerSlot,
} from '../src/shared/protocol';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8787;
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 8788;
// Path C (cloudflared): overrides the joinUrl origin entirely, e.g. https://xyz.trycloudflare.com
const PUBLIC_URL = process.env.PUBLIC_URL;

const app = express();
const distDir = path.resolve(__dirname, '..', 'dist');
app.use(express.static(distDir));
app.get('/healthz', (_req, res) => res.send('ok'));

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws', perMessageDeflate: false });

// Path B (mkcert): if certs/cert.pem + certs/key.pem exist, also serve
// HTTPS/WSS on :8788 from the same express app and room registry, so an
// iPhone can get a secure context for tilt steering without leaving the LAN.
const CERTS_DIR = path.resolve(__dirname, '..', 'certs');
const CERT_PATH = path.join(CERTS_DIR, 'cert.pem');
const KEY_PATH = path.join(CERTS_DIR, 'key.pem');
const hasCerts = existsSync(CERT_PATH) && existsSync(KEY_PATH);

let wssHttps: WSS | null = null;
if (hasCerts) {
  const httpsServer = createHttpsServer(
    { cert: readFileSync(CERT_PATH), key: readFileSync(KEY_PATH) },
    app,
  );
  wssHttps = new WebSocketServer({ server: httpsServer, path: '/ws', perMessageDeflate: false });
  httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
    console.log(`[server] HTTPS listening on 0.0.0.0:${HTTPS_PORT}`);
  });
}

interface Room {
  code: string;
  gameSocket: WebSocket | null;
  // §v5/stage2: exactly one controller can ever join (MAX_CONTROLLERS=1),
  // always at PHONE_SLOT (P2) — indexed by PlayerSlot like before so the rest
  // of this file (which still speaks generically in terms of `slot`) doesn't
  // need to change shape; index 0 (P1, hands-only) is simply never used.
  controllerSockets: (WebSocket | null)[];
  graceTimer: NodeJS.Timeout | null;
}

type SocketState =
  | { role: 'game'; roomCode: string }
  | { role: 'controller'; roomCode: string; slot: PlayerSlot };

const rooms = new Map<string, Room>();
const socketState = new WeakMap<WebSocket, SocketState>();

function generateRoomCode(): string {
  let code: string;
  do {
    code = Array.from(
      { length: ROOM_CODE_LENGTH },
      () => ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)],
    ).join('');
  } while (rooms.has(code));
  return code;
}

function send(socket: WebSocket, msg: AnyMessage) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
}

function getLanIPv4(): string {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return 'localhost';
}

function pagePortFromRequest(req: IncomingMessage): number {
  const origin = req.headers.origin;
  if (origin) {
    try {
      const url = new URL(origin);
      if (url.port) return Number(url.port);
      return url.protocol === 'https:' ? 443 : 80;
    } catch {
      // fall through
    }
  }
  return PORT;
}

function buildJoinUrl(req: IncomingMessage, code: string): string {
  const hostedUrl = publicControllerUrl(code, {
    publicUrl: PUBLIC_URL,
    railwayPublicDomain: process.env.RAILWAY_PUBLIC_DOMAIN,
    requestOrigin: req.headers.origin,
  });
  if (hostedUrl) return hostedUrl;
  const lanIp = getLanIPv4();
  if (hasCerts) {
    return `https://${lanIp}:${HTTPS_PORT}/controller.html?room=${code}`;
  }
  const port = pagePortFromRequest(req);
  return `http://${lanIp}:${port}/controller.html?room=${code}`;
}

function destroyRoom(room: Room) {
  if (room.graceTimer) clearTimeout(room.graceTimer);
  rooms.delete(room.code);
}

// Server-side liveness check for every socket (game + controller), on top of
// the app-level ping/pong the game and controller already exchange for RTT
// display. That app-level ping only runs while the client-side JS is alive
// and scheduling timers; a socket that's actually dead at the TCP level (or
// whose tab was suspended without a clean close) can sit in `OPEN` readyState
// indefinitely otherwise, which is exactly what let a reconnecting phone get
// mistaken for a still-live one (see the controller-join handler above). Uses
// raw WebSocket ping/pong frames, invisible to application code.
const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_MISSED_LIMIT = 2;
const heartbeatMissed = new WeakMap<WebSocket, number>();

function attachHeartbeat(server: WSS): NodeJS.Timeout {
  server.on('connection', (socket) => {
    heartbeatMissed.set(socket, 0);
    socket.on('pong', () => heartbeatMissed.set(socket, 0));
  });
  return setInterval(() => {
    for (const socket of server.clients) {
      const missed = heartbeatMissed.get(socket) ?? 0;
      if (missed >= HEARTBEAT_MISSED_LIMIT) {
        socket.terminate();
        continue;
      }
      heartbeatMissed.set(socket, missed + 1);
      try {
        socket.ping();
      } catch {
        // socket already closing; the next tick (or its close handler) cleans it up
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
}

function handleConnection(socket: WebSocket, req: IncomingMessage) {
  socket.on('message', (data) => {
    const msg = parseMessage(data.toString());
    if (!msg) return; // drop malformed / oversized

    const state = socketState.get(socket);

    if (!state) {
      // First message from this socket must be `hello`.
      if (msg.type !== 'hello') return;

      if (msg.role === 'game') {
        let room: Room | undefined;
        if (msg.wantRoom && rooms.has(msg.wantRoom)) {
          room = rooms.get(msg.wantRoom)!;
          if (room.graceTimer) {
            clearTimeout(room.graceTimer);
            room.graceTimer = null;
          }
          room.gameSocket = socket;
        } else {
          const code = generateRoomCode();
          room = {
            code,
            gameSocket: socket,
            controllerSockets: [null, null],
            graceTimer: null,
          };
          rooms.set(code, room);
        }
        socketState.set(socket, { role: 'game', roomCode: room.code });
        send(socket, { type: 'room', code: room.code, joinUrl: buildJoinUrl(req, room.code) });
        const cs = room.controllerSockets[PHONE_SLOT];
        if (cs && cs.readyState === WebSocket.OPEN) {
          send(socket, { type: 'peer', event: 'controller-joined', slot: PHONE_SLOT });
        }
        return;
      }

      if (msg.role === 'controller') {
        const room = rooms.get(msg.code);
        if (!room) {
          send(socket, { type: 'error', reason: 'bad-room' });
          return;
        }
        // §v5/stage2: only one slot exists — the single phone always drives
        // P2 (PHONE_SLOT). Newest controller always wins: a phone whose old
        // socket died without a clean TCP close (backgrounded tab, flaky
        // wifi, page reload) must never lock the slot as "room-full" for the
        // reconnecting phone — that socket's OPEN readyState lies until the
        // heartbeat below notices, which can take up to ~30s. Instead, any
        // previously-held socket is forcibly terminated and replaced.
        const slot: PlayerSlot = PHONE_SLOT;
        const held = room.controllerSockets[slot];
        if (held) {
          if (room.gameSocket) send(room.gameSocket, { type: 'peer', event: 'controller-left', slot });
          held.terminate();
        }
        room.controllerSockets[slot] = socket;
        socketState.set(socket, { role: 'controller', roomCode: room.code, slot });
        send(socket, { type: 'joined', slot });
        if (room.gameSocket) send(room.gameSocket, { type: 'peer', event: 'controller-joined', slot });
        return;
      }
      return;
    }

    const room = rooms.get(state.roomCode);
    if (!room) return;

    if (msg.type === 'ping') {
      send(socket, { type: 'pong', t: msg.t });
      return;
    }

    if (state.role === 'controller' && msg.type === 'input') {
      if (room.gameSocket) send(room.gameSocket, { ...msg, slot: state.slot });
      return;
    }

    if (state.role === 'game' && msg.type === 'event') {
      if (msg.slot !== undefined) {
        const cs = room.controllerSockets[msg.slot];
        if (cs) send(cs, msg);
      } else {
        for (const cs of room.controllerSockets) {
          if (cs) send(cs, msg);
        }
      }
      return;
    }

    if (state.role === 'controller' && msg.type === 'event') {
      if (room.gameSocket) send(room.gameSocket, { ...msg, slot: state.slot });
      return;
    }
  });

  socket.on('close', () => {
    const state = socketState.get(socket);
    if (!state) return;
    const room = rooms.get(state.roomCode);
    if (!room) return;

    if (state.role === 'game' && room.gameSocket === socket) {
      room.gameSocket = null;
      room.graceTimer = setTimeout(() => {
        for (const cs of room.controllerSockets) {
          if (cs) {
            send(cs, { type: 'peer', event: 'game-left' });
            cs.close();
          }
        }
        destroyRoom(room);
      }, ROOM_GRACE_MS);
    } else if (state.role === 'controller' && room.controllerSockets[state.slot] === socket) {
      room.controllerSockets[state.slot] = null;
      if (room.gameSocket) send(room.gameSocket, { type: 'peer', event: 'controller-left', slot: state.slot });
    }
  });
}

wss.on('connection', handleConnection);
wssHttps?.on('connection', handleConnection);
attachHeartbeat(wss);
if (wssHttps) attachHeartbeat(wssHttps);

httpServer.listen(PORT, '0.0.0.0', () => {
  const lanIp = getLanIPv4();
  console.log(`[server] listening on 0.0.0.0:${PORT}`);
  console.log(`[server] LAN URL: http://${lanIp}:${PORT}`);
  if (hasCerts) console.log(`[server] HTTPS LAN URL: https://${lanIp}:${HTTPS_PORT}`);
  if (PUBLIC_URL) console.log(`[server] PUBLIC_URL override: ${PUBLIC_URL}`);
});
