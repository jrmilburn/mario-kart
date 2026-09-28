import * as THREE from 'three';
import type { TrackQuery } from '../track/TrackQuery';
import { sampleAtArcLength } from '../track/TrackQuery';
import { GRASS_HALF } from '../track/trackData';
import { toonVertexMaterial } from './ToonMaterials';
import { at, makeRandom, merge, part } from './propKit';

// §v5 Capricorn Coast scenery, planted by Environment.ts. Every repeated
// object is ONE draw call: an InstancedMesh per type (palms, Norfolk pines,
// cane clumps, rocks, basalt columns, boats) or one merged vertex-coloured
// mesh for one-off set pieces (pontoons, the beacon, the beach, the islands,
// the rail crossing and its cane train). All original designs; no signage.
//
// Everything is placed deterministically (seeded PRNG) on the exact terrain
// height (ctx.groundAt) and kept clear of both track corridors via the
// terrain field's `dist` (which already treats the shortcut fence like the
// main wall).

export interface CoastContext {
  query: TrackQuery;
  groundAt: (x: number, z: number) => number;
  coastDistance: (x: number, z: number) => number;
  headlandFactor: (x: number, z: number) => number;
  isCaneLand: (x: number, z: number) => boolean;
  seaLevel: number;
  headlandCenter: readonly [number, number];
  headlandRadius: number;
  blendOuter: number;
  clampRadius: number;
}

interface Placement {
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
  tint?: number; // 0..1 shade jitter
}

const TAU = Math.PI * 2;
const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpP = new THREE.Vector3();
const tmpS = new THREE.Vector3();
const tmpC = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);
// §v5 perf: spatial chunk sizes for instancedChunks (metres). The cane is by
// far the biggest set (thousands of clumps), so it gets smaller cells.
const PROP_CELL = 120;
const CANE_CELL = 90;

function instanced(geometry: THREE.BufferGeometry, material: THREE.Material, places: Placement[], name: string, shade = 0.18): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, places.length));
  mesh.name = name;
  mesh.count = places.length;
  places.forEach((pl, i) => {
    tmpQ.setFromAxisAngle(UP, pl.yaw);
    tmpS.setScalar(pl.scale);
    tmpM.compose(tmpP.set(pl.x, pl.y, pl.z), tmpQ, tmpS);
    mesh.setMatrixAt(i, tmpM);
    if (pl.tint !== undefined) mesh.setColorAt(i, tmpC.setScalar(1 - shade / 2 + pl.tint * shade));
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
  return mesh;
}

// §v5 perf: the same thing split into square spatial cells, one InstancedMesh
// per non-empty cell, all sharing ONE geometry and ONE material (so no extra
// shader programs and no extra GPU memory beyond the instance matrices). A
// single InstancedMesh's bounding sphere spans every instance — the cane's
// covers the whole inland half of the map — so it is never frustum-culled,
// in either split-screen view or in the shadow pass. Chunks let each camera
// (and the ~80m shadow box) skip the cells it can't see. Cells are big on
// purpose: every visible chunk is one more draw call, which is CPU the
// main-thread hand tracker also needs.
function instancedChunks(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  places: Placement[],
  name: string,
  cell: number,
  shadows: { cast?: boolean; receive?: boolean },
  shade = 0.18,
): THREE.Group {
  const group = new THREE.Group();
  group.name = name;
  const buckets = new Map<string, Placement[]>();
  for (const pl of places) {
    const key = `${Math.floor(pl.x / cell)},${Math.floor(pl.z / cell)}`;
    let list = buckets.get(key);
    if (!list) buckets.set(key, (list = []));
    list.push(pl);
  }
  for (const [key, list] of buckets) {
    const mesh = instanced(geometry, material, list, `${name}[${key}]`, shade);
    mesh.castShadow = !!shadows.cast;
    mesh.receiveShadow = !!shadows.receive;
    group.add(mesh);
  }
  return group;
}

// --- geometry ------------------------------------------------------------------

// A coconut palm: a curving ringed trunk, eight drooping fronds, coconuts.
function palmGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const segs = 6;
  const segH = 1.35;
  const lean = (k: number) => 0.05 * k * k;
  for (let k = 0; k < segs; k++) {
    const r0 = 0.3 - k * 0.028;
    const r1 = 0.3 - (k + 1) * 0.028;
    const x0 = lean(k);
    const x1 = lean(k + 1);
    const tilt = Math.atan2(x1 - x0, segH);
    parts.push(part(new THREE.CylinderGeometry(r1, r0, segH, 6, 1, true), k % 2 ? 0x8a6a48 : 0x9c7a54, at((x0 + x1) / 2, segH * (k + 0.5), 0, 0, 0, -tilt)));
  }
  const crown = new THREE.Vector3(lean(segs), segH * segs, 0);
  // Fronds: a tapered strip bent under its own weight.
  const fronds = 8;
  const positions: number[] = [];
  const colors: number[] = [];
  const dark = new THREE.Color(0x3a8a3c);
  const light = new THREE.Color(0x67b24c);
  const c = new THREE.Color();
  for (let f = 0; f < fronds; f++) {
    const a = (f / fronds) * TAU + (f % 2) * 0.2;
    const dir = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    const side = new THREE.Vector3(-dir.z, 0, dir.x);
    const lift = f % 2 ? 0.9 : 0.45;
    const station = (t: number) => crown.clone().addScaledVector(dir, 3.4 * t).add(new THREE.Vector3(0, lift * t - 2.1 * t * t, 0));
    const width = (t: number) => 0.62 * Math.sin(Math.PI * Math.min(1, t * 1.15)) + 0.04;
    const steps = 4;
    for (let k = 0; k < steps; k++) {
      const t0 = k / steps;
      const t1 = (k + 1) / steps;
      const p0 = station(t0);
      const p1 = station(t1);
      const l0 = p0.clone().addScaledVector(side, width(t0));
      const r0 = p0.clone().addScaledVector(side, -width(t0));
      const l1 = p1.clone().addScaledVector(side, width(t1));
      const r1 = p1.clone().addScaledVector(side, -width(t1));
      // Fold the leaf slightly along its spine (a shallow V reads as a frond).
      p0.y += 0.12;
      p1.y += 0.12;
      for (const tri of [
        [l0, p0, l1],
        [p0, p1, l1],
        [p0, r0, p1],
        [r0, r1, p1],
      ]) {
        for (const p of tri) {
          positions.push(p.x, p.y, p.z);
          c.copy(dark).lerp(light, t1);
          colors.push(c.r, c.g, c.b);
        }
      }
    }
  }
  const leaves = new THREE.BufferGeometry();
  leaves.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  leaves.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  leaves.computeVertexNormals();
  parts.push(leaves);
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * TAU;
    parts.push(part(new THREE.IcosahedronGeometry(0.2, 0), 0x6b4a2a, at(crown.x + Math.cos(a) * 0.28, crown.y - 0.3, Math.sin(a) * 0.28)));
  }
  return merge(parts);
}

