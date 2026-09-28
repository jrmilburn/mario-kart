import type { HandLandmarker, HandLandmarkerResult } from '@mediapipe/tasks-vision';
import type { RawHand } from './gestures';

// §v5: webcam + MediaPipe HandLandmarker on its own loop, decoupled from the
// render/physics loops. Everything is self-hosted under public/mediapipe/
// (model tracked in git, wasm copied from node_modules by
// scripts/copy-mediapipe.mjs), so the game has no CDN dependency.
//
// Contract with the rest of the game: start() NEVER throws and never rejects.
// Every failure — no camera API (insecure origin), permission denied, no
// device, model/wasm load failure, a detect() crash, the camera being
// unplugged — lands in a terminal status with a human-readable `message`, and
// P1 simply stays on the keyboard (HandProvider reports inactive).

const MODEL_URL = '/mediapipe/hand_landmarker.task';
const WASM_BASE = '/mediapipe/wasm';

// The wasm fileset createFromOptions expects — extracted from HandLandmarker's
// own static signature rather than imported directly, since the whole
// tasks-vision module is loaded dynamically (see createLandmarker).
type WasmFileset = Parameters<typeof HandLandmarker.createFromOptions>[0];

const RATE_HIGH_HZ = 30;
const RATE_LOW_HZ = 20;
// Rolling detect cost that drops us to 20Hz, and the (lower) cost that lets us
// climb back — the gap stops the rate flapping around one threshold.
const SLOW_DETECT_MS = 9;
const FAST_DETECT_MS = 6;
const DETECT_AVG_WINDOW = 30;
const WARMUP_DETECTIONS = 5; // first GPU calls include shader compile; keep them out of the average

export type HandTrackerStatus = 'off' | 'starting' | 'live' | 'denied' | 'no-camera' | 'failed';

export interface HandDetection {
  t: number; // performance.now() when the result was ready
  hands: RawHand[];
  videoW: number;
  videoH: number;
}

export class HandTracker {
  status: HandTrackerStatus = 'off';
  message = '';
  readonly video: HTMLVideoElement;
  // Diagnostics: rolling average detect() cost, current target and measured rate.
  detectMs = 0;
  targetHz = RATE_HIGH_HZ;
  measuredHz = 0;
  delegate: 'GPU' | 'CPU' | null = null;

  private landmarker: HandLandmarker | null = null;
  private stream: MediaStream | null = null;
  private detectionListeners: ((d: HandDetection) => void)[] = [];
  private statusListeners: ((s: HandTrackerStatus) => void)[] = [];
  private nextDueAt = 0;
  private lastVideoTime = -1;
  private detectCosts: number[] = [];
  private detectionCount = 0;
  private rateWindowStart = 0;
  private rateWindowCount = 0;
  private loopToken = 0;
  private pendingRvfc: number | null = null;
  private pendingTimer: number | null = null;
  private retryingWithCpu = false;
  private fileset: WasmFileset | null = null;
  private HandLandmarkerClass: typeof HandLandmarker | null = null;

  constructor() {
    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.autoplay = true;
  }

  get live(): boolean {
    return this.status === 'live';
  }

  onDetection(fn: (d: HandDetection) => void) {
    this.detectionListeners.push(fn);
  }

  onStatus(fn: (s: HandTrackerStatus) => void) {
    this.statusListeners.push(fn);
  }

  private setStatus(status: HandTrackerStatus, message = '') {
    this.status = status;
    this.message = message;
    for (const fn of this.statusListeners) {
      try {
        fn(status);
      } catch (err) {
        console.error('[hands] status listener failed', err);
      }
    }
  }

  async start(): Promise<void> {
    if (this.status === 'starting' || this.status === 'live') return;
    this.setStatus('starting', 'Starting camera…');
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        this.setStatus('no-camera', 'Camera unavailable (needs HTTPS or localhost) — using keyboard (WASD)');
        return;
      }

