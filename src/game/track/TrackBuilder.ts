import * as THREE from 'three';
import { CONTROL_POINTS, ROAD_HALF, GRASS_HALF, CHECKPOINT_COUNT, SURFACE_ZONES, type SurfaceZone } from './trackData';
import { buildAsphaltTexture, buildGrassTexture, tryLoadTextureOverride } from '../render/textures';
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

const SAMPLE_COUNT = 600; // §Phase 4 item 5: ~1001m / 600 samples =~ 1.67m spacing
const RAW_SAMPLE_COUNT = 2000;
const STRIPE_WIDTH = 0.4;
const WALL_HEIGHT = 1.2;
const TEXTURE_V_SCALE = 8; // meters of arc length per texture repeat, longitudinally (§Phase 4 item 1)
const SKIRT_BOTTOM_Y = -2.5; // §Phase 5 elevation review fix #2: below Environment.ts's flat ground plane (y=-0.05)

const UP = new THREE.Vector3(0, 1, 0);
const MAX_SAMPLE_GRADE = 0.12; // §Phase 5 item 1: dev-time budget for adjacent-sample |dy/ds|

function findIndexForS(cum: number[], targetS: number): number {
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] < targetS) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function buildSamples(): { samples: TrackSample[]; totalLength: number } {
  const curve = new THREE.CatmullRomCurve3(CONTROL_POINTS, true, 'centripetal');
  const raw = curve.getPoints(RAW_SAMPLE_COUNT);

  const cum: number[] = [0];
  for (let i = 1; i < raw.length; i++) {
    cum.push(cum[i - 1] + raw[i].distanceTo(raw[i - 1]));
  }
  const totalLength = cum[cum.length - 1];

  const samples: TrackSample[] = [];
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    const targetS = (i / SAMPLE_COUNT) * totalLength;
    const idx = findIndexForS(cum, targetS);
    samples.push({ pos: raw[idx].clone(), s: targetS, forward: new THREE.Vector3(), right: new THREE.Vector3(), grade: 0 });
  }

  // forward/right computed from neighbor samples once all positions are known.
  // NOTE: our kart heading convention is forward = (sin(h), 0, cos(h)) (see
  // physics/Kart.ts kartForward), for which "driver's right" is up x forward
  // (not forward x up as it would be for a forward = (0,0,-1)-at-rest convention).
  // §Phase 5 item 2: `forward` is taken from the full 3D neighbor positions
  // (so it carries the local grade), but `right` is explicitly built from
  // forward's *horizontal* projection so it stays perfectly level (no
  // banking, out of scope) regardless of slope -- banking would otherwise
  // creep in because UP x forward's magnitude depends on forward's pitch even
  // though its direction happens to already be horizontal.
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    const prev = samples[(i - 1 + SAMPLE_COUNT) % SAMPLE_COUNT].pos;
    const next = samples[(i + 1) % SAMPLE_COUNT].pos;
    const forward = next.clone().sub(prev).normalize();
    const horizontalForward = new THREE.Vector3(forward.x, 0, forward.z).normalize();
    samples[i].forward = forward;
    samples[i].right = UP.clone().cross(horizontalForward).normalize();
    samples[i].grade = forward.y;
  }

  checkGradeSafety(samples, totalLength);

  return { samples, totalLength };
}

// §Phase 5 item 1: a cheap one-time startup sanity check on the authored
// heights -- warns (doesn't throw) if the Catmull-Rom-smoothed per-sample
// slope ever exceeds the ~10% grade budget by a meaningful margin, catching
// an over-steep control-point edit before it ships. Runs unconditionally
// (it's O(n) over the sample count, once, at track build time -- not worth
// gating behind a dev-only flag). Wrap-aware at the start/finish seam.
function checkGradeSafety(samples: TrackSample[], totalLength: number) {
  const n = samples.length;
  for (let i = 0; i < n; i++) {
    const a = samples[i];
    const b = samples[(i + 1) % n];
    const dy = b.pos.y - a.pos.y;
    let ds = b.s - a.s;
    if (ds <= 0) ds += totalLength; // wrap at the seam (n-1 -> 0)
    const grade = ds > 0 ? Math.abs(dy / ds) : 0;
    if (grade > MAX_SAMPLE_GRADE) {
      console.warn(
        `[trackData] adjacent-sample grade ${grade.toFixed(3)} exceeds ${MAX_SAMPLE_GRADE} budget near s=${a.s.toFixed(1)}m`,
      );
    }
  }
}

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

