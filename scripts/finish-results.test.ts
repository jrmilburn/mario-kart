import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFinishSummary, formatLapTime, totalTime } from '../src/game/race/FinishResults';

test('formatLapTime always shows mm:ss.mmm, even for sub-minute laps', () => {
  assert.equal(formatLapTime(34.256), '0:34.256');
  assert.equal(formatLapTime(90.5), '1:30.500');
  assert.equal(formatLapTime(0), '0:00.000');
  assert.equal(formatLapTime(NaN), '--:--.---');
  assert.equal(formatLapTime(-1), '--:--.---');
});

test('totalTime sums lap times', () => {
  assert.ok(Math.abs(totalTime([30, 31.5, 29.25]) - 90.75) < 1e-9);
  assert.equal(totalTime([]), 0);
});

test('solo: title reflects the player\'s own finish position', () => {
  const win = buildFinishSummary('single', [
    { slot: 0, name: 'Mario', colorHex: '#FF5A4E', position: 1, lapTimes: [30, 30, 30] },
  ]);
  assert.equal(win.title, 'YOU WIN!');
  assert.equal(win.winner?.name, 'Mario');

  const third = buildFinishSummary('single', [
    { slot: 0, name: 'Mario', colorHex: '#FF5A4E', position: 3, lapTimes: [30, 30, 30] },
  ]);
  assert.equal(third.title, 'YOU FINISHED 3RD');

  const second = buildFinishSummary('single', [
    { slot: 0, name: 'Mario', colorHex: '#FF5A4E', position: 2, lapTimes: [30, 30, 30] },
  ]);
  assert.equal(second.title, 'YOU FINISHED 2ND');
});

test('versus: title names the better-placed human by name and colour', () => {
  const summary = buildFinishSummary('multi', [
    { slot: 0, name: 'Mario', colorHex: '#FF5A4E', position: 2, lapTimes: [30, 31, 32] },
    { slot: 1, name: 'Luigi', colorHex: '#2FB84F', position: 1, lapTimes: [29, 30, 31] },
  ]);
  assert.equal(summary.title, 'LUIGI WINS!');
  assert.equal(summary.winner?.slot, 1);
  assert.equal(summary.players.length, 2);
  assert.equal(summary.players[0].slot, 0, 'player order is preserved (P1 first), independent of who won');
});

test('versus: a tie in position still resolves to A player, not a crash', () => {
  const summary = buildFinishSummary('multi', [
    { slot: 0, name: 'Mario', colorHex: '#FF5A4E', position: 1, lapTimes: [] },
    { slot: 1, name: 'Luigi', colorHex: '#2FB84F', position: 1, lapTimes: [] },
  ]);
  assert.ok(summary.winner);
  assert.equal(summary.title, `${summary.winner!.name.toUpperCase()} WINS!`);
});

test('no active players is handled without throwing', () => {
  const summary = buildFinishSummary('multi', []);
  assert.equal(summary.winner, null);
  assert.equal(summary.title, 'FINISHED');
});
