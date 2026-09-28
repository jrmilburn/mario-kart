import type { InputSnapshot, SteerMode } from '../../shared/protocol';
import type { ControlProvider, ControlSourceKind, ControlState } from './ControlProvider';
import { KeyboardProvider, KEYMAP_P1, KEYMAP_P2, type Keymap } from './KeyboardProvider';
import { PhoneProvider } from './PhoneProvider';

export type { ControlState, ControlSourceKind } from './ControlProvider';
export { KEYMAP_P1, KEYMAP_P2, type Keymap };

export interface InputDiagnostics {
  source: ControlSourceKind;
  steerMode: SteerMode | null;
  seq: number | null;
  ageMs: number | null;
}

// §v5: one player's merged input. Priority, highest first:
//   1. the keyboard, while "active" (2s after a mapped override key, D12) —
//      a deliberate human override always wins;
//   2. each `primary` provider in order (P1: hands; P2: phone);
//   3. otherwise the keyboard's plain state, reported as 'keyboard' — that is
//      what a player with a blocked camera / no phone is actually on.
// Keyboard boost keys are ORed into whichever source wins (see
// KeyboardProvider.attach for why they never count as activity). Drift keys
// are ORed in the same way EXCEPT when the winning source is 'hands' — hands
// never drift, so a hands player resting a hand on Shift must not drift.
export class InputSource {
  readonly keyboard: KeyboardProvider;
  private primaries: ControlProvider[];
  private phone: PhoneProvider | null;

  constructor(keymap: Keymap, primaries: ControlProvider[] = []) {
    this.keyboard = new KeyboardProvider(keymap);
    this.primaries = primaries;
    this.phone = (primaries.find((p) => p instanceof PhoneProvider) as PhoneProvider | undefined) ?? null;
  }

  attachKeyboard() {
    this.keyboard.attach();
  }

  // Snapshots for a player with no phone provider (P1) are dropped.
  onSnapshot(snapshot: InputSnapshot) {
    this.phone?.onSnapshot(snapshot);
  }

  isKeyboardActive(now: number): boolean {
    return this.keyboard.isActive(now);
  }

  // Which source would drive right now — side-effect free, for HUD labels.
  activeKind(now: number = performance.now()): ControlSourceKind {
    if (this.keyboard.isActive(now)) return 'keyboard';
    for (const p of this.primaries) if (p.isActive(now)) return p.kind;
    return 'keyboard';
  }

  // Call exactly once per physics tick per player: the hand provider's
  // smoothing and one-shot thumbs-up boost advance on each call.
  sample(now: number = performance.now()): ControlState {
    let winner: ControlState | null = this.keyboard.sample(now);
    let winnerKind: ControlSourceKind = 'keyboard';
    for (const p of this.primaries) {
      // Every primary is sampled even when outranked, so its filters stay warm
      // and a hand→keyboard→hand handover doesn't resume from stale state.
      const s = p.sample(now);
      if (!winner && s) {
        winner = s;
        winnerKind = p.kind;
      }
    }
    const control = winner ? { ...winner } : this.keyboard.state();
    if (this.keyboard.boostHeld()) control.boost = 1;
    // Hands never drift — don't let a Shift key someone rests a hand on (or
    // habitually reaches for) drift a hands-driven kart.
    if (this.keyboard.driftHeld() && winnerKind !== 'hands') control.drift = 1;
    return control;
  }

  // Raw phone snapshot age, independent of keyboard override — used by
  // RaceDirector's pause-on-disconnect watchdog (§3.6). Always null for a
  // player without a phone provider, so hands/keyboard seats never pause.
  rawControllerAgeMs(now: number = performance.now()): number | null {
    return this.phone ? this.phone.ageMs(now) : null;
  }

  diagnostics(now: number = performance.now()): InputDiagnostics {
    const source = this.activeKind(now);
    const snap = this.phone?.latestSnapshot ?? null;
    return {
      source,
      steerMode: source === 'phone' && snap ? snap.steerMode : null,
      seq: snap?.seq ?? null,
      ageMs: this.phone ? this.phone.ageMs(now) : null,
    };
  }
}