function buildRoadMesh(samples: TrackSample[], totalLength: number): THREE.Mesh {
  const n = samples.length;
  const ringCount = n + 1;
  const positions: number[] = [];
  const colors: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const stripeColor = new THREE.Color(0xf2f2f2);
  const lightGray = new THREE.Color(0x707070);
  const darkGray = new THREE.Color(0x5c5c5c);

  // 4 cross-section vertices per ring: edgeL, stripeL, stripeR, edgeR.
  for (let i = 0; i < ringCount; i++) {
    const sampleIdx = i % n;
    const { pos, right } = samples[sampleIdx];
    const sValue = i < n ? samples[sampleIdx].s : totalLength;
    const v = sValue / TEXTURE_V_SCALE;
    const roadColor = Math.floor(sampleIdx / 4) % 2 === 0 ? lightGray : darkGray;

    const edgeL = pos.clone().addScaledVector(right, -ROAD_HALF);
    const stripeL = pos.clone().addScaledVector(right, -(ROAD_HALF - STRIPE_WIDTH));
    const stripeR = pos.clone().addScaledVector(right, ROAD_HALF - STRIPE_WIDTH);
    const edgeR = pos.clone().addScaledVector(right, ROAD_HALF);

    for (const vtx of [edgeL, stripeL, stripeR, edgeR]) {
      positions.push(vtx.x, vtx.y + 0.001, vtx.z);
    }
    colors.push(
      stripeColor.r, stripeColor.g, stripeColor.b,
      roadColor.r, roadColor.g, roadColor.b,
      roadColor.r, roadColor.g, roadColor.b,
      stripeColor.r, stripeColor.g, stripeColor.b,
    );
    uvs.push(U_EDGE_L, v, U_STRIPE_L, v, U_STRIPE_R, v, U_EDGE_R, v);
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

function buildGrassMesh(samples: TrackSample[], totalLength: number): THREE.Mesh {
  const n = samples.length;
  const ringCount = n + 1;
  const positions: number[] = [];
  const colors: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const baseGreen = new THREE.Color(0x5cb85c);

  // Two ribbons (left ROAD_HALF..GRASS_HALF, right ROAD_HALF..GRASS_HALF), 4 verts per ring.
  for (let i = 0; i < ringCount; i++) {
    const sampleIdx = i % n;
    const { pos, right } = samples[sampleIdx];
    const sValue = i < n ? samples[sampleIdx].s : totalLength;
    const v = sValue / TEXTURE_V_SCALE;
    const jitter = () => 0.9 + Math.random() * 0.2;

    const innerL = pos.clone().addScaledVector(right, -ROAD_HALF);
    const outerL = pos.clone().addScaledVector(right, -GRASS_HALF);
    const innerR = pos.clone().addScaledVector(right, ROAD_HALF);
    const outerR = pos.clone().addScaledVector(right, GRASS_HALF);

    for (const vtx of [outerL, innerL, innerR, outerR]) {
      positions.push(vtx.x, vtx.y, vtx.z);
    }
    for (let k = 0; k < 4; k++) {
      const j = jitter();
      colors.push(baseGreen.r * j, baseGreen.g * j, baseGreen.b * j);
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

  const material = new THREE.MeshLambertMaterial({ vertexColors: true, map: buildGrassTexture() });
  tryLoadTextureOverride('/assets/textures/grass.jpg', material);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true; // §Phase 4 item 3
  return mesh;
}

function buildWallMeshes(samples: TrackSample[]): THREE.Mesh {
  const n = samples.length;
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  const red = new THREE.Color(0xcc2b2b);
  const white = new THREE.Color(0xf0f0f0);

  function addWallStrip(side: 1 | -1, vertexOffset: number) {
    for (let i = 0; i < n; i++) {
      const { pos, right } = samples[i];
      const base = pos.clone().addScaledVector(right, side * GRASS_HALF);
      const top = base.clone().add(new THREE.Vector3(0, WALL_HEIGHT, 0));
      positions.push(base.x, base.y, base.z, top.x, top.y, top.z);
      const stripeColor = Math.floor(i / 2) % 2 === 0 ? red : white;
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

  return new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
}

// §Phase 5 elevation review fix #2: on graded (hilly) sections, the grass
// ribbon's outer edge now sits above/below Environment.ts's flat far-field
// ground plane (y=-0.05), exposing a floating-cliff gap underneath on hills.
// A vertical "skirt" strip from the grass outer edge straight down to a
// constant y hides that gap. No UVs needed (flat vertex color), so this
// follows buildWallMeshes's %n indexing (no seam-duplicate ring) rather than
// the road/grass builders' n+1-ring pattern.
const skirtColor = new THREE.Color(0x3f5c34); // earthy brown-green, darker than the grass ribbon's 0x5cb85c

function buildGroundSkirtMesh(samples: TrackSample[]): THREE.Mesh {
  const n = samples.length;
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  function addSkirtStrip(side: 1 | -1, vertexOffset: number) {
    for (let i = 0; i < n; i++) {
      const { pos, right } = samples[i];
      const top = pos.clone().addScaledVector(right, side * GRASS_HALF);
      positions.push(top.x, top.y, top.z, top.x, SKIRT_BOTTOM_Y, top.z);
      colors.push(skirtColor.r, skirtColor.g, skirtColor.b, skirtColor.r, skirtColor.g, skirtColor.b);
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

function buildTracksideProps(samples: TrackSample[]): THREE.Group {
  const group = new THREE.Group();
  const n = samples.length;
  const isNearStart = (i: number) => Math.min(i, n - i) < START_CLEARANCE_SAMPLES;

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

  // §Phase 5 item 2: translations are pos.y + a local offset, not an absolute
  // world y -- otherwise trees near the hill would float or bury themselves.
  const m = new THREE.Matrix4();
  treeIndices.forEach((idx, i) => {
    const side = i % 2 === 0 ? 1 : -1;
    const sample = samples[idx];
    const offset = GRASS_HALF + 3 + (i % 3);
    const pos = sample.pos.clone().addScaledVector(sample.right, side * offset);
    m.makeTranslation(pos.x, pos.y + 0.6, pos.z);
    trunkMesh.setMatrixAt(i, m);
    m.makeTranslation(pos.x, pos.y + 1.2 + 1.1, pos.z);
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

  // Floating ring gates: centered on the road, spanning it like a hoop, every
  // ~77m. Stride retuned for the §Phase 4 item 5 layout's ~1.67m sample spacing.
  const ringIndices: number[] = [];
  for (let i = 0; i < n; i += 46) ringIndices.push(i);

  const ringGeo = new THREE.TorusGeometry(2.2, 0.22, 8, 16);
  const ringMat = new THREE.MeshLambertMaterial({ color: 0xffd23f });
  const ringMesh = new THREE.InstancedMesh(ringGeo, ringMat, ringIndices.length);
  const ringAxis = new THREE.Vector3(0, 0, 1); // TorusGeometry's hole runs along local Z
  const quat = new THREE.Quaternion();
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

function buildSurfaceZoneVisuals(samples: TrackSample[], totalLength: number): THREE.Group {
  const group = new THREE.Group();
  for (const zone of SURFACE_ZONES) {
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

  function placeAt(obj: THREE.Object3D, s: number, lateral: number, extraYaw = 0) {
    const sample = sampleAtArcLength(samples, totalLength, s);
    obj.position.copy(sample.pos).addScaledVector(sample.right, lateral);
    obj.rotation.y = Math.atan2(sample.forward.x, sample.forward.z) + extraYaw;
    group.add(obj);
  }

  // Grandstands: one on the start straight, one facing the long back
  // straight, both set back beyond the grass, facing in toward the road.
  placeAt(buildGrandstand(), 40, GRASS_HALF + 9, -Math.PI / 2);
  placeAt(buildGrandstand(), 540, -(GRASS_HALF + 9), Math.PI / 2);

  // Arch banner spanning the road partway around the esses/back-straight transition.
  placeAt(buildArchBanner(), 470, 0);

  // Warp-pipe clusters flanking the double-apex and the hairpin.
  placeAt(buildWarpPipe(), 165, GRASS_HALF + 4);
  placeAt(buildWarpPipe(), 178, GRASS_HALF + 7);
  placeAt(buildWarpPipe(), 752, -(GRASS_HALF + 4));

  return group;
}

export function buildTrack(): TrackData {
  const { samples, totalLength } = buildSamples();

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
  group.add(buildRoadMesh(samples, totalLength));
  group.add(buildGrassMesh(samples, totalLength));
  group.add(buildGroundSkirtMesh(samples));
  group.add(buildWallMeshes(samples));
  group.add(buildStartFinish(samples[checkpoints[0]]));
  group.add(buildTracksideProps(samples));
  group.add(buildSurfaceZoneVisuals(samples, totalLength));
  group.add(buildSetPieces(samples, totalLength));

  return { samples, totalLength, checkpoints, group };
}
