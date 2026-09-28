import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GESTURE,
  HandGestureFilter,
  assignHands,
  calibrationTheta0,
  classifyOpenness,
  handOpenness,
  median,
  steerFromAngle,
  stepThumb,
  thumbExtension,
  wheelAngle,
  INITIAL_THUMB,
  type Openness,
  type RawHand,
  type Vec3,
} from '../src/game/hands/gestures';
import { Calibration } from '../src/game/hands/Calibration';

const DEG = Math.PI / 180;
const W = 640;
const H = 480;

// §stage2 review fix: real MediaPipe HandLandmarker output (world_landmarks +
// landmarks + handedness), extracted from this project's own review fixtures
// — NOT synthesized. These are what grounded the retuned open/fist thresholds
// (GESTURE.openAbove/fistBelow): a real fist reads ~0.30, a real "one finger
// up" gesture ~0.48, "victory" (two fingers) ~0.77, nowhere near the old
// 1.35/1.05 band.
const FIST_FIXTURE = {
  label: 'Right' as const,
  worldLandmarks: [
    { x: -0.008604452, y: 0.08165767, z: 0.0061365655 },
    { x: 0.027301773, y: 0.061905317, z: -0.00872007 },
    { x: 0.049898714, y: 0.035359327, z: -0.016682662 },
    { x: 0.050297678, y: 0.005200807, z: -0.028928496 },
    { x: 0.015639625, y: -0.0063155442, z: -0.03174634 },
    { x: 0.029161729, y: -0.0024596984, z: 0.0011553494 },
    { x: 0.034491, y: -0.017581237, z: -0.020781275 },
    { x: 0.034020264, y: -0.0059247985, z: -0.02573838 },
    { x: 0.02867364, y: 0.011137734, z: -0.009430941 },
    { x: 0.0015385814, y: -0.004778851, z: 0.0056454404 },
    { x: 0.010490709, y: -0.019680617, z: -0.027034117 },
    { x: 0.0132071925, y: 0.0071370844, z: -0.034802448 },
    { x: 0.0139978565, y: 0.011672501, z: -0.0040006908 },
    { x: -0.019919239, y: -0.0006897822, z: -0.0003317799 },
    { x: -0.01088193, y: -0.008502296, z: -0.02873486 },
    { x: -0.005327127, y: 0.012745364, z: -0.034153957 },
    { x: -0.0027040644, y: 0.02167169, z: -0.011669062 },
    { x: -0.038813893, y: 0.011925209, z: -0.0076287366 },
    { x: -0.030842202, y: 0.0010964936, z: -0.022697516 },
    { x: -0.01829514, y: 0.013929318, z: -0.032819964 },
    { x: -0.024175374, y: 0.022456694, z: -0.02357186 },
  ] as Vec3[],
};

const POINTING_UP_FIXTURE = {
  label: 'Right' as const,
  worldLandmarks: [
    { x: 0.016918864, y: 0.08634466, z: 0.035783045 },
    { x: 0.04193685, y: 0.056667875, z: 0.019453367 },
    { x: 0.050382353, y: 0.031786427, z: 0.0023380776 },
    { x: 0.043284662, y: 0.008976387, z: -0.02496663 },
    { x: 0.016010094, y: 0.004991216, z: -0.036876947 },
    { x: 0.02450771, y: -0.013496464, z: 0.0041254223 },
    { x: 0.024783865, y: -0.041331705, z: -0.0028748964 },
    { x: 0.025917178, y: -0.06191107, z: -0.010242647 },
    { x: 0.023101516, y: -0.07967696, z: -0.03152665 },
    { x: 0.0006629339, y: -0.0060150283, z: 0.004906766 },
    { x: 0.0077093104, y: -0.017035034, z: -0.029702934 },
    { x: 0.017517095, y: 0.008997183, z: -0.03692814 },
    { x: 0.0145079205, y: 0.017461296, z: -0.011290487 },
    { x: -0.018095909, y: 0.006112392, z: -0.0027157406 },
    { x: -0.010212201, y: 0.0052777785, z: -0.034659054 },
    { x: 0.0043836404, y: 0.028383566, z: -0.03296758 },
    { x: 0.003886811, y: 0.036054, z: -0.0074628904 },
    { x: -0.03178849, y: 0.029854178, z: -0.008874044 },
    { x: -0.02403016, y: 0.021497255, z: -0.027618393 },
    { x: -0.008522437, y: 0.031886857, z: -0.032367583 },
    { x: -0.012865841, y: 0.038687646, z: -0.017172804 },
  ] as Vec3[],
};

