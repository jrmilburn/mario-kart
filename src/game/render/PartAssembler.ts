// §v3 Track B / §v5: shared low-level plumbing for the procedural racers.
//
// Every kart and driver is composed from a few dozen primitives (the v3
// Mario-style cast is 20-40 per driver). Drawn naively that is a few dozen
// draw calls per kart, and split-screen renders the scene twice (plus a
// shadow pass). So builders declare a small fixed *palette*, push
// pre-transformed geometry into a bucket per palette entry, and `build()`
// merges EVERYTHING into ONE vertex-coloured mesh per rigid part. (v3 stopped
// at one mesh per colour bucket: 22-26 meshes per kart+driver, measured.) The
// colour lives in the geometry's `color` attribute and every part shares the
// single cached toon material from ToonMaterials, so:
//  - a kart is 7 meshes: chassis, steering wheel, 2 front wheels (each on its
//    own steer pivot + spin group), the rear axle, and 2 driver parts (body,
//    and the arms on their steering-roll pivot);
//  - each mesh gets a baked inverted-hull outline child (Outline.ts) except
//    the steering wheel, which is buried in the gloves anyway;
//  - retinting a kart (setKartColor) rewrites its own colour-attribute ranges
//    (TintRange) instead of mutating a material. The v3 tint rule — tinting
//    one kart must never repaint another — still holds, because every merged
//    geometry (so every colour attribute) belongs to exactly one kart.
//
// Disposal invariant: every merged geometry (and its hull) is owned by
// exactly one mesh, but the MATERIALS are shared caches — dispose geometry
// only (disposeGeometries), never materials.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { getToonVertexMaterial } from './ToonMaterials';
import { OUTLINE_THICKNESS, attachHull, buildHullGeometry, getOutlineMaterial, outlineTint } from './Outline';

// Low-poly defaults: the toon ramp hides faceting well, and the chunky-toy
// look actually wants visible facets. A SphereGeometry costs
// widthSeg * (heightSeg*2 - 2) triangles, so 10x8 is 140 (the v3 default;
// the builders pass explicit segment counts almost everywhere anyway).
export const SPHERE_W = 10;
export const SPHERE_H = 8;

// Hulls thinner than this are skipped outright (sub-pixel at chase distance,
// and they only z-fight the part they wrap).
const MIN_HULL = 0.006;
// A primitive's hull is at most this fraction of its smallest extent, so a
// 5cm pupil gets a hairline instead of a rim fatter than itself.
const HULL_FRACTION = 0.28;

export interface PartMaterialSpec {
  color: number;
  // Part of the kart's tintable shell: build() reports its vertex ranges so
  // setKartColor can recolour the whole chassis in place.
  tint?: boolean;
  // Default true. Off for tiny inner details (pupils, decals) whose hull
  // would only read as a smudge. Flat single-sided decals (disc(),
  // surfaceSpot()) never get one regardless — see isPlanar.
  outline?: boolean;
  // Faceted bits (gold buttons, the crown gem): per-face normals are baked
  // into the geometry — the vertex-coloured equivalent of v3's per-bucket
  // material flatShading.
  flat?: boolean;
}

// A run of vertices in a merged colour attribute that carries the kart colour.
// `outline` marks a run in a hull, which gets the outline tint instead.
export interface TintRange {
  attr: THREE.BufferAttribute;
  start: number;
  count: number;
  outline: boolean;
}

export interface BuiltPart {
  mesh: THREE.Mesh | null;
  tint: TintRange[];
}

export interface BuildOptions {
  // Subtracted from every vertex: lets builders author in comfortable
  // ground/seat space while the mesh hangs off a pivot somewhere else.
  origin?: [number, number, number];
  outline?: boolean; // default true
  name?: string;
}

const _col = new THREE.Color();
const _box = new THREE.Box3();
const _size = new THREE.Vector3();

// `K` is the union of palette keys, so `add('shel', ...)` is a compile error
// rather than a silently dropped part.
export class PartAssembler<K extends string> {
  private readonly buckets = new Map<K, THREE.BufferGeometry[]>();

  constructor(private readonly palette: Record<K, PartMaterialSpec>) {}

