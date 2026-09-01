import express from 'express';
import { createServer, type IncomingMessage } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { existsSync, readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WebSocket, WebSocketServer, type WebSocketServer as WSS } from 'ws';
import {
  parseMessage,
  MAX_CONTROLLERS,
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
  controllerSockets: (WebSocket | null)[]; // length MAX_CONTROLLERS, indexed by PlayerSlot
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
  if (PUBLIC_URL) {
    return `${PUBLIC_URL.replace(/\/+$/, '')}/controller.html?room=${code}`;
  }
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
            controllerSockets: new Array(MAX_CONTROLLERS).fill(null),
            graceTimer: null,
          };
          rooms.set(code, room);
        }
        socketState.set(socket, { role: 'game', roomCode: room.code });
        send(socket, { type: 'room', code: room.code, joinUrl: buildJoinUrl(req, room.code) });
        for (let s = 0; s < MAX_CONTROLLERS; s++) {
          const cs = room.controllerSockets[s];
          if (cs && cs.readyState === WebSocket.OPEN) {
            send(socket, { type: 'peer', event: 'controller-joined', slot: s as PlayerSlot });
          }
        }
        return;
      }

      if (msg.role === 'controller') {
        const room = rooms.get(msg.code);
        if (!room) {
          send(socket, { type: 'error', reason: 'bad-room' });
          return;
        }
        // Grant the requested slot if it's free/dead; otherwise the lowest
        // free slot. `room-full` only when both slots are held by OPEN sockets.
        let slot: PlayerSlot | null = null;
        if (msg.wantSlot !== undefined) {
          const held = room.controllerSockets[msg.wantSlot];
          if (!held || held.readyState !== WebSocket.OPEN) slot = msg.wantSlot;
        }
        if (slot === null) {
          for (let s = 0; s < MAX_CONTROLLERS; s++) {
            const held = room.controllerSockets[s];
            if (!held || held.readyState !== WebSocket.OPEN) {
              slot = s as PlayerSlot;
              break;
            }
          }
        }
        if (slot === null) {
          send(socket, { type: 'error', reason: 'room-full' });
          return;
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

    // §Phase 3: character select, stamped with the sender's slot exactly like input.
    if (state.role === 'controller' && msg.type === 'select') {
      if (room.gameSocket) send(room.gameSocket, { ...msg, slot: state.slot });
      return;
    }

    // §Phase 3: roster broadcast — every connected controller needs the full
    // picture to grey out taken tiles, so no slot targeting here.
    if (state.role === 'game' && msg.type === 'roster') {
      for (const cs of room.controllerSockets) {
        if (cs) send(cs, msg);
      }
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

httpServer.listen(PORT, '0.0.0.0', () => {
  const lanIp = getLanIPv4();
  console.log(`[server] listening on 0.0.0.0:${PORT}`);
  console.log(`[server] LAN URL: http://${lanIp}:${PORT}`);
  if (hasCerts) console.log(`[server] HTTPS LAN URL: https://${lanIp}:${HTTPS_PORT}`);
  if (PUBLIC_URL) console.log(`[server] PUBLIC_URL override: ${PUBLIC_URL}`);
});
