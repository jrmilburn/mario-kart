import QRCode from 'qrcode';
import type { ConnectionStatus } from '../net/GameSocket';

export class Hud {
  private root: HTMLDivElement;
  private pill: HTMLDivElement;
  private lobbyPanel: HTMLDivElement;
  private codeEl: HTMLDivElement;
  private qrCanvas: HTMLCanvasElement;
  private peerEl: HTMLDivElement;
  private kbBadge: HTMLDivElement;
  private driftBar: HTMLDivElement;
  private driftFill: HTMLDivElement;

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

    this.driftBar = document.createElement('div');
    this.driftBar.style.cssText =
      'position:absolute; left:50%; bottom:24px; transform:translateX(-50%); width:180px; height:12px; ' +
      'border-radius:6px; background:rgba(0,0,0,0.4); overflow:hidden; display:none;';
    this.driftFill = document.createElement('div');
    this.driftFill.style.cssText = 'height:100%; width:0%; background:#3498db; transition:background 0.1s;';
    this.driftBar.appendChild(this.driftFill);
    this.root.appendChild(this.driftBar);

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

    this.peerEl = document.createElement('div');
    this.peerEl.style.cssText =
      'font-size:14px; padding:6px 16px; border-radius:999px; background:#c0392b;';
    this.peerEl.textContent = 'Waiting for phone…';
    this.lobbyPanel.appendChild(this.peerEl);
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

  setPeerConnected(connected: boolean) {
    this.peerEl.textContent = connected ? 'Phone connected ✓' : 'Waiting for phone…';
    this.peerEl.style.background = connected ? '#27ae60' : '#c0392b';
  }

  setKeyboardActive(active: boolean) {
    this.kbBadge.style.display = active ? 'block' : 'none';
  }

  // tier: 0 (charging, below tier 1) .. 3. progress: 0..1 toward the max tier threshold.
  setDriftCharge(active: boolean, tier: number, progress: number) {
    this.driftBar.style.display = active ? 'block' : 'none';
    if (!active) return;
    const colors = ['#7f8c8d', '#3498db', '#e67e22', '#9b59b6']; // gray, blue, orange, purple
    this.driftFill.style.background = colors[Math.min(tier, colors.length - 1)];
    this.driftFill.style.width = `${Math.round(Math.min(Math.max(progress, 0), 1) * 100)}%`;
  }

  hideLobby() {
    this.lobbyPanel.style.display = 'none';
  }

  showLobby() {
    this.lobbyPanel.style.display = 'flex';
  }
}
