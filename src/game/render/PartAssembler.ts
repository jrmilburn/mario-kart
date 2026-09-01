// §v3 Track B: shared low-level plumbing for the procedural racers.
//
// Track B replaces the old "head sphere + torso box + domed cap" driver and
// the single BoxGeometry kart body with characters/chassis composed of 20-40
// primitives each. Naively that would be 20-40 extra draw calls per kart, and
// split-screen already renders the whole scene twice (plus a shadow pass), so
// instead every builder here declares a small fixed *palette* and pushes
// pre-transformed geometry into a bucket per palette entry. `build()` then
// merges each bucket into one BufferGeometry and emits ONE mesh per colour.
//
// Measured, so the next perf pass isn't misled (§v3 Track B review finding
// #3 — an earlier version of this comment claimed "~6 draw calls" for a whole
// kart, which was only ever the chassis' colour buckets): a complete
// kart+driver is 21-25 meshes — always 7 on the chassis body (5 colour buckets
// plus the steering wheel's rim/hub), 8-12 on the driver, and 6 on the wheels
// (tyre+rim per steerable front wheel, plus one merged tyre and one merged rim
// for the fixed rear pair). That is 140 meshes across the six-kart grid, and
// three.js re-runs the shadow pass per renderer.render() call, so split-screen
// is ~4 passes over that. The pre-Track-B kart was 8 meshes, so this is still
// a real increase — keep new detail inside an EXISTING bucket rather than
// adding a colour, and prefer baking fixed transforms into a merge over adding
// another node.
//
// Two invariants the rest of Track B depends on:
//  - Every material created here is a fresh per-call instance, never shared
//    between karts: setKartColor tints each kart's chassis independently
//    (§v3 Track B item 4), so a shared material would repaint all six.
//  - Every merged geometry is likewise owned by exactly one mesh, so
//    SceneBuilder.setDriver's dispose-on-unmount contract (it disposes any
//    subtree tagged userData.disposable) can never free geometry another kart
//    is still drawing.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Low-poly defaults. The budget is ~2.5k tris per kart+driver, and a
// SphereGeometry costs widthSeg * (heightSeg*2 - 2) triangles, so 10x8 (140)
// is the workhorse and 12x10 (216) is reserved for heads/bodies that actually
// read as round at split-screen size.
export const SPHERE_W = 10;
export const SPHERE_H = 8;

export interface PartMaterialSpec {
  color: number;
  // Marks the bucket as part of the kart's tintable shell: build() pushes the
  // material into the caller's `tintMaterials` array so setKartColor can
  // retint the *whole* chassis rather than a single body mesh.
  tint?: boolean;
  flat?: boolean; // flatShading — used for faceted bits (spikes, gems)
}

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

  // Emits one merged, shadow-casting mesh per non-empty bucket under `parent`.
  // `yOffset` is applied to every merged geometry, which lets the kart builder
  // author part positions in comfortable ground-relative coordinates (y=0 at
  // the tyre contact patch) while the mesh actually hangs off a body group
  // pivoted higher up for the drift roll.
  build(
    parent: THREE.Object3D,
    opts: { yOffset?: number; tintMaterials?: THREE.MeshLambertMaterial[] } = {},
  ): void {
    const yOffset = opts.yOffset ?? 0;
    for (const key of Object.keys(this.palette) as K[]) {
      const geos = this.buckets.get(key);
      if (!geos || geos.length === 0) continue;
      // mergeGeometries copies into a new buffer, so the sources have to be
      // disposed; a single-geometry bucket skips the copy entirely.
      let merged: THREE.BufferGeometry | null;
      if (geos.length === 1) {
        merged = geos[0];
      } else {
        merged = mergeGeometries(geos, false);
        for (const g of geos) g.dispose();
      }
      if (!merged) {
        console.warn(`[PartAssembler] merge failed for bucket "${key}"`);
        continue;
      }
      if (yOffset !== 0) merged.translate(0, yOffset, 0);
      const spec = this.palette[key];
      const mat = new THREE.MeshLambertMaterial({ color: spec.color, flatShading: spec.flat ?? false });
      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = true;
      mesh.name = key;
      parent.add(mesh);
      if (spec.tint) opts.tintMaterials?.push(mat);
    }
    this.buckets.clear();
  }
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
// vertical offset: the tapered nose cone of every chassis, plus a few
// wedge-shaped body parts. 12 triangles. BoxGeometry(1,1,1) has 24 unshared
// verts (4 per face) and every one of them has z = +-0.5, so classifying by
// sign(z) cleanly separates the front rim from the back rim.
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

// Dome pointing +Y (rotate it to face wherever the shell/cap needs to point).
export function hemisphere(r: number, wSeg = SPHERE_W, hSeg = 5): THREE.BufferGeometry {
  return new THREE.SphereGeometry(r, wSeg, hSeg, 0, Math.PI * 2, 0, Math.PI / 2);
}

export function cyl(rTop: number, rBottom: number, h: number, seg = 10): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(rTop, rBottom, h, seg);
}

export function cone(r: number, h: number, seg = 8): THREE.BufferGeometry {
  return new THREE.ConeGeometry(r, h, seg);
}

// Flat disc facing +Z by default (emblems, mushroom-cap spots, hub caps).
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

// A tapered cylinder stretched between two points — arms, legs, exhaust
// stacks, steering columns. Built once at construction time, so the temp
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
// spots and shell plates. Nudged 4mm proud so it never z-fights the dome.
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

// Debug/budget helper: total triangles under an object (used to verify the
// ~2.5k tris per kart+driver budget in §v3 Track B item 5).
export function countTriangles(root: THREE.Object3D): number {
  let tris = 0;
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const geo = obj.geometry as THREE.BufferGeometry;
    tris += geo.index ? geo.index.count / 3 : geo.attributes.position.count / 3;
  });
  return tris;
}
