import * as THREE from 'three';
import type { EventName, PlayerSlot } from '../shared/protocol';
import { GameSocket } from './net/GameSocket';
import { NEUTRAL_CONTROL, type ControlState } from './input/ControlProvider';
import { PhoneProvider } from './input/PhoneProvider';
import { HandProvider } from './input/HandProvider';
import { HandTracker } from './hands/HandTracker';
import { Calibration } from './hands/Calibration';
import { HandOverlay } from './ui/HandOverlay';
import { CalibrationPrompt } from './ui/CalibrationPrompt';
import { attachDebugToggle } from './ui/DebugToggle';
import { createPlayer, type Player } from './player/Player';
import { Hud } from './ui/Hud';
import { PlayerHud } from './ui/PlayerHud';
import { FinishScreen } from './ui/FinishScreen';
import { playerColor } from './ui/theme';
import type { FinishPlayerResult } from './race/FinishResults';
import { Diagnostics } from './ui/Diagnostics';
import { startLoop } from './core/loop';
import { createKart, driftTier, kartForward, stepKart, type KartState } from './physics/Kart';
import { resolveWallCollision, resolveKartKartCollisions } from './physics/collision';
import { groundKart, stepVertical, visualGrade, type AirEvent } from './physics/Airborne'; // §v5 jump
import {
  buildLights,
  updateLightTarget,
  updateShadowBounds,
  buildKart,
  setDriver,
  setKartCharacter,
  updateKartVisual,
  triggerBoostPop,
  triggerSquash,
  type KartVisual,
} from './render/SceneBuilder';
import { buildBoostFlare, updateBoostFlare, type BoostFlare } from './render/BoostFlare';
import { buildEnvironment } from './render/Environment';
import { CinematicCamera } from './render/CinematicCamera';
import { CHARACTERS, type CharacterDef } from './characters/registry';
import { loadCharacterModelInstance, preloadAll } from './characters/CharacterLoader';
import { buildTrack } from './track/TrackBuilder';
import { TrackQuery, kartBankRoll, sampleAtArcLength } from './track/TrackQuery';
import { mapById } from './track/maps';
import { getSession } from './session';
import { TUNING } from './tuning';
import { LapTracker, TOTAL_LAPS, createLapProgress, type LapProgress } from './race/LapTracker';
import { RaceDirector } from './race/RaceDirector';
import { createAiState, think, type AiState } from './ai/AiDriver';
import { Effects } from './render/Effects';
import { PostFX } from './render/PostFX';
import { Quality } from './render/Quality';
import { Minimap } from './ui/Minimap';
import { damp } from '../shared/mathUtils';

const PLAYER_FINISH_DELAY_SECONDS = 1.5;
const COLLISION_HAPTIC_COOLDOWN_SECONDS = 0.3; // avoid vibration spam while wall-scraping
const BANK_ROLL_RATE = 10; // §v5: exponential damp rate for the kart visual's bank roll

