import * as THREE from 'three';
import type { TrackSample } from './TrackBuilder';
import type { JumpData, ShortcutData } from './TrackSampler';
import { GRASS_HALF, ROAD_HALF, type SurfaceType, type SurfaceZone } from './trackData';
import { TUNING } from '../tuning';

const CELL_SIZE = 8;
// §v5: nearestSample scans a 5x5 block of cells (±16..24m) rather than 3x3.
// With a second corridor running alongside the S-bend, "the nearest main-line
// sample" is what decides whether a kart is inside the main corridor at all,
// so it has to be the true nearest out to the wall (14m), not merely the
// nearest in whatever cells happened to be adjacent.
const NEAREST_CELL_RADIUS = 2;
// §v5 review #6: metres of main-line lateral (past the main corridor's legal
// edge) over which a shortcut kart's ground eases from the main road's height
// to the shortcut's own. Wide enough that the ≤9cm mismatch at the junctions
// is a gentle ~3% grade, not a step.
const SHORTCUT_GROUND_BLEND = 3;

export type Corridor = 'main' | 'shortcut';

export interface TrackQueryResult {
  // Main-line arc length. §v5: on the shortcut this is the shortcut's mapped
  // main-line s (ShortcutSample.mainS), so lap progress keeps counting.
  s: number;
  // Signed offset from the centerline of whichever corridor the point is in;
  // |lateral| > ROAD_HALF -> grass, >= wallHalf - kartRadius -> wall.
  lateral: number;
  sampleIdx: number; // nearest main-line sample (even on the shortcut)
  right: THREE.Vector3;
  forward: THREE.Vector3;
  groundY: number; // §Phase 5 item 3 / §v5: bank-aware ground height under this x/z
  grade: number; // §Phase 5 item 3: nearest sample's grade (dy/ds) -- cheap, no extra query
  bank: number; // §v5: road roll here in radians (+ = right edge lower); 0 on the shortcut
  corridor: Corridor; // §v5: which half of the drivable union the point is in
  wallHalf: number; // §v5: that corridor's wall half-width (GRASS_HALF or the shortcut's)
  // §v5 review #3: the point is on painted dirt — anywhere on the shortcut
  // corridor, and also across the main verge at its two mouths, where the dirt
  // ribbon is painted over the grass but the overlap resolves to the main
  // line. Callers take the surface from surfaceUnder() and the grass penalty
  // from `offRoad` rather than re-deriving either from `lateral`.
  dirt: boolean;
  offRoad: boolean; // on the main verge (|lateral| > ROAD_HALF) and not on dirt
}

interface SegmentProjection {
  s: number;
  distSq: number; // §Phase 5 item 3: x/z only -- physics + queries are 2D-projected
  y: number; // centerline height interpolated along the segment at the projected t
  lateral: number; // §v5: signed, against the interpolated (unit) right below
  tanBank: number; // §v5: tan of the interpolated bank
  rx: number; // §v5: interpolated, normalized right vector at the projection
  rz: number;
}

// Anything with a sample frame: main-line TrackSamples and ShortcutSamples.
interface Frame {
  pos: THREE.Vector3;
  right: THREE.Vector3;
}

// §v3 Track A: everything Environment.ts's ground heightfield needs to know
// about the circuit at one x/z point, answered by a single cell scan.
//   dist   - x/z distance to the nearest point on a centerline (projected
//            along the winning segment, so it's smooth rather than quantised
//            to the sample spacing). §v5: the shortcut counts too, offset so
//            its wall line reads as GRASS_HALF like the main line's does.
//   blendY - the near-field target height (see terrainTrackField for why this
//            is a weighted blend and not the nearest branch's height).
//   clampY - a ceiling the terrain must not exceed, so it can never poke up
//            through the ribbon.
export interface TerrainTrackField {
  dist: number;
  blendY: number;
  clampY: number;
}

