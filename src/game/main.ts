import * as THREE from 'three';
import { GameSocket } from './net/GameSocket';
import { InputSource } from './input/InputSource';
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
  onInput: (snapshot) => inputSource.onSnapshot(snapshot),
});
void socket;

// --- Fixed-timestep physics + rAF render ----------------------------------

let lastRenderTime = performance.now();

startLoop(
  (dt) => {
    const control = inputSource.sample();
    const preSample = trackQuery.nearestSample(kart.pos);
    const offRoad = Math.abs(preSample.lateral) > ROAD_HALF;
    stepKart(kart, control, dt, offRoad);
    resolveWallCollision(kart, trackQuery);
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

    const diag = inputSource.diagnostics();
    hud.setKeyboardActive(diag.source === 'keyboard');
    diagnostics.update({
      rttMs: lastRttMs,
      inputAgeMs: diag.ageMs,
      seq: diag.seq,
      source: diag.source,
    });

    renderer.render(scene, camera);
  },
);
