import * as THREE from 'three';
import { buildGrassTexture } from './textures';
import { SHADOW_LIGHT_OFFSET } from './SceneBuilder';
import type { TrackQuery } from '../track/TrackQuery';
import type { MapStyle } from '../track/maps';
import { GRASS_HALF } from '../track/trackData';

// §Phase 4 item 2. Replaces the old flat sky-blue background + single-color
// ground plane with: a gradient sky dome, a low-poly distant mountain ring,
// a handful of billboard clouds, fog retuned to the new palette, and a
// grass-textured ground plane matching the track's grass ribbon tone. Called
// once at scene setup; returns the pieces main.ts might want a handle to
// (currently just the ground, for parity with the old buildGround signature).

const SKY_RADIUS = 600;
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

// Seeded PRNG (mulberry32) for everything scattered in this file. The terrain
// itself is already deterministic; making the scenery deterministic too means
// the whole backdrop is reproducible across reloads (and by an offline script)
// rather than reshuffling every time the page is opened.
function makeRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function baseTerrainHeight(x: number, z: number): number {
  return (
    1.8 * Math.sin((TAU * x) / 190 + 0.6) * Math.cos((TAU * z) / 175 - 1.1) +
    1.1 * Math.sin((TAU * (x + z * 0.7)) / 128 + 2.3) +
    0.5 * Math.cos((TAU * (x * 0.6 - z)) / 96 - 0.4) +
    BASE_TERRAIN_MEAN
  );
}

// §v3 polish: a three-stop sky (warm haze at the horizon -> clean blue at
// eye level -> deep blue overhead) instead of the old two-stop ramp. The warm
// band is what makes the horizon read as air rather than as a colour boundary,
// and it is the tone everything distant hazes toward.
const SKY_TOP = new THREE.Color(0x1f63c4);
const SKY_MID = new THREE.Color(0x7fb9ee);
const SKY_HORIZON = new THREE.Color(0xdfeeff);
const FOG_COLOR = SKY_HORIZON.clone();
const FOG_NEAR = 110;
const FOG_FAR = 420;

// §v3 polish scenery. The old backdrop was one ring of cones at a fixed 400m
// -- past FOG_FAR, so linear fog painted every one of them 100% fog colour and
// they were literally invisible against the sky. The replacement is three
// layers, all sized and positioned relative to the *circuit's* own extent
// (never a fixed world radius: the hairpin already reaches ~275m from the
// origin, so a hard-coded ring would sit on top of the track):
//   - a scatter belt of trees/rocks/bushes filling the ground between the
//     grass verge and the hills, planted on the real terrain height,
//   - a ring of rolling green hills just beyond the circuit,
//   - a ring of taller, hazier, snow-capped peaks behind those.
// The two ridges opt out of scene fog (`fog: false`) and bake their own
// distance haze into vertex colours instead, which is what lets them stay
// visible past FOG_FAR while still reading as far away.
// All four ring pads are measured from the circuit's bounding radius. The
// *_CLEAR_PAD values are the ones that matter for correctness: buildRidge
// guarantees no vertex of a ridge ever comes closer to the circuit's centroid
// than that, by pushing any peak whose own skirt would breach it further out.
// Without that guard a wide peak sitting at the inner edge of its ring can
// reach ~135m back toward the circuit and plant a hillside on the racing line.
const HILL_CLEAR_PAD = 90;
const HILL_RING_INNER_PAD = 140;
const HILL_RING_OUTER_PAD = 215;
const PEAK_CLEAR_PAD = 200;
const PEAK_RING_INNER_PAD = 230;
const PEAK_RING_OUTER_PAD = 300;
// Vegetation stops just short of where the hills are allowed to start, so the
// tree belt hands off to the hillsides instead of growing inside them.
const SCATTER_PAD = 95; // how far past the circuit's bounding radius vegetation reaches
const SCATTER_CELL = 18; // jittered-grid spacing for scattered vegetation
// Keep vegetation clear of the racing surface and of TrackBuilder's own
// trackside tree line (which sits at GRASS_HALF + 3..5).
const SCATTER_TRACK_CLEARANCE = GRASS_HALF + 12;

export interface EnvironmentHandles {
  group: THREE.Group;
  // §v4: null on the space map — Rainbow Ridge has no ground under it at all.
  ground: THREE.Mesh | null;
  update?: (time: number) => void;
}

