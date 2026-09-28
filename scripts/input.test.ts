import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { createKart, stepKart } from '../src/game/physics/Kart';
import { TUNING } from '../src/game/tuning';
import { NEUTRAL_CONTROL, type ControlProvider, type ControlState } from '../src/game/input/ControlProvider';
import { InputSource, KEYMAP_P1 } from '../src/game/input/InputSource';
import { KeyboardProvider, KEYMAP_P2 } from '../src/game/input/KeyboardProvider';
import { PhoneProvider } from '../src/game/input/PhoneProvider';
import { isInputSnapshot, type InputSnapshot } from '../src/shared/protocol';
import { HandProvider } from '../src/game/input/HandProvider';
import type { HandTracker } from '../src/game/hands/HandTracker';
import type { RawHand } from '../src/game/hands/gestures';

// KeyboardProvider.attach() wires real `window` keydown/keyup listeners; these
// tests drive the keysDown state directly instead, the same way a real
// keydown/keyup pair would, so they run under node:test with no DOM.
function press(kp: KeyboardProvider, code: string) {
  (kp as unknown as { keysDown: Set<string> }).keysDown.add(code);
}
function release(kp: KeyboardProvider, code: string) {
  (kp as unknown as { keysDown: Set<string> }).keysDown.delete(code);
}
// KeyboardProvider only counts a press as "activity" (starting the 2s
// override window) via its own keydown listener, which these tests bypass —
// mirror it explicitly where a test needs the post-release grace window.
function pressAsActivity(kp: KeyboardProvider, code: string, now: number) {
  press(kp, code);
  (kp as unknown as { lastActivityAt: number }).lastActivityAt = now;
}

const DT = 1 / 60;

test('manual boost fires on the rising edge only, rate-limited by the kart', () => {
  const kart = createKart(new THREE.Vector3());
  const held: ControlState = { ...NEUTRAL_CONTROL, throttle: 1, boost: 1 };
  const off: ControlState = { ...NEUTRAL_CONTROL, throttle: 1 };

  stepKart(kart, held, DT);
  assert.ok(Math.abs(kart.boostTimer - (TUNING.manualBoostDuration - DT)) < 1e-9, 'fires on the press');
  assert.ok(kart.boostCooldown > 0);

  for (let i = 0; i < 120; i++) stepKart(kart, held, DT);
  assert.equal(kart.boostTimer, 0, 'holding does not refire');

  stepKart(kart, off, DT);
  stepKart(kart, held, DT);
  assert.equal(kart.boostTimer, 0, 'a new press inside the cooldown is swallowed');

  for (let t = 0; t < TUNING.boostCooldown; t += DT) stepKart(kart, off, DT);
  stepKart(kart, held, DT);
  assert.ok(kart.boostTimer > 0, 'fires again once the cooldown has elapsed');
});

class FakeProvider implements ControlProvider {
  readonly kind = 'hands' as const;
  constructor(public live: boolean, public state: ControlState) {}
  isActive() {
    return this.live;
  }
  sample() {
    return this.live ? this.state : null;
  }
}

test('merger: primary wins while live, keyboard is the fallback kind', () => {
  const hands = new FakeProvider(true, { ...NEUTRAL_CONTROL, steer: 0.5, throttle: 1 });
  const src = new InputSource(KEYMAP_P1, [hands]);
  assert.equal(src.activeKind(0), 'hands');
  assert.equal(src.sample(0).steer, 0.5);
  hands.live = false; // camera blocked / MediaPipe failed
  assert.equal(src.activeKind(0), 'keyboard');
  assert.deepEqual(src.sample(0), NEUTRAL_CONTROL);
  assert.equal(src.rawControllerAgeMs(0), null, 'no phone provider on this seat (P1 is hands-only)');
});

test('protocol: InputSnapshot carries boost, not item', () => {
  const base = { type: 'input', seq: 1, steer: 0, throttle: 1, brake: 0, drift: 0, steerMode: 'tilt' };
  assert.equal(isInputSnapshot({ ...base, boost: 1 }), true);
  assert.equal(isInputSnapshot({ ...base, item: 1 }), false);
});

// §stage2 defect fix: KeyboardProvider.isActive() used to be purely
// time-based (< 2s since the last mapped keydown) — a key HELD longer than
// 2s (the ordinary case of holding W through a straight) read as "inactive"
// the instant the window lapsed, even though the key never came up.
test('keyboard is active while a mapped non-boost key is HELD, or within 2s of the last one', () => {
  const kp = new KeyboardProvider(KEYMAP_P2);

  pressAsActivity(kp, 'ArrowUp', 0);
  assert.ok(kp.isActive(0));
  // Still held 5s later — well past the 2s window — must still read active.
  assert.ok(kp.isActive(5000), 'a key held past the 2s window is still active');

  release(kp, 'ArrowUp');
  (kp as unknown as { lastActivityAt: number }).lastActivityAt = 5000; // keyup doesn't move this; simulate the release moment
  assert.ok(kp.isActive(5000 + 1999), 'within 2s of release, still active');
  assert.ok(!kp.isActive(5000 + 2001), 'more than 2s after release, inactive');

  // A boost key alone (Enter/Slash for P2) never counts as activity — holding
  // only BOOST must not flip this seat onto the keyboard.
  const kp2 = new KeyboardProvider(KEYMAP_P2);
  press(kp2, 'Enter');
  assert.ok(!kp2.isActive(0), 'boost-only holds are not "activity"');
});

