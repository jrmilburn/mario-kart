// Keeps the phone screen awake for the race. The Wake Lock API releases
// itself whenever the tab is backgrounded, so we re-acquire on visibilitychange
// (§Phase 7). Best-effort: unsupported browsers or a denied request just mean
// the phone may sleep — not a hard failure for the demo.
export class WakeLock {
  private sentinel: WakeLockSentinel | null = null;

  start() {
    this.requestLock();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.requestLock();
    });
  }

  private async requestLock() {
    if (!('wakeLock' in navigator)) return;
    try {
      this.sentinel = await navigator.wakeLock.request('screen');
      this.sentinel.addEventListener('release', () => {
        this.sentinel = null;
      });
    } catch {
      // Permission denied or not allowed in this context — non-critical.
    }
  }
}
