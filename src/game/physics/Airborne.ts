import { TUNING } from '../tuning';
import type { KartState } from './Kart';

// §v5 jump: the kart's vertical state. Physics stays 2D-projected — stepKart
// never reads or writes pos.y — and this is the one place height is
// integrated, called once per kart per tick after x/z (and both collision
// passes) have settled, with the ground height under the kart's final x/z.
//
// Grounded, the kart sits exactly on the ground and `vy` tracks how fast the
// ground under it is rising or falling. It leaves the ground when the ground
// drops away faster than gravity could pull it down to follow: each tick the
// ballistic prediction (y + vy*dt - g*dt²/2) is compared with the new ground
// height, and a gap bigger than TAKEOFF_MARGIN means the kart is now in the
// air. That is exactly what happens at the ramp lip (the ground falls ~2.5m
// into the rail cutting in one sample) and never on the circuit's smooth
// crests, whose vertical curvature is far below g/v² at race speed — so no
// per-track "jump here" flag is needed, and a future lip anywhere just works.
//
// Airborne, it follows a plain parabola under TUNING.gravity and lands the
// first tick it would pass below the ground.

export type AirEvent = 'takeoff' | 'land';

// Metres the ground must fall *below* the ballistic prediction in a single
// tick to count as a takeoff. Large enough that per-sample grade changes and
// banking under a kart moving sideways never register (they are millimetres
// per tick), small enough that the rail-crossing lip always does.
const TAKEOFF_MARGIN = 0.08;
// Clamp on the grounded vertical velocity. The real ground never rises or
// falls faster than ~10 m/s (steepest ramp x boost speed); the clamp exists
// so a *teleport* (AI recovery, race reset) can't turn one tick's height
// change into a huge vy that launches the kart on the next tick.
const MAX_GROUND_VY = 12;
// §v5 review #1: grounded vy is also capped relative to how fast the kart is
// actually moving over the ground. The steepest surface a kart is meant to
// be carried up is the kicker's face (slope 0.25 at the lip, ~0.23 between
// its last two samples); anything steeper under a grounded kart — reversing
// up the rail cutting's wall, being shoved sideways across a bank by a wall
// or another kart — must not bank vertical speed it can then carry off the
// next crest. 0.3 leaves the forward jump untouched and keeps the reverse
// crest over the lip (wall 0.65 up, ramp 0.25 down) below TAKEOFF_MARGIN.
const MAX_GROUND_SLOPE = 0.3;
// §v5 review #1: the ground rising more than this under a grounded kart in
// one tick is a step (a teleport's leftover height error, a corridor seam),
// not a slope: the kart is snapped onto it with no vertical speed rather
// than turning the step into vy. Only upward — a sudden *drop* this size is
// exactly the jump lip, which has to become a takeoff.
const SNAP_STEP = 0.25;

export function stepVertical(kart: KartState, groundY: number, dt: number): AirEvent | null {
  const g = TUNING.gravity;
  if (kart.airborne) {
    kart.airTime += dt;
    kart.vy -= g * dt;
    kart.pos.y += kart.vy * dt;
    if (kart.pos.y <= groundY) {
      kart.pos.y = groundY;
      kart.airborne = false;
      kart.landingVy = kart.vy;
      kart.vy = 0;
      return 'land';
    }
    return null;
  }

  if (groundY - kart.pos.y > SNAP_STEP) {
    kart.pos.y = groundY;
    kart.vy = 0;
    return null;
  }

  const ballisticY = kart.pos.y + kart.vy * dt - 0.5 * g * dt * dt;
  if (groundY < ballisticY - TAKEOFF_MARGIN) {
    kart.airborne = true;
    kart.airTime = 0;
    kart.vy -= g * dt;
    kart.pos.y = ballisticY;
    return 'takeoff';
  }
  const maxVy = Math.min(MAX_GROUND_VY, (Math.abs(kart.speed) + Math.abs(kart.velLateral)) * MAX_GROUND_SLOPE);
  kart.vy = Math.max(-maxVy, Math.min(maxVy, (groundY - kart.pos.y) / dt));
  kart.pos.y = groundY;
  return null;
}

// §v5 review #4: the grade the kart *visual* should pitch to. On the ground
// it is the road's (the nearest sample's forward.y); in the air the kart
// follows its own flight path, not the rail cutting passing beneath it —
// sin of the climb angle, signed for the kart's nose (a kart flying
// backwards pitches the other way), with a floor on the horizontal speed so
// a near-stationary drop doesn't stand the kart on its nose.
const AIR_PITCH_MIN_SPEED = 6;
const AIR_PITCH_MAX_GRADE = 0.5;
export function visualGrade(kart: KartState, groundGrade: number): number {
  if (!kart.airborne) return groundGrade;
  const horizontal = Math.max(Math.abs(kart.speed), AIR_PITCH_MIN_SPEED);
  const sin = (kart.vy / Math.hypot(kart.vy, horizontal)) * (kart.speed < 0 ? -1 : 1);
  return Math.max(-AIR_PITCH_MAX_GRADE, Math.min(AIR_PITCH_MAX_GRADE, sin));
}

// For resets/teleports: plant the kart on the ground with no vertical motion.
export function groundKart(kart: KartState, groundY: number) {
  kart.pos.y = groundY;
  kart.vy = 0;
  kart.airborne = false;
  kart.airTime = 0;
}
