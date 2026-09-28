// §v5 Rendering: inverted-hull outlines for the karts and their drivers.
//
// The classic toy/cel trick: draw a copy of the mesh pushed a few centimetres
// out along its normals, rendered BackSide only, so all that survives the
// depth test is a rim around the silhouette (plus inner contours wherever one
// part overhangs another — a cap brim over the face, a glove over the cowl).
// It is geometry, not a post pass, so it costs nothing on Low quality beyond
// the toggle below, and it composes with the split-screen viewports and the
// single bloom pass for free.
//
// Choices worth knowing before touching this:
//  - The hull is baked on the CPU at build time (not pushed in a vertex
//    shader). Karts are built a handful of times per session, the hull is a
//    few thousand vertices, and a baked hull needs no shader patching — which
//    also means the node-side tests exercise exactly what ships.
//  - Normals are WELDED per position before pushing: a box or a cylinder cap
//    has split normals at its hard edges, and pushing those apart tears the
//    hull open at every corner. Averaging normals over coincident vertices
//    keeps the hull closed.
//  - The colour is a dark tint OF the base colour, never pure black (brief:
//    "soft outlines"): red gets a burgundy rim, green a forest one, white
//    gloves a warm grey. outlineTint is the single place that decides it.
//  - Every outline material is registered with setOutlinesEnabled, which
//    flips `material.visible` — three.js skips objects whose material is
//    invisible during projection, so the Low quality toggle is O(materials),
//    with no scene traversal, and applies to karts built afterwards too.
import * as THREE from 'three';

// Metres, in the mesh's local space (so the boost/jump squash scales it
// along with everything else, which is what you want).
export const OUTLINE_THICKNESS = 0.035;

// Outline = base * OUTLINE_KEEP + OUTLINE_FLOOR, computed in sRGB so "35% of
// coral" means what an artist would expect. The floor is a cool dark violet:
// it's what stops a black tyre from getting a pure-black rim and gives every
// outline a common, slightly inky undertone against the warm scene.
const OUTLINE_KEEP = 0.36;
const OUTLINE_FLOOR = [0.06, 0.045, 0.085] as const;

const _srgb = { r: 0, g: 0, b: 0 };

// Writes the outline tint of `base` (hex or a working-space Color) into
// `target` (working/linear space, ready for a material or a colour attribute).
export function outlineTint(base: number | THREE.Color, target = new THREE.Color()): THREE.Color {
  if (typeof base === 'number') target.setHex(base);
  else target.copy(base);
  target.getRGB(_srgb, THREE.SRGBColorSpace);
  return target.setRGB(
    _srgb.r * OUTLINE_KEEP + OUTLINE_FLOOR[0],
    _srgb.g * OUTLINE_KEEP + OUTLINE_FLOOR[1],
    _srgb.b * OUTLINE_KEEP + OUTLINE_FLOOR[2],
    THREE.SRGBColorSpace,
  );
}

// --- materials ----------------------------------------------------------------

let enabled = true;
const registry = new Set<THREE.Material>();

function register<M extends THREE.Material>(mat: M): M {
  mat.visible = enabled;
  registry.add(mat);
  return mat;
}

// Low quality mode turns every outline off (brief: "Quality Low: ... no
// outlines"). Global, idempotent, and cheap enough to call on every toggle.
export function setOutlinesEnabled(on: boolean): void {
  enabled = on;
  for (const mat of registry) mat.visible = on;
}

export function outlinesEnabled(): boolean {
  return enabled;
}

let vertexOutline: THREE.MeshBasicMaterial | null = null;

// Shared outline for vertex-coloured hulls (every kart and driver part): the
// hull's own `color` attribute already carries the per-part dark tint.
export function getOutlineMaterial(): THREE.MeshBasicMaterial {
  if (!vertexOutline) {
    vertexOutline = register(new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true, side: THREE.BackSide }));
    vertexOutline.name = 'outline-vertex';
  }
  return vertexOutline;
}

const byColor = new Map<number, THREE.MeshBasicMaterial>();

// Per-colour outline for a plain single-colour mesh (see addOutline).
export function getOutlineMaterialFor(baseColor: number): THREE.MeshBasicMaterial {
  let mat = byColor.get(baseColor);
  if (!mat) {
    mat = register(new THREE.MeshBasicMaterial({ color: outlineTint(baseColor), side: THREE.BackSide }));
    mat.name = `outline#${baseColor.toString(16).padStart(6, '0')}`;
    byColor.set(baseColor, mat);
  }
  return mat;
}

