// §v3 Track C — in-world item feedback.
//
// Everything here is *visual only*: no class in this file is allowed to touch
// KartState or any ItemSystem object. State advances on `renderDt` from
// main.ts's render callback, never on the physics tick, and nothing allocates
// per frame (the karts' six markers/star rings are built once at startup and
// toggled with `.visible`, exactly like DriftSparks' pooled particle buffer).
//
// The pieces, in the order the user meets them:
//  1. HeldItemMarkers — a billboard sprite floating over EVERY kart holding an
//     item, AI included, so the threat behind you is legible before it fires.
//  2. SpinStars       — three stars orbiting a spun-out kart's head. Per the
//     spec this is the single biggest readability win for items, so it is
//     deliberately the loudest thing in the file.
//  3. BoostFlare      — twin exhaust cones behind a boosting kart.
//  4. ItemTrail       — one pooled THREE.Points system shared by every shell,
//     so the trail costs one draw call no matter how many are in flight.
import * as THREE from 'three';
import type { ItemType } from '../items/ItemSystem';

// --- shared canvas-texture helpers ------------------------------------------
// Same procedural-canvas approach as render/textures.ts: no image files, so a
// clone of the repo with zero assets still shows every cue (the "playable with
// zero GLBs" rule applies to item feedback too).
function makeCanvas(size: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return { canvas, ctx: canvas.getContext('2d')! };
}

// A translucent dark disc behind every glyph. Without it a yellow banana over
// a sunlit grass verge is invisible, and these markers have to read against
// sky, asphalt and grass alike at split-screen size.
function drawBacking(ctx: CanvasRenderingContext2D, size: number) {
  ctx.fillStyle = 'rgba(12,14,18,0.55)';
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size * 0.45, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = size * 0.045;
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.stroke();
}

