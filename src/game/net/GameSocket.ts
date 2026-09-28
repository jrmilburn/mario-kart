import {
  parseMessage,
  PING_INTERVAL_MS,
  type EventName,
  type GameToServer,
  type InputSnapshot,
  type PlayerSlot,
} from '../../shared/protocol';
import { resolveRelayUrl } from '../../shared/relayUrl';

const ROOM_STORAGE_KEY = 'kart.game.roomCode';
const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000];
const MISSED_PONG_LIMIT = 2;

// §stage2: same relay-discovery rule as the controller (ControllerSocket.ts)
// — an explicit VITE_RELAY_URL wins (any of wss://host, wss://host/ws,
// https://host, http://host, or a bare host — see shared/relayUrl.ts), else
// same-origin.
function relayUrl(): string {
  const configured = import.meta.env.VITE_RELAY_URL as string | undefined;
  return resolveRelayUrl(configured, { protocol: location.protocol, host: location.host });
}

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting';

export interface GameSocketCallbacks {
  onRoom?: (code: string, joinUrl: string) => void;
  onPeer?: (event: 'controller-joined' | 'controller-left' | 'game-left', slot?: PlayerSlot) => void;
  onInput?: (snapshot: InputSnapshot) => void;
  onEvent?: (name: EventName, slot?: PlayerSlot) => void; // commands relayed from the controller (start/restart)
  onStatus?: (status: ConnectionStatus) => void;
  onRtt?: (rttMs: number) => void;
}

export class GameSocket {
  private ws: WebSocket | null = null;
  private reconnectAttempt = 0;
  private pingTimer: number | null = null;
  private pendingPings = new Map<number, number>();
  private missedPongs = 0;
  private closedByUs = false;
  roomCode: string | null = null;
  joinUrl: string | null = null;

  constructor(private callbacks: GameSocketCallbacks) {
    this.connect();
  }

  private connect() {
    this.callbacks.onStatus?.(this.reconnectAttempt === 0 ? 'connecting' : 'reconnecting');
    const ws = new WebSocket(relayUrl());
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.reconnectAttempt = 0;
      this.missedPongs = 0;
      // §defect-fix: sessionStorage throws in some locked-down contexts
      // (private browsing / storage-blocking extensions) — a throw here would
      // kill the socket's open handler and leave the game silently unable to
      // ever announce itself to the relay.
      let wantRoom: string | undefined;
      try {
        wantRoom = sessionStorage.getItem(ROOM_STORAGE_KEY) ?? undefined;
      } catch {
        wantRoom = undefined;
      }
      this.sendRaw({ type: 'hello', role: 'game', wantRoom });
      this.startHeartbeat();
      this.callbacks.onStatus?.('connected');
    });

    ws.addEventListener('message', (ev) => {
      const msg = parseMessage(String(ev.data));
      if (!msg) return;
      switch (msg.type) {
        case 'room':
          this.roomCode = msg.code;
          this.joinUrl = msg.joinUrl;
          sessionStorage.setItem(ROOM_STORAGE_KEY, msg.code);
          this.callbacks.onRoom?.(msg.code, msg.joinUrl);
          break;
        case 'peer':
          this.callbacks.onPeer?.(msg.event as 'controller-joined' | 'controller-left' | 'game-left', msg.slot);
          break;
        case 'input':
          this.callbacks.onInput?.(msg);
          break;
        case 'event':
          this.callbacks.onEvent?.(msg.name, msg.slot);
          break;
        case 'pong': {
          const sentAt = this.pendingPings.get(msg.t);
          if (sentAt !== undefined) {
            this.pendingPings.delete(msg.t);
            this.missedPongs = 0;
            this.callbacks.onRtt?.(performance.now() - sentAt);
          }
          break;
        }
      }
    });

    ws.addEventListener('close', () => {
      this.stopHeartbeat();
      if (this.closedByUs) return;
      this.callbacks.onStatus?.('reconnecting');
      this.scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      ws.close();
    });
  }

  private scheduleReconnect() {
    const delay = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
    this.reconnectAttempt++;
    setTimeout(() => this.connect(), delay);
  }

  private startHeartbeat() {
    this.pingTimer = window.setInterval(() => {
      if (this.missedPongs >= MISSED_PONG_LIMIT) {
        this.callbacks.onStatus?.('reconnecting');
      }
      this.missedPongs++;
      const t = performance.now();
      this.pendingPings.set(t, t);
      this.sendRaw({ type: 'ping', t });
    }, PING_INTERVAL_MS);
  }

  private stopHeartbeat() {
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  sendEvent(name: EventName, slot?: PlayerSlot) {
    this.sendRaw({ type: 'event', name, slot });
  }

  private sendRaw(msg: GameToServer) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }
}
