import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSamples } from '../src/game/track/TrackSampler';
import { mapById } from '../src/game/track/maps';
import { CHECKPOINT_COUNT, GRASS_HALF, ROAD_HALF } from '../src/game/track/trackData';
import { TrackQuery, sampleAtArcLength } from '../src/game/track/TrackQuery';
import { createAiState, think } from '../src/game/ai/AiDriver';
import { createKart, stepKart } from '../src/game/physics/Kart';
import { resolveWallCollision } from '../src/game/physics/collision';
import { createLapProgress, LapTracker } from '../src/game/race/LapTracker';

const map = mapById(process.env.TRACK_TEST_MAP ?? 'rainbow');
const { samples, totalLength } = buildSamples(map.controlPoints);
const checkpoints = Array.from({ length: CHECKPOINT_COUNT }, (_, i) => Math.round(i * samples.length / CHECKPOINT_COUNT) % samples.length);

test('Rainbow layout has safe slopes, separated branches and usable corner radii', () => {
  let clearance = Infinity, radius = Infinity, grade = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = samples[i], b = samples[(i + 1) % samples.length];
    grade = Math.max(grade, Math.abs(b.pos.y - a.pos.y) / (totalLength / samples.length));
    const angle = Math.acos(Math.min(1, a.right.dot(b.right)));
    if (angle > 0.00001) radius = Math.min(radius, a.pos.distanceTo(b.pos) / angle);
    for (let j = i + 1; j < samples.length; j++) {
      const gap = (j - i) * totalLength / samples.length;
      if (Math.min(gap, totalLength - gap) <= 40) continue;
      clearance = Math.min(clearance, Math.hypot(a.pos.x - samples[j].pos.x, a.pos.z - samples[j].pos.z));
    }
  }
  console.log({ metres: Math.round(totalLength), clearance, radius, grade });
  assert.ok(clearance > 2 * GRASS_HALF + 2, 'separate full-width track ribbons');
  assert.ok(radius > GRASS_HALF + 2, 'inside road edge must not fold over');
  assert.ok(grade <= 0.12, 'stay within camera/physics slope budget');
});

test('grid remains flat, checkpoints have wrap margin, and pads lie within the lap', () => {
  for (const s of [-10, -8, -4, 0, 4, 8]) {
    assert.ok(Math.abs(sampleAtArcLength(samples, totalLength, s).pos.y) < 0.05);
  }
  for (let i = 0; i < checkpoints.length; i++) {
    const gap = (samples[checkpoints[(i + 1) % checkpoints.length]].s - samples[checkpoints[i]].s + totalLength) % totalLength;
    assert.ok(gap > 60, '24m wrap guard must fit within 80% of half the gap');
  }
  for (const zone of map.surfaceZones) {
    assert.ok(zone.sStart > 0 && zone.sEnd > zone.sStart && zone.sEnd < totalLength);
  }
});

test('all AI lane preferences finish three laps without recovery teleports', () => {
  const query = new TrackQuery(samples, totalLength, map.surfaceZones);
  const tracker = new LapTracker(checkpoints, samples, totalLength);
  for (const lane of [-2, -0.7, 0.7, 2]) {
    const start = samples[0];
    const kart = createKart(start.pos.clone().addScaledVector(start.right, lane), Math.atan2(start.forward.x, start.forward.z), true);
    const ai = createAiState(lane); ai.jitter = 0;
    const progress = createLapProgress(0);
    let onWall = false, recoveries = 0, offRoad = 0, ticks = 0;
    for (; ticks < 60 * 360 && !progress.finished; ticks++) {
      const q = query.nearestSample(kart.pos);
      const before = kart.pos.clone();
      const { control, topSpeedScale } = think(ai, kart, q.s, q.lateral, onWall, samples, totalLength, progress.progress, progress.progress, 1 / 60);
      if (before.distanceTo(kart.pos) > 1) recoveries++;
      if (Math.abs(q.lateral) > ROAD_HALF) offRoad++;
      stepKart(kart, control, 1 / 60, Math.abs(q.lateral) > ROAD_HALF, topSpeedScale, query.surfaceAt(q.s, q.lateral));
      onWall = resolveWallCollision(kart, query);
      const after = query.nearestSample(kart.pos);
      kart.pos.y = after.groundY;
      tracker.update(progress, after.s);
    }
    console.log({ lane, seconds: ticks / 60, laps: progress.lap, recoveries, offRoadFraction: offRoad / ticks });
    assert.equal(progress.finished, true, `lane ${lane} completes the race`);
    assert.equal(recoveries, 0, `lane ${lane} never gets stuck`);
    assert.ok(offRoad / ticks < 0.1, `lane ${lane} keeps a usable racing line`);

  }
});
