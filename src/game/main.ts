import * as THREE from 'three';
import { ArcadeEffects } from './render/ArcadeEffects';
import { CONTROLLER_ABSENT_MS, type EventName, type PlayerSlot } from '../shared/protocol';
import { GameSocket } from './net/GameSocket';
import { type ControlState } from './input/InputSource';
import { createPlayer, type Player } from './player/Player';
import { Hud } from './ui/Hud';
import { PlayerHud } from './ui/PlayerHud';
import { Diagnostics } from './ui/Diagnostics';
import { startLoop } from './core/loop';
import { createKart, driftTier, kartForward, stepKart, type KartState } from './physics/Kart';
import { resolveWallCollision, resolveKartKartCollisions } from './physics/collision';
import {
  buildLights,
  updateLightTarget,
  updateShadowBounds,
  buildKart,
  setDriver,
  setKartCharacter,
  updateKartVisual,
  buildItemBoxMesh,
  buildBananaMesh,
  buildShellMesh,
  triggerBoostPop,
  type KartVisual,
} from './render/SceneBuilder';
import {
  HeldItemMarkers,
  ItemTrail,
  SpinStars,
  buildBoostFlare,
  updateBoostFlare,
  type BoostFlare,
} from './render/ItemVisuals';
import { buildEnvironment } from './render/Environment';
import { CinematicCamera } from './render/CinematicCamera';
import { CHARACTERS, CHARACTERS_BY_ID, type CharacterDef } from './characters/registry';
import { loadCharacterModelInstance, preloadAll } from './characters/CharacterLoader';
import { buildTrack } from './track/TrackBuilder';
import { TrackQuery, sampleAtArcLength } from './track/TrackQuery';
import { GRASS_HALF, ROAD_HALF } from './track/trackData';
import { mapById } from './track/maps';
import { getSession } from './session';
import { TUNING } from './tuning';
import { LapTracker, TOTAL_LAPS, createLapProgress, type LapProgress } from './race/LapTracker';
import { RaceDirector } from './race/RaceDirector';
import { createAiState, think, type AiState } from './ai/AiDriver';
import {
  createItemBoxes,
  createHeldItemState,
  updateItemBoxes,
  tryPickupItemBox,
  updateRoulette,
  useItem,
  updateBananas,
  updateShells,
  tickAiItemDecision,
  BANANA_TOSS_PEAK,
  BANANA_TOSS_SECONDS,
  type ItemBoxState,
  type HeldItemState,
  type Banana,
  type Shell,
} from './items/ItemSystem';
import { DriftSparks } from './render/DriftSparks';
import { EngineAudio } from './audio/EngineAudio';
import { Minimap } from './ui/Minimap';
import { damp } from '../shared/mathUtils';

const NEUTRAL_CONTROL: ControlState = { steer: 0, throttle: 0, brake: 0, drift: 0, item: 0 };
const PLAYER_FINISH_DELAY_SECONDS = 1.5;
const COLLISION_HAPTIC_COOLDOWN_SECONDS = 0.3; // avoid vibration spam while wall-scraping
const GROUND_FOLLOW_RATE = 20; // §Phase 5 item 4: exponential damp rate for kart.pos.y -> track height

interface KartEntity {
  kart: KartState;
  visual: KartVisual;
  lapProgress: LapProgress;
  ai: AiState | null;
  name: string;
  spawnS: number;
  spawnLane: number;
  itemState: HeldItemState;
  prevItemInput: 0 | 1;
  colorHex: string;
  // Per-entity haptic bookkeeping (Phase 2b: up to two human entities need
  // independent cooldown/edge tracking instead of one pair of module-scope vars).
  collisionHapticCooldown: number;
  prevBoostTimer: number;
  // §v3 Track C1: rising/falling edge tracking for "this player holds an
  // item", the source of the slot-targeted 'item-ready'/'item-clear' cues that
  // light/dim the phone's ITEM button. Tracked per entity (not per player)
  // alongside prevBoostTimer for the same reason: both human seats need
  // independent edge state.
  prevHasItem: boolean;
  // §v3 Track C2: the boost flare cones, parented to visual.group at build
  // time so they inherit heading/pitch/squash but not the drift-lean roll.
  boostFlare: BoostFlare;
  // §Phase 5 item 5: local track grade at this kart's position, refreshed by
  // the ground-follow step each physics tick and consumed by updateKartVisual
  // in the render loop -- reuses that tick's groundHeightAt query instead of
  // taking a second one just for the pitch visual.
  grade: number;
  // §Phase 3: which character this entity currently shows. `driverRequestId`
  // guards the async model load in loadDriverFor — bumped on every
  // applyCharacterToEntity call so a slow-resolving load for a character this
  // entity no longer shows can't clobber a newer selection.
  characterId: string;
  driverRequestId: number;
}

const app = document.getElementById('app')!;

const scene = new THREE.Scene();

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
// §Phase 4 finding #2: split-screen calls renderer.render() twice per frame;
// autoUpdate (default true) would redo the whole shadow pass on both calls
// even though the shadow-casting scene hasn't changed between them. Driven
// manually instead — needsUpdate is set once per frame, just before the first
// render call, so exactly one shadow pass covers both viewports.
renderer.shadowMap.autoUpdate = false;
app.appendChild(renderer.domElement);

// §v4: what the start menu chose (entry.ts wrote it before importing this
// module — see session.ts for why that indirection exists). Everything below
// is built for this map and this number of seats, once.
const session = getSession();
const activeMap = mapById(session.mapId);
console.log(`[main] starting ${activeMap.name} (${activeMap.style}) in ${session.mode}-player mode`);

const lights = buildLights(scene, activeMap.style);

// §v3 Track A: the track (and its TrackQuery) must exist *before* the
// environment now — buildEnvironment's ground is no longer a flat plane, it's
// a heightfield draped over the circuit's own elevation, so it needs to query
// track heights while it builds. scene.background/fog assignment inside
// buildEnvironment is order-independent, so nothing else cares about the swap.
const track = buildTrack(activeMap);
scene.add(track.group);
const trackQuery = new TrackQuery(track.samples, track.totalLength, activeMap.surfaceZones);

// §Phase 4 item 2: sky dome, mountains, clouds, fog, ground (§v3 Track A:
// terrain heightfield). §v4: or, on a 'space' map, a starfield and no ground at all.
const environment = buildEnvironment(scene, trackQuery, activeMap.style);