  // Geometry must already be baked into the target local space (chain
  // .scale()/.rotateX()/.translate() on the helpers below) — merging discards
  // per-primitive transforms, there is no node to hang one off afterwards.
  add(key: K, ...geos: THREE.BufferGeometry[]): void {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = [];
      this.buckets.set(key, bucket);
    }
    for (const g of geos) bucket.push(g);
  }

  // Merges every bucket into ONE shadow-casting toon mesh under `parent`, with
  // its outline hull as a child. Returns the mesh (null if nothing was added)
  // and the tint ranges for setKartColor.
  build(parent: THREE.Object3D, opts: BuildOptions = {}): BuiltPart {
    const [ox, oy, oz] = opts.origin ?? [0, 0, 0];
    const wantHull = opts.outline ?? true;
    const bodies: THREE.BufferGeometry[] = [];
    const hulls: THREE.BufferGeometry[] = [];
    // Pending tint runs as [start, count] in body/hull vertex space.
    const bodyTint: [number, number][] = [];
    const hullTint: [number, number][] = [];
    let bodyVerts = 0;
    let hullVerts = 0;

    for (const key of Object.keys(this.palette) as K[]) {
      const geos = this.buckets.get(key);
      if (!geos || geos.length === 0) continue;
      const spec = this.palette[key];
      _col.setHex(spec.color);
      for (const src of geos) {
        const g = prepare(src, _col, spec.flat ?? false);
        if (ox !== 0 || oy !== 0 || oz !== 0) g.translate(-ox, -oy, -oz);
        const n = g.getAttribute('position').count;
        if (spec.tint) bodyTint.push([bodyVerts, n]);
        bodies.push(g);
        bodyVerts += n;

        if (wantHull && spec.outline !== false && !isPlanar(g)) {
          g.computeBoundingBox();
          _box.copy(g.boundingBox!).getSize(_size);
          const t = Math.min(OUTLINE_THICKNESS, HULL_FRACTION * Math.min(_size.x, _size.y, _size.z));
          if (t >= MIN_HULL) {
            const hull = buildHullGeometry(g, t);
            if (spec.tint) hullTint.push([hullVerts, n]);
            hulls.push(hull);
            hullVerts += n;
          }
        }
      }
    }
    this.buckets.clear();
    if (bodies.length === 0) return { mesh: null, tint: [] };

    const merged = mergeAll(bodies);
    const mesh = new THREE.Mesh(merged, getToonVertexMaterial());
    mesh.castShadow = true;
    mesh.name = opts.name ?? 'part';
    parent.add(mesh);

    const tint: TintRange[] = [];
    const bodyColor = merged.getAttribute('color') as THREE.BufferAttribute;
    for (const [start, count] of bodyTint) tint.push({ attr: bodyColor, start, count, outline: false });

    if (hulls.length > 0) {
      const hullGeo = mergeAll(hulls);
      attachHull(mesh, hullGeo, getOutlineMaterial());
      const hullColor = hullGeo.getAttribute('color') as THREE.BufferAttribute;
      for (const [start, count] of hullTint) tint.push({ attr: hullColor, start, count, outline: true });
    }
    return { mesh, tint };
  }
}

// Normalises a primitive for merging: position + normal + colour only (UVs
// are unused by the untextured toon material and would just bloat the
// buffers), and always indexed — mergeGeometries refuses a mix.
function prepare(input: THREE.BufferGeometry, color: THREE.Color, flat: boolean): THREE.BufferGeometry {
  let src = input;
  if (flat && input.index) {
    // Unweld so computeVertexNormals below yields one normal per face.
    src = input.toNonIndexed();
    input.dispose();
  }
  for (const name of Object.keys(src.attributes)) {
    if (name !== 'position' && name !== 'normal') src.deleteAttribute(name);
  }
  if (flat) src.deleteAttribute('normal');
  if (!src.getAttribute('normal')) src.computeVertexNormals();
  const count = src.getAttribute('position').count;
  if (!src.index) {
    const idx = new Array<number>(count);
    for (let i = 0; i < count; i++) idx[i] = i;
    src.setIndex(idx);
  }
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  src.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return src;
}

