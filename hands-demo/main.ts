import { HandTracker } from '../src/game/hands/HandTracker';
import { Calibration } from '../src/game/hands/Calibration';
import { HandProvider } from '../src/game/input/HandProvider';
import type { DetectionSummary, HandReading, RawHand } from '../src/game/hands/gestures';

// Standalone preview of the game's hand input: the mirrored webcam full
// screen, the tracked skeleton drawn over each hand, and the exact controls
// the game would receive (same HandTracker + HandProvider + gesture filter as
// P1 in the race). C calibrates "level", H hides the readouts.

const ACCENT = '#FFD23F';
const GAS = '#3ddc84';
const BRAKE = '#ff5a4e';
const HAND_CONNECTIONS: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [0, 17], [17, 18], [18, 19], [19, 20],
];
const TIPS = [4, 8, 12, 16, 20];

const app = document.getElementById('app')!;
const tracker = new HandTracker();
const provider = new HandProvider(tracker);
const calibration = new Calibration();
calibration.onDone = (theta0) => provider.setTheta0(theta0);

// --- DOM -------------------------------------------------------------------

const stage = document.createElement('div');
stage.style.cssText = 'position:fixed; inset:0; display:flex; align-items:center; justify-content:center;';
app.appendChild(stage);

const frame = document.createElement('div');
frame.style.cssText = 'position:relative; width:100vw; height:100vh; overflow:hidden;';
stage.appendChild(frame);

const video = tracker.video;
video.style.cssText = 'position:absolute; inset:0; width:100%; height:100%; object-fit:cover; transform:scaleX(-1);';
frame.appendChild(video);

const canvas = document.createElement('canvas');
canvas.style.cssText = 'position:absolute; inset:0; width:100%; height:100%;';
frame.appendChild(canvas);
const ctx = canvas.getContext('2d')!;

const hud = document.createElement('div');
hud.style.cssText =
  'position:absolute; left:24px; bottom:24px; display:flex; align-items:center; gap:18px; padding:14px 20px; ' +
  "border-radius:22px; background:rgba(0,0,0,0.55); color:#fff; font-family:'Lilita One', system-ui, sans-serif;";
frame.appendChild(hud);

const wheel = document.createElement('div');
wheel.style.cssText = 'width:84px; height:84px; will-change:transform;';
wheel.innerHTML =
  `<svg viewBox="-20 -20 40 40" width="84" height="84"><circle r="16" fill="none" stroke="${ACCENT}" stroke-width="4"/>` +
  `<circle r="4" fill="${ACCENT}"/><path d="M-15 0 H-4 M4 0 H15 M0 4 V15" stroke="${ACCENT}" stroke-width="3.5" stroke-linecap="round"/>` +
  `<circle cy="-16" r="2.6" fill="#fff"/></svg>`;
hud.appendChild(wheel);

function pill(label: string) {
  const el = document.createElement('div');
  el.textContent = label;
  el.style.cssText =
    'padding:8px 18px; border-radius:999px; font-size:26px; letter-spacing:1px; background:rgba(255,255,255,0.12); ' +
    'color:rgba(255,255,255,0.4); transition:background 80ms, color 80ms, transform 120ms;';
  hud.appendChild(el);
  return el;
}
const gasPill = pill('GAS');
const brakePill = pill('BRAKE');
const boostPill = pill('BOOST');

const steerText = document.createElement('div');
steerText.style.cssText = "font-family:'Fredoka', system-ui; font-weight:700; font-size:22px; min-width:120px;";
hud.appendChild(steerText);

const banner = document.createElement('div');
banner.style.cssText =
  "position:absolute; top:24px; left:50%; transform:translateX(-50%); padding:12px 22px; border-radius:18px; " +
  "background:rgba(0,0,0,0.55); color:#fff; font-family:'Fredoka', system-ui; font-weight:700; font-size:22px; text-align:center;";
frame.appendChild(banner);

