import * as THREE from 'three';
import { CONTROL_POINTS, ROAD_HALF, GRASS_HALF, CHECKPOINT_COUNT } from './trackData';

export interface TrackSample {
  pos: THREE.Vector3;
  forward: THREE.Vector3;
  right: THREE.Vector3;
  s: number;
}

export interface TrackData {
  samples: TrackSample[];
  totalLength: number;
  checkpoints: number[];
  group: THREE.Group;
}

const SAMPLE_COUNT = 400;
const RAW_SAMPLE_COUNT = 2000;
const STRIPE_WIDTH = 0.4;
const WALL_HEIGHT = 1.2;

const UP = new THREE.Vector3(0, 1, 0);

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
    samples.push({ pos: raw[idx].clone(), s: targetS, forward: new THREE.Vector3(), right: new THREE.Vector3() });
  }

  // forward/right computed from neighbor samples once all positions are known.
  // NOTE: our kart heading convention is forward = (sin(h), 0, cos(h)) (see
  // physics/Kart.ts kartForward), for which "driver's right" is up x forward
  // (not forward x up as it would be for a forward = (0,0,-1)-at-rest convention).
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    const prev = samples[(i - 1 + SAMPLE_COUNT) % SAMPLE_COUNT].pos;
    const next = samples[(i + 1) % SAMPLE_COUNT].pos;
    const forward = next.clone().sub(prev).normalize();
    samples[i].forward = forward;
    samples[i].right = UP.clone().cross(forward).normalize();
  }

  return { samples, totalLength };
}

function buildRoadMesh(samples: TrackSample[]): THREE.Mesh {
  const n = samples.length;
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  const stripeColor = new THREE.Color(0xf2f2f2);
  const lightGray = new THREE.Color(0x707070);
  const darkGray = new THREE.Color(0x5c5c5c);

  // 4 cross-section vertices per sample: edgeL, stripeL, stripeR, edgeR.
  for (let i = 0; i < n; i++) {
    const { pos, right } = samples[i];
    const roadColor = Math.floor(i / 4) % 2 === 0 ? lightGray : darkGray;

    const edgeL = pos.clone().addScaledVector(right, -ROAD_HALF);
    const stripeL = pos.clone().addScaledVector(right, -(ROAD_HALF - STRIPE_WIDTH));
    const stripeR = pos.clone().addScaledVector(right, ROAD_HALF - STRIPE_WIDTH);
    const edgeR = pos.clone().addScaledVector(right, ROAD_HALF);

    for (const v of [edgeL, stripeL, stripeR, edgeR]) {
      positions.push(v.x, v.y + 0.001, v.z);
    }
    colors.push(
      stripeColor.r, stripeColor.g, stripeColor.b,
      roadColor.r, roadColor.g, roadColor.b,
      roadColor.r, roadColor.g, roadColor.b,
      stripeColor.r, stripeColor.g, stripeColor.b,
    );
  }

  for (let i = 0; i < n; i++) {
    const a = i * 4;
    const b = ((i + 1) % n) * 4;
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
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  return new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ vertexColors: true }));
}

