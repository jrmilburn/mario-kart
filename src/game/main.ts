import * as THREE from 'three';
import { CONTROLLER_ABSENT_MS, type PlayerSlot } from '../shared/protocol';
import { GameSocket } from './net/GameSocket';
import { type ControlState } from './input/InputSource';
import { createPlayer, type Player } from './player/Player';
import { Hud } from './ui/Hud';
import { Diagnostics } from './ui/Diagnostics';
import { startLoop } from './core/loop';
import { createKart, driftTier, kartForward, stepKart, type KartState } from './physics/Kart';
import { resolveWallCollision, resolveKartKartCollisions } from './physics/collision';
import {
  buildGround,
  buildLights,
  buildKart,
  updateKartVisual,
  buildItemBoxMesh,
  buildBananaMesh,
  buildShellMesh,
  type KartVisual,
} from './render/SceneBuilder';
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
}

const app = document.getElementById('app')!;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x6ec6ff); // bright cheerful sky blue
scene.fog = new THREE.Fog(0x6ec6ff, 70, 260);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
app.appendChild(renderer.domElement);

buildLights(scene);
buildGround(scene);

const track = buildTrack();
scene.add(track.group);
const trackQuery = new TrackQuery(track.samples, track.totalLength);

// Staggered 2-2-2 grid start (Phase 2b grows this from 1-2-2 to fit a second
// human-capable kart), spaced so no pair starts closer than 2*kartRadius:
// P1/P2 side by side at the line, then two rows of two AI further back.
// `humanSlot` marks entities 0-1 as human-capable; entity 1 falls back to AI
// whenever P2 isn't active (roster locked at countdown, see lockRoster below).
const GRID: { name: string; color: number; s: number; lane: number; humanSlot?: PlayerSlot }[] = [
  { name: 'P1', color: 0xff6b35, s: 0, lane: -1.2, humanSlot: 0 },
  { name: 'P2', color: 0x3498db, s: 0, lane: 1.2, humanSlot: 1 },
  { name: 'AI 1', color: 0x2ecc71, s: -4, lane: -2 },
  { name: 'AI 2', color: 0xf1c40f, s: -4, lane: 0.7 },
  { name: 'AI 3', color: 0x9b59b6, s: -8, lane: 2 },
  { name: 'AI 4', color: 0xe74c3c, s: -8, lane: -0.7 },
];

function spawnPose(sOffset: number, lane: number): { pos: THREE.Vector3; heading: number } {
  const sample = sampleAtArcLength(track.samples, track.totalLength, sOffset);
  const pos = sample.pos.clone().addScaledVector(sample.right, lane);
  const heading = Math.atan2(sample.forward.x, sample.forward.z);
  return { pos, heading };
}

const entities: KartEntity[] = GRID.map((g, i) => {
  const { pos, heading } = spawnPose(g.s, g.lane);
  const isAi = g.humanSlot === undefined;
  const kart = createKart(pos, heading, isAi);
  const visual = buildKart(g.color);
  scene.add(visual.group, visual.shadow);
  return {
    kart,
    visual,
    lapProgress: createLapProgress(0),
    ai: i === 0 ? null : createAiState(g.lane), // entity 0 (P1) is never AI; entity 1 carries a fallback AiState
    name: g.name,
    spawnS: g.s,
    spawnLane: g.lane,
    itemState: createHeldItemState(),
    prevItemInput: 0 as const,
    colorHex: `#${g.color.toString(16).padStart(6, '0')}`,
    collisionHapticCooldown: 0,
    prevBoostTimer: 0,
  };
});
const player = entities[0]; // P1's entity — still the sole HUD/engine-audio/camera reference until Phase 2c

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

