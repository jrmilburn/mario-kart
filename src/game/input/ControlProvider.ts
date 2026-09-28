// §v5 input pipeline: every input device is a ControlProvider, and a player's
// InputSource merges an ordered list of them (see InputSource.ts). Kept free
// of DOM/three imports so the pure gesture code and node tests can share it.

export interface ControlState {
  steer: number; // -1 (full left) .. +1 (full right)
  throttle: 0 | 1;
  brake: 0 | 1;
  drift: 0 | 1;
  // §v5: manual boost request. A *held* level, not an edge — the kart itself
  // fires on the rising edge and owns the cooldown (physics/Kart.ts), so every
  // source (hands, phone, keyboard, AI) is rate-limited by the same rule.
  boost: 0 | 1;
}

export const NEUTRAL_CONTROL: Readonly<ControlState> = { steer: 0, throttle: 0, brake: 0, drift: 0, boost: 0 };

export type ControlSourceKind = 'hands' | 'phone' | 'keyboard';

export interface ControlProvider {
  readonly kind: ControlSourceKind;
  // Side-effect free: does this provider have an opinion right now? Must agree
  // with sample()'s null-ness, so the HUD can label the live source without
  // advancing any provider's filters.
  isActive(now: number): boolean;
  // null = no opinion right now (the merger falls through to the next one).
  sample(now: number): ControlState | null;
}