const THUMB_UP_FIXTURE = {
  label: 'Right' as const,
  worldLandmarks: [
    { x: 0.06753889, y: 0.031051591, z: 0.05541924 },
    { x: 0.06327636, y: -0.003913434, z: 0.02125023 },
    { x: 0.05469646, y: -0.038668767, z: 0.01118496 },
    { x: 0.03557241, y: -0.06865983, z: 0.0029562893 },
    { x: 0.019069858, y: -0.08740239, z: 0.007222481 },
    { x: 0.0044852756, y: -0.02772763, z: -0.004234833 },
    { x: -0.0031203926, y: -0.024173645, z: -0.033932913 },
    { x: 0.0080217365, y: -0.018939625, z: -0.032623816 },
    { x: 0.025537387, y: -0.014517117, z: -0.004398854 },
    { x: -0.004470923, y: -0.0040212176, z: 0.0025033879 },
    { x: -0.010845158, y: -0.0031857258, z: -0.036282137 },
    { x: 0.016729971, y: 0.0028876318, z: -0.036264844 },
    { x: 0.019928008, y: -0.0032422952, z: 0.004380459 },
    { x: -0.005686749, y: 0.017101247, z: 0.0036791638 },
    { x: -0.010514952, y: 0.017355483, z: -0.02882688 },
    { x: 0.014503509, y: 0.019414417, z: -0.026207235 },
    { x: 0.0211232, y: 0.014327417, z: 0.0011467658 },
    { x: 0.0011399705, y: 0.043651186, z: 0.0068390737 },
    { x: -0.010388309, y: 0.03904784, z: -0.015677728 },
    { x: 0.006957108, y: 0.03613425, z: -0.028704688 },
    { x: 0.012793289, y: 0.03930679, z: -0.012465539 },
  ] as Vec3[],
};

const VICTORY_FIXTURE = {
  label: 'Right' as const,
  worldLandmarks: [
    { x: 0.01299962, y: 0.09162361, z: 0.011185312 },
    { x: 0.03726317, y: 0.0638103, z: -0.010005756 },
    { x: 0.03975261, y: 0.03712649, z: -0.02906275 },
    { x: 0.018798776, y: 0.012429599, z: -0.048737116 },
    { x: -0.0128555335, y: 0.001022811, z: -0.044505004 },
    { x: 0.025658218, y: -0.008031519, z: -0.0058278795 },
    { x: 0.028017294, y: -0.038120236, z: -0.010376478 },
    { x: 0.030067094, y: -0.059907563, z: -0.014568218 },
    { x: 0.027284538, y: -0.07803874, z: -0.032692235 },
    { x: 0.0013260426, y: -0.005039873, z: 0.005567288 },
    { x: -0.002380834, y: -0.044605374, z: -0.0038231965 },
    { x: -0.009240147, y: -0.066279344, z: -0.02161214 },
    { x: -0.0092535615, y: -0.08933755, z: -0.037401434 },
    { x: -0.01751284, y: 0.0037118336, z: 0.0047480655 },
    { x: -0.02195602, y: -0.010006189, z: -0.02371484 },
    { x: -0.012851426, y: 0.008346066, z: -0.037721373 },
    { x: -0.00018795021, y: 0.026816685, z: -0.03732748 },
    { x: -0.034864448, y: 0.022316, z: -0.0002774651 },
    { x: -0.035896845, y: 0.01066218, z: -0.017325373 },
    { x: -0.02358637, y: 0.018667895, z: -0.028403495 },
    { x: -0.013704676, y: 0.033456434, z: -0.02595728 },
  ] as Vec3[],
};


// A synthetic MediaPipe hand. `x`/`y` place the wrist in the RAW (unmirrored)
// image; world landmarks are built so handOpenness() == `open` and
// thumbExtension() == `thumb` exactly (palm length |0-9| is the unit).
// Defaults: `open` 0.3 — a closed fist, matching the real fist fixture
// (0.30), i.e. GAS under the fists = gas mapping; `thumb` 0.5 — tucked,
// matching the real fist fixture's 0.53. An open hand is `open: 1.15`,
// squarely inside the ~1.1-1.2 real-open-hand range.
function makeHand(opts: { x: number; y: number; label: 'Left' | 'Right'; open?: number; thumb?: number }): RawHand {
  const { x, y, label, open = 0.3, thumb = 0.5 } = opts;
  const world: Vec3[] = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));
  world[0] = { x: 0, y: 0, z: 0 };
  world[5] = { x: -0.03, y: -0.085, z: 0 };
  world[9] = { x: -0.01, y: -0.09, z: 0 };
  world[13] = { x: 0.01, y: -0.085, z: 0 };
  world[17] = { x: 0.03, y: -0.075, z: 0 };
  const len = Math.hypot(0.01, 0.09);
  const c = { x: 0, y: (-0.085 - 0.09 - 0.085 - 0.075) / 5, z: 0 };
  const tipDirs: [number, number][] = [[-0.3, -1], [-0.1, -1], [0.1, -1], [0.3, -1]];
  [8, 12, 16, 20].forEach((tip, i) => {
    const [dx, dy] = tipDirs[i];
    const n = Math.hypot(dx, dy);
    world[tip] = { x: c.x + (dx / n) * open * len, y: c.y + (dy / n) * open * len, z: 0 };
  });
  world[4] = { x: c.x - thumb * len, y: c.y, z: 0 };
  const landmarks = Array.from({ length: 21 }, () => ({ x, y }));
  return { landmarks, worldLandmarks: world, label };
}

