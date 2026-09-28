import * as THREE from 'three';
import { damp } from '../../shared/mathUtils';
import type { KartState } from '../physics/Kart';

// §v3 polish: the post-race show. Once the race enters FINISHED, main.ts hands
// every kart (including the humans') to the AI autopilot and swaps the split-
// screen follow cameras for this one full-screen camera, which cuts between
// scripted shot types until somebody hits RESTART.
//
// Why autopilot rather than a true replay: a real replay means recording every
// kart's pose for the whole race and playing it back, which needs a ring buffer
// sized for the worst-case race length, a second update path that drives the
// visuals from recorded poses instead of physics, and its own reset/dispose
// story. The karts are already fully drivable by the AI that raced against you,
// so a live "demo lap" gets the same cinematic value out of code that already
// exists and stays correct by construction — the karts on screen are the same
// simulation, just nobody's hands on them.
//
// Shots CUT rather than blend into each other (each pick re-seeds the position
// instead of damping from the last one). Interpolating between two arbitrary
// camera setups reads as a swoop through the scenery; cutting reads as an edit.

export type ShotKind = 'chase' | 'lead' | 'orbit' | 'crane' | 'trackside';

interface ShotSpec {
  kind: ShotKind;
  fov: number;
  // Exponential damp lambda for the camera's own position. Higher = stiffer.
  // (A static shot ignores it — the camera doesn't move at all.)
  damping: number;
  seconds: number;
}

const SHOTS: readonly ShotSpec[] = [
  { kind: 'chase', fov: 62, damping: 3.5, seconds: 4.5 },
  { kind: 'lead', fov: 52, damping: 4, seconds: 4 },
  { kind: 'orbit', fov: 48, damping: 6, seconds: 5 },
  { kind: 'crane', fov: 42, damping: 2.2, seconds: 5 },
  { kind: 'trackside', fov: 36, damping: 0, seconds: 6 },
];

// A trackside shot is framed on a kart that is still driving toward it; once
// the kart is this far past the camera there is nothing left to watch, so the
// shot cuts early rather than holding on a receding dot.
const TRACKSIDE_CUT_DISTANCE = 70;
const TRACKSIDE_LEAD = 46; // how far up the road the camera is planted
const ORBIT_RATE = 0.55; // rad/s

export interface CinematicSubject {
  kart: KartState;
}

export class CinematicCamera {
  readonly camera: THREE.PerspectiveCamera;

  private shot: ShotSpec = SHOTS[0];
  private subject = 0;
  private timer = 0;
  private orbitAngle = 0;
  private placed = false; // false = next update snaps instead of damping (a cut)
  private preferred: number[] = [];

  // Scratch vectors: update() runs every render frame, so it stays allocation-free.
  private position = new THREE.Vector3();
  private desired = new THREE.Vector3();
  private lookAt = new THREE.Vector3();
  private anchor = new THREE.Vector3(); // fixed world point for the static shot
  private forward = new THREE.Vector3();
  private right = new THREE.Vector3();
  private aspect = 0;

