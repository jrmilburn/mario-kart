import * as THREE from 'three';
import { TUNING } from '../tuning';
import { clamp, damp, lerp } from '../../shared/mathUtils';
import type { ControlState } from '../input/ControlProvider';
import type { SurfaceType } from '../track/trackData';

export interface DriftState {
  phase: 'none' | 'active';
  dir: -1 | 1;
  charge: number; // seconds held
}

export interface KartState {
  pos: THREE.Vector3;
  heading: number; // yaw, radians
  speed: number; // signed scalar along heading
  velLateral: number; // outward slip during drift (Phase 4)
  steerActual: number; // damped steer, drives visuals + yaw
  drift: DriftState;
  boostTimer: number;
  isAi: boolean;
  // §v5 manual boost: seconds until the next one may fire, and last tick's
  // boost input for rising-edge detection.
  boostCooldown: number;
  prevBoostInput: 0 | 1;
  // §v5 jump: vertical state, integrated by physics/Airborne.ts stepVertical
  // (never by stepKart, which stays 2D). landingVy is the (negative) vertical
  // speed at the last touchdown, for squash intensity.
  vy: number;
  airborne: boolean;
  airTime: number;
  landingVy: number;
}

export function createKart(pos: THREE.Vector3, heading = 0, isAi = false): KartState {
  return {
    pos: pos.clone(),
    heading,
    speed: 0,
    velLateral: 0,
    steerActual: 0,
    drift: { phase: 'none', dir: 1, charge: 0 },
    boostTimer: 0,
    isAi,
    boostCooldown: 0,
    prevBoostInput: 0,
    // §v5 jump
    vy: 0,
    airborne: false,
    airTime: 0,
    landingVy: 0,
  };
}

// Kart's local "nose" points toward +Z; rotating the mesh by `heading` around Y
// yields this exact world-forward vector (see render/SceneBuilder.ts).
export function kartForward(heading: number): THREE.Vector3 {
  return new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading));
}

// Driver's right hand when facing `heading` (up x forward, matching TrackBuilder's convention).
export function kartRight(heading: number): THREE.Vector3 {
  return new THREE.Vector3(Math.cos(heading), 0, -Math.sin(heading));
}

function moveToward(current: number, target: number, maxDelta: number): number {
  const delta = target - current;
  if (Math.abs(delta) <= maxDelta) return target;
  return current + Math.sign(delta) * maxDelta;
}

const SLIP_DECAY_SECONDS = 0.3;

export function driftTier(charge: number): number {
  let tier = 0;
  for (let i = 0; i < TUNING.driftTierTimes.length; i++) {
    if (charge >= TUNING.driftTierTimes[i]) tier = i + 1;
  }
  return tier;
}

