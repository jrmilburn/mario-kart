import * as THREE from 'three';
import type { TrackSample } from './TrackBuilder';

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