function buildGrassMesh(samples: TrackSample[]): THREE.Mesh {
  const n = samples.length;
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  const baseGreen = new THREE.Color(0x5cb85c);

  // Two ribbons (left ROAD_HALF..GRASS_HALF, right ROAD_HALF..GRASS_HALF), 2 verts each per sample.
  for (let i = 0; i < n; i++) {
    const { pos, right } = samples[i];
    const jitter = () => 0.9 + Math.random() * 0.2;

    const innerL = pos.clone().addScaledVector(right, -ROAD_HALF);
    const outerL = pos.clone().addScaledVector(right, -GRASS_HALF);
    const innerR = pos.clone().addScaledVector(right, ROAD_HALF);
    const outerR = pos.clone().addScaledVector(right, GRASS_HALF);

    for (const v of [outerL, innerL, innerR, outerR]) {
      positions.push(v.x, v.y, v.z);
    }
    for (let k = 0; k < 4; k++) {
      const j = jitter();
      colors.push(baseGreen.r * j, baseGreen.g * j, baseGreen.b * j);
    }
  }

  for (let i = 0; i < n; i++) {
    const a = i * 4;
    const b = ((i + 1) % n) * 4;
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
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  return new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ vertexColors: true }));
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

  const leftPillar = new THREE.Mesh(pillarGeo, pillarMat);
  leftPillar.position.copy(pos).addScaledVector(right, -ROAD_HALF - 0.3);
  leftPillar.position.y = 2.5;
  group.add(leftPillar);

  const rightPillar = new THREE.Mesh(pillarGeo, pillarMat);
  rightPillar.position.copy(pos).addScaledVector(right, ROAD_HALF + 0.3);
  rightPillar.position.y = 2.5;
  group.add(rightPillar);

  const beam = new THREE.Mesh(beamGeo, beamMat);
  beam.position.copy(pos);
  beam.position.y = 5;
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

  // Trees: trunk + cone top, alternating sides, every ~23m.
  const treeIndices: number[] = [];
  for (let i = 0; i < n; i += 15) if (!isNearStart(i)) treeIndices.push(i);

  const trunkGeo = new THREE.CylinderGeometry(0.15, 0.2, 1.2, 6);
  const trunkMat = new THREE.MeshLambertMaterial({ color: 0x6b4423 });
  const trunkMesh = new THREE.InstancedMesh(trunkGeo, trunkMat, treeIndices.length);

  const topGeo = new THREE.ConeGeometry(0.9, 2.2, 7);
  const topMat = new THREE.MeshLambertMaterial({ color: 0x2f8f3f });
  const topMesh = new THREE.InstancedMesh(topGeo, topMat, treeIndices.length);

  const m = new THREE.Matrix4();
  treeIndices.forEach((idx, i) => {
    const side = i % 2 === 0 ? 1 : -1;
    const sample = samples[idx];
    const offset = GRASS_HALF + 3 + (i % 3);
    const pos = sample.pos.clone().addScaledVector(sample.right, side * offset);
    m.makeTranslation(pos.x, 0.6, pos.z);
    trunkMesh.setMatrixAt(i, m);
    m.makeTranslation(pos.x, 1.2 + 1.1, pos.z);
    topMesh.setMatrixAt(i, m);
  });
  trunkMesh.instanceMatrix.needsUpdate = true;
  topMesh.instanceMatrix.needsUpdate = true;
  group.add(trunkMesh, topMesh);

  // Cones: single-piece, closer to the road, every ~15.5m.
  const coneIndices: number[] = [];
  for (let i = 0; i < n; i += 10) if (!isNearStart(i)) coneIndices.push(i);

  const coneGeo = new THREE.ConeGeometry(0.4, 1.0, 8);
  const coneMat = new THREE.MeshLambertMaterial({ color: 0xff7f11 });
  const coneMesh = new THREE.InstancedMesh(coneGeo, coneMat, coneIndices.length);
  coneIndices.forEach((idx, i) => {
    const side = i % 2 === 0 ? -1 : 1;
    const sample = samples[idx];
    const pos = sample.pos.clone().addScaledVector(sample.right, side * (ROAD_HALF + 1.5));
    m.makeTranslation(pos.x, 0.5, pos.z);
    coneMesh.setMatrixAt(i, m);
  });
  coneMesh.instanceMatrix.needsUpdate = true;
  group.add(coneMesh);

  // Floating ring gates: centered on the road, spanning it like a hoop, every ~78m.
  const ringIndices: number[] = [];
  for (let i = 0; i < n; i += 50) ringIndices.push(i);

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

export function buildTrack(): TrackData {
  const { samples, totalLength } = buildSamples();

  const checkpoints: number[] = [];
  for (let i = 0; i < CHECKPOINT_COUNT; i++) {
    checkpoints.push(Math.round((i * SAMPLE_COUNT) / CHECKPOINT_COUNT) % SAMPLE_COUNT);
  }

  const group = new THREE.Group();
  group.add(buildRoadMesh(samples));
  group.add(buildGrassMesh(samples));
  group.add(buildWallMeshes(samples));
  group.add(buildStartFinish(samples[checkpoints[0]]));
  group.add(buildTracksideProps(samples));

  return { samples, totalLength, checkpoints, group };
}
