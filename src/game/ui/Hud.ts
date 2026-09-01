import QRCode from 'qrcode';
import type { ConnectionStatus } from '../net/GameSocket';
import type { PlayerSlot, SteerMode } from '../../shared/protocol';

// Shared chrome only (Phase 2c) — per-player race readouts (lap/pos/speed,
// drift bar, item slot) live in PlayerHud.ts, one instance per human player.
export class Hud {
  private root: HTMLDivElement;
  private pill: HTMLDivElement;
  private lobbyPanel: HTMLDivElement;
  private codeEl: HTMLDivElement;
  private qrCanvas: HTMLCanvasElement;
  private p1PeerEl: HTMLDivElement;
  private p2PeerEl: HTMLDivElement;
  private kbBadge: HTMLDivElement;
  private steerModeBadge: HTMLDivElement;
  private divider: HTMLDivElement;
  private countdownEl: HTMLDivElement;
  private pausedOverlay: HTMLDivElement;
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

    this.lobbyPanel = document.createElement('div');
    this.lobbyPanel.style.cssText =
      'position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:16px; background:rgba(0,0,0,0.55); pointer-events:auto;';
    this.root.appendChild(this.lobbyPanel);

    const title = document.createElement('div');
    title.textContent = 'Scan to connect your phone';
    title.style.cssText = 'font-size:20px; opacity:0.85;';
    this.lobbyPanel.appendChild(title);

    this.qrCanvas = document.createElement('canvas');
    this.qrCanvas.style.cssText = 'background:#fff; padding:8px; border-radius:8px;';
    this.lobbyPanel.appendChild(this.qrCanvas);

    this.codeEl = document.createElement('div');
    this.codeEl.style.cssText = 'font-size:72px; font-weight:700; letter-spacing:8px;';
    this.lobbyPanel.appendChild(this.codeEl);

    // P1 is required (red until connected); P2 is an optional second seat
    // (neutral gray until connected) — the same QR/room code joins either slot.
    const peerRow = document.createElement('div');
    peerRow.style.cssText = 'display:flex; flex-direction:column; gap:6px; align-items:center;';
    this.lobbyPanel.appendChild(peerRow);

    this.p1PeerEl = document.createElement('div');
    this.p1PeerEl.style.cssText =
      'font-size:14px; padding:6px 16px; border-radius:999px; background:#c0392b;';
    this.p1PeerEl.textContent = 'P1: waiting for phone…';
    peerRow.appendChild(this.p1PeerEl);

    this.p2PeerEl = document.createElement('div');
    this.p2PeerEl.style.cssText =
      'font-size:14px; padding:6px 16px; border-radius:999px; background:#7f8c8d;';
    this.p2PeerEl.textContent = 'P2: scan to join (optional)';
    peerRow.appendChild(this.p2PeerEl);

    this.countdownEl = document.createElement('div');
    this.countdownEl.style.cssText =
      'position:absolute; inset:0; display:none; align-items:center; justify-content:center; ' +
      'font-size:160px; font-weight:900; text-shadow:0 4px 16px rgba(0,0,0,0.6);';
    this.root.appendChild(this.countdownEl);

    this.pausedOverlay = document.createElement('div');
    this.pausedOverlay.style.cssText =
      'position:absolute; inset:0; display:none; align-items:center; justify-content:center; ' +
      'background:rgba(0,0,0,0.6); font-size:24px; text-align:center; padding:0 40px;';
    this.pausedOverlay.textContent = 'Controller disconnected — reconnect phone or press K for keyboard';
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

  showRoom(code: string, joinUrl: string) {
    this.codeEl.textContent = code;
    QRCode.toCanvas(this.qrCanvas, joinUrl, { width: 220, margin: 1 }).catch(() => {
      /* rendering the QR is a nicety; the text code still works */
    });
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

  // Lobby-only per-slot connection status (Phase 2c) — the same QR/room code
  // joins either slot; the server assigns whichever is free.
  setPeerStatus(slot: PlayerSlot, connected: boolean) {
    if (slot === 0) {
      this.p1PeerEl.textContent = connected ? 'P1 connected ✓' : 'P1: waiting for phone…';
      this.p1PeerEl.style.background = connected ? '#27ae60' : '#c0392b';
    } else {
      this.p2PeerEl.textContent = connected ? 'P2 connected ✓' : 'P2: scan to join (optional)';
      this.p2PeerEl.style.background = connected ? '#27ae60' : '#7f8c8d';
    }
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
  setSplit(split: boolean) {
    this.divider.style.display = split ? 'block' : 'none';
  }

  hideLobby() {
    this.lobbyPanel.style.display = 'none';
  }

  showLobby() {
    this.lobbyPanel.style.display = 'flex';
  }

  showCountdown(text: string) {
    this.countdownEl.style.display = 'flex';
    this.countdownEl.textContent = text;
  }

  hideCountdown() {
    this.countdownEl.style.display = 'none';
  }

  setPaused(paused: boolean) {
    this.pausedOverlay.style.display = paused ? 'flex' : 'none';
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
