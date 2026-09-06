import { buildSamples, SAMPLE_COUNT } from './TrackSampler';
import * as THREE from 'three';
import { ROAD_HALF, GRASS_HALF, CHECKPOINT_COUNT, type SurfaceZone } from './trackData';
import type { MapDef, MapStyle } from './maps';
import { buildAsphaltTexture, buildGrassTexture, buildRainbowTexture, tryLoadTextureOverride } from '../render/textures';
// §v3 Track A: prop planting has to agree with the ground heightfield's own
// clamp, so the two constants live in Environment and are imported here rather
// than duplicated (no runtime cycle: Environment's only TrackBuilder import is
// `import type`).
import { GROUND_SINK, TERRAIN_CLAMP_RADIUS } from '../render/Environment';
// Value imports from TrackQuery/LapTracker are safe here (no runtime cycle):
// TrackQuery's only import of this module is `import type`, and LapTracker's
// is too — both erased at compile time.
import { sampleAtArcLength } from './TrackQuery';
import { checkWrapGuardSafety } from '../race/LapTracker';

export interface TrackSample {
  pos: THREE.Vector3;
  forward: THREE.Vector3;
  right: THREE.Vector3;
  s: number;
  grade: number; // §Phase 5 item 2: forward.y -- slope along the track direction, +up
}

export interface TrackData {
  samples: TrackSample[];
  totalLength: number;
  checkpoints: number[];
  group: THREE.Group;
}

const STRIPE_WIDTH = 0.4;
const WALL_HEIGHT = 1.2;
const TEXTURE_V_SCALE = 8; // meters of arc length per texture repeat, longitudinally (§Phase 4 item 1)
// §v3 Track A: was an absolute SKIRT_BOTTOM_Y = -2.5 (chosen to sit under
// Environment.ts's old flat y=-0.05 ground plane). Environment's ground is now
// a heightfield that follows the track's own elevation, so an absolute bottom
// is simultaneously too short on the +8m esses crest (skirt ends miles above
// the terrain) and pointlessly long in the -1.8m double-apex dip. Measuring
// the drop *down from the local grass edge* instead keeps the seam sealed at
// every elevation. It only has to out-reach GROUND_SINK (0.25m) plus whatever
// the coarse 6m terrain cells undershoot by; 3m is generous headroom.
const SKIRT_DEPTH = 3;

// u = signed lateral offset in meters / TEXTURE_V_SCALE; v = arc length /
// TEXTURE_V_SCALE. §Phase 4 finding #5: u used to span the fixed range 0..1
// across the road regardless of its 12m width, giving it a texel density
// completely different from v's meters-based scale (and from the ground
// plane's) — a road-width tile read far coarser than the same texture tiling
// along its length. Deriving u from meters at the same TEXTURE_V_SCALE keeps
// texel density uniform in both directions; RepeatWrapping (set in
// textures.ts) handles the resulting u range extending past [0,1].
// The final cross-section ring is a *duplicate* of ring 0 (ringCount = n+1, not
// n), placed at the same position but carrying v = totalLength/TEXTURE_V_SCALE
// instead of wrapping back to v = 0 — otherwise the texture would visibly jump
// at the start/finish seam. Index math below walks 0..n-1 -> i, i+1 with no
// modulo, since the duplicate ring supplies the "+1" vertex for the last band.
const U_EDGE_L = -ROAD_HALF / TEXTURE_V_SCALE;
const U_STRIPE_L = -(ROAD_HALF - STRIPE_WIDTH) / TEXTURE_V_SCALE;
const U_STRIPE_R = (ROAD_HALF - STRIPE_WIDTH) / TEXTURE_V_SCALE;
const U_EDGE_R = ROAD_HALF / TEXTURE_V_SCALE;

// §v4: the space style maps u across the cross-section 0..1 instead of by
// meters, so one hue sweep of the rainbow texture spans the road exactly once
// (see buildRainbowTexture's ClampToEdge note). The meters-based mapping the
// meadow style uses is deliberate for a *tiling* asphalt texture — it keeps
// texel density equal in u and v (§Phase 4 finding #5) — but a gradient that
// is meant to fit the road once needs the normalized mapping instead.
const U_SPACE_EDGE_L = 0;
const U_SPACE_STRIPE_L = STRIPE_WIDTH / (2 * ROAD_HALF);
const U_SPACE_STRIPE_R = 1 - STRIPE_WIDTH / (2 * ROAD_HALF);
const U_SPACE_EDGE_R = 1;

