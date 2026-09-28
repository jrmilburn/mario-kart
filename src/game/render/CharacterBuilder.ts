// §v3 Track B item 2: procedural drivers that are actually recognisable.
//
// The old fallback was a head sphere + torso box + domed cap in three colours,
// which is why every racer read as "the same blob in a different hue". The
// user's ask was "actual designs for each of the characters... so it looks
// decent", so each `driver.kind` here gets a purpose-built silhouette: a cap
// with a brim, a big nose and a moustache for the plumbers; a bell gown and a
// crown for the princess; a snout with eyes on top of the head and back spikes
// for the dino; an oversized spotted mushroom cap for Toad; a spiked shell,
// horns and a red hair tuft for Bowser. Silhouette and colour do the work —
// at split-screen size that's all you get.
//
// Space: origin = the kart's seat anchor (driverAnchor), +Z is the kart's nose
// (physics/Kart.ts kartForward), y grows up from the seat cushion. Characters
// end up ~0.9-1.2m tall from the seat depending on who they are.
//
// Geometry, proportions and colours are exactly the v3 ones. Post-v5 they
// render through the shared cel-shading pipeline: PartAssembler merges each
// driver into TWO vertex-coloured toon meshes (the body, and the arms on
// their steering-roll pivot — v3 was 9-13 colour-bucket meshes), each with a
// baked inverted-hull outline child (Outline.ts; pupils/irises opt out, flat
// decals are skipped automatically). Geometry is freshly allocated per call
// because SceneBuilder.setDriver disposes the whole subtree's geometry when
// the driver is swapped out (GLB arriving, character re-picked) — sharing it
// across karts would free geometry another kart is still drawing. Materials
// are the shared toon/outline caches and are never disposed.
import * as THREE from 'three';
import type { CharacterDef, DriverStyle } from '../characters/registry';
import {
  PartAssembler,
  type PartMaterialSpec,
  box,
  cyl,
  disc,
  hemisphere,
  limb,
  sphere,
  surfaceSpot,
  taperedBox,
} from './PartAssembler';

// Smooth silhouettes at chase-camera distance; colour buckets remain merged.
const HEAD_W = 20, HEAD_H = 14;
const BODY_W = 14, BODY_H = 10;
const SMALL_W = 12, SMALL_H = 8;
const TINY_W = 10, TINY_H = 6;

const EYE_WHITE = 0xfbfbfb;
const PUPIL = 0x2a2320;
const GOLD = 0xf2c94c;
const BOOT = 0x5b3a1e;
const GEM = 0x3fa7ff;

// Where the driver's hands must end up: the steering wheel's ±X rim extremes.
// KartBuilder puts the wheel hub at (0, seatY + 0.32, seatZ + 0.38) with a
// 0.17m rim for EVERY chassis kind, and a tilt about X doesn't move points on
// the X axis — so in seat-local space these coordinates are the same for all
// six karts, and every character can reach the wheel without per-kart tuning.
const HAND_X = 0.17;
const HAND_Y = 0.32;
const HAND_Z = 0.38;

// Height of the arm-roll pivot above the seat. updateKartVisual rolls this
// group with the steering wheel so the driver's arms move with the wheel
// (§Track B item 4, "if easy") — arms live in their own group/assembler for
// exactly that reason.
const ARM_PIVOT_Y = 0.40;

type Palette =
  | 'skin'
  | 'shirt'
  | 'overalls'
  | 'cap'
  | 'hair'
  | 'accent'
  | 'eye'
  | 'pupil'
  | 'trim'
  | 'dark'
  // §v3 Track B review finding #4: the blue GEM constant was declared for
  // Peach's crown and then never referenced — the centre stone was built out
  // of `pupil` (0x2a2320) and rendered as a dark blob against the gold crown.
  // It gets its own bucket because no other palette slot is anywhere near
  // blue. (Post-v5 buckets are vertex colours in one merged mesh, so it no
  // longer costs a draw call.)
  | 'gem'
  | 'iris';

