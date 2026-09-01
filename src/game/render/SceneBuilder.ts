import * as THREE from 'three';
import { clamp, damp } from '../../shared/mathUtils';
import { TUNING } from '../tuning';
import type { KartState } from '../physics/Kart';
import type { CharacterDef } from '../characters/registry';
import { SPIN_OUT_SECONDS } from '../items/ItemSystem';
import { buildKartChassis, disposeChassis, type KartChassis } from './KartBuilder';
import { armPivotOf, buildCharacterModel } from './CharacterBuilder';

export interface KartVisual {
  group: THREE.Group; // body+wheels+driverAnchor; position/rotation driven by physics
  // §v3 Track B: was a single BoxGeometry Mesh, now the composed chassis Group
  // (KartBuilder emits ~6 merged meshes, one per colour). Still exactly the
  // node that takes the drift-lean roll and parents driverAnchor — that
  // contract is what makes the driver lean into drifts for free.
  body: THREE.Group;
  frontWheelPivots: THREE.Group[]; // steer-yawed independently of body lean
  leanAngle: number; // smoothed drift-lean state, mutated by updateKartVisual
  pitchAngle: number; // §Phase 5 item 5: smoothed slope-pitch state, mutated by updateKartVisual
  // §Phase 3: seat anchor for the driver (GLTF model or procedural fallback).
  // Parented under `body` (not `group`) so it inherits the existing drift-lean
  // roll (visual.body.rotation.z, set in updateKartVisual) for free — the
  // driver leans into drifts along with the kart body with no extra per-frame code.
  driverAnchor: THREE.Group;
  // §v3 Track B item 4: the chassis' steering wheel and the procedural
  // driver's arm-roll group, both turned by steerActual in updateKartVisual.
  // `armPivot` is null whenever a GLB driver is mounted (no such node in an
  // imported model) — the steering wheel belongs to the kart, so it survives.
  steeringWheel?: THREE.Object3D;
  armPivot: THREE.Object3D | null;
  // Every material carrying the kart colour. setKartColor walks this instead
  // of poking one mesh's material, and the instances are per-kart so tinting
  // one kart can never repaint another (§v3 Track B item 4).
  tintMaterials: THREE.MeshLambertMaterial[];
  // Kept so setKartCharacter can dispose the outgoing chassis when a player
  // re-picks: each character drives *their* kart, not just their colour.
  chassis: KartChassis;
  // §v3 Track C2: seconds left on the mushroom squash-and-stretch pop. Set by
  // triggerBoostPop when an item boost fires and decayed by updateKartVisual
  // in the render loop (never on the physics tick) — it drives `group.scale`,
  // which nothing else writes, so it composes with the existing lean (body
  // roll), pitch (group rotation.x) and steer visuals rather than fighting them.
  boostPopTimer: number;
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
  // §Phase 5 elevation review fix #1: default Euler order 'XYZ' couples
  // rotation.x (pitch) and rotation.y (heading) -- rotating y first (as XYZ
  // does, applied intrinsically z-then-y-then-x) tips the pitch axis itself,
  // so the nose-tilt sign flips as a function of heading. 'YXZ' applies yaw
  // first and then pitches about the yawed local X axis, which is exactly
  // what updateKartVisual wants: nose-tilt should equal `grade` regardless of
  // heading. Set once here rather than per-frame in updateKartVisual.
  group.rotation.order = 'YXZ';

  // Seat anchor: positioned by mountChassis from the chassis profile (each
  // kart kind seats its driver at a different height/setback) and parented
  // under `body` (see KartVisual.driverAnchor).
  const driverAnchor = new THREE.Group();
  const chassis = buildKartChassis(def);
  mountChassis(group, chassis, driverAnchor);

  // §Phase 4 item 3: no more flat blob shadow mesh — real shadow maps replace
  // it (buildLights/updateLightTarget); every chassis/wheel/driver mesh sets
  // castShadow at construction (PartAssembler) or in setDriver's traversal.
  const visual: KartVisual = {
    group,
    body: chassis.body,
    frontWheelPivots: chassis.frontWheelPivots,
    leanAngle: 0,
    pitchAngle: 0,
    driverAnchor,
    steeringWheel: chassis.steeringWheel,
    armPivot: null,
    tintMaterials: chassis.tintMaterials,
    chassis,
    boostPopTimer: 0,
  };
  setDriver(visual, def, null); // seed the procedural driver immediately; caller swaps in the real model once loaded
  return visual;
}