function buildRoadMesh(samples: TrackSample[], totalLength: number, style: MapStyle): THREE.Mesh {
  const n = samples.length;
  const ringCount = n + 1;
  const positions: number[] = [];
  const colors: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const stripeColor = new THREE.Color(0xf2f2f2);
  const lightGray = new THREE.Color(0x707070);
  const darkGray = new THREE.Color(0x5c5c5c);
  // Space: the rainbow texture carries all the colour, so the vertex colours
  // have to be neutral or they would tint it. (They stay in the attribute
  // rather than dropping vertexColors so both styles share one geometry path.)
  const spaceWhite = new THREE.Color(0xffffff);

  // 4 cross-section vertices per ring: edgeL, stripeL, stripeR, edgeR.
  for (let i = 0; i < ringCount; i++) {
    const sampleIdx = i % n;
    const { pos, right } = samples[sampleIdx];
    const sValue = i < n ? samples[sampleIdx].s : totalLength;
    const v = style === 'space' ? sValue / (2 * ROAD_HALF) : sValue / TEXTURE_V_SCALE;
    const roadColor = Math.floor(sampleIdx / 4) % 2 === 0 ? lightGray : darkGray;

    const edgeL = pos.clone().addScaledVector(right, -ROAD_HALF);
    const stripeL = pos.clone().addScaledVector(right, -(ROAD_HALF - STRIPE_WIDTH));
    const stripeR = pos.clone().addScaledVector(right, ROAD_HALF - STRIPE_WIDTH);
    const edgeR = pos.clone().addScaledVector(right, ROAD_HALF);

    for (const vtx of [edgeL, stripeL, stripeR, edgeR]) {
      positions.push(vtx.x, vtx.y + 0.001, vtx.z);
    }
    if (style === 'space') {
      for (let k = 0; k < 4; k++) colors.push(spaceWhite.r, spaceWhite.g, spaceWhite.b);
      uvs.push(U_SPACE_EDGE_L, v, U_SPACE_STRIPE_L, v, U_SPACE_STRIPE_R, v, U_SPACE_EDGE_R, v);
    } else {
      colors.push(
        stripeColor.r, stripeColor.g, stripeColor.b,
        roadColor.r, roadColor.g, roadColor.b,
        roadColor.r, roadColor.g, roadColor.b,
        stripeColor.r, stripeColor.g, stripeColor.b,
      );
      uvs.push(U_EDGE_L, v, U_STRIPE_L, v, U_STRIPE_R, v, U_EDGE_R, v);
    }
  }

  for (let i = 0; i < n; i++) {
    const a = i * 4;
    const b = (i + 1) * 4; // ringCount = n+1, so i+1 is always in range without wrapping
    // 3 quads (6 indices each) between cross-section i and i+1: left stripe, road, right stripe
    for (let band = 0; band < 3; band++) {
      const a0 = a + band;
      const a1 = a + band + 1;
      const b0 = b + band;
      const b1 = b + band + 1;
      indices.push(a0, b0, b1, a0, b1, a1);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  if (style === 'space') {
    // Lambert rather than unlit, deliberately: an unlit ribbon would glow
    // evenly and the karts would then cast no shadow onto anything at all,
    // which is what makes them look pasted on. This keeps real shading and
    // real kart shadows, with a small emissive floor so the rainbow never
    // falls to black on the shadowed side of a crest. The *rails* and the
    // void shoulder are the unlit pieces (see buildWallMeshes/buildGrassMesh).
    const rainbowTexture = buildRainbowTexture();
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshLambertMaterial({
        vertexColors: true,
        map: rainbowTexture,
        emissiveMap: rainbowTexture,
        emissive: 0xffffff,
        emissiveIntensity: 0.48,
      }),
    );
    mesh.receiveShadow = true;
    return mesh;
  }
  const material = new THREE.MeshLambertMaterial({ vertexColors: true, map: buildAsphaltTexture() });
  tryLoadTextureOverride('/assets/textures/asphalt.jpg', material);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true; // §Phase 4 item 3
  return mesh;
}

// u derived from meters at the same TEXTURE_V_SCALE as v (§Phase 4 finding
// #5, see buildRoadMesh's comment) instead of spanning a fixed 0..1 across
// the cross-section; see buildRoadMesh's comment for the duplicated-ring seam fix.
const U_OUTER_L = -GRASS_HALF / TEXTURE_V_SCALE;
const U_INNER_L = -ROAD_HALF / TEXTURE_V_SCALE;
const U_INNER_R = ROAD_HALF / TEXTURE_V_SCALE;
const U_OUTER_R = GRASS_HALF / TEXTURE_V_SCALE;

// §v4: the same ribbon serves as grass on the meadow map and as the dark
// "void shoulder" on the space map — same geometry, same off-road physics
// (|lateral| > ROAD_HALF), different clothes.
function buildGrassMesh(samples: TrackSample[], totalLength: number, style: MapStyle): THREE.Mesh {
  const n = samples.length;
  const ringCount = n + 1;
  const positions: number[] = [];
  const colors: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const baseGreen = new THREE.Color(0x5cb85c);
  // Space: a violet shoulder right at the road edge falling away to near-black
  // at the rail, so running wide reads as drifting off into the void.
  const shoulderInner = new THREE.Color(0x3a1b5c);
  const shoulderOuter = new THREE.Color(0x0d0718);

  // Two ribbons (left ROAD_HALF..GRASS_HALF, right ROAD_HALF..GRASS_HALF), 4 verts per ring.
  for (let i = 0; i < ringCount; i++) {
    const sampleIdx = i % n;
    const { pos, right } = samples[sampleIdx];
    const sValue = i < n ? samples[sampleIdx].s : totalLength;
    const v = style === 'space' ? sValue / (2 * ROAD_HALF) : sValue / TEXTURE_V_SCALE;
    const jitter = () => 0.9 + Math.random() * 0.2;

    const innerL = pos.clone().addScaledVector(right, -ROAD_HALF);
    const outerL = pos.clone().addScaledVector(right, -GRASS_HALF);
    const innerR = pos.clone().addScaledVector(right, ROAD_HALF);
    const outerR = pos.clone().addScaledVector(right, GRASS_HALF);

    for (const vtx of [outerL, innerL, innerR, outerR]) {
      positions.push(vtx.x, vtx.y, vtx.z);
    }
    if (style === 'space') {
      // Vertex order is outerL, innerL, innerR, outerR.
      for (const c of [shoulderOuter, shoulderInner, shoulderInner, shoulderOuter]) {
        colors.push(c.r, c.g, c.b);
      }
    } else {
      for (let k = 0; k < 4; k++) {
        const j = jitter();
        colors.push(baseGreen.r * j, baseGreen.g * j, baseGreen.b * j);
      }
    }
    uvs.push(U_OUTER_L, v, U_INNER_L, v, U_INNER_R, v, U_OUTER_R, v);
  }

  for (let i = 0; i < n; i++) {
    const a = i * 4;
    const b = (i + 1) * 4; // ringCount = n+1, so i+1 is always in range without wrapping
    // left band: outerL(0)-innerL(1), right band: innerR(2)-outerR(3)
    for (const band of [0, 2]) {
      const a0 = a + band;
      const a1 = a + band + 1;
      const b0 = b + band;
      const b1 = b + band + 1;
      indices.push(a0, b0, b1, a0, b1, a1);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  if (style === 'space') {
    return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ vertexColors: true }));
  }
  const material = new THREE.MeshLambertMaterial({ vertexColors: true, map: buildGrassTexture() });
  tryLoadTextureOverride('/assets/textures/grass.jpg', material);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true; // §Phase 4 item 3
  return mesh;
}

