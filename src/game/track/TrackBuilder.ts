import * as THREE from 'three';
import { buildLayout, type JumpData, type ShortcutData } from './TrackSampler';
import { GRASS_HALF, ROAD_HALF, type SurfaceZone, type TrackZone } from './trackData';
import type { MapDef } from './maps';
import { buildAsphaltTexture } from '../render/textures';
import { toonMaterial, toonVertexMaterial } from '../render/ToonMaterials';
import { at, merge, part } from '../render/propKit';
// Value imports from TrackQuery/LapTracker are safe here (no runtime cycle):
// TrackQuery's only import of this module is `import type`, and LapTracker's
// is too — both erased at compile time.
import { TrackQuery, sampleAtArcLength } from './TrackQuery';
import { checkWrapGuardSafety } from '../race/LapTracker';
import { TUNING } from '../tuning';

export interface TrackSample {
  pos: THREE.Vector3;
  forward: THREE.Vector3;
  right: THREE.Vector3;
  s: number;
  grade: number; // §Phase 5 item 2: forward.y -- slope along the track direction, +up
  // §v5 banking: road roll in radians, + = the +`right` edge lower. The ground
  // at a signed lateral offset L is pos.y - L * tan(bank) (see TrackQuery).
  // (`right` is the driver's on-screen left — see trackData.ts's bank note.)
  bank: number;
  zone: TrackZone; // §v5: scenery/verge theme (esplanade, headland, harbour, cane)
  feature: 'ramp' | 'gap' | null; // §v5 jump: on the kicker ramp / over the rail gap
}

export interface TrackData {
  samples: TrackSample[];
  totalLength: number;
  checkpoints: number[];
  group: THREE.Group;
  // §v5: resolved per-map features, handed straight to TrackQuery (main.ts:
  // `new TrackQuery(track.samples, track.totalLength, track.surfaceZones, track)`).
  surfaceZones: SurfaceZone[];
  shortcut: ShortcutData | null;
  jump: JumpData | null;
}

const STRIPE_WIDTH = 0.4;
const WALL_HEIGHT = 1.0;
const FENCE_HEIGHT = 0.8;
const TEXTURE_V_SCALE = 8; // meters of arc length per texture repeat, longitudinally (§Phase 4 item 1)
// §v3 Track A: the skirt's drop is measured *down from the local verge edge*
// (not to an absolute y), so it seals the seam against the terrain
// heightfield at every elevation. §v5: on banked corners the low edge can sit
// a few metres under the centerline, and the heightfield's bank slack digs a
// little deeper there, so this grew from 3m.
const SKIRT_DEPTH = 4;

// u = signed lateral offset in meters / TEXTURE_V_SCALE; v = arc length /
// TEXTURE_V_SCALE — equal texel density both ways (§Phase 4 finding #5). The
// final cross-section ring duplicates ring 0 with v = totalLength/scale so the
// texture never jumps at the start/finish seam.
const U_EDGE_L = -ROAD_HALF / TEXTURE_V_SCALE;
const U_STRIPE_L = -(ROAD_HALF - STRIPE_WIDTH) / TEXTURE_V_SCALE;
const U_STRIPE_R = (ROAD_HALF - STRIPE_WIDTH) / TEXTURE_V_SCALE;
const U_EDGE_R = ROAD_HALF / TEXTURE_V_SCALE;