// Deliberately drawn as shapes rather than emoji glyphs: emoji rasterise at
// wildly different sizes/colours per platform font, and these textures are
// baked once at startup, so a bad glyph would be permanent.
function drawItemGlyph(ctx: CanvasRenderingContext2D, size: number, item: ItemType) {
  const c = size / 2;
  if (item === 'mushroom' || item === 'goldenMushroom') {
    ctx.fillStyle = '#f4f0e6'; // stem
    ctx.fillRect(c - size * 0.13, c, size * 0.26, size * 0.24);
    ctx.fillStyle = item === 'goldenMushroom' ? '#ffca32' : '#e74c3c'; // cap
    ctx.beginPath();
    ctx.arc(c, c + size * 0.02, size * 0.29, Math.PI, 0);
    ctx.fill();
    ctx.fillStyle = '#fdfaf3'; // spots
    for (const [dx, dy, r] of [
      [-0.15, -0.07, 0.06],
      [0.14, -0.06, 0.055],
      [0.0, -0.16, 0.05],
    ]) {
      ctx.beginPath();
      ctx.arc(c + dx * size, c + dy * size, r * size, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (item === 'banana' || item === 'tripleBanana') {
    // Crescent: a filled arc band, thick enough to survive at 20px on screen.
    ctx.strokeStyle = '#f5d327';
    ctx.lineCap = 'round';
    ctx.lineWidth = size * 0.15;
    ctx.beginPath();
    ctx.arc(c + size * 0.08, c, size * 0.27, Math.PI * 0.35, Math.PI * 1.25);
    ctx.stroke();
    if (item === 'tripleBanana') {
      ctx.font = 'bold 34px sans-serif'; ctx.fillStyle = '#fff'; ctx.fillText('3', size * 0.58, size * 0.76);
    }
    ctx.strokeStyle = '#6b4f16'; // stalk
    ctx.lineWidth = size * 0.06;
    ctx.beginPath();
    ctx.moveTo(c - size * 0.13, c - size * 0.21);
    ctx.lineTo(c - size * 0.19, c - size * 0.3);
    ctx.stroke();
  } else {
    ctx.fillStyle = '#2ecc71'; // dome
    ctx.beginPath();
    ctx.arc(c, c + size * 0.09, size * 0.28, Math.PI, 0);
    ctx.fill();
    ctx.fillStyle = '#1e8449'; // shell segment lines read as a shell, not a ball
    for (const dx of [-0.14, 0.14]) {
      ctx.fillRect(c + dx * size - size * 0.015, c - size * 0.14, size * 0.03, size * 0.22);
    }
    // Plain rects/arcs only in this file — CanvasRenderingContext2D.roundRect
    // is recent enough (Safari 16 / Firefox 112) that a miss would throw at
    // module init and take the whole game down for a 6px corner radius.
    ctx.fillStyle = '#f4f0e6'; // rim
    ctx.fillRect(c - size * 0.3, c + size * 0.08, size * 0.6, size * 0.13);
  }
}

function buildItemTexture(item: ItemType): THREE.CanvasTexture {
  const size = 128;
  const { canvas, ctx } = makeCanvas(size);
  drawBacking(ctx, size);
  drawItemGlyph(ctx, size, item);
  return new THREE.CanvasTexture(canvas);
}

function buildStarTexture(): THREE.CanvasTexture {
  const size = 64;
  const { canvas, ctx } = makeCanvas(size);
  const c = size / 2;
  const outer = size * 0.46;
  const inner = outer * 0.44;
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const x = c + Math.cos(a) * r;
    const y = c + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = '#ffe14d';
  ctx.fill();
  ctx.lineWidth = size * 0.05;
  ctx.strokeStyle = '#e8a600';
  ctx.stroke();
  return new THREE.CanvasTexture(canvas);
}

// --- 1. floating "I have an item" markers ------------------------------------

const MARKER_HEIGHT = 1.95; // metres above kart.pos (the tyre contact patch), i.e. ~0.3m clear of the tallest driver's head
const MARKER_SCALE = 0.62;
const MARKER_BOB = 0.09;
const MARKER_BOB_RATE = 2.2; // rad/s
const MARKER_SPIN_RATE = 0.7; // rad/s of material.rotation — a slow, non-distracting turn

// One sprite per kart entity, created once and toggled with `.visible`; three
// cached textures and three materials shared across all of them. Sprite spin
// lives on `material.rotation`, which three.js reads per *material*, so every
// marker of a given item type turns in lockstep — intended (spec: "one
// material per item type"), and it keeps this to 3 material writes a frame.
export class HeldItemMarkers {
  private materials: Record<ItemType, THREE.SpriteMaterial>;
  private materialList: THREE.SpriteMaterial[];
  private sprites: THREE.Sprite[] = [];
  private t = 0;

  constructor(scene: THREE.Scene, count: number) {
    const make = (item: ItemType) =>
      new THREE.SpriteMaterial({
        map: buildItemTexture(item),
        transparent: true,
        // depthWrite off so overlapping markers don't punch holes in each
        // other; depthTest left ON so a marker is properly hidden by terrain
        // or by a kart in front of it.
        depthWrite: false,
      });
    this.materials = { mushroom: make('mushroom'), banana: make('banana'), shell: make('shell'), goldenMushroom: make('goldenMushroom'), tripleBanana: make('tripleBanana') };
    this.materialList = Object.values(this.materials);
    for (let i = 0; i < count; i++) {
      const sprite = new THREE.Sprite(this.materials.mushroom);
      sprite.scale.setScalar(MARKER_SCALE);
      sprite.visible = false;
      scene.add(sprite);
      this.sprites.push(sprite);
    }
  }

  tick(dt: number) {
    this.t += dt;
    const rotation = this.t * MARKER_SPIN_RATE;
    for (const mat of this.materialList) mat.rotation = rotation;
  }

  // `item === null` (or a spinning kart, whose stars say everything the marker
  // would) hides this entity's marker. `pos` is the kart's world position;
  // MARKER_HEIGHT is added on top of it, so the marker follows track elevation
  // for free.
  set(index: number, item: ItemType | null, pos: THREE.Vector3) {
    const sprite = this.sprites[index];
    if (!item) {
      sprite.visible = false;
      return;
    }
    const mat = this.materials[item];
    if (sprite.material !== mat) sprite.material = mat;
    sprite.visible = true;
    sprite.position.set(
      pos.x,
      pos.y + MARKER_HEIGHT + Math.sin(this.t * MARKER_BOB_RATE + index * 1.7) * MARKER_BOB,
      pos.z,
    );
  }
}

// --- 2. spin-out stars --------------------------------------------------------

const STAR_COUNT = 3;
const STAR_HEIGHT = 1.62;
const STAR_ORBIT_RADIUS = 0.6;
const STAR_SCALE = 0.34;
const STAR_ORBIT_RATE = 7; // rad/s — fast enough to read as "dazed" at split-screen size

// Three stars per entity, pooled the same way as the markers. One shared
// texture/material for all 18 sprites; the orbit is pure position maths.
export class SpinStars {
  private material: THREE.SpriteMaterial;
  private sprites: THREE.Sprite[][] = [];
  private t = 0;

  constructor(scene: THREE.Scene, count: number) {
    this.material = new THREE.SpriteMaterial({ map: buildStarTexture(), transparent: true, depthWrite: false });
    for (let i = 0; i < count; i++) {
      const ring: THREE.Sprite[] = [];
      for (let k = 0; k < STAR_COUNT; k++) {
        const sprite = new THREE.Sprite(this.material);
        sprite.scale.setScalar(STAR_SCALE);
        sprite.visible = false;
        scene.add(sprite);
        ring.push(sprite);
      }
      this.sprites.push(ring);
    }
  }

  tick(dt: number) {
    this.t += dt;
  }

  // `spinTimer` is read, never written — the physics spin-out is untouched.
  // The ring fades out with the timer by shrinking (a shared material can't
  // carry per-sprite opacity), which also stops the stars from popping out of
  // existence the instant control returns.
  set(index: number, spinTimer: number, pos: THREE.Vector3) {
    const ring = this.sprites[index];
    if (spinTimer <= 0) {
      for (const sprite of ring) sprite.visible = false;
      return;
    }
    // spinTimer runs 1 -> 0 over SPIN_OUT_SECONDS; scale in quickly, then let
    // the last ~0.3s shrink them away.
    const scale = STAR_SCALE * Math.min(1, spinTimer * 3.3);
    for (let k = 0; k < STAR_COUNT; k++) {
      const sprite = ring[k];
      const a = this.t * STAR_ORBIT_RATE + (k * Math.PI * 2) / STAR_COUNT;
      sprite.visible = true;
      sprite.scale.setScalar(scale);
      sprite.position.set(
        pos.x + Math.cos(a) * STAR_ORBIT_RADIUS,
        pos.y + STAR_HEIGHT + Math.sin(a * 2) * 0.07,
        pos.z + Math.sin(a) * STAR_ORBIT_RADIUS,
      );
    }
  }
}

// --- 3. boost flare -----------------------------------------------------------

const FLARE_LENGTH = 0.55;
// The widest exhaust count across the six KartBuilder profiles (`heavy` has
// four stacks; `slim`/`mini` have one). The flare pools this many cone PAIRS
// once and hides the surplus, so a mid-lobby character re-pick never has to
// rebuild geometry — §v3 Track C review fix, see updateBoostFlare.
const FLARE_MAX_EXHAUSTS = 4;

export interface BoostFlare {
  group: THREE.Group;
  materials: THREE.MeshBasicMaterial[];
  // Two per pooled exhaust slot, interleaved [outer0, inner0, outer1, inner1…],
  // so slot `s` is meshes[s * 2] and meshes[s * 2 + 1].
  meshes: THREE.Mesh[];
}

// Two nested cones per exhaust stack (orange outer, yellow inner), apex
// trailing behind the kart. The cones are authored so their BASE sits on the
// group origin and the apex reaches back to -FLARE_LENGTH, which lets the
// caller park the group exactly on the current chassis' tail plane (see
// updateBoostFlare's `tailZ`/`tailY` — the six profiles' tails differ by 0.22m
// in z and 0.16m in y, enough that one hard-coded offset would leave a gap
// behind Toad's mini and bury the flame inside Bowser's heavy).
//
// §v3 Track C review fix: the x offsets used to be hard-coded to ±0.2, which
// only ever matched `standard`/`royal`. Luigi's slim and Toad's mini have a
// single centreline stack (`exhausts: [0]`) and Bowser's heavy has four, so
// those karts emitted flame from blank bodywork with nothing coming out of the
// actual pipe. The x is now taken from the chassis' own `exhausts` array every
// frame, for exactly the reason `rearZ`/`exhaustY` were published in the first
// place.
//
// Parented by the caller to the kart ROOT group so they inherit heading, slope
// pitch and the mushroom squash/stretch — but not the drift-lean roll, which
// belongs to `body` and would swing the flames off the exhausts. Materials are
// per-kart instances (never shared across karts, matching the chassis tint
// rule); one outer + one inner per flare is enough because the flicker is
// animated on the meshes' scale, not on any material property.
export function buildBoostFlare(): BoostFlare {
  const group = new THREE.Group();
  const makeMaterial = (color: number, opacity: number) =>
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide, // open-ended cones are visible from behind too
    });
  const outerMat = makeMaterial(0xff8c1a, 0.55);
  const innerMat = makeMaterial(0xffe680, 0.85);
  const meshes: THREE.Mesh[] = [];
  for (let s = 0; s < FLARE_MAX_EXHAUSTS; s++) {
    for (const [radius, mat] of [
      [0.15, outerMat],
      [0.08, innerMat],
    ] as const) {
      // ConeGeometry points up (+Y); rotateX(-PI/2) sends the apex to -Z, i.e.
      // streaming out behind the kart (local +Z is the nose, see KartBuilder).
      const geo = new THREE.ConeGeometry(radius, FLARE_LENGTH, 8, 1, true).rotateX(-Math.PI / 2);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(0, 0, -FLARE_LENGTH / 2); // base on the group origin, apex at -FLARE_LENGTH
      mesh.visible = false; // updateBoostFlare shows only the slots this chassis actually has
      group.add(mesh);
      meshes.push(mesh);
    }
  }
  group.visible = false;
  return { group, materials: [outerMat, innerMat], meshes };
}

// Visible only while `boostTimer > 0`; `t` is a monotonically increasing
// seconds accumulator supplying the flicker. `tailZ`/`tailY`/`exhausts` come
// from the kart's CURRENT chassis (KartChassis.rearZ/exhaustY/exhausts),
// re-read every frame so a mid-lobby character re-pick — which swaps the whole
// chassis out from under this flare — repositions it for free. Scalar writes
// only, no allocation.
export function updateBoostFlare(
  flare: BoostFlare,
  boostTimer: number,
  t: number,
  tailZ: number,
  tailY: number,
  exhausts: readonly number[],
) {
  if (boostTimer <= 0) {
    if (flare.group.visible) flare.group.visible = false;
    return;
  }
  flare.group.visible = true;
  flare.group.position.set(0, tailY, tailZ);
  // Two out-of-phase sines instead of Math.random(): a random flicker at 120fps
  // strobes, whereas this reads as a steady flame at any frame rate.
  const flickA = 0.8 + Math.sin(t * 37) * 0.2;
  const flickB = 0.85 + Math.sin(t * 53 + 1.7) * 0.15;
  // The flame shortens as the boost runs out, so the tail telegraphs how much
  // boost is left on the kart you're chasing.
  const fade = Math.min(1, boostTimer * 4);
  const slots = Math.min(exhausts.length, FLARE_MAX_EXHAUSTS);
  for (let i = 0; i < flare.meshes.length; i++) {
    const mesh = flare.meshes[i];
    const slot = i >> 1;
    if (slot >= slots) {
      if (mesh.visible) mesh.visible = false; // surplus pooled cone for this chassis
      continue;
    }
    mesh.visible = true;
    mesh.position.x = exhausts[slot]; // the stack this plume belongs to
    const flick = i % 2 === 0 ? flickA : flickB;
    const lengthScale = fade * (0.9 + flick * 0.1);
    mesh.scale.set(flick, flick, lengthScale);
    // A cone scales about its own centre, so shrinking z alone would pull the
    // flame's BASE backwards off the bumper and leave a gap. Re-centring it
    // keeps the base pinned to the group origin (= the chassis tail) at every
    // length.
    mesh.position.z = (-FLARE_LENGTH * lengthScale) / 2;
  }
}

export function disposeBoostFlare(flare: BoostFlare) {
  for (const mesh of flare.meshes) mesh.geometry.dispose();
  for (const mat of flare.materials) mat.dispose();
}

// --- 4. pooled shell trail ----------------------------------------------------

const TRAIL_MAX = 96;
const TRAIL_LIFETIME = 0.35;
const TRAIL_SIZE = 0.5;
const TRAIL_OFFSCREEN_Y = -1000;

// Modelled on DriftSparks: one THREE.Points buffer, a ring cursor, no
// allocation after construction, one draw call for every shell in flight.
// Additive blending means "fade out" is just "fade the vertex colour to
// black", which a PointsMaterial can do per-particle where a shared
// SpriteMaterial could not.
export class ItemTrail {
  points: THREE.Points;
  private positions: Float32Array;
  private colors: Float32Array;
  private ages: Float32Array;
  private baseColors: Float32Array;
  private cursor = 0;

  constructor() {
    this.positions = new Float32Array(TRAIL_MAX * 3);
    this.colors = new Float32Array(TRAIL_MAX * 3);
    this.baseColors = new Float32Array(TRAIL_MAX * 3);
    this.ages = new Float32Array(TRAIL_MAX).fill(Infinity);
    for (let i = 0; i < TRAIL_MAX; i++) this.positions[i * 3 + 1] = TRAIL_OFFSCREEN_Y;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    this.points = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        size: TRAIL_SIZE,
        vertexColors: true,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.points.frustumCulled = false; // the buffer's bounding sphere is stale by design (particles move without a recompute)
  }

  emit(x: number, y: number, z: number, r: number, g: number, b: number) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % TRAIL_MAX;
    this.positions[i * 3] = x;
    this.positions[i * 3 + 1] = y;
    this.positions[i * 3 + 2] = z;
    this.baseColors[i * 3] = r;
    this.baseColors[i * 3 + 1] = g;
    this.baseColors[i * 3 + 2] = b;
    this.ages[i] = 0;
  }

  update(dt: number) {
    for (let i = 0; i < TRAIL_MAX; i++) {
      if (this.ages[i] === Infinity) continue;
      this.ages[i] += dt;
      if (this.ages[i] > TRAIL_LIFETIME) {
        this.ages[i] = Infinity;
        this.positions[i * 3 + 1] = TRAIL_OFFSCREEN_Y;
        this.colors[i * 3] = 0;
        this.colors[i * 3 + 1] = 0;
        this.colors[i * 3 + 2] = 0;
        continue;
      }
      const k = 1 - this.ages[i] / TRAIL_LIFETIME;
      this.colors[i * 3] = this.baseColors[i * 3] * k;
      this.colors[i * 3 + 1] = this.baseColors[i * 3 + 1] * k;
      this.colors[i * 3 + 2] = this.baseColors[i * 3 + 2] * k;
    }
    (this.points.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.points.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }

  // Race reset: drop every live particle so a restart doesn't leave the last
  // race's trail hanging in the air.
  clear() {
    for (let i = 0; i < TRAIL_MAX; i++) {
      this.ages[i] = Infinity;
      this.positions[i * 3 + 1] = TRAIL_OFFSCREEN_Y;
      this.colors[i * 3] = 0;
      this.colors[i * 3 + 1] = 0;
      this.colors[i * 3 + 2] = 0;
    }
    (this.points.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.points.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }
}
