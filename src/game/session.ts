import { DEFAULT_MAP_ID, type MapId } from './track/maps';

// §v4: what the start menu chose, read once by main.ts at module scope.
//
// This exists because main.ts builds the entire world — track, terrain,
// environment, karts, cameras — as module-level constants the moment it is
// imported. Rather than restructure all of that into a rebuildable world
// object, entry.ts writes the player's choice here and only *then* dynamically
// imports main.ts, so the world is built exactly once, already knowing which
// map and how many seats it is being built for.
export type GameMode = 'single' | 'multi';

export interface SessionConfig {
  mode: GameMode;
  mapId: MapId;
}

let current: SessionConfig = { mode: 'single', mapId: DEFAULT_MAP_ID };

export function setSession(config: SessionConfig) {
  current = config;
}

export function getSession(): SessionConfig {
  return current;
}