// Staggered 2-2-2 grid start (Phase 2b grows this from 1-2-2 to fit a second
// human-capable kart), spaced so no pair starts closer than 2*kartRadius:
// P1/P2 side by side at the line, then two rows of two AI further back.
// `humanSlot` marks entities 0-1 as human-capable; entity 1 falls back to AI
// whenever P2 isn't active (roster locked at countdown, see lockRoster below).
// `charIndex` is the default CHARACTERS[] slot (§Phase 3: P1=mario, P2=luigi,
// AI get the rest) — overridden live by character-select picks / the
// countdown AI reassignment in lockRoster.
const GRID: { name: string; charIndex: number; s: number; lane: number; humanSlot?: PlayerSlot }[] = [
  { name: 'P1', charIndex: 0, s: 0, lane: -1.2, humanSlot: 0 },
  { name: 'P2', charIndex: 1, s: 0, lane: 1.2, humanSlot: 1 },
  { name: 'AI 1', charIndex: 2, s: -4, lane: -2 },
  { name: 'AI 2', charIndex: 3, s: -4, lane: 0.7 },
  { name: 'AI 3', charIndex: 4, s: -8, lane: 2 },
  { name: 'AI 4', charIndex: 5, s: -8, lane: -0.7 },
];

function spawnPose(sOffset: number, lane: number): { pos: THREE.Vector3; heading: number } {
  const sample = sampleAtArcLength(track.samples, track.totalLength, sOffset);
  const pos = sample.pos.clone().addScaledVector(sample.right, lane);
  const heading = Math.atan2(sample.forward.x, sample.forward.z);
  return { pos, heading };
}

// §Phase 3: kicks off every character's GLB load up front, non-blocking —
// karts already render with their procedural fallback (buildKart seeds it
// synchronously), models swap in whenever each one resolves.
preloadAll(CHARACTERS);

function characterColorHex(def: CharacterDef): string {
  return `#${def.kartColor.toString(16).padStart(6, '0')}`;
}

// Kicks off (or re-kicks-off) the async model load for whatever character
// `entity` currently shows. `driverRequestId` guards against a stale,
// slow-resolving load clobbering a newer selection made before this one finished.
function loadDriverFor(entity: KartEntity, def: CharacterDef) {
  const requestId = ++entity.driverRequestId;
  loadCharacterModelInstance(def).then((model) => {
    if (entity.driverRequestId !== requestId || !model) return;
    setDriver(entity.visual, def, model);
  });
}

// Rebuilds one entity's kart + driver + display name for a new character
// (initial assignment, a select pick, or the countdown AI reassignment in
// lockRoster) — always seeds the procedural pair immediately, then kicks off
// the real model load in the background.
// §v3 Track B: setKartCharacter replaces the old setKartColor call — each
// character now has their *own chassis* (Bowser's wide twin-exhaust heavy,
// Toad's mini, Peach's royal), so re-picking has to rebuild the kart, not
// just retint one body mesh. It preserves visual.driverAnchor, so the
// setDriver call below is what re-mounts the driver.
function applyCharacterToEntity(entity: KartEntity, def: CharacterDef) {
  entity.characterId = def.id;
  entity.name = def.name;
  entity.colorHex = characterColorHex(def);
  setKartCharacter(entity.visual, def);
  setDriver(entity.visual, def, null);
  loadDriverFor(entity, def);
}

const entities: KartEntity[] = GRID.map((g, i) => {
  const def = CHARACTERS[g.charIndex];
  const { pos, heading } = spawnPose(g.s, g.lane);
  const isAi = g.humanSlot === undefined;
  const kart = createKart(pos, heading, isAi);
  const visual = buildKart(def); // seeds body color + fallback driver synchronously
  scene.add(visual.group);
  // §v3 Track C2: one flare rig per kart, hidden until boostTimer > 0. It hangs
  // off the kart ROOT (not `body`) so the drift lean doesn't swing the flames
  // off the exhausts, and it survives setKartCharacter — that swaps the
  // chassis under `group`, never `group` itself.
  const boostFlare = buildBoostFlare();
  visual.group.add(boostFlare.group);
  const entity: KartEntity = {
    kart,
    visual,
    lapProgress: createLapProgress(0),
    ai: i === 0 ? null : createAiState(g.lane), // entity 0 (P1) is never AI; entity 1 carries a fallback AiState
    name: def.name,
    spawnS: g.s,
    spawnLane: g.lane,
    itemState: createHeldItemState(),
    prevItemInput: 0 as const,
    colorHex: characterColorHex(def),
    collisionHapticCooldown: 0,
    prevBoostTimer: 0,
    prevHasItem: false,
    boostFlare,
    grade: 0,
    characterId: def.id,
    driverRequestId: 0,
  };
  loadDriverFor(entity, def);
  return entity;
});
const player = entities[0]; // P1's entity — shorthand kept for the shared/engine-audio bits that stay P1-only

// §v3 polish (post-race showcase): autopilot brains for every kart, so the
// field keeps circulating under the cinematic camera once the race is over.
// Reuses each entity's own AiState where it has one — an AI kart keeps its
// personality and lane preference — and adds one for entity 0, which is
// human-only during a race and so carries none of its own.
const showcaseAi: AiState[] = entities.map((e, i) => e.ai ?? createAiState(GRID[i].lane));

// Phase 2b: one Player per controller slot, each owning its own input source,
// keymap, and camera rig. P1 always drives entity 0; P2 drives entity 1 only
// when active (see lockRoster) — otherwise entity 1 races as AI.
const groundHeightAt = (pos: THREE.Vector3) => trackQuery.groundHeightAt(pos);
const players: [Player, Player] = [createPlayer(0, 0, groundHeightAt), createPlayer(1, 1, groundHeightAt)];
for (const p of players) p.inputSource.attachKeyboard();

// §v3 polish: the post-race camera. Takes over the whole window in FINISHED
// (see renderSplit below) and cuts between shot types until RESTART.
const cinematic = new CinematicCamera(groundHeightAt);

function entityFor(p: Player): KartEntity {
  return entities[p.entityIndex];
}

// One age per *active* human player, keyboard-override-aware (null = keyboard
// is covering for that player right now, so a stale/absent phone doesn't matter).
function activeControllerAges(now: number): (number | null)[] {
  return players
    .filter((p) => p.active)
    .map((p) => (p.inputSource.isKeyboardActive(now) ? null : p.inputSource.rawControllerAgeMs(now)));
}

function allActiveControllersFresh(now: number): boolean {
  return activeControllerAges(now).every((age) => age === null || age <= CONTROLLER_ABSENT_MS);
}

// Active human players whose controller is currently stale (keyboard-covered
// players are never "stale") — feeds the slot-aware pause-overlay message.
function staleActiveSlots(now: number): PlayerSlot[] {
  return players
    .filter((p) => p.active && !p.inputSource.isKeyboardActive(now))
    .filter((p) => {
      const age = p.inputSource.rawControllerAgeMs(now);
      return age !== null && age > CONTROLLER_ABSENT_MS;
    })
    .map((p) => p.slot);
}