// Wraps a real (image-space-agnostic) fixture as a RawHand at a given raw
// wrist position, for feeding through the two-hand assignment/steering path.
function realHandAt(fixture: { label: 'Left' | 'Right'; worldLandmarks: Vec3[] }, x: number, y: number): RawHand {
  return {
    landmarks: Array.from({ length: 21 }, () => ({ x, y })),
    worldLandmarks: fixture.worldLandmarks,
    label: fixture.label,
  };
}

// The player's left hand appears on the RIGHT of the raw image (large x), and
// MediaPipe (assuming a mirrored selfie input) labels it "Right".
const LEFT_RAW_X = 0.7; // mirrored 0.3
const RIGHT_RAW_X = 0.3; // mirrored 0.7

interface HandOpts {
  open?: number;
  thumb?: number;
}

function twoHands(tiltDeg: number, opts: { left?: HandOpts; right?: HandOpts } & HandOpts = {}): RawHand[] {
  const dxPx = (LEFT_RAW_X - RIGHT_RAW_X) * W;
  const dyNorm = (Math.tan(tiltDeg * DEG) * dxPx) / H;
  const both = { open: opts.open, thumb: opts.thumb };
  return [
    makeHand({ x: LEFT_RAW_X, y: 0.5, label: 'Right', ...both, ...opts.left }),
    makeHand({ x: RIGHT_RAW_X, y: 0.5 + dyNorm, label: 'Left', ...both, ...opts.right }),
  ];
}

// Two real fixture hands (left, right) at level wheel positions.
function realPair(
  left: { label: 'Left' | 'Right'; worldLandmarks: Vec3[] },
  right: { label: 'Left' | 'Right'; worldLandmarks: Vec3[] },
): RawHand[] {
  return [realHandAt(left, LEFT_RAW_X, 0.5), realHandAt(right, RIGHT_RAW_X, 0.5)];
}

function angleOf(hands: RawHand[]): number {
  const a = assignHands(hands);
  return wheelAngle(a.left!.landmarks[0], a.right!.landmarks[0], W, H);
}

// Feeds detections at 30Hz and samples at 60Hz from t0 for `ms`. Also sums
// boost edges and records whether throttle/drift ever deviated.
function run(filter: HandGestureFilter, hands: () => RawHand[], t0: number, ms: number) {
  let lastDetect = -Infinity;
  let t = t0;
  let last = filter.sample(t);
  let boosts = 0;
  let minThrottle = 1;
  let maxDrift = 0;
  for (; t <= t0 + ms; t += 1000 / 60) {
    if (t - lastDetect >= 1000 / 30 - 0.01) {
      filter.onDetection(t, hands(), W, H);
      lastDetect = t;
    }
    last = filter.sample(t);
    boosts += last.boost;
    minThrottle = Math.min(minThrottle, last.throttle);
    maxDrift = Math.max(maxDrift, last.drift);
  }
  return { t, last, boosts, minThrottle, maxDrift };
}


test('level hands steer 0', () => {
  const theta = angleOf(twoHands(0));
  assert.ok(Math.abs(theta) < 1e-9);
  assert.equal(steerFromAngle(theta), 0);
});

test('±45deg tilt is full lock, right hand lower steers right', () => {
  assert.ok(Math.abs(angleOf(twoHands(45)) - 45 * DEG) < 1e-9);
  assert.equal(steerFromAngle(angleOf(twoHands(45))), 1);
  assert.equal(steerFromAngle(angleOf(twoHands(-45))), -1);
  assert.equal(steerFromAngle(angleOf(twoHands(70))), 1, 'clamped beyond full lock');
  // End to end through the filter: right hand lower -> positive steer.
  const f = new HandGestureFilter();
  const { last } = run(f, () => twoHands(45), 0, 600);
  assert.ok(last.steer > 0.97, `steer ${last.steer}`);
});

test('deadzone is 3deg and rescaled continuously', () => {
  assert.equal(steerFromAngle(2.9 * DEG), 0);
  assert.equal(steerFromAngle(-2.9 * DEG), 0);
  assert.ok(steerFromAngle(3.5 * DEG) > 0 && steerFromAngle(3.5 * DEG) < 0.02);
  assert.ok(Math.abs(steerFromAngle(24 * DEG) - 0.5) < 1e-9);
  assert.ok(Math.abs(steerFromAngle(-24 * DEG) + 0.5) < 1e-9);
  // theta0 shifts the zero point.
  assert.equal(steerFromAngle(10 * DEG, 10 * DEG), 0);
});

test('aspect correction uses video pixel dimensions', () => {
  // A physical 45deg tilt in a 16:9 frame: 0.4 of the width across, and the
  // same number of PIXELS down — which is 0.711 of the height.
  const w = 1280;
  const h = 720;
  const left = { x: 0.7, y: 0.2 };
  const right = { x: 0.3, y: 0.2 + (0.4 * w) / h };
  assert.ok(Math.abs(wheelAngle(left, right, w, h) - 45 * DEG) < 1e-9);
  // Ignoring the aspect would read it as ~60deg.
  assert.ok(wheelAngle(left, right, 1, 1) > 60 * DEG);
});


