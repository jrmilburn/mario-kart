import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { createKart } from '../src/game/physics/Kart';
import { createHeldItemState, useItem, updateBananas, type Banana, type ItemType } from '../src/game/items/ItemSystem';
import { buildBananaMesh, buildShellMesh } from '../src/game/render/SceneBuilder';
import { buildCharacterModel } from '../src/game/render/CharacterBuilder';
import { CHARACTERS } from '../src/game/characters/registry';

function fixture() {
  const kart = createKart(new THREE.Vector3(10, 2, 10));
  const held = createHeldItemState();
  const bananas: Banana[] = [];
  return { kart, held, bananas, fire(item: ItemType) {
    held.item = item;
    return useItem({ kartIndex: 0, kart, held, bananas, shells: [], targetIndex: null, fireS: 0 });
  } };
}

test('golden boost is consumed, lasts longer, and does not shorten an existing boost', () => {
  const f = fixture();
  f.fire('mushroom'); const normal = f.kart.boostTimer;
  assert.equal(f.fire('goldenMushroom'), true);
  assert.ok(f.kart.boostTimer > normal);
  assert.equal(f.held.item, null);
  f.kart.boostTimer = 9;
  f.fire('goldenMushroom'); assert.equal(f.kart.boostTimer, 9);
});

test('triple bananas fan out behind rotated karts and respect the owner cap', () => {
  const f = fixture(); f.kart.heading = Math.PI / 2;
  f.fire('banana'); const oldest = f.bananas[0];
  f.fire('tripleBanana');
  assert.equal(f.bananas.length, 3);
  assert.ok(!f.bananas.includes(oldest));
  assert.equal(new Set(f.bananas.map(b => b.pos.z)).size, 3);
  assert.ok(f.bananas.every(b => b.pos.x < f.kart.pos.x));
  assert.equal(f.held.item, null);
});

test('airborne bananas cannot hit; landed bananas hit and are removed', () => {
  const f = fixture(); f.fire('tripleBanana');
  const victim = createKart(f.bananas[1].pos);
  updateBananas(f.bananas, [victim], () => 2, 0.1, true);
  assert.equal(victim.spinTimer, 0);
  updateBananas(f.bananas, [victim], () => 2, 0.4, true);
  updateBananas(f.bananas, [victim], () => 2, 0.01, true);
  assert.ok(victim.spinTimer > 0);
  assert.equal(f.bananas.length, 2);
});

test('new item and character geometry has finite vertices and disposable materials', () => {
  const objects = [buildBananaMesh(), buildShellMesh(), ...CHARACTERS.map(buildCharacterModel)];
  for (const object of objects) {
    let triangles = 0;
    object.traverse(part => {
      if (!(part instanceof THREE.Mesh)) return;
      const pos = part.geometry.getAttribute('position');
      assert.ok(Array.from(pos.array).every(Number.isFinite));
      triangles += (part.geometry.index?.count ?? pos.count) / 3;
      part.geometry.dispose();
      const materials = Array.isArray(part.material) ? part.material : [part.material];
      materials.forEach(m => m.dispose());
    });
    assert.ok(triangles > 0 && triangles < 20000, `geometry budget: ${triangles}`);
  }
});
