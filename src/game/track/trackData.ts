import * as THREE from 'three';

// Hand-authored closed circuit (§3.1, redesigned §Phase 4 item 5). Start/finish
// straight, a double-apex right-hander, a flowing esses, a long back
// straight (~181m, clearly the longest single straight), and a two-part
// hairpin complex back to the line — a clean non-self-intersecting ~1001m
// loop (verified via a throwaway arc-length clearance script: no two of the
// 600 rendered samples more than 40m apart along the track are ever closer
// than 2*GRASS_HALF+2 = 30m in x/z; worst case ~33.7m).
export const CONTROL_POINTS: THREE.Vector3[] = [
  new THREE.Vector3(0, 0, 0), // 0 start/finish
  new THREE.Vector3(0, 0, 101.84), // 1 end of long start straight
  new THREE.Vector3(9.32, 0, 127.31), // 2 double-apex turn-in
  new THREE.Vector3(36.02, 0, 142.83), // 3 double-apex, apex 1
  new THREE.Vector3(62.1, 0, 136.62), // 4 double-apex, easing between apexes
  new THREE.Vector3(91.91, 0, 145.94), // 5 double-apex, apex 2
  new THREE.Vector3(116.75, 0, 124.2), // 6 double-apex exit
  new THREE.Vector3(96.26, 0, 86.94), // 7 connecting curve into the esses
  new THREE.Vector3(82.8, 0, 62.1), // 8 esses entry
  new THREE.Vector3(62.93, 0, 28.98), // 9 esses kink 1
  new THREE.Vector3(87.77, 0, -4.14), // 10 esses kink 2
  new THREE.Vector3(80.32, 0, -45.54), // 11 esses exit, entering the back straight
  new THREE.Vector3(80.24, 0, -225.9), // 12 long back straight
  new THREE.Vector3(55.04, 0, -261.9), // 13 braking zone into the hairpin
  new THREE.Vector3(15.44, 0, -272.7), // 14 hairpin apex
  new THREE.Vector3(-15.3, 0, -198), // 15 hairpin exit
  new THREE.Vector3(-22.2, 0, -149), // 16 sweeping back toward the start
  new THREE.Vector3(-4.93, 0, -88.56), // 17 final approach, merging onto the start straight
];

export const ROAD_HALF = 6;
export const GRASS_HALF = 14;
export const CHECKPOINT_COUNT = 16;

// §Phase 4 item 4. `sStart`/`sEnd` are arc-length positions in meters
// (wrap-aware: sStart > sEnd means the zone spans across the start/finish
// seam — TrackQuery.surfaceAt handles that). `latMin`/`latMax` are signed
// lateral bounds (same convention as TrackQuery's `lateral`, §TrackQuery.ts);
// omitted means unbounded on that side, i.e. the zone applies at any lateral
// offset within the s-range. Placed here (not TrackBuilder) so main.ts and
// TrackQuery can both import the data without a build-time dependency on THREE.
export interface SurfaceZone {
  sStart: number;
  sEnd: number;
  type: 'boost' | 'sand';
  latMin?: number;
  latMax?: number;
}

// Three boost pads on the racing line (mid start-straight, mid back-straight,
// on the straightaway just past the hairpin exit) plus one sand trap
// punishing a tight inside cut through the hairpin apex (s=717.5). Re-placed
// here for the §Phase 4 item 5 layout (was authored against the old ~620m
// layout in §Phase 4 item 4).
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
export const SURFACE_ZONES: SurfaceZone[] = [
  { sStart: 55, sEnd: 65, type: 'boost', latMin: -ROAD_HALF, latMax: ROAD_HALF },
  { sStart: 515, sEnd: 528, type: 'boost', latMin: -ROAD_HALF, latMax: ROAD_HALF },
  { sStart: 815, sEnd: 828, type: 'boost', latMin: -ROAD_HALF, latMax: ROAD_HALF },
  { sStart: 705, sEnd: 725, type: 'sand', latMin: 2, latMax: 9 },
];