function buildWallMeshes(samples: TrackSample[], style: MapStyle): THREE.Mesh {
  const n = samples.length;
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  const red = new THREE.Color(0xcc2b2b);
  const white = new THREE.Color(0xf0f0f0);
  // Space: neon rails, the only thing between the ribbon and the void.
  const neonA = new THREE.Color(0x22e0ff);
  const neonB = new THREE.Color(0xff5ce1);

  function addWallStrip(side: 1 | -1, vertexOffset: number) {
    for (let i = 0; i < n; i++) {
      const { pos, right } = samples[i];
      const base = pos.clone().addScaledVector(right, side * GRASS_HALF);
      const top = base.clone().add(new THREE.Vector3(0, WALL_HEIGHT, 0));
      positions.push(base.x, base.y, base.z, top.x, top.y, top.z);
      const stripeColor =
        style === 'space'
          ? Math.floor(i / 3) % 2 === 0
            ? neonA
            : neonB
          : Math.floor(i / 2) % 2 === 0
            ? red
            : white;
      colors.push(stripeColor.r, stripeColor.g, stripeColor.b, stripeColor.r, stripeColor.g, stripeColor.b);
    }
    for (let i = 0; i < n; i++) {
      const a = vertexOffset + i * 2;
      const b = vertexOffset + ((i + 1) % n) * 2;
      // winding flips per side so both walls face outward/inward correctly
      if (side === 1) indices.push(a, b, b + 1, a, b + 1, a + 1);
      else indices.push(a, a + 1, b + 1, a, b + 1, b);
    }
  }

  addWallStrip(-1, 0);
  addWallStrip(1, n * 2);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  const material =
    style === 'space'
      ? new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })
      : new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  return new THREE.Mesh(geometry, material);
}

