// §v3 Track B item 3: per-character kart chassis.
//
// Replaces the single `BoxGeometry(1.2, 0.5, 2.2)` body that every racer used
// to share with a composed chassis — floor pan, side pods, tapered nose,
// bumper, cowl, seat, engine block with exhaust stacks, steering wheel — whose
// proportions vary per `def.kart.kind`, so a kart is identifiable before you
// even look at who's driving it.
//
// Conventions (do not change without checking physics/Kart.ts kartForward):
//  - Local +Z is the nose, +Y is up.
//  - Everything in here is authored in GROUND space: y = 0 is the tyre contact
//    patch. PartAssembler.build() (its `origin` option) shifts the merged geometry down by the body
//    group's pivot height at the end, so the drift-lean roll (applied to that
//    group by updateKartVisual) pivots around the chassis floor rather than
//    around the wheels' contact patch.
//  - Wheels are returned separately and get parented to the kart ROOT, not to
//    the leaning body, so they stay planted through a drift like they did
//    before Track B. Each front wheel is pivot (steer yaw) -> spinner (roll)
//    -> mesh; the rear pair shares one axle line, so both are ONE mesh on one
//    spinning group that sits on that axle.
//
// Geometry, proportions and colours are exactly the v3 ones, with one
// addition: a dark hub cross on each rim, without which a spinning
// cylinder is indistinguishable from a still one. Post-v5 the parts render
// through PartAssembler's cel-shading pipeline — one vertex-coloured toon
// mesh + baked outline hull for the chassis (v3: 5 colour-bucket meshes),
// one per front wheel, one for the rear axle, and the steering wheel (no
// outline) — and the kart colour is retinted through `tint` ranges.
import * as THREE from 'three';
import type { CharacterDef, KartKind } from '../characters/registry';
import {
  PartAssembler,
  box,
  cone,
  cyl,
  disc,
  disposeGeometries,
  limb,
  spanBoxZ,
  sphere,
  taperedBox,
  torus,
  type TintRange,
} from './PartAssembler';

// Colours shared by every chassis regardless of character; only `shell` (the
// kart colour) and `accent` come from the registry.
const FRAME = 0x2a2d33; // floor pan, engine, tyres — reads as dark rubber/plastic
const METAL = 0xb9c0cc; // exhausts, roll hoop, rims, steering column
const RIM = 0xd7dce3;
const SEAT_DARK = 0x33373f;

interface KartProfile {
  halfW: number; // half-width of the shell tub
  frontZ: number; // nose tip
  rearZ: number; // tail
  noseLen: number; // length of the tapered nose section
  floorY: number; // top of the floor pan (ride height)
  trackHalf: number; // wheel lateral offset
  wheelbase: number; // wheel |z|
  frontR: number;
  rearR: number;
  tyreW: number;
  seatY: number; // driver anchor height (top of the seat cushion)
  seatZ: number;
  exhausts: number[]; // x offsets of the rear exhaust stacks
  spoiler: boolean;
  // Distance BEHIND seatZ at which the roll hoop's plane sits; 0 = no hoop.
  // §v3 Track B review finding #2: this was a bare boolean with one hard-coded
  // 0.34m setback, which buried the heavy chassis' hoop apex 0.16m inside
  // Bowser's shell dome (shell centre is seat-local (0, 0.50, -0.19), R=0.35,
  // so on `heavy` the hoop plane at seatZ-0.34 cuts straight through it). It is
  // per-profile now so the hoop can clear whoever is sitting in front of it.
  hoopBack: number;
  heartTail: boolean; // royal's rounded twin-lobe tail
}

