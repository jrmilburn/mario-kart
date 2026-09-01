import type { TrackSample } from '../track/TrackBuilder';
import { wrapDelta } from '../track/TrackQuery';

export const TOTAL_LAPS = 3;

// Guards teleport/wrap glitches: a checkpoint crossing is only valid if both
// the current and previous wrapDelta magnitudes are within this range (§3.5).
const WRAP_GUARD = 30;

export interface LapProgress {
  lap: number;
  nextCheckpoint: number; // index into the checkpoints array
  lastS: number;
  progress: number; // for positions + rubber-banding
  finished: boolean;
  finishOrder: number | null; // set by the caller when `finished` first becomes true
}

// Kart starts sitting on checkpoint 0 (the finish line): the first thing it
// must validate is checkpoint 1, so cutting straight across the infield can
// never "complete a lap" without passing every gate in order.
export function createLapProgress(startS: number): LapProgress {
  return { lap: 0, nextCheckpoint: 1, lastS: startS, progress: 0, finished: false, finishOrder: null };
}

export class LapTracker {
  constructor(
    private checkpoints: number[],
    private samples: TrackSample[],
    private totalLength: number,
  ) {}

  // Returns true iff this update completed a lap (crossed checkpoint 0 as expected).
  update(p: LapProgress, sNow: number): boolean {
    if (p.finished) return false;

    const cpSampleS = this.samples[this.checkpoints[p.nextCheckpoint]].s;
    const dNow = wrapDelta(sNow, cpSampleS, this.totalLength);
    const dLast = wrapDelta(p.lastS, cpSampleS, this.totalLength);

    let lapCompleted = false;
    if (dNow >= 0 && dLast < 0 && Math.abs(dNow) < WRAP_GUARD && Math.abs(dLast) < WRAP_GUARD) {
      const crossedFinish = p.nextCheckpoint === 0;
      if (crossedFinish) {
        p.lap += 1;
        lapCompleted = true;
        if (p.lap >= TOTAL_LAPS) p.finished = true;
      }
      p.nextCheckpoint = (p.nextCheckpoint + 1) % this.checkpoints.length;
    }

    p.lastS = sNow;
    p.progress = this.computeProgress(p, sNow);
    return lapCompleted;
  }

  private computeProgress(p: LapProgress, sNow: number): number {
    const n = this.checkpoints.length;
    const prevCpIdx = (p.nextCheckpoint - 1 + n) % n;
    const sPrevCp = this.samples[this.checkpoints[prevCpIdx]].s;
    const sNextCp = this.samples[this.checkpoints[p.nextCheckpoint]].s;
    const gapToNextCp = (((sNextCp - sPrevCp) % this.totalLength) + this.totalLength) % this.totalLength;

    const delta = wrapDelta(sNow, sPrevCp, this.totalLength);
    const clamped = Math.max(0, Math.min(delta, gapToNextCp));
    return p.lap * this.totalLength + sPrevCp + clamped;
  }
}
