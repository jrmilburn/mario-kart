import type { ItemType } from '../items/ItemSystem';

const ITEM_ICONS: Record<ItemType, string> = { mushroom: '🍄', banana: '🍌', shell: '🐚' };

// Phase 2c: where one player's readouts live on screen. 'solo' fills the
// whole screen (pixel-identical to the pre-split-screen v1 layout); 'left'/
// 'right' confine the same absolutely-positioned children to their half via
// the root's own box (each child's `left`/`top` etc. is relative to it);
// 'hidden' is P2's state whenever it isn't racing.
export type PlayerHudLayout = 'solo' | 'left' | 'right' | 'hidden';

// Per-player race readouts (lap/position/speed, drift charge bar, held item)
// extracted from Hud.ts (Phase 2c) so each human player gets their own,
// positioned over their half of a split screen. Hud.ts keeps the chrome
// that's shared regardless of player count (QR/code, countdown, pause,
// lobby, results).
export class PlayerHud {
  private root: HTMLDivElement;
  private raceInfo: HTMLDivElement;
  private driftBar: HTMLDivElement;
  private driftFill: HTMLDivElement;
  private itemSlot: HTMLDivElement;

  constructor(container: HTMLElement) {
    this.root = document.createElement('div');
    container.appendChild(this.root);

    this.raceInfo = document.createElement('div');
    this.raceInfo.style.cssText =
      'position:absolute; top:12px; left:12px; font-size:22px; font-weight:700; ' +
      'text-shadow:0 2px 6px rgba(0,0,0,0.6); display:none;';
    this.root.appendChild(this.raceInfo);

    this.driftBar = document.createElement('div');
    this.driftBar.style.cssText =
      'position:absolute; left:50%; bottom:24px; transform:translateX(-50%); width:180px; height:12px; ' +
      'border-radius:6px; background:rgba(0,0,0,0.4); overflow:hidden; display:none;';
    this.driftFill = document.createElement('div');
    this.driftFill.style.cssText = 'height:100%; width:0%; background:#3498db; transition:background 0.1s;';
    this.driftBar.appendChild(this.driftFill);
    this.root.appendChild(this.driftBar);

    this.itemSlot = document.createElement('div');
    this.itemSlot.style.cssText =
      'position:absolute; top:52px; left:12px; width:56px; height:56px; border-radius:12px; ' +
      'background:rgba(0,0,0,0.4); border:2px solid rgba(255,255,255,0.4); display:none; ' +
      'align-items:center; justify-content:center; font-size:30px;';
    this.root.appendChild(this.itemSlot);

    this.setLayout('solo');
  }

  setLayout(layout: PlayerHudLayout) {
    const box =
      layout === 'solo'
        ? 'inset:0;'
        : layout === 'left'
          ? 'left:0; top:0; bottom:0; width:50%;'
          : layout === 'right'
            ? 'right:0; top:0; bottom:0; width:50%;'
            : '';
    this.root.style.cssText =
      `position:absolute; pointer-events:none; font-family:system-ui,sans-serif; color:#fff; ${box}` +
      (layout === 'hidden' ? ' display:none;' : ' display:block;');
  }

  setRaceInfo(lap: number, totalLaps: number, speedKmh: number, position: number, totalKarts: number) {
    this.raceInfo.style.display = 'block';
    this.raceInfo.textContent =
      `LAP ${Math.min(lap + 1, totalLaps)}/${totalLaps}   ` +
      `POS ${position}/${totalKarts}   ${Math.round(speedKmh)} km/h`;
  }

  hideRaceInfo() {
    this.raceInfo.style.display = 'none';
  }

  // tier: 0 (charging, below tier 1) .. 3. progress: 0..1 toward the max tier threshold.
  setDriftCharge(active: boolean, tier: number, progress: number) {
    this.driftBar.style.display = active ? 'block' : 'none';
    if (!active) return;
    const colors = ['#7f8c8d', '#3498db', '#e67e22', '#9b59b6']; // gray, blue, orange, purple
    this.driftFill.style.background = colors[Math.min(tier, colors.length - 1)];
    this.driftFill.style.width = `${Math.round(Math.min(Math.max(progress, 0), 1) * 100)}%`;
  }

  // display: the item to show (flickers during roulette, locks once held.item is set).
  setHeldItem(display: ItemType | null) {
    if (!display) {
      this.itemSlot.style.display = 'none';
      return;
    }
    this.itemSlot.style.display = 'flex';
    this.itemSlot.textContent = ITEM_ICONS[display];
  }
}