// Pupils and irises sit on the eye whites; their own hulls would only smudge
// the eye into a dark blob at chase distance, so they rely on the sclera's rim.
function paletteFor(d: DriverStyle): Record<Palette, PartMaterialSpec> {
  return {
    iris: { color: 0x287fba, outline: false },
    skin: { color: d.skin },
    shirt: { color: d.shirt },
    overalls: { color: d.overalls },
    cap: { color: d.cap },
    hair: { color: d.hair },
    accent: { color: d.accent },
    eye: { color: EYE_WHITE },
    pupil: { color: PUPIL, outline: false },
    trim: { color: GOLD, flat: true },
    dark: { color: BOOT },
    gem: { color: GEM, flat: true },
  };
}

type Parts = PartAssembler<Palette>;

// A pair of eyes: white sclera squashed into an oval plus a dark pupil sitting
// slightly proud of it (a pupil buried inside the sclera reads as nothing at
// 30m; poking out reads as a pupil).
function addEyes(
  parts: Parts,
  o: {
    x: number; y: number; z: number;
    r: number; sx?: number; sy?: number; sz?: number;
    pupilR: number; pupilOut?: number;
  },
) {
  const out = o.pupilOut ?? 0.03;
  for (const s of [-1, 1]) {
    parts.add(
      'eye',
      sphere(o.r, SMALL_W, SMALL_H).scale(o.sx ?? 0.85, o.sy ?? 1.25, o.sz ?? 0.7).translate(s * o.x, o.y, o.z),
    );
    parts.add('iris', sphere(o.pupilR * 1.5, SMALL_W, SMALL_H).scale(1, 1.1, 0.45).translate(s * o.x, o.y, o.z + o.r * (o.sz ?? 0.7) + out - o.pupilR * 0.25));
    parts.add('eye', sphere(o.pupilR * 0.28, TINY_W, TINY_H).translate(s * o.x - o.pupilR * 0.2, o.y + o.pupilR * 0.35, o.z + o.r * (o.sz ?? 0.7) + out + o.pupilR * 0.55));
    parts.add(
      'pupil',
      sphere(o.pupilR, TINY_W, TINY_H).translate(s * o.x, o.y, o.z + o.r * (o.sz ?? 0.7) + out - o.pupilR * 0.5),
    );
  }
}

// Straight tapered arms from the shoulders to the wheel rim, plus hands. Built
// into `arms` (the roll pivot), never into the body assembler.
function addArms(
  arms: Parts,
  o: { sleeve: Palette; hand: Palette; shoulderX: number; shoulderY: number; shoulderZ?: number; r: number; handR: number },
) {
  for (const s of [-1, 1]) {
    arms.add(
      o.sleeve,
      limb([s * o.shoulderX, o.shoulderY, o.shoulderZ ?? 0.02], [s * HAND_X, HAND_Y, HAND_Z], o.r, o.r * 0.85, 6),
    );
    arms.add(o.hand, sphere(o.handR, SMALL_W, SMALL_H).translate(s * HAND_X, HAND_Y, HAND_Z));
  }
}

