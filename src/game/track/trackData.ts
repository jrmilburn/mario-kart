// Track geometry constants shared by every map, plus the authoring shapes a
// map's data is written in (§v5 Capricorn Coast: control points carry per-point
// bank/tag/zone, and a map may declare a shortcut corridor and a jump). The
// per-map data itself lives in its own module (capricornCoast.ts) and is
// resolved into samples by TrackSampler.buildLayout.
//
// Deliberately three-free: the start menu imports maps.ts (and so this file)
// for its layout preview without pulling the whole three.js bundle forward.

// §v3 polish: widened from 6 to 7.5 (a 25% wider racing surface) — the road
// is the only thing that grew. GRASS_HALF stays at 14 deliberately: the
// terrain heightfield's anti-breakthrough clamp radius is derived from it and
// was verified empirically against this ribbon width (see TERRAIN_CLAMP_RADIUS
// in Environment.ts), so widening the grass would invalidate that census while
// widening the road cannot — every road-derived value (the ribbon, its
// stripes, the start banner, boost-pad quads, the offRoad test) is computed
// from ROAD_HALF, so this one number moves them all together.
export const ROAD_HALF = 7.5;
export const GRASS_HALF = 14;
export const CHECKPOINT_COUNT = 16;

// §v5 shortcut: the dirt track is a second, narrower corridor. SHORTCUT_HALF is
// its drivable half-width (the dirt ribbon), SHORTCUT_WALL_HALF where its
// fence stands — the value TrackQuery hands collision as `wallHalf` while a
// kart is on it. Narrower than the main road on purpose: it is a risk/reward
// line through the cane, not a second racing line.
export const SHORTCUT_HALF = 5;
export const SHORTCUT_WALL_HALF = 6.5;

// §Phase 4 item 4 (shape only — the zones themselves are per-map). `sStart` /
// `sEnd` are arc-length positions in meters (wrap-aware: sStart > sEnd means
// the zone spans across the start/finish seam — TrackQuery.surfaceAt handles
// that). `latMin`/`latMax` are signed lateral bounds (same convention as
// TrackQuery's `lateral`); omitted means unbounded on that side.
// §v5: 'dirt' is never authored as a zone — it is what TrackQuery.surfaceAt
// reports for anywhere on the shortcut corridor — but it shares the union so
// stepKart has a single surface type to switch on.
export type SurfaceType = 'boost' | 'sand' | 'dirt';

export interface SurfaceZone {
  sStart: number;
  sEnd: number;
  type: SurfaceType;
  latMin?: number;
  latMax?: number;
}

// --- §v5 authoring format -------------------------------------------------
// A circuit is a closed list of TrackPoints joined by a centripetal
// Catmull-Rom spline (the curve passes through every `p`). Everything else is
// optional per point:
//
//   bank  degrees of road roll at this point, interpolated (smoothstep) to the
//         next point. Positive rolls the driver's RIGHT edge (as seen on
//         screen) down — i.e. banks into a right-hander; negative banks into
//         a left-hander. The whole corridor (road + verge, out to the walls)
//         rolls about the centerline. NB: the codebase's `right` vectors
//         (TrackSample.right, kartRight) point to the driver's on-screen LEFT
//         in three.js's right-handed frame, so TrackSampler stores
//         TrackSample.bank with the opposite sign (+ lowers the +right side);
//         authors never need to care.
//   tag   marks a feature anchored exactly at this point:
//           'jump-lip'      the ramp crests here and the gap starts (JumpDef
//                           gives the ramp/gap dimensions)
//           'shortcut-out'  the shortcut corridor leaves the main line here
//           'shortcut-in'   ...and rejoins it here
//   zone  scenery/verge theme from this point on (persists until the next
//         point that names one); purely visual.
//
// Tagged points must sit on straights with bank 0 — the jump because the ramp
// is built along the centerline, the shortcut junctions because the two
// corridors' ground heights have to agree where they overlap.
export type TrackTag = 'jump-lip' | 'shortcut-out' | 'shortcut-in';
export type TrackZone = 'esplanade' | 'headland' | 'harbour' | 'cane';

export interface TrackPoint {
  p: readonly [number, number, number];
  bank?: number;
  tag?: TrackTag;
  zone?: TrackZone;
}

// Ramp + gap over something (the cane-train rail). The ramp is a quadratic
// kicker added on top of the spline's own height over the last `rampLength`
// metres before the 'jump-lip' point, so its slope peaks at the lip
// (2 * rampHeight / rampLength); the gap is a smooth trench `gapDepth` deep
// and `gapLength` long straight after it.
export interface JumpDef {
  rampLength: number;
  rampHeight: number;
  gapLength: number;
  gapDepth: number;
}

// Interior points of the shortcut, in driving order, strictly between the
// 'shortcut-out' and 'shortcut-in' main-line points (those two are prepended /
// appended automatically so the junctions always sit exactly on the main
// centerline).
export interface ShortcutDef {
  points: readonly (readonly [number, number, number])[];
}

// Boost pads anchored to a control point rather than to a raw arc length, so
// moving points around keeps each pad on the straight it was authored for:
// the pad spans [from, to] metres past point `cp`.
export interface PadDef {
  cp: number;
  from: number;
  to: number;
  latMin?: number;
  latMax?: number;
}

export interface TrackDef {
  points: readonly TrackPoint[];
  jump?: JumpDef;
  shortcut?: ShortcutDef;
  pads?: readonly PadDef[];
}
