export interface DiagnosticsData {
  rttMs: number | null;
  inputAgeMs: number | null;
  seq: number | null;
  source: string;
  raceState?: string;
  lap?: number;
  nextCheckpoint?: number;
}

// Backtick-toggle overlay: fps, RTT, input age, seq (§Phase 1).
export class Diagnostics {
  private el: HTMLDivElement;
  private visible = false;
  private frames = 0;
  private lastFpsTime = performance.now();
  private fps = 0;

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
    this.frames++;
    const now = performance.now();
    if (now - this.lastFpsTime >= 500) {
      this.fps = Math.round((this.frames * 1000) / (now - this.lastFpsTime));
      this.frames = 0;
      this.lastFpsTime = now;
    }
  }

  update(data: DiagnosticsData) {
    if (!this.visible) return;
    this.el.textContent =
      `fps: ${this.fps}\n` +
      `rtt: ${data.rttMs !== null ? data.rttMs.toFixed(0) + 'ms' : '-'}\n` +
      `input age: ${data.inputAgeMs !== null ? data.inputAgeMs.toFixed(0) + 'ms' : '-'}\n` +
      `seq: ${data.seq ?? '-'}\n` +
      `source: ${data.source}\n` +
      `race: ${data.raceState ?? '-'}\n` +
      `lap: ${data.lap ?? '-'}\n` +
      `nextCheckpoint: ${data.nextCheckpoint ?? '-'}`;
  }
}
