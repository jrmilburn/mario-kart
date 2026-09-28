import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// §v5 scenery props (track + environment): every multi-part prop — a palm, a
// boat, the start arch, the cane train — is authored as coloured primitive
// parts merged into ONE vertex-coloured geometry, so it costs one draw call
// (and, instanced, one draw call for all copies). Deliberately separate from
// the kart PartAssembler, which the character work owns.

export interface Part {
  geometry: THREE.BufferGeometry;
  color: THREE.ColorRepresentation;
}

const tmpColor = new THREE.Color();

// Bakes `color` into a vertex colour attribute and applies `matrix`; drops uv
// so parts from different primitive types always merge (the props are
// untextured).
export function part(geometry: THREE.BufferGeometry, color: THREE.ColorRepresentation, matrix?: THREE.Matrix4): THREE.BufferGeometry {
  const g = geometry.index ? geometry.toNonIndexed() : geometry.clone();
  geometry.dispose();
  if (matrix) g.applyMatrix4(matrix);
  g.deleteAttribute('uv');
  const count = g.getAttribute('position').count;
  const colors = new Float32Array(count * 3);
  tmpColor.set(color);
  for (let i = 0; i < count; i++) colors.set([tmpColor.r, tmpColor.g, tmpColor.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

export function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!merged) throw new Error('[propKit] merge failed (mismatched attributes)');
  merged.computeBoundingSphere();
  return merged;
}

// Matrix helpers for authoring parts in place.
export function at(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ')),
    new THREE.Vector3(sx, sy, sz),
  );
}

// Seeded PRNG (mulberry32) so every scattered layer is identical across
// reloads (and reproducible by the offline draw-call/triangle census).
export function makeRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
