import * as THREE from 'three';
import { SHADOW_LIGHT_OFFSET } from './SceneBuilder';
import type { TrackQuery } from '../track/TrackQuery';
import { GRASS_HALF } from '../track/trackData';
import { toonVertexMaterial } from './ToonMaterials';
import { buildCoastProps, type CoastContext } from './coastProps';

// §v5 Capricorn Coast backdrop: a golden-hour tropical coast. Replaces the v3/v4
// meadow (mountain rings, broadleaf scatter, wildflowers) and the v4 'space'
// starfield entirely. What is here:
//   - a shader sky: warm horizon (#FFB36B) up to clear blue (#8FD3F4), with the
//     low sun's glow sitting exactly where the key light comes from;
//   - the ground heightfield (§v3 Track A, kept: near the circuit it copies the
//     track's own — now banked — height; far from it, the coast: cane flats
//     inland rising to hazy hills, a sand beach, the basalt headland, seabed);
//   - an animated toon ocean whose colour comes from the real water depth
//     (shallow #1FA7B8 over the sand, deep #0B5E7A offshore);
//   - props (coastProps.ts): palms, Norfolk pines, cane fields, basalt
//     columns, breakwater rock armour, the harbour (pontoons, moored boats,
//     channel beacon), the beach, offshore islands and the cane-train rail
//     crossing under the jump — every repeated thing instanced or merged, one
//     draw call per type.
// Fog is a warm sea haze in the horizon colour, so everything distant melts
// into the sky rather than ending on a visible edge.

const GROUND_SIZE = 1400;

// §v3 Track A (kept): the ground is a heightfield draped over the circuit's own
// elevation near the track and rolling away into base terrain, on a
// non-uniform grid — fine cells over the circuit's extent, coarser through the
// blend band, geometric growth out to the plane edge — so detail is only spent
// where it is visible. Still purely visual: no collision.
const DETAIL_CELL_METERS = 4;
const MID_CELL_METERS = 6;
const FAR_CELL_GROWTH = 1.4;
const FAR_CELL_MAX = 24;
// DETAIL_PAD must exceed the *mid* tier's would-be clamp radius so every
// vertex a ribbon could constrain sits inside the detail tier.
const DETAIL_PAD = 24;
// Blend band, measured as x/z distance from the track centerline. Inside
// BLEND_INNER the terrain is a rigid copy of the track height; from there it
// smoothsteps out to pure base terrain at BLEND_OUTER_DIST.
const BLEND_INNER_DIST = GRASS_HALF + 4;
const BLEND_OUTER = 45;
export const BLEND_OUTER_DIST = GRASS_HALF + BLEND_OUTER;
// §v5: the same band over water — a causeway whose rock-armoured face drops
// from just outside the verge to the seabed in ~8m (see terrainHeightAt).
const CAUSEWAY_INNER_DIST = GRASS_HALF + 1.5;
const CAUSEWAY_OUTER_DIST = GRASS_HALF + 9.5;
// How far below the local track height the terrain sits where it hugs the
// circuit — hidden under the verge ribbon and the ground skirt.
export const GROUND_SINK = 0.25;
// Anti-"green teeth" guard radius, handed to TrackQuery.terrainTrackField as
// the distance inside which a track sample's ribbon still constrains a terrain
// vertex (a ribbon vertex inside a terrain cell is within GRASS_HALF of its
// own sample, and every corner of that cell within one cell diagonal of it).
// §v5: banking is folded into the same argument inside terrainTrackField
// (each sample's ceiling is its own rolled ribbon height minus the bank's
// slope over one cell diagonal). As in §v3 this is empirically verified rather
// than a proof for ribbon triangles straddling a cell — re-run a census after
// changing the layout, the banks, DETAIL_CELL_METERS or CLAMP_RAMP_SLOPE.
export const TERRAIN_CLAMP_RADIUS = GRASS_HALF + DETAIL_CELL_METERS * Math.SQRT2 + 0.5;
const MID_PAD = BLEND_OUTER_DIST + MID_CELL_METERS;

// §v5 coast. Sea surface height; the esplanade road sits at y=0, the beach
// shelves from there into the water ~30m off its seaward (-x) side.
export const SEA_LEVEL = -1.2;