interface KartEntity {
  kart: KartState;
  visual: KartVisual;
  lapProgress: LapProgress;
  ai: AiState | null;
  name: string;
  spawnS: number;
  spawnLane: number;
  colorHex: string;
  // Per-entity haptic bookkeeping (Phase 2b: up to two human entities need
  // independent cooldown/edge tracking instead of one pair of module-scope vars).
  collisionHapticCooldown: number;
  prevBoostTimer: number;
  // §stage2: per-lap times (seconds), one entry appended each time this
  // entity crosses the finish checkpoint (LapTracker.update's return value —
  // see the RACING tick below). `lastLapAt` is `raceElapsed` at the start of
  // the lap currently in progress, so lapTimes.push(raceElapsed - lastLapAt)
  // gives that lap's duration without a separate per-lap timer. Feeds the
  // finish screen (FinishScreen.ts / race/FinishResults.ts).
  lapTimes: number[];
  lastLapAt: number;
  // §v3 Track C2: the boost flare cones, parented to visual.group at build
  // time so they inherit heading/pitch/squash but not the drift-lean roll.
  boostFlare: BoostFlare;
  // §Phase 5 item 5: local track grade at this kart's position, refreshed by
  // the ground-follow step each physics tick and consumed by updateKartVisual
  // in the render loop -- reuses that tick's groundHeightAt query instead of
  // taking a second one just for the pitch visual.
  grade: number;
  // §v5 banking + jump: the visual roll this kart should take on the banked
  // road (from the same ground-follow query as `grade`; 0 while airborne),
  // and the takeoff/land hook. The character work's squash/stretch plugs in
  // here: `entity.onAirEvent = (ev) => triggerSquash(entity.visual, ev)`.
  bankRoll: number;
  onAirEvent: ((event: AirEvent) => void) | null;
  // §Phase 3: which character this entity currently shows. `driverRequestId`
  // guards the async GLB load in loadDriverFor — bumped on every
  // applyCharacterToEntity call so a slow-resolving load for a character this
  // entity no longer shows can't clobber a newer assignment.
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
// §v5 perf readout: split screen renders twice (plus post passes), so the
// per-frame draw/triangle totals are reset by hand once per frame instead.
renderer.info.autoReset = false;
app.appendChild(renderer.domElement);
// §v5 Rendering: every view goes through PostFX (one HDR target, one bloom,
// one output pass — or straight to the canvas on Low quality).
const postFX = new PostFX(renderer);

// §v4: what the start menu chose (entry.ts wrote it before importing this
// module — see session.ts for why that indirection exists). Everything below
// is built for this map and this number of seats, once.
const session = getSession();
const activeMap = mapById(session.mapId);
console.log(`[main] starting ${activeMap.name} in ${session.mode}-player mode`);

const lights = buildLights(scene);
// §v5: Q toggles High/Low (bloom, outlines, shadow-map size, DPR cap).
const quality = new Quality(app, postFX, lights.directional, () => applyRendererSizing(renderSplit()));

// §v3 Track A: the track (and its TrackQuery) must exist *before* the
// environment now — buildEnvironment's ground is no longer a flat plane, it's
// a heightfield draped over the circuit's own elevation, so it needs to query
// track heights while it builds. scene.background/fog assignment inside
// buildEnvironment is order-independent, so nothing else cares about the swap.
const track = buildTrack(activeMap);
scene.add(track.group);
// §v5: the resolved boost pads, shortcut corridor and jump come from the built
// track (TrackData carries all three).
const trackQuery = new TrackQuery(track.samples, track.totalLength, track.surfaceZones, track);

// §v5: the Capricorn Coast backdrop — sky, ocean, terrain heightfield, props.
const environment = buildEnvironment(scene, trackQuery);

// Staggered 2-2-2 grid start (Phase 2b grows this from 1-2-2 to fit a second
// human-capable kart), spaced so no pair starts closer than 2*kartRadius:
// P1/P2 side by side at the line, then two rows of two AI further back.
// `humanSlot` marks entities 0-1 as human-capable; entity 1 falls back to AI
// whenever P2 isn't active (roster locked at countdown, see lockRoster below).
// `charIndex` is the default CHARACTERS[] slot (§Phase 3: P1 = Mario, P2 =
// Luigi, the AI get Peach/Yoshi/Toad/Bowser) — overridden by the countdown AI
// reassignment in lockRoster.
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

// §Phase 3: kicks off every character's optional GLB load up front,
// non-blocking — karts already render with their procedural driver (buildKart
// seeds it synchronously), models swap in whenever each one resolves. With no
// files in public/assets/characters/ (the shipping state) each load just
// console.warns once and resolves null.
preloadAll(CHARACTERS);

function characterColorHex(def: CharacterDef): string {
  return `#${def.kartColor.toString(16).padStart(6, '0')}`;
}

// Kicks off (or re-kicks-off) the async model load for whatever character
// `entity` currently shows. `driverRequestId` guards against a stale,
// slow-resolving load clobbering a newer assignment made before it finished.
function loadDriverFor(entity: KartEntity, def: CharacterDef) {
  const requestId = ++entity.driverRequestId;
  void loadCharacterModelInstance(def).then((model) => {
    if (entity.driverRequestId !== requestId || !model) return;
    setDriver(entity.visual, def, model);
  });
}

// Rebuilds one entity's kart + driver + display name for a new character
// (initial assignment or the countdown AI reassignment in lockRoster) —
// always seeds the procedural pair immediately, then kicks off the optional
// GLB load in the background.
// §v3 Track B: setKartCharacter replaces the old setKartColor call — each
// character has their *own chassis* (Bowser's wide twin-exhaust heavy,
// Toad's mini, Peach's royal), so re-assigning has to rebuild the kart, not
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
    colorHex: characterColorHex(def),
    collisionHapticCooldown: 0,
    prevBoostTimer: 0,
    lapTimes: [],
    lastLapAt: 0,
    boostFlare,
    grade: 0,
    bankRoll: 0, // §v5
    onAirEvent: null, // §v5: see KartEntity.onAirEvent
    characterId: def.id,
    driverRequestId: 0,
  };
  loadDriverFor(entity, def);
  // §v5 jump: stretch on takeoff, squash on landing — harder landings squash more.
  // §v5 Effects: plus a dust ring on touchdown, sized by the same strength.
  entity.onAirEvent = (ev) => {
    const strength = ev === 'land' ? Math.min(2, Math.max(0.6, -entity.kart.landingVy / 8)) : 1;
    triggerSquash(entity.visual, ev, strength);
    if (ev === 'land') effects.landingPuff(i, strength);
  };
  return entity;
});
const player = entities[0]; // P1's entity — shorthand kept for the shared bits that stay P1-only (AI rubber-banding, diagnostics)