// §Phase 5 elevation review fix #2: on graded (hilly) sections, the grass
// ribbon's outer edge sits above the far-field ground, exposing a
// floating-cliff gap underneath on hills. A vertical "skirt" strip hanging
// off the grass outer edge hides that gap. No UVs needed (flat vertex color),
// so this follows buildWallMeshes's %n indexing (no seam-duplicate ring)
// rather than the road/grass builders' n+1-ring pattern.
// §v3 Track A: the drop is now relative to the local grass edge height
// (SKIRT_DEPTH below it) rather than down to an absolute y — see SKIRT_DEPTH.
const skirtColor = new THREE.Color(0x3f5c34); // earthy brown-green, darker than the grass ribbon's 0x5cb85c
// §v4: on the space map the skirt has a different job — there is no terrain to
// seal against, so it is what gives the floating ribbon visible *thickness*
// when you look at it side-on from a crest. Shorter, and near-black so it
// reads as the underside of the track rather than as more track.
const spaceSkirtColor = new THREE.Color(0x140b22);
const SPACE_SKIRT_DEPTH = 1.6;

function buildGroundSkirtMesh(samples: TrackSample[], style: MapStyle): THREE.Mesh {
  const n = samples.length;
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  const depth = style === 'space' ? SPACE_SKIRT_DEPTH : SKIRT_DEPTH;
  const color = style === 'space' ? spaceSkirtColor : skirtColor;

  function addSkirtStrip(side: 1 | -1, vertexOffset: number) {
    for (let i = 0; i < n; i++) {
      const { pos, right } = samples[i];
      const top = pos.clone().addScaledVector(right, side * GRASS_HALF);
      positions.push(top.x, top.y, top.z, top.x, top.y - depth, top.z);
      colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
    }
    for (let i = 0; i < n; i++) {
      const a = vertexOffset + i * 2;
      const b = vertexOffset + ((i + 1) % n) * 2;
      // winding flips per side so both skirts face outward, same convention as buildWallMeshes
      if (side === 1) indices.push(a, b, b + 1, a, b + 1, a + 1);
      else indices.push(a, a + 1, b + 1, a, b + 1, b);
    }
  }

  addSkirtStrip(-1, 0);
  addSkirtStrip(1, n * 2);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  const mesh = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ vertexColors: true }));
  mesh.receiveShadow = false; // underside strip, never lit by the overhead directional light in a way worth shadowing
  return mesh;
}

function buildCheckerTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const cell = size / 8;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? '#ffffff' : '#111111';
      ctx.fillRect(x * cell, y * cell, cell, cell);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(2, 1);
  return texture;
}

function buildStartFinish(sample0: TrackSample): THREE.Group {
  const group = new THREE.Group();
  const { pos, right, forward } = sample0;

  const quad = new THREE.Mesh(
    new THREE.PlaneGeometry(ROAD_HALF * 2, 2),
    new THREE.MeshBasicMaterial({ map: buildCheckerTexture() }),
  );
  quad.rotation.x = -Math.PI / 2;
  quad.rotation.z = Math.atan2(forward.x, forward.z);
  quad.position.copy(pos).add(new THREE.Vector3(0, 0.01, 0));
  group.add(quad);

  const pillarGeo = new THREE.BoxGeometry(0.6, 5, 0.6);
  const pillarMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const beamGeo = new THREE.BoxGeometry(ROAD_HALF * 2 + 1.2, 0.6, 0.6);
  const beamMat = new THREE.MeshLambertMaterial({ color: 0xdd2222 });

  // §Phase 5 item 2: pillar/beam heights are offsets *above local track
  // height* (pos.y), not absolute world y -- small hills mean per-quad y from
  // its own sample is sufficient (no interpolation needed across the arch's
  // ~1m footprint).
  const leftPillar = new THREE.Mesh(pillarGeo, pillarMat);
  leftPillar.position.copy(pos).addScaledVector(right, -ROAD_HALF - 0.3);
  leftPillar.position.y = pos.y + 2.5;
  group.add(leftPillar);

  const rightPillar = new THREE.Mesh(pillarGeo, pillarMat);
  rightPillar.position.copy(pos).addScaledVector(right, ROAD_HALF + 0.3);
  rightPillar.position.y = pos.y + 2.5;
  group.add(rightPillar);

  const beam = new THREE.Mesh(beamGeo, beamMat);
  beam.position.copy(pos);
  beam.position.y = pos.y + 5;
  beam.rotation.y = Math.atan2(forward.x, forward.z);
  group.add(beam);

  return group;
}

