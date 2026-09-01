import * as THREE from 'three';

// Hand-authored closed circuit (§3.1). One long straight (~113m) with the
// start/finish, two sweepers, a chicane, and a hairpin, forming a clean
// non-self-intersecting ~620m loop (verified: >50m clearance between any
// two non-adjacent sections of track).
export const CONTROL_POINTS: THREE.Vector3[] = [
  new THREE.Vector3(0, 0, 0), // 0 start/finish
  new THREE.Vector3(0, 0, 113), // 1 end of long straight
  new THREE.Vector3(12.6, 0, 146.5), // 2 sweeper 1 entry
  new THREE.Vector3(46, 0, 152.4), // 3 sweeper 1 apex
  new THREE.Vector3(82, 0, 127.2), // 4 sweeper 2
  new THREE.Vector3(87.9, 0, 82), // 5 enter back straight
  new THREE.Vector3(75.3, 0, 41.9), // 6 back straight, before chicane
  new THREE.Vector3(52.7, 0, 23.4), // 7 chicane kink 1
  new THREE.Vector3(73.7, 0, 5), // 8 chicane kink 2
  new THREE.Vector3(73.7, 0, -33.5), // 9 back straight continues, entering hairpin zone
  new THREE.Vector3(48.6, 0, -71.2), // 10 hairpin entry
  new THREE.Vector3(10, 0, -82), // 11 hairpin apex
  new THREE.Vector3(-31.8, 0, -56.9), // 12 hairpin exit, heading back toward start
];

export const ROAD_HALF = 6;
export const GRASS_HALF = 14;
export const CHECKPOINT_COUNT = 12;

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

// Three boost pads on the racing line (end of the long straight, mid back
// straight, exit of the chicane straight) plus one sand trap punishing a
// tight inside cut through the hairpin apex. Authored against the current
// ~620m layout; re-placed against the new ~900m layout in §Phase 4 item 5.
export const SURFACE_ZONES: SurfaceZone[] = [
  { sStart: 95, sEnd: 105, type: 'boost', latMin: -ROAD_HALF, latMax: ROAD_HALF },
  { sStart: 288, sEnd: 298, type: 'boost', latMin: -ROAD_HALF, latMax: ROAD_HALF },
  { sStart: 430, sEnd: 440, type: 'boost', latMin: -ROAD_HALF, latMax: ROAD_HALF },
  { sStart: 493, sEnd: 515, type: 'sand', latMin: ROAD_HALF, latMax: GRASS_HALF - 1 },
];