// Roster locks at the moment countdown begins (Phase 2b): P2 drives entity 1
// for this race iff it's connected or driving via keyboard right now;
// otherwise entity 1 runs as AI for the whole race, even if P2 joins mid-race.
// §Phase 3: also hands out characters to every AI-driven entity at this same
// moment — whatever the active humans aren't currently showing, in
// CHARACTERS[] order, assigned to AI entities in ascending index order.
// Recomputed fresh every countdown since lobby picks can change race to race.
function lockRoster() {
  // §v4: the second seat exists because the player picked two-player mode on
  // the start menu, not because a second phone happened to connect. That is
  // what lets the lobby split the screen and show a QR per half before anyone
  // has joined; canStart() below is what stops a race beginning with an empty
  // seat.
  players[1].active = session.mode === 'multi';

  const usedIds = new Set(players.filter((p) => p.active).map((p) => entityFor(p).characterId));
  const remaining = CHARACTERS.filter((c) => !usedIds.has(c.id));
  const humanEntityIndices = new Set(players.filter((p) => p.active).map((p) => p.entityIndex));
  let next = 0;
  entities.forEach((entity, i) => {
    if (humanEntityIndices.has(i)) return;
    const def = remaining[next++];
    if (def && entity.characterId !== def.id) applyCharacterToEntity(entity, def);
  });
}

// §v4: split-screen is decided by the start menu, not by who has connected —
// two-player mode splits immediately, in the lobby, so each half can hold its
// own QR code for the phone that belongs to it (Phase 2c originally derived
// this from the roster lock, which could only be known at countdown).
function isSplit(): boolean {
  return session.mode === 'multi';
}

// §v4: two-player mode can't start with an empty seat. A seat counts as filled
// by a connected phone or by that player's keyboard (the arrow-key debug
// fallback stays usable), matching what activeControllerAges treats as live.
function canStart(): boolean {
  if (session.mode !== 'multi') return true;
  const now = performance.now();
  return players.every((p) => p.connected || p.inputSource.isKeyboardActive(now));
}

// Whether the RENDERER is currently split, which is not the same question as
// the roster's isSplit(): the post-race showcase (§v3 polish) takes the whole
// window for one cinematic camera even when two humans raced.
function renderSplit(): boolean {
  return isSplit() && raceDirector.state !== 'FINISHED';
}

function applyCameraAspects(split: boolean) {
  if (split) {
    const halfAspect = window.innerWidth / 2 / window.innerHeight;
    players[0].camera.aspect = halfAspect;
    players[1].camera.aspect = halfAspect;
  } else {
    players[0].camera.aspect = window.innerWidth / window.innerHeight;
  }
  players[0].camera.updateProjectionMatrix();
  players[1].camera.updateProjectionMatrix();
  // The cinematic camera is always full-window; it owns its own fov per shot,
  // and re-commits this aspect on the next update either way.
  cinematic.camera.aspect = window.innerWidth / window.innerHeight;
  cinematic.camera.updateProjectionMatrix();
}

// Split-screen halves the GPU's effective resolution budget while doubling
// draw/shadow passes, so the devicePixelRatio cap drops while split (§Phase 2c).
function applyRendererSizing(split: boolean) {
  const cap = split ? TUNING.splitPixelRatioCap : 2;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, cap));
  renderer.setSize(window.innerWidth, window.innerHeight);
  applyCameraAspects(split);
}

// §Phase 11 juice: pooled drift-spark particles, WebAudio engine hum, minimap.
const driftSparks = new DriftSparks();
scene.add(driftSparks.points);
const engineAudio = new EngineAudio();
window.addEventListener('pointerdown', () => engineAudio.ensureStarted(), { once: true });
window.addEventListener('keydown', () => engineAudio.ensureStarted(), { once: true });
const minimap = new Minimap(app, track.samples);

// §Phase 10 items: 6 fixed boxes with their own rotating visual meshes, plus
// dynamic banana/shell projectiles synced to THREE meshes each render frame.
const itemBoxes: ItemBoxState[] = createItemBoxes(track.samples);
// §v3 Track C2: `baseY` is captured at build time because the bob animation
// rewrites mesh.position.y every frame and would otherwise drift.
const ITEM_BOX_BASE_HEIGHT = 0.95;
const itemBoxVisuals = itemBoxes.map((box) => {
  const mesh = buildItemBoxMesh();
  mesh.position.copy(track.samples[box.sampleIdx].pos).add(new THREE.Vector3(0, ITEM_BOX_BASE_HEIGHT, 0));
  scene.add(mesh);
  return mesh;
});
// §v3 Track C2 item-box animation. The state machine stays entirely in
// ItemSystem (box.active / box.respawnTimer); this is a pure render-side
// observer that watches `active` flip and plays a pop-out or scale-in. It has
// to be separate state because `active` alone can't express "gone, but still
// finishing its pop".
const ITEM_BOX_POP_SECONDS = 0.26;
const ITEM_BOX_SPAWN_SECONDS = 0.3;
const ITEM_BOX_BOB = 0.13;
const itemBoxAnim = itemBoxes.map((box) => ({
  baseY: track.samples[box.sampleIdx].pos.y + ITEM_BOX_BASE_HEIGHT,
  prevActive: true,
  popTimer: 0,
  spawnTimer: 0,
}));
const bananas: Banana[] = [];
const shells: Shell[] = [];
const bananaVisuals = new Map<Banana, THREE.Mesh>();
const shellVisuals = new Map<Shell, THREE.Mesh>();

// §v3 Track C: the in-world item feedback rigs. All three are pooled at
// startup and never allocate afterwards (see render/ItemVisuals.ts).
const heldItemMarkers = new HeldItemMarkers(scene, GRID.length);
const spinStars = new SpinStars(scene, GRID.length);
const arcadeEffects = new ArcadeEffects(scene);
const shellTrail = new ItemTrail();
scene.add(shellTrail.points);

// Shared seconds accumulator for the render-loop-only animations (item box bob,
// boost-flare flicker). Advanced once per frame by renderDt.
let animClock = 0;
// Shell trail emission is time-based, not per-frame, so the trail is the same
// length at 60Hz and 144Hz.
const SHELL_TRAIL_INTERVAL = 0.04;
let shellTrailAccum = 0;

// Standard easeOutBack: overshoots past 1 then settles, which is what makes a
// scale-in read as a "pop" rather than a fade-in. Used by the item box respawn
// and the shell spawn.
function easeOutBack(u: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const k = u - 1;
  return 1 + c3 * k * k * k + c1 * k * k;
}

const lapTracker = new LapTracker(track.checkpoints, track.samples, track.totalLength);

let finishCounter = 0;
let playerFinishTimer: number | null = null;
// §v3 Track C1 review fix: rising edge of "the race is actually running", used
// to re-assert each phone's ITEM button state on every entry into RACING (see
// the tick below). Starts false so the first countdown->RACING transition of
// the session counts as an edge.
let prevRacing = false;

