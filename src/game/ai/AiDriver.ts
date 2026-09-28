import { TUNING } from '../tuning';
import { angleWrap, clamp } from '../../shared/mathUtils';
import type { TrackSample } from '../track/TrackBuilder';
import { sampleAtArcLength } from '../track/TrackQuery';
import type { KartState } from '../physics/Kart';
import type { ControlState } from '../input/InputSource';

const STUCK_SPEED_THRESHOLD = 2;
const STUCK_SECONDS = 2;
const WALL_SCRAPE_SECONDS = 3;
const CURVATURE_LOOKAHEAD_M = 18;
const CORNER_BRAKE_THRESHOLD = 14;
const DRIFT_ENTER_ANGLE = 0.5;
const DRIFT_EXIT_ANGLE = 0.15;

export interface AiState {
  lane: number; // fixed line preference, one of {-2, -0.7, 0.7, 2}
  jitter: number; // fixed per-kart personality: +-aiTopSpeedJitter
  stuckTimer: number;
  wallScrapeTimer: number;
  driftHeld: boolean;
}

export function createAiState(lane: number): AiState {
  return {
    lane,
    jitter: (Math.random() * 2 - 1) * TUNING.aiTopSpeedJitter,
    stuckTimer: 0,
    wallScrapeTimer: 0,
    driftHeld: false,
  };
}

export interface AiThinkResult {
  control: ControlState;
  topSpeedScale: number;
  // §v5 review #1: true when this call teleported the kart (stuck/wall-scrape
  // recovery). The caller must re-plant it with Airborne.groundKart — the
  // recovery pose copies the centreline's height, which on a banked road is
  // not the ground under the lane it lands in.
  teleported: boolean;
}

// §3.4. Produces a ControlState (fed through the identical Kart.stepKart as
// the player) plus a topSpeedScale for rubber-banding. May directly mutate
// `kart` for stuck/wall-scrape recovery (a teleport, not a control input).
export function think(
  ai: AiState,
  kart: KartState,
  sNow: number,
  lateral: number,
  onWall: boolean,
  samples: TrackSample[],
  totalLength: number,
  aiProgress: number,
  playerProgress: number,
  dt: number,
): AiThinkResult {
  const T = TUNING;

  // 6. Stuck / wall-scrape recovery (checked first: a teleport pre-empts everything else this tick).
  if (Math.abs(kart.speed) < STUCK_SPEED_THRESHOLD) ai.stuckTimer += dt;
  else ai.stuckTimer = 0;
  if (onWall) ai.wallScrapeTimer += dt;
  else ai.wallScrapeTimer = 0;

  let teleported = false;
  if (ai.stuckTimer > STUCK_SECONDS || ai.wallScrapeTimer > WALL_SCRAPE_SECONDS) {
    const recoverySample = sampleAtArcLength(samples, totalLength, sNow);
    kart.pos.copy(recoverySample.pos).addScaledVector(recoverySample.right, ai.lane);
    kart.heading = Math.atan2(recoverySample.forward.x, recoverySample.forward.z);
    kart.speed = 5;
    ai.stuckTimer = 0;
    ai.wallScrapeTimer = 0;
    teleported = true;
  }

  // 1. Lookahead target
  const lookaheadDist = T.aiLookaheadBase + Math.abs(kart.speed) * T.aiLookaheadPerSpeed;
  const targetSample = sampleAtArcLength(samples, totalLength, sNow + lookaheadDist);
  const target = targetSample.pos.clone().addScaledVector(targetSample.right, ai.lane);

  // 2. Steering
  const toTarget = target.clone().sub(kart.pos);
  const angleToTarget = angleWrap(Math.atan2(toTarget.x, toTarget.z) - kart.heading);
  const steer = clamp(angleToTarget * 2.2, -1, 1);

  // 3. Throttle/brake via curvature ahead
  const currentSample = sampleAtArcLength(samples, totalLength, sNow);
  const curvatureSample = sampleAtArcLength(samples, totalLength, sNow + CURVATURE_LOOKAHEAD_M);
  const cornerAngle = Math.abs(
    angleWrap(
      Math.atan2(curvatureSample.forward.x, curvatureSample.forward.z) -
        Math.atan2(currentSample.forward.x, currentSample.forward.z),
    ),
  );
  const tightAndFast = cornerAngle * Math.abs(kart.speed) > CORNER_BRAKE_THRESHOLD;

  // 4. Drift (hysteresis between enter/exit angle so it doesn't chatter)
  if (!ai.driftHeld && cornerAngle > DRIFT_ENTER_ANGLE && Math.abs(kart.speed) > T.driftMinSpeed + 3) {
    ai.driftHeld = true;
  } else if (ai.driftHeld && (
    cornerAngle < DRIFT_EXIT_ANGLE ||
    // A long horseshoe can stay curved after the kart has already rotated
    // onto its exit line. Release before a fixed-direction drift overshoots
    // that line, including when a switchback asks for opposite steering.
    (kart.drift.phase === 'active' && angleToTarget * kart.drift.dir < 0.12)
  )) {
    ai.driftHeld = false;
  }

  // 5. Rubber-banding: only affects the cruise speed cap, never physics constants.
  const delta = playerProgress - aiProgress; // >0: AI behind, <0: AI ahead
  const band =
    delta > 0
      ? 1 + T.rubberBandBehind * clamp(delta / T.rubberBandRange, 0, 1)
      : 1 + T.rubberBandAhead * clamp(-delta / T.rubberBandRange, 0, 1);
  const topSpeedScale = (1 + ai.jitter) * band;

  return {
    control: {
      steer,
      throttle: tightAndFast ? 0 : 1,
      brake: tightAndFast ? 1 : 0,
      drift: ai.driftHeld ? 1 : 0,
      boost: 0, // §v5: AI never manual-boosts; pads and drift releases still boost it
    },
    topSpeedScale,
    teleported,
  };
}
