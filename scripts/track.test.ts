import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { buildLayout } from '../src/game/track/TrackSampler';
import { mapById } from '../src/game/track/maps';
import { GRASS_HALF, ROAD_HALF, SHORTCUT_WALL_HALF } from '../src/game/track/trackData';
import { TrackQuery, sampleAtArcLength, wrapDelta } from '../src/game/track/TrackQuery';
import { createAiState, think } from '../src/game/ai/AiDriver';
import { createKart, stepKart, type KartState } from '../src/game/physics/Kart';
import { groundKart, stepVertical, type AirEvent } from '../src/game/physics/Airborne';
import { resolveWallCollision } from '../src/game/physics/collision';
import { createLapProgress, LapTracker } from '../src/game/race/LapTracker';
import { TUNING } from '../src/game/tuning';
import { SEA_LEVEL } from '../src/game/render/Environment';
import { angleWrap, clamp } from '../src/shared/mathUtils';
import type { ControlState } from '../src/game/input/InputSource';

// §v5 Capricorn Coast: the circuit's geometry and the physics that depends on
// it — corridor clearance, the shortcut union, lap accounting through it, the
// jump and banking — validated on the exact samples the game races on.

const map = mapById('coast');
const layout = buildLayout(map.track);
const { samples, totalLength, checkpoints } = layout;
const shortcut = layout.shortcut!;
const jump = layout.jump!;
const query = new TrackQuery(samples, totalLength, layout.surfaceZones, layout);
const tracker = new LapTracker(checkpoints, samples, totalLength);
const DT = 1 / 60;
const flat = (a: THREE.Vector3, b: THREE.Vector3) => Math.hypot(a.x - b.x, a.z - b.z);

function control(steer: number, throttle: 0 | 1, brake: 0 | 1 = 0): ControlState {
  return { steer, throttle, brake, drift: 0, boost: 0 };
}

// One full physics tick in main.ts's order: step x/z, wall clamp, then the
// vertical integrator against the ground under the settled position.
function tick(kart: KartState, c: ControlState, topSpeedScale = 1): { air: AirEvent | null; onWall: boolean } {
  const q = query.nearestSample(kart.pos);
  stepKart(kart, c, DT, q.offRoad, topSpeedScale, query.surfaceUnder(q));
  const onWall = resolveWallCollision(kart, query);
  const air = stepVertical(kart, query.nearestSample(kart.pos).groundY, DT);
  return { air, onWall };
}

function kartAt(s: number, lateral = 0, speed = 0): KartState {
  const sample = sampleAtArcLength(samples, totalLength, s);
  const pos = sample.pos.clone().addScaledVector(sample.right, lateral);
  const kart = createKart(pos, Math.atan2(sample.forward.x, sample.forward.z));
  kart.pos.y = query.nearestSample(kart.pos).groundY;
  kart.speed = speed;
  return kart;
}

