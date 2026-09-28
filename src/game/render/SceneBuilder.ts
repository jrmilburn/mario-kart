import * as THREE from 'three';
import { clamp, damp } from '../../shared/mathUtils';
import { TUNING } from '../tuning';
import type { KartState } from '../physics/Kart';
import type { CharacterDef } from '../characters/registry';
import { buildKartChassis, disposeChassis, type KartChassis } from './KartBuilder';
import { animateDriver, buildCharacterModel, driverRigOf, type DriverRig } from './CharacterBuilder';
import { disposeGeometries, retint } from './PartAssembler';

export interface KartVisual {
  group: THREE.Group; // body+wheels+driverAnchor; position/rotation driven by physics
  // §v3 Track B: the composed chassis Group (one merged toon mesh + the
  // steering wheel). Still exactly the node that takes the drift-lean roll
  // and parents driverAnchor — that contract is what makes the driver lean
  // into drifts for free. (group.rotation.z is main.ts's track-bank roll;
  // nothing in here writes it.)
  body: THREE.Group;
  frontWheelPivots: THREE.Group[]; // steer-yawed independently of body lean
  leanAngle: number; // smoothed drift-lean state, mutated by updateKartVisual
  pitchAngle: number; // §Phase 5 item 5: smoothed slope-pitch state, mutated by updateKartVisual
  // §Phase 3: seat anchor for the driver (procedural, or a GLB model once one
  // loads). Parented under `body` (not `group`) so it inherits the drift-lean
  // roll (visual.body.rotation.z, set in updateKartVisual) for free — the
  // driver leans into drifts along with the kart body with no extra code.
  driverAnchor: THREE.Group;
  // §v3 Track B item 4: the chassis' steering wheel, turned by steerActual.
  steeringWheel?: THREE.Object3D;
  // The procedural driver's arm-roll rig (CharacterBuilder.animateDriver).
  // Null whenever a GLB driver is mounted (no such node in an imported
  // model) — the steering wheel belongs to the kart, so it keeps turning.
  rig: DriverRig | null;
  // Kept so setKartCharacter can dispose the outgoing chassis when a player
  // re-picks, and read every frame for the wheel spinners/radii and the boost
  // flare's tail/exhaust positions. setKartColor retints chassis.tint
  // (this kart's own colour-attribute runs — the toon material is shared).
  chassis: KartChassis;
  // §v3 Track C2: seconds left on the boost squash-and-stretch pop. Set by
  // triggerBoostPop when a manual boost fires and decayed by updateKartVisual
  // in the render loop (never on the physics tick) — it drives `group.scale`
  // together with the jump squash below, and nothing else writes that scale,
  // so it composes with the lean (body roll), pitch (group rotation.x) and
  // steer visuals rather than fighting them.
  boostPopTimer: number;
  // §v5 jump squash-and-stretch (triggerSquash): seconds since the last
  // trigger (>= SQUASH_SECONDS means idle) and its signed amplitude (+ =
  // stretch tall, - = squash flat).
  squashTime: number;
  squashAmp: number;
  // §v5: accumulated wheel roll angles per axle (rad, wrapped to one turn —
  // the rear tyres are bigger so they turn slower).
  wheelSpinFront: number;
  wheelSpinRear: number;
  // True while group.scale holds a non-identity value, so the frame the last
  // effect ends writes exactly (1,1,1) once and later frames skip the write.
  scaleDirty: boolean;
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
// §v5 golden hour: a low sun (~27° up) over the land (+x), setting behind the
// cane country, so shadows stretch long toward the sea. Environment.ts puts
// the sky's sun disc and the ocean's glints on this same direction.
export const SHADOW_LIGHT_OFFSET = new THREE.Vector3(58, 40, 46);
const SHADOW_HALF_SIZE = 40; // ~80x80m ortho shadow camera, the solo/default extent (§Phase 4 item 3)
const SHADOW_HALF_SIZE_MAX = 90; // widest the ortho box is allowed to grow to cover a spread-out split-screen pair (§Phase 4 finding #3)

// §v5 golden hour (the v4 'space' rig is gone with its map): a warm key sun
// plus a sky/sand HemisphereLight fill. On toon materials the key is what gets
// stepped into bands; the hemisphere fill is smooth and is what keeps the
// shadow side warm and readable instead of flat. PCFSoft shadows (set on the
// renderer in main.ts), one shadow update per frame.
export function buildLights(scene: THREE.Scene): Lights {
  scene.add(new THREE.HemisphereLight(0x9fd8f2, 0xf0c890, 1.25));
  const dir = new THREE.DirectionalLight(0xffc98a, 2.1);
  dir.castShadow = true;
  dir.shadow.mapSize.set(TUNING.shadowMapSize, TUNING.shadowMapSize);
  dir.shadow.camera.left = -SHADOW_HALF_SIZE;
  dir.shadow.camera.right = SHADOW_HALF_SIZE;
  dir.shadow.camera.top = SHADOW_HALF_SIZE;
  dir.shadow.camera.bottom = -SHADOW_HALF_SIZE;
  dir.shadow.camera.near = 10;
  dir.shadow.camera.far = 180;
  dir.shadow.bias = -0.0015; // avoids shadow acne on the flat road/ground planes
  dir.shadow.normalBias = 0.03; // §v5: the low sun grazes banked tarmac at a shallow angle
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
// procedural driver (setDriver swaps in the real GLB model later, once/if it
// loads — see characters/CharacterLoader.ts and main.ts's loadDriverFor).
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

  // §Phase 4 item 3: no blob shadow mesh — real shadow maps (buildLights/
  // updateLightTarget); every chassis/wheel/driver mesh sets castShadow at
  // construction (PartAssembler). Outline hulls never cast (Outline.ts).
  const visual: KartVisual = {
    group,
    body: chassis.body,
    frontWheelPivots: chassis.frontWheelPivots,
    leanAngle: 0,
    pitchAngle: 0,
    driverAnchor,
    steeringWheel: chassis.steeringWheel,
    rig: null,
    chassis,
    boostPopTimer: 0,
    squashTime: SQUASH_SECONDS,
    squashAmp: 0,
    wheelSpinFront: 0,
    wheelSpinRear: 0,
    scaleDirty: false,
  };
  setDriver(visual, def, null); // seed the procedural driver immediately; the caller swaps in a GLB once loaded
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
// twin-exhaust heavy, Peach's royal, Toad's mini...) in its colours. Called
// when an entity changes character; the driver currently mounted on
// driverAnchor is carried across untouched (the caller re-mounts it right
// afterwards via setDriver) — detaching the anchor first means an in-flight
// GLB model is never caught by disposeChassis' traversal.
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
  // The new body starts level; the smoothed lean/pitch state carries over so
  // re-picking mid-drift doesn't pop.
  visual.body.rotation.z = visual.leanAngle;
}

// §Phase 3: sets (or clears) the driver mounted on `visual.driverAnchor` — the
// scaled/offset/rotated GLTF scene when `model` is provided, otherwise the
// procedural character built from `def.driver` (§v3 Track B). Safe to call
// repeatedly (e.g. on character re-select, or when a model finishes loading
// after the procedural driver was already showing): always clears whatever
// was mounted first.
export function setDriver(visual: KartVisual, def: CharacterDef, model: THREE.Object3D | null = null) {
  const anchor = visual.driverAnchor;
  while (anchor.children.length > 0) {
    const child = anchor.children[0];
    anchor.remove(child);
    // Only procedural drivers (tagged userData.disposable) are freed, and
    // only their geometry: their materials are the shared toon/outline
    // caches. GLTF-sourced children share geometry AND materials with the
    // cached original via clone(true), so disposing those would corrupt
    // every other kart using the same cached model.
    if (child.userData.disposable) disposeGeometries(child);
  }

  if (model) {
    model.scale.setScalar(def.scale);
    model.position.set(0, def.yOffset, 0);
    model.rotation.y = def.rotationY;
    // A GLB keeps its own (PBR) materials and gets no baked outline: it can
    // be skinned/morphed and its geometry is shared with the loader cache.
    model.traverse((obj) => {
      if (obj instanceof THREE.Mesh) obj.castShadow = true;
    });
    anchor.add(model);
    // No arm-roll node in an imported model: the per-frame arm animation
    // switches off for it (the kart's steering wheel keeps turning).
    visual.rig = null;
  } else {
    const driver = buildCharacterModel(def);
    anchor.add(driver);
    visual.rig = driverRigOf(driver);
  }
}

// §v3 Track B item 4: retints the WHOLE chassis (and its outline hull) in
// place, by rewriting this kart's own colour-attribute runs (chassis.tint)
// rather than a material colour — the toon material is shared by every kart,
// the colour buffers are not, so this can only ever repaint this one kart.
export function setKartColor(visual: KartVisual, color: number) {
  retint(visual.chassis.tint, color);
}

const LEAN_BLEND_RATE = 1 / 0.15; // blend the drift lean in/out over ~0.15s
const PITCH_BLEND_RATE = 8; // §Phase 5 item 5: smooth the slope-pitch visual over ~0.125s
const FRONT_WHEEL_YAW_SCALE = 0.4;
// §v3 Track B item 4: steering wheel turn per unit of steerActual. Negative
// because the wheel's +Z normal points away from the driver, so a positive
// rotation.z reads as clockwise *to them* while positive steer points the
// front wheels toward the kart's +X (its left).
const STEER_WHEEL_SCALE = -0.7;

// Boost pop (§v3 Track C2): a brief stretch along the kart's own +Z (its
// nose) with a matching squash in X/Y, easing back to 1 over BOOST_POP_SECONDS.
// Applied to `group.scale`, together with the jump squash below.
const BOOST_POP_SECONDS = 0.28;
const BOOST_POP_STRETCH_Z = 0.26;
const BOOST_POP_SQUASH_X = 0.16;
const BOOST_POP_SQUASH_Y = 0.1;

// §v3 Track C2 / §v5: called by main.ts the moment a manual BOOST actually
// fires (not on every boost — a drift-release boost is already sold by the
// drift sparks, a pad by the pad). Idempotent: re-firing mid-pop just
// restarts the timer.
export function triggerBoostPop(visual: KartVisual) {
  visual.boostPopTimer = BOOST_POP_SECONDS;
}

// §v5 jump squash-and-stretch. A damped spring in closed form:
//   s(t) = amp * ramp(t) * e^(-DECAY t) * cos(OMEGA t) * (1 - t/SECONDS)
// applied as y *= 1 + s and x,z *= 1 - s/2 (roughly volume-preserving),
// about the group origin — the tyre contact patch — so the kart squashes
// down onto the road instead of shrinking toward its middle. Closed form
// rather than an integrated spring because a render dt of up to 0.1s (see
// main.ts renderDt clamp) would blow up an explicit integrator at this
// stiffness. The (1 - t/SECONDS) factor lands it on exactly 0 at the end, and
// the 30ms ramp keeps the first frame from snapping. One overshoot, done in
// ~0.28s: takeoff stretches tall and then briefly flattens; landing squashes
// flat and then briefly springs tall.
export const SQUASH_SECONDS = 0.28;
const SQUASH_OMEGA = Math.PI * 2 * 3.2;
const SQUASH_DECAY = 6;
const SQUASH_RAMP = 0.03;
const SQUASH_TAKEOFF = 0.2;
const SQUASH_LAND = -0.3;

// Called by the jump code: 'takeoff' the tick the kart leaves the ground,
// 'land' the tick it touches down. `strength` (clamped 0..2) scales the
// amplitude, e.g. by landing speed; 1 is a normal jump. Restarts mid-spring.
export function triggerSquash(visual: KartVisual, kind: 'takeoff' | 'land', strength = 1) {
  visual.squashTime = 0;
  visual.squashAmp = (kind === 'takeoff' ? SQUASH_TAKEOFF : SQUASH_LAND) * clamp(strength, 0, 2);
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

  visual.group.rotation.y = kart.heading;

  // group.scale = boost pop x jump squash. Written only while either is
  // running, plus exactly once more (scaleDirty) to land on (1,1,1).
  let sx = 1;
  let sy = 1;
  let sz = 1;
  let scaling = false;
  if (visual.boostPopTimer > 0) {
    visual.boostPopTimer = Math.max(0, visual.boostPopTimer - dt);
    const ease = (visual.boostPopTimer / BOOST_POP_SECONDS) ** 2;
    sx *= 1 - BOOST_POP_SQUASH_X * ease;
    sy *= 1 - BOOST_POP_SQUASH_Y * ease;
    sz *= 1 + BOOST_POP_STRETCH_Z * ease;
    scaling = true;
  }
  if (visual.squashTime < SQUASH_SECONDS) {
    visual.squashTime = Math.min(SQUASH_SECONDS, visual.squashTime + dt);
    const t = visual.squashTime;
    const s =
      visual.squashAmp *
      Math.min(1, t / SQUASH_RAMP) *
      Math.exp(-SQUASH_DECAY * t) *
      Math.cos(SQUASH_OMEGA * t) *
      (1 - t / SQUASH_SECONDS);
    sy *= 1 + s;
    sx *= 1 - s * 0.5;
    sz *= 1 - s * 0.5;
    scaling = true;
  }
  if (scaling || visual.scaleDirty) {
    visual.group.scale.set(sx, sy, sz);
    visual.scaleDirty = scaling;
  }

  // §v3 polish: 0.25 -> 0.21 rad, matching the eased driftYawBonus/lateral
  // slip in TUNING — the body still visibly rolls into a drift, just less.
  const targetLean = kart.drift.phase === 'active' ? kart.drift.dir * 0.21 : 0;
  visual.leanAngle = damp(visual.leanAngle, targetLean, LEAN_BLEND_RATE, dt);
  visual.body.rotation.z = visual.leanAngle;
  visual.driverAnchor.rotation.z = damp(visual.driverAnchor.rotation.z, -kart.steerActual * 0.09, 7, dt);
  visual.driverAnchor.rotation.x = damp(visual.driverAnchor.rotation.x, kart.boostTimer > 0 ? 0.10 : 0, 9, dt);

  const targetPitch = -Math.asin(clamp(grade, -1, 1));
  visual.pitchAngle = damp(visual.pitchAngle, targetPitch, PITCH_BLEND_RATE, dt);
  visual.group.rotation.x = visual.pitchAngle;

  for (const pivot of visual.frontWheelPivots) {
    pivot.rotation.y = kart.steerActual * FRONT_WHEEL_YAW_SCALE;
  }

  // §v5: wheels roll with speed (angle = distance / radius, per axle since the
  // rear tyres are bigger). Wrapped to one turn so the float never grows.
  const chassis = visual.chassis;
  const travel = kart.speed * dt;
  visual.wheelSpinFront = (visual.wheelSpinFront + travel / chassis.frontR) % (Math.PI * 2);
  visual.wheelSpinRear = (visual.wheelSpinRear + travel / chassis.rearR) % (Math.PI * 2);
  for (const spinner of chassis.frontWheelSpinners) spinner.rotation.x = visual.wheelSpinFront;
  for (const axle of chassis.rearWheels) axle.rotation.x = visual.wheelSpinRear;

  // §v3 Track B item 4 / §v5: the steering wheel follows the input, and the
  // procedural driver's arms follow the wheel (a GLB driver has no rig).
  // Scalar writes only, no allocation, no traversal —
  // updateKartVisual runs for all six karts every frame.
  if (visual.steeringWheel) visual.steeringWheel.rotation.z = kart.steerActual * STEER_WHEEL_SCALE;
  if (visual.rig) animateDriver(visual.rig, kart.steerActual);
}