  constructor(private groundHeightAt: (pos: THREE.Vector3) => number) {
    this.camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 1500); // far plane matches Player.ts
  }

  /** Index of the kart currently on camera — main.ts points the shadow box at it. */
  get subjectIndex(): number {
    return this.subject;
  }

  // Called on entry to FINISHED. `preferred` are the entity indices worth
  // showing most (the active humans and the winner); the rest of the field
  // still gets screen time, just less of it.
  reset(preferred: readonly number[]) {
    this.preferred = [...preferred];
    this.timer = 0;
    this.placed = false;
  }

  update(subjects: readonly CinematicSubject[], dt: number) {
    if (subjects.length === 0) return;

    this.timer -= dt;
    if (this.timer <= 0 || this.subject >= subjects.length) this.cut(subjects);

    const kart = subjects[this.subject].kart;
    this.forward.set(Math.sin(kart.heading), 0, Math.cos(kart.heading)); // = kartForward(), without its allocation
    // right = UP x forward, matching the track's own frame convention.
    this.right.set(this.forward.z, 0, -this.forward.x);

    this.frame(kart, dt);

    // Never let a shot end up inside the scenery. Applied after the damp (not
    // before) so the clamp wins for the whole transit, not just at the target.
    this.position.y = Math.max(this.position.y, this.groundHeightAt(this.position) + 1.2);
    this.camera.position.copy(this.position);
    this.camera.lookAt(this.lookAt);

    const aspect = window.innerWidth / window.innerHeight;
    if (this.camera.fov !== this.shot.fov || this.aspect !== aspect) {
      this.camera.fov = this.shot.fov;
      this.aspect = aspect;
      this.camera.aspect = aspect;
      this.camera.updateProjectionMatrix();
    }
  }

  // Positions the camera for the current shot. Everything is derived from the
  // subject's own pose, so no shot needs the track's geometry to work.
  private frame(kart: KartState, dt: number) {
    const desired = this.desired;

    switch (this.shot.kind) {
      case 'chase':
        desired.copy(kart.pos).addScaledVector(this.forward, -6).addScaledVector(this.right, 1.1);
        desired.y += 1.5;
        break;
      case 'lead':
        desired.copy(kart.pos).addScaledVector(this.forward, 9);
        desired.y += 1.9;
        break;
      case 'orbit': {
        this.orbitAngle += ORBIT_RATE * dt;
        desired.set(
          kart.pos.x + Math.sin(this.orbitAngle) * 8,
          kart.pos.y + 2.8,
          kart.pos.z + Math.cos(this.orbitAngle) * 8,
        );
        break;
      }
      case 'crane':
        desired.copy(kart.pos).addScaledVector(this.forward, -14);
        desired.y += 12;
        break;
      case 'trackside':
        // Static: the anchor was fixed when the shot was cut, and the camera
        // just sits there while the kart drives past.
        desired.copy(this.anchor);
        if (kart.pos.distanceTo(this.anchor) > TRACKSIDE_CUT_DISTANCE) this.timer = 0;
        break;
    }

    if (!this.placed || this.shot.damping <= 0) {
      this.position.copy(desired);
      this.placed = true;
    } else {
      this.position.set(
        damp(this.position.x, desired.x, this.shot.damping, dt),
        damp(this.position.y, desired.y, this.shot.damping, dt),
        damp(this.position.z, desired.z, this.shot.damping, dt),
      );
    }

    // Aim: a little ahead of the kart for the moving shots (so it isn't pinned
    // dead-center), at the kart itself for the static one.
    this.lookAt.copy(kart.pos);
    this.lookAt.y += 0.8;
    if (this.shot.kind === 'chase') this.lookAt.addScaledVector(this.forward, 3);
  }

  // Picks the next shot + subject. Never repeats the same pair back-to-back,
  // so a cut always visibly changes something.
  private cut(subjects: readonly CinematicSubject[]) {
    const previousKind = this.shot.kind;
    let spec = SHOTS[Math.floor(Math.random() * SHOTS.length)];
    if (spec.kind === previousKind) spec = SHOTS[(SHOTS.indexOf(spec) + 1) % SHOTS.length];
    this.shot = spec;
    this.timer = spec.seconds;

    const previousSubject = this.subject;
    const pool =
      this.preferred.length > 0 && Math.random() < 0.6
        ? this.preferred.filter((i) => i < subjects.length)
        : subjects.map((_, i) => i);
    const candidates = pool.length > 1 ? pool.filter((i) => i !== previousSubject) : pool;
    this.subject = candidates.length > 0 ? candidates[Math.floor(Math.random() * candidates.length)] : 0;

    const kart = subjects[this.subject].kart;
    this.orbitAngle = Math.random() * Math.PI * 2;
    this.placed = false; // hard cut, not a swoop

    if (spec.kind === 'trackside') {
      // Plant the camera up the road from wherever the subject is right now,
      // off to one side, and leave it there for the length of the shot.
      this.forward.set(Math.sin(kart.heading), 0, Math.cos(kart.heading)); // = kartForward(), without its allocation
      this.right.set(this.forward.z, 0, -this.forward.x);
      const side = Math.random() < 0.5 ? -1 : 1;
      this.anchor.copy(kart.pos).addScaledVector(this.forward, TRACKSIDE_LEAD).addScaledVector(this.right, side * 13);
      this.anchor.y = Math.max(kart.pos.y, this.groundHeightAt(this.anchor)) + 3.4;
    }
  }
}