test('closed loop: ~1.1km, no self-intersection with full corridor clearance, drivable radii and grades', () => {
  const n = samples.length;
  let clearance = Infinity;
  let radius = Infinity;
  let grade = 0;
  for (let i = 0; i < n; i++) {
    const a = samples[i];
    const b = samples[(i + 1) % n];
    if (!a.feature && !b.feature) grade = Math.max(grade, Math.abs(b.pos.y - a.pos.y) / (totalLength / n));
    const angle = Math.acos(Math.min(1, a.right.dot(b.right)));
    if (angle > 1e-5) radius = Math.min(radius, flat(a.pos, b.pos) / angle);
    for (let j = i + 1; j < n; j++) {
      const gap = ((j - i) * totalLength) / n;
      if (Math.min(gap, totalLength - gap) <= 45) continue;
      clearance = Math.min(clearance, flat(a.pos, samples[j].pos));
    }
  }
  // The seam closes: the last sample is one spacing from the first.
  assert.ok(Math.abs(flat(samples[n - 1].pos, samples[0].pos) - totalLength / n) < 0.05);
  console.log({ metres: Math.round(totalLength), clearance: +clearance.toFixed(1), radius: +radius.toFixed(1), grade: +grade.toFixed(3) });
  assert.ok(totalLength > 1000 && totalLength < 1250, 'about 1.1km');
  assert.ok(clearance > 2 * GRASS_HALF + 2, 'separate full-width corridors never touch');
  assert.ok(radius > GRASS_HALF + 2, 'inside verge must not fold over');
  assert.ok(grade <= 0.12, 'within camera/physics slope budget');
  // Banked verges never dip into the sea (the ocean would be drawn over them).
  for (const sample of samples) {
    if (sample.feature) continue;
    const lowEdge = sample.pos.y - GRASS_HALF * Math.abs(Math.tan(sample.bank));
    assert.ok(lowEdge > SEA_LEVEL + 0.4, `verge above water at s=${sample.s.toFixed(0)} (${lowEdge.toFixed(2)})`);
  }
  // Grid and checkpoints.
  for (const s of [-12, -8, -4, 0, 4]) {
    const sample = sampleAtArcLength(samples, totalLength, s);
    assert.ok(Math.abs(sample.pos.y) < 0.05 && Math.abs(sample.bank) < 1e-6, 'grid is flat and unbanked');
  }
  for (let i = 0; i < checkpoints.length; i++) {
    const gap = (samples[checkpoints[(i + 1) % checkpoints.length]].s - samples[checkpoints[i]].s + totalLength) % totalLength;
    assert.ok(gap > 60, '24m wrap guard must fit within 80% of half the gap');
  }
  for (const zone of layout.surfaceZones) {
    assert.ok(zone.sStart > 0 && zone.sEnd > zone.sStart && zone.sEnd < totalLength);
    const mid = sampleAtArcLength(samples, totalLength, (zone.sStart + zone.sEnd) / 2);
    assert.equal(mid.zone, 'harbour', 'boost pads sit on the breakwater');
  }
});

test('shortcut corridor is clear of the main corridor except at its two junctions', () => {
  const need = GRASS_HALF + SHORTCUT_WALL_HALF + 2;
  const sep = shortcut.samples.map((p) => Math.min(...samples.map((m) => flat(p.pos, m.pos))));
  let lo = 0;
  while (lo < sep.length && sep[lo] < need) lo++;
  let hi = sep.length - 1;
  while (hi > 0 && sep[hi] < need) hi--;
  const mouth = shortcut.samples[lo].s;
  const tail = shortcut.length - shortcut.samples[hi].s;
  console.log({ shortcut: Math.round(shortcut.length), bypassed: Math.round(shortcut.exitS - shortcut.entryS), mouth: Math.round(mouth), tail: Math.round(tail) });
  assert.ok(mouth < 45 && tail < 45, 'junction overlaps are short forks, not a shared corridor');
  for (let i = lo; i <= hi; i++) assert.ok(sep[i] >= need, `separated at shortcut s=${shortcut.samples[i].s.toFixed(0)}`);
  assert.ok(shortcut.length < 0.85 * (shortcut.exitS - shortcut.entryS), 'it is actually a shortcut');
  // Junctions are flat and at matching heights, so switching corridor never snaps a kart vertically.
  for (const s of [shortcut.entryS, shortcut.exitS]) assert.ok(Math.abs(query.bankAt(s)) < 0.02);
});