// A flat decal (every normal pointing the same way): its "hull" would just be
// a copy of the disc floating a few cm in front of it, never a rim.
function isPlanar(g: THREE.BufferGeometry): boolean {
  const n = g.getAttribute('normal') as THREE.BufferAttribute;
  const x = n.getX(0);
  const y = n.getY(0);
  const z = n.getZ(0);
  for (let i = 1; i < n.count; i++) {
    if (n.getX(i) * x + n.getY(i) * y + n.getZ(i) * z < 0.999) return false;
  }
  return true;
}

// mergeGeometries copies into a new buffer, so the sources are disposed; a
// single-geometry list skips the copy entirely.
function mergeAll(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  if (geos.length === 1) return geos[0];
  const merged = mergeGeometries(geos, false);
  for (const g of geos) g.dispose();
  if (!merged) throw new Error('[PartAssembler] mergeGeometries failed (mismatched attributes?)');
  return merged;
}

// Rewrites the kart-colour runs to `hex` (and the matching hull runs to its
// outline tint). Only touches this kart's own buffers.
export function retint(ranges: readonly TintRange[], hex: number): void {
  const body = new THREE.Color(hex);
  const hull = outlineTint(hex);
  for (const r of ranges) {
    const c = r.outline ? hull : body;
    const arr = r.attr.array as Float32Array;
    for (let i = r.start; i < r.start + r.count; i++) {
      arr[i * 3] = c.r;
      arr[i * 3 + 1] = c.g;
      arr[i * 3 + 2] = c.b;
    }
    r.attr.needsUpdate = true;
  }
}

// Frees every geometry under `root` (hulls included). Materials are shared
// caches (ToonMaterials/Outline) and are deliberately left alone.
export function disposeGeometries(root: THREE.Object3D): void {
  const seen = new Set<THREE.BufferGeometry>();
  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh && !seen.has(obj.geometry)) {
      seen.add(obj.geometry);
      obj.geometry.dispose();
    }
  });
}

// --- geometry helpers -------------------------------------------------------
// All of these return the raw BufferGeometry so call sites can chain three's
// own in-place transforms, e.g. sphere(0.2).scale(1, 1.2, 1).translate(0, 0.7, 0).

export function box(w: number, h: number, d: number): THREE.BufferGeometry {
  return new THREE.BoxGeometry(w, h, d);
}

// A box spanning [z0, z1] on the kart's forward axis — chassis parts are much
// easier to reason about as "from the tail to the front axle" than as a
// centre plus a length.
export function spanBoxZ(w: number, h: number, z0: number, z1: number): THREE.BufferGeometry {
  return box(w, h, Math.abs(z1 - z0)).translate(0, 0, (z0 + z1) / 2);
}

// 4-sided frustum along +Z with independent front/back width, height and
// vertical offset: wedge noses and dashboards. 12 triangles. BoxGeometry(1,1,1)
// has 24 unshared verts (4 per face) and every one of them has z = +-0.5, so
// classifying by sign(z) cleanly separates the front rim from the back rim.
export function taperedBox(
  front: { w: number; h: number; dy?: number },
  back: { w: number; h: number; dy?: number },
  length: number,
): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const isFront = pos.getZ(i) > 0;
    const w = isFront ? front.w : back.w;
    const h = isFront ? front.h : back.h;
    const dy = (isFront ? front.dy : back.dy) ?? 0;
    pos.setX(i, pos.getX(i) * w);
    pos.setY(i, pos.getY(i) * h + dy);
    pos.setZ(i, pos.getZ(i) * length);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals(); // the taper shears the side faces; stale normals would light them wrong
  return geo;
}

export function sphere(r: number, wSeg = SPHERE_W, hSeg = SPHERE_H): THREE.BufferGeometry {
  return new THREE.SphereGeometry(r, wSeg, hSeg);
}

// Unit sphere scaled into an ellipsoid with semi-axes (rx, ry, rz) at `at`.
// Most of both characters is ellipsoids, so this saves a lot of chaining.
export function ellipsoid(
  rx: number, ry: number, rz: number, at: [number, number, number], wSeg = SPHERE_W, hSeg = SPHERE_H,
): THREE.BufferGeometry {
  return sphere(1, wSeg, hSeg).scale(rx, ry, rz).translate(at[0], at[1], at[2]);
}

