import type { ItemType } from '../items/ItemSystem';

const ITEM_ICONS: Record<ItemType, string> = { mushroom: '🍄', banana: '🍌', shell: '🐚' };
// §v3 Track C1: the "ready" ring is drawn in the item's own colour, so the
// slot answers "what have I got?" from peripheral vision without reading the
// icon. Matched to ItemVisuals' in-world sprites so the HUD and the floating
// marker over the kart are unmistakably the same object.
const ITEM_COLORS: Record<ItemType, string> = {
  mushroom: '#e74c3c',
  banana: '#f5d327',
  shell: '#2ecc71',
};

const ITEM_SLOT_SIZE = 76; // §v3 Track C1: up from 56px — half-screen split viewports made the old slot easy to miss

// Phase 2c: where one player's readouts live on screen. 'solo' fills the
// whole screen (pixel-identical to the pre-split-screen v1 layout); 'left'/
// 'right' confine the same absolutely-positioned children to their half via
// the root's own box (each child's `left`/`top` etc. is relative to it);
// 'hidden' is P2's state whenever it isn't racing.
export type PlayerHudLayout = 'solo' | 'left' | 'right' | 'hidden';

// §v3 Track C1: the three item-slot states are animated (spinning ring while
// the roulette runs, a pop the instant the item locks in, a slow idle pulse
// while held), and CSS keyframes cannot be expressed as inline styles. The HUD
// has no stylesheet — it is 100% inline styles today — so rather than
// introduce a CSS file and a build-time import for three keyframe blocks, one
// <style> element is injected once, on first PlayerHud construction, and
// shared by both players' HUDs. Everything else stays inline as before.
const HUD_STYLE_ELEMENT_ID = 'kart-player-hud-styles';