// --- plumber (Mario, Luigi) --------------------------------------------------
// Luigi is the plumber on the 'slim' chassis: same construction, taller torso,
// smaller head, narrower shoulders — he has to read as "the tall one" when
// they're side by side on the grid.
function buildPlumber(parts: Parts, arms: Parts, def: CharacterDef) {
  const lanky = def.kart.kind === 'slim';
  const bodyW = lanky ? 0.40 : 0.45;
  const torsoH = lanky ? 0.42 : 0.34;
  const headR = lanky ? 0.195 : 0.215;
  const hipTop = 0.14;
  const torsoY = hipTop + torsoH / 2;
  const shoulderY = hipTop + torsoH - 0.04;
  const headY = hipTop + torsoH + headR * 0.82;
  const capY = headY + headR * 0.36;

  // hips + legs reaching forward to the pedals
  parts.add('overalls', box(bodyW, 0.18, 0.34).translate(0, 0.07, 0.03));
  for (const s of [-1, 1]) {
    parts.add('overalls', limb([s * 0.13, 0.10, 0.10], [s * 0.15, 0.06, 0.36], 0.085, 0.07, 6));
    parts.add('dark', box(0.15, 0.11, 0.20).translate(s * 0.15, 0.02, 0.46));
  }

  // torso: shirt with the overalls bib + straps over it
  parts.add('shirt', sphere(1, HEAD_W, HEAD_H).scale(bodyW * 0.55, torsoH * 0.66, 0.18).translate(0, torsoY, 0.01));
  parts.add('overalls', box(bodyW * 1.02, 0.16, 0.32).translate(0, hipTop + 0.07, 0.01));
  parts.add('overalls', box(bodyW * 0.58, torsoH * 0.62, 0.06).translate(0, torsoY + 0.02, 0.15));
  for (const s of [-1, 1]) {
    parts.add('overalls', box(0.06, torsoH * 0.66, 0.05).translate(s * 0.105, torsoY + 0.10, 0.145));
    parts.add('trim', disc(0.03, 8).translate(s * 0.105, torsoY + 0.02, 0.185));
    parts.add('shirt', sphere(0.095, SMALL_W, SMALL_H).translate(s * (bodyW / 2), shoulderY, 0.01));
  }

  // head
  parts.add('skin', sphere(headR, HEAD_W, HEAD_H).translate(0, headY, 0.02));
  for (const s of [-1, 1]) {
    parts.add('skin', sphere(0.055, TINY_W, TINY_H).translate(s * headR * 0.95, headY - 0.01, 0));
    // Sideburns sit low and slightly back: at eye height they merged with the
    // pupils into one dark visor band across the face.
    parts.add('hair', box(0.045, 0.10, 0.11).translate(s * headR * 0.90, headY - 0.045, -0.01));
  }
  parts.add('hair', box(0.26, 0.11, 0.10).translate(0, headY - 0.05, -headR * 0.86));
  parts.add('skin', sphere(0.078, SMALL_W, SMALL_H).scale(1, 1, 1.35).translate(0, headY - 0.02, headR * 0.9));
  addEyes(parts, { x: 0.074, y: headY + 0.05, z: headR * 0.82, r: 0.062, sx: 0.8, sy: 1.3, pupilR: 0.024 });
  // moustache: three squashed boxes, the outer two kicked up at the ends
  parts.add('hair', box(0.075, 0.05, 0.075).translate(0, headY - 0.075, headR * 0.86));
  for (const s of [-1, 1]) {
    parts.add('hair', box(0.10, 0.052, 0.075).rotateZ(s * -0.22).translate(s * 0.075, headY - 0.068, headR * 0.84));
  }

  // cap: dome + brim + emblem disc
  parts.add('cap', hemisphere(headR * 1.05, HEAD_W, 5).translate(0, capY, 0.02));
  parts.add('cap', box(headR * 1.9, 0.09, 0.12).translate(0, capY + 0.01, -headR * 0.72));
  parts.add(
    'cap',
    taperedBox({ w: 0.23, h: 0.035 }, { w: 0.30, h: 0.045 }, 0.20).rotateX(-0.13).translate(0, capY - 0.005, headR * 1.02),
  );
  parts.add('accent', surfaceSpot(headR * 0.34, headR * 1.05, [0, capY, 0.02], [0, 0.42, 1], 10));

  addArms(arms, { sleeve: 'shirt', hand: 'accent', shoulderX: bodyW / 2 + 0.01, shoulderY, r: 0.05, handR: 0.078 });
}

