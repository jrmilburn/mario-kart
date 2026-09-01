import * as THREE from 'three';
import type { TrackSample } from './TrackBuilder';
import { SURFACE_ZONES, type SurfaceZone } from './trackData';

const CELL_SIZE = 8;

export interface TrackQueryResult {
  s: number;
  lateral: number; // signed; |lateral| > ROAD_HALF -> grass, >= GRASS_HALF - kartRadius -> wall
  sampleIdx: number;
  right: THREE.Vector3;
  forward: THREE.Vector3;
  groundY: number; // §Phase 5 item 3: track height interpolated along the winning x/z-projected segment
  grade: number; // §Phase 5 item 3: nearest sample's grade (dy/ds) -- cheap, no extra query
}

interface SegmentProjection {
  s: number;
  distSq: number; // §Phase 5 item 3: x/z only -- physics + queries are 2D-projected
  y: number; // track height interpolated along the segment at the projected t
}

// Distance-along-track comparisons must go through wrapDelta since `s` wraps at the
// start/finish line (§3.1).
export function wrapDelta(a: number, b: number, totalLength: number): number {
  return ((((a - b + totalLength / 2) % totalLength) + totalLength) % totalLength) - totalLength / 2;
}

// Nearest evenly-spaced sample to an arbitrary arc-length position (wraps).
// Used by AiDriver for lookahead/curvature sampling (§3.4).
export function sampleAtArcLength(samples: TrackSample[], totalLength: number, s: number): TrackSample {
  const n = samples.length;
  const wrapped = ((s % totalLength) + totalLength) % totalLength;
  const idx = Math.round((wrapped / totalLength) * n) % n;
  return samples[idx];
}

export class TrackQuery {
  private grid = new Map<string, number[]>();
  private allIndices: number[];

  constructor(
    private samples: TrackSample[],
    private totalLength: number,
  ) {
    this.allIndices = samples.map((_, i) => i);
    for (let i = 0; i < samples.length; i++) {
      const key = this.cellKey(samples[i].pos.x, samples[i].pos.z);
      let bucket = this.grid.get(key);
      if (!bucket) {
        bucket = [];
        this.grid.set(key, bucket);
      }
      bucket.push(i);
    }
  }

  private cellKey(x: number, z: number): string {
    return `${Math.floor(x / CELL_SIZE)},${Math.floor(z / CELL_SIZE)}`;
  }

  nearestSample(pos: THREE.Vector3): TrackQueryResult {
    const cx = Math.floor(pos.x / CELL_SIZE);
    const cz = Math.floor(pos.z / CELL_SIZE);

    let candidates: number[] = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const bucket = this.grid.get(`${cx + dx},${cz + dz}`);
        if (bucket) candidates.push(...bucket);
      }
    }
    if (candidates.length === 0) candidates = this.allIndices;

    // §Phase 5 item 3: nearest-sample search is x/z only -- pos.y (kart height,
    // damped toward the ground each tick) must never influence which sample
    // "wins", or a kart briefly lagging the ground on a slope could snap to
    // the wrong part of the track.
    let bestIdx = candidates[0];
    let bestDistSq = Infinity;
    for (const idx of candidates) {
      const sp = this.samples[idx].pos;
      const dx = sp.x - pos.x;
      const dz = sp.z - pos.z;
      const d = dx * dx + dz * dz;
      if (d < bestDistSq) {
        bestDistSq = d;
        bestIdx = idx;
      }
    }

    const n = this.samples.length;
    const prevIdx = (bestIdx - 1 + n) % n;
    const nextIdx = (bestIdx + 1) % n;
    const segPrev = this.projectOntoSegment(pos, prevIdx, bestIdx);
    const segNext = this.projectOntoSegment(pos, bestIdx, nextIdx);
    const winning = segPrev.distSq <= segNext.distSq ? segPrev : segNext;

    const sample = this.samples[bestIdx];
    // right.y is always 0 (§Phase 5 item 2: right stays horizontal), so a
    // full 3D pos.sub(sample.pos).dot(right) is unaffected by either point's
    // y -- lateral is correctly x/z-only without needing to flatten anything here.
    const lateral = pos.clone().sub(sample.pos).dot(sample.right);

    return {
      s: winning.s,
      lateral,
      sampleIdx: bestIdx,
      right: sample.right,
      forward: sample.forward,
      groundY: winning.y,
      grade: sample.grade,
    };
  }

  // §Phase 5 item 3: convenience wrapper for callers (FollowCamera, item
  // projectiles) that just want "track height under this x/z position" and
  // don't otherwise need a TrackQueryResult.
  groundHeightAt(pos: THREE.Vector3): number {
    return this.nearestSample(pos).groundY;
  }

  // §Phase 4 item 4. Wrap-aware linear scan over SURFACE_ZONES (a handful of
  // entries — no need for a spatial index). Returns the first zone's type
  // that contains (s, lateral), or null off any zone. `s` wraps at
  // totalLength the same way `sStart > sEnd` zones do (isInZone below).
  surfaceAt(s: number, lateral: number): SurfaceZone['type'] | null {
    const sWrapped = ((s % this.totalLength) + this.totalLength) % this.totalLength;
    for (const zone of SURFACE_ZONES) {
      const inS =
        zone.sStart <= zone.sEnd
          ? sWrapped >= zone.sStart && sWrapped <= zone.sEnd
          : sWrapped >= zone.sStart || sWrapped <= zone.sEnd; // zone spans the start/finish seam
      if (!inS) continue;
      if (zone.latMin !== undefined && lateral < zone.latMin) continue;
      if (zone.latMax !== undefined && lateral > zone.latMax) continue;
      return zone.type;
    }
    return null;
  }

  // §Phase 5 item 3: projection (both the closest-point search and the t used
  // to interpolate s) is x/z only, matching the 2D-projected physics model.
  // `t` is then reused to interpolate the track's y at the projected point
  // (groundY) -- same t, no second projection.
  private projectOntoSegment(pos: THREE.Vector3, i0: number, i1: number): SegmentProjection {
    const s0 = this.samples[i0];
    const s1 = this.samples[i1];
    const segX = s1.pos.x - s0.pos.x;
    const segZ = s1.pos.z - s0.pos.z;
    const segLenSq = segX * segX + segZ * segZ;
    const toPosX = pos.x - s0.pos.x;
    const toPosZ = pos.z - s0.pos.z;
    let t = segLenSq > 0 ? (toPosX * segX + toPosZ * segZ) / segLenSq : 0;
    t = Math.max(0, Math.min(1, t));
    const projX = s0.pos.x + segX * t;
    const projZ = s0.pos.z + segZ * t;
    const dx = pos.x - projX;
    const dz = pos.z - projZ;
    const distSq = dx * dx + dz * dz;
    const y = s0.pos.y + (s1.pos.y - s0.pos.y) * t;

    let s1v = s1.s;
    if (i1 < i0) s1v += this.totalLength; // unwrap the seam at n-1 -> 0
    const s = ((s0.s + (s1v - s0.s) * t) % this.totalLength + this.totalLength) % this.totalLength;

    return { s, distSq, y };
  }
}