// A Norfolk Island pine: tall straight trunk, flat tiers of branches
// shrinking to a spike — the silhouette that lines the real esplanades.
function norfolkPineGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(part(new THREE.CylinderGeometry(0.1, 0.3, 12, 6), 0x6e5038, at(0, 6, 0)));
  const tiers = 8;
  for (let k = 0; k < tiers; k++) {
    const t = k / (tiers - 1);
    const r = THREE.MathUtils.lerp(2.7, 0.55, t);
    parts.push(part(new THREE.ConeGeometry(r, 0.95, 7), k % 2 ? 0x2f6e3d : 0x3a7f45, at(0, 3.4 + t * 7.6, 0, 0, k * 0.4)));
  }
  parts.push(part(new THREE.ConeGeometry(0.3, 1.6, 6), 0x3a7f45, at(0, 11.9, 0)));
  return merge(parts);
}

// A cane clump: stalks fanning up out of one stool, each with a long leaf
// arching off it. Double-sided, vertex-coloured from a dark base to the
// bright cane green at the tips.
function caneClumpGeometry(): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const base = new THREE.Color(0x4f7d24);
  const tip = new THREE.Color(0x7dba3a);
  const leaf = new THREE.Color(0x96cc52);
  const stalks = 5;
  const push = (p: THREE.Vector3, c: THREE.Color) => {
    positions.push(p.x, p.y, p.z);
    colors.push(c.r, c.g, c.b);
  };
  for (let k = 0; k < stalks; k++) {
    const a = (k / stalks) * TAU + 0.3 * k;
    const lean = 0.12 + (k % 3) * 0.06;
    const h = 2.6 + (k % 2) * 0.6;
    const dir = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    const side = new THREE.Vector3(-dir.z, 0, dir.x);
    const b0 = dir.clone().multiplyScalar(0.25).addScaledVector(side, -0.09);
    const b1 = dir.clone().multiplyScalar(0.25).addScaledVector(side, 0.09);
    const top = dir.clone().multiplyScalar(0.25 + h * lean).setY(h);
    push(b0, base);
    push(b1, base);
    push(top, tip);
    // Leaf arching out from two-thirds up.
    const l0 = dir.clone().multiplyScalar(0.25 + h * lean * 0.66).setY(h * 0.66);
    const la = a + 0.9;
    const ldir = new THREE.Vector3(Math.cos(la), 0, Math.sin(la));
    const lmid = l0.clone().addScaledVector(ldir, 0.8).setY(h * 0.66 + 0.35);
    const lend = l0.clone().addScaledVector(ldir, 1.5).setY(h * 0.66 - 0.2);
    const lside = new THREE.Vector3(-ldir.z, 0, ldir.x).multiplyScalar(0.12);
    push(l0, tip);
    push(lmid.clone().add(lside), leaf);
    push(lmid.clone().sub(lside), leaf);
    push(lmid.clone().add(lside), leaf);
    push(lend, leaf);
    push(lmid.clone().sub(lside), leaf);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  g.computeVertexNormals();
  return g;
}

