import * as THREE from 'three';
import { TUNING } from '../tuning';
import { driftTier, type KartState } from '../physics/Kart';
import type { TrackQuery } from '../track/TrackQuery';
import type { KartVisual } from './SceneBuilder';
import { DriftSparks } from './DriftSparks';
import { BoostTrails } from './BoostTrails';
import { ParticlePool } from './ParticlePool';
import { SpeedLines } from './SpeedLines';

// §v5 Effects: the kart juice, orchestrated in one place so main.ts only
// needs `effects.update(dt)` per frame plus a couple of hooks.
//   - drift sparks (DriftSparks.ts): tier-coloured, both rear tyres, additive
//   - boost trails (BoostTrails.ts): a glowing ribbon per exhaust outlet
//   - dust (a ParticlePool here): rear-tyre puffs on grass/sand/dirt, and a
//     ring burst when a kart lands off the jump (landingPuff)
//   - speed lines (SpeedLines.ts): per-viewport, set just before each view
//     renders (setView)
// Every effect is a fixed pool and ONE draw call however many karts use it,
// and the per-frame path allocates nothing (scalar maths on the kart state —
// no kartForward()/clone(), which would each return a new Vector3).
//
// Camera shake lives on FollowCamera (addTrauma) — it is per player, and
// main.ts decides who felt a hit.

export interface EffectKart {
  kart: KartState;
  visual: KartVisual;
}

type Ground = 'road' | 'grass' | 'sand' | 'dirt';

// Dust colours (linear, deliberately a touch darker than the lit ground so a
// puff reads against it) and alpha per surface.
const DUST: Record<Exclude<Ground, 'road'>, readonly [number, number, number, number]> = {
  grass: [0.46, 0.5, 0.26, 0.42],
  sand: [0.78, 0.62, 0.38, 0.55],
  dirt: [0.44, 0.3, 0.17, 0.6],
};
const DUST_RATE = 26; // puffs/s per rear tyre at top speed
const DUST_MIN_SPEED = 4; // m/s; slower than this raises nothing
const MAX_EXHAUSTS = 4; // widest chassis has four outlets (KartBuilder's exhaust lists)
const SURFACE_SAMPLES_PER_FRAME = 2; // round-robin nearestSample queries (see update)

// Speed lines: none below ~85% of top speed, full at boost speed; a boost
// adds its own kick on top.
const LINES_FROM = 0.85;
const LINES_FULL = TUNING.boostSpeedMult;
const LINES_BOOST = 0.45;
const LINES_RATE = 6; // 1/s smoothing

export class Effects {
  private readonly sparks: DriftSparks;
  private readonly trails: BoostTrails;
  private readonly dust = new ParticlePool({
    capacity: 700,
    additive: false,
    gravity: -0.35, // a slight lift: warm air off the track
    drag: 3.2,
    envelope: 'puff',
    falloff: 'soft',
    name: 'dust',
  });
  private readonly speedLines = new SpeedLines();
  private readonly ground: Ground[];
  private readonly dustCarry: Float32Array;
  private readonly lines: Float32Array; // smoothed speed-line intensity per kart
  private surfaceCursor = 0;
  private time = 0;

  constructor(
    scene: THREE.Scene,
    private readonly trackQuery: TrackQuery,
    private readonly karts: readonly EffectKart[],
  ) {
    const n = karts.length;
    this.sparks = new DriftSparks(n);
    this.trails = new BoostTrails(n * MAX_EXHAUSTS);
    this.ground = new Array<Ground>(n).fill('road');
    this.dustCarry = new Float32Array(n);
    this.lines = new Float32Array(n);
    scene.add(this.dust.points, this.trails.mesh, this.sparks.points, this.speedLines.mesh);
  }

  // Sprite scale: ~the focal length in drawing-buffer pixels for the chase
  // camera's fov (60-76 deg -> ~0.65-0.87 x height). Call on resize.
  setBufferHeight(heightPx: number) {
    const scale = heightPx * 0.8;
    this.sparks.setScale(scale);
    this.dust.setScale(scale);
  }

  // Before rendering a view: which kart's speed lines to show (-1 = none, e.g.
  // the cinematic camera).
  setView(kartIndex: number) {
    this.speedLines.intensity = kartIndex >= 0 ? this.lines[kartIndex] : 0;
  }

  // A kart just touched down off the jump: a ring of dust out from under it,
  // bigger for a harder landing (strength ~0.6..2, as for the squash).
  landingPuff(kartIndex: number, strength: number) {
    const e = this.karts[kartIndex];
    if (!e) return;
    const k = e.kart;
    const g = this.ground[kartIndex];
    const [r, gg, b, a] = DUST[g === 'road' ? 'sand' : g];
    const count = Math.round(14 + 10 * Math.min(2, strength));
    for (let i = 0; i < count; i++) {
      const ang = (i / count) * Math.PI * 2 + Math.random() * 0.3;
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      const sp = 3 + Math.random() * 2.5 * strength;
      this.dust.spawn(
        k.pos.x + c * 0.8,
        k.pos.y + 0.15,
        k.pos.z + s * 0.8,
        c * sp + Math.sin(k.heading) * k.speed * 0.5,
        0.6 + Math.random() * 0.9,
        s * sp + Math.cos(k.heading) * k.speed * 0.5,
        r * 1.08,
        gg * 1.08,
        b * 1.08,
        Math.min(0.85, a + 0.2),
        0.4,
        1.2 + 0.4 * strength,
        0.55 + Math.random() * 0.3,
      );
    }
  }

