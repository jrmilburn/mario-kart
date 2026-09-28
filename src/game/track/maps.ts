import type { TrackDef } from './trackData';
import { CAPRICORN_COAST } from './capricornCoast';

// §v4 introduced a map picker; §v5 ships exactly one original circuit,
// Capricorn Coast (capricornCoast.ts). The MapDef/MAPS shape is kept so the
// start menu (and entry.ts's ?map= deep link) keep compiling until the menu
// is rewritten around a single track — everything track-specific now lives in
// the TrackDef, and there is no per-map visual "style" any more: the coast is
// the world.
//
// Deliberately three-free: the control points are plain [x, y, z] tuples
// rather than THREE.Vector3, so the start menu can import this module (for the
// name and the little layout preview) without dragging the whole three.js
// bundle into the first chunk the page loads. TrackSampler does the
// conversion when it builds the curve.

export type MapId = 'coast';

export interface MapDef {
  id: MapId;
  name: string;
  tagline: string;
  /** Accent colour for the map's card in the start menu (CSS hex). */
  accent: string;
  track: TrackDef;
  /** The spline's control points, for the start menu's layout preview. */
  controlPoints: readonly (readonly [number, number, number])[];
}

export const MAPS: readonly MapDef[] = [
  {
    id: 'coast',
    name: 'Capricorn Coast',
    tagline: 'Esplanade · basalt headland · breakwater · cane-train jump',
    accent: '#ffd23f',
    track: CAPRICORN_COAST,
    controlPoints: CAPRICORN_COAST.points.map((pt) => pt.p),
  },
];

export const DEFAULT_MAP_ID: MapId = 'coast';

export function mapById(id: string | null | undefined): MapDef {
  return MAPS.find((m) => m.id === id) ?? MAPS[0];
}