// §v3 Track B item 3: "slim = narrower/longer, royal = rounded with a heart-ish
// tail, buggy = raised with fat tyres, mini = short wheelbase, heavy = wide
// with twin exhausts". Kept well inside the 1.1m physics kartRadius footprint
// (TUNING.kartRadius) so the visuals never overhang the collision shape by
// more than the old box did.
const PROFILES: Record<KartKind, KartProfile> = {
  standard: {
    halfW: 0.52, frontZ: 1.10, rearZ: -1.04, noseLen: 0.54, floorY: 0.30,
    trackHalf: 0.62, wheelbase: 0.74, frontR: 0.30, rearR: 0.34, tyreW: 0.24,
    seatY: 0.74, seatZ: -0.24, exhausts: [-0.15, 0.15], spoiler: false, hoopBack: 0, heartTail: false,
  },
  slim: {
    halfW: 0.45, frontZ: 1.20, rearZ: -1.10, noseLen: 0.64, floorY: 0.30,
    trackHalf: 0.57, wheelbase: 0.84, frontR: 0.29, rearR: 0.33, tyreW: 0.21,
    seatY: 0.74, seatZ: -0.28, exhausts: [0], spoiler: true, hoopBack: 0, heartTail: false,
  },
  royal: {
    halfW: 0.53, frontZ: 1.08, rearZ: -1.06, noseLen: 0.50, floorY: 0.32,
    trackHalf: 0.61, wheelbase: 0.74, frontR: 0.29, rearR: 0.33, tyreW: 0.22,
    seatY: 0.76, seatZ: -0.24, exhausts: [-0.13, 0.13], spoiler: false, hoopBack: 0, heartTail: true,
  },
  buggy: {
    halfW: 0.54, frontZ: 1.02, rearZ: -1.00, noseLen: 0.44, floorY: 0.44,
    trackHalf: 0.66, wheelbase: 0.72, frontR: 0.36, rearR: 0.40, tyreW: 0.30,
    // Yoshi's body sphere ends at seat-local z = -0.318, so 0.34 clears it.
    seatY: 0.88, seatZ: -0.20, exhausts: [-0.16, 0.16], spoiler: true, hoopBack: 0.34, heartTail: false,
  },
  mini: {
    halfW: 0.47, frontZ: 0.94, rearZ: -0.88, noseLen: 0.42, floorY: 0.28,
    trackHalf: 0.56, wheelbase: 0.60, frontR: 0.27, rearR: 0.30, tyreW: 0.22,
    seatY: 0.70, seatZ: -0.18, exhausts: [0], spoiler: false, hoopBack: 0, heartTail: false,
  },
  heavy: {
    halfW: 0.66, frontZ: 1.16, rearZ: -1.10, noseLen: 0.54, floorY: 0.34,
    trackHalf: 0.76, wheelbase: 0.80, frontR: 0.34, rearR: 0.40, tyreW: 0.32,
    // 0.58 puts the hoop plane 0.39m behind Bowser's shell centre, i.e. clear
    // of its R=0.35 dome AND of the two lower shell spikes (§finding #2).
    seatY: 0.80, seatZ: -0.26, exhausts: [-0.28, -0.12, 0.12, 0.28], spoiler: true, hoopBack: 0.58, heartTail: false,
  },
};

export interface KartChassis {
  // The node that takes the drift-lean roll and parents the driver anchor
  // (see KartVisual.body). One merged chassis mesh + the steering wheel.
  body: THREE.Group;
  // Wheels live on the kart root (they must not lean); the two front ones are
  // wrapped in steer pivots (rotation.y)...
  frontWheelPivots: THREE.Group[];
  // ...and roll on a child spinner each (rotation.x), same order as the pivots.
  frontWheelSpinners: THREE.Object3D[];
  // A single group holding BOTH rear wheels as one mesh. The group sits ON the
  // shared axle line, so spinning it (rotation.x) rolls both wheels. Still an
  // array so SceneBuilder.mountChassis/setKartCharacter stay generic.
  rearWheels: THREE.Group[];
  frontR: number; // for the wheel spin rate (speed / radius)
  rearR: number;
  // Rotated about its local Z by updateKartVisual for a bit of life.
  steeringWheel: THREE.Object3D;
  // Every colour-attribute run carrying the kart colour (chassis body + its
  // outline hull), so setKartColor retints the whole chassis in place. The
  // buffers are this kart's own — tinting can never repaint another kart
  // (§Track B item 4).
  tint: TintRange[];
  // Ground-space seat anchor; SceneBuilder converts it into body-local space.
  seatY: number;
  seatZ: number;
  bodyPivotY: number; // body group height, i.e. the roll pivot
  // §v3 Track C2: this profile's tail plane (ground-space local z, negative).
  // Read-only, published purely so the boost flare can start exactly at this
  // kart's tail — the profiles differ by 0.22m front to back, which is enough
  // for a fixed offset to leave a visible gap behind `mini` or bury the flame
  // inside `heavy`.
  rearZ: number;
  exhaustY: number; // ground-space y of the exhaust stack outlets, for the same reason
  // §v3 Track C review fix: the x offsets of this profile's exhaust stacks (1
  // on slim/mini, 2 on standard/royal/buggy, 4 on heavy). The boost flare used
  // to hard-code ±0.2 and so plumed out of blank bodywork on four of the six
  // karts; it now places one plume per stack from this array.
  exhausts: readonly number[];
}