// --- §v5 palette ------------------------------------------------------------
// Tarmac is warm grey (it sits under a golden-hour key light, and a neutral
// grey reads blue-ish against the sand); each zone gets its own verge and
// barrier so the lap reads as places, not one ribbon. These tint the grey
// asphalt texture (multiplied), hence how light they are.
const ASPHALT: Record<TrackZone, number> = {
  esplanade: 0xd8cdc2,
  headland: 0xc4bcc6,
  harbour: 0xe2dace,
  cane: 0xd3c6b8,
};
const VERGE: Record<TrackZone, number> = {
  esplanade: 0xf4d9a6, // beach sand
  headland: 0xb7b46e, // dry headland grass
  harbour: 0xcfc6b6, // concrete apron
  cane: 0x93bf4f, // headland grass between cane blocks
};
const SKIRT: Record<TrackZone, number> = {
  esplanade: 0xcdb183,
  headland: 0x3b3a48, // basalt
  harbour: 0x8d8678,
  cane: 0x7a5a3a,
};
const BARRIER: Record<TrackZone, [number, number]> = {
  esplanade: [0xffffff, 0xff5a4e], // lifeguard white / coral
  headland: [0x4a4958, 0xffd23f], // basalt with yellow delineators
  harbour: [0xffd23f, 0x3b3a48], // wharf yellow / charcoal
  cane: [0xa8743f, 0xc98f52], // timber rails
};
const BALLAST = 0x6f5d4a; // the rail cutting's floor under the jump
const KERB_RED = new THREE.Color(0xff5a4e);
const STRIPE_WHITE = new THREE.Color(0xf6f1e7);
const DIRT = 0xa8764a;
const DIRT_RUT = 0x8c5f3a;

// §v5 banking: every ribbon vertex sits on the rolled cross-section.
function ribbonPoint(sample: TrackSample, lateral: number, lift = 0): THREE.Vector3 {
  const p = sample.pos.clone().addScaledVector(sample.right, lateral);
  p.y = sample.pos.y - lateral * Math.tan(sample.bank) + lift;
  return p;
}

// Corners get red/white kerbs, straights a plain white edge line.
function isCorner(samples: TrackSample[], i: number): boolean {
  const n = samples.length;
  const a = samples[(i - 2 + n) % n].right;
  const b = samples[(i + 2) % n].right;
  return Math.acos(Math.min(1, a.dot(b))) > 0.07;
}

function buildRoadMesh(samples: TrackSample[], totalLength: number): THREE.Mesh {
  const n = samples.length;
  const positions: number[] = [];
  const colors: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const road = new THREE.Color();
  const kerb = new THREE.Color();

  // 4 cross-section vertices per ring: edgeL, stripeL, stripeR, edgeR.
  for (let i = 0; i <= n; i++) {
    const sample = samples[i % n];
    const v = (i < n ? sample.s : totalLength) / TEXTURE_V_SCALE;
    road.setHex(sample.feature === 'gap' ? BALLAST : ASPHALT[sample.zone]);
    if (Math.floor(i / 4) % 2 === 1) road.multiplyScalar(0.94); // faint banding reads speed
    const corner = isCorner(samples, i % n) && sample.feature !== 'gap';
    kerb.copy(sample.feature === 'gap' ? road : corner && Math.floor(i / 2) % 2 === 0 ? KERB_RED : STRIPE_WHITE);
    for (const lat of [-ROAD_HALF, -(ROAD_HALF - STRIPE_WIDTH), ROAD_HALF - STRIPE_WIDTH, ROAD_HALF]) {
      const p = ribbonPoint(sample, lat, 0.01);
      positions.push(p.x, p.y, p.z);
    }
    colors.push(kerb.r, kerb.g, kerb.b, road.r, road.g, road.b, road.r, road.g, road.b, kerb.r, kerb.g, kerb.b);
    uvs.push(U_EDGE_L, v, U_STRIPE_L, v, U_STRIPE_R, v, U_EDGE_R, v);
  }
  for (let i = 0; i < n; i++) {
    const a = i * 4;
    const b = (i + 1) * 4;
    for (let band = 0; band < 3; band++) indices.push(a + band, b + band, b + band + 1, a + band, b + band + 1, a + band + 1);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, toonMaterial({ vertexColors: true, map: buildAsphaltTexture() }));
  mesh.receiveShadow = true; // §Phase 4 item 3
  return mesh;
}

