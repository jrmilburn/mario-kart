import { clamp } from '../shared/mathUtils';

// Horizontal slider zone -> steer in [-1, 1]. Springs back to 0 on release.
export class TouchSteering {
  private value = 0;
  private el: HTMLDivElement;
  private handle: HTMLDivElement;
  private dragging = false;

  constructor(container: HTMLElement) {
    this.el = document.createElement('div');
    this.el.style.cssText =
      'position:relative; width:100%; height:64px; background:rgba(255,255,255,0.1); ' +
      'border-radius:32px; touch-action:none;';
    container.appendChild(this.el);

    this.handle = document.createElement('div');
    this.handle.style.cssText =
      'position:absolute; top:4px; left:calc(50% - 28px); width:56px; height:56px; ' +
      'border-radius:50%; background:#fff; box-shadow:0 2px 6px rgba(0,0,0,0.4);';
    this.el.appendChild(this.handle);

    this.el.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.el.setPointerCapture(e.pointerId);
      this.updateFromEvent(e);
    });
    this.el.addEventListener('pointermove', (e) => {
      if (this.dragging) this.updateFromEvent(e);
    });
    const release = () => {
      this.dragging = false;
      this.value = 0;
      this.renderHandle();
    };
    this.el.addEventListener('pointerup', release);
    this.el.addEventListener('pointercancel', release);
  }

  private updateFromEvent(e: PointerEvent) {
    const rect = this.el.getBoundingClientRect();
    const half = rect.width / 2;
    const centerX = rect.left + half;
    this.value = clamp((e.clientX - centerX) / half, -1, 1);
    this.renderHandle();
  }

  private renderHandle() {
    const rect = this.el.getBoundingClientRect();
    const travel = rect.width / 2 - 28;
    this.handle.style.left = `calc(50% - 28px + ${this.value * travel}px)`;
  }

  get steer(): number {
    return this.value;
  }
}
