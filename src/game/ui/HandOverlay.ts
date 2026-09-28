import type { DetectionSummary, RawHand } from '../hands/gestures';
import type { HandTracker } from '../hands/HandTracker';
import type { HandProvider } from '../input/HandProvider';
import type { InputSource } from '../input/InputSource';
import { markDebug } from './DebugToggle';

const ACCENT = '#FFD23F';
// §defect-fix (item 12): ~1.6x the old fixed 220px, as a responsive clamp so
// it scales with the viewport instead of a flat pixel value. Height still
// tracks the actual video aspect ratio (4:3 fallback until metadata loads —
// see the `preview` element below), unchanged. In split screen this lives
// entirely inside P1's left half; setSplitScreen() caps it to ~40% of that
// half (i.e. 20% of the full window) so it can never cross into P2's side.
const PREVIEW_WIDTH_CSS = 'clamp(300px, 24vw, 440px)';
const PREVIEW_BASE_WIDTH = 220; // the old fixed width — skeleton stroke/joint scale is relative to this
const SPLIT_MAX_WIDTH_CSS = '20vw'; // 40% of a 50vw half

// MediaPipe's 21-point hand topology (same pairs as HandLandmarker.HAND_CONNECTIONS,
// inlined so this module doesn't need the tasks-vision bundle loaded to draw).
const HAND_CONNECTIONS: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [0, 17], [17, 18], [18, 19], [19, 20],
];

// ~1.6x the old 34px icon, matching the enlarged preview.
const WHEEL_SVG =
  `<svg viewBox="-20 -20 40 40" width="54" height="54" aria-hidden="true">` +
  `<circle r="16" fill="none" stroke="${ACCENT}" stroke-width="4"/>` +
  `<circle r="4" fill="${ACCENT}"/>` +
  `<path d="M-15 0 H-4 M4 0 H15 M0 4 V15" stroke="${ACCENT}" stroke-width="3.5" stroke-linecap="round"/>` +
  `<circle cy="-16" r="2.6" fill="#fff"/>` +
  `</svg>`;

function pill(label: string): HTMLDivElement {
  const el = document.createElement('div');
  el.textContent = label;
  el.style.cssText =
    'padding:4px 11px; border-radius:999px; font-size:16px; font-weight:800; letter-spacing:0.5px; ' +
    'background:rgba(255,255,255,0.12); color:rgba(255,255,255,0.45);';
  return el;
}

// §v5 debug overlay for P1's hands: mirrored webcam preview with the detected
// skeleton, a wheel icon turning with the *smoothed* steer (what the kart
// actually receives), a GAS/BRAKE/BOOST readout of what the hands are
// sending (fists = GAS, open hands = BRAKE, thumbs-up flick = BOOST), a
// one-line legend for that mapping, and which source is driving.
// Bottom-left, responsively sized (PREVIEW_WIDTH_CSS, capped in split screen
// by setSplitScreen()); hidden with everything else by H (DebugToggle), but
// only faded — see DebugToggle for why the <video> must stay composited.
export class HandOverlay {
  private root: HTMLDivElement;
  private preview: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private wheel: HTMLDivElement;
  private gasPill: HTMLDivElement;
  private brakePill: HTMLDivElement;
  private boostPill: HTMLDivElement;
  private statusEl: HTMLDivElement;
  private messageEl: HTMLDivElement;
  private legendEl: HTMLDivElement;
  private boostFlashUntil = 0;
  private lastSeenBoostFiredAt = -Infinity;
  private lastKey = '';
  private lastSplit: boolean | null = null;