test('shortcut region is drivable dirt, walled, and open to the main road at both ends', () => {
  const mid = shortcut.samples.slice(20, -20);
  for (const p of mid) {
    const q = query.nearestSample(p.pos);
    assert.equal(q.corridor, 'shortcut');
    assert.equal(query.surfaceUnder(q), 'dirt');
    assert.ok(Math.abs(q.lateral) < 0.3 && Math.abs(q.groundY - p.pos.y) < 0.05);
    assert.ok(Math.abs(q.lateral) <= ROAD_HALF, 'dirt is not grass: no double off-road penalty');
  }
  // Walled: a kart outside the fence (in the cane) is pushed back inside.
  for (const p of mid.filter((_, i) => i % 10 === 0)) {
    for (const side of [-1, 1]) {
      const kart = createKart(p.pos.clone().addScaledVector(p.right, side * (SHORTCUT_WALL_HALF + 1.5)));
      resolveWallCollision(kart, query);
      const q = query.nearestSample(kart.pos);
      assert.equal(q.corridor, 'shortcut');
      assert.ok(Math.abs(q.lateral) <= SHORTCUT_WALL_HALF - TUNING.kartRadius + 0.01, 'clamped inside the fence');
    }
  }
  // Open: walking the whole centerline from main road to main road never
  // meets a wall (the main wall has an opening at each junction).
  for (let i = 0; i < shortcut.samples.length - 1; i++) {
    for (let t = 0; t < 1; t += 0.25) {
      const pos = shortcut.samples[i].pos.clone().lerp(shortcut.samples[i + 1].pos, t);
      const kart = createKart(pos);
      resolveWallCollision(kart, query);
      assert.ok(flat(kart.pos, pos) < 1e-6, `no wall across the shortcut at s=${shortcut.samples[i].s.toFixed(1)}`);
    }
  }
  // Main-road kerbs next to the junctions are still walls.
  const beside = sampleAtArcLength(samples, totalLength, shortcut.entryS - 30);
  for (const side of [-1, 1]) {
    const kart = createKart(beside.pos.clone().addScaledVector(beside.right, side * (GRASS_HALF + 1)));
    resolveWallCollision(kart, query);
    assert.ok(Math.abs(query.nearestSample(kart.pos).lateral) <= GRASS_HALF - TUNING.kartRadius + 0.01);
  }
});

// Pure-pursuit driver along an explicit path (a list of points), used to take
// the shortcut deliberately — the AI never does.
function driveLaps(path: THREE.Vector3[], laps: number) {
  const kart = kartAt(0, 0);
  const progress = createLapProgress(0);
  let pathIdx = 0;
  let shortcutTicks = 0;
  let maxJump = 0;
  let lastS = query.nearestSample(kart.pos).s;
  let ticks = 0;
  for (; ticks < 60 * 90 * laps && !progress.finished; ticks++) {
    for (let k = 0; k < 12; k++) {
      const next = (pathIdx + 1) % path.length;
      if (flat(path[next], kart.pos) < flat(path[pathIdx], kart.pos)) pathIdx = next;
      else break;
    }
    const target = path[(pathIdx + Math.round(6 + Math.abs(kart.speed) * 0.35)) % path.length];
    const angle = angleWrap(Math.atan2(target.x - kart.pos.x, target.z - kart.pos.z) - kart.heading);
    const tight = Math.abs(angle) > 0.35 && kart.speed > 16;
    tick(kart, control(clamp(angle * 2.2, -1, 1), tight ? 0 : 1, tight ? 1 : 0));
    const q = query.nearestSample(kart.pos);
    if (q.corridor === 'shortcut') shortcutTicks++;
    maxJump = Math.max(maxJump, Math.abs(wrapDelta(q.s, lastS, totalLength)));
    lastS = q.s;
    tracker.update(progress, q.s);
  }
  return { progress, shortcutTicks, maxJump, seconds: ticks / 60 };
}

