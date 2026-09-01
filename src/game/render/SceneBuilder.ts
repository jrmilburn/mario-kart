import * as THREE from 'three';
import { damp } from '../../shared/mathUtils';
import type { KartState } from '../physics/Kart';
import type { CharacterDef, CharacterFallbackColors } from '../characters/registry';

export interface KartVisual {
  group: THREE.Group; // body+wheels+driverAnchor; position/rotation driven by physics
  body: THREE.Mesh; // gets the drift-lean roll
  frontWheelPivots: THREE.Group[]; // steer-yawed independently of body lean
  shadow: THREE.Mesh; // flat blob shadow; position-only follow, never rotates
  leanAngle: number; // smoothed drift-lean state, mutated by updateKartVisual
  // §Phase 3: seat anchor for the driver (GLTF model or procedural fallback).
  // Parented under `body` (not `group`) so it inherits the existing drift-lean
  // roll (visual.body.rotation.z, set in updateKartVisual) for free — the
  // driver leans into drifts along with the kart body with no extra per-frame code.
  driverAnchor: THREE.Group;
}

// §Phase 4 item 2: the ground plane moved to render/Environment.ts
// (buildEnvironment), textured to match the grass ribbon instead of a flat color.

export function buildLights(scene: THREE.Scene) {
  scene.add(new THREE.HemisphereLight(0xbfe3ff, 0x4a6b3a, 1.2));
  const dir = new THREE.DirectionalLight(0xfff3d6, 0.9);
  dir.position.set(5, 10, 5);
  scene.add(dir);
}

// Kart's local "nose" points toward +Z (matches physics/Kart.ts kartForward()).
// §Phase 3: takes a CharacterDef instead of a bare color — the kart body is
// tinted from `def.kartColor` and the seat starts populated with `def`'s
// procedural fallback driver (setDriver swaps in the real GLTF model later,
// once/if it loads).
export function buildKart(def: CharacterDef): KartVisual {
  const group = new THREE.Group();

  const body = new THREE.Mesh(
    new THREE.BoxGeometry(1.2, 0.5, 2.2),
    new THREE.MeshLambertMaterial({ color: def.kartColor }),
  );
  body.position.y = 0.5;
  group.add(body);

  // Seat anchor: ~(0, 0.75, -0.3) in kart-floor space, expressed here relative
  // to `body`'s own origin (which already sits at y=0.5) since driverAnchor is
  // parented under `body` (see KartVisual.driverAnchor).
  const driverAnchor = new THREE.Group();
  driverAnchor.position.set(0, 0.25, -0.3);
  body.add(driverAnchor);

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

  const visual: KartVisual = { group, body, frontWheelPivots, shadow, leanAngle: 0, driverAnchor };
  setDriver(visual, def, null); // seed the fallback immediately; caller swaps in the real model once loaded
  return visual;
}

// §Phase 3: sets (or clears) the driver mounted on `visual.driverAnchor` — the
// scaled/offset/rotated GLTF scene when `model` is provided, otherwise an
// improved procedural fallback built from `def.fallbackColors`. Safe to call
// repeatedly (e.g. on character re-select, or when a model finishes loading
// after the fallback was already showing): always clears whatever was mounted first.
export function setDriver(visual: KartVisual, def: CharacterDef, model: THREE.Object3D | null) {
  const anchor = visual.driverAnchor;
  while (anchor.children.length > 0) {
    const child = anchor.children[0];
    anchor.remove(child);
    // Only dispose procedural-fallback meshes (tagged below): GLTF-sourced
    // children share geometry/material with the cached original via
    // clone(true), so disposing those would corrupt every other kart using
    // the same cached model.
    if (child.userData.disposable) {
      child.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
          else obj.material.dispose();
        }
      });
    }
  }

  if (model) {
    model.scale.setScalar(def.scale);
    model.position.set(0, def.yOffset, 0);
    model.rotation.y = def.rotationY;
    anchor.add(model);
  } else {
    anchor.add(buildFallbackDriver(def.fallbackColors));
  }
}

// Sets just the kart body's tint — used when a player swaps characters so the
// kart color updates immediately without rebuilding the whole KartVisual.
export function setKartColor(visual: KartVisual, color: number) {
  (visual.body.material as THREE.MeshLambertMaterial).color.setHex(color);
}

// Head sphere + torso box + a simple domed cap, sized/positioned relative to
// the driverAnchor origin (the seat) — deliberately more distinct than the
// old lone floating head sphere so each character reads differently even
// with zero GLB files present (the default, shippable state).
function buildFallbackDriver(colors: CharacterFallbackColors): THREE.Group {
  const driver = new THREE.Group();
  // Tag so setDriver() knows it's safe (and necessary) to dispose these
  // meshes' geometry/material on removal — unlike GLTF-sourced children,
  // nothing else references them.
  driver.userData.disposable = true;

  const torso = new THREE.Mesh(
    new THREE.BoxGeometry(0.5, 0.5, 0.4),
    new THREE.MeshLambertMaterial({ color: colors.primary }),
  );
  torso.position.y = 0.25;
  driver.add(torso);

  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.28, 12, 10),
    new THREE.MeshLambertMaterial({ color: colors.skin }),
  );
  head.position.y = 0.68;
  driver.add(head);

  const cap = new THREE.Mesh(
    new THREE.SphereGeometry(0.3, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshLambertMaterial({ color: colors.secondary }),
  );
  cap.position.y = 0.74;
  driver.add(cap);

  return driver;
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