// §v3 Track A: the projected closest point on the centerline is never more
// than half a sample spacing from the nearest *sample*. The search therefore
// looks a couple of meters past `maxRadius` before giving up, so a point whose
// projected distance is just inside the radius can't be missed because its
// nearest sample sat just outside.
const RADIUS_SEARCH_MARGIN = 2;

// §v3 Track A review finding #1: weights for the near-field height blend.
// `blendY` is an inverse-distance (Shepard) weighted mean of the track heights
// around the query point rather than "the height of whichever branch happens
// to be nearest" — taking the nearest branch makes the field discontinuous
// across the medial axis between two branches at different elevations. A
// weighted mean is C0 across the medial axis by construction.
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
// min: each sample contributes a ceiling of `h + max(0, d - clampRadius) *
// CLAMP_RAMP_SLOPE`, so inside clampRadius the constraint is strict and beyond
// it the allowance opens up as a 2:1 cone, and a far-away low branch stops
// dragging the terrain down. Continuous everywhere.
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

// §v5 banking: the visual roll a kart should take on a banked road. The bank
// is defined across the *track's* right vector; a kart pointing along the
// track feels all of it, one crossing sideways none, one reversing the
// mirror image — hence the cosine of the heading difference. Returned as a
// value for the kart group's rotation.z (YXZ order, local roll): positive
// lifts the kart's right side, and a + bank lowers the right edge, so the sign
// flips. Airborne karts should ease this toward 0 (see main.ts).
export function kartBankRoll(bank: number, trackForward: THREE.Vector3, heading: number): number {
  const trackHeading = Math.atan2(trackForward.x, trackForward.z);
  return -bank * Math.cos(heading - trackHeading);
}

// §v5: one entry of the terrain-field index — a main-line or shortcut sample
// reduced to what the heightfield needs.
interface FieldPoint {
  x: number;
  z: number;
  y: number;
  rx: number;
  rz: number;
  tanBank: number;
  half: number; // ribbon half-width the lateral clamp uses
  shortcutIdx: number; // -1 for main-line points
  mainIdx: number; // -1 for shortcut points
}

// Dense flat-array cell index over a world AABB (§v3 Track A: string keys
// cost too much for the terrain build's tens of thousands of queries).
class CellIndex {
  cells: (number[] | undefined)[] = [];
  minCX = 0;
  minCZ = 0;
  countX = 0;
  countZ = 0;

  constructor(xs: number[], zs: number[]) {
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minZ = Math.min(...zs);
    const maxZ = Math.max(...zs);
    this.minCX = Math.floor(minX / CELL_SIZE);
    this.minCZ = Math.floor(minZ / CELL_SIZE);
    this.countX = Math.floor(maxX / CELL_SIZE) - this.minCX + 1;
    this.countZ = Math.floor(maxZ / CELL_SIZE) - this.minCZ + 1;
    this.cells = new Array(this.countX * this.countZ);
    for (let i = 0; i < xs.length; i++) {
      const flat =
        (Math.floor(zs[i] / CELL_SIZE) - this.minCZ) * this.countX + (Math.floor(xs[i] / CELL_SIZE) - this.minCX);
      (this.cells[flat] ??= []).push(i);
    }
  }

  at(cx: number, cz: number): number[] | undefined {
    const ix = cx - this.minCX;
    const iz = cz - this.minCZ;
    if (ix < 0 || iz < 0 || ix >= this.countX || iz >= this.countZ) return undefined;
    return this.cells[iz * this.countX + ix];
  }
}

export class TrackQuery {
  readonly shortcut: ShortcutData | null;
  readonly jump: JumpData | null;
  private mainIndex: CellIndex;
  private fieldIndex: CellIndex;
  private fieldPoints: FieldPoint[] = [];
  private tanBank: number[];
  private boundsMinX = Infinity;
  private boundsMaxX = -Infinity;
  private boundsMinZ = Infinity;
  private boundsMaxZ = -Infinity;
  // §v5 shortcut: its own x/z AABB (grown by the wall half-width plus a
  // margin) so karts nowhere near it skip its projection entirely.
  private scMinX = Infinity;
  private scMaxX = -Infinity;
  private scMinZ = Infinity;
  private scMaxZ = -Infinity;