// --- §v4 space backdrop ---------------------------------------------------
// Rainbow Ridge's world is the exact inverse of the meadow one: no terrain, no
// horizon, no sun. What sells "in space" instead is depth cueing — three
// layers at very different distances (stars furthest, nebulae mid, planets
// nearest) so the backdrop parallaxes as the camera swings through a corner.
const SPACE_BACKGROUND = new THREE.Color(0x05030e);
const SPACE_FOG_COLOR = new THREE.Color(0x0a0618);
const SPACE_FOG_NEAR = 260;
const SPACE_FOG_FAR = 1050;
const STAR_COUNT = 1800;
const STAR_RADIUS = 900; // inside the cameras' 1500 far plane even from the far side of the circuit

// Stars as one THREE.Points cloud on a big sphere. sizeAttenuation is off so a
// star is a fixed pixel size however far away it is, which is what stars do;
// with it on, a 900m-distant point collapses to nothing.
function buildStarfield(): THREE.Points {
  const positions = new Float32Array(STAR_COUNT * 3);
  const colors = new Float32Array(STAR_COUNT * 3);
  const rng = makeRandom(0x5eed10);
  const c = new THREE.Color();
  for (let i = 0; i < STAR_COUNT; i++) {
    // Uniform on the sphere (acos of a uniform cosine), then biased upward a
    // little so fewer stars sit below the track than above it.
    const theta = rng() * TAU;
    const phi = Math.acos(1 - 2 * rng()) * 0.9;
    const r = STAR_RADIUS * (0.75 + rng() * 0.25);
    positions[i * 3] = Math.sin(phi) * Math.cos(theta) * r;
    positions[i * 3 + 1] = Math.cos(phi) * r * 0.6 + 120;
    positions[i * 3 + 2] = Math.sin(phi) * Math.sin(theta) * r;
    // Mostly white, some warm, some blue — a flat white field reads as noise.
    const tint = rng();
    c.setHSL(tint < 0.6 ? 0.6 : tint < 0.8 ? 0.08 : 0.55, tint < 0.6 ? 0.15 : 0.5, 0.75 + rng() * 0.25);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const material = new THREE.PointsMaterial({
    size: 2.2,
    sizeAttenuation: false,
    vertexColors: true,
    fog: false,
    depthWrite: false,
    transparent: true,
  });
  const points = new THREE.Points(geometry, material);
  points.renderOrder = -900;
  return points;
}

function buildNebulaTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255,255,255,0.55)');
  gradient.addColorStop(0.35, 'rgba(190,150,255,0.28)');
  gradient.addColorStop(0.7, 'rgba(90,120,255,0.10)');
  gradient.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

// Broad additive clouds of colour behind the stars. Additive so they lighten
// the black rather than sitting on it as grey discs.
function buildNebulae(): THREE.Group {
  const group = new THREE.Group();
  const map = buildNebulaTexture();
  const rng = makeRandom(0x5eed11);
  const tints = [0x8a5cff, 0x2f7bff, 0xff5ce1, 0x35e0d0];
  for (let i = 0; i < 5; i++) {
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map,
        color: tints[i % tints.length],
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        opacity: 0.34 + rng() * 0.2,
        fog: false,
      }),
    );
    const theta = rng() * TAU;
    const radius = 620 + rng() * 120;
    sprite.position.set(Math.sin(theta) * radius, 60 + rng() * 260, Math.cos(theta) * radius);
    const scale = 380 + rng() * 320;
    sprite.scale.set(scale, scale * (0.5 + rng() * 0.4), 1);
    sprite.renderOrder = -800;
    group.add(sprite);
  }
  return group;
}

// A couple of planets, near enough to read as solid objects (unlike the
// stars) and to parallax against the nebulae. Unlit basic spheres with a
// darker limb painted in by vertex colour, plus a ring on the big one.
function buildPlanets(): THREE.Group {
  const group = new THREE.Group();
  const specs = [
    { color: 0xc06cff, radius: 105, at: new THREE.Vector3(-560, 210, -430), ring: true },
    { color: 0x3fa9f5, radius: 58, at: new THREE.Vector3(520, 300, 380), ring: false },
  ];
  for (const spec of specs) {
    const geometry = new THREE.SphereGeometry(spec.radius, 24, 18);
    const base = new THREE.Color(spec.color);
    const colors = new Float32Array(geometry.attributes.position.count * 3);
    const c = new THREE.Color();
    for (let i = 0; i < geometry.attributes.position.count; i++) {
      // Fake a terminator: brighter toward +X/+Y (roughly where the nebulae
      // are), falling to near-black on the opposite limb.
      const x = geometry.attributes.position.getX(i) / spec.radius;
      const y = geometry.attributes.position.getY(i) / spec.radius;
      const lit = THREE.MathUtils.clamp(0.25 + 0.75 * (0.6 * x + 0.5 * y + 0.4), 0.06, 1);
      c.copy(base).multiplyScalar(lit);
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const planet = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ vertexColors: true, fog: false }));
    planet.position.copy(spec.at);
    group.add(planet);

    if (spec.ring) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(spec.radius * 1.4, spec.radius * 2.1, 48),
        new THREE.MeshBasicMaterial({
          color: 0xffd9a0,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.4,
          fog: false,
        }),
      );
      ring.position.copy(spec.at);
      ring.rotation.set(-1.1, 0.4, 0.2);
      group.add(ring);
    }
  }
  return group;
}

