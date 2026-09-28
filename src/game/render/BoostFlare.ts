import * as THREE from 'three';

// §v3 Track C2: the exhaust flare — flame cones out of every exhaust stack
// while the kart is boosting (drift release, boost pad, manual BOOST). §v5:
// moved out of the deleted item-visuals module; it never had anything to do
// with items.

const FLARE_LENGTH = 0.55;
// The widest exhaust count across the KartBuilder chassis profiles. The flare
// pools this many cone PAIRS once and hides the surplus, so a mid-lobby
// character re-pick never has to rebuild geometry (see updateBoostFlare).
const FLARE_MAX_EXHAUSTS = 4;

export interface BoostFlare {
  group: THREE.Group;
  materials: THREE.MeshBasicMaterial[];
  // Two per pooled exhaust slot, interleaved [outer0, inner0, outer1, inner1…],
  // so slot `s` is meshes[s * 2] and meshes[s * 2 + 1].
  meshes: THREE.Mesh[];
}

// Two nested cones per exhaust stack (orange outer, yellow inner), apex
// trailing behind the kart. The cones are authored so their BASE sits on the
// group origin and the apex reaches back to -FLARE_LENGTH, which lets the
// caller park the group exactly on the current chassis' tail plane (see
// updateBoostFlare's `tailZ`/`tailY` — the chassis tails differ enough that
// one hard-coded offset would leave a gap behind a short kart and bury the
// flame inside a long one). The x of each plume is likewise read from the
// chassis' own `exhausts` array every frame, so a single centreline stack and
// a row of four both get flame out of the actual pipes.
//
// Parented by the caller to the kart ROOT group so they inherit heading, slope
// pitch and the boost squash/stretch — but not the drift-lean roll, which
// belongs to `body` and would swing the flames off the exhausts. Materials are
// per-kart instances (never shared across karts, matching the chassis tint
// rule); one outer + one inner per flare is enough because the flicker is
// animated on the meshes' scale, not on any material property.
export function buildBoostFlare(): BoostFlare {
  const group = new THREE.Group();
  const makeMaterial = (color: number, opacity: number) =>
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide, // open-ended cones are visible from behind too
    });
  const outerMat = makeMaterial(0xff8c1a, 0.55);
  const innerMat = makeMaterial(0xffe680, 0.85);
  const meshes: THREE.Mesh[] = [];
  for (let s = 0; s < FLARE_MAX_EXHAUSTS; s++) {
    for (const [radius, mat] of [
      [0.15, outerMat],
      [0.08, innerMat],
    ] as const) {
      // ConeGeometry points up (+Y); rotateX(-PI/2) sends the apex to -Z, i.e.
      // streaming out behind the kart (local +Z is the nose, see KartBuilder).
      const geo = new THREE.ConeGeometry(radius, FLARE_LENGTH, 8, 1, true).rotateX(-Math.PI / 2);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(0, 0, -FLARE_LENGTH / 2); // base on the group origin, apex at -FLARE_LENGTH
      mesh.visible = false; // updateBoostFlare shows only the slots this chassis actually has
      group.add(mesh);
      meshes.push(mesh);
    }
  }
  group.visible = false;
  return { group, materials: [outerMat, innerMat], meshes };
}

// Visible only while `boostTimer > 0`; `t` is a monotonically increasing
// seconds accumulator supplying the flicker. `tailZ`/`tailY`/`exhausts` come
// from the kart's CURRENT chassis (KartChassis.rearZ/exhaustY/exhausts),
// re-read every frame so a mid-lobby character re-pick — which swaps the whole
// chassis out from under this flare — repositions it for free. Scalar writes
// only, no allocation.
export function updateBoostFlare(
  flare: BoostFlare,
  boostTimer: number,
  t: number,
  tailZ: number,
  tailY: number,
  exhausts: readonly number[],
) {
  if (boostTimer <= 0) {
    if (flare.group.visible) flare.group.visible = false;
    return;
  }
  flare.group.visible = true;
  flare.group.position.set(0, tailY, tailZ);
  // Two out-of-phase sines instead of Math.random(): a random flicker at 120fps
  // strobes, whereas this reads as a steady flame at any frame rate.
  const flickA = 0.8 + Math.sin(t * 37) * 0.2;
  const flickB = 0.85 + Math.sin(t * 53 + 1.7) * 0.15;
  // The flame shortens as the boost runs out, so the tail telegraphs how much
  // boost is left on the kart you're chasing.
  const fade = Math.min(1, boostTimer * 4);
  const slots = Math.min(exhausts.length, FLARE_MAX_EXHAUSTS);
  for (let i = 0; i < flare.meshes.length; i++) {
    const mesh = flare.meshes[i];
    const slot = i >> 1;
    if (slot >= slots) {
      if (mesh.visible) mesh.visible = false; // surplus pooled cone for this chassis
      continue;
    }
    mesh.visible = true;
    mesh.position.x = exhausts[slot]; // the stack this plume belongs to
    const flick = i % 2 === 0 ? flickA : flickB;
    const lengthScale = fade * (0.9 + flick * 0.1);
    mesh.scale.set(flick, flick, lengthScale);
    // A cone scales about its own centre, so shrinking z alone would pull the
    // flame's BASE backwards off the bumper and leave a gap. Re-centring it
    // keeps the base pinned to the group origin (= the chassis tail) at every
    // length.
    mesh.position.z = (-FLARE_LENGTH * lengthScale) / 2;
  }
}
