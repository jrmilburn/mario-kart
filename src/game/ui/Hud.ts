import QRCode from 'qrcode';
import type { ConnectionStatus } from '../net/GameSocket';
import type { PlayerSlot, SteerMode } from '../../shared/protocol';

// §v4: one lobby seat — a QR block (title, code image, room code, hint) plus
// the confirmation line that replaces it once that seat's phone is connected.
interface SeatPanel {
  root: HTMLDivElement;
  titleEl: HTMLDivElement;
  qrBlock: HTMLDivElement;
  qrCanvas: HTMLCanvasElement;
  codeEl: HTMLDivElement;
  statusEl: HTMLDivElement;
  connected: boolean;
}

function buildSeatPanel(slot: number): SeatPanel {
  const root = document.createElement('div');

  const qrBlock = document.createElement('div');
  qrBlock.style.cssText =
    'display:flex; flex-direction:column; align-items:center; gap:12px;';
  root.appendChild(qrBlock);

  const titleEl = document.createElement('div');
  titleEl.style.cssText = 'font-size:20px; opacity:0.85;';
  titleEl.textContent = slot === 0 ? 'Scan to connect your phone' : `Player ${slot + 1} — scan to join`;
  qrBlock.appendChild(titleEl);

  const qrCanvas = document.createElement('canvas');
  qrCanvas.style.cssText = 'background:#fff; padding:8px; border-radius:8px;';
  qrBlock.appendChild(qrCanvas);

  const codeEl = document.createElement('div');
  codeEl.style.cssText = 'font-size:56px; font-weight:700; letter-spacing:8px;';
  qrBlock.appendChild(codeEl);

  const statusEl = document.createElement('div');
  statusEl.style.cssText =
    'font-size:15px; padding:8px 18px; border-radius:999px; background:#27ae60; display:none;';
  root.appendChild(statusEl);

  return { root, titleEl, qrBlock, qrCanvas, codeEl, statusEl, connected: false };
}

// Shared chrome only (Phase 2c) — per-player race readouts (lap/pos/speed,
// drift bar, item slot) live in PlayerHud.ts, one instance per human player.
export class Hud {
  private root: HTMLDivElement;
  private pill: HTMLDivElement;
  // §v4: one lobby panel per seat rather than one shared one. In two-player
  // mode each half of the split screen carries its own QR code, and a half's
  // code disappears the moment that seat's phone connects.
  private seats: SeatPanel[];
  private lobbyVisible = false;
  private seatSplit = false;
  private kbBadge: HTMLDivElement;
  private steerModeBadge: HTMLDivElement;
  private divider: HTMLDivElement;
  private countdownEl: HTMLDivElement;
  private pausedOverlay: HTMLDivElement;
  private pausedMessageEl: HTMLDivElement;
  private pausedRestartEl: HTMLDivElement;
  private resultsPanel: HTMLDivElement;
  private resultsList: HTMLDivElement;