function basaltColumnGeometry(): THREE.BufferGeometry {
  // Unit hexagonal prism, base at y=0, top cap lighter (weathered).
  const g = new THREE.CylinderGeometry(1, 1, 1, 6, 1).toNonIndexed();
  g.translate(0, 0.5, 0);
  g.deleteAttribute('uv');
  const normals = g.getAttribute('normal');
  const colors = new Float32Array(normals.count * 3);
  const side = new THREE.Color(0x3b3a48);
  const top = new THREE.Color(0x5a586c);
  for (let i = 0; i < normals.count; i++) {
    const c = normals.getY(i) > 0.5 ? top : side;
    colors.set([c.r, c.g, c.b], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

function boatGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  // Hull: a squashed octagonal barrel with a pointed bow, lying along +z.
  parts.push(part(new THREE.CylinderGeometry(1.05, 0.9, 4.4, 8), 0xf6f2ea, at(0, 0.35, -0.4, Math.PI / 2, 0, 0, 1, 1, 0.55)));
  parts.push(part(new THREE.ConeGeometry(1.05, 1.9, 8), 0xf6f2ea, at(0, 0.35, 2.75, Math.PI / 2, 0, 0, 1, 1, 0.55)));
  parts.push(part(new THREE.BoxGeometry(2.02, 0.16, 4.2), 0xff5a4e, at(0, 0.5, -0.3))); // boot stripe
  parts.push(part(new THREE.BoxGeometry(1.7, 0.08, 4.6), 0xc49a64, at(0, 0.66, 0.1))); // deck
  parts.push(part(new THREE.BoxGeometry(1.4, 0.85, 1.8), 0xffffff, at(0, 1.1, -0.6))); // cabin
  parts.push(part(new THREE.BoxGeometry(1.42, 0.22, 1.5), 0x2d4e6e, at(0, 1.2, -0.55))); // windows
  parts.push(part(new THREE.CylinderGeometry(0.05, 0.06, 5.2, 5), 0xd8d4cc, at(0, 3.2, 0.5))); // mast
  parts.push(part(new THREE.CylinderGeometry(0.04, 0.04, 2.4, 4), 0xd8d4cc, at(0, 1.6, -0.6, Math.PI / 2))); // boom
  return merge(parts);
}

function rockGeometry(): THREE.BufferGeometry {
  const g = new THREE.DodecahedronGeometry(1, 0); // polyhedra are already non-indexed
  g.deleteAttribute('uv');
  const pos = g.getAttribute('position');
  // Chunky, flattened armour stone.
  for (let i = 0; i < pos.count; i++) pos.setY(i, pos.getY(i) * 0.62);
  g.computeVertexNormals();
  const colors = new Float32Array(pos.count * 3).fill(1);
  tmpC.setHex(0x6b6874);
  for (let i = 0; i < pos.count; i++) colors.set([tmpC.r, tmpC.g, tmpC.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

// --- placement ------------------------------------------------------------------

export function buildCoastProps(ctx: CoastContext): { group: THREE.Group; update: (time: number) => void } {
  const group = new THREE.Group();
  group.name = 'coast-props';
  const { query, groundAt, seaLevel } = ctx;
  const samples = query.samples;
  const total = query.totalLength;
  const trackDist = (x: number, z: number) => query.terrainTrackField(x, z, ctx.blendOuter, ctx.clampRadius)?.dist ?? Infinity;
  const dry = (x: number, z: number, margin = 0.4) => groundAt(x, z) > seaLevel + margin;

  // The rail line under the jump: perpendicular to the road at the deepest
  // point of the gap. Computed first so the cane can leave room for it.
  const jump = query.jump;
  let rail: { origin: THREE.Vector3; dir: THREE.Vector3 } | null = null;
  if (jump) {
    const s = (jump.lipS + jump.gapEndS) / 2;
    const sample = sampleAtArcLength(samples, total, s);
    rail = { origin: sample.pos.clone(), dir: sample.right.clone() };
  }
  const nearRail = (x: number, z: number, pad: number) => {
    if (!rail) return false;
    const dx = x - rail.origin.x;
    const dz = z - rail.origin.z;
    const along = dx * rail.dir.x + dz * rail.dir.z;
    const across = Math.abs(dx * rail.dir.z - dz * rail.dir.x);
    return across < pad && Math.abs(along) < 140;
  };

  // Palms + Norfolk pines along the esplanade, the sweeper and the marina
  // shore, and scattered over the beach.
  const palms: Placement[] = [];
  const pines: Placement[] = [];
  const rng = makeRandom(0xc0a57);
  const nearStart = (s: number) => Math.min(s, total - s) < 16;
  for (let i = 0; i < samples.length; i += 5) {
    const sp = samples[i];
    if (nearStart(sp.s)) continue;
    const zone = sp.zone;
    if (zone !== 'esplanade' && zone !== 'harbour') continue;
    for (const side of [-1, 1]) {
      const lateral = side * (GRASS_HALF + 2.5 + rng() * 5);
      const x = sp.pos.x + sp.right.x * lateral;
      const z = sp.pos.z + sp.right.z * lateral;
      if (!dry(x, z) || trackDist(x, z) < GRASS_HALF + 2) continue;
      // Pines stand in a formal row on the inland side of the esplanade;
      // palms everywhere else.
      const pine = zone === 'esplanade' && side === -1 && i % 10 === 0;
      if (!pine && rng() < 0.35) continue;
      (pine ? pines : palms).push({ x, y: groundAt(x, z) - 0.2, z, yaw: rng() * TAU, scale: 0.85 + rng() * 0.4 });
    }
  }
  for (let k = 0; k < 400 && palms.length < 150; k++) {
    const x = -50 + rng() * 60;
    const z = -150 + rng() * 240;
    const d = ctx.coastDistance(x, z);
    if (d < -30 || d > -9 || trackDist(x, z) < GRASS_HALF + 3 || !dry(x, z, 0.6)) continue;
    palms.push({ x, y: groundAt(x, z) - 0.2, z, yaw: rng() * TAU, scale: 0.8 + rng() * 0.45 });
  }
  // Pines on the headland top.
  for (let k = 0; k < 120 && pines.length < 60; k++) {
    const a = rng() * TAU;
    const r = rng() * ctx.headlandRadius * 0.62;
    const x = ctx.headlandCenter[0] + Math.cos(a) * r;
    const z = ctx.headlandCenter[1] + Math.sin(a) * r;
    if (ctx.headlandFactor(x, z) < 0.98 || trackDist(x, z) < GRASS_HALF + 4) continue;
    pines.push({ x, y: groundAt(x, z) - 0.2, z, yaw: rng() * TAU, scale: 0.75 + rng() * 0.45 });
  }
  const palmMesh = instancedChunks(palmGeometry(), toonVertexMaterial({ side: THREE.DoubleSide }), palms, 'palms', PROP_CELL, { cast: true });
  const pineMesh = instancedChunks(norfolkPineGeometry(), toonVertexMaterial(), pines, 'norfolk-pines', PROP_CELL, { cast: true });
  group.add(palmMesh, pineMesh);

  // Cane: a jittered grid over the cane land, in blocks separated by
  // headland tracks, leaving the road verges, the shortcut fence and the rail
  // line clear. No shadow casting (thousands of instances in the shadow pass
  // for shade nobody can see under the canopy) — they receive only.
  const cane: Placement[] = [];
  const caneRng = makeRandom(0xca9e);
  const CANE_STEP = 3.3;
  for (let gz = -150; gz <= 330; gz += CANE_STEP) {
    for (let gx = -36; gx <= 240; gx += CANE_STEP) {
      const x = gx + (caneRng() - 0.5) * CANE_STEP * 0.7;
      const z = gz + (caneRng() - 0.5) * CANE_STEP * 0.7;
      if (((x % 52) + 52) % 52 < 4 || ((z % 38) + 38) % 38 < 3.5) continue; // headland tracks
      if (!ctx.isCaneLand(x, z) || nearRail(x, z, 6)) continue;
      const d = trackDist(x, z);
      if (d < GRASS_HALF + 2.2 || d > 150) continue;
      if (!dry(x, z, 0.8)) continue;
      cane.push({ x, y: groundAt(x, z) - 0.1, z, yaw: caneRng() * TAU, scale: 0.85 + caneRng() * 0.35, tint: caneRng() });
    }
  }
  const caneMesh = instancedChunks(caneClumpGeometry(), toonVertexMaterial({ side: THREE.DoubleSide }), cane, 'cane', CANE_CELL, { receive: true }, 0.25);
  group.add(caneMesh);

  // Rock armour along the breakwater, the harbour head and the marina causeway
  // (wherever a harbour-zone verge edge drops toward the water).
  const rocks: Placement[] = [];
  const rockRng = makeRandom(0x70c5);
  for (let i = 0; i < samples.length; i += 1) {
    const sp = samples[i];
    if (sp.zone !== 'harbour') continue;
    for (const side of [-1, 1]) {
      if (rockRng() < 0.35) continue;
      const lateral = side * (GRASS_HALF + 1.2 + rockRng() * 4.5);
      const x = sp.pos.x + sp.right.x * lateral;
      const z = sp.pos.z + sp.right.z * lateral;
      const y = groundAt(x, z);
      if (y > seaLevel + 2.6 || trackDist(x, z) < GRASS_HALF + 0.8) continue;
      rocks.push({ x, y: y - 0.15, z, yaw: rockRng() * TAU, scale: 0.9 + rockRng() * 1.1, tint: rockRng() });
    }
  }
  // Boulders at the foot of the headland cliffs.
  for (let k = 0; k < 160; k++) {
    const a = rockRng() * TAU;
    const r = ctx.headlandRadius * (0.95 + rockRng() * 0.25);
    const x = ctx.headlandCenter[0] + Math.cos(a) * r;
    const z = ctx.headlandCenter[1] + Math.sin(a) * r;
    if (trackDist(x, z) < GRASS_HALF + 3) continue;
    const y = groundAt(x, z);
    if (y > seaLevel + 1.5) continue;
    rocks.push({ x, y: y - 0.2, z, yaw: rockRng() * TAU, scale: 1.2 + rockRng() * 1.8, tint: rockRng() });
  }
  const rockMesh = instancedChunks(rockGeometry(), toonVertexMaterial(), rocks, 'rock-armour', PROP_CELL, { receive: true }, 0.3);
  group.add(rockMesh);

  // Basalt columns crowding the headland's cliff band, standing up out of the
  // sea to just above the cliff surface.
  const columns = new THREE.InstancedMesh(basaltColumnGeometry(), toonVertexMaterial(), 320);
  columns.name = 'basalt-columns';
  let colCount = 0;
  const colRng = makeRandom(0xba5a17);
  for (let k = 0; k < 900 && colCount < 320; k++) {
    const a = colRng() * TAU;
    const r = ctx.headlandRadius * (0.66 + colRng() * 0.34);
    const x = ctx.headlandCenter[0] + Math.cos(a) * r;
    const z = ctx.headlandCenter[1] + Math.sin(a) * r;
    const f = ctx.headlandFactor(x, z);
    if (f < 0.04 || f > 0.96 || trackDist(x, z) < GRASS_HALF + 5) continue;
    const top = groundAt(x, z) + 0.4 + colRng() * 2.2;
    const bottom = seaLevel - 3;
    const radius = 1.1 + colRng() * 0.9;
    tmpQ.setFromAxisAngle(UP, colRng() * TAU);
    tmpM.compose(tmpP.set(x, bottom, z), tmpQ, tmpS.set(radius, top - bottom, radius));
    columns.setMatrixAt(colCount, tmpM);
    columns.setColorAt(colCount, tmpC.setScalar(0.85 + colRng() * 0.3));
    colCount++;
  }
  columns.count = colCount;
  columns.instanceMatrix.needsUpdate = true;
  if (columns.instanceColor) columns.instanceColor.needsUpdate = true;
  columns.computeBoundingSphere();
  columns.castShadow = true;
  columns.receiveShadow = true;
  group.add(columns);

  // --- harbour: pontoons, moored boats, the channel beacon ------------------------
  const wet = (x: number, z: number) => groundAt(x, z) < seaLevel - 0.6 && trackDist(x, z) > GRASS_HALF + 3;
  const pontoonParts: THREE.BufferGeometry[] = [];
  const boats: { x: number; z: number; yaw: number; phase: number }[] = [];
  const deckY = seaLevel + 0.45;
  const spineX = -98;
  for (let z = 176; z <= 266; z += 2) {
    if (!wet(spineX, z) || !wet(spineX, z + 2)) continue;
    pontoonParts.push(part(new THREE.BoxGeometry(2.4, 0.35, 2.05), 0xd8cfbd, at(spineX, deckY, z + 1)));
    if ((z - 176) % 12 === 0) {
      for (const side of [-1, 1]) {
        const fx = spineX + side * 4.6;
        if (!wet(fx, z) || !wet(spineX + side * 9, z)) continue;
        pontoonParts.push(part(new THREE.BoxGeometry(7, 0.3, 1.1), 0xd8cfbd, at(spineX + side * 4.7, deckY, z)));
        pontoonParts.push(part(new THREE.CylinderGeometry(0.16, 0.16, 3, 5), 0x6e5a44, at(spineX + side * 8, deckY - 0.6, z)));
        if (boats.length < 12 && (z / 12 + side) % 3 !== 0) boats.push({ x: spineX + side * 5.2, z: z + 2.6, yaw: side * Math.PI / 2, phase: boats.length * 1.7 });
      }
    }
  }
  const offshore: [number, number][] = [
    [-168, 196],
    [-178, 232],
    [-162, 262],
    [-74, 30],
    [-96, 50],
  ];
  for (const [x, z] of offshore) if (wet(x, z)) boats.push({ x, z, yaw: 0.6 + boats.length, phase: boats.length * 2.3 });
  if (pontoonParts.length) {
    const pontoons = new THREE.Mesh(merge(pontoonParts), toonVertexMaterial());
    pontoons.name = 'pontoons';
    pontoons.receiveShadow = true;
    group.add(pontoons);
  }
  const boatMesh = new THREE.InstancedMesh(boatGeometry(), toonVertexMaterial(), Math.max(1, boats.length));
  boatMesh.name = 'boats';
  boatMesh.count = boats.length;
  boats.forEach((b, i) => boatMesh.setColorAt(i, tmpC.setScalar(0.9 + ((i * 37) % 10) / 100)));
  if (boatMesh.instanceColor) boatMesh.instanceColor.needsUpdate = true;
  const boatEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  const placeBoats = (time: number) => {
    boats.forEach((b, i) => {
      boatEuler.set(Math.sin(time * 0.9 + b.phase) * 0.03, b.yaw, Math.sin(time * 1.1 + b.phase * 1.3) * 0.05);
      tmpQ.setFromEuler(boatEuler);
      tmpM.compose(tmpP.set(b.x, seaLevel - 0.25 + Math.sin(time * 1.3 + b.phase) * 0.07, b.z), tmpQ, tmpS.setScalar(1));
      boatMesh.setMatrixAt(i, tmpM);
    });
    boatMesh.instanceMatrix.needsUpdate = true;
  };
  placeBoats(0);
  boatMesh.computeBoundingSphere();
  boatMesh.castShadow = true;
  group.add(boatMesh);

  // Channel beacon off the harbour head: a red/white banded tower on a rock
  // base with a lantern that flashes.
  const beaconPos = new THREE.Vector3(-166, 0, 318);
  const beaconParts: THREE.BufferGeometry[] = [];
  beaconParts.push(part(new THREE.CylinderGeometry(2.4, 3.2, 2.2, 8), 0x4a4858, at(beaconPos.x, seaLevel + 0.4, beaconPos.z)));
  for (let k = 0; k < 5; k++) {
    beaconParts.push(part(new THREE.CylinderGeometry(0.75 - k * 0.06, 0.8 - k * 0.06, 1.5, 10), k % 2 ? 0xffffff : 0xe8413a, at(beaconPos.x, seaLevel + 2.2 + k * 1.5, beaconPos.z)));
  }
  beaconParts.push(part(new THREE.CylinderGeometry(1.2, 1.2, 0.2, 10), 0x2e2c38, at(beaconPos.x, seaLevel + 9.4, beaconPos.z)));
  beaconParts.push(part(new THREE.ConeGeometry(0.8, 0.8, 10), 0xe8413a, at(beaconPos.x, seaLevel + 11.1, beaconPos.z)));
  const beacon = new THREE.Mesh(merge(beaconParts), toonVertexMaterial());
  beacon.name = 'channel-beacon';
  beacon.castShadow = true;
  const lantern = new THREE.Mesh(new THREE.SphereGeometry(0.5, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffd23f }));
  lantern.name = 'beacon-lantern';
  lantern.position.set(beaconPos.x, seaLevel + 10.2, beaconPos.z);
  group.add(beacon, lantern);

  // --- the beach: umbrellas, a lifeguard tower, surf flags -------------------------
  const beachParts: THREE.BufferGeometry[] = [];
  const beachRng = makeRandom(0xbeac4);
  const canopyColors = [0xff5a4e, 0xffd23f, 0x3d7bff, 0xffffff, 0x1fa7b8];
  let umbrellas = 0;
  for (let k = 0; k < 300 && umbrellas < 18; k++) {
    const x = -40 + beachRng() * 26;
    const z = -110 + beachRng() * 180;
    const d = ctx.coastDistance(x, z);
    if (d < -24 || d > -4 || trackDist(x, z) < GRASS_HALF + 2.5 || !dry(x, z, 0.3)) continue;
    const y = groundAt(x, z);
    const tilt = (beachRng() - 0.5) * 0.25;
    const color = canopyColors[umbrellas % canopyColors.length];
    beachParts.push(part(new THREE.CylinderGeometry(0.05, 0.05, 2.4, 5), 0xf2efe8, at(x, y + 1.2, z, tilt, 0, tilt)));
    beachParts.push(part(new THREE.ConeGeometry(1.5, 0.55, 8), color, at(x, y + 2.35, z, tilt, beachRng(), tilt)));
    beachParts.push(part(new THREE.PlaneGeometry(0.9, 1.9), canopyColors[(umbrellas + 2) % canopyColors.length], at(x + 1.3, y + 0.05, z + 0.4, -Math.PI / 2, 0, beachRng())));
    umbrellas++;
  }
  // Lifeguard tower (stilts, hut, red/yellow flag) and a pair of surf flags.
  const tower = { x: -22, z: 34 };
  if (dry(tower.x, tower.z, 0.2)) {
    const y = groundAt(tower.x, tower.z);
    for (const [dx, dz] of [
      [-0.9, -0.9],
      [0.9, -0.9],
      [-0.9, 0.9],
      [0.9, 0.9],
    ]) {
      beachParts.push(part(new THREE.BoxGeometry(0.16, 3, 0.16), 0xf2efe8, at(tower.x + dx, y + 1.5, tower.z + dz)));
    }
    beachParts.push(part(new THREE.BoxGeometry(2.4, 0.2, 2.4), 0xc49a64, at(tower.x, y + 3, tower.z)));
    beachParts.push(part(new THREE.BoxGeometry(2.1, 1.5, 2.1), 0xffd23f, at(tower.x, y + 3.85, tower.z)));
    beachParts.push(part(new THREE.ConeGeometry(1.8, 0.8, 4), 0xff5a4e, at(tower.x, y + 5, tower.z, 0, Math.PI / 4)));
    beachParts.push(part(new THREE.CylinderGeometry(0.04, 0.04, 2.2, 4), 0xf2efe8, at(tower.x, y + 6.4, tower.z)));
    beachParts.push(part(new THREE.PlaneGeometry(0.9, 0.3), 0xff5a4e, at(tower.x + 0.45, y + 7.25, tower.z)));
    beachParts.push(part(new THREE.PlaneGeometry(0.9, 0.3), 0xffd23f, at(tower.x + 0.45, y + 6.95, tower.z)));
  }
  for (const fz of [8, 60]) {
    const fx = -30;
    if (!dry(fx, fz, 0.1)) continue;
    const y = groundAt(fx, fz);
    beachParts.push(part(new THREE.CylinderGeometry(0.04, 0.04, 2.6, 4), 0xf2efe8, at(fx, y + 1.3, fz)));
    beachParts.push(part(new THREE.PlaneGeometry(0.8, 0.28), 0xff5a4e, at(fx + 0.4, y + 2.45, fz)));
    beachParts.push(part(new THREE.PlaneGeometry(0.8, 0.28), 0xffd23f, at(fx + 0.4, y + 2.17, fz)));
  }
  if (beachParts.length) {
    const beach = new THREE.Mesh(merge(beachParts), toonVertexMaterial({ side: THREE.DoubleSide }));
    beach.name = 'beach-props';
    beach.castShadow = true;
    group.add(beach);
  }

  // --- offshore islands: Keppel-style silhouettes, hazed by the fog ----------------
  const islandParts: THREE.BufferGeometry[] = [];
  const islands: [number, number, number, number][] = [
    // x, z, radius, height
    [-470, -210, 90, 34],
    [-610, 60, 120, 52],
    [-520, 330, 70, 26],
    [-760, -60, 60, 22],
    [-430, 560, 100, 40],
  ];
  const islandRng = makeRandom(0x15a7d);
  for (const [x, z, r, h] of islands) {
    const g = new THREE.IcosahedronGeometry(1, 2); // already non-indexed
    const pos = g.getAttribute('position');
    const colors = new Float32Array(pos.count * 3);
    const rock = new THREE.Color(0x4d4c5c);
    const bush = new THREE.Color(0x4f7d3a);
    const sand = new THREE.Color(0xe9cf9c);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const vx = pos.getX(i);
      const vy = pos.getY(i);
      const vz = pos.getZ(i);
      const n = 1 + 0.18 * Math.sin(vx * 4.1 + islandRng() * 0.01) * Math.cos(vz * 3.3);
      pos.setXYZ(i, vx * r * n, Math.max(vy, -0.1) * h * n, vz * r * n);
      c.copy(vy < 0.08 ? sand : vy < 0.35 ? rock : bush);
      colors.set([c.r, c.g, c.b], i * 3);
    }
    g.deleteAttribute('uv');
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    g.translate(x, seaLevel - 1, z);
    g.computeVertexNormals();
    islandParts.push(g);
  }
  const islandMesh = new THREE.Mesh(merge(islandParts), toonVertexMaterial());
  islandMesh.name = 'islands';
  group.add(islandMesh);

  // --- rail crossing + cane train -----------------------------------------------------
  if (rail && jump) {
    const railParts: THREE.BufferGeometry[] = [];
    const heightAt = (lat: number) => {
      const x = rail!.origin.x + rail!.dir.x * lat;
      const z = rail!.origin.z + rail!.dir.z * lat;
      // Inside the corridor the rail runs along the cutting's floor (the
      // track's own gap profile); outside it, on the terrain.
      return Math.abs(lat) < GRASS_HALF ? query.groundHeightAt(new THREE.Vector3(x, 0, z)) : groundAt(x, z);
    };
    const yaw = Math.atan2(rail.dir.x, rail.dir.z);
    const span = 120;
    const step = 2.4;
    for (let lat = -span; lat < span; lat += step) {
      const a = rail.origin.clone().addScaledVector(rail.dir, lat);
      const b = rail.origin.clone().addScaledVector(rail.dir, lat + step);
      a.y = heightAt(lat) + 0.05;
      b.y = heightAt(lat + step) + 0.05;
      const mid = a.clone().add(b).multiplyScalar(0.5);
      const pitch = Math.atan2(b.y - a.y, step);
      // Ballast bed, two sleepers, two rails per step.
      railParts.push(part(new THREE.BoxGeometry(2.6, 0.18, step), 0x8f7d68, at(mid.x, mid.y, mid.z, -pitch, yaw)));
      for (const f of [0.25, 0.75]) {
        const p = a.clone().lerp(b, f);
        railParts.push(part(new THREE.BoxGeometry(1.9, 0.14, 0.32), 0x6a4a30, at(p.x, p.y + 0.12, p.z, -pitch, yaw)));
      }
      for (const g of [-0.55, 0.55]) {
        const off = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw)).multiplyScalar(g);
        railParts.push(part(new THREE.BoxGeometry(0.1, 0.14, step), 0x9aa0a8, at(mid.x + off.x, mid.y + 0.26, mid.z + off.z, -pitch, yaw)));
      }
    }
    const railMesh = new THREE.Mesh(merge(railParts), toonVertexMaterial());
    railMesh.name = 'cane-railway';
    railMesh.receiveShadow = true;
    group.add(railMesh);

    // The cane train, parked on the line beside the cane: a little yellow loco
    // hauling three wire-cage cane bins heaped with cut cane.
    const trainParts: THREE.BufferGeometry[] = [];
    const unit = (lat: number, build: (m: THREE.Matrix4) => void) => {
      const p = rail!.origin.clone().addScaledVector(rail!.dir, lat);
      p.y = heightAt(lat) + 0.35;
      build(at(p.x, p.y, p.z, 0, yaw));
    };
    const add = (m: THREE.Matrix4, g: THREE.BufferGeometry, color: number, local: THREE.Matrix4) => trainParts.push(part(g, color, m.clone().multiply(local)));
    unit(-34, (m) => {
      add(m, new THREE.BoxGeometry(1.7, 0.4, 4.2), 0x2e2c38, at(0, 0.3, 0));
      add(m, new THREE.BoxGeometry(1.5, 1.1, 2.4), 0xffd23f, at(0, 1.05, 0.8));
      add(m, new THREE.BoxGeometry(1.7, 1.5, 1.5), 0xffd23f, at(0, 1.25, -1.2));
      add(m, new THREE.BoxGeometry(1.9, 0.15, 1.8), 0xe8413a, at(0, 2.08, -1.2));
      add(m, new THREE.BoxGeometry(1.72, 0.45, 1.2), 0x2d4e6e, at(0, 1.55, -1.2));
      add(m, new THREE.CylinderGeometry(0.14, 0.18, 0.7, 6), 0x2e2c38, at(0, 1.9, 1.6));
      for (const wz of [-1.3, 1.3]) for (const wx of [-0.62, 0.62]) add(m, new THREE.CylinderGeometry(0.34, 0.34, 0.16, 10), 0x1f1d24, at(wx, 0.05, wz, 0, 0, Math.PI / 2));
    });
    for (let k = 0; k < 3; k++) {
      unit(-40 - k * 4.8, (m) => {
        add(m, new THREE.BoxGeometry(1.6, 0.25, 4.1), 0x2e2c38, at(0, 0.25, 0));
        for (const cx of [-0.78, 0.78]) for (const cz of [-1.95, 0, 1.95]) add(m, new THREE.BoxGeometry(0.08, 1.5, 0.08), 0x9aa0a8, at(cx, 1.1, cz));
        for (const cy of [0.6, 1.8]) for (const cx of [-0.78, 0.78]) add(m, new THREE.BoxGeometry(0.06, 0.06, 4), 0x9aa0a8, at(cx, cy, 0));
        add(m, new THREE.BoxGeometry(1.5, 1.2, 3.9), 0x8fa24a, at(0, 1.05, 0));
        add(m, new THREE.BoxGeometry(1.4, 0.35, 3.7), 0x9c7a4a, at(0, 1.8, 0));
        for (const wz of [-1.3, 1.3]) for (const wx of [-0.62, 0.62]) add(m, new THREE.CylinderGeometry(0.3, 0.3, 0.14, 10), 0x1f1d24, at(wx, 0.05, wz, 0, 0, Math.PI / 2));
      });
    }
    const train = new THREE.Mesh(merge(trainParts), toonVertexMaterial());
    train.name = 'cane-train';
    train.castShadow = true;
    train.receiveShadow = true;
    group.add(train);
  }

  return {
    group,
    update: (time: number) => {
      placeBoats(time);
      // Two short flashes every 4 seconds.
      const phase = time % 4;
      lantern.visible = phase < 0.25 || (phase > 0.55 && phase < 0.8);
    },
  };
}
