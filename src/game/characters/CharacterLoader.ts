import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { CharacterDef } from './registry';

const loader = new GLTFLoader();

// Cached by character id: the *original* parsed scene, never mounted
// directly (see loadCharacterModelInstance). Any failure — 404 because the
// user hasn't dropped a GLB in, a parse error, whatever — resolves to `null`
// with a console.warn instead of rejecting, so callers never need try/catch:
// a missing model is the expected, shippable default state (§Phase 3).
const cache = new Map<string, Promise<THREE.Group | null>>();

export function loadCharacterModel(def: CharacterDef): Promise<THREE.Group | null> {
  let pending = cache.get(def.id);
  if (!pending) {
    pending = loader
      .loadAsync(def.modelUrl)
      .then((gltf) => gltf.scene as THREE.Group)
      .catch((err) => {
        console.warn(`[CharacterLoader] failed to load "${def.id}" model (${def.modelUrl}):`, err);
        return null;
      });
    cache.set(def.id, pending);
  }
  return pending;
}

// Returns a fresh clone for mounting onto a kart's driverAnchor — the cached
// original must never be mounted directly since a THREE.Object3D can only
// have one parent at a time.
export async function loadCharacterModelInstance(def: CharacterDef): Promise<THREE.Group | null> {
  const cached = await loadCharacterModel(def);
  return cached ? (cached.clone(true) as THREE.Group) : null;
}

// Kicks off loading for every character up front, non-blocking — karts start
// with their procedural fallback driver and swap in the real model whenever
// (if ever) its promise resolves. Never awaited by the caller.
export function preloadAll(defs: CharacterDef[]): void {
  for (const def of defs) void loadCharacterModel(def);
}
