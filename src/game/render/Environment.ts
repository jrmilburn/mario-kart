import * as THREE from 'three';
import { buildGrassTexture } from './textures';
import type { TrackQuery } from '../track/TrackQuery';
import { GRASS_HALF } from '../track/trackData';

// §Phase 4 item 2. Replaces the old flat sky-blue background + single-color
// ground plane with: a gradient sky dome, a low-poly distant mountain ring,
// a handful of billboard clouds, fog retuned to the new palette, and a
// grass-textured ground plane matching the track's grass ribbon tone. Called
// once at scene setup; returns the pieces main.ts might want a handle to
// (currently just the ground, for parity with the old buildGround signature).

const SKY_RADIUS = 600;
// §Phase 4 item 5: the new ~1001m layout's hairpin reaches ~275m from the
// origin (plus grass/prop halo), so the ring needs more headroom than the
// old ~620m track required to stay a clearly-distant backdrop.
const MOUNTAIN_RING_RADIUS = 400;
const GROUND_SIZE = 1400;
// §v3 Track A: raised from 12m. The ground is no longer a flat plane viewed
// nearly edge-on at the horizon -- it now has real slopes catching the light,
// and a 12m tile over 1400m (117 repeats) shimmered on them. A slightly
// coarser tile trades a little close-up detail for a calmer far field; the
// grass *ribbon* keeps its own tighter TEXTURE_V_SCALE tiling, and the two
// only meet where the ribbon is opaque over the terrain anyway.
const GROUND_TEXTURE_TILE_METERS = 16;

// §v3 Track A (the "flat green patches" bug): the ground used to be a single
// flat 1400x1400 quad at y=-0.05. Phase 5 gave the track real elevation
// (trackData CONTROL_POINTS run from -1.8m in the double-apex dip to +8m at
// the esses crest), so everywhere the circuit dipped below -0.05 the plane
// was drawn *over* the road and grass ribbons and the kart appeared to drive
// submerged in green. The plane is now a heightfield that copies the track's
// own height near the circuit and rolls away into gentle base terrain far
// from it. It is still purely visual -- no collision (off-track driving stays
// bounded by the analytic wall clamp at GRASS_HALF).
// §v3 Track A review finding #3: the grid is *non-uniform*, in three tiers. A
// flat 6m grid over the whole 1400x1400 plane was 54,756 verts / 108,578
// triangles in one un-chunked mesh whose ~990m bounding sphere never culls, so
// split-screen vertex-processed the entire backdrop twice a frame -- and over
// half of it sits past FOG_FAR (340m), where it is a uniform fog colour
// carrying zero information. Detail is now spent only where it is visible.
// Measured on this layout: 113x171 = 19,323 verts / 38,080 triangles, a 2.85x
// cut, still one mesh (so no T-junction cracks and no extra draw call).
//
// Detail tier: fine cells over the circuit's own extent plus DETAIL_PAD. The
// cell size here is what sets TERRAIN_CLAMP_RADIUS below, and that radius is
// what decides how far outside the grass the anti-teeth clamp digs -- 6m cells
// gave a 22.5m radius, which on the esses (where the circuit doubles back ~20m
// away and ~2m lower) dragged the terrain ~1.3m further down than the local
// road, leaving trackside props hanging in the air (review finding #2). 4m
// cells shrink it to 20.2m, which is inside that doubling-back distance.
const DETAIL_CELL_METERS = 4;
// Mid tier: the rest of the blend band, where the terrain is still shaped by
// the circuit but the clamp can no longer bind, so coarser cells cost nothing.
const MID_CELL_METERS = 6;
// Far field: cells grow geometrically to a cap. Everything out here is flat
// base terrain, most of it past FOG_FAR.
const FAR_CELL_GROWTH = 1.4;
const FAR_CELL_MAX = 24;
// DETAIL_PAD must exceed the *mid* tier's would-be clamp radius
// (GRASS_HALF + 6m*sqrt2 + 0.5 = 22.5m) so that every vertex a ribbon could
// possibly constrain sits strictly inside the detail tier and is therefore
// surrounded only by DETAIL_CELL_METERS cells -- that is what makes a single
// TERRAIN_CLAMP_RADIUS constant valid across the whole non-uniform grid.
const DETAIL_PAD = 24;
// Blend band, measured as x/z distance from the track centerline. Inside
// BLEND_INNER the terrain is a rigid copy of the track height; from there it
// smoothsteps out to pure base terrain at BLEND_OUTER_DIST.
const BLEND_INNER_DIST = GRASS_HALF + 4;
const BLEND_OUTER = 45;
const BLEND_OUTER_DIST = GRASS_HALF + BLEND_OUTER;
// How far below the local track height the terrain sits where it hugs the
// circuit -- enough to stay hidden under the grass ribbon and the ground
// skirt, small enough that there's no visible step at the ribbon edge.
// Exported because TrackBuilder plants trackside props on the same floor the
// terrain is clamped to -- see propGroundY there.
export const GROUND_SINK = 0.25;
// Anti-"green teeth" guard radius, handed to TrackQuery.terrainTrackField as
// the distance inside which a track sample's ribbon still constrains this
// terrain vertex. With multi-metre cells and a curving 14m-half-width ribbon
// on a grade, a cell corner can otherwise land high enough to poke through the
// grass.
//
// The derivation: take a ribbon vertex P (at most GRASS_HALF from its own
// centerline sample S, and P.y === S.y since `right` is horizontal) sitting
// inside a terrain cell. Every corner V of that cell is within one cell
// diagonal of P, so |V - S| <= GRASS_HALF + cellDiagonal; clamping V to
// (min track height within that radius) - GROUND_SINK forces
// V.y <= S.y - GROUND_SINK = P.y - GROUND_SINK, and a rendered triangle only
// interpolates a convex combination of its corners.
//
// §v3 Track A review finding #4: that argument covers ribbon *vertices* that
// land inside a cell, not ribbon *triangles* that straddle one with all three
// vertices outside (a grass quad is 8m x ~1.67m, wider than a 4m cell), so it
// is not a proof -- a fully conservative bound would add the quad diameter
// (~29.7m) and dig the terrain much deeper for no observed benefit. Treat the
// number as empirically verified on this layout rather than derived: the
// offline census (rebuild the field, then evaluate the *rendered* triangles --
// not the pointwise field -- under every ribbon cross-section at 0.25m lateral
// steps across all 600 samples) reports worst (terrain - ribbon) of exactly
// -0.2500m and worst (terrain - road) of exactly -0.2500m, i.e. zero breaches
// with the full GROUND_SINK as margin. Re-run that census after any change to
// the track geometry, to DETAIL_CELL_METERS, or to CLAMP_RAMP_SLOPE in
// TrackQuery.
export const TERRAIN_CLAMP_RADIUS = GRASS_HALF + DETAIL_CELL_METERS * Math.SQRT2 + 0.5;
// Outer edge of the mid tier: one cell past where terrainTrackField stops
// returning anything, i.e. the last vertex whose height the circuit shapes.
const MID_PAD = BLEND_OUTER_DIST + MID_CELL_METERS;

