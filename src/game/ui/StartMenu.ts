import type { GameMode } from '../session';
import { THEME } from './theme';

// §stage2: the full-screen start menu — two big cards, Solo and Versus. No
// map picker any more (this build ships one track; see maps.ts) and no
// player/character picker (P1 is always Mario, P2 always Luigi — registry.ts).
//
// Deliberately three-free, like before: this module is what index.html loads
// first, and pulling three.js in here would put the whole 700kB bundle in
// front of the first paint.

const CARD_BASE =
  'flex:1 1 0; min-width:0; display:flex; flex-direction:column; align-items:center; justify-content:center; ' +
  'gap:14px; padding:48px 32px; border-radius:32px; border:6px solid rgba(11,36,48,0.12); ' +
  `font-family:${THEME.fontLabel}; color:${THEME.ink}; cursor:pointer; font:inherit; text-align:center; ` +
  'transition:transform 140ms ease, box-shadow 140ms ease; box-shadow:0 8px 0 rgba(11,36,48,0.18);';

function styleCardHover(card: HTMLElement) {
  card.addEventListener('pointerenter', () => {
    card.style.transform = 'translateY(-4px)';
    card.style.boxShadow = '0 12px 0 rgba(11,36,48,0.22)';
  });
  card.addEventListener('pointerleave', () => {
    card.style.transform = 'none';
    card.style.boxShadow = '0 8px 0 rgba(11,36,48,0.18)';
  });
  card.addEventListener('pointerdown', () => {
    card.style.transform = 'translateY(4px)';
    card.style.boxShadow = '0 4px 0 rgba(11,36,48,0.18)';
  });
}

function buildCard(opts: {
  bg: string;
  icon: string;
  title: string;
  subtitle: string;
}): HTMLButtonElement {
  const card = document.createElement('button');
  card.style.cssText = `${CARD_BASE} background:${opts.bg};`;
  const icon = document.createElement('div');
  icon.textContent = opts.icon;
  icon.style.cssText = 'font-size:64px; line-height:1;';
  const title = document.createElement('div');
  title.textContent = opts.title;
  title.style.cssText = `font-family:${THEME.fontDisplay}; font-size:44px; letter-spacing:1px;`;
  const subtitle = document.createElement('div');
  subtitle.textContent = opts.subtitle;
  subtitle.style.cssText = 'font-size:16px; font-weight:600; opacity:0.75; max-width:260px; line-height:1.4;';
  card.append(icon, title, subtitle);
  styleCardHover(card);
  return card;
}

export function showStartMenu(app: HTMLElement, launch: (mode: GameMode) => void) {
  app.innerHTML = '';

  const root = document.createElement('div');
  root.style.cssText =
    `position:fixed; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:36px; ` +
    `background:linear-gradient(180deg, ${THEME.oceanShallow} 0%, ${THEME.oceanDeep} 100%); overflow:hidden;`;
  app.appendChild(root);

  const heading = document.createElement('div');
  heading.style.cssText =
    `font-family:${THEME.fontDisplay}; font-size:clamp(36px, 7vw, 72px); color:${THEME.sand}; ` +
    'letter-spacing:2px; text-shadow:0 4px 0 rgba(11,36,48,0.35); text-align:center;';
  heading.textContent = 'COAST KART';
  root.appendChild(heading);

  const cards = document.createElement('div');
  cards.style.cssText =
    'display:flex; gap:28px; width:min(920px, 92vw); flex-wrap:wrap; justify-content:center;';
  root.appendChild(cards);

  const soloCard = buildCard({
    bg: THEME.sand,
    icon: '🖐️',
    title: 'SOLO',
    subtitle: 'Mario on hands, full screen. Keyboard if the camera is off.',
  });
  const versusCard = buildCard({
    bg: THEME.accent,
    icon: '🤝',
    title: 'VERSUS',
    subtitle: 'Split screen — Mario on hands vs Luigi on phone or keyboard.',
  });
  cards.append(soloCard, versusCard);

  // One pick only: the menu removes itself (it would otherwise sit over the
  // race, since main.ts's canvas and HUD are appended *behind* it in `app`),
  // and a double-click can't import/build the world twice.
  let picked = false;
  const pick = (mode: GameMode) => {
    if (picked) return;
    picked = true;
    root.remove();
    launch(mode);
  };
  soloCard.addEventListener('click', () => pick('single'));
  versusCard.addEventListener('click', () => pick('multi'));
}
