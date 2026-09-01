import * as THREE from 'three';
import { TUNING } from '../tuning';
import { clamp, damp, lerp } from '../../shared/mathUtils';
import type { ControlState } from '../input/InputSource';

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
  spinTimer: number;
  isAi: boolean;
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
    spinTimer: 0,
    isAi,
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

const SPIN_OUT_YAW_RATE = 10; // rad/s

// §3.2 steps 1-5. `offRoad` (from TrackQuery, |lateral| > ROAD_HALF) applies the
// grass speed cap; boost overrides the cap so a mushroom powers through grass.
// `topSpeedScale` is AI rubber-banding/personality (§3.4 step 5) — applied only
// to the cruise speed cap, never to accel/brake/off-road/boost physics constants.
export function stepKart(
  kart: KartState,
  control: ControlState,
  dt: number,
  offRoad = false,
  topSpeedScale = 1,
) {
  const T = TUNING;

  // 5. Spin-out (Phase 10 items): inputs forced neutral, heading spins, speed
  // decays at brakeDecel. Pre-empts the rest of the step entirely while active.
  if (kart.spinTimer > 0) {
    kart.spinTimer = Math.max(0, kart.spinTimer - dt);
    kart.heading += SPIN_OUT_YAW_RATE * dt;
    kart.speed = moveToward(kart.speed, 0, T.brakeDecel * dt);
    kart.pos.addScaledVector(kartForward(kart.heading), kart.speed * dt);
    return;
  }

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

  if (offRoad && kart.boostTimer <= 0) {
    const cap = T.topSpeed * T.offRoadSpeedCap;
    if (Math.abs(kart.speed) > cap) {
      kart.speed = moveToward(kart.speed, Math.sign(kart.speed) * cap, T.offRoadDecel * dt);
    }
  }

  // 2. Steering
  kart.steerActual = damp(kart.steerActual, control.steer, T.steerRamp, dt);
  const speedFrac = clamp(Math.abs(kart.speed) / T.topSpeed, 0, 1);
  const baseYawRate = lerp(T.steerMaxYawRate, T.steerYawRateAtTop, speedFrac);
  const lowSpeedAuthority = clamp(Math.abs(kart.speed) / 3, 0, 1);
  const yawRate = baseYawRate * lowSpeedAuthority;

  // 3. Drift state machine
  if (kart.drift.phase === 'none') {
    if (control.drift && Math.abs(kart.speed) >= T.driftMinSpeed && Math.abs(kart.steerActual) > 0.25) {
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
