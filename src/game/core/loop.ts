const FIXED_DT = 1 / 60;
const MAX_FRAME_DT = 0.1; // 100ms clamp -> at most 6 catch-up steps, then time is dropped

export type UpdateFn = (dt: number) => void;
export type RenderFn = (alpha: number, stepsThisFrame: number) => void;

// Fixed 60Hz accumulator: physics is framerate-independent, render runs on rAF.
// Physics is frozen entirely while the tab is hidden (D.. §6 "frame drops breaking physics").
export function startLoop(update: UpdateFn, render: RenderFn) {
  let accumulator = 0;
  let lastTime = performance.now();

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) lastTime = performance.now();
  });

  function frame(now: number) {
    requestAnimationFrame(frame);

    if (document.hidden) {
      lastTime = now;
      return;
    }

    const frameDt = Math.min((now - lastTime) / 1000, MAX_FRAME_DT);
    lastTime = now;
    accumulator += frameDt;

    let steps = 0;
    while (accumulator >= FIXED_DT) {
      update(FIXED_DT);
      accumulator -= FIXED_DT;
      steps++;
    }

    render(accumulator / FIXED_DT, steps);
  }

  requestAnimationFrame(frame);
}