// §3.2 steps 1-4. `offRoad` (from TrackQuery, on the verge and not on dirt)
// applies the grass speed cap; boost overrides the cap so a boost powers
// through grass.
// `topSpeedScale` is AI rubber-banding/personality (§3.4 step 5) — applied only
// to the cruise speed cap, never to accel/brake/off-road/boost physics constants.
// `surface` (§Phase 4 item 4, from TrackQuery.surfaceUnder) layers a track-authored
// surface zone on top: 'boost' tops up boostTimer like a manual boost,
// 'sand' forces the off-road speed cap even when technically within ROAD_HALF.
export function stepKart(
  kart: KartState,
  control: ControlState,
  dt: number,
  offRoad = false,
  topSpeedScale = 1,
  surface: SurfaceType | null = null,
) {
  const T = TUNING;

  // §v5 manual boost, fired on the input's rising edge and rate-limited here —
  // in the kart, not in any input source — so hands, phone, keyboard and any
  // future source all obey the same cooldown.
  kart.boostCooldown = Math.max(0, kart.boostCooldown - dt);
  const boostPressed = control.boost === 1 && kart.prevBoostInput === 0;
  kart.prevBoostInput = control.boost;
  if (boostPressed && kart.boostCooldown <= 0) {
    kart.boostTimer = Math.max(kart.boostTimer, T.manualBoostDuration);
    kart.boostCooldown = T.boostCooldown;
  }

  // §v5 jump: nothing on the ground acts on a kart in the air — no pad, no
  // grass/sand/dirt drag (it is judged again the tick it lands).
  if (kart.airborne) {
    offRoad = false;
    surface = null;
  }

  // 0. Boost-pad surface zone: tops up (never shortens) the same boostTimer a
  // manual boost or a tiered drift release would set.
  if (surface === 'boost') {
    kart.boostTimer = Math.max(kart.boostTimer, T.padBoostDuration);
  }
  const effectiveOffRoad = offRoad || surface === 'sand' || surface === 'dirt';

  // 1. Longitudinal
  if (kart.boostTimer > 0) {
    kart.speed = moveToward(kart.speed, T.topSpeed * T.boostSpeedMult, T.boostAccel * dt);
    kart.boostTimer = Math.max(0, kart.boostTimer - dt);
  } else if (control.throttle) {
    const target = T.topSpeed * topSpeedScale;
    const rate = kart.speed > target ? T.coastDecel : T.accel;
    kart.speed = moveToward(kart.speed, target, rate * dt);
  } else if (control.brake) {
    if (kart.speed > 0.5) {
      kart.speed = moveToward(kart.speed, 0, T.brakeDecel * dt);
    } else {
      kart.speed = moveToward(kart.speed, -T.reverseTopSpeed, T.accel * 0.7 * dt);
    }
  } else {
    kart.speed = moveToward(kart.speed, 0, T.coastDecel * dt);
  }

  if (effectiveOffRoad && kart.boostTimer <= 0) {
    // §Phase 4 finding #1: sand is mechanically distinct from plain grass —
    // a lower cap and a stronger decel, not just the same offRoad penalty.
    // §v5 shortcut: the dirt track is rough (slower than tarmac, kinder than
    // grass) unless boosting — the boostTimer guard above already exempts it.
    const capFrac = surface === 'sand' ? T.sandSpeedCap : surface === 'dirt' ? T.dirtSpeedCap : T.offRoadSpeedCap;
    const decel = surface === 'sand' ? T.sandDecel : surface === 'dirt' ? T.dirtDecel : T.offRoadDecel;
    const cap = T.topSpeed * capFrac;
    if (Math.abs(kart.speed) > cap) {
      kart.speed = moveToward(kart.speed, Math.sign(kart.speed) * cap, decel * dt);
    }
  }

  // 2. Steering
  kart.steerActual = damp(kart.steerActual, control.steer, T.steerRamp, dt);
  const speedFrac = clamp(Math.abs(kart.speed) / T.topSpeed, 0, 1);
  const baseYawRate = lerp(T.steerMaxYawRate, T.steerYawRateAtTop, speedFrac);
  const lowSpeedAuthority = clamp(Math.abs(kart.speed) / 3, 0, 1);
  // §v5 jump: only a little steering authority in the air (no tyre grip).
  const yawRate = baseYawRate * lowSpeedAuthority * (kart.airborne ? T.airSteerAuthority : 1);

  // 3. Drift state machine
  if (kart.drift.phase === 'none') {
    if (control.drift && !kart.airborne && Math.abs(kart.speed) >= T.driftMinSpeed && Math.abs(kart.steerActual) > 0.25) {
      kart.drift.phase = 'active';
      kart.drift.dir = (Math.sign(kart.steerActual) || 1) as -1 | 1;
      kart.drift.charge = 0;
    }
  } else if (Math.abs(kart.speed) < T.driftMinSpeed) {
    // Cancelled: charge discarded, no boost.
    kart.drift.phase = 'none';
    kart.drift.charge = 0;
  } else if (!control.drift) {
    // Released: award a boost if a tier was reached.
    const tier = driftTier(kart.drift.charge);
    if (tier >= 1) kart.boostTimer = T.boostDurations[tier - 1];
    kart.drift.phase = 'none';
    kart.drift.charge = 0;
  } else {
    kart.drift.charge += dt;
  }

  let angularVelocity: number;
  if (kart.drift.phase === 'active') {
    const dir = kart.drift.dir;
    angularVelocity = yawRate * T.driftYawBonus * dir * (1 + kart.steerActual * dir * T.driftCounterRange);
    kart.velLateral = -dir * T.driftLateralSlip;
  } else {
    angularVelocity = yawRate * kart.steerActual * Math.sign(kart.speed);
    kart.velLateral = moveToward(kart.velLateral, 0, (T.driftLateralSlip / SLIP_DECAY_SECONDS) * dt);
  }

  // 4. Integrate (steering flips automatically when reversing via sign(speed))
  kart.heading += angularVelocity * dt;
  kart.pos.addScaledVector(kartForward(kart.heading), kart.speed * dt);
  kart.pos.addScaledVector(kartRight(kart.heading), kart.velLateral * dt);
}