test('lap progress through the shortcut counts every checkpoint and completes laps', () => {
  // Main line with the S-bend replaced by the shortcut.
  const path: THREE.Vector3[] = [];
  let spliced = false;
  for (const sample of samples) {
    if (sample.s > shortcut.entryS && sample.s < shortcut.exitS) {
      if (!spliced) for (const p of shortcut.samples) path.push(p.pos);
      spliced = true;
      continue;
    }
    path.push(sample.pos);
  }
  const viaShortcut = driveLaps(path, 3);
  const viaMain = driveLaps(samples.map((s) => s.pos), 3);
  for (const [name, r] of Object.entries({ viaShortcut, viaMain })) {
    console.log(name, { laps: r.progress.lap, seconds: +r.seconds.toFixed(1), shortcutTicks: r.shortcutTicks, maxSJump: +r.maxJump.toFixed(2) });
  }
  assert.equal(viaShortcut.progress.finished, true, 'three laps complete via the shortcut');
  assert.equal(viaShortcut.progress.lap, 3);
  assert.ok(viaShortcut.shortcutTicks > 3 * 60 * 5, 'actually drove the dirt each lap');
  assert.ok(viaShortcut.maxJump < 10, 'mapped progress is continuous (no checkpoint can be jumped)');
  assert.equal(viaMain.progress.finished, true);
  assert.equal(viaMain.shortcutTicks, 0);

  // Mapped s is monotonic along the shortcut and spans exactly the bypassed arc.
  for (let i = 1; i < shortcut.samples.length; i++) {
    assert.ok(shortcut.samples[i].mainS >= shortcut.samples[i - 1].mainS);
  }
  assert.equal(shortcut.samples[0].mainS, shortcut.entryS);
  assert.equal(shortcut.samples[shortcut.samples.length - 1].mainS, shortcut.exitS);
  // Abuse: driving the shortcut backwards (exit -> entry) never validates a checkpoint.
  const back = createLapProgress(0);
  back.nextCheckpoint = checkpoints.findIndex((cp) => samples[cp].s > shortcut.entryS + 5);
  const before = back.nextCheckpoint;
  for (let i = shortcut.samples.length - 1; i >= 0; i--) {
    tracker.update(back, query.nearestSample(shortcut.samples[i].pos).s);
  }
  assert.equal(back.nextCheckpoint, before);
});

// Follows the main centerline 14m ahead (the AI's own lookahead idea).
function steerAlong(kart: KartState): number {
  const target = sampleAtArcLength(samples, totalLength, query.nearestSample(kart.pos).s + 14).pos;
  return clamp(angleWrap(Math.atan2(target.x - kart.pos.x, target.z - kart.pos.z) - kart.heading) * 2.2, -1, 1);
}

function jumpRun(speed: number, boost = false) {
  const kart = kartAt(jump.lipS - 45, 0, speed);
  let takeoffS: number | null = null;
  let landS: number | null = null;
  let airtime = 0;
  let maxHeightAboveGround = 0;
  for (let i = 0; i < 60 * 8; i++) {
    if (boost) kart.boostTimer = 1;
    const { air } = tick(kart, control(steerAlong(kart), 1));
    const q = query.nearestSample(kart.pos);
    if (air === 'takeoff' && takeoffS === null) takeoffS = q.s;
    if (air === 'land' && landS === null) {
      landS = q.s;
      airtime = kart.airTime;
    }
    if (kart.airborne) maxHeightAboveGround = Math.max(maxHeightAboveGround, kart.pos.y - q.groundY);
    if (q.s > jump.gapEndS + 30 && !kart.airborne) break;
  }
  return { kart, takeoffS, landS, airtime, maxHeightAboveGround };
}

test('jump: race speed takes off at the lip, clears the rail gap with real airtime, and lands', () => {
  for (const [speed, boost] of [
    [TUNING.topSpeed, false],
    [TUNING.topSpeed * TUNING.boostSpeedMult, true],
  ] as const) {
    const r = jumpRun(speed, boost);
    console.log({ speed: +speed.toFixed(1), takeoff: r.takeoffS && +(r.takeoffS - jump.lipS).toFixed(2), land: r.landS && +(r.landS - jump.lipS).toFixed(1), airtime: +r.airtime.toFixed(2), peak: +r.maxHeightAboveGround.toFixed(2) });
    assert.ok(r.takeoffS !== null && Math.abs(r.takeoffS - jump.lipS) < 2.5, 'leaves the ground at the lip');
    assert.ok(r.landS !== null && r.landS > jump.gapEndS, 'lands beyond the gap');
    assert.ok(r.airtime > 0.45, 'visible airtime');
    assert.equal(r.kart.airborne, false);
  }
  // A crawling kart drops into the rail cutting and drives out the far side.
  const slow = kartAt(jump.lipS - 6, 0, 4);
  let passed = false;
  for (let i = 0; i < 60 * 20 && !passed; i++) {
    tick(slow, control(steerAlong(slow), 1));
    slow.speed = Math.min(slow.speed, 5);
    passed = query.nearestSample(slow.pos).s > jump.gapEndS + 5;
  }
  assert.ok(passed, 'slow karts never get stuck in the cutting');
  // Smooth crests never launch anyone: a full-speed lap without the jump region has no takeoffs.
  const kart = kartAt(jump.gapEndS + 20, 0, TUNING.topSpeed);
  let takeoffs = 0;
  for (let i = 0; i < 60 * 30; i++) {
    const { air } = tick(kart, control(steerAlong(kart), 1));
    const s = query.nearestSample(kart.pos).s;
    if (air === 'takeoff' && !(s > jump.rampStartS && s < jump.gapEndS + 5)) takeoffs++;
  }
  assert.equal(takeoffs, 0, 'no spurious hops on crests/banking');
});

