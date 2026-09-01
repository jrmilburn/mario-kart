import * as THREE from 'three';
import { TUNING } from '../tuning';
import { clamp, damp, lerp } from '../../shared/mathUtils';
import { kartForward, type KartState } from '../physics/Kart';

// Damped chase cam with a speed-driven FOV kick (60 -> 76).
export class FollowCamera {
  private currentPos = new THREE.Vector3();
  private initialized = false;

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
    const forward = kartForward(kart.heading);
    const desired = kart.pos
      .clone()
      .addScaledVector(forward, -T.camDistance)
      .add(new THREE.Vector3(0, T.camHeight, 0));

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

    const lookAt = kart.pos.clone().addScaledVector(forward, T.camLookAhead);
    lookAt.y += 0.6;
    this.camera.lookAt(lookAt);

    const speedFrac = clamp(Math.abs(kart.speed) / T.topSpeed, 0, 1);
    const targetFov = lerp(T.fovBase, T.fovMax, speedFrac);
    this.camera.fov = damp(this.camera.fov, targetFov, T.fovDamp, dt);
    this.camera.updateProjectionMatrix();
  }
}