  constructor(container: HTMLElement) {
    this.root = document.createElement('div');
    this.root.style.cssText =
      'position:fixed; inset:0; pointer-events:none; font-family:system-ui,sans-serif; color:#fff;';
    container.appendChild(this.root);

    this.pill = document.createElement('div');
    this.pill.style.cssText =
      'position:absolute; top:12px; right:12px; padding:6px 14px; border-radius:999px; font-size:13px; background:#f39c12; pointer-events:auto;';
    this.pill.textContent = 'connecting…';
    this.root.appendChild(this.pill);

    this.kbBadge = document.createElement('div');
    this.kbBadge.style.cssText =
      'position:absolute; top:12px; right:110px; padding:6px 12px; border-radius:999px; ' +
      'font-size:13px; font-weight:700; background:#34495e; display:none;';
    this.kbBadge.textContent = 'KB';
    this.root.appendChild(this.kbBadge);

    this.steerModeBadge = document.createElement('div');
    this.steerModeBadge.style.cssText =
      'position:absolute; top:12px; right:190px; padding:6px 12px; border-radius:999px; ' +
      'font-size:13px; font-weight:700; background:#2c3e50; display:none;';
    this.root.appendChild(this.steerModeBadge);

    // 2px center divider, shown only while split-screen is active (§Phase 2c).
    this.divider = document.createElement('div');
    this.divider.style.cssText =
      'position:absolute; left:50%; top:0; bottom:0; width:2px; margin-left:-1px; ' +
      'background:rgba(255,255,255,0.35); display:none; z-index:2;';
    this.root.appendChild(this.divider);

    this.seats = [buildSeatPanel(0), buildSeatPanel(1)];
    for (const seat of this.seats) this.root.appendChild(seat.root);
    this.applySeatLayout();

    this.countdownEl = document.createElement('div');
    this.countdownEl.style.cssText =
      'position:absolute; inset:0; display:none; align-items:center; justify-content:center; ' +
      'font-size:160px; font-weight:900; text-shadow:0 4px 16px rgba(0,0,0,0.6);';
    this.root.appendChild(this.countdownEl);

    this.pausedOverlay = document.createElement('div');
    this.pausedOverlay.style.cssText =
      'position:absolute; inset:0; display:none; flex-direction:column; align-items:center; justify-content:center; gap:12px; ' +
      'background:rgba(0,0,0,0.6); font-size:24px; text-align:center; padding:0 40px;';
    this.pausedMessageEl = document.createElement('div');
    this.pausedOverlay.appendChild(this.pausedMessageEl);
    this.pausedRestartEl = document.createElement('div');
    this.pausedRestartEl.style.cssText = 'font-size:16px; opacity:0.8;';
    this.pausedRestartEl.textContent = 'Or tap RESTART on a phone / press R to return to the lobby';
    this.pausedOverlay.appendChild(this.pausedRestartEl);
    this.root.appendChild(this.pausedOverlay);

    this.resultsPanel = document.createElement('div');
    this.resultsPanel.style.cssText =
      'position:absolute; inset:0; display:none; flex-direction:column; align-items:center; ' +
      'justify-content:center; gap:16px; background:rgba(0,0,0,0.6); font-size:32px; pointer-events:auto;';
    const resultsTitle = document.createElement('div');
    resultsTitle.textContent = '🏁 Race complete!';
    this.resultsList = document.createElement('div');
    this.resultsList.style.cssText = 'font-size:20px; display:flex; flex-direction:column; gap:6px;';
    const resultsHint = document.createElement('div');
    resultsHint.style.cssText = 'font-size:16px; opacity:0.8;';
    resultsHint.textContent = 'Press R or tap RESTART on your phone';
    this.resultsPanel.append(resultsTitle, this.resultsList, resultsHint);
    this.root.appendChild(this.resultsPanel);
  }

  // Both seats show the SAME room code and QR: the server hands whoever scans
  // first the free slot (§Phase 2a), so the two codes are interchangeable —
  // what differs is which half of the screen each one is standing in front of.
  showRoom(code: string, joinUrl: string) {
    for (const seat of this.seats) {
      seat.codeEl.textContent = code;
      QRCode.toCanvas(seat.qrCanvas, joinUrl, { width: 190, margin: 1 }).catch(() => {
        /* rendering the QR is a nicety; the text code still works */
      });
    }
  }

  setConnectionStatus(status: ConnectionStatus) {
    const map: Record<ConnectionStatus, [string, string]> = {
      connecting: ['connecting…', '#f39c12'],
      connected: ['connected', '#27ae60'],
      reconnecting: ['reconnecting…', '#c0392b'],
    };
    const [text, color] = map[status];
    this.pill.textContent = text;
    this.pill.style.background = color;
  }

  // §v4: a seat's QR block disappears as soon as that seat's phone is on, and
  // is replaced by a slim confirmation pill — so a split screen ends up with
  // one code left standing in front of whoever hasn't joined yet, and the
  // dimming panel lifts off the track once a seat is filled.
  setPeerStatus(slot: PlayerSlot, connected: boolean) {
    const seat = this.seats[slot];
    seat.connected = connected;
    seat.qrBlock.style.display = connected ? 'none' : 'flex';
    seat.statusEl.textContent = connected
      ? `P${slot + 1} connected ✓ — pick a character, then START`
      : '';
    seat.statusEl.style.display = connected ? 'block' : 'none';
    seat.root.style.background = connected ? 'transparent' : 'rgba(0,0,0,0.55)';
  }

