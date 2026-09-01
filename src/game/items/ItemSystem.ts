import * as THREE from 'three';
import { TUNING } from '../tuning';
import { kartForward, type KartState } from '../physics/Kart';
import type { TrackSample } from '../track/TrackBuilder';
import { sampleAtArcLength } from '../track/TrackQuery';

export type ItemType = 'mushroom' | 'banana' | 'shell';
const ITEM_TYPES: ItemType[] = ['mushroom', 'banana', 'shell'];

export const ITEM_BOX_COUNT = 6;
const ITEM_BOX_RESPAWN_SECONDS = 3;
const ITEM_BOX_PICKUP_RADIUS = 1.5;
const ROULETTE_SECONDS = 1;
const ROULETTE_FLICKER_SECONDS = 0.1;

const BANANA_RADIUS = 1.2;
const BANANA_DROP_DISTANCE = 2;
const BANANA_MAX_PER_KART = 3;

// §v3 Track C2: the banana no longer teleports to its resting spot — it is
// tossed over the kart's tail on a short arc. `BANANA_TOSS_SECONDS` is both
// the flight time AND the arming delay: while `tossTimer > 0` the banana is
// still in the air, so updateBananas skips its collision check entirely (a
// banana must never trip the kart that is in the middle of dropping it).
// `BANANA_TOSS_PEAK` is how high above the straight spawn->rest line the
// render loop bows the parabola. Exported because main.ts's render loop needs
// both to reconstruct the arc for the visual.
export const BANANA_TOSS_SECONDS = 0.35;
export const BANANA_TOSS_PEAK = 0.8;
const BANANA_TOSS_LAUNCH_HEIGHT = 0.7; // how far above the kart's contact patch the banana leaves the driver's hand

// Exported so render/SceneBuilder can normalise `kart.spinTimer` into a 0..1
// progress for the spin-out *visual* (§v3 Track C2) without duplicating the
// duration in a second place that could drift out of sync with this one.
export const SPIN_OUT_SECONDS = 1;
const SPIN_OUT_SPEED_MULT = 0.3;

const SHELL_SPEED = 40;
const SHELL_HIT_RADIUS = 1.5;
const SHELL_LIFETIME_SECONDS = 8;

const AI_ITEM_USE_DELAY_SECONDS = 1.5;
const AI_ITEM_USE_PROBABILITY = 0.7;
const AI_ITEM_REROLL_SECONDS = 0.4;

export interface ItemBoxState {
  sampleIdx: number;
  active: boolean;
  respawnTimer: number;
}

export interface HeldItemState {
  item: ItemType | null;
  rouletteTimer: number; // >0 while the pickup roulette is spinning
  rouletteDisplay: ItemType; // flickering icon shown during roulette
  flickerTimer: number;
  aiUseTimer: number | null; // countdown to next use-roll (AI only; null = no item / player-controlled)
}

export interface Banana {
  // The resting spot, exactly as before — `pos` is authoritative for collision
  // and is re-snapped to the local ground height every tick. During the toss
  // the *visual* is interpolated away from it (main.ts), but the physics
  // object itself never leaves the ground.
  pos: THREE.Vector3;
  ownerIndex: number;
  // §v3 Track C2 toss arc. `spawnFrom` is where the banana left the kart and
  // `tossTimer` counts the flight down from BANANA_TOSS_SECONDS to 0. A banana
  // is "armed" (i.e. can spin somebody out) exactly when `tossTimer <= 0`.
  spawnFrom: THREE.Vector3;
  tossTimer: number;
}

export interface Shell {
  pos: THREE.Vector3;
  s: number;
  ownerIndex: number;
  targetIndex: number;
  age: number;
}

export function createItemBoxes(samples: TrackSample[]): ItemBoxState[] {
  const n = samples.length;
  const boxes: ItemBoxState[] = [];
  for (let i = 0; i < ITEM_BOX_COUNT; i++) {
    boxes.push({ sampleIdx: Math.round((i / ITEM_BOX_COUNT) * n) % n, active: true, respawnTimer: 0 });
  }
  return boxes;
}

export function createHeldItemState(): HeldItemState {
  return { item: null, rouletteTimer: 0, rouletteDisplay: 'mushroom', flickerTimer: 0, aiUseTimer: null };
}

function randomItem(): ItemType {
  return ITEM_TYPES[Math.floor(Math.random() * ITEM_TYPES.length)];
}

export function updateItemBoxes(boxes: ItemBoxState[], dt: number) {
  for (const box of boxes) {
    if (box.active) continue;
    box.respawnTimer -= dt;
    if (box.respawnTimer <= 0) box.active = true;
  }
}

// Checks one kart against all boxes; starts the roulette on pickup.
export function tryPickupItemBox(boxes: ItemBoxState[], samples: TrackSample[], kartPos: THREE.Vector3, held: HeldItemState) {
  if (held.item !== null || held.rouletteTimer > 0) return;
  for (const box of boxes) {
    if (!box.active) continue;
    if (kartPos.distanceTo(samples[box.sampleIdx].pos) < ITEM_BOX_PICKUP_RADIUS) {
      box.active = false;
      box.respawnTimer = ITEM_BOX_RESPAWN_SECONDS;
      held.rouletteTimer = ROULETTE_SECONDS;
      held.flickerTimer = 0;
      return;
    }
  }
}

export function updateRoulette(held: HeldItemState, dt: number) {
  if (held.rouletteTimer <= 0) return;
  held.flickerTimer -= dt;
  if (held.flickerTimer <= 0) {
    held.flickerTimer = ROULETTE_FLICKER_SECONDS;
    held.rouletteDisplay = randomItem();
  }
  held.rouletteTimer -= dt;
  if (held.rouletteTimer <= 0) {
    held.item = randomItem();
  }
}