const legend = document.createElement('div');
legend.style.cssText =
  "position:absolute; right:24px; bottom:24px; padding:10px 16px; border-radius:14px; background:rgba(0,0,0,0.45); " +
  "color:rgba(255,255,255,0.85); font-family:'Fredoka', system-ui; font-weight:600; font-size:17px; line-height:1.5;";
legend.innerHTML = 'Both fists = GAS · both open = BRAKE<br>Thumbs-up flick = BOOST · tilt = steer<br>C = calibrate level · H = hide';
frame.appendChild(legend);

let hudHidden = false;
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyC' && tracker.live) calibration.start();
  if (e.code === 'KeyH') {
    hudHidden = !hudHidden;
    for (const el of [hud, legend, banner]) el.style.opacity = hudHidden ? '0' : '1';
  }
});

// --- Skeleton (detection rate) -------------------------------------------

// Boost bursts: expanding rings at the thumb tip of the hand that flicked.
interface Burst { x: number; y: number; t: number }
const bursts: Burst[] = [];
let lastBoostSeen = -Infinity;
let lastSummary: DetectionSummary | null = null;

provider.onDetection((d) => {
  calibration.feed(d.t, d.theta);
  lastSummary = d;
});

function toScreen(hand: RawHand, i: number, w: number, h: number, vw: number, vh: number) {
  // object-fit:cover crop maths so points sit on the (mirrored) video pixels.
  const scale = Math.max(w / vw, h / vh);
  const ox = (w - vw * scale) / 2;
  const oy = (h - vh * scale) / 2;
  return { x: ox + (1 - hand.landmarks[i].x) * vw * scale, y: oy + hand.landmarks[i].y * vh * scale };
}

function drawHand(hand: RawHand, reading: HandReading | null, w: number, h: number, dpr: number, now: number) {
  const vw = video.videoWidth || 640;
  const vh = video.videoHeight || 480;
  const pts = Array.from({ length: 21 }, (_, i) => toScreen(hand, i, w, h, vw, vh));
  const state = reading?.state ?? 'unknown';
  const colour = state === 'fist' ? GAS : state === 'open' ? BRAKE : ACCENT;
  const pulse = 1 + 0.12 * Math.sin(now / 160);

  ctx.save();
  ctx.shadowColor = colour;
  ctx.shadowBlur = 18 * dpr;
  ctx.strokeStyle = colour;
  ctx.lineWidth = 5 * dpr;
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (const [a, b] of HAND_CONNECTIONS) {
    ctx.moveTo(pts[a].x, pts[a].y);
    ctx.lineTo(pts[b].x, pts[b].y);
  }
  ctx.stroke();
  ctx.shadowBlur = 0;
  for (let i = 0; i < 21; i++) {
    const tip = TIPS.includes(i);
    ctx.fillStyle = tip ? colour : '#fff';
    ctx.beginPath();
    ctx.arc(pts[i].x, pts[i].y, (tip ? 8 * pulse : 5) * dpr, 0, Math.PI * 2);
    ctx.fill();
  }
  // Label above the wrist.
  const label = state === 'fist' ? 'FIST · GAS' : state === 'open' ? 'OPEN · BRAKE' : '…';
  ctx.font = `${22 * dpr}px 'Lilita One', system-ui`;
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  const tw = ctx.measureText(label).width + 24 * dpr;
  ctx.fillRect(pts[0].x - tw / 2, pts[0].y + 18 * dpr, tw, 34 * dpr);
  ctx.fillStyle = colour;
  ctx.fillText(label, pts[0].x, pts[0].y + 43 * dpr);
  ctx.restore();
  return pts;
}

// --- Render loop -----------------------------------------------------------

