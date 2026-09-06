import { ROAD_HALF, type SurfaceZone } from './trackData';

// §v4: the game ships two circuits, chosen from the start menu before anything
// is built (see src/game/entry.ts). Everything that differs between them lives
// in a MapDef; everything that doesn't — road/grass half-widths, checkpoint
// count, sample density, physics — stays global in trackData.ts and elsewhere.
//
// Deliberately three-free: the control points are plain [x, y, z] tuples
// rather than THREE.Vector3, so the start menu can import this module (for map
// names and the little preview it draws of each layout) without dragging the
// whole three.js bundle into the first chunk the page loads. TrackBuilder does
// the conversion when it builds the curve.

export type MapId = 'circuit' | 'rainbow';

// Drives the track's own materials/props (TrackBuilder) and the whole backdrop
// (Environment): 'meadow' is the grass/sky/mountains world, 'space' is a
// glowing ribbon in a starfield with no ground under it at all.
export type MapStyle = 'meadow' | 'space';

export interface MapDef {
  id: MapId;
  name: string;
  tagline: string;
  style: MapStyle;
  /** Accent colour for the map's card in the start menu (CSS hex). */
  accent: string;
  controlPoints: readonly (readonly [number, number, number])[];
  surfaceZones: readonly SurfaceZone[];
}

// --- Sunset Circuit (the original layout) ---------------------------------
// Hand-authored closed circuit (§3.1, redesigned §Phase 4 item 5). Start/finish
// straight, a double-apex right-hander, a flowing esses, a long back straight
// (~181m, clearly the longest single straight), and a two-part hairpin complex
// back to the line — a clean non-self-intersecting ~1001m loop (verified via a
// throwaway arc-length clearance script: no two of the 600 rendered samples
// more than 40m apart along the track are ever closer than 2*GRASS_HALF+2 =
// 30m in x/z; worst case ~33.7m).
//
// §Phase 5 item 1: y values authored on top of the flat Phase 4 layout —
// physics stays 2D-projected (x/z only), y is purely a visual/height query
// concern layered on afterward (see TrackBuilder/TrackQuery/main.ts). Profile:
// flat start/finish straight (0/1 pinned at y=0 so the grid start is level),
// a gentle dip through the double-apex (2-6), climbing through the connecting
// curve and esses (7-10) to an ~8m crest right where the esses feed onto the
// back straight (11), a long gentle descent down the back straight into the
// braking zone (12-13), and level again through the hairpin and back to the
// line (14-17). Control-point-to-point grades top out ~5.3% (esses climb),
// well under the ~10% budget — see buildSamples' dev-time grade assertion for
// the actual worst per-sample figure once Catmull-Rom smoothing is applied.
const CIRCUIT_CONTROL_POINTS = [
  [0, 0, 0], // 0 start/finish
  [0, 0, 101.84], // 1 end of long start straight
  [9.32, -0.5, 127.31], // 2 double-apex turn-in
  [36.02, -1.5, 142.83], // 3 double-apex, apex 1
  [62.1, -1.0, 136.62], // 4 double-apex, easing between apexes
  [91.91, -1.8, 145.94], // 5 double-apex, apex 2
  [116.75, -1.0, 124.2], // 6 double-apex exit
  [96.26, 0.5, 86.94], // 7 connecting curve into the esses
  [82.8, 2.0, 62.1], // 8 esses entry
  [62.93, 4.0, 28.98], // 9 esses kink 1
  [87.77, 6.0, -4.14], // 10 esses kink 2
  [80.32, 8.0, -45.54], // 11 esses exit, entering the back straight -- crest of the hill
  [80.24, 2.0, -225.9], // 12 long back straight -- gentle descent
  [55.04, 1.0, -261.9], // 13 braking zone into the hairpin
  [15.44, 0, -272.7], // 14 hairpin apex
  [-15.3, 0, -198], // 15 hairpin exit
  [-22.2, 0, -149], // 16 sweeping back toward the start
  [-4.93, 0, -88.56], // 17 final approach, merging onto the start straight
] as const;