// Deterministic rolling base terrain: a few summed sines, no noise library and
// no Math.random(), so the far field is byte-identical across reloads and an
// offline script can reproduce the whole field exactly for verification.
// Wavelengths are long
// (~95-190m) and the amplitude modest (~3.4m peak) so it reads as soft hills
// rather than dunes; the whole field is biased ~1.5m below zero so the circuit
// visibly sits *on* the ground rather than being embedded in it.
const BASE_TERRAIN_MEAN = -1.5;
const TAU = Math.PI * 2;

function baseTerrainHeight(x: number, z: number): number {
  return (
    1.8 * Math.sin((TAU * x) / 190 + 0.6) * Math.cos((TAU * z) / 175 - 1.1) +
    1.1 * Math.sin((TAU * (x + z * 0.7)) / 128 + 2.3) +
    0.5 * Math.cos((TAU * (x * 0.6 - z)) / 96 - 0.4) +
    BASE_TERRAIN_MEAN
  );
}

const SKY_TOP = new THREE.Color(0x2f7fd6);
const SKY_HORIZON = new THREE.Color(0xbde3ff);
const FOG_COLOR = SKY_HORIZON.clone();
const FOG_NEAR = 90;
const FOG_FAR = 340;

export interface EnvironmentHandles {
  group: THREE.Group;
  ground: THREE.Mesh;
}

// Inverted sphere, vertically gradiented via vertex colors (horizon tone at
// the equator/below, sky-top tone overhead) — cheap, no custom shader needed.
// `fog: false` keeps the dome's own gradient readable; letting scene fog
// tint it would just wash the whole sphere to a flat fog color.
function buildSkyDome(): THREE.Mesh {
  const geometry = new THREE.SphereGeometry(SKY_RADIUS, 24, 16);
  const pos = geometry.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const t = THREE.MathUtils.clamp(THREE.MathUtils.mapLinear(y, -SKY_RADIUS * 0.1, SKY_RADIUS * 0.9, 0, 1), 0, 1);
    c.copy(SKY_HORIZON).lerp(SKY_TOP, t);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false });
  return new THREE.Mesh(geometry, material);
}

