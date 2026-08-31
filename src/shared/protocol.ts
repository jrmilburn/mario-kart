// Single source of truth for all WebSocket message shapes between
// controller <-> server <-> game. See PLAN.md §2.4 and §3.6.

export type SteerMode = 'touch' | 'tilt';

export interface InputSnapshot {
  type: 'input';
  seq: number; // monotonically increasing per controller session
  steer: number; // -1 (full left) .. +1 (full right)
  throttle: 0 | 1;
  brake: 0 | 1;
  drift: 0 | 1;
  steerMode: SteerMode;
}

export interface GameHello {
  type: 'hello';
  role: 'game';
  wantRoom?: string; // reclaim after reload
}

export interface ControllerHello {
  type: 'hello';
  role: 'controller';
  code: string;
}

export type HelloMessage = GameHello | ControllerHello;

export interface RoomMessage {
  type: 'room';
  code: string;
  joinUrl: string;
}

export interface JoinedMessage {
  type: 'joined';
}

export interface ErrorMessage {
  type: 'error';
  reason: 'bad-room' | 'room-full';
}

export interface PeerMessage {
  type: 'peer';
  event: 'controller-joined' | 'controller-left' | 'game-left';
}

export type EventName = 'lobby' | 'countdown' | 'go' | 'paused' | 'finished' | 'restart';

export interface EventMessage {
  type: 'event';
  name: EventName;
}

export interface PingMessage {
  type: 'ping';
  t: number;
}

export interface PongMessage {
  type: 'pong';
  t: number;
}

// Messages a controller socket may send to the server.
export type ControllerToServer = ControllerHello | InputSnapshot | PingMessage;

// Messages a game socket may send to the server.
export type GameToServer = GameHello | EventMessage | PingMessage;

// Messages the server may send to a controller socket.
export type ServerToController = JoinedMessage | ErrorMessage | PeerMessage | EventMessage | PongMessage;

// Messages the server may send to a game socket.
export type ServerToGame = RoomMessage | PeerMessage | InputSnapshot | PongMessage;

export type AnyMessage =
  | HelloMessage
  | RoomMessage
  | JoinedMessage
  | ErrorMessage
  | PeerMessage
  | EventMessage
  | InputSnapshot
  | PingMessage
  | PongMessage;

const MAX_MESSAGE_BYTES = 1024;

export function parseMessage(raw: string): AnyMessage | null {
  if (raw.length > MAX_MESSAGE_BYTES) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isAnyMessage(obj)) return null;
  return obj;
}

function isAnyMessage(obj: unknown): obj is AnyMessage {
  if (typeof obj !== 'object' || obj === null) return false;
  const type = (obj as { type?: unknown }).type;
  switch (type) {
    case 'hello':
      return isHelloMessage(obj as HelloMessage);
    case 'room':
      return isRoomMessage(obj as RoomMessage);
    case 'joined':
      return true;
    case 'error':
      return isErrorMessage(obj as ErrorMessage);
    case 'peer':
      return isPeerMessage(obj as PeerMessage);
    case 'event':
      return isEventMessage(obj as EventMessage);
    case 'input':
      return isInputSnapshot(obj as InputSnapshot);
    case 'ping':
      return isPingOrPong(obj as PingMessage);
    case 'pong':
      return isPingOrPong(obj as PongMessage);
    default:
      return false;
  }
}

export function isHelloMessage(m: unknown): m is HelloMessage {
  const o = m as Partial<HelloMessage> & { role?: string };
  if (typeof o !== 'object' || o === null) return false;
  if (o.role === 'game') {
    const g = o as Partial<GameHello>;
    return g.wantRoom === undefined || typeof g.wantRoom === 'string';
  }
  if (o.role === 'controller') {
    const c = o as Partial<ControllerHello>;
    return typeof c.code === 'string';
  }
  return false;
}

export function isRoomMessage(m: unknown): m is RoomMessage {
  const o = m as Partial<RoomMessage>;
  return typeof o.code === 'string' && typeof o.joinUrl === 'string';
}

export function isErrorMessage(m: unknown): m is ErrorMessage {
  const o = m as Partial<ErrorMessage>;
  return o.reason === 'bad-room' || o.reason === 'room-full';
}

export function isPeerMessage(m: unknown): m is PeerMessage {
  const o = m as Partial<PeerMessage>;
  return o.event === 'controller-joined' || o.event === 'controller-left' || o.event === 'game-left';
}

const EVENT_NAMES: EventName[] = ['lobby', 'countdown', 'go', 'paused', 'finished', 'restart'];

export function isEventMessage(m: unknown): m is EventMessage {
  const o = m as Partial<EventMessage>;
  return typeof o.name === 'string' && (EVENT_NAMES as string[]).includes(o.name);
}

export function isInputSnapshot(m: unknown): m is InputSnapshot {
  const o = m as Partial<InputSnapshot>;
  return (
    typeof o.seq === 'number' &&
    typeof o.steer === 'number' &&
    (o.throttle === 0 || o.throttle === 1) &&
    (o.brake === 0 || o.brake === 1) &&
    (o.drift === 0 || o.drift === 1) &&
    (o.steerMode === 'touch' || o.steerMode === 'tilt')
  );
}

export function isPingOrPong(m: unknown): m is PingMessage | PongMessage {
  const o = m as Partial<PingMessage>;
  return typeof o.t === 'number';
}

export const ROOM_CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 4;
export const PING_INTERVAL_MS = 2000;
export const INPUT_STALE_MS = 400;
export const CONTROLLER_ABSENT_MS = 2000;
export const ROOM_GRACE_MS = 30_000;