// §stage2 review fix: the OLD thresholds (open>1.35, fist<1.05) were
// unreachable by any of these real hands. A real fist reads ~0.30 and a real
// open-ish hand tops out around 1.1-1.2.
test('openness against real MediaPipe fixtures: thresholds are actually reachable', () => {
  const rFist = handOpenness(FIST_FIXTURE.worldLandmarks);
  const rThumbUp = handOpenness(THUMB_UP_FIXTURE.worldLandmarks);
  const rPointingUp = handOpenness(POINTING_UP_FIXTURE.worldLandmarks);
  const rVictory = handOpenness(VICTORY_FIXTURE.worldLandmarks);

  assert.ok(Math.abs(rFist - 0.302) < 0.01, `fist openness ${rFist}`);
  assert.ok(Math.abs(rThumbUp - 0.273) < 0.01, `thumb-up openness ${rThumbUp}`);
  assert.ok(Math.abs(rPointingUp - 0.476) < 0.01, `pointing-up openness ${rPointingUp}`);
  assert.ok(Math.abs(rVictory - 0.773) < 0.01, `victory openness ${rVictory}`);

  // A real fist, thumbs-up, AND a single pointing finger all cross the fist
  // ceiling (0.55) — openness only looks at fingertips 8/12/16/20, so the
  // thumb never counts and a thumbs-up is still a fist (still GAS).
  assert.equal(classifyOpenness(rFist, 'unknown'), 'fist');
  assert.equal(classifyOpenness(rThumbUp, 'unknown'), 'fist');
  assert.equal(classifyOpenness(rPointingUp, 'open'), 'fist');
  // Victory (two fingers) sits in the dead zone between the two thresholds.
  assert.equal(classifyOpenness(rVictory, 'fist'), 'fist');
  assert.equal(classifyOpenness(rVictory, 'open'), 'open');

  const rOpen = handOpenness(makeHand({ x: 0.5, y: 0.5, label: 'Left', open: 1.15 }).worldLandmarks);
  assert.equal(classifyOpenness(rOpen, 'unknown'), 'open');

  assert.equal(GESTURE.openAbove, 0.85);
  assert.equal(GESTURE.fistBelow, 0.55);
});

// The thumbs-up metric: thumb tip distance from the palm centre / palm
// length. These real-fixture numbers are what GESTURE.thumbUpEngage/Release
// were chosen from.
test('thumb extension against real MediaPipe fixtures: thumbs-up separates cleanly from curled hands', () => {
  const xFist = thumbExtension(FIST_FIXTURE.worldLandmarks);
  const xThumbUp = thumbExtension(THUMB_UP_FIXTURE.worldLandmarks);
  const xPointingUp = thumbExtension(POINTING_UP_FIXTURE.worldLandmarks);
  const xVictory = thumbExtension(VICTORY_FIXTURE.worldLandmarks);

  assert.ok(Math.abs(xFist - 0.533) < 0.01, `fist thumb ${xFist}`);
  assert.ok(Math.abs(xThumbUp - 1.039) < 0.01, `thumb-up thumb ${xThumbUp}`);
  assert.ok(Math.abs(xPointingUp - 0.501) < 0.01, `pointing-up thumb ${xPointingUp}`);
  assert.ok(Math.abs(xVictory - 0.539) < 0.01, `victory thumb ${xVictory}`);

  // Every non-thumbs-up hand sits below the RELEASE line (so a fist arms the
  // flick), the thumbs-up well above the ENGAGE line.
  for (const x of [xFist, xPointingUp, xVictory]) assert.ok(x < GESTURE.thumbUpRelease, `curled thumb ${x}`);
  assert.ok(xThumbUp > GESTURE.thumbUpEngage + 0.2, `thumb-up ${xThumbUp}`);
  assert.ok(GESTURE.thumbUpRelease < GESTURE.thumbUpEngage, 'hysteresis band');
});

test('both fists = GAS, with real fixtures and synthetic hands', () => {
  const f = new HandGestureFilter();
  f.onDetection(0, realPair(FIST_FIXTURE, FIST_FIXTURE), W, H);
  const c = f.sample(0);
  assert.deepEqual([c.throttle, c.brake], [1, 0], 'two real fists: gas');

  const g = new HandGestureFilter();
  const { last } = run(g, () => twoHands(0), 0, 300);
  assert.deepEqual([last.throttle, last.brake], [1, 0], 'two synthetic fists: gas');
});

test('both open hands = BRAKE (the physics reverses from a standstill)', () => {
  const f = new HandGestureFilter();
  const { last } = run(f, () => twoHands(0, { open: 1.15 }), 0, 300);
  assert.deepEqual([last.throttle, last.brake], [0, 1]);
});