// A ring of irregular low-poly cones scattered around the track at a large
// radius, tinted blue-purple for atmospheric-perspective distance haze.
// Fog stays enabled here so they fade toward the horizon color at the edges.
function buildMountainRing(): THREE.Group {
  const group = new THREE.Group();
  const count = 26;
  const geometry = new THREE.ConeGeometry(1, 1, 5);
  geometry.translate(0, 0.5, 0); // base sits at local y=0, so per-instance scale.y controls height cleanly
  const material = new THREE.MeshLambertMaterial({ vertexColors: true });
  const mesh = new THREE.InstancedMesh(geometry, material, count);

  const dummy = new THREE.Object3D();
  const baseColor = new THREE.Color(0x5c6f92);
  const shaded = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.2;
    const radius = MOUNTAIN_RING_RADIUS + (Math.random() - 0.5) * 50;
    const height = 45 + Math.random() * 75;
    const widthX = 35 + Math.random() * 45;
    const widthZ = 35 + Math.random() * 45;
    dummy.position.set(Math.sin(angle) * radius, -8, Math.cos(angle) * radius);
    dummy.rotation.y = Math.random() * Math.PI * 2;
    dummy.scale.set(widthX, height, widthZ);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    shaded.copy(baseColor).multiplyScalar(0.75 + Math.random() * 0.45);
    mesh.setColorAt(i, shaded);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  group.add(mesh);
  return group;
}

function buildCloudTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255,255,255,0.9)');
  gradient.addColorStop(0.6, 'rgba(255,255,255,0.5)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

// A handful of camera-facing (THREE.Sprite auto-billboards) soft white blobs
// scattered high overhead. One shared material/texture across all of them.
function buildClouds(): THREE.Group {
  const group = new THREE.Group();
  const material = new THREE.SpriteMaterial({
    map: buildCloudTexture(),
    transparent: true,
    depthWrite: false,
    fog: false,
  });
  const count = 12;
  for (let i = 0; i < count; i++) {
    const sprite = new THREE.Sprite(material);
    const angle = Math.random() * Math.PI * 2;
    const radius = 110 + Math.random() * 170;
    const scale = 28 + Math.random() * 38;
    sprite.position.set(Math.sin(angle) * radius, 55 + Math.random() * 45, Math.cos(angle) * radius);
    sprite.scale.set(scale, scale * 0.55, 1);
    group.add(sprite);
  }
  return group;
}

// One axis (x or z) of the non-uniform ground grid, given the circuit's extent
// along that axis: DETAIL_CELL_METERS steps across [trackMin - DETAIL_PAD,
// trackMax + DETAIL_PAD], MID_CELL_METERS out to MID_PAD, then cells growing
// by FAR_CELL_GROWTH up to FAR_CELL_MAX out to the plane's edge. The final far
// step is absorbed into the edge rather than left as a sliver, so the outermost
// cells never degenerate into near-zero-area triangles.
function buildGroundAxis(trackMin: number, trackMax: number): number[] {
  const half = GROUND_SIZE / 2;
  const clampAxis = (v: number) => Math.min(half, Math.max(-half, v));
  const d0 = clampAxis(Math.floor((trackMin - DETAIL_PAD) / DETAIL_CELL_METERS) * DETAIL_CELL_METERS);
  const d1 = clampAxis(Math.ceil((trackMax + DETAIL_PAD) / DETAIL_CELL_METERS) * DETAIL_CELL_METERS);
  const midSpan = Math.ceil((MID_PAD - DETAIL_PAD) / MID_CELL_METERS) * MID_CELL_METERS;
  const m0 = clampAxis(d0 - midSpan);
  const m1 = clampAxis(d1 + midSpan);

  // Far field on the low side: walked outward from m0 so the growth starts
  // from a mid-tier cell, then reversed into ascending order.
  const low: number[] = [];
  let step = MID_CELL_METERS;
  let p = m0;
  while (p > -half) {
    step = Math.min(step * FAR_CELL_GROWTH, FAR_CELL_MAX);
    p = p + half <= step * 1.5 ? -half : p - step;
    low.push(p);
  }
  low.reverse();

  const coords = low;
  for (let v = m0; v < d0 - 1e-6; v += MID_CELL_METERS) coords.push(v);
  for (let v = d0; v < d1 - 1e-6; v += DETAIL_CELL_METERS) coords.push(v);
  for (let v = d1; v < m1 - 1e-6; v += MID_CELL_METERS) coords.push(v);
  coords.push(m1);

  step = MID_CELL_METERS;
  p = m1;
  while (p < half) {
    step = Math.min(step * FAR_CELL_GROWTH, FAR_CELL_MAX);
    p = half - p <= step * 1.5 ? half : p + step;
    coords.push(p);
  }
  return coords;
}

// Large ground surface beneath everything for far-field coverage beyond the
// modeled grass ribbon, textured with the same procedural grass so the two
// blend seamlessly instead of the old flat-color ground meeting a
// vertex-colored ribbon at a visible tone mismatch.
//
// §v3 Track A: now a heightfield rather than a flat quad (see the constant
// block above for the bug this fixes). Needs a built TrackQuery, which is why
// main.ts now builds the track *before* the environment.
function buildGroundPlane(trackQuery: TrackQuery): THREE.Mesh {
  const texture = buildGrassTexture();
  const material = new THREE.MeshLambertMaterial({ map: texture });

  console.time('[Environment] ground heightfield');
  const bounds = trackQuery.centerlineBounds();
  const xs = buildGroundAxis(bounds.minX, bounds.maxX);
  const zs = buildGroundAxis(bounds.minZ, bounds.maxZ);
  const nx = xs.length;
  const nz = zs.length;

  const positions = new Float32Array(nx * nz * 3);
  const uvs = new Float32Array(nx * nz * 2);
  for (let j = 0; j < nz; j++) {
    const z = zs[j];
    for (let i = 0; i < nx; i++) {
      const x = xs[i];
      const v = j * nx + i;
      const base = baseTerrainHeight(x, z);
      const field = trackQuery.terrainTrackField(x, z, BLEND_OUTER_DIST, TERRAIN_CLAMP_RADIUS);
      let y = base;
      if (field) {
        // Near-field target: the medial-axis-safe weighted blend of the track
        // heights around this point (see TrackQuery's BLEND_EPS_SQ comment for
        // why it is not simply the nearest branch's height), sunk a little so
        // there's no coincident-surface z-fighting with the grass ribbon.
        const nearY = field.blendY - GROUND_SINK;
        const t = THREE.MathUtils.smoothstep(field.dist, BLEND_INNER_DIST, BLEND_OUTER_DIST);
        y = THREE.MathUtils.lerp(nearY, base, t);
        // Hard requirement (§v3 Track A): near the circuit the terrain must
        // never poke above the grass ribbon. The smoothstep alone doesn't
        // guarantee it once cells are metres wide and the ribbon curves on a
        // grade. Applied unconditionally rather than gated on `dist` -- the
        // ceiling's ramp already makes it non-binding away from the circuit,
        // and a distance gate would put a step back into the field.
        y = Math.min(y, field.clampY - GROUND_SINK);
      }
      positions[v * 3] = x;
      positions[v * 3 + 1] = y;
      positions[v * 3 + 2] = z;
      // World-space UVs (not the 0..1 span a PlaneGeometry would give), so the
      // grass tile stays a fixed size in meters even though the cells don't.
      uvs[v * 2] = x / GROUND_TEXTURE_TILE_METERS;
      uvs[v * 2 + 1] = z / GROUND_TEXTURE_TILE_METERS;
    }
  }

  // Winding is (a, c, b) / (b, c, d) so the face normal comes out +Y for a
  // grid indexed with x increasing along i and z increasing along j.
  // 16-bit indices while the grid fits in them (it does at these tier sizes --
  // ~19k verts), so the mesh doesn't need OES_element_index_uint on a WebGL1
  // phone; the 32-bit path is just a safety net if the tiers are widened.
  const indexCount = (nx - 1) * (nz - 1) * 6;
  const indices = nx * nz <= 65536 ? new Uint16Array(indexCount) : new Uint32Array(indexCount);
  let w = 0;
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      indices[w++] = a;
      indices[w++] = c;
      indices[w++] = b;
      indices[w++] = b;
      indices[w++] = c;
      indices[w++] = d;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  console.timeEnd('[Environment] ground heightfield');
  console.log(`[Environment] ground heightfield: ${nx}x${nz} verts, ${(nx - 1) * (nz - 1) * 2} tris`);

  const ground = new THREE.Mesh(geometry, material);
  ground.receiveShadow = true; // §Phase 4 item 3
  return ground;
}

export function buildEnvironment(scene: THREE.Scene, trackQuery: TrackQuery): EnvironmentHandles {
  scene.background = SKY_HORIZON.clone();
  scene.fog = new THREE.Fog(FOG_COLOR.getHex(), FOG_NEAR, FOG_FAR);

  const group = new THREE.Group();
  group.add(buildSkyDome());
  group.add(buildMountainRing());
  group.add(buildClouds());
  const ground = buildGroundPlane(trackQuery);
  group.add(ground);
  scene.add(group);

  return { group, ground };
}