// Oversized four-point glints punctuate the distant pinprick starfield.
function buildStarGlints(): THREE.Group {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff3b0'; ctx.beginPath();
  ctx.moveTo(32, 0); ctx.lineTo(38, 26); ctx.lineTo(64, 32); ctx.lineTo(38, 38);
  ctx.lineTo(32, 64); ctx.lineTo(26, 38); ctx.lineTo(0, 32); ctx.lineTo(26, 26); ctx.closePath(); ctx.fill();
  const map = new THREE.CanvasTexture(canvas);
  const group = new THREE.Group(), rng = makeRandom(8127);
  for (let i = 0; i < 40; i++) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map, transparent: true, depthWrite: false, fog: false }));
    const a = rng() * TAU;
    sprite.position.set(Math.cos(a) * 650, 45 + rng() * 340, Math.sin(a) * 650);
    sprite.scale.setScalar(4 + rng() * 7); group.add(sprite);
  }
  return group;
}

function buildSpaceEnvironment(scene: THREE.Scene): EnvironmentHandles {
  scene.background = SPACE_BACKGROUND.clone();
  scene.fog = new THREE.Fog(SPACE_FOG_COLOR.getHex(), SPACE_FOG_NEAR, SPACE_FOG_FAR);
  const group = new THREE.Group();
  group.add(buildStarfield());
  const glints = buildStarGlints();
  group.add(glints);
  group.add(buildNebulae());
  group.add(buildPlanets());
  scene.add(group);
  return { group, ground: null, update: (time) => {
    glints.children.forEach((star, i) => {
      const sprite = star as THREE.Sprite;
      sprite.material.opacity = 0.55 + Math.sin(time * 1.2 + i * 2.4) * 0.25;
      sprite.material.rotation = Math.sin(time * 0.3 + i) * 0.1;
    });
  } };
}

// Inverted sphere, vertically gradiented via vertex colors (§v3 polish: three
// stops now — warm horizon haze, mid blue, deep blue overhead — so the sky has
// somewhere to go between the ground and the zenith instead of one flat ramp).
// `fog: false` keeps the dome's own gradient readable; letting scene fog tint
// it would just wash the whole sphere to a flat fog color.
function buildSkyDome(): THREE.Mesh {
  const geometry = new THREE.SphereGeometry(SKY_RADIUS, 32, 20);
  const pos = geometry.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const t = THREE.MathUtils.clamp(THREE.MathUtils.mapLinear(y, -SKY_RADIUS * 0.1, SKY_RADIUS * 0.9, 0, 1), 0, 1);
    // Horizon -> mid over the first quarter of the ramp (a thin warm band, as
    // in the real thing), mid -> top over the rest.
    if (t < 0.25) c.copy(SKY_HORIZON).lerp(SKY_MID, THREE.MathUtils.smoothstep(t, 0, 0.25));
    else c.copy(SKY_MID).lerp(SKY_TOP, THREE.MathUtils.smoothstep(t, 0.25, 1));
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  // §v3 polish: the dome is a backdrop, not an object — it neither tests nor
  // writes depth, and renders before everything else. Previously it was a
  // solid 600m sphere that depth-tested normally, which silently swallowed
  // anything further from the origin than its shell: the new mountain rings
  // sit past that, and half of them would simply not have drawn.
  const material = new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.BackSide,
    fog: false,
    depthWrite: false,
    depthTest: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = -1000;
  return mesh;
}

