import type { ControlState } from '../input/ControlProvider';

// §v5 hand-gesture maths. Pure, DOM-free and clock-free: every function takes
// its inputs (landmarks, times in ms) explicitly, so scripts/gestures.test.ts
// can drive it with synthetic hands. HandTracker produces RawHands,
// HandProvider feeds them into a HandGestureFilter and samples it at 60Hz.
//
// Coordinate conventions. MediaPipe landmarks are in the RAW (unmirrored)
// webcam image: x 0..1 left->right as the camera sees it, y 0..1 top->down.
// Everything user-facing here works in MIRRORED space, x' = 1 - x, i.e. the
// image as the player sees themselves in the preview — so "left" always means
// the player's own left.

export const GESTURE = {
  maxSteerDeg: 45, // wheel tilt that maps to full lock
  deadzoneDeg: 3, // tilt ignored around level, rescaled so steer is continuous
  steerTauMs: 55, // EMA time constant for the steering value at 60Hz sample time
  lostHoldMs: 300, // one/both hands gone: hold the last steer this long...
  lostTauMs: 150, // ...then ease it back to centre with this time constant
  throttleHoldMs: 300, // every hand gone: hold the last combined throttle/brake this long before coasting (matches lostHoldMs)
  staleMs: 500, // no detection at all for this long counts as "no hands"
  // Hand-openness thresholds, measured on MediaPipe's real world-landmark
  // fixtures (scripts/gestures.test.ts embeds them): fist 0.30, thumb-up
  // 0.27, pointing-up 0.48, victory 0.77, a single finger extended
  // 1.11-1.21 — a genuinely open hand sits around 1.1-1.2.
  // v6 mapping: closed FISTS = GAS, OPEN hands = BRAKE / reverse. Each
  // visible hand is classified on its own with this hysteresis;
  // HandGestureFilter.sample() combines them (all fist -> gas, all open ->
  // brake, anything else -> coast).
  openAbove: 0.85, // openness ratio above which a hand is open (brake)
  fistBelow: 0.55, // ...below which it is a fist (gas); between = keep previous
  // Thumbs-up BOOST (either hand): thumbExtension() = thumb tip (4) distance
  // from the palm centre (mean of 0/5/9/13/17), in palm lengths |0-9|.
  // Measured on the same real fixtures: fist 0.53, pointing-up 0.50,
  // victory 0.54, thumb-up 1.04 — a ~0.5 gap, the best separation of the
  // thumb metrics tried (thumb tip -> index MCP |4-5| only separates fist
  // 0.41 from thumb-up 0.65). Engage sits 0.26 above the highest curled-hand
  // reading and 0.24 below the thumb-up fixture; release leaves 0.15 of
  // hysteresis. Only counts on a hand whose fingers read as a fist
  // (openness < fistBelow): an open hand's thumb sticks out too (0.8-1.3 on
  // relaxed open hands), and that's a brake, not a boost. The old left-hand
  // pinch is gone: a gripping fist puts the thumb tip on the index finger,
  // so it would fire constantly under fists = gas.
  thumbUpEngage: 0.8,
  thumbUpRelease: 0.65,
  thumbDebounceMs: 250, // guards a jittery re-engage of the SAME flick; the kart owns the real 2.5s cooldown (TUNING.boostCooldown)
  calibrationMaxDeg: 20, // theta0 clamp, so a bad calibration can't bias steering past this
};


const DEG = Math.PI / 180;

