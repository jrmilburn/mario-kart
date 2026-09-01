import * as THREE from 'three';
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
  setKartColor,
  updateKartVisual,
  buildItemBoxMesh,
  buildBananaMesh,
  buildShellMesh,
  type KartVisual,
} from './render/SceneBuilder';
import { buildEnvironment } from './render/Environment';
import { CHARACTERS, CHARACTERS_BY_ID, type CharacterDef } from './characters/registry';
import { loadCharacterModelInstance, preloadAll } from './characters/CharacterLoader';
import { buildTrack } from './track/TrackBuilder';
import { TrackQuery, sampleAtArcLength } from './track/TrackQuery';
import { GRASS_HALF, ROAD_HALF } from './track/trackData';
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
  type ItemBoxState,
  type HeldItemState,
  type Banana,
  type Shell,
} from './items/ItemSystem';
import { DriftSparks } from './render/DriftSparks';
import { EngineAudio } from './audio/EngineAudio';
import { Minimap } from './ui/Minimap';

const NEUTRAL_CONTROL: ControlState = { steer: 0, throttle: 0, brake: 0, drift: 0, item: 0 };
const PLAYER_FINISH_DELAY_SECONDS = 1.5;
const COLLISION_HAPTIC_COOLDOWN_SECONDS = 0.3; // avoid vibration spam while wall-scraping

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

const lights = buildLights(scene);
buildEnvironment(scene); // §Phase 4 item 2: sky dome, mountains, clouds, fog, ground plane

const track = buildTrack();
scene.add(track.group);
const trackQuery = new TrackQuery(track.samples, track.totalLength);

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

// Rebuilds one entity's driver + kart color + display name for a new
// character (initial assignment, a select pick, or the countdown AI
// reassignment in lockRoster) — always seeds the fallback immediately, then
// kicks off the real model load in the background.
function applyCharacterToEntity(entity: KartEntity, def: CharacterDef) {
  entity.characterId = def.id;
  entity.name = def.name;
  entity.colorHex = characterColorHex(def);
  setKartColor(entity.visual, def.kartColor);
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
    characterId: def.id,
    driverRequestId: 0,
  };
  loadDriverFor(entity, def);
  return entity;
});
const player = entities[0]; // P1's entity — shorthand kept for the shared/engine-audio bits that stay P1-only

// Phase 2b: one Player per controller slot, each owning its own input source,
// keymap, and camera rig. P1 always drives entity 0; P2 drives entity 1 only
// when active (see lockRoster) — otherwise entity 1 races as AI.
const players: [Player, Player] = [createPlayer(0, 0), createPlayer(1, 1)];
for (const p of players) p.inputSource.attachKeyboard();

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
  const now = performance.now();
  players[1].active = players[1].connected || players[1].inputSource.isKeyboardActive(now);

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

// Split-screen (Phase 2c) mirrors the roster lock exactly: two active
// players -> two half-screen viewports; one -> the original full-screen path.
function isSplit(): boolean {
  return players[0].active && players[1].active;
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
const itemBoxVisuals = itemBoxes.map((box) => {
  const mesh = buildItemBoxMesh();
  mesh.position.copy(track.samples[box.sampleIdx].pos).add(new THREE.Vector3(0, 0.6, 0));
  scene.add(mesh);
  return mesh;
});
const bananas: Banana[] = [];
const shells: Shell[] = [];
const bananaVisuals = new Map<Banana, THREE.Mesh>();
const shellVisuals = new Map<Shell, THREE.Mesh>();

const lapTracker = new LapTracker(track.checkpoints, track.samples, track.totalLength);

let finishCounter = 0;
let playerFinishTimer: number | null = null;

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
  }
  for (const box of itemBoxes) {
    box.active = true;
    box.respawnTimer = 0;
  }
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

window.addEventListener('resize', () => applyRendererSizing(isSplit()));

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
    if (name === 'start') raceDirector.requestStart();
    else if (name === 'restart') raceDirector.requestRestart();
  },
  onSelect: (characterId, slot) => trySelectCharacter(slot ?? 0, characterId),
});
void socket;

