// §v5: H hides ALL debug UI at once (hand overlay, diagnostics panel/fps) for
// clean recording. One class on <html> plus one injected rule, rather than
// each widget tracking a second visibility flag that would fight its own
// show/hide logic (e.g. Diagnostics' backtick toggle).
//
// Elements opt in with markDebug(). 'hide' removes them from layout;
// 'fade' only makes them invisible — used for the hand overlay, whose <video>
// must keep being composited or the browser may stop delivering
// requestVideoFrameCallback frames to the hand tracker.
const STYLE_ID = 'kart-debug-toggle-styles';
const HIDDEN_CLASS = 'kart-debug-hidden';

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent =
    `.${HIDDEN_CLASS} [data-debug="hide"] { display: none !important; }\n` +
    `.${HIDDEN_CLASS} [data-debug="fade"] { opacity: 0 !important; pointer-events: none !important; }\n`;
  document.head.appendChild(style);
}

export function markDebug(el: HTMLElement, mode: 'hide' | 'fade' = 'hide') {
  ensureStyles();
  el.dataset.debug = mode;
}

export function isDebugHidden(): boolean {
  return document.documentElement.classList.contains(HIDDEN_CLASS);
}

export function attachDebugToggle() {
  ensureStyles();
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyH' || e.repeat) return;
    document.documentElement.classList.toggle(HIDDEN_CLASS);
  });
}