test('banking: ground height follows the roll across the road and stays continuous', () => {
  // Sign: + bank lowers the right edge.
  const banked = samples.reduce((a, b) => (Math.abs(b.bank) > Math.abs(a.bank) ? b : a));
  assert.ok(Math.abs(banked.bank) > (10 * Math.PI) / 180, 'the corners really are banked');
  const at = (lat: number) => query.groundHeightAt(banked.pos.clone().addScaledVector(banked.right, lat));
  const drop = at(-6) - at(6);
  assert.ok(Math.abs(drop - 12 * Math.tan(banked.bank)) < 0.05, 'height = centre - lateral * tan(bank)');
  assert.ok(Math.sign(drop) === Math.sign(banked.bank));
  assert.ok(Math.abs(query.bankAt(banked.s) - banked.bank) < 1e-9);
  assert.ok(Math.abs(query.nearestSample(banked.pos).bank - banked.bank) < 0.01);

  // Every properly banked stretch leans INTO its corner: the lowered edge is
  // on the side the road is turning toward (catches a sign slip when editing).
  let wrongWay = 0;
  for (const sample of samples) {
    if (Math.abs(sample.bank) < (4 * Math.PI) / 180) continue;
    const ahead = sampleAtArcLength(samples, totalLength, sample.s + 8);
    const behind = sampleAtArcLength(samples, totalLength, sample.s - 8);
    const turn = ahead.right.clone().sub(behind.right).dot(sample.forward); // >0: turning toward -right
    if (Math.abs(turn) < 0.05) continue;
    // Lowered side is +right when bank > 0; the inside is +right when turn < 0.
    if (Math.sign(sample.bank) !== -Math.sign(turn)) wrongWay++;
  }
  assert.equal(wrongWay, 0, 'banks lean into their corners');

  // Continuity: dense raster over every banked stretch (away from the jump
  // and the shortcut mouths); no 0.1m step may change the height by more than
  // the steepest legitimate slope allows.
  let worst = 0;
  const step = 0.1;
  for (let i = 0; i < samples.length; i += 3) {
    const sample = samples[i];
    if (Math.abs(sample.bank) < 0.02 || sample.feature) continue;
    if (Math.abs(wrapDelta(sample.s, jump.lipS, totalLength)) < 40) continue;
    for (let lat = -GRASS_HALF + 1.5; lat <= GRASS_HALF - 1.5; lat += 2.5) {
      let prev: number | null = null;
      for (let ds = 0; ds <= 6; ds += step) {
        const pos = sample.pos.clone().addScaledVector(sample.right, lat).addScaledVector(new THREE.Vector3(sample.forward.x, 0, sample.forward.z).normalize(), ds);
        const y = query.groundHeightAt(pos);
        if (prev !== null) worst = Math.max(worst, Math.abs(y - prev));
        prev = y;
      }
      let prevLat: number | null = null;
      for (let l2 = -GRASS_HALF + 1.5; l2 <= GRASS_HALF - 1.5; l2 += step) {
        const y = query.groundHeightAt(sample.pos.clone().addScaledVector(sample.right, l2));
        if (prevLat !== null) worst = Math.max(worst, Math.abs(y - prevLat));
        prevLat = y;
      }
    }
  }
  console.log({ worstHeightStepPer10cm: +worst.toFixed(4) });
  assert.ok(worst < 0.04, 'bank-aware ground height is continuous');
});

