import * as THREE from 'three';
import { TUNING } from '../tuning';
import { clamp, damp, lerp } from '../../shared/mathUtils';
import type { KartState } from '../physics/Kart';

// §v3 Track C2: the mushroom FOV kick. +6 degrees ramped on over 0.12s, then
// eased back to zero. It is deliberately kept ADDITIVE and separate from the
// speed-driven FOV: `baseFov` keeps doing exactly what it did before (damping
// toward fovBase..fovMax by speed) and the kick is layered on top, so the kick
// can never be "eaten" by the damping and the steady-state feel is unchanged.
const FOV_KICK_DEGREES = 6;
const FOV_KICK_RISE_SECONDS = 0.12;
const FOV_KICK_DECAY_RATE = 6; // ~0.5s to settle back (exponential damp lambda)

// §v5 collision shake: trauma 1 = a head-on wall hit at top speed.
const SHAKE_DECAY = 2.2; // trauma per second (a full hit settles in ~0.45s)
const SHAKE_FREQ = 22; // rad/s base of the noise
const SHAKE_OFFSET = 0.22; // metres at trauma 1
const SHAKE_ROLL = 0.035; // radians at trauma 1

// Damped chase cam with a speed-driven FOV kick (60 -> 76).
export class FollowCamera {
  private currentPos = new THREE.Vector3();
  private initialized = false;
  // Speed-driven FOV, tracked here rather than read back off `camera.fov` so
  // the additive boost kick below doesn't feed itself back into the damping.
  private baseFov = TUNING.fovBase;
  private fovKick = 0; // extra degrees currently applied
  private kickRise = 0; // seconds left in the ramp-on phase
  // §v5 collision shake (addTrauma): 0..1, decays linearly.
  private trauma = 0;
  private shakeTime = 0;
  private readonly forward = new THREE.Vector3();
  private readonly desired = new THREE.Vector3();
  private readonly lookAt = new THREE.Vector3();

  // §Phase 5 item 6: `groundHeightAt` lets the camera clamp its own height to
  // the track under it, independent of whatever the followed kart's y is
  // doing -- keeps the camera from dipping underground when it swings wide of
  // the kart on a slope (e.g. cresting the back-straight hill).
  constructor(
    private camera: THREE.PerspectiveCamera,
    private groundHeightAt: (pos: THREE.Vector3) => number,
  ) {}

  update(kart: KartState, dt: number) {
    const T = TUNING;
    // §v5 perf: scratch vectors — this runs once per player per frame, and
    // kartForward()/clone()/new Vector3 were three allocations each time.
    const forward = this.forward.set(Math.sin(kart.heading), 0, Math.cos(kart.heading));
    const desired = this.desired.copy(kart.pos).addScaledVector(forward, -T.camDistance);
    desired.y += T.camHeight;

    if (!this.initialized) {
      this.currentPos.copy(desired);
      this.initialized = true;
    } else {
      this.currentPos.set(
        damp(this.currentPos.x, desired.x, T.camPosDamp, dt),
        damp(this.currentPos.y, desired.y, T.camPosDamp, dt),
        damp(this.currentPos.z, desired.z, T.camPosDamp, dt),
      );
    }
    // §Phase 5 item 6: clamp after damping (not before) so the clamp always
    // wins against the ground even mid-transition between two heights.
    const groundY = this.groundHeightAt(this.currentPos);
    this.currentPos.y = Math.max(this.currentPos.y, groundY + 1.0);
    this.camera.position.copy(this.currentPos);

    const lookAt = this.lookAt.copy(kart.pos).addScaledVector(forward, T.camLookAhead);
    lookAt.y += 0.6;
    this.camera.lookAt(lookAt);

    // §v5 collision shake, layered on AFTER the aim so it jolts the view
    // without feeding back into the damped follow position.
    if (this.trauma > 0) {
      this.trauma = Math.max(0, this.trauma - SHAKE_DECAY * dt);
      this.shakeTime += dt;
      const s = this.trauma * this.trauma; // squared: big hits jolt, small ones barely tick
      const t = this.shakeTime * SHAKE_FREQ;
      // Sums of incommensurate sines: cheap, smooth, non-repeating noise.
      const nx = Math.sin(t * 1.0) * 0.6 + Math.sin(t * 2.31 + 1.7) * 0.4;
      const ny = Math.sin(t * 1.37 + 0.4) * 0.6 + Math.sin(t * 2.83 + 2.9) * 0.4;
      const nr = Math.sin(t * 1.13 + 2.2) * 0.7 + Math.sin(t * 3.07) * 0.3;
      this.camera.translateX(nx * s * SHAKE_OFFSET);
      this.camera.translateY(ny * s * SHAKE_OFFSET);
      this.camera.rotateZ(nr * s * SHAKE_ROLL);
    }

    const speedFrac = clamp(Math.abs(kart.speed) / T.topSpeed, 0, 1);
    const targetFov = lerp(T.fovBase, T.fovMax, speedFrac);
    this.baseFov = damp(this.baseFov, targetFov, T.fovDamp, dt);

    // §v3 Track C2 boost kick: linear ramp on, exponential ease off.
    if (this.kickRise > 0) {
      this.kickRise = Math.max(0, this.kickRise - dt);
      this.fovKick = Math.min(FOV_KICK_DEGREES, this.fovKick + (FOV_KICK_DEGREES / FOV_KICK_RISE_SECONDS) * dt);
    } else if (this.fovKick > 0.01) {
      this.fovKick = damp(this.fovKick, 0, FOV_KICK_DECAY_RATE, dt);
    } else {
      this.fovKick = 0;
    }

    this.camera.fov = this.baseFov + this.fovKick;
    // Only `fov` is written here — `aspect` is owned by main.ts's
    // applyCameraAspects (split-screen halves it), and this call re-commits
    // whatever aspect it last set, so the split-screen path is unaffected.
    this.camera.updateProjectionMatrix();
  }

  // §v3 Track C2: fired by main.ts when the player whose camera this is uses a
  // mushroom. Only the *firing* player's own camera kicks — a split-screen
  // opponent's view must not lurch because you used an item.
  kickFov() {
    this.kickRise = FOV_KICK_RISE_SECONDS;
  }

  // §v3 Track C2 review fix: resetRace() clears every other use-animation timer
  // (boostPopTimer, the kart squash, the flare, the item-box pops) but the kick
  // lives on the camera, so a restart taken right after a mushroom used to
  // carry ~6 degrees of extra FOV into the lobby and countdown and then ease it
  // off over the next second. FOV_KICK_DECAY_RATE is an exponential damp
  // lambda, so it never snaps on its own — it has to be zeroed explicitly.
  // `baseFov` is re-seeded too: the kart is respawned stationary, so the
  // speed-driven FOV should start from its resting value rather than damping
  // down from race speed.
  resetFov() {
    this.fovKick = 0;
    this.kickRise = 0;
    this.baseFov = TUNING.fovBase;
    this.trauma = 0;
  }

  // §v5 Effects: a collision jolt for THIS player's camera only. `amount` is
  // 0..1 (main.ts scales it by impact speed); trauma takes the max rather than
  // summing, so a wall scrape that re-triggers every few ticks holds a rumble
  // instead of ratcheting up into a blur.
  addTrauma(amount: number) {
    this.trauma = Math.min(1, Math.max(this.trauma, amount));
  }
}
