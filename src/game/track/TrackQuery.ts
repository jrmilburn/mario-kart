import * as THREE from 'three';
import type { TrackSample } from './TrackBuilder';
import { type SurfaceZone } from './trackData';

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

// §v3 Track A: everything Environment.ts's ground heightfield needs to know
// about the circuit at one x/z point, answered by a single cell scan.
//   dist   - x/z distance to the nearest point on the centerline (projected
//            along the winning segment, so it's smooth rather than quantised
//            to the 1.67m sample spacing). Drives the blend-to-base-terrain
//            smoothstep.
//   blendY - the near-field target height (see terrainTrackField for why this
//            is a weighted blend and not the nearest branch's height).
//   clampY - a ceiling the terrain must not exceed, so it can never poke up
//            through the grass ribbon.
export interface TerrainTrackField {
  dist: number;
  blendY: number;
  clampY: number;
}

// §v3 Track A: sample spacing is ~1.67m (1001m / 600), so the projected
// closest point on the centerline is never more than ~0.84m from the nearest
// *sample*. The search therefore looks a couple of meters past `maxRadius`
// before giving up, so a point whose projected distance is just inside the
// radius can't be missed because its nearest sample sat just outside.
const RADIUS_SEARCH_MARGIN = 2;

// §v3 Track A review finding #1: weights for the near-field height blend.
// `blendY` is an inverse-distance (Shepard) weighted mean of the track heights
// around the query point rather than "the height of whichever branch happens
// to be nearest". Taking the nearest branch makes the field *discontinuous*
// across the medial axis between two branches of the circuit at different
// elevations: measured on this layout, the infield bounded by the start
// straight, the esses and the back straight had 53 grid steps over 2m and a
// worst case of 5.51m across a single 6m cell -- a hard ~42-degree green wall
// running ~200m through the middle of the map, well inside FOG_NEAR. A
// weighted mean is C0 across the medial axis by construction (both branches
// contribute equally there and their influence swaps smoothly either side).
//
// The weight is `(1 - d/R)^4 / (d^2 + EPS)`:
//  - the 1/d^2 core makes the nearest track metres dominate, so right beside
//    the ribbon the terrain still tracks the *local* road height;
//  - the (1 - d/R)^4 factor gives the kernel compact support, so a sample
//    crossing the search radius contributes zero on both sides of the
//    boundary and can't introduce a step of its own;
//  - EPS (0.5m^2) keeps the weight finite directly on the centerline.
const BLEND_EPS_SQ = 0.5;

