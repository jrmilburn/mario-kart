import { setSession, type GameMode } from './session';
import { MAPS } from './track/maps';
import { showStartMenu } from './ui/StartMenu';

// §v4/stage2: the page's entry point. Shows the start menu (Solo/Versus) and
// only then loads the game itself.
//
// The `import('./main')` is dynamic on purpose: main.ts builds the whole world
// — track geometry, terrain, environment, karts, cameras, and (versus only)
// the room's WebSocket — at module scope, so it must not evaluate until the
// choice has been recorded in session.ts. It also means the menu paints
// without waiting on the ~700kB three.js chunk behind it, and Solo never even
// creates a socket (see main.ts).
//
// §stage2: no map picker any more — this build ships one track (MAPS[0]; see
// track/maps.ts) — so session only needs the mode.
const app = document.getElementById('app')!;
const mapId = MAPS[0].id;

function launch(mode: GameMode) {
  setSession({ mode, mapId });

  // The game chunk plus building the track/terrain takes a beat; without this
  // the screen is simply black between the menu closing and the first frame.
  const loading = document.createElement('div');
  loading.style.cssText =
    'position:fixed; inset:0; z-index:40; display:flex; flex-direction:column; align-items:center; ' +
    'justify-content:center; gap:14px; color:#fff; font-family:system-ui,sans-serif; background:#05050b;';
  loading.innerHTML =
    `<div style="font-size:26px; font-weight:800;">${MAPS[0].name}</div>` +
    '<div style="font-size:15px; opacity:0.6;">Building the track…</div>';
  app.appendChild(loading);

  void import('./main')
    .then(() => {
      // main.ts's module body has run by now, but nothing has been *rendered*
      // yet — hold the curtain for two frames so the first thing revealed is
      // the track rather than a black canvas.
      requestAnimationFrame(() => requestAnimationFrame(() => loading.remove()));
    })
    .catch((err) => {
      // §defect-fix: main.ts's module body does a LOT at load time (WebGL
      // context, MediaPipe/hand tracking init, track geometry) with plenty of
      // ways to throw on an unsupported browser/GPU — without this the
      // curtain above just sat there forever with no explanation.
      console.error('[entry] failed to start the game', err);
      loading.innerHTML =
        '<div style="font-size:20px; font-weight:800; text-align:center; padding:0 24px;">' +
        "Couldn't start the game</div>" +
        '<div style="font-size:14px; opacity:0.7; text-align:center; padding:0 24px; max-width:480px;">' +
        'Try Chrome/Edge with hardware acceleration on.</div>';
    });
}

// ?mode=solo|versus skips the menu — used for reloading straight back into a
// chosen mode (and for testing).
const params = new URLSearchParams(location.search);
const urlMode = params.get('mode');
if (urlMode === 'solo') {
  launch('single');
} else if (urlMode === 'versus') {
  launch('multi');
} else {
  showStartMenu(app, launch);
}
