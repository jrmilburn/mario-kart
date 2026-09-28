import { ParticlePool } from './ParticlePool';

// §v5 Effects: drift sparks. Upgraded from the §Phase 11a single-point burst
// (one grey/blue/orange/purple PointsMaterial dot stream from the kart's
// centre) to a pair of tyre-contact fountains whose colour AND vigour climb
// with how long the drift has been held — the thing a player reads to time
// the release:
//   tier 0 (charging)  blue-white, a thin trickle
//   tier 1             yellow
//   tier 2             orange
//   tier 3             pink/purple, the fattest, fastest spray
// Colours are HDR (> 1) and additive, so in High quality they bloom (PostFX);
// tier 0 is kept just under the bloom threshold's knee so a fresh drift
// doesn't flare — the glow arriving IS the "tier 1 reached" cue.
//
// Emission is time-based (sparks per second, fractional carry per kart), not
// per-frame, so the stream is the same density at 60Hz and 144Hz.

// Linear RGB, pre-multiplied by the bloom drive.
const TIER_RGB: readonly (readonly [number, number, number])[] = [
  [0.62, 0.8, 1.05], // 0 blue-white
  [2.4, 1.85, 0.35], // 1 yellow
  [2.9, 1.05, 0.18], // 2 orange
  [2.6, 0.55, 2.9], // 3 pink/purple
];
const TIER_RATE = [50, 80, 100, 130]; // sparks per second, per wheel
const TIER_SIZE = [0.12, 0.16, 0.19, 0.24]; // metres
const TIER_SPEED = [2.2, 3, 3.6, 4.4]; // m/s, spray speed off the tyre

export class DriftSparks {
  readonly pool = new ParticlePool({
    capacity: 900,
    additive: true,
    gravity: 11,
    drag: 2.5,
    envelope: 'spark',
    falloff: 'hot',
    name: 'drift-sparks',
  });
  private readonly carry: Float32Array;

  constructor(maxKarts: number) {
    this.carry = new Float32Array(maxKarts);
  }

  get points() {
    return this.pool.points;
  }

  // One frame of sparks for kart `k`, drifting toward `dir` (+1/-1) at
  // `tier`. The two contact points are (x0,z0)/(x1,z1) at height `y`;
  // (fx,fz) is the kart's forward and (rx,rz) its right, both unit, and
  // (vx,vz) the kart's own velocity so the spray is thrown from a moving tyre.
  emit(
    k: number,
    dt: number,
    tier: number,
    dir: number,
    x0: number,
    z0: number,
    x1: number,
    z1: number,
    y: number,
    fx: number,
    fz: number,
    rx: number,
    rz: number,
    vx: number,
    vz: number,
  ) {
    const t = Math.max(0, Math.min(3, tier));
    this.carry[k] += TIER_RATE[t] * dt;
    const n = Math.floor(this.carry[k]);
    this.carry[k] -= n;
    const [cr, cg, cb] = TIER_RGB[t];
    const speed = TIER_SPEED[t];
    const size = TIER_SIZE[t];
    for (let i = 0; i < n; i++) {
      for (let w = 0; w < 2; w++) {
        const px = w === 0 ? x0 : x1;
        const pz = w === 0 ? z0 : z1;
        // Thrown back off the tyre and out to the drift's outside, with a
        // hop up; the kart's own velocity is mostly inherited so the spray
        // trails the kart instead of hanging in the air behind it.
        const back = speed * (0.6 + Math.random() * 0.6);
        const side = (dir * 0.7 + (Math.random() - 0.5) * 1.6) * speed * 0.55;
        const up = speed * (0.35 + Math.random() * 0.55);
        // A little per-spark brightness jitter keeps the stream from looking
        // like a solid tube.
        const j = 0.7 + Math.random() * 0.5;
        this.pool.spawn(
          px + (Math.random() - 0.5) * 0.12,
          y + Math.random() * 0.05,
          pz + (Math.random() - 0.5) * 0.12,
          vx * 0.85 - fx * back + rx * side,
          up,
          vz * 0.85 - fz * back + rz * side,
          cr * j,
          cg * j,
          cb * j,
          1,
          size * (0.8 + Math.random() * 0.5),
          size * 0.25,
          0.22 + Math.random() * 0.2,
        );
      }
    }
  }

  // Drops kart `k`'s fractional carry, so the next drift starts clean.
  stop(k: number) {
    this.carry[k] = 0;
  }

  setScale(scale: number) {
    this.pool.setScale(scale);
  }

  update(dt: number) {
    this.pool.update(dt);
  }

  clear() {
    this.carry.fill(0);
    this.pool.clear();
  }
}