// The verge (ROAD_HALF..GRASS_HALF each side): same off-road physics as ever
// (|lateral| > ROAD_HALF), dressed per zone — sand on the esplanade, concrete
// apron on the breakwater, grass among the cane.
function buildVergeMesh(samples: TrackSample[]): THREE.Mesh {
  const n = samples.length;
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const c = new THREE.Color();
  for (let i = 0; i <= n; i++) {
    const sample = samples[i % n];
    c.setHex(sample.feature === 'gap' ? BALLAST : VERGE[sample.zone]);
    for (const lat of [-GRASS_HALF, -ROAD_HALF, ROAD_HALF, GRASS_HALF]) {
      const p = ribbonPoint(sample, lat);
      positions.push(p.x, p.y, p.z);
      const j = 0.93 + (((i * 7 + lat * 13) % 5) + 5) % 5 * 0.03; // deterministic mottling
      colors.push(c.r * j, c.g * j, c.b * j);
    }
  }
  for (let i = 0; i < n; i++) {
    const a = i * 4;
    const b = (i + 1) * 4;
    for (const band of [0, 2]) indices.push(a + band, b + band, b + band + 1, a + band, b + band + 1, a + band + 1);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, toonVertexMaterial());
  mesh.receiveShadow = true;
  return mesh;
}