  constructor(
    container: HTMLElement,
    private tracker: HandTracker,
    private hands: HandProvider,
    private input: InputSource,
  ) {
    this.root = document.createElement('div');
    this.root.style.cssText =
      `position:absolute; left:12px; bottom:12px; width:${PREVIEW_WIDTH_CSS}; z-index:5; pointer-events:none; ` +
      'font-family:system-ui,sans-serif; color:#fff; display:flex; flex-direction:column; gap:8px;';
    markDebug(this.root, 'fade');
    container.appendChild(this.root);

    this.preview = document.createElement('div');
    this.preview.style.cssText =
      'position:relative; width:100%; aspect-ratio:4 / 3; border-radius:14px; overflow:hidden; ' +
      'background:#111; box-shadow:0 4px 14px rgba(0,0,0,0.45); display:none;';
    this.root.appendChild(this.preview);

    const video = tracker.video;
    // Mirrored so the preview behaves like a mirror: raise your right hand,
    // the right-hand side of the preview moves.
    video.style.cssText = 'position:absolute; inset:0; width:100%; height:100%; object-fit:cover; transform:scaleX(-1);';
    this.preview.appendChild(video);
    video.addEventListener('loadedmetadata', () => {
      if (video.videoWidth && video.videoHeight) {
        this.preview.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
      }
    });

    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'position:absolute; inset:0; width:100%; height:100%;';
    this.preview.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');

    const bar = document.createElement('div');
    bar.style.cssText =
      'display:flex; flex-wrap:wrap; align-items:center; gap:8px 10px; padding:9px 12px; border-radius:14px; background:rgba(0,0,0,0.55);';
    this.root.appendChild(bar);

    this.wheel = document.createElement('div');
    this.wheel.style.cssText = 'width:54px; height:54px; flex:0 0 auto; will-change:transform;';
    this.wheel.innerHTML = WHEEL_SVG;
    bar.appendChild(this.wheel);

    const pills = document.createElement('div');
    pills.style.cssText = 'display:flex; gap:6px; flex:1 1 auto;';
    this.gasPill = pill('GAS');
    this.brakePill = pill('BRAKE');
    this.boostPill = pill('BOOST');
    pills.append(this.gasPill, this.brakePill, this.boostPill);
    bar.appendChild(pills);

    this.statusEl = document.createElement('div');
    // Wraps under the pills rather than overflowing the bar at the narrow split-screen width.
    this.statusEl.style.cssText = 'font-size:17px; font-weight:800; letter-spacing:1px; margin-left:auto;';
    bar.appendChild(this.statusEl);

    this.legendEl = document.createElement('div');
    this.legendEl.style.cssText =
      'font-size:16px; font-weight:700; letter-spacing:0.3px; padding:0 8px; color:rgba(255,255,255,0.75); ' +
      'text-shadow:0 1px 2px rgba(0,0,0,0.8); display:none;';
    this.legendEl.textContent = 'Fists = gas · open = brake · thumb up = boost';
    this.root.appendChild(this.legendEl);

    this.messageEl = document.createElement('div');
    this.messageEl.style.cssText =
      'font-size:19px; font-weight:600; padding:9px 15px; border-radius:12px; background:rgba(0,0,0,0.65); display:none;';
    this.root.appendChild(this.messageEl);

    hands.onDetection((d) => this.drawSkeleton(d));
  }

