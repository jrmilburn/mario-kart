import { TUNING } from '../game/tuning';
import { clamp } from '../shared/mathUtils';

const NEUTRAL_STORAGE_KEY = 'kart.tilt.neutral';

export type TiltAvailability = 'available' | 'insecure' | 'unsupported';

// §3.7 availability gate, steps 1-2 (secure context, API exists). Step 3 (iOS
// permission) is async and must run from a tap handler — see requestTiltPermission.
export function checkTiltAvailability(): TiltAvailability {
  if (!window.isSecureContext) return 'insecure';
  if (typeof DeviceOrientationEvent === 'undefined') return 'unsupported';
  return 'available';
}

interface DeviceOrientationEventWithPermission {
  requestPermission?: () => Promise<'granted' | 'denied'>;
}

// Must be called synchronously from within a user tap handler on iOS.
export async function requestTiltPermission(): Promise<boolean> {
  const DOE = DeviceOrientationEvent as unknown as DeviceOrientationEventWithPermission;
  if (typeof DOE.requestPermission === 'function') {
    try {
      return (await DOE.requestPermission()) === 'granted';
    } catch {
      return false;
    }
  }
  return true; // Android / browsers without the iOS permission gate
}

// Builds a quaternion from (alpha, beta, gamma) with Euler order 'ZXY' (the
// device-orientation convention), rotates the device's long axis (portrait
// +Y) into the world frame, and returns the angle of that axis above/below
// horizontal (asin of the world-Z component) — stable even near-vertical,
// unlike raw beta/gamma (§3.7).
function computeWheelAngle(alpha: number, beta: number, gamma: number): number {
  const d2r = Math.PI / 180;
  const _x = beta * d2r;
  const _y = gamma * d2r;
  const _z = alpha * d2r;

  const cX = Math.cos(_x / 2);
  const cY = Math.cos(_y / 2);
  const cZ = Math.cos(_z / 2);
  const sX = Math.sin(_x / 2);
  const sY = Math.sin(_y / 2);
  const sZ = Math.sin(_z / 2);

  const w = cX * cY * cZ - sX * sY * sZ;
  const qx = sX * cY * cZ - cX * sY * sZ;
  const qy = cX * sY * cZ + sX * cY * sZ;
  const qz = cX * cY * sZ + sX * sY * cZ;

  // Rotate local (0,1,0) by quaternion (w, qx, qy, qz); only the resulting Z
  // component is needed.
  const tx = 2 * qy * 0 - 2 * qz * 1;
  const ty = 2 * qz * 0 - 2 * qx * 0;
  const tz = 2 * qx * 1 - 2 * qy * 0;
  const rz = 0 + w * tz + (qx * ty - qy * tx);

  return Math.asin(clamp(rz, -1, 1));
}

// Replaces TouchSteering when tilt mode is active. Filters raw device-
// orientation samples into a stable "wheel angle", calibrates a neutral
// point, and maps to a steer value with a deadzone + expo curve near center.
export class TiltSteering {
  private filtered = 0;
  private neutral = 0;
  private sampled = false;

  constructor() {
    const stored = sessionStorage.getItem(NEUTRAL_STORAGE_KEY);
    if (stored !== null) this.neutral = Number(stored);
  }

  private handleEvent = (e: DeviceOrientationEvent) => {
    if (e.alpha === null || e.beta === null || e.gamma === null) return;
    let wheelAngle = computeWheelAngle(e.alpha, e.beta, e.gamma);

    // Flip sign between the two landscape orientations so left is always left.
    const orientationAngle = screen.orientation?.angle ?? 0;
    if (orientationAngle === 270) wheelAngle *= -1;

    if (!this.sampled) {
      this.filtered = wheelAngle;
      this.sampled = true;
    } else {
      this.filtered = this.filtered + TUNING.tiltSmoothing * (wheelAngle - this.filtered);
    }
  };

  attach() {
    window.addEventListener('deviceorientation', this.handleEvent);
  }

  detach() {
    window.removeEventListener('deviceorientation', this.handleEvent);
  }

  get filteredAngle(): number {
    return this.filtered;
  }

  get neutralAngle(): number {
    return this.neutral;
  }

  calibrate() {
    this.neutral = this.filtered;
    sessionStorage.setItem(NEUTRAL_STORAGE_KEY, String(this.neutral));
  }

  get steer(): number {
    const maxRad = (TUNING.tiltMaxAngleDeg * Math.PI) / 180;
    const deadzoneRad = (TUNING.tiltDeadzoneDeg * Math.PI) / 180;
    let diff = this.filtered - this.neutral;
    if (Math.abs(diff) < deadzoneRad) diff = 0;
    const linear = clamp(diff / maxRad, -1, 1);
    return Math.sign(linear) * Math.abs(linear) ** 1.3;
  }
}
