import * as THREE from 'three';
import { GameSocket } from './net/GameSocket';
import { InputSource } from './input/InputSource';
import { Hud } from './ui/Hud';
import { Diagnostics } from './ui/Diagnostics';
import { clamp } from '../shared/mathUtils';

const app = document.getElementById('app')!;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb); // sky blue

const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.1,
  1000,
);
camera.position.set(0, 2, 5);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
app.appendChild(renderer.domElement);

const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1.2);
scene.add(hemi);
const dir = new THREE.DirectionalLight(0xffffff, 0.8);
dir.position.set(5, 10, 5);
scene.add(dir);

const NEUTRAL_COLOR = 0xff6b35;
const THROTTLE_COLOR = 0x2ecc71;
const cube = new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshLambertMaterial({ color: NEUTRAL_COLOR }),
);
scene.add(cube);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- Networking + input (Phase 1) ---------------------------------------

const hud = new Hud(app);
const diagnostics = new Diagnostics(app);
const inputSource = new InputSource();
let lastRttMs: number | null = null;
let controllerConnected = false;

const socket = new GameSocket({
  onRoom: (code, joinUrl) => hud.showRoom(code, joinUrl),
  onStatus: (status) => hud.setConnectionStatus(status),
  onRtt: (rtt) => {
    lastRttMs = rtt;
  },
  onPeer: (event) => {
    if (event === 'controller-joined') {
      controllerConnected = true;
      hud.setPeerConnected(true);
    } else if (event === 'controller-left') {
      controllerConnected = false;
      hud.setPeerConnected(false);
    } else if (event === 'game-left') {
      // Room was torn down server-side; nothing left to relay to.
      controllerConnected = false;
      hud.setPeerConnected(false);
    }
  },
  onInput: (snapshot) => inputSource.onSnapshot(snapshot),
});
void socket;
void controllerConnected;

const CUBE_SLIDE_SPEED = 4; // m/s at full steer deflection

function animate() {
  requestAnimationFrame(animate);
  diagnostics.tickFrame();

  const control = inputSource.sample();
  cube.position.x = clamp(cube.position.x + control.steer * CUBE_SLIDE_SPEED * (1 / 60), -4, 4);
  (cube.material as THREE.MeshLambertMaterial).color.setHex(
    control.throttle ? THROTTLE_COLOR : NEUTRAL_COLOR,
  );
  cube.rotation.y += 0.01;

  const diag = inputSource.diagnostics();
  diagnostics.update({
    rttMs: lastRttMs,
    inputAgeMs: diag.ageMs,
    seq: diag.seq,
    source: diag.source,
  });

  renderer.render(scene, camera);
}
animate();