test('all AI lane preferences finish three laps, taking the jump, without recovery teleports', () => {
  for (const lane of [-2, -0.7, 0.7, 2]) {
    const kart = kartAt(0, lane);
    kart.isAi = true;
    const ai = createAiState(lane);
    ai.jitter = 0;
    const progress = createLapProgress(0);
    let onWall = false;
    let recoveries = 0;
    let offRoad = 0;
    let takeoffs = 0;
    let lands = 0;
    let ticks = 0;
    for (; ticks < 60 * 360 && !progress.finished; ticks++) {
      const q = query.nearestSample(kart.pos);
      const before = kart.pos.clone();
      const { control: c, topSpeedScale } = think(ai, kart, q.s, q.lateral, onWall, samples, totalLength, progress.progress, progress.progress, DT);
      if (flat(before, kart.pos) > 1) recoveries++;
      if (Math.abs(q.lateral) > ROAD_HALF) offRoad++;
      const r = tick(kart, c, topSpeedScale);
      onWall = r.onWall;
      if (r.air === 'takeoff') takeoffs++;
      if (r.air === 'land') lands++;
      tracker.update(progress, query.nearestSample(kart.pos).s);
    }
    console.log({ lane, seconds: +(ticks / 60).toFixed(1), laps: progress.lap, recoveries, offRoadFraction: +(offRoad / ticks).toFixed(3), takeoffs, lands });
    assert.equal(progress.finished, true, `lane ${lane} completes the race`);
    assert.equal(recoveries, 0, `lane ${lane} never gets stuck`);
    assert.ok(offRoad / ticks < 0.1, `lane ${lane} keeps a usable racing line`);
    assert.ok(takeoffs >= 3 && lands >= 3, `lane ${lane} jumps the rail every lap`);
  }
});

// --- §v5 track review regressions -------------------------------------------

test('review #1: an AI recovery teleport on a banked section never launches the kart', () => {
  const banked = samples.reduce((a, b) => (Math.abs(b.bank) > Math.abs(a.bank) ? b : a));
  for (const lane of [-2, -0.7, 0.7, 2]) {
    const ai = createAiState(lane);
    ai.jitter = 0;
    // Pinned, stopped, against the outer wall of the steepest bank.
    const kart = createKart(banked.pos.clone().addScaledVector(banked.right, GRASS_HALF - TUNING.kartRadius));
    kart.heading = Math.atan2(banked.forward.x, banked.forward.z);
    kart.isAi = true;
    groundKart(kart, query.nearestSample(kart.pos).groundY);
    ai.stuckTimer = 100; // recovery fires on this think()
    const q0 = query.nearestSample(kart.pos);
    const first = think(ai, kart, q0.s, q0.lateral, true, samples, totalLength, 0, 0, DT);
    assert.equal(first.teleported, true);
    groundKart(kart, query.nearestSample(kart.pos).groundY); // what main.ts does on `teleported`
    let peak = 0;
    let takeoffs = 0;
    let c = first.control;
    for (let t = 0; t < 120; t++) {
      if (tick(kart, c).air === 'takeoff') takeoffs++;
      const q = query.nearestSample(kart.pos);
      peak = Math.max(peak, kart.pos.y - q.groundY);
      c = think(ai, kart, q.s, q.lateral, false, samples, totalLength, 0, 0, DT).control;
    }
    assert.equal(takeoffs, 0, `lane ${lane}: no hop after recovery`);
    assert.ok(peak < 0.3, `lane ${lane}: peak ${peak.toFixed(2)}m above ground`);
  }
  // The integrator on its own: a grounded kart whose height is well below
  // the ground (a teleport that forgot to re-plant) is snapped onto it with no
  // vertical speed, rather than banking the step as vy and launching.
  const kart = kartAt(banked.s, 0, 5);
  const groundY = kart.pos.y;
  kart.pos.y -= 0.6;
  assert.equal(stepVertical(kart, groundY, DT), null);
  assert.equal(kart.vy, 0);
  assert.equal(kart.pos.y, groundY);
  assert.equal(stepVertical(kart, groundY, DT), null);
});

