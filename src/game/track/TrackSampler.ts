import * as THREE from 'three';
import type { TrackSample } from './TrackBuilder';

// Shared by rendering and layout validation: no canvas or browser dependency.
export const SAMPLE_COUNT = 600;
const RAW_SAMPLE_COUNT = 2000;
const UP = new THREE.Vector3(0, 1, 0);
const MAX_SAMPLE_GRADE = 0.12;

function findIndexForS(cum: number[], targetS: number): number {
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] < targetS) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function buildSamples(
  controlPoints: readonly (readonly [number, number, number])[],
): { samples: TrackSample[]; totalLength: number } {
  // §v4: control points arrive as plain tuples so maps.ts can stay free of
  // three.js (the start menu imports it); they become Vector3s here, at the
  // one place that actually builds the curve.
  const points = controlPoints.map(([x, y, z]) => new THREE.Vector3(x, y, z));
  const curve = new THREE.CatmullRomCurve3(points, true, 'centripetal');
  const raw = curve.getPoints(RAW_SAMPLE_COUNT);

  const cum: number[] = [0];
  for (let i = 1; i < raw.length; i++) {
    cum.push(cum[i - 1] + raw[i].distanceTo(raw[i - 1]));
  }
  const totalLength = cum[cum.length - 1];

  const samples: TrackSample[] = [];
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    const targetS = (i / SAMPLE_COUNT) * totalLength;
    const idx = findIndexForS(cum, targetS);
    samples.push({ pos: raw[idx].clone(), s: targetS, forward: new THREE.Vector3(), right: new THREE.Vector3(), grade: 0 });
  }

  // forward/right computed from neighbor samples once all positions are known.
  // NOTE: our kart heading convention is forward = (sin(h), 0, cos(h)) (see
  // physics/Kart.ts kartForward), for which "driver's right" is up x forward
  // (not forward x up as it would be for a forward = (0,0,-1)-at-rest convention).
  // §Phase 5 item 2: `forward` is taken from the full 3D neighbor positions
  // (so it carries the local grade), but `right` is explicitly built from
  // forward's *horizontal* projection so it stays perfectly level (no
  // banking, out of scope) regardless of slope -- banking would otherwise
  // creep in because UP x forward's magnitude depends on forward's pitch even
  // though its direction happens to already be horizontal.
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    const prev = samples[(i - 1 + SAMPLE_COUNT) % SAMPLE_COUNT].pos;
    const next = samples[(i + 1) % SAMPLE_COUNT].pos;
    const forward = next.clone().sub(prev).normalize();
    const horizontalForward = new THREE.Vector3(forward.x, 0, forward.z).normalize();
    samples[i].forward = forward;
    samples[i].right = UP.clone().cross(horizontalForward).normalize();
    samples[i].grade = forward.y;
  }

  checkGradeSafety(samples, totalLength);

  return { samples, totalLength };
}

// §Phase 5 item 1: a cheap one-time startup sanity check on the authored
// heights -- warns (doesn't throw) if the Catmull-Rom-smoothed per-sample
// slope ever exceeds the ~10% grade budget by a meaningful margin, catching
// an over-steep control-point edit before it ships. Runs unconditionally
// (it's O(n) over the sample count, once, at track build time -- not worth
// gating behind a dev-only flag). Wrap-aware at the start/finish seam.
function checkGradeSafety(samples: TrackSample[], totalLength: number) {
  const n = samples.length;
  for (let i = 0; i < n; i++) {
    const a = samples[i];
    const b = samples[(i + 1) % n];
    const dy = b.pos.y - a.pos.y;
    let ds = b.s - a.s;
    if (ds <= 0) ds += totalLength; // wrap at the seam (n-1 -> 0)
    const grade = ds > 0 ? Math.abs(dy / ds) : 0;
    if (grade > MAX_SAMPLE_GRADE) {
      console.warn(
        `[trackData] adjacent-sample grade ${grade.toFixed(3)} exceeds ${MAX_SAMPLE_GRADE} budget near s=${a.s.toFixed(1)}m`,
      );
    }
  }
}