// §v3 polish (post-race showcase): autopilot brains for every kart, so the
// field keeps circulating under the cinematic camera once the race is over.
// Reuses each entity's own AiState where it has one — an AI kart keeps its
// personality and lane preference — and adds one for entity 0, which is
// human-only during a race and so carries none of its own.
const showcaseAi: AiState[] = entities.map((e, i) => e.ai ?? createAiState(GRID[i].lane));

// Phase 2b: one Player per controller slot, each owning its own input source,
// keymap, and camera rig. P1 always drives entity 0; P2 drives entity 1 only
// when active (see lockRoster) — otherwise entity 1 races as AI.
// §v5: P1 = hands (keyboard fallback), P2 = phone (keyboard fallback). The
// tracker starts immediately and never throws; if the camera is blocked or
// MediaPipe fails, HandProvider simply stays inactive and P1 is on WASD.
const groundHeightAt = (pos: THREE.Vector3) => trackQuery.groundHeightAt(pos);
const handTracker = new HandTracker();
const handProvider = new HandProvider(handTracker);
const players: [Player, Player] = [
  createPlayer(0, 0, groundHeightAt, [handProvider]),
  createPlayer(1, 1, groundHeightAt, [new PhoneProvider()]),
];
for (const p of players) p.inputSource.attachKeyboard();

// §v5/stage2 calibration gating: the level-hands step runs automatically in
// LOBBY as soon as the camera goes live, and C re-runs it. A start request
// only waits for it while hands are genuinely in play — see
// shouldWaitForCalibration.
//
// §stage2 defect fix: calibration must only ever run/feed in LOBBY — feeding
// it a mid-race steering angle (or leaving it running through a countdown)
// would bake a moving wheel angle into theta0. Feeding is gated here; the
// cancel-on-leave-LOBBY half of the fix lives in raceDirector's
// onStateChange above (every non-LOBBY state cancels it outright).
const calibration = new Calibration();
calibration.onDone = (theta0) => handProvider.setTheta0(theta0);
handProvider.onDetection((d) => {
  if (raceDirector.state === 'LOBBY') calibration.feed(d.t, d.theta);
});
handTracker.onStatus((status) => {
  if (status === 'live' && raceDirector.state === 'LOBBY') calibration.start();
  else if (status !== 'live' && status !== 'starting') calibration.cancel();
});
let startPendingCalibration = false;
void handTracker.start(); // after the listeners above, so no status edge is missed

// Keyboard players never wait: only when the camera is live, P1 isn't on the
// keyboard, and a hand has actually been seen recently (a webcam pointed at an
// empty chair must not block the start forever).
function shouldWaitForCalibration(now: number): boolean {
  return (
    calibration.running &&
    handTracker.live &&
    !players[0].inputSource.isKeyboardActive(now) &&
    handProvider.filter.handsSeen(now, 1500)
  );
}

function requestStartWhenReady() {
  if (shouldWaitForCalibration(performance.now())) startPendingCalibration = true;
  else raceDirector.requestStart();
}

// §v3 polish: the post-race camera. Takes over the whole window in FINISHED
// (see renderSplit below) and cuts between shot types until RESTART.
const cinematic = new CinematicCamera(groundHeightAt);

function entityFor(p: Player): KartEntity {
  return entities[p.entityIndex];
}

// Roster locks at the moment countdown begins (Phase 2b): P2 drives entity 1
// for this race iff it's connected or driving via keyboard right now;
// otherwise entity 1 runs as AI for the whole race, even if P2 joins mid-race.
// §Phase 3: also hands out characters to every AI-driven entity at this same
// moment — whatever the active humans aren't currently showing, in
// CHARACTERS[] order, assigned to AI entities in ascending index order.
// Recomputed fresh every countdown since lobby picks can change race to race.
function lockRoster() {
  // §v4/stage2: the second seat exists because the player picked versus mode
  // on the start menu, not because a second phone happened to connect. That
  // is what lets the lobby split the screen and show a QR before anyone has
  // joined; an empty P2 seat simply races on keyboard (requestStartWhenReady
  // never blocks on it — see the brief's "versus never blocks").
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
// §v5: the cap itself now comes from the quality level (render/Quality.ts —
// 2 solo / TUNING.splitPixelRatioCap split on High, 1 on Low), and the post
// targets + particle sprite scale follow the drawing buffer.
const drawingBufferSize = new THREE.Vector2();
function applyRendererSizing(split: boolean) {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality.pixelRatioCap(split)));
  renderer.setSize(window.innerWidth, window.innerHeight);
  postFX.setSize();
  effects.setBufferHeight(renderer.getDrawingBufferSize(drawingBufferSize).y);
  applyCameraAspects(split);
}

