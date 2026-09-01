import * as THREE from 'three';
import { GameSocket } from './net/GameSocket';
import { InputSource, type ControlState } from './input/InputSource';
import { Hud } from './ui/Hud';
import { Diagnostics } from './ui/Diagnostics';
import { startLoop } from './core/loop';
import { createKart, driftTier, stepKart } from './physics/Kart';
import { resolveWallCollision } from './physics/collision';
import { buildGround, buildLights, buildKart, updateKartVisual } from './render/SceneBuilder';
import { FollowCamera } from './render/FollowCamera';
import { buildTrack } from './track/TrackBuilder';
import { TrackQuery } from './track/TrackQuery';
import { ROAD_HALF } from './track/trackData';
import { TUNING } from './tuning';
import { LapTracker, TOTAL_LAPS, createLapProgress, type LapProgress } from './race/LapTracker';
import { RaceDirector } from './race/RaceDirector';

const NEUTRAL_CONTROL: ControlState = { steer: 0, throttle: 0, brake: 0, drift: 0 };

const app = document.getElementById('app')!;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb); // sky blue
scene.fog = new THREE.Fog(0x87ceeb, 60, 220);

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

const startSample = track.samples[track.checkpoints[0]];
const startHeading = Math.atan2(startSample.forward.x, startSample.forward.z);
const kart = createKart(startSample.pos.clone(), startHeading);
const kartVisual = buildKart(0xff6b35);
scene.add(kartVisual.group);
scene.add(kartVisual.shadow);

const followCamera = new FollowCamera(camera);

const lapTracker = new LapTracker(track.checkpoints, track.samples, track.totalLength);
let lapProgress: LapProgress = createLapProgress(startSample.s);

function resetRace() {
  kart.pos.copy(startSample.pos);
  kart.heading = startHeading;
  kart.speed = 0;
  kart.velLateral = 0;
  kart.steerActual = 0;
  kart.drift = { phase: 'none', dir: 1, charge: 0 };
  kart.boostTimer = 0;
  kart.spinTimer = 0;
  lapProgress = createLapProgress(startSample.s);
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

    const control = raceDirector.state === 'RACING' ? inputSource.sample(now) : NEUTRAL_CONTROL;
    const preSample = trackQuery.nearestSample(kart.pos);
    const offRoad = Math.abs(preSample.lateral) > ROAD_HALF;
    stepKart(kart, control, dt, offRoad);
    resolveWallCollision(kart, trackQuery);

    if (raceDirector.state === 'RACING') {
      const q = trackQuery.nearestSample(kart.pos);
      lapTracker.update(lapProgress, q.s);
      if (lapProgress.finished) raceDirector.notifyFinished();
    }
  },
  () => {
    diagnostics.tickFrame();

    const now = performance.now();
    const renderDt = Math.min((now - lastRenderTime) / 1000, 0.1);
    lastRenderTime = now;

    updateKartVisual(kartVisual, kart, renderDt);
    followCamera.update(kart, renderDt);

    const driftActive = kart.drift.phase === 'active';
    const maxTierTime = TUNING.driftTierTimes[TUNING.driftTierTimes.length - 1];
    hud.setDriftCharge(driftActive, driftTier(kart.drift.charge), kart.drift.charge / maxTierTime);

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
        hud.setRaceInfo(lapProgress.lap, TOTAL_LAPS, kart.speed * 3.6);
        break;
      case 'PAUSED':
        hud.setPaused(true);
        break;
      case 'FINISHED':
        hud.hideCountdown();
        hud.setPaused(false);
        hud.showResults();
        break;
    }

    const diag = inputSource.diagnostics();
    hud.setKeyboardActive(diag.source === 'keyboard');
    diagnostics.update({
      rttMs: lastRttMs,
      inputAgeMs: diag.ageMs,
      seq: diag.seq,
      source: diag.source,
      raceState: raceDirector.state,
      lap: lapProgress.lap,
      nextCheckpoint: lapProgress.nextCheckpoint,
    });

    renderer.render(scene, camera);
  },
);