test('review #1: reversing up out of the rail cutting and over the lip does not hop', () => {
  // Parked at the bottom of the cutting facing along the track, then
  // flat-out reverse (brake held) up the cutting wall and over the lip.
  const kart = kartAt(jump.lipS + (jump.gapEndS - jump.lipS) / 2, 0, 0);
  let peak = 0;
  let takeoffs = 0;
  let crossed = false;
  for (let t = 0; t < 60 * 8 && !crossed; t++) {
    if (tick(kart, control(0, 0, 1)).air === 'takeoff') takeoffs++;
    const q = query.nearestSample(kart.pos);
    peak = Math.max(peak, kart.pos.y - q.groundY);
    crossed = wrapDelta(q.s, jump.lipS, totalLength) < -8;
  }
  console.log({ reverseOverLip: { crossed, takeoffs, peak: +peak.toFixed(3), speed: +kart.speed.toFixed(1) } });
  assert.ok(crossed, 'actually reversed over the lip');
  assert.ok(peak < 0.3, `no hop over the lip (peak ${peak.toFixed(2)}m)`);
});

test('review #2: the shortcut corridor ends at its end samples (no phantom strip past the fork/rejoin)', () => {
  // A grid round both end samples, out past the main wall: nothing behind the
  // fork's start plane or beyond the rejoin's end plane may classify as
  // shortcut — the phantom strip let karts through the outer main wall near
  // s≈661 and s≈930.
  const pts = shortcut.samples;
  const ends = [
    { p: pts[0], dir: -1 },
    { p: pts[pts.length - 1], dir: 1 },
  ];
  let phantom = 0;
  let pushedIllegal = 0;
  const v = new THREE.Vector3();
  for (const { p, dir } of ends) {
    const f = new THREE.Vector3(p.forward.x, 0, p.forward.z).normalize();
    for (let dx = -25; dx <= 25; dx += 0.25) {
      for (let dz = -25; dz <= 25; dz += 0.25) {
        v.set(p.pos.x + dx, 0, p.pos.z + dz);
        const along = (dx * f.x + dz * f.z) * dir; // > 0: beyond this end
        const q = query.nearestSample(v);
        if (q.corridor === 'shortcut' && along > 0.01) phantom++;
        // Anything just outside the legal region is clamped back into it,
        // along whichever corridor's own `right` it was pushed by.
        const excess = Math.abs(q.lateral) - (q.wallHalf - TUNING.kartRadius);
        if (excess > 0 && excess < 1) {
          const kart = createKart(v);
          resolveWallCollision(kart, query);
          const after = query.nearestSample(kart.pos);
          if (Math.abs(after.lateral) > after.wallHalf - TUNING.kartRadius + 0.01) pushedIllegal++;
        }
      }
    }
  }
  assert.equal(phantom, 0, 'no shortcut classification past its ends');
  assert.equal(pushedIllegal, 0, 'wall pushes always land in a legal spot');
  // The reviewer's probes: the outer main wall just behind the fork (s≈661)
  // and just past the rejoin (s≈930) is solid.
  for (const s of [661, 930]) {
    const sample = sampleAtArcLength(samples, totalLength, s);
    for (const side of [-1, 1]) {
      const kart = createKart(sample.pos.clone().addScaledVector(sample.right, side * (GRASS_HALF + 0.5)));
      resolveWallCollision(kart, query);
      const q = query.nearestSample(kart.pos);
      assert.equal(q.corridor, 'main', `s=${s} side ${side}`);
      assert.ok(Math.abs(q.lateral) <= GRASS_HALF - TUNING.kartRadius + 0.01, `s=${s} side ${side}: wall holds`);
    }
  }
});

