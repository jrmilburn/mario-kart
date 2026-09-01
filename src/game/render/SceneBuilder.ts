import * as THREE from 'three';
import { clamp, damp } from '../../shared/mathUtils';
import { TUNING } from '../tuning';
import type { KartState } from '../physics/Kart';
import type { CharacterDef, CharacterFallbackColors } from '../characters/registry';

export interface KartVisual {
  group: THREE.Group; // body+wheels+driverAnchor; position/rotation driven by physics
  body: THREE.Mesh; // gets the drift-lean roll
  frontWheelPivots: THREE.Group[]; // steer-yawed independently of body lean
  leanAngle: number; // smoothed drift-lean state, mutated by updateKartVisual
  pitchAngle: number; // §Phase 5 item 5: smoothed slope-pitch state, mutated by updateKartVisual
  // §Phase 3: seat anchor for the driver (GLTF model or procedural fallback).
  // Parented under `body` (not `group`) so it inherits the existing drift-lean
  // roll (visual.body.rotation.z, set in updateKartVisual) for free — the
  // driver leans into drifts along with the kart body with no extra per-frame code.
  driverAnchor: THREE.Group;
}

// §Phase 4 item 2: the ground plane moved to render/Environment.ts
// (buildEnvironment), textured to match the grass ribbon instead of a flat color.

export interface Lights {
  directional: THREE.DirectionalLight;
  shadowHalfSize: number; // current ortho shadow-camera half-extent, tracked so updateShadowBounds can skip sub-1m no-op updates (§Phase 4 finding #3)
}

// §Phase 4 item 3: fixed offset from whatever point the directional light's
// shadow target is currently following (see updateLightTarget) — kept
// constant every frame so the light always views the target from the same
// angle, just from a re-centered position.
export const SHADOW_LIGHT_OFFSET = new THREE.Vector3(40, 70, 30);
const SHADOW_HALF_SIZE = 40; // ~80x80m ortho shadow camera, the solo/default extent (§Phase 4 item 3)
const SHADOW_HALF_SIZE_MAX = 90; // widest the ortho box is allowed to grow to cover a spread-out split-screen pair (§Phase 4 finding #3)

export function buildLights(scene: THREE.Scene): Lights {
  scene.add(new THREE.HemisphereLight(0xbfe3ff, 0x4a6b3a, 1.2));
  const dir = new THREE.DirectionalLight(0xfff3d6, 0.9);
  dir.castShadow = true;
  dir.shadow.mapSize.set(TUNING.shadowMapSize, TUNING.shadowMapSize);
  dir.shadow.camera.left = -SHADOW_HALF_SIZE;
  dir.shadow.camera.right = SHADOW_HALF_SIZE;
  dir.shadow.camera.top = SHADOW_HALF_SIZE;
  dir.shadow.camera.bottom = -SHADOW_HALF_SIZE;
  dir.shadow.camera.near = 10;
  dir.shadow.camera.far = 180;
  dir.shadow.bias = -0.0015; // avoids shadow acne on the flat road/ground planes
  dir.position.copy(SHADOW_LIGHT_OFFSET);
  scene.add(dir);
  scene.add(dir.target);
  return { directional: dir, shadowHalfSize: SHADOW_HALF_SIZE };
}

// Re-centers the shadow camera on `target` (world-space) each frame, keeping
// the light's relative offset fixed — called from main.ts's render callback
// with the active players' midpoint (§Phase 4 item 3). `dir.target` must
// already be added to the scene (buildLights does this) for its matrixWorld
// to update during render.
export function updateLightTarget(dir: THREE.DirectionalLight, target: THREE.Vector3) {
  dir.target.position.copy(target);
  dir.position.copy(target).add(SHADOW_LIGHT_OFFSET);
}

// §Phase 4 finding #3: the fixed ~80x80m ortho box was sized for one kart and
// can miss one or both split-screen players when they're spread out. Grows
// the box with player separation (half tracks playerDistance/2 + a 15m
// margin), clamped to [SHADOW_HALF_SIZE, SHADOW_HALF_SIZE_MAX]. Touches the
// shadow camera (and its relatively expensive updateProjectionMatrix) only
// when the desired size actually differs from the current one by more than
// 1m, so steady-state split-screen racing doesn't re-upload the projection
// every frame over sub-meter jitter. `playerDistance` should be 0 outside
// split-screen, which settles back to the SHADOW_HALF_SIZE default.
export function updateShadowBounds(lights: Lights, playerDistance: number) {
  const desired = clamp(Math.max(SHADOW_HALF_SIZE, playerDistance / 2 + 15), SHADOW_HALF_SIZE, SHADOW_HALF_SIZE_MAX);
  if (Math.abs(desired - lights.shadowHalfSize) <= 1) return;
  lights.shadowHalfSize = desired;
  const cam = lights.directional.shadow.camera;
  cam.left = -desired;
  cam.right = desired;
  cam.top = desired;
  cam.bottom = -desired;
  cam.updateProjectionMatrix();
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
  body.castShadow = true;
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
    wheel.castShadow = true;
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

  // §Phase 4 item 3: no more flat blob shadow mesh — real shadow maps replace
  // it (buildLights/updateLightTarget), and karts cast a real shadow via
  // body.castShadow/wheel castShadow above and the driver traversal in setDriver.
  const visual: KartVisual = { group, body, frontWheelPivots, leanAngle: 0, pitchAngle: 0, driverAnchor };
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

  // §Phase 4 item 3: drivers cast shadows too, whichever branch mounted them —
  // set here (rather than once in buildKart) since setDriver re-mounts on
  // every character reselect and every async GLTF-model swap-in.
  anchor.traverse((obj) => {
    if (obj instanceof THREE.Mesh) obj.castShadow = true;
  });
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
const PITCH_BLEND_RATE = 8; // §Phase 5 item 5: smooth the slope-pitch visual over ~0.125s
const FRONT_WHEEL_YAW_SCALE = 0.4;

// Sets kart visuals from physics state each render frame (§3.2 closing paragraph):
// body yaw = heading + drift lean, blended in/out over 0.15s; front wheels
// yawed by steerActual x 0.4, independent of the body lean. `grade` (§Phase 5
// item 5, forward.y of the sample nearest the kart -- caller reuses whatever
// nearestSample query it already made this tick, not a second one) pitches
// the whole group nose-up/down to match the local slope, smoothed like the
// drift lean so pitch changes don't pop across sample boundaries.
export function updateKartVisual(visual: KartVisual, kart: KartState, dt: number, grade = 0) {
  visual.group.position.copy(kart.pos);
  visual.group.rotation.y = kart.heading;

  const targetLean = kart.drift.phase === 'active' ? kart.drift.dir * 0.25 : 0;
  visual.leanAngle = damp(visual.leanAngle, targetLean, LEAN_BLEND_RATE, dt);
  visual.body.rotation.z = visual.leanAngle;

  const targetPitch = -Math.asin(clamp(grade, -1, 1));
  visual.pitchAngle = damp(visual.pitchAngle, targetPitch, PITCH_BLEND_RATE, dt);
  visual.group.rotation.x = visual.pitchAngle;

  for (const pivot of visual.frontWheelPivots) {
    pivot.rotation.y = kart.steerActual * FRONT_WHEEL_YAW_SCALE;
  }
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
