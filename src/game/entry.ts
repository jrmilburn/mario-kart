import { setSession, type GameMode } from './session';
import { MAPS, mapById, type MapId } from './track/maps';
import { showStartMenu } from './ui/StartMenu';

// §v4: the page's entry point. Shows the start menu (players, then track) and
// only then loads the game itself.
//
// The `import('./main')` is dynamic on purpose: main.ts builds the whole world
// — track geometry, terrain, environment, karts, cameras, and the room's
// WebSocket — at module scope, so it must not evaluate until the choice has
// been recorded in session.ts. It also means the room code (and therefore the
// QR) is only created once a race is actually about to be set up, and that the
// menu paints without waiting on the ~700kB three.js chunk behind it.
const app = document.getElementById('app')!;

function launch(mode: GameMode, mapId: MapId) {
  setSession({ mode, mapId });

  // The game chunk plus building the track/terrain takes a beat; without this
  // the screen is simply black between the menu closing and the first frame.
  const loading = document.createElement('div');
  loading.style.cssText =
    'position:fixed; inset:0; z-index:40; display:flex; flex-direction:column; align-items:center; ' +
    'justify-content:center; gap:14px; color:#fff; font-family:system-ui,sans-serif; background:#05050b;';
  loading.innerHTML =
    `<div style="font-size:26px; font-weight:800;">${mapById(mapId).name}</div>` +
    '<div style="font-size:15px; opacity:0.6;">Building the track…</div>';
  app.appendChild(loading);

  void import('./main').then(() => {
    // main.ts's module body has run by now, but nothing has been *rendered*
    // yet — hold the curtain for two frames so the first thing revealed is the
    // track rather than a black canvas.
    requestAnimationFrame(() => requestAnimationFrame(() => loading.remove()));
  });
}

// ?mode=single|multi&map=<id> skips the menu — used for reloading straight
// back into a chosen combination (and for testing).
const params = new URLSearchParams(location.search);
const urlMode = params.get('mode');
const urlMap = params.get('map');
if ((urlMode === 'single' || urlMode === 'multi') && MAPS.some((m) => m.id === urlMap)) {
  launch(urlMode, urlMap as MapId);
} else {
  showStartMenu(app, launch);
}
