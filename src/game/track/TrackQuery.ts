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
}

interface SegmentProjection {
  s: number;
  distSq: number;
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

    let bestIdx = candidates[0];
    let bestDistSq = Infinity;
    for (const idx of candidates) {
      const d = this.samples[idx].pos.distanceToSquared(pos);
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
    const lateral = pos.clone().sub(sample.pos).dot(sample.right);

    return {
      s: winning.s,
      lateral,
      sampleIdx: bestIdx,
      right: sample.right,
      forward: sample.forward,
    };
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

  private projectOntoSegment(pos: THREE.Vector3, i0: number, i1: number): SegmentProjection {
    const s0 = this.samples[i0];
    const s1 = this.samples[i1];
    const segVec = s1.pos.clone().sub(s0.pos);
    const segLenSq = segVec.lengthSq();
    const toPos = pos.clone().sub(s0.pos);
    let t = segLenSq > 0 ? toPos.dot(segVec) / segLenSq : 0;
    t = Math.max(0, Math.min(1, t));
    const projected = s0.pos.clone().addScaledVector(segVec, t);
    const distSq = pos.distanceToSquared(projected);

    let s1v = s1.s;
    if (i1 < i0) s1v += this.totalLength; // unwrap the seam at n-1 -> 0
    const s = ((s0.s + (s1v - s0.s) * t) % this.totalLength + this.totalLength) % this.totalLength;

    return { s, distSq };
  }
}