// §Phase 4 item 4. Three boost pads on the racing line (mid start-straight,
// mid back-straight, on the straightaway just past the hairpin exit) plus one
// sand trap punishing a tight inside cut through the hairpin apex (s=717.5).
//
// §Phase 4 finding #1: the sand zone's latMin sits *inside* ROAD_HALF (not at
// or beyond it) so the patch straddles the pavement itself along the apex's
// inside line, not just the grass beyond the road edge -- that grass is
// already penalized identically by the plain offRoad check, so a zone
// confined to it would be a mechanical no-op. A kart hugging the tight inside
// line through the apex (positive lateral, matching this right-hand hairpin's
// inside) now drives through sand while still nominally on the road; the
// wider/safer line past latMax stays clean. See Kart.ts's sandSpeedCap/sandDecel
// for why sand and grass now feel different, too.
const CIRCUIT_SURFACE_ZONES: SurfaceZone[] = [
  { sStart: 55, sEnd: 65, type: 'boost', latMin: -ROAD_HALF, latMax: ROAD_HALF },
  { sStart: 515, sEnd: 528, type: 'boost', latMin: -ROAD_HALF, latMax: ROAD_HALF },
  { sStart: 815, sEnd: 828, type: 'boost', latMin: -ROAD_HALF, latMax: ROAD_HALF },
  { sStart: 705, sEnd: 725, type: 'sand', latMin: 2, latMax: 9 },
];

// --- Rainbow Ridge -------------------------------------------------------
// A climbing slalom leads into the high northern horseshoe, then a descending
// switchback and a low comet bend return racers to the level finish straight.
// Keep branches separated in X/Z: height does not isolate them in TrackQuery.
// Smoothed: 1729m lap, 37.6m minimum non-local clearance, 18.1m minimum
// corner radius and 8.2% maximum sampled grade. scripts/rainbow.test.ts
// validates the actual smoothed samples, grid, checkpoints and AI laps.
const RAINBOW_CONTROL_POINTS = [
  [0, 0, 240], // level launch straight
  [80, 0, 240],
  [135, 3, 215],
  [170, 6, 170],
  [155, 9, 120], // climbing slalom: alternate steering and drift direction
  [180, 12, 65],
  [205, 16, 10],
  [175, 20, -45],
  [160, 24, -100],
  [180, 27, -155],
  [155, 30, -210], // high horseshoe
  [100, 32, -235],
  [45, 30, -210],
  [15, 26, -150],
  [-25, 23, -135], // reverse direction into the descending switchback
  [-65, 20, -150],
  [-90, 17, -210],
  [-145, 14, -235],
  [-195, 10, -190],
  [-205, 7, -120],
  [-175, 4, -65],
  [-145, 1, -15],
  [-145, -2, 45], // low comet bend
  [-195, -4, 95],
  [-205, -3, 150],
  [-175, 0, 215],
  [-105, 0, 240],
  [-55, 0, 240], // flat grid and straight run to the line
] as const;

// Pads are placed on exits; arc-length locations are verified with the layout.
const RAINBOW_SURFACE_ZONES: SurfaceZone[] = [
  { sStart: 40, sEnd: 54, type: 'boost', latMin: -ROAD_HALF, latMax: ROAD_HALF },
  { sStart: 290, sEnd: 304, type: 'boost', latMin: -ROAD_HALF, latMax: ROAD_HALF },
  { sStart: 745, sEnd: 759, type: 'boost', latMin: -ROAD_HALF, latMax: ROAD_HALF },
  { sStart: 1135, sEnd: 1149, type: 'boost', latMin: -ROAD_HALF, latMax: ROAD_HALF },
  { sStart: 1620, sEnd: 1634, type: 'boost', latMin: -ROAD_HALF, latMax: ROAD_HALF },
];

export const MAPS: readonly MapDef[] = [
  {
    id: 'circuit',
    name: 'Sunset Circuit',
    tagline: 'Rolling countryside · double apex · long back straight',
    style: 'meadow',
    accent: '#4caf50',
    controlPoints: CIRCUIT_CONTROL_POINTS,
    surfaceZones: CIRCUIT_SURFACE_ZONES,
  },
  {
    id: 'rainbow',
    name: 'Rainbow Ridge',
    tagline: 'Climbing slalom \u00b7 summit horseshoe \u00b7 descending switchback',
    style: 'space',
    accent: '#b06cff',
    controlPoints: RAINBOW_CONTROL_POINTS,
    surfaceZones: RAINBOW_SURFACE_ZONES,
  },
];

export const DEFAULT_MAP_ID: MapId = 'circuit';

export function mapById(id: string | null | undefined): MapDef {
  return MAPS.find((m) => m.id === id) ?? MAPS[0];
}
