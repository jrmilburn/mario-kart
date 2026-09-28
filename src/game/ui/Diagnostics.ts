import { markDebug } from './DebugToggle';
import { GESTURE, type HandReading } from '../hands/gestures';

export interface DiagnosticsData {
  rttMs: number | null;
  inputAgeMs: number | null;
  seq: number | null;
  source: string;
  raceState?: string;
  lap?: number;
  nextCheckpoint?: number;
  stepsThisFrame?: number;
  // §v5 hand tracking: rolling detect() cost, measured/target rate, status.
  detectMs?: number | null;
  detectHz?: number | null;
  targetHz?: number | null;
  handStatus?: string;
  // Live per-hand openness ratio r (fist = gas / open = brake thresholds) and
  // thumb-extension ratio t (thumbs-up boost thresholds), so thresholds can
  // be eyeballed against a real hand instead of guessed from synthetic tests.
  handLeft?: HandReading | null;
  handRight?: HandReading | null;
  // §v5 perf pass: whole-frame renderer totals (both split viewports + the
  // shadow pass + post), the render callback's own CPU time, and the level.
  drawCalls?: number;
  triangles?: number;
  cpuMs?: number;
  quality?: string;
}

const HISTOGRAM_LENGTH = 60;
const HISTOGRAM_BLOCKS = '▁▂▃▄▅▆▇█';
const HISTOGRAM_FPS_CEILING = 70; // fps mapped to a "full bar" in the sparkline

// Backtick-toggle overlay: fps (+ rolling histogram), physics steps/frame,
// RTT, input age, seq (§Phase 1, extended in §Phase 9).
export class Diagnostics {
  private el: HTMLDivElement;
  private visible = false;
  private frames = 0;
  private lastFpsTime = performance.now();
  private lastFrameTime = performance.now();
  private fps = 0;
  private fpsHistory: number[] = [];

  constructor(container: HTMLElement) {
    this.el = document.createElement('div');
    this.el.style.cssText =
      'position:absolute; bottom:12px; right:12px; background:rgba(0,0,0,0.65); color:#0f0; ' +
      'font:12px/1.5 monospace; padding:8px 10px; border-radius:4px; white-space:pre; display:none; pointer-events:none;';
    // §v5: bottom-right now — bottom-left belongs to the hand overlay. H
    // (DebugToggle) hides it along with every other debug widget.
    markDebug(this.el);
    container.appendChild(this.el);

    window.addEventListener('keydown', (e) => {
      if (e.key === '`') {
        this.visible = !this.visible;
        this.el.style.display = this.visible ? 'block' : 'none';
      }
    });
  }

  tickFrame() {
    const now = performance.now();
    const instantFps = 1000 / Math.max(1, now - this.lastFrameTime);
    this.lastFrameTime = now;
    this.fpsHistory.push(instantFps);
    if (this.fpsHistory.length > HISTOGRAM_LENGTH) this.fpsHistory.shift();

    this.frames++;
    if (now - this.lastFpsTime >= 500) {
      this.fps = Math.round((this.frames * 1000) / (now - this.lastFpsTime));
      this.frames = 0;
      this.lastFpsTime = now;
    }
  }

  private renderHistogram(): string {
    return this.fpsHistory
      .map((f) => {
        const frac = Math.min(1, Math.max(0, f / HISTOGRAM_FPS_CEILING));
        return HISTOGRAM_BLOCKS[Math.round(frac * (HISTOGRAM_BLOCKS.length - 1))];
      })
      .join('');
  }

  update(data: DiagnosticsData) {
    if (!this.visible) return;
    this.el.textContent =
      `fps: ${this.fps}  frame: ${this.fps > 0 ? (1000 / this.fps).toFixed(1) : '-'}ms` +
      `  cpu: ${data.cpuMs != null ? data.cpuMs.toFixed(1) + 'ms' : '-'}  steps/frame: ${data.stepsThisFrame ?? '-'}\n` +
      `draws: ${data.drawCalls ?? '-'}  tris: ${data.triangles != null ? (data.triangles / 1000).toFixed(0) + 'k' : '-'}` +
      `  quality: ${data.quality ?? '-'}\n` +
      `${this.renderHistogram()}\n` +
      `rtt: ${data.rttMs !== null ? data.rttMs.toFixed(0) + 'ms' : '-'}\n` +
      `input age: ${data.inputAgeMs !== null ? data.inputAgeMs.toFixed(0) + 'ms' : '-'}\n` +
      `seq: ${data.seq ?? '-'}\n` +
      `hands: ${data.handStatus ?? '-'}  detect: ${data.detectMs != null ? data.detectMs.toFixed(1) + 'ms' : '-'}` +
      `  ${data.detectHz != null ? data.detectHz.toFixed(0) : '-'}/${data.targetHz ?? '-'}Hz\n` +
      `L ${fmtHand(data.handLeft)}  R ${fmtHand(data.handRight)}\n` +
      `  r: fist<${GESTURE.fistBelow}=gas open>${GESTURE.openAbove}=brake` +
      `  t: thumb-up>${GESTURE.thumbUpEngage} release<${GESTURE.thumbUpRelease}\n` +
      `source: ${data.source}\n` +
      `race: ${data.raceState ?? '-'}\n` +
      `lap: ${data.lap ?? '-'}\n` +
      `nextCheckpoint: ${data.nextCheckpoint ?? '-'}`;
  }
}

// One hand's live ratios: openness r, thumb extension t, classified state.
function fmtHand(h: HandReading | null | undefined): string {
  if (!h) return 'r:- t:-';
  const f = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : '-');
  return `r:${f(h.r)} t:${f(h.thumb)} ${h.state}`;
}
