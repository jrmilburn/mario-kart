import { calibrationTheta0 } from './gestures';

export const CALIBRATION_MS = 3000;

export type CalibrationState = 'idle' | 'running' | 'done';

// §v5 "hold your hands level" step. The player holds both hands in a level
// wheel grip for 3s; theta0 is the median wheel angle over that window,
// clamped to ±20deg (gestures.calibrationTheta0). Losing either hand for more
// than DROPOUT_TOLERANCE_MS restarts the window from zero — a calibration
// that averaged over a real dropout would bake in whatever the hands were
// doing on the way out of frame — but a single missed detection (one camera
// frame at 20-30Hz is 33-50ms) is tolerated without throwing the hold away
// (§stage2 review fix: this used to restart on ANY null feed, which made
// calibration flaky on exactly the kind of brief tracker hiccup that happens
// constantly in normal use).
//
// DOM-free and clock-free (times come in with each feed), so it is unit
// tested directly; the ring/prompt UI (ui/CalibrationPrompt.ts) just renders
// `state`/`progress`/`waitingForHands`. Stage 2 wires start()/cancel() into
// the menu + race flow (see main.ts: calibration only ever feeds/runs in
// LOBBY, and cancel()s on every transition out of it).
const DROPOUT_TOLERANCE_MS = 200;

export class Calibration {
  state: CalibrationState = 'idle';
  progress = 0; // 0..1 through the current hold window
  waitingForHands = true; // true while the window is empty (no two-hand detection yet)
  theta0: number | null = null; // last completed result
  onDone: ((theta0: number) => void) | null = null;

  private windowStart: number | null = null;
  private samples: number[] = [];
  private lastValidAt: number | null = null; // wall time of the last non-null feed, for dropout tolerance

  constructor(private durationMs = CALIBRATION_MS) {}

  start() {
    this.state = 'running';
    this.resetWindow();
  }

  cancel() {
    if (this.state === 'running') this.state = this.theta0 === null ? 'idle' : 'done';
    this.resetWindow();
  }

  get running(): boolean {
    return this.state === 'running';
  }

  // One call per hand detection. `theta` is the raw two-hand wheel angle, or
  // null when either hand is missing. A null that doesn't outlast
  // DROPOUT_TOLERANCE_MS since the last good sample is ignored outright —
  // the window keeps whatever progress it had, unmodified — so a hand
  // grazing the edge of frame for a detection or two can't cost the whole
  // hold. Only a longer dropout restarts it.
  feed(t: number, theta: number | null) {
    if (this.state !== 'running') return;
    if (theta === null || !Number.isFinite(theta)) {
      if (this.lastValidAt !== null && t - this.lastValidAt < DROPOUT_TOLERANCE_MS) return;
      this.resetWindow();
      return;
    }
    this.lastValidAt = t;
    if (this.windowStart === null) this.windowStart = t;
    this.waitingForHands = false;
    this.samples.push(theta);
    this.progress = Math.min(1, (t - this.windowStart) / this.durationMs);
    if (this.progress >= 1) {
      const theta0 = calibrationTheta0(this.samples);
      this.theta0 = theta0;
      this.state = 'done';
      this.resetWindow();
      this.progress = 1;
      this.onDone?.(theta0);
    }
  }

  private resetWindow() {
    this.windowStart = null;
    this.samples = [];
    this.progress = 0;
    this.waitingForHands = true;
    this.lastValidAt = null;
  }
}