// Immediately ahead of `selfIndex` by race progress; null if already leading
// (nothing to target a homing shell at).
function findNextAhead(selfIndex: number): number | null {
  const self = entities[selfIndex];
  let best: number | null = null;
  let bestProgress = Infinity;
  entities.forEach((e, i) => {
    if (i === selfIndex) return;
    if (e.lapProgress.progress > self.lapProgress.progress && e.lapProgress.progress < bestProgress) {
      bestProgress = e.lapProgress.progress;
      best = i;
    }
  });
  return best;
}

// Keeps a THREE.Mesh per live projectile object, adding/removing as items
// spawn/despawn. `items` is small (a handful of bananas/shells at most).
function syncProjectileVisuals<T extends { pos: THREE.Vector3 }>(
  items: T[],
  visuals: Map<T, THREE.Mesh>,
  build: () => THREE.Mesh,
  targetScene: THREE.Scene,
) {
  for (const [obj, mesh] of visuals) {
    if (!items.includes(obj)) {
      targetScene.remove(mesh);
      // §v3 Track C review fix: buildBananaMesh/buildShellMesh allocate a fresh
      // SphereGeometry + MeshLambertMaterial per projectile, so removing the
      // mesh from the scene alone leaked its GPU buffers and shader program
      // every time a banana was picked up/evicted, a shell hit or timed out, or
      // resetRace() emptied both arrays. Nothing else references these — they
      // are built here and owned by this map — so disposing on removal is safe.
      mesh.traverse((part) => {
        if (!(part instanceof THREE.Mesh)) return;
        part.geometry.dispose();
        const materials = Array.isArray(part.material) ? part.material : [part.material];
        for (const material of materials) material.dispose();
      });
      visuals.delete(obj);
    }
  }
  for (const obj of items) {
    let mesh = visuals.get(obj);
    if (!mesh) {
      mesh = build();
      targetScene.add(mesh);
      visuals.set(obj, mesh);
    }
    mesh.position.copy(obj.pos);
  }
}

function resetRace() {
  for (const e of entities) {
    const { pos, heading } = spawnPose(e.spawnS, e.spawnLane);
    e.kart.pos.copy(pos);
    e.kart.heading = heading;
    e.kart.speed = 0;
    e.kart.velLateral = 0;
    e.kart.steerActual = 0;
    e.kart.drift = { phase: 'none', dir: 1, charge: 0 };
    e.kart.boostTimer = 0;
    e.kart.spinTimer = 0;
    e.lapProgress = createLapProgress(0);
    if (e.ai) {
      e.ai.stuckTimer = 0;
      e.ai.wallScrapeTimer = 0;
      e.ai.driftHeld = false;
    }
    e.itemState = createHeldItemState();
    e.prevItemInput = 0;
    e.collisionHapticCooldown = 0;
    e.prevBoostTimer = 0;
    e.prevHasItem = false;
    e.grade = 0;
    // §v3 Track C2: clear any in-flight use animation so a restart never
    // starts with a stretched kart or a lit exhaust.
    e.visual.boostPopTimer = 0;
    e.visual.group.scale.set(1, 1, 1);
    e.boostFlare.group.visible = false;
  }
  for (const box of itemBoxes) {
    box.active = true;
    box.respawnTimer = 0;
  }
  // The pop/spawn animations are render-side state, so they have to be reset
  // here too — otherwise a box picked up a frame before the restart would
  // finish fading out over the freshly reset track.
  for (const anim of itemBoxAnim) {
    anim.prevActive = true;
    anim.popTimer = 0;
    anim.spawnTimer = 0;
  }
  // §v3 Track C2 review fix: the mushroom FOV kick lives on the camera, not on
  // the entity, so it needs clearing here too — otherwise a restart pressed
  // moments after a mushroom widens the lobby/countdown view and eases back
  // over the next second (the kick decays exponentially and never snaps).
  for (const p of players) p.followCamera.resetFov();
  // Covers each entity's own AiState too (showcaseAi reuses those objects) —
  // the extra brain for entity 0 is the only one the loop above misses.
  for (const ai of showcaseAi) {
    ai.stuckTimer = 0;
    ai.wallScrapeTimer = 0;
    ai.driftHeld = false;
  }
  shellTrail.clear();
  arcadeEffects.clear();
  bananas.length = 0;
  shells.length = 0;
  finishCounter = 0;
  playerFinishTimer = null;
}

// Finished karts rank by finish order above all racing karts, which rank by progress.
function comparePosition(a: KartEntity, b: KartEntity): number {
  if (a.lapProgress.finished !== b.lapProgress.finished) {
    return a.lapProgress.finished ? -1 : 1;
  }
  if (a.lapProgress.finished) {
    return (a.lapProgress.finishOrder ?? 0) - (b.lapProgress.finishOrder ?? 0);
  }
  return b.lapProgress.progress - a.lapProgress.progress;
}

function finalizeUnfinishedByProgress() {
  const unfinished = entities.filter((e) => e.lapProgress.finishOrder === null);
  unfinished.sort((a, b) => b.lapProgress.progress - a.lapProgress.progress);
  for (const e of unfinished) e.lapProgress.finishOrder = ++finishCounter;
}

// The active human player driving this entity this race, if any (for results
// P1/P2 highlighting, §Phase 2c).
function slotForEntity(e: KartEntity): PlayerSlot | null {
  const p = players.find((pl) => pl.active && entityFor(pl) === e);
  return p ? p.slot : null;
}

window.addEventListener('resize', () => applyRendererSizing(renderSplit()));

// --- Networking + input --------------------------------------------------

const hud = new Hud(app);
// One PlayerHud per human seat (Phase 2c): P1's spans the full screen solo,
// or the left half split; P2's stays hidden until it's actually racing.
const playerHuds: [PlayerHud, PlayerHud] = [new PlayerHud(app), new PlayerHud(app)];
playerHuds[1].setLayout('hidden');
const diagnostics = new Diagnostics(app);
let lastRttMs: number | null = null;

// Maps a RaceDirector state to the EventName that puts a controller's
// handleRaceEvent switch (ui.ts) on the matching screen — used to sync a
// freshly-(re)joined controller onto whatever the race is already doing.
function raceStateToEvent(state: RaceDirector['state']): EventName {
  switch (state) {
    case 'LOBBY':
      return 'lobby';
    case 'COUNTDOWN':
      return 'countdown';
    case 'RACING':
      return 'go';
    case 'PAUSED':
      return 'paused';
    case 'FINISHED':
      return 'finished';
  }
}