// --- princess (Peach) --------------------------------------------------------
function buildPrincess(parts: Parts, arms: Parts) {
  // Bell gown as a lathe: 5 profile points x 12 segments = 96 tris and it
  // reads far better than a cone (the flare at the hem is the whole shape).
  const profile = [
    new THREE.Vector2(0.13, 0),
    new THREE.Vector2(0.31, 0.04),
    new THREE.Vector2(0.275, 0.17),
    new THREE.Vector2(0.20, 0.33),
    new THREE.Vector2(0.155, 0.45),
  ];
  parts.add('overalls', new THREE.LatheGeometry(profile, 12));
  parts.add('accent', cyl(0.315, 0.30, 0.055, 12).translate(0, 0.04, 0)); // white hem

  // bodice + collar
  parts.add('shirt', cyl(0.135, 0.16, 0.20, 10).translate(0, 0.53, 0));
  parts.add('accent', cyl(0.145, 0.145, 0.035, 10).translate(0, 0.63, 0));
  parts.add('trim', disc(0.038, 8).translate(0, 0.58, 0.135));
  parts.add('skin', cyl(0.06, 0.06, 0.08, 8).translate(0, 0.67, 0));

  // head + long blonde hair
  const headY = 0.80;
  parts.add('skin', sphere(0.20, HEAD_W, HEAD_H).translate(0, headY, 0.01));
  parts.add('hair', hemisphere(0.212, HEAD_W, 5).scale(1, 0.92, 1).translate(0, headY + 0.01, 0.01));
  parts.add('hair', box(0.30, 0.11, 0.13).rotateX(0.18).translate(0, headY + 0.115, 0.115));
  for (const s of [-1, 1]) {
    parts.add('hair', box(0.13, 0.46, 0.13).translate(s * 0.14, headY - 0.20, -0.095));
    parts.add('trim', sphere(0.032, TINY_W, TINY_H).translate(s * 0.195, headY - 0.03, -0.01));
  }
  parts.add('hair', box(0.22, 0.44, 0.11).translate(0, headY - 0.22, -0.15));
  addEyes(parts, { x: 0.07, y: headY + 0.035, z: 0.165, r: 0.052, sz: 0.72, pupilR: 0.028 });
  for (const s of [-1, 1]) {
    parts.add('pupil', box(0.05, 0.018, 0.03).rotateZ(s * 0.35).translate(s * 0.095, headY + 0.10, 0.155));
  }
  parts.add('overalls', box(0.06, 0.025, 0.04).translate(0, headY - 0.10, 0.185));

  // crown
  parts.add('cap', cyl(0.09, 0.105, 0.06, 10).translate(0, headY + 0.22, 0));
  parts.add('cap', cyl(0.10, 0.10, 0.025, 10).translate(0, headY + 0.185, 0));
  parts.add('gem', sphere(0.03, TINY_W, TINY_H).translate(0, headY + 0.26, 0.075));
  parts.add('trim', sphere(0.028, TINY_W, TINY_H).translate(0, headY + 0.265, 0.06));
  for (const s of [-1, 1]) {
    parts.add('trim', sphere(0.026, TINY_W, TINY_H).translate(s * 0.07, headY + 0.26, -0.02));
  }

  // elbow-length white gloves
  addArms(arms, { sleeve: 'accent', hand: 'accent', shoulderX: 0.155, shoulderY: 0.60, r: 0.05, handR: 0.072 });
  for (const s of [-1, 1]) {
    parts.add('shirt', sphere(0.075, SMALL_W, SMALL_H).translate(s * 0.15, 0.615, 0.01));
  }
}

