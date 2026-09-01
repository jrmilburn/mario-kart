export interface DiagnosticsData {
  rttMs: number | null;
  inputAgeMs: number | null;
  seq: number | null;
  source: string;
  raceState?: string;
  lap?: number;
  nextCheckpoint?: number;
  stepsThisFrame?: number;
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
      'position:absolute; bottom:12px; left:12px; background:rgba(0,0,0,0.65); color:#0f0; ' +
      'font:12px/1.5 monospace; padding:8px 10px; border-radius:4px; white-space:pre; display:none; pointer-events:none;';
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
      `fps: ${this.fps}  steps/frame: ${data.stepsThisFrame ?? '-'}\n` +
      `${this.renderHistogram()}\n` +
      `rtt: ${data.rttMs !== null ? data.rttMs.toFixed(0) + 'ms' : '-'}\n` +
      `input age: ${data.inputAgeMs !== null ? data.inputAgeMs.toFixed(0) + 'ms' : '-'}\n` +
      `seq: ${data.seq ?? '-'}\n` +
      `source: ${data.source}\n` +
      `race: ${data.raceState ?? '-'}\n` +
      `lap: ${data.lap ?? '-'}\n` +
      `nextCheckpoint: ${data.nextCheckpoint ?? '-'}`;
  }
}