// Trackside dressing (§Phase 9): cones, low-poly trees, and floating ring
// gates, all InstancedMesh so the prop count never adds more than a handful
// of draw calls regardless of how many are placed.
const START_CLEARANCE_SAMPLES = 10; // keep props away from the start arch

// §v3 Track A review finding #2: trackside props used to be planted at their
// own centerline sample's height (`sample.pos.y + a local offset`). The ground
// heightfield can't be that high anywhere another part of the ribbon passes
// within TERRAIN_CLAMP_RADIUS at a lower elevation -- on the inside of the
// graded esses the circuit doubles back ~16m away and ~2m lower, and the
// terrain there is (correctly) held below the *lower* ribbon, so trees, warp
// pipes and grandstands hung up to 2.2m in the air. Planting them on exactly
// the floor Environment clamps the terrain to puts them back on the ground.
// Everywhere else the prop's own sample already *is* the minimum, so nothing
// moves. Brute-force over the 600 samples: this runs a few dozen times at
// track-build time, not per frame.
// Only for props set back beyond the grass ribbon -- cones (on the grass) and
// the ring gates / arch banner (over the road) still key off the ribbon.
function propGroundY(samples: TrackSample[], x: number, z: number, fallbackY: number): number {
  const radiusSq = TERRAIN_CLAMP_RADIUS * TERRAIN_CLAMP_RADIUS;
  let lowest = fallbackY;
  for (const sample of samples) {
    const dx = sample.pos.x - x;
    const dz = sample.pos.z - z;
    if (dx * dx + dz * dz <= radiusSq && sample.pos.y < lowest) lowest = sample.pos.y;
  }
  return lowest - GROUND_SINK;
}

// §v4: on the space map everything that grows out of the ground is skipped
// (there is no ground) — only the floating ring gates survive, recoloured as
// neon hoops.
function buildTracksideProps(samples: TrackSample[], style: MapStyle): THREE.Group {
  const group = new THREE.Group();
  const n = samples.length;
  const isNearStart = (i: number) => Math.min(i, n - i) < START_CLEARANCE_SAMPLES;
  const space = style === 'space';
  if (space) return buildRingGates(samples, group, space);

  // Trees: trunk + cone top, alternating sides, every ~23m. Stride retuned
  // for the §Phase 4 item 5 layout's ~1.67m sample spacing (was ~1.55m/sample).
  const treeIndices: number[] = [];
  for (let i = 0; i < n; i += 14) if (!isNearStart(i)) treeIndices.push(i);

  const trunkGeo = new THREE.CylinderGeometry(0.15, 0.2, 1.2, 6);
  const trunkMat = new THREE.MeshLambertMaterial({ color: 0x6b4423 });
  const trunkMesh = new THREE.InstancedMesh(trunkGeo, trunkMat, treeIndices.length);
  trunkMesh.castShadow = true; // §Phase 4 item 3

  const topGeo = new THREE.ConeGeometry(0.9, 2.2, 7);
  const topMat = new THREE.MeshLambertMaterial({ color: 0x2f8f3f });
  const topMesh = new THREE.InstancedMesh(topGeo, topMat, treeIndices.length);
  topMesh.castShadow = true; // §Phase 4 item 3

  // §Phase 5 item 2: translations are a local ground height + a local offset,
  // not an absolute world y -- otherwise trees near the hill would float or
  // bury themselves. §v3 Track A review finding #2: that ground height is now
  // propGroundY, not the sample's own y (see above).
  const m = new THREE.Matrix4();
  treeIndices.forEach((idx, i) => {
    const side = i % 2 === 0 ? 1 : -1;
    const sample = samples[idx];
    const offset = GRASS_HALF + 3 + (i % 3);
    const pos = sample.pos.clone().addScaledVector(sample.right, side * offset);
    const groundY = propGroundY(samples, pos.x, pos.z, sample.pos.y);
    m.makeTranslation(pos.x, groundY + 0.6, pos.z);
    trunkMesh.setMatrixAt(i, m);
    m.makeTranslation(pos.x, groundY + 1.2 + 1.1, pos.z);
    topMesh.setMatrixAt(i, m);
  });
  trunkMesh.instanceMatrix.needsUpdate = true;
  topMesh.instanceMatrix.needsUpdate = true;
  group.add(trunkMesh, topMesh);

  // Cones: single-piece, closer to the road, every ~15m. Stride retuned for
  // the §Phase 4 item 5 layout's ~1.67m sample spacing.
  const coneIndices: number[] = [];
  for (let i = 0; i < n; i += 9) if (!isNearStart(i)) coneIndices.push(i);

  const coneGeo = new THREE.ConeGeometry(0.4, 1.0, 8);
  const coneMat = new THREE.MeshLambertMaterial({ color: 0xff7f11 });
  const coneMesh = new THREE.InstancedMesh(coneGeo, coneMat, coneIndices.length);
  coneIndices.forEach((idx, i) => {
    const side = i % 2 === 0 ? -1 : 1;
    const sample = samples[idx];
    const pos = sample.pos.clone().addScaledVector(sample.right, side * (ROAD_HALF + 1.5));
    m.makeTranslation(pos.x, pos.y + 0.5, pos.z);
    coneMesh.setMatrixAt(i, m);
  });
  coneMesh.instanceMatrix.needsUpdate = true;
  group.add(coneMesh);

  return buildRingGates(samples, group, space);
}