// --- dino (Yoshi) ------------------------------------------------------------
// `skin` is the white belly here, `shirt` the green hide, `overalls` the
// saddle, `hair` the back spikes (see registry.ts).
function buildDino(parts: Parts, arms: Parts) {
  parts.add('shirt', sphere(0.30, HEAD_W, HEAD_H).scale(1, 1.02, 1.06).translate(0, 0.22, 0));
  parts.add('skin', sphere(0.235, BODY_W, BODY_H).scale(0.92, 0.95, 0.62).translate(0, 0.17, 0.19));

  // orange saddle over the back, with side straps
  parts.add('overalls', box(0.36, 0.10, 0.32).translate(0, 0.45, -0.02));
  for (const s of [-1, 1]) {
    parts.add('overalls', box(0.06, 0.22, 0.24).translate(s * 0.20, 0.33, -0.02));
  }

  parts.add('shirt', cyl(0.12, 0.155, 0.22, 8).translate(0, 0.56, -0.02));

  const headY = 0.74;
  parts.add('shirt', sphere(0.215, HEAD_W, HEAD_H).translate(0, headY, 0));
  parts.add('shirt', sphere(0.165, BODY_W, BODY_H).scale(1, 0.86, 1.5).translate(0, headY - 0.04, 0.22));
  for (const s of [-1, 1]) {
    parts.add('pupil', sphere(0.028, TINY_W, TINY_H).translate(s * 0.055, headY + 0.01, 0.44));
  }
  // eyes ON TOP of the head — the single most Yoshi-defining detail
  addEyes(parts, { x: 0.098, y: headY + 0.17, z: 0.05, r: 0.095, sx: 0.85, sy: 1.15, sz: 0.85, pupilR: 0.042, pupilOut: 0.02 });
  // cheeks + nostrils' bridge keep the snout from reading as a tube
  parts.add('shirt', sphere(0.075, SMALL_W, SMALL_H).translate(0, headY + 0.03, 0.10));

  // back spikes, marching down the spine
  const spikes: [number, number, number][] = [
    [0.62, -0.19, 0.055],
    [0.51, -0.26, 0.05],
    [0.40, -0.30, 0.045],
  ];
  for (const [y, z, r] of spikes) {
    parts.add('hair', limb([0, y, z], [0, y + 0.05, z - 0.13], r, 0.006, 6));
  }
  for (const s of [-1, 1]) {
    parts.add('hair', limb([s * 0.06, headY + 0.14, -0.14], [s * 0.09, headY + 0.20, -0.24], 0.04, 0.006, 6));
  }

  // legs into orange boots
  for (const s of [-1, 1]) {
    parts.add('shirt', limb([s * 0.14, 0.10, 0.06], [s * 0.15, 0.07, 0.30], 0.075, 0.065, 6));
    parts.add('accent', box(0.17, 0.12, 0.26).translate(s * 0.15, 0.03, 0.38));
  }

  addArms(arms, { sleeve: 'shirt', hand: 'shirt', shoulderX: 0.26, shoulderY: 0.36, r: 0.065, handR: 0.08 });
}

// --- toad --------------------------------------------------------------------
function buildToad(parts: Parts, arms: Parts) {
  // stubby body in a blue vest with a yellow trim band
  parts.add('shirt', box(0.36, 0.28, 0.30).translate(0, 0.14, 0.01));
  for (const s of [-1, 1]) {
    parts.add('overalls', box(0.10, 0.26, 0.32).translate(s * 0.145, 0.14, 0.01));
    parts.add('shirt', sphere(0.085, SMALL_W, SMALL_H).translate(s * 0.19, 0.26, 0.01));
    parts.add('overalls', box(0.13, 0.13, 0.30).translate(s * 0.11, 0.03, 0.22));
    parts.add('dark', box(0.14, 0.09, 0.16).translate(s * 0.11, 0.01, 0.40));
  }
  parts.add('overalls', box(0.36, 0.26, 0.09).translate(0, 0.14, -0.12));
  parts.add('trim', box(0.38, 0.045, 0.32).translate(0, 0.275, 0.01));

  // face + the oversized mushroom cap
  const headY = 0.44;
  parts.add('skin', sphere(0.20, HEAD_W, HEAD_H).translate(0, headY, 0.02));
  addEyes(parts, { x: 0.088, y: headY + 0.01, z: 0.16, r: 0.08, sx: 0.8, sy: 1.35, sz: 0.6, pupilR: 0.046, pupilOut: 0.02 });
  parts.add('pupil', box(0.07, 0.02, 0.03).translate(0, headY - 0.10, 0.185));

  const capY = headY + 0.08;
  const capR = 0.36;
  parts.add('cap', hemisphere(capR, HEAD_W, 6).translate(0, capY, 0));
  parts.add('cap', cyl(capR, capR * 0.82, 0.10, 12).translate(0, capY - 0.05, 0));
  // 5 red spots sitting 4mm proud of the dome (surfaceSpot orients them)
  const spots: [number, number, number][] = [
    [0, 0.5, 0.87],
    [0.85, 0.45, 0.28],
    [-0.85, 0.45, 0.28],
    [0.5, 0.66, -0.56],
    [-0.5, 0.66, -0.56],
  ];
  for (const dir of spots) parts.add('hair', surfaceSpot(0.105, capR, [0, capY, 0], dir, 8));

  addArms(arms, { sleeve: 'shirt', hand: 'shirt', shoulderX: 0.20, shoulderY: 0.27, r: 0.058, handR: 0.075 });
}

