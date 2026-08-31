import express from 'express';
import { createServer, type IncomingMessage } from 'node:http';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import {
  parseMessage,
  ROOM_CODE_CHARS,
  ROOM_CODE_LENGTH,
  ROOM_GRACE_MS,
  type AnyMessage,
} from '../src/shared/protocol';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8787;

const app = express();
const distDir = path.resolve(__dirname, '..', 'dist');
app.use(express.static(distDir));
app.get('/healthz', (_req, res) => res.send('ok'));

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws', perMessageDeflate: false });

interface Room {
  code: string;
  gameSocket: WebSocket | null;
  controllerSocket: WebSocket | null;
  graceTimer: NodeJS.Timeout | null;
}

interface SocketState {
  role: 'game' | 'controller';
  roomCode: string;
}

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
  const lanIp = getLanIPv4();
  const port = pagePortFromRequest(req);
  return `http://${lanIp}:${port}/controller.html?room=${code}`;
}

function destroyRoom(room: Room) {
  if (room.graceTimer) clearTimeout(room.graceTimer);
  rooms.delete(room.code);
}

wss.on('connection', (socket, req) => {
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
          room = { code, gameSocket: socket, controllerSocket: null, graceTimer: null };
          rooms.set(code, room);
        }
        socketState.set(socket, { role: 'game', roomCode: room.code });
        send(socket, { type: 'room', code: room.code, joinUrl: buildJoinUrl(req, room.code) });
        if (room.controllerSocket && room.controllerSocket.readyState === WebSocket.OPEN) {
          send(socket, { type: 'peer', event: 'controller-joined' });
        }
        return;
      }

      if (msg.role === 'controller') {
        const room = rooms.get(msg.code);
        if (!room) {
          send(socket, { type: 'error', reason: 'bad-room' });
          return;
        }
        if (room.controllerSocket && room.controllerSocket.readyState === WebSocket.OPEN) {
          send(socket, { type: 'error', reason: 'room-full' });
          return;
        }
        room.controllerSocket = socket;
        socketState.set(socket, { role: 'controller', roomCode: room.code });
        send(socket, { type: 'joined' });
        if (room.gameSocket) send(room.gameSocket, { type: 'peer', event: 'controller-joined' });
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
      if (room.gameSocket) send(room.gameSocket, msg);
      return;
    }

    if (state.role === 'game' && msg.type === 'event') {
      if (room.controllerSocket) send(room.controllerSocket, msg);
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
        if (room.controllerSocket) {
          send(room.controllerSocket, { type: 'peer', event: 'game-left' });
          room.controllerSocket.close();
        }
        destroyRoom(room);
      }, ROOM_GRACE_MS);
    } else if (state.role === 'controller' && room.controllerSocket === socket) {
      room.controllerSocket = null;
      if (room.gameSocket) send(room.gameSocket, { type: 'peer', event: 'controller-left' });
    }
  });
});

httpServer.listen(PORT, '0.0.0.0', () => {
  const lanIp = getLanIPv4();
  console.log(`[server] listening on 0.0.0.0:${PORT}`);
  console.log(`[server] LAN URL: http://${lanIp}:${PORT}`);
});
