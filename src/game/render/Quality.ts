import * as THREE from 'three';
import { TUNING } from '../tuning';
import { setOutlinesEnabled } from './Outline';
import type { PostFX } from './PostFX';
import { markDebug } from '../ui/DebugToggle';
import { THEME } from '../ui/theme';

// §v5 Rendering: the Q quality toggle (brief: "Q toggles quality High/Low").
//   High: bloom (PostFX), inverted-hull outlines, 2048 shadow map,
//         devicePixelRatio capped at 2 solo / TUNING.splitPixelRatioCap split.
//   Low:  no bloom (straight-to-canvas render, no HDR target), no outlines,
//         1024 shadow map, devicePixelRatio 1.
// Persisted per browser in localStorage (wrapped: private windows and blocked
// storage throw, and the game must still start). Defaults to High.
//
// Everything here is O(1) state flips except the shadow map, whose render
// target has to be dropped and re-made at the new size on the next shadow
// pass — a one-frame cost, taken on a keypress, never mid-frame.

export type QualityLevel = 'high' | 'low';

const STORAGE_KEY = 'kart.quality';
const TOAST_MS = 1300;

function readStored(): QualityLevel {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'low' ? 'low' : 'high';
  } catch {
    return 'high';
  }
}

function writeStored(level: QualityLevel) {
  try {
    localStorage.setItem(STORAGE_KEY, level);
  } catch {
    // Storage unavailable: the choice just lasts for this session.
  }
}

export class Quality {
  level: QualityLevel = readStored();
  private toast: HTMLDivElement;
  private toastTimer: number | null = null;

  constructor(
    container: HTMLElement,
    private readonly postFX: PostFX,
    private readonly light: THREE.DirectionalLight,
    // Re-applies renderer sizing (the DPR cap depends on the level) and
    // everything sized off the drawing buffer.
    private readonly onResize: () => void,
  ) {
    this.toast = document.createElement('div');
    this.toast.style.cssText =
      'position:absolute; top:14px; left:50%; transform:translateX(-50%); z-index:30; pointer-events:none; ' +
      `padding:6px 14px; border-radius:999px; background:rgba(11,36,48,0.72); color:${THEME.sand}; ` +
      `font:600 14px/1.2 ${THEME.fontLabel}; letter-spacing:0.02em; opacity:0; transition:opacity 0.2s;`;
    markDebug(this.toast); // H hides it with the rest of the debug UI
    container.appendChild(this.toast);

    // §defect-fix: without HDR render-target support, High quality's bloom
    // target rasterizes to solid black instead of throwing — there's nothing
    // to catch, so the check has to happen up front. This overrides the
    // stored preference in memory only (not persisted): it's a hardware
    // constraint, not a choice, and shouldn't stick once the tab is on a
    // capable GPU/browser again.
    if (!this.postFX.supportsHDR) this.level = 'low';

    window.addEventListener('keydown', (e) => {
      if (e.code !== 'KeyQ' || e.repeat) return;
      if (!this.postFX.supportsHDR) return; // Low is the only option this GPU/browser can render
      this.set(this.level === 'high' ? 'low' : 'high');
      this.showToast();
    });
    this.apply();
  }

  get high(): boolean {
    return this.level === 'high';
  }

  pixelRatioCap(split: boolean): number {
    if (!this.high) return 1;
    return split ? TUNING.splitPixelRatioCap : 2;
  }

  set(level: QualityLevel) {
    if (level === this.level) return;
    this.level = level;
    writeStored(level);
    this.apply();
    this.onResize();
  }

  private apply() {
    const high = this.high;
    this.postFX.enabled = high;
    setOutlinesEnabled(high);
    const size = high ? TUNING.shadowMapSize : 1024;
    const shadow = this.light.shadow;
    if (shadow.mapSize.x !== size) {
      shadow.mapSize.set(size, size);
      if (shadow.map) {
        shadow.map.dispose();
        shadow.map = null; // re-created at mapSize by the next shadow pass
      }
    }
  }

  private showToast() {
    this.toast.textContent = `Quality: ${this.high ? 'High' : 'Low'}`;
    this.toast.style.opacity = '1';
    if (this.toastTimer !== null) window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      this.toast.style.opacity = '0';
      this.toastTimer = null;
    }, TOAST_MS);
  }
}
