import * as THREE from 'three';
import { GameSocket } from './net/GameSocket';
import { InputSource, type ControlState } from './input/InputSource';
import { Hud } from './ui/Hud';
import { Diagnostics } from './ui/Diagnostics';
import { startLoop } from './core/loop';
import { createKart, driftTier, stepKart, type KartState } from './physics/Kart';
import { resolveWallCollision, resolveKartKartCollisions } from './physics/collision';
import { buildGround, buildLights, buildKart, updateKartVisual, type KartVisual } from './render/SceneBuilder';
import { FollowCamera } from './render/FollowCamera';
import { buildTrack } from './track/TrackBuilder';
import { TrackQuery, sampleAtArcLength } from './track/TrackQuery';
import { GRASS_HALF, ROAD_HALF } from './track/trackData';
import { TUNING } from './tuning';
import { LapTracker, TOTAL_LAPS, createLapProgress, type LapProgress } from './race/LapTracker';
import { RaceDirector } from './race/RaceDirector';
import { createAiState, think, type AiState } from './ai/AiDriver';

const NEUTRAL_CONTROL: ControlState = { steer: 0, throttle: 0, brake: 0, drift: 0 };
const PLAYER_FINISH_DELAY_SECONDS = 1.5;

interface KartEntity {
  kart: KartState;
  visual: KartVisual;
  lapProgress: LapProgress;
  ai: AiState | null;
  name: string;
  spawnS: number;
  spawnLane: number;
}

const app = document.getElementById('app')!;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x6ec6ff); // bright cheerful sky blue
scene.fog = new THREE.Fog(0x6ec6ff, 70, 260);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
app.appendChild(renderer.domElement);

buildLights(scene);
buildGround(scene);

const track = buildTrack();
scene.add(track.group);
const trackQuery = new TrackQuery(track.samples, track.totalLength);

// Staggered 1-2-2 grid start (§Phase 6), spaced so no pair starts closer than
// 2*kartRadius: player alone at the line, then two rows of two further back.
const GRID = [
  { name: 'YOU', color: 0xff6b35, isAi: false, s: 0, lane: 0 },
  { name: 'AI 1', color: 0x3498db, isAi: true, s: -4, lane: -2 },
  { name: 'AI 2', color: 0x2ecc71, isAi: true, s: -4, lane: 0.7 },
  { name: 'AI 3', color: 0xf1c40f, isAi: true, s: -8, lane: 2 },
  { name: 'AI 4', color: 0x9b59b6, isAi: true, s: -8, lane: -0.7 },
];

function spawnPose(sOffset: number, lane: number): { pos: THREE.Vector3; heading: number } {
  const sample = sampleAtArcLength(track.samples, track.totalLength, sOffset);
  const pos = sample.pos.clone().addScaledVector(sample.right, lane);
  const heading = Math.atan2(sample.forward.x, sample.forward.z);
  return { pos, heading };
}

const entities: KartEntity[] = GRID.map((g) => {
  const { pos, heading } = spawnPose(g.s, g.lane);
  const kart = createKart(pos, heading, g.isAi);
  const visual = buildKart(g.color);
  scene.add(visual.group, visual.shadow);
  return {
    kart,
    visual,
    lapProgress: createLapProgress(0),
    ai: g.isAi ? createAiState(g.lane) : null,
    name: g.name,
    spawnS: g.s,
    spawnLane: g.lane,
  };
});
const player = entities[0];

const followCamera = new FollowCamera(camera);
const lapTracker = new LapTracker(track.checkpoints, track.samples, track.totalLength);

let finishCounter = 0;
let playerFinishTimer: number | null = null;

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
  }
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
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- Networking + input --------------------------------------------------

const hud = new Hud(app);
const diagnostics = new Diagnostics(app);
const inputSource = new InputSource();
inputSource.attachKeyboard();
let lastRttMs: number | null = null;

const raceDirector = new RaceDirector({
  onEvent: (name) => socket.sendEvent(name),
  onStateChange: (state) => {
    if (state === 'LOBBY') resetRace();
  },
});

const socket = new GameSocket({
  onRoom: (code, joinUrl) => hud.showRoom(code, joinUrl),
  onStatus: (status) => hud.setConnectionStatus(status),
  onRtt: (rtt) => {
    lastRttMs = rtt;
  },
  onPeer: (event) => {
    if (event === 'controller-joined') hud.setPeerConnected(true);
    else hud.setPeerConnected(false);
  },
  onInput: (snapshot) => {
    inputSource.onSnapshot(snapshot);
    if (raceDirector.state === 'PAUSED') raceDirector.notifyInputRecovered();
  },
  onEvent: (name) => {
    if (name === 'start') raceDirector.requestStart();
    else if (name === 'restart') raceDirector.requestRestart();
  },
});
void socket;

window.addEventListener('keydown', (e) => {
  if (e.code === 'Enter') raceDirector.requestStart();
  if (e.code === 'KeyR') raceDirector.requestRestart();
  if (raceDirector.state === 'PAUSED') raceDirector.notifyInputRecovered();
});

// --- Fixed-timestep physics + rAF render ----------------------------------

let lastRenderTime = performance.now();

startLoop(
  (dt) => {
    const now = performance.now();
    // While keyboard is actively driving (D12), it fully substitutes for the
    // controller, so phone absence shouldn't re-trigger the pause watchdog.
    const controllerAgeMs = inputSource.isKeyboardActive(now) ? null : inputSource.rawControllerAgeMs(now);
    raceDirector.tick(dt, controllerAgeMs);

    if (raceDirector.state === 'PAUSED') return; // physics frozen entirely

    const racing = raceDirector.state === 'RACING';

    for (const e of entities) {
      const preSample = trackQuery.nearestSample(e.kart.pos);
      const offRoad = Math.abs(preSample.lateral) > ROAD_HALF;
      const onWall = Math.abs(preSample.lateral) >= GRASS_HALF - TUNING.kartRadius;

      let control: ControlState;
      let topSpeedScale = 1;

      if (!racing) {
        control = NEUTRAL_CONTROL;
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
        control = inputSource.sample(now);
      }

      stepKart(e.kart, control, dt, offRoad, topSpeedScale);
      resolveWallCollision(e.kart, trackQuery);
    }

    resolveKartKartCollisions(
      entities.map((e) => e.kart),
      dt,
    );

    if (racing) {
      for (const e of entities) {
        const q = trackQuery.nearestSample(e.kart.pos);
        const wasFinished = e.lapProgress.finished;
        lapTracker.update(e.lapProgress, q.s);
        if (!wasFinished && e.lapProgress.finished) {
          e.lapProgress.finishOrder = ++finishCounter;
        }
      }

      if (player.lapProgress.finished && playerFinishTimer === null) {
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
    followCamera.update(player.kart, renderDt);

    const driftActive = player.kart.drift.phase === 'active';
    const maxTierTime = TUNING.driftTierTimes[TUNING.driftTierTimes.length - 1];
    hud.setDriftCharge(driftActive, driftTier(player.kart.drift.charge), player.kart.drift.charge / maxTierTime);

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

    const diag = inputSource.diagnostics();
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

    renderer.render(scene, camera);
  },
);