window.addEventListener('keydown', (e) => {
  if (e.code === 'Enter') raceDirector.requestStart();
  if (e.code === 'KeyR') raceDirector.requestRestart();
  if (raceDirector.state === 'PAUSED') raceDirector.notifyInputRecovered(allActiveControllersFresh(performance.now()));
});

// --- Fixed-timestep physics + rAF render ----------------------------------

let lastRenderTime = performance.now();
let lastSplitState: boolean | null = null; // forces the first frame to apply sizing/layout
const shadowMidpoint = new THREE.Vector3(); // reused each frame by the shadow-camera-follow block below

startLoop(
  (dt) => {
    const now = performance.now();
    raceDirector.tick(dt, activeControllerAges(now));

    if (raceDirector.state === 'PAUSED') return; // physics frozen entirely

    const racing = raceDirector.state === 'RACING';
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

      if (!racing) {
        control = NEUTRAL_CONTROL;
      } else if (drivingPlayer) {
        control = drivingPlayer.inputSource.sample(now);
      } else if (e.ai) {
        const result = think(
          e.ai,
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
      } else {
        control = NEUTRAL_CONTROL; // unreachable: every non-human entity carries an AiState
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
          useItem({
            kartIndex: i,
            kart: e.kart,
            held: e.itemState,
            bananas,
            shells,
            targetIndex: findNextAhead(i),
            fireS: trackQuery.nearestSample(e.kart.pos).s,
          });
        }
      }
    }

    const kartKartHits = resolveKartKartCollisions(
      entities.map((e) => e.kart),
      dt,
    );

    if (racing) {
      updateBananas(bananas, entities.map((e) => e.kart));
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

    for (const e of entities) updateKartVisual(e.visual, e.kart, renderDt);

    // Split-screen layout/sizing only needs to change when the roster lock
    // (isSplit) actually flips — not recomputed every frame (§Phase 2c).
    const split = isSplit();
    if (split !== lastSplitState) {
      lastSplitState = split;
      applyRendererSizing(split);
      hud.setSplit(split);
      playerHuds[0].setLayout(split ? 'left' : 'solo');
      playerHuds[1].setLayout(split ? 'right' : 'hidden');
    }

    players[0].followCamera.update(entityFor(players[0]).kart, renderDt);
    if (split) players[1].followCamera.update(entityFor(players[1]).kart, renderDt);

    // §Phase 4 item 3: shadow camera re-centers on the active players'
    // midpoint every frame (light keeps its fixed relative offset) so the
    // ortho shadow box always covers whoever's actually racing. Loop instead
    // of players.filter(...) to avoid an allocation every frame (§Phase 4
    // finding #4).
    shadowMidpoint.set(0, 0, 0);
    let activeShadowCount = 0;
    for (const p of players) {
      if (!p.active) continue;
      shadowMidpoint.add(entityFor(p).kart.pos);
      activeShadowCount++;
    }
    shadowMidpoint.divideScalar(activeShadowCount || 1);
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
      sparkPos.y = 0.3;
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

    // Item box visuals: rotate continuously, hide while respawning.
    itemBoxes.forEach((box, i) => {
      const mesh = itemBoxVisuals[i];
      mesh.visible = box.active;
      mesh.rotation.y += renderDt * 1.5;
    });

    // Sync banana/shell meshes to their live-object arrays (create/remove as needed).
    syncProjectileVisuals(bananas, bananaVisuals, buildBananaMesh, scene);
    syncProjectileVisuals(shells, shellVisuals, buildShellMesh, scene);

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
      const heldDisplay = e.itemState.rouletteTimer > 0 ? e.itemState.rouletteDisplay : e.itemState.item;
      ph.setHeldItem(heldDisplay);
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
      renderer.render(scene, players[0].camera);
    }
  },
);