test('mixed or unknown hands = coast', () => {
  const mixed = new HandGestureFilter();
  const a = run(mixed, () => twoHands(0, { left: { open: 0.3 }, right: { open: 1.15 } }), 0, 300).last;
  assert.deepEqual([a.throttle, a.brake], [0, 0], 'left fist + right open: coast');

  const mixed2 = new HandGestureFilter();
  const b = run(mixed2, () => twoHands(0, { left: { open: 1.15 }, right: { open: 0.3 } }), 0, 300).last;
  assert.deepEqual([b.throttle, b.brake], [0, 0], 'left open + right fist: coast');

  // A fresh hand in the dead band has no opinion yet ('unknown'): the other
  // hand's fist alone is not unanimous, so coast.
  const unknown = new HandGestureFilter();
  unknown.onDetection(0, twoHands(0, { left: { open: 0.3 }, right: { open: 0.7 } }), W, H);
  const u = unknown.sample(0);
  assert.deepEqual([u.throttle, u.brake], [0, 0], 'fist + unknown: coast');
  assert.equal(unknown.lastDetection?.right?.state, 'unknown');

  // Real victory (dead band) next to a real fist, from a fresh start: coast.
  const v = new HandGestureFilter();
  v.onDetection(0, realPair(FIST_FIXTURE, VICTORY_FIXTURE), W, H);
  assert.deepEqual([v.sample(0).throttle, v.sample(0).brake], [0, 0]);
});

test('a single visible hand decides on its own (and never steers)', () => {
  // The player's right hand alone (raw label "Left").
  const fistOnly = new HandGestureFilter();
  fistOnly.onDetection(0, [makeHand({ x: RIGHT_RAW_X, y: 0.5, label: 'Left', open: 0.3 })], W, H);
  let c = fistOnly.sample(0);
  assert.deepEqual([c.throttle, c.brake, c.steer], [1, 0, 0], 'one fist: gas');

  // The player's left hand alone (raw label "Right").
  const openOnly = new HandGestureFilter();
  openOnly.onDetection(0, [makeHand({ x: LEFT_RAW_X, y: 0.5, label: 'Right', open: 1.15 })], W, H);
  c = openOnly.sample(0);
  assert.deepEqual([c.throttle, c.brake, c.steer], [0, 1, 0], 'one open hand: brake');

  // Two fists, then one drops out: the remaining fist keeps the gas on.
  const g = new HandGestureFilter();
  const { t } = run(g, () => twoHands(0), 0, 200);
  const r = run(g, () => [twoHands(0)[1]], t, 600);
  assert.equal(r.minThrottle, 1, 'a remaining fist never lets go of the gas');
});

test('openness hysteresis does not flicker on a noisy boundary', () => {
  const noisyAroundOpen = [0.78, 0.87, 0.80, 0.86, 0.81, 0.88, 0.79, 0.90, 0.78];
  let state: Openness = 'fist';
  let flips = 0;
  for (const r of noisyAroundOpen) {
    const next = classifyOpenness(r, state);
    if (next !== state) flips++;
    state = next;
  }
  assert.equal(state, 'open');
  assert.equal(flips, 1, 'one clean fist->open transition, no flicker back');

  const noisyMiddle = [0.6, 0.8, 0.58, 0.82, 0.62, 0.75];
  for (const start of ['open', 'fist'] as Openness[]) {
    let s = start;
    for (const r of noisyMiddle) s = classifyOpenness(r, s);
    assert.equal(s, start, 'the dead band never changes state');
  }

  // Through the filter: two fists wobbling in the dead band keep the gas on
  // (each hand keeps its own previous state)...
  const f = new HandGestureFilter();
  run(f, () => twoHands(0), 0, 200);
  let t = 200;
  for (const r of noisyMiddle) {
    f.onDetection(t, twoHands(0, { open: r }), W, H);
    const c = f.sample(t);
    assert.deepEqual([c.throttle, c.brake], [1, 0]);
    t += 33;
  }
  // ...and opening both fully switches to brake.
  f.onDetection(t, twoHands(0, { open: 1.15 }), W, H);
  const c = f.sample(t);
  assert.deepEqual([c.throttle, c.brake], [0, 1]);
});

test('real thumbs-up fixture out of a real fist: one boost edge, and the gas stays on', () => {
  for (const side of ['left', 'right'] as const) {
    const f = new HandGestureFilter();
    // Both fists gripping the wheel...
    const warm = run(f, () => realPair(FIST_FIXTURE, FIST_FIXTURE), 0, 300);
    assert.equal(warm.boosts, 0, 'a gripping fist never boosts');
    assert.equal(warm.last.throttle, 1);
    // ...then a thumbs-up flick on one of them, held for half a second.
    const flick = () =>
      side === 'left' ? realPair(THUMB_UP_FIXTURE, FIST_FIXTURE) : realPair(FIST_FIXTURE, THUMB_UP_FIXTURE);
    const held = run(f, flick, warm.t, 500);
    assert.equal(held.boosts, 1, `${side} thumbs-up fires exactly once`);
    assert.equal(held.minThrottle, 1, `${side} thumbs-up hand still counts as a fist: gas never drops`);
    // Tuck back in and flick again (past the 250ms debounce): a second edge.
    const tucked = run(f, () => realPair(FIST_FIXTURE, FIST_FIXTURE), held.t, 100);
    const again = run(f, flick, tucked.t, 200);
    assert.equal(again.boosts, 1, `${side}: a second flick boosts again`);
  }
});