// Floating ring gates: centered on the road, spanning it like a hoop, every
// ~77m. Stride retuned for the §Phase 4 item 5 layout's ~1.67m sample spacing.
// §v4: these are the one trackside prop both styles share — a lit yellow hoop
// on the meadow map, an unlit magenta one on the space map.
function buildRingGates(samples: TrackSample[], group: THREE.Group, space: boolean): THREE.Group {
  const n = samples.length;
  const ringIndices: number[] = [];
  for (let i = 0; i < n; i += 46) ringIndices.push(i);

  const ringGeo = new THREE.TorusGeometry(2.2, 0.22, 8, 16);
  const ringMat = space
    ? new THREE.MeshBasicMaterial({ color: 0xff77e0 })
    : new THREE.MeshLambertMaterial({ color: 0xffd23f });
  const ringMesh = new THREE.InstancedMesh(ringGeo, ringMat, ringIndices.length);
  const ringAxis = new THREE.Vector3(0, 0, 1); // TorusGeometry's hole runs along local Z
  const quat = new THREE.Quaternion();
  const m = new THREE.Matrix4();
  ringIndices.forEach((idx, i) => {
    const sample = samples[idx];
    const pos = sample.pos.clone().add(new THREE.Vector3(0, 3, 0));
    quat.setFromUnitVectors(ringAxis, sample.forward);
    m.compose(pos, quat, new THREE.Vector3(1, 1, 1));
    ringMesh.setMatrixAt(i, m);
  });
  ringMesh.instanceMatrix.needsUpdate = true;
  group.add(ringMesh);

  return group;
}

// §Phase 4 item 4: track-authored surface-zone visuals. A soft cyan double
// chevron (canvas texture on an unlit plane) for boost pads, a translucent
// tan ribbon for sand. Both are purely cosmetic — TrackQuery.surfaceAt +
// stepKart's `surface` param drive the actual physics independently.
const SURFACE_VISUAL_Y = 0.012; // just above the road/grass surface, avoids z-fighting

function buildBoostChevronTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.strokeStyle = '#eafcff';
  ctx.lineWidth = 14;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const chevron = (cy: number) => {
    ctx.beginPath();
    ctx.moveTo(size * 0.18, cy + size * 0.16);
    ctx.lineTo(size * 0.5, cy - size * 0.16);
    ctx.lineTo(size * 0.82, cy + size * 0.16);
    ctx.stroke();
  };
  chevron(size * 0.32);
  chevron(size * 0.68);
  const texture = new THREE.CanvasTexture(canvas);
  return texture;
}

const boostChevronMaterial = new THREE.MeshBasicMaterial({
  map: buildBoostChevronTexture(),
  color: 0x33e6ff,
  transparent: true,
  depthWrite: false,
});

// A handful of chevron quads spanning the zone's s-range, each pointing
// along track-forward at its own sample so they follow curvature.
function buildBoostPadVisual(samples: TrackSample[], totalLength: number, zone: SurfaceZone): THREE.Group {
  const group = new THREE.Group();
  const latMin = zone.latMin ?? -ROAD_HALF;
  const latMax = zone.latMax ?? ROAD_HALF;
  const lateralCenter = (latMin + latMax) / 2;
  const width = latMax - latMin;
  const chevronCount = 3;
  for (let i = 0; i < chevronCount; i++) {
    const t = (i + 0.5) / chevronCount;
    const s = zone.sStart + (zone.sEnd - zone.sStart) * t;
    const sample = sampleAtArcLength(samples, totalLength, s);
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(width * 0.8, 2.4), boostChevronMaterial);
    quad.rotation.x = -Math.PI / 2;
    quad.rotation.z = Math.atan2(sample.forward.x, sample.forward.z);
    quad.position.copy(sample.pos).addScaledVector(sample.right, lateralCenter);
    quad.position.y += SURFACE_VISUAL_Y;
    group.add(quad);
  }
  return group;
}

