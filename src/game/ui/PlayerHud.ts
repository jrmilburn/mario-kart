import type { PlayerSlot } from '../../shared/protocol';
import type { ControlSourceKind } from '../input/ControlProvider';
import { THEME, playerColor } from './theme';

// Phase 2c: where one player's readouts live on screen. 'solo' fills the
// whole screen; 'left'/'right' confine the same absolutely-positioned
// children to their half via the root's own box; 'hidden' is P2's state
// whenever it isn't racing.
export type PlayerHudLayout = 'solo' | 'left' | 'right' | 'hidden';

const HUD_STYLE_ELEMENT_ID = 'kart-player-hud-styles';

function ensureHudStyles() {
  if (document.getElementById(HUD_STYLE_ELEMENT_ID)) return;
  const style = document.createElement('style');
  style.id = HUD_STYLE_ELEMENT_ID;
  style.textContent = `
@keyframes kartNoticePop { 0% { transform: translateX(-50%) scale(0.85); opacity: 0; } 100% { transform: translateX(-50%) scale(1); opacity: 1; } }
`;
  document.head.appendChild(style);
}

function ordinal(n: number): string {
  const suffixes = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${suffixes[(v - 20) % 10] ?? suffixes[v] ?? suffixes[0]}`;
}

// §stage2 restyle: rounded chunky playful HUD (Lilita One / Fredoka, the
// brief's palette). Item slot UI is gone entirely — the game has no items
// (§v5). Drift bar stays, restyled. New: a per-player input-kind chip
// (HANDS/PHONE/KEYBOARD) coloured by the player's own colour, and a small
// dismissable notice banner for "Phone disconnected"/"Phone unavailable".
export class PlayerHud {
  private root: HTMLDivElement;
  private inputChip: HTMLDivElement;
  private posEl: HTMLDivElement;
  private lapEl: HTMLDivElement;
  private speedEl: HTMLDivElement;
  private driftBar: HTMLDivElement;
  private driftFill: HTMLDivElement;
  private noticeEl: HTMLDivElement;
  private noticeTimer: number | null = null;
  private readonly color: string;

  constructor(container: HTMLElement, private slot: PlayerSlot) {
    ensureHudStyles();
    this.color = playerColor(slot);

    this.root = document.createElement('div');
    container.appendChild(this.root);

    // Input-kind chip: top corner of this player's half (or top-left solo).
    this.inputChip = document.createElement('div');
    this.inputChip.style.cssText =
      `position:absolute; top:14px; left:14px; font-family:${THEME.fontLabel}; font-size:13px; font-weight:700; ` +
      'letter-spacing:1px; padding:6px 14px; border-radius:999px; color:#fff; display:none;';
    this.root.appendChild(this.inputChip);

    // Position, big and chunky ("1st").
    this.posEl = document.createElement('div');
    this.posEl.style.cssText =
      `position:absolute; top:44px; left:14px; font-family:${THEME.fontDisplay}; font-size:56px; color:#fff; ` +
      'text-shadow:0 3px 0 rgba(11,36,48,0.5); display:none; line-height:1;';
    this.root.appendChild(this.posEl);

    // Lap counter, just under position.
    this.lapEl = document.createElement('div');
    this.lapEl.style.cssText =
      `position:absolute; top:104px; left:16px; font-family:${THEME.fontLabel}; font-size:18px; font-weight:700; ` +
      'color:#fff; text-shadow:0 2px 4px rgba(0,0,0,0.5); letter-spacing:1px; display:none;';
    this.root.appendChild(this.lapEl);

    // Speed, small — bottom corner of this half.
    this.speedEl = document.createElement('div');
    this.speedEl.style.cssText =
      `position:absolute; bottom:14px; right:14px; font-family:${THEME.fontLabel}; font-size:14px; font-weight:600; ` +
      'color:rgba(255,255,255,0.85); text-shadow:0 1px 3px rgba(0,0,0,0.5); display:none;';
    this.root.appendChild(this.speedEl);

    // Drift charge bar — restyled (rounder, chunkier), same tier colours.
    this.driftBar = document.createElement('div');
    this.driftBar.style.cssText =
      'position:absolute; left:50%; bottom:28px; transform:translateX(-50%); width:180px; height:14px; ' +
      'border-radius:999px; background:rgba(11,36,48,0.4); overflow:hidden; display:none; border:2px solid rgba(255,255,255,0.3);';
    this.driftFill = document.createElement('div');
    this.driftFill.style.cssText = 'height:100%; width:0%; background:#7f8c8d; transition:background 0.1s;';
    this.driftBar.appendChild(this.driftFill);
    this.root.appendChild(this.driftBar);

    // Transient notice banner (phone disconnected/unavailable).
    this.noticeEl = document.createElement('div');
    this.noticeEl.style.cssText =
      `position:absolute; left:50%; top:20%; transform:translateX(-50%); font-family:${THEME.fontLabel}; ` +
      'font-size:15px; font-weight:700; color:#fff; background:rgba(11,36,48,0.75); padding:10px 18px; ' +
      'border-radius:16px; text-align:center; max-width:80%; display:none; animation:kartNoticePop 180ms ease-out;';
    this.root.appendChild(this.noticeEl);

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
      `position:absolute; pointer-events:none; font-family:${THEME.fontLabel}; color:#fff; ${box}` +
      (layout === 'hidden' ? ' display:none;' : ' display:block;');
  }

  // kind: null while there's genuinely nothing driving yet (e.g. before the
  // first sample) — chip stays hidden rather than showing a stale label.
  setInputLabel(kind: ControlSourceKind | null) {
    if (!kind) {
      this.inputChip.style.display = 'none';
      return;
    }
    this.inputChip.style.display = 'block';
    this.inputChip.textContent = kind.toUpperCase();
    this.inputChip.style.background = this.color;
  }

  setRaceInfo(lap: number, totalLaps: number, speedKmh: number, position: number, totalKarts: number) {
    this.posEl.style.display = 'block';
    this.posEl.textContent = ordinal(position);
    this.lapEl.style.display = 'block';
    this.lapEl.textContent = `LAP ${Math.min(lap + 1, totalLaps)}/${totalLaps}`;
    this.speedEl.style.display = 'block';
    this.speedEl.textContent = `${Math.round(speedKmh)} km/h`;
    void totalKarts; // kept in the signature for callers that still track it (position ordinal is self-sufficient)
  }

  hideRaceInfo() {
    this.posEl.style.display = 'none';
    this.lapEl.style.display = 'none';
    this.speedEl.style.display = 'none';
  }

  // tier: 0 (charging, below tier 1) .. 3. progress: 0..1 toward the max tier threshold.
  setDriftCharge(active: boolean, tier: number, progress: number) {
    this.driftBar.style.display = active ? 'block' : 'none';
    if (!active) return;
    const colors = ['#7f8c8d', '#3498db', '#e67e22', THEME.accent];
    this.driftFill.style.background = colors[Math.min(tier, colors.length - 1)];
    this.driftFill.style.width = `${Math.round(Math.min(Math.max(progress, 0), 1) * 100)}%`;
  }

  // §stage2: "Phone disconnected — P2 on keyboard" / "Phone unavailable — P2
  // on keyboard (arrows)", shown for a few seconds in this player's half.
  showNotice(text: string, ms: number) {
    if (this.noticeTimer !== null) window.clearTimeout(this.noticeTimer);
    this.noticeEl.textContent = text;
    this.noticeEl.style.display = 'block';
    this.noticeTimer = window.setTimeout(() => {
      this.noticeEl.style.display = 'none';
      this.noticeTimer = null;
    }, ms);
  }
}
