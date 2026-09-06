import { MAPS, type MapDef, type MapId } from '../track/maps';
import type { GameMode } from '../session';

// §v4: the full-screen start menu on the main display — players, then track,
// then the game (and its QR codes) load.
//
// Deliberately three-free, like maps.ts: this module is what index.html loads
// first, and pulling three.js in here would put the whole 700kB bundle in
// front of the first paint. The track previews are drawn with plain canvas 2D
// from the same control points the real curve is built from.

const CARD_BASE =
  'flex:1 1 0; min-width:0; display:flex; flex-direction:column; align-items:center; justify-content:center; ' +
  'gap:18px; padding:40px 32px; border-radius:26px; border:2px solid rgba(255,255,255,0.16); ' +
  'background:rgba(255,255,255,0.04); color:#fff; cursor:pointer; font:inherit; text-align:center; ' +
  'transition:transform 120ms ease, border-color 120ms ease, background 120ms ease;';

function styleCardHover(card: HTMLElement, accent: string) {
  card.addEventListener('pointerenter', () => {
    card.style.transform = 'translateY(-6px)';
    card.style.borderColor = accent;
    card.style.background = 'rgba(255,255,255,0.09)';
  });
  card.addEventListener('pointerleave', () => {
    card.style.transform = 'none';
    card.style.borderColor = 'rgba(255,255,255,0.16)';
    card.style.background = 'rgba(255,255,255,0.04)';
  });
}

// Closed smooth curve through the control points, drawn with the
// midpoint-quadratic trick (move to the midpoint of each segment, curve
// through the point itself). Not the same spline the track uses, but a
// faithful enough silhouette for a thumbnail — and it costs no dependencies.
function drawLayoutPreview(canvas: HTMLCanvasElement, map: MapDef) {
  const dpr = Math.min(window.devicePixelRatio, 2);
  const w = canvas.clientWidth || 320;
  const h = canvas.clientHeight || 190;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const pts = map.controlPoints.map(([x, , z]) => ({ x, z }));
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }
  const pad = 22;
  const scale = Math.min((w - pad * 2) / (maxX - minX || 1), (h - pad * 2) / (maxZ - minZ || 1));
  const ox = (w - (maxX - minX) * scale) / 2 - minX * scale;
  const oy = (h - (maxZ - minZ) * scale) / 2 - minZ * scale;
  const project = (p: { x: number; z: number }) => ({ x: ox + p.x * scale, y: oy + p.z * scale });

  const screen = pts.map(project);
  const mid = (a: { x: number; y: number }, b: { x: number; y: number }) => ({
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  });

  ctx.beginPath();
  const start = mid(screen[screen.length - 1], screen[0]);
  ctx.moveTo(start.x, start.y);
  for (let i = 0; i < screen.length; i++) {
    const p = screen[i];
    const next = mid(p, screen[(i + 1) % screen.length]);
    ctx.quadraticCurveTo(p.x, p.y, next.x, next.y);
  }
  ctx.closePath();

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(255,255,255,0.13)';
  ctx.lineWidth = 13;
  ctx.stroke();
  ctx.strokeStyle = map.accent;
  ctx.lineWidth = 5;
  ctx.stroke();

  // Start/finish marker at control point 0.
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(screen[0].x, screen[0].y, 5, 0, Math.PI * 2);
  ctx.fill();
}