// Parents a freshly built chassis (body + wheels) under the kart root and
// hangs `driverAnchor` off the body at that chassis' seat position. Split out
// of buildKart because setKartCharacter re-runs it when a player re-picks.
function mountChassis(group: THREE.Group, chassis: KartChassis, driverAnchor: THREE.Group) {
  chassis.body.position.y = chassis.bodyPivotY;
  group.add(chassis.body);
  // Wheels hang off the ROOT, not the body: the drift lean must not tip them
  // off the ground (this matches the pre-Track-B layout).
  for (const pivot of chassis.frontWheelPivots) group.add(pivot);
  for (const wheel of chassis.rearWheels) group.add(wheel);
  driverAnchor.position.set(0, chassis.seatY - chassis.bodyPivotY, chassis.seatZ);
  chassis.body.add(driverAnchor);
}

// §v3 Track B: swaps the whole chassis for `def`'s kart kind (Bowser's wide
// twin-exhaust heavy, Peach's royal, Toad's mini...) and retints it. Called
// when a player picks a different character; the driver currently mounted on
// driverAnchor is carried across untouched (the caller re-mounts it right
// afterwards via setDriver, but detaching first means an in-flight GLB model
// is never caught by disposeChassis' traversal).
export function setKartCharacter(visual: KartVisual, def: CharacterDef) {
  const outgoing = visual.chassis;
  visual.driverAnchor.removeFromParent();
  outgoing.body.removeFromParent();
  for (const pivot of outgoing.frontWheelPivots) pivot.removeFromParent();
  for (const wheel of outgoing.rearWheels) wheel.removeFromParent();
  disposeChassis(outgoing);

  const chassis = buildKartChassis(def);
  mountChassis(visual.group, chassis, visual.driverAnchor);
  visual.chassis = chassis;
  visual.body = chassis.body;
  visual.frontWheelPivots = chassis.frontWheelPivots;
  visual.steeringWheel = chassis.steeringWheel;
  visual.tintMaterials = chassis.tintMaterials;
  // The new body starts level; the smoothed lean/pitch state carries over so
  // re-picking mid-drift doesn't pop.
  visual.body.rotation.z = visual.leanAngle;
}

// §Phase 3: sets (or clears) the driver mounted on `visual.driverAnchor` — the
// scaled/offset/rotated GLTF scene when `model` is provided, otherwise the
// procedural character built from `def.driver` (§v3 Track B). Safe to call
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
    // A GLB has no arm-roll node to drive, so the per-frame arm animation
    // simply switches off for it (the kart's steering wheel keeps turning).
    visual.armPivot = null;
  } else {
    const driver = buildCharacterModel(def);
    anchor.add(driver);
    visual.armPivot = armPivotOf(driver);
  }

  // §Phase 4 item 3: drivers cast shadows too, whichever branch mounted them —
  // set here (rather than once in buildKart) since setDriver re-mounts on
  // every character reselect and every async GLTF-model swap-in.
  anchor.traverse((obj) => {
    if (obj instanceof THREE.Mesh) obj.castShadow = true;
  });
}

// §v3 Track B item 4: retints the WHOLE chassis, not one body mesh — the kart
// is now ~6 merged meshes and several of them carry the kart colour. The
// materials in tintMaterials are per-kart instances (PartAssembler never
// shares one between karts), so tinting here can only ever repaint this kart.
// Used when a player swaps characters so the colour updates immediately
// without rebuilding the KartVisual (setKartCharacter does the full rebuild).
export function setKartColor(visual: KartVisual, color: number) {
  for (const mat of visual.tintMaterials) mat.color.setHex(color);
}

const LEAN_BLEND_RATE = 1 / 0.15; // blend the drift lean in/out over ~0.15s
const PITCH_BLEND_RATE = 8; // §Phase 5 item 5: smooth the slope-pitch visual over ~0.125s
const FRONT_WHEEL_YAW_SCALE = 0.4;
// §v3 Track B item 4: steering wheel turn per unit of steerActual. Negative
// because the wheel's +Z normal points away from the driver, so a positive
// rotation.z reads as clockwise *to them* while positive steer points the
// front wheels toward the kart's +X (its left).
const STEER_WHEEL_SCALE = -0.7;
const STEER_ARM_SCALE = -0.22; // the arms only need a hint of the same roll

// §v3 Track C2 spin-out visual. `stepKart` already yaws `kart.heading` at 10
// rad/s while spun out; this adds exactly SPIN_VISUAL_TURNS more revolutions
// *on top of it, visually only*, so getting shelled reads as a proper tumble
// at split-screen size instead of a slow pirouette.
//
// It is a closed form of the elapsed spin fraction rather than an accumulator
// on purpose. extra(u) = TURNS * 2PI * u * (2 - u) with u = elapsed/duration:
//  - extra(0) = 0                      -> nothing pops when the spin starts,
//  - d(extra)/dt is proportional to (1 - u), i.e. to the REMAINING spin time
//    (the spec's wording) -> it eases out instead of stopping dead,
//  - extra(1) = TURNS * 2PI, an exact whole number of turns -> the moment
//    spinTimer hits 0 and this term drops away, the kart is already facing
//    where the term left it, so there is no pop on the way out either.
// Storing an accumulator instead would end on an arbitrary angle and have to
// unwind visibly (i.e. spin the kart backwards) to get back to zero.
const SPIN_VISUAL_TURNS = 1;