// §defect-fix (item 11): a UI polling lastControl once per render frame can
// land right after a SECOND physics sample() already cleared boost back to 0
// (the fixed-timestep loop can run 2+ physics steps per render frame) and
// miss the flick entirely. boostFiredAt is a monotonic timestamp instead —
// only ever moves forward on an actual fire — so it survives being read after
// a later, boost-less sample.
test('boostFiredAt survives a later same-frame sample that already consumed the edge', () => {
  const f = new HandGestureFilter();
  const warm = run(f, () => realPair(FIST_FIXTURE, FIST_FIXTURE), 0, 300);
  assert.equal(f.boostFiredAt, -Infinity, 'no fire yet');

  f.onDetection(warm.t, realPair(THUMB_UP_FIXTURE, FIST_FIXTURE), W, H);
  const fireAt = warm.t + 1000 / 60;
  const s1 = f.sample(fireAt); // consumes the edge: boost=1
  assert.equal(s1.boost, 1, 'the flick fires on this sample');
  assert.equal(f.boostFiredAt, fireAt);

  // A second physics step in the same render frame, with no new detection —
  // the edge is already consumed, so this sample reads boost=0...
  const laterAt = fireAt + 1000 / 60;
  const s2 = f.sample(laterAt);
  assert.equal(s2.boost, 0, 'the edge was already consumed');
  // ...but boostFiredAt must still hold the ORIGINAL fire moment, not reset —
  // a once-per-render-frame reader checking boostFiredAt after both of these
  // samples must still be able to see the flick happened.
  assert.equal(f.boostFiredAt, fireAt, 'boostFiredAt is not cleared by a later boost-less sample');
});

test('curled hands without a thumbs-up never boost', () => {
  for (const fx of [FIST_FIXTURE, POINTING_UP_FIXTURE, VICTORY_FIXTURE]) {
    const f = new HandGestureFilter();
    assert.equal(run(f, () => realPair(fx, fx), 0, 2000).boosts, 0);
  }
  // Nor a synthetic fist whose thumb wobbles inside the hysteresis band.
  const g = new HandGestureFilter();
  let i = 0;
  const wobble = [0.5, 0.7, 0.6, 0.78, 0.55, 0.79];
  assert.equal(run(g, () => twoHands(0, { thumb: wobble[i++ % wobble.length] }), 0, 2000).boosts, 0);
});

test('an open hand never boosts, even with its thumb out', () => {
  // An open hand's thumb is naturally extended.
  const f = new HandGestureFilter();
  const open = run(f, () => twoHands(0, { open: 1.15, thumb: 1.1 }), 0, 1000);
  assert.equal(open.boosts, 0);
  assert.equal(open.last.brake, 1);

  // Closing from open to a fist: the fingers curl a frame before the thumb
  // tucks in, so there is a moment of "curled + thumb out" — that must not
  // read as a thumbs-up (the hand was never armed by a tucked fist).
  const closing = run(f, () => twoHands(0, { open: 0.3, thumb: 1.1 }), open.t, 200);
  assert.equal(closing.boosts, 0, 'open -> fist with the thumb still out is not a flick');
  const tucked = run(f, () => twoHands(0, { open: 0.3, thumb: 0.5 }), closing.t, 200);
  assert.equal(tucked.boosts, 0);
  // Now a genuine flick out of the tucked fist does boost.
  const flick = run(f, () => twoHands(0, { right: { open: 0.3, thumb: 1.0 } }), tucked.t, 200);
  assert.equal(flick.boosts, 1);

  // Unit level: opening the hand disarms.
  let s = stepThumb(INITIAL_THUMB, 0.3, 0.5, 0).state; // tucked fist: armed
  assert.ok(s.armed);
  s = stepThumb(s, 1.15, 0.5, 33).state; // opens
  assert.ok(!s.armed);
  assert.equal(stepThumb(s, 1.15, 1.1, 66).fire, false, 'open hand, thumb out');
});