      // Camera permission and the model download run in parallel; the model is
      // ~7.5MB and the permission prompt waits on the user anyway.
      const landmarkerPromise = this.createLandmarker();
      // Swallow here so an early camera failure can't leave this as an
      // unhandled rejection; the awaited copy below still sees the error.
      // §stage2 review fix: if the camera path below bails out (denied,
      // no-camera, failed) BEFORE this resolves, `this.landmarker` is never
      // assigned and nothing else ever closes it — it would otherwise keep
      // holding its GPU/WASM resources for the rest of the page's life.
      landmarkerPromise
        .then((lm) => {
          if (this.status !== 'starting' && this.status !== 'live') {
            try {
              lm.close();
            } catch {
              // already torn down
            }
          }
        })
        .catch(() => undefined);

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
        });
      } catch (err) {
        const name = (err as { name?: string })?.name;
        if (name === 'NotAllowedError' || name === 'SecurityError') {
          this.setStatus('denied', 'Camera blocked — using keyboard (WASD)');
        } else if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'NotReadableError') {
          this.setStatus('no-camera', 'No camera available — using keyboard (WASD)');
        } else {
          this.setStatus('failed', 'Camera failed — using keyboard (WASD)');
        }
        console.warn('[hands] getUserMedia failed', err);
        return;
      }
      this.stream = stream;
      for (const track of stream.getVideoTracks()) {
        track.addEventListener('ended', () => this.fail('Camera disconnected — using keyboard (WASD)'));
      }
      this.video.srcObject = stream;
      await this.video.play();

      try {
        this.landmarker = await landmarkerPromise;
      } catch (err) {
        console.error('[hands] HandLandmarker failed to load', err);
        this.fail('Hand tracking failed to load — using keyboard (WASD)');
        return;
      }

      this.setStatus('live');
      this.rateWindowStart = performance.now();
      this.nextDueAt = 0;
      this.scheduleNext();
    } catch (err) {
      console.error('[hands] start failed', err);
      this.fail('Hand tracking failed — using keyboard (WASD)');
    }
  }

  private async createLandmarker(): Promise<HandLandmarker> {
    // Dynamic import keeps the ~150kB tasks-vision bundle out of the game's
    // first chunk and turns a load failure into a catchable rejection.
    const { FilesetResolver, HandLandmarker: HandLandmarkerClass } = await import('@mediapipe/tasks-vision');
    this.fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
    // Cached for retryWithCpu() — a runtime GPU failure re-uses the already
    // resolved wasm fileset and module instead of re-fetching either.
    this.HandLandmarkerClass = HandLandmarkerClass;
    try {
      const lm = await this.makeLandmarker('GPU');
      this.delegate = 'GPU';
      return lm;
    } catch (err) {
      // No WebGL2 / blocklisted GPU: CPU (wasm SIMD) is slower but works.
      console.warn('[hands] GPU delegate unavailable, falling back to CPU', err);
      const lm = await this.makeLandmarker('CPU');
      this.delegate = 'CPU';
      return lm;
    }
  }

  private makeLandmarker(delegate: 'GPU' | 'CPU'): Promise<HandLandmarker> {
    return this.HandLandmarkerClass!.createFromOptions(this.fileset!, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: 'VIDEO',
      numHands: 2,
    });
  }

  // §stage2 review fix: a GPU delegate that loaded fine can still throw from
  // detectForVideo at runtime (driver quirks, context loss) — that used to go
  // straight to `fail()` and strand the player on keyboard even though CPU
  // decoding would have kept hands working, just slower. One retry, then fail
  // for real if CPU doesn't work either.
  private async retryWithCpu() {
    this.retryingWithCpu = true;
    try {
      this.landmarker?.close();
    } catch {
      // already torn down
    }
    this.landmarker = null;
    try {
      this.landmarker = await this.makeLandmarker('CPU');
      this.delegate = 'CPU';
      this.scheduleNext();
    } catch (err) {
      console.error('[hands] CPU retry failed', err);
      this.fail('Hand tracking stopped — using keyboard (WASD)');
    }
  }

  private fail(message: string) {
    if (this.status === 'failed') return;
    this.stopLoop();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    try {
      this.landmarker?.close();
    } catch {
      // already torn down
    }
    this.landmarker = null;
    this.setStatus('failed', message);
  }

  private stopLoop() {
    this.loopToken++;
    if (this.pendingRvfc !== null && 'cancelVideoFrameCallback' in this.video) {
      this.video.cancelVideoFrameCallback(this.pendingRvfc);
    }
    if (this.pendingTimer !== null) window.clearTimeout(this.pendingTimer);
    this.pendingRvfc = null;
    this.pendingTimer = null;
  }

  private scheduleNext() {
    this.stopLoop();
    if (this.status !== 'live') return;
    const token = this.loopToken;
    const run = () => {
      if (token !== this.loopToken) return;
      this.onFrame();
    };
    if ('requestVideoFrameCallback' in this.video) {
      this.pendingRvfc = this.video.requestVideoFrameCallback(run);
    }
    // rVFC can stop firing for a video the browser decides isn't being
    // composited; a timer keeps the loop alive regardless (whichever fires
    // first wins). §stage2 review fix: this used to be a fixed 250ms (4Hz) —
    // far below even the LOW 20Hz target, so a tab that lost rVFC (backgrounded,
    // or a browser that just doesn't support it) silently detected 8x slower
    // than intended instead of matching whatever rate onFrame is targeting.
    this.pendingTimer = window.setTimeout(run, 1000 / this.targetHz);
  }

  private onFrame() {
    if (this.status !== 'live' || !this.landmarker) return;
    const now = performance.now();
    const video = this.video;
    const newFrame = video.currentTime !== this.lastVideoTime;
    // Rate limiting against the camera's own cadence: a 30fps camera at a 20Hz
    // target detects on a 2-1-2-1 frame pattern rather than every other frame.
    if (newFrame && video.readyState >= 2 && !document.hidden && now >= this.nextDueAt - 8) {
      const interval = 1000 / this.targetHz;
      this.nextDueAt = Math.max(this.nextDueAt + interval, now + interval * 0.5);
      this.lastVideoTime = video.currentTime;
      let result: HandLandmarkerResult;
      const t0 = performance.now();
      try {
        result = this.landmarker.detectForVideo(video, t0);
      } catch (err) {
        // §stage2 review fix: a GPU delegate can throw at runtime (driver
        // reset, context loss) even though it loaded fine — that used to fail
        // straight to keyboard. Retry once with CPU before giving up.
        if (this.delegate === 'GPU' && !this.retryingWithCpu) {
          console.warn('[hands] detectForVideo failed on GPU, retrying once on CPU', err);
          void this.retryWithCpu();
          return;
        }
        console.error('[hands] detectForVideo failed', err);
        this.fail('Hand tracking stopped — using keyboard (WASD)');
        return;
      }
      const t1 = performance.now();
      this.retryingWithCpu = false; // a clean detect means the retry (if any) actually worked
      this.recordCost(t1 - t0, t1);
      this.emit({ t: t1, hands: toRawHands(result), videoW: video.videoWidth || 640, videoH: video.videoHeight || 480 });
    }
    this.scheduleNext();
  }

  private recordCost(ms: number, now: number) {
    this.detectionCount++;
    this.rateWindowCount++;
    if (now - this.rateWindowStart >= 1000) {
      this.measuredHz = (this.rateWindowCount * 1000) / (now - this.rateWindowStart);
      this.rateWindowStart = now;
      this.rateWindowCount = 0;
    }
    if (this.detectionCount <= WARMUP_DETECTIONS) return;
    this.detectCosts.push(ms);
    if (this.detectCosts.length > DETECT_AVG_WINDOW) this.detectCosts.shift();
    this.detectMs = this.detectCosts.reduce((a, b) => a + b, 0) / this.detectCosts.length;
    if (this.detectCosts.length >= 10) {
      if (this.targetHz === RATE_HIGH_HZ && this.detectMs > SLOW_DETECT_MS) this.targetHz = RATE_LOW_HZ;
      else if (this.targetHz === RATE_LOW_HZ && this.detectMs < FAST_DETECT_MS) this.targetHz = RATE_HIGH_HZ;
    }
  }

  private emit(d: HandDetection) {
    for (const fn of this.detectionListeners) {
      try {
        fn(d);
      } catch (err) {
        // A consumer bug must not kill the tracking loop (or the game).
        console.error('[hands] detection listener failed', err);
      }
    }
  }
}

function toRawHands(result: HandLandmarkerResult): RawHand[] {
  const hands: RawHand[] = [];
  const n = Math.min(result.landmarks.length, result.worldLandmarks.length);
  for (let i = 0; i < n; i++) {
    const label = result.handedness[i]?.[0]?.categoryName === 'Left' ? 'Left' : 'Right';
    hands.push({ landmarks: result.landmarks[i], worldLandmarks: result.worldLandmarks[i], label });
  }
  return hands;
}
