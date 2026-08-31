import { INPUT_STALE_MS, type InputSnapshot, type SteerMode } from '../../shared/protocol';

export interface ControlState {
  steer: number;
  throttle: 0 | 1;
  brake: 0 | 1;
  drift: 0 | 1;
}

const NEUTRAL: ControlState = { steer: 0, throttle: 0, brake: 0, drift: 0 };

// Keyboard input stays "active" this long after the last mapped keypress (D12).
const KEYBOARD_OVERRIDE_MS = 2000;

export interface InputDiagnostics {
  source: 'keyboard' | 'controller' | 'neutral';
  steerMode: SteerMode | null;
  seq: number | null;
  ageMs: number | null;
}

// Merges controller snapshots (relayed over the network) and keyboard state into
// a single ControlState sampled once per physics tick. Keyboard listening itself
// is wired up in Phase 2 via setKeyboardState(); this class only defines the
// merge/staleness seam so that phase can plug in without touching this logic.
export class InputSource {
  private latestSnapshot: InputSnapshot | null = null;
  private latestReceivedAt = 0;
  private keyboardState: ControlState | null = null;
  private keyboardLastActiveAt = 0;

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

  setKeyboardState(state: ControlState | null) {
    this.keyboardState = state;
    if (state) this.keyboardLastActiveAt = performance.now();
  }

  sample(now: number = performance.now()): ControlState {
    if (this.keyboardState && now - this.keyboardLastActiveAt < KEYBOARD_OVERRIDE_MS) {
      return this.keyboardState;
    }
    if (this.latestSnapshot && now - this.latestReceivedAt < INPUT_STALE_MS) {
      const s = this.latestSnapshot;
      return { steer: s.steer, throttle: s.throttle, brake: s.brake, drift: s.drift };
    }
    return NEUTRAL;
  }

  diagnostics(now: number = performance.now()): InputDiagnostics {
    const keyboardActive = !!this.keyboardState && now - this.keyboardLastActiveAt < KEYBOARD_OVERRIDE_MS;
    if (keyboardActive) {
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