// --- koopa (Bowser) ----------------------------------------------------------
function buildKoopa(parts: Parts, arms: Parts) {
  // Torso gets the cheaper sphere: the belly plate, shell, arms and cuffs
  // cover most of it, and Bowser is the tris-heaviest racer by a distance.
  parts.add('skin', sphere(0.34, BODY_W, BODY_H).scale(1.24, 1, 0.92).translate(0, 0.32, 0.02));
  parts.add('shirt', sphere(0.27, BODY_W, BODY_H).scale(1.05, 0.95, 0.6).translate(0, 0.26, 0.19));

  // green shell on the back: hemisphere domed toward -Z, ringed and spiked
  const shellC: [number, number, number] = [0, 0.50, -0.19];
  const shellR = 0.35;
  parts.add('cap', hemisphere(shellR, HEAD_W, 5).rotateX(-Math.PI / 2).translate(...shellC));
  parts.add('overalls', cyl(shellR * 0.98, shellR * 0.98, 0.06, 12).rotateX(Math.PI / 2).translate(0, 0.50, -0.17));
  const shellSpikes: [number, number, number][] = [
    [0.62, 0.42, -0.66],
    [-0.62, 0.42, -0.66],
    [0.34, -0.5, -0.79],
    [-0.34, -0.5, -0.79],
  ];
  for (const d of shellSpikes) {
    const n = Math.hypot(d[0], d[1], d[2]);
    const base: [number, number, number] = [shellC[0] + (d[0] / n) * shellR * 0.9, shellC[1] + (d[1] / n) * shellR * 0.9, shellC[2] + (d[2] / n) * shellR * 0.9];
    const tip: [number, number, number] = [shellC[0] + (d[0] / n) * shellR * 1.35, shellC[1] + (d[1] / n) * shellR * 1.35, shellC[2] + (d[2] / n) * shellR * 1.35];
    parts.add('accent', limb(base, tip, 0.075, 0.008, 6));
  }

  // head: heavy snout, horns, brows, red hair tuft
  const headY = 0.82;
  parts.add('skin', sphere(0.245, HEAD_W, HEAD_H).translate(0, headY, 0));
  parts.add('skin', sphere(0.185, BODY_W, BODY_H).scale(1.15, 0.85, 1.35).translate(0, headY - 0.05, 0.19));
  for (const s of [-1, 1]) {
    parts.add('pupil', sphere(0.03, TINY_W, TINY_H).translate(s * 0.062, headY - 0.02, 0.36));
    parts.add('accent', limb([s * 0.17, headY + 0.10, 0.01], [s * 0.25, headY + 0.25, -0.02], 0.055, 0.008, 6));
    parts.add('hair', box(0.11, 0.04, 0.06).rotateZ(s * 0.34).translate(s * 0.088, headY + 0.10, 0.16));
    parts.add('accent', limb([s * 0.07, headY - 0.10, 0.30], [s * 0.07, headY - 0.04, 0.31], 0.022, 0.004, 5));
  }
  parts.add('pupil', box(0.26, 0.035, 0.10).translate(0, headY - 0.115, 0.28));
  addEyes(parts, { x: 0.092, y: headY + 0.045, z: 0.175, r: 0.058, sx: 0.9, sy: 1, sz: 0.75, pupilR: 0.03 });
  parts.add('hair', limb([0, headY + 0.16, -0.02], [0, headY + 0.33, -0.11], 0.095, 0.01, 6));
  for (const s of [-1, 1]) {
    parts.add('hair', limb([s * 0.11, headY + 0.14, -0.05], [s * 0.17, headY + 0.27, -0.14], 0.06, 0.01, 6));
  }

  // spiked shoulder cuffs + heavy legs
  for (const s of [-1, 1]) {
    parts.add('overalls', sphere(0.10, TINY_W, TINY_H).translate(s * 0.33, 0.46, 0.02));
    parts.add('accent', limb([s * 0.36, 0.52, 0.02], [s * 0.44, 0.63, 0.02], 0.045, 0.006, 6));
    parts.add('skin', limb([s * 0.16, 0.12, 0.10], [s * 0.17, 0.08, 0.36], 0.10, 0.085, 6));
    parts.add('overalls', box(0.18, 0.12, 0.22).translate(s * 0.17, 0.04, 0.46));
  }

  addArms(arms, { sleeve: 'skin', hand: 'skin', shoulderX: 0.32, shoulderY: 0.44, r: 0.085, handR: 0.095 });
  for (const s of [-1, 1]) {
    parts.add('overalls', sphere(0.085, TINY_W, TINY_H).translate(s * 0.165, 0.31, 0.35));
  }
}