// A vertical strip hung along each corridor edge — the skirt (down from the
// verge edge, sealing the seam against the terrain) and the barriers (up from
// it) share this. `keep(i)` decides per segment, which is how the barriers get
// their openings (the jump gap, the shortcut mouths) without any extra pass.
// §v5 review #7: it may also return the [t0, t1] fraction of the segment to
// draw, so an opening's edge can fall mid-segment.
function buildEdgeStrips(
  samples: TrackSample[],
  offset: number,
  from: number,
  to: number,
  color: (i: number, side: 1 | -1) => THREE.Color,
  keep: (i: number, side: 1 | -1) => boolean | readonly [number, number],
): THREE.BufferGeometry {
  const n = samples.length;
  const positions: number[] = [];
  const colors: number[] = [];
  for (const side of [-1, 1] as const) {
    for (let i = 0; i < n; i++) {
      const span = keep(i, side);
      if (!span) continue;
      const p0 = ribbonPoint(samples[i], side * offset);
      const p1 = ribbonPoint(samples[(i + 1) % n], side * offset);
      const [t0, t1] = span === true ? [0, 1] : span;
      const a = p0.clone().lerp(p1, t0);
      const b = p0.clone().lerp(p1, t1);
      const c = color(i, side);
      const quad = [
        [a, from],
        [b, from],
        [b, to],
        [a, from],
        [b, to],
        [a, to],
      ] as const;
      // Wind both sides to face the road.
      const order = side === 1 ? [0, 1, 2, 3, 4, 5] : [0, 2, 1, 3, 5, 4];
      for (const k of order) {
        const [p, dy] = quad[k];
        positions.push(p.x, p.y + dy, p.z);
        colors.push(c.r, c.g, c.b);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  return geometry;
}

function buildStartFinish(sample: TrackSample): THREE.Mesh {
  // §v5: an original arch — two surfboard pylons (coral, cobalt) carrying a
  // sunshine-yellow beam with a checker band and a rising-sun disc on top. No
  // text, no logos. Built as one merged, vertex-coloured mesh (one draw call),
  // including the checker line painted across the road.
  const parts: THREE.BufferGeometry[] = [];
  const pylonX = GRASS_HALF + 0.9;
  for (const [x, color] of [
    [-pylonX, 0xff5a4e],
    [pylonX, 0x3d7bff],
  ] as const) {
    const board = new THREE.CapsuleGeometry(0.9, 6.4, 6, 12);
    parts.push(part(board, color, at(x, 4.1, 0, 0, 0, 0, 1, 1, 0.32)));
    parts.push(part(new THREE.BoxGeometry(0.12, 7.2, 0.34), 0xffffff, at(x, 4.1, 0))); // stringer
    parts.push(part(new THREE.CylinderGeometry(0.5, 0.7, 0.5, 10), 0x3b3a48, at(x, 0.25, 0)));
  }
  const beamY = 8.1;
  parts.push(part(new THREE.BoxGeometry(pylonX * 2, 1.5, 0.7), 0xffd23f, at(0, beamY, 0)));
  const cells = 20;
  const cellW = (pylonX * 2 - 1) / cells;
  for (let i = 0; i < cells; i++) {
    for (let row = 0; row < 2; row++) {
      const color = (i + row) % 2 === 0 ? 0x232028 : 0xfaf6ee;
      const x = -pylonX + 0.5 + cellW * (i + 0.5);
      for (const z of [-0.37, 0.37]) {
        parts.push(part(new THREE.PlaneGeometry(cellW, 0.42), color, at(x, beamY - 0.21 + row * 0.42, z, 0, z < 0 ? Math.PI : 0)));
      }
    }
  }
  // Rising sun on the beam: a half disc with rays.
  parts.push(part(new THREE.CylinderGeometry(1.7, 1.7, 0.5, 20, 1, false, -Math.PI / 2, Math.PI), 0xff9a3c, at(0, beamY + 0.75, 0, Math.PI / 2, 0, 0)));
  for (let k = 0; k < 7; k++) {
    const a = (k / 6) * Math.PI;
    parts.push(part(new THREE.BoxGeometry(0.28, 1.1, 0.3), 0xffd23f, at(Math.cos(a) * 2.5, beamY + 0.75 + Math.sin(a) * 2.5, 0, 0, 0, a - Math.PI / 2)));
  }
  // Checker line across the road (two rows), lifted just above the tarmac.
  const across = 16;
  const w = (ROAD_HALF * 2) / across;
  for (let i = 0; i < across; i++) {
    for (let row = 0; row < 2; row++) {
      const color = (i + row) % 2 === 0 ? 0x1d1b22 : 0xfaf6ee;
      parts.push(part(new THREE.PlaneGeometry(w, 0.9), color, at(-ROAD_HALF + w * (i + 0.5), 0.02, (row - 0.5) * 0.9, -Math.PI / 2)));
    }
  }
  const mesh = new THREE.Mesh(merge(parts), toonVertexMaterial());
  // Local frame: +x = track right, +z = track forward (heading yaw).
  mesh.position.copy(sample.pos);
  mesh.rotation.y = Math.atan2(sample.forward.x, sample.forward.z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// §Phase 4 item 4: boost-pad visuals — soft cyan double chevrons pointing along
// the track. §v5: all pads merged into one geometry (one draw call).
const SURFACE_VISUAL_Y = 0.03;

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
  return new THREE.CanvasTexture(canvas);
}

function buildBoostPads(samples: TrackSample[], totalLength: number, zones: readonly SurfaceZone[]): THREE.Mesh | null {
  const pads = zones.filter((z) => z.type === 'boost' && z.sStart <= z.sEnd);
  if (pads.length === 0) return null;
  const positions: number[] = [];
  const uvs: number[] = [];
  for (const zone of pads) {
    const latMin = zone.latMin ?? -ROAD_HALF;
    const latMax = zone.latMax ?? ROAD_HALF;
    const inset = (latMax - latMin) * 0.1;
    const chevrons = 3;
    for (let k = 0; k < chevrons; k++) {
      const s0 = zone.sStart + ((zone.sEnd - zone.sStart) * (k + 0.1)) / chevrons;
      const s1 = zone.sStart + ((zone.sEnd - zone.sStart) * (k + 0.9)) / chevrons;
      const a = sampleAtArcLength(samples, totalLength, s0);
      const b = sampleAtArcLength(samples, totalLength, s1);
      const p = [
        ribbonPoint(a, latMin + inset, SURFACE_VISUAL_Y),
        ribbonPoint(a, latMax - inset, SURFACE_VISUAL_Y),
        ribbonPoint(b, latMax - inset, SURFACE_VISUAL_Y),
        ribbonPoint(b, latMin + inset, SURFACE_VISUAL_Y),
      ];
      for (const idx of [0, 2, 1, 0, 3, 2]) positions.push(p[idx].x, p[idx].y, p[idx].z);
      const uv = [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ];
      for (const idx of [0, 2, 1, 0, 3, 2]) uvs.push(uv[idx][0], uv[idx][1]);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  return new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({
      map: buildBoostChevronTexture(),
      color: 0x33e6ff,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
}

// §v5 shortcut: the dirt track and its timber fence. Both stop where they run
// into the main corridor (the fork and the rejoin), so the dirt never paints
// over the tarmac and the fence never stands across the main road.
function buildShortcut(shortcut: ShortcutData, query: TrackQuery): THREE.Group {
  const group = new THREE.Group();
  const pts = shortcut.samples;
  const n = pts.length;
  const half = shortcut.wallHalf;
  const insideMainRoad = (p: THREE.Vector3) => Math.abs(query.corridorOffsets(p.x, p.z).main) < ROAD_HALF;
  const insideMainCorridor = (p: THREE.Vector3) => Math.abs(query.corridorOffsets(p.x, p.z).main) < GRASS_HALF;
  const edge = (i: number, lat: number, lift: number) => pts[i].pos.clone().addScaledVector(pts[i].right, lat).add(new THREE.Vector3(0, lift, 0));
  const drape = (p: THREE.Vector3) => p.setY(query.groundHeightAt(p) + 0.02);

  // Dirt ribbon: 4 bands (verge, rut, crown, rut, verge) across the width.
  const lats = [-half, -2.2, -0.9, 0.9, 2.2, half];
  const bandColor = [DIRT, DIRT_RUT, DIRT, DIRT_RUT, DIRT];
  const positions: number[] = [];
  const colors: number[] = [];
  const c = new THREE.Color();
  for (let i = 0; i < n - 1; i++) {
    const quadCorners = [edge(i, -half, 0), edge(i, half, 0), edge(i + 1, -half, 0), edge(i + 1, half, 0)];
    if (quadCorners.every(insideMainRoad)) continue;
    for (let b = 0; b < lats.length - 1; b++) {
      // §v5 review #6: draped on the physics ground (which blends the
      // shortcut's height into the main road's at each junction) rather than
      // the shortcut spline's own height, so the dirt matches what karts ride.
      const p00 = drape(edge(i, lats[b], 0));
      const p01 = drape(edge(i, lats[b + 1], 0));
      const p10 = drape(edge(i + 1, lats[b], 0));
      const p11 = drape(edge(i + 1, lats[b + 1], 0));
      c.setHex(bandColor[b]).multiplyScalar(0.94 + (i % 3) * 0.03);
      for (const p of [p00, p10, p11, p00, p11, p01]) {
        positions.push(p.x, p.y, p.z);
        colors.push(c.r, c.g, c.b);
      }
    }
  }
  const dirt = new THREE.BufferGeometry();
  dirt.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  dirt.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  dirt.computeVertexNormals();
  const dirtMesh = new THREE.Mesh(dirt, toonVertexMaterial({ polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
  dirtMesh.receiveShadow = true;
  group.add(dirtMesh);

  // Fence: a low timber rail on posts, as one strip + instanced-free posts
  // merged in. Skipped wherever the fence line is inside the main corridor.
  const fence: THREE.BufferGeometry[] = [];
  const rail = new THREE.Color(0xb07a45);
  const railPositions: number[] = [];
  const railColors: number[] = [];
  for (const side of [-1, 1] as const) {
    for (let i = 0; i < n - 1; i++) {
      const a = edge(i, side * half, 0);
      const b = edge(i + 1, side * half, 0);
      if (insideMainCorridor(a) || insideMainCorridor(b)) continue;
      for (const [y0, y1] of [
        [0.35, 0.5],
        [0.65, FENCE_HEIGHT],
      ]) {
        const quad = [a.clone().setY(a.y + y0), b.clone().setY(b.y + y0), b.clone().setY(b.y + y1), a.clone().setY(a.y + y1)];
        for (const idx of side === 1 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2]) {
          railPositions.push(quad[idx].x, quad[idx].y, quad[idx].z);
          railColors.push(rail.r, rail.g, rail.b);
        }
      }
      if (i % 3 === 0) fence.push(part(new THREE.BoxGeometry(0.16, FENCE_HEIGHT + 0.1, 0.16), 0x7d5530, at(a.x, a.y + FENCE_HEIGHT / 2, a.z)));
    }
  }
  const rails = new THREE.BufferGeometry();
  rails.setAttribute('position', new THREE.Float32BufferAttribute(railPositions, 3));
  rails.setAttribute('color', new THREE.Float32BufferAttribute(railColors, 3));
  rails.computeVertexNormals();
  fence.push(rails);
  const fenceMesh = new THREE.Mesh(merge(fence), toonVertexMaterial({ side: THREE.DoubleSide }));
  fenceMesh.castShadow = true;
  group.add(fenceMesh);
  return group;
}

// §v5 jump: concrete abutments closing off the rail cutting at both ends —
// the lip's face and the landing's — full corridor width, with hazard
// stripes along the lip so it reads from a distance.
function buildJumpAbutments(samples: TrackSample[], jump: JumpData): THREE.Mesh {
  const parts: THREE.BufferGeometry[] = [];
  const n = samples.length;
  const lip = samples[jump.lipIndex];
  const land = samples[(jump.lipIndex + Math.ceil((jump.gapEndS - jump.lipS) / (samples[1].s - samples[0].s))) % n];
  const floorY = lip.pos.y - jump.rampHeight - jump.gapDepth - 0.6;
  const width = GRASS_HALF * 2 + 1;
  for (const [sample, faceDir] of [
    [lip, 1],
    [land, -1],
  ] as const) {
    // Top kept just under the road so the (sloping) ramp surface behind the
    // lip never has the block poking through it.
    const top = sample.pos.y - 0.3;
    const h = top - floorY;
    const yaw = Math.atan2(sample.forward.x, sample.forward.z);
    const m = at(sample.pos.x, floorY + h / 2, sample.pos.z, 0, yaw).multiply(at(0, 0, -faceDir * 0.3));
    parts.push(part(new THREE.BoxGeometry(width, h, 0.6), 0xbdb6aa, m));
  }
  // Hazard bands painted across the last few metres of the ramp, so the lip
  // reads from the approach (from behind, the gap itself is hidden by the crest).
  const positions: number[] = [];
  const colors: number[] = [];
  const bands = 8;
  const c = new THREE.Color();
  const a = samples[(jump.lipIndex - 2 + n) % n];
  for (let k = 0; k < bands; k++) {
    const t0 = k / bands;
    const t1 = (k + 0.5) / bands;
    const p = (t: number, lat: number) => ribbonPoint(a, lat, 0.03).lerp(ribbonPoint(lip, lat, 0.03), t);
    const quad = [p(t0, -ROAD_HALF), p(t0, ROAD_HALF), p(t1, ROAD_HALF), p(t1, -ROAD_HALF)];
    c.setHex(k % 2 ? 0x2a2830 : 0xffd23f);
    for (const idx of [0, 2, 1, 0, 3, 2]) {
      positions.push(quad[idx].x, quad[idx].y, quad[idx].z);
      colors.push(c.r, c.g, c.b);
    }
  }
  const paint = new THREE.BufferGeometry();
  paint.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  paint.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  paint.computeVertexNormals();
  parts.push(paint);

  const mesh = new THREE.Mesh(merge(parts), toonVertexMaterial({ side: THREE.DoubleSide }));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

export function buildTrack(map: MapDef): TrackData {
  const layout = buildLayout(map.track);
  const { samples, totalLength, checkpoints } = layout;

  // §Phase 4 finding #6: validate LapTracker's WRAP_GUARD safety margin
  // against this layout's actual checkpoint spacing, right where that
  // spacing is known.
  let minCheckpointGap = Infinity;
  for (let i = 0; i < checkpoints.length; i++) {
    const sA = samples[checkpoints[i]].s;
    const sB = samples[checkpoints[(i + 1) % checkpoints.length]].s;
    minCheckpointGap = Math.min(minCheckpointGap, (((sB - sA) % totalLength) + totalLength) % totalLength);
  }
  checkWrapGuardSafety(minCheckpointGap);

  // A build-time query for "is this point inside the other corridor" when
  // cutting openings (the game's own TrackQuery is built by main.ts).
  const query = new TrackQuery(samples, totalLength, layout.surfaceZones, layout);
  const n = samples.length;

  const group = new THREE.Group();
  group.add(buildRoadMesh(samples, totalLength));
  group.add(buildVergeMesh(samples));

  const skirt = buildEdgeStrips(
    samples,
    GRASS_HALF,
    -SKIRT_DEPTH,
    0,
    (i) => new THREE.Color(SKIRT[samples[i].zone]),
    () => true,
  );
  group.add(new THREE.Mesh(skirt, toonVertexMaterial()));

  // Barriers: striped per zone; open over the jump gap (the abutments close
  // it) and wherever a kart can actually drive through the wall line into the
  // shortcut. §v5 review #7: "can drive through" is asked of collision itself
  // (nearestSample legality for the kart's centre, i.e. the shortcut's
  // wallHalf - kartRadius), not of the shortcut's painted width — opening
  // the barrier out to the full wallHalf left ~1m either side of each mouth
  // with no barrier drawn but an invisible wall. The opening's edge is found
  // to within a few cm along the segment rather than rounded to a sample.
  const passable = (p: THREE.Vector3) => {
    const q = query.nearestSample(p);
    return q.corridor === 'shortcut' && Math.abs(q.lateral) <= q.wallHalf - TUNING.kartRadius;
  };
  const shortcutSpan = (i: number, side: 1 | -1): boolean | readonly [number, number] => {
    if (!layout.shortcut) return true;
    const a = ribbonPoint(samples[i], side * GRASS_HALF);
    const b = ribbonPoint(samples[(i + 1) % n], side * GRASS_HALF);
    const openAt = (t: number) => passable(a.clone().lerp(b, t));
    const STEPS = 8;
    const open: boolean[] = [];
    for (let k = 0; k <= STEPS; k++) open.push(openAt(k / STEPS));
    if (open.every((o) => !o)) return true;
    if (open.every((o) => o)) return false;
    // One edge of the opening falls inside this segment: bisect for it.
    const edgeAt = (lo: number, hi: number) => {
      const openLo = openAt(lo);
      for (let k = 0; k < 12; k++) {
        const mid = (lo + hi) / 2;
        if (openAt(mid) === openLo) lo = mid;
        else hi = mid;
      }
      return (lo + hi) / 2;
    };
    if (open[0] && !open[STEPS]) {
      const k = open.lastIndexOf(true);
      return [edgeAt(k / STEPS, (k + 1) / STEPS), 1];
    }
    if (!open[0] && open[STEPS]) {
      const k = open.indexOf(true);
      return [0, edgeAt((k - 1) / STEPS, k / STEPS)];
    }
    return false; // opening wholly inside one segment (never on this map): leave it open
  };
  const walls = buildEdgeStrips(
    samples,
    GRASS_HALF,
    0,
    WALL_HEIGHT,
    (i) => new THREE.Color(BARRIER[samples[i].zone][Math.floor(i / 2) % 2]),
    (i, side) => samples[i].feature !== 'gap' && samples[(i + 1) % n].feature !== 'gap' && shortcutSpan(i, side),
  );
  const wallMesh = new THREE.Mesh(walls, toonVertexMaterial({ side: THREE.DoubleSide }));
  wallMesh.castShadow = true;
  wallMesh.receiveShadow = true;
  group.add(wallMesh);

  group.add(buildStartFinish(samples[checkpoints[0]]));
  const pads = buildBoostPads(samples, totalLength, layout.surfaceZones);
  if (pads) group.add(pads);
  if (layout.shortcut) group.add(buildShortcut(layout.shortcut, query));
  if (layout.jump) group.add(buildJumpAbutments(samples, layout.jump));

  return {
    samples,
    totalLength,
    checkpoints,
    group,
    surfaceZones: layout.surfaceZones,
    shortcut: layout.shortcut,
    jump: layout.jump,
  };
}