// Roster locks at the moment countdown begins (Phase 2b): P2 drives entity 1
// for this race iff it's connected or driving via keyboard right now;
// otherwise entity 1 runs as AI for the whole race, even if P2 joins mid-race.
function lockRoster() {
  const now = performance.now();
  players[1].active = players[1].connected || players[1].inputSource.isKeyboardActive(now);
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

window.addEventListener('resize', () => {
  // Phase 2b: still solo full-screen (split-screen viewport/aspect handling
  // lands in Phase 2c) — only P1's camera renders today.
  players[0].camera.aspect = window.innerWidth / window.innerHeight;
  players[0].camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- Networking + input --------------------------------------------------

const hud = new Hud(app);
const diagnostics = new Diagnostics(app);
let lastRttMs: number | null = null;

const raceDirector = new RaceDirector({
  onEvent: (name) => socket.sendEvent(name), // broadcast to both controllers (no slot)
  onStateChange: (state) => {
    if (state === 'LOBBY') resetRace();
    if (state === 'COUNTDOWN') lockRoster();
  },
});

const socket = new GameSocket({
  onRoom: (code, joinUrl) => hud.showRoom(code, joinUrl),
  onStatus: (status) => hud.setConnectionStatus(status),
  onRtt: (rtt) => {
    lastRttMs = rtt;
  },
  onPeer: (event, slot) => {
    const s = slot ?? 0;
    players[s].connected = event === 'controller-joined';
    if (event === 'controller-joined') hud.setPeerConnected(true);
    else hud.setPeerConnected(false);
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
});
void socket;

window.addEventListener('keydown', (e) => {
  if (e.code === 'Enter') raceDirector.requestStart();
  if (e.code === 'KeyR') raceDirector.requestRestart();
  if (raceDirector.state === 'PAUSED') raceDirector.notifyInputRecovered(allActiveControllersFresh(performance.now()));
});

// --- Fixed-timestep physics + rAF render ----------------------------------

let lastRenderTime = performance.now();

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

      stepKart(e.kart, control, dt, offRoad, topSpeedScale);
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
    // Phase 2b: still solo full-screen — split-screen rendering with both
    // players' cameras lands in Phase 2c.
    players[0].followCamera.update(player.kart, renderDt);

    const driftActive = player.kart.drift.phase === 'active';
    const maxTierTime = TUNING.driftTierTimes[TUNING.driftTierTimes.length - 1];
    hud.setDriftCharge(driftActive, driftTier(player.kart.drift.charge), player.kart.drift.charge / maxTierTime);

    // §Phase 11a/b: drift sparks tinted by tier, engine pitch mapped to speed.
    for (const e of entities) {
      if (e.kart.drift.phase !== 'active') continue;
      const rearOffset = kartForward(e.kart.heading).multiplyScalar(-1);
      const sparkPos = e.kart.pos.clone().addScaledVector(rearOffset, 1.0);
      sparkPos.y = 0.3;
      driftSparks.emit(sparkPos, driftTier(e.kart.drift.charge));
    }
    driftSparks.update(renderDt);
    engineAudio.setSpeed(Math.abs(player.kart.speed) / TUNING.topSpeed);

    minimap.update(entities.map((e) => ({ pos: e.kart.pos, color: e.colorHex, isPlayer: e === player })));

    // Item box visuals: rotate continuously, hide while respawning.
    itemBoxes.forEach((box, i) => {
      const mesh = itemBoxVisuals[i];
      mesh.visible = box.active;
      mesh.rotation.y += renderDt * 1.5;
    });

    // Sync banana/shell meshes to their live-object arrays (create/remove as needed).
    syncProjectileVisuals(bananas, bananaVisuals, buildBananaMesh, scene);
    syncProjectileVisuals(shells, shellVisuals, buildShellMesh, scene);

    const playerHeldDisplay =
      player.itemState.rouletteTimer > 0 ? player.itemState.rouletteDisplay : player.itemState.item;
    hud.setHeldItem(playerHeldDisplay);

    const ranked = [...entities].sort(comparePosition);
    const playerPosition = ranked.indexOf(player) + 1;

    switch (raceDirector.state) {
      case 'LOBBY':
        hud.showLobby();
        hud.hideCountdown();
        hud.setPaused(false);
        hud.hideResults();
        hud.hideRaceInfo();
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
        hud.setRaceInfo(player.lapProgress.lap, TOTAL_LAPS, player.kart.speed * 3.6, playerPosition, entities.length);
        break;
      case 'PAUSED':
        hud.setPaused(true);
        break;
      case 'FINISHED':
        hud.hideCountdown();
        hud.setPaused(false);
        hud.showResults(ranked.map((e) => ({ name: e.name, isPlayer: e === player })));
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

    renderer.render(scene, players[0].camera);
  },
);
