import * as THREE from 'three';
import type { TrackSample } from '../track/TrackBuilder';

const CANVAS_SIZE = 160;
const PADDING = 14;

export interface MinimapKart {
  pos: THREE.Vector3;
  color: string;
  isPlayer: boolean;
}

// 2D canvas polyline of the centerline + colored kart dots, top-right (§Phase 11c).
// §v5: the shortcut is drawn too, as a thinner dashed dirt-coloured line.
export class Minimap {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  private trackPoints: Array<{ x: number; z: number }>;
  private shortcutPoints: Array<{ x: number; z: number }>;

  constructor(container: HTMLElement, samples: TrackSample[], shortcut: readonly { pos: THREE.Vector3 }[] = []) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = CANVAS_SIZE;
    this.canvas.height = CANVAS_SIZE;
    this.canvas.style.cssText =
      'position:absolute; top:52px; right:12px; background:rgba(0,0,0,0.45); border-radius:10px;';
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;

    this.trackPoints = samples.map((s) => ({ x: s.pos.x, z: s.pos.z }));
    this.shortcutPoints = shortcut.map((s) => ({ x: s.pos.x, z: s.pos.z }));
    const all = [...this.trackPoints, ...this.shortcutPoints];
    const xs = all.map((p) => p.x);
    const zs = all.map((p) => p.z);
    this.bounds = { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
  }

  private project(x: number, z: number): { x: number; y: number } {
    const w = CANVAS_SIZE - PADDING * 2;
    const h = CANVAS_SIZE - PADDING * 2;
    const spanX = this.bounds.maxX - this.bounds.minX || 1;
    const spanZ = this.bounds.maxZ - this.bounds.minZ || 1;
    const fx = (x - this.bounds.minX) / spanX;
    const fz = (z - this.bounds.minZ) / spanZ;
    return { x: PADDING + fx * w, y: PADDING + fz * h };
  }

  update(karts: MinimapKart[]) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

    ctx.strokeStyle = 'rgba(255,255,255,0.65)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    this.trackPoints.forEach((p, i) => {
      const { x, y } = this.project(p.x, p.z);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.stroke();

    if (this.shortcutPoints.length > 1) {
      ctx.strokeStyle = 'rgba(214,168,110,0.9)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      this.shortcutPoints.forEach((p, i) => {
        const { x, y } = this.project(p.x, p.z);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.setLineDash([]);
    }

    for (const kart of karts) {
      const { x, y } = this.project(kart.pos.x, kart.pos.z);
      ctx.fillStyle = kart.color;
      ctx.beginPath();
      ctx.arc(x, y, kart.isPlayer ? 5 : 3.5, 0, Math.PI * 2);
      ctx.fill();
      if (kart.isPlayer) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
  }
}