function frameLoop(now: number) {
  requestAnimationFrame(frameLoop);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.round(frame.clientWidth * dpr);
  const h = Math.round(frame.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  ctx.clearRect(0, 0, w, h);

  // Same per-tick sampling the race does — advances smoothing + boost edges.
  const control = tracker.live ? provider.sample(now) : null;
  const d = lastSummary && now - lastSummary.t < 500 ? lastSummary : null;

  let leftPts: { x: number; y: number }[] | null = null;
  let rightPts: { x: number; y: number }[] | null = null;
  if (d?.hands.left) leftPts = drawHand(d.hands.left, d.left, w, h, dpr, now);
  if (d?.hands.right) rightPts = drawHand(d.hands.right, d.right, w, h, dpr, now);

  // The "steering column" between the wrists.
  if (leftPts && rightPts) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,210,63,0.8)';
    ctx.lineWidth = 3 * dpr;
    ctx.setLineDash([12 * dpr, 10 * dpr]);
    ctx.beginPath();
    ctx.moveTo(leftPts[0].x, leftPts[0].y);
    ctx.lineTo(rightPts[0].x, rightPts[0].y);
    ctx.stroke();
    ctx.restore();
  }

  // Boost bursts, spawned at whichever visible thumb tip is highest (the flick).
  const firedAt = provider.filter.boostFiredAt;
  if (firedAt > lastBoostSeen) {
    lastBoostSeen = firedAt;
    const thumbs = [leftPts?.[4], rightPts?.[4]].filter((p): p is { x: number; y: number } => !!p);
    const at = thumbs.sort((a, b) => a.y - b.y)[0] ?? { x: w / 2, y: h / 2 };
    bursts.push({ x: at.x, y: at.y, t: now });
  }
  for (let i = bursts.length - 1; i >= 0; i--) {
    const age = (now - bursts[i].t) / 600;
    if (age >= 1) { bursts.splice(i, 1); continue; }
    ctx.save();
    ctx.globalAlpha = 1 - age;
    ctx.strokeStyle = ACCENT;
    ctx.shadowColor = ACCENT;
    ctx.shadowBlur = 24 * dpr;
    ctx.lineWidth = (10 - 8 * age) * dpr;
    for (const k of [1, 0.6]) {
      ctx.beginPath();
      ctx.arc(bursts[i].x, bursts[i].y, (20 + 160 * age * k) * dpr, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Readouts.
  const steer = provider.filter.sf;
  wheel.style.transform = `rotate(${(steer * 90).toFixed(1)}deg)`;
  const on = (el: HTMLElement, lit: boolean, colour: string) => {
    el.style.background = lit ? colour : 'rgba(255,255,255,0.12)';
    el.style.color = lit ? '#10131a' : 'rgba(255,255,255,0.4)';
  };
  on(gasPill, !!control?.throttle, GAS);
  on(brakePill, !!control?.brake, BRAKE);
  const boostLit = now - lastBoostSeen < 350;
  on(boostPill, boostLit, ACCENT);
  boostPill.style.transform = boostLit ? 'scale(1.15)' : 'scale(1)';
  const dir = Math.abs(steer) < 0.02 ? 'centre' : steer > 0 ? 'right' : 'left';
  steerText.textContent = `STEER ${(steer * 100).toFixed(0)}% ${dir}`;

  if (!tracker.live) {
    banner.textContent = tracker.message || 'Starting camera…';
  } else if (calibration.running) {
    banner.textContent = calibration.waitingForHands
      ? 'Show both fists to calibrate…'
      : `Hold your fists level… ${Math.round(calibration.progress * 100)}%`;
  } else {
    const hz = tracker.measuredHz ? `${tracker.measuredHz.toFixed(0)} Hz` : '';
    banner.textContent = `Tracking · ${tracker.delegate ?? ''} · ${tracker.detectMs.toFixed(1)} ms ${hz}` +
      (calibration.theta0 === null ? ' · press C to calibrate' : ' · calibrated');
  }
}

tracker.onStatus((s) => {
  if (s === 'live') calibration.start();
});
void tracker.start();
requestAnimationFrame(frameLoop);