  // Detection rate: the skeleton only changes when a new result arrives.
  private drawSkeleton(d: DetectionSummary) {
    const ctx = this.ctx;
    if (!ctx) return;
    const rect = this.preview.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    ctx.clearRect(0, 0, w, h);
    // §defect-fix (item 12): the preview is now responsively sized (up to
    // ~1.6x its old fixed 220px) rather than fixed — scale stroke/joint
    // thickness with it (relative to that old baseline) so the skeleton
    // doesn't look thin and lost on the enlarged preview, capped so it can't
    // get comically thick on the wide end of the clamp either.
    const sizeScale = Math.min(1.8, Math.max(1, rect.width / PREVIEW_BASE_WIDTH));
    const draw = (hand: RawHand | null, alpha: number) => {
      if (!hand) return;
      // Mirrored x' = 1 - x to line up with the CSS-mirrored video underneath.
      const px = (i: number) => (1 - hand.landmarks[i].x) * w;
      const py = (i: number) => hand.landmarks[i].y * h;
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 2.2 * dpr * sizeScale;
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (const [a, b] of HAND_CONNECTIONS) {
        ctx.moveTo(px(a), py(a));
        ctx.lineTo(px(b), py(b));
      }
      ctx.stroke();
      ctx.fillStyle = '#fff';
      for (let i = 0; i < 21; i++) {
        ctx.beginPath();
        ctx.arc(px(i), py(i), 2.4 * dpr * sizeScale, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };
    draw(d.hands.left, 1);
    draw(d.hands.right, 1);
    if (d.hands.left && d.hands.right) {
      // The "wheel axle" between the wrists — the line whose tilt is the steer.
      ctx.strokeStyle = 'rgba(255,210,63,0.55)';
      ctx.lineWidth = 1.5 * dpr * sizeScale;
      ctx.setLineDash([5 * dpr, 5 * dpr]);
      ctx.beginPath();
      ctx.moveTo((1 - d.hands.left.landmarks[0].x) * w, d.hands.left.landmarks[0].y * h);
      ctx.lineTo((1 - d.hands.right.landmarks[0].x) * w, d.hands.right.landmarks[0].y * h);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // Call whenever the split-screen layout flips (versus's roster/layout
  // recompute in main.ts). In split screen this overlay lives entirely
  // inside P1's left half — cap its width to ~40% of that half (20% of the
  // full window, since the half is 50%) so it can never grow into P2's side.
  setSplitScreen(active: boolean) {
    if (active === this.lastSplit) return;
    this.lastSplit = active;
    this.root.style.maxWidth = active ? SPLIT_MAX_WIDTH_CSS : 'none';
  }

  // Once per render frame.
  update(now: number) {
    const live = this.tracker.live;
    const kind = this.input.activeKind(now);
    const c = this.hands.filter.lastControl;
    // §defect-fix: latch off HandGestureFilter's boostFiredAt timestamp
    // (updated every time a boost actually fires, whenever that physics
    // sample happened) rather than `c.boost` (true for exactly one sample) —
    // a frame that runs 2+ physics steps could otherwise poll lastControl
    // right after a later, boost-less sample overwrote it and miss the flick.
    const firedAt = this.hands.filter.boostFiredAt;
    if (firedAt > this.lastSeenBoostFiredAt) {
      this.lastSeenBoostFiredAt = firedAt;
      this.boostFlashUntil = firedAt + 250;
    }
    const boostLit = now < this.boostFlashUntil;

    this.wheel.style.transform = `rotate(${(this.hands.filter.sf * 90).toFixed(1)}deg)`;

    // Everything else only changes on discrete events; skip the style writes
    // unless something actually flipped.
    const key = `${live}|${kind}|${c.throttle}|${c.brake}|${boostLit}|${this.tracker.status}|${this.tracker.message}`;
    if (key === this.lastKey) return;
    this.lastKey = key;

    this.preview.style.display = live ? 'block' : 'none';
    this.wheel.style.opacity = live ? '1' : '0.35';
    this.legendEl.style.display = live ? 'block' : 'none';
    setPill(this.gasPill, live && c.throttle === 1, '#27ae60');
    setPill(this.brakePill, live && c.brake === 1, '#c0392b');
    setPill(this.boostPill, live && boostLit, '#f39c12');
    this.statusEl.textContent = kind === 'hands' ? 'HANDS' : 'KEYBOARD';
    this.statusEl.style.color = kind === 'hands' ? ACCENT : '#9fb3c8';

    const showMessage = !live && this.tracker.message !== '';
    this.messageEl.style.display = showMessage ? 'block' : 'none';
    this.messageEl.textContent = this.tracker.message;
  }
}

function setPill(el: HTMLDivElement, on: boolean, color: string) {
  el.style.background = on ? color : 'rgba(255,255,255,0.12)';
  el.style.color = on ? '#fff' : 'rgba(255,255,255,0.45)';
}