// §v3 Track A review finding #2/#4: the anti-"green teeth" ceiling is a *soft*
// min, not a hard min over a disc. A hard disc-minimum has two problems: it
// steps discontinuously as samples cross the disc edge, and it digs the
// terrain down to the lowest height anywhere in the disc even where that
// branch's ribbon is nowhere near -- measured at up to 1.95m below the local
// road, which is what left trackside props hanging in the air.
// Instead each sample contributes a ceiling of `y + max(0, d - clampRadius) *
// CLAMP_RAMP_SLOPE`: inside `clampRadius` (the radius within which a sample's
// ribbon can share a terrain cell with this vertex) the constraint is exactly
// as strict as before, and beyond it the allowance opens up as a 2:1 cone so a
// far-away low branch stops dragging the terrain down. Continuous everywhere,
// and the no-poke-through guarantee inside clampRadius is untouched.
const CLAMP_RAMP_SLOPE = 2;

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

  // §v3 Track A: a *dense* mirror of `grid` over the circuit's cell-space
  // bounding box, plus that box in world units. `grid`'s string keys are fine
  // for the handful of nearestSample calls per physics tick, but the terrain
  // heightfield issues ~19k queries at startup and each one that isn't
  // AABB-rejected sweeps a 19x19 block of cells -- millions of
  // template-literal keys would dominate the build. Flat-array indexing makes
  // an empty-cell probe a couple of
  // integer ops. Sized to the track's extent only (~19x53 cells), so it costs
  // nothing; anything outside is answered by `cellAt` returning undefined.
  private denseCells: (number[] | undefined)[] = [];
  private denseMinCX = 0;
  private denseMinCZ = 0;
  private denseCountX = 0;
  private denseCountZ = 0;
  private boundsMinX = Infinity;
  private boundsMaxX = -Infinity;
  private boundsMinZ = Infinity;
  private boundsMaxZ = -Infinity;

  // §v4: the surface zones arrive from the loaded map (maps.ts) rather than
  // being imported as a module constant — they are per-map data, and this
  // class is built fresh for whichever map the player picked.
  constructor(
    private samples: TrackSample[],
    private totalLength: number,
    private surfaceZones: readonly SurfaceZone[] = [],
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
    this.buildDenseGrid();
  }

  // §v3 Track A: build the flat-array cell index + the centerline's world AABB.
  private buildDenseGrid() {
    for (const sample of this.samples) {
      this.boundsMinX = Math.min(this.boundsMinX, sample.pos.x);
      this.boundsMaxX = Math.max(this.boundsMaxX, sample.pos.x);
      this.boundsMinZ = Math.min(this.boundsMinZ, sample.pos.z);
      this.boundsMaxZ = Math.max(this.boundsMaxZ, sample.pos.z);
    }
    this.denseMinCX = Math.floor(this.boundsMinX / CELL_SIZE);
    this.denseMinCZ = Math.floor(this.boundsMinZ / CELL_SIZE);
    this.denseCountX = Math.floor(this.boundsMaxX / CELL_SIZE) - this.denseMinCX + 1;
    this.denseCountZ = Math.floor(this.boundsMaxZ / CELL_SIZE) - this.denseMinCZ + 1;
    this.denseCells = new Array(this.denseCountX * this.denseCountZ);
    for (let i = 0; i < this.samples.length; i++) {
      const cx = Math.floor(this.samples[i].pos.x / CELL_SIZE) - this.denseMinCX;
      const cz = Math.floor(this.samples[i].pos.z / CELL_SIZE) - this.denseMinCZ;
      const flat = cz * this.denseCountX + cx;
      let bucket = this.denseCells[flat];
      if (!bucket) {
        bucket = [];
        this.denseCells[flat] = bucket;
      }
      bucket.push(i);
    }
  }

  // Absolute cell coords -> bucket, or undefined outside the circuit's extent.
  private cellAt(cx: number, cz: number): number[] | undefined {
    const ix = cx - this.denseMinCX;
    const iz = cz - this.denseMinCZ;
    if (ix < 0 || iz < 0 || ix >= this.denseCountX || iz >= this.denseCountZ) return undefined;
    return this.denseCells[iz * this.denseCountX + ix];
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
    const segPrev = this.projectOntoSegment(pos.x, pos.z, prevIdx, bestIdx);
    const segNext = this.projectOntoSegment(pos.x, pos.z, bestIdx, nextIdx);
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

  // §v3 Track A: the centerline's world-space x/z bounding box. Environment.ts
  // uses it to concentrate the ground heightfield's vertices around the
  // circuit instead of spreading them uniformly over a 1400x1400 plane.
  centerlineBounds(): { minX: number; maxX: number; minZ: number; maxZ: number } {
    return { minX: this.boundsMinX, maxX: this.boundsMaxX, minZ: this.boundsMinZ, maxZ: this.boundsMaxZ };
  }

  // §v3 Track A: everything the ground heightfield needs about the circuit at
  // one x/z point, in a single scan of the dense cell grid. Returns null once
  // the circuit is further than `blendRadius` away -- terrain vertices out
  // there are pure base terrain and don't need an answer at all, which is what
  // keeps the whole heightfield build in the low tens of milliseconds.
  //
  // Deliberately does NOT fall back to the 600-entry `allIndices` linear scan
  // the way nearestSample does: that fallback exists so a kart is never
  // without a track reference, but here "no track nearby" is a perfectly good
  // answer and a linear scan per far-field vertex would cost tens of millions
  // of distance tests over the whole plane.
  //
  // One block scan covers all three outputs. It is a plain square block rather
  // than nearestSample's expanding ring because both the weighted blend and
  // the soft-min ceiling have to see *every* sample in range -- there is
  // nothing to terminate early on -- and the AABB reject above already means
  // only the few thousand vertices actually near the circuit ever get here.
  terrainTrackField(x: number, z: number, blendRadius: number, clampRadius: number): TerrainTrackField | null {
    // Cheap exact rejection first: distance from the point to the centerline's
    // world AABB is a lower bound on the distance to any sample, and the vast
    // majority of the ground plane sits well outside it.
    const clampedX = Math.min(Math.max(x, this.boundsMinX), this.boundsMaxX);
    const clampedZ = Math.min(Math.max(z, this.boundsMinZ), this.boundsMaxZ);
    const boxDX = x - clampedX;
    const boxDZ = z - clampedZ;
    if (boxDX * boxDX + boxDZ * boxDZ > blendRadius * blendRadius) return null;

    const searchRadius = blendRadius + RADIUS_SEARCH_MARGIN;
    const cx = Math.floor(x / CELL_SIZE);
    const cz = Math.floor(z / CELL_SIZE);
    const cellR = Math.ceil(searchRadius / CELL_SIZE) + 1;
    const blendRadiusSq = blendRadius * blendRadius;

    let bestIdx = -1;
    let bestDistSq = Infinity;
    let sumW = 0;
    let sumWY = 0;
    let clampY = Infinity;

    for (let dz = -cellR; dz <= cellR; dz++) {
      for (let dx = -cellR; dx <= cellR; dx++) {
        const bucket = this.cellAt(cx + dx, cz + dz);
        if (!bucket) continue;
        for (const idx of bucket) {
          const sp = this.samples[idx].pos;
          const ddx = sp.x - x;
          const ddz = sp.z - z;
          const dSq = ddx * ddx + ddz * ddz;
          // x/z only, same 2D-projected convention as nearestSample.
          if (dSq < bestDistSq) {
            bestDistSq = dSq;
            bestIdx = idx;
          }
          if (dSq >= blendRadiusSq) continue;
          const d = Math.sqrt(dSq);
          const taper = 1 - d / blendRadius;
          const taper2 = taper * taper;
          const w = (taper2 * taper2) / (dSq + BLEND_EPS_SQ);
          sumW += w;
          sumWY += w * sp.y;
          const ceiling = sp.y + Math.max(0, d - clampRadius) * CLAMP_RAMP_SLOPE;
          if (ceiling < clampY) clampY = ceiling;
        }
      }
    }

    if (bestIdx < 0 || sumW === 0) return null;

    // Same prev/next segment projection nearestSample uses, so `dist` is the
    // distance to the interpolated centerline rather than to the nearest
    // 1.67m-spaced sample -- the blend band would otherwise show the sample
    // spacing as a faint scallop along the ribbon edge.
    const n = this.samples.length;
    const segPrev = this.projectOntoSegment(x, z, (bestIdx - 1 + n) % n, bestIdx);
    const segNext = this.projectOntoSegment(x, z, bestIdx, (bestIdx + 1) % n);
    const winning = segPrev.distSq <= segNext.distSq ? segPrev : segNext;
    const dist = Math.sqrt(winning.distSq);
    if (dist > blendRadius) return null;
    return { dist, blendY: sumWY / sumW, clampY };
  }

  // §Phase 4 item 4. Wrap-aware linear scan over the map's zones (a handful of
  // entries — no need for a spatial index). Returns the first zone's type
  // that contains (s, lateral), or null off any zone. `s` wraps at
  // totalLength the same way `sStart > sEnd` zones do (isInZone below).
  surfaceAt(s: number, lateral: number): SurfaceZone['type'] | null {
    const sWrapped = ((s % this.totalLength) + this.totalLength) % this.totalLength;
    for (const zone of this.surfaceZones) {
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
  // §v3 Track A: takes loose x/z rather than a Vector3 so the terrain
  // heightfield's ~55k queries never have to allocate a scratch vector.
  private projectOntoSegment(x: number, z: number, i0: number, i1: number): SegmentProjection {
    const s0 = this.samples[i0];
    const s1 = this.samples[i1];
    const segX = s1.pos.x - s0.pos.x;
    const segZ = s1.pos.z - s0.pos.z;
    const segLenSq = segX * segX + segZ * segZ;
    const toPosX = x - s0.pos.x;
    const toPosZ = z - s0.pos.z;
    let t = segLenSq > 0 ? (toPosX * segX + toPosZ * segZ) / segLenSq : 0;
    t = Math.max(0, Math.min(1, t));
    const projX = s0.pos.x + segX * t;
    const projZ = s0.pos.z + segZ * t;
    const dx = x - projX;
    const dz = z - projZ;
    const distSq = dx * dx + dz * dz;
    const y = s0.pos.y + (s1.pos.y - s0.pos.y) * t;

    let s1v = s1.s;
    if (i1 < i0) s1v += this.totalLength; // unwrap the seam at n-1 -> 0
    const s = ((s0.s + (s1v - s0.s) * t) % this.totalLength + this.totalLength) % this.totalLength;

    return { s, distSq, y };
  }
}