test('thumbs-up fires on the engage edge only, debounced (not cooled down) — the kart owns the real cooldown', () => {
  let s = INITIAL_THUMB;
  const step = (x: number, t: number, r = 0.3) => {
    const res = stepThumb(s, r, x, t);
    s = res.state;
    return res.fire;
  };
  assert.equal(step(0.5, 0), false, 'tucked fist arms');
  assert.equal(step(1.0, 100), true, 'engage edge fires');
  assert.equal(step(1.0, 133), false, 'held thumbs-up does not refire');
  assert.equal(step(0.7, 166), false, 'inside hysteresis: still engaged');
  assert.equal(step(1.0, 200), false, 'no new edge without a release');
  assert.equal(step(0.5, 233), false, 'released + re-armed');
  assert.equal(step(1.0, 300), false, 'a new flick inside the 250ms debounce is swallowed');
  assert.equal(step(0.5, 340), false);
  assert.equal(step(1.0, 400), true, '250ms since the last fire — no 2.5s cooldown here');
  assert.equal(step(0.5, 433, NaN), false, 'NaN readings leave the state untouched');
  assert.equal(GESTURE.thumbDebounceMs, 250);
  assert.ok(!('boostCooldownMs' in GESTURE), 'the 2.5s cooldown lives in the kart');
  assert.ok(!('pinchEngage' in GESTURE) && !('pinchRelease' in GESTURE), 'pinch boost is gone');

  // A one-detection dropout of the flicking hand mid-thumbs-up does not
  // produce a second edge when it returns.
  const f = new HandGestureFilter();
  const warm = run(f, () => twoHands(0), 0, 300);
  const up = () => twoHands(0, { right: { thumb: 1.0 } });
  const a = run(f, up, warm.t, 150);
  f.onDetection(a.t + 20, [twoHands(0)[0]], W, H); // right hand missing for one detection
  f.sample(a.t + 20);
  const b = run(f, up, a.t + 40, 300);
  assert.equal(a.boosts + b.boosts, 1);
});

test('hands never drift, even at full lock with the gas on', () => {
  assert.ok(!('driftOnSteer' in GESTURE) && !('driftOffSteer' in GESTURE), 'auto-drift constants are gone');
  const f = new HandGestureFilter();
  const r = run(f, () => twoHands(45), 0, 2000);
  assert.ok(r.last.steer > 0.97);
  assert.equal(r.minThrottle, 1);
  assert.equal(r.maxDrift, 0);
  const g = new HandGestureFilter();
  assert.equal(run(g, () => twoHands(-45, { open: 1.15 }), 0, 1000).maxDrift, 0);
});

test('all hands lost: steer holds 300ms then eases to 0; gas/brake hold 300ms then coast', () => {
  const f = new HandGestureFilter();
  const { t: lostAt } = run(f, () => twoHands(24), 0, 800);
  const held = f.sf;
  assert.ok(Math.abs(held - 0.5) < 0.02, `settled at ${held}`);
  const oneHand = () => [twoHands(24)[0]]; // drops the right hand, keeps the left
  let t = lostAt;
  const at = (ms: number) => {
    while (t < lostAt + ms) {
      t += 1000 / 60;
      f.onDetection(t, oneHand(), W, H);
      f.sample(t);
    }
    return f.sf;
  };
  assert.ok(Math.abs(at(150) - held) < 1e-9, 'held at 150ms');
  assert.ok(Math.abs(at(250) - held) < 1e-9, 'held at 250ms');
  const easing = at(450);
  assert.ok(easing < held * 0.5 && easing > 0, `easing at 450ms: ${easing}`);
  assert.ok(Math.abs(at(1200)) < 0.01, 'back to centre');

  // Every hand gone: the combined gas is held briefly, then coasts.
  const g = new HandGestureFilter();
  const { t: goneAt } = run(g, () => twoHands(30), 0, 800);
  g.onDetection(goneAt, [], W, H);
  let c = g.sample(goneAt + 16);
  assert.equal(c.throttle, 1, 'briefly held, same idea as steering');
  assert.equal(c.drift, 0);
  c = g.sample(goneAt + GESTURE.throttleHoldMs - 20);
  assert.equal(c.throttle, 1, 'still held just inside 300ms');
  c = g.sample(goneAt + GESTURE.throttleHoldMs + 20);
  assert.deepEqual([c.throttle, c.brake], [0, 0], 'coasts once the hold elapses');
  const late = run(g, () => [], goneAt + 16, 1500).last;
  assert.ok(Math.abs(late.steer) < 0.01);
  assert.deepEqual([late.throttle, late.brake], [0, 0], 'no hands: coast');

  // Brake holds the same way.
  const b = new HandGestureFilter();
  const { t: bGone } = run(b, () => twoHands(0, { open: 1.15 }), 0, 400);
  b.onDetection(bGone, [], W, H);
  assert.equal(b.sample(bGone + 100).brake, 1);
  assert.equal(b.sample(bGone + GESTURE.throttleHoldMs + 20).brake, 0);
});

test('stale tracker counts as no hands', () => {
  const f = new HandGestureFilter();
  const { t } = run(f, () => twoHands(0), 0, 300);
  assert.equal(f.sample(t).throttle, 1);
  assert.equal(f.sample(t + GESTURE.staleMs + 50).throttle, 0);
});


// §stage2 review fix: extrapolateSteer is gone entirely (it doubled the
// effective gain on inter-detection noise) — steering now chases the latest
// detection directly through the EMA. Covered end-to-end by the ±45deg test
// above (steer settles smoothly at the target with no overshoot) and the
// noisy-boundary test (no flicker from a jittery detection stream).