  setKeyboardActive(active: boolean) {
    this.kbBadge.style.display = active ? 'block' : 'none';
  }

  setSteerMode(mode: SteerMode | null) {
    if (!mode) {
      this.steerModeBadge.style.display = 'none';
      return;
    }
    this.steerModeBadge.style.display = 'block';
    this.steerModeBadge.textContent = mode.toUpperCase();
  }

  // Shown only while two players are actively racing split-screen (§Phase 2c).
  // §v4: also decides whether the lobby shows one full-screen QR or one per
  // half, since that is the same question.
  setSplit(split: boolean) {
    this.divider.style.display = split ? 'block' : 'none';
    if (split === this.seatSplit) return;
    this.seatSplit = split;
    this.applySeatLayout();
  }

  private applySeatLayout() {
    const box = ['left:0; top:0; bottom:0; width:50%;', 'right:0; top:0; bottom:0; width:50%;'];
    this.seats.forEach((seat, i) => {
      const positioned = this.seatSplit ? box[i] : 'inset:0;';
      // Seat 1 only exists on a split screen; solo play has a single seat.
      const visible = this.lobbyVisible && (this.seatSplit || i === 0);
      seat.root.style.cssText =
        'position:absolute; display:flex; flex-direction:column; align-items:center; justify-content:center; ' +
        `gap:14px; pointer-events:auto; text-align:center; padding:0 16px; box-sizing:border-box; ${positioned}` +
        (visible ? ' ' : ' display:none;');
      seat.root.style.background = seat.connected ? 'transparent' : 'rgba(0,0,0,0.55)';
      seat.titleEl.textContent = this.seatSplit ? `Player ${i + 1} — scan to join` : 'Scan to connect your phone';
    });
  }

  // Both are called every frame from main.ts's race-state switch, so they
  // no-op unless the state actually changed — applySeatLayout rewrites style
  // strings and is not something to run 60 times a second.
  hideLobby() {
    if (!this.lobbyVisible) return;
    this.lobbyVisible = false;
    this.applySeatLayout();
  }

  showLobby() {
    if (this.lobbyVisible) return;
    this.lobbyVisible = true;
    this.applySeatLayout();
  }

  showCountdown(text: string) {
    this.countdownEl.style.display = 'flex';
    this.countdownEl.textContent = text;
  }

  hideCountdown() {
    this.countdownEl.style.display = 'none';
  }

  // `staleSlots` names which active human players' controllers have gone
  // stale (empty/omitted falls back to a generic message — e.g. solo play,
  // where the caller doesn't bother tracking slots).
  setPaused(paused: boolean, staleSlots: PlayerSlot[] = []) {
    this.pausedOverlay.style.display = paused ? 'flex' : 'none';
    if (paused) this.pausedMessageEl.textContent = this.pausedMessage(staleSlots);
  }

  private pausedMessage(staleSlots: PlayerSlot[]): string {
    if (staleSlots.length === 0) {
      return 'Controller disconnected — reconnect phone or use WASD / arrow keys';
    }
    return staleSlots
      .map((slot) =>
        slot === 0
          ? 'P1 controller disconnected — reconnect phone or use WASD'
          : 'P2 controller disconnected — reconnect phone or use arrow keys',
      )
      .join(' · ');
  }

  // results: entries ordered by finish position (1st..last). `slot` is the
  // human player driving that kart (highlighted P1/P2), null for AI (§Phase 2c).
  showResults(results: Array<{ name: string; slot: PlayerSlot | null }>) {
    this.resultsPanel.style.display = 'flex';
    this.resultsList.innerHTML = '';
    const SLOT_COLORS: Record<PlayerSlot, string> = { 0: '#ff6b35', 1: '#3498db' };
    results.forEach((r, i) => {
      const row = document.createElement('div');
      const label = r.slot === 0 ? ' (P1)' : r.slot === 1 ? ' (P2)' : '';
      row.textContent = `${i + 1}. ${r.name}${label}`;
      if (r.slot !== null) {
        row.style.fontWeight = '800';
        row.style.color = SLOT_COLORS[r.slot];
      }
      this.resultsList.appendChild(row);
    });
  }

  hideResults() {
    this.resultsPanel.style.display = 'none';
  }
}