// The coastline, along +z, with the land on its +x side and the sea on its -x
// side. It wraps the basalt headland (x -214..-30, z 66..166) and then runs
// up the marina's landward shore; the breakwater, the harbour-head hairpin
// and the road back past the marina all sit out in the water on causeways,
// which the heightfield's track blend builds for free.
const COAST: readonly (readonly [number, number])[] = [
  [-34, -760],
  [-34, -150],
  [-30, -70],
  [-28, 20],
  [-30, 72],
  [-52, 88],
  [-100, 80],
  [-150, 66],
  [-196, 80],
  [-214, 110],
  [-200, 140],
  [-168, 156],
  [-120, 160],
  [-60, 166],
  [-42, 178],
  [-38, 240],
  [-40, 330],
  [-36, 760],
];
// Closing the polyline far inland (+x) makes it a land polygon for the
// point-in-polygon side test (robust at convex/concave corners, unlike a
// per-segment cross-product sign).
const LAND_POLYGON: readonly (readonly [number, number])[] = [...COAST, [3000, 760], [3000, -760]];

// Headland: a basalt plateau with cliffs dropping into the bay, irregular
// outline, centred seaward of where the road crosses its landward shoulder.
const HEADLAND_CENTER = [-150, 112] as const;
const HEADLAND_RADIUS = 62;
const HEADLAND_HEIGHT = 13;

// GLSL-style smoothstep: 0 at e0, 1 at e1, in either direction (e0 > e1 is a
// falling ramp). THREE.MathUtils.smoothstep only handles min < max.
function smooth(x: number, e0: number, e1: number): number {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function pointInLand(x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = LAND_POLYGON.length - 1; i < LAND_POLYGON.length; j = i++) {
    const [xi, zi] = LAND_POLYGON[i];
    const [xj, zj] = LAND_POLYGON[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// Signed x/z distance to the coastline: negative on land, positive at sea.
export function coastDistance(x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i < COAST.length - 1; i++) {
    const [ax, az] = COAST[i];
    const [bx, bz] = COAST[i + 1];
    const sx = bx - ax;
    const sz = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * sx + (z - az) * sz) / (sx * sx + sz * sz)));
    best = Math.min(best, Math.hypot(x - (ax + sx * t), z - (az + sz * t)));
  }
  return pointInLand(x, z) ? -best : best;
}

// 0 outside the headland, 1 on its plateau; the cliff is the steep band
// between (radius fraction 0.72..0.98).
export function headlandFactor(x: number, z: number): number {
  const dx = x - HEADLAND_CENTER[0];
  const dz = z - HEADLAND_CENTER[1];
  const theta = Math.atan2(dz, dx);
  const radius = HEADLAND_RADIUS * (1 + 0.12 * Math.sin(3 * theta + 0.4) + 0.07 * Math.sin(7 * theta + 1.3));
  const r = Math.hypot(dx, dz) / radius;
  return smooth(r, 0.98, 0.72);
}

function headlandHeight(x: number, z: number): number {
  const f = headlandFactor(x, z);
  if (f <= 0) return -Infinity;
  const dome = 1 - Math.hypot(x - HEADLAND_CENTER[0], z - HEADLAND_CENTER[1]) / (HEADLAND_RADIUS * 1.2);
  return SEA_LEVEL - 4 + f * (HEADLAND_HEIGHT + 4 + 3 * Math.max(0, dome));
}

// Deterministic base terrain (no noise library, no Math.random()): byte-identical
// across reloads, and reproducible by an offline script.
export function baseTerrainHeight(x: number, z: number): number {
  const d = coastDistance(x, z);
  // Inland: low cane flats that lift a little away from the shore and rise
  // into hazy hills far inland (the sun sets behind them).
  const hills = 34 * smooth(x, 260, 620) * (0.65 + 0.35 * Math.sin(z / 83 + 0.7));
  const land =
    0.9 +
    1.1 * smooth(d, -30, -140) +
    0.35 * Math.sin(x / 41 + z / 57) * Math.cos(z / 37 - 0.4) +
    hills;
  let h: number;
  if (d < -34) h = land;
  else if (d < -6) h = THREE.MathUtils.lerp(0.5, land, smooth(d, -6, -34)); // dry sand up to the dune line
  else if (d < 10) h = THREE.MathUtils.lerp(SEA_LEVEL - 0.9, 0.5, smooth(d, 10, -6)); // wet beach into the water
  else h = Math.max(SEA_LEVEL - 10, SEA_LEVEL - 0.9 - (d - 10) * 0.11); // seabed shelving away
  return Math.max(h, headlandHeight(x, z));
}