// Dome pointing +Y (rotate it to face wherever the shell/cap needs to point).
// `phiStart/phiLength` carve out wedges.
export function hemisphere(
  r: number, wSeg = SPHERE_W, hSeg = 5, phiStart = 0, phiLength = Math.PI * 2,
): THREE.BufferGeometry {
  return new THREE.SphereGeometry(r, wSeg, hSeg, phiStart, phiLength, 0, Math.PI / 2);
}

export function cyl(rTop: number, rBottom: number, h: number, seg = 10): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(rTop, rBottom, h, seg);
}

export function cone(r: number, h: number, seg = 8): THREE.BufferGeometry {
  return new THREE.ConeGeometry(r, h, seg);
}

// Flat disc facing +Z by default (emblems, mushroom-cap spots, buttons).
export function disc(r: number, seg = 10): THREE.BufferGeometry {
  return new THREE.CircleGeometry(r, seg);
}

export function torus(r: number, tube: number, radial = 5, tubular = 10, arc = Math.PI * 2): THREE.BufferGeometry {
  return new THREE.TorusGeometry(r, tube, radial, tubular, arc);
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _fwd = new THREE.Vector3(0, 0, 1);
const _quat = new THREE.Quaternion();
const _mat = new THREE.Matrix4();

// A tapered cylinder stretched between two points — necks, legs, wings,
// roll bars, exhaust stacks. Built once at construction time, so the temp
// vectors above are pure tidiness, not a hot-path optimisation.
export function limb(
  from: [number, number, number],
  to: [number, number, number],
  rStart: number,
  rEnd = rStart,
  seg = 6,
): THREE.BufferGeometry {
  _a.set(from[0], from[1], from[2]);
  _b.set(to[0], to[1], to[2]);
  _dir.subVectors(_b, _a);
  const len = _dir.length() || 0.0001;
  // CylinderGeometry runs along +Y with its origin at the midpoint.
  const geo = cyl(rEnd, rStart, len, seg);
  _quat.setFromUnitVectors(_up, _dir.divideScalar(len));
  geo.applyMatrix4(_mat.makeRotationFromQuaternion(_quat));
  geo.translate((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, (from[2] + to[2]) / 2);
  return geo;
}

// Rotates a +Z-facing geometry (disc(), mostly) to face `dir`.
export function faceDir(geo: THREE.BufferGeometry, dir: [number, number, number]): THREE.BufferGeometry {
  _dir.set(dir[0], dir[1], dir[2]).normalize();
  _quat.setFromUnitVectors(_fwd, _dir);
  return geo.applyMatrix4(_mat.makeRotationFromQuaternion(_quat));
}

// Places a small disc flush against the surface of a sphere of radius
// `sphereR` centred at `centre`, pointing outward along `dir` — mushroom-cap
// spots and the cap emblem. Nudged 4mm proud so it never z-fights the dome.
export function surfaceSpot(
  spotR: number,
  sphereR: number,
  centre: [number, number, number],
  dir: [number, number, number],
  seg = 8,
): THREE.BufferGeometry {
  _dir.set(dir[0], dir[1], dir[2]).normalize();
  const geo = faceDir(disc(spotR, seg), [_dir.x, _dir.y, _dir.z]);
  const d = sphereR + 0.004;
  return geo.translate(centre[0] + _dir.x * d, centre[1] + _dir.y * d, centre[2] + _dir.z * d);
}

// Budget helper: triangles under an object. Outline hulls are excluded by
// default — they are the same triangles again, and the tests budget the
// visible geometry and the hulls separately.
export function countTriangles(root: THREE.Object3D, opts: { includeOutlines?: boolean } = {}): number {
  let tris = 0;
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    if (obj.userData.outline && !opts.includeOutlines) return;
    const geo = obj.geometry as THREE.BufferGeometry;
    tris += geo.index ? geo.index.count / 3 : geo.attributes.position.count / 3;
  });
  return tris;
}