  // §v4: surface zones arrive from the loaded map rather than as a module
  // constant. §v5: so do the shortcut corridor and the jump (TrackLayout).
  constructor(
    readonly samples: TrackSample[],
    readonly totalLength: number,
    private surfaceZones: readonly SurfaceZone[] = [],
    features: { shortcut?: ShortcutData | null; jump?: JumpData | null } = {},
  ) {
    this.shortcut = features.shortcut ?? null;
    this.jump = features.jump ?? null;
    this.tanBank = samples.map((sp) => Math.tan(sp.bank ?? 0));
    this.mainIndex = new CellIndex(
      samples.map((sp) => sp.pos.x),
      samples.map((sp) => sp.pos.z),
    );

    samples.forEach((sp, i) =>
      this.fieldPoints.push({
        x: sp.pos.x,
        z: sp.pos.z,
        y: sp.pos.y,
        rx: sp.right.x,
        rz: sp.right.z,
        tanBank: this.tanBank[i],
        half: GRASS_HALF,
        shortcutIdx: -1,
        mainIdx: i,
      }),
    );
    if (this.shortcut) {
      const margin = this.shortcut.wallHalf + 10;
      this.shortcut.samples.forEach((sp, i) => {
        this.fieldPoints.push({
          x: sp.pos.x,
          z: sp.pos.z,
          y: sp.pos.y,
          rx: sp.right.x,
          rz: sp.right.z,
          tanBank: 0,
          half: this.shortcut!.wallHalf,
          shortcutIdx: i,
          mainIdx: -1,
        });
        this.scMinX = Math.min(this.scMinX, sp.pos.x - margin);
        this.scMaxX = Math.max(this.scMaxX, sp.pos.x + margin);
        this.scMinZ = Math.min(this.scMinZ, sp.pos.z - margin);
        this.scMaxZ = Math.max(this.scMaxZ, sp.pos.z + margin);
      });
    }
    for (const p of this.fieldPoints) {
      this.boundsMinX = Math.min(this.boundsMinX, p.x);
      this.boundsMaxX = Math.max(this.boundsMaxX, p.x);
      this.boundsMinZ = Math.min(this.boundsMinZ, p.z);
      this.boundsMaxZ = Math.max(this.boundsMaxZ, p.z);
    }
    this.fieldIndex = new CellIndex(
      this.fieldPoints.map((p) => p.x),
      this.fieldPoints.map((p) => p.z),
    );
  }

  // §Phase 5 item 3: nearest-sample search is x/z only -- pos.y (kart height)
  // must never influence which sample "wins".
  private nearestMainIdx(x: number, z: number): number {
    const cx = Math.floor(x / CELL_SIZE);
    const cz = Math.floor(z / CELL_SIZE);
    let bestIdx = -1;
    let bestDistSq = Infinity;
    for (let dx = -NEAREST_CELL_RADIUS; dx <= NEAREST_CELL_RADIUS; dx++) {
      for (let dz = -NEAREST_CELL_RADIUS; dz <= NEAREST_CELL_RADIUS; dz++) {
        const bucket = this.mainIndex.at(cx + dx, cz + dz);
        if (!bucket) continue;
        for (const idx of bucket) {
          const sp = this.samples[idx].pos;
          const d = (sp.x - x) ** 2 + (sp.z - z) ** 2;
          if (d < bestDistSq) {
            bestDistSq = d;
            bestIdx = idx;
          }
        }
      }
    }
    if (bestIdx < 0) {
      // Far from everything (a camera, a stray projectile): full scan so a
      // caller is never without a track reference.
      for (let idx = 0; idx < this.samples.length; idx++) {
        const sp = this.samples[idx].pos;
        const d = (sp.x - x) ** 2 + (sp.z - z) ** 2;
        if (d < bestDistSq) {
          bestDistSq = d;
          bestIdx = idx;
        }
      }
    }
    return bestIdx;
  }