// §Phase 11 juice: pooled drift-spark particles, minimap. (§v5: the game is
// completely silent — the WebAudio engine hum was removed.) §v5 Effects: the
// sparks are now one of render/Effects.ts' pooled effects (sparks, boost
// trails, dust, landing puffs, speed lines).
const effects = new Effects(scene, trackQuery, entities);
const minimap = new Minimap(app, track.samples, track.shortcut?.samples);

/// Shared seconds accumulator for the render-loop-only animations (the
// environment's water/props, boost-flare flicker). Advanced once per frame by
// renderDt.
let animClock = 0;

const lapTracker = new LapTracker(track.checkpoints, track.samples, track.totalLength);

let finishCounter = 0;
let playerFinishTimer: number | null = null;
// §stage2: seconds since 'go' (RACING start) this race, advanced only while
// racing and reset by resetRace(). Feeds per-lap timing (KartEntity.lapTimes)
// for the finish screen — lap N's duration is raceElapsed - lastLapAt at the
// moment that lap's finish-checkpoint crossing is detected.
let raceElapsed = 0;

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
    e.lapProgress = createLapProgress(0);
    if (e.ai) {
      e.ai.stuckTimer = 0;
      e.ai.wallScrapeTimer = 0;
      e.ai.driftHeld = false;
    }
    e.kart.boostCooldown = 0;
    e.kart.prevBoostInput = 0;
    e.collisionHapticCooldown = 0;
    e.prevBoostTimer = 0;
    e.lapTimes = [];
    e.lastLapAt = 0;
    e.grade = 0;
    groundKart(e.kart, trackQuery.groundHeightAt(pos)); // §v5 jump: no leftover airtime/vy
    e.bankRoll = 0;
    // §v3 Track C2: clear any in-flight boost pop so a restart never starts
    // with a stretched kart or a lit exhaust.
    e.visual.boostPopTimer = 0;
    e.visual.group.scale.set(1, 1, 1);
    e.boostFlare.group.visible = false;
  }
  // §v3 Track C2 review fix: the boost FOV kick lives on the camera, not on
  // the entity, so it needs clearing here too — otherwise a restart pressed
  // moments after a boost widens the lobby/countdown view and eases back over
  // the next second (the kick decays exponentially and never snaps).
  for (const p of players) p.followCamera.resetFov();
  effects.clear(); // §v5: no sparks/trails/dust carried over the restart
  // Covers each entity's own AiState too (showcaseAi reuses those objects) —
  // the extra brain for entity 0 is the only one the loop above misses.
  for (const ai of showcaseAi) {
    ai.stuckTimer = 0;
    ai.wallScrapeTimer = 0;
    ai.driftHeld = false;
  }
  finishCounter = 0;
  playerFinishTimer = null;
  raceElapsed = 0;
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

window.addEventListener('resize', () => applyRendererSizing(renderSplit()));

// --- Networking + input --------------------------------------------------

const hud = new Hud(app);
// One PlayerHud per human seat (Phase 2c): P1's spans the full screen solo,
// or the left half split; P2's stays hidden until it's actually racing.
const playerHuds: [PlayerHud, PlayerHud] = [new PlayerHud(app, 0), new PlayerHud(app, 1)];
playerHuds[1].setLayout('hidden');
const finishScreen = new FinishScreen(app);
const diagnostics = new Diagnostics(app);
// §v5: P1's hand preview/readout and the calibration ring. H (DebugToggle)
// hides the overlay + diagnostics for clean recording; the ring stays.
const handOverlay = new HandOverlay(app, handTracker, handProvider, players[0].inputSource);
const calibrationPrompt = new CalibrationPrompt(app, calibration);
attachDebugToggle();
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
    case 'FINISHED':
      return 'finished';
  }
}