// §v3 polish: a sun where the light actually comes from. Two additively
// blended sprites (a small hot disc inside a wide soft glow) parked along
// SHADOW_LIGHT_OFFSET, the same direction buildLights points the directional
// light — so the bright spot in the sky and the direction of the shadows on
// the ground agree. Additive + depthWrite:false means it never occludes
// anything; it is drawn against the dome and adds light to it.
function buildSunSprite(size: number, softness: number, alpha: number): THREE.Sprite {
  const px = 128;
  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(px / 2, px / 2, 0, px / 2, px / 2, px / 2);
  gradient.addColorStop(0, 'rgba(255,252,235,1)');
  gradient.addColorStop(softness, 'rgba(255,240,200,0.55)');
  gradient.addColorStop(1, 'rgba(255,230,180,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, px, px);
  const material = new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(canvas),
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    opacity: alpha,
    fog: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(size, size, 1);
  return sprite;
}

function buildSun(): THREE.Group {
  const group = new THREE.Group();
  const dir = SHADOW_LIGHT_OFFSET.clone().normalize().multiplyScalar(SKY_RADIUS * 0.82);
  for (const sprite of [buildSunSprite(230, 0.45, 0.45), buildSunSprite(70, 0.2, 0.9)]) {
    sprite.position.copy(dir);
    group.add(sprite);
  }
  return group;
}

// A ring of irregular peaks built as ONE merged, non-indexed, vertex-colored
// geometry (§v3 polish — was an InstancedMesh of uniform cones, which cannot
// carry a per-vertex rock->snow gradient and gives every peak the same
// silhouette). Each peak is an apex fanned to a jittered base ring, so no two
// share an outline. `haze` blends the whole ridge toward the horizon tone —
// more for the far ring than the near one — which is the entire reason these
// can run with `fog: false` and still sit believably far away.
interface RidgeOptions {
  count: number;
  centerX: number;
  centerZ: number;
  radiusMin: number;
  radiusMax: number;
  // No vertex of this ridge is allowed within this distance of (centerX,
  // centerZ) — a peak whose skirt would breach it is moved outward instead.
  clearRadius: number;
  heightMin: number;
  heightMax: number;
  widthMin: number;
  widthMax: number;
  base: THREE.Color;
  top: THREE.Color;
  snowLine: number; // fraction of peak height above which `top` takes over (>1 = never)
  haze: number; // 0 = full saturation, 1 = pure horizon color
  seed: number;
}

const RIDGE_BASE_Y = -12;
const RIDGE_SEGMENTS = 9;

// The widest a peak's base ring can reach from its own center, as a multiple
// of its `width` — the ring radius is width * (0.7 + rng * 0.6), so 1.3.
const RIDGE_SKIRT_FACTOR = 1.3;

function buildRidge(o: RidgeOptions, label: string): THREE.Mesh {
  const rng = makeRandom(o.seed);
  const positions: number[] = [];
  const colors: number[] = [];
  let maxExtent = 0; // furthest vertex from the world origin, for the log below
  let minClearance = Infinity; // nearest vertex to the circuit's centroid, ditto
  const apex = new THREE.Vector3();
  const ring: THREE.Vector3[] = [];
  const c = new THREE.Color();

  const pushVertex = (v: THREE.Vector3, height: number) => {
    positions.push(v.x, v.y, v.z);
    maxExtent = Math.max(maxExtent, Math.hypot(v.x, v.z));
    minClearance = Math.min(minClearance, Math.hypot(v.x - o.centerX, v.z - o.centerZ));
    const t = THREE.MathUtils.clamp((v.y - RIDGE_BASE_Y) / height, 0, 1);
    c.copy(o.base).lerp(o.top, THREE.MathUtils.smoothstep(t, o.snowLine - 0.12, Math.min(1, o.snowLine + 0.08)));
    // Bases haze more than summits: near the ground the air column between
    // viewer and mountain is longest, which is what makes ridges look stacked.
    c.lerp(SKY_HORIZON, o.haze * (1 - 0.35 * t));
    colors.push(c.r, c.g, c.b);
  };

  for (let i = 0; i < o.count; i++) {
    const angle = (i / o.count) * TAU + (rng() - 0.5) * (TAU / o.count) * 0.9;
    const height = THREE.MathUtils.lerp(o.heightMin, o.heightMax, rng());
    const width = THREE.MathUtils.lerp(o.widthMin, o.widthMax, rng());
    // The clearance guard: a peak this wide has to stand at least its own
    // skirt beyond clearRadius, whatever its ring would otherwise have said.
    const radius = Math.max(
      THREE.MathUtils.lerp(o.radiusMin, o.radiusMax, rng()),
      o.clearRadius + width * RIDGE_SKIRT_FACTOR,
    );
    const cx = o.centerX + Math.sin(angle) * radius;
    const cz = o.centerZ + Math.cos(angle) * radius;
    apex.set(cx + (rng() - 0.5) * width * 0.35, RIDGE_BASE_Y + height, cz + (rng() - 0.5) * width * 0.35);

    ring.length = 0;
    const phase = rng() * TAU;
    for (let seg = 0; seg < RIDGE_SEGMENTS; seg++) {
      const a = phase + (seg / RIDGE_SEGMENTS) * TAU;
      const r = width * (0.7 + rng() * 0.6);
      ring.push(new THREE.Vector3(cx + Math.sin(a) * r, RIDGE_BASE_Y + rng() * height * 0.06, cz + Math.cos(a) * r));
    }
    for (let seg = 0; seg < RIDGE_SEGMENTS; seg++) {
      pushVertex(ring[seg], height);
      pushVertex(ring[(seg + 1) % RIDGE_SEGMENTS], height);
      pushVertex(apex, height);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals(); // non-indexed -> one normal per face, i.e. faceted
  geometry.computeBoundingSphere();
  // Logged because it is the number that has to stay inside the cameras' far
  // plane (1000 -> 1500, see Player.ts/CinematicCamera): worst case a camera
  // is on the far side of the circuit from the furthest peak.
  console.log(
    `[Environment] ${label}: ${o.count} peaks, furthest vertex ${maxExtent.toFixed(0)}m from origin, ` +
      `nearest ${minClearance.toFixed(0)}m from circuit center (guard ${o.clearRadius.toFixed(0)}m)`,
  );
  const material = new THREE.MeshLambertMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide });
  return new THREE.Mesh(geometry, material);
}

// Near rolling hills + far snow-capped peaks, both sized off the circuit's own
// bounding radius so they always clear the track (see the constants block).
function buildMountainRanges(centerX: number, centerZ: number, circuitRadius: number): THREE.Group {
  const group = new THREE.Group();
  group.add(
    buildRidge(
      {
        count: 36,
        centerX,
        centerZ,
        radiusMin: circuitRadius + HILL_RING_INNER_PAD,
        radiusMax: circuitRadius + HILL_RING_OUTER_PAD,
        clearRadius: circuitRadius + HILL_CLEAR_PAD,
        heightMin: 28,
        heightMax: 62,
        widthMin: 45,
        widthMax: 85,
        base: new THREE.Color(0x4e7a45),
        top: new THREE.Color(0x6f9457),
        snowLine: 1.2, // never reached: hills stay green top to bottom
        haze: 0.34,
        seed: 0x5eed01,
      },
      'hills',
    ),
  );
  group.add(
    buildRidge(
      {
        count: 30,
        centerX,
        centerZ,
        radiusMin: circuitRadius + PEAK_RING_INNER_PAD,
        radiusMax: circuitRadius + PEAK_RING_OUTER_PAD,
        clearRadius: circuitRadius + PEAK_CLEAR_PAD,
        heightMin: 110,
        heightMax: 200,
        widthMin: 70,
        widthMax: 120,
        base: new THREE.Color(0x5d6c8c),
        top: new THREE.Color(0xf4f8ff), // snow
        snowLine: 0.62,
        haze: 0.5,
        seed: 0x5eed02,
      },
      'peaks',
    ),
  );
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

// Camera-facing (THREE.Sprite auto-billboards) soft white blobs overhead.
// §v3 polish: each cloud is now a CLUSTER of 3-5 overlapping puffs at
// different sizes rather than one symmetrical blob, which is the difference
// between reading as a cloud and reading as a smudge. Still one shared
// material/texture across all of them, and still centered on the circuit
// rather than the world origin.
function buildClouds(centerX: number, centerZ: number, spread: number): THREE.Group {
  const group = new THREE.Group();
  const material = new THREE.SpriteMaterial({
    map: buildCloudTexture(),
    transparent: true,
    depthWrite: false,
    opacity: 0.85,
    fog: false,
  });
  const rng = makeRandom(0x5eed03);
  const clusters = 14;
  for (let i = 0; i < clusters; i++) {
    const angle = rng() * TAU;
    const radius = spread * (0.35 + rng() * 0.85);
    const cx = centerX + Math.sin(angle) * radius;
    const cz = centerZ + Math.cos(angle) * radius;
    const cy = 70 + rng() * 60;
    const scale = 26 + rng() * 30;
    const puffs = 3 + Math.floor(rng() * 3);
    for (let p = 0; p < puffs; p++) {
      const sprite = new THREE.Sprite(material);
      const puffScale = scale * (0.55 + rng() * 0.75);
      sprite.position.set(
        cx + (rng() - 0.5) * scale * 1.9,
        cy + (rng() - 0.5) * scale * 0.28,
        cz + (rng() - 0.5) * scale * 1.9,
      );
      sprite.scale.set(puffScale, puffScale * (0.42 + rng() * 0.2), 1);
      group.add(sprite);
    }
  }
  return group;
}

// The exact height the ground heightfield takes at (x, z) — factored out of
// buildGroundPlane (§v3 polish) so scattered vegetation can be planted on the
// same surface the mesh is built from rather than on an approximation of it.
// Near the circuit that is the medial-axis-safe weighted blend of the track's
// own heights (see TrackQuery's BLEND_EPS_SQ comment for why it is not simply
// the nearest branch's height), sunk by GROUND_SINK and clamped so the terrain
// can never poke up through the grass ribbon; far from it, the rolling base
// terrain. `field` is null beyond BLEND_OUTER_DIST, i.e. wherever the circuit
// has no influence at all.
function terrainHeightAt(trackQuery: TrackQuery, x: number, z: number): number {
  const base = baseTerrainHeight(x, z);
  const field = trackQuery.terrainTrackField(x, z, BLEND_OUTER_DIST, TERRAIN_CLAMP_RADIUS);
  if (!field) return base;
  const nearY = field.blendY - GROUND_SINK;
  const t = THREE.MathUtils.smoothstep(field.dist, BLEND_INNER_DIST, BLEND_OUTER_DIST);
  // Hard requirement (§v3 Track A): near the circuit the terrain must never
  // poke above the grass ribbon. The smoothstep alone doesn't guarantee it
  // once cells are metres wide and the ribbon curves on a grade. Applied
  // unconditionally rather than gated on `dist` -- the ceiling's ramp already
  // makes it non-binding away from the circuit, and a distance gate would put
  // a step back into the field.
  return Math.min(THREE.MathUtils.lerp(nearY, base, t), field.clampY - GROUND_SINK);
}

interface ScatterPlacement {
  x: number;
  z: number;
  y: number;
  scale: number;
  rotation: number;
  shade: number;
}

// §v3 polish: vegetation filling the empty green between the grass verge and
// the hills — the thing that was actually missing from the surroundings. Six
// InstancedMeshes (conifer trunk/crown, broadleaf trunk/crown, boulder, bush)
// over a jittered grid, planted on terrainHeightAt and skipped anywhere within
// SCATTER_TRACK_CLEARANCE of the centerline so nothing sprouts on the racing
// surface or fights with TrackBuilder's own trackside tree line.
//
// castShadow is deliberately OFF: the shadow camera is an ~80m ortho box that
// follows the karts, so none of this is ever inside it, and turning it on would
// only add these instances to every shadow pass for nothing.
function buildScatter(trackQuery: TrackQuery, centerX: number, centerZ: number, reach: number): THREE.Group {
  const group = new THREE.Group();
  const rng = makeRandom(0x5eed04);

  const conifers: ScatterPlacement[] = [];
  const broadleaves: ScatterPlacement[] = [];
  const boulders: ScatterPlacement[] = [];
  const bushes: ScatterPlacement[] = [];

  const reachSq = reach * reach;
  const clearanceSq = SCATTER_TRACK_CLEARANCE * SCATTER_TRACK_CLEARANCE;
  let closestToTrack = Infinity; // nearest accepted placement to the centerline, for the log below
  for (let gz = centerZ - reach; gz <= centerZ + reach; gz += SCATTER_CELL) {
    for (let gx = centerX - reach; gx <= centerX + reach; gx += SCATTER_CELL) {
      const x = gx + (rng() - 0.5) * SCATTER_CELL * 0.9;
      const z = gz + (rng() - 0.5) * SCATTER_CELL * 0.9;
      const dx = x - centerX;
      const dz = z - centerZ;
      const distSq = dx * dx + dz * dz;
      if (distSq > reachSq) continue; // circular region, not the grid's square
      // Density thins toward the edge of the belt so it fades out into open
      // ground instead of ending on a visible circle.
      if (rng() > 0.62 - 0.25 * (Math.sqrt(distSq) / reach)) continue;
      const field = trackQuery.terrainTrackField(x, z, BLEND_OUTER_DIST, TERRAIN_CLAMP_RADIUS);
      if (field && field.dist * field.dist < clearanceSq) continue;
      if (field) closestToTrack = Math.min(closestToTrack, field.dist);
      const place: ScatterPlacement = {
        x,
        z,
        y: terrainHeightAt(trackQuery, x, z),
        scale: 0.75 + rng() * 0.75,
        rotation: rng() * TAU,
        shade: rng(),
      };
      const roll = rng();
      if (roll < 0.46) conifers.push(place);
      else if (roll < 0.74) broadleaves.push(place);
      else if (roll < 0.88) bushes.push(place);
      else boulders.push(place);
    }
  }

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const axisY = new THREE.Vector3(0, 1, 0);
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const tint = new THREE.Color();

  // One instanced layer. Every `geometry` passed here is authored with its base
  // at local y=0, so per-instance scale grows it upward out of the ground.
  const addLayer = (
    geometry: THREE.BufferGeometry,
    color: number,
    places: ScatterPlacement[],
    baseScale: number,
    yOffset: number,
    shadeRange: number,
  ) => {
    if (places.length === 0) return;
    const mesh = new THREE.InstancedMesh(geometry, new THREE.MeshLambertMaterial({ color }), places.length);
    places.forEach((pl, i) => {
      const sc = baseScale * pl.scale;
      position.set(pl.x, pl.y + yOffset * pl.scale, pl.z);
      q.setFromAxisAngle(axisY, pl.rotation);
      scale.set(sc, sc * (0.85 + pl.shade * 0.4), sc);
      m.compose(position, q, scale);
      mesh.setMatrixAt(i, m);
      tint.setHex(color).multiplyScalar(1 - shadeRange / 2 + pl.shade * shadeRange);
      mesh.setColorAt(i, tint);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  };

  const trunkGeo = new THREE.CylinderGeometry(0.16, 0.26, 1, 5);
  trunkGeo.translate(0, 0.5, 0);
  const coniferGeo = new THREE.ConeGeometry(0.55, 1, 7);
  coniferGeo.translate(0, 0.5, 0);
  const crownGeo = new THREE.IcosahedronGeometry(0.62, 0);
  crownGeo.translate(0, 0.62, 0);
  const boulderGeo = new THREE.DodecahedronGeometry(0.6, 0);
  boulderGeo.translate(0, 0.35, 0);
  const bushGeo = new THREE.IcosahedronGeometry(0.55, 0);
  bushGeo.scale(1, 0.7, 1);
  bushGeo.translate(0, 0.38, 0);

  // Conifers: a tall narrow crown on a short trunk. Broadleaves: a rounder,
  // lighter crown, a little shorter overall. Two silhouettes plus per-instance
  // scale/shade jitter is enough to stop a few hundred instances reading as
  // copies of one object.
  addLayer(trunkGeo, 0x6b4a2f, conifers, 1.1, 0, 0.25);
  addLayer(coniferGeo, 0x2f7a3c, conifers, 4.2, 1.0, 0.3);
  addLayer(trunkGeo, 0x7a5636, broadleaves, 1.3, 0, 0.25);
  addLayer(crownGeo, 0x4e9a48, broadleaves, 3.4, 1.2, 0.3);
  addLayer(bushGeo, 0x54803c, bushes, 1.9, 0, 0.3);
  addLayer(boulderGeo, 0x8a8578, boulders, 1.7, 0, 0.28);

  console.log(
    `[Environment] scatter: ${conifers.length} conifers, ${broadleaves.length} broadleaves, ` +
      `${bushes.length} bushes, ${boulders.length} boulders; closest to the centerline ` +
      `${closestToTrack === Infinity ? '>' + BLEND_OUTER_DIST : closestToTrack.toFixed(1)}m ` +
      `(clearance ${SCATTER_TRACK_CLEARANCE}m)`,
  );
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
  const material = new THREE.MeshLambertMaterial({ map: texture, vertexColors: true });

  console.time('[Environment] ground heightfield');
  const bounds = trackQuery.centerlineBounds();
  const xs = buildGroundAxis(bounds.minX, bounds.maxX);
  const zs = buildGroundAxis(bounds.minZ, bounds.maxZ);
  const nx = xs.length;
  const nz = zs.length;

  const positions = new Float32Array(nx * nz * 3);
  const uvs = new Float32Array(nx * nz * 2);
  const colors = new Float32Array(nx * nz * 3);
  for (let j = 0; j < nz; j++) {
    const z = zs[j];
    for (let i = 0; i < nx; i++) {
      const x = xs[i];
      const v = j * nx + i;
      // §v3 polish: the per-vertex height math moved to terrainHeightAt (same
      // arithmetic, same result — the scattered vegetation needs to sample the
      // identical surface, and one copy of it means the two cannot drift).
      const y = terrainHeightAt(trackQuery, x, z);
      positions[v * 3] = x;
      positions[v * 3 + 1] = y;
      positions[v * 3 + 2] = z;
      // Broad meadow colour variation complements the small grass texture.
      // Keep the track-side blend neutral so the grass ribbon has no hard seam.
      const field = trackQuery.terrainTrackField(x, z, BLEND_OUTER_DIST, TERRAIN_CLAMP_RADIUS);
      const fade = field ? THREE.MathUtils.smoothstep(field.dist, GRASS_HALF + 2, GRASS_HALF + 35) : 1;
      const patch = (Math.sin(x * 0.035 + Math.sin(z * 0.018)) * Math.cos(z * 0.028) + 1) * 0.5 * fade;
      colors[v * 3] = 1 - patch * 0.19;
      colors[v * 3 + 1] = 1 - patch * 0.07;
      colors[v * 3 + 2] = 1 - patch * 0.25;
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
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  console.timeEnd('[Environment] ground heightfield');
  console.log(`[Environment] ground heightfield: ${nx}x${nz} verts, ${(nx - 1) * (nz - 1) * 2} tris`);

  const ground = new THREE.Mesh(geometry, material);
  ground.receiveShadow = true; // §Phase 4 item 3
  return ground;
}

export function buildEnvironment(scene: THREE.Scene, trackQuery: TrackQuery, style: MapStyle): EnvironmentHandles {
  if (style === 'space') return buildSpaceEnvironment(scene);

  scene.background = SKY_HORIZON.clone();
  scene.fog = new THREE.Fog(FOG_COLOR.getHex(), FOG_NEAR, FOG_FAR);

  // §v3 polish: every backdrop layer is placed relative to the circuit's own
  // centroid and bounding radius rather than the world origin. The circuit is
  // strongly off-center (the hairpin sits ~275m down -Z while the start
  // straight is at the origin), so origin-centered rings put scenery on one
  // side of the track and nothing on the other — and, at the hairpin, very
  // nearly on the track itself.
  const bounds = trackQuery.centerlineBounds();
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerZ = (bounds.minZ + bounds.maxZ) / 2;
  const circuitRadius = Math.hypot(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) / 2;
  console.log(
    `[Environment] circuit center (${centerX.toFixed(0)}, ${centerZ.toFixed(0)}), radius ${circuitRadius.toFixed(0)}m`,
  );

  const group = new THREE.Group();
  group.add(buildSkyDome());
  group.add(buildSun());
  group.add(buildMountainRanges(centerX, centerZ, circuitRadius));
  group.add(buildClouds(centerX, centerZ, circuitRadius + HILL_CLEAR_PAD));
  const ground = buildGroundPlane(trackQuery);
  group.add(ground);
  group.add(buildScatter(trackQuery, centerX, centerZ, circuitRadius + SCATTER_PAD));
  group.add(buildWildflowers(trackQuery, bounds));
  scene.add(group);

  return { group, ground };
}

// Clusters of daisies along the verges: two instanced draws for the whole field.
function buildWildflowers(query: TrackQuery, bounds: { minX: number; maxX: number; minZ: number; maxZ: number }): THREE.Group {
  const group = new THREE.Group(), rng = makeRandom(19761);
  const petals = new THREE.InstancedMesh(new THREE.SphereGeometry(0.18, 6, 4), new THREE.MeshLambertMaterial({ color: 0xffffff }), 1000);
  const stems = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.025, 0.035, 0.5, 4), new THREE.MeshLambertMaterial({ color: 0x397332 }), 1000);
  const dummy = new THREE.Object3D(), color = new THREE.Color();
  let count = 0;
  for (let i = 0; i < 4000 && count < 1000; i++) {
    const x = bounds.minX - 35 + rng() * (bounds.maxX - bounds.minX + 70);
    const z = bounds.minZ - 35 + rng() * (bounds.maxZ - bounds.minZ + 70);
    const field = query.terrainTrackField(x, z, BLEND_OUTER_DIST, TERRAIN_CLAMP_RADIUS);
    if (!field || field.dist < GRASS_HALF + 1 || field.dist > GRASS_HALF + 24) continue;
    const y = terrainHeightAt(query, x, z);
    dummy.position.set(x, y + 0.25, z); dummy.scale.set(1, 1, 1); dummy.updateMatrix(); stems.setMatrixAt(count, dummy.matrix);
    dummy.position.y = y + 0.52; dummy.scale.set(1.5, 0.45, 1.5); dummy.updateMatrix(); petals.setMatrixAt(count, dummy.matrix);
    color.set([0xfff0b8, 0xffd24e, 0xffa8c9, 0xe1d1ff][count % 4]); petals.setColorAt(count, color); count++;
  }
  petals.count = stems.count = count;
  petals.computeBoundingSphere(); stems.computeBoundingSphere();
  group.add(petals, stems); return group;
}