  // §v5: the signed lateral offset of (x, z) from each corridor's centerline
  // independently (shortcut: null when it is nowhere near). For build-time
  // geometry — TrackBuilder uses it to leave an opening in the main wall where
  // the shortcut passes, and to stop the shortcut fence at the main verge.
  corridorOffsets(x: number, z: number): { main: number; shortcut: number | null } {
    const main = this.projectMain(x, z, this.nearestMainIdx(x, z)).lateral;
    const sc = this.projectShortcut(x, z);
    return { main, shortcut: sc ? sc.lateral : null };
  }

  nearestSample(pos: THREE.Vector3): TrackQueryResult {
    const bestIdx = this.nearestMainIdx(pos.x, pos.z);
    const main = this.projectMain(pos.x, pos.z, bestIdx);
    const sample = this.samples[bestIdx];

    // §v5 shortcut: the drivable region is the union of the two corridors. A
    // point counts as on the main line whenever a kart there would be legal
    // on it (inside its wall less the kart radius) — so the overlap at each
    // junction always resolves to the main line — and on the shortcut when it
    // is legal there instead. Outside both, whichever corridor needs the
    // smaller correction wins, which is the one collision then clamps back
    // into: that is what turns the main wall into an opening where the
    // shortcut crosses it.
    const mainY = this.bankedHeight(main.y, main.lateral, main.tanBank);
    let dirt = false;
    if (this.shortcut && Math.abs(main.lateral) > ROAD_HALF) {
      const r = TUNING.kartRadius;
      const excessMain = Math.abs(main.lateral) - (GRASS_HALF - r);
      const sc = this.projectShortcut(pos.x, pos.z);
      if (sc && excessMain > 0) {
        const excessSc = Math.abs(sc.lateral) - (this.shortcut.wallHalf - r);
        if (excessSc <= 0 || excessSc < excessMain) {
          const scSample = this.shortcut.samples[sc.idx];
          // §v5 review #6: where the classification flips from the main line
          // to the shortcut (excessMain = 0), the ground must be the main
          // line's — the shortcut spline's own height differs from the
          // (banked) main road there by up to ~9cm, which read as a step and
          // a spurious takeoff/land. Eased to the shortcut's height over
          // SHORTCUT_GROUND_BLEND metres of main-line lateral.
          const u = Math.min(1, excessMain / SHORTCUT_GROUND_BLEND);
          const w = u * u * (3 - 2 * u);
          return {
            s: ((sc.s % this.totalLength) + this.totalLength) % this.totalLength,
            lateral: sc.lateral,
            sampleIdx: bestIdx,
            right: new THREE.Vector3(sc.rx, 0, sc.rz),
            forward: scSample.forward,
            groundY: mainY + (sc.y - mainY) * w,
            grade: scSample.grade,
            bank: 0,
            corridor: 'shortcut',
            wallHalf: this.shortcut.wallHalf,
            dirt: true,
            offRoad: false,
          };
        }
      }
      // §v5 review #3: the shortcut's mouths, where its dirt is painted
      // across the main verge (TrackBuilder draws the ribbon out to its
      // wallHalf) — dirt, not grass, even though the kart is on the main line.
      dirt = !!sc && Math.abs(sc.lateral) <= this.shortcut.wallHalf;
    }

    return {
      s: main.s,
      lateral: main.lateral,
      sampleIdx: bestIdx,
      // The interpolated right at the projected point (not the nearest
      // sample's), so collision's push along it moves `lateral` exactly.
      right: new THREE.Vector3(main.rx, 0, main.rz),
      forward: sample.forward,
      groundY: mainY,
      grade: sample.grade,
      bank: Math.atan(main.tanBank),
      corridor: 'main',
      wallHalf: GRASS_HALF,
      dirt,
      offRoad: !dirt && Math.abs(main.lateral) > ROAD_HALF,
    };
  }

  // §Phase 5 item 3: convenience wrapper for callers (FollowCamera, item
  // projectiles) that just want "track height under this x/z position".
  // §v5: bank- and shortcut-aware for free, since nearestSample is.
  groundHeightAt(pos: THREE.Vector3): number {
    return this.nearestSample(pos).groundY;
  }