// §stage2 defect fix: BOOST is sent as a held level sampled once per 30Hz
// snapshot; a tap shorter than one send interval — or one overwritten by a
// newer snapshot before the physics tick ever samples it — used to vanish
// entirely. The latch makes sure the rising edge always reaches the kart at
// least once.
test('PhoneProvider latches a boost rising edge until a sample consumes it', () => {
  const snap = (seq: number, boost: 0 | 1): InputSnapshot => ({
    type: 'input',
    seq,
    steer: 0,
    throttle: 1,
    brake: 0,
    drift: 0,
    boost,
    steerMode: 'touch',
  });

  const p = new PhoneProvider();
  p.onSnapshot(snap(1, 1)); // a tap...
  p.onSnapshot(snap(2, 0)); // ...released before anything ever sampled it
  const c1 = p.sample(0);
  assert.equal(c1?.boost, 1, 'the rising edge is latched even though the LATEST snapshot already reads 0');

  const c2 = p.sample(1);
  assert.equal(c2?.boost, 0, 'consumed — does not keep re-firing on every subsequent sample');

  // A snapshot that never had boost=1 never latches anything.
  const p2 = new PhoneProvider();
  p2.onSnapshot(snap(1, 0));
  assert.equal(p2.sample(0)?.boost, 0);
});

// §defect-fix (item 1): Shift used to count as "keyboard activity" just like
// any other mapped key, so a hands player resting a hand on Shift (or
// habitually reaching for the drift key) got yanked onto the keyboard for 2s
// with steer/throttle 0 — losing hand control mid-corner. Drift keys must
// behave like boost keys (never "activity"), and — since hands never drift —
// must NOT be ORed into a hands-driven kart the way boost is.
test('drift key never steals control from a hands player, but still drifts a keyboard player', () => {
  const hands = new FakeProvider(true, { ...NEUTRAL_CONTROL, steer: 0.5, throttle: 1 });
  const src = new InputSource(KEYMAP_P1, [hands]);

  press(src.keyboard, 'ShiftLeft'); // held, no other key
  const c = src.sample(0);
  assert.equal(src.activeKind(0), 'hands', 'Shift alone must not flip the source off hands');
  assert.equal(c.drift, 0, 'hands never drift, even with the drift key physically held');
  assert.equal(c.steer, 0.5, 'hand steering is untouched');
  assert.equal(c.throttle, 1, 'hand throttle is untouched');

  release(src.keyboard, 'ShiftLeft');
  hands.live = false; // camera blocked -> falls through to keyboard

  // Now drive keyboard directly: W (activity) + Shift should drift normally.
  pressAsActivity(src.keyboard, 'KeyW', 0);
  press(src.keyboard, 'ShiftLeft');
  const c2 = src.sample(0);
  assert.equal(src.activeKind(0), 'keyboard');
  assert.equal(c2.drift, 1, 'a keyboard-driven seat still drifts on Shift');
});

test('drift key alone is not "keyboard activity" (mirrors the existing boost-only check)', () => {
  const kp = new KeyboardProvider(KEYMAP_P1);
  press(kp, 'ShiftLeft');
  assert.ok(!kp.isActive(0), 'drift-only holds are not "activity"');
  assert.equal(kp.driftHeld(), 1);
});

// v6 hand mapping through the real HandProvider + InputSource merger: fists
// are GAS, and the hands seat never drifts (drift=0 always, even at full
// lock) — drift stays a keyboard/phone input.
test('hands seat: fists = gas, full lock never drifts, through the merger', () => {
  type Det = { t: number; hands: RawHand[]; videoW: number; videoH: number };
  let emit: (d: Det) => void = () => {};
  const tracker = { live: true, onDetection: (fn: (d: Det) => void) => (emit = fn) };
  const hp = new HandProvider(tracker as unknown as HandTracker);
  const src = new InputSource(KEYMAP_P1, [hp]);

  // A curled synthetic hand (openness ~0.3, thumb tucked) at a raw wrist x/y.
  const fist = (x: number, y: number, label: 'Left' | 'Right'): RawHand => {
    const world = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));
    world[5] = { x: -0.03, y: -0.085, z: 0 };
    world[9] = { x: -0.01, y: -0.09, z: 0 };
    world[13] = { x: 0.01, y: -0.085, z: 0 };
    world[17] = { x: 0.03, y: -0.075, z: 0 };
    const cy = (-0.085 - 0.09 - 0.085 - 0.075) / 5;
    for (const i of [8, 12, 16, 20]) world[i] = { x: 0, y: cy - 0.027, z: 0 };
    world[4] = { x: -0.045, y: cy, z: 0 };
    return { landmarks: Array.from({ length: 21 }, () => ({ x, y })), worldLandmarks: world, label };
  };
  // Right wrist far lower than the left: well past full lock.
  const hands = [fist(0.7, 0.2, 'Right'), fist(0.3, 0.8, 'Left')];

  let maxDrift = 0;
  let last = src.sample(0);
  for (let t = 0; t < 1500; t += 1000 / 60) {
    emit({ t, hands, videoW: 640, videoH: 480 });
    last = src.sample(t);
    maxDrift = Math.max(maxDrift, last.drift);
  }
  assert.equal(src.activeKind(1500), 'hands');
  assert.equal(last.throttle, 1, 'fists = gas');
  assert.equal(last.brake, 0);
  assert.ok(last.steer > 0.97, `full lock: ${last.steer}`);
  assert.equal(maxDrift, 0, 'hands never drift');
});