const sandPatchMaterial = new THREE.MeshBasicMaterial({
  color: 0xd9b26a,
  transparent: true,
  opacity: 0.6,
  depthWrite: false,
});

// A ribbon following the curve across the zone's s-range and lateral extent —
// same construction idea as buildGrassMesh but for one short, one-off patch.
// Assumes zone.sStart < zone.sEnd (non-wrapping); wrap-across-seam zones still
// work physically via TrackQuery.surfaceAt, they just render no visual patch.
function buildSandPatchVisual(samples: TrackSample[], totalLength: number, zone: SurfaceZone): THREE.Mesh {
  const latMin = zone.latMin ?? -GRASS_HALF;
  const latMax = zone.latMax ?? GRASS_HALF;
  const segments = 8;
  const positions: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const s = zone.sStart + (zone.sEnd - zone.sStart) * t;
    const sample = sampleAtArcLength(samples, totalLength, s);
    const inner = sample.pos.clone().addScaledVector(sample.right, latMin);
    const outer = sample.pos.clone().addScaledVector(sample.right, latMax);
    positions.push(inner.x, inner.y + SURFACE_VISUAL_Y, inner.z, outer.x, outer.y + SURFACE_VISUAL_Y, outer.z);
  }
  for (let i = 0; i < segments; i++) {
    const a = i * 2;
    const b = (i + 1) * 2;
    indices.push(a, b, b + 1, a, b + 1, a + 1);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, sandPatchMaterial);
}

function buildSurfaceZoneVisuals(
  samples: TrackSample[],
  totalLength: number,
  zones: readonly SurfaceZone[],
): THREE.Group {
  const group = new THREE.Group();
  for (const zone of zones) {
    if (zone.sStart > zone.sEnd) continue; // wrap-across-seam zones: physics only, no authored visual yet
    if (zone.type === 'boost') group.add(buildBoostPadVisual(samples, totalLength, zone));
    else group.add(buildSandPatchVisual(samples, totalLength, zone));
  }
  return group;
}

// §Phase 4 item 6: a handful of hand-placed set-pieces (grandstands, an arch
// banner, warp-pipe-style cylinders), positioned by (s, lateral) via
// sampleAtArcLength so they follow the curve regardless of layout changes.
// Purely decorative — no collision, no gameplay effect.

function buildAwningTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 8;
  const ctx = canvas.getContext('2d')!;
  const stripes = 8;
  const stripeWidth = canvas.width / stripes;
  for (let i = 0; i < stripes; i++) {
    ctx.fillStyle = i % 2 === 0 ? '#e6483c' : '#f5f5f5';
    ctx.fillRect(i * stripeWidth, 0, stripeWidth, canvas.height);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.repeat.set(3, 1);
  return texture;
}

function buildGrandstand(): THREE.Group {
  const group = new THREE.Group();
  const base = new THREE.Mesh(
    new THREE.BoxGeometry(10, 3.4, 5),
    new THREE.MeshLambertMaterial({ color: 0x9aa3ad }),
  );
  base.position.y = 1.7;
  group.add(base);

  const awning = new THREE.Mesh(
    new THREE.BoxGeometry(11, 0.35, 5.6),
    new THREE.MeshLambertMaterial({ map: buildAwningTexture() }),
  );
  awning.position.y = 3.7;
  group.add(awning);

  return group;
}

// Generic celebratory checker/star pattern — deliberately no wordmarks or
// character likenesses (see README's IP note re: fan-made character assets).
function buildBannerTexture(): THREE.CanvasTexture {
  const w = 256;
  const h = 64;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createLinearGradient(0, 0, w, 0);
  gradient.addColorStop(0, '#ffd23f');
  gradient.addColorStop(0.5, '#ff7f11');
  gradient.addColorStop(1, '#ffd23f');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, w, h);
  const cell = 16;
  ctx.fillStyle = 'rgba(28,28,28,0.85)';
  for (let y = 0; y < h; y += cell) {
    for (let x = 0; x < w; x += cell) {
      if (((x / cell) + (y / cell)) % 2 === 0) ctx.fillRect(x, y, cell, cell);
    }
  }
  return new THREE.CanvasTexture(canvas);
}