  // §v5 banking: the interpolated road roll (radians, + = right edge lower) at
  // main-line arc length `s`.
  bankAt(s: number): number {
    const n = this.samples.length;
    const f = ((((s % this.totalLength) + this.totalLength) % this.totalLength) / this.totalLength) * n;
    const i0 = Math.floor(f) % n;
    const t = f - Math.floor(f);
    return this.samples[i0].bank + (this.samples[(i0 + 1) % n].bank - this.samples[i0].bank) * t;
  }

  // §v5 banking: the whole corridor rolls about the centerline, so the ground
  // at signed offset L is centerY - L * tan(bank). Clamped at the walls so a
  // camera or projectile far outside the corridor doesn't get a runaway
  // height from the extrapolated plane.
  private bankedHeight(centerY: number, lateral: number, tanBank: number): number {
    const l = Math.max(-GRASS_HALF, Math.min(GRASS_HALF, lateral));
    return centerY - l * tanBank;
  }

  // §v3 Track A: the world-space x/z bounding box of every centerline sample
  // (§v5: both corridors). Environment.ts uses it to concentrate the ground
  // heightfield's vertices around the circuit.
  centerlineBounds(): { minX: number; maxX: number; minZ: number; maxZ: number } {
    return { minX: this.boundsMinX, maxX: this.boundsMaxX, minZ: this.boundsMinZ, maxZ: this.boundsMaxZ };
  }

  // §v3 Track A: everything the ground heightfield needs about the circuit at
  // one x/z point, in a single scan of the dense cell grid. Returns null once
  // the circuit is further than `blendRadius` away.
  //
  // §v5 banking: a sample no longer has one height across its cross-section.
  // Each sample contributes the height of *its own ribbon* at this point's
  // lateral offset (clamped to the ribbon edge, so beyond the wall it is the
  // edge height), both to the blend and to the ceiling. The ceiling also
  // subtracts |tan(bank)| * (clampRadius - GRASS_HALF): a terrain vertex
  // within one cell diagonal of a ribbon vertex differs from it in lateral by
  // at most that much, so on a banked section the same no-poke-through
  // argument (§v3 Track A, Environment.ts TERRAIN_CLAMP_RADIUS) still holds.
  terrainTrackField(x: number, z: number, blendRadius: number, clampRadius: number): TerrainTrackField | null {
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
    const slackReach = Math.max(0, clampRadius - GRASS_HALF);

    let bestMain = -1;
    let bestMainSq = Infinity;
    let bestSc = -1;
    let bestScSq = Infinity;
    let sumW = 0;
    let sumWY = 0;
    let clampY = Infinity;

    for (let dz = -cellR; dz <= cellR; dz++) {
      for (let dx = -cellR; dx <= cellR; dx++) {
        const bucket = this.fieldIndex.at(cx + dx, cz + dz);
        if (!bucket) continue;
        for (const idx of bucket) {
          const p = this.fieldPoints[idx];
          const ddx = x - p.x;
          const ddz = z - p.z;
          const dSq = ddx * ddx + ddz * ddz;
          if (p.mainIdx >= 0) {
            if (dSq < bestMainSq) {
              bestMainSq = dSq;
              bestMain = p.mainIdx;
            }
          } else if (dSq < bestScSq) {
            bestScSq = dSq;
            bestSc = p.shortcutIdx;
          }
          if (dSq >= blendRadiusSq) continue;
          const d = Math.sqrt(dSq);
          const lat = Math.max(-p.half, Math.min(p.half, ddx * p.rx + ddz * p.rz));
          const h = p.y - lat * p.tanBank;
          const taper = 1 - d / blendRadius;
          const taper2 = taper * taper;
          const w = (taper2 * taper2) / (dSq + BLEND_EPS_SQ);
          sumW += w;
          sumWY += w * h;
          const ceiling = h - Math.abs(p.tanBank) * slackReach + Math.max(0, d - clampRadius) * CLAMP_RAMP_SLOPE;
          if (ceiling < clampY) clampY = ceiling;
        }
      }
    }

    if ((bestMain < 0 && bestSc < 0) || sumW === 0) return null;

    // Same projection nearestSample uses, so `dist` is the distance to the
    // interpolated centerline rather than to the nearest sample -- the blend
    // band would otherwise show the sample spacing as a faint scallop along
    // the ribbon edge.
    let dist = Infinity;
    if (bestMain >= 0) dist = Math.sqrt(this.projectMain(x, z, bestMain).distSq);
    if (bestSc >= 0 && this.shortcut) {
      const sc = this.projectShortcutFrom(x, z, bestSc);
      dist = Math.min(dist, Math.sqrt(sc.distSq) + (GRASS_HALF - this.shortcut.wallHalf));
    }
    if (dist > blendRadius) return null;
    return { dist, blendY: sumWY / sumW, clampY };
  }

