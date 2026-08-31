import { TUNING } from '../tuning';
import { GRASS_HALF } from '../track/trackData';
import type { TrackQuery } from '../track/TrackQuery';
import { angleWrap, clamp } from '../../shared/mathUtils';
import { kartForward, type KartState } from './Kart';

const GLANCING_ANGLE_RAD = (10 * Math.PI) / 180;
const HEADING_ALIGN_FRACTION = 0.6;

// §3.3 kart-vs-wall. Positional lateral-offset clamp (not a raycast) so it
// cannot tunnel even at top speed. Call after Kart.stepKart has integrated
// position for this tick.
export function resolveWallCollision(kart: KartState, trackQuery: TrackQuery) {
  const T = TUNING;
  const q = trackQuery.nearestSample(kart.pos);
  const limit = GRASS_HALF - T.kartRadius;
  const absLateral = Math.abs(q.lateral);

  if (absLateral <= limit) return;

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
    return;
  }

  kart.speed = tangentSpeed * (1 - T.wallSpeedPenalty * Math.abs(Math.sin(impactAngle)));

  // Auto-align heading toward the wall tangent (whichever direction matches
  // current travel) so karts scrape along walls instead of sticking.
  const tangentDir = q.forward.clone();
  if (v.dot(tangentDir) < 0) tangentDir.negate();
  const tangentHeading = Math.atan2(tangentDir.x, tangentDir.z);
  kart.heading += angleWrap(tangentHeading - kart.heading) * HEADING_ALIGN_FRACTION;
}