  update(dt: number) {
    this.time += dt;
    this.speedLines.time = this.time;

    // Surface under each kart, a couple of karts per frame (nearestSample is
    // the physics' own ground query, not free): three frames' latency on a
    // dust colour is invisible, six queries every frame would not be free.
    for (let q = 0; q < SURFACE_SAMPLES_PER_FRAME; q++) {
      const i = this.surfaceCursor;
      this.surfaceCursor = (i + 1) % this.karts.length;
      this.ground[i] = this.classify(this.karts[i].kart);
    }

    this.trails.begin(dt);
    for (let i = 0; i < this.karts.length; i++) {
      const { kart, visual } = this.karts[i];
      const fx = Math.sin(kart.heading);
      const fz = Math.cos(kart.heading);
      // kartRight(): the local +x axis after the group's yaw.
      const rx = fz;
      const rz = -fx;
      const vx = fx * kart.speed + rx * kart.velLateral;
      const vz = fz * kart.speed + rz * kart.velLateral;
      const chassis = visual.chassis;
      const axleZ = chassis.rearWheels[0]?.position.z ?? -0.6;
      const half = Math.abs(chassis.frontWheelPivots[0]?.position.x ?? 0.7);
      const grounded = !kart.airborne;

      // Drift sparks from both rear contact patches.
      if (kart.drift.phase === 'active' && grounded) {
        const cx = kart.pos.x + fx * axleZ;
        const cz = kart.pos.z + fz * axleZ;
        this.sparks.emit(
          i,
          dt,
          driftTier(kart.drift.charge),
          kart.drift.dir,
          cx + rx * half,
          cz + rz * half,
          cx - rx * half,
          cz - rz * half,
          kart.pos.y + 0.06,
          fx,
          fz,
          rx,
          rz,
          vx,
          vz,
        );
      } else {
        this.sparks.stop(i);
      }

      // Boost ribbons, one per exhaust outlet — every outlet, up to
      // MAX_EXHAUSTS (a quad-pipe heavy chassis gets four). Unused slots are
      // fed as not-boosting so they fade out/idle after a character swap.
      const boosting = kart.boostTimer > 0;
      const tailZ = chassis.rearZ - 0.12;
      for (let slot = 0; slot < MAX_EXHAUSTS; slot++) {
        const ex = chassis.exhausts[slot];
        const ribbon = i * MAX_EXHAUSTS + slot;
        if (ex === undefined) {
          this.trails.feed(ribbon, false, 0, 0, 0, -fx, -fz, dt);
          continue;
        }
        this.trails.feed(
          ribbon,
          boosting,
          kart.pos.x + fx * tailZ + rx * ex,
          kart.pos.y + chassis.exhaustY,
          kart.pos.z + fz * tailZ + rz * ex,
          -fx,
          -fz,
          dt,
        );
      }

      // Dust off the rear tyres on loose ground.
      const g = this.ground[i];
      const speed = Math.abs(kart.speed);
      if (g !== 'road' && grounded && speed > DUST_MIN_SPEED) {
        const [r, gg, b, a] = DUST[g];
        const frac = Math.min(1.2, speed / TUNING.topSpeed);
        this.dustCarry[i] += DUST_RATE * frac * dt;
        const n = Math.floor(this.dustCarry[i]);
        this.dustCarry[i] -= n;
        const cx = kart.pos.x + fx * (axleZ - 0.2);
        const cz = kart.pos.z + fz * (axleZ - 0.2);
        for (let p = 0; p < n; p++) {
          for (let w = -1; w <= 1; w += 2) {
            const j = 0.85 + Math.random() * 0.3;
            this.dust.spawn(
              cx + rx * half * w + (Math.random() - 0.5) * 0.3,
              kart.pos.y + 0.12,
              cz + rz * half * w + (Math.random() - 0.5) * 0.3,
              vx * 0.25 + rx * w * (0.4 + Math.random() * 0.8),
              0.5 + Math.random() * 0.8,
              vz * 0.25 + rz * w * (0.4 + Math.random() * 0.8),
              r * j,
              gg * j,
              b * j,
              a * (0.5 + 0.5 * frac),
              0.25,
              0.75 + 0.4 * frac,
              0.45 + Math.random() * 0.35,
            );
          }
        }
      } else {
        this.dustCarry[i] = 0;
      }

      // Speed-line drive for this kart (only shown for the karts a human
      // camera follows — setView picks).
      const speedFrac = kart.speed / TUNING.topSpeed;
      let target = (speedFrac - LINES_FROM) / (LINES_FULL - LINES_FROM);
      target = Math.max(0, Math.min(1, target)) * 0.7;
      if (boosting) target = Math.min(1, target + LINES_BOOST);
      this.lines[i] += (target - this.lines[i]) * (1 - Math.exp(-LINES_RATE * dt));
    }
    this.trails.end();
    this.sparks.update(dt);
    this.dust.update(dt);
  }

  // Race reset: everything in flight disappears at once.
  clear() {
    this.sparks.clear();
    this.trails.clear();
    this.dust.clear();
    this.dustCarry.fill(0);
    this.lines.fill(0);
    this.speedLines.intensity = 0;
  }

  private classify(kart: KartState): Ground {
    const q = this.trackQuery.nearestSample(kart.pos);
    const surface = this.trackQuery.surfaceUnder(q);
    if (surface === 'dirt') return 'dirt';
    if (surface === 'sand') return 'sand';
    return q.offRoad ? 'grass' : 'road';
  }
}