// The exact height the ground heightfield takes at (x, z) — shared by the mesh
// and everything planted on it, so the two cannot drift. Near the circuit it
// is the medial-axis-safe weighted blend of the track's own (banked) heights,
// sunk by GROUND_SINK and clamped so it can never poke up through the ribbon;
// far from it, the coast.
export function terrainHeightAt(trackQuery: TrackQuery, x: number, z: number): number {
  const base = baseTerrainHeight(x, z);
  const field = trackQuery.terrainTrackField(x, z, BLEND_OUTER_DIST, TERRAIN_CLAMP_RADIUS);
  if (!field) return base;
  const nearY = field.blendY - GROUND_SINK;
  // §v5: over water the embankment is a steep causeway/breakwater face rather
  // than a 45m-wide rolling blend — otherwise the roads either side of the
  // marina would fill the harbour in with land. The outer edge eases between
  // the two widths as the base height crosses sea level, so the field stays
  // continuous along the shore.
  const landward = smooth(base, SEA_LEVEL - 2.5, SEA_LEVEL + 1);
  const inner = THREE.MathUtils.lerp(CAUSEWAY_INNER_DIST, BLEND_INNER_DIST, landward);
  const outer = THREE.MathUtils.lerp(CAUSEWAY_OUTER_DIST, BLEND_OUTER_DIST, landward);
  const t = smooth(field.dist, inner, outer);
  return Math.min(THREE.MathUtils.lerp(nearY, base, t), field.clampY - GROUND_SINK);
}

// --- palette ------------------------------------------------------------------
const SKY_HORIZON = new THREE.Color(0xffb36b);
const SKY_TOP = new THREE.Color(0x8fd3f4);
// Sea haze: the horizon tone lifted slightly toward the sky, so fogged land,
// sea and islands all converge on the band where the sky meets the water.
const FOG_COLOR = new THREE.Color(0xffc38a);
const FOG_NEAR = 170;
const FOG_FAR = 980;
const SAND = new THREE.Color(0xf4d9a6);
const WET_SAND = new THREE.Color(0xd9b98a);
const GRASS = new THREE.Color(0x8fbf52);
const CANE_GROUND = new THREE.Color(0x6f9d34);
const BASALT = new THREE.Color(0x3b3a48);
const HEADLAND_TOP = new THREE.Color(0xa9ad62);
const HILLS = new THREE.Color(0x7e9a58);

export interface EnvironmentHandles {
  group: THREE.Group;
  ground: THREE.Mesh | null;
  update?: (time: number) => void;
}