const raceDirector = new RaceDirector({
  onEvent: (name) => socket?.sendEvent(name), // broadcast (no slot) — a no-op in solo, which never has a socket
  onStateChange: (state) => {
    if (state === 'LOBBY') {
      resetRace();
      players[1].active = false; // re-locked fresh by lockRoster() at the next countdown
      finishScreen.hide();
      // Already-completed calibration (theta0) survives a restart untouched —
      // only a fresh camera-live edge or the C key runs the hold again (see
      // handTracker.onStatus and the KeyC handler below). But if the camera
      // was ALREADY live before this LOBBY entry (e.g. a restart, or the race
      // was started before the camera came up) and calibration never
      // actually completed, handTracker.onStatus's 'live' edge already fired
      // and won't fire again — so it must be (re)started here too, or a
      // hands player can end up racing forever without ever calibrating.
      if (handTracker.live && calibration.theta0 === null) calibration.start();
    } else {
      // §stage2 defect fix: calibration only ever runs/feeds in LOBBY — a
      // mid-race steering angle must never bleed into theta0 (see the
      // handProvider.onDetection feed-gate below).
      calibration.cancel();
      startPendingCalibration = false;
    }
    if (state === 'COUNTDOWN') lockRoster();
    if (state === 'RACING') hud.flashGo();
    if (state === 'FINISHED') {
      // §v3 polish: the winner and whoever was actually driving get most of
      // the screen time; the rest of the field still shows up between them.
      const winner = [...entities].sort(comparePosition)[0];
      const preferred = new Set<number>([entities.indexOf(winner)]);
      for (const p of players) if (p.active) preferred.add(p.entityIndex);
      cinematic.reset([...preferred]);

      const ranked = [...entities].sort(comparePosition);
      const results: FinishPlayerResult[] = players
        .filter((p) => p.active)
        .map((p) => {
          const e = entityFor(p);
          return {
            slot: p.slot,
            name: e.name,
            colorHex: playerColor(p.slot), // the HUD's P1 red / P2 green, not the kart livery
            position: ranked.indexOf(e) + 1,
            lapTimes: e.lapTimes,
          };
        });
      finishScreen.show(session.mode, results);
    }
  },
});

// §stage2: versus opens the relay socket lazily (only when the mode needs
// it); solo never touches the network at all, per the brief. Every call site
// below uses `socket?.` so solo — where `socket` is null — just no-ops them.
const socket: GameSocket | null =
  session.mode === 'multi'
    ? new GameSocket({
        onRoom: (code, joinUrl) => hud.showRoom(code, joinUrl),
        onStatus: (status) => {
          hud.setConnectionStatus(status);
          // The relay itself is unreachable (not just "no phone yet") the
          // moment the very first connection attempt fails — same signal
          // GameSocket uses to start its own backoff retry loop.
          hud.setPhoneUnreachable(status === 'reconnecting');
        },
        onRtt: (rtt) => {
          lastRttMs = rtt;
        },
        onPeer: (event, slot) => {
          const s = slot ?? 1; // §v5/stage2: the only controller slot is P2 (PHONE_SLOT)
          const wasConnected = players[s].connected;
          players[s].connected = event === 'controller-joined';
          hud.setPeerStatus(players[s].connected);
          // §stage2: a phone that drops mid-race falls back to keyboard the
          // moment PhoneProvider goes stale (InputSource's normal priority —
          // nothing here needs to force it) — this is purely the on-screen
          // notice, held briefly in P2's half.
          if (event === 'controller-left' && wasConnected && raceDirector.state !== 'LOBBY') {
            playerHuds[1].showNotice('Phone disconnected — P2 on keyboard', 3000);
          }
          // A controller that (re)joins mid-race defaults to the lobby look
          // (ui.ts's onJoined); if the race has already moved past LOBBY,
          // push the current RaceDirector state to just that slot so it lands
          // on the right screen instead of being stuck on "ready when you are".
          if (event === 'controller-joined' && raceDirector.state !== 'LOBBY') {
            socket?.sendEvent(raceStateToEvent(raceDirector.state), s);
          }
        },
        onInput: (snapshot) => {
          // §v5: P1 is hands/keyboard only, so the one phone drives P2.
          players[1].inputSource.onSnapshot(snapshot);
        },
        onEvent: (name) => {
          // Either controller's start/restart is honored (Phase 2b) — the sender's
          // slot (server-stamped) doesn't gate these, both act on the shared race state.
          if (name === 'start') requestStartWhenReady();
          // §defect-fix: ignore RESTART until the finish screen's ≥4s hold is
          // over — otherwise a phone tap the instant results appear skips
          // past them before anyone can read them.
          else if (name === 'restart' && finishScreen.holdComplete) raceDirector.requestRestart();
        },
      })
    : null;