// Called once a delay/probability roll says "fire now" (player: button rising
// edge; AI: tickAiItemDecision). Returns true if an item was actually used.
export function useItem(args: {
  kartIndex: number;
  kart: KartState;
  held: HeldItemState;
  bananas: Banana[];
  shells: Shell[];
  targetIndex: number | null; // next kart ahead in race order, for shell targeting
  fireS: number; // shooter's current arc-length position, for the shell's start
}): boolean {
  const { kartIndex, kart, held, bananas, shells, targetIndex, fireS } = args;
  if (!held.item) return false;

  if (held.item === 'mushroom') {
    kart.boostTimer = TUNING.boostDurations[1]; // instant tier-2 boost
  } else if (held.item === 'banana') {
    const ownerBananas = bananas.filter((b) => b.ownerIndex === kartIndex);
    if (ownerBananas.length >= BANANA_MAX_PER_KART) {
      bananas.splice(bananas.indexOf(ownerBananas[0]), 1); // oldest makes way for the new one
    }
    const pos = kart.pos.clone().addScaledVector(kartForward(kart.heading), -BANANA_DROP_DISTANCE);
    // §v3 Track C2: the throw starts at the driver's hands (just behind and
    // above the kart's contact patch) and lands on `pos`; `tossTimer` keeps it
    // unarmed for the whole flight.
    const spawnFrom = kart.pos.clone().addScaledVector(kartForward(kart.heading), -0.5);
    spawnFrom.y += BANANA_TOSS_LAUNCH_HEIGHT;
    bananas.push({ pos, ownerIndex: kartIndex, spawnFrom, tossTimer: BANANA_TOSS_SECONDS });
  } else if (held.item === 'shell') {
    if (targetIndex === null) return false; // leading the race: nothing to target, keep holding
    shells.push({ pos: kart.pos.clone(), s: fireS, ownerIndex: kartIndex, targetIndex, age: 0 });
  }

  held.item = null;
  held.aiUseTimer = null;
  return true;
}

function spinOut(kart: KartState) {
  kart.spinTimer = SPIN_OUT_SECONDS;
  kart.speed *= SPIN_OUT_SPEED_MULT;
  kart.drift.phase = 'none';
  kart.drift.charge = 0;
}

// §Phase 5 item 7: `groundHeightAt` re-snaps each stationary banana's y to the
// track height under it every tick -- it doesn't move once dropped, but the
// spot it landed on can still be sloped, and its initial y (copied from the
// dropping kart's pos at throw time) is only an approximation of that.
//
// §v3 Track C2: `dt` is new — it counts the toss timer down. Until it reaches
// zero the banana is mid-air and *unarmed*, so its collision loop is skipped
// entirely. That is the only physics-tick behaviour change in Track C: it also
// happens to fix the long-standing wart where a kart could clip its own
// freshly-dropped banana while reversing into it.
//
// §v3 Track C2 review fix: `collide` splits the two halves apart. The toss
// timer must keep counting down whenever the sim is running, but collisions
// only matter while RACING — main.ts used to gate the whole call on `racing`,
// so a banana thrown in the last third of a second before the race ended froze
// mid-arc and the render loop left it hovering a metre above the track for the
// whole results screen. Now the timer always runs and only the hit test is
// gated, so that banana lands normally (it just can't trip anyone, which is
// moot once the race is over).
export function updateBananas(
  bananas: Banana[],
  karts: KartState[],
  groundHeightAt: (pos: THREE.Vector3) => number,
  dt: number,
  collide: boolean,
) {
  for (let i = bananas.length - 1; i >= 0; i--) {
    const banana = bananas[i];
    banana.pos.y = groundHeightAt(banana.pos);
    if (banana.tossTimer > 0) {
      banana.tossTimer = Math.max(0, banana.tossTimer - dt);
      continue; // still in the air: not armed, cannot spin anybody out yet
    }
    if (!collide) continue;
    for (const kart of karts) {
      if (kart.spinTimer > 0) continue;
      if (kart.pos.distanceTo(banana.pos) < BANANA_RADIUS) {
        spinOut(kart);
        bananas.splice(i, 1);
        break;
      }
    }
  }
}

export function updateShells(
  shells: Shell[],
  karts: KartState[],
  samples: TrackSample[],
  totalLength: number,
  dt: number,
) {
  for (let i = shells.length - 1; i >= 0; i--) {
    const shell = shells[i];
    shell.age += dt;
    shell.s = (shell.s + SHELL_SPEED * dt) % totalLength;
    shell.pos.copy(sampleAtArcLength(samples, totalLength, shell.s).pos);

    const target = karts[shell.targetIndex];
    let hit = false;
    if (target && target.spinTimer <= 0 && shell.pos.distanceTo(target.pos) < SHELL_HIT_RADIUS) {
      spinOut(target);
      hit = true;
    }
    if (hit || shell.age > SHELL_LIFETIME_SECONDS) {
      shells.splice(i, 1);
    }
  }
}

// AI item usage: 1.5s delay after acquiring, then a 70%-per-roll chance,
// re-rolling every ~0.4s until it fires (§Phase 10).
export function tickAiItemDecision(held: HeldItemState, dt: number): boolean {
  if (!held.item) {
    held.aiUseTimer = null;
    return false;
  }
  if (held.aiUseTimer === null) held.aiUseTimer = AI_ITEM_USE_DELAY_SECONDS;
  held.aiUseTimer -= dt;
  if (held.aiUseTimer > 0) return false;
  held.aiUseTimer = AI_ITEM_REROLL_SECONDS;
  return Math.random() < AI_ITEM_USE_PROBABILITY;
}
