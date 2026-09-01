import {
  parseMessage,
  PING_INTERVAL_MS,
  type ControllerToServer,
  type EventName,
  type PlayerSlot,
  type SteerMode,
} from '../shared/protocol';

const CODE_STORAGE_KEY = 'kart.controller.roomCode';
const SLOT_STORAGE_KEY = 'kart.controller.slot';
const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000];
const MISSED_PONG_LIMIT = 2;

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting';
export type JoinErrorReason = 'bad-room' | 'room-full';

export interface ControllerInput {
  steer: number;
  throttle: 0 | 1;
  brake: 0 | 1;
  drift: 0 | 1;
  item: 0 | 1;
  steerMode: SteerMode;
}

export interface ControllerSocketCallbacks {
  onStatus?: (status: ConnectionStatus) => void;
  onJoined?: (slot: PlayerSlot) => void;
  onJoinError?: (reason: JoinErrorReason) => void;
  onGameLeft?: () => void;
  onEvent?: (name: EventName) => void;
  onRtt?: (rttMs: number) => void;
}

const SEND_INTERVAL_MS = 33; // 30 Hz

export class ControllerSocket {
  private ws: WebSocket | null = null;
  private reconnectAttempt = 0;
  private sendTimer: number | null = null;
  private pingTimer: number | null = null;
  private pendingPings = new Map<number, number>();
  private missedPongs = 0;
  private seq = 0;
  private getInput: () => ControllerInput;
  slot: PlayerSlot | null = null;

  constructor(
    private code: string,
    getInput: () => ControllerInput,
    private callbacks: ControllerSocketCallbacks,
  ) {
    this.getInput = getInput;
    this.connect();
  }

  private connect() {
    this.callbacks.onStatus?.(this.reconnectAttempt === 0 ? 'connecting' : 'reconnecting');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.missedPongs = 0;
      const storedSlot = sessionStorage.getItem(SLOT_STORAGE_KEY);
      const wantSlot = storedSlot !== null ? (Number(storedSlot) as PlayerSlot) : undefined;
      this.sendRaw({ type: 'hello', role: 'controller', code: this.code, wantSlot });
    });

    ws.addEventListener('message', (ev) => {
      const msg = parseMessage(String(ev.data));
      if (!msg) return;
      switch (msg.type) {
        case 'joined':
          this.reconnectAttempt = 0;
          this.slot = msg.slot;
          sessionStorage.setItem(CODE_STORAGE_KEY, this.code);
          sessionStorage.setItem(SLOT_STORAGE_KEY, String(msg.slot));
          this.callbacks.onStatus?.('connected');
          this.callbacks.onJoined?.(msg.slot);
          this.startSending();
          this.startHeartbeat();
          break;
        case 'error':
          this.callbacks.onJoinError?.(msg.reason);
          break;
        case 'peer':
          if (msg.event === 'game-left') this.callbacks.onGameLeft?.();
          break;
        case 'event':
          this.callbacks.onEvent?.(msg.name);
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
      this.stopSending();
      this.stopHeartbeat();
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

  private startSending() {
    this.sendTimer = window.setInterval(() => {
      const input = this.getInput();
      this.sendRaw({
        type: 'input',
        seq: this.seq++,
        steer: input.steer,
        throttle: input.throttle,
        brake: input.brake,
        drift: input.drift,
        item: input.item,
        steerMode: input.steerMode,
      });
    }, SEND_INTERVAL_MS);
  }

  private stopSending() {
    if (this.sendTimer !== null) {
      window.clearInterval(this.sendTimer);
      this.sendTimer = null;
    }
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

  sendEvent(name: EventName) {
    this.sendRaw({ type: 'event', name });
  }

  private sendRaw(msg: ControllerToServer) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }
}

export function getStoredRoomCode(): string | null {
  return sessionStorage.getItem(CODE_STORAGE_KEY);
}