function ensureHudStyles() {
  if (document.getElementById(HUD_STYLE_ELEMENT_ID)) return;
  const style = document.createElement('style');
  style.id = HUD_STYLE_ELEMENT_ID;
  style.textContent = `
@keyframes kartSlotSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@keyframes kartSlotPop { 0% { transform: scale(1); } 45% { transform: scale(1.32); } 100% { transform: scale(1); } }
@keyframes kartSlotIdle { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.06); } }
@keyframes kartSlotFlicker { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
`;
  document.head.appendChild(style);
}

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
  private itemRing: HTMLDivElement;
  private itemIcon: HTMLDivElement;
  // §v3 Track C1: which of the three slot looks is currently applied
  // ('empty' | 'rolling' | 'ready:<item>'). setItemState is called every render
  // frame, so the ring/slot styles are only touched when this actually
  // changes. That is not merely a perf guard: rewriting an element's
  // `animation` property restarts its keyframes, so doing it 60 times a second
  // would mean the pop, the idle pulse and the roulette ring spin never play.
  private itemPhase = '';
  // Tracked separately from itemStateKey so that hiding the slot in the lobby
  // and then showing it again in the countdown doesn't need a fake key value
  // (which would force a full restyle every lobby frame just to be hidden again).
  private itemSlotHidden = true;

  constructor(container: HTMLElement) {
    ensureHudStyles();

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

    // The slot is now a container with two children rather than one styled
    // box: the RING carries the state colour and the spin animation, the SLOT
    // itself carries the pop/idle scale animations, and the ICON carries the
    // roulette flicker. Keeping them on separate elements is what lets the
    // ring spin while the slot pulses without the two transforms fighting.
    this.itemSlot = document.createElement('div');
    this.itemSlot.style.cssText =
      `position:absolute; top:52px; left:12px; width:${ITEM_SLOT_SIZE}px; height:${ITEM_SLOT_SIZE}px; ` +
      'display:none; align-items:center; justify-content:center;';
    this.itemRing = document.createElement('div');
    this.itemRing.style.cssText = 'position:absolute; inset:0; border-radius:18px; box-sizing:border-box;';
    this.itemIcon = document.createElement('div');
    this.itemIcon.style.cssText =
      'position:relative; font-size:38px; line-height:1; text-shadow:0 2px 6px rgba(0,0,0,0.7);';
    this.itemSlot.append(this.itemRing, this.itemIcon);
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

  // Called only in LOBBY (main.ts). §v3 Track C1: this hides the item slot too.
  // The empty slot is a deliberately *visible* state everywhere else — it is
  // half the answer to "do I have an item?" — but in the lobby it would float
  // alone over the QR/room-code panel with no race context around it.
  hideRaceInfo() {
    this.raceInfo.style.display = 'none';
    this.itemSlot.style.display = 'none';
    this.itemSlotHidden = true;
  }

  // tier: 0 (charging, below tier 1) .. 3. progress: 0..1 toward the max tier threshold.
  setDriftCharge(active: boolean, tier: number, progress: number) {
    this.driftBar.style.display = active ? 'block' : 'none';
    if (!active) return;
    const colors = ['#7f8c8d', '#3498db', '#e67e22', '#9b59b6']; // gray, blue, orange, purple
    this.driftFill.style.background = colors[Math.min(tier, colors.length - 1)];
    this.driftFill.style.width = `${Math.round(Math.min(Math.max(progress, 0), 1) * 100)}%`;
  }

  // §v3 Track C1: replaces setHeldItem(display). Three visually distinct states:
  //   empty   (item === null, rolling === false) — dashed faint outline, no icon
  //   rolling (rolling === true)                 — `item` is the flickering
  //                                                roulette display; ring spins
  //   ready   (item !== null, rolling === false) — saturated ring in the item's
  //                                                colour + glow, a one-shot pop
  //                                                as it locks in, then a slow
  //                                                idle pulse while held
  // The caller passes the already-resolved display item so this stays a pure
  // view (main.ts owns the rouletteTimer > 0 ? rouletteDisplay : item choice).
  setItemState(state: { item: ItemType | null; rolling: boolean }) {
    if (this.itemSlotHidden) {
      this.itemSlotHidden = false;
      this.itemSlot.style.display = 'flex';
    }

    // The ICON is updated outside the phase guard below, because it is the one
    // thing that legitimately changes ~10x a second (the roulette shuffle).
    // The ring/slot styling is NOT: re-declaring the ring's `animation`
    // property on every roulette tick would restart its spin keyframes from
    // 0deg each time and the ring would never visibly turn at all.
    const icon = state.item ? ITEM_ICONS[state.item] : '';
    if (this.itemIcon.textContent !== icon) this.itemIcon.textContent = icon;

    const phase = state.rolling ? 'rolling' : state.item ? `ready:${state.item}` : 'empty';
    if (phase === this.itemPhase) return;
    const wasReady = this.itemPhase.startsWith('ready:');
    this.itemPhase = phase;

    if (state.rolling) {
      this.itemSlot.style.animation = 'none';
      this.itemIcon.style.animation = 'kartSlotFlicker 0.2s linear infinite';
      // A bright top border on an otherwise faint ring, spun — reads as a
      // loading spinner, i.e. "something is coming", which is exactly the
      // roulette's meaning.
      this.itemRing.style.cssText =
        'position:absolute; inset:0; border-radius:18px; box-sizing:border-box; ' +
        'background:rgba(0,0,0,0.45); border:3px solid rgba(255,255,255,0.18); ' +
        'border-top-color:#ffffff; animation:kartSlotSpin 0.55s linear infinite;';
      return;
    }

    if (!state.item) {
      this.itemSlot.style.animation = 'none';
      this.itemIcon.style.animation = 'none';
      this.itemRing.style.cssText =
        'position:absolute; inset:0; border-radius:18px; box-sizing:border-box; ' +
        'background:rgba(0,0,0,0.22); border:2px dashed rgba(255,255,255,0.3);';
      return;
    }

    const color = ITEM_COLORS[state.item];
    this.itemIcon.style.animation = 'none';
    this.itemRing.style.cssText =
      'position:absolute; inset:0; border-radius:18px; box-sizing:border-box; ' +
      `background:rgba(0,0,0,0.42); border:3px solid ${color}; ` +
      `box-shadow:0 0 18px ${color}, inset 0 0 12px rgba(255,255,255,0.18);`;
    // The pop only fires on the *transition into* ready, never on a re-render
    // that happens to still be ready (which can't reach here anyway thanks to
    // the key guard, but `wasReady` also keeps a mushroom -> shell swap from
    // re-popping the slot if the item ever changed without passing through
    // empty). Afterwards the idle pulse takes over — the delay keeps the two
    // transform animations from overlapping.
    this.itemSlot.style.animation = wasReady
      ? 'kartSlotIdle 1.9s ease-in-out infinite'
      : 'kartSlotPop 0.34s ease-out, kartSlotIdle 1.9s ease-in-out 0.34s infinite';
  }
}
