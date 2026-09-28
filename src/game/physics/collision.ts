import * as THREE from 'three';
import { TUNING } from '../tuning';
import type { TrackQuery } from '../track/TrackQuery';
import { angleWrap, clamp } from '../../shared/mathUtils';
import { kartForward, type KartState } from './Kart';

const GLANCING_ANGLE_RAD = (10 * Math.PI) / 180;
const HEADING_ALIGN_FRACTION = 0.6;
const KART_KART_EXTRA_SEPARATION_MPS = 1.5; // "1.5 m/s position push" for side contact

// §3.3 kart-vs-wall. Positional lateral-offset clamp (not a raycast) so it
// cannot tunnel even at top speed. Call after Kart.stepKart has integrated
// position for this tick. Returns true for a non-glancing hit (used to fire
// the §Phase 11d collision haptic) — a glancing scrape doesn't count.
//
// §v5 shortcut: the drivable region is the union of the main corridor and the
// shortcut corridor. nearestSample already decides which one the kart is in
// (or, outside both, which one it should be pushed back into) and reports that
// corridor's lateral/right and its wall half-width, so this clamp is unchanged
// apart from reading the limit from the query instead of assuming GRASS_HALF.
// Where the shortcut crosses the main wall line the kart is legal on the
// shortcut, so the main wall simply isn't there — that is the opening.
export function resolveWallCollision(kart: KartState, trackQuery: TrackQuery): boolean {
  const T = TUNING;
  const q = trackQuery.nearestSample(kart.pos);
  const limit = q.wallHalf - T.kartRadius;
  const absLateral = Math.abs(q.lateral);

  if (absLateral <= limit) return false;

  const sign = Math.sign(q.lateral);
  kart.pos.addScaledVector(q.right, -(absLateral - limit) * sign);

  // Any wall contact cancels an in-progress drift charge (no boost) — §3.2 step 3.
  kart.drift.phase = 'none';
  kart.drift.charge = 0;

  const v = kartForward(kart.heading).multiplyScalar(kart.speed);
  const vNormalMag = v.dot(q.right);
  const vTangential = v.clone().addScaledVector(q.right, -vNormalMag);
  const tangentSpeed = vTangential.length();
  const speedMag = Math.max(v.length(), 0.001);
  const impactAngle = Math.abs(Math.asin(clamp(vNormalMag / speedMag, -1, 1)));

  if (impactAngle < GLANCING_ANGLE_RAD) {
    // Glancing scrape: position clamp only, no speed/heading penalty.
    return false;
  }

  kart.speed = tangentSpeed * (1 - T.wallSpeedPenalty * Math.abs(Math.sin(impactAngle)));

  // Auto-align heading toward the wall tangent (whichever direction matches
  // current travel) so karts scrape along walls instead of sticking.
  const tangentDir = q.forward.clone();
  if (v.dot(tangentDir) < 0) tangentDir.negate();
  const tangentHeading = Math.atan2(tangentDir.x, tangentDir.z);
  kart.heading += angleWrap(tangentHeading - kart.heading) * HEADING_ALIGN_FRACTION;
  return true;
}

// §3.3 kart-vs-kart. Positions only; heading is never touched (arcade karts
// bump, they don't ragdoll). No drift cancel here — only walls cancel drift.
// Returns the indices of karts that took a real impulse this tick (used to
// fire the §Phase 11d collision haptic) — separating contact doesn't count.
export function resolveKartKartCollisions(karts: KartState[], dt: number): Set<number> {
  const T = TUNING;
  const minDist = 2 * T.kartRadius;
  const hitIndices = new Set<number>();

  for (let i = 0; i < karts.length; i++) {
    for (let j = i + 1; j < karts.length; j++) {
      const a = karts[i];
      const b = karts[j];

      const delta = new THREE.Vector3().subVectors(b.pos, a.pos);
      delta.y = 0;
      const dist = delta.length();
      if (dist >= minDist) continue;

      const normal = dist > 1e-6 ? delta.multiplyScalar(1 / dist) : new THREE.Vector3(1, 0, 0);
      const penetration = minDist - dist;

      // Separate along the center line by half the penetration each, plus a
      // small continuous push so side contact visibly nudges both apart.
      const separation = penetration / 2 + KART_KART_EXTRA_SEPARATION_MPS * dt;
      a.pos.addScaledVector(normal, -separation);
      b.pos.addScaledVector(normal, separation);

      const va = kartForward(a.heading).multiplyScalar(a.speed);
      const vb = kartForward(b.heading).multiplyScalar(b.speed);
      const vaNormal = va.dot(normal);
      const vbNormal = vb.dot(normal);

      if (vaNormal - vbNormal <= 0) continue; // separating already, no impulse needed

      // Exchange 50% of the normal component (equal masses): both end up at
      // the average normal speed, i.e. a shunts b forward and slows itself.
      const avgNormal = (vaNormal + vbNormal) / 2;
      const newVa = va.clone().addScaledVector(normal, avgNormal - vaNormal);
      const newVb = vb.clone().addScaledVector(normal, avgNormal - vbNormal);
      a.speed = newVa.dot(kartForward(a.heading));
      b.speed = newVb.dot(kartForward(b.heading));
      hitIndices.add(i);
      hitIndices.add(j);
    }
  }

  return hitIndices;
}
