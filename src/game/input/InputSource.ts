import { INPUT_STALE_MS, type InputSnapshot, type SteerMode } from '../../shared/protocol';

export interface ControlState {
  steer: number;
  throttle: 0 | 1;
  brake: 0 | 1;
  drift: 0 | 1;
  item: 0 | 1;
}

const NEUTRAL: ControlState = { steer: 0, throttle: 0, brake: 0, drift: 0, item: 0 };

// Keyboard input stays "active" this long after the last mapped keypress (D12).
const KEYBOARD_OVERRIDE_MS = 2000;

const THROTTLE_CODES = ['KeyW', 'ArrowUp'];
const BRAKE_CODES = ['KeyS', 'ArrowDown'];
const LEFT_CODES = ['KeyA', 'ArrowLeft'];
const RIGHT_CODES = ['KeyD', 'ArrowRight'];
const DRIFT_CODES = ['ShiftLeft', 'ShiftRight'];
const ITEM_CODES = ['KeyK'];
const MAPPED_CODES = new Set([
  ...THROTTLE_CODES,
  ...BRAKE_CODES,
  ...LEFT_CODES,
  ...RIGHT_CODES,
  ...DRIFT_CODES,
  ...ITEM_CODES,
]);

export interface InputDiagnostics {
  source: 'keyboard' | 'controller' | 'neutral';
  steerMode: SteerMode | null;
  seq: number | null;
  ageMs: number | null;
}

// Merges controller snapshots (relayed over the network) and keyboard state into
// a single ControlState sampled once per physics tick. Keyboard always wins for
// 2s after the last mapped keypress (D12); otherwise the latest fresh controller
// snapshot is used; otherwise neutral (coast).
export class InputSource {
  private latestSnapshot: InputSnapshot | null = null;
  private latestReceivedAt = 0;
  private keysDown = new Set<string>();
  private lastKeyboardActivityAt = -Infinity;

  attachKeyboard() {
    window.addEventListener('keydown', (e) => {
      if (!MAPPED_CODES.has(e.code)) return;
      this.keysDown.add(e.code);
      this.lastKeyboardActivityAt = performance.now();
    });
    window.addEventListener('keyup', (e) => {
      if (!MAPPED_CODES.has(e.code)) return;
      this.keysDown.delete(e.code);
    });
    window.addEventListener('blur', () => this.keysDown.clear());
  }

  onSnapshot(snapshot: InputSnapshot) {
    // Discard out-of-order/duplicate snapshots, except a seq reset that arrives
    // more than 1s after the last one (a fresh controller session reconnected).
    if (
      this.latestSnapshot &&
      snapshot.seq <= this.latestSnapshot.seq &&
      performance.now() - this.latestReceivedAt < 1000
    ) {
      return;
    }
    this.latestSnapshot = snapshot;
    this.latestReceivedAt = performance.now();
  }

  private keyboardControlState(): ControlState {
    const left = this.keysDown.has(LEFT_CODES[0]) || this.keysDown.has(LEFT_CODES[1]);
    const right = this.keysDown.has(RIGHT_CODES[0]) || this.keysDown.has(RIGHT_CODES[1]);
    let steer = 0;
    if (left && !right) steer = -1;
    else if (right && !left) steer = 1;

    const throttle = THROTTLE_CODES.some((c) => this.keysDown.has(c)) ? 1 : 0;
    const brake = BRAKE_CODES.some((c) => this.keysDown.has(c)) ? 1 : 0;
    const drift = DRIFT_CODES.some((c) => this.keysDown.has(c)) ? 1 : 0;
    const item = ITEM_CODES.some((c) => this.keysDown.has(c)) ? 1 : 0;
    return {
      steer,
      throttle: throttle as 0 | 1,
      brake: brake as 0 | 1,
      drift: drift as 0 | 1,
      item: item as 0 | 1,
    };
  }

  isKeyboardActive(now: number): boolean {
    return now - this.lastKeyboardActivityAt < KEYBOARD_OVERRIDE_MS;
  }

  sample(now: number = performance.now()): ControlState {
    if (this.isKeyboardActive(now)) {
      return this.keyboardControlState();
    }
    if (this.latestSnapshot && now - this.latestReceivedAt < INPUT_STALE_MS) {
      const s = this.latestSnapshot;
      return { steer: s.steer, throttle: s.throttle, brake: s.brake, drift: s.drift, item: s.item };
    }
    return NEUTRAL;
  }

  // Raw controller snapshot age, independent of keyboard override — used by
  // RaceDirector's pause-on-disconnect watchdog (§3.6), which cares about the
  // phone's connectivity regardless of whether keyboard is currently driving.
  rawControllerAgeMs(now: number = performance.now()): number | null {
    return this.latestSnapshot ? now - this.latestReceivedAt : null;
  }

  diagnostics(now: number = performance.now()): InputDiagnostics {
    if (this.isKeyboardActive(now)) {
      return { source: 'keyboard', steerMode: null, seq: null, ageMs: null };
    }
    if (this.latestSnapshot && now - this.latestReceivedAt < INPUT_STALE_MS) {
      return {
        source: 'controller',
        steerMode: this.latestSnapshot.steerMode,
        seq: this.latestSnapshot.seq,
        ageMs: now - this.latestReceivedAt,
      };
    }
    return {
      source: 'neutral',
      steerMode: this.latestSnapshot?.steerMode ?? null,
      seq: this.latestSnapshot?.seq ?? null,
      ageMs: this.latestSnapshot ? now - this.latestReceivedAt : null,
    };
  }
}
