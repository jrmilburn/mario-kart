import * as THREE from 'three';
import type { PlayerSlot } from '../../shared/protocol';
import type { ControlProvider } from '../input/ControlProvider';
import { InputSource, KEYMAP_P1, KEYMAP_P2 } from '../input/InputSource';
import { FollowCamera } from '../render/FollowCamera';

const KEYMAP_BY_SLOT: Record<PlayerSlot, typeof KEYMAP_P1> = {
  0: KEYMAP_P1,
  1: KEYMAP_P2,
};

// One human seat: a controller slot paired with the kart entity it drives,
// its own input source/keymap, and its own camera rig. `connected` tracks the
// live controller-joined/left peer state; `active` is the roster decision
// (locked at countdown, Phase 2b) that decides whether `entityIndex` is
// actually driven by this player's input this race, vs. falling back to AI.
export interface Player {
  slot: PlayerSlot;
  entityIndex: number;
  inputSource: InputSource;
  camera: THREE.PerspectiveCamera;
  followCamera: FollowCamera;
  connected: boolean;
  active: boolean;
}

// P1 (slot 0) is the mandatory, always-active player — entity 0 is always
// human-capable-only, exactly matching v1's single-player behavior. P2 (slot
// 1) starts inactive; RaceDirector's countdown lock decides whether it drives
// entity 1 for the upcoming race (see main.ts's roster-lock logic).
// §v5: `primaries` are this seat's non-keyboard providers in priority order
// (P1: hands; P2: phone) — see InputSource for how they merge with the keyboard.
export function createPlayer(
  slot: PlayerSlot,
  entityIndex: number,
  groundHeightAt: (pos: THREE.Vector3) => number,
  primaries: ControlProvider[] = [],
): Player {
  // §v3 polish: far plane 1000 -> 1500. The new mountain rings stand well
  // beyond the circuit, and a camera on the far side of the track from the
  // furthest peak is ~950m away from it — inside 1000 only by a hair, and
  // clipped outright if the rings ever move. `near` is untouched, so depth
  // precision at kart range is unchanged.
  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1500);
  return {
    slot,
    entityIndex,
    inputSource: new InputSource(KEYMAP_BY_SLOT[slot], primaries),
    camera,
    followCamera: new FollowCamera(camera, groundHeightAt),
    connected: false,
    active: slot === 0,
  };
}