const raceDirector = new RaceDirector({
  onEvent: (name) => socket.sendEvent(name), // broadcast to both controllers (no slot)
  onStateChange: (state) => {
    if (state === 'LOBBY') {
      resetRace();
      players[1].active = false; // re-locked fresh by lockRoster() at the next countdown
    }
    if (state === 'COUNTDOWN') lockRoster();
    if (state === 'FINISHED') {
      // §v3 polish: the winner and whoever was actually driving get most of
      // the screen time; the rest of the field still shows up between them.
      const winner = [...entities].sort(comparePosition)[0];
      const preferred = new Set<number>([entities.indexOf(winner)]);
      for (const p of players) if (p.active) preferred.add(p.entityIndex);
      cinematic.reset([...preferred]);
    }
  },
});

// §Phase 3: character select + roster broadcast. Each RosterPick's
// characterId is simply the entity's *current* character whenever that slot
// has a live controller (null otherwise) — entity state is the single source
// of truth for "what's currently selected", so there's no separate
// pick-tracking state to keep in sync with it.
function broadcastRoster() {
  socket.sendRoster(
    players.map((p) => ({
      slot: p.slot,
      characterId: p.connected ? entityFor(p).characterId : null,
    })),
  );
}

// Accepted only in LOBBY, first-come per character: rejected if the *other*
// connected slot is already showing this character. AI's characters are a
// separate concern resolved only at countdown (lockRoster) — picking a
// character an AI kart happens to be previewing right now is always allowed.
function trySelectCharacter(slot: PlayerSlot, characterId: string) {
  if (raceDirector.state !== 'LOBBY') return;
  const def = CHARACTERS_BY_ID[characterId];
  if (!def) return;
  if (entityFor(players[slot]).characterId === characterId) return; // already selected, nothing to do
  const other = players[slot === 0 ? 1 : 0];
  if (other.connected && entityFor(other).characterId === characterId) return; // taken
  applyCharacterToEntity(entityFor(players[slot]), def);
  broadcastRoster();
}

const socket = new GameSocket({
  onRoom: (code, joinUrl) => hud.showRoom(code, joinUrl),
  onStatus: (status) => hud.setConnectionStatus(status),
  onRtt: (rtt) => {
    lastRttMs = rtt;
  },
  onPeer: (event, slot) => {
    const s = slot ?? 0;
    players[s].connected = event === 'controller-joined';
    hud.setPeerStatus(s, players[s].connected);
    // A freshly-joined controller needs the current roster to render its
    // panel; the other controller needs to know this slot just freed up (or
    // claimed) its character (§Phase 3).
    if (event === 'controller-joined' || event === 'controller-left') broadcastRoster();
    // A controller that (re)joins mid-race defaults to the character-select
    // screen (ui.ts's onJoined); if the race has already moved past LOBBY,
    // push the current RaceDirector state to just that slot so it lands on
    // the right screen instead of being stuck on the character grid.
    if (event === 'controller-joined' && raceDirector.state !== 'LOBBY') {
      socket.sendEvent(raceStateToEvent(raceDirector.state), s);
      // §v3 Track C1: the state event above leaves the ITEM button dim (every
      // screen transition resets it), so re-assert this slot's actual
      // possession — a phone that reconnects mid-race while holding a shell
      // must not sit there with a dead-looking ITEM button. Only meaningful
      // for a slot that is actually driving: if this slot isn't active, entity
      // `entityIndex` is being run by AI and its item is none of this phone's
      // business.
      const holdsItem = players[s].active && entityFor(players[s]).itemState.item !== null;
      socket.sendEvent(holdsItem ? 'item-ready' : 'item-clear', s);
    }
  },
  onInput: (snapshot) => {
    const slot = snapshot.slot ?? 0;
    players[slot].inputSource.onSnapshot(snapshot);
    if (raceDirector.state === 'PAUSED') raceDirector.notifyInputRecovered(allActiveControllersFresh(performance.now()));
  },
  onEvent: (name) => {
    // Either controller's start/restart is honored (Phase 2b) — the sender's
    // slot (server-stamped) doesn't gate these, both act on the shared race state.
    if (name === 'start' && canStart()) raceDirector.requestStart();
    else if (name === 'restart') raceDirector.requestRestart();
  },
  onSelect: (characterId, slot) => trySelectCharacter(slot ?? 0, characterId),
});
void socket;

window.addEventListener('keydown', (e) => {
  if (e.code === 'Enter' && canStart()) raceDirector.requestStart();
  if (e.code === 'KeyR') raceDirector.requestRestart();
  if (raceDirector.state === 'PAUSED') raceDirector.notifyInputRecovered(allActiveControllersFresh(performance.now()));
});

// --- Fixed-timestep physics + rAF render ----------------------------------

let lastRenderTime = performance.now();
let lastLayoutKey: string | null = null; // forces the first frame to apply sizing/layout
const shadowMidpoint = new THREE.Vector3(); // reused each frame by the shadow-camera-follow block below