// §v5: Space (P1 boost) and Enter (P2 boost) also start the race — only in
// LOBBY, since requestStart is a no-op anywhere else, so mid-race they are
// purely boosts. C re-runs hand calibration from the lobby. M reloads back to
// the start menu (a full reload is simplest and guarantees a clean world).
window.addEventListener('keydown', (e) => {
  if (raceDirector.state === 'LOBBY' && !e.repeat) {
    if (e.code === 'Space' || e.code === 'Enter' || e.code === 'NumpadEnter') requestStartWhenReady();
    if (e.code === 'KeyC' && handTracker.live) {
      calibration.start();
      startPendingCalibration = false;
    }
  }
  // §defect-fix: same ≥4s hold gate as the phone's RESTART, above.
  if (e.code === 'KeyR' && finishScreen.holdComplete) raceDirector.requestRestart();
  if (e.code === 'KeyM') location.href = location.pathname;
});

// --- Fixed-timestep physics + rAF render ----------------------------------

const sampledControls: ControlState[] = [NEUTRAL_CONTROL, NEUTRAL_CONTROL]; // indexed by PlayerSlot, refreshed each tick
let lastRenderTime = performance.now();
let lastLayoutKey: string | null = null; // forces the first frame to apply sizing/layout
const shadowMidpoint = new THREE.Vector3(); // reused each frame by the shadow-camera-follow block below
let lastRenderCpuMs = 0; // §v5 perf readout: the render callback's own JS time, last frame

// §v5 perf: compile every material's program now, under the loading curtain
// (entry.ts holds it until the first frames are out), for both the HDR-target
// and the canvas path — otherwise the first boost trail / drift spark / Q
// toggle would stall a frame compiling its shader mid-race.
applyRendererSizing(isSplit());
postFX.compile(scene, players[0].camera);

