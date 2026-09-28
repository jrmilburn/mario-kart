import type { ControlProvider, ControlState } from './ControlProvider';

// Keyboard input stays "active" this long after the last mapped keypress (D12).
const KEYBOARD_OVERRIDE_MS = 2000;

// Phase 2b: each KeyboardProvider owns one player's key mapping, so P1
// (WASD/left-shift/Space) and P2 (arrows/right-shift/Enter or /) can drive
// independently from the same keyboard.
export interface Keymap {
  throttle: string[];
  brake: string[];
  left: string[];
  right: string[];
  drift: string[];
  boost: string[];
}

export const KEYMAP_P1: Keymap = {
  throttle: ['KeyW'],
  brake: ['KeyS'],
  left: ['KeyA'],
  right: ['KeyD'],
  drift: ['ShiftLeft'],
  boost: ['Space'],
};

// §v5: Enter doubles as "start race" in the lobby (main.ts); requestStart is a
// no-op outside LOBBY, so mid-race it is purely P2's boost.
export const KEYMAP_P2: Keymap = {
  throttle: ['ArrowUp'],
  brake: ['ArrowDown'],
  left: ['ArrowLeft'],
  right: ['ArrowRight'],
  drift: ['ShiftRight'],
  boost: ['Enter', 'NumpadEnter', 'Slash'],
};

export class KeyboardProvider implements ControlProvider {
  readonly kind = 'keyboard' as const;
  private keysDown = new Set<string>();
  private lastActivityAt = -Infinity;
  private mappedCodes: Set<string>;
  private boostCodes: Set<string>;
  private driftCodes: Set<string>;
  private overrideCodes: string[];

  constructor(private keymap: Keymap) {
    this.boostCodes = new Set(keymap.boost);
    this.driftCodes = new Set(keymap.drift);
    this.overrideCodes = [...keymap.throttle, ...keymap.brake, ...keymap.left, ...keymap.right];
    this.mappedCodes = new Set([...this.overrideCodes, ...keymap.drift, ...keymap.boost]);
  }

  attach() {
    window.addEventListener('keydown', (e) => {
      if (!this.mappedCodes.has(e.code)) return;
      this.keysDown.add(e.code);
      // §v5/§hands-fix: boost AND drift keys deliberately don't count as
      // "keyboard activity". Space also starts the race and is a natural
      // thing for a hands player to tap, and Shift is the drift modifier a
      // hands player would naturally reach for out of habit — if either
      // flipped P1 onto the keyboard for 2s, the kart would lose its hand
      // steering/throttle mid-corner. Both levels are instead ORed in by
      // InputSource onto whichever source is actually driving (see
      // boostHeld()/driftHeld()), except drift never applies to hands (hands
      // never drift — see InputSource.sample).
      if (!this.boostCodes.has(e.code) && !this.driftCodes.has(e.code)) this.lastActivityAt = performance.now();
    });
    window.addEventListener('keyup', (e) => {
      if (!this.mappedCodes.has(e.code)) return;
      this.keysDown.delete(e.code);
    });
    window.addEventListener('blur', () => this.keysDown.clear());
  }

  // §stage2 review fix: this used to be purely time-based (< 2s since the
  // last mapped keydown), so a key HELD longer than 2s — the completely
  // ordinary case of holding W through a straight — read as "inactive" the
  // moment the 2s window lapsed, and the keyboard driver would drop out from
  // under a still-pressed key. Active now while any mapped override key
  // (throttle/brake/steer — NOT boost or drift, see attach()) is actually
  // down, OR within 2s of the last one letting go.
  isActive(now: number): boolean {
    if (this.any(this.overrideCodes)) return true;
    return now - this.lastActivityAt < KEYBOARD_OVERRIDE_MS;
  }

  boostHeld(): 0 | 1 {
    return this.any(this.keymap.boost) ? 1 : 0;
  }

  driftHeld(): 0 | 1 {
    return this.any(this.keymap.drift) ? 1 : 0;
  }

  private any(codes: string[]): boolean {
    return codes.some((c) => this.keysDown.has(c));
  }

  // Always computable — InputSource also uses this as the fallback state when
  // no provider has an opinion (e.g. camera blocked and no key pressed yet).
  state(): ControlState {
    const { throttle, brake, left, right, drift } = this.keymap;
    const isLeft = this.any(left);
    const isRight = this.any(right);
    let steer = 0;
    if (isLeft && !isRight) steer = -1;
    else if (isRight && !isLeft) steer = 1;
    return {
      steer,
      throttle: this.any(throttle) ? 1 : 0,
      brake: this.any(brake) ? 1 : 0,
      drift: this.any(drift) ? 1 : 0,
      boost: this.boostHeld(),
    };
  }

  sample(now: number): ControlState | null {
    return this.isActive(now) ? this.state() : null;
  }
}