test('review #3: the shortcut mouths drive as dirt, not grass', () => {
  let grass = 0;
  let dirtOnVerge = 0;
  for (const p of shortcut.samples) {
    for (const lat of [-4, 0, 4]) {
      const q = query.nearestSample(p.pos.clone().addScaledVector(p.right, lat));
      if (q.offRoad) grass++;
      if (q.corridor === 'main' && Math.abs(q.lateral) > ROAD_HALF) {
        assert.equal(q.dirt, true);
        assert.equal(query.surfaceUnder(q), 'dirt');
        dirtOnVerge++;
      }
    }
  }
  assert.equal(grass, 0, 'nowhere on the dirt ribbon counts as grass');
  assert.ok(dirtOnVerge > 0, 'the mouths really do cross the main verge');
  // Plain verge away from the shortcut is still grass.
  const verge = sampleAtArcLength(samples, totalLength, shortcut.entryS - 30);
  for (const side of [-1, 1]) {
    const q = query.nearestSample(verge.pos.clone().addScaledVector(verge.right, side * (ROAD_HALF + 2)));
    assert.equal(q.offRoad, true);
    assert.equal(q.dirt, false);
  }
});

test('review #6: switching corridor at the fork and the rejoin is seamless (no step, no hop)', () => {
  // Ground continuity over the legal region of both junction boxes.
  const v = new THREE.Vector3();
  let worst = 0;
  for (const c of [shortcut.samples[0].pos, shortcut.samples[shortcut.samples.length - 1].pos]) {
    const h = 0.2;
    for (let x = c.x - 30; x <= c.x + 30; x += h) {
      let prev: { y: number; ok: boolean } | null = null;
      for (let z = c.z - 30; z <= c.z + 30; z += h) {
        v.set(x, 0, z);
        const q = query.nearestSample(v);
        const ok = Math.abs(q.lateral) <= q.wallHalf - TUNING.kartRadius && Math.abs(wrapDelta(q.s, jump.lipS, totalLength)) > 20;
        if (prev && prev.ok && ok) worst = Math.max(worst, Math.abs(q.groundY - prev.y));
        prev = { y: q.groundY, ok };
      }
    }
  }
  console.log({ junctionWorstStepPer20cm: +worst.toFixed(4) });
  assert.ok(worst < 0.05, 'no height step where the corridors meet');

  // Drive into the fork, down the shortcut at every lateral offset (with and
  // without boost) and out through the rejoin: no takeoff or land anywhere.
  for (const lat of [-4, -2, 0, 2, 4]) {
    for (const boost of [false, true]) {
      const path: THREE.Vector3[] = [];
      for (let s = shortcut.entryS - 40; s < shortcut.entryS; s += 2) path.push(sampleAtArcLength(samples, totalLength, s).pos.clone());
      for (const p of shortcut.samples) path.push(p.pos.clone().addScaledVector(p.right, lat));
      for (let s = shortcut.exitS + 3; s < shortcut.exitS + 60; s += 2) path.push(sampleAtArcLength(samples, totalLength, s).pos.clone());
      const kart = kartAt(shortcut.entryS - 40, 0, boost ? TUNING.topSpeed : TUNING.topSpeed * 0.66);
      let pi = 0;
      const events: string[] = [];
      for (let t = 0; t < 60 * 20 && pi < path.length - 2; t++) {
        while (pi < path.length - 1 && flat(path[pi + 1], kart.pos) < flat(path[pi], kart.pos)) pi++;
        const target = path[Math.min(path.length - 1, pi + 5)];
        if (boost) kart.boostTimer = 1;
        const steer = clamp(angleWrap(Math.atan2(target.x - kart.pos.x, target.z - kart.pos.z) - kart.heading) * 2.2, -1, 1);
        const r = tick(kart, control(steer, 1));
        if (r.air) events.push(r.air);
      }
      assert.ok(pi >= path.length - 2, `lat ${lat} boost ${boost}: drove through`);
      assert.deepEqual(events, [], `lat ${lat} boost ${boost}: no takeoff/land at the junctions`);
    }
  }
});
