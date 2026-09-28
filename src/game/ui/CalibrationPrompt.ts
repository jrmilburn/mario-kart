import type { Calibration } from '../hands/Calibration';

const ACCENT = '#FFD23F';
const RING_R = 44;
const RING_C = 2 * Math.PI * RING_R;

// §v5: the "hold your hands level" ring shown while a Calibration is running.
// Deliberately NOT debug UI — H leaves it up, since it's an instruction the
// player has to follow. Pure view: all state lives in Calibration.
export class CalibrationPrompt {
  private root: HTMLDivElement;
  private arc: SVGCircleElement;
  private title: HTMLDivElement;
  private visible = false;
  private lastTitle = '';

  constructor(container: HTMLElement, private calibration: Calibration) {
    this.root = document.createElement('div');
    this.root.style.cssText =
      'position:absolute; left:50%; top:22%; transform:translateX(-50%); z-index:6; pointer-events:none; ' +
      'display:none; flex-direction:column; align-items:center; gap:10px; padding:18px 26px; border-radius:20px; ' +
      'background:rgba(0,0,0,0.55); color:#fff; font-family:system-ui,sans-serif; text-align:center;';
    container.appendChild(this.root);

    const svgNs = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('width', '96');
    svg.setAttribute('height', '96');
    const track = document.createElementNS(svgNs, 'circle');
    track.setAttribute('cx', '50');
    track.setAttribute('cy', '50');
    track.setAttribute('r', String(RING_R));
    track.setAttribute('fill', 'none');
    track.setAttribute('stroke', 'rgba(255,255,255,0.2)');
    track.setAttribute('stroke-width', '8');
    this.arc = document.createElementNS(svgNs, 'circle');
    this.arc.setAttribute('cx', '50');
    this.arc.setAttribute('cy', '50');
    this.arc.setAttribute('r', String(RING_R));
    this.arc.setAttribute('fill', 'none');
    this.arc.setAttribute('stroke', ACCENT);
    this.arc.setAttribute('stroke-width', '8');
    this.arc.setAttribute('stroke-linecap', 'round');
    this.arc.setAttribute('stroke-dasharray', String(RING_C));
    this.arc.setAttribute('transform', 'rotate(-90 50 50)');
    // A level bar in the middle of the ring — the pose being asked for.
    const bar = document.createElementNS(svgNs, 'rect');
    bar.setAttribute('x', '26');
    bar.setAttribute('y', '47');
    bar.setAttribute('width', '48');
    bar.setAttribute('height', '6');
    bar.setAttribute('rx', '3');
    bar.setAttribute('fill', '#fff');
    svg.append(track, this.arc, bar);
    this.root.appendChild(svg);

    this.title = document.createElement('div');
    this.title.style.cssText = 'font-size:22px; font-weight:800;';
    this.root.appendChild(this.title);

    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:13px; opacity:0.7;';
    hint.textContent = 'Hold the wheel with both fists · C to recalibrate';
    this.root.appendChild(hint);

    // The whole hand mapping, since this is the one screen every hands player sees.
    const controls = document.createElement('div');
    controls.style.cssText = 'font-size:13px; font-weight:700; opacity:0.9;';
    controls.textContent = 'Fists = gas · open hands = brake · thumbs up = boost';
    this.root.appendChild(controls);
  }

  update() {
    const show = this.calibration.running;
    if (show !== this.visible) {
      this.visible = show;
      this.root.style.display = show ? 'flex' : 'none';
    }
    if (!show) return;
    this.arc.setAttribute('stroke-dashoffset', String(RING_C * (1 - this.calibration.progress)));
    const title = this.calibration.waitingForHands ? 'Show both fists' : 'Hold your fists level';
    if (title !== this.lastTitle) {
      this.lastTitle = title;
      this.title.textContent = title;
    }
  }
}
