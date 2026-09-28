import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { CHARACTERS, CHARACTERS_BY_ID } from '../src/game/characters/registry';
import { buildCharacterModel } from '../src/game/render/CharacterBuilder';
import { countTriangles } from '../src/game/render/PartAssembler';
import {
  buildKart,
  setDriver,
  setKartCharacter,
  setKartColor,
  triggerBoostPop,
  triggerSquash,
  updateKartVisual,
  type KartVisual,
} from '../src/game/render/SceneBuilder';
import { setOutlinesEnabled } from '../src/game/render/Outline';
import { createKart } from '../src/game/physics/Kart';

// The restored v3 roster (Mario, Luigi, Peach, Yoshi, Toad, Bowser) on the v5
// cel-shading pipeline: offline budget/structure/animation checks. No WebGL
// needed — everything here is plain BufferGeometry.

function meshes(root: THREE.Object3D, outlines: boolean): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.traverse((o) => {
    if (o instanceof THREE.Mesh && Boolean(o.userData.outline) === outlines) out.push(o);
  });
  return out;
}

function size(root: THREE.Object3D): THREE.Vector3 {
  root.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3());
}

test('roster: Mario (P1) and Luigi (P2) first, then Peach/Yoshi/Toad/Bowser, each with their own kart kind', () => {
  assert.deepEqual(
    CHARACTERS.map((c) => c.id),
    ['mario', 'luigi', 'peach', 'yoshi', 'toad', 'bowser'],
  );
  assert.deepEqual(
    CHARACTERS.map((c) => c.kart.kind),
    ['standard', 'slim', 'royal', 'buggy', 'mini', 'heavy'],
  );
  assert.deepEqual(
    CHARACTERS.map((c) => c.driver.kind),
    ['plumber', 'plumber', 'princess', 'dino', 'toad', 'koopa'],
  );
  assert.equal(new Set(CHARACTERS.map((c) => c.name)).size, 6);
  assert.equal(new Set(CHARACTERS.map((c) => c.kartColor)).size, 6);
  // Optional GLB drop-ins live under the git-ignored public/assets/.
  for (const c of CHARACTERS) assert.equal(c.modelUrl, `/assets/characters/${c.id}.glb`);
});

test('every racer builds in few draw calls, with a sensible triangle budget for 6 karts x 2 viewports', () => {
  let gridTris = 0;
  let gridHullTris = 0;
  let gridDraws = 0;
  for (const def of CHARACTERS) {
    const visual = buildKart(def);
    const tris = countTriangles(visual.group);
    const withHull = countTriangles(visual.group, { includeOutlines: true });
    const drawn = meshes(visual.group, false).length;
    const hulls = meshes(visual.group, true).length;
    console.log(`${def.name.padEnd(6)} (${def.kart.kind}): ${tris} tris (+${withHull - tris} outline), ${drawn} meshes + ${hulls} outline hulls`);
    // v3 measured 3.5k-4.9k visible tris per kart+driver in 22-26 meshes;
    // the geometry is unchanged (plus a hub cross per wheel), the meshes are
    // now merged per rigid part.
    assert.ok(tris > 3000 && tris < 5500, `${def.name} triangle budget: ${tris}`);
    assert.ok(withHull - tris <= tris, `${def.name} hull tris never exceed the visible ones`);
    assert.equal(drawn, 7, `${def.name} mesh count: ${drawn}`);
    assert.equal(hulls, 6, `${def.name}: everything but the steering wheel is outlined`);
    for (const m of meshes(visual.group, false)) {
      const pos = m.geometry.getAttribute('position');
      assert.ok(Array.from(pos.array as Float32Array).every(Number.isFinite));
      assert.ok(m.geometry.getAttribute('color'), 'vertex-coloured');
      assert.ok(m.material instanceof THREE.MeshToonMaterial, 'toon shaded');
      assert.equal(m.castShadow, true);
    }
    for (const h of meshes(visual.group, true)) assert.equal(h.castShadow, false);
    gridTris += tris;
    gridHullTris += withHull - tris;
    gridDraws += drawn + hulls;
  }
  console.log(`grid: ${gridTris} tris + ${gridHullTris} outline tris, ${gridDraws} draw calls (per viewport)`);
  // Two split-screen viewports draw this twice; keep the whole field modest.
  assert.ok(gridTris + gridHullTris < 60000, `grid budget ${gridTris + gridHullTris}`);
});

test('silhouettes: Luigi taller than Mario, Bowser the widest driver, every kart inside the physics footprint', () => {
  const mario = size(buildCharacterModel(CHARACTERS_BY_ID.mario));
  const luigi = size(buildCharacterModel(CHARACTERS_BY_ID.luigi));
  const bowser = size(buildCharacterModel(CHARACTERS_BY_ID.bowser));
  assert.ok(luigi.y > mario.y + 0.02, `Luigi reads as the tall one (${luigi.y} vs ${mario.y})`);
  for (const def of CHARACTERS) {
    if (def.id === 'bowser') continue;
    assert.ok(bowser.x > size(buildCharacterModel(def)).x, `Bowser wider than ${def.name}`);
  }
  for (const def of CHARACTERS) {
    const s = size(buildKart(def).group);
    // TUNING.kartRadius = 1.1: never wider than the collision circle; the v3
    // slim chassis (bumper + exhaust tips) is 2.49m nose to tail.
    assert.ok(s.x <= 2.2 && s.z <= 2.55, `${def.name} footprint ${s.toArray()}`);
  }
});

