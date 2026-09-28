import { HandGestureFilter, type DetectionSummary } from '../hands/gestures';
import type { HandTracker } from '../hands/HandTracker';
import type { ControlProvider, ControlState } from './ControlProvider';

// §v5: P1's primary input. A thin adapter — HandTracker delivers detections
// at 20-30Hz, the pure HandGestureFilter (hands/gestures.ts) turns them into a
// ControlState, and the merger samples it once per 60Hz physics tick.
// Active exactly while the camera + model are live; with no hands in frame it
// still has an opinion (coast), because the player *is* on hands, just
// momentarily out of shot — dropping to the keyboard there would be a lie.
export class HandProvider implements ControlProvider {
  readonly kind = 'hands' as const;
  readonly filter = new HandGestureFilter();
  private detectionListeners: ((d: DetectionSummary) => void)[] = [];

  constructor(readonly tracker: HandTracker) {
    tracker.onDetection((d) => {
      const summary = this.filter.onDetection(d.t, d.hands, d.videoW, d.videoH);
      for (const fn of this.detectionListeners) fn(summary);
    });
  }

  // Calibration and the overlay's skeleton redraw listen here, at detection rate.
  onDetection(fn: (d: DetectionSummary) => void) {
    this.detectionListeners.push(fn);
  }

  setTheta0(theta0: number) {
    this.filter.theta0 = theta0;
  }

  isActive(_now: number): boolean {
    return this.tracker.live;
  }

  sample(now: number): ControlState | null {
    if (!this.tracker.live) return null;
    return this.filter.sample(now);
  }
}