// Mushroom pop (§v3 Track C2): a brief stretch along the kart's own +Z (its
// nose) with a matching squash in X/Y, easing back to 1 over BOOST_POP_SECONDS.
// Applied to `group.scale`, which is otherwise untouched.
const BOOST_POP_SECONDS = 0.28;
const BOOST_POP_STRETCH_Z = 0.26;
const BOOST_POP_SQUASH_X = 0.16;
const BOOST_POP_SQUASH_Y = 0.1;

// §v3 Track C2: called by main.ts the moment a mushroom is actually fired (not
// on every boost — a drift-release boost is already sold by the drift sparks,
// and popping the kart on every tier-1 release would be constant noise).
// Idempotent: re-firing mid-pop just restarts the timer.
export function triggerBoostPop(visual: KartVisual) {
  visual.boostPopTimer = BOOST_POP_SECONDS;
}

// Sets kart visuals from physics state each render frame (§3.2 closing paragraph):
// body yaw = heading + drift lean, blended in/out over 0.15s; front wheels
// yawed by steerActual x 0.4, independent of the body lean. `grade` (§Phase 5
// item 5, forward.y of the sample nearest the kart -- caller reuses whatever
// nearestSample query it already made this tick, not a second one) pitches
// the whole group nose-up/down to match the local slope, smoothed like the
// drift lean so pitch changes don't pop across sample boundaries.
export function updateKartVisual(visual: KartVisual, kart: KartState, dt: number, grade = 0) {
  visual.group.position.copy(kart.pos);

  // §v3 Track C2: the spin-out tumble is added here, to the *visual* yaw only —
  // kart.heading is read, never written, so physics is untouched (the kart
  // still travels exactly where stepKart's spin-out branch sends it).
  let yaw = kart.heading;
  if (kart.spinTimer > 0) {
    const u = clamp(1 - kart.spinTimer / SPIN_OUT_SECONDS, 0, 1); // 0 at the hit -> 1 as control returns
    yaw += SPIN_VISUAL_TURNS * Math.PI * 2 * u * (2 - u);
  }
  visual.group.rotation.y = yaw;

  // §v3 Track C2: mushroom squash-and-stretch. The timer reaches exactly 0 on
  // its last frame, which makes the scale exactly (1,1,1) again, so the guard
  // below can skip the write entirely from the next frame on.
  if (visual.boostPopTimer > 0) {
    visual.boostPopTimer = Math.max(0, visual.boostPopTimer - dt);
    const ease = (visual.boostPopTimer / BOOST_POP_SECONDS) ** 2;
    visual.group.scale.set(
      1 - BOOST_POP_SQUASH_X * ease,
      1 - BOOST_POP_SQUASH_Y * ease,
      1 + BOOST_POP_STRETCH_Z * ease,
    );
  }

  const targetLean = kart.drift.phase === 'active' ? kart.drift.dir * 0.25 : 0;
  visual.leanAngle = damp(visual.leanAngle, targetLean, LEAN_BLEND_RATE, dt);
  visual.body.rotation.z = visual.leanAngle;

  const targetPitch = -Math.asin(clamp(grade, -1, 1));
  visual.pitchAngle = damp(visual.pitchAngle, targetPitch, PITCH_BLEND_RATE, dt);
  visual.group.rotation.x = visual.pitchAngle;

  for (const pivot of visual.frontWheelPivots) {
    pivot.rotation.y = kart.steerActual * FRONT_WHEEL_YAW_SCALE;
  }

  // §v3 Track B item 4: the steering wheel (and, when a procedural driver is
  // mounted, their arms) follow the steering input. Two scalar writes, no
  // allocation, no traversal — updateKartVisual runs for all six karts every
  // frame and must stay allocation-free.
  if (visual.steeringWheel) visual.steeringWheel.rotation.z = kart.steerActual * STEER_WHEEL_SCALE;
  if (visual.armPivot) visual.armPivot.rotation.z = kart.steerActual * STEER_ARM_SCALE;
}

// §Phase 10 item visuals -----------------------------------------------------

// Rotating vertex-colored cube; caller toggles .visible with box.active.
// §v3 Track C2: the material is `transparent` now so the render loop can fade
// the cube out on pickup (scale-up + fade) and scale it back in on respawn.
// The ItemSystem state machine (box.active/respawnTimer) is unchanged — main.ts
// derives the animation purely from watching `active` flip.
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
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true }));
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