test('chassis publishes the boost-flare anchors per kart kind', () => {
  const stacks = CHARACTERS.map((def) => buildKart(def).chassis.exhausts.length);
  assert.deepEqual(stacks, [2, 1, 2, 2, 1, 4]);
  for (const def of CHARACTERS) {
    const c = buildKart(def).chassis;
    assert.ok(c.rearZ < -0.8 && c.exhaustY > 0.5);
  }
});

function drive(visual: KartVisual, frames: number, setup: (k: ReturnType<typeof createKart>) => void = () => {}) {
  const kart = createKart(new THREE.Vector3());
  kart.speed = 10;
  kart.steerActual = 0.5;
  setup(kart);
  for (let i = 0; i < frames; i++) updateKartVisual(visual, kart, 1 / 60);
  return kart;
}

test('animation: wheels steer + spin, drift lean on the body only, arms follow the wheel, squash/boost pop spring back to 1', () => {
  const visual = buildKart(CHARACTERS_BY_ID.mario);
  visual.group.rotation.z = 0.123; // main.ts's bank roll lives here and must survive

  triggerSquash(visual, 'land', 1);
  drive(visual, 3, (k) => {
    k.drift.phase = 'active';
    k.drift.dir = 1;
  });
  assert.ok(visual.group.scale.y < 0.95, `landing squashes (${visual.group.scale.y})`);
  assert.ok(visual.group.scale.x > 1, 'and bulges sideways');
  drive(visual, 40, (k) => {
    k.drift.phase = 'active';
    k.drift.dir = 1;
  });
  assert.deepEqual(visual.group.scale.toArray(), [1, 1, 1]);
  assert.ok(visual.body.rotation.z > 0.15, `drift lean rolls the body (${visual.body.rotation.z})`);
  assert.equal(visual.group.rotation.z, 0.123, 'group roll untouched');
  assert.notEqual(visual.chassis.frontWheelSpinners[0].rotation.x, 0);
  assert.notEqual(visual.chassis.rearWheels[0].rotation.x, 0);
  assert.notEqual(visual.frontWheelPivots[0].rotation.y, 0);
  assert.ok(visual.rig, 'procedural driver has a rig');
  assert.notEqual(visual.rig!.armPivot.rotation.z, 0, 'arms roll with the steering');
  assert.notEqual(visual.steeringWheel!.rotation.z, 0);

  triggerSquash(visual, 'takeoff');
  drive(visual, 2);
  assert.ok(visual.group.scale.y > 1.05, `takeoff stretches (${visual.group.scale.y})`);
  drive(visual, 40);
  triggerBoostPop(visual);
  drive(visual, 2);
  assert.ok(visual.group.scale.z > 1.1, `boost pop stretches forward (${visual.group.scale.z})`);
  drive(visual, 40);
  assert.deepEqual(visual.group.scale.toArray(), [1, 1, 1]);
});

test('retint only touches its own kart; outline toggle hides every hull', () => {
  const visual = buildKart(CHARACTERS_BY_ID.mario);
  const other = buildKart(CHARACTERS_BY_ID.mario);
  const colorOf = (v: KartVisual) => {
    const r = v.chassis.tint[0];
    return (r.attr.array as Float32Array)[r.start * 3 + 2];
  };
  assert.ok(visual.chassis.tint.length > 0);
  const before = colorOf(other);
  setKartColor(visual, 0x0000ff);
  assert.ok(colorOf(visual) > 0.99, 'retinted blue');
  assert.equal(colorOf(other), before, 'other kart untouched');

  setOutlinesEnabled(false);
  assert.ok(meshes(visual.group, true).every((h) => !(h.material as THREE.Material).visible));
  const late = buildKart(CHARACTERS_BY_ID.bowser);
  assert.ok(meshes(late.group, true).every((h) => !(h.material as THREE.Material).visible), 'applies to karts built later too');
  setOutlinesEnabled(true);
  assert.ok(meshes(visual.group, true).every((h) => (h.material as THREE.Material).visible));
});

test('character swap rebuilds the chassis; a GLB driver replaces the procedural one and back', () => {
  const visual = buildKart(CHARACTERS_BY_ID.mario);
  const wideBefore = size(visual.group).x;
  setKartCharacter(visual, CHARACTERS_BY_ID.bowser);
  setDriver(visual, CHARACTERS_BY_ID.bowser, null);
  assert.ok(size(visual.group).x > wideBefore, 'heavy chassis is wider than standard');
  assert.equal(visual.chassis.exhausts.length, 4);

  // Stand-in for a loaded GLB scene.
  const glb = new THREE.Group();
  glb.add(new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.8, 0.4), new THREE.MeshStandardMaterial()));
  const def = CHARACTERS_BY_ID.bowser;
  setDriver(visual, def, glb);
  assert.equal(visual.driverAnchor.children.length, 1);
  assert.equal(visual.driverAnchor.children[0], glb);
  assert.equal(visual.rig, null);
  assert.equal(glb.scale.x, def.scale);
  assert.equal(glb.rotation.y, def.rotationY);
  assert.ok((glb.children[0] as THREE.Mesh).castShadow);
  drive(visual, 2); // no rig: must not throw

  setDriver(visual, def, null);
  assert.notEqual(visual.driverAnchor.children[0], glb);
  assert.ok(visual.rig);
  // The GLB's (cache-shared) geometry is never disposed by an unmount.
  assert.ok((glb.children[0] as THREE.Mesh).geometry.getAttribute('position'));
});
