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

function moveToward(current: number, target: number, maxDelta: number): number {
  const delta = target - current;
  if (Math.abs(delta) <= maxDelta) return target;
  return current + Math.sign(delta) * maxDelta;
}

// §3.2 steps 1-2 and 4 (longitudinal, steering, integrate). Drift (step 3) and
// spin-out (step 5) land in Phase 4 / Phase 10.
// `offRoad` (from TrackQuery, |lateral| > ROAD_HALF) applies the grass speed cap;
// boost overrides the cap so a mushroom powers through grass.
export function stepKart(kart: KartState, control: ControlState, dt: number, offRoad = false) {
  const T = TUNING;

  // 1. Longitudinal
  if (kart.boostTimer > 0) {
    kart.speed = moveToward(kart.speed, T.topSpeed * T.boostSpeedMult, T.boostAccel * dt);
    kart.boostTimer = Math.max(0, kart.boostTimer - dt);
  } else if (control.throttle) {
    const target = T.topSpeed;
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

  // 4. Integrate (steering flips automatically when reversing via sign(speed))
  kart.heading += yawRate * kart.steerActual * Math.sign(kart.speed) * dt;
  kart.pos.addScaledVector(kartForward(kart.heading), kart.speed * dt);
}