  // §Phase 4 item 4. Wrap-aware linear scan over the map's zones (a handful of
  // entries — no need for a spatial index). Returns the first zone's type
  // that contains (s, lateral), or null off any zone. §v5: anywhere on the
  // shortcut corridor is 'dirt' — pass the query's `corridor` through (a
  // shortcut kart's s/lateral would otherwise alias a main-line position).
  surfaceAt(s: number, lateral: number, corridor: Corridor = 'main'): SurfaceType | null {
    if (corridor === 'shortcut') return 'dirt';
    return this.zoneAt(s, lateral);
  }

  // §v5 review #3: the surface under a nearestSample result — 'dirt' wherever
  // dirt is painted (the shortcut and its mouths across the main verge; see
  // TrackQueryResult.dirt), else the authored zones. What physics should use.
  surfaceUnder(q: TrackQueryResult): SurfaceType | null {
    return q.dirt ? 'dirt' : this.zoneAt(q.s, q.lateral);
  }

  private zoneAt(s: number, lateral: number): SurfaceType | null {
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

  // §v5: projection onto the main centerline starting from its nearest sample.
  //
  // The old "closest point on the nearer of the two adjacent segments" is
  // discontinuous on the *inside* of every bend: there a point projects onto
  // both segments at once, and where their distances tie the winner flips and
  // s jumps by ~lateral * (angle per segment) — ~0.8m at the verge of the
  // hairpin. Harmless while height only varied along the track, but with
  // banking that jump times lateral * d(tan bank)/ds became a visible step in
  // the ground (and a kart hop). Instead, this finds where the point sits in
  // the *normal field* of the centerline: along each segment the horizontal
  // forward is interpolated between the samples' own forwards, and the
  // projection is where (P - c(t)) is perpendicular to it. g(t) = (P - c(t)) .
  // f(t) is evaluated exactly at the two samples and interpolated linearly
  // between them; its zero gives t. g at a shared sample is the same for both
  // segments, so t (and s, lateral, height, bank) is continuous everywhere
  // within the corridor.
  private projectMain(x: number, z: number, bestIdx: number): SegmentProjection {
    const n = this.samples.length;
    let i0 = this.normalG(x, z, this.samples[bestIdx]) >= 0 ? bestIdx : (bestIdx - 1 + n) % n;
    // Walk to the bracketing segment; the nearest sample is at most a step
    // off except far outside the corridor (cameras), where t just clamps.
    for (let k = 0; k < 4; k++) {
      const g0 = this.normalG(x, z, this.samples[i0]);
      const g1 = this.normalG(x, z, this.samples[(i0 + 1) % n]);
      if (g0 < 0) i0 = (i0 - 1 + n) % n;
      else if (g1 > 0) i0 = (i0 + 1) % n;
      else break;
    }
    const i1 = (i0 + 1) % n;
    let s1 = this.samples[i1].s;
    if (i1 < i0) s1 += this.totalLength; // unwrap the seam at n-1 -> 0
    const proj = this.projectNormal(x, z, this.samples[i0], this.samples[i1], this.tanBank[i0], this.tanBank[i1], this.samples[i0].s, s1);
    proj.s = ((proj.s % this.totalLength) + this.totalLength) % this.totalLength;
    return proj;
  }

  // g = (P - sample) . horizontal forward, with forward recovered from the
  // (horizontal, unit) right vector: right = up x f  =>  f = (-right.z, right.x).
  private normalG(x: number, z: number, a: Frame): number {
    return -(x - a.pos.x) * a.right.z + (z - a.pos.z) * a.right.x;
  }

  // §Phase 5 item 3: projection is x/z only, matching the 2D-projected physics
  // model; the t it finds is reused to interpolate y, bank, s and right.
  private projectNormal(x: number, z: number, a: Frame, b: Frame, tanA: number, tanB: number, sA: number, sB: number): SegmentProjection {
    const g0 = this.normalG(x, z, a);
    const g1 = this.normalG(x, z, b);
    let t = g0 - g1 > 1e-9 ? g0 / (g0 - g1) : g0 >= 0 ? 1 : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = a.pos.x + (b.pos.x - a.pos.x) * t;
    const cz = a.pos.z + (b.pos.z - a.pos.z) * t;
    let rx = a.right.x + (b.right.x - a.right.x) * t;
    let rz = a.right.z + (b.right.z - a.right.z) * t;
    const rl = Math.hypot(rx, rz) || 1;
    rx /= rl;
    rz /= rl;
    const dx = x - cx;
    const dz = z - cz;
    return {
      s: sA + (sB - sA) * t,
      distSq: dx * dx + dz * dz,
      y: a.pos.y + (b.pos.y - a.pos.y) * t,
      lateral: dx * rx + dz * rz,
      tanBank: tanA + (tanB - tanA) * t,
      rx,
      rz,
    };
  }

  // §v5 shortcut: nearest shortcut sample by brute force (it is ~110 samples,
  // and only karts inside its AABB get here), then the same normal-field
  // projection as the main line — without wrapping, since it is an open curve.
  private projectShortcut(x: number, z: number): (SegmentProjection & { idx: number }) | null {
    if (!this.shortcut || x < this.scMinX || x > this.scMaxX || z < this.scMinZ || z > this.scMaxZ) return null;
    const pts = this.shortcut.samples;
    let best = 0;
    let bestSq = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const d = (pts[i].pos.x - x) ** 2 + (pts[i].pos.z - z) ** 2;
      if (d < bestSq) {
        bestSq = d;
        best = i;
      }
    }
    const proj = this.projectShortcutFrom(x, z, best);
    // §v5 review #2: behind the fork or past the rejoin the projection clamps
    // to the end sample, and `lateral` (measured along that end's right
    // vector) ignores how far *along* the point is — which extended the
    // corridor as a phantom strip past both ends, legal right out beyond the
    // main wall. Both ends lie on the main centreline, deep inside the main
    // corridor, so beyond them there is no shortcut at all.
    if (proj.beyondEnd) return null;
    return { ...proj, idx: best };
  }

  private projectShortcutFrom(x: number, z: number, best: number): SegmentProjection & { beyondEnd: boolean } {
    const pts = this.shortcut!.samples;
    const last = pts.length - 2; // last valid segment start
    let i0 = Math.min(last, this.normalG(x, z, pts[best]) >= 0 ? best : Math.max(0, best - 1));
    for (let k = 0; k < 4; k++) {
      if (this.normalG(x, z, pts[i0]) < 0 && i0 > 0) i0--;
      else if (this.normalG(x, z, pts[i0 + 1]) > 0 && i0 < last) i0++;
      else break;
    }
    const beyondEnd =
      (i0 === 0 && this.normalG(x, z, pts[0]) < 0) || (i0 === last && this.normalG(x, z, pts[last + 1]) > 0);
    return { ...this.projectNormal(x, z, pts[i0], pts[i0 + 1], 0, 0, pts[i0].mainS, pts[i0 + 1].mainS), beyondEnd };
  }

}