startLoop(
  (dt) => {
    const now = performance.now();
    raceDirector.tick(dt);

    // §v5: every seat is sampled exactly once per tick whatever the race
    // state — the hand filter's smoothing and one-shot thumbs-up boost advance per
    // sample, and the overlay shows live values in the lobby too.
    sampledControls[0] = players[0].inputSource.sample(now);
    sampledControls[1] = players[1].inputSource.sample(now);

    if (startPendingCalibration) {
      if (raceDirector.state !== 'LOBBY') startPendingCalibration = false;
      else if (!shouldWaitForCalibration(now)) {
        startPendingCalibration = false;
        raceDirector.requestStart();
      }
    }

    const racing = raceDirector.state === 'RACING';
    // §v3 polish: the post-race showcase. Physics keeps stepping and every
    // kart drives itself (see the control selection below), which is what the
    // cinematic camera is pointed at. Everything else gated on `racing` —
    // lap/finish bookkeeping, haptics — stays off, so the
    // results standing behind the show can't change while it plays.
    const showcase = raceDirector.state === 'FINISHED';

    if (racing) raceElapsed += dt;

    const hitWallThisTick: boolean[] = new Array(entities.length).fill(false);

    for (let i = 0; i < entities.length; i++) {
      const e = entities[i];
      const preSample = trackQuery.nearestSample(e.kart.pos);
      const offRoad = preSample.offRoad; // §v5 review #3: the shortcut's dirt mouths aren't grass
      const onWall = Math.abs(preSample.lateral) >= preSample.wallHalf - TUNING.kartRadius; // §v5: per-corridor wall

      // Roster is locked at countdown (lockRoster): entity 0 is always P1,
      // entity 1 is P2 only when active, everything else is always AI.
      const drivingPlayer = i === 0 ? players[0] : i === 1 && players[1].active ? players[1] : null;

      let control: ControlState;
      let topSpeedScale = 1;

      if (!racing && !showcase) {
        control = NEUTRAL_CONTROL;
      } else if (racing && drivingPlayer) {
        // §v5: every human source (keys, phone, hands) speaks "+1 = screen
        // right", but stepKart's yaw is +heading, which in this camera/axis
        // frame swings the nose to screen LEFT (kartRight() is the driver's
        // visual left). The AI steers in the physics convention natively, so
        // the flip lives here, at the one human -> physics boundary.
        const human = sampledControls[drivingPlayer.slot];
        control = { ...human, steer: -human.steer };
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
        // §v5 review #1: a recovery teleport lands on the centreline's height;
        // plant it on the (banked) ground under its lane with no vy.
        if (result.teleported) groundKart(e.kart, trackQuery.groundHeightAt(e.kart.pos));
      }

      const surface = trackQuery.surfaceUnder(preSample); // §v5: 'dirt' on the shortcut and its mouths
      const cooldownBefore = e.kart.boostCooldown;
      stepKart(e.kart, control, dt, offRoad, topSpeedScale, surface);
      hitWallThisTick[i] = resolveWallCollision(e.kart, trackQuery);
      // §v5: a manual boost just fired (the kart re-arms its cooldown only
      // then) — the squash-and-stretch pop and the FOV kick.
      if (e.kart.boostCooldown > cooldownBefore) {
        triggerBoostPop(e.visual);
        if (drivingPlayer) drivingPlayer.followCamera.kickFov();
      }
    }

    const kartKartHits = resolveKartKartCollisions(
      entities.map((e) => e.kart),
      dt,
    );

    // §Phase 5 item 4: ground-follow, after stepping + both collision passes
    // have settled this tick's x/z position. `stepKart` never touches pos.y
    // itself (design principle: physics stays 2D-projected). §v5 jump: y is
    // now integrated by stepVertical — glued to the (banked) ground, or on a
    // ballistic arc after the ground drops away under it (the rail-crossing
    // lip) — instead of damped toward the ground. The same query's `grade` and
    // bank are stashed on the entity for the render loop's pitch and roll so
    // that doesn't need a second nearestSample call.
    for (const e of entities) {
      const groundSample = trackQuery.nearestSample(e.kart.pos);
      const airEvent = stepVertical(e.kart, groundSample.groundY, dt);
      if (airEvent) e.onAirEvent?.(airEvent);
      e.grade = visualGrade(e.kart, groundSample.grade); // §v5 review #4: flight path while airborne
      e.bankRoll = e.kart.airborne ? 0 : kartBankRoll(groundSample.bank, groundSample.forward, e.kart.heading);
    }

    // §Phase 11d haptic cues, now per active human player (Phase 2b) — each
    // phone only feels its own hits/boosts. (§v5: no audio cues any more.)
    for (const p of players) {
      if (!p.active) continue;
      const e = entityFor(p);
      e.collisionHapticCooldown = Math.max(0, e.collisionHapticCooldown - dt);
      const collided = hitWallThisTick[p.entityIndex] || kartKartHits.has(p.entityIndex);
      if (racing && collided && e.collisionHapticCooldown <= 0) {
        socket?.sendEvent('collision', p.slot);
        e.collisionHapticCooldown = COLLISION_HAPTIC_COOLDOWN_SECONDS;
        // §v5 Effects: this player's own camera jolts, harder the faster the
        // hit (post-impact speed, so a wall's speed penalty is already in it).
        // Only human seats get here, so AI-only bumps never shake anyone.
        p.followCamera.addTrauma(0.3 + 0.55 * Math.min(1, Math.abs(e.kart.speed) / TUNING.topSpeed));
      }
      if (racing && e.kart.boostTimer > 0 && e.prevBoostTimer <= 0) {
        socket?.sendEvent('boost', p.slot);
      }
      e.prevBoostTimer = e.kart.boostTimer;
    }

    if (racing) {
      for (const e of entities) {
        const q = trackQuery.nearestSample(e.kart.pos);
        const wasFinished = e.lapProgress.finished;
        const lapCompleted = lapTracker.update(e.lapProgress, q.s);
        if (lapCompleted) {
          e.lapTimes.push(raceElapsed - e.lastLapAt);
          e.lastLapAt = raceElapsed;
        }
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

    for (const e of entities) {
      updateKartVisual(e.visual, e.kart, renderDt, e.grade);
      // §v5 banking: roll the whole kart with the road (YXZ order, so this is
      // a local roll about the kart's own forward axis).
      e.visual.group.rotation.z = damp(e.visual.group.rotation.z, e.bankRoll, BANK_ROLL_RATE, renderDt);
    }

    // §v3 Track C2: the exhaust flare, driven off kart.boostTimer (drift
    // release, pad or manual boost) and advanced with renderDt, so nothing
    // here can feed back into the simulation.
    for (const e of entities) {
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
      // §defect-fix (item 12): P1's hand-overlay preview lives bottom-left,
      // inside P1's half once the screen actually splits — cap its width so
      // the now-larger preview can't grow into P2's half.
      handOverlay.setSplitScreen(split);
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

    // §Phase 11a / §v5 Effects: tier-coloured drift sparks, boost trails,
    // dust, speed-line drive — all pooled, allocation-free (render/Effects.ts).
    effects.update(renderDt);

    // Minimap stays one shared instance; both active human dots get the
    // bigger highlighted treatment, distinguished from each other by their
    // own kart color (§Phase 2c).
    const activeHumanEntities = new Set(players.filter((p) => p.active).map((p) => entityFor(p)));
    minimap.update(
      entities.map((e) => ({ pos: e.kart.pos, color: e.colorHex, isPlayer: activeHumanEntities.has(e) })),
    );

    const ranked = [...entities].sort(comparePosition);
    const maxTierTime = TUNING.driftTierTimes[TUNING.driftTierTimes.length - 1];

    // Per-player readouts (Phase 2c): drift bar + input-kind label update
    // every frame regardless of race state; lap/pos/speed is gated by race
    // state below.
    for (const p of players) {
      const ph = playerHuds[p.slot];
      // §defect-fix: versus shows P2's half from the lobby onward (isSplit()),
      // well before the roster lock makes p.active true at countdown (see
      // lockRoster) — gating the input-kind label on `active` left P2's half
      // showing no label at all until the race actually started. The label
      // only needs a live input source, not an active race seat, so it
      // updates whenever that half of the screen is showing.
      if (p.active || (p.slot === 1 && isSplit())) {
        ph.setInputLabel(p.inputSource.activeKind(now));
      }
      if (!p.active) continue;
      const e = entityFor(p);
      const driftActive = e.kart.drift.phase === 'active';
      ph.setDriftCharge(driftActive, driftTier(e.kart.drift.charge), e.kart.drift.charge / maxTierTime);
    }

    switch (raceDirector.state) {
      case 'LOBBY':
        hud.showLobby();
        hud.hideCountdown();
        hud.setReadyHint(calibration.running ? null : 'Press SPACE to race');
        for (const ph of playerHuds) ph.hideRaceInfo();
        break;
      case 'COUNTDOWN':
        hud.hideLobby();
        hud.setReadyHint(null);
        hud.showCountdown(String(Math.max(1, Math.ceil(raceDirector.countdownRemaining))));
        break;
      case 'RACING':
        hud.hideLobby();
        // NOT hud.hideCountdown() here — the COUNTDOWN->RACING edge already
        // fired hud.flashGo() (see raceDirector's onStateChange above), which
        // shows "GO" and hides itself on its own short timer. Calling
        // hideCountdown() unconditionally on every RACING frame would cancel
        // that flash before it's even visible.
        hud.setReadyHint(null);
        for (const p of players) {
          if (!p.active) continue;
          const e = entityFor(p);
          const position = ranked.indexOf(e) + 1;
          playerHuds[p.slot].setRaceInfo(e.lapProgress.lap, TOTAL_LAPS, e.kart.speed * 3.6, position, entities.length);
        }
        break;
      case 'FINISHED':
        hud.hideCountdown();
        hud.setReadyHint(null);
        break;
    }

    handOverlay.update(now);
    calibrationPrompt.update();

    // §v5: P1 is never on a phone now, so the diagnostics' phone fields
    // (age/seq/steer mode) follow P2's source instead.
    const diag = players[0].inputSource.diagnostics(now);
    const diagP2 = players[1].inputSource.diagnostics(now);
    diagnostics.update({
      rttMs: lastRttMs,
      inputAgeMs: diagP2.ageMs,
      seq: diagP2.seq,
      source: `P1 ${diag.source} · P2 ${diagP2.source}`,
      raceState: raceDirector.state,
      lap: player.lapProgress.lap,
      nextCheckpoint: player.lapProgress.nextCheckpoint,
      stepsThisFrame,
      detectMs: handTracker.live ? handTracker.detectMs : null,
      detectHz: handTracker.live ? handTracker.measuredHz : null,
      targetHz: handTracker.live ? handTracker.targetHz : null,
      handStatus: handTracker.delegate ? `${handTracker.status} (${handTracker.delegate})` : handTracker.status,
      handLeft: handProvider.filter.lastDetection?.left ?? null,
      handRight: handProvider.filter.lastDetection?.right ?? null,
      // §v5 perf: last frame's totals (info is reset just below, per frame).
      drawCalls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      cpuMs: lastRenderCpuMs,
      quality: quality.high ? 'High' : 'Low',
    });
    renderer.info.reset();

    // §Phase 4 finding #2: with autoUpdate off, the shadow pass only runs
    // when needsUpdate is set — do it once here rather than let it run (or
    // not) implicitly inside each render() call below.
    renderer.shadowMap.needsUpdate = true;

    // §v5: both views go through PostFX (one HDR target on High, the canvas
    // directly on Low), then one bloom + output pass for the whole frame.
    // effects.setView points the speed lines at the kart whose view is next.
    if (split) {
      effects.setView(players[0].entityIndex);
      postFX.renderView(scene, players[0].camera, 0, 2);
      effects.setView(players[1].entityIndex);
      postFX.renderView(scene, players[1].camera, 1, 2);
    } else {
      effects.setView(showcase ? -1 : players[0].entityIndex);
      postFX.renderView(scene, showcase ? cinematic.camera : players[0].camera, 0, 1);
    }
    postFX.finish();
    lastRenderCpuMs = performance.now() - now;
  },
);