// Builds the procedural driver for `def`, sized to sit on the kart's seat
// anchor. Tagged `userData.disposable` — SceneBuilder.setDriver's disposal
// contract depends on it (GLB-sourced drivers share cached geometry and must
// NOT be disposed; these are per-kart and must be). `userData.armPivot` hands
// the arm-roll group back to setDriver without changing this function's
// return type.
export function buildCharacterModel(def: CharacterDef): THREE.Group {
  const root = new THREE.Group();
  root.userData.disposable = true;

  const palette = paletteFor(def.driver);
  const parts = new PartAssembler<Palette>(palette);
  const armParts = new PartAssembler<Palette>(palette);
  const armPivot = new THREE.Group();
  armPivot.position.y = ARM_PIVOT_Y;

  switch (def.driver.kind) {
    case 'plumber':
      buildPlumber(parts, armParts, def);
      break;
    case 'princess':
      buildPrincess(parts, armParts);
      break;
    case 'dino':
      buildDino(parts, armParts);
      break;
    case 'toad':
      buildToad(parts, armParts);
      break;
    case 'koopa':
      buildKoopa(parts, armParts);
      break;
  }

  parts.build(root, { name: 'driver-body' });
  // Arms are authored in the same seat-local space as the body, so the pivot's
  // own height is subtracted out here rather than at every call site.
  armParts.build(armPivot, { origin: [0, ARM_PIVOT_Y, 0], name: 'driver-arms' });
  root.add(armPivot);
  const rig: DriverRig = { armPivot };
  root.userData.rig = rig;
  return root;
}

// The procedural driver's animation hook: the arm-roll group, turned with the
// steering wheel. A mounted GLB has no such node (SceneBuilder keeps
// `visual.rig` null for it and only the kart's own steering wheel turns).
export interface DriverRig {
  armPivot: THREE.Object3D;
}

// Kept out of buildCharacterModel so SceneBuilder doesn't have to know the
// userData key.
export function driverRigOf(root: THREE.Object3D): DriverRig | null {
  const rig = root.userData.rig as DriverRig | undefined;
  return rig ?? null;
}

// The arms only need a hint of the steering wheel's roll (same sign convention
// as SceneBuilder's STEER_WHEEL_SCALE).
const STEER_ARM_SCALE = -0.22;

// Per-frame driver animation, called from updateKartVisual: one scalar write,
// allocation-free.
export function animateDriver(rig: DriverRig, steer: number): void {
  rig.armPivot.rotation.z = steer * STEER_ARM_SCALE;
}