function buildArchBanner(): THREE.Group {
  const group = new THREE.Group();
  const pillarGeo = new THREE.BoxGeometry(0.7, 6, 0.7);
  const pillarMat = new THREE.MeshLambertMaterial({ color: 0x2f3b4c });

  const left = new THREE.Mesh(pillarGeo, pillarMat);
  left.position.set(-(GRASS_HALF + 0.5), 3, 0);
  group.add(left);

  const right = new THREE.Mesh(pillarGeo, pillarMat);
  right.position.set(GRASS_HALF + 0.5, 3, 0);
  group.add(right);

  const banner = new THREE.Mesh(
    new THREE.PlaneGeometry(GRASS_HALF * 2 + 2, 1.6),
    new THREE.MeshLambertMaterial({ map: buildBannerTexture(), side: THREE.DoubleSide }),
  );
  banner.position.set(0, 5.4, 0);
  group.add(banner);

  return group;
}

function buildWarpPipe(): THREE.Group {
  const group = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(1.1, 1.1, 3.2, 16),
    new THREE.MeshLambertMaterial({ color: 0x2f9e44 }),
  );
  body.position.y = 1.6;
  group.add(body);

  const rim = new THREE.Mesh(
    new THREE.CylinderGeometry(1.4, 1.4, 0.6, 16),
    new THREE.MeshLambertMaterial({ color: 0x1f7a33 }),
  );
  rim.position.y = 3.5;
  group.add(rim);

  return group;
}

function buildSetPieces(samples: TrackSample[], totalLength: number): THREE.Group {
  const group = new THREE.Group();

  // `onTerrain` props sit beyond the grass ribbon, so they are planted on the
  // heightfield's floor rather than on their own sample (§v3 Track A review
  // finding #2, see propGroundY). Props over the road keep the ribbon height.
  function placeAt(obj: THREE.Object3D, s: number, lateral: number, extraYaw = 0, onTerrain = false) {
    const sample = sampleAtArcLength(samples, totalLength, s);
    obj.position.copy(sample.pos).addScaledVector(sample.right, lateral);
    if (onTerrain) obj.position.y = propGroundY(samples, obj.position.x, obj.position.z, sample.pos.y);
    obj.rotation.y = Math.atan2(sample.forward.x, sample.forward.z) + extraYaw;
    group.add(obj);
  }

  // Grandstands: one on the start straight, one facing the long back
  // straight, both set back beyond the grass, facing in toward the road.
  placeAt(buildGrandstand(), 40, GRASS_HALF + 9, -Math.PI / 2, true);
  placeAt(buildGrandstand(), 540, -(GRASS_HALF + 9), Math.PI / 2, true);

  // Arch banner spanning the road partway around the esses/back-straight transition.
  placeAt(buildArchBanner(), 470, 0);

  // Warp-pipe clusters flanking the double-apex and the hairpin.
  placeAt(buildWarpPipe(), 165, GRASS_HALF + 4, 0, true);
  placeAt(buildWarpPipe(), 178, GRASS_HALF + 7, 0, true);
  placeAt(buildWarpPipe(), 752, -(GRASS_HALF + 4), 0, true);

  return group;
}

export function buildTrack(map: MapDef): TrackData {
  const { samples, totalLength } = buildSamples(map.controlPoints);
  const style = map.style;

  const checkpoints: number[] = [];
  for (let i = 0; i < CHECKPOINT_COUNT; i++) {
    checkpoints.push(Math.round((i * SAMPLE_COUNT) / CHECKPOINT_COUNT) % SAMPLE_COUNT);
  }

  // §Phase 4 finding #6: validate LapTracker's WRAP_GUARD safety margin
  // against this layout's actual checkpoint spacing, right where that
  // spacing is known.
  let minCheckpointGap = Infinity;
  for (let i = 0; i < checkpoints.length; i++) {
    const sA = samples[checkpoints[i]].s;
    const sB = samples[checkpoints[(i + 1) % checkpoints.length]].s;
    const gap = (((sB - sA) % totalLength) + totalLength) % totalLength;
    minCheckpointGap = Math.min(minCheckpointGap, gap);
  }
  checkWrapGuardSafety(minCheckpointGap);

  const group = new THREE.Group();
  group.add(buildRoadMesh(samples, totalLength, style));
  group.add(buildGrassMesh(samples, totalLength, style));
  group.add(buildGroundSkirtMesh(samples, style));
  group.add(buildWallMeshes(samples, style));
  group.add(buildStartFinish(samples[checkpoints[0]]));
  group.add(buildTracksideProps(samples, style));
  group.add(buildSurfaceZoneVisuals(samples, totalLength, map.surfaceZones));
  // Grandstands, arch banners and warp pipes are all planted on terrain that
  // only the meadow map has (§v4).
  if (style !== 'space') group.add(buildSetPieces(samples, totalLength));

  return { samples, totalLength, checkpoints, group };
}