type ChassisPart = 'shell' | 'accent' | 'frame' | 'metal' | 'seat';

type WheelPart = 'tyre' | 'rim' | 'hub';

function wheelParts() {
  return new PartAssembler<WheelPart>({ tyre: { color: FRAME }, rim: { color: RIM }, hub: { color: FRAME } });
}

// One wheel around its own axle (axis = local X), offset `x` along it: dark
// tyre + a lighter rim poking out both sides (the v3 wheel), plus a thin dark
// hub cross over the rim so the roll actually reads when it spins.
function addWheel(parts: PartAssembler<WheelPart>, r: number, w: number, x: number) {
  parts.add('tyre', cyl(r, r, w, 12).rotateZ(Math.PI / 2).translate(x, 0, 0));
  parts.add('rim', cyl(r * 0.56, r * 0.56, w * 1.06, 8).rotateZ(Math.PI / 2).translate(x, 0, 0));
  parts.add('hub', box(w * 1.1, r * 0.9, 0.05).translate(x, 0, 0), box(w * 1.1, 0.05, r * 0.9).translate(x, 0, 0));
}

export function buildKartChassis(def: CharacterDef): KartChassis {
  const p = PROFILES[def.kart.kind];
  const accent = def.kart.accent;
  const panFrontZ = p.frontZ - p.noseLen; // where the tapered nose starts
  const bodyPivotY = p.floorY;
  // §v3 Track B review finding #1: CharacterBuilder authors every driver with
  // their hips, thighs and boots at y ~= 0 in SEAT-local space (min y is
  // seatY - 0.035 for the plumbers/Toad, seatY - 0.086 for Yoshi's body
  // sphere), but the tallest thing under the footwell used to be the shell
  // tub at floorY + 0.16 — 0.10 to 0.34m lower on every profile. Six racers
  // therefore sat on an invisible chair with their feet dangling, which is
  // exactly what the split-screen opponent view shows off. `deckTop` is the
  // raised footwell floor the boots now land on; the cowl and the steering
  // column are placed relative to it too, so the whole cockpit moves together
  // when a profile's seatY changes.
  const deckTop = p.seatY - 0.045;
  const deckBottom = p.floorY + 0.16; // top of the shell tub — no void left between them

  const parts = new PartAssembler<ChassisPart>({
    shell: { color: def.kartColor, tint: true },
    accent: { color: accent },
    frame: { color: FRAME },
    metal: { color: METAL },
    seat: { color: SEAT_DARK },
  });

  // --- floor pan + tub ------------------------------------------------------
  parts.add('frame', spanBoxZ(p.halfW * 2, 0.10, p.rearZ + 0.04, panFrontZ + 0.04).translate(0, p.floorY - 0.05, 0));
  parts.add('shell', spanBoxZ(p.halfW * 2 - 0.04, 0.18, p.rearZ + 0.06, panFrontZ).translate(0, p.floorY + 0.07, 0));

  // --- side pods: the main mass either side of the driver -------------------
  for (const sx of [-1, 1]) {
    const podW = p.halfW * 0.42;
    parts.add(
      'shell',
      taperedBox({ w: podW * 0.7, h: 0.20 }, { w: podW, h: 0.28 }, Math.abs(panFrontZ - 0.08 - (p.rearZ + 0.12)))
        .translate(sx * (p.halfW - podW * 0.35), p.floorY + 0.13, (panFrontZ - 0.08 + p.rearZ + 0.12) / 2),
    );
    // A thin accent rail along the top of each pod — the single cheapest thing
    // that keeps the karts from reading as one flat colour at distance.
    parts.add(
      'accent',
      spanBoxZ(podW * 0.8, 0.035, p.rearZ + 0.14, panFrontZ - 0.10).translate(sx * (p.halfW - podW * 0.35), p.floorY + 0.265, 0),
    );
  }

  // --- tapered nose + bumper ------------------------------------------------
  parts.add(
    'shell',
    taperedBox({ w: p.halfW * 1.0, h: 0.13, dy: -0.035 }, { w: p.halfW * 1.95, h: 0.28 }, p.noseLen)
      .translate(0, p.floorY + 0.12, panFrontZ + p.noseLen / 2),
  );
  parts.add(
    'accent',
    taperedBox({ w: p.halfW * 0.5, h: 0.03, dy: -0.035 }, { w: p.halfW * 0.95, h: 0.03 }, p.noseLen * 0.92)
      .translate(0, p.floorY + 0.245, panFrontZ + p.noseLen / 2),
  );
  // Rounded bumper bar across the nose tip.
  parts.add('accent', cyl(0.075, 0.075, p.halfW * 1.5, 8).rotateZ(Math.PI / 2).translate(0, p.floorY + 0.075, p.frontZ - 0.07));
  parts.add('frame', cyl(0.06, 0.06, p.halfW * 1.7, 8).rotateZ(Math.PI / 2).translate(0, p.floorY + 0.05, p.rearZ + 0.05));

  // --- cowl in front of the driver -----------------------------------------
  // Steering wheel hub, the same offset from the seat on every chassis so
  // CharacterBuilder's hands land on the rim without per-kart tuning.
  const wheelZ = p.seatZ + 0.38;
  const wheelY = p.seatY + 0.32;
  // --- footwell deck + cowl -------------------------------------------------
  // The deck runs from just behind the seat forward to where the tapered nose
  // starts, between the side pods (their inner edge is at 0.643 * halfW, so a
  // 1.15 * halfW wide deck fits with room to spare) and from the tub top up to
  // `deckTop`. It is capped short of seatZ + 0.84 so the mini/buggy chassis
  // (short nose, long seat-to-axle gap) don't run a raised block halfway down
  // their nose.
  const deckFrontZ = Math.min(panFrontZ, p.seatZ + 0.84);
  parts.add(
    'frame',
    spanBoxZ(p.halfW * 1.15, deckTop - deckBottom, p.seatZ - 0.22, deckFrontZ).translate(0, (deckTop + deckBottom) / 2, 0),
  );
  // The cowl now sits ON the deck rather than down at floorY + 0.20 (where the
  // deck would have swallowed it whole), and is stretched to end 1cm past the
  // deck's front face — that hides the face and guarantees the cowl is fully
  // supported instead of poking out over the nose on the short-nosed profiles.
  // Its top lands just under the steering wheel's lowest rim point
  // (seatY + 0.15), so it reads as a dashboard rather than a kerb.
  const cowlBackZ = wheelZ + 0.13;
  const cowlFrontZ = deckFrontZ + 0.01;
  parts.add(
    'shell',
    taperedBox({ w: p.halfW * 1.15, h: 0.14 }, { w: p.halfW * 1.55, h: 0.22 }, cowlFrontZ - cowlBackZ)
      .translate(0, deckTop + 0.05, (cowlBackZ + cowlFrontZ) / 2),
  );

  // --- seat -----------------------------------------------------------------
  parts.add('seat', box(0.46, 0.10, 0.42).translate(0, p.seatY - 0.05, p.seatZ + 0.03));
  // Deliberately low: from the follow camera (behind and above) a tall seat
  // back hides the driver's colours, which are most of what identifies them.
  parts.add('seat', box(0.42, 0.30, 0.12).rotateX(-0.14).translate(0, p.seatY + 0.12, p.seatZ - 0.25));
  parts.add('accent', box(0.38, 0.055, 0.05).rotateX(-0.14).translate(0, p.seatY + 0.26, p.seatZ - 0.27));

  // --- engine block + exhausts ---------------------------------------------
  parts.add('frame', box(p.halfW * 1.5, 0.26, 0.42).translate(0, p.floorY + 0.16, p.rearZ + 0.26));
  parts.add('shell', box(p.halfW * 1.35, 0.10, 0.36).translate(0, p.floorY + 0.32, p.rearZ + 0.26));
  for (const ex of p.exhausts) {
    parts.add(
      'metal',
      limb([ex, p.floorY + 0.30, p.rearZ + 0.30], [ex, p.floorY + 0.40, p.rearZ - 0.12], 0.05, 0.062, 6),
    );
  }

  // --- per-kind flourishes --------------------------------------------------
  if (p.spoiler) {
    parts.add('accent', box(p.halfW * 1.7, 0.05, 0.20).rotateX(0.12).translate(0, p.floorY + 0.50, p.rearZ + 0.10));
    for (const sx of [-1, 1]) {
      parts.add('metal', limb([sx * p.halfW * 0.6, p.floorY + 0.30, p.rearZ + 0.12], [sx * p.halfW * 0.6, p.floorY + 0.49, p.rearZ + 0.10], 0.03));
    }
  }
  if (p.hoopBack > 0) {
    // Half-torus arcing over and behind the seat (a torus' 0..PI arc is its
    // upper half in the XY plane, which is exactly the roll bar we want).
    parts.add('metal', torus(0.34, 0.035, 4, 10, Math.PI).translate(0, p.seatY + 0.04, p.seatZ - p.hoopBack));
  }
  if (p.heartTail) {
    // Peach's tail: two rounded lobes over a downward point — a heart in
    // silhouette from behind without a custom shape.
    for (const sx of [-1, 1]) {
      parts.add('shell', sphere(0.19, 8, 6).scale(1, 0.85, 0.75).translate(sx * 0.16, p.floorY + 0.30, p.rearZ + 0.10));
    }
    parts.add('shell', cone(0.24, 0.30, 8).rotateX(Math.PI).translate(0, p.floorY + 0.13, p.rearZ + 0.10));
    // §v3 Track B review finding #5: this badge used to sit at rearZ + 0.05,
    // i.e. *between* the two lobes' front and back surfaces (they span
    // rearZ - 0.0425 .. rearZ + 0.2425), so it was occluded from every angle —
    // 8 dead triangles. rearZ - 0.06 clears the lobes' rear extent, and
    // floorY + 0.36 clears the top of the inverted cone tail (floorY + 0.28).
    parts.add('accent', disc(0.09, 8).rotateY(Math.PI).translate(0, p.floorY + 0.36, p.rearZ - 0.06));
  }

  // --- steering column ------------------------------------------------------
  // Runs from the cowl up/back to the wheel hub. Goes through the shared
  // 'metal' bucket rather than being its own Mesh (§v3 Track B review finding
  // #3: it was one more draw call and one more material per kart for a single
  // 24-triangle tube). Authored in ground space like everything else — the
  // origin in parts.build below moves it into body-local space.
  parts.add('metal', limb([0, wheelY - 0.09, wheelZ + 0.05], [0, deckTop + 0.08, wheelZ + 0.26], 0.02, 0.027, 6));

  // Every bucket flagged `tint` in the palette (today: 'shell', which covers
  // the tub, pods, nose, engine cover and tail) reports its vertex runs in
  // `built.tint`, so setKartColor repaints the whole chassis in one pass.
  const body = new THREE.Group();
  const built = parts.build(body, { origin: [0, bodyPivotY, 0], name: 'chassis' });

  // --- steering wheel -------------------------------------------------------
  // The wheel hangs off a fixed-tilt pivot so updateKartVisual only has to set
  // rotation.z (the column that reaches it is merged into the chassis above).
  // No outline: the gloves cover most of it and it's tiny.
  const wheelPivot = new THREE.Group();
  wheelPivot.position.set(0, wheelY - bodyPivotY, wheelZ);
  wheelPivot.rotation.x = 0.4; // top tipped away from the driver, like a real column angle
  const steeringWheel = new THREE.Group();
  const swParts = new PartAssembler<'rim' | 'hub'>({
    rim: { color: 0x2b2f36 },
    hub: { color: accent },
  });
  // Rim radius must equal CharacterBuilder's HAND_X — that's the contract that
  // puts every driver's gloves on the wheel.
  swParts.add('rim', torus(0.17, 0.032, 4, 12));
  swParts.add('hub', cyl(0.05, 0.05, 0.05, 8).rotateX(Math.PI / 2));
  swParts.add('rim', box(0.30, 0.038, 0.02), box(0.038, 0.26, 0.02).translate(0, -0.07, 0));
  swParts.build(steeringWheel, { outline: false, name: 'steering-wheel' });
  wheelPivot.add(steeringWheel);
  body.add(wheelPivot);

  const chassis: KartChassis = {
    body,
    frontWheelPivots: [],
    frontWheelSpinners: [],
    rearWheels: [],
    frontR: p.frontR,
    rearR: p.rearR,
    steeringWheel,
    tint: built.tint,
    seatY: p.seatY,
    seatZ: p.seatZ,
    bodyPivotY,
    rearZ: p.rearZ,
    // The exhaust `limb` above ends at floorY + 0.40; the flare plumes out of
    // that same height, at each stack's own x.
    exhaustY: p.floorY + 0.4,
    exhausts: p.exhausts,
  };

  // --- wheels ---------------------------------------------------------------
  // Same placement as v3; the extra spinner level only adds the roll axis.
  for (const sx of [1, -1]) {
    const pivot = new THREE.Group();
    pivot.position.set(sx * p.trackHalf, p.frontR, p.wheelbase);
    const spinner = new THREE.Group();
    const wp = wheelParts();
    addWheel(wp, p.frontR, p.tyreW, 0);
    wp.build(spinner, { name: 'front-wheel' });
    pivot.add(spinner);
    chassis.frontWheelPivots.push(pivot);
    chassis.frontWheelSpinners.push(spinner);
  }
  // §v3 Track B review finding #3: the rear pair has fixed transforms (only the
  // front pair needs its own steer pivot), so both rear wheels go through one
  // assembler and come out as a single mesh. The group sits on the rear axle
  // line (v3 kept it at the origin with the wheels baked at axle height), so
  // rolling it about X spins both wheels in place.
  const rearAxle = new THREE.Group();
  rearAxle.position.set(0, p.rearR, -p.wheelbase);
  const rearParts = wheelParts();
  const rearW = p.tyreW * 1.12;
  for (const sx of [1, -1]) addWheel(rearParts, p.rearR, rearW, sx * p.trackHalf);
  rearParts.build(rearAxle, { name: 'rear-axle' });
  chassis.rearWheels.push(rearAxle);

  return chassis;
}

// Frees everything a chassis owns — geometry only: the materials are the
// shared toon/outline caches (see PartAssembler's disposal invariant). Only
// ever called when an entity changes character (SceneBuilder.setKartCharacter
// rebuilds the chassis so they get that character's kart, not just its
// colour).
export function disposeChassis(chassis: KartChassis) {
  const roots: THREE.Object3D[] = [chassis.body, ...chassis.frontWheelPivots, ...chassis.rearWheels];
  for (const root of roots) disposeGeometries(root);
}
