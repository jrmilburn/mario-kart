import { buildFinishSummary, formatLapTime, totalTime, type FinishPlayerResult } from '../race/FinishResults';
import { THEME } from './theme';

// Brief "FINISH!" banner in accent colour...
const BANNER_MS = 1200;
// ...then the results panel, held at least this long before it steps back
// (fades + stops blocking input) so the cinematic showcase can be seen
// clearly behind/after it. It stays mounted (not removed) so R still restarts
// straight from here — main.ts's global keydown handler doesn't care whether
// the panel is visually faded.
const HOLD_MS = 4000;

// §stage2: the finish flow — banner, then a results panel with the winner and
// every active human's lap times, readable on camera, restyled in the new
// palette/fonts. Pure DOM; all the winner/title/lap-time math lives in the
// tested pure module race/FinishResults.ts.
export class FinishScreen {
  private root: HTMLDivElement;
  private banner: HTMLDivElement;
  private panel: HTMLDivElement;
  private titleEl: HTMLDivElement;
  private rowsEl: HTMLDivElement;
  private hintEl: HTMLDivElement;
  private persistentHint: HTMLDivElement;
  private bannerTimer: number | null = null;
  private stepBackTimer: number | null = null;
  private shown = false;
  // §defect-fix: true once the ≥4s results hold has actually elapsed. R /
  // phone RESTART must be ignored before this — otherwise an eager tap right
  // as the panel appears skips past results nobody got to read. Gated in
  // main.ts (see holdComplete).
  private holdDone = false;

  constructor(container: HTMLElement) {
    this.root = document.createElement('div');
    this.root.style.cssText =
      'position:fixed; inset:0; display:none; align-items:center; justify-content:center; z-index:8; ' +
      `font-family:${THEME.fontLabel}; color:#fff; transition:opacity 500ms ease;`;
    container.appendChild(this.root);

    this.banner = document.createElement('div');
    this.banner.style.cssText =
      `font-family:${THEME.fontDisplay}; font-size:min(140px, 18vw); color:${THEME.accent}; ` +
      'text-shadow:0 6px 0 rgba(11,36,48,0.5); display:none;';
    this.banner.textContent = 'FINISH!';
    this.root.appendChild(this.banner);

    this.panel = document.createElement('div');
    this.panel.style.cssText =
      'display:none; flex-direction:column; align-items:center; gap:18px; padding:36px 48px; ' +
      `border-radius:32px; background:rgba(11,36,48,0.82); border:5px solid ${THEME.accent};`;
    this.root.appendChild(this.panel);

    this.titleEl = document.createElement('div');
    this.titleEl.style.cssText = `font-family:${THEME.fontDisplay}; font-size:min(56px, 8vw); text-align:center;`;
    this.panel.appendChild(this.titleEl);

    this.rowsEl = document.createElement('div');
    this.rowsEl.style.cssText = 'display:flex; flex-direction:column; gap:14px; min-width:280px;';
    this.panel.appendChild(this.rowsEl);

    this.hintEl = document.createElement('div');
    this.hintEl.style.cssText = 'font-size:15px; opacity:0.75;';
    this.hintEl.textContent = 'Press R to race again';
    this.panel.appendChild(this.hintEl);

    // Persistent hint: shown once the results panel fades (stepBackTimer)
    // and left up indefinitely after that, since the panel itself becomes
    // invisible/non-interactive at that point and its own "Press R" hint
    // fades with it. A sibling of `root` (not a child) so root's opacity
    // fade-to-0 doesn't take it down too. Deliberately NOT markDebug()'d —
    // this is player-facing UI, not debug UI, so H must not hide it.
    this.persistentHint = document.createElement('div');
    this.persistentHint.style.cssText =
      'position:fixed; bottom:20px; left:50%; transform:translateX(-50%); z-index:8; ' +
      `font-family:${THEME.fontLabel}; font-size:13px; color:#fff; opacity:0; ` +
      'background:rgba(11,36,48,0.7); padding:6px 16px; border-radius:999px; ' +
      'pointer-events:none; transition:opacity 500ms ease; white-space:nowrap;';
    this.persistentHint.textContent = 'R to race again · M for menu';
    container.appendChild(this.persistentHint);
  }

  // R / phone RESTART must be ignored until this is true (see main.ts).
  get holdComplete(): boolean {
    return this.holdDone;
  }

  // Call exactly once per race, on the RACING->FINISHED edge.
  show(mode: 'single' | 'multi', players: FinishPlayerResult[]) {
    if (this.shown) return;
    this.shown = true;
    this.holdDone = false;
    this.persistentHint.style.opacity = '0';

    const summary = buildFinishSummary(mode, players);
    this.titleEl.textContent = summary.title;
    this.titleEl.style.color = summary.winner ? summary.winner.colorHex : '#fff';

    this.rowsEl.innerHTML = '';
    for (const p of summary.players) {
      this.rowsEl.appendChild(this.buildRow(p));
    }

    this.root.style.display = 'flex';
    this.root.style.opacity = '1';
    this.root.style.pointerEvents = 'auto';
    this.banner.style.display = 'flex';
    this.panel.style.display = 'none';

    this.bannerTimer = window.setTimeout(() => {
      this.banner.style.display = 'none';
      this.panel.style.display = 'flex';
    }, BANNER_MS);

    // After the hold, fade so the cinematic showcase reads clearly. R / phone
    // RESTART become live at this same instant (main.ts gates on
    // holdComplete) — the persistent hint below appears right as that
    // happens, replacing the panel's own (now-invisible) "Press R" hint.
    this.stepBackTimer = window.setTimeout(() => {
      this.root.style.opacity = '0.001'; // stays laid out (for a re-show) but visually gone
      this.root.style.pointerEvents = 'none';
      this.holdDone = true;
      this.persistentHint.style.opacity = '1';
    }, BANNER_MS + HOLD_MS);
  }

  private buildRow(p: FinishPlayerResult): HTMLDivElement {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; flex-direction:column; gap:4px;';

    const head = document.createElement('div');
    head.style.cssText = 'display:flex; align-items:center; gap:8px; font-weight:700; font-size:17px;';
    const dot = document.createElement('span');
    dot.style.cssText = `width:14px; height:14px; border-radius:50%; background:${p.colorHex}; display:inline-block;`;
    const name = document.createElement('span');
    name.textContent = p.name;
    const total = document.createElement('span');
    total.style.cssText = 'margin-left:auto; font-variant-numeric:tabular-nums; opacity:0.9;';
    total.textContent = formatLapTime(totalTime(p.lapTimes));
    head.append(dot, name, total);
    row.appendChild(head);

    const laps = document.createElement('div');
    laps.style.cssText = 'font-size:13px; opacity:0.75; font-variant-numeric:tabular-nums; padding-left:22px;';
    laps.textContent = p.lapTimes.map((t, i) => `L${i + 1} ${formatLapTime(t)}`).join('   ');
    row.appendChild(laps);

    return row;
  }

  hide() {
    this.shown = false;
    if (this.bannerTimer !== null) window.clearTimeout(this.bannerTimer);
    if (this.stepBackTimer !== null) window.clearTimeout(this.stepBackTimer);
    this.bannerTimer = null;
    this.stepBackTimer = null;
    this.root.style.display = 'none';
    this.root.style.opacity = '1';
    this.root.style.pointerEvents = 'auto';
    this.holdDone = false;
    this.persistentHint.style.opacity = '0';
  }
}