// --- sky -------------------------------------------------------------------------
// §v5: the gradient and the sun glow are computed per pixel from the *view
// direction* (world position minus the camera), so the horizon sits in the
// right place from any camera even though the dome is one fixed sphere. It is
// a backdrop: no depth test or write, drawn first.
function buildSky(sunDir: THREE.Vector3): THREE.Mesh {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uHorizon: { value: SKY_HORIZON.clone() },
      uTop: { value: SKY_TOP.clone() },
      uSunDir: { value: sunDir.clone().normalize() },
      uSun: { value: new THREE.Color(0xfff1c9) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uHorizon;
      uniform vec3 uTop;
      uniform vec3 uSunDir;
      uniform vec3 uSun;
      varying vec3 vWorld;
      void main() {
        vec3 dir = normalize(vWorld - cameraPosition);
        float h = clamp(dir.y, 0.0, 1.0);
        vec3 col = mix(uHorizon, uTop, smoothstep(0.0, 0.42, pow(h, 0.8)));
        float sun = max(dot(dir, uSunDir), 0.0);
        col = mix(col, uSun, smoothstep(0.9975, 0.999, sun));      // disc
        col += uSun * 0.35 * pow(sun, 24.0);                         // glow
        col = mix(col, uHorizon, (1.0 - smoothstep(-0.02, 0.06, dir.y)) * 0.6); // haze band
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(900, 32, 16), material);
  mesh.renderOrder = -1000;
  mesh.frustumCulled = false;
  return mesh;
}

// --- ocean -----------------------------------------------------------------------
// One axis of a grid whose cells are `inner` metres inside ±innerHalf of
// `center` and grow geometrically (to `maxCell`) out to ±half.
function growingAxis(center: number, innerHalf: number, half: number, inner: number, maxCell: number): number[] {
  const coords: number[] = [];
  for (let v = -innerHalf; v <= innerHalf + 1e-6; v += inner) coords.push(center + v);
  let step = inner;
  let p = innerHalf;
  const outer: number[] = [];
  while (p < half) {
    step = Math.min(step * 1.45, maxCell);
    p = Math.min(half, p + step);
    outer.push(p);
  }
  for (const o of outer) coords.push(center + o);
  for (const o of outer) coords.unshift(center - o);
  return coords;
}

// §v5: the toon ocean. Colour is driven by a per-vertex `depth` attribute —
// the real water depth over the terrain (sea level minus ground height) —
// banded into three toon steps from shallow turquoise over the sand to deep
// blue offshore, with a lapping foam line where the depth runs out and a few
// sparkle bands drifting with time. Vertices also bob a few centimetres. The
// fog chunks make it haze into the horizon like everything else.
function buildOcean(ground: (x: number, z: number) => number, centerX: number, centerZ: number): { mesh: THREE.Mesh; material: THREE.ShaderMaterial } {
  const xs = growingAxis(centerX, 700, 2600, 20, 260).filter((x) => x < 240);
  const zs = growingAxis(centerZ, 700, 2600, 20, 260);
  const nx = xs.length;
  const nz = zs.length;
  const positions = new Float32Array(nx * nz * 3);
  const depth = new Float32Array(nx * nz);
  const inland = new Uint8Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const v = j * nx + i;
      const x = xs[i];
      const z = zs[j];
      positions.set([x, SEA_LEVEL, z], v * 3);
      const inPlane = Math.abs(x - centerX) <= GROUND_SIZE / 2 && Math.abs(z - centerZ) <= GROUND_SIZE / 2;
      depth[v] = inPlane ? SEA_LEVEL - ground(x, z) : SEA_LEVEL - baseTerrainHeight(x, z);
      inland[v] = coastDistance(x, z) < -16 ? 1 : 0;
    }
  }
  const indices: number[] = [];
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      // Skip quads entirely under dry land — they could never be seen — and
      // any well inland of the coast: where a banked corner's verge digs the
      // terrain a little below sea level there, it is a dip, not a lagoon.
      if (Math.max(depth[a], depth[b], depth[c], depth[d]) < -1.5) continue;
      if (inland[a] && inland[b] && inland[c] && inland[d]) continue;
      indices.push(a, c, b, b, c, d);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('depth', new THREE.BufferAttribute(depth, 1));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();

  const material = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uTime: { value: 0 },
        uShallow: { value: new THREE.Color(0x1fa7b8) },
        uDeep: { value: new THREE.Color(0x0b5e7a) },
        uFoam: { value: new THREE.Color(0xf4fbf8) },
        uSunDir: { value: SHADOW_LIGHT_OFFSET.clone().normalize() },
        uGlint: { value: new THREE.Color(0xffe2b0) },
      },
    ]),
    vertexShader: /* glsl */ `
      attribute float depth;
      uniform float uTime;
      varying float vDepth;
      varying vec3 vWorld;
      #include <fog_pars_vertex>
      void main() {
        vDepth = depth;
        vec4 w = modelMatrix * vec4(position, 1.0);
        float swell = clamp(depth * 0.25, 0.0, 1.0);
        w.y += (sin(w.x * 0.045 + uTime * 0.9) * 0.08 + cos(w.z * 0.06 - uTime * 0.7) * 0.06) * swell;
        vWorld = w.xyz;
        vec4 mvPosition = viewMatrix * w;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uShallow;
      uniform vec3 uDeep;
      uniform vec3 uFoam;
      uniform vec3 uSunDir;
      uniform vec3 uGlint;
      varying float vDepth;
      varying vec3 vWorld;
      #include <fog_pars_fragment>
      void main() {
        // Three toon bands of depth: shallow, mid, deep.
        float t = clamp(vDepth / 7.0, 0.0, 1.0);
        float band = floor(t * 3.0) / 2.0;
        vec3 col = mix(uShallow, uDeep, clamp(band, 0.0, 1.0));
        // Lapping shoreline foam: a line that breathes in and out.
        float lap = 0.35 + 0.22 * sin(uTime * 1.4 + vWorld.x * 0.08 + vWorld.z * 0.05);
        float foam = step(vDepth, lap) * step(-0.2, vDepth);
        // Sun glints: crossing sine ridges, brightest looking toward the sun.
        vec3 view = normalize(cameraPosition - vWorld);
        float toward = pow(max(dot(reflect(-uSunDir, vec3(0.0, 1.0, 0.0)), -view), 0.0), 3.0);
        // Two drifting ridge fields at irrational angles so the sparkles never
        // line up into a grid; faded out with distance (they would alias into
        // a dotted pattern) and concentrated in the sun's reflection.
        float ridge = sin(vWorld.x * 0.23 + vWorld.z * 0.11 + sin(vWorld.z * 0.031) * 3.0 + uTime * 1.2)
                    * sin(vWorld.x * 0.071 - vWorld.z * 0.19 + sin(vWorld.x * 0.027) * 2.5 - uTime * 0.8);
        float near = 1.0 - smoothstep(40.0, 220.0, length(cameraPosition - vWorld));
        float glint = step(0.93, ridge) * (0.15 + 0.85 * toward) * near;
        // §v5: glints are HDR (> 1) so the bloom pass (PostFX) catches them;
        // on Low quality they simply clip to the same bright sparkle as before.
        col = mix(col, uGlint * 2.2, glint * 0.55);
        col = mix(col, uFoam, foam * 0.9);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
    fog: true,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = false;
  return { mesh, material };
}

// --- ground heightfield -------------------------------------------------------------
// One axis of the non-uniform ground grid (§v3 Track A): DETAIL_CELL_METERS
// across the circuit's extent + DETAIL_PAD, MID_CELL_METERS out to MID_PAD, then
// cells growing by FAR_CELL_GROWTH up to FAR_CELL_MAX out to the plane's edge.
function buildGroundAxis(trackMin: number, trackMax: number, center: number): number[] {
  const half = GROUND_SIZE / 2;
  const lo = center - half;
  const hi = center + half;
  const clampAxis = (v: number) => Math.min(hi, Math.max(lo, v));
  const d0 = clampAxis(Math.floor((trackMin - DETAIL_PAD) / DETAIL_CELL_METERS) * DETAIL_CELL_METERS);
  const d1 = clampAxis(Math.ceil((trackMax + DETAIL_PAD) / DETAIL_CELL_METERS) * DETAIL_CELL_METERS);
  const midSpan = Math.ceil((MID_PAD - DETAIL_PAD) / MID_CELL_METERS) * MID_CELL_METERS;
  const m0 = clampAxis(d0 - midSpan);
  const m1 = clampAxis(d1 + midSpan);

  const low: number[] = [];
  let step = MID_CELL_METERS;
  let p = m0;
  while (p > lo) {
    step = Math.min(step * FAR_CELL_GROWTH, FAR_CELL_MAX);
    p = p - lo <= step * 1.5 ? lo : p - step;
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
  while (p < hi) {
    step = Math.min(step * FAR_CELL_GROWTH, FAR_CELL_MAX);
    p = hi - p <= step * 1.5 ? hi : p + step;
    coords.push(p);
  }
  return coords;
}

// Vertex colour for the ground: sand on the beach and the dunes, wet sand
// under the waterline, basalt on the headland cliffs, dry grass on its top,
// cane-green on the cane flats, and olive hills far inland.
function groundColor(x: number, z: number, y: number, trackDist: number, out: THREE.Color): THREE.Color {
  const d = coastDistance(x, z);
  const cliff = headlandFactor(x, z);
  if (cliff > 0.02 && cliff < 0.97 && y > SEA_LEVEL - 1) return out.copy(BASALT).lerp(HEADLAND_TOP, cliff > 0.85 ? (cliff - 0.85) / 0.12 : 0);
  if (cliff >= 0.97) return out.copy(HEADLAND_TOP);
  if (y < SEA_LEVEL + 0.25 && d > -16) return out.copy(WET_SAND);
  if (d > -34) return out.copy(SAND).lerp(GRASS, smooth(d, -24, -36));
  const inland = smooth(x, 240, 420);
  out.copy(GRASS).lerp(CANE_GROUND, trackDist > GRASS_HALF ? 0.8 * caneFade(x, z) : 0);
  return out.lerp(HILLS, inland);
}

// The cane growing area (also used by coastProps for planting): inland of the
// dune line, clear of the headland, within reach of the circuit, and not the
// grass lawn behind the esplanade.
export function isCaneLand(x: number, z: number): boolean {
  if (x < -36 || x > 240 || z < -150 || z > 330) return false;
  if (coastDistance(x, z) > -40 || headlandFactor(x, z) > 0) return false;
  if (x < 34 && z < 95) return false; // esplanade lawn (palms, pines)
  return true;
}

// 0..1 soft version of isCaneLand for the ground tint under the cane, so the
// darker soil fades out over ~30m instead of ending on the rectangle's edges.
function caneFade(x: number, z: number): number {
  const edge = Math.min(x + 36, 240 - x, z + 150, 330 - z);
  const lawnEdge = Math.max(x - 34, z - 95); // > 0 outside the esplanade lawn block
  const f = smooth(edge, 0, 30) * smooth(-coastDistance(x, z), 40, 60) * (1 - smooth(headlandFactor(x, z), 0, 0.2));
  return f * smooth(lawnEdge, 0, 25);
}

function buildGroundPlane(trackQuery: TrackQuery, centerX: number, centerZ: number): THREE.Mesh {
  console.time('[Environment] ground heightfield');
  const bounds = trackQuery.centerlineBounds();
  const xs = buildGroundAxis(bounds.minX, bounds.maxX, centerX);
  const zs = buildGroundAxis(bounds.minZ, bounds.maxZ, centerZ);
  const nx = xs.length;
  const nz = zs.length;
  const positions = new Float32Array(nx * nz * 3);
  const colors = new Float32Array(nx * nz * 3);
  const c = new THREE.Color();
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = xs[i];
      const z = zs[j];
      const v = j * nx + i;
      const y = terrainHeightAt(trackQuery, x, z);
      positions.set([x, y, z], v * 3);
      const field = trackQuery.terrainTrackField(x, z, BLEND_OUTER_DIST, TERRAIN_CLAMP_RADIUS);
      groundColor(x, z, y, field ? field.dist : Infinity, c);
      // Broad, gentle mottling so large flats don't read as one flat colour.
      const m = 0.94 + 0.06 * Math.sin(x * 0.043 + Math.sin(z * 0.021) * 2) * Math.cos(z * 0.037);
      colors.set([c.r * m, c.g * m, c.b * m], v * 3);
    }
  }
  // Winding (a, c, b) / (b, c, d) so face normals come out +Y. 16-bit indices
  // while the grid fits (it does, ~20k verts), 32-bit as a safety net.
  const indexCount = (nx - 1) * (nz - 1) * 6;
  const indices = nx * nz <= 65536 ? new Uint16Array(indexCount) : new Uint32Array(indexCount);
  let w = 0;
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i;
      const b = a + 1;
      const cc = a + nx;
      const d = cc + 1;
      indices[w++] = a;
      indices[w++] = cc;
      indices[w++] = b;
      indices[w++] = b;
      indices[w++] = cc;
      indices[w++] = d;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  console.timeEnd('[Environment] ground heightfield');
  console.log(`[Environment] ground heightfield: ${nx}x${nz} verts, ${(nx - 1) * (nz - 1) * 2} tris`);
  const ground = new THREE.Mesh(geometry, toonVertexMaterial());
  ground.receiveShadow = true; // §Phase 4 item 3
  return ground;
}

export function buildEnvironment(scene: THREE.Scene, trackQuery: TrackQuery): EnvironmentHandles {
  scene.background = FOG_COLOR.clone();
  scene.fog = new THREE.Fog(FOG_COLOR.getHex(), FOG_NEAR, FOG_FAR);

  // Everything is placed relative to the circuit's own extent, never a fixed
  // world radius (§v3 polish).
  const bounds = trackQuery.centerlineBounds();
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerZ = (bounds.minZ + bounds.maxZ) / 2;

  const group = new THREE.Group();
  group.name = 'environment';
  const sunDir = SHADOW_LIGHT_OFFSET.clone().normalize();
  group.add(buildSky(sunDir));
  const ground = buildGroundPlane(trackQuery, centerX, centerZ);
  group.add(ground);

  const groundAt = (x: number, z: number) => terrainHeightAt(trackQuery, x, z);
  const ocean = buildOcean(groundAt, centerX, centerZ);
  group.add(ocean.mesh);

  const ctx: CoastContext = {
    query: trackQuery,
    groundAt,
    coastDistance,
    headlandFactor,
    isCaneLand,
    seaLevel: SEA_LEVEL,
    headlandCenter: HEADLAND_CENTER,
    headlandRadius: HEADLAND_RADIUS,
    blendOuter: BLEND_OUTER_DIST,
    clampRadius: TERRAIN_CLAMP_RADIUS,
  };
  const props = buildCoastProps(ctx);
  group.add(props.group);
  scene.add(group);

  return {
    group,
    ground,
    update: (time: number) => {
      ocean.material.uniforms.uTime.value = time;
      props.update(time);
    },
  };
}