startLoop(
  (dt) => {
    const now = performance.now();
    raceDirector.tick(dt, activeControllerAges(now));

    if (raceDirector.state === 'PAUSED') return; // physics frozen entirely

    const racing = raceDirector.state === 'RACING';
    // §v3 polish: the post-race showcase. Physics keeps stepping and every
    // kart drives itself (see the control selection below), which is what the
    // cinematic camera is pointed at. Everything else gated on `racing` —
    // pickups, item use, lap/finish bookkeeping, haptics — stays off, so the
    // results standing behind the show can't change while it plays.
    const showcase = raceDirector.state === 'FINISHED';

    // §v3 Track C1 review fix: every screen transition on the controller
    // (ui.ts's handleRaceEvent) dims the ITEM button, but a PAUSED->COUNTDOWN
    // resume does NOT reset the race — resetRace() only runs on the LOBBY
    // transition — so a player can come back from a pause still holding the
    // shell they had. The possession edge below can't recover that on its own
    // (hasItem never changes, so there is no edge to send), which left the
    // button permanently dim mid-race. Re-assert the truth for every active
    // human whenever the race (re)enters RACING instead. This runs after
    // raceDirector.tick() has already emitted 'go', so the cue can't be
    // overwritten by the transition it follows. `prevHasItem` is re-seeded at
    // the same time so the next real edge is measured from a known-sent state.
    if (racing && !prevRacing) {
      for (const p of players) {
        if (!p.active) continue;
        const e = entityFor(p);
        e.prevHasItem = e.itemState.item !== null;
        socket.sendEvent(e.prevHasItem ? 'item-ready' : 'item-clear', p.slot);
      }
    }
    prevRacing = racing;

    if (racing) updateItemBoxes(itemBoxes, dt);

    const hitWallThisTick: boolean[] = new Array(entities.length).fill(false);

    for (let i = 0; i < entities.length; i++) {
      const e = entities[i];
      const preSample = trackQuery.nearestSample(e.kart.pos);
      const offRoad = Math.abs(preSample.lateral) > ROAD_HALF;
      const onWall = Math.abs(preSample.lateral) >= GRASS_HALF - TUNING.kartRadius;

      // Roster is locked at countdown (lockRoster): entity 0 is always P1,
      // entity 1 is P2 only when active, everything else is always AI.
      const drivingPlayer = i === 0 ? players[0] : i === 1 && players[1].active ? players[1] : null;

      let control: ControlState;
      let topSpeedScale = 1;

      if (!racing && !showcase) {
        control = NEUTRAL_CONTROL;
      } else if (racing && drivingPlayer) {
        control = drivingPlayer.inputSource.sample(now);
      } else {
        // Autopilot: the entity's own AiState during a race, and during the
        // showcase that same brain for everyone — including the humans' karts,
        // which have none of their own (§v3 polish, showcaseAi).
        const result = think(
          showcaseAi[i],
          e.kart,
          preSample.s,
          preSample.lateral,
          onWall,
          track.samples,
          track.totalLength,
          e.lapProgress.progress,
          player.lapProgress.progress,
          dt,
        );
        control = result.control;
        topSpeedScale = result.topSpeedScale;
      }

      const surface = trackQuery.surfaceAt(preSample.s, preSample.lateral);
      stepKart(e.kart, control, dt, offRoad, topSpeedScale, surface);
      hitWallThisTick[i] = resolveWallCollision(e.kart, trackQuery);

      if (racing) {
        tryPickupItemBox(itemBoxes, track.samples, e.kart.pos, e.itemState);
        updateRoulette(e.itemState, dt);

        const itemPressed = control.item === 1 && e.prevItemInput === 0;
        e.prevItemInput = control.item;
        // Keyed off who's actually driving this tick, not `e.ai`'s mere
        // presence — entity 1 always carries a fallback AiState (Phase 2b),
        // but must use press-edge firing whenever P2 is actively driving it.
        const wantsFire = drivingPlayer ? itemPressed : tickAiItemDecision(e.itemState, dt);
        if (wantsFire) {
          // Captured before useItem clears it — the mushroom's use animation
          // (§v3 Track C2) needs to know *what* was fired, and useItem only
          // reports whether anything was.
          const firedType = e.itemState.item;
          const fired = useItem({
            kartIndex: i,
            kart: e.kart,
            held: e.itemState,
            bananas,
            shells,
            targetIndex: findNextAhead(i),
            fireS: trackQuery.nearestSample(e.kart.pos).s,
          });
          if (fired) arcadeEffects.burst(e.kart.pos, false);
          if (fired && (firedType === 'mushroom' || firedType === 'goldenMushroom')) {
            // Squash-and-stretch on every mushroom (so opponents' boosts read
            // too), but the FOV kick only on the *firing* human's own camera —
            // lurching a split-screen opponent's view because you used an item
            // would be actively unpleasant.
            triggerBoostPop(e.visual);
            if (drivingPlayer) drivingPlayer.followCamera.kickFov();
          }
        }
      }
    }

    const kartKartHits = resolveKartKartCollisions(
      entities.map((e) => e.kart),
      dt,
    );

    // §Phase 5 item 4: ground-follow, after stepping + both collision passes
    // have settled this tick's x/z position. `stepKart` never touches pos.y
    // itself (design principle: physics stays 2D-projected) -- y is assigned
    // here from the track height under the kart's final x/z, damped rather
    // than snapped so a kart driving off a ledge or through a bump doesn't
    // teleport vertically. The same query's `grade` is stashed on the entity
    // for updateKartVisual's pitch in the render loop (§Phase 5 item 5) so
    // that doesn't need a second nearestSample call.
    for (const e of entities) {
      const groundSample = trackQuery.nearestSample(e.kart.pos);
      e.kart.pos.y = damp(e.kart.pos.y, groundSample.groundY, GROUND_FOLLOW_RATE, dt);
      e.grade = groundSample.grade;
    }

    // §v3 Track C2: `dt` counts each banana's toss/arming timer down. Called on
    // every unpaused tick, not just while RACING (§review fix): the arc has to
    // finish even if the race ends mid-throw, or the render loop keeps drawing
    // the banana suspended at its parabola's peak for the whole results screen.
    // Only the collision half is gated on `racing`.
    updateBananas(bananas, entities.map((e) => e.kart), groundHeightAt, dt, racing);
    if (racing) {
      updateShells(shells, entities.map((e) => e.kart), track.samples, track.totalLength, dt);
    }

    // §Phase 11d haptic/audio cues, now per active human player (Phase 2b) —
    // each phone only feels its own hits/boosts; engine audio stays P1-only
    // (deliberate simplification, §Phase 2b).
    for (const p of players) {
      if (!p.active) continue;
      const e = entityFor(p);
      e.collisionHapticCooldown = Math.max(0, e.collisionHapticCooldown - dt);
      const collided = hitWallThisTick[p.entityIndex] || kartKartHits.has(p.entityIndex);
      if (racing && collided && e.collisionHapticCooldown <= 0) {
        socket.sendEvent('collision', p.slot);
        if (p.slot === 0) engineAudio.burst(0.12, 0.1);
        e.collisionHapticCooldown = COLLISION_HAPTIC_COOLDOWN_SECONDS;
      }
      if (racing && e.kart.boostTimer > 0 && e.prevBoostTimer <= 0) {
        socket.sendEvent('boost', p.slot);
        if (p.slot === 0) engineAudio.burst(0.2, 0.2);
      }
      e.prevBoostTimer = e.kart.boostTimer;

      // §v3 Track C1: slot-targeted item possession edges. Sent only on a
      // change (never per tick) and only to this player's own phone, which
      // lights/dims its ITEM button. The edge is tracked even when not racing
      // so a state transition can't leave a stale `prevHasItem` behind that
      // would swallow the first real edge of the next race.
      const hasItem = e.itemState.item !== null;
      if (hasItem !== e.prevHasItem) {
        if (racing) socket.sendEvent(hasItem ? 'item-ready' : 'item-clear', p.slot);
        e.prevHasItem = hasItem;
      }
    }

    if (racing) {
      for (const e of entities) {
        const q = trackQuery.nearestSample(e.kart.pos);
        const wasFinished = e.lapProgress.finished;
        lapTracker.update(e.lapProgress, q.s);
        if (!wasFinished && e.lapProgress.finished) {
          e.lapProgress.finishOrder = ++finishCounter;
        }
      }

      // Finish timer starts once every active human has finished (Phase 2b) —
      // solo play (only P1 active) behaves exactly as before.
      const allActiveHumansFinished = players.filter((p) => p.active).every((p) => entityFor(p).lapProgress.finished);
      if (allActiveHumansFinished && playerFinishTimer === null) {
        playerFinishTimer = PLAYER_FINISH_DELAY_SECONDS;
      }
      if (playerFinishTimer !== null) {
        playerFinishTimer -= dt;
        if (playerFinishTimer <= 0) {
          finalizeUnfinishedByProgress();
          raceDirector.notifyFinished();
        }
      }
    }
  },
  (_alpha, stepsThisFrame) => {
    diagnostics.tickFrame();

    const now = performance.now();
    const renderDt = Math.min((now - lastRenderTime) / 1000, 0.1);
    lastRenderTime = now;
    animClock += renderDt;
    environment.update?.(animClock);

    for (const e of entities) updateKartVisual(e.visual, e.kart, renderDt, e.grade);

    // §v3 Track C: per-kart item feedback. All of it is driven off state the
    // physics tick already owns (itemState.item, kart.spinTimer,
    // kart.boostTimer) and advanced with renderDt, so nothing here can feed
    // back into the simulation. Applies to every kart, not just the humans —
    // seeing the AI two lengths behind you holding a shell is the point.
    heldItemMarkers.tick(renderDt);
    spinStars.tick(renderDt);
    for (let i = 0; i < entities.length; i++) {
      const e = entities[i];
      // A spun-out kart shows stars instead of its item marker: stacking both
      // over one kart is noise, and the stars are the more urgent message.
      heldItemMarkers.set(i, e.kart.spinTimer > 0 ? null : e.itemState.item, e.kart.pos);
      spinStars.set(i, e.kart.spinTimer, e.kart.pos);
      updateBoostFlare(
        e.boostFlare,
        e.kart.boostTimer,
        animClock,
        e.visual.chassis.rearZ,
        e.visual.chassis.exhaustY,
        e.visual.chassis.exhausts,
      );
    }

    // Layout/sizing only changes when the roster lock (isSplit) flips or the
    // showcase takes over — not recomputed every frame (§Phase 2c). Keyed on a
    // string rather than the old boolean because there are three states now:
    // solo, split, and showcase (§v3 polish), and showcase and solo share the
    // same renderer sizing but hide different HUD layers — a boolean would let
    // 'showcase' -> 'solo' slip through as "no change" and strand both player
    // HUDs hidden for the next race.
    const showcase = raceDirector.state === 'FINISHED';
    const split = isSplit() && !showcase;
    const layoutKey = showcase ? 'showcase' : split ? 'split' : 'solo';
    if (layoutKey !== lastLayoutKey) {
      lastLayoutKey = layoutKey;
      applyRendererSizing(split);
      hud.setSplit(split);
      playerHuds[0].setLayout(showcase ? 'hidden' : split ? 'left' : 'solo');
      playerHuds[1].setLayout(showcase || !split ? 'hidden' : 'right');
    }

    // The follow cameras keep tracking their karts through the showcase even
    // though nothing is rendering them: they damp toward their target, so
    // leaving them frozen would make the first frame after RESTART a swoop.
    players[0].followCamera.update(entityFor(players[0]).kart, renderDt);
    // isSplit() rather than `split`: P2's half exists from the lobby onward in
    // two-player mode (and `split` is false during the showcase), and a camera
    // that has never been updated would render its half from the world origin.
    if (isSplit()) players[1].followCamera.update(entityFor(players[1]).kart, renderDt);
    if (showcase) cinematic.update(entities, renderDt);

    // §Phase 4 item 3: shadow camera re-centers on the active players'
    // midpoint every frame (light keeps its fixed relative offset) so the
    // ortho shadow box always covers whoever's actually racing. Loop instead
    // of players.filter(...) to avoid an allocation every frame (§Phase 4
    // finding #4).
    if (showcase) {
      // §v3 polish: during the showcase the shadow box follows whichever kart
      // the cinematic camera is on — the humans' karts may be nowhere near it.
      shadowMidpoint.copy(entities[cinematic.subjectIndex].kart.pos);
    } else {
      shadowMidpoint.set(0, 0, 0);
      let activeShadowCount = 0;
      for (const p of players) {
        if (!p.active) continue;
        shadowMidpoint.add(entityFor(p).kart.pos);
        activeShadowCount++;
      }
      shadowMidpoint.divideScalar(activeShadowCount || 1);
    }
    updateLightTarget(lights.directional, shadowMidpoint);
    // §Phase 4 finding #3: a straight-line midpoint can leave one split
    // player outside a fixed-size ortho box when they're far apart, so the
    // box itself grows with the players' separation while split.
    const shadowPlayerDistance = split
      ? entityFor(players[0]).kart.pos.distanceTo(entityFor(players[1]).kart.pos)
      : 0;
    updateShadowBounds(lights, shadowPlayerDistance);

    // §Phase 11a/b: drift sparks tinted by tier, engine pitch mapped to speed.
    for (const e of entities) {
      if (e.kart.drift.phase !== 'active') continue;
      const rearOffset = kartForward(e.kart.heading).multiplyScalar(-1);
      const sparkPos = e.kart.pos.clone().addScaledVector(rearOffset, 1.0);
      sparkPos.y = e.kart.pos.y + 0.3; // §Phase 5: relative to local track height, not an absolute world y
      driftSparks.emit(sparkPos, driftTier(e.kart.drift.charge));
    }
    driftSparks.update(renderDt);
    engineAudio.setSpeed(Math.abs(player.kart.speed) / TUNING.topSpeed); // engine audio stays P1-only by design

    // Minimap stays one shared instance; both active human dots get the
    // bigger highlighted treatment, distinguished from each other by their
    // own kart color (§Phase 2c).
    const activeHumanEntities = new Set(players.filter((p) => p.active).map((p) => entityFor(p)));
    minimap.update(
      entities.map((e) => ({ pos: e.kart.pos, color: e.colorHex, isPlayer: activeHumanEntities.has(e) })),
    );

    // Item box visuals (§v3 Track C2): bob + spin while active, a scale-up
    // fade-out pop on pickup, a scale-in on respawn. The ItemSystem state
    // machine is untouched — this only *observes* box.active flipping.
    itemBoxes.forEach((box, i) => {
      const mesh = itemBoxVisuals[i];
      const anim = itemBoxAnim[i];
      const material = mesh.material as THREE.MeshLambertMaterial;
      if (box.active !== anim.prevActive) {
        anim.prevActive = box.active;
        if (box.active) {
          anim.spawnTimer = ITEM_BOX_SPAWN_SECONDS;
          anim.popTimer = 0;
        } else {
          arcadeEffects.burst(mesh.position);
          anim.popTimer = ITEM_BOX_POP_SECONDS;
          anim.spawnTimer = 0;
        }
      }
      mesh.rotation.y += renderDt * 1.5;
      mesh.rotation.z = Math.sin(animClock * 1.7 + i) * 0.18;
      mesh.rotation.x = Math.PI * 0.12;

      if (anim.popTimer > 0) {
        // Still playing the pickup pop: the box is logically gone but stays
        // on screen for another quarter-second, swelling and fading.
        anim.popTimer = Math.max(0, anim.popTimer - renderDt);
        const u = 1 - anim.popTimer / ITEM_BOX_POP_SECONDS; // 0 -> 1
        mesh.visible = true;
        mesh.scale.setScalar(1 + u * 0.9);
        material.opacity = 1 - u;
        mesh.position.y = anim.baseY;
      } else if (box.active) {
        mesh.visible = true;
        material.opacity = 1;
        if (anim.spawnTimer > 0) {
          anim.spawnTimer = Math.max(0, anim.spawnTimer - renderDt);
          mesh.scale.setScalar(easeOutBack(1 - anim.spawnTimer / ITEM_BOX_SPAWN_SECONDS));
        } else {
          mesh.scale.setScalar(1);
        }
        mesh.position.y = anim.baseY + Math.sin(animClock * 2 + i) * ITEM_BOX_BOB;
      } else {
        mesh.visible = false;
      }
    });

    // Sync banana/shell meshes to their live-object arrays (create/remove as needed).
    syncProjectileVisuals(bananas, bananaVisuals, buildBananaMesh, scene);
    syncProjectileVisuals(shells, shellVisuals, buildShellMesh, scene);

    // §v3 Track C2 banana toss arc. syncProjectileVisuals has just snapped
    // every mesh onto its object's resting `pos`; while the banana is still
    // in the air (tossTimer > 0, i.e. unarmed) the visual is lifted off that
    // resting spot and bowed along a parabola from `spawnFrom` instead. The
    // physics object itself never leaves the ground — this is display only.
    for (const banana of bananas) {
      const mesh = bananaVisuals.get(banana);
      if (!mesh) continue;
      if (banana.tossTimer > 0) {
        const t = 1 - banana.tossTimer / BANANA_TOSS_SECONDS; // 0 at the throw -> 1 on landing
        mesh.position.lerpVectors(banana.spawnFrom, banana.pos, t);
        mesh.position.y += Math.sin(t * Math.PI) * BANANA_TOSS_PEAK + 0.2;
        mesh.rotation.y += renderDt * 9;
        // Tilt peaks mid-flight and is back to level exactly on landing, so
        // the banana settles flat with no snap and no post-landing easing state.
        mesh.rotation.x = Math.sin(t * Math.PI) * 0.6;
      } else {
        mesh.position.y += 0.2;
        mesh.rotation.x = 0;
      }
    }

    // §v3 Track C2 shell: scale-in pop, fast Y spin, a slight hover bob, and a
    // pooled fading trail. `shell.age` is already maintained by updateShells,
    // so no new per-shell state is needed for any of it.
    shellTrailAccum += renderDt;
    const emitShellTrail = shellTrailAccum >= SHELL_TRAIL_INTERVAL;
    if (emitShellTrail) shellTrailAccum = 0;
    for (const shell of shells) {
      const mesh = shellVisuals.get(shell);
      if (!mesh) continue;
      mesh.scale.setScalar(easeOutBack(Math.min(1, shell.age / 0.18)));
      mesh.rotation.y = shell.age * 15;
      mesh.position.y = shell.pos.y + 0.42 + Math.sin(shell.age * 9) * 0.07;
      if (emitShellTrail) {
        shellTrail.emit(mesh.position.x, mesh.position.y, mesh.position.z, 0.35, 1, 0.5);
      }
    }
    shellTrail.update(renderDt);
    arcadeEffects.update(renderDt);

    const ranked = [...entities].sort(comparePosition);
    const maxTierTime = TUNING.driftTierTimes[TUNING.driftTierTimes.length - 1];

    // Per-player readouts (Phase 2c): drift bar + item slot update every
    // frame regardless of race state, same as the pre-split-screen behavior;
    // lap/pos/speed is gated by race state below.
    for (const p of players) {
      if (!p.active) continue;
      const e = entityFor(p);
      const ph = playerHuds[p.slot];
      const driftActive = e.kart.drift.phase === 'active';
      ph.setDriftCharge(driftActive, driftTier(e.kart.drift.charge), e.kart.drift.charge / maxTierTime);
      // §v3 Track C1: the HUD slot now has three states rather than
      // "icon or nothing". main.ts keeps ownership of the roulette-vs-held
      // choice (as before) and passes the resolved display item plus whether
      // the roulette is still spinning; PlayerHud does the rest.
      const rolling = e.itemState.rouletteTimer > 0;
      ph.setItemState({ item: rolling ? e.itemState.rouletteDisplay : e.itemState.item, rolling });
    }

    switch (raceDirector.state) {
      case 'LOBBY':
        hud.showLobby();
        hud.hideCountdown();
        hud.setPaused(false);
        hud.hideResults();
        for (const ph of playerHuds) ph.hideRaceInfo();
        break;
      case 'COUNTDOWN':
        hud.hideLobby();
        hud.showCountdown(String(Math.max(1, Math.ceil(raceDirector.countdownRemaining))));
        hud.setPaused(false);
        hud.hideResults();
        break;
      case 'RACING':
        hud.hideLobby();
        hud.hideCountdown();
        hud.setPaused(false);
        hud.hideResults();
        for (const p of players) {
          if (!p.active) continue;
          const e = entityFor(p);
          const position = ranked.indexOf(e) + 1;
          playerHuds[p.slot].setRaceInfo(e.lapProgress.lap, TOTAL_LAPS, e.kart.speed * 3.6, position, entities.length);
        }
        break;
      case 'PAUSED':
        hud.setPaused(true, staleActiveSlots(now));
        break;
      case 'FINISHED':
        hud.hideCountdown();
        hud.setPaused(false);
        hud.showResults(ranked.map((e) => ({ name: e.name, slot: slotForEntity(e) })));
        break;
    }

    const diag = players[0].inputSource.diagnostics();
    hud.setKeyboardActive(diag.source === 'keyboard');
    hud.setSteerMode(diag.source === 'controller' ? diag.steerMode : null);
    diagnostics.update({
      rttMs: lastRttMs,
      inputAgeMs: diag.ageMs,
      seq: diag.seq,
      source: diag.source,
      raceState: raceDirector.state,
      lap: player.lapProgress.lap,
      nextCheckpoint: player.lapProgress.nextCheckpoint,
      stepsThisFrame,
    });

    // §Phase 4 finding #2: with autoUpdate off, the shadow pass only runs
    // when needsUpdate is set — do it once here rather than let it run (or
    // not) implicitly inside each render() call below.
    renderer.shadowMap.needsUpdate = true;

    if (split) {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const halfW = Math.floor(w / 2);
      renderer.setScissorTest(true);
      renderer.setViewport(0, 0, halfW, h);
      renderer.setScissor(0, 0, halfW, h);
      renderer.render(scene, players[0].camera);
      renderer.setViewport(halfW, 0, w - halfW, h);
      renderer.setScissor(halfW, 0, w - halfW, h);
      renderer.render(scene, players[1].camera);
      renderer.setScissorTest(false);
    } else {
      renderer.render(scene, showcase ? cinematic.camera : players[0].camera);
    }
  },
);