export interface Vec2 {
  x: number;
  y: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

// One hand exactly as MediaPipe reports it, minus the parts we don't use.
export interface RawHand {
  landmarks: Vec2[]; // 21 normalized image coords, raw (unmirrored) image
  worldLandmarks: Vec3[]; // 21 metric coords (metres), origin near the hand's centre
  label: 'Left' | 'Right'; // MediaPipe handedness categoryName
}

export interface AssignedHands {
  left: RawHand | null;
  right: RawHand | null;
}

// Landmark indices used below (MediaPipe hand model).
const WRIST = 0;
const THUMB_TIP = 4;
const MIDDLE_MCP = 9;
const PALM_POINTS = [0, 5, 9, 13, 17];
const FINGER_TIPS = [8, 12, 16, 20];

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function dist3(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export function mirrorX(x: number): number {
  return 1 - x;
}

export function isUsableHand(h: RawHand | null | undefined): h is RawHand {
  return !!h && h.landmarks.length >= 21 && h.worldLandmarks.length >= 21;
}

// Which detected hand is the player's left and which the right.
// Two hands: whichever wrist is further left in the MIRRORED image is the left
// hand — geometric, so it can't be fooled by a handedness misclassification,
// which MediaPipe does make when palms face away or hands overlap.
// One hand: fall back to MediaPipe's label, FLIPPED. MediaPipe's handedness
// assumes a mirrored (selfie) input; we feed it the raw unmirrored webcam
// frame, so it reports the player's physical left hand as "Right". (Checked
// against the docs' "input image is mirrored" note; if a hand ever steers the
// wrong way solo, this flip is the first thing to re-verify on a real camera.)
export function assignHands(hands: RawHand[]): AssignedHands {
  const usable = hands.filter(isUsableHand);
  if (usable.length >= 2) {
    const [a, b] = usable;
    const ax = mirrorX(a.landmarks[WRIST].x);
    const bx = mirrorX(b.landmarks[WRIST].x);
    return ax <= bx ? { left: a, right: b } : { left: b, right: a };
  }
  if (usable.length === 1) {
    const h = usable[0];
    return h.label === 'Right' ? { left: h, right: null } : { left: null, right: h };
  }
  return { left: null, right: null };
}

// Wheel angle from the two wrists, radians. Positive = right hand lower =
// steer right (image y grows downward). W/H are the video's pixel dimensions:
// normalized coords squash a 16:9 frame, so without them a tilt reads steeper
// or shallower than the player's hands actually are.
export function wheelAngle(left: Vec2, right: Vec2, videoW: number, videoH: number): number {
  const dx = (mirrorX(right.x) - mirrorX(left.x)) * videoW;
  const dy = (right.y - left.y) * videoH;
  return Math.atan2(dy, dx);
}

// Wheel angle (relative to the calibrated level) -> steer -1..1. The deadzone
// is subtracted rather than just clipped, so steer rises from 0 at exactly
// 3deg instead of jumping to 0.07.
export function steerFromAngle(theta: number, theta0 = 0): number {
  const max = GESTURE.maxSteerDeg * DEG;
  const dz = GESTURE.deadzoneDeg * DEG;
  const d = clamp(theta - theta0, -max, max);
  const past = Math.abs(d) - dz;
  return past <= 0 ? 0 : (Math.sign(d) * past) / (max - dz);
}

// Frame-rate independent exponential smoothing step.
export function emaStep(current: number, target: number, dtMs: number, tauMs: number): number {
  if (dtMs <= 0) return current;
  return current + (target - current) * (1 - Math.exp(-dtMs / tauMs));
}

export function palmLength(world: Vec3[]): number {
  return dist3(world[WRIST], world[MIDDLE_MCP]);
}

function palmCentre(world: Vec3[]): Vec3 {
  const c = { x: 0, y: 0, z: 0 };
  for (const i of PALM_POINTS) {
    c.x += world[i].x;
    c.y += world[i].y;
    c.z += world[i].z;
  }
  c.x /= PALM_POINTS.length;
  c.y /= PALM_POINTS.length;
  c.z /= PALM_POINTS.length;
  return c;
}

// Mean fingertip distance from the palm centre, in palm lengths: a real open
// hand ~1.1-1.2, a fist ~0.3. Uses worldLandmarks (metres) so it doesn't
// change with the hand's distance from the camera or its angle in the image.
// Fingertips 8/12/16/20 only — the thumb is deliberately left out, so a
// thumbs-up still reads as a fist (keeps the gas on while boosting).
// NaN if degenerate.
export function handOpenness(world: Vec3[]): number {
  const len = palmLength(world);
  if (!(len > 1e-6)) return NaN;
  const c = palmCentre(world);
  let sum = 0;
  for (const i of FINGER_TIPS) sum += dist3(world[i], c);
  return sum / FINGER_TIPS.length / len;
}

export type Openness = 'open' | 'fist' | 'unknown';

// Hysteresis: only a crossing of the *far* threshold changes state, so a hand
// hovering around one boundary can't flicker between gas and brake.
export function classifyOpenness(r: number, prev: Openness): Openness {
  if (!Number.isFinite(r)) return prev;
  if (r > GESTURE.openAbove) return 'open';
  if (r < GESTURE.fistBelow) return 'fist';
  return prev;
}

// Thumb tip distance from the palm centre, in palm lengths: tucked against a
// fist ~0.5, a thumbs-up ~1.0. NaN if degenerate.
export function thumbExtension(world: Vec3[]): number {
  const len = palmLength(world);
  if (!(len > 1e-6)) return NaN;
  return dist3(world[THUMB_TIP], palmCentre(world)) / len;
}

export interface ThumbState {
  armed: boolean; // seen as a fist with the thumb tucked since the last fire
  engaged: boolean; // thumb out (with hysteresis)
  lastFireAt: number; // ms; -Infinity = never
}

export const INITIAL_THUMB: ThumbState = { armed: false, engaged: false, lastFireAt: -Infinity };

// Thumbs-up flick for one hand. `r` is that hand's openness, `x` its
// thumbExtension. `fire` is true only on the thumb's engage edge, and only
// when:
//  - the fingers are curled (r < fistBelow) — an open hand is a brake, and
//    its thumb is naturally out;
//  - the hand was ARMED: seen as a fist with the thumb tucked (x below the
//    release line) since the last edge. This is what makes it a *flick* out
//    of a fist, and it stops a hand closing from open -> fist (fingers curl a
//    frame or two before the thumb tucks in) from reading as a thumbs-up;
//  - thumbDebounceMs has passed since this hand last fired, so a jittery
//    re-classification of the same flick can't refire it.
// The kart (physics/Kart.ts) owns the 2.5s boost cooldown; every input source
// reports its rising edges honestly and the kart decides whether to honor one.
export function stepThumb(state: ThumbState, r: number, x: number, now: number): { state: ThumbState; fire: boolean } {
  if (!Number.isFinite(r) || !Number.isFinite(x)) return { state, fire: false };
  const curled = r < GESTURE.fistBelow;
  let engaged = state.engaged;
  if (engaged && x < GESTURE.thumbUpRelease) engaged = false;
  else if (!engaged && x > GESTURE.thumbUpEngage) engaged = true;
  const edge = engaged && !state.engaged;
  const fire = edge && curled && state.armed && now - state.lastFireAt >= GESTURE.thumbDebounceMs;
  let armed = state.armed;
  if (!curled || edge) armed = false; // opening the hand, or any thumb-out edge, disarms
  else if (!engaged) armed = true; // a tucked fist arms the next flick
  return { state: { armed, engaged, lastFireAt: fire ? now : state.lastFireAt }, fire };
}


export interface SteerDetection {
  t: number; // ms
  s: number; // steer target -1..1 at that detection
}

// Steering while one or both hands are missing: hold the smoothed value for
// lostHoldMs (a detection dropout of a frame or two is invisible), then ease
// it back to centre.
export function lostSteer(sf: number, lostForMs: number, dtMs: number): number {
  if (lostForMs < GESTURE.lostHoldMs) return sf;
  return emaStep(sf, 0, dtMs, GESTURE.lostTauMs);
}

export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Calibrated "level" wheel angle: the median of the hold window (robust to a
// few jittery frames), clamped so a player who calibrated with a wild tilt
// still has most of the steering range.
export function calibrationTheta0(thetas: number[]): number {
  const m = median(thetas);
  if (!Number.isFinite(m)) return 0;
  const lim = GESTURE.calibrationMaxDeg * DEG;
  return clamp(m, -lim, lim);
}

// One visible hand's live readings, for the overlay and diagnostics.
export interface HandReading {
  r: number; // openness ratio
  thumb: number; // thumbExtension ratio
  state: Openness; // hysteresis-classified open/fist
}

// Per-detection summary exposed to the overlay/calibration/diagnostics.
export interface DetectionSummary {
  t: number;
  hands: AssignedHands;
  theta: number | null; // raw wheel angle (uncalibrated), null unless both hands
  left: HandReading | null;
  right: HandReading | null;
}

interface HandSlot {
  openness: Openness;
  thumb: ThumbState;
}

// The whole hand -> ControlState pipeline as one deterministic state machine.
// onDetection() at detection rate, sample() once per physics tick; time is
// always passed in, never read.
//
// Mapping (v6): steer = wheel tilt between the wrists; GAS = every visible
// hand a fist; BRAKE (reverse near standstill, via the physics) = every
// visible hand open; mixed/unknown = coast; BOOST = thumbs-up flick on either
// hand. Hands never drift — drift=0 always; drift stays a keyboard/phone
// input.
export class HandGestureFilter {
  theta0 = 0;
  lastDetection: DetectionSummary | null = null;
  // Smoothed steer — also what the overlay's wheel icon shows.
  sf = 0;
  lastControl: ControlState = { steer: 0, throttle: 0, brake: 0, drift: 0, boost: 0 };
  // §defect-fix: `lastControl.boost` is a one-sample edge — true only on the
  // single sample() call that consumes pendingBoost, then back to 0. The
  // physics loop can run 2+ fixed steps per render frame, so a UI reading
  // lastControl once per render frame (HandOverlay's BOOST pill) can land
  // between two samples and read the OFF one, missing the flick entirely.
  // This timestamp instead only ever moves forward when a boost actually
  // fires, so a once-per-render-frame reader can't miss it by polling at the
  // wrong instant — it just compares this against the last value it saw.
  boostFiredAt = -Infinity;

  private lastSteer: SteerDetection | null = null;
  private lastBothAt = -Infinity;
  private lastSampleAt: number | null = null;
  private slots: { left: HandSlot; right: HandSlot } = {
    left: { openness: 'unknown', thumb: INITIAL_THUMB },
    right: { openness: 'unknown', thumb: INITIAL_THUMB },
  };
  private pendingBoost = false;
  // The combined throttle/brake, held briefly across an all-hands dropout —
  // see sample() below.
  private lastHandAt = -Infinity;
  private heldThrottle: 0 | 1 = 0;
  private heldBrake: 0 | 1 = 0;

  onDetection(t: number, rawHands: RawHand[], videoW: number, videoH: number): DetectionSummary {
    const hands = assignHands(rawHands);
    let theta: number | null = null;
    if (hands.left && hands.right) {
      theta = wheelAngle(hands.left.landmarks[WRIST], hands.right.landmarks[WRIST], videoW, videoH);
      const s = steerFromAngle(theta, this.theta0);
      // The EMA in sample() does all the smoothing between detections; the
      // target it chases is simply the latest detection.
      this.lastSteer = { t, s };
      this.lastBothAt = t;
    }

    const read = (hand: RawHand | null, slot: HandSlot): HandReading | null => {
      if (!hand) {
        // Hand gone: no gas/brake opinion, and no carried-over state, so a
        // returning hand is judged fresh against the thresholds. The thumb
        // state is left untouched: a one-frame dropout mid-thumbs-up must not
        // turn the same flick into a second edge.
        slot.openness = 'unknown';
        return null;
      }
      const r = handOpenness(hand.worldLandmarks);
      const thumb = thumbExtension(hand.worldLandmarks);
      slot.openness = classifyOpenness(r, slot.openness);
      const step = stepThumb(slot.thumb, r, thumb, t);
      slot.thumb = step.state;
      if (step.fire) this.pendingBoost = true;
      return { r, thumb, state: slot.openness };
    };
    const left = read(hands.left, this.slots.left);
    const right = read(hands.right, this.slots.right);
    if (left || right) this.lastHandAt = t;

    this.lastDetection = { t, hands, theta, left, right };
    return this.lastDetection;
  }

  // Were any hands seen within `withinMs` of `now`?
  handsSeen(now: number, withinMs: number): boolean {
    const d = this.lastDetection;
    return !!d && now - d.t <= withinMs && (d.hands.left !== null || d.hands.right !== null);
  }

  sample(now: number): ControlState {
    const dt = this.lastSampleAt === null ? 0 : clamp(now - this.lastSampleAt, 0, 100);
    this.lastSampleAt = now;

    const d = this.lastDetection;
    const fresh = d !== null && now - d.t <= GESTURE.staleMs;
    const left = fresh ? d.hands.left : null;
    const right = fresh ? d.hands.right : null;

    if (left && right && this.lastSteer) {
      this.sf = emaStep(this.sf, this.lastSteer.s, dt, GESTURE.steerTauMs);
    } else {
      this.sf = lostSteer(this.sf, now - this.lastBothAt, dt);
    }

    // Every visible hand votes; only a unanimous vote does anything.
    const votes: Openness[] = [];
    if (left) votes.push(this.slots.left.openness);
    if (right) votes.push(this.slots.right.openness);
    let throttle: 0 | 1 = 0;
    let brake: 0 | 1 = 0;
    if (votes.length > 0) {
      if (votes.every((v) => v === 'fist')) throttle = 1;
      else if (votes.every((v) => v === 'open')) brake = 1;
      this.heldThrottle = throttle;
      this.heldBrake = brake;
    } else if (now - this.lastHandAt < GESTURE.throttleHoldMs) {
      // Every hand gone for a detection or two (grazing the edge of the
      // camera): hold the last combined state briefly rather than cutting
      // the gas mid-corner — the same idea as lostSteer for steering.
      throttle = this.heldThrottle;
      brake = this.heldBrake;
    } else {
      this.heldThrottle = 0;
      this.heldBrake = 0;
    }

    const boost: 0 | 1 = this.pendingBoost ? 1 : 0;
    this.pendingBoost = false;
    if (boost) this.boostFiredAt = now;

    this.lastControl = { steer: this.sf, throttle, brake, drift: 0, boost };
    return this.lastControl;
  }
}
