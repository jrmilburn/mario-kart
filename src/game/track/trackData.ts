// Track geometry constants shared by every map, plus the SurfaceZone shape.
// The per-map data — control points, surface zones, visual style — lives in
// maps.ts (§v4); this file is what stays the same whichever map is loaded.

// §v3 polish: widened from 6 to 7.5 (a 25% wider racing surface) — the road
// is the only thing that grew. GRASS_HALF stays at 14 deliberately: the
// terrain heightfield's anti-breakthrough clamp radius is derived from it and
// was verified empirically against this ribbon width (see TERRAIN_CLAMP_RADIUS
// in Environment.ts), so widening the grass would invalidate that census while
// widening the road cannot — every road-derived value (the ribbon, its
// stripes, the start banner, the cone line, boost-pad quads, the offRoad test)
// is computed from ROAD_HALF, so this one number moves them all together.
export const ROAD_HALF = 7.5;
export const GRASS_HALF = 14;
export const CHECKPOINT_COUNT = 16;

// §Phase 4 item 4 (shape only — the zones themselves are per-map, see maps.ts).
// `sStart`/`sEnd` are arc-length positions in meters (wrap-aware: sStart >
// sEnd means the zone spans across the start/finish seam — TrackQuery.surfaceAt
// handles that). `latMin`/`latMax` are signed lateral bounds (same convention
// as TrackQuery's `lateral`, §TrackQuery.ts); omitted means unbounded on that
// side, i.e. the zone applies at any lateral offset within the s-range.
// Declared here (not in maps.ts) so TrackQuery and main.ts can import the type
// without importing map data.
export interface SurfaceZone {
  sStart: number;
  sEnd: number;
  type: 'boost' | 'sand';
  latMin?: number;
  latMax?: number;
}
