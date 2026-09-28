import QRCode from 'qrcode';
import type { ConnectionStatus } from '../net/GameSocket';
import { THEME } from './theme';

const STYLE_ELEMENT_ID = 'kart-hud-styles';

function ensureStyles() {
  if (document.getElementById(STYLE_ELEMENT_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ELEMENT_ID;
  // Countdown numerals scale-pop-and-fade in on every new value; restarted by
  // toggling this class off/on (see showCountdown's reflow trick below).
  style.textContent = `
@keyframes kartCountdownPop { 0% { transform: scale(0.4); opacity: 0; } 55% { transform: scale(1.15); opacity: 1; } 100% { transform: scale(1); opacity: 1; } }
.kart-countdown-pop { animation: kartCountdownPop 380ms cubic-bezier(0.2, 0.9, 0.3, 1.3); }
`;
  document.head.appendChild(style);
}

// Shared chrome only (Phase 2c) — per-player race readouts live in
// PlayerHud.ts. §stage2: only ONE controller can ever exist (MAX_CONTROLLERS
// = 1, always P2), so there's only ever one join panel, shown on the right
// half of a versus lobby. Solo never calls any of the room/peer methods below
// — it never opens a socket at all (see main.ts) — so this whole panel simply
// never appears there. The old pause overlay and item-era results panel are
// gone: pausing is gone with the disconnect watchdog, and the finish screen
// is its own module (FinishScreen.ts) with its own lap-time/winner layout.
export class Hud {
  private root: HTMLDivElement;
  private pill: HTMLDivElement;
  private divider: HTMLDivElement;
  private joinPanel: HTMLDivElement;
  private joinQrCanvas: HTMLCanvasElement;
  private joinCodeEl: HTMLDivElement;
  private joinStatusEl: HTMLDivElement;
  private unreachableEl: HTMLDivElement;
  private readyHintEl: HTMLDivElement;
  private countdownEl: HTMLDivElement;
  private countdownNumberEl: HTMLDivElement;
  private goTimer: number | null = null;
  private lobbyVisible = false;
  private split = false;
  private lastCountdownValue: string | null = null;

  constructor(container: HTMLElement) {
    ensureStyles();

    this.root = document.createElement('div');
    this.root.style.cssText = `position:fixed; inset:0; pointer-events:none; font-family:${THEME.fontLabel}; color:#fff;`;
    container.appendChild(this.root);

    this.pill = document.createElement('div');
    this.pill.style.cssText =
      'position:absolute; top:14px; right:14px; padding:6px 16px; border-radius:999px; font-size:13px; ' +
      `font-weight:700; background:${THEME.accent}; color:${THEME.ink}; display:none;`;
    this.root.appendChild(this.pill);

    // 4px rounded center divider, shown only while split-screen is active.
    this.divider = document.createElement('div');
    this.divider.style.cssText =
      'position:absolute; left:50%; top:0; bottom:0; width:4px; margin-left:-2px; border-radius:4px; ' +
      'background:rgba(255,255,255,0.5); display:none; z-index:2;';
    this.root.appendChild(this.divider);

    // Right-half phone join panel — versus lobby only, never blocks start.
    this.joinPanel = document.createElement('div');
    this.joinPanel.style.cssText =
      'position:absolute; right:0; top:0; bottom:0; width:50%; display:none; flex-direction:column; ' +
      'align-items:center; justify-content:center; gap:14px; text-align:center;';
    this.root.appendChild(this.joinPanel);

    const joinCard = document.createElement('div');
    joinCard.style.cssText =
      'display:flex; flex-direction:column; align-items:center; gap:12px; border-radius:28px; ' +
      'background:rgba(11,36,48,0.55); padding:26px 30px;';
    this.joinPanel.appendChild(joinCard);

    const joinTitle = document.createElement('div');
    joinTitle.textContent = 'Scan to join as P2';
    joinTitle.style.cssText = 'font-size:16px; font-weight:600; opacity:0.9;';
    joinCard.appendChild(joinTitle);

    this.joinQrCanvas = document.createElement('canvas');
    this.joinQrCanvas.style.cssText = 'background:#fff; padding:8px; border-radius:12px;';
    joinCard.appendChild(this.joinQrCanvas);

    this.joinCodeEl = document.createElement('div');
    this.joinCodeEl.style.cssText =
      `font-family:${THEME.fontDisplay}; font-size:44px; letter-spacing:8px; color:${THEME.accent};`;
    joinCard.appendChild(this.joinCodeEl);

    this.joinStatusEl = document.createElement('div');
    this.joinStatusEl.style.cssText =
      `font-size:15px; font-weight:700; padding:8px 18px; border-radius:999px; background:${THEME.accent}; ` +
      `color:${THEME.ink}; display:none;`;
    this.joinPanel.appendChild(this.joinStatusEl);

    this.unreachableEl = document.createElement('div');
    this.unreachableEl.style.cssText = 'font-size:14px; font-weight:600; opacity:0.85; max-width:240px; display:none;';
    this.unreachableEl.textContent = 'Phone unavailable — P2 on keyboard (arrows)';
    this.joinPanel.appendChild(this.unreachableEl);

    // "Press SPACE to race" — shown once whatever calibration is needed is
    // done (or was never needed at all), bottom-center, above both halves.
    this.readyHintEl = document.createElement('div');
    this.readyHintEl.style.cssText =
      'position:absolute; left:50%; bottom:40px; transform:translateX(-50%); font-size:20px; font-weight:700; ' +
      'padding:10px 24px; border-radius:999px; background:rgba(11,36,48,0.55); display:none; white-space:nowrap;';
    this.root.appendChild(this.readyHintEl);

    // Animated countdown, centered over the whole window regardless of split.
    this.countdownEl = document.createElement('div');
    this.countdownEl.style.cssText =
      'position:absolute; inset:0; display:none; align-items:center; justify-content:center; z-index:4;';
    this.root.appendChild(this.countdownEl);

    this.countdownNumberEl = document.createElement('div');
    this.countdownNumberEl.style.cssText =
      `font-family:${THEME.fontDisplay}; font-size:min(260px, 40vw); line-height:1; ` +
      'text-shadow:0 8px 0 rgba(11,36,48,0.45);';
    this.countdownEl.appendChild(this.countdownNumberEl);
  }

  setConnectionStatus(status: ConnectionStatus) {
    const map: Record<ConnectionStatus, [string, string]> = {
      connecting: ['connecting…', THEME.accent],
      connected: ['connected', '#27ae60'],
      reconnecting: ['reconnecting…', '#c0392b'],
    };
    const [text, color] = map[status];
    this.pill.textContent = text;
    this.pill.style.background = color;
    this.pill.style.color = status === 'connecting' ? THEME.ink : '#fff';
    this.pill.style.display = 'block';
  }

  showRoom(code: string, joinUrl: string) {
    this.joinCodeEl.textContent = code;
    QRCode.toCanvas(this.joinQrCanvas, joinUrl, { width: 170, margin: 1 }).catch(() => {
      /* rendering the QR is a nicety; the text code still works */
    });
  }

  // §stage2: only ever P2 now (MAX_CONTROLLERS=1) — no slot parameter needed.
  setPeerStatus(connected: boolean) {
    this.joinStatusEl.textContent = connected ? 'P2 connected ✓' : '';
    this.joinStatusEl.style.display = connected ? 'block' : 'none';
  }

  // The relay itself couldn't be reached at all (versus only) — P2 falls back
  // to keyboard and this note explains why, without blocking anything.
  setPhoneUnreachable(unreachable: boolean) {
    this.unreachableEl.style.display = unreachable ? 'block' : 'none';
  }

  setSplit(split: boolean) {
    this.divider.style.display = split ? 'block' : 'none';
    this.split = split;
    this.applyJoinPanelVisibility();
  }

  private applyJoinPanelVisibility() {
    this.joinPanel.style.display = this.lobbyVisible && this.split ? 'flex' : 'none';
  }

  hideLobby() {
    if (!this.lobbyVisible) return;
    this.lobbyVisible = false;
    this.applyJoinPanelVisibility();
  }

  showLobby() {
    if (this.lobbyVisible) return;
    this.lobbyVisible = true;
    this.applyJoinPanelVisibility();
  }

  // null hides it; otherwise e.g. "Show both hands" / "Press SPACE to race".
  setReadyHint(text: string | null) {
    this.readyHintEl.style.display = text ? 'block' : 'none';
    if (text) this.readyHintEl.textContent = text;
  }

  // value: '3' | '2' | '1'. GO gets its own flashGo() call (see below) so it
  // can render in the accent colour without every other digit needing to
  // know about it.
  showCountdown(value: string) {
    this.countdownEl.style.display = 'flex';
    this.countdownNumberEl.style.color = '#fff';
    this.setNumber(value);
  }

  private setNumber(text: string) {
    if (text === this.lastCountdownValue) return;
    this.lastCountdownValue = text;
    this.countdownNumberEl.textContent = text;
    // Restart the pop animation on every new value: remove the class, force a
    // reflow, then re-add it — re-declaring `animation` alone doesn't restart
    // a keyframe animation that's still using the same class.
    this.countdownNumberEl.classList.remove('kart-countdown-pop');
    void this.countdownNumberEl.offsetWidth;
    this.countdownNumberEl.classList.add('kart-countdown-pop');
  }

  hideCountdown() {
    this.countdownEl.style.display = 'none';
    this.lastCountdownValue = null;
    if (this.goTimer !== null) {
      window.clearTimeout(this.goTimer);
      this.goTimer = null;
    }
  }

  // A brief "GO" flash in the accent colour right as the race actually
  // starts, then hides itself — main.ts fires this once on the
  // COUNTDOWN->RACING edge instead of threading a 4th countdown state through
  // RaceDirector.
  flashGo() {
    this.countdownEl.style.display = 'flex';
    this.countdownNumberEl.style.color = THEME.accent;
    this.setNumber('GO');
    if (this.goTimer !== null) window.clearTimeout(this.goTimer);
    this.goTimer = window.setTimeout(() => this.hideCountdown(), 700);
  }
}