// --- geometry -----------------------------------------------------------------

const _n = new THREE.Vector3();
const _c = new THREE.Color();

// Builds the hull for `src`: positions pushed out by `thickness` along welded
// normals, the same index (so the same triangles, still wound outward — the
// BackSide material is what inverts it), and, if `src` is vertex-coloured, a
// colour attribute already converted to the outline tint. UVs/normals are
// deliberately dropped; the outline material is unlit and untextured.
export function buildHullGeometry(src: THREE.BufferGeometry, thickness = OUTLINE_THICKNESS): THREE.BufferGeometry {
  const pos = src.getAttribute('position') as THREE.BufferAttribute;
  let normal = src.getAttribute('normal') as THREE.BufferAttribute | undefined;
  if (!normal) {
    src.computeVertexNormals();
    normal = src.getAttribute('normal') as THREE.BufferAttribute;
  }
  const count = pos.count;

  // Weld: sum the normals of every vertex sharing a (quantised) position.
  const keyToSlot = new Map<string, number>();
  const slotOf = new Uint32Array(count);
  const sums: number[] = [];
  for (let i = 0; i < count; i++) {
    const key = `${Math.round(pos.getX(i) * 1e4)},${Math.round(pos.getY(i) * 1e4)},${Math.round(pos.getZ(i) * 1e4)}`;
    let slot = keyToSlot.get(key);
    if (slot === undefined) {
      slot = sums.length / 3;
      keyToSlot.set(key, slot);
      sums.push(0, 0, 0);
    }
    slotOf[i] = slot;
    sums[slot * 3] += normal.getX(i);
    sums[slot * 3 + 1] += normal.getY(i);
    sums[slot * 3 + 2] += normal.getZ(i);
  }

  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const s = slotOf[i] * 3;
    _n.set(sums[s], sums[s + 1], sums[s + 2]);
    // Opposing normals can cancel (the two faces of a thin plate): fall back
    // to the vertex's own normal rather than not moving it at all.
    if (_n.lengthSq() < 1e-8) _n.set(normal.getX(i), normal.getY(i), normal.getZ(i));
    _n.normalize();
    out[i * 3] = pos.getX(i) + _n.x * thickness;
    out[i * 3 + 1] = pos.getY(i) + _n.y * thickness;
    out[i * 3 + 2] = pos.getZ(i) + _n.z * thickness;
  }

  const hull = new THREE.BufferGeometry();
  hull.setAttribute('position', new THREE.BufferAttribute(out, 3));
  if (src.index) hull.setIndex(src.index.clone());
  const color = src.getAttribute('color') as THREE.BufferAttribute | undefined;
  if (color) {
    const tinted = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      outlineTint(_c.setRGB(color.getX(i), color.getY(i), color.getZ(i)), _c);
      tinted[i * 3] = _c.r;
      tinted[i * 3 + 1] = _c.g;
      tinted[i * 3 + 2] = _c.b;
    }
    hull.setAttribute('color', new THREE.BufferAttribute(tinted, 3));
  }
  return hull;
}

// Makes `hull` into the outline child of `owner` (same transform, so it
// follows every animation the owner gets). Never casts or receives shadows —
// a second, fatter shadow per part would just smear the real one.
export function attachHull(owner: THREE.Mesh, hull: THREE.BufferGeometry, material: THREE.Material): THREE.Mesh {
  const mesh = new THREE.Mesh(hull, material);
  mesh.name = 'outline';
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.userData.outline = true;
  owner.add(mesh);
  return mesh;
}

// Generic helper for anything that is NOT built through PartAssembler: a
// single-material mesh gets a per-colour hull (vertex-coloured meshes get the
// shared vertex outline). Returns the outline mesh.
export function addOutline(mesh: THREE.Mesh, thickness = OUTLINE_THICKNESS): THREE.Mesh {
  const geo = mesh.geometry as THREE.BufferGeometry;
  const hull = buildHullGeometry(geo, thickness);
  if (hull.getAttribute('color')) return attachHull(mesh, hull, getOutlineMaterial());
  const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  const base = (mat as THREE.Material & { color?: THREE.Color }).color;
  return attachHull(mesh, hull, getOutlineMaterialFor(base ? base.getHex() : 0x404040));
}