export function showStartMenu(container: HTMLElement, launch: (mode: GameMode, mapId: MapId) => void) {
  const root = document.createElement('div');
  root.style.cssText =
    'position:fixed; inset:0; z-index:50; display:flex; flex-direction:column; align-items:center; ' +
    'justify-content:center; gap:22px; padding:4vh 4vw; box-sizing:border-box; color:#fff; ' +
    'font-family:system-ui,sans-serif; background:radial-gradient(circle at 50% 25%, #23305c 0%, #0a0b16 62%, #05050b 100%);';
  container.appendChild(root);

  const title = document.createElement('div');
  title.textContent = 'KART RACER';
  title.style.cssText = 'font-size:clamp(28px,4vw,52px); font-weight:900; letter-spacing:10px; opacity:0.92;';
  root.appendChild(title);

  const heading = document.createElement('div');
  heading.style.cssText = 'font-size:clamp(18px,2.2vw,26px); opacity:0.75;';
  root.appendChild(heading);

  const cards = document.createElement('div');
  cards.style.cssText =
    'display:flex; gap:28px; width:100%; max-width:1500px; flex:1 1 auto; align-items:stretch; min-height:0;';
  root.appendChild(cards);

  const footer = document.createElement('div');
  footer.style.cssText = 'font-size:15px; opacity:0.5; min-height:20px;';
  root.appendChild(footer);

  // Number keys pick a card on whichever step is showing; Escape steps back.
  let keyHandler: ((e: KeyboardEvent) => void) | null = null;
  // Listeners owned by the current step, torn down when it is replaced or the
  // menu closes (the map step attaches one resize listener per preview).
  let cleanups: (() => void)[] = [];

  function runCleanups() {
    for (const fn of cleanups) fn();
    cleanups = [];
  }
  function bindKeys(choices: (() => void)[], onBack: (() => void) | null) {
    if (keyHandler) window.removeEventListener('keydown', keyHandler);
    keyHandler = (e: KeyboardEvent) => {
      const index = Number(e.key) - 1;
      if (Number.isInteger(index) && index >= 0 && index < choices.length) choices[index]();
      else if (e.key === 'Escape' && onBack) onBack();
    };
    window.addEventListener('keydown', keyHandler);
  }

  function close() {
    if (keyHandler) window.removeEventListener('keydown', keyHandler);
    runCleanups();
    root.remove();
  }

  function showModeStep() {
    runCleanups();
    heading.textContent = 'How many players?';
    footer.textContent = 'Press 1 or 2';
    cards.innerHTML = '';

    const options: { label: string; sub: string; icon: string; mode: GameMode; accent: string }[] = [
      { label: 'Single player', sub: 'One phone · full screen', icon: '🎮', mode: 'single', accent: '#4fc3f7' },
      { label: 'Two players', sub: 'Two phones · split screen', icon: '👥', mode: 'multi', accent: '#ffb74d' },
    ];
    const choose: (() => void)[] = [];
    for (const option of options) {
      const card = document.createElement('button');
      card.style.cssText = CARD_BASE;
      card.innerHTML =
        `<div style="font-size:clamp(56px,9vw,128px); line-height:1;">${option.icon}</div>` +
        `<div style="font-size:clamp(26px,3.4vw,46px); font-weight:800;">${option.label}</div>` +
        `<div style="font-size:clamp(15px,1.3vw,19px); opacity:0.65;">${option.sub}</div>`;
      styleCardHover(card, option.accent);
      const pick = () => showMapStep(option.mode);
      card.addEventListener('click', pick);
      choose.push(pick);
      cards.appendChild(card);
    }
    bindKeys(choose, null);
  }

  function showMapStep(mode: GameMode) {
    runCleanups();
    heading.textContent = 'Choose your track';
    footer.textContent = 'Press 1 or 2 · Esc to go back';
    cards.innerHTML = '';

    const choose: (() => void)[] = [];
    for (const map of MAPS) {
      const card = document.createElement('button');
      card.style.cssText = CARD_BASE + ' padding:28px 26px; gap:14px;';

      const canvas = document.createElement('canvas');
      // flex:1 + min-height:0 lets the preview take whatever vertical space is
      // left in the card, so the cards genuinely fill the screen at any size.
      canvas.style.cssText = 'width:100%; flex:1 1 auto; min-height:0; display:block;';
      card.appendChild(canvas);

      const name = document.createElement('div');
      name.textContent = map.name;
      name.style.cssText = 'font-size:clamp(24px,3vw,42px); font-weight:800;';
      card.appendChild(name);

      const tagline = document.createElement('div');
      tagline.textContent = map.tagline;
      tagline.style.cssText = 'font-size:clamp(14px,1.2vw,18px); opacity:0.62; line-height:1.4;';
      card.appendChild(tagline);

      styleCardHover(card, map.accent);
      const pick = () => {
        close();
        launch(mode, map.id);
      };
      card.addEventListener('click', pick);
      choose.push(pick);
      cards.appendChild(card);
      // Drawn after layout so clientWidth/Height are real, and again on resize
      // since the canvas is now sized by flex rather than fixed pixels.
      requestAnimationFrame(() => drawLayoutPreview(canvas, map));
      const redraw = () => drawLayoutPreview(canvas, map);
      window.addEventListener('resize', redraw);
      cleanups.push(() => window.removeEventListener('resize', redraw));
    }
    bindKeys(choose, showModeStep);
  }

  showModeStep();
}