test('calibration: median, ±20deg clamp, brief dropout tolerated, long dropout restarts', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.ok(Math.abs(calibrationTheta0([5 * DEG, 6 * DEG, 50 * DEG, 4 * DEG, 5.5 * DEG]) - 5.5 * DEG) < 1e-12);
  assert.equal(calibrationTheta0([30 * DEG, 31 * DEG, 29 * DEG]), 20 * DEG);
  assert.equal(calibrationTheta0([-40 * DEG]), -20 * DEG);
  assert.equal(calibrationTheta0([]), 0);

  const cal = new Calibration(3000);
  let result = null as number | null;
  cal.onDone = (th) => (result = th);
  cal.start();
  let t = 0;
  for (; t < 2000; t += 33) cal.feed(t, 8 * DEG);
  assert.ok(cal.progress > 0.6 && cal.running);

  // §stage2 defect fix: a single missed detection (one camera frame, ~33ms)
  // must not throw the whole 3s hold away.
  const progressBeforeBlip = cal.progress;
  t += 33;
  cal.feed(t, null);
  assert.ok(cal.running && !cal.waitingForHands, 'a <200ms dropout keeps the window alive');
  assert.equal(cal.progress, progressBeforeBlip, "progress doesn't regress either");
  t += 33;
  cal.feed(t, 8 * DEG); // hand returns well inside the tolerance
  assert.ok(cal.progress > progressBeforeBlip);

  // A dropout that outlasts the 200ms tolerance DOES restart the window.
  t += 250;
  cal.feed(t, null);
  assert.equal(cal.progress, 0);
  assert.ok(cal.waitingForHands);

  const restartAt = t + 33;
  for (t = restartAt; t < restartAt + 2900; t += 33) cal.feed(t, 3 * DEG);
  assert.equal(result, null, 'restart needs a full 3s again');
  for (; t <= restartAt + 3100; t += 33) cal.feed(t, 3 * DEG);
  assert.equal(cal.state, 'done');
  assert.ok(result !== null && Math.abs(result - 3 * DEG) < 1e-12, 'only post-restart samples count');
});

// §stage2 defect fix: calibration must cancel on any transition out of LOBBY
// (wired in main.ts via RaceDirector.onStateChange) so a mid-race steering
// angle can never bleed into theta0. The cancel() contract itself, exercised
// here: cancelling mid-hold with no completed result yet drops back to idle
// (not "done" with a stale/partial average), and a later restart needs the
// full window again — exactly as if the player had never started.
test('calibration cancel (leaving LOBBY): drops an in-progress hold, restart needs a full window', () => {
  const cal = new Calibration(3000);
  let result: number | null = null;
  cal.onDone = (th) => (result = th);

  cal.start();
  let t = 0;
  for (; t < 1500; t += 33) cal.feed(t, 20 * DEG); // well short of the 3s hold — race left LOBBY here
  assert.ok(cal.running);
  cal.cancel();
  assert.equal(cal.state, 'idle', 'no completed result yet — cancelling drops back to idle, not done');
  assert.equal(cal.running, false);
  assert.equal(result, null);

  // Feeding while cancelled (e.g. a stray detection during COUNTDOWN/RACING)
  // must be a no-op — this is the "only feed in LOBBY" half of the fix,
  // enforced by main.ts gating the feed call; Calibration itself simply
  // ignores feed() outside 'running' regardless.
  cal.feed(t + 33, 20 * DEG);
  assert.equal(cal.state, 'idle');

  // Restarting (re-entering LOBBY) needs the full 3s again — no credit for
  // the 1.5s it had before the cancel.
  cal.start();
  const restartAt = t + 33;
  for (t = restartAt; t < restartAt + 2900; t += 33) cal.feed(t, 5 * DEG);
  assert.equal(result, null);

  // Cancelling AFTER a completed calibration (e.g. leaving LOBBY on a later
  // race) must keep the last good theta0 rather than discarding it — a
  // player who already calibrated shouldn't lose that just because a race
  // started.
  const done = new Calibration(3000);
  let doneResult: number | null = null;
  done.onDone = (th) => (doneResult = th);
  done.start();
  for (let dt2 = 0; dt2 <= 3100; dt2 += 33) done.feed(dt2, 7 * DEG);
  assert.equal(done.state, 'done');
  assert.ok(doneResult !== null);
  done.cancel();
  assert.equal(done.state, 'done', 'a completed calibration is not thrown away by a later cancel');
  assert.equal(done.theta0, doneResult);
});


test('handedness: two hands by mirrored wrist x, one hand by flipped label', () => {
  const a = makeHand({ x: 0.8, y: 0.5, label: 'Left' }); // mislabelled on purpose
  const b = makeHand({ x: 0.2, y: 0.5, label: 'Left' });
  const two = assignHands([b, a]);
  assert.equal(two.left, a, 'raw x 0.8 = mirrored 0.2 = player left');
  assert.equal(two.right, b);

  const onlyRightLabel = makeHand({ x: 0.5, y: 0.5, label: 'Right' });
  assert.equal(assignHands([onlyRightLabel]).left, onlyRightLabel, 'MediaPipe "Right" on a raw frame = player left');
  const onlyLeftLabel = makeHand({ x: 0.5, y: 0.5, label: 'Left' });
  assert.equal(assignHands([onlyLeftLabel]).right, onlyLeftLabel);
  assert.deepEqual(assignHands([]), { left: null, right: null });
});
