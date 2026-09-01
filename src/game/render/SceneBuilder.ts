import * as THREE from 'three';
import { damp } from '../../shared/mathUtils';
import type { KartState } from '../physics/Kart';

export interface KartVisual {
  group: THREE.Group; // body+wheels+head; position/rotation driven by physics
  body: THREE.Mesh; // gets the drift-lean roll
  frontWheelPivots: THREE.Group[]; // steer-yawed independently of body lean
  shadow: THREE.Mesh; // flat blob shadow; position-only follow, never rotates
  leanAngle: number; // smoothed drift-lean state, mutated by updateKartVisual
}

// One large flat plane beneath everything (§3.1) for far-field coverage beyond
// the modeled grass ribbon around the track. Color matches the grass ribbon
// (TrackBuilder) for a seamless blend at the horizon.
export function buildGround(scene: THREE.Scene) {
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(1000, 1000),
    new THREE.MeshLambertMaterial({ color: 0x4a9c3f }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.05;
  scene.add(ground);
}

export function buildLights(scene: THREE.Scene) {
  scene.add(new THREE.HemisphereLight(0xbfe3ff, 0x4a6b3a, 1.2));
  const dir = new THREE.DirectionalLight(0xfff3d6, 0.9);
  dir.position.set(5, 10, 5);
  scene.add(dir);
}

// Kart's local "nose" points toward +Z (matches physics/Kart.ts kartForward()).
export function buildKart(bodyColor: number): KartVisual {
  const group = new THREE.Group();

  const body = new THREE.Mesh(
    new THREE.BoxGeometry(1.2, 0.5, 2.2),
    new THREE.MeshLambertMaterial({ color: bodyColor }),
  );
  body.position.y = 0.5;
  group.add(body);

  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.32, 12, 10),
    new THREE.MeshLambertMaterial({ color: 0xffe0bd }),
  );
  head.position.set(0, 0.95, -0.3);
  group.add(head);

  const wheelGeo = new THREE.CylinderGeometry(0.32, 0.32, 0.28, 12);
  const wheelMat = new THREE.MeshLambertMaterial({ color: 0x222222 });

  function makeWheelMesh(): THREE.Mesh {
    const wheel = new THREE.Mesh(wheelGeo, wheelMat);
    wheel.rotation.z = Math.PI / 2;
    return wheel;
  }

  // Front wheels (+Z, toward the nose) get a steer pivot so they can yaw
  // independently for the steering-angle visual; rear wheels are fixed.
  const frontWheelPivots: THREE.Group[] = [];
  for (const x of [0.65, -0.65]) {
    const pivot = new THREE.Group();
    pivot.position.set(x, 0.32, 0.75);
    pivot.add(makeWheelMesh());
    group.add(pivot);
    frontWheelPivots.push(pivot);
  }
  for (const x of [0.65, -0.65]) {
    const wheel = makeWheelMesh();
    wheel.position.set(x, 0.32, -0.75);
    group.add(wheel);
  }

  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(1.3, 16),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35 }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.02;

  return { group, body, frontWheelPivots, shadow, leanAngle: 0 };
}

const LEAN_BLEND_RATE = 1 / 0.15; // blend the drift lean in/out over ~0.15s
const FRONT_WHEEL_YAW_SCALE = 0.4;

// Sets kart visuals from physics state each render frame (§3.2 closing paragraph):
// body yaw = heading + drift lean, blended in/out over 0.15s; front wheels
// yawed by steerActual x 0.4, independent of the body lean.
export function updateKartVisual(visual: KartVisual, kart: KartState, dt: number) {
  visual.group.position.copy(kart.pos);
  visual.group.rotation.y = kart.heading;

  const targetLean = kart.drift.phase === 'active' ? kart.drift.dir * 0.25 : 0;
  visual.leanAngle = damp(visual.leanAngle, targetLean, LEAN_BLEND_RATE, dt);
  visual.body.rotation.z = visual.leanAngle;

  for (const pivot of visual.frontWheelPivots) {
    pivot.rotation.y = kart.steerActual * FRONT_WHEEL_YAW_SCALE;
  }

  visual.shadow.position.set(kart.pos.x, 0.02, kart.pos.z);
}

// §Phase 10 item visuals -----------------------------------------------------

// Rotating vertex-colored cube; caller toggles .visible with box.active.
export function buildItemBoxMesh(): THREE.Mesh {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const faceColors = [0xe74c3c, 0x3498db, 0xf1c40f, 0x2ecc71, 0xe67e22, 0x9b59b6];
  const colors: number[] = [];
  const c = new THREE.Color();
  for (let face = 0; face < 6; face++) {
    c.set(faceColors[face]);
    for (let v = 0; v < 4; v++) colors.push(c.r, c.g, c.b);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
  mesh.position.y = 0.6;
  return mesh;
}

export function buildBananaMesh(): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.3, 8, 6),
    new THREE.MeshLambertMaterial({ color: 0xf5d327 }),
  );
  mesh.scale.set(1.6, 0.55, 0.7);
  mesh.position.y = 0.2;
  return mesh;
}

export function buildShellMesh(): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.35, 10, 8),
    new THREE.MeshLambertMaterial({ color: 0x2ecc71 }),
  );
  mesh.position.y = 0.4;
  return mesh;
}
